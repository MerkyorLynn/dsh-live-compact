import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { cleanEnv, command, here, json, npmCli, repository, save, sha256, verifyCandidate, version } from './common.mjs';
import { overlay, replayEntries, writeInputs } from './scenario.mjs';
import { verifyStage } from './verify.mjs';

const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--root'), 'usage: node test/windows-runtime/run.mjs [--root NEW_EMPTY_DIRECTORY]');
const root = args.length ? resolve(args[1]) : mkdtempSync(join(realpathSync(tmpdir()), 'dsh112-runtime-'));
assert.ok(['darwin', 'win32'].includes(process.platform), 'only native macOS and Windows are supported');
if (process.platform === 'darwin') assert.notEqual(process.geteuid(), 0, 'run the macOS probe as a non-root user');
mkdirSync(root, { recursive: true });
const preinstalled = process.platform === 'win32' && existsSync(join(root, 'expected-sid.txt')) &&
  existsSync(join(root, 'runtime', 'package-lock.json'));
const setupFiles = ['denied-shadow', 'expected-sid.txt', ...(preinstalled ? ['runtime'] : [])];
assert.equal(readdirSync(root).filter((file) => !setupFiles.includes(file)).length, 0, 'refuse to reuse a runtime root');
const env = cleanEnv(root);
const workspace = join(root, 'workspace');
const runtime = join(root, 'runtime');
mkdirSync(workspace);
if (!preinstalled) mkdirSync(runtime);
writeInputs(workspace);
const results = { platform: process.platform, arch: process.arch, node: process.version, root, windowsAcceptance: 'NOT_RUN', desktopAcceptance: 'NOT_RUN', stages: Object.fromEntries(['candidate', 'install', 'plugin-install', 'fixture', 'before', 'denied', 'new-session', 'restart'].map((name) => [name, { status: 'NOT_RUN' }])) };
console.log(`EVIDENCE_ROOT ${root}`);
let current = 'candidate';
try {
  const { pin, tarball } = verifyCandidate();
  results.candidate = pin;
  results.stages.candidate = { status: 'PASS', tarballSha256: pin.sha256 };
  current = 'install';
  if (!preinstalled) {
    const npm = npmCli();
    save(join(runtime, 'package.json'), { name: 'disposable-dsh112-runtime', private: true, type: 'module' });
    await command('install', [npm, 'install', '--ignore-scripts', '--save-exact', '--no-audit', '--no-fund',
      `@deepseek-ai/dsh@${version}`, `@deepseek-ai/dsh-llm-replay@${version}`, 'pnpm@11.7.0'],
    { root, cwd: runtime, env, timeout: 240000 });
  }
  const dshAnchor = join(runtime, 'node_modules/@deepseek-ai/dsh/package.json');
  const dsh = join(dirname(dshAnchor), json(dshAnchor).bin.dsh);
  assert.equal(json(dshAnchor).version, version);
  assert.equal(json(join(runtime, 'node_modules/pnpm/package.json')).version, '11.7.0');
  const cliVersion = await command('cli-version', [dsh, '--version'], { root, cwd: workspace, env });
  assert.ok(cliVersion.includes(version), 'actual CLI version');
  results.stages.install = { status: 'PASS', version, entrySha256: sha256(readFileSync(dsh)), lockSha256: sha256(readFileSync(join(runtime, 'package-lock.json'))) };
  current = 'plugin-install';
  await command('plugin-install', [dsh, 'plugin', '--profile', 'headless', 'add', '--ignore-scripts', '--save-exact', tarball],
    { root, cwd: workspace, env, timeout: 240000 });
  const profile = join(env.DSH_HOME, 'profiles/headless');
  const installed = realpathSync(join(profile, 'node_modules/dsh-live-compact'));
  for (const file of pin.files) assert.equal(sha256(readFileSync(join(installed, file.path))), file.sha256, `normal-path installed ${file.path}`);
  const manifest = json(join(profile, 'package.json'));
  assert.ok(manifest.dsh.profile.bundles.includes('dsh-live-compact'), 'normal CLI must select the candidate bundle');
  // The external preloader imports the candidate before the CLI is booted.
  // Resolve its peer scope to the exact official runtime, rather than installing
  // separate copies of core packages with incomplete peer dependency graphs.
  const scopedPeers = join(profile, 'node_modules/@deepseek-ai');
  assert.equal(existsSync(scopedPeers), false, 'probe requires a clean profile peer scope');
  symlinkSync(join(runtime, 'node_modules/@deepseek-ai'), scopedPeers, process.platform === 'win32' ? 'junction' : 'dir');
  const require = createRequire(join(installed, 'package.json'));
  const replayAnchor = createRequire(dshAnchor).resolve('@deepseek-ai/dsh-llm-replay/package.json');
  assert.equal(json(replayAnchor).version, version);
  for (const name of ['dsh-compaction', 'dsh-compaction-basic', 'dsh-llm']) {
    assert.equal(json(require.resolve(`@deepseek-ai/${name}/package.json`)).version, version, `pinned candidate peer ${name}`);
  }
  results.stages['plugin-install'] = { status: 'PASS', installed, replayVersion: version, replaySha256: sha256(readFileSync(join(dirname(replayAnchor), 'lib/index.js'))) };
  current = 'fixture';
  // Generate only an empty canonical Session header with the official encoder.
  // Official ReplayEntry[] sidecars provide the three synthetic model streams.
  // No live-provider recording or hand-written Session event grammar is needed.
  const fixture = join(root, 'session.v4.jsonl');
  const replay = join(dirname(replayAnchor), 'lib/index.js');
  const fixtureNetwork = join(root, 'fixture.network.jsonl');
  writeFileSync(fixtureNetwork, '');
  const fixtureResult = JSON.parse(await command('fixture', [join(here, 'fixture.mjs'), dshAnchor, replayAnchor, replay, workspace, fixture], { root, cwd: workspace, env: { ...env, PROBE_EVENTS: fixtureNetwork } }));
  assert.equal(readFileSync(fixtureNetwork, 'utf8'), '', 'fixture library imports must not attempt network I/O');
  assert.equal(fixtureResult.format, 4);
  results.stages.fixture = { status: 'PASS', ...fixtureResult };
  const sidFile = join(root, 'expected-sid.txt');
  const expectedSid = existsSync(sidFile) ? readFileSync(sidFile, 'utf8').trim() : undefined;
  if (process.platform === 'win32') assert.ok(expectedSid, 'Windows must use the disposable standard-user coordinator');
  const deniedShadow = join(root, 'denied-shadow');
  if (process.platform === 'darwin') {
    mkdirSync(deniedShadow);
    execFileSync('/usr/bin/chflags', ['uchg', deniedShadow], { env });
  }
  const healthyShadow = join(root, 'healthy-shadow');
  let recoverySid;
  for (const stage of ['before', 'denied', 'new-session', 'restart']) {
    current = stage;
    const denied = stage === 'denied';
    const script = join(root, `${stage}.replay.json`);
    const patch = join(root, `${stage}.patch.yml`);
    const events = join(root, `${stage}.events.jsonl`);
    save(script, replayEntries(stage));
    writeFileSync(patch, overlay(replay, fixture, script));
    writeFileSync(events, '');
    const shadow = denied ? deniedShadow : healthyShadow;
    const stageEnv = { ...env, SPINE_SHADOW_DIR: shadow, PROBE_STAGE: stage, PROBE_DENIED: denied ? '1' : '0', PROBE_EVENTS: events, PROBE_INSTALLED: installed, PROBE_PIN: join(here, 'candidate.json'), PROBE_DSH_ANCHOR: dshAnchor, ...(expectedSid ? { PROBE_EXPECTED_SID: expectedSid } : {}) };
    const resume = stage === 'restart' ? ['--session-id', recoverySid] : [];
    const output = await command(stage, ['--import', pathToFileURL(join(here, 'observe.mjs')).href, dsh, '--profile', 'headless', '--patch', patch, '--json', ...resume, `Synthetic runtime verification ${stage}`], { root, cwd: workspace, env: stageEnv });
    const rows = readFileSync(events, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const projected = output.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(projected.at(-1)?.type, 'final', 'headless final event');
    assert.ok(JSON.stringify(projected.at(-1)).includes(`SYNTHETIC_FINAL_${stage}`), 'all three replay streams consumed');
    let result;
    try {
      result = verifyStage(stage, rows, { denied, expectedSid });
    } catch (error) {
      const captures = rows.filter((row) => row.kind === 'capture').slice(0, 12).map((row) => ({
        callId: row.callId === `${stage}-long` ? 'long' : row.callId === `${stage}-after` ? 'after' : 'other',
        ok: row.ok,
        reason: typeof row.reason === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(row.reason) ? row.reason : null,
      }));
      const warnings = rows.filter((row) => row.kind === 'shadow-warning').slice(0, 6).map((row) =>
        row.message.match(/ESHADOWACCESS (?:dir|file) exit [0-9]+/)?.[0] ?? 'other shadow warning');
      console.error(JSON.stringify({ stage, captures, warnings }));
      throw error;
    }
    assert.equal(projected.filter((event) => event.type === 'tool_call').length, 2, 'real CLI tool-call projection');
    assert.ok(projected.filter((event) => event.type === 'tool_result').length >= 2, 'real CLI tool-result projection (may include prune replacements)');
    if (denied) {
      assert.ok(rows.some((row) => row.kind === 'filesystem-denial' && ['EACCES', 'EPERM'].includes(row.code)), 'real OS write denial');
      const warnings = rows.filter((row) => row.kind === 'shadow-warning').map((row) => row.message);
      assert.equal(warnings.length, 1, 'product reports the permission failure once');
      const [warning] = warnings;
      if (process.platform === 'win32') assert.match(warning, /spine: shadow permission failed ESHADOWACCESS dir exit 1/, 'real native directory ACL helper denied after healthy baseline');
      assert.deepEqual(readdirSync(deniedShadow), [], 'no denied plaintext or cursor artifacts');
    } else {
      for (const raw of rows.filter((row) => row.kind === 'capture' && row.ok && row.callId?.startsWith(`${stage}-`))) {
        assert.equal(sha256(readFileSync(raw.path)), raw.sha256, 'backup independently read back');
      }
    }
    if (stage === 'new-session') {
      recoverySid = result.sid;
      assert.notEqual(result.sid, results.stages.denied.sid, 'fresh session after failure');
    }
    if (stage === 'restart') {
      assert.equal(result.sid, recoverySid, 'actual persisted-session adoption');
      assert.notEqual(result.pid, results.stages['new-session'].pid, 'new CLI process');
      assert.ok(rows.some((row) => row.kind === 'raw-recovery' && row.recovered.some((id) => id.startsWith('new-session-'))), 'prior-session originals recovered after restart');
    }
    results.stages[stage] = result;
    console.log(`PASS ${stage} sid=${result.sid} finishTurn=${result.finishTurn} maintenance=${result.maintenance} prunes=${result.prunes}`);
  }
  if (process.platform === 'win32') {
    current = 'native-rotation';
    const scope = join(repository, 'node_modules');
    mkdirSync(scope);
    symlinkSync(join(runtime, 'node_modules/@deepseek-ai'), join(scope, '@deepseek-ai'), 'junction');
    const tap = await command(current, ['--test', '--test-reporter=tap', '--test-name-pattern=^two OS processes with late raw writer',
      join(repository, 'test/issue-27.mjs')], { root, cwd: workspace, env, timeout: 90000 });
    const checks = tap.split(/\r?\n/).filter((line) => /^ok \d+ - two OS processes with late raw writer.*finishes at 440/.test(line));
    assert.equal(checks.length, 2, 'real independent processes on the explicit root and its alias must finish at 440 bytes');
    results.stages[current] = { status: 'PASS', checks: checks.length, finalBytes: 440 };
    console.log(`PASS ${current} ${checks.length} independent-process checks at 440 bytes`);
    results.windowsAcceptance = 'PASS';
  }
  results.status = 'PASS';
} catch (error) {
  results.status = 'FAIL';
  results.stages[current] = { status: 'FAIL', message: error.message };
  console.error(`FAIL ${current}: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (process.platform === 'darwin' && existsSync(join(root, 'denied-shadow'))) execFileSync('/usr/bin/chflags', ['nouchg', join(root, 'denied-shadow')], { env });
  save(join(root, 'result.json'), results);
  console.log(JSON.stringify({ status: results.status, platform: results.platform, arch: results.arch, stages: results.stages }));
}
