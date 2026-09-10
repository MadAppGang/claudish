import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

interface EndpointReply {
  status: number;
  body?: unknown;
}

interface RefreshChildResult {
  outcome: unknown;
  sentinel: unknown;
}

interface WarmCacheChildResult {
  before: unknown;
  after: unknown;
}

let tempHome = "";
let server: ReturnType<typeof Bun.serve> | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "claudish-catalog-client-contract-"));
});

afterEach(() => {
  server?.stop(true);
  server = undefined;
  rmSync(tempHome, { recursive: true, force: true });
  tempHome = "";
});

function startCatalogServer(
  modelsReply: EndpointReply,
  plansReply: EndpointReply = { status: 200, body: { contractVersion: 2, plans: [] } }
): { catalogUrl: string; plansUrl: string } {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      const reply = pathname === "/queryPlans" ? plansReply : modelsReply;
      return new Response(reply.body === undefined ? undefined : JSON.stringify(reply.body), {
        status: reply.status,
        headers: reply.body === undefined ? undefined : { "content-type": "application/json" },
      });
    },
  });

  return {
    catalogUrl: `http://127.0.0.1:${server.port}/queryModels`,
    plansUrl: `http://127.0.0.1:${server.port}/queryPlans`,
  };
}

async function runRefreshChild(urls: {
  catalogUrl: string;
  plansUrl: string;
}): Promise<RefreshChildResult> {
  const clientUrl = pathToFileURL(join(import.meta.dir, "catalog-client.ts")).href;
  const compatibilityUrl = pathToFileURL(join(import.meta.dir, "catalog-compatibility.ts")).href;
  const sentinelPath = join(tempHome, ".claudish", "catalog-incompatible.json");
  const source = `
    const compatibility = await import(${JSON.stringify(compatibilityUrl)});
    const client = await import(${JSON.stringify(clientUrl)});
    compatibility._resetCatalogCompatibilityForTest();
    client._resetCatalogClient();
    const outcome = await client.refreshCatalog(2_000);
    const sentinel = compatibility.readCatalogIncompatibility(
      ${JSON.stringify(sentinelPath)}
    );
    console.log(JSON.stringify({ outcome, sentinel }));
  `;
  const child = Bun.spawn([process.execPath, "-e", source], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      HOME: tempHome,
      CLAUDISH_CATALOG_URL: urls.catalogUrl,
      CLAUDISH_PLANS_URL: urls.plansUrl,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`catalog child exited ${exitCode}: ${stderr || stdout}`);
  }
  return JSON.parse(stdout.trim()) as RefreshChildResult;
}

async function runWarmCacheChild(urls: {
  catalogUrl: string;
  plansUrl: string;
}): Promise<WarmCacheChildResult> {
  const clientUrl = pathToFileURL(join(import.meta.dir, "catalog-client.ts")).href;
  const compatibilityUrl = pathToFileURL(join(import.meta.dir, "catalog-compatibility.ts")).href;
  const sentinelPath = join(tempHome, ".claudish", "catalog-incompatible.json");
  const source = `
    const compatibility = await import(${JSON.stringify(compatibilityUrl)});
    const client = await import(${JSON.stringify(clientUrl)});
    compatibility._resetCatalogCompatibilityForTest();
    client._resetCatalogClient();
    const before = client.getCatalogEntries();
    compatibility.markCatalogIncompatible(
      { serverContractVersion: 3, minimumContractVersion: 3 },
      ${JSON.stringify(sentinelPath)}
    );
    const after = client.getCatalogEntries();
    console.log(JSON.stringify({ before, after }));
  `;
  const child = Bun.spawn([process.execPath, "-e", source], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      HOME: tempHome,
      CLAUDISH_CATALOG_URL: urls.catalogUrl,
      CLAUDISH_PLANS_URL: urls.plansUrl,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`catalog child exited ${exitCode}: ${stderr || stdout}`);
  }
  return JSON.parse(stdout.trim()) as WarmCacheChildResult;
}

describe("catalog contract compatibility over HTTP", () => {
  test("refreshCatalog returns incompatible for a body-less 426 response", async () => {
    const urls = startCatalogServer({ status: 426 });

    const result = await runRefreshChild(urls);

    expect(result.outcome).toEqual({ kind: "incompatible", serverContractVersion: null });
    expect(result.sentinel).toMatchObject({ serverContractVersion: null });
  });

  test("any non-2xx response is incompatible when its body reports a newer contract", async () => {
    for (const status of [400, 410, 429, 503]) {
      server?.stop(true);
      server = undefined;
      const urls = startCatalogServer({
        status,
        body: {
          contractVersion: 3,
          error: {
            code: "catalog_unavailable",
            minimumContractVersion: 3,
          },
        },
      });

      const result = await runRefreshChild(urls);

      expect(result.outcome).toEqual({ kind: "incompatible", serverContractVersion: 3 });
      expect(result.sentinel).toMatchObject({
        serverContractVersion: 3,
        minimumContractVersion: 3,
      });
    }
  });

  test("never writes a v3 success body into the existing v2 disk cache", async () => {
    const cacheDir = join(tempHome, ".claudish");
    const cachePath = join(cacheDir, "all-models.json");
    const originalBytes = Buffer.from(
      '{\n  "version": 2,\n  "lastUpdated": "2026-09-10T00:00:00.000Z",\n  "entries": [{"modelId":"safe-v2-model","aliases":[],"sources":{}}],\n  "models": []\n}\n',
      "utf8"
    );
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cachePath, originalBytes);
    const urls = startCatalogServer({
      status: 200,
      body: {
        contractVersion: 3,
        total: 1,
        models: [{ modelId: "unsafe-v3-model", aliases: [], sources: {} }],
      },
    });

    const result = await runRefreshChild(urls);

    expect(result.outcome).toEqual({ kind: "incompatible", serverContractVersion: 3 });
    expect(readFileSync(cachePath).equals(originalBytes)).toBe(true);
  });

  test("returns null after the sentinel is set even when the module cache is warm", async () => {
    const cacheDir = join(tempHome, ".claudish");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, "all-models.json"),
      JSON.stringify({
        version: 2,
        lastUpdated: "2026-09-10T00:00:00.000Z",
        entries: [{ modelId: "warm-v2-model", aliases: [], sources: {} }],
        models: [],
      }),
      "utf8"
    );
    // This path does not fetch; the URLs only ensure module evaluation stays
    // hermetic from production endpoints while the disk cache is warmed.
    const urls = {
      catalogUrl: "http://127.0.0.1:1/queryModels",
      plansUrl: "http://127.0.0.1:1/queryPlans",
    };

    const result = await runWarmCacheChild(urls);

    expect(result.before).toEqual([{ modelId: "warm-v2-model", aliases: [], sources: {} }]);
    expect(result.after).toBeNull();
  });
});
