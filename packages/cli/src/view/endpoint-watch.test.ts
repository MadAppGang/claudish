import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { type FSWatcher, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EndpointWatch } from "./endpoint-watch.js";
import { endpointNameOf, endpointsDirOf } from "./endpoints.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

/** a watcher that never reports: the event of a change made while it was starting is lost */
function deafWatch(): FSWatcher {
  const w = new EventEmitter() as unknown as FSWatcher;
  (w as unknown as { close: () => void }).close = () => {};
  return w;
}

describe("EndpointWatch", () => {
  test("a server bound while the directory watch was starting is found without waiting for the backstop", async () => {
    const root = mkdtempSync(join(tmpdir(), "ew-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const seen: string[][] = [];
    const watch = new EndpointWatch({
      root,
      backstopMs: 60_000,
      onChange: (names) => seen.push(names),
      watchDir: deafWatch,
    });
    cleanups.push(() => watch.close());
    watch.start();
    const name = endpointNameOf(process.pid, "abc");
    writeFileSync(join(endpointsDirOf(root), name), "");
    const deadline = Date.now() + 3_000;
    while (seen.length === 0 && Date.now() < deadline) await Bun.sleep(20);
    expect(seen).toEqual([[name]]);
  });
});
