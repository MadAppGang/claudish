/**
 * Black-box fault fixtures for the network-recovery contract tests.
 *
 * Written from the requirements + the published contract only. Nothing in this
 * file imports, names, or reaches into the recovery implementation: every
 * observation is made either at the PROXY'S OWN URL (a real `fetch`, so the
 * status asserted is the one that survived any internal remap) or at an
 * UPSTREAM SOCKET we own (so an attempt is counted because a TCP connection
 * arrived, never because a log line said so).
 *
 * The two ground rules this file exists to enforce:
 *   1. attempts are counted at the upstream socket, not from `[Recovery]` logs;
 *   2. statuses are read from `Response.status` of a fetch against `proxy.url`.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfigFileOverride } from "../config-override.js";
import { createProxyServer } from "../proxy-server.js";
import type { ProxyServer } from "../types.js";

/** A single upstream connection observed at a fault fixture. */
export interface ObservedConnection {
  /** ms since the fixture's `t0` (set when the fixture was created). */
  at: number;
  /** The raw request body bytes this connection delivered ("" if it was reset first). */
  body: string;
  /** Raw request head (request line + headers), lowercased header names. */
  headers: Record<string, string>;
}

export interface RawFixture {
  readonly port: number;
  /** Connections in arrival order. */
  readonly connections: ObservedConnection[];
  /** ms offsets of each connection relative to the FIRST connection. */
  offsetsFromFirst(): number[];
  /** Gaps between consecutive connections, in ms. */
  gaps(): number[];
  /** Reset the recorded connections (keeps the server listening). */
  reset(): void;
  stop(): void;
}

export interface RawFixtureOptions {
  /**
   * 1-based attempt index from which the fixture answers with a real HTTP 200.
   * Attempts before it are dropped. `Infinity` (the default) never answers.
   */
  serveFromAttempt?: number;
  /** Text the served SSE answer carries. */
  sseText?: string;
  /**
   * "onOpen"  — reset the socket the instant it is accepted (fastest; the
   *             request body is never seen, so attempts are timed but not read).
   * "afterBody" — read the whole request first, record it, then reset. This is
   *             what makes a body-replay assertion possible.
   */
  resetWhen?: "onOpen" | "afterBody";
  /** Delay (ms) before answering, once the fixture has decided to answer. */
  respondDelayMs?: number;
}

/**
 * An OpenAI-shaped streaming answer. The proxy always talks `stream:true`
 * upstream (measured against a live fixture), so a non-stream JSON body comes
 * back with empty content — this is the shape a fixture must produce.
 */
export function openAiSse(text: string): string {
  const chunk = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
  return (
    chunk({
      id: "chatcmpl-fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture",
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    }) +
    chunk({
      id: "chatcmpl-fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    }) +
    "data: [DONE]\n\n"
  );
}

interface SocketLike {
  write(data: string): unknown;
  flush(): unknown;
  end(): unknown;
  terminate?: () => void;
}

/** Write a canned HTTP response after `delayMs`, tolerating a peer that left. */
function answerLater(sock: SocketLike, body: string, delayMs: number): void {
  setTimeout(() => {
    try {
      sock.write(body);
      sock.flush();
      sock.end();
    } catch {
      /* peer gone */
    }
  }, delayMs);
}

/**
 * Parse one complete HTTP/1.1 request out of the bytes so far.
 * Returns null while the head or the declared body is still incomplete.
 */
function parseHttpRequest(buf: Buffer): { headers: Record<string, string>; body: string } | null {
  const raw = buf.toString("latin1");
  const headEnd = raw.indexOf("\r\n\r\n");
  if (headEnd === -1) return null;

  const head = raw.slice(0, headEnd);
  const headers: Record<string, string> = {};
  for (const line of head.split("\r\n").slice(1)) {
    const i = line.indexOf(":");
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }

  const headLen = Buffer.byteLength(head, "latin1") + 4;
  const bodyBytes = buf.length - headLen;
  const declared = headers["content-length"];
  if (declared !== undefined && bodyBytes < Number(declared)) return null;
  if (declared === undefined && headers["transfer-encoding"]?.includes("chunked")) {
    if (!raw.endsWith("0\r\n\r\n")) return null;
  }
  return { headers, body: buf.subarray(headLen).toString("utf8") };
}

function httpOk(body: string): string {
  return [
    "HTTP/1.1 200 OK",
    "Content-Type: text/event-stream",
    "Cache-Control: no-cache",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "Connection: close",
    "",
    body,
  ].join("\r\n");
}

/**
 * A raw TCP fixture on a FIXED port.
 *
 * Every accepted connection is one upstream attempt, timestamped at accept
 * time. This is the instrument for anything that asserts the ladder's SHAPE:
 * a refused port cannot count and cannot be slow.
 */
export function startRawFixture(port: number, options: RawFixtureOptions = {}): RawFixture {
  const {
    serveFromAttempt = Number.POSITIVE_INFINITY,
    sseText = "RAW-FIXTURE-ANSWER",
    resetWhen = "onOpen",
    respondDelayMs = 0,
  } = options;

  const connections: ObservedConnection[] = [];
  let t0 = Date.now();

  interface PerSocket {
    index: number;
    buf: Buffer;
    recorded: boolean;
  }

  const server = Bun.listen<PerSocket>({
    hostname: "127.0.0.1",
    port,
    socket: {
      open(sock) {
        const index = connections.length + 1;
        sock.data = { index, buf: Buffer.alloc(0), recorded: false };
        if (resetWhen === "onOpen") {
          connections.push({ at: Date.now() - t0, body: "", headers: {} });
          if (index >= serveFromAttempt) {
            answerLater(sock, httpOk(openAiSse(sseText)), respondDelayMs);
          } else {
            hardClose(sock);
          }
        }
      },
      data(sock, chunk) {
        if (resetWhen === "onOpen") return;
        const state = sock.data;
        if (state.recorded) return;
        state.buf = Buffer.concat([state.buf, chunk]);
        const parsed = parseHttpRequest(state.buf);
        if (parsed === null) return;

        state.recorded = true;
        connections.push({ at: Date.now() - t0, body: parsed.body, headers: parsed.headers });
        if (state.index >= serveFromAttempt) {
          answerLater(sock, httpOk(openAiSse(sseText)), respondDelayMs);
        } else {
          hardClose(sock);
        }
      },
      close() {},
      error() {},
      drain() {},
    },
  });

  return {
    port: server.port,
    connections,
    offsetsFromFirst() {
      const first = connections[0];
      if (first === undefined) return [];
      return connections.map((c) => c.at - first.at);
    },
    gaps() {
      const offsets = this.offsetsFromFirst();
      return offsets.slice(1).map((o, i) => o - (offsets[i] ?? 0));
    },
    reset() {
      connections.length = 0;
      t0 = Date.now();
    },
    stop() {
      try {
        server.stop(true);
      } catch {
        /* already stopped */
      }
    },
  };
}

function hardClose(sock: { terminate?: () => void; end: () => void }): void {
  try {
    if (typeof sock.terminate === "function") sock.terminate();
    else sock.end();
  } catch {
    /* already gone */
  }
}

/** A healthy upstream that records what it received. */
export interface HealthyFixture {
  readonly port: number;
  readonly requests: { at: number; body: string; authorization: string | null; path: string }[];
  stop(): void;
}

export function startHealthyFixture(text = "HEALTHY-FIXTURE-ANSWER", port = 0): HealthyFixture {
  const requests: HealthyFixture["requests"] = [];
  const t0 = Date.now();
  const server = Bun.serve({
    port,
    async fetch(req) {
      requests.push({
        at: Date.now() - t0,
        body: await req.text(),
        authorization: req.headers.get("authorization"),
        path: new URL(req.url).pathname,
      });
      return new Response(openAiSse(text), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  return {
    port: server.port as number,
    requests,
    stop() {
      try {
        server.stop(true);
      } catch {
        /* already stopped */
      }
    },
  };
}

/** An upstream that is reachable and answers a real HTTP error status. */
export function startStatusFixture(status: number, port = 0) {
  let hits = 0;
  const server = Bun.serve({
    port,
    fetch() {
      hits += 1;
      return new Response(JSON.stringify({ error: { message: "fixture-upstream-error" } }), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return {
    port: server.port as number,
    get hits() {
      return hits;
    },
    stop() {
      try {
        server.stop(true);
      } catch {
        /* already stopped */
      }
    },
  };
}

/**
 * Reserve `count` ports by binding them all at once and then releasing them.
 * Binding simultaneously guarantees the numbers differ from each other.
 *
 * NEVER port 1: it is privileged, and a recovery fixture has to be able to
 * bind the same port again later.
 */
export function reservePorts(count: number): number[] {
  const servers = Array.from({ length: count }, () =>
    Bun.serve({ port: 0, fetch: () => new Response("reserved") })
  );
  const ports = servers.map((s) => s.port as number);
  for (const s of servers) s.stop(true);
  return ports;
}

/**
 * P-1: prove the "refused" fault is really refused, immediately before the run.
 *
 * A sibling test that grabbed the port turns a refusal into a live server and
 * inverts the scenario silently. Fails loudly — never skips.
 */
export async function assertRefused(port: number): Promise<void> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(1000),
    });
    throw new Error(
      `PRECONDITION P-1 FAILED: 127.0.0.1:${port} answered HTTP ${res.status}; ` +
        "the refusal fault is not in force (a sibling test probably took the port)."
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("PRECONDITION")) throw err;
    // Any connect-level rejection is what we wanted.
  }
}

export interface EndpointSpec {
  name: string;
  port: number;
  model: string;
  apiKey?: string;
  /** Override the URL entirely (for DNS / TEST-NET faults). */
  url?: string;
}

export function endpointsConfig(specs: EndpointSpec[]): Record<string, unknown> {
  const customEndpoints: Record<string, unknown> = {};
  for (const spec of specs) {
    customEndpoints[spec.name] = {
      kind: "simple",
      url: spec.url ?? `http://127.0.0.1:${spec.port}/v1`,
      format: "openai",
      apiKey: spec.apiKey ?? `test-key-${spec.name}`,
      models: [spec.model],
    };
  }
  return { customEndpoints };
}

/**
 * A pool of identical raw fault fixtures, one endpoint each.
 *
 * MEASURED, and the reason this exists: a recovery EPISODE is keyed per
 * endpoint and survives the request that opened it — a second request to the
 * same dead endpoint continues the ladder at the next rung rather than
 * restarting at 5s. So two arms of a paired experiment that share an endpoint
 * are not comparable: the later arm inherits the earlier arm's rung. Every arm
 * takes a FRESH endpoint from this pool, which also makes the file
 * order-independent.
 */
export interface FixturePool {
  specs: EndpointSpec[];
  /** Hand out an endpoint/fixture pair nobody else in this file has used. */
  next(): { model: string; fixture: RawFixture; name: string };
  stopAll(): void;
}

export function createRawFixturePool(
  count: number,
  prefix: string,
  options: RawFixtureOptions = {}
): FixturePool {
  const ports = reservePorts(count);
  const fixtures = ports.map((p) => startRawFixture(p, options));
  const specs: EndpointSpec[] = ports.map((p, i) => ({
    name: `${prefix}-${i + 1}`,
    port: p,
    model: `m-${i + 1}`,
  }));
  let cursor = 0;
  return {
    specs,
    next() {
      if (cursor >= specs.length) {
        throw new Error(
          `fixture pool "${prefix}" exhausted after ${specs.length} arms — ` +
            "raise the pool size rather than reusing an endpoint (episodes are per-endpoint)."
        );
      }
      const spec = specs[cursor] as EndpointSpec;
      const fixture = fixtures[cursor] as RawFixture;
      cursor += 1;
      return { model: `${spec.name}@${spec.model}`, fixture, name: spec.name };
    },
    stopAll() {
      for (const f of fixtures) f.stop();
    },
  };
}

export interface ProxyHandle {
  proxy: ProxyServer;
  url: string;
  /** Everything the proxy wrote to stderr while this handle was live. */
  stderr(): string;
  shutdown(): Promise<void>;
}

export interface StartProxyOptions {
  model?: string;
  modelChain?: string[];
  quiet?: boolean;
  captureStderr?: boolean;
}

/**
 * Start a real proxy against a temp config file, exactly as `proxy-server.test.ts`
 * does — the config-file override, never a write to the developer's real config, and
 * no catalog warm: the fixtures are declared endpoints, and the warm fetches the live
 * catalog service (about 8 s on a CI runner), which the first request then waits on.
 */
export async function startProxy(
  config: Record<string, unknown>,
  options: StartProxyOptions = {}
): Promise<ProxyHandle> {
  const dir = mkdtempSync(join(tmpdir(), "recovery-contract-"));
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify(config), "utf8");
  setConfigFileOverride(configPath);
  const restoreCatalogWarm = envSnapshot(["CLAUDISH_DISABLE_CATALOG_WARM"]);
  process.env.CLAUDISH_DISABLE_CATALOG_WARM = "1";

  const captured: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  if (options.captureStderr) {
    process.stderr.write = ((chunk: string | Uint8Array) => {
      captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;
  }

  let proxy: ProxyServer;
  try {
    proxy = await createProxyServer(0, undefined, options.model, false, undefined, undefined, {
      quiet: options.quiet ?? true,
      modelChain: options.modelChain,
    });
  } catch (err) {
    if (options.captureStderr) process.stderr.write = realWrite;
    setConfigFileOverride(null);
    restoreCatalogWarm();
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }

  return {
    proxy,
    url: proxy.url,
    stderr: () => captured.join(""),
    async shutdown() {
      if (options.captureStderr) process.stderr.write = realWrite;
      try {
        await proxy.shutdown();
      } finally {
        setConfigFileOverride(null);
        restoreCatalogWarm();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

export interface MessageRequest {
  model: string;
  stream?: boolean;
  headers?: Record<string, string>;
  content?: unknown;
  signal?: AbortSignal;
  maxTokens?: number;
}

/** POST /v1/messages at the proxy's PUBLIC url, and time it. */
export async function postMessage(
  proxyUrl: string,
  req: MessageRequest
): Promise<{ status: number; body: string; headers: Headers; elapsedMs: number }> {
  const started = Date.now();
  const res = await fetch(`${proxyUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(req.headers ?? {}) },
    body: JSON.stringify({
      model: req.model,
      max_tokens: req.maxTokens ?? 64,
      ...(req.stream ? { stream: true } : {}),
      messages: [{ role: "user", content: req.content ?? "hello" }],
    }),
    signal: req.signal,
  });
  const body = await res.text();
  return { status: res.status, body, headers: res.headers, elapsedMs: Date.now() - started };
}

/**
 * The deadline the contract DERIVES from `API_TIMEOUT_MS`:
 *   min(API_TIMEOUT_MS, 300_000) − 30_000
 * (docs/advanced/environment.md). Computed here from the published formula so
 * a test can never hardcode 270_000.
 */
export function derivedDeadlineMs(apiTimeoutMs: number): number {
  return Math.min(apiTimeoutMs, 300_000) - 30_000;
}

/** The published ladder: 5s → 10s → 30s → 60s → 60s → … (FR-2). */
export const LADDER_MS = [5_000, 10_000, 30_000, 60_000, 60_000, 60_000] as const;

/**
 * Attempt start offsets the published ladder puts inside `deadlineMs`,
 * measured from the first attempt at t=0. Derived, never hardcoded.
 */
export function scheduledAttemptOffsets(deadlineMs: number): number[] {
  const offsets = [0];
  let t = 0;
  for (let i = 0; ; i += 1) {
    const gap = LADDER_MS[Math.min(i, LADDER_MS.length - 1)];
    t += gap;
    if (t >= deadlineMs) break;
    offsets.push(t);
  }
  return offsets;
}

/** Restores env vars a test set, including deleting ones that were absent. */
export function envSnapshot(names: string[]): () => void {
  const saved = new Map<string, string | undefined>();
  for (const n of names) saved.set(n, process.env[n]);
  return () => {
    for (const [n, v] of saved) {
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }
  };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
