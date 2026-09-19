import { catalogRouteMatchesProvider } from "./catalog-route-bindings.js";
/**
 * "Does provider P actually serve model M?" — answered from BOTH data sources.
 *
 * ## Why two sources, and which one wins
 *
 * `catalog-client.ts` states the split this module depends on:
 *
 *   - The cloud catalog owns model IDENTITY — what a model is, what each vendor
 *     calls it. Same for everyone.
 *   - A provider's own live endpoint owns ENTITLEMENT — which subset of those
 *     models THIS key may use. Per-user, and impossible to hold statically.
 *
 * Neither is sufficient alone. Measured 2026-08-18: the catalog's `aggregators[]`
 * vocabulary names 18 providers while claudish routes to 23, and the 10 it never
 * mentions are almost entirely the SUBSCRIPTION providers — `glm-coding`,
 * `minimax-coding`, `qwen-token-plan`, `sakana-subscription`, `devin`,
 * `opencode-zen-go`. That is not a catalog defect: a plan's contents are an
 * entitlement, so they were never in scope for a field describing marketplaces.
 *
 * Live discovery covers exactly that gap, and it is AUTHORITATIVE where it
 * answers — it is the provider replying about the caller's own key.
 *
 * ## Why the result is three-valued
 *
 * `unknown` is not indecision, it is the answer that prevents a catastrophe. If
 * absence of evidence were read as "not served", every provider neither source
 * covers would be dropped from every chain — which for a while would have meant
 * dropping the user's paid subscription in favour of a metered hop. So a
 * candidate is removed only on POSITIVE evidence of exclusion; silence leaves it
 * exactly where it was.
 *
 * ## The case this exists for
 *
 * `deepseek-v4-pro-0813` on a bare chain reaches `opencode-zen-go` first. Zen Go
 * does not carry it and says so with **HTTP 401** — a status that reads as a
 * credential failure, and which masked the live OpenRouter hop further down the
 * same chain. Its live roster answers the question before any request is sent:
 *
 *     Zen Go serves 26 models; 'deepseek-v4-pro-0813' is not among them
 *     (it serves the undated `deepseek-v4-pro`), while 'kimi-k3' is.
 *
 * Note the naming detail — the roster also settles what to SEND, which a
 * membership test against catalog ids alone could not.
 */

import { getCatalogEntries } from "./catalog-client.js";
import { discoverProviderModels, getDiscoveryFailure } from "./model-discovery.js";
import { getProviderByName } from "./provider-definitions.js";

/**
 * - `serves`      — positive evidence this provider carries the model.
 * - `not-served`  — positive evidence it does NOT. The only value a caller may
 *                   act on destructively (dropping a candidate).
 * - `unknown`     — no source could answer. Treat exactly as today's behaviour.
 */
export type ModelAvailability = "serves" | "not-served" | "unknown";

/** Case-insensitive membership, since rosters disagree on casing (`MiniMax-M3`). */
function rosterHas(ids: string[], wireId: string): boolean {
  const needle = wireId.trim().toLowerCase();
  return ids.some((id) => id.trim().toLowerCase() === needle);
}

/**
 * Whether `provider` serves `wireId` — the id that would actually be SENT, not
 * the name the user typed. Callers hold the resolved spec already
 * (`buildRoutingChain` computes it), and passing the typed name instead would
 * compare against the wrong side of an `externalId` mapping.
 *
 * Never throws and never blocks meaningfully: discovery is TTL-cached and
 * fail-soft, and any failure degrades to `unknown`.
 */
export async function providerServesModel(
  provider: string,
  wireId: string
): Promise<ModelAvailability> {
  // 1. ENTITLEMENT — the provider's own answer about this key. Authoritative
  //    wherever it exists, because it reflects the caller's actual plan rather
  //    than what the vendor offers in general.
  const def = getProviderByName(provider);
  if (def?.modelDiscovery) {
    const models = await discoverProviderModels(provider);
    if (models.length > 0) {
      return rosterHas(
        models.map((m) => m.id),
        wireId
      )
        ? "serves"
        : "not-served";
    }
    // An empty roster is never a "no". `empty-roster` means the endpoint
    // answered with nothing to offer; every other kind (unauthorized,
    // unreachable, malformed…) means we failed to ask. Both are `unknown` —
    // dropping a candidate because its listing endpoint was briefly down would
    // turn a transient blip into a silent provider switch.
    getDiscoveryFailure(provider);
    return "unknown";
  }

  // 2. IDENTITY — the catalog may confirm a provider SERVES a model, but it may
  //    never conclude that one does not.
  //
  // Catalog coverage is PARTIAL BY NATURE, and the counts make that concrete:
  // `openai-codex` appears on exactly 1 model row, `kimi-coding` on 4, `x-ai` on
  // 7 — out of ~760. An earlier version of this function trusted "provider
  // appears somewhere in the catalog, but not on THIS row" as evidence of
  // absence. That is unsound: openai-codex really does serve `gpt-5` through the
  // ChatGPT subscription, and the rule declared it not-served for every model
  // but one. Caught by `route()`'s own tests, which is exactly what they are
  // for.
  //
  // A live roster is different in kind: it is COMPLETE BY CONSTRUCTION, because
  // the provider is enumerating everything the caller's key can reach. Only that
  // may deny. The catalog can still confirm, which is free and useful.
  const entries = getCatalogEntries();
  if (!entries) return "unknown";

  const needle = wireId.trim().toLowerCase();
  const row = entries.find(
    (e) =>
      e.modelId.toLowerCase() === needle ||
      e.aliases.some((a) => a.toLowerCase() === needle) ||
      (e.aggregators ?? []).some((a) => a.externalModelId?.toLowerCase() === needle)
  );
  if (!row) return "unknown";

  return (row.aggregators ?? []).some(
    (a) => a.routeStatus === "mapped" && catalogRouteMatchesProvider(a.route, provider)
  )
    ? "serves"
    : "unknown";
}
