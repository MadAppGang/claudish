# Team lifecycle — why nothing kills a slot

`team` spawns N Claude Code sessions and collects their answers. This file
records why it has no deadline, why `run` does not block, and who is allowed to
terminate a slot.

## The measurement that removed the deadline

Session `team-20260827-0015`, five models, `timeout: 600`. Two completed, three
were killed. All three killed slots were working at the moment they died:

| Slot | Tool calls | Output tokens | State when killed |
|---|---|---|---|
| `02` grok-4.6 | 45 Read, 7 Bash | 2,773 | mid-analysis |
| `03` kimi-k3 | 13 Bash, 8 Read | 10,198 | mid-verification |
| `04` qwen3.8-max | 24 Bash, 10 Read | 30,557 | starting a probe |

Two observations from `status.json`, both measured rather than inferred.

**The kills were on a 60-second grid, not a deadline.** Measured from the run's
own `startedAt`, every kill landed within 133 ms of a 60 s multiple — 659.867 s,
779.879 s, 1139.901 s. The two COMPLETED slots landed at arbitrary offsets
(−4.05 s, −2.15 s from the nearest tick). That grid was `GRACE_INTERVAL_MS`, the
watcher's poll cadence. An earlier reading of the same data concluded that kills
tracked sibling completions; they did not. Two completions happened to fall a few
seconds before ticks that were going to fire regardless.

**The progress signal could not see work.** The watcher read `updated_at` from
`stats/<id>.json`. Every write to that file comes from `TokenTracker.writeFile`,
whose call sites are all usage-recording paths — a response arriving from a
provider. There is no timer. So the timestamp freezes for the entire duration of
a local tool call, and a slot running `go test ./...` is indistinguishable from a
wedged process. Cross-checking the recorded `updated_at` against the kill times
confirms it exactly: idle at kill was 90.6 s, 108.2 s, 102.3 s against a 90 s
threshold. Slot `02` missed surviving by 0.6 seconds.

## Why a stall detector was never needed

Claude Code bounds its own tool calls. The `Bash` tool has a timeout (default
120 s, maximum 600 s), and Claude Code emits
`Background tasks still running after 600s; terminating`, which
`team-orchestrator.ts` already parses as `BG_CEILING_RE`.

A tool call inside the child cannot hang forever. A claudish-side tool-stall
detector guarded a condition the harness prevents.

## What replaced it

**Nothing terminates a slot on a timer.** `TeamRunOptions.timeout`,
`graceExtension`, `maxGraceSeconds` and `stallSeconds` are gone, along with the
watcher, `timeoutModel`, and the token-file progress read.

**Silence is reported, not judged.** Each child's raw stdout and stderr writes
stamp a timestamp — a listener separate from the answer capture, because those
ask different questions. Capture asks "is this an answer?" and says no to a
`tool_progress` heartbeat; liveness asks "is anything alive?" and the same frame
says yes. `teamSlotIdleSeconds()` publishes the result, and `mode: "status"`
returns it as `idle_seconds_by_slot`.

Frames keep arriving during a long tool call — Claude Code emits `tool_progress`
heartbeats every 30 s — which is exactly why this signal stays honest where the
token-flow timestamp did not.

**The liveness maps describe RUNNING slots only.** `idle_seconds_by_slot`,
`activity_by_slot` and `live_output_bytes_by_slot` skip any slot whose `state` is
not `RUNNING`; an exited slot's outcome is its `state`. The run stays registered
until its LAST slot settles, so before 2026-09-12 an exited slot kept answering:
activity frozen at `waiting_for_input`, idle counting up from its exit. Measured in
a real status payload: `completedAt + idle_seconds` landed on the poll time for
both finished slots (idle 57 s and 571 s), while the third slot was still working.
A caller read `waiting_for_input` as a slot that needed an answer, which `team`
has no way to send. A slot now never reports `waiting_for_input` at all:
between its `result` and its exit it reads `finishing` (see below).

**The caller decides, and `cancel` is how it acts.** `cancelTeamRun` is the only
thing that kills a slot. It kills the process GROUP: `claudish` is a launcher
that runs the real CLI under Bun, which runs `claude`, so signalling the direct
child reaches only the launcher and leaves the tree billing and holding the
response pipe open.

## `outputSize` is not a progress signal, and callers read it as one

`outputSize` is written exactly once per slot, in `finish()`, so a RUNNING slot
carries the `0` it was initialised with for its whole life. This is correct — the
field means "size of the final answer" and there is no final answer yet — and it
is also the single most misread number the tool emits.

Measured 2026-09-08, session `dev-feature-advisor-any-model-20260909-0001`: an
orchestrator polling a four-slot review panel saw

```json
"01": { "state": "RUNNING", "exitCode": null, "outputSize": 0 }
```

against a `startedAt` twenty-two minutes old, and told the user the slot had
produced nothing in twenty-two minutes. It had produced plenty;
`idle_seconds_by_slot` for that slot was 2. The orchestrator caught itself on the
next poll and had to correct the report in front of the user.

Nothing in the payload contradicted the misreading. The `note` explained
`idle_seconds_by_slot` and `activity_by_slot` and said nothing about
`outputSize`, and the skill's own step-2 example showed `outputSize` on the
COMPLETED slot and omitted it from the RUNNING one — the one place a reader could
have been warned instead skipped the case.

**The fix publishes the number that was already being counted.**
`ModelRuntime.getByteCount()` has always tracked answer bytes as they arrive, in
the same unit `outputSize` ends up holding (recovered prose, not raw
stream-json). `teamSlotLiveBytes()` exports it and `mode: "status"` returns it as
`live_output_bytes_by_slot`. A running slot now has a true volume number beside
its true liveness numbers.

**`outputSize` itself was deliberately not changed.** Making it report live bytes
while RUNNING would have made the misleading number true, at the cost of the one
distinction a caller actually needs: `formatTeamResult` and `classifyRunOutput`
both read `outputSize` as final-answer size, and an EMPTY slot is defined by that
field being small. Overload it and `0` no longer separates "still working" from
"exited having produced nothing". One name, one meaning.

**The note is keyed on RUNNING, not on liveness.** The previous note appeared only
when `teamSlotIdleSeconds()` returned non-null, i.e. only for runs this server
spawned. A run whose server restarted under it still shows RUNNING slots from
`status.json`, with all three liveness maps null — which is precisely a reader
about to misjudge an `outputSize` of 0, and now the one who most needs telling.
The not-live wording names no liveness field, because naming a null field sends
the reader after evidence that is not there.

Guarded by `packages/cli/src/team-status-payload.test.ts`. The load-bearing
assertion is the ordering one: `outputSize` must appear in the note BEFORE
`live_output_bytes_by_slot`. A plain "does the note mention outputSize" check
survives gutting the warning, because the remedy clause mentions the field too;
the ordering check does not.

## Why `run` does not block

A team slot is a full Claude Code session and can legitimately work for a long
time. Holding a tool call open for that duration makes the run's length the MCP
client's problem: a client aborts a call that emits nothing for its idle window,
and a real `team` run died at exactly 1800 s for that reason. The keepalive
(`notifications/progress`, the only notification measured to reset that timer)
was built to defeat it.

`startModels` returns as soon as the children exist, handing back a `TeamHandle`
with the team session id and a model-to-slot map. The run continues in the
background; the caller polls `mode: "status"`. This removes the reason the 1800 s
ceiling ever mattered rather than working around it.

`runModels` remains as the blocking form, for `run-and-judge` — a pipeline
cannot judge answers that do not exist yet.

### The run's record in the sessions directory, ended exactly once

Returning early has a cost: the run's completion reaches the caller only through
a channel frame, and Claude Code drops channel frames unless the session named
claudish in `--channels`. The run's own `status.json` sits wherever the caller
pointed `path`, which no outside observer knows. Review panels finished unseen
for days this way. So `team(mode:"run")` also writes a record into the sessions
directory the magus `claudish` plugin monitor already watches:

- `<sessionsDir>/team-<8 hex>/spawn.json` — `kind: "team"`, `teamPath`, `slots`,
  `hostPid`, `mcpPid` (and `launcherPid`, `parentClaudeSessionId` when they
  apply), written by `SessionManager.recordTeamRun` BEFORE `startModels`; a throw
  fails the call with nothing started. The `run` result carries the id as
  `monitor_record`.
- `<sessionsDir>/team-<8 hex>/meta.json` — `{kind:"team", status, startedAt,
  completedAt, elapsedSeconds, slots, ok, failed, cancelled}` plus
  `reason: "start-failed"` when the run never started; written atomically by
  `finishTeamRun`, which never throws and keeps the first outcome it managed to
  write — a failed write does not use up the record's one end.

**The end is wired INTO `startModels`, not after it.** `TeamRunOptions.onSettled`
is called from `done`'s `finally`, after the settled `status.txt` render, inside
its own `try`. Read inside `startModels`, it exists before the first child does,
so a run that settles at once and a slow one take the same path. A settle hung
on `handle.done.then(…)` in the handler would depend on code that runs after
`startModels` returns, and would never be installed when `startModels` throws.

**A throw inside the spawn loop kills what it already spawned.** The ticker, the
registry entry and `done` are all built after the loop, so a synchronous
`spawn()` error or a failed `status.json` write for slot N used to leave slots
1..N-1 running and billing, unreachable, with the SIGINT handler still installed.
The loop's `catch` stops every spawned slot's process group with
`terminateChildTree` — SIGTERM, then SIGKILL after `TERMINATE_GRACE_MS`, as
`cancel_session` does — and waits for that before it removes the SIGINT handler
and rethrows. SIGTERM alone left a slot that traps it running and billing under
a record that already said `start-failed`. The handler's `catch` then writes
`failed`, `reason: start-failed` with counts from `status.json`
(`summarise(readTeamStatus(path))`), and rethrows the ORIGINAL error. `spawnChild`
is the seam a test uses to make one spawn throw, `terminateGraceMs` the one that
shortens the grace period (`team-start-failure.test.ts`).

**The record ends exactly once because the two paths cannot both run.**
`onSettled` is called only from `done`, and `done` is built after the spawn loop;
when the loop throws, `startModels` rejects without ever building it, however
fast the spawned slots exit. When the loop completes, nothing after it throws, so
`startModels` resolves and the handler's `catch` never runs. And `finishTeamRun`
keeps its first outcome, so a second call could not overwrite it anyway.
`team-run-settles-once.test.ts` pins all three on the real code.

`summarise` counts `COMPLETED` as ok, a `cancelled` reason as cancelled, and every
other state — `PENDING` and `RUNNING` included — as failed; the verdict is
`completed` when any slot is ok (the channel frame's rule), `cancelled` when all
were cancelled. Only `run` writes a record: `run-and-judge` returns its verdict in
the call, and `judge`/`status`/`cancel` start no work. `loadDiskRecord` returns
null for a `kind: "team"` directory, so session tools answer a `team-*` id as
unknown and `list_sessions` (in-memory only) never lists one.

### Blinding is unaffected

`run` returns display model → slot id. That does not weaken blind judging. The
manifest is shuffled so the judge CHILDREN, which read `response-<id>.md` without
a manifest, cannot attribute answers. The orchestrating caller has always seen
the mapping — `status.txt` prints model names beside slot ids.

## One parser, two consumers

`team` drove `createAssistantTextCapture()` directly and hand-rolled everything
around it. The channel wrapped that SAME capture in `StreamJsonReducer` and added
what team lacked: a state machine that tells thinking from tool execution, and
`sawResult` — the child's own terminal `result` frame, a real completion oracle
where exit 0 is not (`claude -p` exits 0 on API errors too).

Two implementations of one job existed because `team-orchestrator.ts` dates from
2026-03-20 and `stream-json-reducer.ts` from 2026-08-22. `team` now feeds the
reducer, and `StreamJsonReducer` is the only production consumer of the capture.
`feed()` and `end()` return exactly what `capture.write()`/`capture.end()`
returned, so `byteCount`, `stdoutTail` and `classifyRunOutput` were unaffected by
the swap.

### The one behaviour that had to be made explicit

The two parsers disagreed on a line that is valid JSON but is NOT stream-json
vocabulary — a bare array, a stray object:

| Line | capture | reducer (before) |
|---|---|---|
| not JSON (`[API Error: …]`) | passthrough | passthrough |
| recognised frame | recover prose | recover prose |
| JSON, unrecognised | **passthrough** | **dropped** |

Both behaviours are correct for their own consumer. A channel session's stdout is
pure stream-json, so a stray JSON object is machine noise and keeping it would
pollute the answer. A team slot's `response-<id>.md` is the only place a reader
ever sees what the child printed, and this project has already lost real answers
to a parser deciding something was not worth keeping (`team-capture.md`).

So it is an option — `keepUnrecognizedJson`, default false, and `team` passes
true — rather than one rule imposed on both. Note the asymmetry it resolves: an
UNPARSEABLE line was always kept ("it is the only place a reader would ever see
it"), so dropping *valid* JSON was the stricter rule, not the looser one.

This was caught by the `--print-argv` test, whose fake child prints a JSON array
to stdout: under the reducer's default the argv never reached the response file
and the slot was classified EMPTY.

### Team must settle the reducer itself

A `result` frame ends a turn, and the reducer asks its owner whether stdin stays
open (`onResult` returns `TurnEnd`). `team` closes stdin at spawn, so it always
answers `"stdin-closed"` and the slot moves to `finishing`, which only a terminal
state may follow. Before `finishing` existed, every `result` moved the reducer to
`waiting_for_input`, on the premise that stdin was still open — a premise that
never held for a slot — and until 2026-09-12 nothing settled the reducer after
that: it stayed in `waiting_for_input` after the child had exited.

`finish()` now settles it to the outcome it just recorded (COMPLETED → `completed`,
EMPTY or FAILED → `failed`, a cancelled slot → `cancelled`, TIMEOUT → `timeout`)
and only then disposes it. The dispose moved out of `finalizeCapture` because a
disposed reducer ignores `settle()`, and `finish()` runs later, off the output
stream's "close".

## Spawn plumbing: what was shared, and what was deliberately not

The obvious next step looked like making `team` a client of
`SessionManager.createSession`, so each slot would be a channel session
addressable by `get_output`, `get_diagnostics` and `cancel_session`. That was
evaluated and rejected. Reading what `createSession` actually does shows why:

- It calls `classifyRunOutput` with `minOutputBytes: 0` and NO `requirePattern`.
  Team's shape contract is the one signal that catches a voter which never voted,
  so team's policy would have to be pushed down into the session manager.
- `requirePattern` is matched against the FULL response, not the bounded tail, so
  the session manager would also need team's re-read-from-disk step.
- `session-manager.ts` already imports `classifyRunOutput` FROM
  `team-orchestrator.ts`. Adding team's options would complete the inversion: a
  channel session manager that knows what a blind-vote panel is.

The addressability was also worth less than it looked. `team` already answers the
same questions through `mode:"status"` and `mode:"cancel"`, so the session id
would have added convenience, not capability — at the price of that inversion,
plus a shared `maxSessions` cap and a second copy of every answer on disk.

What IS genuinely shared is the mechanism, and that was extracted:

- **`stdio-decode.ts`.** A `data` chunk ends at the pipe's read boundary, which
  can fall mid-codepoint. The channel decoded through a `StringDecoder` all
  along; team read with `chunk.toString()`, which replaces the dangling bytes
  with U+FFFD — permanently mangling any CJK character or emoji straddling a
  boundary in `response-<id>.md`, and mis-sizing `outputSize`. Both now share
  one decoder helper, one per pipe.
- **The upstream-error log.** `captureUpstreamError` is opt-in on
  `UPSTREAM_ERROR_LOG_ENV`, which team never set — so it was a guaranteed no-op
  for every team child, and the provider response body that separates a
  retryable rate limit from a hard quota wall was discarded as soon as it had
  been classified. Team now sets it per slot (the records carry no slot id, so a
  shared path would interleave models), and `ModelError.upstreamErrorLogPath`
  names the file only when one was actually written.
- **The stream-json parser**, covered above.

What remains team's own is what legitimately differs: a one-shot `--stdin` argv
against the channel's bidirectional `--input-format stream-json` (which exists so
`send_input` works), team's directory layout, its anonymised slot ids, and its
status file. Those are not duplication; they are two different jobs.

`SessionCreateOptions` did gain `sessionId`, `sessionDir`, `tokenFile` and
`keepUnrecognizedJson` while this was being evaluated. They are additive, tested,
and make the adoption route available later if the trade above ever changes.

## Coverage removed with the mechanism

Deleting the reaper deleted the tests that drove it: `team-timeout-termination`
(7 tests), `team-timeout-diagnostics` (1), and 2 of 9 in `team-timeout-repro`.
Two of those covered behaviour reachable only through the kill path — an answer
flushed during shutdown being recovered, and nothing being written after the run
returns. Equivalent coverage belongs against the agent-initiated cancel path.
