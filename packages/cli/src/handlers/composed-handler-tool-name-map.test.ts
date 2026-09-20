/**
 * #164 — the capture-before-await contract on the tool-name decode map.
 *
 * `handle()` captures `adapter.getToolNameMap()` immediately after
 * `prepareRequest` (composed-handler.ts, before any await) and threads it into
 * `handleStream` as a parameter; `reset()` at the START of every request
 * replaces the adapter's bindings. Handlers are cached one per model while
 * `claudish serve` hosts several conversations, so a lane that re-reads the
 * adapter after the upstream await hands the in-flight request the NEXT
 * request's map — its tool calls surface with the encoded wire name (or get
 * dropped) and no error anywhere. The `openai-responses-sse` lane did exactly
 * that until cdfcea6; a single-request test cannot tell the two apart, which
 * is why the defect survived review.
 *
 * These drive TWO requests through the SAME handler instance, with request B
 * (and its `reset()`) landing between A's dispatch and A's parser consuming
 * the map, on both wires the codec applies to. Non-vacuity: reverting a call
 * site to `adapter.getToolNameMap()` must turn its test red (measured in the
 * PR — a single-request test passes either way).
 */
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { ProviderTransport } from "../../providers/transport/types.js";
import { ComposedHandler } from "./composed-handler.js";

function makeTransport(streamFormat: string): ProviderTransport {
  return {
    name: "test-provider",
    displayName: "Test Provider",
    streamFormat,
    overrideStreamFormat: () => streamFormat as any,
    getEndpoint: () => "http://upstream.test/v1",
    getHeaders: () => ({}),
  } as unknown as ProviderTransport;
}

// > 64 chars AND distinct prefixes, so A's and B's encoded names differ and
// the wrong map is distinguishable from the right one.
const LONG_A = "mcp__alpha_" + "a".repeat(64);
const LONG_B = "mcp__beta_" + "b".repeat(64);

function payloadWith(toolName: string): any {
  return {
    model: "test-model",
    max_tokens: 64,
    stream: true,
    messages: [{ role: "user", content: "use the tool" }],
    tools: [
      {
        name: toolName,
        description: "probe tool",
        input_schema: { type: "object", properties: {} },
      },
    ],
  };
}

/** ReadableStream the test feeds chunk by chunk after the Response is handed out. */
function controlledSse(firstChunk: string): {
  response: () => Response;
  emit: (chunk: string) => void;
  end: () => void;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      controller.enqueue(new TextEncoder().encode(firstChunk));
    },
  });
  return {
    response: () =>
      new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
    emit: (chunk) => controller.enqueue(new TextEncoder().encode(chunk)),
    end: () => controller.close(),
  };
}

const sse = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * Runs A and B through the SAME ComposedHandler, with B landing inside A's
 * upstream-response latency window — the production race: handlers are cached
 * per model, request A's `await doFetch` is pending when request B arrives and
 * its `reset()` replaces the adapter's bindings. A's fetch promise is HELD
 * until B has fully completed, then resolved; a lane that re-reads the map
 * after the await (the pre-#164 responses defect) then evaluates B's map.
 * Returns A's client response body plus both encoded wire names.
 */
async function interleavedRun(
  streamFormat: "openai-sse" | "openai-responses-sse",
  firstChunkA: string,
  toolCallChunks: (encodedName: string) => string[]
): Promise<{ bodyA: string; encodedA: string; encodedB: string }> {
  const handler = new ComposedHandler(
    makeTransport(streamFormat),
    "test-model",
    "test-model",
    8471,
    {}
  );
  const encodedNames: Record<"A" | "B", string> = { A: "", B: "" };

  // A: deferred fetch — resolves only once B has run. The stream itself is
  // controlled too: the tool call is emitted last, under A's encoded name.
  let feedA!: { emit: (c: string) => void; end: () => void };
  let releaseA!: () => void;
  let fetchStartedResolve!: () => void;
  const fetchStarted = new Promise<void>((r) => {
    fetchStartedResolve = r;
  });
  const fetchA = async (_input: any, init?: any) => {
    const body = JSON.parse(init?.body ?? "{}");
    const tool = (body.tools ?? [])[0] ?? {};
    encodedNames.A = tool?.function?.name ?? tool?.name ?? "";
    const ctl = controlledSse(firstChunkA);
    feedA = { emit: ctl.emit, end: ctl.end };
    fetchStartedResolve();
    return new Promise<Response>((resolve) => {
      releaseA = () => resolve(ctl.response());
    });
  };

  // B: a complete, boring stream — its purpose is the reset() at handle() start.
  const fetchB = async (_input: any, init?: any) => {
    const body = JSON.parse(init?.body ?? "{}");
    const tool = (body.tools ?? [])[0] ?? {};
    encodedNames.B = tool?.function?.name ?? tool?.name ?? "";
    return healthyResponse(streamFormat);
  };

  const original = (globalThis as any).fetch;
  const appA = new Hono();
  appA.post("/v1/messages", async (c: any) => handler.handle(c, payloadWith(LONG_A)));
  const appB = new Hono();
  appB.post("/v1/messages", async (c: any) => handler.handle(c, payloadWith(LONG_B)));

  try {
    (globalThis as any).fetch = fetchA;
    const promA = appA.request("/v1/messages", {
      method: "POST",
      body: JSON.stringify(payloadWith(LONG_A)),
      headers: { "content-type": "application/json" },
    });
    await fetchStarted; // A is now parked inside its upstream await.

    // B arrives and completes while A's fetch is still pending — handle(B)
    // resets the adapter, replacing the bindings A had captured.
    (globalThis as any).fetch = fetchB;
    await appB.request("/v1/messages", {
      method: "POST",
      body: JSON.stringify(payloadWith(LONG_B)),
      headers: { "content-type": "application/json" },
    });

    releaseA(); // A's upstream response finally arrives — AFTER B's reset().
    const resA = await promA;

    // NOW A's tool call flows, under A's encoded name.
    for (const chunk of toolCallChunks(encodedNames.A)) feedA.emit(chunk);
    feedA.end();

    return { bodyA: await resA.text(), encodedA: encodedNames.A, encodedB: encodedNames.B };
  } finally {
    (globalThis as any).fetch = original;
  }
}

function healthyResponse(streamFormat: "openai-sse" | "openai-responses-sse"): Response {
  const body =
    streamFormat === "openai-responses-sse"
      ? sse("response.created", { type: "response.created" }) +
        sse("response.output_text.delta", { type: "response.output_text.delta", delta: "b" }) +
        sse("response.completed", {
          type: "response.completed",
          response: { usage: { input_tokens: 5, output_tokens: 2 } },
        })
      : `data: ${JSON.stringify({
          id: "b",
          object: "chat.completion.chunk",
          created: 1,
          model: "test-model",
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        })}\n\n` +
        `data: ${JSON.stringify({
          id: "b",
          object: "chat.completion.chunk",
          created: 1,
          model: "test-model",
          choices: [{ index: 0, delta: { content: "b" }, finish_reason: "stop" }],
        })}\n\n` +
        "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("capture-before-await on the tool-name map (#164)", () => {
  test("openai-responses-sse: A decodes with A's bindings after B reset the adapter", async () => {
    const { bodyA, encodedA, encodedB } = await interleavedRun(
      "openai-responses-sse",
      sse("response.created", { type: "response.created" }),
      (enc) => [
        sse("response.output_item.added", {
          type: "response.output_item.added",
          item: { type: "function_call", id: "fc_1", call_id: "fc_1", name: enc, arguments: "" },
        }),
        sse("response.function_call_arguments.delta", {
          type: "response.function_call_arguments.delta",
          call_id: "fc_1",
          delta: "{}",
        }),
        sse("response.output_item.done", {
          type: "response.output_item.done",
          item: { type: "function_call", call_id: "fc_1", id: "fc_1" },
        }),
        sse("response.completed", {
          type: "response.completed",
          response: { usage: { input_tokens: 10, output_tokens: 4 } },
        }),
      ]
    );

    // The harness must actually discriminate: distinct encoded names, both
    // encoded (shorter than the originals), A ≠ B.
    expect(encodedA).not.toBe("");
    expect(encodedB).not.toBe("");
    expect(encodedA).not.toBe(encodedB);
    expect(encodedA.length).toBeLessThan(LONG_A.length);

    // A's tool call surfaces under A's ORIGINAL name, never the encoded one.
    expect(bodyA).toContain(`"name":"${LONG_A}"`);
    expect(bodyA).not.toContain(encodedA);
    expect(bodyA).toContain("message_stop");
  });

  test("openai-sse: A decodes with A's bindings after B reset the adapter", async () => {
    const chunk = (delta: any, finish: string | null = null) =>
      `data: ${JSON.stringify({
        id: "a",
        object: "chat.completion.chunk",
        created: 1,
        model: "test-model",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
    const { bodyA, encodedA, encodedB } = await interleavedRun(
      "openai-sse",
      chunk({ role: "assistant" }),
      (enc) => [
        chunk({
          tool_calls: [
            { index: 0, id: "call_1", type: "function", function: { name: enc, arguments: "" } },
          ],
        }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: "{}" } }] }),
        chunk({}, "tool_calls"),
        "data: [DONE]\n\n",
      ]
    );

    expect(encodedA).not.toBe("");
    expect(encodedB).not.toBe("");
    expect(encodedA).not.toBe(encodedB);
    expect(encodedA.length).toBeLessThan(LONG_A.length);

    expect(bodyA).toContain(`"name":"${LONG_A}"`);
    expect(bodyA).not.toContain(encodedA);
    expect(bodyA).toContain("message_stop");
  });
});
