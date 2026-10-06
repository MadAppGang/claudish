# Team lifecycle — why nothing kills a slot

`team` spawns N Claude Code sessions and collects their answers. This file
records why it has no deadline, why `run` returns early, and who is allowed to
terminate a slot. Every slot is an interactive Claude Code in its own headless
magmux pane; the driver and its settle rule are in [`pane-session.md`](pane-session.md).

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
120 s, maximum 600 s). A tool call inside the child cannot hang forever, so a
claudish-side tool-stall detector guarded a condition the harness prevents.

Print mode also ended its own run with `Background tasks still running after
600s; terminating`, which team once parsed as `BG_CEILING_RE`. An interactive
pane has no such ceiling, and the pattern went with print mode. A background
SHELL is not awaited at all: the turn settles at Claude Code's own
`turn_duration`, the slot reports `background_shell_open: <command>` in its
`detail`, and the reap ends the shell (`pane-session.md`, D23). Background
AGENTS are awaited, with no bound.

## What replaced it

**Nothing terminates a slot on a timer once its prompt is accepted.**
`TeamRunOptions.timeout`, `graceExtension`, `maxGraceSeconds` and `stallSeconds`
are gone, along with the watcher, `timeoutModel`, and the token-file progress
read. The only bounds left are the pane's boot (90 s) and the admission of the
prompt (30 s), before any work exists (D10).

**Silence is reported, not judged.** A slot's `last_activity_at` is its last
screen change or transcript append, and `idle_seconds` counts from it — a signal
separate from the answer, because the two ask different questions. The answer
asks "what did the model say?"; liveness asks "is anything alive?". `mode:
"status"` returns it as `idle_seconds_by_slot`, and every `run.slots` row and
`team(mode:"list")` row carries it as `idle_seconds`.

The screen keeps changing during a long tool call — Claude Code rewrites its
working row (`✶ Simmering… (3s · ↓ 154 tokens)`) and the Bash timer every second
— which is exactly why this signal stays honest where the token-flow timestamp
did not.

**The liveness maps describe live slots only.** `idle_seconds_by_slot`,
`activity_by_slot` and `live_output_bytes_by_slot` skip any slot whose `state` is
terminal; a finished slot's outcome is its `state`. The run stays registered
until its LAST slot settles, so before 2026-09-12 an exited slot kept answering:
activity frozen at `waiting_for_input`, idle counting up from its exit. Measured in
a real status payload: `completedAt + idle_seconds` landed on the poll time for
both finished slots (idle 57 s and 571 s), while the third slot was still working.
A caller read `waiting_for_input` as a slot that needed an answer, which `team`
has no way to send.

**A slot never waits for input.** Between the model's last message and Claude
Code's end-of-turn record its activity reads `finishing` (typically while Stop
hooks run). A slot that stops on a question or a permission dialog it cannot
answer is FAILED `blocked` at once, with the question in its `detail` (D19):
team has no answering verb, so a blocked slot could never finish, and `judge`,
`run-and-judge` and the CLI would wait for it forever. When a `finishing` slot's
screen has been static with no Stop-hook row for 3 × 32 s, its activity reads
`finishing: turn_end_record_missing` and the status note tells the caller to
cancel it; nothing cancels it for them.

**The caller decides, and `cancel` is how it acts.** `cancelTeamRun` is the only
thing that ends a working slot. The slot is CANCELLED when the call returns; the
pane's reap finishes in the background: `close_pane {force:true}`, magmux through
its handle, then SIGTERM and SIGKILL on the pane's process GROUP after an
identity check. The group matters: `claudish` runs the real CLI under Bun, which
runs `claude`, with a Bash-tool grandchild below that, so signalling one process
leaves the rest billing. `team(mode:"cancel")` stops one slot (`slot`) or the
whole run and answers per slot `{state, changed}`.

## `outputSize` is not a progress signal, and callers read it as one

`outputSize` is written exactly once per slot, when it turns terminal, so a
RUNNING slot carries the `0` it was initialised with for its whole life. This is
correct — the field means "size of the final answer" and there is no final answer
yet — and it is also the single most misread number the tool emits.

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

**The fix publishes the number that was already being counted.** The pane's
snapshot carries `liveAnswerBytes`, the current turn's assistant text so far, in
the same unit `outputSize` ends up holding (answer prose). `mode: "status"`
returns it as `live_output_bytes_by_slot`. A running slot now has a true volume
number beside its true liveness numbers.

**`outputSize` itself was deliberately not changed.** Making it report live bytes
while RUNNING would have made the misleading number true, at the cost of the one
distinction a caller actually needs: `formatTeamResult` and `classifyRunOutput`
both read the final answer's size, and an EMPTY slot is defined by it being
small. Overload it and `0` no longer separates "still working" from "finished
having produced nothing". One name, one meaning.

**The note is keyed on RUNNING, not on liveness.** The previous note appeared only
when the liveness maps were non-null, i.e. only for runs this server spawned. A
run whose server restarted under it still shows RUNNING slots from
`status.json`, with all three liveness maps null — which is precisely a reader
about to misjudge an `outputSize` of 0, and now the one who most needs telling.
The not-live wording names no liveness field, because naming a null field sends
the reader after evidence that is not there.

Guarded by `packages/cli/src/team-status-payload.test.ts`. The load-bearing
assertion is the ordering one: `outputSize` must appear in the note BEFORE
`live_output_bytes_by_slot`. A plain "does the note mention outputSize" check
survives gutting the warning, because the remedy clause mentions the field too;
the ordering check does not.

## Why `run` does not wait for answers

A team slot is a full Claude Code session and can legitimately work for a long
time. Holding a tool call open for that duration makes the run's length the MCP
client's problem: a client aborts a call that emits nothing for its idle window,
and a real `team` run died at exactly 1800 s for that reason. The keepalive
(`notifications/progress`, the only notification measured to reset that timer)
was built to defeat it.

`startModels` returns once every slot has **left STARTING** (D9): its prompt was
accepted (RUNNING), or it failed boot or admission. It hands back a `TeamHandle`
with the `run_id`, the team session id and a model-to-slot map. The run continues
in the background; the caller polls `mode: "status"` (read `run.slots`) or
`mode: "list"`. This removes the reason the 1800 s ceiling ever mattered rather
than working around it.

**It does block through boot and admission, and only through them.** The bound
is boot 90 s + admission 30 s = 120 s, before any work exists, so nothing can be
lost to it; with the fake child a slot reaches RUNNING in 1.2–1.9 s. Returning any
earlier breaks a real consumer: the dev plugin's team gate polls until no slot is
RUNNING, so a slot still STARTING on its first poll would end the gate with zero
ballots. Boot and admission failures are therefore in the `run` answer itself.
Slots spawn 300 ms apart so N REPLs do not write `~/.claude.json` in the same
instant.

`runModels` remains as the blocking form, for `run-and-judge` — a pipeline
cannot judge answers that do not exist yet.

### The run registry, by `run_id`

Runs this process started are kept in memory keyed by `run_id`
(`<team_session_id>-<base36 start ms>-<6 hex>`), with an index of the newest run
per path. A path holds at most one ACTIVE run; `run` on an ACTIVE path is refused.
A SETTLED run (every slot terminal) stays listable and capturable for 30 minutes,
at most 20 of them, oldest evicted first. `status`, `cancel` and `capture` take an
optional `run_id`, which addresses THAT run while it is retained even after a newer
run reused the path; without one they address the newest run at `path`. After
eviction, or after a server restart, `status` still answers from `status.json`
(the newest run at the path only), with every liveness map null.

### The run's record in the sessions directory, ended exactly once

Returning early has a cost: the run's completion reaches the caller only through
a channel frame, and Claude Code drops channel frames unless the session named
claudish in `--channels`. The run's own `status.json` sits wherever the caller
pointed `path`, which no outside observer knows. Review panels finished unseen
for days this way. So `team(mode:"run")` also writes a record into the sessions
directory the magus `claudish` plugin monitor already watches:

- `<sessionsDir>/team-<8 hex>/spawn.json` — `kind: "team"`, `teamPath`, `slots`,
  `hostPid`, `mcpPid` (and `launcherPid`, `parentClaudeSessionId` when they
  apply), written by `SessionManager.recordTeamRun` BEFORE `startModels` and after
  every pre-spawn refusal (`claude_flags`, an undeliverable prompt, magmux, an
  ACTIVE path, the pane limit); a throw fails the call with nothing started. The
  `run` result carries the id as `monitor_record`.
- `<sessionsDir>/team-<8 hex>/meta.json` — `{kind:"team", status, startedAt,
  completedAt, elapsedSeconds, slots, ok, failed, cancelled}` plus
  `reason: "start-failed"` when the run never started; written atomically by
  `finishTeamRun`, which never throws and keeps the first outcome it managed to
  write — a failed write does not use up the record's one end.

**The end is wired INTO `startModels`, not after it.** `TeamRunOptions.onSettled`
is called from `done`'s `finally`, after the settled `status.txt` render, inside
its own `try`. Read inside `startModels`, it exists before the first pane does,
so a run that settles at once and a slow one take the same path. A settle hung
on `handle.done.then(…)` in the handler would depend on code that runs after
`startModels` returns, and would never be installed when `startModels` throws.
`team-run-mcp.contract.test.ts` measures the end against the settle: `meta.json`'s
`completedAt` is within 1 s of the last slot's `completedAt`.

**A throw inside the spawn loop stops what it already started.** The ticker, the
registry entry and `done` are all built after the loop, so a failed `status.json`
write for slot N used to leave slots 1..N-1 running and billing, unreachable. The
loop's `catch` now calls `cancel()` on every pane already started and awaits each
`reaped()`: `close_pane {force:true}`, magmux through its handle, then SIGTERM and
SIGKILL on the verified pane group — the reap's own escalation, so a slot that
traps SIGTERM cannot keep running under a record that already says
`start-failed` (measured: magmux's forced close sent the trapping fake SIGHUP and
killed it before the group backstop was needed). Those cancels are not the
caller's, so they reach neither `status.json` nor any frame: the started slots stay
STARTING there and count as failed. Only then does the ORIGINAL error escape. A
slot's own `startPaneSession` throw is NOT such a throw: it is that slot's FAILED
`pane_lost`, and its siblings run on. There is no claudish SIGINT handler to remove
any more; the pane registry's shutdown hooks cover every consumer. The handler's
`catch` then writes `failed`, `reason: start-failed` with counts from `status.json`
(`summarise(readTeamStatus(path))`), and rethrows the original error. The tests
inject the fault by making `status.json` read-only once the first pane record
exists (`team-start-failure.test.ts`, `team-orchestrator-settle.contract.test.ts`).

**The record ends exactly once because the two paths cannot both run.**
`onSettled` is called only from `done`, and `done` is built LAST — after the spawn
loop and after the D9 `ready` await, which never rejects (`ready` resolves on any
exit from STARTING, terminal included) — immediately before the `return`. When the
loop throws, `startModels` rejects without ever building it, however fast the
started slots end. When the loop completes, nothing after it throws, so
`startModels` resolves and the handler's `catch` never runs. And `finishTeamRun`
keeps its first outcome, so a second call could not overwrite it anyway.
`team-run-settles-once.test.ts` pins all three on the real code. "Settled" means
every slot is terminal, not every pane reaped: `done` awaits each slot's
`terminal`, and the reap finishes up to ≈ 12 s later without delaying the record.

`summarise` counts `COMPLETED` as ok, a terminal slot whose `error.reason` is
`cancelled` as cancelled (every CANCELLED row carries it), and every other state —
the non-terminal STARTING, RUNNING, AWAITING_INPUT and AWAITING_PERMISSION
included — as failed; the verdict is `completed` when any slot is ok (the channel
frame's rule), `cancelled` when all were cancelled. Only `run` writes a record:
`run-and-judge` returns its verdict in the call, and `judge`/`status`/`list`/
`capture`/`cancel` start no work. `loadDiskRecord` returns null for a
`kind: "team"` directory, so session tools answer a `team-*` id as unknown and
`list_sessions` (in-memory only) never lists one.

**Shutdown ends the record too.** Stdin EOF, SIGINT, SIGTERM and SIGHUP run
`shutdownAllTeamRuns()` before the pane reap: every live slot is cancelled, each
run's `done` resolves on those transitions, and every record ends `cancelled`.
After a SIGKILL no record ends; the pane watchers still remove every process, and
the monitor reports the run from the writer's death.

### Blinding is unaffected

`run` returns display model → slot id. That does not weaken blind judging. The
manifest is shuffled so the judge CHILDREN, which read `response-<id>.md` without
a manifest, cannot attribute answers. The orchestrating caller has always seen
the mapping — `status.txt` prints model names beside slot ids.

## One driver, two owners

`team` and the channel once had two implementations of one job: team drove a
stream-json capture and hand-rolled everything around it, while the channel
wrapped the same capture in a reducer with a state machine. Both went with print
mode. Both owners now drive the same `PaneSession` (`pane/`), which owns the
MECHANISM — boot, delivery, the transcript turn oracle, settle, the reap — and asks
its owner for POLICY at exactly two points:

- `decide(turn)` when a turn settles. Team's answer writes `response-<slot>.md`
  (byte-exact, once) and returns `classifyRunOutput` with the caller's
  `require_pattern` and `min_output_bytes` (`team-capture.md`); the channel's
  classifies a one-shot turn with no floor and no pattern, or continues an
  interactive one.
- `onBlocked(block)` when a turn stops on a question or a dialog. Team fails the
  slot `blocked`; the channel waits for `send_input`.

So nothing team-specific leaks into the pane module, and nothing pane-specific into
the policy. Two details that used to need explicit rules now follow from the
transcript: there is no "valid JSON but not stream-json" line to keep or drop (the
`keepUnrecognizedJson` option is gone with the reducer), and there is no reducer for
team to settle after its child exits — a slot is terminal at its verdict, before its
pane is reaped.

## Spawn plumbing: what was shared, and what was deliberately not

The obvious next step looked like making `team` a client of
`SessionManager.createSession`, so each slot would be a channel session
addressable by `get_output`, `get_diagnostics` and `cancel_session`. That was
evaluated and rejected. Reading what `createSession` actually does shows why:

- It calls `classifyRunOutput` with `minOutputBytes: 0` and NO `requirePattern`.
  Team's shape contract is the one signal that catches a voter which never voted,
  so team's policy would have to be pushed down into the session manager.
- `requirePattern` is matched against the FULL answer, not a bounded tail, so the
  session manager would also need team's whole-answer handling.
- `session-manager.ts` already imports `classifyRunOutput` FROM
  `team-orchestrator.ts`. Adding team's options would complete the inversion: a
  channel session manager that knows what a blind-vote panel is.

The addressability was also worth less than it looked. `team` already answers the
same questions through `mode:"status"`, `mode:"capture"` and `mode:"cancel"`, so
the session id would have added convenience, not capability — at the price of that
inversion, plus a shared `maxSessions` cap and a second copy of every answer on
disk.

What IS genuinely shared is the mechanism, and that was extracted — first as
shared helpers, now as one driver:

- **`pane/`**, the whole child lifecycle (above). It replaced `stdio-decode.ts`,
  the shared pipe decoder that had fixed team's `chunk.toString()` mangling CJK
  and emoji split across a read boundary; a transcript record is a whole line of
  JSON, so that hazard no longer exists.
- **The upstream-error log.** `captureUpstreamError` is opt-in on
  `UPSTREAM_ERROR_LOG_ENV`, which team never set — so it was a guaranteed no-op
  for every team child, and the provider response body that separates a
  retryable rate limit from a hard quota wall was discarded as soon as it had
  been classified. Team now sets it per slot (the records carry no slot id, so a
  shared path would interleave models), and `ModelError.upstreamErrorLogPath`
  names the file only when one was actually written.

What remains team's own is what legitimately differs: its policy, its directory
layout (`input.md`, `response-<slot>.md`, `status.json`, `errors/<slot>.log`,
`stats/<slot>.json`), its anonymised slot ids and its run registry. Those are not
duplication; they are two different jobs.

`SessionCreateOptions` did gain `sessionId`, `sessionDir` and `tokenFile` while
this was being evaluated. They are additive, tested, and make the adoption route
available later if the trade above ever changes.

## Coverage removed with the mechanism

Deleting the reaper deleted the tests that drove it: `team-timeout-termination`
(7 tests), `team-timeout-diagnostics` (1), and 2 of 9 in `team-timeout-repro`.
Two of those covered behaviour reachable only through the kill path — an answer
flushed during shutdown being recovered, and nothing being written after the run
returns. Equivalent coverage belongs against the agent-initiated cancel path.
`team-cancel.test.ts` now covers that path on real panes (synchronous and
idempotent, one slot, the whole run), and every pane test asserts that no process
or file outlives the run. A cancelled slot's partial answer reaches
`response-<slot>.md` through its terminal transition; no test pins that yet.
