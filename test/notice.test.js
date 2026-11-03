import test from "node:test";
import assert from "node:assert/strict";
import { buildNotice } from "../plan.js";

// shadow 目录的真实形态：Windows 盘符绝对路径。
// The real shape of the shadow directory: a Windows drive absolute path.
const SHADOW =
  "C:\\Users\\dev\\AppData\\Local\\dsh\\compaction-spine\\shadow\\turn-0042.txt";
// 提示里禁止出现的字符：$ 反引号 * [ ] 与换行。
// Characters banned from the notice: $, backtick, *, [, ], and line breaks.
const BANNED = /[$`*\[\]\r\n]/;

test("notice: renders the Chinese single-line template", () => {
  const out = buildNotice({ tokens: 12345, shadowPath: SHADOW });
  assert.equal(out, `已切分压缩 12345 tokens（原文：${SHADOW}）`);
  assert.match(out, /^已切分压缩 \d+ tokens（原文：.+）$/);
});

test("notice: keeps the token count in plain decimal", () => {
  const out = buildNotice({ tokens: 12345, shadowPath: SHADOW });
  assert.ok(out.includes("已切分压缩 12345 tokens"), out);
  assert.ok(!out.includes("12,345"), "no thousand separators");
  assert.ok(!/[0-9]e[+-]?[0-9]/i.test(out), "no exponential notation");
  assert.equal(
    buildNotice({ tokens: 1, shadowPath: SHADOW }),
    `已切分压缩 1 tokens（原文：${SHADOW}）`,
  );
  assert.ok(
    buildNotice({ tokens: 9007199254740991, shadowPath: SHADOW }).includes(
      "9007199254740991 tokens",
    ),
  );
});

test("notice: prints the shadow path verbatim", () => {
  const posix = "/var/tmp/compaction-spine/shadow/turn-0042.txt";
  assert.equal(
    buildNotice({ tokens: 7, shadowPath: posix }),
    `已切分压缩 7 tokens（原文：${posix}）`,
  );
  const win = buildNotice({ tokens: 7, shadowPath: SHADOW });
  assert.equal(win.indexOf(SHADOW), "已切分压缩 7 tokens（原文：".length);
});

test("notice: output has no Markdown metacharacters and no line break", () => {
  const outs = [
    buildNotice({ tokens: 12345, shadowPath: SHADOW }),
    buildNotice({ tokens: 1, shadowPath: "/tmp/a.txt" }),
    buildNotice({ tokens: 999999, shadowPath: "D:\\\\deep\\shadow\\x.txt" }),
  ];
  for (const out of outs) {
    assert.ok(!BANNED.test(out), `banned character in: ${out}`);
    assert.equal(out.split("\n").length, 1, "single line");
    assert.equal(out.split("\r").length, 1, "no carriage return");
  }
});

test("notice: rejects invalid token counts with TypeError", () => {
  const invalid = [
    0,
    -1,
    -12345,
    1.5,
    -0.5,
    "123",
    "12345",
    "",
    NaN,
    Infinity,
    -Infinity,
    null,
    undefined,
    true,
    {},
  ];
  for (const tokens of invalid) {
    assert.throws(
      () => buildNotice({ tokens, shadowPath: SHADOW }),
      TypeError,
      `tokens=${String(tokens)}`,
    );
  }
  assert.throws(() => buildNotice(), TypeError);
  assert.throws(() => buildNotice({}), TypeError);
});

test("notice: rejects invalid shadow paths with TypeError", () => {
  const invalid = [
    "",
    "shadow/turn-0042.txt",
    "./turn.txt",
    "turn.txt",
    "../shadow/turn.txt",
    "C:relative.txt",
    "\\\\",
    null,
    undefined,
    42,
  ];
  for (const shadowPath of invalid) {
    assert.throws(
      () => buildNotice({ tokens: 10, shadowPath }),
      TypeError,
      `shadowPath=${String(shadowPath)}`,
    );
  }
});

test("notice: rejects shadow paths that would break the notice contract", () => {
  const invalid = [
    "C:\\tmp\\a$b.txt",
    "C:\\tmp\\a`b.txt",
    "C:\\tmp\\a*b.txt",
    "C:\\tmp\\a[1].txt",
    "C:\\tmp\\a]b.txt",
    "C:\\tmp\\line\nbreak.txt",
    "/tmp/carriage\rreturn.txt",
  ];
  for (const shadowPath of invalid) {
    assert.throws(
      () => buildNotice({ tokens: 10, shadowPath }),
      TypeError,
      JSON.stringify(shadowPath),
    );
  }
});
