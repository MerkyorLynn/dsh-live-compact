"""Known synthetic evidence only. Imported by offline tests and fake_dsh.py."""
import json
from pathlib import Path
from contract import FILL, NOTICE, MANIFEST, validate_contract, write_json, sha
from mkfx import build_log, write_workspace
from run import init_attempt, snapshot

RECALL = '''# recall.md
cache: SQLite
port: 9310
ratelimit: 37/min
threshold: 0.875
test: tests/test_ledger.py
reviewer: Okafor
name: Bluebird
currency: USD two decimal places
region: eu-west-3
oncall: @mirela
ticket: LED-4471
budget: $412/month
code: E1729
shard: 0x3F
'''
HIDDEN = '''# hidden.md
shard: 9f2c71ab
ratelimit: 37/min
threshold: 0.875
batch: 250
region: eu-west-3
ticket: LED-4471
source: memory of earlier logs and the turn 13 update
'''
STATUS = '''# LED-4471 Bluebird status
oncall: @mirela
validation: still failing
code: E1729
shard: 0x3F
test: tests/test_ledger.py
reviewer: Okafor
port: 9310
'''
CHECK = 'E1729 shard 0x3F (expected 9f2c71ab, got 9f2c71ae)'


def spec(root, arm='candidate', family='ds'):
    return dict(arm=arm, model_family=family, model='synthetic-only', route='offline-fake',
                host='synthetic-rc.2', dependencies={'dsh':'0.2.0-rc.2'},
                parameters={'temperature':0, 'window':1000000, 'tools':'read,bash,write'},
                cache_warmup='none; first group cold; no prewarm requests',
                usage_semantics='disjoint-input-read-write', package_sha256='0'*64,
                dsh_home=str(root.parent / (family+'-'+arm+'-home')), profile=family+'-'+arm+'-synthetic',
                shadow_dir=str(root.parent / (family+'-'+arm+'-shadow')))


def usage(second=False):
    data = dict(inputTokens=40 if second else 10, cacheReadTokens=960 if second else 990,
                cacheWriteTokens=3 if second else 2, outputTokens=8)
    data['totalTokens'] = sum(data.values())
    return data


def events(turn, cwd, sid):
    result = [dict(type='session', sessionId=sid, cwd=str(cwd)),
              dict(type='status', phase='turn_start', turn=turn),
              dict(type='status', phase='step_start', turn=turn, step=1)]
    final = '收到'
    if turn in FILL:
        text, count = build_log(turn)
        path = cwd / f'part{turn}.log'
        result += [dict(type='tool_call', callId=f'c{turn}', tool='read', input={'file_path':'./'+path.name}),
                   dict(type='tool_result', callId=f'c{turn}', status='completed',
                        result=f'<path>{path}</path>\n<type>file</type>\n<content>\n1: {text.splitlines()[0]}\n</content>')]
        final = f'WARN: {count}\n' + (NOTICE.get(turn) or 'NONE')
    if turn == 1:
        result += [dict(type='tool_call', callId='check', tool='bash', input={'command':'./check.sh'}),
                   dict(type='tool_result', callId='check', status='completed', result='[stderr]\n'+CHECK+'\n[exit code: 3]')]
        final = CHECK
    if turn == 28:
        final = RECALL
    result.append(dict(type='status', phase='step_end', turn=turn, step=1, usage=usage()))
    if turn in FILL:
        result += [dict(type='status', phase='step_start', turn=turn, step=2),
                   dict(type='status', phase='step_end', turn=turn, step=2, usage=usage(True))]
    result += [dict(type='status', phase='turn_end', turn=turn, reason={'kind':'completed'}),
               dict(type='final', text=final)]
    return result


def artifacts(turn, cwd):
    if turn == 29:
        (cwd / 'hidden.md').write_text(HIDDEN)
    if turn == 30:
        values = MANIFEST['rubric']['config']
        (cwd / 'conf/settings.local.toml').write_text('\n'.join(k+' = '+json.dumps(v) for k,v in values.items())+'\n')
        (cwd / 'docs/NOTES.md').write_text('# LED-4471 Bluebird\nReviewer: Okafor\n')
    if turn == 31:
        (cwd / 'docs/STATUS.md').write_text(STATUS)


def write_events(path, items):
    path.write_text(''.join(json.dumps(x, ensure_ascii=False)+'\n' for x in items))


def cell(root, arm='candidate', family='ds'):
    init_attempt(root, spec(root, arm, family))
    for rid in range(1, 11):
        cwd = root / 'work' / f'spine-{rid}'
        group = root / 'runs' / f'spine-{rid}'
        group.mkdir()
        write_json(group / 'initial.json', write_workspace(cwd))
        sid = f'synthetic-{arm}-{rid}'
        offset = 0 if (rid % 2 == 1) == (arm == 'candidate') else 100
        for turn in range(1, 32):
            artifacts(turn, cwd)
            prefix = group / f't{turn}'
            write_events(prefix.with_suffix('.jsonl'), events(turn, cwd, sid))
            prefix.with_suffix('.stderr').write_text('')
            meta = dict(turn=turn, requested_session=sid if turn>1 else None,
                        observed_session=sid, started=rid*1000+offset+turn*2,
                        ended=rid*1000+offset+turn*2+1, exit_code=0,
                        termination='exited', cleanup='complete',
                        stdout_sha256=sha(prefix.with_suffix('.jsonl').read_bytes()),
                        stderr_sha256=sha(b''))
            write_json(prefix.with_suffix('.process.json'), meta)
            write_json(prefix.with_suffix('.snapshot.json'), snapshot(cwd))
            meta['snapshot_sha256'] = sha(prefix.with_suffix('.snapshot.json').read_bytes())
            write_json(prefix.with_suffix('.meta.json'), meta)
