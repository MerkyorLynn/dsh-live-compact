import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';

export const here = dirname(fileURLToPath(import.meta.url));
export const repository = resolve(here, '../..');
export const version = process.env.DSH_VERIFY_VERSION ?? '0.2.0-rc.2';
assert.ok(['0.2.0-rc.2', '0.2.1-rc.2'].includes(version), 'pinned DSH verification version');
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
export const save = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');

// Never spread the launching environment: no tokens, proxy, NODE_OPTIONS,
// provider settings, user npmrc, real HOME, or GITHUB_* reach the test runtime.
export function cleanEnv(root) {
  const home = join(root, 'user-home');
  const temp = join(root, 'tmp');
  for (const path of [home, temp, join(home, 'AppData', 'Roaming'), join(home, 'AppData', 'Local')]) mkdirSync(path, { recursive: true });
  for (const name of ['user.npmrc', 'global.npmrc']) writeFileSync(join(root, name), '');
  const systemRoot = process.platform === 'win32' ? process.env.SystemRoot : undefined;
  const systemPath = systemRoot
    ? [systemRoot, join(systemRoot, 'System32'), join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')]
    : ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  return {
    PATH: [join(root, 'runtime', 'node_modules', '.bin'), dirname(process.execPath), ...systemPath].join(process.platform === 'win32' ? ';' : ':'),
    HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
    TMPDIR: temp, TMP: temp, TEMP: temp, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'),
    DSH_HOME: join(root, 'dsh-home'), DSH_TELEMETRY_DISABLED: '1', CI: 'true', NO_COLOR: '1',
    NPM_CONFIG_USERCONFIG: join(root, 'user.npmrc'), NPM_CONFIG_GLOBALCONFIG: join(root, 'global.npmrc'),
    NPM_CONFIG_CACHE: join(root, 'npm-cache'), NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
    NPM_CONFIG_FETCH_RETRIES: '0', NPM_CONFIG_FETCH_TIMEOUT: '20000',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', COREPACK_ENABLE_PROJECT_SPEC: '0',
    ...(systemRoot ? { SystemRoot: systemRoot, WINDIR: systemRoot, ComSpec: join(systemRoot, 'System32', 'cmd.exe'), PATHEXT: '.COM;.EXE;.BAT;.CMD' } : {}),
  };
}

export function npmCli() {
  const candidates = [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
  for (const entry of (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':')) {
    const file = join(entry, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    if (existsSync(file)) candidates.push(process.platform === 'win32' ? join(entry, 'node_modules/npm/bin/npm-cli.js') : realpathSync(file));
  }
  const found = candidates.find((file) => existsSync(file) && file.endsWith('npm-cli.js'));
  assert.ok(found, 'npm CLI must be installed beside Node or on PATH');
  return resolve(found);
}

export async function command(label, args, { root, cwd, env, timeout = 90000 }) {
  console.log(`STAGE ${label}`);
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
  console.log(`PID ${child.pid} ${label}`);
  let stdout = '', stderr = '', failure;
  const stop = () => {
    try {
      if (process.platform === 'win32') execFileSync(join(env.SystemRoot, 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { env, stdio: 'ignore', timeout: 5000, windowsHide: true });
      else process.kill(-child.pid, 'SIGKILL');
    } catch { child.kill('SIGKILL'); }
  };
  const capture = (key, data) => {
    if (key === 'out') stdout += data; else stderr += data;
    if (stdout.length + stderr.length > 4 * 1024 * 1024) { failure = new Error(`${label}: output limit`); stop(); }
  };
  child.stdout.on('data', (data) => capture('out', data));
  child.stderr.on('data', (data) => capture('err', data));
  const timer = setTimeout(() => { failure = new Error(`${label}: timeout after ${timeout}ms`); stop(); }, timeout);
  const heartbeat = setInterval(() => console.log(`RUNNING PID ${child.pid} ${label}; awaiting process exit`), 20000);
  let code;
  try {
    code = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept); });
  } finally { clearTimeout(timer); clearInterval(heartbeat); }
  writeFileSync(join(root, `${label}.stdout.log`), stdout);
  writeFileSync(join(root, `${label}.stderr.log`), stderr);
  save(join(root, `${label}.status.json`), { label, pid: child.pid, code, failure: failure?.message ?? null });
  if (failure) throw failure;
  assert.equal(code, 0, `${label} exited ${code}; inspect its bounded synthetic logs`);
  return stdout;
}

export function verifyCandidate() {
  const pin = json(join(here, 'candidate.json'));
  const tarball = join(here, 'fixtures', pin.filename);
  const bytes = readFileSync(tarball);
  assert.equal(bytes.length, pin.bytes, 'candidate tarball size');
  assert.equal(sha256(bytes), pin.sha256, 'candidate tarball SHA256');
  for (const file of pin.files) {
    const bytes = readFileSync(join(repository, file.path));
    assert.equal(bytes.length, file.bytes, `source size ${file.path}`);
    assert.equal(sha256(bytes), file.sha256, `source SHA256 ${file.path}`);
  }
  return { pin, tarball };
}
