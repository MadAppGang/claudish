import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiskCacheV3 } from "../providers/all-models-cache.js";
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
  // Reset process-global state, then pin an empty catalog so these tests never
  // fall through to the developer's real disk cache.
  _resetCatalogClient();
  _setCatalogEntriesForTest(null);
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
      },
    ]);

    expect(() => advisorRouteFor("kimi-k3", "panel")).toThrow(/kimi-k3/);
  });

  it("resolves a bare served model to OpenRouter's published id", () => {
    _setCatalogEntriesForTest([
      {
        modelId: "grok-4.6",
        aliases: [],
        aggregators: [
          {
            sourceProviderId: "openrouter",
            sourceCollectorId: "test",
            confidence: "aggregator_reported",
            routeStatus: "mapped",
            route: { routeId: "openrouter", routeProfileId: "gateway" },
            externalModelId: "x-ai/grok-4.6",
          },
        ],
      },
    ]);

    expect(advisorRouteFor("grok-4.6", "panel").wireModel).toBe("x-ai/grok-4.6");
  });

  it("resolves a subscription prefix to the OpenRouter vendor id", () => {
    _setCatalogEntriesForTest([
      {
        modelId: "gpt-5.6-sol",
        aliases: [],
        aggregators: [
          {
            sourceProviderId: "openrouter",
            sourceCollectorId: "test",
            confidence: "aggregator_reported",
            routeStatus: "mapped",
            route: { routeId: "openrouter", routeProfileId: "gateway" },
            externalModelId: "openai/gpt-5.6-sol",
          },
        ],
      },
    ]);

    const route = advisorRouteFor("cx@gpt-5.6-sol", "panel");

    expect(route.kind).toBe("openrouter");
    expect(route.wireModel).toBe("openai/gpt-5.6-sol");
    expect(route.wireModel).not.toBe("openai-codex/gpt-5.6-sol");
    expect(route.wireModel).not.toBe("cx/gpt-5.6-sol");
  });
});

describe("advisor request wire routing", () => {
  const fixture: DiskCacheV3 = JSON.parse(
    readFileSync(
      new URL(
        "../test-fixtures/catalog-v3/wire-g-20261012101007285-7770c36e.json",
        import.meta.url
      ),
      "utf8"
    )
  );
  function capture(
    models: string[],
    collector: string | null = null,
    cache: DiskCacheV3 | null = fixture
  ) {
    const home = mkdtempSync(join(tmpdir(), "advisor-wire-"));
    try {
      if (cache) {
        mkdirSync(join(home, ".claudish"));
        writeFileSync(join(home, ".claudish/cloud-models-catalog-v3.json"), JSON.stringify(cache));
      }
      const child = Bun.spawnSync(
        [
          process.execPath,
          "--eval",
          `
        const { advisorRouteFor, runAdvisorCall } = await import(${JSON.stringify(new URL("./native-handler-advisor.ts", import.meta.url).pathname)});
        const models = ${JSON.stringify(models)}, collector = ${JSON.stringify(collector)};
        const routes = models.map(m => advisorRouteFor(m, "panel"));
        if (collector) routes.push(advisorRouteFor(collector, "collector"));
        const calls = [];
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async (url, init) => {
          calls.push({ url: String(url), method: init.method, headers: Object.fromEntries(new Headers(init.headers)), body: JSON.parse(init.body) });
          if (String(url).endsWith("/responses")) return Response.json({ output: [{ type: "reasoning", summary: [] }, { type: "message", content: [{ type: "output_text", text: "Responses advice" }] }] });
          if (String(url).includes(":generateContent")) return Response.json({ candidates: [{ content: { parts: [{ text: "Gemini advice" }] } }] });
          if (String(url).endsWith("/messages")) return Response.json({ content: [{type: "text", text: "Messages synthesis"}] });
          return Response.json({ choices: [{ message: { content: "Chat advice" } }] });
        };
        try {
          const outcome = await runAdvisorCall({ toolUseId: "wire-advisor", messages: [{role: "user", content: "Review this design"}], models, collector,
            apiKeys: { openai: "openai-fake", google: "google-fake", openrouter: "openrouter-fake", anthropic: "anthropic-fake" }, fetchImpl: globalThis.fetch, warn: () => {} });
          console.log(JSON.stringify({ routes, calls, outcome }));
        } finally { globalThis.fetch = originalFetch; }
      `,
        ],
        {
          env: {
            PATH: process.env.PATH,
            HOME: home,
            CLAUDISH_DISABLE_CATALOG_WARM: "1",
            CLAUDISH_DISABLE_KEYCHAIN: "1",
            CLAUDISH_DISABLE_OP: "1",
          },
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      expect(child.exitCode, child.stderr.toString()).toBe(0);
      return JSON.parse(child.stdout.toString());
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
  it("OpenAI panel follows Responses wire and extracts output_text", () => {
    const { routes, calls, outcome } = capture(["openai@gpt-6.1-sol"]);
    expect(routes[0]).toMatchObject({
      api: "responses",
      url: "https://api.openai.com/v1/responses",
      wire: { status: "known" },
    });
    const wire = routes[0].wire;
    const effort = wire.reasoning.effort;
    expect(typeof effort.default).toBe("string");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: routes[0].url,
      headers: { authorization: "Bearer openai-fake" },
      body: {
        stream: false,
        max_output_tokens: 2048,
        reasoning: { effort: effort.values[effort.default] },
      },
    });
    expect(calls[0].body.instructions).toBeString();
    expect(calls[0].body.input).toContainEqual({ role: "user", content: "Review this design" });
    expect(calls[0].body).not.toHaveProperty("messages");
    expect(calls[0].body).not.toHaveProperty("max_tokens");
    expect(outcome.result).toEqual({ text: "Responses advice", isError: false });
  });
  it("Google panel follows native Gemini wire and extracts candidate text", () => {
    const { routes, calls, outcome } = capture(["google@gemini-3.8-flash"]);
    expect(routes[0]).toMatchObject({
      api: "gemini",
      url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
      wire: { status: "known" },
    });
    expect(calls[0]).toMatchObject({
      url: routes[0].url,
      headers: { "x-goog-api-key": "google-fake" },
      body: { generationConfig: { maxOutputTokens: 2048 } },
    });
    expect(calls[0].body.systemInstruction.parts[0].text).toBeString();
    expect(calls[0].body.contents).toContainEqual({
      role: "user",
      parts: [{ text: "Review this design" }],
    });
    expect(calls[0].body).not.toHaveProperty("messages");
    expect(outcome.result).toEqual({ text: "Gemini advice", isError: false });
  });
  it("Anthropic collector uses Messages body, required limit and credential headers", () => {
    const { routes, calls, outcome } = capture(
      ["openai@gpt-6.1-sol", "google@gemini-3.8-flash"],
      "anthropic@claude-opus-5-5"
    );
    expect(routes[2]).toMatchObject({
      api: "anthropic-messages",
      url: "https://api.anthropic.com/v1/messages",
    });
    expect(calls).toHaveLength(3);
    expect(calls[2]).toMatchObject({
      url: routes[2].url,
      headers: { "x-api-key": "anthropic-fake", "anthropic-version": "2023-06-01" },
      body: { model: "claude-opus-5-5", max_tokens: 2048 },
    });
    expect(calls[2].body.system).toBeString();
    expect(calls[2].body.messages[0].content).toContain("Responses advice");
    expect(calls[2].body.messages[0].content).toContain("Gemini advice");
    expect(outcome.result).toEqual({ text: "Messages synthesis", isError: false });
  });
  it.each([
    ["openai@unpublished", "https://api.openai.com/v1/chat/completions"],
    [
      "google@unpublished",
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    ],
    ["openrouter@acme/unpublished", "https://openrouter.ai/api/v1/chat/completions"],
  ])("cold catalog uses documented chat endpoint for %s", (model, url) => {
    const { routes, calls, outcome } = capture([model!], null, null);
    expect(routes[0]).toMatchObject({ api: "chat-completions", url });
    expect(routes[0]).not.toHaveProperty("wire");
    expect(calls[0].body.messages).toBeArray();
    expect(calls[0].body).not.toHaveProperty("input");
    expect(outcome.result).toEqual({ text: "Chat advice", isError: false });
  });
});
