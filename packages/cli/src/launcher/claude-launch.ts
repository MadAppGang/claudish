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
 * passthrough a bare slot already takes, pinned to the subscription
 * (`claudeSubscriptionPin`): `login-only` and the key hidden, whatever the
 * opt-in says.
 *
 * `anthropic@<id>` (`a@`, `api@`) names the Claude API. At top level it is a
 * monitor session too: Claude Code holds only claudish's placeholder token and
 * the proxy signs every request with the user's key (`launch-key`), so the key
 * never enters Claude Code's environment, its tool shells, MCP servers or a
 * nested claudish. In a pane child, and inside a chain, it stays a proxied hop
 * claudish signs itself.
 *
 * Decided in two steps. `decideClaudeLaunch` runs before the launch's catalog
 * verdict and key validation, which must already see `monitor`;
 * `prepareClaudeLaunch` runs after the catalog warm and before the advisor
 * check and the proxy.
 */

import { isClaudishPlaceholderCredential } from "../auth/claudish-placeholder.js";
import type { CredentialAuthority } from "../auth/credentials/authority.js";
import {
  type SettingsFinding,
  managedSettingsForcesClaudeAi,
  settingsArgsForcingClaudeAi,
  settingsCredentialFindings,
  wantsAnthropicApiBilling,
} from "../claude-runner.js";
import { LOGIN_ONLY_SIGNING, type NativeSigning } from "../handlers/shared/anthropic-forward.js";
import { isPaneChild } from "../pane/child-env.js";
import { resolveModelNameSync } from "../providers/catalog-client.js";
import { normalizeNativeModelSpec } from "../providers/claude-code-aliases.js";
import { MODEL_CHAIN_SEPARATOR, parseModelSpec } from "../providers/model-parser.js";
import {
  CLAUDE_SUBSCRIPTION_LABEL,
  claudeLaunchMarkerRefusal,
  claudeSubscriptionInner,
  claudeSubscriptionSpecRefusal,
  nativeRouteFor,
} from "../providers/native-route.js";
import { shadowedEndpointRefusal } from "../providers/shadowed-endpoint.js";
import { WireMarkerError, splitWireMarkers } from "../providers/wire-markers.js";
import { acquireSigningLease, redactSecrets } from "../redact.js";
import type { ClaudishConfig } from "../types.js";

export interface LaunchSigningDeps {
  /** Default `wantsAnthropicApiBilling` (flag, env, config). */
  wantsApiBilling?: (config: ClaudishConfig) => boolean;
}

/**
 * The launch's native signing: `login-only` for a bare Claude main model (or
 * `claude@` before one) without the API-billing opt-in, and always for one a
 * pane child was given as `claude@` (`claudeSubscriptionPin`); else undefined,
 * which the proxy reads as `inbound`.
 */
export function launchSigningFor(
  config: ClaudishConfig,
  deps: LaunchSigningDeps = {}
): NativeSigning | undefined {
  const main = config.model;
  if (!main || nativeRouteFor(main) === null) return undefined;
  if (config.claudeSubscriptionPin) return LOGIN_ONLY_SIGNING;
  const wantsApiBilling =
    deps.wantsApiBilling ?? ((c: ClaudishConfig) => wantsAnthropicApiBilling(c));
  return wantsApiBilling(config) ? undefined : LOGIN_ONLY_SIGNING;
}

/**
 * Whether a Claude advisor member of this launch may fall back to
 * ANTHROPIC_API_KEY when its request carries no Claude login. Not on a launch
 * with no main model (plain `--monitor`, `--advisor` alone) unless the user
 * opted into API billing: such a session runs on Claude Code's own credential,
 * the Claude subscription for a login, and is never moved onto the key.
 */
export function advisorKeyLookupAllowed(
  config: ClaudishConfig,
  deps: LaunchSigningDeps = {}
): boolean {
  const tiers = [config.modelOpus, config.modelSonnet, config.modelHaiku, config.modelSubagent];
  const hasMainModel =
    (config.modelChain?.length ?? 0) > 0 ||
    Boolean(config.model) ||
    tiers.some((m) => typeof m === "string" && m.length > 0);
  if (hasMainModel) return true;
  const wantsApiBilling =
    deps.wantsApiBilling ?? ((c: ClaudishConfig) => wantsAnthropicApiBilling(c));
  return wantsApiBilling(config);
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
    case "auth-token":
      return `${finding.where} sets ANTHROPIC_AUTH_TOKEN, which Claude Code would send instead of your login`;
    case "unreadable":
      return `${finding.where} could not be read or parsed, so claudish cannot confirm it hands Claude Code no API key`;
    case "base-url":
      return null;
  }
}

/**
 * The Claude subscription is never signed with an Anthropic API key, so a
 * settings layer that would hand the child one REFUSES the launch, naming every
 * such file; it is never a warning that spawns anyway. A real settings
 * ANTHROPIC_AUTH_TOKEN is refused the same way: Claude Code would send it
 * instead of the login, and every request would then fail naming the wrong
 * cause. A settings ANTHROPIC_BASE_URL is a notice: it moves where the login's
 * requests go, not which credential signs them.
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

/** True when `spec` is `anthropic@`, `a@` or `api@` before a name: the Claude API. */
function isClaudeApiSpec(spec: string): boolean {
  const parsed = parseModelSpec(spec);
  return parsed.isExplicitProvider && parsed.provider === CLAUDE_API_PROVIDER;
}

/** The claudish provider of the Claude API. */
const CLAUDE_API_PROVIDER = "anthropic";

/**
 * The refusal for a top-level Claude API spec that carries a speed or mode
 * marker or a `:N` suffix, or null. Monitor mode forwards Claude Code's own
 * requests, so neither could apply: each would be dropped silently.
 */
function claudeApiLaunchRefusal(spec: string): string | null {
  let markers: ReturnType<typeof splitWireMarkers>;
  try {
    markers = splitWireMarkers(spec);
  } catch (err) {
    if (err instanceof WireMarkerError) return err.message;
    throw err;
  }
  if (markers.mode || markers.speed) return claudeLaunchMarkerRefusal(spec);
  if (/:\d+$/.test(spec)) {
    return `${spec}: a Claude API launch is one Claude Code session on Anthropic's API, so a :N concurrency suffix cannot apply.`;
  }
  return null;
}

/** Whether the launch may go on; when it may, `decideClaudeLaunch` has updated the config. */
export type ClaudeLaunchDecision = { ok: true } | { ok: false; message: string };

export interface DecideClaudeLaunchDeps {
  /** Default `isPaneChild()`: this process is the claudish of a `team` or MCP session pane. */
  paneChild?: boolean;
  /** Default `shadowedEndpointRefusal`: a spec on a custom endpoint name a Claude builtin took over. */
  shadowedEndpointRefusal?: (specs: readonly string[]) => string | null;
}

/**
 * Step 1, before the launch's catalog verdict and key validation. Reads the
 * whole `--model` chain (`modelChain`, else `model`) and the four tier fields.
 *
 * - A spec on a custom endpoint name a Claude builtin took over (`anthropic@`
 *   while `customEndpoints.anthropic` exists) refuses the launch, naming the
 *   rename: it would reach the builtin, not the user's endpoint.
 * - A `claude@` spec the subscription cannot serve (a name Claude Code does not
 *   own, a marker, a `:N` suffix) refuses the launch, and so does `claude@`
 *   inside a chain: the Claude subscription is served by Claude Code itself.
 * - One `claude@X` main model: in a pane child the model becomes the bare `X`
 *   and `claudeSubscriptionPin` is set; otherwise the launch becomes a monitor session, `claudeLaunch:
 *   "subscription"`, and `model` keeps the user's spec for every later reader
 *   (the end-of-session card, the advisor notice).
 * - One `anthropic@X` (`a@X`, `api@X`) main model at top level: a monitor
 *   session, `claudeLaunch: "api"`; a speed or mode marker or a `:N` suffix
 *   refuses it. In a pane child, and inside a chain, it stays a proxied hop.
 * - Anything else is left as it is.
 */
export function decideClaudeLaunch(
  config: ClaudishConfig,
  deps: DecideClaudeLaunchDeps = {}
): ClaudeLaunchDecision {
  const specs = config.modelChain ?? (typeof config.model === "string" ? [config.model] : []);
  const tiers = [config.modelOpus, config.modelSonnet, config.modelHaiku, config.modelSubagent];
  const named = [...specs, ...tiers].filter(
    (spec): spec is string => typeof spec === "string" && spec.length > 0
  );
  const shadowed = (deps.shadowedEndpointRefusal ?? shadowedEndpointRefusal)(named);
  if (shadowed) return { ok: false, message: shadowed };
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
  if (main === undefined) return { ok: true };

  if (isClaudeApiSpec(main)) {
    // A pane child keeps the proxied hop, which honours markers: a headless
    // pane is never given a key, and claudish signs that hop itself.
    if (deps.paneChild ?? isPaneChild()) return { ok: true };
    const refusal = claudeApiLaunchRefusal(main);
    if (refusal) return { ok: false, message: refusal };
    config.monitor = true;
    config.claudeLaunch = "api";
    return { ok: true };
  }

  if (!isClaudeSubscriptionSpec(main)) return { ok: true };

  if (deps.paneChild ?? isPaneChild()) {
    config.model = normalizeNativeModelSpec(claudeSubscriptionInner(main));
    config.claudeSubscriptionPin = true;
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
  /** Default the credential authority: resolves the Claude API launch's key. */
  credentials?: Pick<CredentialAuthority, "resolveForUse">;
  /** Default `managedSettingsForcesClaudeAi()`: the OS managed tier forces the claude.ai login. */
  managedForcesClaudeAi?: () => boolean;
  /** Default `settingsArgsForcingClaudeAi(config)`: the `--settings` values that force it. */
  settingsForcingClaudeAi?: (config: ClaudishConfig) => string[];
  /** Default `resolveModelNameSync(name, "anthropic").resolvedId`: the wire id Claude Code is given. */
  wireIdFor?: (name: string) => string;
}

/**
 * Step 2, after the catalog warm and before the advisor check and the proxy.
 *
 * - `claudeLaunch: "api"`: the key is resolved now, Claude Code is given the
 *   catalog's wire id, and the proxy signs with the key (`launch-key`); the
 *   returned lease keeps the key redacted until the caller releases it, after
 *   the session ends.
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

  if (config.claudeLaunch === "api" && main) {
    return prepareClaudeApiLaunch(config, main, env, deps);
  }

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
    bareName: isBareClaudeName(main) && !config.claudeSubscriptionPin,
  });
  if (check.refusal) return { ok: false, message: check.refusal };
  return { ok: true, banner: noticeLines(check.notices), signing };
}

/**
 * The Claude API launch. Claude Code holds only claudish's placeholder token;
 * the monitor proxy signs every request with the key resolved here, which is
 * held by the returned signing and lease and nowhere else: never in an
 * environment, `config.anthropicApiKey` or a file.
 *
 * Refused before any key is read when Claude Code could not start on it: the OS
 * managed tier, or a `--settings` value, forcing the claude.ai login. Then
 * refused when no source has a key (naming the sources searched) or a vault
 * that has one could not be read (its reason).
 */
async function prepareClaudeApiLaunch(
  config: ClaudishConfig,
  main: string,
  env: NodeJS.ProcessEnv,
  deps: PrepareClaudeLaunchDeps
): Promise<PreparedClaudeLaunch> {
  const managedForcesClaudeAi = deps.managedForcesClaudeAi ?? managedSettingsForcesClaudeAi;
  if (managedForcesClaudeAi()) {
    return {
      ok: false,
      message:
        'your organization\'s managed Claude Code settings force the claude.ai login method (forceLoginMethod: "claudeai"), ' +
        "which a Claude API session cannot start under, and managed settings cannot be overridden. " +
        "Use claude@<id> for the Claude subscription.",
    };
  }
  const forcing = (deps.settingsForcingClaudeAi ?? settingsArgsForcingClaudeAi)(config);
  if (forcing.length > 0) {
    return {
      ok: false,
      message:
        `${forcing.join(", ")} ${forcing.length === 1 ? "sets" : "set"} forceLoginMethod: "claudeai", ` +
        "which overrides the console login a Claude API session starts under. " +
        "Remove it, or use claude@<id> for the Claude subscription.",
    };
  }

  const authority =
    deps.credentials ?? (await import("../auth/credentials/authority.js")).credentials;
  const resolution = await authority.resolveForUse(CLAUDE_API_PROVIDER, {
    allowOpPrompt: config.interactive,
  });
  if (resolution.state === "absent") {
    return {
      ok: false,
      message:
        `No Anthropic API key for the Claude API (looked in ${resolution.searched.join(", ")}). ` +
        "Store one with claudish keychain set ANTHROPIC_API_KEY, or export it.",
    };
  }
  if (resolution.state === "failed") {
    return {
      ok: false,
      message: `The Anthropic API key for the Claude API could not be read: ${redactSecrets(resolution.reason)}`,
    };
  }

  const key = resolution.key;
  // Claude Code is given the wire id the catalog publishes for this model on
  // the Claude API; `model` keeps the user's spec. Resolved before the lease is
  // taken, so a throw here leaves no lease behind.
  const inner = parseModelSpec(main).model;
  const wireIdFor =
    deps.wireIdFor ??
    ((name: string) => resolveModelNameSync(name, CLAUDE_API_PROVIDER).resolvedId);
  const launchModel = wireIdFor(inner);

  const lease = acquireSigningLease();
  lease.add([key]);
  config.claudeLaunchModel = launchModel;
  config.claudeLaunchKeySource = resolution.source;
  // The proxy receives no key of its own on this launch, and the parse-time
  // capture of the launch environment's key is not the one that signs.
  config.anthropicApiKey = undefined;
  if (isClaudishPlaceholderCredential("ANTHROPIC_API_KEY", env.ANTHROPIC_API_KEY)) {
    delete env.ANTHROPIC_API_KEY;
  }

  return {
    ok: true,
    banner: [
      `[claudish] Monitor mode · Claude API · ANTHROPIC_API_KEY from ${resolution.source} · signed by claudish`,
    ],
    signing: { kind: "launch-key", key: () => key },
    lease,
  };
}

function noticeLines(notices: readonly string[]): string[] {
  return notices.map((notice) => `[claudish] Note: ${notice}`);
}
