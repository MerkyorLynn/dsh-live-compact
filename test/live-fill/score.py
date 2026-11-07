#!/usr/bin/env python3
"""Offline fixed-denominator evidence and answer gate; never invokes DSH."""
import argparse
import json
import re
from pathlib import Path
from contract import (MANIFEST, GROUPS, ROUNDS, FILL, fingerprints, read_json, sha,
                      validate_contract, write_json)
from mkfx import build_log, expected_inventory
from rubric import behavior, check_command, check_evidence, fields, fill_answer

MAX_LOG_BYTES = 16 * 1024 * 1024
CACHE_FIELDS = ('cacheReadTokens', 'cacheWriteTokens')
TRANSPORT = re.compile(r'ECONN\w*|ETIMEDOUT|ENOTFOUND|connection (?:failed|reset|refused)|'
                       r'authentication (?:failed|error)|unauthorized|rate.?limit|'
                       r'HTTP [45]\d\d|retrying|retry attempt|transport error', re.I)


def integer(value):
    return type(value) is int and value >= 0


def normalize_usage(usage):
    """Copy verified DSH rc.2 disjoint usage; prove only omitted cache zeros.

    total = input + output + cacheRead + cacheWrite. With nonnegative
    counters, a zero residual forces every omitted cache bucket to zero.
    reasoningTokens is already part of output, never an additional summand.
    """
    if not isinstance(usage, dict) or any(not integer(usage.get(k)) for k in ('inputTokens', 'outputTokens')):
        raise ValueError('missing/invalid step usage')
    for key in (*CACHE_FIELDS, 'totalTokens', 'reasoningTokens'):
        if key in usage and not integer(usage[key]):
            raise ValueError('invalid optional usage bucket')
    normalized = dict(usage)
    omitted = tuple(k for k in CACHE_FIELDS if k not in usage)
    if 'totalTokens' in usage:
        known = sum(usage[k] for k in ('inputTokens', 'outputTokens', *CACHE_FIELDS) if k in usage)
        residual = usage['totalTokens'] - known
        if residual < 0 or (residual > 0 and not omitted):
            raise ValueError('inconsistent totalTokens')
        if residual == 0:
            normalized.update((k, 0) for k in omitted)
            return normalized, omitted
    return normalized, ()


def same_path(value, expected, cwd):
    if not isinstance(value, str):
        return False
    path = Path(value)
    return (path if path.is_absolute() else Path(cwd) / path).resolve() == Path(expected).resolve()


def grep_proof(args, body, expected, cwd, fixture_lines, truncated=False):
    """Only the bounded built-in grep schema/patterns, never arbitrary regex."""
    pattern = args.get('pattern')
    if (set(args) != {'path', 'pattern'} or
            pattern not in ('WARN', 'NOTICE', '(?i)warn|notice') or
            not same_path(args.get('path'), expected, cwd)):
        return False
    rows = []
    for number, line in enumerate(fixture_lines, 1):
        matches = (('warn' in line.lower() or 'notice' in line.lower())
                   if pattern == '(?i)warn|notice' else pattern in line)
        if matches:
            rows.append(f'Line {number}: {line}')
    if not rows:
        return False
    header = f'Found {len(rows)} matches\n\n{expected.name}\n'
    proof = header + '\n'.join(rows)
    if body in (proof, proof + '\n'):
        return True
    # Validate even a partial trailing row against the frozen output prefix.
    return (truncated is True and body.startswith(header + rows[0] + '\n')
            and proof.startswith(body))


def model_validation_error(call, result, cwd):
    """Only the observed rc.2 edit/write read-before-write rejection."""
    schema = {'edit': {'file_path', 'old_string', 'new_string'},
              'write': {'file_path', 'content'}}
    args = call['input']
    if (call['tool'] not in schema or set(args) != schema[call['tool']] or
            any(not isinstance(v, str) for v in args.values()) or result.get('truncated')):
        return False
    message = re.fullmatch(r'Error: cannot modify "([^"\n]+)": file has not been read — read the file, then retry', result['result'])
    return bool(message and same_path(message[1], args['file_path'], cwd))


def parse_turn(path, turn, cwd, expected_sid=None):
    """Validate rc.2 JSON; retain raw usage and log any proven cache zeros."""
    bad, quality, calls, usages, pairs = [], [], [], [], {}
    usage_zero_proofs = []
    sid = final = reason = None
    turn_open = ended = False
    step = None
    last_step = -1
    first_step_seen = False
    first_step_usage = None
    last_step_usage = None
    projection_truncations = model_tool_errors = 0
    raw = path.read_bytes()
    if len(raw) > MAX_LOG_BYTES or not raw.endswith(b'\n'):
        raise ValueError('oversize or unterminated JSON stream')
    for index, line in enumerate(raw.decode('utf-8').splitlines()):
        # Strict JSON: no ignored banners, nonfinite values or duplicate keys.
        def unique(items):
            result = {}
            for key, value in items:
                if key in result:
                    raise ValueError('duplicate event key')
                result[key] = value
            return result
        ev = json.loads(line, object_pairs_hook=unique,
                        parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite event')))
        if not isinstance(ev, dict) or not isinstance(ev.get('type'), str):
            raise ValueError('event is not a typed object')
        kind = ev['type']
        if final is not None:
            raise ValueError('event after final')
        if ev.get('truncated') is True:
            projection_truncations += 1
            if kind not in ('tool_result', 'text', 'thinking'):
                raise ValueError('essential event projection truncated')
        if kind == 'session':
            if index != 0 or sid is not None or not isinstance(ev.get('sessionId'), str) or not ev['sessionId'].strip():
                raise ValueError('missing/duplicate session identity')
            sid = ev['sessionId']
            if expected_sid is not None and sid != expected_sid:
                bad.append('session reset')
            if not same_path(ev.get('cwd'), cwd, cwd):
                bad.append('session cwd mismatch')
        elif sid is None:
            raise ValueError('session must open stream')
        elif kind == 'status':
            phase = ev.get('phase')
            if ev.get('turn') != turn or type(ev.get('turn')) is not int:
                raise ValueError('wrong DSH turn ordinal')
            if phase == 'turn_start':
                if turn_open or ended:
                    raise ValueError('duplicate turn start')
                turn_open = True
            elif phase == 'step_start':
                if not turn_open or step is not None or not integer(ev.get('step')) or ev['step'] <= last_step:
                    raise ValueError('invalid step start')
                step = ev['step']
            elif phase == 'step_end':
                if step is None or ev.get('step') != step:
                    raise ValueError('unpaired step end')
                last_step, step = step, None
                usage = ev.get('usage')
                last_step_usage = None
                is_first = not first_step_seen
                first_step_seen = True
                if not isinstance(usage, dict) or any(not integer(usage.get(k)) for k in ('inputTokens', 'outputTokens')):
                    bad.append('missing/invalid step usage')
                else:
                    _, proven_zero = normalize_usage(usage)
                    if proven_zero:
                        usage_zero_proofs.append(dict(step=last_step, fields=list(proven_zero),
                                                      totalTokens=usage['totalTokens'],
                                                      knownTokens=sum(usage[k] for k in ('inputTokens', 'outputTokens', *CACHE_FIELDS) if k in usage),
                                                      residual=0))
                    usages.append(usage)
                    last_step_usage = usage
                    if is_first:
                        first_step_usage = usage
            elif phase == 'turn_end':
                if not turn_open or step is not None:
                    raise ValueError('invalid turn end')
                reason = ev.get('reason')
                if not isinstance(reason, dict) or reason.get('kind') != 'completed':
                    bad.append('turn did not complete')
                turn_open, ended = False, True
            else:
                raise ValueError('unknown status phase')
        elif kind == 'tool_call':
            if not turn_open or not isinstance(ev.get('callId'), str) or not ev['callId'] or ev['callId'] in pairs:
                raise ValueError('invalid/duplicate tool call ID')
            if not isinstance(ev.get('tool'), str) or not isinstance(ev.get('input'), dict):
                raise ValueError('unusable tool arguments')
            pairs[ev['callId']] = [ev, None]
            calls.append(ev)
        elif kind == 'tool_result':
            pair = pairs.get(ev.get('callId'))
            if not turn_open or pair is None or pair[1] is not None:
                raise ValueError('unpaired/duplicate tool result')
            if ev.get('status') not in ('completed', 'error') or not isinstance(ev.get('result'), str):
                raise ValueError('invalid tool result')
            pair[1] = ev
            if pair[0]['tool'] == 'bash':
                exits = [int(x) for x in re.findall(r'\[(?:exit code: |Command finished with exit code |shell exited: code )(-?\d+)\]', ev['result'])]
                expected_failure = (turn == 1 and same_path(pair[0]['input'].get('workdir', str(cwd)), cwd, cwd)
                                    and check_evidence(pair[0]['input'].get('command', ''), ev['result']))
                if any(exits) and not expected_failure:
                    bad.append('tool command failed')
            if ev['status'] == 'error':
                if model_validation_error(pair[0], ev, cwd):
                    model_tool_errors += 1
                    quality.append('model tool validation error: file not read')
                else:
                    bad.append('tool infrastructure failure')
            if re.search(r'\[(?:timed out|killed by signal|stopped:|sandbox:)|Command timed out|shell killed', ev['result'], re.I):
                bad.append('tool timed out/stopped/denied')
        elif kind == 'final':
            if not ended or not isinstance(ev.get('text'), str) or not ev['text'].strip():
                raise ValueError('missing/empty/early final')
            final = ev['text']
        elif kind in ('text', 'thinking'):
            if not turn_open or not isinstance(ev.get('text'), str):
                raise ValueError('invalid text event')
        elif kind == 'error':
            bad.append('DSH error event')
        else:
            raise ValueError('unknown event type')
    if sid is None or final is None or not ended or not usages:
        bad.append('incomplete turn')
    if any(pair[1] is None for pair in pairs.values()):
        bad.append('missing tool result')
    expected = Path(cwd) / f'part{turn}.log'
    read_ok = False
    fill_errors = []
    if turn in FILL:
        fixture, _ = build_log(turn)
        fixture_lines = fixture.splitlines()
        for call, result in pairs.values():
            if result is None or result['status'] != 'completed':
                continue
            args, body = call['input'], result['result']
            if call['tool'] == 'read' and same_path(args.get('file_path'), expected, cwd):
                header = re.match(r'<path>([^\n]+)</path>\n<type>file</type>\n<content>\n', body)
                visible = body
                if result.get('truncated') and not body.endswith('\n'):
                    visible = body.rsplit('\n', 1)[0]
                numbered = re.findall(r'(?m)^(\d+): (.*)$', visible)
                if header and same_path(header[1], expected, cwd) and numbered:
                    if all(1 <= int(n) <= len(fixture_lines) and fixture_lines[int(n)-1] == text for n, text in numbered):
                        read_ok = True
            elif call['tool'] == 'grep':
                if grep_proof(args, body, expected, cwd, fixture_lines, result.get('truncated')):
                    read_ok = True
            elif call['tool'] == 'bash':
                import shlex
                try:
                    words = shlex.split(args.get('command', ''))
                except ValueError:
                    words = []
                workdir = Path(args.get('workdir', cwd))
                if not workdir.is_absolute():
                    workdir = Path(cwd) / workdir
                if len(words) == 2 and words[0] == 'cat' and same_path(words[1], expected, workdir):
                    if body == fixture or (result.get('truncated') and len(body) >= 100 and fixture.startswith(body)):
                        read_ok = True
        if not read_ok:
            bad.append('no successful correlated read of expected file')
        fill_errors = fill_answer(final or '', turn)
    if turn == 1:
        check_pairs = [(c, r) for c, r in pairs.values() if c['tool'] == 'bash'
                       and same_path(c['input'].get('workdir', str(cwd)), cwd, cwd)
                       and check_command(c['input'].get('command', ''))]
        if len(check_pairs) != 1 or check_pairs[0][1] is None:
            bad.append('missing once-only check execution')
        else:
            body = check_pairs[0][1]['result']
            if (check_pairs[0][1]['status'] != 'completed' or
                    not check_evidence(check_pairs[0][0]['input'].get('command', ''), body)):
                bad.append('missing original check failure evidence')
        if len(check_pairs) > 1:
            quality.append('repeated check.sh execution')
        if 'E1729 shard 0x3F (expected 9f2c71ab, got 9f2c71ae)' not in (final or ''):
            quality.append('turn 1 did not report exact check failure')
    if turn == 28:
        quality += fields(final or '', 'recall')
    # Legacy quality_errors stays available to callers. It is never a semantic
    # verdict: arbitrary extra prose can escape (or confuse) this heuristic.
    canonical = (f'WARN: {3 + turn % 9}\n' + (MANIFEST['notices'].get(str(turn)) or 'NONE'))
    fill_machine = dict(status='RECOGNIZED' if final == canonical else 'REVIEW',
                        errors=fill_errors,
                        warn=dict(errors=[x for x in fill_errors if 'WARN' in x]),
                        notice=dict(errors=[x for x in fill_errors if 'NOTICE' in x]),
                        semantic_verdict=None) if turn in FILL else None
    return dict(session_id=sid, final=final, calls=calls, usage=usages, reason=reason,
                usage_zero_proofs=usage_zero_proofs,
                evidence_errors=bad, quality_errors=quality + fill_errors,
                tool_quality_errors=list(quality), fill_machine=fill_machine, expected_read=read_ok,
                first_step_usage=first_step_usage, last_step_usage=last_step_usage,
                warn_correct=turn in FILL and not any('WARN' in x for x in fill_errors),
                notice_correct=turn in FILL and not any('NOTICE' in x for x in fill_errors),
                projection_truncations=projection_truncations,
                model_tool_errors=model_tool_errors,
                request_finish_reason=None, transport_retries=None)


def load_evidence(group, turn, cwd, sid):
    prefix = group / f't{turn}'
    meta = read_json(prefix.with_suffix('.meta.json'))
    if meta.get('turn') != turn or meta.get('requested_session') != sid:
        raise ValueError('wrong turn/requested session metadata')
    for name, suffix in (('stdout', '.jsonl'), ('stderr', '.stderr')):
        if prefix.with_suffix(suffix).stat().st_size > MAX_LOG_BYTES:
            raise ValueError('oversize process log')
        data = prefix.with_suffix(suffix).read_bytes()
        if meta.get(name + '_sha256') != sha(data):
            raise ValueError('changed process output')
    if not isinstance(meta.get('started'), (float, int)) or not isinstance(meta.get('ended'), (float, int)) or meta['ended'] < meta['started']:
        raise ValueError('invalid process times')
    process = read_json(prefix.with_suffix('.process.json'))
    if any(meta.get(key) != value for key, value in process.items()):
        raise ValueError('process metadata mismatch')
    result = parse_turn(prefix.with_suffix('.jsonl'), turn, cwd, sid)
    if meta.get('exit_code') != 0 or meta.get('termination') != 'exited' or meta.get('cleanup') != 'complete':
        result['evidence_errors'].append('process failure/timeout/unclean child cleanup')
    errors = TRANSPORT.findall(prefix.with_suffix('.stderr').read_text(encoding='utf-8'))
    if errors:
        result['evidence_errors'].append('transport/retry diagnostic on stderr')
    snapshot = read_json(prefix.with_suffix('.snapshot.json'))
    for name, text in snapshot['texts'].items():
        if not isinstance(text, str) or snapshot['files'].get(name) != sha(text.encode('utf-8')):
            raise ValueError('artifact content/hash mismatch')
    if meta.get('snapshot_sha256') != sha(prefix.with_suffix('.snapshot.json').read_bytes()):
        raise ValueError('changed workspace snapshot')
    if result['session_id'] != meta.get('observed_session'):
        raise ValueError('session metadata mismatch')
    return result, snapshot, meta


def ratios(usages):
    normalized, proofs = [], []
    for usage in usages:
        value, proven_zero = normalize_usage(usage)
        normalized.append(value)
        proofs.append(proven_zero)
    keys = ('inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens')
    totals = {k: sum(x[k] for x in normalized) if normalized and all(k in x for x in normalized) else None for k in keys}
    read, miss, write = (totals[k] for k in ('cacheReadTokens', 'inputTokens', 'cacheWriteTokens'))
    totals['read_over_read_plus_input'] = read / (read + miss) if read is not None and miss is not None and read + miss else None
    totals['actual_prompt_read_ratio'] = read / (read + miss + write) if all(x is not None for x in (read, miss, write)) and read + miss + write else None
    totals['steps'] = len(usages)
    totals['usage_normalization'] = dict(
        proven_zero_steps=sum(bool(proof) for proof in proofs),
        proven_zero_fields={k: sum(k in proof for proof in proofs) for k in CACHE_FIELDS},
        explicit_fields={k: sum(k in usage for usage in usages) for k in CACHE_FIELDS},
        unknown_fields={k: sum(k not in usage for usage in normalized) for k in CACHE_FIELDS})
    return totals


def score_cell(root, *, review_sources=False):
    validate_contract()
    run = read_json(root / 'attempt.json')
    if run.get('fingerprints') != fingerprints() or run.get('version') != MANIFEST['version']:
        raise ValueError('stale attempt: contract/code hashes differ')
    spec = run['spec']
    if spec.get('arm') not in ('candidate', 'stock') or spec.get('model_family') not in ('ds', 'glm'):
        raise ValueError('invalid model/arm identity')
    if spec.get('usage_semantics') != 'disjoint-input-read-write':
        raise ValueError('unverified usage semantics')
    report = dict(version=MANIFEST['version'], arm=spec['arm'], spec=spec,
                  planned_turns=GROUPS * ROUNDS, planned_fill=MANIFEST['fill_per_cell'],
                  complete_turns=0, fill_correct=0, expected_reads=0,
                  fill_complete=0, warn_correct=0, notice_correct=0, projection_truncations=0, model_tool_errors=0,
                  evidence_errors=[], quality_errors=[], tool_behavior_errors=[], fill_machine_errors=[],
                  fill_results=[], groups=[], usage_zero_proofs=[], fingerprints=run['fingerprints'],
                  semantic_verified=False, provisional=True, release_quality_pass=False,
                  observability={'request_finish_reason':'not emitted by rc.2 JSON',
                                 'transport_retries':'not emitted; stderr diagnostics detected, silent retries unknown',
                                 'post_cut_first_request':'not observable in JSON; separate cut/request trace required',
                                 'summary_request_cost':'not observable in JSON; separate provider accounting required'})
    if set(p.name for p in root.iterdir()) - {'attempt.json', 'runs', 'work', 'result.json', 'FAILED.json'}:
        report['evidence_errors'].append('unexpected/stale attempt files')
    if (root / 'FAILED.json').exists():
        report['evidence_errors'].append('attempt stopped on infrastructure failure')
    if set(p.name for p in (root / 'runs').iterdir()) - {f'spine-{n}' for n in range(1, GROUPS+1)}:
        report['evidence_errors'].append('unexpected/stale result groups')
    expected_initial = expected_inventory()
    first, all_steps = [], []
    seen_sessions = set()
    for rid in range(1, GROUPS + 1):
        group = root / 'runs' / f'spine-{rid}'
        cwd = root / 'work' / f'spine-{rid}'
        if group.exists():
            allowed = {'initial.json', 'result.json'} | {
                f't{n}{suffix}' for n in range(1, ROUNDS+1)
                for suffix in ('.jsonl', '.stderr', '.process.json', '.meta.json', '.snapshot.json')}
            if set(p.name for p in group.iterdir()) - allowed:
                report['evidence_errors'].append(f'g{rid}: unexpected/stale result files')
        sid, last_end = None, None
        gr = dict(group=rid, complete_turns=0, t27_last_request_totalTokens=None,
                  t31_last_request_totalTokens=None, started=None, ended=None)
        try:
            initial = read_json(group / 'initial.json')
            if initial != expected_initial:
                raise ValueError('fixture inventory mismatch')
        except (OSError, ValueError):
            initial = {}
            report['evidence_errors'].append(f'g{rid}: missing/corrupt initial inventory')
        for turn in range(1, ROUNDS + 1):
            tag = f'g{rid}/t{turn}'
            try:
                result, snapshot, meta = load_evidence(group, turn, cwd, sid)
                if last_end is not None and meta['started'] < last_end:
                    result['evidence_errors'].append('overlapping/out-of-order turns')
                last_end = meta['ended']
                if gr['started'] is None:
                    gr['started'] = meta['started']
                gr['ended'] = meta['ended']
                if sid is None:
                    sid = result['session_id']
                    if sid in seen_sessions:
                        result['evidence_errors'].append('session reused across groups')
                    seen_sessions.add(sid)
                behavior_errors = behavior(turn, result['calls'], snapshot, initial, cwd=cwd)
                result['quality_errors'] += behavior_errors
                hard_quality = result['tool_quality_errors'] + behavior_errors
                report['tool_behavior_errors'] += [tag + ': ' + x for x in hard_quality]
                if not result['evidence_errors']:
                    report['complete_turns'] += 1
                    gr['complete_turns'] += 1
                report['evidence_errors'] += [tag + ': ' + x for x in result['evidence_errors']]
                report['quality_errors'] += [tag + ': ' + x for x in result['quality_errors']]
                if turn in FILL:
                    report['fill_machine_errors'] += [tag + ': ' + x for x in result['fill_machine']['errors']]
                    case = dict(group=rid, turn=turn, final_sha256=sha(result['final'].encode('utf-8')),
                                evidence_errors=list(result['evidence_errors']),
                                tool_behavior_errors=hard_quality, machine=result['fill_machine'],
                                warn={'verdict': None}, notice={'verdict': None})
                    if review_sources:
                        case['final'] = result['final']
                    report['fill_results'].append(case)
                    report['expected_reads'] += int(result['expected_read'])
                    report['fill_complete'] += int(not result['evidence_errors'])
                    report['warn_correct'] += int(result['warn_correct'] and not result['evidence_errors'])
                    report['notice_correct'] += int(result['notice_correct'] and not result['evidence_errors'])
                    report['fill_correct'] += int(not result['quality_errors'] and not result['evidence_errors'])
                report['projection_truncations'] += result['projection_truncations']
                report['model_tool_errors'] += result['model_tool_errors']
                report['usage_zero_proofs'] += [dict(group=rid, turn=turn, **proof)
                                               for proof in result['usage_zero_proofs']]
                if result['first_step_usage'] is not None:
                    first.append(result['first_step_usage'])
                if result['usage']:
                    all_steps += result['usage']
                    if turn in (27, 31):
                        last_usage = result['last_step_usage']
                        gr[f't{turn}_last_request_totalTokens'] = last_usage.get('totalTokens') if last_usage is not None else None
            except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
                # Preserve every denominator. Never echo raw logs or model text.
                report['evidence_errors'].append(tag + ': missing/corrupt evidence (' + type(error).__name__ + ')')
        report['groups'].append(gr)
    report['first_step'] = ratios(first)
    report['all_steps'] = ratios(all_steps)
    report['metrics_partial'] = report['complete_turns'] != GROUPS * ROUNDS or bool(report['evidence_errors'])
    report['evidence_pass'] = not report['evidence_errors'] and report['complete_turns'] == GROUPS * ROUNDS
    report['answer_pass'] = report['fill_correct'] == MANIFEST['fill_per_cell'] and not report['quality_errors']
    report['hard_quality_pass'] = not report['tool_behavior_errors']
    report['gate_pass'] = report['evidence_pass'] and (spec['arm'] == 'stock' or report['answer_pass'])
    report['cache_release_pass'] = False  # A cell alone never establishes comparability.
    elapsed = [g['ended'] - g['started'] for g in report['groups'] if g['started'] is not None and g['ended'] is not None]
    report['group_elapsed_seconds'] = elapsed
    report['sum_group_elapsed_seconds'] = sum(elapsed)
    starts = [g['started'] for g in report['groups'] if g['started'] is not None]
    ends = [g['ended'] for g in report['groups'] if g['ended'] is not None]
    report['overall_time_span_seconds'] = max(ends) - min(starts) if starts and ends else None
    return report


COMPARABLE_SPEC_KEYS = ('model_family', 'model', 'route', 'host', 'dependencies', 'parameters',
                        'cache_warmup', 'usage_semantics', 'package_sha256')
ISOLATED_SPEC_KEYS = ('dsh_home', 'profile', 'shadow_dir')


def spec_comparison_errors(candidate, stock):
    """Static paired requirements, shared by preregistration and final scoring."""
    errors = ['noncomparable ' + key for key in COMPARABLE_SPEC_KEYS
              if candidate.get(key) != stock.get(key)]
    for key in ISOLATED_SPEC_KEYS:
        if candidate.get(key) == stock.get(key):
            errors.append('shared ' + key)
    return errors


def compare(candidate, stock):
    """Prerecorded budgets. Never turn unmatched/historical input into release proof."""
    errors = []
    if candidate['arm'] != 'candidate' or stock['arm'] != 'stock':
        errors.append('wrong comparison arms')
    for report in (candidate, stock):
        if not report['evidence_pass'] or report['planned_turns'] != 310 or report['planned_fill'] != 230:
            errors.append('incomplete evidence cannot be compared')
    if not (candidate['release_quality_pass'] if candidate.get('semantic_verified') else candidate['answer_pass']):
        errors.append('candidate quality failed')
    errors += spec_comparison_errors(candidate['spec'], stock['spec'])
    if candidate['fingerprints'] != stock['fingerprints']:
        errors.append('different harness')
    if candidate['spec'].get('usage_semantics') != 'disjoint-input-read-write':
        errors.append('unknown usage semantics')
    for cg, sg, order in zip(candidate['groups'], stock['groups'], MANIFEST['cache']['group_order']):
        a, b = (cg, sg) if order == 'candidate,stock' else (sg, cg)
        if a['ended'] is None or b['started'] is None or a['ended'] > b['started']:
            errors.append('unbalanced/overlapping group order')
    budget = MANIFEST['cache']
    for section in ('first_step', 'all_steps'):
        a = candidate[section]['read_over_read_plus_input']
        b = stock[section]['read_over_read_plus_input']
        if a is None or b is None:
            errors.append('missing cache counters')
        elif a < b - budget['ratio_regression_budget']:
            errors.append(section + ' cache regression')
        if candidate[section]['cacheWriteTokens'] is None or stock[section]['cacheWriteTokens'] is None:
            errors.append('cacheWrite unknown; actual prompt ratio unknown')
    floor = candidate['first_step']['read_over_read_plus_input']
    if candidate['spec']['model_family'] == 'ds' and (floor is None or floor < budget['ds_first_step_floor']):
        errors.append('DS historical first-step floor failed')
    a, b = candidate['all_steps']['inputTokens'], stock['all_steps']['inputTokens']
    if a is None or b is None or a > b * budget['uncached_input_multiplier']:
        errors.append('uncached input cost regression/unknown')
    # The projection cannot establish these claims. They are separate runtime
    # release evidence, never fabricated zero counters or a default PASS here.
    verified = all(r.get('semantic_verified') and not r.get('provisional', True) for r in (candidate, stock))
    return dict(cache_comparison_pass=not errors, errors=errors,
                provisional=not verified,
                semantic_verified=verified,
                semantic_review_errors=[] if verified else ['verified full-matrix semantic receipts required'],
                matched_collection_pass=verified and not errors and all(r['hard_quality_pass'] for r in (candidate, stock)),
                cache_release_pass=False,
                usage_metrics={report['arm']: {section: report[section] for section in ('first_step', 'all_steps')}
                               for report in (candidate, stock)},
                remaining_release_evidence=['independent retry/provider-route accounting',
                                           'summary/extra-request cost', 'cut and post-cut request trace',
                                           'runtime threshold/cut controls; stock plugin absence'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--stock-root', type=Path)
    parser.add_argument('--output', type=Path, help='new report only; never overwrite')
    args = parser.parse_args()
    try:
        report = score_cell(args.root.resolve())
        ok = report['gate_pass']
        if args.stock_root:
            report = compare(report, score_cell(args.stock_root.resolve()))
            ok = report['matched_collection_pass']
        if args.output:
            write_json(args.output, report)
        print(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False))
        return 0 if ok else 1
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(json.dumps({'gate_pass':False, 'provisional':True, 'release_quality_pass':False,
                          'error':type(error).__name__ + ': ' + str(error)}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
