/**
 * Every `afterEach` that disposes gate panes passes `DISPOSE_GATE_PANES_HOOK_MS`. One disposal
 * awaits the pane's reap and then polls up to `WAIT_NO_ORPHANS_MS` for leftovers, and a hook
 * left on Bun's 5 s default times out inside that wait on a loaded machine ("a
 * beforeEach/afterEach hook timed out for this test") while the disposal keeps running under
 * the next test.
 */

import { describe, expect, test } from "bun:test";
import { DISPOSE_GATE_PANES_HOOK_MS } from "../pane/test-helpers/gated-pane.js";
import { WAIT_NO_ORPHANS_MS } from "../pane/test-helpers/hermetic-env.js";
import { hooksCalling, hooksWithout } from "./hook-calls.js";

describe("disposeGatePanes hooks", () => {
  test("the hook timeout leaves room for the whole leftover wait", () => {
    expect(DISPOSE_GATE_PANES_HOOK_MS).toBeGreaterThan(WAIT_NO_ORPHANS_MS);
  });

  test("every afterEach that disposes gate panes passes DISPOSE_GATE_PANES_HOOK_MS", () => {
    const hooks = hooksCalling(["afterEach"], "disposeGatePane");
    expect(hooks.length).toBeGreaterThanOrEqual(6);
    expect(hooksWithout(hooks, "DISPOSE_GATE_PANES_HOOK_MS")).toEqual([]);
  });
});
