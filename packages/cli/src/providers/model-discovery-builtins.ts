/**
 * The three builtin dynamic models catalog fetchers that are not an HTTP GET.
 *
 * They live HERE, behind `registerModelDiscoveryFetcher`, rather than as
 * `if (descriptor.format === …)` branches inside `model-discovery.ts`. The
 * devin branch predicted this file: "If a third such provider ever appears,
 * replace this branch with a `registerModelDiscoveryFetcher(name, fn)` seam —
 * not worth it for one." Antigravity was the third.
 *
 * What the move buys is dependency DIRECTION. Previously the generic discovery
 * module had to know about Devin's protobuf rpcs, Antigravity's OAuth POST and
 * Ollama's daemon shape, so adding provider #4 meant editing a file that has
 * nothing to do with provider #4. Now it knows none of them: it loads this
 * bundle once, on the first format it cannot serve itself.
 *
 * This module is only ever imported dynamically, which is what keeps the
 * protobuf codec and the Antigravity OAuth path off the cold-start path — the
 * property the original dynamic `import()` calls existed to protect.
 */

import type { FetcherResult } from "./model-discovery.js";
import { registerModelDiscoveryFetcher } from "./model-discovery.js";

/**
 * Upstream error text as one readable line.
 *
 * A private copy rather than an import: `model-discovery.ts`'s `oneLine` is
 * module-private there, and exporting it to share four lines would widen that
 * module's surface for no gain.
 */
function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Devin's dynamic models catalog is capability ∩ entitlement over two protobuf rpcs.
 *
 * Carries the full variant metadata, not just id/name/window: the picker folds
 * ~170 uids into ~42 rows and needs the group label, the cost multiplier, the
 * promo and the vendor's own default flag to do it.
 *
 * **Honest limit on the classification.** `getServedDevinModels` catches its own
 * rpc errors and returns `modelsCatalogCache ?? []` (devin-models.ts), and
 * `postUnary` answers `null` rather than throwing, so a failed rpc still arrives
 * here as an empty list and is reported as `empty-models-catalog`. What this DOES
 * distinguish is the two states that are knowable without touching that module:
 * no credential at all, and a throw from anywhere in the chain.
 */
async function fetchDevinModelsCatalog(): Promise<FetcherResult> {
  let endpoint: string | undefined;
  try {
    const { readDevinApiKey, readDevinServerUrl } = await import("./devin/devin-credentials.js");
    endpoint = readDevinServerUrl();
    // A logged-out account is a CREDENTIAL problem, and it is the kind that
    // earns a "how to fix it" line. Reporting it as an empty dynamic models catalog says the
    // subscription serves no models, which is a claim about Devin rather than
    // about this machine.
    if (!readDevinApiKey()) {
      return {
        kind: "failed",
        failure: {
          kind: "no-credentials",
          endpoint,
          // The definition's own `apiKeyDescription`, verbatim: there is no
          // `claudish login devin` to point at — the token is the Devin CLI's,
          // and claudish only reads it.
          detail: "no Devin CLI session token (~/.local/share/devin/credentials.toml)",
        },
      };
    }

    const { getServedDevinModels } = await import("./devin/devin-models.js");
    const served = await getServedDevinModels();
    if (served.length === 0) return { kind: "models", models: [], endpoint };

    const { devinModelsCatalogEntry } = await import("./model-resolvers/devin.js");
    return {
      kind: "models",
      endpoint,
      models: served.map((model) => {
        const { wireId, ...rest } = devinModelsCatalogEntry(model);
        // `chat` is Devin's statement, not ours. This list is the set of models
        // Devin's own agent can drive — capability ∩ entitlement, already filtered
        // to configs with a context window — so every uid in it answers chat turns.
        // Its uids are knob-encoded (`swe-1-7-medium`) and the cloud catalog never
        // lists them verbatim, so judged by id alone 244 of 247 read as unknown.
        return { id: wireId, ...rest, reported: "chat" as const };
      }),
    };
  } catch (err: unknown) {
    return {
      kind: "failed",
      failure: { kind: "unreachable", endpoint, detail: oneLine(String(err)) },
    };
  }
}

/**
 * Ids the backend does not declare, but which are still not chat models.
 *
 * `fetchAvailableModels` states unselectability three ways — `isInternal`, the
 * per-feature role lists, and `deprecatedModelIds` — and those cover everything
 * except the `tab_*` pair, which appears in no list and carries no flag. They
 * are the editor's as-you-type completion models: 4096 max output, no thinking,
 * no images, `recommended: false`. They answer HTTP 200, which is precisely what
 * made a wrong-host problem look like a rate limit for an entire session.
 *
 * Prefix-matched, because the ids carry build numbers that rot on each roll of
 * the dynamic models catalog. This is the ONLY guess left in the filter; everything
 * else is declared.
 */
function isUndeclaredEditorInternal(id: string): boolean {
  return id.startsWith("tab_");
}

/**
 * Antigravity lists over an OAuth POST to a Google internal endpoint, not a GET.
 *
 * The reason it is worth a fetcher at all is `maxTokens`: the response reports
 * the window THIS subscription is served, and it disagrees with the shared
 * catalog — `claude-sonnet-4-6` is 250,000 from the backend against 1,000,000
 * in the catalog. `resolveDiscoveredContextLength` already prefers a discovered
 * window over the catalog; this is what gives it one to prefer.
 *
 * WHICH ids the picker shows follows agy. `agy models` prints exactly the
 * response's `agentModelSorts` ids, in order — a curated subset of the dynamic
 * models catalog, which also carries older generations (`gemini-2.5-*`,
 * `gemini-3-*`). Those rows carry `providerOrder`, and the picker lists exactly
 * the rows that do, in that order; when the field is absent (unknown, not
 * "none") no row carries it and the picker shows every selectable id, newest
 * first.
 *
 * THIS FETCHER STILL RETURNS EVERY SELECTABLE ID. It is not the picker's alone:
 * `providerServesModel` (the routing availability filter) and
 * `discoverContextWindow` read the same list, and a "not-served" there REMOVES
 * the `ag@` hop from a bare name's routing chain. Narrowing the list here to
 * agy's subset would silently route a bare `gemini-2.5-pro` past the
 * subscription. The narrowing is the picker's, in `buildRowsFromDiscovered`.
 */
async function fetchAntigravityModelsCatalog(): Promise<FetcherResult> {
  let endpoint: string | undefined;
  try {
    const { getValidAntigravityAccessToken } = await import("../auth/antigravity-token.js");
    const { setupAntigravityUser, getServedAntigravityModels, antigravityHost } = await import(
      "../auth/antigravity-user.js"
    );
    endpoint = `${antigravityHost()}/v1internal:fetchAvailableModels`;
    const token = await getValidAntigravityAccessToken();
    // No token is exactly "logged out", which is one of the two kinds that earns
    // the env-var / key-URL guidance. It used to read as an empty dynamic models catalog, i.e.
    // "your subscription serves nothing".
    if (!token) {
      return {
        kind: "failed",
        failure: {
          kind: "no-credentials",
          endpoint,
          detail: "not signed in — run `claudish login antigravity`",
        },
      };
    }

    const { projectId } = await setupAntigravityUser(token);
    const { servedIds, meta, excludedIds, agentModelIds } = await getServedAntigravityModels(
      token,
      projectId
    );
    // Declared first, guess second. `excludedIds` is the backend's own verdict —
    // internal flags, per-feature role bindings, and retired ids (which look
    // entirely normal but answer 400).
    const declaredExcluded = excludedIds ?? new Set<string>();
    // agy's own list, when the backend sent one: those ids, in agy's order,
    // still intersected with what is served and not declared excluded — a
    // curated id the account is not served is not a choice. They lead, each
    // with its position; every other selectable id follows WITHOUT one, kept
    // for routing (see above) and left out of the picker by the missing field.
    const served = new Set(servedIds);
    const agentSelectable = (agentModelIds ?? []).filter(
      (id) => served.has(id) && !declaredExcluded.has(id)
    );
    const position = new Map(agentSelectable.map((id, index) => [id, index]));
    const otherSelectable = servedIds.filter(
      (id) => !position.has(id) && !declaredExcluded.has(id) && !isUndeclaredEditorInternal(id)
    );
    return {
      kind: "models",
      endpoint,
      models: [...agentSelectable, ...otherSelectable].map((id) => {
        const m = meta[id];
        // contextWindow is left UNSET when the backend reported none
        // (gemini-3.1-flash-image does), so the catalog still gets its turn rather
        // than the row rendering a fabricated 0 as "N/A".
        // Every id here is a tuned variant (`-high`, `-tiered`) the catalog does not
        // carry; see `ignoreCatalogReleaseDate` for the ordering this protects.
        // `chat` is the backend's statement: everything it declares non-selectable —
        // internal flags, per-feature role bindings, retired ids — was removed above,
        // and so were the undeclared editor-completion models. What remains is the
        // set it offers for chat. Judged by id alone, 14 of 21 read as unknown,
        // because these tuned variants are ids the cloud catalog does not carry.
        // `providerOrder` only on agy's own ids: the rest are in `models` key
        // order, which nobody curated.
        const index = position.get(id);
        const order = index === undefined ? {} : { providerOrder: index };
        return m?.contextWindow
          ? {
              id,
              contextWindow: m.contextWindow,
              ignoreCatalogReleaseDate: true,
              reported: "chat" as const,
              ...order,
            }
          : { id, ignoreCatalogReleaseDate: true, reported: "chat" as const, ...order };
      }),
    };
  } catch (err: unknown) {
    return {
      kind: "failed",
      failure: { kind: "unreachable", endpoint, detail: oneLine(String(err)) },
    };
  }
}

/**
 * Ollama's daemon speaks its own listing shape and carries capability data no OpenAI list has.
 *
 * `throwOnError` is what makes "the daemon is not running" distinguishable from
 * "the daemon is running and nothing is pulled". `fetchOllamaModels` is
 * documented as never throwing, and every other caller still gets that; only
 * this one opts in, because only this one has somewhere to report the
 * difference. Both states used to be `empty-models-catalog`, so a stopped daemon
 * read as "this provider has no models" — the complaint, restated.
 */
async function fetchOllamaModelsCatalog(): Promise<FetcherResult> {
  const { fetchOllamaModels, ollamaBaseUrl } = await import("./ollama-discovery.js");
  const { ollamaReported } = await import("./transport/probe-discovery.js");
  const endpoint = `${ollamaBaseUrl()}/api/tags`;
  try {
    // `enrichCapabilities` is left at its default. It used to be `false`, which
    // cost nothing while an undescribed model still counted as chat — and hid
    // every model from a daemon that lists `capabilities` only in `/api/show`
    // once it stopped. A current daemon lists them inline, so the per-model
    // `/api/show` fallback never fires there.
    const installed = await fetchOllamaModels({ throwOnError: true });
    return {
      kind: "models",
      endpoint,
      models: installed.map((model) => ({
        id: model.name,
        displayName: model.name,
        supportsTools: model.supportsTools,
        // The daemon's own `capabilities`, read from `/api/tags`: `completion` means
        // chat, `embedding` means not. This row used to carry only name, display name
        // and a tools flag, so the capability data was fetched and then dropped here,
        // and 18 of 19 local builds — none of which the cloud catalog lists — read as
        // unknown. A daemon too old to report the field leaves it unset.
        reported: ollamaReported(model),
      })),
    };
  } catch (err: unknown) {
    return {
      kind: "failed",
      failure: { kind: "unreachable", endpoint, detail: oneLine(String(err)) },
    };
  }
}

registerModelDiscoveryFetcher("devin-connect", fetchDevinModelsCatalog);
registerModelDiscoveryFetcher("antigravity", fetchAntigravityModelsCatalog);
registerModelDiscoveryFetcher("ollama-tags", fetchOllamaModelsCatalog);
registerModelDiscoveryFetcher("muse-code-models", async () => {
  const { fetchMuseCodeModelsCatalog } = await import("./meta-muse/muse-models.js");
  return fetchMuseCodeModelsCatalog();
});
