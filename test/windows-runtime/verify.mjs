import assert from 'node:assert/strict';

// Content-only assertions, also exercised by negative contract tests. Their
// tests are never reported as a macOS/Windows runtime pass.
export function verifyStage(stage, rows, { denied = false, expectedSid } = {}) {
  const select = (kind) => rows.filter((row) => row.kind === kind);
  assert.equal(select('observer-ready').length, 1, 'exactly one candidate observer');
  for (const kind of ['network-refused', 'unhandledRejection', 'uncaughtException', 'finishTurn-throw']) {
    assert.equal(select(kind).length, 0, `unexpected ${kind}`);
  }
  if (expectedSid) assert.equal(select('identity')[0]?.sid, expectedSid, 'standard user identity');
  const finish = select('finishTurn-return').at(-1);
  assert.ok(finish?.completed, 'real completed turn reached finishTurn return');
  const sid = finish.sid;
  for (const kind of ['finishTurn-enter', 'maintenance-request', 'maintenance-enter', 'maintenance-leave', 'prune-request', 'prune-return']) {
    assert.ok(select(kind).some((row) => row.sid === sid), `missing real ${kind}`);
  }
  assert.equal(select('finishTurn-enter').length, select('finishTurn-return').length, 'all finishTurn calls settled');
  assert.equal(select('maintenance-enter').length, select('maintenance-leave').length, 'all entered maintenance settled');
  const tools = finish.tools.filter((tool) => tool.callId === `${stage}-long` || tool.callId === `${stage}-after`);
  assert.equal(tools.some((tool) => tool.callId === `${stage}-long` && !tool.isError && tool.text.includes('SYNTHETIC_RUNTIME_BEGIN')), true, 'real long read');
  assert.equal(tools.some((tool) => tool.callId === `${stage}-after` && !tool.isError && tool.text.includes('SYNTHETIC_AFTER_DENIAL_CONTROL')), true, 'real subsequent read');
  const capture = select('capture').filter((row) => row.sid === sid && row.callId?.startsWith(`${stage}-`));
  for (const suffix of ['long', 'after']) assert.ok(capture.some((row) => row.callId === `${stage}-${suffix}` && row.ok === !denied), `backup state ${suffix}`);
  const originals = select('prune-original-return').filter((row) => row.sid === sid);
  if (denied) {
    assert.equal(capture.some((row) => row.ok), false, 'denied backup must never be marked complete');
    assert.equal(originals.length, 0, 'guard must suppress actual prune without verified backups');
    assert.equal(finish.prunes, 0, 'no destructive pruning after denial');
    assert.equal(finish.summaries, 0, 'no cut without verified backups');
  } else {
    assert.ok(originals.some((row) => row.replacements > 0 && row.charsRemoved > 0), 'real upstream pruner changed the surface');
    assert.ok(finish.prunes > 0, 'durable compaction/prune');
  }
  return { stage, status: 'PASS', sid, pid: finish.pid, denied, finishTurn: select('finishTurn-return').length, maintenance: select('maintenance-leave').length, prunes: finish.prunes, summaries: finish.summaries };
}
