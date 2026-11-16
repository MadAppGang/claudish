import { afterEach, describe, expect, test } from "bun:test";
import { FakeHerdr } from "../pane/test-helpers/fake-herdr.js";
import type { ViewItem } from "../pane/view-contract.js";
import { HerdrSocket } from "./herdr-socket.js";
import { AGENT_NAME, AGENT_SOURCE, HerdrReporter, META_SOURCE } from "./reporter.js";
import { eventually, sessionItem } from "./test-helpers/view-items.js";

let fake: FakeHerdr | null = null;
afterEach(async () => {
  await fake?.stop();
  fake = null;
});

async function setup() {
  fake = await FakeHerdr.start();
  const { paneId } = fake.addWorkspace("w1");
  const reporter = new HerdrReporter({
    herdr: new HerdrSocket(fake.path, 500),
    paneId,
    now: () => 1_000,
  });
  return { fake, paneId, reporter };
}

const running = (o: Record<string, unknown> = {}): ViewItem =>
  ({ ...sessionItem("a"), activity: "Bash", ...o }) as ViewItem;

describe("HerdrReporter", () => {
  test("reports state and metadata, only when they change, with a rising seq", async () => {
    const { fake: f, paneId, reporter } = await setup();
    reporter.report({ item: running(), ended: false });
    reporter.report({ item: running(), ended: false });
    reporter.report({
      item: running({ state: "AWAITING_INPUT", activity: null }),
      ended: false,
    });
    await eventually(() => expect(f.callsOf("pane.report_agent")).toHaveLength(2));
    await eventually(() => expect(f.callsOf("pane.report_metadata")).toHaveLength(2));
    const agents = f.callsOf("pane.report_agent").map((c) => c.params);
    expect(agents.map((a) => a.state)).toEqual(["working", "idle"]);
    expect(agents[0]).toMatchObject({ pane_id: paneId, source: AGENT_SOURCE, agent: AGENT_NAME });
    const meta = f.callsOf("pane.report_metadata")[0]?.params;
    expect(meta).toMatchObject({ source: META_SOURCE, display_agent: "claudish · gpt-6" });
    const seqs = [...f.callsOf("pane.report_agent"), ...f.callsOf("pane.report_metadata")]
      .map((c) => c.params.seq as number)
      .sort((a, b) => a - b);
    expect(new Set(seqs).size).toBe(seqs.length);
    await reporter.close();
  });

  test("a viewer releases the agent once and never closes the pane it runs in", async () => {
    const { fake: f, paneId, reporter } = await setup();
    reporter.report({ item: running(), ended: false });
    await eventually(() => expect(f.callsOf("pane.report_agent")).toHaveLength(1));
    await reporter.close();
    await reporter.close();
    expect(f.callsOf("pane.release_agent")).toHaveLength(1);
    expect(f.callsOf("pane.close")).toHaveLength(0);
    expect(f.panes.has(paneId)).toBe(true);
  });

  test("reports and releases without subscribing to any herdr event: focusing the pane changes nothing", async () => {
    const { fake: f, paneId, reporter } = await setup();
    reporter.report({ item: running(), ended: false });
    await eventually(() => expect(f.callsOf("pane.report_agent")).toHaveLength(1));
    f.emitForTest("pane_focused", { pane_id: paneId, workspace_id: "w1" });
    await Bun.sleep(50);
    await reporter.close();
    expect(f.callsOf("events.subscribe")).toHaveLength(0);
    expect(f.callsOf("pane.report_agent")).toHaveLength(1);
  });
});
