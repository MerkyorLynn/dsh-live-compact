import test from "node:test";
import assert from "node:assert/strict";
import { buildCard, planMessages, planText, repeatedNames } from "../plan.js";
import { buildSendLess, decideThunder, sharedPrefixLength } from "../thunder.js";

test("baseline: buildCard keeps the current card shape", () => {
  const span = "const a = 1;\nThe task must keep the prefix.\n";
  const card = buildCard(span, "");
  assert.equal(card.verdict, "TRUNK CONFIRMED");
  assert.ok(card.text.startsWith("Spine extract."));
  assert.ok(card.text.includes("TRUNK CONFIRMED against dynamic-v1."));
  assert.ok(card.text.includes("Kept lines:"));
  assert.ok(card.text.endsWith("A shadow path is not live preservation. Read a deferred file before using it."));
});

test("baseline: buildCard confirms when the hard line already lives in the live context", () => {
  const span = "The task must keep the prefix.\n";
  const card = buildCard(span, "The task must keep the prefix.");
  assert.equal(card.verdict, "TRUNK CONFIRMED");
  assert.equal(card.missing.length, 0);
});

test("baseline: planText folds code fences and counts their lines", () => {
  const split = planText("intro prose\n```\nline one\nline two\n```\ntail prose");
  // A fence contributes its closing marker plus the lines inside it.
  assert.equal(split.codeLines, 4);
  assert.ok(split.covered.some((entry) => entry.includes("line one")));
  assert.ok(split.uncovered.includes("intro prose"));
});

test("baseline: repeatedNames reports names seen twice", () => {
  const names = repeatedNames("fooBar appears, fooBar again, baz once");
  assert.ok(names.has("fooBar"));
  assert.ok(!names.has("baz"));
});

test("baseline: planMessages routes an empty conversation locally", () => {
  const plan = planMessages([]);
  assert.equal(plan.route, "local");
  assert.equal(plan.chars, 0);
  assert.ok(plan.text.startsWith("Spine extract."));
});

test("baseline: thunder decisions stay stable", () => {
  assert.equal(sharedPrefixLength("abcdef", "abcdef"), 6);
  assert.equal(decideThunder({ previous: "x".repeat(100), next: "x".repeat(100) }), "attach");
  assert.equal(decideThunder({ previous: "a".repeat(100), next: "b".repeat(100) }), "send-less");
});

test("baseline: buildSendLess keeps the task line and facts", () => {
  const text = buildSendLess({ taskLine: "do the thing", uncovered: "", facts: ["fact one"] });
  assert.ok(text.startsWith("do the thing"));
  assert.ok(text.includes("Facts already copied locally:"));
  assert.ok(text.includes("- fact one"));
});
