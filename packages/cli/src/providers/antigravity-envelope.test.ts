import { describe, expect, test } from "bun:test";

test("two sessions that open with the same words are two conversations", () => {
  let n = 0;
  const conversations = new AntigravityConversations(8, () => `id-${n++}`, "s");
  const inner = { contents: [{ role: "user", parts: [{ text: "hi" }] }] };
  const first = conversations.of(inner, "session-a");
  expect(conversations.of(inner, "session-a")).toBe(first);
  expect(conversations.of(inner, "session-b")).not.toBe(first);
  expect(conversations.of(inner, "session-b").cascadeId).not.toBe(first.cascadeId);
});
import { agyLocalTime, agyUserRequest } from "./antigravity-content.js";
import {
  AntigravityConversations,
  buildAntigravityEnvelope,
  lastStepIndex,
  randomSessionId,
} from "./antigravity-envelope.js";

const CASCADE = "03060b17-d2ae-4ea9-b514-341e884b6dc5";
const TRAJECTORY = "17e12e0a-5b1a-46cf-ada0-23b494be7ad8";

function firstRequest() {
  return {
    contents: [{ role: "user", parts: [{ text: "list the files" }] }],
    generationConfig: {
      temperature: 1,
      maxOutputTokens: 32000,
      thinkingConfig: { includeThoughts: true },
    },
    systemInstruction: { parts: [{ text: "system text" }] },
    tools: [
      {
        functionDeclarations: [
          { name: "read_file", description: "r", parameters: {} },
          { name: "run_command", description: "c", parameters: {} },
        ],
      },
    ],
  };
}

function secondRequest() {
  const first = firstRequest();
  return {
    ...first,
    contents: [
      ...first.contents,
      {
        role: "model",
        parts: [
          { functionCall: { name: "run_command", args: {} } },
          { functionCall: { name: "read_file", args: {} } },
        ],
      },
      {
        role: "user",
        parts: [
          { functionResponse: { name: "run_command", response: {} } },
          { functionResponse: { name: "read_file", response: {} } },
        ],
      },
    ],
  };
}

function conversation() {
  return { cascadeId: CASCADE, trajectoryId: TRAJECTORY, requestCount: 0 };
}

const META = {
  maxOutputTokens: 65536,
  modelEnum: "MODEL_PLACEHOLDER_M418",
  displayName: "Gemini 4 Argon (Medium)",
};

describe("the Antigravity envelope has the shape the Antigravity CLI sends", () => {
  test("the first request of a conversation, key for key and in the recorded order", () => {
    const envelope = buildAntigravityEnvelope({
      inner: firstRequest(),
      model: "gemini-4-argon-medium",
      projectId: "aicode-consumers",
      meta: META,
      conversation: conversation(),
      sessionId: "-3750763034362895579",
      now: 1794739596876,
    });

    expect(JSON.stringify(envelope)).toBe(
      JSON.stringify({
        project: "aicode-consumers",
        requestId: `agent/${CASCADE}/1794739596876/${TRAJECTORY}/1`,
        request: {
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: agyUserRequest(
                    "list the files",
                    agyLocalTime(new Date(1794739596876)),
                    "Gemini 4 Argon (Medium)"
                  ),
                },
              ],
            },
          ],
          systemInstruction: { role: "user", parts: [{ text: "system text" }] },
          tools: [
            { functionDeclarations: [{ name: "read_file", description: "r", parameters: {} }] },
            { functionDeclarations: [{ name: "run_command", description: "c", parameters: {} }] },
          ],
          labels: {
            cascade_id: CASCADE,
            last_step_index: "0",
            model_enum: "MODEL_PLACEHOLDER_M418",
            request_id: `${TRAJECTORY}-0`,
            root_cascade_id: CASCADE,
            trajectory_id: TRAJECTORY,
            used_claude: "false",
            used_claude_conservative: "false",
            used_non_gemini_model: "false",
          },
          generationConfig: { maxOutputTokens: 65536, thinkingConfig: { includeThoughts: true } },
          sessionId: "-3750763034362895579",
        },
        model: "gemini-4-argon-medium",
        userAgent: "antigravity",
        requestType: "agent",
      })
    );
  });

  test("the second request counts the model turn and each tool result as a step", () => {
    const shared = conversation();
    buildAntigravityEnvelope({
      inner: firstRequest(),
      model: "gemini-4-argon-medium",
      projectId: "p",
      meta: META,
      conversation: shared,
      sessionId: "1",
      now: 1,
    });
    const envelope = buildAntigravityEnvelope({
      inner: secondRequest(),
      model: "gemini-4-argon-medium",
      projectId: "p",
      meta: META,
      conversation: shared,
      sessionId: "1",
      now: 1794739605957,
    }) as { requestId: string; request: { labels: Record<string, string> } };

    expect(envelope.requestId).toBe(`agent/${CASCADE}/1794739605957/${TRAJECTORY}/4`);
    expect(envelope.request.labels.last_step_index).toBe("3");
    expect(envelope.request.labels.request_id).toBe(`${TRAJECTORY}-1`);
  });

  test("it sends none of the fields the Antigravity CLI does not send", () => {
    const envelope = buildAntigravityEnvelope({
      inner: firstRequest(),
      model: "gemini-4-argon-medium",
      projectId: "p",
      meta: META,
      conversation: conversation(),
      sessionId: "1",
    }) as Record<string, unknown> & { request: { generationConfig: Record<string, unknown> } };

    expect(envelope).not.toHaveProperty("user_prompt_id");
    expect(envelope).not.toHaveProperty("enabled_credit_types");
    expect(envelope.request.generationConfig).not.toHaveProperty("temperature");
  });

  test("the dialect's own thinking fields and tool choice are kept", () => {
    const inner = {
      ...firstRequest(),
      toolConfig: { functionCallingConfig: { mode: "ANY" } },
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 100,
        thinkingConfig: { includeThoughts: true, thinkingLevel: "high" },
      },
    };
    const envelope = buildAntigravityEnvelope({
      inner,
      model: "gemini-3-pro",
      projectId: "p",
      meta: META,
      conversation: conversation(),
      sessionId: "1",
    }) as { request: Record<string, unknown> };

    expect(envelope.request.toolConfig).toEqual({ functionCallingConfig: { mode: "ANY" } });
    expect(envelope.request.generationConfig).toEqual({
      maxOutputTokens: 65536,
      thinkingConfig: { includeThoughts: true, thinkingLevel: "high" },
    });
  });

  test("a model the backend reported nothing about keeps the request's cap and sends no model_enum", () => {
    const envelope = buildAntigravityEnvelope({
      inner: firstRequest(),
      model: "gemini-4-argon-medium",
      projectId: "p",
      conversation: conversation(),
      sessionId: "1",
    }) as {
      request: { generationConfig: Record<string, unknown>; labels: Record<string, string> };
    };

    expect(envelope.request.generationConfig.maxOutputTokens).toBe(32000);
    expect(envelope.request.labels).not.toHaveProperty("model_enum");
  });

  test("the labels name a Claude model and a model that is not Gemini", () => {
    const labels = (model: string) =>
      (
        buildAntigravityEnvelope({
          inner: firstRequest(),
          model,
          projectId: "p",
          conversation: conversation(),
          sessionId: "1",
        }) as { request: { labels: Record<string, string> } }
      ).request.labels;

    expect(labels("claude-sonnet-5-5").used_claude).toBe("true");
    expect(labels("claude-sonnet-5-5").used_non_gemini_model).toBe("true");
    expect(labels("gpt-oss-120b-medium").used_claude).toBe("false");
    expect(labels("gpt-oss-120b-medium").used_non_gemini_model).toBe("true");
  });

  test("it does not change the body it was given", () => {
    const inner = firstRequest();
    const before = JSON.stringify(inner);
    buildAntigravityEnvelope({
      inner,
      model: "gemini-4-argon-medium",
      projectId: "p",
      meta: META,
      conversation: conversation(),
      sessionId: "1",
    });
    expect(JSON.stringify(inner)).toBe(before);
  });
});

describe("step counting", () => {
  test("a conversation's first request is step 0", () => {
    expect(lastStepIndex(firstRequest().contents)).toBe(0);
    expect(lastStepIndex(undefined)).toBe(0);
  });

  test("a later user message is one step", () => {
    const contents = [
      { role: "user", parts: [{ text: "a" }] },
      { role: "model", parts: [{ text: "b" }] },
      { role: "user", parts: [{ text: "c" }] },
    ];
    expect(lastStepIndex(contents)).toBe(2);
  });
});

describe("conversations of one process", () => {
  test("requests that open with the same message share one conversation", () => {
    let n = 0;
    const store = new AntigravityConversations(64, () => `id-${n++}`, "7");
    const a = store.of(firstRequest());
    const b = store.of(secondRequest());
    expect(b).toBe(a);
    expect(a).toEqual({ cascadeId: "id-0", trajectoryId: "id-1", requestCount: 0 });
    expect(store.sessionId).toBe("7");
  });

  test("a different first message is a different conversation", () => {
    const store = new AntigravityConversations();
    const other = { contents: [{ role: "user", parts: [{ text: "another task" }] }] };
    expect(store.of(other)).not.toBe(store.of(firstRequest()));
  });

  test("the oldest conversation is dropped when the limit is passed", () => {
    const store = new AntigravityConversations(2);
    const request = (text: string) => ({ contents: [{ role: "user", parts: [{ text }] }] });
    const first = store.of(request("1"));
    store.of(request("2"));
    store.of(request("3"));
    expect(store.of(request("1"))).not.toBe(first);
  });

  test("a session id is a signed 64-bit integer in decimal", () => {
    const id = randomSessionId();
    expect(id).toMatch(/^-?\d{1,19}$/);
    expect(BigInt(id).toString()).toBe(id);
  });
});
