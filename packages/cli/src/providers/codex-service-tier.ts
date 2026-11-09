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
 * A tier id is upstream text. It is named in a log line or a refusal only when
 * it has the shape of a short identifier; anything else (a long opaque value
 * could be a credential echoed back) is never printed. It may still be sent:
 * the request goes back to the host that listed it.
 */
const PRINTABLE_TIER_ID = /^[A-Za-z0-9_-]{1,32}$/;

function printableTierId(id: string): string {
  return PRINTABLE_TIER_ID.test(id) ? `"${id}"` : "(unprintable id)";
}

/** The offered tiers for a refusal: printable ids, and a count of the rest. */
function describeOffered(tiers: CodexServiceTier[] | undefined): string {
  const ids = (tiers ?? []).map((t) => t.id);
  const printable = ids.filter((id) => PRINTABLE_TIER_ID.test(id));
  const hidden = ids.length - printable.length;
  const parts = hidden > 0 ? [...printable, `${hidden} unprintable id(s)`] : printable;
  return parts.join(", ") || "none";
}

/**
 * The tier for `speed` among the account's `service_tiers`, matched by id or
 * by name. claudish's `fast` (Claude Code's `/fast`, `#fast`) is the tier the
 * account's dynamic models catalog itself names "Fast".
 */
export function findCodexServiceTier(
  speed: WireSpeed,
  tiers: CodexServiceTier[] | undefined
): CodexServiceTier | undefined {
  if (!tiers) return undefined;
  const matches = (tier: CodexServiceTier) =>
    tier.id === speed || tier.name.toLowerCase() === speed;
  return tiers.find(matches);
}

/**
 * Decide one request's `service_tier` from the account's `/models` entry.
 * `"unsigned"`: no subscription account signed the request (the api-key arm),
 * so there is no account whose dynamic models catalog could be asked.
 */
export function decideCodexSpeed(
  speed: { value: WireSpeed; explicit: boolean },
  modelInfo: CodexModelInfo | undefined | "unsigned"
): CodexSpeedOutcome {
  if (speed.value === "standard") {
    return { note: "speed standard: field omitted (connection default)" };
  }
  if (modelInfo === "unsigned") {
    const message = `speed "${speed.value}" is not available on this connection (no subscription account signed the request)`;
    return speed.explicit ? { note: message, refusal: message } : { note: message };
  }
  const tier = findCodexServiceTier(speed.value, modelInfo?.serviceTiers);
  if (tier) {
    return {
      tier: tier.id,
      note: `speed ${speed.value}: ${CODEX_SERVICE_TIER_POINTER} = ${printableTierId(tier.id)} (from the account's dynamic models catalog)`,
    };
  }
  const message = modelInfo
    ? `speed "${speed.value}" is not offered on this connection (offered: ${describeOffered(modelInfo.serviceTiers)})`
    : `speed "${speed.value}" is not available on this connection (the account's dynamic models catalog did not answer; retry)`;
  return speed.explicit ? { note: message, refusal: message } : { note: message };
}
