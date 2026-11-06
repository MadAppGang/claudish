/**
 * The speed decision for an `openai-codex` connection whose catalog wire says
 * `speed: unknown` — every `codex-subscription` connection today.
 *
 * The evidence is the account's own dynamic models catalog (`GET
 * /backend-api/codex/models`, `codex-models-discovery.ts`): each model lists
 * the `service_tiers` this account may request, and Codex sends the chosen
 * tier's `id` at the request's top-level `service_tier`. That is entitlement
 * evidence for THIS credential, not a value borrowed from another connection,
 * so it may decide speed where the catalog has no answer. It never overrides
 * an answer: a catalog `supported`, `rejected` or `not_applicable` speed is
 * applied by step 5w as before, and this module is not consulted.
 */

import type { CodexModelInfo, CodexServiceTier } from "./codex-models-discovery.js";
import type { WireSpeed } from "./wire-request.js";

/** The pointer Codex reads the tier from. */
export const CODEX_SERVICE_TIER_POINTER = "/service_tier";

export interface CodexSpeedOutcome {
  /** The tier id to write at `service_tier`; absent → send no field. */
  tier?: string;
  /** Log line for the request. */
  note: string;
  /** Set for an explicit `#<speed>` the account does not offer. */
  refusal?: string;
}

/**
 * The tier for `speed` among the account's `service_tiers`. claudish's `fast`
 * (Claude Code's `/fast`, `#fast`) is the tier Codex itself labels "Fast",
 * whose id is `priority`; any other speed matches a tier by id or by name.
 */
export function findCodexServiceTier(
  speed: WireSpeed,
  tiers: CodexServiceTier[] | undefined
): CodexServiceTier | undefined {
  if (!tiers) return undefined;
  const matches = (tier: CodexServiceTier) =>
    tier.id === speed ||
    tier.name.toLowerCase() === speed ||
    (speed === "fast" && tier.id === "priority");
  return tiers.find(matches);
}

/** Decide one request's `service_tier` from the account's `/models` entry. */
export function decideCodexSpeed(
  speed: { value: WireSpeed; explicit: boolean },
  modelInfo: CodexModelInfo | undefined
): CodexSpeedOutcome {
  if (speed.value === "standard") {
    return { note: "speed standard: field omitted (connection default)" };
  }
  const tier = findCodexServiceTier(speed.value, modelInfo?.serviceTiers);
  if (tier) {
    return {
      tier: tier.id,
      note: `speed ${speed.value}: ${CODEX_SERVICE_TIER_POINTER} = "${tier.id}" (from the account's dynamic models catalog)`,
    };
  }
  const offered = modelInfo?.serviceTiers?.map((t) => t.id).join(", ");
  const message = modelInfo
    ? `speed "${speed.value}" is not offered on this connection (offered: ${offered || "none"})`
    : `speed "${speed.value}" is not available on this connection (the account's dynamic models catalog did not answer; retry)`;
  return speed.explicit ? { note: message, refusal: message } : { note: message };
}
