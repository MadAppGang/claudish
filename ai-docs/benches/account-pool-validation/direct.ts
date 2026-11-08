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
 * Returns every pid it signalled (descendants first, `pid` last).
 *
 * `group: true` is for a tree started `detached` (its own process group, `pid` its leader):
 * the whole group is signalled too (`kill(-pid)`), so a member whose parent already died and
 * was re-parented to pid 1 is still reached. The collected tree is signalled either way.
 */
export function killTree(
  pid: number,
  signal: NodeJS.Signals = "SIGKILL",
  opts: { group?: boolean } = {}
): number[] {
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
  if (opts.group) {
    try {
      process.kill(-pid, signal);
    } catch {
      /* the group is already gone */
    }
  }
  for (const p of order) {
    try {
      process.kill(p, signal);
    } catch {
      /* already gone */
    }
  }
  return order;
}

/**
 * True when `pid` no longer runs: no such process, or a zombie (dead, waiting to be
 * reaped; it can no longer make a call).
 */
export function pidGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
  const stat = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)])
    .stdout.toString()
    .trim();
  return stat === "" || stat.startsWith("Z");
}

/**
 * A process tree that may touch the keychain (the V2e seed child, each V2e `serve`). The
 * guard kills and AWAITS every producer before its single cleanup delete (review round 6:
 * a delete that ran while a producer was alive could be followed by that producer's write).
 */
export interface Producer {
  name: string;
  /** The root pid, for the security watch (`security` processes under it). */
  pid: number;
  /** Kill the whole tree (SIGKILL). Idempotent. */
  kill(): void;
  /** Kills, then resolves true once every process of the tree is gone; false if not confirmed in time. */
  confirmGone(timeoutMs: number): Promise<boolean>;
  /** The same, synchronously, for the 'exit' handler (which cannot await). */
  confirmGoneSync(timeoutMs: number): boolean;
}

/**
 * A `Producer` for a real process tree rooted at `pid` (a direct child of this process).
 * `group: true` when the tree runs in its own process group (`startServe({detached: true})`).
 */
export function treeProducer(
  name: string,
  pid: number,
  exited: Promise<unknown>,
  opts: { group?: boolean } = {}
): Producer {
  let pids: number[] = [pid];
  let killed = false;
  const kill = () => {
    if (killed) return;
    killed = true;
    pids = killTree(pid, "SIGKILL", opts);
  };
  return {
    name,
    pid,
    kill,
    async confirmGone(timeoutMs) {
      kill();
      const deadline = Date.now() + timeoutMs;
      // The root is our child: its exit is observed (and it is reaped) through `exited`.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const rootDone = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((r) => {
          timer = setTimeout(() => r(false), timeoutMs);
        }),
      ]);
      clearTimeout(timer);
      if (!rootDone) return false;
      while (Date.now() < deadline) {
        if (pids.every(pidGone)) return true;
        await Bun.sleep(50);
      }
      return pids.every(pidGone);
    },
    confirmGoneSync(timeoutMs) {
      kill();
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (pids.every(pidGone)) return true;
        Bun.sleepSync(50);
      }
      return pids.every(pidGone);
    },
  };
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
  /**
   * Called synchronously the moment the process exists, before any await: V2e registers it
   * with the keychain guard here, so no cleanup can run between the spawn and the registration.
   */
  onSpawn?: (p: Producer) => void;
  /**
   * Start the tree in its OWN process group (review round 8, GPT HIGH 1). A terminal Ctrl-C
   * signals the whole FOREGROUND group; a serve in that group would get SIGINT directly (the
   * launcher forwards it, the product exits at once) while the parent is still waiting for
   * the refresh gate. Detached, only the parent gets the terminal's signals and the serves
   * die only when the parent kills them. stdout and stderr stay piped. Used by `v2e-real.ts`;
   * the bench rows keep the default (same group), so a Ctrl-C of a row run still reaches its
   * serves and nothing a row starts can outlive an abrupt parent death.
   */
  detached?: boolean;
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
    detached: opts.detached === true,
  });
  const group = { group: opts.detached === true };
  opts.onSpawn?.(treeProducer("serve", child.pid, child.exited, group));
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
    // A child killed by a signal has `exitCode === null` and `signalCode` set: without the
    // second test a serve killed while starting was polled until the readiness timeout.
    if (Date.now() > deadline || child.exitCode !== null || child.signalCode !== null) {
      killTree(child.pid, "SIGKILL", group);
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
    kill: (signal = "SIGTERM") => killTree(child.pid, signal, group),
  };
}

/** A 3xx answer the parent received and did NOT follow. */
export interface CapturedRedirect {
  status: number;
  /** The `Location` header as sent (null when absent). Never contacted. */
  location: string | null;
}

/**
 * The ONLY way bench code in the Bun parent sends an HTTP request. The offline sandbox
 * wraps the product child, not the parent, so a parent `fetch` that followed a product
 * redirect to a non-loopback host would contact that host from an unsandboxed process.
 * `redirect: "manual"` is forced (a caller cannot override it): a 3xx comes back as the
 * response itself, and `redirectOf` turns it into a captured failure.
 */
export function parentFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, redirect: "manual" });
}

/** The captured redirect when `res` is a 3xx, else null. */
export function redirectOf(res: Response): CapturedRedirect | null {
  if (res.status < 300 || res.status > 399) return null;
  return { status: res.status, location: res.headers.get("location") };
}

/** One line naming a captured redirect: a harness error, never a PASS. */
export const describeRedirect = (r: CapturedRedirect): string =>
  `the product answered HTTP ${r.status} redirecting to ${JSON.stringify(r.location)}; the parent did not follow it (harness error)`;

export interface DirectReply {
  /** 0 when the connection failed (the process died mid-request: V9 `crash-after-refresh`). */
  status: number;
  headers: Record<string, string>;
  body: unknown;
  /** Set when `fetch` itself threw. */
  connectionError?: string;
  /** Set when the product answered 3xx: recorded, never followed. The row is a harness error. */
  redirect?: CapturedRedirect;
}

export async function postMessage(
  url: string,
  prompt: string,
  /** Becomes `metadata.user_id`'s `session_id`, which `conversationKey()` hashes into `prompt_cache_key`. */
  sessionId?: string,
  timeoutMs = 120_000
): Promise<DirectReply> {
  try {
    const res = await parentFetch(`${url}/v1/messages`, {
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
    const redirect = redirectOf(res);
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers),
      body,
      ...(redirect ? { redirect } : {}),
    };
  } catch (err) {
    return { status: 0, headers: {}, body: null, connectionError: String(err) };
  }
}
