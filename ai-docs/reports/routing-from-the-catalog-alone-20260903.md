# Routing from the catalog alone

Design note. Measured against `~/.claudish/all-models.json` on 2026-09-03.

## The task

Route a model to **subscriptions first, then the vendor's own API, then a
fallback.** Five complications:

1. the user holds their own subset of subscriptions;
2. some subscriptions are dynamic — their model list is per-account;
3. one model has different names at different providers;
4. one model can appear as several effort-level entries at one provider;
5. the user must be able to rewrite the rules.

## The claim

**No hand-written routing data is required.** The catalog publishes everything,
including the two providers previously believed to be unpublishable local
knowledge.

## What the catalog carries

`.plans[]` — one row per subscription:

```json
"xai-supergrok": {
  "provider": "x-ai",
  "modelDiscovery": "client",
  "routing": { "providerUid": "grok-subscription", "prefix": "gk",
               "nativeModelProviders": ["x-ai"] },
  "includedModels": ["account-specific Grok subscription roster"]
}
```

- `routing.providerUid` and `routing.prefix` are claudish's own vocabulary,
  published by the backend. No local mapping table.
- `routing.nativeModelProviders` declares the native tier. Not inferred.
- `modelDiscovery` declares whether the model list is static or must be probed.
- A plan with no `routing` block is one claudish does not implement — skip it.

Measured discovery modes over 19 plans: **7 `catalog`** (static list is
authoritative), **3 `client`** (must probe: `cognition-devin`,
`google-antigravity`, `xai-supergrok`), **2 `hybrid`**, 7 with no routing block.

`.entries[].aggregators[]` — one row per serving provider:

```json
{ "provider": "kimi-coding", "externalId": "k3",
  "confidence": "scrape_verified",
  "contextWindowVariesBySubscription": true,
  "discovery": { "endpoint": "https://api.kimi.com/coding/v1/models", "...": "..." } }
```

- `externalId` is complication 3, solved per provider
  (`moonshotai/Kimi-K3`, `accounts/fireworks/models/kimi-k3`, `k3`, `kimi-k3:cloud`).
- `confidence: "api_official"` marks the vendor's own API. Verified on
  `claude-opus-5 -> anthropic`, `deepseek-v4-pro -> deepseek`,
  `glm-5.3 -> z-ai`, `grok-4.6 -> x-ai`.

## The algorithm

```
chain(model):
  if userRules matches model: return that chain verbatim      # complication 5

  native  = aggregators.where(confidence == "api_official").providers

  plans   = catalog.plans.where(p => p.routing != null)
  covers  = p => p.modelDiscovery == "catalog"
                   ? p.includedModels covers model
                   : probe(p.routing.providerUid) serves model     # complication 2
  subs    = plans.where(covers)

  # tier 0 vs 1 — is this the model's OWN vendor's plan?
  own     = subs.where(p => p.routing.nativeModelProviders ∩ native ≠ ∅)
  other   = subs - own

  rest    = aggregators.providers - subs - native

  chain = [...own, ...other, ...native, ...rest]
  chain = chain.filter(hasCredential)                          # complication 1
  return chain.map(p => [p, aggregators.externalIdFor(model, p)])   # complication 3
```

Complication 4 (effort levels as separate entries) is handled where it already
is: the per-account roster returned by the `client`/`hybrid` probe lists
`gemini-3.6-flash-high` and friends, and the transport family-matches against it.

## Traced: grok-4.6

| tier | result | source |
|---|---|---|
| 0 own vendor sub | `grok-subscription` | `xai-supergrok`, `nativeModelProviders: ["x-ai"]` ∩ `api_official: x-ai` |
| 1 other sub | `opencode-zen-go` | `opencode-go`, `modelDiscovery: catalog`, includes grok-4.6, `nativeModelProviders: []` |
| 2 native | `x-ai` | `api_official` |
| 3 rest | `openrouter` | remaining aggregator row |

Result `[grok-subscription, opencode-zen-go, x-ai, openrouter]`, against today's
hand-written `[grok-subscription, x-ai, openrouter]`. Nothing lost, `opencode-zen-go`
gained.

## Tier 0: the model's own vendor plan

A plan is the model's OWN vendor plan when
`plan.routing.nativeModelProviders` intersects the model's `api_official`
providers. Verified over the whole plans table:

| model | `api_official` | plan | `nativeModelProviders` | own |
|---|---|---|---|---|
| grok-4.6 | x-ai | xai-supergrok | x-ai | yes |
| claude-opus-5 | anthropic | anthropic-claude-code | anthropic | yes |
| gemini-3.6-flash | google | google-antigravity | google | yes |
| gpt-5.6-sol | openai | openai-codex | openai | yes |
| kimi-k3 | moonshotai | kimi-code | moonshotai | yes |
| glm-5.3 | z-ai | z-ai-glm-coding-plan | z-ai | yes |
| minimax-m3 | minimax | minimax-token-plan | minimax | yes |
| qwen3.8-max | qwen | alibaba-token-plan-* | qwen | yes |
| any | — | opencode-go, ollama-cloud | *(empty)* | no |
| claude-opus-5 | anthropic | cognition-devin | cognition | no |

8/8 vendor plans match, 2/2 gateways are empty, and Devin matches nothing —
correct, because Devin re-serves other vendors' models.

Use `nativeModelProviders`, never `plan.provider`. The Alibaba row is the proof:
the plan's provider is `alibaba` while the model's vendor is `qwen`, so a
plan-name comparison would classify it wrongly.

Because tier 0 is decided by vendor identity, `modelDiscovery` no longer affects
order at all. It only decides HOW membership is learned — a static list or a
probe.

## Two corrections to earlier analysis in this session

**`grok-subscription` and `antigravity` are published.** Earlier in this session
I stated they were local knowledge the backend cannot publish. They are in
`.plans[]` as `xai-supergrok` and `google-antigravity`, with full `routing`
blocks. They were absent from the 34-model editorial doc that v9.0.1 read, which
is a different file.

**A local per-provider `tier` column is unnecessary.** An earlier draft of this
design kept one. `routing.nativeModelProviders` plus `confidence: api_official`
supply it from the remote.

## Why v9.0.1 produced one-item chains

`buildCatalogRoutingRules` reads `recommended-models-cache.json`, a **34-model
editorial list**, not `all-models.json` with its 739 entries and 19 plans. The
recommendations doc was used as the serving graph.

## Resolved: subscription ordering

An earlier draft ordered subscriptions static-then-dynamic, which demoted a
SuperGrok holder to OpenCode Go. The `nativeModelProviders ∩ api_official` test
above replaces that with vendor identity, so the vendor's own plan leads and no
trade-off remains.

## What this deletes

- `default-routing-rules.ts` entirely, 254 lines.
- `buildCatalogRoutingRules`, `retainKnownCatalogRoutingRules`, and the
  four-source `mergeRoutingRules`.
- The exact-key-beats-glob hazard: only the user's dictionary is ever matched.
- The `opencode-zen-go` hand-insertion into seven chains, and the ~40 lines of
  comment defending it. `includedModels` answers what that comment argued about.

## Risks

1. **Order within the fallback tier is unspecified.** `together-ai`, `fireworks`
   and `openrouter` all serve kimi-k3. `aggregators[].pricing` is present on most
   rows and is the obvious tiebreak.
2. **Cold cache yields no chain.** Needs a seed snapshot, or an unconditional
   `openrouter` last entry.
3. **59% of entries (434/739) have no `api_official` row.** For those the native
   tier is empty, which is correct — they exist only on aggregators — but it means
   `api_official` cannot be the sole tier signal. `nativeModelProviders` is.
4. **Every bare-name route changes.** The gate is a before/after route table over
   every model id in the cache, reviewed by hand. No removals without a reason.
5. **The Devin invariant loses its current enforcement.** CLAUDE.md requires that
   no colliding bare name reaches Devin, because Devin re-serves other vendors'
   models under uids like `claude-opus-5-high` that match those vendors' patterns.
   Today that is enforced structurally: no routing rule names `devin`. Under this
   design `cognition-devin` is a plan like any other, entering tier 1 whenever its
   `client` probe reports the model. The tier-0 test keeps it behind Anthropic's
   own plan, but it no longer keeps it out. The probe must be matched on the exact
   wire id, and this needs its own test before the refactor ships.

## Verification

- Pin the current route for every model id in `all-models.json`; diff after.
- Cold-cache run with an empty catalog: every family must still reach a fallback.
- User config: glob rule, exact rule, and `"*": []`, each honoured verbatim.
- `grok-subscription` and `antigravity` must still lead their families under a
  `client` probe.
