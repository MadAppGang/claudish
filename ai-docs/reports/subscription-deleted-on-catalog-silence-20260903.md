# Subscriptions deleted when the catalog is silent

Raised in code review of the v9.0.3 hotfix. **Fixed in v9.0.4**, but not by the
mechanism first proposed — the initial diagnosis was wrong and is corrected below.

## Symptom

A subscription provider is dropped from a bare-name routing chain for a model the
user's plan covers, and the request is billed per token instead.

Measured with the v9.0.4 guard disabled:

```
model                verdict(qwen-cloud)   resulting chain
qwen3.5-plus         not-served            zengo@qwen3.5-plus, qp@qwen3.5-plus, qwen3.5-plus
qwen3.7-flash        not-served            qp@qwen3.7-flash, qwen/qwen3.7-flash
qwen3.6-max-preview  not-served            qp@qwen3.6-max-preview, qwen/qwen3.6-max-preview
```

`qwen3.5-plus` is named in `alibaba-ai-coding-plan`'s `includedModels`. A holder
of that $50/month plan lost `qc@` and paid `qwen-payg` per token.

With the fix, all three keep `qc@` at the head of the chain. `qwen3.8-max`, which
has a visible membership, is unchanged — the fix is narrow, not "stop dropping
anything".

## Root cause

`resolveSubscriptionRouting` (`packages/cli/src/adapters/model-catalog.ts`)
builds its candidate plan set as:

```ts
const providerPlans = cache?.plans?.filter((p) => p.routing?.providerUid === provider) ?? [];
```

A plan with **no `routing` block never enters that set**, so it is never consulted.
But `hasPublishedProviderRoster` then asks whether *any* entry in the cache claims
membership in one of the visible plans. A sibling plan for the same vendor can
satisfy that, at which point the provider's silence about a model becomes a verdict
about a plan nobody looked at.

On the live cache all three Alibaba plans carry `provider: "alibaba"`:

```
alibaba-ai-coding-plan           routing=MISSING     includes qwen3.5-plus, qwen3-coder-plus, …
alibaba-token-plan-individual    routing=qwen-cloud  modelDiscovery=catalog
alibaba-token-plan-team-edition  routing=qwen-cloud  modelDiscovery=catalog
```

The first is the plan that covers the affected models, and it is invisible.

## Correction to the original diagnosis

The review that raised this cited `glm-4.7` losing `glm-coding`, and described
`hasPublishedProviderRoster`'s provider granularity as the defect. Measurement
does not support that example:

```
z-ai-glm-coding-plan   modelDiscovery=catalog   includedModels: GLM-5.3, GLM-5.3-Flash
glm-5.3        plans=ollama-cloud|opencode-go|z-ai-glm-coding-plan
glm-5.3-flash  plans=ollama-cloud|opencode-go|z-ai-glm-coding-plan
glm-4.7        plans=(none)
```

`z-ai-glm-coding-plan` is z-ai's only plan, it is fully visible, and it declares
its model list authoritative. So `glm-4.7 -> not-served` is the code correctly
reflecting the catalog. Whether the catalog is RIGHT that the plan excludes the
4.x line is a backend data question, filed separately.

The defect is not provider granularity as such. It is asserting a verdict from a
view that is knowingly incomplete.

## The fix

Withhold `not-served` when any plan sharing the vendor of a matched plan lacks a
`routing` block:

```ts
const vendorsInView = new Set(providerPlans.map((p) => p.provider).filter(Boolean));
const hasUnroutableSiblingPlan = (cache.plans ?? []).some(
  (p) => p.provider !== undefined && vendorsInView.has(p.provider)
         && p.routing?.providerUid === undefined
);
if (hasUnroutableSiblingPlan) return { kind: "unknown" };
```

This restores the property `model-availability.ts` already documents for its
sibling path: only positive evidence removes a candidate. Where a vendor's plans
are all routable — z-ai, openai, moonshotai — nothing changes.

`CachedSubscriptionPlan.provider` had to be added to the type. The field was
present in the served data and consumed nowhere, so Bun's untypechecked test run
passed over the gap until `tsc` caught it.

## Tests

Four hermetic tests in `packages/cli/src/adapters/model-catalog.test.ts`, using
the `cachePath` argument rather than the real cache. One was red before the fix:

```
- "kind": "unknown",
+ "kind": "not-served",
(fail) returns unknown when an unrouted sibling makes the provider plan view partial
```

The other three were green before and must stay green: they pin `not-served` for
a complete view, `serves` for a membership with an aggregator wire id, and
`unknown` when no memberships are published at all. Together they stop the fix
degrading into never dropping a candidate.

## Follow-ups

- Backend: `ai-docs/reports/BACKEND_missing_routing_block_on_plans-20260903.md`.
  Seven plans have no `routing` block and seven have no `modelDiscovery`.
- The two `route() > gpt-5` tests in `routing-rules.test.ts` assert that `gpt-5`
  routes to `openai-codex`, which the catalog contradicts (`openai-codex` lists
  six models and `gpt-5` is not among them). They fail on a warm cache and pass on
  a cold one, so they are both stale and non-hermetic. Not addressed here.
- The catalog-driven redesign in `routing-from-the-catalog-alone-20260903.md`
  supersedes this whole code path.
