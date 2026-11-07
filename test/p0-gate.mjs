import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import {
  attachBackupHint,
  backupHint,
  buildCard,
  withoutFullBackupClaim,
} from "../plan.js";
import SpineCompactionEngine, {
  freshShadowFile,
  isCheckpoint,
  saveShadow,
  spineCheckpointSource,
} from "../index.js";
import {
  captureOwnedToolResult,
  captureToolResult,
} from "../raw.js";
import {
  defaultShadowAccessRunner,
  resetShadowAccessState,
  sessionDir,
  shadowAccessPlan,
  tightenShadow,
  win32Tool,
  writeShadowOwner,
} from "../shadow.js";
import { windowsAclCall } from "./helpers/windows-acl.mjs";
import { DEFAULTS, readSettings } from "../settings.js";
import shellEntry from "../shell.js";

const failures = [];

function check(name, fn) {
  try {
    fn();
    console.log(`pass ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.error(`fail ${name}: ${error.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`pass ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.error(`fail ${name}: ${error.message}`);
  }
}

check("p0-2 tool fact is not dropped while ok", () => {
  const fact = "部署区域是 cn-north-7，后续查询都走这个值。";
  const lines = Array.from({ length: 30 }, (_, i) => `ordinary log entry ${i} happened during the run`);
  lines.splice(10, 0, fact);
  const toolText = lines.join("\n");
  const spans = [
    { role: "tool", text: toolText, toolCallId: "call-repro", known: true, command: "read" },
  ];
  const card = buildCard(toolText, "", spans, {});
  assert.equal(card.ok, true);
  assert.equal(card.text.includes(`- [tool] ${fact}`), true);
  assert.equal(card.text.includes(`- [other] ${fact}`), false);
  assert.equal(card.text.includes(`- [assistant] ${fact}`), false);

  const liveCard = buildCard(toolText, fact, spans, {});
  assert.equal(liveCard.ok, true);
  assert.equal(liveCard.text.includes(`- [other] ${fact}`), false);
  assert.equal(liveCard.text.includes(`- [assistant] ${fact}`), false);
});

check("p0-2 assistant decision refuses the cut without copying", () => {
  const decision =
    "我们决定采用方案 B，因为方案 A 会破坏现有缓存前缀。";
  const spans = [{ role: "assistant", text: decision }];

  const card = buildCard(decision, "", spans, {});
  assert.notEqual(card.ok, true);
  assert.equal(card.hardCount, 0);
  assert.equal(card.text.includes(decision), false);
  assert.equal(card.missing.includes(decision), true);

  const liveCard = buildCard(decision, decision, spans, {});
  assert.equal(liveCard.ok, true);
  assert.equal(liveCard.hardCount, 0);
  assert.equal(liveCard.text.includes(decision), false);

  for (const result of [card, liveCard]) {
    assert.equal(result.text.includes("方案 B"), false);
    assert.equal(result.text.includes("缓存前缀"), false);
  }
});

check("p0-2 ordinary assistant prose stays excluded", () => {
  const user = "把这个插件的配置再确认一遍。";
  const prose = [
    "我先检查配置文件。",
    "然后核对日志。",
    "用户要求：先看日志",
    "已发布",
    "已推送",
  ].join("\n");

  const card = buildCard(
    `${user}\n${prose}`,
    "",
    [
      { role: "user", text: user },
      { role: "assistant", text: prose },
    ],
    {},
  );

  assert.equal(card.ok, true);
  for (const line of prose.split("\n")) {
    assert.equal(card.text.includes(line), false);
  }
  for (const phrase of ["先看日志", "检查配置", "核对日志", "已发布", "已推送"]) {
    assert.equal(card.text.includes(phrase), false);
  }
});

check("p0-2 omitted long tool line refuses even with empty kept", () => {
  const fact = "本次访问口令为 CONTINUITY-TOKEN-7F3A";
  const line =
    "x".repeat(100000) + fact + "y".repeat(100000);
  const spans = [{
    role: "tool",
    text: line,
    toolCallId: "long-result",
    known: true,
  }];

  const card = buildCard(line, "", spans, {});

  assert.equal(card.text.includes(fact), false);
  assert.match(
    card.text,
    /Kept lines:\n- \(none\)\n工具证据:/,
  );
  assert.equal(card.ok, false);
  assert.equal(card.missing.includes(line), true);

  const liveCard = buildCard(line, line, spans, {});
  assert.equal(liveCard.ok, true);
});

check("p0-2 out-of-cut tool is ignored", () => {
  const user = "必须保留当前部署上下文。";
  const fact = "部署区域是 cn-north-7，采用方案 B。";
  const card = buildCard(`${user}\n${fact}`, "", [
    { role: "user", text: user, inCut: true },
    {
      role: "tool",
      text: fact,
      inCut: false,
      toolCallId: "outside-cut",
      known: true,
    },
  ], {});

  assert.equal(card.ok, true);
  assert.equal(card.text.includes(user), true);
  assert.equal(card.text.includes(fact), false);
  assert.equal(card.missing.includes(fact), false);
});

check("p0-1 windows plan replaces the complete protected DACL", () => {
  const sid = "S-1-5-21-100-200-300-1001";
  const plan = shadowAccessPlan("win32", sid);
  assert.equal(plan.kind, "acl");
  assert.equal(plan.usesChmodOnly, false);
  assert.equal(plan.replace, true);
  assert.equal(plan.protected, true);
  assert.equal(plan.rights, "FullControl");
  assert.deepEqual(plan.allow, [sid, "S-1-5-18", "S-1-5-32-544"]);
  assert.deepEqual(plan.inheritance, ["ObjectInherit", "ContainerInherit"]);
  assert.deepEqual(shadowAccessPlan("win32", sid, "file").inheritance, []);
});

check("p0-1 windows default runner replaces and verifies the protected DACL", () => {
  const sid = "S-1-5-21-100-200-300-1001";
  const root = mkdtempSync(join(tmpdir(), "spine-p0-windows-"));
  const env = { SystemRoot: "D:\\WinX" };
  const whoami = win32Tool("whoami.exe", env);
  try {
    for (const kind of ["dir", "file"]) {
      const target = join(root, kind);
      if (kind === "dir") mkdirSync(target);
      else writeFileSync(target, "");
      resetShadowAccessState();
      const calls = [];
      const execFile = (file, args, options) => {
        calls.push({ file, args: [...args] });
        if (file === whoami) return `"DESKTOP-P0","${sid}"`;
        const action = windowsAclCall(file, args, options, env, sid);
        assert.equal(action.path, realpathSync.native(target));
        assert.equal(action.kind, kind);
        return "DSH_SHADOW_ACL_OK";
      };
      assert.equal(defaultShadowAccessRunner({ path: target, kind, platform: "win32", execFile, env }), true);
      assert.equal(calls.length, 2);
      assert.equal(calls[0].file, whoami);
      assert.deepEqual(calls[0].args, ["/user", "/fo", "csv", "/nh"]);
      assert.equal(calls.some((call) => String(call.file).includes("C:\\Windows")), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetShadowAccessState();
  }
});

check("p0-1 windows DACL replacement failure closes the write", () => {
  const sid = "S-1-5-21-100-200-300-1001";
  const env = { SystemRoot: "D:\\WinX" };
  const whoami = win32Tool("whoami.exe", env);
  const powershell = win32Tool("WindowsPowerShell\\v1.0\\powershell.exe", env);
  const target = mkdtempSync(join(tmpdir(), "spine-p0-denied-"));
  try {
    resetShadowAccessState();
    chmodSync(target, 0o755);
    const calls = [];
    assert.throws(
      () => tightenShadow(target, "dir", {
        platform: "win32",
        env,
        execFile(file) {
          calls.push(file);
          if (file === whoami) return `"DESKTOP-P0","${sid}"`;
          throw Object.assign(new Error("injected DACL failure"), { status: 1300 });
        },
      }),
      (error) => error?.code === "ESHADOWACCESS",
    );
    assert.deepEqual(calls, [whoami, powershell]);
    if (process.platform !== "win32") {
      assert.equal(statSync(target).mode & 0o777, 0o755);
    }
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

check("p0-1 false permission result closes the write", () => {
  const target = mkdtempSync(join(tmpdir(), "spine-p0-false-"));
  try {
    chmodSync(target, 0o755);
    assert.throws(
      () => tightenShadow(target, "dir", {
        platform: "win32",
        runner() {
          return false;
        },
      }),
      (error) => error?.code === "ESHADOWACCESS",
    );
    if (process.platform !== "win32") {
      assert.equal(statSync(target).mode & 0o777, 0o755);
    }
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

check("p0-1 whoami failure does not fall back to chmod", () => {
  const target = mkdtempSync(join(tmpdir(), "spine-p0-whoami-"));
  try {
    const cases = [
      () => { throw new Error("whoami missing"); },
      () => "",
      () => `"DESKTOP\\p0","not-a-sid"`,
    ];
    for (const whoami of cases) {
      resetShadowAccessState();
      chmodSync(target, 0o755);
      const calls = [];
      const tool = win32Tool("whoami.exe", { SystemRoot: "D:\\WinX" });
      assert.throws(
        () => tightenShadow(target, "dir", {
          platform: "win32",
          env: { SystemRoot: "D:\\WinX" },
          execFile(file) {
            calls.push(file);
            return whoami();
          },
        }),
        (error) => error?.code === "ESHADOWACCESS",
      );
      assert.deepEqual(calls, [tool]);
      if (process.platform !== "win32") {
        assert.equal(statSync(target).mode & 0o777, 0o755);
      }
    }
    if (process.platform !== "win32") {
      chmodSync(target, 0o755);
      assert.throws(
        () => tightenShadow(target, "dir", { platform: "win32" }),
        (error) => error?.code === "ESHADOWACCESS",
      );
      assert.equal(statSync(target).mode & 0o777, 0o755);
    }
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

check("p0-1 unix backup access stays mode-based", () => {
  const plan = shadowAccessPlan("darwin");
  assert.equal(plan.kind, "mode");
  assert.equal(plan.dirMode, 0o700);
  assert.equal(plan.fileMode, 0o600);
});

check("p0-12 new cards use spine checkpoints without summary markers", () => {
  const user = "必须保留当前任务上下文。";
  const card = buildCard(user, "", [{ role: "user", text: user }], {});
  assert.equal(card.ok, true);
  assert.equal(card.text.includes("compacted-summary"), false);
  assert.equal(card.text.includes("compact-checkpoint"), false);

  const source = spineCheckpointSource("p0-compaction");
  assert.equal(source.kind, "spine-checkpoint");

  const session = (kind) => ({
    eventAt() {
      return {
        type: "user/message",
        data: {
          content: "普通用户消息",
          ...(kind ? { source: { kind } } : {}),
        },
      };
    },
  });
  assert.equal(isCheckpoint(session("compact-checkpoint"), 1), true);
  assert.equal(isCheckpoint(session("spine-checkpoint"), 1), true);
  assert.equal(isCheckpoint(session(), 1), false);
});

await checkAsync("p0-12 commitSelectedSpan writes a path-free spine checkpoint", async () => {
  const shadowRoot = join(tmpdir(), "spine-p0-commit-shadow");
  const conversationDir = sessionDir(shadowRoot, "p0-commit");
  const backupFile = join(conversationDir, "cut-p0-commit.txt");
  const previousShadowDir = process.env.SPINE_SHADOW_DIR;
  process.env.SPINE_SHADOW_DIR = shadowRoot;

  try {
    const appended = [];
    const session = {
      id: "p0-commit",
      dir: conversationDir,
      surface: { nodes: [41] },
      eventAt(seq) {
        assert.equal(seq, 41);
        return {
          type: "user/message",
          data: { content: "必须保留当前任务上下文。" },
        };
      },
      append(type, data, options) {
        const event = { seq: 100 + appended.length, type, data, options };
        appended.push(event);
        return event;
      },
    };
    const chunk = {
      start: 41,
      end: 41,
      tokens: 20,
      card: attachBackupHint(
        buildCard("必须保留当前任务上下文。", "", [
          { role: "user", text: "必须保留当前任务上下文。" },
        ], {}),
        backupFile,
      ),
    };
    assert.equal(chunk.card.ok, true);
    assert.equal(chunk.card.text.includes(backupFile), false);
    const engine = {
      ctx: {
        tokenMeter: {
          estimateMessage() {
            return chunk.tokens - 1;
          },
        },
        sessions: { flush() {} },
      },
      async summarize(input) {
        const received = JSON.stringify(input);
        assert.equal(received.length > 2, true);
        const messages = JSON.stringify(input?.messages || []);
        assert.equal(messages.includes(backupFile), false);
        assert.equal(messages.includes(shadowRoot), false);
        assert.equal(String(input?.liveCompact?.card?.text || "").includes(backupFile), false);
        return {
          summary: [{ type: "text", text: "不含路径的摘要。" }],
          provider: "local",
          model: "spine-extract",
        };
      },
    };

    await SpineCompactionEngine.prototype.commitSelectedSpan.call(
      engine,
      { session },
      chunk,
      new AbortController().signal,
    );

    const serialized = JSON.stringify(appended);
    assert.equal(appended.some((event) => event.type === "user/message"), true);
    assert.equal(serialized.includes("不含路径的摘要。"), true);
    assert.equal(serialized.includes("Spine extract."), true);
    for (const event of appended.filter((item) => item.type === "user/message")) {
      assert.equal(event.data.source.kind, "spine-checkpoint");
    }
    for (const forbidden of [
      "compacted-summary",
      "compact-checkpoint",
      "省略的工具原文在",
      "SPINE_SHADOW_DIR",
      shadowRoot,
      conversationDir,
      basename(backupFile),
    ]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  } finally {
    if (previousShadowDir === undefined) delete process.env.SPINE_SHADOW_DIR;
    else process.env.SPINE_SHADOW_DIR = previousShadowDir;
  }
});

check("p0-1 card text does not receive the backup path", () => {
  const path = "/Users/lynn/.dsh/compaction-spine/shadow/cut-1.txt";
  const card = attachBackupHint({ ok: true, text: "卡片正文没有路径。" }, path);
  assert.equal(card.text.includes("/Users/lynn"), false);
  assert.equal(card.text.includes("compaction-spine"), false);
  assert.equal(card.text.includes(path), false);
  assert.equal(withoutFullBackupClaim(card.text, path).includes(path), false);

  const claim = backupHint(path);
  assert.equal(claim.includes(path), true);
  const cleaned = withoutFullBackupClaim(`前文\n${claim}\n后文`, path);
  assert.equal(cleaned.includes(path), false);
  assert.equal(cleaned.includes("省略的工具原文在"), false);
  assert.equal(cleaned.includes("前文"), true);
  assert.equal(cleaned.includes("后文"), true);
  assert.notEqual(cleaned, claim);
});

function filesUnder(dir) {
  const files = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(path));
    else files.push(path);
  }

  return files;
}

function withShadowRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), "spine-p0-"));
  const previous = process.env.SPINE_SHADOW_DIR;
  process.env.SPINE_SHADOW_DIR = root;

  try {
    return fn(root);
  } finally {
    if (previous === undefined) delete process.env.SPINE_SHADOW_DIR;
    else process.env.SPINE_SHADOW_DIR = previous;

    rmSync(root, { recursive: true, force: true });
  }
}

const writeCases = [
  {
    name: "freshShadowFile",
    fileActions: 0,
    run(root, access) {
      return freshShadowFile("p0", "p0-session", access);
    },
  },
  {
    name: "saveShadow",
    fileActions: 2,
    run(root, access) {
      const dir = sessionDir(root, "p0-session");
      return saveShadow.call(
        {
          ctx: { logger: {} },
          warnShadowFull() {},
          warnShadowOversize() {},
        },
        [{ role: "user", content: "p0-secret span text" }],
        true,
        join(dir, "p0-backup.txt"),
        "p0-session",
        [],
        access,
      );
    },
  },
  {
    name: "captureToolResult",
    fileActions: 2,
    run(root, access) {
      return captureToolResult({
        dir: sessionDir(root, "p0-session"),
        toolCallId: "p0-raw",
        text: "private raw payload",
        access,
      });
    },
  },
  {
    name: "owner",
    fileActions: 1,
    run(root, access) {
      return writeShadowOwner(
        sessionDir(root, "p0-session"),
        access,
      );
    },
  },
  {
    name: "captureOwnedToolResult",
    fileActions: 3,
    run(root, access) {
      return captureOwnedToolResult({
        dir: sessionDir(root, "p0-session"),
        toolCallId: "p0-owned-raw",
        text: "private raw payload",
        access,
      });
    },
  },
];

for (const item of writeCases) {
  check(`p0-1 ${item.name} invokes protection and fails closed`, () => {
    let actionCount = 0;

    withShadowRoot((root) => {
      const actions = [];

      item.run(root, {
        platform: "win32",
        runner(action) {
          actions.push(action);
          assert.equal(action.platform, "win32");

          if (action.kind === "file") {
            assert.equal(readFileSync(action.path).length, 0);
          }

          return true;
        },
      });

      assert.equal(
        actions.some((action) => action.kind === "dir"),
        true,
      );
      assert.equal(
        actions.filter((action) => action.kind === "file").length,
        item.fileActions,
      );
      assert.deepEqual(
        new Set(actions.filter((action) => action.kind === "file").map((action) => action.path)),
        new Set(filesUnder(root)),
      );
      if (item.name === "saveShadow") {
        const written = filesUnder(root).filter((file) => file.endsWith("p0-backup.txt"));
        assert.equal(written.length, 1);
        assert.equal(readFileSync(written[0], "utf8").includes("p0-secret span text"), true);
      }

      actionCount = actions.length;
      assert.ok(actionCount > 0);
    });

    for (let failAt = 1; failAt <= actionCount; failAt += 1) {
      for (const failure of ["throw", "false"]) {
        withShadowRoot((root) => {
          let calls = 0;

          assert.throws(
            () => item.run(root, {
              platform: "win32",
              runner(action) {
                calls += 1;

                if (action.kind === "file") {
                  assert.equal(readFileSync(action.path).length, 0);
                }

                if (calls === failAt) {
                  if (failure === "throw") {
                    throw new Error("injected permission failure");
                  }
                  return false;
                }

                return true;
              },
            }),
            (error) => error?.code === "ESHADOWACCESS",
          );

          assert.equal(calls, failAt);
          assert.deepEqual(filesUnder(root), []);
        });
      }
    }
  });
}

if (process.platform !== "win32") {
  check("p0-1 default unix runner applies directory and file modes", () => {
    withShadowRoot((root) => {
      const dir = sessionDir(root, "p0-modes");
      const record = captureToolResult({
        dir,
        toolCallId: "p0-modes",
        text: "private raw payload",
      });

      assert.equal(record.ok, true);
      assert.equal(statSync(dir).mode & 0o777, 0o700);
      assert.equal(statSync(record.path).mode & 0o777, 0o600);
      assert.equal(statSync(`${record.path}.meta.json`).mode & 0o777, 0o600);
    });
  });

  const previousUmask = process.umask(0o022);
  try {
    for (const item of writeCases) {
      check(`p0-1 ${item.name} default runner tightens existing directory and new files`, () => {
        withShadowRoot((root) => {
          const dir = sessionDir(root, "p0-session");
          mkdirSync(dir, { recursive: true, mode: 0o755 });
          chmodSync(dir, 0o755);

          item.run(root);

          assert.equal(statSync(dir).mode & 0o777, 0o700);
          for (const file of filesUnder(root)) {
            assert.equal(statSync(file).mode & 0o777, 0o600);
          }
        });
      });
    }
  } finally {
    process.umask(previousUmask);
  }
}

const indexSource = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const packageRoot = fileURLToPath(new URL("../", import.meta.url));

function packageJavaScriptFiles(dir) {
  const files = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "test" || entry.name === "node_modules") continue;
      files.push(...packageJavaScriptFiles(path));
    } else if (entry.isFile() && /\.(?:js|mjs|cjs)$/.test(entry.name)) {
      files.push(path);
    }
  }

  return files;
}

check("p0-15 source has no SPINE_MAX_TOKENS", () => {
  const files = packageJavaScriptFiles(packageRoot);
  assert.ok(files.length > 0);
  for (const file of files) {
    assert.equal(/\bSPINE_MAX_TOKENS\b/.test(readFileSync(file, "utf8")), false, file);
  }
});

check("p0-15 bigGate stays 650000 with SPINE_MAX_TOKENS=1", () => {
  const output = execFileSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `import Engine, { BIG_GATE } from "dsh-live-compact/engine";
     import { DEFAULTS } from "./settings.js";
     if (typeof Engine !== "function" || BIG_GATE !== DEFAULTS.bigGate) throw new Error("engine export contract");
     process.stdout.write(String(BIG_GATE));`,
  ], {
    cwd: packageRoot,
    encoding: "utf8",
    env: { ...process.env, SPINE_MAX_TOKENS: "1" },
  });
  assert.equal(output, "650000");
});

check("p0-15 package does not call shadow search", () => {
  const files = packageJavaScriptFiles(packageRoot)
    .filter((file) => !file.endsWith(`${sep}shadow-search.js`));
  assert.ok(files.length > 0);
  for (const file of files) {
    assert.equal(/shadow-search|searchShadow/.test(readFileSync(file, "utf8")), false, file);
  }
});

check("p0-15 importing index never resolves shadow-search.js", () => {
  const moduleURL = new URL("../index.js", import.meta.url).href;
  const hookLog = join(mkdtempSync(join(tmpdir(), "spine-p0-hook-")), "resolved.txt");
  const hookSource = `
    import { appendFileSync } from "node:fs";
    export async function resolve(specifier, context, nextResolve) {
      const resolved = await nextResolve(specifier, context);
      appendFileSync(${JSON.stringify(hookLog)}, specifier + " " + resolved.url + "\\n");
      return resolved;
    }
  `;
  const hookURL = `data:text/javascript,${encodeURIComponent(hookSource)}`;
  const script = `
    import * as module from "node:module";
    await module.register(${JSON.stringify(hookURL)});
    await import(${JSON.stringify(moduleURL)});
    process.stdout.write("ok");
  `;
  const output = execFileSync(process.execPath, [
    "--input-type=module",
    "--eval",
    script,
  ], { encoding: "utf8" });
  assert.equal(output, "ok");
  const resolved = readFileSync(hookLog, "utf8");
  assert.equal(resolved.length > 0, true);
  assert.equal(/shadow-search/.test(resolved), false);
});

check("p0-15 package version is 1.1.2", () => {
  assert.equal(packageJson.version, "1.1.2");
});

check("p0-15 README drops obsolete backup limits", () => {
  assert.equal(/\b(64|128)\s*Mi?B\b/i.test(readme), false);
});

// 服务端只认 adapter.js；客户端 bundle 在宿主模块图里跑，只能自己 require 一次官方 primitives。
check("p0-16 only the adapter and the client bundle import a DSH package", () => {
  const allowed = new Set([join(packageRoot, "adapter.js"), join(packageRoot, "client.js")]);
  const files = packageJavaScriptFiles(packageRoot);
  assert.ok(files.includes(join(packageRoot, "adapter.js")));
  for (const file of files) {
    const imports = /(?:from\s*|import\(\s*|require\(\s*)["']@deepseek-ai\//.test(readFileSync(file, "utf8"));
    assert.equal(imports, allowed.has(file), file);
  }
  const client = readFileSync(join(packageRoot, "client.js"), "utf8");
  assert.equal((client.match(/["']@deepseek-ai\//g) ?? []).length, 1, "client names exactly one DSH package");
});

check("p0-16 package ships adapter.js", () => {
  assert.equal(packageJson.files.includes("adapter.js"), true);
});

check("p0-17 settings schema owns the plugin knobs", () => {
  const shape = shellEntry.Config({});
  const plain = (value) => (value && typeof value === "object" && typeof value.get === "function" ? value.get() : value);
  const knobs = ["minTokens", "keepRounds", "keepRoundTokens", "pointerTokens", "chunkMin", "chunkMax", "bigGate", "cooldownMs"];
  for (const key of knobs) assert.equal(plain(shape[key]), undefined, `${key} preserves absence for env fallback`);
  assert.deepEqual(readSettings(shape, {}), { ...DEFAULTS, pointerTokens: DEFAULTS.chunkMax });
  assert.equal(plain(shape.takeoverPresets), true);
  for (const key of ["auto", "thresholdRatio", "headroomTokens", "retainTokens", "compactionRetries"]) {
    assert.equal(key in shape, true, key);
  }
  // 宿主设置界面只列 volatile 字段，漏标整份表单就不出现。
  for (const [key, field] of Object.entries(shellEntry.Config.dict)) {
    assert.equal(field.meta?.volatile, true, key);
  }
});

check("p0-18 settings UI ships through native client slots", () => {
  assert.equal(packageJson.exports["./client"], "./client.js");
  assert.equal(packageJson.dsh.client.platform, "web");
  assert.equal(packageJson.files.includes("client.js"), true);
  const source = readFileSync(join(packageRoot, "client.js"), "utf8");
  assert.match(source, /window\.__ModuleLoader__\.load\(/);
  assert.match(source, /require\("react"\)/);
  assert.match(source, /plugins\.row\.config/);
  assert.match(source, /locale\.register/);
  assert.match(source, /SettingsFormModel/);
  assert.match(source, /settingsNumberField/);
  assert.match(source, /configForms/);
  assert.match(source, /SettingsValueField/);
  assert.match(source, /props\.edit\(name, text\)/);
  assert.match(source, /hooks: \{ liveCompact: store \}/);
  assert.match(source, /model\.dispose\(\)/);
  assert.equal(/^\s*(?:import|export)\s/m.test(source), false);
  assert.equal(/from\s*["']@deepseek-ai\//.test(source), false);
});

check("p0-18 bundle exposes one component with an internal preset gate", () => {
  const patch = readFileSync(join(packageRoot, "cordis.patch.yml"), "utf8");
  assert.equal((patch.match(/name: dsh-live-compact\b/g) ?? []).length, 1);
  assert.equal(patch.includes("live-compact-gate"), false);
  assert.match(patch, /takeoverPresets: true/);
  assert.match(readFileSync(join(packageRoot, "shell.js"), "utf8"), /installPresetGate\(ctx, config\)/);
});

check("p0-17 config beats env beats default", () => {
  const env = { SPINE_MIN_TOKENS: "9000", SPINE_CHUNK_MIN: "500" };
  assert.equal(readSettings({}, env).minTokens, 9000);
  assert.equal(readSettings({ minTokens: 1234 }, env).minTokens, 1234);
  assert.equal(readSettings({}, {}).minTokens, DEFAULTS.minTokens);
  assert.equal(readSettings({}, {}).pointerTokens, DEFAULTS.chunkMax);
  assert.equal(readSettings({ chunkMax: 40000 }, {}).pointerTokens, 40000);
  assert.equal(readSettings({ chunkMax: 40000, pointerTokens: 7000 }, {}).pointerTokens, 7000);
});

if (failures.length) {
  console.error(`p0 gate failed: ${failures.length}`);
  process.exit(1);
}
console.log("p0 gate passed");
