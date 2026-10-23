/**
 * web-search-executor — SEARXNG_URL credentials-in-userinfo tests.
 *
 * The incident these pin (2026-08-20, po-2026): Basic Auth deployed on the
 * public search.myia.io (IIS, Windows account) 401'd every credless WAN
 * client, and claudish had no way to send credentials at all. The standard
 * curl-style form `https://user:pass@host` now produces an Authorization
 * header — LAN deployments with a credless URL stay byte-identical.
 *
 * Transport (#593): these mocks answer through a fetch stub, not a Bun.serve.
 * Measured 2026-10-23: once any node:http server has lived in the `bun test`
 * process (the real proxy is @hono/node-server, so every proxy-server route
 * test does), every Bun.serve created afterwards is unreachable — fetch gets
 * Bun's "Welcome to Bun!" default page and node:http / raw sockets hang, on
 * win32 1.3.14 and ubuntu 1.4.0 alike. A stub keeps the exact wire semantics
 * (status, headers, JSON bodies, abort on the attempt timeout) without a
 * socket. See test-support/stub-fetch.ts.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { installStubFetch } from "../../test-support/stub-fetch.js";
import {
  searxngConfig,
  executeWebSearch,
  searxngLatencyStats,
  _resetSearxngTelemetry,
} from "./web-search-executor.js";

const ORIGINAL_URL = process.env.SEARXNG_URL;
const ORIGINAL_MCP = process.env.SEARXNG_MCP_URL;
const ORIGINAL_ATTEMPT_TIMEOUT = process.env.SEARXNG_ATTEMPT_TIMEOUT_MS;

afterEach(() => {
  if (ORIGINAL_URL === undefined) delete process.env.SEARXNG_URL;
  else process.env.SEARXNG_URL = ORIGINAL_URL;
  if (ORIGINAL_MCP === undefined) delete process.env.SEARXNG_MCP_URL;
  else process.env.SEARXNG_MCP_URL = ORIGINAL_MCP;
  if (ORIGINAL_ATTEMPT_TIMEOUT === undefined) delete process.env.SEARXNG_ATTEMPT_TIMEOUT_MS;
  else process.env.SEARXNG_ATTEMPT_TIMEOUT_MS = ORIGINAL_ATTEMPT_TIMEOUT;
  _resetSearxngTelemetry();
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

  test("unset → NO default base (the old search.myia.io fallback is gone — #26 port of pre-sync 1fffab8)", () => {
    delete process.env.SEARXNG_URL;
    const c = searxngConfig();
    // The default could only 401 once the host grew Basic Auth (2026-08-19):
    // a working setup carries creds in the userinfo and sets the full URL.
    expect(c.base).toBe("");
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
    let seenUrl = "";
    const restore = installStubFetch((req) => {
      sawAuth = req.headers.get("authorization") || "";
      seenUrl = req.url;
      if (sawAuth !== expectAuth) return new Response("denied", { status: 401 });
      return Response.json({
        results: [{ title: "Lean proof", url: "https://example.com", content: "snippet" }],
      });
    });
    try {
      process.env.SEARXNG_URL = "http://u:p@searxng.test";
      const out = await executeWebSearch("lean", 3000);
      expect(sawAuth).toBe(expectAuth);
      // The credentials ride the userinfo-derived header, never the URL the
      // executor builds (base has them stripped).
      expect(seenUrl.startsWith("http://searxng.test/search?q=lean")).toBe(true);
      expect(out).toContain("[Web search results");
      expect(out).toContain("**Lean proof**");
    } finally {
      restore();
    }
  });

  test("401 despite creds → graceful no-results text, never a throw", async () => {
    delete process.env.SEARXNG_MCP_URL;
    const restore = installStubFetch(() => new Response("Unauthorized", { status: 401 }));
    try {
      process.env.SEARXNG_URL = "http://u:p@searxng.test";
      const out = await executeWebSearch("lean", 2000);
      expect(out).toMatch(/no results|unavailable/i);
    } finally {
      restore();
    }
  });

  test("SEARXNG_URL unset → direct HTTP disabled: ZERO network calls, graceful text (#26 port)", async () => {
    delete process.env.SEARXNG_MCP_URL;
    delete process.env.SEARXNG_URL;
    // The pre-port defect this pins: the silent `|| "http://search.myia.io"`
    // default shipped every search of a misconfigured deployment to a host
    // that 401s — wasted attempt budget, confusing log, no signal that the
    // CONFIG is the problem. Unset must be loud AND offline.
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async (_input?: unknown, _init?: unknown): Promise<Response> => {
      fetchCalls++;
      throw new Error("must not fetch when SEARXNG_URL is unset");
    }) as typeof fetch;
    try {
      const out = await executeWebSearch("lean", 2000);
      expect(fetchCalls).toBe(0); // disabled ≠ shipped-to-default
      // The precise openai-sse.ts "not configured" formula — NOT
      // formatSearchResults([])'s "service may be unavailable", which tells
      // the agent the backend may be DOWN when the fact is: not set.
      expect(out).toBe(
        `[Web search for "lean" could not be executed. The search service (SearXNG) is not configured. Set SEARXNG_URL env var to enable.]`
      );
      // Short-circuit happens BEFORE the retry loop: the #3388 latency window
      // must record no sample — a ~0ms one would read absence-of-backend as
      // a fast backend and poison the drift detector.
      expect(searxngLatencyStats()).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("executeWebSearch — retry, budget and latency telemetry (#3388)", () => {
  // Attempt timeout is shrunk via env so timeout paths run in ~150ms instead
  // of the dimensioned 5s (bun's default per-test timeout is 5s).
  const ATTEMPT_MS = "150";

  /**
   * First request stalls past the attempt timeout (aborted), later ones answer
   * at once. The stall lives in the stub handler; the abort itself is honoured
   * by installStubFetch on the AbortSignal.timeout the executor passes.
   */
  function slowThenFastStub(slowMs: number) {
    let hits = 0;
    const restore = installStubFetch(async () => {
      hits++;
      if (hits === 1) {
        await new Promise((r) => setTimeout(r, slowMs));
      }
      return Response.json({
        results: [{ title: "Retry proof", url: "https://example.com", content: "snippet" }],
      });
    });
    return { restore, hits: () => hits };
  }

  test("first attempt times out → exactly one retry recovers results", async () => {
    delete process.env.SEARXNG_MCP_URL;
    process.env.SEARXNG_ATTEMPT_TIMEOUT_MS = ATTEMPT_MS;
    const { restore, hits } = slowThenFastStub(400);
    try {
      process.env.SEARXNG_URL = "http://searxng.test";
      const out = await executeWebSearch("retry", 3000);
      expect(hits()).toBe(2);
      expect(out).toContain("[Web search results");
      expect(out).toContain("**Retry proof**");
    } finally {
      restore();
    }
  });

  test("all attempts time out → graceful failure text, never a throw, exactly 2 requests", async () => {
    delete process.env.SEARXNG_MCP_URL;
    process.env.SEARXNG_ATTEMPT_TIMEOUT_MS = ATTEMPT_MS;
    let hits = 0;
    const restore = installStubFetch(async () => {
      hits++;
      await new Promise((r) => setTimeout(r, 400));
      return Response.json({ results: [] });
    });
    try {
      process.env.SEARXNG_URL = "http://searxng.test";
      const out = await executeWebSearch("never-answers", 3000);
      expect(hits).toBe(2);
      expect(out).toMatch(/failed after 2 attempts within 3000ms budget/i);
    } finally {
      restore();
    }
  });

  test("exhausted budget → no second attempt started", async () => {
    delete process.env.SEARXNG_MCP_URL;
    process.env.SEARXNG_ATTEMPT_TIMEOUT_MS = ATTEMPT_MS;
    let hits = 0;
    const restore = installStubFetch(async () => {
      hits++;
      await new Promise((r) => setTimeout(r, 400));
      return Response.json({ results: [] });
    });
    try {
      process.env.SEARXNG_URL = "http://searxng.test";
      // 350ms budget: attempt 1 aborts at ~150ms, remaining ~200ms < 250ms
      // retry floor → no second request.
      const out = await executeWebSearch("no-budget", 350);
      expect(hits).toBe(1);
      expect(out).toMatch(/failed/i);
    } finally {
      restore();
    }
  });

  test("latency telemetry records every attempt (incl. timeouts) with p50/p95", async () => {
    delete process.env.SEARXNG_MCP_URL;
    expect(searxngLatencyStats()).toBeNull();
    const { restore } = slowThenFastStub(400);
    try {
      process.env.SEARXNG_ATTEMPT_TIMEOUT_MS = ATTEMPT_MS;
      process.env.SEARXNG_URL = "http://searxng.test";
      await executeWebSearch("telemetry", 3000);
      const stats = searxngLatencyStats();
      expect(stats).not.toBeNull();
      expect(stats!.n).toBe(2); // timed-out attempt + successful attempt
      expect(stats!.p50).toBeGreaterThanOrEqual(0);
      expect(stats!.p95).toBeGreaterThanOrEqual(stats!.p50);
      _resetSearxngTelemetry();
      expect(searxngLatencyStats()).toBeNull();
    } finally {
      restore();
    }
  });

  test("MCP stays first in the chain when configured (retry loop is the HTTP fallback only)", async () => {
    process.env.SEARXNG_ATTEMPT_TIMEOUT_MS = ATTEMPT_MS;
    let httpHits = 0;
    const restore = installStubFetch((req) => {
      // The MCP endpoint is dead (connection refused) — the client must
      // degrade to ok:false and let direct HTTP carry the search.
      if (req.url.includes("127.0.0.1:1/mcp")) {
        throw new Error("connect ECONNREFUSED 127.0.0.1:1");
      }
      httpHits++;
      return Response.json({
        results: [{ title: "Via HTTP fallback", url: "https://example.com", content: "snippet" }],
      });
    });
    try {
      process.env.SEARXNG_MCP_URL = "http://127.0.0.1:1/mcp";
      process.env.SEARXNG_URL = "http://searxng.test";
      const out = await executeWebSearch("mcp-fallback", 3000);
      expect(httpHits).toBeGreaterThanOrEqual(1);
      expect(out).toContain("[Web search results");
    } finally {
      restore();
    }
  });
});
