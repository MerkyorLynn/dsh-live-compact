// --import observer for the real dsh bin. No synthetic Agent, token meter,
// compactor, tool executor, or prune implementation is substituted.
import './network-guard.mjs';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { sha256, json } from './common.mjs';

const log = (kind, fields = {}) => appendFileSync(process.env.PROBE_EVENTS, JSON.stringify({ kind, pid: process.pid, ...fields }) + '\n');
process.on('unhandledRejection', (error) => { log('unhandledRejection', { message: String(error) }); process.exitCode = 1; });
process.on('uncaughtExceptionMonitor', (error) => log('uncaughtException', { message: String(error) }));

if (process.platform === 'win32') {
  const whoami = join(process.env.SystemRoot, 'System32', 'whoami.exe');
  const user = execFileSync(whoami, ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' });
  const groups = execFileSync(whoami, ['/groups', '/fo', 'csv', '/nh'], { encoding: 'utf8' });
  const sid = process.env.PROBE_EXPECTED_SID;
  assert.ok(sid && user.includes(`"${sid}"`) && groups.includes('S-1-16-8192') && !groups.includes('S-1-5-32-544'), 'must be the expected medium-integrity non-admin user');
  log('identity', { sid, mediumIntegrity: true, administratorGroup: false });
} else {
  assert.notEqual(process.geteuid(), 0, 'POSIX denial control requires non-root');
  log('identity', { uid: process.geteuid(), nativeWindows: false });
}
if (process.env.PROBE_DENIED === '1') {
  const target = join(process.env.SPINE_SHADOW_DIR, 'must-not-write.txt');
  let denied = false;
  try { writeFileSync(target, 'synthetic denial control', { flag: 'wx' }); }
  catch (error) { assert.ok(['EACCES', 'EPERM'].includes(error.code)); denied = true; log('filesystem-denial', { code: error.code }); }
  if (!denied) { unlinkSync(target); throw new Error('OS denial precondition failed'); }
}

const installed = process.env.PROBE_INSTALLED;
const pin = json(process.env.PROBE_PIN);
for (const file of pin.files) {
  assert.equal(sha256(readFileSync(join(installed, file.path))), file.sha256, `installed candidate ${file.path}`);
}
const load = async (file) => import(pathToFileURL(file).href);
const require = createRequire(join(installed, 'package.json'));
for (const name of ['@deepseek-ai/dsh-compaction', '@deepseek-ai/dsh-compaction-basic', '@deepseek-ai/dsh-llm']) {
  // Resolve identity from the same candidate anchor the product uses.
  const entry = require.resolve(name);
  log('dependency', { name, entry, sha256: sha256(readFileSync(entry)) });
}
const Engine = (await load(join(installed, 'index.js'))).default;
const { ToolResultPruner } = await load(createRequire(process.env.PROBE_DSH_ANCHOR).resolve('@deepseek-ai/dsh-compaction-tool-result-pruner'));
log('observer-ready', { installed, engineSha256: sha256(readFileSync(join(installed, 'index.js'))), shadowSha256: sha256(readFileSync(join(installed, 'shadow.js'))) });

const originalPrune = ToolResultPruner.prototype.pruneSession;
ToolResultPruner.prototype.pruneSession = function (session) {
  log('prune-original-enter', { sid: session.id });
  const value = originalPrune.call(this, session);
  log('prune-original-return', { sid: session.id, replacements: value.pruned.length, charsRemoved: value.charsRemoved });
  return value;
};
const guard = Engine.prototype.ensurePruneGuard;
Engine.prototype.ensurePruneGuard = function (...args) {
  const value = guard.apply(this, args);
  const pruner = this.ctx.get('toolResultPruner');
  if (pruner?.pruneSession?.__spineGuarded && !pruner.pruneSession.__probeObserved) {
    const guarded = pruner.pruneSession;
    function observed(session) {
      log('prune-request', { sid: session.id });
      const result = guarded.call(this, session);
      log('prune-return', { sid: session.id });
      return result;
    }
    observed.__spineGuarded = true;
    observed.__probeObserved = true;
    pruner.pruneSession = observed;
  }
  return value;
};
const capture = Engine.prototype.captureOne;
const observedLoggers = new WeakSet();
const requestedPrunes = new Set();
Engine.prototype.captureOne = function (session, event, ...args) {
  const logger = this.ctx?.logger;
  if (logger && typeof logger.warn === 'function' && !observedLoggers.has(logger)) {
    observedLoggers.add(logger);
    const originalWarn = logger.warn;
    logger.warn = function (message, ...values) {
      if (typeof message === 'string' && message.startsWith('spine: shadow permission failed')) {
        log('shadow-warning', { message });
      }
      return originalWarn.call(this, message, ...values);
    };
  }
  const value = capture.call(this, session, event, ...args);
  const callId = event.data.message.toolCallId;
  log('capture', { sid: session.id, seq: event.seq, callId, ok: value?.ok === true, reason: value?.reason, path: value?.path, sha256: value?.sha256 });
  const pruneKey = `${session.id}:${callId}`;
  if (callId === `${process.env.PROBE_STAGE}-long` && !requestedPrunes.has(pruneKey)) {
    requestedPrunes.add(pruneKey);
    // Use the next real pre-step, when the completed tool result has reached
    // the surface and the turn is still open, like native pressure pruning.
    const dispose = this.ctx.on('agent/pre-step', async ({ agent }, next) => {
      if (agent.session === session) {
        dispose();
        this.ensurePruneGuard();
        const pruner = this.ctx.get('toolResultPruner');
        assert.ok(pruner?.pruneSession?.__spineGuarded, 'expected the production prune guard');
        log('probe-prune-driver', { sid: session.id });
        pruner.pruneSession(session);
      }
      return next();
    });
  }
  return value;
};
const recover = Engine.prototype.recoverVisibleRaw;
Engine.prototype.recoverVisibleRaw = function (session, ...args) {
  const before = new Set(this.surfaceToolIds(session).filter((id) => this.rawSeen.get(this.rawKey(session, id))?.ok));
  const value = recover.call(this, session, ...args);
  const verified = this.surfaceToolIds(session).filter((id) => this.rawSeen.get(this.rawKey(session, id))?.ok);
  log('raw-recovery', { sid: session.id, recovered: verified.filter((id) => !before.has(id)) });
  return value;
};
const watched = new WeakSet();
const finish = Engine.prototype.finishTurn;
Engine.prototype.finishTurn = async function (agent, ...args) {
  const sid = agent.session.id;
  if (!watched.has(agent)) {
    watched.add(agent);
    const maintenance = agent.runMaintenance;
    agent.runMaintenance = function (fn, ...rest) {
      log('maintenance-request', { sid });
      return maintenance.call(this, async (...inputs) => {
        log('maintenance-enter', { sid });
        try { return await fn(...inputs); }
        finally { log('maintenance-leave', { sid }); }
      }, ...rest);
    };
  }
  log('finishTurn-enter', { sid });
  try {
    const value = await finish.call(this, agent, ...args);
    const events = agent.session.snapshotEvents();
    log('finishTurn-return', {
      sid, completed: events.some((event) => event.type === 'turn/end' && event.data.reason.kind === 'completed'),
      prunes: events.filter((event) => event.type === 'compaction/prune').length,
      summaries: events.filter((event) => event.type === 'compaction/summary').length,
      tools: events.filter((event) => event.type === 'tool/result').map((event) => ({ seq: event.seq, callId: event.data.message.toolCallId, isError: event.data.message.isError, text: event.data.message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n') })),
    });
    return value;
  } catch (error) { log('finishTurn-throw', { sid, message: String(error) }); throw error; }
};
