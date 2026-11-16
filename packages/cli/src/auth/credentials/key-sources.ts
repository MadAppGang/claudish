/**
 * The places an API key is looked for, in the credential authority's order, as
 * the words a message prints: "looked in environment, ~/.claudish/config.json,
 * macOS Keychain". A vault appears only when this machine would ask it, so a
 * message never names a store the user never set up.
 *
 * Reads no secret and starts no process: the Keychain and 1Password entries
 * come from the same sync gates the resolution itself checks first.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { activeGlobalConfigFile, getConfigFileOverride } from "../../config-override.js";
import { hasKeychainSource } from "./keychain-source.js";
import { hasOpSources } from "./op-source.js";

/** The config file as a message names it: the override path, else the tilde form. */
function configLabel(): string {
  return getConfigFileOverride()
    ? activeGlobalConfigFile(join(homedir(), ".claudish", "config.json"))
    : "~/.claudish/config.json";
}

/**
 * The searched sources in resolution order. `compact` gives the short names a
 * narrow line fits (`env, config, Keychain, 1Password`).
 */
export function keySourcesSearched(opts?: { compact?: boolean }): string[] {
  const compact = opts?.compact === true;
  const sources = [compact ? "env" : "environment", compact ? "config" : configLabel()];
  if (hasKeychainSource()) sources.push(compact ? "Keychain" : "macOS Keychain");
  if (hasOpSources()) sources.push("1Password");
  return sources;
}
