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

import { credentialPromptRole } from "../../auth/credentials/prompt-role.js";
import { log } from "../../logger.js";
import {
  MUSE_KEYCHAIN_READ_DEADLINE_MS,
  museKeychainPresence,
  museKeychainPresenceCached,
  withMuseKeychainLogin,
} from "./muse-keychain.js";
import { MuseLoginExpiredError, type MuseMint, mintMuseApiKey } from "./muse-mint.js";
import { defaultMuseStoreDir, readMuseStore, writeBorrowedCopy } from "./muse-store.js";

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
  constructor(message: string) {
    super(message);
    this.name = "MuseCredentialError";
  }
}

export const MUSE_NO_LOGIN_MESSAGE =
  "muse@ needs a Muse Code login: run `claudish login muse` (or, in an interactive terminal, `muse login` and allow Keychain access).";
export const MUSE_NON_INTERACTIVE_MESSAGE =
  "muse@ in a team slot / MCP session needs a claudish login: run `claudish login muse`, or one interactive `claudish --model muse@<model>` and allow Keychain access.";

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

/** Replace the seam (`null` restores it) and forget all state. */
export function setMuseCoreTestDeps(next: Partial<MuseCoreDeps> | null): void {
  deps = next ? { ...defaultDeps, ...next } : defaultDeps;
  resetMuseCredentialState();
}

/** Forget the minted key and every in-flight resolve (after a login or logout). */
export function resetMuseCredentialState(): void {
  state = undefined;
  deadKeys.clear();
  inFlightResolve = null;
  lastFailure = undefined;
}

/** The installed state, if any. Never contains a secret that was not confirmed. */
export function currentMuseState(): MuseState | undefined {
  return state;
}

function install(source: MuseSource, accessToken: string, mint: MuseMint): MuseState {
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
  // A mint that confirmed this key revives it: the service may hand back the
  // key it just rejected, and a dead mark on it would re-mint every request.
  deadKeys.delete(mint.apiKey);
  return state;
}

function isLoginRejection(err: unknown): boolean {
  return err instanceof MuseLoginExpiredError;
}

/** Mint from one file source. null when the source is absent or its login was rejected. */
async function tryFileSource(
  source: "claudish-login" | "borrowed-copy"
): Promise<MuseState | null> {
  const record = deps.readStore(
    source === "claudish-login" ? "own-login" : "borrowed-copy",
    deps.dir()
  );
  if (!record) return null;
  try {
    return install(source, record.access_token, await deps.mint(record.access_token));
  } catch (err) {
    if (isLoginRejection(err)) {
      log(`[MuseCode] ${source} login rejected by the key service; trying the next source`);
      return null;
    }
    throw err;
  }
}

async function resolveFromSources(prompt: boolean): Promise<MuseState> {
  const own = await tryFileSource("claudish-login");
  if (own) return own;
  const borrowed = await tryFileSource("borrowed-copy");
  if (borrowed) return borrowed;

  const role = credentialPromptRole();
  if (prompt && role !== "never") {
    const result = await deps.keychainLogin(async (accessToken) => {
      const mint = await deps.mint(accessToken);
      // Confirmed: keep a copy so a process that may never prompt can sign too.
      try {
        deps.writeBorrowedCopy(accessToken, mint.subsTierName, deps.dir());
      } catch (err) {
        log(`[MuseCode] could not write the borrowed copy: ${(err as Error).message}`);
      }
      return { accessToken, mint };
    }, MUSE_KEYCHAIN_READ_DEADLINE_MS);
    if (result.kind === "used") {
      return install(
        result.source === "borrowed-copy" ? "borrowed-copy" : "keychain",
        result.value.accessToken,
        result.value.mint
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
  inFlightResolve = (async () => {
    try {
      // A TTL re-mint first re-confirms the token already in use, so a lapse is
      // caught and a working source is not abandoned for an earlier one.
      if (previous && !deadKeys.has(previous.key)) {
        try {
          return install(
            previous.source,
            previous.accessToken,
            await deps.mint(previous.accessToken)
          );
        } catch (err) {
          if (!isLoginRejection(err)) throw err;
        }
      }
      return await resolveFromSources(opts.prompt);
    } catch (err) {
      lastFailure = (err as Error).message;
      throw err;
    } finally {
      inFlightResolve = null;
    }
  })();
  return inFlightResolve;
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
    if (err instanceof MuseCredentialError || isLoginRejection(err)) {
      throw new MuseCredentialError(
        "Meta rejected a freshly minted Muse Code key (HTTP 401): run `claudish login muse` (or `muse login`)."
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

/** The last resolve failure's message, for diagnostics. */
export function lastMuseCredentialFailure(): string | undefined {
  return lastFailure;
}
