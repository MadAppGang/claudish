// The gemini-sse parser reports a turn's output tokens with the reasoning
// included: once to the token callback and once in the message_delta usage.
import { expect, test } from "bun:test";
import type { Context } from "hono";
import { createGeminiSseStream } from "./gemini-sse.js";

function ctx(): Context {
  return { req: { header: () => ({}) }, header: () => {} } as unknown as Context;
}

function upstream(): Response {
  const body = `data: ${JSON.stringify({
    candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
    usageMetadata: {
      promptTokenCount: 11145,
      candidatesTokenCount: 37,
      thoughtsTokenCount: 27,
      totalTokenCount: 11209,
    },
  })}\n\n`;
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

async function drain(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

test("thought tokens reach the token callback and the message_delta usage", async () => {
  const updates: Array<[number, number]> = [];
  const sse = await drain(
    createGeminiSseStream(ctx(), upstream(), {
      modelName: "gemini-4-carbon",
      onTokenUpdate: (input, output) => updates.push([input, output]),
    })
  );
  expect(updates).toEqual([[11145, 64]]);
  const delta = sse
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)))
    .find((event) => event.type === "message_delta");
  expect(delta.usage.output_tokens).toBe(64);
});
