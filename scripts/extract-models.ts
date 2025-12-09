#!/usr/bin/env bun

/**
 * Extract model information from multiple providers (OpenRouter, Poe)
 * and generate TypeScript types for use in Claudish
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PoeProvider } from "../src/providers/poe-provider.js";
import { OpenRouterProvider } from "../src/providers/openrouter-provider.js";
import type { UnifiedModel } from "../src/types.js";

interface ModelInfo {
  name: string;
  description: string;
  priority: number;
  provider: string;
}

interface ExtractedModels {
  [key: string]: ModelInfo;
}

function extractModels(markdownContent: string): ExtractedModels {
  const models: ExtractedModels = {};
  let priority = 1;

  // Extract from Quick Reference section (lines 11-30)
  const quickRefMatch = markdownContent.match(
    /## Quick Reference - Model IDs Only\n\n([\s\S]*?)\n---/
  );
  if (!quickRefMatch) {
    throw new Error("Could not find Quick Reference section");
  }

  const quickRef = quickRefMatch[1];
  const lines = quickRef.split("\n");

  for (const line of lines) {
    // Match pattern: - `model-id` - Description (may contain commas), $price/1M or FREE, contextK/M [⭐]
    // Use non-greedy match and look for $ or FREE to find the price section
    const match = line.match(/^- `([^`]+)` - (.+?), (?:\$[\d.]+\/1M|FREE), ([\dKM]+)(?: ⭐)?$/);
    if (match) {
      const [, modelId, description] = match;

      // Determine provider from model ID
      let provider = "Unknown";
      if (modelId.startsWith("x-ai/")) provider = "xAI";
      else if (modelId.startsWith("minimax/")) provider = "MiniMax";
      else if (modelId.startsWith("z-ai/")) provider = "Zhipu AI";
      else if (modelId.startsWith("openai/")) provider = "OpenAI";
      else if (modelId.startsWith("google/")) provider = "Google";
      else if (modelId.startsWith("qwen/")) provider = "Alibaba";
      else if (modelId.startsWith("deepseek/")) provider = "DeepSeek";
      else if (modelId.startsWith("tngtech/")) provider = "TNG Tech";
      else if (modelId.startsWith("openrouter/")) provider = "OpenRouter";
      else if (modelId.startsWith("anthropic/")) provider = "Anthropic";

      // Extract short name from description
      const name = description.trim();

      models[modelId] = {
        name,
        description: description.trim(),
        priority: priority++,
        provider,
      };
    }
  }

  // Add custom option
  models.custom = {
    name: "Custom Model",
    description: "Enter any OpenRouter model ID manually",
    priority: 999,
    provider: "Custom",
  };

  return models;
}

function generateTypeScript(models: ExtractedModels): string {
  const modelIds = Object.keys(models)
    .filter((id) => id !== "custom")
    .map((id) => `  | "${id}"`)
    .join("\n");

  const modelInfo = Object.entries(models)
    .map(([id, info]) => {
      // Escape quotes and newlines in description
      const escapedName = info.name.replace(/"/g, '\\"').replace(/\n/g, '\\n');
      const escapedDescription = info.description.replace(/"/g, '\\"').replace(/\n/g, '\\n');
      return `  "${id}": {
    name: "${escapedName}",
    description: "${escapedDescription}",
    priority: ${info.priority},
    provider: "${info.provider}",
  }`;
    })
    .join(",\n");

  return `// AUTO-GENERATED from multiple providers
// DO NOT EDIT MANUALLY - Run 'bun run extract-models' to regenerate

export const DEFAULT_MODEL = "x-ai/grok-code-fast-1";
export const DEFAULT_PORT_RANGE = { start: 3000, end: 9000 };

// Model metadata for validation and display
export const MODEL_INFO: Record<
  string,
  { name: string; description: string; priority: number; provider: string }
> = {
${modelInfo},
};

// Environment variable names
export const ENV = {
  OPENROUTER_API_KEY: "OPENROUTER_API_KEY",
  POE_API_KEY: "POE_API_KEY",
  CLAUDISH_MODEL: "CLAUDISH_MODEL",
  CLAUDISH_PORT: "CLAUDISH_PORT",
  CLAUDISH_ACTIVE_MODEL_NAME: "CLAUDISH_ACTIVE_MODEL_NAME", // Set by claudish to show active model in status line
  ANTHROPIC_MODEL: "ANTHROPIC_MODEL", // Claude Code standard env var for model selection
  ANTHROPIC_SMALL_FAST_MODEL: "ANTHROPIC_SMALL_FAST_MODEL", // Claude Code standard env var for fast model
  // Claudish model mapping overrides (highest priority)
  CLAUDISH_MODEL_OPUS: "CLAUDISH_MODEL_OPUS",
  CLAUDISH_MODEL_SONNET: "CLAUDISH_MODEL_SONNET",
  CLAUDISH_MODEL_HAIKU: "CLAUDISH_MODEL_HAIKU",
  CLAUDISH_MODEL_SUBAGENT: "CLAUDISH_MODEL_SUBAGENT",
  // Claude Code standard model configuration (fallback if CLAUDISH_* not set)
  ANTHROPIC_DEFAULT_OPUS_MODEL: "ANTHROPIC_DEFAULT_OPUS_MODEL",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "ANTHROPIC_DEFAULT_SONNET_MODEL",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  CLAUDE_CODE_SUBAGENT_MODEL: "CLAUDE_CODE_SUBAGENT_MODEL",
} as const;

// OpenRouter API Configuration
export const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_HEADERS = {
  "HTTP-Referer": "https://github.com/MadAppGang/claude-code",
  "X-Title": "Claudish - OpenRouter Proxy",
} as const;
`;
}

function generateTypes(models: ExtractedModels): string {
  const modelIds = Object.keys(models)
    .filter((id) => id !== "custom")
    .map((id) => `  "${id}"`)
    .join(",\n");

  return `// AUTO-GENERATED from multiple providers
// DO NOT EDIT MANUALLY - Run 'bun run extract-models' to regenerate

// All Available Models (Priority Order)
export const ALL_MODELS = [
${modelIds},
  "custom",
] as const;

export type AllModel = (typeof ALL_MODELS)[number];

// Legacy type for backward compatibility
export type OpenRouterModel = AllModel;
export const OPENROUTER_MODELS = ALL_MODELS;
`;
}

// Provider factory
function createProvider(providerName: string) {
  switch (providerName.toLowerCase()) {
    case 'poe':
      return new PoeProvider();
    case 'openrouter':
      return new OpenRouterProvider();
    default:
      throw new Error(`Unknown provider: ${providerName}`);
  }
}

// Main execution
try {
  // Get provider from command line args
  const providerArg = process.argv[2] || 'all';
  const configPath = join(import.meta.dir, "../src/config.ts");
  const typesPath = join(import.meta.dir, "../src/types.ts");

  console.log(`🔍 Extracting models from provider(s): ${providerArg}`);

  const models: ExtractedModels = {};
  const providers = [];

  if (providerArg === 'all') {
    providers.push(new OpenRouterProvider(), new PoeProvider());
  } else if (providerArg.includes(',')) {
    // Support multiple providers: "openrouter,poe"
    for (const name of providerArg.split(',')) {
      providers.push(createProvider(name.trim()));
    }
  } else {
    providers.push(createProvider(providerArg));
  }

  // Fetch models from all specified providers
  for (const provider of providers) {
    console.log(`\n📡 Fetching from ${provider.name}...`);
    try {
      const providerModels = await provider.fetchModels();

      for (const model of providerModels) {
        models[model.id] = {
          name: model.name,
          description: model.description,
          priority: model.priority || 999,
          provider: model.provider,
        };
      }

      console.log(`✅ ${provider.name}: ${providerModels.length} models extracted`);
    } catch (error) {
      console.error(`❌ ${provider.name}: Failed to extract models - ${error.message}`);
      // Continue with other providers
    }
  }

  console.log(`\n📊 Total models extracted: ${Object.keys(models).length}`);

  console.log("📝 Generating config.ts...");
  const configCode = generateTypeScript(models);
  writeFileSync(configPath, configCode);

  console.log("📝 Generating types.ts...");
  const typesCode = generateTypes(models);
  const existingTypes = readFileSync(typesPath, "utf-8");

  // Replace OPENROUTER_MODELS array and OpenRouterModel type, keep other types
  // Handle both auto-generated and manual versions
  let updatedTypes = existingTypes;

  // Try to replace auto-generated section first
  if (existingTypes.includes("// AUTO-GENERATED")) {
    updatedTypes = existingTypes.replace(
      /\/\/ AUTO-GENERATED[\s\S]*?export type OpenRouterModel = \(typeof OPENROUTER_MODELS\)\[number\];/,
      typesCode.trim()
    );
  } else {
    // First time - replace manual OPENROUTER_MODELS section
    updatedTypes = existingTypes.replace(
      /\/\/ OpenRouter Models[\s\S]*?export type OpenRouterModel = \(typeof OPENROUTER_MODELS\)\[number\];/,
      typesCode.trim()
    );
  }

  writeFileSync(typesPath, updatedTypes);

  console.log("✅ Successfully generated TypeScript files");
  console.log("");
  console.log("Models by provider:");

  // Group by provider for display
  const byProvider: Record<string, ExtractedModels> = {};
  for (const [id, info] of Object.entries(models)) {
    if (!byProvider[info.provider]) byProvider[info.provider] = {};
    byProvider[info.provider][id] = info;
  }

  for (const [provider, providerModels] of Object.entries(byProvider)) {
    console.log(`\n${provider.toUpperCase()} (${Object.keys(providerModels).length}):`);
    const sorted = Object.entries(providerModels)
      .sort(([,a], [,b]) => a.priority - b.priority);
    for (const [id, info] of sorted.slice(0, 10)) { // Show top 10 per provider
      console.log(`  • ${id} - ${info.name}`);
    }
    if (Object.keys(providerModels).length > 10) {
      console.log(`  ... and ${Object.keys(providerModels).length - 10} more`);
    }
  }
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
