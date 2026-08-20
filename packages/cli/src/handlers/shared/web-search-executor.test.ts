/**
 * web-search-executor — SEARXNG_URL credentials-in-userinfo tests.
 *
 * The incident these pin (2026-08-20, po-2026): Basic Auth deployed on the
 * public search.myia.io (IIS, Windows account) 401'd every credless WAN
 * client, and claudish had no way to send credentials at all. The standard
 * curl-style form `https://user:pass@host` now produces an Authorization
 * header — LAN deployments with a credless URL stay byte-identical.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { searxngConfig, executeWebSearch } from "./web-search-executor.js";

const ORIGINAL_URL = process.env.SEARXNG_URL;
const ORIGINAL_MCP = process.env.SEARXNG_MCP_URL;

afterEach(() => {
  if (ORIGINAL_URL === undefined) delete process.env.SEARXNG_URL;
  else process.env.SEARXNG_URL = ORIGINAL_URL;
  if (ORIGINAL_MCP === undefined) delete process.env.SEARXNG_MCP_URL;
  else process.env.SEARXNG_MCP_URL = ORIGINAL_MCP;
});

describe("searxngConfig — userinfo parsing", () => {
  test("no userinfo → no auth header, trailing slash stripped", () => {
    process.env.SEARXNG_URL = "http://192.168.0.47:8181/";
    const c = searxngConfig();
    expect(c.base).toBe("http://192.168.0.47:8181");
    expect(c.authHeaders).toEqual({});
  });

  test("user:pass → Basic header, creds stripped from base", () => {
    process.env.SEARXNG_URL = "https://searxng-user:pw@search.myia.io";
    const c = searxngConfig();
    expect(c.base).toBe("https://search.myia.io");
    expect(c.authHeaders.Authorization).toBe(
      `Basic ${Buffer.from("searxng-user:pw").toString("base64")}`
    );
  });

  test("URL-encoded specials decoded before base64", () => {
    process.env.SEARXNG_URL = "https://u:p%40ss@search.myia.io";
    const c = searxngConfig();
    expect(c.base).toBe("https://search.myia.io");
    expect(c.authHeaders.Authorization).toBe(
      `Basic ${Buffer.from("u:p@ss").toString("base64")}`
    );
  });

  test("unset → default public URL, no auth", () => {
    delete process.env.SEARXNG_URL;
    const c = searxngConfig();
    expect(c.base).toBe("http://search.myia.io");
    expect(c.authHeaders).toEqual({});
  });

  test("username without password still authenticates (empty password part)", () => {
    process.env.SEARXNG_URL = "https://u@search.myia.io";
    const c = searxngConfig();
    expect(c.authHeaders.Authorization).toBe(
      `Basic ${Buffer.from("u:").toString("base64")}`
    );
  });
});

describe("executeWebSearch — Basic auth end-to-end (local mock)", () => {
  test("server demanding auth is satisfied by creds-in-URL", async () => {
    delete process.env.SEARXNG_MCP_URL;
    const expectAuth = `Basic ${Buffer.from("u:p").toString("base64")}`;
    let sawAuth = "";
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        sawAuth = req.headers.get("authorization") || "";
        if (sawAuth !== expectAuth) return new Response("denied", { status: 401 });
        return Response.json({
          results: [{ title: "Lean proof", url: "https://example.com", content: "snippet" }],
        });
      },
    });
    try {
      process.env.SEARXNG_URL = `http://u:p@127.0.0.1:${server.port}`;
      const out = await executeWebSearch("lean", 3000);
      expect(sawAuth).toBe(expectAuth);
      expect(out).toContain("[Web search results");
      expect(out).toContain("**Lean proof**");
    } finally {
      server.stop(true);
    }
  });

  test("401 despite creds → graceful no-results text, never a throw", async () => {
    delete process.env.SEARXNG_MCP_URL;
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("Unauthorized", { status: 401 });
      },
    });
    try {
      process.env.SEARXNG_URL = `http://u:p@127.0.0.1:${server.port}`;
      const out = await executeWebSearch("lean", 2000);
      expect(out).toMatch(/no results|unavailable/i);
    } finally {
      server.stop(true);
    }
  });
});
