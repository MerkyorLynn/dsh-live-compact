/**
 * 边做边压 / Live Compact — DSH（DeepSeek Harness）的压缩后端替身。
 * Live Compact — a replacement compaction backend for DSH.
 *
 * 流水线 / pipeline：
 *   L1 本地切分（spine cut）：每轮结束后把最新一段 1K–32K token 的对话抽成卡片替换，不调模型，前缀缓存不动。
 *     Local spine cut after each completed turn: replace the newest 1K–32K token span with a card,
 *     no model call, cached prefix untouched.
 *   L1.5 路由（plan.js）：判断一段文本能否安全本地压（route === "local"）。
 *     Routing in plan.js: can this span be compressed locally?
 *   L2 send-less：可选（SPINE_THUNDER=1），只压摘要器的输入，不动会话。
 *     Optional (SPINE_THUNDER=1): shrink only the summarizer's input.
 *   L3 大门：继承宿主 BasicCompactionEngine 的 80% 模型摘要，能拖就拖。
 *     Inherited host summarizer at the 80% threshold, deferred as late as possible.
 *
 * 不变量 / invariants：
 *   - 新摘要必须比被遮蔽的原文小，否则抛错并留给大门（见 commitSelectedSpan）。
 *     A new summary must be smaller than the text it shadows, else throw and leave it to the gate.
 *   - 任意替换都要保持 tool_use / tool_result 配对。
 *     Every replacement must keep tool_use / tool_result pairs balanced.
 *   - 原文只增不删地写进 shadow 目录；shadow 不是活上下文。
 *     Shadowed text is appended to disk; a shadow file is never live context.
 *
 * 环境变量 / env：
 *   SPINE_MIN_TOKENS     L1 触发下限，默认 20000 tokens
 *   SPINE_THUNDER        "1" 时启用 attach / send-less 决策
 *   SPINE_THUNDER_MODEL  "27b" 时对大前缀更保守
 *   SPINE_SHADOW_DIR     shadow 输出目录（默认 $DSH_HOME/compaction-spine/shadow）
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
import {
  CompactionId,
  compactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from "@deepseek-ai/dsh-compaction";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { buildCard, planMessages, RAIL_TOKENS } from "./plan.js";
import { buildSendLess, decideThunder } from "./thunder.js";

// 卡片指纹：写进摘要正文，用来辨认历史上被本地切过的段。
// Card fingerprint, written into the summary text so earlier local cuts stay recognizable.
const MARK = "Spine extract.";
// 摘要块的标签：从 checkpoint 事件里还原「哪段是机器压出来的」。
// Summary wrapper tags: identify machine-written summaries inside a checkpoint event.
const SUMMARY_OPEN_TAG = "<compacted-summary>";
const SUMMARY_CLOSE_TAG = "</compacted-summary>";
// 模型看得到的检查点前言：告诉它这是背景，不是新任务。
// Checkpoint preamble the model sees: established background, not a new task.
const CHECKPOINT_PREAMBLE =
  "This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.";
// 一段可切的窗口：[CHUNK_MIN, CHUNK_MAX] token；CHUNK_MAX 就是 plan.js 的 RAIL_TOKENS。
// Sliceable window: [CHUNK_MIN, CHUNK_MAX] tokens; CHUNK_MAX is plan.js's RAIL_TOKENS.
const CHUNK_MIN = 1000;
const CHUNK_MAX = RAIL_TOKENS;
// 超过这个总量就交给大门做模型摘要，别在门口再切（避免和大压抢同一段历史）。
// Above this total, leave it to the gate's model summary instead of cutting near the door.
const BIG_GATE = 650000;
// 全量超过这个数之后，不再用 MAX_TAIL 限制尾部大小（尾部长也认）。
// Past this total, stop enforcing MAX_TAIL on the preserved tail.
const URGENT_TOKENS = 48000;
// 尾部（切点之后）的 token 预算；超了就往后拖，等下一轮或等大门。
// Token budget for the tail after the cut; overshoot defers the cut to a later turn or the gate.
const MAX_TAIL = 2200;
// L1 的压力下限：不到这条线不动刀（默认 20K，可用 SPINE_MIN_TOKENS 覆盖）。
// Pressure floor for L1: below this nothing is cut (default 20K, overridable via SPINE_MIN_TOKENS).
const MIN_PRESSURE = Number(process.env.SPINE_MIN_TOKENS || 20000);
// 每个引擎实例最多跟踪多少个会话状态（Map 按插入顺序做 LRU 淘汰）。
// How many session states one engine instance tracks (Map insertion order, LRU eviction).
const MAX_TRACKED_SESSIONS = 64;
// 没有 session id 时的兜底键。
// Fallback state key when the agent has no session id.
const DEFAULT_KEY = "__default__";

/**
 * 取消息的纯文本正文（content 可能是字符串，也可能是块数组）。
 * Text-only body of a message; content may be a string or an array of blocks.
 *
 * @param {unknown} message
 * @returns {string}
 */
function messageText(message) {
  const content = message?.content ?? message?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (typeof block?.text === "string" ? block.text : ""))
    .join("\n");
}

/**
 * 取某个 surface 节点的事件的纯文本，按事件类型挑字段。
 * Text of one surface event, picked by event type.
 *
 * @param {any} session
 * @param {number} seq
 * @returns {string}
 */
function eventText(session, seq) {
  const event = session.eventAt(seq);
  if (event?.type === "user/message") return messageText(event.data);
  if (event?.type === "assistant/message")
    return messageText(event.data?.message);
  return messageText(event?.data);
}

/**
 * 这个节点是不是一个 checkpoint（宿主的或本地切的）。
 * Whether this node is a checkpoint, host-made or locally cut.
 *
 * @param {any} session
 * @param {number} seq
 * @returns {boolean}
 */
function isCheckpoint(session, seq) {
  const event = session.eventAt(seq);
  if (event?.data?.source?.kind === "compact-checkpoint") return true;
  return eventText(session, seq).includes(MARK);
}

/**
 * 这个节点是不是用户消息。
 * Whether this node is a user message.
 *
 * @param {any} session
 * @param {number} seq
 * @returns {boolean}
 */
function isUser(session, seq) {
  return session.eventAt(seq)?.type === "user/message";
}

/**
 * 包一层 try/catch：宿主校验函数在边界情况下可能抛错，抛错就当「不满足」。
 * Wrap a host predicate: when it throws, treat the check as failed.
 *
 * @param {Function} fn
 * @param {any} session
 * @param {number} seq
 * @returns {boolean}
 */
function cutOk(fn, session, seq) {
  try {
    return fn(session, seq);
  } catch {
    return false;
  }
}

/**
 * shadow 目录：被切掉的原文写这里，只增不删。
 * Shadow directory: shadowed text lands here, append-only.
 *
 * @returns {string}
 */
function shadowDirectory() {
  if (process.env.SPINE_SHADOW_DIR) return process.env.SPINE_SHADOW_DIR;
  const root = process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(root, "compaction-spine", "shadow");
}

/**
 * 会话状态键：优先用 session id。
 * State key: the session id when there is one.
 *
 * @param {any} agent
 * @returns {string}
 */
function sessionKey(agent) {
  const id = agent?.session?.id;
  return typeof id === "string" && id.length > 0 ? id : DEFAULT_KEY;
}

/**
 * shadow 文件名：时间戳 + 原文字符数 + 会话尾号 + 随机后缀。
 * Shadow file name: timestamp, shadowed char count, session tail, random suffix.
 *
 * @param {string} key
 * @param {number} length
 * @returns {string}
 */
function shadowName(key, length) {
  const tag = key.replace(/[^A-Za-z0-9_-]/g, "").slice(-24) || "session";
  return `${Date.now()}-${length}-${tag}-${randomBytes(4).toString("hex")}.txt`;
}

/**
 * 在最新一轮里选一个可提交的切分窗口（从后往前扫）。
 * Pick a committable cut window inside the newest turn, scanning backwards.
 *
 * 规则 / rules：
 *  - 结尾跳过助手消息和很小的用户消息，避免留下过短尾巴。
 *    Skip assistant messages and tiny user messages at the tail.
 *  - 起点不能是 checkpoint 或用户消息；两端 tool pair 都要平衡。
 *    Never start on a checkpoint or a user message; both ends keep tool pairs balanced.
 *  - 先用卡片校验（TRUNK CONFIRMED），再向前扩；扩不动就停。
 *    Validate with the card first (TRUNK CONFIRMED), expand backwards until it stops.
 *
 * @param {any} session
 * @param {any} measurement tokenMeter.measure(session) 的结果 / result of tokenMeter.measure(session)
 * @returns {{ start: number, end: number, tokens: number, after: number, card: any } | null}
 */
function selectNewestChunk(session, measurement) {
  const nodes = session.surface.nodes;
  const priced = measurement.nodes;
  // surface 与计价必须一一对应，否则放弃（宿主投影可能正在变化）。
  // Surface and pricing must line up one-to-one; otherwise bail out.
  if (nodes.length === 0 || nodes.length !== priced.length) return null;
  // 系统提示在节点 0 时永远不进切分范围。
  // When the system prompt occupies node 0, it is never eligible.
  const first = session.eventAt(nodes[0])?.type === "system/message" ? 1 : 0;
  let end = priced.length - 1;
  // 1) 收尾：跳过后缀的助手消息和 <400 token 的用户消息。
  // 1) Trim the tail: skip assistant messages and user messages under 400 tokens.
  while (end >= first) {
    const event = session.eventAt(nodes[end]);
    const shortTail =
      event?.type === "assistant/message" ||
      (event?.type === "user/message" && priced[end].tokens < 400);
    if (!shortTail) break;
    end -= 1;
  }
  // 2) 结尾不能是 checkpoint，也不能破坏 tool pair 平衡。
  // 2) The end must not be a checkpoint and must keep tool pairs balanced.
  while (end >= first && isCheckpoint(session, nodes[end])) end -= 1;
  while (end >= first && !cutOk(toolPairingBalancedAfter, session, nodes[end]))
    end -= 1;
  if (end < first || isCheckpoint(session, nodes[end])) return null;
  // 单个节点就超过窗口上限，切不动。
  // A single node over the window cap cannot be cut.
  if (priced[end].tokens > CHUNK_MAX) return null;
  // 拼某段，以及拼「除这段之外的全部」，给卡片校验用。
  // Join a span, and join everything except that span, for card validation.
  const spanText = (spanStart, spanEnd) => {
    const bits = [];
    for (let index = spanStart; index <= spanEnd; index += 1)
      bits.push(eventText(session, nodes[index]));
    return bits.join("\n");
  };
  const liveText = (spanStart, spanEnd) => {
    const bits = [];
    for (let index = 0; index < nodes.length; index += 1) {
      if (index >= spanStart && index <= spanEnd) continue;
      bits.push(eventText(session, nodes[index]));
    }
    return bits.join("\n");
  };
  let start = end;
  let tokens = priced[end].tokens;
  let card = buildCard(spanText(start, end), liveText(start, end));
  // 3) 最小窗口都过不了卡片校验，就放弃（宁可留给大门也不丢硬信息）。
  // 3) The smallest window fails card validation: give up rather than lose hard facts.
  if (card.verdict !== "TRUNK CONFIRMED") return null;
  // 4) 向前扩：遇到 checkpoint / 用户消息 / 超预算 / 校验不过就停。
  // 4) Expand backwards until a checkpoint, a user message, the cap, or a failed check.
  while (start > first) {
    const prev = start - 1;
    if (isCheckpoint(session, nodes[prev]) || isUser(session, nodes[prev]))
      break;
    const nextTokens = tokens + priced[prev].tokens;
    if (nextTokens > CHUNK_MAX) break;
    const trial = buildCard(spanText(prev, end), liveText(prev, end));
    if (trial.verdict !== "TRUNK CONFIRMED") break;
    tokens = nextTokens;
    start = prev;
    card = trial;
  }
  // 5) 起点不能是 checkpoint，也不能破坏 tool pair；不合格就往后挪。
  // 5) The start must not be a checkpoint and must keep tool pairs; advance it if not.
  while (
    start <= end &&
    (isCheckpoint(session, nodes[start]) ||
      !cutOk(toolPairingBalancedBefore, session, nodes[start]))
  ) {
    tokens -= priced[start].tokens;
    start += 1;
  }
  if (start > end || tokens < CHUNK_MIN || isCheckpoint(session, nodes[start]))
    return null;
  // 6) 起点挪过之后重算卡片，再确认一次。
  // 6) Rebuild the card after moving the start and validate once more.
  card = buildCard(spanText(start, end), liveText(start, end));
  if (card.verdict !== "TRUNK CONFIRMED") return null;
  if (!cutOk(toolPairingBalancedAfter, session, nodes[end])) return null;
  // 7) 统计尾部 token 数，用于「最多留 MAX_TAIL」的延后判断。
  // 7) Count tail tokens for the MAX_TAIL deferral check.
  let after = 0;
  for (let index = end + 1; index < priced.length; index += 1)
    after += priced[index].tokens;
  return { start: nodes[start], end: nodes[end], tokens, after, card };
}

// 给外部（测试/调试）复用的纯函数计划器。
// Re-exported pure planner for tests and debugging.
export { planMessages };

/**
 * 压缩引擎：继承宿主 BasicCompactionEngine，只替换「压哪段、怎么压」。
 * Compaction engine: inherits the host BasicCompactionEngine and changes only
 * which span is compacted and how.
 */
export default class SpineCompactionEngine extends BasicCompactionEngine {
  // 每会话状态。一个引擎实例可能服务多个 agent，所以不能挂在 this 上，
  // 否则一个 agent 的卡片/前缀会漏到另一个 agent。
  // Per-session state. One engine can serve several agents, so nothing here may live on
  // `this` directly or one agent's card/prefix leaks into another.
  sessionState = new Map();

  /**
   * @param {any} ctx
   * @param {any} config
   */
  constructor(ctx, config) {
    super(ctx, config);
    // 轮次结束且 agent 空闲时，才做本地切分（不在轮次中间改 surface）。
    // Cut locally only when a turn has ended and the agent went idle (never mid-turn).
    ctx.on("agent/status", ({ agent, status }) => {
      if (status !== "idle") return;
      const state = this.stateFor(agent);
      if (state.warming) return;
      // 只处理「正常完成」的轮次；取消/出错的轮次不切。
      // Only completed turns are eligible; cancelled or failed turns are left alone.
      const done = agent.session
        .snapshotEvents()
        .some(
          (event) =>
            event.type === "turn/end" &&
            event.data?.reason?.kind === "completed",
        );
      if (!done) return;
      state.warming = true;
      void this.finishTurn(agent).finally(() => {
        state.warming = false;
      });
    });
  }

  /**
   * 取（或建立）某会话的状态；超出上限时按插入顺序淘汰最老的非活跃项。
   * Get or create a session's state, evicting the oldest idle entry past the cap.
   *
   * @param {any} agent
   * @returns {any}
   */
  stateFor(agent) {
    const key = sessionKey(agent);
    let state = this.sessionState.get(key);
    if (state) {
      // 命中即刷新 LRU 位置。
      // A hit refreshes the LRU position.
      this.sessionState.delete(key);
      this.sessionState.set(key, state);
      return state;
    }
    state = {
      key,
      liveAgent: null,
      warming: false,
      // localOnly / approvedCard 只在 finishTurn 的本地提交期间为真，
      // 让 summarize() 用已经算好的卡片而不是再跑一次规划。
      // localOnly / approvedCard are true only during finishTurn's local commit,
      // so summarize() reuses the already-computed card instead of re-planning.
      localOnly: false,
      approvedCard: null,
      lastPrefix: "",
      lastPrefixTokens: 0,
    };
    this.sessionState.set(key, state);
    // 淘汰：保留当前会话，跳过正在压缩或本地提交中的项。
    // Evict past the cap, keeping the current session and skipping busy entries.
    if (this.sessionState.size > MAX_TRACKED_SESSIONS) {
      for (const [oldKey, old] of this.sessionState) {
        if (this.sessionState.size <= MAX_TRACKED_SESSIONS) break;
        if (oldKey === key || old.warming || old.localOnly) continue;
        this.sessionState.delete(oldKey);
      }
    }
    return state;
  }

  /**
   * 把区间的 surface 节点转成消息，交给 plan.js 规划。
   * Turn a surface span into messages for plan.js.
   *
   * 当前未被调用，保留给以后按段规划。
   * Currently unused; kept for future per-span planning.
   *
   * @param {any} session
   * @param {{ start: number, end: number }} chunk
   * @returns {any}
   */
  chunkPlan(session, chunk) {
    const messages = [];
    let on = false;
    for (const seq of session.surface.nodes) {
      if (seq === chunk.start) on = true;
      if (!on) continue;
      messages.push({ role: "assistant", content: eventText(session, seq) });
      if (seq === chunk.end) break;
    }
    return planMessages(messages);
  }

  /**
   * 一轮结束后的本地切分入口：门控 → 选段 → 提交 → 复算 → 记前缀。
   * Post-turn local cut: gate, select, commit, re-measure, remember the prefix.
   *
   * @param {any} agent
   * @returns {Promise<void>}
   */
  async finishTurn(agent) {
    const state = this.stateFor(agent);
    // 整个提交最多 30 秒，避免压缩卡住主循环。
    // Cap the whole commit at 30s so compaction cannot stall the main loop.
    const signal = AbortSignal.timeout(30000);
    try {
      // runMaintenance：与宿主的维护窗口串行，避免和轮次写入交错。
      // runMaintenance serializes with the host's maintenance window so writes cannot interleave.
      await agent.runMaintenance(async (agentSignal) => {
        const op = AbortSignal.any([agentSignal, signal]);
        const measurement = this.ctx.tokenMeter.measure(agent.session);
        // 门控：不到下限不切；过大就留给大门的大压。
        // Gate: no cut below the floor; near the door, leave it to the big summary.
        if (
          measurement.totalTokens < MIN_PRESSURE ||
          measurement.totalTokens >= BIG_GATE
        )
          return;
        const chunk = selectNewestChunk(agent.session, measurement);
        if (chunk === null) return;
        // 尾部太长且压力还不算大：这刀先不切。
        // Tail too long while pressure is still low: skip this cut for now.
        if (chunk.after > MAX_TAIL && measurement.totalTokens < URGENT_TOKENS)
          return;
        const before = measurement.totalTokens;
        const started = Date.now();
        let reduced = false;
        try {
          // 标记本地提交：summarize() 会直接用 approvedCard，不发起模型调用。
          // Mark the local commit: summarize() uses approvedCard and makes no model call.
          state.localOnly = true;
          state.approvedCard = chunk.card;
          await this.commitSelectedSpan(agent, chunk, op);
          const after = this.ctx.tokenMeter.measure(agent.session).totalTokens;
          reduced = after < before;
          this.ctx.logger?.info?.(
            `spine cut ${Date.now() - started}ms ${before} -> ${after} chunk=${chunk.tokens}`,
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          this.ctx.logger?.warn?.(`spine cut failed: ${message}`);
        }
        // 没有真正变小就记一条警告，前缀原样留给大门。
        // No real reduction: warn and leave the prefix to the gate.
        if (!reduced) {
          this.ctx.logger?.warn?.(
            `spine cut did not reduce ${before}; leaving the prefix for the gate`,
          );
        }
        await this.ctx.sessions?.flush?.(agent.session);
        this.rememberPrefix(agent);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.ctx.logger?.warn?.(`spine after-turn skipped: ${message}`);
    } finally {
      state.localOnly = false;
    }
  }

  /**
   * 把一个选中的区间替换成 checkpoint 消息，并按宿主协议落事件。
   * Replace a selected span with a checkpoint message, following the host event protocol.
   *
   * 事件顺序 / event order：
   *   compaction/start → compaction/summary → user/message(replace) → compaction/end
   *
   * @param {any} agent
   * @param {{ start: number, end: number, tokens: number, card: any }} chunk
   * @param {AbortSignal} signal
   * @returns {Promise<void>}
   */
  async commitSelectedSpan(agent, chunk, signal) {
    signal?.throwIfAborted();
    const session = agent.session;
    const nodes = session.surface.nodes;
    const startIdx = nodes.indexOf(chunk.start);
    const endIdx = nodes.indexOf(chunk.end);
    if (startIdx < 0 || endIdx < startIdx)
      throw new Error("spine: selected span is not on the surface");
    // 被遮蔽的节点（surface 上的连续区间）。
    // Shadowed nodes: the contiguous span on the surface.
    const shadowedSeqs = nodes.slice(startIdx, endIdx + 1);
    const messages = [];
    for (const seq of shadowedSeqs)
      messages.push({ role: "assistant", content: eventText(session, seq) });
    // 本地提交走 approveCard；大门走模型摘要（可能是 send-less）。
    // A local commit uses approvedCard; the gate goes through the model summarizer.
    const summarized = await this.summarize({ messages }, agent, signal);
    const compactionId = CompactionId(randomUUID());
    // checkpoint 消息：前言 + 标签包裹的摘要，来源标记让它可被 isCheckpoint 识别。
    // Checkpoint message: preamble + tagged summary, with a source marker for isCheckpoint.
    const checkpointMessage = createUserMessage({
      content: [
        { type: "text", text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
        ...summarized.summary,
        { type: "text", text: SUMMARY_CLOSE_TAG },
      ],
      source: compactCheckpointSource(compactionId),
    });
    // 硬校验：框好的摘要必须比被替换的原文更小，否则整笔回滚。
    // Hard check: the framed summary must be smaller than the shadowed text, else roll back.
    const framedTokens =
      this.ctx.tokenMeter.estimateMessage?.(checkpointMessage);
    if (typeof framedTokens === "number" && framedTokens >= chunk.tokens) {
      throw new Error(
        `summary is not smaller than the shadowed content (${framedTokens} >= ${chunk.tokens})`,
      );
    }
    const lifecycle = { compactionId, turn: null };
    const startEvent = session.append("compaction/start", lifecycle);
    const summaryEvent = session.append("compaction/summary", {
      compactionId,
      summary: summarized.summary,
      ...(summarized.rawOutput === undefined
        ? {}
        : { rawOutput: summarized.rawOutput }),
      shadowedRange: { start: chunk.start, end: chunk.end },
      shadowedSeqs: [...shadowedSeqs],
      shadowedTokenCount: chunk.tokens,
      provider: summarized.provider,
      model: summarized.model,
    });
    // surface 替换 + 源事件引用：回放时能还原「哪些节点被这张卡片遮住了」。
    // Surface replacement plus source refs: replay can recover which nodes the card shadows.
    session.append("user/message", checkpointMessage, {
      surfaceOp: { op: "replace", startSeq: chunk.start, endSeq: chunk.end },
      sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
    });
    session.append("compaction/end", lifecycle);
    await this.ctx.sessions.flush(session);
  }

  /**
   * 记录当前前缀文本与 token 数，供 thunder 判断热缓存能否复用。
   * Remember the current prefix text and its token count so thunder can judge cache reuse.
   *
   * @param {any} agent
   */
  rememberPrefix(agent) {
    const state = this.stateFor(agent);
    try {
      const messages = agent.session.deriveMessages();
      state.lastPrefix = (messages || []).map(messageText).join("\n");
      state.lastPrefixTokens = this.ctx.tokenMeter.measure(
        agent.session,
      ).totalTokens;
    } catch {}
  }

  /**
   * 宿主的大门入口（80% 阈值 / 溢出 / /compact 都会走到这里）。
   * The host's gate entry point (80% threshold, overflow, and /compact all land here).
   *
   * 先清掉本地提交标记，确保走模型摘要而不是复用残留卡片。
   * Clear the local-commit flags first so this goes through the model summarizer.
   *
   * @param {any} agent
   * @param {any} trigger
   * @param {AbortSignal} signal
   * @returns {Promise<any>}
   */
  async compactIfNeeded(agent, trigger, signal) {
    const state = this.stateFor(agent);
    state.liveAgent = agent;
    state.localOnly = false;
    return super.compactIfNeeded(agent, trigger, signal);
  }

  /**
   * 摘要钩子（宿主唯一的子类钩子）：三条路。
   * The summarizer hook (the host's only subclass seam), three paths:
   *   1) 本地提交 / 低散文段：直接返回卡片，不调模型。
   *      Local commit or low-prose span: return the card, no model call.
   *   2) SPINE_THUNDER != "1"：交回宿主的模型摘要。
   *      SPINE_THUNDER != "1": hand back to the host's model summarizer.
   *   3) SPINE_THUNDER == "1"：热前缀就 attach，否则 send-less（只压摘要器输入）。
   *      SPINE_THUNDER == "1": attach on a warm prefix, else send-less.
   *
   * 无论哪条路，原文都先落 shadow。
   * Every path writes the shadowed text to disk first.
   *
   * @param {{ messages: any[] }} input
   * @param {any} agent
   * @param {AbortSignal} signal
   * @returns {Promise<any>}
   */
  async summarize(input, agent, signal) {
    const joined = input.messages.map(messageText).join("\n\n");
    const state = this.stateFor(agent);
    // 本地提交用已批准的卡片；大门路径重新规划。
    // Local commits reuse the approved card; gate paths re-plan.
    const card =
      state.localOnly && state.approvedCard
        ? state.approvedCard
        : planMessages(input.messages);
    state.approvedCard = null;
    // 原文落盘：模型看不到它，所以卡片里要写清 shadow 路径。
    // Persist the original text: the model cannot see it, so the card carries the shadow path.
    const shadow = shadowDirectory();
    mkdirSync(shadow, { recursive: true });
    const file = join(shadow, shadowName(state.key, joined.length));
    writeFileSync(file, joined);
    if (state.localOnly || card.route === "local") {
      const text = `${card.text}\nFull shadowed text: ${file}`;
      const block = { type: "text", text };
      return {
        summary: [block],
        provider: "local",
        model: "spine-extract",
        rawOutput: [block],
      };
    }
    if (process.env.SPINE_THUNDER !== "1")
      return super.summarize(input, agent, signal);
    // thunder：前缀高度重合就整段 attach（吃热缓存），否则只发瘦身后的输入。
    // Thunder: attach the whole prefix when it largely matches the cached one, else send less.
    const next = joined;
    const mode = decideThunder({
      previous: state.lastPrefix || "",
      next,
      modelKind: process.env.SPINE_THUNDER_MODEL === "27b" ? "27b" : "flash",
      prefixTokens: state.lastPrefixTokens || 0,
    });
    if (mode === "attach") return super.summarize(input, agent, signal);
    // send-less：任务行 + 硬事实 + 截断后的散文。
    // Send-less: task line, hard facts, and truncated prose.
    const users = input.messages.filter(
      (message) => (message?.role ?? message?.message?.role) === "user",
    );
    const taskLine = messageText(users.at(-1) || input.messages.at(-1)).slice(
      0,
      500,
    );
    const trunk = buildCard(joined, "");
    const facts = [
      ...new Set([...(trunk.hardLines || []), ...(trunk.missing || [])]),
    ];
    const slim = buildSendLess({ taskLine, uncovered: trunk.uncovered, facts });
    return super.summarize(
      {
        ...input,
        messages: [{ role: "user", content: [{ type: "text", text: slim }] }],
      },
      agent,
      signal,
    );
  }
}
