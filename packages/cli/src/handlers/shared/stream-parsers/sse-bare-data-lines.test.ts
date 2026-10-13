import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DefaultAPIFormat } from "../../../adapters/base-api-format.js";
import { GeminiAPIFormat } from "../../../adapters/gemini-api-format.js";
import { createGeminiSseStream } from "./gemini-sse.js";
import { createResponsesStreamHandler } from "./openai-responses-sse.js";
import { createStreamingResponseHandler } from "./openai-sse.js";

interface ClaudeEvent {
  type: string;
  index?: number;
  message?: { id: string };
  content_block?: { type: string; name?: string };
  delta?: { type?: string; text?: string; thinking?: string; stop_reason?: string };
}

function fixture(name: string): string {
  return readFileSync(
    new URL(`../../../test-fixtures/sse-responses/${name}`, import.meta.url),
    "utf8"
  );
}

function upstream(wire: string): Response {
  return new Response(wire, { headers: { "content-type": "text/event-stream" } });
}

function context(): any {
  return {
    body: (stream: ReadableStream, init?: ResponseInit) => new Response(stream, init),
    json: () => {
      throw new Error("Unexpected no-body error path");
    },
  };
}

async function events(response: Response): Promise<ClaudeEvent[]> {
  return (
    (await response.text())
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)) as ClaudeEvent)
      // Each replay generates a fresh message id. Preserve all other event fields.
      .map((event) =>
        event.type === "message_start" && event.message
          ? { ...event, message: { ...event.message, id: "generated-message-id" } }
          : event
      )
  );
}

const dashscope = "dashscope-qwen3.8-max-0902-bare-data-lines.sse";

describe("SSE optional data space regression", () => {
  test("Responses replays DashScope raw reasoning and Hi through end_turn", async () => {
    const wire = fixture(dashscope);
    expect(wire).toContain("event:response.reasoning_text.delta\n:HTTP_STATUS/200\ndata:");
    expect(wire).toContain("id:1\n");
    expect(wire).not.toMatch(/^data: /m);
    const reasoning = wire
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5)))
      .filter((event) => event.type === "response.reasoning_text.delta")
      .map((event) => event.delta)
      .join("");
    expect(reasoning.length).toBeGreaterThan(0);

    const parsed = await events(
      createResponsesStreamHandler(context(), upstream(wire), {
        modelName: "qwen3.8-max-0902",
      })
    );
    const starts = parsed.filter((event) => event.type === "content_block_start");
    expect(starts.map((event) => event.content_block?.type)).toEqual(["thinking", "text"]);
    const thinkingIndex = starts[0]!.index;
    const textIndex = starts[1]!.index;
    expect(
      parsed
        .filter((event) => event.index === thinkingIndex && event.delta?.type === "thinking_delta")
        .map((event) => event.delta?.thinking)
        .join("")
    ).toBe(reasoning);
    expect(
      parsed
        .filter((event) => event.index === textIndex && event.delta?.type === "text_delta")
        .map((event) => event.delta?.text)
        .join("")
    ).toBe("Hi");
    expect(parsed.find((event) => event.type === "message_delta")?.delta?.stop_reason).toBe(
      "end_turn"
    );
    expect(parsed.at(-1)?.type).toBe("message_stop");
  });

  test("OpenAI chat preserves every event when real capture data spaces are removed", async () => {
    // Also replayed by format-translation.test.ts; captured Grok reasoning + Edit call.
    const wire = fixture("grok-4.6-openai-edit-empty-new-string.sse");
    const bare = wire.replace(/^data: /gm, "data:");
    expect(bare).not.toBe(wire);
    const replay = (input: string) =>
      events(
        createStreamingResponseHandler(
          context(),
          upstream(input),
          new DefaultAPIFormat("grok-4.6"),
          "grok-4.6",
          null
        )
      );
    const original = await replay(wire);
    expect(original.some((event) => event.content_block?.type === "thinking")).toBe(true);
    expect(original.some((event) => event.content_block?.name === "Edit")).toBe(true);
    expect(original.find((event) => event.type === "message_delta")?.delta?.stop_reason).toBe(
      "tool_use"
    );
    expect(await replay(bare)).toEqual(original);
  });

  test("Gemini preserves every event when real capture data spaces are removed", async () => {
    // Also replayed by format-translation.test.ts; real Antigravity OK answer.
    const wire = fixture("gemini-3.6-flash-antigravity-ok-answer.sse");
    const bare = wire.replace(/^data: /gm, "data:");
    expect(bare).not.toBe(wire);
    const replay = (input: string) =>
      events(
        createGeminiSseStream(context(), upstream(input), {
          modelName: "gemini-3.6-flash",
          adapter: new GeminiAPIFormat("gemini-3.6-flash"),
          unwrapResponse: true,
        })
      );
    const original = await replay(wire);
    expect(
      original
        .filter((event) => event.delta?.type === "text_delta")
        .map((event) => event.delta?.text)
        .join("")
    ).toBe("OK");
    expect(original.find((event) => event.type === "message_delta")?.delta?.stop_reason).toBe(
      "end_turn"
    );
    expect(await replay(bare)).toEqual(original);
  });
});
