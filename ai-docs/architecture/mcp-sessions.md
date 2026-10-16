> The 14-tool MCP surface and its four groups, the sessions behind it (panes, records, polling), `run_prompt`'s two paths, the removed channel push, and the progress keepalive.
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
  own headless magmux pane, with the transcript as its turn oracle. Team uses the same driver
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

**A session is created in this order**: the flag check, `assertMagmuxAvailable` (magmux ≥ 0.14.0,
else `Error: magmux_unavailable: …`), credential pre-hydration, the parent session read, a pane
reservation (`Error: pane_limit: …` past 48 live panes per user), `prompt.md`, `spawn.json`, then the
pane. `create_session` returns `{session_id, state}` once the pane exists, without waiting for boot.
A pane that fails to start leaves a FAILED `pane_lost` session with its `meta.json`, and the call
fails.

**The verdict is the owner's (D8).** A one-shot session's settled turn is classified by
`classifyRunOutput` with no byte floor and no pattern (`api_error`, `prompt_not_read`, `refused`,
`empty_output`), and the session is terminal at that verdict, before its pane is reaped. An
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
one). The mutators — `send_input`, `cancel_session`, `capture_session` — never do: a recovered
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

**`waiting_for_input` means a real wait, and nothing else.** It holds iff the session is idle at
an empty input box between turns, or a turn is blocked on a question; `awaiting_permission` iff a
permission or plan-approval dialog is open. A one-shot session is terminal at its verdict, so there
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
contract the monitor reads, so it keeps those words. It is append-only because an observer polling the directory (the magus
`claudish` plugin monitor) must see a wait that opened and closed between two of its reads — a
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
  "claudeSessionId": "<the child's uuid>"
}
```

It exists for observers OUTSIDE this process — the magus `claudish` plugin monitor polls the
sessions directory and reports progress to the Claude Code window that started a run.
`claudeSessionId` is the pane's `--session-id` uuid, the transcript's basename. For a pane session
`mcpPid` is also the pane record's owner, and the watchers make the monitor's liveness inference
sound: when the writer dies, its panes die with it.

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
`toMetaRecord`. It keeps every 10.4.0 key under its 10.4.0 name, because the monitor reads
`status` (an unknown value reads as `failed`), `terminalReason`, `elapsedSeconds`,
`turnsCompleted`, `toolCallCount`, `costUsd` and `exitCode`:

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
  `anomalies`; the tail of the event ring; the upstream error bodies; and the paths: the
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

## MCP Tools (14 total)

- **Low-level** (3): `run_prompt`, `list_models`, `search_models`
- **Agentic** (3): `preflight`, `team`, `report_error`
- **Session** (7): `create_session`, `send_input`, `get_output`, `cancel_session`,
  `list_sessions`, `get_diagnostics`, `capture_session`
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

**The polling verbs are the frozen mod contract v1** (`pane/contract.ts`, summarised in
`pane-session.md`): `list_sessions` answers `{contract_version, capabilities, sessions}` with one
`SessionRow` per session (state, reason, `reason_detail`, tokens, `cost_usd`, tool calls, turns, `idle_seconds`,
`activity`, `pane`); `cancel_session` answers `{session_id, state, changed}`; `capture_session`
answers the session's current 160×50 screen `{seq, cols, rows, cursor, lines, final, spans?}`, or
`{unchanged:true, seq, final}` when `since_seq` is still current — a memory read, meant for polling
at about 1 Hz. Their errors are a JSON `ContractError`. `team` gains the same verbs as modes
(`list`, `status`, `capture`, `cancel`).

The tool list is pinned by an EXACT frozen array in `mcp-session/e2e-sessions.test.ts`, so
adding or removing a tool without updating that test fails CI. That is deliberate:
it is a wire contract, and an accidental change to the tool surface should be loud.

Tool gating via the `CLAUDISH_MCP_TOOLS` env var (lower-cased, `resolveToolGroups` in
`mcp-server.ts`):

| Value | Tools |
|---|---|
| unset, `all` | all 14 |
| `low-level` | `run_prompt`, `list_models`, `search_models` |
| `agentic` | `preflight`, `team`, `report_error` |
| `session` | the 7 session tools |
| `debug` | `compare_models` |
| `channel`, or any other value | all 14, plus one stderr line naming the value and the valid ones (`unknownToolModeWarning`); for `channel` it says the group was renamed to `session` |

Unknown values keep selecting everything, because a server that lists fewer tools than its host
expects fails later and quietly. The stderr line is there so a typo is not read as `all` with
no trace.

`session` was `channel` until 10.7.0. The rename removed the old name with no alias, per the
thesaurus rule, so `channel` now falls into the unknown-value rule and selects everything. The
stderr startup line shows `tools: channel, 14 tools` after the unknown-value warning, but an MCP
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
`get_output`, `get_diagnostics`, `capture_session`, and the session records (`spawn.json`,
`waits.jsonl`, `meta.json`, `events.jsonl`, `screen.txt`), which the magus monitor reads and which
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

**The tool list is pinned per group, and adding a tool must break a pin.** `e2e-sessions.test.ts` freezes the full 14-name list, the session-only 7 and the low-level 3, deliberately: that list is a wire contract and an accidental change to it should be loud. `get_diagnostics` and `capture_session` each broke both pins on the way in, which is the guard working.

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
