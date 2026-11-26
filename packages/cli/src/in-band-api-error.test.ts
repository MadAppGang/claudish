import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  formatInBandApiError,
  inBandErrorCodeKey,
  parseInBandApiError,
  proxyProvesInBandError,
} from "./in-band-api-error.js";

const marker = readFileSync(
  new URL("./test-fixtures/mcp-model-check/credit-balance-exhausted-20261023.txt", import.meta.url),
  "utf8"
).trim();
const code = "credit_balance_exhausted";
const text = marker.slice("[API Error: ".length, -1);
const message = text.slice(code.length + 1);

describe("in-band API error markers", () => {
  test("formats the real billing error verbatim and round-trips its code and text", () => {
    const formatted = formatInBandApiError(code, message);
    expect(formatted).toBe(`\n\n${marker}`);
    expect(parseInBandApiError(formatted)).toEqual({ code, text });
  });

  test.each(["", " ", "\n\n", "\t\r\n "])(
    "allows surrounding whitespace %j on a whole-answer marker",
    (space) => {
      expect(parseInBandApiError(space + marker + space)).toEqual({ code, text });
    }
  );

  test.each([
    `I'll read the file.\n\n${marker}`,
    `I'll read the file.\n\n${marker}\n\nThe answer continues.`,
    `I'll read the file.\n${marker}`,
  ])("never reads a marker after a preamble: %s", (answer) => {
    expect(parseInBandApiError(answer)).toBeNull();
  });

  test.each([
    `The provider returned ${marker}`,
    `${marker}\nPlease add credits.`,
    `Quoted error:\n${marker}\nEnd of quotation.`,
    "",
    "Ordinary model answer.",
  ])("does not classify a marker inside longer text or ordinary text: %s", (answer) => {
    expect(parseInBandApiError(answer)).toBeNull();
  });
});

describe("proxyProvesInBandError — the proxy's record as the proof of a marker", () => {
  const start = "2026-11-21T10:00:00.000Z";
  const at = "2026-11-21T10:00:02.000Z";

  test("a record with the marker's code at or after the turn's start proves it", () => {
    expect(proxyProvesInBandError(code, { code, at }, start)).toBe(true);
    expect(proxyProvesInBandError(code, { code, at: start }, start)).toBe(true);
  });

  test("no record, another code, an older record or an unknown start proves nothing", () => {
    expect(proxyProvesInBandError(code, null, start)).toBe(false);
    expect(proxyProvesInBandError(code, { code: "cyber_policy", at }, start)).toBe(false);
    expect(proxyProvesInBandError(code, { code, at: "2026-11-21T09:59:59.000Z" }, start)).toBe(
      false
    );
    expect(proxyProvesInBandError(code, { code, at }, null)).toBe(false);
    expect(proxyProvesInBandError(code, { code, at: "not a time" }, start)).toBe(false);
  });

  test("a code that is not an identifier matches its `malformed` record", () => {
    expect(inBandErrorCodeKey("weird/code!")).toBe("malformed");
    expect(inBandErrorCodeKey(code)).toBe(code);
    expect(proxyProvesInBandError("weird/code!", { code: "malformed", at }, start)).toBe(true);
  });

  test("a code holding whitespace keys to the same word the marker parses to", () => {
    const parsed = parseInBandApiError(formatInBandApiError("bad code", "refused"));
    expect(parsed?.code).toBe("bad");
    const recorded = inBandErrorCodeKey("bad code");
    expect(recorded).toBe(inBandErrorCodeKey(parsed?.code ?? ""));
    expect(proxyProvesInBandError(parsed?.code ?? "", { code: recorded, at }, start)).toBe(true);
  });

  test("an identifier code is its own key, and a non-identifier first word is `malformed`", () => {
    expect(inBandErrorCodeKey("server_is_overloaded")).toBe("server_is_overloaded");
    expect(inBandErrorCodeKey("  cyber_policy  ")).toBe("cyber_policy");
    expect(inBandErrorCodeKey("key=abc rejected")).toBe("malformed");
    expect(inBandErrorCodeKey("")).toBe("malformed");
    expect(inBandErrorCodeKey("x".repeat(81))).toBe("malformed");
  });
});
