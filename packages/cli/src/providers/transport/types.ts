/**
 * ProviderTransport — how to talk to a model API.
 *
 * Owns: auth, endpoint URL, HTTP headers, SSE format, rate limiting, error handling.
 * Does NOT own: message conversion, tool format, pricing (those are ModelAdapter concerns).
 */

import type { RequestAuth } from "../../auth/credentials/types.js";

/**
 * The auth ONE request signs with, held in a request-local by ComposedHandler.
 *
 * A transport that mints a per-request artifact (`openai-codex`) returns it from
 * `refreshAuth`/`forceRefreshAuth`, and ComposedHandler hands it back to
 * `transformPayload`, `getEndpoint` and `getHeaders`. Every auth-dependent value
 * of the request is then computed from this one artifact, never from a field on
 * the transport instance, which concurrent requests on one handler share (one
 * request's refresh could otherwise change what another request signs with).
 *
 * `auth === null` ⇒ the transport's base (api-key) path.
 */
export interface AuthBinding {
  readonly auth: RequestAuth | null;
}

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

  /**
   * Get the full API endpoint URL for a request.
   *
   * `binding` is the request's auth binding (from `refreshAuth`); a transport
   * that returns one reads auth from it ONLY. Optional, so transports that bind
   * nothing ignore it.
   */
  getEndpoint(model?: string, binding?: AuthBinding): string;

  /**
   * Get HTTP headers (may be async for OAuth token refresh).
   *
   * `claudeRequest` is the ORIGINAL inbound Claude-format body, for a header that
   * carries conversation identity (OpenCode Zen's `x-opencode-session`). Besides
   * `transformPayload`, this is the only hook that can see that identity, and the
   * value must be derived from the argument on every call — never stashed on the
   * instance in `transformPayload` and read back here, because one transport
   * serves overlapping requests from different conversations (the same race as
   * `classifyTerminalError` below). Optional, so existing implementers that
   * ignore it are untouched.
   *
   * `binding`: the request's auth binding, as for `getEndpoint`.
   */
  getHeaders(claudeRequest?: unknown, binding?: AuthBinding): Promise<Record<string, string>>;

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
   * `opts.signal` is OPTIONAL, and so is honouring it — the implementations
   * that ignore the second argument keep compiling and behaving identically.
   * It exists because a retry attempt is bounded by a per-attempt clamp, and a
   * clamp that reaches the `fetch` but not the queue admission in front of it
   * bounds the wrong thing: the caller's wall clock then includes a wait
   * governed by whatever the ACTIVE request's own timeout is. On the local
   * queue that number is ten minutes.
   */
  enqueueRequest?(
    fetchFn: () => Promise<Response>,
    opts?: { signal?: AbortSignal }
  ): Promise<Response>;

  /**
   * Optional auth refresh (e.g., OAuth token rotation).
   * Called once before each request if defined.
   *
   * A transport that returns an `AuthBinding` binds the request to that
   * artifact: ComposedHandler passes it to every later auth-dependent call of
   * the same request. `void` ⇒ a legacy transport with nothing to bind.
   */
  // biome-ignore lint/suspicious/noConfusingVoidType: legacy transports return Promise<void>, which `undefined` would reject
  refreshAuth?(): Promise<AuthBinding | void>;

  /**
   * Force refresh auth credentials after a 401 response.
   * Used by OAuth providers (Vertex, CodeAssist) to handle token expiry.
   * ComposedHandler calls this automatically on 401 and retries the request.
   * A returned binding REPLACES the request's binding for the retry.
   *
   * `ctx.rejectedHeaders` are the headers of the request the upstream just
   * rejected, so a transport holding several credentials can tell a stale
   * failure (its credential already changed) from one that names the
   * credential it holds now.
   */
  forceRefreshAuth?(
    ctx?: { rejectedHeaders?: Record<string, string> }
    // biome-ignore lint/suspicious/noConfusingVoidType: legacy transports return Promise<void>, which `undefined` would reject
  ): Promise<AuthBinding | void>;

  /**
   * Optional: a display-safe name of the credential that signed a request
   * (`RequestAuth.signer`), for a provider with several login sources, looked
   * up from the headers THAT request was sent with — never from the
   * transport's current state, which a concurrent request may have rotated.
   * ComposedHandler returns it on the response as `x-claudish-signed-with`
   * (URI-encoded), which `--probe` reads per request.
   */
  signingCredential?(sentHeaders: Record<string, string>): string | undefined;

  /**
   * Optional per-provider verdict on whether an error response is TERMINAL
   * (won't recover on retry) — the transport's own reading of its provider's
   * error dialect.
   *
   * `true` / `false` are authoritative and override the shared substring
   * heuristics in `isTerminal429` / `getRecoveryHint`; `undefined` means "no
   * opinion, use the generic rules", which is also what every transport that
   * omits this hook gets.
   *
   * It exists because a substring heuristic cannot read a structured error.
   * Google answers EVERY `RESOURCE_EXHAUSTED` — including a plain per-minute
   * rate limit — with the boilerplate "Resource has been exhausted (e.g. check
   * quota).", and the shared exhaustion-wording list matches on the bare word
   * "quota". So a transient throttle was surfaced to the user as "Out of quota
   * — check your plan & billing details. This won't recover on retry.", a
   * confident false statement in two directions, while the SAME transport had
   * already parsed `google.rpc.ErrorInfo.reason: RATE_LIMIT_EXCEEDED` and
   * correctly called it retryable. The layer that understands the dialect gets
   * the final say.
   *
   * MUST be a pure function of (status, bodyText) — the handler calls it on a
   * body it already holds, and a handler instance can serve overlapping
   * requests, so per-request state on the transport would race.
   */
  classifyTerminalError?(status: number, bodyText: string): boolean | undefined;

  /**
   * Optional payload transformation before sending.
   * Used by providers that wrap the payload in an envelope (e.g., CodeAssist).
   * Called after adapter.buildPayload() + adapter.prepareRequest().
   *
   * `claudeRequest` is the ORIGINAL inbound Claude-format body, passed because
   * buildPayload is lossy in exactly the direction a transport sometimes needs:
   * the Responses adapter lifts `system` into `instructions` and drops
   * `metadata`, so conversation identity (`metadata.user_id`) is unreachable
   * from `payload` alone. Optional and second, so the existing implementers
   * that ignore it are untouched.
   *
   * `binding`: the request's auth binding, as for `getEndpoint`.
   */
  transformPayload?(payload: any, claudeRequest?: any, binding?: AuthBinding): any;

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
   * Optional: credential values this transport sends OUTSIDE the headers that
   * `getHeaders()` returns, for exact-value redaction (`redact.ts`). Devin
   * encodes its key into the request body; Antigravity's capacity fallback
   * signs its own fetches. ComposedHandler registers what this returns for
   * the request's lifetime, so an upstream error echoing the value is masked
   * in every log sink and in the error text returned to Claude Code.
   *
   * Values only, read at call time; never logged. A transport whose every
   * credential travels in `getHeaders()` leaves this undefined.
   */
  redactionSecrets?(): string[];

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
