"""Synthetic-only protocol regressions. No stored model logs or real credentials."""
import base64
import contextlib
import copy
import json
import io
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from contract import FILL, HERE, read_json, sha, write_json
from mkfx import build_log
from run import init_attempt, run_group
from score import compare, parse_turn, score_cell
from semantic import (ATTESTATION, VERSION, adjudicate, apply_verdicts, canonical,
                      export, load, main, policy_at, register, reviewers, sources, verify)
from synthetic import cell, events, spec, write_events


def span(text, start=0, end=None):
    raw = text.encode('utf-8')
    end = len(raw) if end is None else end
    return {'start': start, 'end': end, 'sha256': sha(raw[start:end])}


def line_spans(text, prefix):
    result, offset = [], 0
    for line in text.splitlines(keepends=True):
        if line.startswith(prefix):
            result.append(span(text, offset, offset + len(line.rstrip('\n').encode())))
        offset += len(line.encode())
    return result


class SemanticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix='semantic-synthetic-tests-')
        cls.addClassCleanup(cls.tmp.cleanup)
        cls.base = Path(cls.tmp.name).resolve()
        cls.keys, cls.registry = {}, []
        for who in ('A', 'B', 'C'):
            key = cls.base / (who + '.test-private.pem')
            subprocess.run(['openssl', 'genrsa', '-out', str(key), '2048'], check=True,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
            public = subprocess.run(['openssl', 'rsa', '-in', str(key), '-pubout'], check=True,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5).stdout.decode()
            cls.keys[who] = key
            cls.registry.append(dict(reviewer_id=who, public_key_pem=public, independence=ATTESTATION))
        cls.plan = []
        cls.roots = {}
        for family in ('ds', 'glm'):
            for arm in ('candidate', 'stock'):
                root = cls.base / (family + '-' + arm)
                cls.plan.append(dict(root=str(root), spec=spec(root, arm, family)))
                cls.roots[family + '/' + arm] = root
        cls.policy = cls.base / 'registration.json'
        register(cls.plan, cls.registry, cls.policy, synthetic=True)
        for entry in cls.plan:
            identity = entry['spec']
            with patch('synthetic.init_attempt', side_effect=lambda root, spec: init_attempt(root, spec, cls.policy)):
                cell(Path(entry['root']), identity['arm'], identity['model_family'])
        # Correct extra prose is reviewed; it does not have to be canonical.
        cls.extra_path = cls.roots['ds/candidate'] / 'runs/spine-1/t2.jsonl'
        items = [json.loads(x) for x in cls.extra_path.read_text().splitlines()]
        items[-1]['text'] = 'WARN: 5\nNONE（本文件没有 NOTICE。）\n说明：这里只统计当前文件。'
        cls.rewrite(cls.extra_path, items)
        cls.blind = cls.base / 'blind'
        cls.blind.mkdir()
        cls.packet, cls.mapping = cls.blind / 'packet.json', cls.base / 'mapping.json'
        export(cls.policy, cls.packet, cls.mapping)
        cls.packet_data, cls.map_data = read_json(cls.packet), read_json(cls.mapping)
        cls.packet_sha = sha(cls.packet.read_bytes())
        cls.protocol_sha = sha(cls.policy.read_bytes())
        cls.receipts_data = dict(version=VERSION, packet_sha256=cls.packet_sha, cases={})
        for case in cls.packet_data['cases']:
            cls.receipts_data['cases'][case['case_id']] = [cls.envelope(case, who) for who in ('A', 'B')]
        cls.receipts = cls.base / 'receipts.json'
        write_json(cls.receipts, cls.receipts_data)

    @staticmethod
    def rewrite(path, items):
        write_events(path, items)
        for suffix in ('.meta.json', '.process.json'):
            target = path.with_suffix(suffix)
            meta = read_json(target)
            meta['stdout_sha256'] = sha(path.read_bytes())
            target.write_text(json.dumps(meta))

    @classmethod
    def sign(cls, record):
        signature = subprocess.run(['openssl', 'dgst', '-sha256', '-sign', str(cls.keys[record['reviewer_id']])],
                                   input=canonical(record), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   check=True, timeout=5).stdout
        return {'record': record, 'signature': base64.b64encode(signature).decode()}

    @classmethod
    def envelope(cls, case, who, verdicts=('correct', 'correct', 'correct'), observed=None):
        fixture = build_log(int(case['source']))[0]
        record = dict(version=VERSION, reviewer_id=who, signed_off=True, independent=True,
                      full_final_reviewed=True, stage='initial', adjudicates=[],
                      packet_sha256=cls.packet_sha, protocol_sha256=cls.protocol_sha,
                      **{k: case[k] for k in ('case_id', 'run_sha256', 'final_sha256')})
        for index, field in enumerate(('warn', 'notice')):
            value = (observed or case['expected'])[field]
            evidence = line_spans(fixture, 'WARN ' if field == 'warn' else 'NOTICE ')
            if field == 'notice' and case['expected']['notice'] == 'NONE':
                evidence = [span(fixture)]
            record[field] = dict(verdict=verdicts[index], observed=value,
                                 answer_spans=[span(case['final'])], source_spans=evidence,
                                 rationale='Checked the complete answer against the exact source facts.')
        record['extra'] = dict(verdict=verdicts[2], final_spans=[span(case['final'])],
                               rationale='Read all prose; no unsupported extra fact, uncertainty or contradictory claim.')
        return cls.sign(record)

    def small_case(self, text='WARN: 5\nNONE'):
        case = next(copy.deepcopy(c) for c in self.packet_data['cases'] if c['source'] == '2')
        case.update(final=text, final_sha256=sha(text.encode()))
        return case

    def decide(self, case, records):
        return adjudicate(records, case, self.packet_sha, self.protocol_sha,
                          {r['reviewer_id']: r for r in self.registry}, build_log(int(case['source']))[0])

    @contextlib.contextmanager
    def changed(self, path, data):
        previous = path.read_bytes()
        path.write_bytes(data)
        try:
            yield
        finally:
            path.write_bytes(previous)

    @contextlib.contextmanager
    def changed_events(self, path, items):
        paths = [path, path.with_suffix('.meta.json'), path.with_suffix('.process.json')]
        originals = {p: p.read_bytes() for p in paths}
        self.rewrite(path, items)
        try:
            yield
        finally:
            for target, data in originals.items():
                target.write_bytes(data)

    def test_full_matrix_cardinality_hashes_and_synthetic_blindness(self):
        packet, mapping = self.packet_data, self.map_data
        self.assertEqual(len(packet['cases']), 920)
        self.assertEqual(len({c['case_id'] for c in packet['cases']}), 920)
        self.assertEqual(len({c['run_sha256'] for c in packet['cases']}), 920)
        self.assertEqual(packet['sources'], sources())
        for case in packet['cases']:
            self.assertEqual(set(case), {'case_id', 'run_sha256', 'final_sha256', 'final', 'source', 'expected'})
            self.assertEqual(sha(case['final'].encode()), case['final_sha256'])
            self.assertRegex(case['case_id'], r'^[a-f0-9]{32}$')
        for key in self.roots:
            selected = [r for r in mapping['cases'] if r['cell'] == key]
            self.assertEqual({(r['group'], r['turn']) for r in selected}, {(g, t) for g in range(1, 11) for t in FILL})
        self.assertNotEqual([c['case_id'] for c in packet['cases']], [c['case_id'] for c in mapping['cases']])
        self.assertEqual(self.mapping.stat().st_mode & 0o777, 0o600)
        self.assertEqual(list(self.packet.parent.iterdir()), [self.packet])

    def test_full_signed_matrix_is_verified_but_never_full_release(self):
        result = verify(self.policy, self.packet, self.mapping, self.receipts)
        self.assertTrue(result['semantic_collection_pass'])
        self.assertTrue(result['paired_collection_pass'])
        self.assertFalse(result['provisional'])
        self.assertEqual(result['mode'], 'synthetic')
        self.assertFalse(result['live_collection_pass'])
        self.assertFalse(result['release_pass'])
        for report in result['cells'].values():
            self.assertEqual((report['planned_turns'], report['complete_turns'], report['planned_fill']), (310, 310, 230))
            self.assertEqual(report['semantic']['correct'], 230)
            self.assertTrue(report['semantic_verified'])
            self.assertTrue(report['release_quality_pass'])
            self.assertFalse(report['cache_release_pass'])
        for report in result['comparisons'].values():
            self.assertTrue(report['matched_collection_pass'], report['errors'])
            self.assertFalse(report['cache_release_pass'])
        reviewed = result['cells']['ds/candidate']['fill_results'][0]
        self.assertEqual(reviewed['machine']['status'], 'REVIEW')
        self.assertTrue(reviewed['machine']['errors'])
        self.assertEqual(reviewed['warn']['verdict'], 'correct')
        self.assertFalse(result['cells']['ds/candidate']['answer_pass'])

    def test_unreviewed_collection_and_matched_cli_remain_provisional(self):
        a, b = (score_cell(self.roots['glm/' + arm]) for arm in ('candidate', 'stock'))
        self.assertTrue(a['gate_pass'])  # legacy diagnostic, not semantic approval
        self.assertTrue(a['provisional'])
        self.assertFalse(a['release_quality_pass'])
        self.assertIsNone(a['fill_results'][0]['warn']['verdict'])
        self.assertFalse(compare(a, b)['matched_collection_pass'])
        cli = subprocess.run([sys.executable, '-B', str(HERE / 'score.py'), '--root', str(self.roots['ds/candidate']),
                              '--stock-root', str(self.roots['ds/stock'])], stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, timeout=15)
        self.assertEqual(cli.returncode, 1)
        self.assertTrue(json.loads(cli.stdout)['provisional'])

    def test_hard_failures_cannot_be_overridden_by_complete_correct_receipts(self):
        path = self.extra_path
        original = [json.loads(x) for x in path.read_text().splitlines()]
        for kind in ('correlated-read', 'nonzero-tool', 'validation-quality', 'forbidden-behavior',
                     'quoted-rm', 'wrapped-rm', 'forbidden-import', 'opaque-command', 'malformed'):
            with self.subTest(kind=kind):
                items = copy.deepcopy(original)
                if kind == 'correlated-read':
                    next(e for e in items if e['type'] == 'tool_call')['input']['file_path'] = 'part3.log'
                elif kind == 'malformed':
                    items.pop()
                else:
                    call = dict(type='tool_call', callId='bad', tool='bash', input={'command':'false'})
                    result = dict(type='tool_result', callId='bad', status='completed', result='[exit code: 9]')
                    commands = {'forbidden-behavior': 'rm scratch', 'quoted-rm': '"rm" scratch',
                                'wrapped-rm': 'sh -c "rm scratch"',
                                'forbidden-import': 'python -c "import pandas, tenacity"',
                                'opaque-command': 'eval "$PAYLOAD"'}
                    if kind in commands:
                        # Audit inert log strings only; never execute these.
                        call['input']['command'] = commands[kind]
                        result['result'] = '[exit code: 0]'
                    elif kind == 'validation-quality':
                        call.update(tool='write', input={'file_path':'docs/NOTES.md', 'content':'x'})
                        result.update(status='error', result='Error: cannot modify "docs/NOTES.md": file has not been read — read the file, then retry')
                    items[3:3] = [call, result]
                with self.changed_events(path, items):
                    with self.assertRaisesRegex(ValueError, 'hard evidence/tool/behavior failure'):
                        verify(self.policy, self.packet, self.mapping, self.receipts)
        meta_path = path.with_suffix('.meta.json')
        meta = read_json(meta_path)
        meta['exit_code'] = 9
        with self.changed(meta_path, json.dumps(meta).encode()):
            with self.assertRaises(ValueError):
                verify(self.policy, self.packet, self.mapping, self.receipts)

    def test_turn14_audit_failures_remain_nonwaivable_with_complete_receipts(self):
        path = self.roots['ds/candidate'] / 'runs/spine-1/t14.jsonl'
        original = [json.loads(x) for x in path.read_text().splitlines()]
        for command in (
                "mkdir -p audit-bin; cp /bin/rm audit-bin/cat; printf -v PATH '%s' ./audit-bin; cat scratch",
                "printf '%n' PATH", 'cp /bin/rm audit-bin/cat',
                "grep ',' < sample.csv", "cat sample.csv | grep ','", "grep ','",
                "printf old > conf/settings.toml"):
            with self.subTest(command=command):
                items = copy.deepcopy(original)
                # The exact synthetic turn and final stay complete and correct.
                # No shell runs; correct signed finals cannot waive behavior.
                items[5:5] = [dict(type='tool_call', callId='audit', tool='bash', input={'command':command}),
                              dict(type='tool_result', callId='audit', status='completed', result='[exit code: 0]')]
                with self.changed_events(path, items):
                    with self.assertRaisesRegex(ValueError, 'hard evidence/tool/behavior failure'):
                        verify(self.policy, self.packet, self.mapping, self.receipts)

    def test_absent_full_run_or_stale_run_rejected(self):
        path = self.extra_path
        path.rename(path.with_suffix('.held'))
        try:
            with self.assertRaises(ValueError):
                verify(self.policy, self.packet, self.mapping, self.receipts)
        finally:
            path.with_suffix('.held').rename(path)
        items = [json.loads(x) for x in path.read_text().splitlines()]
        items[-1]['text'] += ' additional correct discussion'
        with self.changed_events(path, items):
            with self.assertRaisesRegex(ValueError, 'changed/stale full run'):
                verify(self.policy, self.packet, self.mapping, self.receipts)

    def test_missing_receipts_extra_cases_and_stale_packet_rejected(self):
        for change in ('missing', 'extra', 'stale'):
            data = copy.deepcopy(self.receipts_data)
            if change == 'missing':
                data['cases'].pop(next(iter(data['cases'])))
            elif change == 'extra':
                data['cases']['unknown'] = []
            else:
                data['packet_sha256'] = '0' * 64
            with self.changed(self.receipts, canonical(data)):
                with self.assertRaises(ValueError):
                    verify(self.policy, self.packet, self.mapping, self.receipts)

    def test_wrong_facts_fabricated_notice_and_forged_correct_observation_rejected(self):
        case = self.small_case('WARN: 6\nNONE')
        records = [self.envelope(case, who, observed={'warn':6, 'notice':'NONE'}) for who in ('A', 'B')]
        with self.assertRaisesRegex(ValueError, 'wrong facts'):
            self.decide(case, records)
        forged = [self.envelope(case, who) for who in ('A', 'B')]
        with self.assertRaisesRegex(ValueError, 'unsupported observed WARN'):
            self.decide(case, forged)
        records = [self.envelope(case, who, ('incorrect', 'correct', 'correct'), {'warn':6, 'notice':'NONE'}) for who in ('A', 'B')]
        self.assertEqual(self.decide(case, records), ('incorrect', 'correct', 'correct'))
        case = next(copy.deepcopy(c) for c in self.packet_data['cases'] if c['source'] == '4')
        case.update(final='WARN: 7\nNOTICE invented', final_sha256=sha(b'WARN: 7\nNOTICE invented'))
        records = [self.envelope(case, who, observed={'warn':7, 'notice':'NOTICE invented'}) for who in ('A', 'B')]
        with self.assertRaisesRegex(ValueError, 'wrong facts'):
            self.decide(case, records)

    def test_unsigned_duplicate_nonindependent_unsubstantiated_and_replayed_receipts_rejected(self):
        case = self.small_case()
        a, b = [self.envelope(case, who) for who in ('A', 'B')]
        self.assertEqual(self.decide(case, [a, b]), ('correct',) * 3)
        with self.assertRaisesRegex(ValueError, 'distinct'):
            self.decide(case, [a, a])
        for change in ('signature', 'binding', 'span', 'empty-rationale', 'not-independent', 'partial-final', 'missing-review', 'unknown-field'):
            with self.subTest(change=change):
                bad = copy.deepcopy(b['record'])
                if change == 'binding':
                    bad['run_sha256'] = '0' * 64
                elif change == 'span':
                    bad['warn']['answer_spans'][0]['sha256'] = '0' * 64
                elif change == 'empty-rationale':
                    bad['notice']['rationale'] = ''
                elif change == 'not-independent':
                    bad['independent'] = False
                elif change == 'partial-final':
                    bad['extra']['final_spans'] = [span(case['final'], 0, 3)]
                elif change == 'unknown-field':
                    bad['approve'] = True
                envelope = self.sign(bad)
                if change == 'signature':
                    envelope['signature'] = base64.b64encode(b'0' * 256).decode()
                records = [a] if change == 'missing-review' else [a, envelope]
                with self.assertRaises(ValueError):
                    self.decide(case, records)

    def test_disagreement_requires_distinct_third_and_exact_dispute_binding(self):
        case = self.small_case()
        a = self.envelope(case, 'A')
        b = self.envelope(case, 'B', ('correct', 'correct', 'incorrect'))
        with self.assertRaisesRegex(ValueError, 'third distinct'):
            self.decide(case, [a, b])
        third = self.envelope(case, 'C')['record']
        third.update(stage='adjudication', adjudicates=[sha(canonical(a)), sha(canonical(b))])
        self.assertEqual(self.decide(case, [a, b, self.sign(third)]), ('correct',) * 3)
        for change in ('distinct', 'unresolved', 'new-decision', 'stale-dispute'):
            bad = copy.deepcopy(third)
            if change == 'distinct':
                bad['reviewer_id'] = 'A'
            elif change == 'unresolved':
                bad['extra']['verdict'] = 'unresolved'
            elif change == 'new-decision':
                bad['warn']['verdict'] = 'incorrect'
            else:
                bad['adjudicates'][0] = '0' * 64
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.decide(case, [a, b, self.sign(bad)])
        with self.assertRaisesRegex(ValueError, 'unsolicited'):
            self.decide(case, [a, self.envelope(case, 'B'), self.sign(third)])
        unresolved = [self.envelope(case, who, ('unresolved', 'correct', 'correct')) for who in ('A', 'B')]
        self.assertEqual(self.decide(case, unresolved), ('unresolved', 'correct', 'correct'))

    def test_every_extra_envelope_is_validated_before_stage_partition(self):
        case = self.small_case()
        initials = [self.envelope(case, who) for who in ('A', 'B')]
        astra = {'record': {'reviewer_id': 'NOT_REGISTERED', 'stage': 'discarded'},
                 'signature': 'invalid base64 !!!', 'ignored': True}
        for extra in (astra, None, {}, {'record': None, 'signature': ''}):
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                self.decide(case, initials + [extra])
        for change in ('unknown-stage', 'unknown-reviewer', 'signature', 'extra-envelope-field'):
            third = self.envelope(case, 'C')
            if change == 'unknown-stage':
                third['record']['stage'] = 'discarded'
                third = self.sign(third['record'])
            elif change == 'unknown-reviewer':
                third['record']['reviewer_id'] = 'NOT_REGISTERED'
            elif change == 'signature':
                third['record']['stage'] = 'adjudication'
                third['signature'] = 'invalid base64 !!!'
            else:
                third['ignored'] = True
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.decide(case, initials + [third])

    def test_registration_rejects_known_invalid_pairs_before_collection(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp).resolve()
            plan = [dict(root=str(base / (f + '-' + a)), spec=spec(base / (f + '-' + a), a, f))
                    for f in ('ds', 'glm') for a in ('candidate', 'stock')]
            for key in ('model', 'route', 'host', 'dependencies', 'parameters', 'cache_warmup',
                        'usage_semantics', 'package_sha256', 'dsh_home', 'profile', 'shadow_dir'):
                bad = copy.deepcopy(plan)
                if key in ('dsh_home', 'profile', 'shadow_dir'):
                    bad[1]['spec'][key] = bad[0]['spec'][key]
                elif key == 'package_sha256':
                    bad[1]['spec'][key] = '1' * 64
                elif key in ('dependencies', 'parameters'):
                    bad[1]['spec'][key]['different'] = True
                else:
                    bad[1]['spec'][key] += '-different'
                output = base / 'must-not-exist.json'
                with self.subTest(key=key), patch('semantic.reviewers') as keys:
                    with self.assertRaises(ValueError):
                        register(bad, self.registry, output, synthetic=True)
                    keys.assert_not_called()
                    self.assertFalse(output.exists())
                    self.assertTrue(all(not Path(e['root']).exists() for e in bad))
            for change in ('cross-family-home', 'cross-family-profile', 'nested', 'cross-role', 'aliased-root'):
                bad = copy.deepcopy(plan)
                if change == 'cross-family-home':
                    bad[2]['spec']['dsh_home'] = bad[0]['spec']['dsh_home']
                elif change == 'cross-family-profile':
                    bad[2]['spec']['profile'] = bad[0]['spec']['profile']
                elif change == 'nested':
                    bad[2]['spec']['shadow_dir'] = bad[0]['spec']['shadow_dir'] + '/nested'
                elif change == 'cross-role':
                    bad[2]['spec']['dsh_home'] = bad[0]['root']
                else:
                    bad[2]['root'] = str(base / 'unused' / '..' / 'glm-candidate')
                with self.subTest(change=change), self.assertRaises(ValueError):
                    register(bad, self.registry, base / 'invalid.json', synthetic=True)
            # Policy reads also revalidate known static failures; old files cannot bypass registration.
            policy = read_json(self.policy)
            policy['plan'][1]['spec']['profile'] = policy['plan'][0]['spec']['profile']
            with self.changed(self.policy, canonical(policy)), self.assertRaisesRegex(ValueError, 'shared profile'):
                policy_at(self.policy)

    def test_live_aggregate_requires_both_comparisons_separate_from_semantics(self):
        # Exercise the real 920-case verifier aggregation and compare(), while
        # stubbing collection/signatures only. This is never live evidence.
        cells = {key: dict(report=score_cell(root, review_sources=True), run_sha256=self.map_data['runs'][key])
                 for key, root in self.roots.items()}
        policy = dict(read_json(self.policy), mode='live')
        for failed in (None, 'ds', 'glm'):
            collected = copy.deepcopy(cells)
            if failed:
                collected[failed+'/candidate']['report']['spec']['dsh_home'] = collected[failed+'/stock']['report']['spec']['dsh_home']
            with self.subTest(failed=failed), patch('semantic.policy_at', return_value=(policy, self.protocol_sha)), \
                    patch('semantic.collect', return_value=collected), \
                    patch('semantic.adjudicate', return_value=('correct',) * 3):
                result = verify(self.policy, self.packet, self.mapping, self.receipts)
            self.assertTrue(result['semantic_collection_pass'])
            self.assertFalse(result['provisional'])
            self.assertEqual(result['paired_collection_pass'], failed is None)
            self.assertEqual(result['live_collection_pass'], failed is None)
            self.assertFalse(result['release_pass'])
            if failed:
                self.assertIn('shared dsh_home', result['comparisons'][failed]['errors'])

    def test_cli_cannot_exit_success_on_semantic_only_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            for paired in (False, True):
                output = Path(tmp) / (str(paired)+'.json')
                result = dict(semantic_collection_pass=True, paired_collection_pass=paired,
                              live_collection_pass=paired, provisional=False, release_pass=False)
                argv = ['semantic.py', 'verify', '--registration', 'unused', '--packet', 'unused',
                        '--mapping', 'unused', '--receipts', 'unused', '--output', str(output)]
                with patch.object(sys, 'argv', argv), patch('semantic.verify', return_value=result), \
                        contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(main(), 0 if paired else 1)
                self.assertEqual(read_json(output), result)

    def test_wrong_candidate_stock_and_unresolved_keep_same_denominators(self):
        reports = {a: score_cell(self.roots['ds/' + a]) for a in ('candidate', 'stock')}
        votes = {(g, t): ('correct',) * 3 for g in range(1, 11) for t in FILL}
        wrong = votes.copy()
        wrong[(1, 2)] = ('incorrect', 'correct', 'correct')
        for arm in reports:
            apply_verdicts(reports[arm], wrong)
            self.assertEqual(reports[arm]['semantic']['incorrect'], 1)
            self.assertEqual(reports[arm]['semantic']['warn'], 229)
            self.assertEqual(reports[arm]['semantic']['notice'], 230)
            self.assertEqual((reports[arm]['planned_turns'], reports[arm]['semantic']['planned_fill']), (310, 230))
        self.assertFalse(compare(reports['candidate'], reports['stock'])['matched_collection_pass'])
        self.assertIn('candidate quality failed', compare(reports['candidate'], reports['stock'])['errors'])
        votes[(1, 2)] = ('unresolved', 'correct', 'correct')
        apply_verdicts(reports['candidate'], votes)
        self.assertTrue(reports['candidate']['provisional'])
        self.assertFalse(reports['candidate']['release_quality_pass'])

    def test_machine_fields_never_assign_a_semantic_verdict_or_cross_charge_notice(self):
        with tempfile.TemporaryDirectory() as tmp:
            cwd, path = Path(tmp) / 'work', Path(tmp) / 'turn.jsonl'
            items = events(2, cwd, 'sid')
            items[-1]['text'] = 'WARN: 6\nNONE'
            write_events(path, items)
            parsed = parse_turn(path, 2, cwd, 'sid')
            self.assertTrue(parsed['fill_machine']['warn']['errors'])
            self.assertFalse(parsed['fill_machine']['notice']['errors'])
            self.assertIsNone(parsed['fill_machine']['semantic_verdict'])
            self.assertFalse(parsed['evidence_errors'])
            self.assertFalse(parsed['tool_quality_errors'])
            items[-1]['text'] = 'WARN: 5\nNONE\n上述告警条数还应加 1，正确值为 6。'
            write_events(path, items)
            parsed = parse_turn(path, 2, cwd, 'sid')
            self.assertEqual(parsed['fill_machine']['status'], 'REVIEW')
            self.assertIsNone(parsed['fill_machine']['semantic_verdict'])

    def test_duplicate_public_keys_and_late_registration_rejected(self):
        registry = copy.deepcopy(self.registry)
        registry[1]['public_key_pem'] = registry[0]['public_key_pem']
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            reviewers(registry)
        with self.assertRaisesRegex(ValueError, 'before any planned run'):
            register(self.plan, self.registry, self.base / 'late.json', synthetic=True)

    def test_live_collection_and_synthetic_model_escape_blocked_before_process(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'attempt'
            identity = spec(root)
            identity['model'], identity['route'] = 'example-live-model', 'approved-route'
            with self.assertRaisesRegex(ValueError, 'requires semantic preregistration'):
                init_attempt(root, identity)
            self.assertFalse(root.exists())
            init_attempt(root, spec(root))
            with patch('run.process_turn') as process:
                with self.assertRaisesRegex(ValueError, 'only the local offline fake'):
                    run_group(root, 1, 'dsh')
                process.assert_not_called()

    def test_malformed_json_is_rejected_without_ignoring_duplicate_keys(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'bad.json'
            for value in ('{"version":1,"version":2}', '{"x":NaN}', '{broken'):
                path.write_text(value)
                with self.assertRaises(ValueError):
                    load(path)


if __name__ == '__main__':
    unittest.main()
