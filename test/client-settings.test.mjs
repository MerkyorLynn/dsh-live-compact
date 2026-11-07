import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

// Optional local integration run against the matching host's unmodified model.
const upstream = process.env.DSH_SETTINGS_MODEL_SOURCE;
function createSnapshotStore(initial) {
  let state = initial;
  const listeners = new Set();
  return {
    getSnapshot: () => state,
    set(next) { state = next; for (const listener of listeners) listener(); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

// Contract double for dependency-free CI; edit takes a FIELD NAME, never field state.
class ContractModel {
  constructor(scope, specs) {
    this.scope = scope;
    this.names = new Set(specs.map((spec) => spec.field));
    this.drafts = new Map();
    this.listeners = new Set();
    this.saving = false;
    this.failed = false;
    this.unsubscribe = scope.subscribe(() => this.publish());
  }
  publish() { for (const listener of this.listeners) listener(); }
  bind(project) {
    const store = createSnapshotStore(project());
    this.listeners.add(() => store.set(project()));
    return store;
  }
  shell() {
    const snapshot = this.scope.getSnapshot();
    return { available: snapshot.status === "ready", writable: snapshot.writable,
      dirty: this.drafts.size > 0, invalid: false, saving: this.saving, failed: this.failed };
  }
  field(name) {
    assert.equal(this.names.has(name), true, `unknown field: ${String(name)}`);
    return { text: this.drafts.get(name) ?? String(this.scope.getSnapshot().value[name]),
      overridden: this.drafts.has(name), invalid: false };
  }
  actions() {
    return {
      edit: (name, text) => {
        assert.equal(typeof name, "string", "edit expects a field name, not field state");
        this.field(name);
        this.drafts.set(name, text);
        this.publish();
      },
      resetField: (name) => { this.drafts.set(name, ""); this.publish(); },
      discard: () => { this.drafts.clear(); this.publish(); },
      save: () => { void this.save(); },
    };
  }
  async save() {
    if (!this.scope.getSnapshot().writable) return;
    this.saving = true; this.publish();
    const ops = [...this.drafts].map(([name, text]) => text === ""
      ? { op: "unset", path: [name] } : { op: "set", path: [name], value: name === "takeoverPresets" ? text === "true" : Number(text) });
    const accepted = await this.scope.mutate(ops, this.scope.getSnapshot().revision);
    this.failed = !accepted;
    if (accepted) this.drafts.clear();
    this.saving = false; this.publish();
  }
  dispose() { this.unsubscribe(); this.listeners.clear(); }
}

let SettingsFormModel = ContractModel;
let settingsNumberField = (field) => ({ field });
if (upstream) {
  const compiled = stripTypeScriptTypes(readFileSync(upstream, "utf8"), { mode: "transform" })
    .replace(/^import .*$/m, "").replace(/^export /gm, "");
  const context = { createSnapshotStore };
  vm.runInNewContext(`${compiled}\nthis.Model = SettingsFormModel; this.numberField = settingsNumberField;`, context);
  SettingsFormModel = context.Model;
  settingsNumberField = context.numberField;
}

function harness({ writable = true, accept = true } = {}) {
  let snapshot = { status: "ready", writable, revision: 7, base: {}, user: {},
    value: { takeoverPresets: true, minTokens: 20000, pointerTokens: 40000, keepRounds: 3,
      chunkMin: 1000, chunkMax: 32000, keepRoundTokens: 32000, bigGate: 650000,
      cooldownMs: 0, thresholdRatio: 0.8, headroomTokens: 65536, retainTokens: 8192, compactionRetries: 0 } };
  const defaults = { ...snapshot.value };
  const listeners = new Set();
  const writes = [];
  const scope = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    async mutate(ops, revision) {
      writes.push(JSON.parse(JSON.stringify({ ops, revision })));
      if (!accept) return false;
      const user = { ...snapshot.user };
      for (const op of ops) {
        if (op.op === "unset") delete user[op.path[0]];
        else user[op.path[0]] = op.value;
      }
      snapshot = { ...snapshot, user, value: { ...defaults, ...user }, revision: revision + 1 };
      for (const listener of listeners) listener();
      return true;
    },
  };
  function SettingsForm() {}
  function SettingsValueField() {}
  function Switch() {}
  const primitives = { SettingsFormModel, settingsNumberField, SettingsForm, SettingsValueField, Switch };
  const effects = [];
  let bundle;
  let entry;
  let Page;
  const dictionaries = {};
  const ctx = {
    configForms: {
      get: (ns) => { assert.equal(ns, "compaction-spine"); return scope; },
      whileServed: (names, register) => { assert.deepEqual(Array.from(names), ["compaction-spine"]); return register(new Set(names)); },
    },
    locale: {
      bind: (ns) => (key) => dictionaries[ns]?.zh[key] ?? key,
      register: (ns, dict) => { dictionaries[ns] = dict; return () => {}; },
    },
    effect: (run) => { effects.push(run()); },
    slots: {
      inject: (name, register) => { assert.equal(name, "plugins.row.config"); return register(); },
      register: (options, component) => { entry = options; Page = component; return () => {}; },
    },
  };
  const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }) };
  const window = { __ModuleLoader__: { load: ({ factory }) => {
    bundle = factory((name) => {
      if (name === "react") return React;
      assert.equal(name, "@deepseek-ai/dsh-client-ui-primitives");
      return primitives;
    });
  } } };
  vm.runInNewContext(readFileSync(new URL("../client.js", import.meta.url), "utf8"), { window });
  bundle.apply(ctx);
  const face = entry.inject();
  const render = (view = "page") => Page({ ...face, view,
    t: (key) => dictionaries.liveCompact.zh[key] ?? key,
    useLiveCompact: (select) => select(face.hooks.liveCompact.getSnapshot()) });
  const fields = () => {
    const result = [];
    function walk(node) {
      if (!node || typeof node !== "object") return;
      if (node.type === SettingsValueField) result.push(node.props);
      for (const child of node.children ?? []) walk(child);
    }
    walk(render());
    return result;
  };
  const presetSwitch = () => {
    const find = (node) => {
      if (!node || typeof node !== "object") return undefined;
      if (node.type === Switch) return node.props;
      return (node.children ?? []).map(find).find(Boolean);
    };
    return find(render());
  };
  const save = () => new Promise((resolve) => {
    const store = face.hooks.liveCompact;
    const unsubscribe = store.subscribe(() => {
      if (!store.getSnapshot().saving) { unsubscribe(); resolve(); }
    });
    render().props.onSave();
  });
  return { entry, render, fields, presetSwitch, face, writes, save, snapshot: () => snapshot,
    dispose: () => { for (const dispose of effects.reverse()) dispose(); }, listeners };
}

test("native slot exposes common and advanced fields", () => {
  const ui = harness();
  assert.equal(ui.entry.key, "dsh-live-compact#compaction-spine");
  assert.equal(ui.fields().length, 12);
  assert.equal(ui.fields()[0].text, "20000");
  assert.equal(ui.fields()[0].disabled, false);
  assert.equal(typeof ui.render("summary"), "string");
  ui.dispose();
});

test("typing and numeric stepping echo through the model without a crash", () => {
  const ui = harness();
  const texts = ["25000", "25001", "25000", "", "20000", "21000"];
  for (const text of texts) {
    ui.fields()[0].onEdit(text);
    assert.equal(ui.fields()[0].text, text);
  }
  assert.equal(ui.face.hooks.liveCompact.getSnapshot().dirty, true);
  assert.equal(ui.writes.length, 0, "typing must not write settings");
  ui.dispose();
});

test("discard drops the draft and reset stages an unset", async () => {
  const ui = harness();
  ui.fields()[0].onEdit("25000");
  ui.render().props.onDiscard();
  assert.equal(ui.fields()[0].text, "20000");
  ui.fields()[0].onEdit("25000");
  await ui.save();
  ui.fields()[0].onReset();
  await ui.save();
  assert.deepEqual(ui.writes.at(-1).ops, [{ op: "unset", path: ["minTokens"] }]);
  assert.equal(ui.snapshot().value.minTokens, 20000);
  ui.dispose();
});

test("save writes numeric ops at the starting revision and refreshes the page", async () => {
  const ui = harness();
  ui.fields()[0].onEdit("25000");
  ui.fields().find((field) => field.id.endsWith("thresholdRatio")).onEdit("0.75");
  const pending = ui.save();
  assert.equal(ui.render().props.state.saving, true);
  await pending;
  assert.deepEqual(ui.writes, [{ revision: 7, ops: [
    { op: "set", path: ["minTokens"], value: 25000 },
    { op: "set", path: ["thresholdRatio"], value: 0.75 },
  ] }]);
  assert.equal(ui.render().props.state.saving, false);
  assert.equal(ui.render().props.state.dirty, false);
  assert.equal(ui.fields()[0].text, "25000");
  ui.dispose();
});

test("host refusal preserves drafts and exposes save failure", async () => {
  const ui = harness({ accept: false });
  ui.fields()[0].onEdit("25000");
  await ui.save();
  assert.equal(ui.render().props.state.failed, true);
  assert.equal(ui.fields()[0].text, "25000");
  ui.dispose();
});

test("preset takeover switch stages and saves a boolean, not a string", async () => {
  const ui = harness();
  assert.equal(ui.presetSwitch().checked, true);
  ui.presetSwitch().onChange(false);
  assert.equal(ui.presetSwitch().checked, false);
  assert.equal(ui.writes.length, 0);
  await ui.save();
  assert.deepEqual(ui.writes[0], { revision: 7, ops: [
    { op: "set", path: ["takeoverPresets"], value: false },
  ] });
  assert.equal(ui.snapshot().value.takeoverPresets, false);
  ui.dispose();
});

test("read-only host disables fields and disposing releases its subscription", () => {
  const ui = harness({ writable: false });
  assert.equal(ui.fields().every((field) => field.disabled), true);
  ui.dispose();
  assert.equal(ui.listeners.size, 0);
});
