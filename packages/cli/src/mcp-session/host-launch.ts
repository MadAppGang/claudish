/**
 * The launch of another process on this machine, read exactly: its argv, each argument one
 * string with every space, quote and newline intact, its current directory, and the
 * {@link HOST_ENV_KEYS} of the environment it was started with: `CLAUDE_CONFIG_DIR`, the plugin
 * variables, the launch mode switches and the cowork plugins switch. No other environment value
 * is kept.
 *
 * `ps -o args=` joins the arguments with spaces, so `--settings "/a b.json"` and two arguments
 * `/a` `b.json` print alike; it is never used here. macOS: `sysctl(KERN_PROCARGS2)` for the
 * argv and `proc_pidinfo(PROC_PIDVNODEPATHINFO)` for the cwd, both through `bun:ffi` on
 * libSystem (neither is variadic); the launch environment follows the argv in the same
 * `KERN_PROCARGS2` buffer. Linux: `/proc/<pid>/cmdline` (NUL-separated; a rewritten process
 * title reads as null, {@link argvOfCmdline}), `/proc/<pid>/environ` and the `/proc/<pid>/cwd`
 * link.
 * Elsewhere, for a pid that is not an integer from 2 to 2^31-1, and for a process that is gone
 * or belongs to another user, the answer is null.
 */

import { readFileSync, readlinkSync } from "node:fs";

import { HOST_READ_ENV_KEYS, type HostReadEnvKey } from "./probe-launch-vars.js";

/**
 * The only launch environment keys read, a fixed list ({@link HOST_READ_ENV_KEYS}): the
 * caller's Claude Code config dir, its plugin variables, its launch mode switches, and the
 * cowork plugins switch, which only refuses a probe.
 */
export const HOST_ENV_KEYS: readonly HostReadEnvKey[] = HOST_READ_ENV_KEYS;

/** What a launch environment says about each {@link HOST_ENV_KEYS} key: its value, or nothing. */
export type HostEnv = Partial<Record<HostReadEnvKey, string>>;

export interface HostLaunch {
  argv: string[];
  cwd: string;
  /**
   * {@link HOST_ENV_KEYS} from the environment the process was started with, or null when that
   * environment cannot be read exactly. A later `setenv` inside the process does not show here.
   */
  env: HostEnv | null;
}

/** A process's launch, or null when it cannot be read exactly. Never throws. */
export type HostLaunchReader = (pid: number) => HostLaunch | null;

const CTL_KERN = 1;
const KERN_ARGMAX = 8;
const KERN_PROCARGS2 = 49;
const PROC_PIDVNODEPATHINFO = 9;
/** `struct vnode_info` (152 bytes) then `vip_path[MAXPATHLEN]`, twice: cwd, then root dir. */
const VNODE_INFO_BYTES = 152;
const MAXPATHLEN = 1024;
const VNODEPATHINFO_BYTES = 2 * (VNODE_INFO_BYTES + MAXPATHLEN);

interface DarwinBinding {
  argmax(): number | null;
  procargs(pid: number, size: number): Buffer | null;
  cwd(pid: number): string | null;
}

let darwinBinding: DarwinBinding | null | undefined;

function bindDarwin(): DarwinBinding {
  // Required lazily: only a process that reads another's launch needs `bun:ffi`.
  const { dlopen, FFIType, ptr } = require("bun:ffi") as typeof import("bun:ffi");
  const lib = dlopen("libSystem.B.dylib", {
    sysctl: {
      args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64],
      returns: FFIType.i32,
    },
    proc_pidinfo: {
      args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
  });
  const sysctl = (name: Int32Array, out: Uint8Array | Int32Array, len: BigUint64Array) =>
    lib.symbols.sysctl(ptr(name), name.length, ptr(out), ptr(len), null, 0n) as number;
  return {
    argmax() {
      const out = new Int32Array(1);
      const len = new BigUint64Array([4n]);
      return sysctl(new Int32Array([CTL_KERN, KERN_ARGMAX]), out, len) === 0
        ? (out[0] as number)
        : null;
    },
    procargs(pid, size) {
      const buf = Buffer.alloc(size);
      const len = new BigUint64Array([BigInt(size)]);
      if (sysctl(new Int32Array([CTL_KERN, KERN_PROCARGS2, pid]), buf, len) !== 0) return null;
      return buf.subarray(0, Number(len[0]));
    },
    cwd(pid) {
      const buf = Buffer.alloc(VNODEPATHINFO_BYTES);
      const got = lib.symbols.proc_pidinfo(
        pid,
        PROC_PIDVNODEPATHINFO,
        0n,
        ptr(buf),
        buf.length
      ) as number;
      if (got !== buf.length) return null;
      return cwdOfVnodePathInfo(buf);
    },
  };
}

/**
 * The cwd in a `proc_vnodepathinfo` buffer: the NUL-ended path in the first `vip_path` field
 * (bytes 152 to 1175). Null for a buffer of another size, an empty path, and a field with no
 * NUL inside it: the byte after the field is the next struct's, so a NUL found there ends no
 * path.
 */
export function cwdOfVnodePathInfo(buf: Buffer): string | null {
  if (buf.length !== VNODEPATHINFO_BYTES) return null;
  const field = buf.subarray(VNODE_INFO_BYTES, VNODE_INFO_BYTES + MAXPATHLEN);
  const end = field.indexOf(0);
  if (end <= 0) return null;
  return field.toString("utf8", 0, end);
}

function darwin(): DarwinBinding | null {
  if (darwinBinding !== undefined) return darwinBinding;
  try {
    darwinBinding = bindDarwin();
  } catch {
    darwinBinding = null;
  }
  return darwinBinding;
}

/** The kernel pads the exec path, its NUL included, to a multiple of the pointer size. */
const EXEC_PATH_ALIGN = 8;

/**
 * The argv in a `KERN_PROCARGS2` buffer: `int argc`, the exec path NUL-padded to a multiple of
 * {@link EXEC_PATH_ALIGN} bytes, then `argc` NUL-terminated arguments (the environment follows,
 * {@link hostEnvOfProcargs}). Measured on this Mac for exec paths of every length mod 8: argv[0] starts at
 * exactly that aligned end. Null for a buffer that ends before `argc` arguments, a byte other
 * than NUL in the padding, and an empty argv[0] (or any extra NUL at the aligned start): a scan
 * that skipped every NUL took that argument for padding, so argv[1] read as argv[0] and the
 * first environment entry as the last argument.
 */
export function argvOfProcargs(buf: Buffer): string[] | null {
  return procargsLayout(buf)?.argv ?? null;
}

/** The argv of a `KERN_PROCARGS2` buffer, and the offset of the byte after its last NUL. */
function procargsLayout(buf: Buffer): { argv: string[]; end: number } | null {
  if (buf.length < 4) return null;
  const argc = buf.readInt32LE(0);
  if (argc < 1) return null;
  const pathEnd = buf.indexOf(0, 4);
  if (pathEnd < 0) return null;
  let i = 4 + Math.ceil((pathEnd - 4 + 1) / EXEC_PATH_ALIGN) * EXEC_PATH_ALIGN;
  if (i >= buf.length || buf[i] === 0) return null;
  for (let pad = pathEnd; pad < i; pad++) if (buf[pad] !== 0) return null;
  const argv: string[] = [];
  for (let k = 0; k < argc; k++) {
    const end = buf.indexOf(0, i);
    if (end < 0) return null;
    argv.push(buf.toString("utf8", i, end));
    i = end + 1;
  }
  return { argv, end: i };
}

/**
 * Each {@link HOST_ENV_KEYS} key among `entries` (`KEY=value` byte strings, in order): the first
 * entry with that key wins, as `getenv` reads; every other entry is compared by its key prefix
 * and dropped. Null when one of those values is not valid UTF-8, since a replacement character
 * would name another folder or another switch value.
 */
function hostEnvOf(entries: readonly Buffer[]): HostEnv | null {
  const env: HostEnv = {};
  for (const key of HOST_ENV_KEYS) {
    const prefix = Buffer.from(`${key}=`);
    const entry = entries.find((e) => e.subarray(0, prefix.length).equals(prefix));
    if (entry === undefined) continue;
    const raw = entry.subarray(prefix.length);
    const value = raw.toString("utf8");
    if (!Buffer.from(value, "utf8").equals(raw)) return null;
    env[key] = value;
  }
  return env;
}

/**
 * {@link HOST_ENV_KEYS} from a `KERN_PROCARGS2` buffer: the NUL-ended `KEY=value` strings right
 * after the argv, up to the first empty string (the kernel's NUL padding before the `apple[]`
 * strings, which are never read). Null when the argv cannot be read ({@link argvOfProcargs}),
 * the environment has no end inside the buffer, or a listed value is not valid UTF-8. Only
 * those keys' values are returned ({@link hostEnvOf}).
 */
export function hostEnvOfProcargs(buf: Buffer): HostEnv | null {
  const layout = procargsLayout(buf);
  if (!layout) return null;
  const entries: Buffer[] = [];
  for (let i = layout.end; ; ) {
    const end = buf.indexOf(0, i);
    if (end < 0) return null;
    if (end === i) break;
    entries.push(buf.subarray(i, end));
    i = end + 1;
  }
  return hostEnvOf(entries);
}

/**
 * {@link HOST_ENV_KEYS} from a Linux `/proc/<pid>/environ` buffer: NUL-separated `KEY=value`
 * entries, NUL-ended. Null for an empty buffer (a process that is exiting reads empty), one with
 * no NUL end, and a listed value that is not valid UTF-8.
 */
export function hostEnvOfEnviron(raw: Buffer): HostEnv | null {
  if (raw.length === 0 || raw[raw.length - 1] !== 0) return null;
  const entries: Buffer[] = [];
  for (let i = 0; i < raw.length; ) {
    const end = raw.indexOf(0, i);
    entries.push(raw.subarray(i, end));
    i = end + 1;
  }
  return hostEnvOf(entries);
}

function readDarwin(pid: number): HostLaunch | null {
  const binding = darwin();
  if (!binding) return null;
  const size = binding.argmax();
  if (size === null || size <= 0) return null;
  const raw = binding.procargs(pid, size);
  const argv = raw ? argvOfProcargs(raw) : null;
  const cwd = binding.cwd(pid);
  if (!raw || !argv || !cwd) return null;
  return { argv, cwd, env: hostEnvOfProcargs(raw) };
}

/**
 * The argv in a Linux `/proc/<pid>/cmdline` buffer: NUL-separated arguments, NUL-ended. Null
 * for an empty buffer, one with no NUL end, and a rewritten process title: arguments after
 * `argv[0]` that are all empty. Claude Code 2.1.332 sets `process.title = "claude"`, and on
 * Linux the title is written over the argv area with NULs after it, so its flags read as empty
 * strings, not as a launch without flags.
 */
export function argvOfCmdline(raw: Buffer): string[] | null {
  if (raw.length === 0 || raw[raw.length - 1] !== 0) return null;
  const argv = raw.toString("utf8", 0, raw.length - 1).split("\0");
  if (argv.length > 1 && argv.slice(1).every((arg) => arg === "")) return null;
  return argv;
}

function readLinux(pid: number): HostLaunch | null {
  try {
    const argv = argvOfCmdline(readFileSync(`/proc/${pid}/cmdline`));
    if (!argv) return null;
    const cwd = readlinkSync(`/proc/${pid}/cwd`);
    let env: HostEnv | null;
    try {
      env = hostEnvOfEnviron(readFileSync(`/proc/${pid}/environ`));
    } catch {
      env = null;
    }
    return { argv, cwd, env };
  } catch {
    return null;
  }
}

/** The largest pid the native calls take: they declare it a signed 32-bit `int`. */
const PID_MAX = 2 ** 31 - 1;

/**
 * {@link HostLaunchReader} for this platform. Only an integer pid from 2 to 2^31-1 is read: a
 * larger one would be truncated to another process's pid by the 32-bit native argument, and
 * pid 1 (launchd, init) is never a caller.
 */
export const readHostLaunch: HostLaunchReader = (pid) => {
  if (!Number.isInteger(pid) || pid <= 1 || pid > PID_MAX) return null;
  try {
    if (process.platform === "darwin") return readDarwin(pid);
    if (process.platform === "linux") return readLinux(pid);
  } catch {
    // an unreadable launch is null
  }
  return null;
};
