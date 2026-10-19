/**
 * `--probe`'s view of one routing decision: the chain `route()` calculates, the
 * candidates it dropped, and the fields every renderer shares.
 *
 * Pure: it maps a {@link RouteExplanation} onto the shapes the three renderers
 * read (the `--json` output, the static printer, the probe TUI). Nothing here
 * decides a route or reads a credential — `explainRoute` decided, and the
 * credential remedy is injected ({@link CredentialLookup}) — so a test can build
 * any of the three from an explanation with no network and no environment.
 *
 * The contract the renderers rely on:
 *   - `chain` holds the KEPT candidates in `route()`'s order, and `[]` still means
 *     no route. An explicit target is a one-item chain.
 *   - A native target (no candidates: Claude Code's own auth serves it) is ONE
 *     link that carries `notProbed: "native-auth"`. It is never probed.
 *   - `dropped` holds every other candidate, in chain order, with its outcome.
 *     Dropped candidates are listed, never probed (see `probeTargets`).
 *   - The parser's provider (`nativeProvider`) is not here: it is not a routing
 *     decision, and for a bare non-Claude name it is the internal `auto-route`.
 */

import type { KeyProvenance } from "../providers/api-key-provenance.js";
import type { ProbeResult } from "../providers/probe-live.js";
import type { DroppedOutcome } from "../providers/probe-runner.js";
import type { RouteTier } from "../providers/provider-definitions.js";
import {
  type ExplainedCandidate,
  type RouteExplanation,
  type RouteWarning,
  type RuleScope,
  describeRouteExplanation,
  hopLabel,
} from "../providers/routing-rules.js";
import type { ProbeResultLink } from "./probe-tui-app.js";

/** One link of `--probe`'s chain: a kept hop, or a native target's one not-probed link. */
export interface ProbeChainLink {
  provider: string;
  displayName: string;
  /** Exactly the `Route.modelSpec` the hop becomes; for a native link, what the passthrough sends. */
  modelSpec: string;
  wireId: string;
  position: ExplainedCandidate["position"];
  tier?: RouteTier;
  /** The hop's label: its tier's, `fallback` for the fallback position, or the native auth. */
  label: string;
  /** Confirmed by the account (`serves`), or merely not denied (`unknown`). */
  availability?: ExplainedCandidate["availability"];
  /** Kept hops passed the credential filter, so this is true for every one of them. */
  hasCredentials: boolean;
  credentialHint?: string;
  provenance?: KeyProvenance;
  /** A native link: served on Claude Code's own auth, which this process cannot forward. */
  notProbed?: "native-auth";
  probe?: ProbeResult;
}

/** A candidate the routing chain did not keep, and why. Never probed. */
export interface ProbeDroppedLink {
  provider: string;
  displayName: string;
  wireId: string;
  position: ExplainedCandidate["position"];
  tier?: RouteTier;
  label: string;
  outcome: DroppedOutcome;
  /** The remedy, for a candidate the credential filter dropped. */
  credentialHint?: string;
}

/** Where `--probe` reads a provider's credential remedy and key provenance from. */
export interface CredentialLookup {
  /** The remedy a credential-less row shows (an env var name, or a sentence). */
  hintFor(provider: string): string | undefined;
  /** Where the provider's key comes from, when it is read from an env var. */
  provenanceFor(provider: string): KeyProvenance | undefined;
}

/** The label a native link shows in place of a tier. */
export const NATIVE_LINK_LABEL = "Claude Code's own auth";

/** The kept chain and the dropped candidates of one explanation. */
export function probeChainFrom(
  explanation: RouteExplanation,
  credentials: CredentialLookup
): { chain: ProbeChainLink[]; dropped: ProbeDroppedLink[] } {
  if (explanation.source === "native" && explanation.native) {
    return { chain: [nativeLinkOf(explanation.native)], dropped: [] };
  }
  const chain: ProbeChainLink[] = [];
  const dropped: ProbeDroppedLink[] = [];
  for (const candidate of explanation.candidates) {
    if (candidate.outcome === "kept") chain.push(keptLinkOf(candidate, credentials));
    else dropped.push(droppedLinkOf(candidate, candidate.outcome, credentials));
  }
  return { chain, dropped };
}

/** A native target's one link: what the passthrough sends, never probed. */
function nativeLinkOf(native: NonNullable<RouteExplanation["native"]>): ProbeChainLink {
  return {
    provider: native.provider,
    displayName: native.displayName,
    modelSpec: native.modelSpec,
    wireId: native.modelSpec,
    position: "candidate",
    label: NATIVE_LINK_LABEL,
    hasCredentials: true,
    notProbed: "native-auth",
  };
}

function keptLinkOf(candidate: ExplainedCandidate, credentials: CredentialLookup): ProbeChainLink {
  const provenance = credentials.provenanceFor(candidate.provider);
  return {
    provider: candidate.provider,
    displayName: candidate.displayName,
    modelSpec: candidate.modelSpec,
    wireId: candidate.wireId,
    position: candidate.position,
    ...(candidate.tier !== undefined ? { tier: candidate.tier } : {}),
    label: hopLabel(candidate),
    ...(candidate.availability ? { availability: candidate.availability } : {}),
    hasCredentials: true,
    ...(provenance ? { provenance } : {}),
  };
}

function droppedLinkOf(
  candidate: ExplainedCandidate,
  outcome: DroppedOutcome,
  credentials: CredentialLookup
): ProbeDroppedLink {
  const hint = outcome === "no-credential" ? credentials.hintFor(candidate.provider) : undefined;
  return {
    provider: candidate.provider,
    displayName: candidate.displayName,
    wireId: candidate.wireId,
    position: candidate.position,
    ...(candidate.tier !== undefined ? { tier: candidate.tier } : {}),
    label: hopLabel(candidate),
    outcome,
    ...(hint ? { credentialHint: hint } : {}),
  };
}

/**
 * The Key line text of a credential that is not an env var:
 * `<effectiveLabel>  (<effectiveSource>)`, e.g.
 * `Muse Code borrowed copy · Muse Code Power Usage  (signed this probe request)`.
 * Undefined for an env-var key, whose line the printer builds itself.
 */
export function keyLineText(provenance: KeyProvenance | undefined): string | undefined {
  if (!provenance?.effectiveLabel) return undefined;
  return `${provenance.effectiveLabel}  (${provenance.effectiveSource})`;
}

/** The fields the printer, the TUI and the JSON share, taken from the explanation. */
export interface ProbeRoutingFields {
  routingSource: RouteExplanation["source"];
  /** `describeRouteExplanation`: the one line `--probe` and the config TUI share. */
  routingExplanation: string;
  matchedPattern?: string;
  ruleScope?: RuleScope;
  /** Set when there is no route: `route()`'s reason and hint, verbatim. */
  noRoute?: { reason: string; hint?: string };
  warnings: RouteWarning[];
}

export function routingFieldsFrom(explanation: RouteExplanation): ProbeRoutingFields {
  const { outcome } = explanation;
  return {
    routingSource: explanation.source,
    routingExplanation: describeRouteExplanation(explanation),
    ...(explanation.matchedPattern !== undefined
      ? { matchedPattern: explanation.matchedPattern }
      : {}),
    ...(explanation.ruleScope ? { ruleScope: explanation.ruleScope } : {}),
    ...(outcome.kind === "no-route"
      ? {
          noRoute: {
            reason: outcome.reason,
            ...(outcome.hint !== undefined ? { hint: outcome.hint } : {}),
          },
        }
      : {}),
    warnings: explanation.warnings,
  };
}

/**
 * The TUI's rows for one model: the kept hops in chain order, then one row per
 * dropped candidate carrying its outcome and credential hint. Nothing else — no
 * row is invented for an empty chain; the explanation line says why it is empty.
 */
export function resultLinksFrom(
  chain: ProbeChainLink[],
  dropped: ProbeDroppedLink[]
): ProbeResultLink[] {
  return [
    ...chain.map(
      (link): ProbeResultLink => ({
        provider: link.provider,
        displayName: link.displayName,
        // The id the hop sends, with no redundant provider@ prefix: the row shows
        // displayName + the resolved id only (e.g. "k3", not "kc@k3").
        modelId: link.wireId,
        label: link.label,
        hasCredentials: link.hasCredentials,
        ...(link.credentialHint ? { credentialHint: link.credentialHint } : {}),
        ...(link.notProbed ? { notProbed: link.notProbed } : {}),
        ...(link.probe ? { probe: link.probe } : {}),
        ...withKeyLine(link.provenance),
      })
    ),
    ...dropped.map(
      (entry): ProbeResultLink => ({
        provider: entry.provider,
        displayName: entry.displayName,
        modelId: entry.wireId,
        label: entry.label,
        // Only a not-served candidate proves a credential was read: the credential
        // filter runs before the availability filter, and membership before both.
        hasCredentials: entry.outcome === "not-served",
        ...(entry.credentialHint ? { credentialHint: entry.credentialHint } : {}),
        dropped: entry.outcome,
      })
    ),
  ];
}

function withKeyLine(provenance: KeyProvenance | undefined): { keyLine?: string } {
  const keyLine = keyLineText(provenance);
  return keyLine ? { keyLine } : {};
}
