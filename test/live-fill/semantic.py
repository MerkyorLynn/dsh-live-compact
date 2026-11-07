#!/usr/bin/env python3
"""Bounded, offline first-release semantic registration, blind export and receipts.

No model/client imports or network operations. OpenSSL verifies public-key
signatures locally; this program never reads a private key or signs a review.
"""
import argparse
import base64
import json
import re
import secrets
import subprocess
import tempfile
import time
from pathlib import Path
from contract import (FILL, GROUPS, HERE, MANIFEST, NOTICE, ROUNDS, fingerprints,
                      read_json, sha, validate_contract, write_json)
from mkfx import build_log
from score import MAX_LOG_BYTES, compare, score_cell, spec_comparison_errors

VERSION = 'semantic-review-112-v1'
MATRIX = {(family, arm) for family in ('ds', 'glm') for arm in ('candidate', 'stock')}
LIMIT = 64 * 1024 * 1024
ATTESTATION = 'independent-of-authors-and-other-reviewers'
VERDICTS = {'correct', 'incorrect', 'unresolved'}


def canonical(value):
    """The exact UTF-8 bytes signed with RSA PKCS#1 v1.5 / SHA256."""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'),
                      allow_nan=False).encode('utf-8')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def exact(value, keys):
    require(isinstance(value, dict) and set(value) == set(keys.split()), 'malformed fields')


def bounded(path, limit=LIMIT):
    path = Path(path)
    require(not path.is_symlink() and path.is_file() and path.stat().st_size <= limit,
            'missing, linked or oversized evidence')
    return path.read_bytes()


def load(path):
    bounded(path)
    return read_json(path)


def openssl(args, data):
    result = subprocess.run(['openssl', *args], input=data, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=5)
    require(result.returncode == 0, 'invalid public key or review signature')
    return result.stdout


def reviewers(registry):
    require(isinstance(registry, list) and 3 <= len(registry) <= 12, 'register 3..12 independent reviewers')
    ids, keys = set(), set()
    for row in registry:
        exact(row, 'reviewer_id public_key_pem independence')
        require(isinstance(row['reviewer_id'], str) and re.fullmatch(r'[A-Za-z0-9_-]{1,80}', row['reviewer_id']), 'reviewer identity')
        require(row['independence'] == ATTESTATION, 'reviewer independence declaration required')
        pem = row['public_key_pem']
        require(isinstance(pem, str) and len(pem) < 8192 and pem.startswith('-----BEGIN PUBLIC KEY-----'), 'public key required')
        info = openssl(['rsa', '-pubin', '-text', '-noout'], pem.encode())
        bits = re.search(rb'\((\d+) bit\)', info)
        require(bits and 2048 <= int(bits[1]) <= 4096, 'RSA public key must be 2048..4096 bits')
        digest = sha(openssl(['rsa', '-pubin', '-outform', 'DER'], pem.encode()))
        require(row['reviewer_id'] not in ids and digest not in keys, 'duplicate reviewer identity/key')
        ids.add(row['reviewer_id'])
        keys.add(digest)
    return {r['reviewer_id']: r for r in registry}


def validate_plan(plan, *, synthetic, new=False):
    """Reject known static isolation/comparability failures before collection."""
    from run import validate_spec
    require(isinstance(plan, list) and len(plan) == 4, 'four planned cells required')
    identities, roots = set(), set()
    for entry in plan:
        exact(entry, 'root spec')
        spec = validate_spec(entry['spec'])
        root = Path(entry['root'])
        require(root.is_absolute() and str(root.resolve()) == str(root), 'canonical absolute run root required')
        if new:
            require(not root.exists(), 'register before any planned run exists')
        identities.add((spec['model_family'], spec['arm']))
        roots.add(str(root))
        require((spec['model'] == 'synthetic-only' and spec['route'] == 'offline-fake') == synthetic,
                'synthetic/live provenance mismatch')
    require(identities == MATRIX and len(roots) == 4, 'exact ds/glm candidate/stock matrix required')
    cells = {(e['spec']['model_family'], e['spec']['arm']): e['spec'] for e in plan}
    for family in ('ds', 'glm'):
        errors = spec_comparison_errors(cells[family, 'candidate'], cells[family, 'stock'])
        require(not errors, 'invalid paired plan: ' + ', '.join(errors))
    # All four cells need independent homes/profiles/shadows. Also disallow
    # ancestor/descendant and cross-role filesystem aliases, not just equal strings.
    paths = []
    profiles = set()
    for entry in plan:
        spec = entry['spec']
        require(spec['profile'] not in profiles, 'shared profile across cells')
        profiles.add(spec['profile'])
        current = [Path(entry['root']), *(Path(spec[k]) for k in ('dsh_home', 'shadow_dir'))]
        require(all(str(p.resolve()) == str(p) for p in current), 'canonical isolated paths required')
        for path in current:
            require(not any(path == other or path in other.parents or other in path.parents for other in paths),
                    'overlapping run/home/shadow paths')
        paths.extend(current)


def register(plan, registry, output, *, synthetic=False):
    """Run before initialization. All planned roots must be new, exact paths."""
    validate_plan(plan, synthetic=synthetic, new=True)
    reviewers(registry)
    policy = dict(version=VERSION, mode='synthetic' if synthetic else 'live',
                  created=time.time(), nonce=secrets.token_hex(32), fingerprints=fingerprints(),
                  plan=plan, reviewers=registry, dimensions={'turns_per_cell': 310, 'fill_per_cell': 230, 'cases': 920})
    write_json(output, policy)
    return policy


def policy_at(path):
    policy = load(path)
    exact(policy, 'version mode created nonce fingerprints plan reviewers dimensions')
    require(policy['version'] == VERSION and policy['mode'] in ('synthetic', 'live'), 'unsupported registration')
    require(isinstance(policy['nonce'], str) and re.fullmatch(r'[0-9a-f]{64}', policy['nonce']), 'registration nonce')
    require(type(policy['created']) in (int, float) and policy['created'] <= time.time(), 'registration time')
    require(policy['fingerprints'] == fingerprints(), 'stale protocol/input/code registration')
    require(policy['dimensions'] == {'turns_per_cell': 310, 'fill_per_cell': 230, 'cases': 920}, 'changed denominators')
    validate_plan(policy['plan'], synthetic=policy['mode'] == 'synthetic')
    reviewers(policy['reviewers'])
    return policy, sha(bounded(path))


def check_registration(path, root, spec, attempt=None):
    policy, digest = policy_at(path)
    matches = [p for p in policy['plan'] if p['root'] == str(root.resolve()) and p['spec'] == spec]
    require(len(matches) == 1, 'run/spec absent from preregistration')
    if attempt is not None:
        require(attempt.get('semantic_registration') == {'path': str(Path(path).resolve()), 'sha256': digest},
                'missing/replaced registration binding')
        require(type(attempt.get('created')) in (int, float) and attempt['created'] >= policy['created'],
                'registration postdates run')
    return digest


def inventory(root):
    # Only bounded, known paths; derived result.json is never evidence.
    names = ['attempt.json']
    for group in range(1, GROUPS + 1):
        names.append(f'runs/spine-{group}/initial.json')
        names += [f'runs/spine-{group}/t{turn}{suffix}' for turn in range(1, ROUNDS + 1)
                  for suffix in ('.jsonl', '.stderr', '.process.json', '.meta.json', '.snapshot.json')]
    return {name: sha(bounded(root / name, MAX_LOG_BYTES)) for name in names}


def collect(policy, policy_path):
    cells = {}
    for entry in policy['plan']:
        root, spec = Path(entry['root']), entry['spec']
        before = inventory(root)
        attempt = load(root / 'attempt.json')
        check_registration(policy_path, root, spec, attempt)
        report = score_cell(root, review_sources=True)
        require(report['spec'] == spec, 'changed registered spec')
        require(report['evidence_pass'] and report['hard_quality_pass'], 'hard evidence/tool/behavior failure; never overridable')
        require(len(report['fill_results']) == 230 and report['complete_turns'] == 310, 'absent full run')
        if policy['mode'] == 'live':
            require(all(g['started'] >= attempt['created'] for g in report['groups']), 'replayed/pre-registration process evidence')
        require(inventory(root) == before, 'evidence changed while reading')
        key = spec['model_family'] + '/' + spec['arm']
        cells[key] = dict(root=str(root), report=report, inventory=before, run_sha256=sha(canonical(before)))
    require(set(cells) == {f'{f}/{a}' for f, a in MATRIX}, 'absent full matrix')
    return cells


def sources():
    # Full frozen prompts and fixture texts include earlier parts for historical
    # claims, without copying identities, tool projections or machine outcomes.
    return dict(prompts=validate_contract(), fixtures={str(t): build_log(t)[0] for t in sorted(set(FILL) | {13})})


def blind_case(case_id, commitment, item):
    turn = item['turn']
    return dict(case_id=case_id, run_sha256=commitment, final_sha256=item['final_sha256'],
                final=item['final'], source=str(turn),
                expected={'warn': 3 + turn % 9, 'notice': NOTICE.get(turn, 'NONE')})


def export(policy_path, packet_path, mapping_path):
    require(packet_path.resolve().parent != mapping_path.resolve().parent, 'keep private mapping outside blind packet directory')
    require(not packet_path.exists() and not mapping_path.exists(), 'exclusive new export paths required')
    policy, digest = policy_at(policy_path)
    cells = collect(policy, policy_path)
    cases, mappings = [], []
    for key, cell in cells.items():
        for item in cell['report']['fill_results']:
            case_id, salt = secrets.token_hex(16), secrets.token_hex(32)
            commitment = sha(canonical([salt, cell['run_sha256'], case_id]))
            cases.append(blind_case(case_id, commitment, item))
            mappings.append(dict(case_id=case_id, cell=key, group=item['group'], turn=item['turn'], salt=salt))
    secrets.SystemRandom().shuffle(cases)
    packet = dict(version=VERSION, protocol_sha256=digest, sources=sources(), cases=cases)
    require(len(cases) == 920 and len(canonical(packet)) <= LIMIT, 'complete bounded 920-case packet required')
    write_json(packet_path, packet)
    mapping = dict(version=VERSION, protocol_sha256=digest, packet_sha256=sha(bounded(packet_path)),
                   runs={key: cell['run_sha256'] for key, cell in cells.items()}, cases=mappings)
    write_json(mapping_path, mapping)
    mapping_path.chmod(0o600)
    return {'exported_cases': 920, 'packet_sha256': mapping['packet_sha256'], 'provisional': True}


def span_bytes(spans, text):
    raw, chunks = text.encode('utf-8'), []
    require(isinstance(spans, list) and 1 <= len(spans) <= 32, 'exact evidence spans required')
    previous = -1
    for span in spans:
        exact(span, 'start end sha256')
        start, end = span['start'], span['end']
        require(type(start) is int and type(end) is int and 0 <= start < end <= len(raw) and start >= previous,
                'invalid/overlapping evidence span')
        chunk = raw[start:end]
        require(sha(chunk) == span['sha256'], 'unsubstantiated/stale span hash')
        chunks.append(chunk.decode('utf-8'))
        previous = end
    return '\n'.join(chunks)


def fact_review(value, field, case, fixture):
    exact(value, 'verdict observed answer_spans source_spans rationale')
    require(value['verdict'] in VERDICTS and isinstance(value['rationale'], str) and len(value['rationale'].strip()) >= 12,
            'unsubstantiated semantic rationale')
    answer = span_bytes(value['answer_spans'], case['final'])
    source = span_bytes(value['source_spans'], fixture)
    observed = value['observed']
    if observed is not None:
        if field == 'warn':
            require(type(observed) is int and 0 <= observed <= 1000000 and
                    re.search(r'(?<![\d.])' + str(observed) + r'(?![\d.])', answer), 'unsupported observed WARN value')
        else:
            require(isinstance(observed, str) and observed and observed in answer, 'unsupported observed NOTICE value')
    if value['verdict'] == 'correct':
        require(type(observed) is type(case['expected'][field]) and observed == case['expected'][field], 'wrong facts cannot receive correct verdict')
        if field == 'warn':
            require(all(line in source for line in fixture.splitlines() if line.startswith('WARN ')), 'WARN source evidence incomplete')
        elif observed == 'NONE':
            require(source == fixture, 'NOTICE absence requires full source span')
        else:
            require(observed in source, 'NOTICE source evidence absent')
    return value['verdict']


def verify_record(envelope, case, packet_sha, protocol_sha, registry, fixture):
    exact(envelope, 'record signature')
    record = envelope['record']
    exact(record, 'version case_id packet_sha256 protocol_sha256 run_sha256 final_sha256 reviewer_id signed_off independent full_final_reviewed stage adjudicates warn notice extra')
    require(record['version'] == VERSION and all(record[k] == value for k, value in {
        'case_id': case['case_id'], 'packet_sha256': packet_sha, 'protocol_sha256': protocol_sha,
        'run_sha256': case['run_sha256'], 'final_sha256': case['final_sha256']}.items()), 'stale/replayed review binding')
    require(record['signed_off'] is True and record['independent'] is True and record['full_final_reviewed'] is True,
            'independent full-final sign-off required')
    require(record['reviewer_id'] in registry and record['stage'] in ('initial', 'adjudication'), 'unregistered reviewer/stage')
    require(isinstance(record['adjudicates'], list), 'malformed adjudication references')
    signature = base64.b64decode(envelope['signature'], validate=True)
    require(256 <= len(signature) <= 512, 'malformed signature')
    with tempfile.TemporaryDirectory(prefix='semantic-public-verification-') as tmp:
        key, sig = Path(tmp) / 'public.pem', Path(tmp) / 'signature'
        key.write_text(registry[record['reviewer_id']]['public_key_pem'])
        sig.write_bytes(signature)
        openssl(['dgst', '-sha256', '-verify', str(key), '-signature', str(sig)], canonical(record))
    verdict = tuple(fact_review(record[f], f, case, fixture) for f in ('warn', 'notice'))
    extra = record['extra']
    exact(extra, 'verdict final_spans rationale')
    require(extra['verdict'] in VERDICTS and isinstance(extra['rationale'], str) and len(extra['rationale'].strip()) >= 12,
            'full-response assertion review required')
    require(span_bytes(extra['final_spans'], case['final']) == case['final'], 'review must cover entire final including extra prose')
    return verdict + (extra['verdict'],)


def adjudicate(records, case, packet_sha, protocol_sha, registry, fixture):
    require(isinstance(records, list) and len(records) in (2, 3), 'two reviews; third only for disagreement')
    # Validate every submitted envelope, including extras, before partitioning.
    # An unknown stage must never make an unverified record disappear.
    verified = [verify_record(r, case, packet_sha, protocol_sha, registry, fixture) for r in records]
    require(len({r['record']['reviewer_id'] for r in records}) == len(records), 'reviewers must be distinct')
    initials = [r for r in records if r['record']['stage'] == 'initial']
    thirds = [r for r in records if r['record']['stage'] == 'adjudication']
    require(len(initials) == 2, 'exactly two independent initial reviews required')
    require(all(r['record']['adjudicates'] == [] for r in initials), 'initial reviews cannot reference peer opinions')
    votes = [v for r, v in zip(records, verified) if r['record']['stage'] == 'initial']
    def decision(envelope, vote):
        return vote, tuple(envelope['record'][f]['observed'] for f in ('warn', 'notice'))
    decisions = [decision(r, vote) for r, vote in zip(initials, votes)]
    if decisions[0] == decisions[1]:
        require(not thirds, 'unsolicited/replayed adjudication')
        return votes[0]
    require(len(thirds) == 1, 'disagreement requires third distinct reviewer')
    third = thirds[0]
    require(sorted(third['record']['adjudicates']) == sorted(sha(canonical(r)) for r in initials), 'adjudication must bind both disputed records')
    resolved = verified[records.index(third)]
    require(decision(third, resolved) in decisions and 'unresolved' not in resolved, 'unresolved adjudication')
    return resolved


def apply_verdicts(report, selected):
    """Preserve both denominators; stock errors cannot change candidate facts."""
    require(len(selected) == 230, 'full cell review required')
    counts = {field: sum(v[index] == 'correct' for v in selected.values()) for index, field in enumerate(('warn', 'notice', 'extra'))}
    unresolved = sum('unresolved' in v for v in selected.values())
    correct = sum(v == ('correct',) * 3 for v in selected.values())
    report.update(semantic_verified=True, provisional=bool(unresolved),
                  semantic=dict(planned_fill=230, reviewed=230, correct=correct, incorrect=230-correct-unresolved,
                                unresolved=unresolved, **counts),
                  release_quality_pass=report['evidence_pass'] and report['hard_quality_pass'] and correct == 230)
    for item in report['fill_results']:
        vote = selected[(item['group'], item['turn'])]
        item['warn'], item['notice'], item['extra'] = ({'verdict': v} for v in vote)
        item.pop('final', None)


def verify(policy_path, packet_path, mapping_path, receipts_path):
    policy, digest = policy_at(policy_path)
    registry = {r['reviewer_id']: r for r in policy['reviewers']}
    packet, mapping, receipts = load(packet_path), load(mapping_path), load(receipts_path)
    exact(packet, 'version protocol_sha256 sources cases')
    exact(mapping, 'version protocol_sha256 packet_sha256 runs cases')
    exact(receipts, 'version packet_sha256 cases')
    packet_sha = sha(bounded(packet_path))
    require(all(obj['version'] == VERSION for obj in (packet, mapping, receipts)), 'unsupported review version')
    require(packet['protocol_sha256'] == mapping['protocol_sha256'] == digest and
            mapping['packet_sha256'] == receipts['packet_sha256'] == packet_sha, 'stale packet/protocol')
    require(packet['sources'] == sources(), 'altered/incomplete source evidence')
    require(isinstance(packet['cases'], list) and isinstance(mapping['cases'], list) and
            len(packet['cases']) == len(mapping['cases']) == len(receipts['cases']) == 920, 'full 920-case receipts required')
    cases = {c['case_id']: c for c in packet['cases']}
    require(len(cases) == 920 and set(cases) == set(receipts['cases']), 'missing/duplicate/extra case receipts')
    cells = collect(policy, policy_path)
    require(mapping['runs'] == {k: v['run_sha256'] for k, v in cells.items()}, 'changed/stale full run')
    seen, identities, votes = set(), set(), {}
    for row in mapping['cases']:
        exact(row, 'case_id cell group turn salt')
        cid, key = row['case_id'], row['cell']
        require(isinstance(cid, str) and re.fullmatch(r'[0-9a-f]{32}', cid) and
                isinstance(row['salt'], str) and re.fullmatch(r'[0-9a-f]{64}', row['salt']), 'malformed opaque case identity')
        require(cid in cases and cid not in seen and key in cells, 'duplicate/replayed case mapping')
        require(type(row['group']) is int and type(row['turn']) is int, 'malformed case ordinal')
        identity = (key, row['group'], row['turn'])
        require(identity not in identities, 'duplicate/replayed run final')
        identities.add(identity)
        seen.add(cid)
        item = next((i for i in cells[key]['report']['fill_results'] if (i['group'], i['turn']) == identity[1:]), None)
        require(item is not None, 'mapped final absent from complete run')
        commitment = sha(canonical([row['salt'], cells[key]['run_sha256'], cid]))
        require(cases[cid] == blind_case(cid, commitment, item), 'altered full final/run binding or expected values')
        votes[identity] = adjudicate(receipts['cases'][cid], cases[cid], packet_sha, digest, registry,
                                    packet['sources']['fixtures'][str(row['turn'])])
    require(identities == {(k, g, t) for k in cells for g in range(1, 11) for t in FILL}, 'incomplete full matrix')
    reports = {}
    for key, cell in cells.items():
        report = cell['report']
        selected = {identity[1:]: vote for identity, vote in votes.items() if identity[0] == key}
        apply_verdicts(report, selected)
        reports[key] = report
    comparisons = {f: compare(reports[f + '/candidate'], reports[f + '/stock']) for f in ('ds', 'glm')}
    resolved = all(not r['provisional'] for r in reports.values())
    passed = resolved and all(r['release_quality_pass'] for k, r in reports.items() if k.endswith('/candidate'))
    paired = passed and all(c['matched_collection_pass'] for c in comparisons.values())
    return dict(version=VERSION, mode=policy['mode'], packet_sha256=packet_sha,
                semantic_collection_pass=passed, paired_collection_pass=paired,
                live_collection_pass=paired and policy['mode'] == 'live', provisional=not resolved,
                release_pass=False, cells=reports, comparisons=comparisons,
                remaining_release_evidence=['independent preregistered holdout', 'runtime/cache release gates'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest='action', required=True)
    p = subs.add_parser('register')
    p.add_argument('--plan', type=Path, required=True)
    p.add_argument('--reviewers', type=Path, required=True)
    p.add_argument('--synthetic', action='store_true')
    p.add_argument('--output', type=Path, required=True)
    for action in ('export', 'verify'):
        p = subs.add_parser(action)
        for name in ('registration', 'packet', 'mapping'):
            p.add_argument('--' + name, type=Path, required=True)
        if action == 'verify':
            p.add_argument('--receipts', type=Path, required=True)
            p.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.action == 'register':
            register(load(args.plan), load(args.reviewers), args.output, synthetic=args.synthetic)
            result = {'registered': True, 'registration_sha256': sha(bounded(args.output)), 'provisional': True}
        elif args.action == 'export':
            result = export(args.registration, args.packet, args.mapping)
        else:
            result = verify(args.registration, args.packet, args.mapping, args.receipts)
            write_json(args.output, result)
            print(json.dumps({k: result[k] for k in ('semantic_collection_pass', 'paired_collection_pass', 'live_collection_pass', 'provisional', 'release_pass')}))
            return 0 if result['paired_collection_pass'] else 1
        print(json.dumps(result))
        return 0
    except (OSError, ValueError, KeyError, TypeError, AttributeError, StopIteration, subprocess.SubprocessError):
        # Do not echo model text, filesystem payloads or public-key internals.
        print(json.dumps({'semantic_collection_pass': False, 'provisional': True, 'error': 'invalid or incomplete review evidence'}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
