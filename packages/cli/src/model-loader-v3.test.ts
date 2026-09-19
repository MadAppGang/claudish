import { afterEach, describe, expect, mock, test } from "bun:test";
import { getModelsByProvider } from "./model-loader.js";
import { CATALOG_V3_ACCEPT } from "./providers/catalog-v3.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const envelope = (
  models: Array<{ modelId: string }>,
  nextCursor?: string,
  generationId = "generation-a"
) =>
  Response.json({
    contractVersion: 3,
    generationId,
    generatedAt: "2026-09-19T01:33:46.169Z",
    data: { models, total: 3, ...(nextCursor ? { nextCursor } : {}) },
  });

describe("v3 provider-scoped pagination", () => {
  test("returns the complete provider roster from one generation", async () => {
    const requests: Array<{
      cursor: string | null;
      generation: string | null;
      accept: string | null;
    }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({
        cursor: url.searchParams.get("cursor"),
        generation: url.searchParams.get("generationId"),
        accept: new Headers(init?.headers).get("accept"),
      });
      return url.searchParams.has("cursor")
        ? envelope([{ modelId: "qwen3.8-max" }])
        : envelope([{ modelId: "qwen3.7-plus" }, { modelId: "qwen3.6-plus" }], "opaque-cursor");
    }) as unknown as typeof fetch;

    expect((await getModelsByProvider("qwen", 2)).map((model) => model.modelId)).toEqual([
      "qwen3.7-plus",
      "qwen3.6-plus",
      "qwen3.8-max",
    ]);
    expect(requests).toEqual([
      { cursor: null, generation: null, accept: CATALOG_V3_ACCEPT },
      { cursor: "opaque-cursor", generation: "generation-a", accept: CATALOG_V3_ACCEPT },
    ]);
  });

  test("rejects a later page from another generation", async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) =>
      new URL(String(input)).searchParams.has("cursor")
        ? envelope([{ modelId: "qwen3.8-max" }], undefined, "generation-b")
        : envelope([{ modelId: "qwen3.7-plus" }, { modelId: "qwen3.6-plus" }], "opaque-cursor")
    ) as unknown as typeof fetch;
    await expect(getModelsByProvider("qwen", 2)).rejects.toThrow("generation changed");
  });
});
