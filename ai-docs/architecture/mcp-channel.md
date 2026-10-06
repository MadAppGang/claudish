> The 14-tool MCP surface, the channel sessions behind it, the channel wire format, client-side gating conditions, and the progress keepalive.
>
> Extracted from `CLAUDE.md` (v7.64.0). Indexed in [`README.md`](./README.md).

# Channel Mode (v6.4.0+)

The MCP server supports a channel mode that enables async model sessions with push notifications.

## Architecture

Uses the low-level `Server` class (not `McpServer`) from `@modelcontextprotocol/sdk/server/index.js` to declare `experimental: { 'claude/channel': {} }` capability. The SDK's `assertNotificationCapability()` has no default case — custom notification methods like `notifications/claude/channel` pass through.

## Components (`packages/cli/src/channel/`)

- **SessionManager** — the channel's policy and records: creates sessions, owns the queue of
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
covers what the channel adds on top.

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
else `Error: magmux_unavailable: …`), credential pre-hydration, the parent proof, a pane
reservation (`Error: pane_limit: …` past 48 live panes per user), `prompt.md`, `spawn.json`, then the
pane. `create_session` returns `{session_id, state}` once the pane exists, without waiting for boot.
A pane that fails to start leaves a FAILED `pane_lost` session with its `meta.json`, and the call
fails.

**The verdict is the owner's (D8).** A one-shot session's settled turn is classified by
`classifyRunOutput` with no byte floor and no pattern (`api_error`, `prompt_not_read`, `refused`,
`empty_output`), and the session is terminal at that verdict, before its pane is reaped. An
interactive session continues after each turn and fails only on an API-error turn (D20); a turn
whose task file was not fully read records the anomaly and `meta.prompt_not_read` on the next
frame. A question or a permission dialog waits for `send_input` (team fails it instead).
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

**`"timeout"` is a first-class wire event — the record and the channel agree.**
They diverged until Phase 3: `EVENT_TO_TASK_STATUS` had no `"timeout"` key and fell
through to `?? "working"`, so emitting the real event reported a *dead* session as still
working. The timeout path therefore recorded `"timeout"` and emitted `"failed"`, and a
consumer watching only the channel could not tell "ran out of time" from "errored".
`["timeout", "failed"]` now exists in that map (SEP-1686 has no `timeout` member; `failed`
is its only honest projection). The map is now built from a `Record<ChannelEventType, TaskStatus>`
over the runtime list `CHANNEL_EVENT_TYPES`, so an event type without a projection is a compile
error, and `awaiting_permission` (a dialog only `send_input` can move on) projects to
`input_required` instead of falling through to `working`. **Mutation-proven**: remove the timeout
key and a timed-out session goes back to `status: "working"` on the wire.

**Session shape follows the prompt.** `create_session` WITH a prompt is one-shot: it is terminal
at the verdict of the turn that prompt started. WITHOUT a prompt it is interactive: it waits in
`waiting_for_input` once Claude Code has booted and again after every turn, and it ends on
`cancel_session`, the timeout, or the child exiting 0 after `/exit` or a settled turn. A
`send_input` call converts a one-shot session to interactive.

**`waiting_for_input` means a real wait, and nothing else.** It holds iff the session is idle at
an empty input box between turns, or a turn is blocked on a question; `awaiting_permission` iff a
permission or plan-approval dialog is open. A one-shot session is terminal at its verdict, so there
is no "answered but still exiting" state for a wait to be confused with — 10.4.0's `finishing`
channel event is gone with the transport (RB1). The wait for Claude Code's end-of-turn record after
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
open; `to` is the channel event of the new state, never another wait (the phase table has no
wait-to-wait edge). It is append-only because an observer polling the directory (the magus
`claudish` plugin monitor) must see a wait that opened and closed between two of its reads — a
marker file that exists only during the wait cannot give it that.

The writer is the pane's `onTransition` hook: synchronous, every wire-state change, never
coalesced, and called BEFORE the channel frame, so the line is on disk by the time anyone hears of
the wait. It reports the net change of one event-processing step, so a turn that settles with a
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
  "parentClaudeSessionId": "<uuid>", // OPTIONAL — present only when proven
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

**`hostPid` is structural, computed once at startup** (`hostPidFrom`, `channel/parent-proof.ts`).
A compiled binary or `bun src/index.ts` is the direct child of Claude Code, so `hostPid` is
`process.ppid`. An npm/bun global install runs Claude Code → `node bin/claudish.cjs` → `bun
dist/index.js`, so the launcher puts `CLAUDISH_LAUNCHER_PID` (itself) and
`CLAUDISH_LAUNCHER_PPID` (its parent) in the child's env, and the child believes the pair only
when `CLAUDISH_LAUNCHER_PID` is its real `ppid` — a pair leaked into a nested claudish is
inert. `launcherPid` is recorded exactly when that branch ran. No `ps`, no tree walk. The pane
environment strips the pair and `CLAUDE_CODE_SESSION_ID`, so a claudish MCP server nested inside a
pane cannot inherit the host's identity either.

**`parentClaudeSessionId` is proven per call, or absent** (`proveCallingConversation`). The
environment's `CLAUDE_CODE_SESSION_ID` goes stale on `/clear`, on a resume, and whenever two
windows share a conversation, so it is never stored as such. Claude Code puts the calling
tool-use id in the request `_meta["claudecode/toolUseId"]` (the dispatcher passes it as
`ctx.toolUseId`), and the tool_use block lands in the caller's transcript — but ASYNCHRONOUSLY:
in a live Claude Code 2.1.290 session (2026-10-06, 10 ms poller) the `create_session` record
reached disk 377 ms after its own timestamp, after the tool had already started. For at most two candidates — the env id (only when `CLAUDE_CODE_CHILD_SESSION` is empty)
and the `sessionId` of the host's live record `<configDir>/sessions/<hostPid>.json` (only when
its `pid` matches) — the proof finds the candidate's project directory (fast path: the host
record's `cwd` with every non-alphanumeric character replaced by `-`; else one listing of
`projects/`, cached per candidate), then searches the last 256 KB of `<C>.jsonl` and up to 32
subagent transcripts modified in the last 10 minutes for the quoted id. No hit → look again
every 100 ms (`PROOF_POLL_INTERVAL_MS`) until 2000 ms (`PROOF_DEADLINE_MS`) have passed, then
absent; a hit returns at once, so a call whose record is already on disk waits for nothing. The
single 250 ms retry this replaced lost that race in 2 of 3 calls in one session. A tool-use id is unique and lives only in the transcript of the
conversation that issued it, so a hit is proof and every failure degrades to "absent". It is
`await`ed with `fs/promises` before `createSession`, so the server keeps pumping live sessions
while it looks. `meta.json` carries the same key with the same value exactly when `spawn.json`
does.

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
unset, and it was unset for every channel child. Its own comment states the cost: `log()`
only persists under `--debug`, so the body distinguishing a retryable rate limit from a hard
quota wall is gone the moment it is classified. Each session now points its child at
`<sessionDir>/upstream-errors.jsonl` — set unconditionally, overriding any inherited value,
because the records carry no session id and a shared path interleaves 20 concurrent sessions
into one unattributable file. The capture **redacts at write time** now that it is no longer
only a path a user opted into: a 401/403 body routinely echoes the credential that failed,
and `get_diagnostics` hands these records to an agent.

## MCP Tools (14 total)

- **Low-level** (4): `run_prompt`, `list_models`, `search_models`, `compare_models`
- **Agentic** (3): `preflight`, `team`, `report_error`
- **Channel** (7): `create_session`, `send_input`, `get_output`, `cancel_session`,
  `list_sessions`, `get_diagnostics`, `capture_session`

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
`SessionRow` per session (state, reason, tokens, `cost_usd`, tool calls, turns, `idle_seconds`,
`activity`, `pane`); `cancel_session` answers `{session_id, state, changed}`; `capture_session`
answers the session's current 160×50 screen `{seq, cols, rows, cursor, lines, final, spans?}`, or
`{unchanged:true, seq, final}` when `since_seq` is still current — a memory read, meant for polling
at about 1 Hz. Their errors are a JSON `ContractError`. `team` gains the same verbs as modes
(`list`, `status`, `capture`, `cancel`).

The tool list is pinned by an EXACT frozen array in `channel/e2e-channel.test.ts`, so
adding or removing a tool without updating that test fails CI. That is deliberate:
it is a wire contract, and an accidental change to the tool surface should be loud.

Tool gating via `CLAUDISH_MCP_TOOLS` env var: `all` (default), `low-level`, `agentic`, `channel`.

## Tool Registration Pattern

Uses a `ToolDefinition[]` registry with raw JSON Schema (not Zod). Two `setRequestHandler` calls replace McpServer's ergonomic API:
- `ListToolsRequestSchema` → returns filtered tool list
- `CallToolRequestSchema` → dispatches to handler by name

## Channel Notifications

`server.notification({ method: "notifications/claude/channel", params: { content, meta } })` — pushed by SessionManager's `onStateChange` callback when a session's channel event changes, plus a coalesced `tool_executing` repeat (at most one per second) when the tool or the tool count changes. The method, capability, and params shape match Anthropic's [Channels reference](https://code.claude.com/docs/en/channels-reference) byte-for-byte.

The wire format is contractually pinned by `channel-wire-format.test.ts`:

```json
{
  "method": "notifications/claude/channel",
  "params": {
    "content": "<string>",
    "meta": {
      "session_id": "<8-char hex>",
      "event": "starting|running|tool_executing|waiting_for_input|awaiting_permission|completed|failed|cancelled|timeout",
      "model": "<model-id>",
      "elapsed_seconds": "<numeric string>",
      "task_id": "<same as session_id>",
      "status": "working|input_required|completed|failed|cancelled",
      "created_at": "<ISO 8601 from session start>",
      "last_updated_at": "<ISO 8601 at notification time>"
    }
  },
  "jsonrpc": "2.0"
}
```

The event is derived from the session's state by `channelEventFor` (`session-manager.ts`):
STARTING → `starting`; RUNNING → `tool_executing` when its activity is a tool name, else `running`;
AWAITING_INPUT → `waiting_for_input`; AWAITING_PERMISSION → `awaiting_permission`; COMPLETED,
CANCELLED, TIMEOUT → their own event; FAILED and EMPTY → `failed`. Frames may add `tool` and
`tool_count`, `activity` (whenever it is non-null), `prompt_not_read` and `send_rejected`. The
content is claudish's own short text per event: the question or dialog text when the session is
blocked, the reason and detail on `failed`.

When rendered by Claude Code, each notification arrives in the agent's context as:

```
<channel source="claudish" session_id="…" event="…" model="…" elapsed_seconds="…">
<content here>
</channel>
```

`meta` keys must match `[a-zA-Z0-9_]+` — Claude Code silently drops keys with hyphens or other characters. Our schema uses underscore-only keys (`session_id`, `elapsed_seconds`, etc.); when adding new `extraMeta` keys in `SessionManager.emitFrame`, keep this constraint.

The `task_id` / `status` / `created_at` / `last_updated_at` fields are SEP-1686 (MCP Tasks) forward-compatibility — additive only, no current consumer behavior change. The 9-value `event` collapses to the 5-value `status` per `EVENT_TO_TASK_STATUS` in `mcp-server.ts`; **every member of `ChannelEventType` must have a key there** — enforced at compile time now, because `mapEventToTaskStatus` falls through to `?? "working"` and a missing key silently reports a finished session as running. When Claude Code ships `notifications/tasks/status` receiver support, the migration is a method-name swap + payload restructure; see `ROADMAP.md` (Channel notifications → Phase 2) and `ai-docs/sessions/dev-research-mcp-tool-progress-20260508-235612-8d9da3e8/sep-1686-migration-schema.md` (write-up lost — predates the ai-docs tracking fix) for the full plan.

## Enabling channel rendering in Claude Code

The Claudish MCP server emits the documented wire format, but Claude Code gates channel **registration** behind several conditions that have nothing to do with the wire contract. All of these must be satisfied for `<channel>` blocks to surface in the agent's context:

| Requirement | Why |
|---|---|
| Claude Code v2.1.80 or later | Channels feature minimum version |
| Anthropic auth via claude.ai OR Console API key | Channels are NOT supported on Bedrock, Vertex, or Foundry |
| Interactive session (no `-p` / `--print`) | Channel registration is bound to the interactive event loop. Empirically verified: in `-p` mode the registration codepath never runs and frames are silently dropped |
| Server defined in project `.mcp.json` or `~/.claude.json` | `--mcp-config` is NOT consulted by the channel resolver. Tools loaded via `--mcp-config` work; channels declared by the same server do not register |
| Server explicitly named in `--channels` OR `--dangerously-load-development-channels` | Being in MCP config alone is not enough. Per Anthropic docs: *"a server also has to be named in `--channels`"* |
| Org policy `channelsEnabled: true` (Team/Enterprise only) | Pro/Max users without an org skip this check |

**Launch command — bare server**:

```bash
# in a directory with .mcp.json containing a "claudish" entry
claude --dangerously-load-development-channels server:claudish
```

**Launch command — via the Magus `code-analysis` plugin** (Claudish is bundled there as an MCP server):

```bash
claude --dangerously-load-development-channels plugin:code-analysis@magus
```

The `--dangerously-load-development-channels` flag triggers a one-time confirmation prompt per session. To remove that prompt, the plugin would need to be added to Anthropic's curated channel allowlist (security review required) or to your org's `allowedChannelPlugins` managed setting.

## Diagnostic tracing — `CLAUDISH_CHANNEL_TRACE=1`

When the channel pipeline appears broken (e.g., client never renders `<channel>` blocks), set `CLAUDISH_CHANNEL_TRACE=1` before starting the MCP server. The diagnostics module (`packages/cli/src/channel/diagnostics.ts`) then emits `[channel-trace] …` lines to stderr at three checkpoints:

1. `fired sid=… type=… model=… elapsed=…s` — onStateChange callback entered (producer side fires)
2. `callback returned sid=… type=…` — bridge invoked `server.notification()` without throwing
3. `WIRE-OUT {…json…}` — the JSON-RPC frame literally hit stdout

If you see (1) but not (2): the bridge is throwing or rejecting silently.
If you see (1)+(2) but not (3): the SDK's transport is dropping the frame.
If you see all three but the client doesn't render the notification: the issue is client-side — most often one of the gating conditions in "Enabling channel rendering in Claude Code" above is unmet.

Off by default. Zero overhead in production.

When the MCP server is spawned by a host that captures stderr (e.g. Claude Code), set `CLAUDISH_CHANNEL_TRACE_FILE=/path/to/log` alongside `CLAUDISH_CHANNEL_TRACE=1` to mirror trace lines to a file you can `tail` from outside the host process. The file is opened with `appendFileSync` so multiple sessions append safely.

Diagnostic scripts:
- `packages/cli/src/channel/test-helpers/channel-diagnostic.ts` — drives the MCP server with raw JSON-RPC against the OpenRouter free model. Confirms the producer→bridge→wire pipeline.
- `packages/cli/src/channel/test-helpers/client-diagnostic.ts` — spawns `claude -p` against the instrumented MCP server and compares what the server sent vs. what the client surfaced. Useful for diagnosing client-side gating.
- `packages/cli/src/channel/test-helpers/claudish-mock.ts` — a standalone mock MCP server that exposes a single `start_mock_session` tool, then emits a scripted sequence of 6 channel notifications over ~9 seconds. Decouples channel-rendering tests from real-model behavior.
- `scripts/pane-drive.ts` — drives one pane session from the command line (`--fake <scenario>` for the hermetic fake child).

## Testing

```bash
bun test ./packages/cli/src/channel/
```

Channel sessions are panes, so the suites that start one run a REAL headless magmux with the pane
fake child (`pane/test-helpers/fake-interactive-child.ts`) as `CLAUDISH_BIN`, under a per-test
`CLAUDISH_PANE_ROOT` and an allowlisted environment, and assert after each test that no process,
socket, record or launcher directory is left. Without magmux they skip with "magmux not installed —
not checked". `testing.md` has the rules.

- `session-manager.test.ts` — the pure seams (`channelEventFor` over every `SlotState`,
  `toMetaRecord`, `sessionRowOf`, `normaliseTimeoutSeconds`), the two-generation disk reader, the
  hostile-id and bounded-read guards, live pane sessions (one-shot and promptless frames, a send
  queued while STARTING (G7) or RUNNING, the timeout staying TIMEOUT in memory, `meta.json` and on
  the wire (G1/G2), cancel, recovery from disk), and the module-load signal exit codes (G3). G4 is
  the flag check.
- `session-records.contract.test.ts`, `session-state-records.contract.test.ts`,
  `spawn-record.contract.test.ts`, `host-pid.contract.test.ts`, `session-timeout.test.ts` — the
  on-disk records the monitor reads. These were written blind from the 10.4.0 specification; the
  pane port changed only the adapters and the fake, and every replaced assertion cites its RB/D
  number.
- `channel-wire-format.test.ts`, `event-task-status.test.ts` — the wire format and the SEP-1686
  projection, including `awaiting_permission` and the absence of `finishing`.
- `../mcp-contract.e2e.test.ts` — the mod contract v1 through a real MCP server over JSON-RPC;
  `../mcp-shutdown.e2e.test.ts` — stdin EOF, SIGTERM and SIGKILL of a server holding a live session
  and a live team run.

**The tool list is pinned twice, and adding a tool must break both.** `e2e-channel.test.ts` freezes the full 14-name list and the channel-only 7, deliberately: that list is a wire contract and an accidental change to it should be loud. `get_diagnostics` and `capture_session` each broke both pins on the way in, which is the guard working.

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

Channel and progress are **complementary, not alternatives**: channel is the visible surface with no keepalive, progress is the invisible keepalive — it still renders nowhere. A tool that blocks for minutes needs both.

**`heartbeat: true` is set on exactly four tools**: `team`, `run_prompt`, `compare_models`, `preflight`. `team(mode:"run")` itself returns once every slot's prompt is accepted (at most 90 s + 30 s), but `run-and-judge` holds the call for the whole run. `create_session` deliberately does NOT carry it — it returns `{session_id, state}` as soon as the pane exists, without waiting for boot, and cannot reach the idle timer; the session's own long life is reported over channel frames, which is a different question.

**The emitter is TIME-driven, not event-driven**, and that is the load-bearing choice. `team` already emitted a channel frame on every state change and still died at exactly 1800s, because a model that thinks for 30 minutes produces no state changes — an event-driven emitter goes silent precisely while the idle timer is counting.

Interval defaults to 10s (the measured-working value), overridable with `CLAUDISH_MCP_PROGRESS_INTERVAL_MS`, clamped to `[1000, 60000]`, garbage → default. Resolved once per server, not per call, so a long session cannot change cadence mid-flight. The first frame lands at t+interval, so a 200ms call stays completely silent.

**An absent or invalid `progressToken` degrades to `NOOP_HEARTBEAT`** — a shared frozen handle: no timer, no frame, no warning, no throw. The token is optional in the spec, so a host that omits it has not misbehaved, and a tool call must never fail because its keepalive could not arm. (2.1.231 does send it — observed value `2` in every probe arm. `anthropics/claude-code#58687`, which reports the client sends no `_meta.progressToken`, is STALE.)

**`stop()` latches; `clearInterval` alone would not be enough.** The dispatch owns start and stop in a `finally`, and `stopped` is re-checked at the top of `emit`, so a tick already queued on the macrotask queue when the response was computed is dropped instead of reaching the wire after its own response — the `GLips/Figma-Context-MCP#362` teardown pattern, where a frame arriving after the client cleaned up its token tears down stdio.

**Idle-window defaults, for sizing any test or config**: 30 min on stdio, 5 min on HTTP/SSE/WS. A per-server `timeout` (ms, ≥1000) in `.mcp.json` floors it for that server only; `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0` disables the check entirely. **Undocumented floor worth knowing**: values below ~30s are silently ignored by the client — `1000` and `5000` were (a silent 20s call survived a nominal 5s window), `30000` was honoured exactly. Any test using a shorter window is confounded, because its control cannot fail.
