// packages/cli/src/channel/session-records.contract.test.ts
/**
 * The record half that the 10.4.0 suites assume and pane sessions must now produce
 * (architecture §12.3, §20.1): `meta.json` keeps every 10.4.0 key with its 10.4.0 type,
 * `events.jsonl` has exactly one `assistant` line per main-chain message id (the magus
 * monitor's reply rule), a question or a permission dialog opens and closes one wait, a
 * re-wake keeps its turn, a queued send opens no wait between turns, and a cancelled team
 * slot's `status.json` row says why.
 *
 * A real claudish MCP server over stdio; every session is the pane fake in a real headless
 * magmux under the test's own CLAUDISH_PANE_ROOT. After each test no pane process or file
 * may remain.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FAILURE_REASONS } from "../pane/index.js";
import {
  MAGMUX_AVAILABLE,
  McpServer,
  NO_MAGMUX_MESSAGE,
  createSession,
  paneOrphans,
  sendInput,
  serverEnv,
  sessionTool,
  teamCall,
} from "../test-helpers/contract-mcp.js";
import {
  type TempLayout,
  makeTempLayout,
  readJson,
  readWaitLines,
  waitFor,
  waitPairingViolations,
} from "../test-helpers/contract-records.js";
import { toMetaRecord } from "./session-manager.js";
import type { SessionInfo } from "./types.js";

const T_TEST = 40_000;
const BOOT_MS = 15_000;

let layout: TempLayout;
let server: McpServer;

if (!MAGMUX_AVAILABLE) console.warn(NO_MAGMUX_MESSAGE);

const dirOf = (id: string) => join(layout.sessionsDir, id);

async function created(args: Parameters<typeof createSession>[1]): Promise<string> {
  const { sessionId, result } = await createSession(server, args);
  expect(result.isError).toBe(false);
  expect(typeof sessionId).toBe("string");
  return sessionId as string;
}

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

async function rowOf(id: string): Promise<Record<string, unknown> | undefined> {
  const r = await server.callTool("list_sessions", { include_completed: true });
  const rows = (r.json?.sessions ?? []) as Array<Record<string, unknown>>;
  return rows.find((row) => row.session_id === id);
}

async function waitRow(
  id: string,
  pred: (row: Record<string, unknown>) => boolean,
  what: string
): Promise<Record<string, unknown>> {
  return waitFor(
    async () => {
      const row = await rowOf(id);
      return row && pred(row) ? row : undefined;
    },
    { what, timeoutMs: BOOT_MS, intervalMs: 50 }
  );
}

const isInt = (x: unknown) => Number.isInteger(x);
const isStr = (x: unknown) => typeof x === "string" && x.length > 0;
const isIso = (x: unknown) => isStr(x) && !Number.isNaN(Date.parse(String(x)));
const isNum = (x: unknown) => typeof x === "number";
const nullOr = (ok: (y: unknown) => boolean) => (x: unknown) => x === null || ok(x);
const any = () => true;

/** The 10.4.0 `meta.json` keys and their types, as the magus monitor reads them. */
const META_104: Record<string, (x: unknown) => boolean> = {
  sessionId: isStr,
  model: isStr,
  spawnModel: nullOr(isStr),
  status: (x) => ["completed", "failed", "cancelled", "timeout"].includes(String(x)),
  pid: nullOr(isInt),
  startedAt: isIso,
  completedAt: isIso,
  exitCode: nullOr(isInt),
  turnsCompleted: isInt,
  tokensUsed: isNum,
  elapsedSeconds: isNum,
  idleSeconds: any,
  costUsd: nullOr(isNum),
  toolCallCount: isInt,
  terminalReason: nullOr((x) => (FAILURE_REASONS as readonly unknown[]).includes(x)),
  claudeSessionId: isStr,
  transcriptPath: isStr,
};

function meta104Violations(meta: Record<string, unknown>): string[] {
  return Object.entries(META_104)
    .filter(([key, ok]) => !(key in meta) || !ok(meta[key]))
    .map(([key]) => `${key}=${JSON.stringify(meta[key])}`);
}

/** A copy of the monitor's reply rule: the distinct `message.id` of `type:"assistant"` lines. */
function monitorReplies(eventsText: string): Set<string> {
  const ids = new Set<string>();
  for (const line of eventsText.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as { type?: unknown; message?: { id?: unknown } };
      if (r.type === "assistant" && typeof r.message?.id === "string") ids.add(r.message.id);
    } catch {
      /* the monitor skips a line it cannot parse */
    }
  }
  return ids;
}

describe("EMPTY is a failure to the monitor (§20.1)", () => {
  test("toMetaRecord writes status failed and the FailureReason for an EMPTY session", () => {
    const info: SessionInfo = {
      sessionId: "e0000001",
      model: "m",
      spawnModel: null,
      provider: null,
      state: "EMPTY",
      shape: "one-shot",
      pane: "p",
      panePid: 4242,
      startedAt: "2026-10-06T00:00:00.000Z",
      completedAt: "2026-10-06T00:00:05.000Z",
      exitCode: null,
      turnsCompleted: 1,
      tokensIn: 10,
      tokensOut: 2,
      costUsd: null,
      toolCalls: 0,
      lastActivityAt: null,
      elapsedSeconds: 5,
      idleSeconds: null,
      activity: null,
      reason: "empty_output",
      detail: "no answer",
      pendingInputs: 0,
      claudeSessionId: "3a4b5c6d-0000-4000-8000-000000000001",
      transcriptPath: "/x/y.jsonl",
      captureSource: "transcript",
      turnSource: "transcript",
      timeoutSeconds: 600,
    };
    const meta = toMetaRecord(info, "/cwd");
    expect(meta104Violations(meta)).toEqual([]);
    expect(meta).toMatchObject({
      status: "failed",
      terminalReason: "empty_output",
      state: "EMPTY",
      pid: 4242,
      tokensUsed: 12,
      toolCallCount: 0,
    });
    expect("toolCalls" in meta || "reason" in meta || "panePid" in meta).toBe(false);
  });
});

describe.skipIf(!MAGMUX_AVAILABLE)("live records", () => {
  beforeEach(async () => {
    layout = makeTempLayout("records");
    server = await McpServer.start({ env: serverEnv(layout), cwd: layout.cwd });
  });
  afterEach(async () => {
    await server.close();
    const report = await paneOrphans(layout);
    layout.cleanup();
    expect(report).toEqual({ processes: [], files: [] });
  }, 40_000);

  describe("meta.json keeps the 10.4.0 keys with their 10.4.0 types in every terminal state", () => {
    test(
      "completed",
      async () => {
        const meta = await terminalMeta(await created({ prompt: "say hello" }));
        expect(meta104Violations(meta)).toEqual([]);
        expect(meta).toMatchObject({
          status: "completed",
          terminalReason: null,
          turnsCompleted: 1,
        });
      },
      T_TEST
    );

    test(
      "failed: an API-error turn",
      async () => {
        const id = await created({ model: "fake-api_error", prompt: "say hello" });
        const meta = await terminalMeta(id);
        expect(meta104Violations(meta)).toEqual([]);
        expect(meta).toMatchObject({ status: "failed", terminalReason: "api_error" });
      },
      T_TEST
    );

    test(
      "failed: the child exited mid-turn, with its own exit code",
      async () => {
        const id = await created({ model: "fake-exit_mid_turn", prompt: "say hello" });
        const meta = await terminalMeta(id);
        expect(meta104Violations(meta)).toEqual([]);
        expect(meta).toMatchObject({
          status: "failed",
          terminalReason: "child_exited",
          exitCode: 3,
        });
      },
      T_TEST
    );

    test(
      "cancelled (claudish ended the pane: exitCode null)",
      async () => {
        const id = await created({ prompt: "never answer @@HANG@@" });
        await waitRow(id, (r) => r.state === "RUNNING", "running");
        await sessionTool(server, "cancel_session", id);
        const meta = await terminalMeta(id);
        expect(meta104Violations(meta)).toEqual([]);
        expect(meta).toMatchObject({
          status: "cancelled",
          terminalReason: "cancelled",
          exitCode: null,
        });
      },
      T_TEST
    );

    test(
      "timeout",
      async () => {
        const id = await created({ prompt: "never answer @@HANG@@", timeout_seconds: 4 });
        const meta = await terminalMeta(id, 20_000);
        expect(meta104Violations(meta)).toEqual([]);
        expect(meta).toMatchObject({ status: "timeout", terminalReason: "timeout" });
      },
      T_TEST
    );
  });

  test(
    "events.jsonl has exactly one assistant line per distinct main-chain message id of the transcript",
    async () => {
      const id = await created({ prompt: "use a tool @@TOOL@@" });
      await terminalMeta(id);
      const diag = await sessionTool(server, "get_diagnostics", id);
      const transcriptPath = String(diag.json?.transcriptPath);

      const transcriptIds = new Set<string>();
      for (const line of readFileSync(transcriptPath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const r = JSON.parse(line) as {
          type?: string;
          isSidechain?: boolean;
          message?: { id?: string };
        };
        if (r.type === "assistant" && !r.isSidechain && r.message?.id)
          transcriptIds.add(r.message.id);
      }
      const events = readFileSync(join(dirOf(id), "events.jsonl"), "utf8");
      const assistantLines = events
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as { type?: string })
        .filter((r) => r.type === "assistant");

      expect(transcriptIds.size).toBeGreaterThanOrEqual(2); // the tool_use message and the answer
      expect([...monitorReplies(events)].sort()).toEqual([...transcriptIds].sort());
      expect(assistantLines).toHaveLength(transcriptIds.size);
    },
    T_TEST
  );

  test(
    "RB3 a question in a channel session opens one wait; send_input declines it and closes it to running",
    async () => {
      const id = await created({ model: "fake-ask_user_send", prompt: "ask me something" });
      const blocked = await waitRow(id, (r) => r.state === "AWAITING_INPUT", "the question");
      expect(blocked.activity).toBe("AskUserQuestion");
      const open = readWaitLines(dirOf(id)) ?? [];
      expect(open).toEqual([{ wait: "open", since: expect.any(String), turns: 0 }]);

      expect((await sendInput(server, id, "never mind, answer this")).json).toMatchObject({
        success: true,
      });
      const lines = await waitFor(
        () => {
          const l = readWaitLines(dirOf(id));
          return l && l.length >= 2 ? l : undefined;
        },
        { what: "the closed line", timeoutMs: BOOT_MS }
      );

      expect(lines[1]).toEqual({
        wait: "closed",
        since: lines[0].since,
        at: expect.any(String),
        to: "running",
      });
      expect(waitPairingViolations(lines, true)).toEqual([]);
      await sessionTool(server, "cancel_session", id);
    },
    T_TEST
  );

  test(
    "RB3 a permission dialog opens one wait (awaiting_permission); cancel closes it to cancelled",
    async () => {
      const id = await created({ model: "fake-permission", prompt: "edit something" });
      await waitRow(id, (r) => r.state === "AWAITING_PERMISSION", "the permission dialog");
      expect(readWaitLines(dirOf(id))).toEqual([
        { wait: "open", since: expect.any(String), turns: 0 },
      ]);

      await sessionTool(server, "cancel_session", id);
      await terminalMeta(id);
      const lines = readWaitLines(dirOf(id)) ?? [];

      expect(lines.map((l) => [l.wait, l.to])).toEqual([
        ["open", undefined],
        ["closed", "cancelled"],
      ]);
      expect(waitPairingViolations(lines, false)).toEqual([]);
    },
    T_TEST
  );

  test(
    "D23 a re-wake after the answer closes no wait early and adds no turn",
    async () => {
      const id = await created({});
      await waitFor(() => readWaitLines(dirOf(id))?.length === 1, {
        what: "boot ready",
        timeoutMs: BOOT_MS,
      });
      await sendInput(server, id, "answer, then wake again @@LATE@@");

      const row = await waitRow(
        id,
        (r) => r.state === "AWAITING_INPUT" && r.turns_completed === 1,
        "the re-woken turn to settle"
      );
      const lines = readWaitLines(dirOf(id)) ?? [];
      const output = await sessionTool(server, "get_output", id);

      expect(row.turns_completed).toBe(1);
      expect(lines.map((l) => [l.wait, l.turns ?? l.to])).toEqual([
        ["open", 0],
        ["closed", "running"],
        ["open", 1],
      ]);
      expect(String(output.json?.output)).toContain("LATE second message");
      await sessionTool(server, "cancel_session", id);
    },
    T_TEST
  );

  test(
    "a turn that settles with a send queued writes no wait line between the turns",
    async () => {
      const id = await created({});
      await waitFor(() => readWaitLines(dirOf(id))?.length === 1, {
        what: "boot ready",
        timeoutMs: BOOT_MS,
      });
      await sendInput(server, id, "answer, then linger @@LINGER@@");
      await waitRow(id, (r) => r.state === "RUNNING", "turn 1 running");
      expect((await sendInput(server, id, "second question")).json).toMatchObject({
        success: true,
      });

      await waitRow(
        id,
        (r) => r.state === "AWAITING_INPUT" && r.turns_completed === 2,
        "turn 2 to settle"
      );
      const lines = readWaitLines(dirOf(id)) ?? [];

      expect(lines.map((l) => [l.wait, l.turns ?? l.to])).toEqual([
        ["open", 0],
        ["closed", "running"],
        ["open", 2],
      ]);
      await sessionTool(server, "cancel_session", id);
    },
    T_TEST
  );

  test(
    "a cancelled team slot's status.json row carries error.reason cancelled",
    async () => {
      const teamDir = join(layout.cwd, "team-run");
      const run = await teamCall(server, "run", {
        path: teamDir,
        models: ["contract-fake-a"],
        input: "never answer @@HANG@@",
      });
      expect(run.isError).toBe(false);

      const cancel = await server.callTool("team", { mode: "cancel", path: teamDir });
      expect(cancel.isError).toBe(false);
      const row = await waitFor(
        () => {
          const status = readJson(join(teamDir, "status.json"));
          const models = (status?.models ?? {}) as Record<string, Record<string, unknown>>;
          const slot = Object.values(models)[0];
          return slot?.state === "CANCELLED" ? slot : undefined;
        },
        { what: "the CANCELLED row", timeoutMs: BOOT_MS }
      );

      expect((row.error as Record<string, unknown> | undefined)?.reason).toBe("cancelled");
    },
    T_TEST
  );
});
