/**
 * Config schemas for the LiteLLM-demotion refactor (Phase 1).
 *
 * Defines:
 *   - BuiltinDefaultProviderSchema — enum of provider names users can name as
 *     their default provider for bare model names.
 *   - CustomEndpointSimpleSchema    — "URL + format + key" custom endpoints.
 *   - CustomEndpointComplexSchema   — full provider profile (Phase 3 will register).
 *   - CustomEndpointSchema          — discriminated union of the two.
 *   - DefaultProviderSchema         — builtin enum OR custom-endpoint name string.
 *
 * NOTE: This module is intentionally NOT imported by `profile-config.ts`.
 * Validation happens at the consumption site (Phase 3 will add a
 * `loadCustomEndpoints()` helper that calls Zod and warns on invalid entries).
 * Keeping `profile-config.ts` Zod-free matters because `loadConfig` is called
 * from many lightweight code paths.
 */

import { z } from "zod";

// Built-in providers users can name as their default.
// "litellm" is preserved for legacy compat (Phase 2 will gate auto-promotion on this).
export const BuiltinDefaultProviderSchema = z.enum([
  "openrouter",
  "litellm",
  "openai",
  "anthropic",
  "google",
]);

// "Simple" custom endpoint: just URL + format + key.
// Reuses existing OpenAI/Anthropic format converters and a generic transport.
export const CustomEndpointSimpleSchema = z.object({
  kind: z.literal("simple"),
  url: z.url(),
  format: z.enum(["openai", "anthropic"]),
  apiKey: z.string().min(1),
  modelPrefix: z.string().optional(),
  models: z.array(z.string()).optional(),
  /**
   * Max concurrent in-flight requests to this endpoint (0 = unlimited, 1 =
   * sequential). Only meaningful for capacity-limited backends (e.g. a single
   * GPU vLLM server) where parallel large prefills cause engine wedging.
   * Wires the endpoint through LocalModelQueue — same mechanism as local
   * models' `:N` concurrency suffix. Omit for unbounded (default behavior).
   *
   * Cap raised 8 → 32 (fleet need): the FrogNano-4B vLLM endpoint passed its
   * N=16/32 gates and runs definitive maxConcurrency=16 — the old cap made
   * the whole entry FAIL validation and be skipped (measured 2026-10-07: the
   * endpoint silently left the routing table). The cap is a typo guard, not
   * a capacity statement; 32 keeps headroom over the measured fleet values.
   */
  maxConcurrency: z.number().int().min(0).max(32).optional(),
  /**
   * #431 — clamp `max_tokens` DOWN to this before the request leaves.
   *
   * vLLM counts `prompt + max_tokens` against `--max-model-len` and REFUSES
   * rather than trims (measured on the Swift lane, v0.31): a ~240k prompt
   * with the fleet-standard `max_tokens: 32000` against a 262144 window is a
   * hard refusal, and the same prompt with the cap at 8192 is served. Set it
   * to the window minus your real prompt headroom; unset = verbatim
   * passthrough (today's behavior).
   */
  maxOutputTokens: z.number().int().min(1).optional(),
  /**
   * #441 — dynamic output clamp: the provider's TOTAL window (`--max-model-len`
   * on vLLM, `prompt + max_tokens` counted together, refusal never trim —
   * vllm#110). When set, `max_tokens` is clamped per request to
   * `contextLimit − promptEstimate − max(2048, est/64)` (proportional margin),
   * where the estimate replaces each image/document base64 block with a fixed
   * 1600-token allocation (`estimateClampTokens`) — a 1 MB screenshot scores
   * ~1.6k tokens, not ~750k. Below a useful floor of `min(max_tokens asked,
   * 4096)` the clamp stands down and the upstream refusal stays recoverable
   * (#431 SKIP). A compaction turn at the RX95 window (250k) still fits a
   * 262 144 Swift window instead of 400ing. Composes with `maxOutputTokens`
   * (the smaller cap wins). Unset = verbatim passthrough (today's behavior).
   */
  contextLimit: z.number().int().min(1).optional(),
  /**
   * #651 — read the endpoint's real window from its OWN `/v1/models` at startup
   * (`max_model_len` on vLLM) instead of trusting the hand-typed `contextLimit`.
   *
   * Measured 2026-10-24 (hub): the declared 262 144 agreed with the engine by
   * coincidence — nothing in the proxy ever read `max_model_len`, so swapping
   * the served model or rebuilding the engine with a smaller `--max-model-len`
   * would have left the admission census (#565) and the dynamic clamp (#441)
   * working from a number a human typed, silently and in the dangerous
   * direction. Opt-in per endpoint: absent = today's behavior, byte for byte.
   *
   * A FAILED probe reports "not derived" and falls back to `contextLimit` — it
   * never substitutes a default: an absent measurement coerced into a number is
   * invented evidence (same class as the missing-sample rule).
   */
  deriveContextLimit: z.boolean().optional(),
  /**
   * Drop `reasoning_content` from outbound assistant messages.
   *
   * The OpenAI-format converter emits that field whenever a thinking block is
   * present in history (openai-messages.ts), independent of any opt-in — most
   * OpenAI-compatible backends either require it (DeepSeek) or ignore it
   * (GLM, Kimi). Strict-schema APIs reject it instead: Mistral answers HTTP 422
   * `extra_forbidden` on `body.messages[N].assistant.reasoning_content`, which
   * fails every turn of a real thinking-mode session.
   *
   * Set for endpoints that validate their request body strictly. Defaults to
   * false — no existing endpoint changes behavior.
   */
  omitReasoningContent: z.boolean().optional(),
});

// "Complex" custom endpoint: a runtime PROVIDER_PROFILES entry.
// All ProviderProfile fields, with reasonable defaults documented in Phase 3.
export const CustomEndpointComplexSchema = z.object({
  kind: z.literal("complex"),
  displayName: z.string(),
  transport: z.enum(["openai", "anthropic", "gemini", "ollamacloud", "litellm"]),
  baseUrl: z.url(),
  apiPath: z.string().optional(),
  apiKey: z.string().min(1),
  authScheme: z.enum(["bearer", "x-api-key"]).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  streamFormat: z
    .enum([
      "openai-sse",
      "openai-responses-sse",
      "gemini-sse",
      "anthropic-sse",
      "ollama-jsonl",
    ])
    .optional(),
  modelPrefix: z.string().optional(),
  models: z.array(z.string()).optional(),
  /**
   * Max concurrent in-flight requests to this endpoint (0 = unlimited, 1 =
   * sequential). See CustomEndpointSimpleSchema.maxConcurrency (cap 32 there).
   */
  maxConcurrency: z.number().int().min(0).max(32).optional(),
  /** See CustomEndpointSimpleSchema.maxOutputTokens (#431 output cap). */
  maxOutputTokens: z.number().int().min(1).optional(),
  /** See CustomEndpointSimpleSchema.contextLimit (#441 dynamic clamp). */
  contextLimit: z.number().int().min(1).optional(),
  /** See CustomEndpointSimpleSchema.deriveContextLimit (#651 derivation). */
  deriveContextLimit: z.boolean().optional(),
  /** See CustomEndpointSimpleSchema.omitReasoningContent. */
  omitReasoningContent: z.boolean().optional(),
});

export const CustomEndpointSchema = z.discriminatedUnion("kind", [
  CustomEndpointSimpleSchema,
  CustomEndpointComplexSchema,
]);

// defaultProvider can be a builtin OR the name of a custom endpoint
// (we validate the cross-reference at load time, not in the schema).
export const DefaultProviderSchema = z.union([
  BuiltinDefaultProviderSchema,
  z.string().min(1),
]);

export type BuiltinDefaultProvider = z.infer<typeof BuiltinDefaultProviderSchema>;
export type CustomEndpointSimple = z.infer<typeof CustomEndpointSimpleSchema>;
export type CustomEndpointComplex = z.infer<typeof CustomEndpointComplexSchema>;
export type CustomEndpoint = z.infer<typeof CustomEndpointSchema>;
