# Routing refactor: gate measurement

Part B of the catalog-driven routing work. **Design validated, not implemented.**
Measured against `~/.claudish/all-models.json` (737 entries, 19 plans) on
2026-09-03.

Design: `routing-from-the-catalog-alone-20260903.md`.

## What was built

A pure derivation of the four-tier chain from the catalog alone:

```
0  own vendor subscription   plan.routing.nativeModelProviders ∩ api_official ≠ ∅
1  other subscriptions       plans covering the model
2  native API                aggregators where confidence == "api_official"
3  everything else           remaining aggregator rows
```

It works. Spot-checked chains are right:

```
kimi-k3          0 kimi-coding@k3   1 ollamacloud  1 opencode-zen-go  3 openrouter
glm-5.3          0 glm-coding       1 ollamacloud  1 opencode-zen-go  2 z-ai  3 openrouter
claude-opus-5    0 native-anthropic                                   3 openrouter
minimax-m3       0 minimax-coding   1 ollamacloud  1 opencode-zen-go  2 minimax
```

`ollamacloud` appears on models no hand-written rule mentions — a real gain.

## The gate, over all 737 entries

With an unconditional `openrouter` last entry (see blocker 4):

| outcome | count |
|---|---|
| identical provider set | 332 |
| gained a provider | 213 |
| lost only a dynamic-plan uid | 35 |
| **lost a non-dynamic provider** | **202** |

Without the unconditional openrouter the last figure is 440, because 341 of 737
entries have no `openrouter` aggregator row while today's `"*"` catch-all hands
openrouter to everything.

The 202 are dominated by `opencode-zen-go` leaving models the `opencode-go` plan
does not list. That is very likely correct — `default-routing-rules.ts` predicted
it: *"the catalog join now drops known-unserved Go models"*. But **each one still
needs a human decision**, and that review has not happened.

## Four blockers

**1. Dynamic plans are not derivable. The runtime probe is mandatory.**

`grok-4.6` derives with no `grok-subscription`, and `gemini-3.6-flash` with no
`antigravity`. Both plans are `modelDiscovery: client`, and `xai-supergrok`'s
`includedModels` is the literal string `"account-specific Grok subscription
roster"` — prose, by design, because the roster is per-account. Tier 0 for
`client` and `hybrid` plans can only come from a credentialed probe at runtime.
Not built.

**2. `includedModels` cannot be matched programmatically.**

It is a mixed vocabulary:

```
claude-opus-5                              model id
Claude Opus 4.6 (thinking)                 display name
account-specific Grok subscription roster  prose
deepseek-v4-pro:cloud                      provider-suffixed id
```

Membership must come from `entry.subscriptionPlans`, the backend's own join.
Matching `includedModels` silently fails for Gemini (`Gemini 3.6 Flash` vs
`gemini-3.6-flash`) while appearing to work for GLM (`GLM-5.3` vs `glm-5.3`),
which is the worst kind of failure.

**3. The aggregator-slug map is incomplete.**

`FIREBASE_SLUG_TO_PROVIDER_NAME` (`model-loader.ts:281`) covers 10 slugs and was
built for the recommended-models doc. The catalog's aggregator vocabulary has 18
providers, and the map lacks `anthropic`, `openrouter`, `together-ai`,
`fireworks`, `ollamacloud`, `opencode-zen`. Adding the obvious ones moved the
gate only 447 → 440, so this is necessary but not the main cost.

Related and harder: **`native-anthropic` has two roles.** It is both the
`anthropic-claude-code` plan's `routing.providerUid` and claudish's metered
Anthropic API provider. Deriving it from plan membership alone loses the metered
path — visible as `claude-haiku-3` losing `native-anthropic` in the table.

**4. The `"*"` catch-all is a real decision, not an implementation detail.**

Keeping `openrouter` unconditionally recovers 341 losses and preserves today's
behaviour. Trusting the catalog instead is arguably more honest — it stops
claiming a route that does not exist — but it is a large behaviour change and it
makes a cold cache produce very short chains. Measured both ways above; not
decided.

## Recommendation

The design is sound and the derivation is proven. What remains is not
design work:

1. build the runtime probe for `client`/`hybrid` plans (blocker 1);
2. complete the slug map and resolve `native-anthropic`'s dual role (blocker 3);
3. decide the catch-all (blocker 4);
4. hand-review all 202 non-dynamic losses.

Step 4 is the real cost and it cannot be automated — it is exactly the review
that v9.0.1 skipped. This should be its own session with the route table as the
working document, not tacked onto a hotfix run.

## Scripts

Kept out of tree deliberately (they read the live cache and print only):
`derive.ts`, `route-table.ts` in the session scratchpad. Both are ~100 lines and
trivially rebuilt from this document.
