#!/usr/bin/env bun

/**
 * Update recommended-models.json from OpenRouter API
 *
 * This script fetches the latest model metadata from OpenRouter and updates
 * the recommended-models.json file. Run during releases to keep models current.
 *
 * Usage: bun scripts/update-models.ts
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MODELS_JSON_PATH = join(import.meta.dir, "../packages/cli/recommended-models.json");

// Top Weekly Programming Models (manually verified from the website)
// Source: https://openrouter.ai/models?categories=programming&fmt=cards&order=top-weekly
//
// This list represents the EXACT ranking shown on OpenRouter's website.
// The website is client-side rendered (React), so we can't scrape it with HTTP.
// The API doesn't expose the "top-weekly" ranking, so we maintain this manually.
const TOP_WEEKLY_PROGRAMMING_MODELS = [
  "x-ai/grok-code-fast-1", // #1: xAI Grok Code Fast 1
  "minimax/minimax-m2.1", // #2: MiniMax M2.1
  "z-ai/glm-4.7", // #3: Z.AI GLM 4.7
  "google/gemini-3-pro-preview", // #4: Google Gemini 3 Pro Preview
  "openai/gpt-5.3", // #5: OpenAI GPT-5.3
  "moonshotai/kimi-k2-thinking", // #6: MoonShot Kimi K2 Thinking
  "deepseek/deepseek-v3.2", // #7: DeepSeek V3.2
  "qwen/qwen3-vl-235b-a22b-thinking", // #8: Qwen3 VL 235B Thinking
  "anthropic/claude-sonnet-4.5", // #9: Anthropic Claude Sonnet 4.5
  "anthropic/claude-sonnet-4", // #10: Anthropic Claude Sonnet 4
  "anthropic/claude-haiku-4.5", // #11: Anthropic Claude Haiku 4.5
];

async function updateModels(): Promise<void> {
  console.log("🔄 Updating model recommendations from OpenRouter...");

  // Fetch model metadata from OpenRouter API
  const apiResponse = await fetch("https://openrouter.ai/api/v1/models");
  if (!apiResponse.ok) {
    throw new Error(`OpenRouter API returned ${apiResponse.status}`);
  }

  const openrouterData = (await apiResponse.json()) as { data: any[] };
  const allModels = openrouterData.data;

  console.log(`📊 Fetched ${allModels.length} models from OpenRouter API`);

  // Build a map for quick lookup
  const modelMap = new Map();
  for (const model of allModels) {
    modelMap.set(model.id, model);
  }

  // Build recommendations list following the exact website ranking
  const recommendations: any[] = [];
  const providers = new Set<string>();

  for (const modelId of TOP_WEEKLY_PROGRAMMING_MODELS) {
    const provider = modelId.split("/")[0];

    // Filter 1: Skip Anthropic models (not needed in Claudish)
    if (provider ==== "anthropic") {
      continue;
    }

    // Filter 2: Only ONE model per provider (take the first/top-ranked)
    if (providers.has(provider)) {
      continue;
    }

    const model = modelMap.get(modelId);
    if (!model) {
      console.warn(`⚠️  Model ${modelId} not found in OpenRouter API - skipping`);
      continue;
    }

    const name = model.name || modelId;
    const description = model.description || `${name} model`;
    const architecture = model.architecture || {};
    const topProvider = model.top_provider || {};
    const supportedParams = model.supported_parameters || [];

    // Calculate pricing
    const promptPrice = parseFloat(model.pricing?.prompt || "0");
    const completionPrice = parseFloat(model.pricing?.completion || "0");

    const inputPrice = promptPrice > 0 ? `$${(promptPrice * 1000000).toFixed(2)}/1M` : "FREE";
    const outputPrice = completionPrice > 0 ? `$${(completionPrice * 1000000).toFixed(2)}/1M` : "FREE";
    const avgPrice = promptPrice > 0 || completionPrice > 0
      ? `$${(((promptPrice + completionPrice) / 2) * 1000000).toFixed(2)}/1M`
      : "FREE";

    // Determine category
    let category = "programming";
    const lowerDesc = description.toLowerCase() + " " + name.toLowerCase();
    if (lowerDesc.includes("vision") || lowerDesc.includes("vl-") || lowerDesc.includes("multimodal")) {
      category = "vision";
    } else if (lowerDesc.includes("reason")) {
      category = "reasoning";
    }

    recommendations.push({
      id: modelId,
      name,
      description,
      provider: provider.charAt(0).toUpperCase() + provider.slice(1),
      category,
      priority: recommendations.length + 1,
      pricing: {
        input: inputPrice,
        output: outputPrice,
        average: avgPrice,
      },
      context: topProvider.context_length
        ? `${Math.floor(topProvider.context_length / 1000)}K`
        : "N/A",
      maxOutputTokens: topProvider.max_completion_tokens || null,
      modality: architecture.modality || "text->text",
      supportsTools: supportedParams.includes("tools") || supportedParams.includes("tool_choice"),
      supportsReasoning: supportedParams.includes("reasoning") || supportedParams.includes("include_reasoning"),
      supportsVision: (architecture.input_modalities || []).includes("image") || (architecture.input_modalities || []).includes("video"),
      isModerated: topProvider.is_moderated || false,
      recommended: true,
    });

    providers.add(provider);
  }

  // Read existing version if available
  let version = "1.1.5";
  if (existsSync(MODELS_JSON_PATH)) {
    try {
      const existing = JSON.parse(readFileSync(MODELS_JSON_PATH, "utf-8"));
      version = existing.version || version;
    } catch {
      // Use default version
    }
  }

  // Create new JSON structure
  const updatedData = {
    version,
    lastUpdated: new Date().toISOString().split("T")[0],
    source: "https://openrouter.ai/models?categories=programming&fmt=cards&order=top-weekly",
    models: recommendations,
  };

  // Write to file
  writeFileSync(MODELS_JSON_PATH, JSON.stringify(updatedData, null, 2), "utf-8");

  console.log(`✅ Updated ${MODELS_JSON_PATH}`);
  console.log(`   Models: ${recommendations.length}`);
  console.log(`   Providers: ${Array.from(providers).join(", ")}`);

  // Print model list
  console.log("\n📋 Recommended models:");
  for (const model of recommendations) {
    console.log(`   ${model.priority}. ${model.id} (${model.provider})`);
  }
}

// Run
updateModels().catch((error) => {
  console.error("❌ Error updating models:", error);
  process.exit(1);
});
