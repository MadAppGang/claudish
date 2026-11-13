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

import { type SettingsFinding, wantsAnthropicApiBilling } from "../claude-runner.js";
import { LOGIN_ONLY_SIGNING, type NativeSigning } from "../handlers/shared/anthropic-forward.js";
import { parseModelSpec } from "../providers/model-parser.js";
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

/** What a Claude subscription launch does about the settings findings it read. */
export interface SubscriptionSettingsCheck {
  /** The refusal naming every finding that could hand the child a key; null when none can. */
  refusal: string | null;
  /** One line per finding that changes where requests go, not who signs them. */
  notices: string[];
}

/** The clause one refused finding contributes, naming its file and never a value. */
function refusedClause(finding: SettingsFinding): string | null {
  switch (finding.kind) {
    case "api-key":
      return `${finding.where} sets ANTHROPIC_API_KEY, which Claude Code would sign with instead of your login`;
    case "api-key-helper":
      return `${finding.where} sets an apiKeyHelper, whose output Claude Code would send as an API key instead of your login`;
    case "custom-headers-auth":
      return `${finding.where} sets ANTHROPIC_CUSTOM_HEADERS with an x-api-key or a non-login authorization header, which Claude Code would attach to every request`;
    case "unreadable":
      return `${finding.where} could not be read or parsed, so claudish cannot confirm it hands Claude Code no API key`;
    case "auth-token":
    case "base-url":
      return null;
  }
}

/**
 * The Claude subscription is never signed with an Anthropic API key, so a
 * settings layer that would hand the child one REFUSES the launch, naming every
 * such file; it is never a warning that spawns anyway. A settings
 * ANTHROPIC_AUTH_TOKEN is not refused here (it is not the API key, and the
 * proxy refuses each request it signs that is not a login), and a settings
 * ANTHROPIC_BASE_URL is a notice: it moves where the login's requests go, not
 * which credential signs them.
 *
 * `bareName`: the launch named a bare Claude model, so the user may also opt
 * into API billing instead.
 */
export function subscriptionSettingsCheck(
  findings: readonly SettingsFinding[],
  opts: { bareName: boolean }
): SubscriptionSettingsCheck {
  const clauses: string[] = [];
  const files: string[] = [];
  const notices: string[] = [];
  for (const finding of findings) {
    const clause = refusedClause(finding);
    if (clause) {
      clauses.push(clause);
      if (!files.includes(finding.where)) files.push(finding.where);
    } else if (finding.kind === "base-url") {
      notices.push(
        `${finding.where} sets ANTHROPIC_BASE_URL, so this session's requests bypass claudish`
      );
    }
  }
  if (clauses.length === 0) return { refusal: null, notices };
  const remedy =
    `Remove ${clauses.length === 1 ? "it" : "them"} from ${files.join(", ")}, or use ` +
    `anthropic@<id> for the Claude API${opts.bareName ? ", or pass --anthropic-api-billing" : ""}.`;
  return { refusal: `Claude subscription: ${clauses.join("; ")}. ${remedy}`, notices };
}

/** True when `spec` names a bare Claude model, not `claude@` before one. */
export function isBareClaudeName(spec: string): boolean {
  return nativeRouteFor(spec) !== null && !parseModelSpec(spec).isExplicitProvider;
}
