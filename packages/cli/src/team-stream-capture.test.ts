import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createAssistantTextCapture } from "./team-stream-capture.js";

interface FixtureEvent {
  type?: unknown;
  is_error?: unknown;
  result?: unknown;
  message?: unknown;
  [key: string]: unknown;
}

const FIXTURE_PATH = join(
  import.meta.dir,
  "test-fixtures",
  "stream-json",
  "haiku-post-answer-turn.jsonl"
);
const FIXTURE = readFileSync(FIXTURE_PATH, "utf-8");
const FIXTURE_EVENTS = FIXTURE.trimEnd()
  .split("\n")
  .map((line) => JSON.parse(line) as FixtureEvent);

function recover(input: string, sliceSize?: number): string {
  const capture = createAssistantTextCapture();
  let output = "";

  if (sliceSize === undefined) {
    output += capture.write(input);
  } else {
    for (let offset = 0; offset < input.length; offset += sliceSize) {
      output += capture.write(input.slice(offset, offset + sliceSize));
    }
  }

  return output + capture.end();
}

function getFixtureResultEvent(): FixtureEvent {
  const event = FIXTURE_EVENTS.find((candidate) => candidate.type === "result");
  if (!event) throw new Error("fixture is missing its result event");
  return event;
}

function getFixtureAssistantTextEvent(): FixtureEvent {
  const event = FIXTURE_EVENTS.find((candidate) => {
    if (candidate.type !== "assistant") return false;
    const message = candidate.message;
    if (!message || typeof message !== "object" || Array.isArray(message)) return false;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return false;
    return content.some(
      (block) =>
        block !== null &&
        typeof block === "object" &&
        !Array.isArray(block) &&
        (block as { type?: unknown }).type === "text" &&
        (block as { text?: unknown }).text === "ALPHA_MARKER"
    );
  });
  if (!event) throw new Error("fixture is missing its first assistant text event");
  return event;
}

describe("createAssistantTextCapture", () => {
  it("recovers the full answer instead of only the print-mode result", () => {
    const recovered = recover(FIXTURE);
    const resultEvent = getFixtureResultEvent();

    expect(recovered).toBe("ALPHA_MARKER\n\nOMEGA_MARKER\n");
    expect(recovered).toContain("ALPHA_MARKER");
    expect(recovered).toContain("OMEGA_MARKER");
    expect(typeof resultEvent.result).toBe("string");
    expect(recovered.trimEnd()).not.toBe(resultEvent.result);
  });

  it.each([1, 7, 13, 5000])("is independent of chunk boundaries at %i-byte slices", (sliceSize) => {
    const whole = recover(FIXTURE);
    const sliced = recover(FIXTURE, sliceSize);

    expect(sliced).toBe(whole);
    expect(sliced).toBe("ALPHA_MARKER\n\nOMEGA_MARKER\n");
  });

  it("drops thinking, tool_use input, and tool_result content", () => {
    const recovered = recover(FIXTURE);

    expect(FIXTURE).toContain("This is a straightforward request");
    expect(FIXTURE).toContain("Echo hi to stdout");
    expect(FIXTURE).toContain('"content":"hi"');
    expect(recovered).not.toContain("This is a straightforward request");
    expect(recovered).not.toContain("Echo hi to stdout");
    expect(recovered.split("\n")).not.toContain("hi");
  });

  it("passes plain prose lines through byte for byte", () => {
    const prose = "first plain prose line\nsecond plain prose line";

    expect(recover(`${prose}\n`)).toBe(`${prose}\n`);
    expect(recover(prose)).toBe(prose);
  });

  it.each(['["--model","x"]', '{"type":"telemetry","payload":"future-event"}'])(
    "passes unrecognised JSON through verbatim: %s",
    (line) => {
      expect(recover(line)).toBe(line);
    }
  );

  it("newline-terminates assistant-only streams but not passthrough-only streams", () => {
    const assistantOnly = JSON.stringify(getFixtureAssistantTextEvent());
    const passthroughOnly = "plain prose without a trailing newline";

    // Recovered messages stay newline-terminated, but passthrough outputSize must
    // match the child's byte count: minOutputBytes and the empty check both consume it.
    expect(recover(assistantOnly)).toBe("ALPHA_MARKER\n");
    expect(recover(passthroughOnly)).toBe(passthroughOnly);
  });

  it("drops a successful result event but preserves an API error result", () => {
    const fixtureResult = getFixtureResultEvent();
    const successfulResult = { ...fixtureResult, is_error: false };
    const apiError = "[API Error: overloaded]";
    const failedResult = { ...fixtureResult, is_error: true, result: apiError };

    expect(recover(JSON.stringify(successfulResult))).toBe("");

    // classifyRunOutput matches /\[API Error:/ against recovered stdout. Dropping
    // this failed result would silently disable api_error detection.
    expect(recover(JSON.stringify(failedResult))).toBe(`${apiError}\n`);
  });

  it("does not duplicate an API error already present in recovered prose", () => {
    const apiError = "[API Error: overloaded]";
    const fixtureAssistant = getFixtureAssistantTextEvent();
    const fixtureMessage = fixtureAssistant.message;
    if (!fixtureMessage || typeof fixtureMessage !== "object" || Array.isArray(fixtureMessage)) {
      throw new Error("fixture assistant event has no message object");
    }

    const assistantWithError = {
      ...fixtureAssistant,
      message: {
        ...fixtureMessage,
        content: [{ type: "text", text: apiError }],
      },
    };
    const failedResult = {
      ...getFixtureResultEvent(),
      is_error: true,
      result: apiError,
    };
    const recovered = recover(
      `${JSON.stringify(assistantWithError)}\n${JSON.stringify(failedResult)}\n`
    );

    expect(recovered).toBe(`${apiError}\n`);
    expect(recovered.match(/\[API Error:/g)).toHaveLength(1);
  });

  it("parses a final event without a trailing newline and terminates its output", () => {
    const assistantEvent = getFixtureAssistantTextEvent();

    expect(recover(JSON.stringify(assistantEvent))).toBe("ALPHA_MARKER\n");
  });

  it("ends an empty stream without introducing a newline", () => {
    const capture = createAssistantTextCapture();

    expect(capture.end()).toBe("");
  });
});

describe("createAssistantTextCapture — protocol frames are not prose", () => {
  // REGRESSION: `rate_limit_event` was absent from STREAM_JSON_EVENT_TYPES, so it
  // fell to the passthrough branch and was written into the captured answer.
  // Measured 2026-08-22: a two-byte reply was recorded as 191 B, which corrupts
  // outputSize and silently defeats min_output_bytes.
  const rateLimitFrame =
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed",' +
    '"isUsingOverage":false},"uuid":"5c30f135","session_id":"7ffb7032"}\n';

  const assistantFrame = (text: string) =>
    `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } })}\n`;

  it("drops rate_limit_event instead of emitting it as text", () => {
    const cap = createAssistantTextCapture();
    let out = cap.write(assistantFrame("OK"));
    out += cap.write(rateLimitFrame);
    out += cap.end();
    // Exact value, not trimmed: the capture terminates the answer with a newline,
    // and asserting the real string keeps that pinned too.
    expect(out).toBe("OK\n");
    expect(out).not.toContain("rate_limit_event");
  });

  it("a rate_limit_event alone captures nothing", () => {
    const cap = createAssistantTextCapture();
    const out = cap.write(rateLimitFrame) + cap.end();
    expect(out).toBe("");
  });

  it("still passes genuinely unknown JSON through, as the degradation note promises", () => {
    // The passthrough branch exists for output that is not our protocol at all.
    // Fixing rate_limit_event must not turn it into a silent dropper.
    const cap = createAssistantTextCapture();
    const line = '{"type":"something-we-have-never-seen","x":1}\n';
    const out = cap.write(line) + cap.end();
    expect(out).toContain("something-we-have-never-seen");
  });
});
