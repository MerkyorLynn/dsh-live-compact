// cooldown 的判定单测（node --test test/cooldown.test.mjs）
//
// 会话对象用最小打桩：这个模块的契约只有两个只读接口——`surface.nodes` 与 `eventAt(seq)`。
// 用打桩而不是真实 Session，是为了证明「它对宿主其余部分零依赖」，也便于覆盖时间边界。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_COOLDOWN_MS,
  OFFICIAL_COMPACTION_KIND,
  inCooldown,
  lastSourceKindAgeMs,
  lastSourceKindSeq,
  officialCompactionAgeMs,
  resolveCooldownMs,
} from '../cooldown.js';

/** 造一个只含指定节点序列的假会话。 */
function fakeSession(entries) {
  const byIndex = new Map(entries.map((entry, index) => [index, entry]));
  return {
    surface: { nodes: entries.map((_, index) => index) },
    eventAt: (seq) => byIndex.get(seq),
  };
}

const NOW = 1_800_000_000_000;

/** 一条带指定 source.kind 的用户消息节点。 */
function card(kind, time) {
  return { type: 'user/message', time, data: { source: kind ? { kind } : {}, content: [{ type: 'text', text: 'x' }] } };
}

test('没有官方卡片时视为「从未发生」：age=Infinity、不冷却', () => {
  const session = fakeSession([card(null, NOW - 1000), card('spine-checkpoint', NOW - 500)]);
  assert.equal(officialCompactionAgeMs(session, NOW), Infinity);
  assert.equal(inCooldown(session, { now: NOW }), false);
});

test('刚压完（窗口内）：判定为冷却', () => {
  const session = fakeSession([card(OFFICIAL_COMPACTION_KIND, NOW - 30_000)]);
  assert.equal(officialCompactionAgeMs(session, NOW), 30_000);
  assert.equal(inCooldown(session, { now: NOW }), true, '默认 5 分钟窗口内应冷却');
});

test('超出窗口：不再冷却', () => {
  const session = fakeSession([card(OFFICIAL_COMPACTION_KIND, NOW - DEFAULT_COOLDOWN_MS - 1)]);
  assert.equal(inCooldown(session, { now: NOW }), false);
});

test('spine 自己的卡片不算官方压缩（kind 精确匹配）', () => {
  const session = fakeSession([card('spine-checkpoint', NOW - 1_000)]);
  assert.equal(inCooldown(session, { now: NOW }), false);
  assert.equal(inCooldown(session, { now: NOW, kind: 'spine-checkpoint' }), true, '可复用为任意 kind');
});

test('取最近一条：中间夹一条更新的官方卡片时以它为准', () => {
  const session = fakeSession([
    card(OFFICIAL_COMPACTION_KIND, NOW - 600_000),
    card(null, NOW - 5_000),
  ]);
  assert.equal(officialCompactionAgeMs(session, NOW), 600_000, '仍取 10 分钟前那条，超窗口');
  const recent = fakeSession([card(OFFICIAL_COMPACTION_KIND, NOW - 600_000), card(OFFICIAL_COMPACTION_KIND, NOW - 20_000)]);
  assert.equal(recent && lastSourceKindAgeMs(recent, OFFICIAL_COMPACTION_KIND, NOW), 20_000);
});

test('windowMs ≤ 0 视为关闭：恒不冷却', () => {
  const session = fakeSession([card(OFFICIAL_COMPACTION_KIND, NOW - 1)]);
  assert.equal(inCooldown(session, { now: NOW, windowMs: 0 }), false);
  assert.equal(inCooldown(session, { now: NOW, windowMs: -1 }), false);
});

test('resolveCooldownMs：缺省 300000；0/负数=关闭；正数生效', () => {
  assert.equal(DEFAULT_COOLDOWN_MS, 300000);
  assert.equal(resolveCooldownMs({}), 300_000);
  assert.equal(resolveCooldownMs({ SPINE_COOLDOWN_MS: '0' }), 0);
  assert.equal(resolveCooldownMs({ SPINE_COOLDOWN_MS: '-5' }), 0);
  assert.equal(resolveCooldownMs({ SPINE_COOLDOWN_MS: '90000' }), 90_000);
  assert.equal(resolveCooldownMs({ SPINE_COOLDOWN_MS: 'abc' }), 300_000);
});

test('空会话/异常输入不抛错', () => {
  assert.equal(officialCompactionAgeMs({ surface: { nodes: [] } }, NOW), Infinity);
  assert.equal(inCooldown({}, { now: NOW }), false);
});

// ── 主判据：seq 一次性跳过（时间窗口只是可选兜底）─────────────────────
//
// 为什么需要它：官方压缩后可能隔很久才有下一条消息，那时时间窗口早过了，
// 但「官方摘要仍在 surface 里、第一次动作就在它后面切」的危害照旧存在。

test('lastSourceKindSeq 取最近一条官方卡片的 seq', () => {
  const session = fakeSession([card(OFFICIAL_COMPACTION_KIND, NOW - 900_000), card(null, NOW - 10), card(OFFICIAL_COMPACTION_KIND, NOW - 5)]);
  assert.equal(lastSourceKindSeq(session, OFFICIAL_COMPACTION_KIND), 2, '应是最后一条官方卡片的节点下标');
  assert.equal(lastSourceKindSeq(fakeSession([card(null, NOW - 10)]), OFFICIAL_COMPACTION_KIND), undefined);
});

test('seq 判据：同一条官方卡片只跳过一次（模拟调用方 state）', () => {
  const session = fakeSession([card(OFFICIAL_COMPACTION_KIND, NOW - 3_600_000)]);   // 一小时前压的
  const state = {};
  const decide = () => {
    const seq = lastSourceKindSeq(session, OFFICIAL_COMPACTION_KIND);
    if (seq !== undefined && state.cooldownSeenSeq !== seq) { state.cooldownSeenSeq = seq; return 'skip'; }
    return 'cut';
  };
  assert.equal(decide(), 'skip', '官方压缩后第一次动作应跳过（与间隔一小时无关）');
  assert.equal(decide(), 'cut', '第二次不再跳过，不会永久压制');
  assert.equal(decide(), 'cut');
});

test('出现新的官方卡片时重新跳过一次', () => {
  const entries = [card(OFFICIAL_COMPACTION_KIND, NOW - 1000)];
  const session = fakeSession(entries);
  const state = {};
  const decide = () => {
    const seq = lastSourceKindSeq(session, OFFICIAL_COMPACTION_KIND);
    if (seq !== undefined && state.cooldownSeenSeq !== seq) { state.cooldownSeenSeq = seq; return 'skip'; }
    return 'cut';
  };
  assert.equal(decide(), 'skip');
  assert.equal(decide(), 'cut');
  entries.push(card(OFFICIAL_COMPACTION_KIND, NOW));   // 又来一条官方压缩
  const session2 = fakeSession(entries);
  state.cooldownSeenSeq = lastSourceKindSeq(session, OFFICIAL_COMPACTION_KIND);   // 旧 seq 已记住
  const nextSeq = lastSourceKindSeq(session2, OFFICIAL_COMPACTION_KIND);
  assert.notEqual(nextSeq, state.cooldownSeenSeq, '新卡片的 seq 与已处理的不同');
  state.cooldownSeenSeq = nextSeq;   // 模拟调用方更新
  assert.equal(lastSourceKindSeq(session2, OFFICIAL_COMPACTION_KIND), nextSeq);
});
