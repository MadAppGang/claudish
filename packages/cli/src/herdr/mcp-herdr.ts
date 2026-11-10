/**
 * The MCP server's herdr adapter, built only when the server runs in a herdr pane. Outside herdr
 * this returns null before anything dials a socket, so no herdr call is ever made there.
 */

import type { ViewItem } from "../pane/view-contract.js";
import type { ViewFeedEvent } from "../view/view-feed.js";
import { herdrPaneEnv } from "./front-end.js";
import { HerdrSocket } from "./herdr-socket.js";
import type { PlacementGrants } from "./placement-grants.js";
import { HerdrPlacer } from "./placer.js";
import { selfArgv } from "./self-argv.js";

/** Variables a placed viewer needs from this server: a herdr pane inherits herdr's environment. */
const PASSED_TO_VIEWER = [
  "CLAUDISH_PANE_ROOT",
  "CLAUDISH_BIN",
  "CLAUDISH_HERDR_TITLE",
  "CLAUDISH_VIEW_FOCUS_CLAIM",
  "CLAUDISH_HERDR",
] as const;

export interface McpHerdrDeps {
  env: Readonly<Record<string, string | undefined>>;
  root: string;
  feed: { subscribe(fn: (e: ViewFeedEvent) => void): () => void };
  item: (target: string) => ViewItem | null;
  grants: PlacementGrants;
  endpoint: () => { name: string; path: string } | null;
  cwd: string;
  log: (line: string) => void;
}

/** The started placer, or null outside a herdr pane. A herdr that does not answer logs one line. */
export async function startMcpHerdrPlacer(deps: McpHerdrDeps): Promise<HerdrPlacer | null> {
  const pane = herdrPaneEnv(deps.env);
  if (!pane) return null;
  const self = selfArgv({ env: deps.env });
  const env: Record<string, string> = {};
  for (const k of PASSED_TO_VIEWER) {
    const v = deps.env[k];
    if (v) env[k] = v;
  }
  const placer = new HerdrPlacer({
    herdr: new HerdrSocket(pane.socketPath),
    pane,
    root: deps.root,
    feed: deps.feed,
    item: deps.item,
    grants: deps.grants,
    endpoint: deps.endpoint,
    command: (target) => [...self, "view", target, "--passive", "--front-end", "herdr"],
    env,
    cwd: deps.cwd,
    log: deps.log,
  });
  try {
    await placer.start();
  } catch (e) {
    deps.log(`[herdr] placer off: ${e instanceof Error ? e.message : String(e)}`);
    await placer.shutdown();
    return null;
  }
  return placer;
}
