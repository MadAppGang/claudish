import { describe, expect, test } from "bun:test";
import { snapshotFromCodexHeaders } from "./codex.js";

const NOW = Date.parse("2026-09-12T12:00:00.000Z");

describe("Codex account usage headers", () => {
  test("keeps slot identity separate from the reported window duration", () => {
    // PROVISIONAL: constructed from the measured Codex Pro header names and
    // primary=10080-minute shape documented in auth/quota/sources/codex.ts.
    // Replace with a full real response-header capture from a Phase V account run.
    const headers = new Headers({
      "x-codex-plan-type": "pro",
      "x-codex-primary-used-percent": "41",
      "x-codex-primary-reset-at": "1789232400",
      "x-codex-primary-window-minutes": "10080",
      "x-codex-secondary-used-percent": "0",
      "x-codex-secondary-window-minutes": "0",
    });

    const snapshot = snapshotFromCodexHeaders(headers, NOW);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.observedAt).toBe(NOW);
    expect(snapshot?.label).toBe("Codex Pro");
    expect(snapshot?.windows).toEqual([
      {
        slot: "primary",
        displayId: "7d",
        lengthMinutes: 10_080,
        usedFraction: 0.41,
        resetAt: 1_789_232_400_000,
      },
    ]);

    // Mutation caught: label primary by its historical position as `5h`, key it
    // by the formatted duration, or omit lengthMinutes. The measured weekly
    // primary slot then no longer matches this snapshot.
  });
});
