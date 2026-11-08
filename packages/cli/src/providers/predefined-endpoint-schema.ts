/**
 * The shape of ONE row in the bundled predefined-endpoint catalog.
 *
 * A predefined endpoint is a curated `customEndpoints` entry that ships inside
 * the package, so a user gets `vendor@model` routing without hand-authoring
 * `~/.claudish/config.json`. Each row carries CONNECTION FACTS ONLY — base URL,
 * API path, wire format, auth scheme, the env var the vendor's own docs name —
 * plus the provenance that justifies its membership.
 *
 * Two constraints shape this schema, and both are enforced structurally rather
 * than by review:
 *
 *  1. **No model data, ever.** There is no `models`, `contextWindow`,
 *     `maxOutputTokens`, `pricing`, `capabilities` or `modelDiscovery` field.
 *     A shipped model list is exactly the hardcoded model data this project forbids:
 *     it rots the moment a vendor adds a model, and the failure shape is
 *     claudish refusing a model that actually works. Model metadata comes from
 *     models-index or is absent. The schema is `.strict()`, so a future
 *     contributor cannot add one of those keys by accident — an unknown key is
 *     a parse error, not a silently ignored field. Same doctrine as the upload
 *     projection in the hook engine's `journal()` fan-out (hooks/engine.ts): only
 *     fields passed explicitly reach the telemetry report, so leaking has to be
 *     done on purpose.
 *
 *  2. **`apiPath` is REQUIRED, with no default.** Measured 2026-08-14: DeepInfra
 *     (`/v1/openai` + `/chat/completions`), Novita (`/v3/openai` +
 *     `/chat/completions`) and Perplexity (`/chat/completions`, no `/v1`) do not
 *     use `/v1/chat/completions`. An optional field with a default makes the
 *     failure mode *omission*, and omission is invisible in review. Repeating
 *     the same string on most rows is the price of making the wrong thing
 *     impossible to write by forgetting. `format` is required for the same
 *     reason despite every shipped row being `"openai"` today — the field that
 *     is always the same value is the field nobody checks when row N differs.
 *
 * The Zod schema is the source of truth and `PredefinedEndpoint` is inferred
 * from it, so the compile-time type and the run-time validator cannot drift.
 * (Declaring the interface by hand next to a `.strict()` schema is exactly the
 * two-table coupling this feature exists to avoid, one scale down.)
 */

import { z } from "zod";

/**
 * Provenance for one catalog row (R11). Recorded because the user's gate on
 * this feature was "unless those providers are fully functional through this
 * layer" — so the evidence for each vendor travels with the vendor.
 *
 * NEVER consulted at run time by any code path. It exists for the catalog
 * invariant test, for `claudish providers --json`, and for the reviewer of the
 * next vendor PR, who needs to see at a glance that unverified rows do not
 * exist.
 *
 *  - `tier: "live"`  — a real turn was driven through claudish with a real key.
 *  - `tier: "probe"` — a POST to the configured chat path with a deliberately
 *    invalid key was answered by the vendor's auth layer, and differed from a
 *    deliberately bogus sibling path. A `GET /v1/models` result is NOT evidence
 *    and must never be recorded here: Alibaba's `coding-intl` model-list endpoint
 *    answers a bogus key, and no key at all, with the full list.
 *  - `verdict: "auth-realm"` — 401/403; credentials are checked at this path.
 *  - `verdict: "model-gate"` — the route resolved and rejected the fake model.
 */
export const PredefinedEndpointEvidenceSchema = z
  .object({
    tier: z.enum(["live", "probe"]),
    verdict: z.enum(["auth-realm", "model-gate"]),
    /** HTTP status observed, when the verdict came from one. */
    status: z.number().int().optional(),
    /** ISO date (YYYY-MM-DD) the measurement was taken. */
    measuredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    /** Anything a reader needs to know, e.g. "non-OpenAI error shape". */
    note: z.string().optional(),
  })
  .strict();

export const PredefinedEndpointSchema = z
  .object({
    /**
     * Canonical provider name. Becomes the ONLY shortcut and therefore the
     * `@prefix`, so it must not collide with a builtin's name or shortcut —
     * checked against the LIVE registry at registration, not by this schema.
     */
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    displayName: z.string().min(1),

    // ── connection facts ──────────────────────────────────────────────────
    /** No trailing slash; the path is concatenated verbatim. */
    baseUrl: z.url(),
    /** REQUIRED, no default. See the header note. */
    apiPath: z.string().regex(/^\//),
    format: z.enum(["openai", "anthropic"]),
    authScheme: z.enum(["bearer", "x-api-key"]).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    /** Prepended to the user's model name before the request is sent. */
    modelPrefix: z.string().optional(),

    // ── credential ────────────────────────────────────────────────────────
    /**
     * The variable the VENDOR'S OWN DOCS name (`GROQ_API_KEY`), not the
     * synthesized `CUSTOM_<NAME>_KEY` — a user who already exported it for
     * another tool works with no further setup. `CUSTOM_<NAME>_KEY` is appended
     * as an alias at registration, so the user-authored spelling keeps working.
     */
    apiKeyEnvVar: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    /** Additional accepted spellings, tried in order after the primary. */
    apiKeyAliases: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).optional(),
    /** Where a user obtains a key — surfaced in the missing-key error. */
    apiKeyUrl: z.url().optional(),

    // ── endpoint override ─────────────────────────────────────────────────
    /**
     * Env vars that override `baseUrl` at run time (R12), e.g.
     * `TUNING_ENGINES_BASE_URL`. Needed by gateway-shaped vendors: a
     * self-hosted instance does not live at the public hostname, and without
     * this those users cannot use the bundled row at all.
     */
    baseUrlEnvVars: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).optional(),

    // ── metadata ──────────────────────────────────────────────────────────
    description: z.string().optional(),
    evidence: PredefinedEndpointEvidenceSchema,
  })
  .strict();

export type PredefinedEndpointEvidence = z.infer<typeof PredefinedEndpointEvidenceSchema>;
export type PredefinedEndpoint = z.infer<typeof PredefinedEndpointSchema>;
