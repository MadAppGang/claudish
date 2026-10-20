// REGRESSION: The probe proxy startup status remained after the proxy was ready — /dev:fix session dev-fix-20261020-235500-vtx01
import { describe, expect, test } from "bun:test";
import { nextStatusAfterProbeReady } from "./App.js";

describe("nextStatusAfterProbeReady", () => {
  test("clears the exact proxy startup status", () => {
    expect(nextStatusAfterProbeReady("Starting probe proxy…")).toBeNull();
  });

  test("preserves a newer status message", () => {
    expect(nextStatusAfterProbeReady("Project saved.")).toBe("Project saved.");
  });

  test("preserves a similar but different status message", () => {
    expect(nextStatusAfterProbeReady("Starting probe proxy… failed")).toBe(
      "Starting probe proxy… failed"
    );
  });

  test("leaves an empty status unchanged", () => {
    expect(nextStatusAfterProbeReady(null)).toBeNull();
  });
});
