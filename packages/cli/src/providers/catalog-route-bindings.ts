export interface CatalogRouteBinding {
  routeId: string;
  routeProfileId: string;
}

/**
 * Route bindings between claudish's names and catalog v3 routes, split by job.
 *
 * Model membership and wire ids remain catalog data. These tables only say which
 * name stands for which `(routeId, routeProfileId)` pair, and there are two jobs:
 *
 *   - {@link CATALOG_ROUTE_BINDINGS}, the ROUTING table. Every key is a claudish
 *     provider, built-in or a bundled catalog row (`together`, `fireworks`), that
 *     owns one endpoint and one credential silo. The candidate gatherer reads it
 *     through {@link routingProvidersForRoute}, so every key here can become a
 *     route candidate.
 *   - {@link LOOKUP_ONLY_ROUTE_BINDINGS}, names that catalog READS ask about and
 *     that no claudish provider answers to. They are never route candidates.
 *
 * The split exists because the gatherer returns every name bound to a route. A
 * read-only name in the routing table was a candidate by accident of spelling:
 * a custom endpoint a user named `anthropic` would have been gathered for every
 * model Anthropic's native API serves. The reads still see both tables
 * ({@link catalogRouteForProvider}, {@link catalogReadProvidersForRoute}), so each
 * of them answers exactly as before the split.
 */
export const CATALOG_ROUTE_BINDINGS: Readonly<Record<string, CatalogRouteBinding>> = {
  "native-anthropic": { routeId: "anthropic", routeProfileId: "claude-code-subscription" },
  "openai-codex": { routeId: "openai", routeProfileId: "codex-subscription" },
  openai: { routeId: "openai", routeProfileId: "direct-api" },
  "kimi-coding": { routeId: "moonshotai", routeProfileId: "kimi-code-subscription" },
  kimi: { routeId: "moonshotai", routeProfileId: "direct-api" },
  "glm-coding": { routeId: "z-ai", routeProfileId: "glm-coding-subscription" },
  "z-ai": { routeId: "z-ai", routeProfileId: "direct-api" },
  // The SAME endpoint as `z-ai` (both are https://api.z.ai) under a second
  // claudish name, because the two carry different key silos: ZHIPU_API_KEY and
  // ZAI_API_KEY. Both must bind, or a user whose key sits in the other variable
  // loses Z.ai by bare name with nothing printed — measured on 11 models when
  // only `z-ai` was bound. Which one serves is then the credential filter's
  // decision, which is where it belongs.
  glm: { routeId: "z-ai", routeProfileId: "direct-api" },
  "grok-subscription": { routeId: "x-ai", routeProfileId: "supergrok-subscription" },
  "x-ai": { routeId: "x-ai", routeProfileId: "direct-api" },
  "minimax-coding": { routeId: "minimax", routeProfileId: "coding-plan-subscription" },
  minimax: { routeId: "minimax", routeProfileId: "direct-api" },
  "sakana-subscription": { routeId: "sakana", routeProfileId: "fugu-subscription" },
  sakana: { routeId: "sakana", routeProfileId: "direct-api" },
  devin: { routeId: "cognition", routeProfileId: "devin-subscription" },
  antigravity: { routeId: "google", routeProfileId: "antigravity-subscription" },
  google: { routeId: "google", routeProfileId: "direct-api" },
  "qwen-coding": { routeId: "qwen", routeProfileId: "modelstudio-coding-plan" },
  "qwen-token-plan": { routeId: "qwen", routeProfileId: "qwencloud-token-plan" },
  "qwen-payg": { routeId: "qwen", routeProfileId: "dashscope-direct" },
  // `qwen` is NOT bound, deliberately. A binding names one endpoint and one
  // credential silo (see this file's header); `qwen` is a steering placeholder
  // that owns neither — no baseUrl, no apiPath, no apiKeyEnvVar — and
  // `qwen-payg` is what actually calls dashscope. It was listed here while
  // `providerForCatalogRoute` returned only the FIRST provider per route, which
  // hid it behind `qwen-payg`. v10.0.0 made the gatherer take all of them (the
  // z-ai/glm key-silo fix, now `routingProvidersForRoute`) and the placeholder
  // surfaced: a `Qwen ✗ key missing` hop in `--probe qwen3.8-max`, sending the
  // reader after a key no environment variable can hold. `route()` never yielded
  // it, so the damage was confined to the display.
  //
  // Not fixed by filtering placeholders out of the gatherer: `native-anthropic`
  // is a placeholder too, by the same `reason: "virtual"` marker, and it IS
  // routable — the proxy's native passthrough serves it, so a filter on that
  // marker took `claude-*` away from anyone holding an ANTHROPIC_API_KEY.
  // Measured: two routing tests went red. The binding table is where the wrong
  // claim lived, so it is where the correction belongs.
  "opencode-zen-go": { routeId: "opencode", routeProfileId: "go-subscription" },
  "opencode-zen": { routeId: "opencode", routeProfileId: "zen" },
  ollamacloud: { routeId: "ollama", routeProfileId: "cloud" },
  openrouter: { routeId: "openrouter", routeProfileId: "gateway" },
  together: { routeId: "together-ai", routeProfileId: "gateway" },
  fireworks: { routeId: "fireworks", routeProfileId: "gateway" },
  poe: { routeId: "poe", routeProfileId: "gateway" },
  vertex: { routeId: "vertex", routeProfileId: "google-cloud" },
  deepseek: { routeId: "deepseek", routeProfileId: "direct-api" },
  mistralai: { routeId: "mistralai", routeProfileId: "direct-api" },
  // Meta's metered API (META_API_KEY). The Muse Code subscription is bound to
  // its own profile once models-index publishes one.
  meta: { routeId: "meta", routeProfileId: "direct-api" },
};

/**
 * Names that catalog READS ask about and that no claudish provider answers to.
 *
 * {@link routingProvidersForRoute} never sees this table, so none of these names
 * can become a route candidate. Each entry names its reader; a name whose reader
 * goes away should go with it.
 */
export const LOOKUP_ONLY_ROUTE_BINDINGS: Readonly<Record<string, CatalogRouteBinding>> = {
  // Anthropic's native API. Its reader is the session summary's savings panel,
  // which takes the first-party price from this route (`FIRST_PARTY` in
  // `session/baseline-pricing.ts`). The probe map also keys this route's probe
  // pick under this name (`probe-catalog.ts`). claudish calls Claude through
  // `native-anthropic` or a gateway, never through this route.
  anthropic: { routeId: "anthropic", routeProfileId: "direct-api" },
  // The catalog's vendor slug for Kimi. Its reader is the Kimi picker list: the
  // picker maps `kimi` to `moonshotai` (`pickerProviderToFirebaseSlug` in
  // `model-selector.ts`) and asks `modelsByVendor("moonshotai")` and
  // `servedByVendor("moonshotai")`. The provider that calls this route is `kimi`.
  moonshotai: { routeId: "moonshotai", routeProfileId: "direct-api" },
  // The shortcut spelling of `opencode-zen`, kept as a legacy picker value
  // (`PROVIDER_MODEL_PREFIX_OVERRIDE` in `model-selector.ts`). Its reader is the
  // picker's wire-id and price lookup (`resolveProviderAggregatorEntry`) when a
  // caller still passes that value. `zen@<id>` itself parses to `opencode-zen`.
  zen: { routeId: "opencode", routeProfileId: "zen" },
};

/**
 * The route a name is bound to, in either table.
 *
 * Every catalog read asks through this (`catalogRouteMatchesProvider`,
 * `externalIdFor`, the availability filter, the picker), so a lookup-only name
 * answers exactly as it did when it sat in the routing table.
 */
export function catalogRouteForProvider(provider: string): CatalogRouteBinding | undefined {
  return CATALOG_ROUTE_BINDINGS[provider] ?? LOOKUP_ONLY_ROUTE_BINDINGS[provider];
}

function namesBoundTo(
  table: Readonly<Record<string, CatalogRouteBinding>>,
  route: CatalogRouteBinding | undefined
): string[] {
  if (!route) return [];
  return Object.entries(table)
    .filter(
      ([, binding]) =>
        binding.routeId === route.routeId && binding.routeProfileId === route.routeProfileId
    )
    .map(([name]) => name);
}

/**
 * EVERY claudish provider bound to one catalog route, in declaration order. The
 * candidate gatherer's question (`route-candidates.ts`), answered from the routing
 * table only.
 *
 * The routing table is many-to-one on purpose: one endpoint can wear several
 * claudish names because each name owns a different key silo. Today that is one
 * pair, `z-ai` and `glm`, both https://api.z.ai, under ZAI_API_KEY and
 * ZHIPU_API_KEY.
 *
 * Routing must consider all of them. {@link providerForCatalogRoute}, which
 * answers with the first, silently hid the rest: a user whose key sat in the
 * second silo lost the model by bare name, with no error, because the candidate
 * carrying their credential was never gathered. Deciding WHICH of them serves is
 * the credential filter's job. A bundled catalog row (`together`, `fireworks`)
 * that has not registered in this process has no definition and so no tier, and
 * the gatherer drops it one layer down.
 */
export function routingProvidersForRoute(route: CatalogRouteBinding | undefined): string[] {
  return namesBoundTo(CATALOG_ROUTE_BINDINGS, route);
}

/**
 * Every name bound to one catalog route, for a catalog READ: the routing names in
 * declaration order, then the lookup-only names. Never a routing input.
 *
 * Routing names come first, so the first answer is a provider whenever one is
 * bound: `kimi` before `moonshotai`, `opencode-zen` before `zen`. `anthropic` is
 * the only name on `anthropic/direct-api`. The probe map (`probe-catalog.ts`)
 * keys a route's probe pick under every name this returns.
 */
export function catalogReadProvidersForRoute(route: CatalogRouteBinding | undefined): string[] {
  return [
    ...namesBoundTo(CATALOG_ROUTE_BINDINGS, route),
    ...namesBoundTo(LOOKUP_ONLY_ROUTE_BINDINGS, route),
  ];
}

/**
 * One name per route, for a read that wants exactly one: the first name
 * {@link catalogReadProvidersForRoute} returns. Readers: the aggregator slug set
 * (`model-catalog.ts`) and the recommended-models list (`model-loader.ts`). The
 * probe map (`probe-catalog.ts`) keys every name instead.
 */
export function providerForCatalogRoute(
  route: CatalogRouteBinding | undefined
): string | undefined {
  return catalogReadProvidersForRoute(route)[0];
}

export function catalogRouteMatchesProvider(
  route: CatalogRouteBinding | undefined,
  provider: string
): boolean {
  const binding = catalogRouteForProvider(provider);
  return (
    route !== undefined &&
    binding !== undefined &&
    route.routeId === binding.routeId &&
    route.routeProfileId === binding.routeProfileId
  );
}
