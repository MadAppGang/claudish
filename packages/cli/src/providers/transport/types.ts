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
 * Exact prompt size from the provider's OWN tokenizer (#674).
 *
 * `exact` is what the engine itself will count for this prompt, chat template
 * included — the only number allowed to decide admission inside the uncertain
 * band (the `/4` estimate spans ×0.57–×3.18 of the real count across the served
 * corpus, so it may only nominate).
 */
export interface ExactPromptCount {
  exact: number;
  /**
   * The engine's own declared window, when the tokenizer endpoint reports it
   * (vLLM's `/tokenize` answers `max_model_len`). Advisory for now: it is
   * logged, never written into the learned-cap store.
   */
  maxModelLen?: number;
}

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

  /**
   * #686 — this endpoint opted into client attribution. When true, the
   * handler merges `x-claudish-client: <machine>:<workspace>` (plus the
   * client's `x-claudish-machine` verbatim) into the outbound headers.
   * Undefined on every transport that did not opt in — nothing is sent.
   */
  readonly clientAttribution?: boolean;

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
   *
   * `opts.busyWaitMs` (#431): bound on the concurrency-slot wait for a CASCADE
   * STEP attempt — on expiry the call rejects with StepBusyError so the
   * cascade can skip forward. Undefined (nominal, walk, non-cascade callers)
   * keeps the unbounded FIFO of today.
   */
  enqueueRequest?(fetchFn: () => Promise<Response>, opts?: { busyWaitMs?: number }): Promise<Response>;

  /**
   * Optional exact prompt count from the provider's own tokenizer (#674).
   *
   * vLLM: `POST {root}/tokenize` with `{model, messages}` — the chat template
   * is applied server-side, so this counts what the engine will actually admit
   * against, not a re-rendering we guessed at. Only implemented where a
   * tokenizer endpoint is known to exist; absent everywhere else, which is what
   * keeps #674 inert on every other wire.
   *
   * Contract: NEVER throws and NEVER hangs the turn — a missing route, a
   * timeout, an unreadable body or a non-numeric `count` all resolve to `null`,
   * and `null` must be indistinguishable from this method being absent.
   */
  countPromptTokens?(messages: any[]): Promise<ExactPromptCount | null>;

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
