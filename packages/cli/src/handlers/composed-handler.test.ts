import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import type { ProviderTransport } from "../providers/transport/types.js";
import {
  ComposedHandler,
  STRIPPED_IMAGE_PLACEHOLDER,
  stripImageBlocksFromMessages,
  strippedMediaNotice,
  getRecoveryHint,
} from "./composed-handler.js";
import {
  rememberOverflowCap,
  getOverflowCap,
  resetOverflowCapsForTests,
  estimatePayloadTokens,
  estimateClampTokens,
  getStatedContextLimit,
} from "./shared/context-overflow.js";
import { isQuotaExhaustion } from "../fork/failover.js";

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

/**
 * An anthropic-format transport, so the request the handler estimates is the one
 * the client sent. The OpenAI adapter rewrites an image block on the way in
 * (dropping its base64), which hides the estimator from any pin that feeds the
 * test's payload — measured 24/10: swapping the media-aware estimator for the /4
 * one left the media pin GREEN until this transport existed.
 */
function mediaTransport(): ProviderTransport {
  return {
    name: "test-anthropic",
    displayName: "Test Anthropic",
    streamFormat: "anthropic-sse",
    getEndpoint: () => "http://upstream.test/v1/messages",
    getHeaders: () => ({}),
  } as unknown as ProviderTransport;
}

async function runHandleWith(
  transport: ProviderTransport,
  model: string,
  payload: any,
  fetchImpl: typeof fetch,
  options: Record<string, unknown> = {},
  inboundHeaders: Record<string, string> = {}
): Promise<Response> {
  const original = (globalThis as any).fetch;
  (globalThis as any).fetch = fetchImpl;
  try {
    const handler = new ComposedHandler(transport, model, model, 8462, options);
    const app = new Hono();
    app.post("/v1/messages", async (c: any) => handler.handle(c, payload));
    return await app.request("/v1/messages", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json", ...inboundHeaders },
    });
  } finally {
    (globalThis as any).fetch = original;
  }
}

async function runHandle(
  payload: any,
  fetchImpl: typeof fetch,
  options: Record<string, unknown> = {}
): Promise<Response> {
  return runHandleWith(overflowTransport(), "glm-5.3", payload, fetchImpl, options);
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

// ---------------------------------------------------------------------------
// #651 — a MEASURED window pre-seeds the cap.
//
// The learned cap above lives in one process's memory: a recreate forgets it,
// and the band between the engine's real window and the reported floor stayed
// open until a refusal re-taught it (measured 24/10: 229 645 learned, lost at
// the recreate, and a `400 "Input too large"` 52 min later taught nothing back,
// because the engine's plain 400 is not the shape that re-learns).
//
// A cap equal to the real window needs no learning. These pins hold the
// three properties that make the pre-seed safe: it is a THRESHOLD (not a
// block), it is ABSENT when no window is declared (inert by default), and it
// uses the MEDIA-AWARE estimator — the /4 payload estimator would score a 1 MB
// screenshot at ~350k and refuse a vision request the engine serves in ~1.6k
// tokens, on every small-window lane.
// ---------------------------------------------------------------------------

describe("ComposedHandler — a MEASURED window pre-seeds the cap (#651)", () => {
  beforeEach(() => resetOverflowCapsForTests());
  afterEach(() => resetOverflowCapsForTests());

  test("a request at/past the measured window short-circuits with NO upstream call", async () => {
    expect(getOverflowCap("GLM Coding", "glm-5.3")).toBeUndefined(); // nothing learned yet
    const fx = countingFetch(200, "should never be reached");
    const res = await runHandle(overflowPayload(true, 40_000), fx.impl as typeof fetch, {
      derivedContextLimit: 5_000,
    });

    expect(fx.getCalls()).toBe(0); // the doomed round-trip is skipped
    expect(res.status).toBe(200); // recoverable turn, never a bare 400
    const body = await res.text();
    expect(body).toContain("message_stop");
    expect(body).toContain("maximum prompt size");
    // The #431 marker (`context; est=… cap=5000`) is asserted on the live route
    // instead — K30 in proxy-server-step-skip-route.test.ts. `app.request` hands
    // back a rebuilt Response whose marker is gone once a node:http server has
    // lived in the process (measured 24/10; same class as #604), so a header pin
    // here would be red in a full run and green alone — an instrument that lies.
  });

  test("under the measured window the request still reaches upstream (a threshold, not a block)", async () => {
    const fx = countingFetch(200, "not relevant — we only assert the call happened");
    await runHandle(overflowPayload(false, 1_000), fx.impl as typeof fetch, {
      derivedContextLimit: 10_000_000,
    });
    expect(fx.getCalls()).toBe(1);
  });

  test("ABSENT contextLimit changes nothing — no pre-seed at all (inert-by-default pin)", async () => {
    const fx = countingFetch(200, "not relevant");
    await runHandle(overflowPayload(false, 40_000), fx.impl as typeof fetch, {});
    expect(fx.getCalls()).toBe(1);
  });

  test("a HAND-TYPED contextLimit alone does NOT pre-seed — only a measured one does", async () => {
    // The discriminator between the two knobs. A declared literal may be stale
    // in either direction; refusing on it locally would turn "the operator typed
    // 4k years ago" into a refusal of requests the engine serves. Today's path
    // (clamp + the upstream's own word) stays exactly as it was.
    const fx = countingFetch(200, "not relevant");
    await runHandle(overflowPayload(false, 40_000), fx.impl as typeof fetch, {
      contextLimit: 5_000, // typed, never measured
    });
    expect(fx.getCalls()).toBe(1);
  });

  test("MEDIA-AWARE: a 1.4 MB base64 image on a 32k lane is NOT refused", async () => {
    const image = "A".repeat(1_400_000);
    const payload: any = {
      model: "glm-5.3",
      max_tokens: 512,
      stream: false,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe this screenshot" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: image } },
          ],
        },
      ],
    };
    // The discriminating fact: the /4 payload estimator scores this far above
    // the window, the clamp estimator charges one fixed media block.
    expect(estimatePayloadTokens(payload)).toBeGreaterThan(300_000);
    expect(estimateClampTokens(payload)).toBeLessThan(32_768);

    const fx = countingFetch(200, "not relevant");
    // An anthropic-format transport: the base64 the client sent must reach the
    // handler's estimate byte for byte, or this pin proves nothing (see
    // mediaTransport).
    await runHandleWith(mediaTransport(), "claude-3-5-sonnet", payload, fx.impl as typeof fetch, {
      derivedContextLimit: 32_768,
    });
    // Not the count that matters (a transient-empty answer can be retried):
    // the contract is that the pre-seed did NOT trip. With the /4 estimator it
    // would have been 0 — the false refusal this pin exists for.
    expect(fx.getCalls()).toBeGreaterThanOrEqual(1);
  });

  test("a window ABOVE the estimate no longer lets the cap refuse alone (#674 corroboration)", async () => {
    // The 25/10 measurement inverted this test's premise: `est >= cap` fires
    // on prompts the engine serves (21 served bodies at est >= 230k, real
    // 209k-262k, same day). With a KNOWN window above the estimate, the
    // short-circuit must stand down and let the upstream answer — its 400
    // returns the same recoverable turn one round-trip later; its 200 is a
    // turn the old gate threw away.
    rememberOverflowCap("GLM Coding", "glm-5.3", 1_000);
    const fx = countingFetch(200, "not relevant");
    const res = await runHandle(overflowPayload(true, 40_000), fx.impl as typeof fetch, {
      derivedContextLimit: 10_000_000, // a huge measured window: nothing here is over it
    });
    expect(fx.getCalls()).toBe(1); // upstream called — no refusal on the estimate alone
    expect(res.headers.get("x-claudish-step-skip") ?? "").not.toContain("cap=1000");
  });

  test("the cap still fires when the window corroborates (both estimators agree it is over)", async () => {
    // The other half of the #674 contract: corroboration is not disarmament.
    // Here the measured window sits BELOW the request's estimate, so the two
    // pieces of evidence agree — zero round-trips, exactly the old behavior.
    // Units stay separate: the trigger is payload units (est >= cap), the
    // window is judged in clamp units (this payload is text-only, so both
    // estimators score it at ~10k).
    rememberOverflowCap("GLM Coding", "glm-5.3", 1_000);
    const fx = countingFetch(200, "not relevant");
    const res = await runHandle(overflowPayload(true, 40_000), fx.impl as typeof fetch, {
      derivedContextLimit: 500, // measured, and far below this request
    });
    expect(fx.getCalls()).toBe(0);
    expect(res.headers.get("x-claudish-step-skip") ?? "").toContain("cap=1000");
  });

  // #674 — the window does not have to be configured or probed: a refusal that
  // STATES its own limit ("maximum context length is N") teaches it on the same
  // record as the cap, with no declared/derived window anywhere in options.
  test("a window STATED by a refusal arms the corroboration end-to-end", async () => {
    // r1: the 400 states used=3000, limit=262144 — cap and stated window learned.
    const fx400 = countingFetch(
      400,
      JSON.stringify({
        error: {
          message:
            "This model's maximum context length is 262144 tokens. However, your prompt contains at least 3000 input tokens, which exceeds this limit even without any output tokens. (parameter=input_tokens, value=3000)",
          type: "BadRequestError",
          param: "input_tokens",
          code: 400,
        },
      })
    );
    await runHandle(overflowPayload(false, 40_000), fx400.impl as typeof fetch);
    expect(getStatedContextLimit("GLM Coding", "glm-5.3")).toBe(262144);

    // r2: est (~20k) >= cap (~10k) but clamp-est ~20k < the STATED window
    // 262144 → not corroborated → upstream called, no refusal on the estimate.
    const fx2 = countingFetch(200, "served");
    await runHandle(overflowPayload(false, 80_000), fx2.impl as typeof fetch, {});
    expect(fx2.getCalls()).toBe(1);
  });

  test("the stated window corroborates when the request really is over it", async () => {
    // Mirror: same learning, but the stated window (5000) sits BELOW r2's
    // clamp estimate (~20k) — both pieces of evidence agree → zero round-trips.
    const fx400 = countingFetch(
      400,
      JSON.stringify({
        error: {
          message:
            "This model's maximum context length is 5000 tokens. However, your prompt contains at least 6000 input tokens, which exceeds this limit even without any output tokens. (parameter=input_tokens, value=6000)",
          type: "BadRequestError",
          param: "input_tokens",
          code: 400,
        },
      })
    );
    await runHandle(overflowPayload(false, 40_000), fx400.impl as typeof fetch);
    expect(getStatedContextLimit("GLM Coding", "glm-5.3")).toBe(5000);

    const fx2 = countingFetch(200, "served");
    await runHandle(overflowPayload(false, 80_000), fx2.impl as typeof fetch, {});
    expect(fx2.getCalls()).toBe(0);
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

  test("single remaining text block with NOTHING stripped still collapses to a plain string", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ];
    stripImageBlocksFromMessages(messages, ["image_url", "image", "document"]);
    expect(messages[0].content).toBe("hello");
  });

  test("#222 mixed [text, image] keeps the text AND announces the removal — never silent", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "What color is this image?" },
          { type: "image", source: { type: "base64" } },
        ],
      },
    ];
    stripImageBlocksFromMessages(messages, ["image_url", "image", "document"]);
    expect(messages[0].content).toEqual([
      { type: "text", text: "What color is this image?" },
      { type: "text", text: strippedMediaNotice(1) },
    ]);
  });

  test("#222 multiple stripped parts produce ONE notice carrying the count", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "a" },
          { type: "image", source: {} },
          { type: "image", source: {} },
          { type: "document", source: {} },
        ],
      },
    ];
    stripImageBlocksFromMessages(messages, ["image", "document"]);
    expect(messages[0].content).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: strippedMediaNotice(3) },
    ]);
  });

  test("text + multiple text blocks stay an array, with the removal announced (#222)", () => {
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
      { type: "text", text: strippedMediaNotice(1) },
    ]);
  });

  test("#222 both removal texts name the proxy's decision and carry no instruction", () => {
    // The strip decision is the catalog's supportsVision flag, which #222 measured
    // wrong for a vision model — so the text must not assert it as a model fact,
    // and must not tell the agent what to do (doctrine 2026-08-23).
    for (const text of [STRIPPED_IMAGE_PLACEHOLDER, strippedMediaNotice(1), strippedMediaNotice(3)]) {
      expect(text).toContain("removed by the proxy");
      expect(text).toContain("not flagged as accepting image input");
      expect(text).not.toContain("does not support");
      expect(text).not.toMatch(/\bask\b|\bplease\b|\buse a\b/i);
    }
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

// ---------------------------------------------------------------------------
// getRecoveryHint — fa09cb7e port: name an unsupported model, not the payload
//
// Upstream measured (2026-09-17, Alibaba): the Token Plan and PAYG hosts answer
// an id their silo does not serve with a bare `400 Model not exist` — matched
// none of the phrases, so the only hint was "Request format may be incompatible
// with provider", sending the reader to audit a payload that is fine. The same
// wording can also surface under 401/403 (the OpenCode Zen shape), so the
// phrases that NAME a model are shared by both branches. The bare
// "not supported" is 401/403-only (review of #455, B1): on a 400 it most often
// faults a parameter or a content type, and keying the model hint on it
// regressed measured bodies that main classified correctly.
// ---------------------------------------------------------------------------
describe("getRecoveryHint — fa09cb7e port: an unsupported model is a model problem", () => {
  test("bare 400 `Model not exist` gets the model hint, not the format hint", () => {
    const hint = getRecoveryHint(400, "Model not exist", "Qwen Token Plan");
    expect(hint).toBe("Model not supported by this provider. Verify model name.");
    expect(hint).not.toMatch(/format/i);
  });

  test("the same body in an error envelope behaves identically", () => {
    const hint = getRecoveryHint(
      400,
      '{"error":{"code":"InvalidParameter","message":"Model not exist"}}',
      "Qwen Token Plan"
    );
    expect(hint).toBe("Model not supported by this provider. Verify model name.");
  });

  test("a model-unsupported 401 is recognized as well (shared predicate)", () => {
    const hint = getRecoveryHint(401, "Model not exist", "Qwen Token Plan");
    expect(hint).toBe("Model not supported by this provider. Verify model name.");
  });

  test("the model check runs BEFORE the size test — a body spelling 'tokens' is not input-too-large", () => {
    // The size test is a bare includes("token"); without the ordering a
    // model-unsupported body that happens to spell "tokens" is claimed as
    // "Input too large" and buries the real cause. The body must NAME the
    // model (review of #455, B1): a bare "not supported for token streaming"
    // no longer keys the hint on 400.
    const hint = getRecoveryHint(
      400,
      "Model not found: glm-9.5 does not take part in token streaming",
      "Qwen Token Plan"
    );
    expect(hint).toBe("Model not supported by this provider. Verify model name.");
  });

  test("B1: a 400 'not supported' faulting a parameter or content keeps the format hint", () => {
    // Measured regressions of the shared list (review of #455): on a 400 the
    // bare phrase most often names a parameter or a content type, and keying
    // the model hint on it sent the operator to audit a model id that was
    // fine. Bodies verbatim.
    expect(getRecoveryHint(400, "Image input is not supported for this model", "OpenAI")).toBe(
      "Request format may be incompatible with provider."
    );
    expect(getRecoveryHint(400, "stream_options is not supported", "OpenAI")).toBe(
      "Request format may be incompatible with provider."
    );
  });

  test("B1: OpenAI's max_tokens body never says 'Verify model name'", () => {
    // Verbatim OpenAI 400. It falls through to "Input too large" (as on main,
    // already imperfect); a future parameter-specific hint may replace that —
    // out of scope here. The pin only requires it never points at the model id.
    const hint = getRecoveryHint(
      400,
      "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
      "OpenAI"
    );
    expect(hint).not.toMatch(/verify model name/i);
  });

  test("B1 branch split: bare 'not supported' arms the model hint on 401, not on 400", () => {
    // On an auth-status answer the bare wording almost always names the model
    // (OpenCode Zen); on a 400 it must fall through. Same body, two statuses,
    // two hints — the split IS the fix.
    const body = "This model is not supported";
    expect(getRecoveryHint(401, body, "Zen")).toBe(
      "Model not supported by this provider. Verify model name."
    );
    expect(getRecoveryHint(400, body, "Zen")).toBe(
      "Request format may be incompatible with provider."
    );
  });

  test("the model hint never arms the quota classifier — a model fault must not exile a role", () => {
    // isQuotaExhaustion keys role failover on 403 bodies naming quota walls; a
    // model-unsupported 403 (and the hint's own wording, should it ever be
    // quoted back in a body) must stay out of it. The cascade's job on a model
    // fault is handled elsewhere (step-skip / wiring), never by the wall arm.
    expect(isQuotaExhaustion(403, "Model not exist")).toBe(false);
    expect(isQuotaExhaustion(400, "Model not exist")).toBe(false);
    expect(
      isQuotaExhaustion(
        403,
        '{"error":{"message":"Model not supported by this provider. Verify model name."}}'
      )
    ).toBe(false);
    // Control: a real quota wall still arms — the port did not touch it. The
    // verbatim Kimi 5-hour body (proven arming by the describe above), never a
    // paraphrase: an invented "quota" sentence that fails to match the real
    // phrase list is a broken control that says nothing.
    const VERBATIM_KIMI_WALL =
      '{"error":{"type":"invalid_request_error","message":"You\'ve reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends. To continue now, purchase extra usage or upgrade your plan"}}';
    expect(isQuotaExhaustion(403, VERBATIM_KIMI_WALL)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Provider context-window guard (S4-e lot E2, upstream c9e97c9c hunk)
//
// A transport returning 0 from getContextWindow() means "I have no opinion" —
// our OpenRouterProviderTransport does exactly that (openrouter.ts:62 returns a
// literal 0). Applying it unconditionally overwrote the window the model
// dialect had already resolved, so every OpenRouter-routed model reported
// "context_window: unknown" and lost its context field in the status line.
// 0 must be a no-op, not a reset; a positive window is still applied.
// ---------------------------------------------------------------------------

describe("ComposedHandler — provider context-window guard (S4-e lot E2)", () => {
  function transportWithWindow(getContextWindow: () => number): ProviderTransport {
    return {
      name: "windowed",
      displayName: "Windowed",
      streamFormat: "openai-sse",
      getEndpoint: () => "http://upstream.test/v1/chat/completions",
      getHeaders: () => ({}),
      getContextWindow,
    } as unknown as ProviderTransport;
  }

  const okBody = JSON.stringify({
    id: "x",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
  });

  async function runWindowed(getContextWindow: () => number): Promise<number[]> {
    const handler = new ComposedHandler(
      transportWithWindow(getContextWindow),
      "fugu-ultra",
      "fugu-ultra",
      8466,
      {}
    );
    const tracker = handler.getTokenTracker() as unknown as {
      setContextWindow: (n: number) => void;
    };
    const applied: number[] = [];
    tracker.setContextWindow = (n: number) => applied.push(n);

    const original = (globalThis as any).fetch;
    (globalThis as any).fetch = countingFetch(200, okBody).impl;
    try {
      const app = new Hono();
      const payload = { model: "fugu-ultra", max_tokens: 16, messages: [{ role: "user", content: "hi" }] };
      app.post("/v1/messages", async (c: any) => handler.handle(c, payload));
      await app.request("/v1/messages", {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "content-type": "application/json" },
      });
    } finally {
      (globalThis as any).fetch = original;
    }
    return applied;
  }

  test("a transport answering 0 (\"no opinion\") does not reset the dialect-resolved window", async () => {
    const applied = await runWindowed(() => 0);
    expect(applied).toEqual([]); // 0 must be a no-op, not a reset
  });

  test("a positive transport window is still applied", async () => {
    const applied = await runWindowed(() => 131072);
    expect(applied).toEqual([131072]);
  });
});

// ---------------------------------------------------------------------------
// message_start seed is per-session (#518)
//
// Handlers are cached per TARGET MODEL while the hub serves many sessions, and
// the seed used to be read from the handler's TokenTracker — the last turn of
// ANY session on that model. Measured on the hub 18/10: a fresh 233-token
// single-turn request was announced at input_tokens=166322 (another tenant's
// context size). Claude Code keeps the seed whenever the delta does not report
// a positive count, so a foreign seed both mis-sizes the conversation (spurious
// auto-compaction, or compaction disarmed at the cap) and discloses another
// tenant's size. The seed must be keyed by session (extractSessionKey, the #91
// dwell seam); an unknown session falls back to the first-turn constant,
// never to a foreign session's count.
// ---------------------------------------------------------------------------

describe("ComposedHandler — message_start seed is per-session (#518)", () => {
  // Minimal openai-sse stream: one content delta, one final usage frame, DONE.
  function usageSse(promptTokens: number): string {
    const chunks = [
      {
        id: "c1",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
      },
      {
        id: "c1",
        object: "chat.completion.chunk",
        choices: [],
        usage: { prompt_tokens: promptTokens, completion_tokens: 5, total_tokens: promptTokens + 5 },
      },
    ];
    return [...chunks.map((c) => `data: ${JSON.stringify(c)}`), "data: [DONE]", ""].join("\n\n");
  }

  function sessionPayload(userId?: string): any {
    return {
      model: "glm-5.3",
      max_tokens: 1024,
      stream: true,
      ...(userId ? { metadata: { user_id: userId } } : {}),
      messages: [{ role: "user", content: "hello" }],
    };
  }

  async function messageStartInput(res: Response): Promise<number> {
    const body = await res.text();
    const start = body
      .split("\n")
      .filter((l) => l.startsWith("data: ") && !l.startsWith("data: [DONE]"))
      .map((l) => JSON.parse(l.slice(6)))
      .find((e: any) => e.type === "message_start") as any;
    return start.message.usage.input_tokens;
  }

  test("session B's seed is the first-turn fallback, not session A's context", async () => {
    const script = [usageSse(166_322), usageSse(233), usageSse(166_322), usageSse(999)];
    let i = 0;
    const original = (globalThis as any).fetch;
    (globalThis as any).fetch = (async () =>
      new Response(script[i++], {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as typeof fetch;
    try {
      // ONE handler for every request: that is the production shape (handlers
      // cached per model) and the precondition of the leak.
      const handler = new ComposedHandler(overflowTransport(), "glm-5.3", "glm-5.3", 8468, {});
      const app = new Hono();
      app.post("/v1/messages", async (c: any) => handler.handle(c, JSON.parse(await c.req.text())));
      const post = (p: any) =>
        app.request("/v1/messages", {
          method: "POST",
          body: JSON.stringify(p),
          headers: { "content-type": "application/json" },
        });

      // A turn 1 — first turn on this handler: fallback constant either way.
      expect(await messageStartInput(await post(sessionPayload("session-a")))).toBe(100);
      // B turn 1 — same model, DIFFERENT session: must NOT inherit A's 166322.
      expect(await messageStartInput(await post(sessionPayload("session-b")))).toBe(100);
      // A turn 2 — same-session continuity is the reason the seed exists (S4-b).
      expect(await messageStartInput(await post(sessionPayload("session-a")))).toBe(166_322);
      // No session key at all — unknown session, still never a foreign count.
      expect(await messageStartInput(await post(sessionPayload()))).toBe(100);
    } finally {
      (globalThis as any).fetch = original;
    }
  });
});

describe("#518 seed map guards (coordinator probe)", () => {
  function sse(promptTokens: number): string {
    const chunks = [
      { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
      { id: "c1", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 5, total_tokens: promptTokens + 5 } },
    ];
    return [...chunks.map((c) => `data: ${JSON.stringify(c)}`), "data: [DONE]", ""].join("\n\n");
  }
  async function seedOf(res: Response): Promise<number> {
    const start = (await res.text()).split("\n").filter((l) => l.startsWith("data: ") && !l.startsWith("data: [DONE]"))
      .map((l) => JSON.parse(l.slice(6))).find((e: any) => e.type === "message_start") as any;
    return start.message.usage.input_tokens;
  }
  function harness(next: () => string) {
    const original = (globalThis as any).fetch;
    (globalThis as any).fetch = (async () => new Response(next(), { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    const handler = new ComposedHandler(overflowTransport(), "glm-5.3", "glm-5.3", 8468, {});
    const app = new Hono();
    app.post("/v1/messages", async (c: any) => handler.handle(c, JSON.parse(await c.req.text())));
    const post = (sid: string) => app.request("/v1/messages", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-5.3", max_tokens: 1024, stream: true, metadata: { user_id: sid }, messages: [{ role: "user", content: "hi" }] }) });
    return { post, restore: () => { (globalThis as any).fetch = original; } };
  }

  test("a zero prompt_tokens report does not erase the session's seed", async () => {
    const script = [sse(166_322), sse(0), sse(1)];
    let i = 0;
    const h = harness(() => script[i++]);
    try {
      await seedOf(await h.post("a"));
      await seedOf(await h.post("a"));
      expect(await seedOf(await h.post("a"))).toBe(166_322);
    } finally { h.restore(); }
  });

  test("an active session survives 256 newer ones; the stalest is evicted", async () => {
    const h = harness(() => sse(5_000));
    try {
      await seedOf(await h.post("a"));                                   // a recorded first (oldest)
      for (let k = 1; k <= 255; k++) await seedOf(await h.post(`s${k}`)); // map full: a, s1..s255
      expect(await seedOf(await h.post("a"))).toBe(5_000);               // a refreshed -> newest
      await seedOf(await h.post("s256"));                                 // 257th -> evicts s1, not a
      expect(await seedOf(await h.post("a"))).toBe(5_000);
      expect(await seedOf(await h.post("s1"))).toBe(100);
    } finally { h.restore(); }
  });
});

// ---------------------------------------------------------------------------
// #518 stats volet — recordStats must report THIS stream's token counts.
//
// The handler is per-model and shared by every session hitting that model; the
// tracker underneath is handler-wide. Under "accumulate-both" it accumulates
// input across streams (under "standard" it still accumulates OUTPUT and cost),
// so reading the tracker from onStreamComplete attributes session A's context
// to session B's stats line — the same class of cross-session bleed #518 fixed
// for the message_start seed. The pin: two sessions, one handler, B's recorded
// line must carry B's own input and output, never the accumulated totals.
// ---------------------------------------------------------------------------

describe("#518 stats volet — recordStats records this stream's tokens, not the tracker", () => {
  function sse(promptTokens: number, completionTokens: number): string {
    const chunks = [
      { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
      { id: "c1", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens } },
    ];
    return [...chunks.map((c) => `data: ${JSON.stringify(c)}`), "data: [DONE]", ""].join("\n\n");
  }

  test("two sessions on one handler: B's stats line carries B's own input and output", async () => {
    const { existsSync, readFileSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    const { initStats, resetStatsForTests } = await import("../stats.js");
    const { readBuffer, clearBuffer, appendEvent } = await import("../stats-buffer.js");

    // Arm the stats module against a scratch config (stats are opt-in; the real
    // ~/.claudish/config.json is backed up and restored, stats-buffer precedent).
    const configPath = join(homedir(), ".claudish", "config.json");
    mkdirSync(join(homedir(), ".claudish"), { recursive: true });
    const hadConfig = existsSync(configPath);
    const prevConfig = hadConfig ? readFileSync(configPath, "utf-8") : null;
    const prevStatsEnv = process.env.CLAUDISH_STATS;
    delete process.env.CLAUDISH_STATS;
    writeFileSync(configPath, JSON.stringify({
      version: "1.0.0", defaultProfile: "default", profiles: {}, stats: { enabled: true },
    }), "utf-8");
    const bufferBefore = readBuffer();

    const original = (globalThis as any).fetch;
    const script = [sse(100, 5), sse(50, 7)];
    let i = 0;
    (globalThis as any).fetch = (async () =>
      new Response(script[i++], { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
    try {
      resetStatsForTests(); // stats.test.ts may have latched initialized with the real config
      initStats({ interactive: false } as any);
      // One handler, one model — the shared-per-model shape the hub runs.
      const handler = new ComposedHandler(overflowTransport(), "glm-5.3", "glm-5.3", 8471, { tokenStrategy: "accumulate-both" });
      const app = new Hono();
      app.post("/v1/messages", async (c: any) => handler.handle(c, JSON.parse(await c.req.text())));
      const post = (sid: string) => app.request("/v1/messages", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-5.3", max_tokens: 1024, stream: true, metadata: { user_id: sid }, messages: [{ role: "user", content: "hi" }] }) });

      await (await post("a")).text(); // session A: 100 in / 5 out
      await (await post("b")).text(); // session B: 50 in / 7 out

      const mine = readBuffer().slice(bufferBefore.length);
      expect(mine.length).toBe(2);
      const b = mine[1];
      expect(b.input_tokens).toBe(50); // tracker would say 100+50=150
      expect(b.output_tokens).toBe(7); // tracker would say 5+7=12
    } finally {
      (globalThis as any).fetch = original;
      if (prevStatsEnv === undefined) delete process.env.CLAUDISH_STATS; else process.env.CLAUDISH_STATS = prevStatsEnv;
      // Restore the real config, then put the user's buffered events back (the
      // two test events were flushed toward disk by appendEvent's setImmediate).
      if (hadConfig) writeFileSync(configPath, prevConfig!, "utf-8");
      else { try { require("node:fs").unlinkSync(configPath); } catch { /* ignore */ } }
      clearBuffer();
      for (const e of bufferBefore) appendEvent(e);
      resetStatsForTests(); // leave the module inert — later tests must not record into the real buffer
    }
  });
});

// ---------------------------------------------------------------------------
// #686 — client attribution on the outbound wire (dispatch-level pins).
//
// The unit pins in client-attribution.test.ts hold the composition rules;
// these hold that the handler actually merges the result into the headers it
// FETCHES with, gated on the endpoint opt-in and the global kill switch. The
// fetch stub captures init.headers (the same plain object composed-handler
// passes to fetch), so assertions read the true outbound set.
// ---------------------------------------------------------------------------

describe("#686 — client attribution rides the outbound headers", () => {
  const openaiJsonBody = JSON.stringify({
    id: "c1",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });

  function attributingTransport(clientAttribution: boolean): ProviderTransport {
    return { ...overflowTransport(), clientAttribution } as unknown as ProviderTransport;
  }

  /** Records every init.headers the handler fetches with (plain object). */
  function headerRecordingFetch(status: number, body: string) {
    const captured: Array<Record<string, string>> = [];
    const impl = (async (_input: any, init?: any) => {
      captured.push(init?.headers ?? {});
      return new Response(body, { status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return { impl, captured };
  }

  const smallPayload = (stream: boolean) => ({
    model: "glm-5.3",
    max_tokens: 64,
    stream,
    messages: [{ role: "user", content: "hi" }],
  });

  test("opted-in endpoint: composed value + machine verbatim on the outbound set", async () => {
    const rec = headerRecordingFetch(200, openaiJsonBody);
    await runHandleWith(
      attributingTransport(true),
      "glm-5.3",
      smallPayload(false),
      rec.impl,
      {},
      { "x-claudish-machine": "myia-po-2025", "x-claudish-workspace": "claudish" }
    );
    expect(rec.captured.length).toBe(1);
    expect(rec.captured[0]["x-claudish-client"]).toBe("myia-po-2025:claudish");
    expect(rec.captured[0]["x-claudish-machine"]).toBe("myia-po-2025");
    // the merge must not clobber the standard outbound set
    expect(rec.captured[0]["Content-Type"]).toBe("application/json");
  });

  test("machine only: workspace reads `unknown` — never an absent header", async () => {
    const rec = headerRecordingFetch(200, openaiJsonBody);
    await runHandleWith(
      attributingTransport(true),
      "glm-5.3",
      smallPayload(false),
      rec.impl,
      {},
      { "x-claudish-machine": "myia-po-2024" }
    );
    expect(rec.captured[0]["x-claudish-client"]).toBe("myia-po-2024:unknown");
  });

  test("neither part sent: `unknown:unknown`, still present — 'not attributable' is sayable", async () => {
    const rec = headerRecordingFetch(200, openaiJsonBody);
    await runHandleWith(attributingTransport(true), "glm-5.3", smallPayload(false), rec.impl);
    expect(rec.captured[0]["x-claudish-client"]).toBe("unknown:unknown");
    expect(rec.captured[0]["x-claudish-machine"]).toBeUndefined(); // never fabricated
  });

  test("endpoint that did NOT opt in: no attribution headers leave the box", async () => {
    const rec = headerRecordingFetch(200, openaiJsonBody);
    await runHandleWith(
      attributingTransport(false),
      "glm-5.3",
      smallPayload(false),
      rec.impl,
      {},
      { "x-claudish-machine": "myia-po-2025", "x-claudish-workspace": "claudish" }
    );
    expect(rec.captured[0]["x-claudish-client"]).toBeUndefined();
    expect(rec.captured[0]["x-claudish-machine"]).toBeUndefined();
  });

  test("kill switch CLAUDISH_CLIENT_ATTRIBUTION=0 disarms even an opted-in endpoint", async () => {
    const prev = process.env.CLAUDISH_CLIENT_ATTRIBUTION;
    process.env.CLAUDISH_CLIENT_ATTRIBUTION = "0";
    try {
      const rec = headerRecordingFetch(200, openaiJsonBody);
      await runHandleWith(
        attributingTransport(true),
        "glm-5.3",
        smallPayload(false),
        rec.impl,
        {},
        { "x-claudish-machine": "myia-po-2025", "x-claudish-workspace": "claudish" }
      );
      expect(rec.captured[0]["x-claudish-client"]).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.CLAUDISH_CLIENT_ATTRIBUTION;
      else process.env.CLAUDISH_CLIENT_ATTRIBUTION = prev;
    }
  });

  test("streaming path carries attribution too (same header-build site)", async () => {
    const sse = [
      { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
      { id: "c1", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ].map((f) => `data: ${JSON.stringify(f)}`).join("\n\n") + "\n\ndata: [DONE]\n\n";
    const rec = headerRecordingFetch(200, sse);
    const res = await runHandleWith(
      attributingTransport(true),
      "glm-5.3",
      smallPayload(true),
      rec.impl,
      {},
      { "x-claudish-machine": "myia-po-2025", "x-claudish-workspace": "claudish" }
    );
    await res.text();
    expect(rec.captured[0]["x-claudish-client"]).toBe("myia-po-2025:claudish");
  });
});

describe("ComposedHandler — #674 exact counting in the uncertain band", () => {
  // The band exists because the estimate cannot decide: `real/est` spans
  // 0.57–3.18 over the served corpus, so below `window / 1.15` even the worst
  // over-count does not reach the window, and at/above it the old gate refused
  // on the estimate alone. Inside, only the engine's own count may decide.
  beforeEach(() => resetOverflowCapsForTests());
  afterEach(() => resetOverflowCapsForTests());

  function exactTransport(answers: Array<number | null>) {
    let calls = 0;
    const probes: any[][] = [];
    const transport = {
      name: "test-exact",
      displayName: "Test Exact",
      streamFormat: "openai-sse",
      getEndpoint: () => "http://upstream.test/v1/chat/completions",
      getHeaders: () => ({}),
      countPromptTokens: async (messages: any[]) => {
        probes.push(messages);
        const answer = answers[Math.min(calls++, answers.length - 1)];
        return answer === null ? null : { exact: answer, maxModelLen: 5000 };
      },
    } as unknown as ProviderTransport;
    return { transport, probes };
  }

  test("exact >= window → refused locally, exact count in the message, NO upstream call", async () => {
    const { transport, probes } = exactTransport([6_000]);
    const fx = countingFetch(200, "should never be reached");
    const res = await runHandleWith(transport, "fake-model", overflowPayload(false, 40_000), fx.impl as typeof fetch, {
      derivedContextLimit: 5_000,
    });

    expect(fx.getCalls()).toBe(0); // the doomed round-trip is skipped
    expect(probes.length).toBe(1); // the estimate nominated it
    expect(res.status).toBe(200); // the #79 recoverable turn, never a bare 400
    const body = await res.text();
    expect(body).toContain("maximum prompt size");
    expect(body).toContain("exact count from the provider's tokenizer");
    expect(body).toContain("6000");
  });

  test("exact < window while est >= window → served upstream: the estimate may not refuse alone", async () => {
    // The ×3.18 tail case, in the direction that costs a served turn: the old
    // gate refused this request on its estimate.
    const { transport } = exactTransport([4_000]);
    const fx = countingFetch(200, "served by the upstream");
    const res = await runHandleWith(transport, "fake-model", overflowPayload(false, 40_000), fx.impl as typeof fetch, {
      derivedContextLimit: 5_000,
    });

    expect(fx.getCalls()).toBe(1);
    expect(res.status).toBe(200);
  });

  test("no exact answer (null) → indistinguishable from a transport with no tokenizer", async () => {
    const { transport, probes } = exactTransport([null]);
    const fx = countingFetch(200, "should never be reached");
    const res = await runHandleWith(transport, "fake-model", overflowPayload(false, 40_000), fx.impl as typeof fetch, {
      derivedContextLimit: 5_000,
    });

    expect(probes.length).toBe(1); // asked once
    expect(fx.getCalls()).toBe(0); // pre-#674 behavior: est >= window refuses
    expect(await res.text()).toContain("maximum prompt size");
  });

  test("below the band nothing is probed — one extra round-trip is not free", async () => {
    const { transport, probes } = exactTransport([6_000]);
    const fx = countingFetch(200, "ok");
    await runHandleWith(transport, "fake-model", overflowPayload(false, 1_000), fx.impl as typeof fetch, {
      derivedContextLimit: 10_000_000,
    });

    expect(probes.length).toBe(0);
    expect(fx.getCalls()).toBe(1);
  });

  test("CLAUDISH_EXACT_COUNT=0 disarms it: no probe, pre-#674 behavior", async () => {
    const previous = process.env.CLAUDISH_EXACT_COUNT;
    process.env.CLAUDISH_EXACT_COUNT = "0";
    try {
      const { transport, probes } = exactTransport([1_000]);
      const fx = countingFetch(200, "should never be reached");
      await runHandleWith(transport, "fake-model", overflowPayload(false, 40_000), fx.impl as typeof fetch, {
        derivedContextLimit: 5_000,
      });
      expect(probes.length).toBe(0);
      expect(fx.getCalls()).toBe(0); // est >= window still refuses on the estimate
    } finally {
      if (previous === undefined) delete process.env.CLAUDISH_EXACT_COUNT;
      else process.env.CLAUDISH_EXACT_COUNT = previous;
    }
  });
});
