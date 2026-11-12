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

**A bare Google model reaches `ag@` through a VENDOR CLAIM, not a routing table or a pattern.** The hand-written `"gemini-*": ["antigravity", "google", "openrouter"]` chain was deleted with the rest of `default-routing-rules.ts`, and the `/^gemini-/i` regex claim is removed: the provider declares no `nativeModelPatterns`. `google/antigravity-subscription` sits in the probe map as `client_model_selection_required`, and the catalog cannot say what a seat was given. So `route-candidates.ts` adds an `ag@` candidate for a catalog chat model whose vendor is `google`, when the catalog publishes no Antigravity connection for it; a published connection wins. The account's dynamic models catalog can also add an account-listed candidate for a name it carries. Either is a `dynamic-subscription`-tier candidate, which the order puts ahead of the metered `google` hop. `google` keeps its own `/^gemini-/i` pattern, which only decides what `parseModelSpec` attributes a bare name to. A Claude id the backend serves adds nothing: a bare Claude name must never reach `route()` at all, because `nativeRouteFor()` handles it first.

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

**The availability check resolves ids the way the transport does** (2026-10-21,
`ai-docs/reports/model-failures-2026-10-21.md` D8). `providerServesModel` used to
match the requested id exactly against the dynamic models catalog, because
Antigravity has no entry in the resolver registry. On an account serving only
`gemini-3.8-flash-tiered`, `ag@gemini-3.8-flash` therefore read as not served and
`--advisor` refused it, while the transport would have sent the tiered variant; a
bare `gemini-3.8-flash` lost its `ag@` hop the same way and went to a metered
provider. The transport, the credential and the check now share one function,
`resolveAntigravityServedModel` (`transport/antigravity.ts`):
`resolveAntigravityModelId` with the cloud models catalog's family default
(`lookupFamilyDefaultVariant`). The check feeds it the transport's own inputs, the
full `servedIds` and the backend's `defaultAgentModelId`, from the `getServedAntigravityModels` cache
the discovery just filled (`peekServedAntigravityModels`), and then asks whether
the resolved id is in the dynamic models catalog. An id the backend declares
unselectable therefore still reads as not served. With no cache (a fetch that
never succeeded under this client version) it resolves against the dynamic models
catalog's ids with no backend default. Antigravity stays out of the resolver
registry: a resolver there receives neither the full `servedIds` nor the backend
default.

**The effort level chooses the id, from the connection's effort map** (2026-11-12).
Before this, effort never reached the id: `low` still sent `gemini-4-carbon-high`.
`resolveAntigravityServedModel(requested, served, effort?)` now reads the
`modelIdEffort` map of the Antigravity connection whose `externalModelId` equals
`requested` (`findModelIdEffortConnection`, `adapters/model-catalog.ts`; never a
sibling connection, so a 1M base never takes the default-context map). A connection
spelled exactly as requested decides even when it publishes no map; a case-folded
spelling is consulted only when no connection has the exact one. The choice itself
is `chooseConnectionModelId` (`providers/model-id-effort-choice.ts`), the function
Devin uses too. At effort `e` it sends `values[e]`, else the next higher listed
level, else the highest; `none` sends the published `off` id. With no effort a
served base the backend does not exclude is sent as itself (an excluded base is
never sent: exclusion is checked before that shortcut, in the map step and in the
exact-id step, so the transport, `providerServesModel` and the account-listed
route candidate all reach the same map id); otherwise claudish decides the level (`wire.md`
"Recommended effort": the efforts table's `default` cell for this connection, else
`medium`) and maps it as above. The backend's `defaultAgentModelId` and the
catalog's `modelIdEffort.default` do not decide for a mapped base. An id the
account does not serve, an id the backend declares unselectable (`excludedIds`:
internal, role-bound, retired; the set discovery drops), or a `-fast`/`-priority`
id, is never chosen from the map: the rules above answer instead, over the
selectable ids only: served, not excluded, and no speed premium, so neither the
backend default nor the catalog's family default (`lookupFamilyDefaultVariant`) can
pick the `-fast` id the map just refused (an exactly requested served id the
backend does not exclude still passes, premium included). The availability
check reads the same `excludedIds` from the `peekServedAntigravityModels` cache, so
it agrees with the transport. An exact id that is not a mapped base
(`gemini-4-carbon-low`) is sent unchanged at any effort.

The effort reaches the one decision on both paths. The credential takes it as
`RequestAuthContext.effort`, and its envelope builder takes the request's effort as
`transformPayload(payload, {effort})`, because one artifact serves turns with
different levels. The transport reads the level in `transformPayload` and hands it
to the credential's builder, or resolves with the same function for its local
builder. The level is the `--effort` pin when one is set (`ComposedHandler` pins it
on the dialects and on the transport, `ProviderTransport.setEffortOverride`); else
`none` when the Claude request turns reasoning off (`thinking.type: "disabled"`,
effort `none`, `budget_tokens: 0`); else `output_config.effort`, else the legacy
`thinking.budget_tokens` bucket (`wireChoicesFromClaudeRequest`). `none` is kept
rather than dropped, because it is what selects the `off` id. A call with no Claude
request and no pin is a request with no effort and is resolved afresh on both
builders; it never reuses the previous turn's id. `refreshAuth` resolves
`servedModelName` at the pin, and `servedModelName` then follows the id actually
sent.

**No effort in the body beside an effort-carrying id.** The catalog contract says
the effort is never written into the request body. The body follows the id
actually SENT on each attempt, never the requested one: when the sent id is one an
Antigravity effort map lists (a level or `off`), `antigravityBodyForModelId`
removes `thinkingLevel` and `thinkingBudget` from `generationConfig.thinkingConfig`
(dropping the object when nothing else is left) and keeps `includeThoughts`; any
other sent id keeps the dialect's control. Deciding by the requested base lost the
effort twice: a mapped base whose map id the account does not serve falls back to
an unmapped id (`gemini-3.7-flash` at `low` sending `gemini-3.7-flash-tiered`),
which then carried no effort anywhere; and a capacity retry reused the primary's
body, shaped for a different id. Both builders shape the primary from the original
dialect payload, and the transport keeps that payload (`lastPayload`) so every
capacity retry shapes it again for its own id.

**The capacity fallback never picks a speed premium.** On
`MODEL_CAPACITY_EXHAUSTED` the retry candidates are the served ids minus the one
that failed, minus every `-fast`/`-priority` id and every id in `excludedIds`. With
none left, the original capacity failure is returned. `getActiveModelName()` names
the retry id that served the CURRENT request only: `enqueueRequest` clears it as
each request starts, so a later request served on its primary id never reports an
earlier retry to the status line.

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
- **Refresh is delegated to `agy`**: when the access token is expired or within 2 minutes of expiry, claudish runs `agy models` (12 s timeout). That lightweight, authed command makes `agy` mint a fresh token with its OWN current client secret and write it back to the shared store, and claudish then re-reads the store. claudish never handles the Antigravity client secret in any form: no embed, no scrape, no token exchange. The secret is a literal inside `agy`, and `agy` auto-updates, so each release rotates it and Google revokes the old one. Any copy claudish held would break within days. The refresh outcome (`ran` / `not-installed` / `timeout` / `failed`, with agy's stderr) decides the error: a slow or failing `agy` is retryable, while a missing `agy` or a session that is still stale after a clean run is terminal.
- **Degradation**: no store (agy not installed / not signed in) or non-macOS → actionable error pointing at `g@` + `GEMINI_API_KEY`.

**Model ids — LIVE discovery, no hardcoded map**: the Antigravity backend requires a reasoning-tier suffix (bare `gemini-3.6-flash` → 404), but which variants a subscription serves is **per-account and drifts**, so claudish never hardcodes a model list. `getServedAntigravityModels()` fetches the live set from the backend's own `v1internal:fetchAvailableModels` (body `{project}`) — the served ids are the response `models` keys, plus a backend `defaultAgentModelId` — cached with a TTL. `resolveAntigravityModelId(requested, servedIds, defaultId)` then resolves against that LIVE set: exact match passes through; a bare family (e.g. `gemini-3.6-flash`) resolves to the backend's `defaultAgentModelId` when it's a variant of that family, else to the strongest reasoning tier by a *rank rule* (`high>medium>low>extra-low>tiered` — a rule, like `rankCodeAssistModel`, not pinned ids); anything else passes through to the F1–F7 404 rewrite. The only literals are the tier-rank ordering and endpoint strings — no concrete model ids in source.

**Identity strings**: `User-Agent: antigravity/cli/<ver> (aidev_client; os_type=<platform>; arch=<arch>; auth_method=consumer)` + `metadata: { ideType: "ANTIGRAVITY" }`. The transport keeps all the F1–F7 improvements from the old codeassist path (terminal-error → 400 surfaced inline, the 404 rewrite that checks the dynamic models catalog, `rankCodeAssistModel`). Full reverse-engineering write-up: `ai-docs/sessions/antigravity-refactor-20260803-125333-d0791562/architecture.md` (write-up lost — predates the ai-docs tracking fix).

## Raw model list for models-index (`claudish subscription models antigravity --raw --json`)

**Why it exists.** The models-index catalog publishes no exact connections on route
`google/antigravity-subscription`, so a bare `gemini-4-argon` routes to the metered Gemini API.
The models-index wire-probe runner (a nightly macOS LaunchAgent with no TTY and no browser) runs this
command, uploads stdout, and seals the body as evidence for the connections it publishes. Code:
`subscription-models-command.ts`.

**It reuses the `ag@` path; it does not copy it.**
- `readAntigravityStoreClassified` is the bounded keychain read.
- `getValidAntigravityAccessToken` (with observed deps) refreshes through `agy models` when the
  token is expired.
- `setupAntigravityUser` resolves the project.
- `fetchAntigravityAvailableModelsRaw` returns the body BEFORE any processing.
  `getServedAntigravityModels` calls the same function and processes its result: exclusions,
  displayName, `agentModelSorts`. There is no cache, so every run is a live fetch.

`--raw` and `--json` are both required in v1. Each of these is a usage error:
- a missing flag;
- the `ag` shortcut in place of `antigravity`;
- an extra token.

A usage error exits 2, with the fixed usage line on stderr and an `internal`/`usage` failure line on
stdout. The bare form is kept free for a later human view.

### Schema `claudish.subscription-model-list.v1`

**Every exit, 0 and 1 to 7, prints exactly one JSON object on ONE stdout line**, through the awaited
write before `process.exit`. Keys in this order:

```
schema, provider? ("antigravity"), claudishVersion,
fetchedAt?, sourceUrl?, clientVersion?, clientVersionSource?,
tokenRefreshed, httpStatus?, failure?, body?
```

**Field-presence rule:** a field appears exactly when this run determined it.

| Field | Present when |
|---|---|
| `provider` | the provider was determined: every exit except a usage error and the `index.ts` catch |
| `tokenRefreshed` | always. True when this run asked agy to refresh, even if that refresh failed |
| `clientVersion`, `clientVersionSource` | a valid token was obtained. The value is the version in the User-Agent actually sent. `"fallback"` means the 1.1.9 floor, which hides every `gemini-4-argon-*` id |
| `sourceUrl` | `fetchAvailableModels` was attempted. It is `antigravityHost()` (honours `AICODE_ENDPOINT_URL`) with any userinfo stripped |
| `fetchedAt`, `httpStatus` | `fetchAvailableModels` answered with a status |
| `body` | success only. A STRING: the 2xx response text exactly as `res.text()` read it, byte for byte, untrimmed |
| `failure` | `{ class, code, httpStatus? }`. Each is a fixed string, with no error text; every code matches `^[a-z0-9_.:-]{1,120}$` |

**`body` is the response text, never a re-serialization.** models-index seals it as evidence, and
`JSON.parse` followed by `JSON.stringify` is not the bytes the backend sent: number spellings,
escapes and whitespace can change. The success test still parses the text (2xx, valid JSON,
`models` a non-empty plain object); the parse decides success and is never printed.
`fetchAntigravityAvailableModelsRaw`'s `json` variant carries both `text` and `value`;
`getServedAntigravityModels` reads only `value`.

A non-2xx `fetchAvailableModels` answer is **not a failure**: exit 0, with `httpStatus` and no `body`.

### Failure taxonomy and exit codes

| Class | `code` | Exit |
|---|---|---|
| — (success, or a non-2xx answer) | — | 0 |
| `credential_missing` | `platform_unsupported`, `keychain_item_absent`, `token_unparseable` | 3 |
| `keychain_locked` | `keychain_locked` (security exit 36/51/128), `keychain_read_timeout` (10 s), `keychain_read_failed` (any other exit) | 4 |
| `mint_failed` | `agy_missing`, `agy_refresh_failed`, `agy_refresh_timeout`, `agy_refresh_no_valid_token` | 5 |
| `mint_failed` | `load_code_assist_4xx` (with `httpStatus`), `load_code_assist_no_project`, `load_code_assist_bad_body` | 5 |
| `network` | `load_code_assist_429`, `load_code_assist_5xx` (with `httpStatus`), `load_code_assist_network_error`, `load_code_assist_timeout` (30 s) | 6 |
| `network` | `fetch_available_models_network_error` (unreachable, or a 2xx body that could not be read), `fetch_available_models_timeout` (30 s abort) | 6 |
| `list_incomplete` | `models_absent`, `models_empty`, `body_not_json` (all 2xx, with `httpStatus`) | 7 |
| `internal` | `usage` | 2 |
| `internal` | `secret_guard`, `internal_error` | 1 |

Class `internal` keeps the fixed stderr line of each case, and adds the stdout line:
- `usage`: `schema`, `claudishVersion`, `tokenRefreshed: false`, `failure`. No `provider`: none was
  determined.
- `secret_guard`: every field determined so far, and never a `body`. That line is checked against
  the secrets too; on a hit (it holds no body, so it cannot happen) nothing is printed.
- `internal_error`: `schema`, `provider`, `claudishVersion`, the `tokenRefreshed` known so far, and
  `failure`; nothing else the failed run determined. The `index.ts` catch around the whole command
  prints the same line without `provider` and with `tokenRefreshed: false`. The error text is
  never printed.

A stdout write that itself fails exits 1 with the stderr line only: a second line after a partial
write would leave two objects on stdout.

A `loadCodeAssist` 429 or 5xx is `network`, not `mint_failed`: it is transient
(`credential-error.ts`).

A refresh failure is classified from what the run OBSERVED, never from message text. The command
records whether `runAgyRefresh` was called, and its `AgyRefreshOutcome`:
- No refresh was called: `token_unparseable`.
- `not-installed`, `timeout` or `failed`: the matching `agy_*` code.
- `ran`, but the re-read token is still stale: `agy_refresh_no_valid_token`.

### Keychain lock handling

`defaultReadStore` maps every `security` failure to null, so a locked keychain reads as "not signed
in", and it has no deadline. The command uses `readAntigravityStoreClassified(10 s)` instead.

**Step 1, presence.** `find-generic-password` without `-w` reads no item data.
- Exit 44 is `absent`.
- It is NOT a lock probe: on a locked temporary keychain it answered exit 0 with the full attribute
  dump (measured 2026-10-21).

**Step 2, the value read (`-w`).** This is the step a locked keychain refuses. Measured on a locked
temporary keychain: exit **128** (errSecUserCanceled), empty stderr, after 1.5 s, and no call left
running. `security` exits with the low byte of the negated OSStatus:
- 44 (errSecItemNotFound) is measured.
- 36 (errSecInteractionNotAllowed) and 51 (errSecAuthFailed) are derived from the same arithmetic.

All three map to `keychain_locked`.

Both steps race one 10 s deadline. **`security` is never killed** (keychain.md: a killed `security`
once made macOS restart `securityd`). A LaunchAgent in the Aqua session may get a real unlock dialog.
Then the deadline reports `keychain_read_timeout`, the dialog is left to the user, and the command
exits explicitly, because the unkilled child would otherwise keep the event loop alive.

The pre-read value is handed to the token module as its first `readStore` answer, so that module
never spawns an unbounded read of its own. The one re-read after a refresh uses the default
synchronous read, which has no deadline. This is accepted and recorded as risk R4 of the design.

### LaunchAgent PATH

`locateAgyBinary()` runs `which agy`, then `~/.local/bin/agy`. launchd's default PATH has no
Homebrew prefix. An `agy` installed only under `/opt/homebrew/bin` is therefore invisible to a
LaunchAgent, with two effects:
- the version reads as `clientVersionSource: "fallback"`;
- an expired token fails as `agy_missing`.

**The plist must set PATH** to include the directory `agy` lives in.

### Secret guard

- stdout is built only from the typed envelope. An `err.message` is never printed: messages
  embed vendor text (`loadCodeAssist` bodies) and agy's stderr.
- Before writing, the raw body text AND the serialized line are checked for these values, in
  full. Checking the raw text too means an escaped form in the line cannot hide a credential.
  - the access token;
  - the raw store value;
  - every refresh token read;
  - the project id.

  A hit exits 1 with the stderr line
  `[claudish subscription] refused: output contained a credential value`, and stdout carries the
  body-free `internal`/`secret_guard` line instead.
- `log()` writes only to files, and only after `initLogger`, which this command never calls. The
  project-id log lines in `antigravity-user.ts` therefore go nowhere.
- stderr carries only fixed lines.

The write is awaited before `process.exit`. Measured: an unawaited `process.stdout.write` of the
200 KB line followed by `process.exit` reaches a pipe as exactly 65,536 bytes, 3 runs of 3. Awaiting
the write callback delivers all of it.

## Wire probe for models-index (`claudish subscription probe antigravity`)

```
claudish subscription probe antigravity --model <wire model id> --request-file <path> --raw --json
```

**Why it exists.** The models-index wire-probe runner must send ONE real request through the
user's Antigravity login, to prove what a connection does on the wire, without ever holding the
token. The runner writes the inner Gemini-format `request` object to a file (`contents`,
`generationConfig` with `thinkingConfig`, `tools`, `toolConfig`, `systemInstruction`) and seals the
printed answer as evidence. Code: `subscription-probe-command.ts`. The steps it shares with the
model-list command (platform, bounded keychain read, observed token refresh, client version,
`loadCodeAssist`) live in `subscription-antigravity-session.ts`, so the two cannot drift.

**It sends exactly what the file says.**
- One `POST <host>/v1internal:generateContent`, non-streamed. Measured 2026-11-02 on
  `daily-cloudcode-pa`: 200 with a complete body (`gemini-3-flash`), and 404 `NOT_FOUND` for an
  unserved id. No SSE collection is needed.
- The CodeAssist envelope and headers are the ones `AntigravityCredentialProvider` builds for `ag@`:
  `{model, project, user_prompt_id, request}`, plus `enabled_credit_types: ["GOOGLE_ONE_AI"]` on a
  paid tier; `Authorization`, the agy `User-Agent`, `x-activity-request-id`.
- `request` is the file's own text spliced into the envelope, never parsed and re-serialized (a
  round trip turns `1.0` into `1`). The file is parsed once, only to check it is a JSON object.
- No retry, no model-id rewrite (the `ag@` path resolves the id against the dynamic models
  catalog; the probe does not call `fetchAvailableModels`), no thinking or effort translation.
- The request file is read BEFORE the keychain: a request that cannot be sent touches no
  credential.
- The file's text is spliced untrimmed: JSON allows whitespace around a value, so the caller's
  bytes, trailing newline included, reach the wire as written.
- `redirect: "manual"`. A 3xx is the answer, printed with its body. `fetch` follows a 307/308 by
  default and repeats the POST, which would be a second generation and would report the second
  status.
- `index.ts` routes an argv with `isSubscriptionProbeArgv` from `subscription-dispatch.ts`, the
  probe parser's own token walk, so flags may precede `probe`. That module imports only the
  version, so the routing decision never depends on the probe module loading. If the probe module
  will not load, a probe argv still gets one line: `probeLoadFailureLine()`, the probe schema's
  `internal_error`, exit 1. A models argv never loads the probe module.

### Schema `claudish.subscription-probe.v1`

One JSON object on ONE stdout line on every exit, through the awaited write. Keys in this order:

```
schema, provider? ("antigravity"), claudishVersion, model?,
fetchedAt?, sourceUrl?, clientVersion?, clientVersionSource?,
tokenRefreshed, httpStatus?, failure?, bodyRedacted?, body?
```

The field-presence rule and the meaning of the shared fields are the model-list schema's.
Differences:

| Field | Present when |
|---|---|
| `model` | the argv parsed: the `--model` value, sent unchanged |
| `clientVersion`, `clientVersionSource` | a valid token was obtained, as in the model-list schema (so also on a `load_code_assist_*` failure). Once `generateContent` was attempted, the version that request presented |
| `sourceUrl` | `generateContent` was attempted: `<host>/v1internal:generateContent`, userinfo stripped |
| `fetchedAt`, `httpStatus` | `generateContent` answered |
| `body` | it answered, 2xx OR NOT, within the cap. The response text as read, apart from redaction. A non-2xx answer is exit 0 with its body: the vendor's error is evidence |
| `bodyRedacted` | with `body`: `true` when a credential value inside it was replaced by `[REDACTED]` |

### Failures and exit codes

The classes and exit codes of the model-list command, with these codes of its own:

| Class | `code` | Exit |
|---|---|---|
| `network` | `generate_content_network_error` (fetch threw, or the body could not be read), `generate_content_timeout` (300 s abort, fetch and body read) | 6 |
| `list_incomplete` | `body_too_large` (over 512 KiB, any status, no body), `body_not_json` (a 2xx body that does not parse), `body_unverifiable` (any status: the secret guard could not decode it to a fixed point within its budget, no body) | 7 |
| `internal` | `usage`, `request_file_unreadable`, `request_file_invalid` (not one JSON object, or over 8 MiB) | 2 |
| `internal` | `secret_guard`, `internal_error` | 1 |

The 300 s bound is not the 30 s `fetchAvailableModels` bound: a thinking model's answer can take
minutes, and a 30 s abort turns slow evidence into a `network` failure.

### Redaction, then the guard

A vendor error body can quote the project id (a 403 naming the resource). Refusing the whole line
would destroy the evidence the probe exists to collect, so the body is redacted by exact value,
longest value first, also in the `\/` spelling (a Google refresh token holds `1//`). The
refuse-on-hit guard of the model-list command still runs over the final line and the body text as
the backstop.

Text redaction cannot see every spelling: JSON writes one string many ways (`CANARY…` is
`CANARY…` to any parser). The guard therefore also checks every form `jsonUnescapedForms(body)`
returns: each round decodes every JSON escape sequence ANYWHERE in the text, and the rounds repeat
until nothing changes. A hit in any form refuses (`secret_guard`, exit 1, no body) rather than
printing a body a parser chain would decode into a credential.

`MAX_UNESCAPE_ROUNDS` (64) is a BUDGET, not a cap. A body that has not reached a fixed point within
it is withheld: `list_incomplete`/`body_unverifiable`, exit 7, with `httpStatus`. Review round 4
broke the first version, a 16-round cap, with a valid 1,503-byte body nested 17 deep: a cap passes
what it did not decode, a budget fails closed. Decoding with no limit is not the answer either:
`\` followed by repeated `u005c` decodes ONE escape per round, so a 512 KiB body would take
about 100,000 rounds. Real bodies need 1 to 3 rounds; the worst case at the cap stops after 64
rounds in about 10 ms (test `G12`). Scope: a credential in
literal form or under any depth of JSON string escaping. Other transforms (base64, reversal) are
outside what any text guard can see.

It ignores string boundaries on purpose. Three review rounds broke every guard that first located
string literals:

| Body | Broke | Test |
|---|---|---|
| `{"m":"<escaped token>","m":"safe"}` | one `JSON.parse` of the whole body: it keeps only the last duplicate member | `G7` |
| `{"m":"{\"t\":\"<doubly escaped token>\"}"}` | decoding each literal once: JSON nested in a JSON string needs two decodes | `G8` |
| `" {"m":"<escaped token>"}` (a non-JSON 401 body) | a literal regex: the stray quote pairs the wrong quotes | `G9` |

One round is one level of escaping, so nesting depth N needs N rounds. Over-decoding text that was
never inside a string is harmless: the forms are only checked, never printed.

The reduced `secret_guard` line (below) is printed without a second check. It is built only from
constants in the published source, so a credential that happens to match part of it (a project id
spelled `internal` would match `"class":"internal"`) reveals nothing, and suppressing it would
break one line on every exit.

`--model` is caller input and can equal a credential (a caller passing its own project id). The
`secret_guard` line would then carry it too; instead of printing nothing, that line drops every
fact except `schema`, `claudishVersion`, `tokenRefreshed` and `failure`. One line on every exit
holds.
