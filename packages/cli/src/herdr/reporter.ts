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
 * Selecting this pane in herdr is a user act: a `pane_focused` event for `$HERDR_PANE_ID` takes the
 * view, unless `CLAUDISH_VIEW_FOCUS_CLAIM=0`.
 *
 * At the end the agent is released, and a pane the placer created is closed by its own viewer, so
 * a SIGKILLed MCP server leaves no pane behind. A pane the user started is never closed.
 */

import type { ViewItem } from "../pane/view-contract.js";
import type { FrontEnd, FrontEndHooks } from "../view/viewer.js";
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
  /** this pane was created by a placer: close it on exit */
  placed: boolean;
  titleMode?: "summary" | "model";
  /** claim the view when the user selects this pane (default true) */
  focusClaim?: boolean;
  now?: () => number;
}

export class HerdrReporter implements FrontEnd {
  readonly name = "herdr" as const;
  private lastSeq = 0;
  private lastState: string | null = null;
  private lastMeta: string | null = null;
  private stopFocus: (() => void) | null = null;
  private closing: Promise<void> | null = null;
  private readonly now: () => number;

  constructor(private readonly o: HerdrReporterOptions) {
    this.now = o.now ?? Date.now;
  }

  attach(hooks: FrontEndHooks): void {
    if (this.o.focusClaim === false || this.stopFocus) return;
    this.stopFocus = this.o.herdr.subscribe(
      ["pane.focused"],
      (e) => {
        if (e.event === "pane_focused" && e.data.pane_id === this.o.paneId) hooks.take();
      },
      () => {}
    );
  }

  report(state: { item: ViewItem | null; holding: boolean; ended: boolean }): void {
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

  /** Release the agent; close the pane if it was placed. Idempotent, bounded. */
  close(): Promise<void> {
    if (!this.closing) this.closing = this.shutdown();
    return this.closing;
  }

  private async shutdown(): Promise<void> {
    this.stopFocus?.();
    this.stopFocus = null;
    const work = (async () => {
      if (this.lastState !== null)
        await this.o.herdr
          .request("pane.release_agent", {
            pane_id: this.o.paneId,
            source: AGENT_SOURCE,
            agent: AGENT_NAME,
            seq: this.seq(),
          })
          .catch(() => {});
      if (this.o.placed)
        await this.o.herdr.request("pane.close", { pane_id: this.o.paneId }).catch(() => {});
    })();
    await Promise.race([work, Bun.sleep(CLOSE_BOUND_MS)]);
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
