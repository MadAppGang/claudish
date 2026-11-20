import { expect, test } from "bun:test";
import type { ConnectionResolution } from "../providers/connection-resolver.js";
import { compactionEffort } from "./config.js";
import { CompactionClient } from "./haiku-client.js";

/** `effort: null` builds a client with no effort option. */
function capture(effort: string | null = "low") {
  const bodies: Record<string, unknown>[] = [];
  const requests: Request[] = [];
  const client = new CompactionClient({
    apiKey: "FAKE_CLIENT_OPTIONS_0000",
    model: "test-compaction-model",
    ...(effort === null ? {} : { effort }),
    warn() {},
    record() {},
    fetchImpl: (async (req: Request) => {
      requests.push(req);
      bodies.push(JSON.parse(await req.text()));
      return Response.json({
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "{}" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }) as unknown as typeof fetch,
  });
  return { client, bodies, requests };
}

const BASE = { system: "S", user: "U", maxTokens: 64, timeoutMs: 1000, purpose: "test" };

test("a schema is sent as output_config.format json_schema, beside the effort", async () => {
  const { client, bodies } = capture();
  const schema = { type: "object", properties: {}, additionalProperties: false };
  await client.complete({ ...BASE, schema });
  expect(bodies[0]?.output_config).toEqual({
    effort: "low",
    format: { type: "json_schema", schema },
  });
});

test("a cached prefix is sent as a first text block with a cache marker", async () => {
  const { client, bodies } = capture();
  await client.complete({ ...BASE, cachedPrefix: "CONTEXT" });
  expect(bodies[0]?.messages).toEqual([
    {
      role: "user",
      content: [
        { type: "text", text: "CONTEXT", cache_control: { type: "ephemeral" } },
        { type: "text", text: "U" },
      ],
    },
  ]);
});

test("without either option the request is as before", async () => {
  const { client, bodies } = capture();
  await client.complete(BASE);
  expect(bodies[0]?.messages).toEqual([{ role: "user", content: "U" }]);
  expect(bodies[0]?.output_config).toEqual({ effort: "low" });
});

test("a model with no published effort gets no output_config.effort", async () => {
  const { client, bodies } = capture(null);
  await client.complete(BASE);
  expect(bodies[0]).not.toHaveProperty("output_config");
  const schema = { type: "object", properties: {}, additionalProperties: false };
  await client.complete({ ...BASE, schema });
  expect(bodies[1]?.output_config).toEqual({ format: { type: "json_schema", schema } });
});

/** A resolved Claude API connection whose wire publishes `reasoning`. */
function resolvedWith(reasoning: unknown): ConnectionResolution {
  return {
    ok: true,
    connection: { wire: { status: "known", reasoning } },
  } as unknown as ConnectionResolution;
}

test("the effort comes from the catalog wire: the native value of low at /output_config/effort", () => {
  const published = resolvedWith({
    status: "supported",
    enable: { status: "not_applicable" },
    disable: { status: "not_applicable" },
    effort: { path: "/output_config/effort", values: { low: "low", high: "high" }, default: "high" },
    mode: { status: "unknown" },
  });
  expect(compactionEffort("claude-haiku-x", () => published)).toBe("low");

  // Effort unknown for the model (as for an older Haiku): nothing is sent.
  expect(compactionEffort("claude-haiku-y", () => resolvedWith({ status: "unknown" }))).toBe(
    undefined
  );
  // Effort published elsewhere, or without a low level: nothing is sent.
  const elsewhere = resolvedWith({
    status: "supported",
    enable: { status: "not_applicable" },
    disable: { status: "not_applicable" },
    effort: { path: "/thinking/effort", values: { low: "low" }, default: "low" },
    mode: { status: "unknown" },
  });
  expect(compactionEffort("claude-haiku-z", () => elsewhere)).toBe(undefined);
  const noLow = resolvedWith({
    status: "supported",
    enable: { status: "not_applicable" },
    disable: { status: "not_applicable" },
    effort: { path: "/output_config/effort", values: { high: "high" }, default: "high" },
    mode: { status: "unknown" },
  });
  expect(compactionEffort("claude-haiku-w", () => noLow)).toBe(undefined);
  // No catalog connection: nothing is sent.
  expect(
    compactionEffort("claude-haiku-v", () => ({ ok: false, reason: "no-catalog" }) as never)
  ).toBe(undefined);
});
