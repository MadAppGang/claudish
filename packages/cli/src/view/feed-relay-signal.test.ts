/**
 * `claudish view --feed` run as the real CLI: on SIGTERM the relay removes its file before the
 * process exits. `stats-buffer.ts` exits on SIGTERM at once unless a command claims the exit, so
 * an unclaimed relay left a file whose stamp named a dead process.
 */
import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { defaultFeedPath } from "./feed-relay.js";
import { makeViewRoot } from "./test-helpers/fake-view-endpoint.js";

const CLI = join(import.meta.dir, "..", "index.ts");
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

test("SIGTERM: the relay removes its feed file, then exits", async () => {
  const root = `/tmp/cfs-${randomBytes(4).toString("hex")}`;
  makeViewRoot(root);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const relay = Bun.spawn([process.execPath, CLI, "view", "--feed"], {
    env: { ...process.env, CLAUDISH_PANE_ROOT: root },
    stdout: "pipe",
    stderr: "pipe",
  });
  cleanups.push(() => relay.kill("SIGKILL"));
  const file = defaultFeedPath(root);
  const end = Date.now() + 15_000;
  while (!existsSync(file)) {
    if (Date.now() > end) throw new Error("the relay wrote no file in 15 s");
    await Bun.sleep(50);
  }
  relay.kill("SIGTERM");
  await relay.exited;
  expect(existsSync(file)).toBe(false);
}, 30_000);
