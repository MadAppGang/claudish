/**
 * Every `afterEach` that awaits `finishPaneTest` passes `FINISH_PANE_TEST_HOOK_MS`. The helper
 * waits up to `FINISH_PANE_TEST_MS` for the reap, and a hook left on Bun's 5 s default times out
 * inside that wait on a loaded machine ("a beforeEach/afterEach hook timed out for this test"),
 * so a reap that would have finished fails the test instead of printing its leftover list.
 */

import { describe, expect, test } from "bun:test";
import { hooksCalling, hooksWithout } from "./hook-calls.js";
import { FINISH_PANE_TEST_HOOK_MS, FINISH_PANE_TEST_MS } from "./team-pane.js";

describe("finishPaneTest hooks", () => {
  test("the hook timeout leaves room for the whole leftover wait", () => {
    expect(FINISH_PANE_TEST_HOOK_MS).toBeGreaterThan(FINISH_PANE_TEST_MS);
  });

  test("every afterEach that awaits finishPaneTest passes FINISH_PANE_TEST_HOOK_MS", () => {
    const hooks = hooksCalling(["afterEach"], "finishPaneTest(");
    expect(hooks.length).toBeGreaterThanOrEqual(14);
    expect(hooksWithout(hooks, "FINISH_PANE_TEST_HOOK_MS")).toEqual([]);
  });
});
