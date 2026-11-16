/**
 * `claudish serve` and a request whose model matches no slot. A bare Claude
 * name is the Claude subscription: without the API-billing opt-in it is never
 * signed with the user's Anthropic key, and a request with no Claude login is
 * refused before any upstream call. With the opt-in it is signed with the key.
 */
import { expect, test } from "bun:test";
import { KEY, isolatedFile } from "./test-helpers/claude-behaviour.js";

await isolatedFile(import.meta, async () => {
  const { createProxyServer } = await import("./proxy-server.js");
  const { serveProxyOptions } = await import("./serve-command.js");

  const payload = {
    model: "claude-opus-5",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 1,
  };

  /** Every request the fake Anthropic upstream received, with its headers. */
  async function serveRequest(apiBillingOptIn: boolean, slots: Array<[string, string, string]>) {
    const received: Headers[] = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        received.push(req.headers);
        await req.text();
        return Response.json({
          id: "msg_fake",
          type: "message",
          role: "assistant",
          model: "claude-opus-5",
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "end_turn",
        });
      },
    });
    const previous = process.env.CLAUDISH_TEST_UPSTREAM;
    process.env.CLAUDISH_TEST_UPSTREAM = upstream.url.origin;
    const slotMap = new Map(
      slots.map(([slot, provider, model]) => [slot, { provider, model }] as const)
    );
    let proxy: Awaited<ReturnType<typeof createProxyServer>> | undefined;
    try {
      proxy = await createProxyServer(
        0,
        undefined,
        undefined,
        false,
        KEY,
        undefined,
        serveProxyOptions(
          slotMap,
          slots.map(([slot]) => slot),
          apiBillingOptIn
        )
      );
      const response = await fetch(`${proxy.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      return { status: response.status, body: await response.text(), received };
    } finally {
      await proxy?.shutdown();
      upstream.stop(true);
      if (previous === undefined) delete process.env.CLAUDISH_TEST_UPSTREAM;
      else process.env.CLAUDISH_TEST_UPSTREAM = previous;
    }
  }

  const otherSlot: Array<[string, string, string]> = [["gpt-slot", "openrouter", "openai/gpt-x"]];

  test("without the opt-in an unmapped bare Claude request is refused, never key-signed", async () => {
    const { status, body, received } = await serveRequest(false, otherSlot);
    expect(received.map((h) => h.get("x-api-key"))).toEqual([]);
    expect(status).toBe(401);
    expect(JSON.parse(body)).toMatchObject({
      type: "error",
      error: { type: "authentication_error" },
    });
    expect(body).not.toContain(KEY);
  }, 30_000);

  test("with the opt-in an unmapped bare Claude request is signed with the key", async () => {
    const { status, received } = await serveRequest(true, otherSlot);
    expect(status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0].get("x-api-key")).toBe(KEY);
  }, 30_000);

  test("serveProxyOptions signs login-only only without the opt-in", () => {
    expect(serveProxyOptions(new Map(), [], false).nativeSigning).toEqual({ kind: "login-only" });
    expect(serveProxyOptions(new Map(), [], true).nativeSigning).toBeUndefined();
  });
});
