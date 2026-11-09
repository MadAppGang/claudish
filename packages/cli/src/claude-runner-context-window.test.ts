import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lookupModelForProvider } from "./adapters/model-catalog.js";
import { credentials } from "./auth/credentials/authority.js";
import {
  MAX_AUTO_COMPACT_WINDOW,
  MIN_AUTO_COMPACT_WINDOW,
  computeMainThreadContextWindow,
  resolveContextWindowEnv,
} from "./claude-runner.js";
import { ENV } from "./config.js";
import { catalogRouteForProvider } from "./providers/catalog-route-bindings.js";
import {
  _resetAccountModelsListsForTest,
  readAccountModelsList,
} from "./providers/dynamic-models-catalog.js";
import { discoverContextWindow, invalidateModelDiscovery } from "./providers/model-discovery.js";
import type { ClaudishConfig } from "./types.js";

const REDUCED_WINDOW_SPEC = "cx@gpt-5.6-sol";
const LARGER_WINDOW_SPEC = "oai@gpt-5.6-sol";
const BELOW_AUTO_COMPACT_FLOOR_SPEC = "cx@small-context-model";

let tmpDir: string;
let mockCachePath: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "claudish-main-thread-window-test-"));
  mockCachePath = join(tmpDir, "all-models.json");

  const entries = [
    {
      modelId: "k3",
      aliases: [],
      contextWindow: 1_048_576,
      aggregators: [
        {
          sourceCollectorId: "test",
          routeStatus: "mapped",
          route: catalogRouteForProvider("kimi-coding"),
          sourceProviderId: "kimi-coding",
          externalModelId: "k3",
          confidence: "api_official",
          contextWindow: 131_072,
        },
      ],
    },
    {
      modelId: "gpt-5.6-sol",
      aliases: [],

      contextWindow: 1_050_000,
      aggregators: [
        {
          sourceCollectorId: "test",
          routeStatus: "mapped",
          route: catalogRouteForProvider("openai"),
          sourceProviderId: "openai",
          externalModelId: "gpt-5.6-sol",
          confidence: "api_official",
          contextWindow: 1_050_000,
        },
        {
          sourceCollectorId: "test",
          routeStatus: "mapped",
          route: catalogRouteForProvider("openai-codex"),
          sourceProviderId: "openai-codex",
          externalModelId: "gpt-5.6-sol",
          confidence: "api_official",
          contextWindow: 372_000,
        },
        {
          sourceCollectorId: "test",
          routeStatus: "mapped",
          route: catalogRouteForProvider("openrouter"),
          sourceProviderId: "openrouter",
          externalModelId: "openai/gpt-5.6-sol",
          confidence: "gateway_official",
        },
      ],
    },
    {
      modelId: "small-context-model",
      aliases: [],

      contextWindow: 128_000,
      aggregators: [
        {
          sourceCollectorId: "test",
          routeStatus: "mapped",
          route: catalogRouteForProvider("openai-codex"),
          sourceProviderId: "openai-codex",
          externalModelId: "small-context-model",
          confidence: "api_official",
          contextWindow: 128_000,
        },
      ],
    },
  ];

  writeFileSync(
    mockCachePath,
    JSON.stringify({
      catalogGenerationId: "test-generation",
      plans: [],
      version: 3,
      lastUpdated: new Date().toISOString(),
      entries,
      models: entries.map((entry) => ({ id: entry.modelId })),
    }),
    "utf-8"
  );
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("computeMainThreadContextWindow", () => {
  test("58. launch reads the stored window without discovery", async () => {
    const home = mkdtempSync(join(tmpdir(), "claudish-stored-launch-window-"));
    const previousDir = process.env.CLAUDISH_DYNAMIC_CATALOG_DIR;
    const previousKey = process.env.CLAUDISH_DYNAMIC_CATALOG_KEY;
    const realFetch = globalThis.fetch;
    const options = {
      dir: join(home, "dynamic-models-catalog"),
      keyPath: join(home, "dynamic-models-catalog.key"),
    };
    process.env.CLAUDISH_DYNAMIC_CATALOG_DIR = options.dir;
    process.env.CLAUDISH_DYNAMIC_CATALOG_KEY = options.keyPath;
    try {
      const catalog = await import("./providers/dynamic-models-catalog.js");
      const store = await import("./providers/dynamic-models-catalog-store.js");
      const { credentials } = await import("./auth/credentials/authority.js");
      const { invalidateModelDiscovery } = await import("./providers/model-discovery.js");
      const original = {
        identity: credentials.accountIdentity,
        readiness: credentials.describeReadiness,
        auth: credentials.getRequestAuth,
      };
      const fetcher = mock(async () => {
        throw new Error("Launch must use the stored window");
      });
      globalThis.fetch = fetcher as unknown as typeof fetch;
      credentials.accountIdentity = mock(async (provider: string) =>
        provider === "kimi-coding" ? "A" : undefined
      );
      credentials.describeReadiness = mock(async (provider: string) => ({
        readiness: provider === "kimi-coding" ? ("present" as const) : ("absent" as const),
      }));
      credentials.getRequestAuth = mock(async () => ({
        headers: { Authorization: "Bearer offline-test" },
      }));
      try {
        catalog._resetAccountModelsListsForTest();
        invalidateModelDiscovery();
        const key = store.deriveAccountKey("kimi-coding", "A", options);
        expect(key.ok).toBe(true);
        if (!key.ok) throw new Error(key.reason);
        expect(
          store.writeStoredModelsList(
            "kimi-coding",
            key.accountKey,
            [{ id: "k3", contextWindow: 262144, reported: "chat" }],
            { ...options, now: () => Date.now() - 2 * 3600000 }
          )
        ).toBe(true);
        const config = { model: "kc@k3" } as ClaudishConfig;
        expect(await computeMainThreadContextWindow(config, mockCachePath)).toBe(262144);
        expect(fetcher).not.toHaveBeenCalled();
        expect(credentials.getRequestAuth).not.toHaveBeenCalled();
      } finally {
        credentials.accountIdentity = original.identity;
        credentials.describeReadiness = original.readiness;
        credentials.getRequestAuth = original.auth;
        catalog._resetAccountModelsListsForTest();
        invalidateModelDiscovery();
      }
    } finally {
      globalThis.fetch = realFetch;
      if (previousDir === undefined) delete process.env.CLAUDISH_DYNAMIC_CATALOG_DIR;
      else process.env.CLAUDISH_DYNAMIC_CATALOG_DIR = previousDir;
      if (previousKey === undefined) delete process.env.CLAUDISH_DYNAMIC_CATALOG_KEY;
      else process.env.CLAUDISH_DYNAMIC_CATALOG_KEY = previousKey;
      rmSync(home, { recursive: true, force: true });
    }
  });

  describe("discovery must not block launch without a stored list", () => {
    let home: string;
    let previousDir: string | undefined;
    let previousKey: string | undefined;
    let realFetch: typeof globalThis.fetch;
    let originalIdentity: typeof credentials.accountIdentity;
    let originalReadiness: typeof credentials.describeReadiness;
    let originalAuth: typeof credentials.getRequestAuth;

    // No socket or timer backs this promise: discovery cannot finish during a
    // launch, and it cannot leave an I/O handle behind after the test either.
    const fetcher = mock((_input: RequestInfo | URL): Promise<Response> => new Promise(() => {}));

    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), "claudish-cold-launch-window-"));
      previousDir = process.env.CLAUDISH_DYNAMIC_CATALOG_DIR;
      previousKey = process.env.CLAUDISH_DYNAMIC_CATALOG_KEY;
      process.env.CLAUDISH_DYNAMIC_CATALOG_DIR = join(home, "dynamic-models-catalog");
      process.env.CLAUDISH_DYNAMIC_CATALOG_KEY = join(home, "dynamic-models-catalog.key");
      realFetch = globalThis.fetch;
      originalIdentity = credentials.accountIdentity;
      originalReadiness = credentials.describeReadiness;
      originalAuth = credentials.getRequestAuth;
      credentials.accountIdentity = mock(async (provider: string) =>
        provider === "kimi-coding" ? "offline-launch-account" : undefined
      );
      credentials.describeReadiness = mock(async (provider: string) => ({
        readiness: provider === "kimi-coding" ? ("present" as const) : ("absent" as const),
      }));
      credentials.getRequestAuth = mock(async () => ({
        headers: { Authorization: "Bearer offline-test" },
      }));
      fetcher.mockReset();
      fetcher.mockImplementation(() => new Promise<Response>(() => {}));
      globalThis.fetch = fetcher as unknown as typeof fetch;
      _resetAccountModelsListsForTest();
      invalidateModelDiscovery();
    });

    afterEach(() => {
      _resetAccountModelsListsForTest();
      invalidateModelDiscovery();
      globalThis.fetch = realFetch;
      credentials.accountIdentity = originalIdentity;
      credentials.describeReadiness = originalReadiness;
      credentials.getRequestAuth = originalAuth;
      if (previousDir === undefined) delete process.env.CLAUDISH_DYNAMIC_CATALOG_DIR;
      else process.env.CLAUDISH_DYNAMIC_CATALOG_DIR = previousDir;
      if (previousKey === undefined) delete process.env.CLAUDISH_DYNAMIC_CATALOG_KEY;
      else process.env.CLAUDISH_DYNAMIC_CATALOG_KEY = previousKey;
      rmSync(home, { recursive: true, force: true });
    });

    test("returns the provider's cloud models catalog window while one background discovery never settles", async () => {
      expect(await readAccountModelsList("kimi-coding")).toBeNull();
      expect(lookupModelForProvider("k3", "kimi-coding", mockCachePath)).toBe(131_072);
      const launch = computeMainThreadContextWindow(
        { model: "kc@k3" } as ClaudishConfig,
        mockCachePath
      );

      // A tick lets fire-and-forget discovery start, but cannot finish it.
      await Bun.sleep(0);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher).toHaveBeenCalledWith(
        expect.stringMatching(/\/models$/),
        expect.objectContaining({ method: "GET" })
      );

      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const window = await Promise.race([
          launch,
          new Promise<string>((resolve) => {
            timer = setTimeout(() => resolve("launch still awaiting discovery after 750ms"), 750);
          }),
        ]);
        expect(window).toBe(131_072);
        await Bun.sleep(0);
        expect(fetcher).toHaveBeenCalledTimes(1);
      } finally {
        clearTimeout(timer);
      }
    });

    test.each([undefined, "await"] as const)(
      "discoverContextWindow with network=%s still waits for discovery",
      async (network) => {
        let answer!: (response: Response) => void;
        const response = new Promise<Response>((resolve) => {
          answer = resolve;
        });
        fetcher.mockImplementationOnce(() => response);
        let settled = false;
        const lookup = discoverContextWindow(
          "kimi-coding",
          "k3",
          network === undefined ? undefined : { network }
        ).then((window) => {
          settled = true;
          return window;
        });

        try {
          await Bun.sleep(0);
          expect(fetcher).toHaveBeenCalledTimes(1);
          expect(settled).toBe(false);
        } finally {
          answer(
            new Response(JSON.stringify({ data: [{ id: "k3", context_length: 524_288 }] }), {
              headers: { "Content-Type": "application/json" },
            })
          );
          await lookup;
        }
        expect(await lookup).toBe(524_288);
      }
    );
  });

  test("exposes the Claude Code auto-compaction floor", () => {
    expect(MIN_AUTO_COMPACT_WINDOW).toBe(200_000);
  });

  test("returns a catalog window below the floor so the caller can leave the env unset", async () => {
    const config = { model: BELOW_AUTO_COMPACT_FLOOR_SPEC } as unknown as ClaudishConfig;

    const window = await computeMainThreadContextWindow(config, mockCachePath);

    expect(window).toBe(128_000);
    expect(window).toBeLessThan(MIN_AUTO_COMPACT_WINDOW);
  });

  test("returns the explicit provider's reduced window instead of the top-level window", async () => {
    const config = { model: REDUCED_WINDOW_SPEC } as unknown as ClaudishConfig;

    const window = await computeMainThreadContextWindow(config, mockCachePath);

    expect(window).toBe(372_000);
    expect(window).not.toBe(1_050_000);
  });

  test("returns the minimum eligible window regardless of model assignment order", async () => {
    const reducedFirst = {
      model: REDUCED_WINDOW_SPEC,
      modelSonnet: LARGER_WINDOW_SPEC,
    } as unknown as ClaudishConfig;
    const largerFirst = {
      model: LARGER_WINDOW_SPEC,
      modelSonnet: REDUCED_WINDOW_SPEC,
    } as unknown as ClaudishConfig;

    expect(await computeMainThreadContextWindow(reducedFirst, mockCachePath)).toBe(372_000);
    expect(await computeMainThreadContextWindow(largerFirst, mockCachePath)).toBe(372_000);
  });

  test("ignores haiku and subagent windows when computing the main-thread window", async () => {
    const config = {
      model: LARGER_WINDOW_SPEC,
      modelOpus: LARGER_WINDOW_SPEC,
      modelSonnet: LARGER_WINDOW_SPEC,
      modelHaiku: REDUCED_WINDOW_SPEC,
      modelSubagent: REDUCED_WINDOW_SPEC,
    } as unknown as ClaudishConfig;

    expect(await computeMainThreadContextWindow(config, mockCachePath)).toBe(1_050_000);
  });

  test("returns zero when no main-thread model is configured", async () => {
    const config = {} as unknown as ClaudishConfig;

    expect(await computeMainThreadContextWindow(config, mockCachePath)).toBe(0);
  });

  test("returns zero when an explicit model is absent from the catalog", async () => {
    const config = { model: "cx@unknown-model" } as unknown as ClaudishConfig;

    expect(await computeMainThreadContextWindow(config, mockCachePath)).toBe(0);
  });
});

describe("resolveContextWindowEnv", () => {
  test("exposes the Claude Code auto-compaction ceiling", () => {
    expect(MAX_AUTO_COMPACT_WINDOW).toBe(1_000_000);
  });

  test("clamps a 1,050,000-token auto-compact window while preserving the real max-context cap", () => {
    const { vars } = resolveContextWindowEnv(1_050_000, {});

    expect(vars[ENV.CLAUDE_CODE_AUTO_COMPACT_WINDOW]).toBe("1000000");
    expect(vars[ENV.CLAUDE_CODE_MAX_CONTEXT_TOKENS]).toBe("1050000");
  });

  test("sets the auto-compact window exactly at the ceiling", () => {
    const { vars } = resolveContextWindowEnv(1_000_000, {});

    expect(vars[ENV.CLAUDE_CODE_AUTO_COMPACT_WINDOW]).toBe("1000000");
  });

  test("preserves a 372,000-token auto-compact window below the ceiling", () => {
    const { vars } = resolveContextWindowEnv(372_000, {});

    expect(vars[ENV.CLAUDE_CODE_AUTO_COMPACT_WINDOW]).toBe("372000");
  });

  test("regression: setting the max-context cap fails without the clamp fix", () => {
    const { vars } = resolveContextWindowEnv(1_048_576, {});

    expect(vars[ENV.CLAUDE_CODE_MAX_CONTEXT_TOKENS]).toBe("1048576");
  });

  test("sets the auto-compact window and reports the token count", () => {
    const realWindow = 1_048_576;

    const { vars, notice } = resolveContextWindowEnv(realWindow, {});

    expect(vars[ENV.CLAUDE_CODE_AUTO_COMPACT_WINDOW]).toBe("1000000");
    expect(notice).toContain(`${realWindow.toLocaleString()} tokens`);
  });

  test("sets the max-context cap below the auto-compact floor without setting the window", () => {
    const realWindow = 128_000;

    const { vars, notice } = resolveContextWindowEnv(realWindow, {});

    expect(vars[ENV.CLAUDE_CODE_MAX_CONTEXT_TOKENS]).toBe("128000");
    expect(vars).not.toHaveProperty(ENV.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
    expect(notice).toContain(
      `below Claude Code's ${MIN_AUTO_COMPACT_WINDOW.toLocaleString()}-token auto-compact floor`
    );
  });

  test("sets both variables exactly at the auto-compact floor", () => {
    const { vars } = resolveContextWindowEnv(MIN_AUTO_COMPACT_WINDOW, {});
    const expectedWindow = String(MIN_AUTO_COMPACT_WINDOW);

    expect(vars[ENV.CLAUDE_CODE_MAX_CONTEXT_TOKENS]).toBe(expectedWindow);
    expect(vars[ENV.CLAUDE_CODE_AUTO_COMPACT_WINDOW]).toBe(expectedWindow);
  });

  test("returns no variables or notice for zero and negative windows", () => {
    const zeroWindow = resolveContextWindowEnv(0, {});
    const negativeWindow = resolveContextWindowEnv(-1, {});

    expect(zeroWindow.vars).toEqual({});
    expect(zeroWindow.notice).toBeUndefined();
    expect(negativeWindow.vars).toEqual({});
    expect(negativeWindow.notice).toBeUndefined();
  });

  test("preserves a user auto-compact override while still raising the max-context cap", () => {
    const processEnv = {
      [ENV.CLAUDE_CODE_AUTO_COMPACT_WINDOW]: "300000",
    };

    const { vars, notice } = resolveContextWindowEnv(1_048_576, processEnv);

    expect(vars).not.toHaveProperty(ENV.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
    expect(vars[ENV.CLAUDE_CODE_MAX_CONTEXT_TOKENS]).toBe("1048576");
    expect(notice).toBeUndefined();
  });

  test("preserves a user max-context override while still setting the auto-compact window", () => {
    const processEnv = {
      [ENV.CLAUDE_CODE_MAX_CONTEXT_TOKENS]: "500000",
    };

    const { vars } = resolveContextWindowEnv(1_048_576, processEnv);

    expect(vars).not.toHaveProperty(ENV.CLAUDE_CODE_MAX_CONTEXT_TOKENS);
    expect(vars[ENV.CLAUDE_CODE_AUTO_COMPACT_WINDOW]).toBe("1000000");
  });

  test("returns no variables or notice when both values are user-overridden", () => {
    const processEnv = {
      [ENV.CLAUDE_CODE_AUTO_COMPACT_WINDOW]: "300000",
      [ENV.CLAUDE_CODE_MAX_CONTEXT_TOKENS]: "500000",
    };

    const { vars, notice } = resolveContextWindowEnv(1_048_576, processEnv);

    expect(vars).toEqual({});
    expect(notice).toBeUndefined();
  });

  test("does not mutate an explicit frozen environment or the ambient environment", () => {
    const processEnv = Object.freeze({
      [ENV.CLAUDE_CODE_AUTO_COMPACT_WINDOW]: "300000",
    });
    const processEnvSnapshot = { ...processEnv };
    const ambientEnvSnapshot = { ...process.env };

    const { vars } = resolveContextWindowEnv(1_048_576, processEnv);

    expect(processEnv).toEqual(processEnvSnapshot);
    expect(process.env).toEqual(ambientEnvSnapshot);
    expect(vars).not.toHaveProperty(ENV.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
    expect(vars[ENV.CLAUDE_CODE_MAX_CONTEXT_TOKENS]).toBe("1048576");
  });
});
