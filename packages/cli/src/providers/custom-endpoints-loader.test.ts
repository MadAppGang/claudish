/**
 * Tests for custom-endpoints-loader.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { ClaudishProfileConfig } from "../profile-config.js";
import type { ProfileContext } from "./provider-profiles.js";
import {
  loadCustomEndpoints,
  resolveCustomEndpointApiKey,
} from "./custom-endpoints-loader.js";
import {
  clearRuntimeRegistry,
  getRuntimeProviders,
  getRuntimeProfiles,
} from "./runtime-providers.js";

// Minimal ClaudishProfileConfig stub — only the fields the loader reads.
function makeConfig(
  customEndpoints?: Record<string, unknown>
): ClaudishProfileConfig {
  return {
    version: "1.0.0",
    defaultProfile: "default",
    profiles: {},
    customEndpoints,
  } as ClaudishProfileConfig;
}

describe("custom-endpoints-loader", () => {
  beforeEach(() => {
    clearRuntimeRegistry();
  });

  test("empty config: returns 0 registered, 0 errors, registry stays empty", () => {
    const result = loadCustomEndpoints(makeConfig());
    expect(result.registered).toBe(0);
    expect(result.errors).toEqual([]);
    expect(getRuntimeProviders().size).toBe(0);
    expect(getRuntimeProfiles().size).toBe(0);
  });

  test("valid simple endpoint: registers and is retrievable", () => {
    const result = loadCustomEndpoints(
      makeConfig({
        "my-vllm": {
          kind: "simple",
          url: "http://gpu-box:8000/v1",
          format: "openai",
          apiKey: "none",
        },
      })
    );

    expect(result.registered).toBe(1);
    expect(result.errors).toEqual([]);

    const def = getRuntimeProviders().get("my-vllm");
    expect(def).toBeDefined();
    expect(def?.name).toBe("my-vllm");
    expect(def?.transport).toBe("openai");
    expect(def?.baseUrl).toBe("http://gpu-box:8000/v1");
    expect(def?.isDirectApi).toBe(true);

    expect(getRuntimeProfiles().get("my-vllm")).toBeDefined();
  });

  test("valid complex endpoint with litellm transport: registers", () => {
    const result = loadCustomEndpoints(
      makeConfig({
        "work-litellm": {
          kind: "complex",
          displayName: "Work LiteLLM",
          transport: "litellm",
          baseUrl: "https://litellm.corp.example.com",
          apiPath: "/v1/chat/completions",
          apiKey: "sk-fake-key",
        },
      })
    );

    expect(result.registered).toBe(1);
    expect(result.errors).toEqual([]);

    const def = getRuntimeProviders().get("work-litellm");
    expect(def).toBeDefined();
    expect(def?.displayName).toBe("Work LiteLLM");
    expect(def?.transport).toBe("litellm");
    expect(def?.baseUrl).toBe("https://litellm.corp.example.com");
    expect(def?.apiPath).toBe("/v1/chat/completions");
  });

  test("invalid simple (missing url): not registered, error reported", () => {
    const result = loadCustomEndpoints(
      makeConfig({
        broken: {
          kind: "simple",
          format: "openai",
          apiKey: "none",
          // missing url
        },
      })
    );

    expect(result.registered).toBe(0);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].name).toBe("broken");
    expect(result.errors[0].message.length).toBeGreaterThan(0);
    expect(getRuntimeProviders().size).toBe(0);
  });

  test("invalid simple (bad URL): not registered, error reported", () => {
    const result = loadCustomEndpoints(
      makeConfig({
        bad: {
          kind: "simple",
          url: "not-a-url",
          format: "openai",
          apiKey: "none",
        },
      })
    );

    expect(result.registered).toBe(0);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].name).toBe("bad");
    expect(getRuntimeProviders().size).toBe(0);
  });

  test("mix of valid and invalid: valid ones are registered, invalid are reported", () => {
    const result = loadCustomEndpoints(
      makeConfig({
        good1: {
          kind: "simple",
          url: "https://api.example.com/v1",
          format: "openai",
          apiKey: "k1",
        },
        bad: {
          kind: "simple",
          url: "not-a-url",
          format: "openai",
          apiKey: "k2",
        },
        good2: {
          kind: "complex",
          displayName: "Second",
          transport: "openai",
          baseUrl: "https://other.example.com",
          apiKey: "k3",
        },
      })
    );

    expect(result.registered).toBe(2);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].name).toBe("bad");

    expect(getRuntimeProviders().get("good1")).toBeDefined();
    expect(getRuntimeProviders().get("good2")).toBeDefined();
    expect(getRuntimeProviders().get("bad")).toBeUndefined();
  });

  describe("resolveCustomEndpointApiKey env var expansion", () => {
    const ORIGINAL_ENV = process.env.TEST_LOADER_KEY;

    afterEach(() => {
      if (ORIGINAL_ENV === undefined) {
        delete process.env.TEST_LOADER_KEY;
      } else {
        process.env.TEST_LOADER_KEY = ORIGINAL_ENV;
      }
    });

    test("${VAR} expansion: returns env value when var is set", () => {
      process.env.TEST_LOADER_KEY = "resolved-secret";
      const resolved = resolveCustomEndpointApiKey({
        kind: "complex",
        displayName: "X",
        transport: "litellm",
        baseUrl: "https://x.example.com",
        apiKey: "${TEST_LOADER_KEY}",
      });
      expect(resolved).toBe("resolved-secret");
    });

    test("literal apiKey (no ${...}): returns as-is", () => {
      const resolved = resolveCustomEndpointApiKey({
        kind: "simple",
        url: "https://x.example.com/v1",
        format: "openai",
        apiKey: "literal-value",
      });
      expect(resolved).toBe("literal-value");
    });
  });

  test("idempotent re-registration: calling twice does not double-register", () => {
    const config = makeConfig({
      ep: {
        kind: "simple",
        url: "https://api.example.com/v1",
        format: "openai",
        apiKey: "k1",
      },
    });

    const first = loadCustomEndpoints(config);
    expect(first.registered).toBe(1);
    expect(getRuntimeProviders().size).toBe(1);

    const second = loadCustomEndpoints(config);
    expect(second.registered).toBe(1); // still 1 per call
    // The Map stays size 1 because keys overwrite
    expect(getRuntimeProviders().size).toBe(1);
  });

  describe("complex endpoint streamFormat plumbing", () => {
    // Regression: an Anthropic-compatible endpoint serving a Qwen-named model
    // hits QwenModelDialect (which inherits openai-sse from BaseAPIFormat).
    // The wire is anthropic-sse. streamFormat on the endpoint config must
    // win over the dialect's default — otherwise the parser is wrong and the
    // probe reports "not found".
    function makeCtx(modelName: string): ProfileContext {
      return {
        provider: {
          name: "qwen-token-plan",
          baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic",
          apiPath: "/v1/messages",
          apiKeyEnvVar: "CUSTOM_QWEN_TOKEN_PLAN_KEY",
          prefixes: ["qwen-token-plan"],
          authScheme: "x-api-key",
        },
        modelName,
        targetModel: modelName,
        port: 3000,
        apiKey: "sk-test",
        sharedOpts: {},
      };
    }

    test("anthropic-transport + streamFormat=anthropic-sse: propages to transport.overrideStreamFormat()", () => {
      loadCustomEndpoints(
        makeConfig({
          "qwen-token-plan": {
            kind: "complex",
            displayName: "Qwen Cloud Token Plan",
            transport: "anthropic",
            baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic",
            apiKey: "sk-test",
            streamFormat: "anthropic-sse",
            headers: { "anthropic-version": "2023-06-01" },
          },
        })
      );

      const profile = getRuntimeProfiles().get("qwen-token-plan");
      expect(profile).toBeDefined();
      const handler = profile!.createHandler(makeCtx("qwen3.8-max"))!;
      expect(handler).toBeDefined();
      // ComposedHandler stores the transport on a private `provider` field.
      // Tap into overrideStreamFormat via that field.
      const transport = (handler as any).provider;
      expect(transport).toBeDefined();
      expect(transport.overrideStreamFormat?.()).toBe("anthropic-sse");
    });

    test("openai-transport + streamFormat=openai-sse: propagates to transport.overrideStreamFormat()", () => {
      loadCustomEndpoints(
        makeConfig({
          "op-aggregate": {
            kind: "complex",
            displayName: "OpenAI Aggregate",
            transport: "openai",
            baseUrl: "https://agg.example.com/v1",
            apiKey: "k",
            streamFormat: "openai-sse",
          },
        })
      );

      const profile = getRuntimeProfiles().get("op-aggregate");
      const handler = profile!.createHandler(makeCtx("qwen3.8-max"))!;
      const transport = (handler as any).provider;
      expect(transport.overrideStreamFormat?.()).toBe("openai-sse");
    });

    test("no streamFormat set: transport falls back to dialect default (no override)", () => {
      loadCustomEndpoints(
        makeConfig({
          "no-stream": {
            kind: "complex",
            displayName: "Plain",
            transport: "anthropic",
            baseUrl: "https://plain.example.com",
            apiKey: "k",
          },
        })
      );

      const profile = getRuntimeProfiles().get("no-stream");
      const handler = profile!.createHandler(makeCtx("claude-test"))!;
      const transport = (handler as any).provider;
      // No override set — returns undefined, the parser falls back to the
      // dialect's inherited streamFormat (the historical behavior).
      expect(transport.overrideStreamFormat?.()).toBeUndefined();
    });
  });

  describe("omitReasoningContent plumbing", () => {
    // Regression (2026-08-20 cluster outage): Mistral rejects any history
    // carrying reasoning_content with HTTP 422 extra_forbidden. Promoted to
    // step 0 of the sonnet cascade while GLM was walled, it failed 28 of 32
    // requests and stalled the fleet. The flag must reach ComposedHandler.
    function makeCtx(modelName: string): ProfileContext {
      return {
        provider: {
          name: "mistral",
          baseUrl: "https://api.mistral.ai",
          apiPath: "/v1/chat/completions",
          apiKeyEnvVar: "CUSTOM_MISTRAL_KEY",
          prefixes: ["mistral"],
          authScheme: "bearer",
        },
        modelName,
        targetModel: modelName,
        port: 3000,
        apiKey: "sk-test",
        sharedOpts: {},
      };
    }

    test("complex openai endpoint: omitReasoningContent reaches ComposedHandler options", () => {
      loadCustomEndpoints(
        makeConfig({
          mistral: {
            kind: "complex",
            displayName: "Mistral La Plateforme",
            transport: "openai",
            baseUrl: "https://api.mistral.ai",
            apiPath: "/v1/chat/completions",
            apiKey: "k",
            streamFormat: "openai-sse",
            omitReasoningContent: true,
          },
        })
      );

      const handler = getRuntimeProfiles()
        .get("mistral")!
        .createHandler(makeCtx("zai-glm-5-2"))!;
      expect((handler as any).options.omitReasoningContent).toBe(true);
    });

    test("simple openai endpoint: omitReasoningContent reaches ComposedHandler options", () => {
      loadCustomEndpoints(
        makeConfig({
          strict: {
            kind: "simple",
            url: "https://strict.example.com/v1",
            format: "openai",
            apiKey: "k",
            omitReasoningContent: true,
          },
        })
      );

      const handler = getRuntimeProfiles()
        .get("strict")!
        .createHandler(makeCtx("some-model"))!;
      expect((handler as any).options.omitReasoningContent).toBe(true);
    });

    test("omitted: option stays undefined — no existing endpoint changes behavior", () => {
      loadCustomEndpoints(
        makeConfig({
          lenient: {
            kind: "complex",
            displayName: "Lenient",
            transport: "openai",
            baseUrl: "https://lenient.example.com",
            apiKey: "k",
          },
        })
      );

      const handler = getRuntimeProfiles()
        .get("lenient")!
        .createHandler(makeCtx("some-model"))!;
      expect((handler as any).options.omitReasoningContent).toBeUndefined();
    });
  });
});
