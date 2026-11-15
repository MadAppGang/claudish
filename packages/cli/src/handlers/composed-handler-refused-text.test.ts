// End to end through the handler: the body claudish sends to Antigravity holds
// no security paragraph of Claude Code's system prompt, for a foreign model and
// for a Claude model alike, and every other provider's body still holds it.
import { afterEach, describe, expect, test } from "bun:test";
import type { Context } from "hono";
import type { ProviderTransport } from "../providers/transport/types.js";
import { ComposedHandler } from "./composed-handler.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const SECURITY =
  "IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.";
const KEPT = "MARKER-KEPT-RULE: prefer the dedicated file tools.";

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

async function run(providerName: string, model: string) {
  const { transport, sentBodies } = geminiTransport(providerName);
  const handler = new ComposedHandler(transport, model, model, 8080, {});
  const res = await handler.handle(makeContext(), {
    model,
    max_tokens: 64,
    stream: true,
    system: [
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
      { type: "text", text: `${SECURITY}\n\n${KEPT}` },
    ],
    messages: [{ role: "user", content: "hello" }],
  });
  await res.body?.getReader().read();
  return sentBodies[0] ?? "";
}

describe("system-prompt text the provider's server refuses", () => {
  test("antigravity: the security paragraph is not sent, the next rule is", async () => {
    const body = await run("antigravity", "gemini-4-argon");
    expect(body).not.toContain("C2 frameworks");
    expect(body).not.toContain("Assist with authorized security testing");
    expect(body).toContain(KEPT);
  });

  test("antigravity serving a Claude model: the paragraph is not sent either", async () => {
    const body = await run("antigravity", "claude-opus-5-5");
    expect(body).not.toContain("C2 frameworks");
    expect(body).toContain(KEPT);
  });

  test("another provider: the paragraph is sent", async () => {
    const body = await run("gemini", "gemini-4-argon");
    expect(body).toContain("C2 frameworks");
    expect(body).toContain(KEPT);
  });
});
