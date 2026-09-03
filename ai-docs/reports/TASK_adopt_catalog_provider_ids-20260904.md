# Task: claudish adopts the catalog's provider ids

**Decision:** claudish stops maintaining its own provider names where they differ
from the catalog's. Providers are added rarely, so a hand-maintained list is
acceptable — with a periodic validation step so drift is caught.

**Status:** specified, not started.

## The divergence, measured

18 aggregator slugs in the catalog. 33 providers in claudish's
`BUILTIN_PROVIDERS`. **14 of 18 slugs already match a claudish provider by
name.** The gap is four:

| catalog slug | claudish name | nature |
|---|---|---|
| `anthropic` | `native-anthropic` | claudish renamed the vendor |
| `moonshotai` | `kimi` | claudish renamed the vendor |
| `fireworks` | *(none)* | claudish does not implement it |
| `together-ai` | *(none)* | claudish does not implement it |

So the work is **two renames**. `fireworks` and `together-ai` are separate — they
are providers claudish could add, not naming problems.

## Why this is smaller than it looks

162 references (`native-anthropic` 87, `kimi` 75) across ~20 files sounds
alarming. It is mostly mechanical, because **user-facing addresses do not
change.**

`PROVIDER_SHORTCUTS` maps what a user types to a canonical provider name. The
shortcut is the address; the canonical name is internal. So after the rename:

- `kimi@kimi-k3` still works — `kimi` stays a shortcut, now pointing at
  canonical `moonshotai`;
- `"routing": { "kimi-*": ["kimi"] }` still works — routing entries resolve
  through `PROVIDER_SHORTCUTS` in `buildRoutingChain`;
- `anthropic/claude-opus-5` still resolves — `auto-route.ts:43` already maps
  `anthropic/*` to the canonical provider.

Nothing a user has written breaks. That is the property that makes this
worth doing rather than merely tidy.

## What must change together

The canonical name is a key in several places, and CLAUDE.md already records
that missing one fails **silently**:

1. `BUILTIN_PROVIDERS` — the definition itself.
2. `PROVIDER_PROFILES` — a missing profile routes to OpenRouter with no error.
   This is the documented silent failure; it applies directly here.
3. `PROVIDER_SHORTCUTS` — keep the old name as a shortcut so user config and
   muscle memory survive.
4. `SUBSCRIPTION_PROVIDERS` — a provider absent from this set quotes a flat-rate
   user a per-token price and accrues fictional spend.
5. `CREDENTIAL_DECIDED_PROVIDERS` — `openai-codex` is unaffected, but check the
   set is keyed on canonical names.
6. `PROVIDER_TO_PREFIX` / `DISPLAY_NAMES` in `auto-route.ts`.
7. `DEFAULT_ROUTING_RULES` — `"claude-*": ["native-anthropic", ...]` names it
   directly. (This file is being removed by the catalog-driven refactor, so
   sequence the two.)
8. Credential providers — `auth/credentials/native-anthropic-credential.ts` and
   its registration in `authority.ts`.
9. `FIREBASE_SLUG_TO_PROVIDER_NAME` — the two entries this task exists to delete.

## Suggested approach

**Do not do a bare find-and-replace.** `anthropic` appears as a vendor string, a
URL fragment, and an env-var stem; `kimi` appears in model ids (`kimi-k3`),
shortcuts, and the `kimi-coding` provider name, which is NOT being renamed.

Instead:

1. Add the new canonical name as the definition key, and register the old name in
   `PROVIDER_SHORTCUTS` pointing at it.
2. Update the keyed sets in §"What must change together", one at a time, running
   the suite between each.
3. Only then remove the old canonical name from internal code paths.
4. Delete the two `FIREBASE_SLUG_TO_PROVIDER_NAME` entries last, as the proof the
   rename is complete.

`native-anthropic-mapping.test.ts` and `provider-routing.test.ts` already pin
much of this behaviour and should go red at step 3 if anything was missed.

## Keep the slug next to the provider

Rather than deleting `FIREBASE_SLUG_TO_PROVIDER_NAME` and having nothing, fold it
into the provider definition:

```ts
{ name: "moonshotai", catalogSlugs: ["moonshotai", "kimi"], ... }
```

Two reasons. First, cache and client versions skew — a client that has renamed
can still meet a catalog serving the old slug, and vice versa. Second, CLAUDE.md
already documents that `BUILTIN_PROVIDERS` and `PROVIDER_PROFILES` must be edited
together or routing fails silently; a *separate* slug table is that same defect a
third time. Putting the slug on the definition means one edit, and a new provider
cannot be added without declaring it.

## Make a miss loud

Today an unmappable catalog slug produces a candidate `getProviderByName()`
cannot resolve, it is filtered out of the chain, and the route disappears with no
message. Whatever the naming, an unknown slug encountered while building a chain
for a model the user actually asked for should be logged.

Silence is the part that made the v9.0.1 and v9.0.4 defects expensive: in both,
the wrong thing happened quietly and looked like correct behaviour.

## Periodic validation

Since the list is hand-maintained, add a check that runs on demand and in CI:
every `aggregators[].provider` slug seen in the cached catalog resolves to a
claudish provider, or is on an explicit "not implemented" list. A new backend
slug then shows up as a failing check rather than as a silently missing route.

`fireworks` and `together-ai` go on that list today.

## Reference

`ai-docs/reports/routing-refactor-investigation-20260903.md` §3 for the
measurement and the reasoning, including why the backend publishing
`routing.providerUid` on the plan side already establishes the pattern.
