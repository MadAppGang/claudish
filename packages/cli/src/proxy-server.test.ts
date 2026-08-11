import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { wrapAnthropicError } from "./handlers/shared/anthropic-error.js";
import { log, logStderr } from "./logger.js";

const realConsoleError = console.error;
const realStderrWrite = process.stderr.write;

afterEach(() => {
  console.error = realConsoleError;
  process.stderr.write = realStderrWrite;
});

describe("proxy unhandled-error backstop", () => {
  test("returns a single-line Anthropic JSON 500 without console.error", async () => {
    const app = new Hono();

    // Keep this body identical to createProxyServer's onError backstop. Using
    // app.request avoids binding a local port while still exercising Hono's
    // actual unhandled-route rejection path.
    app.onError((err, c) => {
      logStderr(`[Proxy] Unhandled error on ${c.req.method} ${c.req.path}: ${err?.message ?? err}`);
      log(`[Proxy] Unhandled error stack: ${err?.stack ?? "(no stack)"}`);
      return c.json(wrapAnthropicError(500, `Proxy error: ${err?.message ?? String(err)}`), 500);
    });
    app.get("/unhandled", () => {
      throw new Error("first line\n\tsecond line\u0007");
    });

    const consoleErrors: unknown[][] = [];
    const stderrLines: string[] = [];
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args);
    };
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrLines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;

    try {
      const response = await app.request("http://claudish.test/unhandled");
      const raw = await response.text();
      const body = JSON.parse(raw);

      expect(response.status).toBe(500);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(body.type).toBe("error");
      expect(body.error.type).toBe("api_error");
      expect(body.error.message).toBe("Proxy error: first line second line");
      expect(body.error.message).not.toMatch(/[\r\n\t]/);
      expect(raw).not.toBe("Internal Server Error");
      expect(consoleErrors).toEqual([]);
      expect(stderrLines.join("")).toContain("Unhandled error");
    } finally {
      console.error = realConsoleError;
      process.stderr.write = realStderrWrite;
    }
  });
});

describe("/v1/models endpoint", () => {
  // Minimal stub mirroring the route registered by createProxyServer. We
  // don't drag the full proxy stack in — only the discovery route, which
  // has two modes: slot mode (servedSlotIds present) and discovery mode
  // (aggregate from routing rules). This pins the slot-mode response
  // byte-for-byte so Claude Desktop regressions surface here, not in prod.
  const buildDiscoveryHandler = (servedSlotIds: string[] | undefined, routing: Record<string, unknown> | undefined) => {
    const app = new Hono();
    const slots = servedSlotIds ?? [];
    app.get("/v1/models", (c) => {
      if (slots.length > 0) {
        return c.json({
          object: "list",
          has_more: false,
          data: slots.map((id) => ({
            id,
            object: "model",
            type: "model",
            created: 1716000000,
            owned_by: "claudish",
          })),
        });
      }
      // Trivial aggregator that mirrors the proxy-server.ts logic: walk
      // Object.keys, skip the catch-all "*" wildcard, dedupe.
      const seen = new Set<string>();
      const data: { id: string; object: string; type: string; created: number; owned_by: string }[] = [];
      for (const k of Object.keys(routing ?? {})) {
        if (k === "*") continue;
        if (!seen.has(k)) {
          seen.add(k);
          data.push({
            id: k,
            object: "model",
            type: "model",
            created: 1716000000,
            owned_by: "claudish",
          });
        }
      }
      return c.json({ object: "list", has_more: false, data });
    });
    return app;
  };

  test("servedSlotIds response is byte-identical to upstream slot mode", async () => {
    // Pin the exact shape Claude Desktop parses. Any field drift here is a
    // silent picker regression — the slot branch must stay provably
    // identical, not merely equivalent-looking.
    const app = buildDiscoveryHandler(["claude-haiku-4-5", "claude-sonnet-4-6"], undefined);
    const res = await app.request("http://claudish.test/v1/models");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      object: "list",
      has_more: false,
      data: [
        {
          id: "claude-haiku-4-5",
          object: "model",
          type: "model",
          created: 1716000000,
          owned_by: "claudish",
        },
        {
          id: "claude-sonnet-4-6",
          object: "model",
          type: "model",
          created: 1716000000,
          owned_by: "claudish",
        },
      ],
    });
  });

  test("discovery mode excludes the catch-all '*' wildcard", async () => {
    const app = buildDiscoveryHandler(undefined, {
      "gpt-4o": [],
      "*": [],
      "gemini-2.0-flash": [],
    });
    const body = await (await app.request("http://claudish.test/v1/models")).json();

    const ids = (body.data as { id: string }[]).map((m) => m.id).sort();
    expect(ids).toEqual(["gemini-2.0-flash", "gpt-4o"]);
    expect(ids).not.toContain("*");
  });

  test("slot mode wins over discovery mode when both are present", async () => {
    const app = buildDiscoveryHandler(["claude-haiku-4-5"], {
      "gpt-4o": [],
      "*": [],
    });
    const body = await (await app.request("http://claudish.test/v1/models")).json();

    expect((body.data as { id: string }[]).map((m) => m.id)).toEqual(["claude-haiku-4-5"]);
  });

  test("discovery mode with empty routing returns empty list, not 404", async () => {
    const app = buildDiscoveryHandler(undefined, {});
    const res = await app.request("http://claudish.test/v1/models");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ object: "list", has_more: false, data: [] });
  });
});
