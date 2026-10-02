> The 12-tool surface, the channel wire format, client-side gating conditions, and the progress keepalive.
>
> Extracted from `CLAUDE.md` (v7.64.0). Indexed in [`README.md`](./README.md).

# Channel Mode (v6.4.0+)

The MCP server supports a channel mode that enables async model sessions with push notifications.

## Architecture

Uses the low-level `Server` class (not `McpServer`) from `@modelcontextprotocol/sdk/server/index.js` to declare `experimental: { 'claude/channel': {} }` capability. The SDK's `assertNotificationCapability()` has no default case — custom notification methods like `notifications/claude/channel` pass through.

## Components (`packages/cli/src/channel/`)

- **SessionManager** — spawns the child, tracks lifecycle, enforces timeouts, owns stdin
- **StreamJsonReducer** — per-session state machine driven by the child's own NDJSON frames
- **ScrollbackBuffer** — in-memory ring buffer (2000 lines), holding recovered PROSE

### The transport: bidirectional stream-json over pipes

The child is spawned with, in this exact order:

```
claudish --model X -y --verbose --quiet -p \
         --output-format stream-json --input-format stream-json \
         --include-partial-messages --include-hook-events --replay-user-messages \
         --session-id <uuid> [caller flags…]
```

which reaches `claude` as `-p --output-format stream-json --input-format stream-json
--include-partial-messages --include-hook-events --replay-user-messages --session-id <uuid>
--verbose --dangerously-skip-permissions` (measured 2026-08-22, claude 2.1.239).

Three properties of that argv are load-bearing and each fails silently:

- **`--verbose` BEFORE `--quiet`.** claudish consumes `--verbose` as its own log-verbosity
  flag AND separately forwards a copy to `claude`, which hard-errors on
  `--print --output-format stream-json` without it. Reversed, every child narrates onto
  stderr. Same rule as `team-orchestrator.ts:957` ("ORDER IS LOAD-BEARING").
- **`-p` present, and followed by a FLAG.** Without it and without `--stdin`, `cli.ts:667`
  sees no positional prompt and launches the interactive picker. Unknown flags consume the
  next token as a value unless it starts with `-`.
- **`--stdin` ABSENT.** That is what opens the channel: nothing in claudish consumes fd 0,
  and `claude` is spawned `stdio: "inherit"`, so `proc.stdin` in `SessionManager` lands
  directly on `claude`'s fd 0 with no relay code. This is what makes `send_input` work —
  it never worked before, because the bytes went into an already-satisfied `readStdin` drain.

`RESERVED_CHILD_FLAGS` in `session-manager.ts` rejects a caller-supplied duplicate rather
than appending it; `create_session`'s `claude_flags` are otherwise passed through verbatim.
Two properties of that guard are themselves load-bearing:

- **The set is DERIVED from `buildChannelSpawnArgs`**, plus `RESERVED_FLAG_ALIASES` and
  `--stdin`. The hand-listed version drifted immediately: it had `--verbose` but not `-v`,
  and no `--model` at all — so `-v` walked past a guard built specifically to stop the
  `--verbose` collision, and `--model` could silently run a different model than
  `SessionInfo.model` reports. Every alias in that map is a spelling `cli.ts`'s own parser
  accepts (`--model`/`-m`, `--auto-approve`/`-y`, `--quiet`/`-q`, `--verbose`/`-v`,
  `-p`/`--print`). Anything added to the spawn argv is reserved automatically.
- **The match is EXACT-TOKEN, never a prefix** (long `--flag=value` is split first).
  `--print-argv`, `--model-opus`, `--model-sonnet` and `--agents` are all real, unrelated
  flags a `startsWith` guard would eat — and `--print-argv` is what the argv-ordering
  regression test uses.

**Deltas are consumed and discarded.** `--include-partial-messages` produces 20–60 k
`stream_event` frames per long session (5–14 MB). They reset a liveness watchdog and are
then dropped: storing them would evict all 2000 scrollback lines in seconds. Semantic
frames go to `<sessionDir>/events.jsonl`; recovered prose goes to the scrollback and
`output.log`; `get_output` returns prose, never raw NDJSON.

**Terminal state has to be earned.** `result.terminal_reason` / `is_error` /
`api_error_status`, cross-checked with `classifyRunOutput`. Exit 0 with no `result` frame,
or with zero output bytes, is `failed`. Terminal states are absorbing — a process exit can
never upgrade a verdict the timeout or cancel handler already recorded.

**The witness is scoped to the CURRENT turn.** `reducer.beginTurn()` runs on every frame
written to the child's stdin and clears `sawResult` / `resultIsError` / `apiErrorStatus`
(cumulative accounting is untouched). Without it the witness latches for the life of the
session: turn 1 answers, `send_input` starts turn 2, the child dies mid-turn and exits 0 —
and turn 1's `result` marks turn 2 completed. That is the original bug's shape, a session
reporting success on evidence that does not belong to it.

**Finalisation waits for the pipes, not for `exit`.** `exit` fires BEFORE stdout closes,
and the `result` frame is by construction the LAST line the child writes — so it is exactly
the frame still in flight at that moment. `handleExit` therefore only records
code/signal/timestamp; `finalize()` runs when both stdio pipes have emitted `close`, or
after `DRAIN_TIMEOUT_MS` (10 s), whichever comes first. That constant used to live in
`team-orchestrator.ts` and be imported from here; it moved into `session-manager.ts` when
`team` stopped terminating children and therefore stopped needing to drain them
(see `team-lifecycle.md`). The channel is now its only user. Classifying on `exit` reported a
complete, billed run as *"exited 0 without ever emitting a terminal `result` frame"*,
nondeterministically. The stdio decoders are `StringDecoder`s for the same reason a chunk
boundary must not be trusted: `Buffer.toString` turns a multi-byte character split across
two reads into U+FFFD before the reducer ever sees the line.

**Persistence is redacted and bounded.** `events.jsonl` is `redactSecrets`-filtered per line
and capped at 4 MB (`{"type":"claudish_truncated"}` marks the cut); `stderr.log` is redacted
at write time; the in-memory stderr keeps 32 KB of HEAD plus 32 KB of TAIL — both ends,
because startup diagnostics like `[claude-code:unrecognized_model]` are at the head and the
failure that killed a long run is at the end. These files carry `user` turns and
`tool_result` blocks, and `get_diagnostics` names them for an agent to read.

**Terminal sessions are evicted.** `maxSessions` bounds only ACTIVE sessions, so finished
ones used to accumulate for the life of the MCP server. A terminal session leaves the map
after `terminalRetentionMs` (default 30 min), with a hard ceiling of 50 retained. On-disk
artifacts are unaffected.

**`shutdownAll` uses `terminateChildTree`, and never cancels an escalation it does not
replace.** Liveness is `exitCode`/`signalCode`, not `proc.killed` — `signalProcessTree` sets
`killed` the moment a signal is SENT, so a child that ignored SIGTERM (the only kind that
needs escalating) read as already dead and was skipped, while the pending SIGKILL from a
`cancel_session` five seconds earlier was cleared. The detached process GROUP kept running
and billing. Non-terminal sessions are settled `cancelled` BEFORE their reducer is disposed,
or the exit that follows writes a `meta.json` still claiming the session was running.

**`"timeout"` is now a first-class wire event — the record and the channel agree.**
They diverged until Phase 3: `EVENT_TO_TASK_STATUS` had no `"timeout"` key and fell
through to `?? "working"`, so emitting the real event reported a *dead* session as still
working. The timeout path therefore recorded `"timeout"` and emitted `"failed"`, and a
consumer watching only the channel could not tell "ran out of time" from "errored".
`["timeout", "failed"]` now exists in that map (SEP-1686 has no `timeout` member; `failed`
is its only honest projection), so `ChannelEventType === SessionStatus`, `LEGAL_TRANSITIONS`
has an absorbing `timeout` row, and `ReducerEvent.sessionStatus` — the override that carried
the divergence — is gone. **Mutation-proven**: remove the map key and a timed-out session
goes back to `status: "working"` on the wire.

**Session shape follows the prompt.** `create_session` WITH a prompt is one-shot: stdin is
closed on the first `result`, the session is `finishing` until the child exits 0, then
`completed`. WITHOUT a prompt it is interactive: stdin stays open, the session is in
`waiting_for_input` from creation and again between turns, and it ends on `send_input` → …
→ `cancel_session` or the timeout. A `send_input` call converts a one-shot session to
interactive.

**`waiting_for_input` means a real wait, and nothing else.** It holds iff claudish holds the
child's stdin open and the child has finished a turn no `send_input` has followed yet, or a
promptless session has received no input yet. Before `finishing` existed, every `result` frame moved the
reducer there, including a one-shot's last one, and `handleResult` closed stdin a moment
later — so every one-shot session emitted an `input_required` nothing could answer. The turn
end is now the OWNER's decision: `StreamJsonReducerOptions.onResult` is required and returns
`TurnEnd` (`"stdin-open" | "stdin-closed"`), and `applyResultFrame` asks it BEFORE
transitioning, to `waiting_for_input` or to `finishing`. `finishing` (non-terminal) admits
only terminal successors; a late `assistant`/`user` frame there is refused and recorded as an
anomaly (`get_diagnostics`). It projects to SEP-1686 `working`, and `checkStall` leaves it
unwatched — the session timeout bounds it. `team` closes stdin at spawn, so its reducer
always answers `"stdin-closed"`: a slot reads `finishing` between its `result` and its exit.
A promptless session enters `waiting_for_input` through `awaitInput()` at creation; its
`system:init` frame does not move it, and `beginTurn()` (every `writeFrame`) moves it to
`running`.

### `waits.jsonl` — the wait log

`<sessionDir>/waits.jsonl` gets one line per transition INTO `waiting_for_input` and one per
transition OUT of it (terminal states included), written in the reducer callback that changes
the state:

```jsonc
{"wait":"open","since":"2026-10-02T10:03:12.000Z","turns":1}
{"wait":"closed","since":"2026-10-02T10:03:12.000Z","at":"2026-10-02T10:03:13.400Z","to":"running"}
```

`since` keys the wait (the `closed` line repeats it); `turns` is `turnsCompleted` at the
open. It is append-only because an observer polling the directory (the magus `claudish`
plugin monitor) must see a wait that opened and closed between two of its reads — a marker
file that exists only during the wait cannot give it that. `finalize` settles before
`writeArtifacts`, so a live writer never leaves an open wait beside a `meta.json`. One
`appendFileSync` of < 200 bytes per line; a write failure goes to stderr and loses only that
line; the file stops at 1 MB. A one-shot session never writes one.

### Diagnostics are captured unconditionally, and reachable from the API

Two sessions once ran 900 s of genuine billed work — 241 assistant messages, ~94 k output
tokens, 150 tool calls — and reported success with an empty output log. The whole
explanation was one line, written to `~/.claudish/sessions/<id>/stderr.log` and left there:
`[claude-code:unrecognized_model] {"model":"cx@gpt-5.6-sol"}`. No MCP tool returned it.
**A failure that has already happened cannot be re-run with `--debug`**, so nothing here is
opt-in.

- **`get_diagnostics(session_id, event_limit?)`** returns the redacted stderr, the upstream
  error bodies, the tail of the semantic-event ring, the token/cost record, `exitCode` /
  `terminalReason` / `outputBytes` / `elapsedSeconds` / `timeoutSeconds`, the resolved
  transcript path, **both halves of the model chain** (`model` as asked for, `spawnModel` as
  pinned), and the paths to the full records.
- **stderr follows team's success/failure split, not one rule.** `meaningfulStderr` drops
  `[claude-code:unrecognized_model]` as benign boilerplate — and that line was the ENTIRE
  content of the incident. So it is applied only to a clean `completed`; every other status
  returns the RAW stderr, redacted. Same distinction `team-orchestrator.ts:532` already
  documents: the filter decides whether to write a SUCCESS-path log, a genuine failure keeps
  the boilerplate because there it is the context. `stderrFiltered` says which rule ran.
- **`outputBytes` counts the CHILD's prose only.** `recordNote` exists so claudish's own
  `[claudish] …` failure annotation does not inflate the metric that proves a session
  produced nothing — measured, it read 312 B for a 0-byte session before the split.
- **The event ring is in memory, not read back off disk.** 200 frames × 800 chars, labelled
  `type:subtype`, redacted once and shared with `events.jsonl`. It keeps filling after the
  4 MB file cap, because the frames just before a death are the ones a post-mortem wants.

### `transcriptPath` — realpath, or it is wrong

Claude Code writes an authoritative JSONL transcript at
`~/.claude/projects/<slug of cwd>/<session-uuid>.jsonl`. claudish mints that uuid and passes
it as `--session-id`, then confirms it from `system:init`, so the filename is derived, never
searched for by mtime. `transcriptPathFor` (in `session/session-discovery.ts`, which owns
the layout) is the only `realpathSync` in the repo and it is load-bearing: macOS `tmpdir()`
is `/var/…` → `/private/var/…` and a worktree can be reached through a symlink too, so the
slug of the path we *spawned* with names a directory that does not exist. That is literally
how the incident's transcripts were declared missing — they were under the session's own
`work_dir`, in a project directory nobody looked in. The child's `system:init.cwd` wins when
present (Node has already resolved it); the spawn cwd is the pre-init fallback, which is
exactly the window a startup failure lands in.

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

## MCP Tools (13 total)

- **Low-level** (4): `run_prompt`, `list_models`, `search_models`, `compare_models`
- **Agentic** (3): `preflight`, `team`, `report_error`
- **Channel** (6): `create_session`, `send_input`, `get_output`, `cancel_session`,
  `list_sessions`, `get_diagnostics`

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

The tool list is pinned by an EXACT frozen array in `channel/e2e-channel.test.ts`, so
adding or removing a tool without updating that test fails CI. That is deliberate:
it is a wire contract, and an accidental change to the tool surface should be loud.

Tool gating via `CLAUDISH_MCP_TOOLS` env var: `all` (default), `low-level`, `agentic`, `channel`.

## Tool Registration Pattern

Uses a `ToolDefinition[]` registry with raw JSON Schema (not Zod). Two `setRequestHandler` calls replace McpServer's ergonomic API:
- `ListToolsRequestSchema` → returns filtered tool list
- `CallToolRequestSchema` → dispatches to handler by name

## Channel Notifications

`server.notification({ method: "notifications/claude/channel", params: { content, meta } })` — pushed by SessionManager's `onStateChange` callback on state transitions. The method, capability, and params shape match Anthropic's [Channels reference](https://code.claude.com/docs/en/channels-reference) byte-for-byte.

The wire format is contractually pinned by `channel-wire-format.test.ts`:

```json
{
  "method": "notifications/claude/channel",
  "params": {
    "content": "<string>",
    "meta": {
      "session_id": "<8-char hex>",
      "event": "starting|running|tool_executing|waiting_for_input|finishing|completed|failed|cancelled|timeout",
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

When rendered by Claude Code, each notification arrives in the agent's context as:

```
<channel source="claudish" session_id="…" event="…" model="…" elapsed_seconds="…">
<content here>
</channel>
```

`meta` keys must match `[a-zA-Z0-9_]+` — Claude Code silently drops keys with hyphens or other characters. Our schema uses underscore-only keys (`session_id`, `elapsed_seconds`, etc.); when adding new `extraMeta` keys via `StreamJsonReducer`, keep this constraint.

The `task_id` / `status` / `created_at` / `last_updated_at` fields are SEP-1686 (MCP Tasks) forward-compatibility — additive only, no current consumer behavior change. The 8-value `event` collapses to the 5-value `status` per `EVENT_TO_TASK_STATUS` in `mcp-server.ts`; **every member of `SessionStatus` must have a key there**, because `mapEventToTaskStatus` falls through to `?? "working"` and a missing key silently reports a finished session as running. When Claude Code ships `notifications/tasks/status` receiver support, the migration is a method-name swap + payload restructure; see `ROADMAP.md` (Channel notifications → Phase 2) and `ai-docs/sessions/dev-research-mcp-tool-progress-20260508-235612-8d9da3e8/sep-1686-migration-schema.md` (write-up lost — predates the ai-docs tracking fix) for the full plan.

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

Two diagnostic scripts:
- `packages/cli/src/channel/test-helpers/channel-diagnostic.ts` — drives the MCP server with raw JSON-RPC against the OpenRouter free model. Confirms the producer→bridge→wire pipeline.
- `packages/cli/src/channel/test-helpers/client-diagnostic.ts` — spawns `claude -p` against the instrumented MCP server and compares what the server sent vs. what the client surfaced. Useful for diagnosing client-side gating.
- `packages/cli/src/channel/test-helpers/claudish-mock.ts` — a standalone mock MCP server that exposes a single `start_mock_session` tool, then emits a scripted sequence of 6 channel notifications over ~9 seconds. Decouples channel-rendering tests from real-model behavior.

## Testing

```bash
bun test --cwd . ./packages/cli/src/channel/*.test.ts
```

Five files: scrollback-buffer, session-manager, stream-json-reducer, e2e-channel, channel-wire-format. (`signal-watcher.test.ts` was deleted with the module it covered.) The wire-format tests run without an API key by using the fake-claudish PATH shim, so they execute on every CI run.

`session-manager.test.ts` carries seven mutation-proven regression guards, G1–G7: the timeout's status, the module-load signal exit codes (143/130), the reserved-flag rejection, the `--verbose`-before-`--quiet` argv order with a valueless `-p`, the delta firehose never reaching scrollback, and a promptless session reaching a usable state. Its fixtures replay real captured Claude Code 2.1.239 frames (`test-helpers/captured-stream-json.ts`), and its child (`test-helpers/fake-channel-stream-json.ts`) speaks bidirectional stream-json.

**The tool list is pinned twice, and adding a tool must break both.** `e2e-channel.test.ts` freezes the full 13-name list and the channel-only 6, deliberately: that list is a wire contract and an accidental change to it should be loud. `get_diagnostics` broke both pins on the way in, which is the guard working.

E2E tests use `--strict-mcp-config --bare --dangerously-skip-permissions` for isolation. SessionManager tests point child spawns at the tree under test via `CLAUDISH_BIN` (`spawn-claudish.ts`), never at the installed binary.

**`--bare` defers the MCP connection past `system/init` — do not assert MCP discovery under it.** Measured 2026-08-01 with a 20-line dependency-free stdio MCP server, so this is Claude Code behaviour, not a claudish one:

| flags | `system/init` `mcp_servers` | MCP tools in the init `tools` array | what the model did |
|---|---|---|---|
| `-p --strict-mcp-config --bare` | `status: "pending"` | none | two `Bash` calls first, then *sometimes* the MCP tool |
| `-p --strict-mcp-config` | `status: "connected"` | present | `ToolSearch` → the MCP tool |

Under `--bare` the tools are not in the model's toolset when it decides what to do, so it improvises with `Bash` — with the real claudish server it answered *"I don't have access to a tool called `mcp__claudish__list_models`. My available tools are `Bash`, `Edit`, and `Read`."* Any test asserting that a tool was DISCOVERED or CALLED must drop `--bare`; `--strict-mcp-config` alone still restricts MCP to the temp config, which is the isolation that matters. Keep `--bare` for tests that only drive the server directly over JSON-RPC.

Assert on the protocol, never on prose: `--output-format stream-json --verbose` exposes the `init` server status, the `tools` array, and the `tool_use`/`tool_result` pair. An assertion like `stdout.includes("Recommended Models")` passes for the wrong reason — it matched output the model produced via `Bash` while MCP discovery was silently broken. Also `proc.stdin.end()` on the spawned `claude`, or every run stalls 3s on "no stdin data received".

## The `notifications/progress` keepalive (`mcp/progress-heartbeat.ts`)

Claude Code aborts a tool call that puts nothing on the transport for its idle window — `MCP server "plugin:claudish:claudish" tool "team" sent no response or progress for 1800s; aborting`. Measured 2026-08-14 on **2.1.231** with three tools of identical 90s duration against a 30s window (`ai-docs/reports/mcp-progress-keepalive/findings.md`):

| Tool emits every 10s | Outcome |
|---|---|
| nothing | aborted at 30s |
| `notifications/progress` | survived 90s |
| `notifications/claude/channel` | aborted at 30s |

Channel and progress are **complementary, not alternatives**: channel is the visible surface with no keepalive, progress is the invisible keepalive — it still renders nowhere. A tool that blocks for minutes needs both.

**`heartbeat: true` is set on exactly three tools**: `team`, `run_prompt`, `compare_models`. `create_session` deliberately does NOT carry it — it returns in milliseconds with `{session_id, status:"starting"}` and cannot reach the idle timer; the session's own long life is reported over channel frames, which is a different question.

**The emitter is TIME-driven, not event-driven**, and that is the load-bearing choice. `team` already emitted a channel frame on every state change and still died at exactly 1800s, because a model that thinks for 30 minutes produces no state changes — an event-driven emitter goes silent precisely while the idle timer is counting.

Interval defaults to 10s (the measured-working value), overridable with `CLAUDISH_MCP_PROGRESS_INTERVAL_MS`, clamped to `[1000, 60000]`, garbage → default. Resolved once per server, not per call, so a long session cannot change cadence mid-flight. The first frame lands at t+interval, so a 200ms call stays completely silent.

**An absent or invalid `progressToken` degrades to `NOOP_HEARTBEAT`** — a shared frozen handle: no timer, no frame, no warning, no throw. The token is optional in the spec, so a host that omits it has not misbehaved, and a tool call must never fail because its keepalive could not arm. (2.1.231 does send it — observed value `2` in every probe arm. `anthropics/claude-code#58687`, which reports the client sends no `_meta.progressToken`, is STALE.)

**`stop()` latches; `clearInterval` alone would not be enough.** The dispatch owns start and stop in a `finally`, and `stopped` is re-checked at the top of `emit`, so a tick already queued on the macrotask queue when the response was computed is dropped instead of reaching the wire after its own response — the `GLips/Figma-Context-MCP#362` teardown pattern, where a frame arriving after the client cleaned up its token tears down stdio.

**Idle-window defaults, for sizing any test or config**: 30 min on stdio, 5 min on HTTP/SSE/WS. A per-server `timeout` (ms, ≥1000) in `.mcp.json` floors it for that server only; `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0` disables the check entirely. **Undocumented floor worth knowing**: values below ~30s are silently ignored by the client — `1000` and `5000` were (a silent 20s call survived a nominal 5s window), `30000` was honoured exactly. Any test using a shorter window is confounded, because its control cannot fail.
