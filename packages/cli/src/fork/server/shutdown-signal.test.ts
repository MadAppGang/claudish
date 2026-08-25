/**
 * Who owns the exit on SIGTERM — and why the proxy's graceful shutdown was
 * unreachable until it did.
 *
 * `stats-buffer.ts` registers a synchronous SIGTERM/SIGINT listener at module
 * evaluation time. The proxy entrypoint reaches it through a plain static
 * import chain (standalone-proxy -> proxy-server -> composed-handler -> stats
 * -> stats-buffer), and a module body is evaluated before its importer's, so
 * that listener is always registered FIRST. Node runs signal listeners
 * synchronously in registration order, and `process.exit()` does not return —
 * so an unconditional exit there meant `await server.shutdown()` in
 * standalone-proxy.ts never ran, and every restart cut the in-flight SSE
 * responses mid-body (`Connection lost mid-response`, client-side).
 *
 * WHAT THESE TESTS DO AND DO NOT PROVE. They drive the listener array with
 * `process.emit("SIGTERM")` rather than a real signal, on purpose: on Windows
 * `process.kill(process.pid, "SIGTERM")` is a TerminateProcess and delivers no
 * JS signal at all, so a signal-based test would measure the OS on one platform
 * and our code on another. What is exercised is exactly what changed — listener
 * ordering and the ownership decision. Delivering the signal to PID 1 in the
 * container is the runtime's job, not ours.
 */

import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

// Absolute specifier with forward slashes: the fixture lives in a temp dir, and
// a Windows path with backslashes is not a valid import specifier.
const STATS_BUFFER = join(import.meta.dir, "..", "..", "stats-buffer.ts").replace(/\\/g, "/");

function runFixture(deferToHost: boolean): { stdout: string; exitCode: number } {
  const dir = mkdtempSync(join(tmpdir(), "claudish-sigterm-"));
  const file = join(dir, "fixture.ts");
  const spec = JSON.stringify(STATS_BUFFER);
  writeFileSync(
    file,
    [
      // A BARE import, always — both because it is what the real chain amounts
      // to (nobody imports stats-buffer for its exports; it is pulled in for its
      // side effects) and because a NAMED import that goes unused is elided by
      // the transpiler, module side effects included. That elision silently
      // turned an earlier version of the no-defer case green for the wrong
      // reason, which is what LISTENERS-AFTER-IMPORT below now guards against.
      `import ${spec};`,
      deferToHost ? `import { deferSignalExitToHost } from ${spec};` : "",
      `console.log("LISTENERS-AFTER-IMPORT=" + process.listenerCount("SIGTERM"));`,
      deferToHost ? "deferSignalExitToHost();" : "",
      // Registered second, exactly like standalone-proxy.ts's own handler.
      `process.on("SIGTERM", () => { console.log("HOST-HANDLER-RAN"); });`,
      `process.emit("SIGTERM" as never);`,
      `console.log("STILL-ALIVE-AFTER-EMIT");`,
    ].join("\n")
  );
  const proc = Bun.spawnSync(["bun", "run", file], {
    env: { ...process.env, CLAUDISH_STATS: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { stdout: proc.stdout.toString(), exitCode: proc.exitCode ?? -1 };
}

describe("signal exit ownership", () => {
  it("lets the host's own SIGTERM handler run once it claims the exit", () => {
    const { stdout } = runFixture(true);
    expect(stdout).toContain("LISTENERS-AFTER-IMPORT=1");
    // Empty without the fix: stats-buffer's listener exits the process before
    // the host's listener is ever reached.
    expect(stdout).toContain("HOST-HANDLER-RAN");
    expect(stdout).toContain("STILL-ALIVE-AFTER-EMIT");
  });

  it("still exits by itself when no host claims it", () => {
    const { stdout, exitCode } = runFixture(false);
    expect(stdout).toContain("LISTENERS-AFTER-IMPORT=1");
    // NB: this case also passes against the UN-fixed code, which exits here too.
    // It is not proof of the change — it is the guard against the obvious
    // over-correction. Deleting the exit outright, rather than making it
    // conditional, would leave the CLI unable to die on SIGTERM at all, since
    // registering any listener suppresses Node's default terminate. That
    // mistake fails this test while passing the one above.
    expect(stdout).not.toContain("HOST-HANDLER-RAN");
    expect(stdout).not.toContain("STILL-ALIVE-AFTER-EMIT");
    expect(exitCode).toBe(0);
  });
});
