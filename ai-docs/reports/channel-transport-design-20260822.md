# Channel sessions: architecture alternatives

> Scope: `packages/cli/src/channel/` + the 5 channel tools in `mcp-server.ts`.
> Everything below was verified against this tree and against `claude` 2.1.239 on this
> machine on 2026-08-22. Claims I could not verify are marked **UNVERIFIED**.
> Reproduction scripts: `./probes/`.

---

## 0. Verification log — what changed after checking

Three of the briefing's premises survived, one was wrong, and one new fact reframes the
whole decision. Read this section before the alternatives; it moves the answer.

| Premise | Verdict |
|---|---|
| Channel spawns `--model X -y --stdin --quiet`, no `--output-format` | **Confirmed** — `session-manager.ts:85-92` |
| `--stdin` forces non-interactive → `-p` is pushed | **Confirmed** — `cli.ts:366-367`, `cli.ts:667-669`, `claude-runner.ts:1228-1230` |
| `TOOL_PATTERNS` match TUI `⏺` glyphs unreachable in print mode | **Confirmed** — `signal-watcher.ts:16` |
| `turnsCompleted` / `tokensUsed` initialised 0 and never written | **Confirmed** — `session-manager.ts:146-147`; no other assignment exists in the file |
| `EVENT_TO_TASK_STATUS` has no `"timeout"` key → falls to `?? "working"` | **Confirmed but harmless** — `mcp-server.ts:1525-1536`. `"timeout"` is *never emitted*: `session-manager.ts:225-227` sets `info.status = "timeout"` and then immediately calls `watcher.forceState("failed")`, whose callback (`session-manager.ts:116`) overwrites it in the same tick. The missing key is dead code, not the bug. |
| `team` grid = magmux PTY panes over a Unix socket | **Confirmed** — `team-grid.ts:225-347`, magmux 0.8.1 present at `/opt/homebrew/bin/magmux` |
| **"NO transcript exists for the two real failures"** | **FALSE.** See §1.3. Both transcripts exist, are 1.3 MB and 823 KB, and contain 432 and 299 events. |
| `bin/claudish.cjs` orphans children on SIGTERM (repo memory says UNFIXED) | **Stale memory — it is fixed.** `bin/claudish.cjs:120-166` forwards SIGINT/SIGTERM/SIGHUP and re-raises the child's signal. |
| `-p` means `--profile` in claudish (`team-orchestrator.ts:832`) | **Stale comment.** Only `--profile` is claimed (`cli.ts:379`). A bare `-p` falls into the passthrough branch at `cli.ts:640-646`, sets `_hasPrintFlag`, and reaches `claude`. This matters: it is what makes Alternative A spawnable today. |

**The new fact:** `claude` 2.1.239 ships `--input-format stream-json`,
`--include-partial-messages`, `--include-hook-events`, `--replay-user-messages` and
`--session-id <uuid>`. I ran them. All four work together over plain pipes, with no PTY.
This removes the only reason magmux was ever a candidate for channel sessions.

---

## 1. Root cause — the 900s silent success, exactly

### 1.1 The chain

```
create_session
  └─ spawn: claudish --model X -y --stdin --quiet          session-manager.ts:85-92
       └─ --stdin ⇒ interactive=false                      cli.ts:366-367, 667-669
            └─ readStdin() drains fd 0 to EOF,
               PREPENDS the text as claudeArgs[0]          index.ts:836-843
                 └─ claude-runner pushes -p                claude-runner.ts:1228-1230
                      └─ spawn claude, stdio:"inherit"     claude-runner.ts:1506-1512
                           └─ claude -p <prompt>
                                → prints ONLY the final assistant message, at the very end
```

Print mode is silent for the entire run, so:

* `SignalWatcher.feed` is never called → state stays `starting`
  (`signal-watcher.ts:45-78`). `running`, `tool_executing`, `waiting_for_input` are
  unreachable. `send_input` gates on `["starting","running","waiting_for_input"]`
  (`session-manager.ts:243`) so it is *nominally* callable in `starting` — but the bytes
  land in `readStdin`'s already-satisfied drain, not in `claude`. It does nothing.
* `output.log` is a `createWriteStream` opened at creation (`session-manager.ts:135`) and
  closed at exit (`session-manager.ts:194`). **0 bytes is real**, not truncation.

At the 900 s deadline:

```
timeout fires                                              session-manager.ts:214-229
  signalProcessTree(proc,"SIGTERM")                        → process GROUP
  info.status = "timeout"                                  :225
  watcher.forceState("failed")  ── callback ──▶ info.status = "failed"   :116   ← clobber #1
      │
      └─ SIGTERM reaches claudish's own handler
           claude-runner.ts:1584-1608 →  proc.kill(); …;  process.exit(0)        ← THE BUG
                └─ launcher sees code=0, signal=null → process.exit(0)   bin/claudish.cjs:164
                     └─ proc.on("exit", 0)                 session-manager.ts:181
                          info.exitCode = 0                :182
                          watcher.processExited(0)         :191
                            guard is `if (_state === "cancelled") return`  signal-watcher.ts:84
                            "failed" is NOT guarded → exitCode===0 → transition("completed")
                              ── callback ──▶ info.status = "completed"          ← clobber #2
                          writeFileSync(meta.json)         :202   ← the lie becomes durable
```

**`claude-runner.ts:1608` is the single line that manufactures the false success.** A
graceful-shutdown handler exits 0 for a run that was *killed*. Note the asymmetry:
`cancelSession` forces state `"cancelled"`, which *is* guarded at `signal-watcher.ts:84`,
so **cancel reports honestly and timeout lies.** That is why the bug looks intermittent.

### 1.2 The artifacts match, byte for byte

`~/.claudish/sessions/1084c4a8/meta.json`:

```json
{ "sessionId":"1084c4a8","model":"gpt-5.6-sol","status":"completed","pid":55477,
  "startedAt":"2026-08-21T14:34:53.759Z","completedAt":"2026-08-21T14:49:53.729Z",
  "exitCode":0,"turnsCompleted":0,"tokensUsed":0,"elapsedSeconds":900 }
```

`output.log` — 0 B. `stderr.log` — **one line, 81 bytes**:

```
[claude-code:unrecognized_model] {"model":"cx@gpt-5.6-sol","query_source":"sdk"}
```

`~/.claudish/sessions/0da0d868/` is identical with `kimi-k3` / `kc@k3`.

That stderr line is the only diagnostic either session produced, and **the MCP API exposes
`entry.stderr` nowhere.** `getOutput` returns scrollback only (`session-manager.ts:255-289`);
`listSessions` / `getSession` return `SessionInfo`, which has no stderr field
(`channel/types.ts:22-33`). It is written to `stderr.log` on disk
(`session-manager.ts:197-199`) and that is the end of it. Requirement 4 fails at the *API*
boundary, not just the capture boundary.

### 1.3 The transcripts DO exist — and they are the indictment

The briefing's counter-fact is wrong. Both transcripts are on disk, in the project directory
for the session's `work_dir` (a **magus** worktree, not claudish — which is why a search of
claudish's project dir found nothing):

```
~/.claude/projects/-Users-jack-mag-magus-magus-src--claude-worktrees-style/
  5aba8f1f-f323-4927-9c90-3e65787fa725.jsonl   1,320,401 B   432 events
  6250c4b6-5f65-486f-bf37-4d11360fde3e.jsonl     822,801 B   299 events
```

They match on timestamp to the second, on `entrypoint:"sdk-cli"`, and on model:

| | session `1084c4a8` | session `0da0d868` |
|---|---|---|
| session window | 14:34:53.759 → 14:49:53.729 Z | 14:35:05.865 → 14:50:05.828 Z |
| transcript window | 14:34:54.533 → 14:49:53.734 Z | 14:35:06.970 → 14:49:54.836 Z |
| model in transcript | `gpt-5.6-sol` | `k3` |
| assistant messages | **152** | **89** |
| tool calls | **93** (Bash 41, Read 35, TaskCreate 5, TaskUpdate 6, TaskOutput 3, Agent 1, Skill 2) | **57** (Bash 49, Read 7, mnemex 1) |
| output tokens | **68,529** | **25,366** |
| billed input tokens | **19,884,143** | 6,292,256 (5,805,824 cache-read) |
| reported by claudish | `turnsCompleted:0, tokensUsed:0, status:"completed"` | same |

**Fifteen minutes of real, billed, tool-using work — 93 tool calls and 68 k output tokens —
reported as a completed session with zero tokens and an empty answer.** Nothing was lost
upstream. It was lost at the capture layer, and then relabelled a success.

### 1.4 A fifth bug, currently unreachable-by-luck

`create_session`'s schema documents `prompt` as optional: *"If omitted, send later via
send_input"* (`mcp-server.ts:1327`). But `session-manager.ts:175-178` only writes and
`.end()`s stdin **when a prompt is present**. With no prompt, `readStdin`
(`index.ts:517-523`, a `for await` over `process.stdin`) never sees EOF and never resolves —
claudish never even starts the proxy. The session sits in `starting` until the timeout, and
`send_input` cannot rescue it because a write without EOF still does not terminate the drain.
**The documented "send later" workflow has never been able to work.**

---

## 2. What is already in the tree and reusable

Naming these up front, because three of the five alternatives are mostly assembly.

| Asset | Where | Gives you |
|---|---|---|
| `createAssistantTextCapture()` | `team-stream-capture.ts:112` (header `:1-54`) | streaming stream-json → prose reducer, **degrades per-line** to verbatim passthrough on unrecognised JSON (`:65`). Battle-tested against the exact print-mode dropout. |
| `classifyRunOutput()` | `team-orchestrator.ts:315-450` | "exit 0 has to earn it" — `api_error`, `background_task_ceiling`, `empty_output`, `shape_mismatch`, with capture-mode-aware explanations |
| `meaningfulStderr()` | `team-orchestrator.ts:456-465` | strips benign stderr noise |
| `persistErrorLog()` + `redactSecrets()` | `team-orchestrator.ts:478-495`, `redact.ts` | bounded, redacted diagnostic file |
| `STDOUT_TAIL_LIMIT` | `team-orchestrator.ts:257` | 4 000 B bounded tail convention |
| `CLAUDISH_TOKEN_FILE` | `claude-runner.ts:1274`, `token-tracker.ts:437-445` | **per-child token/cost/tool-call file, live-rewritten on every update.** Requirement 5 is an env-var away. |
| `readSessionStats()` / `SessionStats` | `session-stats.ts:36-105` | tokens, cost, `isEstimated`, `contextUsed`, **`toolCalls: {name,count}[]`**, `billedInputTokens`, savings |
| `toolCallsByName` | `token-tracker.ts:74,113,119,125` | the proxy already counts every tool call it proxies |
| `signalProcessTree` / `terminateChildTree` | `process-tree.ts:57-108` | group SIGTERM→SIGKILL. Requirement 6's hard part is solved. |
| `session-discovery.ts` (898 ll.) | `PROJECTS_DIR :31`, `slugForPath :44`, `sessionsIn :202-235` | transcript location, bounded head/tail reads, `entrypoint` classification |
| `captureUpstreamError` | `composed-handler.ts:777-785` | durable upstream error body, **opt-in via `CLAUDISH_UPSTREAM_ERROR_LOG`, no-op otherwise** |
| `wrapStateChange` / `installWireTap` | `channel/diagnostics.ts` | producer→bridge→wire tracing under `CLAUDISH_CHANNEL_TRACE=1` |

Requirement 5 deserves emphasis: **claudish is the proxy.** It sees every request and every
response. Token, cost and tool-call accounting does not depend on parsing anything the child
prints. `session-manager` simply never sets `CLAUDISH_TOKEN_FILE` and never reads the file back.

---

## 3. Measured facts about `claude` 2.1.239 (this machine)

### 3.1 Print mode writes a full transcript, with no flag

Probe: `claude -p "reply with exactly: OK" --output-format stream-json --verbose` in
`/tmp/cc-transcript-probe`, no PTY, stdout piped. Result: a **49,197 B** transcript at
`~/.claude/projects/-private-tmp-cc-transcript-probe/9cdc44bf-….jsonl`.

**Gotcha:** the slug came from the **realpath** (`/private/tmp/…` → `-private-tmp-…`), not the
logical cwd. `slugForPath` (`session-discovery.ts:44`) is `absPath.replace(/[/.]/g,"-")` with
**no `realpathSync` anywhere in the repo** (grepped). Any transcript-locating code that
slugs `opts.cwd` will miss on macOS `/tmp`, and on every symlinked worktree.

### 3.2 Bidirectional stream-json over pipes works

`probes/probe-bidirectional-stream-json.mjs` — one `claude` process, stdin held open, two
turns sent 20 s apart, then `stdin.end()`:

```
claude -p --session-id <uuid> --output-format stream-json --input-format stream-json \
       --include-partial-messages --include-hook-events --replay-user-messages --verbose \
       --dangerously-skip-permissions
```

Input frame (verified accepted):

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Say exactly: ALPHA"}]}}
```

Output over 42,747 B / 31 lines:

| frame | n | carries |
|---|---|---|
| `system:init` | 2 | `cwd`, `session_id`, full tool list (~18 KB — the bulk of fixed overhead) |
| `system:status` | 2 | `{"status":"requesting"}` — a **first-party liveness signal** |
| `system:hook_started` / `hook_response` | 3 / 3 | `hook_name`, `hook_event`, `exit_code`, `outcome` |
| `stream_event/message_start` | 2 | model id, `usage`, `ttft_ms` |
| `stream_event/content_block_delta` | 4 | live text deltas |
| `assistant` | 2 | complete message + per-message `usage` |
| `user` | 2 | replayed input (`isReplay:true`) and, in probe 2, `tool_result` |
| `result:success` | 2 | `is_error`, `num_turns`, `stop_reason`, **`total_cost_usd`**, full `usage`, `permission_denials`, **`terminal_reason`**, `api_error_status`, `result` |
| `rate_limit_event` | 1 | window status, `resetsAt` |

Exit 0 after `stdin.end()`. **`send_input` over pipes is a solved problem.**

### 3.3 `--include-hook-events` reports *configured* hooks only

`probes/probe-tool-turn-hook-events.mjs` ran a real `Bash` tool call. Observed sequence:

```
hook_started → hook_response → system:init → system:status →
message_start → … → assistant(tool_use) → … → user(tool_result) → system:status →
message_start → … → assistant(text) → … → hook_started → hook_response → result:success
```

**No `PreToolUse` / `PostToolUse` frames.** `~/.claude/settings.json` declares exactly
`{SessionStart: 1, Stop: 1}` and exactly those two fired. So the flag surfaces the lifecycle
of hooks *you have configured*; it does not synthesise a lifecycle. This corrects the
briefing's assumption. It is not a loss: `tool_use` / `tool_result` are already in the
`assistant` / `user` frames, at higher fidelity than a hook payload.

### 3.4 `--session-id <uuid>` kills the transcript-discovery race

`--session-id <uuid>  Use a specific session ID for the conversation (must be a valid UUID)`
(`claude --help`). Claudish can mint the UUID, so it knows the transcript filename **before
spawn** — no cwd+mtime guessing, no race, no `slugForPath` dependency for the filename (still
needed for the directory, see §3.1). `system:init` also carries `cwd` + `session_id`, so the
directory can be derived from the child's own report rather than assumed.

### 3.5 What does not exist

* **No `--permission-prompt-tool`.** Grepped `claude --help`; only `--permission-mode`
  (`acceptEdits|auto|bypassPermissions|manual|dontAsk|plan`) and the two
  skip-permissions flags. Delegating a permission prompt to an MCP tool is an **Agent SDK**
  capability (`canUseTool`), not a CLI one. Moot today — the channel always passes `-y`
  (`session-manager.ts:88`) — but it caps how "interactive" a pipe-mode session can ever be.
* **`Notification` hook behaviour on input-wait: UNVERIFIED.** I did not probe it. In the
  bidirectional design it is moot: the `result` frame *is* the turn boundary, and
  "result received + stdin still open" is an exact `waiting_for_input`, not a heuristic.

### 3.6 Volume

Measured delta frame: 239 B of envelope for a 3-character payload. Envelope is ~200 B fixed
(`session_id` 36 + `uuid` 36 + type strings). Anchoring on the real session A (68,529 output
tokens, 1.3 MB transcript):

| stream shape | est. bytes for session A |
|---|---|
| `-p` text (today) | ~0 (final message only; here, 0) |
| stream-json, no partials | ~1.3 MB (≈ transcript size) |
| stream-json **+ partials** | **~5–14 MB** (20–60 k delta frames × ~230 B) |

Fixed per-session cost is ~18 KB (`system:init`'s tool list), paid once.

---

## 4. The alternatives

Common notation for requirements: **1** progress visibility · **2** working `send_input` ·
**3** honest terminal state · **4** bounded redacted discoverable diagnostics without
`--debug` · **5** real token/cost accounting · **6** whole-tree cancellation · **7**
headless/CI-safe and concurrency-safe.

---

### Alternative A — bidirectional stream-json over pipes

**Approach.** Keep the pipe topology exactly as it is. Change the argv and stop closing
stdin. Replace `SignalWatcher`'s regex machine with a line-delimited JSON event reducer.

```
claudish --model X -y --quiet -p --verbose \
         --session-id <uuid> \
         --output-format stream-json --input-format stream-json \
         --include-partial-messages --include-hook-events --replay-user-messages
```

Two things make this cheap that are not obvious:

* **`--stdin` must be dropped, and that is what opens the channel.** Without it,
  `readStdin` (`index.ts:836`) never runs, so nothing in claudish consumes fd 0. And
  `claude` is spawned `stdio:"inherit"` in non-interactive mode
  (`claude-runner.ts:1506-1512`), through a launcher that is also `stdio:"inherit"`
  (`bin/claudish.cjs:110`). **The SessionManager's `proc.stdin` pipe therefore reaches
  `claude`'s fd 0 directly, with zero relay code in claudish.**
* **`-p` must be passed explicitly**, or `cli.ts:667` flips `interactive = true` (no
  positional prompt, no `--stdin`) and launches the picker. `-p` sets `_hasPrintFlag`
  (`cli.ts:643`) and passes through; `claude-runner.ts:1228` dedupes it. Ordering caveat:
  `cli.ts:647-649` swallows the next token as a value if it does not start with `-`, so
  `-p` must be followed by another flag.
* Unknown flags pass through with their values (`cli.ts:640-649`), and `--verbose` is
  force-forwarded in non-interactive mode (`cli.ts:673-686`) — which `claude` *requires*
  alongside `--output-format stream-json`. `team-orchestrator.ts:834-843` already relies on
  this exact interaction and documents the load-bearing arg order.

**Components.**

```
SessionManager
 ├─ spawn (unchanged topology, new argv, detached:KILL_PROCESS_GROUP)
 ├─ StreamJsonReducer            ← replaces SignalWatcher
 │    stdout lines ─▶ JSON.parse ─▶ switch(type)
 │      system:init          → record cwd + session_id; state:"running"
 │      system:status        → liveness tick (renew watchdog)
 │      stream_event/*delta  → liveness tick ONLY (never stored)
 │      assistant            → append text to answer; count tool_use; state:"tool_executing"
 │      user(tool_result)    → state:"running"
 │      result               → turnsCompleted, tokensUsed, costUsd, terminal_reason,
 │                             is_error, permission_denials; state:"waiting_for_input"
 │      unparseable line     → verbatim to diagnostics (per-line degradation, as
 │                             team-stream-capture.ts:41-54)
 ├─ AnswerBuffer      (createAssistantTextCapture, reused verbatim)
 ├─ EventRing         (bounded, semantic events only — NOT deltas)
 ├─ Diagnostics       (bounded tail + redactSecrets + persistErrorLog)
 └─ TokenFile         (CLAUDISH_TOKEN_FILE → readSessionStats)
```

**Data flow.**

```
orchestrator ──create_session──▶ SessionManager ──argv──▶ claudish ──inherit──▶ claude
                                        ▲                                          │
      send_input ──{"type":"user",…}────┘ (proc.stdin, kept OPEN)                  │
                                                                                   │
   channel notifications ◀── StreamJsonReducer ◀── NDJSON on stdout ◀───────────────┘
   get_output            ◀── AnswerBuffer + EventRing
   get_diagnostics       ◀── Diagnostics + tokenfile
```

**Requirements.**

| # | Verdict |
|---|---|
| 1 | **Full.** `system:status`, per-delta ticks, `assistant` tool names, per-turn `result`. Sub-second granularity. |
| 2 | **Full.** Measured working (§3.2). Stdin stays open; frames are `{"type":"user",…}`. `--replay-user-messages` gives an ack. |
| 3 | **Full and first-party.** `result.terminal_reason`, `result.is_error`, `result.api_error_status`, `result.stop_reason`, `result.permission_denials`. Exit code stops being the oracle. Plus the two one-line fixes in §6.1. |
| 4 | **Good.** Every event is structured, bounded via `STDOUT_TAIL_LIMIT`, redacted via `redactSecrets`, and exposed through a new `get_diagnostics` MCP tool — the API, not the filesystem. |
| 5 | **Full, twice over.** `result.usage` + `result.total_cost_usd` from the child, and `CLAUDISH_TOKEN_FILE` → `readSessionStats()` from the proxy. Cross-checkable. |
| 6 | **Already solved** by `signalProcessTree`, once `claude-runner.ts:1608` stops exiting 0. |
| 7 | **Best of all options.** Pipes; no sockets, no PTYs, no `/tmp` namespace, no external binary. |

**Failure modes.**

* *Reducer bug swallows the answer.* Mitigated by the per-line degradation rule from
  `team-stream-capture.ts:41-54`: only a line that is both valid JSON *and* carries a known
  `type` is treated as an event; anything else passes through verbatim. Never latch on the
  first line.
* *Scrollback thrash.* Deltas at ~20–60 k frames/session would evict all 2 000 lines of
  `ScrollbackBuffer` (`scrollback-buffer.ts:3-4, 17`; `session-manager.ts:39`) in seconds and leave a ring full of
  three-character text fragments. **Deltas must be consumed for liveness and discarded.**
  This is the one place the design can go badly wrong by accident.
* *`--include-partial-messages` bandwidth* — 5–14 MB/session (§3.6). Make it opt-in per
  session (`create_session.stream_partials`, default on: liveness is the whole point, and
  the bytes are consumed not stored).
* *`--input-format stream-json` changes prompt delivery.* The prompt is no longer a
  positional arg; it is the first frame. `claudishFlags` callers who relied on `--stdin`
  semantics break — but no external caller has that, `create_session` owns the argv.
* *A model that never ends a turn* still produces deltas, so the watchdog can distinguish
  "thinking" from "wedged" — which is precisely the 900 s case, and it becomes visible.

**Operational complexity.** Lowest of all options. One new module (~250 lines), one deleted
(`signal-watcher.ts`), no new process, no new IPC, no new dependency.

**Concurrency cost.** Per session: 3 pipes, one `claudish` tree, one JSON parse loop. At the
default `maxSessions = 20` (`session-manager.ts:38`): 60 fds, plus the ring buffers. If the
ring holds semantic events only (~200–500 per session at ~1 KB), that is ~10 MB total —
*less* than today's 2 000-line raw ring. Parse cost is the real load: 20–60 k
`JSON.parse` per session over 15 minutes ≈ 70 lines/s/session, 1 400 lines/s at 20 sessions.
Fine on Bun, but it is on the MCP server's event loop, which also serves tool calls. Worth a
`setImmediate` yield every N lines. **UNVERIFIED at 20× concurrency** — I measured single
sessions only.

**Migration / back-compat.**

| Surface | Impact |
|---|---|
| `SessionInfo` | Additive. `turnsCompleted`/`tokensUsed` finally get real values; add `costUsd`, `toolCallCount`, `terminalReason`, `claudeSessionId`. Existing consumers unaffected. |
| `get_output` | **Breaking if done naively.** Today it returns raw stdout. Fix: `output` keeps returning **prose** — `AnswerBuffer` (all assistant text, concatenated, exactly `team-stream-capture`'s contract), which is *strictly better* than today's final-message-only text. Add `format: "text" \| "events"` (default `"text"`) and an `events` array behind the opt-in. Callers see more content in the same field, never JSON they did not ask for. |
| `list_sessions` | Unchanged shape. |
| channel notifications | Unchanged wire format. The 7-value `event` enum is preserved; every value becomes *reachable* for the first time. `session-wire-format.test.ts` stays green. |
| `EVENT_TO_TASK_STATUS` | Unchanged. Add `["timeout","failed"]` for completeness once `"timeout"` can actually be emitted (§6.1). |

---

### Alternative B — magmux PTY panes

**Approach.** Replace the spawn with a magmux pane. `create_session` sends
`{"type":"open_pane","id":N,"cmd":"claudish --model X …","cwd":…}` over the socket;
`send_input` sends `{"type":"send","pane":N,"text":…}`; state comes from `snapshot` events;
terminal state from `exit` / `results`.

**What magmux actually gives us** (verified against 0.8.1's own `--help` and binary strings):

* `--headless` — *"no raw mode, no alternate screen, and not one byte on stdout. The socket
  is the whole interface."* Auto-enabled when stdin is not a terminal. So it is CI-safe.
* `--id NAME` → `/tmp/magmux-NAME.sock`, known before start. (`[A-Za-z0-9_-]`, **not
  all-digits** — the startup reaper treats those as pid sockets.)
* `{"type":"send","pane":0,"text":…}` — *"writes to a pane even when it is idle."* Real
  `send_input`.
* `open_pane` / `close_pane` / `focus` with `id`→`reply` correlation, and **permanent pane
  indices** (closing leaves a tombstone; ids go sparse and never move). That is exactly the
  dynamic lifecycle `create_session` needs, and it is a genuinely good protocol.
* `state ∈ completed|failed|awaiting_input|running`, plus `tool`, `exitCode`, `response`,
  `model`, `startedAt`/`completedAt`.

**Crucially, magmux is not a screen-scraper.** Its `ClaudeCodeController`
(`controller_claude.go`) reads the JSONL transcript: binary symbols include
`pollTranscript`, `TranscriptReader`, `findActiveSession`, `matchByPrompt`,
`discoveredSession`, `claude.jsonl`, plus `applyTerminalIdle` as a *fallback* and OSC
`777;notify`. Its own help text states the hierarchy outright: *"The screen is a rendering
and may lag, wrap or be mid-redraw; where the two disagree, the transcript above is what the
session actually said."*

**Requirements.**

| # | Verdict |
|---|---|
| 1 | Good — `snapshot` with `state` + `tool`, driven off the transcript. Granularity is a poll interval, not a token. |
| 2 | **Full** — `send`, with real keystroke semantics that also clear the pane's done-state. |
| 3 | Good — `awaiting_input` is a first-class state and `results` is authoritative. Still needs `withoutControlPanes()` discipline (`team-grid.ts:265-278`) and the arithmetic-luck bug it fixed is a standing warning. |
| 4 | Weak — magmux reports `response`, not diagnostics. stderr is interleaved into the pane. Claudish would still need its own capture. |
| 5 | **None from magmux.** Would still come from `CLAUDISH_TOKEN_FILE`. |
| 6 | Indirect — `close_pane {force:true}`, or kill magmux. Whether magmux kills the *whole tree* is **UNVERIFIED**; claudish's own `signalProcessTree` is no longer holding the pid. |
| 7 | Headless: yes (≥0.8.0). Concurrency: see below — this is where it hurts. |

**Failure modes.** A second process to supervise, and its liveness is now a dependency of
every session. `/tmp` socket namespace collisions (repo memory records a real cross-talk
incident where the helper latched onto a concurrent `claudish team` run's socket). Version
drift is a *measured* recurring failure: 0.7.0 added the control pane and reddened `main`
(one-extra-pane), 0.8.0 changed tty behaviour and reddened it again (`Received 0 events`)
— both within a day, both because CI installs magmux **unpinned**
(`brew install MadAppGang/tap/magmux`). Also: `team-grid.ts:485` still uses the pid socket
(`/tmp/magmux-${proc.pid}.sock`) rather than `--id`, so the hermetic path is available but
not taken in production.

**Operational complexity.** Highest. External binary resolution with three fallbacks
(`team-grid.ts:181-222`), socket retry loop (`:286-300`), a second protocol to version, and
a `withoutControlPanes` filter that exists solely to survive an upstream change.

**Concurrency cost.** Per session: 1 PTY master/slave pair, 1 pane with a
`MAGMUX_SCROLLBACK`-sized ring (default 1 000 lines), 1 transcript poller. Panes share one
magmux process and one socket if you multiplex, but **magmux refuses a layout that cannot
give every pane ≥3 rows × 20 cols — about 12 panes on an 80×24 geometry** (its own help).
Headless geometry comes from `COLUMNS`/`LINES` else 80×24, so **20 concurrent channel
sessions do not fit in one magmux under default geometry.** Options: raise `LINES` to a
fictional value (untested, **UNVERIFIED**), or run N magmux processes → N sockets, N
supervisors, N `/tmp` entries. Either way it is strictly worse than 60 file descriptors.

**Migration.** Largest. `SessionInfo.pid` becomes meaningless (or a magmux pid shared by all
sessions). Cancellation semantics change. Status mapping goes through a second enum
(`completed|failed|awaiting_input|running|panel`) before reaching claudish's seven and then
SEP-1686's five — three enums in a row, which is where `buildTeamStatus`'s
`default → TIMEOUT` (`team-grid.ts:387`) already silently mislabels anything unexpected.

---

### Alternative C — hybrid (stream-json for capture, magmux for presentation)

**Approach.** Pipes and stream-json are the source of truth; a magmux grid is an *optional
human viewport* attached when a person wants to watch. Two modes selected by a
`create_session` flag.

**Requirements.** Identical to A for 1–7, because A is the substrate. Adds a
human-watchable grid.

**Failure modes.** Two code paths that must agree on state, which is the classic hybrid tax:
the grid says `awaiting_input`, the reducer says `running`, and a bug report now needs both
traced. Repo precedent is not encouraging — `team` already has `print` and `stream-json`
capture modes and `classifyRunOutput` carries a `captureMode` parameter *purely to explain
the same verdict differently* (`team-orchestrator.ts:337-344, 408-420`).

**Operational complexity.** A's plus B's, minus nothing.

**Concurrency cost.** A's when the grid is off; B's when it is on.

**Migration.** A's, plus a mode flag.

**Verdict.** The presentation need is real but it belongs to `team`, which already has it
(`team-grid.ts`). A channel session's consumer is *an agent reading notifications*, not a
human watching a grid. Building this into the channel is paying B's cost for a `team` feature.

---

### Alternative D — transcript as source of truth + hooks as the event bus

**Approach.** Claudish parses no stdout for state. Hooks configured through the existing
`--settings` overlay POST lifecycle events to a claudish HTTP endpoint (the proxy server is
already listening); the JSONL transcript is the durable record for content, tokens and
diagnostics; stdout carries only the final answer.

**What is genuinely strong here.**

* The transcript is written **unconditionally** (§3.1) — strictly better than any opt-in
  capture, and better than `CLAUDISH_UPSTREAM_ERROR_LOG`, which is a documented no-op when
  unset (`composed-handler.ts:781-785`).
* Claudish already owns the injection point: `createTempSettingsFile()`,
  `buildClaudishSettingsOverlay()` (`claude-runner.ts:863, 884`), `mergeUserSettingsIfPresent`
  (`claude-runner.ts:907, 1204`), and the file is passed as `--settings` at
  `claude-runner.ts:1210` and unlinked at `:1560`.
* ~1 800 lines of transcript parsing already exist and are performance-shaped for it
  (`session-discovery.ts:1-20` documents 5 656 transcripts / 2.57 GB / 73.5 MB max, and the
  bounded 64 KB-head / 128 KB-tail rule that follows from it).
* §1.3 proves the transcript captured **everything** the two failed sessions did, when
  claudish captured nothing.

**Requirements.**

| # | Verdict |
|---|---|
| 1 | Partial. Hooks fire at coarse boundaries (`PreToolUse`, `Stop`); transcript polling adds latency and cost. No token-level liveness. |
| 2 | **None.** Hooks are inbound. `send_input` still needs an open stdin — i.e. it needs Alternative A anyway. |
| 3 | Good — the transcript has every message; a `Stop` hook is a real turn boundary. But a session killed before the transcript's final flush leaves ambiguity. |
| 4 | **Best of all options** for durability. Unconditional, complete, already on disk. |
| 5 | Good — per-message `usage` is in the transcript. But `CLAUDISH_TOKEN_FILE` already gives this without parsing anything. |
| 6 | Unchanged (`signalProcessTree`). |
| 7 | New HTTP endpoint, new hook fan-in, N pollers. Hook commands are shell-outs per event — real overhead at 93 tool calls/session × 20 sessions. |

**Failure modes.**

* **The slug is a landmine.** §3.1: Claude Code slugs the *realpath*; `slugForPath`
  (`session-discovery.ts:44`) slugs the string it is handed, and there is no `realpathSync`
  in the repo. `--session-id` fixes the *filename*, not the *directory*. Take `cwd` from the
  `system:init` frame (which means you need the stream anyway) or `realpathSync(opts.cwd)`.
* **Hook injection collides with user hooks.** `mergeUserSettingsIfPresent` must merge, not
  replace, and a user hook that exits non-zero can block a tool call. Injecting hooks changes
  the child's *behaviour*, which observation must not do.
* **Transcript write timing is not a contract.** Buffering, compaction and rotation are
  unspecified. Building the live state machine on it makes claudish's correctness depend on
  an undocumented flush cadence.
* **`--no-session-persistence` exists** and disables transcripts entirely. A user passing it
  through `claude_flags` silently blinds the whole design.
* The briefing's own counter-fact — "no transcript existed" — was itself a *discovery*
  failure (wrong project directory, wrong timezone window). That is the honest lesson: a
  record nobody can find is not a diagnostic. Which is requirement 4's actual wording:
  *discoverable via the MCP API, not the filesystem.*

**Operational complexity.** Medium-high: HTTP endpoint, hook injection, merge semantics,
poller lifecycle, realpath handling.

**Concurrency cost.** N transcript pollers doing bounded reads + one shell-out per hook
event. At 93 tool calls/session × 20 sessions that is ~1 900 process spawns.

**Migration.** Additive to the wire format; invasive to `claude-runner`'s settings overlay,
which is shared with every other claudish mode.

**Verdict.** **D is a superb complement and a poor substitute.** It cannot do requirement 2
at all. Its unique win — an unconditional durable record — is obtainable in Alternative A for
almost nothing: mint the UUID with `--session-id`, take `cwd` from `system:init`, and store
the resolved transcript path on `SessionInfo` so `get_diagnostics` can *hand the agent the
path* instead of the agent running `find`. **Take D's transcript pointer. Skip D's hook bus
and its HTTP endpoint — `--include-hook-events` already puts the same events inline on the
one ordered stream, which is strictly simpler.**

---

### Alternative E — in-process Agent SDK (no child at all)

**Approach.** Drop the subprocess. The MCP server calls `@anthropic-ai/claude-agent-sdk`
in-process, pointed at claudish's proxy URL.

**Requirements.** 1, 2, 3, 5 all become *native*: `canUseTool` gives a real permission
callback (the thing the CLI lacks, §3.5), messages are objects not bytes, usage is a field.
6 becomes an `AbortController`. 7 is where it collapses.

**Why it is not viable here, and the reasons are specific to this repo:**

* **`bun --compile`.** The repo already rejected the 1Password *SDK* for the CLI over a
  `--compile` blocker (`reference_1password_account_scope`, `project_1password_integration`).
  Adding a heavyweight SDK to the MCP server risks the same wall.
* **Process isolation is load-bearing.** `prehydrateCredentialsForSpawn`
  (`mcp-server.ts:1366`) exists *because* concurrent sessions each opening a 1Password
  SDK client get denied ("Denied authorization for SDK client"). In-process concurrency
  makes every session share one heap, one `process.env`, one `process.cwd()`. The comment at
  `mcp-server.ts:1360-1362` is explicit: *"`process.chdir()` is not an option — it is
  process-global and races concurrent calls."* Per-session `cwd` is a `create_session`
  parameter. **This alone disqualifies E.**
* **Global clobbering has bitten before**: `@hono/node-server` swapping global `Response`
  (`project_hono_globals_clobber`), and telemetry's readline stealing keystrokes from a
  shared stdin (`project_stdin_bug` bug 2).
* Requirement 6 stops being a process-tree kill and becomes "hope every async task honours
  the signal" — a regression against the one part of the current design that measurably works
  (`process-tree.ts:19-27`).

**Verdict.** Right shape in the abstract, wrong shape for a server that must run N
independently-credentialed, independently-cwd'd, independently-killable sessions. Revisit
only if channel sessions become single-tenant.

### Variants considered and folded in

* **Claudish-owned control socket.** Reinvents magmux's protocol without magmux's PTY, to
  solve a problem `proc.stdin` + `--input-format stream-json` already solves. Cost with no
  buyer. *Rejected.*
* **MCP-side streaming.** Not an alternative to any of the above — it is the *output* half,
  and it is already correctly shaped: `notifications/claude/channel` is visible with no
  keepalive, `notifications/progress` is invisible with keepalive, and they are
  **complementary, not alternatives** (measured: silent → aborted at 30 s; progress every
  10 s → survived 90 s; channel every 10 s → aborted at 30 s. `ROADMAP.md:58-69`,
  `mcp/progress-heartbeat.ts`). Whatever wins below must emit both. Note the channel
  *rendering* gating in `ai-docs/architecture/mcp-channel.md` — interactive-only, `.mcp.json`
  only, `--channels` required — is unchanged by any alternative here.

---

## 5. The explicit questions

### 5.1 Does a PTY change what Claude Code emits? Is scraping a rendered TUI ever acceptable?

**Yes, a PTY changes it — and the change is a downgrade for a machine consumer.** With a tty
on stdout, `claude` renders the interactive TUI: alternate screen, cursor addressing,
repaints, `⏺` glyphs, spinner frames, wrapping at the pane width. Without one it emits
`-p` output. Those are different programs' worth of output. The `⏺` in
`signal-watcher.ts:16` is the fossil of exactly this confusion: patterns written against the
TUI, deployed against print mode, and therefore dead since the day they shipped.

**No, scraping a rendered TUI is not acceptable when a structured stream exists**, and the
strongest witness is magmux itself. It runs the PTY and *still* reads the JSONL transcript
in preference to the screen (`pollTranscript`, `TranscriptReader`), using terminal idle only
as a fallback (`applyTerminalIdle`), and its own help states the precedence: *"The screen is
a rendering and may lag, wrap or be mid-redraw; where the two disagree, the transcript above
is what the session actually said."* A rendering is lossy by construction — it wraps at the
pane width, it drops scrollback on the alternate screen, and it is designed for a human eye.

Scraping is acceptable in exactly one situation: no structured stream exists. For
`claude` 2.1.239 that situation does not exist. `--output-format stream-json` has existed for
long enough that `team` already switched to it *deliberately*, "because print mode is the
lossy one" (`team-orchestrator.ts:834-843`, rationale at `team-stream-capture.ts:1-27`).
The channel is the last consumer that did not get the memo.

### 5.2 Can ONE mode serve both "batch, cheap, headless" and "interactive, observable"?

**Yes — one mode, one flag.** This is the answer that changed when I read `claude --help`.

The two profiles differ on exactly one axis: **whether partial-message deltas are streamed.**

| | batch/cheap | interactive/observable |
|---|---|---|
| transport | pipes | pipes |
| `--output-format stream-json` | yes | yes |
| `--input-format stream-json` | yes | yes |
| `--include-partial-messages` | **off** | **on** |
| granularity | per message + per turn | per token |
| volume (session A) | ~1.3 MB | ~5–14 MB |

Everything else — the reducer, the state machine, `send_input`, the accounting, the
diagnostics, the cancellation — is byte-identical. There is no second code path, no second
enum, no second failure mode. That is the difference between a *flag* and a *mode*, and it is
why one mode is now the honest answer where before it was not.

The genuinely separate thing is **a human watching a grid**, and that is not a channel
session. That is `team`, which already has it (`team-grid.ts`). Keep them apart.

### 5.3 Smallest change that kills the 900 s-silent-success class, vs. the right long-term shape

**Smallest — 3 edits, ~10 lines, no wire change, no new module:**

1. `claude-runner.ts:1608` — `process.exit(0)` → `process.exit(128 + signum)` in the signal
   handler. *This single line manufactures the false success.*
2. `signal-watcher.ts:84` — widen the guard from `cancelled` to every terminal state:
   `if (["cancelled","failed","completed"].includes(this._state)) return;`. A process exit
   must never *upgrade* a state that a supervisor already decided.
3. `session-manager.ts:225-227` — emit `"timeout"`, not `"failed"`, and add
   `["timeout","failed"]` to `EVENT_TO_TASK_STATUS` (`mcp-server.ts:1525`) so the value stops
   silently mapping to `"working"`.

After these three, a 900 s timeout reports `status:"timeout"`. It still produces no output
and no tokens — but it stops **lying**, and the class of "exit 0 is the success oracle" is
dead. Cheap enough to ship today, independent of everything else.

**Nearly-smallest bonus, 2 lines:** set `CLAUDISH_TOKEN_FILE` in the spawn env
(`session-manager.ts:99-108`) to `<sessionDir>/tokens.json`, and read it in `getOutput` via
`readSessionStats`. Requirement 5 goes from hardcoded `0` to real tokens, cost and tool
counts, with no parsing of anything.

**Right long-term shape:** Alternative A. The three fixes above are a subset of it, not a
detour — do them first, then land A behind them.

### 5.4 Concurrency: N sessions under magmux vs. pipes

| at N = 20 (`maxSessions` default) | pipes (A) | magmux (B) |
|---|---|---|
| processes | 20 trees | 20 trees **+ 1–2 magmux** |
| file descriptors | 60 pipes | 60 pipes + 20 PTY pairs + sockets |
| kernel PTYs | 0 | 20 (`kern.tty.ptmx_max` is finite and shared with the user's terminals) |
| `/tmp` sockets | 0 | 1 per magmux, in a namespace shared with every other magmux on the box |
| geometry limit | none | **~12 panes at 80×24** — magmux refuses a layout below 3 rows × 20 cols per pane. 20 sessions **do not fit in one magmux** at default headless geometry. Workaround (inflate `LINES`) is **UNVERIFIED**. |
| memory | ~10 MB of semantic event rings | 20 × `MAGMUX_SCROLLBACK` (1 000 lines) + 20 VT emulator states + 20 transcript pollers |
| CPU | ~1 400 `JSON.parse`/s aggregate (**UNVERIFIED at scale**) | VT parsing + rendering + polling per pane |
| cross-talk risk | none | measured real: a helper latched onto a concurrent `claudish team` run's socket. Needs `--id` discipline, which production does not yet use (`team-grid.ts:485` still uses the pid socket). |
| failure blast radius | one session | magmux dies → **all** sessions lose their supervisor |

Pipes win on every axis. Magmux's protocol is genuinely good — `open_pane`/`close_pane` with
reply correlation and permanent indices is better designed than most — but it is paying for a
terminal nobody is looking at.

### 5.5 The coordinator's specific questions

* **Does `Notification` fire on input-wait?** **UNVERIFIED** — I did not probe it. It is also
  moot: in bidirectional stream-json the `result` frame is the exact turn boundary, and
  "`result` received + stdin open" is a *deterministic* `waiting_for_input`, not a heuristic.
  It replaces the 2 s quiet timer (`signal-watcher.ts:11, 72-78`) with a fact.
* **Can claudish know the child's session-uuid?** **Yes, two ways** (§3.4): mint it and pass
  `--session-id <uuid>`, and/or read it from the `system:init` frame. No race, no mtime
  guessing. `session-discovery.ts` solves the *directory* layout but **not** the realpath
  slug (§3.1) — that is a real gap to close either way.
* **Does hooks-based design still need magmux or stream-json?** It needs **stream-json**, for
  `send_input` (hooks are inbound-only). It never needs magmux.
* **Is the transcript still needed for durable diagnostics?** **Yes, as a pointer, not as a
  parser.** The stream plus a bounded redacted on-disk copy covers the working set;
  the transcript covers the case the stream cannot — a claudish crash. Cost of keeping it:
  one string field on `SessionInfo`. Do that. Do not build a live state machine on it.
* **`--include-partial-messages` volume / `ScrollbackBuffer`:** ~5–14 MB per long session
  (§3.6). The existing 2 000-**line** ring would be consumed by delta frames within seconds
  and would evict every semantic event. **Deltas must be consumed for liveness and never
  stored.** Store semantic events (`assistant`, `user`, `result`, `system:*`) plus the prose
  answer; that is ~200–500 entries per session, *smaller* than today's ring.
* **`get_output` back-compat:** see the migration table in Alternative A. Short version: keep
  `output` as prose, make it *more* complete (all assistant text, not just the last message),
  and put events behind an opt-in `format` parameter. No caller breaks; every caller improves.

---

## 6. Recommendation

**Adopt Alternative A — bidirectional stream-json over pipes — with one element of D folded
in (the transcript path as a `SessionInfo` field). Do not adopt magmux for channel sessions.
Do not adopt the in-process SDK.**

Ship in three phases. Each is independently valuable and independently revertable.

### Phase 1 — stop lying (today, ~10 lines, no wire change)

1. `claude-runner.ts:1608` — exit `128+signum`, not `0`.
2. `signal-watcher.ts:84` — guard **all** terminal states against exit-driven upgrade.
3. `session-manager.ts:225-227` + `mcp-server.ts:1525` — emit and map `"timeout"`.
4. `session-manager.ts:99-108` — set `CLAUDISH_TOKEN_FILE=<sessionDir>/tokens.json`;
   `getOutput` reads it via `readSessionStats` → requirement 5, no parsing.
5. `session-manager.ts:175-178` — always `stdin.end()` when the design still uses `--stdin`,
   so a promptless `create_session` fails fast instead of hanging 900 s (§1.4).

Regression test: force a timeout, assert `status === "timeout"` and that `meta.json` is not
overwritten with `"completed"`. Pin it — this bug has a shape that will come back.

### Phase 2 — the stream (~250 lines new, ~180 deleted)

* New `channel/stream-json-reducer.ts` replacing `signal-watcher.ts`. Reuse
  `createAssistantTextCapture` verbatim for the answer; apply its per-line degradation rule
  to the event path.
* Argv change in `session-manager.ts:85-92` (drop `--stdin`, add `-p --verbose
  --output-format stream-json --input-format stream-json --include-partial-messages
  --include-hook-events --replay-user-messages --session-id <uuid>`).
* Remove `proc.stdin.end()` (`:177`); the prompt becomes the first `{"type":"user",…}` frame.
* `sendInput` writes a `user` frame instead of raw text.
* Deltas drive a liveness watchdog and are discarded. Semantic events go in the ring.
* Terminal state comes from `result.terminal_reason` / `is_error` / `api_error_status`,
  cross-checked with `classifyRunOutput` for the "exit 0 has to earn it" rule
  (`team-orchestrator.ts:982-984`).

### Phase 3 — diagnostics as API (~120 lines)

* New MCP tool `get_diagnostics(session_id)` returning: bounded redacted stderr tail
  (`meaningfulStderr` + `redactSecrets`), the last N semantic events, the token/cost record,
  `terminal_reason`, and **the resolved transcript path** (from `--session-id` +
  `realpathSync(cwd)` slug, or the `cwd` reported in `system:init`).
* Add `transcriptPath`, `costUsd`, `toolCallCount`, `terminalReason`, `claudeSessionId` to
  `SessionInfo` (additive).
* Set `CLAUDISH_UPSTREAM_ERROR_LOG` per session so `captureUpstreamError`
  (`composed-handler.ts:777-785`) stops being a no-op for channel children.

That one stderr line — `[claude-code:unrecognized_model] {"model":"cx@gpt-5.6-sol"}` — would
have ended the investigation in ten seconds if any MCP tool had returned it.

### Architectural note on structure

Two catalog patterns apply, and one does not.

* **State** (`references/behavioral.md`) — `SignalWatcher` *is* a state machine, and its
  defect is that transitions are **inferred from regexes over a rendering** rather than
  **declared from events**. The fix is not a new pattern; it is feeding the existing machine
  real input. Keep the explicit transition table and make illegal transitions loud (the
  catalog's `state-machine.ts` asset throws on an illegal transition rather than
  silently no-opping — precisely the discipline whose absence at `signal-watcher.ts:84`
  produced this bug).
* **Observer** — already correct, and correctly *not* a class. `onStateChange` is a single
  callback (`session-manager.ts:47`); the catalog is explicit that in TypeScript
  `attach`/`detach`/`notify` collapses to a callback set. Do not "improve" it.
* **Hexagonal / ports-and-adapters — deliberately NOT adopted.** It is tempting to define a
  `SessionTransport` port with `PipeAdapter` / `MagmuxAdapter` / `SdkAdapter`. Do not. The
  catalog names this failure exactly: *"Over-applied, you get an interface with exactly one
  implementation forever"*, and *"When NOT to use this: the infrastructure will never be
  swapped and the domain is thin."* We are recommending exactly one transport and rejecting
  the other two on evidence. `behavioral.md` files the same judgement as **UNI-09 Strategy
  Overkill** — *"Strategy with 1-2 implementations and no polymorphism benefit"* — with the
  threshold written down: one or two stable branches, use a branch; three or more, extract.
  Revisit only if a second transport is actually funded.

### Trade-off table

Scores: ●●● full / ●●○ partial / ●○○ weak / ○○○ none.

| | **A — stream-json pipes** | **B — magmux PTY** | **C — hybrid** | **D — transcript + hooks** | **E — in-process SDK** |
|---|---|---|---|---|---|
| 1 progress visibility | ●●● token-level | ●●○ poll-level | ●●● | ●●○ hook boundaries | ●●● |
| 2 `send_input` | ●●● **measured working** | ●●● `send` frame | ●●● | ○○○ inbound only | ●●● |
| 3 honest terminal state | ●●● `terminal_reason`, first-party | ●●○ 3 enums deep | ●●● | ●●○ flush ambiguity | ●●● |
| 4 diagnostics via API | ●●● structured, bounded, redacted | ●○○ pane text | ●●● | ●●● durable, ●○○ discoverable | ●●● |
| 5 token/cost | ●●● twice (child + proxy) | ○○○ (falls back to proxy) | ●●● | ●●○ | ●●● |
| 6 tree cancellation | ●●● existing group kill | ●●○ **UNVERIFIED** | ●●● | ●●● | ●○○ AbortController |
| 7 headless / concurrent | ●●● pipes only | ●○○ ~12-pane ceiling, PTYs, `/tmp` | ●●○ | ●●○ N pollers + shell-outs | ○○○ **shared cwd/env — disqualifying** |
| new dependencies | none | magmux (unpinned in CI; broke `main` twice in one day) | magmux | none | Agent SDK (`--compile` risk) |
| net lines | +250 / −180 | +600 | +850 | +400 | +500 |
| migration risk | low (additive; `get_output` improves in place) | high (`pid`, cancel, 3 enums) | high | medium (settings overlay is shared) | very high |
| kills the 900 s class | **yes** | yes | yes | partly | yes |

**A wins on every requirement it does not tie on, adds no dependency, and is the only option
whose entire mechanism I was able to run end to end on this machine today.**

---

## 7. Open questions and unverified claims

1. **`Notification` hook on input-wait — UNVERIFIED.** Not probed. Moot under A (the `result`
   frame is the turn boundary), but worth confirming if D is ever revisited.
2. **JSON-parse cost at 20 concurrent sessions — UNVERIFIED.** Single-session only. Estimate
   ~1 400 lines/s aggregate. If it bites, yield with `setImmediate` every N lines, or make
   `--include-partial-messages` opt-in per session.
3. **magmux pane ceiling above 80×24 — UNVERIFIED.** Whether inflating `COLUMNS`/`LINES` in
   headless mode lifts the ~12-pane limit was not tested. Only matters if B is revisited.
4. **Whether magmux `close_pane {force:true}` kills the whole process tree — UNVERIFIED.**
5. **Transcript flush timing — UNSPECIFIED upstream.** Treat the transcript as a post-hoc
   record, never as a live event source.
6. **`--no-session-persistence` blinds any transcript-dependent design.** Passing it through
   `claude_flags` would need to be rejected or flagged.
7. **Stale comment to fix:** `team-orchestrator.ts:832` says "`-p` means `--profile` in
   claudish". It does not (`cli.ts:379` claims only `--profile`; `-p` passes through at
   `cli.ts:640-646`). The comment is what would stop someone writing Alternative A's argv.
8. **Stale repo memory to correct:** `project_launcher_orphans_children` records the launcher
   orphan bug as UNFIXED. It is fixed (`bin/claudish.cjs:120-166`).
9. **No `realpathSync` in the repo.** Any code that maps a cwd to a Claude Code project
   directory is wrong on macOS `/tmp` and on symlinked worktrees (§3.1).
10. **Channel *rendering* gating is unchanged by all of this** — interactive-only, `.mcp.json`
    only, `--channels` required (`ai-docs/architecture/mcp-channel.md`). A perfect producer
    still renders nothing in a client that did not register the channel. Whatever ships must
    keep emitting `notifications/progress` alongside, for the keepalive.

## 8. Evidence index

| Artifact | Path |
|---|---|
| Failed session A | `~/.claudish/sessions/1084c4a8/{meta.json,output.log,stderr.log,prompt.md}` |
| Failed session B | `~/.claudish/sessions/0da0d868/…` |
| Transcript A (1,320,401 B / 432 events) | `~/.claude/projects/-Users-jack-mag-magus-magus-src--claude-worktrees-style/5aba8f1f-f323-4927-9c90-3e65787fa725.jsonl` |
| Transcript B (822,801 B / 299 events) | `…/6250c4b6-5f65-486f-bf37-4d11360fde3e.jsonl` |
| Bidirectional stream-json probe | `./probes/probe-bidirectional-stream-json.mjs`, `./probes/samples-bidirectional.txt` |
| Tool-turn + hook-events probe | `./probes/probe-tool-turn-hook-events.mjs`, `./probes/samples-tool-turn.txt` |
| Print-mode transcript probe | `~/.claude/projects/-private-tmp-cc-transcript-probe/9cdc44bf-….jsonl` (49,197 B) |
| magmux under test | `/opt/homebrew/bin/magmux`, `magmux 0.8.1 (3e860aa)` |
| Claude Code under test | `2.1.239` (from `system:init`) |
