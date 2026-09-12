# Code review — models-index Catalog Contract v3 implementation

**Reviewer:** claudish client team
**Target:** `/Users/jack/mag/models-index/.claude/worktrees/new-subscriptin-model`, branch `worktree-new-subscriptin-model` (105 changed paths, read-only review — nothing in that repo was modified, staged, or executed)
**Spec:** `~/.claude/plans/gleaming-discovering-marble.md` (plan wins on disagreement)
**Date:** 2026-09-13

## Verdict

**CONDITIONAL** — 0 CRITICAL, 2 HIGH, 3 MEDIUM, 1 LOW.

**Priority 1 (the wire contract claudish already shipped against) is clean. All five sub-questions verified by reading the code and its tests. Our shipped 426 guard is NOT inert.** That is the headline: the thing this review existed to check is correct, field for field and nesting for nesting.

The two HIGH findings are elsewhere: an activation gate that will freeze the catalog after the second generation, and a Mistral pointer quarantine whose seven reviewed rows are largely unreachable on the live collector path (so the required `unknown` evidence rows will not be published, and the safety comes from evidence being silently discarded rather than from the reviewed rule).

## Scope honesty

- **Covered thoroughly:** `catalog-v3-http.ts` + its test, `catalog-v3-reader.ts`, all five HTTP handlers, `catalog-v3-manual-handler.ts`, `route-registry.ts`, `subscription-alias-validation.ts`, `subscription-plan-reconciliation.ts` (all 1294 lines), `catalog-v3-builder.ts`, `catalog-v3-publication.ts`, `catalog-v3-deliberate-diff.ts`, `openai-codex-models.ts`, `collectors/api/mistral.ts`, `manual-overrides/manual-mapping-validation.ts`, the forbidden-field scan in `schema-runtime.ts`, `scripts/catalog-v3-emulator-smoke.ts`, `firestore.rules`, `firebase.json`, `docs/api-reference.md`, and the three CI workflows.
- **Read partially:** `merger.ts` (only `recanonicalizeAliasBackedRawModels` and the mutable-alias paths), `schema-runtime.ts` (only the plan/route/roster schemas, `canonicalizeModelId`, `RawModelSchema` contract), `collectors/base-collector.ts` (only `makeResult` / `validateCollectorResultV3`).
- **NOT reached:** `catalog-generation.ts` (canonical hashing, create-only writes, readback, CAS mechanics, retention implementation — ~all of Priority 3 item 10's *generation* half), `catalog-v3-recommender.ts`, `search-bag-builder.ts`, `checked-evidence-v3.ts` internals, `slack-alert.ts`, 15 of the ~20 new test files, all of `web/`, and the 18 modified collectors other than codex/mistral. Priority 3 item 10 is therefore **partially** answered: the *policy* half is verified, the *persistence* half is not.

Legend on every finding: **(a) verified by reading the code**, **(b) inferred from tests**, **(c) could not determine**.

---

## PRIORITY 1 — the wire contract. All five verified. No findings.

### 1. Does the 426 body match the frozen shape exactly? — YES (a)

`functions/src/catalog-v3-http.ts:88-108`. `sendCatalogErrorV3` writes `contractVersion: 3` at the top level and spreads `details` **inside** `error`:

```ts
res.status(status).json({
  contractVersion: 3,
  error: { code, message, ...details },
});
```

`requireCatalogV3` (`:44-57`) calls it with `{ minimumContractVersion: 3 }`, producing exactly:

```json
{"contractVersion":3,"error":{"code":"catalog_client_upgrade_required","message":"This endpoint requires catalog contract version 3","minimumContractVersion":3}}
```

`catalog-v3-http.test.ts:81-96` asserts this with `toEqual` — a strict deep-equality, not `toMatchObject` — so an extra or relocated field fails their suite. **Our guard reads both fields at the levels it expects.**

### 2. Is `contractVersion: 3` top-level on every body, including 410 and 503? — YES (a)

Every v3 response in the codebase goes through exactly three writers, and all three set it top-level:

- `sendCatalogSuccessV3` (`catalog-v3-http.ts:72-86`)
- `sendCatalogErrorV3` (`:88-108`)
- `sendManualError` (`catalog-v3-manual-handler.ts:197-212`, admin endpoint only)

I enumerated every `res.status(...)` / `res.json(...)` in `functions/src` and confirmed no v3 endpoint constructs a response outside those three. The remaining direct writers belong to endpoints the plan explicitly leaves outside the catalog contract (`skills-search-handler`, `mcp-registry-handler`, `coding-agents-popularity`, `version-handler`, telemetry/error ingest in `index.ts`) or to `algolia-catalog.ts`, which is now dead code — `index.ts:932-996` rewires `reindexAlgoliaModels`, `cleanupStalePrefixedDocs`, `backfillSearchBags`, and `backfillVendorRows` to `handleRetiredCatalogMutatorV3`.

Checked each error path individually rather than trusting the helper:
- **410** — `catalog-v3-reader.ts:719-730` `generationGone()` → `CatalogReadErrorV3(410, "generation_gone", …)` → `sendCatalogReadErrorV3` → `sendCatalogErrorV3`. Also `handleRetiredCatalogMutatorV3`.
- **503** — `catalog-v3-reader.ts:732-736` `catalogUnavailable()`, plus the missing-control branch at `:473-479`, plus the catch-all in `sendCatalogReadErrorV3:138-146`.
- Every handler wraps its whole body in `try/catch` → `sendCatalogReadErrorV3`, so an unexpected throw still produces a versioned 503, not a framework 500.
- `scripts/catalog-v3-emulator-smoke.ts:390` asserts `body.contractVersion === 3` on **every** capture including all 426/410/503 cases, and `:398-401` asserts error bodies carry no `data` and a non-empty `error.code`.

### 3. Is the 426 triggered by a *missing* Accept header specifically? — YES (a)(b)

`acceptsCatalogV3` (`:36-42`): `req.get?.("accept") ?? headerValue(req.headers.accept)`; if falsy it returns `false` immediately, and `requireCatalogV3` sends the 426. **claudish sending no Accept header at all gets 426 and can never receive a v3 success body.**

The four cases you asked about are each covered by an assertion in `catalog-v3-http.test.ts:43-79`:

| Request Accept | Result | Where asserted |
|---|---|---|
| header absent | 426 | `:48` `acceptsCatalogV3(request())` → `false`; `:84` end-to-end 426 |
| `application/json` | 426 | `:49` |
| `…catalog+json;version=2` | 426 | `:51` |
| `…catalog+json;version` (malformed, no `=`) | 426 | `:54`; `parseParameterValue` also rejects unterminated/invalid quoted values |
| `*/*` | 426 | `:66` — worth noting, because several HTTP clients add this automatically |
| `…;version=3;q=0` / `q=0.0` | 426 | `:60-61` |
| `…;version=3;version=2` (duplicate param) | 426 | `:62-63` |

The emulator black-box suite re-tests the two that matter most against real HTTP: `scripts/catalog-v3-emulator-smoke.ts:179` (no Accept → 426) and `:180-183` (`version=2` → 426).

### 4. `Content-Type` and `Cache-Control` as promised? — YES (a)

`setCatalogV3Headers` (`:357-360`) sets `Content-Type: application/vnd.models-index.catalog+json;version=3` and `Cache-Control: no-store`, and is called by all three writers before `.status().json()` — so it applies to success **and** error bodies. Asserted at `catalog-v3-http.test.ts:86-87` and on every emulator capture at `scripts/catalog-v3-emulator-smoke.ts:381-388`.

`firebase.json` has **no** Hosting rewrite to Functions, so clients hit `cloudfunctions.net` directly with no CDN in front — `no-store` plus no cache layer means there is no path by which a cached 200 reaches a non-negotiating client.

### 5. Does any code path serve a v3 success body to a client that did not negotiate? — NO (a)

Every handler that can emit `sendCatalogSuccessV3` calls `requireCatalogV3` as its **first** statement:

`query-handler.ts:83` (`queryModels`), `:205` (`queryPlans`), `plugin-defaults-handler.ts:37`, `probe-models-handler.ts:151`, `openapi-handler.ts:42`, `catalog-v3-manual-handler.ts:69`, `catalog-v3-http.ts:63` (retired mutators).

One ordering nuance, benign: `handleCollectModelCatalogManualV3` checks the admin token *before* negotiating (`catalog-v3-manual-handler.ts:59-68`), so an unauthenticated non-negotiating request gets a 401 rather than a 426. That is an **error** body, it still carries top-level `contractVersion: 3`, and it never contains `data`. No effect on us.

---

## PRIORITY 2 — the two findings we raised. Both accepted and implemented; one has a reachability defect.

### 6. Codex must be `hybrid`, not `catalog` — VERIFIED CORRECT, no finding (a)

All four sub-claims hold:

- **Plan row says `hybrid`.** `subscription-plan-reconciliation.ts:157`: `"openai-codex": supported("hybrid", "openai", "codex-subscription")`. Enforced at runtime, not merely declared — `validatePlanRegistryV3:679-681` raises `"openai-codex discovery must be hybrid"` if a collector emits anything else, and `catalog-v3-builder.ts:70-75` and `:97-102` throw on any violation, blocking the generation.
- **Public rows establish positive inclusions only.** `PLAN_ROSTER_REQUIREMENTS_V3:207-209` declares the Codex roster `supplemental`, `requiredForActivation: false`, 24h. `ROSTER_POLICIES_V3:267-277` pins `authority: "supplemental"`, `scope: "public_api_eligibility"`.
- **Public absence cannot produce a negative verdict or satisfy an authoritative requirement.** Three independent gates:
  - `applyRosterEvidenceToPlansV3:841-854` builds `authoritativeProviders` from **authoritative** rosters only; inclusion pruning is scoped to that set. For `openai-codex` the set is empty, so a model absent from the public registry is never removed from membership.
  - `rosterCoverageAt:899-906` returns `{status:"unknown", reason:"supplemental_only"}` when a plan has no authoritative requirement, and `canAuthoritativelyExcludeModelV3:933-934` returns `false` unless coverage is `complete`. Absence can therefore never harden into `not-served`.
  - `validateRosterForRequirement:999-1001` rejects any roster whose `authority` differs from the requirement's (`reason: "authority"`), so a supplemental roster can never satisfy a `requiredForActivation` gate.
- **`OPENAI_CODEX_FALLBACK_MODEL_SLUGS` is genuinely gone.** A repo-wide grep across `functions/src` (including tests) returns zero hits. `collectors/scraper/openai-codex-models.ts` has no hardcoded slug list; an empty or unparsable registry throws `evidenceError("missing_section", …)` (`:143-148`) and the collector returns `state: "unavailable"` with a `failureClass` (`:72-82`) rather than a fabricated roster.

Also confirmed the collector cannot write membership: it emits plain `RawModel[]` with no `subscriptionPlans`/`availableInPlans` (asserted in `catalog-v3-contract.test.ts:54-67`), and its `collectorId` is absent from `COLLECTOR_ID_SOURCE_PROVIDER_V3`, so `collectServingEvidence` skips it entirely — public Codex rows create no serving route.

### 7. The Mistral moving-pointer rows — table and shape correct, but the rule is largely unreachable. **See HIGH-2 below.**

The parts that are correct (a):

- All seven canonical models are present in `MISTRAL_POINTER_QUARANTINE_V3` (`subscription-alias-validation.ts:39-68`) with exactly the plan's pointers and reasons — five `mutable_pointer_only`, and `identity_conflict` for `mistral-medium-2604`/`mistral-small-2603` whose pointers name the Magistral family. `subscription-alias-validation.test.ts:10-16` table-drives all seven.
- The `unknown` variant genuinely carries **no** callable id and **no** route. `unknownRoute:212-226` emits only `{sourceProviderId, sourceCollectorId?, confidence, routeStatus:"unknown", reason, observedExternalModelId}`. Enforced at runtime by `AggregatorRouteV3Schema` (`schema-runtime.ts:1079-1100`), a `discriminatedUnion("routeStatus")` whose `unknown` branch is `.strict()` — an `externalModelId` or `route` on an `unknown` row is rejected, not ignored.
- Three layered guards, in order (`projectServingEvidence:162-191`): exact quarantine match → any `mistral-medium-*`/`mistral-small-*` canonical paired with a `magistral-*` external id → any dated canonical paired with a `*-latest`/`*.latest` pointer → and finally a catch-all requiring `externalModelId === canonicalModelId && officialCallableEvidence === true` for **every** dated Mistral model, so any non-identical external id yields `unverified_mapping`. That last gate is strong and covers "otherwise mutable pointer" without needing to enumerate pointer spellings.
- `officialCallableEvidence` is set in exactly one place and only from a captured official API row: `catalog-v3-builder.ts:381-383`, `raw.collectorId === "mistral-api" && raw.externalId === raw.canonicalId`.
- `catalog-v3-builder.ts:490-495` additionally strips `*-latest` aliases from any `mistral|ministral|codestral` model's `aliases`, so the model index cannot resolve a pointer to a dated model.

---

## Findings, most severe first

### HIGH-1 — The deliberate-diff gate freezes the catalog permanently after the second generation (a, confirmed by their own tests)

**Location:** `catalog-v3-deliberate-diff.ts:34-59`, `catalog-v3-publication.ts:104-129`, `index.ts:612-631`.

**Problem:** Activation of any generation after G0 requires an operator-supplied approval digest whenever **any** semantic surface changed — and one of the compared surfaces changes on every single collection run, by construction.

**Why:** `buildCatalogDeliberateDiffV3` compares all eight surfaces, `models` and `rosters` among them:

```ts
for (const name of ["models","plans","rosters","redirects","changes","recommendations","pluginDefaults","routeRegistry"] as const) {
  addChangedSurface(surfaces, name, before[name], after[name]);
}
return { changed: Object.keys(surfaces).length > 0, … };
```

Live rosters are re-observed on every run, so each carries a fresh `observedAt`/`expiresAt` and therefore a fresh `contentHash` (`subscription-plan-reconciliation.ts:540-598`). `applyRosterEvidenceToPlansV3:875-879` then propagates `latestObservedAt` into each plan's `lastUpdated`. So `surfaces.rosters` and `surfaces.plans` differ on **every** run even when no upstream vendor changed anything. `changed` is therefore always `true`, `buildCatalogCandidateV3:239-251` always throws `CatalogDeliberateDiffApprovalRequiredV3`, and `publishCatalogV3:115-129` stages a pending candidate and rethrows without activating. `collectModelCatalog` (3-hourly, `index.ts:600`) has no handler for this — it propagates as a function error.

Their own test documents the behaviour: `catalog-v3-publication.test.ts:20-60` shows the second generation must be re-submitted with `approvedDiffDigest`.

**Concrete failure scenario:** G0 and G1 are activated during cutover. The 02:00 scheduled run collects, the OpenCode Go live roster returns the same 24 models with a new `observedAt`, the digest differs, activation is refused, a sealed pending generation is written, the function errors. Same at 05:00, 08:00, … forever. **Within 24 hours of cutover, `rosterCoverage` flips to `{status:"unknown", reason:"expired"}` for all six live-roster plans** — `opencode-go`, `ollama-cloud`, `alibaba-token-plan-individual`, `alibaba-token-plan-team-edition`, `routing-run`, `streamlake-kwaikat-coding-plan` (`rosterCoverageAt:914-916`; expiry removes authority even while the generation stays active, exactly as the §5 rule specifies). New models never appear. claudish keeps serving a frozen G1 with degraded coverage and has no signal that anything is wrong, because the 200 responses stay well-formed.

**Secondary consequence:** `applyRetention` runs only inside `finishPublication` under `if (publication.activated)` (`catalog-v3-publication.ts:285-296`). Since activation never succeeds, retention never runs, and `stagePendingCatalogV3:257-271` seals a full generation (every model, plan, roster, redirect, change document) plus a pending-approval doc on **every** run — 8 per day, never collected. The digest changes each run so the existing-pending short-circuit at `:239-255` never fires.

**Suggestion:** Restrict the auto-activation gate to the surfaces the plan actually names as requiring review — routes, plan `routeStatus`/`route`, membership, recommendations, plugin defaults, route registry — and exclude volatile evidence timestamps (`rosters[].observedAt`/`expiresAt`/`contentHash`, `plans[].lastUpdated`) from the digest, the way `semanticCandidate` already excludes `generationId`/`generatedAt`. Keep the full-surface diff for the operator-facing cutover gate (§5 item 5), where it belongs. Separately, run retention on the staging path too, or cap pending generations.

### HIGH-2 — Serving evidence is keyed on pre-merge canonical IDs, so the Mistral quarantine is largely unreachable and the required `unknown` evidence rows are not published (a, with one (c) component)

**Location:** `catalog-v3-builder.ts:366-388` (`collectServingEvidence`) vs `merger.ts:342-393` (`recanonicalizeAliasBackedRawModels`); `collectors/api/mistral.ts:45-51`; `schema-runtime.ts:434-469`.

**Problem:** `collectServingEvidence` reads `raw.canonicalId` from the **original** `collectorResults`, while the published models come from `mergedModels`. `mergeResults` re-canonicalizes alias-backed rows into new objects (`raws.map(...)`) and does not mutate the input, so the two disagree precisely for mutable-pointer rows — the case the quarantine exists to police.

**Why it matters, step by step.** `RawModelSchema` transforms `canonicalId` via `canonicalizeModelId` at the collector boundary, and `canonicalizeMistralModelId` hardcodes a rule for only one of the seven pointers (`mistral-medium-latest` → `mistral-medium-2604`, `schema-runtime.ts:434-441`). For the other six, `selectCanonicalMistralId` returns the API id verbatim (`collectors/api/mistral.ts:48-51`), so the collector-level canonical id **is** the pointer. Consequently, for a Mistral API row `{"id":"mistral-large-latest"}`:

- serving evidence = `{canonicalModelId: "mistral-large-latest", externalModelId: "mistral-large-latest"}`;
- the quarantine lookup misses (its keys are the *dated* ids), `isDatedMistralModelId("mistral-large-latest")` is `false`, so no guard fires and the row projects to a **mapped** `mistralai/direct-api` route;
- but the merger folds that row onto `mistral-large-2512` via the alias map, so no published model has `modelId === "mistral-large-latest"`;
- `catalog-v3-builder.ts:148` reads `serving.routesByModelId[model.modelId] ?? []`, so the orphan key is **never consumed and never reported**.

So the outcome is safe only by accident. Two concrete consequences:

1. **The plan's required output is missing.** §4.2 requires each of the seven to publish `unknown` with `observedExternalModelId` retained as evidence. Instead the evidence is silently dropped, and the `identity_conflict` branch for `mistral-medium-2604`/`mistral-small-2603` is unreachable from `mistral-api` altogether: a `magistral-medium-latest` row canonicalizes to `magistral-medium-latest` (no canonicalizer rule), so it is never paired with a `mistral-medium-*` canonical id. The seven table rows and their seven tests pass on synthetic evidence that the reviewed collector path does not produce.
2. **A mutable pointer can become a canonical model id.** If the alias evidence that folds `mistral-large-latest` into `mistral-large-2512` is absent — `mistral-model-pages` fails, or Mistral stops listing the alias — nothing removes the pointer row, and `mistral-large-latest` is published as a canonical `CatalogModelV3` carrying a mapped, callable `mistralai/direct-api` route with `externalModelId: "mistral-large-latest"`. That satisfies §4.2's letter (it is not a *dated* canonical model) while contradicting §2.2: "mutable pointers cannot manufacture canonical identity". For us it means the catalog advertises `mistralai@mistral-large-latest` as a stable model id whose weights change under us — the moving target the plan rejected, relocated from `externalModelId` to `modelId`. HIGH-1's diff gate would at least surface it to a human before activation.

A third, narrower gap in the same area: `isDatedMistralModelId` (`subscription-alias-validation.ts:243-245`) anchors on `-(20)?\d{4}(-\d{2}(-\d{2})?)?$`. A dated id whose date is not the final token — e.g. `mistral-ocr-2505-completion` — is classed as undated, so the mutable-pointer and `officialCallableEvidence` gates both skip it and a `-latest` pointer maps. Low likelihood, trivial to close.

**Which manual-mapping rules exist in Firestore today is (c) — I cannot read that data.** It matters because `manualServingCollectorIdV3` (`route-registry.ts:137-141`) does resolve `manual-model-mappings:mistralai` to source provider `mistralai`, so a manual rule of the form `{targetModelId:"mistral-large-2512", servingProvider:"mistralai", servingExternalId:"mistral-large-latest"}` *would* produce the dated↔pointer pairing and *would* hit the quarantine correctly. If such rules exist, the quarantine is live for them. It is still unreachable from the `mistral-api` collector.

**Suggestion:** Key serving evidence on the **merged** canonical id (or run `recanonicalizeAliasBackedRawModels` once and pass the recanonicalized results to both `mergeResults` and `collectServingEvidence`), and add a violation for any `routesByModelId` key with no matching published model — an orphan route today means evidence was thrown away silently. Then either re-derive the seven `unknown` rows from that corrected pairing, or add a positive assertion that each of the seven dated models publishes an `unknown` aggregator with the expected `observedExternalModelId`, so the table cannot silently become decorative.

### MEDIUM-1 — The unscoped global alias membership index is merely unused, not gone (a)

**Location:** `functions/src/subscription-plan-membership.ts` (unchanged from `main` — not in the diff at all), still imported by `writer.ts:11,17` and `recommender.ts:22,24`; `recommended-route-contract.ts:151-155`; `schema.ts:419,434`.

**Problem:** Your item 9 asked specifically whether the old unscoped join is *gone* rather than *unused*. It is unused. `subscription-plan-membership.ts:101` still iterates `plan.includedModels` and still matches plan strings against canonical ids, display names, and every global model alias with no provider or route scope. `recommended-route-contract.ts:151` still reads `plan.routing.providerUid`. `schema.ts:419` still declares `SubscriptionPlanRouting.providerUid` and `:434` still declares `includedModels: string[]`. All of it still compiles into the deployed bundle.

**Why it is nonetheless not exploitable today:** the v3 path is `index.ts:441 runCatalogV3Collection → catalog-v3-publication.publishCatalogV3 → catalog-v3-builder.buildCatalogCandidateV3`. Neither `writer.ts` nor `recommender.ts` is imported by that path — I traced every non-test importer, and the only surviving link is `search-bag-builder.ts:3` pulling the `ACCESS_METHODS` constant from `recommender.ts`. Membership in v3 comes only from `projectSubscriptionPlanMembershipV3` (`subscription-plan-reconciliation.ts:945-983`), which discards any incoming `subscriptionPlanIds` (`:967`) and derives the field solely from `modelIdForMembership` — `canonical_model.modelId` or a **mapped** `provider_model.resolution.modelId`, nothing else. Raw collectors and manual overrides are additionally blocked: `manual-mapping-validation.ts:220-228` strips `subscriptionPlans` from every rule's `copyFields`/`copyMatchedFields`/`overrides`, and `collectors/base-collector.ts` routes every row through `validateRawModelWithoutMembership`.

**Impact:** A future edit that imports `attachSubscriptionPlanMembership` or `writer.ts` reintroduces the exact defect we reported, with no test standing in the way — the v3 suite would stay green because it never touches those modules. Against §1.1's "no compatibility aliases or dual field names" and §8's instruction to convert these files, this is unfinished work, not a correctness bug today.

**Suggestion:** Delete `subscription-plan-membership.ts`, `writer.ts`, `recommended-route-contract.ts`, and `algolia-catalog.ts`; move `ACCESS_METHODS` out of `recommender.ts`; drop `SubscriptionPlanRouting` and `includedModels` from `schema.ts`. `assertNoForbiddenV3Fields` already prevents the fields reaching the wire, so this is a source-hygiene cleanup with no runtime risk.

### MEDIUM-2 — A roster entry naming a model the merger did not produce blocks the entire generation (a)

**Location:** `subscription-plan-reconciliation.ts:956-958`, reached from `catalog-v3-builder.ts:192`.

```ts
if (!modelIds.has(modelId)) {
  throw new Error(`plan ${plan.id} inclusion references missing model ${modelId}`);
}
```

**Problem:** Roster entries become inclusions with `modelId` set (`applyRosterEvidenceToPlansV3:855-873`), and any one of them naming a model absent from `mergedModels` aborts the whole candidate. For supplemental rosters this is worse than it looks: `mergeSupplementalRosters:1051-1087` carries unexpired entries forward from the **active** generation, so an entry can outlive the model it names by up to 24 hours.

**Concrete failure scenario:** OpenAI's public Codex registry lists `gpt-5.6-sol`; the roster records `modelId: "gpt-5.6-sol"`. On the next run the OpenAI collectors do not return that model (a transient upstream 500, or the slug was renamed), so no `ModelDoc` with that id exists — but the supplemental merge carries the entry forward because it has not expired. `projectSubscriptionPlanMembershipV3` throws, `buildCatalogCandidateV3` propagates, no generation is produced, and the catalog goes stale for up to 24 hours until the entry expires. Fail-closed on money and identity, which is right, but it converts a single upstream hiccup into a catalog-wide outage.

**Suggestion:** Treat a dangling supplemental inclusion as a dropped positive inclusion (optionally with a violation recorded for alerting) rather than a fatal error; reserve the throw for **authoritative** rosters, where a missing target genuinely means identity is unresolved.

### MEDIUM-3 — The public cutover verification never exercises the one behaviour claudish depends on (a)

**Location:** `.github/workflows/catalog-v3-cutover.yml:29-36, 82-89, 192-208`.

**Problem:** Plan §5 gate 2 — "Claudish has first shipped a safety release that detects 426/contractVersion 3" — is implemented as a human-typed boolean input, `safety_release_confirmed`. That matches the plan's wording, and no backend can verify our npm release, so it is not wrong. But the `verify-public` step that runs against production only exercises the **happy** path: it sends the v3 Accept header to five endpoints and checks `contractVersion === 3`. It never sends a request **without** an Accept header, which is the single behaviour our shipped guard depends on and the only one that distinguishes a correct v3 deployment from one where negotiation was accidentally bypassed (a misconfigured proxy, a Hosting rewrite added later, a middleware reordering). That case is covered only in the emulator (`scripts/catalog-v3-emulator-smoke.ts:179`).

**Concrete failure scenario:** cutover completes, all six gates pass, `verify-public` is green — and a `queryModels` request with no Accept header returns 200 with a v3 body because something in the production edge path differs from the emulator. Our guard never fires, we parse a v3 success as if it were v2, and the "safety release" gate was satisfied by an attestation that nothing checked.

**Suggestion:** Add two assertions to the `verify-public` node block — one request with no `accept` header and one with `application/json` — each asserting HTTP 426, `body.contractVersion === 3`, `body.error.code === "catalog_client_upgrade_required"`, `body.error.minimumContractVersion === 3`, and `body.data === undefined`. That is ~10 lines and converts our gate from attested to verified. We would also take a published fixture of that exact body to pin our own parser test against.

### LOW-1 — Error-code vocabulary drifts from the plan's frozen union (a)

**Location:** `schema.ts:390-394`; `query-handler.ts:85-91, 207-213`; `plugin-defaults-handler.ts:39-45`; `probe-models-handler.ts:153-159`; `openapi-handler.ts:44-50`; `catalog-v3-manual-handler.ts:59-152`.

Plan §7.1 freezes three codes (`catalog_client_upgrade_required`, `generation_gone`, `catalog_unavailable`). The implementation adds a fourth to the union, `invalid_cursor` at HTTP 400, and introduces a parallel `ManualCatalogErrorCodeV3` set on the admin endpoint (`catalog_admin_unauthorized` 401, `catalog_request_invalid` 400, `catalog_approval_required`/`_not_found`/`_stale` 409). It also emits HTTP **405** carrying code `catalog_unavailable`, which the plan pairs exclusively with 503.

**Impact on us: none.** Every one of these bodies carries top-level `contractVersion: 3` and no `data`, so our guard classifies them correctly as non-2xx failures. `invalid_cursor` and the 410/426/503 rows are documented in `docs/api-reference.md:37-41`; the 405 is the only undocumented one. Recorded so nobody later reads the plan's union as exhaustive when writing a client-side code switch.

---

## Priority 3 — what I verified, and what I did not reach

### 8. Impossible states — VERIFIED, enforced at runtime (a)

`schema-runtime.ts:1061-1077`: `SubscriptionPlanV3Schema` is `z.discriminatedUnion("routeStatus", [...])` with all three branches `.strict()`. `supported` requires `route`; `unsupported` and `unknown` require `routeReason` and, because `.strict()` rejects unknown keys, **forbid** `route`. A missing `routeStatus` fails discriminator resolution. This is a genuine runtime gate on external data, not just the TypeScript union: `createPlanV3:434` routes every plan through `parseSubscriptionPlanV3` (which also runs the forbidden-field scan first), `catalog-v3-reader.ts:441-442` re-parses every stored plan on read, and `validatePlanRegistryV3:682-697` independently cross-checks each plan's `routeStatus` and `route` against `PLAN_DECISIONS_V3`. `AggregatorRouteV3Schema:1079-1100` applies the same pattern to `mapped`/`unknown` serving rows.

### 9. The membership join — VERIFIED for the v3 path; see MEDIUM-1 for the leftover module (a)

Derivation is exactly as specified: `projectSubscriptionPlanMembershipV3` + `modelIdForMembership` accept only `canonical_model` and mapped `provider_model`. Family labels, display labels, and prose placeholders have no `modelId` field at all in `ModelInclusionV3Schema` (`:995-1039`), so they cannot express membership even in principle. `projectModelV3` (`catalog-v3-builder.ts:424-467`) never copies `subscriptionPlanIds` from the incoming `ModelDoc`, and `projectSubscriptionPlanMembershipV3:967` destructures away any that survived. Collectors and manual overrides are blocked as described in MEDIUM-1. The unscoped alias index is unused but present — MEDIUM-1.

### 10. Fail closed — policy half VERIFIED; persistence half NOT REACHED (a for what I read)

Verified: `reconcilePlanProducersV3:129-141` records a violation when a *successful* producer omits a required plan **and** when a failed producer has no active-v3 plan to carry forward — so a first run with no complete evidence and no persisted state cannot publish an empty authoritative plan; it throws. `reconcileRosterEvidenceV3:791-802` records a violation for every `requiredForActivation` roster with no valid incoming and no valid carry-forward. `validateRosterForRequirement:985-1041` fails closed on schema, authority mismatch, policy identity, truncation (`snapshotEntryCount` outside the reviewed range, or missing reviewed sentinels), `content_hash_mismatch`, and expiry. `validateRosterExternalIdentity:1219-1240` fails on duplicate or conflicting external-id-to-model pairs; `globalRosterIdentityViolations:1194-1217` fails on cross-roster conflicts; `finalServingIdentityViolations` (`catalog-v3-builder.ts:390-414`) fails when one route plus external id maps to two models. Every one of these violation lists is a `throw` in `buildCatalogCandidateV3` (`:64, :88, :97, :108, :186, :203`) before any document is written. `:56-58` refuses to seed from a non-v3 active generation. Static/checked evidence keeps its original `observedAt` (`createRosterWithSnapshotCount:540-568` derives `expiresAt` from the entry's own `observedAt` and rejects any non-policy expiry), so collection cannot manufacture freshness.

Not reached: the create-only write, readback, deterministic hashing, sealed-manifest, CAS, and retention mechanics inside `catalog-generation.ts`. The reader side gave me indirect confidence — `catalog-v3-reader.ts` re-verifies the manifest against the control pointer's hash (`:171-180`), rejects a manifest whose `generationId` disagrees with its path (`:165-169`), rejects reads that escape their generation prefix or return nested paths (`:355-366`), rejects per-document sealed-hash mismatches (`:390-391`), and re-validates every document against strict v3 schemas — but I did not audit the writer.

### 11. Route profiles — VERIFIED, all pairs distinct (a)

`route-registry.ts:9-82`. The registry matches the plan's reviewed list exactly: 14 routes, `routeId === consumerProviderId` by construction (`route()` at `:190-195`). Every direct/subscription pair has distinct endpoint **and** credential profile ids:

| Route | direct/gateway | subscription |
|---|---|---|
| `anthropic` | `anthropic-direct` / `anthropic-api-key` | `anthropic-claude-code` / `anthropic-claude-code-oauth` |
| `openai` | `openai-direct` / `openai-api-key` | `openai-codex` / `openai-codex-oauth` |
| `moonshotai` | `moonshot-direct` / `moonshot-api-key` | `kimi-code` / `kimi-code-membership-token` |
| `qwen` | `dashscope-direct` / `dashscope-api-key` | `qwencloud-token-plan` / `qwencloud-token-plan-key` |
| `z-ai` | `zai-direct` / `zai-api-key` | `zai-glm-coding` / `zai-glm-coding-token` |
| `opencode` | `opencode-zen` / `opencode-zen-api-key` | `opencode-go` / `opencode-go-token` |

`requireRouteBindingV3:161-168` rejects any unreviewed route/profile pair and is called on every plan route (`createPlanV3:439`), every mapped serving row (`subscription-alias-validation.ts:207`), and every redirect (`:121`). `COLLECTOR_SOURCE_ROUTE_POLICY_V3:84-103` matches plan section 4.1 with one addition (`"routing-run": null`), and `routeBindingForSourceProvider` distinguishes unregistered (`undefined`, giving `unverified_mapping`) from registered-as-unroutable (`null`, giving `unsupported_provider`) — no source-name fallback exists. `alibaba-ai-coding-plan` is `unsupported` with no route (`subscription-plan-reconciliation.ts:184-187`), double-guarded by `validatePlanRegistryV3:707-710`, so Alibaba can never reference the QwenCloud endpoint or credential silo.

### 12. Forbidden vocabulary — VERIFIED, and the scan's scope is narrow enough to be meaningful (a)

Two independent scans, and I checked both for the vacuity you flagged:

**Build/serve-time** (`schema-runtime.ts:1419-1477`, `assertNoForbiddenV3Fields`) recurses arrays and objects and is applied at the candidate boundary (`catalog-v3-builder.ts:252`, plus inside `parseSubscriptionPlanV3` and `parseCatalogGenerationCandidateV3`) **and** again on every outbound payload (`query-handler.ts:184, 275`, `plugin-defaults-handler.ts:57`, `probe-models-handler.ts:197`, `openapi-handler.ts:57`) — so a violation at read time produces a versioned 503 rather than a leaked field.

**Black-box** (`scripts/catalog-v3-emulator-smoke.ts:407-432`) re-implements the same logic independently and runs over **every** captured envelope, success and error (`:273-275`).

On scope: the unconditional key list is only three names — `providerUid`, `includedModels`, `routing` — none of which has a legitimate v3 use, so the assertion bites. Legacy aggregator `provider` is correctly conditioned on the sibling presence of `sourceProviderId` **and** `routeStatus`, because `PlanBaseV3.provider` and `CatalogModelV3.provider` are legitimate v3 fields; a broader rule would have had to be disabled and would indeed have been vacuous. Forbidden route ids are checked on `routeId`/`consumerProviderId` values, which is where route ids live, and the list extends well past the plan's minimum (`native-anthropic`, `kimi`, plus `kimi-coding`, `openai-codex`, `grok-subscription`, `minimax-coding`, `glm-coding`, `qwen-cloud`, `opencode-zen-go`, `ollamacloud`, `antigravity`, `devin`). Belt and braces: `RouteId` is a strict Zod enum, so those names are rejected structurally too.

**One residual gap, minor:** a forbidden route id appearing as the value of some *other* key — `nativeModelProviders: ["kimi"]`, or a plan's `provider: "kimi"` — is not caught by either scan. Currently unreachable, since `nativeModelProviders` is populated only from the hardcoded registry.

### Plan-ID coverage — VERIFIED (a)

All 19 plan ids from plan section 3 are present in `PLAN_IDS_V3` (`subscription-plan-reconciliation.ts:27-47`) with discovery and route status matching the table row for row, each owned by exactly one producer collector (`PLAN_PRODUCER_COLLECTOR_IDS_V3:52-72`) so no collector can write another's plan. `validatePlanRegistryV3:666-673` rejects both a missing plan and an unreviewed extra. Note for future readers: `catalog-v3-contract.test.ts:9-26` asserts only the **16** plans produced by `popular-coding-subscriptions`; the other three (`streamlake-kwaikat-coding-plan`, `google-antigravity`, `minimax-token-plan`) come from their own collectors and are covered in `subscription-plan-reconciliation.test.ts`. The 19-plan invariant is enforced in production code, which is what matters.

### Other spot-checks that came out clean (a)

- `firestore.rules` denies public reads on the `catalogV3Generations`, `catalogV3Control`, and `catalogV3PendingApprovals` subtrees and on the legacy `models`, `plans`, `config` roots.
- `firebase.json` has no Hosting rewrite to Functions, so there is no CDN or edge layer between claudish and the negotiating handler.
- `reconcileProviderRedirectsV3` (`subscription-alias-validation.ts:110-151`) rejects redirect evidence older than 168h and any route plus `fromExternalModelId` with two targets; redirects live in their own collection and never become aliases or memberships.
- Cursors are HMAC-signed with the sealed manifest hash and bound to resource plus normalized query (`catalog-v3-http.ts:149-242`), compared with `timingSafeEqual`, and a cursor that disagrees with an explicit `generationId` is rejected — pagination cannot mix generations.
- Every handler resolves the control pointer once per read and pins one generation; there is no root, process-cache, or Algolia fallback anywhere in `catalog-v3-reader.ts`.

---

## What claudish should do next

1. **No change to our 426 parser.** The frozen shape shipped as agreed; our guard is live and correct. Ask them to publish a captured 426 body as a fixture we can pin a test against.
2. **Ask for the `verify-public` addition in MEDIUM-3 before cutover.** Two assertions turn our hard gate from attested into verified, and they cost nothing.
3. **HIGH-1 is the one to escalate.** It does not break our contract, but it silently freezes the catalog and degrades six plans to `unknown` coverage within a day of cutover. Worth raising before Phase 5 rather than after.
4. **HIGH-2 changes what we should expect on the wire.** Do not build anything on the assumption that the seven dated Mistral models will carry `unknown` plus `observedExternalModelId` rows — on the current collector path they will carry nothing. And be ready for `mistralai@*-latest` to appear as a canonical model id if their alias evidence lapses.
