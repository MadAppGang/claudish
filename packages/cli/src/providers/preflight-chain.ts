/**
 * Preflight judges a model by its ROUTING CHAIN, not by its first hop.
 *
 * The MCP `preflight` tool used to plan with `route(model)` and probe only the primary,
 * so a model whose hop 1 failed got "❌" and "Drop or replace before running" even when a
 * later hop would serve it (model-failures-2026-10-21.md, D6). Since 14.0.0 a rejected
 * subscription key advances the chain, which made that wrong more often.
 *
 * {@link preflightModel} walks the kept hops in chain order (`explainRoute` →
 * `probeTargets`, the chain `--probe` shows) and probes each until one serves. A failed
 * hop is followed by the runtime's own decision (`ProbeResult.chainAction`, from
 * `decideHopFailure`, shared with `FallbackHandler`): advance to the next hop, or stop
 * here because a real request would stop here too. Metered hops are probed like any
 * other (a configured key is consent, and the runtime would use that hop); the report
 * names each hop's billing. A native Claude name is never probed (CLAUDE.md: the third
 * outcome): a launch of it takes the Claude subscription. The report names its Claude API
 * route below the table (`anthropic@<id>`, metered on the user's key), which a launch
 * uses only when the caller names it; that route is not probed either, since probing it
 * would spend money on a route the launch does not take. Pure apart from the injected
 * probe and the credential readiness the Claude API note reads.
 */
import { credentials } from "../auth/credentials/authority.js";
import { keySourcesSearched } from "../auth/credentials/key-sources.js";
import { isSubscriptionProvider } from "../handlers/shared/remote-provider-types.js";
import { redactSecrets } from "../redact.js";
import { resolveCredentialProvenance } from "./api-key-provenance.js";
import { bundledListLabel } from "./bundled-list-data.js";
import { resolveExternalId } from "./catalog-client.js";
import { explainRouteSettled } from "./explain-route-settled.js";
import { isLocalProviderName, parseModelSpec } from "./model-parser.js";
import {
  NATIVE_NOT_PROBED,
  type NativeRoute,
  claudeSubscriptionSpecRefusal,
  nativeRouteFor,
} from "./native-route.js";
import { type ProbeChainReason, type ProbeResult, describeProbeState } from "./probe-live.js";
import { type ProbeTarget, probeTargets } from "./probe-runner.js";
import type { NoRouteCause, RouteExplanation } from "./routing-rules.js";
import { shadowedEndpointRefusal } from "./shadowed-endpoint.js";

/** How a hop bills. */
export type HopBilling = "subscription" | "metered" | "local";

/** Why the walker moved on or stopped at a failed hop. */
export type WalkerReason =
  | ProbeChainReason
  /** A non-live result with no `chainAction` (key-missing, any future state): stop. */
  | "no-decision"
  /** The injected probe threw: stop. */
  | "probe-error";

/** One kept hop of a model's routing chain, and what probing it found. */
export interface PreflightHop {
  provider: string;
  displayName: string;
  /** The model spec the probe sends (`provider@wire id`, or the explicit spec as typed). */
  probeSpec: string;
  wireId: string;
  position: "candidate" | "fallback";
  billing: HopBilling;
  /** 1-based position among the kept hops. */
  index: number;
  /** Absent when the hop was not probed; synthesized when the probe threw. */
  result?: ProbeResult;
  /** Set on every failed hop. */
  action?: "advance" | "stop";
  reason?: WalkerReason;
}

/**
 * A Claude model's Claude API route, beside the Claude subscription a launch of
 * the bare name takes. Readiness only: never probed, and no Keychain value read.
 */
export type PreflightClaudeApi =
  /** A key is present; `source` names where (never the value). */
  | { state: "available"; spec: string; source: string }
  | { state: "absent"; searched: string[] }
  /** The 1Password step failed; the Keychain is not read here. */
  | { state: "unreadable"; reason: string }
  /** The catalog publishes no Claude API connection for the model. */
  | { state: "not-in-catalog" };

export type PreflightModelResult = (
  | {
      kind: "native";
      model: string;
      displayName: string;
      modelSpec: string;
      /** A bare Claude name only: absent for `claude@<id>` and a tier alias. */
      claudeApi?: PreflightClaudeApi;
    }
  | { kind: "no-route"; model: string; cause: NoRouteCause; reason: string; hint?: string }
  /** Routing itself threw. */
  | { kind: "route-error"; model: string; message: string }
  /** `probe: false`: the chain, unprobed. */
  | { kind: "planned"; model: string; hops: PreflightHop[] }
  | {
      kind: "served";
      model: string;
      served: PreflightHop;
      failed: PreflightHop[];
      untried: number;
      total: number;
    }
  | {
      kind: "failed";
      model: string;
      failed: PreflightHop[];
      /** The hop where the chain stops; absent when every hop advanced. */
      heldAt?: PreflightHop;
      untried: number;
      total: number;
    }
) & {
  /** Set when this decision read the bundled recommended list. */
  catalogSource?: "bundled";
};

export interface PreflightDeps {
  /** null = `probe: false`: plan only, send nothing. */
  probe: ((target: ProbeTarget) => Promise<ProbeResult>) | null;
  /** Default {@link explainRouteSettled}. */
  explain?: (model: string) => Promise<RouteExplanation>;
  /** Called before each hop is probed (progress reporting). */
  onHop?: (hop: PreflightHop, total: number) => void;
  /** Default {@link describeClaudeApi}. */
  claudeApi?: (native: NativeRoute) => Promise<PreflightClaudeApi>;
}

/** The claudish provider of the Claude API, and the key it signs with. */
const CLAUDE_API_PROVIDER = "anthropic";
const CLAUDE_API_KEY_VAR = "ANTHROPIC_API_KEY";

/**
 * The Claude API route of a native model, from the catalog this process already
 * holds and the key's readiness. Readiness never reads a Keychain value
 * (presence by enumeration) and never prompts for 1Password.
 */
export async function describeClaudeApi(native: NativeRoute): Promise<PreflightClaudeApi> {
  const wireId = resolveExternalId(native.modelSpec, CLAUDE_API_PROVIDER);
  if (!wireId) return { state: "not-in-catalog" };
  const { readiness, detail } = await credentials.describeReadiness(CLAUDE_API_PROVIDER, {
    allowOpPrompt: false,
  });
  if (readiness === "present") {
    return {
      state: "available",
      spec: `${CLAUDE_API_PROVIDER}@${wireId}`,
      source:
        detail ??
        resolveCredentialProvenance(CLAUDE_API_PROVIDER, CLAUDE_API_KEY_VAR).effectiveSource,
    };
  }
  if (readiness === "failed") return { state: "unreadable", reason: detail ?? "unknown error" };
  return { state: "absent", searched: keySourcesSearched() };
}

/** How a provider bills: local, subscription (`isSubscriptionProvider`), else metered. */
export function hopBilling(provider: string): HopBilling {
  if (isLocalProviderName(provider)) return "local";
  return isSubscriptionProvider(provider) ? "subscription" : "metered";
}

function toHop(target: ProbeTarget, index: number): PreflightHop {
  return {
    provider: target.provider,
    displayName: target.displayName,
    probeSpec: target.probeSpec,
    wireId: target.wireId,
    position: target.position,
    billing: hopBilling(target.provider),
    index,
  };
}

/** Walk one model's routing chain, probing hops in order until one serves. */
export async function preflightModel(
  model: string,
  deps: PreflightDeps
): Promise<PreflightModelResult> {
  // A `claude@` spec every launch refuses (a marker, `:N`) is refused here too,
  // before `nativeRouteFor` reads it as the native name inside.
  // So is a spec on a custom endpoint name a Claude builtin took over.
  const claudeRefusal = claudeSubscriptionSpecRefusal(model) ?? shadowedEndpointRefusal([model]);
  if (claudeRefusal) return { kind: "route-error", model, message: claudeRefusal };
  const native = nativeRouteFor(model);
  if (native) {
    // `claude@<id>` names the Claude subscription itself, and a tier alias has no
    // concrete id the Claude API could be asked for.
    const bare = !native.isTierAlias && !parseModelSpec(model).isExplicitProvider;
    const claudeApi = bare ? await (deps.claudeApi ?? describeClaudeApi)(native) : undefined;
    return {
      kind: "native",
      model,
      displayName: native.displayName,
      modelSpec: native.modelSpec,
      ...(claudeApi ? { claudeApi } : {}),
    };
  }

  let explanation: RouteExplanation;
  try {
    explanation = await (deps.explain ?? explainRouteSettled)(model);
  } catch (err) {
    return {
      kind: "route-error",
      model,
      message: redactSecrets(err instanceof Error ? err.message : String(err)),
    };
  }
  const result = await resultForExplanation(model, explanation, deps);
  return explanation.catalogSource === "bundled" ? { ...result, catalogSource: "bundled" } : result;
}

/** A routed model's result: its no-route, or its kept hops walked in chain order. */
async function resultForExplanation(
  model: string,
  explanation: RouteExplanation,
  deps: PreflightDeps
): Promise<PreflightModelResult> {
  const { outcome } = explanation;
  if (outcome.kind === "no-route") {
    return {
      kind: "no-route",
      model,
      cause: outcome.cause,
      reason: outcome.reason,
      ...(outcome.hint !== undefined ? { hint: outcome.hint } : {}),
    };
  }

  const targets = probeTargets(explanation);
  const hops = targets.map((target, i) => toHop(target, i + 1));
  const total = hops.length;
  if (!deps.probe) return { kind: "planned", model, hops };

  const failed: PreflightHop[] = [];
  for (let i = 0; i < hops.length; i++) {
    const hop = hops[i];
    deps.onHop?.(hop, total);
    let result: ProbeResult;
    try {
      result = await deps.probe(targets[i]);
    } catch (err) {
      // The probe itself failed: nothing says a later hop serves, so stop.
      hop.result = {
        state: "network-error",
        latencyMs: 0,
        errorMessage: redactSecrets(err instanceof Error ? err.message : String(err)),
      };
      hop.action = "stop";
      hop.reason = "probe-error";
      failed.push(hop);
      return { kind: "failed", model, failed, heldAt: hop, untried: total - hop.index, total };
    }
    hop.result = result;
    if (result.state === "live") {
      return { kind: "served", model, served: hop, failed, untried: total - hop.index, total };
    }
    if (result.chainAction === "advance") {
      hop.action = "advance";
      hop.reason = result.chainReason;
      failed.push(hop);
      continue;
    }
    // "stop", or no decision at all: stopping never claims a later hop serves on
    // evidence the runtime's rule did not produce.
    hop.action = "stop";
    hop.reason = result.chainAction === "stop" ? result.chainReason : "no-decision";
    failed.push(hop);
    return { kind: "failed", model, failed, heldAt: hop, untried: total - hop.index, total };
  }
  return { kind: "failed", model, failed, untried: 0, total };
}

// ── Rendering ────────────────────────────────────────────────────────────────

/**
 * The Details cell of a preflight "no route" row: the reason, then EVERY line
 * of the plan's hint — for a missing credential that is the same login
 * instruction `--probe` prints. Without it the row read only `No credentials
 * configured for "meta-muse-code".`, which an agent cannot act on.
 *
 * Hints come in two shapes. Most are one remedy sentence (explicit-not-served,
 * catalog-unreadable, …), kept whole. `buildCredentialHint`'s is a header
 * (`No credentials found for "<model>". Options:`) and one line per option.
 * Only a line that REPEATS the reason is dropped, and that header is one: it
 * restates the reason's "no credentials" before the options.
 *
 * One table cell, so the kept lines are joined with ` · ` (a space after a
 * line ending in `:`), whitespace runs collapse, and a `|` is escaped.
 */
export function noRouteCell(reason: string, hint?: string): string {
  const flat = (s: string) => s.replace(/\s+/g, " ").trim();
  const lines = (hint ?? "")
    .split("\n")
    .map(flat)
    .filter((line) => line && !repeatsNoRouteReason(line, flat(reason)));
  // A line ending in ":" introduces the next, so it joins with a space.
  const joined = lines.reduce(
    (acc, line, i) => (i === 0 ? line : `${acc}${lines[i - 1].endsWith(":") ? " " : " · "}${line}`),
    ""
  );
  const cell = joined ? `${reason} ${joined}` : reason;
  return cell.replace(/\|/g, "\\|");
}

/** A hint line that restates the reason: the same text, or the credential hint's header. */
function repeatsNoRouteReason(line: string, reason: string): boolean {
  if (line === reason) return true;
  return (
    // "No credentials configured for …" and "No credentialed providers in …".
    reason.startsWith("No credential") &&
    line.startsWith("No credentials found for ") &&
    line.endsWith("Options:")
  );
}

/** One table cell: no newline, `|` escaped. */
function cellText(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
}

function untriedSuffix(untried: number): string {
  return untried > 0 ? ` (+${untried} untried)` : "";
}

/** What a failed hop's line ends with: where the chain went from there. */
function hopOutcomePhrase(hop: PreflightHop, total: number): string {
  if (hop.reason === "probe-error") return "❌ probe error · chain stops here";
  if (hop.reason === "no-decision") return "chain stops here (no hop decision)";
  if (hop.action !== "advance") return "chain stops here";
  return hop.index < total ? `moved to hop ${hop.index + 1}` : "no hop left";
}

function failedHopLine(model: string, hop: PreflightHop, total: number): string {
  const head = `- \`${model}\` hop ${hop.index}/${total} \`${hop.probeSpec}\` (${hop.billing}): `;
  if (hop.reason === "probe-error") {
    const message = hop.result?.errorMessage ? ` — ${hop.result.errorMessage}` : "";
    return cellText(`${head}${hopOutcomePhrase(hop, total)}${message}`);
  }
  const state = hop.result ? describeProbeState(hop.result) : "not probed";
  return cellText(`${head}❌ ${state} — ${hopOutcomePhrase(hop, total)}`);
}

/** The table row for one model. */
function rowFor(r: PreflightModelResult): string {
  switch (r.kind) {
    case "native":
      return `| \`${r.model}\` | ${r.displayName} | native | ${NATIVE_NOT_PROBED} | \`${r.modelSpec}\` |`;
    case "no-route":
      return `| \`${r.model}\` | — | — | ❌ no route | ${noRouteCell(r.reason, r.hint)} |`;
    case "route-error":
      return `| \`${r.model}\` | — | — | ❌ route error | ${cellText(r.message)} |`;
    case "planned": {
      const first = r.hops[0];
      return `| \`${r.model}\` | ${first.displayName} | ${first.billing} | not probed · hop 1/${r.hops.length} | \`${first.probeSpec}\` |`;
    }
    case "served": {
      const s = r.served;
      return `| \`${r.model}\` | ${s.displayName} | ${s.billing} | ✅ live · hop ${s.index}/${r.total}${untriedSuffix(r.untried)} | \`${s.probeSpec}\` |`;
    }
    case "failed": {
      const status = r.heldAt
        ? `❌ ${r.heldAt.reason === "probe-error" ? "probe error" : cellText(describeProbeState(r.heldAt.result as ProbeResult))} · chain stops at hop ${r.heldAt.index}/${r.total}${untriedSuffix(r.untried)}`
        : `❌ every hop failed (${r.total})`;
      return `| \`${r.model}\` | — | — | ${status} | — |`;
    }
  }
}

/** The note line that names a Claude model's Claude API route, below the table. */
function claudeApiLine(model: string, api: PreflightClaudeApi): string {
  const head = `\`${model}\` — Claude API: `;
  switch (api.state) {
    case "available":
      return cellText(
        `${head}\`${api.spec}\` (metered, ${CLAUDE_API_KEY_VAR} from ${api.source}), used only when named`
      );
    case "absent":
      return cellText(
        `${head}absent — no ${CLAUDE_API_KEY_VAR} (looked in ${api.searched.join(", ")})`
      );
    case "unreadable":
      return cellText(`${head}${CLAUDE_API_KEY_VAR} could not be read: ${api.reason}`);
    case "not-in-catalog":
      return cellText(`${head}the catalog publishes no Claude API connection for this model`);
  }
}

/** The billing a model counts under: the serving hop, or the first hop when not probed. */
function countedBilling(r: PreflightModelResult): HopBilling | undefined {
  if (r.kind === "served") return r.served.billing;
  if (r.kind === "planned") return r.hops[0]?.billing;
  return undefined;
}

/** The Markdown report `preflight` returns. */
export function renderPreflightReport(
  results: PreflightModelResult[],
  opts: { probed: boolean }
): string {
  const ready = results.filter((r) => r.kind === "served" || r.kind === "planned").length;
  const dropped = results.filter(
    (r) => r.kind === "failed" || r.kind === "no-route" || r.kind === "route-error"
  );
  const native = results.filter((r) => r.kind === "native").length;
  const billings = results.map(countedBilling);
  const subCount = billings.filter((b) => b === "subscription").length;
  const meteredCount = billings.filter((b) => b === "metered").length;

  const source = results.some((r) => r.catalogSource === "bundled")
    ? [`No cloud models catalog could be read: routed from the ${bundledListLabel()}.`, ""]
    : [];

  const lines = [
    `# Preflight — ${results.length} model${results.length === 1 ? "" : "s"}`,
    "",
    ...source,
    `**Ready: ${ready}** · **Failed: ${dropped.length}** · ` +
      (native > 0 ? `native (not probed): ${native} · ` : "") +
      `subscription: ${subCount} · metered: ${meteredCount}`,
    "",
    "| Model | Provider | Billing | Status | Model spec |",
    "|---|---|---|---|---|",
    ...results.map(rowFor),
  ];

  // What a launch of a bare Claude name does NOT use, so it is not a table row:
  // the table answers what each launch uses, and that is the Claude subscription.
  const claudeApiLines = results.flatMap((r) =>
    r.kind === "native" && r.claudeApi ? [claudeApiLine(r.model, r.claudeApi)] : []
  );
  if (claudeApiLines.length > 0) lines.push("", ...claudeApiLines);

  const failedHopLines = results.flatMap((r) =>
    r.kind === "served" || r.kind === "failed"
      ? r.failed.map((hop) => failedHopLine(r.model, hop, r.total))
      : []
  );
  if (failedHopLines.length > 0) lines.push("", "Failed hops:", ...failedHopLines);

  if (dropped.length > 0) {
    lines.push(
      "",
      `⚠️ Drop or replace before running: ${dropped.map((r) => `\`${r.model}\``).join(", ")}`
    );
  }
  if (meteredCount > 0) {
    lines.push(
      "",
      `💸 ${meteredCount} model${meteredCount === 1 ? "" : "s"} will be billed PER TOKEN. ` +
        "A bare name can land on a metered provider when the subscription that covers it " +
        "has no credential configured, or when an earlier hop fails — name the provider " +
        "explicitly to pin it."
    );
  }
  if (!opts.probed) {
    lines.push("", "ℹ️ `probe: false` — routing and billing only. Reachability was NOT checked.");
  }
  return lines.join("\n");
}
