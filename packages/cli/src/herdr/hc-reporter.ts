/**
 * The viewer's herdr-core front end. Inside an hc terminal (`HC_TERMINAL_ID`) the viewer reports
 * the item's state as its own program status: one OSC 7501 line written to its terminal on every
 * row change. hc parses it, keeps it as the terminal's `status`, and Herdr.app shows the terminal
 * as a `claudish` agent. No socket, no hc call: the terminal itself carries the report.
 *
 * A line is written only when it differs from the last one; hc replays the last report to a new
 * viewer of the terminal by itself. At the end the report is cleared (hc also resets it when the
 * program exits).
 */

import type { ViewItem } from "../pane/view-contract.js";
import type { FrontEnd } from "../view/viewer.js";
import { clearOsc7501, encodeOsc7501 } from "./osc7501.js";
import { hcStatus } from "./state-map.js";

export const HC_APP_NAME = "claudish";

export interface HcStatusReporterOptions {
  /** the terminal: the same stream the viewer paints on */
  write: (bytes: string) => void;
  titleMode?: "summary" | "model";
}

export class HcStatusReporter implements FrontEnd {
  readonly name = "herdr-core" as const;
  private last: string | null = null;
  private closed = false;

  constructor(private readonly o: HcStatusReporterOptions) {}

  report(state: { item: ViewItem | null; holding: boolean; ended: boolean }): void {
    if (!state.item || this.closed) return;
    const s = hcStatus(state.item, { titleMode: this.o.titleMode });
    const line = encodeOsc7501({ ...s, app: HC_APP_NAME });
    if (line === this.last) return;
    this.last = line;
    this.o.write(line);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.last !== null) this.o.write(clearOsc7501());
  }
}
