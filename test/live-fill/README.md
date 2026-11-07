# live-fill 1.1.2 correctness contract

`manifest.json` is the single versioned definition (`live-fill-1.1.2-v1`). Each
model/arm has **10 groups × 31 turns = 310 turns, exactly 230 FILL answers,
230 WARN counts and 230 NOTICE answers**. There is no smaller release mode.
`SPINE_COUNT` is rejected. Missing evidence retains these denominators and fails.
This directory changes the harness only; it does not prove runtime compaction,
PR #26/#27, Windows behavior, or release readiness.

For the first release matrix, [SEMANTIC.md](SEMANTIC.md) governs preregistration,
the full 920-final blind packet and signed independent review. FILL heuristics
are diagnostics. Collection results are provisional without verified receipts;
live initialization requires `--preregistration` before any model execution.

Run the offline gate from the repository root (Python 3.9+, POSIX, standard
library plus local OpenSSL for semantic signature verification):

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s test/live-fill -p 'test_*.py' -v
```

The root package exposes this as `npm run test:live-gate`.
Tests invoke only the local deterministic fake DSH;
they do not load profiles, access credentials, connect to a model, or read old
logs. The end-to-end test executes 310 fake subprocesses through `run.py all`,
then the real scorer CLI. Other tests cover malformed/missing events, missing
turns/usage, empty finals, substring/ambiguous/contradictory answers, wrong files,
unpaired/error tools, nonzero exits, transport errors/retries, session reset,
timeout child cleanup, stale inputs/results, late-turn rubric, cache writes and
comparison budgets.

## Frozen inputs and fixture correction

`prompts.json` remains byte-for-byte unchanged:
`6b7e1d54d72af05533505905419b3b92940eae27faad52e899a1eb85a69e7d29`.
The runner reads it and verifies its hash; it never invokes `prompts.py` or
rewrites repository inputs. `prompts.py` is retained only as historical source.

The original 27 non-oracle fixture files have aggregate inventory SHA256
`c2e032ec2e217bbf89e8949b59e29d8c73ebad932a137160187e1ee7c0b0a1e5`
(SHA256 of UTF-8 `json.dumps({relative_path: file_sha256}, sort_keys=True)`).
The offline test verifies this against a frozen hash independently obtained
from d9391c5's generator. All those bytes remain equivalent. The sole content
addition is `part13.log`: the original `HIDDEN[13]` entry was never generated
because turn 13 is not FILL. Its line 301 is `INFO hidden batch_size 250`,
consistent with frozen prompt 13's `batch_size=250`. Prompt 13 does not request
reading that log: the batch value is also explicitly available from the update;
we do not claim the added file was observed. No prompts or FILL answers change.

`truth.json` is removed from fixture generation. Expected answers live in the
scorer/manifest outside the model cwd. Logs, inventories, snapshots and scoring
reports also stay outside each model cwd. This is oracle placement, not an OS
sandbox guarantee against a model deliberately traversing outside its cwd.
Never place this source directory, the attempt root, or a truth artifact inside
that cwd or expose their paths via model environment variables.

## Evidence and exit behavior

A new root is created exclusively; a pre-existing root is refused, even if empty.
Each group/work directory and each turn log, process record, metadata record,
snapshot and final report is created exclusively. Failed attempts are retained;
retry with an entirely new root. Nothing is resumed, concatenated, overwritten,
or selected from another attempt. No `DONE`/`ALL_DONE` is written. `finish` writes
`result.json` with a computed gate result; a failing report is not completion.

Every turn records start/end wall time, PID/process group, requested/observed
session, CLI exit, timeout/termination/cleanup, stdout/stderr hashes, parser
errors and snapshot hash. Timeout defaults to 180 seconds per turn. The runner
creates a dedicated POSIX process group and terminates/kills that group on
normal exit, timeout, interruption or failure, cleaning task-owned children.
It never signals a pre-existing process/group. Detached daemons that deliberately
escape that group are outside the supported runner contract; profiles/tools
must not spawn them. Non-POSIX hosts are refused until cleanup is implemented
and tested there. Output and workspace snapshots have explicit bounds.

The runner validates each turn before starting the next and stops immediately
on infrastructure failure: nonzero CLI, timeout, error events, transport/retry
diagnostics, missing/invalid usage, empty/missing final, missing/mismatched
session, broken JSON/event ordering/tool pairing, failed tool execution, or no
successful correlated read of the requested FILL file. Failed attempt logs and
process metadata survive. There are no automatic retries. Quality errors are
retained and scored across the fixed task set. The exact observed rc.2
edit/write read-before-write rejection is a model validation/quality error,
counted in `model_tool_errors`, rather than an infrastructure failure. It still
fails candidate quality; successful follow-ups retain real evidence and usage.
Unknown errors and actual CLI/transport failures remain infrastructure failures.
See [the pre-run grammar decisions](GRAMMAR.md).

The scorer requires the exact current code/input fingerprints, original initial
fixture inventory, complete 310-turn evidence, sequential turns in each group,
and distinct group session IDs. It checks process and snapshot hashes instead
of trusting markers or an old score file. A candidate exits nonzero for any
quality or evidence failure. Stock records wrong answers and failed behavior
assertions on the same denominators, while incomplete/corrupt stock evidence
still exits nonzero. Stock correctness is never used to excuse candidate errors.

## Answer and behavior rubric (frozen before any live run)

The pre-run grammar extracts explicit answer fields from Chinese/English
Markdown bullets, bold labels, fences, simple two-column tables and labeled
sections. Supporting prose and supplemental log rows supply no missing fields.
Wrong, conflicting or uncertain current answers still fail. Grammar decisions
and bounded historical regression findings are recorded in [GRAMMAR.md](GRAMMAR.md)
before any new candidate runs.

FILL requires one labeled integer WARN count and one exact NOTICE line or NONE:

```text
WARN: 5
NONE
```

```text
WARN 条数：7
NOTICE cache layer pinned to sqlite
```

`WARN count`, `WARN 数量`, `WARN 条数` and `WARN` are supported labels. `NOTICE:
NONE` is equivalent to `NONE`. `NOTICE 原文行` and `NOTICE original line` may
introduce the answer on the same or following line, with line/count annotations.
Counts are parsed as complete integers, never
numeric substrings; a filename, `15`/`50` for `5`, guesses, negation, multiple
answers or contradictory NONE/NOTICE fail. NOTICE text must match the unique
entire expected original line, with no suffix. Clearly historical named-part
sequences are context; explicit current labels override that exemption.
Supplemental citations cannot add false NOTICE lines or conflicting counts.
An unrelated tool does not prove
a read: the scorer pairs real `callId`s, validates the requested and returned
path, successful result and numbered fixture text. Built-in `read`, an exact
`bash` `cat <expected-path>`, and built-in `grep` are supported. Grep accepts only
`{path, pattern}` for the exact fixture and patterns `WARN`, `NOTICE` or
`(?i)warn|notice`, without evaluating arbitrary regexes. Its count, basename
header and every numbered row must match the complete frozen search output;
no-match-only output is not read proof. Truncated grep must be an exact prefix
of that output containing at least one complete matching row. Opaque shell
programs do not count as read proof. Successful bounded JSON projection
truncation is recorded, not confused with a failed read or transport loss;
usable path/content evidence is still required.

Turns 28–31 use `manifest.json`'s field/value rubric and actual per-turn workspace
snapshots, rather than later disk state. Chinese and English field aliases are
listed there, with presentation-only synonyms in `rubric.py`. Fields use
`label: value`, labeled lists, two-column tables or a field heading followed by
its value, one unique assertion per field. Supporting prose supplies no missing
facts; explicit contradictions still fail. Combined error-code/shard fields
must contain E1729 and 0x3F; exit 3 never implies E1729. Conflicting values,
missing facts and uncertainty fail. The example
answers in `synthetic.py` document accepted formatting, not alternate prompts.

- **28:** zero tools, score the final response only. Do not require disk
  `recall.md`: the prompt explicitly forbids tools. Require SQLite, current port
  9310, 37/min, 0.875, tests/test_ledger.py, Okafor, Bluebird, USD two decimals,
  eu-west-3, @mirela, LED-4471, $412/month, E1729, 0x3F.
- **29:** require `hidden.md` with exact shard 9f2c71ab, rate 37/min, threshold
  0.875, batch 250, region eu-west-3, ticket LED-4471 and a labeled source
  explanation starting with memory/backup (or 记忆/备份). No tools may reread
  part logs from this turn onward; check.sh may never run again. Saved backups
  may be read. A final claim without the artifact fails.
- **30:** require actual `conf/settings.local.toml` with flat keys port=9310,
  cache="sqlite", ratelimit_per_minute=37, alert_threshold=0.875,
  log_retention_days=14, max_workers=6, ledger_strict=true, batch_size=250,
  region="eu-west-3", monthly_budget_usd=412. These freeze a representation of
  current decisions before measurement. Only flat primitive TOML assignments
  and comments are accepted. Require `docs/NOTES.md` with a LED-4471 title,
  Bluebird and `Reviewer: Okafor`. No unrequested invented (a)–(d) subtasks or
  additional plan filename is assumed from the underspecified plan text.
- **31:** require `docs/STATUS.md`, title `# LED-4471 Bluebird status` (or the
  documented rubric title variants), @mirela, unresolved/still failing check,
  E1729, 0x3F, test path, reviewer and current port. Config/notes must still
  satisfy turn 30. A claimed successful check contradicts unchanged check.sh.

Global constraints: check.sh executes once in turn 1 with the exact original
diagnostic and exit 3 evidence, never subsequently. Normal stdout/stderr
redirections and audited `EXIT_CODE=$?` / `code=$?` capture-and-diagnostic forms
require paired matching results in the fixture cwd. Mere echo/cat/mention is
not execution; pipelines, opaque wrappers, ambiguous executions and repeats
are rejected. No rm, .env access (including built-in grep's `path`), vendor artifacts,
Makefile, protected old config/test/check changes; each new .py begins with
`# owner: team-kestrel`. Original logs remain intact (moving them into trash/
after turn 29 is permitted). The rubric checks these observable tools and file
side effects through `command_audit.py`, a bounded, inert, fail-closed audit.
Quoted executables and literal shell wrappers are normalized; rm, forbidden
pandas/tenacity imports/use, CSV regex/split parsing, Makefile use and attempted
protected-path writes fail. Literal cat/head/tail/wc/grep/rg reads, print-only sed,
the literal awk program `{print $1}` (with optional horizontal whitespace),
sort with only `-n`/`-r`/`-rn`/`-nr`, and uniq with optional `-c` have bounded
support. Uniq accepts at most one input filename: its second filename writes
output and is rejected. Awk options, assignments, other programs and CSV parsing
receive no exception. Simple input redirections and pipes carry audited source
paths into consumers, so CSV filters still fail through stdin; unknown stdin
remains opaque. Literal/status printf output is supported, but assignment/control
forms (`-v`, `%n`) fail. Status expansion is limited to output-only printf and
`echo "identifier=$?"`; other variable/substitution forms still fail. Copies and
moves with unproven executable identity remain opaque outside the verified
archive exception, as does command resolution outside trusted system paths.
Read-only standard-library Python/CSV and structured read/grep/write/edit remain
supported. Bash accepts optional nonblank string `description` as UI metadata
only; it grants no execution permission. Unknown or unsupported input keys fail.
Dynamic expansion, arbitrary scripts/interpreters, unsupported
options/code/tool schemas and ambiguous behavior hard-fail as requiring command
review. Finals-only semantic receipts cannot waive that failure; no review
override is implemented. This is an accepted language, not a general shell
sandbox or proof about arbitrary generated programs.

DSH glob accepts `pattern` and optional `path`. It enumerates names through
fixed `rg --files` argv; it never provides content-read evidence. The bounded
positive pattern language admits ASCII letters, digits, `_./-*?`, with no `..`
components; explicit `.env` and prohibited Makefile paths still fail. Listing
part-log names after turn 28 is permitted; content reads remain forbidden.
`todo_write` accepts only `todos`, a list of exact `{content,status}` objects
with nonblank unique trimmed content and `pending`/`in_progress`/`completed`
statuses. Todo content is session metadata, never executable code or file access.
Both tools remain forbidden at turn 28.

Legitimate forms outside this audit subset still require review, including
awk programs beyond that field projection, additional sort/uniq options, glob
brace/class/negated patterns, grep's optional path/include forms, and Bash
timeout/background/escalation controls. These opaque cases are distinct from
explicit policy violations; neither can receive a release pass or semantic waiver.
Input compatibility also does not waive result evidence failures: a legitimate
no-match grep exit 1 still receives the existing `tool command failed` error.

The late-turn log rule permits only audited non-reading archival moves in turns
30–31: plain `mv [--] partN.log ... trash/` or the exact `part*.log` glob,
optionally preceded by `mkdir -p trash;` (or `&&`). Paths may start with `./`;
`trash` and `trash/` name the same sole permitted destination. Each selected
source must be absent and its original SHA256 must match `trash/<name>` in that
turn's snapshot. Bash inputs are limited to `command`, optional nonblank string
`description` metadata, and optional `workdir`, which must resolve to the recorded
fixture workspace. Quoting, other expansions,
wrappers, redirects, pipes and additional commands receive no exemption. Reads
of either original or archived logs still fail, as do turn 29 moves and all
turn 28 tool calls. This changes no prompts, counts, denominators or budgets.

## DSH schema verification

Read-only inspection on this implementation host verified installed
`@deepseek-ai/dsh` / `dsh-headless` **0.2.0-rc.2**, not a guessed synthetic schema:

- `dsh-headless/lib/json-stream-BA-F3lfb.js` SHA256
  `b6ede8da01119f5caf4baa8051ce8bcd8b956b5b163cf58af91d583b80028c0c`
- `dsh-tool-fs/lib/index.js` SHA256
  `66742231de99695b98400cdbc7bcf47b8ef2bf24600cf86f66bb35591981427f`
- `dsh-tool-bash/lib/index.js` SHA256
  `0c63a09e4b80ec22db256eac4ecab6f7de3a342e16ec590348a40c5f356eff1a`
- `dsh-tool-fs-search/lib/index.js` SHA256
  `7210e7aa239021051301e4b1411b74fbc85b239220d1e5ea342d76cbca5eeae9`
- `dsh-tool-todo/lib/index.js` SHA256
  `6baad8bf8e53647319b408cbab0c8c13c0693f65d20b779484c4436f47a6a11b`
- `dsh-llm/lib/types/types.d.ts` SHA256
  `6b7f5b81f6b680b1bf33346950f43e1cb760182f14d54cb71f5f0c1f2ce20352`
- `dsh-llm-pi-ai/lib/index.js` SHA256
  `d46dbc30aeb3414190000e6f8aeaaf994246b5e5c651de07639f4a7e92de37ef`

The exact local installation root is
`/Users/lynn/.nvm/versions/node/v22.22.2/lib/node_modules/@deepseek-ai/dsh`;
these dependency paths are under its `node_modules/@deepseek-ai/` directory.
`dsh-llm/lib/types/types.d.ts:153–174` defines `TokenUsage`: uncached input,
cache read and cache write are disjoint; authoritative `totalTokens` includes
aggregate prompt plus output. `dsh-llm-pi-ai/lib/index.js:1369–1377` maps pi-ai
usage and explicitly omits zero cache fields. Reasoning is folded into output.

The emitter projects `session {sessionId,cwd}`, `status` turn/step start/end,
`tool_call {callId,tool,input}`, `tool_result {callId,status,result}`, `text`,
`thinking`, `error`, and terminal `final {text}`. Tool arguments must be a usable
object. Results use `completed`/`error`, not invented `isError`/`exitCode` fields.
`read` takes `file_path`; its text envelope contains path and numbered lines.
Bash nonzero process exits are **completed tool results** with textual exit
markers; the expected turn-1 exit 3 is a domain failure, not infra failure.

Successful turn-end reason is `{kind:"completed"}`. JSON emits no per-request
finish reason, provider/route identity, retry counter, cut marker or surface
meter. Step usage sums all retry attempts; an attempt missing usage makes the
step omit usage. Optional counters stay unknown unless an omitted cache bucket
is proved zero by the derivation below. An absent entire step usage fails the
evidence gate; unresolved cache buckets block cache comparability. Unknown per-request
finish reasons/retries remain explicit nulls. Stderr transport/retry evidence
fails a clean attempt. Silent retry absence cannot be proved by this projection.

The emitter bounds non-final strings at 8 KiB and events at 32 KiB with
`truncated:true`; final is lossless. Text/thinking/result truncation may be a
known projection limit. Truncated essential structured fields are rejected.
Recheck this adapter before approving any other DSH schema/version.

## Metrics, comparability and historical boundary

Headline first-step ratio is preserved exactly:
`sum(first cacheRead)/(sum(first cacheRead)+sum(first input))`.
All-steps uses the same formula across every step, separately. These are token
weighted, not means of percentages or prefix-byte similarity. Input is uncached
input. Collect input, output, cacheRead **and cacheWrite** separately. The actual
prompt cache-read ratio is `read/(read+input+write)`, and is reported separately,
particularly when cacheWrite is nonzero. Partial metrics are explicitly marked
and cannot release.

Zero normalization applies only to the verified rc.2 disjoint accounting
contract; scoring also requires `usage_semantics="disjoint-input-read-write"`.
Required input/output and every present cache/total/reasoning counter must be
nonnegative integers (booleans are rejected). On a copy of each usage record,
compute `known = inputTokens + outputTokens + sum(present cache buckets)` and
`residual = totalTokens - known`, using only a present authoritative total:

- With residual **zero**, nonnegativity forces every omitted cache bucket to
  zero. Preserve all explicit counters, including explicit nonzero cache values.
- With a **positive** residual and an omitted cache bucket, retain every omitted
  bucket as unknown. Do not allocate the residual or infer a positive cache value.
- With no total, omitted buckets stay unknown. Never synthesize totalTokens.
- A **negative** residual, invalid counter, or nonzero residual when both cache
  buckets are explicit fails evidence. `reasoningTokens` is already in output
  and is never added to `known`.

Raw JSONL files and parsed raw usage are unchanged. `usage_zero_proofs` in the
cell report logs each proof's group, turn, step, derived fields, authoritative
total, known sum and zero residual. Both `first_step` and `all_steps` separately
report `usage_normalization`: `proven_zero_steps` counts records with any proof;
`proven_zero_fields`, `explicit_fields` and `unknown_fields` count each cache
field's provenance, separately from token sums. A record with two proved zeros
counts once as a proved step and once for each field. Any unresolved bucket
keeps that aggregate bucket unknown. Comparison output preserves both arms'
metrics and proof counts under `usage_metrics`; budgets and formulas are unchanged.
This proof does not establish answer correctness, missing-turn coverage, retries,
or runtime release readiness, and does not make historical logs current evidence.

`t27_last_request_totalTokens` and `t31_last_request_totalTokens` are the final
step's JSON usage.totalTokens at those turns, **not actual surface/tokenMeter**.
The JSON value aggregates retries when present, so a true single-request claim
also needs independent retry evidence. `totalTokens` includes prompt and output.
Group elapsed, sum of group elapsed, and overall time span are distinct fields;
none is named cutter time. `saved`/`rewriteCharged` are not billed token savings.

The comparison command recomputes both cells. It requires complete matching
current harness, model, family, route, host, dependency versions, parameters,
package hash, usage semantics and cache-warmup policy; isolated homes/profiles/
shadow dirs; and predeclared candidate/stock then stock/candidate alternating
group order with no within-pair overlap. A convenient serial `all` run of each
arm independently does not establish this balanced matrix. Budgets are frozen:
first-step and all-step candidate ratios >= stock minus **0.5 percentage points**,
all-step uncached input <= stock **105%**, DS first-step additionally >= **98.23%**.
The DS historical floor is not applied to GLM. No denominator or budget changes
after seeing actual results.

`cache_comparison_pass` covers those numeric/comparability checks only.
`cache_release_pass` remains false: independent provider/route/retry accounting,
extra summary-request cost, cut/post-cut request evidence and stock plugin
absence/threshold controls are separate runtime release gates. JSON cannot
prove them. Do not promote an answer gate or numeric comparison into a full
cache/release PASS.

Historical facts below are from `../release-112/astra-plan.md` §§4/6 and
`astra-audit.md`, not old logs re-read or new measurements in this changeset:

- 184 was the old 8-group FILL target, not a verified new measured score.
  No historical measured answer-correctness count is independently recomputed
  here. Existing DONE/NATIVE_FINISHED is not answer or completeness proof.
- 98.23% and 35963 are old DS 8-group metrics; 35963 was t27 last-step totalTokens,
  not end-of-turn-31 surface. Neither establishes current cache comparability.
- Astra reports 73 GLM plugin connection failures without valid usage, old
  stock only 7 DS / 4 GLM groups, and 211 / 119 usage-bearing stock turns.
  Those are coverage/usage counts, not answer scores. They cannot be used as
  this version's complete matched stock baseline. Historical recovery is separate.

## Future authorized execution (not part of the offline command)

The harness does not provision/change profiles or credentials. Supply an already
reviewed isolated profile, approved route, fresh home/shadow and candidate/stock
runtime provenance through a non-secret JSON spec with exactly these keys:

```json
{
  "arm": "candidate",
  "model_family": "ds",
  "model": "APPROVED_EXACT_MODEL",
  "route": "APPROVED_ROUTE_ID",
  "host": "dsh 0.2.0-rc.2 / runtime build identity",
  "dependencies": {"dsh": "0.2.0-rc.2", "adapter": "EXACT_VERSION"},
  "parameters": {"temperature": 0, "window": 1000000, "tools": "EXACT_TOOLSET"},
  "cache_warmup": "FROZEN_POLICY",
  "usage_semantics": "disjoint-input-read-write",
  "package_sha256": "REPLACE_WITH_64_LOWERCASE_HEX_DIGITS_OF_CANDIDATE_TARBALL",
  "dsh_home": "/trusted/live112/ds-candidate/home",
  "profile": "ds-candidate",
  "shadow_dir": "/trusted/live112/ds-candidate/shadow"
}
```

Record exact parameters and dependency versions, not the placeholders. Stock
uses the same candidate tarball hash as comparison identity but does not load
it. Profile/plugin absence and declared route are not independently inferred
from this spec; verify them in the separate runtime gate. Candidate is never
stock fallback. Isolate all four model/arm roots; do not reuse historical homes.
For a balanced matrix, initialize both cells, run whole groups in the manifest's
predeclared A/B, B/A order, and finish each cell after all 10 groups. The scripts
operate one cell/group at a time and never schedule paid calls on their own.

```bash
python3 test/live-fill/run.py init --root "$LIVE_ROOT" --spec "$LIVE_SPEC" --preregistration "$REGISTRATION"
bash test/live-fill/run_one.sh 1
# Repeat groups in the registered two-arm order, then:
python3 test/live-fill/run.py finish --root "$LIVE_ROOT"
python3 test/live-fill/score.py --root "$CANDIDATE_ROOT" --stock-root "$STOCK_ROOT"
```

`run_all.sh` is the serial single-cell convenience entrypoint, requiring a new
`LIVE_ROOT` and `LIVE_SPEC`. Do not use it as evidence of balanced matrix order.
No live calls were made while implementing/testing this contract.
