import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import type { Context } from "hono";
import { FallbackHandler, isRetryableError } from "./fallback-handler.js";
import { sseResponseToJson } from "./shared/collect-sse-message.js";
import { STREAM_FAILURE_HEADER } from "./shared/recovery-marker.js";
import { createResponsesStreamHandler } from "./shared/stream-parsers/openai-responses-sse.js";

async function quotaStreamFailure(): Promise<Response> {
  const bytes = readFileSync(
    new URL("../test-fixtures/sse-responses/codex-parallel-degenerate-stall.sse", import.meta.url),
    "utf8"
  );
  const stream = createResponsesStreamHandler({} as Context, new Response(bytes), {
    modelName: "capture-model",
    retry: {
      issueLeg: async () => ({
        kind: "error",
        message: "HTTP 429 on retry leg 2: usage limit reached",
      }),
      stallClock: { now: () => 0, setTimeout: () => 1, clearTimeout: () => {} },
    },
  });
  return sseResponseToJson(stream, "capture-model");
}

test("REQ-8 TEST-19 a marked quota-worded stream failure is not retryable", async () => {
  const response = await quotaStreamFailure();
  const body = await response.text();
  expect(body).toContain("usage limit reached");
  expect(response.headers.get(STREAM_FAILURE_HEADER)).toBe("1");
  expect(isRetryableError(response.status, body, "openai-codex", response.headers)).toBe(false);
  // Removing the marker must leave the existing quota-routing rule active.
  expect(isRetryableError(response.status, body, "openai-codex", new Headers())).toBe(true);
});

test("REQ-8 TEST-19 returns the exact marked response after an earlier failed candidate without folding or advancing", async () => {
  const marked = await quotaStreamFailure();
  const expectedBody = await marked.clone().text();
  let advanced = false;
  const chain = new FallbackHandler([
    {
      name: "earlier",
      handler: {
        handle: async () => new Response("usage limit reached", { status: 429 }),
        shutdown: async () => {},
      },
    },
    { name: "openai-codex", handler: { handle: async () => marked, shutdown: async () => {} } },
    {
      name: "later",
      handler: {
        handle: async () => {
          advanced = true;
          throw new Error("Must not advance a flushed stream");
        },
        shutdown: async () => {},
      },
    },
  ]);
  // Hono dispatch stays in-process; no socket or network request is made.
  let returned: Response | undefined;
  const app = new Hono();
  app.get("/", async (c) => {
    returned = await chain.handle(c, undefined);
    return returned;
  });
  const response = await app.request("http://in-process.invalid/");
  expect(returned).toBe(marked);
  expect(advanced).toBe(false);
  expect(response.status).toBe(500);
  expect(response.headers.get(STREAM_FAILURE_HEADER)).toBe("1");
  expect(await response.text()).toBe(expectedBody);
});
