/**
 * #155 — pre-stream extension of #65. A policy-class refusal arriving as a
 * plain HTTP 4xx body (no SSE started) used to bypass the lane parsers
 * entirely and kill the agent turn as a bare `API Error` (fleet session,
 * 2026-09-19 14:41Z). These pin the full contract on all three arrival
 * surfaces — openai-sse lane, anthropic-sse lane, and the OpenAI ingress
 * chain — plus the negative controls (quota/overflow/5xx stay with their
 * owners) and the counting markers.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import type { ProviderTransport } from "../../../../providers/transport/types.js";
import { ComposedHandler } from "../../composed-handler.js";
import {
  preStreamPolicyRefusal,
  preStreamPolicyRetry,
  setPolicyRetryBackoffForTests,
} from "./policy-refusal.js";
import { convertOpenAIRequestToAnthropic } from "../format/openai-request-to-anthropic.js";
import { anthropicMessageToChatCompletion } from "../anthropic-to-openai.js";

// The exact message from the fleet report (issue #155), body verbatim.
const FLAGGED_MESSAGE =
  "Invalid prompt: your prompt was flagged as potentially violating our usage policy. Please try again with a different prompt: https://platform.openai.com/docs/guides/reasoning#advice-on-prompting";
const OPENAI_REFUSAL_BODY = JSON.stringify({
  error: { code: "invalid_prompt", message: FLAGGED_MESSAGE },
});
const ANTHROPIC_REFUSAL_BODY = JSON.stringify({
  type: "error",
  error: { type: "invalid_request_error", message: FLAGGED_MESSAGE },
});
const GLM_1308_QUOTA = JSON.stringify({
  error: { code: "1308", message: "Insufficient balance. Your quota is exhausted until the window resets." },
});
const GLM_1261_OVERFLOW = JSON.stringify({
  error: { code: "1261", message: "Prompt exceeds max length" },
});

async function captureStdout(run: () => Promise<void> | void): Promise<string[]> {
  const lines: string[] = [];
  const originalWrite = process.stdout.write;
  const originalLog = console.log;
  process.stdout.write = ((chunk: any) => {
    lines.push(String(chunk));
    return true;
  }) as any;
  console.log = (...args: unknown[]) => {
    lines.push(args.join(" ") + "\n");
  };
  try {
    await run();
    await Bun.sleep(200); // first forceConsole write buffers longer than a fast helper call
  } finally {
    process.stdout.write = originalWrite;
    console.log = originalLog;
  }
  return lines;
}

function makeTransport(streamFormat: string): ProviderTransport {
  return {
    name: "test-provider",
    displayName: "Test Provider",
    streamFormat,
    // resolveStreamFormat() priority: transport override ?? model adapter ??
    // provider — a bare streamFormat field is NOT enough to select the
    // anthropic lane (the default model adapter wins with openai-sse, #102).
    overrideStreamFormat: () => streamFormat as any,
    getEndpoint: () => "http://upstream.test/v1/chat/completions",
    getHeaders: () => ({}),
  } as unknown as ProviderTransport;
}

function jsonRes(status: number, body: string): () => Response {
  return () =>
    new Response(body, { status, headers: { "content-type": "application/json" } });
}

/** Sequential fetch stub: one factory per expected call (fresh Response each). */
function seqFetch(factories: (() => Response)[]): { impl: typeof fetch; getCalls: () => number } {
  let calls = 0;
  const impl = (async () => {
    const mk = factories[Math.min(calls, factories.length - 1)];
    calls++;
    return mk();
  }) as typeof fetch;
  return { impl, getCalls: () => calls };
}

function healthyOpenAiSse(): () => Response {
  return () => {
    const chunk = (delta: any, finish: string | null = null) =>
      `data: ${JSON.stringify({
        id: "x",
        object: "chat.completion.chunk",
        created: 1,
        model: "test-model",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
    const body =
      chunk({ role: "assistant" }) +
      chunk({ content: "recovered-text" }) +
      chunk({}, "stop") +
      "data: [DONE]\n\n";
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
}

async function runHandle(
  transport: ProviderTransport,
  payload: any,
  fetchImpl: typeof fetch
): Promise<Response> {
  const original = (globalThis as any).fetch;
  (globalThis as any).fetch = fetchImpl;
  try {
    const handler = new ComposedHandler(transport, "test-model", "test-model", 8462, {});
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

function smallPayload(stream: boolean, wire: "anthropic" | "openai" = "anthropic"): any {
  if (wire === "openai") {
    return { model: "test-model", stream, messages: [{ role: "user", content: "hello" }] };
  }
  return {
    model: "test-model",
    max_tokens: 64,
    stream,
    messages: [{ role: "user", content: "hello" }],
  };
}

describe("preStreamPolicyRefusal — classification (#155)", () => {
  test("4xx openai code body → classified", () => {
    const r = preStreamPolicyRefusal(400, OPENAI_REFUSAL_BODY);
    expect(r).not.toBeNull();
    expect(r!.code).toBe("invalid_prompt");
    expect(r!.message).toContain("flagged");
  });

  test("4xx anthropic message-pattern body (no code) → classified", () => {
    const r = preStreamPolicyRefusal(400, ANTHROPIC_REFUSAL_BODY);
    expect(r).not.toBeNull();
    expect(r!.code).toBeNull();
    expect(r!.message).toContain("flagged");
  });

  test("4xx plain-text body → classified via message pattern", () => {
    const r = preStreamPolicyRefusal(403, "Your prompt was flagged by the safety system.");
    expect(r).not.toBeNull();
  });

  test("NEGATIVE: 429 quota wall (GLM 1308) → null — isQuotaExhaustion keeps owning it", () => {
    expect(preStreamPolicyRefusal(429, GLM_1308_QUOTA)).toBeNull();
  });

  test("NEGATIVE: 429 generic rate limit → null", () => {
    expect(
      preStreamPolicyRefusal(429, JSON.stringify({ error: { message: "Rate limit exceeded. Please retry." } }))
    ).toBeNull();
  });

  test("NEGATIVE: 400 overflow 1261 → null — overflow interception keeps its path (#79)", () => {
    expect(preStreamPolicyRefusal(400, GLM_1261_OVERFLOW)).toBeNull();
  });

  test("NEGATIVE: 5xx never classifies, even with a refusal-shaped body", () => {
    expect(preStreamPolicyRefusal(500, OPENAI_REFUSAL_BODY)).toBeNull();
  });

  test("NEGATIVE: 2xx → null", () => {
    expect(preStreamPolicyRefusal(200, OPENAI_REFUSAL_BODY)).toBeNull();
  });
});

describe("preStreamPolicyRetry — bounded identical-body retry", () => {
  beforeEach(() => setPolicyRetryBackoffForTests([1, 1]));
  afterEach(() => setPolicyRetryBackoffForTests(null));

  test("retry recovers on second attempt → ok response, markers per retry", async () => {
    // doFetch here is the RETRY closure — the helper's first call still gets
    // the refusal; recovery lands on the second retry.
    const fx = seqFetch([jsonRes(400, OPENAI_REFUSAL_BODY), healthyOpenAiSse()]);
    let out!: { response: Response | null; attempts: number };
    const lines = await captureStdout(async () => {
      out = await preStreamPolicyRetry(fx.impl, { lane: "openai", model: "m" });
    });
    expect(out.attempts).toBe(2);
    expect(out.response).not.toBeNull();
    expect(out.response!.ok).toBe(true);
    expect(fx.getCalls()).toBe(2);
    const retries = new Set(lines.filter((l) => l.includes("[PolicyRefusal]") && l.includes("action=retry")));
    expect(retries.size).toBe(2);
  });

  test("persistent refusal → null after max attempts", async () => {
    const fx = seqFetch([jsonRes(400, OPENAI_REFUSAL_BODY), jsonRes(400, OPENAI_REFUSAL_BODY), jsonRes(400, OPENAI_REFUSAL_BODY)]);
    const out = await preStreamPolicyRetry(fx.impl, { lane: "anthropic", model: "m" });
    expect(out.attempts).toBe(2);
    expect(out.response).toBeNull();
    expect(fx.getCalls()).toBe(2);
  });

  test("mid-retry foreign non-ok (quota) → returned as-is, NOT surfaced as refusal", async () => {
    const fx = seqFetch([jsonRes(400, OPENAI_REFUSAL_BODY), jsonRes(429, GLM_1308_QUOTA)]);
    const out = await preStreamPolicyRetry(fx.impl, { lane: "openai", model: "m" });
    expect(out.response).not.toBeNull();
    expect(out.response!.status).toBe(429);
  });

  test("thrown retry → loop continues, refusal still surfaces as null", async () => {
    let calls = 0;
    const impl = (async () => {
      calls++;
      if (calls === 1) throw new Error("socket reset mid-retry");
      return jsonRes(400, OPENAI_REFUSAL_BODY)();
    }) as typeof fetch;
    const out = await preStreamPolicyRetry(impl, { lane: "openai", model: "m", backoffMs: [1, 1] });
    expect(out.response).toBeNull();
    expect(calls).toBe(2); // throw did not abort the attempt sequence
  });
});

describe("ComposedHandler — pre-stream refusal surfacing (#155)", () => {
  beforeEach(() => setPolicyRetryBackoffForTests([1, 1]));
  afterEach(() => setPolicyRetryBackoffForTests(null));

  test("openai-sse lane, stream:true, persistent refusal → 200 labeled terminal turn + markers", async () => {
    const fx = seqFetch([
      jsonRes(400, OPENAI_REFUSAL_BODY),
      jsonRes(400, OPENAI_REFUSAL_BODY),
      jsonRes(400, OPENAI_REFUSAL_BODY),
    ]);
    let res!: Response;
    const lines = await captureStdout(async () => {
      res = await runHandle(makeTransport("openai-sse"), smallPayload(true), fx.impl);
    });

    // NOT a bare 4xx: ok-by-design also stops handleWithCascade (a policy
    // flag is not a quota wall and must not burn a failover step).
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(fx.getCalls()).toBe(3); // 1 initial + 2 bounded retries

    const body = await res.text();
    const types = [...body.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
    expect(types[0]).toBe("message_start");
    expect(types[types.length - 1]).toBe("message_stop"); // never-hang: terminal frame
    expect(body).toContain("Upstream policy refusal");
    expect(body).toContain("invalid_prompt");

    const retries = new Set(lines.filter((l) => l.includes("[PolicyRefusal]") && l.includes("action=retry")));
    const surfaced = new Set(lines.filter((l) => l.includes("[PolicyRefusal]") && l.includes("action=surface")));
    expect(retries.size).toBe(2);
    expect(surfaced.size).toBe(1);
    expect([...surfaced][0]).toContain("lane=openai");
    expect([...surfaced][0]).toContain("attempt=3");
  });

  test("anthropic-sse lane, stream:false → single JSON message, end_turn, lane=anthropic", async () => {
    const fx = seqFetch([
      jsonRes(400, ANTHROPIC_REFUSAL_BODY),
      jsonRes(400, ANTHROPIC_REFUSAL_BODY),
      jsonRes(400, ANTHROPIC_REFUSAL_BODY),
    ]);
    let res!: Response;
    const lines = await captureStdout(async () => {
      res = await runHandle(makeTransport("anthropic-sse"), smallPayload(false), fx.impl);
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    const msg = await res.json();
    expect(msg.role).toBe("assistant");
    expect(msg.stop_reason).toBe("end_turn");
    expect(msg.content[0].type).toBe("text");
    expect(msg.content[0].text).toContain("Upstream policy refusal");
    expect(msg.usage.input_tokens).toBe(0);
    const surfaced = new Set(lines.filter((l) => l.includes("[PolicyRefusal]") && l.includes("action=surface")));
    expect(surfaced.size).toBe(1);
    expect([...surfaced][0]).toContain("lane=anthropic");
  });

  test("NEGATIVE: 429 quota body → no interception, no retry, error path owns it", async () => {
    const fx = seqFetch([jsonRes(429, GLM_1308_QUOTA)]);
    let res!: Response;
    const lines = await captureStdout(async () => {
      res = await runHandle(makeTransport("openai-sse"), smallPayload(true), fx.impl);
    });

    expect(res.status).not.toBe(200);
    expect(fx.getCalls()).toBe(1); // zero policy retries fired
    const anyMarker = new Set(lines.filter((l) => l.includes("[PolicyRefusal]")));
    expect(anyMarker.size).toBe(0);
    const body = await res.text();
    expect(body).not.toContain("Upstream policy refusal");
  });

  test("recovery: first call refuses, retry passes → client gets the healthy upstream stream", async () => {
    const fx = seqFetch([jsonRes(400, OPENAI_REFUSAL_BODY), healthyOpenAiSse()]);
    let res!: Response;
    const lines = await captureStdout(async () => {
      res = await runHandle(makeTransport("openai-sse"), smallPayload(true), fx.impl);
    });

    expect(res.status).toBe(200);
    expect(fx.getCalls()).toBe(2); // transparent — the client never knew
    const body = await res.text();
    expect(body).toContain("recovered-text");
    expect(body).toContain("message_stop");
    expect(body).not.toContain("Upstream policy refusal");
    const retries = new Set(lines.filter((l) => l.includes("[PolicyRefusal]") && l.includes("action=retry")));
    const surfaced = new Set(lines.filter((l) => l.includes("[PolicyRefusal]") && l.includes("action=surface")));
    expect(retries.size).toBe(1);
    expect(surfaced.size).toBe(0);
  });

  test("OpenAI ingress chain (issue #155 AC): translated client sees a well-formed completion, not an API error", async () => {
    // Mirrors the ingress tail of proxy-server.ts /v1/chat/completions:
    // convertOpenAIRequestToAnthropic → ComposedHandler.handle → (ok) →
    // anthropicMessageToChatCompletion. The interception lives inside
    // handle(), so the ingress inherits it by construction; this pins the
    // end-to-end translation the OpenAI SDK actually consumes.
    const fx = seqFetch([
      jsonRes(400, OPENAI_REFUSAL_BODY),
      jsonRes(400, OPENAI_REFUSAL_BODY),
      jsonRes(400, OPENAI_REFUSAL_BODY),
    ]);
    const anthropicBody = convertOpenAIRequestToAnthropic(smallPayload(false, "openai"));
    expect(anthropicBody.stream).not.toBe(true);

    let res!: Response;
    const lines = await captureStdout(async () => {
      res = await runHandle(makeTransport("openai-sse"), anthropicBody, fx.impl);
    });
    expect(res.status).toBe(200);

    const message = await res.json();
    const chat = anthropicMessageToChatCompletion(message, "test-model");
    expect(chat.object).toBe("chat.completion");
    expect(chat.choices[0].finish_reason).toBe("stop");
    expect(chat.choices[0].message.content).toContain("Upstream policy refusal");
    const surfaced = lines.filter((l) => l.includes("[PolicyRefusal]") && l.includes("action=surface"));
    expect(surfaced.length).toBe(1);
  });
});
