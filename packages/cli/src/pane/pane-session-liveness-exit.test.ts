/**
 * A liveness exit (ESRCH while the magmux socket is down) asks magmux for the exit code before
 * finishing, bounded, and finishes without a code when magmux cannot answer.
 *
 * The session is never started: no client is attached, which is the disconnected state, and
 * `magmux` stays null, so no redial runs beside the query. magmux itself is a small unix-socket
 * server speaking its NDJSON `list` reply.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PaneSessionImpl, type PaneSessionOptions } from "./pane-session.js";

type ListAnswer = "dead-with-code" | "silent";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** A pid that existed and is gone: spawned, exited and reaped by this process. */
async function deadPid(): Promise<number> {
  const child = spawn("true");
  await new Promise((resolve) => child.once("exit", resolve));
  return child.pid!;
}

function fakeMagmux(sockPath: string, answer: ListAnswer, exitCode: number): void {
  const server = Bun.listen({
    unix: sockPath,
    socket: {
      data(socket, data) {
        for (const line of data.toString().split("\n").filter(Boolean)) {
          const msg = JSON.parse(line) as { id: string; type: string };
          if (answer === "silent" || msg.type !== "list") continue;
          socket.write(
            `${JSON.stringify({
              type: "reply",
              id: msg.id,
              ok: true,
              result: { panes: [{ pane: 0, pid: 1, dead: true, exitCode }] },
            })}\n`
          );
        }
      },
    },
  });
  cleanups.push(() => server.stop(true));
}

function session(): { session: PaneSessionImpl; sockPath: string } {
  // A short root: a unix socket path is limited to ~104 bytes on macOS.
  const root = mkdtempSync("/tmp/plx-");
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  const ctlDir = join(root, "launch-ctl000");
  const turnDir = join(root, "launch-turn00");
  for (const dir of [configDir, ctlDir, turnDir]) mkdirSync(dir);
  const opts: PaneSessionOptions = {
    kind: "s",
    label: "liveness-exit-test",
    callerFlags: [],
    spawnModel: "liveness-exit-test",
    cwd: root,
    sessionUuid: crypto.randomUUID(),
    transcriptPath: join(root, "transcript.jsonl"),
    slotEnv: {},
    shape: "interactive",
    readAvailable: true,
    parentEnv: { HOME: root, CLAUDE_CONFIG_DIR: configDir },
    decide: () => "continue",
    onBlocked: () => "wait",
  };
  const sockPath = join(root, "m.sock");
  const s = new PaneSessionImpl(opts, { paneId: "liveness", sockPath, root, ctlDir, turnDir });
  cleanups.push(async () => {
    (s as any).reapPromise = Promise.resolve();
    await s.shutdownReap("liveness test cleanup");
  });
  return { session: s, sockPath };
}

async function livenessExit(s: PaneSessionImpl): Promise<{ exitCode: number | null; ms: number }> {
  (s as any).panePidValue = await deadPid();
  const started = Date.now();
  (s as any).checkLiveness();
  const deadline = Date.now() + 5000;
  while (!(s as any).paneExited && Date.now() < deadline) await Bun.sleep(5);
  expect((s as any).paneExited).toBe(true);
  return { exitCode: s.snapshot().exitCode, ms: Date.now() - started };
}

describe("liveness exit after a socket drop", () => {
  test("takes the exit code magmux still holds", async () => {
    const { session: s, sockPath } = session();
    fakeMagmux(sockPath, "dead-with-code", 3);
    const { exitCode } = await livenessExit(s);
    expect(exitCode).toBe(3);
    expect(s.snapshot().detail ?? "").toContain("pane child exited with code 3");
  });

  test("redials: takes the code when the socket comes back a second after the exit is seen", async () => {
    const { session: s, sockPath } = session();
    setTimeout(() => fakeMagmux(sockPath, "dead-with-code", 3), 1000);
    const { exitCode, ms } = await livenessExit(s);
    expect(exitCode).toBe(3);
    expect(ms).toBeGreaterThanOrEqual(900);
  });

  test("finishes without a code within the bound when magmux is unreachable", async () => {
    const { session: s } = session();
    const { exitCode, ms } = await livenessExit(s);
    expect(exitCode).toBeNull();
    expect(s.snapshot().detail ?? "").toContain("pane child exited (code unknown)");
    expect(ms).toBeLessThan(2900);
  });

  test("finishes without a code within the bound when magmux does not answer", async () => {
    const { session: s, sockPath } = session();
    fakeMagmux(sockPath, "silent", 3);
    const { exitCode, ms } = await livenessExit(s);
    expect(exitCode).toBeNull();
    expect(ms).toBeGreaterThanOrEqual(1900);
    expect(ms).toBeLessThan(2900);
  });
});
