# Model routing

> How a model name becomes a routing chain: which names reach `route()`, catalog-gathered candidates, defaultProvider, wire ids and route bindings, the derived picker provider list, subscription pricing.
>
> Extracted from `CLAUDE.md` (v7.64.0). Indexed in [`README.md`](./README.md).

## New Syntax: `provider@model[:concurrency]`

```bash
# Explicit provider routing: that provider, no routing chain
claudish --model google@<model> "task"
claudish --model openrouter@<vendor>/<model> "task"

# Bare name: route() calculates the chain from your rules and the cloud models catalog
claudish --model <model> "task"
claudish --probe <model>                   # shows that chain, kept and dropped hops

# Local models with concurrency
claudish --model ollama@<model>:3 "task"   # 3 concurrent requests
```

`claudish --help` lists every provider shortcut, generated from `BUILTIN_PROVIDERS`
(`providerShortcutRows`, `cli.ts`).

## Provider Shortcuts
- `g@`, `google@` → Google Gemini (direct API, `GEMINI_API_KEY`)
- `ag@`, `antigravity@` → Antigravity (Gemini via your Antigravity subscription — see `ai-docs/architecture/providers/antigravity.md`)
- `oai@` → OpenAI Direct
- `cx@`, `codex@` → OpenAI Codex (Responses API)
- `or@`, `openrouter@` → OpenRouter
- `mm@`, `mmax@` → MiniMax
- `mmc@` → MiniMax Coding Plan
- `kimi@`, `moon@` → Kimi
- `glm@`, `zhipu@` → GLM
- `gc@` → GLM Coding Plan
- `sakana@`, `fugu@` → Sakana Fugu
- `sc@` → Sakana Fugu Subscription
- `qcode@` → Alibaba Coding Plan (`QWEN_CODING_PLAN_API_KEY`)
- `qtoken@` → Alibaba Token Plan (`QWEN_TOKEN_PLAN_API_KEY`)
- `qpay@` → Alibaba PAYG (`DASHSCOPE_API_KEY`)
- `dv@`, `devin@` → Devin (Cognition/Codeium subscription — see `ai-docs/architecture/providers/devin.md`)
- `gk@` → Grok Build subscription (SuperGrok / X Premium+ — see `ai-docs/architecture/providers/grok-subscription.md`). `grok@` stays with the METERED `x-ai` provider
- `x-ai@`, `xai@`, `grok@` → xAI direct API, metered (`XAI_API_KEY`)
- `muse@` → Muse Code subscription (`meta-muse-code`: `claudish login muse`, or the Muse CLI's Keychain login; see `ai-docs/architecture/providers/meta-muse-code.md`). No route binding yet, so only an explicit `muse@<wire id>` reaches it
- `meta@` → Meta Model API, metered (`meta`, `META_API_KEY`, route `meta/direct-api`). Until `ca4be53b` `meta` was an `ollamacloud` shortcut; it moved with no alias, so an old `meta@llama-…` spec now goes to Meta
- `llama@`, `oc@` → OllamaCloud
- `litellm@`, `ll@` → LiteLLM (requires LITELLM_BASE_URL)
- `ollama@` → Ollama (local)
- `lmstudio@` → LM Studio (local)
- Custom endpoint names also work as provider prefixes (e.g., `my-vllm@model-name`) — see `ai-docs/architecture/custom-endpoints.md`
- **Bundled catalog vendors** each use their own name as their only prefix, and appear only when their key is locally present: `groq@`, `cerebras@`, `together@`, `fireworks@`, `deepinfra@`, `nebius@`, `hyperbolic@`, `sambanova@`, `novita@`, `baseten@`, `perplexity@`, `venice@`, `chutes@`, `featherless@`, `parasail@`, `inference-net@`, `aimlapi@`, `requesty@`, `nanogpt@`, `cohere@`, `scaleway@`, `upstage@`, `writer@`, `moonshot-cn@`, `tuningengines@` — see `ai-docs/architecture/predefined-endpoints.md`. `moonshot-cn@` is the China-region Moonshot product, a DIFFERENT service from the builtin Kimi provider reached by `moonshot@`

## Local models

Claudish supports local models via:
- **Ollama**: `claudish --model ollama@llama3.2` (or `ollama@llama3.2:3` for concurrency)
- **LM Studio**: `claudish --model lmstudio@model-name`
- **Custom URLs**: `claudish --model http://localhost:11434/model`

Local APIs report `prompt_tokens` as the FULL conversation context on every request, not an
increment — see `ai-docs/architecture/context-window.md`.

## Which names reach `route()`

**One gate: `proxyRouteDecision`** (`providers/native-route.ts`). The proxy's step 2c asks it
before routing anything, and `nativeRouteFor` (MCP preflight, the advisor), prehydrate's pin
(`pinSpecFor`), `--probe` and the config TUI ask the same function, so none of them can disagree
with the proxy about which names are routed. Checked in the proxy's order:

1. `parseModelSpec(target).isExplicitProvider` — `provider@model`, a URL, a legacy prefix
   (`oc/<id>`) → `explicit`: that provider, no routing chain.
2. `poe:<id>` → `poe`: the proxy's Poe step serves it.
3. The parser says `native-anthropic`:
   - with a `/` (only `anthropic/<id>` matches) → `explicit` via `vendor-qualified-id`: the
     proxy skips `route()` and sends the id to OpenRouter verbatim;
   - otherwise → `native`: Claude Code's own auth serves it, and `route()` never sees it.
4. Everything else → `bare`, with a known `vendor/` stripped (`openai/<id>` routes as `<id>`).
   Only `bare` calls `route()`.

**The parse gate decides what is `native`.** A bare name that no `nativeModelPatterns` entry
claims parses `native-anthropic` only when Claude Code owns it (`isClaudeCodeModelName`,
`providers/claude-code-aliases.ts`: `opus`, `sonnet`, `haiku`, `internal`, `default`,
`opusplan`, `best`, each optionally with `[1m]`, and any `claude-*`) or when it is not a model
name at all (`""`, a leading `@`). Every other bare name parses `auto-route`
(`AUTO_ROUTE_PROVIDER`, `model-parser.ts`) and is routed. Until 2026-09-24 such names parsed
`native-anthropic`: 508 catalog ids on generation `g-20260923145315478-d7a326bd`, `o4-mini`
among them, went to the native passthrough, which serves none of them. A name the catalog lacks
now gets only the fallback hop, `--probe` says `catalog has no entry for "<name>"`, and
`defaultProvider: ""` turns that into a no-route.

**The display and the request share one step.** `explainRoute(target)`
(`providers/routing-rules.ts`) calls `proxyRouteDecision` first and answers a `native` target
itself; everything else goes to `explainRoutePlan`. `route()` runs the same `explainRoutePlan`,
prints the two billing notices, and returns the kept candidates (`toRoutePlan`). `--probe`, the
config TUI and the team grid render `explainRoute`, and `describeRouteExplanation` words its
origin in one line for all three.

## Where a bare name's chain comes from

**There is no built-in routing table.** `providers/default-routing-rules.ts` — 24 hand-written
globs (`"gpt-*": ["openai-codex", "openai", "openrouter"]`, `"*": ["openrouter"]`) — was
DELETED, together with `mergeRoutingRules`, `retainKnownCatalogRoutingRules` and
`validateDefaultRoutingRules`. `loadRoutingRules()` now returns the user's own global and
project rules and nothing else.

`explainBareName` (`providers/routing-rules.ts`, reached through `explainRoutePlan`) has six
steps, and only the first changed:

1. **A user rule matches?** Use that chain **verbatim** — never merged, reordered or appended
   to, including by the fallback hop. `[]` is a match: the user said "no route".
2. **Otherwise gather from the catalog** — `gatherRouteCandidates` (`route-candidates.ts`)
   reads every `aggregators[]` connection the cloud models catalog publishes for the model
   and orders them: band (both subscription tiers → `native` → `gateway`), then the
   model's own vendor, then tier (`subscription` before `dynamic-subscription`), then
   cheapest (unknown price last), then larger context window, then provider name. The
   shared band exists so a vendor's own dynamic subscription leads: before 2026-09-24
   tier came first and `grok-4.6`/`grok-4.7` went Zen Go → Grok Build → xAI; now Grok
   Build (xAI's own) leads. The strict route gate showed those two chains and nothing
   else move (generation `g-20260923145315478-d7a326bd`).
3. **Append the fallback hop** (below).
4. Credential filter (unchanged).
5. Availability filter — only a POSITIVE "not-served" removes anything, and it asks each
   provider in that provider's own spelling (see below).
6. Primary + fallbacks.

**What `--probe` shows is that explanation, not a chain of its own.** It used to rebuild one
(`buildModelChain`): no credential filter, no availability filter, and a native test without
`route()`'s `/` check, so it probed hops a request never used and called `anthropic/<id>`
native. Now `chain` is the `kept` candidates in `route()`'s order (`[]` still means no route,
and an explicit target is a one-item chain), `dropped[]` lists every other candidate with its
outcome, and only kept candidates are probed (`probeTargets`, `providers/probe-runner.ts`).
Three consequences to know before reading its output:

- **A native name is one link, never probed** (`notProbed: "native-auth"`,
  `NATIVE_NOT_PROBED`). The native handler forwards the inbound Claude Code header, which a
  probe from this process does not have; substituting `ANTHROPIC_API_KEY` tested a different
  credential from the one a session uses.
- **`--no-probe` still asks providers.** The availability filter is part of `route()`, so an
  account's dynamic models catalog is read for each credentialed candidate that declares
  discovery (in memory, five minutes). `--no-probe` skips the model requests only.
- **The parser's provider is not a routing decision.** For a bare non-Claude name it is
  `auto-route`. It stays in `--probe --json` as `nativeProvider` and is never rendered: card
  headings and leaderboards name the first kept hop, or the explanation line when there is
  none.

**No catalog means local only.** With no readable catalog a bare name returns a no-route naming
`claudish --models-refresh`. It is never guessed at `openrouter@<name>`: that sends an id
nobody published to a metered gateway, and a RENAMED id looks identical.

**A dynamic subscription is invisible to the catalog, so it claims a namespace instead.**
`antigravity`, `grok-subscription`, `sakana-subscription` and `devin` sit in the probe map as
`client_model_selection_required` and publish zero connections — the ACCOUNT decides what the
seat serves. Each therefore declares a `nativeModelPatterns` claim (`/^gemini-/i`, `/^grok-/i`,
`/^fugu/i`, `/^swe-/i`) that `gatherFromNamespaceClaims` turns into a candidate. The claim is
not evidence of service; the availability filter asks the account's own dynamic models catalog.
Each claim's namespace is ALSO owned by a metered sibling defined EARLIER in
`BUILTIN_PROVIDERS` (`google`, `x-ai`, `sakana`), which keeps `parseModelSpec`'s first-wins
auto-detection unchanged — two claimants on one namespace is now fine, because the function
that picked a single winner (`getProviderForModel`) no longer exists.

**The availability filter must ask in the provider's OWN spelling.** A provider that encodes
knobs into its model ids never lists a bare canonical id: Devin's dynamic models catalog holds
`swe-1-7`, `swe-1-7-medium` and `swe-1-7-lightning`, never `swe-1.7`. Its transport maps the
requested name onto one of those through `expandSelection` (`providers/model-resolvers/`) when
it sends. `providerServesModel` therefore resolves through the same resolver BEFORE comparing,
so the filter and the transport answer the same question. Until 2026-09-23 it compared the raw
string, answered "not-served" for every canonical id Devin carries, and "not-served" is the one
verdict allowed to remove a candidate: a bare `swe-1.7` lost its Devin hop and went to the
OpenRouter fallback ("swe-1.7 is not a valid model ID"), and the explicit `devin@swe-1.7` was
refused outright, since the explicit path (`explainExplicitSpec`) runs the same check. A provider with no registered
resolver gets its id back unchanged, so this costs every other provider nothing. A new
knob-encoding provider needs a resolver entry, or the filter will deny it by spelling.

## Changing anything that decides a chain: the route-table gate

A passing suite does not show a routing change is safe. It asserts the routes someone thought to
write down, and a silent removal hides in the ones nobody did.
`scripts/route-table-snapshot.ts capture|diff` pins the resolved chain of EVERY catalog model
through the real `route()`, before and after, and classifies each difference. Capture before the
change; after is too late. Both snapshots must be on the same catalog generation.

The gate has two measured blind spots, and a clean diff means "nothing changed for the models
this machine can see", never "nothing changed":

- **Credentials.** It runs on this machine's keys. Filtering virtual providers out of the gatherer
  removed `native-anthropic` from every `claude-*` chain, and the diff reported nothing, because
  this machine sets no `ANTHROPIC_API_KEY` and the hop was already being dropped. Two routing tests
  that set the key caught it.
- **Scope.** It walks catalog models only. The Devin spelling fix above changed routing for names
  a dynamic subscription serves and the catalog does not publish, and the catalog held no `swe-*`
  model at all, so the diff showed no change. The reproduction was the evidence.

Run the suite as the complement: the gate covers breadth the suite cannot, and the suite covers
credential states and non-catalog names the gate cannot.

## Default Provider Configuration (v7.0.0+)

`defaultProvider` names the **fallback hop** — the last position in a gathered chain. It is a
POSITION, not a property of any provider: whichever provider it names occupies it, and no
definition declares `tier: "fallback"`. It is not a "front of the line" override; everything the
catalog maps is tried first.

Set it via:

- **Config file**: `"defaultProvider": "openrouter"` in `~/.claudish/config.json`, or in the file
  `--config` names
- **Env var**: `CLAUDISH_DEFAULT_PROVIDER=openrouter`
- **CLI flag**: `claudish --default-provider openrouter "task"`

**Precedence** (highest to lowest), decided by one resolver, `resolveDefaultProvider`
(`default-provider.ts`):
1. CLI flag `--default-provider`
2. `CLAUDISH_DEFAULT_PROVIDER` env var
3. `defaultProvider` in the config file
4. `OPENROUTER_API_KEY` present → `"openrouter"`
5. Hardcoded `"openrouter"`

Steps 4 and 5 route identically. They differ only in the `source` the route-table gate records.

**An empty value is an answer, not a gap.** `""` at step 1, 2 or 3 disables the fallback hop and
stops the search there, so `CLAUDISH_DEFAULT_PROVIDER=` beats a config `x`, and a flag `x` beats
an empty env var. Until 2026-09-24 the resolver skipped `""` and answered `openrouter`, so the
documented off switch did not work from the env var at all.

**Not read: a project `.claudish.json`.** `loadLocalConfig` keeps a `defaultProvider` key in the
project file, but no routing path reads it: only the global config (or the `--config` file) is
step 3. Supporting a project value would need a project source in the resolver, a scope in the
config TUI's Routing header and its own interaction with `--config`, which nothing asks for yet.

**How the flag travels.** `index.ts` strips `--default-provider` from argv and exports its value
as `CLAUDISH_DEFAULT_PROVIDER` before `parseArgs` and before any subcommand runs
(`planDefaultProviderFlag`). After that the env var is the flag's only carrier: `route()`, the
proxy, `--probe` and every child claudish (team, MCP sessions) read it there. It cannot be read
any later, for two reasons: `--probe` runs and exits inside `parseArgs`'s argv loop, and a child
process inherits env, not argv. `--default-provider ""` exports an empty value, which disables
the hop. The export runs after `--op-env` and `--op`, which overwrite env unconditionally, so the
flag still beats a value they hydrate. Children see it only because every claudish child is
spawned through `node:child_process`, which inherits `process.env`: `Bun.spawn` without an `env`
option drops in-process env writes.

**Who reads it.** `route(model)` with no overrides asks the resolver on every call
(`effectiveDefaultProvider`), and so does `--probe`'s chain, so the two cannot name different
fallback hops. The proxy resolves it once at start and passes it as `route()`'s third argument. It
has to: the proxy also passes its routing rules, and `route(model, rules)` with no third argument
reads NO default provider, a guard that keeps the machine's setting out of unit tests. Until
2026-09-24 the proxy passed only the rules, so its bare-name routing fell back to `openrouter`
whatever `defaultProvider` said, `""` included.

**Example config**:
```json
{
  "defaultProvider": "openrouter",
  "customEndpoints": { ... }
}
```

Valid values: any claudish provider name or shortcut (`"openrouter"`, `"or"`, `"openai"`,
`"litellm"`, etc.), a custom endpoint name defined in `customEndpoints`, or `""` for none.

**How it interacts with routing rules**: it applies ONLY to the catalog-gathered path. A bare
name that matched a user rule gets that chain verbatim with no fallback appended — which is what
makes `routing["*"] = []` a complete no-route switch. On the gathered path the hop is appended
last, deduped against shortcuts (`or` and `openrouter` are the same provider), and then the
whole chain is credential-filtered. Explicit `provider@model` specs are unaffected.

**Three ways it is EMPTY, and they are different:**

| Setting | Fallback hop |
|---|---|
| unset (`undefined`) | `openrouter` — "no preference" is not "disabled" |
| `""` (explicit empty string), from the flag, the env var or the config file | none |
| a matching user rule, e.g. `routing["*"] = []` | none — the rule is verbatim |

**It is not appended when the catalog positively denies it.** The catalog draws the line itself:
a route the probe map marks `client_model_selection_required` is ACCOUNT-selected, so absence
from a model's connections proves nothing; every other probed route is BACKEND-owned and
publishes its complete connection list, so for those absence IS denial. When the fallback
provider is backend-owned and the model has a catalog entry with no mapped connection to it, the
append is skipped (`catalogDeniesProvider`). Measured on generation
`g-20260921062451697-f490edba`: only 492 of 1,123 models have an OpenRouter connection, so the
deleted `"*": ["openrouter"]` catch-all was sending 417 chat models to a hop the catalog never
mapped — `qwen3.8-max` among them, which has four mapped connections and no OpenRouter.

This is NOT the availability filter and does not duplicate it. `providerServesModel` may never
conclude "not served" from the catalog alone (catalog coverage of SUBSCRIPTION providers is
partial by nature — `openai-codex` appears on 5 rows of 1,123). The route-ownership split is
what makes the narrower question answerable, and only the fallback APPEND asks it: the
difference is inventing a hop nobody published versus dropping one something else put there.

**No more LiteLLM auto-promotion** (removed in commit 5 of the model-catalog and routing redesign): Setting `LITELLM_BASE_URL` + `LITELLM_API_KEY` no longer makes LiteLLM the default. Users who want LiteLLM as the catch-all must set `defaultProvider: "litellm"` explicitly. The one-shot stderr hint that announced the promotion, and the `DefaultProviderSchema` that listed LiteLLM as a built-in name, are gone as well.

## Wire ids come from the catalog's connections

A provider is sent its own wire id, never the name the user typed: the canonical model id
`kimi-k3` is `k3` on Kimi Coding and `moonshotai/kimi-k3` on OpenRouter. There is no
per-provider resolver, no `ModelCatalogResolver` and no static vendor map. One lookup reads the
cloud models catalog record's `aggregators[]` connections, each
`{ route: { routeId, routeProfileId }, routeStatus, externalModelId }`, of which only
`routeStatus: "mapped"` counts:

- `resolveExternalId(name, provider)` (`providers/catalog-client.ts`) finds the record by
  canonical model id, then alias, then any wire id the record publishes, then a `/<name>` suffix
  (exact case, then any case).
- `externalIdFor(record, provider)` returns the `externalModelId` of the connection whose route
  is bound to that provider (`catalogRouteMatchesProvider`, route bindings below). With both an
  exact id and a moving pointer on offer, it sends the exact id; a pointer only when the model's
  own id is one.
- No match passes the name through unchanged, so a local model or a custom endpoint's private id
  is sent as typed. A `vendor/<model>` name is its own answer.

It runs in two places:

- **Each routing-chain candidate.** `resolveRoutingEntries` (`routing-rules.ts`) takes a
  subscription plan's wire id first (`resolveSubscriptionRouting`), else this lookup, per
  provider. One chain can therefore send two spellings of one model to two providers.
- **An explicit `provider@model`** (proxy step 2b, `resolveTargetForCatalog`): the spec is
  rewritten to that provider's wire id and `[Model] Resolved …` is printed. Never a bare name:
  rewriting one would manufacture an explicit spec, and step 2c would then skip routing.

The catalog itself is extracted, published and documented in the
[models-index](https://github.com/MadAppGang/models-index) repo; claudish only reads it.

## Contributor wire ids are never chosen implicitly (2026-10-16)

Some vendors publish a second wire id for one model whose use opts the request's CONTENT into
the vendor's product improvement: `muse-spark-1.3-contributor` beside `muse-spark-1.3` on
`meta/direct-api`, and `…-contributor-free` beside the plain id on OpenCode Zen. The catalog maps
both as ordinary connections. On generation `g-20261015133900604-fb6199b5` OpenCode Go mapped
ONLY the contributor id for `muse-spark-1.3`, so a bare `muse-spark-1.3` went to Go first, opted
in, with nothing on screen to say so.

Jack's decision: a contributor id is never chosen for the user, on any route. One typed exactly
(`meta@muse-spark-1.3-contributor`) is sent verbatim.

`isOptInWireId` (`providers/content-use.ts`) matches `-contributor` and `-contributor-free` on the
last path segment. It is enforced where catalog data enters memory, not at each reader, so a
reader added later inherits it:

| Entry point | What it does |
|---|---|
| `readAllModelsCache`, the refreshed `_memCache`, `_setCatalogEntriesForTest` | `splitOptInConnections`: matching rows move from `aggregators[]` to `optInConnections[]` |
| `fetchCatalogPage` (Firebase `ModelDoc`s) | `normaliseCatalogPayload`, the same split |
| `getProbeModel`, `rankProbeCandidates`, `expandSelection` | skip an opt-in id |
| `discoverProviderModelsCatalog` | offered rows exclude opt-in ids; `discoverProviderServedIds` returns both lists for entitlement |

The rows are moved, never deleted. Only EXACT-id readers consult `allConnections()`:
`resolveExternalId`'s first step (`publishesWireIdFor`), `findConnection`'s exact step, the
availability reverse lookup, `allExternalIds`, and `wiresMatchRegistry`, which still validates
every row. A reader that CHOOSES a wire id reads `aggregators[]` and cannot see an opt-in one.

A provider whose only connection for a model is a contributor one is not gathered. `--probe`
shows it as `excluded-by-content-use`. A provider that maps both ids keeps its plain candidate
and shows no drop. Measured on the pinned generation `g-20261016053727894-8a743761` (1189
models): three chains changed, and each lost only `zengo@<id>-contributor` (`gemini-4-argon`,
`muse-spark-1.3`, `muse-spark-1.2`).

**Removal trigger:** models-index publishes a content-use field on every route (backend task M3,
`ai-docs/reports/BACKEND_TASKS_meta_muse_code_route-20261016.md`). Until then this is the one
wire-id name rule claudish keeps.

## Route bindings: which claudish provider a catalog route means

A connection names a route binding `(routeId, routeProfileId)`, never a claudish provider.
`providers/catalog-route-bindings.ts` maps the two in two tables, split by job:

- **`CATALOG_ROUTE_BINDINGS`, the routing table.** Every key is a claudish provider, built-in or
  a bundled endpoint (`together`, `fireworks`), that owns one endpoint and one credential silo.
  The candidate gatherer reads it through `routingProvidersForRoute`, which returns EVERY name
  bound to a route: `z-ai` and `glm` share `z-ai/direct-api` because their keys sit in two
  silos, and the credential filter decides which one serves.
- **`LOOKUP_ONLY_ROUTE_BINDINGS`: `anthropic`, `moonshotai`, `zen`.** Names that catalog READS
  ask about (the savings panel's first-party price, the Kimi picker list, a legacy picker value)
  and that no claudish provider answers to. They are never route candidates. In the routing
  table they were candidates by accident of spelling: a custom endpoint named `anthropic` would
  have been gathered for every model Anthropic's native API serves.

Reads see both tables (`catalogRouteForProvider`; `catalogReadProvidersForRoute` lists routing
names first), so each read answers as it did before the split. A name that owns no endpoint and
no credential silo gets no routing binding, whatever its spelling (CLAUDE.md's invariant).

## Runtime subscription routes come from the backend contract

Claudish refreshes the v3 slim model catalog and `queryPlans` together, pins
each page to one generation, and stores the complete snapshot in
`~/.claudish/all-models.json`. A model's `subscriptionPlanIds[]` contains
commercial plan IDs such as `kimi-code`. The client joins those IDs with a
plan's exact `route.routeId` and `route.routeProfileId`, then sends the matched
model connection's `externalModelId` to that transport.

Plan absence has two different meanings:

- `modelDiscovery: "catalog"`: the published membership is authoritative, so an absent model is
  dropped from that subscription provider's candidate chain.
- `modelDiscovery: "client"` or `"hybrid"`: the authenticated account may reveal models the
  public backend cannot know, so absence remains unknown and the candidate is retained. Devin,
  Antigravity, and the `xai-supergrok` plan use this account-scoped behavior.

Membership gates GATHERED candidates too (`66d10dae`). Before, `gatherFromConnections` kept any
mapped connection of a `subscription`-tier provider, so a plan whose membership did not include
the model still became a hop. Now `resolveSubscriptionRouting(...) === "not-served"` sends the
candidate to `excluded-by-membership`. On the pinned generation `g-20261016053727894-8a743761`,
seven chains lost only their subscription hop (`zengo@` for `qwen3.7-max`, `glm-5.1`,
`qwen3.6-plus`, `minimax-m2.5`, `omen-alpha`; `qtoken@` for `deepseek-v3.2`,
`deepseek-v4-flash`).

**A subscription's terminal credential failure stops the chain.** An expired or revoked login on
any `SUBSCRIPTION_PROVIDERS` member (and `openai-codex` when its OAuth arm signed) answers 400
with its login hint and never walks onto the next, usually metered, hop. A model the plan does not
carry and a spent allowance still advance. The mechanism is in `adapters.md` ("A subscription's
credential failure stops the chain").

The backend recommendation projection supplies canonical model IDs and exact
route/profile identities. Claudish resolves them against the generation-pinned
catalog for model wire IDs. A user routing rule decides preference when one
matches; otherwise the catalog's own connections do, ordered by tier. Catalog
availability removes only known-unserved candidates. A failed model or plan
refresh does not replace a complete cached snapshot.

## Two model catalogs, and which one may deny

Name them apart, because they are different KINDS of fact:

| | **cloud models catalog** | **dynamic models catalog** |
|---|---|---|
| what it is | the hosted models-index metadata, keyed by canonical model id | the list one provider's discovery endpoint returns for ONE credential |
| scope | the same for everybody | per account, per key, per seat |
| lifetime | cached on disk in `~/.claudish/all-models.json` | in memory only, per process |
| owns | model IDENTITY and published plan membership | ENTITLEMENT — which models this key may call |

**A dynamic models catalog is never persisted.** `providers/model-discovery.ts` keeps the
list in an in-memory `Map` for `CACHE_TTL_MS` (five minutes) and writes nothing to disk;
Antigravity's dynamic models catalog is likewise in memory (`auth/antigravity-user.ts`). Every disk
writer holds hosted or credential-free data. A stored per-account list would outlive the
key or seat that earned it and answer with something no longer true.

For a bare name, `route()` asks three questions of each routing-chain candidate, in this
order, and each may remove it (an explicit `provider@model` skips the first):

1. **Catalog membership** (`buildRoutingChain` → `resolveSubscriptionRouting`,
   `adapters/model-catalog.ts`). Only for a plan whose route is `supported` and whose
   `modelDiscovery` is `"catalog"`: a model outside its published membership is dropped
   **before** any credential is read or any discovery request is made. A plan whose
   `modelDiscovery` is `"client"` or `"hybrid"` answers `unknown` here and keeps the
   candidate.
2. **Credential** (`hasCredentialsForProvider`). No key, no candidate.
3. **Availability** (`providerServesModel`, `providers/model-availability.ts`). For a
   provider that declares `modelDiscovery`, a non-empty dynamic models catalog decides:
   listed is `serves`, unlisted is `not-served`. The cloud models catalog may only
   confirm, never deny.

**Only a successful, complete account answer may deny, and a failed refresh denies
nothing.** Every failure path of `discoverProviderModels` (no credential, 401/403, other
HTTP errors, unreachable host, malformed JSON, no base URL) returns `[]` with a reason
recorded for `getDiscoveryFailure`, and `providerServesModel` reads `[]` as `unknown`, so
the candidate keeps its place. A refresh that could not run cannot erase access. The same
holds for a 200 whose list fails the completeness checks: rows the parser had to drop, or
a continuation field (`has_more: true`, `next`, `next_page`, `next_page_token`), record an
`incomplete` failure, return `[]` and are not cached. Completeness is DETECTED, not
proven: the vendor endpoints publish no total, so a well-formed subset still reads as a
complete list.

**What step 3 cannot tell apart.** It treats any non-empty list as the account's answer.
`qwen-coding`'s `/v1/models` answers in full with no credential at all
([`providers/qwen-alibaba.md`](providers/qwen-alibaba.md)), so for that provider the list
records what the plan covers, not what the key may call, and it can still deny.

## The interactive picker's provider list is DERIVED — never hand-write one

Bare `claudish` shows "Select provider:" from `model-selector.ts`. That list used to be a
hand-written `ALL_PROVIDER_CHOICES` array, so **membership was opt-in and a new provider
defaulted to invisible**. `devin` and `antigravity` were both fully working — routing,
`--probe`, and the config TUI (which has always derived its list from `getAllProviders()`) —
while absent from the picker. `3a293b9` even built Antigravity's correct 20-model dynamic
models catalog for a provider the picker could not offer.

The v7389502 credential refactor is the trap here: it unified availability **checking** (it
deleted the three duplicate readiness oracles) and left the **list itself** alone. Unifying how a
list is filtered is not the same as unifying what is in it.

- `isPickableProvider(def)` = `def.shortcuts.length > 0`. A definition with no shortcuts has
  no user-typeable `@` prefix and exists only so `nativeModelPatterns` can steer a BARE name;
  `qwen` and `native-anthropic` are the two, and both carry an empty `baseUrl`/`apiPath`.
  A rule, not a table — there is no exclusion list to keep current.
- `PICKER_COPY` and `PICKER_ORDER` are **editorial only**: labels and ordering. Anything
  unlisted still appears, at the end. Never use either as a membership gate.
- The `@prefix` filter aliases (`getProviderFilterAliases`) are derived the same way, from
  each definition's name + `shortcuts`, because that table had drifted identically — `@dv`
  matched nothing. Alias insertion order follows `PICKER_ORDER` so an ambiguous partial like
  `@op` resolves to the first row the user actually sees (OpenRouter).
- The emitted prefix comes from `shortestPrefix`; `PROVIDER_MODEL_PREFIX_OVERRIDE` holds only
  four readability aliases. The danger the old map created was returning **undefined**, which
  makes `buildExplicitModelSpec` hand back a BARE id — for Devin that is
  `claude-opus-5-medium`, which matches native-anthropic's `/^claude-/i` and is answered by a
  different provider entirely. (`parseModelSpec` passes an unrecognized prefix through
  verbatim — `model-parser.ts:160` — so a canonical NAME also resolves; assert the parser
  round-trip, not membership in `shortcuts`.)

The drift test is `buildProviderChoices()` ⊇ every pickable builtin. It asserts CONTAINMENT,
not equality: runtime custom endpoints legitimately appear too (a real gain — the old array
could never show one), so equality made the test order-dependent on whichever sibling test
file had registered one.

**`config-command.ts` was deleted in v7.64.0 — 809 lines of dead code holding a fourth
hand-written provider table.** `configCommand` was exported and imported nowhere;
`claudish config` has gone to `startConfigTui()` for a long time. The table listed `baseUrl`,
`endpointEnvVar` and `keyUrl` per provider, i.e. exactly the data the catalog owns.

What makes it worth recording rather than just deleting: it was **actively maintained while
dead**. The light-theme sweep (`c9cb626`) restyled it and a MiniMax endpoint fix (`b7173d2`)
corrected its hostname — two people paid to keep a table current that no code could read. A
dead hand-written table is worse than a live one, because nothing can ever prove it wrong.
Check for importers before restyling a file.

## Subscription pricing is decided by BILLING, not by `modelDiscovery`

`SUBSCRIPTION_PROVIDERS` (`handlers/shared/remote-provider-types.ts`) drives both the picker's
`SUB` label and `getModelPricing`'s zero-cost verdict, so a missing entry quotes a flat-rate
user a per-token rate they do not pay — and TokenTracker then accrues fictional spend.

Two paths render a price and only one used to ask the question: a provider WITH
`modelDiscovery` goes through `buildDiscoveredModelRows` (which asks), everything else goes
through `resolveProviderDisplayPrice` (which did not). That is why a missing entry was
invisible on one path and merely wrong on the other. `resolveProviderDisplayPrice` now checks
`isSubscriptionProvider` FIRST, ahead of both the aggregator and model-level rates.

Found by that audit and added: `antigravity` (was N/A) and `sakana-subscription`, alongside
the already-listed `minimax-coding` / `glm-coding`, which were quoting their metered
siblings' dollar rates. When adding a provider, ask "does the user pay per token?", not
"does it declare discovery?".

**`openai-codex` is decided by the CREDENTIAL, not by the name**, and that is the tier the
whole `SUBSCRIPTION_PROVIDERS` design could not express. It was once added to the name set —
its picker row literally says "ChatGPT Plus/Pro subscription" — and a multi-model review
reverted it, on this reasoning: `apiKeyAliases: ["OPENAI_API_KEY"]` means a plain metered key
authenticates `cx@` just as well. **That premise is false at sign time, and a checked-in test
says so.** `authority.ts:157` registers the Codex composite BEFORE the generic provider loop
and `:192-205` blocks the generic `ApiKeyCredentialProvider` from claiming the name, so the
provider that would have been built with `aliases: def.apiKeyAliases` is never built for
`openai-codex`; the composite's own fallback declares no aliases at all
(`codex-credential.ts:79-82`). `auth/credentials/equivalence.test.ts:302-305` —
*"OPENAI_API_KEY alias alone → false (excluded)"* — asserts it. The alias survives only in
display and hint code (`tui/providers.ts`, `keychain-command.ts`, `getApiKeyInfo`), which is
its own cosmetic bug: the config TUI shows `cx@` as key-configured from a key that cannot
sign it.

The real dual mode is **two hosts**, which is a code fact rather than an inference: OAuth
(`codex-oauth.json`) signs `chatgpt.com/backend-api/codex/responses`
(`codex-credential.ts:17`, `:54`), while `OPENAI_CODEX_API_KEY` signs
`api.openai.com/v1/responses` (`provider-definitions.ts:408`, `:410`), and
`transport/openai-codex.ts:11-15` documents that OAuth tokens do not work against
`api.openai.com` at all. Whether that second host bills per token was inferred until
**2026-09-02, when it was measured**: a platform key against exactly that host and path
returns `200` with `"billing": {"payer": "developer"}` in the response body — the endpoint
names the payer itself, and it is the key holder, not a ChatGPT plan
(`ai-docs/reports/data/measurements-20260902.txt`). One 200 does not prove every account type
answers the same way, so the probe's metered-by-default shape is unchanged; it is now backed
by a measurement instead of by the host name.

**The two errors are not symmetric**: quoting a dollar rate to a subscriber is a cosmetic
over-estimate, while reporting `SUB` (and zero accrued cost) to someone OpenAI is metering
silently under-reports real money. So the answer comes from a probe registered by the auth
layer (`auth/credentials/billing-probe.ts`, installed only as a side effect of importing
`auth/credentials/authority.ts`), and every uncertainty resolves toward **metered**:

- The transport records which arm actually signed (`transport/openai-codex.ts` calls
  `recordSignedArm` at the end of `refreshAuth`). That record is read FIRST, because
  `refreshAuth` catches every failure and falls through to the plain api-key path — so
  "OAuth present, api-key signing" is reachable per request whenever a token refresh fails.
- Before any request has been signed, the probe answers "which credential WOULD sign" with
  `CodexOAuth.getInstance().hasCredentials()` — the same predicate the composite uses to pick
  its primary (`composite-credential.ts:50` → `codex-credential.ts:45-47`). **Never**
  `hasOAuthCredentials` or `describeSourceSync`: both return true for an `access_token` with
  an unexpired `expires_at` and no `refresh_token` (`oauth-registry.ts:88-97`), a state where
  `hasCredentials()` is false and the API key signs.
- Unregistered probe ⇒ metered. Safe as money; the cost is one suppressed cost warning at
  `routing-rules.ts:413`.

`antigravity` (no `apiKeyEnvVar` at all) and `sakana-subscription` (which deliberately does
not alias the PAYG `SAKANA_API_KEY`) have no such ambiguity, which is why they sit in the
plain name set. Adding `openai-codex` to that set as well would short-circuit the probe and
report `SUB` to every API-key user — do not.
