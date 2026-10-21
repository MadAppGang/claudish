import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Context } from "hono";
import {
  collectSseMessage,
  sseResponseToJson,
  statusForStreamErrorType,
} from "./collect-sse-message.js";
import { STREAM_FAILURE_HEADER } from "./recovery-marker.js";
import { createResponsesStreamHandler } from "./stream-parsers/openai-responses-sse.js";

const base = new URL("../../test-fixtures/sse-responses/", import.meta.url);
const captured = (name: string) => readFileSync(new URL(name, base), "utf8");
function realFailure(): Response {
  return createResponsesStreamHandler(
    {} as Context,
    new Response(captured("codex-parallel-degenerate-stall.sse")),
    { modelName: "capture-model" }
  );
}
function cutoff(): Response {
  // Derived from native capture: disconnect immediately after the first real argument delta.
  const text = captured("gpt-5.6-sol-responses-toolsonly-turn1.sse");
  const rows = text.split("\n\n");
  const end = rows.findIndex((row) => row.includes('"response.function_call_arguments.delta"'));
  const bytes = new TextEncoder().encode(rows.slice(0, end + 1).join("\n\n") + "\n\n");
  let sent = false;
  return createResponsesStreamHandler(
    {} as Context,
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(bytes);
          } else controller.error(new TypeError("captured stream disconnected"));
        },
      })
    ),
    { modelName: "capture-model" }
  );
}

describe("REQ-7 collector stream-failure contract", () => {
  test("REQ-7 TEST-18 does not copy a forged stream-failure marker from a healthy SSE response", async () => {
    const stream = createResponsesStreamHandler(
      {} as Context,
      new Response(captured("codex-zero-delta-multicall.sse")),
      { modelName: "capture-model" }
    );
    stream.headers.set(STREAM_FAILURE_HEADER, "1");
    stream.headers.set("x-upstream-only", "must-not-copy");
    const response = await sseResponseToJson(stream, "capture-model");
    expect(response.status).toBe(200);
    expect(response.headers.get(STREAM_FAILURE_HEADER)).toBeNull();
    expect(response.headers.get("x-upstream-only")).toBeNull();
    const body = await response.json();
    expect(body.type).toBe("message");
    expect(body.content.filter((c: any) => c.type === "tool_use")).toHaveLength(3);
  });

  test("REQ-7 TEST-18 folds real degeneration to an error rather than successful partial content", async () => {
    const response = await sseResponseToJson(realFailure(), "capture-model");
    expect(response.status).toBe(500);
    expect(response.headers.get(STREAM_FAILURE_HEADER)).toBe("1");
    const body = await response.json();
    expect(body).toEqual({
      type: "error",
      error: { type: "api_error", message: expect.stringContaining("degenerate") },
    });
    expect(body).not.toHaveProperty("content");
  });

  test("REQ-7 TEST-18 cut-off ordinary tool stream discards every partially collected block", async () => {
    const message = await collectSseMessage(cutoff(), "capture-model");
    expect(message.content).toEqual([]);
    expect(message.streamError?.type).toBe("api_error");
    const response = await sseResponseToJson(cutoff(), "capture-model");
    expect(response.status).toBe(500);
    expect(response.headers.get(STREAM_FAILURE_HEADER)).toBe("1");
    expect((await response.json()).type).toBe("error");
  });

  test.each([
    ["api_error", 500],
    ["overloaded_error", 529],
    ["invalid_request_error", 400],
    ["unknown_error", 500],
  ] as const)(
    "REQ-7 TEST-18 %s stream failure maps to HTTP %d with marker",
    async (type, status) => {
      // Derived from actual parser-emitted SSE error for the real V0-21 capture; only its error type changes.
      const source = await realFailure().text();
      const derived = source
        .split("\n")
        .map((line) => {
          if (!line.startsWith("data: ")) return line;
          const data = JSON.parse(line.slice(6));
          if (data.type === "error") data.error.type = type;
          return `data: ${JSON.stringify(data)}`;
        })
        .join("\n");
      const response = await sseResponseToJson(new Response(derived), "capture-model");
      expect(statusForStreamErrorType(type)).toBe(status);
      expect(response.status).toBe(status);
      expect(response.headers.get(STREAM_FAILURE_HEADER)).toBe("1");
      const body = await response.json();
      expect(body.type).toBe("error");
      expect(body.error.type).toBe(type);
      expect(body).not.toHaveProperty("content");
    }
  );
});
