# Routing refactor: decisions

Resolves the four blockers in `routing-refactor-gate-measurement-20260903.md`.
Decisions are Jack's; the measurements behind each are mine, taken against
`~/.claudish/all-models.json` on 2026-09-03.

Design: `routing-from-the-catalog-alone-20260903.md`.

## 1. Dynamic subscriptions — probe, cache, and match

**Decision.** A subscription with a per-account served set must be fetched from
the provider, and the result cached. The hard part is not fetching, it is
matching a subscription's model back to the catalog model, because a
subscription can use a different alias and can bind an effort level into the id.

**Where each half already stands.**

*Aliases are solved.* `aggregators[].externalId` carries the per-provider wire
id, subscription providers included:

```
kimi-k3  ->  kimi-coding = k3
             together-ai = moonshotai/Kimi-K3
             fireworks   = accounts/fireworks/models/kimi-k3
             ollamacloud = kimi-k3:cloud
```

`resolveExternalId` already consumes this.

*Effort variants are half solved.* The catalog has `routeVariant`, which says
"this id is a variant of that model, on this provider":

```
kimi-k3-256k   base=kimi-k3   family=kimi-k3   provider=kimi-coding
glm-5.2-fast   base=glm-5.2   family=glm-5.2   provider=fireworks
```

That is exactly the effort-bound-alias case. But there are **6 such rows across
737 entries**, and antigravity's are absent — `gemini-3.6-flash` has
`routeVariant: none` and no `gemini-3.6-flash-high` entry exists at all.

**What is needed.** For providers the catalog covers, match on
`routeVariant.baseModelId` plus `externalId`. For the rest, family-match the
bare name against the live roster — which the antigravity transport already
does. The gap is that neither is wired into chain CONSTRUCTION; both are used
downstream today.

## 2. `includedModels` — normalize, but keep it secondary

**Decision.** `includedModels` does contain model ids, so find a simple way to
match rather than discarding it.

**Measured.** Normalizer under test: lowercase, drop `(...)`, drop `:suffix`,
spaces to hyphens, collapse repeats.

Over the 12 plans that carry a `routing` block (the only ones claudish uses):

| | count | rate |
|---|---|---|
| `includedModels` strings | 138 | |
| match as-is | 81 | 59% |
| match after normalizing | 102 | **74%** |
| unresolved | 36 | 26% |

The 36 sort into four classes, and only one is a matching problem:

| class | example | fixable by a matcher |
|---|---|---|
| absent from the catalog | `wan2.7-image`, `kimi-k2.5`, `gemma4:31b-cloud` | no |
| dated id | `claude-opus-4-5-20251101` | yes, +3 with a date-suffix strip |
| the plan's own wire ids | `k3`, `k3-256k`, `kimi-for-coding` | no — this is the `externalId` side |
| prose or family name | `MiniMax image model family`, `SWE-1.7` | no |

**Conclusion.** Ship the normalizer as a SECONDARY signal. It cannot be
authoritative: a quarter of the strings do not name catalog models at all.
`entry.subscriptionPlans` stays the primary join.

## 3. One provider list — the split is a bug

**Decision.** There must be a single source of truth for the provider list, even
though it is split across two applications. Not a hand-synced map.

**The current state, which is the bug.** The catalog names providers with its own
slugs in `aggregators[].provider`; claudish names them in `BUILTIN_PROVIDERS`.
They disagree, and the bridge is `FIREBASE_SLUG_TO_PROVIDER_NAME`
(`model-loader.ts:281`) — **10 entries against 18 catalog slugs**, hand-written,
and missing `anthropic`, `openrouter`, `together-ai`, `fireworks`, `ollamacloud`,
`opencode-zen`.

A missing entry produces no error. The derived chain names a provider
`getProviderByName()` cannot resolve, the candidate is filtered out, and the
route vanishes silently — the same silent-failure class CLAUDE.md documents for
`BUILTIN_PROVIDERS` / `PROVIDER_PROFILES`.

Note the plans table already does this correctly: `routing.providerUid` and
`routing.prefix` publish claudish's OWN vocabulary (`qwen-cloud`/`qc`,
`grok-subscription`/`gk`). The aggregator side does not. Making one side of the
same document speak claudish's names and the other speak the catalog's is the
inconsistency to remove.

**Sub-problem to resolve with it.** `native-anthropic` is one claudish provider
with two billing modes: the `anthropic-claude-code` plan's `routing.providerUid`
AND the metered Anthropic API. Today `"claude-*": ["native-anthropic",
"openrouter"]` expresses "subscription or metered, whichever the user has" in one
token. A catalog-derived chain has to say that explicitly, or `claude-haiku-3`
loses its metered route — which the gate measured.

## 4. The `"*"` catch-all belongs to `defaultProvider`, not to routing rules

**Decision.** A static route for `*` is a signal that the logic is in the wrong
place. claudish already has the right mechanism: a per-user default fallback
provider, OpenRouter by default. Remove `"*": ["openrouter"]` from the rules.

**One correction before implementing.** `defaultProvider` is
`defaultProvider?: string` (`profile-config.ts:204`) with **no default value**.
It is unset unless the user configures it. `routeBare` appends it only when set.

So this is two changes, not one:

1. make `defaultProvider` default to `openrouter`;
2. then delete `"*": ["openrouter"]`.

Deleting the rule alone leaves any uncovered model with no route.

**Why it matters at this size:** 341 of 737 catalog entries have no `openrouter`
aggregator row. Under a catalog-derived chain those get no OpenRouter unless
`defaultProvider` supplies it. With it, the gate's non-dynamic losses fall from
440 to 202.

## 5. The 202 remaining losses are the point, not a regression

**Decision.** Glob default routes go away. A user may still write globs, and what
happens then is the user's responsibility.

**What the 202 are.** Today `"deepseek-*": ["opencode-zen-go", "deepseek",
"openrouter"]` puts the Go plan at the head of the chain for every one of ~40
`deepseek-` models. The Go plan actually serves 33 models in total, most of those
variants not among them. So `deepseek-r1-distill-qwen-7b` currently sends a
request to Zen Go, gets `401 {"type":"ModelError"}`, and — because that status is
retryable — falls through to `deepseek`. One wasted round trip per call.

Under the refactor the Go plan appears only for models it actually serves. Those
~200 models "lose" it and should. `default-routing-rules.ts` predicted exactly
this: *"the catalog join now drops known-unserved Go models"*.

**The residual risk, kept explicit.** A missing membership row is
indistinguishable from genuine non-membership. v9.0.4 is the proof: providers
looked correctly dropped and were not, because the covering plan
(`alibaba-ai-coding-plan`) had no `routing` block and was invisible. So the
losses are expected but not self-certifying, and the guard added in v9.0.4
(withhold `not-served` when a same-vendor plan is unroutable) has to survive the
refactor.

## Implementation order

1. `defaultProvider` defaults to `openrouter`; delete the `"*"` rule (§4).
2. Single provider vocabulary across claudish and models-index (§3) — this is the
   one that spans both repos and should be agreed with the backend first.
3. Runtime probe for `client` and `hybrid` plans, cached, feeding chain
   construction (§1).
4. Normalizer for `includedModels` as a secondary signal (§2).
5. Delete the glob defaults; re-run the gate (§5).
