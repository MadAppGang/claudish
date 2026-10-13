import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { DiskCacheV3 } from "./all-models-cache.js";
import {
  WIRE_REGISTRY_VERSION,
  type WireApi,
  isConnectionWire,
  isRouteRegistry,
  registryVersionAtLeast,
  routeProfile,
  wireRequestUrl,
} from "./connection-wire.js";

const fixture: DiskCacheV3 = JSON.parse(
  readFileSync(
    new URL("../test-fixtures/catalog-v3/wire-g-20261012101007285-7770c36e.json", import.meta.url),
    "utf8"
  )
);
const registry = fixture.routeRegistry!.registry;
const connections = fixture.entries
  .flatMap((entry) => entry.aggregators ?? [])
  .filter((connection) => connection.routeStatus === "mapped");
const known = connections.find((connection) => connection.wire?.status === "known")!.wire!;

describe("isConnectionWire", () => {
  test("accepts every published wire, including known, unknown and unsupported", () => {
    expect(fixture.entries).toHaveLength(16);
    expect(new Set(connections.map((connection) => connection.wire?.status))).toEqual(
      new Set(["known", "unknown", "unsupported"])
    );
    for (const connection of connections) expect(isConnectionWire(connection.wire)).toBe(true);
  });
  test.each([
    ["null", null],
    ["missing api", { ...known, api: undefined }],
    ["unrecognized api", { ...known, api: "realtime" }],
    ["unrecognized status", { ...known, status: "future" }],
  ])("rejects %s", (_name, value) => expect(isConnectionWire(value)).toBe(false));
});

describe("isRouteRegistry", () => {
  test("accepts the production registry", () => expect(isRouteRegistry(registry)).toBe(true));
  test("rejects an unknown API key", () => {
    const copy = structuredClone(registry);
    const apis = copy.routes.openai!.profiles["direct-api"]!.apis;
    Object.assign(apis, { realtime: { baseUrl: "https://example.test" } });
    expect(isRouteRegistry(copy)).toBe(false);
  });
  test("rejects a missing baseUrl", () => {
    const copy = structuredClone(registry);
    Reflect.deleteProperty(copy.routes.openai!.profiles["direct-api"]!.apis.responses!, "baseUrl");
    expect(isRouteRegistry(copy)).toBe(false);
  });
  test.each([[null], ["registry"], [[]], [42]])("rejects non-object %j", (value) => {
    expect(isRouteRegistry(value)).toBe(false);
  });
  test("looks up the exact route profile", () => {
    expect(routeProfile(registry, { routeId: "openai", routeProfileId: "direct-api" })).toEqual(
      registry.routes.openai!.profiles["direct-api"]
    );
    expect(routeProfile(registry, { routeId: "openai", routeProfileId: "absent" })).toBeUndefined();
    expect(
      routeProfile(registry, { routeId: "absent", routeProfileId: "direct-api" })
    ).toBeUndefined();
  });
});

describe("registryVersionAtLeast", () => {
  test("wire enforcement starts at 3.7.0", () => expect(WIRE_REGISTRY_VERSION).toBe("3.7.0"));
  test.each([
    ["3.7.0", true],
    ["3.10.0", true],
    ["3.6.9", false],
    ["4.0", true],
  ] as const)("compares %s numerically", (version, expected) => {
    expect(registryVersionAtLeast(version, "3.7.0")).toBe(expected);
  });
});

describe("wireRequestUrl", () => {
  const cases: Array<[WireApi, string, string, string]> = [
    [
      "responses",
      "https://api.openai.com/v1",
      "gpt-6.1-sol",
      "https://api.openai.com/v1/responses",
    ],
    [
      "chat-completions",
      "https://openrouter.ai/api/v1",
      "openai/gpt-6.1-sol",
      "https://openrouter.ai/api/v1/chat/completions",
    ],
    [
      "anthropic-messages",
      "https://api.anthropic.com/v1",
      "claude-opus-5-5",
      "https://api.anthropic.com/v1/messages",
    ],
    [
      "gemini",
      "https://generativelanguage.googleapis.com/v1beta",
      "gemini-3.8-flash",
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse",
    ],
  ];
  for (const [api, base, id, expected] of cases) {
    test(`${api} appends its path and strips trailing slashes`, () => {
      expect(wireRequestUrl(base, api, id)).toBe(expected);
      expect(wireRequestUrl(`${base}/`, api, id)).toBe(expected);
      expect(wireRequestUrl(`${base}///`, api, id)).toBe(expected);
    });
  }
  test("Gemini non-streaming uses generateContent without SSE query", () => {
    expect(
      wireRequestUrl(
        "https://generativelanguage.googleapis.com/v1beta/",
        "gemini",
        "gemini-3.8-flash",
        false
      )
    ).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent"
    );
  });
});
