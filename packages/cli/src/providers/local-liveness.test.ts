import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isHtmlResponse, localBaseUrl, pingLocalProvider } from "./local-liveness.js";

const viteHtmlBody = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/x-icon" href="/assets/favicon-C5W4yrKp.ico" />
  </head>
</html>`;

describe("localBaseUrl", () => {
  const ENVS = ["OLLAMA_BASE_URL", "OLLAMA_HOST", "LMSTUDIO_BASE_URL"];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const e of ENVS) {
      saved[e] = process.env[e];
      delete process.env[e];
    }
  });
  afterEach(() => {
    for (const e of ENVS) {
      if (saved[e] === undefined) delete process.env[e];
      else process.env[e] = saved[e];
    }
  });

  test("returns the catalog default for a local provider with no env override", () => {
    expect(localBaseUrl("ollama")).toBe("http://localhost:11434");
    expect(localBaseUrl("lmstudio")).toBe("http://localhost:1234");
  });

  test("honors an env-var override (first in catalog order wins)", () => {
    process.env.OLLAMA_BASE_URL = "http://gpu-box:11434/";
    // trailing slash trimmed
    expect(localBaseUrl("ollama")).toBe("http://gpu-box:11434");
  });

  test("falls through to the second env var when the first is unset", () => {
    process.env.OLLAMA_HOST = "http://other-host:11434";
    expect(localBaseUrl("ollama")).toBe("http://other-host:11434");
  });

  test("returns null for a non-local / unknown provider", () => {
    expect(localBaseUrl("openrouter")).toBeNull();
    expect(localBaseUrl("does-not-exist")).toBeNull();
  });
});

describe("pingLocalProvider", () => {
  let originalMlxBaseUrl: string | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;

  beforeEach(() => {
    originalMlxBaseUrl = process.env.MLX_BASE_URL;
  });

  afterEach(() => {
    server?.stop(true);
    server = undefined;
    if (originalMlxBaseUrl === undefined) delete process.env.MLX_BASE_URL;
    else process.env.MLX_BASE_URL = originalMlxBaseUrl;
  });

  function serveMlx(fetch: (req: Request) => Response): void {
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
    process.env.MLX_BASE_URL = `http://127.0.0.1:${server.port}`;
  }

  test("'down' for a 200 HTML page served by an unrelated web app", async () => {
    serveMlx((req) => {
      if (new URL(req.url).pathname !== "/v1/models") {
        return new Response(null, { status: 404 });
      }
      return new Response(viteHtmlBody, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    });

    expect(await pingLocalProvider("mlx")).toBe("down");
  });

  test("'running' for a JSON model-list response", async () => {
    serveMlx(
      () =>
        new Response('{"data":[{"id":"some-model"}]}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );

    expect(await pingLocalProvider("mlx")).toBe("running");
  });

  for (const status of [401, 404]) {
    test(`'running' for an HTTP ${status} response`, async () => {
      serveMlx(() => new Response(null, { status }));
      expect(await pingLocalProvider("mlx")).toBe("running");
    });
  }

  test("'down' when the configured MLX port refuses the connection", async () => {
    const stoppedServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(null, { status: 204 }),
    });
    const stoppedPort = stoppedServer.port;
    stoppedServer.stop(true);
    process.env.MLX_BASE_URL = `http://127.0.0.1:${stoppedPort}`;

    expect(await pingLocalProvider("mlx", 300)).toBe("down");
  });

  test("'down' for a local pointed at an unreachable host (short timeout)", async () => {
    const saved = process.env.OLLAMA_BASE_URL;
    // A reserved-for-docs IP (TEST-NET-1) — connections never complete.
    process.env.OLLAMA_BASE_URL = "http://192.0.2.1:11434";
    try {
      // Tight timeout so the test is fast; an unreachable host yields "down".
      expect(await pingLocalProvider("ollama", 300)).toBe("down");
    } finally {
      if (saved === undefined) delete process.env.OLLAMA_BASE_URL;
      else process.env.OLLAMA_BASE_URL = saved;
    }
  });

  test("'unknown' for a provider that isn't a known local one", async () => {
    expect(await pingLocalProvider("openrouter")).toBe("unknown");
    expect(await pingLocalProvider("not-a-real-provider")).toBe("unknown");
  });
});

describe("isHtmlResponse", () => {
  for (const contentType of ["text/html", "text/html; charset=utf-8", "application/xhtml+xml"]) {
    test(`returns true for ${contentType}`, () => {
      expect(isHtmlResponse(new Response(null, { headers: { "Content-Type": contentType } }))).toBe(
        true
      );
    });
  }

  test("returns false for application/json", () => {
    expect(
      isHtmlResponse(new Response(null, { headers: { "Content-Type": "application/json" } }))
    ).toBe(false);
  });

  test("returns false when Content-Type is missing", () => {
    expect(isHtmlResponse(new Response(null))).toBe(false);
  });
});
