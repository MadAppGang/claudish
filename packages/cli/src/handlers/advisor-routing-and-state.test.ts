import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { _resetCatalogClient, _setCatalogEntriesForTest } from "../providers/catalog-client.js";
import {
  ADVISOR_STUB_PATHS,
  _debug_resetTrackedAdvisorIds,
  advisorRouteFor,
  findPendingAdvisorToolResults,
  getAdvisorCall,
  markAdvisorCallConsumed,
  recordAdvisorEventsFromResponseBody,
  rewriteAdvisorToolResults,
  runAdvisorCall,
} from "./native-handler-advisor.js";

const cfg = { enabled: true, logPath: undefined };

function recordAdvisorCall(toolUseId: string, sessionId?: string): void {
  recordAdvisorEventsFromResponseBody(
    cfg,
    {
      content: [{ type: "tool_use", name: "advisor", id: toolUseId, input: {} }],
    },
    sessionId
  );
}

function advisorResultPayload(toolUseId: string): Record<string, unknown> {
  return {
    messages: [
      { role: "user", content: "Review this design." },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: toolUseId, name: "advisor", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            is_error: true,
            content: "<tool_use_error>Error: No such tool available: advisor</tool_use_error>",
          },
        ],
      },
    ],
  };
}

function resultBlock(payload: Record<string, unknown>): any {
  return ((payload.messages as any[])[2].content as any[])[0];
}

afterEach(() => {
  _debug_resetTrackedAdvisorIds();
});

beforeEach(() => {
  _resetCatalogClient();
});

afterEach(() => {
  // `null` is a sticky empty-catalog override, not a reset between tests.
  _resetCatalogClient();
});

describe("advisorRouteFor", () => {
  it("routes OpenAI, Google, OpenRouter, and Anthropic models with provider credentials", () => {
    const openai = advisorRouteFor("gpt-5.6-sol", "panel");
    const google = advisorRouteFor("gemini-3.8-flash", "panel");
    const openrouter = advisorRouteFor("grok-4.6", "panel");
    const anthropic = advisorRouteFor("haiku", "collector");

    expect(openai.kind).toBe("openai");
    expect(openai.host).toBe("api.openai.com");
    expect(google.kind).toBe("google");
    expect(openrouter.kind).toBe("openrouter");
    expect(typeof openrouter.wireModel).toBe("string");
    expect(openrouter.wireModel).toContain("grok-4.6");
    expect(openrouter.wireModel).not.toContain("{");
    expect(openrouter.wireModel).not.toContain("resolvedId");
    expect(anthropic.kind).toBe("anthropic");

    expect(openai.credential).toBe("openai");
    expect(google.credential).toBe("google");
    expect(openrouter.credential).toBe("openrouter");
    expect(new Set([openai.credential, google.credential, openrouter.credential]).size).toBe(3);
  });
});

describe("session-keyed pending advisor state", () => {
  it("isolates calls by session and retains consumed entries", () => {
    const sessionId = "advisor-state-session-s1-001";
    const otherSessionId = "advisor-state-session-s2-001";
    const toolUseId = "toolu_advisor_state_001";

    recordAdvisorCall(toolUseId, sessionId);

    expect(getAdvisorCall(toolUseId, sessionId)?.toolUseId).toBe(toolUseId);
    expect(getAdvisorCall(toolUseId, otherSessionId)).toBeUndefined();

    const delivered = { text: "Retained advisor result", isError: false };
    expect(markAdvisorCallConsumed(toolUseId, delivered, sessionId)).toBe(true);
    expect(getAdvisorCall(toolUseId, sessionId)?.result).toEqual(delivered);
  });

  it("adopts a no-session call into the first known session", () => {
    const firstSessionId = "advisor-adopt-session-s1-002";
    const secondSessionId = "advisor-adopt-session-s2-002";
    const toolUseId = "toolu_advisor_adopt_002";

    recordAdvisorCall(toolUseId);
    const payload = advisorResultPayload(toolUseId);

    expect(findPendingAdvisorToolResults(payload, firstSessionId)).toEqual([toolUseId]);
    expect(
      markAdvisorCallConsumed(
        toolUseId,
        { text: "Adopted advisor result", isError: false },
        firstSessionId
      )
    ).toBe(true);
    expect(getAdvisorCall(toolUseId, firstSessionId)?.sessionKey).toBe(firstSessionId);
    expect(findPendingAdvisorToolResults(payload, secondSessionId)).toEqual([]);
  });
});

describe("rewriteAdvisorToolResults", () => {
  it("propagates an AdvisorToolResult error flag and text", () => {
    const sessionId = "advisor-rewrite-error-session-003";
    const toolUseId = "toolu_advisor_rewrite_error_003";
    recordAdvisorCall(toolUseId, sessionId);
    const payload = advisorResultPayload(toolUseId);

    expect(
      rewriteAdvisorToolResults(
        payload,
        () => ({ text: "Advisor upstream failed", isError: true }),
        sessionId
      )
    ).toEqual([toolUseId]);
    expect(resultBlock(payload).is_error).toBe(true);
    expect(resultBlock(payload).content).toEqual([
      { type: "text", text: "Advisor upstream failed" },
    ]);
  });

  it("clears the error flag for a backward-compatible string replacement", () => {
    const sessionId = "advisor-rewrite-string-session-004";
    const toolUseId = "toolu_advisor_rewrite_string_004";
    recordAdvisorCall(toolUseId, sessionId);
    const payload = advisorResultPayload(toolUseId);

    expect(rewriteAdvisorToolResults(payload, () => "Plain advisor text", sessionId)).toEqual([
      toolUseId,
    ]);
    expect(resultBlock(payload).is_error).toBe(false);
    expect(resultBlock(payload).content).toEqual([{ type: "text", text: "Plain advisor text" }]);
  });

  it("leaves an unrecorded tool_result unchanged", () => {
    const sessionId = "advisor-rewrite-unknown-session-005";
    const toolUseId = "toolu_advisor_rewrite_unknown_005";
    const payload = advisorResultPayload(toolUseId);
    const before = structuredClone(resultBlock(payload));

    expect(rewriteAdvisorToolResults(payload, () => "Must not be used", sessionId)).toEqual([]);
    expect(resultBlock(payload)).toEqual(before);
  });
});

describe("ADVISOR_STUB_PATHS", () => {
  it("names each distinct stub path from S1 through S10", () => {
    const values: string[] = Object.values(ADVISOR_STUB_PATHS);

    expect(values).toHaveLength(10);
    expect(new Set(values).size).toBe(10);
    expect([...values].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))).toEqual(
      Array.from({ length: 10 }, (_, index) => `S${index + 1}`)
    );
  });
});

describe("OpenRouter advisor wire-model resolution", () => {
  it("refuses a known model that only publishes another vendor's external id", () => {
    _setCatalogEntriesForTest([
      {
        modelId: "kimi-k3",
        aliases: [],
        sources: {
          "fireworks-api": { externalId: "accounts/fireworks/models/kimi-k3" },
        },
      },
    ]);

    expect(() => advisorRouteFor("kimi-k3", "panel")).toThrow(/kimi-k3/);
  });

  it("resolves a bare served model to OpenRouter's published id", () => {
    _setCatalogEntriesForTest([
      {
        modelId: "grok-4.6",
        aliases: [],
        sources: { "openrouter-api": { externalId: "x-ai/grok-4.6" } },
      },
    ]);

    expect(advisorRouteFor("grok-4.6", "panel").wireModel).toBe("x-ai/grok-4.6");
  });

  it("resolves a subscription prefix to the OpenRouter vendor id", () => {
    _setCatalogEntriesForTest([
      {
        modelId: "gpt-5.6-sol",
        aliases: [],
        sources: { "openrouter-api": { externalId: "openai/gpt-5.6-sol" } },
      },
    ]);

    const route = advisorRouteFor("cx@gpt-5.6-sol", "panel");

    expect(route.kind).toBe("openrouter");
    expect(route.wireModel).toBe("openai/gpt-5.6-sol");
    expect(route.wireModel).not.toBe("openai-codex/gpt-5.6-sol");
    expect(route.wireModel).not.toBe("cx/gpt-5.6-sol");
  });
});

describe("advisor request token parameter routing", () => {
  const messages = [{ role: "user", content: "Review this fixture." }];
  const apiKeys = {
    openai: "test-openai-key",
    openrouter: "test-openrouter-key",
    google: "test-google-key",
  };

  async function captureRequest(
    model: string
  ): Promise<{ url: URL; body: Record<string, unknown> }> {
    let capturedInput: RequestInfo | URL | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchImpl = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedInput = input;
        capturedInit = init;
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      { preconnect(_url: string | URL): void {} }
    ) as typeof fetch;

    await runAdvisorCall({
      toolUseId: `advisor-token-param-${model}`,
      messages,
      models: [model],
      collector: null,
      apiKeys,
      fetchImpl,
      warn: () => {},
    });

    if (capturedInput === undefined || capturedInit?.body === undefined) {
      throw new Error(`Expected ${model} to issue an advisor request`);
    }
    return {
      url: new URL(String(capturedInput)),
      body: JSON.parse(String(capturedInit.body)) as Record<string, unknown>,
    };
  }

  it("uses max_completion_tokens on the direct OpenAI route", async () => {
    const request = await captureRequest("openai@some-model");

    expect(request.url.host).toBe("api.openai.com");
    expect(request.body).toHaveProperty("max_completion_tokens");
    expect(request.body).not.toHaveProperty("max_tokens");
  });

  it("uses max_tokens on the OpenRouter route", async () => {
    const request = await captureRequest("openrouter@acme/some-model");

    expect(request.url.host).toBe("openrouter.ai");
    expect(request.body).toHaveProperty("max_tokens");
    expect(request.body).not.toHaveProperty("max_completion_tokens");
  });

  it("uses max_tokens on the direct Google route", async () => {
    const request = await captureRequest("google@gemini-fixture");

    expect(request.url.host).toBe("generativelanguage.googleapis.com");
    expect(request.body).toHaveProperty("max_tokens");
    expect(request.body).not.toHaveProperty("max_completion_tokens");
  });
});
