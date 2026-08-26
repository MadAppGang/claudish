import { describe, expect, test } from "bun:test";
import { translateLine } from "./event-translator.js";
import { initialState, reduceEvent } from "./session-state.js";
import {
  FIXTURE_EFFORT_HIGH_DEFAULT_STDOUT,
  FIXTURE_EFFORT_ULTRACODE_STDOUT,
  FIXTURE_ULTRA_EFFORT_ENTER,
  FIXTURE_ULTRA_EFFORT_EXIT,
} from "./test-fixtures.js";

// Events derived from the real captured transcript lines.
const enterEvent = translateLine(FIXTURE_ULTRA_EFFORT_ENTER)!;
const exitEvent = translateLine(FIXTURE_ULTRA_EFFORT_EXIT)!;
const ultracodeChanged = translateLine(FIXTURE_EFFORT_ULTRACODE_STDOUT)!;
const highDefaultChanged = translateLine(FIXTURE_EFFORT_HIGH_DEFAULT_STDOUT)!;

describe("session-state reducer", () => {
  test("ultra_effort_enter sets ultracodeActive", () => {
    const state = reduceEvent(initialState(), enterEvent);
    expect(state.ultracodeActive).toBe(true);
    expect(state.lastEventAt).toBe("2026-07-13T13:31:08.930Z");
  });

  test("ultra_effort_exit clears ultracodeActive", () => {
    const state = reduceEvent(reduceEvent(initialState(), enterEvent), exitEvent);
    expect(state.ultracodeActive).toBe(false);
  });

  test("effort_changed(ultracode) pre-arms ultracodeActive; any other level clears it", () => {
    const armed = reduceEvent(initialState(), ultracodeChanged);
    expect(armed.ultracodeActive).toBe(true);
    expect(armed.effort).toBe("ultracode");
    const cleared = reduceEvent(armed, highDefaultChanged);
    expect(cleared.ultracodeActive).toBe(false);
    expect(cleared.effort).toBe("high");
  });

  test("default-scope change updates defaultEffort; settings seed populates initial state", () => {
    const seeded = initialState({ defaultEffort: "medium" });
    expect(seeded).toMatchObject({
      ultracodeActive: false,
      effort: "medium",
      defaultEffort: "medium",
      seededFrom: "settings",
    });
    const state = reduceEvent(seeded, highDefaultChanged);
    expect(state.defaultEffort).toBe("high");
    expect(state.effortScope).toBe("default");
  });
});
