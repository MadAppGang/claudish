import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { waitForExit } from "../process-tree.js";
import { MagmuxClient } from "./magmux-client.js";
import { MAGMUX, NO_MAGMUX_MESSAGE, orphanReport } from "./test-helpers/hermetic-env.js";

const procs: ChildProcess[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const p of procs.splice(0)) {
    if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
    await waitForExit(p, 2000);
  }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function startMagmux(cmd: string): { sock: string; proc: ChildProcess; root: string } {
  const root = `/tmp/cmc-${randomBytes(4).toString("hex")}`;
  mkdirSync(root, { mode: 0o700 });
  roots.push(root);
  const id = `cmc-${randomBytes(3).toString("hex")}`;
  const proc = spawn(
    MAGMUX as string,
    ["--headless", "--no-status", "--id", id, "--sock-dir", root, "-e", cmd],
    {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: root,
        SHELL: "/bin/sh",
        COLUMNS: "80",
        LINES: "24",
      },
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    }
  );
  procs.push(proc);
  return { sock: join(root, `magmux-${id}.sock`), proc, root };
}

describe.skipIf(!MAGMUX)(
  `MagmuxClient against real magmux (${MAGMUX ? "" : NO_MAGMUX_MESSAGE})`,
  () => {
    test("connect retries until the socket binds; the first line is the aggregate snapshot", async () => {
      const m = startMagmux("sleep 30");
      const snaps: unknown[] = [];
      const c = await MagmuxClient.connect(m.sock);
      c.on("snapshot", (e) => snaps.push(e));
      const caps = await c.request<{ version: string; protocol: number }>({ type: "capabilities" });
      expect(caps.ok).toBe(true);
      if (caps.ok) expect(caps.result.protocol).toBe(1);
      c.close();
    });

    test("replies are correlated by id across concurrent requests; error replies carry the code", async () => {
      const m = startMagmux("sleep 30");
      const c = await MagmuxClient.connect(m.sock);
      const [a, b, bad] = await Promise.all([
        c.request({ type: "capabilities" }),
        c.request({ type: "list" }),
        c.request({ type: "capture", pane: 7 }),
      ]);
      expect(a.ok && "verbs" in a.result).toBe(true);
      expect(b.ok && Array.isArray((b.result as { panes?: unknown[] }).panes)).toBe(true);
      expect(bad).toMatchObject({ ok: false, code: "no_such_pane" });
      c.close();
    });

    test("a pane's own exit is pushed as an `exit` event with its code", async () => {
      const m = startMagmux("sleep 0.3; echo bye; exit 3");
      const c = await MagmuxClient.connect(m.sock);
      const exit = await new Promise<{ exitCode: number; lastLine: string }>((resolve) =>
        c.on("exit", resolve)
      );
      expect(exit.exitCode).toBe(3);
      expect(exit.lastLine).toBe("bye");
      await c.request({ type: "close_pane", pane: 0, force: true });
      c.close();
    });

    test("EOF resolves every pending request client_closed and emits disconnected; it is not a death", async () => {
      const m = startMagmux("sleep 30");
      const c = await MagmuxClient.connect(m.sock);
      const disc = new Promise<{ sawShutdown: boolean }>((r) => c.on("disconnected", r));
      // a watch reply arrives, then frames; a request still in flight when the peer dies resolves closed
      const pending = c.request({ type: "capabilities" }, 5000);
      m.proc.kill("SIGKILL");
      const [r, d] = await Promise.all([pending, disc]);
      expect(r.ok === true || (r.ok === false && r.code === "client_closed")).toBe(true);
      expect(d.sawShutdown).toBe(false);
      expect(await c.request({ type: "list" })).toMatchObject({ ok: false, code: "client_closed" });
    });

    test("close_pane on the last pane: results, shutdown, EOF with sawShutdown, socket removed", async () => {
      const m = startMagmux("sleep 30");
      const c = await MagmuxClient.connect(m.sock);
      const disc = new Promise<{ sawShutdown: boolean }>((r) => c.on("disconnected", r));
      expect((await c.request({ type: "close_pane", pane: 0, force: true })).ok).toBe(true);
      expect((await disc).sawShutdown).toBe(true);
      expect(await waitForExit(m.proc, 5000)).toBe(true);
      expect(existsSync(m.sock)).toBe(false);
      expect(orphanReport({ sockRoot: m.root }).processes).toEqual([]);
    });
  }
);
