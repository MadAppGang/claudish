/**
 * How a launch talks to Anthropic when its main model is a Claude model: who
 * signs the native requests its proxy forwards.
 *
 * A launch whose main model is a bare Claude name is the Claude subscription,
 * so its native requests are signed with Claude Code's login only, never with
 * an Anthropic API key (`login-only`), unless the user opted into API billing
 * (`--anthropic-api-billing`). Every other launch keeps the proxy's `inbound`
 * rule, which an absent signing selects.
 */

import { wantsAnthropicApiBilling } from "../claude-runner.js";
import { LOGIN_ONLY_SIGNING, type NativeSigning } from "../handlers/shared/anthropic-forward.js";
import { nativeRouteFor } from "../providers/native-route.js";
import type { ClaudishConfig } from "../types.js";

export interface LaunchSigningDeps {
  /** Default `wantsAnthropicApiBilling` (flag, env, config). */
  wantsApiBilling?: (config: ClaudishConfig) => boolean;
}

/**
 * The launch's native signing: `login-only` for a bare Claude main model (or
 * `claude@` before one) without the API-billing opt-in, else undefined, which
 * the proxy reads as `inbound`.
 */
export function launchSigningFor(
  config: ClaudishConfig,
  deps: LaunchSigningDeps = {}
): NativeSigning | undefined {
  const main = config.model;
  if (!main || nativeRouteFor(main) === null) return undefined;
  const wantsApiBilling =
    deps.wantsApiBilling ?? ((c: ClaudishConfig) => wantsAnthropicApiBilling(c));
  return wantsApiBilling(config) ? undefined : LOGIN_ONLY_SIGNING;
}
