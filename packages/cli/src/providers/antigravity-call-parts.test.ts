// A tool round as the Antigravity CLI 1.5.9 sends it back (recorded 2026-11-15):
//
//   { role: "model", parts: [
//       { functionCall: { id, name, args }, thoughtSignature },
//       { functionCall: { id, name, args } } ] }
//   { role: "model", parts: [
//       { functionResponse: { id, name, response: { output } } }, ... ] }
//
// The id is the one the server put on the call. The second parallel call came
// from the server without a thought signature and goes back without one.
import { describe, expect, test } from "bun:test";
import type { Context } from "hono";
import { GeminiAPIFormat } from "../adapters/gemini-api-format.js";
import { createGeminiSseStream } from "../handlers/shared/stream-parsers/gemini-sse.js";
import { AntigravityConversations, buildAntigravityEnvelope } from "./antigravity-envelope.js";

function round() {
  return {
    messages: [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_A", name: "run_command", input: { command: "ls" } },
          { type: "tool_use", id: "toolu_B", name: "read_file", input: { file_path: "/a" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_A", content: "RESULT-A" },
          {
            type: "tool_result",
            tool_use_id: "toolu_B",
            content: [{ type: "text", text: "RESULT-B" }],
          },
          { type: "text", text: "NOTICE" },
        ],
      },
    ],
  };
}

function antigravityDialect(): GeminiAPIFormat {
  const dialect = new GeminiAPIFormat("gemini-4-argon-medium", undefined, {
    thinkingFromModelName: true,
    serverCallIds: true,
  });
  dialect.registerToolCall("toolu_A", "run_command", "SIGNATURE-A", "call_111");
  dialect.registerToolCall("toolu_B", "read_file", undefined, "call_222");
  return dialect;
}

describe("a tool round on the Antigravity transport", () => {
  test("calls carry the server's id first and only the signature the server sent", () => {
    const contents = antigravityDialect().convertMessages(round());
    expect(JSON.stringify(contents[1].parts)).toBe(
      JSON.stringify([
        {
          functionCall: { id: "call_111", name: "run_command", args: { command: "ls" } },
          thoughtSignature: "SIGNATURE-A",
        },
        { functionCall: { id: "call_222", name: "read_file", args: { file_path: "/a" } } },
      ])
    );
  });

  test("results carry the server's id and the text under output", () => {
    const contents = antigravityDialect().convertMessages(round());
    expect(JSON.stringify(contents[2].parts)).toBe(
      JSON.stringify([
        {
          functionResponse: {
            id: "call_111",
            name: "run_command",
            response: { output: "RESULT-A" },
          },
        },
        {
          functionResponse: { id: "call_222", name: "read_file", response: { output: "RESULT-B" } },
        },
        { text: "NOTICE" },
      ])
    );
  });

  test("a call met only in history keeps the placeholder signature and has no id", () => {
    const dialect = new GeminiAPIFormat("gemini-4-argon-medium", undefined, {
      serverCallIds: true,
    });
    const contents = dialect.convertMessages(round());
    expect(contents[1].parts[0]).toEqual({
      functionCall: { name: "run_command", args: { command: "ls" } },
      thoughtSignature: "skip_thought_signature_validator",
    });
    expect(contents[2].parts[0]).toEqual({
      functionResponse: { name: "run_command", response: { output: "RESULT-A" } },
    });
  });

  test("every other Gemini-dialect handler keeps its own shape", () => {
    const dialect = new GeminiAPIFormat("gemini-4-argon-medium");
    dialect.registerToolCall("toolu_A", "run_command", "SIGNATURE-A", "call_111");
    dialect.registerToolCall("toolu_B", "read_file", undefined, "call_222");
    const contents = dialect.convertMessages(round());
    expect(contents[1].parts).toEqual([
      {
        functionCall: { name: "run_command", args: { command: "ls" } },
        thoughtSignature: "SIGNATURE-A",
      },
      {
        functionCall: { name: "read_file", args: { file_path: "/a" } },
        thoughtSignature: "skip_thought_signature_validator",
      },
    ]);
    expect(contents[2].parts[0]).toEqual({
      functionResponse: { name: "run_command", response: { content: "RESULT-A" } },
    });
  });

  test("the envelope sends the results as a model entry and the rest as a user entry", () => {
    const inner = { contents: antigravityDialect().convertMessages(round()) };
    const before = structuredClone(inner);
    const conversations = new AntigravityConversations(4, () => "id", "session");
    const envelope = buildAntigravityEnvelope({
      inner,
      model: "gemini-4-argon-medium",
      projectId: "p",
      conversation: conversations.of(inner),
      sessionId: conversations.sessionId,
      now: 1,
    }) as { requestId: string; request: { contents: Array<{ role: string; parts: any[] }> } };
    const contents = envelope.request.contents;
    expect(contents.map((c) => c.role)).toEqual(["user", "model", "model", "user"]);
    expect(contents[2].parts.map((p) => Object.keys(p))).toEqual([
      ["functionResponse"],
      ["functionResponse"],
    ]);
    expect(contents[3].parts).toEqual([{ text: "NOTICE" }]);
    // One model turn and two results: the recorded step count, unchanged by the split.
    expect(envelope.requestId.endsWith("/4")).toBe(true);
    expect(inner).toEqual(before);
  });
});

describe("gemini-sse onToolCall", () => {
  test("reports the id the server put on the call", async () => {
    const seen: unknown[][] = [];
    const body = `data: ${JSON.stringify({
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: { name: "run_command", args: {}, id: "call_111" },
                thoughtSignature: "S",
              },
              { functionCall: { name: "read_file", args: {} } },
            ],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
    })}\n\n`;
    const res = createGeminiSseStream(
      { req: { header: () => ({}) }, header: () => {} } as unknown as Context,
      new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
      {
        modelName: "gemini-4-argon-medium",
        onToolCall: (...args: unknown[]) => {
          seen.push(args.slice(1));
        },
      }
    );
    await res.text();
    expect(seen).toEqual([
      ["run_command", "S", "call_111"],
      ["read_file", undefined, undefined],
    ]);
  });
});
