import { describe, expect, test } from "bun:test";
import { snapshotFromAnthropicHeaders } from "./anthropic.js";

const NOW = Date.parse("2026-09-12T12:00:00.000Z");

describe("Anthropic account usage headers", () => {
  test("discovers windows and carries their encoded lengths in minutes", () => {
    // PROVISIONAL: constructed from the unified header vocabulary observed by
    // NativeHandler. Replace with a complete live claude.ai response-header
    // capture from Phase V before this feature ships.
    const headers = new Headers({
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-5h-utilization": "0.41",
      "anthropic-ratelimit-unified-5h-reset": "1789232400",
      "anthropic-ratelimit-unified-30d-utilization": "92",
      "anthropic-ratelimit-unified-30d-reset": "2026-10-12T12:00:00.000Z",
      "anthropic-ratelimit-unified-representative-claim": "Claude Max",
    });

    const snapshot = snapshotFromAnthropicHeaders(headers, NOW);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.observedAt).toBe(NOW);
    expect(snapshot?.label).toBe("Claude Max");
    expect(snapshot?.windows).toHaveLength(2);
    expect(snapshot?.windows.find((window) => window.slot === "5h")).toEqual({
      slot: "5h",
      displayId: "5h",
      lengthMinutes: 300,
      usedFraction: 0.41,
      resetAt: 1_789_232_400_000,
    });
    expect(snapshot?.windows.find((window) => window.slot === "30d")).toEqual({
      slot: "30d",
      displayId: "30d",
      lengthMinutes: 43_200,
      usedFraction: 0.92,
      resetAt: Date.parse("2026-10-12T12:00:00.000Z"),
    });

    // Mutation caught: hardcode only 5h/7d, or discard the duration encoded by a
    // discovered window name; the 30d row disappears or lacks lengthMinutes.
  });
});
