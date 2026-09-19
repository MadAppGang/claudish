/**
 * Tests for LocalTransport Ollama-backend auto-detection: a custom endpoint
 * pointed at an Ollama server gets num_ctx even when it is not named "ollama",
 * while genuinely non-Ollama endpoints do not.
 *
 * Run: bun test packages/cli/src/providers/transport/local.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { LocalProvider } from "../provider-registry.js";
import { LocalTransport } from "./local.js";

function config(name: string, baseUrl: string): LocalProvider {
  return { name, baseUrl, apiPath: "/v1/chat/completions", envVar: "", prefixes: [] };
}

const ollamaTags = () =>
  new Response(JSON.stringify({ models: [{ name: "llama3" }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

describe("LocalTransport — Ollama backend detection", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  let savedCtxEnv: string | undefined;

  beforeEach(() => {
    // The constructor honours CLAUDISH_CONTEXT_WINDOW; clear it so num_ctx is the
    // internal default and the assertions are deterministic.
    savedCtxEnv = process.env.CLAUDISH_CONTEXT_WINDOW;
    delete process.env.CLAUDISH_CONTEXT_WINDOW;
  });

  afterEach(() => {
    server?.stop(true);
    server = undefined;
    if (savedCtxEnv === undefined) delete process.env.CLAUDISH_CONTEXT_WINDOW;
    else process.env.CLAUDISH_CONTEXT_WINDOW = savedCtxEnv;
  });

  function serve(fetch: (req: Request) => Response): string {
    server = Bun.serve({ port: 0, fetch });
    return `http://localhost:${server.port}`;
  }

  test("a custom endpoint backed by Ollama gets num_ctx", async () => {
    const baseUrl = serve((req) =>
      new URL(req.url).pathname === "/api/tags" ? ollamaTags() : new Response(null, { status: 404 })
    );
    const t = new LocalTransport(config("custom", baseUrl), "llama3");

    const extra = await t.getExtraPayloadFields();
    expect(extra.options?.num_ctx).toBeGreaterThanOrEqual(32768);
  });

  test("a non-Ollama custom endpoint gets no num_ctx", async () => {
    // No /api/tags route: a plain OpenAI-compatible server.
    const baseUrl = serve(() => new Response(null, { status: 404 }));
    const t = new LocalTransport(config("custom", baseUrl), "some-model");

    expect(await t.getExtraPayloadFields()).toEqual({});
  });

  test("a 200 HTML catch-all is not mistaken for Ollama", async () => {
    const baseUrl = serve(
      () =>
        new Response("<!doctype html><html></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        })
    );
    const t = new LocalTransport(config("custom", baseUrl), "x");

    // /api/tags answered 200 but .json() throws, so the probe must reject it.
    expect(await t.getExtraPayloadFields()).toEqual({});
  });

  test("the literal ollama provider is authoritative and never probes", async () => {
    let tagsHits = 0;
    const baseUrl = serve((req) => {
      if (new URL(req.url).pathname === "/api/tags") {
        tagsHits++;
        return ollamaTags();
      }
      return new Response(null, { status: 404 });
    });
    const t = new LocalTransport(config("ollama", baseUrl), "llama3");

    const extra = await t.getExtraPayloadFields();
    expect(extra.options?.num_ctx).toBeGreaterThanOrEqual(32768);
    expect(tagsHits).toBe(0);
  });

  test("a recognized non-Ollama provider (lmstudio) is not probed", async () => {
    let tagsHits = 0;
    const baseUrl = serve((req) => {
      if (new URL(req.url).pathname === "/api/tags") tagsHits++;
      return new Response(null, { status: 404 });
    });
    const t = new LocalTransport(config("lmstudio", baseUrl), "some-model");

    expect(await t.getExtraPayloadFields()).toEqual({});
    expect(tagsHits).toBe(0);
  });

  test("the probe runs once and is cached across calls", async () => {
    let tagsHits = 0;
    const baseUrl = serve((req) => {
      if (new URL(req.url).pathname === "/api/tags") {
        tagsHits++;
        return ollamaTags();
      }
      return new Response(null, { status: 404 });
    });
    const t = new LocalTransport(config("custom", baseUrl), "x");

    await t.getExtraPayloadFields();
    await t.getExtraPayloadFields();
    expect(tagsHits).toBe(1);
  });
});
