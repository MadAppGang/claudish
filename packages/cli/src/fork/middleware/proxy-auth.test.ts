import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createProxyAuthMiddleware } from "./proxy-auth.js";
import { matchesProxyKey, resolveProxyKeys } from "../../handlers/shared/proxy-keys.js";

function buildApp(keys: string[]): Hono {
  const app = new Hono();
  app.use("/v1/*", createProxyAuthMiddleware(keys));
  app.post("/v1/messages", (c) => c.json({ ok: true }));
  app.get("/v1/models", (c) => c.json({ ok: true }));
  return app;
}

function post(app: Hono, headers: Record<string, string> = {}, model = "gpt-4o"): Promise<Response> {
  return app.request("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model }),
  });
}

describe("resolveProxyKeys", () => {
  it("returns just the primary when no previous is set", () => {
    expect(resolveProxyKeys("new", undefined)).toEqual(["new"]);
  });

  it("keeps primary first, previous second", () => {
    expect(resolveProxyKeys("new", "old")).toEqual(["new", "old"]);
  });

  it("dedupes when previous equals primary", () => {
    expect(resolveProxyKeys("same", "same")).toEqual(["same"]);
  });

  it("drops empty values and yields an empty set when nothing is configured", () => {
    expect(resolveProxyKeys("", "")).toEqual([]);
    expect(resolveProxyKeys(undefined, undefined)).toEqual([]);
  });
});

describe("matchesProxyKey", () => {
  it("accepts any configured key, rejects everything else", () => {
    const keys = ["new", "old"];
    expect(matchesProxyKey("new", keys)).toBe(true);
    expect(matchesProxyKey("old", keys)).toBe(true);
    expect(matchesProxyKey("guess", keys)).toBe(false);
    expect(matchesProxyKey(undefined, keys)).toBe(false);
    expect(matchesProxyKey("new", [])).toBe(false);
  });
});

describe("proxy-auth middleware", () => {
  it("accepts the single configured key and rejects wrong or missing keys", async () => {
    const app = buildApp(["only-key"]);
    expect((await post(app, { "x-proxy-key": "only-key" })).status).toBe(200);
    expect((await post(app, { "x-proxy-key": "wrong" })).status).toBe(401);
    expect((await post(app)).status).toBe(401);
  });

  it("during a rotation accepts BOTH the new and the retiring key", async () => {
    const app = buildApp(["new-key", "old-key"]);
    expect((await post(app, { "x-proxy-key": "new-key" })).status).toBe(200);
    expect((await post(app, { "x-proxy-key": "old-key" })).status).toBe(200);
    expect((await post(app, { "x-proxy-key": "pre-rotation-guess" })).status).toBe(401);
  });

  it("accepts the retiring key in every header form (x-proxy-key, x-api-key, Bearer)", async () => {
    const app = buildApp(["new-key", "old-key"]);
    expect((await post(app, { "x-api-key": "old-key" })).status).toBe(200);
    expect((await post(app, { authorization: "Bearer old-key" })).status).toBe(200);
    expect((await post(app, { authorization: "Bearer wrong" })).status).toBe(401);
  });

  it("native-anthropic targets bypass the proxy key entirely", async () => {
    const app = buildApp(["new-key", "old-key"]);
    expect((await post(app, {}, "anthropic/claude-opus-5")).status).toBe(200);
  });

  it("GET requests are exempt (health / model discovery)", async () => {
    const app = buildApp(["new-key"]);
    expect((await app.request("/v1/models")).status).toBe(200);
  });

  it("a malformed body falls through to the route handler", async () => {
    const app = buildApp(["new-key"]);
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(200);
  });
});
