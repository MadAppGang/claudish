/**
 * MCP team shape-contract end-to-end test.
 *
 * `require_pattern` and `min_output_bytes` were added to the MCP `team` tool.
 * Every layer below the MCP boundary has unit coverage, but the path from the
 * JSON-RPC `require_pattern` argument through the handler's
 * `runOpts.requirePattern` and into `runModels` otherwise has typecheck coverage
 * only. A typo in the snake_case key compiles and silently enforces nothing —
 * precisely the quiet failure this feature exists to remove. This test closes
 * that gap by driving a real `claudish --mcp` server over real stdio JSON-RPC.
 *
 * Every slot is an interactive pane (the fake interactive child, via CLAUDISH_BIN, in
 * a real headless magmux). The answer `require_pattern` is matched against is the
 * turn's assistant text read from the transcript. A model that answers without the
 * shape is EMPTY `shape_mismatch`; the same model with no pattern is COMPLETED; a
 * pattern contained in the answer passes.
 */

import { describe, expect, it } from "bun:test";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAGMUX,
  NO_MAGMUX_MESSAGE,
  makePaneTestEnv,
  waitNoOrphans,
} from "./pane/test-helpers/hermetic-env.js";

if (!MAGMUX) console.warn(NO_MAGMUX_MESSAGE);

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SRC_DIR, "../../..");
const SERVER_ENTRY = join(SRC_DIR, "index.ts");
const REQUEST_TIMEOUT_MS = 30_000;

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingRequest {
  resolve: (response: JsonRpcResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ListedTool {
  name?: unknown;
  inputSchema?: { properties?: Record<string, unknown> };
}

interface ToolCallResult {
  content?: Array<{ type?: unknown; text?: unknown }>;
  isError?: unknown;
}

interface TeamStartPayload {
  started?: unknown;
  team_session_id?: unknown;
  session_path?: unknown;
  slots?: Record<string, unknown>;
}

interface TeamStatusPayload {
  models?: Record<
    string,
    {
      state?: unknown;
      error?: { reason?: unknown };
    }
  >;
}

const delay = (ms: number) => new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms));

function isRunning(process: ChildProcessWithoutNullStreams): boolean {
  return process.exitCode === null && process.signalCode === null;
}

async function terminateServer(
  server: ChildProcessWithoutNullStreams,
  closed: Promise<void>
): Promise<void> {
  server.stdin.end();
  if (isRunning(server)) server.kill("SIGTERM");
  await Promise.race([closed, delay(2_000)]);

  if (isRunning(server)) {
    server.kill("SIGKILL");
    await Promise.race([closed, delay(2_000)]);
  }
}

function extractToolText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const content = (result as ToolCallResult).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && block.type === "text" && typeof block.text === "string" ? block.text : ""
    )
    .filter(Boolean)
    .join("\n");
}

function parseToolJson<T>(result: ToolCallResult, context: string): T {
  const text = extractToolText(result);
  if (!text) throw new Error(`${context} returned no text content`);
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`${context} returned invalid JSON: ${text}`, { cause: error });
  }
}

describe.skipIf(!MAGMUX)("MCP team shape contract", () => {
  it(
    "exposes and enforces require_pattern without misclassifying the healthy child",
    async () => {
      const tempRoot = mkdtempSync(join(REPO_ROOT, ".tmp-mcp-shape-"));
      const paneEnv = makePaneTestEnv();
      const requiredShapeSession = join(tempRoot, "required-shape");
      const controlSession = join(tempRoot, "control");
      const containedSession = join(tempRoot, "contained");
      const configPath = join(tempRoot, "config.json");
      let server: ChildProcessWithoutNullStreams | undefined;
      let serverClosed: Promise<void> | undefined;

      try {
        for (const dir of [requiredShapeSession, controlSession, containedSession]) {
          mkdirSync(dir);
          // Two lines: delivered as a task file, so the answer starts after the Read.
          writeFileSync(join(dir, "input.md"), "Review the implementation.\n");
        }
        writeFileSync(configPath, "{}\n");

        server = spawn(process.execPath, ["run", SERVER_ENTRY, "--mcp"], {
          cwd: REPO_ROOT,
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            // Hermetic: HOME, CLAUDE_CONFIG_DIR, the pane root and CLAUDISH_BIN (the fake)
            // come from makePaneTestEnv; nothing is inherited from this shell.
            ...paneEnv.env,
            CLAUDISH_CONFIG: configPath,
            CLAUDISH_DISABLE_OP: "1",
            CLAUDISH_MCP_TOOLS: "all",
            // A team run writes its record under the sessions directory; keep
            // it inside this test's temp root, never the real ~/.claudish.
            CLAUDISH_SESSIONS_DIR: join(tempRoot, "sessions"),
          },
        });

        const rpcServer = server;
        const pending = new Map<number, PendingRequest>();
        let nextId = 1;
        let stdoutPending = "";
        let stderr = "";
        const nonJsonStdout: string[] = [];

        const diagnostics = () => {
          const details = [
            stderr.trim() ? `stderr:\n${stderr.trim().slice(-4_000)}` : "",
            nonJsonStdout.length > 0
              ? `non-JSON stdout:\n${nonJsonStdout.slice(-10).join("\n")}`
              : "",
          ].filter(Boolean);
          return details.length > 0 ? `\n${details.join("\n")}` : "";
        };

        const rejectPending = (message: string) => {
          for (const request of pending.values()) {
            clearTimeout(request.timer);
            request.reject(new Error(`${message}${diagnostics()}`));
          }
          pending.clear();
        };

        rpcServer.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf-8");
        });

        const handleStdoutLine = (line: string) => {
          if (!line.trim()) return;
          let response: JsonRpcResponse;
          try {
            response = JSON.parse(line) as JsonRpcResponse;
          } catch {
            nonJsonStdout.push(line);
            return;
          }

          if (typeof response.id !== "number") return;
          const request = pending.get(response.id);
          if (!request) return;
          clearTimeout(request.timer);
          pending.delete(response.id);
          request.resolve(response);
        };

        rpcServer.stdout.on("data", (chunk: Buffer) => {
          stdoutPending += chunk.toString("utf-8");
          const lines = stdoutPending.split("\n");
          stdoutPending = lines.pop() ?? "";
          for (const line of lines) handleStdoutLine(line);
        });

        serverClosed = new Promise<void>((resolveClosed) => {
          rpcServer.once("close", (code, signal) => {
            rejectPending(`MCP server closed (code=${String(code)}, signal=${String(signal)})`);
            resolveClosed();
          });
        });
        rpcServer.once("error", (error) => {
          rejectPending(`MCP server process error: ${error.message}`);
        });
        rpcServer.stdin.on("error", (error) => {
          rejectPending(`MCP server stdin error: ${error.message}`);
        });

        const writeFrame = (frame: object) => {
          rpcServer.stdin.write(`${JSON.stringify(frame)}\n`);
        };

        const request = async (
          method: string,
          params: Record<string, unknown>,
          timeoutMs = REQUEST_TIMEOUT_MS
        ): Promise<unknown> => {
          const id = nextId++;
          const response = await new Promise<JsonRpcResponse>((resolveResponse, rejectResponse) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              rejectResponse(
                new Error(`Timed out after ${timeoutMs}ms waiting for ${method}${diagnostics()}`)
              );
            }, timeoutMs);
            pending.set(id, {
              resolve: resolveResponse,
              reject: rejectResponse,
              timer,
            });
            writeFrame({ jsonrpc: "2.0", id, method, params });
          });

          if (response.error) {
            throw new Error(
              `JSON-RPC ${method} failed (${response.error.code}): ${response.error.message}`
            );
          }
          return response.result;
        };

        await request("initialize", {
          protocolVersion: "2024-11-05",
          clientInfo: { name: "team-shape-contract-test", version: "1.0.0" },
          capabilities: {},
        });
        writeFrame({ jsonrpc: "2.0", method: "notifications/initialized" });

        // The schema assertion catches the same quiet breakage before execution:
        // either argument disappearing or being renamed means clients cannot send it.
        const listResult = await request("tools/list", {});
        if (!listResult || typeof listResult !== "object") {
          throw new Error("tools/list returned no result");
        }
        const tools = (listResult as { tools?: ListedTool[] }).tools;
        if (!Array.isArray(tools)) throw new Error("tools/list result has no tools array");
        const teamTool = tools.find((tool) => tool.name === "team");
        expect(teamTool).toBeDefined();
        expect(teamTool?.inputSchema?.properties).toHaveProperty("require_pattern");
        expect(teamTool?.inputSchema?.properties).toHaveProperty("min_output_bytes");
        expect(teamTool?.inputSchema?.properties).not.toHaveProperty("timeout");

        const pollSettledStatus = async (
          sessionPath: string,
          label: string
        ): Promise<TeamStatusPayload> => {
          const settleLimitMs = 15_000;
          const deadline = Date.now() + settleLimitMs;
          let lastStatus: TeamStatusPayload | undefined;

          while (Date.now() < deadline) {
            const statusResult = (await request("tools/call", {
              name: "team",
              arguments: { mode: "status", path: sessionPath },
            })) as ToolCallResult;
            if (statusResult.isError === true) {
              throw new Error(`${label} status call returned isError=true`);
            }

            lastStatus = parseToolJson<TeamStatusPayload>(statusResult, `${label} status`);
            const models = lastStatus.models;
            if (!models || typeof models !== "object") {
              throw new Error(`${label} status has no models object`);
            }
            if ((lastStatus as { run?: { state?: string } }).run?.state === "SETTLED") {
              return lastStatus;
            }

            await delay(25);
          }

          throw new Error(
            `${label} did not settle within ${settleLimitMs}ms; last status: ${JSON.stringify(
              lastStatus
            )}`
          );
        };

        const runAndSettle = async (
          sessionPath: string,
          model: string,
          label: string,
          requirePattern?: string
        ) => {
          const result = (await request("tools/call", {
            name: "team",
            arguments: {
              mode: "run",
              path: sessionPath,
              models: [model],
              ...(requirePattern === undefined ? {} : { require_pattern: requirePattern }),
            },
          })) as ToolCallResult;
          expect(result.isError).not.toBe(true);
          const start = parseToolJson<TeamStartPayload>(result, label);
          expect(start.started).toBe(true);
          expect(start.session_path).toBe(sessionPath);
          expect(start.slots).toHaveProperty(model);
          const slot = start.slots?.[model];
          expect(typeof slot).toBe("string");
          const status = await pollSettledStatus(sessionPath, label);
          return status.models?.[String(slot)];
        };

        // Negative control on the transcript answer: the fake answers prose with no vote.
        const mismatched = await runAndSettle(
          requiredShapeSession,
          "fake-no_shape",
          "shape-required run",
          "```vote"
        );
        expect(mismatched).toBeDefined();
        expect(mismatched?.state).toBe("EMPTY");
        expect(mismatched?.error?.reason).toBe("shape_mismatch");

        // This control is load-bearing: the same child must succeed when no shape is
        // required, proving the first failure was not a broken fake.
        const control = await runAndSettle(controlSession, "fake-no_shape", "control run");
        expect(control?.state).toBe("COMPLETED");
        expect(control?.error).toBeUndefined();

        // A pattern contained in the answer passes.
        const contained = await runAndSettle(
          containedSession,
          "fake-answer",
          "contained-pattern run",
          "ANSWER fake-answer [0-9a-f]{8}"
        );
        expect(contained?.state).toBe("COMPLETED");
      } finally {
        if (server && serverClosed) await terminateServer(server, serverClosed);
        rmSync(tempRoot, { recursive: true, force: true });
        const report = await waitNoOrphans({ sockRoot: paneEnv.sockRoot });
        paneEnv.cleanup();
        expect(report).toEqual({ processes: [], files: [] });
      }
    },
    { timeout: 120_000 }
  );
});
