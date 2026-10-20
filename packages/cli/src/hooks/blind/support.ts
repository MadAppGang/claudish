import { expect } from "bun:test";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  type PaneTestEnv,
  makePaneTestEnv,
  waitNoOrphans,
  writeFakeClaudeWrapper,
} from "../../pane/test-helpers/hermetic-env.ts";
import {
  type StubScript,
  type StubUpstream,
  startStubUpstream,
  stubEndpointConfig,
} from "../../test-helpers/stub-upstream.ts";

export const ENTRY = resolve(import.meta.dir, "../../index.ts");
export const OUTPUT_CAPTURE = resolve(import.meta.dir, "../output-capture.ts");
export const PUBLIC = resolve(import.meta.dir, "../public.ts");

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export async function until(check: () => boolean, label: string, ms = 10000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await Bun.sleep(15);
  }
}

export class ProcessCapture {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exit: Promise<number>;
  stdout = "";
  stderr = "";
  closed = false;

  constructor(command: string[], layout: PaneTestEnv, extra: Record<string, string> = {}) {
    this.child = spawn(command[0]!, command.slice(1), {
      cwd: layout.cwd,
      env: { ...layout.env, ...extra },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (s: string) => {
      this.stdout += s;
    });
    this.child.stderr.on("data", (s: string) => {
      this.stderr += s;
    });
    this.exit = new Promise<number>((yes, no) => {
      this.child.once("error", no);
      this.child.once("close", (code, signal) => {
        this.closed = true;
        yes(code ?? (signal ? 128 : -1));
      });
    });
  }

  write(text: string): void {
    this.child.stdin.write(text);
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (!this.closed) this.child.kill("SIGKILL");
    }, 2000);
    try {
      await this.exit;
    } finally {
      clearTimeout(timer);
    }
  }

  async finish(ms = 15000): Promise<number> {
    const timer = setTimeout(() => {
      if (!this.closed) this.child.kill("SIGKILL");
    }, ms);
    try {
      return await this.exit;
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface ModuleSource {
  name: string;
  code: string;
}

export class Workspace {
  readonly layout: PaneTestEnv;
  readonly configFile: string;
  readonly processes: ProcessCapture[] = [];
  readonly sessionIds: string[] = [];
  config: Record<string, unknown> = {};

  constructor(extra: Record<string, string> = {}) {
    this.layout = makePaneTestEnv(extra);
    this.configFile = join(this.layout.tmp, "config", "config.json");
    mkdirSync(dirname(this.configFile), { recursive: true });
    mkdirSync(join(this.layout.home, ".claudish"), { recursive: true });
  }

  file(relative: string, content: string): string {
    const path = join(this.layout.tmp, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return path;
  }

  module(name: string, code: string): string {
    return this.file(`modules/${name}`, code);
  }

  save(config: Record<string, unknown>): void {
    this.config = config;
    writeFileSync(this.configFile, JSON.stringify(config));
  }

  spawn(args: string[], extra: Record<string, string> = {}): ProcessCapture {
    return this.track([process.execPath, "--no-env-file", ENTRY, ...args], extra);
  }

  track(command: string[], extra: Record<string, string> = {}): ProcessCapture {
    const p = new ProcessCapture(command, this.layout, extra);
    this.processes.push(p);
    return p;
  }

  async cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const p = this.spawn(["--config", this.configFile, ...args]);
    const code = await p.finish();
    return { code, stdout: p.stdout, stderr: p.stderr };
  }

  journal(): JournalRow[] {
    const path = join(this.layout.home, ".claudish", "behavior-journal.jsonl");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((s) => JSON.parse(s));
  }

  debug(): string {
    const dir = join(this.layout.cwd, "logs");
    if (!existsSync(dir)) return "";
    const texts: string[] = [];
    const visit = (root: string) => {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (entry.isFile()) texts.push(readFileSync(path, "utf8"));
      }
    };
    visit(dir);
    return texts.join("\n");
  }

  diagnostics(p: ProcessCapture): string {
    const dir = join(this.layout.home, ".claudish");
    const logs = existsSync(dir)
      ? readdirSync(dir)
          .filter((name) => /^diag-\d+\.log$/.test(name))
          .map((name) => readFileSync(join(dir, name), "utf8"))
      : [];
    return [p.stderr, ...logs].join("\n");
  }

  async close(): Promise<void> {
    try {
      for (const p of this.processes) await p.stop();
      const leftovers = await waitNoOrphans({
        sockRoot: this.layout.sockRoot,
        ids: this.sessionIds,
      });
      expect(leftovers).toEqual({ processes: [], files: [] });
    } finally {
      this.layout.cleanup();
    }
  }
}

export interface JournalRow {
  schema: number;
  hookId: string;
  ruleId?: string;
  event: string;
  action?: string;
  decision: string;
  detail?: string;
  toolName?: string;
  argKeys?: string[];
}

export function hook(on: string, fields = ""): string {
  return `export default { apiVersion: 1, id: "test", ${fields} on: { ${on} } };`;
}

export interface SseEvent {
  type: string;
  index?: number;
  content_block?: {
    type: string;
    text?: string;
    thinking?: string;
    name?: string;
    input?: unknown;
  };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    signature?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  [key: string]: unknown;
}

export function events(raw: string): SseEvent[] {
  return raw
    .split(/\r?\n\r?\n/)
    .slice(0, -1)
    .flatMap((frame) => {
      const data = frame
        .split(/\r?\n/)
        .filter((s) => s.startsWith("data:"))
        .map((s) => s.slice(5).trim())
        .join("\n");
      if (!data || data === "[DONE]") return [];
      return [JSON.parse(data) as SseEvent];
    });
}

export function textOf(raw: string): string {
  return events(raw)
    .map((e) => {
      if (e.type === "content_block_start" && e.content_block?.type === "text")
        return e.content_block.text ?? "";
      return e.delta?.type === "text_delta" ? (e.delta.text ?? "") : "";
    })
    .join("");
}

export function thinkingOf(raw: string): string {
  return events(raw)
    .map((e) => (e.delta?.type === "thinking_delta" ? (e.delta.thinking ?? "") : ""))
    .join("");
}

export function toolInputs(raw: string): Array<{ name: string; input: unknown }> {
  const byIndex = new Map<number, { name: string; input: unknown; json: string }>();
  for (const e of events(raw)) {
    if (e.type === "content_block_start" && e.content_block?.type === "tool_use") {
      byIndex.set(e.index!, {
        name: e.content_block.name!,
        input: e.content_block.input,
        json: "",
      });
    }
    if (e.delta?.type === "input_json_delta") {
      const tool = byIndex.get(e.index!);
      if (tool) tool.json += e.delta.partial_json ?? "";
    }
  }
  return [...byIndex.values()].map((t) => ({
    name: t.name,
    input: t.json ? JSON.parse(t.json) : t.input,
  }));
}

export interface ProxyFixture {
  ws: Workspace;
  process: ProcessCapture;
  stub: StubUpstream;
  sessionId: string;
  fetch(body?: Record<string, unknown>): Promise<Response>;
  read(body?: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

export async function startProxy(
  opts: {
    modules?: ModuleSource[];
    hooks?: Record<string, unknown>;
    config?: Record<string, unknown>;
    script?: StubScript;
    endpointUrl?: string;
  } = {}
): Promise<ProxyFixture> {
  const ws = new Workspace();
  const stub = startStubUpstream({
    format: "openai-sse",
    script: opts.script ?? [{ parts: [{ text: "original" }] }],
  });
  try {
    const modules = (opts.modules ?? []).map((m) => ws.module(m.name, m.code));
    const config = stubEndpointConfig(stub);
    if (opts.endpointUrl) {
      const endpoints = config.customEndpoints as Record<string, { url: string }>;
      endpoints.stub!.url = `${opts.endpointUrl}/v1`;
    }
    ws.save({ ...config, ...opts.config, hooks: { modules, ...opts.hooks } });
    const dump = join(ws.layout.tmp, "claude-env.json");
    const wrapper = writeFakeClaudeWrapper(ws.layout.tmp);
    const sessionId = randomUUID();
    ws.sessionIds.push(sessionId);
    const p = ws.spawn(
      [
        "--config",
        ws.configFile,
        "-i",
        "--model",
        "stub@fake-model",
        "-y",
        "--quiet",
        "--session-id",
        sessionId,
        "--debug-claudish",
      ],
      {
        CLAUDE_PATH: wrapper,
        FAKE_CLAUDE_DUMP: dump,
        CONTRACT_FAKE_MAX_MS: "60000",
      }
    );
    await until(() => existsSync(dump) || p.closed, "the fake Claude environment");
    if (!existsSync(dump))
      throw new Error(`Launcher exited before Claude started: ${p.stderr}\n${p.stdout}`);
    // The dump file can exist before the fake Claude has finished writing it. Poll until it parses
    // (bounded) rather than reading a half-written file.
    const parsed: { value?: { env: Record<string, string> } } = {};
    await until(
      () => {
        try {
          parsed.value = JSON.parse(readFileSync(dump, "utf8")) as { env: Record<string, string> };
          return true;
        } catch {
          return false;
        }
      },
      "the fake Claude environment dump to be complete JSON",
      10000
    );
    const snapshot = parsed.value;
    if (!snapshot) throw new Error(`Fake Claude dump never parsed: ${dump}`);
    const base = snapshot.env.ANTHROPIC_BASE_URL;
    if (!base || !/^http:\/\/(127\.0\.0\.1|localhost):\d+/.test(base)) {
      throw new Error(`Expected a loopback child proxy, got ${String(base)}`);
    }
    const send = async (body: Record<string, unknown> = {}) =>
      fetch(`${base.replace(/\/$/, "")}/v1/messages`, {
        method: "POST",
        signal: AbortSignal.timeout(15000),
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": snapshot.env.ANTHROPIC_API_KEY ?? "test-placeholder",
        },
        body: JSON.stringify({
          model: "stub@fake-model",
          max_tokens: 1024,
          stream: true,
          messages: [{ role: "user", content: "HELLO" }],
          metadata: { user_id: JSON.stringify({ session_id: sessionId }) },
          ...body,
        }),
      });
    return {
      ws,
      process: p,
      stub,
      sessionId,
      fetch: send,
      async read(body) {
        const res = await send(body);
        const raw = await res.text();
        expect({
          status: res.status,
          text: res.headers.get("content-type")?.includes("text/event-stream"),
        }).toEqual({ status: 200, text: true });
        expect(events(raw).filter((e) => e.type === "message_stop")).toHaveLength(1);
        return raw;
      },
      async close() {
        stub.stop();
        await ws.close();
      },
    };
  } catch (error) {
    stub.stop();
    await ws.close();
    throw error;
  }
}

export function userRows(ws: Workspace, id = "hook:sample/test"): JournalRow[] {
  return ws.journal().filter((r) => r.hookId === id);
}

export async function waitJournal(
  ws: Workspace,
  match: (row: JournalRow) => boolean
): Promise<JournalRow[]> {
  await until(() => ws.journal().some(match), "the expected hook journal decision");
  return ws.journal();
}

/** Hold the provider after its first text delta until the test releases it. */
export function gatedProvider(prefix = "FIRST", suffix = "SECOND") {
  const release = deferred<void>();
  const reached = deferred<void>();
  let released = false;
  const base = {
    id: "chatcmpl-gate",
    object: "chat.completion.chunk",
    created: 0,
    model: "fake-model",
  };
  const frame = (delta: object, finish: string | null = null) =>
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      if (req.method !== "POST") return Response.json({ data: [] });
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async start(c) {
          c.enqueue(encoder.encode(frame({ role: "assistant", content: prefix })));
          reached.resolve();
          await release.promise;
          released = true;
          c.enqueue(encoder.encode(frame({ content: suffix })));
          c.enqueue(encoder.encode(frame({}, "stop")));
          c.enqueue(encoder.encode("data: [DONE]\n\n"));
          c.close();
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    reached: reached.promise,
    get released() {
      return released;
    },
    release() {
      release.resolve();
    },
    stop() {
      release.resolve();
      server.stop(true);
    },
  };
}

export async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (raw: string) => boolean,
  ms = 4000
): Promise<string> {
  let raw = "";
  const decoder = new TextDecoder();
  const deadline = Date.now() + ms;
  while (!predicate(raw)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`Client did not receive the expected SSE: ${raw}`);
    const read = reader.read();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const next = await Promise.race([
        read,
        new Promise<never>((_, no) => {
          timer = setTimeout(() => no(new Error("Client SSE read timed out")), remaining);
        }),
      ]);
      if (next.done) throw new Error(`Client ended before the expected SSE: ${raw}`);
      raw += decoder.decode(next.value, { stream: true });
    } finally {
      clearTimeout(timer);
    }
  }
  return raw;
}

export function rpc(proc: ProcessCapture, id: number, method: string, params?: unknown): void {
  proc.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`
  );
}

export function rpcLines(stdout: string): Array<{
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: unknown;
  method?: string;
}> {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
