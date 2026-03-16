#!/usr/bin/env bun

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
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseModelSpec } from "./providers/model-parser.js";
import { getProviderByName, getApiKeyInfo } from "./providers/provider-definitions.js";

import { selectProviderComponents } from "./providers/provider-components.js";
import type { FormatAdapter } from "./adapters/format-adapter.js";
import type { ProviderTransport, StreamFormat } from "./providers/transport/types.js";

// Load environment variables
config();

// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Paths - use ~/.claudish/ for writable cache (binaries can't write to __dirname)
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
async function loadRecommendedModels(): Promise<ModelInfo[]> {
  try {
    const data = JSON.parse(await readFile(RECOMMENDED_MODELS_PATH, "utf-8"));
    return data.models || [];
  } catch {
    return [];
  }
}

/**
 * Load or fetch all models from OpenRouter
 */
async function loadAllModels(forceRefresh = false): Promise<any[]> {
  // Check cache
  if (!forceRefresh) {
    try {
      const cacheData = JSON.parse(await readFile(ALL_MODELS_CACHE_PATH, "utf-8"));
      const lastUpdated = new Date(cacheData.lastUpdated);
      const ageInDays = (Date.now() - lastUpdated.getTime()) / (1000 * 60 * 60 * 24);

      if (ageInDays <= CACHE_MAX_AGE_DAYS) {
        return cacheData.models || [];
      }
    } catch {
      // Cache missing or invalid, fetch fresh
    }
  }

  // Fetch from OpenRouter
  try {
    const response = await fetch("https://openrouter.ai/api/v1/models");
    if (!response.ok) throw new Error(`API returned ${response.status}`);

    const data: any = await response.json();
    const models = data.data || [];

    // Cache result - ensure directory exists
    await mkdir(CLAUDISH_CACHE_DIR, { recursive: true });
    await writeFile(
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
    try {
      const cacheData = JSON.parse(await readFile(ALL_MODELS_CACHE_PATH, "utf-8"));
      return cacheData.models || [];
    } catch {
      return [];
    }
  }
}

/**
 * Create transport + format adapter for a model.
 * Uses the provider factory for known providers, falls back to OpenRouter.
 */
function createComponentsForModel(model: string): {
  transport: ProviderTransport;
  adapter: FormatAdapter;
  modelName: string;
} {
  const parsed = parseModelSpec(model);
  const def = getProviderByName(parsed.provider);

  if (def) {
    // Resolve API key from provider definition
    const keyInfo = getApiKeyInfo(def.name);
    let apiKey = keyInfo?.envVar ? process.env[keyInfo.envVar] : "";
    if (!apiKey && def.publicKeyFallback) {
      apiKey = "public";
    }

    // Only use direct provider if we have a key (or it's free).
    // Missing key with explicit provider@ syntax is an error;
    // otherwise fall through to OpenRouter.
    if (!apiKey && def.apiKeyEnvVar) {
      if (parsed.isExplicitProvider) {
        throw new Error(`${def.apiKeyEnvVar} environment variable not set for ${def.displayName}`);
      }
      // Fall through to OpenRouter
    } else {
      const components = selectProviderComponents(def, parsed.model, apiKey || "");
      if (components) {
        return {
          transport: components.transport,
          adapter: components.formatAdapter,
          modelName: parsed.model,
        };
      }
    }
  }

  // Fall back to OpenRouter via factory
  const orApiKey = process.env.OPENROUTER_API_KEY;
  if (!orApiKey) {
    throw new Error("OPENROUTER_API_KEY environment variable not set");
  }
  const orDef = getProviderByName("openrouter");
  if (!orDef) {
    throw new Error("OpenRouter provider definition not found");
  }
  const orComponents = selectProviderComponents(orDef, parsed.model, orApiKey);
  if (!orComponents) {
    throw new Error("Failed to create OpenRouter transport");
  }
  return {
    transport: orComponents.transport,
    adapter: orComponents.formatAdapter,
    modelName: parsed.model,
  };
}

/**
 * Run a prompt through a model using the transport/adapter stack.
 * Non-streaming — collects full response and parses based on adapter type.
 */
async function runPrompt(
  model: string,
  prompt: string,
  systemPrompt?: string,
  maxTokens?: number
): Promise<{ content: string; usage?: { input: number; output: number } }> {
  const { transport, adapter, modelName } = createComponentsForModel(model);

  // Build a Claude-format request for the adapter to convert
  const claudeRequest: any = {
    model: modelName,
    messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    max_tokens: maxTokens || 4096,
  };
  if (systemPrompt) {
    claudeRequest.system = systemPrompt;
  }

  // Use adapter to convert messages and build payload
  const messages = adapter.convertMessages(claudeRequest);
  const tools = adapter.convertTools(claudeRequest);
  const payload = adapter.buildPayload(claudeRequest, messages, tools);

  // Non-streaming: Gemini uses a different endpoint URL, others use stream:false
  let endpoint = transport.getEndpoint(modelName);
  if (transport.streamFormat === "gemini-sse" || transport.streamFormat === "gemini-codeassist-sse") {
    endpoint = endpoint.replace(":streamGenerateContent?alt=sse", ":generateContent");
  } else {
    payload.stream = false;
    delete payload.stream_options;
  }

  const headers = await transport.getHeaders();
  headers["Content-Type"] = "application/json";

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`${transport.displayName} API error: ${response.status} - ${error}`);
  }

  const data: any = await response.json();

  // Parse response based on wire format (matches streaming dispatch in provider-handler)
  return parseResponse(transport.streamFormat, data);
}

/**
 * Extract content and usage from provider response based on stream format.
 * Uses the same format discriminator as the streaming parsers in provider-handler.
 */
function parseResponse(
  format: StreamFormat,
  data: any,
): { content: string; usage?: { input: number; output: number } } {
  switch (format) {
    case "gemini-codeassist-sse":
    case "gemini-sse": {
      const responseData = format === "gemini-codeassist-sse" ? (data.response || data) : data;
      const text = responseData.candidates?.[0]?.content?.parts
        ?.map((p: any) => p.text || "")
        .join("") || "";
      const usage = responseData.usageMetadata
        ? { input: responseData.usageMetadata.promptTokenCount, output: responseData.usageMetadata.candidatesTokenCount }
        : undefined;
      return { content: text, usage };
    }

    case "anthropic-sse": {
      const text = data.content
        ?.filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("") || "";
      const usage = data.usage
        ? { input: data.usage.input_tokens, output: data.usage.output_tokens }
        : undefined;
      return { content: text, usage };
    }

    case "ollama-jsonl": {
      const text = data.message?.content || "";
      return { content: text };
    }

    case "openai-sse":
    case "openai-responses-sse":
    default: {
      const text = data.choices?.[0]?.message?.content || "";
      const usage = data.usage
        ? { input: data.usage.prompt_tokens, output: data.usage.completion_tokens }
        : undefined;
      return { content: text, usage };
    }
  }
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

  // Tool: run_prompt - Run a prompt through any supported model
  server.tool(
    "run_prompt",
    "Run a prompt through any model: OpenRouter (vendor/model), GitHub Models (gh@model), Gemini (google/gemini-*), Zen (zen@model), etc.",
    {
      model: z
        .string()
        .describe("Model ID. Direct: 'gh@gpt-4o-mini', 'zen@gpt-5-nano'. OpenRouter: 'x-ai/grok-code-fast-1', 'openai/gpt-5.1-codex'"),
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
  server.tool(
    "list_models",
    "List recommended models for coding tasks",
    {},
    async () => {
      const models = await loadRecommendedModels();

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
      const tools = model.supportsTools ? "✓" : "·";
      const reasoning = model.supportsReasoning ? "✓" : "·";
      const vision = model.supportsVision ? "✓" : "·";
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
    "Run the same prompt through multiple models and compare responses",
    {
      models: z.array(z.string()).describe("List of model IDs to compare"),
      prompt: z.string().describe("The prompt to send to all models"),
      system_prompt: z.string().optional().describe("Optional system prompt"),
    },
    async ({ models, prompt, system_prompt }) => {
      const results: Array<{
        model: string;
        response: string;
        error?: string;
        tokens?: { input: number; output: number };
      }> = [];

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
