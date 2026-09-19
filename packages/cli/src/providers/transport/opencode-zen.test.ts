// REGRESSION: OpenCode Zen Go 400 MissingSessionID — no x-opencode-session header — Fixed in /dev:fix session dev-fix-20260912-213141-f1fb0c1c
import { describe, expect, test } from "bun:test";
import { getProviderByName, toRemoteProvider } from "../provider-definitions.js";
import { openCodeZenProfile } from "../provider-profiles.js";
import { conversationKey } from "./conversation-key.js";
import { OpenAICodexTransport } from "./openai-codex.js";
import { OpenCodeZenMessagesTransport, OpenCodeZenTransport } from "./opencode-zen.js";

const DEVICE_ID = "073c1234567890abcdef1234567890ab";
const SESSION_ID_A = "ce7d2f89-90c2-4a15-93ed-f2c41b531111";
const SESSION_ID_B = "ce7d2f89-90c2-4a15-93ed-f2c41b532222";

function requestFor(sessionId: string) {
  return {
    model: "claude-sonnet-4-5",
    max_tokens: 16,
    messages: [{ role: "user", content: "hi" }],
    metadata: {
      user_id: JSON.stringify({
        device_id: DEVICE_ID,
        account_uuid: "",
        session_id: sessionId,
      }),
    },
  };
}

function remoteProvider(name: string) {
  const definition = getProviderByName(name);
  if (!definition) throw new Error(`Missing provider fixture: ${name}`);
  return toRemoteProvider(definition);
}

describe("conversationKey", () => {
  test("is stable, opaque, and scoped to the captured Claude Code session id", () => {
    const requestA = requestFor(SESSION_ID_A);
    const requestB = requestFor(SESSION_ID_B);

    const keyA = conversationKey(requestA);
    expect(keyA).toMatch(/^claudish_[0-9a-f]{32}$/);
    expect(conversationKey(requestA)).toBe(keyA);
    expect(conversationKey(requestB)).not.toBe(keyA);
    expect(keyA).not.toContain(SESSION_ID_A);
    expect(keyA).not.toContain(DEVICE_ID);
  });

  test("uses one process-stable fallback for missing and non-JSON metadata", () => {
    const missingMetadata = { model: "claude-sonnet-4-5" };
    const nonJsonUserId = { metadata: { user_id: "not-json" } };

    const fallback = conversationKey(missingMetadata);
    expect(fallback).toMatch(/^claudish_[0-9a-f]{32}$/);
    expect(conversationKey(missingMetadata)).toBe(fallback);
    expect(conversationKey(nonJsonUserId)).toBe(fallback);
  });

  test("is byte-identical to OpenAI Codex prompt_cache_key for the same request", () => {
    const request = requestFor(SESSION_ID_A);
    const transport = new OpenAICodexTransport(
      remoteProvider("openai-codex"),
      "gpt-5.4",
      "test-key"
    );

    const payload = transport.transformPayload({ model: "gpt-5.4" }, request) as {
      prompt_cache_key?: string;
    };
    expect(payload.prompt_cache_key).toBe(conversationKey(request));
  });
});

describe("OpenCodeZenTransport", () => {
  test("adds client identity headers without replacing base authorization", async () => {
    const request = requestFor(SESSION_ID_A);
    const transport = new OpenCodeZenTransport(
      remoteProvider("opencode-zen-go"),
      "minimax-m3",
      "zen-key"
    );

    const headers = await transport.getHeaders(request);
    expect(headers.Authorization).toBe("Bearer zen-key");
    expect(headers["User-Agent"]).toMatch(/^claudish\/\d+\.\d+\.\d+$/);
    expect(headers["x-opencode-session"]).toBe(conversationKey(request));
  });

  test("lets provider-defined identity headers override generated values", async () => {
    const provider = {
      ...remoteProvider("opencode-zen-go"),
      headers: {
        "User-Agent": "pinned",
        "x-opencode-session": "pinned-session",
      },
    };
    const transport = new OpenCodeZenTransport(provider, "minimax-m3", "zen-key");

    const headers = await transport.getHeaders(requestFor(SESSION_ID_A));
    expect(headers).toMatchObject({
      Authorization: "Bearer zen-key",
      "User-Agent": "pinned",
      "x-opencode-session": "pinned-session",
    });
  });

  test("derives each header from its request rather than transport instance state", async () => {
    const transport = new OpenCodeZenTransport(
      remoteProvider("opencode-zen-go"),
      "minimax-m3",
      "zen-key"
    );

    const [headersA, headersB] = await Promise.all([
      transport.getHeaders(requestFor(SESSION_ID_A)),
      transport.getHeaders(requestFor(SESSION_ID_B)),
    ]);
    expect(headersA["x-opencode-session"]).not.toBe(headersB["x-opencode-session"]);
  });
});

describe("OpenCodeZenMessagesTransport", () => {
  test("signs Messages with the product key and scopes the session header", async () => {
    const provider = {
      ...remoteProvider("opencode-zen-go"),
      apiPath: "/v1/messages",
      authScheme: "x-api-key" as const,
    };
    const transport = new OpenCodeZenMessagesTransport(provider, "go-key");
    const request = requestFor(SESSION_ID_A);
    const headers = await transport.getHeaders(request);
    expect(transport.getEndpoint()).toBe("https://opencode.ai/zen/go/v1/messages");
    expect(headers.Authorization).toBeUndefined();
    expect(headers["x-api-key"]).toBe("go-key");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["User-Agent"]).toMatch(/^claudish\/\d+\.\d+\.\d+$/);
    expect(headers["x-opencode-session"]).toBe(conversationKey(request));
    expect((await transport.getHeaders(requestFor(SESSION_ID_B)))["x-opencode-session"]).not.toBe(
      headers["x-opencode-session"]
    );
  });
});

describe("openCodeZenProfile", () => {
  for (const providerName of ["opencode-zen-go", "opencode-zen"] as const) {
    for (const modelName of ["minimax-m3", "gpt-5.4", "qwen3.7-plus"] as const) {
      test(`${providerName} ${modelName} uses the matching transport`, () => {
        const provider = remoteProvider(providerName);
        const handler = openCodeZenProfile.createHandler({
          provider,
          modelName,
          apiKey: "zen-key",
          targetModel: modelName,
          port: 1234,
          sharedOpts: {},
        } as any);

        const messages =
          modelName.startsWith("qwen") ||
          (providerName === "opencode-zen-go" && modelName.startsWith("minimax"));
        expect((handler as any).provider).toBeInstanceOf(
          messages ? OpenCodeZenMessagesTransport : OpenCodeZenTransport
        );
      });
    }
  }
});
