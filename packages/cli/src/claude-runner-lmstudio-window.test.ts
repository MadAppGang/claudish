/**
 * The launch context window for the claudish provider `lmstudio`.
 *
 * A local server runs a model with its own load settings, so the vendor's
 * window in the cloud models catalog says nothing about it. Only a loaded
 * instance reports a window; every other case uses the provider's default.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import * as modelCatalog from "./adapters/model-catalog.js";
import { computeMainThreadContextWindow, resolveContextWindowEnv } from "./claude-runner.js";
import { invalidateModelDiscovery } from "./providers/model-discovery.js";
import type { ClaudishConfig } from "./types.js";

const LMSTUDIO_DEFAULT_WINDOW = 64_000;
const VENDOR_WINDOW = 1_000_000;
const LOADED_WINDOW = 213_176;

const ROWS = [
  {
    id: "loaded-build",
    type: "llm",
    state: "loaded",
    max_context_length: 262_144,
    loaded_context_length: LOADED_WINDOW,
  },
  { id: "unloaded-build", type: "llm", state: "not-loaded", max_context_length: 262_144 },
];

const realFetch = globalThis.fetch;
let savedBaseUrl: string | undefined;
let catalogSpy: ReturnType<typeof spyOn<typeof modelCatalog, "lookupModelForProvider">>;

function launchWindow(model: string): Promise<number> {
  return computeMainThreadContextWindow({ model } as ClaudishConfig);
}

beforeEach(() => {
  invalidateModelDiscovery();
  savedBaseUrl = process.env.LMSTUDIO_BASE_URL;
  delete process.env.LMSTUDIO_BASE_URL;
  catalogSpy = spyOn(modelCatalog, "lookupModelForProvider").mockReturnValue(VENDOR_WINDOW);
  globalThis.fetch = mock(
    async () => new Response(JSON.stringify({ data: ROWS }), { status: 200 })
  ) as unknown as typeof fetch;
});

afterEach(() => {
  catalogSpy.mockRestore();
  globalThis.fetch = realFetch;
  invalidateModelDiscovery();
  if (savedBaseUrl === undefined) delete process.env.LMSTUDIO_BASE_URL;
  else process.env.LMSTUDIO_BASE_URL = savedBaseUrl;
});

describe("computeMainThreadContextWindow on lmstudio", () => {
  test("a loaded model uses the window of its loaded instance", async () => {
    expect(await launchWindow("lms@loaded-build")).toBe(LOADED_WINDOW);
  });

  test("an unloaded model uses the provider default, not the vendor window", async () => {
    expect(await launchWindow("lms@unloaded-build")).toBe(LMSTUDIO_DEFAULT_WINDOW);
  });

  test("a model the server does not list uses the provider default", async () => {
    expect(await launchWindow("lms@not-listed")).toBe(LMSTUDIO_DEFAULT_WINDOW);
  });

  test("an unreachable server uses the provider default", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;

    expect(await launchWindow("lms@unloaded-build")).toBe(LMSTUDIO_DEFAULT_WINDOW);
  });

  test("the default reaches Claude Code as its max-context cap", async () => {
    const { vars } = resolveContextWindowEnv(await launchWindow("lms@unloaded-build"), {});

    expect(vars).toEqual({ CLAUDE_CODE_MAX_CONTEXT_TOKENS: "64000" });
  });
});
