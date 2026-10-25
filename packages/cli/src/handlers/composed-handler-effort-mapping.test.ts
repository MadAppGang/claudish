/**
 * #667 — the client's thinking level reaches the endpoint's own depth knob.
 *
 * Claude Code sends `output_config.effort` (low|medium|high|xhigh|max) next
 * to `thinking:{type:"adaptive"}`. Before #667 the field was read only by
 * the MiniMax dialect (to overwrite it under an operator policy) — every
 * OpenAI-wire route dropped it, and the local vLLM engine serving the haiku
 * role applied its own `medium` default instead of the level the user
 * picked. The fix is a per-endpoint opt-in (`effortTarget` in the custom
 * endpoint schema) mapping the client level onto the top-level
 * `chat_template_kwargs.reasoning_effort` (vLLM levels low|medium|xhigh).
 *
 * These pins drive ComposedHandler end-to-end (Hono + stubbed fetch, the
 * same harness shape as composed-handler-minimax-thinking.test.ts) and
 * assert on the OUTBOUND wire body the transport actually sent. The fixed
 * monotonic ladder lives in EFFORT_TARGET_LADDER (composed-handler.ts):
 *
 *   low→low · medium→medium · high→xhigh · xhigh→xhigh · max→xhigh
 *
 * `high` maps to xhigh, not medium, because medium is what the engine
 * applies when NOT asked — mapping the client's explicit high onto it would
 * make the most common client level (haiku-5-5 sends high) a no-op.
 */
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { ProviderTransport } from "../providers/transport/types.js";
import { OpenAIAPIFormat } from "../adapters/openai-api-format.js";
import { ComposedHandler } from "./composed-handler.js";

const MODEL = "test-haiku-swift";

function makeTransport(extraPayloadFields?: Record<string, unknown>): ProviderTransport {
  return {
    name: "test-vllm",
    displayName: "Test vLLM",
    streamFormat: "openai-sse",
    overrideStreamFormat: () => "openai-sse" as any,
    getEndpoint: () => "http://upstream.test/v1/chat/completions",
    getHeaders: () => ({}),
    ...(extraPayloadFields ? { getExtraPayloadFields: () => extraPayloadFields } : {}),
  } as unknown as ProviderTransport;
}

/** Minimal OpenAI SSE upstream: one content chunk, finish, [DONE]. */
function openaiUpstream(): Response {
  const chunk = (delta: unknown, finish: string | null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model: MODEL,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  const body =
    chunk({ role: "assistant", content: "ok" }, null) +
    chunk({}, "stop") +
    "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

interface RunResult {
  wireBody: any;
  resStatus: number;
  resText: string;
}

/**
 * Drive one request through ComposedHandler on the OpenAI wire and return the
 * parsed OUTBOUND body plus the client-facing response. Captures whatever
 * fetch shape the transport used — (url, init) or a single Request.
 */
async function run(
  clientPayload: any,
  opts?: { effortTarget?: "chat_template_kwargs.reasoning_effort"; extraPayloadFields?: Record<string, unknown> }
): Promise<RunResult> {
  let wireBody: any;
  const handler = new ComposedHandler(makeTransport(opts?.extraPayloadFields), MODEL, MODEL, 8472, {
    adapter: new OpenAIAPIFormat(MODEL),
    ...(opts?.effortTarget ? { effortTarget: opts.effortTarget } : {}),
  });
  const app = new Hono();
  app.post("/v1/messages", async (c: any) => handler.handle(c, clientPayload));
  const original = (globalThis as any).fetch;
  (globalThis as any).fetch = async (...args: any[]) => {
    const [a, b] = args;
    let raw: unknown;
    if (typeof Request !== "undefined" && a instanceof Request) raw = await a.clone().text();
    else raw = b?.body ?? a?.body;
    try {
      wireBody = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      wireBody = raw;
    }
    return openaiUpstream();
  };
  try {
    const res = await app.request("/v1/messages", {
      method: "POST",
      body: JSON.stringify(clientPayload),
      headers: { "content-type": "application/json" },
    });
    return { wireBody, resStatus: res.status, resText: await res.text() };
  } finally {
    (globalThis as any).fetch = original;
  }
}

const baseRequest = (effort?: string, thinking?: unknown): any => {
  const payload: any = {
    model: MODEL,
    max_tokens: 1024,
    stream: true,
    messages: [{ role: "user", content: "hello" }],
  };
  if (effort !== undefined) payload.output_config = { effort };
  if (thinking !== undefined) payload.thinking = thinking;
  return payload;
};

describe("ComposedHandler — #667 effort mapping onto chat_template_kwargs.reasoning_effort", () => {
  test("AC1: without the option the client effort is dropped exactly as today (byte-identical path)", async () => {
    const { wireBody } = await run(baseRequest("high"));
    expect(wireBody.chat_template_kwargs).toBeUndefined();
    expect(wireBody.reasoning_effort).toBeUndefined();
    expect("reasoning_effort" in wireBody).toBe(false);
  });

  test("AC2: with the option the level lands TOP-LEVEL, sibling keys preserved, never under extra_body", async () => {
    const { wireBody } = await run(baseRequest("high"), {
      effortTarget: "chat_template_kwargs.reasoning_effort",
      extraPayloadFields: { chat_template_kwargs: { enable_thinking: true } },
    });
    expect(wireBody.chat_template_kwargs).toEqual({ enable_thinking: true, reasoning_effort: "xhigh" });
    expect(wireBody.extra_body).toBeUndefined();
  });

  test("AC3: the fixed monotonic ladder — one assertion per client level", async () => {
    const ladder: Record<string, string> = {
      low: "low",
      medium: "medium",
      high: "xhigh",
      xhigh: "xhigh",
      max: "xhigh",
    };
    for (const [clientLevel, targetLevel] of Object.entries(ladder)) {
      const { wireBody } = await run(baseRequest(clientLevel), {
        effortTarget: "chat_template_kwargs.reasoning_effort",
      });
      expect(wireBody.chat_template_kwargs?.reasoning_effort).toBe(targetLevel);
    }
  });

  test("AC4: absent client effort writes nothing — the engine's own default keeps applying", async () => {
    const { wireBody } = await run(baseRequest(undefined), {
      effortTarget: "chat_template_kwargs.reasoning_effort",
      extraPayloadFields: { chat_template_kwargs: { enable_thinking: true } },
    });
    expect(wireBody.chat_template_kwargs).toEqual({ enable_thinking: true }); // untouched
  });

  test("AC4: a disabled thinking keeps its current behaviour — nothing added on top", async () => {
    const { wireBody } = await run(baseRequest(undefined, { type: "disabled" }), {
      effortTarget: "chat_template_kwargs.reasoning_effort",
    });
    expect(wireBody.chat_template_kwargs).toBeUndefined();
  });

  test("AC5: an unrecognized effort value is dropped and the request is still served", async () => {
    const { wireBody, resStatus, resText } = await run(baseRequest("ultra"), {
      effortTarget: "chat_template_kwargs.reasoning_effort",
    });
    expect(wireBody.chat_template_kwargs).toBeUndefined();
    expect(resStatus).toBe(200);
    expect(resText).toContain("ok");
  });

  test("the mapping is real, not vacuous — AC1's drop is a mapping, not a dead option (premise guard)", async () => {
    const unmapped = await run(baseRequest("high"));
    const mapped = await run(baseRequest("high"), { effortTarget: "chat_template_kwargs.reasoning_effort" });
    expect(unmapped.wireBody.chat_template_kwargs).toBeUndefined();
    expect(mapped.wireBody.chat_template_kwargs?.reasoning_effort).toBe("xhigh");
  });
});
