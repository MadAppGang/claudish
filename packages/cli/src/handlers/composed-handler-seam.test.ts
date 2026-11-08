/**
 * The response seam end to end through ComposedHandler: a stubbed upstream,
 * the real parser, `withHooks`, the built-in hooks.
 *
 * - A request no rewriting hook claims streams byte-identically to the handler
 *   without hooks, and the seam hands back the handler's own Response object.
 * - Plan-mode tool repair works again: in plan mode a Write aimed at an
 *   invented file in the plan directory reaches Claude Code redirected to the
 *   assigned plan file, on the openai-sse and anthropic-sse wires. Outside plan
 *   mode nothing is held or changed.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { AnthropicAPIFormat } from "../adapters/anthropic-api-format.js";
import { OpenAIAPIFormat } from "../adapters/openai-api-format.js";
import { builtinHooks } from "../hooks/builtins/index.js";
import { HookEngine } from "../hooks/engine.js";
import type { JournalEntry } from "../hooks/journal.js";
import type { HookDefinition } from "../hooks/public.js";
import { HookRegistry, type UserHookInput } from "../hooks/registry.js";
import { withHooks } from "../hooks/response-seam.js";
import type { ProviderTransport } from "../providers/transport/types.js";
import { normalizeWire } from "../test-fixtures/parser-goldens/golden-format.js";
import { ComposedHandler } from "./composed-handler.js";
import type { ModelHandler } from "./types.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const PLAN_DIR = "/tmp/seam-e2e/plans";
const ASSIGNED = `${PLAN_DIR}/assigned-plan.md`;
const INVENTED = `${PLAN_DIR}/my-own-name.md`;

const encoder = new TextEncoder();

/** Stub every fetch with a fresh streaming body of `chunks`. */
function stubStream(chunks: string[]): void {
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

function transport(streamFormat: string): ProviderTransport {
  return {
    name: "test-provider",
    displayName: "Test",
    streamFormat,
    getEndpoint: () => "http://localhost/v1/chat/completions",
    getHeaders: async () => ({}),
  } as unknown as ProviderTransport;
}

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

function engineWith(users: UserHookInput[] = []) {
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
  id: `hook:e2e/${def.id}`,
  module: "/e2e.ts",
  moduleIndex: 0,
  exportIndex: 0,
  def: { apiVersion: 1, ...def } as HookDefinition,
});

const WRITE_TOOL = {
  name: "Write",
  description: "Write a file",
  input_schema: {
    type: "object",
    properties: { file_path: { type: "string" }, content: { type: "string" } },
    required: ["file_path", "content"],
  },
};

function payload(planMode: boolean, stream = true): any {
  return {
    model: "glm-5",
    max_tokens: 64,
    stream,
    messages: [
      {
        role: "user",
        content: planMode
          ? `Plan mode is active. No plan file exists yet. You should create your plan at ${ASSIGNED} using the Write tool.`
          : "Write the plan.",
      },
    ],
    tools: [WRITE_TOOL],
  };
}

const openAiFrame = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;

/** An OpenAI chat-completions stream: some text, then one Write call in two fragments. */
function openAiWriteStream(path: string): string[] {
  const args = JSON.stringify({ file_path: path, content: "# Plan" });
  return [
    openAiFrame({ choices: [{ delta: { role: "assistant", content: "Writing the plan." } }] }),
    openAiFrame({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_w",
                type: "function",
                function: { name: "Write", arguments: args.slice(0, 20) },
              },
            ],
          },
        },
      ],
    }),
    openAiFrame({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(20) } }] } }],
    }),
    openAiFrame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    "data: [DONE]\n\n",
  ];
}

const anthropicFrame = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** A native Anthropic-format stream: one Write call whose arguments arrive in two fragments. */
function anthropicWriteStream(path: string): string[] {
  const args = JSON.stringify({ file_path: path, content: "# Plan" });
  return [
    anthropicFrame("message_start", {
      type: "message_start",
      message: {
        id: "msg_a",
        type: "message",
        role: "assistant",
        content: [],
        model: "glm-5",
        usage: { input_tokens: 5, output_tokens: 1 },
      },
    }),
    anthropicFrame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_w", name: "Write", input: {} },
    }),
    anthropicFrame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: args.slice(0, 20) },
    }),
    anthropicFrame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: args.slice(20) },
    }),
    anthropicFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
    anthropicFrame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 9 },
    }),
    anthropicFrame("message_stop", { type: "message_stop" }),
  ];
}

/** The Write call's arguments as the client assembles them. */
function writeArgs(wire: string): Record<string, unknown> {
  let json = "";
  for (const line of wire.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    const p = JSON.parse(line.slice(6));
    if (p.type === "content_block_delta" && p.delta?.type === "input_json_delta") {
      json += p.delta.partial_json;
    }
  }
  return JSON.parse(json);
}

/** Read a body chunk by chunk, normalizing each. */
async function chunksOf(res: Response): Promise<string[]> {
  const out: string[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const r = await reader.read();
    if (r.done) return out;
    out.push(normalizeWire(decoder.decode(r.value)));
  }
}

function openAiHandler(): ComposedHandler {
  return new ComposedHandler(transport("openai-sse"), "glm-5", "glm-5", 8080, {
    adapter: new OpenAIAPIFormat("glm-5"),
  });
}

describe("an unclaimed request streams byte-identically", () => {
  it("the seam returns the handler's own Response, and the bytes match a run without hooks", async () => {
    const upstream = openAiWriteStream("/repo/src/file.ts");
    // Hooks are loaded and run (a request hook and every built-in), but none
    // claims the response: no plan mode, observer off, no rewrite or end hook.
    const { engine } = engineWith([user({ id: "req-only", on: { request: () => [] } })]);

    stubStream(upstream);
    const plain = await chunksOf(await openAiHandler().handle(context(), payload(false)));

    stubStream(upstream);
    const handler = openAiHandler();
    let inner: Response | undefined;
    const spy: ModelHandler = {
      handle: async (c, p) => {
        inner = await handler.handle(c, p);
        return inner;
      },
      shutdown: () => handler.shutdown(),
    };
    const outer = await withHooks(spy, engine).handle(context(), payload(false));
    expect(outer).toBe(inner as Response);
    const hooked = await chunksOf(outer);

    // Same bytes, same chunk boundaries.
    expect(hooked).toEqual(plain);
    expect(writeArgs(hooked.join(""))).toEqual({
      file_path: "/repo/src/file.ts",
      content: "# Plan",
    });
  });

  it("with only an observe consumer (a responseEnd hook) the bytes and chunking are unchanged too", async () => {
    const upstream = openAiWriteStream("/repo/src/file.ts");
    const { engine } = engineWith([user({ id: "end", on: { responseEnd: () => [] } })]);

    stubStream(upstream);
    const plain = await chunksOf(await openAiHandler().handle(context(), payload(false)));
    stubStream(upstream);
    const tapped = await chunksOf(
      await withHooks(openAiHandler(), engine).handle(context(), payload(false))
    );
    expect(tapped).toEqual(plain);
  });
});

describe("plan-mode tool repair through ComposedHandler", () => {
  it("openai-sse: a Write to an invented plan filename reaches the client redirected", async () => {
    const { engine, journal } = engineWith();
    stubStream(openAiWriteStream(INVENTED));
    const res = await withHooks(openAiHandler(), engine).handle(context(), payload(true));
    const wire = await res.text();

    expect(writeArgs(wire)).toEqual({ file_path: ASSIGNED, content: "# Plan" });
    expect(wire).not.toContain("my-own-name.md");
    expect(wire).toContain('"type":"message_stop"');
    const repaired = journal.find(
      (e) => e.hookId === "plan-mode/plan-file-path" && e.decision === "repaired"
    );
    expect(repaired?.toolName).toBe("Write");
    expect(repaired?.pathRelation).toBe("same_dir_wrong_name");
  });

  it("openai-sse control: outside plan mode the same call is not touched", async () => {
    const { engine, journal } = engineWith();
    stubStream(openAiWriteStream(INVENTED));
    const wire = await (
      await withHooks(openAiHandler(), engine).handle(context(), payload(false))
    ).text();
    expect(writeArgs(wire)).toEqual({ file_path: INVENTED, content: "# Plan" });
    expect(journal.some((e) => e.decision === "repaired")).toBe(false);
  });

  it("anthropic-sse: the repaired block is framed correctly (the old interceptor's defect is gone)", async () => {
    const { engine } = engineWith();
    stubStream(anthropicWriteStream(INVENTED));
    const handler = new ComposedHandler(transport("anthropic-sse"), "glm-5", "glm-5", 8080, {
      adapter: new AnthropicAPIFormat("glm-5"),
    });
    const wire = await (await withHooks(handler, engine).handle(context(), payload(true))).text();

    expect(writeArgs(wire)).toEqual({ file_path: ASSIGNED, content: "# Plan" });
    // One delta, then a stop that carries its own event name.
    expect(wire).toContain(
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n'
    );
    expect(wire).not.toContain("event: content_block_stop\nevent:");
  });

  it("stream:false: the JSON message carries the repaired input", async () => {
    const { engine } = engineWith();
    stubStream(openAiWriteStream(INVENTED));
    const res = await withHooks(openAiHandler(), engine).handle(context(), payload(true, false));
    expect(res.headers.get("content-type")).toContain("application/json");
    const message = await res.json();
    const tool = message.content.find((b: any) => b.type === "tool_use");
    expect(tool.input).toEqual({ file_path: ASSIGNED, content: "# Plan" });
  });
});
