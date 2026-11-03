/**
 * The legacy Codex file move into the Keychain (MTL-372): when it applies.
 *
 * The move itself is `CodexAccountManagement.moveLegacyLogin()` in
 * `management.ts`, which needs that class's gate, fence and config helpers.
 * This module holds what the move and its triggers both ask first, and it stays
 * import-light on purpose: the request path reaches it on every Codex sign, and
 * must not load `@inquirer/prompts` or PKCE unless a move is actually due.
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
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { isKeychainSupported } from "../../providers/keychain.js";
import { claudishHome } from "./paths.js";

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
