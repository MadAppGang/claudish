> The 20-tool MCP surface and its four groups, the sessions behind it (panes, records, polling, resizing, scrolling, the transcript as text lines, read-only replays), `run_prompt`'s two paths, the removed channel push, and the progress keepalive.
>
> Extracted from `CLAUDE.md` (v7.64.0). Indexed in [`README.md`](./README.md).

# MCP sessions and tool surface

The MCP server runs async model sessions (`create_session` and the other session tools) that the
host polls, plus `run_prompt` and `team`. It was `mcp-channel.md`, named for the channel push,
which is gone (see "Push notifications were removed"); the module it describes moved from
`packages/cli/src/channel/` to `packages/cli/src/mcp-session/` in the same rename.

## Architecture

Uses the low-level `Server` class (not `McpServer`) from `@modelcontextprotocol/sdk/server/index.js`.
`capabilities` is `{ tools: {} }` for every `CLAUDISH_MCP_TOOLS` value, with no `experimental` key,
and `serverInfo.version` is `VERSION` from `version.ts` (generated from `packages/cli/package.json`;
it said `9.0.0` until 10.7.0).

## Components (`packages/cli/src/mcp-session/`)

- **SessionManager** — the sessions' policy and records: creates sessions, owns the queue of
  `send_input`, decides a turn's verdict, writes the session records, enforces `timeout_seconds`
- **PaneSession** (`packages/cli/src/pane/`) — the mechanism: one interactive Claude Code in its
  own headless magmux pane, with the transcript as its turn oracle and magmux's input gate deciding
  input (readiness, dialogs, prompt acceptance). Team uses the same driver
- **ScrollbackBuffer** — in-memory ring buffer (2000 lines), holding each settled turn's answer prose

### The transport: an interactive Claude Code in a headless magmux pane

Each session is `claudish -i --model <spawnModel> -y --quiet --session-id <uuid> --add-dir
<turnDir> [caller flags]` inside its own `magmux --headless` pane, driven over the pane's socket.
There is no `-p`, no `--stdin`, no stream-json and no positional prompt. Until 10.4.0 the child was
`claudish -p --output-format stream-json --input-format stream-json …` with its stdin held open for
`send_input`; that transport and its reducer were deleted because print mode is not a faithful
subset of the REPL (`headless-vs-interactive.md`): it skips `--agent` validation silently, and an
interactive Claude Code is what users actually run.

Everything about the pane — boot, the transcript turn oracle and its settle paths, prompt delivery
by file with read coverage, the child's environment, the watcher and the identity-checked reap,
the socket traps, the frozen mod contract — is in [`pane-session.md`](pane-session.md). This file
covers what the session tools add on top.

**`claude_flags` are checked before anything starts** (`checkChildFlags`, shared with `team`):
claudish's own pane argv, transport breakers (`-p`, `--output-format`, `--input-format`, `--stdin`,
`--bg`, …), session breakers (`--resume`, `--continue`, `-w`, `--no-session-persistence`, …),
print-only Claude Code flags (`--max-turns`, `--max-budget-usd`, `--fallback-model`,
`--json-schema`, `--permission-prompt-tool`, which an interactive child would silently ignore),
claudish mode flags, claudish subcommand words, and any positional token or `--`. The match is
exact-token after splitting `--flag=value`, and the positional rule is claudish's own
value-consumption rule (`classifyPassthroughTokens`, pinned against `parseArgs` by a table test).
A refusal is an `invalid_args` error before any credential work. `create_session`'s `agent`
argument becomes `--agent <name>`; an unknown name is refused by the child itself (FAILED
`agent_rejected`), so claudish runs no agent probe of its own.

**A session is created in this order**: the flag check, `assertMagmuxAvailable` (magmux ≥ 0.18.0,
else `Error: magmux_unavailable: …`), credential pre-hydration, the parent session read, a pane
reservation (`Error: pane_limit: …` past 48 live panes per user), `prompt.md`, `spawn.json`, then the
pane. `create_session` returns `{session_id, state}` once the pane exists, without waiting for boot.
A pane that fails to start leaves a FAILED `pane_lost` session with its `meta.json`, and the call
fails.

**The verdict is the owner's (D8).** A one-shot session's settled turn is classified by
`classifyRunOutput` with no byte floor and no pattern (`api_error`, `prompt_not_read`, `refused`,
`empty_output`), and the session is terminal at that verdict, before its pane is reaped. The
rule is the team's own (`oneShotVerdictOf` passes the turn's `lastResponseEnd` and the session
token file's `in_band_api_error`), so a turn whose last API response ends in a text block that is
only an in-band API error marker, which the session's proxy recorded during the turn, is
`api_error` after any progress text; without that record the block is the model's text. An
interactive session continues after each turn and fails only on an API-error turn (D20); a turn
whose task file was not fully read records a `prompt_not_read` anomaly in `events.jsonl`. A question or a permission dialog waits for `send_input` (team fails it instead).
Terminal states are absorbing: a late pane exit can never upgrade or overturn a CANCELLED or
TIMEOUT already recorded.

**The witness is scoped to the CURRENT turn**, by construction: the follower marks the transcript
offset before each delivery and turn N owns only the records past its own offset. Turn 1's answer
can therefore never mark turn 2 completed — the original bug's shape, a session reporting success on
evidence that does not belong to it.

**`send_input` is queued (D17).** It is accepted in every non-terminal state: STARTING and RUNNING
queue it, AWAITING_INPUT delivers it at once, and during a question or permission dialog claudish
presses Esc — which declines the dialog AND interrupts the turn — and delivers the text as the next
prompt. Any accepted send makes a one-shot session interactive. The answer is
`{success:true, queued}` or `{success:false, reason, state}` with `reason` one of `terminal`,
`delivery_unavailable`, `unsupported_command`, `unknown_session`.

**Persistence is redacted and bounded.** `output.log` holds each settled turn's answer prose, plus
claudish's own `[claudish] <STATE> <reason>: <detail>` note on a session that did not complete.
`events.jsonl` holds claudish's own records — `state` transitions, `tool` changes, `anomaly` keys and
one `{type:"assistant", message:{id}, at}` line per main-chain message id — `redactSecrets`-filtered
per line and capped at 4 MB (`{"type":"claudish_truncated"}` marks the cut); message content is not
copied, because the transcript already holds it. `screen.txt` is the pane's final screen, redacted,
written at the terminal transition. These files and the transcript are what `get_diagnostics`
names for an agent to read.

**Terminal sessions are evicted.** `maxSessions` bounds only ACTIVE sessions, so finished
ones used to accumulate for the life of the MCP server. A terminal session leaves the map
after `terminalRetentionMs` (default 30 min), with a hard ceiling of 50 retained. On-disk
artifacts are unaffected, and `getSession`, `get_output` and `get_diagnostics` fall back to the
session directory (both generations of `meta.json`: 10.4.0's `status`-only record and the pane
one). `transcript_session` is a reader too and falls back the same way. The mutators — `send_input`, `cancel_session`, `capture_session` — never do: a recovered
record describes a process that is gone, and they answer `unknown_session`.

**Shutdown ends the records, then reaps.** At startup the MCP server installs the pane shutdown
hooks with `stdin: true`: stdin EOF or close (the host closed the transport), SIGINT, SIGTERM and
SIGHUP first run `shutdownAllTeamRuns()` and `SessionManager.shutdownAll()` — every live session is
cancelled and its terminal transition writes the closing wait line and `meta.json` — and only then
reap every pane in parallel and exit (0 on stdin, 128 + n on a signal). `shutdownAll` waits for
starts still in flight first; one that was skipped would run on unsettled. `stats-buffer.ts`'s
module-load signal listeners used to exit synchronously before any record was ended;
`signal-owner.ts` lets the pane registry claim the exit. After a SIGKILL no record ends, but the
per-pane watchers still remove every process and file.

**`cancel_session` is a synchronous transition with an asynchronous reap.** It returns
`{session_id, state:"CANCELLED", changed}` at once; the pane close and the process-group reap finish
in the background (worst case ≈ 12 s). A second call returns the same state with `changed:false`.

**`timeout` is its own state, never `failed`.** A session killed by its own `timeout_seconds` is
TIMEOUT in memory, `meta.json` `status: "timeout"`, and `to: "timeout"` in `waits.jsonl`. Until
Phase 3 of the channel work the channel push said `failed` for it, because the SEP-1686 projection
had no `timeout` key and fell through to `working`; that projection (`mapEventToTaskStatus`) was
deleted with the push in 10.7.0, and the records never had the split.

**Session shape follows the prompt.** `create_session` WITH a prompt is one-shot: it is terminal
at the verdict of the turn that prompt started. WITHOUT a prompt it is interactive: it waits in
`waiting_for_input` once Claude Code has booted and again after every turn, and it ends on
`cancel_session`, the timeout, or the child exiting 0 after `/exit` or a settled turn. A
`send_input` call converts a one-shot session to interactive.

**`waiting_for_input` means a real wait, and nothing else.** It holds iff the session is idle
between turns — the turn settled on Claude Code's own end-of-turn record, and magmux's input gate
reported the box ready (which means empty) with no dialog, or could not confirm that within 32 s of
chat quiet (recorded as `settle_gate_unconfirmed:<why>`) — or a turn is blocked on a question
(a pending AskUserQuestion in the transcript, or another pending tool with the gate reporting
`dialog:question`). `awaiting_permission` holds iff a tool is pending in the transcript and the gate
reports `dialog:permission` or `dialog:plan`. Before the gate these rested on claudish finding the
box on the screen; the moments they open moved slightly: the first wait opens at the gate's `ready`
(box and raw terminal still 1 s, plus Claude Code's boot reset or a 3.5 s floor), polled every
250 ms, instead of a box stable 3 s; RUNNING starts at the gate's history evidence, earlier than the
transcript witness behind a slow UserPromptSubmit hook; and a session that once stayed RUNNING for
good on a box claudish could not find now reaches `waiting_for_input` after the 32 s grace. The
record vocabulary of `waits.jsonl` is unchanged. A one-shot session is terminal at its verdict, so there
is no "answered but still exiting" state for a wait to be confused with — 10.4.0's `finishing`
event is gone with the transport (RB1). The wait for Claude Code's end-of-turn record after
the model's message ends survives only as `activity:"finishing"` on a RUNNING session. A
promptless session's first wait opens at boot-ready, not at creation: before boot a send is queued,
not answered (RB2).

### `waits.jsonl` — the wait log

`<sessionDir>/waits.jsonl` gets one line per transition INTO a wait (`waiting_for_input` or
`awaiting_permission`) and one per transition OUT of it (terminal states included):

```jsonc
{"wait":"open","since":"2026-10-02T10:03:12.000Z","turns":1}
{"wait":"closed","since":"2026-10-02T10:03:12.000Z","at":"2026-10-02T10:03:13.400Z","to":"running"}
```

`since` keys the wait (the `closed` line repeats it); `turns` is `turnsCompleted` at the
open; `to` is the session event of the new state (`sessionEventFor`: `running`, `tool_executing`,
`completed`, `failed`, `cancelled`, `timeout`, …), never another wait (the phase table has no
wait-to-wait edge). The vocabulary outlived the push it was named for: the field is a record
contract outside observers read, so it keeps those words. It is append-only because an observer polling the directory
must see a wait that opened and closed between two of its reads — a
marker file that exists only during the wait cannot give it that.

The writer is the pane's `onTransition` hook: synchronous, every wire-state change, never
coalesced. It reports the net change of one event-processing step, so a turn that settles with a
send already queued (RUNNING → IDLE → ADMITTING in one step) opens no wait. The terminal transition
closes any open wait before `meta.json` is written, so a live writer never leaves an open wait
beside a `meta.json`. One `appendFileSync` of < 200 bytes per line; a write failure goes to stderr
and loses only that line; the file stops at 1 MB. Interactive sessions write one, and a one-shot
session writes one only when it stops on a question or permission dialog (RB3) — in both cases the
right action is `send_input`.

### `spawn.json` — the start-time record, and who started the run

`createSession` writes `<sessionDir>/spawn.json` after `prompt.md` and BEFORE the pane starts,
atomically (`spawn.json.tmp` + rename), one key per line, and NOT inside a `try`: a session
that cannot be recorded fails the tool call rather than run unrecorded. It exists before
every runtime file (`output.log`, `events.jsonl`, `tokens.json`, `waits.jsonl`, `screen.txt`,
`meta.json`) and is never removed.

```jsonc
{
  "schema": 1,                       // versions spawn.json only
  "kind": "session",                 // "session" | "team"
  "sessionId": "1a2b3c4d",
  "parentClaudeSessionId": "<uuid>", // OPTIONAL — absent when no well-formed id could be read
  "hostPid": 12345,                  // the Claude Code process that launched this server
  "launcherPid": 12398,              // OPTIONAL — present only on the npm launcher path
  "mcpPid": 12399,                   // this process: the one that writes meta.json
  "startedAt": "2026-10-02T10:00:00.000Z",
  "model": "<as the caller asked for it>",
  "timeoutSeconds": 600,             // effective: min(requested ?? 600, 3600)
  "claudeSessionId": "<the child's uuid>",
  "setupFrom": "/abs/caller/project", // OPTIONAL — present only when the child inherits a settings layer
  "inheritedMcpServers": ["linear"],  // OPTIONAL — server NAMES in inherited-mcp.json, never their definitions
  "inheritedPlugins": [{ "id": "dev@magus", "version": "9.8.2" }], // OPTIONAL — plugins handed over with --plugin-dir: ids and versions, never paths
  "pluginProbe": "ok"                 // OPTIONAL — present when the plugin probe was due: ok, its fail-closed cause, or why none started (plugin_url, managed_policy_present, await_initialize, caller_argv_unreadable, caller_env_unreadable, caller_settings_unreadable, caller_mode_unmodelled, setup_from_not_caller, work_dir_command_setting, caller_command_setting, user_command_setting)
}
```

It exists for observers OUTSIDE this process, which poll the sessions directory to report
progress to the Claude Code window that started a run.
`claudeSessionId` is the pane's `--session-id` uuid, the transcript's basename. For a pane session
`mcpPid` is also the pane record's owner, and the watchers make an observer's liveness inference
sound: when the writer dies, its panes die with it.

**`transcript_session` is a second reader of both keys.** A session running under another MCP
server has a directory with `spawn.json` and no `meta.json` (that file is written only at the
terminal transition). `spawn.json` has no `cwd`, so the transcript path is found by
`claudeSessionId`: one `readdir` of the projects directory for `<dir>/<uuid>.jsonl`, used only on
exactly one hit (1,187 project directories: 1.8–2.0 ms warm, 4.6 ms cold). `mcpPid` decides
`final`: only `process.kill(mcpPid, 0)` failing with ESRCH, plus a transcript quiet for 30 s, counts
the writer gone; a live pid, EPERM, or a missing or non-integer `mcpPid` never does. Adding `cwd`
to `spawn.json` was rejected: this file is a cross-repo contract, and every record a released
server wrote lacks the key anyway.

**`hostPid` is structural, computed once at startup** (`hostPidFrom`, `mcp-session/parent-session.ts`).
A compiled binary or `bun src/index.ts` is the direct child of Claude Code, so `hostPid` is
`process.ppid`. An npm/bun global install runs Claude Code → `node bin/claudish.cjs` → `bun
dist/index.js`, so the launcher puts `CLAUDISH_LAUNCHER_PID` (itself) and
`CLAUDISH_LAUNCHER_PPID` (its parent) in the child's env, and the child believes the pair only
when `CLAUDISH_LAUNCHER_PID` is its real `ppid` — a pair leaked into a nested claudish is
inert. `launcherPid` is recorded exactly when that branch ran. No `ps`, no tree walk. The pane
environment strips the pair and `CLAUDE_CODE_SESSION_ID`, so a claudish MCP server nested inside a
pane cannot inherit the host's identity either.

**`parentClaudeSessionId` is the host session record's id, read once per call**
(`parentSessionForCall`, `mcp-session/parent-session.ts`). At `create_session` and
`team(mode:"run")` time claudish reads `<configDir>/sessions/<hostPid>.json` (`configDir` is
`CLAUDE_CONFIG_DIR`, else `$HOME/.claude`) and records its `sessionId` when the file parses,
its `pid` equals `hostPid` and the id is well formed. Only when no record can be read does it
fall back to `CLAUDE_CODE_SESSION_ID` (ignored under `CLAUDE_CODE_CHILD_SESSION`); with
neither, the key is absent. One file read: no transcript search, no polling, no delay.
`meta.json` carries the same key with the same value exactly when `spawn.json` does.

Why the host record, measured on Claude Code 2.1.290 in live interactive sessions
(`madbench --manual`, 2026-10-06):

- The host record carries the window's LIVE conversation, `{"pid":…,"sessionId":…,"cwd":…}`:
  its `sessionId` went `6f9e3d06…` → `d5b9974e…` after `/clear` and back to `6f9e3d06…`
  after `/resume`. The MCP server's `CLAUDE_CODE_SESSION_ID` equals it at server start and
  goes stale after the first `/clear`, which is why the env id is only the fallback.
- The transcript cannot attribute the call. Claude Code writes a call's `tool_use` record
  only AFTER the MCP tool call returns. With a 10 ms poller: record timestamp `00:41:39.899`,
  claudish gave up a 2 s transcript poll and spawned at `00:41:41.909`, the record reached
  disk at `00:41:42.052`; an earlier call, `34.785` / spawn `35.040` / on disk `35.162`. The
  previous mechanism searched the calling conversation's transcript for the `_meta`
  tool-use id, polling up to 2 s; it could never find the call it was proving, so every
  `create_session` came out unattributed and 2 s slower. It is deleted, and claudish no
  longer reads `_meta["claudecode/toolUseId"]`.
  `spawn-record.contract.test.ts` "regression: the transcript does not hold the call while
  the tool runs" replays that order and fails against the transcript search.

Accepted race: a `/clear` typed in the very moment a call runs may attribute that run to the
new conversation. It is never attributed to another window — the record is keyed by this
server's own `hostPid`.

### `meta.json` — the final record, and `events.jsonl`'s assistant lines

`meta.json` is written once, at the terminal transition and before the pane is reaped, through
`toMetaRecord`. Its existence is the run's end record: the magus `claudish-usage` skill and the
multimodel `team` and `delegate` commands wait, bounded, for this file to appear. It keeps every
10.4.0 key under its 10.4.0 name, because the monitor reads `status` (an unknown value reads as
`failed`), `terminalReason`, `elapsedSeconds`, `turnsCompleted`, `toolCallCount`, `costUsd` and
`exitCode`:

- `status`: COMPLETED → `completed`; FAILED and EMPTY → `failed`; CANCELLED → `cancelled`;
  TIMEOUT → `timeout`;
- `terminalReason` is the contract's `FailureReason` (null on COMPLETED), not Claude Code's own
  text; `costUsd` is null for native routes (no fictional spend, D12); `exitCode` is null when
  claudish ended the pane — a pane's exit code exists only if the child exited on its own (RB4);
- additive keys: `state` (tells EMPTY from FAILED), `detail`, `tokensIn`, `tokensOut`,
  `lastActivityAt`, `shape`, `pane`, `provider`, `captureSource`, `turnSource`, `timeoutSeconds`,
  and `cwd` (needed to re-derive a stored transcript path; a 10.4.0 record without it keeps its
  stored path). A `SessionInfo` key that would repeat a pinned key (`toolCalls`, `reason`,
  `panePid`) is written only under the pinned name, so the record never carries two names for one
  fact.

`events.jsonl` carries one `assistant` line per main-chain message id, first-seen order, each once,
which is exactly what the monitor counts as replies (RB5).

### Hook records in an MCP session

When hooks are loaded ([`hooks.md`](hooks.md)), an MCP session's records gain these, all
additive:

- `<sessionDir>/hook-inbox.jsonl`, created (0600) for **every** child before it spawns and named in
  the child's `CLAUDISH_HOOK_INBOX`. The child's proxy appends `stop`, `inject`, `annotate`, `end` and
  `capped` lines; the server reads it at each settle and deletes it at reap.
- `events.jsonl` anomaly keys: `hook_injection_delivered`, `hook_injection_dropped:<reason>`,
  `hook_injection_not_read`, `hook_hold_error`, `hook_hold_watchdog`.
- `get_diagnostics` adds `pendingHookInputs`, and its `phase` can read `SETTLING` while
  `sessionIdle` hooks run. The row `state` stays `RUNNING`, with activity `hook`, which `sessionEventFor`
  reports as `running`, never `tool_executing`. `pendingInputs` still counts caller input only.
- A one-shot session that a hook extends stays `RUNNING` across its turn chain, and its output grows
  turn by turn: each chain turn's answer is appended when the turn is recorded, before any hook runs.

### Diagnostics are captured unconditionally, and reachable from the API

Two sessions once ran 900 s of genuine billed work — 241 assistant messages, ~94 k output
tokens, 150 tool calls — and reported success with an empty output log. The whole
explanation was one line, written to `~/.claudish/sessions/<id>/stderr.log` and left there:
`[claude-code:unrecognized_model] {"model":"cx@gpt-5.6-sol"}`. No MCP tool returned it.
**A failure that has already happened cannot be re-run with `--debug`**, so nothing here is
opt-in. A pane child has no stderr pipe for claudish to keep; what a terminal shows a person is the
screen, so that is what is captured.

- **`get_diagnostics(session_id, event_limit?)`** returns `state`, `event`, `reason`, `detail`;
  **both halves of the model chain** (`model` as asked for, `spawnModel` as pinned) and the
  `provider`; `shape`, `exitCode`, `idleSeconds`, `elapsedSeconds`, `timeoutSeconds`,
  `outputBytes`, turns, tokens, `costUsd`, `toolCalls`, `pendingInputs`; the pane facts — `phase`,
  `connected`, the redacted `screenTail`, `sockPath`, the head of magmux's own stderr,
  `preambleBytes`, the current turn's `readCoverage`, the child's `claudeCodeVersion`,
  `anomalies`, the input gate's fresh reading `gate: {ready, reason, detail, ageMs} | null` and the
  last gated send `lastSend: {kind, reason?, accept?, evidence?, attempts} | null`;
  the tail of the event ring; the upstream error bodies; and the paths: the
  transcript, the session directory, `events.jsonl`, `upstream-errors.jsonl`. A session no longer in
  memory answers from its directory, including `screen.txt`.
- **`outputBytes` counts the CHILD's prose only.** `recordNote` exists so claudish's own
  `[claudish] …` failure annotation does not inflate the metric that proves a session
  produced nothing — measured, it read 312 B for a 0-byte session before the split.
- **The event ring is in memory, not read back off disk.** 200 records × 800 chars, labelled by
  `type`, redacted once and shared with `events.jsonl`. It keeps filling after the 4 MB file cap,
  because the records just before a death are the ones a post-mortem wants.

### `transcriptPath` — realpath, or it is wrong

Claude Code writes an authoritative JSONL transcript at
`<CLAUDE_CONFIG_DIR or $HOME/.claude>/projects/<slug of cwd>/<session-uuid>.jsonl`. claudish
mints that uuid and passes it as `--session-id`, so the filename is derived, never searched for by
mtime. `transcriptPathFor` (in `session/session-discovery.ts`, which owns the layout) is the
only `realpathSync` in the repo and it is load-bearing: macOS `tmpdir()` is `/var/…` →
`/private/var/…` and a worktree can be reached through a symlink too, so the slug of the path we
*spawned* with names a directory that does not exist. That is literally how the incident's
transcripts were declared missing — they were under the session's own `work_dir`, in a project
directory nobody looked in. The slug replaces EVERY non-alphanumeric character with `-`, the
projects root follows the OWNER's `CLAUDE_CONFIG_DIR` (`projectsDir(parentEnv)`), and the pane's
launcher `cd`s to the realpath before `exec`, so the directory Claude Code writes and the one
claudish reads come from one rule. Now that the transcript is the turn oracle, a wrong path is not
a missing diagnostic: it is a session that never sees its own witness.

### `CLAUDISH_UPSTREAM_ERROR_LOG` is set per session

`captureUpstreamError` (`handlers/composed-handler.ts`) is a no-op when that env var is
unset, and it was unset for every session child. Its own comment states the cost: `log()`
only persists under `--debug`, so the body distinguishing a retryable rate limit from a hard
quota wall is gone the moment it is classified. Each session now points its child at
`<sessionDir>/upstream-errors.jsonl` — set unconditionally, overriding any inherited value,
because the records carry no session id and a shared path interleaves 20 concurrent sessions
into one unattributable file. The capture **redacts at write time** now that it is no longer
only a path a user opted into: a 401/403 body routinely echoes the credential that failed,
and `get_diagnostics` hands these records to an agent.

### A work_dir child inherits the caller's settings layer

Claude Code reads project-scope settings (`enabledPlugins`, hooks, permissions, `env`) only from
`<cwd>/.claude/settings{,.local}.json`; it does not walk up to the repository root. A
`create_session` child runs with `work_dir` as its cwd, so before MTL-185 every plugin the
caller's project enables was off in it and `--agent dev:qa-engineer` was refused
(`agent_rejected`). Measured on Claude Code 2.1.306 (session `dev-fix-20261022-023522-f75563b5`):

| Child cwd | Flags | Agents listed |
|---|---|---|
| caller project (E1) | none | the full list (24) |
| sandbox inside the repo (E2) | none | the 5 built-ins |
| sandbox inside the repo (E8, E16) | `--settings` = the caller's layer | identical to E1 |
| sandbox outside the repo (E5) | `--settings` = the caller's layer | user-scope installs only: `dev` at the user row's version (9.2.0, not 9.4.0); `designer`, `madbench`, `code-search`, `code-simplifier` absent |
| sandbox outside the repo (E13) | the layer + one `--plugin-dir` per install row | identical to E1 |

What `createSession` does now (`mcp-session/inherited-settings.ts`, `session-manager.ts`):

- `setup_from` defaults to the server's cwd (the caller's project) and is skipped when it resolves
  to the child's own cwd, whose files Claude Code already reads. `setup_from: null` opts out: the
  child's argv and files are byte-for-byte what they were. An explicit `setup_from` that is not an
  existing directory, or a value that is neither a string nor null, is refused as `invalid_args`;
  the implicit default is not checked.
- The layer is `<setup_from>/.claude/settings.json`, then the local settings files Claude Code
  reads for a launch from `setup_from` (`localSettingsFiles` in `claude-runner.ts`: the MAIN
  checkout's `.claude/settings.local.json` when `setup_from` is a linked worktree or a
  subdirectory of a repository, then `<setup_from>/.claude/settings.local.json`), then every
  caller `--settings` value (both `--settings v` and `--settings=v`), merged in that order:
  objects deep, arrays concatenated without duplicates, scalars later-wins.
- `createSession` resolves `setup_from` to its real path ONCE and hands that path to both the
  settings layer and the MCP builder, so a symlink to a subdirectory of a repository finds the
  main checkout's `settings.local.json` in both (and its `disabledMcpjsonServers` reaches the
  MCP builder). Each builder also takes its argument by real path.
- The caller's `--setting-sources` limits the layer's files as it limits the child's own reads:
  without `project` no `settings.json` is read, without `local` no `settings.local.json`. A
  caller `--settings` value is outside that flag's reach and always applies.
- A string `enabledMcpjsonServers` / `disabledMcpjsonServers` naming one server
  (`/^[A-Za-z0-9_-]+$/`) is read as a one-name list in each file BEFORE the merge, as Claude
  Code does, so a string in one file and an array in another add up.
- A file that is not a regular file (a named pipe, socket or device) is skipped, never read: a
  synchronous read of a pipe with no writer blocks the whole MCP server. The same holds for
  every `.mcp.json`, `.claude.json` and settings file the MCP builder reads. A caller
  `--settings` path that is not a regular file fails as `invalid_args`.
- A malformed inline `--settings` value is reported as `inline --settings value`, never by its
  text: the value can carry an `env` token.
- **Exactly one `--settings` reaches the child.** Claude Code keeps only the LAST one (E14: the
  root settings then `{}` lists the 5 built-ins; E15, reversed, the full list), and claudish's
  child runner merges only the first bare `--settings` into its own overlay (`claude-runner.ts`).
  A second token would replace either the inherited layer or claudish's overlay (statusLine,
  `forceLoginMethod`, `editorMode`), and losing the overlay fails the pane at boot. So the caller's
  `--settings` are folded into the file and removed from argv.
- `permissions.additionalDirectories` is removed: it is `--add-dir` in settings form, and the main
  checkout's `settings.local.json` carries one that would re-open reads outside `work_dir`.
- The layer is written to `<sessionDir>/inherited-settings.json`, mode 0600, because
  `settings.local.json` can carry `env` secrets. Nothing is written to `work_dir` or `setup_from`.
  `spawn.json` records `setupFrom`. A file that is not a JSON object fails the call as
  `invalid_args`, before any pane starts.
- The child claudish copies that layer into its own overlay, `~/.claudish/settings-<pid>-<ts>.json`
  (`createTempSettingsFile`, then `mergeUserSettingsIfPresent` in `claude-runner.ts`), so the
  overlay carries the same secrets and is 0600 too. Up to v14.4.1 it was 0644 (MTL-207). The
  `mode` option of `writeFileSync` applies only when it CREATES a file: an overwrite keeps the
  old bits (measured on Bun 1.4.0, a 0644 file overwritten with `mode: 0o600` stays 0644). So
  the merge calls `chmodSync(…, 0o600)` before it writes, and a chmod failure skips the write.
  `claude-runner-settings-mode.test.ts` pins umask 022, because a runner with umask 077 passes
  the old code. Overlays left behind by older versions are MTL-258.

#### The managed policy sources claudish reads

Both handovers below (`inherited-mcp.json` and `--plugin-dir`) depend on the managed policy, under
two different rules, because a wrong guess costs different things:

- **`inherited-mcp.json` refuses only where Claude Code itself would, except the server-managed
  cache** (see Known limits) (`readManagedPolicy`, once per `create_session`):
  `disableSideloadFlags: true` in a source Claude Code reads, a managed `managed-mcp.json`, or a
  Windows policy key that holds a `Settings` value or cannot be queried. A source Claude Code
  skips is skipped as absent. The cache is the exception: claudish reads a cached
  `remote-settings.json` as in effect, where Claude Code first checks the cache's signature and
  the stored copy's trust, and applies no cache at all on a machine with no stored login (measured
  below). On such a machine a cached `disableSideloadFlags: true` withholds servers Claude Code
  would have accepted. Withholding the servers there would change a
  same-repository child's argv for nothing (a linked worktree of the caller's repository gets
  `--mcp-config` too).
- **The plugin probe starts only on a machine with no managed policy source at all**
  (`managedPolicySourcePresent`): any source that exists in any form, readable or not, is enough,
  and Windows and WSL never get one. A wrong guess there hands over a plugin copy, or runs a
  managed hook in a probe, so the probe needs almost no format knowledge. The one exception is
  the server-managed cache: Claude Code writes a two-byte `{}` `remote-settings.json` for an
  ordinary login (this Mac's, mode 0600, written by Claude Code on 26 Nov), and counting it as
  present refused every probe on such a machine, which is to say the fix did nothing there. A
  `remote-settings.json` that is a regular file (not a symlink) of at most 8 MiB holding one
  JSON object whose every key starts with `$` counts as absent: Claude Code drops `$`-prefixed
  keys other than `$schema` as metadata before it applies the cache (2.1.332:
  `function _Vr(e){let n=js(e,(r,a)=>a.startsWith("$")&&a!=="$schema");…}`), and `$schema` sets
  nothing. Anything else there (a key without `$`, an unparsable file, a non-object, an
  oversize file, a folder, a symlink) stays present. The gate checks the config dir each probe
  uses: the child probe runs in work_dir under the server's environment, the caller probe in the
  caller's own launch directory (the MCP host's cwd) under the caller's own `CLAUDE_CONFIG_DIR`
  (read from the host process, below), and a relative `CLAUDE_CONFIG_DIR` resolves against each
  cwd, so a source in either config dir stops both. setup_from's config dir under the server's
  environment is checked too.

In Claude Code's priority order:

| Source | Path | `inherited-mcp.json` reads it as | Probe gate |
|---|---|---|---|
| server-managed | `remote-settings.json` in the config dir (`CLAUDE_CONFIG_DIR`, else `~/.claude`, resolved against work_dir; for the probe gate also against setup_from and the caller's launch directory) | a regular file of at most 8 MiB, one JSON object; else skipped | present, unless a regular file of at most 8 MiB holding one object whose keys all start with `$` (`{}` included) |
| per-user MDM | `/Library/Managed Preferences/<user>/com.anthropic.claudecode.plist` (macOS) | `/usr/bin/plutil -convert json -o - -- <file>`, at most 5 s (then `SIGKILL`) and 2 MiB of output, one JSON object. When the conversion fails, `plutil -lint -s -- <file>`: a plist that lints (a date or data value) is skipped, a damaged one that can be opened is taken and sets nothing. A plist that converts, or is taken damaged, is the only one read: the device plist after it is not | present |
| device MDM | `/Library/Managed Preferences/com.anthropic.claudecode.plist` (macOS) | the same, only when the per-user plist is missing or skipped | present |
| file | `managed-settings.json`, then the drop-ins of `managed-settings.d` (`.json`, not dot files, sorted) | a regular file, one JSON object, else skipped; a file over 8 MiB withholds (claudish found no evidence that Claude Code skips it) | present; ANY entry of `managed-settings.d`, one Claude Code skips included |
| `managed-mcp.json` | beside `managed-settings.json` | present: withholds | present |
| hybrid sign-in cache | `<config dir>/state/hybrid-settings*.json` | not read | present (a `state` folder that cannot be listed counts as present) |
| Windows registry | `HKLM\SOFTWARE\Policies\ClaudeCode`, `HKCU\SOFTWARE\Policies\ClaudeCode` | `%SystemRoot%\System32\reg.exe query <key> /v Settings`, 5 s: exit 0 with a `Settings REG_*` line withholds, exit status 1 (`reg`'s failure status) with no such line is absent, anything else (a timeout, a failure to run, another status) withholds. Absence is read by status, never by the message: `reg` prints it in the system's language, and matching the English text withheld every same-repository `--mcp-config` on a non-English Windows. A key `reg` cannot read (access denied) also exits 1 and reads as absent; Claude Code reads the policy with the same `reg` query and applies nothing it cannot read either | Windows: no probe |

Presence is `lstat`: anything at the path counts (a dangling symlink, a named pipe, a folder), and
only `ENOENT`/`ENOTDIR` is absence. Nothing a probe gate sees is opened, but the one
`remote-settings.json` that is a regular file small enough to tell whether it sets anything
(above). For `inherited-mcp.json`, a
source that is not a regular file (a named pipe is never opened or handed to plutil), cannot be read,
is not JSON or not a JSON object, a plist that lints but plutil cannot convert, a device plist behind a
per-user plist that converted, a remote cache over 8 MiB and a
drop-in folder that cannot be listed are all skipped, as Claude Code skips them (2.1.332: a document
it cannot read is "Managed settings document (${e}) could not be read: ${n}; none of its settings are
in effect"; plutil's failures are `unreadReason`s such as "it holds a value plutil cannot convert to
JSON"; the remote cache "Disk cache exceeds ${St} bytes; ignoring it as if absent", and a cache that
is not a plain object reads as `null`). Every gate reads ALL present sources and refuses on any of
them, so it holds under both of Claude Code's composition modes. The tests inject every path through
`ManagedPaths` (`managedPreferencePlists`, `remoteSettingsFile`, `hybridSettingsDir`,
`registryPolicyKeys`, and the `readPlist` and `readRegistry` seams); `remoteSettingsFile: null` and
`hybridSettingsDir: null` are the production values, derived from the child's environment.

The hybrid sign-in cache, from the bundle: `function CVr(){{let e=Ua();if(e!==null)return
Un(e,"state",`hybrid-settings${xH()}.json`)}return null}`, read by `ceo()` (its `settings`,
`organizationUuid`, `pluginLocksByUrl`) and seeded into the policy layer by `zAe()` when the account's
`hybridOrganizationUuid` matches. When a real account writes it was not measured (it needs a gateway
or hybrid organisation sign-in); the probe gate needs only its presence. The canary turns red when
the pinned binary no longer holds `hybrid-settings`, `remote-settings.json`,
`com.anthropic.claudecode`, `managed-settings.json`, `managed-settings.d` or `managed-mcp.json` as a
whole quoted string (`"…"`, `'…'` or a template literal). It used to search for the bare text, so a
rename to `new-remote-settings.json` passed: the old name survived inside the new one. Each of the
six is a double-quoted literal in 2.1.332. Two things the check still cannot see: a wholly new
source under a new name, and a rename of the reader while the old quoted name survives elsewhere
(2.1.332 also lists `"remote-settings.json"` in the signature cleanup list, `Uwa=["remote-settings.json",
"policy-limits.json"].map(Ayt)`). Tying each name to its reader's code would key on minified names
that change with every release, so it is not done.

Read from the 2.1.332 bundle. The plist list, per-user first and only for a safe user name:

```js
var r="com.anthropic.claudecode",s="ClaudeCode",AXt=`HKLM\\SOFTWARE\\Policies\\${s}`,E6r=`HKCU\\SOFTWARE\\Policies\\${s}`,
  CZn="Settings",Pwa="/usr/bin/plutil",zed=["-convert","json","-o","-","--"],Ved=["-lint","-s","--"],EGo=5000,jqs=60000,Gqs=2097152
function Yed(){let e="";try{e=i().username}catch{}let o=[],n=/[/\x00-\x1f\x7f]/.test(e);
  if(!["",".",".."].includes(e)&&!n)o.push({path:`/Library/Managed Preferences/${e}/${r}.plist`,label:c});
  return o.push({path:`/Library/Managed Preferences/${r}.plist`,label:"device-level managed preferences"}),o}
```

The first plist that answers wins (`o6r`): each plist is checked with `access(R_OK)` (`ENOENT`
skips it), converted with `plutil -convert json`, and on a failed conversion linted with
`plutil -lint -s`: a plist that lints is unconvertible and answers `null`, a damaged one answers
`{stdout:""}`. Then the list is cut after the first answer,
`u=o.findIndex((s)=>s.stdout!==null);return{plistStdouts:u===-1?o:o.slice(0,u+1),...}`, so a
per-user plist that converts without any policy key still hides the device plist.
`readManagedPolicy` does the same, and `inherited-settings.test.ts` pins it: a per-user plist
without `disableSideloadFlags` beside a device plist that sets it keeps `--mcp-config`. The probe
gate stays presence-based, so any plist present refuses a probe, the device one included.

A plist that is present but unreadable is "Managed settings document (${e}) could not be read:
${n}; none of its settings are in effect." The composition, from the `managedSourcesBehavior`
schema text: `"first-wins" (default): the highest-priority source present (server-managed > MDM
(managed plist / HKLM) > managed-settings.json) is the managed tier alone. "merge": every present
source deep-merge…`. The server-managed cache: `u0t="remote-settings.json"`,
`function jV(){return bH()??Un(nt(),u0t)}`, read as a plain object
(`let a=Z(Ei(r));if(!a||typeof a!=="object"||Array.isArray(a))return null;`) and ignored over
`St=8388608` bytes ("Disk cache exceeds ${St} bytes; ignoring it as if absent"); `$`-prefixed keys
other than `$schema` are metadata. Measured on 2.1.332, isolated config with no stored login: a
`remote-settings.json` holding a `SessionStart` hook did NOT run it under the plugin probe's argv,
so without a login Claude Code does not apply the cache; with an organisation login it was not
measured (no such account in an isolated config). The MDM plists were not measured live: writing
under `/Library` needs root, and the tests never touch it. A binary plist converted by the real
plutil is read in `plugin-probe.test.ts` and `inherited-settings.test.ts` (macOS only).

#### The caller's cwd-bound MCP servers: `inherited-mcp.json`

Two MCP scopes are found from Claude Code's cwd, so a child in another directory can lose them:
project `.mcp.json` (walked up from the cwd) and local scope (`.claude.json`
`projects[<main checkout>].mcpServers`). The settings layer carries only approval NAMES
(`enabledMcpjsonServers`), never a definition. `buildInheritedMcpConfig`
(`inherited-settings.ts`) collects what the child would lack, under two separate gates:

`setup_from` is taken by its real path for every step (the walk-up, the main checkout, the
`.claude.json` key and both gates): a symlinked `setup_from` would otherwise read another
tree's ancestors and miss the local-scope entry. That Claude Code keys `.claude.json` by its
REAL cwd is not measured: M9 measured only that the key is the main checkout. A `work_dir` that
does not exist yet is compared by the real path of its nearest existing ancestor plus the
remaining segments.

**An enterprise `managed-mcp.json` hands over nothing.** While that file exists, Claude Code
refuses every `--mcp-config` server and the child would not start. Read from the 2.1.332
bundle: the file is `<managed dir>/managed-mcp.json` (`hGt(){return Yq($w(),"managed-mcp.json")}`),
the managed dir is `/Library/Application Support/ClaudeCode` on macOS and `/etc/claude-code`
on Linux, and the check refuses a dynamic config that holds any ordinary server:

```js
if(Kdt()===null){if(n)return{kind:"refuse",message:"You cannot use --strict-mcp-config when an enterprise MCP config is present"};
let h=Object.entries(e).filter(([y,k])=>!tHt(y,k));
if(h.length>0)return{kind:"refuse",message:...:"You cannot dynamically configure MCP servers when an enterprise MCP config is present"}
```

The file counts as present unless reading it fails with `ENOENT`/`ENOTDIR`; an unparseable file
keeps exclusive control and the servers are dropped instead. claudish checks only that the path
exists, writes a log line naming it, and builds no `inherited-mcp.json`. The managed paths come
from `realManagedPaths()`: all three files sit in the directory of `managedSettingsPath()`.
`SessionManager` takes them as the `managedPaths` option, which the pane tests point at an empty
temp directory.

**A managed `disableSideloadFlags: true` hands over nothing too**, because Claude Code 2.1.332
reads it from policy settings only (`yD(){return he("policySettings")?.disableSideloadFlags===!0}`,
a restrictive key, so a `true` in the base file or any drop-in wins over a `false` elsewhere) and
exits at startup on a non-sdk `--mcp-config` (`dt=yD()&&!MHi(lt);if(dt&&!we){let
st=EIt(["--mcp-config"]);return cm(st),...Yn(void 0,void 0,"sideload_flags_disabled")}`), so
claudish builds no `inherited-mcp.json` while any managed policy source sets it (the
server-managed `remote-settings.json`, a managed preference plist, `managed-settings.json` or a
drop-in; see "The managed policy sources claudish reads" above), and logs that source's path.
Before the plists were read, an MDM `disableSideloadFlags` passed this gate and the child exited
at startup on the inherited `--mcp-config`. **A managed source Claude Code skips is skipped here
too** (above): an earlier rule withheld the servers beside any source claudish could not read, and
so changed the argv of a same-repository child (a linked worktree outside `setup_from`'s tree) beside
a malformed plist, an oversize remote cache, or on any Windows machine, where Claude Code itself
would have accepted `--mcp-config`.

- **`.mcp.json` servers, only when `work_dir` is not within `setup_from`** (`isWithin`: realpaths,
  compared by path segment, so `/a/bc` is not within `/a/b`). The `.mcp.json` of every folder
  Claude Code's walk-up from `setup_from` reads (`mcpJsonWalkDirs`), the nearest file winning a
  name clash, minus every name in `disabledMcpjsonServers` from the inherited settings layer, the
  `.claude.json` project entry, the user settings file (`userSettingsFile`:
  `<CLAUDE_CONFIG_DIR>/settings.json`, else `$HOME/.claude/settings.json`) and every managed
  policy source (the remote settings, both plists, `managed-settings.json`, then every drop-in in
  `managed-settings.d`), because a `--mcp-config` server bypasses that list (M5). Inside the tree the child's own walk-up already
  finds them.
- **The walk-up, as the 2.1.332 bundle walks it** (`MHt`, case `"project"`):

  ```js
  z=vs()??A;while(z!==Qoi(z).root){if(Rle(z)&&Vyt(z))k.push(Yq(z,".mcp.json"));else if(!i3(z))y.push(z);z=Xoi(z)}
  ```

  It stops BEFORE the file system root, so `/.mcp.json` is never read, and claudish stops there
  too. A folder in a connector-downloads folder is left out. `Rle` is `configFolderInDownloads`
  and `Vyt` is `isClaudeDownloadsFolderAbove` (the chunk's export names); a path segment is a
  connector-downloads folder when `a0t` holds, after lower-casing, `ſ` read as `s` and invisible
  format characters dropped:

  ```js
  uM="connector-downloads";var aa=new RegExp(`^${uM}[. ]*(?::.*)?$`);
  function a0t(e){return e.length>=uM.length&&aa.test(e.toLowerCase().replaceAll("ſ","s").replace(q3e,""))}
  ```

  claudish leaves out every folder with
  such a segment; `Vyt` additionally asks whether the folder is Claude Code's own downloads
  folder, so claudish may leave out a file Claude Code reads, never the reverse. An automount
  map root is left out (`i3`): a path in `CLAUDE_CODE_AUTOMOUNT_ROOTS`
  (`s.CLAUDE_CODE_AUTOMOUNT_ROOTS?.split(u).some((r)=>S(r)&&g(r)===e)`, `u` the path delimiter),
  or on Linux a folder directly under `/` whose `statfs` type is autofs (`M=391`, 0x0187).
  claudish reads `CLAUDE_CODE_AUTOMOUNT_ROOTS` from the child's environment. A folder at or
  under either browser-downloads root is left out as well, whatever `Vyt`'s other checks say:
  `Vyt` returns true first when `ozo` holds, and `ozo` matches the fixed roots of `L3e`
  (`so` and `s0t`, both under `/mnt/user-data`):

  ```js
  oo="/browser-downloads",...,so=Ae(Me(FD),oo),io="/desktop-browser-downloads",...,s0t=Ae(Me(FD),io)
  // FD="/mnt/user-data/uploads", so Me(FD) is "/mnt/user-data"
  function qDe(e){...let n=we.normalize(e.split("/").slice(0,-1).join("/"));return L3e.find(({fixedRoot:r})=>n===r||n.startsWith(`${r}/`))?.savedBy}
  function Vyt(e){if(ozo(`${e}/.`))return!0;...}
  ```

  claudish leaves out `/mnt/user-data/browser-downloads` and
  `/mnt/user-data/desktop-browser-downloads` and every folder below them, compared on the
  path as walked.
- **A folder above both `setup_from` and `work_dir` is left to the child.** The child's own
  walk-up reads that folder's `.mcp.json`, under the child's own disabled lists, so a copy in
  `inherited-mcp.json` would only bypass those lists. Only folders the child's walk-up does not
  reach (none holding `work_dir`) are read.
- **A `.mcp.json` Claude Code skips is skipped.** In the walk-up a file whose read fails
  (`_Wn` returns `config:null`) is logged and passed over:

  ```js
  if(!_e){let Se=ie.filter((Ce)=>!Ce.message.startsWith("MCP config file not found"));if(Se.length>0)t(`MCP config errors for ${Q}: ...`,{level:"error"}),h.push(...Se);continue}
  ```

  That covers an unreadable file, invalid JSON and a file whose shape fails the schema. A blank
  project file is no servers:

  ```js
  if(g==="project"&&!A.trim())return t(`MCP config is blank, read as no servers: ${n}`),{config:{mcpServers:{}},errors:[],present:!0,read:!0};
  ```

  A file larger than 2 MiB is skipped from its size, before it is read (`FYl` asks `cl`, which
  answers `skip` on `l.size>n`):

  ```js
  var fwe=2097152;function _Wn(e){...let Y=g==="dynamic"?y.readFileSync(n,{encoding:"utf8"}):FYl(y,n,fwe);if(Y===null)return t(`MCP config skipped for ${n} (scope=${g}): not a regular file or exceeds ${fwe} byte limit`,{level:"warn"}),...
  ```

  claudish does the same: a blank or whitespace-only file is no servers; a file over 2097152
  bytes is skipped after a `stat`, never read; an unreadable or malformed one (not JSON, not an
  object, `mcpServers` not an object) is skipped. Each skip gets a log line naming only its
  path, and the walk goes on.
- **The caller's `/mcp disable` list applies to both scopes.** Claude Code drops any server
  named in the `.claude.json` project entry's `disabledMcpServers` before it connects, whatever
  its scope, by exact name: `function ni(e){let n=$c();...return Aoe(n.disabledMcpServers).includes(e)}`,
  `Aoe(e){return Array.isArray(e)?e:[]}`. `$c()` is the child's own project entry, so a child
  under another key never sees the caller's list. claudish withholds every name on the caller's
  list from the `.mcp.json` and local-scope servers it hands over, compared exactly (no `_`
  normalisation).
- **The disabled-list forms**, as the 2.1.332 bundle reads them. An array of names, from every
  source. A string naming one server, from every source except managed settings: the
  normaliser `zLt` (`if(typeof o==="string"&&ns.test(o))e[n]=[o]`, `ns=/^[A-Za-z0-9_-]+$/`) runs
  only `if(!o?.policySource)`. The managed drop-ins are the names in `managed-settings.d` that end
  in `.json` and do not start with `.` (`Ele(e){return e.endsWith(".json")&&!e.startsWith(".")}`),
  read after the base file in sorted name order (`O.map((P)=>P.name).sort()`); arrays concatenate
  across them (`WZ`: `return R([...e,...n])`), so the lists add up. A disabled name matches a
  server whose name is equal once every character outside `[A-Za-z0-9_-]` becomes `_` (`Eeo`,
  `Ln`); a `plugin:` name matches only exactly.
- **The child's own disabled list cannot stop an inherited server.** A `disabledMcpjsonServers`
  in `work_dir`'s project or local settings filters only `.mcp.json` servers (M5), so a server
  handed over in `inherited-mcp.json` runs whatever the child's own settings disable.
- **Local-scope servers, only when the child's main checkout differs from `setup_from`'s**
  (`mainCheckoutRoot`; a directory outside Git is its own key). That covers a work_dir outside
  the repository and a separately initialised repository inside the tree; a linked worktree of
  the same repository gets nothing, since Claude Code keys local scope by the main checkout.
  Read from `claudeCodeGlobalConfigPath(parentEnv, work_dir)`, so `CLAUDE_CONFIG_DIR` moves it,
  and a relative `CLAUDE_CONFIG_DIR` resolves against the child's cwd, as the user settings path
  does. They win a `.mcp.json` server of the same name, as local scope does.
- **Same repository, outside `setup_from`** (the `.mcp.json` gate open, the local-scope gate
  closed): a name the shared local scope defines is left out of the file, so the local
  definition the child loads itself is not overridden by the `.mcp.json` one.
- **The caller's `--setting-sources`** (`enabledSettingSources`, either spelling, the last one
  wins) is honoured the way the child honours it: without `project` no `.mcp.json` server is
  handed over, without `local` no local-scope server (and no local name is withheld from the
  `.mcp.json` set), without `user` the user settings' disabled list is not read. The managed
  files, the settings layer and the `.claude.json` entry always apply. A child without
  `project` in its `--setting-sources` skips its own `.mcp.json`, and without `local` its
  local-scope servers; the 2.1.332 bundle gates both scopes on the setting sources before it
  reads them (`MHt`):

  ```js
  let r={project:"projectSettings",user:"userSettings",local:"localSettings"};
  if(e in r&&!(e==="local"?kLn():nn(r[e])))return{servers:jC(),errors:[]};
  ```

The servers go to `<sessionDir>/inherited-mcp.json` as `{"mcpServers": {...}}`, mode 0600 (a
definition can hold `headers.Authorization` and `env`), definitions copied VERBATIM. A
`${VAR}` reference stays unexpanded and the child expands it from its own environment (M7). A
literal value (a key in `env`, a header stored by `claude mcp add -e KEY=v` or written by hand)
is copied as it is into that 0600 file, and the file stays in the session directory after the
session ends, like every other session file. The file is written by `writePrivateJson`, which
narrows an existing file to 0600 BEFORE writing (`mode` applies only when a file is created; a
caller-supplied session id can reuse a directory). The child gets
`--mcp-config <that file>` BEFORE the caller's own flags (`["--mcp-config", file, ...rest,
"--settings", layer]`), so a caller's own `--mcp-config`, coming later, wins a name clash.
`spawn.json` records only the names (`inheritedMcpServers`); no definition value is logged. No
server: no file, no flag. A caller flag `--strict-mcp-config` skips all of it: the caller has
stated the exact set. An unreadable or malformed `.mcp.json` is skipped with a log line naming
the file (an unreadable one says "cannot be read", not "not valid JSON"), as Claude Code skips
it. No message carries the parser's text, for `.mcp.json` and settings files alike: Bun's
message quotes the rejected token (`JSON Parse error: Unexpected identifier "<token>"`), which is
a credential when the unquoted value is a header or key. An unreadable or malformed
`.claude.json` or user settings file is skipped the same way, and never fails the call. An
unreadable or malformed managed policy source is skipped, as Claude Code skips it (above), and
never fails the call either. A malformed settings file of the inherited layer (`settings.json`,
`settings.local.json`, a `--settings` value) still fails the call as `invalid_args` naming it.
User-scope servers are global and need nothing.

Precedence an outside child sees: an inherited server beats a server of the same name in the
child's OWN `.mcp.json` (any `--mcp-config` beats `.mcp.json`, M4), so a child in project B whose
`.mcp.json` defines `db` runs project A's `db`. A caller's own `--mcp-config` beats both. Whether
a `--mcp-config` server beats the child's own local-scope server of the same name is not
measured.

Known gaps in the managed and walk-up reads, against the 2.1.332 bundle:

- **Windows managed directory.** The bundle's managed directory on Windows is
  `C:\Program Files\ClaudeCode` (`hr(){...case"windows":return"C:\\Program Files\\ClaudeCode";default:return"/etc/claude-code"}`);
  `managedSettingsPath()` uses `%PROGRAMDATA%\ClaudeCode`. On Windows the `managed-mcp.json`
  check and the managed disabled lists therefore read the wrong directory. Panes do not run on
  Windows, so no session reaches this today.
- **The Windows registry policy.** claudish checks only that a key holds a `Settings` value
  (above), and withholds the servers when one does: it does not parse the value. One `reg.exe` run
  per key per `create_session`. Panes do not run on Windows, so no session reaches this today.
- **The WSL second managed directory.** Under WSL with `wslInheritsWindowsSettings` Claude Code
  also reads `/mnt/c/Program Files/ClaudeCode` (`SH`) and the registry through
  `/mnt/c/Windows/System32/reg.exe`; the `inherited-mcp.json` gate reads only `/etc/claude-code`.
  The plugin probe never runs on WSL.
- **An invalid nearer server entry.** Claude Code validates each server entry of a `.mcp.json`
  before it merges the walk-up, so an invalid nearer definition does not hide a valid farther
  one of the same name: the farther one runs. claudish merges the definitions unvalidated, so
  the nearer invalid one wins the name, goes into `inherited-mcp.json`, and the child drops it;
  the child runs neither.

Measured on Claude Code 2.1.332, with stdio probe servers that write a marker file naming the
definition used:

- M2: `-p --output-format stream-json`, init `mcp_servers`: an outside folder lists `[]`; a plain
  subfolder of a folder holding `.mcp.json` lists the server with `source "project"` (walk-up
  needs no repository); `--mcp-config` lists its servers as `source "dynamic"`; a flag server
  and a same-name `.mcp.json` server give ONE entry, the flag one.
- M3: an unapproved `.mcp.json` server shows the "New MCP server found in this project" dialog
  in default and `--permission-mode auto` and is not spawned; under bypass permissions (the pane
  child's mode, `-y`) it is spawned unapproved, even with user `enableAllProjectMcpServers:
  false`. A `--mcp-config` server spawns with no dialog in every mode.
- M4: on a name clash the LAST `--mcp-config` wins, and any `--mcp-config` beats `.mcp.json`.
- M5: `disabledMcpjsonServers` filters only `.mcp.json`; a `--mcp-config` server of a disabled
  name is still spawned, so claudish drops disabled names itself.
- M6: `--strict-mcp-config --mcp-config <f>` spawns only `<f>`'s servers.
- M7: `${VAR}` and `${VAR:-default}` in a `--mcp-config` file are expanded against the CHILD's
  environment, in `-p` and interactive.
- M8: a caller's `.mcp.json` servers are on because the caller runs in bypass permissions mode,
  not because of an approval entry; every pane child runs bypass too.
- M9: `claude mcp add --scope local` keys the server by the MAIN checkout in `.claude.json`;
  every worktree and subfolder of that repository sees it, an outside folder does not.
- `claude mcp list` ignores `--mcp-config`, and the flag is variadic, so it is never followed by
  a positional (`checkChildFlags` refuses positionals).

#### The caller's plugin copies: `--plugin-dir`

Claude Code picks a plugin's copy from its OWN launch directory (the install rows that apply to
its real cwd), not from the settings that enable the plugin. So a child whose cwd applies other
rows loads another version of a plugin the caller loads, or none: outside the repository, in a
separate repository nested inside the caller's tree, and in a subfolder of a `setup_from` that is
not in Git. Rather than re-implement that choice (install-row keying, file order, the settings
merge, managed marketplace policy, a plugin its marketplace dropped, naming), `createSession` asks
Claude Code: `inheritedPluginsFor` (`mcp-session/plugin-probe.ts`) starts it twice, quietly, and
reads which copies each launch loads.

**When it runs.** Only when the handover can matter: `setup_from` is set and `work_dir` does not
share its main checkout (`sharesMainCheckout` in `inherited-settings.ts`; outside Git a folder is
its own key, so a subfolder of a non-Git `setup_from` is probed). A subfolder or a linked worktree
of the same repository applies the same rows: no probe, and the argv is byte-for-byte what it was.
No probe runs, and nothing is handed over, in the cases below, checked in this order, each recorded
as `pluginProbe` and logged once with the flag, the source, the platform or the host pid (never a
value or a url).

| `pluginProbe` | When | Why |
|---|---|---|
| `plugin_url` | the child's flags, or the caller's own launch, pass `--plugin-url` (either spelling) | the probes never get `--plugin-url` (below), so a marketplace copy a url plugin shadows would look loaded and be handed over |
| `managed_policy_present` | the child's flags or the caller's launch pass `--managed-settings`; the machine is Windows or WSL; or a managed policy source exists in the config dir of setup_from or work_dir (the server's `CLAUDE_CONFIG_DIR`), of the caller's launch directory (the caller's), or at a machine path (the "Probe gate" column of "The managed policy sources claudish reads") | below |
| `await_initialize` | the child's flags or the caller's launch pass `--await-initialize`, `--initialize-fields` or `--managed-settings-in-initialize` (either spelling) | under these Claude Code reads its first stdin line as an `initialize` request that can carry inline plugins (`--plugin-dir` entries "so the launch command line does not grow with the plugin count"), MCP servers ("the stdin form of one --mcp-config item"), settings (`--initialize-fields=settings`: "applies them as it applies --settings") and managed settings (`--managed-settings-in-initialize`). None of that is in the argv, so no probe can model it. 2.1.332 treats any of the three as that mode (`ye()`: `--managed-settings-in-initialize`, then `--initialize-fields`, then `--await-initialize`); `claude plugin configure --values-stdin` is a subcommand, never a session launch |
| `caller_argv_unreadable` | the caller's process (the MCP host) has no argv claudish can read exactly, or is not a Claude Code launch whose argv holds its flags | the caller probe must be started with the caller's own launch flags (below) |
| `caller_env_unreadable` | the caller's launch environment cannot be read, or one of its listed keys (`CLAUDE_CONFIG_DIR`, a plugin variable, a launch mode switch) is not exact UTF-8 | the caller probe must use the caller's config dir, which decides its install rows and user settings, and the caller's plugin variables and mode switches (below) |
| `caller_settings_unreadable` | the caller's own last `--settings` (inline JSON, or a path resolved against the host's cwd), or a user, project or local settings file whose `env` block the caller applies (below), cannot be read or parsed, is not a regular file, is not an object, or holds an `env` that is not one | it may turn a plugin off, or set a launch mode switch the gate below must see |
| `caller_mode_unmodelled` | the caller runs in safe mode (`--safe-mode` before any `--`, or `CLAUDE_CODE_SAFE_MODE` on in its effective environment, below) or bare mode (`--bare`, or `CLAUDE_CODE_SIMPLE`), with "on" as 2.1.332's `He()` reads it: `1`, `true`, `yes` or `on`, any case, trimmed. Also: cowork plugins mode, `CLAUDE_CODE_USE_COWORK_PLUGINS` on in the caller's launch environment or in ANY of its settings `env` layers (a later `0` never clears it, below), in the server's environment (the child's spawn environment), in the inherited layer's `env`, or in the `env` of a settings file the child probe reads, or `--cowork` in either launch's flags; a caller settings `env` block that sets `CLAUDE_CONFIG_DIR` to another value than the launch's; and a caller settings `env` block that sets `CLAUDE_CODE_RESTRICTED` to a value whose on/off reading differs from the launch's (`--restricted` before any `--`, or the launch environment's value) | measured on 2.1.332: safe and bare mode keep the init `plugins` list unchanged but run none of those plugins' commands or skills (`if(Jo("plugins",{explicitlyRequested:…}))return[]`), so the probe would list copies the caller does not run, and a child handed them by `--plugin-dir` would run them. Restricted mode is not refused: it changes the list itself, and the caller probe gets the caller's LAUNCH switch (`restrictedMode` in the canary); only a settings layer that reads it otherwise refuses, since the caller chose its sources before that layer applied (below). Cowork plugins mode moves the plugin folder to `cowork_plugins` and the user settings file to `cowork_settings.json` (`ws(e){if(e.coworkPlugins\|\|s.CLAUDE_CODE_USE_COWORK_PLUGINS)return LO.cowork;return LO.default}` with `LO={default:"settings.json",cowork:"cowork_settings.json"}`); claudish does not model `cowork_settings.json`, so its helper gate would check the wrong file. The other way into that mode, `eqo(){return n().host.settingsSource.useCoworkPlugins()}`, is set only by `Are(!0)`, which only the `claude plugin …` and `claude plugin marketplace …` subcommands call, on their own `--cowork` (`if(o.cowork)Are(!0)`, 16 sites), never a session launch |
| `setup_from_not_caller` | setup_from and the caller's launch directory (the host's cwd) do not share a main checkout; outside Git, they are not the same folder | the inherited settings layer comes from setup_from, so it describes the caller only when the caller runs in that repository. `setup_from` accepts any existing directory: one in another repository, back when the caller probe ran in setup_from, listed that repository's project-installed copies, which the caller never loaded, and they were handed over. The caller probe now runs in the caller's own launch directory (below), and this refusal stays |
| `work_dir_command_setting` | work_dir's project `settings.json` or a local settings file of a launch there, or the project settings of the child's last `--project-config-root` (resolved against work_dir), sets a command-valued setting (below), or cannot be parsed | the work_dir is not trusted, and `-p` skips the trust dialog the pane child stops at |
| `caller_command_setting` | the caller's launch directory's project `settings.json` or a local settings file of a launch there, or those of the caller's last `--project-config-root` (resolved against that directory), sets `apiKeyHelper`, `otelHeadersHelper`, `proxyAuthHelper`, `awsAuthRefresh`, `awsCredentialExport`, `gcpAuthRefresh` or `policyHelpers`, or cannot be parsed (a file the caller loads that cannot be parsed already answers `caller_settings_unreadable` above) | the caller trusted that directory, so the caller probe's boot would run such a helper (below) |
| `user_command_setting` | the user `settings.json` a probe loads (in that probe's config dir: its own environment's `CLAUDE_CONFIG_DIR`, else `~/.claude`, resolved against its cwd; skipped for a probe whose `--setting-sources` leaves out `user`) sets `apiKeyHelper`, `otelHeadersHelper`, `proxyAuthHelper`, `awsAuthRefresh`, `awsCredentialExport`, `gcpAuthRefresh` or `policyHelpers`, or cannot be parsed | user settings are trusted, so no dialog stops a helper there, and a probe needs no credential (below) |

**Why no probe beside any managed policy.** A managed policy reaches into a probe in ways its flags
cannot close. Managed hooks run despite the probe's `disableAllHooks`: in 2.1.332 the function that
picks the settings hooks reads managed settings first,

```js
function r(){let o=he("policySettings");if(o?.disableAllHooks===!0)return{};
  if(o?.allowManagedHooksOnly===!0||ms())return o?.hooks??{};if(zl("hooks"))return o?.hooks??{};
  let t=dr();if(t.disableAllHooks===!0){if(!dNr())return o?.hooks??{};return l()} ...
```

so `allowManagedHooksOnly`, or even a plain managed `hooks` block, runs before init, too early to
stop. A managed `env` outranks the probe's closed `env` block. A managed `forceLoginOrgUUID` runs an
organisation check against the stored login before init. A managed `policyHelpers` entry runs a
helper whose policy is applied before init. A gate per key leaves the next path open (a policy
helper, the WSL Windows chain and the hybrid sign-in cache are three); a gate that reads no key at
all has nothing left to miss. The cost: on a managed machine the
child gets no plugin copy, and `pluginProbe` says why.

**The caller's own launch, read from the host process.** The caller probe must load what the caller
loads, so it gets the caller's launch flags, not the child's: a caller started with
`--settings` that turns off a project-installed `alpha@m`, probed with the child's flags instead,
listed `alpha@m`, and the outside child (which has no install row for it) was handed the copy the
caller had turned off. The MCP host is the caller's Claude Code process; `SessionManager` already
knows its pid (`hostPidFrom`: our parent, or the npm launcher's parent; `spawn.json` `hostPid`), and
`readHostLaunch` (`mcp-session/host-launch.ts`) reads its argv and cwd exactly:

| Platform | argv | cwd |
|---|---|---|
| macOS | `sysctl(CTL_KERN, KERN_PROCARGS2, pid)` through `bun:ffi` on libSystem: `int argc`, the exec path NUL-padded to a multiple of 8 bytes, then `argc` NUL-terminated arguments (`argvOfProcargs`). Measured on this Mac for exec paths of every length mod 8: argv[0] starts exactly at that aligned end. An empty argv[0] (`perl -e 'exec {"/bin/sleep"} "", "30"'`) puts one more NUL there; the old parser skipped every NUL after the path, took that empty argument for padding, read argv[1] as argv[0] and the first environment entry as the last argument. Now a NUL at the aligned start, a non-NUL byte in the padding, or a buffer that ends early reads as null | `proc_pidinfo(pid, PROC_PIDVNODEPATHINFO)`: the NUL-ended path in the 1024-byte field at byte 152 of the 2352-byte `proc_vnodepathinfo` (`cwdOfVnodePathInfo`). The NUL is looked for inside that field only: a field with none is null, where the old scan accepted the next struct's first byte as its end |
| Linux | `/proc/<pid>/cmdline`, NUL-separated (`argvOfCmdline`). Unreadable: one that does not end in NUL, and a rewritten process title, read as arguments after `argv[0]` that are all empty. 2.1.332 sets `process.title="claude"` unless `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` is set, and on Linux the title is written over the argv area with NULs after it, so `claude\0\0…` ends in NUL and would otherwise read as a launch with only empty flags: the caller probe would run without the caller's `--settings`. Not measured on Linux; on macOS `KERN_PROCARGS2` keeps the original argv (`ps` shows live sessions' full argv) | the `/proc/<pid>/cwd` link |
| elsewhere | none: `caller_argv_unreadable` | |

**The caller's launch environment keys.** `readHostLaunch` also reads a FIXED list of keys of the
host's launch environment (`CALLER_LAUNCH_ENV_KEYS`, `probe-launch-vars.ts`): `CLAUDE_CONFIG_DIR`,
the plugin variables (`PROBE_PLUGIN_VARS`) and the launch mode switches (`PROBE_MODE_VARS`, both
tables below). On macOS they come from the environment strings that follow argv in the same
`KERN_PROCARGS2` buffer, up to the empty string before the apple strings (`hostEnvOfProcargs`); on
Linux from `/proc/<pid>/environ` (`hostEnvOfEnviron`); the first copy of a key wins, as `getenv`
reads. Every other entry is compared by its key prefix and dropped, and no value is ever logged.
The server's values are not the caller's: the MCP server may run with any of them set by an `env`
in its server definition, and 2.1.332 removes several from what it hands the processes it starts
(`Y1a(e)` deletes `S=["CLAUDE_CODE_SAFE_MODE","CLAUDE_CODE_SIMPLE","CLAUDE_CODE_RESTRICTED",...[]]`,
then the same function deletes `CLAUDE_CODE_PLUGIN_DIRS`, `CLAUDE_CODE_SKIP_PLUGIN_LOCAL_MCP_SERVERS`
and `CLAUDE_CODE_SKIP_PLUGIN_MCP_BUNDLES`). So the caller probe gets the caller's value of every
listed key, or none when the caller was started without it, never the server's (`callerEnvOf`);
the child probe keeps the server's, as the child does. A buffer with no environment terminator, a
listed value that is not exact UTF-8, or an unreadable `environ` refuses (`caller_env_unreadable`).
macOS shows no environment for a platform binary (`/bin/sh`, `/bin/sleep` read as null), but does
for Claude Code; `host-launch.test.ts` reads a live Bun child whose environment holds a second,
secret-looking key and gets only `CLAUDE_CONFIG_DIR` back. The same read takes
`CLAUDE_CODE_USE_COWORK_PLUGINS` (`HOST_READ_ENV_KEYS`), only to refuse: it is never handed to a
probe.

**The caller's effective environment** (`callerEffectiveEnv`, `plugin-probe.ts`). The launch
environment is not what the caller runs under: 2.1.332 applies each settings `env` block to
`process.env` before it loads plugins, so a switch set only in the caller's `--settings` is on.
The order, from the bundle:
`ks=["userSettings","projectSettings","localSettings","flagSettings","policySettings"]`, filtered by
`Jr(){let e=HNt(),…let t=new Set(e);t.add("flagSettings"),t.add("policySettings");let o=ks.filter((i)=>t.has(i));…}`
(the enabled sources, plus flag and policy always), then the full pass
`for(let H of Jr()){let F=this.filterSettingsEnv(he(H)?.env,H,…);if(eK(H)){…Object.assign(process.env,F);…}else this.assignFromAboveTheRepository(F)}`
with `assignFromAboveTheRepository(e){Object.assign(process.env,e);…}`: user, project, local,
flag (`--settings`, file or inline JSON), managed, each over the launch environment and a later one
winning. A `-p` boot runs that pass before plugins load (`if(ge()){T1();…` precedes
`plugin_init`); the interactive boot runs it once the folder is trusted. Managed is never read
here: no probe runs beside a managed policy source. Restricted mode empties the first three
(`qNs(){…if(Zv("--restricted")\|\|ILe())m(""),…}`), as does a `--setting-sources` that leaves one
out. So claudish reads the caller's user settings (in its own config dir), its project and local
settings (its launch directory and its last `--project-config-root`) and its `--settings`, each
only when the caller loads that tier, and from each `env` block only the keys it needs; no value is
logged. A missing file is skipped; one that is not a regular file, or cannot be read or parsed,
refuses (`caller_settings_unreadable`). Each file is opened `O_RDONLY | O_NONBLOCK`, `fstat`ed on the
open descriptor and read from it, so a named pipe swapped in between the check and the read
never blocks the server; the command setting gates read their files the same way. A string value is kept, a number
or boolean as its string, anything else dropped, as 2.1.332's `K()` does.

A project or local block may not apply: 2.1.332 drops many keys a project's settings set
(`pt(e,n,r,E,_,f){if(!e\|\|!eK(n))return e;…if(!z(S)\|\|…)continue;…delete g[S]…}`, "project-scoped
settings can't set this key"; `CLAUDE_CODE_SAFE_MODE`, `CLAUDE_CODE_SIMPLE`, `CLAUDE_CONFIG_DIR`,
`CLAUDE_CODE_PLUGIN_CACHE_DIR`, `_SEED_DIR` and `_DIRS` are among the listed names, not every
switch is). claudish does not model that filter. The mode gate counts a switch on when it is on
in ANY order of applying or dropping each project and local block, keys compared in any case: a
project `1` refuses, and a project `0` does not clear a user `1`. The caller probe is given the
launch value of each `CALLER_LAUNCH_ENV_KEYS` key with the user and `--settings` values over it
(exact names, the later winning), so a plugin variable set only in `--settings` reaches the
probe; project and local values are left to the probe's own boot, which reads the same files and
applies Claude Code's own filter. `CLAUDE_CONFIG_DIR` and `CLAUDE_CODE_RESTRICTED` always stay the
launch's (below); `CLAUDE_CONFIG_DIR` decides where the user settings were read, and a settings block that sets it to another value refuses
(`caller_mode_unmodelled`).

**Two switches act at launch only.** 2.1.332 picks the setting sources inside
`eagerLoadSettings`, before any settings `env` block applies:
`function sea(){…ds("eagerLoadSettings_start");let r=J_("--settings");if(r)VNs(r);let g=J_("--managed-settings");if(g)KNs(g);qNs(),v(),ds("eagerLoadSettings_end")…}`
with `qNs(){let e=J_("--setting-sources");if(e!==void 0)m(e);if(Zv("--restricted")\|\|ILe())m(""),…}`.
The user settings file is named the same way, by the launch environment, when the settings are
first read: `ws(e){if(e.coworkPlugins\|\|s.CLAUDE_CODE_USE_COWORK_PLUGINS)return LO.cowork;return LO.default}`.
So for these two keys a settings layer's value does not undo what the launch chose:

| Key | Probe gets | Refuses (`caller_mode_unmodelled`) |
|---|---|---|
| `CLAUDE_CODE_RESTRICTED` | the launch environment's value only (`--restricted` reaches it as a flag), never a settings layer's | a user, project, local or `--settings` layer sets it to a value whose on/off reading (`He()`) differs from the launch's: `--restricted` before any `--`, or the launch value on. The probe started with that value would choose other sources than the caller did |
| `CLAUDE_CODE_USE_COWORK_PLUGINS` | never (read to refuse) | on in the launch environment, or on in ANY settings layer the caller reads; a later `0` does not clear a launch or user `1` |

`--restricted` counts only before `--`, as for `--safe-mode` and `--bare`: after it the word is a
prompt.

Only an integer pid from 2 to 2^31-1 is read. The native calls declare the pid a signed 32-bit
`int`, so a larger number reached the call truncated: `2**32 + process.pid` read the current
process's own launch. Pid 1 (launchd, init) is never a caller.

`ps -o args=` and `ps -ww -o command=` are not used: they join the arguments with spaces, so
`--settings "/a b.json"` and two arguments `/a` `b.json` print alike. Measured on this Mac: a
`zsh -c` argument holding spaces, quotes and a newline came back as one exact token, a test's
`/bin/sh` with an empty argument, a `--settings={"x": 1}` argument, a newline and non-ASCII
text round-trips, the test's own process reads as `ps` shows it, and pid 0, 1, a negative, a
fraction, an out-of-range and a gone pid read as null, and so does a live process with an empty
argv[0] (`host-launch.test.ts`, which also feeds the parsers built buffers: truncated ones, a
missing NUL end, an `argc` larger than the strings present, exec paths of 1 to 17 bytes, an empty
argv[0], extra or missing padding, and a full cwd field with a NUL right after it). The flags are the tokens
after a native `claude` (or a binary under `claude/versions/`), or after `node`/`bun` and the
package's `@anthropic-ai/claude-code/cli.js` with no runtime option between (`callerLaunchFlags`).
Two hosts on this Mac show why the rest fails closed: one claudish MCP server's host was a
pre-started Claude Code spare, argv `claude bg-spare --bg-spare <socket>`, whose session flags
arrive over the socket and are in no argv; another's was Codex. Both read as
`caller_argv_unreadable`, as does any `bg-spare`, `bg-pty-host` or `daemon` subcommand or `--bg-*`
token.

From those flags the caller probe gets `--plugin-dir`, `--plugin-dir-no-mcp`,
`--project-config-root` (relative paths resolved against the host's cwd, as the caller resolved
them), `--setting-sources`, and
`--safe-mode`, `--bare`, `--restricted`. Those three only take away what a launch loads (2.1.332's
help: `--safe-mode` disables installed plugins, hooks and MCP servers; `--bare` skips hooks and plugin
sync; `--restricted` ignores the user, project and local settings files), so a probe given one runs
less, never more, and models the caller exactly. The caller's own last `--settings` (Claude Code
keeps only the last; inline JSON or a path against the host's cwd) becomes the caller probe's
settings layer, under the closed `env` block. `--plugin-url` and `--managed-settings` cannot be
modelled and start no probe, and neither can the `initialize` flags (`await_initialize`).

`--project-config-root <dir>` is hidden in 2.1.332's help: "Read project settings, .mcp.json and
the .claude config trees (…) from this directory rather than the working directory (for a session
a host starts in a worktree of it)". A caller started with it reads `enabledPlugins` from that
root; probed without it, a root that disables `alpha@m` while setup_from enables it would list
`alpha@m`, and the copy would go to the outside child (read from the bundle, not run live; the
unit test pins the argv). Each probe now gets its own launch's last root, absolute.

The child probe keeps the child's flags, the same kinds: `--setting-sources` included. Each probe
gets its own launch's sources, the child probe exactly what the child gets, and the inherited
layer is built under the same sources (`inheritedLayerFor`), so a child `--setting-sources` needs
no refusal.

Limits, stated plainly: the probe runs only on machines with no managed policy source; the caller's
argv is read from the host process, so a caller that is not a plain Claude Code launch (a pre-started
spare, another MCP host, a Node launch with runtime options) gets no hand-over; the host's cwd is its
current directory when the call runs, which Claude Code does not change in a session but nothing
pins; and a value-taking option whose value happens to spell one of these flags is read as that
flag (the scan, like Claude Code's own help, has no full option table).

**The caller probe runs where the caller runs.** It used to run in setup_from, which
`setup_from_not_caller` only required to share the caller's main checkout. Sharing a main checkout
is not sharing project settings: two linked worktrees hold their own `.claude/settings.json` (each
its own branch), and project settings load from the working directory alone. With setup_from = the
main checkout enabling `alpha@m` and the caller in a linked worktree whose `settings.json` sets
`alpha@m: false`, the probe in setup_from listed `alpha@m` and its copy went to an outside child,
though the caller never loaded it (`plugin-probe.test.ts`, "boots the caller probe in the caller's
own launch directory"). The probe now runs in the host's cwd (`readCallerLaunch`), the directory
the caller's relative flags and `--settings` path were already resolved against. The default case
is unchanged: setup_from defaults to the MCP server's cwd, which is the caller's launch directory
when Claude Code starts the server, so the probe runs in the same folder as before (the test pins
that case too).

**The probe.** Two at once, one with cwd = the caller's launch directory, real path (the caller
probe) and one with cwd = work_dir's (the child probe), each:

```
<claude> --output-format stream-json --verbose --settings <tmp>/<caller|child>-settings.json \
  --strict-mcp-config --no-session-persistence <that launch's plugin-loading flags> -p /effort </dev/null
```

| Part | Why |
|---|---|
| `<claude>` | `findClaudeBinary` of the probe's environment, `CLAUDE_PATH` first: the binary the child claudish starts. The probe spawns in another cwd, so the binary is spawned by an absolute path (`pluginProbeRunner`). An absolute `CLAUDE_PATH` or found path is used as is: the spawn follows its symlinks. A relative one is accepted only when, past one leading `./`, it has no empty, `.` or `..` segment and no trailing slash; it is then joined to the server's cwd as plain text (`claudePathIn`, `pane-launch.ts`), which is exactly the path the kernel walks, so nothing is resolved by claudish. A component walk or `path.resolve` would not be: with `link -> a/b` they read `./link/../bin/claude` as the file the kernel does not start, and from `/` a walk accepts `./usr/bin/true/` and `./usr/bin/true/.`, which the kernel refuses (`ENOTDIR`). Any other relative value, or a joined path that is not a file with the execute bit, refuses as `no_claude_binary`. The pane child gets the same absolute `CLAUDE_PATH` (`buildPaneEnv`), since it runs in work_dir; there the same refusal is a `PaneClaudePathError` (`no_claude_binary`) before anything is spawned. Its last step runs `command -v claude` in a shell; that shell leads its own process group, the probe's deadline and a shutdown abort it (`shellLookup` kills the group), and the probe answers only once the shell is gone, so a lookup stalled on a hung `PATH` mount outlives neither |
| `-p /effort` | a prompt that does no work (below): `/effort` with no argument answers locally with its usage line, needs no credential, and prints the init event with no model request while a credential is present (table below) |
| `--output-format stream-json --verbose` | the init event (`{"type":"system","subtype":"init",…}`) is printed only in this form |
| `--settings <file>` | `pluginProbeSettings`: for the child probe the inherited layer the child gets, for the caller probe the caller's own launch `--settings` (never the inherited layer: a layer read from a main checkout's `settings.local.json` could turn on a plugin the caller never loaded); without its `hooks` and every command-valued setting (neither changes which plugins load); then `disableAllHooks: true` (plugin `SessionStart` hooks otherwise run on every probe boot) and the closed `env` block (below) over it. One file per probe, because Claude Code keeps only the last `--settings`. Both written 0600 in one temp folder (0700), never in setup_from or work_dir, and removed once both probes end. The folder's name carries the server's pid (`claudish-plugin-probe-<pid>-XXXXXX`). A server killed mid-probe (`SIGKILL` runs no `finally`) leaves its folder, which holds the caller's `--settings` content; at server start and before each probe pair, `sweepStaleProbeDirs` removes every such folder of this user (a real folder, not a symlink) whose pid is gone, at any age. A folder whose pid is alive goes only after 10 minutes (that pid was reused), as does one named without a pid |
| `--strict-mcp-config` | plugin MCP servers are otherwise spawned; that wait was most of the boot (2.8 s with one, 1.0 s without) |
| `--no-session-persistence` | no transcript, so the probe never shows in the resume list |
| that launch's plugin-loading flags | the caller's own launch flags for the caller probe, the child's for the child probe (above): `--plugin-dir`, `--plugin-dir-no-mcp`, `--project-config-root`, `--setting-sources`, `--safe-mode`, `--bare`, `--restricted`. A relative `--plugin-dir`/`--plugin-dir-no-mcp`/`--project-config-root` is resolved against the host's cwd for the caller probe and against work_dir for the child probe, as each launch resolves it. `--plugin-url` is never passed: Claude Code downloads it before init, sending the url (often a signed one) from every probe; a launch that passes it gets no probe at all (`plugin_url`). Every other flag stays out |
| stdin `/dev/null` | no input; the probe is its own process group, killed with `SIGKILL` on every way out (below) |

**The probe prompt must do no work.** Claude Code prints the init event only after the prompt is
processed (2.1.332, `CLAUDE_CODE_PROFILE_STARTUP=1`: every startup mark is done by 207 ms, then
`after_processUserInput` comes 9 s later, and init with it). So whatever the prompt does comes
before the plugin list, inside the probe's deadline. The probe used `-p /cost` until 2.1.332 on a
real machine showed the cost: `/cost` is an alias of `/usage` (aliases `cost` and `stats`), and on
a Claude subscription login `/usage` takes its subscription branch, which awaits the plan-usage
fetch (signed with the OAuth login) and a scan of the last 7 days of local transcripts together.
On the owner's Mac (27 GB of transcripts, 2140 files changed in 7 days) init, result and exit came
at 8.2 to 8.4 s, 9.3 to 9.4 s with both probes at once, CPU-bound at about 1.1 to 1.3 cores, so
every probe ran past its 8 s kill and answered `timeout`. The isolated canary, with no
subscription login, took the plain branch and answered in about 1 s, so it never saw this.
`/effort` with no argument, same flags, environment and cwd: 0.24 to 0.38 s, the identical plugin
list (same count, same sorted ids) and the same event shape. In the 2.1.332 bundle the
non-interactive `/effort` (`type:"local"`, `supportsNonInteractive:!0`) is:

```
async function Ywd(r,t){let e=r.trim(),o=t.getAppState(),a=Jt(o.mainLoopModelForSession??o.mainLoopModel??Fv());
if(rU.includes(e))return{type:"text",value:ztr()};
if(e==="current"||e==="status"){…}
if(!e)return{type:"text",value:`Usage: /effort <${GTe(a).join("|")}|auto${Z6(a)?"|ultracode [on|off]":""}>`};
return{type:"text",value:await xos(e,t,"noninteractive")}}
```

With no argument it returns the usage line before `xos`, the only path to the setter (`U2e`), and
everything it calls on the way is synchronous (`GTe` filters the effort levels by the cached
`modelAccessCache`; `Z6` reads workflow settings), so it writes no setting and sends no request.
The canary asserts the answer is that usage line, so a Claude Code whose `/effort` becomes a turn,
a picker or a setter turns the canary red before it reaches the probe.

**The spawn environment is an allowlist** (`pluginProbeEnv`), built from scratch rather than
from the pane child's minus a list: a denylist leaked twice (`ANTHROPIC_UNIX_SOCKET`, then
`CLAUDE_CODE_RUNNER_MODEL_SOCKET`, which a review traced through 2.1.332's `$4l()` on a nested
self-hosted Linux runner, before `--settings` applies; not measured here). From the parent it
takes only `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `LANG`, `LC_*`, `TERM`,
`XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`,
`CLAUDE_PATH` (the binary lookup's input), and, as the launch the probe stands for holds them (the
caller's own for the caller probe, read from its launch environment above), `CLAUDE_CONFIG_DIR`,
the variables 2.1.332 reads to decide which plugins load and from where (`PROBE_PLUGIN_VARS`):

| Variable | 2.1.332 reader |
|---|---|
| `CLAUDE_CODE_PLUGIN_CACHE_DIR` | `Xd(){let e=s.CLAUDE_CODE_PLUGIN_CACHE_DIR;if(e)return $p(e);return k(nt(),B())}`: the plugin folder |
| `CLAUDE_CODE_PLUGIN_SEED_DIR` | `oV(){let e=s.CLAUDE_CODE_PLUGIN_SEED_DIR;if(!e)return[];return e.split(Le).filter(Boolean).map($p)}`: seed folders |
| `CLAUDE_CODE_PLUGIN_DIRS` | `if(process.env.CLAUDE_CODE_PLUGIN_DIRS?.trim()){…setInlinePlugins…}`: folders loaded as `--plugin-dir` ones |
| `CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE` | `w6(){return s.CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE}function MCo(){if(!w6())return;let e=s.CLAUDE_CODE_PLUGIN_CACHE_DIR;…}`: marketplaces from a zip cache |

The settings files' location is decided by
`aOt=["CLAUDE_CONFIG_DIR","HOME","USERPROFILE","HOMEDRIVE","HOMEPATH","CLAUDE_CODE_USE_COWORK_PLUGINS"]`;
the three Windows names are left out, since no probe runs on Windows, and
`CLAUDE_CODE_USE_COWORK_PLUGINS` is not on the allowlist: it moves the plugin folder
(`B(){if(eqo())return H;if(s.CLAUDE_CODE_USE_COWORK_PLUGINS)return H;return re}`, `plugins` or
`cowork_plugins`) and the user settings file to `cowork_settings.json`, which claudish does not
model, so a launch that sets it gets no probe (`caller_mode_unmodelled`). No variable moves the
managed settings folder (`hr(){let e=qSa();…}` with `qSa(){return}`). Left out on purpose:
`CLAUDE_CODE_SYNC_PLUGIN_INSTALL` and `FORCE_AUTOUPDATE_PLUGINS`, which install or update plugins
over the network instead of choosing among the installed ones.

And the launch mode switches (`PROBE_MODE_VARS`): each is read at a `-p` boot and only takes away
setting sources, plugins, skills or MCP configs, so a probe given one loads less, never more. A
value the launch holds passes through unchanged; the probe never sets one itself.

| Variable | 2.1.332 reader |
|---|---|
| `CLAUDE_CODE_RESTRICTED` | `ILe(){return He(process.env.CLAUDE_CODE_RESTRICTED)}` and `qNs(){let e=J_("--setting-sources");if(e!==void 0)m(e);if(Zv("--restricted")\|\|ILe())m(""),LKo(!0);…}`: no user, project or local settings, as `--restricted`. Measured: a user-enabled and a project-enabled plugin both leave the init list |
| `CLAUDE_CODE_SAFE_MODE` | a caller in safe mode starts no probe (`caller_mode_unmodelled`); the child's value still passes to the child probe. `ms(){return He(process.env.CLAUDE_CODE_SAFE_MODE)\|\|kZt("--safe-mode")\|\|!1}`, `Jo(e,t){…if(ms()&&!a[e])return!0;…}` with `a={claudeMd:!1,skills:!1,workflows:!1,plugins:!1,…}`, and the plugin command and skill loaders' `if(Jo("plugins",{explicitlyRequested:…}))return[]`: as `--safe-mode`. Measured: the init `plugins` list is unchanged |
| `CLAUDE_CODE_SIMPLE` | a caller in bare mode starts no probe (`caller_mode_unmodelled`); the child's value still passes to the child probe. `eo(){return He(process.env.CLAUDE_CODE_SIMPLE)\|\|kZt("--bare")}` and `if(eo()&&!t?.explicitlyRequested)return l[e]` with `l={claudeMd:!0,skills:!0,workflows:!1,plugins:!0,…}`: bare mode, as `--bare`. Measured: the init `plugins` list is unchanged |
| `CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG` | `cb(){return s.CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG===!0\|\|…}` and `h=cb(),…if(Le.scope==="user"&&h)return y++,!1;…"[skill-as-plugin] not loading plugins from ${y} folder(s) in your own skills directory (CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG)…"`: no plugin from the user's own skills folder |
| `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS` | `k7(i){return s.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS\|\|(i??Rt()).disableBundledSkills===!0}` |
| `CLAUDE_CODE_DISABLE_POLICY_SKILLS` | `s.CLAUDE_CODE_DISABLE_POLICY_SKILLS\|\|hCe()\|\|Ye?Promise.resolve([]):Xz(h,"policySettings")` |
| `CLAUDE_CODE_DISABLE_CLAUDE_API_SKILL`, `CLAUDE_CODE_DISABLE_CLAUDE_CODE_SKILL` | `g({disabled:s.CLAUDE_CODE_DISABLE_CLAUDE_API_SKILL===!0});…y({disabled:s.CLAUDE_CODE_DISABLE_CLAUDE_CODE_SKILL===!0})` |
| `CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS`, `CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS_EXCEPT` | `if(s.CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS){if(!rAo(e,{fullIdsOnly:!1})){t(…Skipping plugin MCP server discovery for "${e.name}"…);return}…` with `rAo(e,{fullIdsOnly:n}){let r=s.CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS_EXCEPT;if(!r)return!1;…}` |
| `CLAUDE_CODE_SKIP_PLUGIN_LOCAL_MCP_SERVERS`, `CLAUDE_CODE_SKIP_PLUGIN_MCP_BUNDLES` | `L=!A&&s.CLAUDE_CODE_SKIP_PLUGIN_LOCAL_MCP_SERVERS,z=L\|\|!A&&s.CLAUDE_CODE_SKIP_PLUGIN_MCP_BUNDLES` |
| `ENABLE_CLAUDEAI_MCP_SERVERS` | `Hwr(){return s.ENABLE_CLAUDEAI_MCP_SERVERS===!1?"env_var":NWe()?"setting":void 0}`: no claude.ai connector |

Read and left out: `CLAUDE_CODE_MANAGED_SETTINGS_PATH` and `CLAUDE_CODE_REMOTE_SETTINGS_PATH`,
whose readers are empty in this build (`qSa(){return}`, `bH(){return}`);
`CLAUDE_CODE_SHOWN_PLUGINS_DIR` and `CLAUDE_CODE_DESKTOP_SKILLS_PLUGIN_DIR`, read only under a
desktop host (`n.setShownPluginsDir(wX()&&a!==void 0&&L(a)?a:void 0)`,
`n.setDesktopSkillsPluginDir(d?s.CLAUDE_CODE_DESKTOP_SKILLS_PLUGIN_DIR:void 0)` with `d=iu()`);
`CLAUDE_CODE_MCP_SERVE_SETTINGS` and `CLAUDE_CODE_MCP_SERVE_ENABLED_PLUGINS`, read only by
`claude mcp serve`; `CLAUDE_CODE_REMOTE_MCP_CONFIG`, read only in a remote session
(`let n=Ku()?s.CLAUDE_CODE_REMOTE_MCP_CONFIG:void 0`); `CLAUDE_CODE_PERSONAL_HOOKS_OFF` and
`CLAUDE_CODE_DISABLE_CLAUDE_MDS`, which change hooks and CLAUDE.md files only (the probe runs no
hook: `disableAllHooks`); `CLAUDE_CODE_PLUGIN_DIR_WATCH`, which changes which `--plugin-dir`
folders are watched, not loaded; and the plugin and skill sync switches, which install over the
network. The canary pins two of the switches against the real binary, in a world with one
user-enabled and one project-enabled plugin and the switch set in the caller's launch environment
only. `restrictedMode`: the caller probe must list exactly what a plain `-p /effort` boot under
`CLAUDE_CODE_RESTRICTED` lists; on 2.1.332 that drops both plugins, and with the switch dropped
from the allowlist the reading turned red (measured:
`differs:probe=…,projectonly@modemkt,useronly@modemkt;plain=…` with the builtins only).
`safeMode`: under `CLAUDE_CODE_SAFE_MODE` no probe may start and the outcome must be
`caller_mode_unmodelled` (`refused`); the summary also shows that the plain boot's list is the
same with and without the switch, the measurement behind that refusal.

Then the probe's own values: `ANTHROPIC_BASE_URL=http://127.0.0.1:9`, a
loopback port nothing listens on, `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1` and
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. No credential, handoff, socket, provider switch,
provider base URL or helper switch reaches the spawn, named or not. The canary pins it: its server
environment names a recording unix listener as `CLAUDE_CODE_RUNNER_MODEL_SOCKET` and another as
`ANTHROPIC_UNIX_SOCKET` (`runnerSocket=unused`, `unixSocket=unused`; with the old denylist a
stand-in that connects read `runnerSocket=connected:5`), and the real 2.1.332 boot still lists the
world's installed copy (`plugins=installed`, the same list as before the allowlist), and the live
handover still hands over 16 plugins, so the allowlist dropped no plugin-loading variable. The
provider switches still matter to the settings `env` block (below): 2.1.332's `IR` list
(`CLAUDE_CODE_USE_BEDROCK`, `_VERTEX`, `_FOUNDRY`, `_ANTHROPIC_AWS`, `_ANTHROPIC_GOOGLE_CLOUD`,
`_MANTLE`, `_GATEWAY`) and each provider's base URL. `CLAUDE_CODE_USE_` is not a prefix rule:
`CLAUDE_CODE_USE_COWORK_PLUGINS` changes which plugins load, and refuses a probe. The canary compares the binary's
`CLAUDE_CODE_USE_*` names with that split and turns red on a new or dropped switch. On the test
data below the init `plugins` list was the same against that closed port as against a logging mock
listener.

**Startup helper switches.** Two more variables never reach the spawn, and are closed to `""` in
the settings `env` block: `CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER` and `CLAUDE_CODE_ENABLE_TELEMETRY`
(`PROBE_STARTUP_HELPER_SWITCHES`). Each starts a settings helper at boot with no model turn and
no key: the first runs `proxyAuthHelper` (`G2o` stores the helper config and checks
`s.CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER`; `OLt` runs it), the second builds the OTLP exporter,
which prefetches `otelHeadersHelper` (`prefetchOtelHeadersFromHelper`, called when the exporter's
headers come from the helper over `http/json` or `http/protobuf`). User settings are trusted, so
nothing else stops a user helper. Measured on 2.1.332 with the canary world (below) and both
switches, `HTTPS_PROXY` and an OTLP/HTTP exporter in the server environment, before the change:
the production-argv probe ran the untrusted cwd's `proxyAuthHelper`, `otelHeadersHelper` AND its
local `apiKeyHelper` (no key anywhere; previously no project helper had ever run under the
production argv), and the second boot ran the user `proxyAuthHelper` and `otelHeadersHelper`.
After it: no marker in either boot. Which of the two switches let the local `apiKeyHelper` run
was not isolated. What else was checked in the bundle: `awsAuthRefresh` and `awsCredentialExport`
run only for the Bedrock and AWS providers, and `gcpAuthRefresh` only for Vertex and Google
Cloud, whose switches are withheld already; `policyHelpers` is a managed key, and no probe runs
beside a managed source; `statusLine`, `subagentStatusLine` and `fileSuggestion` belong to the
interactive interface; `processWrapper` is the daemon launcher's.

**User helpers start no probe (`user_command_setting`).** The switches close two known boot
paths, not every one: a 2.1.332 startup path read from the bundle (`Pe()` to `Oda()`) reaches
the `apiKeyHelper` prefetch with neither switch and no environment key. That path was not
confirmed live (below), and the gate does not depend on it. Rather than chase each path, no probe
starts while the user settings either probe loads set any helper a `-p` boot can run. Those are
the six the bundle lists together,

```js
var va=["apiKeyHelper","proxyAuthHelper","awsCredentialExport","awsAuthRefresh","gcpAuthRefresh","otelHeadersHelper"],
    Ta=["statusLine","subagentStatusLine","fileSuggestion"];
```

plus `policyHelpers`, read from managed and remote settings, refused beside at no cost
(`USER_STARTUP_HELPERS`). The file is the `settings.json` in each probe's config dir
(`userSettingsFile`: `CLAUDE_CONFIG_DIR`, else `~/.claude`, resolved against that probe's cwd),
read only for a probe whose `--setting-sources` loads `user`. One that cannot be parsed refuses too.
`--restricted` (which ignores the user settings file) does not lift the refusal; that is
deliberate, to keep the gate simple, and costs only a hand-over on such a launch.

The rest of `Nrd` does not refuse, because none of it runs under `-p`. `statusLine` runs only from
`jbs(...)`, whose one caller is the status line component (`execute:(Do,Wo,zo)=>jbs(ft,Do,Wo,zo)`
inside the interface's memo cache). `fileSuggestion` runs only from `bLi(...)`, whose one caller
is the `@` mention file suggester (`if((a?xfs(Rt().fileSuggestion):void 0)?.type==="command"){…
c=await bLi(g,f)`). `subagentStatusLine` runs from the interface's task rows ("subagentStatusLine
tick failed", "subagentStatusLine is deprecated in favor of mods"). `processWrapper` is described
as the "Corporate launcher argv prefix for the background-agent supervisor, the sessions and
workers it hosts, and the other covered background processes"; a `-p` boot only copies it into
the environment and starts none of those. Measured, not only read: the canary's user settings set
all four to marker scripts, and no boot of the canary (the production probe, the open run, the
`/cost` run, the fourth world below) ran any of them on 2.1.332 (`sideEffects=none`, three runs).

Whether a user `apiKeyHelper` runs at a production-argv boot with no switch, measured on 2.1.332
in the canary's fourth world (a placeholder subscription login, the closed `env` block, no switch
in the environment): `not-run` in three of three runs. The refusal does not depend on that answer:
a later Claude Code that runs it is still refused, and the canary reports the reading without
comparing it (`userApiKeyHelper`).

**The closed `env` block.** A settings `env` block replaces the launch environment
([`settings-env.md`](settings-env.md)), so a user, project or local settings file could hand the
probe back an API key or a gateway's base URL. Each probe's settings file therefore carries
`env: {ANTHROPIC_BASE_URL: "http://127.0.0.1:9"}` and every credential, handoff, provider switch,
provider base URL, helper switch and first-party switch above set to `""` (`PROBE_SETTINGS_EMPTY_VARS`),
over the layer's (a layer key equal to one of these in any case is
dropped: Claude Code keys `env` upper-cased). Claude Code applies the blocks in the order
`["userSettings","projectSettings","localSettings","flagSettings","policySettings"]`, a later one
winning, so `--settings` beats all but managed. Measured on 2.1.332, isolated config, two logging
listeners: with user settings `env` holding listener A and a fake key, `-p hi` posted six
`/v1/messages` to A with that key; with a `--settings` `env` of listener B and an empty key, it
printed "Not logged in · Please run /login" and neither listener saw a request; with listener B and
another fake key, all six went to B with the flag key. A managed `env` outranks the block, and no
probe runs beside a managed policy. A user `apiKeyHelper` is not closed by the block; no probe starts
while one is set (`user_command_setting`, above).

**No probe is eligible for the managed settings fetch.** At boot Claude Code fetches
server-managed settings for an eligible account (`${un().BASE_API_URL}/api/claude_code/settings`,
signed with the stored login), and a `-p` boot waits for it
(`QJt("headless_managed_settings_wait",()=>F3())`). A policy fetched there applies to that boot
with no cache file present, and its hooks run despite the probe's `disableAllHooks` (2.1.332:
"Hooks configured in managed settings (they run even under a non-managed disableAllHooks)"). The
closed base URL alone does not make an account ineligible. The eligibility check is
`e=be()!=="firstParty"?"third_party_provider":!ha()?"custom_base_url":void 0;if(e)return
C(!1)??{eligible:!1,ineligibleReason:e}`, where `ha(){if(K9())return!0;return cd()}` treats any
base URL as first-party while `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` or the client-data
document named by `CLAUDE_CODE_CLIENT_DATA_URL` says so, and `C()` answers from a stored hybrid
sign-in, and `be()` answers `"gateway"` for a stored gateway sign-in, which `I1o` restores from the
credential store unless `T4e()`. So each probe gets `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1` and
never the two first-party switches (`PROBE_HOST_MANAGED_MARKER`, `PROBE_FIRST_PARTY_SWITCHES`):
`T4e(){return Pc()||xd()||TH()}` with `Pc(){return s.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST||uH()}`
skips the gateway restore, the hybrid lookup (`getHybridSettingsOrganization`) answers null under
the same marker, and eligibility ends at `custom_base_url`. That needs no read of the credential
store, which claudish never touches. Measured on 2.1.332 against this Mac's own login: the same 11
plugins and the same `success` result with zero turns, about 235 ms, with and without the marker.
The marker also goes into the closed `env` block, so a settings `env` cannot clear it. The child
pane makes the fetch at its own start, as the caller did; a policy it applies there is the
child's own, and a cached one stops the probe (above). The boot canary pins the precedence on every pinned version: its user
`settings.json` `env` names its listener with a placeholder key, and the production-argv probe must
send that listener no request.

**The probe takes no handed-over credential.** The host-managed marker opens a launcher path of
its own. At init, before the managed settings load, 2.1.332 runs `REr()`:
`if(!s.CLAUDE_CODE_HOST_CREDS_FILE||!He(s.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST))return;let
e=await h();`, and `h()` reads the file `CLAUDE_CODE_HOST_CREDS_FILE` names (a regular file or a
pipe, mode 0600, owned by the user, naming a live launcher pid and no past expiry) and writes its
`env` into `process.env`: the bearer `ANTHROPIC_AUTH_TOKEN` the probe left out comes back. Its
neighbours read more: `Cpn(){return s.CLAUDE_CODE_HOST_AUTH_ENV_VAR||"ANTHROPIC_AUTH_TOKEN"}`
names the bearer variable, so it can point at any variable the parent holds;
`n=s.CLAUDE_CODE_HOST_AUTH_ASK_AT_START?a??"":a||void 0` lets the file's endpoints win over blank
launch values; `CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH` wires a host token refresh, timed by
`CLAUDE_CODE_HOST_AUTH_REFRESH_TIMEOUT_MS`; `mo()` takes
`token:s.CLAUDE_CODE_LAUNCHER_RUNS_API_KEY_HELPER&&!s.CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH&&s.ANTHROPIC_AUTH_TOKEN`.
The same boot reads a credential from a descriptor or a file when one is named:
`if(s.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR||s.CLAUDE_BG_AUTH_SNAPSHOT_PATH&&...)BP();if(s.CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR)sXt();if(s.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR)W4();if(s.CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR)Vu()`,
and `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`, `CLAUDE_CODE_SESSION_ACCESS_TOKEN` and
`CLAUDE_SESSION_INGRESS_TOKEN_FILE` hand over a sign-in or a session token. None of the fourteen
is on the spawn allowlist, and all are closed to `""` in the settings `env` block
(`PROBE_HOST_HANDOFF_VARS`). Measured on 2.1.332 by the canary (below), whose server environment
names a creds file: with the fourteen passed through, the production probe, the full run and the
marked `/cost` boot each opened it (`handoff=read:probe,full,probecost`); left out, none did
(`handoff=unread`), while a control boot with the variable handed back still did
(`handoffControl=read`). The creds file is a pipe whose writer creates a marker file only once its
write has returned, and the check waits (up to 5 s) for the writer to exit 0 after that marker,
so `read` means a reader took the handoff and the writer finished; a writer that ends without that
write (a redirection error, a broken pipe), or ends other than with 0 after its marker, reads
`writer_failed` and fails the expectation.
`ANTHROPIC_UNIX_SOCKET` is not on the allowlist either, and is not set in the settings `env`
block, because `""` would change the bundle's `s.ANTHROPIC_UNIX_SOCKET!==void 0` checks; a known
limit: a settings layer that sets it is not closed. The canary's server environment names a
recording unix listener there, and no production boot may connect to it (`unixSocket=unused`; a
stand-in that connects fails it; 2.1.332 itself made no connection even with the variable passed
through, since these boots make no Anthropic API request).

**The probe reads no stored login.** The env credentials never reach it (`ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, and the handoffs above), and the host-managed marker keeps the
credential store off limits (`if(T4e()){r.storeOffLimits=!0;return}`), so Claude Code does not read
the Claude subscription login it stores (the Keychain item on macOS, `.credentials.json`
elsewhere) either; claudish never reads it. Measured on 2.1.332 by the canary: the same world's
`/cost` boot answers with the subscription line without the marker, and not under the
production environment (`login: subscription`, `probeLogin: none`). A probe needs no credential:
`/effort` answers locally. Without the marker, every probe boot on a logged-in machine started the
claude.ai connector fetch to `api.anthropic.com`, signed with that login; with the store off limits
it has no login to sign with (not measured with a socket trace). The plugins a login can bring
(an organisation policy, a hybrid sign-in's plugin locks) arrive through a server-managed or
hybrid cache file, and any such file but an empty `{}` cache already refuses the probe.

**Command-valued settings in work_dir.** Claude Code 2.1.332 lists the settings whose value is a
command (`Nrd=["apiKeyHelper","awsAuthRefresh","awsCredentialExport","fileSuggestion",
"gcpAuthRefresh","otelHeadersHelper","processWrapper","policyHelpers","proxyAuthHelper",
"statusLine","subagentStatusLine"]`). The pane child in an untrusted work_dir stops at the trust
dialog (boot dialogs are never accepted), but `-p` skips it. Measured on 2.1.332, isolated config,
untrusted cwd whose `settings.json` sets every one of them (and `policyHelpers.macos`, a project
`SessionStart` hook, and the telemetry and proxy switches some wait for) to a script writing a
marker, `settings.local.json` setting `apiKeyHelper`:

| Boot | Markers |
|---|---|
| production argv (closed `env`; measured with `-p /cost`, and with `-p /effort` by the canary), with and without a user `env` key, with and without the switches | none, in every run |
| the same argv with a key in the flag `env` and the environment, against a listener (the canary's second boot) | the local `apiKeyHelper`, once in two canary runs; none in a third run |
| negative control: `-p "say hi"`, production argv otherwise | the local `apiKeyHelper` (it is read from the highest source only) |

So a probe boot can run `apiKeyHelper` once a key is present. Rather than rely on the production
probe never having one, `inheritedPluginsFor` starts no probe while a project or local settings file
of work_dir (or of the child's `--project-config-root`) sets any key on that list, or cannot be
parsed (`work_dir_command_setting`). The caller's launch directory is trusted (the caller runs
there), so its interface-only keys are harmless to a `-p` boot, but a startup helper there runs at
the caller probe's boot: no probe starts while its project or local settings, or those of the
caller's `--project-config-root`, set a `USER_STARTUP_HELPERS` key or cannot be parsed
(`caller_command_setting`). Overriding each key in
the probe's `--settings` was not chosen: a harmless `apiKeyHelper` there would count as a login.
The canary pins that the production-argv probe runs none of them (its project settings hold all of
them, writing markers); the canary's second boot runs with the cwd's settings removed.

**Reading to the exit.** The probe reads stdout until the process exits, and the init `plugins`
count only for init first, then exactly one `result` event with `subtype: "success"`,
`is_error: false` (both exactly) and `num_turns: 0`, then exit 0. A `result` before init, a
second `result`, or any other `result` anywhere fails at once as `bad_result` (before, a later
successful result overwrote an earlier error, so a wrapper printing an error result, then a
zero-turn one, then exiting 0 supplied plugins; and a result that merely lacked `is_error: true`
passed: `{"type":"result","subtype":"error_during_execution","num_turns":0}` and exit 0 answered
`{"ok":true,"plugins":[]}`). The `/effort` answer is a synthetic assistant event
(`"model":"<synthetic>"`) printed after init; any other assistant event after init fails at once as
`turns`, and the probe is killed. Measured on 2.1.332: `system/init`, `assistant` (synthetic),
`result/success` with `is_error: false`, `num_turns: 0` and the usage line as `result`, exit 0, in
0.24 to 0.38 s on the owner's Mac with its real config.

**Shutdown.** `createSession` refuses at entry once `shutdownAll` has begun, and again after each
await (the magmux check and the probes), so a start that arrives during teardown (a transport close
while a tool call was still preparing its credentials) starts no probe and no pane. `shutdownAll`
sets that flag before anything else and never clears it, and the abort controller is never replaced:
before, `shutdownAll` replaced it before waiting on a snapshot of `pendingStarts`, so a start entering
then took the fresh signal and ran its probes after the server exited. A start already past entry is
in `pendingStarts` from before the magmux check, and `shutdownAll` aborts its signal first: each
running probe's process group is killed (`aborted`), both settings files are removed once both probes
settle, and the start throws ("MCP server is shutting down") instead of starting a pane;
`shutdownAll` returns after that.

**Measured on Claude Code 2.1.332**, fake data only: an isolated `CLAUDE_CONFIG_DIR` and `HOME`
holding a `directory` marketplace `fakemkt` whose entries have `github` sources (so the cache copies
are used), `alpha` 1.0.0 and 2.0.0, `beta` 1.0.0, `gamma` 1.0.0 under a folder with a space. Rows:
alpha project 2.0.0 keyed to `repoA` listed before alpha user 1.0.0, beta project keyed to `repoA`,
gamma user. User settings enable alpha and gamma, `repoA`'s `settings.json` enables beta; `repoA`
is neither a repository nor trusted.

| Variant (cwd `repoA`) | init event | `/v1/messages` requests | exit |
|---|---|---|---|
| `--agent __probe__ -p hi` | no: exits at argv validation (`--agent '__probe__' not found. Available agents: …`) | 0 | 1 |
| `-p --input-format stream-json`, empty stdin | no | 0 | 0 |
| SDK `initialize` control request | no; the reply has agent names, no `plugins` | 0 | 0 |
| SDK `reload_plugins` | no; re-resolves sources and dropped every `fakemkt` plugin | 0 | 0 |
| `-p hi`, `--max-turns 0`, an unknown `--model`, with a key | yes | 6 (a turn and its retries) | 1 |
| `-p /cost`, with a key | yes, `num_turns: 0` | 0 (one `HEAD /api/hello`) | 0 |
| `-p /effort`, with a key (the canary's second boot, its own world) | yes, `num_turns: 0` | 0 (no request at all) | 0 |

Each `plugins` entry is `{name, path, source, version}`: `path` is the exact copy loaded,
`source` is `<name>@<marketplace>`; Claude Code's own plugins have `path: "builtin"` and no version.
What the list reflects:

| Scenario | `fakemkt` part of `plugins` |
|---|---|
| cwd `repoA` (project row first) | alpha 2.0.0, gamma, beta |
| cwd outside | alpha 1.0.0, gamma: only the user rows apply |
| rows reversed, cwd `repoA` | alpha 1.0.0, gamma, beta: the first applicable row in file order wins |
| `repoA` `settings.local.json` `alpha@fakemkt: false` | gamma, beta |
| managed `strictKnownMarketplaces: []`, `allowedMarketplaces: []`, or `blockedMarketplaces` naming the marketplace | none |
| beta removed from `marketplace.json`, cache and row kept | alpha, gamma |

A real managed-file `enabledPlugins: false` was not measured (`--managed-settings` keeps only policy
keys, and `CLAUDE_CODE_MANAGED_SETTINGS_PATH` is a no-op in this build); the list is the copies
Claude Code loaded, so it reflects that case by construction. Side effects of the quiet probe: no
hook ran, no MCP server started, no transcript, nothing changed under the cwd or the plugin caches;
Claude Code still rewrites its `.claude.json` (startup counters). A managed `allowManagedHooksOnly`
or managed `hooks` outrank `--settings`, so no probe starts beside any managed source. Time: 0.95 to
1.0 s per quiet probe (0.25 s with outbound traffic denied, 2.8 s for a boot that starts MCP
servers; these times were taken with `/cost` on a world with no subscription login); both probes
run at once, about 0.4 s on that test data. `claude plugin list --json` is no substitute: it prints every row of every project, `enabled` per id rather than per
row, applies no marketplace policy, and tries to clone every plugin's remote source (2.5 s).

**Fail closed.** Each of these hands over NO plugin, with its cause as `pluginProbe`:

| Cause | When |
|---|---|
| `exited_before_init` | the probe, or a `CLAUDE_PATH` wrapper, exits before an init event |
| `timeout` | the deadline passes (below), during the binary lookup included |
| `assistant_before_init` | an `assistant` event before init |
| `plugins_malformed` | an init whose `plugins` is missing or not a list of `{name, path, source}` |
| `output_too_large` | more than 32 MiB of stdout |
| `no_result` | exit 0 after init with no `result` event |
| `bad_result` | a `result` before init, a second `result`, or a `result` that is not exactly `subtype: "success"` with `is_error: false` |
| `nonzero_exit` | a non-zero exit, or one on a signal, after init |
| `turns` | a non-synthetic `assistant` event after init, or a `result` whose `num_turns` is not 0 |
| `aborted` | a shutdown |
| `no_claude_binary`, `spawn_failed` | no `claude` found, or a spawn failure |

One log line names the cause, never a path or an environment value. Nothing is guessed: a half
answer would hand over a copy the caller does not load.

**The deadline is end to end**: 10 s (`PLUGIN_PROBE_TIMEOUT_MS`, ten times the measured boot on a
loaded machine) from the call, the binary lookup included. A probe still running at the deadline
less the reap time (2 s, or a quarter of the deadline when shorter) is killed, and the result
returns once its process group is gone, or at the deadline, whichever is first. Both probes run at
once, so the probes add at most 10 s to `create_session`. The binary lookup is stopped at the
kill time (or on a shutdown) and waited for, so its shell does not outlive it, but never past
the deadline: a shell `SIGKILL` cannot reap at once (uninterruptible sleep on a hung mount)
would otherwise hold `create_session`, and `shutdownAll` awaits the start. At the deadline the
probe answers `timeout` (`aborted` on a shutdown) and logs that the lookup outlived it. On
settling, the probe also lets go of its stdout, so a descendant outside the group that still
holds it keeps nothing waiting.

**The process group goes on every way out.** The probe runs detached, as its own process group.
On a failure the group is killed at once; on the probe's exit the group is killed too, since a
`CLAUDE_PATH` wrapper that starts Claude Code and exits leaves Claude Code in the group holding
stdout. The result waits for the exit, the end of stdout and `kill(-pgid, 0)` answering `ESRCH`,
checked every 20 ms; no timer is cleared before then, only the deadline settles earlier. Before,
an early exit with no output cleared the deadline and left the wrapper's child running.

**The comparison**, by `source` (`pluginsToHandOver`): for each caller entry with an absolute path
whose `source` is not `<name>@inline`, the caller's copy is handed over when the work_dir probe
lists that `source` at another path or not at all; the same path is never handed over. An `@inline`
entry came from a launch flag (`--plugin-dir`/`--plugin-url`), not from an install row, and is never
handed over. A caller copy of a plugin the child loads from its OWN launch flag (a child entry
`<name>@inline` of the same `name`) is not handed over either, with a log line: the child's flags
chose that copy, and two `--plugin-dir` copies of one name at different paths both load. Only an
`@inline` child entry counts: a child `alpha@m` at another version is exactly the case the
handover exists for (a `--plugin-dir` copy overrides an installed one of the same name).
Order: the caller's init order. argv: the inherited `--mcp-config`, then one `--plugin-dir <path>`
pair per copy (one token per path, spaces included), then the caller's flags. `spawn.json` records
`inheritedPlugins: [{id, version}]` (never a path) and `pluginProbe`: `ok`, the fail-closed cause,
or why no probe started, so a user can see why nothing was handed over.

**A plugin the child's settings turn off is not handed over.** A copy whose id the inherited layer's
`enabledPlugins` (setup_from's project and local settings, then every caller `--settings`) sets to
anything but `true` is dropped from the list, with a log line naming the id. Without that, a request
with `claude_flags: ["--settings", "{\"enabledPlugins\":{\"alpha@m\":false}}"]` and a user-enabled
`alpha@m` handed `alpha` over: the child probe did not list it, the caller probe (which never gets the
layer) did, and the `--plugin-dir` copy loads as `alpha@inline`, which that `false` does not match.

**A relative `--plugin-dir`.** With the caller launched with `--plugin-dir ./extras` and an
`extras/` under its cwd holding an inline `alpha`, the caller loads that inline copy, which shadows its
`alpha@m`. The caller probe resolves `./extras` against the host's cwd and reports `alpha@inline`,
which is never handed over; resolved anywhere else it reported `alpha@m`, and its marketplace copy
was handed over: a copy the caller never loaded. A child `--plugin-dir` is resolved against work_dir
in the child probe, as the child resolves it.

**The naming guard.** A `--plugin-dir` copy takes its name from its manifest, else from its folder:

```js
function Vdt(e,n){let r=Qy(e).replace(/\.zip$/i,"");return n===Ws?gHe(r):r}
// the inline loader: ot=Vdt(ze,n); ... Mge(ze,`${ot}@${n}`,!0,ot,...)   (manifest-less: {name:n})
```

so a cache folder `…/alpha/2.0.0` with no manifest would load as `2.0.0@inline` beside the child's
own `alpha`. A copy is handed over only when `<path>/.claude-plugin/plugin.json` is a regular file
whose `name` is the entry's `name`; otherwise it is skipped and its id logged.

**Why only the caller's loaded set.** A `--plugin-dir` copy is keyed `<name>@inline`, it beats an
installed plugin of the same name (`Plugin "${lt.name}" from --plugin-dir overrides installed
version`), and its enabled state defaults to on whatever `enabledPlugins` says of
`<name>@<marketplace>`:

```js
function neo(e,n,r,a){let l=QWe(e,n);if(l!==void 0&&!l.enabled&&n[l.index]?.managed)return!1;return jS(e,a)||(l?.enabled??(r!==!1||Uo(e)&&wi()))}
```

A managed `enabledPlugins: {"x@m": false}` or `strictKnownMarketplaces: []` does not stop a
`--plugin-dir` copy either. The caller probe applies all of those, so a plugin they turn off is
absent from its list and is never handed over; a `false` in the inherited layer is honoured by the
filter above. A `false` in work_dir's OWN settings for an id the caller turns on only in user
settings still does not keep the handed-over copy off. Also measured: a handed-over copy loads agents,
skills, commands, hooks and its bundled MCP server (unless the caller passes `--strict-mcp-config`),
and the agent namespace is unchanged (`alpha:alpha-v2`), so `--agent <plugin>:<agent>` resolves to
it; two copies of one name at different paths both load; the same path twice loads once.

**The canary.** `scripts/boot-canary.ts` runs the `pluginprobe` scenario on each pinned Claude Code
(`scripts/boot-canary.plugin-probe.ts`). The isolated config has one installed plugin whose copy
carries a `SessionStart` hook and an MCP server, a user `settings.json` whose `env` names a
loopback listener with a placeholder key and which sets a `proxyAuthHelper`, an
`otelHeadersHelper`, a `processWrapper`, a `statusLine`, a `subagentStatusLine` and a
`fileSuggestion` writing markers, a `{}` `remote-settings.json` as an ordinary login leaves
it, a placeholder Claude subscription login in `.credentials.json` (`claudeAiOauth`; with
`CLAUDE_CONFIG_DIR` set, Claude Code's Keychain item name carries a hash of that dir, so the Mac's
own login is never found and the file is read instead), and an untrusted cwd whose project and local settings set every command-valued setting to a
marker script. The server environment carries `CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER=1`,
`HTTPS_PROXY`, `CLAUDE_CODE_ENABLE_TELEMETRY=1` and an OTLP/HTTP exporter to a closed port, so a
probe that kept either switch runs a user helper. claudish's probe gate must admit that config
dir (`policyGate: open`). `spawnPluginProbe` with claudish's own argv, settings file and
environment must answer `ok` with that copy while the listener sees no request
(`productionRequests: 0`) and no helper marker appears. Then the same argv runs to its exit with the
listener and the key in its own settings `env` (the production block would override them), so a
turn would reach it, and the cwd's settings removed: it must exit 0 within 30 s, end on a `result`
event with `subtype: "success"`, `is_error: false` and `num_turns: 0`, make no `/v1/messages`
request, print no assistant event but the synthetic one, run no hook, start no MCP server and
write no transcript. A stand-in that prints init and then hangs, prints a fatal result or a
result with a turn, sends a request to the user `env` base URL, runs the project `apiKeyHelper`,
or runs a user startup helper while its switch is in the environment fails it, and so does an
error result before a good one, two results, a result before init, or an `error_during_execution`
result with `num_turns: 0` and no `is_error` (`bad_result`). Production applies the same exit and
result rule; the second boot adds the open endpoint that shows a model request. When the second
boot's process exits, the canary kills its process group and reads stdout to its close, so a
wrapper's child still holding stdout goes too; a descendant in a group of its own is out of reach
of that kill, so 2 s after the run's 30 s deadline the run settles anyway as `exit: stdout-held`
(red). The canary also reads the binary for the policy source names and the provider switches
(above): `policySources` and `providerSwitches` must both read `known`. The second boot's result
text must be `/effort`'s usage line (`answer: effort-usage`; a stand-in answering other text fails
it). A third boot, the production argv with `-p /cost` in place of the probe prompt and the
host-managed marker removed from the environment and the settings `env` block, must answer with
the subscription line (`login: subscription`; a stand-in that never reads the login file fails
it): that proves the world holds a login Claude Code can read, the one a subscription user's
machine has. A fourth, the same `/cost` boot under the production environment, marker included,
must not (`probeLogin: none`; a stand-in that reads the login under the marker fails it): the probe
reads no stored login. That reading counts only when the fourth boot ended with init, one
successful result and exit 0; otherwise it reads `probeLogin: unreadable` (a stand-in that exits
with no output on that boot fails it), since a crashed boot prints no subscription line either.
The server environment names a host creds file, a named pipe holding a placeholder bearer and
re-armed before each boot, so a boot that opens it is seen: no boot built from the production
environment may open it and no listener request may carry its token (`handoff: unread`), and a
control boot of the production argv with the variable handed back in the environment and the
settings `env` block must open it (`handoffControl: read`; a stand-in that never reads it fails
it). The third boot does not reproduce the 8 s: the world holds no
transcripts, and the
plan-usage fetch fails at once at the closed `HTTPS_PROXY` port, where every outbound attempt of
the world goes (a recording proxy in its place saw one `CONNECT api.anthropic.com:443` per boot,
for `/effort` and `/cost` alike, and nothing else). A user `statusLine`, `subagentStatusLine`,
`fileSuggestion` or `processWrapper` that runs at any of these boots turns `sideEffects` red (a
stand-in that runs the user `statusLine` fails it).

A fourth world is the same with a user `apiKeyHelper` (writing its own marker) in place of the two
switch-gated user helpers, and no startup helper switch in the server environment. In it,
`inheritedPluginsFor` runs as `createSession` would, for a child in the world's cwd with the caller
in another folder (its host launch read as a plain `claude` there; the machine's own managed paths
are never read): it must start no probe and answer `userHelperGate: user_command_setting`. Then a
direct `spawnPluginProbe` of the production argv and environment boots in that world, and
`userApiKeyHelper` reports whether the helper ran and the probe's outcome; that reading is printed,
not compared. The binary is also read for its command-valued settings list (`Nrd`: the one array
literal of quoted names holding `"apiKeyHelper"`, `"statusLine"` and `"proxyAuthHelper"`), which
must equal `COMMAND_SETTINGS` (`commandSettings: known`; a name added or gone reads `unknown:+…,-…`,
no such list or two of them `unreadable`). So a setting Claude Code adds to that list turns the
canary red until it is sorted into `USER_STARTUP_HELPERS` or left out with a reason. What no string
check can see is a new boot path for a setting already on the list, or a new environment switch
that starts one (2.1.332 has 26 `CLAUDE_CODE_ENABLE_*` names, most unrelated). The user gate makes
that matter less: a helper in `USER_STARTUP_HELPERS` refuses the probe whatever starts it, and the
marker boots catch any of the other four that starts to run.

Real run on 2.1.332, three times on the final code: `boot=init probe=ok plugins=installed
productionRequests=0 modelRequests=0 realTurns=0 sideEffects=none exit=0 result=turns:0
policySources=known providerSwitches=known policyGate=open answer=effort-usage login=subscription
probeLogin=none handoff=unread handoffControl=read unixSocket=unused commandSettings=known userHelperGate=user_command_setting userApiKeyHelper="not-run probe=ok"`.
The same world with the two switches still passed to the probe read
`sideEffects=helper:localApiKeyHelper,helper:otelHeadersHelper,helper:proxyAuthHelper,helper:user-otelHeadersHelper,helper:user-proxyAuthHelper`.
`/effort`'s no-argument answer, the init `plugins` shape and the quiet flags are CLI surface, not a
contract.

**Known limits, not closed.**

- A stale server-managed cache can withhold the inherited `--mcp-config`. `inherited-mcp.json`
  treats a readable `remote-settings.json` holding `disableSideloadFlags: true` as in effect,
  also on a machine with no stored login, where Claude Code applies no cache. Claude Code checks a cached copy before it applies it:
  a signed cache keeps its signature beside it (`remote-settings.json.signature.json`, built by
  `function jWe(e){return`${e}.signature.json`}`), and the stored-copy trust check
  (`storedCopyTrust`, the account's organisation pin, the helper consent) can refuse the copy.
  claudish does not repeat that check. So when Claude Code would refuse the cached copy and accept
  the flag, a child that needed the inherited project servers (a linked worktree outside
  setup_from's tree, a child in another repository) starts without them. The trade-off is chosen on
  purpose: the opposite mistake, a `--mcp-config` beside a policy that IS in effect, makes Claude
  Code exit at startup (`sideload_flags_disabled`), so the child would not start at all. Losing the
  servers is the smaller failure, and it is logged with the cache's path.
  `inherited-settings.test.ts` pins it: a cached `disableSideloadFlags: true` beside a signature
  that does not verify still withholds a linked worktree's `--mcp-config`, and the same child gets
  the project server once the cache is gone.
- A `CLAUDE_PATH` wrapper that starts Claude Code in a process group of its own (`setsid`, a
  daemonising launcher) and then exits leaves that process running: the probe kills only its own
  group, and nothing in claudish tracks a descendant outside it. The probe still settles by its
  deadline, lets go of stdout, and hands over nothing unless that process printed a full valid run
  first. The orphan holds no claudish resource, but it lives until it exits by itself, and it was
  started with the probe's environment (no credential, the closed base URL). The canary's own
  stand-in for this case is killed by the test that started it; production has no such cleanup.
  This needs a wrapper written to escape its parent's group, so it is left open.
- The caller's user settings are found from the SERVER's `HOME` when the caller has no
  `CLAUDE_CONFIG_DIR`: `readHostLaunch` does not read the caller's `HOME`. A caller launched
  with another `HOME` than the server's has its mode gate (`callerEffectiveEnv`) and its user
  settings gate (`userSettingsRefusal`) read the server's user settings instead. Both make the
  same assumption, so they agree with each other.
- The probe models a fresh boot of the caller, not the running caller. A plugin installed,
  updated or removed after the caller started is handed over as it is on disk now: the child gets
  the new version, or a copy the caller never loaded.
- An argument that is not valid UTF-8 (a path in another encoding) is decoded with replacement
  characters, on Linux `/proc/<pid>/cmdline` and on macOS alike: the caller probe then names a
  different path, so a `--settings` file reads as `caller_settings_unreadable` and a
  `--plugin-dir` names a folder that does not exist. Only `CLAUDE_CONFIG_DIR` is checked for exact
  UTF-8.

Open questions, not measured: whether state keyed by plugin id (the plugin's data folder,
`pluginConfigs` and user config for `<name>@<marketplace>`, `/plugin` actions, auto-update) follows
an `@inline` copy. Not handed over: plugins the caller loaded with its own `--plugin-dir` (the
caller probe lists them as `@inline`). Claude Code's worktree check (`Ut`: the backlink file and the
`<common>/worktrees/<name>` layout) is not replicated by the probe gate; a broken worktree can look
like the same repository to claudish, which then starts no probe where Claude Code would apply
other rows: the plugin goes missing, never an extra one.

Known gaps, not carried: project `.claude/skills` and `.claude/commands`; project hooks with
relative paths, which resolve against `work_dir`. `team` needs none of this: its slots run in
the server's cwd.

An inherited layer also turns on the caller's plugin hooks in the child, and those hooks keep
per-cwd state: in the live run they wrote `.claude/.coaching/state.json` and `.mnemex/` into the
sandbox. A `work_dir` that must stay pristine needs `setup_from: null`.

To re-measure the table, ask Claude Code for an agent that does not exist:
`(cd <dir> && env -u CLAUDECODE claude <flags> --agent __probe__ -p hi </dev/null)` prints
`--agent '__probe__' not found. Available agents: …` and exits before any model request, so a
matrix of cwds and flag sets costs nothing. `env -u CLAUDECODE` lets it run from inside a
session.

## MCP Tools (20 total)

- **Low-level** (3): `run_prompt`, `list_models`, `search_models`
- **Agentic** (4): `preflight`, `team`, `report_error`, `allowance_status`
- **Session** (12): `create_session`, `send_input`, `get_output`, `cancel_session`,
  `list_sessions`, `get_diagnostics`, `capture_session`, `resize_session`, `scroll_session`,
  `transcript_session`, `replay_session`, `close_replay`
- **Debug** (1): `compare_models`

`preflight` exists because `--probe` is CLI-ONLY. An MCP consumer had no way to
check its models before committing to them, so it either shelled out to the CLI or
discovered provisioning failures minutes in with the slots already spent — a real
`team` run lost 3 of 10 slots that way. It reports, per model, WHICH provider
would serve it (via `route()`, the same rules and credential filter a real run
uses), whether that hop is flat-rate or METERED, and whether it is reachable now.
The billing column is the non-obvious half: subscription-vs-metered is a property
of the PROVIDER, not the model, so the same bare name can be free through a plan
or billed per token depending on which credential is present — which is precisely
what a caller cannot see from the model id.

**`preflight` judges a model by its ROUTING CHAIN** (`providers/preflight-chain.ts`). It used to
plan with `route()` and probe only the primary, so a model whose first hop failed got "❌" and
"Drop or replace before running" even when a later hop served it (six models behind one expired Zen
Go key on 2026-10-21; `model-failures-2026-10-21.md`, D6). Now `preflightModel` takes the kept hops
from `explainRoute` → `probeTargets` (the chain `--probe` shows, in order) and probes each until one
is live. A failed hop is followed by `ProbeResult.chainAction`, which `probeLink` sets with
`decideHopFailure`, the SAME function `FallbackHandler` uses (`adapters.md`): advance, or stop here
because a real request would stop here too (a connection fault, a stream failure, a transient
credential verdict). Two walker defaults stop rather than guess: a non-live result with no
`chainAction` (`no-decision`, e.g. `key-missing`), and a probe that throws (`probe-error`). A native
Claude name is never probed (the third outcome). Metered hops are probed like any other: a configured
key is consent, and the runtime would use that hop.

Output contract: the table's Provider, Billing and Model spec describe the SERVING hop; Status is
`✅ live · hop i/n`, `❌ <state> · chain stops at hop i/n` or `❌ every hop failed (n)`, with
` (+k untried)`; every failed hop is listed under "Failed hops:" with its probe spec, billing word
and where the chain went; "Drop or replace before running" lists only models no hop serves. The
billing counts follow the serving hop.

Cost: at most one probe per kept hop, stopping at the first live one, so a model whose first hop
serves costs what it always did. `timeout_ms` applies PER HOP; the worst case per model is hops ×
`timeout_ms`, carried by `heartbeat: true` and a progress message per hop
(`preflight: <model> · hop i/n`). Preflight models a FRESH chain: `FallbackHandler` starts at its
`lastSuccessIndex` in a long-lived proxy, preflight always at hop 1, which is what a new session sees.

**The polling verbs are the frozen mod contract v1** (`pane/contract.ts`, summarised in
`pane-session.md`): `list_sessions` answers `{contract_version, capabilities, sessions}` with one
`SessionRow` per session (state, reason, `reason_detail`, tokens, `cost_usd`, tool calls, turns, `idle_seconds`,
`activity`, `pane`); `cancel_session` answers `{session_id, state, changed}`; `capture_session`
answers the session's current screen `{seq, cols, rows, cursor, lines, final, spans?}` (160×50 at
launch), or `{unchanged:true, seq, final}` when `since_seq` is still current — a memory read, meant
for polling at about 1 Hz. `resize_session` answers `{session_id, cols, rows, changed, seq,
pending?}`: the size actually set after clamping to 40–9999 × 24–9999 and at most 4 000 000 cells, and the screen `seq` once the
redraw at that size has landed, so a capture with that `since_seq` already sees it. Their errors
are a JSON `ContractError`; `resize` is the only verb that emits the two codes it added,
`resize_unsupported` (the magmux has no `resize` op) and `delivery_unavailable` (magmux refused, or
the pane is unreachable). `capabilities` lists `resize` since the pin moved to magmux 0.15.1. The
resize floor was 0.15.1, not 0.15.0 (the first release with the op; the pane floor is now 0.18.0, for
deep socket paths, above the 0.17.0 the input gate's transcript binding needs): 0.15.0 kept the scroll region's old
bottom after a row grow and clamped cursor-down to it, so Claude Code's relative-move redraw
collapsed its input box onto the old last row and `pathPrimary` never settled the next turn. The
fake child redraws with relative cursor-down for that reason. The per-pane check of magmux's `verbs` stays as the defence against a
binary that passes the version floor but lacks the op. `team` gains the same verbs as modes (`list`, `status`, `capture`,
`cancel`, `resize`, `scroll`, `transcript`). Why the size is the viewer's and what resizing costs the screen heuristics:
`pane-session.md`, "Terminal size".

`scroll_session` (`session_id` and exactly one of `by`, a nonzero signed row count with negative
toward older content, or `to:"end"`) scrolls the child's own transcript view and answers
`{session_id, seq}`; `team(mode:"scroll", path, slot, run_id?, by | to)` answers
`{run_id, path, slot, seq}`. A capture has no rows above the visible screen (the child draws on
the alternate screen), so the scroll goes to the child as SGR wheel events, `|by|` capped at 200
and a target ± 1 row. Its one error code is `scroll_unavailable` (starting, finished, delivering a
prompt, an earlier prompt's copy that may still be unread, a screen-read turn, reconnecting, or
magmux did not confirm); nothing is queued.
`capabilities` lists `scroll`. The argument errors come before the run lookup, as for `resize`. It
is not a nested tool. Mechanism, rows and states: `pane-session.md`, "Scrolling the child's view".

`transcript_session` (`session_id`, `since?`) reads the session's conversation as plain text lines
and answers `{session_id, cursor, lines, more, final}`; `team(mode:"transcript", path, slot,
run_id?, since?)` answers `{run_id, path, slot, cursor, lines, more, final}` (MTL-373). It exists
because a finished session cannot scroll, and the status mod's Text view needs the whole
conversation from the first turn, after the session finished too. Screen stitching and
`get_output` were rejected as sources (one guesses and loses lines between captures, the other
holds answers only).

- **Source.** The child's own transcript JSONL, the file that is already the turn oracle
  (`pane/transcript-page.ts` reads it, `pane/transcript-lines.ts` renders it). Compaction is
  append-only (42 of 400 transcripts compacted; earlier lines stay), so it is complete from the
  first turn. Subagent files are not read: an `Agent` call is one `tool` line.
- **Lines.** `{kind, text, cont?}`, `kind` a closed set appended to only: `user`, `assistant`,
  `tool` (`Name(arg)`, the argument ≤ 160 characters), `task_file` (the Read result of a claudish
  task file, which survives the reap that deletes the file), `system`, `error`. Text is
  sanitised: escape sequences and control characters removed except `\n` and `\t`, a lone surrogate
  made U+FFFD. A text over 8,000 UTF-16 units or 16,000 serialised bytes is SPLIT, never
  truncated, into `cont` lines; a chain may continue in the next answer after `cursor`. `renderEntry` is pure, so two servers mint the
  same lines from one entry.
- **Redaction** (`pane/transcript-redaction.ts`), one pipeline for every text, a tool argument
  included: (1) t0 is the sanitised WHOLE text — for a tool line the whole salient argument,
  before whitespace is collapsed and before the 160 cut, because a cut first destroys the
  complete string that exact-value redaction needs and leaves a credential's head in the line;
  (2) signing-value ranges are found on t0 (`signingValueRanges`), because a pattern
  replacement that ran first breaks a registered value that contains a shape (`opaque-sk-…/
  suffix` left `/suffix` in the clear); (3) `redactPatternsMapped` applies exactly
  `redactPatterns` to t0 and says where each output unit came from, and every surviving unit of
  a signing range becomes `*`, one for one, except whitespace; (4) only then the cuts — the
  argument's collapse and 160 cut, and the 8,000 / 16,000 split. The cuts are computed on the
  pattern-redacted text before the signing mask, so the chunk count and every cut are functions
  of the text alone, never of the leases live at the call (the cursor indexes the k-th line).
  The mask is length-preserving and keeps whitespace in place, so the same cuts apply to the
  masked text and a masked line is never longer than its unmasked one in units or JSON bytes
  (`*` is one byte). A `[redacted]` replacement grew a line past the bound (9,768 characters,
  measured) and is not used here. A range that ends inside a surrogate pair masks both halves,
  and no lone surrogate is emitted.
- **Cursor.** `v1.<offset>.<k>.<id8>`: the byte offset of an entry's line start, the next line
  within that entry, the first 8 hex of the session uuid. Stateless (a restart, the disk fallback
  and another server all read the same file); it is the SCAN position and advances over records
  that render nothing. `v1` names the renderer revision as well: a change to how many lines an
  entry yields mints `v2`, which resumes a `v1` cursor at `k = 0`.
- **Caps per call.** 200 lines; 32,000 UTF-8 bytes of the COMPACT answer (15 % under the
  37,758 bytes Claude Code accepted; 61,681 became a "saved to file" stub with no cursor, which a
  poller would replay forever), and the first line always fits; 16 MiB of transcript scanned
  (≈ 34 ms on the 124 MB worst file); a line over 32 MiB is skipped. Only complete lines are
  read: a half-written entry is left for the next call.
- **`final`.** `true` only when the writer was PROVABLY gone before the read and the page reached
  the end. Live: terminal AND the pane's reap VERIFIED (`reapVerified()`: the group and magmux
  verified gone and the files removed, on the first attempt or a later registry retry). A
  cancelled turn still appends during the ≈ 12 s reap, and `reaped()` is not enough: it resolves
  after an unverified reap (`reapFailed`) too, while a survivor may still write. Disk `meta.json`: a raw terminal state, `completedAt` (else the file's
  mtime) 30 s old, AND the transcript 30 s quiet; the owner's pid is not consulted, because a
  finished session's owner reaps its pane within seconds, and "never final while the owner lives"
  would keep every finished tab of a long-lived server non-final for hours. `spawn.json` alone:
  `mcpPid` ESRCH-dead and the transcript 30 s quiet. A team slot from `status.json`: finished 30 s
  ago and the transcript 30 s quiet. A transcript still being written is evidence the writer is
  alive, whatever the records say (MTL-373 blind test TEST-19). A source
  whose liveness cannot be established answers `false`: a wrong `false` costs one more poll, a
  wrong `true` shows a running conversation as finished.
- **Lookup.** A reader, not a mutator: the live map, then the session directory (`meta.json`, or
  `spawn.json` alone); team: the run registry, then `<path>/status.json` read with `getStatus` so
  ENOENT (`unknown_run`) differs from a missing slot (`unknown_slot`). The team disk fallback
  derives the projects directory from the injected parent env, as `SessionManager` does. A path
  is read only when its basename is `<uuid>.jsonl`, its realpath lies under the (realpath of the)
  projects directory, and the DESCRIPTOR is the file there (`openContainedTranscript`): opened
  `O_NOFOLLOW | O_NONBLOCK`, `fstat` a regular file, then after the open the parent still
  realpaths to itself and `lstat` of the real path has the descriptor's `dev`/`ino` (on Linux the
  kernel's fd path must also equal it). A `stat` taken before the open followed the same swapped
  link as the open and proved nothing.
- **Residual risk (accepted; review round 2, CRITICAL 2).** On macOS an ancestor directory swapped
  for a symlink to an outside directory before the `openSync`, and restored before the parent
  `realpathSync`, still points the read outside the projects root: the descriptor and the `lstat`
  (taken between the two) both name the outside inode, and the parent check then sees the restored
  directory. Two swaps suffice. Accepted because the attacker must already write the user's own
  `~/.claude/projects` as the same uid, which already lets them read the outside file directly, and
  the answer goes only to that user's own Claude Code. A full fix needs descriptor-relative
  no-follow traversal (`openat` with `O_NOFOLLOW` per component, or `F_GETPATH`), which Bun does
  not expose on macOS; Linux closes the window with the kernel's fd path.
- **Read only.** `open(…, O_RDONLY|O_NOFOLLOW|O_NONBLOCK)`, `stat`, `read`, `readdir` and `kill(pid, 0)`; no snapshot refresh,
  no record written, nothing sent to the child. Not a nested tool; `capabilities` lists
  `transcript` after `scroll`. Measurements: `ai-docs/reports/2026-11-03-transcript-measurements.md`.

`replay_session` (`session_id`, `cols?`, `rows?`) opens a finished session's real interface, read only,
in a pane of its own, and answers `{replay_id, seq}`. `capture_session`, `resize_session` and
`scroll_session` route a `replay_id` to `ReplayManager` (`mcp-session/replay-manager.ts`) before any
session lookup; `close_replay` ends it. The pane itself, its environment and its argv are in
`pane-session.md` § Replay panes.

- **Source.** `SessionManager.replayTarget` and `replayTargetOfTeamSlot` are the transcript verbs' own
  lookups, so a session gone from memory but on disk still replays, the `kind:"team"` refusal stays,
  and `unknown_session`, `unknown_run` and `unknown_slot` keep their meaning.
- **States.** `writerGone` is `session_live`'s test, the rule `final` uses above. An open is classified
  and registered before its first await, so concurrent opens of one target, by either verb, share one
  process and one answer. A failed open leaves nothing. A replay that finishes by itself answers
  `final:true` until closed.
- **Errors.** `invalid_args`, `unknown_session`, or `replay_unavailable` with `reason`: `session_live`,
  `no_record`, `spawn_failed` (an exit before the box included), `boot_dialog`. `send_input` answers
  `replay_read_only` for anything shaped like a `replay_id`, open or not, before `text` is read; a
  missing `session_id` stays the error it was.
- **Not a session.** No entry in `sessions`, no directory and no record, so `list_sessions`, the
  accounting, the session limit and `team(mode:"list")` cannot see it, and `get_output`,
  `cancel_session`, `get_diagnostics` and `transcript_session` answer as for an unknown id.
- **Tool groups.** Not a nested tool, and `team(mode:"replay")` is unreachable nested because `team` is
  not registered there. Under `CLAUDISH_MCP_TOOLS=agentic`, where `team` is listed but
  `capture_session` and `close_replay` are not, that mode answers `invalid_args`: nothing there could
  read or close the pane. `capabilities` lists `replay` after `transcript`.

`allowance_status` is the read-only source of the mod's allowance band: `{contract_version,
capabilities, allowance, reason?}`, where `allowance` is the `claudish.allowance.v1` report that
`claudish account forecast --json` prints (the allowance service's `report()`), or `null` with a
`reason` when no Codex account is configured or the report fails. It is in `agentic`, not
`session`, because it reads no session; it is not in `NESTED_MCP_TOOL_NAMES`, so a nested server
never lists it. The answer is model-visible: no project path, session ids cut to 8 characters.
Contract and discovery lifecycle: `pane-session.md` § The `allowance` capability; the model:
`allowance.md`.

**Its answer is compact JSON.** Every other verb answers indented (`contractAnswer`); a full
allowance report measured 61,681 bytes indented and 37,758 compact (trajectory 26,641, sessions
9,672, accounts 798, burn 87, header 287). Indented it is over Claude Code's MCP result cap, and
Claude Code then replaces the answer with a "saved to file" stub: the band parses that stub,
finds no report, and stays hidden with no error anywhere. `compactAnswer` serves this tool only.
Compact is still 37 KB, so the tool takes `sections` (a non-empty subset of `accounts`, `combined`,
`burn`, `alerts`, `trajectory`, `sessions`, `usage`; anything else is `invalid_args`): `allowance`
then keeps its header and only those parts, and the answer carries the sorted `sections` beside
`contract_version`, which is how a reader tells a partial report from a full one.
`allowanceStatusAnswerSchema` requires every NAMED section when `sections` is present; when it is
absent, it requires the six sections of `ALLOWANCE_REPORT_SECTIONS_V1_BASE` only, because `usage`
was added later and an older claudish's full answer (and the goldens magus copies) must keep
validating. A full answer from this claudish always carries `usage`. The band polls
`["accounts","burn","alerts"]`: 1,547 bytes against 34,875 for the full answer, measured on a
two-account pool with 72 h of ledger. The cut happens after `report()`: the full report
(its trajectory simulation included) is computed on every call either way; a lighter report path is
not built.

The tool list is pinned by an EXACT frozen array in `mcp-session/e2e-sessions.test.ts`, so
adding or removing a tool without updating that test fails CI. That is deliberate:
it is a wire contract, and an accidental change to the tool surface should be loud.

Tool gating via the `CLAUDISH_MCP_TOOLS` env var (lower-cased, `resolveToolGroups` in
`mcp-server.ts`):

| Value | Tools |
|---|---|
| unset, `all` | all 20 |
| `low-level` | `run_prompt`, `list_models`, `search_models` |
| `agentic` | `preflight`, `team`, `report_error`, `allowance_status` |
| `session` | the 12 session tools |
| `debug` | `compare_models` |
| `channel`, or any other value | all 20, plus one stderr line naming the value and the valid ones (`unknownToolModeWarning`); for `channel` it says the group was renamed to `session` |

Unknown values keep selecting everything, because a server that lists fewer tools than its host
expects fails later and quietly. The stderr line is there so a typo is not read as `all` with
no trace.

`session` was `channel` until 10.7.0. The rename removed the old name with no alias, per the
thesaurus rule, so `channel` now falls into the unknown-value rule and selects everything. The
stderr startup line shows `tools: channel, 20 tools` after the unknown-value warning, but an MCP
host does not show stderr.
`compare_models` moved to `debug` at the same time: it sends one prompt to several models in
sequence and shows raw answers, which is a route check, not work. Real multi-model work is `team`.

## `run_prompt`: two paths

`run_prompt` (and each entry of `compare_models`) is one quick prompt to one model: one request,
one answer, no tools, no session. `runPrompt` in `mcp-server.ts` picks the path with
`nativeRouteFor()` (`providers/native-route.ts`) FIRST — the proxy's own gate, so the tool cannot
disagree with the proxy (the CLAUDE.md invariant about bare Claude names):

| Model | Path |
|---|---|
| a bare Claude name: `claude-*`, `opus`, `sonnet`, `haiku`, `opusplan`, `internal`, `default` | `runPromptViaClaudeCode` (`mcp/run-prompt-claude-code.ts`): one Claude Code print-mode call through claudish |
| everything else, including `anthropic@claude-*` (metered), `dv@claude-*` and `anthropic/claude-*` | `runPromptViaProxy`: one Anthropic Messages request to the in-process proxy, which routes it like any request |

**Why a Claude name cannot use the proxy.** Until 10.7.0 every model took the proxy path, and
`run_prompt {model: "claude-opus-5-5"}` answered `Proxy error: 401 … x-api-key header is
required`: the proxy's native route forwards the CALLER's credential, and an MCP tool call has
none. claudish must never read the Claude Code OAuth token or its Keychain item, so the only way
onto the user's subscription is the unmodified `claude` binary signing in on its own login.

**The Claude Code print call.** `resolveClaudishLaunch` (`CLAUDISH_BIN`, else `claudish` on PATH —
the same claudish the panes start) runs:

```
<claudish> -p --model <model> --output-format json --tools "" --strict-mcp-config
  --setting-sources "" --disable-slash-commands --no-session-persistence
  (--system-prompt-file <file> | --system-prompt "")
```

The original model string is passed; claudish's CLI owns alias normalisation. Measured on Claude
Code 2.1.301 (session `dev-feature-mcp-run-prompt-claude-20261016-a7c3`):

| Choice | Why |
|---|---|
| prompt on stdin, system prompt in a file | claudish's passthrough parser takes a flag value only when it does not start with `-` (`cli.ts` `passthroughFlagTakesValue`), so a prompt or value starting with `-` would be misparsed. stdin reaches `claude -p` unchanged (`- Say OK` answered correctly), and keeps the prompt out of `ps` |
| `--system-prompt ""` when none is given | omitting it loads Claude Code's default system prompt (3 232 input tokens against 586); the proxy path sends no system prompt either |
| a new empty working directory | `--setting-sources ""` does NOT stop CLAUDE.md and memory loading: 8 718 input tokens in this repo, 580–597 in an empty directory. The cwd is `<tmp>/claudish-run-prompt-*/cwd`; the system prompt file sits beside it, so the cwd is empty even then. Both are removed after the call |
| `--setting-sources ""` | still authenticates: `apiKeySource: "none"`, the Keychain login. The login is not a settings source |
| `--strict-mcp-config`, `--tools ""` | without them the child loads the user's plugins and starts another `claudish --mcp`; with them the init frame shows `mcp_servers: []`, `tools: []` |
| no `--bare` | `--bare` reads only `ANTHROPIC_API_KEY`/`apiKeyHelper`, never the login, and 401s again |

**The environment.** `claudeCodePrintEnv` is the server's environment minus
`isStrippedFromChildEnv` (`pane/pane-launch.ts`, the list the pane spawner uses: `CLAUDECODE`,
`CLAUDE_CODE_CHILD_SESSION`, `MAGMUX_*`, terminal identity, `CLAUDE_CODE_SESSION_ID` and the launcher
pids), minus the pane markers (`PANE_LAUNCH_VARS` and `CLAUDISH_PANE_CHILD`: in a nested server
the flag would make `assertNotNested` refuse `-p` with exit 64; the child is a leaf, so dropping
it opens no second level), minus `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL`.
`ANTHROPIC_API_KEY` goes unconditionally, not only claudish's placeholder: a bare Claude name in
`run_prompt` runs on the Claude Code login, and a user who wants the metered Anthropic API names
it as `anthropic@claude-*`.

**Process handling.** All three stdio streams are pipes: this process's stdin and stdout are the
JSON-RPC transport, and an inherited one would eat the host's requests or corrupt the stream. The
child is `detached` and stopped by its process group (SIGTERM, SIGKILL 5 s later), because
`claudish` on PATH may be the `bin/claudish.cjs` launcher, which orphans the real process on a
plain SIGTERM. There is no wall-clock deadline, as on the proxy path: the child stops on the call's
`AbortSignal` (`ToolCallContext.signal`, from the SDK's `extra.signal`: `notifications/cancelled`
or the host's own timeout) or at server shutdown (`stopAllClaudeCodePrintChildren` in
`installMcpShutdown`). Measured end to end: 1.3 s for a 404, 2.4 s for a Haiku answer.

**The answer.** Claude Code 2.1.301 `--output-format json` prints a JSON ARRAY of frames
(`system/init`, `assistant`, `rate_limit_event`, `result`); older releases printed one result
object. `parseClaudeCodePrintOutput` accepts both and reads the last `type: "result"` frame and the
`system/init` frame. `result` is the answer; `usage.input_tokens + cache_creation_input_tokens +
cache_read_input_tokens` is the input (a cached prefix is context the model saw); the init frame's
`apiKeySource` becomes the `Auth:` line (`"none"` → `Auth: Claude Code login (subscription)`).
`total_cost_usd` is not shown: on a subscription it is a list-price equivalent
(`costBasis: "list"`), not money spent. Exit 0 proves nothing; the verdict is the result frame:

| Condition | Error text |
|---|---|
| `is_error: true` (API error, "Not logged in") | `Claude Code: <result>` plus ` (HTTP <api_error_status>)` when it is a number |
| the executable cannot start | `cannot start claudish (<command>): <code>` |
| no result frame | `claudish -p exited <code>: <stderr tail, sanitized>` (the missing-`claude` case lands here) |
| empty `result` | `Model returned empty response` |
| the call's signal fired | `cancelled` |

**No `max_tokens` on either path.** `run_prompt` and `compare_models` have no output-limit
parameter, and `runPromptViaProxy`'s body has no `max_tokens`. Step 5w strips every limit field the
adapters write and adds the wire's `tokenParam` only when the request carries a limit, so the
upstream applies its own default and no number is pinned ([`wire.md`](wire.md)). Measured 200 with
no limit on chat-completions (`mm@MiniMax-M3`, `kimi-k3`), responses (`gpt-6.1-sol`) and
anthropic-messages (`mmc@MiniMax-M3`). The one known host that REQUIRES `max_tokens` is
`api.anthropic.com`, reached now only by the explicit metered `anthropic@claude-*`; if it 400s,
the fix belongs in step 5w (write the connection's catalog `maxOutputTokens` for
`anthropic-messages`), never in the MCP server.

Why `-p` is acceptable for this one call, when the session tools refuse it:
[`headless-vs-interactive.md`](headless-vs-interactive.md) "The one `-p` the MCP server starts".

### Nested mode

A claudish MCP server whose environment has `CLAUDISH_PANE_CHILD=1` (`inMcpSession()`) runs inside a
session that a claudish owner started: Claude Code in a `create_session` or `team` pane started it
as a plugin server. One level of nesting is the limit (why, and the CLI side of the rule:
[`pane-session.md`](pane-session.md) § One level of nesting). Such a server:

- registers only `NESTED_MCP_TOOL_NAMES` (`mcp/nested-mode.ts`): `run_prompt`, `compare_models`,
  `list_models`, `search_models`. The rule is that a tool is kept only if it is a one-shot call that
  starts no session, no pane and no claudish child that could start one. `team` and every session
  tool start or act on sessions. `preflight` and `report_error` are out as well, so the nested
  surface is the low-level group plus `compare_models` from the debug group. `run_prompt` on a
  Claude model does start a `claudish -p`, a leaf with no tools and no MCP servers (see
  § `run_prompt`: two paths, The environment);
- INTERSECTS that list with the groups `CLAUDISH_MCP_TOOLS` enables and never widens them:
  `all` or unset give 4 tools, `low-level` 3, `debug` 1 (`compare_models`), `agentic` or `session`
  0. Any value still yields no session tool, which matters because madbench forces `all` and an env
  snapshot can carry the variable;
- filters by NAME and fails closed. A tool added later is absent in nested mode until someone lists
  it, whereas a group filter would admit any future tool of its group;
- declares only the `tools` capability, as every claudish MCP server now does;
- answers `initialize` with `NESTED_INSTRUCTIONS` in place of the normal instructions, so the model
  reads why the session tools are absent and what to do instead: it is the delegate, so it does the
  task with its own tools, and a workflow step that says to delegate is satisfied by its own run.
  Without that last sentence (10.6.3), a gpt-6.1-sol child running `/dev:qa`-style work found no
  `create_session` and started `codex exec` through `terminal:mux`. The fix is guidance, not a
  guard: no CLI is blocked. The text lives here because every child receives the server
  instructions, including one that never loads the claudish-usage skill, whose section "Inside a
  claudish session (child mode)" carries the longer version;
- drops the "use the `report_error` tool" hint from `run_prompt`'s and `compare_models`' error
  texts, since that tool is not registered;
- logs `[claudish] MCP server started (tools: nested, 4 tools)`.

A call to a removed tool takes the ordinary unknown-tool path:
`isError: true`, `Error: Unknown tool "create_session"`.

## Tool Registration Pattern

Uses a `ToolDefinition[]` registry with raw JSON Schema (not Zod). Two `setRequestHandler` calls replace McpServer's ergonomic API:
- `ListToolsRequestSchema` → returns filtered tool list
- `CallToolRequestSchema` → dispatches to handler by name

## Push notifications were removed (10.7.0)

Until 10.7.0 the server declared `experimental: {"claude/channel": {}}` and pushed a
`notifications/claude/channel` frame on every session state change (plus a coalesced
`tool_executing` repeat at most once a second) and on every `team` progress tick, with SEP-1686
forward-compatibility fields (`task_id`, `status`, `created_at`, `last_updated_at`). Removed with
it: the capability, the `onStateChange` bridge and `SessionManager.emitFrame`, `notifyChannel`,
the SEP-1686 projection (`mapEventToTaskStatus`), the `ChannelEvent` type, and the
`CLAUDISH_CHANNEL_TRACE` diagnostics (`channel/diagnostics.ts`).

Why: Claude Code rendered those frames only for an interactive host started with `--channels` (or
`--dangerously-load-development-channels`) and the server in project `.mcp.json` or
`~/.claude.json` — `--mcp-config` is not consulted by the channel resolver, and `-p` never
registers channels. Every other host dropped every frame, and a host polling `list_sessions` gets
the same facts from the records. The frames were never a keepalive either (next section).

Where the facts are now: `list_sessions` rows (`state`, `activity`, `idle_seconds`, accounting),
`get_output`, `get_diagnostics`, `capture_session`, `transcript_session`, and the session records (`spawn.json`,
`waits.jsonl`, `meta.json`, `events.jsonl`, `screen.txt`), which outside observers read and which
are byte-identical to before. `waits.jsonl` keeps the same event names in its `to` field.
`team` progress is `team(mode:"status")`. The `notifications/progress` keepalive stays.

The trigger to reconsider is in `ROADMAP.md`: Claude Code delivering `notifications/tasks/status`
(SEP-1686) into the agent's context without `--channels`.

Diagnostic script: `scripts/pane-drive.ts` drives one pane session from the command line
(`--fake <scenario>` for the hermetic fake child).

## Testing

```bash
bun test ./packages/cli/src/mcp-session/
```

Sessions are panes, so the suites that start one run a REAL headless magmux with the pane
fake child (`pane/test-helpers/fake-interactive-child.ts`) as `CLAUDISH_BIN`, under a per-test
`CLAUDISH_PANE_ROOT` and an allowlisted environment, and assert after each test that no process,
socket, record or launcher directory is left. Without magmux they skip with "magmux not installed —
not checked". `testing.md` has the rules.

- `session-manager.test.ts` — the pure seams (`sessionEventFor` over every `SlotState`,
  `toMetaRecord`, `sessionRowOf`, `normaliseTimeoutSeconds`), the two-generation disk reader, the
  hostile-id and bounded-read guards, live pane sessions (one-shot and promptless `waits.jsonl`
  transitions, a send queued while STARTING (G7) or RUNNING, the timeout staying TIMEOUT in memory,
  `meta.json` and `waits.jsonl` (G1/G2), cancel, recovery from disk), and the module-load signal
  exit codes (G3). G4 is the flag check.
- `session-records.contract.test.ts`, `session-state-records.contract.test.ts`,
  `spawn-record.contract.test.ts`, `host-pid.contract.test.ts`, `session-timeout.test.ts` — the
  on-disk records the monitor reads. These were written blind from the 10.4.0 specification; the
  pane port changed only the adapters and the fake, and every replaced assertion cites its RB/D
  number.
- `session-wire-format.test.ts` — the capability declaration: no `experimental` for any tool mode.
- `../mcp-contract.e2e.test.ts` — the mod contract v1 through a real MCP server over JSON-RPC;
  `../mcp-shutdown.e2e.test.ts` — stdin EOF, SIGTERM and SIGKILL of a server holding a live session
  and a live team run.

**The tool list is pinned per group, and adding a tool must break a pin.** `e2e-sessions.test.ts` freezes the full 15-name list, the session-only 8 and the low-level 3, deliberately: that list is a wire contract and an accidental change to it should be loud. `get_diagnostics`, `capture_session`, `resize_session`, `scroll_session` and `transcript_session` each broke both pins on the way in, which is the guard working.

E2E tests use `--strict-mcp-config --bare --dangerously-skip-permissions` for isolation. SessionManager tests point child spawns at the tree under test via `CLAUDISH_BIN` (`spawn-claudish.ts`), never at the installed binary.

**`--bare` defers the MCP connection past `system/init` — do not assert MCP discovery under it.** Measured 2026-08-01 with a 20-line dependency-free stdio MCP server, so this is Claude Code behaviour, not a claudish one:

| flags | `system/init` `mcp_servers` | MCP tools in the init `tools` array | what the model did |
|---|---|---|---|
| `-p --strict-mcp-config --bare` | `status: "pending"` | none | two `Bash` calls first, then *sometimes* the MCP tool |
| `-p --strict-mcp-config` | `status: "connected"` | present | `ToolSearch` → the MCP tool |

Under `--bare` the tools are not in the model's toolset when it decides what to do, so it improvises with `Bash` — with the real claudish server it answered *"I don't have access to a tool called `mcp__claudish__list_models`. My available tools are `Bash`, `Edit`, and `Read`."* Any test asserting that a tool was DISCOVERED or CALLED must drop `--bare`; `--strict-mcp-config` alone still restricts MCP to the temp config, which is the isolation that matters. Keep `--bare` for tests that only drive the server directly over JSON-RPC.

Assert on the protocol, never on prose: `--output-format stream-json --verbose` exposes the `init` server status, the `tools` array, and the `tool_use`/`tool_result` pair. An assertion like `stdout.includes("Recommended Models")` passes for the wrong reason — it matched output the model produced via `Bash` while MCP discovery was silently broken. Also `proc.stdin.end()` on the spawned `claude`, or every run stalls 3s on "no stdin data received". (These are the e2e tests' OWN `claude -p` client; the sessions the server starts are panes.)

## The `notifications/progress` keepalive (`mcp/progress-heartbeat.ts`)

Claude Code aborts a tool call that puts nothing on the transport for its idle window — `MCP server "plugin:claudish:claudish" tool "team" sent no response or progress for 1800s; aborting`. Measured 2026-08-14 on **2.1.231** with three tools of identical 90s duration against a 30s window (`ai-docs/reports/mcp-progress-keepalive/findings.md`):

| Tool emits every 10s | Outcome |
|---|---|
| nothing | aborted at 30s |
| `notifications/progress` | survived 90s |
| `notifications/claude/channel` | aborted at 30s |

**Progress is the keepalive**, and the only one: a channel frame never reset the idle timer (the
row above is kept as the measurement that showed it; the channel push itself was removed in
10.7.0). Progress still renders nowhere.

**`heartbeat: true` is set on exactly four tools**: `team`, `run_prompt`, `compare_models`, `preflight`. `team(mode:"run")` itself returns once every slot's prompt is accepted (at most 90 s + 30 s), but `run-and-judge` holds the call for the whole run. `create_session` deliberately does NOT carry it — it returns `{session_id, state}` as soon as the pane exists, without waiting for boot, and cannot reach the idle timer; the session's own long life is read by polling `list_sessions`, which is a different question.

**The emitter is TIME-driven, not event-driven**, and that is the load-bearing choice. `team` once emitted a channel frame on every state change and still died at exactly 1800s, because a model that thinks for 30 minutes produces no state changes — an event-driven emitter goes silent precisely while the idle timer is counting.

Interval defaults to 10s (the measured-working value), overridable with `CLAUDISH_MCP_PROGRESS_INTERVAL_MS`, clamped to `[1000, 60000]`, garbage → default. Resolved once per server, not per call, so a long session cannot change cadence mid-flight. The first frame lands at t+interval, so a 200ms call stays completely silent.

**An absent or invalid `progressToken` degrades to `NOOP_HEARTBEAT`** — a shared frozen handle: no timer, no frame, no warning, no throw. The token is optional in the spec, so a host that omits it has not misbehaved, and a tool call must never fail because its keepalive could not arm. (2.1.231 does send it — observed value `2` in every probe arm. `anthropics/claude-code#58687`, which reports the client sends no `_meta.progressToken`, is STALE.)

**`stop()` latches; `clearInterval` alone would not be enough.** The dispatch owns start and stop in a `finally`, and `stopped` is re-checked at the top of `emit`, so a tick already queued on the macrotask queue when the response was computed is dropped instead of reaching the wire after its own response — the `GLips/Figma-Context-MCP#362` teardown pattern, where a frame arriving after the client cleaned up its token tears down stdio.

**Idle-window defaults, for sizing any test or config**: 30 min on stdio, 5 min on HTTP/SSE/WS. A per-server `timeout` (ms, ≥1000) in `.mcp.json` floors it for that server only; `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0` disables the check entirely. **Undocumented floor worth knowing**: values below ~30s are silently ignored by the client — `1000` and `5000` were (a silent 20s call survived a nominal 5s window), `30000` was honoured exactly. Any test using a shorter window is confounded, because its control cannot fail.
