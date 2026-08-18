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

import { beforeAll, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  type MagmuxSubscription,
  findMagmuxForTest,
  runHeadless,
  runInPty,
  snapshotMagmuxSockets,
  stripAnsi,
  subscribeToMagmuxSocket,
  writeGridfile,
} from "./team-grid.e2e-helpers.js";
import { hasAnyCredential } from "./test-helpers/credential-gate.js";
import {
  PROVIDER_QUOTA_GUIDANCE,
  isConfirmedProviderQuotaError,
} from "./test-helpers/provider-quota.js";

const E2E_TIMEOUT = 150_000; // per real-model test (includes cold-start slack)

let magmuxPath = "";

// The interactive-mode test launches REAL `claude` in a pane and waits for its
// ClaudeCodeController to reach `awaiting_input` — which only happens once
// `claude` actually processes the prompt, i.e. is authenticated. On a machine
// with no headless-usable credential (`claude -p` prints "Not logged in") the
// pane never gets past the login screen and the test would sit at its 120s
// wait, so gate it on a real auth probe and SKIP with a clear reason instead.
// (The sibling "default mode" test drives claudish, not `claude`, so it is
// unaffected.) One tiny headless prompt; a login/credential error → not usable.
async function probeClaudeUsable(): Promise<boolean> {
  try {
    const probe = spawn("claude", ["-p", "--dangerously-skip-permissions", "--bare", "hi"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    probe.stdout?.on("data", (c: Buffer) => {
      out += c.toString();
    });
    probe.stderr?.on("data", (c: Buffer) => {
      out += c.toString();
    });
    const code = await new Promise<number>((r) => {
      const t = setTimeout(() => {
        probe.kill("SIGTERM");
        r(-1);
      }, 30_000);
      probe.on("exit", (c) => {
        clearTimeout(t);
        r(c ?? 1);
      });
      probe.on("error", () => {
        clearTimeout(t);
        r(1);
      });
    });
    return code === 0 && !/not logged in|please run \/login|invalid api key/i.test(out);
  } catch {
    return false;
  }
}

const claudeUsable = await probeClaudeUsable();
if (!claudeUsable) {
  console.warn(
    "[team-grid.e2e] interactive-mode test SKIPPED — `claude -p` is unavailable or not " +
      "authenticated (needs ANTHROPIC_API_KEY or a headless-usable claude.ai login)."
  );
}

// The default-mode test runs a REAL model (glm-5-turbo) through claudish in a
// pane and asserts the pane completes. With no credential able to serve that
// model, claudish exits non-zero within ~250ms and magmux reports the pane as
// `failed` — a missing-key environment, not a regression. Gate on the providers
// that can actually serve glm-5-turbo: GLM/Z.AI direct, the coding plans, or
// OpenRouter as the aggregator fallback. Asked via claudish's OWN credential
// authority, so a key configured in ~/.claudish/config.json or 1Password counts
// exactly as it does for a real run — not just a raw env var.
const glmCapable = await hasAnyCredential(["glm", "glm-coding", "z-ai", "openrouter"]);
if (!glmCapable) {
  console.warn(
    "[team-grid.e2e] default-mode test SKIPPED — claudish has no credential that can " +
      "serve glm-5-turbo (glm / glm-coding / z-ai / openrouter, via env, " +
      "~/.claudish/config.json apiKeys, or 1Password)."
  );
}

describe("runInPty terminal size", () => {
  // A 0x0 pty made magmux subtract its status line and report the misleading 0x-1 size.
  it.skipIf(Bun.which("expect") === null)("gives the spawned pty a non-zero size", async () => {
    let output = "";
    const handle = runInPty({
      command: ["stty", "size"],
      onData: (chunk) => {
        output += chunk;
      },
    });

    const { code } = await handle.waitForExit();
    expect(code).toBe(0);

    const normalized = output.replace(/\r/g, "");
    expect(normalized).toMatch(/\d+\s+\d+/);

    const dimensions = normalized.match(/(\d+)\s+(\d+)/);
    expect(dimensions).not.toBeNull();
    const rows = Number(dimensions![1]);
    const cols = Number(dimensions![2]);
    expect(rows).toBeGreaterThan(0);
    expect(cols).toBeGreaterThan(0);
    // PTY_ROWS and PTY_COLS are private helper details, so exact values are not checked here.
  });
});

// ─── Fast tier: socket protocol ──────────────────────────────────────────────

describe("magmux socket protocol (shell commands)", () => {
  beforeAll(() => {
    if (!magmuxPath) magmuxPath = findMagmuxForTest();
  });

  const commandPanes = (event: Record<string, unknown>) =>
    (event.panes as Array<Record<string, unknown>>).filter((pane) => pane.control !== true);

  it("broadcasts snapshot, exit, results, shutdown for a short-lived pane", async () => {
    // A pane that prints one line then exits. We sleep for 2s before
    // exiting to give the test's socket subscriber enough time to connect
    // before magmux starts emitting events. `-w` makes magmux auto-quit
    // as soon as the pane is "done".
    const grid = writeGridfile([`echo 'hello from test pane'; sleep 2`]);
    const id = `e2e-${randomUUID().slice(0, 8)}`;

    const handle = runHeadless({
      command: [magmuxPath, "--id", id, "-g", grid.path, "-w"],
    });

    let sub: MagmuxSubscription | null = null;
    try {
      // Wait briefly for magmux to create its socket.
      sub = await subscribeToMagmuxSocket(`/tmp/magmux-${id}.sock`);

      // The shutdown event is the canonical "we're about to close" signal.
      await sub.waitFor((events) => events.some((e) => e.type === "shutdown"), 15_000);

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
      const rawPanes = resultsEvent.panes as Array<Record<string, unknown>>;
      // magmux always reports a control panel; claudish filters it in withoutControlPanes().
      expect(rawPanes.filter((pane) => pane.control === true)).toHaveLength(1);
      const panes = commandPanes(resultsEvent);
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
  }, 30_000);

  it("marks a failed pane as failed in the results event", async () => {
    // Sleep first so the subscriber has time to attach, then fail.
    const grid = writeGridfile([`sleep 2; echo 'oops' >&2; exit 37`]);
    const id = `e2e-${randomUUID().slice(0, 8)}`;

    const handle = runHeadless({
      command: [magmuxPath, "--id", id, "-g", grid.path, "-w"],
    });

    let sub: MagmuxSubscription | null = null;
    try {
      sub = await subscribeToMagmuxSocket(`/tmp/magmux-${id}.sock`);
      await sub.waitFor((events) => events.some((e) => e.type === "results"), 15_000);

      const resultsEvent = sub.events.find((e) => e.type === "results")!;
      const panes = commandPanes(resultsEvent);
      expect(panes).toHaveLength(1);
      expect(panes[0].state).toBe("failed");
      expect(panes[0].exitCode).toBe(37);
    } finally {
      await sub?.close();
      handle.kill("SIGKILL");
      grid.cleanup();
    }
  }, 30_000);

  it("handles multiple panes and reports per-pane state", async () => {
    const grid = writeGridfile([`echo 'pane0 ok'; sleep 2`, `echo 'pane1 ok'; sleep 2`]);
    const id = `e2e-${randomUUID().slice(0, 8)}`;

    const handle = runHeadless({
      command: [magmuxPath, "--id", id, "-g", grid.path, "-w"],
    });

    let sub: MagmuxSubscription | null = null;
    try {
      sub = await subscribeToMagmuxSocket(`/tmp/magmux-${id}.sock`);
      await sub.waitFor((events) => events.some((e) => e.type === "results"), 15_000);

      const resultsEvent = sub.events.find((e) => e.type === "results")!;
      const panes = commandPanes(resultsEvent).sort(
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
  }, 30_000);

  it("pushes exit events in order of pane completion", async () => {
    // pane1 finishes before pane0 — ensures broadcast ordering matches
    // real completion time, not gridfile order.
    // pane1 is fast, pane0 is slow. Both sleep enough that subscribe
    // beats them to the punch.
    const grid = writeGridfile([`sleep 3; echo 'slow'`, `sleep 1; echo 'fast'`]);
    const id = `e2e-${randomUUID().slice(0, 8)}`;

    const handle = runHeadless({
      command: [magmuxPath, "--id", id, "-g", grid.path, "-w"],
    });

    let sub: MagmuxSubscription | null = null;
    try {
      sub = await subscribeToMagmuxSocket(`/tmp/magmux-${id}.sock`);
      await sub.waitFor((events) => events.filter((e) => e.type === "exit").length === 2, 15_000);

      const exits = sub.events.filter((e) => e.type === "exit");
      // pane 1 (the fast one) should exit first.
      expect(exits[0].pane).toBe(1);
      expect(exits[1].pane).toBe(0);
    } finally {
      await sub?.close();
      handle.kill("SIGKILL");
      grid.cleanup();
    }
  }, 30_000);
});

// ─── Fast tier: crash fallback ───────────────────────────────────────────────

describe("magmux crash fallback", () => {
  beforeAll(() => {
    if (!magmuxPath) magmuxPath = findMagmuxForTest();
  });

  it("SIGKILL before results event → no results received", async () => {
    // A long-lived pane so we can kill before completion.
    const grid = writeGridfile(["sleep 30"]);
    const id = `e2e-${randomUUID().slice(0, 8)}`;

    const handle = runHeadless({
      command: [magmuxPath, "--id", id, "-g", grid.path],
    });

    let sub: MagmuxSubscription | null = null;
    try {
      sub = await subscribeToMagmuxSocket(`/tmp/magmux-${id}.sock`);

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
  }, 30_000);
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

describe("claudish team with real models and Claude Code", () => {
  beforeAll(() => {
    if (!magmuxPath) magmuxPath = findMagmuxForTest();
  });

  const commandPanes = (event: Record<string, unknown>) =>
    (event.panes as Array<Record<string, unknown>>).filter((pane) => pane.control !== true);

  it.skipIf(!glmCapable)(
    "default mode: pane runs a real model, magmux emits completed results",
    async () => {
      const grid = writeGridfile([
        devClaudishCommand("glm-5-turbo", "reply with only the word hello"),
      ]);
      const baseline = snapshotMagmuxSockets();
      let paneOutput = "";

      const handle = runInPty({
        command: [magmuxPath, "-g", grid.path, "-w"],
        onData: (chunk) => {
          paneOutput += chunk;
        },
      });

      let sub: MagmuxSubscription | null = null;
      try {
        sub = await subscribeToMagmuxSocket({ baseline, timeoutMs: 5_000 });

        // Give the real model call up to 180s. glm-5-turbo usually responds
        // in 5–15s; we allow extra headroom for cold starts and rate limits.
        try {
          await sub.waitFor(
            (events) =>
              events.some((e) => e.type === "results") && events.some((e) => e.type === "exit"),
            180_000
          );
        } catch (error) {
          const cleanedPaneOutput = stripAnsi(paneOutput);
          if (isConfirmedProviderQuotaError(cleanedPaneOutput)) {
            console.warn(
              `[team-grid.e2e] glm-5-turbo SKIPPED — ${PROVIDER_QUOTA_GUIDANCE}; ` +
                "the pane reported HTTP 429 and/or insufficient balance."
            );
            return;
          }

          const outputTail = cleanedPaneOutput.slice(-2_000) || "<no pane output captured>";
          const diagnostic = `\n\nCaptured pane output (last ~2000 chars):\n${outputTail}`;
          if (error instanceof Error) {
            error.message += diagnostic;
            throw error;
          }
          throw new Error(`${String(error)}${diagnostic}`);
        }

        const resultsEvent = sub.events.find((e) => e.type === "results")!;
        const panes = commandPanes(resultsEvent);
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
    E2E_TIMEOUT + 60_000
  );

  it.skipIf(!claudeUsable)(
    "interactive mode: pane running real Claude Code reaches awaiting_input",
    async () => {
      // Launch Claude Code directly (not via claudish) to validate magmux's
      // ClaudeCodeController integration: it watches
      // ~/.claude/projects/<cwd>/*.jsonl and tracks the live session to
      // `awaiting_input` once claude has answered and is sitting at its prompt.
      //
      // HOW MAGMUX REPORTS THIS (verified against magmux v3.4.2 and v0.4.3):
      // it first emits an empty aggregate `snapshot` (`panes: []`), then a
      // per-pane `snapshot` when the pane starts (state "starting"). It reports
      // the pane's TERMINAL state only in the `results` event. There is NO
      // per-transition `snapshot` broadcast — so the old wait, `snapshot &&
      // state === "awaiting_input"`, could never be satisfied and burned its
      // full 120s timeout on every run. The controller was working the whole
      // time; the test was watching the wrong event type.
      //
      // `-w` makes magmux auto-quit once every pane is DONE. For a Claude Code
      // pane "done" IS awaiting_input — claude has answered and is idle at the
      // prompt, still ALIVE (dead:false) — so this observes the controller's
      // terminal state deterministically, in ~6s, with no keystroke needed.
      const prompt = "reply with only the word hello";
      const grid = writeGridfile([
        `claude --dangerously-skip-permissions ${JSON.stringify(prompt)}`,
      ]);
      const baseline = snapshotMagmuxSockets();

      const handle = runInPty({
        command: [magmuxPath, "-g", grid.path, "-w"],
      });

      let sub: MagmuxSubscription | null = null;
      try {
        sub = await subscribeToMagmuxSocket({ baseline, timeoutMs: 5_000 });

        // magmux auto-quits when the pane is done → results + shutdown.
        await sub.waitFor((events) => events.some((e) => e.type === "results"), 90_000);

        // The start snapshot is best-effort: magmux broadcasts only to clients
        // already connected, so under load the subscriber can attach after this
        // per-pane event. If observed, it must still identify the controller;
        // the results event below is the reliable, load-bearing proof.
        const startSnap = sub.events.find((e) => e.type === "snapshot" && e.pane === 0);
        if (startSnap) {
          expect(startSnap.controller).toBe("claude-code");
        }

        // The load-bearing assertion: the ClaudeCodeController tracked a REAL
        // Claude Code session, via its JSONL transcript, all the way to
        // awaiting_input.
        const resultsEvent = sub.events.find((e) => e.type === "results")!;
        const panes = commandPanes(resultsEvent);
        expect(panes).toHaveLength(1);
        expect(panes[0].controller).toBe("claude-code");
        expect(panes[0].state).toBe("awaiting_input");
        // awaiting_input is NOT process exit — claude is still alive at its
        // prompt. This is what distinguishes it from the `completed` state a
        // one-shot pane reports, and it is the whole point of the controller.
        expect(panes[0].dead).toBe(false);
      } finally {
        await sub?.close();
        handle.kill("SIGKILL");
        grid.cleanup();
      }
    },
    E2E_TIMEOUT + 30_000
  );
});
