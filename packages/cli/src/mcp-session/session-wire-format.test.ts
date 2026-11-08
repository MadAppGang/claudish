/** MCP capability regression tests using raw JSON-RPC over a hermetic server's stdio. */

import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { paneOrphans, serverEnv } from "../test-helpers/contract-mcp.js";
import { type TempLayout, makeTempLayout } from "../test-helpers/contract-records.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SERVER_ENTRY = join(__dirname, "../index.ts");

const layouts: TempLayout[] = [];

afterEach(async () => {
  // Every pane this file started is gone: no process, socket, record or launcher dir.
  for (const layout of layouts.splice(0)) {
    const report = await paneOrphans(layout);
    layout.cleanup();
    expect(report).toEqual({ processes: [], files: [] });
  }
});

describe("MCP capability declaration", () => {
  async function initializeCapabilities(
    toolMode: string
  ): Promise<{ experimental?: Record<string, unknown> }> {
    const layout = makeTempLayout("wirecaps");
    layouts.push(layout);
    // Drive only the initialize handshake — no session needed.
    const proc: ChildProcess = spawn(process.execPath, ["--no-env-file", SERVER_ENTRY, "--mcp"], {
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

  for (const toolMode of ["all", "low-level"]) {
    test(`initialize response has no experimental capability for ${toolMode}`, async () => {
      const caps = await initializeCapabilities(toolMode);
      expect(caps).toHaveProperty("tools");
      expect(caps).not.toHaveProperty("experimental");
    }, 15_000);
  }
});
