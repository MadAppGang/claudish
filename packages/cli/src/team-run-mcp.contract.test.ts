// packages/cli/src/team-run-mcp.contract.test.ts
/**
 * Black-box contract tests for the team-run record through the real `team` MCP tool
 * (design §3.3 "Team record", §3.2 item 3; §8.1 tests 7, 15, 16b, 18, 19).
 *
 * A real claudish MCP server over stdio, every slot an interactive pane: the pane fake
 * (marker mode; serverEnv's default CLAUDISH_BIN), in a real headless magmux under the test's own
 * CLAUDISH_PANE_ROOT (ported per architecture §20.2; every assertion kept). The team
 * directory is inside the server's cwd, in case path validation requires it.
 *
 * INFERRED (adapter `teamCall` in test-helpers/contract-mcp.ts): the `team` tool takes
 * `mode`, a path, `models` and an input; key names are read from the tool's own inputSchema.
 * `team(mode:"status")` reports per-slot activity under an `activity_by_slot` key (named in
 * design §5.6). `run-and-judge` and `judge` are not exercised: they need a judge model.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAGMUX_AVAILABLE,
  McpServer,
  NO_MAGMUX_MESSAGE,
  findField,
  paneOrphans,
  serverEnv,
  teamCall,
} from "./test-helpers/contract-mcp.js";
import {
  TEAM_RECORD_ID_PATTERN,
  type TempLayout,
  claudeId,
  entries,
  makeTempLayout,
  readJson,
  spawnRecordViolations,
  teamRecordDirs,
  waitFor,
} from "./test-helpers/contract-records.js";

const T_TEST = 30_000;
const MODELS = ["contract-fake-a", "contract-fake-b"];

let layout: TempLayout;
let server: McpServer;
let teamDir: string;

if (!MAGMUX_AVAILABLE) console.warn(NO_MAGMUX_MESSAGE);

beforeEach(async () => {
  layout = makeTempLayout("teammcp");
  teamDir = join(layout.cwd, "team-run");
  server = await McpServer.start({
    env: serverEnv(layout),
    cwd: layout.cwd,
  });
});
afterEach(async () => {
  await server.close();
  const report = await paneOrphans(layout);
  layout.cleanup();
  expect(report).toEqual({ processes: [], files: [] });
});

async function run(input: string): Promise<string> {
  const r = await teamCall(server, "run", { path: teamDir, models: MODELS, input });
  expect(r.isError).toBe(false);
  const record = findField(r.json, "monitor_record");
  expect(typeof record).toBe("string");
  return record as string;
}

describe.skipIf(!MAGMUX_AVAILABLE)(
  "REQ-17 team(mode:'run') writes a kind:team record and returns its id",
  () => {
    test(
      "the result carries monitor_record, and that record's spawn.json is valid and names the run",
      async () => {
        const record = await run("answer once and exit");
        const text = readFileSync(join(layout.sessionsDir, record, "spawn.json"), "utf8");

        expect(record).toMatch(TEAM_RECORD_ID_PATTERN);
        expect(spawnRecordViolations(text, record)).toEqual([]);
        expect(JSON.parse(text)).toMatchObject({
          schema: 1,
          kind: "team",
          sessionId: record,
          teamPath: teamDir,
          slots: MODELS.length,
          hostPid: process.pid,
          mcpPid: server.pid,
        });
        expect(teamRecordDirs(layout.sessionsDir)).toEqual([record]);
      },
      T_TEST
    );

    test(
      "the record carries the host session record's id, read when the run call arrives",
      async () => {
        const R = claudeId("host");
        mkdirSync(join(layout.configDir, "sessions"), { recursive: true });
        writeFileSync(
          join(layout.configDir, "sessions", `${process.pid}.json`),
          JSON.stringify({ pid: process.pid, sessionId: R })
        );

        const record = await run("answer once and exit");

        expect(readJson(join(layout.sessionsDir, record, "spawn.json"))).toMatchObject({
          parentClaudeSessionId: R,
        });
      },
      T_TEST
    );
  }
);

describe.skipIf(!MAGMUX_AVAILABLE)(
  "REQ-18/REQ-21 the record of a run that settles at once ends exactly once",
  () => {
    // Replaced (D9): the budget was "within 1 s of the run call returning". `run` now
    // returns once each slot's prompt is ACCEPTED, so that interval also holds the turn's
    // own settle (the fake answers, the follower polls, 500 ms corroboration, a 250 ms
    // tick) in a second bun process and a magmux — pane latency that stretched to
    // 1,013–1,014 ms under machine load while the record path took milliseconds. The
    // property REQ-21 needs is that the record ends AT the settle, from inside
    // `startModels`, not on a later poll: so the 1 s budget is measured from the moment
    // the run settled (its last slot's `completedAt`) to the record's `completedAt`.
    test(
      "meta.json is written within 1 s of the run settling, completed, with every slot ok",
      async () => {
        const record = await run("answer once and exit");

        const meta = await waitFor(() => readJson(join(layout.sessionsDir, record, "meta.json")), {
          what: "the team record's meta.json",
          timeoutMs: 10_000,
        });

        const slots = Object.values(
          (readJson(join(teamDir, "status.json"))?.models ?? {}) as Record<
            string,
            { completedAt?: string | null }
          >
        );
        const settledAt = Math.max(...slots.map((m) => Date.parse(m.completedAt ?? "")));
        const endedAt = Date.parse(String(meta.completedAt));
        expect(slots).toHaveLength(MODELS.length);
        expect(Number.isFinite(settledAt)).toBe(true);
        expect(endedAt).toBeGreaterThanOrEqual(settledAt);
        expect(endedAt - settledAt).toBeLessThanOrEqual(1_000);
        expect(meta).toEqual({
          kind: "team",
          status: "completed",
          startedAt: expect.any(String),
          completedAt: expect.any(String),
          elapsedSeconds: expect.any(Number),
          slots: 2,
          ok: 2,
          failed: 0,
          cancelled: 0,
        });
        expect(entries(join(layout.sessionsDir, record))).toEqual(["meta.json", "spawn.json"]);
      },
      T_TEST
    );
  }
);

describe.skipIf(!MAGMUX_AVAILABLE)(
  "REQ-23 only mode 'run' writes a record, and nothing goes under .hosts",
  () => {
    test(
      "status and cancel on an existing run add no record; no .hosts directory appears",
      async () => {
        const record = await run("answer once and exit");
        await waitFor(() => readJson(join(layout.sessionsDir, record, "meta.json")), {
          what: "the run to settle",
          timeoutMs: 10_000,
        });

        await teamCall(server, "status", { path: teamDir });
        await teamCall(server, "cancel", { path: teamDir });

        expect(teamRecordDirs(layout.sessionsDir)).toEqual([record]);
        expect(existsSync(join(layout.sessionsDir, ".hosts"))).toBe(false);
      },
      T_TEST
    );
  }
);

describe.skipIf(!MAGMUX_AVAILABLE)(
  "REQ-24 a team slot reads finishing, never waiting_for_input, between its result and its exit",
  () => {
    function activities(json: unknown): string[] {
      const bySlot = findField(json, "activity_by_slot");
      if (!bySlot || typeof bySlot !== "object") return [];
      return Object.values(bySlot as Record<string, unknown>).map(String);
    }

    test(
      "slots that answer and then linger before exiting report finishing",
      async () => {
        const record = await run("answer, then linger before exiting @@LINGER@@");
        const seen = new Set<string>();

        await waitFor(
          async () => {
            const status = await teamCall(server, "status", { path: teamDir });
            for (const a of activities(status.json)) seen.add(a);
            return readJson(join(layout.sessionsDir, record, "meta.json"));
          },
          { what: "the run to settle", timeoutMs: 15_000, intervalMs: 100 }
        );

        expect(seen.has("finishing")).toBe(true);
        expect(seen.has("waiting_for_input")).toBe(false);
      },
      T_TEST
    );
  }
);
