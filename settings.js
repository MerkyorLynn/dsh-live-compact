/** 设置系统 */

/** 用户可调项。默认值与 1.1.1 的行为完全一致：不配置就一切照旧。 */
export const DEFAULTS = Object.freeze({
  minTokens: 20000, // 轮后小切的起点
  keepRounds: 3, // 原处保留的最近已结束工具轮数
  keepRoundTokens: 32000, // 云端收尾停止线
  pointerTokens: 0, // 0 = 跟随 chunkMax
  chunkMin: 1000, // 不够这一刀就不切
  chunkMax: 32000, // 一刀上限，等于卡片轨道
  bigGate: 650000, // 绝对停切线
  cooldownMs: 0, // 0 = 只用 seq 一次性跳过
});

/** 旧的环境变量仍然有效，但只作为 config 缺席时的兜底。 */
export const ENV = Object.freeze({
  minTokens: "SPINE_MIN_TOKENS",
  keepRounds: "SPINE_KEEP_ROUNDS",
  keepRoundTokens: "SPINE_KEEP_ROUND_TOKENS",
  pointerTokens: "SPINE_POINTER_TOKENS",
  chunkMin: "SPINE_CHUNK_MIN",
  chunkMax: "SPINE_CHUNK_MAX",
  cooldownMs: "SPINE_COOLDOWN_MS",
});

// volatile 字段的现值是 cosmokit 的取值对象，读之前先摊平。
const plain = (value) => (value && typeof value === "object" && typeof value.get === "function" ? value.get() : value);

/** stock 引擎自己的字段。多给一个键它就直接报 unknown key，所以传给引擎前要摘出来。 */
export const ENGINE_KEYS = Object.freeze([
  "auto",
  "thresholdRatio",
  "headroomTokens",
  "retainTokens",
  "compactionRetries",
]);

export function engineConfig(config = {}) {
  const next = {};
  for (const key of ENGINE_KEYS) if (config?.[key] !== undefined) next[key] = plain(config[key]);
  return next;
}

/** 运行期现值。引擎构造时写入一次，plan 侧按需读。 */
export const settings = { ...DEFAULTS };

const finite = (value) => {
  const number = Number(plain(value));
  return Number.isFinite(number) ? number : undefined;
};

export function readSettings(config = {}, env = process.env) {
  const next = {};
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const envName = ENV[key];
    next[key] =
      finite(config?.[key]) ?? finite(envName ? env?.[envName] : undefined) ?? fallback;
  }
  if (!next.pointerTokens) next.pointerTokens = next.chunkMax;
  return next;
}

export function applySettings(config = {}, env = process.env) {
  Object.assign(settings, readSettings(config, env));
  return settings;
}

/**
 * 官方大压缩的字段照抄 stock 引擎的 schema，剩下的才是本插件自己的旋钮。
 * 每个字段都要 .volatile()：宿主的设置界面只列出 volatile 字段，漏一个就整份表单不出现。
 */
export function configSchema(z) {
  const count = (min) => z.number().step(1).min(min);
  return z.object({
    takeoverPresets: z.boolean().default(true)
      .description("接管官方预设中的压缩引擎；修改后只影响新加载的预设，已有会话需重建。")
      .volatile(),
    auto: z.boolean().default(true).volatile(),
    thresholdRatio: z.number().default(0.8).volatile(),
    headroomTokens: count(0).default(65536).volatile(),
    retainTokens: count(0).default(8192).volatile(),
    compactionRetries: count(0).default(0).volatile(),
    minTokens: count(0).default(DEFAULTS.minTokens)
      .description("轮后小切的起点，上下文到这个 token 数才切一刀。")
      .volatile(),
    keepRounds: count(0).default(DEFAULTS.keepRounds)
      .description("最近几个已结束的工具轮留在原文。")
      .volatile(),
    keepRoundTokens: count(0).default(DEFAULTS.keepRoundTokens)
      .description("云端收尾停止线，降到这个 token 数以下就不再切。")
      .volatile(),
    pointerTokens: count(0).default(DEFAULTS.pointerTokens)
      .description("单个工具结果超过这个 token 数只留指针；0 = 跟随 chunkMax。")
      .volatile(),
    chunkMin: count(0).default(DEFAULTS.chunkMin)
      .description("一刀的最小量，不够就不切，避免每轮一张碎卡片。")
      .volatile(),
    chunkMax: count(1).default(DEFAULTS.chunkMax)
      .description("一刀的最大量，和卡片轨道同为 32000。")
      .volatile(),
    bigGate: count(1).default(DEFAULTS.bigGate)
      .description("绝对停切线，超过就不再做小切，交给官方大压缩。")
      .volatile(),
    cooldownMs: count(0).default(DEFAULTS.cooldownMs)
      .description("官方压缩之后跳过小切的时间窗；0 = 只按事件序号跳过一次。")
      .volatile(),
  });
}
