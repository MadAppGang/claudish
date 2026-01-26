// Centralized provider resolution - THE single source of truth
export {
  resolveModelProvider,
  validateApiKeysForModels,
  getMissingKeyError,
  getMissingKeysError,
  getMissingKeyResolutions,
  requiresOpenRouterKey,
  isLocalModel,
  type ProviderCategory,
  type ProviderResolution,
} from "./provider-resolver.js";

// Local provider registry
export {
  resolveProvider,
  isLocalProvider,
  parseUrlModel,
  createUrlProvider,
  getRegisteredProviders,
  type LocalProvider,
  type ResolvedProvider,
  type UrlParsedModel,
} from "./provider-registry.js";

// Remote provider registry
export {
  resolveRemoteProvider,
  getRegisteredRemoteProviders,
} from "./remote-provider-registry.js";

// Model parser - unified syntax for provider@model[:concurrency]
export {
  parseModelSpec,
  isLocalProviderName,
  isDirectApiProvider,
  getLegacySyntaxWarning,
  formatModelSpec,
  PROVIDER_SHORTCUTS,
  DIRECT_API_PROVIDERS,
  LOCAL_PROVIDERS,
  type ParsedModel,
} from "./model-parser.js";
