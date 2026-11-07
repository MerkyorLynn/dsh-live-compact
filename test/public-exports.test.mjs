import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
// Literal package imports freeze every named/default export on every public
// subpath in 88f7563. Relative imports would miss package export-map failures.
import Entry, { preflightConfig } from "dsh-live-compact";
import Engine, {
  BIG_GATE, freshShadowFile, isCheckpoint, planMessages, saveShadow,
  saveShadowImpl, spineCheckpointSource,
} from "dsh-live-compact/engine";
import Gate, {
  GATE_SERVICE, PRESET_ENGINE_CONFIG, packageLoadable, rewritePresetConfig,
} from "dsh-live-compact/gate";
import { searchShadow } from "dsh-live-compact/shadow-search";

test("88f7563 public subpaths and named imports remain compatible", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  for (const [subpath, target] of Object.entries({
    ".": "./shell.js", "./engine": "./index.js", "./gate": "./gate.js",
    "./shadow-search": "./shadow-search.js",
  })) assert.equal(pkg.exports[subpath], target, subpath);
  for (const value of [Entry, preflightConfig, Engine, freshShadowFile, isCheckpoint,
    planMessages, saveShadow, saveShadowImpl, spineCheckpointSource, Gate,
    packageLoadable, rewritePresetConfig, searchShadow]) assert.equal(typeof value, "function");
  assert.equal(BIG_GATE, 650000);
  assert.equal(GATE_SERVICE, "liveCompactPresetGate");
  assert.equal(typeof PRESET_ENGINE_CONFIG, "object");
  assert.equal(saveShadow, saveShadowImpl);
});

test("every current public subpath imports, including the host client bundle", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  const previous = globalThis.window;
  const bundles = [];
  // No browser or UI: the client registers an inert factory with its host.
  globalThis.window = { __ModuleLoader__: { load: (bundle) => bundles.push(bundle) } };
  try {
    for (const subpath of Object.keys(pkg.exports)) {
      await import(pkg.name + (subpath === "." ? "" : subpath.slice(1)));
    }
    assert.equal(pkg.exports["./client"], "./client.js");
    assert.equal(bundles.length, 1);
    assert.equal(bundles[0].id, pkg.name);
    assert.equal(typeof bundles[0].factory, "function");
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});
