/**
 * Watches a child's token file, the source of a row's cost and token totals. The proxy rewrites it
 * outside the pane's own change signals, so without this a row's cost goes stale between
 * transitions. The directory is watched because the file may not exist yet and may be replaced.
 */

import { type FSWatcher, watch } from "node:fs";
import { basename, dirname } from "node:path";
import { log } from "../logger.js";

/** Returns a function that stops watching. A directory that cannot be watched only logs. */
export function watchTokenFile(path: string, onChange: () => void): () => void {
  const name = basename(path);
  let watcher: FSWatcher;
  try {
    watcher = watch(dirname(path), (_event, changed) => {
      if (changed === name) onChange();
    });
  } catch (e) {
    log(`[view] token file not watched: ${e instanceof Error ? e.message : String(e)}`);
    return () => {};
  }
  watcher.on("error", () => {});
  watcher.unref?.();
  return () => {
    try {
      watcher.close();
    } catch {
      // already closed
    }
  };
}
