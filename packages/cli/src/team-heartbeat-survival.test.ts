/**
 * NO SLOT IS EVER KILLED ON A TIMER once its prompt is accepted (D10,
 * team-lifecycle.md). A slot inside a long silent tool call, and a slot whose Stop hook
 * runs for a long time after its answer, both settle on Claude Code's own end-of-turn
 * record with their answer intact — and report what they are doing meanwhile.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runModels, setupSession, startModels, teamLiveMaps } from "./team-orchestrator.js";
import {
  MAGMUX,
  NO_MAGMUX_MESSAGE,
  type PaneTestEnv,
  finishPaneTest,
  makePaneTestEnv,
  paneRunOptions,
  teamDirOf,
  waitUntil,
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

describe.skipIf(!MAGMUX)("team slot heartbeat survival", () => {
  it("keeps a slot alive through a silent tool call and reports activity Bash", async () => {
    const sessionPath = teamDirOf(t);
    setupSession(sessionPath, ["fake-tool_slow"], "Run the long tool call.");

    const startedAt = Date.now();
    const handle = await startModels(
      sessionPath,
      paneRunOptions(t, {}, { FAKE_GAP_MS_TOOL: "3000" })
    );
    const slotId = handle.slots["fake-tool_slow"] as string;
    const seen = new Set<string>();
    let maxIdle = 0;
    const watch = setInterval(() => {
      const live = teamLiveMaps(sessionPath);
      if (live?.activity[slotId]) seen.add(live.activity[slotId] as string);
      maxIdle = Math.max(maxIdle, live?.idle[slotId] ?? 0);
    }, 100);
    const status = await handle.done;
    clearInterval(watch);
    const elapsedMs = Date.now() - startedAt;
    const model = status.models[slotId];
    const response = readFileSync(join(sessionPath, `response-${slotId}.md`), "utf-8");

    expect(elapsedMs).toBeGreaterThanOrEqual(3000);
    expect(seen.has("Bash")).toBe(true);
    expect(maxIdle).toBeGreaterThanOrEqual(1);
    expect(model?.state).toBe("COMPLETED");
    expect(model?.error).toBeUndefined();
    expect(response).toStartWith("ANSWER fake-tool_slow ");
    expect(response.split("ANSWER")).toHaveLength(2);
  }, 30_000);

  it("waits out a slow Stop hook after the answer, reading finishing meanwhile", async () => {
    const sessionPath = teamDirOf(t);
    setupSession(sessionPath, ["fake-slow_stop_hook"], "Answer, then let the hook run.");

    const handle = await startModels(
      sessionPath,
      paneRunOptions(t, {}, { FAKE_GAP_MS_HOOK: "3000" })
    );
    const slotId = handle.slots["fake-slow_stop_hook"] as string;
    await waitUntil(
      () => teamLiveMaps(sessionPath)?.activity[slotId] === "finishing",
      "activity finishing",
      5_000
    );
    const status = await handle.done;

    expect(status.models[slotId]?.state).toBe("COMPLETED");
    expect(readFileSync(join(sessionPath, `response-${slotId}.md`), "utf-8")).toStartWith(
      "ANSWER fake-slow_stop_hook "
    );
  }, 30_000);

  it("runModels resolves with the settled status of a quick slot", async () => {
    const sessionPath = teamDirOf(t);
    setupSession(sessionPath, ["fake-answer"], "Reply with exactly PEAR");
    const status = await runModels(sessionPath, paneRunOptions(t));
    expect(Object.values(status.models).map((m) => m.state)).toEqual(["COMPLETED"]);
  }, 30_000);
});
