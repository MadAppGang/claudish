# Model routing

> How a bare model name becomes a provider chain: defaultProvider, catalog resolvers, the derived picker roster, subscription pricing.
>
> Extracted from `CLAUDE.md` (v7.64.0). Indexed in [`README.md`](./README.md).

## New Syntax: `provider@model[:concurrency]`

```bash
# Explicit provider routing
claudish --model google@gemini-2.0-flash "task"
claudish --model openrouter@deepseek/deepseek-r1 "task"

# Native auto-detection (no prefix needed)
claudish --model gpt-4o "task"          # → OpenAI
claudish --model gemini-2.0-flash "task" # → Google
claudish --model llama-3.1-70b "task"   # → OllamaCloud

# Local models with concurrency
claudish --model ollama@llama3.2:3 "task"  # 3 concurrent requests
```

## Provider Shortcuts
- `g@`, `google@` → Google Gemini (direct API, `GEMINI_API_KEY`)
- `ag@`, `antigravity@` → Antigravity (Gemini via your Antigravity subscription — see `ai-docs/architecture/providers/antigravity.md`)
- `oai@` → OpenAI Direct
- `cx@`, `codex@` → OpenAI Codex (Responses API)
- `or@`, `openrouter@` → OpenRouter
- `mm@`, `mmax@` → MiniMax
- `mmc@` → MiniMax Coding Plan
- `kimi@`, `moon@` → Kimi
- `glm@`, `zhipu@` → GLM
- `gc@` → GLM Coding Plan
- `sakana@`, `fugu@` → Sakana Fugu
- `sc@` → Sakana Fugu Subscription
- `qc@` → Qwen Plan (Alibaba Model Studio **Token Plan** subscription)
- `qp@`, `dashscope@` → Qwen API (Alibaba Model Studio **pay-as-you-go**, `DASHSCOPE_API_KEY`)
- `dv@`, `devin@` → Devin (Cognition/Codeium subscription — see `ai-docs/architecture/providers/devin.md`)
- `gk@` → Grok Build subscription (SuperGrok / X Premium+ — see `ai-docs/architecture/providers/grok-subscription.md`). `grok@` stays with the METERED `x-ai` provider
- `x-ai@`, `xai@`, `grok@` → xAI direct API, metered (`XAI_API_KEY`)
- `llama@`, `oc@` → OllamaCloud
- `litellm@`, `ll@` → LiteLLM (requires LITELLM_BASE_URL)
- `ollama@` → Ollama (local)
- `lmstudio@` → LM Studio (local)
- Custom endpoint names also work as provider prefixes (e.g., `my-vllm@model-name`) — see `ai-docs/architecture/custom-endpoints.md`
- **Bundled catalog vendors** each use their own name as their only prefix, and appear only when their key is locally present: `groq@`, `cerebras@`, `together@`, `fireworks@`, `deepinfra@`, `nebius@`, `hyperbolic@`, `sambanova@`, `novita@`, `baseten@`, `perplexity@`, `venice@`, `chutes@`, `featherless@`, `parasail@`, `inference-net@`, `aimlapi@`, `requesty@`, `nanogpt@`, `cohere@`, `scaleway@`, `upstage@`, `writer@`, `moonshot-cn@`, `tuningengines@` — see `ai-docs/architecture/predefined-endpoints.md`. `moonshot-cn@` is the China-region Moonshot product, a DIFFERENT service from the builtin Kimi provider reached by `moonshot@`

## Local models

Claudish supports local models via:
- **Ollama**: `claudish --model ollama@llama3.2` (or `ollama@llama3.2:3` for concurrency)
- **LM Studio**: `claudish --model lmstudio@model-name`
- **Custom URLs**: `claudish --model http://localhost:11434/model`

Local APIs report `prompt_tokens` as the FULL conversation context on every request, not an
increment — see `ai-docs/architecture/context-window.md`.

## Default Provider Configuration (v7.0.0+)

`defaultProvider` is a **last-resort fallback** appended to every bare-name routing chain. It is not a "front of the line" override — specific patterns (`gpt-*`, `gemini-*`, etc.) still try their normal providers first. `defaultProvider` only catches models whose explicit chain has zero credentialed providers, or models that match no rule at all.

Set it via:

- **Config file**: `"defaultProvider": "openrouter"` in `~/.claudish/config.json`
- **Env var**: `CLAUDISH_DEFAULT_PROVIDER=openrouter`
- **CLI flag**: `claudish --default-provider openrouter "task"`

**Precedence** (highest to lowest):
1. CLI flag `--default-provider`
2. `CLAUDISH_DEFAULT_PROVIDER` env var
3. `defaultProvider` in config file
4. `OPENROUTER_API_KEY` present → `"openrouter"`
5. Hardcoded `"openrouter"`

**Example config**:
```json
{
  "defaultProvider": "openrouter",
  "customEndpoints": { ... }
}
```

Valid values: any built-in provider name (`"openrouter"`, `"openai"`, `"google"`, `"litellm"`, etc.) or a custom endpoint name defined in `customEndpoints`.

**How it interacts with routing rules**: For each bare-name model, `route()` matches against the rules table, builds the candidate chain, then **appends `defaultProvider` to the end** if it isn't already in the chain (deduped against shortcuts — `or` and `openrouter` are treated as the same provider). The combined chain is then credential-filtered. Explicit `provider@model` specs are not affected — `defaultProvider` only applies to bare names.

**No more LiteLLM auto-promotion** (removed in commit 5 of the model-catalog and routing redesign): Setting `LITELLM_BASE_URL` + `LITELLM_API_KEY` no longer makes LiteLLM the default. Users who want LiteLLM as the catch-all must set `defaultProvider: "litellm"` explicitly.

## Vendor Prefix Auto-Resolution (ModelCatalogResolver)

API aggregators (OpenRouter, LiteLLM) require vendor-prefixed model names that users shouldn't need to know. The `ModelCatalogResolver` interface searches each aggregator's dynamic model catalog to find the correct prefix automatically.

**How it works**: User types bare model name → resolver searches the provider's already-fetched model list → finds the exact match with vendor prefix → sends the prefixed name to the API.

**Current resolvers**:
- **OpenRouter**: `or@qwen3-coder-next` → searches catalog → sends `qwen/qwen3-coder-next`
- **LiteLLM**: `ll@gpt-4o` → searches model groups → finds `openai/gpt-4o` (prefix-strip match)
- **Static fallback**: `OPENROUTER_VENDOR_MAP` for cold starts when catalog isn't loaded yet

**Key design rules**:
- Exact match only — no fuzzy/normalized matching. Find the right prefix, don't guess the model.
- Dynamic catalogs (from provider APIs) are PRIMARY. Static map is cold-start fallback only.
- Resolution happens BEFORE handler construction (in `proxy-server.ts`), not inside adapters.
- Sync entry point (`resolveModelNameSync()`) — uses in-memory caches + `readFileSync`, no async propagation.

**Firebase slim catalog** (v7.0.0+): The `aggregators[]` field on model documents provides a typed multi-provider routing index. Each entry is `{ provider, externalId, confidence }`. Claudish only consumes this hosted catalog at runtime. Catalog extraction, recommendation generation, portal hosting, and API documentation live in the [models-index](https://github.com/MadAppGang/models-index) repo.

## Runtime subscription routes come from the backend contract

Claudish refreshes the slim model catalog and `queryPlans` together and stores both in
`~/.claudish/all-models.json`. A model's `subscriptionPlans[]` contains canonical commercial
plan IDs such as `kimi-code`; those values are NOT provider names. The client joins each ID to
`queryPlans[].routing.providerUid` before deciding whether a provider serves the model.

Plan absence has two different meanings:

- `modelDiscovery: "catalog"`: the published roster is authoritative, so an absent model is
  dropped from that subscription provider's candidate chain.
- `modelDiscovery: "client"` or `"hybrid"`: the authenticated account may reveal models the
  public backend cannot know, so absence remains unknown and the candidate is retained. Devin,
  Antigravity, and the `xai-supergrok` plan use this account-scoped behavior.

The backend recommendation document supplies `routingProvider`, `tier`, and an exact `command`
for each callable route. Claudish turns those rows into exact-model routing rules, orders them by
`tier` (`native` before `general`, `metered`, and `aggregator`), and places them ahead of bundled
defaults. `DEFAULT_ROUTING_RULES` remain the cold-cache and uncovered-model fallback. Global and
local user routing config still overlay both backend and bundled rules with the existing
exact-key merge semantics; an exact backend model route is replaced by a user rule for that same
model ID.

If `queryPlans` cannot refresh, the model refresh still succeeds and the last-known-good plan
cache is preserved. Old cache files without a plan snapshot retain their legacy behavior until a
successful refresh.

**Adding a new aggregator resolver**: Implement `ModelCatalogResolver` interface in `providers/catalog-resolvers/`, register in `model-catalog-resolver.ts`. No changes to proxy-server or provider-resolver needed.

**Architecture doc**: `ai-docs/sessions/dev-arch-20260305-104836-a48a463d/architecture.md` (write-up lost — predates the ai-docs tracking fix)

## The interactive picker roster is DERIVED — never add a membership table

Bare `claudish` shows "Select provider:" from `model-selector.ts`. That list used to be a
hand-written `ALL_PROVIDER_CHOICES` array, so **membership was opt-in and a new provider
defaulted to invisible**. `devin` and `antigravity` were both fully working — routing,
`--probe`, and the config TUI (which has always derived its list from `getAllProviders()`) —
while absent from the picker. `3a293b9` even built Antigravity's correct 20-model roster for
a provider the picker could not offer.

The v7389502 credential refactor is the trap here: it unified availability **checking** (it
deleted the three duplicate readiness oracles) and left the **roster** alone. Unifying how a
list is filtered is not the same as unifying what is in it.

- `isPickableProvider(def)` = `def.shortcuts.length > 0`. A definition with no shortcuts has
  no user-typeable `@` prefix and exists only so `nativeModelPatterns` can steer a BARE name;
  `qwen` and `native-anthropic` are the two, and both carry an empty `baseUrl`/`apiPath`.
  A rule, not a roster — there is no exclusion list to keep current.
- `PICKER_COPY` and `PICKER_ORDER` are **editorial only**: labels and ordering. Anything
  unlisted still appears, at the end. Never use either as a membership gate.
- The `@prefix` filter aliases (`getProviderFilterAliases`) are derived the same way, from
  each definition's name + `shortcuts`, because that table had drifted identically — `@dv`
  matched nothing. Alias insertion order follows `PICKER_ORDER` so an ambiguous partial like
  `@op` resolves to the first row the user actually sees (OpenRouter).
- The emitted prefix comes from `shortestPrefix`; `PROVIDER_MODEL_PREFIX_OVERRIDE` holds only
  four readability aliases. The danger the old map created was returning **undefined**, which
  makes `buildExplicitModelSpec` hand back a BARE id — for Devin that is
  `claude-opus-5-medium`, which matches native-anthropic's `/^claude-/i` and is answered by a
  different provider entirely. (`parseModelSpec` passes an unrecognized prefix through
  verbatim — `model-parser.ts:160` — so a canonical NAME also resolves; assert the parser
  round-trip, not membership in `shortcuts`.)

The drift test is `buildProviderChoices()` ⊇ every pickable builtin. It asserts CONTAINMENT,
not equality: runtime custom endpoints legitimately appear too (a real gain — the old array
could never show one), so equality made the test order-dependent on whichever sibling test
file had registered one.

**`config-command.ts` was deleted in v7.64.0 — 809 lines of dead code holding a fourth
hand-written provider table.** `configCommand` was exported and imported nowhere;
`claudish config` has gone to `startConfigTui()` for a long time. The table listed `baseUrl`,
`endpointEnvVar` and `keyUrl` per provider, i.e. exactly the data the catalog owns.

What makes it worth recording rather than just deleting: it was **actively maintained while
dead**. The light-theme sweep (`c9cb626`) restyled it and a MiniMax endpoint fix (`b7173d2`)
corrected its hostname — two people paid to keep a table current that no code could read. A
dead hand-written roster is worse than a live one, because nothing can ever prove it wrong.
Check for importers before restyling a file.

## Subscription pricing is decided by BILLING, not by `modelDiscovery`

`SUBSCRIPTION_PROVIDERS` (`handlers/shared/remote-provider-types.ts`) drives both the picker's
`SUB` label and `getModelPricing`'s zero-cost verdict, so a missing entry quotes a flat-rate
user a per-token rate they do not pay — and TokenTracker then accrues fictional spend.

Two paths render a price and only one used to ask the question: a provider WITH
`modelDiscovery` goes through `buildDiscoveredModelRows` (which asks), everything else goes
through `resolveProviderDisplayPrice` (which did not). That is why a missing entry was
invisible on one path and merely wrong on the other. `resolveProviderDisplayPrice` now checks
`isSubscriptionProvider` FIRST, ahead of both the aggregator and model-level rates.

Found by that audit and added: `antigravity` (was N/A) and `sakana-subscription`, alongside
the already-listed `minimax-coding` / `glm-coding`, which were quoting their metered
siblings' dollar rates. When adding a provider, ask "does the user pay per token?", not
"does it declare discovery?".

**`openai-codex` is decided by the CREDENTIAL, not by the name**, and that is the tier the
whole `SUBSCRIPTION_PROVIDERS` design could not express. It was once added to the name set —
its picker row literally says "ChatGPT Plus/Pro subscription" — and a multi-model review
reverted it, on this reasoning: `apiKeyAliases: ["OPENAI_API_KEY"]` means a plain metered key
authenticates `cx@` just as well. **That premise is false at sign time, and a checked-in test
says so.** `authority.ts:157` registers the Codex composite BEFORE the generic provider loop
and `:192-205` blocks the generic `ApiKeyCredentialProvider` from claiming the name, so the
provider that would have been built with `aliases: def.apiKeyAliases` is never built for
`openai-codex`; the composite's own fallback declares no aliases at all
(`codex-credential.ts:79-82`). `auth/credentials/equivalence.test.ts:302-305` —
*"OPENAI_API_KEY alias alone → false (excluded)"* — asserts it. The alias survives only in
display and hint code (`tui/providers.ts`, `keychain-command.ts`, `getApiKeyInfo`), which is
its own cosmetic bug: the config TUI shows `cx@` as key-configured from a key that cannot
sign it.

The real dual mode is **two hosts**, which is a code fact rather than an inference: OAuth
(`codex-oauth.json`) signs `chatgpt.com/backend-api/codex/responses`
(`codex-credential.ts:17`, `:54`), while `OPENAI_CODEX_API_KEY` signs
`api.openai.com/v1/responses` (`provider-definitions.ts:408`, `:410`), and
`transport/openai-codex.ts:11-15` documents that OAuth tokens do not work against
`api.openai.com` at all. Whether that second host bills per token was inferred until
**2026-09-02, when it was measured**: a platform key against exactly that host and path
returns `200` with `"billing": {"payer": "developer"}` in the response body — the endpoint
names the payer itself, and it is the key holder, not a ChatGPT plan
(`ai-docs/reports/data/measurements-20260902.txt`). One 200 does not prove every account type
answers the same way, so the probe's metered-by-default shape is unchanged; it is now backed
by a measurement instead of by the host name.

**The two errors are not symmetric**: quoting a dollar rate to a subscriber is a cosmetic
over-estimate, while reporting `SUB` (and zero accrued cost) to someone OpenAI is metering
silently under-reports real money. So the answer comes from a probe registered by the auth
layer (`auth/credentials/billing-probe.ts`, installed only as a side effect of importing
`auth/credentials/authority.ts`), and every uncertainty resolves toward **metered**:

- The transport records which arm actually signed (`transport/openai-codex.ts` calls
  `recordSignedArm` at the end of `refreshAuth`). That record is read FIRST, because
  `refreshAuth` catches every failure and falls through to the plain api-key path — so
  "OAuth present, api-key signing" is reachable per request whenever a token refresh fails.
- Before any request has been signed, the probe answers "which credential WOULD sign" with
  `CodexOAuth.getInstance().hasCredentials()` — the same predicate the composite uses to pick
  its primary (`composite-credential.ts:50` → `codex-credential.ts:45-47`). **Never**
  `hasOAuthCredentials` or `describeSourceSync`: both return true for an `access_token` with
  an unexpired `expires_at` and no `refresh_token` (`oauth-registry.ts:88-97`), a state where
  `hasCredentials()` is false and the API key signs.
- Unregistered probe ⇒ metered. Safe as money; the cost is one suppressed cost warning at
  `routing-rules.ts:413`.

`antigravity` (no `apiKeyEnvVar` at all) and `sakana-subscription` (which deliberately does
not alias the PAYG `SAKANA_API_KEY`) have no such ambiguity, which is why they sit in the
plain name set. Adding `openai-codex` to that set as well would short-circuit the probe and
report `SUB` to every API-key user — do not.
