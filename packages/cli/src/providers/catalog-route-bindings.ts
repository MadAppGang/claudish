export interface CatalogRouteBinding {
  routeId: string;
  routeProfileId: string;
}

/**
 * Transport bindings between Claudish providers and catalog v3 routes.
 * Model membership and wire IDs remain catalog data; this table only identifies
 * the transport adapter that can execute each canonical route.
 */
export const CATALOG_ROUTE_BINDINGS: Readonly<Record<string, CatalogRouteBinding>> = {
  "native-anthropic": { routeId: "anthropic", routeProfileId: "claude-code-subscription" },
  anthropic: { routeId: "anthropic", routeProfileId: "direct-api" },
  "openai-codex": { routeId: "openai", routeProfileId: "codex-subscription" },
  openai: { routeId: "openai", routeProfileId: "direct-api" },
  "kimi-coding": { routeId: "moonshotai", routeProfileId: "kimi-code-subscription" },
  kimi: { routeId: "moonshotai", routeProfileId: "direct-api" },
  moonshotai: { routeId: "moonshotai", routeProfileId: "direct-api" },
  "glm-coding": { routeId: "z-ai", routeProfileId: "glm-coding-subscription" },
  "z-ai": { routeId: "z-ai", routeProfileId: "direct-api" },
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
  qwen: { routeId: "qwen", routeProfileId: "dashscope-direct" },
  "opencode-zen-go": { routeId: "opencode", routeProfileId: "go-subscription" },
  "opencode-zen": { routeId: "opencode", routeProfileId: "zen" },
  zen: { routeId: "opencode", routeProfileId: "zen" },
  ollamacloud: { routeId: "ollama", routeProfileId: "cloud" },
  openrouter: { routeId: "openrouter", routeProfileId: "gateway" },
  together: { routeId: "together-ai", routeProfileId: "gateway" },
  fireworks: { routeId: "fireworks", routeProfileId: "gateway" },
  poe: { routeId: "poe", routeProfileId: "gateway" },
  vertex: { routeId: "vertex", routeProfileId: "google-cloud" },
  deepseek: { routeId: "deepseek", routeProfileId: "direct-api" },
  mistralai: { routeId: "mistralai", routeProfileId: "direct-api" },
};

export function catalogRouteForProvider(provider: string): CatalogRouteBinding | undefined {
  return CATALOG_ROUTE_BINDINGS[provider];
}

export function providerForCatalogRoute(
  route: CatalogRouteBinding | undefined
): string | undefined {
  if (!route) return undefined;
  for (const [provider, binding] of Object.entries(CATALOG_ROUTE_BINDINGS)) {
    if (binding.routeId === route.routeId && binding.routeProfileId === route.routeProfileId) {
      return provider;
    }
  }
  return undefined;
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
