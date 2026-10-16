# Pane sessions — interactive Claude Code in headless magmux panes

Every MCP `team` slot (`run`, `run-and-judge` and the judge children), every CLI `claudish team …`
/ `--team --mode json` slot (they share `runModels`) and every `create_session` is an
**interactive** Claude Code launched through claudish, inside its own headless magmux pane, driven
over that pane's socket. There is no `-p`, no `--stdin`, no stream-json and no positional prompt
anywhere in that path. The driver is `packages/cli/src/pane/`; its public surface is
`pane/index.ts` and its live object is `PaneSession`. Team (`team-orchestrator.ts`) and the
MCP sessions (`mcp-session/session-manager.ts`) are its two owners.

One exception: CLI `--grid` (`team-grid.ts`) still launches `claudish --model X -y --quiet
'<prompt>'` print-mode children in a VISIBLE magmux with `-w`. It is a viewer for a human, not
part of this driver.

This file records why the driver is shaped the way it is. The design and its review history are
in the session that built it (gitignored); the measurements it rests on are in
[`reports/mcp-magmux-panes/phase2-captures.md`](../reports/mcp-magmux-panes/phase2-captures.md)
(Claude Code **2.1.290**, magmux 0.14.0). Read [`headless-vs-interactive.md`](headless-vs-interactive.md)
first for why print mode is not a faithful subset of the REPL.

## The process topology

```
owner (MCP server or CLI team) ── spawn, detached, stdin = pipe ──▶ pane watcher  (/bin/sh, argv0 claudish-pane-watcher)
   │
   └── spawn, detached ──▶ magmux --headless --no-status --id <paneId> --sock-dir <root> -e ". <ctl>/pane-launch.sh"
                               COLUMNS=160 LINES=50, SHELL=<ctl>/sh-shim
                               └─ pane 0: sh-shim -l -c ". pane-launch.sh"  =  /bin/sh -c …
                                    └─ cd -- '<realpath cwd>' || exit 97
                                       exec claudish -i --model <spawnModel> -y --quiet --session-id <uuid> --add-dir <turnDir> [caller flags]
                                            └─ bun → claude   (writes <config>/projects/<slug>/<uuid>.jsonl)
```

- `<root>` is `/tmp/claudish-mux-<uid>` (0700, owned by us, never a symlink), or
  `CLAUDISH_PANE_ROOT` — a location like `CLAUDISH_SESSIONS_DIR`, which tests use so their panes
  never touch the user's root. Every check still applies to it.
- `<paneId>` is `c<owner pid>-<owner start ms, base 36>-<t|s><label>-<6 hex>`, at most 40
  characters. The pid plus start time makes a dead owner detectable even after its pid is reused.
- Two directories per pane, both `mkdtemp(<root>/launch-)`: the **control** directory
  (`pane-launch.sh`, `sh-shim`, `magmux.pid`, `group`) and the **turn** directory (`turn-<n>.md`
  only), which is the one the child gets as `--add-dir`. The model is never pointed at the control
  files (R3-M2). Before any `rm`, both the TypeScript and the watcher's shell check that a path is a
  direct child of the root named `launch-` plus six `[A-Za-z0-9]`.
- **The pane command must never name `claude`.** magmux attaches its `ClaudeCodeController` to a
  pane whose command contains `claude `, ends in `claude` or has that basename, and the
  controller's mtime-based transcript discovery can lock onto the parent's or a sibling's
  transcript. `paneCommand()` throws rather than produce such a command.

## The transcript is the turn oracle; magmux is not

magmux supplies three things: liveness (`exit` events, pids), the screen (`watch` frames) and input
(`send`). It does not know when a turn started or ended:

- a `claudish …` pane has no controller, so magmux pushes no per-pane state for it;
- "running" right after a `send` proves nothing: every PTY write clears magmux's `inputReady`,
  and its idle heuristic re-promotes the pane 5 s after the last printed text.

Acceptance, settle, the answer and the accounting therefore come from the transcript Claude Code
writes for the `--session-id <uuid>` claudish minted. Its path is derived, never searched for:
`<CLAUDE_CONFIG_DIR or $HOME/.claude>/projects/<every non-alphanumeric character of realpath(cwd)
replaced by ->/<uuid>.jsonl`, plus `<uuid>/subagents/agent-<id>.jsonl`. The launcher `cd`s to the
realpath before `exec`, so the slug does not depend on the path the owner spawned with. **A slug
longer than 200 characters is cut to 200 and suffixed `-<base36 |hash(realpath)|>`**, the 32-bit
`(h << 5) - h + charCode` hash over the whole path (Claude Code 2.1.291's `eI`/`Le`). Measured: a
259-character cwd got `<200 slug chars>-g32rlu`, which `projectDirNameFor` reproduces; without it a
deep worktree path names a transcript that is never written and every turn silently degrades to
the screen.

**Turns are segmented by claudish's own deliveries, never by user records.** Before delivering a
prompt the follower polls and records the transcript size; turn N owns every record past that
offset and before turn N+1's. Evidence from an earlier turn can therefore never satisfy a later
one. The turn is ACCEPTED when its **witness** appears after the offset: a main-chain user record
whose text equals the typed line (`origin.kind:"human"`), or a `<command-name>/x</command-name>`
record for a slash command — a user record, or (2.1.287+, `/color yellow` captured on 2.1.291) a
`system/local_command` record, which a user-record-only witness never accepts. A slash command is
also witnessed by a non-`isMeta` user record whose text equals the typed line: `/compact` writes
one at submit (captured on 2.1.290 and 2.1.291, `"content":"/compact"`, no `origin`) but APPENDS its
`<command-name>` record only when compaction finishes — 10.4 s for a two-turn conversation, minutes
on a real context. Waiting for `<command-name>` outlived the 30 s admission bound: the turn was
abandoned (`send_not_accepted`) while Claude Code compacted, and the pump typed the next queued
prompt into a busy REPL. Accepted at the typed record, compaction is a RUNNING turn with no timer
(D10), and the prompts queued behind it wait for path L. `/model` and `/pear` write no such record
and are still witnessed by `<command-name>`. Measured: the witness lands 370–470 ms after a typed send; with a
`sleep 12` UserPromptSubmit hook the box clears at once but the witness arrives 12,501 ms later.

The follower polls on every frame (debounced 250 ms) and on a 1 s backstop.

## The session registry: a second reader, telemetry only

Every interactive Claude Code writes `<CLAUDE_CONFIG_DIR or $HOME/.claude>/sessions/<pid>.json` and
rewrites it on each state change: `status` is `idle`, `busy`, `waiting` (with `waitingFor`:
`permission prompt`, `input needed`) or `shell` (a background Bash still running after the turn); the
first record has no `status` for 100–440 ms. Its `sessionId` is the `--session-id` claudish mints, so
`pane/session-registry.ts` finds the pane's record by that uuid (11/11 measured), never by a bare
pid, and drops a record whose pid is dead. It reads the raw file because `claude agents --json`, the
documented reader, refuses under a user's `disableAgentView` and omits fields; the file itself is
undocumented, and a torn write can leave a trailing `}` (#96438), which the parser tolerates.

It is TELEMETRY: no decision reads it. Each evaluation compares it with what the screen says and
counts the onset of a disagreement as an anomaly — `registry_record_missing` (no live record 5 s after
boot was ready), `registry_idle_screen_booting` (registry idle for 2 s, `readBoot` not `repl`: the
signature of the `--agent` border bug, measured at 2.3 s instead of the 90 s `boot_timeout`),
`registry_idle_screen_working`, `registry_waiting_no_dialog`, `screen_dialog_registry_not_waiting`,
and `registry_status_unknown:<status>`. The research that measured it — readiness 20/20 idle and
19/20 under load, dialog open 34–36 ms ahead of the screen, correct through `/compact`, auto-compaction
and background work where the screen is not — is `ai-docs/reports/pane-ui-independent-signals.md`.
When the field counts show it agreeing, it can replace the screen reads it shadows, one at a time.

**Not used: an in-child mod.** A Claude Code mod loaded with `--plugin-dir` reports busy, dialogs and
submits from inside the child, but it is early access, Anthropic can serve it off remotely with no
local override (#99130), and it delays SessionStart by about 250 ms. Parked in `ROADMAP.md` with its
trigger. Nor is any of its prompt paths, the messaging socket or an argv first prompt a delivery
route: a pane child receives every prompt the way a user gives it — typed, pasted, or an image paste.

## Boot: read from screen content, and never accept a dialog

Boot is ready when the screen shows the REPL input box — a full-width `─` rule, a row starting
`❯` + U+00A0, a second rule — with nothing typed, for 3 s (`REPL_STABLE_MS`). Placeholder text in the box carries
magmux attribute 2 (faint) and does not count as typed. Under `--agent` the top rule carries the
agent's name at its right end (`──── dev:reviewer ─`); `isBoxRule` accepts that one label, and
until 10.4.2 it did not, so every slot given an `agent` failed `boot_timeout` at 90 s with a ready
box on screen (fixture `repl-boot-agent`). Measured spawn → empty box: 0.67–1.97 s
with catalog warm-up off; the ≈11 s of earlier research included claudish's 4–7 s catalog warm-up.

**Why 3 s and not 500 ms.** Claude Code draws the box and then, 1–2 s later, resets stdin (a
termios cooked→raw blip). A line typed into that window is lost or sits in the box unsubmitted, in
normal editor mode as well as vim. Measured 2026-10-16 (Claude Code 2.1.301, magmux 0.15.1, magmux
owner): with the box stable for 500 ms and `--settings {"editorMode":"normal"}`, 2/2 team slots
failed `prompt_not_accepted`, the retry failed one, and the third try got through. A stable box is
not proof the child reads its input, so boot waits the reset out; the cost is ≈2.5 s per boot.

What blocks boot is decided by **"no input box"**, and named by a closed list:

| screen (static 5 s, no input box) | outcome |
|---|---|
| `Choose the text style` (onboarding), `Is this a project you created or one you trust` (trust), `running in Bypass Permissions mode`, `Detected a custom API key in your environment` | FAILED `first_run_dialog`, dialog text in `detail` |
| any other screen with choice markers — a selection footer (`Enter to confirm · Esc to cancel`, `Enter to select`), numbered Yes/No rows, `Press Enter to continue` — e.g. `New MCP server found in this project` | FAILED `boot_blocked`, screen text in `detail` |
| still changing at 90 s | FAILED `boot_timeout` (or `boot_blocked` if it went static) |

**Nothing is ever auto-accepted.** Every 2.1.290 boot dialog has `❯ No, exit` as its default, and
accepting one on the user's behalf (trusting a folder, enabling a project's MCP servers) is a
decision claudish has no standing to make. The bypass-permissions dialog is the one that `-y`
itself would cause, so it is suppressed instead: a pane child's `--settings` overlay carries
`skipDangerousModePermissionPrompt: true`, gated on `isPaneChild()` (`CLAUDISH_PANE_CHILD=1` AND
`CLAUDISH_PANE_CWD`) so no other launch gets it (D5). The same overlay, on the same gate, carries
`editorMode: "normal"`: a user `editorMode: "vim"` leaves the box in `-- INSERT --`, the submit
Enter is swallowed, the typed prompt sits unsent, and every slot fails `prompt_not_accepted` with
anomaly `resent_enter` (measured 2026-10-16, Claude Code 2.1.301, magmux 0.15.1). Claude Code
merges settings per key, so the user's other settings still apply. Claude Code keeps only the LAST
`--settings` flag, so a caller's `claude_flags --settings` is merged into claudish's temp file
(`mergeUserSettingsIfPresent`) and one `--settings <path>` is emitted; in a pane `editorMode` is
forced over the caller's. magmux 0.16.0 forces the same value for its panes; once it is the
minimum, this key can go. The API-key dialog was not recaptured on 2.1.290 (it needs a foreign route with
`ANTHROPIC_API_KEY` set); its marker is the verbatim 2.1.287 text.

**An unknown `--agent` is refused by the child itself**, which is why the old `claude -p` agent
probe was deleted (D11): with two validators the cheap one always decides and the real one is never
exercised. Measured: the pane exits 319 ms after the child starts, with `--agent 'zzz-not-real' not
found. Available agents: …` on the primary screen. magmux's `exit.lastLine` is truncated
(`…not found. Avail…`), so the line is read from the final screen, and on the exit path from a
scrollback `capture {offset:200}`, giving FAILED `agent_rejected`. A child that dies that fast exits
before the first subscription, so its `exit` event is never pushed to us: every attach also asks
`list`, and a dead pane 0 found there takes the exit path.

## Settle — Claude Code's own end-of-turn record, turn-scoped

The rule is the pure function `decideSettle` in `pane/settle-rule.ts`. A turn needs its witness, at
least one assistant message after it, and nothing waking the model after that message. Then:

| path | evidence | screen corroboration |
|---|---|---|
| **P** | `system/turn_duration` after the last assistant message, `pendingBackgroundAgentCount` 0 (absent means 0), background agents balanced, no pending tool | yes |
| **I** | `[Request interrupted by user…]` after the last assistant message; `turn_duration` optional | yes |
| **S** | no `turn_duration`: an ending `stop_reason`, Stop hooks KNOWN finished, and no transcript append and no change above the box for `secondaryQuietMs` | yes; records `settled_without_turn_duration` |
| **X** | the pane has exited: an ending `stop_reason` and nothing waking after it | none (the pane is gone) |
| **L** | a LOCAL slash command: its `<local-command-stdout>` after the witness and no assistant message; the answer is that stdout | yes (none once the pane exited) |

Corroboration is: no further main-chain chat record for 500 ms, and the screen shows an empty input
box, no choice dialog and no working row. While the socket is disconnected the screen is stale, so
P and I settle with the anomaly `screen_unverified` and S waits for the reconnect.

**Local commands (path L).** A local command writes no assistant record and no `turn_duration`
(captured on 2.1.291: `/compact` → `compact_boundary`, the summary, the caveat, `<command-name>`,
`<local-command-stdout>Compacted…`; `/model haiku` → caveat, `<command-name>`, stdout; `/color` →
two `system/local_command` records). Without L such a turn stayed RUNNING "thinking" for good and
every later `send_input` queued behind it. A command that prompts the model (`/pear`) writes no
stdout and settles through P. Local-command records (`<local-command-caveat>`, `<command-name>`,
`<local-command-stdout>`) are never waking records.

**Why `turn_duration`.** In the interactive REPL Claude Code writes it only after the Stop hooks
finish: captured 30,077 ms after the answer with a `sleep 30` Stop hook, `stop_hook_summary`
(`durationMs: 30011`) then `turn_duration`. Waiting for it waits for hooks and for background agents
by construction, and no path can end a running hook. In the local corpus (3,001 transcripts), 5,285
of 8,497 `stop_hook_summary` records are followed by `turn_duration`. It is ABSENT on several real
endings, each captured, which is why the other paths exist:

| ending | `turn_duration`? | settles by |
|---|---|---|
| `end_turn`, hookless or after a Stop hook | yes | P |
| API error (401, `isApiErrorMessage`, `model:"<synthetic>"`) | yes; no `stop_hook_summary` | P → FAILED `api_error` |
| Esc on a dialog (AskUserQuestion, permission, plan) | yes, after the interrupt records | I |
| Esc during a running Bash; a plain interrupt while streaming | **no** | I |
| a Stop-hook re-wake, a background notification after the answer | not for the original turn | the same turn continues |

**S is gated on Stop hooks being known finished**: a `stop_hook_summary` after the last assistant
message, or a session PROVEN hookless (an `end_turn` followed by `turn_duration` with no
`stop_hook_summary` between them — `attachment/prompt_snapshot` and state records do sit between),
or an API error or a refusal (Stop hooks did not run after either). A running Stop hook can never
satisfy S anyway: until it finishes there is no summary, and the working row above the box
(`· Processing… (running Stop hook · 2s …)`) is rewritten every second (30 changes in 30 s
measured), so the above-box quiet window cannot elapse.

**`secondaryQuietMs` = 32,000.** The gap that matters is `stop_hook_summary` → the next main-chain
assistant record after an `end_turn` — the window in which a Stop hook's feedback re-wakes the
model. Over the corpus: 1,944 such gaps, p50 2,122 ms, p90 3,545, p95 4,918, **p99 15,832**, max
810,544 (a background notification). `max(15 000, 2 × p99)` = 31,664, rounded up. It confirms an
ending that has already happened; it never ends work.

**Waking records.** A main-chain user record after the last assistant message means the turn is not
over: a `<task-notification>` (only as a main-chain `user` record; the mid-turn attachment form below
never wakes), Stop-hook feedback, or an `isMeta` record — Claude Code continuing on
its own. 2.1.290 auto-continues a `max_tokens` stop (`Output token limit hit. Resume directly …`,
captured four times with a 60-token cap) and finally writes a synthetic `max_output_tokens` API error,
which settles as FAILED `api_error`. A refusal is followed by an `isMeta` companion and a continuation
on another model (`system/model_refusal_fallback`, the corpus's only refusal), so EMPTY `refused` needs a refusal with nothing
after it, which was never observed.

**Background work (D23).** Background AGENTS are awaited; background shells are not.

- An agent is counted by its result, `toolUseResult.isAsync === true` (with its `agentId`) — haiku
  launched one with no `run_in_background` in its input — and completes on the
  `<task-notification>` whose `<task-id>` is that `agentId`. This mirrors Claude Code's own
  `pendingBackgroundAgentCount`, which `turn_duration` carries only when it is above 0.
- A notification arrives in one of two forms (captured 2.1.263 and 2.1.301). After the turn ended it
  is a `user` record (`origin.kind:"task-notification"`), which wakes. Absorbed into a turn still
  running it is a main-chain `attachment` with `attachment.type:"queued_command"` whose prompt starts
  `<task-notification>`; it completes the agent or closes the shell but never wakes, because it rides
  a request already in flight and the assistant record that answers it follows (1,133 of 1,134 corpus
  attachments; the other was a file still being written). Unread, session 779a03f0 stayed RUNNING /
  `background` with both agents done until cancel (2026-10-16). `queue-operation` records are not
  read: a removal does not prove delivery. The redaction script keeps `<task-id>` inside a redacted
  notification, so a fixture still links it to its launch.
- A background Bash is not awaited. If its notification arrives before settle it wakes the model and
  is part of the turn; otherwise the turn settles at Claude Code's own `turn_duration` and the anomaly
  `background_shell_open: <command>` names it — in the team slot's `detail` and the result card too
  (R3-M5). A dev server, watcher or `tail -f` never finishes, so awaiting it would hold `judge`,
  `run-and-judge` and the review gate forever. For team and one-shot sessions the reap ends the
  shell. In an INTERACTIVE session the shell lives on; when it finishes, its notification re-wakes
  the settled turn and the turn settles again with a longer answer under the SAME index.
  `SessionManager.appendAnswer` appends only the new tail. Until 10.4.2 it kept a set of answered
  indexes and dropped the re-settle, so the follow-up answer never reached `get_output` (3/3). **A background shell is its own process group** (measured on 2.1.291: shell pid 58621,
  pgid 58621, parent the `claude` process, pane group 58218), so a group signal never reaches it.
  The normal reap ends it anyway — `close_pane` lets Claude Code end its own shells (measured) —
  but the group backstop, the owner-EOF watcher and the startup sweep record such descendants as
  `escaped` (pid, start) pairs after `--` in the group file and signal each by pid while its pair
  still matches. A fresh snapshot finds an escaped process only while its parent chain reaches a
  member, and when `claude` dies without its own cleanup the shell is reparented to pid 1 while the
  claudish wrapper (a verified member) lives on. So a refresh keeps every recorded escaped pair
  that still matches the live table, plus that survivor's own descendants outside the group;
  replacing the list with the fresh one dropped the shell in exactly the crash this exists for
  (code-review iteration 2, M2). Dead or reused pairs drop out, so the list stays bounded. A shell
  started and orphaned between two 2 s ticks is never recorded; that window remains.

**A turn that never gets its record.** When the activity is `finishing` (the model's message ended,
Claude Code's end-of-turn record has not arrived) and the screen has been static with no Stop-hook
row for 3 × `secondaryQuietMs`, the anomaly `turn_end_record_missing` is added (R3-M4) and the team
note tells the caller to cancel. The CONDITION is live (`turnEndRecordMissing` on the snapshot): it
clears the moment activity leaves `finishing`, and only while it holds do `activity_by_slot` and the
row's `activity` read `finishing: turn_end_record_missing`; the anomaly stays as history. A sticky
read presented a slot the model had woken again as wedged. No timer ends the turn (D10).

**Counts that disagree.** While a turn is unsettled after a `turn_duration` and not waking, the
background agents claudish counts as pending (`agentsLaunched - agentsCompleted`) are compared with
Claude Code's own `pendingBackgroundAgentCount` (absent means 0). When they differ the anomaly
`agent_count_mismatch: claudish <counted> pending, Claude Code <reported>` is added once per onset of
a pair, and the CONDITION is live (`agentCountMismatch` on the snapshot): only while it holds does the
row's `activity` read `background: agent_count_mismatch`; it clears when the counts agree or the turn
settles, and the anomaly stays as history. It never settles or ends a turn: Claude Code's count is a
witness, never the decider (D23). Session 779a03f0 (2026-10-16) sat at claudish 2 pending, Claude
Code 0 until cancel, with nothing on the row to say why.

**Blocked.** A pending `AskUserQuestion` comes from the transcript. A permission or plan-approval
dialog also needs the screen: `hasChoiceDialog` is a CLOSED list (R3-H1) — a named header
(`Do you want to proceed?`, `Do you want to create|make this edit to|overwrite|delete …?`,
`Would you like to proceed?`, the `Enter to select · ↑/↓ to navigate` footer), a `1.` option row
below the last `⏺` block, and no input box. An unrecognised layout is "not a dialog", an honest
unknown, never `blocked`: numbered prose with a `No, …(esc)` line over a running Bash is a captured
negative fixture. The owner decides what a block means: team fails the slot `blocked` with the
question as its detail (D19, team has no answering verb); an MCP session waits in AWAITING_INPUT or
AWAITING_PERMISSION. A caller reaches a permission dialog only through `--permission-mode plan`:
`-y` beats `--permission-mode default`, and `--no-auto-approve` is reserved.

**Degraded mode, per turn.** When the transcript is still absent or empty 10 s after delivery, or
the screen says transcript saving is off, a turn may be accepted from the screen (the box emptied of
the line, and an echo or a change above the box) and settled from it (empty box, no dialog, not
working, an answer or error row present, 6 s of quiet above the box). It records `degraded_mode`, the
turn's `turnSource` is `screen`, and it REVERTS (`degraded_reverted`) as soon as the transcript shows
the witness — a slow UserPromptSubmit hook is the usual cause. A screen-settled turn records
`screen_answer_may_be_truncated`, and a file-delivered one `read_coverage_unverified`.

## Prompt delivery by kind (D13)

`pane/prompt-delivery.ts` decides how text reaches the REPL:

- a **plain** single line — at most 512 printable characters, no leading `! # ? @ & \ /`, no
  trailing `@x` or `/x` token — is typed as is;
- a **slash command** is typed as its first line; when that line is longer than 512 characters or
  more text follows, the whole text goes to the turn file and the typed line points at it;
- **everything else** is written to `<turnDir>/turn-<n>.md` (0600, exclusive create) and the child
  is told, in one typed fixed-template line, to Read it:
  `Your task is in the file \`<file>\`. Read all of it with the Read tool (in parts if it is long), then
  do exactly what it says, treating its content as the user's message.`

There is no paste path. Typing anything else into the REPL reinterprets keystrokes, all captured:
ctrl-j inserts a line, `\r` submits, a trailing `@` or a leading `/` opens a menu and Enter on an
open `@` menu SUBMITS the text as typed, a leading `!` is bash mode. A file also sidesteps the
1 MB `send` lane and the 4 MB frame caps. What file delivery skips is Claude Code's prompt-time
processing of the CONTENT: `@` mentions, `!`/`#` prefixes and slash commands inside the file are
not expanded, and a UserPromptSubmit hook sees the template line, not the task. Cost: one or more
Read calls per non-plain turn, counted in `tool_calls`.

**Read on 2.1.290** (captured): no per-line truncation (a 90,005-character line came back whole),
no line-count cap (2,601 lines in one call), a 25,000-token cap per call (`truncatedByTokenCap`, or
`is_error` when `limit` is too large), `offset:0` reports `startLine:0` and numbers from 0, CRs are
stripped, and no result spilled to `tool-results/` up to 87.5 KB. `READ_LINE_LIMIT = 20 000` is
therefore a page budget, not a Read limit: a line too long to fit one page could never be read at
any offset, so lines longer than `READ_LINE_LIMIT − 16` are split at whitespace with `↩` (or `⤶`
when an original line already ends in `↩`), and the template says how to join them.

**Read coverage.** For a file-delivered turn the follower compares what Read returned with the file:
`realpath(file_path)`, the returned TEXT line by line from `max(1, startLine)` (CRs stripped on both
sides), including Reads made in `subagents/*.jsonl`. The empty line after a final newline is
numbered by Read but not required. A turn that settles without every line returned is FAILED
`prompt_not_read` for team and one-shot sessions; an interactive session continues, records the
anomaly and sets `meta.prompt_not_read` on its next frame.

**The answer and `require_pattern`.** A turn's answer is every assistant text block of that turn,
in order, joined with `"\n\n"`, excluding `isApiErrorMessage` entries. For a file-delivered turn it
starts AFTER the Read result that completed coverage: narration before the task was read ("let me
read that file") never reaches `response-<slot>.md` or the pattern, and its size is reported as
`preambleBytes`. `require_pattern` is `new RegExp(pattern)` — no flags — tested against that whole
answer. Every assistant message of the turn was read from the transcript, so a mismatch means the
model did not produce the shape, not that the capture lost it (`team-capture.md`).

**Delivery mechanics.** `send {typed:true}` types the line as keystrokes. A send is retried only when
magmux refused it (`busy`, `pane_*`) or it was never written; when the REPLY was lost
(`client_timeout`, `client_lost`) magmux may already have typed it, so the next frame decides: the
line in the box (or, for an Enter send, its witness or echo) means it landed (`send_reply_lost`), and
only an empty box is typed again — a blind retry put the line in the box twice and no witness could
match. With no witness 10 s after delivery, a line still in the box is cleared with ctrl-u, retyped
once and submitted (`resent_enter`, then `retyped_prompt`): a line typed into the startup stdin
reset (Boot, above) may show in the box without the child holding it as input, so a bare
second Enter cannot be relied on to submit it. The first frame after ctrl-u is not evidence: under
load it can be a stale redraw still holding the line (report-F, three parallel slots: ctrl-u at
+1020 ms, the empty box first drawn at +1830 ms; a single 500 ms frame wait read the stale box,
pressed a bare Enter on a box ctrl-u had already emptied, and the prompt was lost). So frames are
read until the box stops showing the line, for up to `NUDGE_CLEAR_DEADLINE_MS` (3 s, ~3.7x the
measured 810 ms): an empty box is retyped, a box holding anything else is `clear_failed` and
nothing is typed, and only a line STILL in the box at the deadline gets the old remedy, one more
Enter. A second copy is never typed while the first could still be in the box. The retyped line is the same line, so the witness and read coverage
are unchanged. A panel command (`/cost`, `/usage`, `/config`: a full-screen panel, no record,
input swallowed until Esc) gets an Esc 500 ms after delivery (`panel_dismissed`), and once the empty
box is back its admission ends without a turn (`panel_command`); it used to wait the 30 s bound and
was then taken as a degraded acceptance. The prompt a session was CREATED with must be accepted
within 30 s, else FAILED `prompt_not_accepted`; a later `send_input` that is never accepted returns
the session to idle with the anomaly `send_not_accepted`. `/exit` and `/quit` are control lines, not
turns: 2.1.282–2.1.285 still write the command's caveat, `<command-name>/exit` and
`<local-command-stdout>(no content)` records into the SETTLED turn (real records in
`corpus-redacted/exit-command.jsonl`), 2.1.291 writes none; after a delivered `/exit` an IDLE session
never re-wakes, so the exit ends COMPLETED via `exit_clean`.

**`send_input` is queued (D17).** It is accepted in every non-terminal state. `send` reads the
transcript before it evaluates, so a turn whose end record already landed settles INSIDE the send;
`SettledTurn.shape` carries the shape at that moment (the send has converted a one-shot session to
interactive), and a send whose own step ended the session answers `terminal`, never a queued count. A serial pump delivers
one prompt at a time when the session is idle, marking the offset before delivery. During a question
or permission dialog a queued send presses Esc, which declines the dialog AND interrupts the turn;
the interrupted turn settles through path I and the text becomes the next prompt.

## The child's environment

The pane child must run in exactly the owner's environment and cwd (D16). A pipe spawn gave that
for free; a pane does not, because magmux starts the pane as `$SHELL -l -c`, a login shell that would
run the user's profile.

- **The snapshot.** The owner passes its environment as JSON in `CLAUDISH_PANE_ENV` — inherited,
  never written to disk, the same exposure class as the variables themselves. The child claudish
  (`pane/child-env.ts`, imported first by `index.ts`) sets every snapshot key, removes every key the
  snapshot lacks except the shell-managed ones, then deletes `CLAUDISH_PANE_ENV`. A profile that
  re-exports `OPENAI_API_KEY` or `CLAUDE_CONFIG_DIR` is undone. On Linux a snapshot over 131,000
  bytes fails the start (`MAX_ARG_STRLEN` is 131,072 per string).
- **The shim.** `SHELL=<ctl>/sh-shim`, set after the snapshot is taken: `[ "$1" = -l ] && shift;
  exec /bin/sh "$@"`. No profile runs at all — no profile prompt, no `exec tmux`, no init cost. The
  snapshot carries the real `SHELL`, which Claude Code's Bash tool needs.
- **Stripped from the pane:** `CLAUDECODE` and `CLAUDE_CODE_CHILD_SESSION` (inherited, they turn
  transcript saving off — and the transcript is the oracle); every `MAGMUX_*` key (an inherited
  `MAGMUX_SOCK_DIR` silently moves the socket); terminal-identity variables (`TMUX`, `TERM_PROGRAM`,
  `COLORTERM`, `CLAUDE_CODE_SSE_PORT`, `ENABLE_IDE_INTEGRATION`, `ITERM_*`, `VSCODE_*`, …) that
  steer a TUI's rendering and integrations; and the host identity (`CLAUDISH_LAUNCHER_PID`/`PPID`,
  `CLAUDE_CODE_SESSION_ID`), which describes the MCP server's host, not the pane's new session.
- **Added:** `COLUMNS=160 LINES=50`, the slot's `CLAUDISH_TOKEN_FILE` and
  `CLAUDISH_UPSTREAM_ERROR_LOG`, and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` when the owner left
  it unset (it suppresses side calls billed on the routed model).
- **`MAGMUX_*` survives in the child.** magmux injects `MAGMUX_SOCK` into the pane; it is excluded
  from the snapshot and kept when the snapshot is applied, so the child knows it is already inside a
  multiplexer and never wraps itself in a second magmux.
- **The child refuses to be anything but a REPL.** The owner checks `claude_flags` first
  (`checkChildFlags`: claudish's own argv, transport breakers like `-p`/`--output-format`, session
  breakers like `--resume`/`-w`, print-only Claude Code flags like `--max-budget-usd`, claudish mode
  flags, subcommand words such as `update` or `team` that `index.ts` dispatches from anywhere in
  argv, and any positional token or `--`, by claudish's own value-consumption rule). After
  `parseArgs` the child asserts it is interactive, not a team run, with no positional prompt;
  otherwise it prints `claudish: pane child refused: <reason>` and exits 64 (FAILED `child_exited`).
- `CLAUDISH_PANE_ENV` and `CLAUDISH_PANE_CWD` (`PANE_LAUNCH_VARS`) are deleted from Claude Code's
  own environment. `CLAUDISH_PANE_CHILD` is KEPT there; the next section says why.

**One level of nesting.** A `create_session` child (gpt-6.1-sol) once called the claudish MCP
`create_session` itself; that session (#969aa2) failed `prompt_not_accepted`. It was a claudish MCP
session inside a claudish MCP session. claude-runner then deleted all three markers from Claude
Code's environment, so the claudish MCP server that the child's plugins started saw no marker and
registered every tool. Nothing checked depth anywhere.

`CLAUDISH_PANE_CHILD=1` now means "this process runs inside a session a claudish owner started", and
claude-runner keeps it, so it reaches everything the session starts: the Bash tool, hooks, plugin MCP
servers. `scrubChildEnv` deletes only `PANE_LAUNCH_VARS`. Putting the flag back in that list
silently re-enables the recursion. Two predicates in `pane/child-env.ts` read it:

- `inMcpSession()`: the flag alone (exactly `"1"`). True for the pane child, its Claude Code and
  everything below them.
- `isPaneChild()`: the flag AND a non-empty `CLAUDISH_PANE_CWD`. True only for the claudish the pane
  launcher started, because Claude Code's environment no longer has `CLAUDISH_PANE_CWD`. The pane
  child's bootstrap, its REPL assertion and the `skipDangerousModePermissionPrompt` overlay gate on
  this one.

A process with `inMcpSession() && !isPaneChild()` is one level deep already. Two things act on it:

- **A model-running CLI launch is refused.** `assertNotNested()` prints
  `claudish: nested session refused: already inside a session started by the claudish MCP server; one level of nesting is the limit`
  and exits 64. It has two call sites. The first is `index.ts`, right before
  `assertPaneChildInteractive`, which covers `-p`, `--stdin`, interactive, `--team` and resume. The
  second is `team-cli.ts`, for every `claudish team` subcommand except `status` (and `--help`):
  `team` is dispatched before `runCli`, so the first site never sees it. A new model-running
  subcommand dispatched before `runCli` needs its own call. Everything that exits inside `parseArgs`
  (`--version`, `--help`, `--models`, `--probe`) and every non-model subcommand (`config`, `update`,
  `login`, `stats`, …) still runs. The pane-child refusal (`pane child refused: …`) is a different
  line and is not used for nesting.
- **`claudish --mcp` is restricted, not refused.** It registers only `run_prompt`, `compare_models`,
  `list_models` and `search_models`, declares no channel capability and uses the nested
  instructions; see [`mcp-sessions.md`](mcp-sessions.md) § Nested mode. `compare_models`, and
  `run_prompt` on a foreign model, start no child: they call a proxy in the MCP server's own
  process (`runPromptViaProxy`). `run_prompt` on a Claude model starts one `claudish -p` with
  `CLAUDISH_PANE_CHILD` dropped from its environment, so the nested refusal does not apply to it.
  That child is a leaf: no tools, no MCP servers, no setting sources, no slash commands
  (`mcp/run-prompt-claude-code.ts`), so it cannot start a session and the depth stays one.

This stops ACCIDENTAL recursion, a model reaching for the tools it was given. It is not a
containment boundary: `env -u CLAUDISH_PANE_CHILD claudish -p …` passes it, and so does anything
that starts claudish with a fresh environment. Two such routes are known and accepted. madbench
starts its MCP server through `env -i` with an explicit allowlist (`madbench/session.ts`), so the
flag never reaches it; forwarding it would put every bench of `create_session` run from inside a
session into nested mode. CLI `--grid` children (`team-grid.ts`) are print-mode children in a
visible magmux and carry no markers, so a grid child's Claude Code can still start a claudish MCP
session; that is one level below a human-visible grid, not below an MCP session.

The rule relies on Claude Code passing its full environment to plugin MCP servers (verified: a
running `claudish --mcp` showed `TMUX`, `CLAUDECODE` and `CLAUDE_CODE_SESSION_ID`). A Claude Code
that passed only the MCP SDK's default allowlist would turn nested mode off silently; the live check
is a `create_session` child listing its own `mcp__plugin_claudish_claudish__*` tools.

**No recovery watchdog in a pane child (D22).** `magmuxPaneCapability()` answers
`{kind:"none", reason:"pane-child"}` for any process inside an MCP-started session
(`inMcpSession()`), before its ambient branch. Only the pane child reaches it in production, since a
nested launch is refused first. A pane child exports no
`CLAUDE_CODE_RETRY_WATCHDOG`, installs no recovery UI and draws no overlay on the screen the
classifier reads. `network-recovery.md` §7 accepts ~300 client attempts only where a person can see
the banner; a headless pane has no viewer. Tier 1's hold still runs; an exhausted episode answers an
inline 400 and the slot is FAILED `api_error`.

## Nothing outlives its owner (D15)

Three layers, because magmux is detached into its own session and a client disconnect has no effect
on its panes: without them a SIGKILLed MCP server would leave REPLs running and billing.

1. **The pane watcher.** One detached `/bin/sh` per pane whose stdin is a pipe from the owner. EOF
   on that pipe — the owner ended by any means, SIGKILL included, because the kernel closes its end —
   makes it verify and kill the pane group and magmux, then remove the files. A clean reap writes
   `done` and it exits without signalling anything. A pipe needs no polling and no owner pid that
   could be reused. The watcher is in its own session and never in the pane group, so a Ctrl-C, a
   group kill of the server or `close_pane` never reaches it. Values reach the script only as
   positional parameters, never interpolated. **Fd hygiene was a gate**: the design needs the write
   end to exist only in the owner. Measured under Bun 1.4.0 with `lsof`: each watcher's stdin is a
   socketpair whose far end only the owner holds — neither magmux nor a sibling watcher has it — and
   746 ms after an owner SIGKILL with two panes, no process and no file was left (the registry test
   asserts it, 955 ms in its own run). An earlier watcher took 7,548 ms, looping `while read` over a
   1,700-row `ps` with fixed sleeps; it now filters with awk and polls.
2. **Pane records and the startup sweep.** `<root>/panes/<paneId>.json` (0600) records the owner's
   pid and start time, the watcher, magmux and pane pids, the uuid and both directories. Before its
   first spawn on a root, a process sweeps it once (`ensureSwept`): records whose owner is dead and
   whose watcher is gone are killed after identity checks and removed; a recordless
   `magmux-c<pid>-*.sock` whose owner is dead is probed and cleaned.
3. **Shutdown hooks.** SIGINT, SIGTERM, SIGHUP and, for the MCP server, stdin EOF/close run the
   owner's `before` (the MCP server ends its session and team records there) and then reap every pane
   in parallel, then exit 128 + n (0 for stdin). `stats-buffer.ts` used to exit synchronously on
   SIGTERM from a module-load listener before any record was ended; `signal-owner.ts` now lets the
   pane registry claim the exit.

**Identity before every signal.** A bare pid is never signalled unless it is this process's own
unreaped child (magmux and the watcher, through their `ChildProcess` handles, which Node refuses to
signal once reaped). magmux is identified by `--id <paneId> --sock-dir` in its command line — the id
is unique, so a reused pid cannot match. The pane group is identified by a (pid, start time) member
recorded while the group's identity was verified (a member's argv contained `--session-id <uuid>` or
`<ctl>/pane-launch.sh`): a pgid is not reused while any member lives, so the check holds even when
only an unidentifiable grandchild is left. Every table read is one `LC_ALL=C ps -ax -ww -o
pid=,ppid=,pgid=,lstart=,command=`, and every `ps` on the reap and registry paths is ASYNC: a
synchronous `ps` polled every 25 ms by concurrent reaps stalled the event loop long enough for magmux
to drop our sockets as slow consumers (seen as `delivery_failed` and missed activity).

**The reap**, one shared promise per pane: refresh the verified group; `close_pane {force:true}`
and wait for `pane_closed`; wait for magmux to exit, else SIGTERM then SIGKILL through its handle;
then the **group backstop** — SIGTERM, then SIGKILL, `-pgid` while the group check passes. `force:true`
is not enough on its own: magmux kills the group only while the pane leader is unreaped, so bun,
claude and a Bash-tool grandchild survive it. Measured with a fake child that traps SIGTERM: magmux's
forced close sends the pane SIGHUP and kills it before the backstop is needed. Only after the group
and magmux are verified gone are the socket, record and directories removed and the watcher told
`done`; otherwise the record keeps `reapFailed: true`, the watcher stays (it finishes the job when the
owner ends), `reap_unverified` is recorded and the registry retries every 2 s. Worst case ≈ 12 s;
`cancel` returns before the reap finishes. The shutdown reap is the same in parallel with short
timeouts, ≈ 3 s for any number of panes.

**The limit.** At most `MAX_LIVE_PANES = 48` live panes per user, counted across every claudish
process from the pane records (one pty and ≈ 15 MB each; `kern.tty.ptmx_max` is 511). An owner
reserves N panes before a run's spawn loop; each start consumes one, whether it succeeds or not.

## magmux socket traps

- **Always pass `--sock-dir`**, and strip `MAGMUX_*`: an inherited `MAGMUX_SOCK_DIR` moves the
  socket (measured). An invalid `--id` or `--sock-dir` is IGNORED, with exit 0 and a stderr line, and
  magmux binds somewhere else; `ignoring --id`, `ignoring --sock-dir` and `magmux: socket` on stderr
  are therefore fatal (`pane_lost`). Ids are validated client-side (`[A-Za-z0-9_-]{1,64}`, not all
  digits — an all-digit id collides with a pid socket).
- **A socket path must be under 100 bytes**, or the bind fails; `sockPathFor` asserts it, which is why
  test roots are `/tmp/cpt-<8 hex>`.
- **`--id` sockets are never reaped after a SIGKILL** (seven stale ones were found during research).
  claudish unlinks its own sockets, and the sweep cleans recordless ones.
- **EOF is not death.** magmux keeps its panes when a client leaves, and it closes slow subscribers
  on its own. A dropped connection is redialled with backoff while the magmux process lives
  (`socket_reconnected`), every attach re-subscribes (`capabilities`, `watch`, `list`), and while
  disconnected the pane's liveness is `kill(panePid, 0)` every second. Only the magmux PROCESS dying
  without an `exit` for the pane is `pane_lost`. Twenty consecutive ENOENT dials record `socket_lost`.
- **claudish owns `seq`.** magmux's frame `seq` restarts at 1 whenever its framer is recreated — on
  every reconnect (measured `1K 2 3 4K 1K`) — so it cannot back `capture(since_seq)`. One persistent
  `watch {mode:"frames", fps:4}` per pane feeds an in-memory screen whose `seq` is 0 until the first
  frame and then grows by one per visible change (text, spans, cursor, alt screen, size) for the
  pane's life. `capture` and `capture_session` are memory reads. `aboveBoxChangedAt` moves only when a
  row ABOVE the input box changes, so the status line ticking under the box never holds a quiet window
  open. 4 fps (research recommended 2–4) halves boot, witness and settle latency at no idle cost.
- `assertMagmuxAvailable` requires `magmux --version` ≥ 0.14.0 (cached per binary), and every
  connect re-checks `capabilities` (`protocol: 1`, version ≥ 0.14.0). claudish never substitutes print mode.
  The release job bundles a pinned magmux and checks the pin against `MIN_MAGMUX_VERSION`.
- **Latent, outside this driver:** `team-grid.ts` (CLI `--grid`) does not pass `--sock-dir`, so an
  inherited `MAGMUX_SOCK_DIR` would move its socket (F7).

## Bounds (D9, D10)

- **`team(mode:"run")` returns once every slot has left STARTING**: its prompt was accepted
  (RUNNING) or it failed boot or admission. Bounded by boot 90 s + admission 30 s; with the fake child
  a slot reaches RUNNING in 1.2–1.9 s. The dev plugin's team gate polls until no slot is RUNNING, so
  a slot still STARTING on its first poll would end the gate with zero ballots. Slots of one run spawn
  300 ms apart, so N REPLs do not write `~/.claude.json` in the same instant.
- **No claudish timer ends a team slot after its prompt was accepted.** Boot and admission bound
  only the time before any work exists. Stop hooks and background agents are waited for without a
  bound. An MCP session's `timeout_seconds` is the caller's own deadline and the only
  post-acceptance timer. See [`team-lifecycle.md`](team-lifecycle.md).

## The phase table

`pane/slot-state.ts` is a transition table over internal phases; `wireState()` is the only place a
phase becomes a contract `SlotState`. Illegal transitions are refused and recorded, never thrown;
terminals absorb, so a late pane `exit` cannot overturn a CANCELLED or TIMEOUT.

| phase | wire state | leaves by |
|---|---|---|
| BOOTING | STARTING | boot ready (IDLE, or ADMITTING with a queued prompt); dialog, blocked screen, 90 s → FAILED |
| ADMITTING | STARTING for the prompt the session was created with, else RUNNING | witness → RUNNING; 30 s → FAILED `prompt_not_accepted` (created prompt) or back to IDLE (a later send) |
| RUNNING | RUNNING | question → QUESTION; permission → PERMISSION; `decide` → IDLE (`continue`) or COMPLETED / EMPTY / FAILED |
| IDLE | AWAITING_INPUT | queued send → ADMITTING; background re-wake → RUNNING (same turn); clean exit after `/exit` or ≥ 1 settled turn → COMPLETED |
| QUESTION | AWAITING_INPUT | the tool resolves → RUNNING; `onBlocked` verdict → FAILED |
| PERMISSION | AWAITING_PERMISSION | same as QUESTION |
| every live phase | — | pane exit or magmux death → FAILED (`agent_rejected`, `child_exited`, `pane_lost`) unless the current turn's own evidence settles it (path X); cancel → CANCELLED; timeout → TIMEOUT |

`initialDelivery` is keyed on the delivery, never the turn index, so a promptless session's first
send goes AWAITING_INPUT → RUNNING and never back to STARTING. `onTransition` reports the NET wire
change of one event-processing step, synchronously and before any frame: a turn that settles with a
send queued (RUNNING → IDLE → ADMITTING in one step) reports nothing and opens no wait. Policy is the
owner's (D8): `decide(turn)` and `onBlocked(block)`.

## The mod contract, version 1 (frozen)

A peer's Claude Code mod polls claudish at about 1 Hz to draw every slot and session. Its wire
types live in **`pane/contract.ts`**, the single source; within version 1 no field changes meaning or
type and new fields may only be added.

- `SlotState` is a closed set of nine: STARTING, RUNNING, AWAITING_INPUT, AWAITING_PERMISSION
  (non-terminal), COMPLETED, FAILED, CANCELLED, TIMEOUT, EMPTY (terminal). `FailureReason` is a
  closed set of fifteen, produced by both owners.
- A `SlotRow` per team slot is also the base of every `list_sessions` row: state, reason, tokens in
  and out, `cost_usd` (always null for native Claude routes — Claude Code's own cost is API-rate
  pricing, fictional spend for a subscription user; D12), tool calls, turns completed,
  `last_activity_at`, `idle_seconds`, `activity` (`thinking`, `background`, `finishing`, a tool name,
  `AskUserQuestion`; unknown values mean busy) and `pane`.
- `reason_detail` (added within v1, 2026-10-16) is one line, at most 160 characters, saying why
  `reason`: for `api_error` the provider's `error.message` from the LAST record of the upstream-error
  capture (`errors/<slot>-upstream.jsonl` for team, `upstream-errors.jsonl` for a session), else the
  child's API-error text with claudish's "The turn ended in an API error (status N): API Error: N"
  boilerplate stripped; for every other reason, the first line of the verdict's detail (the dialog or
  screen text of `boot_blocked` / `first_run_dialog`, the question of `blocked`, the exit line of
  `child_exited`, the refusal of `agent_rejected`). Null on every non-terminal state, on COMPLETED,
  and when nothing readable exists. Only `error.message` is ever lifted from an upstream body —
  bodies carry `user_id`. One pure function, `reasonDetail()` in `pane/reason-detail.ts`, computes
  it for both row builders (`toSlotRow` / `teamRunRowFromDisk` and `sessionRowOf`); the capture file
  is read (16 KB tail) only for a terminal `api_error` row.
- `recent` (added within v1, 2026-10-17) is the last 20 steps of the current turn, oldest first,
  each `{at, kind, tool, summary}`: one per main-chain assistant block after the witness (text,
  thinking, tool_use; an AskUserQuestion tool_use is `kind:"ask"`), `at` the record's own
  timestamp. It exists so the mod can draw a running line (a badge, the step's words, and its
  duration to the next step's `at`) without polling fast enough to see every step: at 1 Hz,
  `activity` alone drops any tool shorter than the poll interval and can say `Bash` but never
  which command. The summary is ONE line, at most 100 characters, from ONE named input field
  (`file_path` for Read/Edit/Write, the first line of `command` for Bash, `pattern` for
  Grep/Glob, `query`, `url`, `description` for Task/Agent, the first question for an ask, the
  first line for text and thinking; empty for any other tool), and it goes through
  `redactSecrets`: a Bash line or a url can hold a token. Nothing from a tool result is ever
  read. Paths keep the home directory, unlike `report_error`'s sanitizer, because the rows never
  leave the machine. Null before the first step and on rows built from disk (no live follower,
  as for `activity`); kept after the turn settles until the next turn opens. `pane/slot-steps.ts`
  (`stepOf`), fed by `applyAssistant` in `pane/transcript-follower.ts`.
- Verbs: `team(mode="list")` → `{contract_version, capabilities, runs}`; `team(mode="status")` adds
  `contract_version`, `capabilities` and a `run` row to its payload; `team(mode="cancel")` and
  `cancel_session` return per-slot `{state, changed}`; `team(mode="capture")` and `capture_session`
  return the 160×50 screen `{seq, cols, rows, cursor, lines, final, spans?}` or
  `{unchanged:true, seq, final}` when `since_seq` is current. Errors are a JSON `ContractError`
  (`unknown_run`, `unknown_slot`, `unknown_session`, `invalid_args`).
- `run_id` (`<team_session_id>-<base36 start ms>-<6 hex>`) addresses one run even after a newer
  run reused its path, while the server retains it (30 minutes after it settles, at most 20 settled
  runs). A path holds at most one ACTIVE run.
- `contract_version: 1` and `capabilities` let the mod tell a pre-contract claudish from an
  unreachable server without parsing prose.

## Where to look

| file | what |
|---|---|
| `pane/pane-session.ts` | `PaneSession`, `startPaneSession`: spawn order, boot, admission pump, settle, exit path, reap |
| `pane/settle-rule.ts` | the pure P/I/S/X decision and `SECONDARY_QUIET_MS` |
| `pane/transcript-follower.ts` | the turn-scoped reducer: witness, waking records, background balance, read coverage, answer start |
| `pane/screen-model.ts`, `pane/screen-classifier.ts` | frames → screen with our `seq`; boot, dialogs, working row, degraded answer |
| `pane/prompt-delivery.ts` | delivery by kind, the turn file, line splitting |
| `pane/pane-launch.ts` | root, ids, environment, launcher, shim, flag check, magmux check, spawns |
| `pane/process-identity.ts` | the identity predicates and the generated watcher script |
| `pane/pane-registry.ts` | records, the cross-process limit, shutdown hooks, the sweep |
| `pane/child-env.ts` | the pane child: snapshot, cwd, pane-child refusal; `inMcpSession`/`isPaneChild` and the nested refusal |
| `mcp/nested-mode.ts` | the nested MCP tool list and instructions |
| `pane/contract.ts` | the frozen mod contract v1 |
| `pane/session-registry.ts` | the child's session-registry record, by session id (telemetry) |
| `scripts/boot-canary.ts` | boot every spawn shape against one Claude Code binary; `.github/workflows/boot-canary.yml` runs it per release on macOS and Linux |
| `scripts/pane-drive.ts` | drive one session from the command line (`--fake <scenario>` for the hermetic fake) |
