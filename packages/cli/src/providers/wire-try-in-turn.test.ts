import { beforeEach, expect, test } from "bun:test";
import { Hono } from "hono";
import type { WireApi } from "./connection-wire.js";
import {
  TryInTurnHandler,
  _clearTryInTurnMemory,
  apiOnlyWire,
  isProtocolMismatch,
  tryInTurnOrder,
} from "./wire-try-in-turn.js";

beforeEach(_clearTryInTurnMemory);
test.each([
  [404, "missing", true],
  [405, "method", true],
  [400, "wrong protocol", true],
  [400, "Use the v1/responses endpoint", true],
  [400, "Unsupported parameter: 'messages'", true],
  [400, '{"error":{"upstream_status":404}}', true],
  [401, "protocol", false],
  [403, "endpoint", false],
  [429, "protocol", false],
  [500, "endpoint", false],
  [400, "invalid value", false],
] as const)("mismatch %s %s", (status, body, expected) =>
  expect(isProtocolMismatch(status, body)).toBe(expected)
);
test("orders only published APIs", () =>
  expect(tryInTurnOrder(["gemini", "chat-completions", "responses"], "key")).toEqual([
    "responses",
    "chat-completions",
    "gemini",
  ]));
function harness(statuses: Partial<Record<WireApi, number>>) {
  const calls: WireApi[] = [];
  const handler = new TryInTurnHandler(
    "key",
    "fixture connection",
    Object.keys(statuses) as WireApi[],
    (api) => ({
      async handle(_c, payload) {
        expect(payload).toEqual({ original: true });
        payload.original = false;
        calls.push(api);
        return new Response(api, { status: statuses[api] });
      },
      async shutdown() {},
    })
  );
  const app = new Hono();
  app.post("/", (c) => handler.handle(c, { original: true }));
  return { calls, request: () => app.request("/", { method: "POST" }) };
}
test("advances on mismatch and remembers success for the second request", async () => {
  const h = harness({ responses: 404, "chat-completions": 200 });
  expect((await h.request()).status).toBe(200);
  expect(h.calls).toEqual(["responses", "chat-completions"]);
  expect(tryInTurnOrder(["responses", "chat-completions"], "key")).toEqual([
    "chat-completions",
    "responses",
  ]);
  await h.request();
  expect(h.calls).toEqual(["responses", "chat-completions", "chat-completions"]);
  expect(tryInTurnOrder(["responses", "chat-completions"], "other-generation")).toEqual([
    "responses",
    "chat-completions",
  ]);
});
test.each([400, 401, 403, 429, 500])("stops at non-mismatch %s", async (status) => {
  const h = harness({ responses: status, "chat-completions": 200 });
  expect((await h.request()).status).toBe(status);
  expect(h.calls).toEqual(["responses"]);
});
test("returns last mismatch when all APIs fail", async () => {
  const h = harness({ responses: 404, "chat-completions": 405 });
  const response = await h.request();
  expect(response.status).toBe(405);
  expect(await response.text()).toBe("chat-completions");
  expect(h.calls).toEqual(["responses", "chat-completions"]);
});
test.each(["responses", "chat-completions", "anthropic-messages", "gemini"] as const)(
  "API-only %s has no guessed decisions",
  (api) => {
    expect(apiOnlyWire(api)).toEqual({
      status: "known",
      api,
      tokenParam: { status: api === "gemini" ? "not_applicable" : "unknown" },
      toolsWithReasoning: { status: "unknown" },
      reasoning: { status: "unknown" },
      speed: { status: "unknown" },
      evidence: [],
    });
  }
);
