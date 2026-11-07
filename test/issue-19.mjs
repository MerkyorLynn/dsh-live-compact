import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DEFAULTS } from "../settings.js";
import { cutCrossesNewerCheckpoint, selectCutIndexes } from "../plan.js";
import { drainRewrite } from "../shadow.js";

const indexSource = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const user = (tokens = 100) => ({ type: "user", tokens, checkpoint: false, balancedAfter: true, balancedBefore: true });
const round = (tokens) => ({ type: "tool", tokens, checkpoint: false, balancedAfter: true, balancedBefore: true });
const card = () => ({ type: "other", tokens: 200, checkpoint: true, balancedAfter: true, balancedBefore: true });

test("issue 19 constants stay on the published lines", () => {
  assert.equal(DEFAULTS.bigGate, 650000);
  assert.equal(DEFAULTS.chunkMin, 1000);
  assert.equal(DEFAULTS.keepRoundTokens, 32000);
  assert.match(indexSource, /const URGENT_TOKENS = 48000/);
  assert.match(indexSource, /const MAX_TAIL = 2200/);
  assert.equal(indexSource.includes("SPINE_MAX_TOKENS"), false);
});

test("issue 19 drain does not cut left of a newer checkpoint", () => {
  const items = [user(), round(200000), card(), user(), round(8000), user(), round(100), round(100), round(100)];
  const cut = selectCutIndexes(items, { engine: "cloud", drain: true, totalTokens: 240000, maxEnd: 4 });
  assert.equal(cut.start > 2, true);
  assert.equal(cutCrossesNewerCheckpoint(items, cut.end), false);
  assert.equal(selectCutIndexes(items, { engine: "cloud", drain: true, totalTokens: 240000, maxEnd: 1 }), null);
});

test("issue 19 four drain cuts charge rewrite once, not four tails", () => {
  const notes = [0, 1, 2, 3].map((index) => ({
    kind: "cut",
    saved: 7800,
    afterPrefix: 210000 - index * 7800,
  }));
  const once = drainRewrite(notes);
  const inflated = notes.reduce((sum, note) => sum + note.afterPrefix, 0);
  assert.equal(once, 210000 - 7800 * 3);
  assert.equal(once < inflated / 2, true);
});

test("issue 19 drain loop does not rescan the log or remeasure at the top", () => {
  const loop = indexSource.slice(indexSource.indexOf("for (let pass = 0; pass < 8; pass += 1)"));
  const body = loop.slice(0, loop.indexOf("state.turnBase"));
  assert.equal(body.includes("snapshotEvents"), false);
  assert.equal(body.includes("collectJobs(agent.session"), false);
  assert.equal(body.includes("this.ctx.tokenMeter.measure(agent.session);\n          if (drain"), false);
});
