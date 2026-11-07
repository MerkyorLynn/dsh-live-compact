import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureShadowDir, tightenShadow, writeShadowFile } from "./shadow.js";

const [role, root, expectedSid] = process.argv.slice(2);
const system32 = join(process.env.SystemRoot, "System32");
const whoami = join(system32, "whoami.exe");
const identity = execFileSync(whoami, ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" });
const groups = execFileSync(whoami, ["/groups"], { encoding: "utf8" });
if (!identity.includes(expectedSid) || !groups.includes("S-1-16-8192") || groups.includes("S-1-5-32-544")) {
  throw new Error("Standard-user token precondition failed");
}
const shadow = join(root, "shadow");
const payload = join(shadow, "cut-1-abcdef01.txt");
const legacy = join(shadow, "raw-abcdef0100000000.txt");
const replaced = join(root, "replaced");
const replacementPayload = join(replaced, "cut-2-abcdef02.txt");
const icacls = join(system32, "icacls.exe");
if (role === "writer") {
  console.log("ACL_STEP legacy directory");
  mkdirSync(shadow);
  execFileSync(join(system32, "icacls.exe"), [shadow, "/grant:r", "*S-1-1-0:(OI)(CI)RX"]);
  ensureShadowDir(shadow);
  console.log("ACL_STEP new file inheritance");
  writeShadowFile(payload, "synthetic backup");
  if (readFileSync(payload, "utf8") !== "synthetic backup") throw new Error("Writer could not read its backup");
  console.log("ACL_STEP legacy file");
  writeFileSync(legacy, "legacy synthetic backup");
  execFileSync(icacls, [legacy, "/grant:r", "*S-1-1-0:R"]);
  tightenShadow(legacy, "file");
  console.log("ACL_STEP replaced directory");
  ensureShadowDir(replaced);
  renameSync(replaced, join(root, "previous"));
  mkdirSync(replaced);
  execFileSync(icacls, [replaced, "/grant:r", "*S-1-1-0:(OI)(CI)RX"]);
  assert.throws(() => writeShadowFile(replacementPayload, "must not be written"), (error) =>
    error.code === "ESHADOWACCESS" && /directory identity changed/.test(error.cause?.message));
  assert.equal(existsSync(replacementPayload), false);
  console.log("ACL_STEP fresh-process directory protection");
  execFileSync(process.execPath, [fileURLToPath(import.meta.url), "restarted-writer", root, expectedSid], { stdio: "inherit" });
  assert.equal(readFileSync(legacy, "utf8"), "legacy synthetic backup");
  assert.equal(readFileSync(replacementPayload, "utf8"), "replacement synthetic backup");
  writeFileSync(join(root, "writer-proof.json"), JSON.stringify({ writerStandard: true, writerRead: true, replacedRefused: true, restartedWriter: true }));
} else if (role === "restarted-writer") {
  writeShadowFile(replacementPayload, "replacement synthetic backup");
} else if (role === "reader") {
  if (readFileSync(join(root, "control.txt"), "utf8").trim() !== "positive control") throw new Error("Control read failed");
  const leaked = [];
  for (const file of [payload, legacy, replacementPayload]) {
    try {
      readFileSync(file);
      leaked.push(file.slice(root.length + 1));
    } catch (error) {
      if (!["EACCES", "EPERM"].includes(error.code)) throw error;
    }
  }
  writeFileSync(join(root, "reader-proof.json"), JSON.stringify({ readerStandard: true, controlRead: true, readerRead: leaked.length > 0, leaked }));
} else {
  throw new Error("Unknown ACL probe role");
}
