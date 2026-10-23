import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { formatInBandApiError, parseInBandApiError } from "./in-band-api-error.js";

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
    `The provider returned ${marker}`,
    `${marker}\nPlease add credits.`,
    `Quoted error:\n${marker}\nEnd of quotation.`,
    "",
    "Ordinary model answer.",
  ])("does not classify a marker inside longer text or ordinary text: %s", (answer) => {
    expect(parseInBandApiError(answer)).toBeNull();
  });
});
