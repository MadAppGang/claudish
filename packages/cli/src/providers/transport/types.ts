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
  | "ollama-jsonl"
  /**
   * Connect-protocol envelopes carrying protobuf (Devin). The ONLY non-text
   * wire in the pipeline — see `serializeBody` below, and note that this
   * backend reports errors INSIDE an HTTP 200 body.
   */
  | "connect-proto";

/**
 * Body bytes a transport may hand to `fetch`.
 *
 * Deliberately NOT the DOM's `BodyInit`: the macOS bridge typechecks these same
 * sources with `lib: ["ES2023"]` and no DOM, where that name does not exist
 * (TS2304). This union covers every shape a serializer realistically produces —
 * a JSON string, or encoded bytes — and is assignable to `fetch`'s body under
 * both configurations. `Uint8Array<ArrayBuffer>` rather than plain
 * `Uint8Array`: the default parameter is `ArrayBufferLike`, which could be
 * `SharedArrayBuffer`-backed and is rejected as a request body.
 */
export type SerializedBody = string | Uint8Array<ArrayBuffer>;

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
   * Serialize the request payload to wire bytes.
   *
   * DEFAULT-PRESERVING BY CONSTRUCTION: not implementing this (or returning
   * undefined) leaves the pipeline on `JSON.stringify(payload)` +
   * `Content-Type: application/json`, byte for byte. ComposedHandler computes
   * `provider.serializeBody?.(payload)` once and applies
   * `serialized?.body ?? JSON.stringify(payload)` /
   * `serialized?.contentType ?? "application/json"` at BOTH fetch call sites
   * (the main request and the 401-retry twin), so a transport that leaves this
   * undefined executes the identical instruction sequence it always did.
   *
   * It lives here rather than on the Layer 1 FormatConverter because the one
   * implementer (Devin) embeds its credential in the encoded body, and
   * credentials are categorically the transport's business — the same reason
   * `transformPayload` (the CodeAssist envelope, which injects the project id)
   * is a transport hook.
   *
   * Called after `transformPayload`, so it sees the final payload.
   */
  serializeBody?(payload: any): { body: SerializedBody; contentType: string };

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

  /**
   * Discover a probe-friendly model by asking the endpoint itself.
   *
   * For self-hosted or user-deployed providers (LiteLLM, Ollama, LM Studio,
   * vLLM, MLX, OllamaCloud) the cloud catalog at /probeModels can't know
   * what's available — each deployment has its own model list. These
   * transports query the endpoint's `GET /v1/models` (or `/api/tags`) and
   * pick the smallest/cheapest model for a 1-token probe.
   *
   * Returns `{ model, reason? }`. When model is null, `reason` carries a
   * human-actionable diagnostic (e.g. "server not running at http://...",
   * "endpoint reachable but /v1/models is empty"). The TUI surfaces this
   * to the user so they know whether to start the server, load a model,
   * or check config.
   *
   * Called only when the cloud catalog has no entry for this provider, so
   * implementations don't need to gate on whether the catalog has data.
   *
   * @param exclude  Models already tried in this probe round. Discovery
   *                 returns the next-best candidate not in this set, so
   *                 the probe loop can fall through transient model errors
   *                 (e.g. LM Studio "model loading error" for a not-loaded
   *                 model — the next candidate might be already loaded).
   */
  discoverProbeModel?(exclude?: ReadonlySet<string>): Promise<{
    model: string | null;
    reason?: string;
  }>;
}
