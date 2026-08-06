# models-index data gap — the OpenCode Zen Go plan is not in the catalog

**Status:** open, filed 2026-08-06
**Repo that owns the fix:** [models-index](https://github.com/MadAppGang/models-index)
**Claudish side:** no change needed when this lands — see "What changes when fixed".

## Summary

Claudish routes to a subscription plan called `opencode-zen-go` (`zgo@`), which serves
25 models across the kimi, glm, minimax, deepseek, qwen, mimo, hy3, gpt and grok
families. The hosted slim catalog knows nothing about it:

- `subscriptionPlans[]` across all 502 catalog entries contains only
  `alibaba-token-plan-individual`, `alibaba-token-plan-team-edition` and
  `kimi-coding`. `opencode-zen-go` never appears.
- `aggregators[]` carries `opencode-zen` entries (the metered Zen product) but no
  `opencode-zen-go` entries.

The two are different providers in claudish, with different base URLs, different
credentials and different billing:

| claudish provider | prefix | base URL | billing |
| --- | --- | --- | --- |
| `opencode-zen` | `zen@` | `opencode.ai/zen` | metered |
| `opencode-zen-go` | `zgo@` | `opencode.ai/zen/go` | **subscription** |

## Why it matters

`resolveSubscriptionRouting()` (`packages/cli/src/adapters/model-catalog.ts`) decides
whether a subscription candidate can serve a model purely from catalog data. With no
`subscriptionPlans` entry for the Go plan, `isSubscriptionPlan("opencode-zen-go")` is
false, so the function returns `unknown` and the candidate is kept for **every** model
in a family — including the ones the plan does not serve.

Claudish ships that way deliberately (routing chains updated 2026-08-06) because Zen Go
degrades safely: an unserved model returns **401** `{"type":"ModelError","message":"Model
X is not supported"}`, which is retryable, so the chain falls through to the metered
provider. The cost is one wasted round-trip per miss, not a failed request.

But that is a workaround for missing data, not the intended design. With correct catalog
data the candidate would be dropped before any request, and the wasted round-trip
disappears.

## Evidence

`GET https://opencode.ai/zen/go/v1/models` (2026-08-06) returns 25 models:

```
deepseek-v4-flash   deepseek-v4-pro   glm-5        glm-5.1      glm-5.2
gpt-5.6-luna        grok-4.5          hy3          hy3-preview  kimi-k2.5
kimi-k2.6           kimi-k2.7-code    kimi-k3      mimo-v2-omni mimo-v2-pro
mimo-v2.5           mimo-v2.5-pro     minimax-m2.5 minimax-m2.7 minimax-m3
qwen3.5-plus        qwen3.6-plus      qwen3.7-max  qwen3.7-plus qwen3.8-max
```

Unserved-model behaviour, verified live against five ids the plan does not carry
(`kimi-k2.7`, `glm-4.6`, `minimax-m2`, `deepseek-v3.2`, and a nonsense id):

```
401  {"type":"error","error":{"type":"ModelError","message":"Model <id> is not supported"}}
```

Catalog state for a representative model (`kimi-k3`):

```
subscriptionPlans: ["kimi-coding"]
aggregators:       openrouter:moonshotai/kimi-k3, together-ai:moonshotai/Kimi-K3,
                   fireworks:accounts/fireworks/models/kimi-k3, opencode-zen:kimi-k3,
                   moonshotai:kimi-k3, kimi-coding:k3
                   ^^ no opencode-zen-go entry
```

## Requested change

For each of the 25 models above, add to the catalog entry:

1. `"opencode-zen-go"` in `subscriptionPlans[]`.
2. An `aggregators[]` entry `{ provider: "opencode-zen-go", externalId: "<wire id>",
   confidence: … }`.

The wire ids are the plain ids in the list above — Zen Go accepts the same names the
catalog uses (`kimi-k3`, `glm-5.2`, `qwen3.8-max`), so `externalId` equals `modelId`
for every one of them. That is worth stating explicitly because it differs from
`kimi-coding`, whose wire id for `kimi-k3` is the bare `k3`.

## What changes when fixed

Nothing in claudish. `resolveSubscriptionRouting` starts returning `serves` /
`not-served` instead of `unknown`, non-serving candidates are dropped before a request
is made, and the wasted 401 round-trip goes away on its own. The routing chains in
`default-routing-rules.ts` already name `opencode-zen-go` and need no edit; the comment
block there ("Zen Go placement") records this dependency.

## Related

`docs/specs/behavior-telemetry-backend.md` — the other backend-facing contract doc.
