#!/usr/bin/env bun
/**
 * Relay resilience E2E — budget-free, self-contained.
 *
 * Drives the REAL prober (startUpstreamProber) and REAL forwardToUpstream against
 * a controllable mock "hub" (Bun.serve). Validates the full failover state
 * machine over real HTTP + real setInterval timing — the parts relay.test.ts
 * (fetch-mocked) cannot cover:
 *
 *   1. NOMINAL   — forward reaches the hub, returns its SSE terminated by
 *                  message_stop (never-hang).
 *   2. FAILOVER  — hub /health starts failing → prober flips alive→false after
 *                  FAIL_THRESHOLD heartbeats (AUTONOMOUS).
 *   3. RECOVERY  — hub /health recovers → prober runs a deep tool-call probe
 *                  (glm-5.2) against the hub, sees message_stop, and (after the
 *                  cooldown) flips alive→true (NOMINAL).
 *
 * No real provider keys, no budget: the mock hub answers every /v1/messages with
 * a canned Anthropic SSE. The autonomous LOCAL serve path is intentionally NOT
 * exercised here — it is the unchanged production pipeline (the hub's own
 * behavior), already covered elsewhere.
 *
 * Run:  bun run packages/cli/src/fork/server/relay-e2e.ts
 * ~2-3 min (heartbeat 10s, fail threshold 2, recovery cooldown 60s).
 */

import { createRelayState, forwardToUpstream, startUpstreamProber } from "./relay.js";

const HUB_PORT = 3999;

const CANNED_SSE =
  'event: message_start\ndata: {"type":"message_start","message":{"id":"m","role":"assistant","content":[],"model":"glm-5.2","usage":{"input_tokens":5,"output_tokens":0}}}\n\n' +
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n' +
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n' +
  'event: message_stop\ndata: {"type":"message_stop"}\n\n';

let hubHealthy = true;
let hubHealthHits = 0;
let hubMsgHits = 0;

const hub = Bun.serve({
  port: HUB_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      hubHealthHits++;
      return new Response(hubHealthy ? "ok" : "down", { status: hubHealthy ? 200 : 503 });
    }
    if (url.pathname === "/v1/messages") {
      hubMsgHits++;
      return new Response(CANNED_SSE, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response("not found", { status: 404 });
  },
});

/** Minimal Hono Context stub (req.raw.headers + body()). */
function mockCtx(headers: Record<string, string> = {}): any {
  return {
    req: { raw: { headers: new Headers(headers) } },
    body: (stream: any) =>
      new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(
  label: string,
  pred: () => boolean,
  timeoutMs: number,
  pollMs = 1000
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await sleep(pollMs);
  }
  return pred();
}

let failures = 0;
function check(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ✅ ${msg}`);
  } else {
    failures++;
    console.log(`  ❌ ${msg}`);
  }
}

async function main() {
  console.log(`[relay-e2e] mock hub on http://localhost:${HUB_PORT}`);
  const state = createRelayState({ upstream: `http://localhost:${HUB_PORT}` });
  const stopProber = startUpstreamProber(state);

  try {
    // ── Phase 1: NOMINAL — forward reaches the hub, returns message_stop ──────
    console.log("\n[Phase 1] NOMINAL forward");
    const r = await forwardToUpstream(mockCtx({ "x-claudish-machine": "e2e-test" }), { model: "glm-5.2" }, state);
    check(r !== null, "forward returned a Response");
    const out = r ? await r.text() : "";
    check(out.includes("message_stop"), "relayed SSE terminated with message_stop (never-hang)");
    check(hubMsgHits >= 1, `hub received the forwarded /v1/messages (hits=${hubMsgHits})`);
    check(state.alive === true, "state remains NOMINAL (alive=true)");

    // ── Phase 2: FAILOVER — hub /health fails → autonomous ───────────────────
    console.log("\n[Phase 2] FAILOVER (hub /health → 503)");
    hubHealthy = false;
    const flipped = await waitFor("autonomous", () => state.alive === false, 45_000);
    check(flipped, `prober flipped to AUTONOMOUS (alive=false, consecutiveFail=${state.consecutiveFail})`);

    // ── Phase 3: RECOVERY — hub /health recovers → deep probe → nominal ──────
    console.log("\n[Phase 3] RECOVERY (hub /health → 200, deep probe, cooldown)");
    const msgBefore = hubMsgHits;
    hubHealthy = true;
    // OK_THRESHOLD(3)*heartbeat(10s) + cooldown(60s) → allow up to ~120s.
    const recovered = await waitFor("nominal", () => state.alive === true, 130_000);
    check(recovered, "prober flipped back to NOMINAL (alive=true)");
    check(hubMsgHits > msgBefore, `deep tool-call probe hit the hub (msg hits ${msgBefore} → ${hubMsgHits})`);
  } finally {
    stopProber();
    hub.stop(true);
  }

  console.log(`\n[relay-e2e] ${failures === 0 ? "ALL CHECKS PASSED ✅" : `${failures} CHECK(S) FAILED ❌`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("[relay-e2e] fatal:", e);
  hub.stop(true);
  process.exit(1);
});
