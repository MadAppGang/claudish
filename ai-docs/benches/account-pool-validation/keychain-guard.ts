/**
 * Safety wrapper for row V2e, the only row that touches the macOS keychain.
 *
 * Design: V2e uses the user's own default (login) keychain through claudish's native path. The
 * bench creates no keychain, changes no search list, default keychain, lock state or keychain
 * setting, and never sets the variable that redirects the product to another keychain file. An
 * earlier design (a throwaway keychain added to the per-user search list) changed state every
 * running program shares and stacked macOS password dialogs until the Mac froze; nothing in this
 * file can do that again:
 *
 *   1. an allowlist: the bench may run only `find-generic-password` and `delete-generic-password`,
 *      each in one exact shape (`-s <service> -a <account>`, plus `-w` on a read), and only on the
 *      ONE fake item `claudish-accounts / openai-codex:aaaaaaaaaaaa`. Anything else throws before
 *      a process is spawned (`assertSecurityCall`);
 *   2. the item is written only by the product's own writer (`KeychainTokenStore.write` in a child,
 *      i.e. `writeKeychainItem`: `security -i add-generic-password ... -U -T /usr/bin/security`
 *      into the default keychain). The bench itself never writes an item;
 *   3. preflight: one attribute-only read (no `-w`). Absent (exit 44) proceeds; a leftover item
 *      refuses the run and names `--recover-keychain`; anything else refuses;
 *   4. every bench call has a 15 s hard timeout. The FIRST timeout trips the guard: from then on
 *      every bench call except the single cleanup delete throws without spawning, every
 *      registered producer is killed, and the row ends as ERROR (`tripMessage()`). A timeout most
 *      likely means a macOS dialog is waiting; a second call would stack a second one;
 *   5. cleanup (finally, SIGINT, SIGTERM, exit) first kills EVERY producer (the seed child and
 *      both serve trees, registered by `registerProducer` at spawn, before any of them can reach
 *      the keychain) and waits until each is confirmed gone; only then runs exactly one
 *      `delete-generic-password -s -a` of the fake item, only when this run seeded it (or, for
 *      `--recover-keychain`, a recovery record says so). Exit 44 means already gone. A producer
 *      that is not confirmed gone keeps the recovery file and the lock, so the next run refuses.
 *      The recovery file (0600) holds only {service, account, pid, startedAt};
 *   6. one exclusive lock (O_EXCL, owner pid, 5 minute stale timeout) keeps two bench runs apart,
 *      and the row has a 90 s deadline after which the cleanup still runs;
 *   7. the product's own keychain calls (inside serve) are not bench calls and cannot be bounded
 *      by item 4. A watch polls `ps` every 500 ms and trips the guard when a `security` process
 *      under any producer has run 5 s (`SERVE_SECURITY_LIMIT_MS`). 5 s, not 15 s: the product
 *      kills its own call at 10 s (`SPAWN_TIMEOUT_MS`, providers/keychain.ts), so a 15 s limit
 *      would never fire. Gaps (review round 6): a call shorter than one poll can be missed; the
 *      other serve can start its own call before the watch trips, so a second dialog is possible;
 *      whether killing `security` closes its dialog is unmeasured. The code kills the call and
 *      makes no further call; it does NOT bound the number of dialogs to one.
 *
 * Every `security` call goes through an injected runner, so every part of this module is
 * unit-tested with a fake runner and never runs `security` itself.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { describeSecret } from "./cred-shape-scan.ts";
import { type Producer, killTree, treeProducer } from "./direct.ts";

export const SECURITY_BIN = "/usr/bin/security";
/** Hard bound on every `security` call, the cleanup delete included. */
export const SECURITY_TIMEOUT_MS = 15_000;
/** Overall bound of the V2e row; the cleanup still runs after it. */
export const ROW_DEADLINE_MS = 90_000;
/** A lock older than this is taken over, whatever its owner. */
export const LOCK_STALE_MS = 5 * 60_000;

export const RECOVERY_FILE = join(tmpdir(), "account-pool-validation-keychain-recovery.json");
export const LOCK_FILE = join(tmpdir(), "account-pool-validation-keychain.lock");
export const RECOVERY_COMMAND =
  "bun ai-docs/benches/account-pool-validation/run-row.ts --recover-keychain";

/** The ONE item the bench may read or delete (the fake account ID.A). */
export const BENCH_SERVICE = "claudish-accounts";
export const BENCH_ACCOUNT = "openai-codex:aaaaaaaaaaaa";
export const MANUAL_DELETE_COMMAND = `security delete-generic-password -s ${BENCH_SERVICE} -a ${BENCH_ACCOUNT}`;

/** The row's ERROR text after the first timed-out keychain call. */
export const TRIPPED_MESSAGE =
  "a keychain call waited 15 s, most likely on a macOS dialog; V2e stopped after one attempt";

/** `security` exit code for "the specified item could not be found". */
export const EXIT_ITEM_NOT_FOUND = 44;

/** The only `security` subcommands the bench may run. */
export const ALLOWED_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "find-generic-password",
  "delete-generic-password",
]);

/**
 * Never run by the bench, whatever the arguments: each one changes keychain state that every
 * running program shares, or writes an item outside the product's own writer. Documentation and
 * test input only; the allowlist above is what enforces it.
 */
export const BANNED_SUBCOMMANDS: readonly string[] = [
  "create-keychain",
  "delete-keychain",
  "list-keychains",
  "default-keychain",
  "unlock-keychain",
  "lock-keychain",
  "set-keychain-settings",
  "show-keychain-info",
  "set-generic-password-partition-list",
  "add-generic-password",
];

/**
 * Child environment names V2e must never set: the first redirects the product away from the
 * default keychain (the design this file replaced).
 */
export const BANNED_CHILD_ENV: readonly string[] = ["CLAUDISH_KEYCHAIN_FILE"];

export interface SecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}
/** Runs `security <args>` with a hard timeout. The only way this module reaches `security`. */
export type SecurityRunner = (args: string[], timeoutMs: number) => Promise<SecResult>;

/** Real runner: the process tree is killed when the timeout fires. */
export function makeSecurityRunner(bin: string = SECURITY_BIN): SecurityRunner {
  return async (args, timeoutMs) => {
    const child = Bun.spawn([bin, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: { PATH: "/usr/bin:/bin", HOME: userInfo().homedir },
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid, "SIGKILL");
    }, timeoutMs);
    let fence: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<SecResult>((resolve) => {
      // Belt: even if a pipe stays open after the kill, the call returns.
      fence = setTimeout(
        () => resolve({ code: null, stdout: "", stderr: "no exit after kill", timedOut: true }),
        timeoutMs + 2_000
      );
    });
    try {
      const done = (async (): Promise<SecResult> => {
        const [stdout, stderr] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        const code = await child.exited;
        return { code: timedOut ? null : code, stdout, stderr, timedOut };
      })();
      return await Promise.race([done, bound]);
    } finally {
      clearTimeout(timer);
      if (fence) clearTimeout(fence);
    }
  };
}

/** Last-resort synchronous runner for the 'exit' handler (no process tree: `security` forks none). */
export type SyncSecurityRunner = (args: string[], timeoutMs: number) => SecResult;
export function makeSyncSecurityRunner(bin: string = SECURITY_BIN): SyncSecurityRunner {
  return (args, timeoutMs) => {
    const p = Bun.spawnSync([bin, ...args], {
      stdin: "ignore",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      env: { PATH: "/usr/bin:/bin", HOME: userInfo().homedir },
    });
    const timedOut = (p as { exitedDueToTimeout?: boolean }).exitedDueToTimeout === true;
    return {
      code: timedOut ? null : p.exitCode,
      stdout: p.stdout.toString(),
      stderr: p.stderr.toString(),
      timedOut,
    };
  };
}

export class GuardRefusal extends Error {}
/** The first timed-out keychain call: the row stops (rule: one attempt, then nothing). */
export class KeychainTimeoutError extends GuardRefusal {
  constructor(message: string = TRIPPED_MESSAGE) {
    super(message);
  }
}
export class CleanupError extends Error {}
export class DeadlineError extends Error {}
export class LockHeldError extends GuardRefusal {}

/** One `security` call the guard made: arguments masked, never a value. */
export interface CallLogEntry {
  n: number;
  cmd: string;
  code: number | null;
  ms: number;
  timedOut: boolean;
}

/**
 * Runs a child command (not `security`) with a hard timeout; the tree is killed on timeout.
 * `onSpawn` is called synchronously the moment the child exists, before any await, so the
 * guard holds it as a producer before it can touch the keychain.
 */
export type ChildRunner = (
  cmd: string[],
  opts: {
    env: Record<string, string>;
    cwd: string;
    timeoutMs: number;
    onSpawn?: (p: Producer) => void;
  }
) => Promise<SecResult>;

export function makeChildRunner(): ChildRunner {
  return async (cmd, { env, cwd, timeoutMs, onSpawn }) => {
    const child = Bun.spawn(cmd, { env, cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    onSpawn?.(treeProducer("seed child", child.pid, child.exited));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid, "SIGKILL");
    }, timeoutMs);
    let fence: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<SecResult>((resolve) => {
      fence = setTimeout(
        () => resolve({ code: null, stdout: "", stderr: "no exit after kill", timedOut: true }),
        timeoutMs + 2_000
      );
    });
    try {
      const done = (async (): Promise<SecResult> => {
        const [stdout, stderr] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        const code = await child.exited;
        return { code: timedOut ? null : code, stdout, stderr, timedOut };
      })();
      return await Promise.race([done, bound]);
    } finally {
      clearTimeout(timer);
      if (fence) clearTimeout(fence);
    }
  };
}

// ---------------------------------------------------------------------------
// Call guards

/** Only the bench's one fake item: any other service or account throws. */
export function assertFakeItem(service: string, account: string): void {
  if (service !== BENCH_SERVICE || account !== BENCH_ACCOUNT)
    throw new GuardRefusal(`refusing: ${service}/${account} is not the bench's fake item`);
}

/**
 * The allowlist, checked before any spawn. Accepted shapes, and nothing else:
 *   find-generic-password -s <service> -a <account>        (attribute-only preflight)
 *   find-generic-password -s <service> -a <account> -w     (value read)
 *   delete-generic-password -s <service> -a <account>
 * No keychain path argument: every call targets the default keychain, as the product does.
 */
export function assertSecurityCall(args: readonly string[]): void {
  const sub = args[0] ?? "";
  if (!ALLOWED_SUBCOMMANDS.has(sub))
    throw new GuardRefusal(
      `refusing: security ${sub || "(no subcommand)"} is not allowed; the bench may run only ${[...ALLOWED_SUBCOMMANDS].join(" and ")}`
    );
  const tail = args.slice(5);
  const shapeOk =
    args[1] === "-s" &&
    args[3] === "-a" &&
    (tail.length === 0 ||
      (sub === "find-generic-password" && tail.length === 1 && tail[0] === "-w"));
  if (!shapeOk)
    throw new GuardRefusal(
      `refusing: security ${sub} must be exactly "-s <service> -a <account>"${sub === "find-generic-password" ? " [-w]" : ""}, got: ${args.slice(1).join(" ")}`
    );
  assertFakeItem(args[2] ?? "", args[4] ?? "");
}

/** A child environment that would redirect the product away from the default keychain throws. */
export function assertChildEnv(env: Record<string, string | undefined>): void {
  for (const name of BANNED_CHILD_ENV)
    if (name in env) throw new GuardRefusal(`refusing: V2e never sets ${name}`);
}

/** The exact argument vectors the bench uses. */
export const presenceArgs = () => [
  "find-generic-password",
  "-s",
  BENCH_SERVICE,
  "-a",
  BENCH_ACCOUNT,
];
export const readArgs = () => [...presenceArgs(), "-w"];
export const deleteArgs = () => [
  "delete-generic-password",
  "-s",
  BENCH_SERVICE,
  "-a",
  BENCH_ACCOUNT,
];

/** Never echo a value: anything after `-w` that is not a flag is masked. */
export function redact(args: string[]): string {
  return args.map((a, i) => (args[i - 1] === "-w" && !a.startsWith("-") ? "<value>" : a)).join(" ");
}

// ---------------------------------------------------------------------------
// Value decoding

/**
 * What `security find-generic-password -w` printed, as text: one trailing newline removed, and an
 * even-length hex string that decodes to valid UTF-8 JSON is decoded (the tool hex-encodes values
 * with non-printable bytes). Plain output is returned unchanged.
 */
export function decodeSecurityOutput(stdout: string): string {
  const text = stdout.replace(/\n$/, "");
  if (text.length > 0 && text.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(text)) {
    try {
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(text, "hex"));
      JSON.parse(decoded);
      return decoded;
    } catch {
      /* not hex-encoded JSON: keep the text */
    }
  }
  return text;
}

/**
 * A description of a value that is not JSON: kind, length and a sha256 prefix. No character
 * of the value (review round 6: 60 raw characters could hold a real token's head).
 */
export function describeUnparsable(raw: string): string {
  const hex = raw.length > 0 && /^[0-9a-fA-F]+$/.test(raw);
  return `${hex ? "hex" : "text"} value, length ${raw.length} (${describeSecret(raw)})`;
}

/** The fake account the V2e config may name; no other account may be in it. */
export const BENCH_ACCOUNT_ID = "aaaaaaaaaaaa";

/**
 * The row's config (`CLAUDISH_CONFIG`) must name ONLY the fake account: V2e runs claudish
 * with the real HOME, and an account the bench did not create would sign with a real
 * credential (run 14). Throws GuardRefusal otherwise, before any process starts.
 */
export function assertFakeOnlyConfig(text: string): void {
  let cfg: { subscriptionAccounts?: Record<string, { accounts?: Array<{ id?: unknown }> }> };
  try {
    cfg = JSON.parse(text);
  } catch {
    throw new GuardRefusal("refusing: the V2e config is not JSON");
  }
  const sections = cfg.subscriptionAccounts ?? {};
  const ids: string[] = [];
  for (const [provider, section] of Object.entries(sections))
    for (const a of section?.accounts ?? []) ids.push(`${provider}:${String(a?.id)}`);
  if (ids.length !== 1 || ids[0] !== `openai-codex:${BENCH_ACCOUNT_ID}`)
    throw new GuardRefusal(
      `refusing: the V2e config must list only openai-codex:${BENCH_ACCOUNT_ID}, it lists [${ids.join(", ")}]`
    );
}

// ---------------------------------------------------------------------------
// Security watch: `security` processes the PRODUCT starts inside a producer

/**
 * A `security` process under a producer alive this long trips the guard. NOT 15 s: the
 * product kills its own `security` call at 10 s (`SPAWN_TIMEOUT_MS`, providers/keychain.ts),
 * so a 15 s threshold would never fire. A normal keychain call returns well under a second.
 */
export const SERVE_SECURITY_LIMIT_MS = 5_000;
export const WATCH_INTERVAL_MS = 500;

export interface ProcRow {
  pid: number;
  ppid: number;
  elapsedMs: number;
  command: string;
}
export type ProcLister = () => ProcRow[];

/** `ps` elapsed time `[[dd-]hh:]mm:ss` in ms; NaN when unreadable. */
export function parseEtime(text: string): number {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (!m) return Number.NaN;
  const [, d = "0", h = "0", min = "0", s = "0"] = m;
  return (((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(s)) * 1000;
}

/** Rows of `ps -axo pid=,ppid=,etime=,comm=` (the command may hold spaces). */
export function parsePsRows(text: string): ProcRow[] {
  const out: ProcRow[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const elapsedMs = parseEtime(m[3] as string);
    if (Number.isNaN(elapsedMs)) continue;
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), elapsedMs, command: m[4] as string });
  }
  return out;
}

export const psLister: ProcLister = () =>
  parsePsRows(Bun.spawnSync(["ps", "-axo", "pid=,ppid=,etime=,comm="]).stdout.toString());

/**
 * The first `security` process under any of `roots` that has run `limitMs` or longer, with
 * the root it was found under.
 */
export function longSecurityCall(
  rows: ProcRow[],
  roots: number[],
  limitMs: number
): (ProcRow & { root: number }) | null {
  const children = new Map<number, ProcRow[]>();
  for (const r of rows) children.set(r.ppid, [...(children.get(r.ppid) ?? []), r]);
  for (const root of roots) {
    const queue = [root];
    const seen = new Set<number>();
    while (queue.length) {
      const pid = queue.shift() as number;
      if (seen.has(pid)) continue;
      seen.add(pid);
      for (const c of children.get(pid) ?? []) {
        if (basename(c.command) === "security" && c.elapsedMs >= limitMs) return { ...c, root };
        queue.push(c.pid);
      }
    }
  }
  return null;
}

export interface WatchOptions {
  list: ProcLister;
  intervalMs?: number;
  limitMs?: number;
}

/** How long cleanup waits for one producer tree to be confirmed gone. */
export const PRODUCER_STOP_TIMEOUT_MS = 10_000;

const okResult = (r: SecResult) => r.code === 0 && !r.timedOut;
const deleted = (r: SecResult) => !r.timedOut && (r.code === 0 || r.code === EXIT_ITEM_NOT_FOUND);

// ---------------------------------------------------------------------------
// Lock

export interface LockOptions {
  pid?: number;
  now?: () => number;
  isAlive?: (pid: number) => boolean;
  staleMs?: number;
}

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** O_EXCL lock file with the owner pid. Returns the release function; fails fast when held. */
export function takeLock(path: string, opts: LockOptions = {}): () => void {
  const pid = opts.pid ?? process.pid;
  const now = opts.now ?? Date.now;
  const alive = opts.isAlive ?? pidAlive;
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const create = () => {
    const fd = openSync(path, "wx", 0o600);
    try {
      writeSync(fd, JSON.stringify({ pid, at: now() }));
    } finally {
      closeSync(fd);
    }
  };
  try {
    create();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    let owner: { pid?: number; at?: number } = {};
    try {
      owner = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      /* unreadable lock: treated as stale below */
    }
    const age = now() - (owner.at ?? 0);
    const live = typeof owner.pid === "number" && alive(owner.pid);
    if (live && age < staleMs)
      throw new LockHeldError(
        `another bench run holds ${path} (pid ${owner.pid}, ${Math.round(age / 1000)} s old); not touching the keychain`
      );
    unlinkSync(path); // dead owner or older than the stale timeout: take over
    try {
      create();
    } catch (again) {
      if ((again as NodeJS.ErrnoException).code === "EEXIST")
        throw new LockHeldError(`lost the race for ${path}; not touching the keychain`);
      throw again;
    }
  }
  return () => {
    try {
      const owner = JSON.parse(readFileSync(path, "utf8")) as { pid?: number };
      if (owner.pid === pid) unlinkSync(path);
    } catch {
      /* already gone */
    }
  };
}

// ---------------------------------------------------------------------------
// Recovery record

export interface RecoveryRecord {
  service: string;
  account: string;
  pid: number;
  startedAt: string;
}

const manualText = (recoveryFile: string) =>
  `Recover with: ${RECOVERY_COMMAND}   (recovery file ${recoveryFile}). By hand: ${MANUAL_DELETE_COMMAND}`;

/**
 * `run-row.ts --recover-keychain`: one `delete-generic-password` of the bench's fake item (the only
 * item a recovery record can name), then the recovery file is removed. Exit 44 means the item was
 * already gone. Runs whether or not a recovery file exists, so a leftover item found by the
 * preflight can be removed. Takes the lock: fails fast while a run is in progress.
 */
export async function recoverKeychain(
  run: SecurityRunner,
  opts: { recoveryFile?: string; lockFile?: string; timeoutMs?: number; lock?: LockOptions } = {}
): Promise<string> {
  const recoveryFile = opts.recoveryFile ?? RECOVERY_FILE;
  const release = takeLock(opts.lockFile ?? LOCK_FILE, opts.lock);
  try {
    if (existsSync(recoveryFile)) {
      let rec: Partial<RecoveryRecord> = {};
      try {
        rec = JSON.parse(readFileSync(recoveryFile, "utf8"));
      } catch {
        /* unreadable: the item is fixed anyway */
      }
      // A record naming anything else is not ours: refuse rather than delete it.
      if (rec.service !== undefined || rec.account !== undefined)
        assertFakeItem(String(rec.service), String(rec.account));
    }
    const args = deleteArgs();
    assertSecurityCall(args);
    const r = await run(args, opts.timeoutMs ?? SECURITY_TIMEOUT_MS);
    if (!deleted(r))
      throw new CleanupError(
        `deleting the bench item ${r.timedOut ? "timed out (a macOS dialog may be waiting; do not retry until it is gone)" : `failed (exit ${r.code})`}. ${manualText(recoveryFile)}`
      );
    if (existsSync(recoveryFile)) unlinkSync(recoveryFile);
    return r.code === EXIT_ITEM_NOT_FOUND
      ? `the bench item ${BENCH_SERVICE}/${BENCH_ACCOUNT} was already gone; removed any recovery file`
      : `deleted the bench item ${BENCH_SERVICE}/${BENCH_ACCOUNT}; removed any recovery file`;
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// The guard

export interface GuardOptions {
  run: SecurityRunner;
  /** Where `keychain-state.json` is written (the evidence directory). */
  stateDir?: string;
  recoveryFile?: string;
  lockFile?: string;
  timeoutMs?: number;
  lock?: LockOptions;
  /** Used only by the 'exit' handler, which cannot await. */
  runSync?: SyncSecurityRunner;
  /** Runs the product-writer child (`seedViaProduct`); default spawns `bun`. */
  runChild?: ChildRunner;
  /** The script that handles `--keychain-seed-child`; default `seed.ts` next to this file. */
  childScript?: string;
  /** Signal registry; default `process`. */
  proc?: Pick<NodeJS.Process, "on" | "off">;
  exit?: (code: number) => void;
  /**
   * Watch every producer's tree for a `security` process the PRODUCT started that runs
   * `limitMs` (a macOS dialog most likely): it trips the guard. Off when absent; the V2e
   * plan's default guard turns it on with `psLister`.
   */
  watch?: WatchOptions;
  /** Per producer, how long cleanup waits for its tree to be confirmed gone. */
  producerStopTimeoutMs?: number;
}

export class KeychainGuard {
  private readonly o: GuardOptions;
  private releaseLock: (() => void) | null = null;
  /** Set once the product writer has been started in this run (it may have written). */
  private seeded = false;
  private tripped = false;
  private tripText = TRIPPED_MESSAGE;
  /** After cleanup no call except the cleanup delete may run. */
  private closed = false;
  private cleanupDeleteUsed = false;
  /** Set when doCleanup has finished (the delete, if any, has returned). */
  private cleanupDone = false;
  private cleaning: Promise<void> | null = null;
  private handlers: Array<[string, () => void]> = [];
  private tripListeners: Array<() => void> = [];
  private readonly calls: CallLogEntry[] = [];
  /** Producers not yet confirmed gone, in registration order. */
  private live: Producer[] = [];
  private watchTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: GuardOptions) {
    this.o = opts;
  }

  /** Why the guard tripped (the row's ERROR text). */
  tripMessage(): string {
    return this.tripText;
  }

  /**
   * Hold `p` until cleanup has killed it and confirmed it gone. Call it the moment the
   * process exists (`onSpawn`). A producer that appears after the guard closed or tripped is
   * killed at once; one that appears after the cleanup delete also rewrites the recovery
   * record, because the item may exist again.
   */
  registerProducer(p: Producer): void {
    this.live.push(p);
    if (this.closed || this.tripped) {
      try {
        p.kill();
      } catch {
        /* a dead process is the goal */
      }
    }
    if (this.cleanupDone) {
      this.calls.push({
        n: this.calls.length + 1,
        cmd: `${p.name} pid ${p.pid} started after the cleanup delete: killed at once, recovery file kept`,
        code: null,
        ms: 0,
        timedOut: false,
      });
      if (this.seeded) this.writeRecovery();
      return;
    }
    if (!this.closed && !this.tripped) this.startWatch();
  }

  private startWatch(): void {
    const w = this.o.watch;
    if (!w || this.watchTimer) return;
    const limitMs = w.limitMs ?? SERVE_SECURITY_LIMIT_MS;
    this.watchTimer = setInterval(() => {
      if (this.tripped || this.closed) return this.stopWatch();
      let hit: ReturnType<typeof longSecurityCall> = null;
      try {
        hit = longSecurityCall(
          w.list(),
          this.live.map((p) => p.pid),
          limitMs
        );
      } catch {
        return; // an unreadable process list proves nothing; the next tick tries again
      }
      if (!hit) return;
      const root = hit.root;
      const owner = this.live.find((p) => p.pid === root)?.name ?? "producer";
      const text = `a security process (pid ${hit.pid}) under the V2e ${owner} ran ${Math.round(hit.elapsedMs / 1000)} s, most likely on a macOS dialog; V2e killed every producer and makes no further keychain call except the cleanup delete`;
      this.calls.push({
        n: this.calls.length + 1,
        cmd: `watch: security pid ${hit.pid} under a producer`,
        code: null,
        ms: hit.elapsedMs,
        timedOut: true,
      });
      this.trip(text);
    }, w.intervalMs ?? WATCH_INTERVAL_MS);
    (this.watchTimer as { unref?: () => void }).unref?.();
  }

  private stopWatch(): void {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
  }

  /**
   * Kill every producer, then wait until each is confirmed gone (producers registered while
   * this runs are included). True when every one was confirmed.
   */
  private async stopProducers(): Promise<boolean> {
    const timeoutMs = this.o.producerStopTimeoutMs ?? PRODUCER_STOP_TIMEOUT_MS;
    let allGone = true;
    while (this.live.length) {
      const batch = this.live.splice(0);
      for (const p of batch) {
        try {
          p.kill();
        } catch {
          /* confirmGone decides */
        }
      }
      const gone = await Promise.all(batch.map((p) => p.confirmGone(timeoutMs).catch(() => false)));
      gone.forEach((ok, i) => {
        if (ok) return;
        allGone = false;
        const p = batch[i] as Producer;
        this.calls.push({
          n: this.calls.length + 1,
          cmd: `${p.name} pid ${p.pid} not confirmed gone after ${timeoutMs} ms`,
          code: null,
          ms: timeoutMs,
          timedOut: true,
        });
      });
    }
    return allGone;
  }

  /** The `security` calls (and the product-writer child) made so far, in order, masked. */
  callLog(): CallLogEntry[] {
    return this.calls.map((c) => ({ ...c }));
  }

  isTripped(): boolean {
    return this.tripped;
  }

  /** `fn` runs once when the guard trips (at once if it already has): kills the serve processes. */
  onTrip(fn: () => void): void {
    if (this.tripped) fn();
    else this.tripListeners.push(fn);
  }

  /** Throws when the row must stop: tripped, or already cleaned up. */
  assertRunnable(): void {
    if (this.tripped) throw new KeychainTimeoutError(this.tripText);
    if (this.closed) throw new GuardRefusal("the V2e guard is closed: no further keychain work");
  }

  private get timeoutMs() {
    return this.o.timeoutMs ?? SECURITY_TIMEOUT_MS;
  }
  private get recoveryFile() {
    return this.o.recoveryFile ?? RECOVERY_FILE;
  }

  /** First trip wins: listeners fire, every producer is killed, the watch stops. */
  private trip(text: string = TRIPPED_MESSAGE): void {
    if (this.tripped) return;
    this.tripped = true;
    this.tripText = text;
    this.stopWatch();
    for (const fn of this.tripListeners.splice(0)) {
      try {
        fn();
      } catch {
        /* a dead process is the goal */
      }
    }
    for (const p of this.live) {
      try {
        p.kill();
      } catch {
        /* cleanup confirms */
      }
    }
  }

  /**
   * The chokepoint. Allowlist first (throws before spawning); then a tripped or closed guard
   * refuses everything except the ONE cleanup delete; a timeout trips the guard.
   */
  private async call(args: string[], kind: "work" | "cleanup" = "work"): Promise<SecResult> {
    assertSecurityCall(args);
    if (kind === "cleanup") {
      if (args[0] !== "delete-generic-password" || this.cleanupDeleteUsed)
        throw new GuardRefusal("refusing: only one cleanup delete per run");
      this.cleanupDeleteUsed = true;
    } else {
      this.assertRunnable();
    }
    const entry: CallLogEntry = {
      n: this.calls.length + 1,
      cmd: `security ${redact(args)}`,
      code: null,
      ms: 0,
      timedOut: false,
    };
    this.calls.push(entry);
    const t0 = Date.now();
    try {
      const r = await this.o.run(args, this.timeoutMs);
      entry.code = r.code;
      entry.timedOut = r.timedOut;
      if (r.timedOut) this.trip();
      return r;
    } finally {
      entry.ms = Date.now() - t0;
    }
  }

  /**
   * Take the lock, refuse after a crashed run, then the preflight: one attribute-only read of the
   * fake item. Absent (44) proceeds; present refuses (never deleted automatically); anything else
   * refuses. Changes nothing.
   */
  async acquire(): Promise<void> {
    this.releaseLock = takeLock(this.o.lockFile ?? LOCK_FILE, this.o.lock);
    try {
      if (existsSync(this.recoveryFile))
        throw new GuardRefusal(
          `an earlier run left ${this.recoveryFile}: the bench item may still exist. Run: ${RECOVERY_COMMAND}`
        );
      this.installHandlers();
      const r = await this.call(presenceArgs());
      if (r.timedOut) throw new KeychainTimeoutError();
      if (r.code === 0)
        throw new GuardRefusal(
          "a leftover bench item exists; run `--recover-keychain` to delete it"
        );
      if (r.code !== EXIT_ITEM_NOT_FOUND)
        throw new GuardRefusal(
          `the preflight read of the bench item failed (exit ${r.code}): not seeding`
        );
    } catch (err) {
      this.removeHandlers();
      this.releaseLock?.();
      this.releaseLock = null;
      throw err;
    }
  }

  /**
   * Create the seed item with the PRODUCT's own writer: a `bun` child runs
   * `KeychainTokenStore.write` (seed.ts `--keychain-seed-child`), i.e. `writeKeychainItem` into
   * the default keychain. The child's environment is a whitelist without any keychain redirect;
   * the item and the token values are checked to be the fake ones first. The recovery record is
   * written BEFORE the child starts, so a crash mid-write still leaves a cleanup trail.
   */
  async seedViaProduct(item: {
    id: string;
    label: string;
    recordJson: string;
    home: string;
    accountsDir: string;
    cwd: string;
    /** The row's own config (`CLAUDISH_CONFIG`): must list only the fake account. */
    configPath: string;
  }): Promise<void> {
    assertFakeItem(BENCH_SERVICE, `openai-codex:${item.id}`);
    this.assertRunnable();
    if (!this.releaseLock) throw new GuardRefusal("acquire() has not run its preflight");
    let configText: string;
    try {
      configText = readFileSync(item.configPath, "utf8");
    } catch {
      throw new GuardRefusal(`refusing: the V2e config ${item.configPath} is not readable`);
    }
    assertFakeOnlyConfig(configText);
    let record: { accessToken?: unknown; refreshToken?: unknown };
    try {
      record = JSON.parse(item.recordJson);
    } catch {
      throw new GuardRefusal("the seed record is not JSON");
    }
    if (
      typeof record.accessToken !== "string" ||
      !record.accessToken.startsWith("access-") ||
      typeof record.refreshToken !== "string" ||
      !record.refreshToken.startsWith("refresh-")
    )
      throw new GuardRefusal("refusing to seed: the tokens are not the bench's fake ones");
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: item.home,
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      LANG: "en_US.UTF-8",
      CLAUDISH_ACCOUNTS_DIR: item.accountsDir,
      // The real HOME must never mean the real config: the row's config names only the fake.
      CLAUDISH_CONFIG: item.configPath,
      CLAUDISH_DISABLE_KEYCHAIN: "0",
    };
    assertChildEnv(env);

    this.writeRecovery();

    const spec = join(item.cwd, "keychain-seed-spec.json");
    writeFileSync(
      spec,
      JSON.stringify({ ref: { provider: "openai-codex", id: item.id, label: item.label }, record }),
      { mode: 0o600 }
    );
    const script = this.o.childScript ?? join(import.meta.dir, "seed.ts");
    const entry: CallLogEntry = {
      n: this.calls.length + 1,
      cmd: "bun seed.ts --keychain-seed-child (KeychainTokenStore.write into the default keychain)",
      code: null,
      ms: 0,
      timedOut: false,
    };
    this.calls.push(entry);
    this.seeded = true; // from here the item may exist: cleanup deletes it
    const t0 = Date.now();
    try {
      const r = await (this.o.runChild ?? makeChildRunner())(
        ["bun", script, "--keychain-seed-child", spec],
        {
          env,
          cwd: item.cwd,
          timeoutMs: this.timeoutMs,
          onSpawn: (p) => this.registerProducer(p),
        }
      );
      entry.code = r.code;
      entry.timedOut = r.timedOut;
      if (r.timedOut) {
        this.trip();
        throw new KeychainTimeoutError(this.tripText);
      }
      // Closed while the child ran (deadline, signal): its result is not ours to act on.
      this.assertRunnable();
      if (!okResult(r))
        throw new GuardRefusal(
          `seeding through the product writer failed (exit ${r.code}): ${(r.stderr || r.stdout).slice(-300)}`
        );
    } finally {
      entry.ms = Date.now() - t0;
      try {
        unlinkSync(spec);
      } catch {
        /* already gone */
      }
    }
  }

  /** The fake item's value from the default keychain (`find-generic-password -s -a -w`). */
  async readItem(): Promise<string | null> {
    const r = await this.call(readArgs());
    if (r.timedOut) throw new KeychainTimeoutError();
    if (r.code === EXIT_ITEM_NOT_FOUND) return null;
    if (!okResult(r)) throw new GuardRefusal(`reading the fake item failed (exit ${r.code})`);
    return decodeSecurityOutput(r.stdout);
  }

  /**
   * Idempotent. In order: close the guard; kill EVERY producer (seed child, serve trees) and
   * wait until each is confirmed gone; then exactly one `delete-generic-password -s -a` of the
   * fake item, only when this run started the product writer. The recovery file is removed
   * only when the delete succeeded (or exit 44) AND every producer was confirmed gone; the
   * lock is released only when every producer was confirmed gone. Otherwise CleanupError.
   */
  cleanup(): Promise<void> {
    if (!this.cleaning) this.cleaning = this.doCleanup();
    return this.cleaning;
  }

  private async doCleanup(): Promise<void> {
    this.closed = true;
    this.removeHandlers();
    this.stopWatch();
    let allGone = false;
    try {
      // A producer still alive after the delete could write the item again.
      allGone = await this.stopProducers();
      let deletedNow = false;
      if (this.seeded && !this.cleanupDeleteUsed) {
        const r = await this.call(deleteArgs(), "cleanup");
        if (!deleted(r))
          throw new CleanupError(
            `cleanup delete of the bench item ${r.timedOut ? "timed out" : `failed (exit ${r.code})`}. ${manualText(this.recoveryFile)}`
          );
        deletedNow = true;
      }
      if (!allGone)
        throw new CleanupError(
          `a process that may write the bench item was not confirmed gone, so the item may exist again; the recovery file and the lock are kept. ${manualText(this.recoveryFile)}`
        );
      if (deletedNow) this.removeRecoveryFile();
    } finally {
      this.cleanupDone = true;
      if (allGone) {
        this.releaseLock?.();
        this.releaseLock = null;
      }
    }
  }

  /** The recovery record (0600), written BEFORE anything can create the item. */
  private writeRecovery(): void {
    const rec: RecoveryRecord = {
      service: BENCH_SERVICE,
      account: BENCH_ACCOUNT,
      pid: this.o.lock?.pid ?? process.pid,
      startedAt: new Date().toISOString(),
    };
    const text = JSON.stringify(rec, null, 2);
    mkdirSync(dirname(this.recoveryFile), { recursive: true });
    writeFileSync(this.recoveryFile, text, { mode: 0o600 });
    chmodSync(this.recoveryFile, 0o600);
    if (this.o.stateDir)
      writeFileSync(join(this.o.stateDir, "keychain-state.json"), text, { mode: 0o600 });
  }

  private removeRecoveryFile(): void {
    try {
      unlinkSync(this.recoveryFile);
    } catch {
      /* already gone */
    }
  }

  /** Run `body` under an overall deadline; the cleanup runs afterwards in every case. */
  async runWithDeadline<T>(body: () => Promise<T>, deadlineMs = ROW_DEADLINE_MS): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new DeadlineError(`V2e exceeded its ${deadlineMs} ms deadline`)),
        deadlineMs
      );
    });
    const work = body();
    work.catch(() => {}); // a body that loses the race must not become an unhandled rejection
    try {
      return await Promise.race([work, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
      await this.cleanup();
    }
  }

  /**
   * Best-effort synchronous cleanup for the 'exit' event: every producer killed and confirmed
   * gone (bounded), then the same single delete. Recovery file and lock as in `cleanup`.
   */
  cleanupSync(): void {
    this.closed = true;
    this.stopWatch();
    const timeoutMs = this.o.producerStopTimeoutMs ?? PRODUCER_STOP_TIMEOUT_MS;
    const producers = this.live.splice(0);
    for (const p of producers) {
      try {
        p.kill();
      } catch {
        /* confirmed below */
      }
    }
    let allGone = true;
    for (const p of producers) {
      let gone = false;
      try {
        gone = p.confirmGoneSync(timeoutMs);
      } catch {
        gone = false;
      }
      allGone &&= gone;
    }
    if (this.seeded && !this.cleanupDeleteUsed) {
      const args = deleteArgs();
      assertSecurityCall(args);
      this.cleanupDeleteUsed = true;
      const r = (this.o.runSync ?? makeSyncSecurityRunner())(args, this.timeoutMs);
      this.calls.push({
        n: this.calls.length + 1,
        cmd: `security ${redact(args)} (exit handler)`,
        code: r.code,
        ms: 0,
        timedOut: r.timedOut,
      });
      if (deleted(r) && allGone) this.removeRecoveryFile();
    }
    this.cleanupDone = true;
    if (allGone) {
      this.releaseLock?.();
      this.releaseLock = null;
    }
  }

  private installHandlers(): void {
    if (this.handlers.length) return;
    const proc = this.o.proc ?? process;
    const exit = this.o.exit ?? ((code: number) => process.exit(code));
    const viaSignal = (code: number) => () => {
      void this.cleanup().then(
        () => exit(code),
        (err) => {
          console.error(String(err));
          exit(code);
        }
      );
    };
    // 'exit' cannot await, so it cleans up synchronously (bounded); the signal handlers and the
    // finally block are the primary paths.
    this.handlers = [
      ["SIGINT", viaSignal(130)],
      ["SIGTERM", viaSignal(143)],
      ["exit", () => this.cleanupSync()],
    ];
    for (const [ev, fn] of this.handlers) proc.on(ev as "exit", fn);
  }

  private removeHandlers(): void {
    const proc = this.o.proc ?? process;
    for (const [ev, fn] of this.handlers) proc.off(ev as "exit", fn);
    this.handlers = [];
  }
}
