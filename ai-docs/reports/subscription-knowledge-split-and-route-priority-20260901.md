# Subscription knowledge is split across two parties, and both copies are wrong

**Date:** 2026-09-01
**Scope:** claudish side. The backend half is
`models-index/TASK_subscription_route_order_contract_and_stale_providers.md`.
**Status:** Findings. Nothing here is fixed yet.

---

## The core problem

Two parties independently hold the answer to "which routes serve this model, and
in what order do we prefer them".

| Party | Where | What it says for `kimi-k3` |
|---|---|---|
| The cloud catalog | `?catalog=recommended` → `subscriptions[]` | `zgo, kc, oc` |
| claudish | `providers/default-routing-rules.ts` → `DEFAULT_ROUTING_RULES` | `kimi-coding, opencode-zen-go, kimi, openrouter` |

They already disagree about which route comes first, and neither can prove the
other wrong. This is the exact failure shape `ai-docs/architecture/routing.md`
records for the picker roster:

> A dead hand-written roster is worse than a live one, because nothing can ever
> prove it wrong.

The difference in risk is that a wrong roster hides a model, which is visible.
A wrong **order** silently changes which plan a user's money goes through, and
looks identical to a correct one.

### What each party legitimately knows

| Knowledge | Belongs to |
|---|---|
| Which plans serve a model, and their wire ids | the catalog. It already ships `subscriptionPlans[]` and `aggregators[].externalId`. |
| The preference order among those plans | the catalog, for the same reason. It is a property of the model and the plans, not of this client. |
| Which credentials the user actually holds | claudish. The catalog cannot know. |
| User overrides and pinning | claudish. `loadRoutingRules()` already merges `DEFAULT ← global ← local`. |
| Behaviour with a cold or unreachable catalog | claudish. Routing must still work. |

So `DEFAULT_ROUTING_RULES` should end up as the **cold-cache fallback and the
base layer user overrides merge onto**, not as a parallel source of truth.

---

## The intended priority order

Stated by Jack, 2026-09-01:

```
1. The vendor's OWN subscription        kc@ (Kimi Code), gc@ (GLM Coding),
                                        qc@ (QwenCloud), mmc@ (MiniMax Coding)
2. General / multi-vendor subscriptions zgo@ (OpenCode Zen Go), oc@ (OllamaCloud)
3. Metered direct vendor APIs           kimi@, glm@, minimax@
4. OpenRouter                           always last; it is per-token API usage
5. Any custom fallback the user configures
```

`DEFAULT_ROUTING_RULES` already encodes exactly this:

```ts
"kimi-*":     ["kimi-coding",       "opencode-zen-go", "kimi",     "openrouter"]
"glm-*":      ["glm-coding",        "opencode-zen-go", "glm",      "openrouter"]
"minimax-*":  ["minimax-coding",    "opencode-zen-go", "minimax",  "openrouter"]
"grok-*":     ["grok-subscription", "x-ai",            "openrouter"]
"deepseek-*": ["opencode-zen-go",   "deepseek",        "openrouter"]
```

`deepseek-*` correctly leads with a general plan because DeepSeek has no native
one. That is why a blanket "put `zgo` last" rule would be wrong, and why the
order has to be per-family data rather than a sort key.

Step 5 already exists: `loadRoutingRules()` (`providers/routing-rules.ts:40`)
merges a global config and a run-local `.claudish.json` over the defaults.

---

## Defect 1 — we render only ONE subscription route per model

**Severity: high. Live today, affects 8 models.**

The backend sends **one** `category:"subscription"` row per model, carrying up
to five routes in a `subscriptions[]` array. It also sends a singular
`subscription` field that mirrors `subscriptions[0]`.

Our type declares only the singular:

```ts
// model-loader.ts:42
subscription?: { prefix: string; plan: string; command: string; };
```

There is no plural field in `RecommendedModelEntry` at all. And
`collectRoutingPrefixes` iterates the **rows** and takes one prefix from each:

```ts
// model-loader.ts:377
for (const sub of group.subscriptions) {
  const p = sub.subscription?.prefix;
```

One row in, one prefix out. Measured 2026-09-01:

```
model              rows  routes_in_array
kimi-k3              1          3
glm-5.3              1          4
qwen3.8-max          1          4
deepseek-v4-pro      1          5
```

So no matter how many routes arrive, at most one can render. Confirmed against
the live payload — `subscription.prefix == subscriptions[0].prefix` for all 8
multi-route models, so the singular is a mirror of element zero, not a curated
primary we were meant to prefer.

**Result:** `list_models` currently shows

```
kimi-k3:     zgo   (backend sent zgo,kc,oc)
glm-5.3:     zgo   (backend sent zgo,gc,zen,oc)
qwen3.8-max: zgo   (backend sent zgo,qc,qc,zen)
minimax-m3:  zgo   (backend sent zgo,mmc,zen,oc)
```

Every vendor-native plan prefix is discarded.

**Why it went unnoticed:** it was harmless while the native plan happened to sit
at index 0. On 2026-08-30 `kimi-k3` was `kc,oc` and we rendered `kc@kimi-k3`
correctly. The 08-31 rollout of `zgo` to more models put a general plan at index
0 and the bug became visible. Code that is right by accident of input order
reads identically to code that is right.

**Consumers affected:** `mcp-server.ts:681` (`list_models`) and `cli.ts:1129`
(the picker). Both call the same function, so both are wrong.

**Fix:** add the plural `subscriptions?: Array<{prefix, plan, command}>` to
`RecommendedModelEntry`, iterate it, fall back to the singular when absent.
Independent of who ends up owning the order, so it can ship immediately.

---

## Defect 2 — the two OpenCode providers are classified backwards

**Severity: high. Misreports money in both directions.**

| Provider | Reality | Classified as | User sees |
|---|---|---|---|
| `opencode-zen-go` (`zgo@`) | paid flat plan ("Lite Plan") | in **neither** set | a per-token price, and TokenTracker accrues fictional spend |
| `opencode-zen` (`zen@`) | metered, needs a real key | in `FREE_PROVIDERS` | **$0** for real metered usage |

`getModelPricing` (`handlers/shared/remote-provider-types.ts:199`) checks
`FREE_PROVIDERS` first, then `isSubscriptionProvider`, then falls through to
dynamic/default pricing. `zgo` reaches the fall-through. `zen` short-circuits at
FREE.

The provider definitions themselves state the reality:

- `provider-definitions.ts:786` — *"Zen Go is a separate **paid tier** from the
  free Zen plan"*, key described as *"OpenCode Zen Go (**Lite Plan**) API Key"*.
- The `opencode-zen` definition records that its keyless tier was **removed**:
  *"Zen remains reachable with a real `OPENCODE_API_KEY`."* The `FREE_PROVIDERS`
  entry predates that removal and was never updated.

The file argues against itself. Directly above `SUBSCRIPTION_PROVIDERS`:

> Quoting a dollar rate to someone on a subscription is a cosmetic
> over-estimate they can ignore; reporting $0 to someone being metered is the
> one that costs them.

`opencode-zen` is doing exactly the error that comment calls the costly one.

This is the CLAUDE.md invariant firing twice:

> A provider absent from `SUBSCRIPTION_PROVIDERS` quotes flat-rate users a
> per-token price and accrues fictional spend.

**Why this is so easy to get wrong:** the names differ by one word; the billing
is inverted relative to what the names imply ("Go"/"lite" sounds cheaper but is
the plan, plain "Zen" sounds fuller but is per-token); they share a credential
(`OPENCODE_API_KEY` is Zen's key and an alias on Zen Go); and billing lives in
three hand-maintained places that nothing cross-checks.

**Fix:** add `opencode-zen-go` to `SUBSCRIPTION_PROVIDERS`; remove
`opencode-zen` from `FREE_PROVIDERS`.

---

## Defect 3 — `openai-codex` reports metered for subscription users

**Severity: medium. Deliberate, documented, and wrong for anyone on ChatGPT
Plus/Pro.**

`openai-codex` is excluded from `SUBSCRIPTION_PROVIDERS` on purpose
(`remote-provider-types.ts:130`). The reasoning is sound as far as it goes:

| provider | `apiKeyEnvVar` | `apiKeyAliases` | in SUB set? |
|---|---|---|---|
| `kimi-coding` | `KIMI_CODING_API_KEY` | none | yes |
| `glm-coding` | `GLM_CODING_API_KEY` | `ZAI_CODING_API_KEY` (also a plan key) | yes |
| `openai-codex` | `OPENAI_CODEX_API_KEY` | **`OPENAI_API_KEY`** | no |

`openai-codex` is the only one that accepts a *generic metered* key, so holding
a credential does not prove plan membership. The other plan keys are
plan-specific, so they do.

But this machine has `~/.claudish/codex-oauth.json`, the ChatGPT Plus/Pro
credential. For this user the label is simply wrong, and `preflight` reports
`gpt-5.6-sol` as metered on a flat-rate plan.

The comment names its own fix:

> Until membership can be decided from the CREDENTIAL actually in play rather
> than the provider name, the safe answer is to leave it out.

**Fix:** decide from the resolved credential. OAuth file in play → subscription.
`OPENAI_API_KEY` in play → metered. The credential layer already knows which
source answered.

---

## Defect 4 — billing membership is opt-in with no default

**Severity: medium. This is the shape that produced defects 2 and 3.**

`FREE_PROVIDERS` and `SUBSCRIPTION_PROVIDERS` are hand-written sets. A provider
absent from both does not fail; it silently receives a guessed per-token price
from `PROVIDER_DEFAULTS` or a `{1.0, 4.0}` literal. So a new provider is
**metered-by-guess until somebody remembers the tables exist**, and nothing ever
proves the omission.

This is the same defect class `routing.md` documents for the picker roster,
where membership was opt-in and `devin` and `antigravity` were invisible while
fully working.

**Fix direction:** make each provider declare its billing model in its own
definition (e.g. `billing: "subscription" | "metered" | "free"`), derive both
sets from `BUILTIN_PROVIDERS`, and make the field required so a new provider
cannot compile without answering the question. Larger change; worth doing after
the two-line correctness fix.

---

## Target design

```
                    ┌──────────────────────────────┐
                    │  cloud catalog               │
                    │  subscriptions[] IN          │  ← single source of
                    │  PREFERENCE ORDER            │    truth for order
                    └──────────────┬───────────────┘
                                   │
       DEFAULT_ROUTING_RULES  ─────┤  used only when the catalog is
       (cold-cache fallback)       │  cold, absent, or has no entry
                                   │
       global config          ─────┤  user layer
       local .claudish.json   ─────┤  user layer (wins)
                                   ▼
                        resolved routing chain
                                   │
              credential filter (claudish only) ──► what actually runs
                                   │
                         display = the same chain
```

Two properties worth stating explicitly:

- **Display and routing read the same source.** Today `list_models` reads the
  catalog array and routing reads our table, so they can disagree without
  anything failing. They should be the same computation.
- **Custom user routing becomes visible.** A user who pins a provider in
  `.claudish.json` currently sees an Access line that ignores it.

---

## Sequencing, and the one ordering risk

1. **Ship defect 1 and defect 2 now.** Both are straight bugs, independent of
   who owns the order, and both are misreporting today.
2. **Get the order contract documented** by the backend (item 1 of the companion
   task). Array order is currently an accident: there is no rank field, no
   declared tier, and nothing promises it.
3. **Then** demote `DEFAULT_ROUTING_RULES` to a fallback and follow the catalog.

Step 3 must not precede step 2. It transfers a cost decision to a field nobody
has promised to keep correct, and the current value of that field puts a general
plan ahead of the vendor's native one on eight models.

A declared `tier` field would remove the fragility entirely, since consumers
would sort by meaning rather than by array position.

---

## Correction recorded

An earlier pass in this session reported that `zgo` being first was "steering
users onto a metered route". That was wrong, and it was wrong because of defect
2: `opencode-zen-go` is a subscription that claudish misclassifies as metered.
The ordering is still not what we want, but for the narrower reason that a
general plan precedes the vendor's native one.

The lesson is that defect 2 does not merely misprint a price. It corrupted the
analysis of a different problem.
