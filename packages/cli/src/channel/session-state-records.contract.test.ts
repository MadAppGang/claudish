// packages/cli/src/channel/session-state-records.contract.test.ts
/**
 * Black-box contract tests for the state model as it reaches disk: `finishing`, and the wait
 * log `waits.jsonl` (design §3.2, §3.3 "waits.jsonl"; §8.1 tests 1-4).
 *
 * Each test starts a real claudish MCP server (`bun src/index.ts --mcp`) over stdio with a
 * temp CLAUDISH_SESSIONS_DIR, HOME and CLAUDE_CONFIG_DIR, and CLAUDISH_BIN pointing at the
 * stream-json fake in test-helpers/contract-fake-child.ts. No model, no network.
 *
 * The records on disk are the primary evidence: `waits.jsonl` gains an `open` line on every
 * transition into waiting_for_input, so its absence proves a session never waited.
 * INFERRED: get_diagnostics reports the live state in a `status` field (adapter in contract-mcp.ts).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  McpServer,
  createSession,
  sendInput,
  serverEnv,
  sessionStatus,
  sessionTool,
} from "../test-helpers/contract-mcp.js";
import {
  type TempLayout,
  makeTempLayout,
  readJson,
  readWaitLines,
  waitFor,
  waitPairingViolations,
} from "../test-helpers/contract-records.js";

const T_TEST = 30_000;

let layout: TempLayout;
let server: McpServer;

beforeEach(async () => {
  layout = makeTempLayout("state");
  server = await McpServer.start({ env: serverEnv(layout), cwd: layout.cwd });
});
afterEach(async () => {
  await server.close();
  layout.cleanup();
});

const dirOf = (id: string) => join(layout.sessionsDir, id);

async function terminalMeta(id: string, timeoutMs = 10_000): Promise<Record<string, unknown>> {
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

describe("REQ-9 a one-shot session ends through finishing and never waits", () => {
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

  test(
    "between its final result and the child's exit the session reads finishing, then completed",
    async () => {
      const id = await created({ prompt: "answer, then take a while to exit @@LINGER@@" });
      const seen: string[] = [];

      await waitFor(
        async () => {
          const s = await sessionStatus(server, id);
          if (s && seen[seen.length - 1] !== s) seen.push(s);
          return s === "completed" ? s : undefined;
        },
        { what: "the session to complete", timeoutMs: 10_000, intervalMs: 50 }
      );

      expect(seen).toContain("finishing");
      expect(seen).not.toContain("waiting_for_input");
      expect(seen.indexOf("finishing")).toBeLessThan(seen.indexOf("completed"));
      expect(existsSync(join(dirOf(id), "waits.jsonl"))).toBe(false);
    },
    T_TEST
  );

  test(
    "REQ-13 a finishing session refuses send_input and still completes without waiting",
    async () => {
      const id = await created({ prompt: "answer, then linger @@LINGER@@" });
      await waitFor(async () => (await sessionStatus(server, id)) === "finishing", {
        what: "the finishing state",
        timeoutMs: 10_000,
        intervalMs: 20,
      });

      const refused = await sendInput(server, id, "too late");
      const meta = await terminalMeta(id);

      expect(refused.isError || /false|closed|not accept|cannot|refus/i.test(refused.text)).toBe(
        true
      );
      expect(meta.status).toBe("completed");
      expect(existsSync(join(dirOf(id), "waits.jsonl"))).toBe(false);
    },
    T_TEST
  );

  test(
    "REQ-12 frames after the final result do not reopen the session; diagnostics name the refused state",
    async () => {
      const id = await created({ prompt: "answer, then misbehave @@LATE@@" });

      const meta = await terminalMeta(id);
      const diagnostics = await sessionTool(server, "get_diagnostics", id);

      expect(meta.status).toBe("completed");
      expect(existsSync(join(dirOf(id), "waits.jsonl"))).toBe(false);
      // INFERRED: the recorded anomaly names the state the frame arrived in.
      expect(diagnostics.text).toContain("finishing");
    },
    T_TEST
  );
});

describe("REQ-11/REQ-14 a promptless session waits from creation, and every wait is logged", () => {
  test(
    "it is waiting_for_input once created, with one open line (turns 0), and the child's init does not end the wait",
    async () => {
      const id = await created({});

      const status = await sessionStatus(server, id);
      // The fake child emits system:init as soon as it starts; give it ample time to arrive.
      await Bun.sleep(1_000);
      const lines = readWaitLines(dirOf(id));
      const statusAfterInit = await sessionStatus(server, id);

      expect(status).toBe("waiting_for_input");
      expect(statusAfterInit).toBe("waiting_for_input");
      expect(lines).toHaveLength(1);
      expect(lines?.[0]).toEqual({ wait: "open", since: expect.any(String), turns: 0 });
    },
    T_TEST
  );

  test(
    "send_input closes the wait to running; the next result opens a new wait with turns already counted",
    async () => {
      const id = await created({});

      expect((await sendInput(server, id, "first question")).isError).toBe(false);
      const afterFirstTurn = await waitFor(
        () => (readWaitLines(dirOf(id))?.length === 3 ? readWaitLines(dirOf(id)) : undefined),
        {
          what: "open, closed, open",
        }
      );
      expect(await sessionStatus(server, id)).toBe("waiting_for_input");
      expect((await sendInput(server, id, "second question")).isError).toBe(false);
      const afterSecondInput = await waitFor(
        () => {
          const l = readWaitLines(dirOf(id));
          return l && l.length >= 4 ? l : undefined;
        },
        { what: "the second closed line" }
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

  test(
    "a wait that opens and closes within milliseconds still leaves both lines",
    async () => {
      const id = await created({});
      await sendInput(server, id, "immediately");

      const lines = await waitFor(
        () => {
          const l = readWaitLines(dirOf(id));
          return l && l.length >= 2 ? l : undefined;
        },
        { what: "both lines of the short wait" }
      );

      expect(lines.slice(0, 2).map((l) => [l.wait, l.to])).toEqual([
        ["open", undefined],
        ["closed", "running"],
      ]);
      expect(lines[1].since).toBe(lines[0].since);
    },
    T_TEST
  );
});

describe("REQ-14 no wait is left open beside a meta.json", () => {
  test(
    "cancel_session closes the open wait (to: cancelled) before meta.json exists",
    async () => {
      const id = await created({});
      await waitFor(() => readWaitLines(dirOf(id))?.length === 1, { what: "the open line" });

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

  test(
    "a session timeout closes the open wait (to: timeout)",
    async () => {
      const id = await created({ timeout_seconds: 1 });

      const meta = await terminalMeta(id, 15_000);
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
      const id = await created({});
      await waitFor(() => readWaitLines(dirOf(id))?.length === 1, { what: "the open line" });
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
      });

      await sessionTool(server, "cancel_session", id);
      const meta = await terminalMeta(id);

      expect(meta.status).toBe("cancelled");
      expect(existsSync(join(dirOf(id), "waits.jsonl"))).toBe(false);
    },
    T_TEST
  );
});
