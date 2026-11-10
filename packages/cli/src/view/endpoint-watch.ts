/**
 * Discovery of claudish MCP servers for a long-lived client: the names in `<root>/endpoints/`,
 * followed with `fs.watch`, read again on every event and once a minute as a backstop.
 *
 * The last server to shut down removes the empty directory, which ends a watch on it; so the
 * directory is created again (0700) and the watch re-armed whenever it is missing or replaced.
 */

import { type FSWatcher, statSync, watch } from "node:fs";
import { ensurePrivateSubdir } from "../pane/pane-launch.js";
import { ENDPOINTS_DIR, endpointsDirOf, listEndpoints } from "./endpoints.js";

export const ENDPOINT_BACKSTOP_MS = 60_000;
/** a burst of events (bind, then chmod) is read once */
const SETTLE_MS = 50;

export interface EndpointWatchOptions {
  root: string;
  /** every endpoint file name present now, called only when the set changed */
  onChange: (names: string[]) => void;
  backstopMs?: number;
}

export class EndpointWatch {
  private watcher: FSWatcher | null = null;
  private watchedIno: number | null = null;
  private backstop: ReturnType<typeof setInterval> | null = null;
  private settle: ReturnType<typeof setTimeout> | null = null;
  private last = "";
  private closed = false;

  constructor(private readonly o: EndpointWatchOptions) {}

  start(): void {
    this.arm();
    // the backstop reports even an unchanged set: a server whose first dial failed is tried again
    this.backstop = setInterval(() => this.rescan(true), this.o.backstopMs ?? ENDPOINT_BACKSTOP_MS);
    this.backstop.unref?.();
    this.rescan();
  }

  /**
   * Read the directory now; `onChange` fires when the set of names differs from the last read, or
   * on every call with `always`.
   */
  rescan(always = false): void {
    if (this.closed) return;
    if (this.watchedIno === null || this.dirIno() !== this.watchedIno) this.arm();
    const names = listEndpoints(this.o.root).sort();
    const key = names.join("\n");
    if (key === this.last && !always) return;
    this.last = key;
    this.o.onChange(names);
  }

  close(): void {
    this.closed = true;
    this.watcher?.close();
    this.watcher = null;
    if (this.backstop) clearInterval(this.backstop);
    if (this.settle) clearTimeout(this.settle);
  }

  private dirIno(): number | null {
    try {
      return statSync(endpointsDirOf(this.o.root)).ino;
    } catch {
      return null;
    }
  }

  private arm(): void {
    this.watcher?.close();
    this.watcher = null;
    try {
      ensurePrivateSubdir(this.o.root, ENDPOINTS_DIR);
      const w = watch(endpointsDirOf(this.o.root), () => this.soon());
      w.on("error", () => this.soon());
      this.watcher = w;
      this.watchedIno = this.dirIno();
    } catch {
      // the root is unusable right now; the backstop tries again
      this.watchedIno = null;
    }
  }

  private soon(): void {
    if (this.settle || this.closed) return;
    this.settle = setTimeout(() => {
      this.settle = null;
      this.rescan();
    }, SETTLE_MS);
  }
}
