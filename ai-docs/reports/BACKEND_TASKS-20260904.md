# models-index: what claudish needs, in priority order

**For:** the models-index backend developer
**From:** claudish, 2026-09-04
**Measured against:** `~/.claudish/all-models.json` as served 2026-09-03
(737 entries, 19 plans, 1112 aggregator rows)

This supersedes `BACKEND_missing_routing_block_on_plans-20260903.md` and
`BACKEND_alias_registry-20260904.md`. Everything needed is inline here; you do
not need to read those.

Items 1–3 cost users money today. Items 4–6 unblock a client refactor. Item 7 is
a nice-to-have.

---

## 1. `alibaba-ai-coding-plan` has no `routing` block, and its siblings poison it

**Cost: real, now.** A holder of Alibaba's $50/month AI Coding Plan is billed per
token for models that plan covers.

```
alibaba-ai-coding-plan           routing = MISSING      modelDiscovery = unset
  includedModels: qwen3.7-plus, qwen3.6-plus, qwen3.5-plus, kimi-k2.5, glm-5,
                  MiniMax-M2.5, qwen3-max-2026-01-23, qwen3-coder-next,
                  qwen3-coder-plus

alibaba-token-plan-individual    routing.providerUid = qwen-cloud   modelDiscovery = catalog
alibaba-token-plan-team-edition  routing.providerUid = qwen-cloud   modelDiscovery = catalog
```

All three carry `provider: "alibaba"`. claudish skips any plan without a
`routing` block, which is correct. The damage is the side effect: the two
siblings DO publish memberships, so claudish concluded `qwen-cloud`'s roster was
fully published and treated a model's absence from them as proof it is in no
Alibaba plan.

Measured, with the client guard disabled:

```
model                verdict(qwen-cloud)   resulting chain
qwen3.5-plus         not-served            zengo@qwen3.5-plus, qp@qwen3.5-plus, ...
qwen3.7-flash        not-served            qp@qwen3.7-flash, qwen/qwen3.7-flash
qwen3.6-max-preview  not-served            qp@qwen3.6-max-preview, ...
```

`qwen3.5-plus` is in `alibaba-ai-coding-plan`'s own `includedModels`. The
subscription was dropped from the chain and the request went to metered
`qwen-payg`.

**Fix:** give it `routing.providerUid: "qwen-cloud"` and
`nativeModelProviders: ["qwen"]`, matching its siblings. Plus a `modelDiscovery`
value.

**Already mitigated client-side in v9.0.4** — claudish now withholds a
"not-served" verdict when a same-vendor plan is unroutable. That guard trades
precision for safety and is not a substitute for the data.

---

## 2. Two plans declare very short `includedModels`. Please confirm they are right

Both are marked `modelDiscovery: catalog`, which tells claudish the list is
authoritative. claudish therefore drops the subscription for anything absent. If
the lists are short because they are incomplete rather than because the plans are
small, users are being billed per token for models they have paid for.

```
z-ai-glm-coding-plan   modelDiscovery = catalog
  includedModels: GLM-5.3, GLM-5.3-Flash

openai-codex           modelDiscovery = catalog
  includedModels: 6 models, gpt-5 NOT among them
```

Consequence today, and claudish believes this is correct behaviour:

```
glm-4.5, glm-4.6, glm-4.7  ->  glm-coding dropped, routed to metered z-ai
gpt-5                      ->  openai-codex dropped, routed to metered openai
```

If the Z.ai GLM Coding Plan still serves the 4.x line, this is item 1 again with
a different vendor. We cannot tell from the client — only you can.

---

## 3. Seven of nineteen plans have no `routing` block

```
alibaba-ai-coding-plan            provider=alibaba      (item 1)
byteplus-modelark-coding-plan     provider=bytedance
github-copilot                    provider=github
llm-gateway-devpass               provider=llm-gateway
mistral-vibe                      provider=mistralai
routing-run                       provider=routing-run
streamlake-kwaikat-coding-plan    provider=streamlake
```

The twelve that do have one map cleanly onto claudish's provider uids —
`qwen-cloud/qc`, `antigravity/ag`, `kimi-coding/kc`, `opencode-zen-go/zgo`,
`grok-subscription/gk`, `glm-coding/gc`, `devin/dv`, `openai-codex/cx`,
`minimax-coding/mmc`, `ollamacloud/oc`, `native-anthropic`. That part of the
contract works well.

**The problem is that absence is ambiguous.** It could mean "no client route
exists" or "not filled in yet", and claudish cannot distinguish them — which is
what makes item 1 possible.

**Fix:** a `routing` block on every plan, or an explicit marker meaning "no
client route". Also `modelDiscovery` on the seven plans where it is `unset`.

---

## 4. Alias coverage for subscription providers

**This is the largest piece of work here, and you do not need to finish it.**

Every provider names the same model differently. Subscription providers are worst
because their names are product names:

```
kimi-k3          openrouter  = moonshotai/kimi-k3
                 fireworks   = accounts/fireworks/models/kimi-k3
                 ollamacloud = kimi-k3:cloud
                 kimi-coding = k3                  <- the subscription

kimi-k2.7-code   kimi-coding = kimi-for-coding     <- underivable by any rule
```

**The registry already exists and already works.** `aggregators[].externalId`
holds all of the above, including `kimi-for-coding`, and claudish consumes it via
`resolveExternalId`. This is a request for coverage, not a new mechanism.

**Where coverage is missing.** The aggregator vocabulary names 18 providers;
claudish routes to 33. The absent ones are almost entirely the subscription
providers:

| provider | what is missing |
|---|---|
| `devin` | **do this first.** Devin re-serves other vendors' models under colliding uids (`claude-opus-5-high`, `gpt-5-6-luna-medium`, `glm-5-2`). Guessed wrong, these answer as the wrong vendor, so claudish refuses to guess — meaning Devin models stay unenriched until you record them. |
| `antigravity` | serves effort-suffixed ids (`gemini-3.6-flash-high`). None are in the catalog; `gemini-3.6-flash` has `routeVariant: none`. |
| `grok-subscription` | account-specific roster, no aliases recorded at all |
| `glm-coding`, `minimax-coding`, `qwen-cloud` | no aggregator rows |

For variants — an effort tier, a context size — `routeVariant` already exists and
already models it:

```json
"routeVariant": { "baseModelId": "kimi-k3", "familyId": "kimi-k3",
                  "provider": "kimi-coding", "isDefault": false }
```

There are **6 such rows across 737 entries.** `kimi-k3-256k` has one; antigravity
has none.

**Why you need not reach 100%.** claudish runs a matcher for anything the
registry does not cover, and your entries always win where they exist. Scored
against the 705 non-trivial `(externalId -> modelId)` pairs already in the
catalog:

| outcome | rate |
|---|---|
| recovered correctly | 85.1% |
| wrong model | 0.1% |
| declined, no match | 14.8% |

It is tuned to decline rather than guess, because a decline costs metadata while
a wrong match sends the request to a different model. So the priority order above
is by risk, not by volume.

---

## 5. Add `providerUid` to `aggregators[]`

**Small change, removes a whole class of silent failure.**

`aggregators[].provider` uses the catalog's vendor slugs. claudish has its own
provider names. Measured: **14 of 18 slugs already match**. The gap is four:

| slug | claudish | nature |
|---|---|---|
| `anthropic` | `native-anthropic` | claudish renamed the vendor |
| `moonshotai` | `kimi` | claudish renamed the vendor |
| `fireworks` | *(none)* | claudish does not implement it |
| `together-ai` | *(none)* | claudish does not implement it |

Today a slug claudish cannot resolve produces a candidate it cannot build, the
candidate is filtered out, and the route disappears with **no error**.

**The pattern already exists on the plan side.** `plans[].routing` publishes
claudish's own `providerUid` and `prefix` for twelve plans. So one half of the
document already speaks claudish's vocabulary and the other speaks vendor slugs.
Adding `providerUid` to aggregator rows makes the document internally consistent.

For 14 of 18 it equals the existing `provider`. For the two renames it carries
them. Omitting it for `fireworks` and `together-ai` says "no client route", the
same signal a missing plan `routing` block gives.

claudish is separately renaming its two odd names to match yours, so this may
shrink to a no-op — but the field still resolves version skew between a client
and a cache.

---

## 6. Periodic alias validation

Aliases drift without notice. A periodic check that every `externalId` recorded
for a provider still appears in that provider's live roster would catch it before
a user does.

claudish cannot do this centrally — it only sees providers a given user holds
credentials for.

---

## 7. `includedModels` vocabulary — non-blocking

`includedModels` currently mixes four kinds of string:

| example | what it is |
|---|---|
| `claude-opus-5` | a model id |
| `Gemini 3.6 Flash` | display name; id is `gemini-3.6-flash` |
| `Claude Opus 4.6 (thinking)` | display name plus a mode |
| `k3`, `kimi-for-coding` | the plan's own wire ids |
| `MiniMax image model family` | a family, naming no single model |
| `account-specific Grok subscription roster` | prose, deliberately |

Measured over the twelve plans with a `routing` block, 138 strings: 59% match a
model id exactly, 74% after normalizing, 26% do not resolve at all.

claudish uses `entry.subscriptionPlans` as the authoritative join, so this is not
blocking. But if `includedModels` carried model ids with the display text in a
separate field, it would become usable rather than advisory.

---

## Summary

| # | item | why now |
|---|---|---|
| 1 | `alibaba-ai-coding-plan` routing block | users mischarged today |
| 2 | confirm GLM and Codex `includedModels` | possibly mischarged today |
| 3 | routing block or explicit "no route" on all plans | makes item 1 impossible |
| 4 | alias coverage, `devin` first | unblocks catalog-driven routing |
| 5 | `providerUid` on `aggregators[]` | removes silent route loss |
| 6 | periodic alias validation | catches drift |
| 7 | `includedModels` vocabulary | nice to have |
