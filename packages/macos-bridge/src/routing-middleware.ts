/**
 * Routing Middleware
 *
 * Intercepts /v1/messages requests and applies model mappings based on User-Agent detection.
 * Handles both streaming and non-streaming responses.
 */

// Import from CLI package's internal modules (same monorepo)
import { ProviderHandler } from "../../cli/src/handlers/provider-handler.js";
import { OpenRouterTransport } from "../../cli/src/providers/transport/openrouter.js";
import { OpenRouterAdapter } from "../../cli/src/adapters/openrouter-adapter.js";
import {
  parseModelSpec,
} from "../../cli/src/providers/model-parser.js";
import {
  getProviderByName,
  getApiKeyInfo,
} from "../../cli/src/providers/provider-definitions.js";
import { selectProviderComponents } from "../../cli/src/providers/provider-components.js";
import type { Context, Next } from "hono";
import type { ConfigManager } from "./config-manager.js";
import { detectFromHeaders } from "./detection.js";
import type { ApiKeys, DetectedApp, LogEntry } from "./types.js";

/**
 * Context for a routed request
 */
export interface RoutingContext {
  detectedApp: string;
  confidence: number;
  originalModel: string;
  targetModel: string;
  requestId: string;
}

/**
 * Handler interface for type safety
 */
interface Handler {
  handle(c: Context, payload: unknown): Promise<Response>;
  shutdown(): Promise<void>;
}

/**
 * Routing middleware for model mapping
 */
export class RoutingMiddleware {
  private handlers = new Map<string, Handler>();
  private logBuffer: LogEntry[] = [];
  private detectedApps = new Map<string, DetectedApp>();
  private bridgePort: number;

  constructor(
    private configManager: ConfigManager,
    private apiKeys: ApiKeys,
    bridgePort = 0
  ) {
    this.bridgePort = bridgePort;
  }

  /**
   * Create handler for a model ID using ProviderHandler + Transport + Adapter.
   * Uses parseModelSpec to resolve the provider, then the transport factory.
   */
  private createHandlerForModel(model: string): Handler {
    const parsed = parseModelSpec(model);
    const def = getProviderByName(parsed.provider);

    // Use transport factory for all known providers (remote + local)
    if (def) {
      const apiKey = this.resolveApiKey(def.name);
      const components = selectProviderComponents(def, parsed.model, apiKey);
      if (components) {
        return new ProviderHandler(model, parsed.model, this.bridgePort, false, components, {
          tokenStrategy: def.tokenStrategy,
        }) as unknown as Handler;
      }
    }

    // Default: OpenRouter for everything else
    const apiKey = this.apiKeys.openrouter;
    if (!apiKey) throw new Error(`OpenRouter API key required for model: ${model}`);
    const orProvider = new OpenRouterTransport(apiKey);
    const orAdapter = new OpenRouterAdapter(model);
    return new ProviderHandler(orProvider, model, model, this.bridgePort, { formatAdapter: orAdapter }) as unknown as Handler;
  }

  /**
   * Resolve API key for a provider using the bridge's apiKeys map and env vars.
   */
  private resolveApiKey(providerName: string): string {
    // Check bridge's configured API keys first
    const keyMap: Record<string, string | undefined> = {
      google: this.apiKeys.gemini,
      openai: this.apiKeys.openai,
      minimax: this.apiKeys.minimax || process.env.MINIMAX_API_KEY,
      "minimax-coding": this.apiKeys.minimax || process.env.MINIMAX_CODING_API_KEY,
      kimi: this.apiKeys.kimi || process.env.MOONSHOT_API_KEY,
      "kimi-coding": process.env.KIMI_CODING_API_KEY,
      glm: this.apiKeys.glm || process.env.ZHIPU_API_KEY,
      "glm-coding": process.env.GLM_CODING_API_KEY,
      zai: process.env.ZAI_API_KEY,
      openrouter: this.apiKeys.openrouter,
    };
    if (keyMap[providerName]) return keyMap[providerName]!;

    // Fall back to the provider's configured env var
    const info = getApiKeyInfo(providerName);
    if (info?.envVar) {
      const envKey = process.env[info.envVar];
      if (envKey) return envKey;
    }

    // Local providers don't need keys
    return "";
  }

  /**
   * Get or create handler for a model (with caching)
   */
  private getHandlerForModel(model: string): Handler {
    if (this.handlers.has(model)) {
      return this.handlers.get(model)!;
    }

    const handler = this.createHandlerForModel(model);
    this.handlers.set(model, handler);
    return handler;
  }

  /**
   * Resolve target model based on app and original model
   */
  private resolveTargetModel(appName: string, requestedModel: string): string {
    // First check if proxy is enabled
    if (!this.configManager.isEnabled()) {
      return requestedModel;
    }

    // Check for app-specific mapping
    const mappedModel = this.configManager.getModelMapping(appName, requestedModel);
    if (mappedModel) {
      return mappedModel;
    }

    // Check for default model
    const config = this.configManager.getConfig();
    if (config.defaultModel) {
      return config.defaultModel;
    }

    // No mapping, use original
    return requestedModel;
  }

  /**
   * Update detected apps registry
   */
  private updateDetectedApp(name: string, confidence: number, userAgent: string): void {
    const existing = this.detectedApps.get(name);
    if (existing) {
      existing.requestCount++;
      existing.lastSeen = new Date().toISOString();
      if (confidence > existing.confidence) {
        existing.confidence = confidence;
      }
    } else {
      this.detectedApps.set(name, {
        name,
        confidence,
        userAgent,
        lastSeen: new Date().toISOString(),
        requestCount: 1,
      });
    }
  }

  /**
   * Compute estimated cost based on model and token usage
   */
  private computeCost(model: string, inputTokens: number, outputTokens: number): number {
    // Simplified pricing (per 1K tokens)
    // Real implementation would use provider pricing tables
    if (model.includes("gpt-4o")) {
      return (inputTokens * 0.0025 + outputTokens * 0.01) / 1000;
    }
    if (model.includes("gpt-4o-mini")) {
      return (inputTokens * 0.00015 + outputTokens * 0.0006) / 1000;
    }
    if (model.includes("gemini")) {
      return (inputTokens * 0.000125 + outputTokens * 0.000375) / 1000;
    }
    if (model.includes("opus")) {
      return (inputTokens * 0.015 + outputTokens * 0.075) / 1000;
    }
    if (model.includes("sonnet")) {
      return (inputTokens * 0.003 + outputTokens * 0.015) / 1000;
    }
    if (model.includes("haiku")) {
      return (inputTokens * 0.00025 + outputTokens * 0.00125) / 1000;
    }
    // Local models have no cost
    if (model.includes("ollama") || model.includes("lmstudio")) {
      return 0;
    }
    // Default to a reasonable estimate
    return (inputTokens * 0.001 + outputTokens * 0.002) / 1000;
  }

  /**
   * Log a completed request
   */
  private logRequest(
    ctx: RoutingContext,
    status: number,
    latency: number,
    inputTokens = 0,
    outputTokens = 0
  ): void {
    const cost = this.computeCost(ctx.targetModel, inputTokens, outputTokens);

    const logEntry: LogEntry = {
      timestamp: new Date().toISOString(),
      app: ctx.detectedApp,
      confidence: ctx.confidence,
      requestedModel: ctx.originalModel,
      targetModel: ctx.targetModel,
      status,
      latency,
      inputTokens,
      outputTokens,
      cost,
    };

    this.logBuffer.push(logEntry);

    // Keep only last 1000 entries in memory
    if (this.logBuffer.length > 1000) {
      this.logBuffer.shift();
    }
  }

  /**
   * Parse token usage from response body
   */
  private parseTokenUsage(data: unknown): { inputTokens: number; outputTokens: number } {
    if (!data || typeof data !== "object") {
      return { inputTokens: 0, outputTokens: 0 };
    }

    const usage = (data as Record<string, unknown>).usage as Record<string, unknown> | undefined;
    if (!usage) {
      return { inputTokens: 0, outputTokens: 0 };
    }

    return {
      inputTokens: (usage.input_tokens as number) || (usage.prompt_tokens as number) || 0,
      outputTokens: (usage.output_tokens as number) || (usage.completion_tokens as number) || 0,
    };
  }

  /**
   * Handle streaming response
   */
  private async handleStreamingResponse(
    c: Context,
    handler: Handler,
    payload: unknown,
    ctx: RoutingContext,
    startTime: number
  ): Promise<Response> {
    const response = await handler.handle(c, payload);

    if (!response.body) {
      const latency = Date.now() - startTime;
      this.logRequest(ctx, response.status, latency);
      return response;
    }

    // Create a pass-through stream that also tracks tokens
    let inputTokens = 0;
    let outputTokens = 0;

    const transformStream = new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        // Pass through the chunk
        controller.enqueue(chunk);

        // Try to parse for token usage (appears in final chunks)
        const text = new TextDecoder().decode(chunk);
        const lines = text.split("\n");

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.substring(6);
            if (data === "[DONE]") continue;

            try {
              const json = JSON.parse(data) as Record<string, unknown>;
              const usage = this.parseTokenUsage(json);
              if (usage.inputTokens > 0) inputTokens = usage.inputTokens;
              if (usage.outputTokens > 0) outputTokens = usage.outputTokens;
            } catch {
              // Skip invalid JSON
            }
          }
        }
      },
      flush: () => {
        // Log when stream completes
        const latency = Date.now() - startTime;
        this.logRequest(ctx, response.status, latency, inputTokens, outputTokens);
      },
    });

    const newBody = response.body.pipeThrough(transformStream);

    return new Response(newBody, {
      status: response.status,
      headers: response.headers,
    });
  }

  /**
   * Hono middleware that intercepts /v1/messages requests
   */
  handle() {
    return async (c: Context, next: Next) => {
      const path = c.req.path;

      // Only intercept proxy requests
      if (!path.startsWith("/v1/messages")) {
        return next();
      }

      const startTime = Date.now();
      const requestId = crypto.randomUUID();

      try {
        // 1. Parse request payload
        const payload = (await c.req.json()) as Record<string, unknown>;
        const requestedModel = (payload.model as string) || "unknown";
        const isStreaming = payload.stream === true;

        // 2. Detect application from headers (User-Agent, Origin, Host)
        const userAgent = c.req.header("user-agent") || "";
        const origin = c.req.header("origin") || "";
        const host = c.req.header("host") || "";
        const detection = detectFromHeaders({ userAgent, origin, host });

        // 3. Update detected apps registry
        this.updateDetectedApp(detection.name, detection.confidence, userAgent);

        // 4. Apply model mapping
        const targetModel = this.resolveTargetModel(detection.name, requestedModel);

        // 5. Get or create handler for target model
        const handler = this.getHandlerForModel(targetModel);

        // 6. Update payload with target model
        const modifiedPayload = { ...payload, model: targetModel };

        // 7. Create routing context for logging
        const ctx: RoutingContext = {
          detectedApp: detection.name,
          confidence: detection.confidence,
          originalModel: requestedModel,
          targetModel,
          requestId,
        };

        // 8. Log routing decision
        console.error(
          `[routing] ${detection.name} (${(detection.confidence * 100).toFixed(0)}%): ${requestedModel} → ${targetModel}`
        );

        // 9. Forward to handler
        if (isStreaming) {
          return this.handleStreamingResponse(c, handler, modifiedPayload, ctx, startTime);
        }
        const response = await handler.handle(c, modifiedPayload);
        const latency = Date.now() - startTime;

        // Parse response for token usage
        try {
          const cloned = response.clone();
          const data = await cloned.json();
          const usage = this.parseTokenUsage(data);
          this.logRequest(ctx, response.status, latency, usage.inputTokens, usage.outputTokens);
        } catch {
          this.logRequest(ctx, response.status, latency);
        }

        return response;
      } catch (error) {
        const latency = Date.now() - startTime;
        console.error("[routing] Error:", error);

        // Log error
        this.logBuffer.push({
          timestamp: new Date().toISOString(),
          app: "Unknown",
          confidence: 0,
          requestedModel: "unknown",
          targetModel: "unknown",
          status: 500,
          latency,
          inputTokens: 0,
          outputTokens: 0,
          cost: 0,
        });

        return c.json(
          {
            error: "Internal proxy error",
            details: error instanceof Error ? error.message : String(error),
          },
          500
        );
      }
    };
  }

  /**
   * Get log entries
   */
  getLogs(): LogEntry[] {
    return this.logBuffer;
  }

  /**
   * Get detected apps
   */
  getDetectedApps(): DetectedApp[] {
    return Array.from(this.detectedApps.values());
  }

  /**
   * Clear logs
   */
  clearLogs(): void {
    this.logBuffer = [];
  }

  /**
   * Shutdown all handlers
   */
  async shutdown(): Promise<void> {
    for (const handler of this.handlers.values()) {
      await handler.shutdown();
    }
    this.handlers.clear();
  }
}
