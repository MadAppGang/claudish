/**
 * Relay / sidecar mode (fork extension).
 *
 * A claudish container can run as a *sidecar* on each cluster machine:
 *   - NOMINAL   → forward raw Anthropic-API requests to a central hub (po-2023),
 *                 preserving the central live view + captures + 30:1 compression.
 *   - AUTONOMOUS→ when the hub is unreachable (detected with hysteresis), the
 *                 request falls through to the normal local pipeline so the
 *                 machine keeps serving during an outage.
 *
 * When no upstream is configured the process is the HUB itself: no RelayState is
 * created and the /v1/messages route behaves exactly as before (zero change).
 *
 * NEVER-HANG (priority #1): the forwarded response is piped through
 * `createAnthropicPassthroughStream` (ping keepalive + finalizeWithError), so a
 * mid-stream hub death still emits a terminal message_stop. A *pre-stream*
 * forward failure returns `null` → the caller falls through to local handling for
 * that single request, and the failure feeds the prober's hysteresis.
 *
 * Capture is mode-aware *for free*: the relay branch is wired BEFORE logRequest /
 * the handler capture points, so nominal forwards never capture locally (the hub
 * captures centrally). Autonomous requests skip the relay branch → normal path →
 * local capture (used for outage reconciliation). The forward's own response pipe
 * passes `capture: false` so it never writes an orphan resp-*.sse in nominal.
 */

import type { Context } from "hono";
import { gzipSync, gunzipSync } from "node:zlib";
import { log, logStderr } from "../../logger.js";
import { getInstanceId } from "../../instance-id.js";
import { createAnthropicPassthroughStream } from "../../handlers/shared/stream-parsers/anthropic-sse.js";
import { boundRetryUpstream } from "../../handlers/shared/first-event-watchdog.js";
import { carryNoticeHeader } from "../../handlers/shared/failover-stream-notice.js";
import { isQuotaExhaustion } from "../failover.js";
import { isKeylessExempt } from "../../handlers/shared/keyless-exempt.js";

/** Headers we must not blindly forward to the upstream. */
const HOP_BY_HOP = new Set([
  "host", "connection", "keep-alive", "transfer-encoding", "te",
  "trailer", "upgrade", "content-length", "content-encoding",
]);

export interface RelayState {
  /** Upstream hub base URL, e.g. "http://192.168.0.50:3000" or "https://models.myia.io". */
  upstream: string;
  /** gzip the forwarded request body (WAN externals only). */
  compress: boolean;
  /** Injected as x-api-key on the forward so the hub's auth accepts it. */
  proxyKey?: string;
  /** Current health verdict (prober-owned). true → relay, false → autonomous. */
  alive: boolean;
  consecutiveFail: number;
  consecutiveOk: number;
  /** ms epoch of the last alive→false / false→true transition (recovery cooldown). */
  lastFlipAt: number;
  /**
   * #323 (review B1): the header-phase AbortControllers currently waiting on
   * upstream headers. The prober's NOMINAL→AUTONOMOUS flip aborts every one of
   * them: at a 360s budget the flip (~200s: stall detector 180s + 2 heartbeats)
   * is the FIRST thing that knows the waits are dead, and without this release
   * every forward dispatched inside the detection window would sit out the full
   * budget — ~160s of pure dead time per request, per machine, on the exact
   * 2026-09-02 wedge shape this module documents. Controllers are flagged
   * `_relayFlipAbort` before the abort so the fallthrough can label them apart
   * from a budget deadline (`aborted-on-autonomous`) and neither markFail a
   * second time nor get retried.
   */
  headerWaiters: Set<AbortController>;
  /**
   * #156: the upstream's /health published OUR OWN instanceId — the upstream IS
   * this process, whatever the URL says (the 2026-09-19 ARR-loop shape). Sticky
   * per detection: latched true by `heartbeat()`, cleared when a reply stops
   * matching. Published on /health as `selfLoop`.
   */
  selfLoop: boolean;
}

// ── Hysteresis tuning ──────────────────────────────────────────────
// Failover FAST (the 2026-07-02 outage cost hours); recover SLOW (anti-flap on a
// degraded LAN). In-band forward failures and heartbeat failures feed the same
// counter, so a hard hub crash flips within ~10-20s (or immediately per-request
// for pre-stream connection-refused, which falls through to local at once).
const FAIL_THRESHOLD = 2; // consecutive failures → autonomous
const OK_THRESHOLD = 3; // consecutive OK heartbeats before attempting a deep probe
const RECOVERY_COOLDOWN_MS = 60_000; // min time autonomous before returning to relay
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 4_000;
/**
 * Pre-stream deadline (the body stream itself is unbounded). This is NOT a liveness
 * detector — the heartbeat prober owns that (10s interval, 2 failures → AUTONOMOUS).
 * Its only job is to stop a black-holed connection from hanging a request forever,
 * so it must sit ABOVE the hub's normal header latency, not inside it.
 *
 * Measured on ai-01 → models.myia.io, 2026-08-10, ordinary glm-5.2 streaming POSTs:
 * first byte at 2.5s / 3.1s / 3.4s / **8.3s**. The former 5s bound sat in the middle
 * of that distribution, so routine upstream latency aborted the forward and the
 * request fell through to the local pipeline — silently (markFail only logs on its
 * second consecutive failure) and expensively (the hub's in-flight provider call is
 * orphaned but still billed, then the sidecar re-runs the same prompt locally).
 * Worse, on a CLAUDISH_NO_ANTHROPIC machine that fallthrough reroutes a native
 * target to the budget model — a policy-visible behavior change caused by latency.
 *
 * #320: the 30s value sat inside the hub's own LEGITIMATE header waits, not above
 * them. The hub's header-phase contract is bounded by two mechanisms of its own
 * (composed-handler.ts): the first-event watchdog confines a mute upstream to
 * CLAUDISH_FIRST_EVENT_TIMEOUT_MS (300s default), and an overload path may hold the
 * response for "transport 60s + patient backoff ~305s ≈ 6 min, well under the
 * 10-min client timeout" — the contract a DIRECT client of the hub enjoys. A relay
 * cutting at 30s defeated both: measured 2026-10-03/04, every >30s hub header wait
 * was raw upstream latency in GLM bursts (salves 35-92s, queue to 221s, max 221s;
 * ZERO `[Overload]` patient-retry lines in 83,695 log lines — the backoff loop
 * never fired), so the relay was amputating waits the hub was faithfully holding
 * for its provider. Each cut stalled the client 30s, orphaned the hub's in-flight
 * (billed) call, replayed the prompt on the local cascade (invisible to central
 * capture, possibly PAYG), and could flip the machine AUTONOMOUS via the failure
 * streak. The default is now derived from the hub's contract, not the first-byte
 * sample: 360s = the ~6 min a live hub may legitimately spend before its first
 * header, still 4 min under the client's own 10-min timeout. The bound is a
 * BACKSTOP: a genuinely wedged hub is detected elsewhere and sooner — /health's
 * stall detector counts a request from the moment it enters the middleware
 * (stream-registry.ts, pendingRequests), so header-phase silences feed the 503 the
 * prober already acts on (180s default) — this deadline only guarantees the client
 * turn ends even if that whole chain somehow stays quiet.
 *
 * Abort-on-AUTONOMOUS-flip IS wired (#323 review B1). The residual without it is
 * not "one request": a wedged-but-/health-answering hub (the 2026-09-02 shape,
 * 2h27 fleet-wide) is detected in ~200s (stall detector 180s + 2 heartbeats) —
 * every forward dispatched inside that window (a sidecar holds 7-10 in flight,
 * plus each new arrival) would otherwise sit out the full 360s budget, ~160s of
 * dead time per request after the flip already knew. markFail's transition now
 * aborts every registered header waiter (RelayState.headerWaiters), the abort
 * carries its own fallthrough label (`aborted-on-autonomous`), and it never
 * markFails a second time. Liveness stays with the prober; this deadline is the
 * backstop for a flip that somehow never comes.
 */
export const FORWARD_HEADERS_TIMEOUT_MS = 360_000;

/**
 * Legal range for CLAUDISH_RELAY_HEADER_TIMEOUT_MS. The MIN keeps an operator from
 * re-creating the original 5s bug (first byte measured at up to 8.3s on ORDINARY
 * traffic — a budget inside that spread demotes routine requests to local). The
 * MAX is the client's documented 10-min timeout: past it the client has abandoned
 * the turn, so the bound protects no one while the local replay never happens.
 * `0` is NOT a legal "disable" here — an unbounded header wait is exactly the
 * never-hang violation this bound exists to prevent; use MAX for the longest wait.
 */
export const MIN_FORWARD_HEADERS_TIMEOUT_MS = 5_000;
export const MAX_FORWARD_HEADERS_TIMEOUT_MS = 600_000;

/**
 * Per-request read of CLAUDISH_RELAY_HEADER_TIMEOUT_MS (never cached — same
 * rationale as stallThresholdMs: this is a knob an operator turns mid-incident).
 * Empty/unset mean the default — NOT 0: compose injects every listed name as ""
 * (#310 review), and Number("") === 0, so a naive parse would turn every
 * unconfigured container into an instant-timeout relay. Garbage and out-of-range
 * values also fall back to the default rather than silently disarming the bound.
 */
export function resolveForwardHeadersTimeoutMs(): number {
  const raw = process.env.CLAUDISH_RELAY_HEADER_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return FORWARD_HEADERS_TIMEOUT_MS;
  const n = Number(raw);
  if (
    !Number.isFinite(n) ||
    n < MIN_FORWARD_HEADERS_TIMEOUT_MS ||
    n > MAX_FORWARD_HEADERS_TIMEOUT_MS
  ) {
    return FORWARD_HEADERS_TIMEOUT_MS;
  }
  return Math.floor(n);
}
const DEEP_PROBE_TIMEOUT_MS = 30_000;
/** #80 part 2: one retry on a connect-phase failure before falling through
 * (the Docker Desktop tunnel's chronic resets — see forwardToUpstream). */
const CONNECT_RETRIES = 1;
const CONNECT_RETRY_DELAY_MS = 250;

/**
 * Read the JSON request body, inflating a gzipped body if present.
 *
 * WAN external sidecars gzip the forwarded request body (Content-Encoding: gzip)
 * to save uplink on the constrained asymmetric link; the hub inflates here. Most
 * runtimes do NOT auto-inflate request bodies, but some do — so we detect the
 * gzip magic bytes (0x1f 0x8b) rather than trusting the header blindly, which
 * makes this correct (and non-throwing) whether or not the runtime already
 * inflated. Falls back to plain c.req.json() when no gzip encoding is declared —
 * zero cost on the LAN path.
 */
export async function readRequestBody(c: Context): Promise<any> {
  const encoding = (c.req.header("content-encoding") ?? "").toLowerCase();
  if (!encoding.includes("gzip")) {
    return c.req.json();
  }
  const raw = Buffer.from(await c.req.arrayBuffer());
  const isGzip = raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b;
  const jsonBuf = isGzip ? gunzipSync(raw) : raw;
  return JSON.parse(jsonBuf.toString("utf-8"));
}

export function createRelayState(opts: {
  upstream: string;
  compress?: boolean;
  proxyKey?: string;
}): RelayState {
  return {
    upstream: opts.upstream.replace(/\/+$/, ""),
    compress: opts.compress ?? false,
    proxyKey: opts.proxyKey,
    alive: true, // optimistic at boot; the first heartbeat corrects within ~HEARTBEAT_INTERVAL_MS
    consecutiveFail: 0,
    consecutiveOk: 0,
    lastFlipAt: 0,
    headerWaiters: new Set(),
    selfLoop: false,
  };
}

/**
 * Strip userinfo from an upstream that `new URL` cannot parse.
 *
 * `[^/]*` (not `[^/@]+`) so the cut lands on the LAST `@` before the path: an
 * unencoded `@` inside the password made the narrow class stop at the first one
 * and republish the tail. Measured 2026-09-20 in review of #159:
 * `https://user:p@ss@not a url` → `https://ss@not a url`. `new URL` reads that
 * form correctly, so the hole existed only on the unparseable branch — which is
 * precisely the branch whose whole job is to leak nothing.
 *
 * Shared by `/health` publication and by log redaction so the regex, and the
 * reason it is written this way, live in ONE place.
 */
function stripUnparseableUserinfo(upstream: string): string {
  return upstream.replace(/\/\/[^/]*@/, "//");
}

/**
 * #160: the upstream, safe to LOG. `/health` already refused to publish
 * credentials (see `relayHealthFields`), but three log lines interpolated
 * `state.upstream` verbatim — boot, and both hysteresis transitions. A relay
 * upstream may legitimately carry basic-auth userinfo (`https://user:pass@host`,
 * the documented SearXNG form), and `docker logs` is read by every cycle, quoted
 * into dashboard reports and archived: a credential there outlives the session
 * that printed it.
 *
 * Deliberately NARROWER than the `/health` field, which publishes the origin
 * only: a log keeps host, port and path, because those are what makes a
 * misconfigured upstream diagnosable. **A credential-free upstream is returned
 * byte-identical**, so on every machine in the fleet today these lines do not
 * change at all — the redaction arms only for the form that needs it.
 *
 * Never throws: an unparseable upstream degrades to the regex above.
 */
export function redactUpstreamForLog(upstream: string): string {
  try {
    const u = new URL(upstream);
    if (!u.username && !u.password) return upstream;
    u.username = "";
    u.password = "";
    // `toString()` re-adds the trailing slash `createRelayState` strips.
    return u.toString().replace(/\/+$/, "");
  } catch {
    return stripUnparseableUserinfo(upstream);
  }
}

/**
 * #157: the role this node believes it is playing, for `/health`. On
 * 2026-09-19 a hub recreated as a relay forwarding to ITSELF (ARR loops back)
 * served 4h40 of `200 {"status":"ok"}` while flapping 193 times — healthy and
 * false at the same time, invisible to every prober, because `/health` said
 * nothing about the role. Same family as the 02/09 outage this handler's
 * comment documents: a 200 that doesn't say what the process is.
 *
 * Reads two in-memory fields — constant-time, no I/O, never throws. The
 * upstream is published as ORIGIN ONLY: `/health` is unauthenticated, and an
 * upstream configured with userinfo (`https://user:pass@host`, the documented
 * SearXNG form) would leak a credential on it.
 */
export function relayHealthFields(
  relay?: RelayState
): { role: "hub" | "relay-nominal" | "relay-autonomous"; upstream: string | null } {
  if (!relay?.upstream) return { role: "hub", upstream: null };
  let upstream: string;
  try {
    upstream = new URL(relay.upstream).origin;
  } catch {
    // Unparseable config: still never publish credentials — strip any userinfo.
    // See `stripUnparseableUserinfo` for why the class is `[^/]*`.
    upstream = stripUnparseableUserinfo(relay.upstream);
  }
  return { role: relay.alive ? "relay-nominal" : "relay-autonomous", upstream };
}

function markFail(state: RelayState, reason: string): void {
  state.consecutiveOk = 0;
  state.consecutiveFail++;
  if (state.alive && state.consecutiveFail >= FAIL_THRESHOLD) {
    state.alive = false;
    state.lastFlipAt = Date.now();
    // #323 (review B1) — release the in-flight header waits on the flip. The
    // flip is the earliest trustworthy verdict that those waits are dead (the
    // stall detector + 2 heartbeats ≈ 200s, vs a 360s budget they would each
    // otherwise sit out). Flag BEFORE aborting so forwardToUpstream's catch can
    // tell a flip-abort from its own deadline (distinct fallthrough label, no
    // second markFail, no pointless retry).
    if (state.headerWaiters) {
      for (const ctl of state.headerWaiters) {
        (ctl as any)._relayFlipAbort = true;
        ctl.abort();
      }
    }
    log(
      `[Relay] upstream ${redactUpstreamForLog(state.upstream)} DOWN after ${state.consecutiveFail} failure(s) (${reason}) → AUTONOMOUS`,
      true
    );
  }
}

/**
 * Log EVERY per-request fallthrough. `markFail` only speaks on its second
 * consecutive failure, so a single forward failure used to be completely invisible
 * while still changing behavior: the request is served by the local pipeline, so it
 * escapes central capture (attribution hole) and, on a CLAUDISH_NO_ANTHROPIC
 * machine, a native target is rerouted to the budget model. Silent degradation of
 * that kind is the one thing a relay must never do.
 * Not called from the prober — heartbeat failures would spam one line per 10s tick.
 */
function logFallthrough(state: RelayState, reason: string): void {
  log(
    `[Relay] forward failed (${reason}) → this request served LOCALLY ` +
      `[${state.consecutiveFail}/${FAIL_THRESHOLD} before AUTONOMOUS]`,
    true
  );
}

// ── #279: per-request hop marker ────────────────────────────────────
// #156's heartbeat identity sees a node forwarding to ITSELF (its own /health
// comes back). It cannot see (a) the boot window — `alive` starts optimistic,
// so a request arriving before the ~10s first heartbeat still forwards — nor
// (b) an A→B→A cycle, where each node's /health is answered by the OTHER node
// and every id comparison says "healthy, not self". The request itself is the
// only witness that traverses the loop: each forward appends its sender's
// instanceId to a hop list, and a node that finds ITS OWN id in the list it
// received is, by construction, re-receiving a request it already forwarded.

/**
 * #279: the hop-list header. Appended-to on every forward (never replaced —
 * upstream ids are the evidence), checked on arrival. A plain custom header in
 * the same survival class as X-Claudish-Machine (which the copy loop in
 * `forwardToUpstream` preserves across the hop); it must never collide with
 * `authorization` / `x-proxy-key` handling, and it carries nothing but random
 * per-process nonces, derived from nothing.
 */
export const HOPS_HEADER = "x-claudish-hops";

export function parseHops(value: string | undefined | null): string[] {
  if (!value) return [];
  return value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Append `id` to the incoming hop list, preserving whatever arrived. */
export function appendHop(value: string | undefined | null, id: string): string {
  return [...parseHops(value), id].join(",");
}

/** True when the hop list names THIS process — a forward of ours came back. */
export function hopsContainSelf(value: string | undefined | null): boolean {
  return parseHops(value).includes(getInstanceId());
}

/**
 * #279 route seam: did one of OUR forwards come back to us? The caller serves
 * the request locally instead of forwarding again (never-hang outranks
 * diagnostic cleanliness — a refusal would stall the agent) and logs one
 * forceConsole marker. Only meaningful on a relay (`options.relay` set): a hub
 * legitimately receives hop-marked forwards from its sidecars and must ignore
 * the header. Accepted trade-off: `instanceId` is published on the
 * unauthenticated `/health`, so a client COULD forge a one-hop list naming us
 * to force local serving of its own request — worst case is one request served
 * by the local cascade instead of the hub, loudly logged by the marker.
 */
export function requestLoopedBack(c: Context): boolean {
  return hopsContainSelf(c.req.raw.headers.get(HOPS_HEADER));
}

/**
 * Forward a request to the upstream hub. Returns the piped Response on success,
 * or `null` on a pre-stream failure (caller falls through to local handling).
 * Never throws.
 */
export async function forwardToUpstream(
  c: Context,
  body: unknown,
  state: RelayState,
  headerTimeoutMs: number = resolveForwardHeadersTimeoutMs()
): Promise<Response | null> {
  // Build outbound headers: copy inbound minus hop-by-hop (this PRESERVES
  // X-Claudish-Machine so central attribution survives the relay — the whole
  // point of the capture-machine-attribution foundation), then inject the
  // cluster proxy key so the hub's auth accepts the forward.
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  for (const [key, value] of c.req.raw.headers.entries()) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    if (typeof value !== "string") continue;
    headers[key] = value;
  }
  // #279 — append this process's id to the hop list (an inbound list is
  // preserved verbatim before our id: the upstream ids ARE the evidence a
  // re-visited node will check). Overwrites the copy the loop above made of
  // the inbound value, if any.
  headers[HOPS_HEADER] = appendHop(c.req.raw.headers.get(HOPS_HEADER), getInstanceId());
  // #416 — the relay's cluster key authenticates the RELAY, never its client.
  //
  // The auth middleware (registerForkExtensions, mounted before every route)
  // marks a request whose Anthropic-shaped target it admitted WITHOUT the
  // caller holding a key of its own (keyless-exempt.ts, #412). Injecting the
  // cluster key here on such a request would hand that client the fleet's
  // credential at the hub — the elevation #412 exists to close, reopened by the
  // very hop that carries it. Measured shape: a keyless native client through a
  // sidecar arrives at the hub authenticated, and `[InboundKey]`/keyless
  // accounting never sees it.
  const keyless = isKeylessExempt(c.req.raw);
  if (state.proxyKey && !keyless) {
    // Inject the cluster proxy key as x-proxy-key (NOT x-api-key). The hub's
    // auth gate accepts x-proxy-key, but NativeHandler's proxyKey→Anthropic swap
    // only triggers on x-api-key/authorization == proxyKey. Using x-proxy-key
    // means a relayed native (Opus) request does NOT swap → the client's own
    // OAuth (preserved below) passes through to Anthropic. This is what lets
    // ai-01's Opus traverse sidecar → hub → Anthropic: the hub stores no
    // Anthropic key of its own, so the x-api-key swap path would 401. Executors
    // (glm/minimax) are unaffected — they carry no OAuth, and the gate still
    // passes on x-proxy-key. See memory proxy-key-custom-header-auth.
    delete headers["x-api-key"]; // a stale client x-api-key==proxyKey would re-arm the hub swap
    headers["x-proxy-key"] = state.proxyKey;
    // KEEP authorization — preserves the client OAuth for native passthrough.
  } else if (keyless) {
    // Explicit decision on the two neighbouring headers, on the keyless path:
    //
    // - `x-api-key` is KEPT, unlike the keyed branch above. On that branch the
    //   delete exists to stop a stale copy of OUR cluster key re-arming the
    //   hub's proxyKey→Anthropic swap; here the value cannot be our cluster key
    //   at all — the middleware only marks keyless after `matchesProxyKey`
    //   failed on exactly this header value at THIS process's key list. What it
    //   can be is the client's own `sk-ant-…` API key, and deleting it would
    //   strip the only credential of a native client authenticating that way:
    //   the hub would then see no credential, take the #296 shape-A path, and
    //   answer 403 where the pre-#412 relay worked. The exemption means "spends
    //   its OWN credential" — so its own credential travels.
    // - `x-proxy-key` is DROPPED anyway. It is the relay's own header: a hub
    //   with a different key value would read a non-matching forwarded copy as
    //   an authentication attempt, and nothing legitimate ever puts a client
    //   value there (a matching one would have authenticated this request one
    //   line earlier, so this branch cannot see one). Not forwarding it keeps
    //   the "no key" reading at the hub unambiguous.
    delete headers["x-proxy-key"];
    // logStderr, not log(): a sidecar runs with debug off, where log() is
    // file-only and the marker would be invisible to `docker logs` — the same
    // reason the sibling `[InboundKey]` / `[Relay] forward connect failed`
    // markers exist (#212 lesson). One line per keyless forward is the
    // countable evidence for the post-deploy consumer check (#416 DoD).
    logStderr("[Relay] keyless-exempt forward — cluster key not injected (#416)");
  }

  // Serialize (body already consumed by the route's readRequestBody). Optionally
  // gzip for WAN externals — the uplink (system + history + tools) is the
  // constrained direction; the hub inflates via readRequestBody().
  let payload: Uint8Array | string = JSON.stringify(body);
  if (state.compress) {
    try {
      payload = gzipSync(Buffer.from(payload as string, "utf-8"));
      headers["content-encoding"] = "gzip";
    } catch (e) {
      log(`[Relay] gzip failed, sending uncompressed: ${String(e)}`);
      payload = JSON.stringify(body);
    }
  }

  // Bound ONLY the header-fetch phase, not the (arbitrarily long) body stream.
  // AbortSignal.timeout() would keep firing after headers arrive and abort the
  // streaming body mid-flight — truncating every real response at ~5s. So use an
  // AbortController and clear the timer the instant fetch() resolves (= headers
  // received); the body then streams unbounded, and a mid-stream hub death is
  // handled by createAnthropicPassthroughStream's finalizeWithError (never-hang).
  //
  // #80 part 2 — one connect retry before falling through. The container →
  // host.docker.internal tunnel resets chronically (~1 per 8 min measured over
  // 12 h, 87 failures, while the hub itself answered /health in 4 ms throughout:
  // the defect is the Docker Desktop transport, not the hub). A connect failure
  // is a FAST failure (socket refused/reset in ms), so one retry at +250 ms
  // absorbs the blip at no perceptible cost — and an ABSORBED retry does not
  // markFail, so the chronic blips stop feeding the AUTONOMOUS hysteresis and
  // stop diverting requests to the local cascades (which the central capture
  // never sees, and which may bill PAYG the hub's subscriptions would have
  // covered). A header deadline is NOT retried (that would double the budgeted
  // stall), and neither is an HTTP 5xx (the hub answered; hysteresis owns it).
  let res: Response | null = null;
  let lastErr: unknown = null;
  let lastWasHeaderDeadline = false;
  let lastWasFlipAbort = false;
  let fetchStartedAt = performance.now();
  // Path-aware forward: relay to the SAME route the client hit, so an OpenAI
  // request (/v1/chat/completions) reaches the hub's OpenAI ingress rather
  // than /v1/messages. Falls back to /v1/messages when the path is missing
  // (older callers / tests) to preserve the historical behavior.
  const reqPath =
    typeof c.req?.path === "string" && c.req.path.startsWith("/v1/")
      ? c.req.path
      : "/v1/messages";
  // #323 (review B2): ONE header deadline for the whole relayed turn. Every
  // header leg — the initial attempt, its connect retry, and each #170
  // re-forward — arms `max(0, deadline − now)`, never a fresh budget: 3 legs ×
  // 360s would spend 1 080s in headers alone, past the client's 10-min timeout,
  // and the client would abandon the turn with a timeout error instead of
  // receiving the relay's well-formed finalization. When no budget remains the
  // leg aborts immediately and returns null, so the parser surfaces the
  // original death exactly as it does today.
  const headerDeadlineAt = Date.now() + headerTimeoutMs;
  for (let attempt = 0; attempt <= CONNECT_RETRIES; attempt++) {
    const headerController = new AbortController();
    const headerTimer = setTimeout(
      () => headerController.abort(),
      Math.max(0, headerDeadlineAt - Date.now())
    );
    fetchStartedAt = performance.now();
    // Registered for the prober's flip-abort (see RelayState.headerWaiters) —
    // only while headers are pending; a controller whose headers arrived must
    // not be aborted by a later flip (the body is unbounded by design).
    (state.headerWaiters ??= new Set()).add(headerController);
    try {
      res = await fetch(`${state.upstream}${reqPath}`, {
        method: "POST",
        headers,
        body: payload,
        signal: headerController.signal,
      });
      clearTimeout(headerTimer); // headers in → stop bounding; body is unbounded
      lastErr = null;
      break;
    } catch (e) {
      clearTimeout(headerTimer);
      lastErr = e;
      lastWasFlipAbort = (headerController as any)._relayFlipAbort === true;
      lastWasHeaderDeadline = (e as any)?.name === "AbortError" && !lastWasFlipAbort;
      // A slow upstream or a flipped hub: retrying either doubles the stall or
      // forwards to a hub we just declared dead.
      if (lastWasHeaderDeadline || lastWasFlipAbort) break;
      if (attempt < CONNECT_RETRIES) {
        log(
          `[Relay] forward connect failed (${String(e).slice(0, 80)}) — retrying ${attempt + 1}/${CONNECT_RETRIES}`,
          true
        );
        await new Promise((r) => setTimeout(r, CONNECT_RETRY_DELAY_MS));
      }
    } finally {
      state.headerWaiters.delete(headerController);
    }
  }
  if (lastErr !== null) {
    // Three outcomes of opposite natures land here, and only one of them
    // says anything about whether the HUB is alive.
    //
    // A refused / reset / DNS-failed connection is direct evidence the hub is
    // unreachable, so it feeds the hysteresis — that is what the hysteresis is for.
    //
    // Our OWN header deadline firing is not. It says the upstream PROVIDER was slow
    // to first byte; the hub may be answering /health in under 100ms throughout.
    // Feeding markFail here let a throttled provider drive the hub's state machine:
    // two slow POSTs in a row flipped the whole machine to AUTONOMOUS, and because
    // markFail also zeroes `consecutiveOk`, it erased progress toward recovery.
    // That contradicts this module's own design, stated at FORWARD_HEADERS_TIMEOUT_MS:
    // the bound "is NOT a liveness detector — the heartbeat prober owns that".
    //
    // Measured on ai-01, 2026-08-24: 23 header-deadline fallthroughs in 24h, 21 of
    // them a single failure short of the threshold, and 1 of the day's 2 AUTONOMOUS
    // episodes (3m06s, machine-wide, all traffic off the hub) caused this way while
    // the hub stayed healthy. The blast radius, not the 3 minutes, is the point.
    //
    // Trade-off, accepted knowingly: a hub that answered /health but black-holed
    // POSTs would no longer be demoted by this path, so every request would spend
    // the full deadline before falling through. That was justified with "Never
    // observed" — and on 2026-09-02 it was observed, fleet-wide: the hub went
    // silent at 03:20:45Z, kept answering /health from a wedged process, and no
    // machine failed over until a manual reboot 2h27 later. The conclusion was
    // still right (this path must not own liveness) but the gap was real, so it
    // is now closed twice over: /health itself reports whether the request
    // pipeline is MOVING (streams in flight with no byte for
    // CLAUDISH_STALL_THRESHOLD_MS → 503), which the prober below already acts on
    // (see fork/server/stream-registry.ts) — and since #323 the NOMINAL→AUTONOMOUS
    // flip proactively aborts the in-flight header waits, so a wedged hub no
    // longer costs each request its full budget.
    //
    // A flip-abort is the third nature: the waiter was aborted by the prober's
    // transition (markFail), not by its own deadline. The flip has already spoken
    // (this very markFail is what aborted us), so it must neither markFail again
    // — double-counting one verdict — nor read as latency. Its fallthrough label
    // `aborted-on-autonomous` is what keeps the three apart in the logs.
    //
    // The request itself still falls through, and every fallthrough is still logged.
    // Only the machine-wide contagion is removed.
    const detail = String(lastErr).slice(0, 80);
    if (!lastWasHeaderDeadline && !lastWasFlipAbort) {
      markFail(state, `forward-connect: ${detail}`);
    }
    // Label the natures apart. Reporting a header deadline as `connect:` is what hid
    // this: the log named a connection failure while the cause was latency.
    logFallthrough(
      state,
      lastWasFlipAbort
        ? "aborted-on-autonomous"
        : lastWasHeaderDeadline
          ? `header-timeout after ${headerTimeoutMs}ms`
          : `connect: ${detail}`
    );
    return null;
  }
  if (!res) return null; // unreachable: loop exits with res set or lastErr set

  // #318 — a 503 the hub marked as its OWN drain admission freeze is
  // deliberate and temporary (the hub is about to restart; Retry-After: 15).
  // Same family as the 529 below: the hub spoke, so this is liveness
  // evidence, not a failure. Unmarked 503s keep the fallthrough — a hub's
  // own death is still a real 503, and that discrimination is why the marker
  // must be an explicit header (real provider overloads emit an
  // Anthropic-shaped overloaded_error body too, so body sniffing cannot tell
  // them apart).
  const drainFreeze503 = res.status === 503 && res.headers.get("x-claudish-drain-freeze") === "1";

  if (res.status !== 529 && !drainFreeze503 && res.status >= 500) {
    // Hub answered 5xx → treat as unhealthy, fall back to local for this request.
    // (500/502/504 and an UNMARKED 503 keep this behavior — those CAN be the
    // hub's own failure.)
    markFail(state, `forward-http-${res.status}`);
    logFallthrough(state, `hub HTTP ${res.status}`);
    return null;
  }

  if (res.status === 529) {
    // #299 A — provider overload relayed by a LIVE hub. The hub answered, so it
    // is healthy: 529 is the upstream provider saying "overloaded", the same
    // principle the header deadline established ("a throttled provider must not
    // drive the hub's state machine"). Falling through to local here would (a)
    // replay the request against the SAME overloaded provider, doubling its
    // load on every client retry, (b) move the request off the central capture,
    // and (c) two in a row would flip the whole machine AUTONOMOUS for every
    // role. Pass it through exactly like a 4xx: the hub spoke, the client hears it.
    // forceConsole: the fallthrough line this replaces was forceConsole, and a
    // plain log() is file-only — a no-op on a production relay (debug off).
    log(`[Relay] hub HTTP 529 (provider overload) — passed through to client, no local replay (#299)`, true);
  }

  if (drainFreeze503) {
    // #318 — our own drain window, passed through for the same reasons as the
    // 529: the hub is alive and deliberate, and a local replay would (a) fight
    // the drain it exists to survive, (b) eject the request from the central
    // capture onto the relay's local cascades (budget/PAYG where the hub's
    // subscriptions would have served), and (c) let two freezes flip the relay
    // AUTONOMOUS because the hub is being maintained. forceConsole, countable.
    log(`[Relay] hub HTTP 503 (drain admission freeze, marked) — passed through to client, no local replay (#318)`, true);
  }

  // Success (2xx/3xx/4xx), a relayed 529, or a marked drain-freeze 503. Reset
  // the failure streak; a 4xx is a real client error that local handling would
  // reproduce, and a 529 is the provider's overload — neither is evidence about
  // the hub's health, so pass through rather than replay locally.
  state.consecutiveFail = 0;

  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream")) {
    // Non-streaming (e.g. /compact stream:false, or a 4xx JSON error) — buffer + return.
    // #229: the hub may set the failover-notice header on this branch too (an
    // OpenAI client's non-streamed answer); this rebuild must not be where it dies.
    const text = await res.text().catch(() => "");
    // #318 — a 503 (drain freeze, or any relayed error) is almost always
    // application/json, so THIS rebuild is the pass-through path for it. The
    // hub's Retry-After is the freeze's contract with the client ("retry in
    // 15s") and the old rebuild dropped it for every relayed non-streaming
    // error; preserve it whenever the hub sent one.
    const retryAfter = res.headers.get("retry-after");
    // #318 review — the marker must survive the hop too. In a chain A→B→hub,
    // B passes the freeze 503 through to A, and A is itself a relay: without
    // the marker on the relayed response, A reads a plain 503 and does exactly
    // what #318 removes (markFail + local replay + AUTONOMOUS flips, all
    // because the hub is being drained). Chains are a supported topology
    // (#279's hop list exists because A→B shapes happen), so the property
    // has to compose. Fixed literal set by our own hub — nothing sensitive.
    const drainFreezeMarker = res.headers.get("x-claudish-drain-freeze");
    return carryNoticeHeader(
      res,
      new Response(text, {
        status: res.status,
        headers: {
          "Content-Type": contentType || "application/json",
          ...(retryAfter ? { "retry-after": retryAfter } : {}),
          ...(drainFreezeMarker ? { "x-claudish-drain-freeze": drainFreezeMarker } : {}),
        },
      })
    );
  }

  // Streaming — reuse the battle-tested passthrough (ping keepalive +
  // finalizeWithError). capture:false → the hub captures centrally; the sidecar
  // must not double-capture (nor write an orphan resp-*.sse) in nominal mode.
  const model = (body as { model?: string } | undefined)?.model ?? "(relay)";
  // #170 — re-issue the forward when the hub dies before any client-visible event.
  // A hub restart cuts every in-flight SSE on every relaying machine; the streams
  // that had not yet emitted are recoverable, and this closure is what makes them
  // so. Header-bounded like the original forward (an unbounded re-forward against a
  // wedged hub would hang the very turn this exists to save), and it deliberately
  // does NOT markFail: a recovery attempt is not a liveness measurement — the same
  // separation #80 part 2 established for the absorbed connect retry. The heartbeat
  // prober owns the hysteresis. boundRetryUpstream gives the REPLACEMENT stream its
  // own first-event watchdog, which matters more here than on any other lane: the
  // relay bypasses ComposedHandler, so there is no outer wrap to inherit and a
  // mute-but-200 replacement would hang the client (#108's exact failure mode).
  const reforward = boundRetryUpstream(async () => {
    const reforwardController = new AbortController();
    // #323 (review B2): the re-forward draws on the turn's ONE header deadline
    // (headerDeadlineAt), never a fresh budget — 2 re-forwards × a fresh 360s
    // each would spend 1 080s in headers on one turn, past the client's 10-min
    // timeout. Zero remaining aborts immediately → null → the parser surfaces
    // the original death. Registered in headerWaiters like the initial attempt:
    // a prober flip while a re-forward waits on headers releases it too.
    const reforwardTimer = setTimeout(
      () => reforwardController.abort(),
      Math.max(0, headerDeadlineAt - Date.now())
    );
    (state.headerWaiters ??= new Set()).add(reforwardController);
    try {
      return await fetch(`${state.upstream}${reqPath}`, {
        method: "POST",
        headers,
        body: payload,
        signal: reforwardController.signal,
      });
    } catch {
      return null; // refused / reset / deadline / flip-abort → the parser surfaces the original death
    } finally {
      clearTimeout(reforwardTimer);
      state.headerWaiters.delete(reforwardController);
    }
  }, String(model));
  // #229: the passthrough rebuilds its response headers from a fresh literal,
  // so the hub's failover-notice header (set by the hub's own /v1/chat/completions
  // translation) is carried across explicitly — a sidecar-relayed OpenAI client
  // must see the same notice signal a direct-to-hub client sees.
  return carryNoticeHeader(
    res,
    createAnthropicPassthroughStream(c, res, {
      modelName: String(model),
      capture: false,
      retryUpstream: reforward,
      // Relay-side TTFT: fetch dispatch → hub headers. The [ttft] marker this
      // feeds is the measurement that splits "upstream slow to first byte"
      // from "long generation" — the exact question the header deadline raises.
      headerLatencyMs: Math.round(performance.now() - fetchStartedAt),
    })
  );
}

/**
 * Cheap liveness heartbeat: the hub's unauthenticated /health endpoint.
 *
 * #156 — self-loop detection. The 2026-09-19 incident (a hub recreated as a
 * relay forwarding to itself through ARR) flapped 193 times in 4h40 while
 * serving 200s: string comparison cannot see a public URL looping back, but
 * IDENTITY can. /health publishes a per-process `instanceId` (see
 * instance-id.ts); when the upstream's equals ours, the upstream IS this
 * process — whatever the URL. The first detection logs one forceConsole
 * marker, and the heartbeat counts as failed so the hysteresis settles
 * AUTONOMOUS (the node serves locally, which is right for a hub misconfigured
 * as a relay) instead of flapping. Detection is deliberately conservative: a
 * reply with no `instanceId` (older image), a non-JSON body, or a different id
 * is NOT a self-loop, and the verdict falls back to `res.ok` exactly as before.
 *
 * Exported for the regression test only.
 */
export async function heartbeat(state: RelayState): Promise<boolean> {
  try {
    const res = await fetch(`${state.upstream}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    // Body-read failure is a fetch failure (false), NOT "not detected" — an
    // aborted read must not be laundered into a healthy verdict.
    let text: string;
    try {
      text = await res.text();
    } catch {
      return false;
    }
    // JSON.parse failure IS "not detected": a non-JSON 200 keeps the pre-#156
    // verdict (true) rather than reaching the outer catch as a failure.
    let upstreamId: unknown = undefined;
    try {
      upstreamId = (JSON.parse(text) as { instanceId?: unknown } | null)?.instanceId;
    } catch {
      // non-JSON → not detected
    }
    if (typeof upstreamId === "string") {
      const isSelf = upstreamId === getInstanceId();
      if (isSelf !== state.selfLoop) {
        state.selfLoop = isSelf;
        if (isSelf) {
          log(
            `[Relay] upstream resolves to SELF — misconfigured topology (${redactUpstreamForLog(state.upstream)}) — heartbeat counted as failed, settling AUTONOMOUS`,
            true
          );
        } else {
          log(
            `[Relay] upstream no longer resolves to SELF (${redactUpstreamForLog(state.upstream)}) — resuming normal health evaluation`
          );
        }
      }
      if (isSelf) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Canonical fleet id for THIS process, or `""` when unknown (#345).
 *
 * Sourced from `CLAUDISH_MACHINE`, which `install-sidecar.ps1 -Machine` writes
 * into the per-machine `.env` (compose injects it — a name absent from the
 * compose list never reaches the container, #304). Deliberately NOT derived
 * from the host: inside a container `os.hostname()`/`HOSTNAME` is the container
 * id and `COMPUTERNAME` is the engine's, never the machine's — a WRONG value
 * here is worse than none, because it forks attribution (the exact defect
 * `verify-machine-header.py` exists to catch). Read per call, like every
 * runtime knob here; empty = send no header (= the hub, where the relay branch —
 * and therefore this probe — never runs).
 */
function machineName(): string {
  const v = process.env.CLAUDISH_MACHINE;
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Deep probe (port of scripts/claudish-watchdog.ps1 Test-ProxyWithTools): a real
 * tool-call stream must complete with a terminal `message_stop`. Confirms the
 * WHOLE pipeline works — not just that /health answers — before returning to
 * relay. Only run during recovery, so its handful of budget tokens is negligible.
 *
 * **A quota wall is liveness, not death.** The probe asks the hub for one specific
 * model (`glm-5.3`); when that model's plan is spent the hub answers 429/402 —
 * which it can only do by being alive, authenticating the request, routing it and
 * reaching the provider. Reading that as "hub down" holds the recovery gate shut
 * for as long as the wall lasts, and AUTONOMOUS is the worse place to wait: the
 * sidecar then serves the *same* walled model locally, where the failover cascade
 * is usually not configured (measured on ai-01, 2026-08-24→25: 25 of 43
 * locally-served requests died on that exact wall in 20.6h).
 *
 * `isQuotaExhaustion` is the same predicate the budget failover arms on, not a
 * copy — 402 on status alone, 429 only when the body names a quota/credit/balance/
 * weekly/plan wall. Its narrowness is the safety property: a per-minute burst
 * still reads as "not proven alive", and 401/404 never qualify, so a bad proxy key
 * or a bad model id can never be laundered into a health verdict.
 *
 * Bounded like the rest of the probe: the `fetch` carries
 * `AbortSignal.timeout(DEEP_PROBE_TIMEOUT_MS)`, which covers the error-body read
 * too, and any throw lands in the catch below as `false`.
 *
 * No evidence exists that this defect has fired. 24h of ai-01 sidecar logs show 5
 * AUTONOMOUS switches and 5 returns to NOMINAL, every duration explained by a
 * genuine hub absence. It is fixed on correctness and observability, not on a
 * measured incident.
 *
 * Exported for the regression test only.
 */
export async function deepProbe(state: RelayState): Promise<boolean> {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (state.proxyKey) headers["x-proxy-key"] = state.proxyKey;
    // #345: identify ourselves so the hub attributes this probe to its machine
    // instead of filing it as a header-less phantom lane. Only when the name is
    // known — an unset CLAUDISH_MACHINE keeps the request byte-identical to
    // before, which is the hub's case (no relay branch, so no probe at all).
    const machine = machineName();
    if (machine) headers["X-Claudish-Machine"] = machine;
    const body = JSON.stringify({
      model: "glm-5.3",
      max_tokens: 100,
      stream: true,
      tools: [
        {
          name: "Bash",
          description: "Run a shell command",
          input_schema: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
        {
          name: "Read",
          description: "Read a file",
          input_schema: {
            type: "object",
            properties: { file_path: { type: "string" } },
            required: ["file_path"],
          },
        },
      ],
      messages: [{ role: "user", content: "List the current directory using Bash. Do it now." }],
    });
    const startedAt = Date.now();
    const res = await fetch(`${state.upstream}/v1/messages`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(DEEP_PROBE_TIMEOUT_MS),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      if (isQuotaExhaustion(res.status, errBody)) {
        log(
          `[Relay] deep probe: upstream answered ${res.status} naming a quota/plan wall — ` +
            `that IS liveness (it routed the request to answer), returning to NOMINAL`,
          true
        );
        return true;
      }
      log(`[Relay] deep probe failed: upstream HTTP ${res.status}`, true);
      return false;
    }
    if (!res.body) {
      log(`[Relay] deep probe failed: HTTP ${res.status} with no body`, true);
      return false;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let acc = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      acc += decoder.decode(value, { stream: true });
      if (acc.includes("message_stop")) {
        // #298 b1: a SUCCESSFUL probe used to leave no trace — its only
        // evidence was the "healthy again" line a cooldown later, so "the
        // probe ran, silently" was indistinguishable from "recovery happened
        // without a probe" (that silence produced a retracted false reading
        // about where the probe is served, 06/10). One bounded line per
        // probe, on the deep-probe path only — never per heartbeat.
        log(`[Relay] deep probe OK — message_stop after ${Date.now() - startedAt}ms`, true);
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        return true;
      }
      if (acc.length > 200_000) break; // bound memory
    }
    // Reached only by a stream that ended (or overran) without a terminal frame.
    log(
      `[Relay] deep probe failed: stream ended after ${acc.length} bytes without message_stop`,
      true
    );
    return false;
  } catch (e) {
    // Every other exit already logged its reason; this one carries the last.
    // Without these lines a sidecar held in AUTONOMOUS behind a healthy hub gave
    // no signal at all — the gate was invisible in the logs.
    log(`[Relay] deep probe failed: ${String(e).slice(0, 200)}`, true);
    return false;
  }
}

/**
 * One prober pass: heartbeat → hysteresis. Extracted from `startUpstreamProber`
 * (#156) so the self-loop regression can drive the REAL decision loop (not a
 * re-implementation) without waiting on wall-clock intervals. Behavior-identical
 * to the former inline closure; the "at most one in-flight deep probe per state"
 * guard lives in a WeakSet so it survives the extraction.
 *
 * Exported for the regression test only — production reaches it through
 * `startUpstreamProber`.
 */
const probingStates = new WeakSet<RelayState>();

export async function proberTick(state: RelayState): Promise<void> {
  const ok = await heartbeat(state);
  if (state.alive) {
    // Nominal: any heartbeat failure counts toward failover.
    if (ok) state.consecutiveFail = 0;
    else markFail(state, "heartbeat");
    return;
  }
  // Autonomous: accumulate OK heartbeats, then confirm with a deep probe
  // (+ cooldown) before returning to relay — avoids flapping on a flaky link.
  if (!ok) {
    state.consecutiveOk = 0;
    return;
  }
  state.consecutiveOk++;
  if (
    state.consecutiveOk >= OK_THRESHOLD &&
    Date.now() - state.lastFlipAt >= RECOVERY_COOLDOWN_MS &&
    !probingStates.has(state)
  ) {
    probingStates.add(state);
    try {
      const deep = await deepProbe(state);
      if (deep) {
        state.alive = true;
        state.consecutiveFail = 0;
        state.consecutiveOk = 0;
        state.lastFlipAt = Date.now();
        log(
          `[Relay] upstream ${redactUpstreamForLog(state.upstream)} healthy again → NOMINAL (relay resumed)`,
          true
        );
      } else {
        // deepProbe logged the reason on every false path.
        state.consecutiveOk = 0; // keep waiting
      }
    } finally {
      probingStates.delete(state);
    }
  }
}

/**
 * Start the background prober. Returns a stop function. Only call when an upstream
 * is configured (i.e. this process is a sidecar, not the hub). Never throws.
 */
export function startUpstreamProber(state: RelayState): () => void {
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await proberTick(state);
    } catch (e) {
      // The prober must never throw.
      log(`[Relay] prober tick error: ${String(e)}`);
    }
  };

  const interval = setInterval(() => void tick(), HEARTBEAT_INTERVAL_MS);
  void tick(); // correct boot-time state fast
  log(
    `[Relay] sidecar mode: upstream=${redactUpstreamForLog(state.upstream)} compress=${state.compress}`,
    true
  );

  return () => {
    stopped = true;
    clearInterval(interval);
  };
}
