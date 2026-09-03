# Subscription routing client implementation and live verification

**Date:** 2026-09-02

**Audience:** Claudish maintainers

**Status:** **DELIVERED AND RELEASED — but the release carried a CRITICAL
regression, reverted in v9.0.3. Read the correction below before this report.**

> ## Correction, 2026-09-03
>
> The routing change this report delivers shipped a regression that survived
> v9.0.1 and v9.0.2 on npm `latest`.
>
> `loadRoutingRules` merged catalog-derived rules into the same dictionary as
> `DEFAULT_ROUTING_RULES`. Catalog keys are exact model ids; default and user
> keys are globs; `matchRoutingRule` returns on the first exact hit. So each
> catalog key made the matching glob unreachable and deleted every provider the
> catalog had not named. Measured on a real cache, `grok-4.6` became
> `["opencode-zen-go@grok-4.6"]`, leaving a user holding `XAI_API_KEY` and
> `OPENROUTER_API_KEY` with no route at all. User rules written as globs — the
> documented style — were shadowed the same way, silently.
>
> The verification below is not wrong about what it checked. It checked the
> backend contract and the client's consumption of it, both of which were
> correct. It did not check the resulting route for any model, which is where
> the defect was.
>
> v9.0.3 removes the catalog from the rules dictionary and restores v9.0.0
> routing. The catalog data itself was already consumed safely elsewhere
> (`resolveSubscriptionRouting`, `providerServesModel`), and the design for
> doing it properly is in
> `routing-from-the-catalog-alone-20260903.md`.

**Models Index release:** `v1.2.12`

**Claudish release:** `v9.0.1`

This report closes the implementation work unblocked by
`backend-contract-validation-20260902.md`. It supersedes that report's “Three
things are now unblocked” and “Residual gaps” sections: the client work is
implemented, the backend residuals are addressed, both repositories are merged
and released, and the resulting contract has been checked against production.

The earlier report remains useful as the independent acceptance review of the
backend's `v2.1.0` contract. This report is the delivery record for the work that
followed it.

---

## Executive verdict

The subscription-routing split is now implemented end to end:

1. `subscriptionPlans[]` contains **commercial plan IDs**.
2. `/queryPlans[].routing.providerUid` maps each plan to a **Claudish routing
   provider**.
3. `/queryPlans[].modelDiscovery` states whether static catalog absence is
   authoritative or whether the authenticated client owns the roster.
4. `recommended.models[].subscriptions[]` carries the backend's preferred route
   order, declared `tier`, routing provider, plan IDs, and exact command.
5. Claudish consumes those fields directly and keeps its bundled route rules as
   cold-cache and uncovered-model fallback only.

This fixes the shared cause of the old defects. Claudish no longer compares a
plan ID such as `openai-codex` or `opencode-go` to a provider UID and hopes the
strings happen to match. It also no longer treats absence from a shared static
catalog as proof that an account-scoped provider such as Devin, Antigravity, or
SuperGrok cannot serve a model.

No additional client implementation is required for this feature.

---

## Delivery chain

| Surface | Pull request | Merge commit on remote `main` | Release | Result |
|---|---|---|---|---|
| Models Index | [#75](https://github.com/MadAppGang/models-index/pull/75) | `3c49173fdfcef59c23ddcc22dff603e17bedfc9f` | [v1.2.12](https://github.com/MadAppGang/models-index/releases/tag/v1.2.12) | deployed |
| Claudish | [#228](https://github.com/MadAppGang/claudish/pull/228) | `ad7b79b918a1af106237d43021b946f381bd26b5` | [v9.0.1](https://github.com/MadAppGang/claudish/releases/tag/v9.0.1) | GitHub, npm, and Homebrew published |

Both tags resolve to the exact current remote-main commit in their repository.
The feature-branch and squash-merge diffs have identical stable patch IDs:

- Models Index: `71ae32a10e5ef45842d2dc9792e4f35245f57cc6`
- Claudish: `85515f7a1b91617d42fcf18ed831cb6ab4a4e03d`

This matters because a merged PR state alone does not prove that the tested
feature patch is the one that was tagged and released. Here it is.

---

## What changed in Claudish

### 1. `queryPlans` is cached beside the slim model catalog

The version-2 `~/.claudish/all-models.json` cache now has an additive `plans`
projection containing only what synchronous routing needs:

- plan ID;
- `modelDiscovery`;
- `routing.providerUid`;
- routing prefix and native-owner metadata where present.

The model and plan requests are deliberately independent:

- a model refresh still succeeds when `/queryPlans` fails;
- a plan failure preserves the previous last-known-good plan projection;
- legacy caches without `plans` retain their old behavior until refreshed;
- `CLAUDISH_PLANS_URL` can override the plan endpoint for integration tests and
  controlled deployments.

Primary files:

- `packages/cli/src/providers/catalog-client.ts`
- `packages/cli/src/providers/all-models-cache.ts`
- `packages/cli/src/providers/all-models-cache.test.ts`

### 2. Plan IDs are joined to provider UIDs explicitly

`resolveSubscriptionRouting(modelId, providerUid)` now resolves the provider's
commercial plans through cached `queryPlans`, then checks the model's
`subscriptionPlans[]` against those plan IDs.

The resulting behavior is intentionally conservative:

| Cache/contract state | Result |
|---|---|
| Membership exists and the provider aggregator supplies an exact wire ID | `serves(externalId)` |
| Membership exists but no exact provider wire ID is known | `unknown`; never invent an ID |
| A catalog-discovered plan has published roster coverage and this model is absent | `not-served` |
| A client- or hybrid-discovered plan is absent from slim | `unknown`; authenticated discovery decides |
| `queryPlans` is newer but slim has zero membership coverage for that provider | `unknown`; protects staggered rollouts |
| Legacy cache has no `plans` projection | previous provider-UID behavior |

The “published roster coverage” guard is important. `/queryModels` and
`/queryPlans` are separate requests, so during a rollout a client can briefly
pair a new plan contract with an old slim snapshot. Static absence becomes
authoritative only after the same cache demonstrates at least one membership
row for that provider's plans. Without this guard, a newer plan response could
temporarily make every OpenAI or Anthropic model look unsupported.

Primary files:

- `packages/cli/src/adapters/model-catalog.ts`
- `packages/cli/src/providers/routing-rules.ts`
- `packages/cli/src/providers/routing-rules.test.ts`

### 3. Backend routes now drive client preference

Claudish now consumes the backend's recommended route objects directly:

- `tier` controls preference: `native`, `general`, `metered`, `aggregator`;
- `routingProvider` chooses the Claudish provider;
- `command` supplies the exact backend-selected wire model;
- `planIds[]` retains the commercial-plan identity behind one callable route.

Routes are sorted by declared tier. A backend exact route replaces the bundled
route for the same provider/model. `DEFAULT_ROUTING_RULES` remains available for
cold caches and models the recommendation catalog does not cover, but it is no
longer the primary owner of route preference.

An unknown future `routingProvider` is ignored rather than allowed to shadow a
working installed fallback. This makes backend and client releases safely
staggerable in both directions.

Primary files:

- `packages/cli/src/model-loader.ts`
- `packages/cli/src/model-loader.test.ts`
- `packages/cli/src/providers/default-routing-rules.ts`
- `packages/cli/src/providers/default-routing-rules.test.ts`

### 4. Client-owned rosters remain client-owned

The backend can declare a commercial plan and routing provider without claiming
to know an account's exact entitlement. Claudish keeps its authenticated model
discovery for these providers:

- `cognition-devin` → `devin` → `modelDiscovery: "client"`
- `google-antigravity` → `antigravity` → `modelDiscovery: "client"`
- `xai-supergrok` → `grok-subscription` → `modelDiscovery: "client"`

For these plans, no static slim membership is required and static absence is
never converted to `not-served`.

---

## Backend follow-through that the client now relies on

Models Index `v1.2.12` completed the backend side of the join:

- projects catalog and hybrid plan rosters into each model's canonical
  `subscriptionPlans[]`;
- applies the projection to newly collected rows and active/preview rows
  preserved from earlier successful owner collections;
- removes stale classified membership while preserving explicit legacy plans
  whose discovery mode has not yet been classified;
- uses the previous successful plan snapshot when a plan collector fails;
- rejects recommendation routes whose `planIds[]` disagree with slim
  membership;
- rejects static routes for client-discovered plans;
- publishes the canonical OpenAI Codex `subscriptionPlans` field while keeping
  the old collector field only as a deprecated compatibility input;
- documents StreamLake's missing routing join as intentionally partial;
- documents that catalog presence and recommendation curation are different,
  and that versioned model IDs can legitimately be distinct records.

The membership projection has an idempotence invariant: re-projecting the
published result must be a no-op. It also rejects references to inactive plans
and any static membership assigned to client-discovered plans.

---

## SuperGrok contract

The new live plan is:

```text
plan id:            xai-supergrok
provider:           x-ai
routing provider:   grok-subscription
prefix:             gk
discovery:          client
native owners:      x-ai
```

The plan intentionally publishes an account-specific roster description rather
than fabricated model IDs. Exact callable models are fetched after the user
authenticates.

Published price points are Free `$0`, SuperGrok `$30/month`, and SuperGrok Plus
`$100/month`. Sources are xAI's own pages:

- <https://x.ai/pricing>
- <https://x.ai/news/grok-build-cli>
- <https://x.ai/news/grok-kilocode>

---

## Production verification

### Deployed versions

| Readback | Live value |
|---|---|
| `/queryVersion` | `1.2.12` |
| function deployment revision | `queryversion-00034-zes` |
| `/queryOpenApiSpec.info.version` | `1.2.12` |
| portal `/version.json` | `1.2.12` |
| recommended contract version | `2.1.0` |
| npm `claudish` latest | `9.0.1` |
| Homebrew tap formula | `9.0.1` |

The OpenAPI schema now documents `subscriptionPlans` as canonical plan IDs that
must be joined to `queryPlans`; they are explicitly not provider UIDs.

### Fresh catalog collection

A manual collection was run only after the deployment completed. The shared
Firestore lease prevented overlap with any scheduled or manual collection.

```json
{
  "ok": true,
  "modelsCollected": 3666,
  "modelsMerged": 1246,
  "plansWritten": 19,
  "recommendedModels": 34,
  "algoliaIndexed": 1832,
  "collectorsOk": 59,
  "collectorsFailed": 0,
  "durationMs": 106277,
  "errors": []
}
```

### Slim membership

The cache-bypassed slim read returned 743 routable models. Seventy rows carry at
least one plan membership.

Relevant authoritative memberships:

- `openai-codex`: 6 models;
- `anthropic-claude-code`: 11 models.

Dynamic-plan violations:

```text
cognition-devin static slim rows:      0
google-antigravity static slim rows:   0
xai-supergrok static slim rows:        0
```

That is the required result, not missing data. Their signed-in rosters are
account-scoped.

### Recommended routing

The current production recommendation payload contains:

```text
models total:                    34
subscription-category models:   14
subscription routes:            32
native routes:                  12
general routes:                 14
metered routes:                  6
```

Regression results:

```text
retired Gemini Code Assist routes:   0
invented Devin routes:               0
native-first order violations:       0
subscription/subscriptions[0] drift: 0
```

The production invariant checker reported:

```text
plan-served slim models:          70
plan-served recommended models:   14
coverage violations:              0
route-contract violations:        0
inactive-plan membership:         0
```

Result: `PASS: subscription coverage, route order, provider mappings, and plan lifecycle are valid`.

### Authenticated client discovery

Read-only roster discovery was run after the local client cache had been
refreshed. No inference request was sent and no model usage was billed.

| Provider | Auth state | Discovered account roster |
|---|---|---:|
| Devin | OAuth ready | 193 models |
| Antigravity | OAuth ready | 19 models |
| Grok Subscription | OAuth ready | 2 models |

The first Devin attempt returned an empty fail-soft result. A direct retry of
its capability and entitlement RPCs returned `193 / 193`, and the normal
discovery path then returned all 193 models. This was transient upstream/RPC
behavior, not a stale credential or code regression. Importantly, the contract
returned `unknown` during the transient absence rather than falsely returning
`not-served`.

The Grok account currently reports `grok-4.6` and `grok-4.5`. Those are observed
account results, not values written into either repository.

---

## Verification and CI

### Models Index

- structural subscription check: 8/8 passed;
- functions: 1,142 tests passed, 0 failed, 4,258 assertions;
- functions build: passed;
- web lint/typecheck: passed;
- web production build: passed, 1,701 modules;
- PR CI: [passed](https://github.com/MadAppGang/models-index/actions/runs/33634290633);
- post-merge CI: [passed](https://github.com/MadAppGang/models-index/actions/runs/33634470822);
- deployment/release/live verification: [passed](https://github.com/MadAppGang/models-index/actions/runs/33634580709).

### Claudish

- focused affected suite: 129 tests passed, 0 failed, 281 assertions;
- typecheck: passed for CLI and macOS bridge;
- production build: passed for CLI and bridge;
- PR hermetic typecheck/lint/tests: [passed](https://github.com/MadAppGang/claudish/actions/runs/33634289098);
- post-merge hermetic typecheck/lint/tests: [passed](https://github.com/MadAppGang/claudish/actions/runs/33634603093);
- four-platform binary build, GitHub Release, npm publish, and Homebrew update:
  [passed](https://github.com/MadAppGang/claudish/actions/runs/33634793937).

The broad local suite under Bun `1.4.0` reported 3,078 passing, 17 skipped, and
five failures. The same five failures reproduce on untouched `origin/main`:

- three team-cancellation `EPIPE` cases;
- two Unicode-width fallback cases.

The repository's pinned Bun `1.3.10` hermetic CI passed after all feature
changes. See `bun-140-test-breakage-20260902.md` for the separate environment
report.

The Claude PR reviewer did not run because the organization's overage-spend
limit was exhausted. It left no code finding. This is separate from the real
test, security, build, merge, and release checks above, all of which passed.

---

## Acceptance matrix

| Requirement | Result | Evidence |
|---|---|---|
| Join plan IDs to provider UIDs | **PASS** | cached `/queryPlans.routing.providerUid` |
| Consume declared tier instead of guessing order | **PASS** | 32 live routes, 0 native-first violations |
| Consume exact backend route commands | **PASS** | recommended route builder and tests |
| Keep bundled rules only as fallback | **PASS** | backend exact routes override matching defaults |
| Preserve client-discovered roster semantics | **PASS** | 0 static client-plan rows; 193/19/2 live discoveries |
| Protect staggered plan/model rollout | **PASS** | zero-coverage activation guard and tests |
| Preserve plans when plan fetch fails | **PASS** | last-known-good cache tests |
| Remove stale Gemini and invented Devin routes | **PASS** | 0 `go@`, 0 `dv@` production routes |
| Publish OpenAI and Anthropic membership | **PASS** | 6 and 11 live slim memberships |
| Add SuperGrok without a fabricated roster | **PASS** | `modelDiscovery: client`, OAuth roster discovery |
| Clarify StreamLake's missing join | **PASS** | documented as partial by design |
| Release backend and client | **PASS** | `v1.2.12` and `v9.0.1` live |

---

## Developer rules going forward

1. Never compare `subscriptionPlans[]` directly to a Claudish provider name.
   Join through `/queryPlans`.
2. Never infer unsupported from static absence when `modelDiscovery` is
   `client` or `hybrid`.
3. Never manufacture a wire ID from a catalog owner ID. Use the provider's
   aggregator `externalId`, a backend exact recommendation command, or return
   `unknown`.
4. Treat `tier` as semantic truth and array order as its serialized
   consequence.
5. Keep `DEFAULT_ROUTING_RULES` for compatibility, not as the owner of current
   subscription preference.
6. Ignore backend providers newer than the installed client until the client
   knows how to instantiate them; do not let them shadow a working fallback.
7. Preserve the last-known-good plan projection when only `/queryPlans` fails.

---

## Non-blocking local observations

### Display-only refresh command

`claudish --models-top --models-refresh` refreshes the recommended-model display
cache and exits during argument handling before the normal launcher slim-cache
warm step. The help text describes `--models-refresh` more broadly as a slim
catalog refresh. This behavior predates this feature and does not affect normal
session startup or the 24-hour routing-cache TTL, but the wording/behavior is a
reasonable separate cleanup ticket.

For this delivery, the actual routing cache was refreshed through the shipped
catalog client using cache-bypassed endpoints. The local cache now contains:

```text
cache schema:  2
slim entries:  743
plans:         19
```

### Two local installations

The active executable is `/Users/jack/.bun/bin/claudish` and reports `9.0.1`.
An older inactive Homebrew `8.1.0` keg remains installed, but it does not win
`PATH`; the published Homebrew formula itself is now `9.0.1`. Removing the old
keg is package-manager housekeeping, not part of this feature.

---

## Final handoff

The client developer should not add another static plan roster, route-order
table, or plan/provider alias for this work. The necessary knowledge is now
owned by the correct layer:

- commercial plan and preference metadata: Models Index;
- provider implementation and authenticated entitlement: Claudish;
- account-specific model roster: provider's live authenticated endpoint;
- compatibility when remote and client releases are staggered: Claudish
  last-known-good cache and bundled fallback rules.

The feature is complete and usable on the current machine with Claudish
`v9.0.1` and a freshly populated 19-plan cache.
