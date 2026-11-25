import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { formatInBandApiError, inBandErrorCodeKey } from "./in-band-api-error.js";
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
 * (FAILED) → refused (EMPTY) → empty_output → min_output_bytes → shape_mismatch
 * (SHAPE_MISMATCH) LAST.
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

describe("classifyRunOutput — in-band API errors", () => {
  const answer = readFileSync(
    new URL(
      "./test-fixtures/mcp-model-check/credit-balance-exhausted-20261023.txt",
      import.meta.url
    ),
    "utf8"
  );
  const unread = delivery({ linesRead: 0, complete: false });

  it("reports the captured billing error as FAILED api_error before prompt_not_read", () => {
    const result = classifyRunOutput({ answer, apiError: null, promptRead: unread });
    expect(result).toEqual({
      state: "FAILED",
      reason: "api_error",
      detail: expect.stringContaining("credit_balance_exhausted"),
    });
    expect(result?.detail).toContain("You have no credits remaining");
  });

  it("reports a trailing billing error after an unread turn's preamble as api_error", () => {
    const result = classifyRunOutput({
      answer: `I'll read the file.\n\n${answer.trim()}`,
      apiError: null,
      promptRead: unread,
      requirePattern: "VERDICT:",
    });
    expect(result).toEqual({
      state: "FAILED",
      reason: "api_error",
      detail: expect.stringContaining("credit_balance_exhausted"),
    });
    expect(result?.detail).toContain("You have no credits remaining");
  });

  const overflowAnswer =
    "\n\n[API Error: context_length_exceeded Context limit reached. This model's backend enforces a smaller context window ~372K tokens than its API spec. " +
    "Run /clear to start fresh (/compact will also fail — it re-sends the full conversation), " +
    "or route the model via `oai@gpt-5.6-sol` to use the full-size window.]";

  it("reports a whole-answer context overflow as api_error even after the task was read", () => {
    const result = classifyRunOutput({
      answer: overflowAnswer,
      apiError: null,
      promptRead: delivery({ complete: true }),
    });
    expect(result).toEqual({
      state: "FAILED",
      reason: "api_error",
      detail: expect.stringContaining("context_length_exceeded"),
    });
    expect(result?.detail).toContain("Context limit reached");
    expect(result?.detail).toContain("/clear");
    expect(result?.detail).toContain("oai@gpt-5.6-sol");
  });

  it("reports a trailing context overflow after an unread turn's preamble as api_error", () => {
    const result = classifyRunOutput({
      answer: `I'll read the file.\n\n${overflowAnswer.trim()}`,
      apiError: null,
      promptRead: unread,
      requirePattern: "VERDICT:",
    });
    expect(result).toEqual({
      state: "FAILED",
      reason: "api_error",
      detail: expect.stringContaining("context_length_exceeded"),
    });
    expect(result?.detail).toContain("Context limit reached");
  });

  it("keeps a read turn's verdict when its answer ends with the same billing marker", () => {
    const input = {
      answer: `I'll read the file.\n\n${answer.trim()}`,
      apiError: null,
      promptRead: delivery({ complete: true }),
    };
    expect(classifyRunOutput(input)).toBeNull();
    expect(classifyRunOutput({ ...input, requirePattern: "VERDICT:" })).toEqual({
      state: "SHAPE_MISMATCH",
      reason: "shape_mismatch",
      detail: expect.stringContaining("VERDICT:"),
    });
  });

  it("gives the Claude Code apiError status and text precedence over the in-band marker", () => {
    const result = classifyRunOutput({
      answer,
      apiError: {
        status: 529,
        text: "API Error: 529 Our servers are currently overloaded. Please try again later.",
      },
      promptRead: unread,
    });
    expect(result).toEqual({
      state: "FAILED",
      reason: "api_error",
      detail: expect.stringContaining("status 529"),
    });
    expect(result?.detail).toContain("Our servers are currently overloaded");
    expect(result?.detail).not.toContain("credit_balance_exhausted");
  });

  it.each([`The provider returned:\n${answer}`, `${answer}\nThis is quoted provider output.`])(
    "keeps prompt_not_read for a marker embedded in a longer answer: %s",
    (text) => {
      expect(classifyRunOutput({ answer: text, apiError: null, promptRead: unread })).toEqual({
        state: "FAILED",
        reason: "prompt_not_read",
        detail: expect.stringContaining("never read"),
      });
    }
  );
});

describe("classifyRunOutput — in-band API error as the turn's last API response", () => {
  // The real shape: a slot narrated its progress in earlier responses, then the final
  // response held thinking blocks and ONE text block that is exactly the marker,
  // stop_reason end_turn, no isApiErrorMessage. The proxy that wrote the marker also
  // recorded it in the slot's token file (`in_band_api_error`), and only that record
  // tells claudish's marker from the model quoting one.
  const marker =
    "\n\n[API Error: cyber_policy This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request.]";
  const progress =
    "Reading the module first.\n\nThe handler parses three fields; checking the tests next.";
  const endsWith = (text: string) => ({ blockType: "text", text });
  const turnStartedAt = "2026-11-21T10:00:00.000Z";
  const proof = (code = "cyber_policy", at = "2026-11-21T10:00:05.000Z") => ({
    proxyInBandError: { code, at },
    turnStartedAt,
  });

  it("reports a final response that is only the marker as FAILED api_error after progress text", () => {
    const result = classifyRunOutput({
      answer: `${progress}\n\n${marker}`,
      lastResponseEnd: endsWith(marker),
      ...proof(),
      apiError: null,
      stopReason: "end_turn",
      promptRead: delivery({ complete: true }),
      requirePattern: "VERDICT:",
    });
    expect(result?.state).toBe("FAILED");
    expect(result?.reason).toBe("api_error");
    expect(result?.detail).toContain("cyber_policy");
    expect(result?.detail).toContain("content policy");
    expect(result?.detail).not.toMatch(/relax|re-prompt/i);
  });

  it("reports it whatever the read coverage says", () => {
    const result = classifyRunOutput({
      answer: `${progress}\n\n${marker}`,
      lastResponseEnd: endsWith(marker),
      ...proof(),
      apiError: null,
      promptRead: delivery({ linesRead: 10, complete: false }),
    });
    expect(result?.reason).toBe("api_error");
  });

  it("accepts a proxy record written in the same millisecond the turn started", () => {
    const result = classifyRunOutput({
      answer: marker,
      lastResponseEnd: endsWith(marker),
      ...proof("cyber_policy", turnStartedAt),
      apiError: null,
      promptRead: delivery({ complete: true }),
    });
    expect(result?.reason).toBe("api_error");
  });

  it("reads a marker block with no proxy record as the model's text", () => {
    const result = classifyRunOutput({
      answer: `${progress}\n\n${marker}`,
      lastResponseEnd: endsWith(marker),
      turnStartedAt,
      apiError: null,
      stopReason: "end_turn",
      promptRead: delivery({ complete: true }),
      requirePattern: "VERDICT:",
    });
    expect(result?.reason).not.toBe("api_error");
    expect(result?.reason).toBe("shape_mismatch");
  });

  it("reads a quoted marker the greedy pattern would match as the model's text without a record", () => {
    // One text block that starts with a marker and ends in `]`: the writer's format
    // `[API Error: <code> <message>]` cannot be told apart from it by text alone.
    const quoted = "[API Error: overloaded] is what you see; retry later [see docs]";
    const result = classifyRunOutput({
      answer: quoted,
      lastResponseEnd: endsWith(quoted),
      turnStartedAt,
      proxyInBandError: null,
      apiError: null,
      promptRead: delivery({ complete: true }),
    });
    expect(result).toBeNull();
  });

  it("reports a marker whose code held whitespace as api_error against the record's key", () => {
    const spaced = formatInBandApiError("bad code", "refused");
    const result = classifyRunOutput({
      answer: spaced,
      lastResponseEnd: endsWith(spaced),
      ...proof(inBandErrorCodeKey("bad code")),
      apiError: null,
      promptRead: delivery({ complete: true }),
    });
    expect(result?.reason).toBe("api_error");
  });

  it("reads a marker as the model's text when the proxy recorded a different code", () => {
    const result = classifyRunOutput({
      answer: marker,
      lastResponseEnd: endsWith(marker),
      ...proof("server_is_overloaded"),
      apiError: null,
      promptRead: delivery({ complete: true }),
    });
    expect(result).toBeNull();
  });

  it("reads a marker as the model's text when the proxy record is older than the turn", () => {
    const result = classifyRunOutput({
      answer: marker,
      lastResponseEnd: endsWith(marker),
      ...proof("cyber_policy", "2026-11-21T09:59:59.999Z"),
      apiError: null,
      promptRead: delivery({ complete: true }),
    });
    expect(result).toBeNull();
  });

  it("reads a marker as the model's text when the turn's start is unknown", () => {
    const result = classifyRunOutput({
      answer: marker,
      lastResponseEnd: endsWith(marker),
      proxyInBandError: { code: "cyber_policy", at: "2026-11-21T10:00:05.000Z" },
      turnStartedAt: null,
      apiError: null,
      promptRead: delivery({ complete: true }),
    });
    expect(result).toBeNull();
  });

  it("keeps a marker quoted inside a longer final text block as the model's text", () => {
    const quoted = `The provider sometimes answers with ${marker.trim()} — that is not what happened here.\n\nVERDICT: PASS`;
    const result = classifyRunOutput({
      answer: `${progress}\n\n${quoted}`,
      lastResponseEnd: endsWith(quoted),
      ...proof(),
      apiError: null,
      stopReason: "end_turn",
      promptRead: delivery({ complete: true }),
      requirePattern: "VERDICT:",
    });
    expect(result).toBeNull();
  });

  it("reports a marker block appended after streamed prose in the same response as api_error", () => {
    // The proxy's endWithText adds the marker as an extra text block of the response
    // whose prose had already streamed: [prose block, marker block].
    const result = classifyRunOutput({
      answer: `${progress}\n\nSee below.\n\n${marker}`,
      lastResponseEnd: endsWith(marker),
      ...proof(),
      apiError: null,
      promptRead: delivery({ complete: true }),
      requirePattern: "VERDICT:",
    });
    expect(result?.state).toBe("FAILED");
    expect(result?.reason).toBe("api_error");
  });

  it("keeps one final block of prose ending in a marker as the model's text, even unread", () => {
    const block = "The provider returned:\n\n[API Error: cyber_policy refused]";
    const result = classifyRunOutput({
      answer: block,
      lastResponseEnd: endsWith(block),
      ...proof(),
      apiError: null,
      promptRead: delivery({ linesRead: 0, complete: false }),
    });
    expect(result?.reason).not.toBe("api_error");
    expect(result?.reason).toBe("prompt_not_read");
  });

  it("does not read a marker followed by a later content block of that response as an error", () => {
    const result = classifyRunOutput({
      answer: `${progress}\n\n${marker}`,
      lastResponseEnd: { blockType: "tool_use", text: null },
      ...proof(),
      apiError: null,
      promptRead: delivery({ complete: true }),
    });
    expect(result).toBeNull();
  });

  it("uses no joined-answer rule once the last response is known", () => {
    const result = classifyRunOutput({
      answer: marker,
      lastResponseEnd: { blockType: "thinking", text: null },
      ...proof(),
      apiError: null,
      promptRead: delivery({ complete: true }),
    });
    expect(result).toBeNull();
  });

  it("applies the joined-answer rules when no last-response data exists", () => {
    const result = classifyRunOutput({
      answer: `I'll read the file.\n\n[API Error: cyber_policy refused]`,
      apiError: null,
      promptRead: delivery({ linesRead: 0, complete: false }),
    });
    expect(result?.reason).toBe("api_error");
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

    expect(result?.state).toBe("SHAPE_MISMATCH");
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
