import { describe, expect, test } from "bun:test";
import type { ProviderTransport } from "../providers/transport/types.js";
import { ComposedHandler } from "./composed-handler.js";

// REGRESSION: structural weakness that allowed #102 — ComposedHandler must reject
// provider-routed strings in the modelName slot so dialect selection cannot be
// confused by provider-prefix characters. Fixed in /dev:fix session
// dev-fix-20260415-000620-e95d5090.

function makeFakeTransport(name = "test-provider"): ProviderTransport {
  return {
    name,
    displayName: "Test",
    streamFormat: "openai-sse",
    getEndpoint: () => "http://localhost/",
    getHeaders: () => ({}),
  } as unknown as ProviderTransport;
}

describe("ComposedHandler — modelName invariant (#102 structural fix)", () => {
  test("throws when modelName contains '@' (routed string leaked into bare slot)", () => {
    const transport = makeFakeTransport();
    expect(() => {
      // Passing a routed string in the modelName slot is structurally invalid —
      // the bare slot must never contain provider routing syntax.
      new ComposedHandler(transport, "zai@glm-4.7", "zai@glm-4.7", 8080, {});
    }).toThrow(/modelName.*must.*not.*contain/i);
  });

  test("accepts valid bare modelName with routed targetModel", () => {
    const transport = makeFakeTransport();
    expect(() => {
      new ComposedHandler(transport, "zai@glm-4.7", "glm-4.7", 8080, {});
    }).not.toThrow();
  });

  test("accepts vendor-prefixed modelName (slash separator is legitimate)", () => {
    const transport = makeFakeTransport();
    expect(() => {
      new ComposedHandler(transport, "openrouter@x-ai/grok-beta", "x-ai/grok-beta", 8080, {});
    }).not.toThrow();
  });

  test("accepts OpenRouter preset model IDs that begin with '@'", () => {
    const transport = makeFakeTransport("openrouter");
    expect(() => {
      new ComposedHandler(transport, "@preset/example", "@preset/example", 8080, {});
    }).not.toThrow();
  });

  test("rejects leading '@' model IDs for non-OpenRouter providers", () => {
    const transport = makeFakeTransport();
    expect(() => {
      new ComposedHandler(transport, "@preset/example", "@preset/example", 8080, {});
    }).toThrow(/modelName.*must.*not.*contain/i);
  });
});
