# Channel sessions → bidirectional stream-json — implementation log

Design implemented: `ai-docs/sessions/dev-arch-20260822-114706-c77bb53d/alternatives.md`,
Alternative A, phases 1 and 2 (phase 3 is `mcp-server.ts`, forbidden this batch).
Verified against `claude` 2.1.239 on this machine, 2026-08-22.

---

## 1. Files changed

| File | Why |
|---|---|
| `packages/cli/src/channel/stream-json-reducer.ts` | **NEW** (~470 ll). Replaces `SignalWatcher`. NDJSON → state, prose, accounting. Explicit transition table with absorbing terminal states; deltas consumed for liveness then discarded; per-line degradation; `result` frame drives turns/tokens/`terminal_reason`. |
| `packages/cli/src/channel/session-manager.ts` | Rewritten around the new transport: new argv, stdin held open, prompt as the first `user` frame, `send_input` writes a `user` frame, `CLAUDISH_TOKEN_FILE` in the child env, exit classified via `classifyRunOutput`, `"timeout"` survives in `SessionInfo.status`, reserved-flag rejection, `dispose()` actually called, `getDiagnostics()`. |
| `packages/cli/src/channel/types.ts` | `SignalState/SignalData/SignalCallback` → `ChannelEventType/ReducerEvent/ReducerCallback`. `ChannelEventType = Exclude<SessionStatus,"timeout">` encodes the `EVENT_TO_TASK_STATUS` constraint in the type system. `SessionInfo` gains `costUsd`, `toolCallCount`, `terminalReason`, `claudeSessionId`. |
| `packages/cli/src/channel/index.ts` | Export surface follows the rename; adds `buildChannelSpawnArgs`, `assertNoReservedFlags`, `userFrame`. |
| `packages/cli/src/channel/test-helpers/channel-diagnostic.ts` | One stale `SignalWatcher` mention in a diagnostic string. |
| `packages/cli/src/claude-runner.ts` | Signal handler exits `128 + signum` instead of `0`. Cleanup (temp settings unlink, `onCleanup`, `proc.kill`) unchanged. |
| `packages/cli/src/stats-buffer.ts` | **Not in the design.** A second, EARLIER-registered `process.exit(0)` signal handler — see §4.1. Now exits 143/130. |
| `packages/cli/src/team-stats.ts` | Adds `readTokenStatsAt(path)` (path-addressed); `readTokenStats` delegates. Adds `tool_calls` to `ModelTokenStats`. |
| `packages/cli/src/team-stream-capture.ts` | `STREAM_JSON_EVENT_TYPES` exported so the reducer can gate on the capture's real vocabulary instead of duplicating it. No behaviour change. |
| `ai-docs/architecture/mcp-channel.md` | Components, the exact argv and its three load-bearing properties, delta discipline, the timeout/wire split, session shape, test-file status. |

### Files deleted

- `packages/cli/src/channel/signal-watcher.ts` — the `⏺` `TOOL_PATTERNS`, the
  `QUESTION_PATTERNS`, the 2-second quiet-period `waiting_for_input` heuristic, and the
  `processExited` guard that only blocked `cancelled`. Nothing imports it.
- `packages/cli/src/channel/signal-watcher.test.ts` — 12 tests for the deleted module.

Nothing outside `packages/cli/src/channel/` was deleted.

---

## 2. The exact final argv

`SessionManager` spawns:

```
claudish --model <spawnModel|model> -y --verbose --quiet -p \
         --output-format stream-json \
         --input-format stream-json \
         --include-partial-messages \
         --include-hook-events \
         --replay-user-messages \
         --session-id <minted uuid> \
         [caller claudishFlags…]
```

Measured, not assumed — `claude` receives (probe `probes/probe-argv.ts`, real claudish tree,
`CLAUDE_PATH` pointed at a recording stand-in):

```
--settings /Users/jack/.claudish/settings-….json --dangerously-skip-permissions
-p --output-format stream-json --input-format stream-json --include-partial-messages
--include-hook-events --replay-user-messages --session-id <uuid> --verbose
```

Order rationale, all three verified:

1. `--verbose` BEFORE `--quiet` — claudish consumes `--verbose` itself (`cli.ts:344`,
   sets `quiet=false`) and separately forwards a copy to `claude` (`cli.ts:674`), which
   hard-errors on `--print --output-format stream-json` without it. Reversed, every child
   narrates onto stderr. Mirrors `team-orchestrator.ts:818-825`.
2. `-p` present and followed by a flag — without `-p` and without `--stdin`, `cli.ts:667`
   flips `interactive = true` and launches the picker; and the passthrough value rule
   (`cli.ts:647`) would swallow a following non-flag token.
3. `--session-id <uuid>` last of the base args — it consumes exactly one token, so caller
   flags appended after it are parsed fresh.

### `--stdin` removal — VERIFIED, not assumed

The task flagged this as the thing to confirm. Probe result (`probes/probe-argv.ts`):

- claudish stays non-interactive (no picker), because `-p` sets `_hasPrintFlag`.
- `readStdin()` never runs, so nothing in claudish consumes fd 0.
- A `{"type":"user",…}` frame written to the spawned process's stdin arrived at the
  grandchild's fd 0 **byte-identical**, and the grandchild's stdout arrived back on the
  parent's pipe. Zero relay code — `stdio: "inherit"` all the way down.
- Parent stderr was empty (`--quiet` won claudish's own verbosity), exit 0.

---

## 3. Behaviour changes worth knowing

### 3.1 Session shape now follows the prompt (a design gap I had to close)

The design says `result` → `waiting_for_input` and stdin stays open. It never says when a
session reaches `completed`. Taken literally, **no session would ever complete**: the child
answers, sits idle, and the 600 s timeout reports a failure it did not have. Since
`create_session`'s schema lives in `mcp-server.ts` (forbidden), no new tool parameter was
available, so the signal had to come from existing information:

- `prompt` **given** → one-shot. First `result` closes stdin; the child exits 0; state
  becomes `completed`. Event sequence: `running → tool_executing → running →
  waiting_for_input → completed`.
- `prompt` **absent** → interactive. Stdin stays open forever, `waiting_for_input` between
  turns, ends on `cancel_session` or the timeout.
- Any `send_input` converts a one-shot session to interactive — the caller has taken over.

This also resolves Phase 1 item 5 (the promptless hang) *architecturally* rather than with
the `stdin.end()` the design proposed: that fix only made sense while `--stdin` existed. With
`--stdin` gone, `readStdin` never runs, there is no drain to satisfy, and a promptless
session is a legitimately-waiting session that `send_input` can now actually drive. Adding
`stdin.end()` here would have re-broken the documented "send later" workflow.

### 3.2 `get_output` returns prose, and now explains failures

`output` is recovered assistant prose (`createAssistantTextCapture`, reused verbatim), which
is strictly more than the old final-message-only text. Raw NDJSON never reaches it. On a
FAILED session the classifier's explanation plus the meaningful stderr tail is appended as a
`[claudish] …` block — so the diagnostic that used to sit unreachable in `stderr.log` is now
in the field the agent reads. No wire-shape change; the JSON keys are identical.

### 3.3 On-disk artifacts

`prompt.md`, `output.log` (prose, no longer 0 B), `stderr.log`, `meta.json` (now with
`costUsd`/`toolCallCount`/`terminalReason`/`claudeSessionId`), plus two new ones:
`events.jsonl` (every semantic frame, deltas excluded — ~2 KB for a short session, ~1.3 MB
for a long one) and `tokens.json` (the child's own token tracker output).

### 3.4 Cost is deliberately NOT taken from the child

`result.total_cost_usd` prices every model at Anthropic's rates. For a proxied model that is
fiction, and for a subscription provider it invents spend that will never be billed —
directly against the `SUBSCRIPTION_PROVIDERS` invariant in `CLAUDE.md`. `costUsd` therefore
comes only from the proxy's token file, and is `0` when that file does not exist. Tokens fall
back to `result.usage` when the file is absent; turns come only from `result.num_turns`.

### 3.5 `dispose()` — the leak

There were zero call sites. Now: on child exit, on spawn error, and for every session in
`shutdownAll()` (whether or not its process is still alive), alongside `clearTimeout` of both
handles. The timeout handle and kill handle are `unref()`d so a pending session timer can
never hold the MCP server open.

### 3.6 Stall watchdog

Deltas reset a liveness clock; after 120 s of total silence in `starting` or `running` the
session emits ONE `running` event with `meta.stalled=true` and the idle seconds.
`tool_executing` and `waiting_for_input` are exempt — a 10-minute `Bash` and a session waiting
for input are both legitimately silent. It reports; it never terminates. Configurable via
`SessionManagerOptions.stallSeconds` (0 disables).

### 3.7 Reserved flags (from the coordinator's mid-task correction)

`assertNoReservedFlags` rejects a caller-supplied `-p`, `--print`, `--output-format`,
`--input-format`, `--session-id`, `--verbose` with a named error. Local to
`session-manager.ts`, not in the shared `buildChildClaudeFlags` — the reserved set is a
property of this transport and team reserves fewer. `--flag=value` spellings are handled.
Verified: `--verbose` and `--output-format json` rejected, `--agent dev:reviewer` accepted.

---

## 4. Things the design got wrong, or did not know

### 4.1 `claude-runner.ts:1608` is NOT the only `process.exit(0)` — and it is not the one that fires

The design names that line as "the single line that manufactures the false success". It is
not. `packages/cli/src/stats-buffer.ts:225` registers `process.on("SIGTERM", … process.exit(0))`
**at module load**, i.e. long before `setupSignalHandlers` runs, and it exits unconditionally.

Measured after fixing `claude-runner.ts` alone: a group SIGTERM against a live channel child
still produced `code=0, signal=null`. After also fixing `stats-buffer.ts`: `code=143`.

`stats-buffer.ts` is outside `packages/cli/src/channel/` but is not on the forbidden list, and
fixing it is Phase 1 item 1's actual intent. It has a SIGINT twin, now `130`.

**Anyone re-deriving this bug from the design will fix the wrong line and see no change.**

### 4.2 `createAssistantTextCapture` cannot be fed the raw stream

The design says reuse it "verbatim" for the answer. Its degradation rule passes through any
line whose `type` it does not recognise, and its vocabulary is exactly
`{system, assistant, user, result}`. So feeding it the real stream puts **every
`stream_event` delta and every `rate_limit_event` into the answer as raw JSON**. Observed:
the first probe run had a `rate_limit_event` frame sitting in `get_output`.

Fix: the reducer gates. Deltas never reach it (rule 1 anyway); a JSON line whose `type` is
outside the capture's vocabulary goes to `events.jsonl` only. Non-JSON lines still pass
through verbatim, which preserves the degradation guarantee — the worst case stays an ugly
answer, never a lost one. `STREAM_JSON_EVENT_TYPES` is now exported so the two cannot drift.

### 4.3 A non-JSON line really does appear mid-stream

`claude 2.1.239` emitted, on stdout, between frames:

```
Client.listTools() called but server does not advertise tools capability - returning empty list
```

The per-line degradation rule is load-bearing, not defensive padding. It is recorded as an
anomaly and kept in the prose.

### 4.4 `--agent` under `--input-format stream-json`

Ran the control the coordinator asked for. The result is **not** the clean "still errors"
the request expected, and not the "silently dropped" it feared:

| invocation | outcome |
|---|---|
| `claude -p "say hi" --agent zzz-not-a-real-agent` | exit 1, stderr `--agent 'zzz-not-a-real-agent' not found. Available agents: …` |
| same, with `--output-format stream-json --input-format stream-json` + a frame on stdin | **exit 0, normal answer.** No error at all. |
| `--agent Explore` with a positional prompt | `system:init.tools` = 157, no `Edit`/`Write`/`Task` |
| `--agent Explore` with `--input-format stream-json` | same non-MCP tool set, no `Edit`/`Write`/`Task` |

So: **a VALID `--agent` IS honoured under `--input-format stream-json`. An INVALID one is
silently ignored and falls back to the default agent, instead of the exit-1 "not found" that
print mode gives.** The channel path is therefore functional but has lost its typo guard —
`create_session(agent: "dev:reviwer")` will quietly run the default agent. Worth a
client-side check in `create_session` (mcp-server.ts, not my file).

### 4.5 §1.1's `readStdin` hang

Correct as written, and it disappears with `--stdin`. See §3.1.

---

## 5. What I could not verify

1. **JSON-parse cost at 20 concurrent sessions.** Single sessions only, as in the design.
   No `setImmediate` yield was added — it would be speculative. The delta path is one
   `JSON.parse` plus a `Set.has`, and deltas never touch the capture, the scrollback or the
   disk, which is the cheapest shape available without measuring.
2. **A real long session with `--include-partial-messages` end to end.** Every probe used a
   `CLAUDE_PATH` stand-in or a single short real `claude` turn. The 5–14 MB delta volume is
   the design's estimate, not something I reproduced. What IS verified is that deltas are
   dropped before any buffer.
3. **`--session-id` collision behaviour.** The uuid is minted per session with `randomUUID()`;
   I did not test what `claude` does if one is reused.
4. **The transcript path.** `claudeSessionId` is recorded (from `system:init`, cross-checked
   against the minted uuid) but no code resolves it to a file. Doing so needs the realpath
   slug fix the design flags at §3.1/§7.9, and its only consumer is Phase 3's
   `get_diagnostics` in `mcp-server.ts`.
5. **The stall watchdog against a genuinely wedged real model.** Exercised only with
   `stallSeconds: 0` (disabled) in the probes.

---

## 6. Test status — READ THIS

I wrote no tests, per instruction. Current state, `CLAUDISH_SKIP_LIVE_E2E=1`:

- Full suite: **2816 pass, 12 skip, 12 fail** over 2840 tests.
- 11 of those 12 are `src/channel/session-manager.test.ts` (12 of its 23 tests fail).
  They assert the pre-stream-json topology: the `--stdin` argv, exit-0-means-completed, and
  a `fake-claudish.ts` shim that echoes stdin instead of speaking stream-json. Every one is
  an intended contract change, not a regression.
- The 12th, `team-timeout-repro.test.ts › REPRO: process that completes just before timeout`,
  **passes in isolation** (8/8) and fails only in the contended full run — the documented
  `project_test_contention_false_failures` flake.
- `session-wire-format.test.ts` (6) and `scrollback-buffer.test.ts` (11) both pass: **the
  channel wire contract is intact.**
- `team-stats`, `team-stream-capture`, `stats-buffer`, `session/`, `process-tree`,
  `status-line-context`: 123/123 pass.

Failing tests, verbatim:

```
SessionManager > spawn argv falls back to the requested model when spawnModel is absent
SessionManager > spawnModel changes argv while SessionInfo keeps the requested model
SessionManager > getOutput returns output from process stdout
SessionManager > getOutput totalLines reflects number of lines produced
SessionManager > getOutput with tail_lines returns only the last N lines
SessionManager > listSessions excludes completed sessions when includeCompleted=false
SessionManager > listSessions includes completed sessions when includeCompleted=true
SessionManager > meta.json is written to the configured sessions directory after completion
SessionManager > onStateChange callback fires with session_id and event
SessionManager > sendInput returns false for completed session
SessionManager > cancelSession returns false for completed session
SessionManager > timeout kills long-running process and terminates it
```

The test-architect will need `fake-claudish.ts` to emit stream-json frames (a working model
is `probes/fake-claude-streaming.mjs` and `probes/fake-claude-modes.mjs` here) and to assert
the new argv from `buildChannelSpawnArgs`, which is exported for exactly that.

---

## 7. Verification runs

`bun run typecheck` — clean, both packages, no output.
`bun run lint` — **exit 0**, 0 errors, 881 warnings (all pre-existing `noExplicitAny` /
`noExcessiveCognitiveComplexity`; none in the new files).
`bun run build` — CLI 2.78 MB, bridge 3.15 MB, both bundle.

### Probes (all in `probes/`, all runnable)

| probe | what it proved |
|---|---|
| `probe-argv.ts` + `fake-claude.mjs` | the argv survives claudish's parser; stdin reaches the grandchild; stdout comes back; stderr silent; exit 0 |
| `probe-session-manager.ts` + `fake-claude-streaming.mjs` | full one-shot: `running → tool_executing → running → waiting_for_input → completed`, prose recovered (no protocol JSON), `turnsCompleted: 1`, `tokensUsed: 1290`, `toolCallCount: 1`, `terminalReason: "completed"`, `claudeSessionId` from `system:init`, honest `meta.json`, non-empty `output.log`, 2 KB `events.jsonl` |
| `probe-failures.ts` + `fake-claude-modes.mjs` | the four honesty cases, below |

Failure-path results:

```
[1 silent-zero]  status=failed  exit=0    events=failed
                 output carries "[claudish] Child exited 0 without ever emitting a terminal
                 `result` frame … stderr: [claude-code:unrecognized_model] {"model":"cx@gpt-5.6-sol"…
[2 timeout    ]  status=timeout exit=143  events=failed   meta.status=timeout
[3 cancel     ]  status=cancelled exit=143 events=cancelled
[4 interactive]  send#1=true send#2=true  turns=2  output="turn1:ALPHA\n\n\nturn2:BETA"
[5 flags      ]  --verbose → rejected; --output-format json → rejected; --agent dev:reviewer → accepted
```

Case 1 is the original bug, byte for byte — the same `unrecognized_model` stderr line, the
same exit 0, the same empty stdout. It now reports `failed` and hands the agent the
diagnostic. Case 2 is the clobber: `SessionInfo.status` and `meta.json` both say `"timeout"`
while the wire event stays `"failed"`, and the child's exit does not upgrade it. Case 4 is
`send_input` working for the first time.

---

## 8. Not done (Phase 3, all in the forbidden `mcp-server.ts`)

- `get_diagnostics` MCP tool. `SessionManager.getDiagnostics()` exists and returns the
  stderr tail, anomalies, `events.jsonl` path, `claudeSessionId`, terminal reason and
  accounting — it needs ~20 lines of tool registration and nothing else.
- `["timeout","failed"]` in `EVENT_TO_TASK_STATUS`. Until it lands, `ChannelEventType`
  excludes `"timeout"` and there is a `TODO(phase3)` on the type saying so.
- `CLAUDISH_UPSTREAM_ERROR_LOG` per session.
- A client-side agent-name check in `create_session` (see §4.4).

---

# Review fixes (3/3 REJECT → nine defects)

Review inputs: `ai-docs/sessions/review-impl-20260822-130838/response-{01,02,05}.md`.
Every fix below is proven by a probe in `probes/probe-review-fixes.ts` (D1–D8) or
`probes/probe-shutdown-orphan.ts` (D9), and every probe is proven to be load-bearing by a
hand-written mutation applied and reversed with `probes/mutate.ts` — no `git checkout`, no
stash. Verbatim probe output is in §V below.

**No test file was edited.** `session-manager.test.ts`, `test-helpers/*`, `mcp-server.ts`,
`cli.ts`, `team-orchestrator.ts`, `providers/claude-code-aliases.*` and
`mcp-child-flags.test.ts` are untouched. G1–G7 are still green.

## D1 — exit-before-drain race (BLOCKING) — FIXED

`proc.on("exit")` no longer finalises. `handleExit` records only
`{code, signal, at}` into `entry.pendingExit`; the new `finalize()` runs when BOTH stdio
pipes have emitted `close` (`onPipeClosed`, counting down `entry.openPipes`) or after
`DRAIN_TIMEOUT_MS` — imported from `team-orchestrator.ts`, the same 10 s bound and the same
rationale as `team`'s own exit handler, which the new comment at the site cites by line.

`exit` fires before the stdout pipe closes and the `result` frame is by construction the
LAST line the child writes, so it is exactly the frame in flight at that moment. A `close`
that arrives before `exit` is handled too (`onPipeClosed` returns until `pendingExit` is
set). `finalize()` is idempotent (`entry.finalized`) and is the single funnel for all four
endings: pipes drained, drain timeout, spawn error, `shutdownAll`.

Measured — probe emits `exit` first, then the answer + `result`:

| | status | output | meta.json |
|---|---|---|---|
| pre-fix (mutation D1) | `failed` | diagnostic only | `failed` |
| fixed | `completed` | contains `FINAL ANSWER` | `completed` |

## D2 — RESERVED_CHILD_FLAGS incomplete (BLOCKING) — FIXED

The hand-written list is gone. `RESERVED_CHILD_FLAGS` is now DERIVED from
`buildChannelSpawnArgs` — every token in the base argv that starts with `-` — plus
`RESERVED_FLAG_ALIASES` and `TRANSPORT_BREAKING_FLAGS` (`--stdin`). Anything added to the
spawn argv is reserved automatically; that drift is what produced the hole.

Aliases were read out of `cli.ts`'s arg loop, not guessed: `--model`/`-m` (:263),
`--auto-approve`/`-y` (:310), `--quiet`/`-q` (:338), `--verbose`/`-v` (:340), plus
`-p`→`--print` (a `claude` flag, not a claudish one).

Effective set (18): `--model -m -y --auto-approve --verbose -v --quiet -q -p --print
--output-format --input-format --include-partial-messages --include-hook-events
--replay-user-messages --session-id --stdin`.

**The matcher was deliberately NOT widened.** Exact-token equality, with the existing
long-form `=value` split, is kept. A `startsWith` matcher would reject `--print-argv`
(used by two existing tests, and the flag that pins the argv-ordering invariant),
`--model-opus`, `--model-sonnet` and `--agents` — the too-wide half of the mistake
`buildChildClaudeFlags` shipped. Mutation `D2w` reproduces exactly that: three false
rejections. `-v=x` handling was NOT added — `cli.ts` accepts no such spelling.

Verified: all 18 rejected, `--print-argv --model-opus --model-sonnet --agents --effort`
accepted, G4 green, and `team-orchestrator.test.ts -t "pinned spawn identity"` 2 pass/0 fail.

## D3 — stale result witness (BLOCKING) — FIXED

`StreamJsonReducer.beginTurn()` clears `_resultSeen` / `_resultIsError` /
`_apiErrorStatus`, and `writeFrame` calls it on every frame written to the child's stdin —
the one moment we know for certain a new turn is outstanding. Cumulative accounting
(`_turns`, tokens, `_terminalReason`) is deliberately untouched: it is history, not
completion evidence.

Also: `_resultIsError` now also latches on a `subtype` beginning with `error`
(`error_max_turns`, `error_during_execution`), which `is_error` alone did not always carry.

Probe: promptless session → turn 1 answers with a clean `result` → `send_input` turn 2 →
child exits 0 mid-turn. Pre-fix `completed`; fixed `failed`, with the diagnostic naming the
missing `result` frame.

**Partially disputed.** gpt-5.6-sol also asked that `classifyExit` require
`terminalReason === "completed"`. I did not do that and think it would be a regression:
the `terminal_reason` vocabulary is UNMEASURED here (the implementation log's own probes
only ever observed `"completed"`), the field is optional on the wire, and a Claude Code
version that omits it would turn every successful session into a failure. The
turn-scoping above closes the actual reported failure mode; a value-level check needs a
measured vocabulary first.

## D4 — raw event logs persist secrets, unbounded (SECURITY) — FIXED

`onSemanticLine` now routes through `appendEventLog`, which `redactSecrets(line)`s each
frame (imported from `../redact.js`, the module `team-orchestrator.ts` itself imports —
that file was not touched) and stops at `EVENT_LOG_LIMIT = 4 MB`, writing one
`{"type":"claudish_truncated","limit_bytes":…}` marker at the cut. `stderr.log` is
redacted at write time too, matching `team-orchestrator.ts:1070`.

Probe: an `ANTHROPIC_API_KEY=sk-ant-…` inside a `tool_result` frame and on stderr.
Pre-fix both files contained the key verbatim; fixed, neither does, `REDACTED` appears, and
5 MB of frames produce a 4.2 MB capped log carrying the truncation marker.

## D5 — UTF-8 corruption at chunk boundaries — FIXED

`node:string_decoder` `StringDecoder`, one per pipe, held on the entry; `decodeChunk()`
passes strings through (a test can `emit("data", "…")`, and `StringDecoder.write` only
accepts a Buffer). `finalize()` flushes `decoder.end()` on both before the reducer's own
`end()`.

Probe splits `日本語のテキスト 🚀 done` mid-codepoint across two chunks. Pre-fix:
`"���本語…"`. Fixed: byte-exact, no U+FFFD.

## D6 — batchToolUse timer does not cancel on state transition — FIXED

Two independent guards, both kept:
1. `transition()` calls `resetToolBatch()` on any real move where `newState !==
   "tool_executing"` — the timer never outlives the state it describes.
2. The timer callback re-checks `!disposed && _state === "tool_executing"`, covering the
   ordering where it was already queued on the macrotask queue when the move happened.

`clearBatchTimer` became `resetToolBatch` (timer + count + name), used by `settle` and
`dispose` too.

Either guard alone suppresses the defect, so the mutation proof needed BOTH removed:
with `D6`+`D6b` applied, gemini-3.7-flash's exact scenario (Read → tool_result → Write →
tool_result → 450 ms) yanks the session from `running` back to `tool_executing` and emits a
phantom notification. Fixed, it stays `running`.

**Also fixed here (glm-5.3 minor c):** `_toolUseCount` counted assistant FRAMES containing a
tool_use, not tool_use BLOCKS, so parallel calls — Claude Code's default shape — undercounted
the very metric ("93 tool calls") the incident was measured by. `toolUseNames()` returns
every block; `toolBatchAnnounced` stops the debounced notification repeating news the
immediate one already carried.

## D7 — spawn-error path leaks and writes no meta.json — FIXED

`proc.on("error")` now sets `pendingExit`, settles `failed`, records the reason into the
scrollback (so `get_output` explains it) and calls `finalize()` — which clears both timers,
ends `outputLogStream`, and writes `stderr.log` + `meta.json`.

This matters more than the review knew: measured under Bun, an ENOENT spawn emits
`error` + `close` and **no `exit` at all**, so nothing else was ever going to run.
(My first mutation of this path failed to reproduce because it left `pendingExit` set and
the pipe-close path finished the job; the corrected mutation restores the original handler
verbatim and does reproduce.)

Pre-fix: no `meta.json`, `outputLogStream` still open. Fixed: `meta.json` with
`status: "failed"`, stream nulled.

## D8 — unbounded entry.stderr, no session eviction — FIXED

- **stderr**: `recordStderr()` keeps `STDERR_SIDE_LIMIT` (32 KB) of HEAD **and** 32 KB of
  TAIL with one marker between. Both ends deliberately — the diagnostic that motivated this
  whole change (`[claude-code:unrecognized_model]`, 81 bytes) is emitted at STARTUP, so a
  pure tail buffer is precisely the shape that would have lost it. 2.6 MB written → 65 592
  chars held, with both `HEAD-MARKER` and `TAIL-MARKER` present.
- **eviction**: `scheduleEviction()` drops a terminal session from the map after
  `terminalRetentionMs` (default 30 min, `unref`'d, exposed on `SessionManagerOptions` for
  tests), and `evictOldestTerminal()` enforces a hard ceiling of 50 retained, oldest
  `completedAt` first. On-disk artifacts are untouched. There was previously not one
  `sessions.delete` in the file.

## D9 — shutdownAll cancels the SIGKILL fallback — FIXED

Rewritten around `terminateChildTree` (`process-tree.ts`): SIGTERM to the group, wait,
SIGKILL to the group, wait. Two separate bugs closed:

1. Liveness was `!proc.killed`. `signalProcessTree` sets `killed` the instant a signal is
   SENT, so a child that IGNORED SIGTERM — the only kind that needs escalating — read as
   already dead and was skipped. Now `exitCode === null && signalCode === null`. The same
   correction was applied to the timeout handler and `cancelSession`.
2. `entry.killHandle` (the SIGKILL a `cancel_session` scheduled 5 s earlier) was cleared
   for those skipped sessions, cancelling the only escalation. It is now cleared only
   AFTER `terminateChildTree` has actually run.

Also: a non-terminal session is settled `cancelled` BEFORE its reducer is disposed, then
`finalize`d — glm-5.3's minor (b), where the later exit found a disposed reducer and wrote
a `meta.json` still claiming the session was running.

Probe uses a real tree: a child that `trap`s SIGTERM holding a `/bin/sh` grandchild that
also hard-ignores it. `cancel_session`, then `shutdownAll` INSIDE the 5 s window.
Pre-fix (mutation D9): both child and grandchild survive. Fixed: both dead.

## Not done, deliberately

- **`terminalReason === "completed"` as a completion requirement** — disputed above (D3).
- **glm-5.3 minor (d), a second `result` with no intervening `user` frame is a swallowed
  self-transition.** Adding `repeat: true` at `applyResultFrame`'s transition would surface
  it, but it also emits a wire frame for every duplicate `result` in any state, and this
  transport only ever produces one `result` per input frame. Left alone rather than trading
  a silent edge case for guaranteed wire noise; worth revisiting if a real stream ever
  shows back-to-back results.

## V. Verification, verbatim

```text
$ bun run typecheck
$ bun run --cwd packages/cli typecheck && bun run --cwd packages/macos-bridge typecheck
$ tsc --noEmit
$ tsc --noEmit -p tsconfig.typecheck.json
(clean, both packages)

$ bun run --cwd packages/cli lint
Checked 481 files in 346ms. No fixes applied.
Found 881 warnings.
lint exit=0
(881 = the pre-review baseline; ZERO diagnostics in session-manager.ts or
 stream-json-reducer.ts — `finalize` was split into clearTimers/flushDecoders/
 writeArtifacts to stay under the cognitive-complexity rule)

$ CLAUDISH_SKIP_LIVE_E2E=1 bun test packages/cli/src/channel/
 62 pass
 4 skip
 0 fail
 229 expect() calls
Ran 66 tests across 5 files. [10.69s]

$ CLAUDISH_SKIP_LIVE_E2E=1 bun test packages/cli/src/team-orchestrator.test.ts -t "pinned spawn identity"
 2 pass
 53 filtered out
 0 fail

$ CLAUDISH_SKIP_LIVE_E2E=1 bun test
 2905 pass
 25 skip
 0 fail
 12488 expect() calls
Ran 2930 tests across 174 files. [86.09s]
```

### Probes

```text
$ bun run probes/probe-review-fixes.ts
PASS  D1 exit-before-drain keeps the verdict honest  — completed
PASS  D1 the in-flight answer tail is not dropped
PASS  D1 meta.json records the same verdict  — completed
PASS  D2 rejects -v / --verbose / -m / --model / --stdin / -q / --quiet / -y /
          --auto-approve / -p / --print / --output-format / --output-format=json /
          --input-format / --session-id / --include-partial-messages /
          --include-hook-events / --replay-user-messages          (18 assertions)
PASS  D2 accepts unrelated --print-argv / --model-opus / --model-sonnet / --agents / --effort
PASS  D3 turn 1 is accepted
PASS  D3 turn 1 completes normally
PASS  D3 turn 2 is accepted
PASS  D3 a stale result does not complete the next turn  — status=failed
PASS  D3 the failure names the missing result frame
PASS  D4 events.jsonl carries no credential
PASS  D4 events.jsonl shows the redaction
PASS  D4 events.jsonl is bounded  — 4204110 bytes for ~5 MB written
PASS  D4 the truncation is recorded in the log
PASS  D4 stderr.log carries no credential
PASS  D5 no replacement characters  — "日本語のテキスト 🚀 done"
PASS  D5 the split character survives
PASS  D6 state stays running after the batch window  — running
PASS  D6 no phantom tool_executing notification  — last event = running
PASS  D7 spawn failure writes meta.json
PASS  D7 the record says failed  — failed
PASS  D7 no leaked output.log write stream
PASS  D8 stderr is bounded  — 65592 chars for ~2.6 MB written
PASS  D8 startup diagnostic (head) survives
PASS  D8 death rattle (tail) survives
PASS  D8 the session is readable immediately after it ends
PASS  D8 the terminal session is evicted after its retention window  — 0 retained

ALL PROBES PASS

$ bun run probes/probe-shutdown-orphan.ts
PASS  child and grandchild are running  — pids 8638,8639
PASS  cancelSession accepted
PASS  the child ignored SIGTERM, as designed
PASS  D9 the child is dead after shutdownAll
PASS  D9 the grandchild is not orphaned

ALL PROBES PASS
```

### Mutation proof

Applied with `bun run probes/mutate.ts <id> apply`, reversed with `… revert`. Every
reversal is verified by the anchor check in the script (it exits 2 if the file is not in
the expected state), and the full channel suite is green afterwards.

| mutation | what it restores | observed failure |
|---|---|---|
| `D1` | classify on `exit`, no drain | D1 ×3 — `status=failed`, answer tail lost, `meta.status=failed` |
| `D2` | the hand-listed reserved set | D2 ×11 — `-v`, `-m`, `--model`, `--stdin`, `-q`, `--quiet`, `-y`, `--auto-approve`, the three include/replay flags all ACCEPTED |
| `D2w` | a `startsWith` matcher "to catch aliases" | D2 ×3 — `--print-argv`, `--model-opus`, `--model-sonnet` falsely REJECTED |
| `D3` | session-global result witness | D3 ×2 — turn 2's silent death reported `completed` |
| `D4` | raw `events.jsonl` | D4 ×2 — the `sk-ant-…` key on disk verbatim |
| `D4b` | raw `stderr.log` | D4 ×1 — same key in `stderr.log` |
| `D5` | `chunk.toString("utf-8")` | D5 ×2 — `"���本語のテキスト 🚀 done"` |
| `D6` + `D6b` | timer with no state guard and no reset on transition | D6 ×2 — `running` → `tool_executing`, phantom notification (either guard alone suppresses it, so both are needed to reproduce) |
| `D7` | the original `settle` + `dispose` error handler | D7 ×2 — no `meta.json`, `outputLogStream` leaked |
| `D8` | `entry.stderr += chunk` | D8 ×1 — 2 621 465 chars held |
| `D8b` | no `sessions.delete` | D8 ×1 — 1 session retained past its window |
| `D9` | `!proc.killed` liveness + cleared escalation | D9 ×2 — child AND grandchild survive `shutdownAll` |

### Files changed by the review fixes

| File | Change |
|---|---|
| `packages/cli/src/channel/session-manager.ts` | D1 (`handleExit`/`onPipeClosed`/`finalize`, `clearTimers`, `flushDecoders`, `writeArtifacts`), D2 (derived reserved set + aliases), D3 (`beginTurn` in `writeFrame`), D4 (`appendEventLog`, redacted `stderr.log`), D5 (`decodeChunk` + per-pipe `StringDecoder`), D7 (spawn-error path), D8 (`recordStderr`, `scheduleEviction`, `evictOldestTerminal`), D9 (`shutdownAll` via `terminateChildTree`; `killed`→`exitCode/signalCode` in the timeout path and `cancelSession`) |
| `packages/cli/src/channel/stream-json-reducer.ts` | D3 (`beginTurn`, `subtype`-based error), D6 (`resetToolBatch` on transition + timer state guard), tool_use BLOCK counting |
| `packages/cli/src/channel/types.ts` | `SessionManagerOptions.terminalRetentionMs` |
| `ai-docs/architecture/mcp-channel.md` | Drain-not-exit finalisation, the derived reserved set and the exact-token rule, turn-scoped witness, redaction/bounds, eviction, `shutdownAll`; Testing section rewritten (the "awaiting a rewrite" note was stale — G1–G7 exist) |

---

# Phase 3 — diagnostics as API

`mcp-server.ts` was released by the concurrent session at `471bbf7`, so the three items
§8 listed as blocked are now done, plus the one it did not list (`transcriptPath`).

## 1. Files changed

| File | Change |
|---|---|
| `packages/cli/src/mcp-server.ts` | `["timeout","failed"]` in `EVENT_TO_TASK_STATUS`; the `get_diagnostics` tool, appended last; the terminal-failure notification hint now covers `timeout` and names `get_diagnostics`; `INSTRUCTIONS` documents the `timeout` event and step 5 of the workflow |
| `packages/cli/src/channel/types.ts` | `ChannelEventType = SessionStatus` (the `TODO(phase3)` is discharged); `ReducerEvent.sessionStatus` DELETED; `SessionInfo` gains `spawnModel` and `transcriptPath` |
| `packages/cli/src/channel/stream-json-reducer.ts` | `TERMINAL_STATES` and `LEGAL_TRANSITIONS` gain an absorbing `timeout` row; `settle()` drops the `sessionStatus` override; `onSemanticLine(line, label)` carries `type:subtype` so the ring need not re-parse |
| `packages/cli/src/channel/session-manager.ts` | `CLAUDISH_UPSTREAM_ERROR_LOG` in the child env; `getDiagnostics` rewritten (returns `SessionDiagnostics`); `stderrForDiagnostics`; the event ring (`recordEvent`); `readTailLines`; `recordNote` split out of `recordProse`; `refreshTranscriptPath`; the timeout path settles `"timeout"` |
| `packages/cli/src/session/session-discovery.ts` | `transcriptPathFor(cwd, uuid)` — the repo's ONLY `realpathSync` |
| `packages/cli/src/handlers/shared/upstream-error-capture.ts` | `redactSecrets` at write time, before truncation |
| `packages/cli/src/channel/index.ts` | exports `SessionDiagnostics`, `DiagnosticEvent` |
| `ai-docs/architecture/mcp-channel.md` | the timeout/wire convergence, the three diagnostics sections, the 13-tool roster, the double roster pin |

No test file and no `test-helpers/*` file was touched. `team-stream-capture.ts` is untouched
(the other session's `rate_limit_event` addition stands).

## 2. I DID widen the wire event. Why, and what it cost

The sequencing worked: with `["timeout","failed"]` present, `"timeout"` on the wire is
strictly better than the `"failed"` it replaces, and the ONE risk the TODO named is gone.
The remaining risks were checked rather than assumed:

- **`mapEventToTaskStatus`** — the whole reason for the exclusion. Now correct; mutation-
  proven below (remove the key → a dead session reports `status: "working"`).
- **Client-side enum validation** — none exists. `meta.event` becomes an attribute string on
  the rendered `<channel …>` tag; the documented client constraint is on meta KEY names
  (`[a-zA-Z0-9_]+`), not values.
- **The `failed`-only report_error hint in the bridge** — would have silently disappeared for
  timeouts. Widened to `failed || timeout`, and both now point at `get_diagnostics` first.
- **`INSTRUCTIONS`** — enumerated six events to the agent. `timeout` added, or the wire would
  have carried a value the agent was never told about.
- **`ReducerEvent.sessionStatus`** — its only user was the divergence. Deleted rather than
  left as a hook with no implementation; `LEGAL_TRANSITIONS` gets a real absorbing `timeout`
  row instead of laundering it through `failed`.

Cost: **G2 fails, exactly as forecast.** G1's three assertions in the same test still pass.

```text
$ CLAUDISH_SKIP_LIVE_E2E=1 bun test packages/cli/src/channel/session-manager.test.ts -t "G1/G2"
370 |     expect(info.status).toBe("timeout");
371 |     expect(meta.status).toBe("timeout");
372 |     expect(info.exitCode).toBe(0);
373 |     expect(meta.exitCode).toBe(0);
374 |     expect(terminalWireEvents).toEqual(["failed"]);
                                     ^
error: expect(received).toEqual(expected)

  [
-   "failed",
+   "timeout",
  ]

- Expected  - 1
+ Received  + 1

      at <anonymous> (…/packages/cli/src/channel/session-manager.test.ts:374:32)
(fail) SessionManager > G1/G2: timeout stays timeout in memory and meta while the wire reports failed
```

Line 375, `expect(events.some((event) => event.type === "timeout")).toBe(false)`, is the
other half and will invert too; the test aborts at 374 before reaching it. The test's own
name and its comment ("the current seven-value channel wire") both need rewriting, not just
the two expectations — G1 and G2 are no longer the same fact.

## 3. TWO MORE tests fail, and they are supposed to

`ai-docs/architecture/mcp-channel.md` states the rule: *"The roster is pinned by an EXACT
frozen array in `mcp-session/e2e-sessions.test.ts`, so adding or removing a tool without updating
that test fails CI. That is deliberate: it is a wire contract."* `get_diagnostics` is a new
tool, so both pins fire. This is the guard working, not collateral damage — but it is a
second and third test change the task did not anticipate, and it is not mine to make.

```text
(fail) Group 1: MCP Protocol — channel capability > lists the exact public tool roster
    "create_session",
+   "get_diagnostics",
    "get_output",
  at …/packages/cli/src/mcp-session/e2e-sessions.test.ts:87:19

(fail) Group 1b: MCP Protocol — channel-only tools > lists only the 5 channel tools when CLAUDISH_MCP_TOOLS=channel
    "create_session",
+   "get_diagnostics",
    "get_output",
  at …/packages/cli/src/mcp-session/e2e-sessions.test.ts:262:19
```

The second one's TITLE also needs changing — there are six channel tools now, not five.

## 4. What `get_diagnostics` returns, and the two judgement calls in it

Beyond the requested fields (`terminalReason`, `exitCode`, `outputBytes`, `elapsedSeconds`,
`timeoutSeconds`, `transcriptPath`, `model` + `spawnModel`, tokens/cost/tools, the event
tail, the stderr tail) it also returns `sessionDir`, `eventLogPath`, `upstreamErrorLogPath`,
`anomalies`, `stderrFiltered`, `stderrTruncated` and `eventsTotal` — every one of which
answers "is what I am looking at the whole of it, and where is the rest".

### 4.1 stderr: filtered on success, RAW on everything else

The task's nuance, implemented as team states it at `team-orchestrator.ts:447-455`. The
`meaningfulStderr` filter runs ONLY for `status === "completed"`; any other status returns
the raw buffer. `stderrFiltered` reports which rule ran, so a reader is never guessing.

Both are redacted here, which they were NOT before: `entry.stderr` is the unredacted
in-memory buffer (only the on-disk `stderr.log` was redacted at write time), and the old
`getDiagnostics` returned `entry.stderr.slice(...)` verbatim. That was a live credential leak
into an agent's context waiting for a tool to call it.

### 4.2 `outputBytes` was wrong, and the probe caught it

`finalize` records its `[claudish] <verdict>` explanation through `recordProse`, which
increments `proseBytes`. So the field that proves a session produced nothing read **312 for
a 0-byte session** — the diagnostic falsifying the metric it exists to explain. Split into
`recordNote` (scrollback + `output.log`, no accounting) vs `recordProse` (accounting too).
`get_output` is unchanged: the explanation is still in the prose an agent reads.

### 4.3 The event ring is in memory, not a tail-read of `events.jsonl`

200 frames × 800 chars, `type:subtype`-labelled, redacted once and shared with the file.
It keeps filling after the file's 4 MB cap, because the frames just before a death are
precisely the ones a post-mortem wants and a capped FILE must not also blind the API.
`event_limit` is clamped to `[0, 200]`.

## 5. `transcriptPath`, and where the realpath actually bites

`transcriptPathFor` lives in `session/session-discovery.ts` — the module that documents the
layout and already exports `PROJECTS_DIR` and `slugForPath`. It is the repo's only
`realpathSync`. `refreshTranscriptPath` re-derives only when `cwd + uuid` changes, so the
syscall does not run on every `list_sessions`.

**Measured, and worth knowing before anyone "simplifies" it:** the child's own
`system:init.cwd` is ALREADY resolved, because Node's `process.cwd()` resolves symlinks. So
once the child has spoken, a raw slug of the reported cwd happens to be right. The realpath
matters for the window BEFORE `system:init` — and that window is exactly where a startup
failure lands, which is the case this whole phase exists for. Mutation P3 shows it: with
`realpathSync` removed the pre-init path is
`…/projects/-var-folders-…-T-chan-p3-symlink-XXXX/<uuid>.jsonl`, a directory that does not
exist, instead of `-private-var-folders-…`.

## 6. `CLAUDISH_UPSTREAM_ERROR_LOG` — and a leak that came with it

Set unconditionally per session, overriding any inherited value: the records carry no session
id, so a shared path interleaves up to 20 concurrent sessions into one unattributable file,
and `get_diagnostics` publishes this path as the session's own.

`captureUpstreamError` did **not** redact. That was defensible while it was opt-in and the
user named the path; it is not, now that claudish sets the path for every channel session and
returns the contents to an agent. A 401/403 body routinely echoes the credential that failed.
Redaction added at write time (the codebase's stated rule — the only point that covers every
reader) and BEFORE truncation, so a cut cannot leave a usable prefix of a key in the file.
Its six existing tests are untouched and still pass.

## 7. Verification, verbatim

```text
$ bun run typecheck
$ bun run --cwd packages/cli typecheck && bun run --cwd packages/macos-bridge typecheck
$ tsc --noEmit
$ tsc --noEmit -p tsconfig.typecheck.json
(clean, both packages)

$ bun run --cwd packages/cli lint
Checked 481 files in 115ms. No fixes applied.
Found 881 warnings.
lint exit=0
(881 = the unchanged baseline; ZERO diagnostics in any file this phase touched)

$ bun run build
  index.js  2.80 MB  (entry point)      # CLI
  index.js  3.16 MB  (entry point)      # macOS bridge

$ CLAUDISH_SKIP_LIVE_E2E=1 bun test packages/cli/src/channel/
(fail) SessionManager > G1/G2: timeout stays timeout in memory and meta while the wire reports failed
(fail) Group 1: MCP Protocol — channel capability > lists the exact public tool roster
(fail) Group 1b: MCP Protocol — channel-only tools > lists only the 5 channel tools when CLAUDISH_MCP_TOOLS=channel
 59 pass
 4 skip
 3 fail
Ran 66 tests across 5 files. [10.00s]

$ CLAUDISH_SKIP_LIVE_E2E=1 bun test packages/cli/src/team-orchestrator.test.ts -t "pinned spawn identity"
 2 pass
 53 filtered out
 0 fail

$ CLAUDISH_SKIP_LIVE_E2E=1 bun test
 2905 pass
 25 skip
 3 fail
Ran 2933 tests across 174 files. [80.12s]
```

The 3 failures are the same 3 in both runs. Nothing else moved: 2905 pass vs the phase-2
baseline's 2905, with 3 tests transferred from pass to fail and 3 new probe-covered
behaviours added.

## 8. Probes

`probes/probe-phase3.ts` (in-process) and `probes/probe-phase3-mcp.ts` (drives the REAL MCP
server over stdio JSON-RPC — the map, the bridge and the tool registry are only observable
through a client). `probes/fake-claudish-upstream.ts` is a `CLAUDISH_BIN` stand-in that calls
the REAL `captureUpstreamError` from the tree, so what is proven is the production function
writing to the path the transport handed it.

```text
$ bun run probes/probe-phase3.ts
PASS  P2 the silent exit-0 is reported failed  — failed
PASS  P2 the incident's only diagnostic reaches the API  — "[claude-code:unrecognized_model] {\"model\":\"cx@gpt-5.6-sol\",\"query_source\":\"sdk\"}\n"
PASS  P2 a failure returns RAW stderr, not the meaningfulStderr filter  — stderrFiltered=false
PASS  P2 the tail is not the empty string meaningfulStderr would have produced
PASS  P2 outputBytes says the session produced no answer  — 0
PASS  P2 both halves of the resolved chain are visible  — ollama@llama3.2 → ollama@llama3.2-pinned
PASS  P2 the timeout it was measured against is reported  — 60
PASS  P2 elapsedSeconds is present  — 0
PASS  P2 exitCode is the honest 0  — 0
PASS  P2 sessionDir names a real directory
PASS  P3 the probe's cwd really is reached through a symlink (else nothing is proven)  — /var/folders/…/T/chan-p3-symlink-JwU9KL → /private/var/folders/…/T/chan-p3-symlink-JwU9KL
PASS  P3 the path is known BEFORE the child speaks, from the realpath slug  — /Users/jack/.claude/projects/-private-var-folders-…-T-chan-p3-symlink-JwU9KL/0b1d73a8-….jsonl
PASS  P3 and it is NOT the raw-cwd slug, which names a directory that does not exist
PASS  P3 the uuid is re-derived from the child's system:init  — fake-modes-0000
PASS  P3 transcriptPath follows the confirmed uuid
PASS  P3 meta.json carries it too, so a post-mortem needs no process
PASS  P4 the child inherits a per-session CLAUDISH_UPSTREAM_ERROR_LOG  — …/<sid>/upstream-errors.jsonl
PASS  P4 get_diagnostics publishes the same path the child wrote to
PASS  P4 the real captureUpstreamError produced a record  — 1
PASS  P4 the record carries the upstream status
PASS  P4 and the BODY that distinguishes a rate limit from a quota wall
PASS  P4 … while `redactSecrets` in the capture path keeps the credential out
PASS  P4 the session itself still completed normally  — completed
PASS  P4 a COMPLETED session gets the filtered stderr (team's success-path rule)
PASS  P5 ring events are labelled type:subtype  — system:init,assistant,result:success
PASS  P5 every preview is bounded at EVENT_PREVIEW_CHARS
PASS  P5 eventsTotal agrees with the ring for a short session  — 3/3
PASS  P5 event_limit is honoured
PASS  P5 event_limit 0 omits them
PASS  P5 an absurd event_limit is clamped to the ring size

ALL PROBES PASS

$ bun run probes/probe-phase3-mcp.ts
PASS  P1 get_diagnostics is registered as an MCP tool
PASS  P1 it is appended at the END of the tool list  — create_session,send_input,get_output,cancel_session,list_sessions,get_diagnostics
PASS  P1 its schema requires session_id
PASS  P6 create_session returned a session id  — a12dc130
PASS  P6 the wire carries `event: timeout` — it used to be laundered into `failed`  — timeout
PASS  P6 EVENT_TO_TASK_STATUS projects it to SEP-1686 `failed`  — status=failed
PASS  P6 and NOT the `?? "working"` fallthrough that reported a dead session as alive
PASS  P6 no `failed` frame is emitted alongside it  — timeout
PASS  P7 get_diagnostics reports the timeout verdict  — timeout
PASS  P7 … against the timeout it was measured by  — 12
PASS  P7 … with a resolved transcript path
PASS  P7 … and the per-session upstream error log
PASS  P7 … and the requested model  — ollama@llama3.2
PASS  P7 … and the pinned spawn model field  — null
PASS  P7 an unknown session is a clean tool error, not a crash

ALL PROBES PASS
```

### Mutation proof

Applied with `bun run probes/mutate.ts <id> apply`, reversed with `… revert`; every reversal
is verified by the script's anchor check, and both probes are green after every revert.

| mutation | what it restores | observed failure |
|---|---|---|
| `P1` | `EVENT_TO_TASK_STATUS` without the `timeout` key | P6 ×2 — the timed-out session reports SEP-1686 `status: "working"`, i.e. still alive |
| `P2` | `meaningfulStderr` on every path | P2 ×3 — `stderrTail` is `""` for the exact incident the tool exists to explain |
| `P3` | slug the cwd as handed to us, no `realpathSync` | P3 ×2 — `-var-folders-…` instead of `-private-var-folders-…`, a directory that does not exist |
| `P4` | `CLAUDISH_UPSTREAM_ERROR_LOG` left unset | P4 ×5 — child env `null`, zero records, nothing to read back |
| `P5` | the failure note counted as model output | P2 ×1 — `outputBytes` 312 for a session that produced nothing |
| `P6` | `captureUpstreamError` without redaction | P4 ×1 — `sk-ant-api03-PROBESECRET` verbatim in `upstream-errors.jsonl` and in the tool's reply |

**`mutate.ts` bit back once, and the trap is worth recording.** `P1`'s first `broken` anchor
was the bare `]);`, which is not unique in `mcp-server.ts` — `String.replace` put the
reverted key back inside `resolveToolGroups`, producing a file that still ran and a probe
failure indistinguishable from "the mutation survived the revert". The anchor now carries the
preceding comment line. Any future mutation anchor must be unique in its file.

## 9. Left undone, deliberately

- **A client-side agent-name check in `create_session`** (§4.4). Still open. It is a
  different concern from diagnostics and wants `assertAgentAvailable` semantics, which the
  other session has just been changing.
- **Reading `events.jsonl` back through the tool.** `get_diagnostics` names the path but
  returns the in-memory ring. A file-backed `get_events(session_id, offset)` would serve a
  session evicted from the map 30 minutes on; nothing needs it yet.
- **`ChannelEvent.type` is still `string`.** Typing it `ChannelEventType` would make the
  bridge's event handling exhaustive. Out of scope, and it touches every notifier.
