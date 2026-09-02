/**
 * Default routing rules shipped with claudish.
 *
 * Same shape users edit via `claudish config route` (see `RoutingRules` in
 * `profile-config.ts`). Users can override any pattern (including the catch-all
 * `"*"`) by writing their own routing rules in `~/.claudish/config.json` or a
 * project-local `.claudish.json` — user rules merge ON TOP of these defaults at
 * load time (see `loadRoutingRules` in `routing-rules.ts`).
 *
 * Rule design notes:
 *   - Subscription endpoints come FIRST (people who paid for them want them
 *     used; the chain falls through automatically when subscription credentials
 *     are missing because route() filters by credential availability).
 *   - Direct-API providers come second.
 *   - OpenRouter is last by convention — it's a universal aggregator. Users
 *     who don't want OpenRouter as the catch-all override "*" with their own
 *     chain or [].
 *   - The `provider@model` rewrite syntax (see kimi-* below) is used when a
 *     subscription endpoint expects a different model name than the direct API.
 *
 * Migration plan §B.1 — Commit 4 of the model-catalog and routing redesign.
 */
import type { RoutingRules } from "../profile-config.js";
import { PROVIDER_SHORTCUTS } from "./model-parser.js";
import { getProviderByName } from "./provider-definitions.js";

export const DEFAULT_ROUTING_RULES: RoutingRules = {
  // Anthropic Claude — native first, then OpenRouter.
  "claude-*": ["native-anthropic", "openrouter"],

  // OpenAI families: Codex subscription first, then direct API, then OpenRouter.
  "gpt-*": ["openai-codex", "openai", "openrouter"],
  "o1-*": ["openai-codex", "openai", "openrouter"],
  "o3-*": ["openai-codex", "openai", "openrouter"],

  // Google Gemini: Antigravity subscription, direct API, OpenRouter.
  //
  // `antigravity` holds the subscription slot that `gemini-codeassist` used to.
  // Google retired Code Assist for individuals (UNSUPPORTED_CLIENT for
  // gemini-cli's OAuth client), so leaving the retired provider at the head of
  // this chain cost a guaranteed-failing round-trip and then silently billed the
  // metered `google` API for a model the user's subscription already covers.
  //
  // Antigravity's served ids carry a reasoning-tier suffix
  // (`gemini-3.6-flash-high`); the transport resolves a bare family name against
  // the account's LIVE served set, so a bare `gemini-3.6-flash` routes correctly
  // here. No token → route() filters the candidate out and `google` takes over.
  "gemini-*": ["antigravity", "google", "openrouter"],

  // xAI Grok: account-discovered subscription, direct API, then OpenRouter.
  // Subscription BEFORE metered, the same order every other split family uses
  // (glm-coding before glm, qwen-cloud before qwen-payg). A user holding both a
  // Grok subscription and an XAI_API_KEY must never be silently billed per token
  // for a model their plan already covers. Safe to put in the bare chain — and
  // unlike Devin or Qwen Plan, which are explicit-access only — because these
  // ids are xAI's own, so there is no other vendor's namespace to collide with.
  "grok-*": ["grok-subscription", "x-ai", "openrouter"],

  // Kimi: the subscription endpoint speaks its own wire ids (kimi-for-coding,
  // kimi-for-coding-highspeed, k3, k3-256k) — NOT catalog names like
  // "kimi-k2.7-code". No model is pinned here: buildRoutingChain translates the
  // catalog name to the plan's wire id via `subscriptionPlans[]` plan IDs,
  // cached `queryPlans.routing.providerUid`, and `aggregators[].externalId`.
  // It drops the kimi-coding candidate when the
  // plan doesn't include the model (e.g. kimi-k2.5) so it falls through to the
  // metered Moonshot API rather than being silently answered by a different
  // model. `k3*` needs its own rule: it doesn't match `kimi-*`, and the catalog
  // alias would otherwise send bare `k3` to the paid OpenRouter listing.
  // `opencode-zen-go` sits between the vendor's own plan and the metered API on
  // every family below — see "Zen Go placement" at the bottom of this table for
  // why that is safe here but is NOT safe for qwen-cloud.
  "kimi-*": ["kimi-coding", "opencode-zen-go", "kimi", "openrouter"],
  "k3*": ["kimi-coding", "opencode-zen-go", "kimi", "openrouter"],

  // MiniMax (matchRoutingRule is case-insensitive, so a single rule covers
  // both `MiniMax-M2.5` and `minimax-m2.5`).
  "minimax-*": ["minimax-coding", "opencode-zen-go", "minimax", "openrouter"],

  // GLM: coding plan, Zen Go plan, direct, OpenRouter.
  "glm-*": ["glm-coding", "opencode-zen-go", "glm", "openrouter"],

  // Qwen Plan (Alibaba Model Studio subscription), then OpenRouter.
  // `globMatch` is a literal prefix/suffix split, so the "." is matched
  // literally: this claims the DOTTED names (qwen3.7-plus) and not the
  // hyphenated ones (qwen3-coder-next).
  //
  // Hyphenated is NOT a synonym for "third-party name" — see the measured
  // rosters in provider-definitions.ts's qwen-cloud note. Alibaba ships both
  // conventions; the Token Plan this chain leads with just happens to serve
  // only dotted ids, which is why the split lands correctly here. Extending
  // this rule to `qwen3-*` is the same 400-dead-end hazard described for glm-*
  // below, and needs a verified PAYG roster first.
  //
  // The plan ALSO serves glm-5.2 and deepseek-v4-*, but their chains are left
  // untouched on purpose. Routing filters by CREDENTIAL availability, not by
  // model availability — putting qwen-cloud in front of "glm-*" would send
  // glm-4.6 to Alibaba on the strength of the plan key alone, earn a
  // `400 Model not exist`, and stop there, because 400 is deliberately
  // non-retryable in fallback-handler.ts. Cross-vendor access to the plan
  // stays explicit: `qc@glm-5.2`.
  //
  // `qwen-payg` (Alibaba's metered dashscope-intl host) sits after the plan and
  // the Go plan, exactly where `kimi` / `glm` / `minimax` sit in their own
  // chains: subscription → Go plan → metered vendor API → aggregator. Its key
  // is a DIFFERENT credential from the plan's (each Alibaba silo rejects the
  // others'), so a user holding both is answered by the plan they already pay
  // for, while a user holding only a PAYG key now reaches Alibaba at all —
  // before this entry existed, the sole Qwen chain pointed at a host their key
  // could never authenticate against.
  "qwen3.*": ["qwen-cloud", "opencode-zen-go", "qwen-payg", "openrouter"],

  // Z.AI native models.
  "z-ai-*": ["z-ai", "openrouter"],

  // DeepSeek: Zen Go plan, then the metered direct API, then OpenRouter.
  "deepseek-*": ["opencode-zen-go", "deepseek", "openrouter"],

  // MiMo and HunYuan are served by the Zen Go plan and had no rule at all, so
  // they fell to the `*` catch-all and were billed through OpenRouter.
  "mimo-*": ["opencode-zen-go", "openrouter"],
  "hy3*": ["opencode-zen-go", "openrouter"],

  // Mistral: direct API, then OpenRouter. Three separate product lines —
  // `ministral-` and `codestral-` are not prefixes of `mistral-`, so a single
  // glob cannot cover them. `magistral-*` is deliberately NOT claimed: it is not
  // in the catalog's mistralai set, so routing it here would send it to a
  // provider that does not serve it.
  "mistral-*": ["mistralai", "openrouter"],
  "ministral-*": ["mistralai", "openrouter"],
  "codestral-*": ["mistralai", "openrouter"],
  // Mistral Labs ships under its own prefix. NO openrouter fallback: this is
  // the one mistralai model no other provider in the catalog serves, so naming
  // a fallback would claim a reachability that does not exist.
  "labs-*": ["mistralai"],

  // Cognition SWE: Devin only, NO fallback — same shape as `labs-*` above, and
  // for the same reason: no other provider in the catalog serves it, so naming
  // a fallback would claim a reachability that does not exist.
  //
  // This is a DELIBERATE, NARROW amendment to the "no bare name ever routes to
  // Devin" rule. That rule exists because Devin re-serves other vendors' models
  // under uids that collide head-on with their namespaces — `claude-opus-5-high`
  // matches native-anthropic's `/^claude-/i`, `gpt-5-6-luna-medium` matches
  // OpenAI's, `glm-5-2` GLM's — so a bare name reaching Devin would answer as
  // the wrong vendor. `swe-*` is the one family that is COGNITION'S OWN: it
  // collides with nothing, no other provider in the catalog carries it, and the
  // hosted catalog attributes it to `cognition-devin`. Without this rule the
  // bare id matched nothing, fell through to native-anthropic, and was silently
  // rewritten to `claude-opus-4-1` — a healthy backend made unreachable through
  // the catalog's own identifier, answered by another vendor's model.
  //
  // The invariant still holds everywhere it was aimed: no COLLIDING bare name
  // reaches Devin. Do not generalise this entry to Devin's re-served families.
  "swe-*": ["devin"],

  // Sakana Fugu: subscription first, then token API. NO hardcoded openrouter —
  // we don't claim OpenRouter carries the model; it's reachable explicitly via
  // or@sakana/fugu (catalog-resolved). The bare "fugu" id needs its own exact
  // rule because "fugu-*" only matches hyphenated names.
  fugu: ["sakana-subscription", "sakana"],
  "fugu-*": ["sakana-subscription", "sakana"],

  // OpenCode Zen owns/serves a few model lines exclusively.
  // Pragmatic shim until Firebase aggregators[] coverage closes the gap.
  "*-zen": ["opencode-zen"],

  // ── Zen Go placement ──────────────────────────────────────────────────────
  //
  // `opencode-zen-go` appears above on kimi/glm/minimax/deepseek/qwen3/mimo/hy3
  // because the Go plan serves all of those families, and without it a bare name
  // skipped a subscription the user already pays for and was billed per-token by
  // the vendor's metered API (or by OpenRouter, for mimo/hy3 which had no rule).
  //
  // Why this is safe where the same move is NOT safe for qwen-cloud (see the
  // `qwen3.*` note above): the catalog join now drops known-unserved Go models.
  // On a cold or legacy cache, `resolveSubscriptionRouting` remains `unknown`
  // and the candidate is kept for every model in the family — including ones
  // the plan does not serve. What
  // happens next is the whole argument, and it is provider-specific:
  //
  //   Zen Go, unserved model  → 401 {"type":"ModelError","message":"Model X is
  //                             not supported"}  → RETRYABLE → chain falls
  //                             through to the metered provider. Verified live
  //                             2026-08-06 against kimi-k2.7, glm-4.6,
  //                             minimax-m2, deepseek-v3.2 and a nonsense id.
  //   Alibaba, unserved model → 400 "Model not exist" → NOT retryable → the
  //                             chain STOPS and the user gets an error instead
  //                             of a working provider.
  //
  // So the cost of a miss here is one wasted round-trip, not a dead request.
  // That is also why the broad `gpt-*` and `grok-*` families are deliberately
  // left alone: the Go plan carries only `gpt-5.6-luna` and `grok-4.5`, so
  // adding it there would buy a subscription hit on one model in exchange for a
  // wasted 401 on every other call in the family.
  //
  // Current caches get that answer by joining the `opencode-go` commercial plan
  // ID to provider `opencode-zen-go`; no provider UID is stored in
  // `subscriptionPlans[]`.

  // Catch-all: try OpenRouter (it covers most things). Users disable with
  // routing["*"] = [] for strict no-fallback mode, or replace with their own
  // chain.
  "*": ["openrouter"],
};

/**
 * Validate that every provider name referenced by a routing rules table exists
 * in `provider-definitions.ts`. Walks each entry, strips the optional
 * `@model` suffix, resolves shortcuts (e.g. `or` → `openrouter`), and looks
 * each canonical provider up.
 *
 * Throws if any rule references a typo provider — dev-time only; the cost is
 * a single sweep at module load and prevents silent no-op rules from shipping
 * to users.
 *
 * Exposed (not just internal) so tests can pass intentionally-broken rule
 * tables to verify the validator's contract.
 */
export function validateRoutingRulesAgainstProviders(rules: RoutingRules): void {
  const unknown: Array<{ rule: string; entry: string; provider: string }> = [];

  for (const ruleKey of Object.keys(rules)) {
    const entries = rules[ruleKey] ?? [];
    for (const entry of entries) {
      const atIdx = entry.indexOf("@");
      const providerRaw = atIdx === -1 ? entry : entry.slice(0, atIdx);
      const canonical = PROVIDER_SHORTCUTS[providerRaw.toLowerCase()] ?? providerRaw.toLowerCase();
      if (!getProviderByName(canonical)) {
        unknown.push({ rule: ruleKey, entry, provider: canonical });
      }
    }
  }

  if (unknown.length > 0) {
    const lines = unknown.map(
      (u) => `  rule "${u.rule}" → entry "${u.entry}" → unknown provider "${u.provider}"`
    );
    throw new Error(
      `[claudish] DEFAULT_ROUTING_RULES references unknown providers:\n${lines.join("\n")}`
    );
  }
}

/**
 * Validate the shipped DEFAULT_ROUTING_RULES at module load. Throws on a typo
 * so the bug surfaces in `bun run build` / test runs instead of as a silent
 * no-route at runtime.
 */
export function validateDefaultRoutingRules(): void {
  validateRoutingRulesAgainstProviders(DEFAULT_ROUTING_RULES);
}

// Eager validation at import time.
validateDefaultRoutingRules();
