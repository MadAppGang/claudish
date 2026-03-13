/**
 * Remote Provider Registry
 *
 * Handles resolution of remote cloud API providers (Gemini, OpenAI, MiniMax, Kimi, GLM, etc.)
 * based on model ID specifications.
 *
 * New syntax: provider@model
 * Examples:
 *   google@gemini-3-pro-preview          - Direct Google API
 *   openrouter@google/gemini-3-pro       - Explicit OpenRouter
 *   oai@gpt-5.3                          - Direct OpenAI API (shortcut)
 *
 * Provider definitions are sourced from provider-definitions.ts.
 */

import type {
  ResolvedRemoteProvider,
} from "../handlers/shared/remote-provider-types.js";
import { parseModelSpec } from "./model-parser.js";
import { getProviderByName, getAllProviders, toRemoteProvider, isLocalTransport } from "./provider-definitions.js";

/**
 * Resolve a model ID to a remote provider
 *
 * Supports both new syntax (provider@model) and legacy syntax (prefix/model)
 * Returns null if no provider matches (falls through to OpenRouter default)
 */
export function resolveRemoteProvider(modelId: string): ResolvedRemoteProvider | null {
  // Try new model parser first
  const parsed = parseModelSpec(modelId);

  // Skip local providers - they're handled by provider-registry.ts
  if (isLocalTransport(parsed.provider)) {
    return null;
  }

  // Skip custom URL providers
  if (parsed.provider === "custom-url") {
    return null;
  }

  // Look up provider definition by canonical name (replaces providerNameMap)
  const def = getProviderByName(parsed.provider);
  if (def) {
    const provider = toRemoteProvider(def);
    return {
      provider,
      modelName: parsed.model,
      isLegacySyntax: parsed.isLegacySyntax,
    };
  }

  // Legacy: check prefix patterns for backwards compatibility
  for (const provDef of getAllProviders()) {
    for (const prefix of provDef.legacyPrefixes) {
      if (modelId.startsWith(prefix)) {
        return {
          provider: toRemoteProvider(provDef),
          modelName: modelId.slice(prefix.length),
          isLegacySyntax: true,
        };
      }
    }
  }

  return null;
}

