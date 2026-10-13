/**
 * Hook output capture, and protocol-stdout isolation for the MCP server.
 *
 * Two layers with different jobs:
 *
 * 1. **The hook scope** (`AsyncLocalStorage`) is for ATTRIBUTION. Every module
 *    import and every handler call runs inside it. While it is active,
 *    `console.*` and `process.stdout`/`stderr.write` go to claudish's debug log,
 *    prefixed `[hook <label>]`, or are dropped when the debug log is off. Calls
 *    outside the scope — all of claudish's own code — are untouched. Timers and
 *    promise continuations a handler schedules inherit the scope.
 *
 *    Measured on Bun 1.4.0: the scope does NOT reach a module's top-level code
 *    during `import()` (module evaluation runs outside the caller's async
 *    context), and stack attribution cannot replace it (JSC's proper tail calls
 *    drop the callback's frame). So an import runs in an IMPORT WINDOW: while it
 *    is in flight, unscoped writes are attributed to the module being imported,
 *    and timers registered during the window are bound to its scope. Imports are
 *    serial, so the window names one module at a time. Anything else claudish
 *    writes inside that window (it is short, and loading is awaited at startup
 *    before any handler exists) lands in the debug log too.
 *
 *    A callback the scope does not reach still runs unscoped: a listener a hook
 *    registers at import and claudish's own I/O emits later (`process.stdin`
 *    `data`, a signal). That is why the scope is never relied on for protocol
 *    safety.
 *
 * 2. **`isolateProtocolStdout()`** is for PROTOCOL SAFETY in `mcp` mode, where
 *    stdout is the JSON-RPC channel. It is the first statement of the MCP entry.
 *    Through `bun:ffi` on libc it takes a private duplicate of descriptor 1 for
 *    the protocol writer and points descriptor 1 at stderr, so every other
 *    route — Bun's native `console.log`, `process.stdout.write`,
 *    `fs.writeSync(1, …)`, `Bun.write(Bun.stdout, …)`, inheriting children —
 *    lands on stderr. On top of that, stdout-bound `console` methods and
 *    `process.stdout.write` are diverted process-wide to the debug log.
 *    Where the libc symbols cannot be bound, it changes nothing and reports
 *    `active: false`; the loader then loads no user module in `mcp` mode.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { Writable } from "node:stream";
import { format, inspect } from "node:util";
import { log } from "../logger.js";

interface ScopeStore {
  label: string;
}

const scope = new AsyncLocalStorage<ScopeStore>();

/** Label of the module whose import is in flight, or null. */
let importLabel: string | null = null;

/** True in `mcp` mode once stdout is isolated: unscoped stdout writes go to the debug log. */
let stdoutDiverted = false;

let installed = false;

/** Where captured text goes. Replaceable for tests. */
let sink: (line: string) => void = (line) => log(line);

/** The label in force for a write made right now, or null when it is claudish's own. */
export function currentHookLabel(): string | null {
  return scope.getStore()?.label ?? importLabel;
}

function emit(label: string, text: string): void {
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
  sink(`[${label}] ${trimmed}`);
}

function chunkToText(chunk: unknown, encoding?: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk).toString(
      typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8"
    );
  }
  return String(chunk);
}

const STDOUT_CONSOLE = ["log", "info", "debug", "dir", "table"] as const;
const STDERR_CONSOLE = ["warn", "error"] as const;
type ConsoleMethod = (typeof STDOUT_CONSOLE)[number] | (typeof STDERR_CONSOLE)[number];

function formatConsole(method: ConsoleMethod, args: unknown[]): string {
  if (method === "dir") return inspect(args[0], (args[1] as object | undefined) ?? {});
  if (method === "table") return inspect(args[0]);
  return format(...args);
}

/**
 * Patch `console.*` and both stream writers once per process. Each replacement
 * checks the scope at call time, so outside a hook (and outside `mcp`
 * diversion) the original runs with the original arguments.
 */
function install(): void {
  if (installed) return;
  installed = true;

  const con = console as unknown as Record<ConsoleMethod, (...a: unknown[]) => void>;
  for (const method of [...STDOUT_CONSOLE, ...STDERR_CONSOLE]) {
    const original = con[method].bind(console);
    const stdoutBound = (STDOUT_CONSOLE as readonly string[]).includes(method);
    con[method] = (...args: unknown[]) => {
      const label = currentHookLabel();
      if (label !== null) return emit(`hook ${label}`, formatConsole(method, args));
      if (stdoutDiverted && stdoutBound) return emit("stdout", formatConsole(method, args));
      return original(...args);
    };
  }

  const patchWrite = (stream: NodeJS.WriteStream, isStdout: boolean) => {
    const original = stream.write.bind(stream) as (...a: unknown[]) => boolean;
    // biome-ignore lint/suspicious/noExplicitAny: Node's overloaded write signature
    (stream as any).write = (chunk: unknown, encoding?: unknown, callback?: unknown): boolean => {
      const label = currentHookLabel();
      const diverted = isStdout && stdoutDiverted;
      if (label === null && !diverted) return original(chunk, encoding, callback);
      emit(label !== null ? `hook ${label}` : "stdout", chunkToText(chunk, encoding));
      const cb = typeof encoding === "function" ? encoding : callback;
      if (typeof cb === "function") queueMicrotask(() => (cb as () => void)());
      return true;
    };
  };
  patchWrite(process.stdout, true);
  patchWrite(process.stderr, false);
}

/**
 * Run `fn` inside a hook's scope. `label` is the effective hook id (`[hook <id>]`
 * in the debug log). Synchronous throws propagate; the caller isolates them.
 */
export function runInHookScope<T>(label: string, fn: () => T): T {
  install();
  return scope.run({ label }, fn);
}

type TimerFn = (cb: (...a: unknown[]) => void, ...rest: unknown[]) => unknown;

/** Bind timer callbacks registered during the window to the module's scope. */
function bindTimers(label: string): () => void {
  const g = globalThis as unknown as Record<string, TimerFn | undefined>;
  const names = ["setTimeout", "setInterval", "setImmediate", "queueMicrotask"] as const;
  const saved = names.map((name) => [name, g[name]] as const);
  for (const [name, original] of saved) {
    if (typeof original !== "function") continue;
    const wrapped: TimerFn = (cb, ...rest) =>
      original(
        typeof cb === "function" ? (...a: unknown[]) => scope.run({ label }, () => cb(...a)) : cb,
        ...rest
      );
    // Keep `setTimeout[util.promisify.custom]` and friends reachable.
    Object.setPrototypeOf(wrapped, original);
    g[name] = wrapped;
  }
  return () => {
    for (const [name, original] of saved) g[name] = original;
  };
}

/**
 * Run a module import inside the import window (see the header). `label` is the
 * configured module path (`[hook <module>]` in the debug log). The window closes
 * when `fn` settles — on a load timeout the caller races `fn` and the window
 * closes at the race, so an import still hanging afterwards runs unscoped.
 */
export async function runImportInScope<T>(label: string, fn: () => Promise<T>): Promise<T> {
  install();
  const previous = importLabel;
  importLabel = label;
  const restoreTimers = bindTimers(label);
  try {
    return await scope.run({ label }, fn);
  } finally {
    restoreTimers();
    importLabel = previous;
  }
}

/* ───────────── protocol stdout (mcp mode) ───────────── */

export interface ProtocolStdout {
  /** false → stdout untouched; mcp mode then loads no user module */
  active: boolean;
  /** the only writer of the real stdout; process.stdout when inactive */
  protocolOut: Writable;
  /** why isolation is inactive */
  reason?: string;
}

export interface LibcBinding {
  dup(fd: number): number;
  dup2(from: number, to: number): number;
}

let isolation: ProtocolStdout | null = null;

/** The isolation result of this process, or null when `isolateProtocolStdout()` never ran. */
export function protocolIsolation(): ProtocolStdout | null {
  return isolation;
}

/** libc through `bun:ffi`. Throws where no binding exists (Windows, unknown libc). */
function bindLibc(): LibcBinding {
  const library =
    process.platform === "darwin"
      ? "libSystem.B.dylib"
      : process.platform === "linux"
        ? "libc.so.6"
        : null;
  if (!library) throw new Error(`no libc binding for platform ${process.platform}`);
  // Required lazily: `bun:ffi` is only needed in mcp mode, and only here.
  const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
  const lib = dlopen(library, {
    dup: { args: [FFIType.i32], returns: FFIType.i32 },
    dup2: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  return {
    dup: (fd) => lib.symbols.dup(fd) as number,
    dup2: (from, to) => lib.symbols.dup2(from, to) as number,
  };
}

/**
 * A `Writable` over a private descriptor. Each frame goes to a Bun `FileSink`,
 * and the write callback fires when its `flush()` settles, so a slow reader
 * applies the caller's `drain` backpressure instead of growing memory.
 */
function protocolWriter(fd: number): Writable {
  const fileSink = Bun.file(fd).writer();
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      try {
        fileSink.write(chunk);
        const flushed = fileSink.flush();
        if (flushed instanceof Promise) {
          flushed.then(
            () => callback(),
            (err: unknown) => callback(err instanceof Error ? err : new Error(String(err)))
          );
        } else {
          callback();
        }
      } catch (err) {
        callback(err instanceof Error ? err : new Error(String(err)));
      }
    },
    final(callback) {
      try {
        const ended = fileSink.end();
        if (ended instanceof Promise) ended.then(() => callback(), callback);
        else callback();
      } catch (err) {
        callback(err instanceof Error ? err : new Error(String(err)));
      }
    },
  });
}

/**
 * Hand descriptor 1 to the MCP protocol writer alone. `mcp` mode only;
 * idempotent. `bind` replaces the libc binding, for tests.
 */
export function isolateProtocolStdout(opts?: { bind?: () => LibcBinding }): ProtocolStdout {
  if (isolation) return isolation;

  const inactive = (reason: string): ProtocolStdout => {
    isolation = { active: false, protocolOut: process.stdout, reason };
    return isolation;
  };

  let libc: LibcBinding;
  try {
    libc = (opts?.bind ?? bindLibc)();
  } catch (err) {
    return inactive(err instanceof Error ? err.message : String(err));
  }

  let privateFd: number;
  try {
    privateFd = libc.dup(1);
    if (privateFd < 0) return inactive("dup(1) failed");
    if (libc.dup2(2, 1) < 0) return inactive("dup2(2, 1) failed");
  } catch (err) {
    return inactive(err instanceof Error ? err.message : String(err));
  }

  install();
  stdoutDiverted = true;
  isolation = { active: true, protocolOut: protocolWriter(privateFd) };
  return isolation;
}

/* ───────────── test seams ───────────── */

/** Redirect captured lines (default: the debug log). Returns the previous sink. */
export function setCaptureSinkForTests(next: (line: string) => void): (line: string) => void {
  const previous = sink;
  sink = next;
  return previous;
}
