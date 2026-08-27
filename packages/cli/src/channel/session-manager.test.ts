/**
 * Unit and process-level regression tests for the bidirectional stream-json
 * channel transport.
 *
 * SessionManager spawns the stream-json-speaking fake through the CLAUDISH_BIN
 * seam. Every manager gets an explicit temporary sessionsDir, so this file
 * never resolves either the installed claudish binary or ~/.claudish/sessions.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { mapEventToTaskStatus } from "../mcp-server.js";
import {
  SessionManager,
  assertNoReservedFlags,
  buildChannelSpawnArgs,
  userFrame,
} from "./session-manager.js";
import {
  CAPTURED_ASSISTANT_PROSE,
  CAPTURED_DELTA_LINE,
  capturedAssistantFrame,
} from "./test-helpers/captured-stream-json.js";
import type { ChannelEvent, SessionManagerOptions, SessionStatus } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FAKE_CLAUDISH_TS = join(__dirname, "test-helpers", "fake-channel-stream-json.ts");
const SIGNAL_CHILD_TS = join(__dirname, "test-helpers", "stats-buffer-signal-child.ts");
const TERMINAL_STATUSES: readonly SessionStatus[] = ["completed", "failed", "cancelled", "timeout"];
// Must match KILL_GRACE_MS in session-manager.ts:210; post-SIGTERM waits must exceed it.
const KILL_GRACE_MS = 5000;
const POST_SIGTERM_WAIT_MS = KILL_GRACE_MS + 2000;
const TIMEOUT_REGRESSION_TEST_MS = POST_SIGTERM_WAIT_MS * 2 + 1000;

const ORIGINAL_CLAUDISH_BIN = process.env.CLAUDISH_BIN;
let sessionsDir: string;
let managers: SessionManager[] = [];

beforeAll(() => {
  sessionsDir = mkdtempSync(join(tmpdir(), "claudish-channel-sessions-"));
  process.env.CLAUDISH_BIN = FAKE_CLAUDISH_TS;
});

afterAll(() => {
  if (ORIGINAL_CLAUDISH_BIN === undefined) delete process.env.CLAUDISH_BIN;
  else process.env.CLAUDISH_BIN = ORIGINAL_CLAUDISH_BIN;
  rmSync(sessionsDir, { recursive: true, force: true });
});

function waitUntil(predicate: () => boolean, timeoutMs = 5000, intervalMs = 25): Promise<void> {
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

function makeManager(opts?: SessionManagerOptions): SessionManager {
  const manager = new SessionManager({
    maxSessions: 20,
    sessionsDir,
    stallSeconds: 0,
    ...opts,
  });
  managers.push(manager);
  return manager;
}

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

async function waitForStatus(
  manager: SessionManager,
  sessionId: string,
  statuses: readonly SessionStatus[],
  timeoutMs = 5000
): Promise<void> {
  await waitUntil(() => statuses.includes(manager.getSession(sessionId).status), timeoutMs);
}

async function waitForCompleted(manager: SessionManager, sessionId: string): Promise<void> {
  await waitForStatus(manager, sessionId, ["completed"]);
}

async function waitForMeta(sessionId: string, timeoutMs = 5000): Promise<string> {
  const metaPath = join(sessionsDir, sessionId, "meta.json");
  await waitUntil(() => existsSync(metaPath), timeoutMs);
  return metaPath;
}

beforeEach(() => {
  managers = [];
});

afterEach(async () => {
  // Cancel only live sessions. Calling shutdownAll on a process that already
  // exited waits for an exit event that has already happened.
  for (const manager of managers) {
    for (const session of manager.listSessions(false)) {
      manager.cancelSession(session.sessionId);
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 75));
});

describe("SessionManager", () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = makeManager();
  });

  test("createSession returns unique session IDs", () => {
    const id1 = manager.createSession({ model: "test-model", claudishFlags: ["--sleep", "3"] });
    const id2 = manager.createSession({ model: "test-model", claudishFlags: ["--sleep", "3"] });
    expect(id1).not.toBe(id2);
    expect(id1.length).toBeGreaterThan(0);
    expect(id2.length).toBeGreaterThan(0);
  });

  test("getSession returns correct model/status/sessionId fields", () => {
    const id = manager.createSession({ model: "test-model", claudishFlags: ["--sleep", "3"] });
    const info = manager.getSession(id);
    expect(info.sessionId).toBe(id);
    expect(info.model).toBe("test-model");
    expect(["starting", "running"]).toContain(info.status);
    expect(info.pid).not.toBeNull();
    expect(typeof info.startedAt).toBe("string");
    expect(info.completedAt).toBeNull();
    expect(info.exitCode).toBeNull();
  });

  test("spawnModel changes argv while SessionInfo keeps the requested model", async () => {
    const id = manager.createSession({
      model: "glm-5",
      spawnModel: "gc@glm-5",
      prompt: "report argv",
      claudishFlags: ["--print-argv"],
    });

    await waitForCompleted(manager, id);

    const argv = JSON.parse(manager.getOutput(id).output.trim()) as string[];
    const modelFlag = argv.indexOf("--model");
    expect(argv[modelFlag + 1]).toBe("gc@glm-5");
    expect(argv).not.toContain("--stdin");
    expect(manager.getSession(id).model).toBe("glm-5");
  });

  test("spawn argv falls back to the requested model when spawnModel is absent", async () => {
    const id = manager.createSession({
      model: "glm-5",
      prompt: "report argv",
      claudishFlags: ["--print-argv"],
    });

    await waitForCompleted(manager, id);

    const argv = JSON.parse(manager.getOutput(id).output.trim()) as string[];
    const modelFlag = argv.indexOf("--model");
    expect(argv[modelFlag + 1]).toBe("glm-5");
    expect(argv).toContain("stream-json");
    expect(manager.getSession(id).model).toBe("glm-5");
  });

  test("getSession throws for non-existent session", () => {
    expect(() => manager.getSession("nonexistent")).toThrow("not found");
  });

  test("listSessions includes active session", () => {
    const id = manager.createSession({ model: "test-model", claudishFlags: ["--sleep", "3"] });
    expect(manager.listSessions(false).some((session) => session.sessionId === id)).toBe(true);
  });

  test("listSessions excludes completed sessions when includeCompleted=false", async () => {
    const id = quickSession(manager);
    await waitForCompleted(manager, id);
    expect(manager.listSessions(false).some((session) => session.sessionId === id)).toBe(false);
  });

  test("listSessions includes completed sessions when includeCompleted=true", async () => {
    const id = quickSession(manager);
    await waitForCompleted(manager, id);
    expect(manager.listSessions(true).some((session) => session.sessionId === id)).toBe(true);
  });

  test("maxSessions limit: 3rd session throws when limit is 2", () => {
    const limited = makeManager({ maxSessions: 2 });
    limited.createSession({ model: "m", claudishFlags: ["--sleep", "3"] });
    limited.createSession({ model: "m", claudishFlags: ["--sleep", "3"] });
    expect(() => limited.createSession({ model: "m", claudishFlags: ["--sleep", "3"] })).toThrow(
      /Max sessions/
    );
  });

  test("cancelSession: status becomes 'cancelled'", async () => {
    const id = manager.createSession({
      model: "test-model",
      claudishFlags: ["--sleep", "60"],
    });
    await waitUntil(() => manager.getSession(id).pid !== null);

    expect(manager.cancelSession(id)).toBe(true);
    expect(manager.getSession(id).status).toBe("cancelled");
  });

  test("cancelSession returns false for completed session", async () => {
    const id = quickSession(manager);
    await waitForCompleted(manager, id);
    expect(manager.cancelSession(id)).toBe(false);
  });

  test("sendInput returns false for non-existent session", () => {
    expect(manager.sendInput("does-not-exist", "hello")).toBe(false);
  });

  test("sendInput returns false for completed session", async () => {
    const id = quickSession(manager);
    await waitForCompleted(manager, id);
    expect(manager.sendInput(id, "some input")).toBe(false);
  });

  test("getOutput returns output from process stdout", async () => {
    const id = quickSession(manager, [], "hello world");
    await waitForCompleted(manager, id);

    const output = manager.getOutput(id);
    expect(output.sessionId).toBe(id);
    expect(output.status).toBe("completed");
    expect(output.output).toContain(CAPTURED_ASSISTANT_PROSE);
    expect(output.output).not.toContain('"type":"assistant"');
  });

  test("getOutput with tail_lines returns only the last N lines", async () => {
    const id = quickSession(manager, ["--messages", "5"]);
    await waitForCompleted(manager, id);

    const full = manager.getOutput(id);
    const tail = manager.getOutput(id, 2);
    const fullLines = full.output.split("\n");
    expect(tail.output).toBe(fullLines.slice(-2).join("\n"));
    expect(tail.output.split("\n")).toHaveLength(2);
    expect(tail.totalLines).toBe(full.totalLines);
    expect(tail.output).not.toBe(full.output);
  });

  test("getOutput throws for non-existent session", () => {
    expect(() => manager.getOutput("bad-id")).toThrow("not found");
  });

  test("timeout kills long-running process and terminates it", async () => {
    const id = manager.createSession({
      model: "test-model",
      timeoutSeconds: 1,
      claudishFlags: ["--sleep", "60"],
    });

    const metaPath = await waitForMeta(id, 4000);
    const info = manager.getSession(id);
    const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as { status: string };
    expect(info.completedAt).not.toBeNull();
    expect(info.status).toBe("timeout");
    expect(meta.status).toBe("timeout");
  }, 10_000);

  test("onStateChange callback fires with session_id and event", async () => {
    const events: Array<{ sessionId: string; event: ChannelEvent }> = [];
    const callbackManager = makeManager({
      onStateChange: (sessionId, event) => events.push({ sessionId, event }),
    });
    const id = quickSession(callbackManager, [], "trigger events");

    await waitForCompleted(callbackManager, id);

    expect(events.map(({ event }) => event.type)).toEqual([
      "running",
      "waiting_for_input",
      "completed",
    ]);
    for (const observed of events) {
      expect(observed.sessionId).toBe(id);
      expect(observed.event.model).toBe("test-model");
    }
  });

  test("meta.json is written to the configured sessions directory after completion", async () => {
    const id = quickSession(manager);
    const metaPath = await waitForMeta(id);
    const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as Record<string, unknown>;

    expect(meta.sessionId).toBe(id);
    expect(meta.model).toBe("test-model");
    expect(meta.status).toBe("completed");
    expect(meta.turnsCompleted).toBe(1);
    expect(typeof meta.startedAt).toBe("string");
    expect(typeof meta.completedAt).toBe("string");
  });

  test("createSession stores session in listSessions immediately", () => {
    const id = manager.createSession({
      model: "test-model",
      claudishFlags: ["--sleep", "3"],
    });
    expect(manager.listSessions(true).some((session) => session.sessionId === id)).toBe(true);
  });

  test("cancelled session appears in listSessions with includeCompleted=true", async () => {
    const id = manager.createSession({
      model: "test-model",
      claudishFlags: ["--sleep", "3"],
    });
    await waitUntil(() => manager.getSession(id).pid !== null);
    manager.cancelSession(id);

    const found = manager.listSessions(true).find((session) => session.sessionId === id);
    expect(found?.status).toBe("cancelled");
  });

  test("getOutput totalLines reflects number of lines produced", async () => {
    const id = quickSession(manager, ["--messages", "5"]);
    await waitForCompleted(manager, id);
    expect(manager.getOutput(id).totalLines).toBeGreaterThanOrEqual(5);
  });

  test("cancelSession returns false for non-existent session", () => {
    expect(manager.cancelSession("ghost-session")).toBe(false);
  });

  test(
    "G1/G2: timeout stays timeout in memory, meta, and on the wire",
    async () => {
      const events: ChannelEvent[] = [];
      const timeoutManager = makeManager({
        onStateChange: (_sessionId, event) => events.push(event),
      });
      const id = timeoutManager.createSession({
        model: "test-model",
        timeoutSeconds: 1,
        claudishFlags: ["--result-then-hang", "--trap-term-exit-zero"],
      });

      await waitForStatus(timeoutManager, id, ["running"]);
      expect(timeoutManager.sendInput(id, "interactive turn")).toBe(true);
      await waitForStatus(timeoutManager, id, ["waiting_for_input"]);

      // If the SIGTERM trap loses its race, SIGKILL follows only after the full
      // grace, then exit, pipe drain, and writeArtifacts must finish. Keep these
      // polling budgets above KILL_GRACE_MS or load makes this a fast-path-only test.
      await waitForStatus(timeoutManager, id, ["timeout"], POST_SIGTERM_WAIT_MS);
      const metaPath = await waitForMeta(id, POST_SIGTERM_WAIT_MS);
      const info = timeoutManager.getSession(id);
      const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as {
        status: string;
        exitCode: number | null;
      };
      const terminalWireEvents = events
        .map((event) => event.type)
        .filter((type) => TERMINAL_STATUSES.includes(type as SessionStatus));

      // Same test, deliberately: memory, persistent data, and the wire must all
      // report the honest terminal reason. SEP-1686 projects timeout to failed.
      expect(info.status).toBe("timeout");
      expect(meta.status).toBe("timeout");
      expect(info.exitCode).toBe(0);
      expect(meta.exitCode).toBe(0);
      expect(terminalWireEvents).toEqual(["timeout"]);
      expect(events.some((event) => event.type === "timeout")).toBe(true);
    },
    TIMEOUT_REGRESSION_TEST_MS
  );

  test("G7: a promptless session reaches a usable state and accepts later input", async () => {
    const id = manager.createSession({ model: "test-model", timeoutSeconds: 5 });

    await waitForStatus(manager, id, ["running"], 2000);
    expect(manager.sendInput(id, "first interactive turn")).toBe(true);
    await waitUntil(
      () =>
        manager.getSession(id).status === "waiting_for_input" &&
        manager.getOutput(id).output.includes(CAPTURED_ASSISTANT_PROSE),
      2000
    );

    expect(existsSync(join(sessionsDir, id, "prompt.md"))).toBe(false);
    expect(manager.getSession(id).status).toBe("waiting_for_input");
    expect(manager.cancelSession(id)).toBe(true);
  });

  test("G6: delta firehose is not stored and cannot evict assistant prose", () => {
    const boundedManager = makeManager({ scrollbackCapacity: 2000 });
    const id = boundedManager.createSession({
      model: "test-model",
      claudishFlags: ["--sleep", "60"],
    });
    const internal = boundedManager as unknown as {
      sessions: Map<string, { process: ChildProcess }>;
    };
    const stdout = internal.sessions.get(id)?.process.stdout;
    if (!stdout) throw new Error("spawned test child has no stdout pipe");

    for (let i = 0; i < 3; i++) {
      stdout.emit("data", Buffer.from(`${JSON.stringify(capturedAssistantFrame())}\n`));
    }
    stdout.emit("data", Buffer.from(`${CAPTURED_DELTA_LINE}\n`.repeat(3000)));

    const output = boundedManager.getOutput(id);
    expect(output.output).toContain(CAPTURED_ASSISTANT_PROSE);
    expect(output.output).not.toContain('"type":"stream_event"');
    expect(output.totalLines).toBeLessThan(20);
  });

  test("D1: a new manager recovers a finished session from disk", async () => {
    const id = quickSession(manager, [], "DELTA");
    await waitForCompleted(manager, id);
    await waitForMeta(id);

    const liveInfo = manager.getSession(id);
    const liveOutput = manager.getOutput(id);
    const recovered = makeManager();

    const info = recovered.getSession(id);
    const output = recovered.getOutput(id);
    const diagnostics = recovered.getDiagnostics(id);

    expect(info).toMatchObject({
      sessionId: id,
      model: liveInfo.model,
      status: "completed",
      turnsCompleted: liveInfo.turnsCompleted,
      exitCode: liveInfo.exitCode,
    });
    expect(output).toMatchObject({
      sessionId: id,
      status: "completed",
      turnsCompleted: liveOutput.turnsCompleted,
      tokensUsed: liveOutput.tokensUsed,
    });
    // ScrollbackBuffer is chunk-boundary sensitive: live can retain a phantom
    // trailing line that a one-append disk replay correctly cannot reproduce.
    expect(output.output.trimEnd()).toBe(liveOutput.output.trimEnd());
    expect(diagnostics).toMatchObject({
      sessionId: id,
      status: "completed",
      model: liveInfo.model,
      turnsCompleted: liveInfo.turnsCompleted,
    });
    expect(diagnostics.outputBytes).toBeGreaterThan(0);
    expect(diagnostics.eventsTotal).toBeGreaterThan(0);
    expect(diagnostics.recentEvents.every((event) => event.at === "")).toBe(true);
  });

  test("D2: a disk-recovered session is structurally read-only", async () => {
    const id = quickSession(manager);
    await waitForCompleted(manager, id);
    await waitForMeta(id);

    const recovered = makeManager();
    expect(recovered.getSession(id).pid).toBeNull();
    expect(recovered.sendInput(id, "hello")).toBe(false);
    expect(recovered.cancelSession(id)).toBe(false);
  });

  test("D3: hostile session ids are rejected before disk lookup", () => {
    const root = join(sessionsDir, "hostile-root");
    const outside = join(root, "outside");
    mkdirSync(join(outside, "victim"), { recursive: true });
    writeFileSync(join(outside, "victim", "meta.json"), JSON.stringify({ model: "LEAKED" }));
    const hostileManager = makeManager({ sessionsDir: join(root, "sessions") });

    for (const id of [
      "../outside/victim",
      "..%2Foutside",
      "../../etc",
      "..",
      ".",
      "/etc/passwd",
      "a/b",
      "a\\b",
      "with\0null",
      "",
      ".hidden",
      "x".repeat(200),
    ]) {
      expect(() => hostileManager.getSession(id), JSON.stringify(id)).toThrow("not found");
    }
  });

  test("D4: malformed disk records degrade to diagnostics instead of throwing", () => {
    const cases: Array<[string, string | null]> = [
      ["nometa", null],
      ["halfwritten", '{"sessionId":"halfwr'],
      ["emptymeta", ""],
      [
        "wrongtypes",
        JSON.stringify({
          sessionId: 42,
          model: null,
          status: "banana",
          tokensUsed: "lots",
          pid: 1,
          startedAt: [],
          elapsedSeconds: Number.NaN,
        }),
      ],
      ["notjson", "[1,2,3]"],
    ];

    for (const [id, meta] of cases) {
      const dir = join(sessionsDir, id);
      mkdirSync(dir, { recursive: true });
      if (meta !== null) writeFileSync(join(dir, "meta.json"), meta);
      if (id === "halfwritten") writeFileSync(join(dir, "output.log"), "partial answer\n");

      const info = manager.getSession(id);
      const output = manager.getOutput(id);
      const diagnostics = manager.getDiagnostics(id);
      expect(info.sessionId).toBe(id);
      expect(info.pid).toBeNull();
      expect(typeof info.tokensUsed).toBe("number");
      expect(Number.isFinite(info.elapsedSeconds)).toBe(true);
      expect(typeof output.output).toBe("string");
      expect(typeof diagnostics.stderrTail).toBe("string");
      if (id !== "wrongtypes") {
        expect(diagnostics.anomalies.length, id).toBeGreaterThan(0);
      }
    }
  });

  test("D5: disk diagnostics stay bounded for a 4 MB event log", () => {
    const id = "bigsession";
    const dir = join(sessionsDir, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({
        sessionId: id,
        model: "m",
        status: "failed",
        startedAt: new Date().toISOString(),
      })
    );

    const frames: string[] = [];
    let eventBytes = 0;
    for (let i = 0; eventBytes < 4 * 1024 * 1024; i++) {
      const frame = `${JSON.stringify({
        type: "assistant",
        subtype: null,
        i,
        pad: "x".repeat(2000),
      })}\n`;
      frames.push(frame);
      eventBytes += Buffer.byteLength(frame);
    }
    writeFileSync(join(dir, "events.jsonl"), frames.join(""));

    const diagnostics = manager.getDiagnostics(id, 200);
    expect(Buffer.byteLength(JSON.stringify(diagnostics))).toBeLessThan(512 * 1024);
    expect(diagnostics.eventsTotal).toBeLessThan(512);
    expect(diagnostics.recentEvents).toHaveLength(200);
    expect(diagnostics.recentEvents.every((event) => event.preview.length <= 800)).toBe(true);
  });
});

describe("exported channel transport seams", () => {
  test("timeout projects to SEP-1686 failed instead of falling through to working", () => {
    expect(mapEventToTaskStatus("timeout")).toBe("failed");
    expect(mapEventToTaskStatus("timeout")).not.toBe("working");
    expect(mapEventToTaskStatus("genuinely_unknown_event")).toBe("working");

    for (const [event, status] of [
      ["completed", "completed"],
      ["failed", "failed"],
      ["cancelled", "cancelled"],
    ] as const) {
      expect(mapEventToTaskStatus(event)).toBe(status);
    }
  });

  test("G4: every transport-owned flag is rejected loudly", () => {
    for (const flag of [
      "-p",
      "--print",
      "--output-format",
      "--input-format",
      "--session-id",
      "--verbose",
      "--output-format=json",
    ]) {
      expect(() => assertNoReservedFlags([flag])).toThrow(/channel transport/);
    }

    expect(() =>
      assertNoReservedFlags(["--effort", "high", "--agent", "dev:reviewer"])
    ).not.toThrow();
  });

  test("G5: spawn argv keeps verbose before quiet and leaves -p valueless", () => {
    const args = buildChannelSpawnArgs({
      model: "provider@model",
      claudeSessionId: "captured-session-id",
      claudishFlags: ["--effort", "high"],
    });
    const verboseAt = args.indexOf("--verbose");
    const quietAt = args.indexOf("--quiet");
    const printAt = args.indexOf("-p");

    expect(verboseAt).toBeGreaterThan(-1);
    expect(quietAt).toBeGreaterThan(verboseAt);
    expect(printAt).toBeGreaterThan(-1);
    expect(args[printAt + 1]?.startsWith("-")).toBe(true);
    expect(args).not.toContain("--stdin");
  });

  test("userFrame encodes one newline-delimited user turn", () => {
    const encoded = userFrame("hello\nworld");
    expect(encoded.endsWith("\n")).toBe(true);
    expect(encoded.split("\n")).toHaveLength(2);
    expect(JSON.parse(encoded)).toEqual({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "hello\nworld" }],
      },
    });
  });
});

interface ExitObservation {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

async function runSignalChild(signal: "SIGTERM" | "SIGINT"): Promise<ExitObservation> {
  const child = spawn(process.execPath, ["run", SIGNAL_CHILD_TS], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf-8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf-8");
  });

  try {
    await waitUntil(() => stdout.includes("ready"), 3000);
    const exit = new Promise<ExitObservation>((resolve) => {
      child.once("exit", (code, observedSignal) => {
        resolve({ code, signal: observedSignal as NodeJS.Signals | null, stderr });
      });
    });
    child.kill(signal);
    return await Promise.race([
      exit,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`signal child did not exit after ${signal}`)), 3000)
      ),
    ]);
  } finally {
    stopChild(child);
  }
}

function stopChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
}

describe("claudish signal exit codes", () => {
  test("G3: module-load signal handlers preserve SIGTERM=143 and SIGINT=130", async () => {
    const term = await runSignalChild("SIGTERM");
    const interrupt = await runSignalChild("SIGINT");

    expect({ code: term.code, signal: term.signal, stderr: term.stderr }).toEqual({
      code: 143,
      signal: null,
      stderr: "",
    });
    expect({ code: interrupt.code, signal: interrupt.signal, stderr: interrupt.stderr }).toEqual({
      code: 130,
      signal: null,
      stderr: "",
    });
  }, 10_000);
});
