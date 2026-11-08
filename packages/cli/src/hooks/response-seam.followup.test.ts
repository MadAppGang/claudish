/**
 * Follow-ups F4.2 and F4.3, written from the spec and the public contract only.
 *
 * F4.2  The hook seam must not drop response headers. `x-claudish-signed-with` (the
 *       credential that signed THIS request, URI-encoded) and the auth-verdict headers
 *       (`x-claudish-auth-verdict`) are read per request by `--probe`; a seam that rebuilds
 *       the Response without `headers` would silently lose them.
 * F4.3  A Muse Responses stream (`openai-responses-sse`: output_text deltas, a function call,
 *       `response.completed`, then a trailing `response.subscription_usage` and `[DONE]`)
 *       run through `withHooks` fires a counting `responseEnd` hook exactly once.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { CodexAPIFormat } from "../adapters/codex-api-format.js";
import { OpenAIAPIFormat } from "../adapters/openai-api-format.js";
import { ComposedHandler } from "../handlers/composed-handler.js";
import type { ModelHandler } from "../handlers/types.js";
import type { ProviderTransport } from "../providers/transport/types.js";
import { builtinHooks } from "./builtins/index.js";
import { HookEngine } from "./engine.js";
import type { JournalEntry } from "./journal.js";
import type { HookDefinition, ResponseEndContext } from "./public.js";
import { HookRegistry, type UserHookInput } from "./registry.js";
import { requestHooksOf } from "./request-stage.js";
import { withHooks } from "./response-seam.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const encoder = new TextEncoder();

/* ───────────── harness (same shape as the existing seam tests) ───────────── */

function engineWith(users: UserHookInput[]) {
  const journal: JournalEntry[] = [];
  const config = {};
  const engine = new HookEngine({
    registry: new HookRegistry(builtinHooks(config), users, undefined),
    config,
    hostMode: "other",
    journalSink: (e) => journal.push(e),
    warn: () => {},
    drainTelemetryOutbox: false,
  });
  return { engine, journal };
}

const user = (def: Omit<HookDefinition, "apiVersion">): UserHookInput => ({
  id: `hook:followup/${def.id}`,
  module: "/followup.ts",
  moduleIndex: 0,
  exportIndex: 0,
  def: { apiVersion: 1, ...def } as HookDefinition,
});

// biome-ignore lint/suspicious/noExplicitAny: a minimal Hono context, as the existing seam tests build
function context(): any {
  const vars = new Map<string, unknown>();
  return {
    req: {
      header: (name?: string) =>
        name === undefined ? {} : name === "x-claudish-no-recovery" ? "1" : undefined,
    },
    header: () => {},
    body: (body: BodyInit | null, init?: ResponseInit) => new Response(body, init),
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), { status: status ?? 200 }),
    get: (k: string) => vars.get(k),
    set: (k: string, v: unknown) => vars.set(k, v),
  };
}

// biome-ignore lint/suspicious/noExplicitAny: the Messages API payload is untyped at this layer
function payload(stream = true): any {
  return {
    model: "muse-spark-1.3",
    max_tokens: 64,
    stream,
    messages: [{ role: "user", content: "PONG" }],
  };
}

function stubFetchStream(chunks: string[]): void {
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    )) as unknown as typeof fetch;
}

/** Poll until `check` holds, bounded; true when it did. */
async function eventually(check: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await Bun.sleep(10);
  return check();
}

/* ───────────── F4.2: headers survive the seam ───────────── */

const SIGNER = "muse own login";
const SIGNER_HEADER = encodeURIComponent(SIGNER);

const claudeSse = (text: string) =>
  [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [],
          model: "m",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ],
    [
      "content_block_start",
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ],
    [
      "content_block_delta",
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 2 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ]
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");

/**
 * A terminal handler, as ComposedHandler is to the seam: it begins one attempt (which is
 * what makes the seam run) and answers with the given status, headers and body.
 */
function terminal(init: {
  status: number;
  headers: Record<string, string>;
  body: string;
}): ModelHandler {
  return {
    async handle(c, body) {
      await requestHooksOf(c)?.beginAttempt(c, {
        claudeRequest: structuredClone(body) as Record<string, unknown>,
        route: { modelId: "muse-spark-1.3", provider: "meta-muse-code", native: false },
        model: "muse-spark-1.3",
        stream: (body as { stream?: boolean }).stream !== false,
      });
      return new Response(init.body, { status: init.status, headers: init.headers });
    },
    async shutdown() {},
  };
}

const PROBE_HEADERS = {
  "x-claudish-signed-with": SIGNER_HEADER,
  "x-claudish-auth-verdict": "terminal",
};

describe("F4.2 the signer and auth-verdict headers survive the hook seam", () => {
  it("F4.2-a streamed 2xx with a rewriting hook and an end hook active: both headers are on the client's response", async () => {
    const { engine } = engineWith([
      user({
        id: "edit",
        on: {
          responseRewrite: { handle: () => [{ type: "appendText", text: "-EDIT" }] },
          responseEnd: () => [],
        },
      }),
    ]);
    const inner = terminal({
      status: 200,
      headers: { "content-type": "text/event-stream", ...PROBE_HEADERS },
      body: claudeSse("hello"),
    });
    const res = await withHooks(inner, engine).handle(context(), payload());
    expect(res.status).toBe(200);
    // The hook really rewrote the stream, so this is not the identity pass-through.
    const wire = await res.text();
    expect(wire).toContain("-EDIT");
    expect(res.headers.get("x-claudish-signed-with")).toBe(SIGNER_HEADER);
    expect(res.headers.get("x-claudish-auth-verdict")).toBe("terminal");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
  });

  it("F4.2-b streamed 2xx with only an end hook (observe path): both headers survive", async () => {
    const { engine } = engineWith([user({ id: "end", on: { responseEnd: () => [] } })]);
    const inner = terminal({
      status: 200,
      headers: { "content-type": "text/event-stream", ...PROBE_HEADERS },
      body: claudeSse("hello"),
    });
    const res = await withHooks(inner, engine).handle(context(), payload());
    await res.text();
    expect(res.headers.get("x-claudish-signed-with")).toBe(SIGNER_HEADER);
    expect(res.headers.get("x-claudish-auth-verdict")).toBe("terminal");
  });

  it("F4.2-c stream:false JSON message with a rewriting hook active: both headers survive", async () => {
    const { engine } = engineWith([
      user({
        id: "edit",
        on: { responseRewrite: { handle: () => [{ type: "appendText", text: "-EDIT" }] } },
      }),
    ]);
    const message = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "m",
      content: [{ type: "text", text: "hello" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 2 },
    };
    const inner = terminal({
      status: 200,
      headers: { "content-type": "application/json", ...PROBE_HEADERS },
      body: JSON.stringify(message),
    });
    const res = await withHooks(inner, engine).handle(context(), payload(false));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-claudish-signed-with")).toBe(SIGNER_HEADER);
    expect(res.headers.get("x-claudish-auth-verdict")).toBe("terminal");
    expect(JSON.parse(await res.text()).type).toBe("message");
  });

  it("F4.2-d a non-2xx answer keeps its status, body and both headers", async () => {
    const { engine } = engineWith([
      user({ id: "end", on: { responseEnd: () => [], responseRewrite: { handle: () => [] } } }),
    ]);
    const errorBody = JSON.stringify({
      type: "error",
      error: { type: "authentication_error", message: "claudish login muse" },
    });
    const inner = terminal({
      status: 400,
      headers: { "content-type": "application/json", ...PROBE_HEADERS },
      body: errorBody,
    });
    const res = await withHooks(inner, engine).handle(context(), payload());
    expect(res.status).toBe(400);
    expect(res.headers.get("x-claudish-signed-with")).toBe(SIGNER_HEADER);
    expect(res.headers.get("x-claudish-auth-verdict")).toBe("terminal");
    expect(await res.text()).toBe(errorBody);
  });

  it("F4.2-e through ComposedHandler: the transport's signing credential reaches the client with hooks active", async () => {
    const { engine } = engineWith([
      user({
        id: "edit",
        on: {
          responseRewrite: { handle: () => [{ type: "appendText", text: "-EDIT" }] },
          responseEnd: () => [],
        },
      }),
    ]);
    const transport = {
      name: "meta-muse-code",
      displayName: "Muse Code",
      streamFormat: "openai-sse",
      getEndpoint: () => "http://localhost/v1/chat/completions",
      getHeaders: async () => ({ authorization: "Bearer LLM|TESTKEY0001" }),
      signingCredential: () => SIGNER,
    } as unknown as ProviderTransport;
    const frame = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
    stubFetchStream([
      frame({ choices: [{ delta: { role: "assistant", content: "hello" } }] }),
      frame({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
    ]);
    const handler = new ComposedHandler(transport, "muse-spark-1.3", "muse-spark-1.3", 8080, {
      adapter: new OpenAIAPIFormat("muse-spark-1.3"),
    });
    const res = await withHooks(handler, engine).handle(context(), payload());
    const wire = await res.text();
    expect(wire).toContain("-EDIT");
    expect(res.headers.get("x-claudish-signed-with")).toBe(SIGNER_HEADER);
  });
});

/* ───────────── F4.3: one responseEnd per Muse Responses stream ───────────── */

const responsesWire = (events: Array<Record<string, unknown>>) =>
  events
    .map(
      (e, sequence_number) =>
        `event: ${e.type}\ndata: ${JSON.stringify({ ...e, sequence_number })}\n\n`
    )
    .join("") + "data: [DONE]\n\n";

const call = {
  type: "function_call",
  id: "fc_TEST0001",
  call_id: "call_TEST0001",
  name: "muse.read_file",
  arguments: '{"path":"note.txt"}',
};

const TEXT_EVENTS: Array<Record<string, unknown>> = [
  { type: "response.created", response: { id: "resp_1" } },
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "message", id: "msg_1", role: "assistant", content: [] },
  },
  { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "PONG" },
  {
    type: "response.completed",
    response: { id: "resp_1", usage: { input_tokens: 27, output_tokens: 9 } },
  },
];

const FULL_EVENTS: Array<Record<string, unknown>> = [
  ...TEXT_EVENTS.slice(0, 3),
  { type: "response.output_item.added", output_index: 1, item: { ...call, arguments: "" } },
  {
    type: "response.function_call_arguments.delta",
    output_index: 1,
    item_id: call.id,
    delta: call.arguments,
  },
  { type: "response.output_item.done", output_index: 1, item: call },
  TEXT_EVENTS[3] as Record<string, unknown>,
  {
    type: "response.subscription_usage",
    subscription: {
      tier: "<tier-id>",
      weekly: { resets_at: 1792368000, used_percent: 0 },
      window: { resets_at: 1792088451, used_percent: 2, window_duration_mins: 300 },
    },
  },
];

function museHandler(): ComposedHandler {
  const transport = {
    name: "meta-muse-code",
    displayName: "Muse Code",
    streamFormat: "openai-responses-sse",
    getEndpoint: () => "http://localhost/v1/responses",
    getHeaders: async () => ({ authorization: "Bearer LLM|TESTKEY0001" }),
    signingCredential: () => SIGNER,
  } as unknown as ProviderTransport;
  return new ComposedHandler(transport, "muse-spark-1.3", "muse-spark-1.3", 8080, {
    adapter: new CodexAPIFormat("muse-spark-1.3", "openai-responses-sse", {
      codexExtras: false,
    }),
  });
}

describe("F4.3 a Muse Responses stream through withHooks fires responseEnd exactly once", () => {
  for (const [label, events] of [
    ["text then completed", TEXT_EVENTS],
    ["text, tool call, completed, then trailing subscription_usage", FULL_EVENTS],
  ] as const) {
    it(`F4.3-a ${label}: observe path (responseEnd hook only)`, async () => {
      const seen: ResponseEndContext[] = [];
      const { engine } = engineWith([
        user({ id: "count", on: { responseEnd: (ctx) => void seen.push(ctx) } }),
      ]);
      stubFetchStream([responsesWire(events)]);
      const res = await withHooks(museHandler(), engine).handle(context(), payload());
      const wire = await res.text();
      expect(res.status).toBe(200);
      expect(wire).toContain("PONG");
      expect((wire.match(/event: message_stop/g) ?? []).length).toBe(1);

      expect(await eventually(() => seen.length >= 1)).toBe(true);
      // A second, late firing would land after the first: give it room to appear.
      await Bun.sleep(200);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.response.text).toContain("PONG");
    });

    it(`F4.3-b ${label}: closed path (a rewriting hook is also active)`, async () => {
      const seen: ResponseEndContext[] = [];
      const { engine } = engineWith([
        user({
          id: "count",
          on: {
            responseRewrite: { handle: () => [{ type: "appendText", text: "-EDIT" }] },
            responseEnd: (ctx) => void seen.push(ctx),
          },
        }),
      ]);
      stubFetchStream([responsesWire(events)]);
      const res = await withHooks(museHandler(), engine).handle(context(), payload());
      const wire = await res.text();
      expect(wire).toContain("-EDIT");

      expect(await eventually(() => seen.length >= 1)).toBe(true);
      await Bun.sleep(200);
      expect(seen).toHaveLength(1);
      // responseEnd sees the final bytes the client received.
      expect(seen[0]?.response.text).toContain("PONG-EDIT");
    });
  }

  it("F4.3-c two sequential responses fire once each, not cumulatively", async () => {
    let count = 0;
    const { engine } = engineWith([user({ id: "count", on: { responseEnd: () => void count++ } })]);
    const handler = withHooks(museHandler(), engine);
    for (let i = 1; i <= 2; i++) {
      stubFetchStream([responsesWire(FULL_EVENTS)]);
      const res = await handler.handle(context(), payload());
      await res.text();
      expect(await eventually(() => count >= i)).toBe(true);
      await Bun.sleep(150);
      expect(count).toBe(i);
    }
  });
});
