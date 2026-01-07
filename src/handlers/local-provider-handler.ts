/**
 * Local Provider Handler
 *
 * Handles requests to local OpenAI-compatible providers like Ollama, LM Studio, vLLM.
 * Uses the Provider Registry for configuration and shared OpenAI-compat utilities.
 */

import type { Context } from "hono";
import type { ModelHandler } from "./types.js";
import type { LocalProvider } from "../providers/provider-registry.js";
import { AdapterManager } from "../adapters/adapter-manager.js";
import { MiddlewareManager } from "../middleware/index.js";
import { transformOpenAIToClaude } from "../transform.js";
import { log, logStructured } from "../logger.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Agent } from "undici";
import {
  convertMessagesToOpenAI,
  convertToolsToOpenAI,
  filterIdentity,
  createStreamingResponseHandler,
  estimateTokens,
} from "./shared/openai-compat.js";

// Create a custom undici agent with long timeouts for local LLM inference
// Default undici headersTimeout is 30s which is too short for prompt processing
const localProviderAgent = new Agent({
  headersTimeout: 600000, // 10 minutes for headers (prompt processing time)
  bodyTimeout: 600000, // 10 minutes for body (generation time)
  keepAliveTimeout: 30000, // 30 seconds keepalive
  keepAliveMaxTimeout: 600000,
});

export interface LocalProviderOptions {
  summarizeTools?: boolean; // Summarize tool descriptions to reduce prompt size
}

export class LocalProviderHandler implements ModelHandler {
  private provider: LocalProvider;
  private modelName: string;
  private adapterManager: AdapterManager;
  private middlewareManager: MiddlewareManager;
  private port: number;
  private healthChecked = false;
  private isHealthy = false;
  private contextWindow = 32768; // Default context window (32K reasonable for modern models)
  private sessionInputTokens = 0;
  private sessionOutputTokens = 0;
  private options: LocalProviderOptions;

  constructor(
    provider: LocalProvider,
    modelName: string,
    port: number,
    options: LocalProviderOptions = {}
  ) {
    this.provider = provider;
    this.modelName = modelName;
    this.port = port;
    this.options = options;
    this.adapterManager = new AdapterManager(modelName);
    this.middlewareManager = new MiddlewareManager();
    this.middlewareManager.initialize().catch((err) => {
      log(`[LocalProvider:${provider.name}] Middleware init error: ${err}`);
    });

    // Check for env var override of context window (useful when API doesn't expose it)
    const envContextWindow = process.env.CLAUDISH_CONTEXT_WINDOW;
    if (envContextWindow) {
      const parsed = parseInt(envContextWindow, 10);
      if (!isNaN(parsed) && parsed > 0) {
        this.contextWindow = parsed;
        log(`[LocalProvider:${provider.name}] Context window from env: ${this.contextWindow}`);
      }
    }

    // Write initial token file so status line has data from the start
    this.writeTokenFile(0, 0);
    if (options.summarizeTools) {
      log(`[LocalProvider:${provider.name}] Tool summarization enabled`);
    }
  }

  /**
   * Check if the local provider is available
   */
  async checkHealth(): Promise<boolean> {
    if (this.healthChecked) return this.isHealthy;

    // Try Ollama-specific health check first
    try {
      const healthUrl = `${this.provider.baseUrl}/api/tags`;
      log(`[LocalProvider:${this.provider.name}] Trying health check: ${healthUrl}`);
      const response = await fetch(healthUrl, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });

      if (response.ok) {
        this.isHealthy = true;
        this.healthChecked = true;
        log(`[LocalProvider:${this.provider.name}] Health check passed (/api/tags)`);
        return true;
      }
      log(
        `[LocalProvider:${this.provider.name}] /api/tags returned ${response.status}, trying /v1/models`
      );
    } catch (e: any) {
      log(
        `[LocalProvider:${this.provider.name}] /api/tags failed: ${e?.message || e}, trying /v1/models`
      );
    }

    // Try generic OpenAI-compatible health check (works for MLX, LM Studio, vLLM, etc.)
    try {
      const modelsUrl = `${this.provider.baseUrl}/v1/models`;
      log(`[LocalProvider:${this.provider.name}] Trying health check: ${modelsUrl}`);
      const response = await fetch(modelsUrl, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        this.isHealthy = true;
        this.healthChecked = true;
        log(`[LocalProvider:${this.provider.name}] Health check passed (/v1/models)`);
        return true;
      }
      log(`[LocalProvider:${this.provider.name}] /v1/models returned ${response.status}`);
    } catch (e: any) {
      log(`[LocalProvider:${this.provider.name}] /v1/models failed: ${e?.message || e}`);
    }

    this.healthChecked = true;
    this.isHealthy = false;
    log(`[LocalProvider:${this.provider.name}] Health check FAILED - provider not available`);
    return false;
  }

  /**
   * Fetch context window size from provider-specific endpoints
   */
  private async fetchContextWindow(): Promise<void> {
    log(`[LocalProvider:${this.provider.name}] Fetching context window...`);
    if (this.provider.name === "ollama") {
      await this.fetchOllamaContextWindow();
    } else if (this.provider.name === "lmstudio") {
      await this.fetchLMStudioContextWindow();
    } else {
      log(
        `[LocalProvider:${this.provider.name}] No context window fetch for this provider, using default: ${this.contextWindow}`
      );
    }
  }

  /**
   * Fetch context window from Ollama's /api/show endpoint
   */
  private async fetchOllamaContextWindow(): Promise<void> {
    try {
      const response = await fetch(`${this.provider.baseUrl}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: this.modelName }),
        signal: AbortSignal.timeout(3000),
      });

      if (response.ok) {
        const data = (await response.json()) as any;
        // Ollama returns context window in model_info
        // Can be at general.context_length OR {architecture}.context_length
        let ctxFromInfo = data.model_info?.["general.context_length"];

        // If not found at general.context_length, search for {arch}.context_length
        if (!ctxFromInfo && data.model_info) {
          for (const key of Object.keys(data.model_info)) {
            if (key.endsWith(".context_length")) {
              ctxFromInfo = data.model_info[key];
              break;
            }
          }
        }

        const ctxFromParams = data.parameters?.match(/num_ctx\s+(\d+)/)?.[1];
        if (ctxFromInfo) {
          this.contextWindow = parseInt(String(ctxFromInfo), 10);
        } else if (ctxFromParams) {
          this.contextWindow = parseInt(ctxFromParams, 10);
        } else {
          // Keep class default (32K)
          log(
            `[LocalProvider:${this.provider.name}] No context info found, using default: ${this.contextWindow}`
          );
        }
        if (ctxFromInfo || ctxFromParams) {
          log(`[LocalProvider:${this.provider.name}] Context window: ${this.contextWindow}`);
        }
      }
    } catch (e) {
      // Use default context window
    }
  }

  /**
   * Fetch context window from LM Studio's /v1/models endpoint
   */
  private async fetchLMStudioContextWindow(): Promise<void> {
    try {
      const response = await fetch(`${this.provider.baseUrl}/v1/models`, {
        method: "GET",
        signal: AbortSignal.timeout(3000),
      });

      if (response.ok) {
        const data = (await response.json()) as any;
        log(`[LocalProvider:lmstudio] Models response: ${JSON.stringify(data).slice(0, 500)}`);

        // LM Studio returns models in data array
        // Look for the loaded model and check for context_length
        const models = data.data || [];
        // Try exact match first, then path-based match (model names often include org/name)
        const targetModel =
          models.find((m: any) => m.id === this.modelName) ||
          models.find((m: any) => m.id?.endsWith(`/${this.modelName}`)) ||
          models.find((m: any) => this.modelName.includes(m.id));

        if (targetModel) {
          // Check various possible locations for context length
          const ctxLength =
            targetModel.context_length ||
            targetModel.max_context_length ||
            targetModel.context_window ||
            targetModel.max_tokens;
          if (ctxLength && typeof ctxLength === "number") {
            this.contextWindow = ctxLength;
            log(`[LocalProvider:lmstudio] Context window from model: ${this.contextWindow}`);
            return;
          }
        }

        // LM Studio often uses 4096 or 8192 as defaults, but many models support more
        // Use a reasonable default for modern models
        this.contextWindow = 32768;
        log(`[LocalProvider:lmstudio] Using default context window: ${this.contextWindow}`);
      }
    } catch (e: any) {
      // Use default - LM Studio typically supports at least 4K
      this.contextWindow = 32768;
      log(
        `[LocalProvider:lmstudio] Failed to fetch model info: ${e?.message || e}. Using default: ${this.contextWindow}`
      );
    }
  }

  /**
   * Write token tracking file for status line
   */
  private writeTokenFile(input: number, output: number): void {
    try {
      // For local models, prompt_tokens represents the FULL conversation context each request
      // (not incremental), so we use the latest value directly instead of accumulating.
      // Output tokens ARE incremental (new tokens generated), so we accumulate those.
      if (input > 0) {
        this.sessionInputTokens = input; // Use latest (already includes full context)
      }
      this.sessionOutputTokens += output; // Accumulate outputs
      const sessionTotal = this.sessionInputTokens + this.sessionOutputTokens;

      // Calculate context usage: input (full context) + accumulated outputs
      const leftPct =
        this.contextWindow > 0
          ? Math.max(
              0,
              Math.min(
                100,
                Math.round(((this.contextWindow - sessionTotal) / this.contextWindow) * 100)
              )
            )
          : 100;

      const data = {
        input_tokens: this.sessionInputTokens,
        output_tokens: this.sessionOutputTokens,
        total_tokens: sessionTotal,
        total_cost: 0, // Local models are free
        context_window: this.contextWindow,
        context_left_percent: leftPct,
        updated_at: Date.now(),
      };

      // Write to ~/.claudish/ directory (same location status line reads from)
      const claudishDir = join(homedir(), ".claudish");
      mkdirSync(claudishDir, { recursive: true });
      writeFileSync(join(claudishDir, `tokens-${this.port}.json`), JSON.stringify(data), "utf-8");
    } catch (e) {
      // Ignore write errors
    }
  }

  async handle(c: Context, payload: any): Promise<Response> {
    const target = this.modelName;

    logStructured(`LocalProvider Request`, {
      provider: this.provider.name,
      targetModel: target,
      originalModel: payload.model,
      baseUrl: this.provider.baseUrl,
    });

    // Health check on first request
    if (!this.healthChecked) {
      const healthy = await this.checkHealth();
      if (!healthy) {
        return this.errorResponse(c, "connection_error", this.getConnectionErrorMessage());
      }
      // Fetch context window after successful health check
      await this.fetchContextWindow();
    }

    // Transform request
    const { claudeRequest, droppedParams } = transformOpenAIToClaude(payload);
    // Use simple format for providers that don't support complex message structures
    // MLX doesn't handle array content or tool role messages
    const useSimpleFormat = this.provider.name === "mlx";
    const messages = convertMessagesToOpenAI(
      claudeRequest,
      target,
      filterIdentity,
      useSimpleFormat
    );
    const tools = convertToolsToOpenAI(claudeRequest, this.options.summarizeTools);

    // Check capability: strip tools if not supported
    const finalTools = this.provider.capabilities.supportsTools ? tools : [];
    if (tools.length > 0 && !this.provider.capabilities.supportsTools) {
      log(`[LocalProvider:${this.provider.name}] Tools stripped (not supported)`);
    }
    if (tools.length > 0 && this.options.summarizeTools) {
      log(`[LocalProvider:${this.provider.name}] Tools summarized (${tools.length} tools)`);
    }

    // Add guidance to system prompt for local models
    if (messages.length > 0 && messages[0].role === "system") {
      let guidance = `

IMPORTANT INSTRUCTIONS FOR THIS MODEL:

1. OUTPUT BEHAVIOR:
- NEVER output your internal reasoning, thinking process, or chain-of-thought as visible text.
- Only output your final response, actions, or tool calls.
- Do NOT ramble or speculate about what the user might want.

2. CONVERSATION HANDLING:
- Always look back at the ORIGINAL user request in the conversation history.
- When you receive results from a Task/agent you called, SYNTHESIZE those results and continue fulfilling the user's original request.
- Do NOT ask "What would you like help with?" if there's already a user request in the conversation.
- Only ask for clarification if the FIRST user message in the conversation is unclear.
- After calling tools or agents, continue with the next step - don't restart or ask what to do.

3. CRITICAL - AFTER TOOL RESULTS:
- When you see tool results (like file lists, search results, or command output), ALWAYS continue working.
- Analyze the results and take the next action toward completing the user's request.
- If the user asked for "evaluation and suggestions", you MUST provide analysis and recommendations after seeing the data.
- NEVER stop after just calling one tool - continue until you've fully addressed the user's request.
- If you called a Glob/Search and got files, READ important files next, then ANALYZE, then SUGGEST improvements.`;

      // Add tool calling guidance if tools are present
      if (finalTools.length > 0) {
        // Check if this is a Qwen model that needs explicit tool format instructions
        const isQwen = target.toLowerCase().includes("qwen");

        if (isQwen) {
          guidance += `

4. TOOL CALLING FORMAT (CRITICAL FOR QWEN):
You MUST use proper OpenAI-style function calling. Do NOT output tool calls as XML text.
When you want to call a tool, use the API's tool_calls mechanism, NOT text like <function=...>.
The tool calls must be structured JSON in the API response, not XML in your text output.

If you cannot use structured tool_calls, format as JSON:
{"name": "tool_name", "arguments": {"param1": "value1", "param2": "value2"}}

5. TOOL PARAMETER REQUIREMENTS:`;
        } else {
          guidance += `

4. TOOL CALLING REQUIREMENTS:`;
        }

        guidance += `
- When calling tools, you MUST include ALL required parameters. Incomplete tool calls will fail.
- For Task: always include "description" (3-5 words), "prompt" (detailed instructions), and "subagent_type"
- For Bash: always include "command" and "description"
- For Read/Write/Edit: always include the full "file_path"
- For Grep/Glob: always include "pattern"
- Ensure your tool call JSON is complete with all required fields before submitting.`;
      }

      messages[0].content += guidance;
    }

    // Detect model family for optimized sampling parameters
    const modelLower = target.toLowerCase();
    const isQwenModel = modelLower.includes("qwen");
    const isDeepSeekModel = modelLower.includes("deepseek");
    const isLlamaModel = modelLower.includes("llama");
    const isMistralModel = modelLower.includes("mistral");

    // Hardcoded recommended sampling parameters per model family
    // These are optimized defaults - no env vars needed
    const getSamplingParams = () => {
      if (isQwenModel) {
        // Qwen3 Instruct recommended settings
        // Source: Qwen team + community testing for thinking mode stability
        return {
          temperature: 0.7,
          top_p: 0.8,
          top_k: 20,
          min_p: 0.0,
          repetition_penalty: 1.05, // Slight penalty helps with Qwen repetition
        };
      }
      if (isDeepSeekModel) {
        // DeepSeek Coder recommended settings
        return {
          temperature: 0.6,
          top_p: 0.95,
          top_k: 40,
          min_p: 0.0,
          repetition_penalty: 1.0,
        };
      }
      if (isLlamaModel) {
        // Llama 3.x recommended settings
        return {
          temperature: 0.7,
          top_p: 0.9,
          top_k: 40,
          min_p: 0.05,
          repetition_penalty: 1.1,
        };
      }
      if (isMistralModel) {
        // Mistral recommended settings
        return {
          temperature: 0.7,
          top_p: 0.9,
          top_k: 50,
          min_p: 0.0,
          repetition_penalty: 1.0,
        };
      }
      // Generic defaults for other models
      return {
        temperature: 0.7,
        top_p: 0.9,
        top_k: 40,
        min_p: 0.0,
        repetition_penalty: 1.0,
      };
    };

    const samplingParams = getSamplingParams();
    log(
      `[LocalProvider:${this.provider.name}] Using sampling params: temp=${samplingParams.temperature}, top_p=${samplingParams.top_p}, top_k=${samplingParams.top_k}`
    );

    // For local providers, ensure max_tokens is set to a reasonable value
    // Some local providers have very low defaults or ignore Claude's max_tokens
    // Use the larger of: Claude's request, 8192 minimum for meaningful responses
    const requestedMaxTokens = claudeRequest.max_tokens || 4096;
    const effectiveMaxTokens = Math.max(requestedMaxTokens, 8192);

    log(
      `[LocalProvider:${this.provider.name}] max_tokens: requested=${requestedMaxTokens}, effective=${effectiveMaxTokens}`
    );

    // Build OpenAI-compatible payload
    const openAIPayload: any = {
      model: target,
      messages,
      // Sampling params - optimized per model family
      // Critical to avoid infinite loops with Qwen3 thinking mode
      temperature: samplingParams.temperature,
      top_p: samplingParams.top_p,
      top_k: samplingParams.top_k,
      min_p: samplingParams.min_p,
      repetition_penalty:
        samplingParams.repetition_penalty > 1 ? samplingParams.repetition_penalty : undefined,
      stream: this.provider.capabilities.supportsStreaming,
      max_tokens: effectiveMaxTokens,
      tools: finalTools.length > 0 ? finalTools : undefined,
      stream_options: this.provider.capabilities.supportsStreaming
        ? { include_usage: true }
        : undefined,
      // Note: Removed stop sequences - they can cause premature termination
      // The chat template should handle turn boundaries naturally
    };

    // For Qwen models: add /no_think to disable thinking mode if causing issues
    // This can be toggled by setting CLAUDISH_QWEN_NO_THINK=1
    if (isQwenModel && process.env.CLAUDISH_QWEN_NO_THINK === "1") {
      if (messages.length > 0 && messages[0].role === "system") {
        messages[0].content = "/no_think\n\n" + messages[0].content;
        log(`[LocalProvider:${this.provider.name}] Added /no_think to disable Qwen thinking mode`);
      }
    }

    // For Ollama: set context window size to ensure tools aren't truncated
    // This is critical - Ollama defaults to 2048 and silently truncates, losing tool definitions!
    if (this.provider.name === "ollama") {
      // Use detected context window, or 32K minimum for tool calling (Claude Code sends large system prompts)
      const numCtx = Math.max(this.contextWindow, 32768);
      openAIPayload.options = { num_ctx: numCtx };
      log(
        `[LocalProvider:${this.provider.name}] Setting num_ctx: ${numCtx} (detected: ${this.contextWindow})`
      );
    }

    // Handle tool choice
    if (claudeRequest.tool_choice && finalTools.length > 0) {
      const { type, name } = claudeRequest.tool_choice;
      if (type === "tool" && name) {
        openAIPayload.tool_choice = { type: "function", function: { name } };
      } else if (type === "auto" || type === "none") {
        openAIPayload.tool_choice = type;
      }
    }

    // Apply adapter transformations
    const adapter = this.adapterManager.getAdapter();
    if (typeof adapter.reset === "function") adapter.reset();
    adapter.prepareRequest(openAIPayload, claudeRequest);

    // Strip parameters that local providers don't support
    // These are cloud-API-specific (e.g., Qwen API's enable_thinking, thinking_budget)
    // LM Studio, Ollama, etc. don't understand these and may behave unexpectedly
    delete openAIPayload.enable_thinking;
    delete openAIPayload.thinking_budget;
    delete openAIPayload.thinking;

    // Apply middleware
    await this.middlewareManager.beforeRequest({
      modelId: target,
      messages,
      tools: finalTools,
      stream: openAIPayload.stream,
    });

    // Make request to local provider
    const apiUrl = `${this.provider.baseUrl}${this.provider.apiPath}`;

    // Debug logging (only to file, not console)
    log(
      `[LocalProvider:${this.provider.name}] Request: ${openAIPayload.tools?.length || 0} tools, ${messages.length} messages`
    );
    log(`[LocalProvider:${this.provider.name}] Endpoint: ${apiUrl}`);

    try {
      // Use a long timeout for local providers - they need time for prompt processing
      // before sending response headers. Default undici timeout is ~30s which is too short
      // for large prompts on local models.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        log(`[LocalProvider:${this.provider.name}] Request timeout (10 min) - aborting`);
        controller.abort();
      }, 600000); // 10 minutes - local models can be slow

      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(openAIPayload),
        signal: controller.signal,
        // @ts-ignore - Use custom undici agent with long timeouts for local LLM inference
        dispatcher: localProviderAgent,
      });

      clearTimeout(timeoutId);

      log(`[LocalProvider:${this.provider.name}] Response status: ${response.status}`);
      if (!response.ok) {
        const errorBody = await response.text();
        log(`[LocalProvider:${this.provider.name}] ERROR: ${errorBody.slice(0, 200)}`);
        return this.handleErrorResponse(c, response.status, errorBody);
      }

      log(`[LocalProvider:${this.provider.name}] Response OK, proceeding to streaming...`);
      if (droppedParams.length > 0) {
        c.header("X-Dropped-Params", droppedParams.join(", "));
      }

      // Handle streaming response
      log(`[LocalProvider:${this.provider.name}] Streaming: ${openAIPayload.stream}`);
      if (openAIPayload.stream) {
        return createStreamingResponseHandler(
          c,
          response,
          adapter,
          target,
          this.middlewareManager,
          (input, output) => this.writeTokenFile(input, output),
          claudeRequest.tools // Pass tool schemas for validation
        );
      }

      // Handle non-streaming response (shouldn't normally happen)
      const data = await response.json();
      return c.json(data);
    } catch (error: any) {
      if (error.code === "ECONNREFUSED" || error.cause?.code === "ECONNREFUSED") {
        return this.errorResponse(c, "connection_error", this.getConnectionErrorMessage());
      }
      throw error;
    }
  }

  private handleErrorResponse(c: Context, status: number, errorBody: string): Response {
    // Parse error and provide helpful messages
    try {
      const parsed = JSON.parse(errorBody);
      const errorMsg = parsed.error?.message || parsed.error || errorBody;

      // Model not found
      if (
        errorMsg.includes("model") &&
        (errorMsg.includes("not found") || errorMsg.includes("does not exist"))
      ) {
        return this.errorResponse(
          c,
          "model_not_found",
          `Model '${this.modelName}' not found. ${this.getModelPullHint()}`
        );
      }

      // Model doesn't support tools - provide helpful message
      if (
        errorMsg.includes("does not support tools") ||
        (errorMsg.includes("tool") && errorMsg.includes("not supported"))
      ) {
        return this.errorResponse(
          c,
          "capability_error",
          `Model '${this.modelName}' does not support tool/function calling. Claude Code requires tool support for most operations. Try a model that supports tools (e.g., llama3.2, mistral, qwen2.5).`,
          400
        );
      }

      return this.errorResponse(c, "api_error", errorMsg, status);
    } catch {
      return this.errorResponse(c, "api_error", errorBody, status);
    }
  }

  private errorResponse(c: Context, type: string, message: string, status: number = 503): Response {
    return c.json(
      {
        error: {
          type,
          message,
        },
      },
      status as any
    );
  }

  private getConnectionErrorMessage(): string {
    switch (this.provider.name) {
      case "ollama":
        return `Cannot connect to Ollama at ${this.provider.baseUrl}. Make sure Ollama is running with: ollama serve`;
      case "lmstudio":
        return `Cannot connect to LM Studio at ${this.provider.baseUrl}. Make sure LM Studio server is running.`;
      case "vllm":
        return `Cannot connect to vLLM at ${this.provider.baseUrl}. Make sure vLLM server is running.`;
      default:
        return `Cannot connect to ${this.provider.name} at ${this.provider.baseUrl}. Make sure the server is running.`;
    }
  }

  private getModelPullHint(): string {
    switch (this.provider.name) {
      case "ollama":
        return `Pull it with: ollama pull ${this.modelName}`;
      default:
        return "Make sure the model is available on the server.";
    }
  }

  async shutdown(): Promise<void> {}
}
