/**
 * Tests for probe-catalog.ts.
 *
 * Each test uses a unique tmp cache path. `fetch` is stubbed per-test via
 * globalThis.fetch reassignment so we never hit the live endpoint.
 *
 * Run: bun test packages/cli/src/providers/probe-catalog.test.ts
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type ProbeModelsResponse,
  describeProbeCatalogFailure,
  fetchProbeModels,
  isCacheFresh,
  readProbeModelsCache,
  writeProbeModelsCache,
} from "./probe-catalog.js";

function makeTmpPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "claudish-probe-cache-"));
  return {
    path: join(dir, "probe-models.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const SAMPLE: ProbeModelsResponse = {
  version: 3,
  generationId: "test-generation",
  generatedAt: "2026-05-25T13:24:22.364Z",
  providers: {
    xai: "grok-build-0.1",
    openai: "gpt-5-nano",
    zhipu: "glm-4.5-air",
    moonshot: "moonshot-v1-auto",
  },
  unavailable: {},
};

const REAL_426_BODY =
  '{"contractVersion":3,"error":{"code":"catalog_client_upgrade_required","message":"This endpoint requires catalog contract version 3","minimumContractVersion":3}}';

const REAL_V3_PROBE_MODELS_BODY =
  '{"contractVersion":3,"generationId":"g-20260918072314542-9c5a9567","generatedAt":"2026-09-18T07:23:14.542Z","data":{"routes":{"deepseek/direct-api":{"modelId":"deepseek-v4.1-flash","externalModelId":"deepseek-flash","route":{"routeId":"deepseek","routeProfileId":"direct-api"},"confidence":"api_official"}},"unavailableRoutes":{"google/antigravity-subscription":{"route":{"routeId":"google","routeProfileId":"antigravity-subscription"},"reason":"client_model_selection_required"},"poe/gateway":{"route":{"routeId":"poe","routeProfileId":"gateway"},"reason":"no_verified_probe_model"}}}}';

describe("readProbeModelsCache / writeProbeModelsCache", () => {
  let tmp: ReturnType<typeof makeTmpPath>;
  beforeEach(() => {
    tmp = makeTmpPath();
  });
  afterEach(() => tmp.cleanup());

  test("returns null when file does not exist", () => {
    expect(readProbeModelsCache(tmp.path)).toBeNull();
  });

  test("roundtrips a valid response", () => {
    writeProbeModelsCache(SAMPLE, tmp.path);
    const read = readProbeModelsCache(tmp.path);
    expect(read).toEqual(SAMPLE);
  });

  test("returns null for unparseable JSON", () => {
    writeFileSync(tmp.path, "{not json", "utf-8");
    expect(readProbeModelsCache(tmp.path)).toBeNull();
  });

  test("returns null when providers map is missing", () => {
    writeFileSync(
      tmp.path,
      JSON.stringify({ version: 1, generatedAt: "2026-05-25T00:00:00Z" }),
      "utf-8"
    );
    expect(readProbeModelsCache(tmp.path)).toBeNull();
  });

  test("returns null when version field is wrong type", () => {
    writeFileSync(
      tmp.path,
      JSON.stringify({ version: "1", generatedAt: "2026-05-25T00:00:00Z", providers: {} }),
      "utf-8"
    );
    expect(readProbeModelsCache(tmp.path)).toBeNull();
  });

  test("creates parent directory if missing", () => {
    const nested = join(tmp.path, "..", "nested", "dir", "probe-models.json");
    writeProbeModelsCache(SAMPLE, nested);
    expect(existsSync(nested)).toBe(true);
  });
});

describe("isCacheFresh", () => {
  test("null cache is stale", () => {
    expect(isCacheFresh(null)).toBe(false);
  });

  test("recent cache is fresh", () => {
    const recent: ProbeModelsResponse = { ...SAMPLE, generatedAt: new Date().toISOString() };
    expect(isCacheFresh(recent)).toBe(true);
  });

  test("cache older than the (1h) default TTL is stale", () => {
    // 2h old is stale under the 1h default TTL.
    const oldDate = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const old: ProbeModelsResponse = { ...SAMPLE, generatedAt: oldDate };
    expect(isCacheFresh(old)).toBe(false);
  });

  test("cache 30 min old is fresh under the (1h) default TTL", () => {
    const recent: ProbeModelsResponse = {
      ...SAMPLE,
      generatedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    };
    expect(isCacheFresh(recent)).toBe(true);
  });

  test("respects custom TTL", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const cache: ProbeModelsResponse = { ...SAMPLE, generatedAt: fiveMinAgo };
    expect(isCacheFresh(cache, 10 * 60 * 1000)).toBe(true);
    expect(isCacheFresh(cache, 60 * 1000)).toBe(false);
  });

  test("malformed date is stale", () => {
    const cache: ProbeModelsResponse = { ...SAMPLE, generatedAt: "not-a-date" };
    expect(isCacheFresh(cache)).toBe(false);
  });
});

describe("fetchProbeModels", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("returns ok with parsed response on 200", async () => {
    globalThis.fetch = mock(
      async () => new Response(REAL_V3_PROBE_MODELS_BODY, { status: 200 })
    ) as unknown as typeof fetch;
    const outcome = await fetchProbeModels("http://stub.local", 1000);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.data.providers).toEqual({ deepseek: "deepseek-flash" });
      expect(outcome.data.unavailable).toEqual({
        antigravity: "client_model_selection_required",
        poe: "no_verified_probe_model",
      });
    }
  });

  test("returns incompatible with the server contract version on 426", async () => {
    globalThis.fetch = mock(
      async () => new Response(REAL_426_BODY, { status: 426 })
    ) as unknown as typeof fetch;
    const outcome = await fetchProbeModels("http://stub.local", 1000);
    expect(outcome).toEqual({ kind: "incompatible", serverContractVersion: 3 });
  });

  test("returns incompatible with an unknown server contract version on an empty 426", async () => {
    globalThis.fetch = mock(
      async () => new Response(null, { status: 426 })
    ) as unknown as typeof fetch;
    const outcome = await fetchProbeModels("http://stub.local", 1000);
    expect(outcome).toEqual({ kind: "incompatible", serverContractVersion: null });
  });

  test("maps exact provider routes in a v3 response", async () => {
    globalThis.fetch = mock(
      async () => new Response(REAL_V3_PROBE_MODELS_BODY, { status: 200 })
    ) as unknown as typeof fetch;
    const outcome = await fetchProbeModels("http://stub.local", 1000);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.data.providers).toEqual({ deepseek: "deepseek-flash" });
      expect(outcome.data.unavailable).toEqual({
        antigravity: "client_model_selection_required",
        poe: "no_verified_probe_model",
      });
    }
  });

  test("returns http with status on a non-contract non-2xx response with no body", async () => {
    globalThis.fetch = mock(
      async () => new Response(null, { status: 503 })
    ) as unknown as typeof fetch;
    const outcome = await fetchProbeModels("http://stub.local", 1000);
    expect(outcome).toEqual({ kind: "http", status: 503 });
  });

  test("returns invalid when body is not the expected shape", async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ foo: "bar" }), { status: 200 })
    ) as unknown as typeof fetch;
    const outcome = await fetchProbeModels("http://stub.local", 1000);
    expect(outcome.kind).toBe("invalid");
  });

  test("returns network on thrown error", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const outcome = await fetchProbeModels("http://stub.local", 1000);
    expect(outcome.kind).toBe("network");
    if (outcome.kind === "network") expect(outcome.reason).toContain("ECONNREFUSED");
  });

  test("returns timeout on AbortSignal timeout", async () => {
    globalThis.fetch = mock(async () => {
      const err = new Error("aborted");
      err.name = "TimeoutError";
      throw err;
    }) as unknown as typeof fetch;
    const outcome = await fetchProbeModels("http://stub.local", 1000);
    expect(outcome).toEqual({ kind: "timeout" });
  });
});

describe("describeProbeCatalogFailure", () => {
  test("describes a known incompatible version without blaming connectivity", () => {
    const message = describeProbeCatalogFailure({
      kind: "incompatible",
      serverContractVersion: 3,
    });
    expect(message).toContain("contract v3");
    expect(message).not.toContain("could not reach");
  });

  test("describes an unknown incompatible version without blaming connectivity", () => {
    const message = describeProbeCatalogFailure({
      kind: "incompatible",
      serverContractVersion: null,
    });
    expect(message).not.toContain("could not reach");
  });

  test("describes timeout and network failures as connectivity failures", () => {
    expect(describeProbeCatalogFailure({ kind: "timeout" })).toContain("could not reach");
    expect(describeProbeCatalogFailure({ kind: "network", reason: "ECONNREFUSED" })).toContain(
      "could not reach"
    );
  });

  test("includes the HTTP status in an HTTP failure", () => {
    expect(describeProbeCatalogFailure({ kind: "http", status: 503 })).toContain("503");
  });
});

describe("getProbeModel", () => {
  // getProbeModel reads from ~/.claudish/probe-models.json directly. The
  // shape contract — string-valued, non-empty, indexed by claudish provider
  // slug — is what these tests pin.
});
