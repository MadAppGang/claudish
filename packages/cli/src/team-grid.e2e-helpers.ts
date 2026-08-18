/**
 * End-to-end test helpers for team-grid + magmux integration.
 *
 * These utilities let a Bun test:
 *   - Launch a command under a real PTY (via expect(1))
 *   - Subscribe to magmux's Unix socket and collect events
 *   - Send keystrokes into the PTY
 *   - Capture exit codes and cleaned stdout
 *
 * Bun.spawn cannot allocate a PTY on its own. We use `expect(1)` as a PTY
 * allocator because:
 *   - It's preinstalled on macOS
 *   - It's trivially available on Linux (`apt install expect` / `yum install expect`)
 *   - Its `spawn` command forks a child under a pty(4) and proxies stdin/stdout,
 *     which is exactly what we want
 *   - `script(1)` does not work here because macOS script aborts with
 *     `tcgetattr/ioctl: Operation not supported on socket` when its own
 *     stdin is not already a TTY, which it isn't under `bun test`.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { type Socket, connect } from "node:net";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";

// ─── Magmux Binary Resolution ────────────────────────────────────────────────

/**
 * Locate the magmux binary for tests. Prefers the npm-installed copy because
 * that is what the CI shipping artifact uses. Falls back to $PATH.
 */
export function findMagmuxForTest(): string {
  const candidates = [
    join(
      import.meta.dir,
      "..",
      "node_modules",
      "@claudish",
      `magmux-${platform()}-${process.arch}`,
      "bin",
      "magmux"
    ),
    "/opt/homebrew/bin/magmux",
    "/usr/local/bin/magmux",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error("magmux not found for e2e tests. Install via `bun install` or PATH.");
}

// ─── PTY Runner ──────────────────────────────────────────────────────────────

export interface PtyRunOptions {
  command: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Optional callback invoked on every chunk of captured output. */
  onData?: (chunk: string) => void;
}

export interface PtyHandle {
  proc: ChildProcess;
  /** Promise that resolves when the child exits, yielding {code, stdout}. */
  waitForExit(): Promise<{ code: number; stdout: string }>;
  /** Write raw bytes to the PTY's stdin. */
  send(data: string): void;
  /** Force-terminate the underlying process tree. */
  kill(signal?: NodeJS.Signals): void;
}

export type HeadlessHandle = Omit<PtyHandle, "send">;

/**
 * Spawn a command directly with non-TTY stdio.
 *
 * magmux 0.8.0 auto-enables headless mode when stdin is not a terminal and no
 * longer survives the expect(1) wrapper used by runInPty(). Socket-protocol
 * tests therefore launch it directly and use the socket as the whole interface.
 */
export function runHeadless(opts: PtyRunOptions): HeadlessHandle {
  const command = opts.command[0];
  if (!command) throw new Error("runHeadless requires a command");

  const proc = spawn(command, opts.command.slice(1), {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let rawStdout = "";
  proc.stdout?.on("data", (chunk: Buffer) => {
    const s = chunk.toString("utf-8");
    rawStdout += s;
    opts.onData?.(s);
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    const s = chunk.toString("utf-8");
    rawStdout += s;
    opts.onData?.(s);
  });

  const exit = new Promise<{ code: number; stdout: string }>((resolve) => {
    proc.once("exit", (code) => {
      resolve({ code: code ?? -1, stdout: stripAnsi(rawStdout) });
    });
  });

  return {
    proc,
    waitForExit() {
      return exit;
    },
    kill(signal: NodeJS.Signals = "SIGTERM") {
      try {
        proc.kill(signal);
      } catch {
        /* already dead */
      }
    },
  };
}

/**
 * Spawn a command under a real PTY using expect(1). Cleaned stdout excludes
 * ANSI escape sequences.
 *
 * We drive expect(1) by piping a tiny Tcl script to stdin. The script:
 *   - Disables timeout (test code controls the lifetime)
 *   - Spawns the real command, which creates a pty(4) and attaches the child
 *   - `interact` proxies expect's stdin/stdout to the child
 *   - On EOF it waits for the child, captures exit status, and exits with it
 *
 * expect's own stdin is our test handle, so test code can still send('q')
 * and have the keystroke reach the spawned process over the PTY.
 */
/**
 * Size given to a spawned pty.
 *
 * Comfortably above magmux's stated minimum of 3 rows / 20 columns per pane, so
 * a gridfile with several panes still lays out. These are not the developer's
 * real terminal and do not need to be: the tests read magmux's socket, not its
 * rendering, and a fixed size makes the harness independent of whoever runs it.
 */
const PTY_ROWS = 50;
const PTY_COLS = 200;

export function runInPty(opts: PtyRunOptions): PtyHandle {
  void platform; // retained for future per-platform tweaks
  // Build the shell command string, quoting each arg for sh -c.
  const shellCmd = opts.command.map(shellQuote).join(" ");

  // Tcl program for expect:
  //   - timeout -1: don't limit; test code owns lifetime
  //   - stty_init: give the pty a SIZE. expect sizes a spawned pty from its own
  //     controlling terminal, and we spawn it with `stdio: ["pipe","pipe","pipe"]`,
  //     so there is no terminal to copy from and the pty comes up 0x0. Measured
  //     directly, no magmux involved: `stty size` inside such a pty prints
  //     `0 0`, and prints `50 200` once stty_init is set. A tty-aware child
  //     then derives nonsense from it — magmux subtracts its status line and
  //     reports `cannot lay out 1 panes in 0x-1`, which is a correct complaint
  //     about a terminal we failed to size rather than a bug in magmux.
  //   - spawn + interact: fork sh under a pty(4), which executes our command.
  //     We pass the shell command as a Tcl brace-literal so none of its
  //     contents get re-parsed by Tcl.
  //   - On child exit, capture its status and exit expect with the same code
  const tclScript = [
    "set timeout -1",
    "log_user 1",
    `set stty_init "rows ${PTY_ROWS} cols ${PTY_COLS}"`,
    `spawn -noecho sh -c ${tclBrace(shellCmd)}`,
    "interact",
    "catch wait result",
    "exit [lindex $result 3]",
  ].join("\n");

  const proc = spawn("expect", ["-c", tclScript], {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let rawStdout = "";
  proc.stdout?.on("data", (chunk: Buffer) => {
    const s = chunk.toString("utf-8");
    rawStdout += s;
    opts.onData?.(s);
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    const s = chunk.toString("utf-8");
    rawStdout += s;
    opts.onData?.(s);
  });

  return {
    proc,
    waitForExit(): Promise<{ code: number; stdout: string }> {
      return new Promise((resolve) => {
        proc.on("exit", (code) => {
          const cleaned = stripAnsi(rawStdout);
          resolve({ code: code ?? -1, stdout: cleaned });
        });
      });
    },
    send(data: string) {
      proc.stdin?.write(data);
    },
    kill(signal: NodeJS.Signals = "SIGTERM") {
      try {
        proc.kill(signal);
      } catch {
        /* already dead */
      }
    },
  };
}

/**
 * Strip ANSI escape sequences (CSI, OSC, simple C1) and non-printing control
 * bytes. Keeps newlines and tabs so structural assertions still work.
 */
export function stripAnsi(input: string): string {
  return (
    input
      // CSI: ESC [ ... <final>
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences require control chars
      .replace(/\x1b\[[0-9;?]*[@-~]/g, "")
      // OSC: ESC ] ... BEL/ST
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences require control chars
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      // Other ESC sequences
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences require control chars
      .replace(/\x1b[@-_]/g, "")
      // Remaining control characters except \n and \t
      // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately stripping raw control chars
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
  );
}

/**
 * Quote an argument for POSIX `sh -c`. Plain words pass through; anything
 * with metacharacters gets wrapped in single quotes with embedded quotes
 * escaped via the `'\''` idiom.
 */
function shellQuote(arg: string): string {
  if (arg === "") return "''";
  if (/^[a-zA-Z0-9_\-./=,:]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Wrap a string in a Tcl brace-literal `{...}`. Braces make the enclosed
 * text completely opaque to Tcl — no `$var` substitution, no backslash
 * escapes. If the text contains unbalanced braces, fall back to a
 * double-quoted Tcl string with backslash escaping.
 */
function tclBrace(s: string): string {
  // Check for unbalanced braces inside `s`. If balanced, brace-literal is safe.
  let depth = 0;
  let balanced = true;
  for (const ch of s) {
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth < 0) {
        balanced = false;
        break;
      }
    }
  }
  if (balanced && depth === 0) return `{${s}}`;
  // Fallback: double-quote with escaping
  const escaped = s.replace(/[\\$"[\]]/g, (c) => `\\${c}`);
  return `"${escaped}"`;
}

// ─── Magmux Socket Subscriber ────────────────────────────────────────────────

export interface MagmuxEvent {
  type: string;
  [key: string]: unknown;
}

export interface MagmuxSubscription {
  socket: Socket;
  events: MagmuxEvent[];
  onEvent: (fn: (event: MagmuxEvent) => void) => void;
  close(): Promise<void>;
  /** Wait until a predicate is true or timeout (ms) elapses. */
  waitFor(predicate: (events: MagmuxEvent[]) => boolean, timeoutMs: number): Promise<MagmuxEvent[]>;
}

export interface MagmuxSocketBaseline {
  /** Paths of magmux sockets that existed at baseline time. */
  paths: Set<string>;
  /** Wall-clock (ms) when the baseline was captured. Used to filter stale entries. */
  capturedAtMs: number;
}

/**
 * Take a snapshot of all existing magmux sockets so newly-created ones can
 * be discovered by subtraction. Call this before spawning magmux.
 */
export function snapshotMagmuxSockets(): MagmuxSocketBaseline {
  const existing = new Set<string>();
  try {
    for (const entry of readdirSync("/tmp")) {
      if (entry.startsWith("magmux-") && entry.endsWith(".sock")) {
        existing.add(join("/tmp", entry));
      }
    }
  } catch {
    /* ignore */
  }
  return { paths: existing, capturedAtMs: Date.now() };
}

/**
 * Poll /tmp until a new magmux socket appears that (a) was not in
 * `baseline.paths` and (b) was created at or after `baseline.capturedAtMs`.
 * Returns the path of the newest qualifying socket, or null if none appeared
 * within `timeoutMs`. This is necessary because our tests spawn magmux under
 * `expect(1)`, so `ChildProcess.pid` belongs to expect, not magmux.
 */
export async function findNewestMagmuxSocket(
  baseline: MagmuxSocketBaseline,
  timeoutMs = 3_000
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const entries = readdirSync("/tmp")
        .filter((e) => e.startsWith("magmux-") && e.endsWith(".sock"))
        .map((e) => join("/tmp", e))
        .filter((p) => {
          if (baseline.paths.has(p)) return false;
          try {
            return statSync(p).ctimeMs >= baseline.capturedAtMs - 50;
          } catch {
            return false;
          }
        });
      if (entries.length > 0) {
        entries.sort((a, b) => {
          try {
            return statSync(b).ctimeMs - statSync(a).ctimeMs;
          } catch {
            return 0;
          }
        });
        return entries[0];
      }
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

/**
 * Connect to a magmux Unix socket as a subscriber. Accepts either an explicit
 * socket path or a `baseline` of pre-existing sockets — in the latter case the
 * function polls /tmp for a new socket matching `magmux-*.sock` that was not
 * in the baseline. Use the baseline flavor when the parent process is `expect`
 * or any other wrapper, since `ChildProcess.pid` won't match magmux's own PID.
 *
 * Discovery and connect share a single tight retry loop (10ms) so fast panes
 * that exit quickly don't slip past us.
 */
export async function subscribeToMagmuxSocket(
  target: number | string | { baseline: MagmuxSocketBaseline; timeoutMs?: number }
): Promise<MagmuxSubscription> {
  const timeoutMs =
    typeof target === "object" && !Array.isArray(target) ? (target.timeoutMs ?? 5_000) : 5_000;
  const deadline = Date.now() + timeoutMs;
  let socket: Socket | null = null;
  let sockPath = "";

  while (Date.now() < deadline && !socket) {
    // Resolve socket path on every iteration because baseline-mode tests
    // race against fast-exiting panes.
    if (typeof target === "number") {
      sockPath = `/tmp/magmux-${target}.sock`;
    } else if (typeof target === "string") {
      sockPath = target;
    } else {
      const baseline = target.baseline;
      const entries = readdirSync("/tmp")
        .filter((e) => e.startsWith("magmux-") && e.endsWith(".sock"))
        .map((e) => join("/tmp", e))
        .filter((p) => {
          if (baseline.paths.has(p)) return false;
          try {
            return statSync(p).ctimeMs >= baseline.capturedAtMs - 50;
          } catch {
            return false;
          }
        });
      if (entries.length === 0) {
        await new Promise((r) => setTimeout(r, 10));
        continue;
      }
      entries.sort((a, b) => {
        try {
          return statSync(b).ctimeMs - statSync(a).ctimeMs;
        } catch {
          return 0;
        }
      });
      sockPath = entries[0];
    }

    if (existsSync(sockPath)) {
      try {
        socket = await new Promise<Socket>((resolve, reject) => {
          const s = connect(sockPath);
          s.once("connect", () => resolve(s));
          s.once("error", reject);
        });
        break;
      } catch {
        /* socket gone already, retry */
      }
    }
    await new Promise((r) => setTimeout(r, 10));
  }

  if (!socket) {
    throw new Error(
      `Could not connect to any magmux socket within ${timeoutMs}ms${sockPath ? ` (last path: ${sockPath})` : ""}`
    );
  }

  const events: MagmuxEvent[] = [];
  const listeners: Array<(e: MagmuxEvent) => void> = [];

  let buf = "";
  socket.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf-8");
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
      if (!line) continue;
      try {
        const evt = JSON.parse(line) as MagmuxEvent;
        events.push(evt);
        for (const fn of listeners) fn(evt);
      } catch {
        /* ignore malformed */
      }
    }
  });

  return {
    socket,
    events,
    onEvent(fn) {
      listeners.push(fn);
    },
    async close() {
      socket.end();
      await new Promise((r) => setTimeout(r, 20));
      socket.destroy();
    },
    waitFor(predicate, timeoutMs) {
      return new Promise((resolve, reject) => {
        if (predicate(events)) return resolve([...events]);
        const timer = setTimeout(() => {
          const idx = listeners.indexOf(check);
          if (idx >= 0) listeners.splice(idx, 1);
          reject(
            new Error(
              `Timed out after ${timeoutMs}ms waiting for magmux events. ` +
                `Received ${events.length} events so far: [${events.map((e) => e.type).join(", ")}]`
            )
          );
        }, timeoutMs);
        const check = () => {
          if (predicate(events)) {
            clearTimeout(timer);
            const idx = listeners.indexOf(check);
            if (idx >= 0) listeners.splice(idx, 1);
            resolve([...events]);
          }
        };
        listeners.push(check);
      });
    },
  };
}

// ─── Gridfile helpers ────────────────────────────────────────────────────────

/**
 * Write a gridfile (one shell command per line) and return its path. Caller
 * is responsible for cleaning up the parent directory.
 */
export function writeGridfile(lines: string[]): {
  path: string;
  dir: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "e2e-grid-"));
  const path = join(dir, "gridfile.txt");
  const content = `${lines.join("\n")}\n`;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { writeFileSync } = require("node:fs") as typeof import("node:fs");
  writeFileSync(path, content, "utf-8");
  return {
    path,
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}
