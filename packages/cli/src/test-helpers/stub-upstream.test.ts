/**
 * The stub upstream harness (hook-system §11.2): every format streams the scripted
 * parts, records the request, and can split a multi-byte character across chunks.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  type StubFormat,
  type StubUpstream,
  startStubUpstream,
  stubChunks,
  stubEndpointConfig,
  stubEvents,
} from "./stub-upstream.js";

let stub: StubUpstream | null = null;
afterEach(() => {
  stub?.stop();
  stub = null;
});

const dataOf = (sse: string) =>
  sse
    .split("\n\n")
    .flatMap((e) => e.split("\n"))
    .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
    .map((l) => JSON.parse(l.slice(6)));

async function readChunks(res: Response): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

describe("startStubUpstream", () => {
  for (const format of ["openai-sse", "anthropic-sse", "openai-responses-sse"] as StubFormat[]) {
    test(`${format}: text, thinking and a tool call stream in order; the request is recorded`, async () => {
      stub = startStubUpstream({
        format,
        script: [
          {
            parts: [
              { thinking: "hmm" },
              { text: "héllo" },
              { toolCall: { name: "Write", args: { p: 1 } } },
            ],
            deltaChars: 2,
          },
        ],
      });
      const res = await fetch(`${stub.url}/v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify({ model: "fake-model", messages: [{ role: "user", content: "hi" }] }),
      });
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      const text = await res.text();
      const events = dataOf(text);
      const blob = JSON.stringify(events);
      // deltas of 2 characters: "héllo" → "hé", "ll", "o"
      for (const piece of ["hm", "hé", "ll", "Write"]) expect(blob).toContain(piece);
      expect(stub.requests).toHaveLength(1);
      expect(stub.requests[0]?.path).toBe("/v1/chat/completions");
      expect((stub.requests[0]?.body as { model: string }).model).toBe("fake-model");
    });
  }

  test("a tool-only response finishes with tool_calls (openai) / tool_use (anthropic)", () => {
    const r = { parts: [{ toolCall: { name: "Bash", args: { command: "ls" } } }] };
    expect(JSON.stringify(dataOf(stubEvents("openai-sse", r).join("")))).toContain(
      '"finish_reason":"tool_calls"'
    );
    expect(JSON.stringify(dataOf(stubEvents("anthropic-sse", r).join("")))).toContain(
      '"stop_reason":"tool_use"'
    );
  });

  test("splitMultibyte cuts one network chunk inside a multi-byte character", async () => {
    const events = stubEvents("openai-sse", { parts: [{ text: "答え" }] });
    const chunks = stubChunks(events, true);
    expect(chunks.length).toBe(events.length + 1);
    const dec = new TextDecoder("utf-8", { fatal: true });
    // some chunk ends mid-character: a fatal decoder rejects it on its own
    expect(
      chunks.some((c) => {
        try {
          dec.decode(c);
          return false;
        } catch {
          return true;
        }
      })
    ).toBe(true);
    // and the stream reassembles byte-exactly
    stub = startStubUpstream({
      format: "openai-sse",
      script: [{ parts: [{ text: "答え" }], splitMultibyte: true }],
    });
    const res = await fetch(`${stub.url}/v1/chat/completions`, { method: "POST", body: "{}" });
    const got = await readChunks(res);
    const joined = new TextDecoder().decode(Buffer.concat(got.map((c) => Buffer.from(c))));
    expect(joined).toBe(events.join(""));
  });

  test("chunkDelayMs paces the chunks; a script function answers per request; status errors", async () => {
    stub = startStubUpstream({
      format: "anthropic-sse",
      script: (_req, n) =>
        n === 0 ? { parts: [{ text: "a" }], chunkDelayMs: 40 } : { parts: [], status: 503 },
    });
    const t0 = Date.now();
    await (await fetch(stub.url, { method: "POST", body: "{}" })).text();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(40 * 5);
    expect((await fetch(stub.url, { method: "POST", body: "{}" })).status).toBe(503);
  });

  test("stubEndpointConfig routes stub@<model> through a keyless simple openai endpoint", () => {
    stub = startStubUpstream({ format: "openai-sse", script: [] });
    expect(stubEndpointConfig(stub)).toEqual({
      customEndpoints: {
        stub: { kind: "simple", url: `${stub.url}/v1`, format: "openai", authScheme: "none" },
      },
    });
  });
});
