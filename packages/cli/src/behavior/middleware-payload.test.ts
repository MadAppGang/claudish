import { describe, expect, it } from "bun:test";
import { CodexAPIFormat } from "../adapters/codex-api-format.js";
import { OpenAIAPIFormat } from "../adapters/openai-api-format.js";

const MESSAGE_MARKER = "BEHAVIOR_MESSAGE_MUTATION_SURVIVED";
const TOOL_MARKER = "BEHAVIOR_TOOL_DESCRIPTION_MUTATION_SURVIVED";
const SYSTEM_MARKER = "BEHAVIOR_SYSTEM_MUTATION_SURVIVED";

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

describe("middleware mutations before adapter.buildPayload", () => {
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
