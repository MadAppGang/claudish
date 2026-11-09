/**
 * MTL-373: read-only replay panes (`replay_session`, `team(mode:"replay")`, `close_replay`)
 * over a REAL claudish MCP stdio server and real headless magmux, with a controlled
 * stand-in `claude` binary (`CLAUDE_PATH`).
 *
 * Written strictly from `spec.md` and `contract/architecture-contracts.md` + `contract/contract.ts`.
 * No implementation file was read.
 * See `qa/test-plan.md` for `REQ-n` and `TEST-n` coverage mapping.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  CAPABILITIES,
  CONTRACT_VERSION,
  type ContractError,
  type ReplayUnavailableReason,
  isReplayId,
} from "../pane/contract.js";
import { requireProcessTable } from "../pane/test-helpers/hermetic-env.js";
import { useBlackboxEnv } from "../test-helpers/blackbox-env.js";
import {
  MAGMUX_AVAILABLE,
  McpServer,
  NO_MAGMUX_MESSAGE,
  type ToolResult,
  createSession,
  paneOrphans,
  paneRootOf,
  sendInput,
  serverEnv,
} from "../test-helpers/contract-mcp.js";
import {
  type TempLayout,
  makeTempLayout,
  pidAlive,
  sanitisedProjectName,
  waitFor,
} from "../test-helpers/contract-records.js";
import { type StandinHarness, createStandinHarness, slugOfCwd } from "./replay-standin.js";

useBlackboxEnv();

type Json = Record<string, unknown>;

const T_TEST = 120_000;
const REPLAY_ID_RE = /^replay-[0-9a-f]{16}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EXPECTED_CAPABILITIES: Array<(typeof CAPABILITIES)[number]> = [
  "list",
  "status",
  "cancel",
  "capture",
  "capture_since_seq",
  "capture_spans",
  "resize",
  "allowance",
  "scroll",
  "transcript",
  "replay",
];

let layout: TempLayout;
let server: McpServer | undefined;
let standin: StandinHarness;
let exitedPid: number;
const extraServers: McpServer[] = [];
const trackedReplayPids = new Set<number>();

if (!MAGMUX_AVAILABLE) console.warn(NO_MAGMUX_MESSAGE);

beforeEach(async () => {
  layout = makeTempLayout("bbreplay");
  standin = createStandinHarness(layout.root, { kind: "box" });
  const child = Bun.spawnSync([process.execPath, "--no-env-file", "-e", ""], {
    cwd: layout.cwd,
    env: { HOME: layout.home, PATH: process.env.PATH ?? "" },
  });
  expect(child.exitCode).toBe(0);
  exitedPid = child.pid;
  expect(() => process.kill(exitedPid, 0)).toThrow();
  server = await startServer();
});

afterEach(async () => {
  try {
    for (const s of extraServers.splice(0)) await s.close();
    await server?.close();
  } finally {
    try {
      for (const pid of trackedReplayPids) {
        if (pidAlive(pid)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // already gone
          }
        }
      }
      trackedReplayPids.clear();
      expect(await paneOrphans(layout, 15_000)).toEqual({ processes: [], files: [] });
    } finally {
      layout.cleanup();
      server = undefined;
    }
  }
});

function startServer(
  extra: Record<string, string | undefined> = {},
  cwd = layout.cwd
): Promise<McpServer> {
  return McpServer.start({
    env: serverEnv(layout, {
      CONTRACT_FAKE_MAX_MS: "180000",
      CLAUDE_PATH: standin.wrapperPath,
      ...extra,
    }),
    cwd,
  });
}

async function restart(
  extra: Record<string, string | undefined> = {},
  cwd = layout.cwd
): Promise<void> {
  await server?.close();
  server = await startServer(extra, cwd);
}

function currentServer(): McpServer {
  if (!server) throw new Error("MCP server was not started");
  return server;
}

function call(tool: string, args: Json): Promise<ToolResult> {
  return currentServer().callTool(tool, args);
}

function ok(result: ToolResult): Json {
  expect(result.isError, "Expected a successful tool answer: " + result.text).toBe(false);
  expect(result.json, "Expected JSON tool answer: " + result.text).toBeDefined();
  if (!result.json) throw new Error("Expected JSON tool answer: " + result.text);
  return result.json;
}

function contractError(
  result: ToolResult,
  code: ContractError["error"]["code"],
  reason?: ReplayUnavailableReason,
  context = "Contract error"
): void {
  const diagnostic = context + ": " + result.text;
  expect(result.isError, diagnostic).toBe(true);
  const expectedError: Record<string, unknown> = {
    code,
    message: expect.any(String),
  };
  if (reason !== undefined) {
    expectedError.reason = reason;
  }
  expect(result.json, diagnostic).toEqual({ error: expectedError });
  const body = result.json as unknown as ContractError;
  if (reason === undefined) {
    expect(Object.hasOwn(body.error, "reason"), diagnostic).toBe(false);
  }
  expect(body.error.message.length, diagnostic).toBeGreaterThan(0);
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeJson(path: string, value: Json): void {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function age(path: string, secondsAgo = 120): void {
  const old = new Date(Date.now() - secondsAgo * 1_000);
  utimesSync(path, old, old);
}

function putTranscript(path: string, records: Json[], quiet = true, cwd = layout.cwd): void {
  mkdirSync(dirname(path), { recursive: true });
  const id = basename(path, ".jsonl");
  const content = records
    .map(
      (r) =>
        JSON.stringify({
          ...r,
          sessionId: id,
          session_id: id,
          cwd,
        }) + "\n"
    )
    .join("");
  writeFileSync(path, content);
  if (quiet) age(path);
}

interface SeededSession {
  sessionId: string;
  conversationId: string;
  transcriptPath: string;
  recordDir: string;
  sessionCwd: string;
}

function seedSession(
  opts: {
    terminal?: boolean;
    owner?: number | null;
    quiet?: boolean;
    completedAgoSeconds?: number;
    missingTranscript?: boolean;
    missingConversationId?: boolean;
    sessionCwd?: string;
    records?: Json[];
  } = {}
): SeededSession {
  const sessionId = randomUUID().slice(0, 8);
  const conversationId = randomUUID();
  const recordDir = join(layout.sessionsDir, sessionId);
  mkdirSync(recordDir, { recursive: true });
  const sessionCwd = opts.sessionCwd ?? layout.cwd;
  const transcriptPath = join(
    layout.configDir,
    "projects",
    sanitisedProjectName(sessionCwd),
    conversationId + ".jsonl"
  );
  const terminal = opts.terminal ?? true;
  const completedAgo = opts.completedAgoSeconds ?? 120;
  const startedAt = new Date(Date.now() - (completedAgo + 120) * 1_000).toISOString();
  const completedAt = new Date(Date.now() - completedAgo * 1_000).toISOString();
  const owner = opts.owner === undefined ? exitedPid : opts.owner;

  writeJson(join(recordDir, "spawn.json"), {
    schema: 1,
    kind: "session",
    sessionId,
    hostPid: process.pid,
    ...(owner === null ? {} : { mcpPid: owner }),
    startedAt,
    model: "contract-fake-model",
    timeoutSeconds: 600,
    ...(opts.missingConversationId ? {} : { claudeSessionId: conversationId }),
  });

  if (terminal) {
    writeJson(join(recordDir, "meta.json"), {
      sessionId,
      model: "contract-fake-model",
      status: "completed",
      state: "COMPLETED",
      terminalReason: null,
      detail: null,
      startedAt,
      completedAt,
      elapsedSeconds: 120,
      turnsCompleted: 1,
      toolCallCount: 0,
      costUsd: null,
      exitCode: 0,
      tokensIn: null,
      tokensOut: null,
      lastActivityAt: completedAt,
      provider: null,
      pane: null,
      captureSource: "transcript",
      turnSource: "transcript",
      timeoutSeconds: 600,
      cwd: sessionCwd,
      ...(opts.missingConversationId ? {} : { claudeSessionId: conversationId, transcriptPath }),
    });
  }

  const defaultRecords: Json[] = opts.records ?? [
    { type: "user", uuid: randomUUID(), message: { role: "user", content: "Reply PEAR" } },
    {
      type: "assistant",
      uuid: randomUUID(),
      message: { role: "assistant", id: randomUUID(), content: [{ type: "text", text: "PEAR" }] },
    },
  ];
  if (!opts.missingTranscript && !opts.missingConversationId) {
    putTranscript(transcriptPath, defaultRecords, opts.quiet ?? true, sessionCwd);
  }

  return { sessionId, conversationId, transcriptPath, recordDir, sessionCwd };
}

function mainTranscripts(): string[] {
  const projects = join(layout.configDir, "projects");
  if (!existsSync(projects)) return [];
  const found: string[] = [];
  for (const project of readdirSync(projects, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    for (const file of readdirSync(join(projects, project.name), { withFileTypes: true })) {
      if (file.isFile() && file.name.endsWith(".jsonl")) {
        found.push(join(projects, project.name, file.name));
      }
    }
  }
  return found.sort();
}

interface PreparedTeamSlot {
  path: string;
  runId: string;
  slot: string;
  transcriptPath: string;
  conversationId: string;
}

async function prepareFinishedTeamSlot(
  name = "team-" + randomUUID().slice(0, 8)
): Promise<PreparedTeamSlot> {
  const before = new Set(mainTranscripts());
  const path = join(layout.cwd, name);
  const started = ok(
    await call("team", {
      mode: "run",
      path,
      models: ["fake-answer"],
      input: "Reply with exactly PEAR",
    })
  );
  const runId = started.run_id as string;
  const slot = (started.slots as Record<string, string>)["fake-answer"]!;
  expect(slot).toBe("01");
  await waitFor(
    async () => {
      const s = ok(await call("team", { mode: "status", path, run_id: runId }));
      return (s.run as Json).state === "SETTLED";
    },
    { what: "team run to settle", timeoutMs: 60_000, intervalMs: 100 }
  );
  await waitFor(
    async () => {
      const cap = ok(await call("team", { mode: "capture", path, slot, run_id: runId }));
      return cap.final === true;
    },
    { what: "team pane to exit", timeoutMs: 45_000, intervalMs: 100 }
  );
  await waitFor(
    async () => {
      const tr = ok(await call("team", { mode: "transcript", path, slot, run_id: runId }));
      return tr.final === true;
    },
    { what: "team slot transcript final:true", timeoutMs: 45_000, intervalMs: 100 }
  );
  const created = mainTranscripts().filter((p) => !before.has(p));
  expect(created).toHaveLength(1);
  const transcriptPath = created[0]!;
  age(transcriptPath, 120);

  // Backdate on-disk status.json and manifest.json (if present) and file mtimes by 120 s
  // so that after a server restart, the disk read does not see "finished under 30 s ago"
  // (`replay_unavailable` reason `session_live`, contract §5 Open errors).
  const oldIso = new Date(Date.now() - 120_000).toISOString();
  const statusJsonPath = join(path, "status.json");
  if (existsSync(statusJsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(statusJsonPath, "utf8")) as Json;
      const backdateObj = (obj: unknown): void => {
        if (!obj || typeof obj !== "object") return;
        const rec = obj as Record<string, unknown>;
        for (const [k, v] of Object.entries(rec)) {
          if (
            typeof v === "string" &&
            (k.endsWith("At") || k.endsWith("_at")) &&
            !Number.isNaN(Date.parse(v))
          ) {
            rec[k] = oldIso;
          } else if (v && typeof v === "object") {
            backdateObj(v);
          }
        }
      };
      backdateObj(parsed);
      writeJson(statusJsonPath, parsed);
    } catch {
      // leave as is if not JSON
    }
    age(statusJsonPath, 120);
  }
  const manifestJsonPath = join(path, "manifest.json");
  if (existsSync(manifestJsonPath)) {
    age(manifestJsonPath, 120);
  }
  age(path, 120);

  for (const name of readdirSync(layout.sessionsDir)) {
    if (!name.startsWith("team-")) continue;
    const teamDir = join(layout.sessionsDir, name);
    for (const f of ["spawn.json", "meta.json"]) {
      const fp = join(teamDir, f);
      if (existsSync(fp)) {
        try {
          const parsed = JSON.parse(readFileSync(fp, "utf8")) as Json;
          for (const k of ["startedAt", "completedAt", "lastActivityAt", "finishedAt"]) {
            if (typeof parsed[k] === "string") parsed[k] = oldIso;
          }
          if ("mcpPid" in parsed) parsed.mcpPid = exitedPid;
          writeJson(fp, parsed);
        } catch {
          // ignore
        }
        age(fp, 120);
      }
    }
    age(teamDir, 120);
  }
  return {
    path,
    runId,
    slot,
    transcriptPath,
    conversationId: basename(transcriptPath, ".jsonl"),
  };
}

function recordSpawnedPids(): void {
  for (const s of standin.spawns()) {
    trackedReplayPids.add(s.pid);
  }
}

// ============================================================================
// TEST-1: Capability & Surface Pins
// ============================================================================

describe("capability and MCP tool surface (REQ-1)", () => {
  test("TEST-1 REQ-1: CAPABILITIES ends with replay and is announced by list_sessions and team(mode:list)", async () => {
    expect(CONTRACT_VERSION).toBe(1);
    expect([...CAPABILITIES]).toEqual(EXPECTED_CAPABILITIES);
    expect(CAPABILITIES.at(-2)).toBe("transcript");
    expect(CAPABILITIES.at(-1)).toBe("replay");
    expect(isReplayId("replay-0123456789abcdef")).toBe(true);
    expect(isReplayId("replay-0123456789abcde")).toBe(false);
    expect(isReplayId("01234567")).toBe(false);

    for (const [tool, args] of [
      ["list_sessions", {}],
      ["team", { mode: "list" }],
    ] as const) {
      expect(ok(await call(tool, args))).toMatchObject({
        contract_version: 1,
        capabilities: EXPECTED_CAPABILITIES,
      });
    }
  });

  test("TEST-1 REQ-1: default surface exposes 20 tools with replay_session, close_replay and team mode replay", async () => {
    const tools = await currentServer().listTools();
    expect(tools).toHaveLength(20);
    expect(new Set(tools.map((t) => t.name)).size).toBe(20);

    const replaySession = tools.find((t) => t.name === "replay_session");
    expect(replaySession).toBeDefined();
    expect(replaySession?.inputSchema?.required).toEqual(["session_id"]);
    expect(Object.keys(replaySession?.inputSchema?.properties ?? {}).sort()).toEqual([
      "cols",
      "rows",
      "session_id",
    ]);

    const closeReplay = tools.find((t) => t.name === "close_replay");
    expect(closeReplay).toBeDefined();
    expect(closeReplay?.inputSchema?.required).toEqual(["replay_id"]);
    expect(Object.keys(closeReplay?.inputSchema?.properties ?? {}).sort()).toEqual(["replay_id"]);

    const team = tools.find((t) => t.name === "team");
    const props = (team?.inputSchema?.properties ?? {}) as Record<string, Json>;
    expect(props.mode?.enum).toEqual([
      "run",
      "judge",
      "run-and-judge",
      "status",
      "cancel",
      "list",
      "capture",
      "resize",
      "scroll",
      "transcript",
      "replay",
    ]);
  });

  test("TEST-1 REQ-1: session group exposes 12 tools and nested mode excludes replay_session and close_replay", async () => {
    await restart({ CLAUDISH_MCP_TOOLS: "session" });
    expect((await currentServer().listTools()).map((t) => t.name).sort()).toEqual([
      "cancel_session",
      "capture_session",
      "close_replay",
      "create_session",
      "get_diagnostics",
      "get_output",
      "list_sessions",
      "replay_session",
      "resize_session",
      "scroll_session",
      "send_input",
      "transcript_session",
    ]);

    for (const group of [undefined, "all", "session", "agentic", "low-level", "debug"]) {
      await restart({ CLAUDISH_PANE_CHILD: "1", CLAUDISH_MCP_TOOLS: group });
      const names = (await currentServer().listTools()).map((t) => t.name);
      expect(names).not.toContain("replay_session");
      expect(names).not.toContain("close_replay");
    }
  }, T_TEST);
});

// ============================================================================
// TEST-2 & TEST-3: Argument Validation & Lookup Errors (no panes required)
// ============================================================================

describe("argument validation and lookup errors (REQ-4)", () => {
  test("TEST-2 REQ-4: replay_session validates session_id, cols and rows", async () => {
    const seeded = seedSession();
    for (const session_id of [undefined, "", null, 42, false, [], {}]) {
      contractError(
        await call("replay_session", session_id === undefined ? {} : { session_id }),
        "invalid_args"
      );
    }
    for (const badDim of [12.5, -0.5, "160", null, true, false, [], {}, Number.NaN]) {
      contractError(
        await call("replay_session", { session_id: seeded.sessionId, cols: badDim }),
        "invalid_args",
        undefined,
        `replay_session cols=${JSON.stringify(badDim)}`
      );
      contractError(
        await call("replay_session", { session_id: seeded.sessionId, rows: badDim }),
        "invalid_args",
        undefined,
        `replay_session rows=${JSON.stringify(badDim)}`
      );
    }
    expect(standin.spawns()).toEqual([]);
  });

  test(
    "TEST-2 REQ-4: team(mode:replay) validates path, slot, run_id, cols, rows and agentic tool group",
    async () => {
      const teamSlot = MAGMUX_AVAILABLE
        ? await prepareFinishedTeamSlot("validate-team")
        : undefined;
      const validPath = teamSlot ? teamSlot.path : join(layout.cwd, "missing-run");
      for (const path of [undefined, "", null, 42, false, [], {}, "/etc"]) {
        contractError(
          await call("team", {
            mode: "replay",
            slot: "01",
            ...(path === undefined ? {} : { path }),
          }),
          "invalid_args"
        );
      }
      for (const slot of [undefined, "", null, 42, false, [], {}]) {
        contractError(
          await call("team", {
            mode: "replay",
            path: validPath,
            ...(slot === undefined ? {} : { slot }),
          }),
          "invalid_args"
        );
      }
      if (teamSlot) {
        for (const run_id of ["", null, 42, false, [], {}]) {
          contractError(
            await call("team", { mode: "replay", path: validPath, slot: "01", run_id }),
            "invalid_args"
          );
        }
        for (const badDim of [10.5, "80", null, true, false, [], {}]) {
          contractError(
            await call("team", {
              mode: "replay",
              path: validPath,
              slot: "01",
              run_id: teamSlot.runId,
              cols: badDim,
            }),
            "invalid_args"
          );
          contractError(
            await call("team", {
              mode: "replay",
              path: validPath,
              slot: "01",
              run_id: teamSlot.runId,
              rows: badDim,
            }),
            "invalid_args"
          );
        }
      }

      // `team` replay when CLAUDISH_MCP_TOOLS=agentic -> invalid_args
      await restart({ CLAUDISH_MCP_TOOLS: "agentic" });
      contractError(
        await call("team", { mode: "replay", path: validPath, slot: "01" }),
        "invalid_args"
      );
      expect(standin.spawns()).toEqual([]);
    },
    T_TEST
  );

  test("TEST-2 REQ-4: close_replay validates required string replay_id and answers closed:true for any string", async () => {
    for (const replay_id of [undefined, "", null, 42, false, [], {}]) {
      contractError(
        await call("close_replay", replay_id === undefined ? {} : { replay_id }),
        "invalid_args"
      );
    }
    for (const id of ["replay-0123456789abcdef", "never-issued-id", "bad"]) {
      expect(ok(await call("close_replay", { replay_id: id }))).toEqual({ closed: true });
    }
  });

  test("TEST-3 REQ-4: unknown_session and unknown_run are returned when targets do not exist", async () => {
    contractError(await call("replay_session", { session_id: "missing1" }), "unknown_session");
    contractError(
      await call("team", { mode: "replay", path: join(layout.cwd, "no-such-run"), slot: "01" }),
      "unknown_run"
    );
    expect(standin.spawns()).toEqual([]);
  });
});

// ============================================================================
// TEST-4 & TEST-5: Availability Errors (session_live, no_record)
// ============================================================================

describe("replay_unavailable on session_live and no_record (REQ-5)", () => {
  test("TEST-4 REQ-5: spawn.json without meta.json and owner alive answers replay_unavailable session_live", async () => {
    const liveSpawnOnly = seedSession({
      terminal: false,
      owner: process.pid,
      quiet: false,
    });
    contractError(
      await call("replay_session", { session_id: liveSpawnOnly.sessionId }),
      "replay_unavailable",
      "session_live"
    );
    expect(standin.spawns()).toEqual([]);
  });

  test("TEST-4 REQ-5: on-disk session finished under 30 s ago with live/unproven owner answers session_live", async () => {
    const recent = seedSession({
      terminal: true,
      owner: process.pid,
      quiet: false,
      completedAgoSeconds: 5,
    });
    contractError(
      await call("replay_session", { session_id: recent.sessionId }),
      "replay_unavailable",
      "session_live"
    );
    expect(standin.spawns()).toEqual([]);
  });

  test("TEST-5 REQ-5: finished session without transcript file or conversation id answers replay_unavailable no_record", async () => {
    const noTranscript = seedSession({ missingTranscript: true });
    contractError(
      await call("replay_session", { session_id: noTranscript.sessionId }),
      "replay_unavailable",
      "no_record"
    );

    const noConvId = seedSession({ missingConversationId: true });
    contractError(
      await call("replay_session", { session_id: noConvId.sessionId }),
      "replay_unavailable",
      "no_record"
    );
    expect(standin.spawns()).toEqual([]);
  });
});

// ============================================================================
// Live Magmux Replay Tests (TEST-3 slot, TEST-4 live, TEST-6..TEST-18)
// ============================================================================

describe.skipIf(!MAGMUX_AVAILABLE)("live replay panes in headless magmux", () => {
  test(
    "TEST-3 TEST-4 REQ-4 REQ-5: live session/team slot answers session_live; settled team run checks run_id and slot",
    async () => {
      // Live interactive session -> session_live
      const created = await createSession(currentServer(), {});
      ok(created.result);
      const liveSessionId = created.sessionId!;
      contractError(
        await call("replay_session", { session_id: liveSessionId }),
        "replay_unavailable",
        "session_live"
      );
      ok(await call("cancel_session", { session_id: liveSessionId }));

      // Live team run -> session_live
      const liveTeamPath = join(layout.cwd, "live-team-replay");
      const started = ok(
        await call("team", {
          mode: "run",
          path: liveTeamPath,
          models: ["contract-fake-model"],
          input: "hold @@HANG@@",
        })
      );
      const liveRunId = started.run_id as string;
      contractError(
        await call("team", { mode: "replay", path: liveTeamPath, slot: "01", run_id: liveRunId }),
        "replay_unavailable",
        "session_live"
      );
      contractError(
        await call("team", { mode: "replay", path: liveTeamPath, slot: "99", run_id: liveRunId }),
        "unknown_slot"
      );
      contractError(
        await call("team", {
          mode: "replay",
          path: liveTeamPath,
          slot: "01",
          run_id: "never-minted-run",
        }),
        "unknown_run"
      );
      ok(await call("team", { mode: "cancel", path: liveTeamPath, run_id: liveRunId }));
      expect(standin.spawns()).toEqual([]);
    },
    T_TEST
  );

  test(
    "TEST-6 REQ-5 REQ-12: missing CLAUDE_PATH or child exiting before input box answers spawn_failed and leaves nothing",
    async () => {
      const target = seedSession();

      // 1. Immediate exit before drawing box
      standin.setScenario({ kind: "exit_before_box", exitCode: 2, delayMs: 0 });
      contractError(
        await call("replay_session", { session_id: target.sessionId }),
        "replay_unavailable",
        "spawn_failed"
      );
      recordSpawnedPids();
      expect(standin.spawns()).toHaveLength(1);
      const firstPid = standin.spawns()[0]!.pid;
      await waitFor(() => !pidAlive(firstPid), { what: "immediate-exit stand-in pid gone" });

      // 2. Delayed exit before drawing box
      standin.setScenario({ kind: "exit_before_box", exitCode: 1, delayMs: 400 });
      contractError(
        await call("replay_session", { session_id: target.sessionId }),
        "replay_unavailable",
        "spawn_failed"
      );
      recordSpawnedPids();
      expect(standin.spawns()).toHaveLength(2);
      const secondPid = standin.spawns()[1]!.pid;
      await waitFor(() => !pidAlive(secondPid), { what: "delayed-exit stand-in pid gone" });

      // 3. Missing CLAUDE_PATH binary
      await restart({ CLAUDE_PATH: join(layout.root, "nonexistent-claude-bin") });
      contractError(
        await call("replay_session", { session_id: target.sessionId }),
        "replay_unavailable",
        "spawn_failed"
      );

      const paneRoot = paneRootOf(layout);
      if (existsSync(join(paneRoot, "panes"))) {
        expect(readdirSync(join(paneRoot, "panes"))).toEqual([]);
      }
    },
    T_TEST
  );

  test(
    "TEST-7 REQ-2 REQ-5 REQ-12: immediate or delayed trust dialog answers boot_dialog and reaps child; quoted trust text with a box succeeds",
    async () => {
      const target = seedSession();

      // (a) Immediate trust dialog with no box -> boot_dialog
      standin.setScenario({ kind: "dialog", delayMs: 0, writeForkRecord: true, trapSignals: true });
      contractError(
        await call("replay_session", { session_id: target.sessionId }),
        "replay_unavailable",
        "boot_dialog"
      );
      recordSpawnedPids();
      expect(standin.spawns()).toHaveLength(1);
      const dialogSpawn1 = standin.spawns()[0]!;
      expect(pidAlive(dialogSpawn1.pid)).toBe(false);
      if (dialogSpawn1.forkRecordPath) {
        expect(existsSync(dialogSpawn1.forkRecordPath)).toBe(false);
      }

      // (b) Delayed trust dialog with no box -> boot_dialog
      standin.setScenario({ kind: "dialog", delayMs: 500, writeForkRecord: true });
      contractError(
        await call("replay_session", { session_id: target.sessionId }),
        "replay_unavailable",
        "boot_dialog"
      );
      recordSpawnedPids();
      expect(standin.spawns()).toHaveLength(2);
      const dialogSpawn2 = standin.spawns()[1]!;
      expect(pidAlive(dialogSpawn2.pid)).toBe(false);
      if (dialogSpawn2.forkRecordPath) {
        expect(existsSync(dialogSpawn2.forkRecordPath)).toBe(false);
      }

      // (c) Conversation text quoting the trust words followed by a valid input box -> succeeds
      standin.setScenario({ kind: "quoted_trust_then_box", endMarker: "QUOTED-TRUST-OK" });
      const opened = ok(await call("replay_session", { session_id: target.sessionId }));
      recordSpawnedPids();
      expect(Object.keys(opened).sort()).toEqual(["replay_id", "seq"]);
      expect(opened.replay_id).toMatch(REPLAY_ID_RE);
      expect(typeof opened.seq).toBe("number");

      const captured = ok(await call("capture_session", { session_id: opened.replay_id }));
      const screenText = (captured.lines as string[]).join("\n");
      expect(screenText).toContain("Is this a project you created or one you trust");
      expect(screenText).toContain("QUOTED-TRUST-OK");

      expect(ok(await call("close_replay", { replay_id: opened.replay_id }))).toEqual({
        closed: true,
      });
    },
    T_TEST
  );

  test(
    "TEST-8 REQ-2 REQ-6: opens finished session and finished team slot (with/without run_id, and delayed box) and captures the end",
    async () => {
      // Delayed box draw on a finished session
      standin.setScenario({ kind: "box", delayMs: 450, endMarker: "SESSION-END-DRAWN" });
      const sess = seedSession();
      const openedSess = ok(await call("replay_session", { session_id: sess.sessionId }));
      recordSpawnedPids();
      expect(Object.keys(openedSess).sort()).toEqual(["replay_id", "seq"]);
      const sessReplayId = openedSess.replay_id as string;
      expect(sessReplayId).toMatch(REPLAY_ID_RE);
      expect(Number.isInteger(openedSess.seq) && (openedSess.seq as number) >= 1).toBe(true);

      const capSess = ok(await call("capture_session", { session_id: sessReplayId }));
      expect(capSess.cols).toBe(160);
      expect(capSess.rows).toBe(50);
      expect(capSess.final).toBe(false);
      expect((capSess.lines as string[]).join("\n")).toContain("SESSION-END-DRAWN");
      expect(ok(await call("close_replay", { replay_id: sessReplayId }))).toEqual({ closed: true });

      // Finished team slot: open with explicit run_id, close, then open without run_id after restart
      standin.setScenario({ kind: "box", delayMs: 0, endMarker: "TEAM-END-DRAWN" });
      const teamSlot = await prepareFinishedTeamSlot();
      const openedTeam1 = ok(
        await call("team", {
          mode: "replay",
          path: teamSlot.path,
          slot: teamSlot.slot,
          run_id: teamSlot.runId,
        })
      );
      recordSpawnedPids();
      expect(Object.keys(openedTeam1).sort()).toEqual(["replay_id", "seq"]);
      const teamReplayId1 = openedTeam1.replay_id as string;
      expect(teamReplayId1).toMatch(REPLAY_ID_RE);
      const capTeam1 = ok(await call("capture_session", { session_id: teamReplayId1 }));
      expect((capTeam1.lines as string[]).join("\n")).toContain("TEAM-END-DRAWN");
      expect(ok(await call("close_replay", { replay_id: teamReplayId1 }))).toEqual({
        closed: true,
      });

      // Restart server so team run is read from on-disk status.json without run_id
      await restart();
      const openedTeam2 = ok(
        await call("team", {
          mode: "replay",
          path: teamSlot.path,
          slot: teamSlot.slot,
        })
      );
      recordSpawnedPids();
      expect(Object.keys(openedTeam2).sort()).toEqual(["replay_id", "seq"]);
      expect(openedTeam2.replay_id).toMatch(REPLAY_ID_RE);
      expect(ok(await call("close_replay", { replay_id: openedTeam2.replay_id }))).toEqual({
        closed: true,
      });
    },
    T_TEST
  );

  test(
    "TEST-9 REQ-9: verifies exact argv, --settings statusLine extraction, environment allowlist, and cwd fallback",
    async () => {
      // Write <CLAUDE_CONFIG_DIR>/settings.json with statusLine object and extra forbidden keys
      const statusLineConfig = { type: "command", command: "echo custom-status" };
      writeJson(join(layout.configDir, "settings.json"), {
        statusLine: statusLineConfig,
        env: { ANTHROPIC_API_KEY: "sk-ant-should-never-pass", CLAUDISH_MODEL: "leaked" },
        model: "should-not-copy",
        alwaysThinkingEnabled: true,
      });

      // Restart server with extra credential, routing, and FAKE_* env vars that must be stripped
      await restart({
        ANTHROPIC_API_KEY: "sk-ant-secret",
        ANTHROPIC_AUTH_TOKEN: "bearer-secret",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:9999",
        OPENROUTER_API_KEY: "or-secret",
        OPENAI_API_KEY: "oai-secret",
        CLAUDISH_MODEL: "foreign-model",
        CLAUDISH_PROVIDER: "openrouter",
        CLAUDISH_ACTIVE_MODEL_NAME: "foreign",
        FAKE_SCENARIO_VAR: "must-not-pass",
        CUSTOM_UNLISTED_VAR: "must-not-pass",
        LC_CTYPE: "UTF-8",
        TZ: "UTC",
      });

      // Case 1: Session with its own existing folder
      const customSessionDir = join(layout.root, "session-own-cwd");
      mkdirSync(customSessionDir, { recursive: true });
      const sessWithDir = seedSession({ sessionCwd: realpathSync(customSessionDir) });
      const open1 = ok(await call("replay_session", { session_id: sessWithDir.sessionId }));
      recordSpawnedPids();
      expect(standin.spawns()).toHaveLength(1);
      const spawn1 = standin.spawns()[0]!;

      // Verify argv order and values:
      // --resume <id> --fork-session --session-id <fork> --bare --setting-sources "" --strict-mcp-config --settings <json>
      expect(spawn1.argv).toHaveLength(11);
      expect(spawn1.argv[0]).toBe("--resume");
      expect(spawn1.argv[1]).toBe(sessWithDir.conversationId);
      expect(spawn1.argv[2]).toBe("--fork-session");
      expect(spawn1.argv[3]).toBe("--session-id");
      const forkId = spawn1.argv[4]!;
      expect(forkId).toMatch(UUID_RE);
      expect(forkId).not.toBe(sessWithDir.conversationId);
      expect(spawn1.argv[5]).toBe("--bare");
      expect(spawn1.argv[6]).toBe("--setting-sources");
      expect(spawn1.argv[7]).toBe("");
      expect(spawn1.argv[8]).toBe("--strict-mcp-config");
      expect(spawn1.argv[9]).toBe("--settings");
      expect(JSON.parse(spawn1.argv[10]!)).toEqual({
        wheelScrollAccelerationEnabled: false,
        tui: "fullscreen",
        statusLine: statusLineConfig,
      });

      // Verify cwd is the session's own existing directory
      expect(spawn1.cwd).toBe(realpathSync(customSessionDir));

      // Verify environment allowlist:
      // After removing MAGMUX_*, TERM, PWD, OLDPWD, SHLVL, _, keys are exactly:
      // SHELL, CLAUDISH_PANE_CHILD, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
      // CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL, CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING,
      // COLUMNS, LINES, plus whichever of HOME, PATH, USER, LOGNAME, LANG, LC_ALL, LC_CTYPE, TZ, TMPDIR,
      // CLAUDE_CONFIG_DIR the server has.
      const filteredEnvKeys = Object.keys(spawn1.env)
        .filter(
          (k) => !k.startsWith("MAGMUX_") && !["TERM", "PWD", "OLDPWD", "SHLVL", "_"].includes(k)
        )
        .sort();
      const mandatoryKeys = [
        "CLAUDISH_PANE_CHILD",
        "CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
        "CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL",
        "COLUMNS",
        "LINES",
        "SHELL",
      ];
      const optionalPassthrough = [
        "CLAUDE_CONFIG_DIR",
        "HOME",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "LOGNAME",
        "PATH",
        "TMPDIR",
        "TZ",
        "USER",
      ];
      const allowedSet = new Set([...mandatoryKeys, ...optionalPassthrough]);
      for (const k of mandatoryKeys) {
        expect(filteredEnvKeys).toContain(k);
      }
      for (const k of filteredEnvKeys) {
        expect(allowedSet.has(k), `Unexpected env key in replay child: ${k}`).toBe(true);
      }
      expect(spawn1.env.CLAUDISH_PANE_CHILD).toBe("1");
      expect(spawn1.env.CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL).toBe("1");
      expect(spawn1.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING).toBe("1");
      expect(spawn1.env.SHELL).toBe("/bin/zsh");
      expect(spawn1.env.HOME).toBe(layout.home);
      expect(spawn1.env.CLAUDE_CONFIG_DIR).toBe(layout.configDir);

      expect(ok(await call("close_replay", { replay_id: open1.replay_id }))).toEqual({
        closed: true,
      });

      // Case 2: Session whose folder no longer exists on disk + settings.json without statusLine object
      writeJson(join(layout.configDir, "settings.json"), {
        statusLine: "not-an-object",
        otherKey: 123,
      });
      const deletedDir = join(layout.root, "deleted-session-cwd");
      mkdirSync(deletedDir, { recursive: true });
      const sessMissingDir = seedSession({ sessionCwd: realpathSync(deletedDir) });
      rmSync(deletedDir, { recursive: true, force: true });

      const open2 = ok(await call("replay_session", { session_id: sessMissingDir.sessionId }));
      recordSpawnedPids();
      expect(standin.spawns()).toHaveLength(2);
      const spawn2 = standin.spawns()[1]!;
      expect(JSON.parse(spawn2.argv[10]!)).toEqual({
        wheelScrollAccelerationEnabled: false,
        tui: "fullscreen",
      });
      expect(spawn2.cwd).toBe(realpathSync(layout.cwd));

      expect(ok(await call("close_replay", { replay_id: open2.replay_id }))).toEqual({
        closed: true,
      });
    },
    T_TEST
  );

  test(
    "TEST-10 REQ-3: opening the same target twice (sequentially and concurrently) returns the same replay_id and spawns once; re-opens after close",
    async () => {
      standin.setScenario({ kind: "box", delayMs: 250 });
      const sess = seedSession();

      // Concurrent opens of the same session with different cols/rows
      const [resA, resB] = await Promise.all([
        call("replay_session", { session_id: sess.sessionId, cols: 120, rows: 40 }),
        call("replay_session", { session_id: sess.sessionId, cols: 90, rows: 30 }),
      ]);
      recordSpawnedPids();
      const bodyA = ok(resA);
      const bodyB = ok(resB);
      expect(bodyA.replay_id).toBe(bodyB.replay_id);
      expect(standin.spawns()).toHaveLength(1);

      // Sequential open while still open ignores new cols/rows and returns the same replay_id
      const bodyC = ok(
        await call("replay_session", { session_id: sess.sessionId, cols: 200, rows: 60 })
      );
      expect(bodyC.replay_id).toBe(bodyA.replay_id);
      expect(standin.spawns()).toHaveLength(1);

      const cap = ok(await call("capture_session", { session_id: bodyA.replay_id }));
      expect(cap.cols).toBe(120);
      expect(cap.rows).toBe(40);

      // After close_replay, opening again starts a new replay with a new replay_id
      expect(ok(await call("close_replay", { replay_id: bodyA.replay_id }))).toEqual({
        closed: true,
      });
      const bodyD = ok(await call("replay_session", { session_id: sess.sessionId }));
      recordSpawnedPids();
      expect(bodyD.replay_id).not.toBe(bodyA.replay_id);
      expect(standin.spawns()).toHaveLength(2);
      expect(ok(await call("close_replay", { replay_id: bodyD.replay_id }))).toEqual({
        closed: true,
      });

      // Team slot opened with and without run_id while open returns the same replay_id
      const teamSlot = await prepareFinishedTeamSlot("dedup-team");
      const teamOpen1 = ok(
        await call("team", {
          mode: "replay",
          path: teamSlot.path,
          slot: teamSlot.slot,
          run_id: teamSlot.runId,
        })
      );
      recordSpawnedPids();
      const teamOpen2 = ok(
        await call("team", {
          mode: "replay",
          path: teamSlot.path,
          slot: teamSlot.slot,
        })
      );
      expect(teamOpen2.replay_id).toBe(teamOpen1.replay_id);
      expect(standin.spawns()).toHaveLength(3);
      expect(ok(await call("close_replay", { replay_id: teamOpen1.replay_id }))).toEqual({
        closed: true,
      });
    },
    T_TEST
  );

  test(
    "TEST-11 REQ-2 REQ-6: clamps cols and rows on open and resize_session and reports changed accurately",
    async () => {
      // Open with undersized cols/rows -> clamped to 40x24
      const sess = seedSession();
      const opened = ok(
        await call("replay_session", { session_id: sess.sessionId, cols: 10, rows: 5 })
      );
      recordSpawnedPids();
      const replayId = opened.replay_id as string;

      const capInitial = ok(await call("capture_session", { session_id: replayId }));
      expect(capInitial.cols).toBe(40);
      expect(capInitial.rows).toBe(24);

      // Resize to same clamped size -> changed: false
      const sameResize = ok(
        await call("resize_session", { session_id: replayId, cols: 40, rows: 24 })
      );
      expect(sameResize).toMatchObject({
        session_id: replayId,
        cols: 40,
        rows: 24,
        changed: false,
      });

      // Resize to a new valid size -> changed: true, capture shows new size
      const newResize = ok(
        await call("resize_session", { session_id: replayId, cols: 100, rows: 35 })
      );
      expect(newResize).toMatchObject({
        session_id: replayId,
        cols: 100,
        rows: 35,
        changed: true,
      });
      expect(newResize.seq as number).toBeGreaterThanOrEqual(capInitial.seq as number);

      const capAfter = ok(await call("capture_session", { session_id: replayId }));
      expect(capAfter.cols).toBe(100);
      expect(capAfter.rows).toBe(35);
      expect((capAfter.lines as string[]).length).toBe(35);

      // Resize exceeding 4,000,000 cells (e.g. 5000 x 5000 = 25,000,000) -> clamped so cols * rows <= 4,000,000
      const hugeResize = ok(
        await call("resize_session", { session_id: replayId, cols: 5000, rows: 5000 })
      );
      expect((hugeResize.cols as number) * (hugeResize.rows as number)).toBeLessThanOrEqual(
        4_000_000
      );

      expect(ok(await call("close_replay", { replay_id: replayId }))).toEqual({ closed: true });
    },
    T_TEST
  );

  test(
    "TEST-12 REQ-6 REQ-7 REQ-9: capture_session (spans & since_seq) and scroll_session (1 row per wheel event, |by|<=200 cap, ctrl-End, stdin allowlist)",
    async () => {
      standin.setScenario({ kind: "box", historyLines: 60, endMarker: "BOTTOM-LINE-60" });
      const sess = seedSession();
      const opened = ok(
        await call("replay_session", { session_id: sess.sessionId, cols: 120, rows: 24 })
      );
      recordSpawnedPids();
      const replayId = opened.replay_id as string;

      // Before any scroll_session, stdin log must be completely empty
      expect(standin.stdinBytes()).toBe("");

      // Capture with spans:true and since_seq
      const cap0 = ok(await call("capture_session", { session_id: replayId, spans: true }));
      expect(Array.isArray(cap0.spans)).toBe(true);
      expect((cap0.spans as unknown[]).length).toBe(24);
      expect((cap0.lines as string[]).join("\n")).toContain("status: offset=0");
      expect((cap0.lines as string[]).join("\n")).toContain("HISTORY-ROW-60 BOTTOM-LINE-60");

      const unchanged = ok(
        await call("capture_session", { session_id: replayId, since_seq: cap0.seq })
      );
      expect(unchanged).toEqual({ unchanged: true, seq: cap0.seq, final: false });

      // Scroll up by -3 from live bottom -> 4 wheel-up events (`\x1b[<64;1;1M`: 1 dead first event + 3 moving), offset becomes 3
      const scrollUp = ok(await call("scroll_session", { session_id: replayId, by: -3 }));
      expect(scrollUp).toEqual({ session_id: replayId, seq: expect.any(Number) });
      const capUp = await waitFor(
        async () => {
          const c = ok(await call("capture_session", { session_id: replayId }));
          return (c.lines as string[]).join("\n").includes("status: offset=3") ? c : undefined;
        },
        { what: "offset=3 after scroll by -3", timeoutMs: 10_000, intervalMs: 50 }
      );
      expect((capUp.lines as string[]).join("\n")).toContain("HISTORY-ROW-57");
      expect((capUp.lines as string[]).join("\n")).not.toContain("HISTORY-ROW-60");
      expect(standin.stdinBytes()).toBe("\x1b[<64;1;1M".repeat(4));

      // Scroll down by +1 after direction change -> 2 wheel-down events (`\x1b[<65;1;1M`: 1 dead first event + 1 moving), offset becomes 2
      const scrollDown = ok(await call("scroll_session", { session_id: replayId, by: 1 }));
      expect(scrollDown).toEqual({ session_id: replayId, seq: expect.any(Number) });
      await waitFor(
        async () => {
          const c = ok(await call("capture_session", { session_id: replayId }));
          return (c.lines as string[]).join("\n").includes("status: offset=2") ? c : undefined;
        },
        { what: "offset=2 after scroll by +1", timeoutMs: 10_000, intervalMs: 50 }
      );
      expect(standin.stdinBytes()).toBe("\x1b[<64;1;1M".repeat(4) + "\x1b[<65;1;1M".repeat(2));

      // Scroll to:"end" -> sends `\x1b[1;5F` (ctrl-End) once, returns to offset=0
      const scrollEnd = ok(await call("scroll_session", { session_id: replayId, to: "end" }));
      expect(scrollEnd).toEqual({ session_id: replayId, seq: expect.any(Number) });
      await waitFor(
        async () => {
          const c = ok(await call("capture_session", { session_id: replayId }));
          return (c.lines as string[]).join("\n").includes("status: offset=0") ? c : undefined;
        },
        { what: "offset=0 after scroll to end", timeoutMs: 10_000, intervalMs: 50 }
      );
      expect(standin.stdinBytes()).toBe(
        "\x1b[<64;1;1M".repeat(4) + "\x1b[<65;1;1M".repeat(2) + "\x1b[1;5F"
      );

      // |by| is capped at 200: scrolling by 500 after to:"end" sends 201 wheel-down sequences (200 cap + 1 dead first event)
      const beforeCapBytes = standin.stdinBytes().length;
      const expectedCapSeqs = "\x1b[<65;1;1M".repeat(201);
      ok(await call("scroll_session", { session_id: replayId, by: 500 }));
      await waitFor(() => standin.stdinBytes().length >= beforeCapBytes + expectedCapSeqs.length, {
        what: "capped scroll bytes to arrive",
        timeoutMs: 5_000,
      });
      const deltaBytes = standin.stdinBytes().slice(beforeCapBytes);
      expect(deltaBytes).toBe(expectedCapSeqs);

      // Invalid scroll_session arguments on a replay_id -> invalid_args
      for (const bad of [{}, { by: 0 }, { by: -1, to: "end" }, { to: "top" }, { by: 1.5 }]) {
        contractError(
          await call("scroll_session", { session_id: replayId, ...bad }),
          "invalid_args"
        );
      }

      expect(ok(await call("close_replay", { replay_id: replayId }))).toEqual({ closed: true });
    },
    T_TEST
  );

  test(
    "TEST-13 REQ-7: send_input on any replay_id (open, closed, or never issued, with or without text) answers replay_read_only and writes nothing to stdin",
    async () => {
      const sess = seedSession();
      const opened = ok(await call("replay_session", { session_id: sess.sessionId }));
      recordSpawnedPids();
      const replayId = opened.replay_id as string;

      // Open replay_id with and without text
      contractError(
        await call("send_input", { session_id: replayId, text: "attempt turn" }),
        "replay_read_only"
      );
      contractError(await call("send_input", { session_id: replayId }), "replay_read_only");
      expect(standin.stdinBytes()).toBe("");

      // Never-issued replay_id with and without text
      const neverIssued = "replay-0123456789abcdef";
      contractError(
        await call("send_input", { session_id: neverIssued, text: "hello" }),
        "replay_read_only"
      );
      contractError(await call("send_input", { session_id: neverIssued }), "replay_read_only");

      // Closed replay_id
      expect(ok(await call("close_replay", { replay_id: replayId }))).toEqual({ closed: true });
      contractError(
        await call("send_input", { session_id: replayId, text: "after close" }),
        "replay_read_only"
      );

      // Non-replay unknown session_id still behaves as before
      const nonReplay = ok(await sendInput(currentServer(), "deadbeef", "hi"));
      expect(nonReplay).toMatchObject({ success: false, reason: "unknown_session" });
    },
    T_TEST
  );

  test(
    "TEST-14 REQ-8: a replay is not listed in list_sessions or team(mode:list) and is rejected by get_output, cancel_session, get_diagnostics and transcript_session",
    async () => {
      const sess = seedSession();
      const opened = ok(await call("replay_session", { session_id: sess.sessionId }));
      recordSpawnedPids();
      const replayId = opened.replay_id as string;
      const neverIssued = "never123";

      const activeList = ok(await call("list_sessions", { include_completed: false }));
      expect((activeList.sessions as Json[]).some((s) => s.session_id === replayId)).toBe(false);

      const allList = ok(await call("list_sessions", { include_completed: true }));
      expect((allList.sessions as Json[]).some((s) => s.session_id === replayId)).toBe(false);

      const teamList = ok(await call("team", { mode: "list" }));
      expect(JSON.stringify(teamList.runs)).not.toContain(replayId);

      // cancel_session and transcript_session return ContractError unknown_session
      contractError(await call("cancel_session", { session_id: replayId }), "unknown_session");
      contractError(await call("transcript_session", { session_id: replayId }), "unknown_session");

      // get_output and get_diagnostics behave the same as a never-issued id
      for (const tool of ["get_output", "get_diagnostics"] as const) {
        const resReplay = await call(tool, { session_id: replayId });
        const resMissing = await call(tool, { session_id: neverIssued });
        expect(resReplay.isError).toBe(true);
        expect(resMissing.isError).toBe(true);
      }

      expect(ok(await call("close_replay", { replay_id: replayId }))).toEqual({ closed: true });
    },
    T_TEST
  );

  test(
    "TEST-15 REQ-10: original transcript sha256 is unchanged, fork record is deleted on close_replay, and closed replay_id answers unknown_session",
    async () => {
      standin.setScenario({ kind: "box", writeForkRecord: true });
      const sess = seedSession();
      const shaBefore = sha256File(sess.transcriptPath);

      const opened = ok(await call("replay_session", { session_id: sess.sessionId }));
      recordSpawnedPids();
      const replayId = opened.replay_id as string;
      const spawn = standin.spawns().at(-1)!;
      expect(spawn.forkRecordPath).not.toBeNull();
      const forkPath = spawn.forkRecordPath!;
      const expectedSlug = slugOfCwd(sess.sessionCwd);
      expect(forkPath).toContain(join(layout.configDir, "projects", expectedSlug));
      expect(existsSync(forkPath)).toBe(true);

      // Perform capture, scroll, resize
      ok(await call("capture_session", { session_id: replayId }));
      ok(await call("scroll_session", { session_id: replayId, by: -2 }));
      ok(await call("resize_session", { session_id: replayId, cols: 140, rows: 45 }));

      // Close replay -> fork record is deleted, process is gone, original sha256 is untouched
      expect(ok(await call("close_replay", { replay_id: replayId }))).toEqual({ closed: true });
      expect(pidAlive(spawn.pid)).toBe(false);
      expect(existsSync(forkPath)).toBe(false);
      expect(sha256File(sess.transcriptPath)).toBe(shaBefore);

      // Second close_replay is idempotent
      expect(ok(await call("close_replay", { replay_id: replayId }))).toEqual({ closed: true });

      // capture_session, resize_session, scroll_session after close answer unknown_session
      contractError(await call("capture_session", { session_id: replayId }), "unknown_session");
      contractError(
        await call("resize_session", { session_id: replayId, cols: 100, rows: 30 }),
        "unknown_session"
      );
      contractError(
        await call("scroll_session", { session_id: replayId, by: -1 }),
        "unknown_session"
      );
    },
    T_TEST
  );

  test(
    "TEST-16 REQ-6 REQ-11: self-exiting replay answers final:true on capture, changed:false on resize, scroll_unavailable on scroll, and allows re-open",
    async () => {
      standin.setScenario({
        kind: "box_then_exit",
        delayMs: 400,
        exitCode: 0,
        endMarker: "LAST-SCREEN-BEFORE-EXIT",
      });
      const sess = seedSession();
      const opened = ok(
        await call("replay_session", { session_id: sess.sessionId, cols: 110, rows: 32 })
      );
      recordSpawnedPids();
      const replayId = opened.replay_id as string;
      const firstSpawnPid = standin.spawns().at(-1)!.pid;

      // Wait for the replay process to exit on its own and capture to report final:true
      const finalCap = await waitFor(
        async () => {
          const c = ok(await call("capture_session", { session_id: replayId }));
          return c.final === true ? c : undefined;
        },
        { what: "self-exited replay to report final:true", timeoutMs: 15_000, intervalMs: 100 }
      );
      expect((finalCap.lines as string[]).join("\n")).toContain("LAST-SCREEN-BEFORE-EXIT");
      expect(pidAlive(firstSpawnPid)).toBe(false);

      // Repeated capture still returns the last screen with final:true
      const repeatCap = ok(
        await call("capture_session", { session_id: replayId, since_seq: finalCap.seq })
      );
      expect(repeatCap).toEqual({ unchanged: true, seq: finalCap.seq, final: true });

      // resize_session on a finished replay answers its last size with changed:false and no pending
      const resizeFinished = ok(
        await call("resize_session", { session_id: replayId, cols: 150, rows: 40 })
      );
      expect(resizeFinished).toEqual({
        session_id: replayId,
        cols: 110,
        rows: 32,
        changed: false,
        seq: finalCap.seq,
      });
      expect(Object.hasOwn(resizeFinished, "pending")).toBe(false);

      // scroll_session on a finished replay answers scroll_unavailable
      contractError(
        await call("scroll_session", { session_id: replayId, by: -1 }),
        "scroll_unavailable"
      );

      // Opening the same session after self-exit starts a fresh replay with a new replay_id
      standin.setScenario({ kind: "box" });
      const reopened = ok(await call("replay_session", { session_id: sess.sessionId }));
      recordSpawnedPids();
      expect(reopened.replay_id).not.toBe(replayId);
      expect(ok(await call("close_replay", { replay_id: reopened.replay_id }))).toEqual({
        closed: true,
      });
      expect(ok(await call("close_replay", { replay_id: replayId }))).toEqual({
        closed: true,
      });
    },
    T_TEST
  );

  test(
    "TEST-17 REQ-12 (R-TERM & R-WATCHER): close_replay kills a process trapping SIGTERM and SIGHUP and leaves no pane process or file",
    async () => {
      standin.setScenario({ kind: "box", trapSignals: true, writeForkRecord: true });
      const sess = seedSession();
      const opened = ok(await call("replay_session", { session_id: sess.sessionId }));
      recordSpawnedPids();
      const replayId = opened.replay_id as string;
      const spawn = standin.spawns().at(-1)!;
      expect(pidAlive(spawn.pid)).toBe(true);

      const closeRes = ok(await call("close_replay", { replay_id: replayId }));
      expect(closeRes).toEqual({ closed: true });

      // R-TERM: exact pid is dead when close_replay returns
      expect(pidAlive(spawn.pid)).toBe(false);

      // R-WATCHER: no process naming the pane root or replay id, and panes/ directory is empty
      const paneRoot = paneRootOf(layout);
      const table = requireProcessTable();
      const lingering = table.filter(
        (r) =>
          r.pid !== process.pid && (r.command.includes(paneRoot) || r.command.includes(replayId))
      );
      expect(lingering).toEqual([]);
      if (existsSync(join(paneRoot, "panes"))) {
        expect(readdirSync(join(paneRoot, "panes"))).toEqual([]);
      }
      if (existsSync(paneRoot)) {
        const extraFiles = readdirSync(paneRoot).filter((n) => n !== "panes");
        expect(extraFiles).toEqual([]);
      }
    },
    T_TEST
  );

  test(
    "TEST-18 REQ-12 (R-EARLY & R-SIGKILL): server exit while replay is still drawing and SIGKILL of server leave no replay process",
    async () => {
      // Part 1 (R-EARLY): stand-in draws nothing (hangs before box) and traps SIGTERM/SIGHUP;
      // server closes while replay_session is in flight.
      standin.setScenario({ kind: "hang_before_box", trapSignals: true });
      const sess1 = seedSession();
      const inFlight = call("replay_session", { session_id: sess1.sessionId }).catch(() => null);
      const earlySpawn = await waitFor(() => standin.spawns()[0], {
        what: "in-flight stand-in to record its pid",
        timeoutMs: 10_000,
        intervalMs: 50,
      });
      trackedReplayPids.add(earlySpawn.pid);
      expect(pidAlive(earlySpawn.pid)).toBe(true);

      await currentServer().close();
      await inFlight;
      await waitFor(() => !pidAlive(earlySpawn.pid), {
        what: "in-flight stand-in pid to be reaped on server close",
        timeoutMs: 10_000,
        intervalMs: 50,
      });
      expect(pidAlive(earlySpawn.pid)).toBe(false);

      // Part 2 (R-SIGKILL): open a replay on a fresh server, then SIGKILL the server;
      // the replay process must be gone within 5 s by exact pid.
      standin.setScenario({ kind: "box", trapSignals: false });
      server = await startServer();
      const sess2 = seedSession();
      const opened = ok(await call("replay_session", { session_id: sess2.sessionId }));
      recordSpawnedPids();
      expect(opened.replay_id).toMatch(REPLAY_ID_RE);
      const liveSpawn = standin.spawns().at(-1)!;
      expect(pidAlive(liveSpawn.pid)).toBe(true);

      const killedAt = performance.now();
      currentServer().proc.kill("SIGKILL");
      await currentServer().proc.exited;
      await waitFor(() => !pidAlive(liveSpawn.pid), {
        what: "replay process to exit within 5 s after server SIGKILL",
        timeoutMs: 5_000,
        intervalMs: 50,
      });
      expect(performance.now() - killedAt).toBeLessThanOrEqual(5_000);
      expect(pidAlive(liveSpawn.pid)).toBe(false);
    },
    T_TEST
  );
});
