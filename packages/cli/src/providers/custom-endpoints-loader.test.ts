/**
 * Tests for custom-endpoints-loader.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { ClaudishProfileConfig } from "../profile-config.js";
import {
  loadCustomEndpoints,
  resolveCustomEndpointApiKey,
} from "./custom-endpoints-loader.js";
import {
  clearRuntimeRegistry,
  getRuntimeProviders,
  getRuntimeProfiles,
} from "./runtime-providers.js";
import { resolveModelProvider } from "./provider-resolver.js";
import { toRemoteProvider } from "./provider-definitions.js";

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
    expect(def?.apiKeyEnvVar).toBe("");
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
    expect(def?.apiKeyEnvVar).toBe("");
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

  test("custom endpoint apiKey satisfies resolver without synthetic env var", () => {
    const original = process.env.CUSTOM_MY_VLLM_KEY;
    delete process.env.CUSTOM_MY_VLLM_KEY;

    try {
      const result = loadCustomEndpoints(
        makeConfig({
          "my-vllm": {
            kind: "simple",
            url: "https://api.example.com/v1",
            format: "openai",
            apiKey: "stored-key",
          },
        })
      );

      expect(result.registered).toBe(1);
      const resolution = resolveModelProvider("my-vllm@llama-3");
      expect(resolution.category).toBe("direct-api");
      expect(resolution.requiredApiKeyEnvVar).toBeNull();
      expect(resolution.apiKeyAvailable).toBe(true);
    } finally {
      if (original === undefined) {
        delete process.env.CUSTOM_MY_VLLM_KEY;
      } else {
        process.env.CUSTOM_MY_VLLM_KEY = original;
      }
    }
  });

  test("custom endpoint models restrict handler creation", () => {
    const result = loadCustomEndpoints(
      makeConfig({
        limited: {
          kind: "simple",
          url: "https://api.example.com/v1",
          format: "openai",
          apiKey: "stored-key",
          models: ["allowed-model"],
        },
      })
    );

    expect(result.registered).toBe(1);
    const def = getRuntimeProviders().get("limited");
    const profile = getRuntimeProfiles().get("limited");
    expect(def).toBeDefined();
    expect(profile).toBeDefined();

    const provider = toRemoteProvider(def!);
    const baseCtx = {
      provider,
      apiKey: "",
      targetModel: "limited@allowed-model",
      port: 39999,
      sharedOpts: {},
    };

    const originalError = console.error;
    console.error = () => {};
    try {
      expect(profile!.createHandler({ ...baseCtx, modelName: "blocked-model" })).toBeNull();
    } finally {
      console.error = originalError;
    }

    expect(profile!.createHandler({ ...baseCtx, modelName: "allowed-model" })).not.toBeNull();
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

    test("missing ${VAR} endpoint is skipped with validation error", () => {
      const original = process.env.TEST_LOADER_MISSING_KEY;
      delete process.env.TEST_LOADER_MISSING_KEY;

      try {
        const result = loadCustomEndpoints(
          makeConfig({
            missing: {
              kind: "simple",
              url: "https://x.example.com/v1",
              format: "openai",
              apiKey: "${TEST_LOADER_MISSING_KEY}",
            },
          })
        );

        expect(result.registered).toBe(0);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].name).toBe("missing");
        expect(result.errors[0].message).toContain("resolved to an empty value");
      } finally {
        if (original === undefined) {
          delete process.env.TEST_LOADER_MISSING_KEY;
        } else {
          process.env.TEST_LOADER_MISSING_KEY = original;
        }
      }
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
});
