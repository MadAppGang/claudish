import { afterAll, describe, expect, test } from "bun:test";
import { createProxyServer } from "./proxy-server.js";
import type { ProxyServer } from "./types.js";

const TEST_PORT = 19050 + Math.floor(Math.random() * 100);

let proxyServer: ProxyServer | null = null;

async function ensureProxy(): Promise<number> {
  if (proxyServer) return proxyServer.port;
  proxyServer = await createProxyServer(
    TEST_PORT,
    "dummy-openrouter-key",
    undefined,
    false,
    undefined,
    undefined,
    { quiet: true }
  );
  return proxyServer.port;
}

afterAll(async () => {
  if (proxyServer) {
    await proxyServer.shutdown();
    proxyServer = null;
  }
});

async function sendMessage(model: string): Promise<{ status: number; body: any }> {
  const port = await ensureProxy();
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 8,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  return { status: res.status, body: await res.json() };
}

describe("proxy explicit provider routing", () => {
  test("unroutable explicit provider returns a routing error instead of falling back", async () => {
    const result = await sendMessage("missing-provider@example-model");

    expect(result.status).toBe(400);
    expect(result.body.type).toBe("error");
    expect(result.body.error.type).toBe("invalid_request_error");
    expect(result.body.error.message).toContain('Explicit provider "missing-provider"');
  });
});
