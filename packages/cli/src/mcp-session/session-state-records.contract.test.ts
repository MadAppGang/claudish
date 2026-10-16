// packages/cli/src/channel/session-state-records.contract.test.ts
/**
 * Black-box contract tests for the state model as it reaches disk: the wait log
 * `waits.jsonl` (design §3.2, §3.3 "waits.jsonl"; §8.1 tests 1-4).
 *
 * Each test starts a real claudish MCP server (`bun src/index.ts --mcp`) over stdio with a
 * temp CLAUDISH_SESSIONS_DIR, HOME and CLAUDE_CONFIG_DIR. Every session is an interactive
 * pane: the pane fake (marker mode) via CLAUDISH_BIN, in a real headless magmux under the
 * test's own CLAUDISH_PANE_ROOT. No model, no network. Ported per architecture §20.2: only
 * the adapters and the fake changed; the three cases about 10.4.0's `finishing` state are
 * replaced (RB1, D17, D23), and the promptless cases wait for boot first (RB2). After each
 * test no pane process or file may remain.
 *
 * The records on disk are the primary evidence: `waits.jsonl` gains an `open` line on every
 * transition into a wait, so its absence proves a session never waited.
 * INFERRED: get_diagnostics reports the live channel event in an `event` field (adapter
 * `sessionStatus` in contract-mcp.ts, RB7).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  MAGMUX_AVAILABLE,
  McpServer,
  NO_MAGMUX_MESSAGE,
  createSession,
  paneOrphans,
  paneRootOf,
  sendInput,
  serverEnv,
  sessionStatus,
  sessionTool,
} from "../test-helpers/contract-mcp.js";
import {
  type TempLayout,
  entries,
  makeTempLayout,
  readJson,
  readWaitLines,
  waitFor,
  waitPairingViolations,
} from "../test-helpers/contract-records.js";

const T_TEST = 30_000;
/** Boot (≈ 2 s with the fake) plus the answer, with room for a loaded machine. */
const BOOT_MS = 15_000;

let layout: TempLayout;
let server: McpServer;

if (!MAGMUX_AVAILABLE) console.warn(NO_MAGMUX_MESSAGE);

beforeEach(async () => {
  layout = makeTempLayout("state");
  server = await McpServer.start({ env: serverEnv(layout), cwd: layout.cwd });
});
afterEach(async () => {
  await server.close();
  const report = await paneOrphans(layout);
  layout.cleanup();
  expect(report).toEqual({ processes: [], files: [] });
}, 40_000);

const dirOf = (id: string) => join(layout.sessionsDir, id);

async function terminalMeta(id: string, timeoutMs = BOOT_MS): Promise<Record<string, unknown>> {
  return waitFor(
    () => {
      const meta = readJson(join(dirOf(id), "meta.json"));
      return meta && ["completed", "failed", "timeout", "cancelled"].includes(String(meta.status))
        ? meta
        : undefined;
    },
    { what: `a terminal meta.json for ${id}`, timeoutMs }
  );
}

async function created(args: Parameters<typeof createSession>[1]): Promise<string> {
  const { sessionId, result } = await createSession(server, args);
  expect(result.isError).toBe(false);
  expect(typeof sessionId).toBe("string");
  return sessionId as string;
}

/** RB2: a promptless session waits once boot is ready (STARTING before). */
async function bootedPromptless(): Promise<string> {
  const id = await created({});
  await waitFor(() => readWaitLines(dirOf(id))?.length === 1, {
    what: "the first open line (boot ready)",
    timeoutMs: BOOT_MS,
    intervalMs: 2,
  });
  return id;
}

/** The session's `list_sessions` row. */
async function rowOf(id: string): Promise<Record<string, unknown> | undefined> {
  const r = await server.callTool("list_sessions", { include_completed: true });
  const rows = (r.json?.sessions ?? []) as Array<Record<string, unknown>>;
  return rows.find((row) => row.session_id === id);
}

describe.skipIf(!MAGMUX_AVAILABLE)(
  "REQ-9 a one-shot session ends at its verdict and never waits",
  () => {
    test(
      "a prompted session completes and leaves no waits.jsonl",
      async () => {
        const id = await created({ prompt: "say hello" });

        const meta = await terminalMeta(id);

        expect(meta.status).toBe("completed");
        expect(existsSync(join(dirOf(id), "waits.jsonl"))).toBe(false);
      },
      T_TEST
    );

    test(
      "a prompted session with a tool call completes and leaves no waits.jsonl",
      async () => {
        const id = await created({ prompt: "use a tool @@TOOL@@" });

        const meta = await terminalMeta(id);

        expect(meta.status).toBe("completed");
        expect(existsSync(join(dirOf(id), "waits.jsonl"))).toBe(false);
      },
      T_TEST
    );

    // Replaced (RB1): 10.4.0's "between its final result and the child's exit the session reads
    // finishing, then completed". A pane session decides a one-shot verdict at settle, so the
    // exiting interval does not exist; the end-of-turn wait is `activity:"finishing"` on RUNNING.
    test(
      "RB1 a one-shot session goes running → completed with no wait, and meta.json is written before its pane is reaped",
      async () => {
        const id = await created({
          prompt: "answer, then take a while to end the turn @@LINGER@@",
        });
        const seen: string[] = [];
        const panes = join(paneRootOf(layout), "panes");
        let paneRecordsAtMeta = -1;

        await waitFor(
          async () => {
            if (paneRecordsAtMeta < 0 && readJson(join(dirOf(id), "meta.json")))
              paneRecordsAtMeta = entries(panes).length;
            const s = await sessionStatus(server, id);
            if (s && seen[seen.length - 1] !== s) seen.push(s);
            return s === "completed" ? s : undefined;
          },
          { what: "the session to complete", timeoutMs: BOOT_MS, intervalMs: 5 }
        );
        await waitFor(
          () => {
            if (paneRecordsAtMeta < 0 && readJson(join(dirOf(id), "meta.json")))
              paneRecordsAtMeta = entries(panes).length;
            return paneRecordsAtMeta >= 0;
          },
          { what: "meta.json", intervalMs: 2 }
        );

        expect(seen).toContain("running");
        expect(seen[seen.length - 1]).toBe("completed");
        expect(seen).not.toContain("finishing");
        expect(seen).not.toContain("waiting_for_input");
        expect(paneRecordsAtMeta).toBe(1);
        expect(existsSync(join(dirOf(id), "waits.jsonl"))).toBe(false);
      },
      T_TEST
    );

    // Replaced (D17): 10.4.0's "a finishing session refuses send_input and still completes without
    // waiting". send_input is accepted in every non-terminal state; only a terminal one refuses.
    test(
      "D17 a send after a one-shot's verdict is refused terminal; a send while its activity is finishing is queued, converts it, and is answered as turn 2",
      async () => {
        const done = await created({ prompt: "say hello" });
        await terminalMeta(done);
        const refused = await sendInput(server, done, "too late");
        expect(refused.json).toMatchObject({ success: false, reason: "terminal" });

        const id = await created({ prompt: "answer, then linger @@LINGER@@" });
        await waitFor(async () => (await rowOf(id))?.activity === "finishing", {
          what: "activity finishing",
          timeoutMs: BOOT_MS,
          intervalMs: 20,
        });
        const accepted = await sendInput(server, id, "second question");
        expect(accepted.json).toMatchObject({ success: true });

        const row = await waitFor(
          async () => {
            const r = await rowOf(id);
            return r?.turns_completed === 2 && r.state === "AWAITING_INPUT" ? r : undefined;
          },
          { what: "turn 2 answered", timeoutMs: BOOT_MS }
        );
        const output = await sessionTool(server, "get_output", id);
        const lines = readWaitLines(dirOf(id)) ?? [];

        expect(row.state).toBe("AWAITING_INPUT");
        expect((String(output.json?.output).match(/ANSWER /g) ?? []).length).toBe(2);
        // The send was queued behind turn 1, so no wait opened between the turns (net of the pump).
        expect(lines.map((l) => [l.wait, l.turns])).toEqual([["open", 2]]);
        await sessionTool(server, "cancel_session", id);
      },
      T_TEST
    );

    // Replaced (D23, §2.8): 10.4.0's "frames after the final result do not reopen the session;
    // diagnostics name the refused state". A re-wake is part of the same turn, not a late frame.
    test(
      "D23 a re-wake after the answer stays in the same turn, opens no wait, and turnsCompleted is 1",
      async () => {
        const id = await created({ prompt: "answer, then wake again @@LATE@@" });

        const meta = await terminalMeta(id);
        const output = await sessionTool(server, "get_output", id);

        expect(meta.status).toBe("completed");
        expect(meta.turnsCompleted).toBe(1);
        expect(String(output.json?.output)).toContain("LATE second message");
        expect(existsSync(join(dirOf(id), "waits.jsonl"))).toBe(false);
      },
      T_TEST
    );
  }
);

describe.skipIf(!MAGMUX_AVAILABLE)(
  "REQ-11/REQ-14 a promptless session waits once boot is ready, and every wait is logged",
  () => {
    test(
      "RB2 it is waiting_for_input once boot is ready, with one open line (turns 0), and the child's own activity does not end the wait",
      async () => {
        const id = await bootedPromptless();

        const status = await sessionStatus(server, id);
        await Bun.sleep(1_000);
        const lines = readWaitLines(dirOf(id));
        const statusLater = await sessionStatus(server, id);

        expect(status).toBe("waiting_for_input");
        expect(statusLater).toBe("waiting_for_input");
        expect(lines).toHaveLength(1);
        expect(lines?.[0]).toEqual({ wait: "open", since: expect.any(String), turns: 0 });
      },
      T_TEST
    );

    test(
      "send_input closes the wait to running; the next result opens a new wait with turns already counted",
      async () => {
        const id = await bootedPromptless();

        expect((await sendInput(server, id, "first question")).isError).toBe(false);
        const afterFirstTurn = await waitFor(
          () => (readWaitLines(dirOf(id))?.length === 3 ? readWaitLines(dirOf(id)) : undefined),
          { what: "open, closed, open", timeoutMs: BOOT_MS }
        );
        expect(await sessionStatus(server, id)).toBe("waiting_for_input");
        expect((await sendInput(server, id, "second question")).isError).toBe(false);
        const afterSecondInput = await waitFor(
          () => {
            const l = readWaitLines(dirOf(id));
            return l && l.length >= 4 ? l : undefined;
          },
          { what: "the second closed line", timeoutMs: BOOT_MS }
        );

        expect(afterFirstTurn.map((l) => l.wait)).toEqual(["open", "closed", "open"]);
        expect(afterFirstTurn[0].turns).toBe(0);
        expect(afterFirstTurn[1]).toEqual({
          wait: "closed",
          since: afterFirstTurn[0].since,
          at: expect.any(String),
          to: "running",
        });
        expect(afterFirstTurn[2].turns).toBe(1);
        expect(afterSecondInput[3]).toEqual({
          wait: "closed",
          since: afterFirstTurn[2].since,
          at: expect.any(String),
          to: "running",
        });
        expect(waitPairingViolations(afterSecondInput, true)).toEqual([]);
      },
      T_TEST
    );

    // RB2: a send during boot is queued and becomes the first prompt, so no wait opens; the
    // shortest real wait starts at boot-ready, so the send follows the open line at once.
    test(
      "a wait that opens and closes within milliseconds still leaves both lines",
      async () => {
        const id = await bootedPromptless();
        await sendInput(server, id, "immediately");

        const lines = await waitFor(
          () => {
            const l = readWaitLines(dirOf(id));
            return l && l.length >= 2 ? l : undefined;
          },
          { what: "both lines of the short wait", timeoutMs: BOOT_MS }
        );

        expect(lines.slice(0, 2).map((l) => [l.wait, l.to])).toEqual([
          ["open", undefined],
          ["closed", "running"],
        ]);
        expect(lines[1].since).toBe(lines[0].since);
      },
      T_TEST
    );
  }
);

describe.skipIf(!MAGMUX_AVAILABLE)("REQ-14 no wait is left open beside a meta.json", () => {
  test(
    "cancel_session closes the open wait (to: cancelled) before meta.json exists",
    async () => {
      const id = await bootedPromptless();

      await sessionTool(server, "cancel_session", id);
      const meta = await terminalMeta(id);
      const lines = readWaitLines(dirOf(id)) ?? [];

      expect(meta.status).toBe("cancelled");
      expect(lines.map((l) => l.wait)).toEqual(["open", "closed"]);
      expect(lines[1].to).toBe("cancelled");
      expect(waitPairingViolations(lines, false)).toEqual([]);
    },
    T_TEST
  );

  // RB2: a timeout that expires during boot opens no wait; 5 s lets the session boot and wait.
  test(
    "a session timeout closes the open wait (to: timeout)",
    async () => {
      const id = await created({ timeout_seconds: 5 });

      const meta = await terminalMeta(id, 20_000);
      const lines = readWaitLines(dirOf(id)) ?? [];

      expect(meta.status).toBe("timeout");
      expect(lines.map((l) => l.wait)).toEqual(["open", "closed"]);
      expect(lines[1].to).toBe("timeout");
      expect(waitPairingViolations(lines, false)).toEqual([]);
    },
    T_TEST
  );

  test(
    "the moment meta.json first parses, the wait log is already closed",
    async () => {
      const id = await bootedPromptless();
      const cancelling = sessionTool(server, "cancel_session", id).catch(() => undefined);

      const linesWhenMetaAppeared = await waitFor(
        () =>
          readJson(join(dirOf(id), "meta.json")) ? (readWaitLines(dirOf(id)) ?? []) : undefined,
        { what: "meta.json", timeoutMs: 10_000, intervalMs: 2 }
      );
      await cancelling;

      expect(waitPairingViolations(linesWhenMetaAppeared, false)).toEqual([]);
    },
    T_TEST
  );

  test(
    "a prompted session cancelled mid-turn never waited, so it has no waits.jsonl",
    async () => {
      const id = await created({ prompt: "never answer @@HANG@@" });
      await waitFor(async () => (await sessionStatus(server, id)) === "running", {
        what: "running",
        timeoutMs: BOOT_MS,
      });

      await sessionTool(server, "cancel_session", id);
      const meta = await terminalMeta(id);

      expect(meta.status).toBe("cancelled");
      expect(existsSync(join(dirOf(id), "waits.jsonl"))).toBe(false);
    },
    T_TEST
  );
});
