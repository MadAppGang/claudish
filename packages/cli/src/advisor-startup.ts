/**
 * `--advisor` startup: the refusals and the notice.
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
 *   4. ANY panel model whose credential does not resolve. Each panel model
 *      calls one host with one metered key (never a subscription); a missing
 *      key is known now, so it is refused now rather than returning an error
 *      section on every advisor call.
 *   5. A collector the user NAMED whose credential does not resolve. A
 *      DEFAULTED collector (`haiku`, supplied by parseAdvisorFlag) is instead
 *      dropped — see `decideAdvisorStartup`.
 *
 * Which host and which credential a model uses is NOT decided here: it is the
 * advisor call path's own routing (`advisorRouteFor`, native-handler-advisor.ts),
 * so startup and runtime cannot drift apart. Credentials are resolved through
 * the credential authority — env, config, keychain, 1Password — exactly as the
 * runtime resolves them; an `--advisor` launch is their point of need.
 *
 * Everything that decides is exported and side-effect free
 * (`decideAdvisorStartup` and its helpers). The only I/O is credential
 * resolution, isolated in `resolveAdvisorCredentials` and injectable into
 * `evaluateAdvisorStartup`. Printing, exiting and applying the effective
 * collector belong to the caller (index.ts).
 *
 * Output channel: the caller writes the notice to STDERR before the child
 * spawns. In `-p` mode stdout carries Claude Code's (often machine-readable)
 * output and nothing else; see ai-docs/architecture/headless-vs-interactive.md.
 * Terminal isolation (terminal-isolation.ts) is not active yet at that point, so
 * the write reaches the terminal instead of being diverted to the log.
 */

import { OllamaAPIFormat } from "./adapters/ollama-api-format.js";
import type { AdvisorToolEnv } from "./claude-runner.js";
import { ADVISOR_TOOL_ENV_VAR } from "./claude-runner.js";
import {
  ADVISOR_AUTHORITY_PROVIDER,
  type AdvisorRoute,
  type AdvisorRouteKind,
  advisorRouteFor,
  resolveAdvisorCredential,
} from "./handlers/native-handler-advisor.js";
import { parseModelSpec } from "./providers/model-parser.js";
import { nativeRouteFor } from "./providers/native-route.js";
import { type TransportType, getProviderByName } from "./providers/provider-definitions.js";
import { resolveModelProvider } from "./providers/provider-resolver.js";
import type { ClaudishConfig } from "./types.js";

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
// Advisor routing — owned by the advisor call path, NOT by this file
// ---------------------------------------------------------------------------

/** The credential an advisor call signs with. */
export type AdvisorCredential = AdvisorRouteKind;

/** Where one advisor model's request goes; the call path's own type. */
export type { AdvisorRoute };

export type AdvisorRole = "panel" | "collector";

/**
 * The ONE place this module asks where an advisor model is sent. It is the
 * advisor call path's own routing (`advisorRouteFor`), so the host and the
 * credential startup checks are the ones the first advisor call will use.
 *
 * The credential SET is still computed here, not by `advisorCredentialsFor`:
 * that one counts the collector only when the panel has more than one model
 * (the only case in which it runs), while startup checks a collector the user
 * named whatever the panel size.
 */
export function routeAdvisorModel(modelSpec: string, role: AdvisorRole): AdvisorRoute {
  return advisorRouteFor(modelSpec, role);
}

// ---------------------------------------------------------------------------
// Credentials — presence through the credential authority
// ---------------------------------------------------------------------------

/**
 * The key's name as a user would set it. Read from the provider definition (the
 * same one the authority registered), except `anthropic`, whose
 * `native-anthropic` definition deliberately carries no env var.
 *
 * The registry name per credential is `ADVISOR_AUTHORITY_PROVIDER`, owned by
 * the advisor call path — the same table its credential lookup reads.
 */
export function advisorCredentialEnvName(credential: AdvisorCredential): string {
  if (credential === "anthropic") return "ANTHROPIC_API_KEY";
  return (
    getProviderByName(ADVISOR_AUTHORITY_PROVIDER[credential])?.apiKeyEnvVar ||
    `a ${credential} API key`
  );
}

/**
 * A second env var the credential ALSO accepts, for the refusal sentence. Only
 * Google has one: `resolveAdvisorCredential` falls back to GOOGLE_API_KEY,
 * which the authority's `google` provider (GEMINI_API_KEY) never reads.
 */
function alsoAcceptedEnvName(credential: AdvisorCredential): string | null {
  return credential === "google" ? "GOOGLE_API_KEY" : null;
}

/** Whether each credential resolved. Booleans only — no secret is kept. */
export type AdvisorCredentialPresence = Partial<Record<AdvisorCredential, boolean>>;

/**
 * Resolve credential PRESENCE for only the credentials this launch needs. The
 * one side-effecting function in this module (it may open 1Password, as the
 * runtime would on the first advisor call); `evaluateAdvisorStartup` takes it
 * as a dependency.
 *
 * It asks `resolveAdvisorCredential`, the advisor call path's OWN lookup, so
 * this check cannot disagree with the runtime about what is callable. Two
 * lookups disagreed before: the runtime accepted GOOGLE_API_KEY and this one
 * did not, so a working Google panel model was refused at launch.
 *
 * PRESENCE ONLY: the resolved value is tested and dropped here — never
 * returned, logged or printed. The api-key half of a credential ALWAYS returns
 * an object (`{headers:{}}`, or one carrying only static non-auth headers), so
 * neither the object nor "some header is non-empty" proves a key (CLAUDE.md);
 * the shared lookup reads the auth headers alone.
 */
export async function resolveAdvisorCredentials(
  needed: ReadonlySet<AdvisorCredential>
): Promise<AdvisorCredentialPresence> {
  const present = async (credential: AdvisorCredential): Promise<boolean> =>
    Boolean(await resolveAdvisorCredential(credential));
  const list = [...needed];
  const results = await Promise.all(list.map(present));
  const out: AdvisorCredentialPresence = {};
  list.forEach((c, i) => {
    out[c] = results[i];
  });
  return out;
}

/** One panel or collector model, as startup sees it. */
export interface AdvisorModelStatus {
  model: string;
  route: AdvisorRoute;
  callable: boolean;
  /** Env-var name of the credential it needs, e.g. `OPENAI_API_KEY`. */
  credentialName: string;
  /**
   * Why this model is uncallable for a reason that is NOT a missing credential
   * — today, an alias the live catalog could not resolve to a wire id
   * (`AdvisorRoute.unresolvedAlias`). Present ⇒ `callable` is false, and this
   * sentence replaces the missing-credential one in the refusal or the notice.
   */
  unresolved?: string;
}

/** Pure: status of one model given its route and credential presence. */
export function advisorModelStatus(
  model: string,
  route: AdvisorRoute,
  presence: AdvisorCredentialPresence
): AdvisorModelStatus {
  const credentialName = advisorCredentialEnvName(route.credential);
  // A key cannot make an unsendable id sendable, so this outranks presence.
  if (route.unresolvedAlias) {
    return {
      model,
      route,
      callable: false,
      credentialName,
      unresolved:
        `${model} is a claudish alias, not a model id ${route.host} accepts, and the model ` +
        "catalog holds no id for it (it is cold or has never been fetched), so claudish would " +
        `have to POST "${route.unresolvedAlias}" verbatim`,
    };
  }
  return {
    model,
    route,
    callable: presence[route.credential] === true,
    credentialName,
  };
}

/** The sentence a refusal uses for a model whose credential is missing. */
export function describeMissingCredential(s: AdvisorModelStatus): string {
  const also = alsoAcceptedEnvName(s.route.credential);
  return (
    `${s.model} calls ${s.route.host} and needs ${s.credentialName}${also ? ` (or ${also})` : ""}; ` +
    "none found in env, config, keychain or 1Password"
  );
}

/** Why a model cannot be called: its own reason when it has one, else the credential. */
function describeUncallable(s: AdvisorModelStatus): string {
  return s.unresolved ?? describeMissingCredential(s);
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
  panelStatus: AdvisorModelStatus[];
  collectorStatus: AdvisorModelStatus | null;
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
    };

/**
 * Pure: the refusals decidable WITHOUT credentials (1–3). Split out so the
 * caller can skip credential lookups — and any 1Password prompt — for a launch
 * that is refused anyway.
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

function describeRoute(s: AdvisorModelStatus): string {
  return `${s.model} -> ${s.route.host} (${s.credentialName}, billed per token)`;
}

/**
 * Pure: refuse, or proceed with the notice lines and the effective collector.
 */
export function decideAdvisorStartup(facts: AdvisorLaunchFacts): AdvisorStartupDecision {
  const early = refusalBeforeCredentials(facts);
  if (early) return { kind: "refuse", reason: early };

  const missingPanel = facts.panelStatus.filter((s) => !s.callable);
  if (missingPanel.length > 0) {
    return {
      kind: "refuse",
      reason:
        `advisor panel model${missingPanel.length > 1 ? "s" : ""} cannot be called: ` +
        `${missingPanel.map(describeUncallable).join("; ")}. ` +
        "Set the key, or remove the model from --advisor.",
    };
  }

  let effectiveCollector = facts.collector;
  let collectorLine = "none";
  const cs = facts.collectorStatus;
  if (cs && !cs.callable) {
    if (!facts.collectorDefaulted) {
      return {
        kind: "refuse",
        reason:
          `collector ${describeUncallable(cs)}. ` +
          'Set the key, name another collector ("a,b:collector"), or end the value with ":" for no collector.',
      };
    }
    // DEFAULTED collector that cannot be called: proceed WITHOUT it rather than
    // refuse. Every multi-model panel with no ":" defaults to `haiku`, and a
    // Claude Code OAuth session usually has no ANTHROPIC_API_KEY — refusing
    // would break the default. Before this rule the same case ended in
    // concatenation too, after a silent 401 from the collector call
    // (fetchMultiModelAdvice's fallback); the end result is unchanged, it is
    // only made visible, and the call that cannot succeed is skipped.
    effectiveCollector = null;
    collectorLine = cs.unresolved
      ? // Same rule, other cause: an alias the catalog could not resolve. Sending
        // it anyway is a guaranteed rejection from the endpoint, so the DEFAULTED
        // collector is dropped here too rather than failing on the first call.
        `none — ${cs.unresolved}; panel answers will be concatenated`
      : `none — the default collector ${cs.model} needs ${cs.credentialName}, which was not ` +
        "found; panel answers will be concatenated";
  } else if (cs) {
    collectorLine = describeRoute(cs);
  }

  const notice: string[] = ["[claudish] --advisor is on for this launch"];
  notice.push("  panel (panel calls never use a subscription):");
  for (const s of facts.panelStatus) notice.push(`    ${describeRoute(s)}`);
  notice.push(`  collector:  ${collectorLine}`);

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
      "cost grows with panel size and transcript length"
  );
  return { kind: "proceed", notice, effectiveCollector };
}

/** Injectable I/O for `evaluateAdvisorStartup`. */
export interface AdvisorStartupDeps {
  resolveCredentials: (
    needed: ReadonlySet<AdvisorCredential>
  ) => Promise<AdvisorCredentialPresence>;
}

/**
 * Gather the facts for this launch and decide. Returns `null` when `--advisor`
 * was not given — the advisor is opt-in per launch (N1), and this reads only
 * the parsed CLI config, never stored config.
 *
 * Credentials are resolved only when the launch survives the credential-free
 * refusals, and only for the credentials the panel and collector use.
 */
export async function evaluateAdvisorStartup(
  config: ClaudishConfig,
  toolEnv: AdvisorToolEnv,
  childEnv: Record<string, string | undefined> = process.env,
  deps: AdvisorStartupDeps = { resolveCredentials: resolveAdvisorCredentials }
): Promise<AdvisorStartupDecision | null> {
  if (!config.advisor) return null;

  const panel = config.advisorModels ?? [];
  const collector = config.advisorCollector ?? null;
  const mainModels = mainModelSpecs(config).map(resolveMainModelFact);

  const early = refusalBeforeCredentials({ childEnv, mainModels, panel });
  if (early) return { kind: "refuse", reason: early };

  // A spec the routing cannot turn into a valid wire id is refused HERE, with
  // the reason the router gave. `advisorRouteFor` throws for exactly that case
  // (e.g. a subscription prefix that is not an OpenRouter vendor namespace and
  // whose model the catalog does not place on OpenRouter); building the invalid
  // id anyway used to pass startup on the strength of the OpenRouter key alone
  // and fail on the first advisor call.
  let panelRoutes: AdvisorRoute[];
  let collectorRoute: AdvisorRoute | null;
  try {
    panelRoutes = panel.map((m) => routeAdvisorModel(m, "panel"));
    collectorRoute = collector ? routeAdvisorModel(collector, "collector") : null;
  } catch (err) {
    return {
      kind: "refuse",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  const needed = new Set<AdvisorCredential>(panelRoutes.map((r) => r.credential));
  if (collectorRoute) needed.add(collectorRoute.credential);
  const presence = await deps.resolveCredentials(needed);

  return decideAdvisorStartup({
    panel,
    collector,
    collectorDefaulted: config.advisorCollectorDefaulted === true,
    mainModels,
    childEnv,
    toolEnv,
    panelStatus: panel.map((m, i) => advisorModelStatus(m, panelRoutes[i], presence)),
    collectorStatus:
      collector && collectorRoute ? advisorModelStatus(collector, collectorRoute, presence) : null,
  });
}
