import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiskCacheV3 } from "./all-models-cache.js";

function generation(id: string, publishedAt: string): DiskCacheV3 {
  return {
    version: 3,
    catalogGenerationId: id,
    lastUpdated: publishedAt,
    entries: [
      {
        modelId: `${id}-model`,
        aliases: [],
        inputModalities: ["text"],
        outputModalities: ["text"],
        aggregators: [
          {
            sourceProviderId: "test-labs",
            sourceCollectorId: "test",
            confidence: "api_official",
            routeStatus: "mapped",
            route: { routeId: "test-labs", routeProfileId: "direct-api" },
            externalModelId: `${id}-wire`,
            wire: { status: "unknown", evidence: [] },
          },
        ],
      },
    ],
    models: [],
    plans: [],
    routeRegistry: {
      generationId: id,
      registry: {
        registryVersion: "3.7.0",
        routes: {
          "test-labs": {
            routeId: "test-labs",
            profiles: {
              "direct-api": {
                kind: "direct",
                apis: { "chat-completions": { baseUrl: `https://${id}.test/v1` } },
              },
            },
          },
        },
      },
    },
  };
}

test("repairing an older generation's missing routes preserves a newer routes sidecar", () => {
  const home = mkdtempSync(join(tmpdir(), "claudish-route-registry-generation-"));
  const older = generation("z-opaque-old", "2026-11-04T11:20:00.000Z");
  const newer = generation("a-opaque-new", "2026-11-04T12:17:00.000Z");
  const source = (name: string) => JSON.stringify(new URL(name, import.meta.url).pathname);

  try {
    const child = Bun.spawnSync(
      [
        process.execPath,
        "--eval",
        `
          import assert from "node:assert/strict";
          import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
          import { dirname } from "node:path";
          import {
            ALL_MODELS_CACHE_PATH,
            readAllModelsCache,
            routeRegistryPathFor,
          } from ${source("./all-models-cache.ts")};
          import { ensureRouteRegistryReady } from ${source("./catalog-client.ts")};

          const older = ${JSON.stringify(older)};
          const newer = ${JSON.stringify(newer)};
          const cachePath = ALL_MODELS_CACHE_PATH;
          assert.ok(cachePath.startsWith(process.env.HOME + "/"));
          const routesPath = routeRegistryPathFor(cachePath);
          mkdirSync(dirname(cachePath), { recursive: true });
          const { routeRegistry, ...withoutRegistry } = older;
          writeFileSync(cachePath, JSON.stringify(withoutRegistry));
          assert.ok(readAllModelsCache());
          assert.equal(readAllModelsCache().routeRegistry, undefined);

          let signalStarted;
          const started = new Promise(resolve => { signalStarted = resolve; });
          let release;
          const response = new Promise(resolve => { release = resolve; });
          const calls = [];
          globalThis.fetch = async input => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            assert.equal(url.origin, "https://route-repair.test");
            assert.equal(url.pathname, "/queryModels");
            assert.deepEqual(Object.fromEntries(url.searchParams), {
              catalog: "routes",
              generationId: older.catalogGenerationId,
            });
            calls.push(url.href);
            signalStarted();
            return response;
          };

          const repairing = ensureRouteRegistryReady(1000);
          await started;
          // Publish exactly as another process would, with no in-process invalidation.
          writeFileSync(cachePath, JSON.stringify(newer));
          const expectedRoutes = JSON.stringify(newer.routeRegistry);
          writeFileSync(routesPath, expectedRoutes);
          release(Response.json({
            contractVersion: 3,
            generationId: older.catalogGenerationId,
            generatedAt: older.lastUpdated,
            data: { mode: "routes", registry: routeRegistry.registry },
          }));
          await repairing;
          assert.equal(calls.length, 1);
          assert.equal(JSON.parse(readFileSync(cachePath, "utf8")).catalogGenerationId,
            newer.catalogGenerationId);
          process.stdout.write(readFileSync(routesPath, "utf8"));
        `,
      ],
      {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH,
          HOME: home,
          CLAUDISH_ACCOUNTS_DIR: join(home, "accounts"),
          CLAUDISH_DISABLE_KEYCHAIN: "1",
          CLAUDISH_DISABLE_OP: "1",
          CLAUDISH_DISABLE_CATALOG_WARM: "0",
          CLAUDISH_CATALOG_URL: "https://route-repair.test/queryModels?catalog=slim",
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const routes = JSON.parse(child.stdout.toString());
    expect(routes.generationId).toBe(newer.catalogGenerationId);
    expect(routes).toEqual(newer.routeRegistry);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
