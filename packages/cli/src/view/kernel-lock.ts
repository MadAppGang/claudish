/**
 * `flock(2)` locks: the kernel holds one exactly as long as some process holds a descriptor of its
 * open file description, and frees it when the last one closes or dies. No liveness, age or owner
 * rule exists here, so none can be wrong.
 *
 * Only `flock` and the errno read go through `bun:ffi`. `open` is variadic, and Apple arm64 passes
 * variadic arguments on the stack, which an FFI signature cannot; `fs.openSync` opens instead, with
 * `O_CLOEXEC` spelled per platform because `fs.openSync` does not set it, and a spawn elsewhere in
 * this process must not inherit the descriptor.
 *
 * Nothing here blocks the event loop: `waitAcquire` polls a non-blocking `flock`.
 */

import { constants, closeSync, fstatSync, openSync, statSync, unlinkSync } from "node:fs";

const LOCK_EX = 2;
const LOCK_NB = 4;
const EWOULDBLOCK = process.platform === "darwin" ? 35 : 11;
const O_CLOEXEC = process.platform === "darwin" ? 0x01000000 : 0o2000000;
const POLL_MS = 100;

export class KernelLockUnavailable extends Error {}

export interface KernelLock {
  readonly fd: number;
  readonly path: string;
  /** idempotent; the lock is free once every copy of the descriptor is closed */
  close(): void;
}

interface FlockBinding {
  flock(fd: number, op: number): number;
  errno(): number;
}

let binding: FlockBinding | null | undefined;

function bindFlock(): FlockBinding {
  const library =
    process.platform === "darwin"
      ? "libSystem.B.dylib"
      : process.platform === "linux"
        ? "libc.so.6"
        : null;
  if (!library) throw new Error(`no libc binding for platform ${process.platform}`);
  // Required lazily: only a process that takes a lock needs `bun:ffi`.
  const { dlopen, FFIType, read } = require("bun:ffi") as typeof import("bun:ffi");
  const errnoSymbol = process.platform === "darwin" ? "__error" : "__errno_location";
  const lib = dlopen(library, {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    [errnoSymbol]: { args: [], returns: FFIType.ptr },
  });
  const errnoFn = lib.symbols[errnoSymbol] as unknown as () => number | null;
  return {
    flock: (fd, op) => lib.symbols.flock(fd, op) as number,
    errno: () => {
      const p = errnoFn();
      return p ? read.i32(p as never, 0) : -1;
    },
  };
}

function flockBinding(): FlockBinding | null {
  if (binding !== undefined) return binding;
  try {
    binding = bindFlock();
  } catch {
    binding = null;
  }
  return binding;
}

/** False where `flock` cannot be bound (no libc binding); callers then rely on in-process order. */
export function flockAvailable(): boolean {
  return flockBinding() !== null;
}

function lockOf(fd: number, path: string): KernelLock {
  let open = true;
  return {
    fd,
    path,
    close() {
      if (!open) return;
      open = false;
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    },
  };
}

/** The lock, or null when someone else holds it. Throws `KernelLockUnavailable` on any other error. */
export function tryAcquire(path: string): KernelLock | null {
  const lib = flockBinding();
  if (!lib) throw new KernelLockUnavailable("flock is not available in this process");
  for (let attempt = 0; attempt < 5; attempt++) {
    const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | O_CLOEXEC, 0o600);
    if (lib.flock(fd, LOCK_EX | LOCK_NB) !== 0) {
      const errno = lib.errno();
      closeSync(fd);
      if (errno === EWOULDBLOCK) return null;
      throw new KernelLockUnavailable(`flock ${path}: errno ${errno}`);
    }
    // unlinked between our open and our flock: the lock is on a file nobody else can find
    let same = false;
    try {
      same = fstatSync(fd).ino === statSync(path).ino;
    } catch {
      same = false;
    }
    if (same) return lockOf(fd, path);
    closeSync(fd);
  }
  throw new KernelLockUnavailable(`flock ${path}: the file keeps being replaced`);
}

/** Polls `tryAcquire` until `ms` has passed; null when the lock stayed held. */
export async function waitAcquire(path: string, ms: number): Promise<KernelLock | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const lock = tryAcquire(path);
    if (lock) return lock;
    if (Date.now() >= deadline) return null;
    await Bun.sleep(Math.min(POLL_MS, Math.max(1, deadline - Date.now())));
  }
}

/** Removes a lock file nobody holds; a held one is left alone. True when it was removed. */
export function removeIfFree(path: string): boolean {
  let lock: KernelLock | null;
  try {
    lock = tryAcquire(path);
  } catch {
    return false;
  }
  if (!lock) return false;
  try {
    // unlinked while still held, so an acquirer that opened it meanwhile sees the inode change
    unlinkSync(path);
    return true;
  } catch {
    return false;
  } finally {
    lock.close();
  }
}
