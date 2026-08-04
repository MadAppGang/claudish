/**
 * Spawns one `claudish --mcp` server and drives it over stdio JSON-RPC,
 * capturing every byte of both streams.
 *
 * Extracted from `channel/test-helpers/channel-diagnostic.ts`, which grew the
 * same spawn + newline-framing logic inline. Kept transport-only on purpose:
 * no assertions, no scenario knowledge — it returns raw observations and lets
 * the caller judge them.
 */
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { redactSecrets } from "../redact.js";
import type { JsonRpcFrame, ToolCall, TraceSpan } from "./types.js";

export interface DriveOptions {
  /** Absolute path to `packages/cli/src/index.ts`. */
  serverEntry: string;
  cwd: string;
  env: Record<string, string>;
  calls: ToolCall[];
  timeoutMs: number;
  /** Appended with every line the harness observes, as it happens. */
  logFile: string;
  /** Mirror to console. */
  verbose: boolean;
}

export interface DriveResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  frames: JsonRpcFrame[];
  stderr: string;
  spans: TraceSpan[];
  toolText: Record<string, string>;
  /** Session ids seen in any `create_session` result, for log collection. */
  sessionIds: string[];
}

/**
 * Parse startup-trace spans off stderr. There are TWO emission shapes and the
 * op spans we care about only ever use the second one:
 *
 *   table (pre-finalize, printed once):  `     18ms        0ms  startup:op-env-flags`
 *   live  (post-finalize, streamed):     `[startup-trace] op:resolve(FOO) 12.3ms`
 *
 * Everything raised BEFORE finalize is buffered and lands in the table;
 * everything after streams live. Since finalize now runs right after the MCP
 * server starts, on-demand credential resolution always lands in the live form.
 * Both are parsed anyway, so a change in when finalize fires cannot silently
 * blind the harness.
 */
export function parseTraceSpans(stderr: string): TraceSpan[] {
  const out: TraceSpan[] = [];
  const DUR = /^[\d.]+(?:ms|s)$/;
  for (const raw of stderr.split("\n")) {
    const live = raw.indexOf("[startup-trace] ");
    if (live !== -1) {
      const rest = raw.slice(live + "[startup-trace] ".length).trim();
      if (!rest) continue;
      const tokens = rest.split(/\s+/);
      const name = tokens.find((t) => !DUR.test(t)) ?? tokens[0];
      out.push({ name, detail: rest.slice(rest.indexOf(name) + name.length).trim(), raw });
      continue;
    }
    // Table row: two duration columns, then the span name. The header row
    // ("start dur span") fails DUR on both columns and is skipped.
    const m = raw.match(/^\s+([\d.]+(?:ms|s))\s+([\d.]+(?:ms|s))\s+(\S+)(.*)$/);
    if (m) out.push({ name: m[3], detail: `${m[2]}${m[4]}`.trim(), raw });
  }
  return out;
}

/** Pull the text content out of a `tools/call` result, tolerating shapes. */
function extractText(result: Record<string, unknown> | undefined): string {
  if (!result) return "";
  const content = result.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) =>
      c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : ""
    )
    .join("\n");
}

/** Best-effort session id from a create_session result body. */
function findSessionId(text: string): string | undefined {
  const m =
    text.match(/\b(?:session[_ ]?id|sid)["' :=]+([0-9a-f]{8})\b/i) ??
    text.match(/\b([0-9a-f]{8})\b/);
  return m?.[1];
}

export async function driveServer(opts: DriveOptions): Promise<DriveResult> {
  const started = Date.now();
  const append = (line: string) => {
    try {
      appendFileSync(opts.logFile, line.endsWith("\n") ? line : `${line}\n`);
    } catch {
      // A full disk must not take the harness down mid-run.
    }
    if (opts.verbose) process.stderr.write(`\x1b[2m${line}\x1b[0m\n`);
  };

  const proc = spawn("bun", ["run", opts.serverEntry, "--mcp"], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: opts.cwd,
    env: opts.env,
  });

  const frames: JsonRpcFrame[] = [];
  const toolText: Record<string, string> = {};
  const sessionIds: string[] = [];
  let stderrBuf = "";
  let stdoutPending = "";
  let timedOut = false;

  proc.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8");
    stderrBuf += text;
    for (const l of text.split("\n").filter(Boolean)) append(`STDERR ${l}`);
  });

  // Maps a request id back to the tool it called, so results can be attributed
  // without assuming response ordering.
  const idToTool = new Map<number, string>();

  proc.stdout.on("data", (chunk: Buffer) => {
    stdoutPending += chunk.toString("utf-8");
    const lines = stdoutPending.split("\n");
    stdoutPending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      append(`STDOUT ${line}`);
      try {
        const frame = JSON.parse(line) as JsonRpcFrame;
        frames.push(frame);
        if (typeof frame.id === "number" && idToTool.has(frame.id)) {
          const tool = idToTool.get(frame.id) as string;
          const text = extractText(frame.result);
          toolText[tool] = (toolText[tool] ? `${toolText[tool]}\n` : "") + text;
          if (tool === "create_session") {
            const sid = findSessionId(text);
            if (sid) sessionIds.push(sid);
          }
        }
      } catch {
        // Non-JSON on stdout is itself a finding; the raw line is already logged.
      }
    }
  });

  const send = (rpc: object) => {
    const frame = `${JSON.stringify(rpc)}\n`;
    append(`SEND   ${frame.trim()}`);
    try {
      proc.stdin.write(frame);
    } catch {
      // Server already gone; exit handling reports it.
    }
  };

  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    proc.on("exit", (code, signal) => resolve({ code, signal }));
  });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const killTimer = setTimeout(() => {
    timedOut = true;
    append(`[harness] TIMEOUT after ${opts.timeoutMs}ms — terminating`);
    proc.kill("SIGTERM");
    setTimeout(() => proc.kill("SIGKILL"), 2000);
  }, opts.timeoutMs);

  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "mcp-e2e", version: "1.0.0" },
      capabilities: { experimental: { "claude/channel": {} } },
    },
  });
  await sleep(600);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await sleep(200);

  let nextId = 2;
  for (const call of opts.calls) {
    const id = nextId++;
    idToTool.set(id, call.name);
    send({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: call.name, arguments: call.arguments },
    });
    if (call.settleMs) await sleep(call.settleMs);

    if (call.cancelAfter) {
      // Cancel whatever this call started so an arm that only needs the
      // credential resolution never pays for a full model turn.
      const sid = sessionIds[sessionIds.length - 1];
      if (sid) {
        const cancelId = nextId++;
        idToTool.set(cancelId, "cancel_session");
        send({
          jsonrpc: "2.0",
          id: cancelId,
          method: "tools/call",
          params: { name: "cancel_session", arguments: { session_id: sid } },
        });
        await sleep(500);
      } else {
        append("[harness] cancelAfter requested but no session id was observed");
      }
    }
  }

  await sleep(500);
  proc.stdin.end();
  proc.kill("SIGTERM");
  const { code, signal } = await Promise.race([
    exited,
    sleep(5000).then(() => {
      proc.kill("SIGKILL");
      return { code: null, signal: "SIGKILL" };
    }),
  ]);
  clearTimeout(killTimer);

  const stderr = redactSecrets(stderrBuf);
  return {
    exitCode: code,
    signal,
    timedOut,
    durationMs: Date.now() - started,
    frames,
    stderr,
    spans: parseTraceSpans(stderr),
    toolText,
    sessionIds,
  };
}
