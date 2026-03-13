/**
 * URL-based model parsing for custom local endpoints.
 *
 * Handles http://localhost:11434/modelname style model specs.
 * Named local providers (ollama, lmstudio, etc.) are now handled
 * by provider-definitions.ts like all other providers.
 */

import type { LocalProviderConfig } from "./transport/local.js";

export interface UrlParsedModel {
  baseUrl: string;
  modelName: string;
}

/**
 * Parse a URL-style model specification
 * Supports: http://localhost:11434/modelname or http://host:port/v1/modelname
 */
export function parseUrlModel(modelId: string): UrlParsedModel | null {
  // Check for http:// or https:// prefix
  if (!modelId.startsWith("http://") && !modelId.startsWith("https://")) {
    return null;
  }

  try {
    const url = new URL(modelId);
    const pathParts = url.pathname.split("/").filter(Boolean);

    if (pathParts.length === 0) {
      return null;
    }

    // Model name is the last path segment
    const modelName = pathParts[pathParts.length - 1];

    // Base URL is everything except the model name
    // Handle cases like /v1/modelname or just /modelname
    let basePath = "";
    if (pathParts.length > 1) {
      // Check if second-to-last is "v1" or similar API version
      const prefix = pathParts.slice(0, -1).join("/");
      if (prefix) basePath = "/" + prefix;
    }

    const baseUrl = `${url.protocol}//${url.host}${basePath}`;

    return {
      baseUrl,
      modelName,
    };
  } catch {
    return null;
  }
}

/**
 * Create an ad-hoc provider config for URL-based models
 */
export function createUrlProvider(parsed: UrlParsedModel): LocalProviderConfig {
  return {
    name: "custom-url",
    displayName: "Custom URL",
    baseUrl: parsed.baseUrl,
    apiPath: "/v1/chat/completions",
    envVar: "",
    prefixes: [],
    capabilities: {
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: true,
      supportsJsonMode: true,
      supportsReasoning: false,
    },
  };
}
