/**
 * macOS Keychain secret store — the engine.
 *
 * A dependency-light wrapper over `/usr/bin/security` that stores one generic-
 * password item per API-key env var:
 *
 *   service = "claudish"
 *   account = the env var name          e.g. GEMINI_API_KEY
 *   label   = "claudish: GEMINI_API_KEY"   (findable in Keychain Access.app)
 *   value   = the secret (UTF-8, no control characters — see below)
 *
 * One item per variable rather than a single JSON blob: individually visible,
 * individually deletable, individually ACL'd by macOS. The blob layout would
 * collapse N spawns into one, but `dump-keychain` already collapses the only
 * operation that needed N — enumeration — so the blob buys nothing and costs
 * discoverability.
 *
 * WHY THE `security` CLI AND NOT A NATIVE BINDING
 *
 * A keychain item's ACL is bound to the code signature of the binary that
 * accesses it. `/usr/bin/security` is Apple-signed and its path is stable, so a
 * value written through it reads back through it without a new authorization
 * dialog. A native binding inside a `bun`-compiled executable presents a
 * DIFFERENT identity that changes with every rebuild and every `bun` upgrade —
 * which macOS surfaces as a fresh "claudish wants to access your keychain"
 * prompt each time. The subprocess is the less elegant option and the only one
 * that stays quiet.
 *
 * MEASURED COSTS (darwin 25.6.0; transcripts in
 * ai-docs/reports/keychain-security-cli-measurements.md)
 *
 *   find-generic-password -w   17.4 ms   per call, per variable
 *   dump-keychain (no -d)      28   ms   ONCE, for the entire item list
 *
 * That gap is the whole architecture. A per-variable read cannot sit on a
 * synchronous path — 25 providers would cost ~435 ms against a provider-
 * registration pass that runs in ~1.5-2 ms. Enumeration can: it answers
 * "which variables are stored?" for every provider in a single spawn.
 * `dump-keychain` reads item ATTRIBUTES only and never item DATA, which is why
 * it is prompt-free while a value read is not.
 *
 * WHY SECRETS GO ON STDIN
 *
 * `security add-generic-password -w <secret>` puts the secret in the process's
 * argv, where any other user on the machine can read it out of `ps` for the
 * duration of the call. Writes therefore go through `security -i`, which reads
 * the command itself from stdin, with the value carried as `-X <hex>` so no
 * shell-style quoting of quotes/backslashes/spaces is ever required.
 *
 * The documented alternative — `-w` passed LAST so `security` prompts for the
 * value — was measured and REJECTED: it demands the password twice, a single
 * piped line fails the confirmation, and it then exits 0 having created an item
 * with an EMPTY value. A write path that reports success while storing nothing
 * is worse than no write path at all.
 *
 * WHY CONTROL CHARACTERS ARE REJECTED
 *
 * `find-generic-password -w` prints the value as RAW text for printable data
 * but as a HEX STRING when the data contains control characters, with nothing
 * in the output to distinguish the two — a printable key that happens to be all
 * hex digits is genuinely ambiguous. Rather than guess at read time, values
 * containing control characters are refused at WRITE time, which makes every
 * stored value unambiguous by construction. API keys are single-line printable
 * tokens, so this rejects nothing a user actually has.
 *
 * Every side effect is behind an injectable `KeychainDeps` seam, so the module
 * is fully testable with no real keychain. Same rationale as
 * `auth/antigravity-token.ts`, which reads the SHARED agy/claudish token item
 * and is the existing precedent for talking to `security` from this codebase.
 */

/** Keychain service name for claudish's API-KEY items — one item per env var. */
export const KEYCHAIN_SERVICE = "claudish";

/**
 * Keychain service name for the ACCOUNT POOL's OAuth token blobs.
 *
 * A separate service, and the separation is load-bearing twice over:
 *
 * 1. `hydrateKeychainIntoEnv()` enumerates and reads the `claudish` service and
 *    writes what it finds into `process.env`, where spawned children inherit it.
 *    A refresh token stored under that service would be copied into every child's
 *    environment. Under `claudish-accounts` it can never be.
 * 2. These items are ONE JSON BLOB PER ACCOUNT, where the api-key service is one
 *    item per variable. That is not an inconsistency: a token set (access,
 *    refresh, expiry, generation, fingerprint) is a single atomic unit whose
 *    parts are meaningless apart and must rotate together, whereas env vars are
 *    independently resolvable and independently deletable.
 */
export const KEYCHAIN_ACCOUNTS_SERVICE = "claudish-accounts";

/** Absolute path — `security` must not be resolved through a mutable PATH. */
const SECURITY_BIN = "/usr/bin/security";

/**
 * `security` exit code for "the specified item could not be found".
 *
 * Distinguishing it from a real failure is what lets a miss stay silent while a
 * genuine error (locked keychain, denied ACL, missing binary) still surfaces.
 * Measured, not assumed: both a `find` miss and a `delete` of an absent item
 * exit 44.
 */
const EXIT_ITEM_NOT_FOUND = 44;

/**
 * Burst memo TTL.
 *
 * A process-lifetime cache would be WRONG: the user can edit the keychain in
 * Keychain Access.app, and another claudish process can write it, while this
 * one runs. The goal is collapsing repeated asks inside ONE operation (a TUI
 * render pass, a routing chain walking several candidate providers), not
 * caching across a session. Mirrors `antigravity-token.ts`'s READ_STORE_TTL_MS
 * for the same reason.
 */
const MEMO_TTL_MS = 3000;

/**
 * Hard ceiling on any single `security` invocation.
 *
 * A keychain call that hangs must not hang claudish. The measured cost of every
 * operation here is 17-30 ms, so ten seconds means something is genuinely wrong
 * — most plausibly a LOCKED keychain, where `security` blocks on an unlock
 * dialog that a proxy server or an MCP child has no way to answer. `syncRun`
 * blocks the event loop outright, so without this a locked keychain would
 * freeze the process indefinitely.
 *
 * Verified that `Bun.spawnSync` honours it: a 1s timeout on `sleep 5` returned
 * in 1002ms with `exitCode: null, signal: "SIGTERM"` — which `normalizeResult`
 * reports as a signal kill rather than inventing an exit code.
 *
 * This guard was briefly LOST in the move from `execFileSync` (which carried its
 * own `timeout` option) to `Bun.spawnSync`, which is the kind of thing a
 * mechanical port drops silently.
 */
const SPAWN_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A keychain operation failed for a reason the caller should show the user. */
export class KeychainError extends Error {
  constructor(
    message: string,
    /** `security`'s exit code, when the failure came from the binary. */
    readonly exitCode?: number
  ) {
    super(message);
    this.name = "KeychainError";
  }
}

// ---------------------------------------------------------------------------
// Injectable side-effect seam
// ---------------------------------------------------------------------------

export interface KeychainRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface KeychainDeps {
  /** `process.platform`, injectable so tests can exercise the non-darwin path. */
  platform: () => string;
  /** Run `security` with the given argv; `stdin` is written to its stdin when set. */
  run: (args: string[], stdin?: string) => KeychainRunResult;
  /** Async form, used by the parallel hydration pass. */
  runAsync: (args: string[], stdin?: string) => Promise<KeychainRunResult>;
  /**
   * Start `security` and hand back its completion as a JOINABLE handle, with NO
   * deadline and NO kill path. `done` resolves only when `security` itself
   * exits — never rejects — and `pid` is the child's pid (undefined when the
   * spawn failed). See {@link KeychainSpawn}.
   */
  spawnAsync: (args: string[], stdin?: string) => KeychainSpawn;
}

/**
 * One `security` run that may outlive whoever started it.
 *
 * WHY NO DEADLINE AND NO KILL. A value read of an item another application owns
 * (`find-generic-password -w`) can open the macOS access dialog, and the user
 * may take minutes to answer it. `runAsync`'s `SPAWN_TIMEOUT_MS` would KILL
 * `security` at ten seconds, and a `security` killed mid-transaction is how
 * this codebase once made macOS restart `securityd`, which dropped every
 * running application's keychain session (keychain.md, "NEVER verify against
 * the real login keychain"). Killing it also throws away the user's answer:
 * the dialog stays up, and a click on "Always Allow" lands on a process that is
 * gone.
 *
 * So the handle is the contract. A caller races `done` against ITS OWN
 * deadline and, when the deadline wins, simply stops waiting: `done` stays
 * alive, a late approval still resolves it, and the next caller can JOIN the
 * same `done` instead of spawning a second dialog. `pid` lets a caller record
 * which `security` holds the dialog (a per-machine lock names the child, not
 * the claudish process that may exit first).
 */
export interface KeychainSpawn {
  done: Promise<KeychainRunResult>;
  pid: number | undefined;
}

/**
 * WHY `Bun.spawnSync` AND NOT `execFileSync` — this one is measured, and it is
 * the difference between the write working and the config TUI freezing.
 *
 * Node's `execFileSync(..., { input })` HANGS when the parent's stdin is in raw
 * mode or has an active `data` listener — which is exactly what any TUI does.
 * Measured inside the config TUI: the call blocked for the full timeout and came
 * back `status: null, signal: "SIGTERM", code: "ETIMEDOUT"`, with EMPTY stderr.
 * Because it is synchronous, it froze the whole interface for ten seconds first.
 * The identical code path succeeds from a plain CLI process, so this cannot be
 * caught anywhere except by driving the real TUI.
 *
 * `Bun.spawnSync` with a `Uint8Array` stdin has no such interaction — verified
 * under raw mode WITH a data listener attached: exit 0 in ~30ms, value round-
 * tripped. Bun's native spawn is also what the rest of claudish relies on, and
 * the launcher (`bin/claudish.cjs`) refuses to run under Node at all, so the
 * `Bun` global is guaranteed here.
 *
 * stderr is ALWAYS piped, never inherited. The most common keychain operation —
 * a lookup that misses — writes "SecKeychainSearchCopyNext: The specified item
 * could not be found" to it. Inheriting that would spray one line per provider
 * per resolution pass into a terminal claudish SHARES with the Claude Code TUI,
 * which is how this codebase corrupted its own display once already (see
 * terminal-isolation.ts).
 */
function syncRun(args: string[], stdin?: string): KeychainRunResult {
  try {
    const proc = Bun.spawnSync([SECURITY_BIN, ...args], {
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
      timeout: SPAWN_TIMEOUT_MS,
    });
    return normalizeResult(
      proc.exitCode,
      proc.signalCode,
      decode(proc.stdout),
      decode(proc.stderr)
    );
  } catch (err) {
    // A throw here means the spawn itself failed (binary missing, EPERM) — the
    // message is the only diagnostic there is, so it must not be discarded.
    return { code: 1, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }
}

async function asyncRun(args: string[], stdin?: string): Promise<KeychainRunResult> {
  try {
    const proc = Bun.spawn([SECURITY_BIN, ...args], {
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
      timeout: SPAWN_TIMEOUT_MS,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return normalizeResult(exitCode, proc.signalCode, stdout, stderr);
  } catch (err) {
    return { code: 1, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * {@link KeychainDeps.spawnAsync}: no `timeout` option, no `kill()`, anywhere.
 * stderr piped for the same reason as `syncRun`. A spawn that cannot start
 * resolves `done` with the error, as `asyncRun` reports it.
 */
function spawnAsyncRun(args: string[], stdin?: string): KeychainSpawn {
  try {
    const proc = Bun.spawn([SECURITY_BIN, ...args], {
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    const done = Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]).then(
      ([stdout, stderr, exitCode]) => normalizeResult(exitCode, proc.signalCode, stdout, stderr),
      (err: unknown) => ({
        code: 1,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
      })
    );
    return { done, pid: proc.pid };
  } catch (err) {
    return {
      done: Promise.resolve({
        code: 1,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
      }),
      pid: undefined,
    };
  }
}

function decode(buf: Uint8Array | null | undefined): string {
  return buf ? new TextDecoder().decode(buf) : "";
}

/**
 * Turn a spawn outcome into a result, WITHOUT inventing an exit code.
 *
 * A process killed by a signal reports `exitCode: null`. An earlier version
 * collapsed that to `1` and produced the message "security exited 1" for what
 * was actually a ten-second timeout — a fabricated exit code that sent the
 * investigation in the wrong direction. When there is no real exit code, say so
 * and name the signal instead.
 */
function normalizeResult(
  exitCode: number | null,
  signalCode: string | null | undefined,
  stdout: string,
  stderr: string
): KeychainRunResult {
  if (typeof exitCode === "number") return { code: exitCode, stdout, stderr };
  const detail = signalCode ? `killed by ${signalCode}` : "terminated without an exit code";
  return { code: -1, stdout, stderr: stderr.trim() || `security ${detail}` };
}

const defaultDeps: KeychainDeps = {
  platform: () => process.platform,
  run: syncRun,
  runAsync: asyncRun,
  spawnAsync: spawnAsyncRun,
};

let deps: KeychainDeps = defaultDeps;

/**
 * Replace the side-effect seam. Pass `null` to restore the real one.
 * MANDATORY in tests — otherwise the suite mutates the developer's own keychain.
 */
export function setKeychainTestDeps(next: Partial<KeychainDeps> | null): void {
  deps = next ? { ...defaultDeps, ...next } : defaultDeps;
  invalidateKeychainCache();
}

// ---------------------------------------------------------------------------
// Memo
// ---------------------------------------------------------------------------

let listMemo: { at: number; value: KeychainEnumeration } | null = null;
const valueMemo = new Map<string, { at: number; value: string | null }>();

/** Drop every memo. Call after ANY mutation, and after swapping the deps seam. */
export function invalidateKeychainCache(): void {
  listMemo = null;
  valueMemo.clear();
}

function now(): number {
  return Date.now();
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * C0 controls plus DEL. Deliberately includes tab, newline and carriage return:
 * see the module header — their presence is what flips `-w` from raw output to
 * hex output, and no API key contains them.
 *
 * The `noControlCharactersInRegex` suppression below is intentional and narrow:
 * matching control characters IS this expression's entire purpose, so the rule's
 * usual "you probably meant something else" assumption is inverted here. It must
 * stay a SINGLE line — Biome only attaches a suppression to the statement
 * immediately following it, and continuation lines silently detach it.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the purpose — this guard is what keeps `security -w` reads unambiguous
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/** Conventional env-var spelling. Anything else cannot be an API-key variable. */
const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidKeychainVarName(name: string): boolean {
  return ENV_VAR_NAME.test(name);
}

/**
 * Why a value cannot be stored, or null when it can.
 * Exported so callers can pre-validate a batch (e.g. `keychain import`'s plan)
 * without attempting a write per entry.
 */
export function describeUnstorableValue(value: string): string | null {
  if (value.length === 0) return "value is empty";
  if (CONTROL_CHARS.test(value)) {
    return "value contains control characters (tab/newline/etc), which the keychain read path cannot represent unambiguously";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

/** True when this platform has a macOS keychain claudish can drive. */
export function isKeychainSupported(): boolean {
  return deps.platform() === "darwin";
}

/** The reason keychain is unavailable, or null when it is available. */
export function keychainUnavailableReason(): string | null {
  if (!isKeychainSupported()) {
    return `the macOS Keychain is only available on macOS (this is ${deps.platform()})`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * `security -w` appends exactly one newline to the value.
 *
 * Stripping ONE trailing "\n" rather than calling `.trim()` is deliberate: trim
 * would also eat whitespace that is genuinely part of a stored secret, turning
 * a working key into a subtly broken one that fails with a 401 nobody can
 * explain.
 */
function stripOneTrailingNewline(out: string): string {
  return out.endsWith("\n") ? out.slice(0, -1) : out;
}

/**
 * Target keychain FILE, when `CLAUDISH_KEYCHAIN_FILE` names one.
 *
 * `security` takes an optional trailing keychain path on every subcommand;
 * without one it uses the user's default (login) keychain. Setting this env var
 * redirects every operation in this module to a throwaway keychain instead.
 *
 * WHY THIS EXISTS. End-to-end verification against the REAL login keychain is
 * not safe: during development of this module, hung `security` processes were
 * killed mid-transaction and macOS restarted `securityd`, which drops every
 * running application's authenticated keychain session and produces a storm of
 * re-authorization prompts across the whole machine. Nothing was lost and no
 * ACL was altered, but it disrupted the user's entire desktop.
 *
 * Unit tests use the `KeychainDeps` seam and never spawn anything. But live
 * verification is still worth doing — it is what caught the `execFileSync`
 * raw-mode hang, which no seam-based test could have surfaced — so it needs a
 * safe target rather than care and good intentions. Point this at a keychain
 * created with `security create-keychain` and the blast radius is that file.
 *
 * Read at CALL time, not captured at module load, so a test can set it after
 * import.
 */
function keychainFileArgs(): string[] {
  const file = process.env.CLAUDISH_KEYCHAIN_FILE;
  return file ? [file] : [];
}

function findArgs(account: string, service: string = KEYCHAIN_SERVICE): string[] {
  return ["find-generic-password", "-s", service, "-a", account, "-w", ...keychainFileArgs()];
}

/** Memo key. Two services can hold the same account name and mean different things. */
function memoKey(service: string, account: string): string {
  return `${service} ${account}`;
}

/** Interpret a `find-generic-password -w` result. Throws on a real failure. */
function interpretRead(envVar: string, res: KeychainRunResult): string | null {
  if (res.code === 0) {
    const value = stripOneTrailingNewline(res.stdout);
    return value.length > 0 ? value : null;
  }
  if (res.code === EXIT_ITEM_NOT_FOUND) return null;
  throw new KeychainError(
    `Keychain lookup for ${envVar} failed: ${res.stderr.trim() || `security exited ${res.code}`}`,
    res.code
  );
}

/**
 * The stored secret for `envVar`, or null when absent.
 *
 * SYNCHRONOUS and ~17 ms. Never call this once per provider on a render or
 * registration path — use {@link listKeychainVars} for presence, which answers
 * for every provider in one spawn.
 */
export function readKeychainSecret(envVar: string): string | null {
  return readKeychainItem(KEYCHAIN_SERVICE, envVar);
}

/** Async twin of {@link readKeychainSecret}, for parallel batch hydration. */
export async function readKeychainSecretAsync(envVar: string): Promise<string | null> {
  return readKeychainItemAsync(KEYCHAIN_SERVICE, envVar);
}

/** Options shared by the generalized `(service, account)` read paths. */
export interface KeychainReadOptions {
  /**
   * Bypass the 3 s burst memo — and do not populate it either.
   *
   * MANDATORY on the token-refresh path. The memo exists to collapse a burst
   * inside one operation; on a refresh it would hand back the PRE-ROTATION token
   * for up to three seconds after another process rotated it, and exchanging a
   * revoked refresh token is `invalid_grant` and a logged-out account. Reads for
   * DISPLAY may use the memo freely.
   */
  uncached?: boolean;
}

/**
 * Read one item under an explicit service. Throws on a real failure; returns
 * null only for a CONFIRMED absence (exit 44).
 *
 * That distinction is the whole contract: a caller that cannot tell "the
 * keychain is locked" from "nothing is stored" will treat a locked store as an
 * unconfigured one.
 */
export function readKeychainItem(
  service: string,
  account: string,
  opts: KeychainReadOptions = {}
): string | null {
  if (!isKeychainSupported()) return null;
  const key = memoKey(service, account);
  const at = now();
  if (!opts.uncached) {
    const cached = valueMemo.get(key);
    if (cached && at - cached.at < MEMO_TTL_MS) return cached.value;
  }
  const value = interpretRead(account, deps.run(findArgs(account, service)));
  // Memoize the MISS too: "not stored" is the answer that repeats hardest, and
  // it costs a full failed spawn every time. An uncached read populates nothing,
  // so it cannot install a value a later uncached read is then asked to trust.
  if (!opts.uncached) valueMemo.set(key, { at, value });
  return value;
}

/** Async twin of {@link readKeychainItem}. */
export async function readKeychainItemAsync(
  service: string,
  account: string,
  opts: KeychainReadOptions = {}
): Promise<string | null> {
  if (!isKeychainSupported()) return null;
  const key = memoKey(service, account);
  const at = now();
  if (!opts.uncached) {
    const cached = valueMemo.get(key);
    if (cached && at - cached.at < MEMO_TTL_MS) return cached.value;
  }
  const value = interpretRead(account, await deps.runAsync(findArgs(account, service)));
  if (!opts.uncached) valueMemo.set(key, { at, value });
  return value;
}

// ---------------------------------------------------------------------------
// Another application's generic-password item (joinable, no kill path)
// ---------------------------------------------------------------------------

/** Which generic-password item, in which keychain file. */
export interface GenericPasswordQuery {
  service: string;
  account?: string;
  /**
   * A keychain FILE to search instead of the default search list. Absent:
   * `CLAUDISH_KEYCHAIN_FILE` when set, else the user's default keychains.
   */
  keychainFile?: string;
}

/** The outcome of one item lookup. `failed` is never collapsed into `absent`. */
export type GenericPasswordResult =
  | { kind: "found"; value?: string }
  | { kind: "absent" }
  | { kind: "failed"; code: number; error: string };

function genericPasswordArgs(query: GenericPasswordQuery, withValue: boolean): string[] {
  return [
    "find-generic-password",
    "-s",
    query.service,
    ...(query.account !== undefined ? ["-a", query.account] : []),
    ...(withValue ? ["-w"] : []),
    ...(query.keychainFile !== undefined ? [query.keychainFile] : keychainFileArgs()),
  ];
}

function interpretGenericPassword(
  res: KeychainRunResult,
  withValue: boolean
): GenericPasswordResult {
  if (res.code === 0) {
    if (!withValue) return { kind: "found" };
    const value = stripOneTrailingNewline(res.stdout);
    return value.length > 0 ? { kind: "found", value } : { kind: "absent" };
  }
  if (res.code === EXIT_ITEM_NOT_FOUND) return { kind: "absent" };
  return {
    kind: "failed",
    code: res.code,
    error: res.stderr.trim() || `security exited ${res.code}`,
  };
}

/**
 * Whether an item exists, from its ATTRIBUTES only: `find-generic-password`
 * without `-w` reads no item data, so it opens no access dialog. Async, and
 * through {@link KeychainDeps.spawnAsync}, so nothing ever kills it; it is
 * never on a render path. stdout (the attribute dump) is discarded here.
 */
export async function findGenericPasswordPresence(
  query: GenericPasswordQuery
): Promise<GenericPasswordResult> {
  if (!isKeychainSupported()) return { kind: "absent" };
  const res = await deps.spawnAsync(genericPasswordArgs(query, false)).done;
  return interpretGenericPassword(res, false);
}

/**
 * Start a VALUE read of an item (`find-generic-password -w`). This may open the
 * macOS access dialog for an item another application owns, so it returns the
 * joinable handle rather than a promise with a deadline: the caller races
 * `done` against its own deadline, never kills `security`, and a later caller
 * may join the same `done` (see {@link KeychainSpawn}). The value is never
 * memoized here; the caller decides what to keep.
 */
export function startGenericPasswordRead(query: GenericPasswordQuery): {
  done: Promise<GenericPasswordResult>;
  pid: number | undefined;
} {
  if (!isKeychainSupported()) {
    return { done: Promise.resolve({ kind: "absent" }), pid: undefined };
  }
  const spawn = deps.spawnAsync(genericPasswordArgs(query, true));
  return { done: spawn.done.then((res) => interpretGenericPassword(res, true)), pid: spawn.pid };
}

// ---------------------------------------------------------------------------
// Enumerate
// ---------------------------------------------------------------------------

/**
 * `dump-keychain` renders a blob attribute either as `="text"` or, when the
 * bytes are not printable ASCII, as `=0x48656C6C6F  "Hello"`. Both forms end in
 * the quoted rendering, so one pattern covers them.
 */
const ACCT_ATTR = /"acct"<blob>=(?:0x[0-9A-Fa-f]*\s+)?"([^"]*)"/;

/** Exact service match — `="claudish"` must not also match `="claudish-foo"`. */
const SVCE_MATCH = `"svce"<blob>="${KEYCHAIN_SERVICE}"`;

/**
 * The result of an enumeration attempt.
 *
 * `failed` is the whole point of this type. An earlier version collapsed a
 * failed `dump-keychain` into an empty array, which is a LIE with consequences
 * that compound: a locked store reads as "nothing stored", so the credential
 * source reports a clean absence rather than a transient failure, so the
 * authority caches the miss for the process lifetime, so predefined endpoints
 * silently vanish — and, worst of all, `keychain import` builds its
 * overwrite plan from that false-empty set and reports every existing key as
 * `new`, then overwrites it with `-U` without ever showing the warning that
 * exists precisely to prevent an unrecoverable replacement.
 *
 * "I could not ask" and "there is nothing there" must never be the same value.
 */
export interface KeychainEnumeration {
  /** Stored env var names, sorted. Empty when `failed` is true. */
  names: string[];
  /** True when the keychain could not be enumerated (locked, denied, no binary). */
  failed: boolean;
  /** Diagnostic for the failure. Never contains key material. */
  error?: string;
}

/**
 * Every env var name claudish has stored in the keychain, plus whether the
 * question could be answered at all.
 *
 * ONE spawn (~28 ms) for the whole list, memoized for the burst. This is the
 * function that makes a synchronous presence check affordable, and it is the
 * reason no mirror of these names is kept in `config.json`: a second copy of a
 * list is a second thing that can be wrong, and this list is cheap enough to
 * read from the store that owns it.
 *
 * Attributes only — `dump-keychain` is invoked WITHOUT `-d`, so it never reads
 * item DATA and never triggers a per-item access dialog.
 *
 * Does not throw: a failure is DATA here, because the callers are render paths
 * and a provider-registration pass that must not die over a diagnostic. The
 * memo caches the failure too — deliberately, since a locked keychain stays
 * locked and re-spawning per provider would achieve nothing — but only for the
 * 3-second burst window, so it re-tries as soon as the burst ends.
 */
export function enumerateKeychainVars(): KeychainEnumeration {
  if (!isKeychainSupported()) return { names: [], failed: false };
  const at = now();
  if (listMemo && at - listMemo.at < MEMO_TTL_MS) return listMemo.value;

  const res = deps.run(["dump-keychain", ...keychainFileArgs()]);
  const value: KeychainEnumeration =
    res.code === 0
      ? { names: parseDumpAccounts(res.stdout), failed: false }
      : {
          names: [],
          failed: true,
          error: res.stderr.trim() || `security exited ${res.code}`,
        };
  listMemo = { at, value };
  return value;
}

/**
 * Stored env var names, sorted — the names ONLY.
 *
 * Callers that can act differently on "could not enumerate" must use
 * {@link enumerateKeychainVars} instead; this convenience wrapper cannot
 * distinguish an empty store from an unreachable one.
 */
export function listKeychainVars(): string[] {
  return enumerateKeychainVars().names;
}

/** Exported for tests: parse `dump-keychain` output into claudish's accounts. */
export function parseDumpAccounts(dump: string): string[] {
  const found = new Set<string>();
  for (const block of dump.split(/\nkeychain: /)) {
    if (!block.includes(SVCE_MATCH)) continue;
    const m = block.match(ACCT_ATTR);
    if (m?.[1] && isValidKeychainVarName(m[1])) found.add(m[1]);
  }
  return Array.from(found).sort();
}

/** True when `envVar` has a stored keychain value. One spawn for ALL providers. */
export function keychainHasVar(envVar: string): boolean {
  return lookupKeychainVar(envVar).present;
}

/**
 * Presence for `envVar`, carrying whether the store could be consulted at all.
 *
 * `{present: false, failed: true}` means "unknown", NOT "absent" — the caller
 * decides what to do with that. Collapsing the two is what turned a locked
 * keychain into a silent, cached "no credential here" for the whole process.
 */
export function lookupKeychainVar(envVar: string): { present: boolean; failed: boolean } {
  if (!isKeychainSupported()) return { present: false, failed: false };
  // Prefer a memoized VALUE when one is already present: after a write or a
  // resolve, the value memo is the fresher of the two, and consulting it avoids
  // a dump for a question that has already been answered exactly. It also
  // answers correctly while enumeration is failing.
  const cached = valueMemo.get(memoKey(KEYCHAIN_SERVICE, envVar));
  if (cached && now() - cached.at < MEMO_TTL_MS && cached.value !== null) {
    return { present: true, failed: false };
  }
  const listed = enumerateKeychainVars();
  return { present: listed.names.includes(envVar), failed: listed.failed };
}

// ---------------------------------------------------------------------------
// Write / delete
// ---------------------------------------------------------------------------

function toHex(value: string): string {
  return Buffer.from(value, "utf8").toString("hex");
}

/**
 * Quote one argument for `security -i`, which parses its stdin line with
 * shell-like tokenization.
 *
 * Unquoted values SPLIT ON WHITESPACE — which silently turned the item label
 * ("claudish: GEMINI_API_KEY") and the comment ("Stored by claudish") into
 * stray positional tokens and made every write fail with a usage dump. Values
 * are quoted uniformly rather than only where a space is expected today,
 * because "this particular string can't contain a space" is the kind of
 * assumption that stops being true one refactor later.
 *
 * The secret itself travels as hex and needs none of this; it is quoted anyway
 * so no argument is a special case.
 */
function quoteForStdin(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Store (or replace) `envVar`'s secret.
 *
 * The command goes over stdin so the secret never reaches argv; `-X` carries it
 * as hex so no quoting is needed; `-U` upserts (without it, a second write to
 * the same account fails with -25299); `-T /usr/bin/security` pins the ACL to
 * the same Apple-signed binary every read uses, which is what keeps subsequent
 * reads dialog-free.
 *
 * The write is VERIFIED by reading the value back. macOS imposes its own limits
 * on item data, and rather than hard-code a size ceiling this cannot verify,
 * the round-trip proves the store actually holds what the user was told it
 * holds. ~17 ms extra on an operation that happens once per key.
 */
export function writeKeychainSecret(envVar: string, value: string): void {
  // Order preserved from before the `(service, account)` generalization: the
  // platform check comes first, so a non-macOS user is told the backend is
  // unavailable rather than that their variable name is wrong.
  const unsupported = keychainUnavailableReason();
  if (unsupported) throw new KeychainError(`Cannot write ${envVar}: ${unsupported}`);
  if (!isValidKeychainVarName(envVar)) {
    throw new KeychainError(`Cannot write "${envVar}": not a valid environment variable name`);
  }
  writeKeychainItem(KEYCHAIN_SERVICE, envVar, value);
}

/**
 * An account name for a non-env-var item: anything printable without the
 * characters `security -i`'s shell-like tokenizer would have to interpret.
 *
 * The api-key path's `ENV_VAR_NAME` cannot be reused here — account ids match
 * `^[a-z0-9]{12}$` and may legitimately start with a digit, which that pattern
 * rejects.
 */
const KEYCHAIN_ACCOUNT_NAME = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

/** Store (or replace) a value under an explicit service. See {@link writeKeychainSecret}. */
export function writeKeychainItem(service: string, account: string, value: string): void {
  const unsupported = keychainUnavailableReason();
  if (unsupported) throw new KeychainError(`Cannot write ${account}: ${unsupported}`);
  if (!KEYCHAIN_ACCOUNT_NAME.test(account)) {
    throw new KeychainError(`Cannot write "${account}": not a valid keychain account name`);
  }
  const unstorable = describeUnstorableValue(value);
  if (unstorable) throw new KeychainError(`Cannot store ${account}: ${unstorable}`);

  // Invalidate BEFORE the write, so a throwing `security` still leaves the memo
  // dropped rather than serving a value the store may or may not still hold.
  invalidateKeychainCache();

  const cmd = [
    "add-generic-password",
    "-s",
    quoteForStdin(service),
    "-a",
    quoteForStdin(account),
    "-l",
    quoteForStdin(`${service}: ${account}`),
    "-D",
    quoteForStdin("application password"),
    "-j",
    quoteForStdin("Stored by claudish"),
    "-X",
    quoteForStdin(toHex(value)),
    "-U",
    "-T",
    quoteForStdin(SECURITY_BIN),
    // Trailing keychain path, when one is targeted. Must come LAST — `security`
    // treats the final positional argument as the keychain to operate on.
    ...keychainFileArgs().map(quoteForStdin),
  ].join(" ");

  const res = deps.run(["-i"], `${cmd}\n`);
  if (res.code !== 0) {
    throw new KeychainError(
      `Failed to store ${account} in the keychain: ${res.stderr.trim() || `security exited ${res.code}`}`,
      res.code
    );
  }

  invalidateKeychainCache();
  // Read back UNCACHED: the memo was just dropped, but an uncached read also
  // states the intent — this is a verification, not a lookup.
  const readBack = readKeychainItem(service, account, { uncached: true });
  if (readBack !== value) {
    throw new KeychainError(
      `Keychain write for ${account} did not round-trip — the stored value differs from what was written. ` +
        "The item may exceed the keychain's size limit; nothing should be assumed saved."
    );
  }
}

/**
 * Remove `envVar` from the keychain. Returns true when an item was deleted,
 * false when there was nothing there. Idempotent by design — "remove this key"
 * succeeding on an already-absent key is the behaviour every caller wants.
 */
export function deleteKeychainSecret(envVar: string): boolean {
  return deleteKeychainItem(KEYCHAIN_SERVICE, envVar);
}

/** Remove one item under an explicit service. See {@link deleteKeychainSecret}. */
export function deleteKeychainItem(service: string, account: string): boolean {
  if (!isKeychainSupported()) return false;
  invalidateKeychainCache();
  const res = deps.run([
    "delete-generic-password",
    "-s",
    service,
    "-a",
    account,
    ...keychainFileArgs(),
  ]);
  invalidateKeychainCache();
  if (res.code === 0) return true;
  if (res.code === EXIT_ITEM_NOT_FOUND) return false;
  throw new KeychainError(
    `Failed to delete ${account} from the keychain: ${res.stderr.trim() || `security exited ${res.code}`}`,
    res.code
  );
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/**
 * Last-4 identification tail, the "••••1234" pattern the 1Password tab already
 * uses so a user can confirm WHICH credential is wired up. Never returns more
 * than four characters of the secret, and returns none at all for a value short
 * enough that four characters would be most of it.
 */
export function valueTail(value: string): string {
  if (value.length <= 6) return "••••";
  return `••••${value.slice(-4)}`;
}
