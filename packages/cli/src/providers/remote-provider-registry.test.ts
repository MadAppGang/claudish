import { describe, it, expect } from "bun:test";
import { resolveRemoteProvider } from "./remote-provider-registry.js";

describe("resolveRemoteProvider — vertex", () => {
  // Regression: Vertex has a static baseUrl of "" (its endpoint is built
  // per-region in the vertex transport). A baseUrl-emptiness filter in
  // getRemoteProviders() used to drop it, so `v@`/`vertex@` resolved to null
  // and every Vertex request silently fell through to the OpenRouter default
  // (HTTP 401). Vertex must resolve regardless of its empty static baseUrl.
  it("resolves v@ to the vertex provider", () => {
    const r = resolveRemoteProvider("v@gemini-3.5-flash");
    expect(r).not.toBeNull();
    expect(r!.provider.name).toBe("vertex");
    expect(r!.modelName).toBe("gemini-3.5-flash");
  });

  it("resolves vertex@ to the vertex provider", () => {
    const r = resolveRemoteProvider("vertex@gemini-2.5-pro");
    expect(r).not.toBeNull();
    expect(r!.provider.name).toBe("vertex");
    expect(r!.modelName).toBe("gemini-2.5-pro");
  });

  it("resolves the legacy v/ prefix to the vertex provider", () => {
    const r = resolveRemoteProvider("v/gemini-3.5-flash");
    expect(r).not.toBeNull();
    expect(r!.provider.name).toBe("vertex");
  });
});
