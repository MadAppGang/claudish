/**
 * Regression — SSE `data:` lines without the space after the colon
 * (port of upstream 3dbd3167).
 *
 * Every parser here used to gate on `startsWith("data: ")` with the space
 * MANDATORY, so a conforming provider emitting the bare `data:{…}` form had
 * every line silently skipped — measured upstream on DashScope's Responses
 * API (qwen3.8-max-0902, 2026-10-14: empty answer, "--probe" said "stream
 * ended without content"). Our anthropic parser normalizes inline (fork-era
 * discovery, Alibaba MaaS); this file pins the three parsers that used to
 * gate: openai-sse, openai-responses-sse, gemini-sse.
 *
 * Method (upstream's): take a REAL captured fixture, strip the space from
 * every data line, and require the bare replay to produce events identical
 * to the spaced original — byte-for-byte equality, not just "some text".
 * The Gemini leg has no captured fixture in this fork, so its gate is pinned
 * by the sseDataPayload unit tests plus the shared-helper wiring (a bare
 * line reaching createGeminiSseStream parses through the same function).
 *
 * Run: bun test packages/cli/src/handlers/shared/stream-parsers/sse-bare-data-lines.test.ts
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createGeminiSseStream } from "./gemini-sse.js";
import { createResponsesStreamHandler } from "./openai-responses-sse.js";
import { createStreamingResponseHandler } from "./openai-sse.js";

interface ClaudeEvent {
  type: string;
  index?: number;
  message?: { id: string };
  content_block?: { type: string; name?: string };
  delta?: { type?: string; text?: string; stop_reason?: string };
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

/**
 * Identity adapter (review #469, nit 1): the openai replay used to pass
 * `adapter = null`, so every real text chunk died on a TypeError and BOTH
 * replays (spaced and bare) converged to the parser's injected "empty
 * response" message — the equality compared error injection to error
 * injection. The identity stub lets real content flow, and the leg below
 * asserts on it.
 */
const identityAdapter = {
  processTextContent: (textContent: string) => ({
    cleanedText: textContent,
    extractedToolCalls: [] as unknown[],
    wasTransformed: false,
  }),
};

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

describe("SSE optional data space regression (upstream 3dbd3167)", () => {
  test("Responses parser: bare-data replay is event-identical to the spaced original", async () => {
    const wire = fixture("SEED-responses-text-only.sse");
    const bare = wire.replace(/^data: /gm, "data:");
    expect(bare).not.toBe(wire);

    const replay = (input: string) =>
      events(createResponsesStreamHandler(context(), upstream(input), { modelName: "gpt-5.6" }));

    const original = await replay(wire);
    expect(original.some((e) => e.delta?.type === "text_delta")).toBe(true);
    expect(original.at(-1)?.type).toBe("message_stop");
    expect(await replay(bare)).toEqual(original);
  });

  test("OpenAI chat parser: bare-data replay is event-identical to the spaced original", async () => {
    const wire = fixture("SEED-openai-text-only.sse");
    const bare = wire.replace(/^data: /gm, "data:");
    expect(bare).not.toBe(wire);

    const replay = (input: string) =>
      events(
        createStreamingResponseHandler(
          context(),
          upstream(input),
          identityAdapter,
          "gpt-5.6",
          null
        )
      );

    const original = await replay(wire);
    expect(original.some((e) => e.delta?.type === "text_delta")).toBe(true);
    expect(original.at(-1)?.type).toBe("message_stop");
    // Real content, not the empty-response injection (identity adapter — review #469).
    // The fixture-specific substring is what discriminates: with adapter=null
    // both replays die on the TypeError and converge to the parser's injected
    // 223-char empty-response message, which does NOT contain this text.
    const text = original
      .filter((e) => e.delta?.type === "text_delta")
      .map((e) => e.delta?.text ?? "")
      .join("");
    expect(text).toContain("a test model.");
    expect(await replay(bare)).toEqual(original);
  });

  // Committed pin for the gemini gate (review #469, nit 2): the coordinator's
  // mutation pass showed reverting gemini-sse's bare-data handling stayed
  // GREEN — only the shared helper was pinned, not this parser's own read
  // loop. This drives createGeminiSseStream end-to-end with a bare-data wire
  // and asserts the text reaches the CLIENT-bound stream.
  test("Gemini parser: bare-data wire delivers text to the client stream", async () => {
    const bare = [
      'data:{"candidates":[{"content":{"parts":[{"text":"bare-gemini"}]}}]}',
      'data:{"candidates":[{"content":{"parts":[{"text":"-ok"}]}}]}',
      "",
      "",
    ].join("\n");

    const response = createGeminiSseStream(context(), upstream(bare), {
      modelName: "gemini-2.0-flash",
    });
    const out = await response.text();
    expect(out).toContain("bare-gemini");
    expect(out).toContain("-ok");
  });
});
