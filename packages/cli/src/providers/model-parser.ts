/**
 * Model Parser - Unified syntax for provider@model:concurrency
 *
 * New syntax: provider@model[:concurrency]
 * Legacy syntax: prefix/model (deprecated, still supported)
 * Native model detection: bare model names auto-route to their provider
 *
 * All provider shortcuts, prefix patterns, and native model patterns are
 * derived from provider-definitions.ts.
 */

import {
  getShortcuts,
  getLegacyPrefixPatterns,
  getNativeModelPatterns,
  isLocalTransport,
} from "./provider-definitions.js";

/**
 * Parsed model specification
 */
export interface ParsedModel {
  /** Normalized provider name (lowercase) */
  provider: string;
  /** Model name/ID (without provider prefix) */
  model: string;
  /** Original full model string */
  original: string;
  /** Concurrency limit (undefined = use default, 0 = no limit) */
  concurrency?: number;
  /** Whether this used legacy syntax (for deprecation warnings) */
  isLegacySyntax: boolean;
  /** Whether provider was explicitly specified (vs auto-detected) */
  isExplicitProvider: boolean;
}

/**
 * Parse a model specification string
 *
 * Supports both new and legacy syntax:
 * - New: provider@model[:concurrency]
 * - Legacy: prefix/model or prefix:model
 */
export function parseModelSpec(modelSpec: string): ParsedModel {
  const original = modelSpec;

  // URL-style model (http:// or https://)
  if (modelSpec.startsWith("http://") || modelSpec.startsWith("https://")) {
    return {
      provider: "custom-url",
      model: modelSpec,
      original,
      isLegacySyntax: false,
      isExplicitProvider: true,
    };
  }

  // New @ syntax: provider@model[:concurrency]
  const atMatch = modelSpec.match(/^([^@]+)@(.+)$/);
  if (atMatch) {
    const providerPart = atMatch[1].toLowerCase();
    let modelPart = atMatch[2];
    let concurrency: number | undefined;

    const concurrencyMatch = modelPart.match(/^(.+):(\d+)$/);
    if (concurrencyMatch) {
      modelPart = concurrencyMatch[1];
      concurrency = parseInt(concurrencyMatch[2], 10);
    }

    const shortcuts = getShortcuts();
    const provider = shortcuts[providerPart] || providerPart;

    return {
      provider,
      model: modelPart,
      original,
      concurrency,
      isLegacySyntax: false,
      isExplicitProvider: true,
    };
  }

  // Legacy prefix patterns (all derived from provider definitions)
  const lowerSpec = modelSpec.toLowerCase();
  for (const { prefix, provider, stripPrefix } of getLegacyPrefixPatterns()) {
    if (lowerSpec.startsWith(prefix)) {
      const model = stripPrefix ? modelSpec.slice(prefix.length) : modelSpec;

      // Parse concurrency suffix for local providers using legacy syntax
      let concurrency: number | undefined;
      let modelName = model;
      if (isLocalTransport(provider)) {
        const concurrencyMatch = model.match(/^(.+):(\d+)$/);
        if (concurrencyMatch) {
          modelName = concurrencyMatch[1];
          concurrency = parseInt(concurrencyMatch[2], 10);
        }
      }

      return {
        provider,
        model: modelName,
        original,
        concurrency,
        isLegacySyntax: true,
        isExplicitProvider: true,
      };
    }
  }

  // No explicit provider, try native model detection
  for (const { pattern, provider } of getNativeModelPatterns()) {
    if (pattern.test(modelSpec)) {
      const slashIndex = modelSpec.indexOf("/");
      const model = slashIndex > 0 ? modelSpec.slice(slashIndex + 1) : modelSpec;

      return {
        provider,
        model,
        original,
        isLegacySyntax: false,
        isExplicitProvider: false,
      };
    }
  }

  // Unknown vendor/model format
  if (modelSpec.includes("/")) {
    return {
      provider: "unknown",
      model: modelSpec,
      original,
      isLegacySyntax: false,
      isExplicitProvider: false,
    };
  }

  // No "/" so treat as native Anthropic model
  return {
    provider: "native-anthropic",
    model: modelSpec,
    original,
    isLegacySyntax: false,
    isExplicitProvider: false,
  };
}

export function getLegacySyntaxWarning(parsed: ParsedModel): string | null {
  if (!parsed.isLegacySyntax) return null;
  const newSyntax = `${parsed.provider}@${parsed.model}`;
  return (
    `Deprecation warning: "${parsed.original}" uses legacy prefix syntax.\n` +
    `  Consider using: ${newSyntax}`
  );
}
