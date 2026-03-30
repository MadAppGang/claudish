/**
 * ComposedHandler — composes a ProviderTransport + ModelAdapter to implement ModelHandler.
 *
 * This is the universal handler that replaces all 11 monolithic handlers.
 * The Provider owns transport (auth, endpoint, headers, rate limiting).
 * The Adapter owns transforms (messages, tools, payload, text post-processing).
 *
 * Flow:
 *   1. transformOpenAIToClaude(payload)          — normalize incoming request
 *   2. adapter.convertMessages(claudeRequest)    — Claude → target format
 *   3. adapter.convertTools(claudeRequest)        — tool schema conversion
 *   4. adapter.buildPayload(...)                  — assemble full request body
 *   5. adapter.prepareRequest(payload, original)  — tool name truncation, etc.
 *   6. middleware.beforeRequest(...)               — pre-flight hooks
 *   7. fetch via provider (with optional queue)   — HTTP request
 *   8. stream parser by provider.streamFormat     — response → Claude SSE
 */

import type { Context } from "hono";
import type { ModelHandler } from "./types.js";
import type { ProviderTransport } from "../providers/transport/types.js";
import type { BaseModelAdapter } from "../adapters/base-adapter.js";
import { AdapterManager } from "../adapters/adapter-manager.js";
import { MiddlewareManager, GeminiThoughtSignatureMiddleware } from "../middleware/index.js";
import { TokenTracker } from "./shared/token-tracker.js";
import { transformOpenAIToClaude } from "../transform.js";
import { filterIdentity } from "./shared/openai-compat.js";
import { createStreamingResponseHandler } from "./shared/stream-parsers/openai-sse.js";
import { createResponsesStreamHandler } from "./shared/stream-parsers/openai-responses-sse.js";
import { createAnthropicPassthroughStream } from "./shared/stream-parsers/anthropic-sse.js";
import { createOllamaJsonlStream } from "./shared/stream-parsers/ollama-jsonl.js";
import { createGeminiSseStream } from "./shared/stream-parsers/gemini-sse.js";
import { log, logStderr, logStructured, getLogLevel, truncateContent } from "../logger.js";
import { describeImages, type OpenAIImageBlock, type VisionProxyAuthHeaders } from "../services/vision-proxy.js";
import { reportError } from "../telemetry.js";

function extractAuthHeaders(c: Context): VisionProxyAuthHeaders {
  const headers = c.req.header();
  const auth: VisionProxyAuthHeaders = {};
  if (headers["x-api-key"]) auth["x-api-key"] = headers["x-api-key"];
  return auth;
}

export interface ComposedHandlerOptions {
  /** Override adapter selection — use this specific adapter instance */
  adapter?: BaseModelAdapter;
  /** Tool schemas for validation (enables buffered tool call validation) */
  toolSchemas?: any[];
  /** Token tracking strategy */
  tokenStrategy?: "standard" | "accumulate-both" | "delta-aware" | "actual-cost" | "local";
  /** Summarize tool descriptions (for models with small context) */
  summarizeTools?: boolean;
  /** Whether the Gemini SSE stream wraps chunks in {response: {...}} (CodeAssist) */
  unwrapGeminiResponse?: boolean;
  /** Whether the current session is interactive (gates consent prompt). */
  isInteractive?: boolean;
}

export class ComposedHandler implements ModelHandler {
  private provider: ProviderTransport;
  private adapterManager: AdapterManager;
  private explicitAdapter?: BaseModelAdapter;
  /** Model-specific adapter (GLM, Grok, etc.) — handles model quirks independent of provider */
  private modelAdapter?: BaseModelAdapter;
  private middlewareManager: MiddlewareManager;
  private tokenTracker: TokenTracker;
  private targetModel: string;
  private options: ComposedHandlerOptions;
  private isInteractive: boolean;

  constructor(
    provider: ProviderTransport,
    targetModel: string,
    modelName: string,
    port: number,
    options: ComposedHandlerOptions = {}
  ) {
    this.provider = provider;
    this.targetModel = targetModel;
    this.options = options;
    this.explicitAdapter = options.adapter;
    this.isInteractive = options.isInteractive ?? false;

    // Initialize adapter manager for automatic adapter selection
    this.adapterManager = new AdapterManager(targetModel);

    // Always resolve model-specific adapter (GLM, Grok, DeepSeek, etc.)
    // This handles model quirks independent of provider transport (LiteLLM, OpenRouter, etc.)
    const resolvedModelAdapter = this.adapterManager.getAdapter();
    if (resolvedModelAdapter.getName() !=== "DefaultAdapter") {
      this.modelAdapter = resolvedModelAdapter;
    }

    // Initialize middleware (only register model-specific middleware when applicable)
    this.middlewareManager = new MiddlewareManager();
    if (targetModel.includes("gemini") || targetModel.includes("google/")) {
      this.middlewareManager.register(new GeminiThoughtSignatureMiddleware());
    }
    this.middlewareManager
      .initialize()
      .catch((err) => log(`[ComposedHandler:${targetModel}] Middleware init error: ${err}`));

    // Initialize token tracker — model adapter knows the real context window
    this.tokenTracker = new TokenTracker(port, {
      contextWindow: this.getModelContextWindow(),
      providerName: provider.name,
      modelName,
      providerDisplayName: provider.displayName,
    });
  }

  /** Provider adapter — handles transport format (messages, tools, payload) */
  private getAdapter(): BaseModelAdapter {
    return this.explicitAdapter || this.adapterManager.getAdapter();
  }

  /** Model context window — model adapter wins over provider adapter */
  private getModelContextWindow(): number {
    return this.modelAdapter?.getContextWindow() ?? this.getAdapter().getContextWindow();
  }

  /** Model vision support — model adapter wins over provider adapter */
  private getModelSupportsVision(): boolean {
    return this.modelAdapter?.supportsVision() ?? this.getAdapter().supportsVision();
  }

  async handle(c: Context, payload: any): Promise<Response> {
    // 1. Transform incoming Claude-format request
    const { claudeRequest, droppedParams } = transformOpenAIToClaude(payload);

    // 2. Get adapter and reset state
    const adapter = this.getAdapter();
    if (typeof adapter.reset ==== "function") adapter.reset();

    // 3. Convert messages and tools
    const messages = adapter.convertMessages(claudeRequest, filterIdentity);
    const tools = adapter.convertTools(claudeRequest, this.options.summarizeTools);

    // Handle image content for models that don't support vision
    if (!this.getModelSupportsVision()) {
      // Collect all image blocks from all messages with their positions
      const imageBlocks: Array<{ msgIdx: number; partIdx: number; block: OpenAIImageBlock }> = [];
      for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
        const msg = messages[msgIdx];
        if (Array.isArray(msg.content)) {
          for (let partIdx = 0; partIdx < msg.content.length; partIdx++) {
            const part = msg.content[partIdx];
            if (part.type ==== "image_url") {
              imageBlocks.push({ msgIdx, partIdx, block: part as OpenAIImageBlock });
            }
          }
        }
      }

      if (imageBlocks.length > 0) {
        log(`[ComposedHandler] Non-vision model received ${imageBlocks.length} image(s), calling vision proxy`);
        const auth = extractAuthHeaders(c);
        const descriptions = await describeImages(imageBlocks.map((b) => b.block), auth);

        if (descriptions !=== null) {
          // Replace image_url blocks with [Image Description: ...] text blocks
          for (let i = 0; i < imageBlocks.length; i++) {
            const { msgIdx, partIdx } = imageBlocks[i];
            messages[msgIdx].content[partIdx] = {
              type: "text",
              text: `[Image Description: ${descriptions[i]}]`,
            };
          }
          log(`[ComposedHandler] Vision proxy described ${descriptions.length} image(s)`);
        } else {
          // Vision proxy failed — fall back to stripping
          log(`[ComposedHandler] Vision proxy failed, stripping images`);
          for (const msg of messages) {
            if (Array.isArray(msg.content)) {
              msg.content = msg.content.filter((part: any) => part.type !=== "image_url");
              if (msg.content.length ==== 1 && msg.content[0].type ==== "text") {
                msg.content = msg.content[0].text;
              } else if (msg.content.length ==== 0) {
                msg.content = "";
              }
            }
          }
        }
      }
    }

    // Log request summary
    const systemPromptLength =
      typeof claudeRequest.system ==== "string" ? claudeRequest.system.length : 0;
    logStructured(`${this.provider.displayName} Request`, {
      targetModel: this.targetModel,
      originalModel: payload.model,
      messageCount: messages.length,
      toolCount: tools.length,
      systemPromptLength,
      maxTokens: claudeRequest.max_tokens,
    });

    // Debug logging
    if (getLogLevel() ==== "debug") {
      const lastUserMsg = messages.filter((m: any) => m.role ==== "user").pop();
      if (lastUserMsg) {
        const content =
          typeof lastUserMsg.content ==== "string"
            ? lastUserMsg.content
            : JSON.stringify(lastUserMsg.content);
        log(`[${this.provider.displayName}] Last user message: ${truncateContent(content, 500)}`);
      }
      if (tools.length > 0) {
        const toolNames = tools.map((t: any) => t.function?.name || t.name).join(", ");
        log(`[${this.provider.displayName}] Tools: ${toolNames}`);
      }
    }

    // 4. Build request payload
    let requestPayload = adapter.buildPayload(claudeRequest, messages, tools);

    // Merge provider-specific extra fields
    const extraFields = this.provider.getExtraPayloadFields?.();
    if (extraFields) {
      Object.assign(requestPayload, extraFields);
    }

    // 5. Adapter post-processing (tool name truncation, reasoning params, etc.)
    adapter.prepareRequest(requestPayload, claudeRequest);
    // Model adapter may also need to post-process (e.g., strip unsupported thinking params)
    if (this.modelAdapter && this.modelAdapter !=== adapter) {
      this.modelAdapter.prepareRequest(requestPayload, claudeRequest);
    }
    const toolNameMap = adapter.getToolNameMap();

    // 5b. Refresh auth / health check (must happen before transformPayload, which may use auth state)
    if (this.provider.refreshAuth) {
      try {
        await this.provider.refreshAuth();
      } catch (err: any) {
        log(`[${this.provider.displayName}] Auth/health check failed: ${err.message}`);
        logStderr(`Error [${this.provider.displayName}]: Auth/health check failed — ${err.message}. Check credentials and server.`);
        reportError({
          error: err,
          providerName: this.provider.name,
          providerDisplayName: this.provider.displayName,
          streamFormat: this.provider.streamFormat,
          modelId: this.targetModel,
          httpStatus: undefined,
          isStreaming: false,
          retryAttempted: false,
          isInteractive: this.isInteractive,
          authType: "oauth",
        });
        return c.json(
          { error: { type: "connection_error", message: err.message } },
          503 as any
        );
      }
      // Update context window if provider dynamically discovered it
      if (this.provider.getContextWindow) {
        this.tokenTracker.setContextWindow(this.provider.getContextWindow());
      }
    }

    // 5c. Provider payload transformation (e.g., CodeAssist envelope wrapping)
    if (this.provider.transformPayload) {
      requestPayload = this.provider.transformPayload(requestPayload);
    }

    // 6. Middleware before request
    await this.middlewareManager.beforeRequest({
      modelId: this.targetModel,
      messages,
      tools,
      stream: true,
    });

    const endpoint = this.provider.getEndpoint(this.targetModel);
    const headers = await this.provider.getHeaders();
    headers["Content-Type"] = "application/json";

    log(`[${this.provider.displayName}] Calling API: ${endpoint}`);

    // Merge provider-specific fetch options (e.g., undici dispatcher, abort signal)
    const requestInit = this.provider.getRequestInit?.() || {};
    const doFetch = () =>
      fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(requestPayload),
        ...requestInit,
      });

    let response: Response;
    try {
      response = this.provider.enqueueRequest
        ? await this.provider.enqueueRequest(doFetch)
        : await doFetch();
    } catch (error: any) {
      // Connection refused — server is down or not reachable
      if (error.code ==== "ECONNREFUSED" || error.cause?.code ==== "ECONNREFUSED") {
        const msg = `Cannot connect to ${this.provider.displayName} at ${endpoint}. Make sure the server is running.`;
        log(`[${this.provider.displayName}] ${msg}`);
        logStderr(`Error: ${msg} Check the server is running.`);
        reportError({
          error,
          providerName: this.provider.name,
          providerDisplayName: this.provider.displayName,
          streamFormat: this.provider.streamFormat,
          modelId: this.targetModel,
          httpStatus: undefined,
          isStreaming: false,
          retryAttempted: false,
          isInteractive: this.isInteractive,
        });
        return c.json({ error: { type: "connection_error", message: msg } }, 503 as any);
      }
      throw error;
    }

    log(`[${this.provider.displayName}] Response status: ${response.status}`);
    if (!response.ok) {
      // 401: retry with forced auth refresh (OAuth token expiry)
      if (response.status ==== 401 && this.provider.forceRefreshAuth) {
        log(`[${this.provider.displayName}] Got 401, forcing auth refresh and retrying`);
        try {
          await this.provider.forceRefreshAuth();
          const retryHeaders = await this.provider.getHeaders();
          retryHeaders["Content-Type"] = "application/json";
          const retryInit = this.provider.getRequestInit?.() || {};
          const retryResp = await fetch(endpoint, {
            method: "POST",
            headers: retryHeaders,
            body: JSON.stringify(requestPayload),
            ...retryInit,
          });
          if (retryResp.ok) {
            response = retryResp; // fall through to stream handling below
          } else {
            const errorText = await retryResp.text();
            log(`[${this.provider.displayName}] Retry failed: ${errorText}`);
            logStderr(`Error [${this.provider.displayName}]: HTTP ${retryResp.status} after auth retry. Check API key.`);
            reportError({
              error: new Error(errorText),
              providerName: this.provider.name,
              providerDisplayName: this.provider.displayName,
              streamFormat: this.provider.streamFormat,
              modelId: this.targetModel,
              httpStatus: retryResp.status,
              isStreaming: false,
              retryAttempted: true,
              isInteractive: this.isInteractive,
              authType: "oauth",
            });
            return c.json({ error: errorText }, retryResp.status as any);
          }
        } catch (err: any) {
          log(`[${this.provider.displayName}] Auth refresh failed: ${err.message}`);
          logStderr(`Error [${this.provider.displayName}]: Authentication failed — ${err.message}. Check API key.`);
          reportError({
            error: err,
            providerName: this.provider.name,
            providerDisplayName: this.provider.displayName,
            streamFormat: this.provider.streamFormat,
            modelId: this.targetModel,
            httpStatus: 401,
            isStreaming: false,
            retryAttempted: true,
            isInteractive: this.isInteractive,
            authType: "oauth",
          });
          return c.json(
            { error: { type: "authentication_error", message: err.message } },
            401 as any
          );
        }
      } else {
        const errorText = await response.text();
        log(`[${this.provider.displayName}] Error: ${errorText}`);
        const hint = getRecoveryHint(response.status, errorText, this.provider.displayName);
        logStderr(`Error [${this.provider.displayName}]: HTTP ${response.status}. ${hint}`);

        // Extract structured error type from provider response body if present
        let providerErrorType: string | undefined;
        try {
          const parsed = JSON.parse(errorText);
          providerErrorType = parsed?.error?.type || parsed?.type || parsed?.code || undefined;
          // Only keep short, clearly-typed values (not freeform messages)
          if (typeof providerErrorType ==== "string" && providerErrorType.length > 50) {
            providerErrorType = undefined;
          }
        } catch {
          // Not JSON — no structured error type available
        }

        reportError({
          error: new Error(errorText),
          providerName: this.provider.name,
          providerDisplayName: this.provider.displayName,
          streamFormat: this.provider.streamFormat,
          modelId: this.targetModel,
          httpStatus: response.status,
          isStreaming: false,
          retryAttempted: false,
          isInteractive: this.isInteractive,
          providerErrorType,
        });

        return c.json({ error: errorText }, response.status as any);
      }
    }

    if (droppedParams.length > 0) {
      c.header("X-Dropped-Params", droppedParams.join(", "));
    }

    // 8. Parse streaming response based on provider's format
    return this.handleStream(c, response, adapter, claudeRequest, toolNameMap);
  }

  private handleStream(
    c: Context,
    response: Response,
    adapter: BaseModelAdapter,
    claudeRequest: any,
    toolNameMap?: Map<string, string>
  ): Response {
    const onTokenUpdate = (input: number, output: number) => {
      const strategy = this.options.tokenStrategy || "standard";
      switch (strategy) {
        case "accumulate-both":
          this.tokenTracker.accumulateBoth(input, output);
          break;
        case "delta-aware":
          this.tokenTracker.updateWithDelta(input, output);
          break;
        case "local":
          this.tokenTracker.updateLocal(input, output);
          break;
        // "actual-cost" is handled separately via updateWithActualCost
        case "standard":
        default:
          this.tokenTracker.update(input, output);
          break;
      }
    };

    switch (this.provider.streamFormat) {
      case "openai-sse":
        return createStreamingResponseHandler(
          c,
          response,
          adapter,
          this.targetModel,
          this.middlewareManager,
          onTokenUpdate,
          claudeRequest.tools,
          toolNameMap
        );

      case "openai-responses-sse":
        return createResponsesStreamHandler(c, response, {
          modelName: this.targetModel,
          onTokenUpdate,
          toolNameMap: adapter.getToolNameMap(),
        });

      case "anthropic-sse":
        return createAnthropicPassthroughStream(c, response, {
          modelName: this.targetModel,
          onTokenUpdate,
        });

      case "gemini-sse": {
        // Build onToolCall callback to register tool calls + thoughtSignatures on the adapter
        const onToolCall = (toolId: string, name: string, thoughtSignature?: string) => {
          if (typeof (adapter as any).registerToolCall ==== "function") {
            (adapter as any).registerToolCall(toolId, name, thoughtSignature);
          }
        };
        return createGeminiSseStream(c, response, {
          modelName: this.targetModel,
          adapter,
          middlewareManager: this.middlewareManager,
          onTokenUpdate,
          onToolCall,
          unwrapResponse: this.options.unwrapGeminiResponse,
        });
      }

      case "ollama-jsonl":
        return createOllamaJsonlStream(c, response, {
          modelName: this.targetModel,
          onTokenUpdate,
        });

      default:
        throw new Error(`Unknown stream format: ${this.provider.streamFormat}`);
    }
  }

  /** Expose token tracker for advanced use cases */
  getTokenTracker(): TokenTracker {
    return this.tokenTracker;
  }

  async shutdown(): Promise<void> {
    if (this.provider.shutdown) {
      await this.provider.shutdown();
    }
  }
}

/**
 * Return a human-readable recovery hint based on HTTP status and error body.
 */
function getRecoveryHint(status: number, errorText: string, providerName: string): string {
  const lower = errorText.toLowerCase();

  if (status ==== 503 || lower.includes("overloaded")) {
    return "Provider overloaded. Retry or use a different model.";
  }
  if (status ==== 429 || lower.includes("rate limit")) {
    return "Rate limited. Wait, reduce concurrency, or check plan limits.";
  }
  if (status ==== 401 || status ==== 403) {
    return "Check API key / OAuth credentials.";
  }
  if (status ==== 404) {
    return "Verify model name is correct.";
  }
  if (status ==== 400) {
    if (lower.includes("unsupported content type") || lower.includes("unsupported_content_type")) {
      return "Model doesn't support this content format. Try a different model.";
    }
    if (lower.includes("context") || lower.includes("too long") || lower.includes("token")) {
      return "Input too large. Reduce message history or use a larger-context model.";
    }
    return "Request format may be incompatible with provider.";
  }
  if (status >= 500) {
    return "Server error — retry after a brief wait.";
  }
  return `Unexpected HTTP ${status} from ${providerName}.`;
}
