#!/usr/bin/env bun

/**
 * Claudish MCP Server
 *
 * Exposes multi-provider model access as MCP tools for Claude Code.
 * Supports provider@model syntax (e.g., g@gemini-2.0-flash, oai@gpt-5.1, gh@gpt-4o).
 * Falls back to OpenRouter for unrecognized providers.
 * Run with: claudish-mcp (stdio transport)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { config } from "dotenv";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseModelSpec } from "./providers/model-parser.js";
import { PROVIDERS_BY_NAME } from "./providers/provider-definitions.js";
import {
  resolveEffective,
  resolveTransport,
  resolveAPIFormat,
} from "./providers/provider-profiles.js";

// Load environment variables
config();

// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Paths
const RECOMMENDED_MODELS_PATH = join(__dirname, "../recommended-models.json");
const CLAUDISH_CACHE_DIR = join(homedir(), ".claudish");
const ALL_MODELS_CACHE_PATH = join(CLAUDISH_CACHE_DIR, "all-models.json");
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
    mkdirSync(CLAUDISH_CACHE_DIR, { recursive: true });
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
 * Resolve API key for a provider definition, checking primary env var and aliases.
 */
function resolveApiKey(def: { apiKeyEnvVar: string; apiKeyAliases?: string[] }): string {
  if (def.apiKeyEnvVar && process.env[def.apiKeyEnvVar]) {
    return process.env[def.apiKeyEnvVar]!;
  }
  if (def.apiKeyAliases) {
    for (const alias of def.apiKeyAliases) {
      if (process.env[alias]) return process.env[alias]!;
    }
  }
  return "";
}

/**
 * Run a prompt through the provider system.
 *
 * Parses model with provider@model syntax, resolves the provider definition,
 * builds the request via the adapter, and fetches a non-streaming response.
 */
async function runPrompt(
  model: string,
  prompt: string,
  systemPrompt?: string,
  maxTokens?: number,
  files?: string[],
): Promise<{ content: string; usage?: { input: number; output: number } }> {
  // Parse model spec (e.g., "g@gemini-2.0-flash", "openai/gpt-5.1")
  const parsed = parseModelSpec(model);

  // Look up provider definition
  let def = PROVIDERS_BY_NAME.get(parsed.provider);

  // Fall back to OpenRouter for unknown providers
  if (!def) {
    def = PROVIDERS_BY_NAME.get("openrouter");
    if (!def) {
      throw new Error(`No provider found for "${parsed.provider}" and OpenRouter fallback unavailable`);
    }
    // For OpenRouter fallback, use the original model string as the model name
    parsed.model = parsed.original;
  }

  // Resolve effective definition (handles Zen minimax swap, publicKeyFallback, etc.)
  const apiKey = resolveApiKey(def);
  const effective = resolveEffective(def, parsed.model, apiKey);

  // Resolve transport and adapter
  const transport = resolveTransport(effective.def, parsed.model, effective.apiKey);
  if (!transport) {
    throw new Error(
      `Cannot create transport for provider "${effective.def.name}". ` +
      `Check that ${effective.def.apiKeyEnvVar || "the required API key"} is set.`
    );
  }

  const adapter = resolveAPIFormat(effective.def, parsed.model);
  if (!adapter) {
    throw new Error(`Cannot create format adapter for provider "${effective.def.name}"`);
  }

  // Build a Claude-shaped request so the adapter can convert it
  let fullPrompt = prompt;
  if (files && files.length > 0) {
    fullPrompt += "\n\n---\n";
    for (const filePath of files) {
      try {
        const content = readFileSync(filePath, "utf-8");
        fullPrompt += `\n### File: ${filePath}\n\`\`\`\n${content}\n\`\`\`\n`;
      } catch (e) {
        fullPrompt += `\n### File: ${filePath}\n[Error reading file: ${e instanceof Error ? e.message : String(e)}]\n`;
      }
    }
  }

  const claudeRequest: any = {
    model: parsed.model,
    max_tokens: maxTokens || 4096,
    messages: [{ role: "user", content: fullPrompt }],
  };

  if (systemPrompt) {
    claudeRequest.system = systemPrompt;
  }

  // Convert through adapter
  const messages = adapter.convertMessages(claudeRequest);
  const tools: any[] = [];
  const payload = adapter.buildPayload(claudeRequest, messages, tools);

  // Make it non-streaming
  // Gemini uses a different endpoint for non-streaming
  let endpoint: string;
  if (transport.getNonStreamingEndpoint) {
    endpoint = transport.getNonStreamingEndpoint(parsed.model);
  } else {
    // For OpenAI-compatible APIs, set stream=false and remove stream_options
    payload.stream = false;
    delete payload.stream_options;
    endpoint = transport.getEndpoint(parsed.model);
  }

  const headers = await transport.getHeaders();
  headers["Content-Type"] = "application/json";

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `${effective.def.displayName} API error: ${response.status} - ${errorText}`
    );
  }

  const data = await response.json();
  return adapter.parseResponse(data);
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

  console.error("[claudish] MCP server started");

  // Tool: run_prompt - Run a prompt through any provider
  server.tool(
    "run_prompt",
    "Run a prompt through a model using provider@model syntax (e.g., g@gemini-2.0-flash, oai@gpt-5.1, gh@gpt-4o, or@deepseek/deepseek-r1). Falls back to OpenRouter for unrecognized providers.",
    {
      model: z
        .string()
        .describe("Model in provider@model syntax (e.g., 'g@gemini-2.0-flash', 'oai@gpt-5.1', 'gh@gpt-4o') or OpenRouter model ID"),
      prompt: z.string().describe("The prompt to send to the model"),
      system_prompt: z.string().optional().describe("Optional system prompt"),
      max_tokens: z
        .number()
        .optional()
        .describe("Maximum tokens in response (default: 4096)"),
      files: z
        .array(z.string())
        .optional()
        .describe("File paths to read and append after the prompt"),
    },
    async ({ model, prompt, system_prompt, max_tokens, files }) => {
      try {
        const result = await runPrompt(model, prompt, system_prompt, max_tokens, files);

        let response = result.content;
        if (result.usage) {
          response += `\n\n---\nTokens: ${result.usage.input} input, ${result.usage.output} output`;
        }

        return { content: [{ type: "text", text: response }] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Tool: list_models - List recommended models
  server.tool("list_models", "List recommended models for coding tasks", {}, async () => {
    const models = loadRecommendedModels();

    if (models.length === 0) {
      return {
        content: [
          { type: "text", text: "No recommended models found. Try search_models instead." },
        ],
      };
    }

    let output = "# Recommended Models\n\n";
    output += "| Model | Provider | Pricing | Context | Tools | Reasoning | Vision |\n";
    output += "|-------|----------|---------|---------|-------|-----------|--------|\n";

    for (const model of models) {
      const tools = model.supportsTools ? "Y" : ".";
      const reasoning = model.supportsReasoning ? "Y" : ".";
      const vision = model.supportsVision ? "Y" : ".";
      output += `| ${model.id} | ${model.provider} | ${model.pricing?.average || "N/A"} | ${model.context || "N/A"} | ${tools} | ${reasoning} | ${vision} |\n`;
    }

    output += "\n## Quick Picks\n";
    output += "- **Budget**: `minimax-m2.5` ($0.75/1M)\n";
    output += "- **Large context**: `gemini-3.1-pro-preview` (1M tokens)\n";
    output += "- **Most advanced**: `gpt-5.4` ($8.75/1M)\n";
    output += "- **Vision + coding**: `kimi-k2.5` ($1.32/1M)\n";
    output += "- **Agentic**: `glm-5` ($1.68/1M)\n";
    output += "- **Multimodal**: `qwen3.5-plus-02-15` ($1.40/1M)\n";

    return { content: [{ type: "text", text: output }] };
  });

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
          content: [
            { type: "text", text: "Failed to load models. Check your internet connection." },
          ],
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
        const pricing =
          avgPrice > 0 ? `$${avgPrice.toFixed(2)}/1M` : avgPrice < 0 ? "varies" : "FREE";
        const context = model.context_length
          ? `${Math.round(model.context_length / 1000)}K`
          : "N/A";

        output += `| ${model.id} | ${provider} | ${pricing} | ${context} |\n`;
      }

      output += `\nUse with: run_prompt(model="${results[0].model.id}", prompt="your prompt")`;

      return { content: [{ type: "text", text: output }] };
    }
  );

  // Tool: compare_models - Run same prompt through multiple models
  server.tool(
    "compare_models",
    "Run the same prompt through multiple models and compare responses. Supports provider@model syntax.",
    {
      models: z.array(z.string()).describe("List of model IDs to compare (provider@model syntax supported)"),
      prompt: z.string().describe("The prompt to send to all models"),
      system_prompt: z.string().optional().describe("Optional system prompt"),
      files: z
        .array(z.string())
        .optional()
        .describe("File paths to read and append after the prompt"),
    },
    async ({ models, prompt, system_prompt, files }) => {
      const results: Array<{
        model: string;
        response: string;
        error?: string;
        tokens?: { input: number; output: number };
      }> = [];

      for (const model of models) {
        try {
          const result = await runPrompt(model, prompt, system_prompt, 2048, files);
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
