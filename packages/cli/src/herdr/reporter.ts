/**
 * The viewer's herdr front end: the viewer process, the foreground program of its pane, reports the
 * item's state as the pane's agent (source `claudish`, agent `claudish`) and its presentation as
 * metadata (source `claudish:meta`). A foreground report persists for the process's life, and
 * herdr does not detect a bun or claudish foreground as an agent of its own, so nothing competes
 * with it.
 *
 * Reports go out only when what they say changed. `seq` is the clock in microseconds, kept strictly
 * rising, so it also rises across restarts as herdr requires.
 *
 * The reporter subscribes to no herdr event: selecting this pane changes nothing about the session,
 * whose view only Claude Code holds.
 *
 * At the end the agent is released. The pane belongs to the user and is never closed.
 */

import type { ViewItem } from "../pane/view-contract.js";
import type { FrontEnd } from "../view/viewer.js";
import type { HerdrApi } from "./herdr-socket.js";
import { herdrAgentState, herdrMetadata } from "./state-map.js";

export const AGENT_SOURCE = "claudish";
export const META_SOURCE = "claudish:meta";
export const AGENT_NAME = "claudish";
const CLOSE_BOUND_MS = 1_000;

export interface HerdrReporterOptions {
  herdr: HerdrApi;
  /** `$HERDR_PANE_ID` */
  paneId: string;
  titleMode?: "summary" | "model";
  now?: () => number;
}

export class HerdrReporter implements FrontEnd {
  readonly name = "herdr" as const;
  private lastSeq = 0;
  private lastState: string | null = null;
  private lastMeta: string | null = null;
  private closing: Promise<void> | null = null;
  private readonly now: () => number;

  constructor(private readonly o: HerdrReporterOptions) {
    this.now = o.now ?? Date.now;
  }

  report(state: { item: ViewItem | null; ended: boolean }): void {
    const item = state.item;
    if (!item || this.closing) return;
    const agentState = herdrAgentState(item);
    if (agentState !== this.lastState) {
      this.lastState = agentState;
      this.send("pane.report_agent", {
        pane_id: this.o.paneId,
        source: AGENT_SOURCE,
        agent: AGENT_NAME,
        state: agentState,
        seq: this.seq(),
      });
    }
    const meta = herdrMetadata(item, { titleMode: this.o.titleMode });
    const key = JSON.stringify(meta);
    if (key !== this.lastMeta) {
      this.lastMeta = key;
      this.send("pane.report_metadata", {
        pane_id: this.o.paneId,
        source: META_SOURCE,
        agent: AGENT_NAME,
        ...meta,
        seq: this.seq(),
      });
    }
  }

  /** Release the agent. Idempotent, bounded. */
  close(): Promise<void> {
    if (!this.closing) this.closing = this.shutdown();
    return this.closing;
  }

  private async shutdown(): Promise<void> {
    if (this.lastState !== null) {
      const work = this.o.herdr
        .request("pane.release_agent", {
          pane_id: this.o.paneId,
          source: AGENT_SOURCE,
          agent: AGENT_NAME,
          seq: this.seq(),
        })
        .catch(() => {});
      await Promise.race([work, Bun.sleep(CLOSE_BOUND_MS)]);
    }
    this.o.herdr.close();
  }

  /** strictly rising: the clock in microseconds, or one more than the last when that is ahead */
  private seq(): number {
    this.lastSeq = Math.max(this.lastSeq + 1, this.now() * 1000);
    return this.lastSeq;
  }

  private send(method: string, params: Record<string, unknown>): void {
    // a report that does not arrive is replaced by the next one; the picture never waits on herdr
    void this.o.herdr.request(method, params).catch(() => {});
  }
}
