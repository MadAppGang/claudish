/**
 * Direct entry point: the BUILT bundle as a proxy, driven by a plain HTTP
 * Messages-shaped request, with no Claude Code in the loop.
 *
 *   claudish serve --port <n> --models <slots.json>      (serve-command.ts)
 *   POST http://127.0.0.1:<n>/v1/messages   {"model": "<slot>", ...}
 *
 * `serve` parks `createProxyServer` and spawns no Claude Code child, so it is the
 * direct entry for rows that need N coordinated processes or a sub-second window.
 * A row's third source is the HTTP response (the transcript does not exist).
 *
 * This module only starts a `serve` process and posts a request; rows.ts owns
 * what each row does with them (stage 4a's go/no-go main block moved there as
 * the V11 `direct` row).
 */

import { LAUNCHER, OFFLINE_PROFILE } from "./row-env.ts";

/** The slot id the request names; `serve` maps it to the Codex model. */
export const SLOT = "claude-sonnet-4-6";

export interface ServeProc {
  port: number;
  url: string;
  pid: number;
  stdout(): string;
  stderr(): string;
  /** Resolves with the exit code when the process ends. */
  exited: Promise<number | null>;
  kill(signal?: NodeJS.Signals): void;
}

/**
 * Kill `pid` and every descendant. The launcher (`bin/claudish.cjs`) spawns the
 * bundle as a CHILD, so killing only the launcher orphans a `serve` that keeps its
 * port, its lock file and its timers (found in stage 4b on the first run). The
 * descendants are collected BEFORE the first signal, because a killed parent
 * re-parents its children to pid 1 and they can no longer be found by ppid.
 */
export function killTree(pid: number, signal: NodeJS.Signals = "SIGKILL"): void {
  const listing = Bun.spawnSync(["ps", "-axo", "pid=,ppid="]).stdout.toString();
  const children = new Map<number, number[]>();
  for (const line of listing.split("\n")) {
    const [p, pp] = line.trim().split(/\s+/).map(Number);
    if (!p || !pp) continue;
    children.set(pp, [...(children.get(pp) ?? []), p]);
  }
  const order: number[] = [];
  const walk = (p: number) => {
    for (const c of children.get(p) ?? []) walk(c);
    order.push(p);
  };
  walk(pid);
  for (const p of order) {
    try {
      process.kill(p, signal);
    } catch {
      /* already gone */
    }
  }
}

export async function freePort(): Promise<number> {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = probe.port as number;
  probe.stop(true);
  return port;
}

/** Start `claudish serve` from the built bundle and wait for its listening line. */
export async function startServe(opts: {
  env: Record<string, string>;
  cwd: string;
  slotsPath: string;
  offline?: boolean;
  readyTimeoutMs?: number;
  /** A mutant tree's launcher; default is the built `packages/cli/bin/claudish.cjs`. */
  launcher?: string;
}): Promise<ServeProc> {
  const port = await freePort();
  const inner = [
    "node",
    opts.launcher ?? LAUNCHER,
    "serve",
    "--port",
    String(port),
    "--models",
    opts.slotsPath,
  ];
  const argv = opts.offline ? ["sandbox-exec", "-p", OFFLINE_PROFILE, ...inner] : inner;
  const child = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: opts.env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  let out = "";
  let err = "";
  const drain = async (stream: ReadableStream<Uint8Array>, into: (s: string) => void) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      into(decoder.decode(value));
    }
  };
  void drain(child.stdout, (s) => {
    out += s;
  });
  void drain(child.stderr, (s) => {
    err += s;
  });
  const deadline = Date.now() + (opts.readyTimeoutMs ?? 30_000);
  while (!out.includes("listening on")) {
    if (Date.now() > deadline || child.exitCode !== null) {
      killTree(child.pid, "SIGKILL");
      throw new Error(`serve did not start: stdout=${out} stderr=${err}`);
    }
    await Bun.sleep(50);
  }
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    pid: child.pid,
    stdout: () => out,
    stderr: () => err,
    exited: child.exited,
    kill: (signal = "SIGTERM") => killTree(child.pid, signal),
  };
}

export interface DirectReply {
  /** 0 when the connection failed (the process died mid-request: V9 `crash-after-refresh`). */
  status: number;
  headers: Record<string, string>;
  body: unknown;
  /** Set when `fetch` itself threw. */
  connectionError?: string;
}

export async function postMessage(
  url: string,
  prompt: string,
  /** Becomes `metadata.user_id`'s `session_id`, which `conversationKey()` hashes into `prompt_cache_key`. */
  sessionId?: string,
  timeoutMs = 120_000
): Promise<DirectReply> {
  try {
    const res = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": "placeholder-not-a-credential",
      },
      body: JSON.stringify({
        model: SLOT,
        max_tokens: 64,
        stream: false,
        messages: [{ role: "user", content: prompt }],
        ...(sessionId ? { metadata: { user_id: JSON.stringify({ session_id: sessionId }) } } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* keep text */
    }
    return { status: res.status, headers: Object.fromEntries(res.headers), body };
  } catch (err) {
    return { status: 0, headers: {}, body: null, connectionError: String(err) };
  }
}
