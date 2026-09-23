/**
 * End-to-end tests for the claudish + magmux integration.
 *
 * Spawns real processes (magmux, claudish, Claude Code) under a PTY and
 * validates the full lifecycle: socket protocol, controller snapshots,
 * final results aggregation.
 *
 * Two describe blocks, both run on every invocation:
 *   1. Socket protocol — shell commands only. Fast, no API keys needed.
 *   2. Real models + Claude Code — calls actual LLMs (glm-5-turbo) and
 *      launches Claude Code interactive so ClaudeCodeController attaches
 *      and reports snapshots. Requires a working model config and the
 *      `claude` CLI on PATH.
 *
 * Preqs (all must be on PATH):
 *   - expect(1)          — real PTY allocator
 *   - magmux             — via @claudish/magmux-*  npm package or Homebrew
 *   - claude             — Claude Code CLI
 *   - bun                — runs the dev claudish via `bun run src/index.ts`
 */

import { expect } from "bun:test";
import { join } from "node:path";
import {
  findMagmuxForTest,
  runInPty,
  snapshotMagmuxSockets,
  subscribeToMagmuxSocket,
  writeGridfile,
  type MagmuxSubscription,
} from "./team-grid.e2e-helpers.js";
import { envDescribe } from "./test-support/env-gate";

const E2E_TIMEOUT = 150_000; // per real-model test (includes cold-start slack)

const magmuxPath = findMagmuxForTest();

const magmuxGate = {
  id: "team-grid-magmux-pty",
  active: process.platform !== "win32" && magmuxPath !== "",
  reason: "e2e needs the magmux binary (npm @claudish/magmux-* or Homebrew) AND the expect(1) PTY allocator — neither ships on this machine",
  activation: "bun install the platform magmux package on a POSIX host with expect(1)",
};

// ─── Fast tier: socket protocol ──────────────────────────────────────────────

envDescribe({ ...magmuxGate }, "magmux socket protocol (shell commands)")((it) => {
  it(
    "broadcasts snapshot, exit, results, shutdown for a short-lived pane",
    async () => {
      // A pane that prints one line then exits. We sleep for 2s before
      // exiting to give the test's socket subscriber enough time to connect
      // before magmux starts emitting events. `-w` makes magmux auto-quit
      // as soon as the pane is "done".
      const grid = writeGridfile([`echo 'hello from test pane'; sleep 2`]);
      const baseline = snapshotMagmuxSockets();

      const handle = runInPty({
        command: [magmuxPath, "-g", grid.path, "-w"],
      });

      let sub: MagmuxSubscription | null = null;
      try {
        // Wait briefly for magmux to create its socket.
        sub = await subscribeToMagmuxSocket({ baseline });

        // The shutdown event is the canonical "we're about to close" signal.
        await sub.waitFor(
          (events) => events.some((e) => e.type === "shutdown"),
          15_000
        );

        const types = sub.events.map((e) => e.type);

        // We expect at minimum: exit → results → shutdown. Snapshots may
        // or may not appear because `echo` doesn't get a controller.
        expect(types).toContain("exit");
        expect(types).toContain("results");
        expect(types).toContain("shutdown");

        // The exit event should carry the correct pane index and code.
        const exitEvent = sub.events.find((e) => e.type === "exit")!;
        expect(exitEvent.pane).toBe(0);
        expect(exitEvent.exitCode).toBe(0);

        // The results event should contain one pane marked completed.
        const resultsEvent = sub.events.find((e) => e.type === "results")!;
        expect(Array.isArray(resultsEvent.panes)).toBe(true);
        const panes = resultsEvent.panes as Array<Record<string, unknown>>;
        expect(panes).toHaveLength(1);
        expect(panes[0].pane).toBe(0);
        expect(panes[0].state).toBe("completed");
        expect(panes[0].exitCode).toBe(0);
        expect(panes[0].dead).toBe(true);
      } finally {
        await sub?.close();
        handle.kill("SIGKILL");
        grid.cleanup();
      }
    },
    30_000
  );

  it(
    "marks a failed pane as failed in the results event",
    async () => {
      // Sleep first so the subscriber has time to attach, then fail.
      const grid = writeGridfile([`sleep 2; echo 'oops' >&2; exit 37`]);
      const baseline = snapshotMagmuxSockets();

      const handle = runInPty({
        command: [magmuxPath, "-g", grid.path, "-w"],
      });

      let sub: MagmuxSubscription | null = null;
      try {
        sub = await subscribeToMagmuxSocket({ baseline });
        await sub.waitFor(
          (events) => events.some((e) => e.type === "results"),
          15_000
        );

        const resultsEvent = sub.events.find((e) => e.type === "results")!;
        const panes = resultsEvent.panes as Array<Record<string, unknown>>;
        expect(panes).toHaveLength(1);
        expect(panes[0].state).toBe("failed");
        expect(panes[0].exitCode).toBe(37);
      } finally {
        await sub?.close();
        handle.kill("SIGKILL");
        grid.cleanup();
      }
    },
    30_000
  );

  it(
    "handles multiple panes and reports per-pane state",
    async () => {
      const grid = writeGridfile([
        `echo 'pane0 ok'; sleep 2`,
        `echo 'pane1 ok'; sleep 2`,
      ]);
      const baseline = snapshotMagmuxSockets();

      const handle = runInPty({
        command: [magmuxPath, "-g", grid.path, "-w"],
      });

      let sub: MagmuxSubscription | null = null;
      try {
        sub = await subscribeToMagmuxSocket({ baseline });
        await sub.waitFor(
          (events) => events.some((e) => e.type === "results"),
          15_000
        );

        const resultsEvent = sub.events.find((e) => e.type === "results")!;
        const panes = (resultsEvent.panes as Array<Record<string, unknown>>).sort(
          (a, b) => (a.pane as number) - (b.pane as number)
        );
        expect(panes).toHaveLength(2);
        expect(panes[0].state).toBe("completed");
        expect(panes[1].state).toBe("completed");
      } finally {
        await sub?.close();
        handle.kill("SIGKILL");
        grid.cleanup();
      }
    },
    30_000
  );

  it(
    "pushes exit events in order of pane completion",
    async () => {
      // pane1 finishes before pane0 — ensures broadcast ordering matches
      // real completion time, not gridfile order.
      // pane1 is fast, pane0 is slow. Both sleep enough that subscribe
      // beats them to the punch.
      const grid = writeGridfile([
        `sleep 3; echo 'slow'`,
        `sleep 1; echo 'fast'`,
      ]);
      const baseline = snapshotMagmuxSockets();

      const handle = runInPty({
        command: [magmuxPath, "-g", grid.path, "-w"],
      });

      let sub: MagmuxSubscription | null = null;
      try {
        sub = await subscribeToMagmuxSocket({ baseline });
        await sub.waitFor(
          (events) => events.filter((e) => e.type === "exit").length === 2,
          15_000
        );

        const exits = sub.events.filter((e) => e.type === "exit");
        // pane 1 (the fast one) should exit first.
        expect(exits[0].pane).toBe(1);
        expect(exits[1].pane).toBe(0);
      } finally {
        await sub?.close();
        handle.kill("SIGKILL");
        grid.cleanup();
      }
    },
    30_000
  );
});

// ─── Fast tier: crash fallback ───────────────────────────────────────────────

envDescribe({ ...magmuxGate }, "magmux crash fallback")((it) => {
  it(
    "SIGKILL before results event → no results received",
    async () => {
      // A long-lived pane so we can kill before completion.
      const grid = writeGridfile([`sleep 30`]);
      const baseline = snapshotMagmuxSockets();

      const handle = runInPty({
        command: [magmuxPath, "-g", grid.path],
      });

      let sub: MagmuxSubscription | null = null;
      try {
        sub = await subscribeToMagmuxSocket({ baseline });

        // Give magmux a moment to start rendering but not send results.
        await new Promise((r) => setTimeout(r, 500));

        handle.kill("SIGKILL");
        await handle.waitForExit();

        // A SIGKILLed magmux cannot flush the results event.
        const hasResults = sub.events.some((e) => e.type === "results");
        expect(hasResults).toBe(false);
      } finally {
        await sub?.close();
        grid.cleanup();
      }
    },
    30_000
  );
});

// ─── Real-model tier: claudish happy paths ───────────────────────────────────

// For real-model tests we drive magmux directly with a gridfile that runs the
// dev-build claudish (via `bun run src/index.ts --model ...`). This avoids
// version skew between the outer test harness and whatever `claudish` happens
// to be on PATH inside the pane.
function devClaudishCommand(model: string, prompt: string): string {
  const entry = join(import.meta.dir, "index.ts");
  const escPrompt = prompt.replace(/'/g, `'\\''`);
  return `bun run ${entry} --model ${model} -y --quiet '${escPrompt}'`;
}

envDescribe({ ...magmuxGate }, "claudish team with real models and Claude Code")((it) => {
  it(
    "default mode: pane runs a real model, magmux emits completed results",
    async () => {
      const grid = writeGridfile([
        devClaudishCommand("glm-5-turbo", "reply with only the word hello"),
      ]);
      const baseline = snapshotMagmuxSockets();

      const handle = runInPty({
        command: [magmuxPath, "-g", grid.path, "-w"],
      });

      let sub: MagmuxSubscription | null = null;
      try {
        sub = await subscribeToMagmuxSocket({ baseline, timeoutMs: 5_000 });

        // Give the real model call up to 90s. glm-5-turbo usually responds
        // in 5–15s; we allow extra headroom for cold starts and rate limits.
        await sub.waitFor(
          (events) =>
            events.some((e) => e.type === "results") &&
            events.some((e) => e.type === "exit"),
          90_000
        );

        const resultsEvent = sub.events.find((e) => e.type === "results")!;
        const panes = resultsEvent.panes as Array<Record<string, unknown>>;
        expect(panes).toHaveLength(1);
        expect(panes[0].state).toBe("completed");
        expect(panes[0].exitCode).toBe(0);
        expect(panes[0].dead).toBe(true);

        const exitEvent = sub.events.find((e) => e.type === "exit")!;
        expect(exitEvent.exitCode).toBe(0);
      } finally {
        await sub?.close();
        handle.kill("SIGKILL");
        grid.cleanup();
      }
    },
    E2E_TIMEOUT
  );

  it(
    "interactive mode: pane running real Claude Code reaches awaiting_input",
    async () => {
      // Launch Claude Code directly (not via claudish). This lets us validate
      // magmux's ClaudeCodeController integration — the controller watches
      // ~/.claude/projects/<cwd>/*.jsonl for the session transcript and
      // reports awaiting_input once the stop_hook_summary arrives.
      const prompt = "reply with only the word hello";
      const grid = writeGridfile([
        `claude --dangerously-skip-permissions ${JSON.stringify(prompt)}`,
      ]);
      const baseline = snapshotMagmuxSockets();

      const handle = runInPty({
        command: [magmuxPath, "-g", grid.path],
      });

      let sub: MagmuxSubscription | null = null;
      try {
        sub = await subscribeToMagmuxSocket({ baseline, timeoutMs: 5_000 });

        // Wait for the controller to report awaiting_input via a snapshot
        // event (that's the DONE-equivalent for a running Claude Code TUI).
        await sub.waitFor(
          (events) =>
            events.some(
              (e) =>
                e.type === "snapshot" && e.state === "awaiting_input"
            ),
          120_000
        );

        // At least one snapshot should carry the controller name and some
        // content (response or tool). Magmux's ClaudeCodeController parses
        // the JSONL transcript in real time.
        const snap = sub.events.find(
          (e) => e.type === "snapshot" && e.state === "awaiting_input"
        );
        expect(snap).toBeDefined();
        expect(snap!.controller).toBe("claude-code");

        // Now send 'q' so magmux gracefully shuts down.
        handle.send("q");

        await sub.waitFor(
          (events) => events.some((e) => e.type === "shutdown"),
          15_000
        );

        // Magmux's shutdown-time results should include the pane as
        // completed or awaiting_input.
        const resultsEvent = sub.events.find((e) => e.type === "results")!;
        const panes = resultsEvent.panes as Array<Record<string, unknown>>;
        expect(panes).toHaveLength(1);
        const state = String(panes[0].state);
        expect(["completed", "awaiting_input"]).toContain(state);
      } finally {
        await sub?.close();
        handle.kill("SIGKILL");
        grid.cleanup();
      }
    },
    E2E_TIMEOUT + 30_000
  );
});
