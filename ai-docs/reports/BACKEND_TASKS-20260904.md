# models-index: what claudish needs, in priority order

**For:** the models-index backend developer
**From:** claudish
**First issued:** 2026-09-04. **Revised:** 2026-09-09, in response to your
"Proposed fix for subscription routing and model identity".
**Measured against:** `~/.claudish/all-models.json` as served 2026-09-03
(737 entries, 19 plans, 1112 aggregator rows)

Item numbers are unchanged from the first issue so the thread stays legible.
Items 1, 2 and 5 changed materially. Your reply is the reason for all three.

---

## What changed in this revision

| # | 2026-09-04 said | now says | why |
|---|---|---|---|
| 1 | give `alibaba-ai-coding-plan` `providerUid: qwen-cloud` | **do NOT.** Mark it explicitly unsupported | you were right — that would cross two isolated credential silos |
| 2 | the `includedModels` lists may be too short | GLM's list looks correct; the gap is redirects | your Z.ai redirect finding |
| 5 | add `providerUid` to every `aggregators[]` row | one route registry that rows reference | your section 5, which is better than the original |

Items 3, 4, 6 and 7 stand, with your caveats folded in.

---

## 1. `alibaba-ai-coding-plan` — do not give it a route. Mark it unsupported

**This item previously asked for the wrong thing. Do not implement the
2026-09-04 version of it.**

You were right that the endpoint and the credential decide entitlement, not the
vendor. claudish's own provider table already records the split, from a live
probe (`packages/cli/src/providers/provider-definitions.ts:1260`):

```
Token Plan   token-plan.ap-southeast-1.maas.aliyuncs.com  -> qwen-cloud
Coding Plan  coding-intl.dashscope.aliyuncs.com           -> (not built)
PAYG         dashscope-intl.aliyuncs.com                  -> qwen-payg
```

And at `:1183`, probed 2026-08-02:

> the sibling Alibaba hosts reject it outright — `coding-intl.dashscope.aliyuncs.com`
> -> 401 invalid_api_key; `dashscope.aliyuncs.com` (Beijing) and
> `dashscope-intl.aliyuncs.com` -> 403 invalid api-key

So `alibaba-ai-coding-plan` has **no claudish provider at all**. The missing
`routing` block was not an omission — it was accurate. Publishing
`providerUid: "qwen-cloud"` would have told claudish that the Token Plan covers
Coding-Plan-only models, routing a Token Plan key to a host that does not serve
them.

**What we now ask instead:**

1. Leave `alibaba-ai-coding-plan` without a `providerUid`.
2. Give it an explicit `routingStatus: "unsupported"` (item 3) so its absence
   stops reading as "not filled in yet". That is what let us misread it.
3. When claudish ships a `coding-intl` provider, we will ask for the routing
   block then, naming the new provider.

**Client state:** the v9.0.4 guard withholds a `not-served` verdict when a
same-vendor plan is unroutable. We described that as a stopgap. Given the
above it is the correct end state for this plan, not a stopgap.

**Claudish side:** building the `coding-intl` provider is our work, tracked
below. Nothing you publish can substitute for it.

---

## 2. GLM and Codex — the question is redirects, not list length

The 2026-09-04 version asked whether these lists were too short:

```
z-ai-glm-coding-plan   modelDiscovery = catalog
  includedModels: GLM-5.3, GLM-5.3-Flash

openai-codex           modelDiscovery = catalog
  includedModels: 6 models, gpt-5 NOT among them
```

Your reply says Z.ai documents that `GLM-4.7` requests **execute**
`GLM-5.3-Flash`, and `GLM-5.2` / `GLM-5.1` requests execute `GLM-5.3`. If that
holds, the list is right and the catalog has no way to say what is actually
happening. We have not independently verified that citation; please confirm it
against the source you checked.

That reframes the ask:

1. **Do not publish a redirect as coverage.** Agreed, without reservation. A
   plan that redirects `GLM-4.7` to `GLM-5.3-Flash` does not "include GLM-4.7",
   and a user who asked for 4.7 should not silently receive 5.3-Flash believing
   otherwise.
2. **Give redirects their own representation** — request id, execution target,
   and the source. claudish can then display the executing model rather than
   the requested one.
3. **Codex:** your point is well taken. A model's presence in the general
   OpenAI API catalog is not evidence of Codex subscription access. Verify
   against subscription-specific sources only.

---

## 3. Explicit routing status and roster coverage

Seven of nineteen plans have no `routing` block:

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
`minimax-coding/mmc`, `ollamacloud/oc`, `native-anthropic`. That half of the
contract works well.

**The defect is that absence is ambiguous.** It could mean "no client route
exists" or "not filled in yet". Item 1 is exactly what that ambiguity costs:
we read an accurate absence as an omission and proposed a dangerous fix.

Your section 2 proposal is accepted as written:

| field | meaning |
|---|---|
| `routingStatus` | `supported` / `unsupported` / `unknown`, scoped to claudish. Missing in an older response means `unknown`, never `unsupported`. |
| roster coverage | `complete` / `partial` / `unknown`, plus source and time of the last successful verification |

Two points we want to hold you to, because they are the ones that bite:

- **`complete` only when the source is exhaustive AND the collection run
  succeeded.** A marketing list of highlighted models is not a roster. A 200 is
  not a roster. claudish learned this the hard way: `coding-intl`'s `/v1/models`
  serves a full list to an *unauthenticated* caller, which briefly convinced an
  investigation of the opposite conclusion.
- **A failed refresh must downgrade coverage, not preserve `complete`.** Expired
  coverage must stop supporting negative verdicts.

**Sequencing note:** a new field is inert until claudish reads it. Publishing
`routingStatus` changes nothing on its own — we have to ship the reader. See
the claudish section below.

---

## 4. Alias coverage for subscription providers

**This is the largest piece of work here, and you do not need to finish it.**

Every provider names the same model differently. Subscription providers are
worst, because their names are product names:

```
kimi-k3          openrouter  = moonshotai/kimi-k3
                 fireworks   = accounts/fireworks/models/kimi-k3
                 ollamacloud = kimi-k3:cloud
                 kimi-coding = k3                  <- the subscription

kimi-k2.7-code   kimi-coding = kimi-for-coding     <- underivable by any rule
```

**The registry already exists and already works.** `aggregators[].externalId`
holds all of the above, including `kimi-for-coding`, and claudish consumes it
via `resolveExternalId`. This is a request for coverage, not a new mechanism.

**Where coverage is missing.** The aggregator vocabulary names 18 providers;
claudish routes to 33. The absent ones are almost entirely the subscription
providers:

| provider | what is missing |
|---|---|
| `devin` | **do this first.** Devin re-serves other vendors' models under colliding uids (`claude-opus-5-high`, `gpt-5-6-luna-medium`, `glm-5-2`). Guessed wrong, these answer as the wrong vendor. |
| `antigravity` | serves effort-suffixed ids (`gemini-3.6-flash-high`). None are in the catalog; `gemini-3.6-flash` has `routeVariant: none`. |
| `grok-subscription` | account-specific roster, no aliases recorded at all |
| `glm-coding`, `minimax-coding`, `qwen-cloud` | no aggregator rows |

For variants — an effort tier, a context size — `routeVariant` already exists:

```json
"routeVariant": { "baseModelId": "kimi-k3", "familyId": "kimi-k3",
                  "provider": "kimi-coding", "isDefault": false }
```

There are **6 such rows across 737 entries.** `kimi-k3-256k` has one;
antigravity has none.

**Your caveats, accepted:**

- **Keep mappings provider- and route-scoped.** The same wire id can name
  different models on different services. This is the whole reason `devin` is
  first on the list.
- **A redirect is not an alias.** Item 2's GLM case is a redirect and must not
  be recorded here.
- **An observed roster id does not establish identity.** For account-specific
  providers, attach identity metadata to the locally discovered roster. Do not
  manufacture a public serving route to enrich a model only a signed-in client
  can see.
- **Keep conservative no-match behaviour for ambiguous ids.** Agreed, and it is
  already how the client-side matcher is designed.

**Why you need not reach 100%.** claudish runs a matcher for anything the
registry does not cover, and your entries always win where they exist. Scored
against the 705 non-trivial `(externalId -> modelId)` pairs already in the
catalog:

| outcome | rate |
|---|---|
| recovered correctly | 85.1% |
| wrong model | 0.1% |
| declined, no match | 14.8% |

It is tuned to decline rather than guess, because a decline costs metadata
while a wrong match sends the request to a different model. The priority order
above is by risk, not by volume.

*(That matcher is measured but not yet shipped — see the claudish section.)*

---

## 5. One route registry, referenced by rows

**Your section 5 replaces the original ask, and it is the better shape.**

The problem is unchanged: `aggregators[].provider` uses catalog vendor slugs,
claudish has its own provider names, and a slug claudish cannot resolve produces
a candidate it cannot build — filtered out, route gone, **no error**.

Measured: **14 of 18 slugs already match.** The gap is four:

| slug | claudish | nature |
|---|---|---|
| `anthropic` | `native-anthropic` | claudish renamed the vendor |
| `moonshotai` | `kimi` | claudish renamed the vendor |
| `fireworks` | *(none)* | claudish does not implement it |
| `together-ai` | *(none)* | claudish does not implement it |

The original ask was to stamp `providerUid` on every aggregator row. You are
right that this duplicates a client-specific name across 1112 rows. **One
maintained route registry that rows reference** is better, and it matches what
claudish is doing on its own side — folding the slug map into the provider
definitions rather than keeping a third hand-synced table.

Two things we ask you to preserve from the original:

- **Omission means unknown, not unsupported.** Agreed and important. The
  installed client's registry decides whether it can build a route; the catalog
  only says which route identity applies.
- **An unresolvable route must be visible.** Today it vanishes silently. That
  silence is what made both the v9.0.1 and v9.0.4 defects expensive. Claudish
  will log it on its side; the registry should make it detectable on yours.

claudish is separately renaming its two odd names to match yours, so the
divergence may shrink to nothing — but the registry still resolves version skew
between a client and a cache, which is why it is worth having anyway.

---

## 6. Periodic alias validation

Aliases drift without notice. A periodic check that every `externalId` recorded
for a provider still appears in that provider's live roster would catch it
before a user does.

claudish cannot do this centrally — it only sees providers a given user holds
credentials for.

**Your caveat, accepted and important:** an authentication failure or an
incomplete response must **not** delete mappings. Report a scoped discrepancy
instead. A validation run that treats "I could not check" as "it is gone" is
the same failure mode as item 3's coverage flag, one layer down.

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

claudish uses `entry.subscriptionPlans` as the authoritative join, so this is
not blocking. Your proposal — add structured canonical references while
preserving the existing display text, and represent families and unresolved
entries explicitly rather than forcing them into model ids — is the right
shape. The 26% that fails today is mostly not a matching problem, so an
explicit "this names a family, not a model" is worth more than a better
normalizer.

---

## What claudish is fixing on its side

Named here so the boundary is clear, and so you do not wait on us for the
wrong things.

| work | blocks / blocked by |
|---|---|
| **Sibling-plan over-coverage.** `model-catalog.ts:303` filters plans by `providerUid`, then unions their ids. A model in `alibaba-token-plan-team-edition` only returns `serves` to an Individual holder. Your acceptance check 2, and it fails today. | ours alone |
| **A `coding-intl` provider** for the Alibaba Coding Plan | ours alone; item 1 waits on it |
| **Read `routingStatus` and coverage** once published | needs item 3 first; inert until we ship |
| **Ship the alias matcher.** Measured at 85.1%, currently an evaluation script only | independent |
| **Log an unresolvable route** instead of silently dropping the candidate | independent |
| **Metered-fallback policy** — whether unknown coverage may fall through to a metered provider is a product decision, not yet made | independent |

Both `resolveSubscriptionRouting` bugs have one cause: `providerUid` is a
**route** identity and the code uses it as a **plan** identity. One route serves
several plans, so the union over-covers in one direction while a partial view
under-covers in the other. v9.0.4 patched the expensive direction. The general
fix is to stop treating a route as a plan — which is your four-way split, and we
agree with it.

---

## Acceptance checks

Yours, with the current claudish verdict against each. Verified by reading the
resolver, not by running a live session.

| # | check | today |
|---|---|---|
| 1 | A missing or partial sibling plan cannot remove the user's subscription candidate | **passes** (v9.0.4 guard) |
| 2 | A model included only in a sibling plan cannot grant the user coverage | **fails** (`model-catalog.ts:303`) |
| 3 | Coding Plan credentials stay on the Coding Plan endpoint | **n/a** — no such provider exists yet |
| 4 | Missing new contract fields in old caches produce unknown, not exclusion | **passes** (`providerPlans.length === 0` -> `unknown`) |
| 5 | Failed or incomplete discovery cannot create an authoritative empty roster | **backend-side** |
| 6 | Unknown routes produce an actionable diagnostic | **fails** — silently filtered |
| 7 | Unknown coverage cannot trigger metered fallback unless policy authorizes it | **fails** — no such policy exists |
| 8 | Explicitly authorized metered fallback continues to work | **n/a** until 7 exists |
| 9 | Redirected wire ids report the model that actually executes | **fails** — no redirect concept |
| 10 | Ambiguous cross-provider ids cannot enrich or route to the wrong model | **passes**, trivially — no guessing happens today |

Check 10 passes only because the matcher is not shipped. It becomes a real
check the moment it is, which is why it is designed to decline.

---

## Summary

| # | item | status |
|---|---|---|
| 1 | Alibaba Coding Plan: mark unsupported, do **not** route | revised — original was wrong |
| 2 | GLM/Codex redirects, not list length | revised |
| 3 | `routingStatus` + roster coverage on every plan | accepted as you proposed |
| 4 | alias coverage, `devin` first | stands, with your identity caveats |
| 5 | one route registry, rows reference it | revised to your shape |
| 6 | periodic alias validation | stands; failures must not delete |
| 7 | `includedModels` vocabulary | stands, structured refs alongside display text |
