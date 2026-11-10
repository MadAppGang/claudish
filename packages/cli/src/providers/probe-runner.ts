import { hasProviderPrefix } from "./model-parser.js";
import { type ProbeLinkInput, type ProbeResult, probeLink } from "./probe-live.js";
import type { CandidateOutcome, ExplainedCandidate, RouteExplanation } from "./routing-rules.js";

// Interactive probes must outlive the slowest legitimate credential path.
// Antigravity may spend up to 40s refreshing the shared token, and its own
// bounded 429 retries can take ~27s. The old 15s UI deadline cut either path
// off and reported a timeout before the provider returned an attributable
// result. CLI --probe remains independently configurable via --probe-timeout.
export const INTERACTIVE_PROBE_TIMEOUT_MS = 60_000;

export function pinProbeModelSpec(link: Pick<ProbeLinkInput, "provider" | "modelSpec">): string {
  // native-anthropic is the ONE provider the proxy resolves by the ABSENCE of a
  // provider@ prefix (isNative = no "/" and no "@" → nativeHandler). Prefixing
  // it would set hasExplicitProvider=true and route it AWAY from the passthrough
  // (→ "not a valid model ID"). So keep its model spec BARE.
  if (link.provider === "native-anthropic") return link.modelSpec;
  // A spec names its provider only when text comes before its first "@". A wire
  // id may itself start with "@" (OpenRouter presets: "@preset/x"), and that
  // id still needs the provider in front of it.
  return hasProviderPrefix(link.modelSpec) ? link.modelSpec : `${link.provider}@${link.modelSpec}`;
}

/** A candidate the routing chain did not keep. */
export type DroppedOutcome = Exclude<CandidateOutcome, "kept">;

/**
 * What a display says about a dropped candidate, in place of a probe result.
 * Strings only: a display picks the colour from `C.*` at render time.
 */
export const DROPPED_LABEL: Record<DroppedOutcome, string> = {
  "no-credential": "no credential",
  "credential-unreadable": "credential could not be read",
  "not-served": "account does not serve it",
  "excluded-by-membership": "not in the plan's membership",
  "excluded-by-content-use": "contributor id: content-use opt-in, type it exactly to use it",
  "unknown-provider": "unknown provider shortcut",
  "gateway-id-unknown": "withheld",
};

/**
 * The remedy a dropped candidate's credential hint names. An environment variable
 * name reads as an instruction (`set KIMI_API_KEY`); any other hint is already a
 * sentence (a Vertex project source, "enable local provider in global config").
 */
export function droppedRemedy(credentialHint: string | undefined): string | undefined {
  if (!credentialHint) return undefined;
  return /^[A-Z][A-Z0-9_]*$/.test(credentialHint) ? `set ${credentialHint}` : credentialHint;
}

/** A dropped candidate's outcome, with the sentence that outcome carries when it has one. */
export function droppedStatus(outcome: DroppedOutcome, detail?: string): string {
  return detail ? `${DROPPED_LABEL[outcome]}: ${detail}` : DROPPED_LABEL[outcome];
}

/** One line for a dropped candidate: its outcome, then the remedy when one is known. */
export function describeDropped(
  outcome: DroppedOutcome,
  credentialHint?: string,
  detail?: string
): string {
  const status = droppedStatus(outcome, detail);
  const remedy = droppedRemedy(credentialHint);
  return remedy ? `${status} · ${remedy}` : status;
}

/** One hop a probe sends a request down: a kept candidate and the model spec to send. */
export type ProbeTarget = ExplainedCandidate & {
  /** The model spec the probe request carries through the proxy. */
  probeSpec: string;
  /** `"routed"` for a hop of a bare name's routing chain; absent for an explicit spec. */
  hopOrigin?: "routed";
};

/**
 * The hop origin of every hop in one explanation. A catalog-gathered chain and a
 * user rule's chain are both built by the proxy's routing step, whose hops are
 * routed (`hopOrigin: "routed"`); an explicit spec is a one-hop chain under RB-2;
 * a native target has no hop to send.
 */
export function probeHopOriginFor(explanation: RouteExplanation): "routed" | undefined {
  return explanation.source === "catalog" || explanation.source === "user-rule"
    ? "routed"
    : undefined;
}

/**
 * The hops a probe sends requests down: the KEPT candidates, in chain order.
 *
 * A dropped candidate is never probed. The routing chain will not use it, so a
 * probe result for it would describe a request no session makes; a display lists
 * it with its outcome instead. A native target has no candidates, so it has no
 * targets: its link is reported as not probed (`NATIVE_NOT_PROBED`, native-route.ts).
 *
 * An explicit target is probed as TYPED (`kc@kimi-k3`, `poe:x`,
 * `anthropic/claude-opus-5`), because that string is what a session sends and the
 * proxy serves it past its gate without `route()`. Every other hop is pinned to
 * its own provider, so each hop of a routed chain is probed on its own.
 *
 * Every hop of a bare name's routing chain carries `hopOrigin: "routed"`, which
 * `probeLink` sends as a header, so the probe proxy builds the hop as real traffic
 * does. Only the explicit target is held to RB-2.
 *
 * `probeSpec` is final: send it with `probeLink`, not `probeProviderRoute`, whose
 * second pinning would turn `poe:x` into `poe@poe:x`.
 */
export function probeTargets(explanation: RouteExplanation): ProbeTarget[] {
  const hopOrigin = probeHopOriginFor(explanation);
  return explanation.candidates
    .filter((candidate) => candidate.outcome === "kept")
    .map((candidate) => ({
      ...candidate,
      probeSpec:
        explanation.source === "explicit"
          ? explanation.requestedModel
          : pinProbeModelSpec(candidate),
      ...(hopOrigin ? { hopOrigin } : {}),
    }));
}

export function probeProviderRoute(
  proxyUrl: string,
  link: ProbeLinkInput,
  timeoutMs: number
): Promise<ProbeResult> {
  return probeLink(
    proxyUrl,
    {
      ...link,
      modelSpec: pinProbeModelSpec(link),
    },
    timeoutMs
  );
}
