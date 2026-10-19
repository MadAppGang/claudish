/**
 * The Muse Code credential core: which `dca:` login signs, the minted `LLM|` key,
 * the entitlement it was confirmed with, and how both are renewed.
 *
 * ## Sources, in order (architecture §4.3)
 *
 * 1. claudish's own login, `~/.claudish/meta-muse-oauth.json`.
 * 2. claudish's borrowed copy of the Muse Code CLI's login,
 *    `~/.claudish/meta-muse-borrowed.json`.
 * 3. The Muse Code CLI's Keychain item — only when the caller may prompt AND the
 *    process's credential prompt role is not `never` (`prompt-role.ts`). A
 *    confirmed mint from it writes the borrowed copy, so the next process,
 *    including a `team` slot that may never prompt, needs no Keychain at all.
 *
 * Each source's `dca:` token is MINTED (`muse-mint.ts`), and only a mint that
 * confirmed the subscription installs state. A mint that rejects the login
 * (401/403) moves to the next source; a network or transient failure is
 * rethrown unchanged — it never falls to another source and never falls back
 * to an unconfirmed key. Each source switch is logged with the tier name, so a
 * silent account switch between the own login and a borrowed one is visible.
 *
 * ## Renewal
 *
 * - Entitlement TTL: re-mint before the next request once the confirmation is
 *   older than 30 minutes (a rule, not a vendor value). It bounds a lapse of the
 *   subscription in `claudish serve` and in long sessions to 30 minutes of SUB
 *   labelling.
 * - A 401 from `/v1/responses` → {@link forceRefreshMuseApiKey}: the rejected
 *   key is marked dead and the token re-minted (single-flight), unless the key
 *   in use is already a different one (a stale failure).
 *
 * Every artifact carries `arm: "oauth"`; there is no api-key half. Nothing here
 * writes the Muse Code CLI's own Keychain item.
 */

import { homedir } from "node:os";
import { credentialPromptRole } from "../../auth/credentials/prompt-role.js";
import { log } from "../../logger.js";
import {
  MUSE_KEYCHAIN_READ_DEADLINE_MS,
  museKeychainPresence,
  museKeychainPresenceCached,
  resetMuseKeychainState,
  withMuseKeychainLogin,
} from "./muse-keychain.js";
import { MuseLoginExpiredError, type MuseMint, mintMuseApiKey } from "./muse-mint.js";
import {
  defaultMuseStoreDir,
  museStorePath,
  readMuseStore,
  writeBorrowedCopy,
} from "./muse-store.js";

/** Re-mint once the entitlement confirmation is older than this. */
export const MUSE_ENTITLEMENT_TTL_MS = 30 * 60_000;

export type MuseSource = "claudish-login" | "borrowed-copy" | "keychain";

export interface MuseState {
  source: MuseSource;
  accessToken: string;
  key: string;
  confirmedAt: number;
  subsTierName?: string;
  /** Bumped on every install, so a caller can tell a re-mint happened. */
  generation: number;
}

/** A terminal Muse Code credential failure with a message that names its fix. */
export class MuseCredentialError extends Error {
  readonly terminal = true;
  /**
   * The status Meta answered when this error stands for a rejected login
   * (401/403 from the mint). `classifyAuthFailure` carries it into the terminal
   * 400 as `error.upstream_status`, so `extractUpstreamStatus` (and `--probe`)
   * recover the real status instead of reading a plain 400.
   */
  readonly upstreamStatus?: number;
  constructor(message: string, upstreamStatus?: number) {
    super(message);
    this.name = "MuseCredentialError";
    if (upstreamStatus !== undefined) this.upstreamStatus = upstreamStatus;
  }
}

export const MUSE_NO_LOGIN_MESSAGE =
  "muse@ needs a Muse Code login: run `claudish login muse` (or, in an interactive terminal, `muse login` and allow Keychain access).";
export const MUSE_NON_INTERACTIVE_MESSAGE =
  "muse@ in a team slot / MCP session needs a claudish login: run `claudish login muse`, or one interactive `claudish --model muse@<model>` and allow Keychain access.";

/**
 * A login file EXISTS and Meta rejected its token (mint 401/403): a different
 * fact from a missing file, so it is not worded for any process role. The
 * file is kept; only a new login fixes it.
 */
export function museLoginRejectedMessage(status: number): string {
  return `Meta rejected the Muse Code login (HTTP ${status}): it has expired or been revoked. Run \`claudish login muse\`, or one interactive \`claudish --model muse@<model>\` and allow Keychain access.`;
}

/** Injectable side effects, so the core is testable with no network and no Keychain. */
export interface MuseCoreDeps {
  mint: (accessToken: string) => Promise<MuseMint>;
  readStore: typeof readMuseStore;
  writeBorrowedCopy: typeof writeBorrowedCopy;
  keychainLogin: typeof withMuseKeychainLogin;
  now: () => number;
  dir: () => string;
}

const defaultDeps: MuseCoreDeps = {
  mint: (token) => mintMuseApiKey(token),
  readStore: readMuseStore,
  writeBorrowedCopy,
  keychainLogin: withMuseKeychainLogin,
  now: () => Date.now(),
  dir: defaultMuseStoreDir,
};

let deps: MuseCoreDeps = defaultDeps;
let state: MuseState | undefined;
let generation = 0;
const deadKeys = new Set<string>();
let inFlightResolve: Promise<MuseState> | null = null;
let lastFailure: string | undefined;
/**
 * The rejected-login message of the last resolve, when every login file it
 * tried was rejected by Meta; cleared by a confirmed mint or a reset. Read by
 * `--probe` after its request (`describeMuseSigningSource`).
 */
let lastRejection: string | undefined;
/**
 * The invalidation epoch. A reset (login, logout, `credentials.invalidate`)
 * bumps it; a resolve that started in an older epoch may finish, but it never
 * installs its result: the login it resolved may be the one just replaced.
 */
let epoch = 0;
/** Which resolve `inFlightResolve` names, so a finishing one clears only itself. */
let resolveSeq = 0;
let inFlightId = 0;

/** Replace the seam (`null` restores it) and forget all state. */
export function setMuseCoreTestDeps(next: Partial<MuseCoreDeps> | null): void {
  deps = next ? { ...defaultDeps, ...next } : defaultDeps;
  resetMuseCredentialState();
}

/** Forget the minted key and every in-flight resolve (after a login or logout). */
export function resetMuseCredentialState(): void {
  epoch++;
  state = undefined;
  // The Keychain module's held tokens too: a logout must leave nothing to mint from.
  resetMuseKeychainState();
  deadKeys.clear();
  inFlightResolve = null;
  lastFailure = undefined;
  lastRejection = undefined;
}

/** The installed state, if any. Never contains a secret that was not confirmed. */
export function currentMuseState(): MuseState | undefined {
  return state;
}

function install(
  source: MuseSource,
  accessToken: string,
  mint: MuseMint,
  startEpoch: number
): MuseState {
  if (startEpoch !== epoch) {
    // Fenced: the credential state was reset while this resolve ran. Answer
    // the caller that asked, but leave the state to the newer resolve.
    log("[MuseCode] a resolve that began before a credential reset finished; not installing it");
    return {
      source,
      accessToken,
      key: mint.apiKey,
      confirmedAt: deps.now(),
      ...(mint.subsTierName ? { subsTierName: mint.subsTierName } : {}),
      generation,
    };
  }
  if (state && (state.source !== source || state.subsTierName !== mint.subsTierName)) {
    log(
      `[MuseCode] signing source ${state.source} (${state.subsTierName ?? "tier unknown"}) → ` +
        `${source} (${mint.subsTierName ?? "tier unknown"})`
    );
  } else if (!state) {
    log(`[MuseCode] signing with ${source} (${mint.subsTierName ?? "tier unknown"})`);
  }
  state = {
    source,
    accessToken,
    key: mint.apiKey,
    confirmedAt: deps.now(),
    ...(mint.subsTierName ? { subsTierName: mint.subsTierName } : {}),
    generation: ++generation,
  };
  lastFailure = undefined;
  lastRejection = undefined;
  // A mint that confirmed this key revives it: the service may hand back the
  // key it just rejected, and a dead mark on it would re-mint every request.
  deadKeys.delete(mint.apiKey);
  return state;
}

function isLoginRejection(err: unknown): boolean {
  return err instanceof MuseLoginExpiredError;
}

/**
 * Mint from one file source. null when the source is absent or its login was
 * rejected; a rejection's status is pushed onto `rejections`, so the caller can
 * tell "no login file" from "a login file Meta refused".
 */
async function tryFileSource(
  source: "claudish-login" | "borrowed-copy",
  startEpoch: number,
  rejections: number[]
): Promise<MuseState | null> {
  const record = deps.readStore(
    source === "claudish-login" ? "own-login" : "borrowed-copy",
    deps.dir()
  );
  if (!record) return null;
  try {
    return install(source, record.access_token, await deps.mint(record.access_token), startEpoch);
  } catch (err) {
    if (isLoginRejection(err)) {
      log(`[MuseCode] ${source} login rejected by the key service; trying the next source`);
      rejections.push((err as MuseLoginExpiredError).upstreamStatus);
      return null;
    }
    throw err;
  }
}

async function resolveFromSources(prompt: boolean, startEpoch: number): Promise<MuseState> {
  // Each resolve states its own outcome; an older rejection must not outlive it.
  if (startEpoch === epoch) lastRejection = undefined;
  const rejections: number[] = [];
  const own = await tryFileSource("claudish-login", startEpoch, rejections);
  if (own) return own;
  const borrowed = await tryFileSource("borrowed-copy", startEpoch, rejections);
  if (borrowed) return borrowed;

  const role = credentialPromptRole();
  if (prompt && role !== "never") {
    const result = await deps.keychainLogin(async (accessToken) => {
      const mint = await deps.mint(accessToken);
      // Confirmed: keep a copy so a process that may never prompt can sign too —
      // unless a credential reset happened while the read and the mint ran (a
      // logout deletes the copy; this resolve must not write it back).
      if (startEpoch === epoch) {
        try {
          deps.writeBorrowedCopy(accessToken, mint.subsTierName, deps.dir());
        } catch (err) {
          log(`[MuseCode] could not write the borrowed copy: ${(err as Error).message}`);
        }
      } else {
        log(
          "[MuseCode] a credential reset happened during the Keychain read; not writing the copy"
        );
      }
      return { accessToken, mint };
    }, MUSE_KEYCHAIN_READ_DEADLINE_MS);
    if (result.kind === "used") {
      return install(
        result.source === "borrowed-copy" ? "borrowed-copy" : "keychain",
        result.value.accessToken,
        result.value.mint,
        startEpoch
      );
    }
    if (result.kind === "timeout") {
      throw new MuseCredentialError(
        'could not read the Muse Code login from the macOS Keychain (no answer to the access dialog); run `claudish login muse`, or retry and click "Always Allow".'
      );
    }
    if (result.kind === "failed") {
      throw new MuseCredentialError(
        `could not read the Muse Code login from the macOS Keychain (${result.detail}); run \`claudish login muse\`, or retry and click "Always Allow".`
      );
    }
    // absent / not-allowed: fall through to the no-login message.
  }
  // A login file was there and Meta refused it: say THAT, in words that fit
  // every role. The no-file messages below describe a missing login, and the
  // `never` one blames the team slot / MCP session, which a `-p` run is not.
  // The files are kept either way.
  if (rejections.length > 0) {
    const message = museLoginRejectedMessage(rejections[0]);
    if (startEpoch === epoch) lastRejection = message;
    throw new MuseCredentialError(message, rejections[0]);
  }
  if (role === "never") throw new MuseCredentialError(MUSE_NON_INTERACTIVE_MESSAGE);
  throw new MuseCredentialError(MUSE_NO_LOGIN_MESSAGE);
}

/**
 * A confirmed, unexpired state — resolving it when needed. Single-flight: every
 * concurrent caller shares one resolve. `prompt` permits the Keychain source
 * (the role must allow it too).
 */
export async function ensureMuseCredentialReady(opts: { prompt: boolean }): Promise<MuseState> {
  if (
    state &&
    !deadKeys.has(state.key) &&
    deps.now() - state.confirmedAt <= MUSE_ENTITLEMENT_TTL_MS
  ) {
    return state;
  }
  if (inFlightResolve) return inFlightResolve;
  const previous = state;
  const startEpoch = epoch;
  const resolveId = ++resolveSeq;
  const resolving: Promise<MuseState> = (async () => {
    try {
      // A TTL re-mint first re-confirms the token already in use, so a lapse is
      // caught and a working source is not abandoned for an earlier one.
      if (previous && !deadKeys.has(previous.key)) {
        try {
          return install(
            previous.source,
            previous.accessToken,
            await deps.mint(previous.accessToken),
            startEpoch
          );
        } catch (err) {
          if (!isLoginRejection(err)) throw err;
        }
      }
      return await resolveFromSources(opts.prompt, startEpoch);
    } catch (err) {
      if (startEpoch === epoch) lastFailure = (err as Error).message;
      throw err;
    } finally {
      // Only our own reference: a reset may have started a newer resolve.
      if (inFlightId === resolveId) inFlightResolve = null;
    }
  })();
  inFlightResolve = resolving;
  inFlightId = resolveId;
  return resolving;
}

/**
 * After a 401 on a request signed with `rejectedKey`: mark it dead and re-mint,
 * unless the key in use is already a different, live one (a stale failure).
 * Throws a terminal error naming the login fix when no source works.
 */
export async function forceRefreshMuseApiKey(opts: {
  rejectedKey?: string;
  prompt: boolean;
}): Promise<MuseState> {
  if (opts.rejectedKey) deadKeys.add(opts.rejectedKey);
  if (state && opts.rejectedKey && state.key !== opts.rejectedKey && !deadKeys.has(state.key)) {
    return state;
  }
  if (state) deadKeys.add(state.key);
  try {
    return await ensureMuseCredentialReady({ prompt: opts.prompt });
  } catch (err) {
    // Reworded only when the re-mint found no login that works (every source
    // rejected, or none left). The team/MCP message, the rejected-login message
    // and the Keychain messages name their own fix and pass through unchanged.
    const noWorkingLogin =
      isLoginRejection(err) ||
      (err instanceof MuseCredentialError && err.message === MUSE_NO_LOGIN_MESSAGE);
    if (noWorkingLogin) {
      throw new MuseCredentialError(
        "Meta rejected a freshly minted Muse Code key (HTTP 401): run `claudish login muse` (or `muse login`).",
        401
      );
    }
    throw err;
  }
}

/** Whether the request path of this process may use the Keychain source. */
export function requestPathMayPrompt(): boolean {
  return credentialPromptRole() === "interactive-launch";
}

/**
 * Run a config-TUI action with the Muse login resolved IN-PROCESS first, so the
 * action's own proxy requests find it in memory and never cause a read. Errors
 * of the resolve are not thrown: the action runs and reports what it finds.
 */
export async function withInteractiveCredential<T>(action: () => Promise<T>): Promise<T> {
  try {
    await ensureMuseCredentialReady({ prompt: credentialPromptRole() !== "never" });
  } catch (err) {
    log(`[MuseCode] login not available for this action: ${(err as Error).message}`);
  }
  return action();
}

/**
 * Resolve the Muse login in-process for a config-TUI action (Test, Test All,
 * the Routing tab's probe) before it sends anything to the probe proxy. The
 * action is the user's keypress, so the Keychain may be read here; the proxy's
 * requests then find the key in memory. Never throws: the action reports what
 * its own request finds.
 */
export async function prepareMuseLoginForTuiAction(): Promise<void> {
  await withInteractiveCredential(async () => undefined);
}

/**
 * The one cached Muse Code credential status, for sync readers (Providers tab,
 * `claudish providers --json`, `source.ts`). The two file checks are sync;
 * `keychain` comes from the async presence memo ({@link refreshMuseCredentialStatus}).
 */
export type MuseCredentialStatus =
  | "own-login"
  | "borrowed-copy"
  | "keychain"
  | "absent"
  | "failed"
  | "unknown";

export function museCredentialStatus(dir: string = deps.dir()): MuseCredentialStatus {
  if (deps.readStore("own-login", dir)) return "own-login";
  if (deps.readStore("borrowed-copy", dir)) return "borrowed-copy";
  const presence = museKeychainPresenceCached();
  if (presence === "present") return "keychain";
  if (presence === "failed") return "failed";
  if (presence === "absent") return "absent";
  return "unknown";
}

/** The status from claudish's own two files only: no Keychain question of any kind. */
export function museCredentialStatusFromFiles(dir: string = deps.dir()): MuseCredentialStatus {
  if (deps.readStore("own-login", dir)) return "own-login";
  if (deps.readStore("borrowed-copy", dir)) return "borrowed-copy";
  return "absent";
}

/** Refresh the Keychain presence memo (attributes only, no dialog), then read the status. */
export async function refreshMuseCredentialStatus(): Promise<MuseCredentialStatus> {
  if (!deps.readStore("own-login", deps.dir()) && !deps.readStore("borrowed-copy", deps.dir())) {
    await museKeychainPresence();
  }
  return museCredentialStatus();
}

/** Projection: a status that means a login is there to use. */
export function isMuseCredentialConfigured(status: MuseCredentialStatus): boolean {
  return status === "own-login" || status === "borrowed-copy" || status === "keychain";
}

/** How `--probe` names each signing source. */
const SOURCE_LABELS: Record<MuseSource, string> = {
  "claudish-login": "claudish login",
  "borrowed-copy": "borrowed copy",
  keychain: "Muse Code CLI Keychain login",
};

/**
 * The display name of the credential a state signs with:
 * `Muse Code <source> · <tier>`. Display-safe (no token), so it travels with
 * the request's artifact (`RequestAuth.signer`) and back to `--probe` on the
 * response; see {@link describeMuseSigningSource}.
 */
export function museSignerLabel(signer: Pick<MuseState, "source" | "subsTierName">): string {
  return `Muse Code ${SOURCE_LABELS[signer.source]} · ${signer.subsTierName ?? "tier unknown"}`;
}

/** What `--probe`'s Key line says about the Muse Code credential. */
export interface MuseSigningDescription {
  /** False when nothing can sign here: rejected, or no login this process may use. */
  present: boolean;
  /** `Muse Code <source> · <tier>`, `Muse Code login rejected`, or the no-login label. */
  label: string;
  /** Where that came from: the request that signed, the file, or the remedy. */
  detail: string;
}

function displayPath(path: string): string {
  const home = homedir();
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/**
 * What `--probe` says about a muse@ hop's credential (contract §4.3 item 5 /
 * R2-F28: a silent switch between the own login and a borrowed one must be
 * visible). Read AFTER the probe request, and in this order:
 *
 * 1. `signedWith` — the signer THIS probe request's response named
 *    (`x-claudish-signed-with`). Per request, so concurrent probes in one
 *    process cannot borrow each other's answer.
 * 2. A probe that ran and was refused because every login file was rejected
 *    by Meta: `Muse Code login rejected`, with the rejection message.
 * 3. The files, in the order the resolve tries them, with the tier the
 *    confirming mint wrote: what a request WOULD sign with (no probe sent, or
 *    it failed for another reason).
 * 4. No file: worded for the role. A `never` process (team slot, MCP, `-p`,
 *    `--probe`) reads files only, so a Muse Code CLI Keychain login may exist
 *    but cannot be used here, and the line says so. In a role that may read
 *    the Keychain, an item the attribute-only presence memo already saw is
 *    reported present.
 *
 * Files and memos ONLY: never a Keychain question of any kind.
 */
export function describeMuseSigningSource(
  opts: { signedWith?: string; probed?: boolean } = {}
): MuseSigningDescription {
  if (opts.signedWith) {
    return { present: true, label: opts.signedWith, detail: "signed this probe request" };
  }
  if (opts.probed && lastRejection) {
    return { present: false, label: "Muse Code login rejected", detail: lastRejection };
  }
  for (const [kind, source] of [
    ["own-login", "claudish-login"],
    ["borrowed-copy", "borrowed-copy"],
  ] as const) {
    const record = deps.readStore(kind, deps.dir());
    if (!record) continue;
    const tier = typeof record.subs_tier_name === "string" ? record.subs_tier_name : undefined;
    const path = displayPath(museStorePath(kind, deps.dir()));
    return {
      present: true,
      label: museSignerLabel({ source, subsTierName: tier }),
      detail: opts.probed
        ? `${path}; the probe request did not confirm it`
        : `${path}, not yet confirmed in this process`,
    };
  }
  if (credentialPromptRole() === "never") {
    return {
      present: false,
      label: "no claudish Muse Code login",
      detail:
        "this process reads login files only, so a Muse Code CLI Keychain login cannot be used here: " +
        "run `claudish login muse`, or one interactive `claudish --model muse@<model>` and allow Keychain access",
    };
  }
  if (museKeychainPresenceCached() === "present") {
    return {
      present: true,
      label: museSignerLabel({ source: "keychain" }),
      detail: "in the macOS Keychain; read on first use, after you allow access",
    };
  }
  return { present: false, label: "no Muse Code login", detail: MUSE_NO_LOGIN_MESSAGE };
}

/** The last resolve failure's message, for diagnostics. */
export function lastMuseCredentialFailure(): string | undefined {
  return lastFailure;
}
