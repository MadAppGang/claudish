# Backend task: a maintained alias registry

**For:** the models-index backend developer
**From:** claudish, 2026-09-04
**Status:** requested, not started
**Measured against:** `~/.claudish/all-models.json` as served 2026-09-03

## The problem

Every provider names the same model differently, and subscription providers are
the worst offenders because their names are product names rather than model
names:

```
kimi-k3          openrouter  = moonshotai/kimi-k3
                 together-ai = moonshotai/Kimi-K3
                 fireworks   = accounts/fireworks/models/kimi-k3
                 ollamacloud = kimi-k3:cloud
                 kimi-coding = k3                    <- the subscription

kimi-k2.7-code   kimi-coding = kimi-for-coding       <- unguessable
```

`kimi-for-coding` cannot be derived from `kimi-k2.7-code` by any rule. Somebody
has to write it down. That is what this task is for.

## What already exists, and works

`aggregators[].externalId` **is** the alias registry. The `kimi-for-coding`
mapping above is already in it and is already correct. claudish consumes it
through `resolveExternalId`.

So this is not a request for a new mechanism. It is a request for **coverage and
a maintenance process** on the mechanism that exists.

## What is missing

**Subscription providers are under-covered.** The catalog's aggregator vocabulary
names 18 providers. claudish routes to 33. The ones it never mentions are almost
entirely the subscription providers — `glm-coding`, `minimax-coding`,
`qwen-cloud`, `sakana-subscription`, `devin`, `opencode-zen-go`,
`grok-subscription`, `antigravity`.

That is understandable — an aggregator row describes a marketplace listing, and a
plan's contents are an entitlement. But the aliases are needed all the same, and
`aggregators[]` is where the other ones live.

**Concretely missing today:**

| provider | what claudish needs |
|---|---|
| `antigravity` | serves effort-suffixed ids (`gemini-3.6-flash-high`). None are in the catalog; `gemini-3.6-flash` has `routeVariant: none`. |
| `grok-subscription` | account-specific roster, no aliases recorded at all |
| `devin` | re-serves other vendors' models under colliding uids (`claude-opus-5-high`, `glm-5-2`). These are the highest-risk aliases in the system: guessed wrong, they answer as the wrong vendor. |
| `glm-coding`, `minimax-coding`, `qwen-cloud` | no aggregator rows |

## What to add

For each subscription provider, an `aggregators[]` row on the models it serves,
carrying `provider` and `externalId` — the same shape already used. No new field
is required.

Where a model is a variant of another (an effort tier, a context size), also set
`routeVariant`, which already exists and already models exactly this:

```json
"routeVariant": { "baseModelId": "kimi-k3", "familyId": "kimi-k3",
                  "provider": "kimi-coding", "isDefault": false }
```

There are **6 such rows across 737 entries** today. `kimi-k3-256k` has one;
antigravity's effort tiers have none.

## What claudish will do for the remainder

The registry will never be complete, because a provider can change an alias
without notice. claudish will run a matcher for anything the registry does not
cover, and the manual registry **always wins** where it has an entry.

The matcher is measured, not aspirational. Evaluated against the 705 non-trivial
`(externalId -> modelId)` pairs already in the catalog:

| outcome | rate |
|---|---|
| recovered correctly | **85.1%** |
| wrong model | **0.1%** |
| declined, no match | 14.8% |

Rules: normalize case and separators; strip variant suffixes but never add them;
`glm-5-2` <-> `glm-5.2`; re-attach a stripped vendor token (`k3` -> `kimi-k3`);
refuse anything ending in `latest`, because a pointer is not a name.

It is tuned so that failure means declining, not guessing — a decline costs
metadata, a wrong match sends the request to a different model.

**What that means for you.** You do not have to reach 100%. Prioritise:

1. **`devin` first.** Its aliases collide with other vendors' namespaces, so a
   wrong guess answers as the wrong vendor. The matcher declines rather than
   guesses, but that means Devin models stay unenriched until you record them.
2. **`antigravity` and `grok-subscription` next.** Their rosters are
   account-specific, so claudish must probe them live. The registry is what lets
   claudish translate what the probe returns into catalog models.
3. Everything else is opportunistic — the matcher handles the ordinary shapes.

## A second ask, small

`includedModels` is currently a mixed vocabulary: model ids
(`claude-opus-5`), display names (`Gemini 3.6 Flash`, `Claude Opus 4.6
(thinking)`), prose (`account-specific Grok subscription roster`), and provider
wire ids (`k3`, `kimi-for-coding`). Measured over the 12 plans carrying a
`routing` block: 59% match a model id exactly, 74% after normalizing, 26% do not
resolve at all.

claudish will use `entry.subscriptionPlans` as the authoritative join and treat
`includedModels` as a secondary signal, so this is not blocking. But if
`includedModels` could carry model ids with the display text in a separate field,
it would become usable rather than advisory.

## Validation

Aliases drift. Whatever cadence suits you, a periodic check that every
`externalId` recorded for a provider still appears in that provider's live roster
would catch the drift before a user does. claudish cannot do this centrally — it
only sees the providers a given user has credentials for.

## References

- Matcher design and full measurement:
  `ai-docs/reports/routing-refactor-investigation-20260903.md` §1
- The `routing` block gap on 7 of 19 plans, filed separately:
  `ai-docs/reports/BACKEND_missing_routing_block_on_plans-20260903.md`
