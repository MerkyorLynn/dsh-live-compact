#!/usr/bin/env python3
"""Explicit live runner. Offline tests use a local fake executable, never DSH."""
import argparse
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from contract import (GROUPS, ROUNDS, MANIFEST, HERE, fingerprints, read_json, sha,
                      validate_contract, write_json)
from mkfx import write_workspace
from rubric import behavior
from score import MAX_LOG_BYTES, TRANSPORT, parse_turn, score_cell

TEXT_PATHS = ('hidden.md', 'docs/STATUS.md', 'docs/NOTES.md', 'conf/settings.local.toml')


def snapshot(cwd):
    files, texts, headers = {}, {}, {}
    total = 0
    for path in cwd.rglob('*'):
        if path.is_symlink():
            raise ValueError('workspace symlink prevents bounded snapshot')
        if not path.is_file():
            continue
        if len(files) >= 256 or path.stat().st_size > 1024 * 1024:
            raise ValueError('workspace snapshot bound exceeded')
        data = path.read_bytes()
        total += len(data)
        if total > 8 * 1024 * 1024:
            raise ValueError('workspace snapshot byte bound exceeded')
        name = str(path.relative_to(cwd))
        files[name] = sha(data)
        if name in TEXT_PATHS:
            texts[name] = data.decode('utf-8')
        if name.endswith('.py'):
            headers[name] = data.decode('utf-8').splitlines()[0] if data else ''
    return {'files': files, 'texts': texts, 'python_headers': headers}


def validate_spec(spec):
    required = {'arm', 'model_family', 'model', 'route', 'host', 'dependencies', 'parameters',
                'cache_warmup', 'usage_semantics', 'package_sha256', 'dsh_home', 'profile', 'shadow_dir'}
    if set(spec) != required or spec['arm'] not in ('candidate', 'stock') or spec['model_family'] not in ('ds', 'glm'):
        raise ValueError('spec must use the documented exact keys, arm and model family')
    if any(not isinstance(spec[k], str) or not spec[k].strip() for k in required - {'dependencies', 'parameters'}):
        raise ValueError('blank spec identity')
    if not isinstance(spec['dependencies'], dict) or not spec['dependencies'] or not isinstance(spec['parameters'], dict):
        raise ValueError('record dependency versions and all sampling/window/tool parameters')
    if len(spec['package_sha256']) != 64 or any(c not in '0123456789abcdef' for c in spec['package_sha256']):
        raise ValueError('package SHA256 required')
    if spec['usage_semantics'] != 'disjoint-input-read-write':
        raise ValueError('unverified usage semantics')
    for key in ('dsh_home', 'shadow_dir'):
        if not Path(spec[key]).is_absolute():
            raise ValueError(key + ' must be an absolute isolated path')
    return spec


def init_attempt(root, spec, registration=None):
    validate_spec(spec)
    frozen = fingerprints()
    binding = None
    if registration is not None:
        from semantic import check_registration
        binding = {'path': str(Path(registration).resolve()),
                   'sha256': check_registration(registration, root, spec)}
    elif spec['model'] != 'synthetic-only' or spec['route'] != 'offline-fake':
        raise ValueError('live collection requires semantic preregistration before initialization')
    root.mkdir(parents=True, exist_ok=False)
    write_json(root / 'attempt.json', {'version': MANIFEST['version'], 'fingerprints': frozen,
                                     'spec': spec, 'created': time.time(),
                                     'semantic_registration': binding,
                                     'groups': GROUPS, 'rounds': ROUNDS,
                                     'fill_per_cell': MANIFEST['fill_per_cell'],
                                     'python': sys.version, 'execution': 'serial within group; no automatic retry'})
    (root / 'runs').mkdir()
    (root / 'work').mkdir()


def cleanup_group(proc):
    """Only the process group created by this invocation is ever signalled."""
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(proc.pid, sig)
        except ProcessLookupError:
            pass
        if sig == signal.SIGTERM:
            try:
                proc.wait(timeout=0.3)
            except subprocess.TimeoutExpired:
                pass
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        return 'failed'
    return 'complete'


def process_turn(command, cwd, env, prefix, turn, sid, timeout):
    """Exclusive logs, bounded wait and output, task-owned child group cleanup."""
    if os.name != 'posix':
        raise ValueError('runner requires POSIX process-group cleanup; no untested Windows fallback')
    started = time.time()
    meta = {'turn': turn, 'requested_session': sid, 'started': started, 'ended': None,
            'pid': None, 'process_group': None, 'exit_code': None, 'termination': 'spawn_error',
            'cleanup': 'not_started',
            'transport_retries': None, 'request_finish_reason': None,
            'retry_visibility': 'rc.2 JSON aggregates retry usage; no retry events',
            'timeout_seconds': timeout}
    proc = None
    try:
        with prefix.with_suffix('.jsonl').open('xb') as out, prefix.with_suffix('.stderr').open('xb') as err:
            proc = subprocess.Popen(command, cwd=cwd, env=env, stdout=out, stderr=err,
                                    start_new_session=True)
            meta['pid'] = meta['process_group'] = proc.pid
            deadline = time.monotonic() + timeout
            heartbeat = time.monotonic() + 30
            meta['termination'] = 'exited'
            while proc.poll() is None:
                if time.monotonic() >= deadline:
                    meta['termination'] = 'timeout'
                    break
                if max(os.fstat(out.fileno()).st_size, os.fstat(err.fileno()).st_size) > MAX_LOG_BYTES:
                    meta['termination'] = 'log_limit'
                    break
                if time.monotonic() >= heartbeat:
                    print(f'turn {turn}: PID {proc.pid} still running; awaiting DSH exit/final', flush=True)
                    heartbeat = time.monotonic() + 30
                try:
                    proc.wait(timeout=min(0.1, max(0.001, deadline - time.monotonic())))
                except subprocess.TimeoutExpired:
                    pass
    except OSError:
        meta['termination'] = 'spawn_error'
    except BaseException:
        meta['termination'] = 'interrupted'
        raise
    finally:
        if proc is not None:
            meta['cleanup'] = cleanup_group(proc)
            meta['exit_code'] = proc.returncode
        meta['ended'] = time.time()
        for key, suffix in (('stdout', '.jsonl'), ('stderr', '.stderr')):
            file = prefix.with_suffix(suffix)
            if file.exists():
                meta[key + '_bytes'] = file.stat().st_size
                meta[key + '_sha256'] = sha(file.read_bytes()) if file.stat().st_size <= MAX_LOG_BYTES else None
        write_json(prefix.with_suffix('.process.json'), meta)
    return meta


def run_group(root, rid, executable='dsh', timeout=None):
    if rid not in range(1, GROUPS + 1):
        raise ValueError('group outside frozen manifest')
    run = read_json(root / 'attempt.json')
    if run['fingerprints'] != fingerprints():
        raise ValueError('stale attempt: code/input hashes changed')
    if (root / 'FAILED.json').exists() or (root / 'result.json').exists():
        raise ValueError('finished/failed attempt is immutable; start a new root')
    spec = validate_spec(run['spec'])
    registration = run.get('semantic_registration')
    if registration:
        from semantic import check_registration
        check_registration(registration['path'], root, spec, run)
    else:
        # The old offline CLI remains useful, but cannot launch a model by
        # labeling a real invocation synthetic. Missing absolute executables
        # still exercise the runner's spawn-error preservation path.
        target = Path(executable)
        offline = (spec['model'] == 'synthetic-only' and spec['route'] == 'offline-fake' and
                   (target.resolve() == HERE / 'fake_dsh.py' or (target.is_absolute() and not target.exists())))
        if not offline:
            raise ValueError('unregistered attempt may execute only the local offline fake')
    if registration:
        from semantic import policy_at
        if policy_at(registration['path'])[0]['mode'] == 'synthetic' and Path(executable).resolve() != HERE / 'fake_dsh.py':
            raise ValueError('synthetic registration cannot launch a model')
    group = root / 'runs' / f'spine-{rid}'
    group.mkdir(exist_ok=False)
    cwd = root / 'work' / f'spine-{rid}'
    initial = write_workspace(cwd)
    write_json(group / 'initial.json', initial)
    env = os.environ.copy()
    # Scorer/manifest paths are never exported into the model's environment.
    for key in ('LIVE_ROOT', 'LIVE_SPEC', 'SPINE_COUNT', 'LIVE_TRUTH'):
        env.pop(key, None)
    env['DSH_HOME'] = spec['dsh_home']
    env['SPINE_SHADOW_DIR'] = str(Path(spec['shadow_dir']) / f'spine-{rid}')
    if spec['arm'] == 'stock':
        for key in list(env):
            if key.startswith('SPINE_'):
                env.pop(key)
    prompts = validate_contract()
    sid = None
    errors, quality, hard_quality, fill_machine = [], [], [], []
    for item in prompts:
        turn = item['turn']
        prefix = group / f't{turn}'
        command = [executable, '--profile', spec['profile'], '--json']
        if sid:
            command += ['--session-id', sid]
        command.append(item['prompt'])
        print(f'group {rid}, turn {turn}: starting; bounded timeout {timeout or MANIFEST["timeout_seconds"]}s', flush=True)
        meta = process_turn(command, cwd, env, prefix, turn, sid,
                            timeout if timeout is not None else MANIFEST['timeout_seconds'])
        try:
            snap = snapshot(cwd)
            write_json(prefix.with_suffix('.snapshot.json'), snap)
            meta['snapshot_sha256'] = sha(prefix.with_suffix('.snapshot.json').read_bytes())
            result = parse_turn(prefix.with_suffix('.jsonl'), turn, cwd, sid)
            meta['observed_session'] = result['session_id']
            meta['turn_end_reason'] = result['reason']
            meta['usage_steps'] = result['usage']
            meta['tool_call_count'] = len(result['calls'])
            meta['projection_truncations'] = result['projection_truncations']
            meta['model_tool_errors'] = result['model_tool_errors']
            errors += result['evidence_errors']
            behavior_errors = behavior(turn, result['calls'], snap, initial, cwd=cwd)
            quality += result['quality_errors'] + behavior_errors
            hard_quality += result['tool_quality_errors'] + behavior_errors
            if result['fill_machine']:
                fill_machine.append(dict(turn=turn, **result['fill_machine']))
            sid = result['session_id']
        except (OSError, ValueError, KeyError, TypeError) as error:
            errors.append('parse/snapshot failure: ' + type(error).__name__)
        if meta['exit_code'] != 0 or meta['termination'] != 'exited' or meta['cleanup'] != 'complete':
            errors.append('process failure: ' + meta['termination'])
        try:
            stderr = prefix.with_suffix('.stderr')
            if stderr.stat().st_size > MAX_LOG_BYTES:
                errors.append('oversize stderr')
            elif TRANSPORT.search(stderr.read_text(encoding='utf-8', errors='strict')):
                errors.append('transport/retry stderr diagnostic')
        except (OSError, ValueError):
            errors.append('missing/invalid stderr')
        meta['parser_errors'] = list(errors)
        write_json(prefix.with_suffix('.meta.json'), meta)
        if errors:
            write_json(root / 'FAILED.json', {'group': rid, 'turn': turn, 'errors': errors})
            print(f'group {rid}, turn {turn}: infrastructure failure; attempt preserved', flush=True)
            return False
    write_json(group / 'result.json', {'evidence_pass': True, 'quality_errors': quality,
                                      'tool_behavior_errors': hard_quality, 'fill_machine': fill_machine,
                                      'provisional': True, 'semantic_verified': False, 'release_quality_pass': False,
                                      'answer_pass': not quality, 'session_id': sid})
    return True


def finish(root):
    result = score_cell(root)
    write_json(root / 'result.json', result)
    print(json.dumps({k: result[k] for k in ('gate_pass', 'provisional', 'release_quality_pass', 'complete_turns', 'planned_turns', 'fill_correct', 'planned_fill')}))
    return 0 if result['gate_pass'] else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('init', 'group', 'all', 'finish'))
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--spec', type=Path)
    parser.add_argument('--preregistration', type=Path, help='frozen semantic registration required for live collection')
    parser.add_argument('--group', type=int)
    parser.add_argument('--dsh', default='dsh', help='explicit executable; offline tests pass fake_dsh.py')
    args = parser.parse_args()
    try:
        if os.environ.get('SPINE_COUNT'):
            raise ValueError('SPINE_COUNT is unsupported: release dimensions cannot be overridden')
        root = args.root.resolve()
        if args.action in ('init', 'all'):
            if not args.spec:
                raise ValueError('--spec is required')
            init_attempt(root, read_json(args.spec), args.preregistration)
        if args.action == 'init':
            return 0
        if args.action == 'group':
            if args.group is None:
                raise ValueError('--group is required')
            return 0 if run_group(root, args.group, args.dsh) else 1
        if args.action == 'all':
            for rid in range(1, GROUPS + 1):
                if not run_group(root, rid, args.dsh):
                    return 1
        return finish(root)
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(type(error).__name__ + ': ' + str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
