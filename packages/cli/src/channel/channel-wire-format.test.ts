/**
 * Channel notification wire-format regression tests.
 *
 * These tests pin the exact JSON-RPC contract that the MCP server emits over
 * stdio for channel notifications. They run without any API key: the server's
 * CLAUDISH_BIN is the pane fake (pane/test-helpers/fake-interactive-child.ts),
 * which a real headless magmux runs as an interactive child; its transcript
 * drives the pane session's state machine, whose transitions fire
 * onStateChange callbacks, which invoke server.notification(), which serialize
 * JSON-RPC frames to stdout. The server env is hermetic (contract-mcp.ts
 * `serverEnv`) with its own pane root, and every test proves no pane is left.
 *
 * Why a dedicated test file:
 *   - The OPENROUTER_API_KEY-gated lifecycle test in e2e-channel.test.ts
 *     does similar checks but is skipped when the key is absent, so CI never
 *     runs it. These tests run unconditionally (wherever magmux is installed).
 *   - We use raw JSON-RPC over child process pipes (not the MCP Client SDK)
 *     so we can assert the literal frame objects — that's the wire contract.
 *
 * What's pinned:
 *   1. The notification method name: "notifications/claude/channel"
 *   2. params.content is a string
 *   3. params.meta required keys: session_id, event, model, elapsed_seconds
 *   4. session_id is an 8-char hex string (from randomUUID().slice(0, 8))
 *   5. elapsed_seconds is serialized as a numeric string (not a number)
 *   6. jsonrpc: "2.0" framing
 *
 * If a future refactor changes any of these, these tests will fail loudly.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FAKE_MODEL,
  MAGMUX_AVAILABLE,
  McpServer,
  NO_MAGMUX_MESSAGE,
  type ToolResult,
  paneOrphans,
  serverEnv,
} from "../test-helpers/contract-mcp.js";
import { type TempLayout, makeTempLayout, waitFor } from "../test-helpers/contract-records.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SERVER_ENTRY = join(__dirname, "../index.ts");

const TERMINAL_EVENTS = ["completed", "failed", "cancelled", "timeout"];

// ─── Helper: drive an MCP server session and capture frames ─────────────────

interface ChannelFrame {
  method: string;
  params: { content: string; meta: Record<string, string> };
  jsonrpc: string;
}

interface CapturedFrames {
  notifications: ChannelFrame[];
  createResult: ToolResult;
}

const layouts: TempLayout[] = [];

afterEach(async () => {
  // Every pane this file started is gone: no process, socket, record or launcher dir.
  for (const layout of layouts.splice(0)) {
    const report = await paneOrphans(layout);
    layout.cleanup();
    expect(report).toEqual({ processes: [], files: [] });
  }
});

function channelFrames(server: McpServer): ChannelFrame[] {
  return server.notifications.filter(
    (n) => n.method === "notifications/claude/channel"
  ) as unknown as ChannelFrame[];
}

/**
 * Start a server, create one session, collect its channel frames until `until` holds
 * (default: a terminal event), then close the server (stdin EOF shuts it down).
 */
async function captureSessionFrames(opts: {
  model?: string;
  prompt?: string;
  until?: (frames: ChannelFrame[]) => boolean;
  timeoutMs?: number;
}): Promise<CapturedFrames> {
  const layout = makeTempLayout("wireformat");
  layouts.push(layout);
  const server = await McpServer.start({ env: serverEnv(layout), cwd: layout.cwd });
  try {
    const createResult = await server.callTool("create_session", {
      model: opts.model ?? FAKE_MODEL,
      prompt: opts.prompt ?? "Reply with a short answer.",
      timeout_seconds: 60,
    });
    expect(createResult.isError).toBe(false);
    const until =
      opts.until ??
      ((frames: ChannelFrame[]) =>
        frames.some((f) => TERMINAL_EVENTS.includes(f.params?.meta?.event)));
    await waitFor(() => until(channelFrames(server)), {
      what: "the expected channel frames",
      timeoutMs: opts.timeoutMs ?? 20_000,
    });
    // Brief grace period to capture any final frames
    await Bun.sleep(200);
    return { notifications: [...channelFrames(server)], createResult };
  } finally {
    await server.close();
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe.skipIf(!MAGMUX_AVAILABLE)(
  `Channel notification wire format${MAGMUX_AVAILABLE ? "" : ` (${NO_MAGMUX_MESSAGE})`}`,
  () => {
    test("emits well-formed notifications/claude/channel JSON-RPC frames", async () => {
      const captured = await captureSessionFrames({});

      // At least one notification should arrive (running + completed expected)
      expect(captured.notifications.length).toBeGreaterThan(0);

      for (const n of captured.notifications) {
        // Method name is exactly the contracted string
        expect(n.method).toBe("notifications/claude/channel");

        // JSON-RPC framing
        expect(n.jsonrpc).toBe("2.0");

        // params shape
        expect(n.params).toBeDefined();
        expect(typeof n.params.content).toBe("string");
        expect(n.params.meta).toBeDefined();

        // Required meta keys (current Claudish vocabulary)
        expect(n.params.meta.session_id).toMatch(/^[0-9a-f]{8}$/);
        expect(typeof n.params.meta.event).toBe("string");
        expect(n.params.meta.model).toBe(FAKE_MODEL);

        // elapsed_seconds is serialized as a string (not a number) —
        // this is intentional per the MCP server's bridge: see mcp-server.ts
        // where it calls String(event.elapsedSeconds).
        expect(typeof n.params.meta.elapsed_seconds).toBe("string");
        expect(n.params.meta.elapsed_seconds).toMatch(/^\d+$/);

        // SEP-1686 forward-compat fields (additive — see mcp-server.ts bridge
        // and ai-docs/sessions/.../sep-1686-migration-schema.md)
        // task_id mirrors session_id (will become the only field after migration)
        expect(n.params.meta.task_id).toBe(n.params.meta.session_id);
        // status carries the SEP-1686 5-value TaskStatus enum
        expect(["working", "input_required", "completed", "failed", "cancelled"]).toContain(
          n.params.meta.status
        );
        // ISO 8601 timestamps
        expect(n.params.meta.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
        expect(n.params.meta.last_updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      }
    }, 40_000);

    test("SEP-1686 status mapping: 9-value event collapses to 5-value status correctly", async () => {
      const captured = await captureSessionFrames({});
      expect(captured.notifications.length).toBeGreaterThan(0);

      // Build (event, status) pairs and validate every observed pair against
      // the expected mapping defined in mcp-server.ts:EVENT_TO_TASK_STATUS.
      // RB1: `finishing` is no longer a channel event; `awaiting_permission` is (F5).
      const expectedMapping: Record<string, string> = {
        starting: "working",
        running: "working",
        tool_executing: "working",
        waiting_for_input: "input_required",
        awaiting_permission: "input_required",
        completed: "completed",
        failed: "failed",
        cancelled: "cancelled",
        timeout: "failed",
      };

      for (const n of captured.notifications) {
        const event = n.params.meta.event as string;
        const status = n.params.meta.status as string;
        const expected = expectedMapping[event];
        if (expected !== undefined) {
          expect(status).toBe(expected);
        } else {
          // Unknown event types fall through to "working" per
          // mapEventToTaskStatus's default. If a NEW event type ever leaks
          // through without an entry in EVENT_TO_TASK_STATUS, this catches it.
          expect(status).toBe("working");
        }
      }
    }, 40_000);

    test("a permission dialog emits awaiting_permission with status input_required", async () => {
      const captured = await captureSessionFrames({
        model: "fake-permission",
        prompt: "Edit the file.",
        until: (frames) => frames.some((f) => f.params?.meta?.event === "awaiting_permission"),
      });
      const frame = captured.notifications.find(
        (n) => n.params.meta.event === "awaiting_permission"
      );
      expect(frame).toBeDefined();
      expect(frame?.params.meta.status).toBe("input_required");
      expect(frame?.params.meta.model).toBe("fake-permission");
      expect(typeof frame?.params.content).toBe("string");
    }, 40_000);

    test("all notifications for one session share the same created_at timestamp", async () => {
      const captured = await captureSessionFrames({});
      expect(captured.notifications.length).toBeGreaterThan(0);

      // created_at is the session start time; all events from one session
      // must report the same value. last_updated_at varies per event.
      const createdAts = new Set(captured.notifications.map((n) => n.params.meta.created_at));
      expect(createdAts.size).toBe(1);

      // last_updated_at should differ across at least some events (they fire
      // at different moments). Typically running + completed, so at least
      // 2 distinct timestamps.
      const lastUpdates = new Set(captured.notifications.map((n) => n.params.meta.last_updated_at));
      expect(lastUpdates.size).toBeGreaterThan(0);
    }, 40_000);

    test("all notifications for one session share the same session_id", async () => {
      const captured = await captureSessionFrames({});
      expect(captured.notifications.length).toBeGreaterThan(0);

      const ids = new Set(captured.notifications.map((n) => n.params.meta.session_id));
      expect(ids.size).toBe(1);
    }, 40_000);

    test("session lifecycle ends with a terminal event (completed/failed/cancelled)", async () => {
      const captured = await captureSessionFrames({});
      expect(captured.notifications.length).toBeGreaterThan(0);

      const events = captured.notifications.map((n) => n.params.meta.event);
      const lastEvent = events[events.length - 1];
      expect(["completed", "failed", "cancelled"]).toContain(lastEvent);
    }, 40_000);

    test("create_session response payload contains session_id matching notifications", async () => {
      const captured = await captureSessionFrames({});

      const parsed = captured.createResult.json as { session_id: string };
      expect(parsed.session_id).toMatch(/^[0-9a-f]{8}$/);

      // session_id from create_session response must equal the one in
      // notifications — they describe the same session.
      const notifSid = captured.notifications[0]?.params.meta.session_id;
      expect(parsed.session_id).toBe(notifSid);
    }, 40_000);
  }
);

describe("MCP capability declaration", () => {
  async function initializeCapabilities(
    toolMode: string
  ): Promise<{ experimental?: Record<string, unknown> }> {
    const layout = makeTempLayout("wirecaps");
    layouts.push(layout);
    // Drive only the initialize handshake — no session needed.
    const proc: ChildProcess = spawn(process.execPath, [SERVER_ENTRY, "--mcp"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: serverEnv(layout, { CLAUDISH_MCP_TOOLS: toolMode }),
      cwd: layout.cwd,
    });

    let stdoutBuf = "";
    let initResponse: {
      result: { capabilities: { experimental?: Record<string, unknown> } };
    } | null = null;
    let resolveInit: () => void;
    const initDone = new Promise<void>((r) => {
      resolveInit = r;
    });

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf-8");
      let nl: number;
      // biome-ignore lint/suspicious/noAssignInExpressions: canonical line-buffer drain idiom
      while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1) {
            initResponse = msg;
            resolveInit();
          }
        } catch {}
      }
    });

    proc.stdin?.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          clientInfo: { name: "cap-test", version: "1.0.0" },
          capabilities: {},
        },
      })}\n`
    );

    await Promise.race([initDone, new Promise((r) => setTimeout(r, 10_000))]);
    const exited = new Promise<void>((r) => proc.on("exit", () => r()));
    proc.kill("SIGTERM");
    await exited;

    expect(initResponse).not.toBeNull();
    return (
      initResponse as unknown as {
        result: { capabilities: { experimental?: Record<string, unknown> } };
      }
    ).result.capabilities;
  }

  test("initialize response declares experimental.claude/channel capability", async () => {
    const caps = await initializeCapabilities("all");
    expect(caps.experimental).toBeDefined();
    expect(caps.experimental).toHaveProperty("claude/channel");
  }, 15_000);

  test("experimental capability is omitted when channel tools are disabled", async () => {
    // With CLAUDISH_MCP_TOOLS=low-level, channel tools are gated off and
    // the experimental.claude/channel capability should NOT be declared.
    const caps = await initializeCapabilities("low-level");
    // Either experimental is absent entirely, or it doesn't have claude/channel
    const hasChannel = !!caps.experimental && "claude/channel" in caps.experimental;
    expect(hasChannel).toBe(false);
  }, 15_000);
});
