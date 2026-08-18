import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { setConfigFileOverride } from "./config-override.js";
import { wrapAnthropicError } from "./handlers/shared/anthropic-error.js";
import { log, logStderr } from "./logger.js";
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
