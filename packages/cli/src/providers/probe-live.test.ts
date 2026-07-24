/**
 * probe-live unit tests.
 *
 * Fix "error · 400 hides auth failures": composed-handler REMAPS terminal
 * upstream errors (401/403/terminal-429) to HTTP 400 so Claude Code surfaces
 * them instead of silently retrying. The probe must classify a remapped auth
 * failure as auth-failed and display the UPSTREAM code, via the structured
 * `error.upstream_status` field the remap site attaches.
 *
 * Fixture policy: the remapped bodies below are produced by the SAME functions
 * the remap site in composed-handler.ts calls (buildSurfacedErrorMessage +
 * wrapAnthropicError with upstreamStatus) — real producer output, not a
 * hand-crafted divergent shape.
 */

import { describe, expect, test } from "bun:test";
import {
  buildSurfacedErrorMessage,
  wrapAnthropicError,
} from "../handlers/shared/anthropic-error.js";
import {
  PROBE_MAX_TOKENS,
  type ProbeResult,
  classifyHttpError,
  describeProbeState,
  probeLink,
} from "./probe-live.js";

/** The exact body the composed-handler remap path sends for a terminal error. */
function remappedTerminalBody(upstreamStatus: number, providerMessage: string): string {
  const surfaced = buildSurfacedErrorMessage({
    providerDisplayName: "OpenCode Zen",
    status: upstreamStatus,
    hint: "Check API key / OAuth credentials.",
    providerMessage,
  });
  return JSON.stringify(wrapAnthropicError(400, surfaced, "invalid_request_error", upstreamStatus));
}

describe("classifyHttpError — remapped terminal errors (upstream_status)", () => {
  test("400 carrying upstream_status 401 classifies as auth-failed with the UPSTREAM code", () => {
    const body = remappedTerminalBody(401, "invalid api key");
    const result = classifyHttpError(400, body, 123);
    expect(result.state).toBe("auth-failed");
    expect(result.httpStatus).toBe(401);
    // The TUI line must read "auth failed · 401", not "error · 400".
    expect(describeProbeState(result)).toContain("auth failed · 401");
    expect(result.errorMessage).toContain("HTTP 401");
  });

  test("400 carrying upstream_status 403 classifies as auth-failed · 403", () => {
    const body = remappedTerminalBody(403, "forbidden");
    const result = classifyHttpError(400, body, 55);
    expect(result.state).toBe("auth-failed");
    expect(result.httpStatus).toBe(403);
  });

  test("a plain 400 (no upstream_status) still classifies as generic error · 400", () => {
    // Real non-remapped producer shape: the proxy's own invalid_request_error.
    const body = JSON.stringify(wrapAnthropicError(400, "missing required field: model"));
    const result = classifyHttpError(400, body, 10);
    expect(result.state).toBe("error");
    expect(result.httpStatus).toBe(400);
    expect(describeProbeState(result)).toContain("error · 400");
  });

  test("a remapped terminal 429 (upstream_status 429) classifies as out-of-credit · 429", () => {
    // Real case: Moonshot "suspended due to insufficient balance" / Z.AI code
    // 1113 — a billing exhaustion 429 the proxy remaps to 400. Must NOT read
    // as an opaque "error · 400" (what the user saw for kimi/glm), and must
    // NOT be "rate-limited" (the TUI treats throttling as healthy).
    const body = remappedTerminalBody(429, "insufficient balance");
    const result = classifyHttpError(400, body, 10);
    expect(result.state).toBe("out-of-credit");
    expect(result.httpStatus).toBe(429);
    expect(describeProbeState(result)).toContain("out of credit · 429");
  });

  test("a direct 402 Payment Required classifies as out-of-credit · 402", () => {
    const result = classifyHttpError(
      402,
      JSON.stringify({ error: { message: "subscription expired" } }),
      9
    );
    expect(result.state).toBe("out-of-credit");
    expect(result.httpStatus).toBe(402);
    expect(result.errorMessage).toBe("subscription expired");
  });

  test("a genuine (unremapped) 429 stays rate-limited — transient throttling is healthy", () => {
    const result = classifyHttpError(429, JSON.stringify({ error: { message: "slow down" } }), 8);
    expect(result.state).toBe("rate-limited");
  });

  test("a genuine upstream 401 is unaffected", () => {
    const result = classifyHttpError(
      401,
      JSON.stringify({ error: { message: "unauthorized" } }),
      7
    );
    expect(result.state).toBe("auth-failed");
    expect(result.httpStatus).toBe(401);
  });

  test("non-JSON body on a 400 does not throw and stays generic", () => {
    const result = classifyHttpError(400, "<html>bad gateway-ish text</html>", 5);
    expect(result.state).toBe("error");
    expect(result.httpStatus).toBe(400);
  });

  test("a proxy 503 connection failure classifies as network-error", () => {
    const body = JSON.stringify({
      type: "error",
      error: {
        type: "connection_error",
        message:
          "Cannot resolve chatgpt.com for OpenAI Codex. This is a DNS/network problem on your machine — check your internet connection, VPN, or DNS resolver (e.g. Tailscale MagicDNS) — not OpenAI Codex.",
      },
    });
    const result = classifyHttpError(503, body, 1385);
    // A proxy-side connection failure is a LOCAL network problem, not an upstream server error.
    expect(result.state).toBe("network-error");
    expect(result.errorMessage).toContain("Cannot resolve chatgpt.com");
  });

  test("a genuine transient upstream 503 stays server-error", () => {
    const body = JSON.stringify({
      type: "error",
      error: {
        type: "overloaded_error",
        message: "temporary overload",
      },
    });
    const result = classifyHttpError(503, body, 42);
    expect(result.state).toBe("server-error");
    expect(result.httpStatus).toBe(503);
  });
});

describe("probe budget", () => {
  test("describeProbeState surfaces errorMessage for a code-less error (contentless 200)", () => {
    // Regression: a reasoning model that spends its whole budget before any
    // visible text returns HTTP 200 (no status) with a self-explaining
    // errorMessage. The TUI's describeProbeState dropped it → bare "error · Nms".
    const result: ProbeResult = {
      state: "error",
      latencyMs: 3340,
      errorMessage: "no visible output within probe budget (512 tokens consumed, none visible)",
    };
    const line = describeProbeState(result);
    expect(line).toContain("error · 3340ms");
    expect(line).toContain("no visible output within probe budget");
  });

  test("describeProbeState error without a message stays a bare error", () => {
    expect(describeProbeState({ state: "error", latencyMs: 10, httpStatus: 400 })).toBe(
      "error · 400 · 10ms"
    );
  });

  // Contentless-truncation E2E: a reasoning model that burns the ENTIRE probe
  // budget on hidden reasoning yields HTTP 200 + finish_reason "length" + zero
  // visible text (verified live against OpenAI gpt-5-nano). The probe must
  // report a self-explaining budget message, not "stream ended without content".
  //
  // Fixture policy: the Claude-side stream the probe consumes is produced by
  // the REAL openai-sse parser (createStreamingResponseHandler) — the actual
  // production producer. Only the upstream OpenAI chunks are synthesized,
  // mirroring the verified reproduction shape (empty content deltas,
  // finish_reason "length", usage with completion_tokens == the full cap).
  test("contentless budget-truncated 200 reports 'no visible output within probe budget'", async () => {
    const { createStreamingResponseHandler } = await import("../handlers/shared/openai-compat.js");
    const { DefaultAPIFormat } = await import("../adapters/base-api-format.js");

    // Upstream OpenAI SSE: role delta with empty content → finish "length" →
    // usage chunk consuming the whole (new) probe budget on reasoning.
    const upstreamChunks = [
      `data: {"id":"chatcmpl-probe","object":"chat.completion.chunk","created":1,"model":"gpt-5-nano","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}`,
      `data: {"id":"chatcmpl-probe","object":"chat.completion.chunk","created":1,"model":"gpt-5-nano","choices":[{"index":0,"delta":{},"finish_reason":"length"}]}`,
      `data: {"id":"chatcmpl-probe","object":"chat.completion.chunk","created":1,"model":"gpt-5-nano","choices":[],"usage":{"prompt_tokens":25,"completion_tokens":${PROBE_MAX_TOKENS},"total_tokens":${25 + PROBE_MAX_TOKENS},"completion_tokens_details":{"reasoning_tokens":${PROBE_MAX_TOKENS}}}}`,
      "data: [DONE]",
    ].join("\n\n");

    const server = Bun.serve({
      port: 0,
      fetch() {
        const upstream = new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`${upstreamChunks}\n\n`));
              controller.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        );
        // Minimal Hono-context shim (same shape format-translation.test.ts uses).
        const ctx: any = {
          body: (stream: ReadableStream, init?: any) => new Response(stream, init),
        };
        return createStreamingResponseHandler(
          ctx,
          upstream,
          new DefaultAPIFormat("gpt-5-nano"),
          "gpt-5-nano",
          null,
          undefined,
          undefined
        );
      },
    });

    try {
      const result = await probeLink(
        `http://127.0.0.1:${server.port}`,
        { provider: "openai", modelSpec: "oai@gpt-5-nano", hasCredentials: true },
        10000
      );
      expect(result.state).toBe("error");
      expect(result.errorMessage).toContain("no visible output within probe budget");
      expect(result.errorMessage).toContain(`${PROBE_MAX_TOKENS} tokens consumed`);
    } finally {
      server.stop(true);
    }
  });

  test("probe request forces minimal reasoning effort (reasoning models emit visible text)", async () => {
    // Verified live: gpt-5-nano with default effort spends the whole probe
    // budget on hidden reasoning → 0 visible text ~60% of runs. With
    // output_config.effort "minimal" it emits text deterministically (10/10).
    // The proxy maps this to reasoning_effort; here we assert the probe SENDS
    // it (the adapter mapping is covered by the api-format tests).
    let capturedBody: any = null;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        capturedBody = await req.json();
        return new Response(
          'data: {"type":"content_block_delta","delta":{"text":"one"}}\n\ndata: [DONE]\n\n',
          {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }
        );
      },
    });
    try {
      await probeLink(
        `http://127.0.0.1:${server.port}`,
        { provider: "openai", modelSpec: "oai@gpt-5-nano", hasCredentials: true },
        10000
      );
      expect(capturedBody?.output_config?.effort).toBe("minimal");
    } finally {
      server.stop(true);
    }
  });

  test("a genuinely dead contentless stream keeps the plain message", async () => {
    // No stop reason, no usage — nothing indicates budget truncation.
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("data: [DONE]\n\n", {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });
    try {
      const result = await probeLink(
        `http://127.0.0.1:${server.port}`,
        { provider: "openai", modelSpec: "oai@gpt-5-nano", hasCredentials: true },
        10000
      );
      expect(result.state).toBe("error");
      expect(result.errorMessage).toBe("stream ended without content");
    } finally {
      server.stop(true);
    }
  });
});

// Type-level pin: ProbeResult.httpStatus carries the DISPLAYED code, which for
// remapped errors is the upstream status — keep the field optional-number.
const _pin: ProbeResult = { state: "error", latencyMs: 0, httpStatus: 401 };
void _pin;
