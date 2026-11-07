import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import { cleanEnv, here, repository, sha256, verifyCandidate } from './common.mjs';
import { replayEntries } from './scenario.mjs';
import { verifyStage } from './verify.mjs';

test('frozen npm tarball contains exactly the pinned source bytes', () => {
  const { pin, tarball } = verifyCandidate();
  const tar = gunzipSync(readFileSync(tarball), { maxOutputLength: 1024 * 1024 });
  const found = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (from, to) => header.subarray(from, to).toString('utf8').replace(/\0.*$/s, '');
    const name = text(0, 100);
    const size = parseInt(text(124, 136).trim(), 8);
    assert.ok(Number.isSafeInteger(size));
    assert.ok(name.startsWith('package/') && !name.includes('..'));
    assert.ok(['0', ''].includes(text(156, 157)), 'no symlinks or special tar members');
    assert.equal(found.has(name.slice(8)), false, 'no duplicate tar members');
    found.set(name.slice(8), { bytes: size, sha256: sha256(tar.subarray(offset + 512, offset + 512 + size)) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.equal(found.size, pin.files.length);
  for (const { path, bytes, sha256 } of pin.files) assert.deepEqual(found.get(path), { bytes, sha256 }, path);
});

test('runtime environment is allowlisted with fresh HOME and empty npm configs', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh112-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = cleanEnv(root);
  for (const key of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'NODE_OPTIONS', 'NODE_PATH', 'HTTP_PROXY', 'HTTPS_PROXY', 'DSH_PROFILE', 'SPINE_ENGINE_FAIL']) assert.equal(env[key], undefined);
  assert.equal(env.HOME, join(root, 'user-home'));
  assert.equal(env.DSH_HOME, join(root, 'dsh-home'));
  assert.equal(env.DSH_TELEMETRY_DISABLED, '1');
  assert.notEqual(env.NPM_CONFIG_USERCONFIG, env.NPM_CONFIG_GLOBALCONFIG);
  assert.equal(readFileSync(env.NPM_CONFIG_USERCONFIG, 'utf8'), '');
  assert.equal(readFileSync(env.NPM_CONFIG_GLOBALCONFIG, 'utf8'), '');
});

test('only an opt-in push on one validation branch can schedule native Windows jobs', () => {
  const workflow = readFileSync(join(repository, '.github/workflows/windows-112-runtime.yml'), 'utf8');
  assert.match(workflow, /push:\s+branches: \[validation\/112-windows-runtime\]/);
  assert.match(workflow, /github.ref == 'refs\/heads\/validation\/112-windows-runtime' && contains\(github.event.head_commit.message, '\[windows-runtime\]'\)/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /runner: windows-11-arm/);
  assert.match(workflow, /runner: windows-2022/);
  assert.doesNotMatch(workflow, /\b(pull_request|schedule|secrets|id-token|write-all):/);
});

test('replay requests only two synthetic reads and a final marker', () => {
  const script = replayEntries('contract');
  assert.equal(script.length, 3);
  assert.deepEqual(script.slice(0, 2).map((entry) => entry.chunks[1].block.name), ['read', 'read']);
  assert.deepEqual(script.slice(0, 2).map((entry) => JSON.parse(entry.chunks[1].block.arguments).file_path), ['synthetic.log', 'control.txt']);
  assert.deepEqual(script.map((entry) => entry.chunks.at(-1).reason.kind), ['tool-calls', 'tool-calls', 'stop']);
});

// These rows test the evidence validator, not DSH or a Windows kernel.
function evidence(denied) {
  const stage = 'contract', sid = 'synthetic-contract';
  const row = (kind, extra = {}) => ({ kind, sid, pid: 100, ...extra });
  return [row('observer-ready'), row('finishTurn-enter'), row('maintenance-request'), row('maintenance-enter'),
    row('prune-request'), row('prune-return'),
    ...['long', 'after'].map((suffix) => row('capture', { callId: `${stage}-${suffix}`, ok: !denied })),
    ...denied ? [] : [row('prune-original-return', { replacements: 1, charsRemoved: 1000 })],
    row('maintenance-leave'), row('finishTurn-return', { completed: true, prunes: denied ? 0 : 1, summaries: 0,
      tools: [
        { callId: `${stage}-long`, isError: false, text: 'SYNTHETIC_RUNTIME_BEGIN' },
        { callId: `${stage}-after`, isError: false, text: 'SYNTHETIC_AFTER_DENIAL_CONTROL' },
      ] }),
  ];
}

for (const missing of ['finishTurn-return', 'maintenance-enter', 'maintenance-leave', 'prune-request']) {
  test(`validator refuses a zero-exit-shaped record missing ${missing}`, () => {
    assert.throws(() => verifyStage('contract', evidence(false).filter((row) => row.kind !== missing)));
  });
}
test('validator refuses absent tool output and an unhandled runtime error', () => {
  const rows = evidence(false);
  rows.at(-1).tools.pop();
  assert.throws(() => verifyStage('contract', rows), /subsequent read/);
  assert.throws(() => verifyStage('contract', [...evidence(false), { kind: 'unhandledRejection' }]), /unhandledRejection/);
});
test('validator refuses destructive prune or a false backup claim after denial', () => {
  assert.throws(() => verifyStage('contract', [...evidence(true), { kind: 'prune-original-return', sid: 'synthetic-contract' }], { denied: true }), /suppress actual prune/);
  const rows = evidence(true);
  rows.find((row) => row.kind === 'capture').ok = true;
  assert.throws(() => verifyStage('contract', rows, { denied: true }), /backup state/);
});
test('macOS immutable synthetic directory denies real writes and chmod (OS control only)', { skip: process.platform !== 'darwin' }, (t) => {
  assert.notEqual(process.geteuid(), 0);
  const root = mkdtempSync(join(tmpdir(), 'dsh112-denial-'));
  const denied = join(root, 'denied');
  mkdirSync(denied);
  t.after(() => { execFileSync('/usr/bin/chflags', ['nouchg', denied]); rmSync(root, { recursive: true, force: true }); });
  execFileSync('/usr/bin/chflags', ['uchg', denied]);
  assert.throws(() => writeFileSync(join(denied, 'test.txt'), 'synthetic'), { code: 'EPERM' });
  assert.throws(() => chmodSync(denied, 0o700), { code: 'EPERM' });
});
