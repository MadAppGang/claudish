import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MIN_AUTO_COMPACT_WINDOW,
  computeMainThreadContextWindow,
  resolveContextWindowEnv,
} from "./claude-runner.js";
import { ENV } from "./config.js";
import { catalogRouteForProvider } from "./providers/catalog-route-bindings.js";
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
  test("regression: setting the max-context cap fails without the clamp fix", () => {
    const { vars } = resolveContextWindowEnv(1_048_576, {});

    expect(vars[ENV.CLAUDE_CODE_MAX_CONTEXT_TOKENS]).toBe("1048576");
  });

  test("sets the auto-compact window and reports the token count", () => {
    const realWindow = 1_048_576;

    const { vars, notice } = resolveContextWindowEnv(realWindow, {});

    expect(vars[ENV.CLAUDE_CODE_AUTO_COMPACT_WINDOW]).toBe("1048576");
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
    expect(vars[ENV.CLAUDE_CODE_AUTO_COMPACT_WINDOW]).toBe("1048576");
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
