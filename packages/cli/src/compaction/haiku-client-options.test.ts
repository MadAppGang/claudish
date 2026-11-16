import { expect, test } from "bun:test";
import { CompactionClient } from "./haiku-client.js";

function capture() {
  const bodies: Record<string, unknown>[] = [];
  const client = new CompactionClient({
    apiKey: "FAKE_CLIENT_OPTIONS_0000",
    model: "test-compaction-model",
    warn() {},
    record() {},
    fetchImpl: (async (req: Request) => {
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
  return { client, bodies };
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
