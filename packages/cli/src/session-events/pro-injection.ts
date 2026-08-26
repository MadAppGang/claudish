/**
 * Ultracode → provider-preset payload injection (v1 consumer of the
 * session-event layer).
 *
 * Applied in ComposedHandler step 5a-pre, immediately BEFORE the --model-params
 * merge — precedence is positional, so an explicit user parameter always wins
 * over the injected one.
 *
 * WHAT IS INJECTED IS NOT HARDCODED. Both halves of the fact come from the slim
 * catalog's `routeVariant`: which models a preset applies to (`baseModelId`)
 * and what that preset sets (`preset`, e.g. `reasoning.mode=pro`). A name regex
 * would assert a fact the catalog already knows, and would go stale the moment
 * a vendor ships another pro SKU.
 */

import { lookupVariantPresets } from "../adapters/model-catalog.js";
import { log } from "../logger.js";
import { deepMergeParams, parseModelParams } from "../model-params.js";
import { type SessionEventRegistry, sessionEvents } from "./index.js";

/** A catalog preset resolved for a model, and where it was learned. */
export interface ResolvedPreset {
  /** The params the preset expands to, ready to deep-merge. */
  params: Record<string, unknown>;
  /** The variant model id the preset was read from (e.g. `gpt-5.6-sol-pro`). */
  variantModelId: string;
  /** The serving provider the catalog recorded the preset on. */
  provider?: string;
  /** The raw preset string, for the log line. */
  preset: string;
}

/**
 * The provider-preset this model has on `provider`, if the catalog knows one.
 *
 * Replaces the v1 `/gpt-5.6/` name gate. Returns undefined for a cold cache, a
 * model with no variants, a variant recorded on a DIFFERENT provider, or a
 * preset string that is not parseable `k=v` — every one of which means "no
 * information", which the caller must treat as "do not inject".
 *
 * `provider` is required rather than optional on purpose: a preset is an
 * observation about ONE provider's roster. `reasoning.mode=pro` is recorded
 * against OpenRouter; whether the same parameter reaches the model on another
 * host is unverified, and injecting it there would be a guess.
 */
export function resolveVariantPreset(
  bareModelName: string,
  provider: string,
  cachePath?: string
): ResolvedPreset | undefined {
  for (const variant of lookupVariantPresets(bareModelName, provider, cachePath)) {
    try {
      const params = parseModelParams(variant.preset);
      if (Object.keys(params).length === 0) continue;
      return {
        params,
        variantModelId: variant.modelId,
        provider: variant.provider,
        preset: variant.preset,
      };
    } catch {
      // Unparseable preset vocabulary (not `k=v`) → no information, try the next.
    }
  }
  return undefined;
}

export interface ProInjectionOptions {
  /** The proOnUltracode config gate (default OFF). */
  enabled: boolean;
  /** Claude Code session id from extractSessionId(). undefined = no injection. */
  sessionId: string | undefined;
  /** Bare model name (no provider prefix) — the catalog key for the preset lookup. */
  bareModelName: string;
  /** The serving provider actually being routed to (ProviderTransport.name). */
  provider: string;
  /** Full routed model string, for the log line. */
  targetModel: string;
  /** The incoming Claude request's output_config — the composite-guard input. */
  outputConfig?: { effort?: unknown; format?: unknown } | null;
  /** Test seam — defaults to the process-wide registry. */
  registry?: SessionEventRegistry;
  /** Test seam — catalog cache path. Defaults to ~/.claudish/all-models.json. */
  cachePath?: string;
}

/**
 * Merge the model's catalog provider-preset into the outbound payload when the
 * session is in ultracode. Returns whether it injected. Never throws.
 */
export function applyProInjection(
  requestPayload: Record<string, any>,
  opts: ProInjectionOptions
): boolean {
  try {
    if (!opts.enabled || !opts.sessionId) return false;
    // Composite wire guard (2026-07-15): subagent requests carry the SAME
    // session_id as the main loop (empirically verified — Anthropic exposes no
    // hierarchy metadata, GH#12430), so session state alone over-applies.
    // Ultracode main-loop turns are signed by output_config.effort === "xhigh";
    // subagents send their own configured effort, and auxiliary calls (titling)
    // carry output_config.format (structured output). Residual known gap: a
    // subagent explicitly configured `effort: xhigh` during an ultracode
    // session still gets the preset — narrow and semantically defensible.
    if (opts.outputConfig?.effort !== "xhigh") return false;
    if (opts.outputConfig?.format) return false;
    const registry = opts.registry ?? sessionEvents;
    // Own the session lifecycle here rather than at the call site. getState()
    // returns undefined until a tailer exists, so without these two lines the
    // layer is INERT in production and every gate below is unreachable — the
    // unit tests only passed because the harness called ensureSession itself.
    //
    // Both are cheap to repeat: ensureSession is idempotent (and rate-limits
    // its own misses), sync is a no-op for an unknown session. They run only
    // after the free gates above, so a request that could never inject does no
    // filesystem work. sync() closes the enter-event→request race — the
    // ultracode attachment is written to the transcript moments before the
    // first ultracode request arrives, and poll-interval latency would
    // otherwise lose that first turn.
    registry.ensureSession(opts.sessionId);
    registry.sync(opts.sessionId);
    const state = registry.getState(opts.sessionId);
    if (!state?.ultracodeActive) return false;
    // Capability gate LAST: it is the only gate that touches the filesystem.
    const resolved = resolveVariantPreset(opts.bareModelName, opts.provider, opts.cachePath);
    if (!resolved) return false;
    deepMergeParams(requestPayload, resolved.params);
    log(
      `[SessionEvents] ultracode active → preset ${resolved.preset} for ${opts.targetModel} ` +
        `(catalog variant ${resolved.variantModelId} @ ${resolved.provider}, session ${opts.sessionId})`
    );
    return true;
  } catch {
    return false;
  }
}
