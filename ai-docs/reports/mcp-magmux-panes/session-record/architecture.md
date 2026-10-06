# Architecture — MCP `team` slots and `create_session` as interactive Claude Code in headless magmux panes

Session: `dev-feature-mcp-magmux-panes-20261002-a7c3` · base `302a045b` · claudish 10.3.0 · magmux 0.14.0 ·
Claude Code 2.1.287. Inputs: `requirements.md`, `validation-criteria.md`, `spec-from-peer.md`, `research.md`
and its three detail files, `contract-amendments.md`, the plan review (`reviews/plan-review/consolidated.md`),
plus the repo's architecture docs. Thesaurus and CLAUDE.md invariants apply throughout. "Harness" means
Claude Code; "the child" is the claudish process in the pane; "foreign model" covers local models too.

**Revision 1** (plan review 1: 4 CRITICAL, 12 HIGH, 20 MEDIUM, 15 LOW, plus two ungraded findings treated
as HIGH). Finding ids below use the consolidated numbering (`C1`…`C4`, `H1`…`H12`, `M1`…`M20`,
`L1`…`L15`, `UG1` = `-p` injection through `claude_flags`, `UG2` = unreserved `--bg`). §17 maps each
CRITICAL and HIGH finding to the section that resolves it.

**Revision 2** (plan review 2: 1 CRITICAL, 7 HIGH, 16 MEDIUM, 13 LOW; ids `X-C1`, `X-H1`…`X-H7`, `X-M1`…`X-M16`,
`X-L1`…`X-L13`). The final revision. The owner watcher leaves the pane and becomes a server-spawned pipe
watcher (D15, §2.3, §2.10, §2.11); settle gains an interrupt path and a Stop-hook-gated secondary path (D14,
§2.8); file delivery gains read-coverage checking, line splitting and an answer that starts after the task
file was read (D13, §2.13); pane children lose the recovery watchdog (D22); only background agents are awaited
(D23). New evidence was measured for this revision from the local transcript corpus (3,083 files, read-only)
and is quoted where it is used. §18 maps every round-2 finding to its section; §8 changes are marked
**[amended r2]**.

**Revision r-base** (change of base). The design was written against main `302a045b` (claudish 10.3.0). It
is now built on the unmerged branch `feat/session-records` (head `cf4f7835`, version 10.4.0, untagged), which
adds per-run records under the sessions directory (`spawn.json`, `waits.jsonl`, the session and team
`meta.json`), the parent-conversation proof, a channel `finishing` state, `timeout_seconds` clamping and about
3,000 lines of blind contract tests. The magus `claudish` plugin monitor reads those records, so their on-disk
shapes are an external contract. §20 is the delta; edits to earlier sections are marked **[r-base]**. The §8
edits — the release-version note, the pre-contract range and one sentence on `finishing` — are marked
**[amended r-base]**; `SlotState` and every §8 type are unchanged.

---

## 0. Decisions at a glance

| # | Decision | Why (one line) |
|---|---|---|
| D1 | One new module, `packages/cli/src/pane/`. Its public surface is `pane/index.ts` and its live object is `PaneSession`. Team and channel both consume it. | One driver, so the traps are fixed once. Team stays out of `SessionManager`, for the reasons `team-lifecycle.md` gives (policy inversion). |
| D2 | One headless magmux per slot or session: `--headless --no-status --id <id> --sock-dir /tmp/claudish-mux-<uid> -e '. <launcher>'`, with `COLUMNS=160 LINES=50` and no `-w`. At most `MAX_LIVE_PANES = 48` live panes **per user, counted across every claudish process** from the pane records (r2, X-L11). | Independent lifetimes; cancelling one slot closes one magmux. 15 MB and 1 pty each (research §5/§7); the cap keeps us far below `kern.tty.ptmx_max` 511 (M14) even with several MCP servers. |
| D3 | The **transcript** decides turn state: acceptance, settle, answer and accounting. magmux supplies liveness (`exit`, pid), the screen (`watch` frames) and input (`send`). | magmux pushes no per-pane state for a `claudish` pane, and "running after send" proves nothing (research-magmux TL;DR 2, 5). |
| D4 | Boot readiness is read from screen **content**: the REPL input box with no dialog. A named dialog → FAILED `first_run_dialog`; an unnamed static non-REPL screen with choice markers → FAILED `boot_blocked`; both carry the screen text. Nothing is ever auto-accepted. | Dialogs default to "No, exit". The closed list names dialogs; it no longer decides whether boot is blocked (M2). |
| D5 | `--settings` overlay gains `skipDangerousModePermissionPrompt: true`, gated on the internal marker `CLAUDISH_PANE_CHILD=1`. | Suppresses dialog 3, verified at the flag tier. Gating on the marker keeps it off every other claudish launch. |
| D6 | One persistent socket connection per magmux with `watch {mode:"frames", fps:2}`. Frames are applied to an in-memory screen. claudish owns a monotonic `seq` (0 = no frame yet). A dropped connection is **reconnected**, never treated as a death. | `capture` is a memory read (NFR2), `seq` stays monotonic across magmux framer resets, and magmux closes slow subscribers on its own (H1). |
| D7 | The lifecycle is a **transition table over internal phases** (`BOOTING`, `ADMITTING`, `RUNNING`, `IDLE`, `QUESTION`, `PERMISSION` + five terminals), with a pure `wireState(phase, initialDelivery)` mapping to the closed nine-state contract set. `initialDelivery` is true only while the prompt the session was **created with** is being admitted (r2, X-M1: never keyed on the turn index). | Phases make "booting vs. prompt in flight" and "idle vs. blocked on a question" legal-transition distinctions instead of flags (H3, M1), while the wire set stays the frozen nine. |
| D8 | Policy stays with the owner. `PaneSession` calls `decide(turn)` and `onBlocked(block)`; team applies `require_pattern`/`min_output_bytes` and fails blocked slots; the channel applies its one-shot or interactive shape. | Keeps `PaneSession` from accreting team or channel rules (the facade's God-object risk). |
| D9 | `team(mode="run")` returns once every slot has **left STARTING** on the wire: its prompt was accepted (RUNNING), or it failed (boot or admission). Bounded by boot 90 s + admission 30 s = **120 s worst case**, about 12–20 s typical. | The dev plugin's team-gate polls `until no state === "RUNNING"`; a STARTING slot seen on the first poll would end the gate with 0 ballots. Boot and admission failures are reported synchronously (H4). |
| D10 | No claudish timer ever ends a **team slot** after its prompt was accepted. The two pre-work bounds — boot (90 s) and admission (30 s) — apply only before then, when no work exists to lose. Waiting on Stop hooks and background agents is likewise unbounded. A channel session's `timeout_seconds` is the caller's own explicit deadline and is the only post-acceptance timer (r2, X-L10). | `team-lifecycle.md`'s rule protects working slots; a slot whose prompt never reached the model has done no work. |
| D11 | Delete `agent-availability.ts` and its `claude -p` probe. **This overrides research decision 6.** | The interactive child refuses an unknown agent itself in ≈5.7 s, before any model request (measured). With two validators the cheap one always decides, so the real one is never exercised. |
| D12 | `cost_usd` is `null` for native routes. The token file is the cost source for foreign models. | Claude Code's `cost-state` is API-rate pricing — fictional spend for a subscription user (CLAUDE.md invariant) — and lands only at exit. |
| D13 | **Prompt delivery by kind** (`pane/prompt-delivery.ts`): a *plain* single line (≤ 512 printable chars, no leading `! # ? @ & \`, no trailing `@x`/`/x` token) is **typed**; a slash command is typed as its first line (≤ 512 chars, with a file pointer appended when more follows); **everything else is written to a 0600 turn file and the child is told, in one typed fixed-template line, to Read it.** No paste path. **[r2]** Lines longer than Read's per-line limit are split with a marker the template explains (X-H5); claudish verifies from the transcript that every line of the file was returned by Read, and a turn whose file was not fully read is FAILED `prompt_not_read` (X-H5, X-M4); the answer of a file-delivered turn starts **after** the Read result that completed coverage, so pre-Read narration never reaches `require_pattern` or `response-<slot>.md` (X-H4). | Removes every keystroke-reinterpretation hazard (CRLF, tab, ctrl-j, leading `!`, menus, `\x1b`), the 800-char paste heuristic, the 1 MB `send` lane cap and the 4 MB frame cap, and gives an exact acceptance witness. Cost: one or more Read calls per non-plain turn (H5, M4). Read's limits are made visible instead of silent. |
| D14 | **Settle = Claude Code's own "foreground turn finished" record, turn-scoped.** Primary: a `system/turn_duration` after the turn's last assistant message, with `pendingBackgroundAgentCount === 0`, background agents balanced, no pending tool, and the screen at an empty input box. **[r2] Interrupt:** a `[Request interrupted by user…]` record after the last assistant message settles the turn without `turn_duration` (X-H3). **[r2] Secondary** (no `turn_duration`): a measured full-quiet window (≥ 15 s), **allowed only once Stop hooks are known to be finished** — a `stop_hook_summary` after the last assistant message, or a session proven to have no Stop hooks (X-H2). Every turn-ending `stop_reason` is passed to the owner. | In a live interactive REPL `turn_duration` is written after Stop hooks finish (5,160 of 5,451 are directly preceded by `stop_hook_summary`) and is absent on re-wakes, closed sessions and plain interrupts (0 of 254), so the primary path waits for hooks and background agents by construction and no path can end a running hook (C1, H2). |
| D15 | **[r2] No-orphan design in three layers** (X-C1): (1) a **server-spawned pipe watcher** per pane — a detached `/bin/sh` whose stdin is a pipe from the owner. EOF on that pipe (the owner ended by any means, SIGKILL included) makes it kill that pane's magmux and pane group **after re-verifying each target's identity**, then clean the files; a clean reap ends it explicitly with `done`. It is not in the pane's process group and signals nothing on a clean reap. (2) A 0600 pane record per pane under `<SOCK_ROOT>/panes/` drives an identity-validated startup sweep for the rare case where the watcher itself was killed. (3) stdin EOF / transport close / SIGINT / SIGTERM / SIGHUP shut down with a parallel ≤ 3 s reap. **Every signal to a process that is not this process's own unreaped child is preceded by an identity check: magmux by its unique `--id <paneId>` argv, a pane group by a (pid, start time) member recorded while the group's identity was verified.** | NFR1 must hold when the server is SIGKILLed with no restart: magmux is detached into its own session and a client disconnect has no effect on panes (research-magmux §4, `e2` f), so without a watcher the REPL would run indefinitely. A pipe EOF is kernel-delivered, needs no polling and no owner pid, and so cannot be fooled by pid reuse. |
| D16 | **Exact parent environment in the child**: the server passes a JSON snapshot of its environment as `CLAUDISH_PANE_ENV` (inherited, never on disk); the pane child claudish re-applies it, then deletes it. The launcher `cd`s to the spawn cwd before `exec`. **[r2]** The pane shell is no longer a login shell: magmux's `$SHELL -l -c` runs a 0700 shim that drops `-l` and execs `/bin/sh -c`, so no profile runs at all (X-M15); the snapshot restores the real `SHELL` for Claude Code's Bash tool. Terminal-identity variables are stripped (X-M16). | Today's pipe spawn never crossed a login shell; this restores parity for credentials, `CLAUDE_CONFIG_DIR`, `SHELL` and cwd without writing secrets to the launcher (H8, M8), and removes profile side effects (prompts, `exec tmux`, slow init). |
| D17 | **`send_input` is accepted in every non-terminal phase and queued**; a serial admission pump delivers one prompt at a time when the session is IDLE, marking the transcript offset **before** delivery. During a question or permission dialog a send presses Esc, which **declines the dialog and interrupts the turn**; the interrupted turn settles through the interrupt path (D14) and the text is delivered as the next prompt. | Keeps today's "send while STARTING/RUNNING" behaviour and the one-shot→interactive conversion (M1), and makes admission atomic (H10). |
| D18 | `claude_flags` are checked twice: the server rejects reserved tokens **and any positional token** with claudish's own value-consumption rule; the pane child claudish (marker set) asserts after its own `parseArgs` that it is interactive, not a team run, with no positional prompt, and refuses to start otherwise. `-i` is passed explicitly. **[r2]** Print-mode-only Claude Code flags and claudish's own mode flags are reserved too (X-M3, X-L2). | Space-separated `--allowedTools Read Bash` or a `--` separator made claudish inject `-p` (UG1); `--bg`, `-w`, `--from-pr`, `--teleport`, `--no-session-persistence` break the pane or the derived transcript (UG2, M8); `--max-budget-usd` and friends would be accepted and silently ignored interactively. |
| D19 | A team slot that blocks on a question or permission dialog becomes **FAILED `blocked`** at once (the question text in detail). An interactive channel session waits in AWAITING_INPUT/AWAITING_PERMISSION. | Team has no answering verb, so a blocked slot can never finish; without this `judge`, `run-and-judge` and CLI `team` would wait forever (M10). |
| D20 | A settled API-error turn is **FAILED `api_error`** for every shape, including promptless interactive sessions. | The contract promises FAILED for an API error; Claude Code has already retried retryable statuses before writing `isApiErrorMessage` (H9). |
| D21 | Contract v1 answers of `team list`, `team status` and `list_sessions` carry `contract_version: 1` and `capabilities` (CA-12). Every §8 verb returns errors as JSON `ContractError`. | The mod tells "pre-contract claudish" from "server unreachable" without parsing prose; one envelope per verb (M15). |
| D22 | **[r2] A pane child is never eligible for a network-recovery surface** (X-H1). `magmuxPaneCapability()` returns `{kind:"none", reason:"pane-child"}` when `CLAUDISH_PANE_CHILD=1`, checked before its ambient branch, and claude-runner's ambient-install branch reads `paneCapability.kind === "ambient"` instead of its own `MAGMUX_SOCK` expression. So the pane child exports no `CLAUDE_CODE_RETRY_WATCHDOG` (and `applyRetryWatchdog` deletes a claudish-owned one inherited from a wrapped parent), installs no recovery UI and draws no overlay on the screen the classifier reads. | `network-recovery.md` §7 accepts ~300 client attempts (RISK-6, about a day, each a potentially billed re-POST) only where a person can see the banner; a headless per-slot magmux has no viewer. Tier 1's hold still runs, bounded by the derived `TIER1_DEADLINE_MS` (default 270 s); with no lease the exhausted episode answers an inline 400, Claude Code writes an API-error entry and the slot is FAILED `api_error`. One predicate, per that doc's own rule. |
| D23 | **[r2] Only background agents are awaited** (X-H6). The background balance counts Task/Agent launches with `run_in_background`, mirroring Claude Code's `pendingBackgroundAgentCount`. A background Bash is not awaited: if its `<task-notification>` arrives before settle it wakes the model and is part of the turn; otherwise the turn settles at Claude Code's own `turn_duration{pending:0}` and the anomaly `background_shell_open` names the command. For team and one-shot sessions the reap then ends the shell. | A dev server, watcher or `tail -f` never finishes, so awaiting it would hold `judge`, blocking `run-and-judge` and the team-gate forever and lock the review `path` against the next round. Claude Code itself declares the foreground turn finished at that point. Print mode's ≤ 600 s wait for such a shell is lost; recorded in §9.7. |
| D24 | **[r-base] Pane sessions write the session records of `feat/session-records`; nothing parallel is built.** `spawn.json` (both kinds), the team `meta.json` and their writers are kept unchanged. `waits.jsonl` is fed from a new uncoalesced `PaneSession` transition hook in place of the reducer callback. The session `meta.json` keeps every 10.4.0 key under its 10.4.0 name and meaning through `toMetaRecord(info)`. `events.jsonl` keeps one `assistant` line per message id. The channel `finishing` event is dropped; the end-of-turn wait is `activity:"finishing"`, and `SlotState` is unchanged (§20). | The magus monitor reads these files. Two records of one run would drift, and a meta.json without `status` reads as `failed` in every monitor line. |

---

## 1. Overview

### 1.1 Purpose

Every MCP `team` slot (`run`, `run-and-judge` and the judge children), every CLI `claudish team …` /
`--team --mode json` slot (they share `runModels`), and every `create_session` runs as an **interactive**
Claude Code session launched through claudish:
`claudish -i --model <spawnModel> -y --quiet --session-id <uuid> --add-dir <turnDir> [caller flags]`, with no
`-p`, no `--stdin`, no stream-json flags and no positional prompt. It runs inside a per-slot headless magmux
pane and is driven over the socket. The `-p`/`--stdin` spawn paths are deleted in the same change. The MCP
surface gains the status, list, stop and capture verbs the peer's Claude Code mod polls at about 1 Hz.

### 1.2 Component diagram

```
                       MCP host (Claude Code)  ── $.mcp.call("plugin:claudish:claudish", …) ── mod (peer)
                                │ JSON-RPC stdio  (EOF ⇒ shutdown, D15)
                    ┌───────────▼────────────────────────────────────────────────────────┐
                    │ mcp-server.ts                                                       │
                    │   team(mode=run|status|list|capture|cancel|judge|run-and-judge)     │
                    │   create_session send_input get_output cancel_session list_sessions │
                    │   get_diagnostics capture_session(new)                              │
                    └───────┬───────────────────────────────────────┬────────────────────┘
          team-cli.ts ──────┤ (CLI team / --team, same runModels)   │
              ┌─────────────▼──────────────┐          ┌─────────────▼──────────────┐
              │ team-orchestrator.ts        │          │ channel/session-manager.ts │
              │  policy: require_pattern,   │          │  policy: one-shot vs        │
              │  min_output_bytes, blocked, │          │  interactive, timeout,      │
              │  run registry (by PATH)     │          │  channel frames, disk       │
              └─────────────┬──────────────┘          └─────────────┬──────────────┘
                            │  decide(turn) / onBlocked(block)        │
                            └──────────────┬─────────────────────────┘
                                ┌──────────▼───────────────────────────────────────┐
                                │ pane/  (facade: pane/index.ts)                    │
                                │  PaneSession ── slot-state (phase table + wire)   │
                                │     ├─ admission pump ── prompt-delivery          │
                                │     ├─ pane-launch   (id, sock dir, env snapshot, │
                                │     │                 launcher, shell shim)       │
                                │     ├─ process-identity (pane-group + magmux id)  │
                                │     ├─ magmux-client (NDJSON, ids, reconnect)     │
                                │     ├─ screen-model  (frames → lines, seq, spans) │
                                │     ├─ screen-classifier (REPL/dialog/choice/err) │
                                │     └─ transcript-follower (turn-scoped reducer)  │
                                │  slot-row · accounting · pane-registry (records,  │
                                │  limit, shutdown hooks, sweep) · child-env (child) │
                                └───────┬──┬────────────────────────────────────────┘
          spawn (detached), stdin=pipe  │  │ spawn (detached) · unix socket /tmp/claudish-mux-<uid>/magmux-<id>.sock
   ┌────────────────────────────────────▼┐ ┌▼────────────────────────┐
   │ pane watcher: /bin/sh, argv0        │ │ magmux --headless        │  pane 0: <shim> -l -c ". launcher"
   │ claudish-pane-watcher <paneId>      │ │  (one per slot)          │   = /bin/sh -c ". launcher"
   │ read until "done" (clean) or EOF    │ └──────────────────────────┘   └ cd <cwd>; exec claudish → bun → claude
   │ (owner gone) → verify → kill → clean│
   └─────────────────────────────────────┘                                        │ writes
                                                                      ▼
                         <CLAUDE_CONFIG_DIR|~/.claude>/projects/<slug(realpath cwd)>/<uuid>.jsonl (+ <uuid>/subagents/)
                         <run>/stats/<slot>.json  or  <sessionDir>/tokens.json   (proxy accounting)
                         <SOCK_ROOT>/panes/<paneId>.json                          (pane record, sweep, limit)
                         <sessionsDir>/<id>/{spawn.json, waits.jsonl, meta.json, events.jsonl}, <sessionsDir>/team-<8 hex>/{spawn.json, meta.json}
                                                                                  (session records, read by the magus monitor; §20) [r-base]
                         <SOCK_ROOT>/launch-XXXXXX/{pane-launch.sh, sh-shim, group, turn-<n>.md} (launcher dir = turn dir)
```

### 1.3 Data flow of one team slot

```
startModels ─ check flags, pane limit ─ mint uuid, pane id ─▶ PaneSession.start
   │   launcher dir + record (magmuxPid null) ─▶ spawn watcher ─▶ spawn magmux ─▶ record magmuxPid ─▶ dial (≤5 s) ─▶ capabilities ≥0.14.0 ─▶ watch
   │                                        ▼
   │                                    BOOTING (wire STARTING) ── frames ─▶ screen-classifier
   │                                        │ repl stable 500 ms ─▶ ADMITTING (wire STARTING): mark offset → deliver
   │                                        │ named dialog / blocked screen / 90 s ─▶ FAILED ─▶ reap
   │                                        │ pane exit ─▶ FAILED agent_rejected | child_exited ─▶ reap
   │                                        ▼
   │◀── ready resolves ───────────── acceptance witness after the offset ─▶ RUNNING   (30 s bound, else FAILED prompt_not_accepted)
   │   (startModels returns once          │ pending tool ─▶ activity; AskUserQuestion ─▶ onBlocked ─▶ FAILED blocked
   │    ALL slots left STARTING)          │ turn_duration{pending:0} + agents balanced + task file fully read + empty box ─▶ decide(turn)
   ▼                                      ▼
 poll status/list/capture (memory)    team verdict: classifyRunOutput ─▶ COMPLETED | EMPTY | FAILED
                                      write response-<slot>.md, status.json, errors/<slot>.log ─▶ reap
```

---

## 2. Component design (`packages/cli/src/pane/`)

`pane/index.ts` is the facade. It exports `startPaneSession`, `PaneSession` (type), `buildClaudishPaneArgv`,
`checkChildFlags`, `assertMagmuxAvailable`, `reapAllPanes`, `sweepOrphanPanes`, `installPaneShutdownHooks`,
`livePaneCount`, `MAX_LIVE_PANES`, `toSlotRow`, and the contract types. **[r2]** `pane/process-identity.ts`
(internal) holds the one definition of "this pid is that pane's magmux" and "this process group is that pane's
group", used by the reap, the sweep and (as generated shell) the pane watcher. `pane/child-env.ts` is imported by the
CLI entry, not through the facade (it runs in the child). Internal files are imported only through the facade,
except by their own tests.

### 2.1 `pane/contract.ts` — the frozen wire types (also pasted in §8)

The single source of the mod contract types: `CONTRACT_VERSION`, `CAPABILITIES`, `SlotState`,
`TERMINAL_STATES`, `FailureReason`, `SlotRow`, `SessionRow`, `TeamRunRow`, `TeamListResult`,
`SessionListResult`, `CaptureResult`, `CaptureUnchanged`, `TeamCancelResult`, `SessionCancelResult` and
`ContractError`. `FailureReason` moves here from team-orchestrator because both owners produce it. Callers
import from `pane/index.ts`; there is no re-export shim from team-orchestrator.

```ts
export type FailureReason =
  | "cancelled"            // the caller stopped it — a decision, not a fault
  | "timeout"              // create_session timeout_seconds; team-grid (CLI) pane end
  | "boot_timeout"         // no REPL prompt within the boot deadline, screen still changing (screen tail in detail)
  | "boot_blocked"         // a static non-REPL screen that is not a named dialog blocked boot (screen text in detail)
  | "first_run_dialog"     // a named first-run dialog blocked boot (dialog text in detail)
  | "agent_rejected"       // the child refused --agent (its own "not found. Available agents" line)
  | "prompt_not_accepted"  // the first prompt never produced an acceptance witness within the admission bound
  | "prompt_not_read"      // [r2] a file-delivered turn settled without Read returning every line of its task file
  | "child_exited"         // pane child exited before the turn settled (exit code + last line + screen tail)
  | "pane_lost"            // the magmux PROCESS died without reporting the pane's exit
  | "blocked"              // team slot stopped on a question/permission dialog team cannot answer (question in detail)
  | "api_error"            // the settled turn is an isApiErrorMessage entry (or a screen-mode error row)
  | "refused"              // the settled turn's stop_reason is "refusal"
  | "empty_output"
  | "shape_mismatch";
```

Removed: `nonzero_exit` (replaced by `child_exited`: a pane has no process exit status of claudish's own) and
`background_task_ceiling` (print mode only).

### 2.2 `pane/slot-state.ts` — the lifecycle machine (phase table + wire mapping)

```ts
export type Phase =
  | "BOOTING"      // pane spawned, Claude Code not yet at an empty input box
  | "ADMITTING"    // a prompt is being delivered / awaiting its acceptance witness
  | "RUNNING"      // accepted turn in progress (incl. Stop hooks and background agents)
  | "IDLE"         // interactive session between turns, input box empty
  | "QUESTION"     // turn blocked on a pending AskUserQuestion
  | "PERMISSION"   // turn blocked on a permission / plan-approval dialog
  | "COMPLETED" | "FAILED" | "CANCELLED" | "TIMEOUT" | "EMPTY";

export type PhaseEvent =
  | "boot_ready_idle" | "boot_ready_admit" | "boot_dialog" | "boot_blocked" | "boot_deadline"
  | "admit"                       // pump starts delivering a queued prompt (IDLE only)
  | "prompt_accepted"             // witness found after the turn's offset
  | "admit_deadline"              // first prompt never accepted → FAILED prompt_not_accepted
  | "admit_abandoned"             // a later prompt never accepted → back to IDLE (anomaly, frame meta)
  | "blocked_question" | "blocked_permission" | "unblocked"
  | "turn_continue"               // decide() returned "continue"
  | "rewake"                      // [r2] interactive IDLE: a background notification woke the model (D23)
  | "verdict_completed" | "verdict_empty" | "verdict_failed"
  | "exit_clean"                  // interactive child exited 0 while IDLE after a requested /exit or ≥1 settled turn
  | "pane_exit" | "pane_lost" | "cancel" | "timeout";

const ANY_LIVE = { pane_exit: "FAILED", pane_lost: "FAILED", cancel: "CANCELLED", timeout: "TIMEOUT" } as const;

export const TRANSITIONS = {
  BOOTING:    { boot_ready_idle: "IDLE", boot_ready_admit: "ADMITTING", boot_dialog: "FAILED",
                boot_blocked: "FAILED", boot_deadline: "FAILED", ...ANY_LIVE },
  ADMITTING:  { prompt_accepted: "RUNNING", admit_deadline: "FAILED", admit_abandoned: "IDLE", ...ANY_LIVE },
  RUNNING:    { blocked_question: "QUESTION", blocked_permission: "PERMISSION", turn_continue: "IDLE",
                verdict_completed: "COMPLETED", verdict_empty: "EMPTY", verdict_failed: "FAILED", ...ANY_LIVE },
  IDLE:       { admit: "ADMITTING", rewake: "RUNNING", exit_clean: "COMPLETED", ...ANY_LIVE },
  QUESTION:   { unblocked: "RUNNING", verdict_failed: "FAILED", ...ANY_LIVE },
  PERMISSION: { unblocked: "RUNNING", verdict_failed: "FAILED", ...ANY_LIVE },
  COMPLETED: {}, FAILED: {}, CANCELLED: {}, TIMEOUT: {}, EMPTY: {},
} as const satisfies Record<Phase, Partial<Record<PhaseEvent, Phase>>>;

export function nextPhase(from: Phase, ev: PhaseEvent): Phase | null;   // null = illegal; never throws in production

/** The only place a phase becomes a contract SlotState. [r2] keyed on the delivery, not the turn index (X-M1). */
export function wireState(p: Phase, initialDelivery: boolean): SlotState {
  // BOOTING → STARTING; ADMITTING → initialDelivery ? STARTING : RUNNING; RUNNING → RUNNING;
  // IDLE, QUESTION → AWAITING_INPUT; PERMISSION → AWAITING_PERMISSION; terminals map to themselves.
}
```

- **[r2] `initialDelivery`** is true only while the `initialPrompt` the session was created with is being
  admitted (`boot_ready_admit`). A promptless session's first `send_input` is an ordinary later delivery: the
  wire goes AWAITING_INPUT → RUNNING (never back to STARTING), and a non-acceptance is `admit_abandoned` → IDLE
  with `send_rejected`, never FAILED. `admit_deadline` likewise applies only to an `initialDelivery` (X-M1).

- **Illegal transitions are recorded and refused, never thrown.** They become a diagnostics anomaly. A late
  pane `exit` can never overturn a CANCELLED or TIMEOUT that was already recorded (the absorbing-terminal rule
  salvaged from `stream-json-reducer.ts` `LEGAL_TRANSITIONS`).
- **A prompted session never shows AWAITING_INPUT before its prompt is accepted** (H3): `boot_ready_admit`
  goes straight from BOOTING to ADMITTING, and both map to STARTING while the `initialPrompt` is admitted.
- **Pane exit is decided against the current turn only** (C3). On `exit`, `PaneSession` first polls the
  follower once more, then selects exactly one event:
  1. phase RUNNING and the **current** turn (the latest accepted one) has settle evidence (§2.8, including
     the exit path X: an ending `stop_reason` with no waking record after it, `settledBy:"exit"` — r2, X-M11)
     → run `decide()`. A verdict → `verdict_*`, with the exit code in `detail` (M5). **[r2] `"continue"`**
     (an interactive session, no API error) → `turn_continue` (RUNNING → IDLE, `settledTurns++`), then
     re-evaluate rule 2 on the same exit (X-M10);
  2. phase IDLE, exit code 0, shape interactive, and either `exitRequested` (a `/exit` or `/quit` was
     delivered, §2.13) or `settledTurns ≥ 1` with **no admitted-but-unsettled turn** → `exit_clean` →
     COMPLETED;
  3. otherwise `pane_exit` → FAILED `agent_rejected` (if `agentRejectedLine` matches `exit.lastLine` or the
     final screen) or `child_exited` (this includes an interactive session that exits non-zero after a
     settled turn).

  "Turn 1 completed, turn 2 accepted, exit 0 before answering" is phase RUNNING without current-turn
  evidence → FAILED `child_exited`. A clean `/exit` between turns is `IDLE --exit_clean--> COMPLETED`, which
  the table allows. Both are pinned by tests (§12.3), as are r2's `exit_before_td` and
  `interactive_exit_after_settle` (§12.2).

### 2.3 `pane/pane-launch.ts` — ids, socket dir, environment, launcher, spawn

```ts
export const SOCK_ROOT: string;                                   // `/tmp/claudish-mux-${uid}`; [r-base] `CLAUDISH_PANE_ROOT` overrides it (§20.4)
export function ensureSockRoot(root?: string): string;            // mkdir 0700; lstat: must be a real dir (no symlink), owner === getuid(), (mode & 0o077) === 0
export function mintPaneId(kind: "t" | "s", label: string): string; // `c${pid}-${ownerStart36}-${kind}${label}-${6 hex}` (≤ 40 chars)
export function isValidPaneId(id: string): boolean;               // /^[A-Za-z0-9_-]{1,64}$/ && !/^\d+$/
export function sockPathFor(root: string, id: string): string;    // join(root, `magmux-${id}.sock`); assert < 100 bytes
export function buildPaneEnv(input: { parentEnv: NodeJS.ProcessEnv; slotEnv: Record<string, string>; cwd: string })
  : { magmuxEnv: Record<string, string> };
export function buildClaudishPaneArgv(spawnModel: string, sessionUuid: string, turnDir: string, callerFlags: string[]): string[];
// → ["-i", "--model", spawnModel, "-y", "--quiet", "--session-id", sessionUuid, "--add-dir", turnDir, ...callerFlags]
export function checkChildFlags(flags: string[]): { ok: true } | { ok: false; message: string };
export async function assertMagmuxAvailable(): Promise<{ binary: string; version: string }>; // cached per process
export function spawnPaneMagmux(input: SpawnInput): SpawnedPane;   // writes record + launcher, spawns magmux
```

`ownerStart36` is the server's start time in ms, base 36: together with the pid it makes a reused owner pid
detectable (L4).

**magmux binary.** `assertMagmuxAvailable` reuses `launcher/magmux-binary.ts` `findMagmuxBinary()` (bundled
`@claudish/magmux-<platform>-<arch>` first, then PATH — NFR3), then requires `capabilities.version ≥ 0.14.0`
and `protocol === 1`. Otherwise it throws `MagmuxUnavailableError` (`magmux_unavailable`, the found path and
version in the message). There is never a silent `-p` substitute (L9).

**Environment** (D16, H8).

- `magmuxEnv` = `parentEnv`, then:
  - minus `STRIPPED_CHILD_VARS` (`CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`; exported from
    `launcher/magmux-wrapper.ts`) and every `MAGMUX_*` key;
  - **[r2] minus `TERMINAL_IDENTITY_VARS`** (X-M16): `TMUX`, `TMUX_PANE`, `TERM_PROGRAM`,
    `TERM_PROGRAM_VERSION`, `TERM_SESSION_ID`, `COLORTERM`, `LC_TERMINAL`, `LC_TERMINAL_VERSION`, `WT_SESSION`,
    `CLAUDE_CODE_SSE_PORT`, `ENABLE_IDE_INTEGRATION`, and every key with prefix `ITERM_`, `KITTY_`, `WEZTERM_`,
    `ALACRITTY_`, `GHOSTTY_`, `VSCODE_`. Inert under `-p`, these steer a TUI's rendering and integrations (tmux
    teammate panes in the user's real session, IDE auto-connect). Phase 2 fixtures are captured with the same
    scrubbed environment so production screens match them;
  - **[r-base] minus the host-identity keys** `CLAUDISH_LAUNCHER_PID`, `CLAUDISH_LAUNCHER_PPID` (the npm launcher
    pair `hostPidFrom` reads) and `CLAUDE_CODE_SESSION_ID` (the HOST conversation's id, a candidate of the
    parent proof). They describe the MCP server's host, not the pane's fresh Claude Code session. Both are already
    harmless — the launcher pair is believed only when `CLAUDISH_LAUNCHER_PID` is the reader's real parent, and
    the env id is believed only when the proof finds the tool-use id in that transcript — but stripping them
    makes the pane's environment the one a terminal launch has (§20.3);
  - plus `COLUMNS=160`, `LINES=50`;
  - plus the slot env: `CLAUDISH_TOKEN_FILE`, `CLAUDISH_UPSTREAM_ERROR_LOG`, `CLAUDISH_PANE_CHILD=1`,
    `CLAUDISH_PANE_CWD=<realpath cwd>`, and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` only when the parent
    left it unset (suppresses title/resume-summary side calls billed on the routed model and the
    `ANTHROPIC_SMALL_FAST_MODEL=haiku` 404s of research §2.4);
  - plus **`CLAUDISH_PANE_ENV`** = `JSON.stringify(snapshot)`, where `snapshot` is the resulting environment
    minus the shell-managed keys (`MAGMUX_*`, `COLUMNS`, `LINES`, `TERM`, `SHLVL`, `PWD`, `OLDPWD`, `_`) and
    minus `CLAUDISH_PANE_ENV` itself. It carries the **real** `SHELL`;
  - **[r2] then `SHELL=<launcherDir>/sh-shim`** (X-M15), set after the snapshot is taken. magmux starts the
    pane as `exec.Command($SHELL, "-l", "-c", cmd)` (research-magmux §4); the shim (0700, generated, fixed
    content `#!/bin/sh` / `[ "$1" = -l ] && shift` / `exec /bin/sh "$@"`) drops `-l`, so no login profile runs:
    no profile prompt, no `exec tmux`, no `path_helper`, no per-pane init cost. The child restores the real
    `SHELL` from the snapshot, which Claude Code's Bash tool needs.
- **[r2] Size bound** (X-L13): Linux limits one environment string to `MAX_ARG_STRLEN` (131,072 bytes). A
  snapshot whose `CLAUDISH_PANE_ENV=…` string exceeds 131,000 bytes on Linux fails the spawn before anything
  starts, with `Error: pane environment snapshot is <n> bytes, over Linux's 131072-byte limit per variable`
  (slot FAILED `pane_lost` with that text; `create_session` returns it as its `Error: …` text). macOS has no
  per-string limit (only `ARG_MAX`, 1 MiB in total).
- The snapshot is inherited by magmux and the pane shell exactly as the original variables are — the same
  exposure class, never written to any file. Credentials hydrated by `prehydrateCredentialsForSpawn` are in
  it, so a profile that re-exports `OPENAI_API_KEY` or `CLAUDE_CONFIG_DIR` is undone in the child (§2.14).
- `MAGMUX_SOCK`, injected by magmux into the pane, is deliberately **not** in the snapshot: it is what sends the
  child claudish down its **ambient** branch instead of wrapping itself in a second magmux.

**Launcher.**

- Location: `mkdtemp(<SOCK_ROOT>/launch-)` with mode 0700 (charset `[A-Za-z0-9/_-]`, no `@`, no space); it is
  also the session's **turn directory** (`turnDir`, §2.13). `pane-launch.sh` is opened with `wx`, mode 0600.
- Contents (generated; every interpolated value is single-quote escaped). **[r2]** No watcher and no `PATH`
  line any more: the shim runs no profile, so `PATH` arrives unchanged, and orphan protection moved to the
  server-spawned pane watcher below (X-C1).

  ```sh
  cd -- '<realpath cwd>' || exit 97
  exec '<claudish>' <argv…>
  ```

- `cd` before `exec` makes the transcript slug independent of the spawn path (M8). Exit 97 surfaces as
  `child_exited` with a clear detail. Because the launcher `exec`s, the pane leader's command line is the
  claudish argv (it carries `--session-id <uuid>`); before the `exec` it is `/bin/sh -c . '<launcherDir>/
  pane-launch.sh'`. Both forms are matched by the pane identity predicate (§2.11).
- `<claudish>` comes from `resolveClaudishSpawn()`. A bare name is resolved with
  `Bun.which(name, { PATH: parentEnv.PATH })`; unresolved → `claudish not found on PATH`.
  `CLAUDISH_BIN=*.ts` gives `exec <bun> run <file.ts> …` (the test seam, and the Phase 7 built-tree seam).

**Pane watcher** (D15 layer 1, r2, X-C1). One per pane, spawned by the owner **before** magmux:

```
spawn("/bin/sh", ["-c", WATCHER_SCRIPT, "claudish-pane-watcher", paneId, sessionUuid, launcherDir, sockPath, recordPath],
      { stdio: ["pipe", "ignore", "ignore"], detached: true })      // then proc.unref(); proc.stdin unref'd
```

- `WATCHER_SCRIPT` is a constant (values arrive only as positional parameters, never interpolated). Its
  shape:

  ```sh
  while IFS= read -r l; do [ "$l" = done ] && exit 0; done   # "done" = clean reap: exit, signal nothing
  # EOF without "done": the owner is gone — SIGKILL included (the kernel closed its end of the pipe)
  export LC_ALL=C
  # 1. targets: magmux pid from $3/magmux.pid, else `pgrep -f -- "--id $1 --sock-dir"`;
  #    pane group from $3/group (pgid + (pid, lstart) members the owner recorded), plus a fresh snapshot
  #    taken now if the identity predicate still matches a member of that pgid (or of `pgrep -P <magmux>`'s group)
  # 2. TERM:  group verified → kill -TERM -<pgid>;   magmux verified → kill -TERM <pid>   (graceful quit)
  # 3. sleep 2; re-verify both; KILL whatever is still verified
  # 4. nothing verified alive → rm -f "$4" "$5"; rm -rf "$3"     (else leave the files for the sweep)
  ```

- **Verification before every signal** (the shared predicates of §2.11, emitted as shell from the same
  constants as `process-identity.ts`): magmux = `ps -o command= -p <pid>` contains `--id <paneId> --sock-dir`
  (the id is unique per pane, so a reused pid cannot match); pane group = some process whose pgid is the
  recorded pgid has a (pid, `lstart`) pair in the verified member set. A target that fails is never signalled.
  `$PPID` and bare pids are never used.
- **Why a pipe**: EOF is delivered by the kernel when the owner's last copy of the write end closes, for every
  way a process can end, with no polling and no owner pid to be reused. The watcher costs one blocked `sh`
  per pane (no CPU, ≈ 1 MB). It is in its **own** session (`detached`), so a terminal Ctrl-C, a group kill of
  the server, or `close_pane` never reaches it, and it is never a member of the pane group (which is why the
  round-1 launcher watcher broke the reap's verification).
- **Fd hygiene, a Phase 3 gate.** The design relies on the write end existing only in the owner: libuv creates
  stdio pipes close-on-exec, so magmux and later siblings must not inherit it. Phase 3 measures it under the
  runtime the server actually uses (Bun): `lsof -p <magmux pid>` and `lsof -p <sibling watcher>` show no
  descriptor of another watcher's pipe, and the registry test SIGKILLs an owner of **two** panes and requires
  both to be cleaned. **Fallback** if a leak is measured and cannot be fixed by spawn options: the watcher
  additionally polls the owner every 2 s by (pid, `lstart`) identity (`ps -o lstart= -p <ownerPid>` equal to
  the recorded value) and treats a mismatch as EOF.
- **Ending it**: the normal reap writes `done\n` and ends stdin after a verified reap (§2.10 step 6); if the
  watcher is still alive 1 s later the owner kills it through its own `ChildProcess` handle — this process's
  child, which Node never signals after reaping it, so the pid cannot be stale.

**Pane command.** The `-e` value is exactly `. '<SOCK_ROOT>/launch-XXXXXX/pane-launch.sh'`. It must never
contain `claude `, end in `claude`, or have the basename `claude`: any of those attaches magmux's
ClaudeCodeController, whose mtime- and first-prompt-based transcript discovery can lock onto the parent's or a
sibling's transcript (research-magmux §3). The old `claude-launch.sh` name is not used.

**Spawn.**

```
spawn(magmux, ["--headless","--no-status","--id",id,"--sock-dir",root,"-e",cmd], {
  cwd, env: magmuxEnv, stdio: ["ignore","ignore","pipe"], detached: true })
```

- magmux is its own process-group leader (`detached`), so `magmuxPgid === magmuxPid`.
- Any stderr line matching `ignoring --id`, `ignoring --sock-dir` or `magmux: socket` is fatal: the slot fails
  `pane_lost` with that line (magmux ignores an invalid id or directory and exits 0). The first 8 KB of stderr
  are kept for diagnostics.
- **[r2] Order** (X-L4): launcher dir → pane record with `magmuxPid:null` → watcher → magmux →
  `<launcherDir>/magmux.pid` and the record's `magmuxPid` written at once → `panePid` from the first snapshot →
  the first group snapshot (`<launcherDir>/group`). A crash between any two steps leaves the watcher (or, before
  it exists, the record) able to finish the job; a record with `magmuxPid:null` is handled by the sweep's
  socket probe and `pgrep -f -- "--id <paneId> --sock-dir"`.
- **[r2] Boot stagger** (X-L8): the slots of one `run` spawn 300 ms apart (inside D9's bound), so N REPLs do
  not write `~/.claude.json` in the same instant; R13 still measures it.

**Child flags** (D18, UG1, UG2, M8). `checkChildFlags` runs in `team(run)`, CLI team and `create_session`,
before any spawn; a failure is `invalid_args` (channel/`team` JSON error, CLI exit 2).

1. **Reserved tokens** (exact-token, `--flag=value` split first):
   - our own argv: `-i`/`--interactive`, `--model`/`-m`, `-y`/`--auto-approve`, `--quiet`/`-q`,
     `--session-id`, `--add-dir` is **allowed** (additive);
   - transport breakers: `-p`/`--print`, `--stdin`, `--output-format`, `--input-format`,
     `--include-partial-messages`, `--replay-user-messages`, `--json`, `--bg`, `--background`;
   - session/cwd identity breakers: `--resume`/`-r`, `--continue`/`-c`, `--from-pr`, `--teleport`,
     `--fork-session`, `-w`/`--worktree`, `--no-session-persistence` (it would switch off the transcript, the
     turn oracle);
   - **[r2] print-mode-only Claude Code flags** (X-M3): `--max-turns`, `--max-budget-usd`, `--fallback-model`,
     `--json-schema`, `--permission-prompt-tool`. Refused with "`<flag>` works only with `--print`; team slots
     and sessions are interactive panes, so it would be silently ignored". `--max-budget-usd` was a real
     spend cap under `-p`; accepting it and ignoring it would be a billing exposure. Listed in §9.7 and the
     BREAKING footer;
   - **[r2] claudish's own mode flags** (X-L2): `--team`, `-f`/`--file`, `--grid`, `--probe`, `--models`,
     `--monitor`, `--advisor`, `--version`, `--help`/`-h` — each would start a different claudish mode inside
     the pane (`-v` is `--verbose` in `cli.ts:379` and stays allowed).
2. **No positional token and no `--`.** The tokens are walked with claudish's own rule (`cli.ts:732-760`):
   an unknown flag consumes the next token iff it does not start with `-`; a known claudish flag consumes its
   declared arity; anything else is a positional prompt → refused, with the hint "claudish takes one value per
   flag: write `--allowedTools Read,Bash`". The walker is a pure function in `cli.ts`
   (`classifyPassthroughTokens`), and a table test pins it against `parseArgs` on the same inputs so the two
   cannot drift.
3. **Defence in depth, in the child.** When `CLAUDISH_PANE_CHILD=1`, the child claudish asserts right after
   `parseArgs` that `config.interactive && !config.team && !config._hasPositionalPrompt &&
   !config._hasPrintFlag && !config.stdin` (`!config.team` added in r2); otherwise it prints
   `claudish: pane child refused: <reason>` and exits 64 → FAILED `child_exited` with that line. This catches
   any flag the server-side walker mis-classifies.
4. If the flags visibly remove the Read tool (`--disallowedTools` containing `Read`, or a `--tools` list
   without it), only *plain* prompts can be delivered (§2.13); a non-plain prompt is refused with
   `invalid_args` naming the reason. This is only the cheap early refusal: an `--agent` whose `tools:` list
   lacks Read, or a model that cannot call tools, is caught by the transcript's read-coverage check, which
   makes such a turn FAILED `prompt_not_read` instead of COMPLETED (r2, X-M4; §2.13).

### 2.4 `pane/magmux-client.ts` — socket transport

```ts
export class MagmuxClient {
  static async connect(sockPath: string, opts?: { retryMs?: number; timeoutMs?: number }): Promise<MagmuxClient>; // retry every 50 ms up to 5 s
  request<T = Record<string, unknown>>(msg: Record<string, unknown>, timeoutMs?: number): Promise<MagmuxReply<T>>;
  on(ev: "snapshot" | "exit" | "pane_closed" | "results" | "shutdown" | "frame" | "disconnected", fn: (e: any) => void): void;
  close(): void;
}
export type MagmuxReply<T> = { ok: true; result: T } | { ok: false; code: string; error: string }
  | { ok: false; code: "client_timeout" | "client_closed"; error: string };
```

- One reader per connection, buffering partial lines across chunks; `reply` dispatched by string id (`r<n>`),
  everything else to listeners. (Not the per-request-listener pattern of `recovery/magmux-ui.ts:201`, which
  can lose a line split across chunks.) The reader never awaits inside the data handler, so magmux's per-
  subscriber limits (1024 messages / 8 MB / 2 s write deadline, research §7.3) are not hit by our own stalls.
- Every request carries an `id`. Unknown event types (`control`, `overlay`) are ignored.
- EOF emits `disconnected` with `{sawShutdown: boolean}` and resolves every pending request
  `{ok:false, code:"client_closed"}`. **EOF is not a death signal**; `PaneSession` decides (§2.9 Reconnect).

### 2.5 `pane/screen-model.ts` — watch frames to a screen with claudish's seq

```ts
export interface ScreenState { seq: number; cols: number; rows: number; cursor: { x: number; y: number };
  lines: string[]; spans: Array<Array<[number, number, number, number, number]>>; alt: boolean;
  changedAt: number; aboveBoxChangedAt: number }
export function emptyScreen(cols: number, rows: number): ScreenState;           // seq 0, rows × ""
export function applyFrame(s: ScreenState, frame: MagmuxFrame): ScreenState;
export function applyCapture(s: ScreenState, cap: MagmuxCapture): ScreenState;  // finalisation path; pads to rows
```

- A keyframe replaces all rows; a delta replaces the rows it names. All metadata (`spans`, `alt`, cursor) is
  always applied (M16).
- `seq` is **0 until the first frame is applied**, then `seq++` on every visible change: row text, spans,
  cursor, `alt`, `rows` or `cols`. magmux's own frame `seq`, which resets per framer, is ignored. (A blank
  first keyframe is seq 1, so `seq:0` unambiguously means "no frame yet" — M12.)
- `aboveBoxChangedAt` tracks changes to the rows **above the input box's top rule** only. The settle quiet
  window reads it, so a ticking status line under the box does not hold a turn open (M3). `seq` stays honest
  and does count status-line changes: the mod should redraw them.
- `lines.length === rows` always, each right-trimmed. On reconnect the client re-issues `watch`; the first
  frame is a keyframe and the local `seq` keeps counting.

### 2.6 `pane/screen-classifier.ts` — what the screen says

```ts
export type BootReading =
  | { kind: "repl" }                         // input box: rule ─(≥20) / line starting "❯" / rule, nothing typed
  | { kind: "dialog"; name: "onboarding" | "trust" | "bypass" | "api_key"; text: string }
  | { kind: "choice"; text: string }         // unnamed: numbered options or Yes/No rows, no input box
  | { kind: "booting" };
export function readBoot(s: ScreenState): BootReading;           // alt and primary screens both read (dialog 4 is primary)
export function inputBox(s: ScreenState): { top: number; text: string; menuOpen: boolean; menuItem: string | null } | null; // text excludes placeholder cells
export function hasChoiceDialog(s: ScreenState): boolean;        // permission / plan approval / AskUserQuestion
export function isWorking(s: ScreenState): boolean;              // "esc to interrupt" visible — defence in depth only
export function transcriptSavingOff(s: ScreenState): boolean;    // "Transcript saving is off"
export function screenErrorRows(s: ScreenState): string[];       // "⎿  API Error…", login/quota rows (from real captures)
export function screenAnswer(s: ScreenState, echo: string): string; // ⏺ prose rows after the echo, minus tool/spinner/token rows
export function agentRejectedLine(text: string): string | null;  // /--agent '([^']+)' not found\. Available agents:[^\n]*/
export function screenText(s: ScreenState): string;
```

- **Named dialogs** are a closed list, each backed by a verbatim real capture in `pane/test-fixtures/screens/`
  (research-transcript §4): `Choose the text style` (onboarding), `Is this a project you created or one you
  trust` (trust), `running in Bypass Permissions mode` (bypass), `Detected a custom API key in your
  environment` (api_key). The list only **names** a dialog.
- **Unnamed blocking screens** (M2): `choice` is any screen without an input box that shows a numbered-option
  row (`/^\s*(❯\s*)?\d+\.\s+\S/`) together with a `Yes`/`No`/`(esc)` row, or `Press Enter to continue`. A
  `choice` reading static for 5 s → FAILED `boot_blocked` with the screen text. At the 90 s deadline a static
  non-REPL screen is `boot_blocked`, a still-changing one `boot_timeout`.
- **Choice-dialog markers, named now** (H7) and confirmed or corrected against Phase 2 captures before Phase 3
  starts: permission — `Do you want to proceed?` / `Do you want to make this edit to` / `Do you want to create`
  with `1. Yes` and a `No, and tell Claude what to do differently (esc)` row; plan approval — `Would you like to
  proceed?` with `1. Yes,`; AskUserQuestion — the tool's option list with a `Type something` / `Other` row.
  `hasChoiceDialog` requires a numbered `1.` row and an `(esc)` or `No` row in the bottom 20 rows, outside the
  input box.
- `isWorking` is never required by any rule (M20); it only vetoes a settle or a degraded acceptance when it
  is visibly true.
- **[r2] "Empty input box"** (X-M14), used by boot, both settle corroborations and degraded mode:
  `inputBox().text` is built from the box row's cells **excluding placeholder styling** — cells whose `spans`
  attribute is dim/faint, or whose foreground equals the placeholder colour measured in Phase 2 (magmux's
  `attr` documents only bold, so the colour rule is the fallback). Ghost text (placeholder, prompt
  suggestion) therefore reads as empty; typed text does not. Phase 2 captures a post-turn idle screen with a
  prompt suggestion showing and a fresh-boot placeholder, and the gate requires both to classify as empty.
- `agentRejectedLine` reads `exit.lastLine` first, then the final screen captured with a scrollback `offset`,
  so a long agent list cannot push the line off screen (L8).

### 2.7 `pane/transcript-follower.ts` — the turn-scoped oracle

```ts
export class TranscriptFollower {
  constructor(path: string, subagentsDir: string);
  poll(): boolean;                     // read appended bytes (partial-line safe); stat subagents/ for activity; true when anything new
  size(): number;                      // current byte offset (after a poll)
  openTurn(t: { index: number; offset: number; witness: Witness }): void;  // turn N owns records strictly after offset
  view(): TranscriptView;
}
export type Witness =
  | { kind: "text"; text: string }               // typed plain line or the file-reference instruction (exact)
  | { kind: "command"; name: string };           // slash command: its <command-name> record
export interface TranscriptView {
  availability: "ok" | "absent" | "empty" | "off";  // §2.8 degraded entry
  current: TurnView | null;            // the latest opened turn
  settledTurns: number;                // turns that reached a verdict or "continue" → turns_completed
  usage: { tokensIn: number; tokensOut: number };   // per message.id, main chain + subagents/*.jsonl
  toolCalls: number;                   // unique tool_use ids, main chain + subagents
  lastAppendAt: number | null;         // main transcript or any subagent file
  session: SessionFacts;               // [r2]
}
export interface TurnView {
  index: number;
  acceptedAt: string | null;           // ISO of the witness record; null until accepted
  assistantText: string[];             // every assistant text block after the witness, in order (excl. isApiErrorMessage)
  lastAssistant: { messageId: string; stopReason: string | null; isApiError: boolean } | null;
  turnDurationAfterLast: { pendingBackgroundAgentCount: number | null } | null; // a turn_duration after lastAssistant
  stopHookSummaryAfterLast: boolean;
  interruptAfterLast: { forToolUse: boolean } | null;   // [r2] "[Request interrupted by user…]" after lastAssistant (§2.8 path I)
  pendingTool: { id: string; name: string } | null;
  agentsLaunched: number; agentsCompleted: number;      // [r2] background AGENTS only (D23)
  backgroundShellsOpen: string[];                        // [r2] background Bash commands with no notification yet (reported, not awaited)
  apiError: { status: number | null; category: string | null; text: string } | null;
  compactions: number;                 // isCompactSummary records seen inside the turn
  // [r2] file delivery (§2.13): null for typed / command-without-file turns
  delivery: { file: string; lines: number } | null;
  readCoverage: { linesReturned: number; complete: boolean; reads: number; completedAtOffset: number | null };
  preambleBytes: number;               // assistant text before completedAtOffset, excluded from the answer
}
export interface SessionFacts { stopHooksSeen: boolean; provenHookless: boolean } // [r2] across this session's settled turns (§2.8 S)
export function applyRecord(state: FollowerState, record: Record<string, unknown>, offset: number): FollowerState; // pure
```

- **Turns are segmented by claudish's own deliveries, not by user records** (C3, H12). Turn N is every record
  whose byte offset is greater than turn N's offset (taken before delivery, §2.9), up to turn N+1's offset. No
  evidence from an earlier turn can satisfy a later one.
- **Acceptance witness** (H10, M13): the first record after the offset that is a main-chain user record whose
  trimmed text equals the delivered line (`text`), or a `<command-name>/name</command-name>` record (`command`).
  Phase 2 captures a real slash-command transcript and a local-command (`/cost`) transcript to pin the
  `command` shape; a local command's settle evidence is its `<local-command-stdout>` record.
- Within a turn, user records that are not our witness — `tool_result`, `<task-notification>`, Stop-hook
  feedback, `isCompactSummary: true` — never end the turn and never contribute answer text. A compaction
  inside a turn therefore keeps pre- and post-compaction assistant text in one answer (H12). This logic lives
  in the follower's reducer; `mainConversationTurn` (reused for the sidechain, `isMeta` and envelope
  exclusions) is not changed.
- **Usage is taken once per `message.id`** (every split line repeats the full usage: 17,308 of 17,308
  surveyed): `tokensIn` = input + cache_creation + cache_read; `tokensOut` = output_tokens. Subagent files are
  included and deduplicated the same way, so native and foreign rows report on the same basis (M6).
- `assistantText` keeps every text block in order; the answer is `assistantText.join("\n\n")`, the
  concatenate-everything rule of `team-capture.md`. **[r2] For a file-delivered turn** (X-H4) `assistantText`
  holds only text blocks of assistant records **after** `readCoverage.completedAtOffset` — the `tool_result`
  record with which Read's returned lines first covered every line of `turn-<n>.md`. Text in earlier records
  (typically "I'll read the task file first.", including text in the same message as the Read `tool_use`) is
  counted in `preambleBytes` and shown in diagnostics, never in the answer. If coverage never completes, the
  answer is the text after the last Read result of the file, and the turn is FAILED `prompt_not_read` anyway
  (§2.13).
- **[r2] Read coverage** (X-H5, X-M4): every main-chain Read `tool_use` whose `file_path` equals the turn file
  is paired with its `tool_result`; the line numbers **actually returned** (parsed from Read's numbered
  rendering, format pinned by the Phase 2 capture) are unioned. Requested `offset`/`limit` are not trusted,
  since Read may return fewer lines than asked (token cap); an `is_error` result contributes nothing.
  `complete` ⇔ the union covers lines 1…`delivery.lines`.
- **[r2] `SessionFacts`**: `stopHooksSeen` once any `stop_hook_summary` appears in the session;
  `provenHookless` once, with `stopHooksSeen` false, a settled turn's **`end_turn`** assistant record is
  followed directly by its `turn_duration` (no `stop_hook_summary` between). Corpus basis (3,083 files):
  every `stop_hook_summary` carries `hookCount ≥ 1`, so it is written only when Stop hooks exist; 5,160 of
  5,451 `turn_duration` records are directly preceded by one; of the 279 that are not, in sessions that do
  have Stop hooks, 154 follow a synthetic API-error line (`stop_sequence`), 90 an interrupt record, 33 a
  `system/informational` and 2 a `tool_use` — **none follows an `end_turn`**. Stop hooks therefore do not run
  after an API error or an interrupt, and an `end_turn → turn_duration` pair proves the session has none.
- Polling is a stat-size check on every applied screen frame (debounced 250 ms) plus a 1000 ms backstop
  interval — no faster than the reference driver's 600 ms (FR4).

### 2.8 Settle rule (D14) and degraded mode, in `PaneSession`

**Settle evidence for the current turn (transcript source).** Conditions 1, 2 and 4 always; exactly one of
the paths in 3; condition 5 unless the path says otherwise.

1. The turn is accepted, and `lastAssistant` exists after the witness.
2. No main-chain assistant record and no witness-less user record that wakes the model (`task-notification`,
   Stop-hook feedback) follows `lastAssistant`. (An interrupt record is not a waking record; path I reads it.)
3. **One settle path:**
   - **P — primary.** `turnDurationAfterLast` exists and its `pendingBackgroundAgentCount` is `0` (or absent
     and the agent balance is closed). Claude Code writes `turn_duration` only after Stop hooks complete
     (5,160 of 5,451 `turn_duration` records directly follow a `stop_hook_summary`; the rest follow API
     errors, interrupts and informational records, never an `end_turn`, §2.7) and omits it on a re-wake — so a
     blocking Stop hook of any duration simply produces more assistant records and a later `turn_duration`.
     `settledBy: "turn_duration"`.
   - **I — interrupt** (r2, X-H3). `interruptAfterLast` is set: a main-chain user record whose text begins
     `[Request interrupted by user` (both the plain and the `… for tool use]` form) after `lastAssistant` or
     after the pending tool's `tool_result`, and no assistant record after it. The interrupt resolves the
     pending tool (the rejection `tool_result` precedes it). `turn_duration` is accepted but **not required**:
     in the corpus, 91 of 127 "for tool use" interrupts are followed directly by `turn_duration`, 36 are not,
     and **0 of 254** plain interrupts are. `stopReason: "interrupted"`, `settledBy: "interrupt"`, answer = the
     text so far.
   - **S — secondary** (no `turn_duration`, no interrupt). `lastAssistant.stopReason ∉ {tool_use,
     pause_turn}` (incl. `null`) or `isApiError`; **and Stop hooks are known to be finished** (r2, X-H2):
     `stopHookSummaryAfterLast`, or `session.provenHookless`, or `isApiError` (Stop hooks do not run after an
     API error, §2.7); **and full quiet** for `secondaryQuietMs`: no append to the main transcript or any
     subagent file, and no change above the input box. `secondaryQuietMs = max(15 000, 2 × p99)` of the
     `stop_hook_summary` → next main-chain append gap (the re-wake gap, 422 corpus cases), measured in Phase 2
     and recorded with the number in `pane-session.md`; it is a constant with a test-only override (§2.9).
     `settledBy: "quiet"`, anomaly `settled_without_turn_duration`. **A running Stop hook can never satisfy
     S**: until its summary is written there is no summary, and a session with Stop hooks is never
     `provenHookless`. S is a safety net for an ending the Phase 2 matrix (§13) did not reveal; any ending that
     Phase 2 shows lacking `turn_duration` gets a named path like I before Phase 3.
   - **X — exit** (r2, X-M11). Only on the pane-exit path (§2.2): `lastAssistant.stopReason ∉ {tool_use,
     pause_turn}` and no waking record after it. No screen corroboration (the pane is dead). `settledBy:
     "exit"`. Research §1.7 counts 76 end_turns followed by a closed session with no `turn_duration`.
4. `pendingTool === null` (or resolved by path I) and the **agent** balance is closed: `agentsLaunched ===
   agentsCompleted`, counting only Task/Agent launches with `run_in_background` (D23; Phase 2 pins the launch
   and `<task-notification>` record shapes). Background Bash is not in the balance; open shells are listed in
   `backgroundShellsOpen` and, if any remain at settle, recorded as the anomaly `background_shell_open:
   <command>` (and in the team `detail` of a COMPLETED slot's status anomalies).
5. **Screen corroboration** (paths P, I, S): an input box is visible and empty (§2.6), no choice dialog,
   `isWorking` not visibly true, and 500 ms with no further main-chain chat record. **While disconnected**
   (r2, X-M12) the in-memory screen is stale, so P and I settle on transcript evidence alone with the anomaly
   `screen_unverified`; S waits for the reconnect.

**Activity while unsettled** (never a timer, D10): `"background"` when only the agent balance or
`pendingBackgroundAgentCount` is outstanding; **[r2] `"finishing"`** when the model's last message has an
ending `stop_reason` but neither `turn_duration`, an interrupt nor S's Stop-hook condition holds yet —
typically a Stop hook still running; otherwise the pending tool's name or `"thinking"`. "Wait for background
agents" moves from Claude Code's print mode (≤ 600 s) to claudish, unbounded; recorded in `pane-session.md` and
`team-capture.md`.

**[r2] Interactive re-wake** (D23). In an interactive session that has settled a turn (IDLE), a background
shell's or agent's `<task-notification>` can wake the model with no prompt of ours. A main-chain assistant
record or waking user record appearing in IDLE fires `rewake` (IDLE → RUNNING): it continues the **same** turn
index, the pump does not deliver while RUNNING, the new text is appended to `output.log`, and the next settle
runs `decide()` again without incrementing `turns_completed` a second time. Team and one-shot sessions are
terminal at settle and reaped, so they never see it.

**Stop reasons** (H2). `SettledTurn.stopReason` carries `lastAssistant.stopReason`, or `"interrupted"` on
path I. `end_turn`, `stop_sequence`, `max_tokens`, `refusal` and `null` all settle through 1–5; `tool_use` and
`pause_turn` never settle except through path I (the harness continues them). `classifyRunOutput` maps
`refusal` → EMPTY `refused`, and appends "stop_reason max_tokens: the answer may be truncated" to `detail` for
`max_tokens`. Phase 2 captures what Claude Code 2.1.287 writes for a `max_tokens`, a `refusal`, an API-error
and an interrupted turn, in a config with no Stop hooks and in one with a Stop hook (§13), and the fake
templates those records.

**Degraded mode (`turnSource: "screen"`)** (C4, M20; **r2: per turn, re-entrant and leavable**, X-H7).
Evaluated afresh for every turn; each turn starts on the transcript source. Entered when, for the current
turn:

- `availability === "off"`: the screen shows `Transcript saving is off`; or
- 10 s after delivery there is no witness and `availability` is `absent` (no file) **or** `empty` (file
  exists, no record after the offset), **and** the input box no longer holds the delivered text.

Neither entry requires `isWorking` to have been sampled. **The follower keeps polling in degraded mode.** If
the current turn's witness appears (a slow UserPromptSubmit hook delays the user record past 10 s: Claude Code
clears the box on submit and writes the record after the hooks return, default hook timeout 60 s), the turn
returns to the transcript source at once (`turnSource:"transcript"`, anomaly `degraded_reverted`) and every
transcript rule applies from then on. Immediately before a screen-mode settle the follower is polled once more,
with the same reversion. In degraded mode:

- **Acceptance:** the input box emptied of the delivered text **and** either the echo row `❯ <first 40 chars>`
  above the box or any change above the box since delivery.
- **Settle:** input box visible and empty, no choice dialog, **at least one answer row (`⏺` prose) after the
  echo**, and no change above the box for `2 × 3000` ms. **[r2]** The pure-quiet alternative (no change above
  the box for `secondaryQuietMs`, no answer row) applies **only** when `availability === "off"`, the one case
  in which the transcript is known never to arrive; for `absent`/`empty` a turn with no answer row stays
  RUNNING (it is most likely a slow prompt hook), so a slow hook can no longer yield an EMPTY screen answer.
- **Errors:** an API error is (a) a new entry in the slot's `CLAUDISH_UPSTREAM_ERROR_LOG` during the turn
  (structured, claudish-written, foreign routes) or (b) `screenErrorRows` after the echo with no `⏺` prose
  rows (native routes). Either → `apiError` set → FAILED `api_error` with the text.
- **Answer:** `screenAnswer` — `⏺` prose rows and their indented continuations, excluding tool rows
  (`⏺ Name(`), spinner rows and token rows (L14). It is capped at the visible screen; the anomaly
  `screen_answer_may_be_truncated` is recorded and `captureSource` is `"screen"`.
- Accounting comes from the token file only. The transition is recorded in diagnostics.
- **[r2]** Read coverage of a file-delivered prompt cannot be checked from the screen: the turn is not failed
  `prompt_not_read`, the anomaly `read_coverage_unverified` is recorded instead.

F4 (strip `CLAUDE_CODE_CHILD_SESSION`) makes `off` unlikely; degraded mode exists for FR5's "missing or empty"
case, not as a normal path.

### 2.9 `pane/pane-session.ts` — the live object

```ts
export interface PaneSessionOptions {
  kind: "t" | "s"; label: string;
  callerFlags: string[];                 // already checked by checkChildFlags
  spawnModel: string; cwd: string; sessionUuid: string;
  transcriptPath: string;                // transcriptPathFor(realpath cwd, sessionUuid) — caller derives (F1, F2)
  slotEnv: Record<string, string>;
  shape: "one-shot" | "interactive";
  initialPrompt?: string;                // enqueued before boot; delivered on boot_ready
  readAvailable: boolean;                // false when callerFlags remove Read (§2.3 rule 4)
  decide: (turn: SettledTurn) => FinalVerdict | "continue";
  onBlocked: (b: { kind: "question" | "permission"; tool: string; text: string }) => FinalVerdict | "wait";
  bootTimeoutMs?: number;                // default 90_000
  admitTimeoutMs?: number;               // default 30_000 (initialDelivery only)
  timeoutMs?: number;                    // whole-session deadline → TIMEOUT (channel only; team never passes it)
  onChange?: (snap: PaneSnapshot, prev: SlotState) => void;   // coalesced ≤ 4/s
  /** [r-base] Every wire-state change, synchronously, never coalesced, reported once per event-processing step
   *  NET of the pump's synchronous admit (RUNNING → IDLE → ADMITTING in one step reports nothing). The channel
   *  writes `waits.jsonl` and the `events.jsonl` state lines from it (§20.1). */
  onTransition?: (t: { from: SlotState; to: SlotState; at: string; snap: PaneSnapshot }) => void;
  magmuxBinary?: string; sockRoot?: string; claudishSpawn?: ClaudishSpawnTarget; parentEnv?: NodeJS.ProcessEnv;
  /** @internal [r2] test-only timing seams (X-M7); production never passes them — defaults are the measured constants. */
  timings?: { secondaryQuietMs?: number; screenSettleQuietMs?: number; degradedEntryMs?: number;
              resendAfterMs?: number; corroborationMs?: number };
}
export interface SettledTurn { index: number; answer: string; apiError: TurnView["apiError"]; stopReason: string | null;
  captureSource: "transcript" | "screen" | "none"; settledBy: "turn_duration" | "interrupt" | "quiet" | "screen" | "exit";
  delivery: { mode: Delivery["mode"]; linesTotal: number | null; linesRead: number | null; complete: boolean | null;
              preambleBytes: number } }       // [r2] owners map complete === false → prompt_not_read
export interface FinalVerdict { state: "COMPLETED" | "EMPTY" | "FAILED"; reason?: FailureReason; detail?: string }

export async function startPaneSession(opts: PaneSessionOptions): Promise<PaneSession>;
// throws MagmuxUnavailableError or PaneLimitError before spawning; installs the shutdown hooks (idempotent)

export interface PaneSession {
  readonly paneId: string; readonly sockPath: string;
  readonly ready: Promise<void>;          // resolves when the wire state leaves STARTING: RUNNING, AWAITING_INPUT (promptless), or terminal
  readonly terminal: Promise<PaneSnapshot>;
  snapshot(): PaneSnapshot;               // sync, memory only
  capture(sinceSeq?: number, opts?: { spans?: boolean }): CaptureResult | CaptureUnchanged; // sync, memory only
  send(text: string): SendResult;         // sync enqueue; never blocks on the child
  turnAnswer(index: number): string;
  cancel(): { changed: boolean; state: SlotState };
  expire(): { changed: boolean; state: SlotState };
  reaped(): Promise<void>;
}
export type SendResult = { ok: true; queued: number } | { ok: false; reason: "terminal" | "delivery_unavailable" | "unsupported_command" };
export interface PaneSnapshot {
  paneId: string; phase: Phase; state: SlotState; reason: FailureReason | null; detail: string | null;
  activity: string | null; lastActivityAt: string | null; idleSeconds: number | null;
  turnsCompleted: number; tokensIn: number | null; tokensOut: number | null; toolCalls: number;
  liveAnswerBytes: number; exitCode: number | null; captureSource: SettledTurn["captureSource"] | null;
  turnSource: "transcript" | "screen"; pendingInputs: number; connected: boolean;
  startedAt: string; endedAt: string | null; transcriptPath: string; panePid: number | null;
  screenTail: string; anomalies: string[];
}
```

**Admission pump** (D17, H4, H10). One per session; it is the only code that delivers text.

1. `send(text)` validates synchronously (terminal → `terminal`; `/clear` and `/resume` → `unsupported_command`,
   because they move the session to another transcript; non-plain text with `readAvailable === false` →
   `delivery_unavailable`), appends to the queue and returns `{ok:true, queued}`. A send to a one-shot session
   converts it to interactive **before** enqueueing (unchanged rule).
2. The pump runs whenever the phase is IDLE (or BOOTING reaches `boot_ready` with a queued item): it fires
   `admit` (IDLE→ADMITTING) — or `boot_ready_admit` — **synchronously**, so a concurrent `send` only queues.
3. `follower.poll()`, then `offset = follower.size()`; this pre-delivery offset is the single turn boundary
   ("mark before deliver", stated once). `openTurn({index, offset, witness})`.
4. Deliver per §2.13 (`send{typed:true}` of one line). The reply is awaited with a 10 s request timeout; an
   error reply or `busy` is retried once after 500 ms. **[r2] Slash commands** (X-L1) are typed with
   `enter:false`; after the next frame, if `menuOpen` and `menuItem` is not the typed command, `escape` closes
   the menu; then `enter`. A witness whose `<command-name>` differs from the typed one never matches, so a
   wrong menu pick ends in step 6, never in a silently different command.
5. Await the witness. At +10 s without one: if `inputBox().text` still starts with the delivered line, send
   `escape` when `menuOpen`, then one `enter` key (anomaly `resent_enter`); if the box is empty and the
   transcript is `absent`/`empty`, apply the degraded acceptance rule (§2.8), which a late witness reverts.
6. At `admitTimeoutMs` without acceptance: an `initialDelivery` → `admit_deadline` → FAILED
   `prompt_not_accepted` (screen tail in detail); any other delivery (including a promptless session's first
   send, X-M1) → `admit_abandoned` → IDLE, anomaly `send_not_accepted`, and the channel frame carries
   `meta.send_rejected: true`. No work existed for that turn, so this is not a D10 timer.
7. During QUESTION or PERMISSION a queued item first triggers one `escape`. **That declines the dialog and
   interrupts the turn** (r2, X-H3): Claude Code writes the rejection `tool_result` and a `[Request
   interrupted by user for tool use]` record (corpus: 98 of the 127 such records directly follow a rejection
   `tool_result`); the turn settles through path I (§2.8) with `stopReason:"interrupted"`; an interactive
   `decide()` returns `"continue"` (a one-shot session was converted to interactive by the send, step 1), the
   phase becomes IDLE, and the item is delivered as the next prompt. If no interrupt record appears within
   the admission bound after the Esc, the item stays queued, the anomaly `escape_not_effective` is recorded
   and the phase is unchanged (the dialog is still answerable by a later send). Phase 2 captures Esc on an
   AskUserQuestion and on a permission dialog on 2.1.287 to pin both record shapes.

`/exit` and `/quit` are delivered from IDLE without opening a turn and set `exitRequested`.

**Blocked detection** (H7). `blocked_question` fires from the transcript alone: `pendingTool.name ===
"AskUserQuestion"` with no `tool_result`. `blocked_permission` needs a pending non-AskUserQuestion tool **and**
`hasChoiceDialog`. There is no silence-based inference: if the marker fails, the row stays RUNNING with
`activity` = the tool name and a growing `idle_seconds` — an honest unknown. On either event `PaneSession`
asks `onBlocked`; a verdict applies at once (`verdict_failed` is legal from QUESTION and PERMISSION), `"wait"`
keeps the phase. `unblocked` fires when the `tool_result` lands.

**Reconnect** (D6, H1). On `disconnected`:

1. If the magmux process has exited (`proc.exitCode !== null` on its `ChildProcess` handle): poll the follower
   once; if the current turn has settle evidence, take the §2.2 exit path with code `null`; else
   `pane_lost`. (`sawShutdown` with our own `close_pane` in flight is the normal reap, not a loss.)
2. Otherwise magmux is alive (it keeps panes when a client leaves, research `e2` f): redial with backoff
   50 ms → 1 s while magmux lives. On success: `capabilities`, `list` (a `dead:true` pane with `exitCode` →
   the §2.2 exit path, catching an `exit` missed in the gap), then `watch` (keyframe; `seq` continues).
   Anomaly `socket_reconnected`. **[r2]** 20 consecutive dials failing with ENOENT (the socket file is gone
   while magmux lives) record `socket_lost` and stop redialing: the session continues on the transcript alone,
   `connected:false`, and its reap uses the magmux handle and the verified group (§2.10).
3. While disconnected, the transcript follower keeps running (it is file-based), so acceptance and settle
   still progress (paths P and I with `screen_unverified`, §2.8); pane liveness is checked with
   `kill(panePid,0)` every 1 s, and **[r2] an ESRCH takes the §2.2 exit path with exit code `null`** (X-M12).
   `snapshot().connected` reports the gap.
4. **[r2] Anomalies are deduplicated** by key with a count (`socket_reconnected ×12`) and capped at 64
   distinct keys, so a flapping socket cannot grow `anomalies[]` without bound.

**activity**: RUNNING → the pending tool's name, `"background"` or `"finishing"` (§2.8), or `"thinking"`;
QUESTION → `"AskUserQuestion"`; PERMISSION → the blocked tool's name; otherwise `null`. During a network
outage the tier-1 hold (D22) shows as `"thinking"` with a ticking spinner; it ends within the derived deadline
as an API error.

**lastActivityAt** = max(last screen change, last transcript or subagent append). Claude Code's spinner ticks
every second while it works, so a working slot reads `idleSeconds ≈ 0`; a frozen screen with a stale
transcript is the real stall signal. `idleSeconds` is `null` in terminal states (`team-lifecycle.md`).

**On a terminal state** the final screen is fixed with one `capture` request (with scrollback offset), then
`reap()` runs. The last `ScreenState` stays in memory, so capturing a closed pane returns it with
`final: true`.

### 2.10 Reap — `PaneSession.reaped()`, idempotent (one shared promise)

**[r2] Signalling rule** (X-C1). The reap signals only (a) this process's own children through their
`ChildProcess` handles — magmux and the pane watcher — which Node refuses to signal once it has reaped them,
so a stale pid is impossible; and (b) the pane's process group after the group check of §2.11 (a member with
a recorded (pid, start time) is still in that group). Never a bare pid, never `$PPID`.

**Normal reap** (finish, cancel, timeout):

0. Refresh the pane's verified group snapshot (§2.11) while its members still carry their identity.
1. If connected and the pane is not closed: `close_pane {pane:0, force:true}` (1 s timeout), then wait ≤ 3 s
   for `pane_closed`, `shutdown` or EOF. `no_such_pane` counts as done.
2. Wait ≤ 3 s for the magmux process to exit (it exits 0 once its last pane is closed).
3. Still alive → `terminateChildTree(magmuxProc, 2000)` (`process-tree.ts`, kept; it signals through the
   handle).
4. **Pane group backstop.** If the group check passes: SIGTERM `-pgid`, wait 2 s, check again, SIGKILL.
   `force:true` kills the group only while the pane leader is unreaped, so grandchildren (bun, claude, a
   Bash-tool grandchild) survive without this step (research-magmux §2). Because the check uses the recorded
   (pid, start time) members rather than argv, a group whose identifiable members already exited — the
   `orphan_grandchild` case — is still recognised.
5. Verify: the group check fails (no recorded member left in the group) and the magmux handle has exited. Then
   unlink `sockPath` (ENOENT is fine), `rm -rf` the launcher/turn directory, delete the pane record.
6. **End the watcher**, only after step 5 succeeded: write `done\n`, end its stdin; if it has not exited 1 s
   later, `watcherProc.kill("SIGKILL")` through the handle. If verification failed, the record is kept with
   `reapFailed: true`, the watcher is **left running** (it finishes the job when this process ends), the
   anomaly `reap_unverified` is recorded, and the registry re-runs steps 4–6 for that pane on its 2 s tick
   until they succeed.

Worst case ≈ 12 s; `cancel()` returns before it finishes. On a clean reap nothing outlives it: the pane group,
magmux and the watcher are gone and their files are removed (asserted by every integration test, §12.3).

**Shutdown reap** (`reapAllPanes`): every live pane **in parallel** — `close_pane force` (500 ms timeout), then
after 1 s SIGKILL every magmux handle and every group that passes the group check, verify, unlink, delete
records, end the watchers. Bounded at ≈ 3 s for any N (C2 gap 3; L4's serial 20 × 11 s). If the process exits
before a pane finished, that pane's watcher sees EOF and completes the same steps with the same checks.

### 2.11 `pane/pane-registry.ts` — process-wide safety (D15)

```ts
export const MAX_LIVE_PANES = 48;
export function livePaneCount(): number;                          // [r2] across owners: records with a live owner, not reaped
export function reservePanes(n: number): void;                    // throws PaneLimitError (code pane_limit) if live + n > MAX
export function registerPane(s: PaneSession): void;
export async function reapAllPanes(reason: "shutdown" | "stdin_closed" | "signal"): Promise<void>;
export async function sweepOrphanPanes(root?: string): Promise<{ reaped: string[]; cleaned: string[]; kept: string[] }>;
export function installPaneShutdownHooks(opts?: { exitAfter?: boolean; before?: () => Promise<void> }): void; // idempotent
```

**Pane record** `<SOCK_ROOT>/panes/<paneId>.json` (0600, dir 0700), written before any spawn with
`magmuxPid:null` (X-L4), updated with `watcherPid`, `magmuxPid` and `panePid` as each becomes known, deleted
only after a verified reap:
`{paneId, ownerPid, ownerStart, watcherPid|null, magmuxPid|null, panePid|null, sessionUuid, sockPath,
launcherDir, createdAt, reapFailed?}`. `ownerStart` is the owner's `lstart` (`LC_ALL=C ps -o lstart=`).

**[r2] Process identity — `pane/process-identity.ts`, one definition for reap, sweep and watcher** (X-C1).
All process-table reads use one `LC_ALL=C ps -ax -o pid=,pgid=,lstart=,command=` call (portable across macOS
and Linux; `ps -g` is not used, its meaning differs between them).

- `isPaneMagmux(pid, paneId)`: the command line contains `--id <paneId> --sock-dir`. The pane id embeds the
  owner pid, its start time and 6 random hex digits, so no other process can carry it.
- `paneIdentityMatches(command, pane)`: contains `--session-id <sessionUuid>` or `<launcherDir>/pane-launch.sh`
  (the leader before and after its `exec`, bun and claude).
- **Verified group snapshot**: for the pane's pgid (= `panePid`, magmux makes each pane a session leader),
  if at least one member satisfies `paneIdentityMatches`, the snapshot is the set of every member's
  (pid, `lstart`). The registry refreshes it for all of its panes with **one** `ps` call per 2 s tick (unref'd
  interval, only while a pane is live) and atomically rewrites `<launcherDir>/group` (pgid, then one
  `pid lstart` line per member) when it changes, so the watcher and the sweep read the same set.
- **Group check** (before every group signal): some process with that pgid has a (pid, `lstart`) pair in the
  snapshot. A pgid cannot be reused while any of its members lives, and a recorded member that died cannot
  be impersonated by a new process with the same pid **and** start time, so a passing check proves the group
  is the pane's — including when only an unidentifiable grandchild is left.

**Layers.**

1. **Pane watcher** (§2.3): on owner EOF it verifies, then kills the pane group and its magmux within ≈ 2–3 s
   and removes the files; on a clean reap it receives `done` and exits without signalling anything. This
   replaces round 1's launcher watcher and round 1's synchronous `exit` hook (which signalled
   `-panePid`/`-magmuxPid` unvalidated): every way the owner can end, `process.exit` included, closes the
   pipe, so the watcher already covers the `exit`-hook case with verification.
2. **Startup sweep** (`sweepOrphanPanes`, once per process before the first spawn; MCP server startup and the
   first `startPaneSession` of a CLI run). For each record whose owner is dead (ESRCH) or reused (`lstart`
   differs): if its watcher is alive (`watcherPid`'s command is `… claudish-pane-watcher <paneId> …`), skip it —
   the watcher is mid-job. Otherwise apply the watcher's algorithm in TypeScript: `isPaneMagmux` for
   `magmuxPid` (or `pgrep -f -- "--id <paneId> --sock-dir"` when null); the group check from
   `<launcherDir>/group`, plus a fresh identity snapshot if a member still matches; SIGTERM, 2 s, re-check,
   SIGKILL; verify; unlink the socket, remove the launcher dir and the record. A target that fails its check
   is never signalled; its files are cleaned and it is reported as `kept`. Sockets matching `magmux-c<pid>-*`
   with no record are probed: owner dead and connection refused → unlink; owner dead and it accepts → `list`
   for the pane pid, identity-check, kill, unlink (C2 gap 4).
3. **Shutdown hooks** (`installPaneShutdownHooks`, installed by `startPaneSession` on first use, so CLI
   `team` gets them too — H6):
   - `SIGINT`, `SIGTERM`, `SIGHUP` → `before?.()` → `reapAllPanes("signal")` → `process.exit(128 + n)` when
     `exitAfter` (CLI default); the MCP server installs them itself with its record-settling `before`.
   - MCP server only: `process.stdin.on("end" | "close")` and the transport's `onclose` →
     `reapAllPanes("stdin_closed")` → `process.exit(0)` (C2 gap 1). The 2 s progress interval and the magmux
     sockets would otherwise keep the event loop alive with the host gone.
   - A synchronous `exit` listener only SIGKILLs live magmux **handles** (`proc.kill`, safe by construction);
     the groups and files are the watchers' job.

**How NFR1 holds after a server SIGKILL with no restart** (R8): the kernel closes the watcher pipes; each
watcher verifies and kills its group and magmux (magmux's graceful quit removes its socket; the watcher
removes it if magmux had to be SIGKILLed), removes the launcher dir and the record, and exits. Measured by
the registry test (owner SIGKILL, two panes, ≤ 5 s, nothing left) and live in R8.

The per-run SIGINT handler in `startModels` is deleted; layer 3 replaces it for every consumer.

**Pane limit** (M14, r2 X-L11 and X-C1): `team(run)`, CLI team and `create_session` call `reservePanes(n)`
before spawning. `livePaneCount()` counts the records under `<SOCK_ROOT>/panes/` whose owner is alive
(pid + `lstart`) and whose reap has not finished, across every claudish process of this user, plus this
process's reservations not yet recorded. A pane stops counting when its reap finishes (≤ 12 s after the
terminal transition), verified or not; a `reapFailed` or dead-owner record never counts, so failed reaps
cannot exhaust the limit. Exceeding `MAX_LIVE_PANES` is `pane_limit`: the `Error: pane_limit: …` text
envelope for both `create_session` and `run` (r2, X-L9: neither is a §8 verb), a pre-spawn refusal of the
whole run.

### 2.12 `pane/accounting.ts` and `pane/slot-row.ts`

```ts
export function readTokenFileCached(path: string): TokenFileStats | null;  // mtime-cached readTokenStatsAt
export function mergeAccounting(snap: PaneSnapshot, tokenFile: TokenFileStats | null): {
  tokensIn: number | null; tokensOut: number | null; costUsd: number | null; toolCalls: number; provider: string | null };
export function resolveProvider(input: { model: string; spawnModel: string | null; tokenFile: TokenFileStats | null }): string | null;
export function toSlotRow(id: { slot: string; model: string; spawnModel: string | null }, snap: PaneSnapshot,
                          acct: ReturnType<typeof mergeAccounting>): SlotRow;
```

**Accounting.** The token file is authoritative when it carries data (`provider_name` set, or
`total_tokens > 0`): `tokensIn` = `billed_input_tokens` (new `ModelTokenStats` field in `team-stats.ts`; never
`input_tokens`, which is the current context), `tokensOut` = `output_tokens`, `costUsd` = `total_cost`,
`toolCalls` = Σ `tool_calls[].count`. Otherwise tokens and tool calls come from the transcript (main chain +
subagents) and `costUsd = null`. `tool_calls` includes the one Read of a file-delivered prompt.

**I/O of polling verbs** (M17). The token file is re-read on the owner's 2 s progress tick into memory; the
polling verbs (`list`, `status` for a live run, `list_sessions`, both captures) read memory only. **[r2]**
(X-L5) `team(status)` for a run in the registry builds its legacy keys (`models`, `summary`, …) from the
orchestrator's in-memory status object — the same object `updateModelStatus` serialises to `status.json` —
and `run` from the same registry entry, so the two halves of one answer cannot disagree; today's per-call
`readFileSync(status.json)` (`team-orchestrator.ts:1671`) is used only for a run **not** in the registry,
the single documented disk read.

**Provider** (M11), exactly:

```ts
function resolveProvider({ model, spawnModel, tokenFile }) {
  if (tokenFile?.provider_name) return tokenFile.provider_name;          // served-by: the proxy observed it
  const native = nativeRouteFor(model);                                   // before ANY route lookup (CLAUDE.md invariant)
  if (native) return displayNameOf("native-anthropic");
  const pinned = parsePinnedSpec(spawnModel);                             // "provider@model", single hop only
  if (pinned) return getProviderByName(pinned.provider)?.displayName ?? pinned.provider;
  return null;                                                            // "+"-joined chain or bare name not yet served
}
```

The invariant concerns `nativeRouteFor` before `route()`; the token file is observation, not routing. The
first two sources are disjoint today (a native route writes no proxy token file); a test asserts a native
model never yields a token file with a different provider.

### 2.13 `pane/prompt-delivery.ts` — how text reaches the REPL (D13)

```ts
export type Delivery =
  | { mode: "typed"; line: string; witness: Witness }                       // plain line
  | { mode: "command"; line: string; witness: Witness; file?: string }      // slash command (+ pointer)
  | { mode: "file"; line: string; file: string; witness: Witness }          // turn file + fixed instruction
  | { mode: "control"; line: "/exit" | "/quit" };
export function planDelivery(text: string, turnDir: string, turnIndex: number, readAvailable: boolean): Delivery;
```

- **Plain** — one line, ≤ 512 chars, every char printable (no C0/DEL, no tab, no `\r`), not starting with
  `! # ? @ & \` or `/`, last whitespace-separated token not starting with `@` or `/` → `typed` exactly as
  given. This covers conversational replies ("yes", "continue with option 2").
- **Slash command** — first line matches `^/[A-Za-z0-9][A-Za-z0-9:_-]*(\s|$)` → the first line, normalised
  (tabs → space, C0 removed), is typed. **[r2]** The typed line is capped at 512 chars like a plain line
  (X-L1): if the first line is longer, or more lines follow, the whole text is written to the turn file and
  the typed line is the command name plus the suffix `` — the full arguments are in the file `<path>`; read
  all of it first. `` The command stays live (its expansion receives the pointer in `$ARGUMENTS`); the menu
  check of §2.9 step 4 runs before Enter. `/exit` and `/quit` are `control`. A file-carrying command turn gets
  the same read-coverage check and answer rule as a file turn.
- **Everything else** — written to `<turnDir>/turn-<n>.md`, 0600, and the typed line is the fixed template

  `` Your task is in the file `<turnDir>/turn-<n>.md`. Read all of it with the Read tool (in parts if it is long), then do exactly what it says, treating its content as the user's message. ``

  with, only when a line was split (below), the extra sentence `` Lines ending in ↩ were split for reading: join each with the next line, dropping the ↩. `` `turnDir` is the launcher's mkdtemp directory: `[A-Za-z0-9/_-]` only, so the line has no `@`, no space in
  the path, ends with `.` and opens no menu. It is ≤ 300 chars, below the 800-char paste heuristic. The exact
  line is the witness. `--add-dir <turnDir>` makes the file readable without a permission prompt in any
  permission mode.
- **[r2] File content and Read's limits** (X-H5). Read renders numbered lines, truncates a line longer than
  `READ_LINE_LIMIT` characters and caps one call's output (≈ 2000 lines / ≈ 25 k tokens). Phase 2 measures all
  three on 2.1.287 and pins the rendering format; the constants carry the measured values.
  - The file holds the caller's bytes unchanged (no CRLF or tab normalisation), **except** that a line longer
    than `READ_LINE_LIMIT − 16` characters is split into segments at the last whitespace before that bound
    (a hard split if there is none), every segment but the last ending in the marker `↩` (U+21A9). If any
    original line already ends in `↩`, the marker becomes `⤶` (U+2936) and the template names that one. The
    split is reversible and the template states how. `delivery.lines` is the line count of the written file.
  - **Coverage is verified, not hoped for**: the follower unions the line numbers that Read **returned** for
    this file (§2.7). At settle, `complete === false` (no Read at all — an agent without Read, a model that
    cannot call tools, a refusal to open it — or partial paging) makes a team slot or a one-shot session
    **FAILED `prompt_not_read`**, `detail` = "read lines 1–2000 of 3400 of the task file" or "the task file
    was never read", with the answer kept in `response-<slot>.md` for inspection (X-H5, X-M4). An interactive
    session is not failed (its caller can resend): the turn continues with the anomaly `prompt_not_read` and
    frame `meta.prompt_not_read: true`.
- **[r2] Answer of a file-delivered turn** (X-H4): only assistant text after the Read result that completed
  coverage (§2.7); pre-Read narration is excluded and counted in `preambleBytes` (diagnostics).
- **[r2] `require_pattern` semantics, exactly**: `new RegExp(pattern)` with **no flags**
  (`team-orchestrator.ts:578`), tested with `.test()` against the full answer — the answer text blocks joined
  with `"\n\n"`, in order, as written to `response-<slot>.md`. `^` and `$` anchor to the start and end of that
  whole answer (no `m` flag, so not to line starts); for a file-delivered turn the start is the first text
  block after coverage completed, so `^VERDICT:` matches an answer that begins with its verdict even when the
  model narrated before reading. `min_output_bytes` is measured on the same string.
- **No paste path exists.** typed delivery of ≤ 512 single-line chars at ≈ 4 k chars/s takes ≤ 0.2 s.
- **Fidelity, restated:** the model sees Read's numbered rendering of the turn file, which reproduces the
  caller's text once line numbers are stripped and marked splits are joined (CR handling as measured in Phase
  2); the transcript's user entry is the template (exact witness); every line's delivery is proven from the
  transcript.
- **Judge prompt size.** A judge prompt is the rubric plus every response (≈ 50 KB for 5 × 10 KB, unbounded in
  principle). By file it has no delivery ceiling (the 1 MB `send` lane cap and the 4 MB frame cap no longer
  apply, and the `control` echo every `send` broadcasts stays ≈ 200 bytes); above Read's per-call cap the
  judge pages, and an incomplete paging is FAILED `prompt_not_read`, never a verdict on part of the input. R4
  measures a > 100 KB judge file.
- **[r2] Prompt-time processing that file delivery skips** (X-M5), listed in `pane-session.md`: Claude
  Code's prompt-time handling sees the template, not the content — thinking keywords (`ultrathink`, "think
  hard"), `@path` attachment expansion, and UserPromptSubmit hooks that route on prompt text do not fire on
  the content; a multi-line slash command receives "command + pointer" as `$ARGUMENTS`, so `$1`/`$2`
  positional splitting sees the pointer. Plain single-line prompts keep all of them.
- **Costs accepted:** one or more Read round-trips (≈ 1–3 s and a few hundred tokens each) per non-plain
  turn; a model that cannot call tools cannot complete a non-plain task and is reported as
  `prompt_not_read`.

### 2.14 `pane/child-env.ts` — runs inside the pane child claudish

Imported first by the CLI entry (`index.ts`), before config loading. When `CLAUDISH_PANE_CHILD === "1"`:

1. If `CLAUDISH_PANE_ENV` is set: parse it; for every key in the snapshot set `process.env[key]`; delete every
   `process.env` key absent from the snapshot except the shell-managed set and `MAGMUX_*`; delete
   `CLAUDISH_PANE_ENV`. Parse failure → print `claudish: pane child refused: bad env snapshot`, exit 64.
2. If `realpath(process.cwd()) !== CLAUDISH_PANE_CWD`: `process.chdir(CLAUDISH_PANE_CWD)` and log it.
3. After `parseArgs`: the interactive assertion of §2.3 rule 3.

`claude-runner.ts` still deletes `CLAUDISH_PANE_CHILD` from claude's env (§11), so a nested claudish inside a
slot's Bash tool behaves normally. The marker stays in the child claudish's own `process.env`, which is what
`magmuxPaneCapability()` reads for D22.

**[r2] Recovery surface in the pane child** (D22, X-H1; `network-recovery.md` read for this). Two edits,
both in Phase 1: `launcher/magmux-wrapper.ts` `magmuxPaneCapability()` returns `{kind:"none",
reason:"pane-child"}` as its **first** check when `parentEnv.CLAUDISH_PANE_CHILD === "1"`; and
`claude-runner.ts`'s ambient branch (`recoverySurfaceAllowed() && config.interactive &&
process.env.MAGMUX_SOCK`, :2022) becomes `recoverySurfaceAllowed() && paneCapability.kind === "ambient"`, the
same predicate the watchdog (:1657) and the wrap (:1988) already read. Effect in the pane child:
`applyRetryWatchdog(env, {paneEligible:false})` exports no watchdog and deletes a claudish-owned one inherited
through the snapshot (an MCP server started by a wrapped claudish session inherits
`CLAUDE_CODE_RETRY_WATCHDOG=1` plus `CLAUDISH_SET_RETRY_WATCHDOG=1`); a user's own unmarked value is kept, as
`applyRetryWatchdog` already rules. No recovery UI installs, so no overlay ever draws over the screen the
classifier reads. What remains is tier 1: the proxy holds a failing request up to `TIER1_DEADLINE_MS`
(derived from `API_TIMEOUT_MS`, 270 s by default) and, holding no banner lease, answers an inline 400 at
exhaustion; Claude Code does not retry a 400, writes an API-error entry, and the slot settles FAILED
`api_error` with that text. A 503 from upstream gets Claude Code's default budget (~11 attempts, ~174 s).
Holding for that bounded time is correct: it is what every unwrapped interactive launch already does, and the
row shows RUNNING with a live spinner, which is true. Tests: `recovery/settings.test.ts` gains "pane child →
no watchdog, inherited marked watchdog removed", and its existing source guard is extended to the ambient
branch; `network-recovery.md` and `pane-session.md` record the rule.

---

## 3. Data design

### 3.1 Team `status.json` — `ModelStatus` (persisted, single writer `updateModelStatus`)

```ts
export interface ModelStatus {
  state: SlotState;                 // closed nine-value set (PENDING removed; setupSession writes STARTING)
  model: string; spawnModel: string | null; provider: string | null;
  sessionUuid: string; transcriptPath: string; pane: string | null;
  exitCode: number | null;          // from the magmux exit event (or list.exitCode after reconnect)
  startedAt: string | null; completedAt: string | null;
  outputSize: number;               // FINAL answer bytes, written once (meaning unchanged — team-lifecycle.md)
  captureSource: "transcript" | "screen" | "none" | null;
  turnSource: "transcript" | "screen";
  stopReason: string | null;
  tokensIn: number | null; tokensOut: number | null; costUsd: number | null;
  toolCalls: number; turnsCompleted: number; lastActivityAt: string | null;
  error?: ModelError;
}
export interface ModelError {
  model: string; command: string; reason: FailureReason; detail: string;
  screenSnippet?: string;           // redacted head+tail of the final screen (replaces stderrSnippet)
  answerSnippet?: string;           // redacted head+tail of the answer (replaces stdoutSnippet)
  errorLogPath: string;             // errors/<slot>.log — final screen, exit code, last line, magmux stderr, anomalies
  upstreamErrorLogPath?: string;    // only when the file exists
  workDir: string;
}
```

- Rewritten on every state change and on the 2 s progress tick (fresh accounting for disk readers).
- `team-grid.ts` (CLI grid) fills the new fields with `null`/`0`; its states are a subset of the closed set.
- **Reading old files** (L13): a persisted `state` outside the closed set (e.g. `PENDING`) is reported as
  `FAILED` with `reason: null`; §8 B states it.
- **[r-base] `status.json` is read outside this process**: `summarise` (the team record's end) and the magus
  monitor's heartbeat both classify a row by `state` and `error.reason`. So a CANCELLED row always carries
  `error` with `reason: "cancelled"`, and `summarise` counts every non-terminal state (STARTING, RUNNING,
  AWAITING_*) as failed (§20.1).

### 3.2 Run registry (team-orchestrator, in memory)

```ts
interface LiveTeamRun {
  runId: string;                    // [r2] THE KEY (CA-13): `<team_session_id>-<base36 start ms>-<6 hex>`
  path: string;                     // resolved absolute session dir (was basename: "judging" collided)
  kind: "run" | "judge";
  startedAt: string; finishedAt: string | null;
  status: TeamStatus;               // [r2] the in-memory object updateModelStatus serialises to status.json (X-L5)
  slots: Map<string, { model: string; spawnModel: string | null; tokenFile: string; session: PaneSession | null;
                       acct: Accounting /* refreshed on the 2 s tick */ }>;   // session null = pane never spawned
}
const teamRuns = new Map<string, LiveTeamRun>();          // [r2] keyed by runId (X-M2)
const newestRunByPath = new Map<string, string>();        // [r2] resolved path → runId of its newest run
const SETTLED_RUN_RETENTION_MS = 30 * 60_000;   // same as channel TERMINAL_RETENTION_MS
const MAX_SETTLED_RUNS = 20;
```

**[r-base] The entry is created after the spawn loop**, before the D9 `ready` await, together with the
progress ticker; `done` is built last, immediately before `startModels` returns (§20.3, the team record's
exactly-once end). A run is therefore listable once all of its panes exist (the 300 ms stagger, ≈ N × 0.3 s
into the `run` call). Settled runs stay listable and capturable for 30 minutes, capped at 20, oldest evicted first. After eviction
`status` still works from disk (newest run at the path only); `capture` and `list` no longer see the run.
**[r2] Addressing** (X-M2): a mode given `run_id` addresses that run while it is retained (else
`unknown_run`); given only `path`, it addresses `newestRunByPath.get(path)`. At most one run per path is
ACTIVE, so a superseded run is always SETTLED: `cancel` on it returns every slot with `changed:false`;
`capture` returns its retained final screens; `status` returns `run` from memory and **omits** the legacy
path-based keys (`models`, `summary`, …), because `status.json` at that path now belongs to the newer run.
A second `run` on a path whose newest run is ACTIVE is refused in `run`'s own text envelope:
`Error: invalid_args: a team run is already ACTIVE at <path> (run_id <id>); cancel it or wait for it`.

### 3.3 Channel `SessionInfo` (internal record, persisted as `meta.json`)

```ts
export interface SessionInfo {
  sessionId: string; model: string; spawnModel: string | null; provider: string | null;
  state: SlotState; shape: "one-shot" | "interactive";
  pane: string | null; panePid: number | null;
  startedAt: string; completedAt: string | null; exitCode: number | null;
  turnsCompleted: number; tokensIn: number | null; tokensOut: number | null; costUsd: number | null;
  toolCalls: number; lastActivityAt: string | null; elapsedSeconds: number; idleSeconds: number | null;
  reason: FailureReason | null; detail: string | null; pendingInputs: number;
  claudeSessionId: string; transcriptPath: string;
  parentClaudeSessionId?: string;   // [r-base] kept from 10.4.0: present only when proven
  captureSource: "transcript" | "screen" | "none" | null; turnSource: "transcript" | "screen";
  timeoutSeconds: number;           // [r-base] normaliseTimeoutSeconds(): an integer in 1..3600
}
```

- `status: SessionStatus`, `tokensUsed`, `toolCallCount` and `terminalReason` are removed **from the in-memory
  `SessionInfo`**, with no alias. **[r-base]** They are NOT removed from `meta.json`: since 10.4.0 that file is
  a record the magus monitor reads (`status`, `terminalReason`, `turnsCompleted`, `toolCallCount`, `costUsd`,
  `exitCode`, `elapsedSeconds`), and a missing `status` reads as `failed`. `writeArtifacts` serialises
  `toMetaRecord(info)`, which writes every 10.4.0 key under its 10.4.0 name and meaning, plus additive keys
  (§20.1). The disk reader reads both generations.
- `SessionStatus` is deleted. `ChannelEventType` becomes its own union: `starting | running |
  tool_executing | waiting_for_input | awaiting_permission | completed | failed | cancelled | timeout`.
  **[r-base]** 10.4.0's `finishing` is not in it (§20.3).
- Session directory artifacts: `prompt.md`, **[r-base] `spawn.json`** (written before the pane exists, before
  every runtime file), `meta.json`, **[r-base] `waits.jsonl`**, `output.log` (answer prose per turn),
  `events.jsonl` (claudish's own `{type:"state",from,to,at}` / `{type:"tool",name,at}` / `{type:"anomaly",…}`
  records, **[r-base]** plus one `{type:"assistant",message:{id},at}` line per new main-chain message id, which
  the monitor counts as replies; redacted, capped at 4 MB), `screen.txt` (final screen, redacted),
  `tokens.json`, `upstream-errors.jsonl`. `stderr.log` is gone (a PTY has no separate stderr). The disk reader
  reads only this set.
- **F1 window** (L10): `meta.json` written before the slug fix carries a wrong `transcriptPath`; the disk
  reader re-derives the path from `claudeSessionId` + the recorded cwd when the stored one does not exist.

### 3.4 Mapping to the channel event (`channelEventFor`, in `session-manager.ts`)

| Phase → SlotState | `event` | `status` (EVENT_TO_TASK_STATUS) |
|---|---|---|
| BOOTING, ADMITTING(`initialDelivery`) → STARTING | starting | working |
| ADMITTING(any other delivery, incl. a promptless session's first send), RUNNING (no pending tool) → RUNNING | running | working |
| RUNNING (pending tool) | tool_executing (+ `meta.tool`, `meta.tool_count`, coalesced ≤ 1 frame/s) | working |
| IDLE, QUESTION → AWAITING_INPUT | waiting_for_input (`meta.activity` = `"AskUserQuestion"` for QUESTION) | input_required |
| PERMISSION → AWAITING_PERMISSION | **awaiting_permission** (new key) | input_required |
| COMPLETED | completed | completed |
| FAILED, EMPTY | failed | failed |
| CANCELLED | cancelled | cancelled |
| TIMEOUT | timeout | failed |

Every `ChannelEventType` member has an `EVENT_TO_TASK_STATUS` key (a test iterates the union's runtime
list). The frame shape is unchanged; new `meta` keys are additive (`activity`, `send_rejected`, r2
`prompt_not_read`). `meta.stalled`
goes with the stall watchdog: `idle_seconds` on the row is the information.

---

## 4. API design (MCP tools)

The tool list goes from 13 to **14**: low-level 4, agentic 3, channel **7**. Every tool returns
`content: [{type:"text", text:<JSON>}]`.

### 4.1 `team` (group agentic, `heartbeat: true`)

- Schema: `mode` enum `["run","judge","run-and-judge","status","cancel","list","capture"]`;
  `required: ["mode"]` (`path` required by every mode except `list`, validated by the handler); new properties
  `since_seq` (number) and `spans` (boolean) for `capture`, and `run_id` (string) for `status`/`cancel`/
  `capture` (CA-13); `slot`'s description adds `capture`.
- Description: "poll `status` (read `run.slots`) or `list`"; keep "NO SLOT IS EVER KILLED ON A TIMER",
  qualified as "once its prompt is accepted"; add "a slot that stops on a question it cannot answer is FAILED
  `blocked`"; drop the stream-json wording from `require_pattern`; `claude_flags` takes flags and values only,
  no positional text.

| mode | behaviour | response |
|---|---|---|
| `run` | Input exclusivity, `buildChildClaudeFlags`, `checkChildFlags`, `assertMagmuxAvailable`, refuse if the path's newest run is ACTIVE (`Error: invalid_args: …` text, §3.2), `reservePanes(n)`, then `setupSession`, then **[r-base]** `proveParentForCall` and `recordTeamRun` (the team `spawn.json`; a refused run therefore leaves no record), then `startModels({…, onSettled})`, which awaits every slot's `ready` (D9); a throw writes the record's `start-failed` end and releases the reservation (§20.3). Mints `run_id` (CA-13). | `{started, run_id, team_session_id, session_path, monitor_record /*[r-base] team-<8 hex>*/, slots /*model→id*/, run: TeamRunRow, next, note}` |
| `status` | `getStatus(path)` + `run: TeamRunRow` (live from memory, else from `status.json` with `idle_seconds:null`, `activity:null`) + `contract_version`, `capabilities`. | §8 B |
| `list` | Registry only; ACTIVE runs first, then SETTLED by `finished_at` desc. | `TeamListResult` (§8 A) |
| `cancel` | `cancelTeamRun(path, slot?)`: synchronous transition, asynchronous reap. | `TeamCancelResult` (§8 C) |
| `capture` | `session.capture(since_seq, {spans})` | `CaptureResult \| CaptureUnchanged` (§8 D) |
| `judge` | unchanged; the judges are panes through `runModels(…/judging)`, judge prompt by file (§2.13) | verdict |
| `run-and-judge` | unchanged blocking form | verdict |

**Fields `status` keeps** (the dev plugin's team-gate polls `models[*].state === "RUNNING"`, reads `summary`,
and reads `response-<slot>.md` via the `run` `slots` map): `startedAt`, `models[slot]` (with `state`,
`outputSize`, `error` and the new `ModelStatus` fields), `idle_seconds_by_slot` and `activity_by_slot` (derived
from `run.slots`), `live_output_bytes_by_slot` (from `PaneSnapshot.liveAnswerBytes` — `SlotRow` has no byte
field; L11), `note` (keyed on "any non-terminal slot"), `summary` (once every slot is terminal).
`formatTeamResult` counts CANCELLED among the failures and lists `blocked` slots with their question.

**`NEXT_STEP` entries.** Added: `boot_timeout` ("the child never reached its prompt and its screen kept
changing — read the evidence screen; usually a slow catalog fetch or MCP server start"), `boot_blocked` ("a
screen claudish does not know stopped boot — its text is in `what`; answer it once interactively in that
directory"), `first_run_dialog` ("run claude (or claudish --model X) once interactively in that directory and
answer the dialog named in `what`; claudish never accepts it for you"), `agent_rejected` ("fix the agent name;
the available agents are listed in `what`"), `prompt_not_accepted` ("the REPL never took the prompt — read
the evidence screen; retry"), `child_exited` ("read the evidence screen, then retry or drop the model"),
`pane_lost` ("magmux died — check `magmux --version` ≥ 0.14.0 and retry"), `blocked` ("the child asked a
question team cannot answer — make the prompt self-contained or use create_session"), `refused` ("the model
refused — rephrase or drop the model"), **[r2]** `prompt_not_read` ("the child never read all of its task
file — check that its agent or tool flags allow Read and that the model can call tools; `what` says which
lines were read"). Removed: `nonzero_exit`, `background_task_ceiling`. Reworded: `shape_mismatch` — "the
answer (assistant text after the task was read) did not match".

### 4.2 Channel tools

| tool | change |
|---|---|
| `create_session` | Same props; **[r-base]** `timeout_seconds` is the 10.4.0 schema (`integer`, 1–3600, out-of-range clamped by `normaliseTimeoutSeconds`). `checkChildFlags`, `assertMagmuxAvailable`, `prehydrateCredentialsForSpawn`, **[r-base]** `proveParentForCall` (async, before any reservation), `reservePanes(1)`, then `sessionManager.createSession`, which writes `prompt.md` and `spawn.json` before `startPaneSession` (a `spawn.json` failure fails the call and releases the reservation). Returns `{session_id, state:"STARTING"}` immediately (no boot wait, no heartbeat — unchanged). |
| `send_input` | **Accepted in every non-terminal state and queued** (D17): STARTING and RUNNING queue the text until the session is idle; AWAITING_INPUT delivers at once; during a question or a permission dialog the dialog is declined with Esc and the text becomes the next prompt. Any accepted send converts a one-shot session to interactive (unchanged). Returns `{ success: true, queued }` or `{ success: false, reason: "terminal" \| "unknown_session" \| "delivery_unavailable" \| "unsupported_command", state }`. |
| `get_output` | Prose from the transcript-fed scrollback, `tail_lines` unchanged. |
| `cancel_session` | `SessionCancelResult` (§8 C). The description drops "SIGTERM, then SIGKILL after 5 seconds". |
| `list_sessions` | `SessionListResult` (§8 B): `{contract_version, capabilities, sessions}`. `include_completed` unchanged. |
| `get_diagnostics` | Same call. `stderrTail`/`stderrFiltered` become `screenTail`; adds `pane`, `sockPath`, `magmuxStderr`, `captureSource`, `turnSource`, `phase`, `pendingInputs`, `connected` and `anomalies` (illegal transitions, degraded mode, `resent_enter`, `socket_reconnected`, `settled_without_turn_duration`, `send_not_accepted`, r2:
`degraded_reverted`, `screen_unverified`, `socket_lost`, `background_shell_open`, `escape_not_effective`,
`reap_unverified`, `read_coverage_unverified`, `prompt_not_read`, …, deduplicated with counts) and r2's
`preambleBytes` / read coverage per turn. Keeps upstream errors, the event ring, accounting, both halves of the model chain, `transcriptPath` and artifact paths. **[r-base]** 10.4.0's `status` key (a `SessionStatus`) becomes `event` (the current `ChannelEventType`) beside `state` (`SlotState`); not a record, so no consumer outside the tests reads it, and the contract adapter `sessionStatus` reads `event` (§20.2). |
| `capture_session` (**new**, group channel) | `{session_id, since_seq?, spans?}` → `CaptureResult \| CaptureUnchanged` |

`INSTRUCTIONS` (mcp-server.ts 97–126) is updated: the `awaiting_permission` event, "send_input may be called
at any time; it is queued until the session is idle", `capture_session`, `list_sessions` rows, "timeout: hit
timeout_seconds; the pane was closed". **[r-base]** 10.4.0's `finishing` line is deleted, and its
`input_required` line ("only interactive sessions do this") becomes "the session waits for send_input: an
interactive session between turns, or a session stopped on a question or a permission dialog (a send declines
it and becomes the next prompt)".

### 4.3 Error handling

**Envelope, verb by verb** (M15):

| Verb | Success | Error |
|---|---|---|
| `team` `list` / `status` / `cancel` / `capture`, `capture_session`, `cancel_session`, `list_sessions` (the §8 verbs) | JSON per §8 | `isError: true`, text = JSON `ContractError` |
| `team` `run` / `judge` / `run-and-judge`, `create_session`, `send_input`, `get_output`, `get_diagnostics`, low-level tools | unchanged | unchanged `Error: …` text (`create_session`'s `pane_limit`/`magmux_unavailable` use this text form, with the code as the first word) |

`team(status)` switching its error text to JSON is a change to an existing verb; the team-gate treats any
`isError` as "not ready" and does not parse the text (checked in the dev plugin skill).

**Failure detection**, each re-derived from print mode:

| Failure | Detected by |
|---|---|
| API error turn | `isApiErrorMessage` (transcript); upstream error log or screen error rows (degraded) |
| Refusal | `stop_reason: "refusal"` |
| Child exits before answering | magmux `exit` event, or `list` `dead:true` after a reconnect, decided against the current turn (§2.2) |
| Unknown agent | `agentRejectedLine` on `exit.lastLine` / final screen, plus the exit |
| Boot timeout / blocked boot | the boot deadline; a static `choice` or named dialog screen |
| Prompt never accepted | the admission bound (§2.9) |
| Task file not (fully) read **[r2]** | read coverage of `turn-<n>.md` from the transcript's Read results (§2.7, §2.13) |
| Interrupted turn **[r2]** | a `[Request interrupted by user…]` record (§2.8 path I); not a failure |
| Blocked team slot | pending `AskUserQuestion` (transcript) or a permission marker + pending tool |
| Session timeout | `timeoutMs` |
| magmux death | magmux process exited (not socket EOF) → `pane_lost` |

---

## 5. State-transition table (authoritative semantics)

Phases are internal; the wire column is what every row, frame and status shows (`wireState`).

| From (wire) | Event | To (wire) | Guard / side effect |
|---|---|---|---|
| — | spawn | BOOTING (STARTING) | `reservePanes`, pane id, launcher dir, record, **watcher**, magmux, watch, boot deadline armed |
| BOOTING | `boot_ready_idle` | IDLE (AWAITING_INPUT) | `readBoot = repl` stable 500 ms, queue empty. Clears boot deadline. Resolves `ready` |
| BOOTING | `boot_ready_admit` | ADMITTING (STARTING for the `initialPrompt`; RUNNING for a `send_input` queued during boot, r2) | as above with a queued prompt. Pump: offset → `openTurn` → deliver. Admission bound armed |
| BOOTING | `boot_dialog` | FAILED | `first_run_dialog`, dialog text. Never accepted. Reap |
| BOOTING | `boot_blocked` | FAILED | `boot_blocked`, static `choice` screen text (5 s, or at the deadline). Reap |
| BOOTING | `boot_deadline` (90 s) | FAILED | `boot_timeout`, screen tail. Reap. No work existed (D10) |
| ADMITTING | `prompt_accepted` | RUNNING | witness after the offset, or the degraded acceptance rule. Clears admission bound. Resolves `ready` (`initialDelivery`) |
| ADMITTING | `admit_deadline` (30 s, `initialDelivery` only) | FAILED | `prompt_not_accepted`, screen tail. Reap |
| ADMITTING | `admit_abandoned` (30 s, any other delivery — incl. a promptless session's first send) | IDLE (AWAITING_INPUT) | anomaly `send_not_accepted`; frame `meta.send_rejected` (r2, X-M1) |
| IDLE | `admit` | ADMITTING (RUNNING) | pump, queue non-empty. Never STARTING (r2, X-M1) |
| IDLE | `rewake` **[r2]** | RUNNING | interactive only: a notification woke the model after settle (D23); same turn index; the pump waits |
| RUNNING | `blocked_question` | QUESTION (AWAITING_INPUT) | pending `AskUserQuestion`. Then `onBlocked`: team → `verdict_failed` (`blocked`); channel → wait |
| RUNNING | `blocked_permission` | PERMISSION (AWAITING_PERMISSION) | pending tool + `hasChoiceDialog`. Then `onBlocked` as above |
| QUESTION / PERMISSION | `unblocked` | RUNNING | the `tool_result` landed — including the rejection `tool_result` written when a queued send pressed Esc; the interrupt record that follows settles the turn through path I (r2, X-H3) |
| QUESTION / PERMISSION | `verdict_failed` | FAILED | `blocked` (team), question/tool text in detail. Write artifacts, reap |
| RUNNING | settled → `decide()` = verdict | COMPLETED / EMPTY / FAILED | §2.8 evidence for the **current** turn (paths P, I, S). team: `prompt_not_read` if coverage is incomplete (r2), else `classifyRunOutput`; one-shot channel: same with `minOutputBytes 0`, no pattern; interactive + `apiError` → FAILED `api_error` (D20). Write artifacts, reap |
| RUNNING | settled → `decide()` = `"continue"` | IDLE (AWAITING_INPUT) | interactive, no `apiError` (incl. an interrupted turn, path I, and a turn with `prompt_not_read` as anomaly). `settledTurns++` (not again after a `rewake`). Pump delivers the next queued item |
| RUNNING | pane exit with current-turn settle evidence (incl. path X) | COMPLETED / EMPTY / FAILED, or IDLE then rule 2 | `decide()`; exit code in detail (M5). `"continue"` → `turn_continue`, then the IDLE exit rules (r2, X-M10) |
| IDLE | `exit_clean` | COMPLETED | exit 0, interactive, `exitRequested` or `settledTurns ≥ 1`, no admitted-unsettled turn |
| any live | `pane_exit` (otherwise) | FAILED | `agent_rejected` if the line matches, else `child_exited` (exit code, last line, screen tail). Reap |
| any live | `pane_lost` | FAILED | magmux process exited without the pane's exit (socket EOF alone never fires it). Reap |
| any live | `cancel` | CANCELLED | `cancelled`. Reap. `changed:true` |
| any live | `timeout` (channel `timeoutMs`) | TIMEOUT | `timeout`. Reap. **Team never arms it** |
| terminal | anything | (unchanged) | anomaly, refused; `cancel` returns `changed:false` |

**Terminal states:** COMPLETED, FAILED, CANCELLED, TIMEOUT, EMPTY. They are absorbing.

---

## 6. Team orchestrator changes (`team-orchestrator.ts`, `team-cli.ts`, `index.ts`)

### 6.1 `startModels(sessionPath, opts)`

```ts
export async function startModels(sessionPath: string, opts?: TeamRunOptions): Promise<TeamHandle>;
export async function runModels(sessionPath: string, opts?: TeamRunOptions): Promise<TeamStatus>; // = (await startModels()).done
// [r2] every addressing function takes an optional runId (X-M2): given → that retained run, else the newest run at path
export async function cancelTeamRun(path: string, slot?: string, runId?: string): Promise<TeamCancelResult>;
export function listTeamRuns(): TeamListResult;
export function teamRunRow(path: string, runId?: string): TeamRunRow | null;
export function captureTeamSlot(path: string, slot: string, sinceSeq?: number, spans?: boolean, runId?: string): CaptureResult | CaptureUnchanged; // throws ContractErrorException
export async function shutdownAllTeamRuns(): Promise<void>;   // settles records CANCELLED; reapAllPanes does the killing

export interface TeamRunOptions {          // existing fields kept (spawnPlanner, onProgress, …)
  parentEnv?: NodeJS.ProcessEnv;          // [r2] X-M9: the env every pane of this run is built from; default process.env
  onSettled?: (status: TeamStatus) => void; // [r-base] kept from 10.4.0: once, when every slot is terminal (§20.3)
  // [r-base] deleted: spawnChild (no node spawn of claudish remains), terminateGraceMs (the reap owns its grace)
}
```

**[r2] Hermetic env reaches owner-spawned panes** (X-M9): `parentEnv` is threaded from `TeamRunOptions`,
`SessionManagerOptions` and `SessionCreateOptions` into `PaneSessionOptions.parentEnv`, and the owner derives
`transcriptPath` with `projectsDir(parentEnv)` (F2's function takes the env as an argument, defaulting to
`process.env`). Owner-level tests pass `makePaneTestEnv()` there and never mutate `process.env`.

1. `assertValidRequirePattern` **before** reading the manifest (unchanged), `checkChildFlags(claudeFlags)`.
   Read the manifest and `input.md`. Build the spawn plan (`spawnPlanner ?? prehydrateCredentialsForSpawn`).
   `await assertMagmuxAvailable()`, `reservePanes(slots.length)`, `sweepOrphanPanes()` (once per process).
2. For each slot, in parallel but spawned 300 ms apart (§2.3 boot stagger): mint the uuid; `transcriptPath =
   transcriptPathFor(realpath(process.cwd()), uuid, projectsDir(parentEnv))` (team children run in the
   server's cwd, as today; the launcher `cd`s there); `slotEnv = {
   CLAUDISH_TOKEN_FILE: tokenFileFor(path, id), CLAUDISH_UPSTREAM_ERROR_LOG: errors/<id>-upstream.jsonl }`;
   `startPaneSession({kind:"t", label:id, shape:"one-shot", initialPrompt: inputContent, decide: teamDecide,
   onBlocked: teamOnBlocked, …})`; `updateModelStatus(id, STARTING, …)`. A spawn throw marks only that slot
   FAILED `pane_lost` with the message (its registry `session` is `null`; `capture` answers the §8 D
   never-spawned screen); siblings continue.
3. `teamDecide(turn)` → `classifyRunOutput({answer, apiError, stopReason, promptRead: turn.delivery,
   minOutputBytes, requirePattern})`.
   Before returning the verdict it writes `response-<id>.md` from `turn.answer` in one write, byte-exact, so
   the response file exists before the state turns terminal. On failure it writes `errors/<id>.log` (final
   screen, exit code, last line, magmux stderr, redacted answer tail, anomalies) and fills `ModelError`.
4. `teamOnBlocked(b)` → writes the answer-so-far to `response-<id>.md` and returns
   `{state:"FAILED", reason:"blocked", detail: b.text}` (D19).
5. `onChange` → `updateModelStatus` for state changes; the 2 s progress tick refreshes accounting into the
   registry and `status.json`, rewrites `status.txt` and emits `onProgress`.
6. `await Promise.all(slots.map(s => s.session.ready))` (D9; ≤ 120 s), then return
   `{teamSessionId, sessionPath, slots, done}`. `done` = all `terminal` promises; it sets `finishedAt` and
   emits `onProgress("settled")`. The run stays in the registry under the retention policy.
   **[r-base]** `done`'s `finally` then calls `opts.onSettled?.(status)` inside its own `try`, after the settled
   `status.txt` render, exactly as 10.4.0 does. `done` is built immediately before the `return`, and nothing
   after it can throw.
7. **[r-base] Spawn-loop failure.** Step 2 runs inside a `try` whose `catch` covers only throws that are not
   slot-local (a slot's own `startPaneSession` throw is still that slot's FAILED `pane_lost`; a failed
   `status.json` write is the realistic case). The catch sets `aborting` (later `onChange` calls write
   nothing, so the started slots' rows stay `STARTING` and are counted as failed by `summarise`), calls
   `cancel()` on every started `PaneSession` and awaits every `reaped()` (§2.10: SIGTERM, then SIGKILL, on the
   verified group), releases the reservations no pane used, and rethrows the ORIGINAL error. The registry entry,
   the ticker and `done` do not exist yet, so `onSettled` is never called and the `run` handler writes the
   record's `start-failed` end. This is 10.4.0's `terminateChildTree` loop, moved onto panes (§20.3).

### 6.2 `classifyRunOutput` (kept, re-signed; second caller `session-manager.ts`)

```ts
export function classifyRunOutput(input: {
  answer: string;
  apiError: { status: number | null; text: string } | null;
  stopReason?: string | null;
  promptRead?: SettledTurn["delivery"];   // [r2] complete === false → prompt_not_read
  minOutputBytes?: number;
  requirePattern?: string;
}): { state: "FAILED" | "EMPTY"; reason: FailureReason; detail: string } | null;
```

Precedence: `api_error` (FAILED) → **[r2] `prompt_not_read` (FAILED)** → `refused` (EMPTY) → whitespace-only
`empty_output` → `min_output_bytes` → `shape_mismatch` **last**, matched against the **full** answer as
defined in §2.13 (all EMPTY). `max_tokens` adds the truncation
note to `detail` of whatever results (or to the COMPLETED status' anomalies). `outputSize` =
`Buffer.byteLength(answer, "utf8")`. Removed: the `captureMode` param and its two-branch `cause`, `stdoutTail`,
`stderr`, `BG_CEILING_RE`, `API_ERROR_RE`.

### 6.3 Non-MCP consumers (H6)

- `team-cli.ts` (`claudish team run|judge|run-and-judge`, line 147/176) and `index.ts:663` (`--team --mode
  json`) call `runModels` and therefore now run panes. They get `checkChildFlags`, `assertMagmuxAvailable`
  (a missing magmux prints the same clear error and exits 1), `reservePanes`, the startup sweep and the
  shutdown hooks through `startPaneSession` (`exitAfter: true`: Ctrl-C reaps every pane in ≤ 3 s, then exits
  130).
- `index.ts` `--team … --mode json` drops `claudeFlags: ["--json"]` (reserved now, and meaningless
  interactively); the raw-string `responses` path already handles prose.
- CLI `--grid` (`team-grid.ts`) is untouched (out of scope), apart from the new nullable status fields.
- This is a user-visible CLI change: Windows loses `claudish team` and `--team` (magmux ships for darwin and
  linux only). Recorded in §9.6, the docs and the BREAKING footer.

### 6.4 Other edits

`team-stats.ts`: `fmtState`/`renderTeamStatsCompact` cover the nine states; `ModelTokenStats` gains
`billed_input_tokens`.

**[r-base]** `summarise` and `readTeamStatus` are kept. The only change to `summarise` is its non-terminal guard:
`state !== "PENDING" && state !== "RUNNING"` becomes `TERMINAL_STATES.includes(state)`. COMPLETED counts as ok, a
terminal row with `error.reason === "cancelled"` as cancelled, and every other row (non-terminal included) as
failed. This is the same rule the monitor's heartbeat applies.

---

## 7. Channel `SessionManager` changes (`channel/session-manager.ts`)

- `createSession(opts)` starts the pane with: `callerFlags` = checked `claudishFlags`; `shape` = `prompt ?
  "one-shot" : "interactive"`; `initialPrompt` = prompt; `decide` = one-shot → `classifyRunOutput({answer,
  apiError, stopReason, promptRead, minOutputBytes:0})` (null → COMPLETED), interactive → `apiError ? FAILED
  api_error : "continue"` (D20; an incomplete read is an anomaly plus `meta.prompt_not_read`, r2);
  `parentEnv` from `SessionManagerOptions`/`SessionCreateOptions` (r2, X-M9); `onBlocked` → `"wait"`; `timeoutMs` = `timeoutSeconds × 1000`; `slotEnv` = `{ tokens.json,
  upstream-errors.jsonl }`. It returns immediately. `maxSessions` counts non-terminal sessions (unchanged);
  the pane limit applies on top.
- `onChange` → `info` update; `channelEventFor` → `onStateChange(sid, ChannelEvent)` (fires only when the
  derived event changes, apart from the coalesced `tool_executing` repeat; new optional `meta` keys
`prompt_not_read` (r2)); scrollback and `output.log` appends
  of new assistant text per turn; an `events.jsonl` record.
- `sendInput(id, text)` → `session.send(text)` (D17) → `{success, queued}` or the refusal reason.
- `cancelSession(id)` → `session.cancel()` → `SessionCancelResult`. `shutdownAll()` settles records CANCELLED;
  the registry reaps.
- `finalize`, `writeArtifacts`, eviction (30 min, 50 retained) and the disk reader are kept with the new
  artifact set; `getOutput` and `getDiagnostics` with the new fields. New: `captureSession(id, sinceSeq?,
  spans?)`.
- **[r-base] The 10.4.0 record writers stay in `SessionManager`, unchanged in output.** `writeSpawnRecord`,
  `writeJsonAtomic`, `normaliseTimeoutSeconds`, `recordTeamRun`, `finishTeamRun`, `appendWait` and
  `recordWaitTransition`, plus the `hostPid`/`launcherPid` getters and the `hostPid` option. `createSession`
  writes `spawn.json` (with `claudeSessionId` = the pane's `--session-id` uuid) before `startPaneSession`.
  `recordWaitTransition` is driven by `PaneSession.onTransition` (§2.9), not by the reducer callback. A wait
  is open while the wire state is AWAITING_INPUT or AWAITING_PERMISSION; `turns` = `turnsCompleted`; the
  closed line's `to` is the new state's channel event. `writeArtifacts` writes `toMetaRecord(info)`.
  `shutdownAll()` and `finalize` close an open wait and write `meta.json` before the process exits. §20.1
  has the full mapping.

---

## 8. Mod contract (frozen)

> Paste-ready for the peer session `claudish-mcp-feedback`. Contract version **1**, shipping in the claudish
> release that lands this migration (minor bump: **[amended r-base]** 10.5.0 if the session-records release
> 10.4.0 ships on its own first, else 10.4.0; §20.6). Amendments to the peer's original spec are
> marked **[amended]**; changes made by plan revision 2 are marked **[amended r2]** (one new failure reason,
> one new `activity` value, `run_id` addressing any retained run, wording fixes, two error codes that no
> verb below emits removed).

### Reaching claudish

- **Server name for `$.mcp.call`.** `plugin:claudish:claudish` when claudish is installed through the magus
  `claudish` plugin (tools appear as `mcp__plugin_claudish_claudish__<tool>`); `claudish` when registered
  directly under that key in `.mcp.json` / `~/.claude.json` (tools appear as `mcp__claudish__<tool>`). The
  general rule is `plugin:<plugin-name>:<server-key>`. Try `plugin:claudish:claudish` first, then `claudish`.
- **Envelope.** Every tool returns `content: [{ "type": "text", "text": "<JSON>" }]`. Parse `text`. Errors
  from the verbs below arrive with `isError: true` and `text` = the `ContractError` JSON (§E).
- **Detecting the contract [amended, CA-12].** `team(mode="list")`, `team(mode="status")` and `list_sessions`
  answers carry `contract_version: 1` and `capabilities`. A pre-contract claudish (≤ 10.3.0, or 10.4.x when
  10.4.0 ships on its own **[amended r-base]**) answers
  `team(mode="list")` with `isError: true` and text `Error: Unknown mode: list`, and `capture_session` with
  `Error: Unknown tool "capture_session"`; its `status`/`list_sessions` answers have no `contract_version`.
  A transport failure is neither: the call itself fails.
- **Polling.** Every verb below is non-blocking and reads memory (the one exception: `team(status)` for a run
  this server no longer holds reads its `status.json` once). Polling each about once per second is intended.
- **Compatibility.** Fields listed here never change meaning or type within contract version 1. New fields
  may be **added**; ignore keys you do not know. A future capability is announced in `capabilities` before
  you may rely on it.

### Types (TypeScript, authoritative)

```ts
export const CONTRACT_VERSION = 1;
/** v1 announces exactly these. */
export const CAPABILITIES = ["list", "status", "cancel", "capture", "capture_since_seq", "capture_spans"] as const;

export interface ContractMeta {
  contract_version: 1;
  capabilities: string[];          // v1: exactly CAPABILITIES
}

/** Closed set. The mod colours by it. */
export type SlotState =
  | "STARTING"            // pane spawned; Claude Code booting (claudish boot ≈ 11 s), or the prompt the session was
                          // CREATED with delivered but not yet accepted [amended r2: a promptless session's first
                          // send_input goes AWAITING_INPUT → RUNNING, never back to STARTING].
                          // Bounded: leaves within 90 s + 30 s. Non-terminal.
  | "RUNNING"             // a turn is in progress: prompt accepted; the model thinking, a tool running, Stop hooks
                          // or background agents still finishing. Never ended by a timer (team). Non-terminal.
  | "AWAITING_INPUT"      // waiting for text. Either an interactive create_session between turns (activity null), or a
                          // turn blocked on a question (activity "AskUserQuestion"). [amended r2] A send_input during a
                          // question does NOT answer it: claudish presses Esc, which declines the question and
                          // interrupts the turn, and the text becomes the next prompt. Team slots never stay here:
                          // team cannot answer, so a blocked team slot becomes FAILED "blocked". Non-terminal.
  | "AWAITING_PERMISSION" // a permission / plan-approval dialog is showing (only when caller flags override -y).
                          // A send_input declines it the same way. Same team rule as above. Non-terminal.
  | "COMPLETED"           // turn settled with a usable answer (team: passed require_pattern / min_output_bytes), or an
                          // interactive session whose child exited with code 0 while idle after /exit or after at
                          // least one settled turn [amended r2]. Terminal.
  | "FAILED"              // the session broke: boot failure, prompt never accepted, task file not fully read
                          // [amended r2], child exited (incl. unknown agent), API error, blocked (team), pane lost.
                          // Terminal.
  | "CANCELLED"           // stopped by team(mode="cancel") or cancel_session. Terminal.
  | "TIMEOUT"             // create_session timeout_seconds elapsed (team slots never time out). Terminal.
  | "EMPTY";              // turn settled but the answer is unusable: empty, refused, below min_output_bytes, or
                          // shape_mismatch. Terminal.

export const TERMINAL_STATES: readonly SlotState[] = ["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT", "EMPTY"];

export type FailureReason =
  | "cancelled" | "timeout"
  | "boot_timeout" | "boot_blocked" | "first_run_dialog" | "agent_rejected" | "prompt_not_accepted"
  | "prompt_not_read"    // [amended r2] FAILED: the prompt was delivered as a file and the child's Read calls did not
                         // return every line of it (never read, or paged incompletely); detail says which lines
  | "child_exited" | "pane_lost" | "blocked"
  | "api_error" | "refused" | "empty_output" | "shape_mismatch";

/** B — one row per team slot, and the base of every list_sessions row. */
export interface SlotRow {
  slot: string;                  // team: anonymised slot id ("01"); session: the session_id
  model: string;                 // as requested
  provider: string | null;       // display name of the claudish provider serving it; null until known
  state: SlotState;
  reason: FailureReason | null;  // set on FAILED / EMPTY / CANCELLED / TIMEOUT; null otherwise (incl. COMPLETED).
                                 // [amended r2] One exception: a pre-contract state read from disk is FAILED with null (§B)
  tokens_in: number | null;      // billed input incl. cache reads/writes, main conversation + subagents; null = no source yet
  tokens_out: number | null;
  cost_usd: number | null;       // null = unknown (always null for native Claude routes)
  tool_calls: number;            // includes the child's Read call(s) of a file-delivered prompt
  turns_completed: number;       // prompts whose turn settled (one per prompt, however many internal loops)
  last_activity_at: string | null; // ISO 8601: last screen change or transcript append
  idle_seconds: number | null;   // seconds since last_activity_at; null in terminal states
  activity: string | null;       // RUNNING: tool name, "thinking", "background" (waiting on background agents), or
                                 // [amended r2] "finishing" (the model's message ended; waiting for Claude Code's
                                 // end-of-turn record, typically while Stop hooks run);
                                 // AWAITING_PERMISSION: blocked tool; AWAITING_INPUT on a question: "AskUserQuestion";
                                 // otherwise null. Treat unknown values as "busy".
  pane: string | null;           // informational only (do not parse, no verb takes it); null if no pane was ever spawned
}

/** list_sessions row = SlotRow + session fields. `slot` equals `session_id`. */
export interface SessionRow extends SlotRow {
  session_id: string;
  started_at: string;            // ISO
  completed_at: string | null;   // ISO
  elapsed_seconds: number;
}

/** A — one team run this server knows. */
export interface TeamRunRow {
  run_id: string;                // [amended, CA-13] unique per team(mode="run") start, distinct even when `path` is reused
                                 // (opaque; format `<team_session_id>-<base36 start ms>-<6 hex>`). Same value as the
                                 // start answer's `run_id`. A judge sub-run has its own run_id.
  path: string;                  // absolute session directory (the `path` every other team mode takes)
  kind: "run" | "judge";         // "judge" = the judging/ sub-run of a judge or run-and-judge
  started_at: string;            // ISO
  finished_at: string | null;    // ISO, set when the last slot turned terminal
  state: "ACTIVE" | "SETTLED";   // [amended] run-level, distinct from SlotState: SETTLED ⇔ every slot terminal
  outcome: "ok" | "partial" | "all-failed" | null;  // null while ACTIVE; same words as the result card
  slots: SlotRow[];              // sorted by slot id
}

export interface TeamListResult extends ContractMeta { runs: TeamRunRow[] }    // [amended] an object, not a bare array
export interface SessionListResult extends ContractMeta { sessions: SessionRow[] }
/** team(mode="status") adds these keys to its existing payload. */
export interface TeamStatusAdditions extends ContractMeta { run: TeamRunRow }

/** C */
export interface TeamCancelResult {
  run_id: string;                // [amended, CA-13]
  path: string;
  results: Array<{ slot: string; state: SlotState; changed: boolean }>; // changed = this call moved it to CANCELLED
}
export interface SessionCancelResult { session_id: string; state: SlotState; changed: boolean }

/** D */
export interface CaptureResult {
  seq: number;                   // claudish-owned. 0 = no frame received yet (lines all ""); ≥ 1 after the first frame;
                                 // +1 per visible change (text, colours, cursor, alt screen); never resets for a pane's life
  cols: number;                  // 160
  rows: number;                  // 50
  cursor: { x: number; y: number };
  lines: string[];               // exactly `rows` entries, plain text, right-trimmed; Claude Code's screen (no scrollback)
  final: boolean;                // true = the pane is closed and this is its last screen
  spans?: Array<Array<[col: number, len: number, fg: number, bg: number, attr: number]>>; // only when spans:true was asked
}
export interface CaptureUnchanged { unchanged: true; seq: number; final: boolean }

/** E */
export interface ContractError {
  error: {
    code: "unknown_run" | "unknown_slot" | "unknown_session" | "invalid_args";  // [amended r2] magmux_unavailable and
                                 // pane_limit removed: no verb in A–D can produce them (spawning verbs answer in text)
    message: string;
  };
}
```

Colour values in `spans`: `-1` = default, `0..255` = indexed, `≥ 16777216` = truecolor (`c & 0xFFFFFF`).
`attr` is a bitmask in which 1 = bold. The magmux frame encoding is passed through.

### A. `team(mode="list")` → `TeamListResult`

```json
{"contract_version":1,"capabilities":["list","status","cancel","capture","capture_since_seq","capture_spans"],
 "runs":[{"run_id":"review-mfz3k2a1-9c41e0","path":"/Users/jack/proj/ai-docs/sessions/x/review","kind":"run","started_at":"2026-10-02T11:00:00.000Z",
  "finished_at":null,"state":"ACTIVE","outcome":null,
  "slots":[{"slot":"01","model":"internal","provider":"Anthropic (native)","state":"RUNNING","reason":null,
            "tokens_in":61211,"tokens_out":812,"cost_usd":null,"tool_calls":3,"turns_completed":0,
            "last_activity_at":"2026-10-02T11:00:41.120Z","idle_seconds":0,"activity":"Bash",
            "pane":"c48211-kq3j9x2-t01-a1b2c3"}]}]}
```

- Args: `{ "mode": "list" }`, with no `path`.
- **[amended, CA-13] `run_id`.** `team(mode="run")` and `team(mode="run-and-judge")` answers carry
  `run_id` (top level, and inside `run`). `/dev:dev` reuses one review `path` every round, so `path` alone
  names several runs over time; `run_id` names one. A path holds at most one ACTIVE run at a time (starting a
  run on a path whose run is ACTIVE is refused; `run` is not a verb of this contract, so the refusal is its
  usual text error, `Error: invalid_args: …` [amended r2]); a SETTLED run at that path stays in `list` under
  its own `run_id` until retention drops it. `status`, `cancel` and `capture` accept an optional `run_id`
  **[amended r2]**: when given, they address **that** run for as long as this server retains it — including a
  run superseded at the same `path` — and answer `unknown_run` once it is no longer retained; never another
  run's data. Omitted, they address the newest run at `path`. A superseded run is always SETTLED, so `cancel`
  on it returns `changed:false` for every slot, and `status` on it returns `run` plus the contract keys but
  not the legacy path-based keys of §B (`models`, `summary`, …), which describe the newest run.
- Scope: runs started by **this server process**. ACTIVE runs, plus SETTLED runs for **30 minutes** after
  `finished_at`, at most **20** settled runs (oldest dropped first). A server restart forgets every run;
  `status` still reads finished runs off disk. `create_session` sessions are in `list_sessions`, not here.

### B. `team(mode="status", path)` and `list_sessions`

- `team(mode="status", path)` returns the existing payload **plus** `contract_version`, `capabilities` and
  `run: TeamRunRow`. The mod reads `run.slots`.
- Kept beside it for existing callers: `startedAt`, `models` (keyed by slot; `models[slot].state` uses the same
  `SlotState` set), `live_output_bytes_by_slot`, `idle_seconds_by_slot`, `activity_by_slot`, `note`, and
  `summary` once every slot is terminal.
- For a run not live in this server, `run` is built from `status.json`: rows have `idle_seconds:null` and
  `activity:null`, `state` is whatever was last written, and a persisted value outside the closed set (from a
  pre-contract claudish) is reported as `FAILED` with `reason:null`.
- `list_sessions(include_completed?)` → `SessionListResult`:
  `{ "contract_version": 1, "capabilities": [...], "sessions": SessionRow[] }`.

### C. Stop

- `team(mode="cancel", path, slot?, run_id?)` → `TeamCancelResult` (which also carries `run_id`); omitting
  `slot` cancels every slot.
  `cancel_session(session_id)` → `SessionCancelResult`.
- Idempotent: a second call returns the same `state` with `changed:false`.
- Returns once the state has turned CANCELLED. The pane close and process-group reap finish in the
  background within about 12 s.
- Unknown path → `unknown_run`; unknown slot → `unknown_slot`; unknown session → `unknown_session`.

### D. Show

- `team(mode="capture", path, slot, since_seq?, spans?, run_id?)` and `capture_session(session_id, since_seq?, spans?)`
  → `CaptureResult`, or `CaptureUnchanged` when `since_seq === seq`. **Any other `since_seq`** (lower, higher —
  e.g. from a previous server — or absent) returns a full `CaptureResult`.
- Before the first frame: `seq:0`, 50 empty lines, `final:false`. Polling with `since_seq:0` therefore returns
  `unchanged` only while no frame has arrived.
- A closed pane returns its last screen with `final:true` for as long as the run or session is retained
  (30 min); after that `unknown_run` or `unknown_session`.
- **[amended r2]** A slot whose pane never spawned (its row is FAILED with `pane:null`) returns `seq:0`,
  `cols:160`, `rows:50`, cursor `{x:0,y:0}`, 50 empty lines and `final:true`.
- Captures are addressed only by `(path, slot)` or `session_id`; the row's `pane` is informational.

```json
{"seq":57,"cols":160,"rows":50,"cursor":{"x":2,"y":44},"final":false,
 "lines":[" ▐▛███▛█   Claude Code v2.1.287","▝▜██████▀  Haiku 4.5 · Claude Max","", "❯ Reply with exactly PEAR","","⏺ PEAR", "…"]}
{"unchanged":true,"seq":57,"final":false}
```

### E. Errors and channel frames

- Errors: `ContractError` as above, with `isError:true`, from every verb in A–D (including `team(status)` and
  `list_sessions`).
- `notifications/claude/channel` frames keep their shape. The `event` vocabulary gains `awaiting_permission`
  (`status: input_required`); new optional `meta` keys: `activity`, `send_rejected`, and **[amended r2]**
  `prompt_not_read` (an interactive turn whose task file was not fully read; the session continues).
  **[amended r-base]** The `finishing` event of the session-records build (10.4.0) is not emitted: a one-shot
  session goes from `running` straight to its terminal event, and the wait for Claude Code's end-of-turn record
  is `activity: "finishing"` on a RUNNING row. `SlotState` is unchanged.
- Terminal states reach `list` and `status` in the same tick they are decided. A 1 Hz poll is enough for the
  mod's wake-up.

---

## 9. Alternatives and trade-offs (Phase 3)

### 9.1 Process topology

| Approach | Pros | Cons | Verdict |
|---|---|---|---|
| **A. One magmux per slot** | Independent cancel and close; a full 160×50 screen each; matches the reference driver; failure isolation. | ≈ 15 MB, 1 pty and 0.4 % CPU idle per slot (measured, N=10 fine; capped at 48). | **Chosen** |
| B. One magmux per run, N panes | One process and socket per run. | Shared headless geometry (≈ 12 panes at 80×24); closing the last pane exits magmux, coupling lifetimes; one crash takes every slot. | Rejected |
| C. Keep `-p` stream-json and validate harder | No new mechanism. | FR8 forbids it; silent divergences remain (unknown agent, interactive-only `/dev:*`). | Rejected |
| D. Launch bare `claude` so magmux's controller supplies state | Per-pane state pushed. | Bypasses claudish routing; controller discovery by mtime/first prompt can lock onto a sibling's transcript. | Rejected |

### 9.2 Turn oracle and settle

| Approach | Verdict |
|---|---|
| **Transcript at the derived path, turn-scoped; settle on `turn_duration{pendingBackgroundAgentCount:0}` + agent balance + screen corroboration; interrupt path; measured full-quiet secondary gated on Stop-hook completion** | **Chosen.** `turn_duration` is the harness's own "foreground turn done" record, written after Stop hooks; it waits for hooks of any length by construction, and no path can end a running hook (r2) |
| Ungated quiet secondary (revision 1) | Rejected (r2, X-H2): a Stop hook longer than the window is "quiet with no `turn_duration`" and was cut |
| Await background Bash too (revision 1) | Rejected (r2, X-H6): a dev server never notifies, so `judge` and the team-gate never return |
| Fixed 3 s quiet window (revision 0) | Rejected: blind to background agents (they write `subagents/`) and unmeasured against Stop-hook latency (C1) |
| magmux `awaiting_input`/`running` heuristics | Rejected: 5 s idle heuristic, cleared by any send, not pushed |
| Screen scraping only | Degraded screen source only: a 50-row screen truncates long answers (research rsch-c1) |

### 9.3 Prompt delivery

| Approach | Pros | Cons | Verdict |
|---|---|---|---|
| **Kind-based: plain line typed, slash command typed (+ pointer), everything else by turn file + fixed instruction; r2: long lines split with a stated marker, read coverage verified, answer starts after the read** | Caller's content with a reversible split only; no keystroke hazards (CR, tab, ctrl-j, `!`, menus, Esc); no size ceiling; exact acceptance witness; slash commands stay live; an unread or partly read task is FAILED, never answered silently | One or more Read round-trips per non-plain turn; requires the Read tool; prompt-time processing (thinking keywords, `@path`) does not see the content | **Chosen** |
| Type the prompt when it fits (single paragraph ≤ 512) and file only the rest (r2 option) | No Read call for short prompts | Already the rule for single plain lines; a multi-line prompt cannot be typed safely (CR submits, ctrl-j unmeasured) | Kept as is |
| Instruct the child to `cat` the file through Bash | No per-line truncation | Bash output is also truncated, needs the Bash tool and permission, and its output is not line-numbered for coverage | Rejected |
| typed ≤ 32 KiB, paste above (revision 0) | No extra tool call | CRLF submits early, tab autocompletes, leading `!` runs shell under `-y`, ctrl-j semantics unverified, paste shows a placeholder and defeats the resend check, 1 MB/4 MB caps (H5, M4) | Rejected |
| Always paste | One write | `[Pasted text]` placeholder; `<pasted_content>` framing changes what the model sees; slash commands not live | Rejected |
| Normalise then type everything | Simple | Still alters bytes; leading `!`/`#` and menus need escaping Claude Code does not offer; slow for 100 KB | Rejected |

### 9.4 Team on `SessionManager` vs a shared module

**Chosen: a shared module.** `team-lifecycle.md`'s rejection of making team a client of `createSession` still
holds: it would push team's shape contract into the channel manager. The mechanism is shared (`pane/`); policy
stays with each owner through `decide` and `onBlocked`.

### 9.5 Orphan prevention

| Approach | Verdict |
|---|---|
| **r2: server-spawned per-pane pipe watcher (`/bin/sh`, own session) + pane records + identity-validated sweep + stdin/signal hooks; every foreign-pid signal re-verified by (pid, start time) or unique argv** | **Chosen**: covers SIGKILL promptly (≈ 2–3 s) with one blocked `sh` per pane and no polling; owner death is a kernel EOF, not a pid; ended explicitly by the reap, signals nothing on a clean reap; outside the pane group |
| Launcher owner-watcher inside the pane (revision 1) | Rejected (X-C1): it watched the owner rather than the pane, so it survived every clean reap; being in the pane group it failed the reap's verification, so records and turn files leaked; later it signalled a stale `$PPID` |
| In-pane watcher polling owner and leader by (pid, start time) | Rejected: works, but polls (`ps` per pane per second), still lives in the pane group the reap must verify, and needs the same identity code in shell anyway |
| A detached per-server bun warden process | Rejected: one more ~30 MB bun process per server and a second lifecycle to get right; one `sh` per pane is smaller and needs no protocol |
| Sweep at next startup only | Rejected: magmux is detached into its own session and a client disconnect does not touch its panes (research-magmux §4, `e2` f), so after a server SIGKILL the REPLs (300–400 MB each) would run until some later server starts (C2) |

### 9.6 Pattern notes (catalog files read: `patterns/state.md`, `patterns/facade.md`)

- **State, table form (`slot-state.ts`).**
  - Gain: the whole machine is visible in one place; illegal transitions fail in one place. The phase/wire
    split keeps the frozen nine wire states while the internal machine gains the distinctions the review
    asked for.
  - Cost: behaviour per phase lives in `PaneSession`, so the table shows legality, not effects.
  - When NOT to use: "two states with trivial differences — a boolean and an `if` is correct"; "transitions
    never change and the machine is small — use the table". Eleven phases with distinct guards justify a
    machine, and the table is exactly the catalog's small-machine recommendation.
  - Does TypeScript already do this: yes — a `const` table that `satisfies Record<…>` replaces the class per
    state.
  - One deviation: the catalog's `next()` throws; ours returns `null` and records an anomaly, because a late
    pane `exit` after a cancel is normal.
- **Facade (`pane/index.ts`).**
  - Gain: spawn → dial → watch → admit → settle → reap happens correctly in one place; team and channel learn
    one surface.
  - Cost: risk of a God object accreting a method per caller (`UNI-01`). `decide`/`onBlocked` and owner-held
    policy are the guard.
  - When NOT to use: "every caller needs different parts of the subsystem". Both callers need the same
    lifecycle.
  - Does TypeScript already do this: yes — "a module is a facade", so it is a module export, not a facade
    class. `PaneSession` is a class only because it owns live state.

### 9.7 Trade-offs accepted

| Gain | Cost |
|---|---|
| Interactive semantics: agent validation, slash commands, `/dev:*` behave as for a person | `run` blocks ≈ 12–20 s through boot and admission (≤ 120 s, D9). Each slot pays claudish's 4–7 s catalog warm-up. More processes per slot (watcher `sh` + magmux + claudish + bun + claude). |
| Answers and turns from Claude Code's own transcript, waiting for Stop hooks and background agents | A dependency on transcript format and location, guarded by real fixtures and degraded mode. A slot whose background agent never finishes stays RUNNING (`activity:"background"`) until cancelled — by design (D10). |
| **[r2]** A team slot never hangs on a dev server or watcher it started in the background (D23) | A finite background Bash whose result arrives after Claude Code's `turn_duration{pending:0}` is not waited for (print mode waited ≤ 600 s) and is ended by the reap; reported as `background_shell_open`. Run such commands in the foreground. |
| **[r2]** Print-only flags refused instead of silently ignored | `--max-turns`, `--max-budget-usd`, `--fallback-model`, `--json-schema`, `--permission-prompt-tool` no longer usable for team slots and sessions. BREAKING. |
| **[r2]** No recovery watchdog in pane children (D22) | A slot does not ride out a long outage: it fails `api_error` after the tier-1 deadline (270 s default) instead of retrying ~300 times with nobody watching |
| Prompts of any size, with every line's delivery proven | One or more Read calls per non-plain prompt; Read must be available, else `prompt_not_read`; over-long lines arrive split with a stated marker |
| Live screen for the mod | Memory of ≈ 8,000 cells × N |
| One validator for `--agent` (the child) | `create_session` reports an unknown agent ≈ 6 s later, through a frame or `list` |
| Team slots never hang on a question | A team prompt that makes the child ask is FAILED `blocked` (answer-so-far kept) |
| magmux required for MCP `team`/`create_session` **and CLI `claudish team`/`--team`** | **Windows loses all of them** (magmux ships for darwin and linux only). NFR3: a clear error, never a silent `-p`. BREAKING. |

---

## 10. Deletions

**Whole files**

| Path | Why |
|---|---|
| `packages/cli/src/channel/stream-json-reducer.ts` | Both callers migrate. `LEGAL_TRANSITIONS` and the absorbing rule are salvaged into `pane/slot-state.ts`, the tool-batch debounce into `session-manager.ts`. **[r-base]** 10.4.0's additions go with it: `TurnEnd`, the required `onResult`, `awaitInput()`, `beginTurn()`'s wait-ending transition, and the `finishing` row of `LEGAL_TRANSITIONS`. Their guarantees move as §20.2 lists. |
| `packages/cli/src/test-helpers/contract-fake-child.ts` **[r-base]** | A stream-json child. Its markers (`@@TOOL@@`, `@@HANG@@`, `@@LINGER@@`, `@@LATE@@`) and env (`CONTRACT_FAKE_SIGTERM_MARKER`, `CONTRACT_FAKE_HANG`, `CONTRACT_FAKE_MAX_MS`) move into `fake-interactive-child.ts` (§20.2). Deleted in Phase 5, when the channel's last stream-json path dies. |
| `channel/stream-json-reducer.contract.test.ts` **[r-base]** | Tests the deleted reducer; its guarantees are re-homed per §20.2 |
| `packages/cli/src/team-stream-capture.ts` | Its only importer is the reducer |
| `packages/cli/src/stdio-decode.ts` + test | Its only callers were the two pipe readers |
| `packages/cli/src/agent-availability.ts` + test | D11 |
| `scripts/magmux-drive-session.ts` | Replaced by `scripts/pane-drive.ts`, a thin CLI over `PaneSession` that can also run bare `claude` for upstream A/B |
| `channel/test-helpers/fake-claudish.ts`, `fake-channel-stream-json.ts`, `captured-stream-json.ts`, `captures/`, `fake-streamjson-child.ts`, `fake-dropout-child.ts` | stream-json fakes; replaced by `pane/test-helpers/fake-interactive-child.ts` |
| `test-fixtures/stream-json/` | It fixtured the stream-json capture |
| Tests: `channel/stream-json-reducer.test.ts`, `channel/stream-json-reducer-unrecognized-json.test.ts`, `team-stream-capture.test.ts`, `team-stderr-noise.test.ts`, `team-timeout-repro.test.ts` | Bug #1 targets the already-dead TIMEOUT path; bug #3 (setupSession refuses an existing dir) moves into `team-orchestrator.test.ts` |

**Consumers of the deleted fakes** (M18) — each repointed to `fake-interactive-child.ts` via `CLAUDISH_BIN`
and the per-test hermetic env (§12.1), keeping its assertions:

| Consumer | Action |
|---|---|
| `channel/channel-wire-format.test.ts` (FR10) | repoint; every frame assertion kept; `awaiting_permission` case added |
| `team-cancel.test.ts`, `team-heartbeat-survival.test.ts`, `team-liveness-exited-slot.test.ts`, `team-multibyte-answer.test.ts` | repoint; rewritten per §12.4 |
| `channel/session-create-options.test.ts` | repoint; `keepUnrecognizedJson` case deleted |
| `mcp-e2e/runner.ts` | repoint its child to `CLAUDISH_BIN=<fake>`; the runner sets the hermetic env (10.4.0's `userHomeFrom` sessions path kept) |
| **[r-base]** the session-records contract suites and `test-helpers/contract-mcp.ts` / `contract-adapters.ts` | ported or kept per the §20.2 table; `contract-records.ts` is kept as is |

**Symbols in surviving files**

- `team-orchestrator.ts`: `TeamCaptureMode`, `TEAM_CAPTURE_ENV_VAR`, `resolveCaptureMode`,
  `TeamRunOptions.captureMode`; `classifyRunOutput`'s `captureMode`/`stdoutTail`/`stderr` params and print
  branch; `BG_CEILING_RE`, `API_ERROR_RE`; the `nonzero_exit`/`background_task_ceiling` reasons and
  `ModelState` (`"PENDING"`); `ModelRuntime` (+ `flushPartial`), `reconcileTimedOutOutput` and every TIMEOUT
  branch in `startModels`; `settleReducer`, the stdin write and EPIPE handler, the stream-json argv builder,
  the per-run SIGINT handler; `meaningfulStderr`, `BENIGN_STDERR_PATTERNS`, `readFullOutputIfNeeded`; the
  `StreamJsonReducer`, `stdio-decode` and `process-tree` imports. **[r-base]** Also `TeamRunOptions.spawnChild`
  and `.terminateGraceMs`, the spawn loop's `terminateChildTree` call and the `TERMINATE_GRACE_MS` import (the
  loop's `catch` itself stays, §6.1 step 7), and the "`finishing` (its `result` arrived and it is exiting)"
  wording of `teamSlotActivity`.
- `channel/session-manager.ts`: `buildChannelSpawnArgs`, `RESERVED_FLAG_ALIASES`, `TRANSPORT_BREAKING_FLAGS`,
  `RESERVED_CHILD_FLAGS`, `assertNoReservedFlags` (reworked into `pane/pane-launch.ts` `checkChildFlags`);
  `userFrame`, `writeFrame`, `flushDecoders`, `onPipeClosed`, `DRAIN_TIMEOUT_MS`; `openPipes`, `stdinClosed`,
  `autoCloseOnResult`, the `StringDecoder` fields; `recordStderr`, the stderr buffers, `STDERR_SIDE_LIMIT`, the
  `stderr.log` artifact, `stderrForDiagnostics`; the stall watchdog and `stallSeconds`,
  `refreshTranscriptPath`, the reducer construction. **[r-base]** Also `handleResult` (with its `TurnEnd`
  answer), `openFirstTurn`, `KNOWN_STATUSES`; `recordWaitTransition` is re-hooked, not deleted.
- `channel/types.ts`: `SessionStatus`, `ReducerEvent`, `ReducerCallback`,
  `SessionCreateOptions.keepUnrecognizedJson`, `SessionManagerOptions.stallSeconds`.
- `channel/index.ts`: the exports of all of the above.
- `mcp-server.ts`: `NEXT_STEP.nonzero_exit`/`.background_task_ceiling`; both `assertAgentAvailable` calls and
  the import; the `team` `required: ["mode","path"]`; the stream-json prose. **[r-base]** The `finishing` key
  of `EVENT_TO_TASK_STATUS` and the `finishing` line of `INSTRUCTIONS` (the map's comment goes back to counting
  the union's members).
- Env var `CLAUDISH_TEAM_CAPTURE` (removed).
- Test cases: `session-manager.test.ts` G5 (argv order), G6 (delta firehose), the `userFrame` test;
  `team-orchestrator.test.ts` 454–524 (argv, rewritten) and 575–632 (print-mode epilogue, replaced by the
  re-wake case); `team-output-classification.test.ts` background-ceiling and `captureMode` cases;
  `session-create-options.test.ts` `keepUnrecognizedJson`.

**Kept, with reason**: `classifyRunOutput`, `snippetHeadAndTail`, `persistErrorLog`, `STDOUT_TAIL_LIMIT`
(both owners); `process-tree.ts` (magmux reap); `ScrollbackBuffer` and the disk reader;
`launcher/magmux-wrapper.ts` (`STRIPPED_CHILD_VARS` gains an export consumer; `envDeltas`/`buildLauncherScript`
are no longer used by the pane path, which generates its own launcher, but stay for the CLI magmux path);
`launcher/magmux-binary.ts` `findMagmuxBinary` (reused, NFR3); `team-grid.ts`; claude-runner's `-p`/`--stdin`
handling (user-facing CLI); `madbench/session.ts`; `stats-buffer-signal-child.ts`. **[r-base]** All of
session-records' transport-independent code: `channel/home-dir.ts`, `channel/parent-proof.ts`, the launcher's
`CLAUDISH_LAUNCHER_PID`/`_PPID` pair in `bin/claudish.cjs`, `ToolCallContext.toolUseId`, the record writers in
`SessionManager` (§7), and `summarise`/`readTeamStatus`/`TeamRunOutcome`/`onSettled` in `team-orchestrator.ts`.

New env vars: **`CLAUDISH_PANE_CHILD`**, **`CLAUDISH_PANE_ENV`**, **`CLAUDISH_PANE_CWD`** — internal markers
set by the pane launcher and consumed by the child claudish, documented in `pane-session.md` and `config.ts`
`ENV`. **[r-base]** **`CLAUDISH_PANE_ROOT`** — a location override for `SOCK_ROOT`, of the same class as
`CLAUDISH_SESSIONS_DIR` (§20.4); every `ensureSockRoot` check and the < 100-byte socket-path assert still apply. No tuning knob: tests use `PaneSessionOptions` seams (`timings`, `@internal`). **[r2]** New files
generated per pane: `<launcherDir>/sh-shim`, `<launcherDir>/group`, `<launcherDir>/magmux.pid`; new module
`pane/process-identity.ts`; new process per pane: the watcher (`claudish-pane-watcher <paneId>` in `ps`).

---

## 11. Pre-existing defects fixed in the same change

| # | Defect | Fix | Test |
|---|---|---|---|
| F1 | `slugForPath` replaces only `[/.]`; Claude Code replaces every non-alphanumeric character (verified with `_`; realpath applied). | **[r-base]** One definition: 10.4.0's `projectDirNameFor` (`channel/parent-proof.ts`, pinned by `parent-proof.contract.test.ts`) already is the rule; `slugForPath` becomes that function applied to the realpath, and its local regex is deleted, so the path claudish derives and the directory the parent proof searches cannot drift. Old `meta.json` paths re-derived (§3.3). | slug test with the real `fresh_cwd.v1` directory name (research §1.1) |
| F2 | `PROJECTS_DIR` ignores `CLAUDE_CONFIG_DIR`. | **[r-base]** `projectsDir(env = process.env)` = `join(claudeConfigDir(env), "projects")`, reusing 10.4.0's `claudeConfigDir` (`CLAUDE_CONFIG_DIR`, else `$HOME/.claude`, else the OS home's — the `$HOME`-first rule of `home-dir.ts`, because Bun's `os.homedir()` ignores a runtime `HOME`), at call time (the `env` argument is r2's X-M9 seam) | unit test setting `CLAUDE_CONFIG_DIR`, and one setting only `HOME`, in a passed env |
| F3 | `CLAUDISH_TOKEN_FILE` from the parent is overwritten in claude's env by `createTempSettingsFile`'s `tokens-<port>.json`; the status line reads an empty file. | New exported `resolveTokenFilePath(port)` used by `createTempSettingsFile` and `session-stats.ts:79` | env `CLAUDISH_TOKEN_FILE` → returned `tokenFilePath` equals it |
| F4 | `CLAUDE_CODE_CHILD_SESSION` survives the ambient-magmux and plain interactive paths ("Transcript saving is off", research §3.4). | claude-runner deletes every `STRIPPED_CHILD_VARS` key when `config.interactive`; the pane snapshot excludes them | `claude-runner` env test |
| F5 | `EVENT_TO_TASK_STATUS` has no `awaiting_permission` key. | `["awaiting_permission","input_required"]` + a test iterating every `ChannelEventType` | table test |
| F6 | The team run registry is keyed by basename. | Key by resolved path (§3.2) | two runs sharing a basename both listed |
| F7 | Existing drivers do not pass `--sock-dir`; an inherited `MAGMUX_SOCK_DIR` moves the socket. | The pane path always passes `--sock-dir` and strips `MAGMUX_*`. `team-grid.ts` (CLI, out of scope) recorded in `pane-session.md` as latent. | launcher unit test |
| F8 **[r2]** | claude-runner's ambient recovery-UI branch (:2022) restates the surface rule as a hand-written `MAGMUX_SOCK` expression instead of reading `magmuxPaneCapability()`, the "two statements of one rule" `network-recovery.md` forbids. | Read `paneCapability.kind === "ambient"`; add the `pane-child` case to `magmuxPaneCapability()` (D22) | `recovery/settings.test.ts` source guard + pane-child case |

**`--settings` overlay — how `skipDangerousModePermissionPrompt` gets in.** `buildClaudishSettingsOverlay`
(`claude-runner.ts:972`) gains `paneChild: boolean` from `process.env[ENV.CLAUDISH_PANE_CHILD] === "1"`; when
true the overlay carries `skipDangerousModePermissionPrompt: true`. `mergeUserSettingsIfPresent` (:995) sets
the same key when the user's `--settings` lacks it. Right after the env literal (:1620) claude-runner deletes
`CLAUDISH_PANE_CHILD`, `CLAUDISH_PANE_ENV` and `CLAUDISH_PANE_CWD` from claude's env. The overlay loads at the
CLI-args tier, verified to suppress dialog 3.

**Dialog 4 on a fresh machine** (M19). Every proxied child gets claudish's placeholder `ANTHROPIC_API_KEY`, so on
a fresh `~/.claude.json` every foreign-model pane meets the API-key dialog and fails `first_run_dialog`
(frequency: once per machine/config dir, until answered once). Pre-seeding `customApiKeyResponses` or an
`apiKeyHelper` through the same `CLAUDISH_PANE_CHILD`-gated overlay would remove it, but it changes auth
behaviour; it is recorded in `ROADMAP.md` with this trigger, and R15 verifies the reported reason and text.

---

## 12. Testing strategy

### 12.1 Hermetic principles (H11)

- **Every process-spawning test builds its own environment** in its own `beforeEach` with
  `makePaneTestEnv()` (`pane/test-helpers/hermetic-env.ts`), never relying on `test:safe`:
  - constructed by **allowlist**, not by deleting from `process.env`: `PATH`, `TMPDIR`, `USER`, `LOGNAME`,
    `LANG`, then `HOME=<tmp>/home`, `CLAUDE_CONFIG_DIR=<tmp>/home/.claude`, `ZDOTDIR=<tmp>/home`,
    `XDG_CONFIG_HOME=<tmp>/xdg`, `SHELL=/bin/zsh`, `CLAUDISH_DISABLE_KEYCHAIN=1`, `CLAUDISH_DISABLE_OP=1`,
    `CLAUDISH_DISABLE_CATALOG_WARM=1`, `CLAUDISH_NO_PREDEFINED_ENDPOINTS=1`, `CLAUDISH_BIN=<fake>`; no
    `ANTHROPIC_*`/provider key survives because none is allowlisted;
  - `sockRoot = /tmp/cpt-<8 hex>` (short, so socket paths stay < 100 bytes; removed in `afterEach`);
  - `assertHermetic(env)` fails the test if `HOME`, `CLAUDE_CONFIG_DIR` or `ZDOTDIR` resolve under the real
    home, and a hostile-inheritance test runs the suite helper with `CLAUDE_CONFIG_DIR`/`ZDOTDIR` set to a
    canary dir in the outer env and asserts nothing is written there.
- **Files that spawn real magmux** (and only these): `pane/magmux-client.test.ts`,
  `pane/pane-session.integration.test.ts`, `pane/pane-registry.test.ts`, `team-orchestrator.test.ts`,
  `team-cancel.test.ts`, `team-heartbeat-survival.test.ts`, `team-liveness-exited-slot.test.ts`,
  `team-multibyte-answer.test.ts`, `team-mcp-shape-contract.e2e.test.ts`, `team-cli-signal.test.ts`,
  `channel/session-manager.test.ts`, `channel/channel-wire-format.test.ts`,
  `channel/session-create-options.test.ts`, `mcp-contract.e2e.test.ts`, r2's
  `pane/pane-child-real-claudish.integration.test.ts`, and **[r-base]** the ported session-records suites
  (`channel/host-pid.contract.test.ts`, `channel/session-state-records.contract.test.ts`,
  `channel/spawn-record.contract.test.ts`, `channel/session-timeout.test.ts`,
  `team-orchestrator-settle.contract.test.ts`, `team-run-mcp.contract.test.ts`, `team-run-settles-once.test.ts`,
  `team-start-failure.test.ts`; §20.2). Server-level suites pass `CLAUDISH_PANE_ROOT=<their sockRoot>` so the
  no-orphan assertion and the startup sweep stay inside the test. Each uses
  `describe.skipIf(!findMagmuxBinaryOrNull())` with the message **"magmux not installed — not checked"**
  (`testing.md`). CI (`test.yml`) already runs `brew install MadAppGang/tap/magmux`; it stays, pinned to a
  version ≥ 0.14.0.
- Real magmux, never a mock; no `mock.module` of shared infrastructure. Pure modules are tested directly.
- **Fixtures come from real logs, copied verbatim:** `pane/test-fixtures/transcripts/` (the rsch-c2 PEAR run,
  an API-error transcript, a tool-use transcript with a re-wake, a sidechain sample, a **compacted** transcript,
  a background-agent transcript with `pendingBackgroundAgentCount > 0` and its `<task-notification>`, a
  slash-command and a local-command transcript, `max_tokens`/`refusal` turns, an Esc-declined
  AskUserQuestion); `pane/test-fixtures/screens/` (REPL, the four dialogs, an unnamed choice dialog,
  agent-rejected, long Bash, AskUserQuestion, permission, ExitPlanMode, a screen-mode API error, an open
  autocomplete menu); `pane/test-fixtures/frames/` (research e5/e6). For each, `git ls-files` lists it and
  `git check-ignore -v` prints nothing.
- **[r2] Fixture provenance and redaction** (X-M8). Fixtures come first from Phase 2's **synthetic live
  captures** (native haiku in a scratch cwd under the hermetic config, so they carry no private content).
  Where a shape exists only in the local corpus (a compaction, a real background-agent run), the record is
  passed through `scripts/redact-transcript-fixture.ts`, which keeps every key, type, `subtype`, `stop_reason`,
  ordering and id relationship and replaces text bodies, tool inputs/outputs, `cwd`, `gitBranch` and paths
  with placeholders of the same kind. `pane/test-fixtures/fixtures-redaction.test.ts` greps every fixture
  for `/Users/`, the real home path, `sk-`, `ghp_`, `xox`, `AKIA`, `-----BEGIN` and e-mail addresses and
  fails on any hit. The "copied verbatim" rule still holds for structure: no hand-written record.
- **[r2] Timing** (X-M7): scenario gaps are read by the fake from `FAKE_GAP_MS_<NAME>` env values, and
  tests pass matching `timings` seams, so scenarios keep their **ordering** at a fraction of real time
  (e.g. a 2 s re-wake gap against a 1 s quiet window). Exactly one test per window runs with the production
  constant (`quiet` with the default `secondaryQuietMs`, marked slow with a 90 s timeout); every
  timing-sensitive test sets an explicit per-test timeout. The Stop-hook scenarios no longer depend on any
  window: path S cannot fire without a `stop_hook_summary` (§2.8).

### 12.2 The fake interactive child — `pane/test-helpers/fake-interactive-child.ts`

**Contract** (M9, M18): reads `--model fake-<scenario>[-<n>]`, `--session-id`, `--agent`, `--add-dir`; draws on
the alt screen with bracketed paste enabled and raw stdin; boots by drawing the REPL lines **copied from the
real fixture**; writes its transcript to `<CLAUDE_CONFIG_DIR>/projects/<slug(realpath cwd)>/<uuid>.jsonl`
(F1 rule); records are produced by templating lines from real fixtures (ids and text substituted).
**Key semantics come from the Phase 2 keylog of the real REPL** (cited beside the fixture), not from the
design: `\r` submits; whatever Phase 2 measures for `\n`, Esc on a choice dialog, and a menu-opening trailing
token is what the fake does. When it receives the file-reference template it **emits Read `tool_use` and
`tool_result` records templated from the Phase 2 capture** (Read's numbered rendering, paging by the measured
per-call cap, truncating lines over the measured limit exactly as Read does), reconstructs the text from its
own Read results (numbers stripped, marked splits joined), and answers `ANSWER <model> <sha1(reconstructed)
[0..8]>` — so a hermetic test compares that hash with `sha1(caller's prompt)` and sees any truncation (r2,
X-H5). For a typed line it hashes the line.

**[r-base] Marker mode** (absorbs `test-helpers/contract-fake-child.ts`, §20.2). When `--model` is not
`fake-<scenario>` (the contract suites pass `contract-fake-model`), the scenario is chosen by markers in the
delivered prompt text (the typed line, or the file content it reconstructed from its Read results) or in argv:
none → `answer`; `@@TOOL@@` → one extra Bash `tool_use`/`tool_result` round trip before the answer; `@@HANG@@`
→ accepts the prompt, never answers (RUNNING, `activity:"thinking"`, until reaped); `@@LINGER@@` → answer,
then a static gap of `LINGER_MS` (1,500) before `stop_hook_summary` and `turn_duration`, so
`activity:"finishing"` is observable; `@@LATE@@` → the `rewake` shape (answer, gap, a second assistant message,
`turn_duration`). The env is honoured as before: `CONTRACT_FAKE_SIGTERM_MARKER` (a file written on SIGTERM or
SIGHUP), `CONTRACT_FAKE_HANG=1` (`@@HANG@@` regardless of input), `CONTRACT_FAKE_MAX_MS` (a safety exit, default
20 s, so a broken test never leaves a REPL behind). A new scenario `ignore_term` traps SIGTERM and SIGHUP and
dies only on SIGKILL (the `team-start-failure` case).

**Scenarios:**

| scenario | behaviour | proves |
|---|---|---|
| `answer` | answer + `turn_duration{pending:0}` | happy path, primary settle |
| `quiet` | answer, `stop_hook_summary`, no `turn_duration` | path S after `secondaryQuietMs` with the anomaly (one run at the production constant, §12.1) |
| `quiet_no_summary` **[r2]** | answer, no `stop_hook_summary`, no `turn_duration`, session not proven hook-less | **never settles**; `activity:"finishing"`; cancel → CANCELLED (X-H2) |
| `hookless_quiet` **[r2]** | turn 1: end_turn → `turn_duration` (no summary); turn 2: answer, no `turn_duration` | turn 2 settles by path S (`provenHookless`) |
| `rewake` | end_turn, `stop_hook_summary`, gap **longer than the quiet window under test**, second assistant message, `turn_duration` | no settle before the `turn_duration`; both texts concatenated |
| `slow_stop_hook` | end_turn, silent static screen for **3 × the quiet window under test**, `stop_hook_summary`, `turn_duration` | no settle during the hook by **any** path; settles on P after it (X-H2) |
| `bg_rewake` | end_turn, `turn_duration{pending:1}`, gap, `<task-notification>`, real answer, `turn_duration{pending:0}` | waits for background agents; `activity:"background"` |
| `bg_server` **[r2]** | a `run_in_background` Bash launch that never notifies, answer, `turn_duration{pending:0}` | settles at the `turn_duration`; anomaly `background_shell_open`; reap ends the shell (X-H6) |
| `ask_user_send` **[r2]** | channel: pending AskUserQuestion; a send arrives → Esc → rejection `tool_result` + `[Request interrupted by user for tool use]`, **no** `turn_duration` | path I settles `interrupted`; the queued text is delivered and answered as turn 2 (X-H3) |
| `interrupt_td` **[r2]** | as above, with a `turn_duration` after the interrupt (the 91-of-127 shape) | same outcome, one settle only |
| `narrate_then_read` **[r2]** | "I'll read the task file first." + Read `tool_use` in one message, `tool_result`, then `VERDICT: ok` | answer begins `VERDICT:`; `^VERDICT:` pattern → COMPLETED; `preambleBytes > 0` (X-H4) |
| `long_line` **[r2]** | prompt with a 5,000-char line | file has marked splits; fake's reconstructed hash equals the prompt's (X-H5) |
| `partial_read` / `no_read` **[r2]** | Reads only the first page of a long file / never calls Read | team: FAILED `prompt_not_read` with the line counts; interactive: continues, `meta.prompt_not_read` (X-H5, X-M4) |
| `slow_prompt_hook` **[r2]** | box clears on submit, user record written after a gap longer than the degraded-entry delay, then a normal turn | degraded entry, then `degraded_reverted`; transcript answer, `turnSource:"transcript"` (X-H7) |
| `exit_before_td` **[r2]** | answer (`end_turn`), exits 0 before `turn_duration` | settled by path X; team verdict from the answer, not `child_exited` (X-M11) |
| `interactive_exit_after_settle` **[r2]** | interactive: answer + `turn_duration` and exit 0 in the same poll | `turn_continue` then `exit_clean` → COMPLETED (X-M10) |
| `promptless_first_send_ignored` **[r2]** | promptless session; the first send is never submitted | wire stays AWAITING_INPUT → RUNNING → AWAITING_INPUT with `send_rejected`; never STARTING, never FAILED (X-M1) |
| `idle_suggestion` **[r2]** | idle box showing dim prompt-suggestion text (real capture) | reads as empty; settle and boot proceed (X-M14) |
| `compaction` | assistant text, compact boundary + `isCompactSummary` user record, more text, `turn_duration` | one settle, full text (H12) |
| `max_tokens` / `refusal` / `null_stop` | the Phase 2 record shapes | settle; `refused` → EMPTY; truncation note |
| `no_shape` | answer without the marker | `require_pattern` negative control → EMPTY `shape_mismatch` |
| `api_error` | `isApiErrorMessage` entry | FAILED `api_error` (one-shot and interactive) |
| `tool_slow` | Bash tool_use, 5 s static screen, tool_result, answer | no kill; `activity:"Bash"`; idle grows |
| `ask_user` | pending AskUserQuestion + real choice screen | channel: AWAITING_INPUT + `activity`; team: FAILED `blocked` (the send path is `ask_user_send`) |
| `permission` | pending Edit + real permission screen | AWAITING_PERMISSION; frame `awaiting_permission` |
| `multibyte` | CJK + emoji answer | `response-<id>.md` byte-exact |
| `exit_mid_turn` | exits 3 after the prompt | FAILED `child_exited`, code 3 |
| `exit_after_settle` | answer + `turn_duration`, exits 0 at once | verdict from the settled turn, not `child_exited` (M5) |
| `turn2_exit0` | interactive: turn 1 settles, turn 2 accepted, exit 0 | FAILED `child_exited` (C3) |
| `idle_exit` | interactive: `/exit` → exit 0 | COMPLETED via `exit_clean` |
| any + `--agent zzz*` | real "not found. Available agents" text, exit 1 | FAILED `agent_rejected` |
| `dialog_*` (4 named) / `dialog_unknown` | real dialog screen / unnamed choice screen, waits | FAILED `first_run_dialog` / `boot_blocked` in ≈ 5 s |
| `slow_boot` | 3 s primary screen, then REPL | STARTING then boot; `bootTimeoutMs:1000` → `boot_timeout` |
| `ignore_input` | never submits | `initialDelivery` → FAILED `prompt_not_accepted`; any later delivery → IDLE + `send_rejected` |
| `menu_eats_enter` | first Enter closes a menu | `resent_enter` path accepts |
| `immediate_write` | writes its user record before the send reply returns | witness still found (offset taken before delivery) |
| `ignore_hup` | ignores SIGHUP | reap's group backstop leaves no survivor; the watcher got `done` and exited |
| `orphan_grandchild` | pane leader exits, a grandchild (no identifying argv) keeps running | the group check passes on the recorded (pid, start time); backstop, watcher and sweep each kill the group |
| `no_transcript` / `empty_transcript` / `missing_no_warning` | saving-off line / empty file / no file and no warning | degraded mode entry for each (C4) |
| `screen_fast` / `screen_api_error` | degraded: answer drawn and gone within one frame interval / error row | settles without `isWorking`; FAILED `api_error` |
| `status_tick` | idle status-line row changes every second | settle not held open; `seq` advances honestly |
| `env_probe` | writes its env and cwd to a file | real `SHELL` restored (not the shim); a clobbering `$ZDOTDIR/.zprofile` (canary key, `CLAUDE_CONFIG_DIR`, `cd /`) is **never sourced**; terminal-identity vars absent (r2, X-M15, X-M16) |

**[r2] The real child claudish, hermetically** (X-M6) —
`pane/pane-child-real-claudish.integration.test.ts`: `CLAUDISH_BIN=<repo>/packages/cli/src/index.ts` (the real
entry, run by bun) and `CLAUDE_PATH=<fake-interactive-child in "claude" mode>`, with a native model name so no
proxy request is made. The fake `claude` dumps its argv, env and the `--settings` file, then emulates the REPL.
Asserted: `child-env.ts` restored the snapshot and the cwd; the overlay carries
`skipDangerousModePermissionPrompt: true`; `CLAUDISH_PANE_CHILD`/`_ENV`/`_CWD` are absent from claude's env;
no `CLAUDE_CODE_RETRY_WATCHDOG` even when the outer env carries a claudish-marked one (D22); `CLAUDISH_TOKEN_FILE`
reaches the status-line path (F3); `CLAUDE_CODE_CHILD_SESSION` stripped (F4); a positional or `--team` in
`claude_flags` that slipped past the walker exits 64 with `pane child refused`.

### 12.3 New test files

| File | Kind | Covers |
|---|---|---|
| `pane/slot-state.test.ts` | pure | every legal transition (incl. r2 `rewake`); terminals absorb; illegal → null; `wireState` for every phase; ADMITTING(`initialDelivery`) → STARTING, ADMITTING(other, incl. a promptless first send) → RUNNING |
| `pane/screen-model.test.ts` | pure (real frames) | seq 0 before first frame, first blank keyframe → 1; style-only and alt-only changes bump; `aboveBoxChangedAt` ignores status rows |
| `pane/screen-classifier.test.ts` | pure (real screens) | REPL vs each named dialog; unnamed choice; permission/plan/question markers; error rows; `screenAnswer` excludes tool/spinner/token rows; menu detection |
| `pane/transcript-follower.test.ts` | pure (real transcripts) | per-`message.id` dedupe incl. subagents; turn scoping by offset (earlier evidence never satisfies a later turn); witness kinds; compaction; task-notification; agent balance (background Bash excluded, listed in `backgroundShellsOpen`); partial-line tail; r2: both interrupt record forms; `stopHookSummaryAfterLast`; `provenHookless` only from `end_turn → turn_duration`; read coverage from returned line numbers (paged, truncated, `is_error`); answer start after coverage; `preambleBytes` |
| `pane/settle-rule.test.ts` **[r2]** | pure | the §2.8 decision table: P, I, S (each Stop-hook gate), X, with and without screen corroboration and while disconnected |
| `pane/prompt-delivery.test.ts` | pure | plain/command/file/control classification; CRLF, tab, leading `!`/`#`/`?`, trailing `@x`, 200 KB, multi-line slash command; template charset; file bytes equal the prompt except marked splits; r2: split at whitespace below the limit, hard split, marker collision → alternate marker named in the template, 512-char slash first line |
| `pane/pane-launch.test.ts` | pure | launcher content (`cd`, exec, quoting; r2: no watcher, no `PATH` line); shim content and `SHELL` override after the snapshot; `-e` never names `claude`; snapshot excludes shell-managed, stripped and terminal-identity keys and keeps the real `SHELL`; Linux env-size refusal; id validity and sock path < 100; `lstat` symlink refusal; watcher argv (`claudish-pane-watcher <paneId> …`, values only as positional parameters) |
| `pane/process-identity.test.ts` **[r2]** | pure (recorded `ps` tables) | `isPaneMagmux` needs `--id <paneId> --sock-dir`; identity by `--session-id` or launcher path; group check passes on a recorded (pid, start time) and fails on a same-pid/different-start process; the TS predicates and the generated shell agree on the same tables |
| `pane/child-flags.test.ts` | pure | reserved set incl. `--bg`, `-w`, `--from-pr`, `--teleport`, `--no-session-persistence`, r2's print-only set (refusal names the loss) and claudish mode flags; `--allowedTools Read Bash` and `-- --effort high` refused; walker ≡ `parseArgs` table |
| `pane/child-env.test.ts` | pure | snapshot applied, extra keys removed, marker vars deleted, chdir |
| `pane/accounting.test.ts` | pure | precedence pseudocode; `billed_input_tokens`; native → `cost_usd:null`; native never with a foreign token file |
| `pane/magmux-client.test.ts` | real magmux (`sleep` pane) | id correlation, error replies, pushed `exit`, EOF resolves pending requests |
| `pane/pane-session.integration.test.ts` | real magmux + fake | §12.2 scenarios; capture/`since_seq`/`final`; **subscriber drop**: close our socket while magmux and child live → reconnect, no state change, `seq` continues; concurrent sends; 5 sessions → unique ids, all reaped; after every test **no process whose argv contains the test's `sockRoot` (pane shell, claude's `--add-dir`, the watcher) or session id remains, no process remains in any of the test's pane pgids, and no socket, record or launcher dir remains in `sockRoot`** (`ps`-based; r2, X-C1) |
| `pane/pane-registry.test.ts` | real magmux | `reapAllPanes` parallel ≤ 3 s for 5 panes; **[r2] clean reap ends the watcher** (no `claudish-pane-watcher <paneId>` after `reaped()`); **owner SIGKILL with two panes**: a child bun process owns two panes and is SIGKILLed → both watchers remove group, magmux, socket, launcher dir and record within 5 s (also proves no sibling holds another watcher's pipe); **decoy**: a `sleep` whose pid is written into `magmux.pid` and `group` is still alive after the watcher and the sweep run; sweep of dead-owner records (identity validated, wrong-identity pid not signalled; a record whose watcher is alive is skipped); recordless socket probe; `reapFailed` record not counted; pane limit counted across two owner processes |
| `team-cli-signal.test.ts` | CLI + fake | `claudish team run` SIGINT → exit 130, no pids, no sockets |
| `mcp-shutdown.e2e.test.ts` | real MCP server + fake | close server stdin mid-run → server exits, nothing left; SIGTERM likewise |
| `team-list-contract.test.ts` | orchestrator + fake | registry by `run_id` with the newest-by-path index, retention, `list` ordering, F6, `ACTIVE`/`SETTLED`; r2: a superseded run at the same path is listed, capturable and cancellable (`changed:false`) by its `run_id`, its `status` omits the legacy keys; a second `run` on an ACTIVE path → `Error: invalid_args: …` |
| `channel/session-records.contract.test.ts` **[r-base]** | real MCP server + fake | the record half that the 10.4.0 suites assume and panes must now produce: `meta.json` carries the 10.4.0 keys with 10.4.0 types (`status` ∈ completed/failed/cancelled/timeout with EMPTY → `failed`; `terminalReason` = the `FailureReason` or null; `toolCallCount`, `turnsCompleted` integers; `costUsd` number or null; `exitCode` integer or null; `elapsedSeconds`) for each terminal state; `events.jsonl` has exactly one `{type:"assistant",message:{id}}` line per distinct main-chain message id (the monitor's reply rule, applied by a copy of its 10-line reader); a QUESTION and a PERMISSION in a channel session each open and close one wait; a re-wake closes the wait with `to:"running"` and the next settle reopens it with `turns` unchanged; IDLE with a queued send writes no line (`onTransition` is net of the pump); a CANCELLED team row in `status.json` carries `error.reason:"cancelled"` |
| `mcp-contract.e2e.test.ts` | real MCP server over JSON-RPC + fake | **exact key sets** of `TeamListResult`, `TeamRunRow`, `SlotRow`, `SessionRow`, `SessionListResult`, status additions, `CaptureResult`, `CaptureUnchanged`, `TeamCancelResult`, `SessionCancelResult`, `ContractError` (`Object.keys(...).sort()` equality); `contract_version === 1` and `capabilities` exact; state values ⊂ the closed set; cancel idempotency; `unchanged` when idle; error paths of every §8 verb return JSON `ContractError` |

### 12.4 Rewritten tests (each keeps its original intent)

| File | New form |
|---|---|
| `team-orchestrator.test.ts` | Argv pinned through the launcher (`-i --model X -y --quiet --session-id <uuid> --add-dir <dir>`, no `-p`/`--stdin`/stream-json). Per-slot `UPSTREAM_ERROR_LOG` reaches the child (`env_probe`). Re-wake concatenation replaces the print-mode epilogue case. setupSession, judge and pure tests kept. |
| `team-cancel.test.ts` | Same assertions, with reap proven (no pids, socket, record) and `changed` idempotency |
| `team-heartbeat-survival.test.ts` | `tool_slow` and `slow_stop_hook` are not killed |
| `team-liveness-exited-slot.test.ts` | A terminal row has `idle_seconds:null` while a sibling runs |
| `team-multibyte-answer.test.ts` | `multibyte` scenario |
| `team-mcp-shape-contract.e2e.test.ts` | `fake-no_shape` → EMPTY `shape_mismatch`; `fake-answer` with a contained pattern → COMPLETED |
| `team-output-classification.test.ts` | New signature (`stopReason`, `promptRead`, state); bg-ceiling/captureMode cases deleted; precedence kept + `prompt_not_read` (after `api_error`) + `refused`; anchored-pattern cases (`^VERDICT:` against an answer that starts with it, no `m` flag) |
| `recovery/settings.test.ts` **[r2]** | pane child → `magmuxPaneCapability` `none/pane-child`; no watchdog; an inherited claudish-marked watchdog removed, a user's unmarked one kept; source guard covers the ambient branch (D22, F8) |
| `team-result-card.test.ts`, `team-status-payload.test.ts` | CANCELLED, new reasons, `blocked` listing, `run` row, `contract_version`/`capabilities`, derived `*_by_slot` maps; note ordering kept |
| `channel/session-manager.test.ts` | Lifecycle on panes. G1/G2 timeout stays timeout in memory, meta and wire, **sending while RUNNING (queued)**. G4 uses the new flag check. G7: promptless → send while STARTING (queued) → answer. D1–D5 disk recovery with the new artifact set. G3 and the 585 mapping kept. |
| `channel/session-create-options.test.ts` | `sessionId`, `sessionDir`, `tokenFile` reach the child (`env_probe`) |
| `channel/channel-wire-format.test.ts` | Every assertion kept (FR10); fake swapped; `awaiting_permission` added; **[r-base]** the SEP-1686 table loses 10.4.0's `finishing` row, keeps its `timeout: failed` row |
| `channel/session-manager.test.ts` (10.4.0 edits) **[r-base]** | 10.4.0's expectations are restated for panes: a one-shot session's events are `["running", "completed"]` (no `finishing`; STARTING is the initial state, not a transition); a promptless session is `waiting_for_input` once boot is ready (STARTING before), not at creation |
| `channel/e2e-channel.test.ts` | Pinned lists become **14** tools and **7** channel tools (`capture_session`); low-level stays 4 |
| `mcp-preflight-not-a-precondition.test.ts` | Re-run (it greps tool descriptions) |
| `process-tree.test.ts` | Kept |

---

## 13. Implementation phases

One developer agent per phase; sequential where files are shared. **Before Phase 1:** the orchestrator sends
§8 verbatim to the peer `claudish-mcp-feedback` (FR9).

| Phase | Scope | Files | Depends on |
|---|---|---|---|
| **1. Defects + markers** | F1–F5, **r2 F8 + D22** (pane child not recovery-eligible; ambient branch reads `paneCapability`). `CLAUDISH_PANE_CHILD`/`_ENV`/`_CWD` in `ENV`; overlay/merge key; marker strip; `child-env.ts` + the child-side interactive assertion incl. `!config.team` (§2.14); `classifyPassthroughTokens` extracted in `cli.ts`; `ChannelEventType` union + map key; `projectsDir(env)`. **[r-base]** F1/F2 reuse `projectDirNameFor`/`claudeConfigDir` from `channel/parent-proof.ts`; the union gains `awaiting_permission` and keeps 10.4.0's `finishing` until Phase 5 (the stream-json path still emits it). | `session/session-discovery.ts`, `session/session-stats.ts`, `claude-runner.ts`, `launcher/magmux-wrapper.ts`, `recovery/settings.test.ts`, `cli.ts`, `index.ts` (import), `config.ts`, `pane/child-env.ts`, `channel/types.ts` (union), `mcp-server.ts` (map), tests | — |
| **2. Captures + pure core (GATE)** | **Live captures first**, driven by the existing `scripts/magmux-drive-session.ts` (r2, X-L6; deleted in Phase 3), native haiku, cents, hermetic `CLAUDE_CONFIG_DIR` copy, **with the pane's scrubbed environment** (§2.3): REPL keylog (`\n`, Esc on each dialog, trailing `@`/`/` menu); long Bash; AskUserQuestion + Esc decline; permission prompt + Esc decline (record shapes of both interrupts) and ExitPlanMode (caller `--permission-mode`); a background Task and a background Bash finishing after end_turn (record shapes, `pendingBackgroundAgentCount`, notification); **r2 ending matrix**: `end_turn`, `max_tokens`, `refusal`, API-error and interrupted turns, each in a config with **no** Stop hook and with **one** Stop hook (`sleep 30`) — which of `stop_hook_summary` / `turn_duration` follow each (any ending lacking `turn_duration` gets a named settle path before Phase 3, §2.8); whether the screen repaints above the box while a Stop hook runs; a post-turn idle box with a prompt suggestion and a fresh-boot placeholder (empty-box rule, §2.6); a slow UserPromptSubmit hook (box clears before the user record); a slash command and `/cost`; a compaction; Read on 2.1.287 (lines per call, chars per line, token cap, the numbered rendering, CR handling) → `READ_LINE_LIMIT` and the coverage parser; screen-mode API error. `refusal` is elicited through claudish's Gemini content_filter → refusal mapping; a shape that still cannot be elicited is a **documented skip** in `phase2-captures.md` with its branch covered by a redacted corpus record, never a hand-written one (X-L12). **Measure** the `stop_hook_summary` → next main-chain append gap over the local corpus → `secondaryQuietMs`. **Gate:** every named marker in §2.6 and every record shape in §2.7–2.8 matches a verbatim capture, or the classifier/reducer is corrected here, before Phase 3. Then `contract.ts`, `slot-state.ts`, `screen-model.ts`, `screen-classifier.ts`, `transcript-follower.ts`, `prompt-delivery.ts`, `accounting.ts`, `slot-row.ts` + unit tests. | `pane/*` (new), `pane/test-fixtures/**`, `team-stats.ts` (`billed_input_tokens`), `ai-docs/reports/mcp-magmux-panes/phase2-captures.md` | 1 |
| **3. Transport + session + registry** | `magmux-client.ts` (reconnect), `pane-launch.ts` (snapshot, shim, launcher, watcher spawn, flags), `process-identity.ts` (TS predicates + generated watcher shell), `pane-session.ts` (pump, blocked, reconnect, exit path, settle paths), `pane-registry.ts` (records, group snapshots, cross-owner limit, hooks, sweep), `index.ts`; the fake child (incl. "claude" mode, **[r-base]** marker mode, the `CONTRACT_FAKE_*` env, `ignore_term`) + hermetic env helper + redaction script; **[r-base]** `PaneSessionOptions.onTransition`, `CLAUDISH_PANE_ROOT`, the host-identity strip in the snapshot; integration, real-claudish and registry tests; `scripts/pane-drive.ts`; delete `scripts/magmux-drive-session.ts`. **Gate (r2):** under Bun, `lsof` shows no watcher pipe in magmux or a sibling watcher, and the two-pane owner-SIGKILL test passes; else the polling fallback of §2.3 is enabled before Phase 4. | `pane/*`, `pane/test-helpers/*`, `launcher/magmux-wrapper.ts` (export only), `scripts/` | 2 |
| **4. Team migration** (shares `mcp-server.ts` with 5 → sequential) | `startModels` on `PaneSession` (boot stagger, `parentEnv`); `onBlocked`; registry by `run_id` + newest-by-path index + retention; `list`/`capture`/`cancel`/`status` with `run` row and CA-12 fields; `classifyRunOutput` re-sign; `FailureReason` from `pane/`; `NEXT_STEP`; schema `required:["mode"]`; team-grid new fields; **`team-cli.ts` and `index.ts --team`** (flags check, signal hooks, `--json` dropped); remove team's `assertAgentAvailable`. Team tests per §12.4, `team-list-contract.test.ts`, `team-cli-signal.test.ts`. **[r-base]** Keep `onSettled`, the spawn-loop `catch` re-based onto panes (§6.1 step 7), registry entry after the loop, `done` last; delete `spawnChild`/`terminateGraceMs`; `summarise` terminal guard; CANCELLED rows carry `error.reason`; the `run` handler reorders refusals → `setupSession` → proof → `recordTeamRun` → `startModels` and returns `monitor_record`. Port the team half of §20.2 (`team-orchestrator-settle`, `team-run-mcp`, `team-run-settles-once`, `team-start-failure` onto the pane fake, passed explicitly through `serverEnv(layout, {CLAUDISH_BIN})` because the channel suites still run the stream-json fake until Phase 5; `team-run-summary`, `team-run-record` via the `modelStates()` adapter). | `team-orchestrator.ts`, `team-stats.ts`, `team-grid.ts` (types), `team-cli.ts`, `index.ts`, `mcp-server.ts` (team tool, `NEXT_STEP`, `formatTeamResult`, `buildTeamStatusPayload`, `teamStatusNote`), team tests, **[r-base]** `test-helpers/contract-adapters.ts` (`spawnSeam` deleted, `modelStates()`), `test-helpers/contract-mcp.ts` (pane-fake option, `CLAUDISH_PANE_ROOT`, magmux skip) | 3 |
| **5. Channel migration** (after 4) | `SessionManager` on `PaneSession` (queue, API-error policy, `parentEnv`, `rewake`, `meta.prompt_not_read`); `SessionInfo`; `channelEventFor`; `capture_session`; `cancel_session`/`send_input`/`list_sessions` shapes (+ CA-12); `get_diagnostics` fields; `INSTRUCTIONS`; MCP shutdown on stdin EOF/transport close/signals via `installPaneShutdownHooks` + startup `sweepOrphanPanes`; §4.3 envelope for every §8 verb. **Delete** the files in §10 (their last callers die here) and repoint their consumers. Channel tests per §12.4, `mcp-contract.e2e.test.ts`, `mcp-shutdown.e2e.test.ts`. **[r-base]** Record writers re-hooked: `spawn.json` before `startPaneSession`; `waits.jsonl` from `onTransition`; `toMetaRecord` + a two-generation disk reader; `events.jsonl` assistant lines; `shutdownAll` ends records before exit; `get_diagnostics` `event`; drop `finishing` from the union, the map and `INSTRUCTIONS`. Port the channel half of §20.2 (`session-state-records`, `spawn-record`, `host-pid`, `session-timeout`), make the pane fake `contract-mcp.ts`'s default, delete `contract-fake-child.ts`, `stream-json-reducer.contract.test.ts` and the reducer probes in `contract-adapters.ts`; add `channel/session-records.contract.test.ts`. | `channel/session-manager.ts`, `channel/types.ts`, `channel/index.ts`, `mcp-server.ts`, deleted files, channel tests, `mcp-e2e/*`, **[r-base]** `test-helpers/contract-*.ts` | 4 |
| **6. Docs + sweep** | §14 docs; pin the magmux version the release job bundles (L9); `bun run typecheck`, `lint`, `format`, `test:safe`, plus `bunx bun@1.3.10 test` for CI parity; residue grep (`stream-json`, `StreamJsonReducer`, `captureMode`, `CLAUDISH_TEAM_CAPTURE`, `assertAgentAvailable`, `nonzero_exit`, `background_task_ceiling`, `magmux-drive-session`, **[r-base]** `TurnEnd`, `awaitInput`, `spawnChild`, `terminateGraceMs`, `contract-fake-child`, and `finishing` used as a channel event or a session status) across `packages/`, `ai-docs/architecture/`, `docs/`, `CLAUDE.md`. | `ai-docs/architecture/*`, `CLAUDE.md`, `docs/usage/mcp-server.md`, `docs/usage/magmux.md`, release workflow | 5 |
| **7. Live verification + release** | §15 through the real MCP server over JSON-RPC, **with `CLAUDISH_BIN=<built dist entry>` in the server env so every child is the build under test** (M7); each child's version is printed from `startup-metrics.jsonl` into the evidence. Evidence to `ai-docs/reports/mcp-magmux-panes/` (tracked). Minor bump per CLAUDE.md "Releasing" — **[r-base]** to 10.5.0 if 10.4.0 is published, else none (the tree already says 10.4.0; §20.6). Message the peer with the version. | report files, `package.json`, `packages/cli/package.json`, generated `version.ts` | 6 |

Each phase commits at first green. The migration commit is breaking (L6):
`feat(mcp)!: run team slots as interactive panes in headless magmux` with a `BREAKING CHANGE:` footer naming
Windows' loss of MCP `team`/`create_session` and CLI `team`/`--team`, the removed `SessionInfo.status` key,
`CLAUDISH_TEAM_CAPTURE`, and (r2) the refused print-only `claude_flags` (`--max-turns`, `--max-budget-usd`,
`--fallback-model`, `--json-schema`, `--permission-prompt-tool`). D22 is its own commit:
`fix(recovery): drop the retry watchdog in MCP pane children`. Each F-fix is its own `fix(...)` commit (e.g.
`fix(session): slug every non-alphanumeric cwd character in transcriptPathFor`).

---

## 14. Documentation (NFR6)

| File | Change |
|---|---|
| **`ai-docs/architecture/pane-session.md` (new)** | Why the transcript is the turn oracle and magmux is not; boot from content, named vs unnamed dialogs, "never accept"; the settle rule (`turn_duration` after Stop hooks, the interrupt path with its corpus counts, the Stop-hook gate on the quiet path and the `end_turn → turn_duration` proof of hooklessness, `pendingBackgroundAgentCount`, agents-only balance and why background Bash is not awaited, the measured `secondaryQuietMs` with its number); turn scoping and the witness; degraded mode (per turn, reverting); prompt delivery by kind, line splitting, read coverage, the answer start and exact `require_pattern` semantics, and what prompt-time processing file delivery skips; the env snapshot, the shell shim and the terminal-identity strip; the pane watcher (why a pipe, why outside the pane group, the fd-hygiene gate), process identity by (pid, start time), records, sweep and reap sequence (why `force:true` is not enough); why pane children get no recovery watchdog (D22); socket and id traps (`--sock-dir`, ignored invalid ids, never-reaped `--id` sockets, `MAGMUX_SOCK` must survive); EOF ≠ death; `seq` ownership; D9/D10 bounds; `CLAUDISH_PANE_*` markers; the phase table; F7 latent issue in team-grid |
| `headless-vs-interactive.md` | "A working implementation" points to `pane/` and `scripts/pane-drive.ts`. "Permission prompts" corrected: the controller never produces `awaiting_permission`, and `claudish` panes have no controller. The MCP no longer uses `-p` for children. |
| `team-lifecycle.md` | "One parser, two consumers" / "Team must settle the reducer" → "One driver, two owners". Spawn plumbing: mechanism `pane/`, policy `decide`/`onBlocked`. "Why `run` does not block" amended: it blocks through boot and admission only (≤ 120 s), with the team-gate reason. Liveness from screen frames + transcript. `blocked` rule. Registry by path + retention. `BG_CEILING_RE` removed. **[r-base]** 10.4.0's "The run's record in the sessions directory, ended exactly once" is kept, and its exactly-once argument is restated for `startModels` on panes (registry entry after the loop, `done` last). "A throw inside the spawn loop kills what it already spawned" is rewritten: `cancel()` and `reaped()` on every started pane, the reap's own SIGTERM→SIGKILL on the verified group, status writes suppressed, no `spawnChild`/`terminateGraceMs` seams, no SIGINT handler. "A slot now never reports `waiting_for_input`: … it reads `finishing`" becomes `activity:"finishing"` between the answer and Claude Code's end-of-turn record. The `summarise` paragraph gains the non-terminal states and the CANCELLED row's `error.reason`. |
| `team-capture.md` | Print-mode measurement kept (why `require_pattern` exists). "Recovery" rewritten as turn-scoped transcript concatenation; "wait for background work" now claudish's job. `captureMode`, argv-order and passthrough items and the haiku fixture removed. |
| `mcp-channel.md` | Components and transport rewritten (pane + transcript). 14 tools / 7 channel. `awaiting_permission`. `capture_session`. `send_input` queueing (lines 126–130 rewritten). Diagnostics fields. Testing section (fake child, real magmux, per-test hermetic env). **[r-base]** 10.4.0's sections are handled one by one. "`spawn.json` — the start-time record" is kept verbatim (it is transport-independent). "`waits.jsonl` — the wait log" is kept, with its writer restated: `onTransition`, net of the pump; a wait is AWAITING_INPUT or AWAITING_PERMISSION; a one-shot session writes one only when it stops on a question or permission dialog; a promptless session's first wait opens at boot-ready. "`waiting_for_input` means a real wait" keeps its definition, but the `TurnEnd`/`onResult`/`awaitInput`/`beginTurn`/`finishing` mechanism paragraph is replaced by the pane statement (a one-shot session is terminal at its verdict, so no "answered but exiting" state exists). The session-shape paragraph loses `finishing`. The wire-format event list drops `finishing` and gains `awaiting_permission`. A new paragraph covers `meta.json` as a record (`toMetaRecord`, the 10.4.0 keys, the additive keys) and `events.jsonl`'s assistant lines. |
| `testing.md` | Hermetic pane tests: allowlist env, the "not checked" skip wording, the `ps`/socket/record no-orphan assertion (sockRoot argv, pane pgids, watcher), fixture redaction and its grep test, scaled timing seams |
| `network-recovery.md` **[r2]** | RISK-6's boundary gains the pane-child case: `magmuxPaneCapability` answers `none/pane-child`, so no watchdog, no UI, tier 1 only; the ambient branch now reads the same predicate (F8) |
| `README.md` (architecture index) | New `pane-session.md` row; reworded rows for the four above |
| `CLAUDE.md` pointer list | Add "`pane-session.md` — MCP and CLI team children as interactive Claude Code in headless magmux panes: transcript turn oracle, settle on `turn_duration`, prompt delivery by file with read coverage, boot dialogs, the pane watcher and identity-checked reap, socket traps; read before editing `pane/`, team spawn or channel spawn". Update the `headless-vs-interactive.md` and `mcp-channel.md` lines. |
| `docs/usage/mcp-server.md`, `docs/usage/magmux.md` | magmux ≥ 0.14.0 required for MCP `team`/`create_session` and CLI `team`/`--team`; Windows unsupported for them; `list`/`capture`/`capture_session`; `claude_flags` takes no positional text. **[r-base]** In 10.4.0's text: the `finishing` event row, the one-shot example's `finishing` step and "a session in `finishing` … refuses it" are deleted (`send_input` is accepted in every non-terminal state). The `input_required` row is restated (questions and permission dialogs too). "Session records on disk" is kept: `waits.jsonl` is "interactive sessions, and any session stopped on a question or permission dialog"; `meta.json` is "the final record: `status`, `terminalReason`, exit code, turns, tool calls, cost (null for native routes), plus `state`, `detail`, tokens in/out" rather than "the final `SessionInfo`". |

---

## 15. Risks and live verification (Phase 7)

All runs use the built tree through the real MCP server over JSON-RPC stdio, with `CLAUDISH_BIN` pointing at
the built entry. Each takes a `ps` + listing (`ls /tmp/claudish-mux-$(id -u)/ /tmp/claudish-mux-$(id -u)/panes/
/tmp/magmux-*.sock`) before and after. Evidence goes to `ai-docs/reports/mcp-magmux-panes/`.

| # | Risk | Live verification | Criterion |
|---|---|---|---|
| R1 | Boot classifier misreads the real UI | `team run` with `internal` + one foreign model; a `capture` of each at boot and mid-turn; rows reach COMPLETED with the B fields | V1, V4 |
| R2 | Settle early on a Stop-hook re-wake, or never | V1 on Jack's config (Stop hooks); response = all assistant text vs the transcript; no premature COMPLETED | V1 |
| R3 | Delivery alters the prompt | A 12 KB `input.md` with CRLF lines, tabs, a leading `!`, code fences, a trailing `@x` and **one 5,000-char line** → file delivery; **the transcript's Read results, with line numbers stripped and marked splits joined, reproduce the caller's text** (CR handling as measured in Phase 2), and read coverage is complete; a single-line `/dev:` command stays a slash command (transcript `<command-name>`) | V1 |
| R4 | Large judge prompt | `run-and-judge` whose judge prompt exceeds 100 KB; the judge's Read results cover every line of the file (returned line numbers in the transcript); verdict produced; a forced partial read (a judge prompt telling the model to read only the first page) is FAILED `prompt_not_read` | V1 |
| R5 | Unknown agent | `agent:"zzz-not-real"` → slots FAILED `agent_rejected` with the child's line | V2 |
| R6 | `require_pattern` on the new source | negative → EMPTY `shape_mismatch`; positive → COMPLETED | V3 |
| R7 | `seq`/`unchanged` while idle | `capture` twice on an idle promptless `create_session` → `{unchanged:true}` on the hermetic status line; on Jack's real status line, the observed tick rate is recorded | V4 |
| R8 | Orphans | cancel mid-run (second cancel `changed:false`); a normal finish (no `claudish-pane-watcher` left afterwards); SIGTERM the server mid-run; **close the server's stdin mid-run**; **SIGKILL the server mid-run with 3 slots and confirm the pane watchers remove panes, magmux, sockets, launcher dirs and records within 5 s, with no restart**; `ps` (incl. `pgrep -f claudish-pane-watcher` and any argv under `/tmp/claudish-mux-$(id -u)`) + listings show nothing left, and an unrelated `sleep` started beforehand is still alive | V5 |
| R9 | Transcript saving off | grep every capture for "Transcript saving is off": absent; transcript at the derived path | V6 |
| R10 | Channel parity | prompt → COMPLETED + `get_output`; promptless + `send_input` **sent while STARTING** → answer; `cancel_session`; `list_sessions` rows with B fields and CA-12 keys | V7 |
| R11 | `list` visibility | `team list` while running and after settle: `ACTIVE` → `SETTLED`, `finished_at`, `outcome`, CA-12 keys | V8 |
| R12 | Channel frames | `channel-wire-format.test.ts` green + one traced live frame (`CLAUDISH_CHANNEL_TRACE_FILE`) | V9 |
| R13 | Concurrent `~/.claude.json` writes | 5-slot run with the 300 ms boot stagger (r2 mitigation, X-L8); `jq . ~/.claude.json` before and after | extra |
| R14 | `run` latency | 3 slots: expected 12–20 s; fail the design check above 60 s | extra |
| R15 | First-run dialog on a fresh config | `create_session` with `CLAUDE_CONFIG_DIR=<empty>` → FAILED `first_run_dialog`/`boot_blocked` with the text; no model call | extra |
| R16 | Accounting | foreign: row = token file; native: row = deduplicated main + subagent sum, `cost_usd:null`, cross-checked against `cost-state.modelUsage` at exit | extra |
| R17 | Blocked slots | team prompt that triggers AskUserQuestion → FAILED `blocked` with the question; channel → AWAITING_INPUT, `activity:"AskUserQuestion"`, send → declined + delivered as next prompt | extra |
| R18 | magmux version drift | `capabilities.version ≥ 0.14.0 && protocol === 1`; hermetic stub reporting 0.13 → `magmux_unavailable` | extra |
| R19 | Background agents | a team prompt that launches a background agent and summarises its result: no settle until the notification and final answer; answer contains the summary | extra |
| R20 | Profile clobber | a temporary `~/.zprofile` line exporting a canary over a provider key and `cd /tmp` (restored afterwards): the profile is not sourced (shim), the child's request uses the server's key (token file provider and a 200), Claude Code's Bash tool reports the real `$SHELL`, transcript at the derived path | extra |
| R21 **[r2]** | Stop hooks on Jack's config | a team slot under Jack's real config (magus Stop hooks) whose answer is followed by a Stop hook of ≥ 20 s: no settle before its `stop_hook_summary`/`turn_duration`; `activity:"finishing"` meanwhile | extra |
| R22 **[r2]** | Interrupt via send | `create_session` with a prompt that makes the child ask (AskUserQuestion); `send_input` → transcript shows the rejection + interrupt record; the turn settles `interrupted`; the sent text is answered as turn 2 | extra |
| R23 **[r2]** | Outage in a pane child | a foreign-model slot pointed at an unroutable host: `ps eww` of the pane's claude shows no `CLAUDE_CODE_RETRY_WATCHDOG`; the slot is FAILED `api_error` within the derived tier-1 deadline + one minute; no overlay text in any capture | extra |
| R24 **[r2]** | Background server | a team prompt that starts `python3 -m http.server` with `run_in_background` and answers: the slot settles COMPLETED with `background_shell_open`; the server process is gone after the reap | extra |
| R25 **[r-base]** | Session records still consumed correctly | (1) the ported session-records suites and `channel/session-records.contract.test.ts` green, unmodified in their assertions except the §20.2 deletions. (2) Live, through the built server: one one-shot `create_session` (COMPLETED), one promptless session with a `send_input` then `cancel_session`, and one `team run` of two slots. For each, read `spawn.json` (passes `contract-records.ts` `spawnRecordViolations`; `hostPid` = the host's pid, `mcpPid` = the server's, `claudeSessionId` = the transcript's basename), `waits.jsonl` (`waitPairingViolations` empty; none for the one-shot), `meta.json` (the 10.4.0 keys; `status` matches the row's state) and the team record's `meta.json` (`ok`/`failed`/`cancelled` match `summarise(status.json)`). (3) Run the magus monitor itself (`bun --env-file=/dev/null plugins/claudish/scripts/session-monitor.ts` with `CLAUDE_PID=<host pid>` and the same sessions directory) across those runs, and keep its stdout: `started`, `needs-input` for the promptless wait, `completed turns=1 tools=…` for the one-shot, `cancelled`, and `team … completed ok=2`; no `unrecognised-status`, no `claudish-too-old` | extra |

Pass threshold unchanged from `validation-criteria.md`: all of V1–V9, or a documented skip.

---

## 16. Assumptions and open questions

**Assumptions** (taken because the prompt was silent):

1. `--quiet` on the pane argv is acceptable: it suppresses the logo and claudish's update **prompt**
   (`update-prompt.ts:75`), which would block boot in a pane with a TTY.
2. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` for pane children is acceptable (print-mode rationale; an
   explicit user value wins).
3. In a live interactive REPL, Claude Code writes `system/turn_duration` for every foreground turn that ends
   without a re-wake or a plain interrupt (research §1.7 and the r2 corpus counts in §2.7–2.8). Phase 2's
   ending matrix confirms it per ending, with and without Stop hooks; an ending that lacks it gets a named path
   (as interrupts did), and the Stop-hook-gated quiet path is only the safety net.
6. **[r2]** `stop_hook_summary` is written only when Stop hooks exist (every corpus instance has
   `hookCount ≥ 1`), and Stop hooks do not run after an API-error or interrupted turn (no corpus
   `turn_duration` follows an `end_turn` without a summary in a session that has hooks). Phase 2 re-checks
   both on 2.1.287.
7. **[r2]** The Bun runtime the MCP server uses creates child stdio pipes close-on-exec, so only the owner
   holds a watcher's write end. Gated in Phase 3 with a fallback (§2.3).
8. **[r-base]** `feat/session-records` merges to main and is tagged v10.4.0 from its own merge commit before
   this migration's Phase 7 (§20.6). If it has not been tagged by then, it is not tagged separately and the
   combined tree ships as 10.4.0.
9. **[r-base]** The magus monitor (`plugins/claudish/scripts/session-monitor.ts`, read for this revision) is the
   only reader of the records outside claudish. It reads `spawn.json`, `waits.jsonl`, `events.jsonl` (assistant
   message ids), `tokens.json`, the team's `<teamPath>/status.json` (`state`, `error.reason`) and both
   `meta.json` kinds.
4. `pane` handles and `seq` are meaningful within one server process only.
5. The CLI `team`/`--team` migration is within scope because they share `runModels` and FR8 deletes the
   `-p` spawn path they used; the out-of-scope CLI item is `--grid` only.

**Open questions for the caller or the peer:**

1. Should the dev plugin's team-gate predicate become "every slot terminal" instead of `!== RUNNING`? D9 hides
   STARTING and D19 removes long-lived AWAITING_* on team slots, so `!== RUNNING` is now equivalent; the
   change would only be defensive.
2. Pre-seeding the API-key dialog answer (M19) is parked in `ROADMAP.md`; the peer may want it sooner for
   fresh machines.
3. Should `team` gain a `send` mode so a blocked slot can be answered instead of failing `blocked`? Not in v1;
   the `blocked` reason keeps the door open without a contract change.
4. **[r-base]** For the monitor's owner: should its team heartbeat count every non-terminal `SlotState`
   (`STARTING`, `AWAITING_INPUT`, `AWAITING_PERMISSION`) as running, not only `RUNNING`/`PENDING`? Not a
   blocker. STARTING lasts at most 120 s (D9), while the first heartbeat comes 5 minutes after `started`. A team
   row never holds AWAITING_*: `onBlocked` decides in the same step, so the row goes RUNNING → FAILED (§20.1).
   Today a STARTING row would read as `failed` in the heartbeat only.

---

## 17. Revision log (plan review 1)

**CRITICAL**

| Finding | Resolution | Section |
|---|---|---|
| C1 premature settle (Stop hooks, background agents) | Settle on `turn_duration` after the turn's last assistant message with `pendingBackgroundAgentCount === 0`, background balance closed, screen corroboration on both paths; measured secondary quiet; `bg_rewake`/`slow_stop_hook`/20 s `rewake` scenarios; R19 | D14, §2.8, §12.2, §15 |
| C2 NFR1 no-orphan gaps | Launcher owner-watcher (SIGKILL-proof), pane records + identity-validated sweep, stdin EOF/transport close/signal hooks, parallel ≤ 3 s shutdown reap, synchronous `exit` SIGKILL hook, verified reap before record deletion; R8 adds stdin close and SIGKILL without restart. *Superseded in r2 (X-C1): the launcher watcher and the `exit`-hook group kill are replaced by the pane watcher, §18.* | D15, §2.3, §2.10, §2.11, §12.3, §15 |
| C3 exit-0 exception reuses earlier turn evidence; §2.2/§5 disagree | Turn-scoped evidence; pane exit decided against the current turn only; `exit_clean` legal only from IDLE; table and §5 aligned; `turn2_exit0`/`idle_exit` tests | §2.2, §2.7, §5, §12.2 |
| C4 degraded oracle misses missing/empty transcript | `availability` absent/empty/off; degraded acceptance and settle without `isWorking`; errors from the upstream error log or screen error rows; scenarios for each | §2.7, §2.8, §12.2 |

**HIGH**

| Finding | Resolution | Section |
|---|---|---|
| H1 socket EOF → `pane_lost` | EOF ≠ death; reconnect while the magmux process lives (backoff, `list` for a missed exit, re-`watch`, seq continues); `pane_lost` only on magmux process exit; follower keeps running; subscriber-drop test | D6, §2.4, §2.9, §4.3, §5, §12.3 |
| H2 stop-reason totality | Settle keyed on `turn_duration`, not on `stop_reason`; every non-continuing stop reason (incl. `null`) settles; `refusal` → EMPTY `refused`, `max_tokens` noted; Phase 2 captures the shapes | D14, §2.8, §6.2 |
| H3 transient AWAITING_INPUT before acceptance | Phase table: BOOTING → ADMITTING (both STARTING) for prompted sessions | D7, §2.2, §3.4, §5, §8 |
| H4 `run`/`ready` unbounded after boot | 30 s admission bound → FAILED `prompt_not_accepted` (turn 1) or IDLE + `send_rejected` (later); resend handles menus; no paste placeholder exists; D9 bound 120 s | D9, D10, §2.9, §5 |
| H5 typed delivery alters prompts | Delivery by kind: plain/slash typed single line, everything else byte-exact by turn file; no ctrl-j, CR, tab, `!` or menu exposure; judge size note; R3/R4 | D13, §2.13, §9.3, §15 |
| H6 non-MCP `runModels` consumers | `team-cli.ts` and `--team` in Phase 4; shutdown hooks installed by `startPaneSession`; `team-cli-signal.test.ts`; BREAKING CLI note | §2.11, §6.3, §9.7, §13 |
| H7 AWAITING_* detection deferred | Question from the transcript alone; permission markers named now and gated in Phase 2; no silence inference; team policy needs only the transcript case | §2.6, §2.9, §13 |
| H8 login-shell clobbers env | `CLAUDISH_PANE_ENV` snapshot re-applied in the child (never on disk); `cd` in the launcher; `env_probe` test; R20 | D16, §2.3, §2.14, §15 |
| H9 promptless sessions ignore API errors | API-error turn → FAILED `api_error` for every shape | D20, §5, §7 |
| H10 admission/offset not atomic | Serial pump; synchronous `admit`; pre-delivery offset (single invariant); exact witness; question answers via Esc, not as turns; `immediate_write`/concurrent-send tests | D17, §2.7, §2.9 |
| H11 hermetic isolation via outer guards | `makePaneTestEnv` allowlist env per test, `assertHermetic`, hostile-inheritance test, named magmux-spawning files, skip wording, CI magmux pinned | §12.1 |
| H12 auto-compaction splits the turn | Turns segmented by our deliveries; `isCompactSummary` never ends a turn; compacted fixture + scenario | §2.7, §12.2 |
| UG1 `-p` injection through `claude_flags` | Positional/`--` refusal with claudish's own rule (walker ≡ `parseArgs` test); child-side interactive assertion; explicit `-i` | D18, §2.3, §2.14 |
| UG2 unreserved `--bg` | `--bg`, `--background` reserved, with `-w`, `--from-pr`, `--teleport`, `--fork-session`, `--no-session-persistence` | §2.3 |

**MEDIUM** (one line each)

- M1 `send_input` regression → queued in every non-terminal state; Esc + next prompt during a dialog (D17, §4.2).
- M2 unlisted dialog → `boot_blocked` with the screen text after 5 s static (§2.6).
- M3 idle screen changes → quiet measured above the input box; `seq` stays honest (§2.5, R7).
- M4 prompt size ceiling → file delivery has none (§2.13).
- M5 exit after settle discarded → exit path runs `decide()` on current-turn evidence (§2.2).
- M6 subagent usage → included, deduplicated by `message.id` (§2.7).
- M7 live run used the installed claudish → `CLAUDISH_BIN=<built entry>` + version evidence (§13 Phase 7, §15).
- M8 derived path vs child cwd → launcher `cd`, child chdir check, `-w`/`--from-pr`/`--teleport` reserved (§2.3, §2.14).
- M9 fake fidelity → key semantics from the Phase 2 keylog; added scenarios (§12.2).
- M10 blocked team slots hold panes → FAILED `blocked` at once (D19).
- M11 provider precedence → code-shaped order + disjointness test (§2.12).
- M12 `seq:0` ambiguity → 0 only before the first frame (§2.5, §8 D).
- M13 slash commands never accepted → `command` witness, local-command records, `/exit` control path, `/clear` refused (§2.7, §2.9, §2.13).
- M14 PTY ceiling → `MAX_LIVE_PANES = 48`, `pane_limit` (§2.11).
- M15 error envelope → verb-by-verb table; every §8 verb returns JSON `ContractError` (§4.3, §8 E).
- M16 style/alt changes → metadata always applied; seq bumps on spans/alt (§2.5).
- M17 memory-only polling → accounting refreshed on the 2 s tick; one documented disk exception (§2.12, §8).
- M18 kept suites lose `fake-claudish` → consumer table (§10).
- M19 placeholder key triggers dialog 4 → frequency stated; pre-seed parked in ROADMAP (§11).
- M20 `!isWorking` dependency → `isWorking` is veto-only; no rule requires it (§2.6, §2.8).

**LOW**: L1 `TeamRunRow.state` → `ACTIVE`/`SETTLED`; L2 `pane` informational; L3 `{runs}` amendment and
`since_seq !== seq` → full capture; L4 `lstat`, owner start time in id and record, parallel shutdown; L5
`turns_completed` = settled prompts; L6 `feat(mcp)!` + footer; L7 "fallback" replaced by "degraded screen
source"/"backstop"; L8 `exit.lastLine` + scrollback capture; L9 version/protocol check + pinned bundle; L10 F1
window re-derivation; L11 `live_output_bytes_by_slot` from `liveAnswerBytes`; L12 dangling "R4" in D13
removed; L13 unknown persisted states → FAILED; L14 screen answer filters tool/spinner/token rows; L15 NFR6 doc
plan (§14) and `findMagmuxBinary` named (§2.3).

**Contract**: CA-12 merged (`contract_version`, `capabilities` on A and B answers; pre-contract detection text).

---

## 18. Revision log (plan review 2)

Evidence gathered for this revision (read-only, local corpus of 3,083 transcripts under `~/.claude/projects`):
interrupt records and what follows them (§2.8 path I); `stop_hook_summary` vs `turn_duration` ordering and the
279 summary-less `turn_duration`s in hooked sessions (§2.7 `SessionFacts`); `recovery/settings.ts`,
`launcher/magmux-wrapper.ts:175-200` and `claude-runner.ts:1645-1657, 1988, 2022` for D22; research-magmux §4
for magmux's lifetime after a server SIGKILL (§9.5).

**CRITICAL**

| Finding | Resolution | Section |
|---|---|---|
| X-C1 owner watcher outlives every clean reap; signals a stale magmux pid; `exit` hook signals unvalidated | The launcher watcher is gone. A **server-spawned pipe watcher** per pane (detached `/bin/sh`, own session, never in the pane group): EOF on its stdin pipe — the owner ended by any means, SIGKILL included — makes it kill the pane's magmux and group, each only after re-verification (magmux by its unique `--id <paneId> --sock-dir` argv; the group by a recorded (pid, `lstart`) member still in that pgid), then remove socket, launcher dir and record. A clean reap ends it with `done` after verification, then through its own `ChildProcess` handle. No `$PPID`, no bare pid; the server signals only its own children through handles, and groups after the group check. The synchronous `exit`-hook group kill is removed (the watcher covers `process.exit` too). One `process-identity.ts` shared by reap, sweep and the generated watcher shell. Records written with `magmuxPid:null` first; cross-owner pane counting; a pane stops counting when its reap finishes, and failed-reap records never count. No-orphan assertion now covers sockRoot argv, pane pgids and the watcher; owner-SIGKILL test with two panes; decoy pid never signalled; Phase 3 fd-hygiene gate with a polling fallback. NFR1 after a server SIGKILL with no restart: magmux would otherwise live on (detached, research-magmux §4 `e2` f), so the watcher is required, and R8 measures it live | D15, §1.2, §2.3 (watcher, order), §2.10, §2.11, §9.5, §12.3, §13 Phase 3, §15 R8, §16 #7 |

**HIGH**

| Finding | Resolution | Section |
|---|---|---|
| X-H1 pane children inherit the ~300-attempt watchdog | D22: `magmuxPaneCapability()` → `none/pane-child` first; the ambient branch reads the same predicate (F8). No watchdog (an inherited claudish-marked one is deleted), no recovery UI, no overlay. Tier 1's bounded hold (derived deadline, 270 s default), then an inline 400 → FAILED `api_error`; the row reads RUNNING `thinking` meanwhile. Test + R23; `network-recovery.md` updated | D22, §2.9 activity, §2.14, §11 F8, §12.4, §13 Phase 1, §14, §15 R23 |
| X-H2 secondary settle ends a slow Stop hook | Path S requires Stop hooks known finished: a `stop_hook_summary` after the last message, or `provenHookless` (an `end_turn → turn_duration` pair; corpus: never seen in a hooked session), or an API-error ending (hooks do not run after one). A running hook satisfies no path; `activity:"finishing"` meanwhile. Window re-based on the summary → next-append gap. Phase 2 ending matrix with and without a Stop hook, plus the Stop-hook screen. Scenarios `slow_stop_hook`, `quiet_no_summary`, `hookless_quiet`; R21 | D14, §2.7 `SessionFacts`, §2.8, §8 activity [amended r2], §12.2, §13 Phase 2, §15 R21, §16 #6 |
| X-H3 Esc-interrupted turn cannot settle | Path I: a `[Request interrupted by user…]` record after the last message (or the rejection `tool_result`) settles with `stopReason:"interrupted"`, `settledBy:"interrupt"`, no `turn_duration` required. Corpus: 91 of 127 tool-use interrupts have one, 36 do not; 0 of 254 plain interrupts do. The pump then delivers the queued text; `escape_not_effective` if no interrupt appears. Scenarios `ask_user_send`, `interrupt_td`; R22 | D14, D17, §2.7, §2.8, §2.9 step 7, §5, §12.2, §15 R22 |
| X-H4 pre-Read narration enters the answer and `require_pattern` | The answer of a file-delivered turn is the assistant text after the Read `tool_result` that completed coverage; earlier text is `preambleBytes` (diagnostics). `require_pattern` semantics stated exactly: `new RegExp(pattern)`, no flags, `.test()` on the `"\n\n"`-joined answer, `^`/`$` anchor the whole answer. Scenario `narrate_then_read`; anchored-pattern unit cases | D13, §2.7, §2.13, §6.2, §12.2, §12.4 |
| X-H5 file delivery not byte-exact (long lines, partial reads) | Lines over the measured `READ_LINE_LIMIT` are split at whitespace with a stated, reversible marker (alternate on collision); coverage of every line is computed from the line numbers Read actually returned; incomplete → FAILED `prompt_not_read` (team, one-shot; interactive: anomaly + `meta.prompt_not_read`). The fake goes through templated Read records and hashes its reconstruction. R3/R4 restated on Read results | D13, §2.1, §2.7, §2.13, §6.2, §8 FailureReason [amended r2], §12.2, §15 R3/R4 |
| X-H6 background Bash keeps the balance open forever | D23: only background agents are awaited (Claude Code's own `pendingBackgroundAgentCount` semantics); a background Bash either notifies before settle (part of the turn) or is reported `background_shell_open` and ended by the reap. No timer involved. Interactive sessions get `rewake` (IDLE → RUNNING) when a later notification wakes the model. Scenario `bg_server`; R24; §9.7 trade-off | D23, §2.2, §2.7, §2.8, §5, §9.2, §9.7, §12.2, §15 R24 |
| X-H7 degraded mode irreversible; slow UserPromptSubmit hook | Degraded mode is per turn, keeps following the transcript and reverts on a late witness (`degraded_reverted`), with a final poll before any screen settle; the pure-quiet screen settle applies only when saving is `off`, otherwise an answer row is required. Scenario `slow_prompt_hook`; Phase 2 capture | §2.8 degraded mode, §2.9 step 5, §12.2, §13 Phase 2 |

**MEDIUM and LOW** (one line each)

| Finding | Resolution | Section |
|---|---|---|
| X-M1 promptless first send → STARTING, fatal | `wireState` and `admit_deadline` keyed on `initialDelivery`, not the turn index; the first send goes AWAITING_INPUT → RUNNING, non-acceptance → IDLE `send_rejected` | D7, §2.2, §2.9, §3.4, §5, §8 STARTING [amended r2] |
| X-M2 CA-13 not deliverable by the registry | Registry keyed by `run_id` + newest-by-path index; `runId?` on every addressing function; `run_id` addresses any retained run; superseded-run `status` omits legacy keys; ACTIVE-path refusal is `run`'s `Error: invalid_args: …` text | §3.2, §4.1, §6.1, §8 A [amended r2], §12.3 |
| X-M3 print-only flags silently ignored | Reserved with a refusal naming the loss; BREAKING footer, §9.7 | D18, §2.3, §9.7, §13 |
| X-M4 nothing detects an unread task file | Read-coverage check → FAILED `prompt_not_read`, covering agents without Read and tool-less models without parsing agent files | §2.3 rule 4, §2.13, §6.2 |
| X-M5 file delivery skips prompt-time processing | Differences listed (thinking keywords, `@path`, content-routing UserPromptSubmit hooks, `$ARGUMENTS` splitting) and recorded in `pane-session.md` | §2.13, §9.3, §14 |
| X-M6 hermetic suite never runs the real child claudish | New `pane-child-real-claudish.integration.test.ts`: real entry + fake `claude` via `CLAUDE_PATH`; asserts overlay, marker strip, no watchdog, snapshot, refusal | §12.1, §12.2 |
| X-M7 test seams and real-time lengths unspecified | `timings` (`@internal`) seams; fake gaps from env; ordering kept at scaled time; one production-constant test per window; explicit per-test timeouts | §2.9, §12.1, §12.2 |
| X-M8 real transcripts in tracked fixtures | Synthetic Phase 2 captures first; structure-preserving redaction script for corpus records; fixture grep test | §12.1 |
| X-M9 hermetic env never reaches owner-spawned panes | `parentEnv` on `TeamRunOptions`, `SessionManagerOptions`, `SessionCreateOptions`; `projectsDir(parentEnv)` | §6.1, §7, §11 F2 |
| X-M10 interactive pane exit after a settled turn has no event | `"continue"` on the exit path → `turn_continue`, then the IDLE exit rules | §2.2, §5, §12.2 |
| X-M11 exit before `turn_duration` discards the answer | Path X: an ending `stop_reason` with no waking record after it settles on exit (`settledBy:"exit"`); `exit_before_td` scenario | §2.2, §2.8, §12.2 |
| X-M12 settle needs a live screen while disconnected; reconnect has no exit | P and I settle transcript-only with `screen_unverified`; pane death while disconnected → exit path, code `null`; `socket_lost` after 20 ENOENT dials; anomalies deduplicated and capped | §2.8, §2.9 Reconnect |
| X-M13 contract says a question waits for text | §8 AWAITING_INPUT/AWAITING_PERMISSION state that a send declines and interrupts | D17, §8 [amended r2] |
| X-M14 "empty input box" undefined | Placeholder cells (dim attribute, or the measured placeholder colour) excluded; Phase 2 idle-suggestion and placeholder captures gated; `idle_suggestion` scenario | §2.6, §12.2, §13 |
| X-M15 login profile still runs | `SHELL` shim drops `-l` and execs `/bin/sh -c`; the snapshot restores the real `SHELL`; `PATH` line removed | D16, §2.3, §12.2, §15 R20 |
| X-M16 terminal-identity variables reach the TUI | `TERMINAL_IDENTITY_VARS` stripped from env and snapshot; Phase 2 captures use the same env | D16, §2.3, §12.3 |
| X-L1 slash first line unbounded; a menu can pick another command | 512-char cap (rest via file pointer); typed with `enter:false`, menu closed unless it shows the typed command; a mismatched witness never accepts | §2.9 step 4, §2.13 |
| X-L2 claudish mode flags not reserved | Reserved; child assertion adds `!config.team` (`-v` stays: it is `--verbose`) | D18, §2.3 |
| X-L3 `SlotRow.reason` "always set on FAILED" | Field comment states the legacy-disk exception | §8 [amended r2] |
| X-L4 record cannot hold `magmuxPid` at write time | Written with `magmuxPid:null`, updated right after spawn; the sweep falls back to the socket probe / `pgrep` | §2.3 order, §2.11 |
| X-L5 `team(status)` reads disk per poll | Live runs answer from the in-memory status object; disk only for runs not in the registry | §2.12, §3.2 |
| X-L6 Phase 2 capture driver unnamed | `scripts/magmux-drive-session.ts`, deleted in Phase 3 | §13 |
| X-L7 `capture` for a never-spawned slot | `seq:0`, 160×50 blank, `final:true` | §6.1, §8 D [amended r2] |
| X-L8 concurrent `~/.claude.json` writes | 300 ms boot stagger per run; R13 still measures | §2.3, §6.1, §15 R13 |
| X-L9 `pane_limit` envelope contradiction | Text envelope for `create_session` and `run`; `magmux_unavailable`/`pane_limit` dropped from `ContractError.code` | §2.11, §8 E [amended r2] |
| X-L10 two wording contradictions | COMPLETED covers an unrequested exit 0 after a settled turn; D10 qualified to team slots | D10, §8 [amended r2] |
| X-L11 `MAX_LIVE_PANES` per process | Counted across owners from the pane records | D2, §2.11 |
| X-L12 Phase 2 gate has no skip rule | `refusal` via the Gemini content_filter mapping; otherwise a documented skip backed by a redacted corpus record | §13 Phase 2 |
| X-L13 `CLAUDISH_PANE_ENV` one string over Linux's limit | Bound stated; pre-spawn error naming the size | §2.3 |

**Contract**: §8 stays paste-ready. r2 changes, each marked **[amended r2]**: `prompt_not_read` added to
`FailureReason` and to the FAILED description; `activity` gains `"finishing"`; STARTING, AWAITING_INPUT,
AWAITING_PERMISSION and COMPLETED wording; the `SlotRow.reason` legacy exception; `run_id` addresses any
retained run and the ACTIVE-path refusal's envelope is named; the never-spawned capture; `ContractError.code`
loses two codes no §8 verb emits; `meta.prompt_not_read`. CA-12 and CA-13 remain merged.

---

## 19. Binding implementation constraints (plan review 3)

Round 3 (verification) returned CONDITIONAL: every round-2 CRITICAL/HIGH resolved, no new CRITICAL, one new
HIGH and five MEDIUMs. Each is adopted below as a constraint the implementation MUST follow; Phase 5 code
review checks them by id.

| Id | Constraint |
|---|---|
| R3-H1 | `hasChoiceDialog` is a **closed list**: it is true only when ALL hold — (a) a **named** dialog header from the §2.6 list is on screen, (b) **no input box** is on screen, (c) the option rows sit below the last `⏺` block. An unrecognised layout is "not a dialog" (stay RUNNING, honest unknown), never `blocked`. `screen-classifier.test.ts` gains NEGATIVE fixtures: a running Bash under numbered prose containing a "No…" line, and the `(esc to interrupt)` spinner row; the fake child gains a `tool_slow_numbered` scenario asserting the slot is not blocked. |
| R3-M1 | The watcher's stdin has an `'error'` handler; EPIPE on `done\n` means "watcher already gone" and is not an error. A magmux spawn failure runs a "spawn failed" reap (write `done`, delete record and launcher dir); a test injects a spawn failure and asserts `livePaneCount() === 0` and no watcher process remains. |
| R3-M2 | Split directories: `turn-<n>.md` alone in the `--add-dir` turn directory; `group`, `magmux.pid`, `sh-shim`, `pane-launch.sh` in a sibling control directory the model is never pointed at. Before any `rm`, both TypeScript and the generated shell validate the path is a direct child of `SOCK_ROOT` matching `launch-[A-Za-z0-9]{6}` (and sockets match `magmux-<paneId>.sock`). |
| R3-M3 | Read coverage compares `realpath(file_path)`; it parses `toolUseResult.file` (`startLine`, `numLines`, `totalLines`, `content`) and compares returned line TEXT with the file, not only line numbers. A command turn that delegates the read to a subagent counts `subagents/*.jsonl` Reads, else records the `read_coverage_unverified` anomaly (not FAILED). Phase 2 captures a Read of a file with a line longer than `READ_LINE_LIMIT` and checks whether large Read results spill to `<uuid>/tool-results/*.txt`. |
| R3-M4 | Each slot records the child's Claude Code version. When a turn sits in `finishing` with a static screen and no Stop-hook UI for N × `secondaryQuietMs`, `status` adds the anomaly `turn_end_record_missing` (in `activity_by_slot`, the row's `activity`, and the team note telling the caller to cancel). No timer ends the slot (D10 holds). |
| R3-M5 | When `backgroundShellsOpen` is non-empty at settle, `background_shell_open: <command>` goes into the team slot `detail` and the result card, not only the anomalies. No wait carve-out. |


---

## 20. Rebase onto `feat/session-records` (delta)

**What was read.** `git log 302a045b..cf4f7835` (11 commits) and the diffs of `channel/session-manager.ts`,
`channel/stream-json-reducer.ts`, `channel/types.ts`, `mcp-server.ts`, `team-orchestrator.ts`,
`bin/claudish.cjs`, the new `channel/home-dir.ts` and `channel/parent-proof.ts`, `ai-docs/architecture/
mcp-channel.md`, `team-lifecycle.md` and `docs/usage/mcp-server.md`. Also every new `*.contract.test.ts`, the
four `test-helpers/contract-*.ts` files, and the consumer itself: the magus monitor
(`plugins/claudish/scripts/session-monitor.ts`, `MIN_CLAUDISH_VERSION = "10.4.0"`). The monitor's readers
decide what "byte-compatible" means here. It reads:

- `spawn.json`, in full;
- `waits.jsonl`: `wait`, `since`, `turns`, `at`, `to`;
- the session `meta.json`: `status` (an unknown value reads as `failed`, reason `unrecognised-status`),
  `terminalReason`, `elapsedSeconds`, `turnsCompleted`, `toolCallCount`, `costUsd`, `exitCode`;
- the team `meta.json`: `status`, `reason`, `slots`, `ok`, `failed`, `cancelled`;
- `events.jsonl`: the distinct `message.id` of lines with `type:"assistant"`, its `replies` count;
- `tokens.json`: `total_cost`, `tool_calls[].count`;
- `<teamPath>/status.json`: `models[*].state` and `error.reason`.

### 20.1 What the records give us, and how panes produce them

The records answer a question the pane design left open: how an observer **outside** this server learns, in
the right Claude Code window, that a run started, is waiting for input, and ended. §8 answers it only for a
caller polling this server's memory. Panes therefore build nothing parallel (no second start record, no pane-
side wait log). They feed the existing writers from the pane state machine (D24).

**Who writes each record, now that the reducer is deleted.**

| Record | 10.4.0 writer and trigger | Pane writer and trigger | Output |
|---|---|---|---|
| session `spawn.json` | `SessionManager.createSession` → `writeSpawnRecord`, after `prompt.md`, before `spawn()`, atomic, not in a `try` | the same call, before `startPaneSession` (§4.2, §7) | unchanged; `claudeSessionId` is the pane's `--session-id` uuid (the transcript's basename) |
| team `spawn.json` | `recordTeamRun` in the `team(run)` handler, before `startModels` | the same, after the pre-spawn refusals and `setupSession` (§4.1) | unchanged |
| `waits.jsonl` | `recordWaitTransition` in the reducer's state callback, before the channel notification | `recordWaitTransition` in `PaneSession.onTransition` (§2.9), before the channel frame | unchanged lines, limits and append rule; what opens a wait: below |
| session `meta.json` | `writeArtifacts(SessionInfo)` at the end of `finalize` | `writeArtifacts(toMetaRecord(info))` on the terminal transition, before the reap starts | every 10.4.0 key, same name and meaning, plus additive keys |
| team `meta.json` | `finishTeamRun` from `onSettled` (in `done`'s `finally`) or from the handler's `catch` (`start-failed`) | the same; `done` resolves when every slot is terminal, i.e. when `TeamRunRow.state` turns SETTLED | unchanged |
| `events.jsonl` | the reducer's `onLine`: every stream-json line except deltas, verbatim | `SessionManager`: `state`/`tool`/`anomaly` records, plus `{type:"assistant",message:{id},at}` once per new main-chain message id the follower sees | the monitor's reply count is unchanged; message content is no longer copied (the transcript holds it) |
| `tokens.json` | the child's proxy | the same | unchanged |
| team `status.json` | `updateModelStatus` | the same | nine-value `state`; CANCELLED rows carry `error.reason:"cancelled"` (§3.1) |

The reducer was the clock of every state record: each `transition()` called back, and the callback wrote the
wait line before anyone was notified. The pane equivalent is the phase table inside `PaneSession`, and
`onTransition` is its callback: synchronous, every wire change, never coalesced, called before `onChange` and
therefore before any frame. It reports the net change of one event-processing step. A turn that settles with
an item queued (RUNNING → IDLE → ADMITTING in one step) therefore reports no transition and opens no wait,
which keeps 10.4.0's "a wait is real" rule. `onBlocked` runs inside the same step, so a team slot that hits a
question goes RUNNING → FAILED `blocked` as one net transition: like 10.4.0's slots, it never reports
`waiting_for_input`.

**The records mapped onto `PaneSession` and §8 B.**

| Record field | Source |
|---|---|
| wait opens | the wire state enters AWAITING_INPUT or AWAITING_PERMISSION (phases IDLE, QUESTION, PERMISSION), net of the pump |
| `open.turns` | `snapshot.turnsCompleted` = §8 B `turns_completed` (settled prompts; a re-wake does not add one) |
| wait closes | the wire state leaves both; `closed.to` = `channelEventFor(snapshot).event` of the new state: `running`, `tool_executing`, `completed`, `failed`, `cancelled` or `timeout`. Never `waiting_for_input`, because the phase table has no QUESTION ↔ PERMISSION or IDLE ↔ PERMISSION edge, so a wait never turns into another wait |
| `meta.status` | the terminal state through §3.4: COMPLETED → `completed`; FAILED, EMPTY → `failed`; CANCELLED → `cancelled`; TIMEOUT → `timeout` |
| `meta.terminalReason` | §8 B `reason` (a `FailureReason`), `null` on COMPLETED. The monitor prints it as `reason=` on a failure: `agent_rejected`, `shape_mismatch`, … |
| `meta.turnsCompleted`, `.toolCallCount`, `.costUsd`, `.exitCode`, `.elapsedSeconds` | `turns_completed`, `tool_calls`, `cost_usd`, `snapshot.exitCode`, elapsed |
| `meta.pid`, `meta.tokensUsed` | `panePid`; `tokens_in + tokens_out` (0 when neither is known) |
| `meta` additive keys | `state` (tells EMPTY from FAILED), `detail`, `tokensIn`, `tokensOut`, `lastActivityAt` (= §8 B `last_activity_at`, which no 10.4.0 record carried), `shape`, `pane`, `captureSource`, `turnSource` |
| team `meta` counts | `summarise(status)` when the run turns SETTLED |
| `activity: "finishing"` | no record field. It is the §8 activity for "the model's message ended; Claude Code's end-of-turn record has not arrived" (§2.8), and it is what 10.4.0's `finishing` meant to a team observer (§20.3 item 5) |

`SessionInfo` keys that would repeat a pinned key (`toolCalls`, `reason`, `panePid`) are written only under the
pinned name, so `meta.json` never carries two names for one fact.

**Kept exactly as 10.4.0 has them**:

- the file names, the sessions-directory rule (`sessionsDirFrom`) and the `team-<8 hex>` ids;
- `spawn.json` schema 1 for both kinds, field for field, written atomically, one key per line, before
  every runtime file and before any pane;
- the team `meta.json` shape and its first-successful-write-wins end;
- the `waits.jsonl` line shapes, the "< 200 bytes" rule, the 1 MB stop and "a write failure loses one line";
- `parentClaudeSessionId` present exactly when proven, in both files;
- the disk reader's refusal of `kind:"team"` ids;
- `normaliseTimeoutSeconds`;
- `prompt.md` before `spawn.json`.

**Deliberate changes, each with its reason** (RB = rebase):

| # | Change | Reason |
|---|---|---|
| RB1 | The channel event `finishing` is not emitted and leaves `ChannelEventType`, `EVENT_TO_TASK_STATUS` and `INSTRUCTIONS` | No record carries it (it appears in frames and `get_diagnostics` only), and a pane session has no state with its guarantees (§20.3 item 5). It never shipped (10.4.0 is untagged) |
| RB2 | A promptless session's first wait opens at boot-ready (STARTING → AWAITING_INPUT), not at creation | §8 keeps STARTING for boot. Before boot-ready a send is queued (D17), not answered, so the session is not idle at a prompt. `since` moves by the boot time (≈ 11 s) |
| RB3 | A wait also opens on AWAITING_PERMISSION, and on a question in any shape, so a one-shot session writes `waits.jsonl` when, and only when, it stops on a question or permission dialog | `-p` could produce neither, so 10.4.0's "a one-shot session never writes one" followed from the transport, not from a rule. In both cases the right action is `send_input`, which is what the monitor's `needs-input` line tells the caller |
| RB4 | `meta.costUsd` is `null` for native routes; `meta.terminalReason` is a `FailureReason` (or `null`) instead of Claude Code's `terminal_reason` text; `meta.exitCode` is `null` when claudish ended the pane (verdict reap, cancel, timeout) | D12 (no fictional spend; the monitor drops a `null` cost). The reason vocabulary is §8's. A pane's exit code exists only if the child exits on its own |
| RB5 | `events.jsonl` no longer holds verbatim stream-json; its `assistant` lines are `{type, message:{id}, at}` only | There is no stream-json any more. The monitor reads exactly `type` and `message.id`, and copying message content into a second file would duplicate private text the transcript already holds |
| RB6 | Team `status.json` `state` is the nine-value set: PENDING is gone; STARTING, AWAITING_*, CANCELLED are new; CANCELLED rows carry `error.reason:"cancelled"` | §3.1. The monitor's heartbeat classifies cancelled rows by `error.reason`, and it does so correctly. STARTING would read `failed` in a heartbeat but cannot reach one (≤ 120 s, against the first heartbeat at 5 min); §16 open question 4 asks the monitor's owner to count it as running anyway |
| RB7 | `get_diagnostics` reports `event` and `state`, not 10.4.0's `status` | `SessionStatus` is deleted (§3.3). `get_diagnostics` is not a record; only the contract adapter read the key |
| RB8 | A failed team start stops its slots by pane reap (≤ ≈ 12 s, SIGTERM then SIGKILL on the verified group), not by `terminateChildTree` with a 5 s grace; the started slots' `status.json` rows stay `STARTING` (10.4.0 left them `RUNNING`) | §20.3 item 2 |

### 20.2 Fate of each session-records artifact

**Source.**

| Artifact | Fate | Why |
|---|---|---|
| `channel/home-dir.ts` (`userHomeFrom`, `sessionsDirFrom`) | keep | Shared with the monitor; transport-independent. `claudeConfigDir` builds on it, and so does F2 now |
| `channel/parent-proof.ts` (`hostPidFrom`, `proveParentForCall`, `claudeConfigDir`, `projectDirNameFor`, …) | keep; F1 and F2 reuse two of its functions (§11) | Proves the calling conversation from Claude Code's own transcript; nothing in it touches the child transport |
| `bin/claudish.cjs` launcher pid pair; `ToolCallContext.toolUseId`; `proveParentForCall` calls in `create_session`/`team(run)` | keep | Same |
| `SessionManager` record writers (`writeSpawnRecord`, `writeJsonAtomic`, `recordTeamRun`, `finishTeamRun`, `appendWait`, `recordWaitTransition`, `normaliseTimeoutSeconds`, `hostPid` option and getters, the `kind:"team"` refusal in `loadDiskRecord`) | keep; `recordWaitTransition` re-hooked to `onTransition`; `writeArtifacts` gains `toMetaRecord` | §20.1 |
| `handleResult` → `TurnEnd`, `openFirstTurn`, `KNOWN_STATUSES` | delete with the reducer | Their job (stdin open or closed at a turn end, the promptless first wait) is the phase table's: `decide()` and `boot_ready_idle` |
| `stream-json-reducer.ts` additions (`TurnEnd`, required `onResult`, `awaitInput`, `beginTurn`'s transition, the `finishing` row) | delete with the file (§10) | Below: where each guarantee goes |
| `team-orchestrator.ts`: `onSettled`, `summarise`, `readTeamStatus`, `TeamRunOutcome`, the spawn-loop `catch` | keep; `summarise` gets the terminal guard; the `catch` body is re-based onto panes (§6.1 step 7) | §20.3 items 1–2 |
| `team-orchestrator.ts`: `spawnChild`, `terminateGraceMs` | delete | No node `spawn` of claudish remains; the reap owns its grace |
| `mcp-server.ts`: `monitor_record` in the `run` answer, `timeout_seconds` integer schema, record writes in the `run` handler | keep | §4.1, §4.2 |
| `mcp-server.ts`: the `finishing` map key and `INSTRUCTIONS` line | delete | RB1 |
| `channel/types.ts`: `SessionInfo.parentClaudeSessionId`, `SessionCreateOptions.parentClaudeSessionId`, `SessionManagerOptions.hostPid` | keep | §3.3 |
| `channel/types.ts`: `SessionStatus` incl. `finishing` | delete (as already planned, §10) | §3.3 |

**Guarantees of `stream-json-reducer.contract.test.ts`, re-homed.**

| Its requirement | Where it lives now |
|---|---|
| REQ-9/10: the owner's answer at a turn end decides the state; a one-shot turn never names `waiting_for_input` | `slot-state.test.ts` (RUNNING + verdict → terminal; RUNNING + `"continue"` → IDLE) and the ported `session-state-records` REQ-9 (no `waits.jsonl` for a one-shot) |
| REQ-11: `awaitInput` (STARTING → wait), `init` does not end the wait, `beginTurn` ends it | `slot-state.test.ts` (`boot_ready_idle` → IDLE/AWAITING_INPUT; `admit` → ADMITTING/RUNNING) and `pane-session.integration.test.ts` (`status_tick`, `idle_suggestion`: idle screen changes never close a wait) |
| REQ-12/13: `finishing` admits only terminal successors; late frames are refused and recorded | Not carried; there is no `finishing` state (RB1). What remains true is that terminals absorb and illegal transitions are recorded, never thrown (`slot-state.test.ts`) |

**Tests and helpers.** Porting rule: these suites were written blind from a specification, so a port changes
**only** the adapters and the fake, never an assertion. An assertion that no longer holds is deleted, or
replaced by one citing its RB/D number. The table is the complete list.

| File | Fate | Detail |
|---|---|---|
| `channel/parent-proof.contract.test.ts`, `channel/parent-proof.test.ts`, `channel/home-dir.test.ts` | keep as is | Pure, over a synthetic config dir |
| `channel/team-run-record.contract.test.ts` | keep as is | Drives `recordTeamRun`/`finishTeamRun` directly. Its `S.PENDING` comes from the `modelStates()` adapter, which maps it to `STARTING` (a not-yet-started slot; `summarise` counts it as failed either way) |
| `team-run-summary.contract.test.ts` | keep, plus three added cases | Same adapter mapping. Added: CANCELLED with `error.reason:"cancelled"` → cancelled; AWAITING_INPUT and AWAITING_PERMISSION → failed |
| `version-contract.test.ts` | keep as is | Asserts ≥ 10.4.0 and three agreeing places; true under either §20.6 outcome |
| `channel/spawn-record.contract.test.ts` | port | Child: the pane fake; `describe.skipIf(!magmux)`. Every assertion kept (schema, parent proof, timeout normalisation, team id answered as unknown) |
| `channel/host-pid.contract.test.ts` | port | Same. The 9a topology (npm launcher → `dist`) also needs the built tree's `CLAUDISH_BIN` to point at the fake, which `serverEnv` already does |
| `channel/session-timeout.test.ts` | port | `SessionManager.createSession` with the pane fake; the `spawn.json` assertions kept |
| `channel/session-state-records.contract.test.ts` | port, three cases replaced | Kept: REQ-9 "completes and leaves no `waits.jsonl`" (with and without `@@TOOL@@`), REQ-11/14 (the first wait opens once boot is ready, RB2), REQ-14 (no wait left open beside a `meta.json` after cancel, timeout, shutdown). Replaced: "reads `finishing` between result and exit" → "a one-shot session goes `running` → `completed` with no wait, and `meta.json` is written before its pane is reaped" (RB1). REQ-13 "a `finishing` session refuses `send_input`" → "a send after a one-shot's verdict is refused `terminal`; a send while its `activity` is `finishing` (`@@LINGER@@`) is queued, converts it to interactive and is answered as turn 2" (D17). REQ-12 "`@@LATE@@` frames do not reopen the session" → "a re-wake after the answer (`@@LATE@@`) stays in the same turn, opens no wait, and `turnsCompleted` is 1" (D23, §2.8) |
| `team-run-mcp.contract.test.ts` | port | Every assertion kept. REQ-24 ("a team slot reads `finishing`, never `waiting_for_input`") holds unchanged, because `@@LINGER@@` holds the end-of-turn record open and `activity_by_slot` shows `finishing` |
| `team-orchestrator-settle.contract.test.ts` | port | REQ-21 kept (on the `answer` shape). REQ-22: the throw is injected as a failed `status.json` write after slot 1's pane started (the team dir made read-only), not through `spawnChild`. "SIGTERMs every spawned child" → "every started pane is reaped (no process, socket or record) before the rejection"; "removes the SIGINT handler" is deleted (the handler no longer exists, §2.11). "Original error, `onSettled` never called" kept |
| `team-run-settles-once.test.ts` | port | Its `/bin/sh` print-mode fake becomes the pane fake. The spawn throw becomes the `status.json` fault above. All three properties kept |
| `team-start-failure.test.ts` | port | Its EventEmitter `ChildProcess` becomes the pane fake's `ignore_term` scenario. Asserted: the reap's group backstop SIGKILLs the pane group that ignores SIGTERM before `startModels` rejects (`CONTRACT_FAKE_SIGTERM_MARKER` proves SIGTERM came first) |
| `channel/stream-json-reducer.contract.test.ts` | delete | Its subject is deleted; its guarantees are listed above |
| `test-helpers/contract-records.ts` | keep as is | Pure validators of the record rules; R25 uses them on live files |
| `test-helpers/contract-mcp.ts` | adapt | `FAKE_CHILD` → the pane fake (Phase 4: an explicit option for team suites; Phase 5: the default). `serverEnv` keeps its allowlist and adds `CLAUDISH_PANE_ROOT` (a short `/tmp/cpt-<8 hex>`) and the hermetic keys of `makePaneTestEnv`. A magmux skip helper. `sessionStatus` reads `event` (RB7) |
| `test-helpers/contract-adapters.ts` | adapt | Delete `KNOWN_STATES`, `ReducerProbe`, `makeReducerProbe`, `disposeReducerProbes` and `spawnSeam`; `modelStates()` returns the `SlotState` values (PENDING → STARTING); keep `newSessionManager`, `setupTeamSession`, `startModels` |
| `test-helpers/contract-fake-child.ts` | delete (Phase 5), merged into `pane/test-helpers/fake-interactive-child.ts` | Below |

**One fake, not two.** `contract-fake-child.ts` speaks stream-json on stdin/stdout, which no pane child speaks
any more, so it cannot drive a pane. What the contract suites need from it is a vocabulary of behaviours
selected by prompt markers. §12.2's marker mode gives the pane fake exactly that vocabulary, plus the same env.
Keeping a second fake would mean two simulations of one child, drifting apart. M9 already ties the fake to the
Phase 2 keylog and templated real records, and the blindness that matters lives in the assertions, not in the
fake.

### 20.3 Conflicts with our decisions, resolved

1. **The team record ends exactly once, and our settle and reap.** 10.4.0 proves it structurally: `onSettled`
   is called only from `done`, `done` is built after the spawn loop, and nothing after it throws. `startModels`
   on panes keeps that structure, which is the reason for two ordering rules (§3.2, §6.1). First, the registry
   entry and the ticker are created after the spawn loop. Second, `done` is built last, after the D9 `ready`
   await (which never rejects: `ready` resolves on any exit from STARTING, terminal included), immediately
   before the `return`. A slot-local `startPaneSession` throw stays a FAILED `pane_lost` slot and never throws
   `startModels`, so the handler's `catch` sees only real start failures. "Settled" for the record means
   every slot is terminal (`TeamRunRow.state` SETTLED), not every pane reaped: the reap finishes ≤ ≈ 12 s later
   and is not the run's outcome. The monitor's end line therefore does not wait for the reap.
2. **10.4.0's SIGTERM→SIGKILL on a failed start, and our reap.** It is the same intent, already implemented by
   §2.10. The loop's `catch` calls `cancel()` on each started `PaneSession` and awaits `reaped()`: `close_pane`,
   then magmux through its handle, then SIGTERM, 2 s and SIGKILL on the verified pane group, with the watcher
   still behind it if this process dies mid-reap. `aborting` keeps those cancels out of `status.json` and out of
   any frame, so the record says `failed`, `reason: start-failed`, with zero cancellations: the caller cancelled
   nothing. The SIGINT handler removal in 10.4.0's `catch` disappears with the handler (§2.11 layer 3 replaces
   it for every consumer).
3. **`hostPid` / parent proof, and the watcher's owner.** They are different questions, and neither replaces
   the other. `hostPid` (structural, computed once) and `parentClaudeSessionId` (proven per call) say whose
   window a run belongs to. The pane record's `ownerPid` + `ownerStart` say which claudish process owns a pane,
   and the watcher needs neither, because it acts on pipe EOF. For an MCP-owned pane, `spawn.json` `mcpPid`
   equals the pane record's `ownerPid`. D15 also makes the monitor's liveness inference sound: when the writer
   (`mcpPid`) dies, its panes die with it, so a monitor that reports such a run as lost is not hiding a REPL
   still at work. The pane snapshot strips the launcher pair and `CLAUDE_CODE_SESSION_ID` (§2.3), so a nested
   claudish MCP server inside a pane can neither inherit the host's identity nor a stale conversation
   candidate. Both were already inert; stripping them makes the pane match a terminal launch.
4. **The `timeout_seconds` clamp.** It agrees with D10. `normaliseTimeoutSeconds` runs once, in
   `createSession`, and its value goes to `spawn.json`, `SessionInfo.timeoutSeconds` and
   `PaneSessionOptions.timeoutMs`, so the record and the timer cannot disagree. A value below the boot time
   (e.g. 1) expires the session during STARTING: `timeout` is legal from every live phase, the session becomes
   TIMEOUT, and the pane is reaped. That is the caller's explicit deadline, as D10 states. The monitor's own
   lost-check window (`startedAt + timeoutSeconds + grace`) still bounds a pane session, because `meta.json` is
   written at the terminal transition, before the reap.
5. **The channel's `finishing` state, our `SlotState` and our `activity`.** 10.4.0's `finishing` means "the
   final turn's `result` arrived, claudish closed stdin, the child is exiting". It comes with three guarantees:
   only a terminal state may follow; a late frame is refused; `send_input` is refused. A pane session can honour
   none of them. A one-shot verdict is decided at settle and the session is terminal before the reap, so the
   "exiting" interval does not exist. A Stop-hook re-wake after the answer is a legitimate part of the same turn
   (§2.8), not a frame to refuse. D17 accepts and queues `send_input` in every non-terminal state. Emitting
   `finishing` with weaker semantics would give one name to two concepts. So: `SlotState` stays the closed nine
   values, unchanged; the channel event goes (RB1); and §8 gets one sentence **[amended r-base]** (§8 E). The
   word survives where its meaning does: `activity:"finishing"` on a RUNNING row ("the model's message ended;
   waiting for Claude Code's end-of-turn record", §8 B, already amended in r2). That is also exactly what 10.4.0
   promised a team observer ("between its result and its exit it reads `finishing`, never
   `waiting_for_input`"), and REQ-24 passes unchanged.
6. **"A promptless session waits from creation".** It conflicts with §8's STARTING during boot. Resolved by RB2.
   A `send_input` during boot is queued and becomes the first prompt (`boot_ready_admit`), in which case no wait
   ever opens. That is correct: nothing waited.
7. **F1 and F2 now have two definitions each.** 10.4.0's `projectDirNameFor` and `claudeConfigDir` implement
   exactly F1's slug and a better F2 (its `$HOME`-first rule; Bun's `os.homedir()` ignores a runtime `HOME`,
   and Claude Code follows `$HOME`). F1 and F2 reuse them (§11), so the transcript path claudish derives and the
   directory the proof searches come from one rule.
8. **Shutdown ends the records.** Stdin EOF, transport close and the signal hooks run `before()`, which now
   covers the records too. `shutdownAllTeamRuns` marks slots CANCELLED and awaits each live run's `done`, which
   resolves on those transitions (not on the reaps), so every team record ends `cancelled`. `shutdownAll` closes
   each open wait (`to:"cancelled"`) and writes each `meta.json`; then `reapAllPanes` runs. After a SIGKILL of
   the server no record ends. The watchers still remove the panes, and the monitor reports the run from the
   writer's death, as 10.4.0 intended ("an observer reports from the writer's liveness — never a false
   verdict").

### 20.4 `CLAUDISH_PANE_ROOT`

The ported suites, like `mcp-contract.e2e.test.ts` and `mcp-shutdown.e2e.test.ts`, start a real MCP server as a
subprocess, so the `sockRoot` seam of `PaneSessionOptions` cannot reach the panes. Without an override, such a
server would use the user's real `/tmp/claudish-mux-<uid>`. Its startup sweep would then act on the user's
dead-owner records (identity-checked, but still not the test's to touch), its panes would count against the
user's `MAX_LIVE_PANES`, and the no-orphan assertion, which is scoped by `sockRoot`, would see nothing.
`CLAUDISH_PANE_ROOT` is a location, like `CLAUDISH_SESSIONS_DIR`: it tunes no behaviour, and every
`ensureSockRoot` check (a real directory, owned by us, mode `0700`) and the < 100-byte socket-path assert still
apply. This is a gap in the r2 design that the ported suites made unavoidable, recorded here rather than left
implicit.

### 20.5 Sections updated

- §0 adds D24.
- §1.2 adds the record paths.
- §2.3 adds `CLAUDISH_PANE_ROOT` and the host-identity strip.
- §2.9 adds `onTransition`.
- §3.1 adds CANCELLED's `error.reason` and the outside readers.
- §3.2: the registry entry is created after the loop.
- §3.3: `meta.json` keeps the 10.4.0 keys; `spawn.json`, `waits.jsonl` and the `events.jsonl` assistant lines.
- §4.1: the `run` order, the record writes and `monitor_record`.
- §4.2: the proof, `spawn.json`, the `timeout_seconds` schema, `get_diagnostics` `event`, `INSTRUCTIONS`.
- §6.1 adds `onSettled`, step 7 and the deleted seams.
- §6.4 changes `summarise`.
- §7: the record writers stay.
- §8: the version note, the pre-contract range and the `finishing` sentence, all **[amended r-base]**.
- §10: the reducer additions, the contract fake, the reducer contract test, the team seams, the `finishing`
  keys, the kept list and `CLAUDISH_PANE_ROOT`.
- §11: F1 and F2 reuse.
- §12: the magmux-spawning list, marker mode, `session-records.contract.test.ts`, the 10.4.0 test edits.
- §13: every phase.
- §14: the 10.4.0 doc sections, one by one.
- §15 adds R25.
- §16 adds assumptions 8–9 and open question 4.

`mod-contract-v1.md` in this session directory is the paste of §8. It must be re-pasted from §8 before it goes
to the peer (this revision edited only this document).

### 20.6 Version

**Assumption.** `feat/session-records` is complete and green. The monitor already requires 10.4.0 and treats
anything older as unable to report, and `version-contract.test.ts` pins ≥ 10.4.0.

**Recommendation.** Merge `feat/session-records` to main on its own and tag **v10.4.0** from that merge commit,
per CLAUDE.md "Releasing". This migration then ships as **10.5.0**: a minor bump, with the `feat(mcp)!` commit
and its `BREAKING CHANGE:` footer as §13 states, which adds RB1 (`finishing` is no longer emitted) to the
footer's list. Reasons:

- The monitor gets its records now, instead of after a large breaking migration.
- A published 10.4.0 is a live baseline: R25's record files from the pane build can be compared with ones the
  `-p` build wrote.
- The two release notes describe two separate user-visible changes.

The cost: `finishing` would be public for one release before RB1 removes it. That is harmless, since it asked
nothing of the caller and no record carries it.

**If 10.4.0 has not been tagged when this migration reaches Phase 7, do not tag it separately afterwards.** Ship
the combined tree as **10.4.0**: both version files already say so, the version contract and the monitor's
minimum hold, RB1 then removes nothing published, and §8's "pre-contract ≤ 10.3.0" is exact. Phase 7's bump
step is therefore conditional (§13): to 10.5.0 if `git ls-remote --tags origin refs/tags/v10.4.0` finds the
tag, else none. Either way the tag is re-checked immediately before tagging, as CLAUDE.md requires.

---

## 21. Phase 2 corrections **[impl-2]**

Live captures of Claude Code **2.1.290** (not 2.1.287) in headless magmux, recorded in
`ai-docs/reports/mcp-magmux-panes/phase2-captures.md` (tracked); fixtures in
`packages/cli/src/pane/test-fixtures/`. The gate found these differences; the code follows the captures.

- **§2.6 `hasChoiceDialog` (R3-H1)** — the closed list is named headers only: permission
  `Do you want to proceed?` / `Do you want to create|make this edit to|overwrite|delete …?`, plan
  `Would you like to proceed?`, AskUserQuestion footer `Enter to select · ↑/↓ to navigate`; plus a `1.`
  option row below the last `⏺` block and no input box. 2.1.290 has **no** `No, and tell Claude …(esc)`
  row (permission ends `3. No`, plan approval has no No row), so the `(esc)`/`No` requirement is gone.
- **§2.6 unnamed boot choice** — 2.1.290 boot dialogs are unnumbered (`❯ No, exit`); the footer
  `Enter to confirm · Esc to cancel` (or `Enter to select`) also marks a choice screen. All boot dialogs
  are on the primary screen.
- **§2.6 `isWorking`** — `esc to interrupt` no longer exists; the working row is `<glyph> <Word>… (…)`
  above the box (the finished row has no `…`). `stopHookRunning` reads `(running Stop hook`.
- **§2.6 `screenErrorRows`** — an API error renders as a `⏺` row (`⏺ Please run /login · API Error: 401 …`).
- **§2.6 `screenAnswer`** — Bash renders as a description row + `⎿  $ cmd`, collapsed to `Ran 1 shell
  command`; also excluded: `⏺ Agent "…" finished`, `⏺ Background command …`, `⏺ User declined …`.
- **§2.6 `agentRejectedLine`** — magmux truncates `exit.lastLine` (`…not found. Avail…`); the agent list is
  optional in the match; read the full line from the final screen.
- **§2.6 empty box** — placeholder cells carry magmux attr **2** (faint); the cursor cell attr 16. The box
  prompt is `❯` + U+00A0 (echo rows use a plain space). The prompt suggestion never appeared (skipped).
- **§2.7 `provenHookless`** — `attachment/prompt_snapshot` and state records sit between the `end_turn`
  record and `turn_duration`; the rule is "no `stop_hook_summary` in between".
- **§2.7 / D23 background agents** — counted from `toolUseResult.isAsync === true` (`agentId`): haiku
  launched an async agent with no `run_in_background` in its input. Completion = the `<task-notification>`
  whose `<task-id>` is the agentId.
- **§2.7–2.8 waking records** — an `isMeta` user record after the last assistant message wakes the model:
  2.1.290 auto-continues `max_tokens` (`Output token limit hit. Resume directly …`, three times, then a
  `max_output_tokens` synthetic API error → FAILED `api_error`), and a refusal is followed by an `isMeta`
  companion and a fallback-model continuation (corpus). `refused` therefore needs a refusal with nothing
  after it, which was never observed.
- **§2.8 S gate** — also opens for `stop_reason:"refusal"` (Stop hooks did not run after the corpus refusal).
- **§2.8 `secondaryQuietMs` = 32 000** (corpus p99 15,832 ms of the end_turn re-wake gap, ×2, rounded up).
- **§2.13 Read** — no per-line truncation (a 90,005-char line came back whole), no line cap (2,601 lines),
  a 25,000-token cap (`truncatedByTokenCap` + `read_truncation_notice`, or `is_error` when `limit` is too
  big); `offset:0` reports `startLine:0` and numbers from 0; CRs are stripped; no `tool-results/` spill.
  `READ_LINE_LIMIT = 20 000` is therefore a page budget, not a Read limit. Coverage = a text compare from
  `max(1, startLine)`; the empty line after a final newline is numbered by Read but not required.
- **§2.13 commands** — `/cost` opens the `/usage` panel, writes **no record** and swallows input until Esc
  (Phase 3: press Esc on a panel when admission fails). `--permission-mode default` does not override
  `-y`; `--no-auto-approve` does (and is not reserved).
- New files beyond §13's list: `pane/settle-rule.ts` (the §2.8 decision, pure), `pane/types.ts`
  (`SettledTurn`, `FinalVerdict`, `PaneSnapshot`), `pane/test-helpers/{fixtures,transcript-fixtures}.ts`,
  `scripts/redact-transcript-fixture.ts` (used for the two corpus fixtures; Phase 3 reuses it).
- `mergeAccounting(snap, tokenFile, ids?)` also returns `provider` (through `resolveProvider` when `ids` is
  given), so `toSlotRow(id, snap, acct)` reads the provider from `acct`. A native route writes **no** token
  file at all in a pane (not even the initialised zeros).
