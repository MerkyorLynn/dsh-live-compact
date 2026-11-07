import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test, { after, mock } from "node:test";
import { Session } from "@deepseek-ai/dsh-session";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { skipLiveOfficialCompaction } from "../cooldown.js";
import { contentHash } from "../raw.js";
import { resolveEngine, resolveProviderBaseURL, selectCutIndexes } from "../plan.js";
import { DEFAULTS } from "../settings.js";
import { fixture, runtime } from "./helpers/runtime.mjs";

const inheritedEnv = new Map(["SPINE_ENGINE", "DEEPSEEK_BASE_URL"].map((key) => [key, process.env[key]]));
for (const key of inheritedEnv.keys()) delete process.env[key];
after(() => {
  for (const [key, value] of inheritedEnv) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

// Shapes transcribed from local upstream 0.2.0-rc.2 package code, never a
// configured profile: llm-deepseek-account, config-editor, launch-environment.
const ACCOUNT = "deepseek-account";
const LOCAL = "http://127.0.0.1:19420";
const PUBLIC = "https://gateway.example.test/anthropic";
const OWNER = "account-custom-entry-id";
const directory = [{ provider: ACCOUNT, displayName: "DeepSeek Account", settingsNs: OWNER, settingsPath: [] }];
const row = (override = {}, inherited = {}, id = OWNER) => ({ entry: { options: { id } }, override, inherited });
const hash = (f) => contentHash(JSON.stringify(f.session.snapshotEvents()));

function routing(t, options = {}) {
  const h = runtime(t);
  const { engine, ctx } = h.engine();
  delete engine.engineFor; // Exercise the real resolver, not runtime's default stub.
  const calls = [];
  const forbidden = () => { throw new Error("provider transport/discovery forbidden"); };
  ctx.llm = new Proxy({
    listProviders: () => options.listed ?? [{ id: ACCOUNT, name: "DeepSeek Account" }],
    listConfigurableProviders: () => { calls.push("directory"); return options.directory ?? directory; },
  }, { get: (target, key) => key in target ? target[key] : forbidden });
  ctx.provide("configEditor", { configuration: () => options.rows ?? [] });
  if (options.environment !== false) ctx.provide("launchEnvironment", {
    get(name) {
      assert.equal(name, "DEEPSEEK_BASE_URL", "read only the adapter's exact environment key");
      calls.push("launch-url");
      return options.launchURL === undefined ? undefined : { value: options.launchURL, source: "project-env" };
    },
  });
  engine.profilePatchText = () => options.patchText ?? "";
  engine.catalogProviders = () => options.catalog ?? [];
  const agent = { session: {
    requestHeader: () => ({ config: { provider: options.provider ?? ACCOUNT, ...(options.header ?? {}) } }),
    requestContext: () => options.context ?? {},
  } };
  return { ...h, engine, ctx, calls, agent };
}

function official(f, { time, kind = "compact-checkpoint" } = {}) {
  const clock = time === undefined ? null : mock.method(Date, "now", () => time);
  try {
    return f.user("official fixture summary", { kind, compactionId: `fixture-${f.session.snapshotEvents().length}` });
  } finally { clock?.mock.restore(); }
}

function work(f, name = "after-card", tool = "read") {
  f.user("继续当前任务。");
  const pair = f.round(name, { name: tool, tokens: 3000, text: "INFO fixture heartbeat ok\n".repeat(300) });
  for (let i = 0; i < 3; i++) f.round(`${name}-short-${i}`);
  return pair;
}

test("#29 exact account no-address fallback; near names and existing public providers keep their behavior", (t) => {
  const h = routing(t);
  assert.deepEqual(h.engine.engineFor(h.agent), { engine: "cloud", source: "provider" });
  for (const provider of ["deepseek-account-copy", "my-deepseek-account", "DeepSeek-Account", "deepseek_account", "unknown"]) {
    assert.deepEqual(resolveEngine({ provider, env: {} }), { engine: "local", source: "unknown" }, provider);
    assert.equal(resolveProviderBaseURL({ provider, launchURL: LOCAL, directory, layers: [] }), "");
  }
  for (const provider of ["deepseek", "deepseek-official", "DEEPSEEK-OFFICIAL"]) {
    const baseURL = resolveProviderBaseURL({ provider });
    assert.deepEqual(resolveEngine({ provider, baseURL, env: {} }), { engine: "cloud", source: "address" });
  }
  assert.deepEqual(resolveEngine({ provider: "strata-box", baseURL: PUBLIC, env: {} }), { engine: "local", source: "provider" });
});

test("#29 header, context, listed URL, generic layers, account root, patch and launch precedence", async (t) => {
  const common = {
    rows: [row({ baseURL: PUBLIC }, { baseURL: LOCAL })], launchURL: LOCAL,
    patchText: `providers:\n  ${ACCOUNT}:\n    baseURL: ${LOCAL}\n`,
    catalog: [{ id: ACCOUNT, baseURL: PUBLIC }],
  };
  const cases = [
    ["header", { ...common, header: { baseURL: LOCAL }, context: { baseURL: PUBLIC } }, "local"],
    ["context", { ...common, context: { baseURL: LOCAL } }, "local"],
    ["listed", { ...common, listed: [{ id: ACCOUNT, baseURL: LOCAL }] }, "local"],
    ["generic settings", { ...common, rows: [row({ providers: { [ACCOUNT]: { baseURL: LOCAL } }, baseURL: PUBLIC })] }, "local"],
    ["root settings", common, "cloud"],
    ["patch", { ...common, rows: [] }, "local"],
    ["launch", { ...common, rows: [], patchText: "" }, "local"],
    ["catalog", { ...common, rows: [], patchText: "", launchURL: undefined }, "cloud"],
  ];
  for (const [name, options, expected] of cases) await t.test(name, (t) => {
    const h = routing(t, options);
    assert.deepEqual(h.engine.engineFor(h.agent), { engine: expected, source: "address" });
  });
});

test("#29 account root settings use exact directory identity and preserve inheritance/override and volatile fields", async (t) => {
  const cases = [
    ["inherited", [row({}, { baseURL: LOCAL })], "local", "address"],
    ["override", [row({ baseURL: LOCAL }, { baseURL: PUBLIC })], "local", "address"],
    ["public override", [row({ baseURL: PUBLIC }, { baseURL: LOCAL })], "cloud", "address"],
    ["unrelated override field", [row({ thinking: "enabled" }, { baseURL: LOCAL })], "local", "address"],
    ["volatile", [row({ baseURL: { get: () => LOCAL } })], "local", "address"],
    ["absent volatile inherits", [row({ baseURL: { get: () => undefined } }, { baseURL: LOCAL })], "local", "address"],
    ["wrong row", [row({ baseURL: LOCAL }, {}, "other")], "cloud", "provider"],
  ];
  for (const [name, rows, expected, source] of cases) await t.test(name, (t) => {
    const h = routing(t, { rows });
    assert.deepEqual(h.engine.engineFor(h.agent), { engine: expected, source });
  });
  for (const badDirectory of [[], [{ ...directory[0], provider: "DeepSeek-Account" }], [{ ...directory[0], settingsNs: "other" }], [{ ...directory[0], settingsPath: ["unsupported"] }]]) {
    assert.equal(resolveProviderBaseURL({ provider: ACCOUNT, directory: badDirectory, layers: [{ settingsNs: OWNER, override: { baseURL: LOCAL } }] }), "");
  }
});

test("#29 both engine overrides win over explicit, missing and malformed account URLs", (t) => {
  const h = routing(t, { rows: [row({ baseURL: LOCAL })] });
  const saved = process.env.SPINE_ENGINE;
  t.after(() => { if (saved === undefined) delete process.env.SPINE_ENGINE; else process.env.SPINE_ENGINE = saved; });
  for (const engine of ["local", "cloud"]) {
    process.env.SPINE_ENGINE = engine;
    assert.deepEqual(h.engine.engineFor(h.agent), { engine, source: "env" });
    for (const baseURL of ["", LOCAL, PUBLIC, "not a url"]) assert.deepEqual(resolveEngine({ provider: ACCOUNT, baseURL, env: process.env }), { engine, source: "env" });
  }
});

test("#29 explicit public, loopback, private IPv4 and IPv6 account addresses take priority over default cloud", (t) => {
  const h = routing(t);
  for (const baseURL of [LOCAL, "http://localhost:8080", "http://10.1.2.3", "http://172.16.2.3", "http://192.168.2.3", "http://100.64.2.3", "http://[::1]", "http://[fd00::1]", "http://[fe80::1]", "http://[::ffff:192.168.1.1]"]) {
    h.agent.session.requestHeader = () => ({ config: { provider: ACCOUNT, baseURL } });
    assert.deepEqual(h.engine.engineFor(h.agent), { engine: "local", source: "address" });
  }
  h.agent.session.requestHeader = () => ({ config: { provider: ACCOUNT, baseURL: PUBLIC } });
  assert.deepEqual(h.engine.engineFor(h.agent), { engine: "cloud", source: "address" });
});

test("#29 malformed nonempty account URLs do not fall through from any address source", async (t) => {
  for (const [name, options] of [
    ["header", { header: { baseURL: "not a url" } }],
    ["context", { context: { baseURL: "not a url" } }],
    ["listed", { listed: [{ id: ACCOUNT, baseURL: "not a url" }] }],
    ["root", { rows: [row({ baseURL: "not a url" })] }],
    ["inherited", { rows: [row({}, { baseURL: "not a url" })] }],
    ["patch", { patchText: `providers:\n  ${ACCOUNT}: { baseURL: http://[ }` }],
    ["launch", { launchURL: "not a url" }],
  ]) await t.test(name, (t) => {
    const h = routing(t, options);
    assert.deepEqual(h.engine.engineFor(h.agent), { engine: "local", source: "invalid-address" });
  });
  for (const baseURL of [" ", "ftp://gateway.example.test", "https://fixture-user:fixture-password@gateway.example.test", `${PUBLIC}?fixture=1`, `${PUBLIC}#fragment`]) {
    assert.deepEqual(resolveEngine({ provider: ACCOUNT, baseURL, env: {} }), { engine: "local", source: "invalid-address" });
  }
});

test("#29 launch snapshot owns env fallback; process is read only when the service is absent", (t) => {
  const saved = process.env.DEEPSEEK_BASE_URL;
  process.env.DEEPSEEK_BASE_URL = LOCAL;
  t.after(() => { if (saved === undefined) delete process.env.DEEPSEEK_BASE_URL; else process.env.DEEPSEEK_BASE_URL = saved; });
  const snapshot = routing(t);
  assert.deepEqual(snapshot.engine.engineFor(snapshot.agent), { engine: "cloud", source: "provider" });
  const legacy = routing(t, { environment: false });
  assert.deepEqual(legacy.engine.engineFor(legacy.agent), { engine: "local", source: "address" });
  const supplied = routing(t, { launchURL: PUBLIC });
  assert.deepEqual(supplied.engine.engineFor(supplied.agent), { engine: "cloud", source: "address" });
});

test("#29 provider inspection reads no auth fields or discovery and emits no addresses", async (t) => {
  const config = { baseURL: LOCAL };
  for (const key of ["apiKey", "token", "credentials"]) Object.defineProperty(config, key, { get() { throw new Error("auth field read forbidden"); } });
  const h = routing(t, { rows: [row(config)] });
  const f = h.use(fixture());
  f.session.requestHeader = h.agent.session.requestHeader;
  f.session.requestContext = h.agent.session.requestContext;
  h.capture(h.engine, f);
  await h.engine.finishTurn(f.agent());
  assert.equal(f.summaries().length, 1);
  assert.ok(h.infos.includes("spine engine=local source=address"));
  assert.equal([...h.infos, ...h.warnings].some((line) => /https?:|127\.0\.0\.1|fixture-password/.test(line)), false);
});

test("#29 restored old official card cuts on the first maintenance through real transactions", async (t) => {
  const h = routing(t);
  for (const tool of ["shell", "read"]) {
    const f = fixture({ totalTokens: 48000 });
    const seq = official(f, { time: Date.now() - 9 * 60 * 60 * 1000 });
    const pair = work(f, `restored-${tool}`, tool);
    f.session = Session.create(f.session.id, JSON.parse(JSON.stringify(f.session.snapshotEvents())));
    h.use(f);
    assert.ok(seq < f.session.firstLiveSeq);
    f.session.requestHeader = h.agent.session.requestHeader;
    f.session.requestContext = h.agent.session.requestContext;
    const originalEvents = f.session.snapshotEvents().map((event) => JSON.stringify(event));
    const prefixLength = f.session.surface.nodes.indexOf(pair[0]);
    const prefix = JSON.stringify(f.session.deriveMessages().slice(0, prefixLength));
    h.capture(h.engine, f);
    await h.engine.finishTurn(f.agent());
    assert.ok(f.summaries().length, `restored ${tool}: ${h.warnings.join("; ")}; ${h.infos.join("; ")}`);
    assert.deepEqual(f.summaries().at(-1).data.shadowedSeqs, pair);
    assert.equal(JSON.stringify(f.session.deriveMessages().slice(0, prefixLength)), prefix);
    for (let i = 0; i < originalEvents.length; i++) assert.equal(JSON.stringify(f.session.eventAt(i)), originalEvents[i]);
    assert.ok(f.session.surface.nodes.includes(seq));
    assert.equal(h.infos.some((line) => line.includes("cooldown:")), false);
  }
});

test("#29 live official card skips once even if state/engine construction is delayed over one hour", async (t) => {
  const h = runtime(t);
  const f = fixture();
  const seq = official(f, { time: Date.now() - 61 * 60 * 1000 });
  const pair = work(f);
  h.use(f);
  const { engine } = h.engine();
  assert.ok(seq >= f.session.firstLiveSeq);
  h.capture(engine, f); // Historical capture replay must not mark the card seen.
  const before = hash(f);
  await engine.finishTurn(f.agent());
  assert.equal(hash(f), before);
  await engine.finishTurn(f.agent());
  assert.ok(f.summaries().length, h.warnings.join("; "));
  assert.deepEqual(f.summaries().at(-1).data.shadowedSeqs, pair);
  const next = official(f);
  const nextPair = work(f, "second-official");
  h.capture(engine, f);
  assert.notEqual(seq, next);
  const afterNext = hash(f);
  await engine.finishTurn(f.agent());
  assert.equal(hash(f), afterNext);
  await engine.finishTurn(f.agent());
  assert.deepEqual(f.summaries().at(-1).data.shadowedSeqs, nextPair);
});

test("#29 once-only cooldown survives LRU eviction, engine replacement and actual module hot reload", async (t) => {
  const h = runtime(t);
  const f = h.use(fixture());
  official(f);
  const pair = work(f);
  const { engine } = h.engine();
  h.capture(engine, f);
  await engine.finishTurn(f.agent());
  for (let i = 0; i < 65; i++) engine.stateFor({ session: { id: `evict-${i}` } });
  assert.equal(engine.sessionState.has(f.session.id), false, "must exercise actual eviction");
  await engine.finishTurn(f.agent());
  assert.deepEqual(f.summaries().at(-1).data.shadowedSeqs, pair);
  const next = work(f, "after-engine-replace");
  const replacement = h.engine().engine;
  h.capture(replacement, f);
  await replacement.finishTurn(f.agent());
  assert.deepEqual(f.summaries().at(-1).data.shadowedSeqs, next);
  const nextSeq = official(f);
  assert.equal(skipLiveOfficialCompaction(f.session), true);
  const reload = await import(`../cooldown.js?issue29-hot-reload=${nextSeq}`);
  assert.equal(reload.skipLiveOfficialCompaction(f.session), false);
  const reloaded = (await import("../index.js?issue29-hot-reload")).default;
  const lastPair = work(f, "after-module-reload");
  const hotEngine = h.engine({}, "local", reloaded).engine;
  h.capture(hotEngine, f);
  await hotEngine.finishTurn(f.agent());
  assert.deepEqual(f.summaries().at(-1).data.shadowedSeqs, lastPair);
});

test("#29 cooldown uses Session identity: separate sessions and a same-ID new object each skip their own live card", async (t) => {
  const h = runtime(t);
  const { engine } = h.engine();
  for (const id of ["separate-a", "separate-b", "separate-a"]) {
    const f = h.use(fixture({ id }));
    official(f);
    const pair = work(f);
    h.capture(engine, f);
    const before = hash(f);
    await engine.finishTurn(f.agent());
    assert.equal(hash(f), before);
    await engine.finishTurn(f.agent());
    assert.deepEqual(f.summaries().at(-1).data.shadowedSeqs, pair);
  }
});

test("#29 restored recent card still respects the optional timing setting and spine cards never trigger official cooldown", async (t) => {
  const h = runtime(t);
  const f = fixture();
  official(f);
  const pair = work(f);
  f.session = Session.create(f.session.id, JSON.parse(JSON.stringify(f.session.snapshotEvents())));
  h.use(f);
  const { engine } = h.engine({ cooldownMs: 300000 });
  h.capture(engine, f);
  const before = hash(f);
  await engine.finishTurn(f.agent());
  await engine.finishTurn(f.agent());
  assert.equal(hash(f), before, "time window applies independently to restored cards");
  engine.liveConfig = { cooldownMs: 0 };
  await engine.finishTurn(f.agent());
  assert.deepEqual(f.summaries().at(-1).data.shadowedSeqs, pair);
  const next = work(f, "after-spine");
  h.capture(engine, f);
  await engine.finishTurn(f.agent());
  assert.deepEqual(f.summaries().at(-1).data.shadowedSeqs, next);
});

test("#29 hosts without a valid firstLiveSeq explicitly retain once-per-card compatibility", () => {
  for (const boundary of [undefined, -1, NaN, Infinity, "5", 1.5]) {
    const session = {
      firstLiveSeq: boundary, surface: { nodes: [4] },
      eventAt: () => ({ type: "user/message", data: { source: { kind: "compact-checkpoint" } } }),
    };
    assert.equal(skipLiveOfficialCompaction(session), true);
    assert.equal(skipLiveOfficialCompaction(session), false);
  }
});

test("#29 firstLiveSeq equality is live; restoring the same event makes it historical", () => {
  const session = Session.create("issue29-boundary");
  const event = session.append("user/message", createUserMessage({ content: [{ type: "text", text: "official fixture" }],
    source: { kind: "compact-checkpoint", compactionId: "boundary-fixture" } }), { surfaceOp: "append" });
  assert.equal(event.seq, session.firstLiveSeq);
  assert.equal(skipLiveOfficialCompaction(session), true);
  assert.equal(skipLiveOfficialCompaction(session), false);
  const restored = Session.create(session.id, JSON.parse(JSON.stringify(session.snapshotEvents())));
  assert.ok(event.seq < restored.firstLiveSeq);
  assert.equal(skipLiveOfficialCompaction(restored), false);
});

test("#29 real request header, session/event capture and idle hook cut after restored history on the first pass", async (t) => {
  const h = routing(t);
  const f = fixture({ totalTokens: 48000 });
  f.add("request/header", { header: { config: { provider: ACCOUNT, model: "fixture-no-network" } }, reason: "initial" }, 0, {});
  const seq = official(f, { time: Date.now() - 9 * 60 * 60 * 1000 });
  for (const event of f.session.snapshotEvents()) h.ctx.emit("session/event", f.session, event);
  const seed = JSON.parse(JSON.stringify(f.session.snapshotEvents()));
  f.session = Session.create(f.session.id, seed);
  h.use(f);
  const original = f.add;
  f.add = (...args) => {
    const seq = original(...args);
    h.ctx.emit("session/event", f.session, f.session.eventAt(seq));
    return seq;
  };
  const pair = work(f, "hook-work", "shell");
  f.add("turn/end", { turn: 1, reason: { kind: "completed" } }, 0, {});
  const agent = f.agent();
  h.ctx.emit("agent/status", { agent, status: "idle" });
  for (let i = 0; h.engine.stateFor(agent).warming && i < 30; i++) await setImmediate();
  assert.equal(h.engine.stateFor(agent).warming, false);
  assert.ok(f.summaries().length, h.warnings.join("; "));
  assert.deepEqual(f.summaries().at(-1).data.shadowedSeqs, pair);
  assert.ok(f.session.surface.nodes.includes(seq));
  for (const event of seed) assert.deepEqual(f.session.eventAt(event.seq), event);
  assert.ok(h.infos.includes("spine engine=cloud source=provider"));
  assert.equal(h.infos.some((line) => line.includes("cooldown:")), false);
});

test("#29 maintenance rejection, cancellation and commit failure do not poison cooldown or localOnly", async (t) => {
  const h = runtime(t);
  const f = h.use(fixture());
  official(f);
  const pair = work(f);
  const { engine } = h.engine();
  h.capture(engine, f);
  const before = hash(f);
  await engine.finishTurn({ session: f.session, runMaintenance: async () => { throw new Error("fixture maintenance refused"); } });
  assert.equal(hash(f), before);
  await engine.finishTurn(f.agent());
  assert.equal(hash(f), before, "failed entry cannot consume the live card skip");
  await engine.finishTurn({ session: f.session, runMaintenance: (fn) => fn(AbortSignal.abort()) });
  assert.equal(hash(f), before);
  assert.equal(engine.stateFor(f.agent()).localOnly, false);
  const commit = engine.commitSelectedSpan;
  engine.commitSelectedSpan = async () => { throw new Error("fixture commit refused"); };
  await engine.finishTurn(f.agent());
  assert.equal(hash(f), before);
  assert.equal(engine.stateFor(f.agent()).localOnly, false);
  engine.commitSelectedSpan = commit;
  await engine.finishTurn(f.agent());
  assert.deepEqual(f.summaries().at(-1).data.shadowedSeqs, pair);
  assert.equal(engine.stateFor(f.agent()).localOnly, false);
});

test("#29 defaults preserve the 1000 chunk minimum, 32000 rail, and 48000 cloud urgent line", () => {
  assert.deepEqual(DEFAULTS, { minTokens: 20000, keepRounds: 3, keepRoundTokens: 32000, pointerTokens: 0,
    chunkMin: 1000, chunkMax: 32000, bigGate: 650000, cooldownMs: 0 });
  const items = (tokens) => [{ type: "user", tokens: 80 }, { type: "tool", tokens }];
  assert.equal(selectCutIndexes(items(999), { engine: "local" }), null);
  assert.ok(selectCutIndexes(items(1000), { engine: "local" }));
  assert.equal(selectCutIndexes(items(32000), { engine: "local" }).pointerOnly, undefined);
  assert.equal(selectCutIndexes(items(32001), { engine: "local" }).pointerOnly, true);
  assert.equal(selectCutIndexes(items(3000), { engine: "cloud", totalTokens: 47999 }), null);
  assert.ok(selectCutIndexes(items(3000), { engine: "cloud", totalTokens: 48000 }));
});

test("#29 restored account history still obeys the minTokens and absolute bigGate boundaries", async (t) => {
  const h = routing(t);
  for (const [totalTokens, cut] of [[19999, false], [20000, true], [649999, true], [650000, false]]) {
    const f = fixture();
    official(f);
    const pair = work(f);
    f.prices.set(0, f.prices.get(0) + totalTokens - f.measure().totalTokens);
    f.session = Session.create(f.session.id, JSON.parse(JSON.stringify(f.session.snapshotEvents())));
    h.use(f);
    f.session.requestHeader = h.agent.session.requestHeader;
    f.session.requestContext = h.agent.session.requestContext;
    assert.equal(f.measure().totalTokens, totalTokens);
    h.capture(h.engine, f);
    const before = hash(f);
    await h.engine.finishTurn(f.agent());
    if (cut) assert.deepEqual(f.summaries().at(-1).data.shadowedSeqs, pair);
    else assert.equal(hash(f), before);
  }
});

test("#29 reminder policy stays unchanged: structured injected notice is still a user boundary", async (t) => {
  const h = runtime(t);
  for (const engineKind of ["local", "cloud"]) {
    const f = h.use(fixture({ long: { name: "shell" } }));
    // Same event.data.source level used by the host, without claiming any
    // unverified producer contract or teaching the selector a new policy.
    f.session.append("user/message", createUserMessage({ content: [{ type: "text", text: "fixture reminder" }],
      source: { kind: "fixture-reminder", form: "notice" } }), { surfaceOp: "append" });
    const { engine } = h.engine({}, engineKind);
    h.capture(engine, f);
    const before = hash(f);
    await engine.finishTurn(f.agent());
    assert.equal(hash(f), before);
    assert.equal(f.summaries().length, 0);
  }
});
