/**
 * Why raw `providerRequest` hooks run BEFORE `buildPayload`: edits to the
 * converted `messages`/`tools` and to `claudeRequest.system` survive
 * serialisation on both the Chat Completions and the Codex/Responses adapters
 * only when made before the payload is built (moved from the behavior layer's
 * middleware-payload test; the property is the adapters', not the hook tier's).
 */

import { describe, expect, it } from "bun:test";
import { CodexAPIFormat } from "../adapters/codex-api-format.js";
import { OpenAIAPIFormat } from "../adapters/openai-api-format.js";

const MESSAGE_MARKER = "RAW_MESSAGE_MUTATION_SURVIVED";
const TOOL_MARKER = "RAW_TOOL_DESCRIPTION_MUTATION_SURVIVED";
const SYSTEM_MARKER = "RAW_SYSTEM_MUTATION_SURVIVED";

function claudeRequest(): any {
  return {
    system: "original system prompt",
    max_tokens: 256,
    messages: [{ role: "user", content: "original user message" }],
    tools: [
      {
        name: "ExitPlanMode",
        description: "original description",
        input_schema: { type: "object", properties: {} },
      },
    ],
  };
}

describe("raw providerRequest mutations before adapter.buildPayload", () => {
  it("serializes message and tool mutations through OpenAIAPIFormat", () => {
    const adapter = new OpenAIAPIFormat("gpt-5.5");
    const request = claudeRequest();
    const messages = adapter.convertMessages(request);
    const tools = adapter.convertTools(request);

    messages.push({ role: "user", content: MESSAGE_MARKER });
    tools[0].function.description = TOOL_MARKER;
    request.system = SYSTEM_MARKER;

    const serialized = JSON.stringify(adapter.buildPayload(request, messages, tools));

    expect(serialized).toContain(MESSAGE_MARKER);
    expect(serialized).toContain(TOOL_MARKER);
  });

  it("serializes message, tool, and system mutations through CodexAPIFormat", () => {
    const adapter = new CodexAPIFormat("gpt-5.6-codex");
    const request = claudeRequest();
    const messages = adapter.convertMessages(request);
    const tools = adapter.convertTools(request);

    messages.push({ role: "user", content: MESSAGE_MARKER });
    tools[0].function.description = TOOL_MARKER;
    request.system = SYSTEM_MARKER;

    const serialized = JSON.stringify(adapter.buildPayload(request, messages, tools));

    expect(serialized).toContain(MESSAGE_MARKER);
    expect(serialized).toContain(TOOL_MARKER);
    expect(serialized).toContain(`"instructions":"${SYSTEM_MARKER}"`);
  });
});
