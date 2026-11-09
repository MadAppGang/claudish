/**
 * picker/PickerDataSource.ts — the four slow things the picker needs, behind one
 * interface, plus the production implementation that wraps the existing functions
 * verbatim.
 *
 * THIS SEAM EXISTS BECAUSE THE STATES THAT MATTER CANNOT BE PHOTOGRAPHED
 * OTHERWISE. The whole feature is about what the picker shows when discovery
 * FAILS, serves nothing, or is still in flight — and of those, only "unauthorized"
 * is reproducible against a live provider (a bogus key, a real 401). An empty
 * dynamic models catalog, a dynamic models catalog where nothing is chat-capable, a network timeout and the
 * in-flight frames themselves are not reachable from outside, and the warm catalog
 * path settles faster than a screenshot can catch. So the loaders are a parameter,
 * a scriptable fake drives the capture runs, and the production impl is the
 * default.
 *
 * NOT `mock.module()`: mocking shared infrastructure bleeds across Bun's module
 * registry and breaks sibling e2e files (`feedback_no_mock_module_bleed`). An
 * injected interface cannot leak into another test file.
 *
 * EVERY MEMBER'S SYNC/ASYNC SHAPE IS PART OF THE CONTRACT.
 *
 *   · `providerList`, `displayName`, `notEnabledLocalProviders`,
 *     `discoveryShape` are SYNCHRONOUS because the first frame must be complete
 *     before any await, and because the in-flight indicator's SHAPE has to be
 *     chosen before the fetch it describes begins.
 *   · `servedModels` is SYNCHRONOUS, and that is the decision that makes one flat
 *     cross-provider list affordable at all. It reads the catalog's local
 *     served-by index; the async `loadModelsForPickerProvider` asks the same
 *     question with a live `?provider=` query per owner slug, and 22 of those
 *     fired together were MEASURED at 10 s returning zero rows. `servedByVendor`
 *     in `providers/model-catalog.ts` records why the index is the same authority
 *     and not a second one.
 *   · `probeCredentials` is an AsyncIterable rather than a `Promise<Map>` so the
 *     `done/total` counter advances as each probe settles; a single awaited map
 *     would hide ~30 probes behind one silent pause, one of which is a
 *     multi-second 1Password handshake.
 */

import { credentials } from "../auth/credentials/authority.js";
import { isSubscriptionProvider } from "../handlers/shared/remote-provider-types.js";
import {
  type ModelInfo,
  type PickerDiscoveryOutcome,
  buildDiscoveredModelOutcome,
  buildProviderChoices,
  outcomeFromModelsCatalog,
  providerShortcut,
  servedModelsForProvider,
} from "../model-selector.js";
import { isLocalProviderEnabled } from "../profile-config.js";
import { ensureCatalogReady } from "../providers/catalog-client.js";
import { LIVE_MS } from "../providers/dynamic-models-catalog-store.js";
import {
  type AccountModelsList,
  isPersistedListProvider,
  loadAccountModelsLists,
  onAccountModelsListChanged,
  readAccountModelsList,
  refreshAccountModelsList,
} from "../providers/dynamic-models-catalog.js";
import { type CatalogClient, createCatalogClient } from "../providers/model-catalog.js";
import { type DescriptionIndex, loadModelDescriptions } from "../providers/model-descriptions.js";
import {
  type ModelsCatalogOutcome,
  discoverProviderModelsCatalog,
  servedOutcomeOf,
} from "../providers/model-discovery.js";
import { getAllProviders, getProviderByName } from "../providers/provider-definitions.js";

/** How a provider bills — the row's tag, and the reason a price may be absent. */
export type BillingMode = "sub" | "local" | "metered";

/**
 * Which in-flight indicator discovering one provider's models earns (§4.3), decided
 * synchronously from the provider's discovery format.
 *
 * `deadline` is the GET half, the only path that sees `FETCH_TIMEOUT_MS` — so an
 * elapsed-vs-deadline bar can be drawn and LABELLED as a deadline. `elapsed` is
 * the registered-fetcher half (ollama-tags, devin-connect, antigravity), where this
 * module owns no deadline at all: inventing 5 000 ms, or copying Ollama's 3 000 ms
 * onto Devin, would be a guess rendered as a fact. An elapsed counter with no
 * denominator makes exactly one claim — time is passing — and that claim is true.
 */
export type DiscoveryShape = "deadline" | "elapsed" | "none";

/** One provider, as every view of the picker needs it on frame one. */
export interface PickerProviderChoice {
  /** `ProviderDefinition.name` — the value every other call is keyed by. */
  value: string;
  /** The editorial display name — `Kimi / Moonshot`, `OpenAI Codex`. */
  label: string;
  /**
   * The routing shortcut this provider's rows print, `kc@` / `or@` / `gk@`.
   * DERIVED (`providerShortcut`), never a table, and it is the string the user
   * can retype on argv.
   */
  shortcut: string;
  description: string;
  billing: BillingMode;
  /** The env var to name in a credential notice. Empty for OAuth-only providers. */
  envVar: string;
  /** Does this provider list its own dynamic models catalog? Decides whether `p` runs discovery. */
  hasDiscovery: boolean;
  discoveryShape: DiscoveryShape;
}

export interface PickerDataSource {
  /** Sync, so frame one is never blank: derived from the provider definitions. */
  providerList(): PickerProviderChoice[];
  /** Built-in local providers present in the catalog but not enabled in config. */
  notEnabledLocalProviders(): string[];
  /** The provider's editorial display name, for dialog titles and notices. */
  displayName(provider: string): string;
  /** Readiness per provider, yielded AS EACH SETTLES — never one awaited map. */
  probeCredentials(names: string[]): AsyncIterable<[string, boolean]>;
  /** Make the cross-vendor catalog usable. Bounded, and never throws. */
  ensureCatalog(): Promise<void>;
  /**
   * What this provider SERVES, from the local served-by index, plus the
   * account's stored dynamic models catalog for a provider that keeps one. Sync.
   */
  servedModels(provider: string): ModelInfo[];
  /** One settled outcome per discovery provider, `fallbackRows` included. */
  discoverModelsCatalog(provider: string): Promise<PickerDiscoveryOutcome>;
  /**
   * The account's STORED dynamic models catalog as rows, or `null` when there is
   * none. Sync and disk-only, so a provider opens on its last answer while
   * `discoverModelsCatalog` asks live. Optional: a source without stored lists
   * opens on the live answer alone.
   */
  cachedModelsCatalog?(provider: string): PickerDiscoveryOutcome | null;
  /**
   * Called whenever a stored list lands, changes or is removed, so the views
   * that read `servedModels` and `cachedModelsCatalog` re-derive. Returns an
   * unsubscribe.
   */
  onModelsListsChanged?(listener: () => void): () => void;
  /**
   * One editorial sentence per model, for the detail pane. Resolves late and is
   * never awaited before a first paint; the slim catalog carries no description.
   */
  descriptions(): Promise<DescriptionIndex>;
}

/** How a provider bills, from the two oracles that already answer it. */
export function billingModeOf(provider: string): BillingMode {
  if (isSubscriptionProvider(provider)) return "sub";
  return getProviderByName(provider)?.isLocal === true ? "local" : "metered";
}

/**
 * Which indicator shape a provider's discovery earns.
 *
 * `openai-models-list` is the one format that runs through the GET half, which is
 * the only place `FETCH_TIMEOUT_MS` is referenced. Everything else is a registered
 * fetcher with its own, unpublished deadline.
 */
export function discoveryShapeOf(provider: string): DiscoveryShape {
  const format = getProviderByName(provider)?.modelDiscovery?.format;
  if (!format) return "none";
  return format === "openai-models-list" ? "deadline" : "elapsed";
}

/** The deadline the `deadline` shape is drawn against. Mirrors `FETCH_TIMEOUT_MS`. */
export const DISCOVERY_DEADLINE_MS = 5000;

/**
 * How long the picker will wait for a cold catalog before drawing what it has.
 *
 * It is NOT rendered as a determinate bar, deliberately. `ensureCatalogReady`
 * races this timeout against `refreshCatalog(8000)` — two different numbers, so
 * there is no single denominator a bar could honestly be drawn against. The
 * catalog row gets a shimmer and an elapsed figure, which claims only that time
 * is passing.
 */
const CATALOG_WAIT_MS = 5000;

/**
 * Yield each promise's value as it settles, in COMPLETION order.
 *
 * `Promise.all` would hold every result until the slowest one lands, which is the
 * silent pause this whole design exists to remove: one 1Password handshake is
 * multi-second, and with `all` it would freeze ~30 rows that had already answered.
 *
 * A rejection is mapped by the caller, never here — a generator that throws
 * mid-iteration would abandon the probes that had not yet been drained.
 */
async function* inCompletionOrder<T>(promises: Array<Promise<T>>): AsyncGenerator<T> {
  const live = new Map(promises.map((p, i) => [i, p.then((v) => ({ i, v }))]));
  while (live.size > 0) {
    const { i, v } = await Promise.race(live.values());
    live.delete(i);
    yield v;
  }
}

/**
 * A stored list as rows, through the same builder a live answer uses. `null`
 * when the list yields no rows (nothing chat-capable): a stored list that shows
 * nothing is not worth opening on, and the live answer explains it.
 */
function storedOutcome(
  provider: string,
  displayName: string,
  list: AccountModelsList,
  catalog: CatalogClient
): PickerDiscoveryOutcome | null {
  const outcome = outcomeFromModelsCatalog(
    provider,
    displayName,
    servedOutcomeOf(list.models),
    servedModelsForProvider(provider, catalog)
  );
  return outcome.kind === "rows" ? { ...outcome, listFetchedAt: list.fetchedAt } : null;
}

/**
 * The live leg for a provider that keeps a stored list: the account-bound
 * refresh, so the answer is written through for the next process. A list
 * younger than `LIVE_MS` is already the live answer and is read, not fetched.
 * With no credential the plain discovery runs, because its failure is the
 * notice that names the missing credential.
 */
async function liveAccountModelsCatalog(provider: string): Promise<ModelsCatalogOutcome> {
  const result = await refreshAccountModelsList(provider, "picker-provider", {
    minAgeMs: LIVE_MS,
  });
  if (result.kind === "refreshed") {
    return result.outcome.kind === "served"
      ? servedOutcomeOf(result.outcome.models)
      : result.outcome;
  }
  if (result.reason === "too-recent") {
    const list = await readAccountModelsList(provider);
    if (list) return servedOutcomeOf(list.models);
  }
  return discoverProviderModelsCatalog(provider);
}

/**
 * The production data source. Every method wraps an existing function verbatim —
 * no new fetch, no new field, no new plumbing.
 *
 * STORED DYNAMIC MODELS CATALOGS ARE READ FROM DISK AT OPEN, never fetched for a
 * frame. `loadAccountModelsLists` reads disk only; a provider whose credential
 * probe answers ready gets ONE background refresh per open, gated by the stored
 * list's age, and no render waits for it. A list that lands later reaches the
 * views through `onModelsListsChanged`.
 *
 * ONE `CatalogClient` PER PICKER OPEN, captured here rather than per call, so the
 * 24 h slim-cache read and the per-vendor memo are shared by every list the picker
 * renders. `selectModel` made the same choice for the same reason.
 */
export function createPickerDataSource(): PickerDataSource {
  const catalog = createCatalogClient();
  // Resolved once per open. `buildProviderChoices()` is pure and derived — never a
  // membership table (`routing.md:139`) — so calling it twice would be free but
  // would also let the dynamic models catalog and the notices disagree about ordering.
  const choices = buildProviderChoices().filter((c) => c.value !== "skip" && c.value !== "custom");
  const names = new Map(choices.map((c) => [c.value, c.name]));

  // The stored dynamic models catalogs for the current accounts, from disk.
  let lists = new Map<string, AccountModelsList>();
  let loaded = false;
  /** Changes heard before the disk read finished: they are newer than it. */
  const heard = new Map<string, AccountModelsList | null>();
  /** `cachedModelsCatalog` per provider, until its list changes. */
  const outcomes = new Map<string, PickerDiscoveryOutcome | null>();
  const viewers = new Set<() => void>();
  let stopListening: (() => void) | null = null;
  /** Providers already refreshed this open: one background refresh each. */
  const refreshed = new Set<string>();

  const notify = (): void => {
    for (const viewer of viewers) {
      try {
        viewer();
      } catch {
        // A viewer's fault must not keep the others from re-deriving.
      }
    }
  };

  void loadAccountModelsLists().then(
    (snapshot) => {
      const next = new Map(snapshot);
      for (const [provider, list] of heard) {
        if (list) next.set(provider, list);
        else next.delete(provider);
      }
      heard.clear();
      lists = next;
      loaded = true;
      outcomes.clear();
      notify();
    },
    () => {
      loaded = true;
    }
  );

  const cachedOutcome = (provider: string): PickerDiscoveryOutcome | null => {
    if (!outcomes.has(provider)) {
      const list = lists.get(provider);
      outcomes.set(
        provider,
        list ? storedOutcome(provider, names.get(provider) ?? provider, list, catalog) : null
      );
    }
    return outcomes.get(provider) ?? null;
  };

  return {
    providerList(): PickerProviderChoice[] {
      return choices.map((c) => ({
        value: c.value,
        label: c.name,
        shortcut: providerShortcut(c.value),
        description: c.description,
        billing: billingModeOf(c.value),
        envVar: getProviderByName(c.value)?.apiKeyEnvVar ?? "",
        hasDiscovery: Boolean(getProviderByName(c.value)?.modelDiscovery),
        discoveryShape: discoveryShapeOf(c.value),
      }));
    },

    notEnabledLocalProviders(): string[] {
      // Derived, so `routing.md:139` holds: no membership list to keep current.
      // `isLocalProviderEnabled` is a pure config read — it never probes a daemon,
      // which is why a dead LM Studio is NOT what this row is about.
      return getAllProviders()
        .filter((d) => d.isLocal === true && !isLocalProviderEnabled(d.name))
        .map((d) => d.name);
    },

    displayName(provider: string): string {
      return names.get(provider) ?? provider;
    },

    probeCredentials(providers: string[]): AsyncIterable<[string, boolean]> {
      return inCompletionOrder(
        providers.map(async (name): Promise<[string, boolean]> => {
          // Documented never to throw (`authority.ts:110-117`), guarded anyway:
          // behind a live renderer an unhandled rejection has nowhere to surface.
          const ready = await credentials.isAvailable(name).catch(() => false);
          if (ready && isPersistedListProvider(name) && !refreshed.has(name)) {
            refreshed.add(name);
            // Started, never awaited: the stored list is already on screen, and
            // a fresh one arrives through `onModelsListsChanged`.
            void refreshAccountModelsList(name, "picker-open", { minAgeMs: LIVE_MS }).catch(
              () => undefined
            );
          }
          return [name, ready];
        })
      );
    },

    async ensureCatalog(): Promise<void> {
      // Documented never to throw; guarded anyway, for the same reason as above.
      await ensureCatalogReady(CATALOG_WAIT_MS).catch(() => undefined);
    },

    servedModels(provider: string): ModelInfo[] {
      const fromCatalog = servedModelsForProvider(provider, catalog);
      const stored = isPersistedListProvider(provider) ? cachedOutcome(provider) : null;
      if (stored?.kind !== "rows") return fromCatalog;
      // The account's own answer first; a catalog row for the same id adds nothing.
      const listed = new Set(stored.rows.map((m) => m.id));
      return [...stored.rows, ...fromCatalog.filter((m) => !listed.has(m.id))];
    },

    discoverModelsCatalog(provider: string): Promise<PickerDiscoveryOutcome> {
      return buildDiscoveredModelOutcome(
        provider,
        names.get(provider) ?? provider,
        catalog,
        isPersistedListProvider(provider) ? liveAccountModelsCatalog : undefined
      );
    },

    cachedModelsCatalog(provider: string): PickerDiscoveryOutcome | null {
      return cachedOutcome(provider);
    },

    onModelsListsChanged(listener: () => void): () => void {
      viewers.add(listener);
      if (stopListening === null) {
        stopListening = onAccountModelsListChanged((provider, list) => {
          if (list) lists.set(provider, list);
          else lists.delete(provider);
          if (!loaded) heard.set(provider, list);
          outcomes.delete(provider);
          notify();
        });
      }
      return () => {
        viewers.delete(listener);
        if (viewers.size === 0 && stopListening !== null) {
          stopListening();
          stopListening = null;
        }
      };
    },

    descriptions(): Promise<DescriptionIndex> {
      return loadModelDescriptions();
    },
  };
}
