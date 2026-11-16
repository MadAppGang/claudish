// Claude Code sends the skill list, the agent list and MCP server instructions
// as `role: "system"` messages INSIDE `messages`. The Gemini, Chat Completions
// and Responses converters convert only `user` and `assistant` messages, so the
// handler moves that text into the neighbouring user message before conversion
// (`inline-system.ts`). These tests read the body claudish puts on the wire.
import { afterEach, describe, expect, test } from "bun:test";
import type { Context } from "hono";
import { AnthropicAPIFormat } from "../adapters/anthropic-api-format.js";
import { CodexAPIFormat } from "../adapters/codex-api-format.js";
import { GeminiAPIFormat } from "../adapters/gemini-api-format.js";
import type { ProviderTransport } from "../providers/transport/types.js";
import { ComposedHandler } from "./composed-handler.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function claudeRequest(model: string) {
  return {
    model,
    max_tokens: 16,
    system: "BASE-SYSTEM",
    messages: [
      { role: "user", content: "first" },
      { role: "system", content: [{ type: "text", text: "INLINE-SKILL-LIST" }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "system", content: "INLINE-MCP-INSTRUCTIONS" },
      { role: "user", content: "second" },
    ],
  };
}

function makeContext(): Context {
  return {
    req: { header: () => ({}) },
    header: () => {},
    body: (body: BodyInit | null, init?: ResponseInit) => new Response(body, init),
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), { status: status ?? 200 }),
  } as unknown as Context;
}

function transportNamed(name: string): ProviderTransport {
  return {
    name,
    displayName: name,
    streamFormat: "openai-sse",
    getEndpoint: () => "http://localhost/v1/chat/completions",
    getHeaders: async () => ({}),
  } as unknown as ProviderTransport;
}

/** Sends one request and returns the parsed body claudish put on the wire. */
async function sentBody(provider: string, model: string, options: object = {}): Promise<any> {
  const bodies: string[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({ error: { message: "stop" } }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const handler = new ComposedHandler(transportNamed(provider), model, model, 8080, options);
  await handler.handle(makeContext(), claudeRequest(model));
  expect(bodies.length).toBeGreaterThan(0);
  return JSON.parse(bodies[0]);
}

describe("inline system messages reach a foreign model, at their position", () => {
  test("Chat Completions: each text is in the user turn it followed", async () => {
    const body = await sentBody("sakana", "fugu-ultra");
    expect(body.messages.map((m: any) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    // The system prompt is unchanged: nothing is put in front of the conversation.
    expect(body.messages[0].content).toBe("BASE-SYSTEM");
    const first = JSON.stringify(body.messages[1].content);
    const second = JSON.stringify(body.messages[3].content);
    expect(first).toContain("first");
    expect(first).toContain("INLINE-SKILL-LIST");
    expect(second).toContain("INLINE-MCP-INSTRUCTIONS");
    expect(second).toContain("second");
    expect(second.indexOf("INLINE-MCP-INSTRUCTIONS")).toBeLessThan(second.indexOf("second"));
  });

  test("Gemini: the text is in contents, and systemInstruction holds only the base prompt", async () => {
    const body = await sentBody("antigravity", "gemini-4-carbon", {
      adapter: new GeminiAPIFormat("gemini-4-carbon"),
    });
    const system = body.systemInstruction.parts[0].text as string;
    expect(system).toContain("BASE-SYSTEM");
    expect(system).not.toContain("INLINE-");
    expect(body.contents.map((m: any) => m.role)).toEqual(["user", "model", "user"]);
    expect(JSON.stringify(body.contents[0])).toContain("INLINE-SKILL-LIST");
    expect(JSON.stringify(body.contents[2])).toContain("INLINE-MCP-INSTRUCTIONS");
  });

  test("Responses: the text is in input, and instructions hold only the base prompt", async () => {
    const body = await sentBody("openai-codex", "gpt-6.1-sol", {
      adapter: new CodexAPIFormat("gpt-6.1-sol"),
    });
    expect(body.instructions).toBe("BASE-SYSTEM");
    const input = JSON.stringify(body.input);
    expect(input).toContain("INLINE-SKILL-LIST");
    expect(input).toContain("INLINE-MCP-INSTRUCTIONS");
    expect(input.indexOf("INLINE-SKILL-LIST")).toBeLessThan(
      input.indexOf("INLINE-MCP-INSTRUCTIONS")
    );
  });

  test("Anthropic-shaped: the text is in messages, with no system entry left", async () => {
    const body = await sentBody("kimi-coding", "kimi-k3", {
      adapter: new AnthropicAPIFormat("kimi-k3"),
    });
    expect(body.system).toBe("BASE-SYSTEM");
    expect(body.messages.map((m: any) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(body.messages)).toContain("INLINE-SKILL-LIST");
    expect(JSON.stringify(body.messages)).toContain("INLINE-MCP-INSTRUCTIONS");
  });
});
