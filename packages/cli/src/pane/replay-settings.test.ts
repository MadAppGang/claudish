/**
 * The `--settings` value a replay pane's Claude Code receives. A replay runs with
 * `--setting-sources ""`, so this object is the only settings source it has: the view
 * must be pinned to fullscreen here, or Claude Code picks the classic view, which ignores
 * the SGR wheel events `scroll_session` sends. The key set is closed so `env` and
 * `apiKeyHelper` can never enter.
 */

import { describe, expect, test } from "bun:test";
import { replaySettingsJson } from "./pane-launch.js";

const statusLine = { type: "command", command: "echo hi", padding: 0 };

describe("replaySettingsJson", () => {
  test("without a statusLine: exactly the wheel and view keys", () => {
    const parsed = JSON.parse(replaySettingsJson(null)) as Record<string, unknown>;
    expect(parsed).toEqual({ wheelScrollAccelerationEnabled: false, tui: "fullscreen" });
    expect(Object.keys(parsed).sort()).toEqual(["tui", "wheelScrollAccelerationEnabled"]);
  });

  test("with a statusLine: the statusLine plus the wheel and view keys", () => {
    const parsed = JSON.parse(replaySettingsJson(statusLine)) as Record<string, unknown>;
    expect(parsed).toEqual({
      statusLine,
      wheelScrollAccelerationEnabled: false,
      tui: "fullscreen",
    });
    expect(Object.keys(parsed).sort()).toEqual([
      "statusLine",
      "tui",
      "wheelScrollAccelerationEnabled",
    ]);
  });

  test("never carries env or apiKeyHelper", () => {
    for (const sl of [null, statusLine]) {
      const parsed = JSON.parse(replaySettingsJson(sl)) as Record<string, unknown>;
      expect(Object.hasOwn(parsed, "env")).toBe(false);
      expect(Object.hasOwn(parsed, "apiKeyHelper")).toBe(false);
    }
  });
});
