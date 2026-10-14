/** Real MCP stdio → real headless magmux → hermetic interactive fake child. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  McpServer,
  type ToolResult,
  paneOrphans,
  serverEnv,
} from "../test-helpers/contract-mcp.js";
import { type TempLayout, makeTempLayout, waitFor } from "../test-helpers/contract-records.js";
import type { CaptureResult, ResizeResult, TeamResizeResult } from "./contract.js";
import { MagmuxClient } from "./magmux-client.js";
import {
  MAGMUX,
  killLeftovers,
  makePaneTestEnv,
  waitNoOrphans,
} from "./test-helpers/hermetic-env.js";

let resizeUnavailableReason = MAGMUX
  ? "resolved magmux capabilities.verbs lacks resize; not checked"
  : "magmux not installed; not checked";

/** Probe the resolved binary itself, independently of any feature test or version number. */
async function resizeAvailable(): Promise<boolean> {
  if (!MAGMUX) return false;
  const env = makePaneTestEnv({ COLUMNS: "80", LINES: "24" });
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let client: MagmuxClient | undefined;
  try {
    mkdirSync(env.sockRoot, { recursive: true });
    proc = Bun.spawn(
      [MAGMUX, "--headless", "--no-status", "--sock-dir", env.sockRoot, "--", "/bin/sleep", "30"],
      { env: env.env, cwd: env.cwd, stdin: "ignore", stdout: "ignore", stderr: "pipe" }
    );
    const socket = await waitFor(
      () => {
        if (proc?.exitCode !== null) throw new Error("magmux capability probe exited before its socket appeared");
        try {
          return findSocket(env.sockRoot);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          return undefined;
        }
      },
      { what: "capability probe socket", timeoutMs: 5_000, intervalMs: 50 }
    ).catch(async (error) => {
      proc?.kill("SIGTERM");
      const stderr = proc?.stderr instanceof ReadableStream ? await new Response(proc.stderr).text() : "";
      throw new Error(`${String(error)}; magmux stderr: ${stderr}`);
    });
    client = await MagmuxClient.connect(socket);
    const reply = await client.request<{ verbs: string[] }>({ type: "capabilities" });
    if (!reply.ok) throw new Error(`magmux capabilities: ${reply.code}: ${reply.error}`);
    if (!Array.isArray(reply.result.verbs)) throw new Error("magmux capabilities lacks verbs");
    return reply.result.verbs.includes("resize");
  } catch (error) {
    // Restricted runners cannot bind unix sockets. This is not evidence about verbs.
    if (String(error).includes("bind: operation not permitted")) {
      resizeUnavailableReason = "capabilities not checked: sandbox denied magmux unix socket bind";
      return false;
    }
    throw error;
  } finally {
    client?.close();
    proc?.kill("SIGTERM");
    if (proc) {
      const ended = await Promise.race([proc.exited.then(() => true), Bun.sleep(2_000).then(() => false)]);
      if (!ended) {
        proc.kill("SIGKILL");
        await proc.exited;
      }
    }
    // The trivial pane child must also be gone before removing the probe's socket directory.
    killLeftovers({ sockRoot: env.sockRoot });
    const report = await waitNoOrphans({ sockRoot: env.sockRoot });
    try {
      expect(report).toEqual({ processes: [], files: [] });
    } finally {
      env.cleanup();
    }
  }
}

function findSocket(dir: string): string | undefined {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (stat.isSocket()) return path;
    if (stat.isDirectory()) {
      const socket = findSocket(path);
      if (socket) return socket;
    }
  }
  return undefined;
}

const RESIZE_AVAILABLE = await resizeAvailable();
if (!RESIZE_AVAILABLE)
  console.warn(`pane resize SKIPPED — ${resizeUnavailableReason}`);

const T_TEST = 60_000;
type Json = Record<string, unknown>;
function ok(r: ToolResult): Json {
  expect(r.isError).toBe(false);
  expect(r.json).toBeDefined();
  return r.json as Json;
}

// Hooks are inside the gated suite: an unsupported magmux starts no MCP server.
describe.skipIf(!RESIZE_AVAILABLE)("pane resize through MCP (requires magmux resize verb)", () => {
  let layout: TempLayout;
  let server: McpServer | undefined;
  beforeEach(async () => {
    layout = makeTempLayout("paneresize");
    server = await McpServer.start({
      env: serverEnv(layout, { CONTRACT_FAKE_MAX_MS: "120000" }),
      cwd: layout.cwd,
    });
  });
  afterEach(async () => {
    try {
      await server?.close();
    } finally {
      const report = await paneOrphans(layout);
      layout.cleanup();
      server = undefined;
      expect(report).toEqual({ processes: [], files: [] });
    }
  });

  async function call(name: string, args: Json): Promise<Json> {
    return ok(await (server as McpServer).callTool(name, args));
  }
  async function row(id: string): Promise<Json | undefined> {
    const list = await call("list_sessions", { include_completed: true });
    return (list.sessions as Json[]).find((s) => s.session_id === id);
  }
  async function create(model = "contract-fake-model"): Promise<string> {
    const created = await call("create_session", { model });
    const id = created.session_id as string;
    await waitFor(async () => (await row(id))?.state === "AWAITING_INPUT", {
      what: "promptless session ready", timeoutMs: 20_000, intervalMs: 100,
    });
    return id;
  }
  async function capture(id: string): Promise<CaptureResult> {
    return await call("capture_session", { session_id: id }) as unknown as CaptureResult;
  }
  async function resize(id: string, cols: number, rows: number): Promise<ResizeResult> {
    return await call("resize_session", { session_id: id, cols, rows }) as unknown as ResizeResult;
  }
  async function redrawn(id: string, cols: number, rows: number): Promise<CaptureResult> {
    return await waitFor(async () => {
      const c = await capture(id);
      return c.cols === cols && c.rows === rows && c.lines.some((l) => new RegExp(`─{${cols - 1},}`).test(l))
        ? c : undefined;
    }, { what: "fake child SIGWINCH redraw", timeoutMs: 10_000, intervalMs: 100 });
  }

  test("resize reports coherent capture geometry, seq and a full-width box rule", async () => {
    const id = await create();
    const before = await capture(id);
    const r = await resize(id, 100, 40);
    expect(r).toMatchObject({ session_id: id, cols: 100, rows: 40, changed: true });
    expect(typeof r.seq).toBe("number");
    expect(r.seq).toBeGreaterThan(before.seq);
    const c = await capture(id);
    expect(c.cols).toBe(100);
    expect(c.rows).toBe(40);
    expect(c.seq).toBeGreaterThanOrEqual(r.seq);
    expect((await redrawn(id, 100, 40)).lines.some((l) => /─{99,}/.test(l))).toBe(true);
  }, T_TEST);

  test("same size leaves the idle capture seq unchanged", async () => {
    const id = await create();
    await resize(id, 100, 40);
    await redrawn(id, 100, 40);
    const stable = await waitFor(async () => {
      const a = await capture(id);
      await Bun.sleep(400);
      const b = await capture(id);
      return a.seq === b.seq ? b : undefined;
    }, { what: "stable resized screen", timeoutMs: 10_000, intervalMs: 100 });
    const r = await resize(id, 100, 40);
    expect(r).toMatchObject({ cols: 100, rows: 40, changed: false, seq: stable.seq });
    expect(await call("capture_session", { session_id: id, since_seq: stable.seq }))
      .toEqual({ unchanged: true, seq: stable.seq, final: false });
  }, T_TEST);

  test("small dimensions clamp to 80 columns and 24 rows", async () => {
    const id = await create();
    expect(await resize(id, 5, 5)).toMatchObject({ cols: 80, rows: 24, changed: true });
    await redrawn(id, 80, 24);
  }, T_TEST);

  test("a running slow turn survives resize and completes with its answer", async () => {
    const id = await create("fake-tool_slow");
    const prompt = "answer after the slow tool";
    await call("send_input", { session_id: id, text: prompt });
    await waitFor(async () => {
      const s = await row(id);
      return s?.state === "RUNNING" && s.activity === "Bash";
    }, { what: "slow Bash tool running", timeoutMs: 20_000, intervalMs: 100 });
    expect(await resize(id, 100, 40)).toMatchObject({ cols: 100, rows: 40, changed: true });
    const answer = `ANSWER fake-tool_slow ${createHash("sha1").update(prompt).digest("hex").slice(0, 8)}`;
    await waitFor(async () => {
      const s = await row(id);
      const c = await capture(id);
      return s?.state === "AWAITING_INPUT" && (s.turns_completed as number) >= 1
        && c.lines.some((l) => l.includes(answer));
    }, { what: "resized turn settled with answer", timeoutMs: 25_000, intervalMs: 100 });
    await call("send_input", { session_id: id, text: "/exit" });
    await waitFor(async () => (await row(id))?.state === "COMPLETED", {
      what: "answered session COMPLETED", timeoutMs: 15_000, intervalMs: 100,
    });
  }, T_TEST);

  test("concurrent resize calls leave the last caller's dimensions", async () => {
    const id = await create();
    const calls = [resize(id, 120, 40), resize(id, 90, 30), resize(id, 140, 45)];
    const results = await Promise.all(calls);
    for (const r of results) expect(typeof r.seq).toBe("number");
    const c = await capture(id);
    expect(c).toMatchObject({ cols: 140, rows: 45 });
    await redrawn(id, 140, 45);
  }, T_TEST);

  test("team resize addresses one live slot and its capture", async () => {
    const path = join(layout.cwd, "resize-team");
    const started = await call("team", {
      mode: "run", path, models: ["contract-fake-model"], input: "stay running @@HANG@@",
    });
    const r = (await call("team", { mode: "resize", path, slot: "01", cols: 110, rows: 35 })) as unknown as TeamResizeResult;
    expect(r).toMatchObject({ run_id: started.run_id, path, slot: "01", cols: 110, rows: 35, changed: true });
    expect(typeof r.seq).toBe("number");
    const c = await call("team", { mode: "capture", path, slot: "01" });
    expect(c).toMatchObject({ cols: 110, rows: 35 });
    expect(c.seq as number).toBeGreaterThanOrEqual(r.seq);
  }, T_TEST);

  test("cancelled session resize preserves the final capture's size", async () => {
    const id = await create();
    await resize(id, 100, 40);
    await redrawn(id, 100, 40);
    await call("cancel_session", { session_id: id });
    const final = await waitFor(async () => {
      const c = await capture(id);
      return c.final ? c : undefined;
    }, { what: "cancelled final capture", timeoutMs: 15_000, intervalMs: 100 });
    expect(await resize(id, 140, 45)).toMatchObject({
      session_id: id, cols: final.cols, rows: final.rows, changed: false, seq: final.seq,
    });
    expect(await capture(id)).toEqual(final);
  }, T_TEST);
});
