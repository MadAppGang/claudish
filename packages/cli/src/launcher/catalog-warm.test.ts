/**
 * Tests for the launcher catalog warm step.
 *
 * Run: bun test packages/cli/src/launcher/catalog-warm.test.ts
 *
 * Covers three layers:
 *   1. shouldWarmCatalog — pure trigger function (12+ cases).
 *   2. classifyCatalogState — pure state classifier (6 cases).
 *   3. warmCatalogIfNeeded — dispatcher state machine (mocked resolver/cache).
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import type { ClaudishConfig } from "../types.js";
import type { DiskCacheV2 } from "../providers/all-models-cache.js";
import type { RefreshOutcome } from "../providers/model-catalog-resolver.js";

// ---------------------------------------------------------------------------
// Module mocks for dispatcher tests
// ---------------------------------------------------------------------------
//
// `mock.module()` is hoisted to top-of-file by Bun, so we register both mocks
// here BEFORE importing catalog-warm. The mocks are mutated in beforeEach to
// configure each test case.

let mockReadResult: DiskCacheV2 | null = null;
let mockRefreshOutcome: RefreshOutcome = { kind: "refreshed", modelCount: 0 };
let mockResolverNull = false;
const refreshSpy = mock(async (_timeoutMs: number): Promise<RefreshOutcome> => {
  return mockRefreshOutcome;
});

mock.module("../providers/all-models-cache.js", () => ({
  readAllModelsCache: () => mockReadResult,
  // The dispatcher module only imports readAllModelsCache + the type. Other
  // exports (writeAllModelsCache, allModelsCachePath, SlimModelEntry) are
  // intentionally omitted — bun's mock.module replaces the whole module so we
  // re-export only what catalog-warm.ts touches. `allModelsCachePath` is the
  // canary the shared cache test uses to detect this mock (#272).
  writeAllModelsCache: () => undefined,
  allModelsCachePath: () => "/tmp/test-all-models.json",
}));

mock.module("../providers/model-catalog-resolver.js", () => ({
  getResolver: (provider: string) => {
    // `mockResolverNull` lets the L1 test exercise the otherwise-unreachable
    // defensive branch in catalog-warm.ts where the OpenRouter resolver is
    // somehow not registered. Reset to false in beforeEach.
    if (mockResolverNull) return null;
    if (provider !== "openrouter") return null;
    return {
      provider: "openrouter",
      resolveSync: () => null,
      warmCache: async () => {},
      isCacheWarm: () => false,
      ensureReady: async () => {},
      refreshCatalog: refreshSpy,
    };
  },
}));

// Now import the module under test. The two mocks above are wired in.
import {
  shouldWarmCatalog,
  classifyCatalogState,
  warmCatalogIfNeeded,
} from "./catalog-warm.js";

// ---------------------------------------------------------------------------
// shouldWarmCatalog (pure)
// ---------------------------------------------------------------------------

describe("shouldWarmCatalog", () => {
  test("ollama@ prefix → false", () => {
    expect(shouldWarmCatalog({ model: "ollama@llama3.2" })).toBe(false);
  });

  test("lmstudio@ prefix → false", () => {
    expect(shouldWarmCatalog({ model: "lmstudio@my-model" })).toBe(false);
  });

  test("http://localhost prefix → false", () => {
    expect(shouldWarmCatalog({ model: "http://localhost:11434/foo" })).toBe(false);
  });

  test("http://127.0.0.1 prefix → false", () => {
    expect(shouldWarmCatalog({ model: "http://127.0.0.1:8080/x" })).toBe(false);
  });

  test("https://localhost prefix → false", () => {
    expect(shouldWarmCatalog({ model: "https://localhost/foo" })).toBe(false);
  });

  test("https://127.0.0.1 prefix → false", () => {
    expect(shouldWarmCatalog({ model: "https://127.0.0.1/x" })).toBe(false);
  });

  test("--skip-models-update with model → false", () => {
    expect(
      shouldWarmCatalog({ model: "gpt-4o", skipModelsUpdate: true })
    ).toBe(false);
  });

  test("--skip-models-update without model → false", () => {
    expect(shouldWarmCatalog({ skipModelsUpdate: true })).toBe(false);
  });

  test("undefined model (auto-route) → true", () => {
    expect(shouldWarmCatalog({})).toBe(true);
  });

  test("aggregator prefix or@ → true", () => {
    expect(shouldWarmCatalog({ model: "or@x" })).toBe(true);
  });

  test("native prefix g@ → true", () => {
    expect(shouldWarmCatalog({ model: "g@x" })).toBe(true);
  });

  test("bare model id gpt-4o → true", () => {
    expect(shouldWarmCatalog({ model: "gpt-4o" })).toBe(true);
  });

  test("mixed-case URL prefix HTTP://localhost → false (case-insensitive)", () => {
    expect(shouldWarmCatalog({ model: "HTTP://localhost:11434/foo" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// classifyCatalogState (pure)
// ---------------------------------------------------------------------------

describe("classifyCatalogState", () => {
  const NOW = new Date("2026-05-08T12:00:00.000Z");

  function diskCache(overrides: Partial<DiskCacheV2> = {}): DiskCacheV2 {
    return {
      version: 2,
      lastUpdated: NOW.toISOString(),
      entries: [{ modelId: "alpha", aliases: [], sources: {} }],
      models: [{ id: "vendor/alpha" }],
      ...overrides,
    };
  }

  test("null cache → missing", () => {
    expect(classifyCatalogState(null, 24, NOW)).toBe("missing");
  });

  test("empty entries+models → missing", () => {
    expect(
      classifyCatalogState(diskCache({ entries: [], models: [] }), 24, NOW)
    ).toBe("missing");
  });

  test("malformed lastUpdated → missing", () => {
    expect(
      classifyCatalogState(diskCache({ lastUpdated: "not-a-date" }), 24, NOW)
    ).toBe("missing");
  });

  test("age 1h, ttl 24 → fresh", () => {
    const oneHourAgo = new Date(NOW.getTime() - 1 * 3_600_000).toISOString();
    expect(
      classifyCatalogState(diskCache({ lastUpdated: oneHourAgo }), 24, NOW)
    ).toBe("fresh");
  });

  test("age 25h, ttl 24 → stale", () => {
    const twentyFiveHoursAgo = new Date(
      NOW.getTime() - 25 * 3_600_000
    ).toISOString();
    expect(
      classifyCatalogState(
        diskCache({ lastUpdated: twentyFiveHoursAgo }),
        24,
        NOW
      )
    ).toBe("stale");
  });

  test("age exactly TTL boundary → stale (uses strict <)", () => {
    const exactlyTtlAgo = new Date(NOW.getTime() - 24 * 3_600_000).toISOString();
    expect(
      classifyCatalogState(diskCache({ lastUpdated: exactlyTtlAgo }), 24, NOW)
    ).toBe("stale");
  });
});

// ---------------------------------------------------------------------------
// warmCatalogIfNeeded (dispatcher with mocks)
// ---------------------------------------------------------------------------

describe("warmCatalogIfNeeded", () => {
  let stderrChunks: string[];
  let originalWrite: typeof process.stderr.write;
  const NOW = new Date("2026-05-08T12:00:00.000Z");

  function makeConfig(overrides: Partial<ClaudishConfig> = {}): ClaudishConfig {
    return {
      autoApprove: false,
      dangerous: false,
      interactive: false,
      debug: false,
      logLevel: "info",
      quiet: true, // suppress preparing/indexed lines unless a test opts in
      jsonOutput: false,
      monitor: false,
      stdin: false,
      claudeArgs: [],
      noLogs: false,
      diagMode: "off",
      ...overrides,
    } as ClaudishConfig;
  }

  function freshCache(): DiskCacheV2 {
    return {
      version: 2,
      lastUpdated: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(), // 1h old
      entries: [{ modelId: "alpha", aliases: [], sources: {} }],
      models: [{ id: "vendor/alpha" }],
    };
  }

  function staleCache(): DiskCacheV2 {
    return {
      version: 2,
      lastUpdated: new Date(NOW.getTime() - 30 * 60 * 60 * 1000).toISOString(), // 30h old
      entries: [{ modelId: "alpha", aliases: [], sources: {} }],
      models: [{ id: "vendor/alpha" }],
    };
  }

  beforeEach(() => {
    stderrChunks = [];
    originalWrite = process.stderr.write.bind(process.stderr);
    // Capture stderr writes; return true to satisfy the WriteStream contract.
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (
      s: string
    ) => {
      stderrChunks.push(s);
      return true;
    };
    refreshSpy.mockClear();
    mockReadResult = null;
    mockRefreshOutcome = { kind: "refreshed", modelCount: 0 };
    mockResolverNull = false;
  });

  afterEach(() => {
    (process.stderr as unknown as { write: typeof originalWrite }).write =
      originalWrite;
  });

  test("--skip-models-update → 'skipped' and refreshCatalog NOT called", async () => {
    const config = makeConfig({ model: "gpt-4o", skipModelsUpdate: true });
    const result = await warmCatalogIfNeeded(config, { now: NOW });
    expect(result).toBe("skipped");
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  test("local model ollama@x → 'skipped' and refreshCatalog NOT called", async () => {
    const config = makeConfig({ model: "ollama@llama3.2" });
    const result = await warmCatalogIfNeeded(config, { now: NOW });
    expect(result).toBe("skipped");
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  test("fresh cache + !forceUpdate → 'ok' without calling refreshCatalog", async () => {
    mockReadResult = freshCache();
    const config = makeConfig({ model: "gpt-4o" });
    const result = await warmCatalogIfNeeded(config, { now: NOW });
    expect(result).toBe("ok");
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  test("fresh cache + forceUpdate=true → calls refreshCatalog → 'ok'", async () => {
    mockReadResult = freshCache();
    mockRefreshOutcome = { kind: "refreshed", modelCount: 42 };
    const config = makeConfig({ model: "gpt-4o", forceUpdate: true });
    const result = await warmCatalogIfNeeded(config, { now: NOW });
    expect(result).toBe("ok");
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy).toHaveBeenCalledWith(8000);
  });

  test("stale cache + refreshed → 'ok'", async () => {
    mockReadResult = staleCache();
    mockRefreshOutcome = { kind: "refreshed", modelCount: 13 };
    const config = makeConfig({ model: "gpt-4o" });
    const result = await warmCatalogIfNeeded(config, { now: NOW });
    expect(result).toBe("ok");
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  test("stale cache + fetch_failed → 'warned' with WARNING line on stderr", async () => {
    mockReadResult = staleCache();
    mockRefreshOutcome = { kind: "fetch_failed", reason: "network" };
    const config = makeConfig({ model: "gpt-4o", quiet: false });
    const result = await warmCatalogIfNeeded(config, { now: NOW });
    expect(result).toBe("warned");
    const stderrText = stderrChunks.join("");
    expect(stderrText).toContain("WARNING: Catalog stale");
    expect(stderrText).toContain("--force-update");
  });

  test("missing cache + refreshed → 'ok'", async () => {
    mockReadResult = null;
    mockRefreshOutcome = { kind: "refreshed", modelCount: 7 };
    const config = makeConfig({ model: "gpt-4o" });
    const result = await warmCatalogIfNeeded(config, { now: NOW });
    expect(result).toBe("ok");
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  test("missing cache + fetch_failed → 'hard_fail' with verbatim error on stderr", async () => {
    mockReadResult = null;
    mockRefreshOutcome = { kind: "fetch_failed", reason: "network" };
    const config = makeConfig({ model: "gpt-4o" });
    const result = await warmCatalogIfNeeded(config, { now: NOW });
    expect(result).toBe("hard_fail");

    const stderrText = stderrChunks.join("");
    // Verbatim FR-4 message expected.
    expect(stderrText).toContain(
      "Error: cannot reach model catalog and no cached copy found."
    );
    expect(stderrText).toContain("Check network connection");
    expect(stderrText).toContain(
      "Use a local model: claudish --model ollama@llama3.2 'task'"
    );
    expect(stderrText).toContain(
      "Skip catalog (advanced): claudish --skip-models-update 'task'"
    );
    expect(stderrText).toContain(
      "Claudish will not launch without catalog data when using cloud models."
    );
  });

  test("missing cache + null resolver → 'hard_fail' (defensive branch)", async () => {
    // Simulate the otherwise-unreachable case where getResolver returns null
    // (the OpenRouter resolver is normally auto-registered at module import).
    // Combined with a missing cache, the dispatcher should still hard-fail
    // with the verbatim FR-4 message rather than crash.
    mockReadResult = null;
    mockResolverNull = true;
    const config = makeConfig({ model: "gpt-4o" });
    const result = await warmCatalogIfNeeded(config, { now: NOW });
    expect(result).toBe("hard_fail");
    expect(refreshSpy).not.toHaveBeenCalled();
    const stderrText = stderrChunks.join("");
    expect(stderrText).toContain(
      "Error: cannot reach model catalog and no cached copy found."
    );
  });

  test("stale cache aged exactly 24h + fetch_failed → WARNING uses singular '1 day'", async () => {
    // Verifies humanizeAge pluralization (L2): a cache aged exactly 24h
    // should render as "1 day", not "1 days". The cache is stale at the
    // 24h boundary because classifyCatalogState uses strict-less-than.
    const oneDayAgo = new Date(NOW.getTime() - 24 * 3_600_000).toISOString();
    mockReadResult = {
      version: 2,
      lastUpdated: oneDayAgo,
      entries: [{ modelId: "alpha", aliases: [], sources: {} }],
      models: [{ id: "vendor/alpha" }],
    };
    mockRefreshOutcome = { kind: "fetch_failed", reason: "network" };
    const config = makeConfig({ model: "gpt-4o", quiet: false });
    const result = await warmCatalogIfNeeded(config, { now: NOW });
    expect(result).toBe("warned");
    const stderrText = stderrChunks.join("");
    expect(stderrText).toContain("1 day");
    expect(stderrText).not.toContain("1 days");
  });
});
