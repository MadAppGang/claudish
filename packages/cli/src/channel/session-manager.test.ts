/**
 * Unit tests for SessionManager.
 *
 * SessionManager normally spawns `claudish`, but here we intercept by
 * prepending a temp directory to PATH that contains a `claudish` shim.
 * The shim (`fake-claudish.ts`) is a tiny Bun script whose behaviour is
 * controlled by extra flags we pass via SessionCreateOptions.claudishFlags.
 *
 * Flag conventions (understood by the fake, silently ignored by the real CLI):
 *   --sleep <s>    sleep for <s> seconds then exit 0
 *   --fail         exit immediately with code 1
 *   --lines <n>    write "line 1" … "line N" to stdout then exit 0
 *   --print-argv   write the received argv as JSON then exit 0
 *
 * The real claudish spawn args (--model, -y, --stdin, --quiet) come first;
 * the test-only flags are appended via claudishFlags so they land after all
 * the real flags. The fake script simply ignores unknown flags it doesn't
 * recognise.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SessionManager } from "./session-manager.js";
import type { ChannelEvent, SessionManagerOptions } from "./types.js";

// ─── Setup: PATH shim ────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Absolute path to the fake-claudish TypeScript entry point. */
const FAKE_CLAUDISH_TS = join(__dirname, "test-helpers", "fake-claudish.ts");

/** Temp directory where we place a `claudish` wrapper script. */
let shimDir: string;
/** Temp artifact root so tests never write under the real ~/.claudish. */
let sessionsDir: string;
/** Original PATH value so we can restore it after tests. */
const ORIGINAL_PATH = process.env.PATH ?? "";

beforeAll(() => {
  // Create a temp directory for the shim
  shimDir = mkdtempSync(join(tmpdir(), "claudish-shim-"));
  sessionsDir = mkdtempSync(join(tmpdir(), "claudish-sessions-"));

  // Write a `claudish` wrapper that calls the fake via bun
  const shimPath = join(shimDir, "claudish");
  writeFileSync(shimPath, `#!/bin/sh\nexec bun run "${FAKE_CLAUDISH_TS}" "$@"\n`, { mode: 0o755 });

  // Prepend shim directory to PATH so our fake is found first
  process.env.PATH = `${shimDir}:${ORIGINAL_PATH}`;
});

afterAll(() => {
  // Restore original PATH
  process.env.PATH = ORIGINAL_PATH;

  // Clean up shim directory
  try {
    rmSync(shimDir, { recursive: true, force: true });
    rmSync(sessionsDir, { recursive: true, force: true });
  } catch {}
});

// ─── Helper utilities ────────────────────────────────────────────────────────

/** Wait until a predicate returns true, checking every `intervalMs` ms.
 *  Rejects if the predicate hasn't returned true within `timeoutMs`. */
function waitUntil(predicate: () => boolean, timeoutMs = 5000, intervalMs = 50): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error("waitUntil timed out"));
      setTimeout(check, intervalMs);
    };
    check();
  });
}

/** Create a SessionManager with sensible test defaults. */
function makeManager(opts?: SessionManagerOptions): SessionManager {
  return new SessionManager({ maxSessions: 20, sessionsDir, ...opts });
}

/**
 * Create a session whose spawned process exits quickly.
 * By default the fake echoes an empty stdin and exits.
 * Extra fake flags can be passed via extraFlags.
 */
function quickSession(
  manager: SessionManager,
  extraFlags: string[] = [],
  prompt = "hello"
): string {
  return manager.createSession({
    model: "test-model",
    prompt,
    claudishFlags: extraFlags,
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("SessionManager", () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = makeManager();
  });

  afterEach(() => {
    // Shut down all sessions. We don't await because the KILL_GRACE_MS (5s)
    // wait could exceed the hook timeout. Each test uses a fresh manager
    // instance so not awaiting here is safe — orphaned processes will exit
    // via SIGTERM and the SIGKILL fallback will clean them up asynchronously.
    manager.shutdownAll().catch(() => {});
  });

  // ── 1. createSession returns unique session IDs ──────────────────────────

  test("createSession returns unique session IDs", () => {
    const id1 = quickSession(manager);
    const id2 = quickSession(manager);
    expect(id1).not.toBe(id2);
    expect(typeof id1).toBe("string");
    expect(id1.length).toBeGreaterThan(0);
    expect(typeof id2).toBe("string");
    expect(id2.length).toBeGreaterThan(0);
  });

  // ── 2. getSession returns correct info ───────────────────────────────────

  test("getSession returns correct model/status/sessionId fields", () => {
    const id = quickSession(manager);
    const info = manager.getSession(id);
    expect(info.sessionId).toBe(id);
    expect(info.model).toBe("test-model");
    // Status is "starting" immediately after spawn
    expect(["starting", "running", "completed"]).toContain(info.status);
    expect(info.pid).not.toBeNull();
    expect(typeof info.startedAt).toBe("string");
    expect(info.completedAt).toBeNull();
    expect(info.exitCode).toBeNull();
  });

  test("spawnModel changes argv while SessionInfo keeps the requested model", async () => {
    const id = manager.createSession({
      model: "glm-5",
      spawnModel: "gc@glm-5",
      claudishFlags: ["--print-argv"],
    });

    await waitUntil(() => ["completed", "failed"].includes(manager.getSession(id).status));

    const argv = JSON.parse(manager.getOutput(id).output.trim()) as string[];
    const modelFlag = argv.indexOf("--model");
    expect(argv[modelFlag + 1]).toBe("gc@glm-5");
    expect(manager.getSession(id).model).toBe("glm-5");
  });

  test("spawn argv falls back to the requested model when spawnModel is absent", async () => {
    const id = manager.createSession({
      model: "glm-5",
      claudishFlags: ["--print-argv"],
    });

    await waitUntil(() => ["completed", "failed"].includes(manager.getSession(id).status));

    const argv = JSON.parse(manager.getOutput(id).output.trim()) as string[];
    const modelFlag = argv.indexOf("--model");
    expect(argv[modelFlag + 1]).toBe("glm-5");
    expect(manager.getSession(id).model).toBe("glm-5");
  });

  test("getSession throws for non-existent session", () => {
    expect(() => manager.getSession("nonexistent")).toThrow("not found");
  });

  // ── 3. listSessions filters completed sessions ───────────────────────────

  test("listSessions includes active session", () => {
    const id = quickSession(manager, ["--sleep", "3"]);
    const list = manager.listSessions(false);
    expect(list.some((s) => s.sessionId === id)).toBe(true);
    // Cancel immediately so afterEach shutdownAll is fast
    manager.cancelSession(id);
  });

  test("listSessions excludes completed sessions when includeCompleted=false", async () => {
    const id = quickSession(manager);
    // Wait until the session completes
    await waitUntil(() => {
      const info = manager.getSession(id);
      return ["completed", "failed"].includes(info.status);
    });
    const list = manager.listSessions(false);
    expect(list.some((s) => s.sessionId === id)).toBe(false);
  });

  test("listSessions includes completed sessions when includeCompleted=true", async () => {
    const id = quickSession(manager);
    await waitUntil(() => {
      const info = manager.getSession(id);
      return ["completed", "failed"].includes(info.status);
    });
    const list = manager.listSessions(true);
    expect(list.some((s) => s.sessionId === id)).toBe(true);
  });

  // ── 4. maxSessions limit ─────────────────────────────────────────────────

  test("maxSessions limit: 3rd session throws when limit is 2", async () => {
    const limited = makeManager({ maxSessions: 2 });
    const ids: string[] = [];
    try {
      ids.push(limited.createSession({ model: "m", claudishFlags: ["--sleep", "3"] }));
      ids.push(limited.createSession({ model: "m", claudishFlags: ["--sleep", "3"] }));
      expect(() => limited.createSession({ model: "m", claudishFlags: ["--sleep", "3"] })).toThrow(
        /Max sessions/
      );
    } finally {
      // Cancel all sessions before shutdown so SIGTERM resolves quickly
      for (const id of ids) {
        try {
          limited.cancelSession(id);
        } catch {}
      }
      await limited.shutdownAll();
    }
  });

  // ── 5. cancelSession sends SIGTERM ───────────────────────────────────────

  test("cancelSession: status becomes 'cancelled'", async () => {
    const id = manager.createSession({
      model: "test-model",
      claudishFlags: ["--sleep", "60"],
    });

    // Wait until the process is running (has a PID and is not instantly done)
    await waitUntil(() => {
      const info = manager.getSession(id);
      return info.pid !== null;
    });

    const result = manager.cancelSession(id);
    expect(result).toBe(true);
    expect(manager.getSession(id).status).toBe("cancelled");
  });

  // ── 6. cancelSession returns false for already-completed session ─────────

  test("cancelSession returns false for completed session", async () => {
    const id = quickSession(manager);
    await waitUntil(() => {
      const info = manager.getSession(id);
      return ["completed", "failed"].includes(info.status);
    });
    const result = manager.cancelSession(id);
    expect(result).toBe(false);
  });

  // ── 7. sendInput returns false for non-existent session ─────────────────

  test("sendInput returns false for non-existent session", () => {
    expect(manager.sendInput("does-not-exist", "hello")).toBe(false);
  });

  // ── 8. sendInput returns false for completed session ────────────────────

  test("sendInput returns false for completed session", async () => {
    const id = quickSession(manager);
    await waitUntil(() => {
      const info = manager.getSession(id);
      return ["completed", "failed"].includes(info.status);
    });
    expect(manager.sendInput(id, "some input")).toBe(false);
  });

  // ── 9. getOutput returns scrollback content ──────────────────────────────

  test("getOutput returns output from process stdout", async () => {
    const id = manager.createSession({
      model: "test-model",
      prompt: "hello world",
      // echo stdin to stdout (default fake behaviour)
    });

    await waitUntil(() => {
      const info = manager.getSession(id);
      return ["completed", "failed"].includes(info.status);
    });

    const out = manager.getOutput(id);
    expect(out.sessionId).toBe(id);
    expect(out.output).toContain("hello world");
  });

  // ── 10. getOutput with tail_lines ────────────────────────────────────────

  test("getOutput with tail_lines returns only the last N lines", async () => {
    const id = manager.createSession({
      model: "test-model",
      claudishFlags: ["--lines", "10"],
    });

    await waitUntil(() => {
      const info = manager.getSession(id);
      return ["completed", "failed"].includes(info.status);
    });

    const out = manager.getOutput(id, 2);
    const lines = out.output.split("\n").filter((l) => l.trim() !== "");
    expect(lines.length).toBeLessThanOrEqual(2);
    // Last two of 10 numbered lines should be "line 9" and "line 10"
    expect(out.output).toContain("line 9");
    expect(out.output).toContain("line 10");
    expect(out.output).not.toContain("line 1\n");
  });

  test("getOutput throws for non-existent session", () => {
    expect(() => manager.getOutput("bad-id")).toThrow("not found");
  });

  // ── 11. timeout kills process ─────────────────────────────────────────────

  test("timeout kills long-running process and terminates it", async () => {
    const id = manager.createSession({
      model: "test-model",
      timeoutSeconds: 1,
      claudishFlags: ["--sleep", "60"],
    });

    // After the timeout fires (1s), the watcher forces "failed" state and
    // completedAt is set. The internal status ends up as "failed" because
    // watcher.forceState("failed") overwrites the transient "timeout" value.
    // We verify the session was killed by confirming completedAt is set within
    // a short window.
    await waitUntil(
      () => {
        const info = manager.getSession(id);
        // completedAt is set in the timeout handler (line 208 of session-manager.ts)
        // before forceState is called, so it's a reliable signal that timeout fired.
        return info.completedAt !== null;
      },
      4000,
      100
    );

    const info = manager.getSession(id);
    // completedAt was set by the timeout handler
    expect(info.completedAt).not.toBeNull();
    // Process was killed: status is "failed" (watcher overrides the transient "timeout")
    expect(["failed", "timeout"]).toContain(info.status);
  }, 10000);

  // ── 12. onStateChange callback fires ─────────────────────────────────────

  test("onStateChange callback fires with session_id and event", async () => {
    const events: Array<{ sessionId: string; event: ChannelEvent }> = [];

    const mgr = makeManager({
      onStateChange: (sessionId, event) => {
        events.push({ sessionId, event });
      },
    });

    try {
      const id = mgr.createSession({
        model: "test-model",
        prompt: "trigger events",
      });

      // Wait for the process to reach a terminal state
      await waitUntil(() => {
        const info = mgr.getSession(id);
        return ["completed", "failed"].includes(info.status);
      }, 8000);

      // Give the SignalWatcher a moment to flush any pending callbacks
      await new Promise((r) => setTimeout(r, 200));

      expect(events.length).toBeGreaterThan(0);
      // All events should reference the correct session
      for (const e of events) {
        expect(e.sessionId).toBe(id);
        expect(typeof e.event.type).toBe("string");
        expect(typeof e.event.model).toBe("string");
      }
    } finally {
      await mgr.shutdownAll();
    }
  }, 15000);

  // ── 13. session artifacts on disk ─────────────────────────────────────────

  test("meta.json is written to the configured sessions directory after completion", async () => {
    const id = quickSession(manager);

    await waitUntil(() => {
      const info = manager.getSession(id);
      return ["completed", "failed"].includes(info.status);
    });

    // Give the exit handler a moment to finish writing files
    await new Promise((r) => setTimeout(r, 300));

    const metaPath = join(sessionsDir, id, "meta.json");
    expect(existsSync(metaPath)).toBe(true);

    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    expect(meta.sessionId).toBe(id);
    expect(meta.model).toBe("test-model");
    expect(typeof meta.startedAt).toBe("string");
    expect(typeof meta.completedAt).toBe("string");
  });

  // ── Additional edge cases ─────────────────────────────────────────────────

  test("createSession stores session in listSessions immediately", () => {
    const id = manager.createSession({
      model: "test-model",
      claudishFlags: ["--sleep", "3"],
    });
    const all = manager.listSessions(true);
    expect(all.some((s) => s.sessionId === id)).toBe(true);
    // Cancel so afterEach is fast
    manager.cancelSession(id);
  });

  test("cancelled session appears in listSessions with includeCompleted=true", async () => {
    const id = manager.createSession({
      model: "test-model",
      claudishFlags: ["--sleep", "3"],
    });
    await waitUntil(() => manager.getSession(id).pid !== null);
    manager.cancelSession(id);

    const all = manager.listSessions(true);
    const found = all.find((s) => s.sessionId === id);
    expect(found).toBeDefined();
    expect(found?.status).toBe("cancelled");
  });

  test("getOutput totalLines reflects number of lines produced", async () => {
    const id = manager.createSession({
      model: "test-model",
      claudishFlags: ["--lines", "5"],
    });

    await waitUntil(() => {
      const info = manager.getSession(id);
      return ["completed", "failed"].includes(info.status);
    });

    const out = manager.getOutput(id);
    expect(out.totalLines).toBeGreaterThanOrEqual(5);
  });

  test("cancelSession returns false for non-existent session", () => {
    expect(manager.cancelSession("ghost-session")).toBe(false);
  });
});
