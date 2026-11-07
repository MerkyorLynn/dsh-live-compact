# Preregistered semantic review — first 1.1.2 matrix

This protocol supersedes the FILL heuristic as release semantic authority.
Freeze it before fresh paid collection. It neither authorizes calls nor proves
release readiness. No historical output becomes current evidence. The separate
independent preregistered holdout remains required and is outside this change.

## Freeze before collection

`semantic.py` is offline, uses Python's standard library plus local OpenSSL
(RSA 2048–4096, PKCS#1 v1.5/SHA256 verification), and never signs, calls a model,
loads a profile, reads a private key, or accesses a service. Only the tests create
ephemeral signing keys in temporary directories. Reviewer private keys stay with
the reviewers; obtain their public keys and authenticate their identities and
independence before registering. Authors cannot appoint aliases of themselves.

Create a private plan JSON array with exactly four entries:
`{"root":"/absolute/new/run", "spec":{...exact run.py spec...}}`, one each for
DS/candidate, DS/stock, GLM/candidate, GLM/stock. Specs, homes, profiles, routes,
parameters and A/B then B/A group order retain the existing contract. All four
roots must be absent at registration. Registration rejects known paired spec
mismatches before collection, shared profiles across any cells, and overlapping
or aliased root/home/shadow paths across cells. Each path must be canonical.
Both arms of each family must match model, route, host, dependencies, parameters,
warmup, usage semantics and package hash. Re-reading a registration enforces the
same static checks. Create a reviewer JSON array of 3–12 entries:

```json
{
  "reviewer_id": "reviewer-A",
  "public_key_pem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n",
  "independence": "independent-of-authors-and-other-reviewers"
}
```

```sh
python3 test/live-fill/semantic.py register --plan "$PLAN" --reviewers "$REVIEWERS" --output "$REGISTRATION"
python3 test/live-fill/run.py init --root "$LIVE_ROOT" --spec "$LIVE_SPEC" --preregistration "$REGISTRATION"
```

Keep the registration's original SHA256 in the preregistration record held by the
independent coordinator. Registration freezes all four roots/specs, reviewer
keys, policy and harness/input hashes, including this document and `rubric.py`.
Changes require a new registration **before** new runs, never retrospective
relabeling. Registration is checked before root creation and before each group;
run evidence binds its path/hash and creation time. This local timestamp is not
a trusted external timestamp or proof against an operator fabricating a whole
run; the coordinator's prior freeze and runtime provenance remain necessary.
No existing/failing run is resumed. Continue using the existing group commands
and balanced order. `--synthetic` registers only specs marked `synthetic-only` /
`offline-fake`; that registration can execute only `fake_dsh.py` and verification
labels its output synthetic. It is never live release evidence.

## Full blind export

After all four runs, export to two new paths in **different directories**:

```sh
python3 test/live-fill/semantic.py export --registration "$REGISTRATION" --packet "$BLIND_DIR/packet.json" --mapping "$PRIVATE_DIR/mapping.json"
```

Export rechecks every required artifact of all 4 × 310 turns and requires the
exact 4 × 230 = **920 FILL** finals, full evidence and non-FILL/tool/behavior gates.
It reads only known evidence paths; each file is bounded to 16 MiB and packet,
map and receipt files to 64 MiB. Missing, stale, malformed or failing evidence
blocks export. Nothing is sampled or selected by heuristic result.

Give reviewers **only** `packet.json`. Cases are randomly shuffled, with random
opaque case IDs, exact unmodified final text and UTF-8 SHA256, exact expected
WARN/NOTICE values, and full frozen fixture texts/prompts (including prior parts
for historical claims). A per-case salted `run_sha256` commitment binds the full
run inventory without exposing which other cases share a run. No model, arm,
group, session, process, cache, tool quality or machine-heuristic outcome is
exported. Original final text is never redacted, normalized or rewritten; any
self-identifying prose in a response is an intrinsic blindness limitation.
Source turn numbers are required to judge facts, and carry no arm identity.

The private mode-0600 mapping holds roots via registration, model/arm, group/turn,
salts and complete run hashes. Never give it, scorer reports, registration plan
or receipts from another reviewer to either initial reviewer. Keep original raw
streams and metadata privately; the public packet contains their exact final
text, not raw logs with identity/cache metadata. Run hashes cover attempt,
inventories, all 310 streams, stderr, process, metadata and snapshots, excluding
derived `result.json`. The verifier re-fetches this local evidence, never trusts
a previously computed PASS, and checks a before/after inventory for mutation.

## Semantic standard and receipt format

Every case needs two **distinct preregistered reviewers**, working
independently, signing off after reading the **entire** final and necessary
source. When using model reviewers, the coordinator records each isolated
session and its model, supplies only the blind packet and frozen rules,
and signs only the review returned by that registered session. Recognized syntax still needs both reviews. Require exactly one clearly
labeled, unique, definite WARN integer and the exact NOTICE original or NONE.
Presentation wrappers, truthful explanation/repetition, and correctly attributed
historical context are acceptable. Missing answers, wrong facts, alternatives
(`5 or 6`, `0 (or 1)`), fabricated originals, conflicting trailing assertions,
current-answer uncertainty, or unsupported extra claims fail. A correct opening
answer never excuses a contradictory tail. Unverifiable claims are unresolved.

Receipts are a JSON object with `version: "semantic-review-112-v1"`, the exact
packet file's `packet_sha256`, and `cases: {case_id: [envelope, envelope]}` for
**all 920 cases**. An envelope is `{"record": {...}, "signature": "BASE64"}`.
No ignored keys, duplicate JSON keys or NaN are accepted. A record has exactly:

```text
version, case_id, packet_sha256, protocol_sha256, run_sha256, final_sha256,
reviewer_id, signed_off=true, independent=true, full_final_reviewed=true,
stage="initial", adjudicates=[], warn, notice, extra
```

Copy binding hashes from the packet/case. `protocol_sha256` hashes the exact
registration file; `run_sha256` is the case's opaque commitment to that same
run. `warn` and `notice` each have exactly:

```text
verdict: "correct" | "incorrect" | "unresolved"
observed: integer (WARN) | string (NOTICE, including "NONE") | null (unresolved/missing)
answer_spans: [{start, end, sha256}, ...]
source_spans: [{start, end, sha256}, ...]
rationale: substantive explanation (minimum 12 non-edge-whitespace characters)
```

Offsets are half-open **UTF-8 byte offsets** into exact final / current source
fixture text; span hashes cover those exact bytes. Each list has 1–32 nonempty,
ordered, non-overlapping spans on valid UTF-8 boundaries. For a correct WARN,
source spans must include every original WARN line; a correct NOTICE must cite
its exact source line. NONE requires a whole-fixture source span to establish
absence. Fact values must be supported in cited answer bytes and match exact
expected values to receive `correct`. Null cannot be correct. Missing answers
can cite the whole final and explain the omission. These checks substantiate
the receipt; they do not infer natural-language semantics automatically.

`extra` has exactly `verdict`, `final_spans`, `rationale`. Its spans must cover
the **entire final** exactly, and its rationale must explain the review of all
additional assertions, historical attribution, duplicates/conflicts and
uncertainty. It cannot ignore text without WARN/NOTICE keywords. Every field
verdict is reviewed separately; a WARN issue is not counted as a NOTICE error.

Sign the UTF-8 bytes of Python `json.dumps(record, ensure_ascii=False,
sort_keys=True, separators=(',', ':'), allow_nan=False)` using RSA PKCS#1 v1.5 /
SHA256, then base64 the signature without whitespace. The verifier uses only
the frozen public key; it does not accept a supplied replacement key or an
unsigned boolean. Reviewers must retain their separate review records.

If either initial fact/extra judgment disagrees, keep both records and obtain
one third **distinct** registered reviewer. That reviewer first reads the full
case independently, then examines the dispute and signs `stage="adjudication"`
with `adjudicates` equal to both initial envelope SHA256s (canonical JSON bytes,
same serialization as above). Its evidence and rationale must address the
dispute. A resolved decision must agree with one initial decision in all fields;
unresolved or a third different decision blocks. No third vote is accepted for
two agreeing initials. Never delete an inconvenient review or ask for votes
until a case passes. The verifier cannot prove that two reviewers acted
independently, that rationale is honest, or that prose has no hidden semantic
contradiction; authenticated independent review, not signatures alone, supplies
that evidence. This is not a machine correctness oracle.

## Verify and interpret

```sh
python3 test/live-fill/semantic.py verify --registration "$REGISTRATION" --packet "$BLIND_DIR/packet.json" --mapping "$PRIVATE_DIR/mapping.json" --receipts "$PRIVATE_DIR/receipts.json" --output "$PRIVATE_DIR/verified.json"
```

Verification refuses missing/extra/replayed cases, absent full runs, stale hashes,
invalid signatures, duplicate reviewer IDs/keys, unsupported spans/values,
unsigned sign-offs, and hard evidence/tool/behavior failures. Even unanimously
correct semantic receipts **cannot** repair an invalid correlated read, nonzero
shell/process exit, tool error, behavior violation, missing turn, or stale run.
All failures/missing/unresolved retain **310 turns / 230 FILL per arm**.
Stock semantic errors are reported on the same 230 denominator and never excuse
a candidate error. An incorrect candidate fails `semantic_collection_pass`.
Agreeing unresolved receipts produce a failing, provisional result.
Every submitted envelope is fully verified before partitioning by its recognized
stage; malformed or unknown-stage extras cannot disappear from adjudication.

The scorer keeps legacy `quality_errors`, `gate_pass`, heuristic correctness
counts and standalone CLI exit behavior as **collection diagnostics**.
`fill_machine_errors`/`fill_results[].machine` separate heuristic/syntax issues
from `evidence_errors` and `tool_behavior_errors`. Noncanonical/unknown text is
`REVIEW`, never an automatic semantic failure or success. `warn` and `notice`
semantic fields remain null until verified; review counts live under `semantic`.
Heuristic errors may remain visible alongside a verified correct semantic verdict.
Without verified receipts every `score.py`/`run.py` result is explicitly
`provisional=true`, `semantic_verified=false`, `release_quality_pass=false`.
The standalone legacy `gate_pass` never means release approval.

`cache_comparison_pass` remains the legacy numeric/comparability diagnostic;
matched CLI exits nonzero without verified receipts. Only the verifier produces
`matched_collection_pass` after semantic verification. Existing cache budgets
**0.005, 1.05, DS 0.9823**, isolation, process, behavior and valid correlated-read
rules are unchanged. `semantic_collection_pass` reports semantic candidate
success only. Aggregate `paired_collection_pass` additionally requires **both**
DS and GLM `matched_collection_pass` results; `live_collection_pass` requires
that paired success and a live registration. Verifier CLI exit 0 requires paired
success (including for synthetic test matrices). A semantic-only PASS cannot
waive isolation/comparability failures. `cache_release_pass` and overall `release_pass` stay false:
the independent holdout, 20k small-cut controls, cut/post-cut requests, retry and
extra-request costs, runtime provenance and stock plugin absence remain separate
release evidence. Do not treat a synthetic verification as release collection.
