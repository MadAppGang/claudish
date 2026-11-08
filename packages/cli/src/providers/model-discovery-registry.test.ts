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

test.each([
  ["OpenCode Go discovery retries the definition URL after a registry 404", 404, 200],
  ["OpenCode Go discovery does not retry a registry 401", 401, 200],
  ["OpenCode Go discovery records the definition URL when both endpoints return 404", 404, 404],
] as const)("%s", (_name, registryStatus, definitionStatus) => {
  const home = mkdtempSync(join(tmpdir(), "discovery-registry-go-fallback-"));
  try {
    const data = structuredClone(fixture);
    data.routeRegistry!.registry.routes.opencode!.profiles["go-subscription"]!.apis = {
      "chat-completions": { baseUrl: "https://opencode.ai/inference/go/openai/v1" },
      responses: { baseUrl: "https://opencode.ai/inference/go/openai/v1" },
      "anthropic-messages": { baseUrl: "https://opencode.ai/inference/go/anthropic/v1" },
      gemini: { baseUrl: "https://opencode.ai/inference/go/google/v1beta" },
    };
    mkdirSync(join(home, ".claudish"));
    writeFileSync(join(home, ".claudish/cloud-models-catalog-v3.json"), JSON.stringify(data));
    const child = Bun.spawnSync(
      [
        process.execPath,
        "--eval",
        `
      const { discoverProviderModelsCatalog, getDiscoveryFailure } = await import(${JSON.stringify(new URL("./model-discovery.ts", import.meta.url).pathname)});
      const calls = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url, init) => {
        calls.push({url: String(url), headers: Object.fromEntries(new Headers(init.headers))});
        const status = String(url) === "https://opencode.ai/inference/go/openai/v1/models"
          ? ${registryStatus} : ${definitionStatus};
        return Response.json({data: [{id: "test-chat"}]}, {status});
      };
      try {
        const result = await discoverProviderModelsCatalog("opencode-zen-go");
        console.log(JSON.stringify({result, calls, failure: getDiscoveryFailure("opencode-zen-go")}));
      } finally { globalThis.fetch = originalFetch; }
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
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const result = JSON.parse(child.stdout.toString());
    const registryEndpoint = "https://opencode.ai/inference/go/openai/v1/models";
    const definitionEndpoint = "https://opencode.ai/zen/go/v1/models";
    expect(result.calls.map((call: { url: string }) => call.url)).toEqual(
      registryStatus === 404 ? [registryEndpoint, definitionEndpoint] : [registryEndpoint]
    );
    for (const call of result.calls) {
      expect(call.headers.authorization).toBe("Bearer fake");
    }
    if (registryStatus === 404 && definitionStatus === 200) {
      expect(result.result.kind, JSON.stringify(result)).toBe("served");
      expect(result.result.models).toEqual([expect.objectContaining({ id: "test-chat" })]);
    } else {
      expect(result.result.kind, JSON.stringify(result)).not.toBe("served");
      expect(result.failure).toMatchObject({
        status: registryStatus === 404 ? definitionStatus : registryStatus,
        endpoint: registryStatus === 404 ? definitionEndpoint : registryEndpoint,
      });
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
