/**
 * Tests for custom-endpoints-loader.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { credentials } from "../auth/credentials/authority.js";
import { __resetSniffForTests } from "../auth/credentials/op-source.js";
import type { ClaudishProfileConfig } from "../profile-config.js";
import {
  loadCustomEndpoints,
  resolveCustomEndpointApiKey,
  resolveDeclaredEndpointKey,
} from "./custom-endpoints-loader.js";
import { __resetEndpointDiagnosticsForTests } from "./endpoint-diagnostics.js";
import { invalidateEndpointRegistration } from "./endpoint-registration.js";
import { __resetPredefinedStateForTests } from "./predefined-endpoints.js";
import { getProviderByName } from "./provider-definitions.js";
import type { ProfileContext } from "./provider-profiles.js";
import {
  clearRuntimeRegistry,
  getRuntimeProfiles,
  getRuntimeProviders,
} from "./runtime-providers.js";

// Minimal ClaudishProfileConfig stub — only the fields the loader reads.
function makeConfig(customEndpoints?: Record<string, unknown>): ClaudishProfileConfig {
  return {
    version: "1.0.0",
    defaultProfile: "default",
    profiles: {},
    customEndpoints,
  } as ClaudishProfileConfig;
}

interface HandlerTestSeams {
  provider?: { overrideStreamFormat?: () => unknown };
  resolveStreamFormat?: () => unknown;
}

function handlerTestSeams(handler: unknown): HandlerTestSeams {
  return handler as HandlerTestSeams;
}

const AUTH_SCHEME_TEST_ENV_VARS = [
  "CUSTOM_KEYLESS_SIMPLE_REGRESSION_KEY",
  "CUSTOM_KEYLESS_COMPLEX_REGRESSION_KEY",
  "CUSTOM_KEYLESS_ENV_REGRESSION_KEY",
  "CUSTOM_BEARER_REGRESSION_KEY",
] as const;

describe("custom-endpoints-loader", () => {
  let savedAuthSchemeEnv: Map<string, string | undefined>;

  beforeEach(() => {
    savedAuthSchemeEnv = new Map(
      AUTH_SCHEME_TEST_ENV_VARS.map((name) => [name, process.env[name]])
    );
    for (const name of AUTH_SCHEME_TEST_ENV_VARS) delete process.env[name];
    clearRuntimeRegistry();
    __resetEndpointDiagnosticsForTests();
    __resetPredefinedStateForTests();
    invalidateEndpointRegistration();
  });

  afterEach(() => {
    invalidateEndpointRegistration();
    __resetPredefinedStateForTests();
    clearRuntimeRegistry();
    __resetEndpointDiagnosticsForTests();
    for (const name of AUTH_SCHEME_TEST_ENV_VARS) {
      const value = savedAuthSchemeEnv.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
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
    expect(result.refused).toEqual([]);

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

  describe('authScheme "none" registration', () => {
    test("simple endpoint preserves the scheme and needs no credential", async () => {
      const name = "keyless-simple-regression";
      const result = loadCustomEndpoints(
        makeConfig({
          [name]: {
            kind: "simple",
            url: "https://keyless-openai.example.com/v1",
            format: "openai",
            authScheme: "none",
          },
        })
      );

      expect(result).toEqual({ registered: 1, errors: [], refused: [] });
      expect(getProviderByName(name)?.authScheme).toBe("none");
      expect(process.env.CUSTOM_KEYLESS_SIMPLE_REGRESSION_KEY).toBeUndefined();
      expect(await credentials.isAvailable(name)).toBe(true);

      const headers = (await credentials.getRequestAuth(name, { model: "m" })).headers;
      expect("Authorization" in headers).toBe(false);
      expect("x-api-key" in headers).toBe(false);
    });

    test("complex endpoint preserves the scheme and needs no credential", async () => {
      const name = "keyless-complex-regression";
      const result = loadCustomEndpoints(
        makeConfig({
          [name]: {
            kind: "complex",
            displayName: "Keyless Anthropic Gateway",
            transport: "anthropic",
            baseUrl: "https://keyless-anthropic.example.com",
            authScheme: "none",
          },
        })
      );

      expect(result).toEqual({ registered: 1, errors: [], refused: [] });
      expect(getProviderByName(name)?.authScheme).toBe("none");
      expect(process.env.CUSTOM_KEYLESS_COMPLEX_REGRESSION_KEY).toBeUndefined();
      expect(await credentials.isAvailable(name)).toBe(true);

      const headers = (await credentials.getRequestAuth(name, { model: "m" })).headers;
      expect("Authorization" in headers).toBe(false);
      expect("x-api-key" in headers).toBe(false);
    });

    test('credential signing ignores an accidentally populated env key for scheme "none"', async () => {
      const name = "keyless-env-regression";
      process.env.CUSTOM_KEYLESS_ENV_REGRESSION_KEY = "must-not-leak";
      loadCustomEndpoints(
        makeConfig({
          [name]: {
            kind: "simple",
            url: "https://keyless-env.example.com/v1",
            format: "openai",
            authScheme: "none",
          },
        })
      );

      const headers = (await credentials.getRequestAuth(name, { model: "m" })).headers;
      expect("Authorization" in headers).toBe(false);
      expect("x-api-key" in headers).toBe(false);
    });

    test("explicit bearer endpoint still signs with its declared key", async () => {
      const name = "bearer-regression";
      loadCustomEndpoints(
        makeConfig({
          [name]: {
            kind: "complex",
            displayName: "Bearer Gateway",
            transport: "openai",
            baseUrl: "https://bearer.example.com",
            authScheme: "bearer",
            apiKey: "declared-bearer-key",
          },
        })
      );

      const headers = (await credentials.getRequestAuth(name, { model: "m" })).headers;
      expect(headers.Authorization).toBe("Bearer declared-bearer-key");
      expect("x-api-key" in headers).toBe(false);
    });
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

  describe("reserved builtin namespace", () => {
    const collisions = [
      { name: "openrouter", owner: "openrouter", source: "builtin name" },
      { name: "or", owner: "openrouter", source: "builtin shortcut" },
      { name: "xai", owner: "x-ai", source: "legacy prefix" },
      { name: "gem", owner: "google", source: "picker-only alias" },
      { name: "OpenRouter", owner: "openrouter", source: "case-insensitive builtin name" },
    ] as const;

    for (const { name, owner, source } of collisions) {
      test(`refuses ${source} '${name}' and names '${owner}' as its owner`, () => {
        const result = loadCustomEndpoints(
          makeConfig({
            [name]: {
              kind: "simple",
              url: "https://attacker.example/v1",
              format: "openai",
              apiKey: "sk-attacker-declared-key",
            },
          })
        );

        expect(result).toEqual({
          registered: 0,
          errors: [],
          refused: [
            {
              name,
              reason:
                `'${name}' is already claimed by builtin provider '${owner}' ` +
                "(as its name, a shortcut, or a legacy prefix)",
            },
          ],
        });
        expect(getRuntimeProviders().has(name)).toBe(false);
        expect(getRuntimeProfiles().has(name)).toBe(false);
      });
    }

    test("a refused openrouter entry cannot replace the builtin credential authority", async () => {
      const attackerKey = "sk-attacker-declared-key";
      const builtinKey = "sk-builtin-openrouter-test-key";
      const originalEnv = process.env.OPENROUTER_API_KEY;
      const originalProvider = credentials.get("openrouter");
      expect(originalProvider).toBeDefined();

      process.env.OPENROUTER_API_KEY = builtinKey;
      credentials.invalidate("openrouter");
      try {
        const result = loadCustomEndpoints(
          makeConfig({
            openrouter: {
              kind: "simple",
              url: "https://attacker.example/v1",
              format: "openai",
              apiKey: attackerKey,
            },
          })
        );

        expect(result.registered).toBe(0);
        expect(result.refused).toHaveLength(1);
        expect(credentials.get("openrouter")).toBe(originalProvider);

        const auth = await credentials.getRequestAuth("openrouter", { model: "test-model" });
        expect(auth.headers).not.toEqual({ Authorization: `Bearer ${attackerKey}` });
        expect(auth.headers.Authorization).toBe(`Bearer ${builtinKey}`);
      } finally {
        if (originalProvider) credentials.register(originalProvider, ["openrouter"]);
        if (originalEnv === undefined) delete process.env.OPENROUTER_API_KEY;
        else process.env.OPENROUTER_API_KEY = originalEnv;
        credentials.invalidate("openrouter");
      }
    });
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

    test("op:// apiKey is NOT resolved here — returned verbatim (pre-resolved at startup)", () => {
      // op:// keys are pre-resolved into CUSTOM_<NAME>_KEY by index.ts before
      // sync handler construction. resolveCustomEndpointApiKey no longer touches
      // 1Password — it just returns the literal so there's no async/SDK on the
      // hot path. The env-first read in createHandler is what supplies the value.
      const resolved = resolveCustomEndpointApiKey({
        kind: "simple",
        url: "https://x.example.com/v1",
        format: "openai",
        apiKey: "op://Vault/Item/field",
      });
      expect(resolved).toBe("op://Vault/Item/field");
    });
  });

  describe("createHandler env-first apiKey", () => {
    const ENV_VAR = "CUSTOM_OPVLLM_KEY";
    const ORIGINAL = process.env[ENV_VAR];

    afterEach(() => {
      clearRuntimeRegistry();
      if (ORIGINAL === undefined) delete process.env[ENV_VAR];
      else process.env[ENV_VAR] = ORIGINAL;
    });
  });

  // -------------------------------------------------------------------------
  // Credential authority registration.
  //
  // REGRESSION GUARD: a custom endpoint declaring `apiKey: "${SOME_VAR}"` (or a
  // literal) was registered in the authority under CUSTOM_<NAME>_KEY ONLY. That
  // env var is set by nothing except the op:// pre-resolution path, so the
  // authority reported "no credential" and the routing pre-flight rejected the
  // model with:
  //   Explicit model "ep@model" could not be routed — its provider has no
  //   credential. No API key for provider "ep".
  // ...even though the handler could have expanded ${SOME_VAR} itself. These
  // tests pin the authority's view, which is what routing actually consults.
  // -------------------------------------------------------------------------
  describe("credential authority registration", () => {
    const VAR = "TEST_CUSTOM_EP_VAR";
    const OP_ENV_VAR = "CUSTOM_OP_EP_KEY";
    const ORIGINAL_VAR = process.env[VAR];
    const ORIGINAL_OP_ENV = process.env[OP_ENV_VAR];
    const ORIGINAL_DISABLE_KEYCHAIN = process.env.CLAUDISH_DISABLE_KEYCHAIN;
    const ORIGINAL_DISABLE_OP = process.env.CLAUDISH_DISABLE_OP;

    beforeEach(() => {
      // Keep credential misses off the host keychain and real 1Password SDK/config.
      process.env.CLAUDISH_DISABLE_KEYCHAIN = "1";
      process.env.CLAUDISH_DISABLE_OP = "1";
      __resetSniffForTests();
      delete process.env[VAR];
      delete process.env[OP_ENV_VAR];
    });

    afterEach(() => {
      clearRuntimeRegistry();
      if (ORIGINAL_VAR === undefined) delete process.env[VAR];
      else process.env[VAR] = ORIGINAL_VAR;
      if (ORIGINAL_OP_ENV === undefined) delete process.env[OP_ENV_VAR];
      else process.env[OP_ENV_VAR] = ORIGINAL_OP_ENV;
      if (ORIGINAL_DISABLE_KEYCHAIN === undefined) {
        delete process.env.CLAUDISH_DISABLE_KEYCHAIN;
      } else {
        process.env.CLAUDISH_DISABLE_KEYCHAIN = ORIGINAL_DISABLE_KEYCHAIN;
      }
      if (ORIGINAL_DISABLE_OP === undefined) delete process.env.CLAUDISH_DISABLE_OP;
      else process.env.CLAUDISH_DISABLE_OP = ORIGINAL_DISABLE_OP;
      __resetSniffForTests();
    });

    test("${VAR} apiKey with the var SET → provider is credentialed and signs with the value", async () => {
      process.env[VAR] = "sk-expanded-from-var";
      loadCustomEndpoints(
        makeConfig({
          "var-ep": {
            kind: "simple",
            url: "https://api.example.com/v1",
            format: "openai",
            apiKey: `\${${VAR}}`,
          },
        })
      );

      expect(await credentials.isAvailable("var-ep")).toBe(true);

      const auth = await credentials.getRequestAuth("var-ep", { model: "m" });
      expect(auth.headers.Authorization).toBe("Bearer sk-expanded-from-var");
      // The literal template must never reach the wire.
      expect(auth.headers.Authorization).not.toContain("${");
    });

    test("${VAR} apiKey with the var UNSET → provider is NOT credentialed", async () => {
      loadCustomEndpoints(
        makeConfig({
          "unset-ep": {
            kind: "simple",
            url: "https://api.example.com/v1",
            format: "openai",
            apiKey: `\${${VAR}}`,
          },
        })
      );

      expect(await credentials.isAvailable("unset-ep")).toBe(false);
      const auth = await credentials.getRequestAuth("unset-ep", { model: "m" });
      expect(auth.headers.Authorization).toBeUndefined();
    });

    test("literal apiKey → provider is credentialed and signs with the literal", async () => {
      loadCustomEndpoints(
        makeConfig({
          "literal-ep": {
            kind: "simple",
            url: "https://api.example.com/v1",
            format: "openai",
            apiKey: "sk-literal-key",
          },
        })
      );

      expect(await credentials.isAvailable("literal-ep")).toBe(true);
      const auth = await credentials.getRequestAuth("literal-ep", { model: "m" });
      expect(auth.headers.Authorization).toBe("Bearer sk-literal-key");
    });

    test("CUSTOM_<NAME>_KEY env (op:// pre-resolution) wins over the declared ${VAR}", async () => {
      // The op:// path and the authority's write-through mirror both land the key
      // in CUSTOM_<NAME>_KEY. That env value must keep precedence over the
      // config-declared key — declaredKey is the LAST link in the sync chain.
      process.env[VAR] = "sk-from-declaration";
      process.env.CUSTOM_VAR_EP_KEY = "sk-from-env-mirror";
      try {
        loadCustomEndpoints(
          makeConfig({
            "var-ep": {
              kind: "simple",
              url: "https://api.example.com/v1",
              format: "openai",
              apiKey: `\${${VAR}}`,
            },
          })
        );

        const auth = await credentials.getRequestAuth("var-ep", { model: "m" });
        expect(auth.headers.Authorization).toBe("Bearer sk-from-env-mirror");
      } finally {
        delete process.env.CUSTOM_VAR_EP_KEY;
      }
    });

    test("op:// apiKey → signs with the pre-resolved CUSTOM_<NAME>_KEY, never the op:// literal", async () => {
      // op:// refs are resolved by the authority's async op-source step into
      // CUSTOM_<NAME>_KEY. resolveDeclaredEndpointKey must NOT satisfy the sync
      // chain with the raw ref, or the "op://…" string would be sent as the key.
      process.env[OP_ENV_VAR] = "sk-resolved-from-1password";
      loadCustomEndpoints(
        makeConfig({
          "op-ep": {
            kind: "simple",
            url: "https://api.example.com/v1",
            format: "openai",
            apiKey: "op://Vault/Item/field",
          },
        })
      );

      expect(await credentials.isAvailable("op-ep")).toBe(true);
      const auth = await credentials.getRequestAuth("op-ep", { model: "m" });
      expect(auth.headers.Authorization).toBe("Bearer sk-resolved-from-1password");
      expect(auth.headers.Authorization).not.toContain("op://");
    });

    test("complex endpoint with x-api-key authScheme → declared key signs the x-api-key header", async () => {
      process.env[VAR] = "sk-complex-declared";
      loadCustomEndpoints(
        makeConfig({
          "corp-proxy": {
            kind: "complex",
            displayName: "Corp Proxy",
            transport: "anthropic",
            baseUrl: "https://llm.corp.internal",
            apiKey: `\${${VAR}}`,
            authScheme: "x-api-key",
          },
        })
      );

      expect(await credentials.isAvailable("corp-proxy")).toBe(true);
      const auth = await credentials.getRequestAuth("corp-proxy", { model: "m" });
      expect(auth.headers["x-api-key"]).toBe("sk-complex-declared");
    });
  });

  describe("resolveDeclaredEndpointKey", () => {
    const VAR = "TEST_DECLARED_KEY_VAR";
    const ORIGINAL = process.env[VAR];

    afterEach(() => {
      if (ORIGINAL === undefined) delete process.env[VAR];
      else process.env[VAR] = ORIGINAL;
    });

    test("set ${VAR} → expanded value", () => {
      process.env[VAR] = "expanded";
      expect(
        resolveDeclaredEndpointKey({
          kind: "simple",
          url: "https://x.example.com/v1",
          format: "openai",
          apiKey: `\${${VAR}}`,
        })
      ).toBe("expanded");
    });

    test("unset ${VAR} → undefined (no credential, do not fake one)", () => {
      delete process.env[VAR];
      expect(
        resolveDeclaredEndpointKey({
          kind: "simple",
          url: "https://x.example.com/v1",
          format: "openai",
          apiKey: `\${${VAR}}`,
        })
      ).toBeUndefined();
    });

    test("literal → the literal", () => {
      expect(
        resolveDeclaredEndpointKey({
          kind: "simple",
          url: "https://x.example.com/v1",
          format: "openai",
          apiKey: "literal-value",
        })
      ).toBe("literal-value");
    });

    test("op:// ref → undefined (the async op-source step owns it)", () => {
      expect(
        resolveDeclaredEndpointKey({
          kind: "simple",
          url: "https://x.example.com/v1",
          format: "openai",
          apiKey: "op://Vault/Item/field",
        })
      ).toBeUndefined();
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
      const transport = handlerTestSeams(handler).provider;
      expect(transport).toBeDefined();
      expect(transport?.overrideStreamFormat?.()).toBe("anthropic-sse");
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
      const transport = handlerTestSeams(handler).provider;
      expect(transport?.overrideStreamFormat?.()).toBe("openai-sse");
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
      const transport = handlerTestSeams(handler).provider;
      // No override set — returns undefined, the parser falls back to the
      // dialect's inherited streamFormat (the historical behavior).
      expect(transport?.overrideStreamFormat?.()).toBeUndefined();
    });

    test("a configured streamFormat selects the stream PARSER, not just the transport value", () => {
      loadCustomEndpoints(
        makeConfig({
          "parser-override": {
            kind: "complex",
            displayName: "Parser Override",
            transport: "openai",
            baseUrl: "https://override.example.com/v1",
            apiKey: "k",
            streamFormat: "anthropic-sse",
          },
        })
      );

      const overriddenHandler = getRuntimeProfiles()
        .get("parser-override")!
        .createHandler(makeCtx("qwen3.8-max"))!;
      // resolveStreamFormat is private, but it is the parser-selection step users experience.
      expect(handlerTestSeams(overriddenHandler).resolveStreamFormat?.()).toBe("anthropic-sse");

      clearRuntimeRegistry();
      loadCustomEndpoints(
        makeConfig({
          "parser-default": {
            kind: "complex",
            displayName: "Parser Default",
            transport: "openai",
            baseUrl: "https://default.example.com/v1",
            apiKey: "k",
          },
        })
      );

      const defaultHandler = getRuntimeProfiles()
        .get("parser-default")!
        .createHandler(makeCtx("qwen3.8-max"))!;
      expect(handlerTestSeams(defaultHandler).resolveStreamFormat?.()).toBe("openai-sse");
    });
  });
});
