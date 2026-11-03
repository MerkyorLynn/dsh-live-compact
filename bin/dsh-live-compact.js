#!/usr/bin/env node
/**
 * 版本查询小工具：`dsh-live-compact --version`。
 * Version probe: `dsh-live-compact --version`.
 *
 * 只读自身的 package.json，不 import 插件主体，因此没有宿主依赖也能跑。
 * Reads its own package.json only; no host imports, so it runs without DSH installed.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../package.json"),
    "utf8",
  ),
);
const arg = process.argv[2];
if (arg === "--version" || arg === "-v") {
  console.log(pkg.version);
  process.exit(0);
}
console.log(`${pkg.name} ${pkg.version}`);
console.log(
  "dsh plugin --profile web add https://download.merkyorlynn.com/downloads/plugins/dsh-live-compact-1.0.1.tgz",
);
