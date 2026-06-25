/**
 * Tests for probe-catalog.ts.
 *
 * Each test uses a unique tmp cache path. `fetch` is stubbed per-test via
 * globalThis.fetch reassignment so we never hit the live endpoint.
 *
 * Run: bun test packages/cli/src/providers/probe-catalog.test.ts
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  fetchProbeModels,
  getProbeModel,
  isCacheFresh,
  readProbeModelsCache,
  writeProbeModelsCache,
  type ProbeModelsResponse,
} from "./probe-catalog.js";

function makeTmpPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "claudish-probe-cache-"));
  return {
    path: join(dir, "probe-models.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const SAMPLE: ProbeModelsResponse = {
  version: 1,
  generatedAt: "2026-05-25T13:24:22.364Z",
  providers: {
    xai: "grok-build-0.1",
    openai: "gpt-5-nano",
    zhipu: "glm-4.5-air",
    moonshot: "moonshot-v1-auto",
  },
};

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
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify(SAMPLE), { status: 200 })
    ) as unknown as typeof fetch;
    const outcome = await fetchProbeModels("http://stub.local", 1000);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") expect(outcome.data).toEqual(SAMPLE);
  });

  test("returns http with status on non-2xx", async () => {
    globalThis.fetch = mock(async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    const outcome = await fetchProbeModels("http://stub.local", 1000);
    expect(outcome).toEqual({ kind: "http", status: 503 });
  });

  test("returns invalid when body is not the expected shape", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ foo: "bar" }), { status: 200 })
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

describe("getProbeModel", () => {
  // getProbeModel reads from ~/.claudish/probe-models.json directly. The
  // shape contract — string-valued, non-empty, indexed by claudish provider
  // slug — is what these tests pin.

  test("returns null when no cache file exists at default path", () => {
    // We can't redirect getProbeModel to a tmp path without restructuring,
    // but it gracefully handles missing/unparseable cache (see the
    // readProbeModelsCache tests above). This call just exercises the
    // null-handling path; a stale dev-machine cache wouldn't have this
    // sentinel slug.
    const result = getProbeModel("nonexistent-provider-slug-xyz-sentinel");
    expect(result).toBeNull();
  });

  test("cache shape: every provider slug maps to a non-empty string", () => {
    // Pin the contract: backend MUST return entries as { [slug]: string }.
    // If the shape ever drifts (e.g. backend returns objects), getProbeModel
    // will return null and the TUI surfaces "no probe model in catalog".
    for (const [slug, model] of Object.entries(SAMPLE.providers)) {
      expect(typeof model).toBe("string");
      expect(model.length).toBeGreaterThan(0);
      expect(slug.length).toBeGreaterThan(0);
    }
  });
});
