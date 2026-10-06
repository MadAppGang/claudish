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

**It SNAPSHOTS files.** `GUARDED` lists `~/.claudish/config.json` and
`~/.claudish/all-models.json`. Each is read before the run and compared after.
Present and changed → restored from the snapshot. Absent before and present
after → DELETED, because on a clean machine a test fixture that survives becomes
the machine's first real catalog, and a cold cache is indistinguishable from a
poisoned one to every caller. Present but unreadable → it refuses and says so,
which is why `snapshot()` establishes presence with `existsSync` separately from
reading the bytes: folding "unreadable" into "absent" would make the delete
branch destroy the file.

**It PREVENTS three things outright,** via env vars set on the child:

| Variable | Stops | Why prevention, not restore |
|---|---|---|
| `CLAUDISH_DISABLE_KEYCHAIN=1` | `security` against the login keychain | A keychain mutation cannot be snapshotted the way JSON bytes can |
| `CLAUDISH_DISABLE_OP=1` | 1Password handshakes | Denials suppress authorization machine-wide for 15s, for every process |
| `CLAUDISH_DISABLE_CATALOG_WARM=1` | the live hosted-catalog fetch | The restore returns the bytes; it cannot return the hermeticity |

The third was added 2026-09-15 and is gated inside `refreshCatalog()` rather than
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

`e2e-channel.test.ts` Group 2 spawns a real `claude -p`, so it needs a working credential.
It gates on a genuine probe — one tiny headless prompt, treating a login/credential error as
"not usable" — which is the right design. But the probe itself lived inside
`if (!SKIP_LIVE_E2E) { … }`.

So running with `CLAUDISH_SKIP_LIVE_E2E=1` — which is the normal, recommended way to run this
suite — meant the probe never executed, `claudeUsable` stayed `false`, and Group 2 reported:

```
[e2e-channel] Group 2 SKIPPED — `claude -p` is unavailable or not authenticated
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

`channel/test-helpers/captured-stream-json.ts` reads real captured stream-json frames at
MODULE LOAD, via an IIFE. Its `PROBE_DIR` originally pointed at
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

## Pane tests: a real magmux, a fake child, nothing left behind

MCP `team` slots and `create_session` run as interactive Claude Code in headless magmux panes
(`pane-session.md`), so every suite that starts one — `pane/*.integration.test.ts`,
`pane/pane-registry.test.ts`, the channel and team suites, `mcp-contract.e2e.test.ts`,
`mcp-shutdown.e2e.test.ts` — runs a REAL `magmux --headless`. The transport's behaviour (frames,
`exit` events, `close_pane`, slow-subscriber drops, socket paths) is magmux's, and a simulated
magmux would test our model of it instead.

**The child is the fake, never Claude Code.** `pane/test-helpers/fake-interactive-child.ts` is
started through `CLAUDISH_BIN` (a `*.ts` value becomes `bun run <file>`). It draws the REPL with
lines copied from the phase-2 screen fixtures, reads raw keystrokes with the key semantics measured
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
into a temp directory. `CLAUDISH_PANE_ROOT` is a fresh `/tmp/cpt-<8 hex>` per test or layout:
short, so socket paths stay under magmux's 100-byte limit, and never the user's
`/tmp/claudish-mux-<uid>`, whose startup sweep and 48-pane limit belong to the user's own
sessions.

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
