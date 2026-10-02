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
 * The measured failure is subtle: `claude -p` prints only the final assistant
 * message. If a child answers and then takes one more turn when a background
 * task completes, its real answer is replaced by a short epilogue. The process
 * still exits 0 with plausible prose and no API error, so only the caller's
 * required output shape distinguishes that dropout from success.
 */

import { describe, expect, it } from "bun:test";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SRC_DIR, "../../..");
const SERVER_ENTRY = join(SRC_DIR, "index.ts");
const FAKE_CHILD = join(SRC_DIR, "channel", "test-helpers", "fake-dropout-child.ts");
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

describe("MCP team shape contract", () => {
  it(
    "exposes and enforces require_pattern without misclassifying the healthy child",
    async () => {
      const tempRoot = mkdtempSync(join(REPO_ROOT, ".tmp-mcp-shape-"));
      const requiredShapeSession = join(tempRoot, "required-shape");
      const controlSession = join(tempRoot, "control");
      const configPath = join(tempRoot, "config.json");
      let server: ChildProcessWithoutNullStreams | undefined;
      let serverClosed: Promise<void> | undefined;

      try {
        mkdirSync(requiredShapeSession);
        mkdirSync(controlSession);
        writeFileSync(join(requiredShapeSession, "input.md"), "Review the implementation.\n");
        writeFileSync(join(controlSession, "input.md"), "Review the implementation.\n");
        writeFileSync(configPath, "{}\n");

        server = spawn(process.execPath, ["run", SERVER_ENTRY, "--mcp"], {
          cwd: REPO_ROOT,
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            CLAUDISH_BIN: FAKE_CHILD,
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
            if (Object.values(models).every((model) => model.state !== "RUNNING")) {
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

        const mismatchResult = (await request("tools/call", {
          name: "team",
          arguments: {
            mode: "run",
            path: requiredShapeSession,
            models: ["fake-dropout"],
            require_pattern: "```vote",
          },
        })) as ToolCallResult;
        expect(mismatchResult.isError).not.toBe(true);
        const mismatchStart = parseToolJson<TeamStartPayload>(mismatchResult, "shape-required run");
        expect(mismatchStart.started).toBe(true);
        expect(mismatchStart.team_session_id).toBe("required-shape");
        expect(mismatchStart.session_path).toBe(requiredShapeSession);
        expect(mismatchStart.slots).toHaveProperty("fake-dropout");
        const mismatchSlot = mismatchStart.slots?.["fake-dropout"];
        expect(typeof mismatchSlot).toBe("string");

        const mismatchStatus = await pollSettledStatus(requiredShapeSession, "shape-required run");
        const mismatchedModel = mismatchStatus.models?.[String(mismatchSlot)];
        expect(mismatchedModel).toBeDefined();
        expect(mismatchedModel?.state).toBe("EMPTY");
        expect(mismatchedModel?.error?.reason).toBe("shape_mismatch");

        // This control is load-bearing: the same exit-0 child must succeed when
        // no shape is required, proving the first failure was not a broken fake.
        const controlResult = (await request("tools/call", {
          name: "team",
          arguments: {
            mode: "run",
            path: controlSession,
            models: ["fake-dropout"],
          },
        })) as ToolCallResult;
        expect(controlResult.isError).not.toBe(true);
        const controlStart = parseToolJson<TeamStartPayload>(controlResult, "control run");
        expect(controlStart.started).toBe(true);
        expect(controlStart.slots).toHaveProperty("fake-dropout");
        const controlSlot = controlStart.slots?.["fake-dropout"];
        expect(typeof controlSlot).toBe("string");

        const controlStatus = await pollSettledStatus(controlSession, "control run");
        const controlModel = controlStatus.models?.[String(controlSlot)];
        expect(controlModel).toBeDefined();
        expect(controlModel?.state).toBe("COMPLETED");
        expect(controlModel?.error).toBeUndefined();
      } finally {
        if (server && serverClosed) await terminateServer(server, serverClosed);
        rmSync(tempRoot, { recursive: true, force: true });
      }
    },
    { timeout: 120_000 }
  );
});
