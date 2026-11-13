/**
 * How a launch talks to Anthropic when its main model is a Claude model: who
 * signs the native requests its proxy forwards, and whether the launch is a
 * monitor session on Claude Code's own login.
 *
 * A launch whose main model is a bare Claude name is the Claude subscription,
 * so its native requests are signed with Claude Code's login only, never with
 * an Anthropic API key (`login-only`), unless the user opted into API billing
 * (`--anthropic-api-billing`). Every other launch keeps the proxy's `inbound`
 * rule, which an absent signing selects.
 *
 * `claude@<id>` names the Claude subscription explicitly. At top level it is a
 * monitor session: Claude Code talks to Anthropic on its own login and the
 * proxy forwards every request unchanged, signed `login-only` whatever the
 * API-billing opt-in says. In a pane child it is the bare `<id>`, the native
 * passthrough a bare slot already takes.
 *
 * Decided in two steps. `decideClaudeLaunch` runs before the launch's catalog
 * verdict and key validation, which must already see `monitor`;
 * `prepareClaudeLaunch` runs after the catalog warm and before the advisor
 * check and the proxy.
 */

import { isClaudishPlaceholderCredential } from "../auth/claudish-placeholder.js";
import {
  type SettingsFinding,
  settingsCredentialFindings,
  wantsAnthropicApiBilling,
} from "../claude-runner.js";
import { LOGIN_ONLY_SIGNING, type NativeSigning } from "../handlers/shared/anthropic-forward.js";
import { isPaneChild } from "../pane/child-env.js";
import { normalizeNativeModelSpec } from "../providers/claude-code-aliases.js";
import { MODEL_CHAIN_SEPARATOR, parseModelSpec } from "../providers/model-parser.js";
import {
  CLAUDE_SUBSCRIPTION_LABEL,
  claudeSubscriptionInner,
  claudeSubscriptionSpecRefusal,
  nativeRouteFor,
} from "../providers/native-route.js";
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

/** True when `spec` is `claude@` before a name: the Claude subscription named explicitly. */
function isClaudeSubscriptionSpec(spec: string): boolean {
  const parsed = parseModelSpec(spec);
  return parsed.isExplicitProvider && parsed.provider === "native-anthropic";
}

/** Whether the launch may go on; when it may, `decideClaudeLaunch` has updated the config. */
export type ClaudeLaunchDecision = { ok: true } | { ok: false; message: string };

export interface DecideClaudeLaunchDeps {
  /** Default `isPaneChild()`: this process is the claudish of a `team` or MCP session pane. */
  paneChild?: boolean;
}

/**
 * Step 1, before the launch's catalog verdict and key validation. Reads the
 * whole `--model` chain (`modelChain`, else `model`) and the four tier fields.
 *
 * - A `claude@` spec the subscription cannot serve (a name Claude Code does not
 *   own, a marker, a `:N` suffix) refuses the launch, and so does `claude@`
 *   inside a chain: the Claude subscription is served by Claude Code itself.
 * - One `claude@X` main model: in a pane child the model becomes the bare `X`;
 *   otherwise the launch becomes a monitor session, `claudeLaunch:
 *   "subscription"`, and `model` keeps the user's spec for every later reader
 *   (the end-of-session card, the advisor notice).
 * - Anything else is left as it is.
 */
export function decideClaudeLaunch(
  config: ClaudishConfig,
  deps: DecideClaudeLaunchDeps = {}
): ClaudeLaunchDecision {
  const specs = config.modelChain ?? (typeof config.model === "string" ? [config.model] : []);
  const tiers = [config.modelOpus, config.modelSonnet, config.modelHaiku, config.modelSubagent];
  for (const spec of [...specs, ...tiers]) {
    if (typeof spec !== "string" || spec.length === 0) continue;
    const refusal = claudeSubscriptionSpecRefusal(spec);
    if (refusal) return { ok: false, message: refusal };
  }
  if (specs.length > 1) {
    const refusal = claudeSubscriptionSpecRefusal(specs.join(MODEL_CHAIN_SEPARATOR));
    return refusal ? { ok: false, message: refusal } : { ok: true };
  }
  const main = specs[0];
  if (main === undefined || !isClaudeSubscriptionSpec(main)) return { ok: true };

  if (deps.paneChild ?? isPaneChild()) {
    config.model = normalizeNativeModelSpec(claudeSubscriptionInner(main));
    return { ok: true };
  }
  config.monitor = true;
  config.claudeLaunch = "subscription";
  return { ok: true };
}

/** A hold on a credential the launch signs with, released when the session ends. */
export interface LaunchLease {
  release(): void;
}

export type PreparedClaudeLaunch =
  | {
      ok: true;
      /** Lines for stderr, printed unless the launch is quiet. */
      banner: string[];
      /** The launch's native signing; absent means the proxy's own `inbound` rule. */
      signing?: NativeSigning;
      lease?: LaunchLease;
    }
  | { ok: false; message: string };

export interface PrepareClaudeLaunchDeps {
  /** Default `settingsCredentialFindings(config, env)`. */
  settingsFindings?: (config: ClaudishConfig, env: NodeJS.ProcessEnv) => SettingsFinding[];
  /** Default `wantsAnthropicApiBilling` (flag, env, config). */
  wantsApiBilling?: (config: ClaudishConfig) => boolean;
  /** Default `process.env`: the launch environment, read for settings and scrubbed of claudish's placeholder key. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Step 2, after the catalog warm and before the advisor check and the proxy.
 *
 * - `claudeLaunch: "subscription"`: Claude Code is given the bare Claude name
 *   (`claudeLaunchModel`; Claude Code resolves its own aliases), a settings
 *   layer that would hand it an API key refuses the launch, an inherited
 *   placeholder `ANTHROPIC_API_KEY` is scrubbed as `--monitor` scrubs it, and
 *   every request is signed `login-only`.
 * - A bare Claude main model without the API-billing opt-in: the same settings
 *   refusal, and `login-only`.
 * - Anything else: no effect.
 */
export async function prepareClaudeLaunch(
  config: ClaudishConfig,
  deps: PrepareClaudeLaunchDeps = {}
): Promise<PreparedClaudeLaunch> {
  const env = deps.env ?? process.env;
  const findingsOf =
    deps.settingsFindings ??
    ((c: ClaudishConfig, e: NodeJS.ProcessEnv) => settingsCredentialFindings(c, e));
  const main = typeof config.model === "string" ? config.model : undefined;

  if (config.claudeLaunch === "subscription" && main) {
    const check = subscriptionSettingsCheck(findingsOf(config, env), { bareName: false });
    if (check.refusal) return { ok: false, message: check.refusal };
    if (isClaudishPlaceholderCredential("ANTHROPIC_API_KEY", env.ANTHROPIC_API_KEY)) {
      delete env.ANTHROPIC_API_KEY;
    }
    config.claudeLaunchModel = normalizeNativeModelSpec(claudeSubscriptionInner(main));
    return {
      ok: true,
      banner: [
        `[claudish] Monitor mode · ${CLAUDE_SUBSCRIPTION_LABEL} · Claude Code's own login`,
        ...noticeLines(check.notices),
      ],
      signing: LOGIN_ONLY_SIGNING,
    };
  }

  const signing = launchSigningFor(
    config,
    deps.wantsApiBilling ? { wantsApiBilling: deps.wantsApiBilling } : {}
  );
  if (signing?.kind !== "login-only" || !main) {
    return signing ? { ok: true, banner: [], signing } : { ok: true, banner: [] };
  }
  const check = subscriptionSettingsCheck(findingsOf(config, env), {
    bareName: isBareClaudeName(main),
  });
  if (check.refusal) return { ok: false, message: check.refusal };
  return { ok: true, banner: noticeLines(check.notices), signing };
}

function noticeLines(notices: readonly string[]): string[] {
  return notices.map((notice) => `[claudish] Note: ${notice}`);
}
