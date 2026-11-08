/** Shared by the pane-gated-* suites: real pinned magmux, fake child, PRODUCTION timings. */
import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { cpus } from "node:os";
import { Worker } from "node:worker_threads";
import type { MagmuxReply } from "../magmux-client.js";
import type { ScreenState } from "../screen-model.js";
import { type GateRun, gateUntil, gatedSends, submissions } from "./gated-pane.js";

export const T = 90_000;
export const PROMPT = "Reply with exactly PEAR.";
export const sha8 = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 8);
export const cases = [
  { name: "plain", prompt: PROMPT, mode: "typed" },
  { name: "command", prompt: "/model haiku", mode: "command" },
  { name: "file", prompt: "First line.\nSecond line with `markdown` and **words**.", mode: "file" },
] as const;

export function screen(r: GateRun): ScreenState {
  const capture = r.s.capture(undefined, { spans: true });
  if (!("lines" in capture)) throw new Error("full capture required");
  return { ...capture, spans: capture.spans ?? [], alt: true, changedAt: 0, aboveBoxChangedAt: 0 };
}

export function listResult(reply: MagmuxReply): Record<string, unknown> {
  if (!reply.ok) throw new Error(`list failed: ${reply.code}: ${reply.error}`);
  return reply.result;
}

export async function settled(r: GateRun, count = 1): Promise<void> {
  await gateUntil(r, (snapshot) => snapshot.turnsCompleted >= count, 45_000);
}

export function assertOneCopy(r: GateRun, prompt: string): void {
  const typed = gatedSends(r).filter(({ message }) => typeof message.text === "string");
  expect(typed).toHaveLength(1);
  expect(typeof typed[0]?.message.text).toBe("string");
  expect(submissions(r).map(({ text }) => text)).toEqual([typed[0]?.message.text as string]);
  expect(typed[0]?.message).toMatchObject({ typed: true });
  if (prompt === "/model haiku") {
    expect(submissions(r)[0]?.text).toBe(prompt);
    expect(r.turns[0]?.answer).toBe("Set model to `haiku`");
  } else {
    expect(r.turns[0]?.answer).toBe(`ANSWER fake-${r.scenario} ${sha8(prompt)}`);
    if (prompt.includes("\n")) {
      expect(submissions(r)[0]?.text).toMatch(/^Your task is in the file `.+`\. Read all of it/);
      expect(r.turns[0]?.delivery).toMatchObject({ mode: "file", complete: true });
    } else expect(submissions(r)[0]?.text).toBe(prompt);
  }
}

/** Real CPU load in separate threads; every thread is joined, including on assertion failure. */
export async function underLoad(work: () => Promise<void>): Promise<void> {
  const workers: Worker[] = [];
  try {
    const ready: Promise<unknown>[] = [];
    for (let i = 0; i < cpus().length; i++) {
      const worker = new Worker(
        `const { parentPort } = require('node:worker_threads'); parentPort.postMessage('ready'); let n = 0; while (true) { n = (n + Math.sqrt(n + 1)) % 1000000; }`,
        { eval: true }
      );
      workers.push(worker);
      ready.push(
        new Promise((resolve, reject) => {
          worker.once("message", resolve);
          worker.once("error", reject);
        })
      );
    }
    await Promise.all(ready);
    await work();
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}

export async function allRuns(runs: Promise<void>[]): Promise<void> {
  // Do not leave sibling assertions polling after an early Promise.all rejection.
  const results = await Promise.allSettled(runs);
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}

export async function assertLoudLoss(r: GateRun, reason: string): Promise<void> {
  const snapshot = await gateUntil(r, (s) => s.state === "FAILED", 40_000);
  expect(snapshot.reason).toBe("prompt_not_accepted");
  expect(snapshot.detail).toContain(`magmux not_accepted ${reason}`);
  expect(snapshot.anomalies).not.toContain("degraded_mode");
  expect(r.turns).toHaveLength(0);
  expect(r.transitions.some(({ to }) => to === "EMPTY" || to === "COMPLETED")).toBe(false);
  expect(submissions(r)).toEqual([]);
  // A recording gap must fail here as a missed send, not below as a timing bound.
  const typed = gatedSends(r).filter(({ message }) => typeof message.text === "string");
  expect(typed.length).toBe(r.s.diagnostics().lastSend?.attempts ?? -1);
  const failedAt = r.transitions.find(({ to }) => to === "FAILED")?.at ?? 0;
  expect(failedAt - (gatedSends(r)[0]?.at ?? Number.POSITIVE_INFINITY)).toBeGreaterThanOrEqual(
    29_000
  );
  expect(failedAt - (gatedSends(r)[0]?.at ?? 0)).toBeLessThanOrEqual(31_000);
}

// The two "loaded" tests run six panes beside one busy worker per core. On the CI macOS
// runner both hit their 180 s bound (PR #305, run 39388284350) and pushed the hermetic step
// past its timeout; on an 18-core machine they take 20-45 s. They run locally only. D-A and
// D-B stay covered in CI without the load: DA-1, DA-2, DB-1 / I2-I4 and DB-2 / I17.
export const SKIP_LOADED = process.env.CI === "true";
