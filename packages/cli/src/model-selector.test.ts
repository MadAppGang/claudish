/**
 * Tests for the pure-logic helpers in `model-selector.ts`.
 *
 * The inquirer-driven flows are end-to-end tested via the headless tmux smoke
 * run in commit 3 (see `ai-docs/sessions/.../commit-3-summary.md`). Here we
 * focus on the parts that are at risk of silent regression — the picker
 * provider→Firebase slug map, the user-deployed predicate, and the model-spec
 * builder.
 *
 * Run: bun test packages/cli/src/model-selector.test.ts
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { credentials } from "./auth/credentials/authority.js";
import {
  isSubscriptionProvider,
  registerSubscriptionCredentialProbe,
} from "./handlers/shared/remote-provider-types.js";
import {
  type ModelInfo,
  buildExplicitModelSpec,
  buildProviderChoices,
  getProviderFilterAliases,
  isPickableProvider,
  pickerProviderToFirebaseSlug,
  resolveProviderDisplayPrice,
  resolveProviderExternalId,
  warnDiscoveryFailure,
} from "./model-selector.js";
import { createCatalogClient } from "./providers/model-catalog.js";
import {
  type DiscoveryFailureKind,
  discoverProviderModels,
  getDiscoveryFailure,
  invalidateModelDiscovery,
} from "./providers/model-discovery.js";
import { parseModelSpec } from "./providers/model-parser.js";
import { BUILTIN_PROVIDERS, getProviderByName } from "./providers/provider-definitions.js";

// ─── pickerProviderToFirebaseSlug ────────────────────────────────────────────

// ─── isUserDeployedProvider ──────────────────────────────────────────────────

// ─── buildExplicitModelSpec ──────────────────────────────────────────────────

describe("warnDiscoveryFailure", () => {
  const provider = "qwen-cloud";
  const displayName = "Qwen Plan";
  const def = getProviderByName(provider)!;
  const realFetch = globalThis.fetch;
  const realGetRequestAuth = credentials.getRequestAuth;

  beforeEach(() => {
    invalidateModelDiscovery();
    credentials.getRequestAuth = mock(async () => ({
      headers: { Authorization: "Bearer offline-test-token" },
    }));
    globalThis.fetch = mock(async () => {
      throw new Error("Unexpected fetch call");
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    invalidateModelDiscovery();
    globalThis.fetch = realFetch;
    credentials.getRequestAuth = realGetRequestAuth;
  });

  async function recordFailure(kind: DiscoveryFailureKind): Promise<void> {
    switch (kind) {
      case "no-credentials":
        credentials.getRequestAuth = mock(async () => ({ headers: { authorization: "   " } }));
        break;
      case "unauthorized":
        globalThis.fetch = mock(
          async () => new Response(JSON.stringify({ error: "rejected" }), { status: 401 })
        ) as unknown as typeof fetch;
        break;
      case "http-error":
        globalThis.fetch = mock(
          async () => new Response(JSON.stringify({ error: "outage" }), { status: 500 })
        ) as unknown as typeof fetch;
        break;
      case "unreachable":
        globalThis.fetch = mock(async () => {
          throw new Error("offline");
        }) as unknown as typeof fetch;
        break;
      case "malformed":
        globalThis.fetch = mock(
          async () => new Response("not-json", { status: 200 })
        ) as unknown as typeof fetch;
        break;
      case "empty-roster":
        globalThis.fetch = mock(
          async () => new Response(JSON.stringify({ data: [] }), { status: 200 })
        ) as unknown as typeof fetch;
        break;
    }

    expect(await discoverProviderModels(provider)).toEqual([]);
    expect(getDiscoveryFailure(provider)?.kind).toBe(kind);
  }

  function captureWarning(): {
    stderr: string;
    stdout: string;
    stderrCalls: number;
    stdoutCalls: number;
  } {
    const stderrWrite = spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdoutWrite = spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      warnDiscoveryFailure(provider, displayName, def);
      return {
        stderr: stderrWrite.mock.calls.map(([chunk]) => String(chunk)).join(""),
        stdout: stdoutWrite.mock.calls.map(([chunk]) => String(chunk)).join(""),
        stderrCalls: stderrWrite.mock.calls.length,
        stdoutCalls: stdoutWrite.mock.calls.length,
      };
    } finally {
      stderrWrite.mockRestore();
      stdoutWrite.mockRestore();
    }
  }

  test("writes nothing when no failure is recorded or the roster is empty", async () => {
    expect(captureWarning()).toEqual({ stderr: "", stdout: "", stderrCalls: 0, stdoutCalls: 0 });

    await recordFailure("empty-roster");
    expect(captureWarning()).toEqual({ stderr: "", stdout: "", stderrCalls: 0, stdoutCalls: 0 });
  });

  test.each(["unauthorized", "no-credentials"] as const)(
    "prints credential guidance for %s on stderr only",
    async (kind) => {
      await recordFailure(kind);

      const output = captureWarning();
      expect(output.stderr).toContain(displayName);
      expect(output.stderr).toContain("QWEN_CLOUD_PLAN_API_KEY");
      expect(output.stderr).toContain(
        "https://www.alibabacloud.com/help/en/model-studio/claude-code"
      );
      expect(output.stderr).toContain("Falling back to manual model entry.");
      expect(output.stderrCalls).toBeGreaterThan(0);
      expect(output.stdout).toBe("");
      expect(output.stdoutCalls).toBe(0);
    }
  );

  test.each(["http-error", "unreachable", "malformed"] as const)(
    "omits credential guidance for %s while warning on stderr",
    async (kind) => {
      await recordFailure(kind);

      const output = captureWarning();
      expect(output.stderr).toContain(displayName);
      expect(output.stderr).toContain("Falling back to manual model entry.");
      expect(output.stderr).not.toContain("QWEN_CLOUD_PLAN_API_KEY");
      expect(output.stderr).not.toContain(
        "https://www.alibabacloud.com/help/en/model-studio/claude-code"
      );
      expect(output.stderrCalls).toBeGreaterThan(0);
      expect(output.stdout).toBe("");
      expect(output.stdoutCalls).toBe(0);
    }
  );
});

describe("buildExplicitModelSpec", () => {
  test.each([
    ["zen", "claude-opus-4-7", "zen@claude-opus-4-7"],
    ["openrouter", "qwen/qwen3-coder", "openrouter@qwen/qwen3-coder"],
    ["google", "gemini-2.5-pro", "google@gemini-2.5-pro"],
    ["openai", "gpt-5", "oai@gpt-5"],
    ["openai-codex", "gpt-5-codex", "cx@gpt-5-codex"],
    ["x-ai", "grok-4", "x-ai@grok-4"],
    ["deepseek", "deepseek-v3", "ds@deepseek-v3"],
    ["minimax", "MiniMax-M2", "mm@MiniMax-M2"],
    ["minimax-coding", "MiniMax-M2", "mmc@MiniMax-M2"],
    ["kimi", "kimi-k2", "kimi@kimi-k2"],
    ["kimi-coding", "kimi-for-coding", "kc@kimi-for-coding"],
    ["qwen-payg", "qwen3.7-plus", "qp@qwen3.7-plus"],
    // antigravity renders google-catalog rows in the picker; without a prefix
    // entry, rows would emit a bare id that won't route to Antigravity.
    ["antigravity", "gemini-3-pro", "ag@gemini-3-pro"],
    ["glm", "glm-4-plus", "glm@glm-4-plus"],
    ["glm-coding", "glm-4-plus", "gc@glm-4-plus"],
    ["z-ai", "z-ai-plus", "z-ai@z-ai-plus"],
    ["ollamacloud", "llama-3.1-70b", "oc@llama-3.1-70b"],
    ["ollama", "llama3.2", "ollama@llama3.2"],
    ["lmstudio", "qwen2.5-7b", "lmstudio@qwen2.5-7b"],
  ])("builds %s + %s → %s", (provider, modelId, expected) => {
    expect(buildExplicitModelSpec(provider, modelId)).toBe(expected);
  });

  test("does not double-prefix when model ID already starts with the provider prefix", () => {
    expect(buildExplicitModelSpec("zen", "zen@gpt-5")).toBe("zen@gpt-5");
    expect(buildExplicitModelSpec("openrouter", "openrouter@anthropic/claude-opus-4-7")).toBe(
      "openrouter@anthropic/claude-opus-4-7"
    );
  });

  test("returns model ID unchanged when provider has no prefix entry", () => {
    expect(buildExplicitModelSpec("unknown-provider", "some-model")).toBe("some-model");
  });
});

// ─── picker provider roster ──────────────────────────────────────────────────

describe("picker provider roster", () => {
  const pickableBuiltins = BUILTIN_PROVIDERS.filter(isPickableProvider);
  const unpickableBuiltins = BUILTIN_PROVIDERS.filter((def) => !isPickableProvider(def));

  test("the picker offers every pickable provider", () => {
    const choices = buildProviderChoices();
    const choiceProviders = new Set(
      choices.flatMap((choice) => (choice.provider ? [choice.provider] : []))
    );
    const pickableProviderNames = new Set(pickableBuiltins.map((def) => def.name));
    const unpickableProviderNames = new Set(unpickableBuiltins.map((def) => def.name));

    // Runtime custom endpoints legitimately appear in the picker, so equality against the builtin
    // table is order-dependent on whichever sibling test file registered one.
    expect([...pickableProviderNames].filter((name) => !choiceProviders.has(name))).toEqual([]);
    expect([...unpickableProviderNames].filter((name) => choiceProviders.has(name))).toEqual([]);
    expect(choiceProviders).toContain("devin");
    expect(choiceProviders).toContain("antigravity");
    expect(choices[0]?.value).toBe("skip");
    expect(choices.at(-1)?.value).toBe("custom");
  });

  test("every pickable provider has a working @filter alias", () => {
    const aliases = getProviderFilterAliases();

    // This table used to be hardcoded and missed Devin/Antigravity, so @dv matched nothing.
    for (const def of pickableBuiltins) {
      expect(aliases[def.name.toLowerCase()]).toBe(def.name);
      for (const shortcut of def.shortcuts) {
        expect(aliases[shortcut]).toBe(def.name);
      }
    }

    expect(aliases.gem).toBe("google");
    expect(aliases.zen).toBe("opencode-zen");
  });

  test("every builtin is pickable or an explicitly known unpickable shell", () => {
    const knownUnpickableShells = ["qwen", "native-anthropic"];

    for (const def of BUILTIN_PROVIDERS) {
      expect(isPickableProvider(def) || knownUnpickableShells.includes(def.name)).toBe(true);
    }

    // Changing this set is a product decision, not a provider rename.
    expect(unpickableBuiltins.map((def) => def.name)).toEqual(["qwen", "native-anthropic"]);
  });

  test.each(unpickableBuiltins.map((def) => [def.name, def] as const))(
    "%s has no endpoint for a picked model",
    (_name, def) => {
      expect(def.baseUrl).toBe("");
      expect(def.apiPath).toBe("");
    }
  );

  test.each(pickableBuiltins.map((def) => [def.name, def] as const))(
    "%s never emits a bare model id",
    (_name, def) => {
      // A bare id is not cosmetic: Devin's claude-opus-5-medium would match
      // native-anthropic's /^claude-/i pattern and route to a different provider.
      expect(buildExplicitModelSpec(def.name, "some-model")).not.toBe("some-model");
    }
  );

  test.each(pickableBuiltins.map((def) => [def.name, def] as const))(
    "%s emits a prefix that parses back to the same provider",
    (_name, def) => {
      const spec = buildExplicitModelSpec(def.name, "m");
      const [emittedPrefix] = spec.split("@", 1);
      if (!def.shortcuts.includes(emittedPrefix)) {
        // These are intentional readability overrides accepted by the parser.
        // Keep this list explicit so `${provider}@` cannot become a general
        // fallback for names such as ollamacloud or sakana-subscription.
        expect(["google", "openrouter"]).toContain(def.name);
      } else {
        expect(def.shortcuts).toContain(emittedPrefix);
      }

      const parsed = parseModelSpec(spec);
      expect(parsed.provider).toBe(def.name);
      expect(parsed.model).toBe("m");
      expect(parsed.isExplicitProvider).toBe(true);
    }
  );

  test("keeps Devin and Antigravity in the picker with routable prefixes", () => {
    const devin = getProviderByName("devin");
    const antigravity = getProviderByName("antigravity");

    expect(devin).toBeDefined();
    expect(antigravity).toBeDefined();
    expect(isPickableProvider(devin!)).toBe(true);
    expect(isPickableProvider(antigravity!)).toBe(true);
    expect(buildExplicitModelSpec("devin", "claude-opus-5-medium")).toBe("dv@claude-opus-5-medium");
    expect(buildExplicitModelSpec("antigravity", "gemini-3-pro")).toBe("ag@gemini-3-pro");
  });

  describe("provider-spec dedupe key", () => {
    const duplicateAntigravityRows: ModelInfo[] = [
      {
        id: "gemini-3.1-pro-high",
        name: "Gemini 3.1 Pro High",
        description: "",
        provider: "Google",
        aggregators: [
          {
            provider: "antigravity",
            externalId: "gemini-3.1-pro-high",
            confidence: "gateway_official",
          },
        ],
      },
      {
        id: "gemini-3.1-pro-preview",
        name: "Gemini 3.1 Pro Preview",
        description: "",
        provider: "Google",
        aggregators: [
          {
            provider: "antigravity",
            externalId: "gemini-3.1-pro-high",
            confidence: "gateway_official",
          },
        ],
      },
    ];

    const toProviderSpec = (provider: string, model: ModelInfo) =>
      buildExplicitModelSpec(provider, resolveProviderExternalId(provider, model));

    test("collapses different catalog rows that render the same provider spec", () => {
      const specs = duplicateAntigravityRows.map((model) => toProviderSpec("antigravity", model));

      expect(duplicateAntigravityRows[0]?.id).not.toBe(duplicateAntigravityRows[1]?.id);
      expect(specs).toEqual(["ag@gemini-3.1-pro-high", "ag@gemini-3.1-pro-high"]);
      expect(new Set(specs).size).toBe(1);
    });

    test("keeps rows whose provider externalIds render different specs", () => {
      const distinctRows: ModelInfo[] = [
        duplicateAntigravityRows[0]!,
        {
          id: "gemini-3.1-flash",
          name: "Gemini 3.1 Flash",
          description: "",
          provider: "Google",
          aggregators: [
            {
              provider: "antigravity",
              externalId: "gemini-3.1-flash",
              confidence: "gateway_official",
            },
          ],
        },
      ];
      const specs = distinctRows.map((model) => toProviderSpec("antigravity", model));

      expect(specs).toEqual(["ag@gemini-3.1-pro-high", "ag@gemini-3.1-flash"]);
      expect(new Set(specs).size).toBe(2);
    });

    test("uses model.id when the selected provider has no aggregator entry", () => {
      const noAntigravityEntry: ModelInfo = {
        id: "gemini-3.1-pro-preview",
        name: "Gemini 3.1 Pro Preview",
        description: "",
        provider: "Google",
        aggregators: [
          {
            provider: "openrouter",
            externalId: "google/gemini-3.1-pro-preview",
            confidence: "gateway_official",
          },
        ],
      };

      expect(resolveProviderExternalId("antigravity", noAntigravityEntry)).toBe(
        "gemini-3.1-pro-preview"
      );
      expect(toProviderSpec("antigravity", noAntigravityEntry)).toBe("ag@gemini-3.1-pro-preview");
    });
  });
});

// ─── resolveProviderExternalId (exact callable-spec rendering) ───────────────

describe("resolveProviderExternalId", () => {
  // gpt-5 is served bare by OpenAI but vendor-prefixed by OpenRouter / Zen.
  const gpt5: ModelInfo = {
    id: "gpt-5",
    name: "GPT-5",
    description: "",
    provider: "OpenAI",
    aggregators: [
      { provider: "openai", externalId: "gpt-5", confidence: "api_official" },
      { provider: "openrouter", externalId: "openai/gpt-5", confidence: "gateway_official" },
      { provider: "opencode-zen", externalId: "openai/gpt-5", confidence: "gateway_official" },
    ],
  };

  test("OpenRouter row uses the vendor-prefixed externalId", () => {
    // → or@openai/gpt-5
    expect(resolveProviderExternalId("openrouter", gpt5)).toBe("openai/gpt-5");
    expect(
      buildExplicitModelSpec("openrouter", resolveProviderExternalId("openrouter", gpt5))
    ).toBe("openrouter@openai/gpt-5");
  });

  test("OpenAI row uses the bare externalId", () => {
    // → oai@gpt-5
    expect(resolveProviderExternalId("openai", gpt5)).toBe("gpt-5");
    expect(buildExplicitModelSpec("openai", resolveProviderExternalId("openai", gpt5))).toBe(
      "oai@gpt-5"
    );
  });

  test("Zen row uses whatever externalId the catalog stores for opencode-zen", () => {
    // The catalog currently stores "openai/gpt-5" for Zen; we render exactly
    // that so the displayed spec is the true callable id (zen@openai/gpt-5).
    expect(resolveProviderExternalId("zen", gpt5)).toBe("openai/gpt-5");
  });

  test("falls back to the bare model id when no aggregator matches the provider", () => {
    const noAgg: ModelInfo = {
      id: "llama3.2:3b",
      name: "llama",
      description: "",
      provider: "Ollama",
    };
    expect(resolveProviderExternalId("ollama", noAgg)).toBe("llama3.2:3b");
    // A provider with aggregators but none for the selected provider also falls back.
    expect(resolveProviderExternalId("deepseek", gpt5)).toBe("gpt-5");
  });
});

// ─── resolveProviderDisplayPrice (true per-aggregator pricing) ───────────────

describe("resolveProviderDisplayPrice", () => {
  // The credential-decided billing probe is run-scoped module state installed by
  // importing the credential authority (see the import above). A test that pins it
  // must hand back the probe the registrar RETURNED — restoring `null` uninstalls
  // the production probe for the rest of the Bun process, and every sibling file
  // then sees openai-codex billing unwired, failing by run order.
  let previousProbe: ((p: string) => boolean) | null | undefined;

  afterEach(() => {
    if (previousProbe === undefined) return; // this test never replaced it
    registerSubscriptionCredentialProbe(previousProbe);
    previousProbe = undefined;
  });

  // gpt-5: owner OpenAI lists $1.25/$10; aggregators charge their OWN rates.
  // The slim catalog now carries per-aggregator pricing on each entry.
  const gpt5: ModelInfo = {
    id: "gpt-5",
    name: "GPT-5",
    description: "",
    provider: "OpenAI",
    pricing: { input: "$1.25", output: "$10.00", average: "$5.63/1M" },
    aggregators: [
      {
        provider: "openai",
        externalId: "gpt-5",
        confidence: "api_official",
        pricing: { input: 1.25, output: 10 },
      },
      {
        provider: "openrouter",
        externalId: "openai/gpt-5",
        confidence: "gateway_official",
        pricing: { input: 1.3, output: 10.5 }, // marked-up gateway rate
      },
      {
        provider: "opencode-zen",
        externalId: "openai/gpt-5",
        confidence: "gateway_official",
        pricing: { input: 1.07, output: 8.5 }, // cheaper gateway rate
      },
    ],
  };

  const pricedAcrossBillingModes: ModelInfo = {
    id: "priced-model",
    name: "Priced Model",
    description: "",
    provider: "OpenAI",
    pricing: { input: "$1.25", output: "$10.00", average: "$5.63/1M" },
    aggregators: [
      {
        provider: "openai",
        externalId: "priced-model",
        confidence: "api_official",
        pricing: { input: 1.25, output: 10 },
      },
      {
        provider: "antigravity",
        externalId: "priced-model",
        confidence: "gateway_official",
        pricing: { input: 2, output: 12 },
      },
      {
        provider: "sakana",
        externalId: "priced-model",
        confidence: "gateway_official",
        pricing: { input: 3, output: 13 },
      },
    ],
  };

  test.each(["antigravity", "sakana-subscription"])(
    "%s reports SUB ahead of aggregator and model-level prices",
    (provider) => {
      expect(resolveProviderDisplayPrice(provider, pricedAcrossBillingModes)).toBe("SUB");
    }
  );

  test("keeps a metered OpenAI provider on its real price", () => {
    expect(resolveProviderDisplayPrice("openai", pricedAcrossBillingModes)).toBe("$5.63/1M");
  });

  test("keeps qwen-payg metered while qwen-cloud remains subscription-priced", () => {
    expect(isSubscriptionProvider("qwen-payg")).toBe(false);
    expect(isSubscriptionProvider("qwen-cloud")).toBe(true);
    expect(resolveProviderDisplayPrice("qwen-payg", pricedAcrossBillingModes)).toBe("$5.63/1M");
    expect(resolveProviderDisplayPrice("qwen-payg", pricedAcrossBillingModes)).not.toBe("SUB");
  });

  test("openai-codex bills by the credential that signs, not by its name", () => {
    // Replaces an assertion that openai-codex is NEVER a subscription. Its stated
    // reason — that `apiKeyAliases: ["OPENAI_API_KEY"]` lets a plain metered key
    // authenticate `cx@` — is false at sign time: authority.ts:157 registers the
    // Codex composite first, :192-205 blocks the generic API-key provider from
    // taking the name, and the composite's fallback declares no aliases
    // (codex-credential.ts:79-82). equivalence.test.ts:302-305 is a checked-in
    // test that OPENAI_API_KEY alone does NOT authenticate openai-codex; the alias
    // is read only by display/hint code.
    //
    // The real dual mode is two HOSTS — chatgpt.com under OAuth vs api.openai.com
    // under OPENAI_CODEX_API_KEY — so the answer is a property of the credential
    // in play, which is what the probe reports. Pinned here in BOTH directions so
    // this file's answer does not depend on whether the machine running the suite
    // happens to hold a ChatGPT token.
    previousProbe = registerSubscriptionCredentialProbe(() => false);
    expect(resolveProviderDisplayPrice("openai-codex", pricedAcrossBillingModes)).toBe("$5.63/1M");
    expect(resolveProviderDisplayPrice("openai-codex", pricedAcrossBillingModes)).not.toBe("SUB");

    registerSubscriptionCredentialProbe(() => true);
    expect(resolveProviderDisplayPrice("openai-codex", pricedAcrossBillingModes)).toBe("SUB");
  });

  test("shows the selected aggregator's TRUE per-gateway price, not the owner price", () => {
    // OpenRouter: ($1.30 + $10.50)/2 = $5.90/1M
    expect(resolveProviderDisplayPrice("openrouter", gpt5)).toBe("$5.90/1M");
    // OpenCode Zen: ($1.07 + $8.50)/2 = $4.79/1M (different from OpenRouter — the point)
    expect(resolveProviderDisplayPrice("zen", gpt5)).toBe("$4.79/1M");
    // OpenAI (owner): ($1.25 + $10)/2 = $5.63/1M
    expect(resolveProviderDisplayPrice("openai", gpt5)).toBe("$5.63/1M");
  });

  test("falls back to model-level price when the aggregator entry has no pricing", () => {
    const noEntryPrice: ModelInfo = {
      id: "m",
      name: "m",
      description: "",
      provider: "OpenAI",
      pricing: { input: "$1.00", output: "$2.00", average: "$1.50/1M" },
      aggregators: [
        // openrouter entry exists but carries NO pricing → fall back to model.pricing
        { provider: "openrouter", externalId: "x/m", confidence: "gateway_official" },
      ],
    };
    expect(resolveProviderDisplayPrice("openrouter", noEntryPrice)).toBe("$1.50/1M");
  });

  test("returns N/A when neither aggregator nor model pricing is known", () => {
    const noPrice: ModelInfo = {
      id: "m",
      name: "m",
      description: "",
      provider: "OpenAI",
      aggregators: [{ provider: "openrouter", externalId: "x/m", confidence: "gateway_official" }],
    };
    expect(resolveProviderDisplayPrice("openrouter", noPrice)).toBe("N/A");
  });
});

// ─── CatalogClient integration: picker → modelsByVendor("opencode-zen") ──────

describe("CatalogClient integration for the original Zen bug", () => {
  test("modelsByVendor('opencode-zen') returns Zen-served models from the slim cache", async () => {
    // The picker for OpenCode Zen now flows: pick "OpenCode Zen" (value "zen") →
    // pickerProviderToFirebaseSlug["zen"] === "opencode-zen" →
    // catalog.modelsByVendor("opencode-zen") → slim-cache filter on
    // aggregators[].provider. This test verifies the data plumbing is intact
    // independent of the inquirer widgets.
    const fakeReadSlimCache = mock(() => ({
      version: 2 as const,
      lastUpdated: new Date().toISOString(),
      entries: [
        {
          modelId: "claude-opus-4-7",
          aliases: [],
          sources: {},
          aggregators: [
            {
              provider: "anthropic",
              externalId: "claude-opus-4-7",
              confidence: "api_official" as const,
            },
            {
              provider: "opencode-zen",
              externalId: "anthropic/claude-opus-4-7",
              confidence: "gateway_official" as const,
            },
          ],
        },
        {
          modelId: "gpt-5",
          aliases: [],
          sources: {},
          aggregators: [
            { provider: "openai", externalId: "gpt-5", confidence: "api_official" as const },
            {
              provider: "opencode-zen",
              externalId: "openai/gpt-5",
              confidence: "gateway_official" as const,
            },
          ],
        },
        {
          modelId: "grok-4",
          aliases: [],
          sources: {},
          aggregators: [
            { provider: "x-ai", externalId: "grok-4", confidence: "api_official" as const },
          ],
        },
      ],
      models: [],
    }));

    const fakeProviderQuery = mock(async () => []);
    const client = createCatalogClient({
      getModelsByProvider: fakeProviderQuery,
      readSlimCache: fakeReadSlimCache,
    });

    const pickerValue = "zen";
    const firebaseSlug = pickerProviderToFirebaseSlug[pickerValue];
    expect(firebaseSlug).toBe("opencode-zen");

    const result = await client.modelsByVendor(firebaseSlug!);

    expect(result.map((m) => m.modelId).sort()).toEqual(["claude-opus-4-7", "gpt-5"]);
    // Aggregator path must not hit the rich provider query.
    expect(fakeProviderQuery).not.toHaveBeenCalled();
  });

  test("modelsByVendor('moonshotai') routes Kimi picker to the owner catalog", async () => {
    // pickerValue "kimi" → "moonshotai" (owner) → rich provider query.
    const fakeProviderQuery = mock(async (slug: string) => {
      expect(slug).toBe("moonshotai");
      return [
        {
          modelId: "kimi-k2",
          provider: "moonshotai",
          displayName: "Kimi K2",
        },
      ];
    });

    const client = createCatalogClient({
      getModelsByProvider: fakeProviderQuery,
      readSlimCache: () => null,
    });

    const firebaseSlug = pickerProviderToFirebaseSlug.kimi;
    expect(firebaseSlug).toBe("moonshotai");

    const result = await client.modelsByVendor(firebaseSlug!);

    expect(result).toHaveLength(1);
    expect(result[0]?.modelId).toBe("kimi-k2");
    expect(fakeProviderQuery).toHaveBeenCalledTimes(1);
  });
});
