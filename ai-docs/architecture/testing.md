> The SSE-replay format-translation harness, the shared resources a test must never reach, hermetic pane tests against a real magmux, and the opt-in live pane tests.
>
> Extracted from `CLAUDE.md` (v7.64.0). Indexed in [`README.md`](./README.md).

# Test Infrastructure

## Format Translation Test Harness
`packages/cli/src/format-translation.test.ts` — SSE replay tests for the full translation pipeline.

**Fixture-based**: Each `.sse` file in `test-fixtures/sse-responses/` is a captured SSE stream from a real provider response. Tests replay fixtures through the stream parser and assert correct Claude SSE output.

**Helpers**: `parseClaudeSseStream()`, `extractText()`, `extractToolNames()`, `extractStopReason()`, `fixtureToResponse()`

**Adding regression tests**: After extracting fixtures from a debug log, add a `describe("Regression: <model>")` block. Template is at the bottom of the test file.

## Three shared resources a test must never reach, and why prevention beats restore

`scripts/guard-real-config.ts` — the thing `bun run test:safe` runs the suite
under — does two separate jobs, and conflating them is how each keeps decaying.

**Live sessions write these files during a run, so the guard repairs only damage.** A full
`test:safe` takes 31-43 minutes, and on a working machine about 40 live claudish sessions write
the guarded files in that window: `config.json` on every stats or telemetry save, the TUI and
account management; the catalog caches on refresh; `accounts/allowance-alerts.json`. The guard
used to write the pre-run bytes back over every changed file and fail the run, which threw those
writes away and turned a green suite red. Now a test write cannot reach the real files at all
(the run home, below), so a change that leaves a file VALID is kept, reported as a warning, and
the exit code is the tests' own.

**It SNAPSHOTS files.** `GUARDED` lists the config, the catalog caches and sentinel, and
the credential stores below. Each is read before the run and compared after, and each carries one
closed `validity` kind that says what "valid" means for it:

| `validity` | Entries | Valid when |
|---|---|---|
| `json-object` | every non-secret file | parses to a non-null, non-array object |
| `refresh-token` | the login stores | a non-empty string `refresh_token` |
| `parseable` | `accounts/state.json` | any parseable JSON, `null` included |
| `hex-key` | `dynamic-models-catalog.key` | 64 hex characters (surrounding whitespace ignored, as the store's reader does) |

| Post-run state | Action | Exit |
|---|---|---|
| unchanged | none, silent | child |
| valid, changed or created | kept: `WARNING — kept <path>`, the key delta, the `.guard-backup` path; a secret is forced to 0600 | child |
| `config.json` valid but lost top-level keys | kept, and the pre-run bytes written to `config.json.guard-kept-<UTC stamp>` (created exclusively, 0600) | child |
| existed, now deleted, empty, unparseable, the wrong shape or unreadable | `MUTATED`, restored from the snapshot through a same-directory temp file renamed over it; a non-secret file gets its pre-run mode, a secret 0600 | 1 |
| created and invalid, non-secret | `MUTATED`, RENAMED to `<path>.guard-created`, never deleted | 1 |
| created and invalid, secret | `MUTATED`, deleted (test data, not a login) | 1 |
| unreadable before, invalid or absent after | `CANNOT RESTORE`, left alone | 1 |
| a restore threw | `RESTORE FAILED`, left alone | 1 |

`.guard-backup` is rewritten at the start of every run, so the run after a bad one would copy test
data over the only good copy; that is why a kept `config.json` that lost keys gets its own
timestamped `.guard-kept-*` copy. The original incident removed `onepasswordAccount`, which is
exactly that signature. Present but unreadable → it refuses and says so, which is why `snapshot()`
establishes presence with `statSync` and an explicit `ENOENT` test, separately from reading the
bytes: `existsSync` answers `false` on every stat error, and folding "unreadable" into "absent"
would send the file down the created-file branch.

Every repair overwrites, deletes or moves the file, so `settle()` reads it again just before one
and classifies that newer state if it differs from the post-run snapshot. With the run home in
place, damage on a real file most likely comes from a live session (a logout, then a login), and
that session's next write can land between the post-run snapshot and the repair. The file is read
again once, so a file rewritten without pause still gets a decision. This narrows the window to
the repair itself; it cannot close it, and no lock exists that every writer honours.

The sentinel directory and the run home are both removed in `finish()`, each in its own `try`. A
failed removal is reported (`could not remove ...`) and never changes the exit code: both hold
only test data, and a leftover temp directory is not a reason to fail a green run.

**The real directories (`GUARDED_DIRS`) are reported, never restored, never failed on.** The usage
ledger and the stored dynamic models catalogs are compared by file set and sizes;
a delta prints `<label> changed during the run` and `Not restored`. Truncating a ledger segment
would delete rows a live session appended, and live sessions append to both all the time.

**Credential files are SECRET entries.** `codex-oauth.json`, `grok-oauth.json`,
`gemini-oauth.json`, `kimi-oauth.json`, the Muse stores, `accounts/state.json` and the dynamic
models catalog key get no `.guard-backup` sidecar (a second plaintext copy of a real login that
`claudish logout` never removes); the in-memory snapshot is the only restore path, and a restored
or kept secret is always 0600. A secret the run left VALID but different is KEPT, because Codex
and Grok rotate refresh tokens: a concurrent claudish process may have refreshed during the run,
and writing the old document back reinstates a consumed refresh token (`refresh_token_reused`,
which can revoke the grant). A valid login created during the run is kept at 0600 too. Identical
bytes with a new mode are only chmodded back to 0600 (`Repaired secret file permissions to
0600.`). Only a mode change the run made counts; a login that was already 0644 before the run is
the developer's state. SIGINT and SIGTERM are forwarded to the child so Ctrl-C still repairs.
Credential files were added 2026-10-21 after a full run deleted the real `codex-oauth.json`: a
test-only singleton reset replaced `CodexOAuth`'s instance, the credential authority kept the old
one, and a test's `credentials.logout()` reached it. Reset singletons IN PLACE.

**Exit rule:** damage, a run-home tripwire hit or a termination signal → 1; otherwise the
child's exit code.

**It PREVENTS things outright,** via the child's environment:

| Variable | Stops | Why prevention, not restore |
|---|---|---|
| `CLAUDISH_DISABLE_KEYCHAIN=1` | `security` against the login keychain | A keychain mutation cannot be snapshotted the way JSON bytes can |
| `CLAUDISH_DISABLE_OP=1` | 1Password handshakes | Denials suppress authorization machine-wide for 15s, for every process |
| `CLAUDISH_DISABLE_CATALOG_WARM=1` | the live hosted-catalog fetch | The restore returns the bytes; it cannot return the hermeticity |
| `HOME` = the run home (`claudish-guard-home-*` under the temp dir, also named in `CLAUDISH_GUARD_RUN_HOME`); `CLAUDISH_ACCOUNTS_DIR`, `CLAUDISH_CONFIG`, `CLAUDISH_DYNAMIC_CATALOG_DIR`, `CLAUDISH_DYNAMIC_CATALOG_KEY` removed | any write to the real `~/.claudish`, including by production code a test spawns with no `env` option | A live session's write and a test's write look the same in a real file; only keeping tests out of it tells them apart |

**The run home and its tripwire.** The bun test preload replaces a `HOME` equal to
`CLAUDISH_GUARD_RUN_HOME` with a fresh `claudish-test-home-*` per `bun test` process, so the three
sequential processes of `bun run test` do not share one. A process still on the run home after
that is one that skipped the preload, and no live session knows the path. After the run the guard
maps every `GUARDED` and `GUARDED_DIRS` path onto the run home; a name present there is reported
as `<label> WRITTEN IN THE RUN HOME`, naming a child spawned with no `env` option as the likely
cause, and the run exits 1. The run home is removed afterwards.

**`CLAUDISH_DISABLE_KEYCHAIN=1` also keeps the legacy Codex file move off** (MTL-372) for the
whole suite. The move copies `~/.claudish/codex-oauth.json` into the Keychain and deletes the
file. It runs on the first Codex sign of any process whose config is the default one, so an
in-process test that installs a darwin keychain fake without the flag reaches it with the real
`HOME`, where `activeConfigFile()` was built from `os.homedir()` at module load. A hand-run `bun
test` does not go through this guard, and that is how the move once reached a developer's real login
(2026-11-03): the test preload now sets the flag and a temporary `HOME` for EVERY `bun test` run (see
"The home guard" below). A test that wants the move installs the fake `security`
(`auth/accounts/fake-security.test-helper.ts`, see `keychain.md`) in a child process with a temp
`HOME`, and deletes the flag only inside that child, after the fake is installed. The parent keeps
the flag.

The catalog flag was added 2026-09-15 and is gated inside `refreshCatalog()` rather than
`warmCatalog()`, because `ensureCatalogReady()` refreshes through the same
function — a gate on one of two entry points is how a gate stops being true. It
returns `reason: "disabled"`, never `"network"`: a caller that logs "the catalog
could not be reached" when nothing tried to reach it sends the reader to debug a
working connection.

**What it caught, and how the leak hid.** `createProxyServer` fires
`warmCatalog().catch(() => {})` unconditionally (`proxy-server.ts:1193`), so
`handlers/explicit-spec-no-credential.test.ts` live-fetched the hosted catalog
and rewrote the real `all-models.json` with a fresh `lastUpdated` — even though
that file's own header says "no network call happens", which was true of the
upstream model call and wrong about the proxy.

It hid itself by RACING. A sibling file cleaned up with
`_setCatalogEntriesForTest(null)`, and `null` is not a reset: the read path
short-circuits on `!== undefined`, so it is a sticky process-wide "catalog is
empty" override. Every later lookup returned instantly, the process exited
before the ~2s fetch resolved, and the write never landed. Whether the leak was
visible depended on which files ran alongside it. `_resetCatalogClient()` is the
real teardown; `_setCatalogEntriesForTest(null)` belongs only inside a test body
that wants the cold-catalog state.

Evidence: that file tripped the guard 3/3 times alone at ~2.0s, ran clean at 55ms
against a dead catalog host, and runs at 66ms with the kill switch. This is the
same non-hermeticity that turned two DeepSeek tests red mid-release when the
hosted catalog changed its answer.

## A gate must not also gate its own diagnostic

`e2e-sessions.test.ts` Group 2 spawns a real `claude -p`, so it needs a working credential.
It gates on a genuine probe — one tiny headless prompt, treating a login/credential error as
"not usable" — which is the right design. But the probe itself lived inside
`if (!SKIP_LIVE_E2E) { … }`.

So running with `CLAUDISH_SKIP_LIVE_E2E=1` — which is the normal, recommended way to run this
suite — meant the probe never executed, `claudeUsable` stayed `false`, and Group 2 reported:

```
[e2e-sessions] Group 2 SKIPPED — `claude -p` is unavailable or not authenticated
```

**That message is a claim about the environment that the environment was never asked.** It is
indistinguishable from the same message on a machine with genuinely no credential, and it was
repeated in status reports for hours as "environment-gated" when the real answer was "not
asked". Removing the flag ran the probe and recovered the tests; with a credential present,
all 15 in the file pass with zero skips.

**The general form: a mechanism that reports state must not be disabled by the same switch
that disables the work.** Where a skip is conditional, its REASON must be computed
unconditionally, or the skip message must say "not checked" rather than naming a cause. A
diagnostic that is silenced along with the feature cannot tell you why the feature is off —
it can only repeat its default.

Same shape as `team`'s exit 0 (`team-capture.md`): a status whose failure mode is to look
like a confident answer. Prefer "unknown" to a plausible guess in any automated report.

## A fixture must live where the test lives, never in scratch space

`channel/test-helpers/captured-stream-json.ts` (the directory is now `mcp-session/`) read real
captured stream-json frames at MODULE LOAD, via an IIFE. Its `PROBE_DIR` originally pointed at
`ai-docs/sessions/dev-arch-*/probes/` — where the probe that recorded them happened to write.

`.gitignore:56` excludes `ai-docs/sessions/`. So the files existed on exactly one machine and
in no clone. In CI the `readFileSync` threw during module init, the exported consts were never
assigned, and every test in the file died with:

```
ReferenceError: Cannot access 'CAPTURED_ASSISTANT_FRAME' before initialization.
```

which names a symbol, not a missing file — the real cause is two frames up the stack.

Fixed by copying both captures VERBATIM into `packages/cli/src/channel/test-helpers/captures/`
and pointing `PROBE_DIR` at `resolve(import.meta.dir, "captures")`. Byte-identical: fixtures
come from real logs and must never be regenerated or reformatted in a move. (That helper and its
captures were later deleted with the stream-json child transport; the rule stands, and the pane
fixtures under `pane/test-fixtures/` follow it.)

**The rule, stated generally:** a fixture is BY DEFINITION something meant to outlive the
session that produced it, so a session directory is never its home — however convenient that
is at capture time. CLAUDE.md already warns that `ai-docs/sessions/` "does not survive a fresh
clone or `git worktree remove`" and that "three write-ups already died this way". This was the
fourth, and the first to take a test gate down rather than a document.

The trap is that it is invisible locally in the only direction that matters: the suite is
green on the machine that recorded the captures and red everywhere else, so local green is not
weaker evidence than CI red — it is ACTIVELY MISLEADING. Same family as the gated diagnostic
above: a signal that reports success because the question could only be asked where the answer
was already yes.

Cheap check before trusting any new fixture: `git ls-files <path>` must list it, and
`git check-ignore -v <path>` must say nothing.

## A red local suite may just be a newer bun than CI pins

`.github/workflows/test.yml` pins `bun-version: "1.3.10"`. A developer machine on a
newer bun runs different bundled Unicode tables, and `tui/viz/color.test.ts` measures
claudish's `displayWidth` fallback against a RUNTIME oracle. So the oracle moves with
the runtime while the fallback table does not.

Measured 2026-09-04 on bun 1.4.0: two `displayWidth` tests fail locally on
U+2630–U+2637 and U+268A–U+268F (Yijing trigram and monogram symbols), whose East
Asian Width classification differs between the two bun releases. The same commit's
`Tests` run on main is GREEN on the pinned 1.3.10.

**Do not "fix" the width table to match the newer bun** — that inverts the failure and
breaks the pinned CI. Before treating any hermetic red as a regression, check the local
runtime against the pinned one and look at whether CI is green on the same SHA. A test
that compares against a runtime-provided oracle is only as stable as the runtime.

Distinct from the credential-gated live tests, which skip in CI and are documented as
non-blocking; this one is hermetic and still environmental.

**The reverse holds too: a GREEN local suite on a newer bun can hide a red CI.** Measured
2026-10-06: the pane suites passed 4964/36/0 on bun 1.4.0 and failed 118 tests under the pinned
1.3.10. On 1.3.10, `net.connect(path)` to a unix socket that does not exist yet emits ENOENT
synchronously inside `connect()`, before any listener can be attached, and `bun test` reports it as
an unhandled error; 1.4.0 defers the event. `MagmuxClient`'s dial now attaches its listeners to a
`new Socket()` before calling `connect`. Run `bunx bun@<pinned> test` before calling a change that
touches sockets, timers or child processes green.

**Since 2026-09-15 the two budgeted sweeps enforce this themselves.** They read
`bun-version` out of `test.yml` at test time and `test.skipIf` when `Bun.version`
differs, naming both versions in the skip. Three details are load-bearing:

- The pin is PARSED, never copied. A second hardcoded `"1.3.10"` in the test file
  would drift from the workflow, which is the failure being fixed.
- A parse failure FAILS OPEN and runs the tests. A gate that silently disables
  coverage when it cannot find its input is worse than no gate.
- Only the two oracle-calibrated sweeps are gated. The first test in the block
  asserts five literal widths, is not oracle-dependent, and runs everywhere.

The 2026-09-04 measurement above named `U+2630–U+2637` and `U+268A–U+268F`. The
full sweep on bun 1.4.0 is wider: `total 3017`, of which the `other` bucket —
budgeted at 17 — is 576, almost all `U+1160..U+11FF`, conjoining Hangul Jamo that
1.4.0 measures as zero-width. Same cause, larger blast radius than first recorded.

When the pin is bumped, RE-BASELINE the budgets against the new oracle. Never
widen them to clear a red run: the budget is the entire assertion.

## A green local suite can be reading the developer's own `~/.claudish`

The guard snapshots and prevents writes. It does nothing about READS. A production
fallback that asks "what is on disk under `homedir()`" answers from the developer's
real state, and Bun keeps `homedir()` on the real home even when a test assigns
`process.env.HOME`. The test is then green on every developer machine that has the
file and red on the clean runner, which has none.

Measured 2026-10-20 on PR #301, two cases, both green locally under `test:safe` and
red on CI; each reproduced locally by making the read return what a clean runner
returns:

| Test | Real file it read | Local | CI |
|---|---|---|---|
| `openai-codex-refresh-outage.test.ts` C2/E2 "unknown refresh" | `~/.claudish/codex-oauth.json`, through the billing probe's `CodexOAuth.hasCredentials()` fallback (`billing-probe.ts`) | subscription, 503 | metered, 401 |
| `model-selector.muse-code.test.ts` N3 | `~/.claudish/cloud-models-catalog-v3.json`, through `isChatCapable` → `classifyChatCapability` with no `cachePath` | `muse-spark-1.3` is chat | `unknown`, row dropped |

The injected dependency was right in both. The read happened several layers below
it, in code the test never named. Two seams now exist for this:
`registerSubscriptionCredentialProbe` makes the billing probe agree with a fake
credential, and `_setChatCapabilityCachePathForTest` points the chat filter at a
test-owned catalog.

Before calling a test that reaches routing, billing or the picker green, ask what it
would read with an empty `~/.claudish`. CI is the only place that state is empty.

The same CI run showed a third red that was not this class:
`team-cli-signal.test.ts` exited 0 instead of 130 on SIGINT in 5 of 6 local runs,
on `main`'s code as well. `shutdown()` in `pane/pane-registry.ts` awaited a reap
whose last waits (the pane watcher, `waitForExit`'s timer) are unref'd, so Bun
drained the event loop and exited 0 before `process.exit(code)`. The shutdown now
holds the loop with an interval until the reap ends. A test of an exit code under
signals needs `--rerun-each`: one run hides a race that loses more often than it wins.

## A test run never writes into a real session's records (the preload)

A suite run inside a claudish pane (a `create_session` runner, a `team` slot) inherits the pane's
session variables, and `captureUpstreamError` appended the suite's test doubles (`stub`,
`fixture-upstream-error`) to `~/.claudish/sessions/<id>/upstream-errors.jsonl`, so that session's
`get_diagnostics` listed them as upstream failures (`model-failures-2026-10-21.md`, D5).

`scripts/test-preload.ts` deletes `SESSION_ENV_VARS` from `process.env` before the first test file
loads. The six names live in the import-free `scripts/session-env-vars.ts`, each the literal of the
production constant whose writer follows it: `CLAUDISH_UPSTREAM_ERROR_LOG`, `CLAUDISH_HOOK_INBOX`,
`CLAUDISH_HOOK_SESSION`, `CLAUDISH_TOKEN_FILE`, `CLAUDISH_PUBLISHED_TOKEN_FILE`,
`CLAUDISH_PANE_CHILD`. Neither file imports production code: that would load `hooks/`, `config.ts`
and the token tracker ahead of the module-scope snapshots tests rely on. A new session-record
writer means a new name in that list.

**Three bunfig.toml files** register the preload: the repo root, `packages/cli` and
`packages/macos-bridge`. bun reads `bunfig.toml` from the working directory only and never walks
up (measured on 1.3.10 and 1.4.0), and the suite runs from all three.

**The trap: a child spawned with no `env` option gets the ORIGINAL environment back.** Measured
2026-10-22: `Bun.spawn`/`Bun.spawnSync` on 1.3.10 and 1.4.0, and `node:child_process` on 1.3.10 (the
CI pin; 1.4.0's `child_process` sees the deletion). So the preload covers in-process writers (D5's
observed records) and children given `env: { ...process.env }`, and two more layers close the rest:

- `scripts/guard-real-config.ts` deletes the same names from the OS environment of a `test:safe`
  run, so no descendant can inherit them.
- `scripts/spawn-env.test.ts` fails on any `Bun.spawn`, `Bun.spawnSync` or `node:child_process`
  spawn/exec/fork in test code (`*.test.ts(x)` and anything under a `test-helpers/` directory)
  whose options are not an object literal with an `env` key. It parses with the TypeScript
  compiler API, so a comment cannot satisfy it. A site whose options cannot be read statically goes
  in its allowlist with the file, the line text and the reason. 42 sites lacked `env` when it
  landed; each got `env: { ...process.env }`.

Two pane tests "fail inside a pane by design" (`launcher/magmux-wrapper.test.ts`,
`team-grid.e2e.test.ts`). With `CLAUDISH_PANE_CHILD`, `CLAUDISH_PANE_CWD` and `MAGMUX_SOCK` set,
magmux-wrapper measured 16 pass / 9 fail both before and after the preload: the 9 come from
`MAGMUX_SOCK` (the ambient-multiplexer branch), which is not a session-record variable and stays
inherited. team-grid.e2e was 7 / 0 both times in that simulation.

## The home guard: every `bun test` runs on a temporary HOME with the Keychain off

**What happened (2026-11-03, MTL-372 review round 4).** A plain `bun test` ran the legacy Codex
file move against the developer's REAL `~/.claudish` and Keychain. `CodexPoolHalf.getRequestAuth`
starts the move on every Codex sign, and its only test-side guard was `CLAUDISH_DISABLE_KEYCHAIN=1`,
which `test:safe` sets and a plain `bun test` did not.

**What the preload does now** (`scripts/test-preload.ts`, before any test file loads):

- The three prevention flags `test:safe` sets: `CLAUDISH_DISABLE_KEYCHAIN=1`,
  `CLAUDISH_DISABLE_OP=1` and `CLAUDISH_DISABLE_CATALOG_WARM=1`, each unless the environment already
  states a value. The catalog flag became necessary with the empty `HOME`: without it
  `handlers/explicit-spec-no-credential.test.ts` and `unregistered-credential-name.test.ts` (3
  tests) live-fetch the hosted catalog past their 5 s timeout; under the real `HOME` they had been
  reading the developer's cached catalog, the class described above.
- `HOME` becomes a fresh `claudish-test-home-*` directory under the system temp dir, removed at
  exit, unless the inherited `HOME` is already under a temp directory (a parent test that spawned
  this `bun test` with its own throwaway home keeps it). The one temp `HOME` that is always
  replaced is the guard's run home, the value of `CLAUDISH_GUARD_RUN_HOME`: every `bun test`
  process of a `test:safe` run inherits it, so keeping it would let them read each other's files.
- `os.homedir()` follows `process.env.HOME`. **Assigning `HOME` is not enough under Bun.** Measured
  on 1.4.0: `os.homedir()` and `os.userInfo().homedir` return the HOME the process STARTED with,
  whatever `process.env.HOME` says later, and a named `import { homedir } from "node:os"` is not
  reached by patching the `os` object (`require("os")` is). `profile-config.ts` builds its config
  path from `homedir()` at module load, so an env-only preload would have left the default config,
  and the move's "default config" check, on the real home. The preload therefore patches the CJS
  object and `mock.module`s both `node:os` and `os`.

`scripts/test-preload-home.test.ts` proves it from all three bunfig directories: a check file run
under `bun test` with a non-temporary stand-in `HOME` sees a temp home from `process.env.HOME`, a
named import, a module-load constant, the namespace, `require("os")` and `userInfo()`, plus the flag.
It fails 4/5 with the previous preload and 3/5 with an env-only one.

**Which files reached the move.** A static import scan found 247 of 620 test files that can load
`legacy-move.ts`. Each ran alone under the PREVIOUS preload with a throwaway stand-in `HOME` holding a
fake `codex-oauth.json`, a recorder in place of `startLegacyCodexMove` (it asks the real
`legacyMoveApplies`, never moves), every `Bun.spawn`/`spawnSync` of `security` intercepted, and a
fake `security` first on `PATH`. A fake on `PATH` alone is NOT a safe harness: `keychain.ts` spawns
the absolute `/usr/bin/security`. One file started the move: `auth/credentials/codex-pool-legacy-2a.test.ts`
(5 signs, each due). `billing-probe.test.ts` reached the trigger 5 times, never due. Two e2e files
(`mcp-session/e2e-sessions.test.ts`, `team-grid.e2e.test.ts`) ran a bare `security
find-generic-password` (existence only, no `-w`) through `claude-runner.ts`'s Claude Code login check:
a read of the login keychain, not the move. Under the new preload the same harness records zero due
moves.

**Not covered by the preload:** a child spawned with no `env` option gets the original
environment, real `HOME` included (the trap above); `spawn-env.test.ts` forbids that in test
code, but production code a test calls (`claude-runner.ts` spawning `security`) is outside its
reach. Under `test:safe` that gap is closed: the original environment is the guard's, whose `HOME`
is the run home, so such a child writes there, never to the real `~/.claudish`, and the guard's
tripwire fails the run naming the file. A hand-run `bun test` still has the gap.

## Clearing provider keys: derive the list, never hand-write it

`routing-rules.test.ts` cleared a hand list of 24 key names that missed `POE_API_KEY` and every
bundled vendor's key (D4). `test-helpers/provider-credential-env.ts` derives the list:
`providerCredentialEnvVars()` is every `apiKeyEnvVar`/`apiKeyAliases` in `BUILTIN_PROVIDERS` and
`PREDEFINED_ENDPOINTS` (`providerKeyEnvVars()`), the credential names no definition declares
(taken from the reader's constant where one exists: `DEVIN_API_KEY_ENV`,
`VERTEX_PROJECT_ENV_VARS`), and every `CUSTOM_<NAME>_KEY` present; `providerBaseUrlEnvVars()` is
every declared `baseUrlEnvVars`. `clearProviderCredentialEnv()` deletes both and returns the
restore function. A test that needs "no provider key" uses it, so a new provider cannot reopen the
hole.

## Credential files: seams and a redirected HOME

`GrokOAuth`, `KimiOAuth` and the Devin reader re-read their credential files when they change
(`credential-files.md`), so a test that reaches one without its path seam reads, and through a
refresh may write, the developer's real login. Use `setGrokOAuthPathForTesting`,
`setKimiOAuthPathForTesting`, `setKimiDeviceIdPathForTesting`, `KimiOAuth._resetForTests()` and
`setDevinCredentialsPathForTesting`. A test file that imports `auth/credentials/authority.ts` or
`auth/kimi-oauth.ts` should also run in a child spawned with `HOME` set to a temp directory in the
child's environment (Bun resolves `homedir()` from the environment a process starts with, never
from an in-process assignment), so a missed seam lands there.

## Pane tests: a real magmux, a fake child, nothing left behind

MCP `team` slots and `create_session` run as interactive Claude Code in headless magmux panes
(`pane-session.md`), so every suite that starts one — `pane/*.integration.test.ts`,
`pane/pane-registry.test.ts`, the MCP session and team suites, `mcp-contract.e2e.test.ts`,
`mcp-shutdown.e2e.test.ts` — runs a REAL `magmux --headless`. The transport's behaviour (frames,
`exit` events, `close_pane`, slow-subscriber drops, socket paths) is magmux's, and a simulated
magmux would test our model of it instead.

**The child is the fake, never Claude Code.** `pane/test-helpers/fake-interactive-child.ts` is
started through `CLAUDISH_BIN` (a `*.ts` value becomes `bun --no-env-file run <file>`). It draws
the REPL with lines copied from the phase-2 screen fixtures, reads raw keystrokes with the key semantics measured
from the real REPL, and writes its transcript by TEMPLATING real records — never hand-written ones.
A scenario is chosen by `--model fake-<scenario>`, or, in the contract suites' marker mode
(`contract-fake-model`), by markers in the prompt: `@@TOOL@@`, `@@HANG@@` (accepted, never
answered), `@@LINGER@@` (answers, holds the end-of-turn record), `@@LATE@@` (a re-wake after the
answer). A file-delivered prompt is answered `ANSWER <model> <sha1 prefix of the reconstructed
file>`, so a test can prove nothing was lost in delivery. `pane-child-real-claudish.integration.test.ts`
is the one place the REAL child claudish runs: this tree's `src/index.ts` launches the fake in
"claude" mode as Claude Code (via `CLAUDE_PATH`) with a native model, so no proxy request is made,
and the fake dumps the argv, env, cwd and `--settings` it was given.

**The environment is built by ALLOWLIST** (`makePaneTestEnv()`, and `serverEnv(layout)` for a
real MCP server), never by deleting from `process.env`: no `ANTHROPIC_*` or provider key survives
because none is listed, and `HOME`, `CLAUDE_CONFIG_DIR`, `ZDOTDIR` and `XDG_CONFIG_HOME` all point
into a temp directory. `CLAUDISH_PANE_ROOT` is a fresh `/tmp/cpt-<8 hex>` per test or layout,
never the user's `/tmp/claudish-mux-<uid>`, whose startup sweep and 48-pane limit belong to the user's own
sessions.

**Drop `CLAUDISH_PANE_CHILD` from any env spread from `process.env`.** The flag reaches everything a
claudish-started session runs ([`pane-session.md`](pane-session.md) § One level of nesting), so a
suite launched from inside one (a runner in a `create_session` pane) inherits it. A claudish child
spawned with `...process.env` then refuses to run a model (exit 64, `nested session refused`), and
an MCP server spawned that way lists 4 tools instead of 14. Build the env by allowlist, or set
`CLAUDISH_PANE_CHILD: undefined` explicitly. `scripts/guard-real-config.ts` deletes the flag for
`bun run test:safe` as a second layer; a hand-run `bun test <file>` from such a session gets no
such help.

**Every test asserts that nothing outlived it** (`assertNoOrphans`, `paneOrphans(layout)`): no
process whose argv contains the test's root or a session uuid, no process left in any pane
process group, and no socket, pane record or launcher directory in the root. That assertion is
what proves the reap; a green suite without it would hide a REPL left billing.

**A missing magmux is "not checked", never a cause.** Without magmux these suites skip with
`magmux not installed — not checked` (the gated-diagnostic rule above). CI installs it
(`brew install MadAppGang/tap/magmux` in `test.yml`), so the pane suites run there on macOS.

**Time is a seam, and a budget measures a code path, not wall-clock under contention.**
`PaneSessionOptions.timings` scales the quiet windows, the degraded-mode entry and the resend delay
for tests (production never passes it), and the integration suite runs its groups with
`describe.concurrent` (43 tests in ~50 s instead of ~250 s), each test owning its env and root. Two
measured traps:

- At a load average of 85–88 from another session, one full run produced 14 timing failures across
  the pane, registry and session-manager suites — and also exposed a real defect (`shutdownAll`
  skipped starts still in flight), so a red run under load still needs reading before it is
  dismissed.
- REQ-18 asserted the team record's `meta.json` within 1 s of `team(mode:"run")` returning. With
  panes, `run` returns once each prompt is accepted, so that interval also held the fake's turn and
  the 500 ms settle corroboration, and it failed at 1,013–1,014 ms under load while the record path
  took milliseconds. It now measures from the run's settle (the last slot's `completedAt`) to the
  record's `completedAt`, and still fails (1,505 ms) when the end is delayed onto a later poll.
  Measure the thing the requirement is about; never just raise the number.

**Fixtures are real captures, and a test greps them.** `pane/test-fixtures/` holds screens,
transcripts, frames, token files and a `ps` table from Claude Code 2.1.290 in a headless pane
(`reports/mcp-magmux-panes/phase2-captures.md`); the two corpus slices were redacted with
`scripts/redact-transcript-fixture.ts`. `fixtures-redaction.test.ts` fails on a home path, a
credential or an e-mail address in any of them.

**Live pane tests are opt-in.** `pane-live-claude.integration.test.ts` drives the REAL Claude Code
(native haiku) through `PaneSession` and spends money, so it runs only when asked:

```bash
CLAUDISH_PANE_LIVE=1 CLAUDE_CODE_OAUTH_TOKEN=<token> \
  bun test packages/cli/src/pane/pane-live-claude.integration.test.ts
```

The config directory is hermetic, and a hermetic config directory is "Not logged in": Claude Code
keys its keychain item by config directory, so redirecting `HOME` or `CLAUDE_CONFIG_DIR` loses the
login. The token therefore comes from the operator's environment; the test never reads the
keychain or `~/.claude`. Likewise `bun run test:mcp` (`mcp-e2e/`) needs live 1Password and the real
config and is not part of `test:safe`. To drive one session by hand, use `scripts/pane-drive.ts`
(`--fake <scenario>` for the hermetic fake).
