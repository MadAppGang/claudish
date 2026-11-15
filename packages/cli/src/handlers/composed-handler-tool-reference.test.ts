// End to end through the handler: a ToolSearch result that holds only a
// `tool_reference` item reaches the model as a sentence that names the tool,
// not as an empty result, in each body shape and under the tool-name alias.
import { afterEach, describe, expect, test } from "bun:test";
import type { Context } from "hono";
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

/** The function responses of the body sent for a ToolSearch that loaded `loaded`. */
async function searchResults(providerName: string, model: string, loaded: string) {
  const { transport, sentBodies } = geminiTransport(providerName);
  const handler = new ComposedHandler(transport, model, model, 8080, {});
  const res = await handler.handle(makeContext(), {
    model,
    max_tokens: 64,
    stream: true,
    system: "You are a coding agent.",
    tools: [tool("ToolSearch"), tool(loaded)],
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
  const body = JSON.parse(sentBodies[0] ?? "{}");
  // The handler picks the converter from the provider: Gemini-shaped bodies
  // hold the result in a `functionResponse` part, Chat Completions bodies in
  // a `tool` message.
  const fromParts = (body.contents ?? [])
    .flatMap((turn: any) => turn.parts ?? [])
    .filter((part: any) => part.functionResponse)
    .map((part: any) => part.functionResponse.response.content);
  const fromMessages = (body.messages ?? [])
    .filter((message: any) => message.role === "tool")
    .map((message: any) => message.content);
  return [...fromParts, ...fromMessages];
}

describe("a ToolSearch result that holds only a tool reference", () => {
  test("gemini: the model reads which tool was loaded, not OK", async () => {
    const results = await searchResults("gemini", "gemini-4-argon", "WebFetch");
    expect(results).toEqual(["Loaded: WebFetch. It is in your tool list now."]);
  });

  test("antigravity: the sentence uses the name the tool is declared under", async () => {
    const results = await searchResults("antigravity", "gemini-4-argon", "Read");
    expect(results).toEqual(["Loaded: read_file. It is in your tool list now."]);
  });

  test("antigravity serving a Claude model: the sentence is sent as well", async () => {
    const results = await searchResults("antigravity", "claude-opus-5-5", "WebFetch");
    expect(results).toEqual(["Loaded: WebFetch. It is in your tool list now."]);
  });
});
