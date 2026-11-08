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

import type { Context } from "hono";
import type { ChildAuthControl, ChildAuthSource } from "../child-auth-types.js";
import { log } from "../logger.js";
import { ensureCatalogReady } from "../providers/catalog-client.js";
import { nativeRouteFor } from "../providers/native-route.js";
import type { RouteTier } from "../providers/provider-definitions.js";
import {
  type CandidateOutcome,
  type NoRouteCause,
  type RouteExplanation,
  explainRoute,
} from "../providers/routing-rules.js";
import { CatalogPendingHandler, RefusingHandler } from "../providers/wire-handler.js";
import {
  WireMarkerError,
  WireMarkerHandler,
  type WireMarkers,
  splitWireMarkers,
} from "../providers/wire-markers.js";
import { TryInTurnHandler } from "../providers/wire-try-in-turn.js";
import { redactSecrets } from "../redact.js";
import { ANTHROPIC_API_HOST, claudeAdvisorModelFor } from "./advisor-claude-route.js";
import { ComposedHandler } from "./composed-handler.js";
import { type FallbackCandidate, FallbackHandler, isRetryableError } from "./fallback-handler.js";
import type { HandlerSet } from "./handler-set.js";
import { type HopAttempt, type HopBilling, withPlannedHop } from "./shared/call-context.js";
import { isSubscriptionProvider } from "./shared/remote-provider-types.js";
import type { ModelHandler } from "./types.js";

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
 * `custom-headers` is not listed: it counts only when the headers set
 * `x-api-key` (`sendsApiKey`, see `sendsInboundApiKey`).
 */
const INBOUND_KEY_SOURCES: ReadonlySet<ChildAuthSource> = new Set([
  "user-api-key",
  "settings-api-key",
  "api-key-helper",
]);

/**
 * Whether Claude Code sends a real `x-api-key` on this uncontrolled launch.
 * ANTHROPIC_CUSTOM_HEADERS that set only `Authorization` send a bearer the
 * advisor never signs with off a controlled launch, so such a launch needs
 * ANTHROPIC_API_KEY or is refused at startup, not stubbed at every call.
 */
function sendsInboundApiKey(childAuth: Extract<ChildAuthControl, { controlled: false }>): boolean {
  if (childAuth.reason === "custom-headers") return childAuth.sendsApiKey === true;
  return INBOUND_KEY_SOURCES.has(childAuth.reason);
}

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
  if (sendsInboundApiKey(childAuth)) {
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
    case "settings-unreadable":
      return `a ${source.where} value Claude Code receives could not be read, so its auth cannot be ruled out`;
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

/**
 * A hop as a notice names it: its display name and its billing word, the word
 * printed once. Some display names already end in it (`Grok Build
 * (subscription)`), which read `Grok Build (subscription) (subscription)`.
 */
export function hopLabel(displayName: string, billing: AdvisorBilling): string {
  const suffix = `(${billingWord(billing)})`;
  return displayName.toLowerCase().endsWith(suffix.toLowerCase())
    ? displayName
    : `${displayName} ${suffix}`;
}

/** A `CandidateOutcome` as the notice's "skipped" phrase. */
export const SKIPPED_PHRASE: Readonly<Record<Exclude<CandidateOutcome, "kept">, string>> = {
  "no-credential": "no credential",
  "credential-unreadable": "credential could not be read",
  "not-served": "the account does not serve it",
  "excluded-by-membership": "not in the plan's membership",
  "excluded-by-content-use": "content-use opt-in id only",
  "unknown-provider": "unknown provider shortcut",
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

type RoutedPlan = Extract<AdvisorModelPlan, { kind: "routed" }>;
type RefusedPlan = Extract<AdvisorModelPlan, { kind: "refused" }>;

/**
 * The refusal sentence for a refused plan, or for a routed plan whose built
 * chain has no callable hop (every hop's outcome is named).
 */
export function describeAdvisorRefusal(
  refusal: RefusedPlan | { plan: RoutedPlan; build: AdvisorChainBuild }
): string {
  if ("build" in refusal) {
    const { plan, build } = refusal;
    const outcomes = plan.hops.map((hop, i) => {
      const b = build.builds[i];
      const what =
        b?.kind === "refused"
          ? b.message
          : b?.kind === "failed"
            ? `could not be built: ${b.message}`
            : b?.kind === "not-built" || !b
              ? "could not be built"
              : "built, but a refusing hop before it stops the chain";
      return `${hop.displayName}: ${what}`;
    });
    return `${plan.spec}: no hop could be built — ${outcomes.join("; ")}`;
  }
  switch (refusal.cause) {
    case "claude-selector":
    case "unresolved-alias":
    case "claude-no-credential":
      return refusal.reason;
    default:
      return `${refusal.spec}: ${refusal.reason}${refusal.hint ? ` ${refusal.hint}` : ""}`;
  }
}

// ---------------------------------------------------------------------------
// Chains: built once, at startup, from the plan, with main routing's dispatch
// ---------------------------------------------------------------------------

/**
 * What building one planned hop produced. Every handler a getter can return
 * has a case (round-3 A3), and `provider.name` is read only off a
 * `ComposedHandler`, the one type known to have a transport:
 *
 * - `built`: a `ComposedHandler`; `transportName` is its provider's name, the
 *   name its hop-log entries carry.
 * - `built-pending`: a handler whose transport is chosen per request (a
 *   `TryInTurnHandler` for a wire the catalog does not publish, a
 *   `CatalogPendingHandler` while no route registry is readable). The serving
 *   transport is attributed from the hop log at call time.
 * - `refused`: a `RefusingHandler`; asked once at build (no network), and
 *   `chainContinues` is `FallbackHandler`'s own `isRetryableError` on its answer.
 * - `not-built`: the getter returned null.
 * - `failed`: the getter or a profile factory threw; `message` is redacted.
 */
export type HopBuild =
  | { kind: "built"; handler: ModelHandler; transportName: string }
  | {
      kind: "built-pending";
      handler: ModelHandler;
      handlerKind: "try-in-turn" | "catalog-pending" | "other";
    }
  | { kind: "refused"; handler: ModelHandler; message: string; chainContinues: boolean }
  | { kind: "not-built" }
  | { kind: "failed"; message: string };

export interface AdvisorChainBuild {
  /** `"<role>:<spec>"`. */
  key: string;
  /** Index-aligned with `plan.hops`. */
  builds: HopBuild[];
  /** The runtime handler (a `FallbackHandler` when more than one hop runs); null when nothing can run. */
  handler: ModelHandler | null;
  /** Index into `plan.hops` of the first hop a call can reach and that can serve; null ⇒ refusal. */
  firstCallableHop: number | null;
  /** Hop-log provider name → plan hop uid, for every `built` hop. */
  uidByTransportName: ReadonlyMap<string, string>;
}

/** The key a plan's build is stored under. */
export function advisorChainKey(role: AdvisorRole, spec: string): string {
  return `${role}:${spec}`;
}

/**
 * Build every routed plan's chain with the getters main routing uses,
 * STRICTLY SEQUENTIALLY (plans in order, hops in order, each awaited): a
 * getter may resolve a credential value (1Password, Keychain), and concurrent
 * handshakes are what 1Password refuses.
 *
 * Dispatch copies the proxy's: a `poe:` spec → the Poe getter (step 3); an
 * `openrouter` hop → the OpenRouter getter (2c); everything else → the remote
 * getter (2c), and only for an explicit single-hop plan whose remote build
 * returned null, the local getter (steps 4 → 5). A `poe@<wire>` hop therefore
 * goes through the remote getter and the Poe profile, never through the
 * legacy `poe:` strip. No advisor wrapper is ever applied.
 */
export async function buildAdvisorChains(
  plans: readonly RoutedPlan[],
  set: HandlerSet
): Promise<Map<string, AdvisorChainBuild>> {
  const out = new Map<string, AdvisorChainBuild>();
  for (const plan of plans) {
    const key = advisorChainKey(plan.role, plan.spec);
    if (out.has(key)) continue;
    const builds: HopBuild[] = [];
    for (const hop of plan.hops) {
      builds.push(await buildHop(plan, hop, set));
    }
    out.set(key, assembleChain(key, plan, builds));
  }
  return out;
}

async function buildHop(plan: RoutedPlan, hop: AdvisorHop, set: HandlerSet): Promise<HopBuild> {
  const mode = plan.invocationMode;
  let handler: ModelHandler | null;
  try {
    if (hop.modelSpec.startsWith("poe:")) {
      handler = await set.poe(hop.modelSpec, mode);
    } else if (hop.provider === "openrouter") {
      handler = set.openRouter(hop.modelSpec, mode);
    } else {
      handler = await set.remote(hop.modelSpec, mode);
      if (!handler && mode === "explicit-model" && plan.hops.length === 1) {
        handler = set.local(hop.modelSpec, mode);
      }
    }
  } catch (err) {
    const message = redactSecrets(err instanceof Error ? err.message : String(err));
    log(`[advisor] build failed: ${plan.spec} hop ${hop.displayName}: ${message}`);
    return { kind: "failed", message };
  }
  return classifyHandler(handler, hop);
}

/** The refusal text inside a `RefusingHandler`'s answer, without its `claudish: ` prefix. */
function refusalMessageOf(body: string): string {
  try {
    const message = (JSON.parse(body) as { error?: { message?: unknown } }).error?.message;
    if (typeof message === "string") return message.replace(/^claudish: /, "");
  } catch {
    // not JSON: use the body as it is
  }
  return body;
}

async function classifyHandler(handler: ModelHandler | null, hop: AdvisorHop): Promise<HopBuild> {
  if (!handler) return { kind: "not-built" };
  if (handler instanceof RefusingHandler) {
    // Asked once, here: it answers locally and sends nothing.
    const response = await handler.handle();
    const body = await response.text();
    return {
      kind: "refused",
      handler,
      message: refusalMessageOf(body),
      chainContinues: isRetryableError(
        response.status,
        body,
        hop.displayName,
        response.headers,
        hop.provider
      ),
    };
  }
  if (handler instanceof ComposedHandler) {
    return { kind: "built", handler, transportName: handler.getProviderName() };
  }
  const handlerKind =
    handler instanceof TryInTurnHandler
      ? "try-in-turn"
      : handler instanceof CatalogPendingHandler
        ? "catalog-pending"
        : "other";
  return {
    kind: "built-pending",
    handler: new PlannedHopHandler(handler, hop.provider),
    handlerKind,
  };
}

/**
 * A built-pending hop, carrying its planned identity to call time. The
 * transport it serves through is chosen per request, and its name need not be
 * the planned uid (`google` serves through `GeminiProviderTransport`, named
 * `gemini`), so every hop-log entry recorded while this hop runs carries the
 * planned uid (`withPlannedHop` → `recordHopEntry`) rather than being matched
 * back by name. The uid is on the entry from the moment it is pushed, so a
 * timed-out call's snapshot already has it.
 *
 * Wrapping is safe here and nowhere else: `FallbackHandler` reads fallback
 * metadata only off a `ComposedHandler`, and a pending handler is never one.
 */
export class PlannedHopHandler implements ModelHandler {
  constructor(
    readonly inner: ModelHandler,
    readonly plannedUid: string
  ) {}

  handle(c: Context, payload: unknown): Promise<Response> {
    return withPlannedHop(c, this.plannedUid, () => this.inner.handle(c, payload));
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}

function assembleChain(key: string, plan: RoutedPlan, builds: HopBuild[]): AdvisorChainBuild {
  let firstCallableHop: number | null = null;
  for (let i = 0; i < builds.length; i++) {
    const b = builds[i];
    if (b.kind === "refused" && !b.chainContinues) break;
    if (b.kind === "built" || b.kind === "built-pending") {
      firstCallableHop = i;
      break;
    }
  }

  const uidByTransportName = new Map<string, string>();
  const candidates: FallbackCandidate[] = [];
  builds.forEach((b, i) => {
    if (b.kind === "not-built" || b.kind === "failed") return;
    const hop = plan.hops[i];
    // Every runtime hop, a refusing one included, exactly as main routing's
    // step 2c pushes every non-null handler.
    candidates.push({ name: hop.displayName, provider: hop.provider, handler: b.handler });
    if (b.kind === "built" && !uidByTransportName.has(b.transportName)) {
      uidByTransportName.set(b.transportName, hop.provider);
    }
  });

  let handler: ModelHandler | null = null;
  if (firstCallableHop !== null && candidates.length > 0) {
    handler = candidates.length > 1 ? new FallbackHandler(candidates) : candidates[0].handler;
    if (plan.markers) handler = new WireMarkerHandler(handler, plan.markers);
  }
  return { key, builds, handler, firstCallableHop, uidByTransportName };
}

/**
 * The plan hop a hop-log entry belongs to: the planned uid a `built-pending`
 * hop stamped on it (`PlannedHopHandler`), else the build's transport-name map
 * for a `built` hop, else the transport name taken as a uid. Null when none
 * matches.
 */
export function planHopForTransport(
  plan: RoutedPlan,
  build: AdvisorChainBuild,
  entry: Pick<HopAttempt, "provider" | "plannedUid">
): AdvisorHop | null {
  const uid = entry.plannedUid ?? build.uidByTransportName.get(entry.provider) ?? entry.provider;
  return plan.hops.find((hop) => hop.provider === uid) ?? null;
}

/**
 * Shut down every handler a set of builds holds, each once. For a startup
 * that refuses after building, and for the proxy's own shutdown.
 */
export async function shutdownAdvisorChains(builds: Iterable<AdvisorChainBuild>): Promise<void> {
  const handlers = new Set<ModelHandler>();
  for (const build of builds) {
    for (const b of build.builds) {
      if (b.kind === "built" || b.kind === "built-pending" || b.kind === "refused") {
        handlers.add(b.handler);
      }
    }
  }
  for (const handler of handlers) {
    try {
      await handler.shutdown();
    } catch (err) {
      log(`[advisor] handler shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * The `; then …` parts for the hops after the first callable one, up to a
 * refusing hop the chain stops at, and whether any of them bills per token.
 */
function laterHopParts(
  plan: RoutedPlan,
  build: AdvisorChainBuild,
  firstCallableHop: number
): { parts: string[]; metered: boolean } {
  const parts: string[] = [];
  let metered = false;
  for (let i = firstCallableHop + 1; i < plan.hops.length; i++) {
    const b = build.builds[i];
    const hop = plan.hops[i];
    if (b.kind === "refused") {
      const stops = b.chainContinues ? "" : "; the chain stops here";
      parts.push(`; then ${hop.displayName} (refuses: ${b.message}${stops})`);
      if (!b.chainContinues) break;
      continue;
    }
    if (b.kind !== "built" && b.kind !== "built-pending") continue;
    parts.push(`; then ${hopLabel(hop.displayName, hop.billing)}`);
    if (hop.billing === "metered") metered = true;
  }
  return { parts, metered };
}

/**
 * The notice line for any plan. A routed plan is described from its BUILT
 * chain: the first callable hop, every later hop a call can reach, the
 * subscription candidates routing skipped and why, and the hops that could
 * not be built. A refused plan reads as its refusal.
 */
export function describeAdvisorPlan(plan: AdvisorModelPlan, build?: AdvisorChainBuild): string {
  if (plan.kind === "claude-native") return describeClaudeAdvisorPlan(plan);
  if (plan.kind === "refused") return describeAdvisorRefusal(plan);
  if (!build || build.firstCallableHop === null) {
    return build ? describeAdvisorRefusal({ plan, build }) : `${plan.spec} -> (not built)`;
  }

  const first = plan.hops[build.firstCallableHop];
  const later = laterHopParts(plan, build, build.firstCallableHop);
  const parts = [`${plan.spec} -> ${hopLabel(first.displayName, first.billing)}`, ...later.parts];
  const laterMetered = later.metered;

  const skipped = plan.explanation.candidates
    .filter(
      (c) =>
        c.outcome !== "kept" && (c.tier === "subscription" || c.tier === "dynamic-subscription")
    )
    .map(
      (c) => `${c.displayName} — ${SKIPPED_PHRASE[c.outcome as Exclude<CandidateOutcome, "kept">]}`
    );
  if (skipped.length > 0) parts.push(` (skipped: ${skipped.join("; ")})`);

  const notBuilt = plan.hops
    .filter((_, i) => build.builds[i].kind === "not-built" || build.builds[i].kind === "failed")
    .map((hop) => hop.displayName);
  for (const name of notBuilt) parts.push(` (not built: ${name}; see the debug log)`);

  // `FallbackHandler` moves past a rejected subscription credential to the
  // next hop, metered included (routing.md), so a mixed chain says so here;
  // the per-call warning (`warnWhenServedUnlikePlan`) names the hop that served.
  if (first.billing === "subscription" && laterMetered) {
    parts.push(" (if the subscription login is rejected, calls move on to the metered hop)");
  }
  return parts.join("");
}

// ---------------------------------------------------------------------------
// The panel gateway's contract (implemented in advisor-panel-gateway.ts)
// ---------------------------------------------------------------------------

/** One turn of the conversation a panel member is asked about, flattened to text. */
export interface AdvisorTurn {
  role: "user" | "assistant";
  content: string;
}

/** The Anthropic-shaped body a routed panel call sends through its chain. */
export interface AdvisorPanelPayload {
  model: string;
  system: string;
  messages: AdvisorTurn[];
  max_tokens: number;
  stream: false;
}

/**
 * The body of a routed advisor call. Deliberately nothing but these keys: no
 * `tools`, `tool_choice`, `metadata`, `thinking` or `output_config`. Without
 * tools and a session id, code mode stays off (`decideCodeMode`), Layer 4 has
 * no session to drain, and the panel cannot call back into the advisor.
 */
export function buildAdvisorPanelPayload(
  hop0ModelSpec: string,
  system: string,
  turns: AdvisorTurn[],
  maxTokens: number
): AdvisorPanelPayload {
  return { model: hop0ModelSpec, system, messages: turns, max_tokens: maxTokens, stream: false };
}

export interface AdvisorPanelCall {
  plan: RoutedPlan;
  payload: AdvisorPanelPayload;
  /** 60 000 for a panel member, 30 000 for the collector. */
  timeoutMs: number;
}

export interface AdvisorPanelResult {
  /** The answer's HTTP status; null on timeout or an internal error. */
  status: number | null;
  /** The WHOLE body, read inside the deadline and redacted by value. */
  bodyText: string;
  /** `isStreamFailureResponse(response)`: a 200 whose stream ended on an error. */
  streamFailure: boolean;
  /** Snapshot of the hop log: every hop whose `handle()` was entered, in order. */
  hops: Array<HopAttempt & { uid: string | null; displayName: string }>;
  /** The chain's first callable hop at startup: what the notice promised this member. */
  plannedHop?: { provider: string; displayName: string; billing: AdvisorBilling };
  failure?: { kind: "timeout" | "internal"; message: string };
  latencyMs: number;
}

export interface AdvisorPanelGateway {
  /** The startup plan for a spec; a spec the startup map lacks is a refused plan. */
  plan(spec: string, role: AdvisorRole): AdvisorModelPlan;
  /** Run one routed call through its startup-built chain. Never rejects. */
  call(req: AdvisorPanelCall): Promise<AdvisorPanelResult>;
}

// ---------------------------------------------------------------------------
// Advice extraction
// ---------------------------------------------------------------------------

/** Why a 2xx answer carried no advice text. */
export type AdvisorEmptyReason =
  | "no-content"
  | "reasoning-only"
  | "max-tokens-before-text"
  | "max-tokens-during-reasoning";

export interface ExtractedAdvice {
  /** Every `text` block, joined with a blank line and trimmed; absent when empty. */
  text?: string;
  emptyReason?: AdvisorEmptyReason;
  /** The message's `stop_reason`, verbatim. */
  stopReason?: string;
  usage?: { input_tokens: number; output_tokens: number };
}

/**
 * The advice in one Anthropic-shaped message, or the named reason there is
 * none. Every text block counts, not only the first. No text: `max_tokens`
 * with a non-empty thinking block is "max-tokens-during-reasoning", without
 * one "max-tokens-before-text"; otherwise a thinking block makes it
 * "reasoning-only", and nothing at all "no-content".
 */
export function extractAdvice(message: unknown): ExtractedAdvice {
  const m = (message && typeof message === "object" ? message : {}) as {
    content?: unknown;
    stop_reason?: unknown;
    usage?: { input_tokens?: unknown; output_tokens?: unknown };
  };
  const blocks = Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : [];
  const stopReason = typeof m.stop_reason === "string" ? m.stop_reason : undefined;
  const inputTokens = m.usage?.input_tokens;
  const outputTokens = m.usage?.output_tokens;
  const usage =
    typeof inputTokens === "number" && typeof outputTokens === "number"
      ? { input_tokens: inputTokens, output_tokens: outputTokens }
      : undefined;
  const base = {
    ...(stopReason !== undefined ? { stopReason } : {}),
    ...(usage ? { usage } : {}),
  };

  const text = blocks
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n\n")
    .trim();
  if (text) return { text, ...base };

  const thought = blocks.some(
    (b) => b?.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim() !== ""
  );
  let emptyReason: AdvisorEmptyReason;
  if (stopReason === "max_tokens") {
    emptyReason = thought ? "max-tokens-during-reasoning" : "max-tokens-before-text";
  } else {
    emptyReason = thought ? "reasoning-only" : "no-content";
  }
  return { emptyReason, ...base };
}
