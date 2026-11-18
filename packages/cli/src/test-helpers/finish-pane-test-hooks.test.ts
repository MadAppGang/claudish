/**
 * Every `afterEach` that awaits `finishPaneTest` passes `FINISH_PANE_TEST_HOOK_MS`. The helper
 * waits up to `FINISH_PANE_TEST_MS` for the reap, and a hook left on Bun's 5 s default times out
 * inside that wait on a loaded machine ("a beforeEach/afterEach hook timed out for this test"),
 * so a reap that would have finished fails the test instead of printing its leftover list.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FINISH_PANE_TEST_HOOK_MS, FINISH_PANE_TEST_MS } from "./team-pane.js";

const SRC = join(import.meta.dir, "..");

/** Each `afterEach(...)` call in `source`, from its name to its closing parenthesis. */
function afterEachCalls(source: string): string[] {
  const calls: string[] = [];
  for (let at = source.indexOf("afterEach("); at >= 0; at = source.indexOf("afterEach(", at + 1)) {
    let depth = 0;
    for (let i = at + "afterEach".length; i < source.length; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")" && --depth === 0) {
        calls.push(source.slice(at, i + 1));
        break;
      }
    }
  }
  return calls;
}

describe("finishPaneTest hooks", () => {
  test("the hook timeout leaves room for the whole leftover wait", () => {
    expect(FINISH_PANE_TEST_HOOK_MS).toBeGreaterThan(FINISH_PANE_TEST_MS);
  });

  test("every afterEach that awaits finishPaneTest passes FINISH_PANE_TEST_HOOK_MS", () => {
    const files = [...new Bun.Glob("**/*.test.ts").scanSync(SRC)];
    const hooks = files.flatMap((file) =>
      afterEachCalls(readFileSync(join(SRC, file), "utf8"))
        .filter((call) => call.includes("finishPaneTest("))
        .map((call) => ({ file, call }))
    );
    expect(hooks.length).toBeGreaterThanOrEqual(14);
    const missing = hooks
      .filter(({ call }) => !/,\s*FINISH_PANE_TEST_HOOK_MS\s*\)$/.test(call))
      .map(({ file }) => file);
    expect(missing).toEqual([]);
  });
});
