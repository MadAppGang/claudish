import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import type { ProviderTransport } from "../providers/transport/types.js";
import {
  ComposedHandler,
  STRIPPED_IMAGE_PLACEHOLDER,
  stripImageBlocksFromMessages,
  getRecoveryHint,
} from "./composed-handler.js";
import {
  rememberOverflowCap,
  getOverflowCap,
  resetOverflowCapsForTests,
} from "./shared/context-overflow.js";

// REGRESSION: structural weakness that allowed #102 — ComposedHandler must reject
// provider-routed strings in the modelName slot so dialect selection cannot be
// confused by provider-prefix characters. Fixed in /dev:fix session
// dev-fix-20260415-000620-e95d5090.

function makeFakeTransport(): ProviderTransport {
  return {
    name: "test-provider",
    displayName: "Test",
    streamFormat: "openai-sse",
    getEndpoint: () => "http://localhost/",
    getHeaders: () => ({}),
  } as unknown as ProviderTransport;
}

// ---------------------------------------------------------------------------
// Context-overflow interception (#79 — incident 2026-09-10/11)
//
// A pre-stream 400 "Prompt exceeds max length" (GLM 1261) used to be relayed as
// a bare error with no `usage`: the client gauge never moved, auto-compact never
// fired, and `/continue` re-sent the same prompt all night. These pin the full
// contract: recoverable 200 turn (SSE and JSON), untouched relay for every other
// error, and the learned-cap pre-flight that skips the doomed upstream call.
// ---------------------------------------------------------------------------

const GLM_1261 = JSON.stringify({ error: { code: "1261", message: "Prompt exceeds max length" } });

function overflowTransport(): ProviderTransport {
  return {
    name: "glm-coding",
    displayName: "GLM Coding",
    streamFormat: "openai-sse",
    getEndpoint: () => "http://upstream.test/v1/chat/completions",
    getHeaders: () => ({}),
  } as unknown as ProviderTransport;
}

function countingFetch(status: number, body: string) {
  let calls = 0;
  const impl = (async (_input: any, _init?: any) => {
    calls++;
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, getCalls: () => calls };
}

async function runHandle(
  payload: any,
  fetchImpl: typeof fetch
): Promise<Response> {
  const original = (globalThis as any).fetch;
  (globalThis as any).fetch = fetchImpl;
  try {
    const handler = new ComposedHandler(overflowTransport(), "glm-5.3", "glm-5.3", 8462, {});
    const app = new Hono();
    app.post("/v1/messages", async (c: any) => handler.handle(c, payload));
    return await app.request("/v1/messages", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
    });
  } finally {
    (globalThis as any).fetch = original;
  }
}

function overflowPayload(stream: boolean, sizeChars = 40_000): any {
  return {
    model: "glm-5.3",
    max_tokens: 1024,
    stream,
    messages: [{ role: "user", content: "context payload ".repeat(Math.ceil(sizeChars / 17)) }],
  };
}

describe("ComposedHandler — context-overflow interception (#79)", () => {
  beforeEach(() => resetOverflowCapsForTests());
  afterEach(() => resetOverflowCapsForTests());

  test("400 GLM 1261 + stream:true → 200 SSE recoverable turn with gauge-advancing usage", async () => {
    const fx = countingFetch(400, GLM_1261);
    const res = await runHandle(overflowPayload(true), fx.impl as typeof fetch);

    expect(res.status).toBe(200); // NOT 400 — a replayed error wedges the client
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(fx.getCalls()).toBe(1); // exactly one upstream attempt (first occurrence learns)

    const body = await res.text();
    const types = [...body.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
    expect(types[0]).toBe("message_start");
    expect(types[types.length - 1]).toBe("message_stop"); // never-hang: terminal frame present

    const delta = body
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)))
      .find((e: any) => e.type === "message_delta") as any;
    expect(delta.usage.input_tokens).toBeGreaterThanOrEqual(280_000); // crosses the compaction threshold
    expect(body).toContain("maximum prompt size");
  });

  test("same 400 + stream:false → single JSON message with usage ≥ floor", async () => {
    const fx = countingFetch(400, GLM_1261);
    const res = await runHandle(overflowPayload(false), fx.impl as typeof fetch);

    expect(res.status).toBe(200);
    const msg = (await res.json()) as any;
    expect(msg.type).toBe("message");
    expect(msg.stop_reason).toBe("end_turn");
    expect(msg.usage.input_tokens).toBeGreaterThanOrEqual(280_000);
    expect(msg.content[0].text).toContain("maximum prompt size");
  });

  test("the learned cap is recorded from the first rejection (provider + resolved model)", async () => {
    const fx = countingFetch(400, GLM_1261);
    await runHandle(overflowPayload(false), fx.impl as typeof fetch);
    expect(getOverflowCap("GLM Coding", "glm-5.3")).toBeGreaterThan(0);
  });

  test("second oversized request ≥ learned cap → NO upstream call, direct recovery", async () => {
    rememberOverflowCap("GLM Coding", "glm-5.3", 1_000); // tiny cap → any payload trips it
    const fx = countingFetch(400, GLM_1261);
    const res = await runHandle(overflowPayload(true), fx.impl as typeof fetch);

    expect(fx.getCalls()).toBe(0); // pre-flight short-circuit: the doomed round-trip is skipped
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const body = await res.text();
    expect(body).toContain("message_stop");
    expect(body).toContain("maximum prompt size");
  });

  test("request under the learned cap still reaches upstream (cap is a threshold, not a block)", async () => {
    rememberOverflowCap("GLM Coding", "glm-5.3", 10_000_000); // huge cap → nothing trips it
    const fx = countingFetch(200, "not relevant — we only assert the call happened");
    await runHandle(overflowPayload(false, 1_000), fx.impl as typeof fetch);
    expect(fx.getCalls()).toBe(1);
  });

  test("400 non-overflow is relayed unchanged as an Anthropic error envelope", async () => {
    const fx = countingFetch(400, JSON.stringify({ error: { message: "unsupported content type" } }));
    const res = await runHandle(overflowPayload(false), fx.impl as typeof fetch);
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.type).toBe("error");
    expect(body.error.message).toContain("unsupported content type");
  });

  test("401 and 404 keep their statuses (wiring mistakes must stay visible)", async () => {
    const f401 = countingFetch(401, JSON.stringify({ error: { message: "invalid api key" } }));
    const r401 = await runHandle(overflowPayload(false), f401.impl as typeof fetch);
    expect(r401.status).toBe(401);

    const f404 = countingFetch(404, JSON.stringify({ error: { message: "model not found" } }));
    const r404 = await runHandle(overflowPayload(false), f404.impl as typeof fetch);
    expect(r404.status).toBe(404);
  });
});

describe("ComposedHandler — modelName invariant (#102 structural fix)", () => {
  test("throws when modelName contains '@' (routed string leaked into bare slot)", () => {
    const transport = makeFakeTransport();
    expect(() => {
      // Passing a routed string in the modelName slot is structurally invalid —
      // the bare slot must never contain provider routing syntax.
      new ComposedHandler(transport, "zai@glm-4.7", "zai@glm-4.7", 8080, {});
    }).toThrow(/modelName.*must.*not.*contain/i);
  });

  test("accepts valid bare modelName with routed targetModel", () => {
    const transport = makeFakeTransport();
    expect(() => {
      new ComposedHandler(transport, "zai@glm-4.7", "glm-4.7", 8080, {});
    }).not.toThrow();
  });

  test("accepts bare modelName when targetModel is also bare (no provider prefix)", () => {
    const transport = makeFakeTransport();
    expect(() => {
      new ComposedHandler(transport, "glm-4.7", "glm-4.7", 8080, {});
    }).not.toThrow();
  });

  test("accepts vendor-prefixed modelName (slash separator is legitimate)", () => {
    const transport = makeFakeTransport();
    expect(() => {
      new ComposedHandler(transport, "openrouter@x-ai/grok-beta", "x-ai/grok-beta", 8080, {});
    }).not.toThrow();
  });
});

// REGRESSION (2026-08-14, po-2025:CoursIA PDF read): when a non-vision model
// (glm-5.3 absent from the catalog → supportsVision=false) received a user
// message of [tool_result, image×N] with no text block, stripping the images
// left {"role":"user","content":""} — Z.AI rejected it with HTTP 400 code 1213
// "The prompt parameter was not received normally" (deterministic, 4/4 repro),
// and the client retried into the same wall. The placeholder keeps the
// message non-empty so the request can never hit that 400 again.
describe("stripImageBlocksFromMessages — empty-content regression", () => {
  test("images-only message becomes the placeholder, not empty string", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAA" } },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,BBB" } },
        ],
      },
    ];
    stripImageBlocksFromMessages(messages, ["image_url", "image", "document"]);
    expect(messages[0].content).toBe(STRIPPED_IMAGE_PLACEHOLDER);
    expect((messages[0].content as string).length).toBeGreaterThan(0);
  });

  test("single remaining text block collapses to a plain string", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          { type: "image", source: {} },
        ],
      },
    ];
    stripImageBlocksFromMessages(messages, ["image_url", "image", "document"]);
    expect(messages[0].content).toBe("hello");
  });

  test("text + multiple text blocks stay an array", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
          { type: "document", source: {} },
        ],
      },
    ];
    stripImageBlocksFromMessages(messages, ["document"]);
    expect(messages[0].content).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]);
  });

  test("PDF-read shape (tool result already extracted, images-only user msg) never yields empty content", () => {
    // Shape seen in the wild: conversion turns [tool_result, image×5] into a
    // role:tool message plus a user message holding only image_url parts.
    const messages = [
      { role: "tool", content: "PDF pages extracted: 5 page(s)", tool_call_id: "tu1" },
      {
        role: "user",
        content: Array.from({ length: 5 }, () => ({
          type: "image_url",
          image_url: { url: "data:image/jpeg;base64,XXX" },
        })),
      },
    ];
    stripImageBlocksFromMessages(messages, ["image_url", "image", "document"]);
    expect(messages[1].content).toBe(STRIPPED_IMAGE_PLACEHOLDER);
    // The tool message is untouched.
    expect(messages[0].content).toBe("PDF pages extracted: 5 page(s)");
  });

  test("non-array (plain string) content passes through unchanged", () => {
    const messages = [{ role: "user", content: "plain text" }];
    stripImageBlocksFromMessages(messages, ["image_url"]);
    expect(messages[0].content).toBe("plain text");
  });
});

describe("getRecoveryHint — a quota 403 is not an auth fault", () => {
  // Verbatim Kimi Coding 5-hour wall (2026-09-15). The client renders this 403
  // as "Failed to authenticate" and the old hint said "Check API key / OAuth
  // credentials" — a wall misread as a wiring fault, which is exactly the
  // diagnosis detour this assertion closes.
  const KIMI_5H_WALL =
    '{"error":{"type":"invalid_request_error","message":"You\'ve reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends. To continue now, purchase extra usage or upgrade your plan"}}';

  test("names the wall instead of sending the reader after a key", () => {
    const hint = getRecoveryHint(403, KIMI_5H_WALL, "Kimi Coding");
    expect(hint).toMatch(/quota/i);
    expect(hint).not.toMatch(/API key/i);
  });

  test("a genuine auth 403 keeps the credential hint", () => {
    const hint = getRecoveryHint(403, '{"error":{"message":"Invalid API key provided"}}', "Kimi");
    expect(hint).toMatch(/API key/i);
  });

  test("401 for an unsupported model still reads as a model problem", () => {
    const hint = getRecoveryHint(401, '{"error":"unsupported model"}', "Zen");
    expect(hint).toMatch(/model not supported/i);
  });
});
