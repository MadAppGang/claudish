/**
 * Spawns a real `claude -p` session wired to the claudish MCP server and parses
 * its stream-json output into something assertable.
 *
 * Two decisions here are load-bearing and were learned the hard way:
 *
 *  - NO `--bare`. Under `--bare` Claude Code defers the MCP connection past
 *    `system/init`: the init frame reports `status: "pending"` with no MCP tools
 *    in the `tools` array, so the model decides what to do while claudish is not
 *    in its toolset and improvises with Bash instead. Any test asserting a tool
 *    was DISCOVERED or CALLED must drop it. `--strict-mcp-config` alone still
 *    confines MCP to our temp config, which is the isolation that matters.
 *
 *  - The MCP server is spawned through `env -i`. A `.mcp.json` `env` block is
 *    ADDITIVE — Claude Code merges it over its own environment — so it cannot
 *    remove anything. But Claude Code is typically launched under
 *    `op run --environment …`, which means the server would inherit provider
 *    keys 1Password already resolved and never consult 1Password at all. `env -i`
 *    is the only way to guarantee the credential path under test is the one that
 *    actually runs.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactSecrets } from "../redact.js";
import type { AuthMode, ClaudishCall, ContentBlock, StreamFrame } from "./types.js";

export interface SessionOptions {
  serverEntry: string;
  /** Isolated claudish config the MCP server must read. */
  claudishConfigPath: string;
  /** Directory for this run's artifacts. */
  runDir: string;
  prompt: string;
  timeoutMs: number;
  authMode: AuthMode;
  cwd: string;
  verbose: boolean;
}

export interface SessionResult {
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  frames: StreamFrame[];
  stdout: string;
  stderr: string;
}

/** Write the temp `.mcp.json` and return its path. */
export function writeMcpConfig(opts: SessionOptions): string {
  // A stripped environment, built explicitly. Only what `bun` and claudish need
  // to start, plus the isolated config pointer and the observability flags.
  const serverEnv: string[] = [
    `HOME=${process.env.HOME ?? ""}`,
    `PATH=${process.env.PATH ?? ""}`,
    "TERM=dumb",
    `CLAUDISH_CONFIG=${opts.claudishConfigPath}`,
    "CLAUDISH_MCP_TOOLS=all",
    "CLAUDISH_STARTUP_TRACE=1",
    "CLAUDISH_OP_LOCK_TRACE=1",
  ];
  // Service-account mode is the unattended path: pass the token through so the
  // SDK never needs a desktop handshake. In desktop mode nothing is passed and
  // the account comes from the isolated config.
  if (opts.authMode === "service-account" && process.env.OP_SERVICE_ACCOUNT_TOKEN) {
    serverEnv.push(`OP_SERVICE_ACCOUNT_TOKEN=${process.env.OP_SERVICE_ACCOUNT_TOKEN}`);
  }

  const config = {
    mcpServers: {
      claudish: {
        command: "/usr/bin/env",
        args: ["-i", ...serverEnv, "bun", "run", opts.serverEntry, "--mcp"],
      },
    },
  };
  const path = join(opts.runDir, "mcp-config.json");
  writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
  return path;
}

/** Run the session to completion (or timeout) and return the raw observation. */
export async function runSession(opts: SessionOptions): Promise<SessionResult> {
  const mcpConfigPath = writeMcpConfig(opts);
  const started = Date.now();

  return new Promise<SessionResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const proc = spawn(
      "claude",
      [
        "-p",
        "--mcp-config",
        mcpConfigPath,
        "--strict-mcp-config",
        "--dangerously-skip-permissions",
        "--output-format",
        "stream-json",
        "--verbose",
        opts.prompt,
      ],
      { cwd: opts.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] }
    );
    // Without this the run stalls ~3s on "no stdin data received".
    proc.stdin?.end();

    proc.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (opts.verbose) process.stderr.write(text);
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const finish = (exitCode: number, timedOut: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        timedOut,
        durationMs: Date.now() - started,
        frames: parseFrames(stdout),
        stdout,
        stderr: redactSecrets(stderr),
      });
    };

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 3000);
      finish(-1, true);
    }, opts.timeoutMs);

    proc.on("exit", (code) => finish(code ?? 1, false));
    proc.on("error", () => finish(1, false));
  });
}

/** Split stream-json stdout into frames, skipping anything unparseable. */
export function parseFrames(stdout: string): StreamFrame[] {
  const frames: StreamFrame[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      frames.push(JSON.parse(t) as StreamFrame);
    } catch {
      // Partial or interleaved output; the raw stdout is kept for forensics.
    }
  }
  return frames;
}

/** Flatten a tool_result `content` field, which may be string | blocks | object. */
function flattenResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(flattenResult).join("\n");
  if (content && typeof content === "object") {
    const block = content as ContentBlock;
    if (typeof block.text === "string") return block.text;
    return JSON.stringify(content);
  }
  return content === undefined || content === null ? "" : String(content);
}

/**
 * Pair every claudish `tool_use` with its `tool_result`.
 *
 * Matching is by `tool_use_id`, never by position: the agent may interleave
 * calls, and a positional pairing would silently attribute one model's answer
 * to another — the exact class of error this benchmark exists to catch.
 */
export function extractClaudishCalls(frames: StreamFrame[]): ClaudishCall[] {
  const calls = new Map<string, ClaudishCall>();

  for (const frame of frames) {
    for (const block of frame.message?.content ?? []) {
      if (block.type === "tool_use" && typeof block.name === "string") {
        // Claude Code namespaces MCP tools as mcp__<server>__<tool>.
        if (!block.name.startsWith("mcp__") || !block.name.includes("claudish")) continue;
        const input = (block.input ?? {}) as Record<string, unknown>;
        const model = typeof input.model === "string" ? input.model : undefined;
        calls.set(block.id ?? "", {
          tool: block.name.split("__").pop() ?? block.name,
          qualifiedName: block.name,
          toolUseId: block.id ?? "",
          input,
          ...(model !== undefined ? { model } : {}),
          resultText: "",
          isError: false,
        });
      }
      if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        const call = calls.get(block.tool_use_id);
        if (!call) continue;
        call.resultText = flattenResult(block.content);
        call.isError = block.is_error === true;
      }
    }
  }
  return [...calls.values()];
}

/**
 * Model ids the session actually saw, harvested from catalog tool results.
 *
 * Best-effort by design: the checks use this to confirm a chosen model was real
 * and visible to the agent, so a permissive extraction that occasionally admits
 * an extra token is the safe direction to err. A miss would fail a good run.
 */
export function extractCatalogModels(calls: ClaudishCall[]): string[] {
  const found = new Set<string>();
  const ID =
    /\b[a-z0-9][\w.]*(?:[-.][\w.]+)*\/[\w.\-]+\b|\b(?:gpt|claude|gemini|glm|kimi|grok|deepseek|qwen|minimax|llama|mistral)[\w.\-]*\b/gi;
  for (const call of calls) {
    if (!/list_models|search_models|compare_models/.test(call.tool)) continue;
    for (const m of call.resultText.matchAll(ID)) found.add(m[0]);
  }
  return [...found].sort();
}

/** The last assistant text block in the stream. */
export function extractFinalText(frames: StreamFrame[]): string {
  let text = "";
  for (const frame of frames) {
    if (frame.message?.role !== "assistant") continue;
    for (const block of frame.message.content ?? []) {
      if (block.type === "text" && typeof block.text === "string") text = block.text;
    }
  }
  return text;
}
