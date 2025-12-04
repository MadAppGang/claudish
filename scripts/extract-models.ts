#!/usr/bin/env bun

/**
 * Extract model information from shared/recommended-models.md
 * and generate TypeScript types for use in Claudish
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
      return `  "${id}": {
    name: "${info.name}",
    description: "${info.description}",
    priority: ${info.priority},
    provider: "${info.provider}",
  }`;
    })
    .join(",\n");

  return `// AUTO-GENERATED from shared/recommended-models.md
// DO NOT EDIT MANUALLY - Run 'bun run extract-models' to regenerate

import type { OpenRouterModel } from "./types.js";

export const DEFAULT_MODEL: OpenRouterModel = "x-ai/grok-code-fast-1";
export const DEFAULT_PORT_RANGE = { start: 3000, end: 9000 };

// Model metadata for validation and display
export const MODEL_INFO: Record<
  OpenRouterModel,
  { name: string; description: string; priority: number; provider: string }
> = {
${modelInfo},
};

// Environment variable names
export const ENV = {
  OPENROUTER_API_KEY: "OPENROUTER_API_KEY",
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

  return `// AUTO-GENERATED from shared/recommended-models.md
// DO NOT EDIT MANUALLY - Run 'bun run extract-models' to regenerate

// OpenRouter Models - Top Recommended for Development (Priority Order)
export const OPENROUTER_MODELS = [
${modelIds},
  "custom",
] as const;

export type OpenRouterModel = (typeof OPENROUTER_MODELS)[number];
`;
}

// Main execution
try {
  const sharedModelsPath = join(import.meta.dir, "../../../shared/recommended-models.md");
  const configPath = join(import.meta.dir, "../src/config.ts");
  const typesPath = join(import.meta.dir, "../src/types.ts");

  console.log("📖 Reading shared/recommended-models.md...");
  const markdownContent = readFileSync(sharedModelsPath, "utf-8");

  console.log("🔍 Extracting model information...");
  const models = extractModels(markdownContent);

  console.log(`✅ Found ${Object.keys(models).length - 1} models + custom option`);

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
  console.log("Models:");
  for (const [id, info] of Object.entries(models)) {
    if (id !== "custom") {
      console.log(`  • ${id} - ${info.name} (${info.provider})`);
    }
  }
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
