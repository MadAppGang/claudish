import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("advisor startup-chain routing", () => {
  const replay = JSON.parse(
    readFileSync(
      new URL("../test-fixtures/advisor/replay-results-1792535079405.json", import.meta.url),
      "utf8"
    )
  );
  const opus = replay.results.find(
    (result: any) => result.tier === "claude-opus-5-5" && result.shape === "A"
  );
  const haiku = replay.results.find(
    (result: any) => result.tier === "claude-haiku-5-5" && result.shape === "A"
  );
  const messages = [
    { role: "user", content: "Review this design" },
    { role: "assistant", content: "I will check the boundary." },
    { role: "user", content: "Include the earlier context." },
  ];

  function capture(models: string[], collector: string | null = null) {
    const home = mkdtempSync(join(tmpdir(), "advisor-routing-"));
    try {
      const child = Bun.spawnSync(
        [
          process.execPath,
          "--eval",
          `
        const originalFetch = globalThis.fetch;
        const networkCalls = [];
        globalThis.fetch = async (...args) => {
          networkCalls.push(String(args[0]));
          throw new Error("Unexpected network call");
        };
        try {
          const { runAdvisorCall } = await import(${JSON.stringify(new URL("./native-handler-advisor.ts", import.meta.url).pathname)});
          const { _setCatalogEntriesForTest } = await import(${JSON.stringify(new URL("../providers/catalog-client.ts", import.meta.url).pathname)});
          _setCatalogEntriesForTest(null);
          const models = ${JSON.stringify(models)}, collector = ${JSON.stringify(collector)};
          const opus = ${JSON.stringify(opus)}, haiku = ${JSON.stringify(haiku)};
          const message = result => ({
            model: result.ok.model,
            content: [{ type: "text", text: result.ok.text }],
            stop_reason: result.ok.stop_reason,
            usage: result.ok.usage,
          });
          const gatewayCalls = [], claudeCalls = [], plans = new Map();
          for (const [role, specs] of [["panel", models], ["collector", collector ? [collector] : []]]) {
            for (const spec of specs) {
              if (spec === "claude-opus-5-5") {
                plans.set(role + ":" + spec, { kind: "claude-native", spec, role, model: spec, expectedArm: "api-key" });
                continue;
              }
              const wireId = spec.slice(spec.indexOf("@") + 1);
              const provider = spec.slice(0, spec.indexOf("@"));
              const displayName = { openai: "OpenAI", google: "Google", openrouter: "OpenRouter", anthropic: "Anthropic" }[provider];
              plans.set(role + ":" + spec, {
                kind: "routed", spec, role,
                explanation: { requestedModel: spec, routedModel: wireId, source: "explicit", candidates: [], warnings: [], outcome: { kind: "ok" } },
                hops: [{ provider, displayName, modelSpec: spec, wireId, billing: "metered" }],
                invocationMode: "explicit-model",
              });
            }
          }
          let claudeAuthLookups = 0;
          const outcome = await runAdvisorCall({
            toolUseId: "routed-advisor", messages: ${JSON.stringify(messages)}, models, collector,
            gateway: {
              plan: (spec, role) => plans.get(role + ":" + spec),
              async call(request) {
                if (request.plan !== plans.get(request.plan.role + ":" + request.plan.spec)) throw new Error("Not the startup plan");
                gatewayCalls.push(structuredClone(request));
                const hop = request.plan.hops[0];
                const result = request.plan.spec.startsWith("google@") ? haiku : opus;
                return {
                  status: result.status, bodyText: JSON.stringify(message(result)), streamFailure: false, latencyMs: 1,
                  hops: [{ provider: hop.provider, wireModel: hop.wireId, arm: "api-key", billing: "metered", uid: hop.provider, displayName: hop.displayName }],
                };
              },
            },
            claude: {
              async resolveAuth() {
                claudeAuthLookups++;
                return { arm: "api-key", source: "ANTHROPIC_API_KEY", apiKey: "anthropic-fake", facts: {} };
              },
              async fetchImpl(input, init) {
                const request = input instanceof Request ? input : new Request(input, init);
                claudeCalls.push({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body: await request.json() });
                return Response.json(message(opus), { status: opus.status });
              },
            },
            warn: () => {},
          });
          console.log(JSON.stringify({ gatewayCalls, claudeCalls, claudeAuthLookups, networkCalls, outcome }));
        } finally { globalThis.fetch = originalFetch; }
      `,
        ],
        {
          cwd: home,
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
      const result = JSON.parse(child.stdout.toString());
      expect(result.networkCalls).toEqual([]);
      return result;
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  function expectPanelCall(call: any, spec: string) {
    expect(call.plan).toMatchObject({
      kind: "routed",
      spec,
      role: "panel",
      invocationMode: "explicit-model",
    });
    expect(call.timeoutMs).toBe(60_000);
    expect(Object.keys(call.payload).sort()).toEqual([
      "max_tokens",
      "messages",
      "model",
      "stream",
      "system",
    ]);
    expect(call.payload).toMatchObject({
      model: call.plan.hops[0].modelSpec,
      max_tokens: 2048,
      stream: false,
    });
    expect(call.payload.system).toBeString();
    expect(call.payload.system.length).toBeGreaterThan(0);
    expect(call.payload.messages.slice(0, messages.length)).toEqual(messages);
  }

  it("sends an OpenAI panel call through its startup chain and extracts translated advice", () => {
    const spec = "openai@gpt-6.1-sol";
    const { gatewayCalls, claudeCalls, claudeAuthLookups, outcome } = capture([spec]);
    expect(gatewayCalls).toHaveLength(1);
    expectPanelCall(gatewayCalls[0], spec);
    expect(claudeCalls).toEqual([]);
    expect(claudeAuthLookups).toBe(0);
    expect(outcome.result).toEqual({ text: opus.ok.text, isError: false });
    expect(outcome.panel[0]).toMatchObject({
      origin: "upstream",
      billing: "metered",
      hopsTried: ["openai"],
      servedBy: { provider: "openai", displayName: "OpenAI", arm: "api-key", billing: "metered" },
      recordRoute: { kind: "routed", plannedChain: ["OpenAI"] },
    });
  });

  it("sends a Google panel call through its startup chain without resolving Claude credentials", () => {
    const spec = "google@gemini-3.8-flash";
    const { gatewayCalls, claudeCalls, claudeAuthLookups, outcome } = capture([spec]);
    expect(gatewayCalls).toHaveLength(1);
    expectPanelCall(gatewayCalls[0], spec);
    expect(claudeCalls).toEqual([]);
    expect(claudeAuthLookups).toBe(0);
    expect(outcome.result).toEqual({ text: haiku.ok.text, isError: false });
  });

  it("uses the fixed Anthropic Messages endpoint for a bare Claude collector with both panel answers", () => {
    const models = ["openai@gpt-6.1-sol", "google@gemini-3.8-flash"];
    const { gatewayCalls, claudeCalls, claudeAuthLookups, outcome } = capture(
      models,
      "claude-opus-5-5"
    );
    expect(gatewayCalls).toHaveLength(2);
    for (const spec of models)
      expectPanelCall(
        gatewayCalls.find((call: any) => call.plan.spec === spec),
        spec
      );
    expect(claudeAuthLookups).toBe(1);
    expect(claudeCalls).toHaveLength(1);
    expect(claudeCalls[0]).toMatchObject({
      method: "POST",
      url: "https://api.anthropic.com/v1/messages",
      headers: { "x-api-key": "anthropic-fake", "anthropic-version": "2023-06-01" },
      body: { model: "claude-opus-5-5", max_tokens: 2048 },
    });
    expect(claudeCalls[0].headers).not.toHaveProperty("authorization");
    expect(claudeCalls[0].body.system).toBeString();
    expect(claudeCalls[0].body.messages[0].role).toBe("user");
    for (const spec of models) expect(claudeCalls[0].body.messages[0].content).toContain(spec);
    expect(claudeCalls[0].body.messages[0].content).toContain(opus.ok.text);
    expect(claudeCalls[0].body.messages[0].content).toContain(haiku.ok.text);
    expect(outcome.result).toEqual({ text: opus.ok.text, isError: false });
    expect(outcome.collectorOutcome).toMatchObject({
      recordRoute: { kind: "claude-native", host: "api.anthropic.com" },
      servedBy: { provider: "native-anthropic", arm: "api-key", billing: "metered" },
      credentialSource: "ANTHROPIC_API_KEY",
      billing: "metered",
    });
  });

  it.each(["openai@unpublished", "google@unpublished", "openrouter@acme/unpublished"])(
    "uses the startup chain for %s even with a cold cloud models catalog",
    (spec) => {
      const { gatewayCalls, claudeCalls, claudeAuthLookups, outcome } = capture([spec]);
      expect(gatewayCalls).toHaveLength(1);
      expectPanelCall(gatewayCalls[0], spec);
      expect(claudeCalls).toEqual([]);
      expect(claudeAuthLookups).toBe(0);
      expect(outcome.result).toEqual({
        text: spec.startsWith("google@") ? haiku.ok.text : opus.ok.text,
        isError: false,
      });
    }
  );

  it("keeps an explicit Anthropic collector on its routed chain, not the native Claude arm", () => {
    const collector = "anthropic@claude-opus-5-5";
    const { gatewayCalls, claudeCalls, claudeAuthLookups, outcome } = capture(
      ["openai@gpt-6.1-sol", "google@gemini-3.8-flash"],
      collector
    );
    expect(gatewayCalls).toHaveLength(3);
    const call = gatewayCalls.find((call: any) => call.plan.role === "collector");
    expect(call.plan.spec).toBe(collector);
    expect(call.timeoutMs).toBe(30_000);
    expect(call.payload.model).toBe(call.plan.hops[0].modelSpec);
    expect(Object.keys(call.payload).sort()).toEqual([
      "max_tokens",
      "messages",
      "model",
      "stream",
      "system",
    ]);
    expect(call.payload.messages[0].content).toContain(opus.ok.text);
    expect(call.payload.messages[0].content).toContain(haiku.ok.text);
    expect(claudeCalls).toEqual([]);
    expect(claudeAuthLookups).toBe(0);
    expect(outcome.result).toEqual({ text: opus.ok.text, isError: false });
  });
});
