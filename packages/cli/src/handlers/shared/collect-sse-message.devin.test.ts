import { describe, expect, test } from "bun:test";
import type { Context } from "hono";
import { midStreamError } from "../../test-fixtures/devin/stream-replay.test-helper.js";
import { sseResponseToJson } from "./collect-sse-message.js";
import { STREAM_FAILURE_HEADER } from "./recovery-marker.js";
import { createDevinConnectStream } from "./stream-parsers/devin-connect.js";

describe("sseResponseToJson Devin errors", () => {
  test("answers HTTP 400 for a captured mid-stream invalid_argument", async () => {
    const stream = createDevinConnectStream({} as Context, new Response(midStreamError()), {
      modelName: "capture-model",
    });
    const response = await sseResponseToJson(stream, "capture-model");

    expect(response.status).toBe(400);
    expect(response.headers.get(STREAM_FAILURE_HEADER)).toBe("1");
    const body = await response.json();
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("invalid_argument");
    expect(body).not.toHaveProperty("content");
  });
});
