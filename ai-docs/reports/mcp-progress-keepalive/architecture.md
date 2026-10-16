# `notifications/progress` as an MCP keepalive — implementation design

Session: `dev-feature-mcp-progress-20260814-001500-c4d9`
Depends on (measured ground truth, not re-litigated here):
`ai-docs/reports/mcp-progress-keepalive/findings.md`

## 0. What is being built, in one paragraph

Claude Code aborts an MCP tool call that puts nothing on the transport for the idle
window (stdio default 1800s — the exact number the real `team` failure died at).
`notifications/progress` resets that timer; `notifications/claude/channel` does not.
So the three tools that block for minutes — `team` (`run`, `run-and-judge`),
`run_prompt`, `compare_models` — get a **time-driven** heartbeat emitting
`notifications/progress` against the caller's `progressToken`. Channel emission is
untouched: channel is the visible surface, progress is the keepalive. `create_session`
is deliberately out of scope — it returns in milliseconds with
`{session_id, status:"starting"}` and cannot reach the idle timer.

The heartbeat must be periodic, not event-driven. `team` already emits channel frames
on state change and still died: a model that runs for 30 minutes without a state change
produces no events, so an event-driven emitter is silent exactly when the timer is
counting.

## 1. Threading `progressToken` from dispatch to handler

### Decision: an explicit, always-supplied second `ctx` parameter, built per call in the dispatch.

Rejected alternatives:

| Option | Why not |
|---|---|
| **AsyncLocalStorage** | Makes the token ambient. The one failure mode that actually matters here is *emitting a progress frame after the call it belongs to has been answered* (§5), and ambient state is precisely what lets a callback captured by a long-lived object — `SessionManager.onStateChange`, a `runModels` progress closure — read a token from whatever call happens to be on the stack later. It also can't be unit-tested without going through the dispatch. It buys nothing: every site that needs the token is lexically inside the handler. |
| **Per-call notifier factory passed into `defineTools`** | `defineTools(sessionManager, notifyChannel)` is called **once** at startup (line 1370) and its closure is shared by every call. A per-call value cannot come through it without turning `defineTools` into a per-call factory — that rebuilds 11 tool objects on every `tools/call`, and `toolMap` is built from it. Strictly larger diff, worse allocation profile. |
| **Optional (`ctx?`) second param** | Forces `ctx?.reportProgress?.()` at every use site for a value the dispatch always supplies. Required-in-type / ignored-in-implementation is the same diff with fewer `?`. |

### Why the diff stays at zero for the other tools

TypeScript function-type assignability is **bivariant in parameter count**: a value of
type `(args: A) => R` is assignable to `(args: A, ctx: C) => R`. Widening
`ToolDefinition.handler` therefore requires **no edit to any of the ~11 existing
handlers** — `list_models`, `search_models`, `report_error`, `create_session`,
`send_input`, `get_output`, `cancel_session`, `list_sessions` keep their one-parameter
arrow functions verbatim, and they neither receive nor pay for a heartbeat because the
heartbeat is gated on an opt-in flag (below), not on the parameter.

Tools that do not set `heartbeat: true` are handed `NOOP_HEARTBEAT`-backed context: no
timer is created, no frame is ever emitted, `ctx.reportProgress()` is a no-op call that
returns `undefined`. Zero behavioural change and zero allocation beyond one frozen
object reference.

### Where the token comes from

The SDK already surfaces it. `protocol.js:317` sets `extra._meta = request.params?._meta`,
and `RequestHandlerExtra._meta?: RequestMeta` types `progressToken` as
`string | number | undefined`. So the dispatch reads `extra._meta?.progressToken` — no
casting through `request.params`.

`extra.sendNotification` is typed `(n: ServerNotification) => Promise<void>` and
`ProgressNotificationSchema` **is** a member of `ServerNotificationSchema`
(`types.js:1990-2000`), so the emit typechecks without a cast — unlike the existing
channel path, which sends a method outside that union. Prefer `extra.sendNotification`
over `server.notification` on principle (it is the request-scoped sender; on non-stdio
transports it is what correlates the frame with its request), even though on stdio the
two are equivalent today.

`notifications/progress` needs **no capability declaration**: the SDK's
`assertNotificationCapability` has an explicit `case 'notifications/progress': // always
allowed` (`server/index.js:204`). Nothing changes in the `capabilities` block at
line 1285-1292.

### Exact signatures

```ts
// packages/cli/src/mcp-server.ts — insert immediately after `type ToolGroup` (line 100)

/**
 * Per-call context handed to every tool handler. Built fresh in the CallTool
 * dispatch, so nothing here is shared between concurrent calls.
 */
interface ToolCallContext {
  /**
   * Emit ONE keepalive frame right now, in addition to the periodic ones.
   * Safe to call from anywhere inside the handler; a no-op when the client sent
   * no `progressToken`, when the tool did not opt into `heartbeat`, or after the
   * heartbeat has been stopped. Never throws.
   */
  reportProgress: (message?: string) => void;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties?: Record<string, unknown>; required?: string[] };
  group: ToolGroup;
  /**
   * Opt in to the periodic `notifications/progress` keepalive. Set ONLY on tools
   * that can block past the client's MCP idle window (30 min by default on stdio).
   * The dispatch owns start and stop; the handler cannot leak a timer.
   */
  heartbeat?: true;
  handler: (
    args: Record<string, unknown>,
    ctx: ToolCallContext
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>;
}
```

## 2. The heartbeat helper

New file: **`packages/cli/src/mcp/progress-heartbeat.ts`** (new `mcp/` directory, sibling
of `channel/`; the helper is transport-level and has nothing to do with channels, and
`mcp-server.ts` is already 1434 lines).

```ts
/**
 * Periodic `notifications/progress` keepalive for long-blocking MCP tools.
 *
 * Claude Code aborts a tool call that emits nothing for the MCP idle window
 * ("sent no response or progress for 1800s; aborting"). A progress notification
 * resets that timer; a `notifications/claude/channel` frame does not — measured
 * 2026-08-14 on 2.1.231, see
 * ai-docs/reports/mcp-progress-keepalive/findings.md.
 *
 * The emitter is TIME-driven on purpose. `team` already emitted channel frames on
 * every state change and still died at exactly 1800s, because a model that thinks
 * for 30 minutes produces no state changes.
 */

/** MCP `ProgressToken` — the spec allows a string or a number. */
export type ProgressToken = string | number;

export interface ProgressFrame {
  progressToken: ProgressToken;
  /** Strictly increasing, per the spec. Starts at 1. */
  progress: number;
  message?: string;
}

/** Emits one frame. Sync-throwing or promise-rejecting are both tolerated. */
export type ProgressSender = (frame: ProgressFrame) => unknown;

export interface HeartbeatHandle {
  /** Emit one frame immediately, sharing the monotonic counter. Never throws. */
  tick(message?: string): void;
  /** Idempotent. Clears the timer AND latches the emitter off. */
  stop(): void;
  /** False when disarmed (no valid token) or stopped. */
  readonly active: boolean;
  /** Frames handed to the sender. Test observability only. */
  readonly emitted: number;
}

export const DEFAULT_PROGRESS_INTERVAL_MS = 10_000;
export const MIN_PROGRESS_INTERVAL_MS = 1_000;
export const MAX_PROGRESS_INTERVAL_MS = 60_000;

export function isProgressToken(v: unknown): v is ProgressToken;

/**
 * Reads CLAUDISH_MCP_PROGRESS_INTERVAL_MS once, clamped to
 * [MIN, MAX]; anything unparseable falls back to the default.
 */
export function resolveProgressIntervalMs(env?: NodeJS.ProcessEnv): number;

export interface HeartbeatOptions {
  /** RAW `_meta.progressToken`. Validated here — callers never pre-check. */
  token: unknown;
  send: ProgressSender;
  /** Tool name, used to build the default message. */
  label: string;
  intervalMs?: number; // default DEFAULT_PROGRESS_INTERVAL_MS
}

export function startHeartbeat(opts: HeartbeatOptions): HeartbeatHandle;

/** Shared, frozen, permanently inert. Used for tools without `heartbeat: true`. */
export const NOOP_HEARTBEAT: HeartbeatHandle;
```

Implementation contract (the parts that are load-bearing, not stylistic):

```ts
export function startHeartbeat(opts: HeartbeatOptions): HeartbeatHandle {
  const { token, send, label } = opts;
  if (!isProgressToken(token)) return NOOP_HEARTBEAT;   // §3

  const intervalMs = clamp(opts.intervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS);
  const startedAt = Date.now();
  let progress = 0;
  let stopped = false;

  const emit = (message?: string): void => {
    if (stopped) return;                                 // §5 — the latch
    progress += 1;                                       // strictly increasing
    try {
      const r = send({
        progressToken: token,
        progress,
        message: message ?? `${label}: working (${Math.round((Date.now() - startedAt) / 1000)}s)`,
      });
      // sendNotification is async; an unhandled rejection would kill the server.
      if (r && typeof (r as PromiseLike<unknown>).then === "function") {
        void (r as Promise<unknown>).catch(() => {});
      }
    } catch {
      // A keepalive must never fail the call it is keeping alive.
    }
  };

  const timer = setInterval(() => emit(), intervalMs);
  // A pending keepalive must not hold the process open at shutdown.
  (timer as { unref?: () => void }).unref?.();

  return {
    tick: (m) => emit(m),
    stop: () => { stopped = true; clearInterval(timer); },
    get active() { return !stopped; },
    get emitted() { return progress; },
  };
}
```

### Why 10 s

- **It is the measured-working number.** The surviving probe arm emitted every 10 s
  against a 30 s window. Inventing a different interval would put an unmeasured value on
  the one path whose whole purpose is not to be silent.
- **It holds at the smallest window a user can actually configure.** The findings record
  an undocumented floor on `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`: `1000` and `5000` were
  silently ignored, `30000` was honoured exactly. At a 30 s window, 10 s gives 3 ticks —
  the call survives two consecutive missed or late ticks. `.mcp.json`'s per-server
  `timeout` only raises the floor, so 30 s is the realistic minimum.
- **Late timers are normal here.** `setInterval` is best-effort, and during a `team` run
  the event loop is spawning N children and parsing their stdout. A 25 s interval would
  have single-tick margin at the floor: one delayed timer = one aborted call.
- **The cost at the default window is nothing.** 1800 s ÷ 10 s = 180 frames per call,
  ~150 bytes each ≈ 27 KB over half an hour, on a stream that is otherwise idle.
- **Not 1 s**: 1800 frames per call, interleaved with channel frames and JSON-RPC
  responses on the same pipe, for zero extra safety margin.

Override: `CLAUDISH_MCP_PROGRESS_INTERVAL_MS`, clamped to `[1000, 60000]`, garbage →
default. Resolved **once** at server start (§7, line ~1341) rather than per call, so a
long session cannot change behaviour mid-flight. Its real consumer is the test suite,
which sets 200 ms so a wire test finishes in under a second.

### Monotonicity and `total`

`progress` starts at 1 and increments on **every** emit — periodic ticks and explicit
`ctx.reportProgress()` calls share one counter, so the sequence is strictly increasing as
the spec requires regardless of interleaving.

**`total` is never sent.** Our progress axis is elapsed time, and time has no known
total. It is tempting to set `total = modelIds.length` in `compare_models` — but then a
heartbeat tick between two model completions increments `progress` past `total`, and a
conformant client renders >100 %. One axis, no total, no lie.

`message` is short and structural — tool name, elapsed seconds, and for
`compare_models` an `N/M models done` counter. **Never** the prompt, model output, or a
filesystem path: it goes on the wire to the host and, unlike the channel content, was
not composed for display.

## 3. When `progressToken` is absent

`startHeartbeat` returns `NOOP_HEARTBEAT` whenever `isProgressToken(token)` is false —
which covers `_meta` missing entirely (older client / non-Claude-Code host), `_meta`
present without the key, and a token of the wrong type (`null`, `true`, an object).
`isProgressToken` is `typeof v === "string" || (typeof v === "number" && Number.isFinite(v))`.

Consequences, all silent:

- no `setInterval` is created,
- `ctx.reportProgress()` returns immediately,
- `stop()` is a no-op,
- the tool executes and returns byte-identically to today.

There is no warning and no error. A host that does not send a token has not
misbehaved — the token is optional in the spec — and a tool call must never fail because
its keepalive could not arm. (Claude Code 2.1.231 does send it, value `2`, every run;
`anthropics/claude-code#58687`'s claim to the contrary is stale.)

## 4. Coexistence with the existing channel emission

Nothing about `notifyChannel` (line 1342), the `ChannelNotifier` type (line 423), the
`SessionManager` bridge (line 1309), or the wire format pinned by
`session-wire-format.test.ts` changes. The two mechanisms are complementary and were
measured to be:

| | visible to agent / human | resets idle timer |
|---|---|---|
| `notifications/claude/channel` | ✓ | ✗ |
| `notifications/progress` | ✗ | ✓ |

Two specific rules that follow:

1. **The heartbeat is NOT gated on `channelEnabled`.** The real `team` failure happened in
   a session with channels unregistered (plain `claude`, no `--channels`). Gating the
   keepalive on the channel group would reproduce the bug exactly. `notifyChannel` keeps
   its `if (!channelEnabled) return;`; the heartbeat has no such guard.
2. **`team`'s `onProgress` does both.** It keeps calling `notifyChannel(...)` with the
   rendered grid unchanged, and additionally calls `ctx.reportProgress(...)` with a short
   phase string. That is belt-and-braces — the periodic timer alone already suffices —
   but it costs one line and means a state-change burst refreshes the idle timer at the
   moment there is real news.

The comment block at lines 413-422 claims channels are "the ONLY measured-working push
mechanism". That was true for *rendering* and is now misleading; it gets a two-line
amendment pointing at the new findings, since it is the note a future reader will hit
first.

## 5. Concurrency and the "progress after cleanup" risk

The historical objection (ROADMAP, `GLips/Figma-Context-MCP#362`) is that a progress
notification arriving **after** the client has cleaned up its `progressToken` is treated
as a protocol violation and tears down stdio. Three structural reasons that cannot
happen here:

**(a) `stop()` runs strictly before the response is serialized.** The dispatch is

```ts
try   { return await tool.handler(args ?? {}, ctx); }
catch { /* error result */ }
finally { hb.stop(); }
```

A `finally` block executes after the return *value* is computed but before the function
returns to the caller. The SDK receives the result only after `stop()` has already
cleared the interval and latched the emitter — on the success path, the error path, and
any future early return. The handler cannot forget to stop it, because the handler never
started it.

**(b) The latch, not just `clearInterval`.** `stopped = true` is checked at the top of
`emit`, so a tick already queued on the macrotask queue when `stop()` ran is dropped
rather than emitted. `clearInterval` alone would not cover that window.

**(c) Ordering on the wire.** A frame emitted before `stop()` is written to stdout before
`stop()` returns, and the response is written after — the stdio transport preserves write
order, so a progress frame can never overtake its own response.

**On "N concurrent progressTokens" (the ROADMAP's stated fear):** it rests on a
misreading. `team`'s N children are OS processes spawned by `team-orchestrator.ts:599`,
not MCP requests — they have no `progressToken` at all. A `team` call has exactly **one**
token, and emits at most one frame per interval. The only genuine concurrency is the host
issuing several `tools/call` requests in parallel, which Claude Code does. Each gets its
own `HeartbeatHandle` closed over its own token and its own counter; **no map is keyed by
token and no state is shared**, so there is nothing to collide, evict, or clean up
incorrectly.

Related: the findings observed `progressToken: 2` on every run. If Claude Code really
does reuse the value across concurrent calls, our frames are unaffected — we hold no
token-keyed state, and a frame mis-attributed by the client to a sibling call still resets
that client's idle timer. This is asserted at unit level by the concurrent-calls wire test
(§6-B3), which answers the findings' open question without a live model.

Two further safety properties: the emit path swallows sync throws **and** attaches
`.catch()` to the returned promise (an unhandled rejection in Bun would take the whole MCP
server down), and the interval is `unref()`ed so a pending tick cannot hold the process
alive during `SIGTERM` shutdown (line 1418).

## 6. Testing strategy — no live Claude Code

### A. `packages/cli/src/mcp/progress-heartbeat.test.ts` — pure unit, hermetic

No spawn, no network, no `mock.module` (the repo's own rule: mocking shared infra bleeds
across Bun's module registry into sibling e2e files). The sender is a plain array-pushing
function; intervals are 20 ms so the file runs in well under a second.

1. **Disarmed**: `token` of `undefined` / `null` / `true` / `{}` / `NaN` → zero sends after
   5 intervals, `active === false`, `tick()` and a double `stop()` do not throw.
2. **Periodic**: `intervalMs: 20`, wait 110 ms → ≥ 4 frames; `progress` strictly
   increasing starting at 1; `progressToken` echoed verbatim for both a numeric (`2`) and a
   string (`"abc"`) token; **`total` absent from every frame** (the §2 rule, pinned).
3. **Stop discipline**: after `stop()`, wait 3 intervals → frame count frozen; `active ===
   false`.
4. **No emit after stop, racing**: call `stop()` from inside the sender on frame 1 → total
   stays 1 (this is the (b) latch, and it is the assertion that maps directly to the
   Figma-Context-MCP regression).
5. **Hostile sender**: a sender that throws synchronously, and one that returns a rejected
   promise → the heartbeat keeps ticking and nothing escapes. Bun fails a test on an
   unhandled rejection, so arm 2 passing *is* the assertion.
6. **Shared counter**: interleave `tick()` with periodic ticks → the sequence is strictly
   increasing with no repeats.
7. **`resolveProgressIntervalMs`**: default when unset; honours a valid value; clamps `1`
   → 1000 and `600000` → 60000; `"abc"` → default. Uses an injected `env` object, never
   `process.env`.

### B. `packages/cli/src/mcp/mcp-progress-wire.test.ts` — dispatch-level over real stdio

Spawns `bun run packages/cli/src/index.ts --mcp` and speaks raw newline-framed JSON-RPC
to it, exactly like `mcp-session/session-wire-format.test.ts` (and reusing
`mcp-e2e/jsonrpc-client.ts`'s framing where convenient). **No API key required**: the
existing `fake-claudish` PATH shim satisfies `team`, because `team-orchestrator.ts:599`
spawns through `resolveClaudishSpawn()` just like `SessionManager` does. Child env sets
`CLAUDISH_MCP_PROGRESS_INTERVAL_MS=200`.

1. **Frames are emitted**: `tools/call` for `team` (`mode: "run"`, shim models, a temp
   session dir) with `params._meta.progressToken = 2` → ≥ 2 frames with
   `method === "notifications/progress"`, each `params.progressToken === 2`, `progress`
   strictly increasing, no `total` key.
2. **Stop discipline on the wire**: **zero** `notifications/progress` frames appear on
   stdout after the JSON-RPC response with the matching `id`. This is the §5 contract
   observable purely as frame ordering — the single most valuable assertion in the file.
3. **Concurrency**: two `tools/call` requests written back-to-back with tokens `2` and `3`
   → both responses arrive, every progress frame carries one of the two tokens, and the
   server is still alive afterwards (a follow-up `tools/list` returns). Answers the
   findings' open N-concurrent question at unit level.
4. **No token → silence**: the same `team` call with `_meta` omitted → zero progress
   frames and a normal, unchanged result payload. (§3.)
5. **Not every tool heartbeats**: `list_models` with a token → zero progress frames,
   proving `heartbeat: true` is a real gate rather than decoration.

### C. Regression guard on what must not change

`bun test packages/cli/src/mcp-session/session-wire-format.test.ts` must stay green
untouched — it pins the channel contract, and §4's whole claim is that channel behaviour
is unchanged.

## 7. Exact insertion points (`packages/cli/src/mcp-server.ts`, 1434 lines today)

| # | Line | Change |
|---|---|---|
| 1 | after 24 (`./channel/index.js`) | `import { NOOP_HEARTBEAT, type HeartbeatHandle, resolveProgressIntervalMs, startHeartbeat } from "./mcp/progress-heartbeat.js";` — Biome sorts imports by path, so it lands between `./channel/index.js` and `./model-loader.js`. |
| 2 | after 100 (`type ToolGroup`) | new `interface ToolCallContext` (§1). |
| 3 | 102-115 | `ToolDefinition`: add `heartbeat?: true;`, widen `handler` to `(args, ctx)`. |
| 4 | 413-422 | amend the comment block: channel is the only *rendering* mechanism; progress is the keepalive; link the new findings. |
| 5 | 476 | `run_prompt`: add `heartbeat: true,` next to `group: "low-level",`. Handler body **unchanged** — the whole point is that the dispatch owns it. |
| 6 | 707 | `compare_models`: add `heartbeat: true,`. |
| 7 | 708 → `async (args, ctx)`; after the loop body push at 726/733 | `ctx.reportProgress(\`compare_models: ${results.length}/${modelIds.length} models done\`);` — one line, inside the `for`, after both the success and error `results.push`. |
| 8 | 818 | `team`: add `heartbeat: true,` next to `group: "agentic",`. |
| 9 | 819 | `handler: async (args, ctx) => {`. |
| 10 | 840-851 | inside `onProgress`, before/after the existing `notifyChannel({...})` call: `ctx.reportProgress(\`team: ${u.phase}\`);` — channel emission itself untouched (§4). |
| 11 | after 1341 (`const channelEnabled = …`) | `const progressIntervalMs = resolveProgressIntervalMs();` — resolved once per server. |
| 12 | 1386-1408 | the dispatch rewrite (below). |

### The dispatch (replaces lines 1386-1408)

```ts
  // Register CallTool handler
  //
  // `extra._meta` is the caller's request `_meta` (SDK protocol.js:317), which is
  // where Claude Code puts `progressToken`. A tool marked `heartbeat: true` gets a
  // periodic `notifications/progress` keepalive for as long as it runs: the client
  // aborts a call that emits nothing for its idle window (30 min on stdio by
  // default — the exact 1800s a real `team` run died at), and a progress frame is
  // the ONLY notification measured to reset that timer. Channel frames do not.
  //
  // The dispatch owns start AND stop. `finally` runs before the result reaches the
  // SDK, so a frame can never be emitted after the response it belongs to — the
  // GLips/Figma-Context-MCP#362 teardown pattern is structurally unreachable.
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    const tool = toolMap.get(name);
    if (!tool) {
      return {
        content: [{ type: "text" as const, text: `Error: Unknown tool "${name}"` }],
        isError: true,
      };
    }

    const heartbeat: HeartbeatHandle = tool.heartbeat
      ? startHeartbeat({
          token: extra._meta?.progressToken,
          label: name,
          intervalMs: progressIntervalMs,
          send: (frame) => extra.sendNotification({ method: "notifications/progress", params: frame }),
        })
      : NOOP_HEARTBEAT;
    const ctx: ToolCallContext = { reportProgress: (message) => heartbeat.tick(message) };

    try {
      return await tool.handler(args ?? {}, ctx);
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    } finally {
      heartbeat.stop();
    }
  });
```

## 8. Implementation phases

**Phase 1 — helper + unit tests.** `mcp/progress-heartbeat.ts` and
`mcp/progress-heartbeat.test.ts` (§6-A). Self-contained, imports nothing from the repo,
mergeable and reviewable on its own. No behaviour change to the server.

**Phase 2 — wiring.** Items 1-3 and 11-12 of §7 (types + dispatch), then 5/6/8 (the three
`heartbeat: true` flags). After this the keepalive is live for all three tools; items 7
and 10 are not required for it to work.

**Phase 3 — event-time ticks and docs.** Items 7 and 10 (`ctx.reportProgress` in
`compare_models` and `team`), item 4's comment amendment, the wire test (§6-B), the
ROADMAP un-parking (`ROADMAP.md:44` — the item is parked on *rendering* grounds that
remain true; it is being implemented on *keepalive* grounds, which is a different
justification and should be written down as such rather than silently contradicted), and
a CLAUDE.md note next to the channel section.

Dependencies: 2 needs 1; 3 needs 2. Nothing else in the repo depends on any of it.

## 9. Considerations

**Security / privacy.** Progress `message` carries tool name, elapsed seconds, and
counts only — never prompt text, model output, session paths, or model ids beyond what
the caller already sent. The channel path (already reviewed) keeps its own richer
content.

**Performance.** One `setInterval` per in-flight heartbeat tool call. At the default
10 s, a 30-minute `team` run emits ~180 frames ≈ 27 KB. Non-heartbeat tools allocate one
object reference (`ctx`) and nothing else.

**Failure modes, all non-fatal by construction.** Sender throws → swallowed. Sender
rejects → `.catch`ed (an unhandled rejection would kill the server, which is why this is
explicit rather than incidental). No token → inert. Interval misconfigured → clamped.
Process shutting down → `unref()`ed timer does not hold it open.

**What this does not fix.** Claude Code's **wall-clock** limit and its 2-minute automatic
backgrounding are untouched — the findings are explicit that a backgrounded call is still
subject to both limits, and only the *idle* one is addressed here. A `team` run that
exceeds the wall-clock ceiling will still be cut off, and the remedies for that remain
config-side (`.mcp.json` per-server `timeout`, or SEP-1686 Tasks when Claude Code ships
receiver support — already tracked in ROADMAP).

**Open question deliberately left open.** Whether the idle-timeout floor sits between 5 s
and 30 s is unresolved and does not need resolving: a 10 s heartbeat is safe at 30 s and
the floor can only move the true window upward.
