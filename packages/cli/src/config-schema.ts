/**
 * Config schemas for the LiteLLM-demotion refactor (Phase 1).
 *
 * Defines:
 *   - CustomEndpointSimpleSchema    — "URL + format + key" custom endpoints.
 *   - CustomEndpointComplexSchema   — full provider profile (Phase 3 will register).
 *   - CustomEndpointSchema          — discriminated union of the two.
 *
 * `defaultProvider` has no schema. Nothing validated it, and the one that existed
 * rejected `""`, which is a valid value (no fallback provider), and listed
 * `anthropic`, which is not a claudish provider.
 *
 * Endpoint validation happens at the consumption site. The accounts config
 * transaction also imports this module: every global save must validate and
 * preserve the disk-owned accounts block under the shared config lock.
 */

import { z } from "zod";
import { CODEX_WINDOW_SLOTS } from "./auth/quota/codex-window-slots.js";

/**
 * How a custom endpoint authenticates.
 *
 * `"none"` exists because there was previously NO WAY to reach an endpoint that
 * wants no credential — a local gateway, an inference server on a trusted
 * network. `apiKey` was `z.string().min(1)`, so `""` failed validation, and any
 * placeholder ("none", "x") was sent as a real `Authorization: Bearer none`
 * header. Reported in #139 by a user whose local router rejected the stray
 * header; the whole entry was refused with `Too small: expected string to have
 * >=1 characters`, which reads as a bug in claudish rather than a missing
 * feature.
 *
 * It is EXPLICIT rather than inferred from an absent `apiKey`. A misspelled key
 * field ("apikey", "api_key") would otherwise silently downgrade an endpoint to
 * unauthenticated and send the user's prompts out with no credential — a failure
 * that looks like it worked. Requiring the declaration means the only way to get
 * no auth is to ask for it.
 */
export const CustomEndpointAuthSchemeSchema = z.enum(["bearer", "x-api-key", "none"]);

/**
 * `apiKey` is required UNLESS `authScheme: "none"`, in which case it must be
 * absent or empty.
 *
 * Written as a refinement rather than two schema variants so the ERROR is
 * actionable in both directions. The old failure told the user their string was
 * too short and left them to guess; these name the field to add.
 */
function requireKeyUnlessNoAuth<
  T extends { apiKey?: string; authScheme?: "bearer" | "x-api-key" | "none" },
>(ep: T, ctx: z.RefinementCtx): void {
  const declared = ep.apiKey?.trim() ?? "";
  if (ep.authScheme === "none") {
    if (declared !== "") {
      ctx.addIssue({
        code: "custom",
        path: ["apiKey"],
        message:
          'authScheme "none" sends no auth header, so apiKey must be omitted. ' +
          "Remove apiKey, or drop authScheme to send it as a bearer token.",
      });
    }
    return;
  }
  if (declared === "") {
    ctx.addIssue({
      code: "custom",
      path: ["apiKey"],
      message:
        "apiKey is required. If this endpoint needs no credential, set " +
        '"authScheme": "none" and omit apiKey entirely.',
    });
  }
}

const WireValueSchema = z.union([z.string(), z.number(), z.boolean()]);

/** RFC 6901 pointer into the request body root, e.g. `/reasoning/effort`. */
const WirePointerSchema = z.string().startsWith("/");

const WireAssignmentSchema = z.object({ path: WirePointerSchema, value: WireValueSchema });

/**
 * How a custom endpoint is called, declared by the user — the same vocabulary
 * the cloud models catalog publishes per connection (`wire`), because a custom
 * endpoint has no catalog connection and claudish never guesses one from the
 * model name. Every field is optional; the documented defaults are:
 *
 *   api         the transport's API (openai → chat-completions, anthropic →
 *               anthropic-messages); an openai endpoint may say "responses"
 *   tokenParam  max_tokens (chat, messages) / max_output_tokens (responses);
 *               "none" sends no output limit
 *   reasoning   nothing sent. Declare `effort.path` (and optionally `values`,
 *               mapping claudish's effort names none…max to the endpoint's own
 *               values; identity when omitted), `enable`, `disable`.
 */
export const CustomEndpointWireSchema = z.object({
  api: z.enum(["chat-completions", "responses", "anthropic-messages"]).optional(),
  tokenParam: z
    .enum(["max_tokens", "max_completion_tokens", "max_output_tokens", "none"])
    .optional(),
  reasoning: z
    .object({
      enable: z.array(WireAssignmentSchema).optional(),
      disable: z.array(WireAssignmentSchema).optional(),
      effort: z
        .object({
          path: WirePointerSchema,
          values: z.record(z.string(), WireValueSchema).optional(),
          default: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});

/** A declared `wire.api` must be one the endpoint's transport can speak. */
function requireWireApiForTransport(
  transport: string,
  wire: z.infer<typeof CustomEndpointWireSchema> | undefined,
  ctx: z.RefinementCtx
): void {
  const api = wire?.api;
  if (!api) return;
  const allowed: Record<string, string[]> = {
    openai: ["chat-completions", "responses"],
    litellm: ["chat-completions"],
    anthropic: ["anthropic-messages"],
  };
  if (allowed[transport] && !allowed[transport].includes(api)) {
    ctx.addIssue({
      code: "custom",
      path: ["wire", "api"],
      message: `wire.api "${api}" is not spoken by the ${transport} transport (use ${allowed[transport].join(" or ")})`,
    });
  }
}

// "Simple" custom endpoint: just URL + format + key.
// Reuses existing OpenAI/Anthropic format converters and a generic transport.
export const CustomEndpointSimpleSchema = z
  .object({
    kind: z.literal("simple"),
    url: z.url(),
    format: z.enum(["openai", "anthropic"]),
    // Optional so `authScheme: "none"` can omit it; the refinement below still
    // requires it for every other scheme.
    apiKey: z.string().optional(),
    // `simple` used to have no authScheme at all and hardcoded bearer. It is
    // accepted here ONLY so a keyless endpoint does not have to be rewritten as
    // `kind: "complex"` just to say "no auth" — the narrowest widening that
    // closes #139 for the shape the reporter actually used.
    authScheme: CustomEndpointAuthSchemeSchema.optional(),
    modelPrefix: z.string().optional(),
    models: z.array(z.string()).optional(),
    wire: CustomEndpointWireSchema.optional(),
  })
  .superRefine((ep, ctx) => {
    requireKeyUnlessNoAuth(ep, ctx);
    requireWireApiForTransport(ep.format, ep.wire, ctx);
  });

// "Complex" custom endpoint: a runtime PROVIDER_PROFILES entry.
// All ProviderProfile fields, with reasonable defaults documented in Phase 3.
export const CustomEndpointComplexSchema = z
  .object({
    kind: z.literal("complex"),
    displayName: z.string(),
    transport: z.enum(["openai", "anthropic", "gemini", "ollamacloud", "litellm"]),
    baseUrl: z.url(),
    apiPath: z.string().optional(),
    apiKey: z.string().optional(),
    authScheme: CustomEndpointAuthSchemeSchema.optional(),
    headers: z.record(z.string(), z.string()).optional(),
    streamFormat: z
      .enum(["openai-sse", "openai-responses-sse", "gemini-sse", "anthropic-sse", "ollama-jsonl"])
      .optional(),
    modelPrefix: z.string().optional(),
    models: z.array(z.string()).optional(),
    wire: CustomEndpointWireSchema.optional(),
  })
  .superRefine((ep, ctx) => {
    requireKeyUnlessNoAuth(ep, ctx);
    requireWireApiForTransport(ep.transport, ep.wire, ctx);
  });

export const CustomEndpointSchema = z.discriminatedUnion("kind", [
  CustomEndpointSimpleSchema,
  CustomEndpointComplexSchema,
]);

/**
 * Opt-out surface for the BUNDLED endpoint catalog (`predefined-catalog.ts`).
 *
 *   "predefinedEndpoints": {
 *     "enabled": false,              // the whole catalog is off
 *     "disable": ["groq"],           // individual opt-out, case-insensitive
 *     "enable":  ["tuningengines"]   // activate despite no locally-present key
 *   }
 *
 * `enable` exists because activation is otherwise inferred from a credential
 * being present SYNCHRONOUSLY, and a key that lives only behind an `op://`
 * reference cannot be seen without the async 1Password path — which the gate
 * deliberately cannot reach. It is also the answer for a keyless self-hosted
 * gateway sitting behind network auth.
 *
 * `disable` beats `enable`: refusals beat permissions, the same rule that puts
 * the collision check ahead of the credential gate.
 *
 * NOT `.strict()`, deliberately — an unknown key here is a forward-compat
 * config from a newer claudish, and the right response to that is to honour the
 * keys we understand, not to discard the block. Unknown NAMES in `disable` /
 * `enable` are likewise a silent no-op: a user who opts out of a vendor that is
 * later dropped from the bundle should not collect a warning on every launch
 * for a line that is now simply inert.
 */
export const PredefinedEndpointsConfigSchema = z.object({
  enabled: z.boolean().optional(),
  disable: z.array(z.string()).optional(),
  enable: z.array(z.string()).optional(),
});

export type CustomEndpointWire = z.infer<typeof CustomEndpointWireSchema>;

/**
 * The subscription account lists, one per provider, as they appear in `config.json`.
 *
 * ```jsonc
 * "subscriptionAccounts": {
 *   "openai-codex": {
 *     "generation": 3,
 *     "switchAt": 0.9,
 *     "switchAtByWindow": { "primary": 0.8 },
 *     "accounts": [
 *       { "id": "a1b2c3d4e5f6", "label": "work", "store": "keychain",
 *         "addedAt": "2026-09-01T10:00:00Z",
 *         "identity": { "chatgptAccountId": "…", "plan": "pro" } }
 *     ]
 *   }
 * }
 * ```
 *
 * NO SECRETS, and no `owner` — the named refresher lives in `state.json` alone.
 *
 * **`switchAtByWindow` is keyed on the STABLE SLOT ID**, not on the formatted
 * duration. `scrapeCodexHeaders` replaces a slot's id with
 * `formatWindowMinutes(minutes)` whenever `window-minutes` is present, so
 * production Codex windows render as `"5h"`/`"7d"` — values that change with the
 * user's plan. A threshold keyed on those silently never matches.
 *
 * Codex keys are therefore the closed set `"primary"`/`"secondary"`, and a
 * mistyped one is REJECTED rather than ignored. Anthropic's keys are its window
 * names, which are DISCOVERED from the response headers and deliberately not
 * pinned here: the vendor may change its window set, and a closed list would
 * turn that into "this account reports no usage".
 *
 * `id` is generated and opaque because it is interpolated into two PATHS
 * (`locks/<provider>/<id>.lock`, `tokens/<provider>/<id>.json`); the pattern is
 * what keeps an account-list edit from becoming a path traversal.
 */
export const AccountIdentitySchema = z.object({
  accountUuid: z.string().optional(),
  chatgptAccountId: z.string().optional(),
  email: z.string().optional(),
  plan: z.string().optional(),
});

export const AccountStoreKindSchema = z.enum(["keychain", "file", "legacy-codex-file"]);

export const SubscriptionAccountSchema = z.object({
  id: z.string().regex(/^[a-z0-9]{12}$/, "account ids are generated, 12 lowercase alphanumerics"),
  label: z.string().regex(/^[\w][\w .-]{0,31}$/, "labels are 1-32 word characters, . - or space"),
  identity: AccountIdentitySchema.optional(),
  store: AccountStoreKindSchema,
  enabled: z.boolean().optional(),
  addedAt: z.string(),
});

/** Codex slot names. Positions, not durations — see the block comment above. */
export const CodexWindowSlotSchema = z.enum(CODEX_WINDOW_SLOTS.map((slot) => slot.fallbackId));

export const SubscriptionAccountsEntrySchema = z.object({
  enabled: z.boolean().optional(),
  switchAt: z.number().min(0).max(1).optional(),
  switchAtByWindow: z.record(z.string(), z.number().min(0).max(1)).optional(),
  noticeAcceptedAt: z.string().optional(),
  legacyCodexSuppressed: z.boolean().optional(),
  /**
   * The allowance model's selection strategy, exactly `DEPLOYABLE`
   * (`allowance/strategies/strategy.ts`). Declared here because the entry is a
   * non-strict object: an undeclared key is stripped on parse and lost on the
   * first `account add`/`remove` write. Absent means `sticky`.
   */
  strategy: z.enum(["sticky", "ebr", "lookahead"]).optional(),
  generation: z.number().int().min(0),
  accounts: z.array(SubscriptionAccountSchema),
});

export const SubscriptionAccountsSchema = z
  .object({
    "native-anthropic": SubscriptionAccountsEntrySchema.optional(),
    "openai-codex": SubscriptionAccountsEntrySchema.optional(),
  })
  .superRefine((block, ctx) => {
    for (const key of Object.keys(block["openai-codex"]?.switchAtByWindow ?? {})) {
      if (CodexWindowSlotSchema.safeParse(key).success) continue;
      ctx.addIssue({
        code: "custom",
        path: ["openai-codex", "switchAtByWindow", key],
        message:
          `"${key}" is not a Codex window slot. Use "primary" or "secondary" — the ` +
          'formatted durations ("5h", "7d") are display ids that change with the plan, ' +
          "so a threshold keyed on one silently never matches.",
      });
    }
  });

export type SubscriptionAccountEntryConfig = z.infer<typeof SubscriptionAccountsEntrySchema>;
export type SubscriptionAccountsBlock = z.infer<typeof SubscriptionAccountsSchema>;

export type CustomEndpointSimple = z.infer<typeof CustomEndpointSimpleSchema>;
export type CustomEndpointComplex = z.infer<typeof CustomEndpointComplexSchema>;
export type CustomEndpoint = z.infer<typeof CustomEndpointSchema>;
export type PredefinedEndpointsConfig = z.infer<typeof PredefinedEndpointsConfigSchema>;
