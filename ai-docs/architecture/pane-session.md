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
   └── spawn, detached ──▶ magmux --headless --no-status --controller claude-code --session-id <uuid>
                                  --transcript <transcript path> --id <paneId> --sock-dir <root> -e ". <ctl>/pane-launch.sh"
                               COLUMNS=160 LINES=50 (launch size), SHELL=<ctl>/sh-shim
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
- **The pane is DECLARED to magmux's Claude Code controller**, and that declaration is bound to one
  transcript: `--controller claude-code --session-id <uuid> --transcript <path>` comes before the
  `-e` it binds, with the same uuid claudish passes Claude Code and the same path its transcript
  follower derives ("The transcript binding" below). `--id <paneId> --sock-dir` stays adjacent:
  that pair is how the reap, the sweep and the watcher recognise the pane's magmux.
- **The pane command must still never name `claude`.** magmux attaches its controller to a direct
  `claude` command by itself (gate basis `direct`): by its mtime discovery, not by name, and with
  Claude Code's `--settings` rewritten. `paneCommand()` throws rather than produce such a command.

## The transcript is the turn oracle; magmux's input gate decides input

magmux supplies liveness (`exit` events, pids), the screen (`watch` frames), input (`send`) and,
for a declared pane, its **input gate**: a gated `send` waits for the input box, types, verifies
the box holds exactly the text, presses Enter and replies once it has attributable evidence, and
`list` publishes the pane's `input` readiness (`ready`, `reason`, `detail`). claudish reads every
INPUT decision from the gate (is the REPL ready, is a dialog open, was the prompt submitted) and
every TURN decision from the transcript (when a turn ended, its answer, its accounting). It never
reads the controller's own turn state, nor `list`'s `prompt`/`response` keys.

The split is by evidence class. The gate reads this pane's own screen, termios and history; a
turn's ending is only in the transcript (`turn_duration` waits for Stop hooks, the screen does
not), and "running" on the screen right after a `send` proves nothing: every PTY write clears
magmux's `inputReady`, and its idle heuristic re-promotes the pane 5 s after the last printed text.

Settle, the answer and the accounting therefore come from the transcript Claude Code
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
one. The turn is ACCEPTED at the input gate's confirmation ("Delivery mechanics") or when its
**witness** appears after the offset, whichever comes first; settle needs the witness either way.
The witness is a main-chain user record
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
That lag is why acceptance no longer waits for the witness: the gate's `evidence:"history"` is read
from this pane's own screen and does not wait for the hook. A gate-accepted turn whose transcript
is readable but shows no witness 30 s (`ADMIT_TIMEOUT_MS`) later records `witness_missing` once and
stays RUNNING; no timer ends it (D10). What Claude Code writes for a prompt a UserPromptSubmit hook
BLOCKS was not measured.

The follower polls on every frame (debounced 250 ms) and on a 1 s backstop.

## The transcript binding: why magmux ≥ 0.17.0

magmux's gate reads the pane's transcript and Claude Code's session registry: for readiness, for
its `evidence:"transcript"`, and for the `convChange` test that keeps its one automatic retype from
submitting a second copy. In 0.16.0 it found that transcript by DISCOVERY, and for a claudish pane
discovery can pick the wrong one (read in source, `controller_claude.go:532-645` at 4c6060c):

- the pane command carries no prompt (`-e ". pane-launch.sh"`), so discovery takes the newest
  `.jsonl` in the cwd's project directory, "fresh" preferred, and "preexisting" marks only the files
  present at the controller's FIRST scan;
- the child writes no transcript until its first prompt is accepted, so for that whole window the
  candidates are only OTHER sessions' files: a sibling `team` slot in the same cwd started 300 ms
  later, or the parent Claude Code session, still being written;
- claims are per magmux PROCESS, and every claudish pane is its own magmux, so no claim excludes a
  sibling's file; and discovery read `os.UserHomeDir()`, not `CLAUDE_CONFIG_DIR`.

A pane locked onto another session can report `busy dialog:<kind>` for a dialog that is not on its
own screen, and can see "a turn started" in the other session and refuse its retype (a false "may
have been submitted"). So claudish requires the binding magmux 0.17.0 introduced (the floor is
now 0.18.0, for deep socket paths; see "magmux socket traps"): it takes `--session-id` and
`--transcript` bound to the `-e` that follows, claims exactly that file (also before it exists),
never falls back to discovery, and echoes the binding per pane in `list`.

**The binding check, on every attach** (`gate-binding.ts`, first connect and every redial): pane 0
must show `gateBasis: "declared"`, an `input` object, `bound: "named"`, `sessionId` equal to the
uuid, and `transcriptPath` equal to the follower's path. Both paths are compared after resolving
their deepest EXISTING ancestor with `realpath` (the file and often its project directory do not
exist before the first prompt, and `/var` must equal `/private/var`). Anything else is FAILED
`pane_lost` with detail `input_gate_unavailable: …` or `input_gate_unbound: magmux <v> bound pane 0
to <path> (<bound>), not <ours>: <what differs>`; a failed `list` is `input_gate_unbound … list
failed`. Until the check passes on a connection, no gate reading from it is read and no send is
made. `transcriptSeen: false` is normal before the first prompt and is not read. Measured on 0.17.0
(fake child, hermetic env): `bound named`, the claudish uuid and the path under `CLAUDE_CONFIG_DIR`,
50 ms after launch, before any transcript file existed.

**What the gate is read from.** magmux publishes no readiness event (`snapshotChanged` does not
compare `input`), so `PaneSession` polls `list` every 250 ms (`GATE_POLL_MS`; magmux refreshes
`input` at 4 Hz), one request in flight, reply timeout 1 s. A reading older than 1 s
(`GATE_STALE_MS`), or any reading while disconnected, is UNKNOWN, and unknown is never a decision.
The same reply's `pid` and `dead` back the `exit` event: pane 0 dead for 1 s with no event records
`exit_event_missing` and takes the exit path. Only the documented `input` fields are read
(`ready`, `reason`, `detail`); `ready: true` already means the box is EMPTY, because the published
view is computed with the typing query and refuses `box_not_empty` last, after every dialog and
vim test (`controller_claude.go:411`, `controller_claude_input.go:360`).

## The session registry: a second reader, telemetry only

Every interactive Claude Code writes `<CLAUDE_CONFIG_DIR or $HOME/.claude>/sessions/<pid>.json` and
rewrites it on each state change: `status` is `idle`, `busy`, `waiting` (with `waitingFor`:
`permission prompt`, `input needed`) or `shell` (a background Bash still running after the turn); the
first record has no `status` for 100–440 ms. Its `sessionId` is the `--session-id` claudish mints, so
`pane/session-registry.ts` finds the pane's record by that uuid (11/11 measured), never by a bare
pid, and drops a record whose pid is dead. It reads the raw file because `claude agents --json`, the
documented reader, refuses under a user's `disableAgentView` and omits fields; the file itself is
undocumented, and a torn write can leave a trailing `}` (#96438), which the parser tolerates.

It is TELEMETRY in claudish: no claudish decision reads it. (magmux's gate does read it, by the
bound session id, for its own readiness.) Each evaluation compares it with the input gate and
counts the onset of a disagreement held for 2 s as an anomaly — `registry_record_missing` (no live
record 5 s after boot was ready), `registry_idle_gate_starting` (registry idle while the gate still
says `starting`/`no_input_box`, held 5 s because the gate legitimately says `starting` for up to
its 3.5 s boot floor plus 1 s of stillness; the signature of the `--agent` border bug, and the
canary for magmux missing the box at a new width), `registry_idle_screen_working` (registry idle,
a working row on the screen), `registry_waiting_gate_no_dialog`, `gate_dialog_registry_not_waiting`, and
`registry_status_unknown:<status>`. Two more compare the gate with the screen:
`gate_ready_box_not_located` (gate ready, `locateBox` null) and `gate_dialog_screen_unrecognised`
(gate `dialog:permission|plan|question`, the closed dialog list does not match). Comparisons with
the gate are skipped, neither counted nor reset, while the gate reading is unknown. The research
that measured the registry — readiness 20/20 idle and 19/20 under load, dialog open 34–36 ms ahead
of the screen, correct through `/compact`, auto-compaction and background work where the screen is
not — is `ai-docs/reports/pane-ui-independent-signals.md`. These field counts decide, later,
whether the remaining screen cross-checks can go.

**Not used: an in-child mod.** A Claude Code mod loaded with `--plugin-dir` reports busy, dialogs and
submits from inside the child, but it is early access, Anthropic can serve it off remotely with no
local override (#99130), and it delays SessionStart by about 250 ms. Parked in `ROADMAP.md` with its
trigger. Nor is any of its prompt paths, the messaging socket or an argv first prompt a delivery
route: a pane child receives every prompt the way a user gives it — typed, pasted, or an image paste.

## Boot: ready when the gate says so, and never accept a dialog

Boot is ready when the input gate's published `input.ready` is true. claudish no longer reads the
box for it: magmux's readiness already requires the box and a raw terminal both still for 1 s, AND
either an observed boot stdin reset or 3.5 s since the terminal first went raw. Measured spawn → empty box on the real
child: 0.67–1.97 s with catalog warm-up off (the ≈11 s of earlier research included claudish's 4–7 s
catalog warm-up). The fake child never blips termios, so it waits the floor: `ready` at 3.9–4.2 s
(magmux 0.17.0).

**Why magmux waits for the boot reset.** Claude Code draws the box and then, 1–2 s later, resets
stdin (a termios cooked→raw blip). A line typed into that window is lost or sits in the box
unsubmitted, in normal editor mode as well as vim. Measured 2026-10-16 (Claude Code 2.1.301, magmux
0.15.1, magmux owner): with the box stable for 500 ms and `--settings {"editorMode":"normal"}`, 2/2
team slots failed `prompt_not_accepted`, the retry failed one, and the third try got through. A
stable box is not proof the child reads its input. claudish used to wait the reset out itself (box
stable 3 s, `REPL_STABLE_MS`, ≈2.5 s per boot); magmux now does, and if a reset still lands after
`ready`, its gated send retypes once and says so (`retypeCause: "terminal_reset"`, counted as
`gate_retyped:terminal_reset`). A rising count is a boot floor too short for some Claude Code.

What blocks boot is decided by **the gate not being ready on a screen static for 5 s**
(`BOOT_STATIC_MS`), and named by the gate's dialog kind first, the screen's words second:

| gate (static 5 s, not ready) | outcome |
|---|---|
| `dialog:trust`, `dialog:bypass`, `dialog:api_key`, `dialog:onboarding` | FAILED `first_run_dialog`, the dialog's words from the screen (`dialogText`) in `detail` |
| any reason, with a named first-run marker on screen (`Choose the text style`, `Is this a project you created or one you trust`, `running in Bypass Permissions mode`, `Detected a custom API key in your environment`) | FAILED `first_run_dialog`; magmux files a reworded boot dialog under `select` |
| `vim_mode` | FAILED `boot_blocked`, `vim editing mode is on (-- INSERT -- under the box)` |
| `dialog:select` or another `dialog:*` | FAILED `boot_blocked`, screen text in `detail` |
| `starting`, `terminal_not_ready`, `no_input_box` with choice markers on screen (`Press Enter to continue`, numbered Yes/No rows, a selection footer — e.g. `New MCP server found in this project`, which magmux has no kind for) | FAILED `boot_blocked`, screen text in `detail` |
| not ready at 90 s | FAILED `boot_timeout`, or `boot_blocked` when the screen is static and the gate names a dialog or the screen names something; `detail` ends `gate: <reason> (<detail>)` |

Under `--agent` the top rule carries the agent's name at its right end (`──── dev:reviewer ─`);
until 10.4.2 claudish's own box test refused that one label and every slot given an `agent` failed
`boot_timeout` at 90 s with a ready box on screen (fixture `repl-boot-agent`). The gate's
`registry_idle_gate_starting` comparison is the canary for the same class of miss on magmux's side.

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
forced over the caller's. This key stays: magmux forces normal mode only for a DIRECT `claude`
pane; for a declared wrapper its `editorOverride` is `delegated` ("the wrapper must force normal
mode itself"). If vim mode is on anyway, the gate refuses to type (`vim_mode`) and the prompt fails
with `vim editing mode is on` — at once when the published view already says so, else after the
in-flight send's ready wait (≤ 10 s) — instead of sitting unsent. The API-key dialog was not recaptured on 2.1.290 (it needs a foreign route with
`ANTHROPIC_API_KEY` set); its marker is the verbatim 2.1.287 text. It cannot occur in a pure-proxy
pane: such a pane child sets no `ANTHROPIC_API_KEY` (and deletes an inherited one), only the placeholder
`ANTHROPIC_AUTH_TOKEN`, which alone suppresses login (`applyProxyPlaceholderAuth`; verified on
Claude Code 2.1.304, where an env key raised "Detected a custom API key in your environment").

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

| path | evidence | gate corroboration |
|---|---|---|
| **P** | `system/turn_duration` after the last assistant message, `pendingBackgroundAgentCount` 0 (absent means 0), background agents balanced, no pending tool | yes |
| **I** | `[Request interrupted by user…]` after the last assistant message; `turn_duration` optional | yes |
| **S** | no `turn_duration`: an ending `stop_reason`, Stop hooks KNOWN finished, and no transcript append and no change above the located box for `secondaryQuietMs` (the transcript quiet alone when no box is located) | yes; records `settled_without_turn_duration` |
| **X** | the pane has exited: an ending `stop_reason` and nothing waking after it | none (the pane is gone) |
| **L** | a LOCAL slash command: its `<local-command-stdout>` after the witness and no assistant message; the answer is that stdout | yes (none once the pane exited) |

Corroboration is: no further main-chain chat record for 500 ms, and the input gate's fresh reading
is `ready` (which already means an EMPTY box) with no dialog, and no working row is drawn above the
box located by the cursor. **Corroboration can delay a transcript-proven ending, never veto it.**
When it cannot confirm idle, the turn settles anyway once the chat has been quiet for 32 s
(`GATE_GRACE_MS` = `secondaryQuietMs`), with `settle_gate_unconfirmed:<why>`: the gate's reason
(`box_not_empty`, `dialog:<kind>`, `starting`, …), `working`, or `gate_unknown` for a stale reading
on a connected session. That window confirms an ending Claude Code already recorded, the same
standing as S's window, so D10 holds; and a turn can no longer stay RUNNING for good on a box
claudish failed to find, which the old hard veto allowed. A box that is not located is unknown and
never vetoes. A pending tool still blocks P before corroboration is consulted, so an open dialog
cannot be settled through. While the socket is disconnected the screen and gate are stale, so P and
I settle at once with `screen_unverified` and S waits for the reconnect.

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
Claude Code's end-of-turn record has not arrived) and nothing above the located box has changed
(the transcript's quiet when no box is located), with no Stop-hook row anywhere on the screen, for
3 × `secondaryQuietMs`, the anomaly `turn_end_record_missing` is added (R3-M4) and the team
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

**Blocked.** A pending `AskUserQuestion` comes from the transcript alone. Any other pending tool
is blocked only when the gate names the dialog: `dialog:permission` or `dialog:plan` → PERMISSION,
`dialog:question` → QUESTION; any other reading, or an unknown one, stays RUNNING — an honest
unknown, never `blocked`. The question's text is read from the screen (`dialogText`: the non-empty
rows below the last `⏺` row, with no box test), because `input` carries only the kind. claudish's
own closed dialog list (`choiceDialog`, R3-H1: a named header such as `Do you want to proceed?`,
`Do you want to create|make this edit to|overwrite|delete …?`, `Would you like to proceed?`, the
`Enter to select · ↑/↓ to navigate` footer, and a `1.` option row below the last `⏺` block) no
longer decides; it is the cross-check behind `gate_dialog_screen_unrecognised`. Numbered prose with
a `No, …(esc)` line over a running Bash stays a captured negative fixture. The owner decides what a block means: team fails the slot `blocked` with the
question as its detail (D19, team has no answering verb); an MCP session waits in AWAITING_INPUT or
AWAITING_PERMISSION. A caller reaches a permission dialog only through `--permission-mode plan`:
`-y` beats `--permission-mode default`, and `--no-auto-approve` is reserved.

**Degraded mode, per turn: settle only, never acceptance.** A turn is never accepted from the
screen any more; degraded mode begins only AFTER the gate accepted the prompt with evidence, so it
can produce an EMPTY answer only for a prompt that really was submitted. When the transcript is
off, or still absent or empty 10 s (`DEGRADED_ENTRY_MS`) after that acceptance, the turn settles
from the screen: gate `ready` with no dialog (a fresh reading required), no working row above the
located box, an answer or error row present, and 6 s of quiet above the located box (the whole
screen's quiet when no box is located, stricter because the status line ticks). It records `degraded_mode`, the
turn's `turnSource` is `screen`, and it REVERTS (`degraded_reverted`) as soon as the transcript shows
the witness — a slow UserPromptSubmit hook is the usual cause. A screen-settled turn records
`screen_answer_may_be_truncated`, and a file-delivered one `read_coverage_unverified`.

## The input box is located by the cursor, and what still reads the screen

The screen is now read only for TEXT and for quiet, never for an input decision. Where a reader
needs to know which rows are the input box, `locateBox` (`pane/box-locate.ts`) finds it from the
frame's hidden cursor: the nearest rule row within 40 rows above the cursor and the nearest below
it, a rule being `─` from column 0 to the row's end, at least 20 cells, with at most one ` label ─`
tail (the `--agent` name); the row under the top rule must be the prompt row (`❯` + U+00A0, a bare
`❯`, or `!` in bash mode); and neither that row nor the cursor row may be a SELECTED option, `❯` +
an ASCII space + a number + `.` — the box prompt is `❯` + U+00A0, so a prompt typed as `1. Red` is
still the box. An AskUserQuestion footer below the rules is a dialog, not the box. Anything else is
"not located", an unknown: it never vetoes and never counts as a box.

Why the cursor and not the rule's width: the old test (`isBoxRule`, a rule at least `cols − 1`
long) held only at the captured widths. In every captured REPL screen from 80 to 500 columns the
hidden cursor sits on the box's text row (on the last row when the typed line wraps), also while
working and during a UserPromptSubmit hook, and inside the dialog when one is open; every rule spans
exactly the full width (350 × 80 and 500 × 100 captured on 2.1.303, plus the same six states reached
by growing a 160 × 50 pane with magmux's `resize`). All screen test data carries a `cursor`.

| reader | what it reads | box needed? |
|---|---|---|
| `aboveBoxChangedAt` (screen model) | the quiet above the box, for S and degraded settle | located; a change while either frame is unlocated counts as above-box |
| `workingAboveBox` | the working row, for corroboration | located; `null` (no veto) when not |
| `menuAbove` | the slash menu's highlight, before a command's Enter | located; else `menu_unverified` and no Escape |
| `screenAnswer` | the degraded answer | ends at the top rule found by the old `isBoxRule` test, else at the screen's end; a rule row ends a prose block, so the fallback cannot pull the box or status line into the answer |
| `dialogText` | a dialog's or boot dialog's words | no: the rows below the last `⏺` |
| `nameBootScreen` | a named first-run marker or choice markers on a static boot screen | no |
| `stopHookRunning`, `transcriptSavingOff`, `screenErrorRows`, `agentRejectedLine` | Stop-hook row, saving-off notice, error rows, the `--agent` refusal | no |
| `isWorking`, `choiceDialog` | telemetry cross-checks only (`registry_idle_screen_working`, `gate_dialog_screen_unrecognised`) | the old `isBoxRule` test |

`isBoxRule` (a rule at least `cols − 1` long) and the readers built on it (`inputBox`, `readBoot`)
remain for the degraded answer's end row, the two telemetry checks, the boot canary and their own
tests; no readiness, acceptance, dialog or corroboration decision calls them.

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

**Delivery mechanics: one gated send.** Every line goes through ONE gated magmux `send`
(`{text, typed:true, readyTimeoutMs}`, Enter included), never `noGate`, never `dismissDialogs`. The
gate waits for the box to be ready and empty, types, re-reads the box from 150 ms after the last
byte every 40 ms for at least 1.2 s (`SendVerifyMin`), presses Enter only when the box holds EXACTLY
the line, and replies only with attributable evidence. Ctrl-u and Escape are KEYS sends, which the
gate never touches. `pane/input-gate.ts` translates each reply into a closed `SendOutcome` and
`PaneSession`'s admission loop switches over it exhaustively, at most one gated send in flight:

| reply | Enter pressed? | what claudish does |
|---|---|---|
| `ok`, `evidence:"history"` (`accept` `confirmed`, `resent_enter`, or `submitted_by_other`) | yes | accepted: RUNNING. `resent_enter`, `submitted_by_other` and `retyped` are counted (`gate_resent_enter`, `gate_submitted_by_other`, `gate_retyped:<retypeCause>`), never failures |
| `ok`, `evidence:"transcript"` | yes | accepted only if claudish's own witness is present, else treated as `unconfirmed` (`gate_transcript_evidence[_unwitnessed]`) |
| `busy` `starting`, `terminal_not_ready`, `no_input_box`, `typing_in_progress`, `queue_full`, `in_flight` | no | next attempt after 250 ms |
| `busy` with `typed:true`, `busy box_not_empty`, `not_accepted text_mismatch` | no | the next send first clears the box (below); after a mismatch it waits 1 s for a late draw |
| `busy vim_mode`, `busy dialog:trust\|bypass\|api_key\|onboarding` | no | stop, never a key: `prompt_not_accepted` (vim) or `first_run_dialog` |
| `busy dialog:permission\|question\|plan` | no | wait for the dialog to leave, within the deadline; a re-woken turn owns it |
| `not_accepted empty_box` | no | next attempt; on a command's Enter step, `gate_command_left_box` and no retype (below) |
| `not_accepted still_in_box` | yes, ignored | witness present → accepted; else once: ctrl-u and one more attempt; twice: wait for the witness |
| `not_accepted unconfirmed`, `text_mismatch` with `maybeSubmitted`, a lost reply (`client_timeout`, `client_lost`) | maybe | NEVER typed again. Only claudish's own witness can accept, until the deadline |
| `bad_request`, `unknown_verb`, `unsupported`, `internal` | — | stop: `send_bad_request` / `send_unexpected:<code>` |
| `pane_dead`, `no_such_pane` | — | the exit path decides |

**`maybeSubmitted` (magmux 0.17.0).** A `text_mismatch` has two variants that say it is UNKNOWN
whether the text was submitted: the box showed the text and then emptied without magmux's Enter
("leftBox"), or stayed empty while the conversation moved ("convMoved"); both end "check the
conversation before sending it again". claudish reads the reply's `maybeSubmitted` field, with that
phrase as the fallback for a reply without it, sends nothing more for that prompt and waits for its
own witness; at the deadline the prompt fails with `magmux could not tell whether the prompt was
submitted (the box emptied without its Enter) and no transcript record of it appeared`. A witness
that arrives after the deadline re-wakes the idle session as that same turn (`late_witness`): a
prompt that WAS submitted is reported late, never lost. The cost is accepted: if Claude Code starts
a turn by itself while a claudish line is typed and never drawn, magmux answers convMoved although
nobody submitted it, and the caller sees a loud failure it can resend instead of a possible
duplicate.

**Leftover text is cleared BEFORE a send, from the published view.** A typed gated send into a
non-empty box types nothing and waits its WHOLE `readyTimeoutMs` before answering `busy
box_not_empty`, as `busy vim_mode` and `busy dialog:<kind>` do. So before every send that types,
claudish reads the fresh published `input`: `box_not_empty` (or text this admission itself may have
left) → KEYS ctrl-u, then up to 1 s for a `ready` reading received at least 250 ms after the reply
that left the text (magmux republishes at 4 Hz, so an earlier reading can predate a late draw);
`vim_mode` or a boot dialog → stop now; a permission, question or plan dialog → wait for it to
leave. Because `box_not_empty` is evaluated last by the gate, it already proves no dialog and a
settled terminal, so that ctrl-u cannot land on a dialog. A lost TYPE reply on a new connection
waits out the old delivery's own budget first, since a ctrl-u from another connection is not
ordered behind it. Measured (I10b, magmux 0.17.0): vim mode on before the send stops in 2.2 s wall,
boot included; a send already in flight when vim turns on still costs its ready wait (≈ 10 s).

**Every attempt fits the 30 s admission.** The client request timeout is magmux's own upper bound
(`protocol.SendBudget`, ported as `sendBudgetMs` at 4c6060c) plus 2 s, and no attempt is started
whose timeout would end after the deadline:
`ReadyWait(rt) + 2 × (writes × 10 + keys × 22 + 150 + 1200 + 40) + (submit ? 6000 : 0) + 2000` ms,
`writes` = runs of ≤ 32 runes, one per newline. claudish's shapes (keys counts the final Enter):

| shape | fixed part (budget − rt) | budget at rt 10 000 |
|---|---|---|
| 13-character SUBMIT (1 write) | 10 844 | 20 844 |
| 300-character file-template SUBMIT (10 writes) | 11 024 | 21 024 |
| 512-character typed SUBMIT (16 writes) | 11 144 | 21 144 |
| command TYPE `/model haiku` (1 write, no submit) | 4 800 | 14 800 |
| command Enter SUBMIT (`{keys:["enter"], enter:false}`, no text) | 10 824 | 20 824 |

`rt = min(10 000, left − fixed(step) − 2 000 − reserve)`, where the reserve for a command's TYPE is
the Enter step's fixed part + 2 000 + 1 000; below 1 000 no attempt starts. So `readyTimeoutMs` is
magmux's 10 s default whenever there is room, never above it (a 60 s ready wait is a 71 s send),
never below 1 s. A plain or file prompt gets one full attempt (client timeout ≈ 23 s) and a second
only after a fast refusal (`text_mismatch` in ≈ 1.5–4 s); a command's TYPE gets rt 9 376 and its
Enter at least 1 000, the last timeout ending at 30.0 s. That is what keeps the created prompt's 30 s
bound, `team(mode:"run")`'s 120 s, and a later send's return to idle at 30 s strict; the old sizing
let an in-flight reply run past the deadline. Drift in magmux's constants is safe in direction: an
under-estimate becomes a lost reply (no resend, a slower failure), never a duplicate. A bump of the
pin re-reads `protocol/sendbudget.go`.

**Why neither a lost prompt nor a doubled one can happen (D-A, D-B), by construction.** D-A was two
10 s timers racing: claudish's ctrl-u nudge emptied the box, its screen-based acceptance then saw
"empty box and a change above it" and accepted, and a lost prompt became a quiet empty answer. The
nudge, the resend timer and screen acceptance are deleted; the only acceptance paths are a gate
`ok` with a NEW history entry carrying the verified text, and claudish's own witness. An emptied box
is never evidence: "a lost prompt looks exactly like a submitted one" (magmux README). Every ctrl-u
is issued by the admission loop between two of its own sends, never beside an acceptance decision.
D-B was a frame read ~150 ms after typing that saw an empty box (Claude Code draws typed text
300–800 ms late), so claudish typed again and `/model haiku` arrived as `haiku/model haiku`. claudish
no longer reads the box to decide a retype; its only retype follows `still_in_box` (Enter pressed and
ignored, the text proven present), once, after ctrl-u, through the gate. The gate types only into an
empty box and presses Enter only on an exact match; magmux's own single retype needs the box
COMPLETELY empty and either a terminal reset after the first byte (`terminal_reset`) or no draw for
the whole 3 s window with no conversation change (`never_drawn`), and never for a paste. claudish
keeps `typed:true` on every send so no line is ever a paste. Two copies can still be TYPED (a very
late draw after a retype), but Enter is pressed only on a box holding exactly one, so two copies are
never SUBMITTED. The DA-* and DB-* tests in `pane-gated-delivery.integration.test.ts` prove both at
production timings, with no `timings` overrides.

**Slash commands are two sends, because the gate has no menu handling.** A leading `/` opens
Claude Code's command menu, and Enter on an open menu runs the HIGHLIGHTED item, not the typed one.
So a command is a TYPE (`enter:false`, answered `in_box`), a menu check on the located box (an open
menu whose highlight is not the typed name gets Escape; a box that is not located records
`menu_unverified` and gets none), then the Enter as a gated SUBMIT (`{keys:["enter"], enter:false}`).
`ok submitted_by_other` on the TYPE accepts and skips the Enter; `empty_box` on the Enter means the
command left the box without claudish's Enter and may have run, so it is never retyped. A panel
command (`/cost`, `/usage`, `/config`; `/model` with no argument: a full-screen panel or picker, no
transcript record, input swallowed until Esc) shows as `unconfirmed` or `busy dialog:select` on its
Enter; once the gate says `no_input_box` or `dialog:select` with `Esc to cancel` on screen for
500 ms it gets one Escape (`panel_dismissed` / `picker_dismissed`, never while the gate names a boot
dialog), and when the gate is ready again its admission ends without a turn (`panel_command`).

The prompt a session was CREATED with must be accepted within 30 s, else FAILED
`prompt_not_accepted`, whose `reason_detail` names the gate's answer (`magmux not_accepted
still_in_box: …`, `magmux not_accepted unconfirmed: …`, `the magmux send reply was lost (<code>)
…`, `busy vim_mode: vim editing mode is on …`, or `prompt not accepted in N s; last magmux reply:
busy <reason> (<gate detail>)`); a later `send_input` that is never accepted returns the session to
idle with the anomaly `send_not_accepted`. `get_diagnostics` carries the fresh `gate` reading and the
`lastSend` (kind, reason, accept, evidence, retypeCause, attempts). `/exit` and `/quit` are control
lines, not turns: one gated SUBMIT whose reply is recorded only as an anomaly
(`control_send:<kind>[:<reason>]`); 2.1.282–2.1.285 still write the command's caveat,
`<command-name>/exit` and `<local-command-stdout>(no content)` records into the SETTLED turn (real
records in `corpus-redacted/exit-command.jsonl`), 2.1.291 writes none; after a delivered `/exit` an
IDLE session never re-wakes, so the exit ends COMPLETED via `exit_clean`.

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
  (`pane/child-env.ts`, imported by `index.ts` right after `launch-guard.ts`) sets every snapshot
  key, removes every key the snapshot lacks except the shell-managed ones, then deletes
  `CLAUDISH_PANE_ENV`. The markers and the snapshot are control variables: no env file in the
  child's cwd can set them (`launch-env.ts`, `ai-docs/architecture/hooks.md`). A profile that
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
- **Added:** `COLUMNS`/`LINES` at the launch size (160×50 unless a size was requested while the
  pane was starting; they are not updated by a later resize — "Terminal size" below), the slot's `CLAUDISH_TOKEN_FILE` and
  `CLAUDISH_UPSTREAM_ERROR_LOG`, and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` when the owner left
  it unset (it suppresses side calls billed on the routed model), with `CLAUDE_CODE_NATIVE_CURSOR=1`
  under the same rule (traffic off makes Claude self-draw a reverse-video cursor on the faint
  placeholder, which the input gate reads as `box_not_empty`). For every child, also
  `CLAUDISH_HOOK_INBOX` (the owner-created hook inbox) and `CLAUDISH_HOOK_SESSION`
  (`{"kind","id","role"}`); see [`hooks.md`](hooks.md).
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
- `CLAUDISH_PANE_CHILD`, `CLAUDISH_PANE_CWD`, `CLAUDISH_HOOK_INBOX` and `CLAUDISH_HOOK_SESSION`
  survive the snapshot. `CLAUDISH_PANE_ENV`, `CLAUDISH_PANE_CWD` and the two hook markers
  (`PANE_LAUNCH_VARS`) are deleted from Claude Code's own environment, so the model never sees the
  inbox path. `CLAUDISH_PANE_CHILD` is KEPT there; the next section says why.

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

## Terminal size

**The size is the viewer's, not ours.** Every pane used to be born 160×50 and stay there, so a
docked viewer either showed empty rows below the screen or cut every line. 160×50 is now only the
launch default (`pane/pane-size.ts`); `resize_session` and `team(mode:"resize")` set it at any time,
mid-turn included, clamped to cols 40–9999 × rows 24–9999 and at most 4 000 000 cells. The floor is
claudish's and is measured, not arbitrary. It was 80, the width at which every closed-list marker
still fit one row. MTL-140 lowered it to 40 on real Claude Code 2.1.304 screens in magmux 0.18.0
(`size-40x24-*`):

- magmux's gate still answers `dialog:permission` (Write and Bash) and `dialog:question`, a ready
  empty box, and `box_not_empty` for a typed line. Claude Code shortens what it prints in a narrow
  dialog (`Do you want to create hello.txt?`, not the path), so the runtime markers stay on one row.
- The gate's `dismissable` drops for the question dialog, whose footer wraps as
  `Enter to select · ↑/↓ to navigate · Esc` / `to cancel`, so magmux's one-row `Esc to cancel`
  check fails. claudish never reads that flag: it sends Escape itself from its `QUESTION` or
  `PERMISSION` phase.
- A boot marker such as `Is this a project you created or one you trust` (46 characters) cannot
  fit one 40-column row, so magmux's per-row marker table misses it. claudish names it from the
  flattened screen (`nameBootScreen`), which is the path `bootBlock` takes when the gate has no
  boot kind. Not captured live at 40 columns: the capturing account trusts `/`, so no trust
  prompt appears.
- 24 rows still hold the tallest captured dialog (Bash permission, rows 6–23 of 24).

The ceiling is magmux's own (`mux/size.go`), so a clamped size can never
earn its `too_small`/`too_large`: the `resize` op refuses a side over 10 000, but the launch size it
parses from `COLUMNS`/`LINES` is EXCLUSIVE of 10 000, and a size requested while the pane is
starting goes through those variables, so 9 999 is the largest side valid on both paths; the
product is capped at `maxScreenCells` = 4 000 000, so `clampPaneSize` lowers `rows` to
`floor(4 000 000 / cols)` (9 999 columns leave 400 rows).

There used to be a 250-column cap, because the real screen fixtures stopped there and `isBoxRule`
found the input box by a `─` rule at least `cols − 1` long. No decision depends on the width any
more: readiness, acceptance and dialogs come from magmux's input gate, and the box is located by
the hidden cursor's row (`pane/box-locate.ts`), with no width test. Captures at 350 × 80 and
500 × 100 (Claude Code 2.1.303) show every rule spanning exactly the full width and the cursor on
the box's text row, the same as at 80–250. A very large size is flagged, not capped: 9 999 × 400 is
4 M cells in claudish's screen model and in every `capture_session` reply.

**A resize is a real one.** claudish sends magmux's `resize` op (`{type:"resize", pane:0, cols,
rows}` → `{rows, cols, changed, manual}`); magmux sets the PTY winsize, the child gets a genuine
SIGWINCH, and Claude Code reflows by reading the TTY. magmux then pushes a keyframe at the new
geometry to every frames-mode watcher, which `applyFrame` consumes and which bumps `seq` like any
other visible change. A magmux without the op (no `resize` in `capabilities.verbs`, read at every
connect and redial) answers `resize_unsupported`. Once the pin and `MIN_MAGMUX_VERSION` move to the
magmux release that ships the verb, an older magmux is refused at launch and that path is defensive.

**Last caller wins, without locks.** The session keeps a `desiredSize` and an `appliedSize` (null =
unknown, e.g. after `client_lost`/`client_timeout`). `resize()` records the desired size and awaits
one per-pane drain loop that always sends the LATEST desired size, so a viewer dragging an edge
produces a few requests, not one per intermediate size. The same-size short-circuit (`changed:false`,
no request) applies only when `appliedSize` is known, equal and nothing is in flight; otherwise
magmux's `changed` decides. While the client is disconnected, or the pane is still starting, the
size is stored and the call answers `changed:true, pending:true`; `attach()` re-applies it after
`capabilities`, and a starting pane launches at it. A size stored while the drain loop sits in its
post-reply screen wait has no waiter, and the redial's kick finds the loop running, so the loop also
runs while a size is OWED: connected, not terminal, applied ≠ desired, and desired ≠ the last size
it sent on this connection. The last clause is what stops a refused size being resent forever; a
redial resets it, so each connection retries a stored size once. After every await the phase is
re-checked: a session that went terminal answers its final capture's size with `changed:false`.

**A capture after a resize sees the new size.** On `changed:true`, `resize()` waits up to 1000 ms
for the screen model to reach the set size and returns that screen's `seq`, so a caller passing it
as `since_seq` never reads a pre-resize frame as current.

**What a resize costs the screen heuristics.** The classifier was written against 160 columns;
at other widths its checks are width-proof: echo prefixes are `min(40, cols − 4)` long and compared
against box text with row breaks removed, dialog markers match the dialog region joined into one
string, and the working row tolerates a wrapped tail. They are validated on real Claude Code screens
captured at 40, 80, 120 and 250 columns; `locateBox` also at 350 and 500 (`box-locate.test.ts`). A
resize redraw moves the above-box region, which only DELAYS settle (it restarts its quiet clocks)
and never completes it; during the redraw the cursor can be stale for a frame, and the answer for
that frame is "box not located", an unknown, never a wrong box. A resize during an admission only
delays the gate's readiness inside the attempt's budget: magmux re-reads screen and termios fresh
for every decision. One place would read a redraw as evidence and therefore ignores it inside the
quiet window, an interval [from, until) opened at the SEND (the SIGWINCH redraw can land before the
reply) and extended to `RESIZE_QUIET_MS` (2 s) past a `changed:true` or lost
(`client_lost`/`client_timeout`) reply: the activity timestamp behind `idle_seconds` and
`last_activity_at` (a separate activity clock; `screen.changedAt` still moves). The window is never
retracted: a lost reply may follow an applied resize, and moving the start to the reply would push
an earlier redraw out of it. (Screen-based admission, its other reader, is deleted.)

**What does not follow a resize.** `COLUMNS`/`LINES` in the child's environment stay at the launch
values — they are shell-managed keys of the snapshot, and Claude Code reads the TTY winsize, not
them. Children of Claude Code's Bash tool inherit that environment, so their output stays formatted
for the launch width. Documented, not fixed.

**Contract additions (additive in v1).** The `resize` verb on both owners (`resize_session`,
`team(mode:"resize")`), the `resize` capability (advertised only together with the magmux pin that
ships the op), and two `ContractError` codes that only this verb emits: `resize_unsupported` and
`delivery_unavailable`.

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

   **A process table without this process decides nothing.** Every table read maps a `ps` failure
   to `[]` (EPERM in a macOS sandbox that refuses the setuid `/bin/ps`, EAGAIN/EMFILE, `maxBuffer`),
   and an empty table reads as "owner dead, watcher gone". So the sweep checks
   `processTableTrusted` on each read and, when this process is absent, keeps the pane: no kill,
   no unlink. Measured 2026-10-21: in the madbench home sandbox a voter's nested MCP server ran the
   sweep on the shared root and deleted a live voter's launch dir and record about 4 s after it
   started. A nested MCP server also does not sweep at all: it registers no session tools and never
   spawns a pane.
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
  socket (measured). An invalid `--id` is IGNORED, with a stderr line, and magmux binds under its pid;
  an unusable `--sock-dir` / `MAGMUX_SOCK_DIR` exits 1 with `magmux: --sock-dir "<dir>": <reason>`
  (or `magmux: MAGMUX_SOCK_DIR "<dir>": …`), and a failed bind prints `magmux: socket <path>: <err>`.
  All three on stderr are fatal (`FATAL_MAGMUX_STDERR`, `pane_lost`). Ids are validated client-side
  (`[A-Za-z0-9_-]{1,64}`, not all digits — an all-digit id collides with a pid socket).
- **A socket path may be any length.** magmux ≥ 0.18.0 binds and dials a socket deeper than
  `sun_path` (104 bytes on darwin, 108 on linux), so `CLAUDISH_PANE_ROOT` can sit anywhere, such as
  inside a sandbox's home. `sockPathOf` (`process-identity.ts`) is the one place the path is built.
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
  row ABOVE the input box (located by the cursor) changes, so the status line ticking under the box never holds a quiet window
  open. 4 fps (research recommended 2–4) halves boot, witness and settle latency at no idle cost.
- `assertMagmuxAvailable` requires `magmux --version` ≥ `MIN_MAGMUX_VERSION` (0.18.0, the first
  release that binds and dials a deep socket; cached per binary). It is also above the transcript
  binding, which needs 0.17.0, not the gate alone: 0.16.0 had the gate but bound it by discovery.
  Every connect re-checks `capabilities` (`protocol: 1`, version ≥ `MIN_MAGMUX_VERSION`) and then
  the binding (`list`). An older magmux is refused with `magmux_unavailable: <path> is version <v>;
  panes need >= 0.18.0 (…); upgrade: brew upgrade MadAppGang/tap/magmux`; claudish never falls back
  to the box-reading path or to print mode: one validator per fact. The release job bundles the
  magmux pinned in `.github/magmux.env` (v0.18.0), test.yml runs the pane suites against that pin,
  and release.yml checks the pin against `MIN_MAGMUX_VERSION`.
- **The `--version` probe must settle on its own deadline, never on the child's exit.**
  `assertMagmuxAvailable` shares ONE in-flight probe per binary with every caller, so a probe that
  never settles hangs every later `create_session` and team run in the process (a long-lived MCP
  server for its whole life; CI shard pane-1of6 for 15 minutes, run 39713744446). execFile's
  `timeout` does not bound it: it sends SIGTERM and then waits for the child to close, and a stand-in
  that ignores SIGTERM held the probe 20 s on bun 1.3.10. `runMagmuxVersion` therefore keeps its own
  5000 ms timer: on expiry it rejects `magmux_unavailable: <path> --version failed: no answer in
  5000 ms`, SIGKILLs the child and destroys its pipes (a grandchild may still hold them). The shared
  entry is cleared on settle, so the next caller probes afresh; only successes are cached. Any new
  per-process latch on a child process needs the same rule.
- **Latent, outside this driver:** `team-grid.ts` (CLI `--grid`) does not pass `--sock-dir`, so an
  inherited `MAGMUX_SOCK_DIR` would move its socket (F7).

## Bounds (D9, D10)

- **`team(mode:"run")` returns once every slot has left STARTING**: its prompt was accepted
  (RUNNING) or it failed boot or admission. Bounded by boot 90 s + admission 30 s, and every admission attempt is sized so its
  client timeout ends by the 30 s deadline ("Delivery mechanics"). With the fake child the gate is
  ready 3.9–4.2 s after spawn (it waits magmux's 3.5 s boot floor; the fake never resets stdin);
  1.2–1.9 s to RUNNING was measured before the gate. The dev plugin's team gate polls until no slot is RUNNING, so
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
| BOOTING | STARTING | gate `ready` (IDLE, or ADMITTING with a queued prompt); boot dialog, blocked screen, 90 s → FAILED; binding check failed → FAILED `pane_lost` |
| ADMITTING | STARTING for the prompt the session was created with, else RUNNING | gate `ok` with history evidence, or the witness → RUNNING; a stop row (vim mode, boot dialog, `bad_request`, an unexpected code), a panel command, or 30 s → FAILED `prompt_not_accepted` / `first_run_dialog` (created prompt) or back to IDLE with `send_not_accepted` (a later send); an unaccepted hook injection in a one-shot session → SETTLING (`hook_admit_abandoned`), which concludes on the chain so far |
| RUNNING | RUNNING | question → QUESTION; permission → PERMISSION; `decide` → IDLE (`continue`) or COMPLETED / EMPTY / FAILED; with a hook binding and idle work, `settle_hold` → SETTLING |
| SETTLING | RUNNING (activity `hook`) | only with a hook binding: the settled turn is recorded and `sessionIdle` runs. `hold_inject` → IDLE (an injection is admitted next); `hold_rewake` → RUNNING (same turn); `turn_continue` → IDLE; the verdict → COMPLETED / EMPTY / FAILED. See [`hooks.md`](hooks.md) |
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
  `AskUserQuestion`, `hook` while a settled turn's hooks run; unknown values mean busy) and `pane`.
  `hook` needed no version change, because an unknown value already meant busy.
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
- `agent_requested` and `agent` (added within v1, 2026-10-23, MTL-231) say which subagent a slot
  runs, as two plain values with no "applied" verdict between them. `agent_requested` is the value
  of the last `--agent` in the child's final flags (`requestedAgentOf`): `buildChildClaudeFlags`
  has already folded the `agent` argument and any `--agent` in `claude_flags` into one pair, so the
  flags are the one source. `agent` is the latest `{"type":"agent-setting","agentSetting":…}`
  record of the child's OWN transcript. Claude Code writes it at line 2, before the first prompt,
  and repeats it during the session, so `applyRecord` reads it before any turn is open and the last
  one wins. Null means the transcript has none: no agent, a refused agent (`agent_rejected`: the
  child exits before writing one), or not written yet. The pair is the mod's whole test: requested
  and loaded agree, or `agent` is null and `reason` says why. Unlike `recent`, both survive on rows
  built from disk: team `status.json` and session `meta.json` carry `agentRequested` and `agent`,
  and `spawn.json` carries `agentRequested` when there is one.
- Verbs: `team(mode="list")` → `{contract_version, capabilities, runs}`; `team(mode="status")` adds
  `contract_version`, `capabilities` and a `run` row to its payload; `team(mode="cancel")` and
  `cancel_session` return per-slot `{state, changed}`; `team(mode="capture")` and `capture_session`
  return the screen at its current size `{seq, cols, rows, cursor, lines, final, spans?}` or
  `{unchanged:true, seq, final}` when `since_seq` is current; `team(mode="resize")` and
  `resize_session` return `{…, cols, rows, changed, seq, pending?}` ("Terminal size"). Errors are a
  JSON `ContractError` (`unknown_run`, `unknown_slot`, `unknown_session`, `invalid_args`, and from
  `resize` only `resize_unsupported`, `delivery_unavailable`).
- `run_id` (`<team_session_id>-<base36 start ms>-<6 hex>`) addresses one run even after a newer
  run reused its path, while the server retains it (30 minutes after it settles, at most 20 settled
  runs). A path holds at most one ACTIVE run.
- `contract_version: 1` and `capabilities` let the mod tell a pre-contract claudish from an
  unreachable server without parsing prose.

## Where to look

| file | what |
|---|---|
| `pane/pane-session.ts` | `PaneSession`, `startPaneSession`: spawn order, the binding check, the gate poll, boot, the admission loop, settle, exit path, reap |
| `pane/input-gate.ts` | the gate adapter: `classifySendReply` (reply → closed `SendOutcome`), `parseGateInput`, `parseGateBinding`, `sendBudgetMs` (magmux's `SendBudget`); pure, translation only |
| `pane/gate-binding.ts` | `checkGateBinding`: pane 0 declared, gated and bound by name to this session's id and transcript |
| `pane/box-locate.ts` | `locateBox` / `inspectBox`: the input box from the cursor row, no width test |
| `pane/settle-rule.ts` | the pure P/I/S/X/L decision, gate corroboration and its 32 s grace, `SECONDARY_QUIET_MS` |
| `pane/transcript-follower.ts` | the turn-scoped reducer: witness, waking records, background balance, read coverage, answer start |
| `pane/screen-model.ts`, `pane/screen-classifier.ts` | frames → screen with our `seq`; dialog text, boot screen names, working row, degraded answer |
| `pane/pane-size.ts` | launch size, the resize clamp (magmux's limits), `RESIZE_QUIET_MS` |
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
