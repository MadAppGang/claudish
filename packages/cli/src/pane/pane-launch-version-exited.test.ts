/**
 * The `--version` deadline bounds a child that is still running. A child that already exited
 * is settled by the exit path (its output drain), never refused by the deadline: under CPU load
 * the exit can be seen just before the deadline, and the deadline then refused a magmux that
 * exited 0, skipping the empty-output retry in `versionOf`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runMagmuxVersion } from "./pane-launch.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function fake(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pane-launch-version-exited-"));
  dirs.push(dir);
  const binary = join(dir, "magmux");
  writeFileSync(binary, `#!/bin/sh\n${body}\n`);
  chmodSync(binary, 0o755);
  return binary;
}

describe("magmux --version deadline after the child exited", () => {
  test("an exit seen before the deadline settles through the drain, not as no answer", async () => {
    // exits at once with no output; the deadline (300 ms) falls inside the drain (1000 ms)
    const binary = fake("exit 0");
    const outcome = await runMagmuxVersion(binary, 300, 1_000).then(
      (out) => ({ ok: true as const, out }),
      (e: Error) => ({ ok: false as const, message: e.message })
    );
    expect(outcome).toEqual({ ok: true, out: "" });
  });

  test("an exit 0 whose exit event never arrives answers empty, so versionOf asks again", async () => {
    // the child is reaped (exitCode 0) but neither its output nor its exit event is delivered;
    // a refusal here would skip the retry in versionOf and refuse a magmux that works
    const child = Object.assign(new EventEmitter(), {
      exitCode: 0,
      signalCode: null,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    const spawnChild = (() => child) as unknown as typeof spawn;
    const outcome = await runMagmuxVersion("/fake/magmux", 300, 50, spawnChild).then(
      (out) => ({ ok: true as const, out }),
      (e: Error) => ({ ok: false as const, message: e.message })
    );
    expect(outcome).toEqual({ ok: true, out: "" });
  });

  test("a non-zero exit whose exit event never arrives is still refused", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: 3,
      signalCode: null,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    const spawnChild = (() => child) as unknown as typeof spawn;
    await expect(runMagmuxVersion("/fake/magmux", 300, 50, spawnChild)).rejects.toThrow(
      /exited \(3\) but no exit event/
    );
  });

  test("a child still running at the deadline is refused as no answer", async () => {
    const binary = fake("exec /bin/sleep 5");
    await expect(runMagmuxVersion(binary, 300, 1_000)).rejects.toThrow(
      /no answer in 300 ms .*child still running/
    );
  });
});
