# Reply: subscription routing and model identity

**To:** the models-index backend developer
**From:** claudish, 2026-09-09
**Re:** your "Proposed fix for subscription routing and model identity"

Accepted, with three corrections to our own document. `BACKEND_TASKS-20260904.md`
is revised; items 1, 2 and 5 changed because of your reply. Item numbers are
unchanged so this thread stays legible.

---

## You were right about Alibaba, and our item 1 was a hazard

Do not implement the 2026-09-04 version of item 1. We checked our own provider
table before replying, and it already carries the proof
(`packages/cli/src/providers/provider-definitions.ts:1260`):

```
Token Plan   token-plan.ap-southeast-1.maas.aliyuncs.com  -> qwen-cloud
Coding Plan  coding-intl.dashscope.aliyuncs.com           -> (not built)
PAYG         dashscope-intl.aliyuncs.com                  -> qwen-payg
```

and at `:1183`, from a live probe on 2026-08-02:

> the sibling Alibaba hosts reject it outright — `coding-intl.dashscope.aliyuncs.com`
> -> 401 invalid_api_key; `dashscope.aliyuncs.com` (Beijing) and
> `dashscope-intl.aliyuncs.com` -> 403 invalid api-key

So `alibaba-ai-coding-plan` has no claudish provider at all, and its missing
`routing` block was **accurate**, not an omission. We read the absence as a data
gap and proposed crossing two isolated credential silos to close it. Your
"never silently retarget an existing credential" is the correct rule and we are
adopting it.

What we ask instead: leave it without a `providerUid`, and give it an explicit
`routingStatus: "unsupported"`. Building a `coding-intl` provider is our work.
We will ask for the routing block when it exists, naming the new provider.

One consequence worth stating: we described the v9.0.4 client guard as a
stopgap that trades precision for safety. For this plan it is not a stopgap. It
is the correct behaviour, and it should stay.

---

## Your section 3 is already how the resolver works

The three-verdict model is shipped, not pending:

```
adapters/model-catalog.ts:281      | { kind: "not-served" }
providers/routing-rules.ts:234     if (routing.kind === "not-served") continue;
```

Only the negative verdict acts destructively; `unknown` keeps the candidate.
So we agree on the resolver's shape, and nothing in your section 3 is new work
for us except the fallback policy below.

---

## Your acceptance check 2 fails today. We had not spotted it

> *A model included only in a sibling plan cannot grant the user coverage.*

`adapters/model-catalog.ts:303` filters plans by route, then unions their ids:

```ts
const providerPlans = cache?.plans?.filter((plan) => plan.routing?.providerUid === provider) ?? [];
const providerPlanIds = new Set(providerPlans.map((plan) => plan.id));
```

`alibaba-token-plan-individual` and `-team-edition` both map to `qwen-cloud`, so
a model in Team Edition only returns `serves` to someone holding Individual.

That is the mirror image of the v9.0.4 defect. We fixed the direction that
deletes a subscription and left the direction that invents one. It is the
cheaper failure — a rejected request rather than a wrong bill — but it is real,
and it is ours. Thank you for the check that found it.

Both bugs have one cause, and it is your four-way split stated in our
vocabulary: `providerUid` is a **route** identity, and the resolver uses it as a
**plan** identity. One route serves several plans, so the union over-covers
while a partial view under-covers. Fixing that properly is on our side.

---

## The GLM redirect changes what we were asking

Our item 2 asked whether `z-ai-glm-coding-plan`'s two-model `includedModels` was
too short. Your answer — that Z.ai documents `GLM-4.7` executing as
`GLM-5.3-Flash`, and `GLM-5.2` / `GLM-5.1` as `GLM-5.3` — means the list is
right and the catalog has no way to say what actually happens.

We have not independently verified that citation. Please confirm it against the
source you checked, since it decides whether current claudish behaviour for the
GLM 4.x line is correct or merely correct-looking.

Your rule is accepted without reservation: a redirect is not coverage, and it
should carry its own representation — requested id, execution target, source.
claudish will display the model that executes. The same discipline applies to
Codex; we accept that a general OpenAI API catalog entry proves nothing about
subscription access.

---

## Section 5: your shape is better than ours

We asked for `providerUid` on every `aggregators[]` row. You are right that this
stamps a client-specific name across 1112 rows. One maintained route registry
that rows reference is better, and it converges with what we had already decided
for our side — folding the slug map into the provider definitions instead of
keeping a third hand-synced table.

Two things we would like preserved from the original ask:

- **Omission means unknown, not unsupported.** You said this yourself; we are
  agreeing loudly because it is the same trap as item 1.
- **An unresolvable route must be visible somewhere.** Today it produces a
  candidate we cannot build, it is filtered out, and the route disappears with
  no message. Silence is what made both the v9.0.1 and v9.0.4 defects expensive.
  We will log it; the registry should make it detectable on your side too.

---

## One thing we are not deciding yet

> *Unknown subscription coverage must not itself authorize metered fallback.*

We understand the argument and it is sound. It is also a product decision with
a real cost in both directions: today an unknown verdict keeps the subscription
candidate and the routing chain falls through to a metered provider; your
proposal stops with an explanation unless the user has authorized that fallback.
One risks a surprise bill, the other risks a stopped session for someone who
would have happily paid.

That is ours to decide, not yours, and it is not decided. Everything else in
your section 3 we are taking as written. Your point that it must reuse existing
settings rather than introduce a competing policy system is well taken either
way.

---

## Where that leaves the sequence

Your section 6 ordering is right, with one substitution in step 3.

| step | what | owner |
|---|---|---|
| 1 | client safety: scope roster decisions to the configured plan, preserve uncertainty | claudish |
| 2 | contract: `routingStatus` + roster coverage, with validation that partial collection cannot publish exclusions | backend |
| 3 | Alibaba: mark Coding Plan unsupported **now**; the adapter comes later | backend now, claudish later |
| 4 | identity coverage, `devin` first, provider- and route-scoped | backend |
| 5 | validation during existing collection runs; failures must not delete mappings | backend |
| 6 | vocabulary: structured canonical references alongside display text | backend |

Step 3 changed because the Alibaba adapter does not exist. Marking the plan
unsupported is small, it is available today, and it removes the ambiguity that
produced our bad recommendation in the first place — so it is worth doing before
the adapter rather than with it.

---

## What we owe you

- the sibling-plan over-coverage fix (your check 2)
- a `coding-intl` provider, before item 1 can be reopened
- readers for `routingStatus` and coverage — a new field is inert until we ship
  the code that reads it, so the two halves need sequencing, not just publishing
- an actionable diagnostic for unresolvable routes
- the alias matcher, currently measured at 85.1% but living only as an
  evaluation script

Your closing point is the one we will hold ourselves to: a backend schema change
alone does not establish changed client behaviour. We will verify the deployed
catalog and the consuming claudish behaviour separately, and report both.
