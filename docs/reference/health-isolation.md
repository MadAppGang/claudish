# `/health` isolation from the data path — proposed design (#587, not implemented)

Status: **design grain, nothing merged**. Issue #587 proposes two remedies
(cached-state health endpoint; chunked admission). This doc orders them against
what is actually measured, names the sites, and records one rejected option so
it does not come back. The hub serves `/health` from the same Node event loop
that parses request bodies; the question is whether that coupling has ever
produced the observed relay flips, and what to build if it does again.

## The state machine being protected

A relay sidecar probes its upstream hub every `HEARTBEAT_INTERVAL_MS = 10_000`
with a `HEARTBEAT_TIMEOUT_MS = 4_000` budget (`fork/server/relay.ts:86-87`).
Two consecutive failures (`FAIL_THRESHOLD = 2`, `relay.ts:294-311`) flip the
relay NOMINAL → AUTONOMOUS. A flip therefore requires the hub's loop to be
**mute for ~14+ seconds across two heartbeat windows** — a merely *slow* (1-3 s)
`/health` never flips anything. Any proposed cause must scale to that bar.

## Anatomy of the current path

- The `/health` handler (`proxy-server.ts:2611`) is **already O(1)**: config
  read, `streamTracker.isStalled()`, `relayHealthFields()`, windowed lag reads.
  #615 removed the last real cost (two `Array.from().sort()` per call,
  7.89 ms on a full ring — measured, see the comment block at
  `proxy-server.ts:2635-2647`). **There is no handler-side compute left to
  remove**; the remaining exposure is entirely "the loop never runs us".
- The synchronous work on the admission path is concentrated in
  `readRequestBody` (`fork/server/relay.ts:188-197`):
  - LAN/direct: `c.req.json()` — the socket read is async I/O, the terminal
    `JSON.parse` is synchronous;
  - gzip WAN (sidecar → hub, the only path where request bodies are gzipped):
    `arrayBuffer()` (async) then **`gunzipSync`** then **`JSON.parse`** — two
    synchronous CPU passes over the inflated body.
  The same helper serves all three ingresses: `/v1/messages`
  (`proxy-server.ts:2863`), `/v1/chat/completions` (`:3022`); `count_tokens`
  parses via `c.req.json()` directly (`:2665`).
- Rough arithmetic: `JSON.parse` ≈ 10-30 ms/MB, `gunzipSync` ≈ 20-50 ms/MB.
  One ordinary admission (the measured fleet bodies are 640-817 Ko ≈ 180-230 K
  tokens) costs tens of milliseconds — **nowhere near the 14 s mute bar**.
  Reaching it takes either a burst of many multi-MB bodies parsing
  back-to-back, or a single body in the tens of MB. Both are possible; neither
  is proven by the corpus.

## What the 2026-10-21 corpus does and does not show

The issue's table (`[ttft] headers=` 14.5 s → 42.9 s with multi-MB admissions
in flight, `msgs=118`) is a **correlation on a corpus that predates the lag
instruments** — `eventLoopMax60sMs`/`eventLoopBlockedMs5m` and the
`[EventLoop]` log line shipped with #615 afterwards. On that day nothing could
distinguish "loop blocked by parse" from "event loop fine, answers late for
another reason". The corpus is consistent with a parse burst; it does not
establish one.

The 2026-10-25 measurement closes the *recent* episodes the other way: during
po-203's relay episodes 2 and 3 the hub's loop was **flat**
(`eventLoopMax60sMs` 24.9 ms, `eventLoopBlockedMs5m` 0), the wait sat in
`headers`, transverse to upstreams — admission-side upstream capacity, not
loop blockage. Those episodes are **not** #587's mechanism and no /health
isolation would have prevented them. #587 stays live only for a corpus where
the loop measurably blocks while a relay flips.

## Options, in order

### O0 — discriminate first (already shipped, no new code)

The #615 instruments self-classify every future episode: join the hub-side
`[EventLoop]` lines and `eventLoopMax60sMs` with the sidecars' AUTONOMOUS
transitions on the same clock (`docker logs -t`), by minute. If the loop is
flat during a flip, no data-path isolation is the remedy — the cause is
admission-side and belongs to capacity work. **This is the only action to take
today.** One measurement trap: a relay's own loop can also miss its heartbeat
(the flap is an instrument of hub state, not a certificate — a busy sidecar
blames the hub falsely). The join must read the **hub-side** lag evidence,
never the flip alone.

### O1 — second HTTP listener, same process: REJECTED (not deferred)

A separate `http.createServer` for `/health` shares the same Node event loop.
While the loop is blocked, neither server answers — the relay's fetch times
out identically. What O1 removes is the handler's own compute, which #615
already made negligible, and it adds a second listening surface (cluster key,
loop identity, watchdog probes) for zero isolation. Recorded here so it is not
re-proposed as a fix. The issue's "http.createServer on a separate listener"
wording is this option and does not isolate.

### O2 — worker-thread `/health`: real isolation, kept in reserve

A dedicated thread's loop is never blocked by the main thread's parse, so the
heartbeat keeps answering no matter what admission does. Sketch, if ever
needed:

- The main thread's existing lag timer callback (the 20 ms repeating interval
  behind #615) writes a small status word into a `SharedArrayBuffer` —
  status byte + timestamp double — from the timer callback itself (the one
  place that already runs when the loop runs, so the snapshot cannot go stale
  silently: a timestamp older than N×interval reads as "unknown", never "ok").
- The worker runs a minimal `node:http` server answering from shared memory,
  serializing the same JSON fields the route emits today (nothing renamed,
  parsers unaffected).
- Costs that gate it: a second thing to drain on shutdown (the #630 die-log
  ordering), one more port or a mux in front, and the snapshot's `stalled`
  verdict depends on `streamTracker`, which lives on the main thread — the
  worker can only publish what main last wrote, and the staleness rule above
  is what keeps that honest.

**Gate: do not build this without an O0-confirmed corpus** (loop blocked
across a relay flip). On every episode measured so far it would have changed
nothing.

### O3 — asynchronous admission: the first code gesture if O0 confirms

Attack the cause, not the symptom — a loop that never blocks needs no
isolated health:

- Swap `gunzipSync` for a streaming `createGunzip` pipeline in
  `readRequestBody` (the socket read is already async I/O; only the inflate
  pass is synchronous today). Small, self-contained, and safe regardless of
  any corpus: the failure paths and the single 400 wrapper (#548) are
  unchanged, and never-hang is preserved (a broken stream degrades exactly as
  the sync version's catch does).
- If bursts of large `JSON.parse` are confirmed, serialize them behind an
  admission gate that yields (`setImmediate`) between bodies, so one giant
  parse never stacks behind another on the same tick. This also benefits the
  real requests' TTFT — the same loop latency the `[ttft] headers=` line
  measures — not just the heartbeat.

## Acceptance criteria, as measurements

- Synthetic multi-MB admission in flight, probe from a relay seat:
  `/health` p99 < 500 ms (issue's bar).
- Regression population: po-203's 2026-10-21 episode table. A pass is **zero
  AUTONOMOUS flips in windows where `eventLoopMax60sMs` stays under 100 ms** —
  the join, not the flip count alone.
