/**
 * `--advisor` startup: plan every member, build the routed chains, then refuse
 * or print the notice.
 *
 * Design rule (requirements.md, decided Q3): anything claudish can determine at
 * LAUNCH is a refusal at startup with a named reason and a non-zero exit. Runtime
 * warnings are only for what cannot be known until the child is running. R5
 * forbids the alternative — a session that silently has no advisor looks exactly
 * like one that works.
 *
 * Refusals, in order:
 *   1. `CLAUDE_CODE_DISABLE_ADVISOR_TOOL` is true in the child's environment.
 *      The enable variable does not override it, so no advisor tool is offered.
 *   2. A main-model path whose wire format drops every tool. Decided from the
 *      RESOLVED provider's transport and a probe of that format's
 *      `convertTools`, never from a model list.
 *   3. No panel models.
 *   4. ANY panel member whose plan is refused (routing found no route, a wire
 *      marker error, a Claude selector, a Claude member with no credential)
 *      or whose built chain has no callable hop. Every one is listed.
 *   5. A collector the user NAMED that is refused likewise. A DEFAULTED
 *      collector (`haiku`, supplied by parseAdvisorFlag) is instead dropped —
 *      see `decideAdvisorStartup`.
 *
 * Where a member goes is decided by `planAdvisorModel` (handlers/advisor-route-plan.ts),
 * which wraps `explainRoute`, the function main routing is derived from, and
 * decides a Claude name first, as the proxy does. Each routed member's chain is
 * then BUILT here, before the port is bound, with the getters main routing
 * uses, in a handler set of its own (`requestRole: "advisor"`). The notice, the
 * refusal and the runtime all read those plans and builds, so they cannot
 * disagree, and there is no lazy path. Members are planned, and chains built,
 * strictly one after another: a build may resolve a credential value
 * (1Password, Keychain), and concurrent handshakes are what 1Password refuses.
 *
 * `decideAdvisorStartup` is pure. `evaluateAdvisorStartup` gathers its facts
 * (the planning and building above, injectable for tests) and shuts every
 * built handler down when it refuses. Printing, exiting, applying the
 * effective collector and handing the runtime to the proxy belong to the
 * caller (index.ts).
 *
 * Output channel: the caller writes the notice to STDERR before the child
 * spawns. In `-p` mode stdout carries Claude Code's (often machine-readable)
 * output and nothing else; see ai-docs/architecture/headless-vs-interactive.md.
 * Terminal isolation (terminal-isolation.ts) is not active yet at that point, so
 * the write reaches the terminal instead of being diverted to the log.
 */

import { OllamaAPIFormat } from "./adapters/ollama-api-format.js";
import type { AdvisorToolEnv, ChildAuthControl } from "./claude-runner.js";
import { ADVISOR_TOOL_ENV_VAR, childAuthControl } from "./claude-runner.js";
import type { AdvisorRuntime } from "./handlers/advisor-panel-gateway.js";
import {
  type AdvisorChainBuild,
  type AdvisorModelPlan,
  type AdvisorRole,
  type PlanAdvisorDeps,
  advisorChainKey,
  buildAdvisorChains,
  describeAdvisorPlan,
  describeAdvisorRefusal,
  planAdvisorModel,
  shutdownAdvisorChains,
} from "./handlers/advisor-route-plan.js";
import { type HandlerSet, createHandlerSet } from "./handlers/handler-set.js";
import { resolveAdvisorCredential } from "./handlers/native-handler-advisor.js";
import { parseModelSpec } from "./providers/model-parser.js";
import { nativeRouteFor } from "./providers/native-route.js";
import { type TransportType, getProviderByName } from "./providers/provider-definitions.js";
import { resolveModelProvider } from "./providers/provider-resolver.js";
import { traceSpan } from "./startup-trace.js";
import type { ClaudishConfig } from "./types.js";

export type { AdvisorRole };

/** Claude Code's kill switch for the advisor tool. Wins over the enable variable. */
export const ADVISOR_DISABLE_ENV_VAR = "CLAUDE_CODE_DISABLE_ADVISOR_TOOL";

/**
 * Claude Code's strict boolean reader: `1`, `true`, `yes`, `on` after trim and
 * lowercase are true; EVERYTHING else is false — `"2"`, `"false"`, `""`, unset.
 */
export function isClaudeCodeBoolTrue(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

// ---------------------------------------------------------------------------
// Main-model path — can it carry a tool at all?
// ---------------------------------------------------------------------------

/** The slice of a wire format that decides whether tools survive it. */
export interface ToolSchemaConverter {
  convertTools(claudeRequest: unknown, summarize?: boolean): unknown[];
  getName(): string;
}

/**
 * Pure: does this format put ANY tool on the wire? Probes `convertTools` with a
 * one-tool request shaped like the advisor tool claudish swaps in. An empty
 * result means every tool is stripped (`OllamaAPIFormat.convertTools` returns
 * `[]`), so an advisor tool can never reach the model.
 *
 * Fails OPEN on a throw: a probe that breaks must not block every launch on
 * that path.
 */
export function formatCarriesTools(format: ToolSchemaConverter): boolean {
  try {
    const out = format.convertTools(
      {
        tools: [
          {
            name: "advisor",
            description: "startup probe",
            input_schema: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      },
      false
    );
    return Array.isArray(out) && out.length > 0;
  } catch {
    return true;
  }
}

/**
 * The wire format a transport pins, for transports whose profile builds ONE
 * fixed format regardless of model (`ollamaCloudProfile` → `OllamaAPIFormat`).
 * `null` means the format is chosen per model or per request (every other
 * transport) and all of those convert tools; the path is then treated as
 * tool-capable. Whether the pinned format carries tools is NOT asserted here —
 * `formatCarriesTools` probes it, so a future Ollama format that learns tools
 * lifts the refusal without anyone editing this file.
 */
export function pinnedFormatForTransport(
  transport: TransportType,
  modelName: string
): ToolSchemaConverter | null {
  switch (transport) {
    case "ollamacloud":
      return new OllamaAPIFormat(modelName);
    default:
      return null;
  }
}

/** One main-model candidate, resolved for the notice and the tool check. */
export interface MainModelFact {
  model: string;
  /** Display name of the provider that serves it. */
  providerName: string;
  carriesTools: boolean;
  /** The pinned wire format, when the transport pins one (for the refusal text). */
  wireFormat?: string;
}

/**
 * Resolve the provider and tool capability of one main-model spec, with no
 * network and no credential access.
 *
 * `nativeRouteFor` FIRST, as the proxy does (CLAUDE.md invariant): a bare Claude
 * name is served natively and must never be read through the remote-provider
 * resolver, which would mislabel it.
 */
export function resolveMainModelFact(model: string): MainModelFact {
  const native = nativeRouteFor(model);
  if (native) return { model, providerName: native.displayName, carriesTools: true };

  const resolution = resolveModelProvider(model);
  // toRemoteProvider renames exactly one provider (google → gemini); reverse it
  // to reach the definition, as createHandlerForProvider does.
  const definitionName = resolution.catalogName === "gemini" ? "google" : resolution.catalogName;
  const definition = definitionName ? getProviderByName(definitionName) : undefined;
  const format = definition
    ? pinnedFormatForTransport(definition.transport, resolution.modelName)
    : null;
  // `auto-route` is a bare name route() decides on the first request, so no
  // provider is known yet; `unknown` is a `vendor/` with no known vendor.
  const providerName =
    resolution.category === "unknown" || resolution.category === "auto-route"
      ? "unresolved (routed on the first request)"
      : definition?.displayName || resolution.providerName;
  return {
    model,
    providerName,
    carriesTools: format ? formatCarriesTools(format) : true,
    wireFormat: format?.getName(),
  };
}

/**
 * The main-model specs this launch actually routes: the pinned chain when there
 * is one (every element can serve a turn after a fallback), else `--model`, else
 * — only when no `--model` was given — the profile's tier mappings. Empty means
 * Claude Code picks its own model natively.
 */
export function mainModelSpecs(config: ClaudishConfig): string[] {
  if (config.modelChain && config.modelChain.length > 0) return [...config.modelChain];
  if (config.model) return [config.model];
  const tiers = [config.modelOpus, config.modelSonnet, config.modelHaiku, config.modelSubagent];
  return [...new Set(tiers.filter((m): m is string => typeof m === "string" && m.length > 0))];
}

/** Model identity for the "panel includes the main model" line: provider-free, vendor-free. */
function modelIdentity(spec: string): string {
  const model = parseModelSpec(spec).model.toLowerCase();
  const slash = model.lastIndexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
}

/** Pure: the panel members that are the main model, under the same or another spelling. */
export function panelMembersMatchingMain(panel: string[], mainModels: string[]): string[] {
  const main = new Set(mainModels.map(modelIdentity));
  return panel.filter((p) => main.has(modelIdentity(p)));
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/** Every fact the startup decision reads. Nothing in here needs I/O to inspect. */
export interface AdvisorLaunchFacts {
  panel: string[];
  collector: string | null;
  /** True when `collector` is parseAdvisorFlag's default, not the user's choice. */
  collectorDefaulted: boolean;
  /** Empty = no main model named; Claude Code's own session model serves. */
  mainModels: MainModelFact[];
  /** The environment the child Claude Code will inherit. */
  childEnv: Record<string, string | undefined>;
  toolEnv: AdvisorToolEnv;
  /** Index-aligned with `panel`: each member's startup plan. */
  panelPlans: AdvisorModelPlan[];
  /** The collector's plan; null when no collector was given. */
  collectorPlan: AdvisorModelPlan | null;
  /** Every routed member's built chain, keyed `"<role>:<spec>"` (`advisorChainKey`). */
  builds: ReadonlyMap<string, AdvisorChainBuild>;
  /** The launch's `childAuthControl` decision the Claude plans were made with. */
  childAuth: ChildAuthControl;
}

export type AdvisorStartupDecision =
  | { kind: "refuse"; reason: string }
  | {
      kind: "proceed";
      notice: string[];
      /**
       * The collector the proxy must use. Equals `facts.collector` except when a
       * DEFAULTED collector cannot be called, in which case it is `null`. The
       * caller MUST apply it to the config before the proxy is created.
       */
      effectiveCollector: string | null;
      /** The plans and chains the proxy's panel gateway runs on (no lazy path). */
      runtime: AdvisorRuntime;
    };

/**
 * Pure: the refusals decidable WITHOUT planning (1–3). Split out so the
 * caller can skip routing, credential lookups and handler construction — and
 * any 1Password prompt — for a launch that is refused anyway.
 */
export function refusalBeforeCredentials(
  facts: Pick<AdvisorLaunchFacts, "childEnv" | "mainModels" | "panel">
): string | null {
  const disable = facts.childEnv[ADVISOR_DISABLE_ENV_VAR];
  if (isClaudeCodeBoolTrue(disable)) {
    return (
      `${ADVISOR_DISABLE_ENV_VAR}=${JSON.stringify(disable)} is set in your environment. ` +
      `Claude Code then never offers the advisor tool, and ${ADVISOR_TOOL_ENV_VAR} does not ` +
      `override it. Unset ${ADVISOR_DISABLE_ENV_VAR} to use --advisor.`
    );
  }

  const toolless = facts.mainModels.filter((m) => !m.carriesTools);
  if (toolless.length > 0) {
    const named = toolless
      .map((m) => `${m.model} (${m.providerName}${m.wireFormat ? `, ${m.wireFormat}` : ""})`)
      .join(", ");
    return (
      `the main model path cannot carry tools: ${named} drops every tool from the request, ` +
      "so the advisor tool can never reach the model. Choose a main model on a provider " +
      "that supports tool calls, or drop --advisor."
    );
  }

  if (facts.panel.length === 0) {
    return 'no advisor panel models were given. Use --advisor "model1[,model2][:collector]".';
  }
  return null;
}

/**
 * Pure: why a member cannot be called, or null when it can. A refused plan
 * reads as its refusal; a routed plan whose chain has no callable hop names
 * every hop's outcome. A Claude member is callable once planned: its plan
 * already refused the launch that has no credential for it.
 */
export function advisorMemberRefusal(
  plan: AdvisorModelPlan,
  builds: ReadonlyMap<string, AdvisorChainBuild>
): string | null {
  if (plan.kind === "refused") return describeAdvisorRefusal(plan);
  if (plan.kind === "claude-native") return null;
  const build = builds.get(advisorChainKey(plan.role, plan.spec));
  if (!build) return `${plan.spec}: its chain was not built at startup`;
  if (build.firstCallableHop === null || !build.handler) {
    return describeAdvisorRefusal({ plan, build });
  }
  return null;
}

/**
 * The notice lines for one member: its plan described from its built chain,
 * then each routing warning (a subscription that does not serve the model, or
 * whose credential could not be read) as a `note:` line under it. `route()`
 * prints those per request; nothing prints them for an advisor call.
 */
function memberNoticeLines(
  plan: AdvisorModelPlan,
  builds: ReadonlyMap<string, AdvisorChainBuild>,
  indent: string
): string[] {
  const build =
    plan.kind === "routed" ? builds.get(advisorChainKey(plan.role, plan.spec)) : undefined;
  const lines = [describeAdvisorPlan(plan, build)];
  if (plan.kind === "routed") {
    for (const warning of plan.explanation.warnings) {
      if (warning.type === "rule-problem") continue;
      lines.push(`${indent}  note: ${warning.message}`);
    }
  }
  return lines;
}

/** The `claudish --probe` hint of a refusal: the first refused member's spec. */
function probeHint(specs: string[]): string {
  return `claudish --probe ${specs[0] ?? "<model>"} shows the routing decision`;
}

/**
 * Pure: the collector's part of the decision — refuse a NAMED collector that
 * cannot be called, drop a DEFAULTED one, else keep it — and its notice lines.
 */
function decideCollector(
  facts: Pick<AdvisorLaunchFacts, "collector" | "collectorDefaulted" | "collectorPlan" | "builds">
):
  | { kind: "refuse"; reason: string }
  | { kind: "keep"; effectiveCollector: string | null; lines: string[] } {
  const cp = facts.collectorPlan;
  if (!cp) return { kind: "keep", effectiveCollector: facts.collector, lines: ["none"] };
  const refusal = advisorMemberRefusal(cp, facts.builds);
  if (!refusal) {
    return {
      kind: "keep",
      effectiveCollector: facts.collector,
      lines: memberNoticeLines(cp, facts.builds, "  "),
    };
  }
  if (!facts.collectorDefaulted) {
    return {
      kind: "refuse",
      reason:
        `collector ${refusal}. ` +
        'Name another collector ("a,b:collector"), or end the value with ":" for no collector ' +
        `(${probeHint([cp.spec])}).`,
    };
  }
  // DEFAULTED collector that cannot be called: proceed WITHOUT it rather than
  // refuse. Every multi-model panel with no ":" defaults to `haiku`, and a
  // launch with a non-Claude --model has no Claude login and usually no
  // ANTHROPIC_API_KEY — refusing would break the default. The panel's answers
  // are concatenated instead, as the notice says.
  return {
    kind: "keep",
    effectiveCollector: null,
    lines: [`none — ${refusal}; panel answers will be concatenated`],
  };
}

/**
 * Pure: refuse, or proceed with the notice lines, the effective collector and
 * the runtime the proxy's panel gateway runs on.
 */
export function decideAdvisorStartup(facts: AdvisorLaunchFacts): AdvisorStartupDecision {
  const early = refusalBeforeCredentials(facts);
  if (early) return { kind: "refuse", reason: early };

  const refused = facts.panelPlans
    .map((plan) => ({ plan, reason: advisorMemberRefusal(plan, facts.builds) }))
    .filter((r): r is { plan: AdvisorModelPlan; reason: string } => r.reason !== null);
  if (refused.length > 0) {
    return {
      kind: "refuse",
      reason:
        `advisor panel model${refused.length > 1 ? "s" : ""} cannot be called: ` +
        `${refused.map((r) => r.reason).join("; ")}. ` +
        "Remove the model from --advisor, or fix what the reason names " +
        `(${probeHint(refused.map((r) => r.plan.spec))}).`,
    };
  }

  const collectorDecision = decideCollector(facts);
  if (collectorDecision.kind === "refuse") return collectorDecision;
  const { effectiveCollector, lines: collectorLines } = collectorDecision;
  const cp = facts.collectorPlan;

  const notice: string[] = ["[claudish] --advisor is on for this launch"];
  notice.push("  panel (each model is routed like a main-model request):");
  for (const plan of facts.panelPlans) {
    const [first, ...notes] = memberNoticeLines(plan, facts.builds, "    ");
    notice.push(`    ${first}`, ...notes);
  }
  const [collectorFirst, ...collectorNotes] = collectorLines;
  notice.push(`  collector:  ${collectorFirst}`, ...collectorNotes);

  const main =
    facts.mainModels.length === 0
      ? "your Claude Code session"
      : facts.mainModels.map((m) => `${m.model} via ${m.providerName}`).join(" -> ");
  notice.push(`  main model: ${main}`);

  const envValue = facts.childEnv[ADVISOR_TOOL_ENV_VAR];
  if (facts.toolEnv.source === "inherited") {
    notice.push(
      `  ${ADVISOR_TOOL_ENV_VAR}=${JSON.stringify(envValue ?? "")} inherited from your environment` +
        (isClaudeCodeBoolTrue(envValue)
          ? ""
          : " — Claude Code reads this value as FALSE, so the advisor tool appears only if your main model qualifies for it without the override")
    );
  } else {
    notice.push(`  ${ADVISOR_TOOL_ENV_VAR}=1 set by claudish`);
  }

  const includesMain = panelMembersMatchingMain(
    facts.panel,
    facts.mainModels.map((m) => m.model)
  );
  if (includesMain.length > 0) {
    notice.push(`  note: the panel includes the main model (${includesMain.join(", ")})`);
  }

  notice.push(
    "  cost: each advisor call sends the FULL conversation to every panel model, uncached; " +
      "subscription hops draw on the plan's allowance, metered hops bill per token; " +
      "routing keeps using the last hop that served"
  );
  // Planning ran main routing's credential filter for every routed member:
  // each candidate the chain keeps had its key resolved once, now, not on first
  // use (advisor.md, "Credentials are resolved at launch").
  const routedMembers = [...facts.panelPlans, ...(cp ? [cp] : [])].some(
    (plan) => plan.kind === "routed"
  );
  if (routedMembers) {
    notice.push(
      "  credentials: each routed advisor model's chain had its keys resolved at launch, " +
        "including fallback hops (1Password or Keychain may have been asked once)"
    );
  }

  const plans = new Map<string, AdvisorModelPlan>();
  for (const plan of facts.panelPlans) plans.set(advisorChainKey("panel", plan.spec), plan);
  if (cp && effectiveCollector !== null) plans.set(advisorChainKey("collector", cp.spec), cp);
  return {
    kind: "proceed",
    notice,
    effectiveCollector,
    runtime: { plans, chains: facts.builds, childAuth: facts.childAuth },
  };
}

/** Injectable I/O for `evaluateAdvisorStartup`; every field defaults to the real thing. */
export interface AdvisorStartupDeps {
  /** Default `childAuthControl(config, childEnv)`. */
  childAuth?: ChildAuthControl;
  /** Presence of ANTHROPIC_API_KEY; default the advisor's own lookup, value dropped. */
  anthropicKeyPresent?: () => Promise<boolean>;
  /** Default `planAdvisorModel`. */
  plan?: (spec: string, role: AdvisorRole, deps: PlanAdvisorDeps) => Promise<AdvisorModelPlan>;
  /** Default: a fresh advisor handler set (`requestRole: "advisor"`, no token file). */
  createHandlerSet?: () => HandlerSet;
  /** Default `buildAdvisorChains`. */
  buildChains?: (
    plans: readonly Extract<AdvisorModelPlan, { kind: "routed" }>[],
    set: HandlerSet
  ) => Promise<Map<string, AdvisorChainBuild>>;
  /** Default `shutdownAdvisorChains`. */
  shutdownChains?: (builds: Iterable<AdvisorChainBuild>) => Promise<void>;
}

/** Presence only: the resolved value is tested and dropped here, never returned or printed. */
async function anthropicKeyPresent(): Promise<boolean> {
  return Boolean(await resolveAdvisorCredential("anthropic"));
}

/**
 * Gather the facts for this launch and decide. Returns `null` when `--advisor`
 * was not given — the advisor is opt-in per launch (N1), and this reads only
 * the parsed CLI config, never stored config.
 *
 * Planning and building run only when the launch survives the refusals that
 * need no planning, and strictly in order: every member's plan (panel, then
 * collector, each in its own trace span), then every routed member's chain. A
 * refusal shuts down every handler that was built, so nothing outlives it.
 */
export async function evaluateAdvisorStartup(
  config: ClaudishConfig,
  toolEnv: AdvisorToolEnv,
  childEnv: Record<string, string | undefined> = process.env,
  deps: AdvisorStartupDeps = {}
): Promise<AdvisorStartupDecision | null> {
  if (!config.advisor) return null;

  const panel = config.advisorModels ?? [];
  const collector = config.advisorCollector ?? null;
  const mainModels = mainModelSpecs(config).map(resolveMainModelFact);

  const early = refusalBeforeCredentials({ childEnv, mainModels, panel });
  if (early) return { kind: "refuse", reason: early };

  const childAuth = deps.childAuth ?? childAuthControl(config, childEnv as NodeJS.ProcessEnv);
  const planDeps: PlanAdvisorDeps = {
    childAuth,
    anthropicKeyPresent: deps.anthropicKeyPresent ?? anthropicKeyPresent,
  };
  const plan = deps.plan ?? planAdvisorModel;

  const panelPlans: AdvisorModelPlan[] = [];
  for (const [i, spec] of panel.entries()) {
    panelPlans.push(
      await traceSpan(`startup:advisor-plan:panel:${i}`, () => plan(spec, "panel", planDeps))
    );
  }
  const collectorPlan = collector
    ? await traceSpan("startup:advisor-plan:collector:0", () =>
        plan(collector, "collector", planDeps)
      )
    : null;

  const routed = [...panelPlans, ...(collectorPlan ? [collectorPlan] : [])].filter(
    (p): p is Extract<AdvisorModelPlan, { kind: "routed" }> => p.kind === "routed"
  );
  const set =
    deps.createHandlerSet?.() ??
    createHandlerSet({
      requestRole: "advisor",
      // No token file is written for this set, so the port is never read.
      port: 0,
      isInteractive: config.interactive,
      // The notice describes each member; an `[Auto-route]` line would repeat it.
      quiet: true,
    });
  const builds =
    routed.length > 0
      ? await traceSpan("startup:advisor-build", () =>
          (deps.buildChains ?? buildAdvisorChains)(routed, set)
        )
      : new Map<string, AdvisorChainBuild>();

  const decision = decideAdvisorStartup({
    panel,
    collector,
    collectorDefaulted: config.advisorCollectorDefaulted === true,
    mainModels,
    childEnv,
    toolEnv,
    panelPlans,
    collectorPlan,
    builds,
    childAuth,
  });
  if (decision.kind === "refuse") {
    await (deps.shutdownChains ?? shutdownAdvisorChains)(builds.values());
  }
  return decision;
}
