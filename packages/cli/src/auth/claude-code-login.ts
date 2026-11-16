/**
 * Does this machine hold a Claude Code login? The readiness of the Claude
 * subscription: a non-empty `CLAUDE_CODE_OAUTH_TOKEN`, Claude Code's OAuth
 * credentials file, or its macOS login-Keychain item. No stored secret is read:
 * the environment token is checked only for being non-empty, the file only for
 * existence, and the Keychain probe reads item attributes, never data, so it
 * raises no access dialog.
 *
 * An Anthropic API key is NOT a Claude Code login: the Claude subscription is
 * never signed with one, so a key alone never makes it ready.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  claudeCodeConfigDir,
  claudeCodeGlobalConfigPath,
  claudeCodeSecureStorageServices,
} from "./claude-code-facts.js";

/**
 * Existence-only probe for an OS-credential-store Anthropic OAuth item. `env`
 * decides the config directory, and so the item's service name.
 */
export type KeychainCredentialProbe = (env?: NodeJS.ProcessEnv) => boolean;

// Startup-only memo (at most a couple of evaluations per launch), keyed by the
// SERVICE NAMES probed so a changed CLAUDE_CONFIG_DIR is not answered from the
// previous directory's result. Tests inject their own probe, so this stays
// inert there.
const macosKeychainAnthropicMemo = new Map<string, boolean>();

/**
 * Existence-only probe for Claude Code's macOS login-Keychain OAuth item.
 *
 * It asks exactly the services the launch check asks
 * (`claudeCodeSecureStorageServices("-credentials", env)`, the
 * `Claude Code-credentials[-<hash>]` names), so picker readiness and the launch
 * agree: `CLAUDE_SECURESTORAGE_CONFIG_DIR` decides alone when set, and a custom
 * `CLAUDE_CONFIG_DIR` never falls back to the unsuffixed default login, which
 * the child would not start with.
 *
 * Uses `security find-generic-password` WITHOUT `-w`, so it reads item ATTRIBUTES
 * and never item DATA: no secret is requested, no Keychain-access dialog appears,
 * and the token is never touched — Claude Code itself still forwards the OAuth
 * once claudish skips the placeholder key. Non-darwin → false (returns before
 * spawning). Best-effort: any error (security absent, non-zero exit, item
 * missing) → false.
 *
 * `CLAUDISH_DISABLE_KEYCHAIN=1` short-circuits it to false, mirroring
 * `hasKeychainSource()`. A test run must be able to guarantee it spawns no
 * `security` at all — see `keychain.md` on why a flag the production code
 * honours is the only stub that cannot leak.
 */
export const defaultKeychainAnthropicProbe: KeychainCredentialProbe = (env = process.env) => {
  if (process.platform !== "darwin") return false;
  // The test guard is honoured from either environment: a caller's own env
  // must never be the reason a test run spawns `security`.
  if (process.env.CLAUDISH_DISABLE_KEYCHAIN === "1" || env.CLAUDISH_DISABLE_KEYCHAIN === "1") {
    return false;
  }

  const memoKey = claudeCodeSecureStorageServices("-credentials", env).join("|");
  const memoized = macosKeychainAnthropicMemo.get(memoKey);
  if (memoized !== undefined) return memoized;
  // Existence only: `defaultKeychainPresence` runs `find-generic-password`
  // WITHOUT `-w` and honours `CLAUDISH_KEYCHAIN_FILE`.
  const found = keychainLoginPresent(env, defaultKeychainPresence);
  macosKeychainAnthropicMemo.set(memoKey, found);
  return found;
};

/**
 * Whether a Claude Code OAuth Keychain item is present, asking `presence` about
 * each service. Presence only.
 */
export function keychainLoginPresent(
  env: NodeJS.ProcessEnv,
  presence: (service: string) => KeychainPresence
): boolean {
  return anyPresent(claudeCodeSecureStorageServices("-credentials", env), presence) === "found";
}

/** Injectable reads for {@link hasClaudeCodeLogin}; each defaults to the real one. */
export interface ClaudeCodeLoginDeps {
  env?: NodeJS.ProcessEnv;
  fileExists?: (path: string) => boolean;
  keychainProbe?: KeychainCredentialProbe;
}

/**
 * True when Claude Code has a login it can sign the Claude subscription with: a
 * non-empty `CLAUDE_CODE_OAUTH_TOKEN` (claudish never sets a placeholder for
 * it), the
 * `.credentials.json` in Claude Code's config directory (`CLAUDE_CONFIG_DIR`,
 * else `~/.claude`, both read from `env`), or its macOS Keychain item for that
 * directory. Existence only.
 *
 * TODO: Windows/Linux may also keep the OAuth in an OS credential store
 * (Credential Manager / libsecret) rather than the file; only the macOS Keychain
 * is covered so far.
 */
export function hasClaudeCodeLogin(deps: ClaudeCodeLoginDeps = {}): boolean {
  const env = deps.env ?? process.env;
  const token = env.CLAUDE_CODE_OAUTH_TOKEN;
  if (typeof token === "string" && token.trim().length > 0) return true;
  const fileExists = deps.fileExists ?? existsSync;
  if (fileExists(join(claudeCodeConfigDir(env), ".credentials.json"))) return true;
  return (deps.keychainProbe ?? defaultKeychainAnthropicProbe)(env);
}

/** What one presence probe of a Keychain service answered; `failed` is never `absent`. */
export type KeychainPresence = "found" | "absent" | "failed";

/** `security`'s exit status for "no such item". */
const SECURITY_ITEM_NOT_FOUND = 44;

/**
 * Presence of any generic-password item under `service`, from its ATTRIBUTES:
 * `find-generic-password` without `-w` reads no item data, so it raises no
 * access dialog. Non-darwin: `absent`. `CLAUDISH_DISABLE_KEYCHAIN=1`: `failed`,
 * since the store was not asked. Honours `CLAUDISH_KEYCHAIN_FILE`.
 */
export function defaultKeychainPresence(service: string): KeychainPresence {
  if (process.platform !== "darwin") return "absent";
  if (process.env.CLAUDISH_DISABLE_KEYCHAIN === "1") return "failed";
  const args = ["find-generic-password", "-s", service];
  const keychainFile = process.env.CLAUDISH_KEYCHAIN_FILE;
  if (keychainFile) args.push(keychainFile);
  try {
    const res = spawnSync("security", args, { stdio: "ignore" });
    if (res.error) return "failed";
    if (res.status === 0) return "found";
    return res.status === SECURITY_ITEM_NOT_FOUND ? "absent" : "failed";
  } catch {
    return "failed";
  }
}

/**
 * The credential Claude Code would start with, as far as presence can tell:
 *
 * - `login`: a claude.ai login (a non-empty `CLAUDE_CODE_OAUTH_TOKEN`, the
 *   `.credentials.json` file, or the OAuth Keychain item);
 * - `api-key`: no login, but a stored Console key (`primaryApiKey` in Claude
 *   Code's global config, or its API-key Keychain item). Claude Code sends it
 *   as `x-api-key` and shows no login screen (measured on 2.1.325); `where`
 *   names the store, never a value;
 * - `none`: neither, and every store answered;
 * - `unknown`: no login found and a login store could not be asked (a Keychain
 *   that did not answer), whatever the key stores hold; or neither found and a
 *   key store could not be asked (an unreadable config file).
 */
export type ClaudeCodeStartupCredential =
  | { kind: "login" }
  | { kind: "api-key"; where: string }
  | { kind: "none" }
  | { kind: "unknown" };

/** Injectable reads for {@link claudeCodeStartupCredential}; each defaults to the real one. */
export interface ClaudeCodeStartupCredentialDeps {
  env?: NodeJS.ProcessEnv;
  fileExists?: (path: string) => boolean;
  readFile?: (path: string) => string;
  keychainPresence?: (service: string) => KeychainPresence;
}

/**
 * Which credential Claude Code holds, read at launch for a Claude subscription
 * session. Presence only: the config file is parsed to learn whether
 * `primaryApiKey` is set, and its value is neither kept nor returned; the
 * Keychain is probed by service name, never read.
 */
export function claudeCodeStartupCredential(
  deps: ClaudeCodeStartupCredentialDeps = {}
): ClaudeCodeStartupCredential {
  const env = deps.env ?? process.env;
  const fileExists = deps.fileExists ?? existsSync;
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf-8"));
  const presence = deps.keychainPresence ?? defaultKeychainPresence;

  const token = env.CLAUDE_CODE_OAUTH_TOKEN;
  if (typeof token === "string" && token.trim().length > 0) return { kind: "login" };
  if (fileExists(join(claudeCodeConfigDir(env), ".credentials.json"))) return { kind: "login" };

  // Only the names Claude Code itself uses: `CLAUDE_SECURESTORAGE_CONFIG_DIR`
  // decides alone when set. A login under any other name is not the one it
  // would start with.
  const oauth = anyPresent(claudeCodeSecureStorageServices("-credentials", env), presence);
  if (oauth === "found") return { kind: "login" };
  // A login store that did not answer may hold the login: a Console key found
  // elsewhere proves a key exists, not that no login does.
  if (oauth === "failed") return { kind: "unknown" };

  const configPath = claudeCodeGlobalConfigPath(env);
  const stored = fileExists(configPath) ? configSetsConsoleKey(configPath, readFile) : "absent";
  if (stored === "found") return { kind: "api-key", where: configPath };
  const keychainKey = anyPresent(claudeCodeSecureStorageServices("", env), presence);
  if (keychainKey === "found") return { kind: "api-key", where: "the macOS Keychain" };
  const unanswered = stored === "failed" || keychainKey === "failed";
  return unanswered ? { kind: "unknown" } : { kind: "none" };
}

/** `found` at the first service present; `failed` when none is and one did not answer. */
function anyPresent(
  services: readonly string[],
  presence: (service: string) => KeychainPresence
): KeychainPresence {
  let failed = false;
  for (const service of new Set(services)) {
    const answer = presence(service);
    if (answer === "found") return "found";
    if (answer === "failed") failed = true;
  }
  return failed ? "failed" : "absent";
}

/** Whether Claude Code's global config sets `primaryApiKey`; the value is not kept. */
function configSetsConsoleKey(path: string, readFile: (path: string) => string): KeychainPresence {
  try {
    const parsed: unknown = JSON.parse(readFile(path));
    if (parsed === null || typeof parsed !== "object") return "absent";
    const key = (parsed as Record<string, unknown>).primaryApiKey;
    return typeof key === "string" && key.length > 0 ? "found" : "absent";
  } catch {
    return "failed";
  }
}
