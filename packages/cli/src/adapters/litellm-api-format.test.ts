import { expect, test } from "bun:test";
import { LiteLLMAPIFormat } from "./litellm-api-format.js";

test("MiniMax images remain standard image_url parts on LiteLLM", () => {
  const format = new LiteLLMAPIFormat("minimax-m3", "https://example.invalid");
  const messages = format.convertMessages({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
          { type: "image", source: { type: "url", url: "https://example.invalid/image.png" } },
        ],
      },
    ],
  });
  expect(messages[0].content).toEqual([
    { type: "text", text: "Describe this" },
    { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
    { type: "image_url", image_url: { url: "https://example.invalid/image.png" } },
  ]);
});
