import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { flockAvailable, tryAcquire } from "./kernel-lock.js";
import { ReplayRegistry } from "./replay-registry.js";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe.skipIf(!flockAvailable())("ReplayRegistry.sweep", () => {
  test("a .tmp left by a writer that died while the sweep waited is removed by that sweep", async () => {
    const root = `/tmp/cpt-${randomBytes(4).toString("hex")}`;
    roots.push(root);
    const registry = new ReplayRegistry(root);
    const dir = registry.ensure();
    // a free replay lock: the sweep's loop waits for registry.lock to remove its entry
    const uuid = randomUUID();
    tryAcquire(registry.lockPathOf(uuid))?.close();
    const editor = tryAcquire(join(dir, "registry.lock"));
    if (!editor) throw new Error("registry.lock was held");
    const sweeping = registry.sweep();
    await Bun.sleep(100);
    // a writer killed between its write and its rename, after the sweep listed the directory
    const tmp = join(dir, `${uuid}.json.deadbeef.tmp`);
    writeFileSync(tmp, "{}\n", { mode: 0o600 });
    editor.close();
    expect(await sweeping).toEqual([uuid]);
    expect(existsSync(tmp)).toBe(false);
  });
});
