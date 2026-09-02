# Backend catalog verification — none of the five items is fixed, and item 5 has widened

**Date:** 2026-09-02
**For:** the `models-index` maintainer
**Verifies:** `models-index/TASK_subscription_route_order_contract_and_stale_providers.md`
**Method:** live API only. No file in `models-index` was read for status and none
was modified. Every claim below is a response from
`https://us-central1-claudish-6da10.cloudfunctions.net/queryModels`.

**Payload under test:** `?catalog=recommended`, `version=2.0.0`,
`lastUpdated=2026-09-02`, 38 model entries, 18 of them `category:"subscription"`.
Also `?catalog=slim`, 743 models.

The catalog was regenerated today, so this is current output and not a stale
cache. Raw capture: `ai-docs/reports/data/backend-verification-20260902.txt`.

---

## Summary

| # | Item | Status |
|---|---|---|
| 1 | `subscriptions[]` order contract | **not fixed** — no tier field; 0 of 6 models lead with their native plan |
| 2 | retired Gemini Code Assist | **not fixed** — still advertised |
| 3 | `swe-1.7` advertises Devin | **not fixed** — still advertised |
| 4 | `subscription` category cap | **not fixed** — still 18, still capped |
| 5 | `slim` / `recommended` disagreement | **widened** — 4 → 8 plan values, 6 → 53 flagged models |

Three further findings, none previously reported:

- **A model id changed silently**: `claude-fable-5` → `claude-fable-5-1`.
- **The duplicate `qc` prefix has a different cause than we reported.** It is not
  a generator joining twice. Two genuinely distinct plans share one prefix.
- **(added later the same day, from a live measurement rather than the catalog)**
  **The two OpenCode tiers are not access-separated**: one key is accepted by
  both endpoints and 17 models are served by both, so a `zen` route and a `zgo`
  route for the same model differ only in billing. Sharpens item 5. See
  **New finding C**.

---

## 1. Order contract — not fixed

**Acceptance asked for:** a published statement that `subscriptions[]` is ordered
by routing preference, native plan first and OpenRouter last; a model with a
vendor-native plan listing it at index 0; and ideally an explicit `tier` field so
consumers need not infer intent from array position.

**Measured.** The route objects carry exactly three keys:

```
command, plan, prefix
```

No `tier`, no `rank`, no `order`, no `priority`. Order remains positional and
undeclared.

Every model that has a vendor-native plan still leads with a general one:

| model | `subscriptions[]` in order | native plan | at index 0? |
|---|---|---|---|
| `qwen3.8-max` | `zgo, qc, qc, zen` | `qc` | no |
| `glm-5.3` | `zgo, gc, zen, oc` | `gc` | no |
| `kimi-k3` | `zgo, kc, oc` | `kc` | no |
| `minimax-m3` | `zgo, mmc, zen, oc` | `mmc` | no |
| `qwen3.8-flash` | `zgo, qc, qc, zen` | `qc` | no |
| `glm-5.3-flash` | `zgo, gc, zen, oc` | `gc` | no |

**0 correct, 6 still wrong.**

The singular `subscription` field still mirrors element 0 exactly across all 18
rows — `mirrors=18, diverges=0` — so it continues to name an arbitrary route
rather than the preferred one. Any consumer treating the singular as "the plan to
use" is being pointed at a general plan for every model that has a native one.

**Nothing on the claudish side depends on this being fixed.** We deliberately made
route order a non-criterion and render whatever order arrives, precisely because
the contract is undeclared. Ordering is still worth fixing, but it is not
blocking us. A declared `tier` would let us sort by meaning and stop caring about
position at all.

## 2. Retired Gemini Code Assist — not fixed

**Acceptance asked for:** no `recommended` entry emitting `prefix: "go"` or
`plan: "Gemini Code Assist"`.

**Measured.** `gemini-3.7-flash`'s subscription row, verbatim:

```json
{
  "id": "gemini-3.7-flash",
  "subscription":  { "prefix": "go", "plan": "Gemini Code Assist", "command": "go@gemini-3.7-flash" },
  "subscriptions": [{ "prefix": "go", "plan": "Gemini Code Assist", "command": "go@gemini-3.7-flash" }]
}
```

It is the only `go@` row in the catalog, and it is its model's only advertised
route.

## 3. `swe-1.7` advertising Devin — not fixed

**Measured**, verbatim:

```json
{
  "id": "swe-1.7",
  "subscription":  { "prefix": "dv", "plan": "Devin", "command": "dv@swe-1.7" },
  "subscriptions": [{ "prefix": "dv", "plan": "Devin", "command": "dv@swe-1.7" }]
}
```

Still the only `dv@` row, still `swe-1.7`'s only route.

## 4. Subscription category cap — not fixed

| snapshot | rows in `subscription` |
|---|---|
| 2026-08-29 | 10 |
| 2026-08-30 | 15 |
| 2026-08-31 | 18 |
| **2026-09-02** | **18** |

The count has stopped moving but the mechanism is unchanged: routing data still
rides on membership of a ranked, capped list rather than on the model, so a model
pushed out silently loses its routes.

Four of the eighteen slots still hold entries with **no `prefix` at all** —
`claude-fable-5-1`, `claude-opus-5`, `claude-haiku-4-5`, `claude-sonnet-5`. That
is correct data for native Claude models, which need no prefix, but it means 22%
of a capped resource that exists to carry routing prefixes carries none.

## 5. `slim` / `recommended` disagreement — widened

This is the item that moved, and it moved the wrong way.

| | at task-writing | 2026-09-02 |
|---|---|---|
| distinct `subscriptionPlans` values in `slim` | 4 | **8** |
| `slim` models flagged plan-served | 6 | **53** |
| `recommended` models advertising a routing prefix | 13 | 14 |

The eight values, against claudish provider uids:

| `subscriptionPlans[]` value | matches a claudish provider uid? |
|---|---|
| `kimi-coding` | **yes** |
| `alibaba-token-plan-individual` | no |
| `alibaba-token-plan-team-edition` | no |
| `z-ai-glm-coding-plan` | no |
| `minimax-token-plan` | no — new |
| `ollama-cloud` | no — new |
| `opencode-go` | no — new |
| `streamlake-kwaikat-coding-plan` | no — new |

Seven of eight do not match. The question the task asked — **are these plan
identifiers or provider names?** — is still unanswered, and four new
plan-id-shaped values have arrived since it was asked.

### Why this now matters more to us than it did

claudish's `resolveSubscriptionRouting` compares this array against **provider
uids**. With one of eight matching, the safety check meant to drop a subscription
candidate that a plan does not actually serve is **active for Kimi alone and
inert for every other provider**.

The new `opencode-go` value is the concrete case. We shipped a change on
2026-09-02 that classifies the provider whose uid is `opencode-zen-go` as a
flat-rate plan. The catalog calls that same plan `opencode-go`. They will never
match, so that provider never returns `kind:"serves"` from the plan-aware path.

**What we need is a decision, not necessarily a change:**

- If these are meant to be **provider names**, please emit `qwen-cloud`,
  `glm-coding`, `minimax-coding`, `opencode-zen-go`, `ollamacloud`.
- If they are deliberately **plan identifiers**, say so and we will add an
  explicit mapping on our side and stop treating the mismatch as a bug.

Either answer is fine. The current state — two fields populated from different
inputs with nothing able to prove either wrong — is the condition that produced
every other item in the original task.

---

## New finding A — a model id changed silently

`claude-fable-5` on 2026-09-01 is `claude-fable-5-1` on 2026-09-02.

Model ids are the join key. A consumer that pinned, cached, or configured
`claude-fable-5` now refers to nothing. This is more consequential than a
cosmetic rename because ids appear in user configuration and in routing rules.

Two requests:

1. Confirm whether this was intentional and whether ids are considered stable.
2. If ids can change, that is worth stating in the schema, because consumers are
   currently assuming they cannot.

## New finding B — the duplicate `qc` is two plans, not a duplication bug

We previously reported that `qwen3.8-max`, `qwen3.8-flash` and `deepseek-v4-pro`
repeat `qc` inside one `subscriptions[]` array, and guessed the generator was
joining something twice. **That diagnosis was wrong**, and the real cause is more
interesting.

Enumerating every distinct `prefix | plan` pair in the catalog:

```
qc | QwenCloud Token Plan Individual     3 model(s)
qc | QwenCloud Token Plan Team Edition   3 model(s)
```

Two genuinely different plans share one prefix. So the array is correct; the
**prefix is ambiguous**.

The consumer-side consequence: claudish dedupes routes by prefix, so it collapses
these two into a single `qc@` entry and a user cannot tell from the Access line
which plan they would be billed against. Those are different commercial
agreements.

This is not a duplication to remove. It is either a prefix that needs splitting
(two prefixes for two plans) or an explicit statement that one prefix serves both
tiers and the distinction is not routable — in which case emitting one route
rather than two would be clearer.

For completeness, every plan advertised in the catalog today:

```
(no prefix) | Claude Code                4 models
cx  | OpenAI Codex                       3
dv  | Devin                              1
gc  | GLM Coding Plan                    2
go  | Gemini Code Assist                 1     <- retired, item 2
kc  | Kimi Code                          1
mmc | MiniMax Code Plan                  1
mv  | Mistral Vibe                       1
oc  | OllamaCloud                        5
qc  | QwenCloud Token Plan Individual    3     <- shares a prefix
qc  | QwenCloud Token Plan Team Edition  3     <- shares a prefix
zen | OpenCode Zen                       6
zgo | OpenCode Go                        9
```

## New finding C — the two OpenCode tiers are not access-separated (measured)

**Added 2026-09-02, after the sections above.** Not a defect in your payload. It
is a fact about the upstream both `zen@` and `zgo@` point at, it contradicts
something we had written down as true, and it changes what item 5 has to decide.

We had a claim in our own catalog that a key minted for one OpenCode tier is
refused by the other with a `401`. We measured it, on `minimax-m3` — a model both
tiers serve — one `chat/completions` POST per row:

```
CONTROL  Zen Go key -> https://opencode.ai/zen/go/v1/chat/completions -> 200 OK
CROSS    Zen Go key -> https://opencode.ai/zen/v1/chat/completions    -> 200 OK
BOGUS    fake key   -> https://opencode.ai/zen/v1/chat/completions    -> 401 AuthError
```

The bogus row proves the endpoint authenticates, so the cross-tier `200` is real
acceptance, not an open door. The two answered with different response-id shapes
(`06e71dee…` vs `chatcmpl-76bdafac…`) — different upstreams, one key. Raw
capture: `ai-docs/reports/data/measurements-20260902.txt`.

The rosters overlap heavily too, measured the same run: `/zen/go` serves 33
models, `/zen` serves 64, and **17 are served by both** (`minimax-m3`,
`minimax-m2.7`, `minimax-m2.5`, `kimi-k3`, `kimi-k2.7-code`, `kimi-k2.6`, …).

**Why this is yours and not only ours.** For those 17 models your catalog can
emit a `zgo` route and a `zen` route, and nothing observable at the endpoint
distinguishes them: same key works, same model answers. The only thing that
differs is **how the user is billed** — `zen` is metered, `zgo` is a flat-rate
Lite Plan. So for OpenCode the `subscriptions[]` array is carrying a *commercial*
distinction with no access-level backing, which is precisely the case a
positional, untyped array cannot express.

This is the same shape as **New finding B** (`qc` naming two different commercial
plans behind one prefix), arriving from the other direction: there, one prefix for
two plans; here, two prefixes for one access surface. Both say the array needs to
carry billing meaning explicitly rather than leaving consumers to infer it from a
prefix string.

**Concretely, two asks, both cheap:**

1. **Confirm what `opencode-go` in `subscriptionPlans[]` names** — the Lite Plan
   (`opencode.ai/zen/go`) or something else. This is item 5's question narrowed to
   the one value that is currently costing us behaviour, and finding C is why the
   answer cannot be inferred from which models it appears against: the rosters
   overlap.
2. **If the `zen` / `zgo` split is meant to be a billing distinction, mark it as
   one** — the `tier` field from item 1, or an explicit `billing: "metered" |
   "plan"` on the route. We will not infer it from the prefix, because we have now
   measured that access does not.

**What we changed on our side, so you can see the direction.** We removed the
alias that let the metered Zen key satisfy `zgo@`. It existed only because of the
401 claim this measurement refuted, and `zgo@` is classified flat-rate by name, so
the alias made "billed per token, displayed as a subscription at `$0`" reachable
with one env var. `zgo@` now requires its own `OPENCODE_GO_API_KEY`. We fixed our
own data rather than asking you to work around it.

**One direction remains unmeasured**, stated so nobody over-reads the above: a
Zen-tier key against `/zen/go`. We hold no Zen-tier key. The claim we refuted was
symmetric, so refuting one direction is enough to refute it, but it is not
evidence that both directions behave alike.

---

## What the claudish side shipped, for context

On 2026-09-02 we fixed the three client-side defects from the companion report:

1. `collectRoutingPrefixes` rendered only one route per model. It now renders
   every route in `subscriptions[]`, in the order you send them. Eight models
   gained routes.
2. The two OpenCode providers were classified backwards for billing.
3. `openai-codex` billing now follows the credential in play rather than the
   provider name.

**We did not implement any route preference.** Order is rendered exactly as sent
and is an explicit non-criterion in our validation, because the contract is
undeclared. If you add a `tier` field we will sort by it; until then we will not
guess.

One consequence worth flagging: now that we advertise every route you send, a
user can type a route that the item-5 plan-id mismatch prevents us from
resolving. That raises the priority of item 5 from our side.

## Priority we would suggest

1. **Item 5**, the plan-id-versus-provider-name decision, and with it **finding
   C's first ask** — what `opencode-go` names. Cheapest to answer, the only item
   currently blocking correct behaviour on our side, and finding C is why the
   answer cannot be inferred from the data: the two OpenCode tiers overlap in both
   keys and models.
2. **Items 2 and 3**, the two retired providers. Small, purely data, and both
   advertise routes that cannot work.
3. **New findings B and C together**, which are one problem seen twice: a prefix
   string is carrying a commercial distinction it cannot express. `qc` names two
   plans; `zen`/`zgo` name two billing modes over one access surface. Whatever
   fixes one should fix the other.
4. **Item 1**, the order contract, ideally as a declared `tier` field — which is
   also finding C's second ask, so these are the same piece of work.
5. **Item 4**, the cap, which is the structural version of items already fixed
   one at a time.
