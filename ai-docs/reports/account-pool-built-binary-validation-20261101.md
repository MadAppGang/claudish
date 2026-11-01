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
- HOME is never the real home, and the child env is a whitelist.
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
| V2e | Needs a throwaway keychain (`security create-keychain`), which touches the keychain search list; Jack's decision |
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

## Open review findings (not fixed)

Five external review rounds (`gpt-6.1-sol`, `gemini-4-argon`) ran on this harness. `gemini-4-argon` approved
rounds 2 and 3 with no HIGH finding. `gpt-6.1-sol` rejected each round and every round's HIGH findings were
fixed except those of round 5, which stay open by decision. None is evidence that a recorded run misbehaved;
each is a way a future run could pass when it should fail.

- HIGH, `direct.ts:151-166`, `e20.ts:473-488`: the parent `fetch` calls follow redirects. The offline
  sandbox contains the product child, not the Bun parent, so a product response redirecting to a
  non-loopback host would make the parent contact it. Fix: `redirect: "manual"` and treat a redirect as a
  captured failure.
- HIGH, `e20.ts:824-854`: a mutant counts as red on any difference from the unmutated candidate, without a
  check that the request reached the intended upstream path. The saved endpoint-mutant capture does contain
  `POST /backend-api/codex/mutant`. Fix: require the mutation-specific request and classify missing upstream
  contact as ABORTED.
- MEDIUM, `harness.ts:299-301,321`: the leak scan skips files over 5 MB without failing, and issued tokens
  (`at-rotated-N`) are matched by shape only, not by exact value.

## Rerun

```bash
bun install --frozen-lockfile                          # a fresh worktree has no node_modules
bun run --cwd packages/cli build                       # build once; the bench never rebuilds
bun ai-docs/benches/account-pool-validation/mutants.ts --check   # expect: 32 OK, 0 BAD
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
