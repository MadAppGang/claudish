import { describe, expect, test } from "bun:test";
import type { FailureReason, SlotState } from "./contract.js";
import { reasonDetail } from "./reason-detail.js";

// Real evidence: requirements.md §3b R9 and qa/briefs/C-reason-detail.md.
// Boundary/multiline inputs below are transformations of that observed detail.
// Verbatim capture: qa/fixtures/real-04-upstream.jsonl in the same session.
// String.raw preserves the escaped JSON STRING in body, including its original envelope.
const REAL_UPSTREAM_RECORD = String.raw`{"at":"2026-09-03T09:34:24.740Z","provider":"Zen Go","model":"grok-4.6","status":401,"body":"{\"type\":\"error\",\"error\":{\"type\":\"ModelError\",\"message\":\"Model grok-4.6 is not supported for format oa-compat\"}}"}`;
const UPSTREAM_MESSAGE = "Model grok-4.6 is not supported for format oa-compat";
const PROVIDER_MESSAGE = "no-such-model-zz9 is not a valid model ID";
const API_BOILERPLATE = "The turn ended in an API error (status 400): API Error: 400";
const API_DETAIL = `${API_BOILERPLATE} ${PROVIDER_MESSAGE}`;
const DETAIL_REASONS = [
  "boot_blocked",
  "first_run_dialog",
  "blocked",
  "child_exited",
  "agent_rejected",
] as const satisfies readonly FailureReason[];

// TEST-1 — REQ-4. The expected value is deliberately independent of the detail's prefix.
describe("reasonDetail API-error fallback", () => {
  test.each([
    ["observed API-error boilerplate", API_DETAIL],
    ["already-readable provider message", PROVIDER_MESSAGE],
  ])(
    "REQ-4: returns only the provider message from %s with no upstream record",
    (_label, detail) => {
      const input = { state: "FAILED", reason: "api_error", detail } as const;

      const implicitRecords = reasonDetail(input);
      const emptyRecords = reasonDetail(input, []);

      expect(implicitRecords).toBe("no-such-model-zz9 is not a valid model ID");
      expect(emptyRecords).toBe("no-such-model-zz9 is not a valid model ID");
    }
  );

  // TEST-11 — REQ-2, REQ-4.
  test("REQ-2 REQ-4: returns one stripped line from multiline API-error detail", () => {
    const detail = `${API_DETAIL}\n${PROVIDER_MESSAGE}`;

    const result = reasonDetail({ state: "FAILED", reason: "api_error", detail });

    expect(result).toBe(PROVIDER_MESSAGE);
  });

  // TEST-8 — REQ-4, REQ-7.
  test.each([
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
    ["whitespace only", " \t\r\n"],
    ["boilerplate only", API_BOILERPLATE],
  ] as const)("REQ-4 REQ-7: returns null when API-error detail is %s", (_label, detail) => {
    const result = reasonDetail({ state: "FAILED", reason: "api_error", detail });

    expect(result).toBeNull();
  });
});

// TEST-5 — REQ-2, REQ-5.
describe("reasonDetail detail-preserving reasons", () => {
  test.each([...DETAIL_REASONS])(
    "REQ-2 REQ-5: returns only the first detail line for %s",
    (reason) => {
      const detail = `${PROVIDER_MESSAGE}\n${API_DETAIL}`;

      const result = reasonDetail({ state: "FAILED", reason, detail });

      expect(result).toBe(PROVIDER_MESSAGE);
    }
  );

  test("REQ-2 REQ-5: returns the first child_exited detail line without a CRLF terminator", () => {
    const detail = `${PROVIDER_MESSAGE}\r\n${API_DETAIL}`;

    const result = reasonDetail({ state: "FAILED", reason: "child_exited", detail });

    expect(result).toBe(PROVIDER_MESSAGE);
  });

  // TEST-8 — REQ-7. Exercise missing/empty detail for every named reason.
  test.each([
    ["boot_blocked", null],
    ["first_run_dialog", undefined],
    ["blocked", ""],
    ["child_exited", " \t"],
    ["agent_rejected", "\r\n"],
  ] as const)("REQ-7: returns null when %s has no readable detail", (reason, detail) => {
    const result = reasonDetail({ state: "FAILED", reason, detail });

    expect(result).toBeNull();
  });
});

describe("reasonDetail state gating", () => {
  // TEST-6 — REQ-6. Populated stale detail must not bypass state gating.
  test.each([
    "STARTING",
    "RUNNING",
    "AWAITING_INPUT",
    "AWAITING_PERMISSION",
    "COMPLETED",
  ] satisfies SlotState[])(
    "REQ-6: returns null for %s even when API-error detail is populated",
    (state) => {
      const result = reasonDetail({ state, reason: "api_error", detail: API_DETAIL });

      expect(result).toBeNull();
    }
  );

  // TEST-7 — REQ-7. All failure terminal states, not just FAILED.
  test.each([
    ["FAILED", "api_error"],
    ["CANCELLED", "cancelled"],
    ["TIMEOUT", "timeout"],
    ["EMPTY", "empty_output"],
  ] as const)(
    "REQ-7: returns null for %s with reason %s and no detail or records",
    (state, reason) => {
      const result = reasonDetail({ state, reason, detail: null }, []);

      expect(result).toBeNull();
    }
  );
});

// TEST-9 — REQ-2. The contract bounds the line, not the choice of truncation marker.
describe("reasonDetail length boundary", () => {
  for (const reason of ["api_error", "child_exited"] as const) {
    test.each([159, 160, 161, 400])(
      `REQ-2: bounds a ${reason} message of %i characters to one line of at most 160`,
      (length) => {
        const message = PROVIDER_MESSAGE.repeat(Math.ceil(length / PROVIDER_MESSAGE.length)).slice(
          0,
          length
        );
        const detail = reason === "api_error" ? `${API_BOILERPLATE} ${message}` : message;

        const result = reasonDetail({ state: "FAILED", reason, detail });

        expect(result).not.toBeNull();
        expect(result!).not.toMatch(/[\r\n]/);
        expect(result!.length).toBeLessThanOrEqual(160);
        if (length <= 160) {
          expect(result).toBe(message);
        } else {
          expect(result!.length).toBeLessThan(message.length);
          expect(result!.startsWith(PROVIDER_MESSAGE)).toBe(true);
        }
      }
    );
  }
});

// TEST-10 — REQ-9. Invalid JSON needs no guessed capture-file schema.
describe("reasonDetail malformed upstream JSONL", () => {
  test("REQ-9 REQ-4: ignores a malformed JSONL line and returns the stripped child message", () => {
    const result = reasonDetail({ state: "FAILED", reason: "api_error", detail: API_DETAIL }, [
      "{",
    ]);

    expect(result).toBe(PROVIDER_MESSAGE);
  });

  test("REQ-9 REQ-7: ignores a malformed JSONL line and returns null without child detail", () => {
    const result = reasonDetail({ state: "FAILED", reason: "api_error", detail: null }, ["{"]);

    expect(result).toBeNull();
  });
});

describe("reasonDetail real upstream JSONL", () => {
  // TEST-2 — REQ-3. Exercise the verbatim record both without and over conflicting child detail.
  test("REQ-3: returns exactly the upstream provider error.message instead of child detail", () => {
    for (const detail of [null, API_DETAIL]) {
      const input = { state: "FAILED", reason: "api_error", detail } as const;

      const result = reasonDetail(input, [REAL_UPSTREAM_RECORD]);

      expect(result).toBe("Model grok-4.6 is not supported for format oa-compat");
    }
  });

  // TEST-3 — REQ-3. Change only the message; preserve the real envelope and JSON-string body.
  test("REQ-3: selects the last upstream record's provider message in oldest-first input", () => {
    const record = JSON.parse(REAL_UPSTREAM_RECORD);
    const body = JSON.parse(record.body);
    const changedMessage = `${UPSTREAM_MESSAGE} (another attempt)`;
    body.error.message = changedMessage;
    const changedRecord = JSON.stringify({ ...record, body: JSON.stringify(body) });
    const input = { state: "FAILED", reason: "api_error", detail: API_DETAIL } as const;

    const changedLast = reasonDetail(input, [REAL_UPSTREAM_RECORD, changedRecord]);
    const originalLast = reasonDetail(input, [changedRecord, REAL_UPSTREAM_RECORD]);

    expect(changedLast).toBe(changedMessage);
    expect(originalLast).toBe(UPSTREAM_MESSAGE);
  });

  // TEST-4 — REQ-8. Add only a sibling field inside the real body to expose identifier leaks.
  test("REQ-8: returns only the upstream message and never user_id or other body fields", () => {
    const record = JSON.parse(REAL_UPSTREAM_RECORD);
    const body = JSON.parse(record.body);
    const recordWithUserId = JSON.stringify({
      ...record,
      body: JSON.stringify({ ...body, user_id: "u-123" }),
    });

    const result = reasonDetail({ state: "FAILED", reason: "api_error", detail: null }, [
      recordWithUserId,
    ]);

    expect(result).toBe(UPSTREAM_MESSAGE);
    expect(result).not.toContain("user_id");
    expect(result).not.toContain("u-123");
    expect(result).not.toContain("ModelError");
    expect(result).not.toContain('"type"');
  });
});
