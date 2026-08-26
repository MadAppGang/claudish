import { describe, expect, test } from "bun:test";
import { translateLine } from "./event-translator.js";
import {
  FIXTURE_EFFORT_HIGH_DEFAULT_STDOUT,
  FIXTURE_EFFORT_ULTRACODE_STDOUT,
  FIXTURE_ULTRA_EFFORT_ENTER,
  FIXTURE_ULTRA_EFFORT_EXIT,
} from "./test-fixtures.js";

describe("translateLine", () => {
  test("real ultra_effort_enter attachment → ultra_effort_enter event", () => {
    expect(translateLine(FIXTURE_ULTRA_EFFORT_ENTER)).toEqual({
      kind: "ultra_effort_enter",
      at: "2026-07-13T13:31:08.930Z",
    });
  });

  test("real ultra_effort_exit attachment → ultra_effort_exit event", () => {
    expect(translateLine(FIXTURE_ULTRA_EFFORT_EXIT)).toEqual({
      kind: "ultra_effort_exit",
      at: "2026-07-13T13:31:32.054Z",
    });
  });

  test("real '/effort ultracode' stdout line → effort_changed (session scope)", () => {
    expect(translateLine(FIXTURE_EFFORT_ULTRACODE_STDOUT)).toEqual({
      kind: "effort_changed",
      level: "ultracode",
      scope: "session",
      at: "2026-07-13T13:31:05.055Z",
    });
  });

  test("real '/effort high' saved-as-default stdout line → effort_changed (default scope)", () => {
    expect(translateLine(FIXTURE_EFFORT_HIGH_DEFAULT_STDOUT)).toEqual({
      kind: "effort_changed",
      level: "high",
      scope: "default",
      at: "2026-07-13T13:31:26.234Z",
    });
  });

  test("malformed line → null; unrecognized attachment type → unknown passthrough", () => {
    expect(translateLine("not json {")).toBeNull();
    expect(translateLine('"just a string"')).toBeNull();
    // Derived from the real enter line — only the attachment type differs
    // (forward-compat: future harness events must flow through as `unknown`).
    const future = FIXTURE_ULTRA_EFFORT_ENTER.replace("ultra_effort_enter", "model_switch");
    expect(translateLine(future)).toMatchObject({
      kind: "unknown",
      attachmentType: "model_switch",
    });
  });
});
