// 下一轮雷霆路径：默认关闭（SPINE_THUNDER=1 才开），且每次只读一次模型。
// Next-round thunder path: off unless SPINE_THUNDER=1, and it reads the model at most once.
// 规则：要么整段 attach 吃热缓存，要么 send-less 只发瘦身后的输入，不做「先 attach 再 send-less」。
// One rule: either attach the whole prefix for a warm cache, or send less. Never both.

// send-less 时散文部分的 token 上限。
// Token cap for the prose part when sending less.
const PROSE_TOKEN_CAP = 32000;

/**
 * 公共前缀长度（字符数）：先按 64 字符块跳着比，再逐字符收尾。
 * Length of the shared prefix in characters: jump in 64-char blocks, then finish byte by byte.
 *
 * 这是「缓存还能不能命中」的近似判定。
 * This is a cheap proxy for "will the cached prefix still match".
 *
 * @param {string} previous
 * @param {string} next
 * @returns {number}
 */
export function sharedPrefixLength(previous, next) {
  if (!previous || !next) return 0;
  const limit = Math.min(previous.length, next.length);
  let index = 0;
  const step = 64;
  while (
    index + step <= limit &&
    previous.slice(index, index + step) === next.slice(index, index + step)
  )
    index += step;
  while (index < limit && previous[index] === next[index]) index += 1;
  return index;
}

/**
 * 决定这次大压怎么喂给摘要器：attach 还是 send-less。
 * Decide how to feed the summarizer: attach or send-less.
 *
 * - 没有可比的上一轮前缀，直接 send-less（没缓存可吃）。
 *   No previous prefix to compare: go send-less.
 * - 公共前缀占比 < 90%，缓存基本没戏，send-less 更省。
 *   Shared prefix below 90%: the cache will miss, so send-less is cheaper.
 * - 27b 模型且前缀超过 80K token，不 attach（小窗口放不下热前缀）。
 *   On the 27b model with a prefix over 80K tokens, do not attach.
 *
 * @param {{ previous?: string, next?: string, modelKind?: string, prefixTokens?: number, attachMaxTokens?: number }} options
 * @returns {"attach" | "send-less"}
 */
export function decideThunder({
  previous,
  next,
  modelKind,
  prefixTokens,
  attachMaxTokens = 80000,
}) {
  if (!previous || !next) return "send-less";
  const shared = sharedPrefixLength(previous, next);
  const ratio = shared / Math.max(previous.length, 1);
  if (ratio < 0.9) return "send-less";
  if (modelKind === "27b" && (prefixTokens || 0) > attachMaxTokens)
    return "send-less";
  return "attach";
}

/**
 * 粗估 token：CJK 按 1.5 字符/token，其余按 4 字符/token。
 * Rough token estimate: 1.5 chars per token for CJK, 4 for everything else.
 *
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  return Math.ceil(cjk / 1.5 + (text.length - cjk) / 4);
}

/**
 * 组装 send-less 输入：任务行 + 已抄下来的事实 + 截断后的散文。
 * Build the send-less input: task line, locally kept facts, truncated prose.
 *
 * 散文超预算时用二分找到最长的、token 不超过上限的前缀。
 * Over budget, binary-search the longest prose prefix that fits the cap.
 *
 * @param {{ taskLine?: string, uncovered?: string, facts?: string[], proseTokens?: number }} options
 * @returns {string}
 */
export function buildSendLess({
  taskLine,
  uncovered,
  facts,
  proseTokens = PROSE_TOKEN_CAP,
}) {
  const kept = (facts || []).filter(Boolean);
  let prose = uncovered || "";
  if (estimateTokens(prose) > proseTokens) {
    let low = 0;
    let high = prose.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (estimateTokens(prose.slice(0, mid)) <= proseTokens) low = mid;
      else high = mid - 1;
    }
    prose = prose.slice(0, low);
  }
  return [
    taskLine || "Continue the current task.",
    "Facts already copied locally:",
    ...(kept.length ? kept.map((fact) => `- ${fact}`) : ["- (none)"]),
    "Uncovered prose to summarize:",
    prose || "(none)",
  ].join("\n");
}
