import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentials } from "../../auth/credentials/authority.js";
import { providerShortcutRows } from "../../cli.js";
import { getConfigFileOverride } from "../../config-override.js";
import { isDotenvAllowedKey } from "../../dotenv-allowlist.js";
import { isSubscriptionProvider } from "../../handlers/shared/remote-provider-types.js";
import { decideModelListings } from "../../launcher/claude-launch.js";
import { buildModelLineup } from "../../launcher/model-lineup.js";
import {
  buildExplicitModelSpec,
  buildProviderChoices,
  outcomeFromModelsCatalog,
  resolveProviderDisplayPrice,
} from "../../model-selector.js";
import { setConfigFileOverride } from "../../profile-config.js";
import { getDynamicPricingSync } from "../../services/pricing-cache.js";
import {
  clearProviderCredentialEnv,
  providerBaseUrlEnvVars,
  providerCredentialEnvVars,
} from "../../test-helpers/provider-credential-env.js";
import { API_KEY_MAP } from "../api-key-map.js";
import { CATALOG_ROUTE_BINDINGS } from "../catalog-route-bindings.js";
import { providerServesModel } from "../model-availability.js";
import {
  discoverContextWindow,
  discoverProviderModels,
  discoverProviderModelsCatalog,
  invalidateModelDiscovery,
} from "../model-discovery.js";
import { parseListingEntry, parseModelFlags, parseModelSpec } from "../model-parser.js";
import {
  getEffectiveBaseUrl,
  getProviderByName,
  getShortcuts,
  toRemoteProvider,
} from "../provider-definitions.js";
import { createHandlerForProvider } from "../provider-profiles.js";
import { getProviderApiKeyEnv } from "../routing-hints.js";
import { explainRoute } from "../routing-rules.js";
import { OpenAIProviderTransport } from "../transport/openai.js";
import {
  TRUSTEDROUTER_BASE_URL,
  fetchTrustedRouterModelsCatalog,
  parseTrustedRouterModels,
  resolveTrustedRouterModelsEndpoint,
} from "./trustedrouter-models.js";

const SAMPLE_CATALOG_RESPONSE = {
  data: [
    {
      id: "trustedrouter/auto",
      name: "TrustedRouter Auto",
      created: 1735689600,
      context_length: 1_048_576,
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      pricing: { prompt: "0.000000026375", completion: "0.00000007385" },
      supported_parameters: ["tools", "max_tokens"],
      trustedrouter: {
        supports_chat: true,
        internal_only: false,
        configuration_hidden: false,
        synthetic_monitor: false,
        aliases: ["nyte/auto", "nyte/auto-routing", "trustedrouter/auto"],
      },
    },
    {
      id: "trustedrouter/zdr",
      name: "TrustedRouter ZDR",
      created: 1735689600,
      context_length: 1_048_576,
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      pricing: { prompt: "0.0000005", completion: "0.0000015" },
      supported_parameters: ["tools"],
      trustedrouter: {
        supports_chat: true,
        aliases: ["nyte/zdr"],
      },
    },
    {
      id: "trustedrouter/e2e",
      name: "TrustedRouter E2E",
      created: 1735689600,
      context_length: 200_000,
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      pricing: { prompt: "0.000001", completion: "0.000003" },
      supported_parameters: ["tools"],
      trustedrouter: {
        supports_chat: true,
        aliases: ["nyte/e2e"],
      },
    },
    {
      id: "trustedrouter/fast",
      name: "TrustedRouter Fast",
      context_length: 128_000,
      pricing: { prompt: "0.0000002", completion: "0.0000006" },
      supported_parameters: ["tools"],
      trustedrouter: { supports_chat: true, aliases: ["nyte/fast"] },
    },
    {
      id: "trustedrouter/cheap",
      name: "TrustedRouter Cheap",
      context_length: 128_000,
      pricing: { prompt: "0.0000001", completion: "0.0000003" },
      supported_parameters: ["tools"],
      trustedrouter: { supports_chat: true, aliases: ["nyte/cheap"] },
    },
    {
      id: "trustedrouter/free",
      name: "TrustedRouter Free",
      context_length: 128_000,
      pricing: { prompt: "0", completion: "0" },
      supported_parameters: ["max_tokens"],
      trustedrouter: { supports_chat: true, aliases: ["nyte/free"] },
    },
    {
      id: "anthropic/claude-sonnet-4.6",
      name: "Anthropic: Claude Sonnet 4.6",
      created: 1767225600,
      top_provider: { context_length: 200_000 },
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      pricing: { prompt: "0.00000211", completion: "0.00001055" },
      supported_parameters: ["tools"],
      trustedrouter: {
        supports_chat: true,
        capabilities: { tools: true },
      },
    },
    {
      id: "nyte/confidential-direct",
      name: "Nyte Confidential Direct",
      context_length: 256_000,
      trustedrouter: {
        supports_chat: true,
        prompt_price_microdollars_per_million_tokens: 1_500_000,
        completion_price_microdollars_per_million_tokens: 4_500_000,
      },
    },
    {
      id: "vendor/no-tools-chat",
      name: "No Tools Chat",
      context_length: 64_000,
      pricing: { prompt: "0.0000005", completion: "0.000001" },
      trustedrouter: {
        supports_chat: true,
        capabilities: { tools: false },
      },
    },
    // Filtered rows below — must NOT appear in parsed catalog
    {
      id: "internal/canary-model",
      name: "Internal Canary",
      context_length: 128_000,
      trustedrouter: { supports_chat: true, internal_only: true },
    },
    {
      id: "hidden/config-model",
      name: "Hidden Config",
      context_length: 128_000,
      trustedrouter: { supports_chat: true, configuration_hidden: true },
    },
    {
      id: "monitor/synthetic-probe",
      name: "Synthetic Monitor",
      context_length: 128_000,
      trustedrouter: { supports_chat: true, synthetic_monitor: true },
    },
    {
      id: "openai/text-embedding-3-large",
      name: "Embedding Nested Non-Chat",
      context_length: 8192,
      trustedrouter: { supports_chat: false },
    },
    {
      id: "vendor/top-level-non-chat",
      name: "Top-level Non-Chat",
      supports_chat: false,
      context_length: 8192,
    },
    null,
    { id: "" },
  ],
};

const realFetch = globalThis.fetch;

describe("parseTrustedRouterModels", () => {
  test("filters internal, hidden, synthetic-monitor, and non-chat rows while keeping public routes", () => {
    const models = parseTrustedRouterModels(SAMPLE_CATALOG_RESPONSE);
    expect(models).not.toBeNull();
    const ids = models!.map((m) => m.id);

    expect(ids).toEqual([
      "trustedrouter/auto",
      "trustedrouter/zdr",
      "trustedrouter/e2e",
      "trustedrouter/fast",
      "trustedrouter/cheap",
      "trustedrouter/free",
      "anthropic/claude-sonnet-4.6",
      "nyte/confidential-direct",
      "vendor/no-tools-chat",
    ]);
    expect(ids).not.toContain("internal/canary-model");
    expect(ids).not.toContain("hidden/config-model");
    expect(ids).not.toContain("monitor/synthetic-probe");
    expect(ids).not.toContain("openai/text-embedding-3-large");
    expect(ids).not.toContain("vendor/top-level-non-chat");
  });

  test("extracts pricing (USD/1M), context window, release date, aliases, and tool capabilities", () => {
    const models = parseTrustedRouterModels(SAMPLE_CATALOG_RESPONSE)!;
    const byId = new Map(models.map((m) => [m.id, m]));

    const auto = byId.get("trustedrouter/auto")!;
    expect(auto.displayName).toBe("TrustedRouter Auto");
    expect(auto.contextWindow).toBe(1_048_576);
    expect(auto.releaseDate).toBe("2025-01-01");
    expect(auto.reported).toBe("chat");
    expect(auto.supportsTools).toBe(true);
    expect(auto.pricing).toEqual({ input: 0.026375, output: 0.07385 });
    expect(auto.aliases).toEqual(["nyte/auto", "nyte/auto-routing"]);

    const free = byId.get("trustedrouter/free")!;
    expect(free.pricing).toEqual({ input: 0, output: 0 });
    expect(free.supportsTools).toBeUndefined();
    expect(free.aliases).toEqual(["nyte/free"]);

    const sonnet = byId.get("anthropic/claude-sonnet-4.6")!;
    expect(sonnet.contextWindow).toBe(200_000);
    expect(sonnet.pricing).toEqual({ input: 2.11, output: 10.55 });
    expect(sonnet.supportsTools).toBe(true);

    const nyteDirect = byId.get("nyte/confidential-direct")!;
    expect(nyteDirect.pricing).toEqual({ input: 1.5, output: 4.5 });

    const noTools = byId.get("vendor/no-tools-chat")!;
    expect(noTools.supportsTools).toBe(false);
  });

  test("marks non-text output modalities as not-chat and rejects payloads without data array", () => {
    expect(parseTrustedRouterModels(null)).toBeNull();
    expect(parseTrustedRouterModels({})).toBeNull();
    expect(parseTrustedRouterModels({ data: "not-an-array" })).toBeNull();

    const parsed = parseTrustedRouterModels({
      data: [
        {
          id: "vendor/image-gen",
          architecture: { input_modalities: ["text"], output_modalities: ["image"] },
        },
      ],
    });
    expect(parsed).toHaveLength(1);
    expect(parsed![0]!.reported).toBe("not-chat");
  });
});

describe("TrustedRouter provider wiring, prefix resolution, and key isolation", () => {
  let restoreEnv: (() => void) | null = null;
  let savedKeychainGuard: string | undefined;
  let savedOpGuard: string | undefined;
  let savedConfigOverride: string | null = null;

  beforeEach(() => {
    savedConfigOverride = getConfigFileOverride();
    setConfigFileOverride(
      join(tmpdir(), `claudish-trustedrouter-test-${process.pid}-${Date.now()}.json`)
    );
    savedKeychainGuard = process.env.CLAUDISH_DISABLE_KEYCHAIN;
    savedOpGuard = process.env.CLAUDISH_DISABLE_OP;
    restoreEnv = clearProviderCredentialEnv();
    process.env.CLAUDISH_DISABLE_KEYCHAIN = "1";
    process.env.CLAUDISH_DISABLE_OP = "1";
    credentials.invalidate();
    invalidateModelDiscovery();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    setConfigFileOverride(savedConfigOverride);
    restoreEnv?.();
    restoreEnv = null;
    if (savedKeychainGuard === undefined) delete process.env.CLAUDISH_DISABLE_KEYCHAIN;
    else process.env.CLAUDISH_DISABLE_KEYCHAIN = savedKeychainGuard;
    if (savedOpGuard === undefined) delete process.env.CLAUDISH_DISABLE_OP;
    else process.env.CLAUDISH_DISABLE_OP = savedOpGuard;
    credentials.invalidate();
    invalidateModelDiscovery();
  });

  test("provider definition matches required endpoint, env var, shortcuts, and gateway classification", () => {
    const def = getProviderByName("trustedrouter");
    expect(def).toBeDefined();
    expect(def!.displayName).toBe("TrustedRouter");
    expect(def!.tier).toBe("gateway");
    expect(def!.transport).toBe("openai");
    expect(def!.baseUrl).toBe(TRUSTEDROUTER_BASE_URL);
    expect(def!.apiPath).toBe("/chat/completions");
    expect(def!.baseUrlEnvVars).toEqual(["TRUSTEDROUTER_BASE_URL"]);
    expect(def!.modelDiscovery).toEqual({ path: "/models", format: "trustedrouter-models" });
    expect(def!.apiKeyEnvVar).toBe("TRUSTEDROUTER_API_KEY");
    expect(def!.apiKeyAliases).toBeUndefined();
    expect(def!.shortcuts).toEqual(["trustedrouter", "tr", "nyte"]);
    expect(def!.shortestPrefix).toBe("tr");
    expect(def!.nativeModelPatterns).toBeUndefined();
    expect(isSubscriptionProvider("trustedrouter")).toBe(false);
    expect(CATALOG_ROUTE_BINDINGS.trustedrouter).toBeUndefined();

    const shortcutMap = getShortcuts();
    expect(shortcutMap.trustedrouter).toBe("trustedrouter");
    expect(shortcutMap.tr).toBe("trustedrouter");
    expect(shortcutMap.nyte).toBe("trustedrouter");

    expect(API_KEY_MAP.trustedrouter).toEqual({ envVar: "TRUSTEDROUTER_API_KEY" });
    expect(getProviderApiKeyEnv("trustedrouter")).toBe("TRUSTEDROUTER_API_KEY");
    expect(providerCredentialEnvVars()).toContain("TRUSTEDROUTER_API_KEY");
    expect(providerBaseUrlEnvVars()).toContain("TRUSTEDROUTER_BASE_URL");
    expect(isDotenvAllowedKey("TRUSTEDROUTER_API_KEY")).toBe(true);
    expect(isDotenvAllowedKey("TRUSTEDROUTER_BASE_URL")).toBe(false);
    expect(OpenAIProviderTransport.formatDisplayName("trustedrouter")).toBe("TrustedRouter");

    const cliRow = providerShortcutRows().find((r) => r.displayName === "TrustedRouter");
    expect(cliRow).toEqual({
      shortcuts: ["trustedrouter", "tr", "nyte"],
      displayName: "TrustedRouter",
      kind: "gateway",
    });

    const pickerOrder = buildProviderChoices().map((c) => c.value);
    const poeIdx = pickerOrder.indexOf("poe");
    const trIdx = pickerOrder.indexOf("trustedrouter");
    expect(poeIdx).toBeGreaterThan(-1);
    expect(trIdx).toBe(poeIdx + 1);
  });

  test("resolves trustedrouter@, tr@, and nyte@ prefixes and listing scopes", () => {
    for (const [spec, expectedModel] of [
      ["trustedrouter@trustedrouter/auto", "trustedrouter/auto"],
      ["TRUSTEDROUTER@trustedrouter/zdr", "trustedrouter/zdr"],
      ["tr@trustedrouter/e2e", "trustedrouter/e2e"],
      ["tr@anthropic/claude-sonnet-4.6", "anthropic/claude-sonnet-4.6"],
      ["nyte@nyte/auto", "nyte/auto"],
      ["NYTE@nyte/zdr", "nyte/zdr"],
      ["nyte@anthropic/claude-sonnet-4.6", "anthropic/claude-sonnet-4.6"],
    ] as const) {
      const parsed = parseModelSpec(spec);
      expect(parsed.provider).toBe("trustedrouter");
      expect(parsed.model).toBe(expectedModel);
      expect(parsed.isExplicitProvider).toBe(true);
      expect(parsed.isLegacySyntax).toBe(false);
    }

    for (const prefix of ["trustedrouter", "tr", "nyte"]) {
      const rec = parseListingEntry(`${prefix}@`);
      expect(rec).toEqual({
        shortcut: prefix,
        scope: "recommended",
      });
      const all = parseListingEntry(`${prefix}@*`);
      expect(all).toEqual({
        shortcut: prefix,
        scope: "all",
      });

      const flags = parseModelFlags([`${prefix}@`]);
      expect(flags.ok).toBe(true);
      if (!flags.ok) throw new Error("Expected flags.ok");
      const config: Parameters<typeof decideModelListings>[0] = {
        interactive: true,
        quiet: false,
        debug: false,
        noLogs: false,
        diagMode: "auto",
        logLevel: "info",
        autoApprove: false,
        dangerous: false,
        stdin: false,
        freeOnly: false,
        monitor: false,
        jsonOutput: false,
        claudeArgs: [],
      };
      const decided = decideModelListings(config, flags.value, {
        settingsFindings: () => [],
      });
      expect(decided.ok).toBe(true);
      expect(config.modelListings).toEqual([
        {
          provider: "trustedrouter",
          typed: `${prefix}@`,
          scope: "recommended",
          pinnedSpecs: [],
        },
      ]);
    }

    const explicit = buildExplicitModelSpec("trustedrouter", "trustedrouter/auto");
    expect(explicit).toBe("tr@trustedrouter/auto");
    expect(parseModelSpec(explicit)).toMatchObject({
      provider: "trustedrouter",
      model: "trustedrouter/auto",
      isExplicitProvider: true,
    });
  });

  test("isolates TRUSTEDROUTER_API_KEY from other gateway keys", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-other";
    process.env.VENICE_API_KEY = "venice-other";
    process.env.OPENAI_API_KEY = "sk-openai-other";
    credentials.invalidate();

    expect(await credentials.isAvailable("trustedrouter")).toBe(false);

    process.env.TRUSTEDROUTER_API_KEY = "tr-secret-test-key";
    credentials.invalidate();

    expect(await credentials.isAvailable("trustedrouter")).toBe(true);
    const auth = await credentials.getRequestAuth("trustedrouter", {
      model: "trustedrouter/auto",
    });
    expect(auth.headers.Authorization).toBe("Bearer tr-secret-test-key");
  });

  test("fetches live catalog from default and overridden base URLs and classifies errors", async () => {
    const seenRequests: Array<{ url: string; auth: string | null; userAgent: string | null }> = [];
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init?.headers);
      seenRequests.push({
        url,
        auth: headers.get("authorization"),
        userAgent: headers.get("user-agent"),
      });
      return Response.json(SAMPLE_CATALOG_RESPONSE);
    }) as unknown as typeof fetch;

    // Public discovery succeeds even without TRUSTEDROUTER_API_KEY
    const publicModels = await discoverProviderModels("trustedrouter");
    expect(publicModels).toHaveLength(9);
    expect(seenRequests[0]!.url).toBe("https://api.trustedrouter.com/v1/models");
    expect(seenRequests[0]!.auth).toBeNull();
    expect(seenRequests[0]!.userAgent).toMatch(/^claudish\//);

    // Base URL override + bearer header forwarding when key is set
    process.env.TRUSTEDROUTER_BASE_URL = "https://private.trustedrouter.test/v1/";
    process.env.TRUSTEDROUTER_API_KEY = "tr-custom-key";
    credentials.invalidate();
    invalidateModelDiscovery("trustedrouter");

    expect(resolveTrustedRouterModelsEndpoint()).toBe(
      "https://private.trustedrouter.test/v1/models"
    );
    const authedResult = await fetchTrustedRouterModelsCatalog();
    expect(authedResult.kind).toBe("models");
    expect(seenRequests[1]!.url).toBe("https://private.trustedrouter.test/v1/models");
    expect(seenRequests[1]!.auth).toBe("Bearer tr-custom-key");

    // Error classifications: 401 unauthorized, 500 http-error, malformed JSON, network unreachable
    globalThis.fetch = mock(
      async () => new Response('{"error":"Invalid API key"}', { status: 401 })
    ) as unknown as typeof fetch;
    const unauth = await fetchTrustedRouterModelsCatalog();
    expect(unauth).toMatchObject({
      kind: "failed",
      failure: { kind: "unauthorized", status: 401 },
    });

    globalThis.fetch = mock(
      async () => new Response("upstream error", { status: 502 })
    ) as unknown as typeof fetch;
    const serverErr = await fetchTrustedRouterModelsCatalog();
    expect(serverErr).toMatchObject({
      kind: "failed",
      failure: { kind: "http-error", status: 502 },
    });

    globalThis.fetch = mock(
      async () => new Response("{not-json", { status: 200 })
    ) as unknown as typeof fetch;
    const badJson = await fetchTrustedRouterModelsCatalog();
    expect(badJson).toMatchObject({
      kind: "failed",
      failure: { kind: "malformed" },
    });

    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const offline = await fetchTrustedRouterModelsCatalog();
    expect(offline).toMatchObject({
      kind: "failed",
      failure: { kind: "unreachable" },
    });
  });

  test("routes explicit trustedrouter@ and nyte@ specs, checks alias availability, pricing, and context window", async () => {
    globalThis.fetch = mock(async () =>
      Response.json(SAMPLE_CATALOG_RESPONSE)
    ) as unknown as typeof fetch;

    // Without credential: explicit-no-credential naming TRUSTEDROUTER_API_KEY in hint
    const missingKey = await explainRoute("trustedrouter@trustedrouter/auto");
    expect(missingKey.outcome.kind).toBe("no-route");
    if (missingKey.outcome.kind === "no-route") {
      expect(missingKey.outcome.cause).toBe("explicit-no-credential");
      expect(missingKey.outcome.reason).toContain("trustedrouter");
      expect(missingKey.outcome.hint).toContain("TRUSTEDROUTER_API_KEY");
    }

    // With credential: canonical id and nyte/* alias both route cleanly
    process.env.TRUSTEDROUTER_API_KEY = "tr-live-key";
    credentials.invalidate();
    invalidateModelDiscovery("trustedrouter");

    const autoRoute = await explainRoute("trustedrouter@trustedrouter/auto");
    expect(autoRoute.outcome.kind).toBe("ok");
    expect(autoRoute.candidates[0]).toMatchObject({
      provider: "trustedrouter",
      wireId: "trustedrouter/auto",
      outcome: "kept",
    });

    const nyteRoute = await explainRoute("nyte@nyte/zdr");
    expect(nyteRoute.outcome.kind).toBe("ok");
    expect(nyteRoute.candidates[0]).toMatchObject({
      provider: "trustedrouter",
      wireId: "nyte/zdr",
      outcome: "kept",
    });

    // Availability recognises canonical ids and aliases, rejects unknown ids
    expect(await providerServesModel("trustedrouter", "trustedrouter/auto")).toBe("serves");
    expect(await providerServesModel("trustedrouter", "nyte/zdr")).toBe("serves");
    expect(await providerServesModel("trustedrouter", "nyte/free")).toBe("serves");
    expect(await providerServesModel("trustedrouter", "does-not-exist/model")).toBe("not-served");

    const unservedRoute = await explainRoute("trustedrouter@does-not-exist/model");
    expect(unservedRoute.outcome.kind).toBe("no-route");
    if (unservedRoute.outcome.kind === "no-route") {
      expect(unservedRoute.outcome.cause).toBe("explicit-not-served");
    }

    // Context window lookup works for both canonical id and nyte/* alias
    expect(await discoverContextWindow("trustedrouter", "trustedrouter/auto")).toBe(1_048_576);
    expect(await discoverContextWindow("trustedrouter", "nyte/auto")).toBe(1_048_576);
    expect(await discoverContextWindow("trustedrouter", "nyte/e2e")).toBe(200_000);

    // Dynamic pricing lookup uses live discovered rates for canonical id and alias
    expect(getDynamicPricingSync("trustedrouter", "anthropic/claude-sonnet-4.6")).toEqual({
      inputCostPer1M: 2.11,
      outputCostPer1M: 10.55,
      isFree: false,
    });
    expect(getDynamicPricingSync("trustedrouter", "nyte/auto")).toEqual({
      inputCostPer1M: 0.026375,
      outputCostPer1M: 0.07385,
      isFree: false,
    });
    expect(getDynamicPricingSync("trustedrouter", "trustedrouter/free")).toEqual({
      inputCostPer1M: 0,
      outputCostPer1M: 0,
      isFree: true,
    });

    // Handler targets https://api.trustedrouter.com/v1/chat/completions with Bearer auth
    const def = getProviderByName("trustedrouter")!;
    const remoteProvider = toRemoteProvider(def);
    expect(getEffectiveBaseUrl(def)).toBe(TRUSTEDROUTER_BASE_URL);
    const handler = await createHandlerForProvider({
      provider: remoteProvider,
      modelName: "trustedrouter/auto",
      apiKey: "tr-live-key",
      targetModel: "trustedrouter@trustedrouter/auto",
      port: 0,
      sharedOpts: {},
    });
    expect(handler).not.toBeNull();
    const transport = (handler as unknown as { provider?: OpenAIProviderTransport }).provider;
    expect(transport?.getEndpoint()).toBe("https://api.trustedrouter.com/v1/chat/completions");
    expect(transport?.displayName).toBe("TrustedRouter");
    expect(await transport?.getHeaders()).toEqual({ Authorization: "Bearer tr-live-key" });
  });

  test("lists all live public chat models with pricing and context via --model trustedrouter@* and nyte@*, and follows gateway R7 on x@", async () => {
    globalThis.fetch = mock(async () =>
      Response.json(SAMPLE_CATALOG_RESPONSE)
    ) as unknown as typeof fetch;
    process.env.TRUSTEDROUTER_API_KEY = "tr-lineup-key";
    credentials.invalidate();
    invalidateModelDiscovery("trustedrouter");

    // Picker discovery outcome preserves live pricing & context length
    const catalogOutcome = await discoverProviderModelsCatalog("trustedrouter");
    const pickerOutcome = outcomeFromModelsCatalog(
      "trustedrouter",
      "TrustedRouter",
      catalogOutcome,
      []
    );
    expect(pickerOutcome.kind).toBe("rows");
    if (pickerOutcome.kind !== "rows") throw new Error("Expected rows outcome");
    expect(pickerOutcome.rows).toHaveLength(9);

    const byId = new Map(pickerOutcome.rows.map((r) => [r.id, r]));
    expect(resolveProviderDisplayPrice("trustedrouter", byId.get("trustedrouter/free")!)).toBe(
      "FREE"
    );
    expect(
      resolveProviderDisplayPrice("trustedrouter", byId.get("anthropic/claude-sonnet-4.6")!)
    ).toBe("$6.33/1M");
    expect(byId.get("trustedrouter/auto")!.context).toBe("1M");

    // R7: gateway `x@` with no cloud-catalog recommendations points users to `x@*`
    const recLineup = await buildModelLineup(
      [
        {
          provider: "trustedrouter",
          typed: "tr@",
          scope: "recommended",
          pinnedSpecs: [],
        },
      ],
      {
        deps: {
          ensureCatalog: async () => {},
          catalogRows: () => [],
          recommended: async () => ({
            version: "1",
            lastUpdated: "2026-01-01T00:00:00Z",
            models: [],
          }),
        },
      }
    );
    expect(recLineup.rows).toEqual([]);
    expect(recLineup.outcomes).toEqual([
      {
        kind: "not-listed",
        provider: "trustedrouter",
        reason: "it serves none of the recommended models; 'tr@*' lists every model it serves",
      },
    ]);

    // R7: `/model` lineup for `--model 'trustedrouter@*'` and `--model 'nyte@*'` lists all tool-capable models
    for (const listingTyped of ["trustedrouter@*", "nyte@*"] as const) {
      const lineup = await buildModelLineup(
        [
          {
            provider: "trustedrouter",
            typed: listingTyped,
            scope: "all",
            pinnedSpecs: [],
          },
        ],
        {
          deps: {
            ensureCatalog: async () => {},
            catalogRows: () => [],
            recommended: async () => null,
          },
        }
      );
      // 8 tool-capable public models (vendor/no-tools-chat has supportsTools: false and is dropped)
      expect(lineup.rows).toHaveLength(8);
      expect(lineup.outcomes).toEqual([
        { kind: "listed", provider: "trustedrouter", count: 8, source: "live" },
      ]);
      const rowByModel = new Map(lineup.rows.map((r) => [r.model, r]));
      expect(rowByModel.has("tr@trustedrouter/auto")).toBe(true);
      expect(rowByModel.has("tr@trustedrouter/zdr")).toBe(true);
      expect(rowByModel.has("tr@trustedrouter/e2e")).toBe(true);
      expect(rowByModel.has("tr@trustedrouter/fast")).toBe(true);
      expect(rowByModel.has("tr@trustedrouter/cheap")).toBe(true);
      expect(rowByModel.has("tr@trustedrouter/free")).toBe(true);
      expect(rowByModel.has("tr@anthropic/claude-sonnet-4.6")).toBe(true);
      expect(rowByModel.has("tr@nyte/confidential-direct")).toBe(true);
      expect(rowByModel.has("tr@vendor/no-tools-chat")).toBe(false);

      expect(rowByModel.get("tr@trustedrouter/free")!.description).toContain("FREE");
      expect(rowByModel.get("tr@trustedrouter/auto")!.description).toContain("1M context");
      expect(rowByModel.get("tr@anthropic/claude-sonnet-4.6")!.description).toContain("$6.33/1M");
    }
  });
});
