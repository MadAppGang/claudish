/**
 * The proxy's proof of an in-band API error. A terminal error inside an HTTP 200 stream is
 * written to Claude Code as an ordinary text block (`[API Error: <code> <message>]`), which a
 * model can also write; so the request that wrote it records `in_band_api_error: {code, at}`
 * in its token file, and a team slot or one-shot session reads an `api_error` only with that
 * record. Driven through `ComposedHandler.handle` with a canned Responses stream, so the
 * record is proved to come from the parser's `onApiError` on a real request.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

import { OpenAIAPIFormat } from "../adapters/openai-api-format.js";
import { parseInBandApiError } from "../in-band-api-error.js";
import type { ProviderTransport } from "../providers/transport/types.js";
import { ComposedHandler } from "./composed-handler.js";

const ERROR_FRAME =
  '{"type":"error","error":{"type":"invalid_request_error","code":"context_length_exceeded","message":"Your input exceeds the context window of this model. Please adjust your input and try again.","param":"input"},"sequence_number":2}';
const ERROR_MESSAGE = "Your input exceeds the context window of this model.";

const fixture = readFileSync(
  new URL("../test-fixtures/sse-responses/gpt-5.6-sol-responses-turn1.sse", import.meta.url),
  "utf8"
);
const opening = fixture.split("\n\n", 1)[0];
const ENDPOINT = "https://in-band.invalid/v1/responses";

const realFetch = globalThis.fetch;
const originalTokenFile = process.env.CLAUDISH_TOKEN_FILE;
const dirs: string[] = [];
const handlers: ComposedHandler[] = [];

afterEach(async () => {
  globalThis.fetch = realFetch;
  for (const h of handlers.splice(0)) await h.shutdown();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (originalTokenFile === undefined) delete process.env.CLAUDISH_TOKEN_FILE;
  else process.env.CLAUDISH_TOKEN_FILE = originalTokenFile;
});

function transport(): ProviderTransport {
  return {
    name: "in-band-test",
    displayName: "In-band test",
    streamFormat: "openai-responses-sse",
    getEndpoint: () => ENDPOINT,
    getHeaders: async () => ({}),
    overrideStreamFormat: () => "openai-responses-sse",
  } as unknown as ProviderTransport;
}

async function runOneRequest(tokenFile: string, sse: string): Promise<string> {
  process.env.CLAUDISH_TOKEN_FILE = tokenFile;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== ENDPOINT) throw new Error(`no network in this test: ${url}`);
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  const model = "gpt-5.6-sol";
  const handler = new ComposedHandler(transport(), model, model, 0, {
    adapter: new OpenAIAPIFormat(model),
    codeMode: "off",
    isInteractive: false,
  });
  handlers.push(handler);
  const app = new Hono();
  app.post("/v1/messages", (c) =>
    handler.handle(c, {
      model,
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    })
  );
  const res = await app.request("/v1/messages", {
    method: "POST",
    headers: { "x-claudish-no-recovery": "1" },
  });
  return res.text();
}

function tempTokenFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "claudish-in-band-"));
  dirs.push(dir);
  return join(dir, "stats", "01.json");
}

describe("ComposedHandler — the in-band API error record in the token file", () => {
  test("an in-stream error writes in_band_api_error {code, at} and keeps the token fields", async () => {
    const tokenFile = tempTokenFile();
    const before = Date.now();
    const wire = await runOneRequest(tokenFile, `${opening}\n\ndata: ${ERROR_FRAME}\n\n`);
    // the marker did reach Claude Code as text
    const text = wire
      .split("\n")
      .filter((l) => l.startsWith("data: ") && l.includes("text_delta"))
      .map((l) => JSON.parse(l.slice(6)).delta.text)
      .join("");
    expect(parseInBandApiError(text)?.code).toBe("context_length_exceeded");

    const file = JSON.parse(readFileSync(tokenFile, "utf8"));
    expect(file.in_band_api_error.code).toBe("context_length_exceeded");
    expect(Date.parse(file.in_band_api_error.at)).toBeGreaterThanOrEqual(before);
    expect(Object.keys(file.in_band_api_error).sort()).toEqual(["at", "code"]);
    // the upstream message never reaches the file
    expect(JSON.stringify(file)).not.toContain(ERROR_MESSAGE);
    for (const key of ["input_tokens", "output_tokens", "total_tokens", "provider_name"])
      expect(file).toHaveProperty(key);
  }, 15_000);

  test("a request with no in-stream error writes no record", async () => {
    const tokenFile = tempTokenFile();
    await runOneRequest(tokenFile, fixture);
    // A clean request still writes its token counts, so the absence below is a real read.
    expect(existsSync(tokenFile)).toBe(true);
    const file = JSON.parse(readFileSync(tokenFile, "utf8"));
    for (const key of ["input_tokens", "output_tokens", "total_tokens", "provider_name"])
      expect(file).toHaveProperty(key);
    expect(file).not.toHaveProperty("in_band_api_error");
  }, 15_000);
});
