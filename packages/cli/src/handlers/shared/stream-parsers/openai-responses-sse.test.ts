import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseInBandApiError } from "../../../in-band-api-error.js";

import { createResponsesStreamHandler } from "./openai-responses-sse.js";

interface ClaudeEvent {
  data: {
    type?: string;
    delta?: {
      type?: string;
      text?: string;
    };
  };
}

const REAL_CONTEXT_LENGTH_ERROR =
  '{"type":"error","error":{"type":"invalid_request_error","code":"context_length_exceeded","message":"Your input exceeds the context window of this model. Please adjust your input and try again.","param":"input"},"sequence_number":2}';

const REAL_ERROR_MESSAGE =
  "Your input exceeds the context window of this model. Please adjust your input and try again.";

function contextLengthErrorResponse(error = REAL_CONTEXT_LENGTH_ERROR): Response {
  const realFixture = readFileSync(
    new URL(
      "../../../test-fixtures/sse-responses/gpt-5.6-sol-responses-turn1.sse",
      import.meta.url
    ),
    "utf8"
  );
  const responseCreatedOpening = realFixture.split("\n\n", 1)[0];
  const sse = `${responseCreatedOpening}\n\ndata: ${error}\n\n`;

  return new Response(sse, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function createMockContext(): any {
  return {
    json() {
      throw new Error("Unexpected no-body error path");
    },
  };
}

async function parseClaudeSseStream(response: Response): Promise<ClaudeEvent[]> {
  const wire = await response.text();

  return wire
    .split("\n\n")
    .map((part) => part.split("\n").find((line) => line.startsWith("data: ")))
    .filter((line): line is string => Boolean(line) && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as ClaudeEvent["data"])
    .map((data) => ({ data }));
}

function extractText(events: ClaudeEvent[]): string {
  return events
    .filter(
      (event) =>
        event.data.type === "content_block_delta" && event.data.delta?.type === "text_delta"
    )
    .map((event) => event.data.delta?.text ?? "")
    .join("");
}

describe("OpenAI Responses SSE — Context limit reached", () => {
  test("emits actionable text with the backend cap and signals the API error", async () => {
    const onApiError = mock((_code: string, _message: string) => {});
    const parsedResponse = createResponsesStreamHandler(
      createMockContext(),
      contextLengthErrorResponse(),
      {
        modelName: "gpt-5.6-sol",
        contextWindow: 372000,
        onApiError,
      }
    );

    const text = extractText(await parseClaudeSseStream(parsedResponse));

    const error = parseInBandApiError(text);
    expect(error).toEqual({
      code: "context_length_exceeded",
      text: expect.stringContaining("Context limit reached"),
    });
    expect(error?.text).toContain("/clear");
    expect(error?.text).toContain("oai@gpt-5.6-sol");

    expect(text).toContain("Context limit reached");
    expect(text).toContain("/clear");
    expect(text).toContain("oai@gpt-5.6-sol");
    expect(text).toContain("372K");
    expect(onApiError).toHaveBeenCalledTimes(1);
    expect(onApiError).toHaveBeenCalledWith("context_length_exceeded", REAL_ERROR_MESSAGE);
  });

  test("omits an invalid cap when contextWindow is unavailable", async () => {
    const parsedResponse = createResponsesStreamHandler(
      createMockContext(),
      contextLengthErrorResponse(),
      {
        modelName: "gpt-5.6-sol",
      }
    );

    const text = extractText(await parseClaudeSseStream(parsedResponse));

    const error = parseInBandApiError(text);
    expect(error).toEqual({
      code: "context_length_exceeded",
      text: expect.stringContaining("Context limit reached"),
    });
    expect(error?.text).toContain("/clear");
    expect(error?.text).toContain("oai@gpt-5.6-sol");

    expect(text).toContain("Context limit reached");
    expect(text).toContain("/clear");
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("NaN");
  });

  test("preserves the upstream code when only the message identifies a context overflow", async () => {
    const upstream = JSON.parse(REAL_CONTEXT_LENGTH_ERROR);
    upstream.error.code = "invalid_request_error";
    upstream.error.message = "maximum context length is 400000 tokens";
    const parsedResponse = createResponsesStreamHandler(
      createMockContext(),
      contextLengthErrorResponse(JSON.stringify(upstream)),
      { modelName: "gpt-5.6-sol" }
    );

    const text = extractText(await parseClaudeSseStream(parsedResponse));
    const error = parseInBandApiError(text);
    expect(error).toEqual({
      code: "invalid_request_error",
      text: expect.stringContaining("Context limit reached"),
    });
    expect(error?.text).toContain("/clear");
    expect(error?.text).toContain("oai@gpt-5.6-sol");
  });
});

test("stops keep-alive pings when the downstream reader is cancelled", async () => {
  const capturedErrors: unknown[] = [];
  const captureError = (error: unknown) => {
    capturedErrors.push(error);
  };
  let upstreamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let downstreamReader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  process.on("uncaughtException", captureError);
  process.on("unhandledRejection", captureError);

  try {
    const upstreamResponse = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          upstreamController = controller;
        },
      }),
      {
        headers: { "content-type": "text/event-stream" },
      }
    );
    const parsedResponse = createResponsesStreamHandler(createMockContext(), upstreamResponse, {
      modelName: "gpt-5.6-sol",
    });

    if (!parsedResponse.body) {
      throw new Error("Expected the parsed response to have a body");
    }
    downstreamReader = parsedResponse.body.getReader();

    const firstChunk = await downstreamReader.read();
    expect(firstChunk.done).toBe(false);
    expect(firstChunk.value).toBeInstanceOf(Uint8Array);

    await downstreamReader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 2250));

    const invalidStateErrors = capturedErrors.filter((error) =>
      /Invalid state|already closed/i.test(error instanceof Error ? error.message : String(error))
    );
    expect(invalidStateErrors).toEqual([]);
  } finally {
    await downstreamReader?.cancel().catch(() => {});
    try {
      upstreamController?.close();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.off("uncaughtException", captureError);
    process.off("unhandledRejection", captureError);
  }
}, 10000);

describe("OpenAI Responses SSE stream error with a truncated tool call", () => {
  const SOCKET_DIED = new TypeError("The socket connection was closed unexpectedly");

  function readFixtureLines(): string[] {
    return readFileSync(
      new URL(
        "../../../test-fixtures/sse-responses/gpt-5.6-sol-responses-turn1.sse",
        import.meta.url
      ),
      "utf8"
    ).split("\n");
  }

  function erroringResponse(lines: string[]): Response {
    const bytes = new TextEncoder().encode(`${lines.join("\n")}\n`);
    let delivered = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!delivered) {
          delivered = true;
          controller.enqueue(bytes);
          return;
        }
        controller.error(SOCKET_DIED);
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  // Cut a few lines after the FIRST response.function_call_arguments.delta:
  // its event line, its data line, and the blank separator. One argument
  // fragment has streamed; output_item.done for that call has not.
  function truncatedToolCallResponse(): Response {
    const lines = readFixtureLines();
    const firstDelta = lines.findIndex(
      (line) => line === "event: response.function_call_arguments.delta"
    );
    if (firstDelta === -1) {
      throw new Error("Fixture changed: no function_call_arguments.delta line");
    }
    return erroringResponse(lines.slice(0, firstDelta + 3));
  }

  // Cut before the first function_call output_item.added frame, during
  // response.output_text.delta: no tool call is in flight when the socket dies.
  function midTextResponse(): Response {
    const lines = readFixtureLines();
    const firstFunctionCallData = lines.findIndex((line) => line.includes("function_call"));
    if (firstFunctionCallData === -1) {
      throw new Error("Fixture changed: no function_call frame");
    }
    return erroringResponse(lines.slice(0, firstFunctionCallData - 1));
  }

  function stopReason(event: ClaudeEvent): string | undefined {
    return (event.data.delta as { stop_reason?: string } | undefined)?.stop_reason;
  }

  test("a tool call cut off mid-arguments ends the turn with an error event", async () => {
    const parsedResponse = createResponsesStreamHandler(
      createMockContext(),
      truncatedToolCallResponse(),
      { modelName: "gpt-5.6-sol" }
    );
    const events = await parseClaudeSseStream(parsedResponse);

    const errorEvent = events.find((event) => event.data.type === "error");
    expect(errorEvent).toBeDefined();
    expect((errorEvent?.data as { error?: { type?: string } }).error?.type).toBe("api_error");

    const endTurn = events.find(
      (event) => event.data.type === "message_delta" && stopReason(event) === "end_turn"
    );
    expect(endTurn).toBeUndefined();

    const toolStarts = events.filter(
      (event) =>
        event.data.type === "content_block_start" &&
        (event.data as { content_block?: { type?: string } }).content_block?.type === "tool_use"
    );
    expect(toolStarts.length).toBeGreaterThan(0);

    const startIndices = events
      .filter((event) => event.data.type === "content_block_start")
      .map((event) => (event.data as { index?: number }).index);
    const stopIndices = events
      .filter((event) => event.data.type === "content_block_stop")
      .map((event) => (event.data as { index?: number }).index);
    for (const index of startIndices) {
      expect(stopIndices.filter((stopIndex) => stopIndex === index)).toHaveLength(1);
    }
  });

  test("a stream error with no tool call in flight keeps the inline text and end_turn", async () => {
    const parsedResponse = createResponsesStreamHandler(createMockContext(), midTextResponse(), {
      modelName: "gpt-5.6-sol",
    });
    const events = await parseClaudeSseStream(parsedResponse);

    const endTurn = events.find(
      (event) => event.data.type === "message_delta" && stopReason(event) === "end_turn"
    );
    expect(endTurn).toBeDefined();
    expect(extractText(events)).toContain("[Stream error:");
  });
});
