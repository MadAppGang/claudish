/**
 * The context window LocalTransport reports for LM Studio.
 *
 * The status line reads this number, so it must agree with the window claudish
 * gives Claude Code at launch: the loaded instance's window, else the default.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { LocalProvider } from "../provider-registry.js";
import { LocalTransport } from "./local.js";

const LMSTUDIO_DEFAULT_WINDOW = 128_000;

const ROWS = [
  {
    id: "publisher/loaded-build",
    type: "llm",
    state: "loaded",
    max_context_length: 262_144,
    loaded_context_length: 213_176,
  },
  {
    id: "publisher/unloaded-build",
    type: "llm",
    state: "not-loaded",
    max_context_length: 262_144,
  },
];

function config(name: string, baseUrl: string): LocalProvider {
  return { name, baseUrl, apiPath: "/v1/chat/completions", envVar: "", prefixes: [] };
}

describe("LocalTransport context window on lmstudio", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  let savedCtxEnv: string | undefined;

  function lmStudio(nativeList: () => Response): string {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/api/v0/models") return nativeList();
        if (path === "/v1/models") return Response.json({ object: "list", data: [] });
        return new Response(null, { status: 404 });
      },
    });
    return `http://127.0.0.1:${server.port}`;
  }

  async function windowOf(model: string, nativeList: () => Response): Promise<number> {
    const transport = new LocalTransport(config("lmstudio", lmStudio(nativeList)), model);
    await transport.refreshAuth();
    return transport.getContextWindow();
  }

  beforeEach(() => {
    savedCtxEnv = process.env.CLAUDISH_CONTEXT_WINDOW;
    delete process.env.CLAUDISH_CONTEXT_WINDOW;
  });

  afterEach(() => {
    server?.stop(true);
    server = undefined;
    if (savedCtxEnv === undefined) delete process.env.CLAUDISH_CONTEXT_WINDOW;
    else process.env.CLAUDISH_CONTEXT_WINDOW = savedCtxEnv;
  });

  test("starts on the provider default before any request", () => {
    const transport = new LocalTransport(config("lmstudio", "http://127.0.0.1:1"), "some-model");

    expect(transport.getContextWindow()).toBe(LMSTUDIO_DEFAULT_WINDOW);
  });

  test("a loaded model reports the window of its loaded instance", async () => {
    expect(await windowOf("publisher/loaded-build", () => Response.json({ data: ROWS }))).toBe(
      213_176
    );
  });

  test("an unloaded model keeps the provider default", async () => {
    expect(await windowOf("publisher/unloaded-build", () => Response.json({ data: ROWS }))).toBe(
      LMSTUDIO_DEFAULT_WINDOW
    );
  });

  test("an unloaded model whose maximum is below the default reports its maximum", async () => {
    const rows = [{ id: "small", type: "llm", state: "not-loaded", max_context_length: 32_768 }];

    expect(await windowOf("small", () => Response.json({ data: rows }))).toBe(32_768);
  });

  test("a server without the native list keeps the provider default", async () => {
    expect(
      await windowOf("publisher/loaded-build", () => new Response(null, { status: 404 }))
    ).toBe(LMSTUDIO_DEFAULT_WINDOW);
  });

  test("CLAUDISH_CONTEXT_WINDOW still wins", async () => {
    process.env.CLAUDISH_CONTEXT_WINDOW = "48000";

    expect(await windowOf("publisher/loaded-build", () => Response.json({ data: ROWS }))).toBe(
      48_000
    );
  });
});

describe("LocalTransport context window on other local providers", () => {
  test("vllm keeps its existing default", () => {
    const transport = new LocalTransport(config("vllm", "http://127.0.0.1:1"), "some-model");

    expect(transport.getContextWindow()).toBe(32768);
  });
});
