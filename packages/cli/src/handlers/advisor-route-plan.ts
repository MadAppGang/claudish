/**
 * The routing decision for one `--advisor` spec, made by the function main
 * routing is derived from.
 *
 * `planAdvisorModel` wraps `explainRoute` (providers/routing-rules.ts), the
 * function `route()` itself runs, so a panel member is planned exactly like a
 * main-model request: the same route candidates, the same credential and
 * availability filters, the same tier order. Startup plans every member before
 * the port is bound; the notice, the refusal and the runtime all read that one
 * result, so they cannot disagree.
 *
 * A Claude name is decided BEFORE routing, as the proxy does (`nativeRouteFor`
 * first, CLAUDE.md invariant): `native-anthropic` has no credential store, so
 * `route()` would drop it and degrade the chain to OpenRouter. A Claude member
 * is a call to api.anthropic.com instead, signed with Claude Code's login only
 * on a launch where claudish controls the child's auth (`childAuthControl`,
 * claude-runner.ts), else with an API key, metered.
 *
 * Imports neither the advisor call path nor the proxy (no cycle): the
 * Anthropic-key presence check is passed in by the caller, which owns the one
 * lookup the runtime also uses.
 */

import type { ChildAuthControl, ChildAuthSource } from "../claude-runner.js";
import { ensureCatalogReady } from "../providers/catalog-client.js";
import { nativeRouteFor } from "../providers/native-route.js";
import type { RouteTier } from "../providers/provider-definitions.js";
import {
  type CandidateOutcome,
  type NoRouteCause,
  type RouteExplanation,
  explainRoute,
} from "../providers/routing-rules.js";
import { WireMarkerError, type WireMarkers, splitWireMarkers } from "../providers/wire-markers.js";
import { ANTHROPIC_API_HOST, claudeAdvisorModelFor } from "./advisor-claude-route.js";
import type { HopBilling } from "./shared/call-context.js";
import { isSubscriptionProvider } from "./shared/remote-provider-types.js";

export type AdvisorRole = "panel" | "collector";
export type AdvisorBilling = HopBilling;

/** One kept route candidate of a routed plan. */
export interface AdvisorHop {
  /** claudish provider uid (`ExplainedCandidate.provider`). */
  provider: string;
  /** THE display source for the notice and the records. */
  displayName: string;
  modelSpec: string;
  wireId: string;
  tier?: RouteTier;
  /** `isSubscriptionProvider(provider)` at plan time; the record re-reads it after signing. */
  billing: AdvisorBilling;
}

/** Where a Claude member's API key comes from on a launch without a usable login. */
export type ClaudeApiKeySource = "inbound-x-api-key" | "ANTHROPIC_API_KEY";

export type AdvisorModelPlan =
  | {
      kind: "routed";
      spec: string;
      role: AdvisorRole;
      markers?: WireMarkers;
      explanation: RouteExplanation;
      /** ≥ 1: the kept candidates, in chain order. */
      hops: AdvisorHop[];
      invocationMode: "explicit-model" | "auto-route";
    }
  | {
      kind: "claude-native";
      spec: string;
      role: AdvisorRole;
      /** The resolved Anthropic API id. */
      model: string;
      expectedArm: "claude-login" | "api-key";
      /** Set only for `api-key`: the source that keeps the login off this launch, and where. */
      authSource?: { reason: ChildAuthSource; where: string };
      /** Set only for `api-key`: what the call is expected to sign with. */
      apiKeySource?: ClaudeApiKeySource;
    }
  | {
      kind: "refused";
      spec: string;
      role: AdvisorRole;
      cause:
        | NoRouteCause
        | "wire-marker"
        | "unresolved-alias"
        | "claude-selector"
        | "claude-no-credential"
        | "no-callable-hop";
      reason: string;
      hint?: string;
    };

export interface PlanAdvisorDeps {
  /** This launch's `childAuthControl(config, env)`. */
  childAuth: ChildAuthControl;
  /**
   * Presence of ANTHROPIC_API_KEY through the advisor's own credential lookup
   * (never ANTHROPIC_AUTH_TOKEN, never a placeholder). Asked only for a Claude
   * member that cannot use the login and gets no inbound `x-api-key`.
   */
  anthropicKeyPresent: () => Promise<boolean>;
  /** Default `explainRoute`. */
  explain?: (target: string) => Promise<RouteExplanation>;
  /** Default `ensureCatalogReady`. */
  ensureCatalog?: (timeoutMs: number) => Promise<void>;
  /** Default `isSubscriptionProvider`. */
  isSubscription?: (provider: string) => boolean;
}

/**
 * Sources after which Claude Code itself sends a real `x-api-key`, so a Claude
 * member signs with that and needs no ANTHROPIC_API_KEY of claudish's.
 * `custom-headers` may set either header; it is not refused for a missing key.
 */
const INBOUND_KEY_SOURCES: ReadonlySet<ChildAuthSource> = new Set([
  "user-api-key",
  "settings-api-key",
  "api-key-helper",
  "custom-headers",
]);

/** The catalog wait main routing applies before it routes (`proxy-server.ts` step 2c). */
const CATALOG_WAIT_MS = 5000;

/**
 * Plan one advisor spec. Never writes to stderr; `explanation.warnings` are
 * returned for the notice to print.
 *
 * Decision order: wire markers; a Claude name (native recognition first); the
 * catalog wait; `explainRoute`. Each step exists in main routing; only the
 * composition is new.
 */
export async function planAdvisorModel(
  spec: string,
  role: AdvisorRole,
  deps: PlanAdvisorDeps
): Promise<AdvisorModelPlan> {
  let markers: WireMarkers;
  try {
    markers = splitWireMarkers(spec);
  } catch (err) {
    if (err instanceof WireMarkerError) {
      return { kind: "refused", spec, role, cause: "wire-marker", reason: err.message };
    }
    throw err;
  }
  const model = markers.spec;

  if (nativeRouteFor(model)) return planClaudeMember(spec, role, model, deps);

  await (deps.ensureCatalog ?? ensureCatalogReady)(CATALOG_WAIT_MS);
  const explanation = await (deps.explain ?? ((target: string) => explainRoute(target)))(model);
  const { outcome } = explanation;
  if (outcome.kind === "no-route") {
    return {
      kind: "refused",
      spec,
      role,
      cause: outcome.cause,
      reason: outcome.reason,
      ...(outcome.hint !== undefined ? { hint: outcome.hint } : {}),
    };
  }

  const isSubscription = deps.isSubscription ?? isSubscriptionProvider;
  const hops: AdvisorHop[] = explanation.candidates
    .filter((candidate) => candidate.outcome === "kept")
    .map((candidate) => ({
      provider: candidate.provider,
      displayName: candidate.displayName,
      modelSpec: candidate.modelSpec,
      wireId: candidate.wireId,
      ...(candidate.tier !== undefined ? { tier: candidate.tier } : {}),
      billing: isSubscription(candidate.provider) ? "subscription" : "metered",
    }));
  if (hops.length === 0) {
    // `toRoutePlan` throws for this; an "ok" outcome always keeps one today.
    return {
      kind: "refused",
      spec,
      role,
      cause: "no-callable-hop",
      reason: `routing kept no candidate for "${model}"`,
    };
  }

  return {
    kind: "routed",
    spec,
    role,
    ...(markers.mode || markers.speed ? { markers } : {}),
    explanation,
    hops,
    invocationMode: explanation.source === "explicit" ? "explicit-model" : "auto-route",
  };
}

async function planClaudeMember(
  spec: string,
  role: AdvisorRole,
  model: string,
  deps: PlanAdvisorDeps
): Promise<AdvisorModelPlan> {
  const claude = claudeAdvisorModelFor(model);
  if (claude.refused) {
    return { kind: "refused", spec, role, cause: claude.cause, reason: claude.reason };
  }
  const { childAuth } = deps;
  if (childAuth.controlled) {
    return { kind: "claude-native", spec, role, model: claude.id, expectedArm: "claude-login" };
  }
  const authSource = { reason: childAuth.reason, where: childAuth.where };
  if (INBOUND_KEY_SOURCES.has(childAuth.reason)) {
    return {
      kind: "claude-native",
      spec,
      role,
      model: claude.id,
      expectedArm: "api-key",
      authSource,
      apiKeySource: "inbound-x-api-key",
    };
  }
  if (!(await deps.anthropicKeyPresent())) {
    return {
      kind: "refused",
      spec,
      role,
      cause: "claude-no-credential",
      reason:
        `${spec} is a Claude model; this launch gives the advisor no Claude login ` +
        `(${noLoginPhrase(authSource)}), and no ANTHROPIC_API_KEY was found in env, config, ` +
        "keychain or 1Password. Set the key, run without --model, map a role to Claude " +
        "(--model-haiku haiku), or name it through OpenRouter (or@anthropic/<id>).",
    };
  }
  return {
    kind: "claude-native",
    spec,
    role,
    model: claude.id,
    expectedArm: "api-key",
    authSource,
    apiKeySource: "ANTHROPIC_API_KEY",
  };
}

/** Why a launch has no Claude login the advisor may use, as a clause. */
export function noLoginPhrase(source: { reason: ChildAuthSource; where: string }): string {
  switch (source.reason) {
    case "proxy-auth":
      return "a --model of another provider gives Claude Code claudish's placeholder, not your login";
    case "user-auth-token":
      return "your ANTHROPIC_AUTH_TOKEN is forwarded to Claude Code instead";
    case "user-api-key":
      return "your ANTHROPIC_API_KEY is forwarded to Claude Code instead";
    case "settings-auth-token":
      return `a Claude Code settings file (${source.where}) sets ANTHROPIC_AUTH_TOKEN`;
    case "settings-api-key":
      return `a Claude Code settings file (${source.where}) sets ANTHROPIC_API_KEY`;
    case "api-key-helper":
      return `a Claude Code settings file (${source.where}) names an apiKeyHelper`;
    case "custom-headers":
      return `ANTHROPIC_CUSTOM_HEADERS (${source.where}) sets an auth header`;
  }
}

/** What a user does to put the login back, per source. */
function restoreLoginHint(source: { reason: ChildAuthSource }): string {
  switch (source.reason) {
    case "proxy-auth":
      return "Run without --model, or map a role to Claude (--model-haiku haiku), to use your subscription";
    case "user-auth-token":
      return "Unset ANTHROPIC_AUTH_TOKEN to use your subscription";
    case "user-api-key":
      return "Unset ANTHROPIC_API_KEY to use your subscription";
    default:
      return "Remove it to use your subscription";
  }
}

/** The billing word a notice line uses. */
export function billingWord(billing: AdvisorBilling): string {
  return billing === "subscription" ? "subscription" : "metered, billed per token";
}

/** A `CandidateOutcome` as the notice's "skipped" phrase. */
export const SKIPPED_PHRASE: Readonly<Record<Exclude<CandidateOutcome, "kept">, string>> = {
  "no-credential": "no credential",
  "credential-unreadable": "credential could not be read",
  "not-served": "the account does not serve it",
  "excluded-by-membership": "not in the plan's membership",
  "excluded-by-content-use": "content-use opt-in id only",
};

/**
 * The notice line for a Claude member: where it goes and what signs it. A
 * routed member's line needs its built chain (`describeAdvisorPlan` with a
 * build).
 */
export function describeClaudeAdvisorPlan(
  plan: Extract<AdvisorModelPlan, { kind: "claude-native" }>
): string {
  if (plan.expectedArm === "claude-login") {
    return (
      `${plan.spec} -> ${ANTHROPIC_API_HOST} (subscription: your Claude Code login; if a request ` +
      "carries none: its x-api-key or ANTHROPIC_API_KEY, metered, billed per token)"
    );
  }
  const source = plan.authSource ?? { reason: "proxy-auth" as const, where: "environment" };
  const key =
    plan.apiKeySource === "inbound-x-api-key"
      ? "the x-api-key Claude Code sends, else ANTHROPIC_API_KEY"
      : "ANTHROPIC_API_KEY";
  return (
    `${plan.spec} -> ${ANTHROPIC_API_HOST} (metered, billed per token: ${key}; ` +
    `${noLoginPhrase(source)}, so the advisor never signs with a bearer on this launch. ` +
    `${restoreLoginHint(source)})`
  );
}

/** The refusal sentence for a refused plan. */
export function describeAdvisorRefusal(
  plan: Extract<AdvisorModelPlan, { kind: "refused" }>
): string {
  switch (plan.cause) {
    case "claude-selector":
    case "unresolved-alias":
    case "claude-no-credential":
      return plan.reason;
    default:
      return `${plan.spec}: ${plan.reason}${plan.hint ? ` ${plan.hint}` : ""}`;
  }
}
