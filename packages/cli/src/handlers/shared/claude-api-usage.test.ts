import { expect, test } from "bun:test";
import { type AnthropicUsage, mergeSseUsage } from "./claude-api-usage.js";

test("mergeSseUsage keeps the cache write's split by TTL", () => {
  const usage: AnthropicUsage = {};
  mergeSseUsage(
    `data: ${JSON.stringify({
      type: "message_start",
      message: {
        usage: {
          input_tokens: 3,
          cache_creation_input_tokens: 500,
          cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 300 },
        },
      },
    })}`,
    usage
  );
  mergeSseUsage(
    `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 9 } })}`,
    usage
  );
  expect(usage.cache_creation).toEqual({
    ephemeral_5m_input_tokens: 200,
    ephemeral_1h_input_tokens: 300,
  });
  expect(usage.cache_creation_input_tokens).toBe(500);
  expect(usage.output_tokens).toBe(9);
});
