/**
 * A placer wired to a fake herdr, a hand-driven feed and an in-memory item table. Test-only.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHerdr } from "../../pane/test-helpers/fake-herdr.js";
import type { ViewItem } from "../../pane/view-contract.js";
import type { ViewFeedEvent } from "../../view/view-feed.js";
import { HerdrSocket } from "../herdr-socket.js";
import { PlacementGrants } from "../placement-grants.js";
import { HerdrPlacer, type PlacerOptions } from "../placer.js";

export class HandFeed {
  private readonly listeners = new Set<(e: ViewFeedEvent) => void>();
  subscribe(fn: (e: ViewFeedEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(e: ViewFeedEvent): void {
    for (const l of this.listeners) l(e);
  }
}

export function sessionItem(
  id: string,
  o: { state?: string; viewSocket?: string | null; model?: string } = {}
): ViewItem {
  return {
    kind: "session",
    target: `s:${id}`,
    session_id: id,
    slot: id,
    model: o.model ?? "cx@gpt-6",
    provider: null,
    state: o.state ?? "RUNNING",
    reason: null,
    reason_detail: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    tool_calls: 0,
    turns_completed: 0,
    last_activity_at: null,
    idle_seconds: null,
    activity: null,
    pane: null,
    recent: null,
    agent_requested: null,
    agent: null,
    view: null,
    started_at: "2026-11-10T00:00:00.000Z",
    completed_at: null,
    elapsed_seconds: 0,
    prompt_summary: "say hi",
    prompts_sent: 1,
    pending_inputs: 0,
    subagents: [],
    magmux: {
      pane_id: `c1-${id}`,
      view_socket: o.viewSocket === undefined ? `/tmp/magmux-${id}.view` : o.viewSocket,
    },
  } as ViewItem;
}

export function replayItem(id: string, final = false): ViewItem {
  return {
    kind: "replay",
    target: `r:${id}`,
    replay_id: id,
    of: { session_id: "s" },
    model: "cx@gpt-6",
    final,
    magmux: { pane_id: `c1-${id}`, view_socket: `/tmp/magmux-${id}.view` },
    view: null,
    herdr_workspaces: [],
  };
}

export interface Harness {
  fake: FakeHerdr;
  feed: HandFeed;
  items: Map<string, ViewItem>;
  grants: PlacementGrants;
  placer: HerdrPlacer;
  userPane: string;
  userTab: string;
  root: string;
  logs: string[];
  tokens: string[];
  /** set the item and emit its upsert */
  upsert(item: ViewItem): void;
  /** another placer on the same fake, workspace and grants: a second opener */
  second(o?: Partial<PlacerOptions>): Promise<HerdrPlacer>;
  stop(): Promise<void>;
}

export async function startHarness(
  o: Partial<PlacerOptions> & { timeoutMs?: number } = {}
): Promise<Harness> {
  const fake = await FakeHerdr.start();
  const { paneId: userPane, tabId: userTab } = fake.addWorkspace("w1");
  const feed = new HandFeed();
  const items = new Map<string, ViewItem>();
  const grants = (o.grants as PlacementGrants | undefined) ?? new PlacementGrants();
  const root = mkdtempSync(join(tmpdir(), "placer-root-"));
  const logs: string[] = [];
  const tokens: string[] = [];
  let n = 0;
  const made: HerdrPlacer[] = [];
  const build = async (extra: Partial<PlacerOptions> = {}): Promise<HerdrPlacer> => {
    const placer = new HerdrPlacer({
      herdr: new HerdrSocket(fake.path, o.timeoutMs ?? 250),
      pane: { socketPath: fake.path, paneId: userPane, workspaceId: "w1" },
      root,
      feed,
      item: (t) => items.get(t) ?? null,
      grants,
      endpoint: () => ({ name: "c1-abc.sock", path: `${root}/endpoints/c1-abc.sock` }),
      command: (t) => ["/usr/bin/claudish", "view", t, "--passive", "--front-end", "herdr"],
      env: { CLAUDISH_PANE_ROOT: root },
      cwd: "/tmp",
      graceMs: 200,
      cleanupRetryMs: 50,
      token: () => {
        n += 1;
        const t = n.toString(16).padStart(8, "0");
        tokens.push(t);
        return t;
      },
      log: (l) => logs.push(l),
      ...o,
      ...extra,
    });
    await placer.start();
    made.push(placer);
    return placer;
  };
  const placer = await build();
  return {
    fake,
    feed,
    items,
    grants,
    placer,
    userPane,
    userTab,
    root,
    logs,
    tokens,
    upsert(item) {
      items.set(item.target, item);
      feed.emit({ event: "upsert", item });
    },
    second: (extra) => build(extra),
    async stop() {
      for (const p of made) await p.shutdown();
      await fake.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Polls until `check` passes or `ms` runs out; the last failure is thrown. */
export async function eventually(check: () => void, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      check();
      return;
    } catch (e) {
      if (Date.now() > deadline) throw e;
    }
    await Bun.sleep(20);
  }
}
