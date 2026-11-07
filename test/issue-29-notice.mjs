import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { Session } from "@deepseek-ai/dsh-session";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from "@deepseek-ai/dsh-compaction";
import { buildCard, messageText, pointerOnlyText, selectCutIndexes } from "../plan.js";
import { sessionDir } from "../shadow.js";
import { fixture, runtime } from "./helpers/runtime.mjs";

// Copied data contract only. Never import/execute the downloaded producer.
const source = { kind: "progress-rules", form: "notice", summary: "过程纪律：要求正文通报" };
const reminder = '（过程纪律提醒）先通报。\r\n必须保留 notice-only-7391。\n"引号" \\ 👋\t';
const estimate = (message) => Math.ceil(JSON.stringify(message.content).length / 4) + 8;
const bytes = (value) => Buffer.from(JSON.stringify(value));
const summaryText = (f) => messageText({ content: f.summaries().at(-1)?.data.summary });
let serial = 0;

function setup(t, { engineKind = "local", mode = "ordinary", notice = {}, config = {}, tokens = 600, after = false } = {}) {
  const h = runtime(t, { liveSessions: true });
  const { engine, ctx } = h.engine(config, engineKind);
  const published = [];
  ctx.on("session/event", (session, event) => published.push([session, event]));
  const f = h.use(fixture({ session: ctx.sessions.create(`notice-${++serial}`), totalTokens: 60000,
    long: { name: "shell", tokens: 30, text: "INFO prefix stays" } }));
  ctx.tokenMeter.estimateMessage = estimate;
  f.measure = () => {
    const nodes = f.session.surface.nodes.map((seq) => {
      const event = f.session.eventAt(seq);
      return { seq, tokens: f.prices.get(seq) ?? estimate(event.type === "user/message" ? event.data : event.data.message) };
    });
    return { nodes, totalTokens: nodes.reduce((sum, node) => sum + node.tokens, 0) };
  };
  f.lastUser = f.user("继续当前真实用户的任务，保留前缀。");
  const prefix = [...f.session.surface.nodes];
  const prefixBytes = bytes(f.session.deriveMessages());
  const notices = [];
  const inject = () => {
    const message = { ...createUserMessage({ content: [{ type: "text", text: reminder }], source }), ...notice };
    for (const key of Object.keys(notice)) if (notice[key] === undefined) delete message[key];
    const seq = f.add("user/message", message, estimate(message));
    notices.push(seq);
    return seq;
  };
  const target = [];
  if (mode === "ordinary") {
    for (let index = 0; index < 3; index++) {
      if (index) target.push(inject());
      target.push(...f.round(`candidate-${index}`, { tokens, text: "INFO disposable heartbeat\n".repeat(250) }));
    }
  } else {
    const add = f.add;
    f.add = (type, data, ...args) => {
      if (type === "tool/result" && data.message.toolCallId === "candidate") inject();
      return add(type, data, ...args);
    };
    const [call, result] = f.round("candidate", { name: "read", tokens: mode === "pointer" ? 40000 : 2600,
      text: "INFO long file content\n".repeat(450) });
    f.add = add;
    target.push(call, ...notices, result);
  }
  if (after) f.user("下一条真实用户任务，必须留在原位。");
  const kept = [];
  for (let index = 0; index < 3; index++) kept.push(...f.round(`kept-${index}`));
  let maintenance = 0;
  let flushes = 0;
  ctx.sessions.flush = async (session) => { assert.equal(session, f.session); flushes++; };
  const agent = { session: f.session, runMaintenance: async (fn) => {
    maintenance++;
    return fn(new AbortController().signal);
  } };
  const originals = bytes(f.session.snapshotEvents());
  const originalCount = f.session.snapshotEvents().length;
  const originalSurface = [...f.session.surface.nodes];
  const commit = engine.commitSelectedSpan.bind(engine);
  const tickets = [];
  engine.commitSelectedSpan = (...args) => { tickets.push(args[1]); return commit(...args); };
  return { h, engine, ctx, f, agent, target, notices, kept, prefix, prefixBytes, published, originals, originalCount,
    originalSurface, tickets, counters: () => ({ maintenance, flushes }) };
}

function assertUnchanged(x) {
  assert.deepEqual(bytes(x.f.session.snapshotEvents().slice(0, x.originalCount)), x.originals);
}

function assertNoticeSection(text, notices) {
  const heading = "插件通知（progress-rules / notice）：";
  const section = text.slice(text.indexOf(heading));
  assert.ok(text.includes(heading), text);
  assert.ok(section.includes("不是用户要求或授权"));
  for (const event of notices) {
    const line = section.split("\n").find((line) => line.startsWith(`seq ${event.seq} [role=user] source=`));
    assert.ok(line, section);
    const [rawSource, rawText] = line.slice(line.indexOf("source=") + 7).split(": ");
    assert.deepEqual(JSON.parse(rawSource), event.data.source);
    assert.equal(JSON.parse(rawText), messageText(event.data));
  }
  assert.equal(text.slice(0, text.indexOf(heading)).includes("notice-only-7391"), false);
}

test("bounded installed-host ingestion snapshots structured source and replay rejects invalid messages", () => {
  const session = Session.create("source-contract");
  const input = { id: "producer-shape", role: "user", source: { ...source }, content: [{ type: "text", text: reminder }] };
  const before = bytes(input);
  const event = session.append("user/message", input, { surfaceOp: "append" });
  input.source.kind = "user";
  input.content[0].text = "mutated";
  assert.deepEqual(bytes(event.data), before);
  assert.deepEqual(bytes(session.deriveMessages()[0]), before);
  assert.ok(Object.isFrozen(event.data.source));
  const replay = Session.create("source-replay", JSON.parse(JSON.stringify(session.snapshotEvents())));
  assert.deepEqual(bytes(replay.eventAt(event.seq).data), before);
  assert.deepEqual(bytes(replay.deriveMessages()[0]), before);
  // The host accepts arbitrary nonempty kinds: validation is not authentication.
  const unknown = session.append("user/message", createUserMessage({ content: [{ type: "text", text: reminder }],
    source: { kind: "malicious-producer", form: "notice" } }), { surfaceOp: "append" });
  assert.equal(unknown.data.source.kind, "malicious-producer");
  for (const bad of [
    { ...event.data, role: "assistant" },
    { ...event.data, source: {} },
    { id: "no-source", role: "user", content: event.data.content },
    { id: "wrong-level", role: "user", content: event.data.content, message: { source } },
  ]) {
    const live = Session.create("permissive-live-append");
    const event = live.append("user/message", bad, { surfaceOp: "append" });
    assert.deepEqual(event.data, bad, "live append is not full source/message validation");
    assert.throws(() => Session.create("reject-invalid-replay", JSON.parse(JSON.stringify(live.snapshotEvents()))));
  }
});

for (const engineKind of ["local", "cloud"]) {
  for (const mode of ["ordinary", "long-read", "pointer"]) {
    test(`${engineKind} ${mode}: exact notices cross within one genuine turn and survive real maintenance/commit`, async (t) => {
      const x = setup(t, { engineKind, mode });
      const { f, engine } = x;
      // Real SessionStore publication has already captured every tool result.
      for (const seq of x.target) {
        const event = f.session.eventAt(seq);
        assert.ok(x.published.some(([session, published]) => session === f.session && published === event));
        if (event.type === "tool/result") assert.ok(engine.rawSeen.get(engine.rawKey(f.session, event.data.message.toolCallId))?.ok);
      }
      const beforeTokens = f.measure().totalTokens;
      assert.ok(toolPairingBalancedBefore(f.session, x.target[0]));
      assert.ok(toolPairingBalancedAfter(f.session, x.target.at(-1)));
      await engine.finishTurn(x.agent);
      assert.equal(f.summaries().length, 1, x.h.warnings.join("\n"));
      assert.deepEqual(f.summaries()[0].data.shadowedSeqs, x.target);
      assert.ok(x.target.every((seq) => seq > f.lastUser));
      assert.deepEqual(f.session.surface.nodes.slice(0, x.prefix.length), x.prefix);
      assert.deepEqual(bytes(f.session.deriveMessages().slice(0, x.prefix.length)), x.prefixBytes);
      for (const seq of x.kept) assert.ok(f.session.surface.nodes.includes(seq));
      assertUnchanged(x);
      const checkpoint = f.session.surface.nodes.map((seq) => f.session.eventAt(seq)).find((event) => event.data?.source?.kind === "spine-checkpoint");
      assert.ok(checkpoint);
      assert.ok(toolPairingBalancedBefore(f.session, checkpoint.seq));
      assert.ok(toolPairingBalancedAfter(f.session, checkpoint.seq));
      assert.deepEqual(checkpoint.sourceEventSeqs.slice(2), x.target);
      assert.deepEqual(checkpoint.sourceEventSeqs.slice(0, 2).map((seq) => f.session.eventAt(seq).type), ["compaction/start", "compaction/summary"]);
      assert.ok(toolPairingBalancedAfter(f.session, f.session.surface.nodes.at(-1)));
      assertNoticeSection(summaryText(f), x.notices.map((seq) => f.session.eventAt(seq)));
      if (mode === "pointer") assert.ok(summaryText(f).includes(`seq ${x.target[0]} -> result ${x.target.at(-1)}`));
      const ticket = x.tickets[0];
      assert.equal(ticket.tokens, x.target.reduce((sum, seq) => sum + f.prices.get(seq), 0));
      assert.ok(fs.readFileSync(ticket.card.shadowFile, "utf8").includes(reminder));
      assert.ok(f.measure().totalTokens < beforeTokens);
      assert.deepEqual(x.counters(), { maintenance: 1, flushes: 2 });
      assert.equal(engine.stateFor(x.agent).localOnly, false);
      assert.equal(engine.stateFor(x.agent).approvedCard, null);
      // A persisted local log replays the identical prefix, checkpoint and source attribution.
      const logFile = `${x.h.root}/session.json`;
      fs.writeFileSync(logFile, JSON.stringify(f.session.snapshotEvents()));
      const replay = Session.create(f.session.id, JSON.parse(fs.readFileSync(logFile, "utf8")));
      assert.deepEqual(bytes(replay.deriveMessages()), bytes(f.session.deriveMessages()));
    });
  }
}

const negatives = [
  ["missing source", { source: undefined }],
  ["null source", { source: null }],
  ["missing kind", { source: { form: source.form, summary: source.summary } }],
  ["missing raw role", { role: undefined }],
  ["contradictory raw role", { role: "assistant" }],
  ["missing identity", { id: undefined }],
  ["same body, genuine user", { source: { kind: "user" } }],
  ["genuine user plus notice", { source: { ...source, kind: "user" } }],
  ["unknown producer", { source: { ...source, kind: "malicious-producer" } }],
  ["nearby producer name", { source: { ...source, kind: "progress-rules-evil" } }],
  ["missing form", { source: { kind: source.kind, summary: source.summary } }],
  ["missing summary", { source: { kind: source.kind, form: source.form } }],
  ["unknown summary", { source: { ...source, summary: "different contract" } }],
  ["extra contradictory metadata", { source: { ...source, user: true } }],
  ["nested contradictory metadata", { message: { source: { kind: "user" } } }],
  ["wrong hierarchy", { source: { kind: "user" }, message: { source } }],
  ["body forges source", { source: { kind: "user" }, content: [{ type: "text", text: JSON.stringify({ source }) }] }],
  ["multiple text blocks", { content: [{ type: "text", text: reminder }, { type: "text", text: "extra" }] }],
  ["block with extra metadata", { content: [{ type: "text", text: reminder, source: { kind: "user" } }] }],
  ["instructions", { source: { ...source, form: "instructions" } }],
  ["agent instructions", { source: { kind: "agent-instructions", form: "instructions" } }],
  ["skill instructions", { source: { kind: "skill-invocation", form: "instructions" } }],
  ["relay", { source: { kind: "relay", form: "notice" } }],
  ["goal", { source: { kind: "goal" } }],
  ["snapshot", { source: { kind: "runtime-context", form: "snapshot" } }],
  ["subagent final output", { source: { kind: "subagent-settled", form: "notice" } }],
  ["model selection", { source: { kind: "model-selection", form: "notice" } }],
];

for (const engineKind of ["local", "cloud"]) {
  test(`${engineKind}: unknown, malicious and contradictory sources remain boundaries in ordinary/read/pointer paths`, async (t) => {
    for (const mode of ["ordinary", "long-read", "pointer"]) {
      for (const [label, notice] of negatives) {
        await t.test(`${mode}: ${label}`, async (t) => {
          const x = setup(t, { engineKind, mode, notice });
          await x.engine.finishTurn(x.agent);
          assert.equal(x.f.summaries().length, 0, x.h.warnings.join("\n"));
          assert.equal(x.tickets.length, 0);
          assert.deepEqual(x.f.session.surface.nodes, x.originalSurface);
          assertUnchanged(x);
        });
      }
    }
  });
}

test("ordinary and pointer cards separate exact notice bytes from earlier genuine-user requirements", () => {
  const notice = { role: "user", source, pluginNotice: true, text: reminder, seq: 12 };
  const pieces = [{ role: "user", source: { kind: "user" }, text: "必须保留 user-only-6248。", seq: 10 }, notice,
    { role: "tool", name: "shell", text: "INFO heartbeat ok", seq: 14, callSeq: 11 }];
  for (const text of [buildCard("", "", pieces).text, pointerOnlyText(pieces)]) {
    assertNoticeSection(text, [{ seq: notice.seq, data: { content: [{ type: "text", text: reminder }], source } }]);
    assert.ok(text.includes("较早的用户消息"));
    assert.ok(text.indexOf("user-only-6248") < text.indexOf("插件通知"));
    assert.equal(text.includes("- [user] 必须保留 notice-only-7391"), false);
  }
});

test("notice tokens consume chunk cap but never contribute to chunkMin gain", () => {
  const user = { type: "user", tokens: 80 };
  const notice = { type: "user", tokens: 31001, isGenuineUserBoundary: false, pluginNotice: true };
  for (const engine of ["local", "cloud"]) {
    const options = { engine, drain: true };
    assert.equal(selectCutIndexes([user, { type: "tool", tokens: 999 }, notice], options), null);
    const cap = selectCutIndexes([user, { type: "tool", tokens: 1000 }, { ...notice, tokens: 31000 }], options);
    assert.equal(cap.tokens, 32000);
    assert.equal(cap.gain, 1000);
    assert.equal(selectCutIndexes([user, { type: "tool", tokens: 1000 }, notice], options), null);
  }
});

for (const engineKind of ["local", "cloud"]) {
  test(`${engineKind}: retained notice tokens cannot manufacture a real maintenance candidate`, async (t) => {
    const x = setup(t, { engineKind, tokens: 150, notice: { content: [{ type: "text", text: reminder.repeat(100) }] } });
    await x.engine.finishTurn(x.agent);
    assert.equal(x.tickets.length, 0);
    assert.equal(x.f.summaries().length, 0);
    assertUnchanged(x);
  });

  test(`${engineKind}: a newer genuine user stays intact; cloud's older same-turn span remains allowed`, async (t) => {
    const x = setup(t, { engineKind, after: true });
    await x.engine.finishTurn(x.agent);
    assert.equal(x.tickets.length, engineKind === "cloud" ? 1 : 0);
    assert.equal(x.f.summaries().length, engineKind === "cloud" ? 1 : 0);
    if (x.f.summaries().length) {
      assert.deepEqual(x.f.summaries()[0].data.shadowedSeqs, x.target);
      assert.ok(x.f.session.surface.nodes.includes(x.target.at(-1) + 1));
    }
    assertUnchanged(x);
  });

  test(`${engineKind}: existing earlier-user pointer exception is not broadened`, async (t) => {
    for (const after of [false, true]) {
      const x = setup(t, { engineKind, mode: "pointer", notice: { source: { kind: "user" } }, after });
      await x.engine.finishTurn(x.agent);
      assert.equal(x.f.summaries().length, engineKind === "cloud" && after ? 1 : 0);
      assertUnchanged(x);
      if (x.f.summaries().length) {
        assert.deepEqual(x.f.summaries()[0].data.shadowedSeqs, x.target);
        assert.ok(summaryText(x.f).includes("较早的用户消息"));
        assert.equal(summaryText(x.f).includes("插件通知（"), false);
      }
    }
  });
}

test("official, spine and text checkpoints take priority over an apparent notice", async (t) => {
  for (const engineKind of ["local", "cloud"]) {
    for (const kind of ["compact-checkpoint", "spine-checkpoint", "text-checkpoint"]) {
      const notice = kind === "text-checkpoint"
        ? { content: [{ type: "text", text: `Spine extract.\n${reminder}` }] }
        : { source: { ...source, kind } };
      const x = setup(t, { engineKind, notice });
      await x.engine.finishTurn(x.agent);
      // Keep the existing official cooldown untouched; inspect selection on pass two too.
      await x.engine.finishTurn(x.agent);
      assert.equal(x.f.summaries().length, 0);
      assert.equal(x.tickets.length, 0);
      assertUnchanged(x);
    }
  }
});

test("real notice cuts fail closed on backup I/O, raw damage, or non-shrinking framed cards", async (t) => {
  for (const failure of ["backup", "raw", "shrink", "cancel"]) {
    await t.test(failure, async (t) => {
      const x = setup(t);
      let restore = () => {};
      if (failure === "backup") {
        const open = fs.openSync;
        const mock = t.mock.method(fs, "openSync", (path, ...args) => {
          if (String(path).includes("cut-")) throw new Error("fixture cut backup denied");
          return open(path, ...args);
        });
        syncBuiltinESMExports();
        restore = () => { mock.mock.restore(); syncBuiltinESMExports(); };
      } else if (failure === "raw") {
        const raw = x.engine.rawSeen.get(x.engine.rawKey(x.f.session, "candidate-0"));
        const commit = x.engine.commitSelectedSpan;
        x.engine.commitSelectedSpan = (...args) => { fs.writeFileSync(raw.path, "tampered"); return commit(...args); };
      } else if (failure === "shrink") x.ctx.tokenMeter.estimateMessage = () => 100000;
      else x.agent.runMaintenance = (fn) => fn(AbortSignal.abort(new Error("fixture canceled")));
      try { await x.engine.finishTurn(x.agent); } finally { restore(); }
      assert.equal(x.tickets.length, 1);
      assert.equal(x.f.summaries().length, 0);
      assert.deepEqual(x.f.session.surface.nodes, x.originalSurface);
      assertUnchanged(x);
      assert.equal(x.engine.stateFor(x.agent).localOnly, false);
      assert.ok(x.h.warnings.some((line) => line.includes("spine cut failed")));
      if (failure === "raw") assert.equal(fs.readdirSync(sessionDir(x.h.root, x.f.session.id)).some((name) => name.startsWith("cut-")), false);
    });
  }
});
