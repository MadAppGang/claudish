import { describe, expect, test } from "bun:test";
import type { Context } from "hono";
import {
  CONTENT_PREFIX,
  midStreamError,
} from "../../../test-fixtures/devin/stream-replay.test-helper.js";
import { createDevinConnectStream } from "./devin-connect.js";

async function sseEvents(response: Response) {
  const sse = await createDevinConnectStream({} as Context, response, {
    modelName: "capture-model",
  }).text();
  return sse
    .split("\n\n")
    .filter((frame) => frame.startsWith("event: "))
    .map((frame) => {
      const lines = frame.split("\n");
      return {
        event: lines[0]!.slice("event: ".length),
        data: JSON.parse(lines.find((line) => line.startsWith("data: "))!.slice("data: ".length)),
      };
    });
}

describe("Devin Connect stream errors", () => {
  test.each([
    ["invalid_argument", "invalid_request_error"],
    ["unavailable", "overloaded_error"],
  ] as const)("%s after content emits %s", async (code, expectedType) => {
    const events = await sseEvents(new Response(midStreamError(code)));
    expect(
      events.some(
        (event) => event.event === "content_block_delta" && event.data.delta.type === "text_delta"
      )
    ).toBe(true);
    const errors = events.filter((event) => event.event === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.data.error.type).toBe(expectedType);
    expect(errors[0]!.data.error.message).toContain(code);
  });

  test("a read failure without an error frame keeps api_error", async () => {
    let sent = false;
    const events = await sseEvents(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!sent) {
              sent = true;
              controller.enqueue(CONTENT_PREFIX);
            } else {
              controller.error(new TypeError("captured Devin stream disconnected"));
            }
          },
        })
      )
    );
    const errors = events.filter((event) => event.event === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.data.error.type).toBe("api_error");
    expect(errors[0]!.data.error.message).toContain("captured Devin stream disconnected");
  });
});
