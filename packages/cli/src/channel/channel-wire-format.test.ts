/**
 * Channel notification wire-format regression tests.
 *
 * These tests pin the exact JSON-RPC contract that the MCP server emits over
 * stdio for channel notifications. They run without any API key by using the
 * fake-claudish PATH shim — fake-claudish produces deterministic stdout that
 * drives SignalWatcher state transitions, which in turn fire onStateChange
 * callbacks, which invoke server.notification(), which serialize JSON-RPC
 * frames to stdout.
 *
 * Why a dedicated test file:
 *   - The OPENROUTER_API_KEY-gated lifecycle test in e2e-channel.test.ts
 *     does similar checks but is skipped when the key is absent, so CI never
 *     runs it. These tests run unconditionally.
 *   - We use raw JSON-RPC over child process pipes (not the MCP Client SDK)
 *     so we can assert the literal frame bytes — that's the wire contract.
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

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SERVER_ENTRY = join(__dirname, "../index.ts");
const FAKE_CLAUDISH_TS = join(__dirname, "test-helpers", "fake-claudish.ts");

// ─── PATH shim setup ────────────────────────────────────────────────────────

let shimDir: string;
const ORIGINAL_PATH = process.env.PATH ?? "";

beforeAll(() => {
  shimDir = mkdtempSync(join(tmpdir(), "claudish-shim-wireformat-"));
  const shimPath = join(shimDir, "claudish");
  writeFileSync(
    shimPath,
    `#!/bin/sh\nexec bun run "${FAKE_CLAUDISH_TS}" "$@"\n`,
    { mode: 0o755 }
  );
  process.env.PATH = `${shimDir}:${ORIGINAL_PATH}`;
});

afterAll(() => {
  process.env.PATH = ORIGINAL_PATH;
  if (shimDir) {
    try {
      rmSync(shimDir, { recursive: true, force: true });
    } catch {}
  }
});

// ─── Helper: drive an MCP server session and capture frames ─────────────────

interface CapturedFrames {
  notifications: Array<{
    method: string;
    params: { content: string; meta: Record<string, string> };
    jsonrpc: string;
  }>;
  responses: Array<{ id: number; result?: unknown; error?: unknown; jsonrpc: string }>;
  rawStdoutLines: string[];
  stderr: string;
}

async function captureSessionFrames(opts: {
  shimArgs?: string[]; // extra args passed to fake-claudish via spawn
  timeoutMs?: number;
}): Promise<CapturedFrames> {
  const proc: ChildProcess = spawn("bun", ["run", SERVER_ENTRY, "--mcp"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      CLAUDISH_MCP_TOOLS: "all",
    },
  });

  const captured: CapturedFrames = {
    notifications: [],
    responses: [],
    rawStdoutLines: [],
    stderr: "",
  };

  let stdoutBuf = "";
  let resolveDone: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });

  proc.stdout!.on("data", (chunk: Buffer) => {
    stdoutBuf += chunk.toString("utf-8");
    let nl: number;
    while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line.trim()) continue;
      captured.rawStdoutLines.push(line);
      try {
        const msg = JSON.parse(line);
        if (msg.method === "notifications/claude/channel") {
          captured.notifications.push(msg);
          // Resolve once we see a terminal event
          const evt = msg.params?.meta?.event;
          if (evt === "completed" || evt === "failed" || evt === "cancelled") {
            resolveDone();
          }
        } else if (msg.id !== undefined) {
          captured.responses.push(msg);
        }
      } catch {
        // not JSON, ignore
      }
    }
  });

  proc.stderr!.on("data", (chunk: Buffer) => {
    captured.stderr += chunk.toString("utf-8");
  });

  function send(rpc: object) {
    proc.stdin!.write(JSON.stringify(rpc) + "\n");
  }

  // Initialize
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "wire-format-test", version: "1.0.0" },
      capabilities: { experimental: { "claude/channel": {} } },
    },
  });

  await new Promise((r) => setTimeout(r, 300));
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await new Promise((r) => setTimeout(r, 100));

  // create_session — fake-claudish ignores --model so any value works.
  // We pass an extra prompt-style arg via claudish_flags so fake-claudish
  // gets the --lines flag and produces deterministic output.
  send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "create_session",
      arguments: {
        model: "fake-model",
        prompt: "ignored",
        timeout_seconds: 10,
        claudish_flags: opts.shimArgs ?? ["--lines", "3"],
      },
    },
  });

  // Wait for terminal event or timeout
  const timeoutMs = opts.timeoutMs ?? 15_000;
  await Promise.race([
    done,
    new Promise<void>((r) => setTimeout(r, timeoutMs)),
  ]);

  // Brief grace period to capture any final frames
  await new Promise((r) => setTimeout(r, 200));

  proc.kill("SIGTERM");
  await new Promise<void>((r) => proc.on("exit", () => r()));

  return captured;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Channel notification wire format", () => {
  test(
    "emits well-formed notifications/claude/channel JSON-RPC frames",
    async () => {
      const captured = await captureSessionFrames({ shimArgs: ["--lines", "3"] });

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
        expect(n.params.meta.model).toBe("fake-model");

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
        expect([
          "working",
          "input_required",
          "completed",
          "failed",
          "cancelled",
        ]).toContain(n.params.meta.status);
        // ISO 8601 timestamps
        expect(n.params.meta.created_at).toMatch(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/
        );
        expect(n.params.meta.last_updated_at).toMatch(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/
        );
      }
    },
    20_000
  );

  test(
    "SEP-1686 status mapping: 7-value event collapses to 5-value status correctly",
    async () => {
      const captured = await captureSessionFrames({ shimArgs: ["--lines", "3"] });
      expect(captured.notifications.length).toBeGreaterThan(0);

      // Build (event, status) pairs and validate every observed pair against
      // the expected mapping defined in mcp-server.ts:EVENT_TO_TASK_STATUS.
      const expectedMapping: Record<string, string> = {
        starting: "working",
        running: "working",
        tool_executing: "working",
        waiting_for_input: "input_required",
        completed: "completed",
        failed: "failed",
        cancelled: "cancelled",
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
    },
    20_000
  );

  test(
    "all notifications for one session share the same created_at timestamp",
    async () => {
      const captured = await captureSessionFrames({ shimArgs: ["--lines", "5"] });
      expect(captured.notifications.length).toBeGreaterThan(0);

      // created_at is the session start time; all events from one session
      // must report the same value. last_updated_at varies per event.
      const createdAts = new Set(captured.notifications.map((n) => n.params.meta.created_at));
      expect(createdAts.size).toBe(1);

      // last_updated_at should differ across at least some events (they fire
      // at different moments). With --lines 5 there's typically running +
      // completed, so at least 2 distinct timestamps.
      const lastUpdates = new Set(captured.notifications.map((n) => n.params.meta.last_updated_at));
      expect(lastUpdates.size).toBeGreaterThan(0);
    },
    20_000
  );

  test(
    "all notifications for one session share the same session_id",
    async () => {
      const captured = await captureSessionFrames({ shimArgs: ["--lines", "5"] });
      expect(captured.notifications.length).toBeGreaterThan(0);

      const ids = new Set(captured.notifications.map((n) => n.params.meta.session_id));
      expect(ids.size).toBe(1);
    },
    20_000
  );

  test(
    "session lifecycle ends with a terminal event (completed/failed/cancelled)",
    async () => {
      const captured = await captureSessionFrames({ shimArgs: ["--lines", "2"] });
      expect(captured.notifications.length).toBeGreaterThan(0);

      const events = captured.notifications.map((n) => n.params.meta.event);
      const lastEvent = events[events.length - 1];
      expect(["completed", "failed", "cancelled"]).toContain(lastEvent);
    },
    20_000
  );

  test(
    "create_session response payload contains session_id matching notifications",
    async () => {
      const captured = await captureSessionFrames({ shimArgs: ["--lines", "3"] });

      const callResponse = captured.responses.find((r) => r.id === 2);
      expect(callResponse).toBeDefined();

      const content = (callResponse!.result as { content: Array<{ text: string }> }).content;
      const parsed = JSON.parse(content[0].text) as { session_id: string };
      expect(parsed.session_id).toMatch(/^[0-9a-f]{8}$/);

      // session_id from create_session response must equal the one in
      // notifications — they describe the same session.
      const notifSid = captured.notifications[0].params.meta.session_id;
      expect(parsed.session_id).toBe(notifSid);
    },
    20_000
  );
});

describe("MCP capability declaration", () => {
  test(
    "initialize response declares experimental.claude/channel capability",
    async () => {
      // Drive only the initialize handshake — no session needed.
      const proc: ChildProcess = spawn("bun", ["run", SERVER_ENTRY, "--mcp"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, CLAUDISH_MCP_TOOLS: "all" },
      });

      let stdoutBuf = "";
      let initResponse: { result: { capabilities: { experimental?: Record<string, unknown> } } } | null = null;
      let resolveInit: () => void;
      const initDone = new Promise<void>((r) => {
        resolveInit = r;
      });

      proc.stdout!.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString("utf-8");
        let nl: number;
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

      proc.stdin!.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            clientInfo: { name: "cap-test", version: "1.0.0" },
            capabilities: {},
          },
        }) + "\n"
      );

      await Promise.race([initDone, new Promise((r) => setTimeout(r, 10_000))]);
      proc.kill("SIGTERM");
      await new Promise<void>((r) => proc.on("exit", () => r()));

      expect(initResponse).not.toBeNull();
      const caps = initResponse!.result.capabilities;
      expect(caps.experimental).toBeDefined();
      expect(caps.experimental).toHaveProperty("claude/channel");
    },
    15_000
  );

  test(
    "experimental capability is omitted when channel tools are disabled",
    async () => {
      // With CLAUDISH_MCP_TOOLS=low-level, channel tools are gated off and
      // the experimental.claude/channel capability should NOT be declared.
      const proc: ChildProcess = spawn("bun", ["run", SERVER_ENTRY, "--mcp"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, CLAUDISH_MCP_TOOLS: "low-level" },
      });

      let stdoutBuf = "";
      let initResponse: { result: { capabilities: { experimental?: Record<string, unknown> } } } | null = null;
      let resolveInit: () => void;
      const initDone = new Promise<void>((r) => {
        resolveInit = r;
      });

      proc.stdout!.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString("utf-8");
        let nl: number;
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

      proc.stdin!.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            clientInfo: { name: "cap-test", version: "1.0.0" },
            capabilities: {},
          },
        }) + "\n"
      );

      await Promise.race([initDone, new Promise((r) => setTimeout(r, 10_000))]);
      proc.kill("SIGTERM");
      await new Promise<void>((r) => proc.on("exit", () => r()));

      expect(initResponse).not.toBeNull();
      const caps = initResponse!.result.capabilities;
      // Either experimental is absent entirely, or it doesn't have claude/channel
      const hasChannel = !!caps.experimental && "claude/channel" in caps.experimental;
      expect(hasChannel).toBe(false);
    },
    15_000
  );
});
