import { describe, expect, it } from "bun:test";
import type { RecommendedModelGroup, RecommendedModelsDoc } from "./model-loader.js";
import {
  buildCatalogRoutingRules,
  collectRoutingPrefixes,
  formatListingPrice,
} from "./model-loader.js";

const swe17Entry = {
  pricing: { input: "N/A", output: "N/A", average: "N/A" },
  subscription: { prefix: "dv", plan: "Devin", command: "dv@swe-1.7" },
};

const glm53Entry = {
  pricing: { input: "N/A", output: "N/A", average: "N/A" },
};

const claudeCodeSubscription = {
  plan: "Claude Code",
  command: "claude-fable-5",
};

describe("formatListingPrice", () => {
  it("passes through a real rate and preserves FREE and varies normalization", () => {
    expect(formatListingPrice({ pricing: { average: "$1.32/1M" } })).toBe("$1.32/1M");
    expect(formatListingPrice({ pricing: { average: "$0.00/1M" } })).toBe("FREE");
    expect(formatListingPrice({ pricing: { average: "-1000000" } })).toBe("varies");
  });

  it("renders swe-1.7's subscription plan when its rate is unavailable", () => {
    expect(formatListingPrice(swe17Entry)).toBe("SUB (Devin)");
  });

  it("renders compact swe-1.7 pricing as SUB", () => {
    expect(formatListingPrice(swe17Entry, { compact: true })).toBe("SUB");
  });

  it("keeps glm-5.3's unknown price as N/A in both display modes", () => {
    expect(formatListingPrice(glm53Entry)).toBe("N/A");
    expect(formatListingPrice(glm53Entry, { compact: true })).toBe("N/A");
  });

  it("prefers a real rate over a subscription plan", () => {
    expect(
      formatListingPrice({
        pricing: { average: "$1.32/1M" },
        subscription: claudeCodeSubscription,
      })
    ).toBe("$1.32/1M");
  });
});

// ─── collectRoutingPrefixes ──────────────────────────────────────────────────
//
// Fixtures below reproduce the SHAPE of the live `?catalog=recommended` payload,
// with values that are obviously synthetic. No live model id, plan name, price
// or context window is pinned — those rot, and CLAUDE.md forbids hardcoding them.
//
// The shape that matters: a catalog row that is served by several plans carries
// a `subscriptions` ARRAY of routes, and its singular `subscription` MIRRORS
// element 0 of that array rather than being a curated primary. So a row with
// three routes is one row, and reading one prefix per row loses two of them.

/** Slug the synthetic native-prefix lookup does not know, so it answers null. */
const SYNTHETIC_SLUG = "synthetic-vendor";

/** One route inside a row's plural `subscriptions` array. `prefix` is optional on the wire. */
interface WireRoute {
  prefix?: string;
  plan: string;
  command: string;
  planIds?: string[];
  routingProvider?: string;
  tier?: "native" | "general" | "metered" | "aggregator";
}

const route = (prefix: string, modelId: string): WireRoute => ({
  prefix,
  plan: `Synthetic Plan ${prefix.toUpperCase()}`,
  command: `${prefix}@${modelId}`,
});

/**
 * A group holding exactly ONE `category:"subscription"` row, which itself carries
 * `routes`. The singular mirrors `routes[0]`, as measured on the wire.
 */
function groupWithOneSubscriptionRow(modelId: string, routes: WireRoute[]): RecommendedModelGroup {
  const base = {
    id: modelId,
    name: `Synthetic ${modelId}`,
    description: "synthetic fixture",
    provider: SYNTHETIC_SLUG,
    priority: 1,
    pricing: { input: "N/A", output: "N/A", average: "N/A" },
    context: "N/A",
  };

  const group = {
    id: modelId,
    bucket: "flagship",
    primary: { ...base, category: "programming" },
    subscriptions: [
      {
        ...base,
        category: "subscription",
        // Mirrors element 0 — not an additional, curated route.
        subscription: routes[0],
        subscriptions: routes,
      },
    ],
  };

  // The plural `subscriptions` field on a row is present on the wire but is not
  // (yet) declared on RecommendedModelEntry, so the fixture is cast at the
  // boundary. The runtime value is the real wire shape.
  return group as unknown as RecommendedModelGroup;
}

/** Stand-in for the real slug→native-shortcut lookup the callers pass in. */
const NATIVE_PREFIX_BY_SLUG: Record<string, string> = { "native-vendor": "nv" };
const getNativePrefix = (firebaseSlug: string): string | null =>
  NATIVE_PREFIX_BY_SLUG[firebaseSlug] ?? null;

/** The one slug the lookup above answers for, and the shortcut it answers with. */
const NATIVE_SLUG = "native-vendor";
const NATIVE_PREFIX = NATIVE_PREFIX_BY_SLUG[NATIVE_SLUG];

/**
 * The shape the native rows really ship: `{plan, command}` with NO `prefix` key
 * at all, because the command is the bare model id and there is nothing to
 * prefix it with.
 */
const prefixlessRoute = (modelId: string): WireRoute => ({
  plan: "Synthetic Native Plan",
  command: modelId,
});

/**
 * A group whose single subscription row is assembled field by field, so a test
 * can put the plural and the singular deliberately out of step.
 * `groupWithOneSubscriptionRow` always mirrors element 0 — the real wire shape,
 * but it cannot express "plural present and empty" or "singular diverges".
 */
function groupWithRawRow(
  modelId: string,
  row: { subscription?: WireRoute; subscriptions?: WireRoute[] }
): RecommendedModelGroup {
  const group = groupWithOneSubscriptionRow(modelId, []);
  const rawRow = group.subscriptions[0] as unknown as Record<string, unknown>;
  delete rawRow.subscription;
  delete rawRow.subscriptions;
  if (row.subscription) rawRow.subscription = row.subscription;
  if (row.subscriptions) rawRow.subscriptions = row.subscriptions;
  return group;
}

/** Same shape as `groupWithOneSubscriptionRow`, but served by a slug the native lookup knows. */
function groupServedNatively(modelId: string, routes: WireRoute[]): RecommendedModelGroup {
  const group = groupWithOneSubscriptionRow(modelId, routes);
  group.primary.provider = NATIVE_SLUG;
  return group;
}

/** How the Access line renders the result — the surface the guards below protect. */
const renderAccessLine = (prefixes: string[], modelId: string): string =>
  prefixes.map((p) => `${p}@${modelId}`).join(" · ");

describe("collectRoutingPrefixes", () => {
  // T-1 — the test that defines the defect.
  //
  // A single catalog row can be served by several plans. Every one of those is a
  // route the user can type, so every one must be offered. Taking one prefix per
  // ROW instead of per ROUTE hides the rest: the user is never told the model is
  // reachable on their own subscription and pays per token on another provider.
  it("yields every route a single subscription row carries, in the order sent", () => {
    const group = groupWithOneSubscriptionRow("synth-model-1", [
      route("aa", "synth-model-1"),
      route("bb", "synth-model-1"),
      route("cc", "synth-model-1"),
    ]);

    expect(collectRoutingPrefixes(group, getNativePrefix)).toEqual(["aa", "bb", "cc"]);
  });

  it("uses declared tier rather than wire-array position", () => {
    const general = { ...route("gg", "synth-tiered"), tier: "general" as const };
    const native = { ...route("nn", "synth-tiered"), tier: "native" as const };
    const metered = { ...route("mm", "synth-tiered"), tier: "metered" as const };
    const group = groupWithOneSubscriptionRow("synth-tiered", [metered, general, native]);

    expect(collectRoutingPrefixes(group, getNativePrefix)).toEqual(["nn", "gg", "mm"]);
  });

  // ── T-2..T-6 are regression guards. They do not prove the fix (T-1 does that);
  // they pin properties the rewrite could break, each with a user-visible symptom.

  // T-2 — the missing-prefix guard is load-bearing, not defensive noise.
  //
  // Native rows ship a subscription entry that is `{plan, command}` with no
  // `prefix` key at all. Drop the guard and those rows advertise
  // `undefined@<model>` — a route the user can read and type and that cannot
  // work. Turn the guard into a `break` and every later route in the row is lost.
  it("contributes nothing for a route with no prefix, and never renders undefined@", () => {
    const onlyPrefixless = groupWithOneSubscriptionRow("synth-model-2", [
      prefixlessRoute("synth-model-2"),
    ]);
    expect(collectRoutingPrefixes(onlyPrefixless, getNativePrefix)).toEqual([]);

    // A prefixless route sitting BETWEEN two real ones must be skipped — not
    // emitted as `undefined`, and not treated as the end of the row.
    const mixed = groupWithOneSubscriptionRow("synth-model-2", [
      route("aa", "synth-model-2"),
      prefixlessRoute("synth-model-2"),
      route("bb", "synth-model-2"),
    ]);
    const prefixes = collectRoutingPrefixes(mixed, getNativePrefix);
    expect(prefixes).toEqual(["aa", "bb"]);
    expect(renderAccessLine(prefixes, "synth-model-2")).not.toContain("undefined@");
  });

  // T-2b — a NULL element inside the plural array is a dropped route, not a crash.
  //
  // These are wire values. TypeScript types the array as non-nullable objects, so
  // it cannot warn, and `route.prefix` on a JSON `null` throws a TypeError all the
  // way out of collectRoutingPrefixes — taking down the whole list_models render
  // and the CLI listing rather than losing one route. The code this replaced read
  // `sub.subscription?.prefix` and did not have that failure mode.
  it("skips a null route inside the plural array instead of throwing", () => {
    const group = groupWithRawRow("synth-model-2b", {
      subscriptions: [
        route("aa", "synth-model-2b"),
        null as unknown as WireRoute,
        route("bb", "synth-model-2b"),
      ],
    });

    expect(() => collectRoutingPrefixes(group, getNativePrefix)).not.toThrow();
    expect(collectRoutingPrefixes(group, getNativePrefix)).toEqual(["aa", "bb"]);
  });

  // T-3 — dedupe WITHIN one row's route array.
  //
  // The live payload really does repeat a prefix inside a single array (the
  // `[zgo, qc, qc, zen]` shape). Lose the dedupe in a rewrite and the model
  // advertises the same route twice on one line.
  it("renders a prefix repeated inside one row's route array exactly once", () => {
    const group = groupWithOneSubscriptionRow("synth-model-3", [
      route("aa", "synth-model-3"),
      route("bb", "synth-model-3"),
      route("bb", "synth-model-3"),
      route("cc", "synth-model-3"),
    ]);

    expect(collectRoutingPrefixes(group, getNativePrefix)).toEqual(["aa", "bb", "cc"]);
  });

  // T-4 — an EMPTY plural must fall through to the singular.
  //
  // `row.subscriptions ?? [row.subscription]` reads as equivalent to a length
  // test and is not: `??` falls through only on null/undefined, so a
  // present-but-empty array wins and the singular route is silently dropped.
  // The row then advertises no route at all — the older-backend shape breaks.
  it("falls back to the singular route when the plural is present but empty", () => {
    const group = groupWithRawRow("synth-model-4", {
      subscriptions: [],
      subscription: route("xx", "synth-model-4"),
    });

    expect(collectRoutingPrefixes(group, getNativePrefix)).toEqual(["xx"]);
  });

  // T-5 — a non-empty plural is the COMPLETE answer; the singular is a fallback,
  // never an addition.
  //
  // On the wire the singular mirrors element 0, so the equal case below is what
  // production actually sends — but it is a WIRE-SHAPE EXAMPLE, not coverage: on
  // its own it CANNOT FAIL, because dedupe swallows an appended duplicate. Do not
  // cite it as a mutation-catching assertion. The diverging row is what makes the
  // contract observable: append instead of replace and a route the backend never
  // put in the plural shows up on the Access line. Length is asserted, not
  // membership, for the same reason.
  it("does not append the singular route to a non-empty plural", () => {
    const mirrored = route("aa", "synth-model-5");
    const equal = groupWithRawRow("synth-model-5", {
      subscriptions: [mirrored],
      subscription: mirrored,
    });
    const fromEqual = collectRoutingPrefixes(equal, getNativePrefix);
    expect(fromEqual).toEqual(["aa"]);
    expect(fromEqual).toHaveLength(1);

    const diverging = groupWithRawRow("synth-model-5", {
      subscriptions: [route("aa", "synth-model-5"), route("bb", "synth-model-5")],
      subscription: route("zz", "synth-model-5"),
    });
    const fromDiverging = collectRoutingPrefixes(diverging, getNativePrefix);
    expect(fromDiverging).toEqual(["aa", "bb"]);
    expect(fromDiverging).toHaveLength(2);
  });

  // T-6 — the native provider's own prefix holds index 0.
  //
  // It is the route the user already has, so burying it after the subscription
  // routes is a real regression in what the line communicates. The same seeding
  // is what stops a subscription route that repeats the native prefix from
  // rendering it twice.
  it("puts the native prefix first, even when a subscription route repeats it", () => {
    const group = groupServedNatively("synth-model-6", [
      route("aa", "synth-model-6"),
      route("bb", "synth-model-6"),
    ]);
    const prefixes = collectRoutingPrefixes(group, getNativePrefix);
    expect(prefixes[0]).toBe(NATIVE_PREFIX);
    expect(prefixes).toEqual([NATIVE_PREFIX, "aa", "bb"]);

    const collides = groupServedNatively("synth-model-6", [
      route("aa", "synth-model-6"),
      route(NATIVE_PREFIX, "synth-model-6"),
      route("bb", "synth-model-6"),
    ]);
    const collided = collectRoutingPrefixes(collides, getNativePrefix);
    expect(collided[0]).toBe(NATIVE_PREFIX);
    expect(collided).toEqual([NATIVE_PREFIX, "aa", "bb"]);
  });
});

describe("buildCatalogRoutingRules", () => {
  it("uses routingProvider, command wire IDs, and declared tier", () => {
    const base = {
      id: "synth-live-route",
      name: "Synthetic live route",
      description: "synthetic fixture",
      provider: "Synthetic",
      category: "subscription",
      priority: 1,
      pricing: { input: "N/A", output: "N/A", average: "N/A" },
      context: "N/A",
    };
    const doc = {
      version: "2.1.0",
      lastUpdated: "2026-09-02",
      models: [
        {
          ...base,
          subscription: {
            prefix: "np",
            plan: "Native plan",
            planIds: ["commercial-native-plan"],
            routingProvider: "native-provider",
            tier: "native",
            command: "np@native-wire-id",
          },
          subscriptions: [
            {
              prefix: "mp",
              plan: "Metered route",
              planIds: [],
              routingProvider: "metered-provider",
              tier: "metered",
              command: "mp@metered/wire-id",
            },
            {
              prefix: "np",
              plan: "Native plan",
              planIds: ["commercial-native-plan"],
              routingProvider: "native-provider",
              tier: "native",
              command: "np@native-wire-id",
            },
          ],
        },
      ],
    } as RecommendedModelsDoc;

    expect(buildCatalogRoutingRules(doc)).toEqual({
      "synth-live-route": ["native-provider@native-wire-id", "metered-provider@metered/wire-id"],
    });
  });

  it("ignores legacy routes that do not declare routingProvider", () => {
    const doc = {
      version: "1",
      lastUpdated: "2026-08-01",
      models: [
        {
          id: "legacy-model",
          name: "Legacy",
          description: "legacy fixture",
          provider: "Synthetic",
          category: "subscription",
          priority: 1,
          pricing: { input: "N/A", output: "N/A", average: "N/A" },
          context: "N/A",
          subscription: { prefix: "old", plan: "Old", command: "old@legacy-model" },
        },
      ],
    } as RecommendedModelsDoc;

    expect(buildCatalogRoutingRules(doc)).toEqual({});
  });
});
