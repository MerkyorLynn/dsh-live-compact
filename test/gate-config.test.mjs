import assert from "node:assert/strict";
import { test } from "node:test";
import { installPresetGate } from "../gate.js";
import { STOCK_ENGINE } from "../adapter.js";

function gateHost() {
  const root = {};
  const listeners = new Set();
  const mount = () => {
    const disposers = [];
    return {
      root,
      effect(run) { disposers.push(run()); },
      on(name, listener) {
        assert.equal(name, "internal/config");
        listeners.add(listener);
        disposers.push(() => listeners.delete(listener));
      },
      dispose() { for (const dispose of disposers.reverse()) dispose(); },
    };
  };
  const preset = { id: "standard", plugins: [{ name: STOCK_ENGINE }] };
  return {
    mount, listeners,
    load() {
      const chain = [...listeners];
      const next = () => chain.length ? chain.shift()(null, next) : preset;
      return next();
    },
  };
}

test("one host installs only one preset listener, not one per engine", () => {
  const host = gateHost();
  const owner = host.mount();
  const child = host.mount();
  installPresetGate(owner);
  installPresetGate(child);
  assert.equal(host.listeners.size, 1);
  assert.equal(host.load().plugins[0].name, "dsh-live-compact");
  child.dispose();
  assert.equal(host.listeners.size, 1);
  owner.dispose();
  assert.equal(host.listeners.size, 0);
  const replacement = host.mount();
  installPresetGate(replacement);
  assert.equal(host.listeners.size, 1);
  replacement.dispose();
});

test("the volatile switch controls future preset loads and preserves existing results", () => {
  const host = gateHost();
  const owner = host.mount();
  let enabled = true;
  installPresetGate(owner, { takeoverPresets: { get: () => enabled } });
  const running = host.load();
  assert.equal(running.plugins[0].name, "dsh-live-compact");
  enabled = false;
  assert.equal(host.load().plugins[0].name, STOCK_ENGINE);
  assert.equal(running.plugins[0].name, "dsh-live-compact");
  enabled = true;
  assert.equal(host.load().plugins[0].name, "dsh-live-compact");
  owner.dispose();
});

test("a disabled root gate is not re-enabled by a nested engine", () => {
  const host = gateHost();
  const owner = host.mount();
  const child = host.mount();
  installPresetGate(owner, { takeoverPresets: false });
  installPresetGate(child);
  assert.equal(host.load().plugins[0].name, STOCK_ENGINE);
  owner.dispose();
  child.dispose();
});

const gateUrl = new URL("../gate.js", import.meta.url);
let importId = 0;

function rewrittenEngineConfig(rewritePresetConfig) {
  const rewritten = rewritePresetConfig({
    id: "standard",
    plugins: [{ name: "@deepseek-ai/dsh-compaction-basic" }],
  }, true);
  return rewritten.plugins[0].config;
}

test("gate 使用三项配置的默认值", async () => {
  const keys = ["SPINE_THRESHOLD_RATIO", "SPINE_HEADROOM_TOKENS", "SPINE_RETAIN_TOKENS"];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];

  try {
    const { rewritePresetConfig } = await import(`${gateUrl.href}?config=${importId++}`);
    const config = rewrittenEngineConfig(rewritePresetConfig);
    assert.strictEqual(config.thresholdRatio, 0.8);
    assert.strictEqual(config.headroomTokens, 65536);
    assert.strictEqual(config.retainTokens, 8192);
  } finally {
    for (const key of keys) {
      if (previous.get(key) === undefined) delete process.env[key];
      else process.env[key] = previous.get(key);
    }
  }
});

test("gate 在加载时读取 SPINE_HEADROOM_TOKENS 并复制数字", async () => {
  const previous = process.env.SPINE_HEADROOM_TOKENS;
  process.env.SPINE_HEADROOM_TOKENS = "16384";

  try {
    const { rewritePresetConfig } = await import(`${gateUrl.href}?config=${importId++}`);
    const config = rewrittenEngineConfig(rewritePresetConfig);
    assert.strictEqual(config.headroomTokens, 16384);
  } finally {
    if (previous === undefined) delete process.env.SPINE_HEADROOM_TOKENS;
    else process.env.SPINE_HEADROOM_TOKENS = previous;
  }
});
