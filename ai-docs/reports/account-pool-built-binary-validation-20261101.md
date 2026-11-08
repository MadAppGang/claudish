# Account pool: built-binary validation run (MTL-260)

**Date**: 2026-11-01
**Build under test**: claudish 14.10.1
**Result**: 32 of 32 run-row variants PASS. E20 parity: 4 cases identical, 1 expected divergence.

No product defect was found by this run. The first runs failed rows; each failure was a defect
in the rows contract text or in the harness, and each is listed under *Defects found and fixed*.

The session directory `ai-docs/sessions/dev-feature-mtl-260-pool-bin-20261101-153857-c4a1/` holds the
raw evidence and is gitignored. It does not survive a fresh clone or `git worktree remove`. The
numbers in this report are the durable record. Evidence paths below are relative to that directory.

Row ids and their mutations: [`accounts-validation.md`](../architecture/accounts-validation.md).
Design rationale: [`accounts.md`](../architecture/accounts.md). Harness: `ai-docs/benches/account-pool-validation/`.

## What was run

The rows ran twice against the same bundle. Each run recorded its pin before any row ran. Run 1 is
`validation/rows-summary-run1.md`, pinned 05:42:56; run 2 is `validation/pin.json` and
`validation/rows-summary.md`, pinned 06:30:24 (the final run; the table below is run 2). Both
runs gave 32 PASS of 32 variants. The two pins differ only in `git status --porcelain`: run 1 saw the
harness directory as the only change, run 2 also saw the two edited architecture documents and this
report.

| Item | Value |
|---|---|
| `claudish --version` | `claudish version 14.10.1` |
| Bundle `packages/cli/dist/index.js` sha256 | `17d298d23f8b955bd11600c26446c69f096bea49bbebaa2de5622d209bae95b9` |
| Launcher `packages/cli/bin/claudish.cjs` sha256 | `53489f09299017f3f6a50c89fb0d4174fd1e593317319ffcf4321f8ed98ad509` |
| git HEAD | `5bdf9982e919a9bcbdec79dc353ca3532beb8730` (`git status --porcelain`: `M ai-docs/architecture/accounts-validation.md`, `M ai-docs/architecture/accounts.md`, `?? ai-docs/benches/account-pool-validation/`, `?? ai-docs/reports/account-pool-built-binary-validation-20261101.md`) |
| Claude Code | `2.1.316 (Claude Code)` at `/Users/jack/.local/share/claude/versions/2.1.316` |
| Catalog generation | `g-20261012101007285-7770c36e` (test data copy, `packages/cli/src/test-fixtures/catalog-v3/wire-g-20261012101007285-7770c36e.json`) |
| Bun | 1.4.0 |
| Pinned at | 2026-11-01T06:30:24.778Z (run 1: 2026-11-01T05:42:56.126Z) |

The bundle was built once and never rebuilt during the run. No startup identity line exists in the
source, so the pin is `--version` plus the two sha256 values plus git HEAD.

Scope: 32 run-row variants over 22 rows (V1, V1b, V1c, V1d, V1e, V2, V2b, V2c, V2d, V2f, V3, V3b, V8,
V8b, V9, V9b, V10, V10b, V11, V14, V16b, V17), plus V16 as E20 on two binaries. The run took about
12 minutes with the offline sandbox on.

## How it ran

Every row drives the built launcher against a fake Codex upstream. Two drive modes exist:

| Drive | Command | Third source | Variants |
|---|---|---|---|
| `session` | `node packages/cli/bin/claudish.cjs -y -q -p "<prompt>" --model cx@gpt-6.1-sol` | Claude Code transcript | 5 (V1, V1c, V8, V11, V17) |
| `direct` | `claudish serve --port <n> --models <slots.json>`, then a plain `POST /v1/messages` | the proxy's HTTP response | 27 |

Each row passes only when three sources agree (`agree.ts`): the proxy's `accounts.jsonl`, the fake's
request log, and the third source above.

Standing assertions on every run (`harness.ts`):

- A pre-flight request reaches a separate fake on a separate HOME, which proves the seam is armed.
- The canary (the metered `api.openai.com` listener) is proved alive: one hit, then the counter resets.
- The canary count equals the row's stated number: 0 everywhere except V17.
- The only non-loopback contact is `CONNECT us-central1-claudish-6da10.cloudfunctions.net:443`, refused by the egress sink.
- HOME is never the real home, and the child env is a whitelist. The one exception is V2e, which
  runs claudish with the real HOME by owner decision (`security` finds keychains only through
  `$HOME`) and passes `CLAUDISH_CONFIG` naming a config that lists only the fake account.
- No credential-shaped string reaches any product-output file: every file in a run directory is scanned except the evidence files named in `harness.ts` `EVIDENCE_FILES`.

Mutants (`mutants.ts`) are textual edits of a scratch copy of the bundle, never the repo's `dist/`.
Each row runs against the real bundle, then against its mutants. A required mutant that leaves the
row green is `DEAD-MUTANT`, and the row counts as not evidence. Negative controls (`*-DEAD`) must
remain dead for the billing predicate (the canary is never contacted). Their row results differ, per
control (run 3): `V1-no-rotation-catch-inner-only-DEAD` (V1 direct and session),
`V16b-hascredentials-revert-DEAD` and `V16b-existssync-absence-DEAD` are fully green (no failed
check); `V1c-swallow-only-DEAD` (direct and session) and `V1d-swallow-only-DEAD` fail response
assertions (the 429 or 503 answer, the `x-claudish-auth-verdict` header, the account messages) while
the canary stays at 0; `V16-drop-transform` (E20) is identical to the unmutated candidate (0 diffs).
The run used 32 mutants: 36 required mutant runs, all 36 turned their row red, and 7
negative-control runs of 5 controls all stayed dead.

## Per-row results

Every row verdict is PASS. Canary is the count got/expected. "RED" means the mutant turned the row
red, as required. "DEAD(ctl)" means a negative control stayed dead for the billing predicate, as required (per control: some fully green, some failing a response assertion, see above).

| Row | Drive | Canary | Mutant outcome |
|---|---|---|---|
| V11 | session, direct | 0/0 | `V11-no-rotation` RED, `V11-quota-to-terminal` RED (both drives) |
| V1 | direct, session | 0/0 | `V1-no-rotation-catch` RED; `V1-no-rotation-catch-inner-only-DEAD` DEAD(ctl) |
| V1c | direct, session | 0/0 | `V1c-swallow-initial-sign` RED; `V1c-swallow-only-DEAD` DEAD(ctl) |
| V1b | direct | 0/0 | `V1b-no-transport-net` RED, `V1b-no-nets` RED |
| V1d | direct | 0/0 | `V1d-swallow-in-isavailable` RED; `V1d-swallow-only-DEAD` DEAD(ctl) |
| V1e | direct | 0/0 | `V1e-config-failed-as-absent` RED |
| V16b | direct | 0/0 | `V16b-registry-failed-as-absent` RED; `V16b-hascredentials-revert-DEAD`, `V16b-existssync-absence-DEAD` DEAD(ctl) |
| V2 | direct | 0/0 | `V2-no-exclusive-create` RED |
| V2b | direct | 0/0 | `V2b-no-dead-holder-detection` RED |
| V2c | direct | 0/0 | `V2c-timeout-unlocked-refresh` RED |
| V2d | direct | 0/0 | `V2d-unwritable-unlocked-refresh` RED |
| V2f | direct | 0/0 | `V2f-fence-on-pid-only` RED |
| V3 | direct | 0/0 | `V3-coalesce-selection-usage` RED |
| V3b | direct | 0/0 | `V3b-stale-usage-is-unknown` RED |
| V8 | direct, session | 0/0 | `V8-no-record-retry` RED (both drives) |
| V8b case 1 | direct | 0/0 | `V8b-acquire-in-query` RED |
| V8b case 2 | direct | 0/0 | none: the disabled-account arm; the mutant targets case 1's eligible-account arm |
| V9 `persist-throw` | direct | 0/0 | `V9-no-journal` RED |
| V9 `crash-after-refresh` | direct | 0/0 | `V9-no-journal` RED |
| V9b committed | direct | 0/0 | `V9b-committed-resolved-as-uncommitted` RED |
| V9b uncommitted | direct | 0/0 | none: the mutant is observable only in the committed case |
| V10 a | direct | 0/0 | `V10-no-material-moved`, `V10-no-baseline-in-mark`, `V10-no-heal-in-acquire`: all RED |
| V10 b | direct | 0/0 | `V10-no-material-moved`, `V10-no-baseline-in-mark`: both RED |
| V10 c | direct | 0/0 | `V10c-retry-always-due` RED |
| V10b | direct | 0/0 | `V10b-no-gate-ownership-check` RED |
| V14 | direct | 0/0 | `V14-no-restat-per-answer` RED |
| V17 | direct, session | 1/1 | `V17-pool-available-when-empty` RED (both drives) |

`V8b:case2` and `V9b:uncommitted` carry a "not evidence" note in `rows-summary.md`. Each is the second
arm of a row whose mutant sits on the first arm. Raw rows: `validation/rows/<ROW>/`.

## E20: executable parity (V16)

V16 compares two built binaries on the same fake, the same seed and the same request. The baseline is
the parent of the Phase 2a commit, v14.4.1 (`579114b125ed03324ef8bb9cf1f3fe659ab4443a`), with only the
test seam backported. The candidate is the 14.10.1 build above. Both ran as `claudish serve` under the
offline sandbox. The run was repeated end to end twice with the same outcomes, and every case ran twice
per binary inside each run and was self-stable.

| | Baseline | Candidate |
|---|---|---|
| `--version` | `claudish version 14.4.1` | `claudish version 14.10.1` |
| `dist/index.js` sha256 | `7d68e1be0ba2674ef1941a5333ed7afee22840875afb0e74b78ced3eab0ee6a3` | `17d298d23f8b955bd11600c26446c69f096bea49bbebaa2de5622d209bae95b9` |
| Seam | backported (diff sha256 `f6c6ccfab7c8347336af818828743cd55e657933a48ca068ff1e5932bf762ed6`) | none needed |

The seam proof ran before any case: a `POST /backend-api/codex/responses` reached the fake on both
binaries. The backport is a new `test-upstream.ts` (from `52fb426b`), `resolveUpstreamUrl` in
`openai.ts` `getEndpoint()`, the `endpoint` in `codex-credential.ts`, and the refresh fetch in
`codex-oauth.ts`.

| Case | Outcome |
|---|---|
| `legacy-ok` | identical: same path, headers, payload; client 200, same body |
| `legacy-error` (fake 500) | identical: same two requests, no retry on either; client 500 `server_error` |
| `legacy-terminal` (fake 400, added) | identical: exercises the terminal-error remap proper |
| `apikey` (V16 and V17) | identical: one request at the canary on both, fake saw 0 `/responses` |
| `refresh-rejected` | **expected divergence** |

`refresh-rejected`: the baseline answers HTTP 500 `api_error` ("Token refresh failed: 400 -
invalid_grant"). The candidate answers HTTP 400 `invalid_request_error`, `upstream_status: 401`, with
header `x-claudish-auth-verdict: terminal`. Fixes A2 and A4 changed this on purpose, and they sit
inside `52fb426b`, so no pre-pool binary is post-A4. Both binaries made exactly one token request, and
the canary stayed at 0. The runner now checks, on every repetition of each binary (`e20-gate.ts`
`refreshRejectedProblems`): the status, `error.type`, `upstream_status`, the verdict header, one
token exchange, canary 0, the exact `error.message` of each binary (no variable part), no fake
credential in the client body or in any response header, and that the differing leaves are exactly
the four recorded ones. Any other difference makes the case DIFFERENT and the exit code nonzero. Fake
credentials are allowed only in upstream-request evidence, by an explicit file list in the code:
in a row run `fake.jsonl`, `canary.jsonl`, `egress.jsonl`, `accounts.jsonl`, `state.json`,
`result.json` and `outcome.json` (`harness.ts` `EVIDENCE_FILES`); in E20 `fake-requests.json`,
`canary-requests.json`, `result.json` and a mutant's `diff.json` (`e20-gate.ts`
`UPSTREAM_EVIDENCE_FILES`). Every other file is product output and is scanned, and E20 also scans
the full stdout and stderr of every repetition and mutant run in memory.
Run 2 predates that check; run 3 (below) repeated E20 with it active (`divergenceProblems: []`).

Mutants of the current bundle, on scratch copies:

| Mutant | Case | Outcome |
|---|---|---|
| `V16-endpoint-path` | `legacy-ok` | red (17 diffs) |
| `V16-omit-header` (drops `originator`) | `legacy-ok` | red (2 diffs) |
| `V16-remap` | `legacy-error` | red (5 diffs) |
| `V16-drop-transform` | `legacy-ok` | **DEAD-MUTANT** (0 diffs) |
| `V16-drop-transform-both-layers` (supplementary) | `legacy-ok` | red (2 diffs: `store`, `include` absent) |

**Why `V16-drop-transform` is dead.** The request builder already writes `store:false` and `include`
(`codexExtras`, `index.js` near line 24102). The credential's `oauthPayload` payload edit is redundant,
so removing it changes no byte on the wire. The supplementary mutant removes both layers and turns
red, which shows the payload comparison can fail.

Checks: egress was only the known catalog `CONNECT` on every run. The canary count was 0 in all
`legacy-*` and `refresh-rejected` runs and 1 in `apikey` on both binaries, and 0 in every mutant run.
The secret scan covered 87 files with 59 matches, all on the allowlist of fake values, and 0
violations. Evidence: `validation/e20/` (`summary.json`, `pins.json`, `seam-proof.json`,
`seam-backport.diff`, `secret-scan.json`).

Not covered: the native-with-no-pool case, dropped because it needs an Anthropic route in the fake
(V18's response half). Parity holds for behaviour other than the seam, which is the backport itself.

## Blocked rows

These rows cannot run. No owner ticket exists yet for those marked "to be created".

| Row | Reason | Owner |
|---|---|---|
| V4 | Native Claude pool (P3) is not built; the row is also `[unmutatable]` | to be created: "feat(accounts): Claude account pool on the native handler (Phase 3), with built-binary rows V4, V15, V18" |
| V5, V5b, V6, V7, V7b | Need D8, a real Codex `usage_limit_reached` frame with its metadata prefix; the extended in-stream watch is Phase 2b | MTL-261 |
| V12, V12b, V12c | Superseded by the switch rule (2026-10-29); need P4 | MTL-263 (replaces them with switch-rule cases) |
| V13, V13b, V13c | P4 handoff (`account use`, Claude Code's item) is not built | to be created: "feat(accounts): `account use` handoff under the switch rule, with built-binary rows V13, V13b, V13c" |
| V15 | Needs both claudish providers in one HOME; the Claude pool is P3 | same ticket as V4 |
| V18 request half | Activating the pool with zero Claude accounts needs P3 | same ticket as V4 |

## Deferred rows

These rows could run in principle but were not run in this ticket.

| Row or part | Reason |
|---|---|
| V1b rotation site, forced site, post-record backstop | The fault is read from `process.env` at each check. A built binary cannot flip it mid-turn from outside. It needs a product seam, a fault armed after N signs (to be created: "test(accounts): fault that arms `non-oauth-artifact` after N signs"). In-process tests `E17-*` and `E17-backstop` cover it, with executed mutants |
| V16b live half | The pool answers before the singleton `CodexOAuth` is reached, so it is unreachable from outside |
| V16b `chmod 000 ~/.claudish` pass | The catalog test data lives in `~/.claudish`; claudish answers 400 "cloud models catalog is not available" first, so the pass would test the catalog read |
| V16b `EMFILE` pass | No `EMFILE` injection exists; `account-list-read-throws` stands in |
| V2e (strict 3 s memo window) | Partly verified on a real account; the strict form waits for quota. See *V2e on the login keychain* below |
| V10 (d) | No fault in the vocabulary pauses between the heal's read and its write |
| V14 billing-probe half | In-process state with no external read |
| V18 response half | The fake has no Anthropic route; `native-handler.test.ts` covers it at unit level |

## Relaxations

- **Direct rows have no transcript.** Their third source is the proxy's HTTP response body: status,
  headers (`x-claudish-auth-verdict`, `upstream_status`) and body. That is stricter for status and
  headers and says nothing about what Claude Code displays. The 5 rows that assert what the user sees
  also run a `session` variant.
- **V8b asserts no transcript.** Claude Code retries a `transient` 429, so the user sees the retried
  request's outcome. V8b runs `direct` only.
- **V1b covers the initial site only.** See *Deferred rows*.
- **V17 and V14 state.** `recordSignedArm = metered` is in-process state; the canary request carrying
  the api key stands in for it. The V14 billing-probe half is not observable.

## Findings that are not failures

- **V2: the O_EXCL create does not keep the exchange count at one.** Under `V2-no-exclusive-create`
  the token endpoint still sees one exchange. The fence and the read-back stop the others, at the
  price of three HTTP 503. The mutation costs availability, not safety. The row turns red through its
  four-HTTP-200 check, not through `ok > 1`.
- **V1c, V1d and V1b: two redundant nets.** The single-edit mutants (`V1c-swallow-only-DEAD`,
  `V1d-swallow-only-DEAD`) stay dead against the built bundle with canary 0. That is the intended
  defence in depth. The mutant that turns the row red removes both nets. V1 has the same shape: the
  dispatch loop's `isAccountsError` net answers the same 400 when only the rotation catch goes.
- **V16b: the live half of the legacy-file check is unreachable from outside.** The pool is consulted
  first. `V16b-hascredentials-revert-DEAD` and `V16b-existssync-absence-DEAD` stayed dead.

## Defects found and fixed

These were found by the first runs. None was a product defect, and no assertion was weakened away.

| Row | First observation | Cause | Fix |
|---|---|---|---|
| V16b | control pass wrote no `accounts.jsonl` record | contract wrong: a synthesized legacy-only list signs through the singleton `CodexOAuth` with no pooled account | expected records are now "none" |
| V2f | token file carries a `writeId` | contract wrong: the journal write before the exchange mints one | assert unchanged generation, fingerprint and tokens plus the open journal |
| V2 | "issued in one tick" read 444 ms | harness bug: the span was measured after `await` | measured when the four fetches are created |
| V8, V8b | "no quota-switch record" failed | harness bug: these rows switch once and still end in a pinned error | `noSwitchAgreement` takes `switchAttempted` |
| V1 (mutant) | `V1-no-rotation-catch` stayed green | contract wrong: the dispatch loop's net is redundant | the mutant removes both nets; the single edit is a negative control |
| V2 (mutant) | `ok > 1 and invalid_grant >= 1` not reached | contract wrong: one exchange, three HTTP 503 | red condition includes the HTTP-200 and attempt-count checks |
| V17, V1, V8 sessions | Claude Code retried the canary's 500 ten times over 150 s | harness gap | these session rows set `CLAUDE_CODE_MAX_RETRIES=0` |

One more harness bug: killing the launcher orphaned a `serve`, because `bin/claudish.cjs` spawns the
bundle as a child. `direct.ts` `killTree` now signals the whole tree. Two further contract changes
(V3 request sequence, V10 case (c) mutant) are in `implementation-log.md` under "Decisions changed".

## Run 3 (after the external review fixes)

Two external reviewers (`gemini-4-argon`, `gpt-6.1-sol`) found issues in the harness code. The fixes changed
how a row run and the E20 run classify results (`standingBroken`, E20 exit code, refresh-rejected oracle,
tree kill, temp-tree removal). The rows and E20 ran again on a fresh build, written to `validation-run3/`
in the session directory, with the new code. Results:

- Build: bundle sha256 `17d298d2…bae95b9`, the same as run 2 (`claudish version 14.10.1`).
- `mutants.ts --check`: 32 OK, 0 BAD.
- Rows: `PASS=32 FAIL=0 DEAD-MUTANT=0 ERROR=0 of 32 run row variants`; 36 required mutant runs red; the
  row table matches run 2 line for line once timings are removed; canary 0 on every row except V17 (1).
- E20: seam ARMED on both binaries; `legacy-ok`, `legacy-error`, `legacy-terminal` and `apikey`
  identical; `refresh-rejected` expected divergence (4 diffs), now checked against explicit values;
  `V16-drop-transform` dead (named control); the other four mutants red; secret scan 87 files, 0 violations;
  E20 exit code 0 under the new gate.

## Run 4 (after review round 2)

Round 2 of the external review found three more false-success paths (leak scan misses V10 values, E20
`--only` typo exits 0, second refresh-rejected capture unchecked). The fixes touch the leak scan, the E20
gate and E20 argument checks. The rows and E20 ran again on a fresh build into `validation-run4/` with
the new code (219 harness tests pass). Results:

- Build: bundle sha256 `17d298d2…bae95b9`, the same as runs 2 and 3.
- `mutants.ts --check`: 32 OK, 0 BAD.
- Rows: `PASS=32 FAIL=0 DEAD-MUTANT=0 ERROR=0 of 32 run row variants`; 36 required mutant runs red.
- E20: four cases identical, `refresh-rejected` expected divergence (4 diffs, all four captures checked),
  `V16-drop-transform` dead (named control), the other four mutants red, secret scan 87 files, 0 violations,
  exit code 0.

## Run 5 (after review round 3)

Round 3 found a credential echo that the refresh-rejected oracle and the E20 secret scan both allowed, and
a cleanup gap in `executeRun` and `runOnce`. The fixes: exact refresh-rejected messages, a client-visible
credential scan on every capture, cleanup opened before the first resource. The rows and E20 ran again on
a fresh build into `validation-run5/` (226 harness tests pass). Results:

- Build: bundle sha256 `17d298d2…bae95b9`, the same as runs 2 to 4.
- `mutants.ts --check`: 32 OK, 0 BAD.
- Rows: `PASS=32 FAIL=0 DEAD-MUTANT=0 ERROR=0 of 32 run row variants`; 36 required mutant runs red.
- E20: four cases identical, `refresh-rejected` expected divergence with the exact messages, `V16-drop-transform`
  dead (named control), the other four mutants red, secret scan 87 files, 0 violations, exit code 0.

## Run 6 (after review round 4)

Round 4 found two more credential-echo surfaces (E20 stdout and stderr, V14 command output) and one cleanup
gap in `preflight`. The fix closes the class: fake credentials are allowed only in named upstream-evidence
files, every other file the harness writes is scanned, and E20 scans stdout and stderr on every repetition.
The rows and E20 ran again on a fresh build into `validation-run6/` (236 harness tests pass). Results:

- Build: bundle sha256 `17d298d2…bae95b9`, the same as runs 2 to 5.
- `mutants.ts --check`: 32 OK, 0 BAD.
- Rows: `PASS=32 FAIL=0 DEAD-MUTANT=0 ERROR=0 of 32 run row variants`; 36 required mutant runs red.
- E20: four cases identical, `refresh-rejected` expected divergence with the exact messages, `V16-drop-transform`
  dead (named control), the other four mutants red, secret scan 87 files, 0 violations, exit code 0.

## Run 15 (after the 2026-11-02 harness fixes)

The rows and E20 ran again after the fixes listed under *Review findings fixed on 2026-11-02* and the
V2e redesign, into `validation-run15/` and `e20-run15/` (355 harness tests pass). Results:

- Build: bundle sha256 `17d298d2…bae95b9`, the same as runs 2 to 6.
- `mutants.ts --check`: 33 OK, 0 BAD (the 32 row mutants and `V2e-keychain-reads-memoized`).
- Rows: `PASS=32 FAIL=0 DEAD-MUTANT=0 ERROR=0 of 32 run row variants`; 36 required mutant runs red. The new
  standing check "no real-credential-shaped string in any run file" passed in every row. V2e is not in
  `--all`.
- E20: four cases identical, `refresh-rejected` expected divergence (4 diffs), `V16-drop-transform` dead
  (named control), the other four mutants red, each with its own upstream request captured
  (`POST /backend-api/codex/mutant` for the endpoint mutant, `POST /backend-api/codex/responses` for the
  rest), secret scan 87 files, 0 violations, exit code 0.

## Run 16 (after review round 6)

Rows and E20 ran again after the round-6 fixes, into `validation-run16/` and `e20-run16/` (428 harness
tests pass, strict `tsc` exit 0):

- Build: bundle sha256 `17d298d2…bae95b9`, unchanged.
- `mutants.ts --check`: 33 OK, 0 BAD.
- Rows: `PASS=32 FAIL=0 DEAD-MUTANT=0 ERROR=0 of 32 run row variants`; 36 required mutant runs red.
- E20: four cases identical, `refresh-rejected` expected divergence (4 diffs), `V16-drop-transform` dead
  (named control), four mutants red, each with its own request AND a difference under its declared field
  (for example `2 of 2 difference(s) under $.fake[*].headers.originator`,
  `1 of 5 difference(s) under $.client.status`), secret scan 87 files, 0 violations, exit code 0.

## Run 17 (after review round 7)

Rows and E20 ran again after the round-7 fixes, into `validation-run17/` and `e20-run17/` (442 harness
tests pass, strict `tsc` exit 0). Same build. Rows: `PASS=32 FAIL=0 DEAD-MUTANT=0 ERROR=0 of 32 run row
variants`; 36 required mutant runs red. E20: identical to run 16 (four cases identical, `refresh-rejected`
expected divergence, `V16-drop-transform` dead as the named control, four mutants red on their own
request and field), secret scan 87 files, 0 violations, exit code 0.

## Run 18 (after review round 8)

Rows and E20 ran again after the round-8 fixes (`direct.ts` changed: detached process groups for
`v2e-real.ts`, `signalCode` on start), into `validation-run18/` and `e20-run18/` (458 harness tests pass,
strict `tsc` exit 0). Same build. Rows: `PASS=32 FAIL=0 DEAD-MUTANT=0 ERROR=0 of 32 run row variants`;
36 required mutant runs red. E20: identical to run 17, secret scan 87 files, 0 violations, exit code 0.

## Review round 9

`gpt-6.1-sol` and `gemini-4-argon` (`dev:reviewer`, `xhigh`, read-only) both APPROVE with no finding at
any severity. Both confirmed the four round-8 fixes and their regression tests (458 pass), found no new
defect in the `direct.ts` process-group change, and judged the stated gaps accurate. Reports:
`ai-docs/sessions/team-20261102-review9/response-01.md` and `response-02.md` (gitignored).

## V2e on the login keychain (2026-11-02)

**Cause of every earlier V2e failure.** `/usr/bin/security` finds keychains through `$HOME`: it reads
`$HOME/Library/Keychains` and the search list from `$HOME/Library/Preferences/com.apple.security.plist`.
The bench runs claudish under a temporary `HOME`, so claudish saw no keychain at all. Read-only check:

| `HOME` | `security default-keychain -d user` | `security list-keychains -d user` |
|---|---|---|
| real | `/Users/jack/Library/Keychains/login.keychain-db`, exit 0 | the login keychain |
| temporary | `A default keychain could not be found.`, exit 1 | empty |
| temporary, with symlinks to both paths above | the login keychain, exit 0 | the login keychain |

The five earlier diagnoses (ACL, partition list, `-A`, the product writer) looked at the item; the item was
never reachable.

**The throwaway-keychain design is removed.** It created a keychain file and changed the per-user search
list, which is shared by every running program. Observed on 2026-11-02, in this order: the V2e guard saw
the new keychain file in the search list and restored the list around each run; during those runs other
programs (`gh`, Claude Code) raised stacked "wants to use the login keychain" dialogs; the Mac had to be
rebooted. That the search-list change caused the dialogs and the freeze is INFERRED, not proven
(`ai-docs/architecture/keychain.md` says the same). `keychain-guard.ts` now allows only
`find-generic-password` and `delete-generic-password`, on the one fake item
`claudish-accounts` / `openai-codex:aaaaaaaaaaaa`; `create-keychain`, `list-keychains`, `default-keychain`,
`unlock-keychain`, `set-keychain-settings`, `show-keychain-info` and the partition list throw before any
process starts. The product's own `writeKeychainItem` stores the item. The first bench call that waits
15 s, or a product `security` call under a serve that runs 5 s, stops the row: the code kills that call
and every producer and makes no further keychain call except the cleanup delete. How many dialogs can
appear, and whether a dialog closes when its call is killed, is NOT measured (see *Review round 6*).

**Run 14 (fake server, real `HOME`, by Jack's decision).** Every keychain call took 11-79 ms; no dialog.
The race did not run: under the real config the pool chose the real default account `4463fa7e5c82`
(`legacy-codex-file` store), whose token was not expired, and its real access token reached the fake
server's log. The run folder was deleted the same day. That leak is what the credential-shape scan
(below) now catches.

**Real-account run (`v2e-real.ts`, `v2e-real-run1/`), by Jack's decision.** Real `HOME` (so `security`
finds the login keychain), `CLAUDISH_CONFIG` naming only the keychain account `dc53ea1b2616`, the real
accounts folder (so the refresh lock is the one every claudish process on the Mac shares), real OpenAI.
The script marked the token expired through `writeKeychainItem`, then raced two `serve` processes:

| Moment | Generation | Expires | Fingerprint |
|---|---|---|---|
| before | 1 | 2026-11-05T05:13:11Z | `67e5bb95…` |
| forced expired | 1 | 1970-01-01 | `67e5bb95…` |
| after the race | 2 | 2026-11-12T09:50:29Z | `b45c2360…` |

Measured: the generation went from 1 to 2, and the fingerprint and the expiry are new. All four
`accounts.jsonl` records name `dc53ea1b2616`. Inferred, not measured: that only one token exchange
happened (a generation step is one persisted rotation, not a count of exchanges) and that the second
process read the expired generation. The run-1 script read `needsReauth` from the wrong path in
`accounts/state.json` (review round 6, B3), so "no `needsReauth` mark" was not measured either;
`v2e-real.ts` now reads `providers["openai-codex"].accounts[<id>].needsReauth`. Both replies were HTTP 400, "Codex subscription usage limit reached on every account (1 of
1)": the account's real quota was used up, so the model calls after the refresh were refused. The replies
took 12.3 s, so the run does not show the second read falling inside the 3 s memo window, and it is not
the strict V2e proof. A JWT-shape scan of the run folder found no token.

**Open:** rerun `v2e-real.ts --out <dir>` after the quota resets for the strict form.

### Run 2 on `dc53ea1b2616` (2026-11-03): refused by claudish, not by OpenAI

Both replies were HTTP 400 after 29 ms, and the generation stayed at 2: no request left the Mac. The
cause is claudish's saved quota block. `~/.claudish/accounts/state.json` holds `exhaustedUntil`
2026-11-05T21:15:41Z for this account (the weekly window OpenAI reported on 2026-11-02), and
`blockerFor` (`packages/cli/src/auth/accounts/policy.ts:229`) skips an account whose saved time is in
the future. The restore put the original expiry back (`restore: restored`), and the shape scan found
nothing.

Product gap, filed by triage as MTL-370: a reset at the vendor before the saved time (Jack reset quota by hand)
is never learned. `AccountStateStore.clearExhausted` (`state-store.ts:926`) exists, but no product
code calls it, so the account stays blocked until `exhaustedUntil` passes.

### Run 3 on `dc53ea1b2616` (2026-11-03): every race check passes; the 3 s check cannot pass

Jack reset the account's quota at OpenAI. The saved block was cleared through the product's own
`StateStore.clearExhausted` (state file backed up first), then `v2e-real.ts` ran.

| Moment | Generation | Expires | Fingerprint |
|---|---|---|---|
| before | 2 | 2026-11-12T09:50:29Z | `b45c2360…` |
| forced expired | 2 | 1970-01-01 | `b45c2360…` |
| after the race | 3 | 2026-11-13T04:42:36Z | `8224a8d8…` |

Measured: both replies HTTP 200 (9.3 s and 10.1 s), one persisted rotation (generation 2 → 3, new
fingerprint and expiry), all four `accounts.jsonl` records name `dc53ea1b2616`, `needsReauth` `null`,
`restore: newer-generation` (nothing written back), shape scan of 8 files clean. Exit 1, only because
`memoWindowMet` is false.

The 3 s check is a flawed proxy. The risk window is between process A persisting the rotation and
process B re-reading the item; the script cannot see that moment, so it measured the full reply
time, which includes the model's answer (4 to 10 s against real OpenAI). The check cannot pass
against real OpenAI whatever claudish does. Inferred, not measured: process B did not use a stale
memo copy, because that would have sent a revoked refresh token, giving `invalid_grant` and a
`needsReauth` mark, and neither happened. Open: measure the persist-to-reread interval directly.

### File-store race on the default account `4463fa7e5c82` (2026-11-03)

Jack's decision: while `dc53ea1b2616` is blocked, run the same race on the default account, which is a
`legacy-codex-file` account (`~/.claudish/codex-oauth.json`). This is NOT V2e: V2e is the keychain row.
It proves the same refresh race on the file store.

`v2e-real.ts --account <id>` picks the store from the account's `store` in the real config:
the product's `LegacyCodexFileStore` for a file account (its write keeps every other key in the file).
The gate path comes from the product's `accountRefreshLockPath`, which names `legacy-codex.lock` for
this store, not `4463fa7e5c82.lock`: a path built from the id would hold a lock no serve takes.
`v2e-real-file.test.ts` pins both, and the verdict label, against the product's own functions in a
temp HOME. With the two fixes reverted, 2 of its 10 tests fail (the lock path and the label).

| Moment | Generation | Expires | Fingerprint |
|---|---|---|---|
| before | 1 | 2026-11-10T03:13:25Z | `8db7ee99…` |
| forced expired | 1 | 1970-01-01 | `8db7ee99…` |
| after the race | 2 | 2026-11-13T03:33:11Z | `350caa08…` |

Measured: both replies HTTP 200 (4.1 s and 4.8 s), the generation went from 1 to 2, the fingerprint and
the expiry are new, all four `accounts.jsonl` records name `4463fa7e5c82`, `needsReauth` is `null`,
both serves confirmed gone. `restore: newer-generation` is the expected outcome: the race rotated the
token, so the end wrote nothing. The shape scan of the 8 output files found nothing. Inferred, not
measured: that only one token exchange happened (one generation step is one persisted rotation).

## Review findings fixed on 2026-11-02

The round-5 findings, parked at release time, are fixed in the harness. Each has a test that fails with
the fix reverted:

- HIGH, redirects: every parent-side request goes through `parentFetch` (`direct.ts`), which forces
  `redirect: "manual"`. A 3xx is a recorded failure (row ERROR, E20 case aborted), never followed. A test
  fails on any new bare `fetch(` in the bench.
- HIGH, E20 mutant verdict: each E20 mutant declares the upstream request that proves it ran
  (`POST /backend-api/codex/mutant` for the endpoint mutant, `POST /backend-api/codex/responses` for the
  others). Red needs that request and a difference; no upstream contact is ABORTED and fails the exit code.
- MEDIUM, leak scan: files of any size are scanned in overlapping windows; tokens the fake issued are
  matched by their exact values (`Fake.issued()`).
- NEW, credential shape: `cred-shape-scan.ts` fails a run on any JWT-shaped string (`eyJ…`, three
  segments, 100+ characters) or `sk-` key that is not one of the bench's own values. A finding names the
  file, offset, length and a sha256 prefix, never the value. Rows, E20 and `v2e-real.ts` run it.

## Review round 6 (2026-11-02)

GPT (`response-02.md`) and Gemini (`response-01.md`) rejected the 2026-11-02 fixes. Every finding is
fixed in the harness and none of them under `packages/`. No row, `run-row.ts`, `e20.ts`, `v2e-real.ts` or
`security` ran for this round; the evidence is the unit suite (428 tests). Each test below was run with
its fix reverted (the file copied aside, edited, run, copied back) and failed as shown.

| Finding | Change | Test | Output with the fix reverted |
|---|---|---|---|
| A1 real account list under real HOME | `CLAUDISH_CONFIG` to the seed child (`keychain-guard.ts:894`) and both serves (`rows.ts:865`); `assertFakeOnlyConfig` (`keychain-guard.ts:355`) before the seed (`:873`) and after the store edit (`rows.ts:839`) | `A1: the V2e config may name only the fake account > seeding refuses a config with a real account before any child or keychain write`; `v2eBody ... > order: ...` | `Expected promise that rejects / Received promise that resolved`; env diff `- "CLAUDISH_CONFIG": ".../home/.claudish/config.json"` |
| A2 delete before producers dead | `registerProducer` at spawn (`direct.ts:182`, `keychain-guard.ts:640`); `stopProducers` (`:704`) before the one delete in `doCleanup` / `cleanupSync`; recovery file and lock kept if one survives; `teardownRun` (`harness.ts:516`) | `A2: ... > a paused seed child is killed before the delete and never writes afterwards` (GPT's scenario); `... > a producer not confirmed gone keeps the recovery file and the lock`; `teardownRun: ... > a process that is not confirmed gone is named` | `expect(itemExistsAfterCleanup).toBe(false)` Received `true`; `Expected promise that rejects`; `- "serve 1 pid 4242" + []` |
| A3 product `security` not bounded | `longSecurityCall` (`keychain-guard.ts:419`), `psLister`, watch every 500 ms (`startWatch`), 5 s limit | `A3: ... > a long security call under a serve trips the guard: every producer killed, listeners fire, no further call` | `Expected: true Received: false` |
| B1 unlocked read-modify-write | `forceExpiry` reads uncached inside `withRefreshGate` on `accountLockPath` (`v2e-real-lib.ts:50`, `v2e-real.ts:83`), refuses an open journal, checks the fence | `B1: ... > a rotation that lands while the script waits for the gate is the base, never overwritten` | `Expected: 2 Received: 1` |
| B2 aborted run leaves expiry forced | `restoreIfStillForced` (`v2e-real-lib.ts:83`): same generation, fingerprint, `expiresAt 0`, no journal | `B2: ... > a newer generation is never written over` | `Expected: "newer-generation" Received: "material-changed"` |
| B3 wrong `needsReauth` path | `needsReauthOf` (`v2e-real-lib.ts:106`) | `B3: ... > the account's own mark`; `... > the old wrong paths ... are not read` | `- {"failedGeneration": 2} + null`; `toBeNull() Received: 1` |
| B4 exit 0 on a false field | `classifyVerdict` (`v2e-real-lib.ts:132`): any false field exits 1; observational vs strict; prints `NOT EVIDENCE for the strict V2e form` | `B4: ... > memo window missed (run 1 took 12.3 s): exit 1, observational only, NOT EVIDENCE printed`, one test per field | `- "exitCode": 1 + "exitCode": 0` |
| B5 serve output dropped | `v2e-real.ts:132` writes `serve-N-stdout.txt` / `serve-N-stderr.txt` in `finish()` before the scan | none: `v2e-real.ts` may not run in this round; the write is ahead of the scan in the same function | not proved by a test |
| C1 encoded and truncated credentials | `cred-shape-scan.ts`: `jwt-prefix` (`:98`), `rt_` (`:105`), credential JSON/form fields (`:107`, `:110`), JSON-escape, UTF-16LE and base64 views (`:225`, `:255`, `:276`) | `encoded and truncated credentials are caught (review round 6) > ...` (8 tests) | `Expected to contain: "jwt/base64" Received: []`; `- ["rt-token"] + []` |
| C2 files written after the scan | `finalizeRecord` (`harness.ts:463`), `writeOutcomeScanned` (`run-row.ts:304`), `writeScanned` for summaries and E20 `finishE20` (`e20.ts:958`); `describeBearers` (`harness.ts:549`) | `result.json is scanned in memory ... > a credential in a note fails the run`; `... > the pre-flight detail names bearers by hash`; `outcome.json ... > ... turns the row into ERROR` | `Expected: false Received: true`; `Expected to not contain: "eyJqqlAJmTxp"`; `Expected: "ERROR" Received: "FAIL"` |
| C3 raw characters of an unparsable value | `describeUnparsable` (`keychain-guard.ts:342`): kind, length, sha256 prefix | `reading values > describeUnparsable names the kind, length and a sha256 prefix, and no character of the value` | `Expected to contain: "hex value, length 200" Received: "hex value: 7b7b…"` |
| C4 first match only | `unknownSecretShapes` (`e20-gate.ts:36`), global regex, used by `clientLeaks` / `outputLeaks` | `C4: every credential-shaped match is checked, not only the first > ...` (3 tests) | `Expected: 2 Received: 0`; `Expected: true Received: false` |
| D1 a throw ends E20 with no summary | `guarded` (`e20-gate.ts:205`) around seam proofs, cases and mutants (`e20.ts:713`, `:764`, `:905`); `finishE20` | `D1: ... > guarded turns a throw into an ABORTED entry`; `... > finishE20 writes secret-scan.json and summary.json and fails on the ABORTED entry` | the test threw `serve did not start (V16-remap) ...` / `POST failed (candidate): connection reset` |
| D2 red on any difference | `diffPaths` per mutant (`e20.ts:158-181`), `underDiffPath`, `mutantVerdict` (`e20-gate.ts:345`); checked against the run-15 captures | `D2: red needs a difference under the mutant's declared diff path > <mutant> differing only elsewhere is ABORTED, never red` (4 tests) plus the run-15 table | `Expected: "ABORTED" Received: "mutant red"` |
| E1 report wording | *V2e on the login keychain* rewritten: measured vs inferred, `needsReauth` unmeasured, dialogs unmeasured | n/a | n/a |
| E2 rerun block | `33 OK, 0 BAD`; HOME exception noted in *How it ran* and the README | n/a | n/a |
| E3 test title | `v2e-row.test.ts:59`: "the red predicate fires only on the memo's own evidence: a rejected or a second accepted exchange" | n/a | n/a |

A1, the legacy question: with real HOME, `CLAUDISH_CONFIG` replaces the config file but not
`~/.claudish/codex-oauth.json`. `AccountRegistry.refreshLegacySource()` (`packages/cli/src/auth/accounts/registry.ts:423`)
ignores the legacy file when the `openai-codex` entry has `accounts.length > 0`, and the row's config
always has one (`aaaaaaaaaaaa`), which `assertFakeOnlyConfig` checks. `CLAUDISH_CONFIG` is applied by
`applyConfigOverride` (`index.ts:356`) before serve is dispatched (`index.ts:456`). Resolved by reading
the code; not measured by a run.

**Deviation.** The serve watch limit is 5 s, not the 15 s the finding proposed: the product kills its
own `security` call at 10 s (`SPAWN_TIMEOUT_MS`, `providers/keychain.ts:135`), so a 15 s limit would
never fire.

**Remaining gaps (not fixed, stated):**

- The watch polls `ps` every 500 ms; a `security` call shorter than one poll is not seen.
- The other serve can start its own `security` call within about 5.5 s, before the watch trips, so a
  second dialog is possible. "At most one dialog" is not claimed.
- Whether killing `security` closes a macOS dialog is unmeasured.
- With the real HOME, serve still writes its logs, startup metrics and tokens-port files under the real
  `~/.claudish`.
- The shape scanner reads one level of encoding (JSON escape, UTF-16LE, base64). A credential split
  across strings, compressed, or encoded twice is not caught.
- A producer that appears after the cleanup delete is killed at once and re-arms the recovery file;
  it is not confirmed gone.
- ~~B5 has no unit test~~: since round 8 the run is `v2e-real-run.ts`, tested with fakes and synthetic
  processes; the live wiring is pinned by source only.

## Review round 7 (2026-11-02)

GPT (`response-02.md`, REJECT: 3 HIGH, 1 MEDIUM, 1 LOW) and Gemini (`response-01.md`, APPROVE with 2 LOW,
both duplicates of GPT's) reviewed the round-6 fixes. All five are fixed in the harness, none under
`packages/`. No row, `run-row.ts`, `e20.ts`, `v2e-real.ts` or `security` ran; the evidence is the unit
suite (442 tests). Each fix was reverted (the fixed file copied aside, the fix's lines put back to the old
behaviour, run, copied back) and its test failed as shown.

| Finding | Change | Test | Output with the fix reverted |
|---|---|---|---|
| GPT HIGH 1 = Gemini LOW 2: snapshot retained only after the write and its readback | `forceExpiry` hands the snapshot to `onSnapshot` BEFORE the write (`v2e-real-lib.ts:81`); any later failure re-reads under the same hold and restores only the unchanged forced record (`restoreUnderGate`, `:116`, now also requires every other field unchanged); `v2e-real.ts:230` keeps the snapshot from the callback | `R7-1: ... > write commits, then throws: the original expiresAt is restored under the same gate`; `... > verification read throws: the original expiresAt is restored`; `... > the in-place restore fails too: the snapshot is still with the caller, and the end restores` | `Expected: 2000000000000 Received: 0` (both); `Received: null` (snapshot) |
| GPT HIGH 2: SIGKILL could cut a rotation between exchange and persist | `shutdownUnderGate` (`v2e-real-lib.ts:183`): stop issuing, take the refresh gate (bounded 60 s, `gateWithin` retries the product's 20 s acquire, `v2e-real.ts:105`), kill and restore with it held; not free in time: kill, print a WARNING that a refresh may have been interrupted and the account may need a `claudish` login, restore under the gate; `installSafeSignals` (`:228`): a second signal prints `finishing safely, please wait`; no request after the end began (`v2e-real.ts:270`, `:277`) | `R7-2: an interrupted run kills the serves only with the refresh gate held > SIGINT between exchange acceptance and persist: the kill waits for the gate`; `... > gate not free within the bound: kills anyway and says so, never silently` | kill first: `Expected to not contain: "kill" Received: ["exchange accepted", "kill", "rotation lost (killed before persist)", "kill"]`; no repeat guard: `- ["finishing safely, please wait"] + []` |
| GPT HIGH 3 = Gemini LOW 1: returned record and outcome unsanitized, early ERROR return unscanned | `finalizeRecord` returns `redactCredentialShapesDeep(record)` (`harness.ts:507`); `writeOutcomeScanned` returns the sanitized outcome (`run-row.ts:328`); both early ERROR returns go through `errorOutcome` (`:161`, `:166`, `:293`); every printed line through `safeLine` (`outcomeLines`, `:347`, used at `:495`); `redactCredentialShapesDeep` (`cred-shape-scan.ts:525`) scans each string in its `{"key": value}` context | `returned records, outcomes and console lines hold no part of a credential (R7-3) > finalizeRecord returns the record sanitized: notes, check detail, error`; `... > errorOutcome (the harness-error early return) ...`; `... > writeOutcomeScanned returns failed checks and mutant notes sanitized`; `... > a console line is redacted even for an outcome that skipped every sanitizer` | harness revert: `+ ["eyJqql", "yJqqlA", ...]` (6-char pieces found); run-row revert: 3 of the 4 tests fail |
| GPT MEDIUM: base64 run decoded only to `BASE64_MAX_RUN` | the whole run is decoded in 256 KiB blocks overlapping by 64 KiB, 4-aligned (`base64Blocks`, `cred-shape-scan.ts:293`, used at `:363`) | `encoded and truncated credentials are caught (review round 6) > a key after BASE64_MAX_RUN in a 349,588-char base64 body is found`; `... > base64Blocks covers a run whole, 4-aligned, each overlap long enough` | `- ["sk-key/base64"] + []` |
| GPT LOW: freeze stated as proven cause | README *Why the default keychain* and the *throwaway-keychain design is removed* paragraph above: the observed sequence, the causal link labelled INFERRED, as in `ai-docs/architecture/keychain.md` | n/a | n/a |

Product check for HIGH 2: the gate covers the whole rotation. `withGate` (`packages/cli/src/auth/accounts/token-manager.ts:515`)
runs `refreshUnderGate` inside one `withRefreshGate`; `exchangeAndPersist` writes the journal, exchanges,
re-reads and persists the final record before it returns, and `withRefreshGate` releases only in its
`finally` (`refresh-lock.ts:93`). So a holder of the gate is never between exchange and persist.

**Remaining gaps (stated, not fixed):**

- The bounded wait is about 60 s: `gateWithin` retries the product's fixed 20 s acquire while time is
  left, so the last try can end up to 20 s past the bound.
- A serve killed while QUEUED for the gate (not holding it) loses nothing; one killed after the bound,
  holding it, can lose a rotation: that case is warned, not prevented.
- ~~The `v2e-real.ts` wiring (real lock, real `security`) has no unit test~~: since round 8 the run itself
  is `v2e-real-run.ts` and is tested; only the live pieces stay untested (see round 8).

## Review round 8 (2026-11-02)

GPT (`response-02.md`, REJECT: 2 HIGH, 1 MEDIUM) and Gemini (`response-01.md`, APPROVE with 1 MEDIUM that
duplicates GPT HIGH 2, and 1 LOW) reviewed the round-7 fixes. All four are fixed in the harness, none
under `packages/`. No row, `run-row.ts`, `e20.ts`, `v2e-real.ts` or `security` ran; the evidence is the
unit suite (458 tests, 13 files) plus real synthetic processes (a bun parent, a node "launcher", `sleep`).
Each fix was reverted (the fixed file copied aside, the fix's lines put back, run, copied back; never git)
and its test failed as shown.

To make the run testable, the main coroutine of `v2e-real.ts` moved into `createRealRun`
(`v2e-real-run.ts`) with every live piece injected; `v2e-real.ts` now only wires the product's gate and
keychain calls, the built `serve` and the `--out` folder.

| Finding | Change | Test | Output with the fix reverted |
|---|---|---|---|
| GPT HIGH 1: a terminal Ctrl-C reached the serves directly (same foreground process group), so the product exited before the parent held the gate | `startServe({detached: true})` starts the tree in its own process group, stdout/stderr still piped (`direct.ts:214`); `killTree(pid, sig, {group: true})` also signals the group (`direct.ts:65`), so a member re-parented to pid 1 is reached; `treeProducer` passes it through; `v2e-real.ts:161` uses it; an `exit` handler kills every registered tree (`v2e-real.ts:191`), since the terminal no longer does. The bench rows keep the default (same group): a Ctrl-C of a row run still reaches its serves, and nothing a row starts can outlive the parent | `R8-1: a detached serve does not get the terminal's SIGINT > SIGINT to the parent's group: the serve lives until the parent's end kills it` (a real bun parent, its own group leader, gets `kill(-pgid, SIGINT)`; the node serve exits 130 on SIGINT); `... > control, same group (the old startServe): the serve exits 130 before the parent's kill`; `... > killTree with group: a member re-parented to pid 1 is still killed`; `R8-1/R8-4: v2e-real.ts wires ... > the serves are started detached, registered at spawn` | detached option removed: `aliveWhileWaiting Expected: true Received: false` (GPT's `childExit: 130` before `parentKillCalled`); group kill removed: `Expected: true Received: false` (orphan alive) |
| GPT HIGH 2 = Gemini MEDIUM (1-3): the end snapshotted `before` before waiting for the gate; `forceExpiry` wrote after the end began; the main coroutine read the keychain and the log beside the end and overwrote `report.error`; a serve still starting was not registered | the restore decides with the gate HELD (`before` read inside the callback, `v2e-real-run.ts:164`); `forceExpiry` asks `stopping` under the gate on entry and right before the snapshot and write, no await between that check and the write (`v2e-real-lib.ts:83`, `:91`); `halt` after every await point: before/after forcing expiry, before/after each `startServe`, before the race, after the race, after the item read (`v2e-real-run.ts:225-277`); once the end began the main coroutine's error goes to `report.stoppedAt`, never over `report.error` (`:322`); each serve registered at spawn (`onSpawn`, `:135`, `:245`), killed with `confirmGone`, and one spawned after the end began is killed at once (`:139`); `startServe` now notices a child killed by a signal (`signalCode`, `direct.ts:239`) instead of polling to its readiness timeout | `R8-2: the main coroutine and the end never run beside each other > interrupt while forceExpiry is queued behind a held gate: no expiry write, original expiry kept`; `... > interrupt during postMessage: no keychain or log read beside the end, the signal stays the error`; `... > interrupt during startServe: the serve still starting is killed and confirmed gone` (real `startServe`, a node launcher that never becomes ready); `... > a serve spawned after the end began is killed at once`; `R7-1: ... > R8-2: the end began while forceExpiry waited for the gate: nothing written`; `... > R8-2: the end began during forceExpiry's read: nothing written` | stop check AND lazy snapshot removed: one write `expiresAt: 0`, no restore (GPT's `remainingExpiry 0`); stop check alone removed: two writes (forced, then restored) where none is expected; `halt` after the race removed: `+ ["readAccountsLog stopping=true"]` and a second read after the stop; `onSpawn` not passed: 3 tests fail (`Expected: true Received: false`); `signalCode` check removed: `Expected: < 5000 Received: 20025` |
| GPT MEDIUM: a base64 match was placed at its run's start, so a run that began in an earlier file window lost every match in later windows | each decoded match is placed at the encoded 4-char groups that carry it: decoded byte `d` of alignment `shift` is group `shift + 4*floor(d/3)` (`cred-shape-scan.ts:338`, used at `:388`); the JSON-unescaped view maps through its own index first. Ownership and dedupe use that position; the redaction now replaces only those groups | `encoded and truncated credentials are caught (review round 6) > R8-3: a base64 run longer than one file window > a key past SCAN_CHUNK_BYTES + SCAN_OVERLAP_BYTES in one run of a >4.06 MiB file is found once` (offset asserted exactly); `... > a key in the overlap after the first window's owned bytes is found once, by the second window` | `- ["sk-key/base64"] + []` (GPT's `fileWindowFindings: 0`); offset `Expected 4195315 Received 15` (the run's start) |
| Gemini LOW: `report.error` and console lines unredacted; `serve-*` logs and `v2e-real.json` written raw before the scan | every console line and `report.error` through `redactCredentialShapes` (`v2e-real-run.ts:120`); every file of `--out` (config, slots, both serves' stdout/stderr, `v2e-real.json`) through the injected scanned writer, `writeScanned` in `v2e-real.ts:177`; a value redacted on write fails the run and is listed in `credentialShapeScan.redactedOnWrite` (`v2e-real-run.ts:127`) | `R8-4: ... > a startServe error quoting a credential: report.error, the console and v2e-real.json hold none of it`; `... > a credential in a serve's stderr: written redacted, named, and the run fails`; `R8-1/R8-4: v2e-real.ts wires ... > no file of --out is written except through writeScanned`; `... > no console line bypasses the run's redacting printers` | line redaction removed: `Expected to contain: "<redacted" Received: "serve did not start: ... Bearer sk-proj-0fd3…"`; write findings dropped: `scan.found Expected: true Received: false`; wiring back to `writeFileSync` and no `detached`: both source pins fail |

**Remaining gaps (stated, not fixed):**

- The lazy restore snapshot is not pinned on its own: with the `forceExpiry` stop check in place no
  expiry can be written after the end began, so reverting only the lazy read changes no outcome. The
  test fails when the stop check alone, or both, are reverted.
- A detached serve is not reached by the terminal. If the parent itself is SIGKILLed, neither the end nor
  the `exit` handler runs, and the serves keep running until killed by hand (`ps -o pid,pgid,command`
  shows them in their own group).
- A serve killed while still starting has no `ServeProc`, so its stdout and stderr are not written to
  `--out`; its `serve did not start` error text is kept, redacted, in `report.stoppedAt`.
- A serve spawned after the end finished (a `startServe` already past its stop check when the end
  completed) is killed only by the `exit` handler, not confirmed gone before the report is written.
- The live wiring (real lock, real `security`, real `serve`) still has no executed test; it is pinned by
  source (`detached: true`, `writeScanned`, the two printers) and the run it calls is tested.

## Review round 10 (2026-11-03): the `--account` file-store change

Reviewers: `gemini-4-argon` APPROVE, no findings; `gpt-6.1-sol` REJECT, one HIGH. Both traced the
product's refresh of a `legacy-codex-file` account to the same lock as the script
(`legacy-codex.lock`, through `AccountPool.managerFor` → `accountRefreshLockPath`) and found the
"NOT V2e" labels honest. Session: `ai-docs/sessions/team-20261103-review10/`.

GPT HIGH 1, confirmed in the source: `codex-oauth.json` has a writer that does not take the refresh
gate. `CodexOAuth.login()` saves without it by design (`codex-oauth.ts:478`; the product closes the
hazard on the refresh side with a pre-persist re-read). Its managed-account refusal reads only the
ACTIVE config (`management.ts:117`), so `claudish --config <legacy-only file> login codex` passes it
and writes the real `codex-oauth.json`. A login landing between the script's gated read and its write
would be overwritten with the captured older token, and the script's checks would not see it.

Fix: `compareAndWriteStore` (`v2e-real-lib.ts`) wraps the file store; every force and restore write
re-reads first and refuses unless generation and fingerprint are still those of the record being
written: the product's own defence. Three tests in `v2e-real-file.test.ts` (R10); with the check
disabled, the two interleaving tests fail. 471 bench tests pass.

Stated gap: the window shrinks to the gap between that re-read and the write (the same gap the
product's refresh accepts); it is not closed. Closing it needs the product login to take the gate.
The alternate-`--config` bypass of the managed-account refusal is a product defect, filed by triage as MTL-371.

## Review round 11 (2026-11-03)

Both reviewers APPROVE with no finding at any severity (`gpt-6.1-sol`, `gemini-4-argon`; session
`ai-docs/sessions/team-20261103-review11/`). Both confirmed that `compareAndWriteStore` guards the force
and the restore, that the normalised read of `LegacyCodexFileStore` gives no false refusal on an
ordinary write, that the R10 interleaving tests fail with the comparison disabled, and that the residual
window is stated accurately.

## Open review findings

Eight external review rounds (`gpt-6.1-sol`, `gemini-4-argon`) ran on this harness. Round 8's findings are
fixed in the harness (*Review round 8*); its remaining gaps are listed there.

## Rerun

```bash
bun install --frozen-lockfile                          # a fresh worktree has no node_modules
bun run --cwd packages/cli build                       # build once; the bench never rebuilds
bun ai-docs/benches/account-pool-validation/mutants.ts --check   # expect: 33 OK, 0 BAD
bun ai-docs/benches/account-pool-validation/run-row.ts --list
SESSION_PATH=<dir> bun ai-docs/benches/account-pool-validation/run-row.ts --all
# expect the last line of rows-summary.md: PASS=32 FAIL=0 DEAD-MUTANT=0 ERROR=0 of 32 run row variants.
```

E20 needs a baseline worktree at `579114b1` with the seam backported by hand and built:

```bash
bun ai-docs/benches/account-pool-validation/e20.ts --baseline <baseline-worktree> --out <dir>
```

Do not pipe `run-row.ts` through `tee`; results are files. The README in the bench directory lists
the traps. The recorded `seam-backport.diff` lives in the gitignored session directory, so recreate
the four edits described under *E20* if you rerun it.
