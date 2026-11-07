import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureShadowDir, writeShadowFile } from "./shadow.js";

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
if (role === "writer") {
  mkdirSync(shadow);
  execFileSync(join(system32, "icacls.exe"), [shadow, "/grant:r", "*S-1-1-0:(OI)(CI)RX"]);
  ensureShadowDir(shadow);
  writeShadowFile(payload, "synthetic backup");
  if (readFileSync(payload, "utf8") !== "synthetic backup") throw new Error("Writer could not read its backup");
  writeFileSync(join(root, "writer-proof.json"), JSON.stringify({ writerStandard: true, writerRead: true }));
} else if (role === "reader") {
  if (readFileSync(join(root, "control.txt"), "utf8").trim() !== "positive control") throw new Error("Control read failed");
  let readerRead = false;
  try {
    readerRead = readFileSync(payload, "utf8") === "synthetic backup";
  } catch (error) {
    if (!["EACCES", "EPERM"].includes(error.code)) throw error;
  }
  writeFileSync(join(root, "reader-proof.json"), JSON.stringify({ readerStandard: true, controlRead: true, readerRead }));
} else {
  throw new Error("Unknown ACL probe role");
}
