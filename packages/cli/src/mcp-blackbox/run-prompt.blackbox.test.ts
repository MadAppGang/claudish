/**
 * BLACK-BOX: real claudish --mcp, public stdio protocol and a test-owned executable/endpoint.
 * Spec: dev-feature-mcp-run-prompt-claude-20261016-a7c3/requirements.md and
 * qa/sandbox/contract/architecture-contracts.md, run_prompt testing-strategy table.
 * No implementation source or module mocks. The fake's frames derive from a1/a3 measurements.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useBlackboxEnv } from "../test-helpers/blackbox-env.js";
import {
  McpServer,
  type ToolResult,
  paneOrphans,
  serverEnv,
} from "../test-helpers/contract-mcp.js";
import { type TempLayout, makeTempLayout } from "../test-helpers/contract-records.js";

useBlackboxEnv();

const FAKE = join(import.meta.dir, "..", "test-helpers", "fake-print-claudish.ts");
const PROMPT = "- What is 4817 + 2906?";
const T_TEST = 35_000;
const FORBIDDEN_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDISH_PANE_CHILD",
  "CLAUDISH_PANE_ENV",
  "CLAUDISH_PANE_CWD",
];

type Json = Record<string, unknown>;
interface PrintRecord {
  pid: number;
  invocationCount: number;
  argv: string[];
  cwd: string;
  stdin: string;
  env: Record<string, boolean>;
  envValues: Record<string, string>;
  cwdEntriesAtStart: string[];
  systemPromptFileContent: string | null;
  recordedAt: number;
}
interface ProviderRequest {
  body: Json;
  childRecordPresent: boolean;
  childWasAlive: boolean;
}

let layout: TempLayout;
let server: McpServer | undefined;
let recordPath: string;
let expectedEnv: Record<string, string>;
let endpoint: { stop(closeActiveConnections?: boolean): unknown } | undefined;
let providerRequests: ProviderRequest[];

function record(): PrintRecord {
  return JSON.parse(readFileSync(recordPath, "utf8")) as PrintRecord;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function until(check: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error(`Timed out after ${timeoutMs} ms: ${what}`);
    await Bun.sleep(25);
  }
}

function argvFor(model: string, systemArgs = ["--system-prompt", ""]): string[] {
  return [
    "-p",
    "--model",
    model,
    "--output-format",
    "json",
    "--tools",
    "",
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--no-session-persistence",
    ...systemArgs,
  ];
}

async function boot(extra: Record<string, string | undefined> = {}): Promise<McpServer> {
  expectedEnv = serverEnv(layout, {
    CLAUDISH_BIN: FAKE,
    FAKE_PRINT_RECORD: recordPath,
    CLAUDISH_MCP_TOOLS: "all",
    ...extra,
  });
  server = await McpServer.start({ env: expectedEnv, cwd: layout.cwd });
  return server;
}

function expectPromptError(result: ToolResult, model: string): void {
  expect(result.isError).toBe(true);
  expect(result.text.startsWith("Error: ")).toBe(true);
  expect(result.text).toContain("report_error");
  // The hint itself must name this model, not merely the preceding error message.
  expect(result.text.slice(result.text.indexOf("report_error"))).toContain(model);
}

function addLoopbackEndpoint(): void {
  const local = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const childRecordPresent = existsSync(recordPath);
      providerRequests.push({
        body: (await request.json()) as Json,
        childRecordPresent,
        childWasAlive: childRecordPresent && alive(record().pid),
      });
      // OpenAI SSE as specified by the custom-endpoint contract: one answer chunk + DONE.
      const chunk = {
        id: "rp-mock-answer",
        object: "chat.completion.chunk",
        model: "m",
        choices: [
          { index: 0, delta: { role: "assistant", content: "7723" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 },
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  endpoint = local;
  const configDir = join(layout.home, ".claudish");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      customEndpoints: {
        "rp-mock": {
          kind: "simple",
          format: "openai",
          authScheme: "none",
          url: `http://127.0.0.1:${local.port}`,
        },
      },
    })
  );
}

function expectUnlimited(body: Json): void {
  for (const key of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
    expect(Object.hasOwn(body, key)).toBe(false);
  }
}

beforeEach(() => {
  layout = makeTempLayout("bbrunprompt");
  chmodSync(FAKE, 0o755); // CLAUDISH_BIN is executed directly, not through a shell.
  recordPath = join(layout.root, "print-record.json");
  server = undefined;
  endpoint = undefined;
  providerRequests = [];
});

afterEach(async () => {
  // Cleanup is deliberately after assertions, so it cannot make the cancel test pass.
  try {
    if (existsSync(recordPath)) {
      const { pid } = record();
      if (alive(pid)) process.kill(pid, "SIGKILL");
    }
    if (server) {
      expect(
        server.notifications.filter((n) => n.method === "notifications/claude/channel")
      ).toEqual([]);
    }
  } finally {
    try {
      await server?.close();
      endpoint?.stop(true);
      const report = await paneOrphans(layout);
      expect(report).toEqual({ processes: [], files: [] });
    } finally {
      layout.cleanup();
    }
  }
});

describe("run_prompt Claude print contract", () => {
  test(
    "REQ-1 REQ-2 REQ-3 REQ-6: sends exact argv/stdin once and returns cached usage plus subscription auth",
    async () => {
      const mcp = await boot();
      const result = await mcp.callTool("run_prompt", { model: "claude-fake-ok", prompt: PROMPT });

      expect(result.isError).toBe(false);
      expect(record().invocationCount).toBe(1);
      expect(record().argv).toEqual(argvFor("claude-fake-ok"));
      expect(record().stdin).toBe(PROMPT);
      expect(record().systemPromptFileContent).toBeNull();
      expect(result.text).toBe(
        "7723\n\n---\nTokens: 582 input, 4 output\nAuth: Claude Code login (subscription)"
      );
    },
    T_TEST
  );

  test(
    "REQ-2 REQ-3: delivers a dash-leading system prompt through an exact --system-prompt-file argument",
    async () => {
      const mcp = await boot();
      const result = await mcp.callTool("run_prompt", {
        model: "claude-fake-ok",
        prompt: PROMPT,
        system_prompt: "- one word",
      });

      expect(result.isError).toBe(false);
      const seen = record();
      const file = seen.argv.at(-1)!;
      expect(file.length).toBeGreaterThan(0);
      expect(seen.argv).toEqual(argvFor("claude-fake-ok", ["--system-prompt-file", file]));
      expect(seen.systemPromptFileContent).toBe("- one word");
      expect(seen.stdin).toBe(PROMPT);
    },
    T_TEST
  );

  test(
    "REQ-5: strips the contracted inherited auth/session/pane variables and preserves other server environment values",
    async () => {
      // Exact inherited values from the contract's environment table row. In particular,
      // do not invent a pane snapshot format to bypass the public CLI startup path.
      const mcp = await boot({
        ANTHROPIC_API_KEY: "sk-test-not-real",
        ANTHROPIC_AUTH_TOKEN: "x",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION_ID: "s",
        CLAUDISH_PANE_CHILD: "1",
        FAKE_PRINT_KEEP: "unchanged sentinel",
      });
      const result = await mcp.callTool("run_prompt", { model: "claude-fake-ok", prompt: PROMPT });

      expect(result.isError).toBe(false);
      const seen = record();
      for (const key of FORBIDDEN_ENV) {
        expect(seen.env[key]).toBe(false);
        expect(Object.hasOwn(seen.envValues, key)).toBe(false);
      }
      expect(seen.env.PATH).toBe(true);
      expect(seen.env.HOME).toBe(true);
      for (const [key, value] of Object.entries(expectedEnv)) {
        if (!FORBIDDEN_ENV.includes(key)) expect(seen.envValues[key]).toBe(value);
      }
    },
    T_TEST
  );

  test(
    "REQ-4: starts in a distinct empty cwd and removes it after the call",
    async () => {
      const mcp = await boot();
      const result = await mcp.callTool("run_prompt", { model: "claude-fake-ok", prompt: PROMPT });

      expect(result.isError).toBe(false);
      const seen = record();
      expect(seen.cwd).not.toBe(layout.cwd);
      expect(seen.cwdEntriesAtStart).toEqual([]);
      expect(existsSync(seen.cwd)).toBe(false);
    },
    T_TEST
  );

  test(
    "REQ-8: returns the measured Claude error and HTTP 404 with a model-specific report_error hint",
    async () => {
      const mcp = await boot();
      const result = await mcp.callTool("run_prompt", { model: "claude-fake-404", prompt: PROMPT });

      expectPromptError(result, "claude-fake-404");
      expect(result.text).toContain("Error: Claude Code: There's an issue with the selected model");
      expect(result.text).toContain("(HTTP 404)");
    },
    T_TEST
  );

  test(
    "REQ-9: reports exit 3 and stderr when stdout is not a parseable result",
    async () => {
      const mcp = await boot();
      const result = await mcp.callTool("run_prompt", {
        model: "claude-fake-garbage",
        prompt: PROMPT,
      });

      expectPromptError(result, "claude-fake-garbage");
      expect(result.text).toContain("claudish -p exited 3");
      expect(result.text).toContain("boom");
    },
    T_TEST
  );

  test(
    "REQ-10: rejects an empty successful result and keeps the model-specific report_error hint",
    async () => {
      const mcp = await boot();
      const result = await mcp.callTool("run_prompt", {
        model: "claude-fake-empty",
        prompt: PROMPT,
      });

      expectPromptError(result, "claude-fake-empty");
      expect(result.text).toContain("Model returned empty response");
    },
    T_TEST
  );

  test(
    "REQ-7: accepts a single result object instead of a frame array",
    async () => {
      const mcp = await boot();
      const result = await mcp.callTool("run_prompt", {
        model: "claude-fake-object",
        prompt: PROMPT,
      });

      expect(result.isError).toBe(false);
      expect(result.text.startsWith("7723")).toBe(true);
      expect(record().invocationCount).toBe(1);
    },
    T_TEST
  );

  test(
    "REQ-11: reports cannot start claudish when CLAUDISH_BIN does not exist",
    async () => {
      const mcp = await boot({ CLAUDISH_BIN: "/nonexistent/claudish" });
      const result = await mcp.callTool("run_prompt", { model: "claude-fake-ok", prompt: PROMPT });

      expectPromptError(result, "claude-fake-ok");
      expect(result.text).toContain("cannot start claudish");
      expect(existsSync(recordPath)).toBe(false);
    },
    T_TEST
  );

  test(
    "REQ-14: notifications/cancelled removes the in-flight fake pid within 6 seconds",
    async () => {
      const mcp = await boot();
      // The request id belongs to this test, not to McpServer's private request counter.
      const requestId = 910001;
      const stdin = mcp.proc.stdin as { write(text: string): unknown; flush?(): unknown };
      stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: requestId,
          method: "tools/call",
          params: { name: "run_prompt", arguments: { model: "claude-fake-hang", prompt: PROMPT } },
        })}\n`
      );
      stdin.flush?.();
      await until(() => existsSync(recordPath), 10_000, "hanging fake to record its pid");
      const { pid } = record();
      expect(alive(pid)).toBe(true);

      const cancelledAt = performance.now();
      mcp.notify("notifications/cancelled", { requestId, reason: "black-box cancellation test" });
      await until(() => !alive(pid), 6_000, `cancelled fake pid ${pid} to disappear`);

      expect(performance.now() - cancelledAt).toBeLessThanOrEqual(6_000);
      expect(alive(mcp.pid)).toBe(true);
      expect((await mcp.listTools()).map((tool) => tool.name)).toContain("run_prompt");
    },
    T_TEST
  );
});

describe("quick prompts through the non-Claude proxy", () => {
  test(
    "REQ-12: makes one unlimited loopback request and never starts the print child",
    async () => {
      addLoopbackEndpoint();
      const mcp = await boot();
      const result = await mcp.callTool("run_prompt", { model: "rp-mock@m", prompt: PROMPT });

      expect(result.isError).toBe(false);
      expect(result.text.startsWith("7723\n\n---\nTokens: ")).toBe(true);
      expect(result.text).not.toContain("Auth:");
      expect(existsSync(recordPath)).toBe(false);
      expect(providerRequests).toHaveLength(1);
      expect(providerRequests[0]!.childRecordPresent).toBe(false);
      expectUnlimited(providerRequests[0]!.body);
      expect(providerRequests[0]!.body.model).toBe("m");
      expect(JSON.stringify(providerRequests[0]!.body.messages)).toContain(PROMPT);
    },
    T_TEST
  );

  test(
    "REQ-1 REQ-12 REQ-13: compares Claude then non-Claude sequentially with one child, one unlimited request and two answers",
    async () => {
      addLoopbackEndpoint();
      const mcp = await boot();
      const result = await mcp.callTool("compare_models", {
        models: ["claude-fake-ok", "rp-mock@m"],
        prompt: PROMPT,
      });

      expect(result.isError).toBe(false);
      expect(record().invocationCount).toBe(1);
      expect(record().argv).toEqual(argvFor("claude-fake-ok"));
      expect(record().stdin).toBe(PROMPT);
      expect(providerRequests).toHaveLength(1);
      expect(providerRequests[0]!.childRecordPresent).toBe(true);
      expect(providerRequests[0]!.childWasAlive).toBe(false);
      expectUnlimited(providerRequests[0]!.body);
      const claudeSection = result.text.indexOf("claude-fake-ok");
      const proxySection = result.text.indexOf("rp-mock@m");
      expect(claudeSection).toBeGreaterThanOrEqual(0);
      expect(proxySection).toBeGreaterThan(claudeSection);
      expect(result.text.slice(claudeSection, proxySection)).toContain("7723");
      expect(result.text.slice(proxySection)).toContain("7723");
      expect(result.text.match(/7723/g)).toHaveLength(2);
    },
    T_TEST
  );
});
