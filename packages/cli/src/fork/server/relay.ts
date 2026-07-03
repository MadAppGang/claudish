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
import { log } from "../../logger.js";
import { createAnthropicPassthroughStream } from "../../handlers/shared/stream-parsers/anthropic-sse.js";

/** Headers we must not blindly forward to the upstream. */
const HOP_BY_HOP = new Set([
  "host", "connection", "keep-alive", "transfer-encoding", "te",
  "trailer", "upgrade", "content-length", "content-encoding",
]);

export interface RelayState {
  /** Upstream hub base URL, e.g. "http://192.168.0.46:3000" or "https://models.myia.io". */
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
const FORWARD_HEADERS_TIMEOUT_MS = 5_000; // pre-stream deadline; longer stream is unbounded
const DEEP_PROBE_TIMEOUT_MS = 30_000;

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
  };
}

function markFail(state: RelayState, reason: string): void {
  state.consecutiveOk = 0;
  state.consecutiveFail++;
  if (state.alive && state.consecutiveFail >= FAIL_THRESHOLD) {
    state.alive = false;
    state.lastFlipAt = Date.now();
    log(
      `[Relay] upstream ${state.upstream} DOWN after ${state.consecutiveFail} failure(s) (${reason}) → AUTONOMOUS`,
      true
    );
  }
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
  headerTimeoutMs: number = FORWARD_HEADERS_TIMEOUT_MS
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
  if (state.proxyKey) {
    delete headers["authorization"];
    headers["x-api-key"] = state.proxyKey;
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
  let res: Response;
  const headerController = new AbortController();
  const headerTimer = setTimeout(() => headerController.abort(), headerTimeoutMs);
  try {
    res = await fetch(`${state.upstream}/v1/messages`, {
      method: "POST",
      headers,
      body: payload,
      signal: headerController.signal,
    });
    clearTimeout(headerTimer); // headers in → stop bounding; body is unbounded
  } catch (e) {
    // Pre-stream failure (connection refused / header timeout) → fall through to local.
    clearTimeout(headerTimer);
    markFail(state, `forward-connect: ${String(e).slice(0, 80)}`);
    return null;
  }

  if (res.status >= 500) {
    // Hub answered 5xx → treat as unhealthy, fall back to local for this request.
    markFail(state, `forward-http-${res.status}`);
    return null;
  }

  // Success (2xx/3xx/4xx). Reset the failure streak; a 4xx is a real client error
  // that local handling would reproduce, so pass it through rather than retry.
  state.consecutiveFail = 0;

  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream")) {
    // Non-streaming (e.g. /compact stream:false, or a 4xx JSON error) — buffer + return.
    const text = await res.text().catch(() => "");
    return new Response(text, {
      status: res.status,
      headers: { "Content-Type": contentType || "application/json" },
    });
  }

  // Streaming — reuse the battle-tested passthrough (ping keepalive +
  // finalizeWithError). capture:false → the hub captures centrally; the sidecar
  // must not double-capture (nor write an orphan resp-*.sse) in nominal mode.
  const model = (body as { model?: string } | undefined)?.model ?? "(relay)";
  return createAnthropicPassthroughStream(c, res, {
    modelName: String(model),
    capture: false,
  });
}

/** Cheap liveness heartbeat: the hub's unauthenticated /health endpoint. */
async function heartbeat(state: RelayState): Promise<boolean> {
  try {
    const res = await fetch(`${state.upstream}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Deep probe (port of scripts/claudish-watchdog.ps1 Test-ProxyWithTools): a real
 * tool-call stream must complete with a terminal `message_stop`. Confirms the
 * WHOLE pipeline works — not just that /health answers — before returning to
 * relay. Only run during recovery, so its handful of budget tokens is negligible.
 */
async function deepProbe(state: RelayState): Promise<boolean> {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (state.proxyKey) headers["x-api-key"] = state.proxyKey;
    const body = JSON.stringify({
      model: "glm-5.2",
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
    const res = await fetch(`${state.upstream}/v1/messages`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(DEEP_PROBE_TIMEOUT_MS),
    });
    if (!res.ok || !res.body) return false;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let acc = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      acc += decoder.decode(value, { stream: true });
      if (acc.includes("message_stop")) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        return true;
      }
      if (acc.length > 200_000) break; // bound memory
    }
    return acc.includes("message_stop");
  } catch {
    return false;
  }
}

/**
 * Start the background prober. Returns a stop function. Only call when an upstream
 * is configured (i.e. this process is a sidecar, not the hub). Never throws.
 */
export function startUpstreamProber(state: RelayState): () => void {
  let stopped = false;
  let probing = false; // guard: at most one in-flight deep probe. setInterval does
  // not await tick(), so without this a 30s deepProbe would let the next 10s ticks
  // launch overlapping probes (double-spending budget tokens during recovery).

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const ok = await heartbeat(state);
      if (state.alive) {
        // Nominal: any heartbeat failure counts toward failover.
        if (ok) state.consecutiveFail = 0;
        else markFail(state, "heartbeat");
      } else {
        // Autonomous: accumulate OK heartbeats, then confirm with a deep probe
        // (+ cooldown) before returning to relay — avoids flapping on a flaky link.
        if (!ok) {
          state.consecutiveOk = 0;
          return;
        }
        state.consecutiveOk++;
        if (
          !probing &&
          state.consecutiveOk >= OK_THRESHOLD &&
          Date.now() - state.lastFlipAt >= RECOVERY_COOLDOWN_MS
        ) {
          probing = true;
          try {
            const deep = await deepProbe(state);
            if (deep) {
              state.alive = true;
              state.consecutiveFail = 0;
              state.consecutiveOk = 0;
              state.lastFlipAt = Date.now();
              log(`[Relay] upstream ${state.upstream} healthy again → NOMINAL (relay resumed)`, true);
            } else {
              state.consecutiveOk = 0; // deep probe failed; keep waiting
            }
          } finally {
            probing = false;
          }
        }
      }
    } catch (e) {
      // The prober must never throw.
      log(`[Relay] prober tick error: ${String(e)}`);
    }
  };

  const interval = setInterval(() => void tick(), HEARTBEAT_INTERVAL_MS);
  void tick(); // correct boot-time state fast
  log(`[Relay] sidecar mode: upstream=${state.upstream} compress=${state.compress}`, true);

  return () => {
    stopped = true;
    clearInterval(interval);
  };
}
