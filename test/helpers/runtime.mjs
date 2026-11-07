import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { Session, SessionStore } from "@deepseek-ai/dsh-session";
import { createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import Spine from "../../index.js";
import { ENV } from "../../settings.js";
import { resetShadowAccessState } from "../../shadow.js";

let serial = 0;
export function fixture({ totalTokens = 24000, id = `runtime-${++serial}`, session = Session.create(id), longLast = false, long = {} } = {}) {
  const prices = new Map();
  const f = { session, prices, rounds: [] };
  f.add = (type, data, tokens = 20, options = { surfaceOp: "append" }) => {
    if (type === "assistant/message") data = { step: 0, stream: [], ...data };
    if (options.surfaceOp?.op === "replace" && !options.sourceEventSeqs) {
      const { startSeq, endSeq } = options.surfaceOp;
      const nodes = f.session.surface.nodes;
      options = { ...options, sourceEventSeqs: nodes.slice(nodes.indexOf(startSeq), nodes.indexOf(endSeq) + 1) };
    }
    const event = f.session.append(type, data, options);
    prices.set(event.seq, tokens);
    return event.seq;
  };
  f.user = (text, source = { kind: "user" }) => f.add("user/message", createUserMessage({ content: [{ type: "text", text }], source }), 80);
  f.round = (id, { name = "shell", text = "INFO fixture heartbeat ok", tokens = 30, command = "echo fixture", turn = 1, prose = "" } = {}) => {
    const call = f.add("assistant/message", { turn, message: createAssistantMessage({
      content: [...(prose ? [{ type: "text", text: prose }] : []), { type: "tool-call", id, name,
        arguments: JSON.stringify(name === "read" ? { file_path: "ledger.txt" } : { command }) }],
      source: { provider: "test", model: "no-network" },
    }) });
    const result = f.add("tool/result", { turn, message: createToolResultMessage({
      callId: id, content: [{ type: "text", text }], isError: false,
    }) }, tokens);
    const round = [call, result];
    f.rounds.push(round);
    return round;
  };
  f.measure = () => {
    const nodes = f.session.surface.nodes.map((seq) => ({ seq, tokens: prices.get(seq) ?? 200, heuristicTokens: prices.get(seq) ?? 200 }));
    const totalTokens = nodes.reduce((sum, node) => sum + node.tokens, 0);
    return { nodes, totalTokens, totalHeuristicTokens: totalTokens };
  };
  f.agent = () => ({ session: f.session, runMaintenance: (fn) => fn(new AbortController().signal) });
  f.summaries = () => f.session.snapshotEvents().filter((event) => event.type === "compaction/summary");
  f.add("system/message", { message: createSystemMessage("runtime fixture") }, totalTokens - 3270);
  f.lastUser = f.user("读取日志并继续当前任务。");
  const addLong = () => { f.longRound = f.round("long", { name: "read", tokens: 3000, text: "INFO fixture heartbeat ok\n".repeat(300), ...long }); };
  if (!longLast) addLong();
  for (let index = 0; index < 3; index++) f.round(`short-${index}`);
  if (longLast) addLong();
  f.add("assistant/message", { turn: 1, message: createAssistantMessage({
    content: [{ type: "text", text: "本轮结束。" }], source: { provider: "test", model: "no-network" },
  }) });
  return f;
}

// Real Context + engine + Session; only host I/O, token prices and model transport
// are fixtures. Provider discovery must never inspect the user's profiles.
export function runtime(t, { liveSessions = false } = {}) {
  const keys = [...Object.values(ENV), "SPINE_SHADOW_DIR", "SPINE_THUNDER", "SPINE_ENGINE_FAIL",
    "SPINE_SHADOW_MAX_BYTES", "SPINE_SHADOW_MAX_MB"];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  const root = mkdtempSync(join(tmpdir(), "spine-runtime-"));
  process.env.SPINE_SHADOW_DIR = root;
  resetShadowAccessState();
  const contexts = [];
  const fixtures = new Map();
  const h = { root, fixtures, warnings: [], infos: [], modelCalls: 0, pruneCalls: 0 };
  h.engine = (config = {}, engineKind = "local", Engine = Spine) => {
    const ctx = new Context();
    contexts.push(ctx);
    ctx.logger = { info: (line) => h.infos.push(line), debug() {}, warn: (line) => h.warnings.push(line) };
    if (liveSessions) new SessionStore(ctx);
    else ctx.sessions = {};
    ctx.sessions.flush = async () => {};
    ctx.tokenMeter = { measure: (session) => fixtures.get(session).measure(), estimateMessage: () => 200 };
    ctx.llm = new Proxy({}, { get: () => () => { h.modelCalls++; throw new Error("model calls forbidden"); } });
    ctx.provide("toolResultPruner", { pruneSession() { h.pruneCalls++; } });
    const engine = new Engine(ctx.isolate("compaction"), { auto: false, ...config });
    engine.engineFor = () => ({ engine: engineKind, source: "fixture" });
    return { engine, ctx };
  };
  h.use = (f) => { fixtures.set(f.session, f); return f; };
  h.capture = (engine, f) => {
    for (const event of f.session.snapshotEvents()) {
      engine.noteEvent(f.session, event);
      if (event.type === "tool/result") engine.captureOne(f.session, event);
    }
    engine.captureSession(f.session);
  };
  t.after(async () => {
    try {
      for (const ctx of contexts) await ctx.fiber.dispose();
      assert.equal(h.modelCalls, 0, "these local maintenance tests must never request a model");
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      resetShadowAccessState();
      rmSync(root, { recursive: true, force: true });
    }
  });
  return h;
}
