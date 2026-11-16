import { afterEach, describe, expect, test } from "bun:test";
import type { Context } from "hono";
import { CodexAPIFormat } from "../adapters/codex-api-format.js";
import { GeminiAPIFormat } from "../adapters/gemini-api-format.js";
import type { ProviderTransport } from "../providers/transport/types.js";
import { ComposedHandler } from "./composed-handler.js";
import {
  ANTIGRAVITY_IDENTITY_HEAD,
  NEUTRAL_IDENTITY_HEAD,
} from "./shared/format/identity-filter.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

function claudeRequest(model: string) {
  return {
    model,
    max_tokens: 16,
    system: [
      { type: "text", text: IDENTITY },
      { type: "text", text: "Be brief." },
    ],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>Claude Code attached this.</system-reminder>" },
          { type: "text", text: "What is Claude Code?" },
        ],
      },
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

/** Sends one request and returns the body text claudish put on the wire. */
async function sentBody(provider: string, model: string, options: object = {}): Promise<string> {
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
  return bodies[0];
}

function systemTextOf(body: string): string {
  const parsed = JSON.parse(body);
  const fromMessages = parsed.messages?.find((m: any) => m.role === "system")?.content;
  return typeof fromMessages === "string" ? fromMessages : JSON.stringify(parsed);
}

describe("ComposedHandler removes Claude Code's identity before a foreign model", () => {
  test("a foreign model gets the neutral header and no Claude Code identity", async () => {
    const body = await sentBody("sakana", "fugu-ultra");
    const system = systemTextOf(body);
    expect(system.startsWith(NEUTRAL_IDENTITY_HEAD)).toBe(true);
    expect(body).not.toContain("Anthropic's official CLI");
    expect(body).not.toContain("You are NOT Claude");
    expect(body).toContain("Agent CLI attached this.");
    expect(body).toContain("What is Claude Code?");
  });

  test("the antigravity provider gets Antigravity's own identity header", async () => {
    const body = await sentBody("antigravity", "gemini-4-carbon");
    expect(body).toContain(JSON.stringify(ANTIGRAVITY_IDENTITY_HEAD).slice(1, -1));
    expect(body).not.toContain(NEUTRAL_IDENTITY_HEAD);
    expect(body).not.toContain("Anthropic's official CLI");
  });

  test("a real Claude model behind a gateway keeps Claude Code's identity", async () => {
    const body = await sentBody("sakana", "anthropic/claude-sonnet-5");
    expect(body).toContain(IDENTITY);
    expect(body).not.toContain(NEUTRAL_IDENTITY_HEAD);
    expect(body).toContain("Claude Code attached this.");
  });
});

// The adapters that once filtered identity themselves. The handler decides now,
// so each must give BOTH outcomes: scrubbed for a foreign model, kept for Claude.
describe("the identity decision holds on the Responses and Gemini adapters", () => {
  const codex = (model: string) => ({
    adapter: new CodexAPIFormat(model, undefined, { codexExtras: false }),
  });
  const gemini = (model: string) => ({ adapter: new GeminiAPIFormat(model) });

  test("Responses: a foreign model gets the neutral header", async () => {
    const body = JSON.parse(await sentBody("openai-codex", "gpt-6.1-sol", codex("gpt-6.1-sol")));
    expect(body.instructions.startsWith(NEUTRAL_IDENTITY_HEAD)).toBe(true);
    expect(body.instructions).not.toContain("Anthropic's official CLI");
  });

  test("Responses: a real Claude model keeps Claude Code's identity", async () => {
    const body = JSON.parse(await sentBody("sakana", "claude-sonnet-5", codex("claude-sonnet-5")));
    expect(body.instructions).toContain(IDENTITY);
    expect(body.instructions).not.toContain(NEUTRAL_IDENTITY_HEAD);
  });

  test("Gemini: a foreign model on antigravity gets Antigravity's header", async () => {
    const body = JSON.parse(
      await sentBody("antigravity", "gemini-4-carbon", gemini("gemini-4-carbon"))
    );
    const system = body.systemInstruction.parts[0].text as string;
    expect(system.startsWith(ANTIGRAVITY_IDENTITY_HEAD)).toBe(true);
    expect(system).not.toContain("Anthropic's official CLI");
  });

  test("Gemini: a real Claude model on antigravity keeps Claude Code's identity", async () => {
    const body = JSON.parse(
      await sentBody("antigravity", "claude-sonnet-5", gemini("claude-sonnet-5"))
    );
    const system = body.systemInstruction.parts[0].text as string;
    expect(system).toContain(IDENTITY);
    expect(system).not.toContain(ANTIGRAVITY_IDENTITY_HEAD);
  });
});
