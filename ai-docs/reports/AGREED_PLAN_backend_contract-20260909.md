# Catalog Contract v3 — claudish's residual position

**Governing plan:** `Models Index Catalog Contract v3 — Final Architecture`
(`~/.claude/plans/gleaming-discovering-marble.md`). **That plan governs.** The backend
developer owns the models-index repo and v3 is their implementation plan for it.

**This file is the residual only** — what v3 does not close, plus claudish's own
migration. It is not a competing plan and nothing in it should be read as one.

**Superseded by v3, do not work from:** `BACKEND_TASKS-20260904.md`,
`REVIEW_backend_implementation_plan-20260909.md`, and the earlier revision of this file.

---

## What v3 already closes

Verified by reading v3 against the two review rounds. Seven of nine items, three of
them solved better than we specified.

| our item | v3 | where |
|---|---|---|
| unscoped membership join | deleted the mechanism — `includedModels` strings are gone; only `canonical_model` and mapped `provider_model` inclusions create membership | §2 line 83, §7 line 216 |
| one vendor name, two billing paths | `(routeId, routeProfileId)`; a profile selects an endpoint and credential silo and is never an alternate provider id | §2 line 41, §3 line 44 |
| legacy false-exclusion paths | eliminated; no v2 parser, no compatibility alias | §1 line 5 |
| publication consistency | immutable generations, sealed manifest, SHA-256, CAS activation, `generationId` pinned across pagination | §5 |
| freshness exposed | read-time `rosterCoverage` with `expiresAt`; expiry removes negative authority immediately | §5 line 161 |
| redirects out of the alias field | `ProviderModelRedirectV3`, with the Z.ai source URL and observation date | §2 line 92 |
| duplicate aggregator rows | same target dedupes; conflicting targets block the generation | §5 line 159 |

v3 also settles the rename in the direction we asked: `native-anthropic` and route id
`kimi` are **invalid**, canonical ids are `anthropic` and `moonshotai` (§1 line 5).

Three of these are stronger than the requirement. Generation pinning solves a read
consistency problem we only described. Route profiles solve an identity problem we had
only named. Deleting `includedModels` removes a defect class rather than guarding it.

---

## Open item 1 — the Codex roster still rests on an API-eligibility predicate

**v3 §3 lists:** `openai-codex | catalog | supported openai/codex-subscription |
live Codex registry, required 24h; mapped exact`.

`catalog` means absence proves absence. The source has not changed —
`models-index/functions/src/collectors/scraper/openai-codex-models.ts:88`:

```ts
model.supported_in_api === true &&
model.visibility !== "hide"
```

fetched from
`raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json`.

Fetching a repository file every 24 hours makes it **fresh**, not **exhaustive for a
subscription**. That predicate is API eligibility. Upstream's own model manager treats
the remote catalog as account-, plan- and credential-dependent, with visible ChatGPT
catalogs taking authority over bundled metadata.

This is precisely the distinction v3 §5 line 161 enforces everywhere else — and §6 of
the earlier review generalised it correctly: **authentication determines evidence scope,
not completeness.** A public source can be exhaustive for a product while proving
nothing about an account.

**Ask:** either `hybrid`, or a documented separate source establishing exhaustive
subscription coverage. Also note the collector carries
`OPENAI_CODEX_FALLBACK_MODEL_SLUGS`, a hardcoded five-model list, feeding a completeness
claim.

---

## Open item 2 — seven Mistral models are addressable only by a moving pointer

Measured on `~/.claudish/all-models.json` as served 2026-09-03. Not mentioned in v3.

```
codestral-2508                 mistralai  [mistral-code-fim-latest]
ministral-3-14b-instruct-2512  mistralai  [ministral-14b-latest]
ministral-3-3b-instruct-2512   mistralai  [ministral-3b-latest]
ministral-3-8b-instruct-2512   mistralai  [ministral-8b-latest]
mistral-large-2512             mistralai  [mistral-large-latest]
mistral-medium-2604            mistralai  [magistral-medium-latest]
mistral-small-2603             mistralai  [magistral-small-latest]
```

Each has a dated canonical id and no dated external id, so the only address moves.

The last two need checking beyond the pointer problem: **Magistral** appears to be a
different product line from **Mistral Medium/Small**, which would make those rows name
the wrong family. Not verified against Mistral's current naming — an observation to
confirm, not a confirmed defect.

---

## Open risk — the cutover assumes a client that can be updated

**v3 §9:** *"update clients first; enter maintenance; deploy v3-only code/rules"* and
*"No dual serving/write or converter exists."*

claudish is a CLI installed from npm. There is no mechanism to force an update, so some
users will run a v2-reading build indefinitely. "Clients must update before cutover" is
an assumption, not a step, and v3 does not mark it as one.

**Traced against the shipped resolver.** On cutover day, an un-updated claudish:

```
model-catalog.ts:303   plans.filter(p => p.routing?.providerUid === provider)
                       v3 plans carry `route: {routeId, routeProfileId}` — no `routing`
                       -> providerPlans = []
model-catalog.ts:316   -> { kind: "unknown" } for every model

catalog-client.ts:214  entry.aggregators?.find(a => a.provider === provider)
                       v3 rows carry `sourceProviderId` — no `provider`
                       -> null
routing-rules.ts:249   modelName = resolveExternalId(...) ?? modelName
                       -> falls back to the bare model name
```

It does not crash. It **degrades silently**: every subscription verdict becomes
`unknown`, catalog intelligence disappears, and requests fall through to metered
providers.

That is the v9.0.1 defect — subscriptions dropped, flat-rate users billed per token —
reproduced at population scale by design rather than by bug. It is the exact failure
this contract work exists to remove.

**Proposed fix, and it is claudish's to build, not the backend's.** Ship a release well
before cutover that detects `contractVersion: 3` and fails **loudly**:

> your claudish is too old for this catalog — run `claudish update`

The population then splits into *updated and working* and *shown a clear error*. Neither
half is silently mis-billed. This has to propagate before cutover, which makes it the
long pole: it is phase 1 of claudish's work, not phase 5.

Dual serving is not the answer and v3 is right to refuse it. Loud failure is cheaper and
does not compromise the contract.

---

## claudish's v3 migration

v3 is breaking, so this is a rewrite of every catalog-reading path, not an adoption of
optional fields.

| phase | work | why in this order |
|---|---|---|
| 1 | **version detector + loud failure** on `contractVersion: 3` | must propagate before cutover; everything else can follow |
| 2 | adopt canonical route ids: `native-anthropic` → `anthropic`, `kimi` → `moonshotai`, old names kept as user-facing shortcuts | v3 rejects the old names outright |
| 3 | model `(routeId, routeProfileId)` — claudish has no profile concept today; `anthropic/direct-api` and `anthropic/claude-code-subscription` must be distinct for billing | fixes the metered-versus-subscription classification at `remote-provider-types.ts:148` |
| 4 | read `plan.route.routeId` instead of `plan.routing.providerUid`; read `sourceProviderId` and the `routeStatus` union instead of `aggregators[].provider` | the two breaking reads traced above |
| 5 | generation pinning, `410` and `503` handling | v3 §6 |
| 6 | read `rosterCoverage`; narrow the v9.0.4 guard; drop the `.some()` roster test at `model-catalog.ts:335` | needs v3 live |

Independent of v3, and worth shipping on the current contract:

- rank aggregator rows instead of taking the first (`catalog-client.ts:213`) — a no-op
  on today's data that removes a dependency on array order
- plan-scoped membership: stop unioning plans that share a route
  (`model-catalog.ts:303`)
- log unresolvable routes instead of dropping them silently
- ship the alias matcher, measured at 85.1%, currently an evaluation script
- the metered-fallback policy when coverage is unknown — a product decision, not made

---

## Acceptance criteria

Revised for v3. **The previous criterion "a cache carrying none of the new fields routes
exactly as today" is withdrawn** — v3 is breaking by design, so it is unsatisfiable. Its
intent survives as criterion 4.

Backend-side, provable in emulators — v3 §8 already covers these; listed for tracing:

1. An unresolved or ingress-rejected entry prevents a complete roster.
2. Direct and subscription profiles for one route cannot exchange credentials or billing
   classification.
3. A read spanning an interrupted publication cannot establish absence.

Client-side, provable only against a real claudish build:

4. An un-updated claudish meeting a v3 response **fails visibly**, and never silently
   loses a subscription.
5. `qwen3.5-plus` resolves `qwen-cloud` as `unknown`, not `not-served`.
6. `glm-4.5`, `glm-4.6`, `glm-4.7` stay absent from GLM plan membership, and a request
   for `glm-4.7` reports the model that actually executes.
7. Alibaba Coding Plan credentials never reach a Qwen Token Plan endpoint.
8. The recommended set is unchanged, or every change is deliberate.

Criterion 4 is the one that decides whether the cutover is safe.

---

## Closing

v3 is a better design than the additive plan it replaces, for a reason worth keeping:
it **deletes** the fields that made bad states expressible instead of **adding** fields
that discourage them. `includedModels` strings cannot produce a bad join once they no
longer exist.

The cutover risk is not a flaw in that reasoning. It is what happens when a design
correct for a server meets a client the server does not control.
