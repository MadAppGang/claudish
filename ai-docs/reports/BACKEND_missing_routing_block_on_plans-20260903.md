# Backend request: plans without a `routing` block are invisible, and they poison their siblings

> **SUPERSEDED 2026-09-04 by `BACKEND_TASKS-20260904.md`.** That document carries
> this content as items 1 and 3, alongside everything else claudish needs, in
> priority order. Send the backend developer that one file, not this one. This is
> kept only as the record of what shipped with v9.0.4.

**For:** the models-index backend developer
**From:** claudish, 2026-09-03
**Cache measured:** `~/.claudish/all-models.json`, `lastUpdated` as served on 2026-09-03

## Summary

Seven of nineteen plans in `/queryPlans` carry no `routing` block. claudish skips
those plans entirely, which is correct and expected. The problem is the side
effect: a skipped plan's **siblings** can still make claudish believe it has a
complete view of that vendor, so a model covered only by the skipped plan is
declared not-served and the user is moved off a subscription they pay for.

claudish has shipped a client-side guard for this in v9.0.4 (it now withholds the
`not-served` verdict when a same-vendor plan is unroutable). That guard trades
precision for safety — it keeps candidates that may genuinely not be served. The
proper fix is on the data side.

## Plans with no `routing` block

```
alibaba-ai-coding-plan            provider=alibaba      included=9
byteplus-modelark-coding-plan     provider=bytedance    included=5
github-copilot                    provider=github       included=32
llm-gateway-devpass               provider=llm-gateway  included=11
mistral-vibe                      provider=mistralai    included=2
routing-run                       provider=routing-run  included=14
streamlake-kwaikat-coding-plan    provider=streamlake   included=1
```

Twelve plans do have one, and those map cleanly onto claudish's provider uids —
`qwen-cloud/qc`, `antigravity/ag`, `kimi-coding/kc`, `opencode-zen-go/zgo`,
`grok-subscription/gk`, `glm-coding/gc`, `devin/dv`, `openai-codex/cx`,
`minimax-coding/mmc`, `ollamacloud/oc`, `native-anthropic`. That part of the
contract works well.

## The concrete failure

`alibaba-ai-coding-plan` is the case that costs money today.

```
alibaba-ai-coding-plan           routing=MISSING      modelDiscovery=unset
  includedModels: qwen3.7-plus, qwen3.6-plus, qwen3.5-plus, kimi-k2.5, glm-5,
                  MiniMax-M2.5, qwen3-max-2026-01-23, qwen3-coder-next,
                  qwen3-coder-plus

alibaba-token-plan-individual    routing.providerUid=qwen-cloud   modelDiscovery=catalog
alibaba-token-plan-team-edition  routing.providerUid=qwen-cloud   modelDiscovery=catalog
```

All three have `provider: "alibaba"`. Only the last two are visible to claudish.
Because those two publish membership rows, claudish concluded that `qwen-cloud`'s
roster was fully published, and therefore that a model absent from them is not in
any Alibaba plan.

Measured, with the v9.0.4 guard disabled:

```
model                verdict(qwen-cloud)   resulting chain
qwen3.5-plus         not-served            zengo@qwen3.5-plus, qp@qwen3.5-plus, qwen3.5-plus
qwen3.7-flash        not-served            qp@qwen3.7-flash, qwen/qwen3.7-flash
qwen3.6-max-preview  not-served            qp@qwen3.6-max-preview, qwen/qwen3.6-max-preview
```

`qwen3.5-plus` is in `alibaba-ai-coding-plan`'s own `includedModels`. A user
holding that plan lost `qc@` from the chain and was billed per token by
`qwen-payg`.

## What we would like

1. **A `routing` block on every plan you publish**, or an explicit marker meaning
   "no client route exists for this plan". Today absence is ambiguous: it could
   mean "no route" or "not filled in yet", and claudish cannot tell them apart.
2. **A `modelDiscovery` value on every plan.** Seven are `unset`.
   `alibaba-ai-coding-plan` is one, so even with a routing block claudish would
   not know whether its `includedModels` is authoritative.
3. If `alibaba-ai-coding-plan` should route through `qwen-cloud` like its
   siblings, `routing.providerUid: "qwen-cloud"` plus
   `nativeModelProviders: ["qwen"]` would resolve this specific case.

## A separate data question, not a bug report

`z-ai-glm-coding-plan` declares `modelDiscovery: catalog` with
`includedModels: GLM-5.3, GLM-5.3-Flash`. Because that is marked authoritative,
claudish correctly drops `glm-coding` from the chain for `glm-4.5`, `glm-4.6` and
`glm-4.7`.

Is that right? If the Z.ai GLM Coding Plan still serves the 4.x line, the
`includedModels` list is short and those users are being billed per token. If the
plan genuinely covers only 5.3, no action is needed and claudish is behaving
correctly. We cannot tell from the client.

The same question applies to `openai-codex`, which declares six included models
and does not list `gpt-5`.

## Reference

Client-side analysis: `ai-docs/reports/subscription-deleted-on-catalog-silence-20260903.md`.
The v9.0.4 guard lives in `packages/cli/src/adapters/model-catalog.ts`,
`resolveSubscriptionRouting`.
