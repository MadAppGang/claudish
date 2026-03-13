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
  | "gemini-codeassist-sse"
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
   * Extra fields to merge into the request payload.
   * Used for provider-specific keys like `extra_headers` (LiteLLM),
   * `provider` overrides (OpenRouter), etc.
   */
  getExtraPayloadFields?(): Record<string, any>;

  /**
   * Optional request queue for rate limiting / concurrency control.
   * If provided, the ProviderHandler will call this instead of raw fetch.
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
   * ProviderHandler calls this automatically on 401 and retries the request.
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
   * ProviderHandler calls this after refreshAuth to update TokenTracker.
   */
  getContextWindow?(): number;

  /**
   * Optional cleanup on shutdown.
   */
  shutdown?(): Promise<void>;
}
