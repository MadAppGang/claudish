/**
 * Regression: per-wire tool-count cap (S4-e lot E3, upstream 964efc61 hunk).
 *
 * OpenAI's Chat Completions API hard-caps the `tools` array at 128; exceeding it
 * fails the whole request with HTTP 400 "Invalid 'tools': array too long". Our
 * tree carried a comment claiming the cap was "enforced by the transport's
 * transformPayload() hook" — but no transport ever implemented it (grep 0 across
 * providers/transport/), so every OpenAI-shaped run with >128 tools failed
 * whole.
 *
 * DIVERGENCE FROM UPSTREAM (measured, not stylistic): upstream scopes the cap to
 * the OpenAIAPIFormat CLASS. In this tree OpenAIAPIFormat.shouldHandle matches
 * only `oai/*`, `o1` and `o3` ids — a bare `gpt-4o` bound for api.openai.com
 * resolves to DefaultAPIFormat, so the class-scoped cap would protect almost
 * none of the traffic that can actually hit the 400. The cap is therefore keyed
 * on the WIRE (openai-sse), exactly like the sibling tool-NAME limit
 * (getToolNameLimit), and the ComposedHandler passes the RESOLVED stream format
 * (transport override included) so the key is the wire the request really rides.
 * The Responses wire (Codex) stays uncapped, as upstream explicitly intends.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { ProviderTransport } from "../providers/transport/types.js";
import { OpenAIAPIFormat } from "./openai-api-format.js";
import { CodexAPIFormat } from "./codex-api-format.js";
import { GeminiAPIFormat } from "./gemini-api-format.js";
import { DefaultAPIFormat } from "./base-api-format.js";
import { ComposedHandler } from "../handlers/composed-handler.js";

describe("getMaxToolCount — per-wire tool-count cap", () => {
  test("OpenAI Chat Completions wire caps tools at 128", () => {
    expect(new OpenAIAPIFormat("gpt-4o").getMaxToolCount()).toBe(128);
  });

  test("DefaultAPIFormat (serves bare gpt-4o → api.openai.com) caps at 128 via the wire", () => {
    // The load-bearing population: upstream's class-scoped cap misses this one.
    expect(new DefaultAPIFormat("gpt-4o").getMaxToolCount()).toBe(128);
  });

  test("Codex (Responses wire) is NOT capped — upstream keeps that path uncapped", () => {
    expect(new CodexAPIFormat("gpt-5-codex").getMaxToolCount()).toBeNull();
  });

  test("other wires inherit the no-cap default (null)", () => {
    expect(new GeminiAPIFormat("gemini-2.0-flash").getMaxToolCount()).toBeNull();
  });

  test("the resolved wire argument wins over the class: Gemini served through an OpenAI-shaped gateway is capped", () => {
    expect(new GeminiAPIFormat("gemini-2.0-flash").getMaxToolCount("openai-sse")).toBe(128);
  });

  test("the resolved wire argument wins the other way: an OpenAI model on the Responses wire is not capped", () => {
    expect(new OpenAIAPIFormat("gpt-5").getMaxToolCount("openai-responses-sse")).toBeNull();
  });

  test("head-slice semantics: slicing to the cap keeps the first N tools", () => {
    // Mirrors the ComposedHandler slice: built-in tools come first and survive,
    // tail-most MCP tools are dropped.
    const cap = new OpenAIAPIFormat("gpt-4o").getMaxToolCount();
    const tools = Array.from({ length: 165 }, (_, i) => ({ name: `tool_${i}` }));
    const sliced = cap && tools.length > cap ? tools.slice(0, cap) : tools;
    expect(sliced).toHaveLength(128);
    expect(sliced[0]?.name).toBe("tool_0"); // first (built-in) preserved
    expect(sliced[127]?.name).toBe("tool_127"); // tail dropped at the cap
  });
});

// ---------------------------------------------------------------------------
// ComposedHandler head-slice — the enforcement itself, end to end. The tests
// above pin hook VALUES; these prove the slice runs at the
// convertTools→buildPayload seam, keys on the RESOLVED wire, and that the
// request is still SENT (a cap that rejected the request instead of slicing it
// would fix nothing). gpt-4o deliberately resolves to DefaultAPIFormat here —
// the composition upstream's class-scoped cap leaves unprotected.
// ---------------------------------------------------------------------------

function openaiShapedTransport(): ProviderTransport {
  return {
    name: "openai-test",
    displayName: "OpenAI Test",
    streamFormat: "openai-sse",
    getEndpoint: () => "http://upstream.test/v1/chat/completions",
    getHeaders: () => ({}),
  } as unknown as ProviderTransport;
}

const OK_BODY = JSON.stringify({
  id: "x",
  object: "chat.completion",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
});

function anthropicTools(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    name: `tool_${i}`,
    description: `test tool ${i}`,
    input_schema: { type: "object", properties: {} },
  }));
}

async function runCapped(
  toolCount: number,
  transport: ProviderTransport = openaiShapedTransport(),
  model = "gpt-4o"
): Promise<{ calls: number; sentTools: any[] | undefined; status: number }> {
  const handler = new ComposedHandler(transport, model, model, 8467, {});

  let calls = 0;
  let sentTools: any[] | undefined;
  const impl = (async (_input: any, init?: any) => {
    calls++;
    sentTools = JSON.parse(String(init?.body)).tools;
    return new Response(OK_BODY, { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const payload = {
    model,
    max_tokens: 16,
    stream: false,
    messages: [{ role: "user", content: "hi" }],
    tools: anthropicTools(toolCount),
  };

  const original = (globalThis as any).fetch;
  (globalThis as any).fetch = impl;
  try {
    const app = new Hono();
    app.post("/v1/messages", async (c: any) => handler.handle(c, payload));
    const res = await app.request("/v1/messages", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
    });
    return { calls, sentTools, status: res.status };
  } finally {
    (globalThis as any).fetch = original;
  }
}

describe("ComposedHandler — tool cap enforcement (S4-e lot E3)", () => {
  test(">128 tools → outgoing body carries exactly 128 (head-sliced) and the request is sent", async () => {
    const { calls, sentTools, status } = await runCapped(165);
    expect(status).toBe(200); // the turn completes — cap must not fail the request
    expect(calls).toBe(1); // request sent, not rejected client-side
    expect(sentTools).toHaveLength(128); // head-sliced to the API cap
    expect(sentTools?.[0]?.function?.name ?? sentTools?.[0]?.name).toBe("tool_0"); // head preserved
  });

  test("≤128 tools → nothing sliced, full set forwarded", async () => {
    const { sentTools } = await runCapped(100);
    expect(sentTools).toHaveLength(100); // under the cap → untouched
  });
});
