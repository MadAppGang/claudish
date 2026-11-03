/**
 * The legacy Codex file move into the Keychain (MTL-372): when it applies.
 *
 * The move itself is `CodexAccountManagement.moveLegacyLogin()` in
 * `management.ts`, which needs that class's gate, fence and config helpers.
 * This module holds what the move and its triggers both ask first, and the
 * request-path trigger ({@link startLegacyCodexMove}: single flight, cooldown).
 * It stays import-light on purpose: the request path reaches it on every Codex
 * sign, and must not load `@inquirer/prompts` or PKCE unless a move is due.
 *
 * The move runs only where BOTH hold:
 *
 * - **a Keychain platform**: `CLAUDISH_DISABLE_KEYCHAIN` is not `1` and the
 *   platform has a macOS Keychain. Elsewhere (Linux, Windows, WSL, the test
 *   suite) the 0600 legacy file stays exactly as built: the move needs a
 *   destination better than its source.
 * - **the default config**: the active config resolves to
 *   `<claudishHome>/config.json`. The legacy file is per `HOME` and a config is
 *   per path, so a move run against an alternate `--config` / `CLAUDISH_CONFIG`
 *   would hand the shared file to a config that does not own it (MTL-371 in the
 *   other direction).
 */
import { lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { log } from "../../logger.js";
import { activeConfigFile } from "../../profile-config.js";
import { isKeychainSupported } from "../../providers/keychain.js";
import { redactSecrets } from "../../redact.js";
// Type-only: erased at runtime, so the request path never loads management.ts here.
import type { AccountManagementDeps, LegacyMoveOutcome } from "./management.js";
import { claudishHome, legacyCodexCredentialsPath } from "./paths.js";
import { type AccountRegistry, getAccountRegistry } from "./registry.js";
import { defaultAccountStore } from "./token-store.js";

/** True when the move must not run because there is no usable Keychain here. */
export function legacyMoveKeychainBlocked(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAUDISH_DISABLE_KEYCHAIN === "1" || !isKeychainSupported();
}

/** `realpath`, or the absolute path when the file does not exist (yet). */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Does `configPath` name the default config of this `HOME`? */
export function isDefaultConfigPath(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return canonical(configPath) === canonical(join(claudishHome(env), "config.json"));
}

// ---------------------------------------------------------------------------
// The request-path trigger: the first Codex sign of a process, in the background
// ---------------------------------------------------------------------------

/**
 * How long a request-path trigger waits after a move that did not complete.
 * A judgement value, not a measurement: it keeps a locked keychain or a busy
 * gate from costing a `security` spawn on every request. The explicit commands
 * (`login codex`, the account verbs) ignore it.
 */
export const LEGACY_MOVE_RETRY_MS = 10 * 60 * 1000;

/**
 * Is a move due? Synchronous and cheap: the env flag, the platform, one
 * account-list snapshot (stat-cached), one `lstat` only in the leftover case,
 * then the config path and the destination store's kind. Any doubt (an
 * unreadable account list) answers false.
 *
 * Due when the snapshot shows the synthesized legacy login, a
 * `legacy-codex-file` row, or the leftover condition (the suppression marker
 * and the file still present).
 */
export function legacyMoveApplies(
  env: NodeJS.ProcessEnv,
  configPath: string,
  registry: AccountRegistry
): boolean {
  if (legacyMoveKeychainBlocked(env)) return false;
  let due: boolean;
  try {
    const snapshot = registry.snapshot("openai-codex");
    const rows = snapshot.accounts["openai-codex"];
    const legacyRow = rows.some((row) => row.legacy || row.store === "legacy-codex-file");
    due =
      legacyRow ||
      (snapshot.settings["openai-codex"]?.legacyCodexSuppressed === true && legacyFileExists(env));
  } catch {
    return false;
  }
  if (!due || !isDefaultConfigPath(configPath, env)) return false;
  return defaultAccountStore(env).kind === "keychain";
}

function legacyFileExists(env: NodeJS.ProcessEnv): boolean {
  try {
    lstatSync(legacyCodexCredentialsPath(env));
    return true;
  } catch {
    return false;
  }
}

export interface StartLegacyMoveOptions {
  env?: NodeJS.ProcessEnv;
  configPath?: () => string;
  registry?: AccountRegistry;
  now?: () => number;
  /** Passed to the move; tests inject stores and gate deps here. */
  management?: AccountManagementDeps;
}

/** The single flight: one move per process at a time. */
let inFlight: Promise<LegacyMoveOutcome> | null = null;
/** The last move started, kept for tests after it settles. */
let lastMove: Promise<LegacyMoveOutcome> | null = null;
/** Request-path triggers before this instant do nothing. */
let cooldownUntil = 0;

/**
 * Start the legacy Codex file move if one is due, and return at once.
 *
 * Fire and forget: the pre-move and the post-move state both sign correctly,
 * and every race with a concurrent reader is a transient 503 (the token
 * manager's revalidation of an emptied store, `CodexOAuth`'s moved-file error).
 * Awaiting would put the gate wait (up to 20 s behind a refresh) and a
 * `security` spawn on a user's request. Outcomes go to the debug log only: a
 * background line on stderr would interleave with Claude Code's TUI.
 *
 * A move that ends `deferred` or `not-applicable` starts the cooldown. Never throws.
 */
export function startLegacyCodexMove(opts: StartLegacyMoveOptions = {}): void {
  try {
    if (inFlight) return;
    const now = opts.now ?? Date.now;
    if (now() < cooldownUntil) return;
    const env = opts.env ?? process.env;
    const configPath = (opts.configPath ?? activeConfigFile)();
    if (!legacyMoveApplies(env, configPath, opts.registry ?? getAccountRegistry())) return;

    const move: Promise<LegacyMoveOutcome> = (async () => {
      // Loaded only now: management.ts pulls in @inquirer/prompts and PKCE.
      const { moveLegacyCodexLogin } = await import("./management.js");
      return moveLegacyCodexLogin(
        { env, configPath: () => configPath, ...opts.management },
        { trigger: "request" }
      );
    })()
      .catch(
        (err): LegacyMoveOutcome => ({
          kind: "deferred",
          reason: "config-unavailable",
          // A thrown message may quote file bytes; it reaches the debug log.
          detail: redactSecrets(err instanceof Error ? err.message : String(err)),
        })
      )
      .then((outcome) => {
        log(`[accounts] legacy Codex move (request path): ${outcome.kind}`);
        if (outcome.kind === "deferred" || outcome.kind === "not-applicable") {
          cooldownUntil = now() + LEGACY_MOVE_RETRY_MS;
        }
        return outcome;
      })
      .finally(() => {
        if (inFlight === move) inFlight = null;
      });
    inFlight = move;
    lastMove = move;
  } catch (err) {
    log(
      `[accounts] legacy Codex move not started: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** TEST SEAM: the move the last trigger started (in flight or settled), or null. */
export function _legacyMoveForTests(): Promise<LegacyMoveOutcome> | null {
  return lastMove;
}

/** TEST SEAM: forget the single flight, the last move and the cooldown. */
export function _resetLegacyMoveForTests(): void {
  inFlight = null;
  lastMove = null;
  cooldownUntil = 0;
}
