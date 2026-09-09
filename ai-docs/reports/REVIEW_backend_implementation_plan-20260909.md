# Design review: Backend Catalog Contract Implementation Plan

**Reviewing:** "Backend Catalog Contract Implementation Plan" (models-index), 2026-09-09
**Reviewer:** claudish
**Against:** `BACKEND_TASKS-20260904.md` (revised 2026-09-09) and the shipped claudish resolver

## Method, and what is evidence here

Every claim about claudish behaviour below was read out of the source in this
worktree and is cited by `file:line`. Claims about the backend are read from the
plan text only — that side was not executed or inspected. Claims about vendor
behaviour (Z.ai redirects, Alibaba hosts) are attributed to whoever established
them and are **not** independently re-verified here, except the Alibaba host
split, which claudish probed live on 2026-08-02 and recorded in source.

Where this review says "verified", a command produced the quoted text. Where it
says "expected" or "reads as", it is inference from the plan.

---

## Verdict

**Approve the contract. Do not start implementation until B1 and B3 are settled.**

The plan implements the semantics we asked for, and in two places it is stronger
than what we asked for. The fail-closed rule in §5 — *on a first run without
complete or persisted evidence, fail closed rather than publish an empty
authoritative plan* — is a direct structural fix for the defect class that
produced claudish v9.0.1 and v9.0.4. That alone justifies the contract work.

Four findings follow. Two block, one is a naming decision that must precede
code on both sides, one is a scope question.

---

## B1 — BLOCKING. The two teams are about to rename in opposite directions

**What the plan says.** §7 derives `providerUid` from the catalog slug with two
renames:

```
anthropic  → native-anthropic
moonshotai → kimi
```

That publishes **claudish's current internal names**.

**What claudish decided.** On 2026-09-04, recorded in
`TASK_adopt_catalog_provider_ids-20260904.md`: claudish stops maintaining its own
provider names and adopts the catalog's. That is the same two pairs, in the
other direction — `native-anthropic` becomes `anthropic`, `kimi` becomes
`moonshotai`.

**Impact.** If both ship, the backend begins emitting `native-anthropic` in the
same release where claudish stops using it. The result is not a clean failure:
the claudish task doc keeps each old name as a provider shortcut, so
`native-anthropic` would still resolve — by accident, through a compatibility
path, not by design. Two teams would have paid for two renames to arrive back
where they started, with a shortcut concealing the seam.

**Recommended resolution.** claudish adopts the catalog slugs; the backend's
mapping table collapses to identity for all sixteen implemented providers.

Reasons, in order of weight:

1. It is the decision already taken on the claudish side, and the one that
   removes a hand-maintained table rather than adding one.
2. It makes `providerUid == provider` for every row the client can act on, so
   the field carries no divergence to get wrong.
3. It leaves `providerUid` doing the one job it is uniquely good at — resolving
   skew between a client version and a cache version — instead of encoding a
   permanent naming disagreement.

`fireworks` and `together-ai` stay omitted either way. That part is right.

**Decision owner:** claudish (it is our rename). Needs to be communicated before
§7 is written.

---

## B2 — Naming. `routeStatus` versus `routingStatus`

`BACKEND_TASKS-20260904.md` §3 asks for `routingStatus`. The plan implements
`routeStatus`. The plan's own preamble anticipated this: *"Agree on final field
names with the backend developer; the semantics below matter more than the
spelling."*

Agreed on semantics, and **take `routeStatus`** — it is shorter and it is
already written into their type definitions.

This is trivial and it still blocks, because claudish reads a literal field name
and a mismatch is a silent no-op: the field is published, the reader looks for a
key that is not there, and every plan reads as legacy-unknown. That is the exact
failure mode CLAUDE.md warns about for `loadConfig`'s allowlist.

**Decision owner:** joint. Settle in the reply.

---

## B3 — BLOCKING. GLM redirects collide in claudish's aggregator lookup

**What the plan says.** §5 adds five provider-scoped aliases, of which two land
on the same model:

```
("glm-coding", "GLM-5.3-Flash") → glm-5.3-flash
("glm-coding", "GLM-4.7")       → glm-5.3-flash
```

**What claudish does with that.** Two `glm-coding` aggregator rows on one entry.
`packages/cli/src/providers/catalog-client.ts:213`:

```ts
export function externalIdFor(entry: SlimModelEntry, provider: string): string | null {
  const agg = entry.aggregators?.find((a) => a.provider === provider);
  if (agg?.externalId) return agg.externalId;
```

`find` returns the **first** match in array order. claudish has no tiebreak and
no notion that one of the two rows is a redirect.

**Impact.** A user asks for `glm-5.3-flash`. If the `GLM-4.7` row sorts first,
claudish puts `GLM-4.7` on the wire. Z.ai redirects it back to
`GLM-5.3-Flash`, so the request succeeds and the response looks correct. The
defect is invisible at runtime and depends on array order in a cache file.

It also defeats the plan's own acceptance check 9 — *redirected wire ids report
the model that actually executes*. Nothing in the row marks it as a redirect, so
claudish cannot report what it cannot distinguish.

**Recommended resolution.** A redirect is not an alias and must not share the
alias field. Give it its own representation carrying requested id, execution
target, and source — which is what the plan's own parent document already
argued: *"Treat provider redirects separately from identity aliases."* The
design was right; the storage chosen for it is not.

If a redirect must live on the aggregator row for delivery reasons, then it
needs a discriminator field, and claudish needs to filter on it before
`externalIdFor` picks a winner. That is more work on both sides than a separate
field, for a worse result.

**Decision owner:** backend, since it is their schema. claudish must ship the
reader either way.

---

## B4 — Scope question. The coverage signal is designed but not exposed

The parent design asked for roster coverage plus *"the source and time of the
last successful roster verification"*, and stated that expired coverage must
stop supporting definitive negative verdicts.

In the plan, `AuthoritativeRosterSnapshot` — which carries `completeness`,
`sourceUrl`, `observedAt` and `error` — is internal to reconciliation. §9 adds
only `routeStatus` and `includedModelRefs` to `queryPlans`.

**This may be deliberate and correct.** If §5 guarantees that a partial or
fallback roster can never be published as authoritative, then a client never
receives a stale roster and does not need the flag.

**What it costs.** claudish still cannot distinguish *this list is authoritative
as of today* from *this is the last good list, and the last three refreshes
failed*. `modelDiscovery: "catalog"` carries no freshness, and it is the only
signal we act on when deciding whether absence proves anything.

**Ask:** was the omission intended? If yes, say so in the contract document, so
the next reader does not re-derive this. If a freshness field is cheap, exposing
`observedAt` alone would let claudish age out a negative verdict without
importing the whole snapshot type.

**Decision owner:** backend.

---

## Non-blocking observations

### N1 — The seven `unsupported` plans change nothing for claudish today

Expected, and worth stating so nobody validates against a phantom improvement.

claudish's v9.0.4 guard keys on the **missing routing block**, not on any status
field (`packages/cli/src/adapters/model-catalog.ts:368`):

```ts
plan.routing?.providerUid === undefined
```

The plan keeps `routing` omitted on all seven. Behaviour before and after is
identical. The same applies to adding `routeStatus: "supported"` to the twelve
routed plans — `resolveSubscriptionRouting` filters on `routing.providerUid` and
never reads a status field.

The value is deferred, not absent. Once claudish reads `routeStatus`, the guard
can stop being blunt: an **unsupported** sibling plan should not suppress a
`not-served` verdict, because claudish can never route that plan regardless. At
that point `qwen-cloud` becomes correctly `not-served` for Coding-Plan-only
models rather than permanently `unknown`. That is claudish work their contract
unlocks, and it should be scheduled as such rather than expected on delivery.

### N2 — Deferring `devin` aliases is reasonable, and it has a consequence worth naming

`BACKEND_TASKS-20260904.md` §4 put `devin` first, on risk. The plan defers
`devin`, `antigravity`, `grok-subscription` and `minimax-coding` until exact
authenticated roster evidence exists.

Not a contradiction — "first when you do them" and "not until there is evidence"
can both hold. But the practical outcome is that Devin models stay unenriched
indefinitely, and claudish's matcher declines on them by design, because Devin
re-serves other vendors' models under colliding uids. So Devin models remain
reachable only by explicit address (`dv@…`) with no catalog metadata.

That is the correct trade — a decline costs metadata, a wrong match answers as
the wrong vendor — but it should be a stated outcome, not a surprise later.

### N3 — Tripwire: `modelDiscovery: "catalog"` on the Alibaba Coding Plan

§4 sets `alibaba-ai-coding-plan` to `modelDiscovery: "catalog"` with a
ten-model roster. Harmless today: the plan is `unsupported`, so claudish never
consults it.

It becomes a hazard the day claudish ships a `coding-intl` provider and the plan
flips to `supported`. claudish's own source records why
(`packages/cli/src/providers/provider-definitions.ts:1272`):

> Contrast `coding-intl`'s `/v1/models`, which serves the full roster to an
> unauthenticated caller — a 200 from THAT one proves nothing about a
> credential, and briefly convinced this investigation of the opposite.

The ten-model list describes the **product**, not an account's entitlement.
Under `catalog`, claudish treats absence from it as proof. That is precisely
what the plan's §3 forbids — *"A nonempty response or freshly served cache is
also insufficient"* — applied to the plan's own classification.

**Ask:** record now, in `docs/subscription-routing-contract.md`, that this plan
must move to `hybrid` or `client` at the moment it becomes supported. The cost
of writing that sentence today is one sentence. The cost of rediscovering it is
a repeat of v9.0.1 against a paid plan.

### N4 — Verify the recommended set does not shrink

§9 makes recommendations require `supported` plus valid routing. claudish's
second cache, `~/.claudish/recommended-models-cache.json`, currently carries 34
editorial models and drives the picker.

If any recommended model's subscription coverage was computed through one of
the seven now-`unsupported` plans, that coverage disappears. Probably correct —
an unroutable plan should not present as coverage — but it is a user-visible
change to the picker, so it should be asserted rather than assumed. Add a check
that the recommended set's size and membership are unchanged, or that each
change is deliberate.

---

## Approved as designed

| plan section | our item | note |
|---|---|---|
| §4 Alibaba: `unsupported`, no routing, no invented uid | 1 (revised) | exactly right, including refusing to reuse `qwen-cloud` |
| §3 strict-ingress vs legacy-persistence validation | 3 | separate APIs over a mode boolean is the better call |
| §3 "`supported` requires routing; `unsupported`/`unknown` forbid it" | 3 | makes the invalid state unrepresentable |
| §5 fail closed on first run; last-known-good retention | 3, 6 | the strongest item in the plan |
| §5 Codex: complete-only authority, fallback never proves absence | 2 | correct, and correctly separated from the display list |
| §6 collision policy, no winner by confidence or fuzzy inference | 4 | matches our matcher's own precision-first design |
| §8 validation never auto-deletes or remaps | 6 | the caveat we asked for, implemented |
| §2 `includedModelRefs`, index-aligned, additive | 7 | display text preserved; families and prose represented explicitly |
| §7 no implicit `providerUid ?? provider` fallback | 5 | important — a vendor slug is not a route identity |

---

## Decisions required before implementation

| # | decision | owner | blocks |
|---|---|---|---|
| B1 | rename direction: claudish adopts catalog slugs, backend mapping becomes identity | claudish | plan §7 |
| B2 | field name: `routeStatus` | joint | plan §2, claudish reader |
| B3 | redirects get their own representation, not an aggregator alias row | backend | plan §5, GLM |
| B4 | is withholding roster freshness from `queryPlans` intended? | backend | nothing; answer in the contract doc |
| N3 | record that Alibaba must leave `catalog` when it becomes supported | backend | nothing; one sentence in the contract doc |

---

## What claudish owes, sequenced against their phases

Their §11 sequence is sound. The claudish side maps onto it as follows. Nothing
here is in their scope; it is listed so neither team waits on the other for the
wrong thing.

| their phase | claudish work | dependency |
|---|---|---|
| 1 contracts | adopt catalog provider slugs (B1) | must land before their §7 |
| 1 contracts | fix sibling-plan over-coverage at `model-catalog.ts:303` | independent, ours alone |
| 2 roster flow | — | none |
| 3 route identities | read `routeStatus`; narrow the v9.0.4 guard (N1) | needs their §2 published |
| 3 route identities | read the redirect representation, display the executing model | needs B3 resolved |
| 4 validation | — | none |
| 5 public contract | ship the alias matcher (measured 85.1%, currently an eval script) | independent |
| any | log unresolvable routes instead of dropping them silently | independent |
| any | `coding-intl` provider, then reopen item 1 | independent, unscheduled |
| any | metered-fallback policy decision | product decision, not made |

---

## Integration validation, once both sides ship

Their §12 validates the backend against emulators. These are the assertions that
close the loop on the **client**, and they are the ones that decide whether the
fix worked. Run against the deployed catalog with a refreshed
`~/.claudish/all-models.json`.

| # | assertion | proves |
|---|---|---|
| 1 | `alibaba-ai-coding-plan` has `routeStatus: "unsupported"`, no `routing`, no `qwen-cloud` reference | B1 of the original report is closed correctly |
| 2 | `qwen3.5-plus` still resolves `qwen-cloud` as `unknown`, not `not-served` | the v9.0.4 guard survived the contract change |
| 3 | every `aggregators[].providerUid`, where present, resolves to a claudish provider | B1 landed in the agreed direction |
| 4 | no model carries two aggregator rows for one provider | B3 is closed |
| 5 | `glm-4.5`, `glm-4.6`, `glm-4.7` are absent from `z-ai-glm-coding-plan` membership | redirects were not published as coverage |
| 6 | requesting `glm-4.7` through `gc@` reports the executing model | acceptance check 9 |
| 7 | the recommended set is unchanged, or every change is deliberate | N4 |
| 8 | a cache with no `routeStatus` anywhere still routes exactly as today | legacy compatibility, and the claudish reader fails open |

Assertion 8 is the one most likely to be skipped and most likely to matter. Every
user on a stale cache is in that state on the first run after release.

---

## Closing note

The plan's §14 rollback design is additive throughout — stop emitting a field,
retain last-known-good, never overwrite with fallback data. That is the right
shape, and it is what makes approving the contract low-risk even with B1 and B3
open.

The one thing worth repeating from their own document, because both defects in
this review are instances of it: a correct rule loses to an existing data
structure unless the schema stops it. B3 is a correct rule about redirects put
into the field that already existed. The `providerUid`-as-plan-identity bug on
our side is the same shape. Where the plan makes an invalid state
unrepresentable — `unsupported` forbids `routing` — it will hold. Where it
relies on discipline, it will drift.
