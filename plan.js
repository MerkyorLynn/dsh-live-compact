/**
 * 纯函数层：卡片抽取、路由与 token 预估。
 * Pure functions: card extraction, routing, and token estimates.
 *
 * 这里不做 I/O、不调模型，输出可复现，便于评测时复算。
 * No I/O, no model calls; deterministic output so benchmark numbers can be reproduced.
 *
 * 核心概念 / core concept：
 *   covered   —— 看起来是代码/路径/数据/表格的行，压完还能读。
 *                Lines that look like code, paths, data, or tables; still meaningful when kept.
 *   uncovered —— 散文，信息密度低，压缩后最容易丢的一类。
 *                Prose: low density and the part most likely to be lost.
 *   hard      —— 义务句、错误行、重复标识符、路径；卡片必须优先保住它们。
 *                Obligations, error lines, repeated identifiers, paths: must survive the card.
 */
const MARK = "Spine extract.";
// 卡片正文的字符预算：硬行 + 可读行共享。
// Character budget for the card body, shared by hard lines and readable lines.
const KEEP_BUDGET = 8000;
// 单个切分窗口的 token 上限（index.js 的 CHUNK_MAX 就是它）。
// Token cap for one cut window; index.js uses this as CHUNK_MAX.
export const RAIL_TOKENS = 32000;
// 卡片校验的范围标签，写进摘要正文，方便回看是哪个策略版本判的。
// Scope tag for card validation, written into the summary so the policy version is auditable.
export const TRUNK_SCOPE = "dynamic-v1";
// 单行探针只看前 240 个字符，避免超长行拖慢正则。
// Line probes only look at the first 240 chars so very long lines stay cheap.
const LINE_TEST = 240;
// 行分类探针：代码/命令/堆栈/补丁头。
// Line probes: code, commands, stack frames, patch headers.
const CODE =
  /^(?:diff --git|index [0-9a-f]{4,}|@@ |--- |\+\+\+ |def |class |function |fn |pub |impl |import |export |#include |package |const |let |var |async |return |Traceback\b|Error:|Exception:|panic!|FAILED\b|PASS\b)|^\s+at \S+|^(?:\$ |> )?(?:git|cargo|npm|bun|python3|pip|curl|make) /;
// 单行像文件路径：这些后缀的行默认留给卡片。
// A line that looks like a file path: keep it by default.
const PATH =
  /^[~./\w-]+\.(?:py|js|ts|tsx|go|rs|java|c|h|cc|cpp|md|json|yml|yaml)(?::\d+)?$/;
// 研究类行：论文号、DOI、超参、公式、图表题、哈希。
// Research lines: arXiv/DOI ids, hyperparameters, formulas, figure/table captions, hashes.
const RESEARCH =
  /(?:\barxiv:\d{4}\.\d{4,5}\b|\bdoi:\s*10\.\d{4,}\/|\b10\.\d{4,9}\/\S+|\b(?:lr|learning_rate|batch_size|temperature|top_p|max_tokens)\s*[=:]|^\$\$|\\(?:frac|sum|prod|alpha|beta|gamma|cdot)\b|^Figure \d|^Table \d|^Eq\.?\s*\d|\bsha256\b|\b[a-f0-9]{64}\b)/i;
// Markdown 表格行。
// A Markdown table row.
const TABLE = /^\|.*\|$/;
// 宿主注入的提示噪音：不该进入卡片（对续跑没价值）。
// Harness-injected boilerplate: never worth keeping in a card.
const HARNESS =
  /web_search results are external|web_fetch returns external|Track every background job|Use the workflow tool ONLY|create_goal may infer|do not busy-poll/;
// 义务句/约束句：中英文的 must / 必须 / 保留 / 禁止 等。
// Obligation and constraint lines, English and Chinese.
const OBLIGATION =
  /(?:\b(?:must|never|do not|don't|required|requires|preserve|preserving|shall not)\b|必须|不要|禁止|不能|不得|只能|保留)/i;
// 标识符提取：反引号里的东西、驼峰名、蛇形/短横线名、文件名、绝对/相对路径。
// Identifier extraction: backticked tokens, camelCase, snake/kebab names, file names, paths.
const TOKEN =
  /`([^`]{2,80})`|\b([A-Z][A-Za-z0-9]+(?:[A-Z][a-z0-9]+)+)\b|\b([a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+)\b|\b([a-z][a-z0-9]*(?:[_-][a-z0-9]+){1,})\b|\b([A-Za-z0-9_.-]+\.(?:py|js|ts|tsx|go|rs|java|c|h|cc|cpp|md|json|yml|yaml))\b|\b((?:~|\.{1,2})?\/[A-Za-z0-9_./+-]{3,})\b/g;
// 标识符 + 动词 (move/keep/preserve...) 的行：多半是操作指令。
// Identifier plus an instruction verb: usually an operational instruction.
const IDENT_VERB =
  /`[^`]{2,80}`[\s\S]{0,80}\b(?:move|place|clear|preserve|require|requires|keep)\b|\b(?:move|place|clear|preserve|require|requires|keep)\b[\s\S]{0,80}`[^`]{2,80}`/i;
// 错误行：必须优先保留。
// Error headers: always keep.
const ERROR_LINE = /^(?:Error:|Exception:|Traceback\b|FAILED\b|panic!)/;

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
 * 判断一行是不是「填充式重复文本」（少量词反复出现）。
 * Whether a line is filler: a few tokens repeated over and over.
 *
 * @param {string} text
 * @returns {boolean}
 */
function isPadding(text) {
  if (!text) return false;
  const sample = text.length > 800 ? text.slice(0, 800) : text;
  const parts = sample.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 8) return false;
  const counts = new Map();
  let max = 0;
  for (const part of parts) {
    const next = (counts.get(part) || 0) + 1;
    counts.set(part, next);
    if (next > max) max = next;
  }
  return counts.size <= 3 || max / parts.length >= 0.6;
}

/**
 * 单行探针：像代码 / 路径 / 研究数据 / 表格，就算「有价值」。
 * One-line probe: code, path, research data, or table means worth keeping.
 *
 * @param {string} line
 * @returns {boolean}
 */
function probe(line) {
  const sample = line.length > LINE_TEST ? line.slice(0, LINE_TEST) : line;
  return (
    CODE.test(sample) ||
    PATH.test(sample) ||
    RESEARCH.test(sample) ||
    TABLE.test(sample)
  );
}

/**
 * 找重复出现的标识符（≥2 次）：重复出现通常意味着它是任务对象。
 * Find identifiers that appear twice or more: repetition usually means the task cares about it.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
export function repeatedNames(text) {
  const counts = new Map();
  for (const match of String(text || "").matchAll(TOKEN)) {
    const token = match.slice(1).find(Boolean);
    if (!token || token.length < 4) continue;
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return new Set(
    [...counts].filter(([, count]) => count >= 2).map(([token]) => token),
  );
}

/**
 * 路由：这段文本该本地压，还是等 80% 的大门。
 * Route: compress this span locally, or wait for the 80% gate.
 *
 * 判定只看两个量：uncovered 字符数与散文占比。
 * Only two numbers matter: uncovered chars and the prose ratio.
 *   uncovered ≥ 20000 且占比 ≥ 0.5  → wait-80（散文太多，本地切不可信）
 *                                    → too much prose; a local card would not be trustworthy
 *   uncovered <  20000 且占比 < 0.2  → local（几乎全是代码/路径，切得安全）
 *                                    → almost all code/path; safe to cut locally
 *   其余                              → wait-80
 *
 * @param {{ chars?: number, uncovered?: string } | null} plan
 * @returns {"local" | "wait-80"}
 */
export function compactionRoute(plan) {
  const chars = Math.max(1, plan?.chars || 0);
  const uncovered = plan?.uncovered?.length || 0;
  const proseRatio = uncovered / chars;
  if (uncovered >= 20000 && proseRatio >= 0.5) return "wait-80";
  if (uncovered < 20000 && proseRatio < 0.2) return "local";
  return "wait-80";
}

/**
 * 把一段文本拆成 covered（保留）与 uncovered（待总结）两部分。
 * Split text into covered (keep) and uncovered (to summarize) parts.
 *
 * 围栏代码块整块按 covered 处理，过长时只留首尾各一行。
 * Fenced code blocks count as covered; oversized ones keep only their first and last line.
 *
 * @param {string} text
 * @returns {{ covered: string[], uncovered: string, codeLines: number }}
 */
export function planText(text) {
  const covered = [];
  const uncovered = [];
  let fence = null;
  let codeLines = 0;
  const flushFence = () => {
    if (!fence) return;
    codeLines += fence.length;
    const body = fence.join("\n");
    covered.push(
      body.length > 1200
        ? `${fence[0]}\n… ${fence.length} code lines …\n${fence.at(-1)}`
        : body,
    );
    fence = null;
  };
  for (const raw of String(text).split("\n")) {
    const trimmed = raw.trim();
    if (fence) {
      fence.push(raw);
      if (trimmed.startsWith("```")) flushFence();
      continue;
    }
    if (trimmed.startsWith("```")) {
      fence = [raw];
      continue;
    }
    // 空行和填充行直接丢掉；探针命中的行进 covered，其余进 uncovered。
    // Drop blanks and filler; probe hits go to covered and the rest to uncovered.
    if (!trimmed || isPadding(trimmed)) continue;
    if (probe(trimmed)) {
      codeLines += 1;
      covered.push(
        trimmed.length > 300 ? `${trimmed.slice(0, 180)} …` : trimmed,
      );
    } else uncovered.push(trimmed);
  }
  flushFence();
  return { covered, uncovered: uncovered.join("\n"), codeLines };
}

/**
 * 递归收集消息里的文本（兼容字符串、块数组、嵌套 message/content）。
 * Recursively collect text from a message (strings, block arrays, nested message/content).
 *
 * @param {any} node
 * @param {string[]} bits
 */
function collectText(node, bits) {
  if (!node) return;
  if (typeof node === "string") {
    bits.push(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectText(item, bits);
    return;
  }
  if (typeof node === "object") {
    if (typeof node.text === "string") bits.push(node.text);
    if (node.content) collectText(node.content, bits);
    if (node.message) collectText(node.message, bits);
  }
}

/**
 * 先把消息摊平成 { role, content }，再交给 planMessages。
 * Flatten messages into { role, content } and hand them to planMessages.
 *
 * @param {any[]} messages
 * @returns {any}
 */
export function planTree(messages) {
  return planMessages(
    (messages || []).map((message) => {
      const bits = [];
      collectText(message, bits);
      return {
        role: message?.role || message?.message?.role || "assistant",
        content: bits.join("\n"),
      };
    }),
  );
}

/**
 * 抽取「硬行」：义务句、错误行、重复标识符、路径、标识符+动词。
 * Extract hard lines: obligations, errors, repeated identifiers, paths, identifier+verb.
 *
 * 宿主注入的提示噪音先被过滤；超过 400 字符的行只保留其中的重复标识符。
 * Harness boilerplate is filtered first; lines over 400 chars keep only their repeated identifiers.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function hardItems(text) {
  const names = repeatedNames(text);
  const items = [];
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line || HARNESS.test(line)) continue;
    const named = [...names].filter((name) => line.includes(name));
    if (line.length > 400) {
      items.push(...named);
      continue;
    }
    if (
      named.length > 0 ||
      OBLIGATION.test(line) ||
      ERROR_LINE.test(line) ||
      IDENT_VERB.test(line) ||
      PATH.test(line)
    ) {
      items.push(line);
    }
  }
  return [...new Set(items)];
}

/**
 * 生成一张卡片，并给出 TRUNK CONFIRMED / UNCONFIRMED 判定。
 * Build a card and decide TRUNK CONFIRMED versus UNCONFIRMED.
 *
 * 硬行优先入卡；已经在活上下文（liveText）里出现的行不重复记；
 * 预算用完后，未入卡的硬行记为 missing —— 只要 missing 非空，判定就是 UNCONFIRMED。
 * Hard lines go in first; lines already live in context are not repeated; hard lines
 * dropped by the budget become `missing`, and any missing line makes the verdict UNCONFIRMED.
 *
 * @param {string} spanText 被切掉的文本 / the shadowed text
 * @param {string} [liveText] 留在上下文里的文本 / text that stays live
 * @returns {any}
 */
export function buildCard(spanText, liveText = "") {
  const span = String(spanText || "");
  const live = String(liveText || "");
  const hard = hardItems(span);
  const split = planText(span);
  const kept = [];
  let used = 0;
  let omittedHard = 0;
  for (const line of hard) {
    if (live.includes(line)) continue;
    if (used + line.length > KEEP_BUDGET) {
      omittedHard += 1;
      continue;
    }
    kept.push(line);
    used += line.length;
  }
  let deferred = 0;
  for (const line of [...new Set(split.covered)]) {
    if (kept.includes(line) || live.includes(line)) continue;
    if (used + line.length > KEEP_BUDGET) {
      deferred += 1;
      continue;
    }
    kept.push(line);
    used += line.length;
  }
  const missing = hard.filter(
    (line) => !live.includes(line) && !kept.includes(line),
  );
  const verdict =
    missing.length === 0 ? "TRUNK CONFIRMED" : "TRUNK UNCONFIRMED";
  return {
    verdict,
    scope: TRUNK_SCOPE,
    hardLines: hard,
    hardCount: hard.length,
    omittedHard,
    deferred,
    missing,
    uncovered: split.uncovered,
    keptChars: used,
    // 卡片正文：模型看到的就是这几行；最后一句是给读卡片的模型/人的免责声明。
    // Card body: this is what the model sees; the last line is the disclaimer for whoever reads it.
    text: [
      MARK,
      `${verdict} against ${TRUNK_SCOPE}.`,
      "Checked: names repeated in this chunk, obligation lines, and error headers. Unclassified prose is not claimed.",
      `Hard lines: ${hard.length}. Missing from card and live context: ${missing.length}. Deferred recoverable: ${deferred}.`,
      "Kept lines:",
      ...(kept.length === 0 ? ["- (none)"] : kept.map((line) => `- ${line}`)),
      "A shadow path is not live preservation. Read a deferred file before using it.",
    ].join("\n"),
  };
}

/**
 * 多消息版本：短用户消息原文保留，其余走 planText/buildCard。
 * Multi-message variant: short user messages are kept verbatim; the rest goes through planText/buildCard.
 *
 * @param {any[]} messages
 * @returns {any}
 */
export function planMessages(messages) {
  const covered = [];
  const uncovered = [];
  const shortUsers = [];

  let chars = 0;
  let codeLines = 0;

  for (const message of messages) {
    const text = messageText(message);
    chars += text.length;
    const role = message?.role ?? message?.message?.role;

    // ≤280 字符的用户消息原文保留：那通常是任务本身，压缩它没有收益。
    // User messages up to 280 chars stay verbatim: that is usually the task itself.
    if (
      role === "user" &&
      text.length > 0 &&
      text.length <= 280 &&
      !text.startsWith(MARK)
    ) {
      shortUsers.push(text.trim());
      continue;
    }

    const split = planText(text);
    covered.push(...split.covered);
    codeLines += split.codeLines;

    if (split.uncovered) uncovered.push(split.uncovered);
  }
  const unique = [...new Set(covered)];
  const kept = [];

  let used = 0;
  let omitted = 0;

  for (const line of unique) {
    if (used + line.length > KEEP_BUDGET) {
      omitted += 1;
      continue;
    }

    kept.push(line);
    used += line.length;
  }

  const prose = uncovered.join("\n");
  const joined = (messages || []).map(messageText).join("\n");
  const card = buildCard(joined, shortUsers.join("\n"));

  return {
    chars,
    codeLines,
    keptChars: card.keptChars,
    omitted,
    omittedHard: card.omittedHard,
    deferred: card.deferred,
    verdict: card.verdict,
    hardLines: card.hardLines,
    // needsModel 是 route 的布尔镜像，供调用方少算一次路由。
    // needsModel mirrors route as a boolean so callers avoid a second route computation.
    needsModel: compactionRoute({ chars, uncovered: prose }) !== "local",
    route: compactionRoute({ chars, uncovered: prose }),
    uncovered: prose,
    text: [
      card.text,
      `Shadowed characters: ${chars}. Regex kept lines: ${kept.length}. Omitted over budget: ${omitted}.`,
      "Short user messages:",
      ...(shortUsers.length === 0
        ? ["- (none)"]
        : shortUsers.map((line) => `- ${line}`)),
    ].join("\n"),
  };
}
