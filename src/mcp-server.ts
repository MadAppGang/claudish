#!/usr/bin/env node

/**
 * Claudish MCP Server
 *
 * Exposes OpenRouter models as MCP tools for Claude Code.
 * Run with: claudish-mcp (stdio transport)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { config } from "dotenv";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Load environment variables
config();

// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Paths
const RECOMMENDED_MODELS_PATH = join(__dirname, "../recommended-models.json");
const ALL_MODELS_CACHE_PATH = join(__dirname, "../all-models.json");
const CACHE_MAX_AGE_DAYS = 2;

// Types
interface ModelInfo {
  id: string;
  name: string;
  description: string;
  provider: string;
  pricing?: {
    input: string;
    output: string;
    average: string;
  };
  context?: string;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
  supportsVision?: boolean;
}

interface OpenRouterResponse {
  id: string;
  choices: Array<{
    message: {
      content: string;
      role: string;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Load recommended models from JSON
 */
function loadRecommendedModels(): ModelInfo[] {
  if (existsSync(RECOMMENDED_MODELS_PATH)) {
    try {
      const data = JSON.parse(readFileSync(RECOMMENDED_MODELS_PATH, "utf-8"));
      return data.models || [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Load or fetch all models from OpenRouter
 */
async function loadAllModels(forceRefresh = false): Promise<any[]> {
  // Check cache
  if (!forceRefresh && existsSync(ALL_MODELS_CACHE_PATH)) {
    try {
      const cacheData = JSON.parse(readFileSync(ALL_MODELS_CACHE_PATH, "utf-8"));
      const lastUpdated = new Date(cacheData.lastUpdated);
      const ageInDays = (Date.now() - lastUpdated.getTime()) / (1000 * 60 * 60 * 24);

      if (ageInDays <= CACHE_MAX_AGE_DAYS) {
        return cacheData.models || [];
      }
    } catch {
      // Cache invalid, fetch fresh
    }
  }

  // Fetch from OpenRouter
  try {
    const response = await fetch("https://openrouter.ai/api/v1/models");
    if (!response.ok) throw new Error(`API returned ${response.status}`);

    const data = await response.json();
    const models = data.data || [];

    // Cache result
    writeFileSync(
      ALL_MODELS_CACHE_PATH,
      JSON.stringify({
        lastUpdated: new Date().toISOString(),
        models,
      }),
      "utf-8"
    );

    return models;
  } catch (error) {
    // Return cached data if available, even if stale
    if (existsSync(ALL_MODELS_CACHE_PATH)) {
      const cacheData = JSON.parse(readFileSync(ALL_MODELS_CACHE_PATH, "utf-8"));
      return cacheData.models || [];
    }
    return [];
  }
}

/**
 * Run a prompt through OpenRouter
 */
async function runPrompt(
  model: string,
  prompt: string,
  systemPrompt?: string,
  maxTokens?: number
): Promise<{ content: string; usage?: { input: number; output: number } }> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY environment variable not set");
  }

  const messages: Array<{ role: string; content: string }> = [];

  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }

  messages.push({ role: "user", content: prompt });

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://claudish.com",
      "X-Title": "Claudish MCP",
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens || 4096,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenRouter API error: ${response.status} - ${error}`);
  }

  const data: OpenRouterResponse = await response.json();

  const content = data.choices?.[0]?.message?.content || "";
  const usage = data.usage
    ? { input: data.usage.prompt_tokens, output: data.usage.completion_tokens }
    : undefined;

  return { content, usage };
}

/**
 * Fuzzy search score
 */
function fuzzyScore(text: string, query: string): number {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();

  if (lowerText === lowerQuery) return 1;
  if (lowerText.includes(lowerQuery)) return 0.8;

  // Simple character match
  let score = 0;
  let queryIndex = 0;
  for (const char of lowerText) {
    if (queryIndex < lowerQuery.length && char === lowerQuery[queryIndex]) {
      score++;
      queryIndex++;
    }
  }

  return queryIndex === lowerQuery.length ? score / lowerText.length : 0;
}

/**
 * Create and start the MCP server
 */
async function main() {
  const server = new McpServer({
    name: "claudish",
    version: "2.5.0",
  });

  // Tool: run_prompt - Run a prompt through an OpenRouter model
  server.tool(
    "run_prompt",
    "Run a prompt through an OpenRouter model (Grok, GPT-5, Gemini, etc.)",
    {
      model: z.string().describe("OpenRouter model ID (e.g., 'x-ai/grok-code-fast-1', 'openai/gpt-5.1-codex')"),
      prompt: z.string().describe("The prompt to send to the model"),
      system_prompt: z.string().optional().describe("Optional system prompt"),
      max_tokens: z.number().optional().describe("Maximum tokens in response (default: 4096)"),
    },
    async ({ model, prompt, system_prompt, max_tokens }) => {
      try {
        const result = await runPrompt(model, prompt, system_prompt, max_tokens);

        let response = result.content;
        if (result.usage) {
          response += `\n\n---\nTokens: ${result.usage.input} input, ${result.usage.output} output`;
        }

        return { content: [{ type: "text", text: response }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );

  // Tool: list_models - List recommended models
  server.tool(
    "list_models",
    "List recommended OpenRouter models for coding tasks",
    {},
    async () => {
      const models = loadRecommendedModels();

      if (models.length === 0) {
        return {
          content: [{ type: "text", text: "No recommended models found. Try search_models instead." }],
        };
      }

      let output = "# Recommended Models\n\n";
      output += "| Model | Provider | Pricing | Context | Tools | Reasoning | Vision |\n";
      output += "|-------|----------|---------|---------|-------|-----------|--------|\n";

      for (const model of models) {
        const tools = model.supportsTools ? "✓" : "·";
        const reasoning = model.supportsReasoning ? "✓" : "·";
        const vision = model.supportsVision ? "✓" : "·";
        output += `| ${model.id} | ${model.provider} | ${model.pricing?.average || "N/A"} | ${model.context || "N/A"} | ${tools} | ${reasoning} | ${vision} |\n`;
      }

      output += "\n## Quick Picks\n";
      output += "- **Fast & cheap**: `x-ai/grok-code-fast-1` ($0.85/1M)\n";
      output += "- **Most advanced**: `openai/gpt-5.2` ($5.00/1M)\n";
      output += "- **Large context**: `google/gemini-3-pro-preview` (1M tokens)\n";
      output += "- **Reasoning**: `moonshotai/kimi-k2-thinking` ($2.50/1M)\n";
      output += "- **Budget**: `minimax/minimax-m2.1` ($0.60/1M)\n";
      output += "- **Code specialist**: `deepseek/deepseek-v3.2` ($1.00/1M)\n";

      return { content: [{ type: "text", text: output }] };
    }
  );

  // Tool: search_models - Search all OpenRouter models
  server.tool(
    "search_models",
    "Search all OpenRouter models by name, provider, or capability",
    {
      query: z.string().describe("Search query (e.g., 'grok', 'vision', 'free')"),
      limit: z.number().optional().describe("Maximum results to return (default: 10)"),
    },
    async ({ query, limit }) => {
      const maxResults = limit || 10;
      const allModels = await loadAllModels();

      if (allModels.length === 0) {
        return {
          content: [{ type: "text", text: "Failed to load models. Check your internet connection." }],
          isError: true,
        };
      }

      // Search with fuzzy matching
      const results = allModels
        .map((model) => {
          const nameScore = fuzzyScore(model.name || "", query);
          const idScore = fuzzyScore(model.id || "", query);
          const descScore = fuzzyScore(model.description || "", query) * 0.5;
          return { model, score: Math.max(nameScore, idScore, descScore) };
        })
        .filter((item) => item.score > 0.2)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults);

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `No models found matching "${query}"` }],
        };
      }

      let output = `# Search Results for "${query}"\n\n`;
      output += "| Model | Provider | Pricing | Context |\n";
      output += "|-------|----------|---------|----------|\n";

      for (const { model } of results) {
        const provider = model.id.split("/")[0];
        const promptPrice = parseFloat(model.pricing?.prompt || "0") * 1000000;
        const completionPrice = parseFloat(model.pricing?.completion || "0") * 1000000;
        const avgPrice = (promptPrice + completionPrice) / 2;
        const pricing = avgPrice > 0 ? `$${avgPrice.toFixed(2)}/1M` : avgPrice < 0 ? "varies" : "FREE";
        const context = model.context_length ? `${Math.round(model.context_length / 1000)}K` : "N/A";

        output += `| ${model.id} | ${provider} | ${pricing} | ${context} |\n`;
      }

      output += `\nUse with: run_prompt(model="${results[0].model.id}", prompt="your prompt")`;

      return { content: [{ type: "text", text: output }] };
    }
  );

  // Tool: compare_models - Run same prompt through multiple models
  server.tool(
    "compare_models",
    "Run the same prompt through multiple models and compare responses",
    {
      models: z.array(z.string()).describe("List of model IDs to compare"),
      prompt: z.string().describe("The prompt to send to all models"),
      system_prompt: z.string().optional().describe("Optional system prompt"),
    },
    async ({ models, prompt, system_prompt }) => {
      const results: Array<{ model: string; response: string; error?: string; tokens?: { input: number; output: number } }> = [];

      for (const model of models) {
        try {
          const result = await runPrompt(model, prompt, system_prompt, 2048);
          results.push({
            model,
            response: result.content,
            tokens: result.usage,
          });
        } catch (error) {
          results.push({
            model,
            response: "",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      let output = "# Model Comparison\n\n";
      output += `**Prompt:** ${prompt.slice(0, 100)}${prompt.length > 100 ? "..." : ""}\n\n`;

      for (const result of results) {
        output += `## ${result.model}\n\n`;
        if (result.error) {
          output += `**Error:** ${result.error}\n\n`;
        } else {
          output += result.response + "\n\n";
          if (result.tokens) {
            output += `*Tokens: ${result.tokens.input} in, ${result.tokens.output} out*\n\n`;
          }
        }
        output += "---\n\n";
      }

      return { content: [{ type: "text", text: output }] };
    }
  );

  // Start server with stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr (stdout is for MCP protocol)
  console.error("[claudish] MCP server started");
}

/**
 * Entry point for MCP server mode
 * Called from index.ts when --mcp flag is used
 */
export function startMcpServer() {
  main().catch((error) => {
    console.error("[claudish] MCP fatal error:", error);
    process.exit(1);
  });
}
