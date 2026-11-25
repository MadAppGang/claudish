/**
 * The verdict of a one-shot `create_session` turn (`oneShotVerdictOf`), without a pane: a
 * settled turn whose last assistant API response ends in a text block that is exactly one in-band
 * API error marker failed, whatever progress text the turn wrote before it, when the session's
 * proxy recorded that error in the session's token file (`in_band_api_error`) during the turn.
 */

import { describe, expect, it } from "bun:test";

import { formatInBandApiError } from "../in-band-api-error.js";
import type { SettledTurn } from "../pane/index.js";
import { oneShotVerdictOf } from "./session-manager.js";

const marker = formatInBandApiError(
  "cyber_policy",
  "This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request."
);
const progress =
  "Reading the module first.\n\nThe handler parses three fields; checking the tests next.";
const acceptedAt = "2026-11-21T10:00:00.000Z";
const record = { code: "cyber_policy", at: "2026-11-21T10:00:04.000Z" };

function settledTurn(over: Partial<SettledTurn>): SettledTurn {
  const delivery: SettledTurn["delivery"] = {
    mode: "file",
    linesTotal: 12,
    linesRead: 12,
    complete: true,
    preambleBytes: 0,
  };
  return {
    index: 1,
    answer: "",
    acceptedAt,
    apiError: null,
    stopReason: "end_turn",
    captureSource: "transcript",
    settledBy: "turn_duration",
    shape: "one-shot",
    delivery,
    chainAnswers: [],
    chainDelivery: delivery,
    hookTurns: 0,
    hookCaused: false,
    ...over,
  };
}

describe("oneShotVerdictOf — in-band API error as the turn's last API response", () => {
  it("fails a turn whose final response is only the marker after progress text", () => {
    const verdict = oneShotVerdictOf(
      settledTurn({
        answer: `${progress}\n\n${marker}`,
        lastResponseEnd: { blockType: "text", text: marker },
      }),
      record
    );
    expect(verdict.state).toBe("FAILED");
    expect(verdict.reason).toBe("api_error");
    expect(verdict.detail).toContain("cyber_policy");
    expect(verdict.detail).toContain("content policy");
  });

  it("completes a marker-only final block when the session's proxy recorded no error", () => {
    const verdict = oneShotVerdictOf(
      settledTurn({
        answer: `${progress}\n\n${marker}`,
        lastResponseEnd: { blockType: "text", text: marker },
      }),
      null
    );
    expect(verdict.state).toBe("COMPLETED");
  });

  it("completes a marker-only final block when the proxy's record is an earlier turn's", () => {
    const verdict = oneShotVerdictOf(
      settledTurn({ answer: marker, lastResponseEnd: { blockType: "text", text: marker } }),
      { code: "cyber_policy", at: "2026-11-21T09:00:00.000Z" }
    );
    expect(verdict.state).toBe("COMPLETED");
  });

  it("completes a turn whose final text quotes the marker inside a longer answer", () => {
    const quoted = `The provider sometimes answers with ${marker.trim()} — that is not what happened here.`;
    const verdict = oneShotVerdictOf(
      settledTurn({
        answer: `${progress}\n\n${quoted}`,
        lastResponseEnd: { blockType: "text", text: quoted },
      }),
      record
    );
    expect(verdict.state).toBe("COMPLETED");
    expect(verdict.reason).toBeUndefined();
  });

  it("fails a turn whose final response is prose and then a separate marker block", () => {
    const verdict = oneShotVerdictOf(
      settledTurn({
        answer: `See below.\n\n${marker}`,
        lastResponseEnd: { blockType: "text", text: marker },
      }),
      record
    );
    expect(verdict.reason).toBe("api_error");
  });

  it("completes a turn whose marker was followed by a tool_use in the same response", () => {
    const verdict = oneShotVerdictOf(
      settledTurn({ answer: marker, lastResponseEnd: { blockType: "tool_use", text: null } }),
      record
    );
    expect(verdict.state).toBe("COMPLETED");
  });
});
