/**
 * CONTRACT POINT 10 (`[Recovery]` log lines, with no `--debug` anywhere) and
 * the process-level half of CONTRACT POINT 7 (stop promptly, and actually
 * exit).
 *
 * A SPAWNED CHILD with separated pipes, deliberately. An in-process
 * `process.stderr.write` monkeypatch intercepts the CALL, not the file
 * descriptor, so it cannot answer "did this byte go to stdout?" — which is the
 * only question that matters when the client on the other end is a TUI. And a
 * process that never exits is invisible to a test running inside it.
 */

import { describe, expect, test } from "bun:test";
import { reservePorts, sleep, startRawFixture } from "./fixtures.js";

const CHILD = new URL("./child-proxy-run.ts", import.meta.url).pathname;
const SECRET_KEY = "sk-blackbox-SECRET-VALUE-9f3c1d"; // the key the child configures

interface ChildRun {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  lifetimeMs: number;
  result: Record<string, unknown>;
}

async function runChild(
  mode: "exhaust" | "abort",
  endpointUrl: string,
  apiTimeoutMs: number,
  abortAfterMs?: number
): Promise<ChildRun> {
  const started = Date.now();
  const child = Bun.spawn(
    [
      "bun",
      "run",
      CHILD,
      mode,
      endpointUrl,
      String(apiTimeoutMs),
      ...(abortAfterMs ? [String(abortAfterMs)] : []),
    ],
    { env: { ...process.env }, stdout: "pipe", stderr: "pipe", stdin: "ignore" }
  );
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const exitCode = await child.exited;
  const lifetimeMs = Date.now() - started;
  const line = stdout.trim().split("\n").at(-1) ?? "{}";
  let result: Record<string, unknown> = {};
  try {
    result = JSON.parse(line);
  } catch {
    /* asserted by the caller */
  }
  return { stdout, stderr, exitCode, lifetimeMs, result };
}

describe("CP-10 — recovery diagnostics in a real child process", () => {
  test("a recovery episode is reported in the captured output with no --debug anywhere", async () => {
    const [port] = reservePorts(1);
    const fixture = startRawFixture(port);
    try {
      const run = await runChild("exhaust", `http://127.0.0.1:${port}/v1`, 40_000);
      // The ladder really ran: counted at our socket, not in the log.
      expect(fixture.connections.length).toBeGreaterThanOrEqual(2);
      expect(run.result.status).toBe(400);

      // Contract point 10: the retry activity is legible without a debug flag.
      // The docs make the same promise for a shortened API_TIMEOUT_MS:
      // "claudish shortens the hold to match and logs a [Recovery] line
      // saying so" (docs/advanced/environment.md).
      //
      // MEASURED at HEAD 8ed0f13: the lines exist and are rich, but they go
      // to the DEBUG LOG FILE (logs/claudish_*.log, which only a --debug run
      // writes). With no debug flag a whole recovery episode leaves nothing
      // on either stream but the final `[claudish] Error:` line.
      expect(
        run.stderr,
        `neither stream carried a [Recovery] line.\nstdout=${run.stdout}\nstderr=${run.stderr}`
      ).toContain("[Recovery]");
    } finally {
      fixture.stop();
    }
  }, 90_000);

  test("no diagnostic byte lands on stdout — the client's protocol stream stays clean", async () => {
    const [port] = reservePorts(1);
    const fixture = startRawFixture(port);
    try {
      const run = await runChild("exhaust", `http://127.0.0.1:${port}/v1`, 40_000);
      expect(fixture.connections.length).toBeGreaterThanOrEqual(2);

      // stdout carries the child's single JSON result line and nothing else.
      const stdoutLines = run.stdout.split("\n").filter((l) => l.trim().length > 0);
      expect(stdoutLines.length).toBe(1);
      expect(run.stdout).not.toContain("[Recovery]");
      expect(run.stdout).not.toContain("[claudish]");
    } finally {
      fixture.stop();
    }
  }, 90_000);

  test("no credential appears in anything the process printed", async () => {
    const [port] = reservePorts(1);
    const fixture = startRawFixture(port);
    try {
      const run = await runChild("exhaust", `http://127.0.0.1:${port}/v1`, 40_000);
      expect(fixture.connections.length).toBeGreaterThanOrEqual(2);
      // Positive control: the run really did print the failing endpoint, so
      // "no secret" is not passing because nothing was printed at all.
      expect(run.stderr + run.stdout).toContain(`127.0.0.1:${port}`);
      expect(run.stdout).not.toContain(SECRET_KEY);
      expect(run.stderr).not.toContain(SECRET_KEY);
    } finally {
      fixture.stop();
    }
  }, 90_000);
});

describe("CP-7 — the process itself lets go", () => {
  test("after an aborted ladder the child shuts down and exits promptly", async () => {
    const [port] = reservePorts(1);
    const fixture = startRawFixture(port);
    try {
      // 12s, not 7s: the child's FIRST upstream attempt lands ~2.5s after the
      // request starts (catalog/registry warm-up inside the request path), so
      // a 7s abort can land before attempt 2 and make "it stopped retrying"
      // trivially true — trap T-11.
      const abortAfterMs = 12_000;
      const run = await runChild("abort", `http://127.0.0.1:${port}/v1`, 120_000, abortAfterMs);

      expect(run.result.aborted).toBe(true);
      expect(fixture.connections.length).toBeGreaterThanOrEqual(2); // it was mid-ladder
      expect(run.exitCode).toBe(0);
      expect(Number(run.result.shutdownMs)).toBeLessThan(1_000);
      // Startup + the abort delay + a generous margin. A retained 60s timer
      // blows straight through this.
      expect(run.lifetimeMs).toBeLessThan(abortAfterMs + 10_000);
    } finally {
      fixture.stop();
    }
  }, 90_000);

  test("SIGTERM mid-ladder ends the process within two seconds", async () => {
    const [port] = reservePorts(1);
    const fixture = startRawFixture(port);
    const child = Bun.spawn(
      ["bun", "run", CHILD, "exhaust", `http://127.0.0.1:${port}/v1`, "120000"],
      { env: { ...process.env }, stdout: "pipe", stderr: "pipe", stdin: "ignore" }
    );
    try {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && fixture.connections.length < 2) await sleep(50);
      expect(fixture.connections.length).toBeGreaterThanOrEqual(2);

      const killedAt = Date.now();
      child.kill("SIGTERM");
      await child.exited;
      expect(Date.now() - killedAt).toBeLessThan(2_000);
    } finally {
      child.kill("SIGKILL");
      fixture.stop();
    }
  }, 90_000);
});
