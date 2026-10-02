/**
 * A team run that fails to START: the spawn loop throws after some slots
 * exist. Every slot already spawned must be STOPPED before the error reaches
 * the caller — SIGTERM, then SIGKILL after the grace period — so nothing the
 * `team(mode:"run")` handler records as `failed reason=start-failed` keeps
 * running and billing. A slot that ignores SIGTERM is the case that matters.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { getStatus, setupSession, startModels } from "./team-orchestrator.js";

const spawnPlanner = async () => ({ pinned: new Map<string, string>() });
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Until the one spawned slot's end is recorded in `status.json`. The slot whose
 * spawn threw stays `RUNNING` there: it was marked before the throw.
 */
async function waitForSpawnedSlotEnd(sessionPath: string, limitMs = 5_000): Promise<void> {
  const deadline = Date.now() + limitMs;
  const ended = () =>
    Object.values(getStatus(sessionPath).models).some((m) => Boolean(m.completedAt));
  while (!ended()) {
    if (Date.now() > deadline) throw new Error(`the spawned slot never ended: ${sessionPath}`);
    await delay(10);
  }
}

/**
 * A child that ignores SIGTERM and dies only on SIGKILL. No pid, so
 * `signalProcessTree` never addresses a real process group; `killed` stays
 * false so every signal reaches `kill`, as the group kill would in production.
 */
class StubbornChild extends EventEmitter {
  readonly pid = undefined;
  readonly killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: string[] = [];

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    if (signal === "SIGKILL" && this.signalCode === null) {
      this.signalCode = "SIGKILL";
      this.stdout.end();
      this.stderr.end();
      this.emit("exit", null, "SIGKILL");
    }
    return true;
  }
}

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "team-start-failure-test-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("team spawn-loop failure", () => {
  it("escalates to SIGKILL for a spawned slot that ignores SIGTERM, before rethrowing", async () => {
    const sessionPath = join(tempRoot, "stubborn");
    setupSession(sessionPath, ["model-a", "model-b"], "ping");

    const stubborn = new StubbornChild();
    let calls = 0;
    const spawnChild = (() => {
      calls++;
      if (calls === 1) return stubborn as unknown as ChildProcess;
      throw new Error("spawn EAGAIN");
    }) as unknown as typeof spawn;

    let settledCalls = 0;
    const error = await startModels(sessionPath, {
      captureMode: "print",
      spawnPlanner,
      spawnChild,
      terminateGraceMs: 50,
      onSettled: () => {
        settledCalls++;
      },
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("spawn EAGAIN");
    // Stopped BEFORE the error reached us, not after.
    expect(stubborn.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(stubborn.signalCode).toBe("SIGKILL");
    // Its close handler records the kill; let it land before the directory goes.
    await waitForSpawnedSlotEnd(sessionPath);
    expect(settledCalls).toBe(0);
  });
});
