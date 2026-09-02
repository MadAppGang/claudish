# Backend contract validation — all five items fixed, and the contract matches our vision

**Date:** 2026-09-02 (later the same day)
**Supersedes:** `backend-catalog-verification-20260902.md`, which found none of the
five items fixed. Everything in that document is now stale except its
"New finding" sections, which are addressed below.
**Method:** live API only. Every claim in the backend's new
*Subscription routing contract* was checked as a claim.

**Payload:** `?catalog=recommended` `version=2.1.0`, `lastUpdated=2026-09-02`,
34 entries, 14 `category:"subscription"`. Plus `?catalog=slim` (743 models) and
the new `GET /queryPlans` (18 plans).

---

## Verdict

**The backend has delivered, and delivered more than was asked for.** All five
original items are fixed. The contract is not a patch to the data; it is a
separation of four concepts that were previously conflated — commercial plan
identity, routing identity, model discovery, and route preference.

| # | Original item | Now |
|---|---|---|
| 1 | order contract undocumented and wrong | **fixed** — explicit `tier`, native first, 6/6 correct |
| 2 | retired Gemini Code Assist advertised | **fixed** — 0 `go@` routes |
| 3 | `swe-1.7` advertising Devin | **fixed** — 0 `dv@` routes, and for a principled reason |
| 4 | subscription category capped | **improved** — 18 → 14 rows, all of them routable |
| 5 | `slim`/`recommended` disagreement | **fixed** — the question is answered and the join works |

Contract claims verified against the live API: **12 of 12 checks pass.**

---

## 1. Order contract — fixed, and better than requested

We asked for a declared `tier` field rather than positional order, calling array
position "fragile". The contract delivers exactly that.

Every one of 32 routes carries `tier`, `routingProvider`, `planIds` and `command`:

```
route object keys: command, plan, planIds, prefix, routingProvider, tier
tier values:       native=12, general=14, metered=6
```

Ordering is correct on every multi-route model, and every model with a native
route lists it first — this morning it was 0 of 6:

```
qwen3.8-max     qc(native)  zgo(general)  zen(metered)
glm-5.3         gc(native)  zgo(general)  oc(general)  zen(metered)
kimi-k3         kc(native)  zgo(general)  oc(general)
minimax-m3      mmc(native) zgo(general)  oc(general)  zen(metered)
qwen3.8-flash   qc(native)  zgo(general)  zen(metered)
glm-5.3-flash   gc(native)  zgo(general)  oc(general)  zen(metered)
```

This is exactly the priority order we stated: the vendor's own plan, then general
multi-vendor plans, then metered direct APIs, then aggregators last.

The singular `subscription` is now an **exact** copy of `subscriptions[0]`
(14/14, byte-identical JSON), so it finally names the *preferred* route rather
than an arbitrary one.

**A detail that shows the tier semantics are real, not cosmetic:**
`deepseek-v4-pro` lists `qc` as **general**, not native — because
`alibaba-token-plan-*` declares `nativeModelProviders: ["qwen"]` and DeepSeek is
not Qwen. The same prefix is native on one model and general on another. That is
the contract computing meaning rather than labelling a string.

## 2 & 3. Retired providers — fixed, and item 3 for the right reason

Zero `go@` routes; `gemini-3.7-flash` keeps no subscription row.

Zero `dv@` routes. The contract explains why this is correct rather than a
deletion: `cognition-devin` is a live plan with `modelDiscovery: "client"`, so
"static absence means *not known until client discovery*, not *unsupported*". The
backend stops inventing `dv@swe-1.7` from an owner model id while keeping Devin a
valid plan. Same for `google-antigravity`.

This is the better fix. We had framed it as "remove the stale row"; they
distinguished *no data yet* from *no plan*.

## 4. The cap — materially improved

Rows went 18 → 14, and the four dropped were `gemini-3.7-flash`, `swe-1.7`,
`gpt-5.6-luna`, `mistral-medium-3.1`. The first two are the retirements above.

The contract states the mechanism: *"The backend emits a plan-backed route only
while the referenced plan exists and the model belongs to that plan."* Routes are
now derived from plan membership rather than from list position, which is the
structural fix we asked for — a model no longer silently loses routes by being
pushed down a ranked list.

Four rows still carry no prefix (`claude-*`), but they now declare
`tier: "native"`, `routingProvider: "native-anthropic"`, and
`planIds: ["anthropic-claude-code"]`. They are no longer untyped placeholders.

## 5. `slim` / `recommended` — the question is answered

The original task asked: **are `subscriptionPlans[]` values plan identifiers or
provider names?** The contract answers: **plan identifiers**, joined to
`/queryPlans` for `routing.providerUid`.

That is the answer we said we could work with. It also removes a coincidence:
slim's Kimi value changed from `kimi-coding` to `kimi-code`, so the old accidental
string equality with our provider uid is gone and the join does the work.

**The join is 7 of 8 total:**

```
alibaba-token-plan-individual     5 models  -> qwen-cloud
alibaba-token-plan-team-edition   9 models  -> qwen-cloud
kimi-code                         2 models  -> kimi-coding
minimax-token-plan                2 models  -> minimax-coding
ollama-cloud                     18 models  -> ollamacloud
opencode-go                      20 models  -> opencode-zen-go
z-ai-glm-coding-plan              1 model   -> glm-coding
streamlake-kwaikat-coding-plan    1 model   -> (none)   <-- unresolvable
```

**`providerUid` alignment with our provider table: 10 of 10.** Every value —
`qwen-cloud`, `kimi-coding`, `minimax-coding`, `ollamacloud`, `opencode-zen-go`,
`glm-coding`, `devin`, `antigravity`, `openai-codex`, `native-anthropic` — is a
real `BUILTIN_PROVIDERS[].name` in claudish. Nothing to map.

*(Our earlier report listed `native-anthropic` as unmatched. That was our error —
a hand-written comparison list, not the real provider table. It matches.)*

## Duplicate `qc` — fixed exactly as the contract describes

Our first report called this a generator bug; our second corrected that to two
plans sharing a prefix. The contract confirms the second reading and models it
properly — one callable route whose `planIds[]` names both plans:

```
qwen3.8-max: qc planIds=["alibaba-token-plan-individual","alibaba-token-plan-team-edition"]
```

Zero duplicate prefixes remain in any model.

---

## What this means for claudish

### Our shipped code works unchanged, and gets correct ordering for free

Re-ran the FR-1 live verification against v2.1.0. **VC-1 and VC-2: 0 failures.**

```
kimi-k3       kimi · zgo   ->  kimi · kc · zgo · oc
qwen3.8-max   zgo          ->  qc · zgo · zen
glm-5.3       z-ai · zgo   ->  z-ai · gc · zgo · oc · zen
minimax-m3    mm · zgo     ->  mm · mmc · zgo · oc · zen
```

The vendor-native plan now renders immediately after the native provider prefix,
ahead of the general plans — without a line of client-side ordering code.

**This is the payoff of a decision made under uncertainty.** We deliberately made
route order a non-criterion and rendered whatever order arrived, because the
contract was undeclared. Had we implemented a client-side "native first"
preference, we would now be fighting a backend that does it correctly, and we
would have had to unpick it. Declining to guess was the right call.

The four unprefixed Claude rows still emit `[]` rather than
`undefined@claude-opus-5`, and the `qc` dedupe still holds — both edge cases
survive the new payload.

### Three things are now unblocked

1. **R-15 is fixable.** `resolveSubscriptionRouting` compares our provider uid
   against `subscriptionPlans[]`, which are plan ids — so it was inert for
   everything except Kimi. With `routingProvider` on every recommended route and
   `routing.providerUid` on every plan, the join is now available and exact.
2. **`DEFAULT_ROUTING_RULES` can be demoted to a cold-cache fallback.** The
   original report was explicit that this must not precede a documented order
   contract. That contract now exists, with a declared `tier` rather than an
   inferred position — the stronger version of the precondition.
3. **We can consume `tier` directly** instead of relying on array position, which
   removes the last place where we depend on an undeclared property.

None of these is in the current change. They are the natural next piece of work.

### Residual gaps, all minor

1. **`streamlake-kwaikat-coding-plan` has no `providerUid`** (1 slim model), so
   the documented join yields nothing for it. Either it needs routing, or the
   contract should say the join is partial by design.
2. **Four plans carry a `providerUid` but no slim model references them** —
   `anthropic-claude-code`, `cognition-devin`, `google-antigravity`,
   `openai-codex`. For the two `client`-discovery plans that is exactly what the
   contract prescribes. `anthropic-claude-code` and `openai-codex` are declared
   `catalog` discovery, where the catalog is supposed to be authoritative, so
   their absence from slim looks inconsistent with their own discovery mode.
3. **`grok-subscription` (`gk@`) has no plan at all.** We route it via our own
   rules, so nothing is broken, but it is a plan-served provider the catalog does
   not know about.
4. **`gpt-5.6-luna` left the roster entirely**, not just its subscription row. It
   previously advertised `zgo` and `cx`. Worth confirming that is intended
   curation rather than a side effect of the plan-membership rewrite.
5. **The model id churn we flagged is unresolved**: `claude-fable-5` →
   `claude-fable-5-1` persists. Ids are the join key and appear in user
   configuration; whether they are stable is still worth stating in the schema.

---

## Assessment

The contract is aligned with our vision, not merely compatible with it. The tier
vocabulary — `native`, `general`, `metered`, `aggregator` — is the priority order
we specified, and `planIds[]` plus `routingProvider` separate the two identities
whose conflation caused the original defect on both sides.

The parts we would single out as better than what we asked for:

- **A declared `tier` rather than a fixed order.** We asked for order and
  suggested a tier; they made the tier the contract and the order a consequence.
- **`nativeModelProviders` deciding nativeness per model**, so the same prefix is
  native for a vendor's own model and general for someone else's. We had assumed
  nativeness was a property of the plan alone.
- **Discovery mode separated from route preference**, which is what let Devin and
  Antigravity stay valid without inventing commands. Our framing would have
  deleted them.

Every one of those is a distinction we did not draw and would have got wrong.
