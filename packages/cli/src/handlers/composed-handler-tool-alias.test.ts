// The OUTBOUND half of the antigravity tool-name alias, end to end through the
// handler: the tool the model is offered carries agy's name. The INBOUND half
// (restoring the name on the response) is proven at the parser level in
// stream-parsers/gemini-sse-tool-alias.test.ts, and the round trip in
// shared/format/tool-name-alias.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import type { Context } from "hono";
import { GeminiAPIFormat } from "../adapters/gemini-api-format.js";
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

/** A gemini-sse transport that records the outbound body and streams one text reply. */
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

function request() {
  return {
    model: "gemini-4-carbon",
    max_tokens: 64,
    stream: true,
    tools: [
      { name: "Bash", description: "Run a command.", input_schema: { type: "object" } },
      { name: "TodoWrite", description: "Plan.", input_schema: { type: "object" } },
    ],
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }] },
      { role: "user", content: "and again" },
    ],
  };
}

async function run(providerName: string) {
  const { transport, sentBodies } = geminiTransport(providerName);
  const handler = new ComposedHandler(transport, "gemini-4-carbon", "gemini-4-carbon", 8080, {});
  const res = await handler.handle(makeContext(), request());
  await res.body?.getReader().read();
  return sentBodies[0] ?? "";
}

describe("ComposedHandler tool-name alias, outbound (antigravity)", () => {
  test("the tool definition the model is offered carries agy's name", async () => {
    const body = await run("antigravity");
    expect(body).toContain("run_command");
    expect(body).not.toContain('"Bash"');
    expect(body).toContain("TodoWrite"); // an unaliased tool is left alone
  });

  test("a non-antigravity gemini route offers Claude Code's own names", async () => {
    const body = await run("openrouter");
    expect(body).toContain('"Bash"');
    expect(body).not.toContain("run_command");
  });
});

// The INBOUND wiring: the handler must give the gemini-sse parser this request's
// own `restore`. The parser tests pass their own mapper, so only a tool call
// that travels through the handler proves the argument is connected.
describe("ComposedHandler tool-name alias, inbound (antigravity)", () => {
  async function toolCallSeenByClient(providerName: string, upstreamName: string) {
    const transport = {
      name: providerName,
      displayName: providerName,
      streamFormat: "gemini-sse",
      getEndpoint: () => "http://localhost/v1/stream",
      getHeaders: async () => ({}),
      transformPayload: (p: any) => p,
    } as unknown as ProviderTransport;
    globalThis.fetch = (async () => {
      const chunk = `data: ${JSON.stringify({
        candidates: [
          {
            content: { parts: [{ functionCall: { name: upstreamName, args: { command: "ls" } } }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 },
      })}\n\n`;
      return new Response(chunk, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const handler = new ComposedHandler(transport, "gemini-4-carbon", "gemini-4-carbon", 8080, {
      adapter: new GeminiAPIFormat("gemini-4-carbon"),
    });
    const res = await handler.handle(makeContext(), request());
    const sse = await res.text();
    return /"type":"tool_use","id":"[^"]+","name":"([^"]+)"/.exec(sse)?.[1];
  }

  test("a run_command call from antigravity reaches Claude Code as Bash", async () => {
    expect(await toolCallSeenByClient("antigravity", "run_command")).toBe("Bash");
  });

  test("another provider's run_command call is passed through unchanged", async () => {
    expect(await toolCallSeenByClient("google-gemini", "run_command")).toBe("run_command");
  });
});
