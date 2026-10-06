# Implementation log

## Baseline (cf4f7835)

Measured 2026-10-06 before any Phase 1 edit. The worktree had NO `node_modules`
(tests had been resolving through the main checkout's tree and `tsc` failed with
`Cannot find type definition file for 'bun-types'`); `bun install --frozen-lockfile`
was run first, then:

- `bun run typecheck` — exit 0 (cli + macos-bridge).
- `bun run test:safe` — exit 0.
  - packages/cli: **4644 pass, 33 skip, 0 fail** (4677 tests, 306 files, 697 s).
  - packages/macos-bridge: 20 pass, 0 fail.
  - scripts/*.test.ts: 5 pass, 0 fail.
- Pre-existing failures: none.

Raw logs: `impl1/baseline-typecheck.log`, `impl1/baseline-test.log` (session dir, gitignored).

## Impl phase 1

Start 2026-10-06 11:07:49 · end 2026-10-06 11:55:49 · branch `worktree-claudish-mcp-magmux`,
base cf4f7835, head 68e30e53. Not pushed.

### Commits (one per fix, each test proven to fail without its fix by a mutation run)

| sha | subject | covers |
|---|---|---|
| 5fb09b27 | fix(session): slug every non-alphanumeric cwd character in transcriptPathFor | F1 |
| 341f353d | fix(session): read CLAUDE_CONFIG_DIR for the transcript projects dir | F2, `projectsDir(env)` |
| 26df1140 | fix(statusline): read an inherited CLAUDISH_TOKEN_FILE in the status line | F3 |
| b623e1e0 | fix(runner): strip CLAUDE_CODE_CHILD_SESSION from interactive Claude Code | F4 |
| f9e1478b | fix(mcp): map the awaiting_permission channel event to input_required | F5, union + map key |
| 7c78bcb8 | refactor(recovery): read magmuxPaneCapability in the ambient UI branch | F8 |
| 22c3b42b | refactor(cli): extract parseArgs's token rule as classifyPassthroughTokens | walker |
| cc03e91d | feat(mcp): apply the CLAUDISH_PANE_ENV snapshot in a pane child claudish | ENV markers, `pane/child-env.ts`, child-side assertion |
| 0a05a2e7 | fix(recovery): drop the retry watchdog in MCP pane children | D22 |
| 20734c1f | feat(mcp): set skipDangerousModePermissionPrompt in a pane child overlay | overlay + merge key (D5) |
| c5ecf085 | feat(mcp): strip the CLAUDISH_PANE_* markers from Claude Code's env | marker strip |
| 68e30e53 | chore(mcp): sort the channel/types import in mcp-server.ts | biome organizeImports error left by f9e1478b |

### Files changed (19; +1525 / −72)

Source: `session/session-discovery.ts`, `session/session-stats.ts`, `claude-runner.ts`, `launcher/magmux-wrapper.ts`,
`cli.ts`, `index.ts`, `config.ts`, `pane/child-env.ts` (new), `channel/types.ts`, `channel/stream-json-reducer.ts`,
`mcp-server.ts`. Tests: `session/session-discovery.test.ts`, `claude-runner-token-file.test.ts` (new),
`claude-runner-child-env.test.ts` (new), `channel/event-task-status.test.ts` (new), `recovery/settings.test.ts`,
`cli-passthrough-walker.test.ts` (new), `pane/child-env.test.ts` (new), `force-login-method.test.ts`.

### Quality checks (after the last commit)

- `bun run format` — 702 + 20 files, no fixes applied.
- `bun run lint` — exit 0 (warnings only: 995 cli + 22 bridge; none new in touched functions after the
  walker was split to stay under the complexity limit).
- `bun run typecheck` — exit 0.
- `bun run test:safe` — exit 0.
  - packages/cli: **4736 pass, 33 skip, 0 fail** (4769 tests, 311 files, 698 s) vs baseline 4644/33/0
    (4677, 306 files): +92 tests, +5 files, no new failures, skip count unchanged.
  - macos-bridge 20/0, scripts 5/0 (unchanged).

Raw logs: `impl1/final-{lint,typecheck,test}.log`.

### Deviations from the plan (with reason)

1. **`bun install --frozen-lockfile` before the baseline.** The worktree had no `node_modules`.
2. **F8 is `refactor(recovery)`, not `fix(...)`.** Before D22 the old ambient expression and
   `paneCapability.kind === "ambient"` are equivalent, so the commit changes no behaviour; CLAUDE.md's
   commit rules reserve `fix` for a defect with a symptom. The behaviour change it enables is D22's commit.
3. **`ChannelEventType` is derived from a runtime list `CHANNEL_EVENT_TYPES`** (channel/types.ts) so the
   "test iterating every ChannelEventType" can exist; a compile-time check pins every `SessionStatus` in it.
   `EVENT_TO_TASK_STATUS` is now built from a `Record<ChannelEventType, TaskStatus>`, so a missing key is a
   compile error. `ReducerEvent` and `stream-json-reducer.ts` were narrowed from `ChannelEventType` to
   `SessionStatus` (print mode never emits `awaiting_permission`), which keeps the reducer untouched in
   behaviour and makes its Phase 5 deletion local. `channel-wire-format.test.ts`'s `expectedMapping`
   was NOT given an `awaiting_permission` row (Phase 5 rewrites that file, §12.4).
4. **F3:** the resolver is `resolveTokenFilePath(port, env)` in `session/session-stats.ts` (renamed from its
   `tokenFilePath`; the old name is gone). Default path uses the `$HOME`-first rule (`userHomeFrom`).
   `createTempSettingsFile` additionally **does not blank an inherited token file** (the parent's,
   unique per child; a zeroed record would read as "answered with zero tokens"). `TokenTracker`'s writer
   (`handlers/shared/token-tracker.ts`) was left alone: it already honours the override; its default
   still uses `os.homedir()`.
5. **F2:** `transcriptPathFor(cwd, uuid, projectsRoot = projectsDir())` gained the third argument named in
   §6.1 now, so Phase 4/5 can pass `projectsDir(parentEnv)`. `PROJECTS_DIR` is deleted.
6. **F4 + marker strip** live in one exported helper, `scrubChildEnv(env, {interactive})`, called right after
   the env literal in `runClaudeWithProxy` (source-guarded). `CLAUDECODE`'s existing unconditional delete
   further down is unchanged.
7. **child-env.ts specifics not stated in §2.14:** (a) the snapshot application never deletes
   `CLAUDISH_PANE_CHILD`/`CLAUDISH_PANE_CWD` even if the snapshot lacks them (a builder bug must not
   turn the child into an ordinary launch); (b) an unreachable `CLAUDISH_PANE_CWD` is a refusal
   (`cannot enter <cwd>: <err>`, exit 64) rather than a logged continue; (c) values must all be strings
   or the snapshot is "bad env snapshot"; (d) "log it" for the chdir is a note flushed through `log()`
   right after `initLogger` in index.ts (the logger does not exist at import time). The bootstrap is a
   guarded import-time side effect of `child-env.ts`; index.ts imports it first (biome keeps it first
   because it sits in its own blank-line group).
8. **Overlay:** `buildClaudishSettingsOverlay(statusLine, proxyAuthMode, paneChild = isPaneChild())` and
   `mergeUserSettingsIfPresent(..., paneChild = isPaneChild())` (now exported, for the test). A caller's
   explicit `skipDangerousModePermissionPrompt` in `--settings` is kept.
9. **Walker:** exported from cli.ts: `classifyPassthroughTokens`, `CLAUDISH_FLAG_ARITY`,
   `CLAUDISH_INLINE_VALUE_FLAGS`, `CLAUDISH_EXITING_FLAGS`, `passthroughFlagTakesValue` (which parseArgs's
   catch-all now calls). The drift guard is both a 24-input equivalence table against `parseArgs` and a
   source scan of every `arg === "..."` in parseArgs (`-p`/`--print`/`--`/`--resume` excluded by name).
10. **Extra commit** 68e30e53 for an import-order lint error introduced by f9e1478b (no history rewrite).

### What Phase 2+ must know

- `pane/child-env.ts` is the single home of `PANE_SHELL_MANAGED_KEYS` / `isPaneShellManagedKey`
  (Phase 3's snapshot builder in `pane-launch.ts` must exclude exactly these plus `CLAUDISH_PANE_ENV`),
  `PANE_MARKER_VARS`, `isPaneChild(env)`, `PANE_CHILD_REFUSED_EXIT = 64`. Refusal line format:
  `claudish: pane child refused: <reason>`.
- `checkChildFlags` (Phase 3) should build on `classifyPassthroughTokens`: refuse when `positionals.length > 0`
  or `separatorAt !== null`, and test reserved names against tokens of kind `claudish-flag` /
  `passthrough-flag` (split `--flag=value` first; the walker treats only `--default-provider=`, `--op-env=`,
  `--op=` as inline claudish forms).
- **Risk for the pane argv (Phase 3/4):** index.ts detects subcommands BEFORE parseArgs by scanning the raw
  argv — `args.includes("update")`, `args.includes("init")`, `profile` anywhere not after a flag, and the
  first non-dash token for `config`/`team`/`login`/... A caller flag value such as `--agent update` or
  `--agent team` would dispatch a subcommand instead of the REPL. The child-side assertion runs after
  parseArgs and cannot catch it; the server-side check should reserve those words as flag values or the
  argv should be shaped so they cannot appear. Not changed in Phase 1.
- `projectsDir(env)` / `transcriptPathFor(cwd, uuid, projectsDir(parentEnv))` are ready for owners.
- `CLAUDISH_PANE_ROOT` was not added (Phase 3, §20.4).
- End-to-end proof that a real child claudish restores the snapshot, carries the overlay key, strips the
  markers and `CLAUDE_CODE_CHILD_SESSION`, keeps `CLAUDISH_TOKEN_FILE` and exports no watchdog is still
  Phase 3's `pane-child-real-claudish.integration.test.ts`; Phase 1 covers these by unit tests, source
  guards and the `index.ts` subprocess tests in `pane/child-env.test.ts`.
- Full `test:safe` takes ~12 minutes on this machine.

## Impl phase 2

Start 2026-10-06 11:58 · end 2026-10-06 13:16 · branch `worktree-claudish-mcp-magmux`, base 68e30e53,
head a9bf6886. Not pushed. Claude Code on this machine is **2.1.290** (design assumed 2.1.287).

### Captures (gate)

Harness `phase2/cap.ts` (session dir, gitignored) launches the pane exactly per §2.3 (headless magmux
`--no-status --id --sock-dir`, 160×50, launcher `cd`+`exec bun …/index.ts -i --model haiku -y --quiet
--session-id --add-dir`, sh-shim `SHELL`, allowlisted env, hermetic `HOME`/`CLAUDE_CONFIG_DIR`/`ZDOTDIR`
under `/tmp/cc2/<run>`, `CLAUDISH_PANE_CHILD`/`_CWD`/`_ENV` snapshot, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`),
watches frames at 4 fps into an in-memory screen, snapshots text+spans, records every frame. 16 runs
(s01–s12, scripts beside it, raw output in `phase2/runs/`). Spend $1.39 at API rates (subscription).

- **Login trap:** a hermetic config dir is "Not logged in" (keychain item is keyed per config dir; HOME
  redirect fails too). The harness reads the subscription access token once in memory via
  `/usr/bin/security find-generic-password -s "Claude Code-credentials" -w` (same binary Claude Code uses,
  no ACL prompt; 291 min left) and passes `CLAUDE_CODE_OAUTH_TOKEN`. Never written to disk; fixtures grep
  clean. Banner then reads `· Claude API`.
- **Taken:** REPL keylog (ctrl-j newline, ctrl-u, backspace, `@`/`/` menus, Esc closes menu, Enter on an open
  `@` menu SUBMITS), long Bash, numbered-prose-over-running-Bash (R3-H1 negative), working spinner rows,
  background Bash and background Agent after end_turn, AskUserQuestion + Esc, Esc during Bash, plain
  interrupt, `/pear`, `/cost`, `/compact`, Read limits (6k/40k/90k-char lines, 2,600 lines, token-capped
  file, paged read, CRLF, spill check), the file-delivery template, ending matrix (end_turn, API error,
  max_tokens, interrupts) hookless and with a `sleep 30` Stop hook (screen sampled 1 Hz during the hook),
  Stop-hook screen, slow UserPromptSubmit hook timeline, fresh-boot placeholder, onboarding/trust/bypass
  dialogs, unnamed `.mcp.json` dialog, `--agent` rejection, permission dialogs (Write, Bash) + Esc,
  ExitPlanMode + Esc, screen-mode API error (invalid token).
- **Skipped (documented in the report):** `refusal` (not elicitable on native haiku; no Gemini key in the
  hermetic run) → redacted corpus slice (the only refusal in 3,001 files); in-turn auto compaction → redacted
  corpus slice (manual `/compact` captured live); API-key dialog (needs a foreign route with
  `ANTHROPIC_API_KEY`; research's 2.1.287 verbatim text stands); `Transcript saving is off` (F4 removes
  the cause; research text stands); prompt suggestion (never appeared in 2 sessions / 4 turns with
  nonessential traffic allowed; production disables it anyway).
- **`secondaryQuietMs` = 32,000** from `phase2/corpus.ts` over 3,001 transcripts: 1,944
  end_turn→summary→assistant re-wakes, p99 15,832 ms.
- Process/socket listings before/after every run: `phase2/runs/ps.log`; final state: no `cc2` process,
  sockets dir empty, `/tmp/cc2` removed.

### Design corrections (all in `architecture.md` §21 [impl-2] and report §7–§9)

hasChoiceDialog closed list by named headers (no `(esc)`/`No` row exists in 2.1.290); unnamed boot choice
by `Enter to confirm · Esc to cancel`; isWorking = `<glyph> <Word>… (…)` row; error rows are `⏺` rows;
screenAnswer excludes Bash description rows / Agent / Background rows; agentRejectedLine tolerates
magmux's truncated `lastLine`; faint = attr 2, box prompt is `❯`+U+00A0; provenHookless skips
prompt_snapshot/state records; background agents from `toolUseResult.isAsync`; isMeta user records wake
(max_tokens auto-continue → `max_output_tokens` API error; refusal companion → continuation); S gate opens
for refusal; Read has no line limit/cap, 25k-token cap, `offset:0` numbers from 0, CR stripped, no spill →
`READ_LINE_LIMIT = 20 000` as a page budget and text-compare coverage from `max(1,startLine)`; `/cost`
opens a panel with no record; `--permission-mode default` does not beat `-y`, `--no-auto-approve` does.

### Files

New: `pane/contract.ts`, `slot-state.ts`, `screen-model.ts`, `screen-classifier.ts`,
`transcript-follower.ts`, `settle-rule.ts`, `prompt-delivery.ts`, `accounting.ts`, `slot-row.ts`,
`types.ts`; tests `slot-state`, `screen-model`, `screen-classifier`, `transcript-follower`, `settle-rule`,
`prompt-delivery`, `accounting`, `test-fixtures/fixtures-redaction`; helpers `pane/test-helpers/fixtures.ts`,
`transcript-fixtures.ts`; fixtures `pane/test-fixtures/{screens(32),transcripts(13 + 2 corpus-redacted +
subagents),frames(3),token-files(2)}` (~2 MB); `scripts/redact-transcript-fixture.ts`;
`ai-docs/reports/mcp-magmux-panes/phase2-captures.md`. Modified: `team-stats.ts` (`billed_input_tokens`).

### Commits

| sha | subject |
|---|---|
| 272643c7 | feat(mcp): add the pane contract types and slot lifecycle table |
| cd27aca0 | test(mcp): add real pane screen and transcript fixtures |
| ac3e3c32 | feat(mcp): add the pane screen model and screen classifier |
| 71be50eb | feat(mcp): add the pane transcript follower and settle rule |
| 47bddf98 | feat(mcp): add pane prompt delivery for typed, command and file turns |
| 510af126 | feat(team): read billed_input_tokens from the proxy token file |
| 3d44782b | feat(mcp): build contract slot rows from pane accounting |
| a9bf6886 | docs(mcp): record the phase-2 Claude Code captures |

### Quality checks

- `bun run format` — applied (new files only); `bun run lint` — exit 0, 995 + 22 warnings (unchanged from
  phase 1; new code has none: complex functions split, `any` confined to one ignored `Rec` alias per file).
- `bun run typecheck` — exit 0.
- pane tests alone: 183 pass / 0 fail across 9 files (~0.6 s).
- `bun run test:safe` — run 1: 4897 pass / 33 skip / **1 fail**
  (`composed-handler-recovery.test.ts` "the master switch restores today's immediate 400": a dead-port
  test got `invalid_request_error`; passes 3/3 alone; handlers untouched by this phase — a contention
  flake). Run 2: exit 0 — packages/cli **4898 pass, 33 skip, 0 fail** (4931 tests, 319 files, 698 s) vs
  phase 1 4736/33/0 (4769, 311 files): +162 tests, +8 files, skip count unchanged; macos-bridge 20/0,
  scripts 5/0. Logs: `impl2/final-test.log`, `impl2/final-test-2.log`.

### Notes for phase 3

- Use `phase2/cap.ts` as the model for `scripts/pane-drive.ts` and the real-claudish integration test; the
  OAuth-token trick is the only way to log a hermetic config dir in (do NOT put it in tests).
- `decideSettle` (settle-rule.ts) is the pure §2.8 core: feed it `follower.view().current`, `session`,
  `transcriptQuietMs` (now − `lastAppendAt`), `chatQuietMs` (since the turn's last chat record was read —
  PaneSession must timestamp `lastChatOffset` changes), screen facts from the classifier
  (`inputBox()?.text === ""`, `hasChoiceDialog`, `isWorking`, `now − aboveBoxChangedAt`) or `null` while
  disconnected, and `paneExited` on the exit path.
- Follower turn offsets: call `poll()` then `openTurn({offset: size()})` BEFORE typing; records are
  applied at `lineStart + 1` so the first record after the mark is strictly past it. For a command turn
  the boundary/summary/caveat records precede the `<command-name>` witness and belong to it.
- Read coverage needs `openTurn({delivery: {file, text}})` with the exact bytes written.
- `/cost`-style panel commands: no record, input swallowed until Esc — handle in the admission pump.
- Blocked detection: AskUserQuestion pending from the transcript; permission/plan need `hasChoiceDialog`;
  the fake child needs the `tool_slow_numbered` scenario (R3-H1) templated from
  `screens/numbered-prose-bash-running.json` and the tools-session transcript.
- Fake child key semantics from the keylog: `\r` submits, ctrl-j inserts a newline, Esc closes a menu
  keeping the text, Esc on a dialog declines + interrupts, Enter on an `@` menu submits as typed.
- The stats notice claudish prints on a fresh claudish config appears even with `--quiet` (primary
  screen, before the alt screen); harmless for boot (box detection), but the fake can draw it.
- `FailureReason` now exists in both `pane/contract.ts` and `team-orchestrator.ts`; phase 4 deletes the
  latter (no shim).

## Impl phase 3

Start 2026-10-06 ≈13:20 · end 2026-10-06 16:00 (one usage-limit pause in between) · branch
`worktree-claudish-mcp-magmux`, base a9bf6886, head 405b725a. Not pushed. magmux 0.14.0, bun 1.4.0.

### Commits

| sha | subject |
|---|---|
| ee59889e | feat(mcp): add pane process identity and the generated pane watcher |
| eac9182b | feat(mcp): add the magmux socket client for pane sessions |
| 188b73f3 | feat(mcp): add pane launch: env snapshot, sh shim, launcher, flag check |
| d2bd2126 | feat(mcp): add the pane registry: records, sweep, limit, shutdown hooks |
| e85760f7 | feat(mcp): add PaneSession, the live interactive pane, and pane/index.ts |
| 965d8115 | test(mcp): add the fake interactive child and real-magmux pane suites |
| 7c82731b | feat(scripts): replace magmux-drive-session.ts with pane-drive.ts |
| 6b604763 | perf(mcp): cache the magmux version check per binary path |
| 405b725a | test(mcp): exercise the real magmux spawn-failure reap (R3-M1) |

### Files

New source: `pane/magmux-client.ts`, `pane-launch.ts`, `process-identity.ts`, `pane-registry.ts`,
`pane-session.ts`, `index.ts`. New test helpers: `pane/test-helpers/fake-interactive-child.ts`,
`hermetic-env.ts`, `pane-owner.ts`. New fixture: `pane/test-fixtures/ps/live-pane.json` (a real
`ps` of one live pane; home path redacted to `/opt/u`). New tests: `pane-launch.test.ts`,
`child-flags.test.ts`, `process-identity.test.ts`, `magmux-client.test.ts`,
`pane-session.integration.test.ts`, `pane-registry.test.ts`,
`pane-child-real-claudish.integration.test.ts`, `pane-live-claude.integration.test.ts` (opt-in).
Modified: `config.ts` (`ENV.CLAUDISH_PANE_ROOT`), `pane/transcript-follower.ts` (`pendingTool.input`),
`pane/types.ts` (`claudeCodeVersion`, `shape`), `pane/accounting.test.ts`,
`ai-docs/architecture/headless-vs-interactive.md` (one paragraph: the new script).
`scripts/pane-drive.ts` new; `scripts/magmux-drive-session.ts` deleted.
Session scratch (gitignored): `impl3/` — `fd-probe.ts`, `watcher-probe.ts`, `smoke.ts`,
`capture-ps.ts`, `gate-evidence.ts` + `gate-evidence.txt`, `final-test.log`.

### GATE (r2) — passed, no polling fallback needed

Measured under Bun 1.4.0 by `impl3/gate-evidence.ts` (raw output `impl3/gate-evidence.txt`) and
asserted by `pane-registry.test.ts` "GATE: owner SIGKILL with two panes …" (lsof check + cleanup
≤ 5.5 s). Bun gives each child's stdio a unix socketpair; the owner (16464) holds the far end of
each watcher's stdin (`0xd419…` ↔ watcher 16475 fd0 `0xc10d…`; `0x2cca…` ↔ watcher 16479 fd0
`0x819a…`). Neither magmux nor the sibling watcher holds either address:

```
bun 1.4.0; owner 16464; watchers 16475,16479; magmux 16476,16480; panes 16481,16478
--- lsof -a -U -p owner,watchers,magmux (unix sockets: Bun's stdio pairs)
COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
bun     16464 jack    1u  unix 0xa79e1827f2e0348f      0t0      ->0x9b94378a86279db3
bun     16464 jack    4u  unix 0xa79e1827f2e0348f      0t0      ->0x9b94378a86279db3
bun     16464 jack    7u  unix 0x45f0596c0413bdc4      0t0      ->0xd0752fbe6cf04e3a
bun     16464 jack    8u  unix 0xd419b898a2fbf92d      0t0      ->0xc10d94a0fafd818
bun     16464 jack    9u  unix 0x4964b9e284336bc6      0t0      ->0xb81c0ac09cc43492
bun     16464 jack   10u  unix 0x2ccace1ab2b2f83c      0t0      ->0x819aacac0ca9a2c3
bun     16464 jack   11u  unix 0x2cd18bf5b8bcf48e      0t0      ->0x4ec7e19bab2d2913
bun     16464 jack   12u  unix 0x8a2746d2d2d23b96      0t0      ->0x58a9af0e211cd15b
bash    16475 jack    0u  unix  0xc10d94a0fafd818      0t0      ->0xd419b898a2fbf92d
magmux  16476 jack    2u  unix 0xd0752fbe6cf04e3a      0t0      ->0x45f0596c0413bdc4
magmux  16476 jack    4u  unix 0x4e44698fa3ced84c      0t0      /tmp/cpt-0679b229/magmux-c16464-muw6skyo-t02-494d7f.sock
magmux  16476 jack    8u  unix 0x4ec7e19bab2d2913      0t0      /tmp/cpt-0679b229/magmux-c16464-muw6skyo-t02-494d7f.sock
bash    16479 jack    0u  unix 0x819aacac0ca9a2c3      0t0      ->0x2ccace1ab2b2f83c
magmux  16480 jack    2u  unix 0xb81c0ac09cc43492      0t0      ->0x4964b9e284336bc6
magmux  16480 jack    4u  unix 0xfab6bf7bd05eebfa      0t0      /tmp/cpt-0679b229/magmux-c16464-muw6skyo-t01-d0bc77.sock
magmux  16480 jack    8u  unix 0x58a9af0e211cd15b      0t0      /tmp/cpt-0679b229/magmux-c16464-muw6skyo-t01-d0bc77.sock
--- lsof -a -d 0-20 -p watchers,magmux: watchers hold only fd0 (their own pair) + /dev/null;
    magmux holds /dev/null, its own stderr pair, kqueue, /dev/ptmx, an internal pipe pair, its socket
--- 746 ms after owner SIGKILL: processes=[] files=[]
--- ls -A /tmp/cpt-0679b229 /tmp/cpt-0679b229/panes: [ "panes" ] []
--- ps for watchers/magmux pids: (none)
```

The registry test's own run: `[gate] owner SIGKILL → clean in 955 ms`. An earlier version of
the watcher took 7,548 ms (shell `while read` loops over a 1,700-row `ps`, fixed `sleep 2; sleep
1`); it now filters with awk and polls (≤ 2 s after TERM, ≤ 1 s after KILL).

### Quality checks

- `bun run format` — applied to new files only. `bun run lint` — exit 0, 995 + 22 warnings
  (unchanged from phase 2; the five complexity warnings new code introduced were refactored away).
- `bun run typecheck` — exit 0.
- pane tests alone: 283 tests across 17 files (280 pass, 3 skip = the opt-in live tests, 0 fail, ~87 s); the integration file alone 43/43 in ~50 s, re-run 3× (one load flake fixed, see deviations 7–8).
- `bun run test:safe` — exit 0 — packages/cli **4995 pass, 36 skip, 0 fail** (5031 tests, 327 files, 781 s) vs phase 2 4898/33/0 (4931, 319 files): +97 pass, +3 skip (the opt-in live tests), +8 files, no new failures; macos-bridge 20/0, scripts 5/0. No `cpt-*` root, watcher, magmux or fake child left afterwards. Log: `impl3/final-test.log`.

### Deviations from the plan (with reason)

1. **`--no-auto-approve` is reserved** (the brief; §21 said "not reserved"). It contradicts our own
   `-y`. Consequence for Phase 5: a caller reaches AWAITING_PERMISSION only through
   `--permission-mode plan` (plan approval appears under `-y`, phase-2 s08).
2. **Subcommand words are refused** as caller-flag tokens and as `spawnModel` (`update`, `init`,
   `profile`, `config`, `team`, `login`, …): index.ts dispatches them from anywhere in argv
   (the phase-1 risk note). Also `--mcp`, `--kimi-login/-logout` and every `CLAUDISH_EXITING_FLAGS`
   flag are reserved as mode flags.
3. **`watch` at 4 fps**, not 2 (research §6 recommends 2–4): halves boot/witness/settle latency;
   idle cost is nil.
4. **R3-M2 split dirs:** both the control dir and the turn dir are `mkdtemp(<root>/launch-)`, so one
   validator (`launch-[A-Za-z0-9]{6}`, direct child of the root) covers both; the record keeps
   `launcherDir` (= control dir) and gains `turnDir`.
5. **`assertMagmuxAvailable` reads `magmux --version`**; the protocol and version are re-checked
   from `capabilities` on every connect (a mismatch is FAILED `pane_lost` "magmux_unavailable: …").
6. **No final `capture` before the reap**: the frame-fed screen already is the final screen; a
   scrollback `capture {offset:200}` is taken only on the pane-exit path (for `agent_rejected`).
7. **`list` on every attach**, not only on reconnect: a child that dies in its first milliseconds
   (unknown `--agent`) exits before our first subscription, so its `exit` event is never pushed to
   us. Found by the concurrent integration run.
8. **Every `ps` on the reap and registry-tick paths is async**: synchronous `ps` polled every 25 ms
   by concurrent reaps stalled the event loop long enough for magmux to drop our sockets as slow
   consumers (seen as `delivery_failed` and missed activity under the concurrent suite).
9. **Reservations:** `startPaneSession` consumes one reservation synchronously (or makes its own,
   checking the limit) and writes the record before its next await; `registerPane` no longer
   decrements. New exports `takePaneReservation`, `releasePaneReservations`.
10. **`TurnView.pendingTool.input`** (additive) so a blocked question reports its text.
11. **R3-M4**: `PaneSnapshot.claudeCodeVersion` from the boot banner; the anomaly
    `turn_end_record_missing` after 3 × `secondaryQuietMs` of a static `finishing` screen with no
    Stop-hook row. `activity` stays `finishing`; Phase 4 puts it into `activity_by_slot`/the note.
12. **The `rewake` fixture gap is SHORTER than the quiet window under test** (§12.2 says longer):
    a gap longer than the window would legitimately open path S (`stop_hook_summary` + quiet).
    The production window is 2 × the corpus p99 of exactly that gap, so "shorter" is the real shape.
13. **The fake's blocking scenarios** (`ask_user*`, `interrupt_td`, `permission`) block turn 1 only;
    the prompt sent after the decline is answered.
14. **Not implemented in the fake:** `dialog_api_key` (no 2.1.290 capture of that screen exists in
    the fixtures). Every other §12.2 scenario exists; most are exercised now, the rest are for
    Phases 4–5 (`no_shape`, `multibyte`, `turn2_exit0` is tested, `ignore_term`, …).
15. **The integration suite runs its groups with `describe.concurrent`** (43 tests in ~50 s instead
    of ~250 s sequentially); every test owns its env and sockRoot, and an `afterAll` reaps any run a
    failed test left behind.
16. **Opt-in live tests were not run** (they need an operator-supplied `CLAUDE_CODE_OAUTH_TOKEN`;
    the harness never reads the keychain). Run:
    `CLAUDISH_PANE_LIVE=1 CLAUDE_CODE_OAUTH_TOKEN=<token> bun test packages/cli/src/pane/pane-live-claude.integration.test.ts`.

### Notes for phase 4

- Facade: `import { startPaneSession, checkChildFlags, flagsRemoveRead, reservePanes,
  releasePaneReservations, reapAllPanes, installPaneShutdownHooks, sweepOrphanPanes, livePaneCount,
  toSlotRow, mergeAccounting, … } from "./pane/index.js"`. `startPaneSession` throws
  `MagmuxUnavailableError` (`magmux_unavailable`), `PaneLimitError` (`pane_limit`) or
  `PaneStartError` (`invalid_args` | `pane_lost`) before anything is spawned — map a throw to a
  FAILED `pane_lost` slot (§20.3 item 1).
- Call `reservePanes(n, root)` once per run before the spawn loop; each `startPaneSession` consumes
  one; call `releasePaneReservations(k)` for slots you end up not starting.
- `transcriptPath` is the caller's: `transcriptPathFor(realpath(cwd), uuid, projectsDir(parentEnv))`.
- `ready` resolves on leaving STARTING (D9); `terminal` resolves after `onTransition` of the terminal
  step; `reaped()` resolves after files and watcher are gone (≈ 0.2–1 s typical with the fake).
- Team policy goes in `decide` (`require_pattern`, `min_output_bytes`, `delivery.complete === false`
  → `prompt_not_read`, `apiError` → `api_error`) and `onBlocked` (→ FAILED `blocked`, detail = the
  question text). The background-shell anomaly is `background_shell_open: <command>` in
  `snapshot().anomalies` (R3-M5 wants it in the team `detail` and the result card).
- Owner-side test seam: `CLAUDISH_BIN=<pane/test-helpers/fake-interactive-child.ts>` and
  `CLAUDISH_PANE_ROOT=<short /tmp dir>`; `makePaneTestEnv()` sets both. `--model fake-<scenario>`
  or marker mode (`contract-fake-model` + `@@HANG@@` etc.).
- `PaneSessionImpl.client` is private; the subscriber-drop test reaches it by cast.
- Boot with the fake: ~1.2–1.9 s to RUNNING; with the real claudish entry ~3–5 s.

## Impl phase 4

Start 2026-10-06 ≈16:05 · end 16:53 · branch `worktree-claudish-mcp-magmux`, base 405b725a,
head 3ba7c3d7. Not pushed. magmux 0.14.0, bun 1.4.0.

### Commits

| sha | subject |
|---|---|
| bb7fd52d | fix(mcp): use up a held pane reservation when startPaneSession throws |
| 5a310c16 | feat(mcp): export deliveryRefusal and ContractErrorException from pane/ |
| 389a22fe | feat(mcp)!: run team slots as interactive panes in headless magmux (BREAKING CHANGE footer, team half) |
| 3ba7c3d7 | test(team): add the run-registry contract and CLI SIGINT suites |

### Files

Source: `team-orchestrator.ts` (rewritten: startModels on PaneSession, registry by run_id +
newestRunByPath + retention, `preflightTeamRun`, `listTeamRuns`, `teamRunRow`,
`teamRunRowFromDisk`, `teamLiveMaps`, `cancelTeamRun(path, slot?, runId?)`,
`captureTeamSlot`, `shutdownAllTeamRuns`, re-signed `classifyRunOutput`, summarise terminal
guard; `@internal resetTeamRegistryForTests`/`pruneTeamRunsForTests`), `mcp-server.ts` (team
schema/handler, `NEXT_STEP: Record<FailureReason,…>`, `teamStatusNote({anyActive,live,
endRecordMissing})`, `buildTeamStatusPayload({…, run})`, `formatTeamResult`, exported
`teamContractVerb`/`teamStatusAnswer`), `team-cli.ts`, `index.ts` (--team json), `team-stats.ts`,
`team-grid.ts`, `channel/session-manager.ts` (private stream-json classifier + `meaningfulStderr`
copies), `pane/pane-session.ts`, `pane/prompt-delivery.ts` (`deliveryRefusal`),
`pane/contract.ts` (`ContractErrorException`), `pane/index.ts`.
Tests: rewritten `team-cancel`, `team-heartbeat-survival`, `team-liveness-exited-slot`,
`team-multibyte-answer`, `team-mcp-shape-contract.e2e`, `team-output-classification`,
`team-result-card`, `team-status-payload`, `team-orchestrator` (argv/env/rewake/policy on panes;
bug #3 moved in); ported `team-orchestrator-settle.contract`, `team-run-mcp.contract`,
`team-run-settles-once`, `team-start-failure`; `team-run-summary.contract` +3 cases;
`team-stream-capture.test.ts` lost its resolveCaptureMode cases; `pane/pane-registry.test.ts`
+ "reservations"; new `team-list-contract.test.ts`, `team-cli-signal.test.ts`,
`test-helpers/team-pane.ts`. Helpers: `contract-adapters.ts` (spawnSeam deleted, modelStates →
SlotState with PENDING→STARTING), `contract-mcp.ts` (`PANE_FAKE_CHILD`, `CLAUDISH_PANE_ROOT` per
layout via `paneRootOf`, `paneOrphans`, hermetic keys, `MAGMUX_AVAILABLE`), fake child
(`FAKE_PROBE_FILE` accepts `{session}`). Deleted: `team-stderr-noise.test.ts`,
`team-timeout-repro.test.ts`, `channel/test-helpers/fake-dropout-child.ts`,
`fake-streamjson-child.ts` (their only consumers were team tests). Session scratch:
`impl4/smoke.ts`, `impl4/msg-*.txt`, `impl4/test-1.log`.

### Quality checks

- `bun run format` — applied; `bun run lint` — exit 0, 991 + 22 warnings (995 before; new
  complexity warnings refactored away: `classifyAnswer` split, `slotError`, `failureLines`).
- `bun run typecheck` — exit 0.
- `bun run test:safe` — exit 0 — packages/cli **5016 pass, 36 skip, 0 fail** (5052 tests, 327
  files, 796 s) vs phase 3 4995/36/0 (5031, 327): +21, no new failures, no flakes to re-run;
  macos-bridge 20/0, scripts 5/0. The new `pane-registry` "reservations" test was added after
  the run started and passes alone (and fails with the take removed: Expected 0, Received 2).
  No `/tmp/cpt-*` root left. Log: `impl4/test-1.log`.

### Deviations (with reason)

1. **New `ModelStatus` fields are optional in the TYPE** (§3.1 lists them as plain fields):
   `getStatus` returns whatever is on disk, and a pre-contract status.json lacks them. Every pane
   run writes all of them; `setupSession` writes STARTING + `model`; team-grid fills
   `model/spawnModel/provider/pane`. Added `ModelStatus.claudeCodeVersion` (R3-M4) and
   `anomalies` (R3-M5 background shells, truncation note, turn_end_record_missing) and
   `TeamStatus.runId`/`kind` (so the disk `run` row carries the real run_id after eviction).
2. **Reservation leak fix in `startPaneSession`** (own commit): a start that threw before taking
   its reservation now uses up one held reservation, so an owner reserving N never leaks.
3. **status.json fault injection** for the ported REQ-22 / settles-once / start-failure suites
   is `chmod 0444 status.json` (the FILE, not the dir: an in-place overwrite ignores dir perms),
   timed by the first pane record in `<paneRoot>/panes/` (or, for start-failure, the stubborn
   child in `ps`), inside the 300 ms stagger.
4. **team-start-failure "SIGTERM came first"**: measured — magmux's forced `close_pane` sends
   the pane SIGHUP (repeatedly) and then kills it itself, before our SIGTERM→SIGKILL group
   backstop is needed. The marker therefore shows SIGHUP; the test asserts a trapped polite
   signal (SIGHUP|SIGTERM) and that nothing is left at rejection time.
5. **`run` handler preflight**: pane-limit refusal before the record is a capacity CHECK
   (`livePaneCount + n > MAX`), the real `reservePanes(n)` happens inside `startModels` (CLI needs
   it too). A run that passes the check but loses a race fails start-failed, not refused.
6. **run-and-judge answer** gains additive `run_id` and `run` beside the verdict keys.
7. **Never-spawned slots**: response file written empty, error log written, row FAILED
   `pane_lost` with `pane:null`; `capture` answers the blank final screen (unchanged at since_seq 0).
8. **Unknown mode** stays `Error: Unknown mode: x` text (the pre-contract detection string); the
   four §8 modes answer JSON / ContractError; `path` is required by those (invalid_args) — a
   `run_id` without `path` is not accepted.
9. Removed both stream-json fakes (`fake-dropout-child.ts`, `fake-streamjson-child.ts`) now, not in
   phase 5: phase 4 removed their last consumers. `fake-claudish.ts`, `fake-channel-stream-json.ts`,
   `captured-stream-json.ts`, `test-fixtures/stream-json/` stay (channel tests, team-stream-capture).

### Notes for phase 5

- `mcp-server.ts` installs NO pane shutdown hooks itself yet: `startPaneSession` installs the
  default ones (`exitAfter:true`) on first use, and the old `process.on("SIGTERM")` still calls
  `sessionManager.shutdownAll()` + `shutdownAllTeamRuns()`. Phase 5 should call
  `installPaneShutdownHooks({ stdin:true, before: async () => { await shutdownAllTeamRuns();
  await sessionManager.shutdownAll(); } })` at server start (before any pane) and delete that
  handler. `shutdownAllTeamRuns` cancels every live slot and awaits `terminal` (records end
  `cancelled`).
- `McpServer.close()` (contract-mcp.ts) waits 3 s then SIGKILLs, because the server does not exit
  on stdin EOF yet; the watchers clean up. Once stdin EOF shuts down, the ported team suite gets
  faster (team-run-mcp takes ~21 s now).
- `serverEnv` now always sets `CLAUDISH_PANE_ROOT` (per layout) and the hermetic keys; making the
  pane fake the default is just changing `CLAUDISH_BIN` there. Call `paneOrphans(layout)` in each
  channel suite's afterEach once it spawns panes.
- `ContractErrorException` (pane/contract.ts) + `contractErrorAnswer`/`contractAnswer` in
  mcp-server.ts are ready for `cancel_session`/`capture_session`/`list_sessions`.
- `session-manager.ts` holds private `classifyStreamJsonProse`/`meaningfulStderr`/`API_ERROR_RE`/
  `BG_CEILING_RE`; delete them with the stream-json path and use `classifyRunOutput` (new
  signature) for the one-shot verdict. `STDOUT_TAIL_LIMIT` is still exported from team-orchestrator.
- `agent-availability.ts` is still imported by `create_session` (channel half of D11).
- Test helper `test-helpers/team-pane.ts` (`paneRunOptions`, `finishPaneTest`, `waitUntil`) is
  team-oriented; channel suites can use `pane/test-helpers/hermetic-env.ts` directly.
- Pane test sessions whose path must pass `validateSessionPath` live under `process.cwd()`
  (`.tmp-team-list-*`, `.tmp-mcp-shape-*`), removed in afterEach.

## Impl phase 5

Start 2026-10-06 ≈16:55 · end 18:45 · branch `worktree-claudish-mcp-magmux`, base 3ba7c3d7,
head fc918644. Not pushed. magmux 0.14.0, bun 1.4.0.

### Commits

| sha | subject |
|---|---|
| 86c7baf4 | feat(mcp): expose assistant message ids and pane diagnostics on PaneSession |
| 190ac1ce | feat(mcp)!: run create_session as an interactive pane in headless magmux (BREAKING CHANGE footer: SessionInfo `status` removed from answers, `finishing` gone, CLAUDISH_TEAM_CAPTURE, refused print-only claude_flags, Windows) |
| 41cf1cb2 | fix(mcp): end session and team records before exiting on SIGTERM |
| 4de221d3 | test(mcp): add the mod-contract and session-records e2e suites |
| fc918644 | perf(mcp): run the startup pane sweep once per root through ensureSwept |

### Files

Source: `channel/session-manager.ts` (rewritten on `startPaneSession`: async `createSession`
— checks → `assertMagmuxAvailable` → `reservePanes(1)` → `prompt.md` → `spawn.json` → pane;
`decide` one-shot/interactive (D20, `meta.prompt_not_read`), `onBlocked` → wait, `timeoutMs`;
`onTransition` → wait lines, `events.jsonl` state records, terminal records (`meta.json` via
exported `toMetaRecord`, `screen.txt`, partial answer + `[claudish]` note); `onChange` →
assistant-id/tool/anomaly records and coalesced frames; exported `channelEventFor`,
`sessionRowOf`; `sendInput` → `SendInputResult`; `cancelSession` → `SessionCancelResult`;
`captureSession`; `listSessionRows`; `getDiagnostics` new fields; two-generation disk reader;
`shutdownAll` waits for in-flight starts, cancels, awaits `terminal`), `channel/types.ts`
(`SessionInfo` §3.3 + `activity`; `SessionStatus`, `ReducerEvent`, `stallSeconds`,
`keepUnrecognizedJson` gone; `parentEnv`, `paneTimings` options), `channel/index.ts`,
`mcp-server.ts` (channel tools, `capture_session`, INSTRUCTIONS, map without `finishing`,
`installPaneShutdownHooks({stdin, before})` + startup `ensureSwept`; SIGTERM handler deleted;
`create_session` answers `{session_id, state}`; magmux_unavailable/pane_limit as `Error: <code>: …`),
`pane/transcript-follower.ts` (`assistantMessageIds`), `pane/pane-session.ts`
(`assistantMessageIds()`, `diagnostics()`), `pane/index.ts`, `pane/pane-registry.ts`
(`claimSignalExit`), new `signal-owner.ts`, `stats-buffer.ts`, `team-orchestrator.ts` (comment).
Tests: ported `channel/session-manager`, `session-create-options`, `session-timeout`,
`channel-wire-format` (+ awaiting_permission case), `e2e-channel` (14/7 tools),
`session-state-records`, `spawn-record`, `host-pid`, `event-task-status`; new
`channel/session-records.contract.test.ts`, `mcp-contract.e2e.test.ts`,
`mcp-shutdown.e2e.test.ts`; `transcript-follower.test.ts` +1. Helpers: `contract-mcp.ts`
(pane fake default, `sessionStatus` reads `event`, `close(graceMs=15 s)`),
`contract-adapters.ts` (reducer probes deleted), `mcp-e2e/{runner,scenarios,types}.ts`
(pane fake, per-replica pane root, `screen.txt`), `scripts/no-retired-terms.test.ts` (comment),
`team-run-mcp.contract.test.ts` (default CLAUDISH_BIN), fake child mode 0755.

### Deleted files (with their tests; static test counts from 3ba7c3d7)

`channel/stream-json-reducer.ts` (+ `stream-json-reducer.test.ts` ≈2,
`-unrecognized-json.test.ts` 3, `.contract.test.ts` 13), `team-stream-capture.ts` (+ test 11),
`stdio-decode.ts` (+ test 4), `agent-availability.ts` (+ test 10), `test-helpers/contract-fake-child.ts`,
`channel/test-helpers/{fake-claudish,fake-channel-stream-json,captured-stream-json}.ts`,
`channel/test-helpers/captures/`, `test-fixtures/stream-json/`. Deleted cases in ported files:
session-manager G5 (argv order), G6 (delta firehose), `userFrame`, `assertNoReservedFlags`/
`buildChannelSpawnArgs` (replaced by G4 through `checkChildFlags`); session-create-options
`keepUnrecognizedJson` and its reducer-default half; session-state-records' `"finishing"`
diagnostics text check (RB1). Merged in session-manager: "timeout kills…" into G1/G2;
"stored in listSessions immediately" and "getSession fields" into the unique-ids case;
"totalLines ≥ 5" into the tail_lines case (three interactive turns).

### Quality checks

- `bun run format` — clean; `bun run lint` — exit 0, 988 + 22 warnings (991 + 22 before).
- `bun run typecheck` — exit 0. `bun run build` run (host-pid 9a uses `dist/`; the old dist
  did not exit on stdin EOF).
- `bun run test:safe` run 4 — exit 0 — packages/cli **4964 pass, 36 skip, 0 fail** (5000
  tests, 324 files, 842 s) vs phase 4 5016/36/0 (5052, 327): −52 tests and −3 files = the 6
  deleted files (≈43 tests) and the deleted/merged cases, plus 3 new files; macos-bridge
  20/0, scripts 5/0. No `/tmp/cpt-*` left. Runs 1–3 (logs `impl5/test-{1,2,3}.log`) are
  the history: run 1 2 fail (REQ-18 1014 ms, registry GATE 6846 ms > 5500, both timing);
  run 2 14 fail at load average 85–88 from another session (pane-session integration,
  registry, session-manager timeouts; it exposed `shutdownAll` skipping in-flight starts,
  fixed before commit); run 3 1 fail (REQ-18 1013 ms) → fc918644; run 4 green.

### Deviations (with reason)

1. **`createSession` is async** (resolves once the pane exists, no boot wait); the reservation
   is taken INSIDE it (after the checks and the magmux check, before `spawn.json`), so the
   handler does not reserve. A pane that fails to start leaves a FAILED `pane_lost` session
   with `meta.json` and the call throws.
2. **SIGTERM/SIGINT exit ownership** (41cf1cb2): stats-buffer's module-load listeners exited
   synchronously before the registry's async shutdown ended any record (found by fork D's
   SIGTERM test; repro `impl5/forkD/repro.test.ts`). New `signal-owner.ts` flag.
3. **Startup sweep through `ensureSwept`** (fc918644), not a second `sweepOrphanPanes`.
4. **`cancel_session`/`send_input` on a disk-only session** answer `unknown_session`
   (ContractError / `{success:false, reason}`), not `false`.
5. **`get_output`** answers `state`, `tokensIn`, `tokensOut` (no `status`, no `tokensUsed`).
6. **F1 re-derivation** of a stored transcript path needs the recorded cwd: pane-generation
   `meta.json` carries an additive `cwd`; a 10.4.0 record (no cwd) keeps its stored path.
7. **10.4.0 `meta.json` reasons**: only `cancelled`/`timeout` are inferred from `status`;
   10.4.0's `terminalReason` was Claude Code text, so `failed` reads reason null.
8. **Frame content** is claudish's own short text per event (question/permission text when
   blocked); frame meta adds `activity` whenever non-null (additive).
9. **`McpServer.close()`** waits up to 15 s (it was 3 s before SIGKILL) now that stdin EOF shuts
   the server down with records and reap.
10. **Not run:** the `bun run test:mcp` harness (mcp-e2e; needs live 1Password and the real
    config) — ported, not executed.
11. **REQ-18's 1 s budget** is load-sensitive: 760 ms measured on a quiet machine
    (`impl5/req18-latency.ts`). Blind assertion, unchanged.

### Notes for phase 6

- Docs (§14): `mcp-channel.md` still describes stream-json, `finishing`, 13 tools, SIGTERM-then-
  SIGKILL cancel, `stderr.log`; `docs/usage/mcp-server.md` likewise. New things to document:
  `capture_session`, `SessionListResult`/`SessionCancelResult`, `send_input` queueing, the
  `event` key in get_diagnostics, `screen.txt`, `signal-owner.ts` (why stats-buffer no longer
  exits when panes are owned), `meta.json` additive keys incl. `cwd`.
- Residue grep targets (§13 row 6) should come back clean in source except docs; the word
  `finishing` survives only as `activity:"finishing"`.
- `bun run build` before the full suite (host-pid 9a runs `dist/` when present).
- Session scratch: `impl5/smoke.ts`, `server-smoke.ts`, `req18-latency.ts`, `forkD/`,
  `deleted/`, `test-{1..4}.log`, `load-3.log`.

## Impl phase 6

Start 2026-10-06 ≈18:46 · end ≈20:10 · branch `worktree-claudish-mcp-magmux`, base fc918644,
head bfc7614d. Not pushed. magmux 0.14.0, bun 1.4.0 (CI parity on bun 1.3.10).

### Commits

| sha | subject |
|---|---|
| b094ac2e | test(team): measure REQ-18's 1 s record budget from the run's settle |
| c88fe581 | chore(release): pin the bundled magmux to v0.14.0 and verify it |
| 90ab094a | chore(mcp): remove references to the deleted reducer and agent probe |
| ab39a2de | docs(mcp): add pane-session.md, the rationale of the headless pane driver |
| 33c1b0b2 | docs(mcp): rewrite mcp-channel.md for channel sessions in panes |
| d4bc8e0b | docs(team): describe team slots as panes in team-lifecycle and capture |
| 26da8a2e | docs(mcp): point headless-vs-interactive.md at the pane driver |
| 63cd17d6 | docs(recovery): record why a pane child exports no retry watchdog |
| 31a2bd9b | docs(test): document hermetic pane tests and the opt-in live tests |
| 463fbb78 | docs(mcp): document the magmux 0.14.0 requirement and the capture verbs |
| 2b93329a | fix(mcp): attach the magmux dial's error listener before connect |
| bfc7614d | docs(test): record the bun 1.3.10 socket ENOENT that a 1.4.0 run hid |

### Files

New: `ai-docs/architecture/pane-session.md`. Rewritten/updated: `ai-docs/architecture/{mcp-channel,
team-lifecycle,team-capture,headless-vs-interactive,network-recovery,testing,README}.md`,
`CLAUDE.md` (pointer list: pane-session.md with trigger; headless-vs-interactive, mcp-channel,
team-capture, team-lifecycle lines; `keepUnrecognizedJson` dropped), `docs/usage/mcp-server.md`,
`docs/usage/magmux.md`, `.github/workflows/release.yml`, `packages/cli/src/team-run-mcp.contract.test.ts`,
`packages/cli/src/pane/magmux-client.ts`, `packages/cli/src/advisor-startup.ts` (comment),
`packages/cli/src/channel/test-helpers/channel-diagnostic.ts` (message). Session scratch:
`impl6/` — `build.log`, `test-safe.log`, `ci-parity.sh`, `run-ci-parity.sh`,
`ci-parity-1-before-fix.log`, `ci-parity.log`, `team-orchestrator.ts.orig` (mutation copy).

### Docs (§14) — as built, each claim checked against pane/, team-orchestrator.ts, session-manager.ts, mcp-server.ts

- `pane-session.md`: topology, transcript oracle + witness (370–470 ms; 12,501 ms with a slow
  UserPromptSubmit hook), boot from content + closed dialog list + never accept (0.67–1.97 s to the
  box), agent rejection (319 ms; truncated `lastLine`; `list` on attach), P/I/S/X settle with the
  captured ending matrix, corpus numbers (5,285 of 8,497 summaries → `turn_duration`; 1,944 gaps,
  p99 15,832 ms → `secondaryQuietMs` 32,000), waking records, background agents vs shells (D23),
  `turn_end_record_missing`, blocked/closed list, degraded mode (entry only when the transcript is
  absent/empty/off; 6 s screen quiet; reverts), delivery by kind + Read limits + coverage + answer
  start + exact `require_pattern`, env snapshot/shim/strips/MAGMUX_SOCK, D22, the three no-orphan
  layers with the fd-hygiene gate numbers (746 ms / 955 ms; old watcher 7,548 ms), identity, reap
  (why `force:true` is not enough), async-ps trap, limit 48, socket traps, EOF≠death, seq
  ownership, F7 latent (team-grid has no `--sock-dir`), D9/D10, phase table, mod contract v1
  summary → `pane/contract.ts`.
- Corrections vs the design while writing (code is the truth): the registry entry is created after
  the spawn loop but BEFORE the D9 `ready` await (`done` is built last); liveness maps cover every
  non-terminal slot, not only RUNNING; `heartbeat:true` is on FOUR tools (`preflight` too — the old
  doc said three); `--no-auto-approve` is reserved (phase-2 report §10 still says otherwise; a
  historical note); `get_session` in docs/usage never existed (→ `get_output`); `session_started`
  was never a channel event.

### Magmux pin (L9)

`release.yml` downloaded the LATEST MadAppGang/magmux release (floating). Now pinned
`MAGMUX_TAG="v0.14.0"`; the step fails if the pin is older than `MIN_MAGMUX_VERSION` parsed from
`pane-launch.ts` (`sort -V`), verifies the asset against the release's `checksums.txt`
(`shasum -a 256 -c`) and checks `magmux --version` of the extracted binary. Dry-run of the same
commands on darwin arm64: checksum OK, version OK, a 0.13.0 pin rejected. The
`@claudish/magmux-*` package versions are rewritten to the claudish release version at publish
(unchanged; they carry whatever binary the build job downloaded, now the pin).

### Residue grep (packages/, ai-docs/architecture/, docs/, CLAUDE.md)

Removed: `advisor-startup.ts` comment citing `agent-availability.ts`; `channel-diagnostic.ts`
verdict naming `StreamJsonReducer`; every doc occurrence of the reducer, `TurnEnd`, `awaitInput`,
`captureMode`, `CLAUDISH_TEAM_CAPTURE`, `spawnChild`, `terminateGraceMs`, `BG_CEILING_RE`,
`keepUnrecognizedJson`, the `finishing` channel event/status, `stderr.log`, 11/12/13-tool counts.
Remaining, each legitimate:

- `stream-json` in `cli.ts`, `index.ts`, `claude-runner.ts`, `types.ts`, `tui/runtime/*`: claudish's
  own user-facing `-p` single-shot mode and its stdout contract.
- `stream-json` in `madbench/*`, `channel/e2e-channel.test.ts`, `channel/test-helpers/client-diagnostic.ts`:
  those drive their OWN `claude -p` client (madbench eval; the e2e/diagnostic harness), not a session child.
- `--input-format stream-json` in `pane/child-flags.test.ts`, `channel/session-manager.test.ts`:
  asserts the flag is REFUSED.
- `stream-json` in `channel/session-manager.ts`, `channel/types.ts` comments: state its absence.
- `stream-json`/`--input-format stream-json` in `headless-vs-interactive.md`, `docs/usage/magmux.md`,
  `CLAUDE.md`, `team-capture.md`, `testing.md`, `team-lifecycle.md`, `mcp-channel.md`, `pane-session.md`,
  README row: the historical measurement (agent validation, the ALPHA/OMEGA capture) or a statement
  that the transport is gone.
- `magmux-drive-session` in `headless-vs-interactive.md`: "pane-drive.ts replaced it", with the old
  driver's measurements.
- `agent-availability.ts` in `headless-vs-interactive.md`: explains why the probe was deleted (D11).
- `spawnChild` in `process-tree.test.ts`: an unrelated local helper; in
  `team-orchestrator-settle.contract.test.ts`: the "deleted seam" porting note.
- `TurnEnd` substring: `onTurnEnd` (stream parsers / behavior layer) and `checkTurnEndMissing`
  (R3-M4), unrelated identifiers.
- `finishing`: only `activity:"finishing"` (contract, settle rule, team/channel tests), the
  RB1 absence tests, and the 10.4.0 disk-reader test record `status:"finishing"`.
- `nonzero_exit`, `background_task_ceiling`, `contract-fake-child`, `assertAgentAvailable`: no hits.

### REQ-18 decision

`team-run-mcp.contract.test.ts` "REQ-18/REQ-21 … within 1 s of the run call returning" failed at
1,013/1,014 ms under load (phase 5). The budget is incidental as measured: since D9, `run` returns at
prompt acceptance, so "return → meta.json" contains the fake's turn + follower poll + 500 ms
corroboration + 250 ms tick in another process — pane latency, not the record path. The real
requirement (REQ-21: the end is wired into `startModels`/`done`, at the settle, not a later poll)
is now measured directly: `meta.completedAt − max(slot completedAt in status.json) ≤ 1 000 ms`
(and ≥ 0), with a 10 s wait for the file. Same number, robust measurement, replaced assertion cites
D9 (porting rule). Mutation-proven: a 1,500 ms delay before `onSettled` fails it (Received 1505);
unmutated the file passes 4/4.

### Quality checks

- `bun run format` — 1 fix (folded into 90ab094a before anything was pushed); `bun run lint` —
  exit 0, 988 + 22 warnings (unchanged); `bun run typecheck` — exit 0; `bun run build` — ok.
- `bun run test:safe` (bun 1.4.0, before 2b93329a) — exit 0 — packages/cli **4964 pass, 36 skip,
  0 fail** (5000 tests, 324 files, 824.6 s); macos-bridge 20/0; scripts 5/0. Log `impl6/test-safe.log`.
- **CI parity, run 1** (`bun run test` with the 1.3.10 `.bin` first on PATH, `CLAUDISH_SKIP_LIVE_E2E=1`,
  under the guard): **118 failures** before it was stopped — every pane suite, starting with
  `MagmuxClient … connect retries until the socket binds`: `connect ENOENT /tmp/cpt-…/magmux-….sock`
  reported as an unhandled error. Cause (probed standalone): bun 1.3.10 emits the unix-socket
  ENOENT synchronously inside `net.connect()`, before `dialOnce` attached its listener; 1.4.0 defers
  it. Fixed in 2b93329a (`new Socket()`, listeners, then `connect`). Log `impl6/ci-parity-1-before-fix.log`;
  its 62 leftover `/tmp/cpt-*` dirs (no processes) were removed.
- **CI parity, run 2** (bun 1.3.10, after the fix) — exit 0 — packages/cli **4963 pass, 37 skip,
  0 fail** (5000 tests, 324 files, 827.7 s); macos-bridge 20/0; scripts 5/0. The +1 skip vs 1.4.0
  was not identified (version-dependent gate). Log `impl6/ci-parity.log`. After the fix, `bun test
  ./packages/cli/src/pane/` on 1.4.0: 282 pass / 3 skip / 0 fail (85 s). No `/tmp/cpt-*`, watcher,
  magmux or fake child left after any run.

### Notes for phase 7

- **CI timeout risk:** `test.yml` runs `bun run test` with `timeout-minutes: 10`; packages/cli alone
  took 824–828 s locally on both buns (baseline before panes was 697 s). If the macOS runner is not
  markedly faster, the hermetic gate times out. Check the first CI run of this branch; the fix would
  be the timeout (and its "healthy run is ~60s" comment), not skipping pane suites.
- The magmux-client fix means the previous phases' "green" was 1.4.0-only; phase 7's evidence run
  should state the bun version.
- The release job now needs `checksums.txt` in every future magmux release it is pinned to.


## Code-review fixes (iteration 1)

Input: `reviews/code-review/consolidated.md` (5 HIGH) and the four area reviews (17 MEDIUM, 29 LOW).
Base `bfc7614d`; 42 commits `64885f91..e5238527`, plus 4 changes left **uncommitted** because commit
signing stopped working mid-session (see "Not committed" below). Every HIGH and MEDIUM fix was
mutation-checked: the fix was reverted by copying the pre-fix file in (never git), the new test
failed, the fixed file was copied back.

### Live captures (Claude Code 2.1.291, native haiku, hermetic HOME, token in memory)

Harness `phase2/cr1-commands.ts`, `phase2/cr1-bgshell.ts` (login exactly as phase2-captures §1);
results in `phase2/runs/cr1*.out`, recorded in `ai-docs/reports/mcp-magmux-panes/phase2-captures.md`
§11. No process, socket or `/tmp/cc2/cr1-*` dir left (removed after copying the transcripts).

- `/exit` on 2.1.291 writes **no** user record (only `file-history-snapshot` + 2 × `cost-state`).
  Real 2.1.281/2.1.282/2.1.285 transcripts (`~/.claude/projects`) write caveat + `<command-name>/exit`
  + `<local-command-stdout>(no content)`; the 2.1.285 triple is redacted into
  `transcripts/corpus-redacted/exit-command.jsonl`. HIGH 1 is therefore real on ≤ 2.1.285 and latent on
  2.1.291; fixed for both.
- `/color yellow` → two `system/local_command` records (witness AND stdout): a user-record-only witness
  never accepts it — a defect the review did not name, fixed in `b9935130`. `/model haiku`, `/compact`
  → user caveat, `<command-name>`, `<local-command-stdout>`. The whole transcript is
  `transcripts/local-commands.jsonl` (fake child templates come from it).
- Long cwd (259 chars): projects dir `<200 slug chars>-g32rlu`. Rule read from the 2.1.291 bundle:
  `function eI(e){let n=k(e);if(n.length<=Rle)return n;return \`${n.slice(0,Rle)}-${Le(e)}\`}`, `Rle=200`,
  `Le(e)=Math.abs(_ne(e)).toString(36)`, `_ne` = `(e<<5)-e+charCodeAt|0` over the whole path.
  `projectDirNameFor` reproduces `g32rlu` exactly.
- `run_in_background` Bash in a production `PaneSession`: shell pid 58621 **pgid 58621** (own group),
  parent the `claude` process, pane group 58218; the normal reap ended it (Claude Code kills its
  shells on `close_pane`). The review's M6 suspicion is confirmed for every non-graceful path.

### HIGH

| # | finding | commit | test that fails without it |
|---|---|---|---|
| H1 | `/exit` after a settled turn → FAILED | `c3003c25` | integration "/exit after a settled turn…" (FAILED without both changes); follower "local commands > /exit's own records…" |
| H2 | local slash commands never settle | `47694f6d` (path L), `b9935130` (system witness), `4ad426fd` (panel `/cost` no longer holds the queue 30 s) | integration "local commands settle on their stdout…" (RUNNING "thinking" after 15 s without L; ADMITTING without the system witness); settle-rule "path L"; integration "/cost opens a panel…" |
| H3 | UTF-8 decoded per chunk | `64885f91` | follower "byte-safe tail" (东 split across two appends) |
| H4 | `send_input` success for a dropped prompt | `a453f712` | session-manager "send_input whose own step settles the one-shot turn…" (appends the withheld `turn_duration` and sends in the same tick) |
| H5 | project-dir truncation | `c0585cf7` | session-discovery "a slug over 200 characters…" (pins the measured `g32rlu` name) |

### MEDIUM

| finding | commit / rebuttal |
|---|---|
| A-M1 record-path tautology, unvalidated `paneId` | `13d66836` (+ `80884f77`, A-L3, resolved root so the new dirname checks hold) |
| A-M2 R3-M3 command-turn fallback | `6a9b948e` |
| A-M3 group members accumulate | `b32dfc42` |
| A-M4 per-turn state / answers unbounded | `72531115` |
| A-M5 lost `send` reply types the prompt twice | `9342e396` (client now distinguishes `client_lost` from `client_closed`) |
| A-M6 background shells outside the pane group | **measured, true** (above); `863f1796` records escaped descendants and signals them in the backstop, the sweep and the watcher shell |
| B-M1 sticky `turn_end_record_missing` | `0336206b` (live `turnEndRecordMissing`); NOTE: that commit's fake edit dropped the `quiet_no_summary` label (caught by the full 1.3.10 run); fix is uncommitted change 1 below |
| B-M2 `run.slots[].activity` lacks it | `0336206b` (in `toSlotRow`) |
| B-M3 shutdown awaits `terminal`, misses spawn-loop runs | `591052fd` |
| B-M4 SIGINT test proves nothing | `7492106c` (fails with the hook installs removed) |
| C-M1 unredacted `detail` | `ae2b371e` |
| C-M2 test gaps | covered by the H4 and C-M1 tests |
| D-M1 token-file writer rule | `5a752e27` |
| D-M2 nested claudish shares the parent's token file | `86fff258` (`CLAUDISH_PUBLISHED_TOKEN_FILE`) |
| D-M3 subcommand list drift | `4a548f99` (source-scan drift guard; 15 words match) |
| D-M4 `--verbose "text"` | partly **wrong**: `--verbose` is claudish's own boolean, so `--verbose "do X"` was already refused as a positional. The class is real for Claude Code booleans claudish does not know (`--brief now` passed): `38d80d54` (allow-list of Claude Code value flags from `claude --help` 2.1.291) |
| D-M5 CI tests a different magmux | `912e8749` (`.github/magmux.env` read by both workflows) |

### LOW

Fixed: A-L1 `65f637f8`; A-L3 `80884f77`; A-L4 `1668c1c6` (no new test: the socket-lost exit cannot be
staged deterministically); A-L6 pinned by the B-M1 team test; A-L7 `3a9ab29f`; B-L1 `8aacd250`;
B-L2 `4eeb38e9`; B-L3 `48782f0c`; B-L5 `8387be4d`; B-L6 `08d1c700`; B-L7 `869467cb`; B-L8 `875fa7a8`;
C-L4 `28e3a3d8`; C-L6 `68d52cc2`; C-L7 `de399bc4`; D-L1 `cb1cc18f` (pinned sha256s); D-L5 `6ac66fb8`.

Deferred (reason): A-L2 shutdown reap ≈ 6–7 s instead of ≈ 3 s (watchers cover an early SIGKILL; reordering
the reap is not a LOW-sized change); A-L5 spurious rewake after a screen settle (needs a deterministic
degraded-mode fixture); A-L8 / D-L4 redaction script key positions (checked-in fixtures are clean,
`fixtures-redaction.test.ts` passes); A-L9 a prompt starting `/word ` is typed as a command (needs a
product decision; undocumented limitation); B-L4 `run_id` fallback to the basename before the first
flush (needs the id minted before prehydrate); C-L1 `invalid_args` spawnModel recorded as `pane_lost`;
C-L2 STARTING with a null session (unreachable over MCP); C-L3 `closing` flag and bounded `before`;
C-L5 accounting frozen at the terminal transition (the monitor reads `tokens.json`); D-L2 import-time
`bootstrapPaneChild`; D-L3 release-version wording (waits for the §20.6 version decision).

Docs: `5e754754` (pane-session.md), `5c242baf` (context-window.md), `09b49f4e` (usage),
`e5238527` (capture report §11).

### Not committed (signing failed)

From the B-M1 fix onward commits were signed via 1Password; after `e5238527` every commit failed with
`error: 1Password: failed to fill whole buffer / fatal: failed to write commit object` for 40+ minutes
(retried every 20 s; the Mac was likely locked). Signing was not bypassed. Four changes are in the
working tree, messages in `cr1/msgs/`, one command to commit them in order: `sh cr1/commit-pending.sh`.

1. `test(mcp): restore the fake child's quiet_no_summary scenario` (staged) — B-M1's fake edit had
   dropped the label; "quiet_no_summary: never settles" failed on both buns.
2. `test(mcp): cancel idle interactive panes instead of awaiting the fake's exit` — `close()` helper.
3. `test(mcp): accept a lost close_pane reply when magmux exits at once` — the one 1.4.0 flake.
4. `ci: raise the hermetic test step timeout from 10 to 25 minutes`.

Also not done for the same reason: rewording four subjects (75, 73, 75 characters; two with "and":
`86fff258`, `8387be4d`, `5c242baf`, `869467cb`) — a `git rebase --exec` reword was prepared
(`scratchpad reword.sh`) and aborted when the first amend could not be signed; HEAD restored to `e5238527`.

### CI time (item 4)

- Before (bun 1.3.10, CI-scoped, JUnit): packages/cli **846.3 s** wall, Σ testcase time 1,125.6 s, of
  which the 51 pane/team/channel/mcp files 675.7 s (60%; concurrent files overstate). Top:
  `pane-session.integration` 312 s Σ (concurrent), recovery-contract black-box suites ≈ 300 s together,
  `pane-registry` 53 s, the channel record contract suites 32–39 s each. Pre-pane baseline (impl6) 697 s.
- Found: six integration tests ended an idle interactive session with `finish()` and waited for the
  fake's 20 s safety exit. `close()` cancels first: the file standalone **30.0 s → 16.0 s** (bun 1.4.0).
- After: packages/cli **834.3 s** (1.3.10) / **832.4 s** (1.4.0). The suite is dominated by non-pane
  work and was already over 10 min before panes, so `timeout-minutes` goes 10 → 25 with the numbers in
  the comment (uncommitted change 4). Sharing one magmux across tests was not attempted: per-test
  sockRoots are what make the no-orphan checks meaningful.

### Gates (final tree = HEAD `e5238527` + the 4 uncommitted changes)

- `bun run format` (no changes), `bun run lint` exit 0 (988 + 22 warnings, unchanged), `bun run typecheck`
  exit 0.
- `bun run test:safe`, bun **1.4.0**: packages/cli **5000 pass, 36 skip, 1 fail** (5037 tests, 326
  files, 832.4 s); the one failure is `magmux-client` "close_pane on the last pane" (lost reply under
  load; 6/6 standalone passes), fixed by uncommitted change 3 and re-run green standalone (5/5).
  macos-bridge and scripts not reached in that run (the cli step exited 1). Log `cr1/safe-140.log`.
- CI parity, bun **1.3.10** (`bun run test`, `CLAUDISH_SKIP_LIVE_E2E=1`, under the guard): packages/cli
  **5000 pass, 37 skip, 0 fail** (5037 tests, 326 files, 834.3 s); macos-bridge **20/0**; scripts **5/0**;
  exit 0. Log `cr1/ci-1310.log`.
- The earlier 1.3.10 measurement run (`cr1/before-1310.log`, before changes 1–2): 4999 pass / 37 skip /
  1 fail (`quiet_no_summary`, change 1).
- No `/tmp/cpt-*`, magmux, watcher or fake child left after any run.

## Phase-6 MEDIUM fixes

Findings M1 and M2 of `reviews/code-review/claude-internal-AD.md`. Both committed and signed (signing
worked again): `d7f9753d` (M2), `e323fe8d` (M1), built by `cr1/commit-medium.ts` in a temporary index
so the four pending changes kept out of them. Those four are still uncommitted and `cr1/commit-pending.sh`
still applies unchanged: the staged fake hunk is untouched, and `pane-session.integration.test.ts`'s
working-tree diff against the new HEAD is still only the `close()` hunks (my test went in via the blob
`cr1/blobs/pane-session.integration.test.m1.ts` = old HEAD + my test).

### M2 — escaped background shell dropped when its parent dies (`d7f9753d`)

- Cause: `mergeSnapshots` replaced `escaped` with the fresh list; a fresh snapshot finds an escaped process
  only while its ppid chain reaches a member, so after `claude` dies (shell reparented to pid 1) while the
  wrapper is still a verified member, the next refresh (2 s tick or reap step 0) wrote `escaped: []`.
- Fix: `mergeSnapshots(a, b, table)` keeps every recorded escaped (pid, lstart) still in `table`, plus that
  survivor's own descendants outside the pgid, alongside the fresh list; dead/reused pairs drop out.
  `refreshGroupOf` and `sweepGroup` pass their table. `pane-session.md` updated (residual: a shell started
  AND orphaned between two 2 s ticks is never recorded).
- Tests: `process-identity.test.ts` "merge keeps a recorded escaped shell whose parent died…" (captured ps
  table + synthesized rows, incl. reused pid); `pane-registry.test.ts` "escaped background shells" — a real
  `/bin/sh` wrapper (argv `--session-id <uuid>`, own session) whose bun "claude" spawns a detached
  `sleep 300` and exits; refresh in the window keeps it; the owner-EOF watcher ends wrapper + sleep; files
  removed. Mutation (merge reverted by file copy): both fail. (First draft used `exec sleep 60`, which
  dropped the wrapper's identity so the record was kept for the wrong reason — the test passed without the
  fix; fixed with `sleep 60; :` and an assertion that the wrapper still carries `--session-id`.)

### M1 — `/compact` abandoned at the 30 s admission bound (`e323fe8d`)

- Cause: the command witness matched only `<command-name>/compact`, which 2.1.291 appends after the boundary
  and summary (record 43, at compaction end); the plain typed `"/compact"` user record (record 34, no
  `isMeta`, no `origin`) is written at submit. Same in 2.1.290 (`tools-session` record 139). No other
  fixture has a plain slash-command user record (`/model`, `/pear` write none).
- Fix: `Witness` command form gains `line?` (the typed line; set by `planDelivery` for both command forms);
  `matchesWitness` accepts a main-chain, non-`isMeta`, non-tool-result user record whose text equals it.
  Accepted, compaction is RUNNING with no timer (D10); it settles via path L on its stdout. No admission
  timer was lengthened. `pane-session.md` witness paragraph updated.
- Fake: unchanged — it already writes the captured typed record first and honours `FAKE_GAP_MS_COMPACT`.
- Tests: `transcript-follower.test.ts` "/compact (2.1.291) is accepted at its typed record…" (mid-compaction
  replay accepted at record 34; name-only witness not accepted; finished turn has stdout, 1 compaction) and
  "a typed-line witness never matches an isMeta record or another command's line";
  `pane-session.integration.test.ts` "a /compact that outlasts the admission bound stays admitted…"
  (`FAKE_GAP_MS_COMPACT=4000`, `admitTimeoutMs 1500`, prompt queued behind: RUNNING with 1 pending past the
  bound, then `["local_command","turn_duration"]`, no `send_not_accepted`). Mutation (typed-line match
  removed by file copy): both new tests fail.

### Gates

- biome format + check on the 9 changed source files: clean; `tsc --noEmit` (packages/cli) exit 0.
- bun 1.4.0: process-identity, transcript-follower, prompt-delivery, settle-rule, pane-registry 110/0;
  pane-session.integration 50/0. bun 1.3.10: all six files 160/0. No `sleep 300`/`sleep 60`, magmux or
  watcher left after the runs. Whole suite not run (another agent running tests concurrently).

## Phase-6 arg validation

The two IMPLEMENTATION_ISSUEs of `tests/failure-analysis.md`, fixed in `mcp-server.ts`; the black-box tests
were not edited except for a biome format pass before committing them (whitespace only, checked by a
whitespace-insensitive comparison of all three files; without it `bun run lint` fails on them).

- `e1685ef3` fix(mcp): check team verb argument types before resolving the run. `teamContractVerb` read
  `args.spans === true` (a string was silently false) and checked `since_seq` only inside the capture
  branch, so `capture(spans:"yes")` at a run-less path answered `unknown_run`. Now path, run_id, slot,
  since_seq (integer) and spans (boolean) are type-checked for status/cancel/capture before any lookup,
  via new `optionalInteger` / `optionalBoolean`. Unit test in `team-list-contract.test.ts` (wrong types ×
  three verbs; well-typed args reach `unknown_run`) — status/cancel are not pinned by the black-box suite.
- `b4d7946d` fix(mcp): refuse a non-boolean include_completed or spans argument. `list_sessions` and
  `capture_session` (same `=== true` class) now use `optionalBoolean`; `capture_session.since_seq` uses
  `optionalInteger`. `capture_session spans:"yes"` added to `mcp-contract.e2e.test.ts` (not pinned by the
  black-box suite).
- `d9b7290f` test(mcp): add black-box tests for the mod contract and pane sessions (22 tests).
- Mutation (boolean check disabled by file copy): 4 tests fail — both black-box tests, the new unit test and
  the e2e assertion. Restored.
- Gates: biome format/check clean on the changed files (pre-existing mcp-server warnings only); tsc exit 0.
  Black-box 22/22 on bun 1.4.0 and 1.3.10. Full suite: bun 1.4.0 `test:safe` packages/cli 5029 pass /
  36 skip / 0 fail (5065 tests, 329 files), macos-bridge 20/0, scripts 5/0, exit 0; bun 1.3.10 CI-scoped
  5028 / 37 / 0, 20/0, 5/0, exit 0. Details in `tests/test-results.md`.
