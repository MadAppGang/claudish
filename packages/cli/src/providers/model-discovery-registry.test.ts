import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiskCacheV3 } from "./all-models-cache.js";
import { resolveRouteProfile } from "./connection-resolver.js";

const fixturePath = new URL(
  "../test-fixtures/catalog-v3/wire-g-20261012101007285-7770c36e.json",
  import.meta.url
).pathname;
const fixture: DiskCacheV3 = JSON.parse(readFileSync(fixturePath, "utf8"));
test.each([
  ["opencode-zen", undefined],
  ["opencode-zen-go", undefined],
  ["opencode-zen-go", "https://override.invalid/proxy"],
] as const)("%s discovery honors its descriptor and base override %s", (provider, override) => {
  const home = mkdtempSync(join(tmpdir(), "discovery-registry-"));
  try {
    mkdirSync(join(home, ".claudish"));
    writeFileSync(join(home, ".claudish/cloud-models-catalog-v3.json"), JSON.stringify(fixture));
    const child = Bun.spawnSync(
      [
        process.execPath,
        "--eval",
        `
      const { discoverProviderModelsCatalog } = await import(${JSON.stringify(new URL("./model-discovery.ts", import.meta.url).pathname)});
      const calls = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url, init) => {
        calls.push({url: String(url), headers: Object.fromEntries(new Headers(init.headers))});
        return Response.json({data: [{id: "test-chat"}]});
      };
      try { console.log(JSON.stringify({result: await discoverProviderModelsCatalog(${JSON.stringify(provider)}), calls})); }
      finally { globalThis.fetch = originalFetch; }
    `,
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: home,
          CLAUDISH_DISABLE_CATALOG_WARM: "1",
          CLAUDISH_DISABLE_KEYCHAIN: "1",
          CLAUDISH_DISABLE_OP: "1",
          OPENCODE_GO_API_KEY: "fake",
          ...(override ? { OPENCODE_GO_BASE_URL: override } : {}),
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const result = JSON.parse(child.stdout.toString());
    if (provider === "opencode-zen") {
      expect(result.result).toEqual({ kind: "unsupported", reason: "no-descriptor" });
      expect(result.calls).toEqual([]);
      return;
    }
    const profile = resolveRouteProfile("opencode-zen-go", fixturePath)!.profile;
    const registryBase = profile.apis["chat-completions"]!.baseUrl;
    expect(result.result.kind, JSON.stringify(result)).toBe("served");
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].url).toBe(override ? `${override}/v1/models` : `${registryBase}/models`);
    expect(result.calls[0].headers.authorization).toBe("Bearer fake");
    expect(result.result.kind).toBe("served");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Kimi discovery uses the registry host instead of the definition host", () => {
  const home = mkdtempSync(join(tmpdir(), "discovery-registry-kimi-"));
  try {
    mkdirSync(join(home, ".claudish"));
    writeFileSync(join(home, ".claudish/cloud-models-catalog-v3.json"), JSON.stringify(fixture));
    const child = Bun.spawnSync(
      [
        process.execPath,
        "--eval",
        `
      const { discoverProviderModelsCatalog } = await import(${JSON.stringify(new URL("./model-discovery.ts", import.meta.url).pathname)});
      const calls = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url, init) => {
        calls.push({url: String(url), headers: Object.fromEntries(new Headers(init.headers))});
        return Response.json({data: [{id: "k3"}]});
      };
      try { console.log(JSON.stringify({result: await discoverProviderModelsCatalog("kimi-coding"), calls})); }
      finally { globalThis.fetch = originalFetch; }
    `,
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: home,
          CLAUDISH_DISABLE_CATALOG_WARM: "1",
          CLAUDISH_DISABLE_KEYCHAIN: "1",
          CLAUDISH_DISABLE_OP: "1",
          KIMI_CODING_API_KEY: "fake",
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const result = JSON.parse(child.stdout.toString());
    expect(result.result.kind, JSON.stringify(result)).toBe("served");
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].url).toBe("https://api.kimi.ai/coding/v1/models");
    expect(result.calls[0].headers.authorization).toBe("Bearer fake");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
