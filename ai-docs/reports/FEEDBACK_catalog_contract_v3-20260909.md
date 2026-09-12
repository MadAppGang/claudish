# Feedback: Models Index Catalog Contract v3

**To:** the models-index backend developer
**From:** claudish, 2026-09-09
**On:** `Models Index Catalog Contract v3 — Final Architecture`

**Verdict: v3 is the plan. Build it.** It closes seven of the nine items claudish
raised across two review rounds, and three of them more thoroughly than we asked. Three
things remain — two data items and one coordination risk that v3 treats as an
assumption rather than a step.

Everything below citing source was read, not assumed. Nothing was deployed, mutated or
inferred against. Vendor-behaviour claims are attributed, not re-verified.

---

## A. Confirmed — please do not relitigate these

Listing them so review time goes to the open items.

| v3 | what it closes |
|---|---|
| §2 line 83, §7 line 216 — only canonical and mapped inclusions create membership | the unscoped alias join at `subscription-plan-membership.ts:110`, which could attach any model whose alias collided with a plan string. Deleting `includedModels` removes the defect class rather than guarding it |
| §2 line 41, §3 line 44 — `(routeId, routeProfileId)`, profile selects an endpoint and credential silo | one vendor name carrying both a metered API route and a subscription route. `anthropic: direct-api, claude-code-subscription` is exactly right |
| §5 — immutable generations, sealed manifest, SHA-256, CAS activation, `generationId` pinned across pagination | a response that mixes two publication generations. Stronger than we specified |
| §5 line 161 — read-time `rosterCoverage` with `expiresAt`; expiry removes negative authority immediately | staleness invisibly supporting a negative verdict. "Freshness is intentionally exposed, not withheld" is the right call |
| §2 line 92 — `ProviderModelRedirectV3` with source URL and observation date | redirects stored in the alias field. Three entries in the live cache already carry two rows for one provider; first-array-match decides today |
| §5 line 159 — same target dedupes, conflicting targets block the generation | 33 duplicate rows in the current cache |
| §1 line 5 — `native-anthropic` and route id `kimi` invalid | the rename, settled in the direction claudish asked for. We adopt `anthropic` and `moonshotai` |

The single strongest property in v3 is that `routeStatus: "supported"` requires
`route` and the other two forbid it. That makes the contradictory state impossible to
write down rather than merely discouraged. Every open item below is a place the same
discipline has not yet reached.

---

## B. Open item 1 — the Codex roster still rests on an API-eligibility predicate

**v3 §3 lists:** `openai-codex | catalog | supported openai/codex-subscription |
live Codex registry, required 24h; mapped exact`.

`catalog` means absence proves absence. The source is unchanged —
`functions/src/collectors/scraper/openai-codex-models.ts:88`:

```ts
model.supported_in_api === true &&
model.visibility !== "hide"
```

fetched from
`raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json`.

Re-fetching a checked-in repository file every 24 hours makes it **fresh**, not
**exhaustive for a subscription**. That predicate is API eligibility. Upstream's own
model manager treats the remote catalog as account-, plan- and credential-dependent,
with visible ChatGPT catalogs taking authority over bundled metadata.

This is the distinction v3 enforces everywhere else. Stated generally:
**authentication determines evidence scope, not completeness.** A public source can be
exhaustive for a *product* while proving nothing about an *account*. v3 already applies
this to Alibaba (§3 line 127); Codex is the same shape with the opposite conclusion.

**Ask:** either move `openai-codex` to `hybrid`, or document the separate source that
establishes exhaustive subscription coverage for that plan.

**Adjacent:** the same collector carries `OPENAI_CODEX_FALLBACK_MODEL_SLUGS`, a
hardcoded five-model list, feeding a completeness claim. Your repo and your call —
flagged because claudish holds the inverse invariant, that a default is a rule and never
a pinned id.

---

## C. Open item 2 — seven Mistral models are addressable only by a moving pointer

Measured on `~/.claudish/all-models.json` as served 2026-09-03. Not covered by v3.

```
codestral-2508                 mistralai  [mistral-code-fim-latest]
ministral-3-14b-instruct-2512  mistralai  [ministral-14b-latest]
ministral-3-3b-instruct-2512   mistralai  [ministral-3b-latest]
ministral-3-8b-instruct-2512   mistralai  [ministral-8b-latest]
mistral-large-2512             mistralai  [mistral-large-latest]
mistral-medium-2604            mistralai  [magistral-medium-latest]
mistral-small-2603             mistralai  [magistral-small-latest]
```

Each has a dated canonical id and no dated external id, so the only address claudish
has is a name whose target moves. Under v3 these become `AggregatorRouteV3` rows on
`mistralai/direct-api`, and a pointer resolves to whatever Mistral currently serves —
which is a different model from the dated id the entry claims to be.

**The last two need checking beyond the pointer problem.** *Magistral* appears to be a
different product line from *Mistral Medium* and *Mistral Small*, which would make those
two rows name the wrong family entirely. Not verified against Mistral's current naming —
an observation to confirm, not a confirmed defect.

**Ask:** record dated external ids where Mistral publishes them, and confirm or correct
the two `magistral-*` mappings. If a dated id genuinely does not exist for a model, a
`routeStatus: "unknown"` row is more honest than a pointer.

---

## D. Open risk — the cutover assumes a client that can be updated

**v3 §9:** *"update clients first; enter maintenance; deploy v3-only code/rules"* and
*"No dual serving/write or converter exists."*

claudish is a CLI installed from npm. There is no mechanism to force an update, and
users update on their own schedule. So "clients must update before cutover" is an
**assumption**, not a step, and v3 does not mark it as one.

**What happens to an un-updated client, traced against the shipped resolver:**

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
`unknown`, all catalog intelligence disappears, and requests fall through to metered
providers. Flat-rate users get billed per token with no error anywhere.

That is the v9.0.1 defect reproduced at population scale — by design of the cutover
rather than by bug. It is the exact failure this whole contract exists to remove.

**We are not asking for dual serving.** v3 is right to refuse it, and the fix is
claudish's to build: a release that detects `contractVersion: 3` and fails **loudly**
with "your claudish is too old, run `claudish update`". The population then splits into
*updated and working* and *shown a clear error*, and neither half is silently
mis-billed.

That release must propagate before cutover, which makes it the long pole. **Three
things we need from you to schedule it:**

1. **A cutover date, with lead time.** We need the detector shipped and adopted before
   it, not after. Name the date as early as you can; it can move later.
2. **A guarantee that `contractVersion` appears on every v3 response**, including the
   `410` and `503` shapes in §6. It is the only thing an old client can key on.
3. **Somewhere to test against before cutover** — a staging generation, or whether
   `demo-models-index` from §8 can be pointed at by a real claudish build. We would
   rather find the breaks against your emulator than against production.

---

## E. What claudish commits to

So no acceptance check is credited to a change we have not made.

| work | trigger |
|---|---|
| `contractVersion: 3` detector with loud failure | **first**, before anything else, and before cutover |
| adopt canonical route ids; old names kept as user-facing shortcuts only | before cutover |
| model `(routeId, routeProfileId)` so a metered route and a subscription route on one vendor bill differently | before cutover |
| read `plan.route.routeId` and `sourceProviderId` instead of the v2 fields | before cutover |
| generation pinning, `410` and `503` handling | before cutover |
| read `rosterCoverage` and let expiry withdraw a negative verdict | after v3 is live |

**Correction, 2026-09-13.** An earlier revision of this row also committed us to
dropping "our own over-broad roster test at `model-catalog.ts:335`". That was
wrong, and the claim behind it was wrong. We described the `.some()` there as
licensing a `not-served` verdict from a single membership row. Reading to the end
of the function shows the actual licence is
`providerPlans.every(isCatalogDiscoveredPlan)` — which landed on `main` in
`9c6947f` on 2026-09-03 and is the check we said was missing. The `.some()` two
guards earlier can only produce an *early* `unknown`; it makes the verdict safer,
never harsher, and its own comment says so — it guards against pairing a new plan
contract with an older slim snapshot mid-rollout.

We are therefore **keeping** it, renamed `hasAnyMembershipRow` and documented as
a snapshot-skew guard. Deleting it would create *new* `not-served` verdicts
during your rollout, which is the opposite of this document's purpose. The error
was ours: the analysis ran in a worktree branched before that fix, so an
already-fixed defect read as live.

Independent of v3, shipping on the current contract: rank aggregator rows instead
of taking the first, scope membership to the plan rather than the route, and log
unresolvable routes instead of dropping them.

---

## F. How we will validate

Your §8 covers the backend side in emulators. These are the four that can only be
proved against a real claudish build and a refreshed cache:

1. An un-updated claudish meeting a v3 response **fails visibly**, and never silently
   loses a subscription. This is the one that decides whether cutover is safe.
2. `qwen3.5-plus` resolves `qwen-cloud` as `unknown`, not `not-served`, and Alibaba
   Coding Plan credentials never reach a Qwen Token Plan endpoint.
3. `glm-4.5`, `glm-4.6` and `glm-4.7` stay out of GLM plan membership, and a request
   for `glm-4.7` reports the model that actually executes.
4. The recommended set is unchanged, or every change is deliberate.

We will report all four, pass or fail, with the commands that produced them.
