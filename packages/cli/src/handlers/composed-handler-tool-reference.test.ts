// End to end through the handler: a ToolSearch result that holds only a
// `tool_reference` item reaches the model as a sentence that names the tool,
// not as `OK` or the item's JSON, through the Gemini and the Chat Completions
// converter and under the tool-name alias.
import { afterEach, describe, expect, test } from "bun:test";
import type { Context } from "hono";
import { GeminiAPIFormat } from "../adapters/gemini-api-format.js";
import { OpenAIAPIFormat } from "../adapters/openai-api-format.js";
import type { ProviderTransport } from "../providers/transport/types.js";
import { ComposedHandler } from "./composed-handler.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function makeContext(): Context {
  return {
    req: { header: () => ({}) },
    header: () => {},
    body: (body: BodyInit | null, init?: ResponseInit) => new Response(body, init),
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), { status: status ?? 200 }),
  } as unknown as Context;
}

function geminiTransport(providerName: string) {
  const sentBodies: string[] = [];
  const transport = {
    name: providerName,
    displayName: providerName,
    streamFormat: "gemini-sse",
    getEndpoint: () => "http://localhost/v1/stream",
    getHeaders: async () => ({}),
    transformPayload: (p: any) => p,
  } as unknown as ProviderTransport;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    sentBodies.push(String(init?.body ?? ""));
    const chunk = `data: ${JSON.stringify({
      candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 },
    })}\n\n`;
    return new Response(chunk, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return { transport, sentBodies };
}

const tool = (name: string) => ({
  name,
  description: `${name}.`,
  input_schema: { type: "object", properties: {} },
});

type Wire = "gemini" | "chat-completions" | "openai";

/** The body sent for a ToolSearch whose result holds only a reference to `loaded`. */
async function sentBody(
  providerName: string,
  model: string,
  loaded: string,
  wire: Wire,
  otherTools: string[] = []
) {
  const { transport, sentBodies } = geminiTransport(providerName);
  // The handler takes its converter from `adapter`, never from the provider
  // name; with none it builds a Chat Completions body.
  const adapters = {
    gemini: () => ({ adapter: new GeminiAPIFormat(model) }),
    openai: () => ({ adapter: new OpenAIAPIFormat(model) }),
    "chat-completions": () => ({}),
  };
  const options = adapters[wire]();
  const handler = new ComposedHandler(transport, model, model, 8080, options);
  const res = await handler.handle(makeContext(), {
    model,
    max_tokens: 64,
    stream: true,
    system: "You are a coding agent.",
    tools: [tool("ToolSearch"), ...otherTools.map(tool), tool(loaded)],
    messages: [
      { role: "user", content: "load the tool" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "ToolSearch", input: { query: loaded } }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [{ type: "tool_reference", tool_name: loaded }],
          },
        ],
      },
    ],
  });
  await res.body?.getReader().read();
  return JSON.parse(sentBodies[0] ?? "{}");
}

/** What each `functionResponse` part of a Gemini-shaped body says. */
const functionResponses = (body: any) =>
  (body.contents ?? [])
    .flatMap((turn: any) => turn.parts ?? [])
    .filter((part: any) => part.functionResponse)
    .map((part: any) => part.functionResponse.response.content);

/** What each `tool` message of a Chat Completions body says. */
const toolMessages = (body: any) =>
  (body.messages ?? [])
    .filter((message: any) => message.role === "tool")
    .map((message: any) => message.content);

describe("a ToolSearch result that holds only a tool reference", () => {
  test("Gemini converter: the model reads which tool was loaded, not OK", async () => {
    const body = await sentBody("gemini", "gemini-4-argon", "WebFetch", "gemini");
    expect(functionResponses(body)).toEqual(["Loaded: WebFetch. It is in your tool list now."]);
  });

  test("antigravity: the sentence uses the name the tool is declared under", async () => {
    const body = await sentBody("antigravity", "gemini-4-argon", "Read", "gemini");
    expect(functionResponses(body)).toEqual(["Loaded: read_file. It is in your tool list now."]);
  });

  test("antigravity serving a Claude model: the sentence is sent as well", async () => {
    const body = await sentBody("antigravity", "claude-opus-5-5", "WebFetch", "gemini");
    expect(functionResponses(body)).toEqual(["Loaded: WebFetch. It is in your tool list now."]);
  });

  test("Chat Completions converter: the tool message is the sentence, not the item's JSON", async () => {
    const body = await sentBody("openrouter", "kimi-k3", "WebFetch", "chat-completions");
    expect(toolMessages(body)).toEqual(["Loaded: WebFetch. It is in your tool list now."]);
  });

  test("a name over the converter's length limit: the sentence uses the encoded name", async () => {
    const long = "mcp__plugin_browser-use_browser-use__retry_with_browser_use_agent";
    const body = await sentBody("openai", "gpt-6-astra", long, "openai");
    const declared = body.tools.map((t: any) => t.function.name);
    const sent = declared.find((name: string) => name.startsWith("mcp__plugin_browser-use"));
    expect(sent).not.toBe(long);
    expect(toolMessages(body)).toEqual([`Loaded: ${sent}. It is in your tool list now.`]);
  });

  test("a tool past the converter's tool-count cap: the sentence says it is not loaded", async () => {
    const others = Array.from({ length: 127 }, (_, i) => `deferred_${i}`);
    const body = await sentBody("openai", "gpt-6-astra", "deferred_last", "openai", others);
    const declared = body.tools.map((t: any) => t.function.name);
    expect(declared).toHaveLength(128);
    expect(declared).not.toContain("deferred_last");
    expect(toolMessages(body)).toEqual(["Not loaded: deferred_last. It is not in your tool list."]);
  });
});
