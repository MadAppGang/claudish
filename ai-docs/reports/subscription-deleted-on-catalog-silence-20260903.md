# Subscriptions deleted when the catalog is silent

Open defect. Found in code review of the v9.0.3 hotfix, 2026-09-03. **Not fixed
by v9.0.3.** Live on npm `latest`.

## Symptom

A user holding a Z.ai GLM Coding Plan asks for `glm-4.7` and is billed per token
by the metered `glm` API. The plan they pay for is silently removed from the
chain, along with the OpenCode Go plan.

Measured on the live cache:

```
glm-4.7   rule  ["glm-coding", "opencode-zen-go", "glm", "openrouter"]
          chain ["glm@glm-4.7", "openrouter@z-ai/glm-4.7"]      <- both plans deleted

glm-5.3   chain ["glm-coding@gc@glm-5.3", "opencode-zen-go@...", "glm@...", "openrouter@..."]
```

Same shape for `qwen-cloud` on `qwen3-coder-plus`.

This is the CLAUDE.md invariant the project names explicitly: a provider absent
from the chain quotes a flat-rate user a per-token price.

## Mechanism

`resolveSubscriptionRouting` (`packages/cli/src/adapters/model-catalog.ts:335-344`),
consumed by `buildRoutingChain` (`packages/cli/src/providers/routing-rules.ts:213`).

The guard meant to prevent exactly this is `hasPublishedProviderRoster`. It asks
whether the cache contains **any** membership row for the provider's plans:

```ts
const hasPublishedProviderRoster = cache.entries.some((candidate) =>
  candidate.subscriptionPlans?.some((planId) => providerPlanIds.has(planId))
);
if (!hasPublishedProviderRoster) return { kind: "unknown" };
```

That is evaluated at **provider granularity across the whole cache**. So a single
model publishing a membership makes every *other* model's silence authoritative.

On the live cache only `glm-5.3` and `glm-5.3-flash` list
`z-ai-glm-coding-plan`. `glm-4.5`, `glm-4.6` and `glm-4.7` have
`subscriptionPlans: None`. The roster therefore counts as "published", their
silence is read as denial, and the candidate is dropped.

## Why v9.0.0 was safe

v9.0.0 tested `entry.subscriptionPlans?.includes(provider)` — a **provider uid**
against a list of **plan ids**. Those never match (`z-ai-glm-coding-plan` is not
`glm-coding`), so the function returned `unknown` and kept the candidate. The
join introduced in v9.0.1 is the right idea; its authority check is too coarse.

`openai-codex` is the one provider whose plan id equals its uid, which is why the
two `route() > gpt-5` tests in `routing-rules.test.ts` fail locally on a warm
cache and pass in CI on a cold one. Those two failures are this bug.

## Candidate fixes

1. Scope `hasPublishedProviderRoster` to the model's own family rather than the
   whole cache.
2. Gate `not-served` on the entry having a non-empty `subscriptionPlans`, so
   silence stays `unknown`. Closest to v9.0.0's safety property.

Option 2 restores the invariant that only positive evidence removes a candidate,
which is what `model-availability.ts` already documents for the sibling path.

## Test gate

Any fix needs a red-first test that does not depend on ambient cache state — the
same requirement that the v9.0.3 review imposed on its own regression tests. A
warm-cache-only test here would be blind on CI, which is where `glm-4.7` and
`gpt-5` currently pass for the wrong reason.

## Relationship to v9.0.3

v9.0.3 restores the routing **rule composition** to v9.0.0 and is byte-identical
to it after comment stripping. It deliberately retains v9.0.1's
subscription-availability join, this gap included. "v9.0.3 == v9.0.0 routing" is
therefore false and should not be used to scope a bisect.

The catalog-driven redesign in `routing-from-the-catalog-alone-20260903.md`
supersedes this code path entirely, but that is a larger change and this defect
is costing subscription holders money now.
