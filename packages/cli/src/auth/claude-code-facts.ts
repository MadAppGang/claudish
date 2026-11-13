/**
 * Facts about the INSTALLED Claude Code binary that claudish has to agree with.
 *
 * These are measured from the binary's strings, not documented anywhere, so each
 * one carries the version it was measured against. A claudish that guesses wrong
 * here does not error — it silently looks in the wrong place and reports "no
 * login", which is the failure mode this file exists to make visible.
 *
 * Measured against **Claude Code 2.1.268**.
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

/** The Claude Code version these facts were measured against. */
export const CLAUDE_CODE_FACTS_VERSION = "2.1.268";

/** Service name with no config-dir suffix — the default-config-dir case. */
const BASE_KEYCHAIN_SERVICE = "Claude Code";
const KEYCHAIN_SERVICE_SUFFIX = "-credentials";

/** Claude Code's default config directory. */
function defaultConfigDir(env: NodeJS.ProcessEnv): string {
  return resolve(env.HOME || homedir(), ".claude");
}

/**
 * The directory Claude Code keeps its config and file-backed login in:
 * `CLAUDE_CONFIG_DIR` (resolved against the working directory) when set, else
 * `~/.claude` under `HOME`.
 */
export function claudeCodeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.CLAUDE_CONFIG_DIR?.trim();
  if (!raw) return defaultConfigDir(env);
  return isAbsolute(raw) ? resolve(raw) : resolve(process.cwd(), raw);
}

/** `sha256(configDir)` truncated to 8 hex characters, as the binary does. */
function configDirHash(configDir: string): string {
  return createHash("sha256").update(configDir).digest("hex").slice(0, 8);
}

/**
 * The macOS Keychain service holding Claude Code's OAuth item:
 *
 *   `Claude Code[-<sha256(configDir)[0:8]>]-credentials`
 *
 * The hash suffix appears only when `CLAUDE_CONFIG_DIR` points somewhere other
 * than the default `~/.claude`, which is exactly what makes the omission so easy
 * to miss: every developer on a default install sees the unsuffixed name work,
 * and only a user with a custom config dir — or claudish's own tests, which set
 * one deliberately to stay off the real login keychain — is told they have no
 * Claude login when they are signed in.
 */
export function claudeCodeKeychainService(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.CLAUDE_CONFIG_DIR?.trim();
  if (!raw) return `${BASE_KEYCHAIN_SERVICE}${KEYCHAIN_SERVICE_SUFFIX}`;

  const resolved = isAbsolute(raw) ? resolve(raw) : resolve(process.cwd(), raw);
  if (resolved === defaultConfigDir(env)) {
    // An explicit CLAUDE_CONFIG_DIR that names the DEFAULT directory is still the
    // default, and the binary stores it under the unsuffixed service.
    return `${BASE_KEYCHAIN_SERVICE}${KEYCHAIN_SERVICE_SUFFIX}`;
  }
  return `${BASE_KEYCHAIN_SERVICE}-${configDirHash(resolved)}${KEYCHAIN_SERVICE_SUFFIX}`;
}

/**
 * Every service name a login could plausibly live under, most specific first.
 *
 * Two unknowns the measurement has not settled: whether the binary hashes the
 * RAW `CLAUDE_CONFIG_DIR` string or a resolved absolute path, and whether a
 * trailing slash survives. Existence probing is cheap (`find-generic-password`
 * without `-w` reads attributes, never data, so it never prompts), so the probe
 * checks each candidate instead of betting on one normalisation and reporting
 * "not signed in" when it loses.
 *
 * The unsuffixed name is always included last: a user who sets
 * `CLAUDE_CONFIG_DIR` after logging in still has a usable item under the old
 * service, and finding it is strictly better than telling them to log in again.
 */
export function claudeCodeKeychainServiceCandidates(
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const candidates = [claudeCodeKeychainService(env)];
  const raw = env.CLAUDE_CONFIG_DIR?.trim();
  if (raw) {
    for (const variant of [raw, raw.replace(/\/+$/, "")]) {
      candidates.push(
        `${BASE_KEYCHAIN_SERVICE}-${configDirHash(variant)}${KEYCHAIN_SERVICE_SUFFIX}`
      );
    }
  }
  candidates.push(`${BASE_KEYCHAIN_SERVICE}${KEYCHAIN_SERVICE_SUFFIX}`);
  return [...new Set(candidates)];
}

/** The JSON key inside that Keychain item holding the OAuth block. */
export const CLAUDE_CODE_OAUTH_ITEM_KEY = "claudeAiOauth";

/**
 * The macOS Keychain services Claude Code's secure storage uses, measured on
 * Claude Code 2.1.312 (ai-docs/reports/claude-oauth-facts-2026-10-29.md, F1,
 * F4, F15): `Claude Code<kind>` plus `-<sha256(dir)[0:8]>` AFTER the kind.
 * `kind` is `-credentials` for the claude.ai OAuth item and empty for the
 * API-key item (a stored Console key). The suffix is decided by
 * `CLAUDE_SECURESTORAGE_CONFIG_DIR` when it is set (empty: no suffix), else it
 * appears whenever `CLAUDE_CONFIG_DIR` is non-empty, even when that names the
 * default directory.
 *
 * Whether the hashed directory is the raw value or a resolved path is not
 * settled, so each plausible spelling is a candidate; a presence probe over
 * all of them costs no secret read.
 */
export function claudeCodeSecureStorageServices(
  kind: "-credentials" | "",
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const base = `${BASE_KEYCHAIN_SERVICE}${kind}`;
  const secure = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const spellings =
    secure !== undefined
      ? secure
        ? [secure]
        : []
      : env.CLAUDE_CONFIG_DIR
        ? [
            env.CLAUDE_CONFIG_DIR,
            claudeCodeConfigDir(env),
            env.CLAUDE_CONFIG_DIR.replace(/\/+$/, ""),
          ]
        : [];
  if (spellings.length === 0) return [base];
  return [...new Set(spellings.map((dir) => `${base}-${configDirHash(dir.normalize("NFC"))}`))];
}

/**
 * Claude Code's global config file, where a Console login keeps its key
 * (`primaryApiKey`): `<CLAUDE_CONFIG_DIR>/.claude.json` when that is set
 * (measured on Claude Code 2.1.325), else `~/.claude.json` under `HOME`.
 */
export function claudeCodeGlobalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.CLAUDE_CONFIG_DIR?.trim();
  return raw
    ? resolve(claudeCodeConfigDir(env), ".claude.json")
    : resolve(env.HOME || homedir(), ".claude.json");
}
