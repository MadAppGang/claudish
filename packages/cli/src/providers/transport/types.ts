/**
 * ProviderTransport — how to talk to a model API.
 *
 * Owns: auth, endpoint URL, HTTP headers, SSE format, rate limiting, error handling.
 * Does NOT own: message conversion, tool format, pricing (those are ModelAdapter concerns).
 */

/** The wire format used for streaming responses */
export type StreamFormat =
  | "openai-sse"
  | "openai-responses-sse"
  | "gemini-sse"
  | "anthropic-sse"
  | "ollama-jsonl";

/**
 * A transport layer for a model API provider.
 *
 * Implementations are lightweight — they contain only the information
 * needed to make HTTP requests to the provider's API. All model-specific
 * transforms (messages, tools, payload shape) live in ModelAdapter.
 */
export interface ProviderTransport {
  /** Internal provider identifier (e.g., "openai", "gemini", "litellm") */
  readonly name: string;

  /** Human-readable name for display (e.g., "OpenAI", "Google Gemini") */
  readonly displayName: string;

  /** Which stream parser to use for this provider's responses */
  readonly streamFormat: StreamFormat;

  /** Get the full API endpoint URL for a request */
  getEndpoint(model?: string): string;

  /** Get HTTP headers (may be async for OAuth token refresh) */
  getHeaders(): Promise<Record<string, string>>;

  /**
   * Override the adapter's stream format selection.
   * Only needed for aggregator providers (OpenRouter, LiteLLM) that normalize
   * response formats server-side, regardless of the underlying model.
   * If undefined, the adapter's getStreamFormat() is used.
   */
  overrideStreamFormat?(): StreamFormat | undefined;

  /**
   * Extra fields to merge into the request payload.
   * Used for provider-specific keys like `extra_headers` (LiteLLM),
   * `provider` overrides (OpenRouter), etc.
   */
  getExtraPayloadFields?(): Record<string, any>;

  /**
   * Optional request queue for rate limiting / concurrency control.
   * If provided, the ComposedHandler will call this instead of raw fetch.
   */
  enqueueRequest?(fetchFn: () => Promise<Response>): Promise<Response>;

  /**
   * Optional auth refresh (e.g., OAuth token rotation).
   * Called once before each request if defined.
   */
  refreshAuth?(): Promise<void>;

  /**
   * Force refresh auth credentials after a 401 response.
   * Used by OAuth providers (Vertex, CodeAssist) to handle token expiry.
   * ComposedHandler calls this automatically on 401 and retries the request.
   */
  forceRefreshAuth?(): Promise<void>;

  /**
   * Optional payload transformation before sending.
   * Used by providers that wrap the payload in an envelope (e.g., CodeAssist).
   * Called after adapter.buildPayload() + adapter.prepareRequest().
   */
  transformPayload?(payload: any): any;

  /**
   * Extra options to merge into the fetch RequestInit.
   * Used for custom agents (e.g., undici dispatcher with long timeouts for local models).
   * Called once per request — may return per-request values like AbortSignal.
   */
  getRequestInit?(): Record<string, any>;

  /**
   * Dynamic context window discovered at runtime (e.g., from local model API).
   * ComposedHandler calls this after refreshAuth to update TokenTracker.
   */
  getContextWindow?(): number;

  /**
   * Active model name after fallback (e.g., capacity exhaustion triggered a model switch).
   * If set, the composed handler writes this to the token file so the status line
   * shows the actual model being used, not the originally requested one.
   */
  getActiveModelName?(): string | undefined;

  /**
   * Get quota remaining fraction (0-1) for a specific model.
   * Used by Code Assist to surface per-model quota in the status bar.
   */
  getQuotaRemaining?(modelName: string): Promise<number | undefined>;

  /**
   * Optional cleanup on shutdown.
   */
  shutdown?(): Promise<void>;
}
