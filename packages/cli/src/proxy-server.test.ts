import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { setConfigFileOverride } from "./config-override.js";
import { wrapAnthropicError } from "./handlers/shared/anthropic-error.js";
import { log, logStderr } from "./logger.js";
import { __resetEndpointDiagnosticsForTests } from "./providers/endpoint-diagnostics.js";
import { invalidateEndpointRegistration } from "./providers/endpoint-registration.js";
import { __resetPredefinedStateForTests } from "./providers/predefined-endpoints.js";
import { clearRuntimeRegistry } from "./providers/runtime-providers.js";
import { createProxyServer } from "./proxy-server.js";
import type { ProxyServer } from "./types.js";

interface ModelsResponse {
  object: string;
  has_more: boolean;
  data: Array<{
    id: string;
    object: string;
    type: string;
    created: number;
    owned_by: string;
  }>;
}

async function requestModels(
  config: Record<string, unknown>,
  servedSlotIds?: string[]
): Promise<{ status: number; body: ModelsResponse }> {
  const tempDir = mkdtempSync(join(tmpdir(), "claudish-model-discovery-"));
  const configPath = join(tempDir, "config.json");
  writeFileSync(configPath, JSON.stringify(config), "utf8");

  // The CLI bootstrap turns CLAUDISH_CONFIG into this process-wide override.
  // Tests invoke createProxyServer directly, so install the same override here.
  setConfigFileOverride(configPath);
  let proxy: ProxyServer | undefined;

  try {
    proxy = await createProxyServer(0, undefined, undefined, false, undefined, undefined, {
      quiet: true,
      servedSlotIds,
    });
    const response = await fetch(`${proxy.url}/v1/models`);
    return {
      status: response.status,
      body: (await response.json()) as ModelsResponse,
    };
  } finally {
    if (proxy) await proxy.shutdown();
    setConfigFileOverride(null);
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function requestTokenCount(
  config: Record<string, unknown>,
  model: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const tempDir = mkdtempSync(join(tmpdir(), "claudish-keyless-handler-"));
  const configPath = join(tempDir, "config.json");
  writeFileSync(configPath, JSON.stringify(config), "utf8");
  setConfigFileOverride(configPath);
  let proxy: ProxyServer | undefined;

  try {
    proxy = await createProxyServer(0, undefined, undefined, false, undefined, undefined, {
      quiet: true,
    });
    // count_tokens constructs the selected provider handler, then estimates
    // locally. It exercises the proxy's credential gate without contacting the
    // configured upstream endpoint.
    const response = await fetch(`${proxy.url}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: 16,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  } finally {
    if (proxy) await proxy.shutdown();
    setConfigFileOverride(null);
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const realConsoleError = console.error;
const realStderrWrite = process.stderr.write;

afterEach(() => {
  console.error = realConsoleError;
  process.stderr.write = realStderrWrite;
  invalidateEndpointRegistration();
  __resetPredefinedStateForTests();
  __resetEndpointDiagnosticsForTests();
  clearRuntimeRegistry();
  setConfigFileOverride(null);
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

describe("GET /v1/models", () => {
  test("slot mode is unchanged", async () => {
    const { status, body } = await requestModels({}, ["claude-haiku-4-5"]);

    expect(status).toBe(200);
    expect(body.data).toEqual([
      {
        id: "claude-haiku-4-5",
        object: "model",
        type: "model",
        created: 1716000000,
        owned_by: "claudish",
      },
    ]);
  });

  test("slot mode wins over discoverable config models", async () => {
    const { body } = await requestModels(
      {
        routing: { "routing-model": ["openrouter"] },
        customEndpoints: {
          "slot-wins-fixture": {
            kind: "simple",
            url: "http://127.0.0.1:1/v1",
            format: "openai",
            apiKey: "test-key",
            models: ["custom-model"],
          },
        },
      },
      ["claude-opus-4-1", "claude-sonnet-4-5"]
    );

    expect(body.data.map(({ id }) => id)).toEqual(["claude-opus-4-1", "claude-sonnet-4-5"]);
  });

  test("discovery lists routing rule names", async () => {
    const { body } = await requestModels({
      routing: {
        "routing-model-a": ["openrouter"],
        "routing-model-b": ["openai"],
      },
    });

    expect(body.data.map(({ id }) => id)).toEqual(["routing-model-a", "routing-model-b"]);
  });

  test("discovery excludes the routing wildcard", async () => {
    const { body } = await requestModels({
      routing: {
        "*": ["openrouter"],
        "named-model": ["openrouter"],
      },
    });

    expect(body.data.map(({ id }) => id)).toEqual(["named-model"]);
  });

  test("discovery includes custom endpoint models", async () => {
    const { body } = await requestModels({
      customEndpoints: {
        "model-list-fixture": {
          kind: "simple",
          url: "http://127.0.0.1:1/v1",
          format: "openai",
          apiKey: "test-key",
          models: ["a", "b"],
        },
      },
    });

    expect(body.data.map(({ id }) => id)).toEqual(["a", "b"]);
  });

  test("empty config returns an empty list with HTTP 200", async () => {
    // Positive control: an always-empty implementation must not make this
    // negative case pass while bypassing config discovery altogether.
    const populated = await requestModels({ routing: { "discovery-control": ["openrouter"] } });
    expect(populated.body.data.map(({ id }) => id)).toEqual(["discovery-control"]);

    const { status, body } = await requestModels({});
    expect(status).toBe(200);
    expect(body).toEqual({ object: "list", has_more: false, data: [] });
  });
});

describe('proxy handler routing for authScheme "none"', () => {
  test("does not reject a keyless custom endpoint at the anti-poison credential gate", async () => {
    const envVar = "CUSTOM_KEYLESS_PROXY_REGRESSION_KEY";
    const saved = process.env[envVar];
    delete process.env[envVar];

    try {
      const { status, body } = await requestTokenCount(
        {
          customEndpoints: {
            "keyless-proxy-regression": {
              kind: "simple",
              url: "http://127.0.0.1:1/v1",
              format: "openai",
              authScheme: "none",
            },
          },
        },
        "keyless-proxy-regression@test-model"
      );

      expect(process.env[envVar]).toBeUndefined();
      expect(status).toBe(200);
      expect(typeof body.input_tokens).toBe("number");
    } finally {
      if (saved === undefined) delete process.env[envVar];
      else process.env[envVar] = saved;
    }
  });
});

describe("ProxyServer.fetch (in-process dispatch)", () => {
  test("dispatches through the app with no TCP loopback, matching the served port", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "claudish-inproc-"));
    const configPath = join(tempDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ version: "2", defaultProfile: "default", profiles: {} }),
      "utf8"
    );
    setConfigFileOverride(configPath);
    let proxy: ProxyServer | undefined;

    try {
      proxy = await createProxyServer(0, undefined, undefined, false, undefined, undefined, {
        quiet: true,
      });
      const viaTcp = await fetch(`${proxy.url}/v1/models`);
      const viaApp = await proxy.fetch(new Request("http://proxy.local/v1/models"));

      expect(viaApp.status).toBe(viaTcp.status);
      expect(await viaApp.json()).toEqual(await viaTcp.json());
    } finally {
      if (proxy) await proxy.shutdown();
      setConfigFileOverride(null);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
