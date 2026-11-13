/**
 * Does this machine hold a Claude Code login? The readiness of the Claude
 * subscription: a real `CLAUDE_CODE_OAUTH_TOKEN`, Claude Code's OAuth
 * credentials file, or its macOS login-Keychain item. Existence only: no secret
 * is read, and the Keychain probe reads item attributes, never data, so it
 * raises no access dialog.
 *
 * An Anthropic API key is NOT a Claude Code login: the Claude subscription is
 * never signed with one, so a key alone never makes it ready.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { claudeCodeConfigDir, claudeCodeKeychainServiceCandidates } from "./claude-code-facts.js";
import { isClaudishPlaceholderCredential } from "./claudish-placeholder.js";

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
 * The service is `Claude Code[-<sha256(configDir)[0:8]>]-credentials` — the hash
 * suffix appears whenever `CLAUDE_CONFIG_DIR` is not the default. This probe
 * hardcoded the UNSUFFIXED name, so a user with a custom config dir was reported
 * as having no Claude login however signed in they were, and claudish then
 * injected a placeholder key over a perfectly good subscription. Each candidate
 * from {@link claudeCodeKeychainServiceCandidates} is tried in order.
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

  const services = claudeCodeKeychainServiceCandidates(env);
  const memoKey = services.join("|");
  const memoized = macosKeychainAnthropicMemo.get(memoKey);
  if (memoized !== undefined) return memoized;

  // `CLAUDISH_KEYCHAIN_FILE` redirects every `security` call to a throwaway
  // keychain, and it must be the LAST argument on any subcommand. Honoured here
  // so live verification has the same safe target the rest of the keychain code
  // has.
  const keychainFile = process.env.CLAUDISH_KEYCHAIN_FILE;
  let found = false;
  try {
    for (const service of services) {
      const args = ["find-generic-password", "-s", service];
      if (keychainFile) args.push(keychainFile);
      // Existence only — NO `-w`, so no secret is requested and no prompt appears.
      const res = spawnSync("security", args, { stdio: "ignore" });
      if (!res.error && res.status === 0) {
        found = true;
        break;
      }
    }
  } catch {
    found = false;
  }
  macosKeychainAnthropicMemo.set(memoKey, found);
  return found;
};

/** Injectable reads for {@link hasClaudeCodeLogin}; each defaults to the real one. */
export interface ClaudeCodeLoginDeps {
  env?: NodeJS.ProcessEnv;
  fileExists?: (path: string) => boolean;
  keychainProbe?: KeychainCredentialProbe;
}

/**
 * True when Claude Code has a login it can sign the Claude subscription with: a
 * real `CLAUDE_CODE_OAUTH_TOKEN` (not claudish's placeholder), the
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
  if (
    typeof token === "string" &&
    token.trim().length > 0 &&
    !isClaudishPlaceholderCredential("CLAUDE_CODE_OAUTH_TOKEN", token)
  ) {
    return true;
  }
  const fileExists = deps.fileExists ?? existsSync;
  if (fileExists(join(claudeCodeConfigDir(env), ".credentials.json"))) return true;
  return (deps.keychainProbe ?? defaultKeychainAnthropicProbe)(env);
}
