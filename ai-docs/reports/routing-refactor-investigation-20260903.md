# Routing refactor: investigation results

Answers four open questions with measurements rather than opinion. Measured
against `~/.claudish/all-models.json` on 2026-09-03 (737 entries, 19 plans,
1112 aggregator rows).

---

## 1. Guessing the real model from an unmaintained alias

**The question.** A dynamic subscription returns a roster of its own ids. Nobody
maintains a mapping and the provider can change them at any time. We need a rule
that recovers the catalog model from the alias alone.

### The evaluation set

Every `aggregators[].externalId` in the catalog is a labelled pair — the alias a
provider uses, and the model it really is. Hide the label, run the matcher, count
how often it recovers the truth. That gives a real accuracy figure.

1112 rows carry an `externalId`. 407 are trivial (alias equals the model id).
**705 are the real test.**

### The matcher

Generate candidate keys from the alias, take the first that hits a catalog id.

```
canonical(s)   lowercase; drop everything before the last "/"; drop "(...)";
               whitespace and "_" to "-"; collapse repeats
numeric forms  glm-5-2 <-> glm-5.2   (only when both groups are pure digits)
strip suffix   -highspeed -thinking -reasoning -instruct -preview -medium
               -256k -1m -high -fast -mini -low -max -pro :cloud
strip date     claude-opus-4-5-20251101 -> claude-opus-4-5
add vendor     k3 -> kimi-k3   (vendor token derived from the provider)
refuse         anything ending in "latest" — a pointer, not a name
```

### Result

| outcome | count | rate |
|---|---|---|
| recovered correctly | 600 | **85.1%** |
| **wrong model** | **1** | **0.1%** |
| declined, no match | 104 | 14.8% |

The one error is unresolvable by any rule: `qwen/qwen3.8-flash` truly means
`qwen3.8-flash-next`, while a catalog model named `qwen3.8-flash` also exists.
Two models, one alias.

### The design principles that produced that ratio

These matter more than the percentage, because they are what keeps it safe as
the data drifts.

**Strip, never add.** Stripping a suffix generalises (`kimi-k3-256k` ->
`kimi-k3`) and lands on a real id or nothing. Adding one guesses a more specific
model. Several declines are cases where the truth carries a suffix the alias
lacks (`gemini-3-flash` -> `gemini-3-flash-preview`). Recovering those by adding
`-preview` would raise recall and start producing wrong matches. Not worth it.

**Refuse pointers.** `-latest` names a moving target. Guessing it produced the
`mistral-large-latest -> mistral-large` error; declining removed it and cost
nothing else.

**Decline on ambiguity.** If more than one catalog id is reachable, return
nothing.

**Failure is asymmetric, so tune for precision.** A decline costs catalog
enrichment — context window, pricing, tier. A wrong match sends the user's
request to a different model. Those are not comparable, so the matcher must
prefer silence.

### What to do with a decline

Keep the model usable through its explicit address (`kc@k3` works regardless),
but do not claim it is a catalog model. Missing metadata is a degraded
experience; a wrong identity is a wrong answer.

### Caveat on the evaluation

The set is aggregator aliases, which is the closest labelled proxy available. A
live subscription roster may skew differently — antigravity's effort-suffixed
ids (`gemini-3.6-flash-high`) are absent from the catalog entirely, so they are
not represented here. The suffix-strip rule covers that shape, but it is
untested against real roster data because probing needs credentials.

---

## 2. What the `includedModels` problem actually is

Restated plainly, because the earlier write-up was not clear.

**The question being answered:** does plan P include model M?

**Source 1 — `entry.subscriptionPlans`.** A list of plan IDs stored on the model.

```
glm-5.3   subscriptionPlans = [ollama-cloud, opencode-go, z-ai-glm-coding-plan]
```

These are IDs. They match plan IDs exactly. Nothing to interpret.

**Source 2 — `plan.includedModels`.** A list of strings stored on the plan.

```
z-ai-glm-coding-plan   includedModels = ["GLM-5.3", "GLM-5.3-Flash"]
```

The problem is that these are **not IDs**. They are whatever text describes the
plan's contents, and the vocabulary is mixed:

| string in `includedModels` | what it is | matches a model id? |
|---|---|---|
| `claude-opus-5` | a model id | yes |
| `GLM-5.3` | display name, same as the id but capitalised | after lowercasing |
| `Gemini 3.6 Flash` | display name with spaces | no — id is `gemini-3.6-flash` |
| `Claude Opus 4.6 (thinking)` | display name plus a mode | no |
| `k3`, `kimi-for-coding` | the plan's OWN wire ids | no — that is the `externalId` side |
| `MiniMax image model family` | a family description | no — names no single model |
| `account-specific Grok subscription roster` | prose | no — deliberately |
| `wan2.7-image`, `kimi-k2.5` | ids of models absent from the catalog | no |

**Measured** over the 12 plans that carry a `routing` block (the only ones
claudish uses), 138 strings:

| | count | rate |
|---|---|---|
| match as an exact id | 81 | 59% |
| match after normalizing | 102 | **74%** |
| unresolved | 36 | 26% |

Normalizer: lowercase, drop `(...)`, drop `:suffix`, spaces to hyphens.

**The conclusion.** The 26% that fails is mostly not a matching problem — it is
models the catalog does not carry, wire ids, and prose. No matcher fixes those.
So `includedModels` can be a **secondary** signal worth 15 extra points, but it
can never be authoritative. `entry.subscriptionPlans` stays primary because it is
IDs joined to IDs.

**The trap worth naming.** The normalizer matches GLM and fails Gemini. Test it
on GLM alone and it looks correct. That is the same shape as the v9.0.1 bug: a
lookup that passes the case you check and fails the case you do not.

---

## 3. One provider list — proposal

### Measured divergence

18 aggregator slugs in the catalog; 33 providers in claudish's
`BUILTIN_PROVIDERS`; 11 plan `routing.providerUid` values.

**14 of 18 slugs already match a claudish provider by name.** The gap is four:

| slug | claudish | nature |
|---|---|---|
| `anthropic` | `native-anthropic` | claudish renamed the vendor |
| `moonshotai` | `kimi` | claudish renamed the vendor |
| `fireworks` | *(none)* | claudish does not implement it |
| `together-ai` | *(none)* | claudish does not implement it |

So this is not a large mapping problem. It is **two renames and two unsupported
providers.**

### The decisive observation

The same document already speaks claudish's vocabulary — on the plan side:

```json
"routing": { "providerUid": "grok-subscription", "prefix": "gk",
             "nativeModelProviders": ["x-ai"] }
```

`providerUid` and `prefix` are claudish's own names and provider shortcuts. The
backend already publishes them, deliberately, for 11 plans — including
`antigravity`, `opencode-zen-go` and `qwen-cloud`, which the aggregator side
never mentions at all.

So the coupling the backend would supposedly be taking on **already exists**. One
half of the payload speaks claudish; the other speaks vendor slugs. That
inconsistency inside a single document is the actual defect.

### Proposal

**Primary — backend.** Add `providerUid` to `aggregators[]` rows, exactly as
`plans[].routing` already has it. For 14 of 18 it equals the existing `provider`
value, so the change is small; for `anthropic` and `moonshotai` it carries the
rename; for `fireworks` and `together-ai` it is omitted, which tells claudish
plainly "no client route" — the same signal a plan with no `routing` block gives.

That removes the client-side map entirely for anything the backend knows about,
and it makes one document internally consistent.

**Secondary — claudish.** Fold `FIREBASE_SLUG_TO_PROVIDER_NAME` into the provider
definitions as a `catalogSlugs` field on each `BUILTIN_PROVIDERS` entry, rather
than keeping a separate table. CLAUDE.md already records that
`BUILTIN_PROVIDERS` plus `PROVIDER_PROFILES` must be edited together or routing
fails silently; a third hand-synced table is the same defect again. Putting the
slug next to the provider means one edit, and a new provider cannot be added
without declaring it.

**Both — make a miss loud.** Today an unmappable slug produces a candidate
`getProviderByName()` cannot resolve, it is filtered out, and the route vanishes
with no message. Whatever the mapping mechanism, an unknown slug for a model the
user asked for should be logged. Silence is the part that made this expensive.

The secondary is worth doing even if the backend ships the primary: cache and
client versions skew, and the client needs a defined answer during that window.

---

## 4. `defaultProvider` — confirmed, it is a settings gap

`profile-config.ts:204` declares `defaultProvider?: string`. `DEFAULT_CONFIG`
(`profile-config.ts:250`) does not set it. `routeBare` appends it only when set
and non-empty (`routing-rules.ts:402`).

So today there is **no default fallback provider**. The only reason an uncovered
model routes anywhere is the `"*": ["openrouter"]` rule in
`DEFAULT_ROUTING_RULES`. Remove that rule without setting the config value and
the model does not fall back — it fails with "No routing rule matched".

**Fix:** set `defaultProvider: "openrouter"` in `DEFAULT_CONFIG`, then delete the
`"*"` rule. Two changes, in that order.

**Scale:** 341 of 737 catalog entries have no `openrouter` aggregator row, so
under a catalog-derived chain those depend entirely on this setting.

**One thing to check when implementing.** `loadConfig` merges
`config.defaultProvider` only when it is not `undefined`
(`profile-config.ts:341`), so a value in `DEFAULT_CONFIG` must survive that merge
path rather than being overwritten by an absent user value. CLAUDE.md's warning
about `loadConfig`'s allowlist applies to the same function.
