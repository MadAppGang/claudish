import { describe, expect, test } from "bun:test";

import { StreamJsonReducer } from "./stream-json-reducer.js";

const UNRECOGNIZED_JSON = '["--model","x","-y"]';
const API_ERROR = "[API Error: overloaded]";
const ASSISTANT_TEXT = "Recovered assistant answer";
const ASSISTANT_FRAME = JSON.stringify({
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "text", text: ASSISTANT_TEXT }],
  },
});

function feedLine(line: string, keepUnrecognizedJson?: true): string {
  const reducer = new StreamJsonReducer({
    sessionId: "unrecognized-json-test",
    stallSeconds: 0,
    callback: () => {},
    onResult: () => "stdin-closed",
    ...(keepUnrecognizedJson === true ? { keepUnrecognizedJson } : {}),
  });

  try {
    return reducer.feed(`${line}\n`);
  } finally {
    reducer.dispose();
  }
}

describe.each([
  { setting: "the default", keepUnrecognizedJson: undefined, unrecognizedJson: "" },
  {
    setting: "keepUnrecognizedJson enabled",
    keepUnrecognizedJson: true,
    unrecognizedJson: `${UNRECOGNIZED_JSON}\n`,
  },
] as const)("StreamJsonReducer with $setting", ({ keepUnrecognizedJson, unrecognizedJson }) => {
  test("handles valid JSON outside the stream-json vocabulary", () => {
    expect(feedLine(UNRECOGNIZED_JSON, keepUnrecognizedJson)).toBe(unrecognizedJson);
  });

  test("always passes through non-JSON output verbatim", () => {
    expect(feedLine(API_ERROR, keepUnrecognizedJson)).toBe(`${API_ERROR}\n`);
  });

  test("always recovers prose from a recognized assistant frame", () => {
    expect(feedLine(ASSISTANT_FRAME, keepUnrecognizedJson)).toBe(ASSISTANT_TEXT);
  });
});
