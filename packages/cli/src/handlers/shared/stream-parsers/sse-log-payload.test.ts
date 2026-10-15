import { describe, expect, test } from "bun:test";
import {
  SSE_LOG_MAX_CHARS,
  SSE_LOG_TRUNCATION_MARKER,
  formatRawSseLogPayload,
} from "./openai-sse.js";

describe("formatRawSseLogPayload", () => {
  // This test fails if any short payload cap returns.
  test("preserves a realistic payload well beyond the former 300-character cap", () => {
    const payload = JSON.stringify({
      choices: [
        {
          delta: {
            role: "assistant",
            content: "x".repeat(5_000),
          },
        },
      ],
    });

    const result = formatRawSseLogPayload(payload);

    expect(result).toBe(payload);
    expect(result.length).toBe(payload.length);
    expect(result).not.toContain(SSE_LOG_TRUNCATION_MARKER);
  });

  test("marks an over-limit payload and reports its original length", () => {
    const payload = JSON.stringify({
      choices: [
        {
          delta: {
            content: "x".repeat(SSE_LOG_MAX_CHARS + 1_234),
          },
        },
      ],
    });

    const result = formatRawSseLogPayload(payload);
    const keptPrefix = payload.slice(0, SSE_LOG_MAX_CHARS);
    const truncationSuffix = ` ${SSE_LOG_TRUNCATION_MARKER} original_chars=${payload.length}`;

    expect(result).toContain(SSE_LOG_TRUNCATION_MARKER);
    expect(result).toContain(`original_chars=${payload.length}`);
    expect(() => JSON.parse(result)).toThrow();
    expect(result.slice(0, SSE_LOG_MAX_CHARS)).toBe(keptPrefix);
    expect(result).toBe(`${keptPrefix}${truncationSuffix}`);
  });

  test("returns payloads at or under the maximum byte for byte", () => {
    const underMaximum = "x".repeat(SSE_LOG_MAX_CHARS - 1);
    const atMaximum = "x".repeat(SSE_LOG_MAX_CHARS);

    expect(formatRawSseLogPayload(underMaximum)).toBe(underMaximum);
    expect(formatRawSseLogPayload(atMaximum)).toBe(atMaximum);
    expect(formatRawSseLogPayload("")).toBe("");
    expect(formatRawSseLogPayload("[DONE]")).toBe("[DONE]");
  });
});
