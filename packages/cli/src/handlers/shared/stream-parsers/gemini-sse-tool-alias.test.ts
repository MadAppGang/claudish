// The INBOUND half of a provider-native tool-name alias: the gemini-sse parser
// restores the Claude name before the tool_use block reaches Claude Code, so a
// name sent out as agy's comes back as Claude Code's own. See tool-name-alias.ts.
import { describe, expect, test } from "bun:test";
import type { Context } from "hono";
import { createGeminiSseStream } from "./gemini-sse.js";

function ctx(): Context {
  return { req: { header: () => ({}) }, header: () => {} } as unknown as Context;
}

function upstream(parts: unknown[]): Response {
  const body = `data: ${JSON.stringify({
    candidates: [{ content: { parts }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
  })}\n\n`;
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

async function drain(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

const agyToClaude = (n: string) => (n === "run_command" ? "Bash" : n);

describe("gemini-sse mapToolName", () => {
  test("restores an aliased tool name in the tool_use block", async () => {
    const sse = await drain(
      createGeminiSseStream(
        ctx(),
        upstream([{ functionCall: { name: "run_command", args: { command: "ls" } } }]),
        { modelName: "gemini-4-carbon", mapToolName: agyToClaude }
      )
    );
    expect(sse).toContain('"name":"Bash"');
    expect(sse).not.toContain("run_command");
  });

  test("leaves an unaliased tool name unchanged", async () => {
    const sse = await drain(
      createGeminiSseStream(ctx(), upstream([{ functionCall: { name: "TodoWrite", args: {} } }]), {
        modelName: "gemini-4-carbon",
        mapToolName: agyToClaude,
      })
    );
    expect(sse).toContain('"name":"TodoWrite"');
  });

  test("passes the upstream name through when no mapper is given", async () => {
    const sse = await drain(
      createGeminiSseStream(
        ctx(),
        upstream([{ functionCall: { name: "run_command", args: {} } }]),
        { modelName: "gemini-4-carbon" }
      )
    );
    expect(sse).toContain('"name":"run_command"');
  });

  test("the adapter's history store gets the wire name, Claude Code the restored one", async () => {
    // The next request renames this call to the wire name again on the way out,
    // and the adapter names its functionResponse from this store. A restored
    // name here makes the call and its result disagree.
    const stored: string[] = [];
    const observed: string[] = [];
    const sse = await drain(
      createGeminiSseStream(
        ctx(),
        upstream([{ functionCall: { name: "run_command", args: { command: "ls" } } }]),
        {
          modelName: "gemini-4-carbon",
          mapToolName: agyToClaude,
          onToolCall: (_id, name) => stored.push(name),
          onToolCallObserved: (name) => observed.push(name),
        }
      )
    );
    expect(stored).toEqual(["run_command"]);
    expect(observed).toEqual(["Bash"]);
    expect(sse).toContain('"name":"Bash"');
  });
});
