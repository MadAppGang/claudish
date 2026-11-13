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
 * same chain. Its dynamic models catalog answers the question before any request is sent:
 *
 *     Zen Go serves 26 models; 'deepseek-v4-pro-0813' is not among them
 *     (it serves the undated `deepseek-v4-pro`), while 'kimi-k3' is.
 *
 * Note the naming detail — the dynamic models catalog also settles what to SEND, which a
 * membership test against catalog ids alone could not.
 */

import { getCatalogEntries } from "./catalog-client.js";
import { allConnections } from "./content-use.js";
import {
  isPersistedListProvider,
  readAccountModelsList,
  refreshAccountModelsList,
} from "./dynamic-models-catalog.js";
import {
  type DiscoveredModel,
  discoverProviderServedIds,
  getDiscoveryFailure,
  peekDiscoveredList,
} from "./model-discovery.js";
import { expandSelection } from "./model-resolvers/registry.js";
import { getProviderByName } from "./provider-definitions.js";

/**
 * - `serves`      — positive evidence this provider carries the model.
 * - `not-served`  — positive evidence it does NOT. The only value a caller may
 *                   act on destructively (dropping a candidate).
 * - `unknown`     — no source could answer. Treat exactly as today's behaviour.
 */
export type ModelAvailability = "serves" | "not-served" | "unknown";

/**
 * - `await`      — may wait on the provider's discovery endpoint (the request path).
 * - `background` — never waits on it (a launch): answers from what is already
 *                  known, starts the refresh, and reads `unknown` where only a
 *                  fetch could decide.
 */
export type AvailabilityNetwork = "await" | "background";

/** Case-insensitive match, since dynamic models catalogs disagree on casing (`MiniMax-M3`). */
function modelsCatalogHas(ids: string[], wireId: string): boolean {
  const needle = wireId.trim().toLowerCase();
  return ids.some((id) => id.trim().toLowerCase() === needle);
}

/**
 * The id this provider would ACTUALLY SEND for `wireId`, found by the same
 * resolver its transport uses.
 *
 * A provider that encodes knobs into its model ids never lists the bare
 * canonical id. Devin's dynamic models catalog holds `swe-1-7`,
 * `swe-1-7-medium` and `swe-1-7-lightning`, never `swe-1.7`, and its transport
 * maps the requested name onto one of them through `expandSelection` at request
 * time. This check used to compare the raw requested string instead, so it
 * answered "not-served" for every canonical id Devin carries, and "not-served"
 * is the one verdict allowed to REMOVE a candidate. Measured 2026-09-23 on a
 * 247-uid Devin catalog: `swe-1.7`, `swe-2`, `swe-1.6`, `glm-5.3` and
 * `kimi-k3` all read as not served, while the resolver maps them to
 * `swe-1-7-medium`, `swe-2-high`, `swe-1-6`, `glm-5-3-max` and `kimi-k3-high`.
 * A bare `swe-1.7` therefore lost its Devin hop and went to the OpenRouter
 * fallback, which answered "swe-1.7 is not a valid model ID", while the explicit
 * pin `devin@swe-1.7` worked.
 *
 * No effort is passed, so the resolver picks the family default. That is enough
 * to answer "is anything in this family served"; the transport resolves again
 * with the request's real effort when it sends. For a provider with no
 * resolver, `expandSelection` returns `wireId` unchanged, so their answer is
 * exactly what it was.
 *
 * Antigravity resolves outside the resolver registry (see its comment there)
 * and the same rule applies: `ag@gemini-3.8-flash` read as not served on an
 * account serving only `gemini-3.8-flash-tiered`, which the transport sends,
 * so a bare name lost its subscription hop. It resolves here with the
 * transport's own function over the transport's own inputs: the in-process
 * list of served and excluded ids and the backend's default id, cached by the discovery that just ran.
 * Only when that cache is absent does it fall back to the served ids the
 * dynamic models catalog describes (`antigravityServedSetOfList`: its ids plus
 * the excluded ids stored beside them), with no backend default. Both carry the
 * excluded ids, so an excluded exact id resolves as itself either way and the
 * answer does not depend on which one this process holds. Loaded lazily, so no
 * other provider's check pulls in the Antigravity transport.
 */
async function resolveAgainstModelsCatalog(
  provider: string,
  wireId: string,
  models: DiscoveredModel[],
  excludedIds?: readonly string[]
): Promise<string> {
  if (provider === "antigravity") {
    const [{ resolveAntigravityServedModel }, { antigravityServedSetOfList }, user] =
      await Promise.all([
        import("./transport/antigravity.js"),
        import("./antigravity-model-id.js"),
        import("../auth/antigravity-user.js"),
      ]);
    const served =
      user.peekServedAntigravityModels() ??
      antigravityServedSetOfList(
        models.map((m) => m.id),
        excludedIds
      );
    return resolveAntigravityServedModel(wireId, served);
  }
  const entries = models.map(({ id, ...rest }) => ({ wireId: id, ...rest }));
  return expandSelection(provider, wireId, entries, { quiet: true });
}

/**
 * Whether a complete list of `provider`'s models carries `wireId` in the
 * provider's own spelling. `excludedIds` are the served ids the list's endpoint
 * declares not selectable: they inform the resolution, and never count as
 * listed.
 */
async function listServes(
  provider: string,
  wireId: string,
  models: DiscoveredModel[],
  excludedIds?: readonly string[]
): Promise<boolean> {
  return modelsCatalogHas(
    models.map((m) => m.id),
    await resolveAgainstModelsCatalog(provider, wireId, models, excludedIds)
  );
}

/**
 * The account's stored dynamic models catalog, for a provider that keeps one.
 *
 * A stored list of any age up to its cap may CONFIRM; only a `live` one (at most
 * five minutes old, from any process, for this account key) may DENY. When an
 * older list would deny, the request path asks the account once and that answer
 * decides; a launch (`background`) never waits and reads `unknown`, with the
 * refresh started for the next reader.
 *
 * `deadline` bounds that one ask: once it has resolved, the verdict is `unknown`
 * and the refresh keeps running for the next reader. It is the routing
 * decision's missing-list deadline, so a list the chain stopped waiting for is
 * not then awaited without a bound here.
 *
 * `null` means this account has no binding to read under (no identity material,
 * so nothing is stored for it): the caller falls back to plain discovery, which
 * is what every provider did before lists were stored.
 */
async function storedListVerdict(
  provider: string,
  wireId: string,
  network: AvailabilityNetwork,
  deadline?: Promise<"deadline">
): Promise<ModelAvailability | null> {
  const list = await readAccountModelsList(provider);
  if (list) {
    if (await listServes(provider, wireId, list.models, list.excludedIds)) return "serves";
    if (list.mayDeny) return "not-served";
  }
  if (network === "background") {
    // Started, never awaited: the next reader gets the answer.
    void refreshAccountModelsList(provider, "availability");
    return "unknown";
  }
  const refreshing = refreshAccountModelsList(provider, "availability", { minAgeMs: 0 });
  const refreshed = deadline ? await Promise.race([refreshing, deadline]) : await refreshing;
  if (refreshed === "deadline") return "unknown";
  if (refreshed.kind === "skipped") return list ? "unknown" : null;
  const { outcome } = refreshed;
  if (outcome.kind !== "served") return "unknown";
  return (await listServes(provider, wireId, outcome.models, outcome.excludedIds))
    ? "serves"
    : "not-served";
}

/**
 * Whether `provider` serves `wireId` — the id that would actually be SENT, not
 * the name the user typed. Callers hold the resolved spec already
 * (`buildRoutingChain` computes it), and passing the typed name instead would
 * compare against the wrong side of an `externalId` mapping.
 *
 * Never throws and never blocks meaningfully: discovery is TTL-cached and
 * fail-soft, and any failure degrades to `unknown`. With `network: "background"`
 * it never waits on discovery at all. With a `deadline`, a stored-list refresh
 * still running when it resolves reads `unknown`.
 */
export async function providerServesModel(
  provider: string,
  wireId: string,
  opts: { network?: AvailabilityNetwork; deadline?: Promise<"deadline"> } = {}
): Promise<ModelAvailability> {
  const network = opts.network ?? "await";
  // 1. ENTITLEMENT — the provider's own answer about this key. Authoritative
  //    wherever it exists, because it reflects the caller's actual plan rather
  //    than what the vendor offers in general.
  const def = getProviderByName(provider);
  if (def?.modelDiscovery) {
    if (isPersistedListProvider(provider)) {
      const verdict = await storedListVerdict(provider, wireId, network, opts.deadline);
      if (verdict !== null) return verdict;
    }
    if (network === "background") {
      // Only what this process already holds; otherwise warm it for the request
      // path and answer `unknown`, which keeps the candidate where it is.
      const held = peekDiscoveredList(provider);
      if (!held) {
        void discoverProviderServedIds(provider);
        return "unknown";
      }
      return (await listServes(provider, wireId, held.models, held.excludedIds))
        ? "serves"
        : "not-served";
    }
    // BOTH lists: this answers whether the id the request carries is entitled,
    // and an explicitly typed content-use opt-in id is entitled when the account
    // serves it. Nothing here offers a model, so nothing here can choose one.
    const { served, optIn, excludedIds } = await discoverProviderServedIds(provider);
    const models = [...served, ...optIn];
    if (models.length > 0) {
      return (await listServes(provider, wireId, models, excludedIds)) ? "serves" : "not-served";
    }
    // An empty dynamic models catalog is never a "no". `empty-models-catalog`
    // means the endpoint answered with nothing to offer; every other kind (unauthorized,
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
  // A dynamic models catalog is different in kind: it is COMPLETE BY CONSTRUCTION, because
  // the provider is enumerating everything the caller's key can reach. Only that
  // may deny. The catalog can still confirm, which is free and useful.
  const entries = getCatalogEntries();
  if (!entries) return "unknown";

  const needle = wireId.trim().toLowerCase();
  const row = entries.find(
    (e) =>
      e.modelId.toLowerCase() === needle ||
      e.aliases.some((a) => a.toLowerCase() === needle) ||
      allConnections(e).some((a) => a.externalModelId?.toLowerCase() === needle)
  );
  if (!row) return "unknown";

  // Exact reverse lookup, opt-in rows included: it confirms, it never chooses.
  return allConnections(row).some(
    (a) => a.routeStatus === "mapped" && catalogRouteMatchesProvider(a.route, provider)
  )
    ? "serves"
    : "unknown";
}
