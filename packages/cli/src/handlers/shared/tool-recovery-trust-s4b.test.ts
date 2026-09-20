/**
 * S4-b lot B1 — the text-recovery trust boundary (issue #28).
 *
 * Upstream anchors:
 *  - e82c315 (upstream #223): a tool NAME is an identifier. Pattern 0's
 *    `[^>]+` took everything up to the next `>` — a `<function=` opened in
 *    prose produced names carrying parameter fragments and ARGUMENT VALUES
 *    (live incident: `web_search_query_listOpposed["macos security …"]`
 *    reached a client). Two gates now run on every extracted call: the shape
 *    gate (identifier) and the allowlist gate (the request's own tools).
 *    openai-sse also stops running text extraction at all once a structured
 *    call exists — recovery exists for models that cannot emit `tool_calls`;
 *    against one that just did, it can only ADD calls.
 *  - 2e18042 (parser half): the hold-back test uses the SAME shape the
 *    extractor accepts (`hasExtractableFunctionTag`) — when the two drifted,
 *    text was withheld from the client and then nothing emitted it; and a
 *    LATER fragment that completes `function.name` revises the tool's name at
 *    the decode point.
 *
 * Non-vacuity: written before the implementation; pre-fix counts published
 * with the exact command and bun version in the PR body.
 */

import { describe, expect, test } from "bun:test";
import {
  extractToolCallsFromText,
  type ToolSchema,
} from "./tool-call-recovery.js";
import { createStreamingResponseHandler } from "./stream-parsers/openai-sse.js";

// ── unit: extractToolCallsFromText gates ─────────────────────────────────

describe("S4-b lot B1: extraction gates (e82c315)", () => {
  test("the grok mangled name — tool name + parameter + ARGUMENT VALUE — is not extracted", () => {
    const text =
      '<function=web_search_query_listOpposed["macos security add-generic-password -X hex password flag"]><parameter=q>x</parameter>';
    const calls = extractToolCallsFromText(text);
    expect(calls.length).toBe(0);
  });

  test("a `<function=` opened in prose with non-identifier content yields no call", () => {
    const text = "Use the <function=read a file please> helper when needed.";
    expect(extractToolCallsFromText(text).length).toBe(0);
  });

  test("a well-shaped name the client never advertised is dropped; an advertised one is kept", () => {
    const text = "<function=Bash><parameter=command>ls</parameter></function>";
    const advertised = extractToolCallsFromText(text, ["Bash"]);
    expect(advertised.length).toBe(1);
    expect(advertised[0].name).toBe("Bash");
    const unadvertised = extractToolCallsFromText(text, ["Read"]);
    expect(unadvertised.length).toBe(0);
  });

  test("the allowlist canonicalizes case-insensitively to the client's own spelling", () => {
    const text = "<function=bash><parameter=command>ls</parameter></function>";
    const calls = extractToolCallsFromText(text, ["Bash"]);
    expect(calls.length).toBe(1);
    expect(calls[0].name).toBe("Bash");
  });

  test("decode fn runs BETWEEN the shape gate and the allowlist gate", () => {
    // Shape gate sees the WIRE name (identifier); decode maps it to the
    // client's original; allowlist holds the originals.
    const text = "<function=enc_12ab><parameter=q>x</parameter></function>";
    const decode = (n: string) => (n === "enc_12ab" ? "mcp__plugin__real_tool_name" : n);
    const calls = extractToolCallsFromText(text, ["mcp__plugin__real_tool_name"], decode);
    expect(calls.length).toBe(1);
    expect(calls[0].name).toBe("mcp__plugin__real_tool_name");
  });

  test("without an advertised list, the shape gate alone runs (control)", () => {
    const text = "<function=Bash><parameter=command>ls</parameter></function>";
    const calls = extractToolCallsFromText(text);
    expect(calls.length).toBe(1);
    expect(calls[0].name).toBe("Bash");
  });
});

// ── parser level ─────────────────────────────────────────────────────────

const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};

function mockContext() {
  const headers = new Headers();
  const c: any = {
    header: (k: string, v: string) => headers.set(k, v),
    json: () => null,
    headers,
    req: {},
    body: (stream: ReadableStream, init?: any) => new Response(stream, init),
  };
  return c;
}

function sseResponse(raw: string): Response {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(raw));
      controller.close();
    },
  });
  return new Response(stream, { headers: new Headers(SSE_HEADERS) });
}

async function drain(response: Response): Promise<string> {
  let output = "";
  await response.body?.pipeTo(
    new WritableStream({
      write(chunk: Uint8Array) {
        output += new TextDecoder().decode(chunk, { stream: true });
      },
    })
  );
  return output;
}

const adapter = {
  processTextContent: (t: string) => ({ cleanedText: t, wasTransformed: false }),
};

function countToolUseBlocks(output: string): number {
  return (output.match(/"type":"tool_use"/g) || []).length;
}

async function run(
  raw: string,
  opts: { toolSchemas?: any[]; toolNameMap?: Map<string, string> } = {}
): Promise<string> {
  const response = createStreamingResponseHandler(
    mockContext(),
    sseResponse(raw),
    adapter,
    "glm-5.3",
    undefined,
    undefined,
    opts.toolSchemas,
    opts.toolNameMap,
    undefined,
    undefined,
    undefined
  ) as Response;
  let output = "";
  const originalLog = console.log;
  console.log = () => {};
  try {
    output = await drain(response);
  } finally {
    console.log = originalLog;
  }
  return output;
}

describe("S4-b lot B1: parser-level trust boundary", () => {
  test("a structured call plus prose mentioning a function tag dispatches ONE tool_use", async () => {
    const raw =
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { name: "Bash", arguments: '{"command":"ls"}' } }],
            },
          },
        ],
      })}\n\n` +
      `data: ${JSON.stringify({
        choices: [{ delta: { content: "I could also <function=Read> the file if you want." } }],
      })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n` +
      "data: [DONE]\n\n";
    const output = await run(raw, {
      toolSchemas: [{ name: "Bash", description: "run", input_schema: { type: "object" } }],
    });
    expect(countToolUseBlocks(output)).toBe(1);
  });

  test("prose holding a non-identifier `<function=…>` mention reaches the client as text, withheld by nothing", async () => {
    const raw =
      `data: ${JSON.stringify({
        choices: [{ delta: { content: "The <function=read a file please> form is legacy." } }],
      })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n` +
      "data: [DONE]\n\n";
    const output = await run(raw, {
      toolSchemas: [{ name: "Read", description: "r", input_schema: { type: "object" } }],
    });
    expect(output).toContain("The <function=read a file please> form is legacy.");
    expect(countToolUseBlocks(output)).toBe(0);
  });

  test("a later fragment completing function.name revises the tool at the decode point", async () => {
    const raw =
      `data: ${JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "enc" } }] } }],
      })}\n\n` +
      `data: ${JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "_12ab", arguments: '{"q":"x"}' } }] } }],
      })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n` +
      "data: [DONE]\n\n";
    const output = await run(raw, {
      toolSchemas: [{ name: "mcp__plugin__real_tool_name", description: "r", input_schema: { type: "object" } }],
      toolNameMap: new Map([["enc_12ab", "mcp__plugin__real_tool_name"]]),
    });
    expect(output).toContain('"name":"mcp__plugin__real_tool_name"');
    expect(output).not.toContain('"name":"enc"');
  });
});
