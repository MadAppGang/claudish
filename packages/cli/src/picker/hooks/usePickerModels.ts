/**
 * usePickerModels — ONE flat cross-provider list, and the per-provider counts the
 * provider dialog prints.
 *
 * THIS HOOK IS THE FIX FOR "SUPER UNCLEAR WHAT IS HAPPENING". The build it
 * replaces asked the user which PROVIDER before it would answer which MODEL, and
 * put a cursor in each of the two lists with only a border colour to say which one
 * the arrow keys drove. One list has one cursor. So the provider stops being a
 * navigation step and becomes a COLUMN — the routing shortcut, which is also the
 * string the user could have typed on argv.
 *
 * IT IS AFFORDABLE BECAUSE `servedModels` IS SYNCHRONOUS. The obvious
 * implementation — `loadModelsForPickerProvider` per provider — was MEASURED at
 * 10 s for 22 concurrent owner-slug queries, every one of which aborted on its
 * shared timeout and returned zero rows. That is not a slow picker; it is the
 * picker saying "this provider has no models", which is the exact complaint this
 * feature exists to remove. `PickerDataSource.servedModels` reads the catalog's
 * local served-by index instead, in about a millisecond, and
 * `model-catalog.ts:servedByVendor` records why that index is the same authority
 * rather than a second one.
 *
 * ONLY CREDENTIALLED PROVIDERS CONTRIBUTE ROWS, and the absence is EXPLAINED
 * rather than silent: the count in the dialog title reads `24/31 providers`, and
 * `p` lists all 31 with the reason each unready one is not there. A row the user
 * cannot launch is worse than a row that is missing — it fails at
 * `validateApiKeysForModels`, after the picker has closed.
 *
 * ONE `servedModels` CALL PER PROVIDER PER OPEN, held in a ref. Readiness arrives
 * as ~31 separate `setState`s (that incremental fill IS the loading affordance),
 * so a memo that re-derived every provider's rows on each of them would read the
 * slim cache ~500 times.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  type ModelInfo,
  buildExplicitModelSpec,
  compareByReleaseDateDesc,
  resolveProviderDisplayPrice,
  resolveProviderExternalId,
} from "../../model-selector.js";
import { useMounted } from "../../tui/hooks/useMounted.js";
import type { PickerDataSource, PickerProviderChoice } from "../PickerDataSource.js";
import { priceLabel } from "../rows.js";

/** One choice in the flat list: a model AND the provider that would serve it. */
export interface PickerRow {
  /** `ProviderDefinition.name` — what every source call is keyed by. */
  provider: string;
  /** The routing shortcut printed in the provider column: `or@`, `kc@`. */
  shortcut: string;
  /** Exactly what Enter returns. */
  spec: string;
  /** Already reshaped by `priceLabel` — `$2.25`, `SUB`, `FREE`, `local`. */
  price: string;
  model: ModelInfo;
}

/** The shape `ProbeState` established (`hooks/useRouteProbe.ts:28-33`) — copied, not reinvented. */
export type LoadPhase = "idle" | "loading" | "ready";

export interface PickerModelsState {
  /** Every (provider, model) pair a credentialled provider serves, newest first. */
  rows: PickerRow[];
  /** Rows per provider — the `p` dialog's count column. */
  counts: ReadonlyMap<string, number>;
  /** Whether the cross-vendor catalog warm has settled. */
  phase: LoadPhase;
}

/**
 * One model under one provider, as a row.
 *
 * EXPORTED BECAUSE THERE ARE TWO LISTS AND THEY MUST NOT DIFFER. The flat list is
 * built from the served-by index; a scoped list may instead be a live discovery
 * dynamic models catalog or its catalog fallback. If those paths built rows differently, a fallback
 * list would be distinguishable by ACCIDENT — a different price string, a different
 * spec spelling — rather than by the three deliberate provenance encodings, and a
 * reader would learn to read the accident instead of the mark.
 */
export function toPickerRow(choice: PickerProviderChoice, model: ModelInfo): PickerRow {
  return {
    provider: choice.value,
    shortcut: choice.shortcut,
    // The SAME spec builder the classic path uses, with the provider's own
    // externalId — `or@openai/gpt-5`, not the catalog's bare key. Every row is
    // provider-scoped, so no bare Claude name can leave this picker.
    spec: buildExplicitModelSpec(choice.value, resolveProviderExternalId(choice.value, model)),
    price: priceLabel(resolveProviderDisplayPrice(choice.value, model), choice.billing),
    model,
  };
}

export function usePickerModels(
  source: PickerDataSource,
  providerList: PickerProviderChoice[],
  /** Providers whose credential probe came back true. */
  ready: ReadonlySet<string>,
  /**
   * dynamic models catalog rows for the providers the user has already OPENED this session
   * (`rowsFromOutcomes`). Empty until he opens one, and that is the design: a
   * dynamic models catalog is fetched because he asked for that provider, and once it is in hand
   * it costs nothing to let it improve the cross-provider list too.
   */
  liveRows: ReadonlyMap<string, ModelInfo[]> = EMPTY_LIVE,
  /**
   * FALSE UNTIL A MODEL LIST IS ACTUALLY ON SCREEN — the whole point of this
   * parameter.
   *
   * The picker opens on the provider list, which needs no catalog at all, and
   * the owner's instruction was blunt: *"why we prefetching? we should not, as
   * we show on demand"*. So the cross-vendor warm does not run at startup; it
   * runs the first time a list of MODELS is asked for, which is one cached fetch
   * for the view that needs it rather than eleven that nobody asked for.
   */
  enabled = true,
  /**
   * Bumped whenever a stored dynamic models catalog lands or changes. Each
   * value re-reads `servedModels` once per provider; the per-provider cache
   * holds only within one value.
   */
  listsRevision = 0
): PickerModelsState {
  const [phase, setPhase] = useState<LoadPhase>("idle");
  const cache = useRef(new Map<string, PickerRow[]>());
  const cachedRevision = useRef(listsRevision);
  /** The warm is asked for ONCE per picker open, however often `enabled` flips. */
  const warmed = useRef(false);
  const mounted = useMounted();

  useEffect(() => {
    if (!enabled || warmed.current) return;
    warmed.current = true;
    setPhase("loading");
    void (async () => {
      // Bounded, and documented never to throw. A cold cache is the only case
      // this actually waits for; a warm one returns on the first line.
      await source.ensureCatalog();
      // RECORDED WHENEVER IT LANDS, not only while the model view is showing.
      // The warm is asked for once, so a result dropped because the user stepped
      // back mid-fetch (`a`, `esc`, `a` on a cold cache) was never asked for
      // again, and `cloud catalog fetching…` stayed on screen for the rest of the
      // run with the catalog already on disk. Only an UNMOUNT discards it.
      if (!mounted.current) return;
      // The warm may have REPLACED the slim cache on disk, so anything derived
      // from it before now is stale by construction.
      cache.current.clear();
      setPhase("ready");
    })();
  }, [source, enabled, mounted]);

  // The ready set is re-derived per render by `usePickerProviders`, so it cannot
  // be a memo dependency directly — a new Set every frame would rebuild the whole
  // list every frame. Its SIGNATURE can: a string compares by value, so the set
  // rebuilt from it keeps its identity until the membership actually changes.
  // (Depending on `signature` AND `ready` together, as this once did, rebuilt the
  // list every frame anyway — `ready` alone defeated the signature.)
  const signature = useMemo(() => [...ready].sort().join(","), [ready]);
  const stableReady = useMemo(
    () => new Set(signature === "" ? [] : signature.split(",")),
    [signature]
  );

  return useMemo(() => {
    if (phase !== "ready") return { rows: [], counts: new Map(), phase };
    dropOnNewRevision(cache.current, cachedRevision, listsRevision);
    const counts = new Map<string, number>();
    const rows: PickerRow[] = [];
    for (const choice of providerList) {
      let cached = cache.current.get(choice.value);
      if (cached === undefined) {
        cached = source.servedModels(choice.value).map((m) => toPickerRow(choice, m));
        cache.current.set(choice.value, cached);
      }
      // THE DYNAMIC MODELS CATALOG WINS AND THE CATALOG ROWS STAY, deduped by
      // `(provider, modelId)`.
      //
      // The same model id under two DIFFERENT providers is two rows on purpose —
      // that is the whole value of a cross-provider list, and the reason
      // `gpt-6-astra` is worth seeing at $30.00 on `or@` beside `SUB` on `cx@`.
      // This loop is per provider, so the dedupe below can only ever collapse the
      // OVERLAP between one provider's dynamic models catalog and its catalog entries. The
      // live entry wins because it is what this account can actually call: the
      // endpoint answered for THESE credentials, where the catalog answers for
      // everyone.
      const live = liveRows.get(choice.value);
      const merged =
        live === undefined || live.length === 0
          ? dedupeByProviderModel(cached)
          : dedupeByProviderModel([...live.map((m) => toPickerRow(choice, m)), ...cached]);
      // The COUNT is what this provider offers, credentials or not — the provider
      // dialog shows it beside `needs OPENAI_API_KEY`, and "0 models" there would
      // read as "this provider has nothing" rather than "you have no key".
      counts.set(choice.value, merged.length);
      if (stableReady.has(choice.value)) rows.push(...merged);
    }
    // Newest first, across providers. The same comparator the classic picker
    // uses, so two lists of the same models cannot disagree about their order.
    rows.sort((a, b) => compareByReleaseDateDesc(a.model, b.model));
    return { rows, counts, phase };
  }, [source, providerList, phase, stableReady, liveRows, listsRevision]);
}

/** Empty the per-provider row cache when the stored lists have changed since it was filled. */
function dropOnNewRevision(
  cache: Map<string, PickerRow[]>,
  seen: { current: number },
  revision: number
): void {
  if (seen.current === revision) return;
  seen.current = revision;
  cache.clear();
}

/** No dynamic models catalogs yet — a shared empty map, so the memo's identity is stable. */
const EMPTY_LIVE: ReadonlyMap<string, ModelInfo[]> = new Map();

/**
 * ROW IDENTITY DEPENDS ON THE VIEW, and the owner stated the rule directly: *"if
 * model has more than one provider that going to be two lines in 'all models'
 * list. and if we enter to provider catalog, not all models — then the model will
 * be just one"*.
 *
 * · **The flat cross-provider list** keys on `(provider, modelId)`. A model on
 *   three providers is three rows, because the route and the billing differ and
 *   that difference IS the list's value — `gpt-6-astra` at `$30.00` on OpenRouter
 *   beside the same model as `SUB` on Codex.
 * · **A provider-scoped list** keys on `modelId` alone. One route is in scope, so
 *   a second row of the same model would mean nothing.
 *
 * Both are spelled out rather than sharing one parameterised helper, because the
 * two call sites are the two views and a reader should be able to see which rule
 * each one applies without following a flag.
 */
export function dedupeByProviderModel(rows: PickerRow[]): PickerRow[] {
  const seen = new Set<string>();
  const out: PickerRow[] = [];
  for (const row of rows) {
    const key = `${row.provider} ${row.model.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/** One row per model id — the rule INSIDE one provider's catalog. */
export function dedupeByModelId(rows: PickerRow[]): PickerRow[] {
  const seen = new Set<string>();
  const out: PickerRow[] = [];
  for (const row of rows) {
    if (seen.has(row.model.id)) continue;
    seen.add(row.model.id);
    out.push(row);
  }
  return out;
}
