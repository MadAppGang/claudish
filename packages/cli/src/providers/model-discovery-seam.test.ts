import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ModelDiscoveryFetcher } from "./model-discovery.js";
import { getModelDiscoveryFetcher, registerModelDiscoveryFetcher } from "./model-discovery.js";

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = mock(async () => {
    throw new Error("model-discovery seam tests must not access the network");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("model discovery fetcher registration", () => {
  test("returns the registered fetcher and lets the last writer win", () => {
    const firstFetcher: ModelDiscoveryFetcher = async () => ({ kind: "models", models: [] });
    const replacementFetcher: ModelDiscoveryFetcher = async () => ({
      kind: "models",
      models: [{ id: "replacement-model" }],
    });

    registerModelDiscoveryFetcher("test-format", firstFetcher);
    expect(getModelDiscoveryFetcher("test-format")).toBe(firstFetcher);

    // Last-writer-wins lets tests and later registrations replace a format without shared mocks.
    registerModelDiscoveryFetcher("test-format", replacementFetcher);
    expect(getModelDiscoveryFetcher("test-format")).toBe(replacementFetcher);
  });

  test("returns undefined for an unregistered format", () => {
    expect(getModelDiscoveryFetcher("nope")).toBeUndefined();
  });

  test("the builtin module registers every non-GET discovery format", async () => {
    // Importing this lazy bundle performs registration while keeping the protobuf codec off cold start.
    await import("./model-discovery-builtins.js");

    for (const format of ["devin-connect", "antigravity", "ollama-tags"]) {
      expect(typeof getModelDiscoveryFetcher(format)).toBe("function");
    }
  });

  // REGRESSION: LM Studio picker hides models the cloud models catalog does not list
  test("every declared format is a GET-half format or has a registered fetcher, never both", async () => {
    await import("./model-discovery-builtins.js");
    const { BUILTIN_PROVIDERS } = await import("./provider-definitions.js");

    // The formats the GET half in model-discovery.ts speaks itself. Neither has
    // a fetcher: a registered fetcher would bypass the GET half's base URL,
    // local-key and failure-kind handling.
    const getHalfFormats = ["openai-models-list", "lmstudio-models"];
    const declared = [
      ...new Set(
        BUILTIN_PROVIDERS.flatMap((def) =>
          def.modelDiscovery ? [def.modelDiscovery.format as string] : []
        )
      ),
    ].sort();

    expect(declared).toEqual([
      "antigravity",
      "devin-connect",
      "lmstudio-models",
      "muse-code-models",
      "ollama-tags",
      "openai-models-list",
    ]);
    for (const format of declared) {
      const fetcher = getModelDiscoveryFetcher(format);
      if (getHalfFormats.includes(format)) expect(fetcher).toBeUndefined();
      else expect(typeof fetcher).toBe("function");
    }
  });

  // REGRESSION: LM Studio picker hides models the cloud models catalog does not list
  test("the claudish provider lmstudio declares the native /api/v0/models list", async () => {
    const { getProviderByName } = await import("./provider-definitions.js");

    const descriptor = getProviderByName("lmstudio")?.modelDiscovery;
    expect(descriptor?.path).toBe("/api/v0/models");
    expect(descriptor?.format as string | undefined).toBe("lmstudio-models");
  });
});
