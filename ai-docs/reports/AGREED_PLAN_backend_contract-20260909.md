# Agreed plan: models-index catalog contract

**For:** the models-index backend developer
**From:** claudish, 2026-09-09
**Supersedes:** `BACKEND_TASKS-20260904.md`, `REVIEW_backend_implementation_plan-20260909.md`,
and the second-round review of `gleaming-discovering-marble.md`. Work from this file.

This is claudish's consolidated position, not a signed agreement. It reconciles two
review rounds into one ordered list so nothing has to be cross-referenced. Where the
two rounds differed, this file states which one governs and why.

**Every claim citing source was verified by reading it.** Citations are `file:line`
against `models-index` at `origin/main` and claudish at
`.claude/worktrees/nok3`. Claims about vendor behaviour are attributed, not
re-verified. Nothing was deployed, mutated, or inferred against.

---

## Where the two review rounds disagreed

One item, and it is factual rather than a difference of judgement.

**R1's failure mechanism is wrong for claudish.** Round two describes a client that
"receives complete coverage from B and model memberships from A". claudish cannot do
that. It fetches a single endpoint — `packages/cli/src/model-loader.ts:257`:

```
const FIREBASE_BASE_URL = "https://us-central1-claudish-6da10.cloudfunctions.net/queryModels";
```

and that one response carries both `.entries` and `.plans`. There is no client-side
join across two requests.

**The finding survives; the mechanism moves.** The risk is that one `queryModels`
handler reads two Firestore collections without a consistent snapshot, so a *single*
response can be internally inconsistent. That is worse, because the client has no way
to detect it. The recommended fix is unchanged.

Everything else layers cleanly. Round two is stronger on contract semantics; round one
carries the live client evidence. Where they overlap, round two governs — it is
strictly more general in every case (R3 over B1, R6 over N3).

---

## P1 — blocking. Settle these in the contract before implementation

### 1. The membership join has no provider or route scope

**Verified.** `models-index/functions/src/subscription-plan-membership.ts:110`:

```ts
const keys = new Set(
  [model.modelId, model.displayName, ...model.aliases]
    .flatMap(subscriptionPlanModelIdentityKeys),
);
const matchedPlanIds = [...keys]
  .flatMap(key => [...(planIdsByModelKey.get(key) ?? [])]);
```

`planIdsByModelKey` is a global index built from every plan's `includedModels`. The
lookup keys include **every alias of every model**. Any alias colliding with a plan's
included-model string attaches that model to that plan.

**Why it is first.** `entry.subscriptionPlans` is the field claudish treats as
authoritative — `packages/cli/src/adapters/model-catalog.ts:320`:

```ts
const hasMembership = entry.subscriptionPlans?.some((planId) => providerPlanIds.has(planId));
```

A collision here produces a wrong `serves` in claudish, which routes a request to a
subscription the user does not hold. No downstream validator catches it: a
`(routeRef, externalId)` collision check does not help while the projection still
reads the unscoped index.

**Required correction.** Reconciliation produces validated, plan-scoped canonical
membership sets, and the merger, writer and query projection consume those exact sets.
Public structured refs may stay informational; the internal authoritative join must
consume validated identities. Preserve prior validated membership during a failed
refresh rather than rebuilding from arbitrary aliases.

Also define whether `planIds[]` applies one roster to every listed plan. If Personal
and Team rosters differ, emit plan-specific snapshots rather than spreading a
route-wide union across both.

**Regression tests.** A global alias from another provider colliding with a plan wire
id must not attach. A Team-only member must not reach Individual. An unresolved entry
in an otherwise complete upstream list, and an ingress-rejected model, must both
prevent `completeness: complete`.

### 2. One vendor name is carrying two billing paths

**Verified, with a live claudish consequence.** The plan assigns `anthropic` to the
direct API route and to the Claude subscription plan, while each registry entry holds
exactly one `kind: api | subscription`.

On the claudish side that collapse is already load-bearing.
`packages/cli/src/handlers/shared/remote-provider-types.ts:148` and `:251`:

```
SUBSCRIPTION_PROVIDERS         -> native-anthropic ABSENT
CREDENTIAL_DECIDED_PROVIDERS   -> new Set(["openai-codex"])
```

So claudish classifies `native-anthropic` as metered, correctly, because
`packages/cli/src/providers/routing-rules.ts:318` records that it requires an explicit
`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`. The catalog meanwhile uses
`native-anthropic` as a **subscription plan's** `routing.providerUid`.

CLAUDE.md states the outcome: *a provider absent from `SUBSCRIPTION_PROVIDERS` quotes
flat-rate users a per-token price and accrues fictional spend.*

**Required correction.** Keep `catalogProviderId: anthropic` for vendor identity, and
give the API and subscription execution paths **distinct stable route keys**. Define
each key's adapter, authentication and billing scope even though executable details
stay client-owned. Preserve the old `providerUid` for compatibility only.

**This supersedes round one's B1.** B1 asked only which spelling of the vendor name
wins. That question still resolves the same way — claudish adopts the catalog's slugs,
so the mapping table collapses to identity — but it was the smaller half of the
problem. Agreeing on a vendor name does not entitle two routes to share an identity.

**Also clarify** whether the registry is catalog-wide or a claudish capability view.
Omitting `fireworks` and `together-ai` purely because claudish lacks adapters mixes
those meanings. A catalog-wide registry can name a route no particular client can
execute.

**Regression test.** The API aggregator and the Claude subscription plan resolve to
distinct route entries and cannot exchange credentials, billing classification or
entitlement by sharing a vendor name.

### 3. The Codex roster rests on an API-eligibility predicate

**Verified.** `models-index/functions/src/collectors/scraper/openai-codex-models.ts:88`:

```ts
model.supported_in_api === true &&
model.visibility !== "hide"
```

applied to a file fetched from
`raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json` —
a checked-in repository file. That predicate is API eligibility. It does not establish
subscription entitlement or completeness. Upstream's own model manager treats the
remote catalog as account-, plan- and credential-dependent, with visible ChatGPT
catalogs taking authority over bundled metadata.

**Required correction.** Treat that file as identity and metadata evidence carrying no
authoritative negative coverage. Use client or hybrid discovery unless a separate
source establishes exhaustive coverage for the plan. Any centrally obtained
authenticated roster stays scoped to its account and must not become universal plan
truth.

**Adjacent, not raised in round two.** The same collector carries
`OPENAI_CODEX_FALLBACK_MODEL_SLUGS`, a hardcoded five-model list, feeding a
completeness claim. Your repo and your call — recording it because claudish holds the
inverse invariant: a default is a rule, never a pinned id.

**Regression tests.** A subscription-only model failing the API predicate; a remotely
available model absent from the bundled file; a stale bundled entry absent from the
account roster; two accounts with different access. None may receive universal
entitlement or exclusion.

### 4. Legacy compatibility and rollback preserve the false-exclusion paths

**Verified, both citations.**

`packages/cli/src/adapters/model-catalog.ts:307` — when `cache.plans` is absent the
legacy branch can return `not-served` via `isLegacySubscriptionPlan`.

`packages/cli/src/adapters/model-catalog.ts:335` — and this is the sharper half:

```ts
const hasPublishedProviderRoster = cache.entries.some((candidate) =>
  candidate.subscriptionPlans?.some((planId) => providerPlanIds.has(planId))
);
```

`.some()` means **one** membership row anywhere in the cache licenses the conclusion
that this provider publishes rosters, which then permits `not-served` for every other
model. The variable name asserts a completeness the code never checks.

**Required correction.** Separate old-client *readability* from new-client *decision*
compatibility. Old fields stay readable and positive identity mappings stay usable, but
a new reader must return `unknown` for any exclusion unsupported by explicit coverage
evidence — and rollback must preserve that even if every new field disappears.

**Scope note.** Fixing both branches is claudish's work, listed below. A backend
emulator cannot prove that an installed client honours a field it does not read, so the
delivery must not claim that backend-only publication changes client routing.

### 5. Publication consistency

**Mechanism corrected, see the disagreement section above.** The same route-registry
version does not identify the membership snapshot, and models and plans are written
separately even though claudish receives them in one response.

**Required correction.** Add a membership or publication revision independent of the
route-registry version. Define commit and read semantics so a partially written
revision cannot be served as complete — immutable staged data plus a committed pointer,
validated read retries, or a self-contained complete per-plan membership response. A
timestamp on an otherwise mixed read is not sufficient.

Negative verdicts require a matching membership revision and an exhaustive received
view. Define behaviour for pagination, filters, missing canonical models, and
interrupted publication. Unknown or mismatched evidence means unknown availability.

**Regression tests.** A read between plan and model writes; an interrupted write; a
limited or filtered model response. None may establish absence.

---

## P2 — required in this delivery, does not block starting

### 6. Freshness schema and evidence scope

`validUntil` must be required, not optional, whenever coverage is `complete`, together
with verification and source evidence. Define invalid and missing dates conservatively.
`checkedAt` must not advance the last successful observation time on a failed attempt.

**Replace the blanket authentication rule.** "Every unauthenticated refresh is partial"
conflicts with allowing exhaustive public official pages, and it is the wrong axis.
Authentication determines **evidence scope**, not completeness: a public source can be
exhaustive for a *product* while proving nothing about an *account*, and an
authenticated source can be account-specific and incomplete.

That generalisation replaces round one's per-plan Alibaba tripwire, which is the
special case. Keep an Alibaba regression fixture. claudish's own probe is the worked
example — `packages/cli/src/providers/provider-definitions.ts:1272`:

> Contrast `coding-intl`'s `/v1/models`, which serves the full roster to an
> unauthenticated caller — a 200 from THAT one proves nothing about a credential.

### 7. Redirects stay out of the alias field

Confirmed as already accepted. Recording the live evidence, because it strengthens the
case beyond the GLM example.

Measured on `~/.claudish/all-models.json` as served 2026-09-03: **three entries already
carry two aggregator rows for one provider with different ids.**

```
gemini-3.1-pro-preview  google       [gemini-3.1-pro-preview, gemini-pro-latest]
gemini-3.8-flash        google       [gemini-3.8-flash, gemini-flash-latest]
qwen3.5-2b-lora         together-ai  [Qwen/Qwen3.5-2B-Lora, qwen3.5-2b-lora]
```

`packages/cli/src/providers/catalog-client.ts:213` resolves by first array match, so
today's correct answer depends on the order your collectors emit. All three happen to
be right; nothing holds them there.

### 8. Seven Mistral models are addressable only by a moving pointer

New, from the same measurement.

```
codestral-2508                 mistralai  [mistral-code-fim-latest]
ministral-3-14b-instruct-2512  mistralai  [ministral-14b-latest]
ministral-3-3b-instruct-2512   mistralai  [ministral-3b-latest]
ministral-3-8b-instruct-2512   mistralai  [ministral-8b-latest]
mistral-large-2512             mistralai  [mistral-large-latest]
mistral-medium-2604            mistralai  [magistral-medium-latest]
mistral-small-2603             mistralai  [magistral-small-latest]
```

Each has a dated canonical id and no dated aggregator id, so claudish can only address
them by a name whose target moves.

The last two need checking beyond the pointer problem: **Magistral** appears to be a
different product line from **Mistral Medium/Small**, which would make those rows point
at the wrong family. Not verified against Mistral's current naming — an observation to
confirm, not a confirmed defect.

### 9. Thirty-three duplicate rows hold the same id twice

Same measurement: 36 `(entry, provider)` pairs carry more than one aggregator row, and
33 hold an identical `externalId` twice. Harmless to routing, and your alias validator's
"same-target duplicates deduplicate" rule should remove them. Flagged only so you can
confirm that path covers it.

---

## Confirmed as designed — do not relitigate

- Literal `routeStatus` naming, one spelling across producers and readers.
- Legacy provider names preserved through a coordinated rename.
- Redirects stored separately from aliases and from plan membership.
- No invented Alibaba Coding Plan adapter, and no reuse of Token Plan credentials.
- `routeStatus: "supported"` requires routing; `unsupported` and `unknown` forbid it.
  This is the strongest thing in the plan: it makes the contradictory state
  unrepresentable rather than merely discouraged.
- Fail closed on a first run with no complete or persisted evidence.
- Last successful data retained while effective coverage downgrades on refresh failure.
- No automatic alias deletion from failed authentication or incomplete discovery.
- Explicit recommendation diffs, emulator validation, no production deployment.

---

## Delivery order

1. Settle items 1–5 and encode their contract fixtures. Nothing else starts first.
2. Ship coverage authority, validated canonical membership, consistent publication and
   the public projection **together**. Splitting them re-opens item 1.
3. Add route identities, and separate redirects, against that contract.
4. Structured display references and daily alias monitoring last. They may be dropped
   from this delivery if they would delay the correctness work.

Keep the existing plan-retirement invariant and add retention: a successful complete
snapshot may retire absent plans; a failed required collection preserves last-known-good
with downgraded coverage. Test both, so preservation does not become permanent retention
of retired plans.

---

## What claudish owes

Not in your scope. Listed so neither side waits on the other, and so no acceptance
check is credited to a backend change it does not control.

| work | source | depends on |
|---|---|---|
| plan-scoped membership: stop unioning plans that share a route (`model-catalog.ts:303`) | item 1's client half | ours alone |
| replace the `.some()` roster test with real coverage evidence (`model-catalog.ts:335`) | item 4 | ours alone |
| billing classification for a subscription route distinct from the metered API route | item 2's client half | needs item 2's route keys |
| rank aggregator rows instead of taking the first (`catalog-client.ts:213`) | item 7 | ours alone, ships independently |
| read `routeStatus` and coverage; narrow the v9.0.4 guard | items 4, 6 | needs the contract published |
| a `coding-intl` provider, before the Alibaba plan can become supported | item 6 | ours alone, unscheduled |
| ship the alias matcher, measured at 85.1%, currently an evaluation script | — | independent |
| log unresolvable routes instead of dropping them silently | item 2 | ours alone |
| metered-fallback policy when coverage is unknown | — | product decision, not made |

---

## Acceptance criteria

Backend-side, provable in emulators:

1. A cross-provider alias colliding with a plan's included-model string does not attach.
2. A Team-only member does not reach an Individual holder.
3. An unresolved or ingress-rejected entry prevents `completeness: complete`.
4. The API route and the subscription route for one vendor are distinct keys and cannot
   exchange credentials or billing classification.
5. A subscription-only model failing the Codex API predicate is not excluded.
6. A read spanning an interrupted publication cannot establish absence.
7. `validUntil` is present whenever coverage is complete; `checkedAt` does not advance
   on a failed attempt.
8. No entry carries two aggregator rows for one provider with different ids, unless the
   second is explicitly marked a redirect.

Client-side, provable only against a real claudish build and a refreshed cache:

9. `qwen3.5-plus` still resolves `qwen-cloud` as `unknown`, not `not-served`.
10. `glm-4.5`, `glm-4.6` and `glm-4.7` stay absent from `z-ai-glm-coding-plan` membership.
11. A cache carrying none of the new fields routes exactly as it does today.
12. The recommended set is unchanged, or every change is deliberate.

Criterion 11 is the one most likely to be skipped and most likely to matter. Every user
is in that state on the first run after release.

---

## Closing

Both reviews found the same defect at different layers, which is the strongest argument
for the contract work. Round one found claudish unioning plans that share a route. Round
two found the membership data feeding it built by an equally unscoped join. Fixing
either alone leaves the other producing wrong answers from correct-looking inputs.

The shape that survives is the one already in the plan: make the invalid state
impossible to write down. `unsupported` forbids `routing`, so that pairing cannot
occur. Every item above is a place where the same discipline has not yet been applied.
