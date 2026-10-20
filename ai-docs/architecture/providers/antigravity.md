> Gemini on an Antigravity subscription: shared keychain token, runtime client-secret extraction, live model discovery.
>
> Extracted from `CLAUDE.md` (v7.64.0). Indexed in [`README.md`](./README.md).

# Antigravity Provider (`ag@`) — Gemini via your Antigravity subscription

Two separate Gemini flows, deliberately split:

| Flow | Prefix | Auth | Backend | Billing |
|---|---|---|---|---|
| Direct Gemini API | `g@` / `google@` | `GEMINI_API_KEY` | `generativelanguage.googleapis.com` | pay-per-use |
| **Antigravity** | `ag@` / `antigravity@` | your Antigravity OAuth token (shared with the `agy` CLI) | `daily-cloudcode-pa.googleapis.com/v1internal` | your Antigravity subscription (free / Pro / Ultra) |

**The `gemini-codeassist` provider was fully REMOVED (v7.36.0)** — definition, transport, credential provider, OAuth registration, quota adapter, probe entry, and the `--gemini-login`/`--gemini-logout` flags. It could not authenticate for any consumer account, yet it sat FIRST in the `gemini-*` routing chain, so every bare `gemini-*` name paid a guaranteed-failing round-trip before falling through to the metered `google` API — silently billing per-token for a model the user's subscription already covered. A leftover `~/.claudish/gemini-oauth.json` no longer reads as a live credential (its `oauth-registry.ts` entries are gone), which is what kept a dead provider in the config TUI's Test All list.

**Bare `gemini-*` reaches `ag@` through a NAMESPACE CLAIM, not a routing table.** The hand-written `"gemini-*": ["antigravity", "google", "openrouter"]` chain was deleted with the rest of `default-routing-rules.ts`. `google/antigravity-subscription` sits in the probe map as `client_model_selection_required` and publishes zero `aggregators[]` rows — the catalog cannot say what a seat was given — so the provider declares `nativeModelPatterns: [{ pattern: /^gemini-/i }]` and `route-candidates.ts` turns that into a `dynamic-subscription`-tier candidate, which the tier order puts ahead of the metered `google` hop. The claim deliberately does not win auto-detection (`google` declares the same pattern and is defined earlier in `BUILTIN_PROVIDERS`, and `getNativeModelPatterns()` is first-wins), and it deliberately does NOT cover `/^claude-/i` even though the backend serves Claude ids: a bare Claude name must never reach `route()` at all — `nativeRouteFor()` handles it first.

The Antigravity half of the old `auth/gemini-oauth.ts` was extracted to **`auth/antigravity-user.ts`** (project/tier resolution, `retrieveUserQuota`, live discovery of the account's dynamic models catalog) before that file was deleted — Antigravity depends on it, so deleting wholesale would have taken `ag@` down too. All three calls now share ONE identity (the Antigravity User-Agent). `retrieveUserQuota` used to keep the gemini-cli UA it was written with; measured 2026-08-18 on a real Ultra account, same token and project, only the UA varying — the gemini-cli UA returned 4 quota buckets (the membership of the retired free Code Assist plan) and the Antigravity UA returned 24. This backend gates its ANSWER on request identity, not just the tier label it displays.

**Why not just spoof the identity:** the backend has two independent gates. `loadCodeAssist` gates the visible *tier* on request identity (`User-Agent` + `metadata.ideType: ANTIGRAVITY`), but `streamGenerateContent` gates *generation* on the OAuth **client that minted the token** — headers can't fake it (403 PERMISSION_DENIED). So claudish does not spoof; it **reuses the user's own Antigravity token**. A third gate sits on top of both: the client VERSION in the User-Agent decides which models exist at all — see [The client version gates discovery AND generation](#the-client-version-gates-discovery-and-generation-2026-10-14).

## THE HOST IS NOT `cloudcode-pa` (v7.66.0)

`ag@` was built from the remains of the removed `gemini-codeassist` provider. The
token was swapped to Antigravity's; the HOST was kept, under a source comment
asserting *"the split was never about the URL, it was about which OAuth client
minted the token."* **That assertion was wrong**, and it cost a full debugging
session.

`cloudcode-pa.googleapis.com` is **Code Assist's** backend — the product Google
retired for individuals. Antigravity's own backend is
`daily-cloudcode-pa.googleapis.com`. Present an Antigravity token to the former
and you are answered *as Code Assist*.

Measured 2026-08-24 — one Google AI Ultra account, same token, same project, same
model, only the host varying:

```
cloudcode-pa.googleapis.com        generate gemini-3.6-flash-high -> 429
daily-cloudcode-pa.googleapis.com  generate gemini-3.6-flash-high -> 200
```

On `cloudcode-pa` that account reads `currentTier: free-tier` (while `paidTier`
says `g1-ultra-tier`), is served a dynamic models catalog of `gemini-2.5-*` plus editor-internal
`chat_*`/`tab_*` ids, reports every quota bucket at 100% **forever** because
nothing is ever consumed, and can generate with EXACTLY the two `tab_*`
inline-completion models — free Code Assist's remaining entitlement — while all
28 chat models return a **contentless** `RESOURCE_EXHAUSTED`:

```json
{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).",
          "status":"RESOURCE_EXHAUSTED"}}
```

No `details`, no `ErrorInfo`, no `RetryInfo`. It is not a rate limit; it is the
wrong product. Those two `200`s are what let nine wrong hypotheses survive — an
identity rejected everywhere tells you nothing, but one that succeeds on exactly
the completion models is naming its own tier out loud.

`agy` 1.1.18 has never called anything else: 2,822 requests across 73 log files
spanning a week, 100% to `daily-`, 0% to `cloudcode-pa`. Its log is the primary
source — `~/.gemini/antigravity-cli/cli.log`, lines beginning `URL:`.

`AICODE_ENDPOINT_URL` overrides the host. It is the same variable `agy` reads, so
a user on a different release track can point claudish where their own CLI goes.

## `-tiered` means the tier is a PARAMETER, not part of the id

The Antigravity CLI shows "Gemini 3.7 Flash" with a low/medium/high **Effort**
slider. That is one model, not three: `gemini-3.7-flash-high` **404s**, and the
only served 3.7 id is `gemini-3.7-flash-tiered`. The response declares it:

```json
"tieredModelIds": {"flashLite":["gemini-3.1-flash-lite"],
                   "flash":["gemini-3.7-flash-tiered"],
                   "pro":["gemini-3.1-pro-low"]}
```

Gemini 3.6 still bakes the tier into the id (`-high`/`-low`/`-medium`); 3.7 moved
to the parameter form. **Both shapes are live at once.** Effort travels as
`generationConfig.thinkingConfig.thinkingLevel` (`low`/`medium`/`high`, all
verified 200), which `adapters/gemini-api-format.ts` already emits for any
`gemini-3*` id from Claude Code's own effort setting — so claudish has the Effort
slider already. `xhigh` and `max` both collapse to `high`, because Gemini 3 has
nothing above it.

**Do not read `agy models` output as API ids.** It is the CLI's DISPLAY
vocabulary. Doing so produced a bug report asking a backend to add five ids that
404 and delete the one that works.

## The dynamic models catalog: what the backend declares unselectable

`fetchAvailableModels` returns the whole editor surface, and states three ways
which of it is not a chat model — all of them read by
`getServedAntigravityModels`:

| Signal | Shape | Example |
|---|---|---|
| `isInternal: true` | per-model flag | `chat_20706`, `chat_23310` (both 400) |
| modality role lists | `tabModelIds`, `imageGenerationModelIds`, `audioTranscriptionModelIds` | `gemini-3.1-flash-image` |
| `deprecatedModelIds` | **map** id → `{newModelId}` | `gemini-3.1-pro-high` → `gemini-pro-agent` |

The deprecation map is load-bearing: `gemini-3.1-pro-high` is still present in
`models`, looks entirely ordinary, carries full capability flags — and answers
`400 INVALID_ARGUMENT`. The deprecation notice is the only warning given.

NOT excluded: `mqueryModelIds` / `webSearchModelIds` / `commitMessageModelIds`.
Those are role ASSIGNMENTS of an ordinary model — all three name
`gemini-3.1-flash-lite`, which chats fine. Treating a role as a disqualification
dropped a real model from the picker.

Only `tab_*` needs a prefix rule; it appears in no list and carries no flag.

## The client version gates discovery AND generation (2026-10-14)

claudish sent `antigravity/cli/1.1.9` from a hard-coded literal while the
installed `agy` was 1.3.5. Same token, project and host, only the version in the
User-Agent varying:

| UA version | `fetchAvailableModels` | `defaultAgentModelId` | `streamGenerateContent` `gemini-4-argon-low` |
|---|---|---|---|
| 1.1.9 | 23 ids; no `gemini-4*`, no `gemini-3.8-flash-{high,medium,low}` | `claude-opus-5-5-low` | **404** |
| 1.3.5 | 29 ids; + `gemini-4-argon-{high,medium,low}`, + `gemini-3.8-flash-{high,medium,low}` | `gemini-4-argon-medium` | **200** |

So the version is not cosmetic: a pinned one hides every model released after
the pin, from the picker AND from generation, with nothing in the response to say
so. The earlier claim that the UA "does not gate generation" was true only for
models old enough to predate every version claudish ever sent.

**The version is read from agy, once per auth session.** agy auto-updates, and
claudish already depends on it for the token, so the installed agy's version is
the one value that cannot drift. `auth/antigravity-token.ts` runs `agy --version`
(prints `1.3.5`, 0.04 s) whenever `getValidAntigravityAccessToken` or
`forceRefreshAntigravityToken` hands out an access token that differs from the
one the last read was made for — a new token means agy just ran, which is when it
may have updated. Same token → the cached value, at the cost of a string compare.
The value lives in `auth/antigravity-client-version.ts`; `buildAntigravityUserAgent`
reads it.

- **A failed read keeps the previous good version.** It never demotes a session to
  the floor, and it is not retried until the token changes.
- **`1.1.9` remains only as a floor** for when agy cannot be read at all (not
  installed, broken). It is not a target; nothing ever pins to it again.
- **The served-models cache is keyed to the version.** `getServedAntigravityModels`
  drops a cache fetched under another version, because that answer is a different
  dynamic models catalog, not a stale copy of the same one.

## The picker lists `agentModelSorts`, routing lists `models`

`agy models` prints exactly `agentModelSorts[*].groups[*].modelIds`, in that
order — on the 2026-10-14 account, 13 ids. The `models` dict carries more: older
generations (`gemini-2.5-*`, `gemini-3-*`, `gemini-3.5-*`) and
`gemini-3.8-flash-tiered`, which agy does not offer for selection.

`getServedAntigravityModels` returns that list as `agentModelIds` (flattened over
every sort and group, order kept, deduplicated). The `ag@` picker then lists
exactly those ids that are also served and not declared excluded, in agy's order.
When the field is absent or empty the picker falls back to every selectable served
id, newest first — absent means unknown, not "none".

**The narrowing happens in the picker, not in the discovery fetcher.**
`fetchAntigravityModelsCatalog` still returns every selectable id; agy's ids lead
and carry `providerOrder` (their position), the rest carry none.
`buildRowsFromDiscovered` keeps only the rows that carry it, in that order. The
fetcher's list is not the picker's alone: `providerServesModel` — the routing
chain's availability filter — and `discoverContextWindow` read it too, and a
dynamic models catalog is the one source allowed to answer "not-served", which
REMOVES a hop. Narrowing the fetcher would have routed a bare `gemini-2.5-pro`
past the subscription to a metered provider.

Routing is unchanged: `resolveAntigravityModelId` and the transport resolve
against the full `servedIds`, so a typed `ag@gemini-2.5-pro` still works.

## Ordering: cloud models catalog dates are poison for Antigravity's models

Antigravity rows set `ignoreCatalogReleaseDate`. `compareByReleaseDateDesc` sorts
undated rows last, and measured 2026-08-24 only 6 of 19 served ids had a catalog
date — every one of them an OLD base model, while every new variant had none:

```
dated    gemini-2.5-flash          2025-04-17     <- sorted to the TOP
UNDATED  gemini-3.7-flash-tiered          —       <- sorted to the BOTTOM
```

The catalog dates *base* models; Antigravity serves *variants* it does not list.
Six dated of nineteen was worse than zero: a partial signal ranked confidently on
incomplete evidence. Suppressed, the whole dynamic models catalog falls through to version-parts
and orders 3.7 > 3.6 > 3.5 > 3.1 > 3 > 2.5.

That rule now governs only the fallback list. When the backend sends
`agentModelSorts`, the picker shows agy's own order instead (previous section).


**Token lifecycle** (`auth/antigravity-token.ts`, macOS):
- **Shared store**: the same keychain item the `agy` CLI uses — `service=gemini, account=antigravity`, value `go-keyring-base64:<base64(JSON)>` (zalando/go-keyring). claudish reads AND writes it, so both tools reuse one live token.
- **Self-refresh**: when the token is expired, POST `oauth2/token` with `grant_type=refresh_token`. The Antigravity client_id/secret are **never shipped** — they're extracted at runtime from the user's own local `agy` binary (`strings` for the `…apps.googleusercontent.com` id + `GOCSPX-` secret; the working combo is discovered by first-200 and cached). The refreshed (and possibly rotated) token is written back to the shared store.
- **Degradation**: no store (agy not installed / not signed in) or non-macOS → actionable error pointing at `g@` + `GEMINI_API_KEY`.

**Model ids — LIVE discovery, no hardcoded map**: the Antigravity backend requires a reasoning-tier suffix (bare `gemini-3.6-flash` → 404), but which variants a subscription serves is **per-account and drifts**, so claudish never hardcodes a model list. `getServedAntigravityModels()` fetches the live set from the backend's own `v1internal:fetchAvailableModels` (body `{project}`) — the served ids are the response `models` keys, plus a backend `defaultAgentModelId` — cached with a TTL. `resolveAntigravityModelId(requested, servedIds, defaultId)` then resolves against that LIVE set: exact match passes through; a bare family (e.g. `gemini-3.6-flash`) resolves to the backend's `defaultAgentModelId` when it's a variant of that family, else to the strongest reasoning tier by a *rank rule* (`high>medium>low>extra-low>tiered` — a rule, like `rankCodeAssistModel`, not pinned ids); anything else passes through to the F1–F7 404 rewrite. The only literals are the tier-rank ordering and endpoint strings — no concrete model ids in source.

**Identity strings**: `User-Agent: antigravity/cli/<ver> (aidev_client; os_type=<platform>; arch=<arch>; auth_method=consumer)` + `metadata: { ideType: "ANTIGRAVITY" }`. The transport keeps all the F1–F7 improvements from the old codeassist path (terminal-error → 400 surfaced inline, the 404 rewrite that checks the dynamic models catalog, `rankCodeAssistModel`). Full reverse-engineering write-up: `ai-docs/sessions/antigravity-refactor-20260803-125333-d0791562/architecture.md` (write-up lost — predates the ai-docs tracking fix).
