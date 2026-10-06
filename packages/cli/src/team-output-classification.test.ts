import { describe, expect, it } from "bun:test";
import type { SettledTurn } from "./pane/index.js";
import {
  DEFAULT_MIN_OUTPUT_BYTES,
  TRUNCATION_NOTE,
  classifyRunOutput,
} from "./team-orchestrator.js";

/*
 * `classifyRunOutput` decides a settled pane turn. Its inputs are the turn's ANSWER (the
 * assistant text read from the transcript — for a file-delivered prompt, only the text
 * after the task file was read), the transcript's API-error entry, the stop_reason and
 * the read coverage of the task file. Precedence: api_error (FAILED) → prompt_not_read
 * (FAILED) → refused (EMPTY) → empty_output → min_output_bytes → shape_mismatch LAST.
 */

const CLEAN_LARGE_OUTPUT = "A".repeat(4000);

function delivery(over: Partial<SettledTurn["delivery"]> = {}): SettledTurn["delivery"] {
  return {
    mode: "file",
    linesTotal: 40,
    linesRead: 40,
    complete: true,
    preambleBytes: 0,
    ...over,
  };
}

describe("classifyRunOutput", () => {
  it("classifies a turn that ended in an API error entry as FAILED api_error", () => {
    const result = classifyRunOutput({
      answer: "",
      apiError: {
        status: 529,
        text: "API Error: 529 Our servers are currently overloaded. Please try again later.",
      },
    });

    expect(result?.state).toBe("FAILED");
    expect(result?.reason).toBe("api_error");
    expect(result?.detail).toContain("status 529");
    expect(result?.detail).toContain("Our servers are currently overloaded");
  });

  it("classifies output below the configured minimum as empty", () => {
    const shortOutput = "A".repeat(300);
    const result = classifyRunOutput({ answer: shortOutput, apiError: null, minOutputBytes: 500 });

    expect(result?.state).toBe("EMPTY");
    expect(result?.reason).toBe("empty_output");
    expect(result?.detail).toContain("at least 500 B");
    expect(
      classifyRunOutput({
        answer: shortOutput,
        apiError: null,
        minOutputBytes: DEFAULT_MIN_OUTPUT_BYTES,
      })
    ).toBeNull();
  });

  it.each([
    "Observability provides visibility into complex system behaviors, enabling rapid diagnosis and resolution of issues before they impact users.",
    "Observability matters because it turns opaque failures into diagnosable signals you can act on.",
  ])("accepts a measured short regression answer at default (%#)", (answer) => {
    expect(classifyRunOutput({ answer, apiError: null })).toBeNull();
  });

  it.each([
    { name: "a newline", answer: "\n" },
    { name: "mixed spaces, newline, and tab", answer: "   \n\t " },
    { name: "zero bytes", answer: "" },
  ])("classifies $name as empty at default", ({ answer }) => {
    const result = classifyRunOutput({ answer, apiError: null });

    expect(result?.state).toBe("EMPTY");
    expect(result?.reason).toBe("empty_output");
  });

  it("accepts large clean output", () => {
    expect(classifyRunOutput({ answer: CLEAN_LARGE_OUTPUT, apiError: null })).toBeNull();
  });

  it("measures min_output_bytes in UTF-8 bytes of the answer", () => {
    const answer = "答え".repeat(10); // 60 bytes, 20 chars
    expect(classifyRunOutput({ answer, apiError: null, minOutputBytes: 60 })).toBeNull();
    expect(classifyRunOutput({ answer, apiError: null, minOutputBytes: 61 })?.reason).toBe(
      "empty_output"
    );
  });

  it("gives an API error precedence over empty output", () => {
    const result = classifyRunOutput({
      answer: "",
      apiError: { status: null, text: "request failed" },
      minOutputBytes: 500,
    });

    expect(result?.reason).toBe("api_error");
  });

  it("classifies a refusal as EMPTY refused", () => {
    const result = classifyRunOutput({
      answer: "I can't help with that.",
      apiError: null,
      stopReason: "refusal",
    });

    expect(result).toEqual({
      state: "EMPTY",
      reason: "refused",
      detail: expect.stringContaining("refusal"),
    });
  });

  it("adds the truncation note to whatever results from a max_tokens turn", () => {
    const result = classifyRunOutput({
      answer: "",
      apiError: null,
      stopReason: "max_tokens",
    });

    expect(result?.reason).toBe("empty_output");
    expect(result?.detail).toContain(TRUNCATION_NOTE);
    expect(
      classifyRunOutput({ answer: "complete", apiError: null, stopReason: "max_tokens" })
    ).toBeNull();
  });
});

describe("classifyRunOutput — prompt_not_read", () => {
  it("fails a turn whose task file was never read", () => {
    const result = classifyRunOutput({
      answer: "VERDICT: ok",
      apiError: null,
      promptRead: delivery({ linesRead: 0, complete: false }),
    });

    expect(result?.state).toBe("FAILED");
    expect(result?.reason).toBe("prompt_not_read");
    expect(result?.detail).toContain("never read");
  });

  it("names the lines a partial read returned", () => {
    const result = classifyRunOutput({
      answer: "VERDICT: ok",
      apiError: null,
      promptRead: delivery({ linesTotal: 3400, linesRead: 2000, complete: false }),
    });

    expect(result?.reason).toBe("prompt_not_read");
    expect(result?.detail).toContain("2000 of 3400");
  });

  it("comes after api_error and before refused and the shape contract", () => {
    const unread = delivery({ linesRead: 0, complete: false });
    expect(
      classifyRunOutput({
        answer: "",
        apiError: { status: 500, text: "boom" },
        promptRead: unread,
      })?.reason
    ).toBe("api_error");
    expect(
      classifyRunOutput({
        answer: "no",
        apiError: null,
        stopReason: "refusal",
        promptRead: unread,
        requirePattern: "VERDICT",
      })?.reason
    ).toBe("prompt_not_read");
  });

  it("does not apply to a typed prompt (complete is null) or a fully read file", () => {
    expect(
      classifyRunOutput({
        answer: "ok",
        apiError: null,
        promptRead: delivery({ mode: "typed", linesTotal: null, linesRead: null, complete: null }),
      })
    ).toBeNull();
    expect(classifyRunOutput({ answer: "ok", apiError: null, promptRead: delivery() })).toBeNull();
  });
});

describe("classifyRunOutput — requirePattern", () => {
  const requirePattern = "```vote";

  // These are the three real epilogues that replaced complete answers in the
  // measured print-mode dropout runs. A pane turn keeps every assistant message, but
  // an answer that IS only an epilogue still has no vote, and must still be refused.
  const dropoutFixtures = [
    {
      name: "repro4 response-01 from gc@glm-5.2",
      text: 'The background agent finished: it counted **99** `.ts` files under `packages/cli/src/` containing "timeout" (case-insensitive; 77 for strict-lowercase). That was step 1\'s parallel task — the review and vote above are complete and unaffected by it.\n',
    },
    {
      name: "repro4 response-02 from kc@k3",
      text:
        'The background agent from step 1 has finished: it found **99 `.ts` files** under `packages/cli/src/` containing the word "timeout" (case-insensitive; 77 if matched strictly lowercase), verified with two independent search tools.\n\n' +
        "The review and vote above stand as delivered — the classification logic in `team-orchestrator.ts` is approved with the bounded-tail caveat on the API-error marker.\n",
    },
    {
      name: "the original glm-5.2 incident",
      text:
        "The stray agent was already stopped — that notification just confirms the kill I issued.\n" +
        "Nothing further needed on that front.\n\n" +
        "My review is complete and stands. No new user input has arrived, so I'm not taking any\n" +
        "additional action.\n",
    },
  ];

  it.each(dropoutFixtures)("classifies $name as a shape mismatch", ({ text }) => {
    const result = classifyRunOutput({ answer: text, apiError: null, requirePattern });

    expect(result?.state).toBe("EMPTY");
    expect(result?.reason).toBe("shape_mismatch");
    expect(result?.detail).toContain(requirePattern);
    expect(result?.detail).toContain(`${Buffer.byteLength(text)} B`);
  });

  it("accepts output that contains the required shape", () => {
    const text = [
      "The review is complete.",
      "```vote",
      "RESPONSE: 01",
      "VERDICT: APPROVE",
      "```",
    ].join("\n");

    expect(classifyRunOutput({ answer: text, apiError: null, requirePattern })).toBeNull();
  });

  it("leaves shape validation off when requirePattern is omitted", () => {
    expect(classifyRunOutput({ answer: dropoutFixtures[0].text, apiError: null })).toBeNull();
  });

  it("matches the FULL answer: a marker at the start of a long answer is found", () => {
    const text = `Review complete.\n${requirePattern}\n${"A".repeat(40_000)}`;
    expect(classifyRunOutput({ answer: text, apiError: null, requirePattern })).toBeNull();
  });

  it("anchors ^ to the start of the whole answer, with no flags (no m)", () => {
    const answer = "VERDICT: PASS\n\nThe change is sound.";
    expect(classifyRunOutput({ answer, apiError: null, requirePattern: "^VERDICT:" })).toBeNull();

    // A verdict on a later line does not satisfy ^: the pattern has no `m` flag.
    const later = "I read the file.\n\nVERDICT: PASS";
    expect(
      classifyRunOutput({ answer: later, apiError: null, requirePattern: "^VERDICT:" })?.reason
    ).toBe("shape_mismatch");
    // $ anchors to the end of the whole answer.
    expect(classifyRunOutput({ answer, apiError: null, requirePattern: "sound\\.$" })).toBeNull();
  });

  it.each([
    {
      name: "an API error",
      expectedReason: "api_error",
      input: { answer: "", apiError: { status: 529, text: "overloaded" } },
    },
    {
      name: "a refusal",
      expectedReason: "refused",
      input: { answer: "No.", apiError: null, stopReason: "refusal" },
    },
    {
      name: "zero-byte output",
      expectedReason: "empty_output",
      input: { answer: "", apiError: null },
    },
    {
      name: "whitespace-only output",
      expectedReason: "empty_output",
      input: { answer: "\n", apiError: null },
    },
    {
      name: "output below the caller's minimum",
      expectedReason: "empty_output",
      input: { answer: "A short but non-empty response.", apiError: null, minOutputBytes: 500 },
    },
  ])("gives $name precedence over shape validation", ({ expectedReason, input }) => {
    const result = classifyRunOutput({ ...input, requirePattern });

    expect(result?.reason).toBe(expectedReason as never);
    expect(result?.reason).not.toBe("shape_mismatch");
  });

  it("does not fail an otherwise-good run when called directly with an invalid regex", () => {
    const text = "A complete response with substantive analysis and a clear conclusion.";
    let result: ReturnType<typeof classifyRunOutput> | undefined;

    expect(() => {
      result = classifyRunOutput({ answer: text, apiError: null, requirePattern: "(" });
    }).not.toThrow();
    expect(result).toBeNull();
  });
});
