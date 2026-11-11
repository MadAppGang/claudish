/**
 * Whether an OpenRouter key exists anywhere this machine keeps one.
 *
 * PRESENCE only: no value is read and no 1Password session is opened, so routing
 * can ask on every decision. Three stores, cheapest first: the environment and
 * config `apiKeys` (`hasLocalApiKey`), the Keychain's single enumerate call
 * (`keychainHasAnyOf`), and a config `op://` reference naming the variable.
 *
 * A key that only a 1Password Environment or a glob import would supply is not
 * visible here until something has fetched it into `process.env`, which step one
 * then sees: its contents are unknown without opening the SDK.
 */
import { keychainHasAnyOf } from "./keychain-source.js";
import { hasLocalApiKey } from "./local-api-key.js";
import { configHasOpReferenceFor } from "./op-source.js";

const OPENROUTER_KEY_ENV_VAR = "OPENROUTER_API_KEY";

export function openRouterKeyPresent(): boolean {
  return (
    hasLocalApiKey({ envVar: OPENROUTER_KEY_ENV_VAR }) ||
    keychainHasAnyOf([OPENROUTER_KEY_ENV_VAR]) ||
    configHasOpReferenceFor(OPENROUTER_KEY_ENV_VAR)
  );
}
