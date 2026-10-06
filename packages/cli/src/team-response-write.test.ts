/**
 * A slot whose response file cannot be written still ends with its terminal row in
 * status.json (the write failure goes to the slot's error log), instead of keeping its
 * last non-terminal state forever while `run` says SETTLED.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getStatus, setupSession, startModels } from "./team-orchestrator.js";
import {
  MAGMUX,
  NO_MAGMUX_MESSAGE,
  type PaneTestEnv,
  finishPaneTest,
  makePaneTestEnv,
  paneRunOptions,
  teamDirOf,
} from "./test-helpers/team-pane.js";

if (!MAGMUX) console.warn(NO_MAGMUX_MESSAGE);

let t: PaneTestEnv;

beforeEach(() => {
  t = makePaneTestEnv();
});

afterEach(async () => {
  const report = await finishPaneTest(t);
  expect(report).toEqual({ processes: [], files: [] });
});

describe.skipIf(!MAGMUX)("team response file", () => {
  it("an unwritable response file: the slot still ends COMPLETED in status.json", async () => {
    const sessionPath = teamDirOf(t);
    const manifest = setupSession(sessionPath, ["fake-answer"], "Answer.");
    const slotId = Object.keys(manifest.models)[0] as string;
    mkdirSync(join(sessionPath, `response-${slotId}.md`)); // writing it now fails (EISDIR)
    const handle = await startModels(sessionPath, paneRunOptions(t));
    const status = await handle.done;
    expect(status.models[slotId]?.state).toBe("COMPLETED");
    expect(getStatus(sessionPath).models[slotId]?.state).toBe("COMPLETED");
    expect(readFileSync(join(sessionPath, "errors", `${slotId}.log`), "utf8")).toContain(
      "response file not written"
    );
  }, 30_000);
});
