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
- `muse@` → Muse Code subscription (`meta-muse-code`: `claudish login muse`, or the Muse CLI's Keychain login; see `ai-docs/architecture/providers/meta-muse-code.md`). Route binding `meta/muse-code-subscription` lets mapped subscription connections lead bare-name routing, subject to membership, credential and availability filters
- `meta@` → Meta Model API, metered (`meta`, `META_API_KEY`, route `meta/direct-api`). Until `ca4be53b` `meta` was an `ollamacloud` shortcut; it moved with no alias, so an old `meta@llama-…` spec now goes to Meta
- `llama@`, `oc@` → OllamaCloud
- `litellm@`, `ll@` → LiteLLM (requires LITELLM_BASE_URL)
- `ollama@` → Ollama (local)
- `lmstudio@` → LM Studio (local)
- Custom endpoint names also work as provider prefixes (e.g., `my-vllm@model-name`) — see `ai-docs/architecture/custom-endpoints.md`
- **An unknown shortcut is named as unknown** (`providers/unknown-shortcut.ts`). `parseModelSpec` passes an unknown shortcut through as the provider name, so `go@gemini-3.8-flash` (`go@` was removed in v7.36.0) used to reach the credential filter and answer `No credentials configured for "go"` (D9). `explainExplicitSpec` now asks `isKnownProviderName` FIRST, before any credential read (no authority lookup, readiness probe or 1Password attempt for a name that cannot exist), and answers no-route with cause `explicit-unknown-shortcut` and candidate outcome `unknown-provider`. Known means a builtin or runtime-registered provider, a bundled endpoint (even with no key, so `groq@` keeps its credential message), a `customEndpoints` key, or `custom-url`. The one wording, printed by routing, the proxy's step 6b, preflight and `--probe`: `Unknown provider shortcut "go" in "go@gemini-3.8-flash".` plus `Providers that serve gemini-3.8-flash: ag@… (Antigravity, subscription · account decides models) · g@… (Gemini, native API) · … Every shortcut: claudish --help.` The suggestions are the providers `gatherRouteCandidates` returns for the model (catalog connections and vendor claims, chain order, no credential filter, no cap; no account's dynamic models catalog is read), spelled with `getShortestPrefix`; a model that gathers nothing lists the shortcuts one edit from the typed one. No model list is written anywhere, and a removed shortcut gets no alias. Whoever adds a credential read to `explainExplicitSpec` keeps it BELOW this check
- **Bundled catalog vendors** each use their own name as their only prefix, and appear only when their key is locally present: `groq@`, `cerebras@`, `together@`, `fireworks@`, `deepinfra@`, `nebius@`, `hyperbolic@`, `sambanova@`, `novita@`, `baseten@`, `perplexity@`, `venice@`, `chutes@`, `featherless@`, `parasail@`, `inference-net@`, `aimlapi@`, `requesty@`, `nanogpt@`, `cohere@`, `scaleway@`, `upstage@`, `writer@`, `moonshot-cn@`, `tuningengines@` — see `ai-docs/architecture/predefined-endpoints.md`. `moonshot-cn@` is the China-region Moonshot product, a DIFFERENT service from the builtin Kimi provider reached by `moonshot@`

## Local models

Claudish supports local models via:
- **Ollama**: `claudish --model ollama@llama3.2` (or `ollama@llama3.2:3` for concurrency)
- **LM Studio**: `claudish --model lmstudio@model-name`
- **Custom URLs**: `claudish --model http://localhost:11434/model`

Local APIs report `prompt_tokens` as the FULL conversation context on every request, not an
increment — see `ai-docs/architecture/context-window.md`.

## MCP callers pass bare names: an unrequested `provider@` is removed (2026-10-23)

The agent that calls the MCP tools often writes a `provider@` the user never asked for: it
copies one from the `list_models` Access line, or guesses. That spec bypasses the user's
routing (configured providers, subscription first, preferences, manual overrides). Measured in
the `recommended-effort` bench run1: the agent sent `oai@gpt-6-luna` from the Access line,
was billed on the metered API and got `credit_balance_exhausted`, while `cx@` (the
subscription) would have served the bare name.

So `team` (`models`, `judges`), `create_session` and `run_prompt` remove the provider
(`stripUnrequestedProvider`, `mcp-server.ts`) unless the caller lists the spec in
`user_required_provider` (the user named the provider). Only a single `provider@model` whose
provider is a BUILT-IN claudish provider and whose model part is exactly a canonical model id of
the cloud models catalog is changed; markers (`+pro`, `#fast`) stay. Unchanged: chains, local
providers, `custom-url`, a user's custom endpoint (`corp-proxy@gpt-4o` names a vendor and a bill
the bare name would not reach), legacy syntax, a wire id
that is not a catalog model id (`kc@k3`), and two specs that would strip to one name
(`or@kimi-k3`, `kc@kimi-k3`: a provider comparison keeps both providers and both efforts). The
answer names every removal (`provider_note` / `note`) and the MCP log records it.
`compare_models` is not changed: it is a debug tool, where comparing providers can be the
point.

## MCP callers name a recommended model: other bare names answer `unknown_model` / `not_recommended` (2026-10-23)

Measured in the `recommended-effort` bench (run10, run11): an agent told "a GPT model and a
MiniMax model" sent `team` the names `gpt` and `minimax`. Neither is a model; `gpt` became the
fallback hop `or@gpt` and failed. Another agent guessed `gpt-5` from memory without calling
`list_models`: a catalog model that no subscription serves, so it ran on metered OpenAI and got
`credit_balance_exhausted`. A skill or a schema description did not change that (the agent never
reads them when it holds a name); a tool answer does, as `needs_effort` showed.

So `team` (`models`, `judges`), `create_session` and `run_prompt` start nothing for a bare name
that is not in the recommended list (`modelChoiceProblems`, `mcp-server.ts`):

| Name | Answer |
|---|---|
| in the cloud models catalog (id or alias) | `not_recommended`: re-evaluate against the recommended list |
| not in the catalog, and no stored dynamic models catalog carries it | `unknown_model`: pick the best recommended model |

The answer carries the recommended ids of the same family (the first run of letters, `gpt` for
`gpt-6.1-sol`) or vendor, newest first, plus the whole recommended list with tiers and release
dates. The calling agent knows the task and what the user asked, so IT picks; claudish never
substitutes a model. `user_required_model` (`team`: the entries; the others: `true`) runs a model
the user named exactly. Never checked: an explicit `provider@` (after the removal above), a chain,
a native Claude name, a name a user routing rule matches (the user's own routing), a name the
catalog lacks that an account's stored dynamic models catalog carries (`swe-1.7` on Devin: the
account decides; read from disk, no network; a catalog model such as `grok-4.20` is checked even
with a SuperGrok seat), a name the catalog resolves to a recommended id
(`MiniMax-M3`, the alias `k3`, the route variant `gemini-4-argon-high`), a catalog miss when the user's
`defaultProvider` is not `openrouter` (LiteLLM, a custom endpoint may serve it) or when `create_session`'s
`work_dir` holds project rules this server cannot read, and everything when no recommended list or no
catalog is on disk (the MCP log says so). The check runs before `needs_effort`.

The refusal carries the effort rows of the matching ids (run13: an agent retried with a level it made up). `search_models` lists the matching recommended models first and its `Use with:` line names only a recommended id (`recommendedSearchMatches`): run13's `gpt-5.5` came from its OpenRouter listing.

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

## A Claude model has two routes: Claude subscription and Claude API

**Claude subscription** is the user's own Claude Code login, served by the native passthrough
(`native-anthropic`, `NativeHandler`). **Claude API** is Anthropic's metered native API on the
user's Anthropic API key: the catalog's `anthropic/direct-api` route.

**Why `--probe claude-haiku-5-5` showed one row (v14.20.0).** The Summary had a single line,
`Anthropic (Native) ◐ native — not probed`, and no Claude API row, even with `ANTHROPIC_API_KEY`
set and seven mapped connections in the catalog for that model (`anthropic/direct-api`,
`anthropic/claude-code-subscription`, Devin, OpenCode Go, OpenCode Zen, OpenRouter, Poe). Three
independent causes, each enough on its own:

1. **No candidates were gathered.** `proxyRouteDecision` classifies a bare Claude name as
   `native` before `route()`, so `explainRoute` answers `{source: "native", candidates: []}`
   and never asks `gatherRouteCandidates` about the model.
2. **The probe has nothing to send.** `probeChainFrom` turns a native explanation into one link
   with `notProbed: "native-auth"`, and `probeTargets` has no candidate to turn into a request.
3. **No claudish provider could call `anthropic/direct-api`.** The name `anthropic` sat in
   `LOOKUP_ONLY_ROUTE_BINDINGS`, so it was never a route candidate. The only credential provider
   that read `ANTHROPIC_API_KEY` was `native-anthropic`'s (`NativeAnthropicCredentialProvider`),
   and that provider is `noHandler("virtual")` with `apiKeyEnvVar: ""`: it supplies the native
   passthrough's fallback key, it does not serve a route.

Fixing one cause alone changes nothing visible: a provider for `anthropic/direct-api` is still
never gathered for a native name, and gathering candidates for a native name still finds no
provider that can sign the Claude API.

**The Claude API provider is `anthropic`** (shortcuts `anthropic@`, `a@`, `api@`; tier
`native`; `x-api-key` on `ANTHROPIC_API_KEY`), bound to `anthropic/direct-api` in the routing
table. It is metered by name: in neither `SUBSCRIPTION_PROVIDERS` nor
`CREDENTIAL_DECIDED_PROVIDERS`. What it deliberately lacks: `nativeModelPatterns` (patterns are
tried in builtin order, and `/^claude-/` there would take every bare Claude name away from the
Claude subscription), `baseUrlEnvVars` (`ANTHROPIC_BASE_URL` is how claudish points a child
Claude Code at its own proxy, so a nested claudish would send the key to the parent's proxy),
and `apiKeyAliases` (`ANTHROPIC_AUTH_TOKEN` is the subscription's OAuth token). It reads a vault
key only at use (`vaultKeyReadAtUse`, [keychain.md](./keychain.md)), so a key it resolves never
reaches `process.env` and a later native child. A bare Claude name still never reaches
`route()`, so routing it is unchanged; `anthropic@<id>` names the route explicitly.

**The name `anthropic` means two things.** It is the catalog's route id for Anthropic's own
endpoints (`anthropic/direct-api`, `anthropic/claude-code-subscription`) and the vendor slug the
savings panel reads its first-party price under, and the Claude API provider's name. It is ALSO
the hook route provider `NativeHandler` reports (`route: {provider: "anthropic", native: true}`),
and `isNativeRoute` (`hooks/request-stage.ts`) answers true for `providerName === "anthropic"`
whatever the model, a rule `ComposedHandler.routeInfo` feeds too. So a proxied `anthropic@`
request reports `RouteInfo.native: true`, as the native passthrough does: the wire is
Anthropic's own and the model is Claude, which is what the plan-mode measurement behind `native`
covers. A hook scoped `routes: native` runs on both Claude routes; `routes: foreign` on neither. A rule that must tell the native
passthrough apart from a metered call reads `provider_name` and `adapter_name` in stats, never
the hook's provider name.

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
  credential from the one a session uses. Why no Claude API row appeared beside it: [A Claude
  model has two routes](#a-claude-model-has-two-routes-claude-subscription-and-claude-api).
- **`--no-probe` still asks providers.** The availability filter is part of `route()`, so an
  account's dynamic models catalog is read for each credentialed candidate that declares
  discovery (the account's stored list; only a list at most five minutes old may deny).
  `--no-probe` skips the model requests only.
- **The parser's provider is not a routing decision.** For a bare non-Claude name it is
  `auto-route`. It stays in `--probe --json` as `nativeProvider` and is never rendered: card
  headings and leaderboards name the first kept hop, or the explanation line when there is
  none.

**No catalog: see [the bundled recommended list](#no-catalog-the-bundled-recommended-list).** A
name with no catalog entry and no account-listed candidate returns a no-route naming
`claudish --models-refresh`. It is never guessed at `openrouter@<name>`: that sends an id nobody
published to a metered gateway, and a RENAMED id looks identical.

**A dynamic subscription is invisible to the catalog, so its candidates come from its vendor
and its account.** `antigravity`, `grok-subscription`, `sakana-subscription` and `devin` sit in
the probe map as `client_model_selection_required`. The catalog publishes few or no
connections for them, because the ACCOUNT decides what the seat serves. Two sources in
`route-candidates.ts` add their candidates after the catalog's connections, and neither matches
a model name against a pattern:

- **Vendor claim** (`gatherVendorClaims`). A dynamic subscription becomes a candidate for a
  catalog chat model whose vendor (the entry's `provider`) is the subscription's own route
  vendor, when the catalog publishes no connection of that subscription for the model. `gk@`
  claims `x-ai` models, `ag@` claims `google` models, `sc@` claims `sakana` models. Devin's
  vendor, `cognition`, has no catalog entries, so Devin gets no vendor claim. A claim is not
  evidence of service; the availability filter asks the account.
- **Account-listed candidate** (`gatherAccountListed`). The account's dynamic models catalog
  carries the name in the provider's own spelling (`swe-1.7` resolves to `swe-1-7-medium`
  through `expandSelection`), and the catalog publishes no connection of that provider for the
  model. That covers a name the catalog lacks (Devin's `swe-*`), a machine with no readable
  catalog, and a catalog model that only other providers connect (Devin re-serving `kimi-k3` as
  `kimi-k3-high`). The candidate carries the listed row's context window. Published plan
  membership still excludes: a subscription whose catalog membership lacks the model is set
  aside as `excluded-by-membership`. Any subscription provider that declares `modelDiscovery`
  keeps a list (`isPersistedListProvider`), not only the four above.

A catalog connection wins over both for the same provider and wire id, because it carries the
price and window the other two cannot know. The old regex claims (`/^gemini-/i`, `/^grok-/i`,
`/^fugu/i`, `/^swe-/i`) and the four providers' `nativeModelPatterns` are removed. The metered
siblings keep theirs (`google`, `x-ai`, `sakana`): those decide what `parseModelSpec`
attributes a bare name to, and that attribution is never a routing chain.

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

## No catalog: the bundled recommended list

The numbered rules are in [`routing-rulebook.md`](routing-rulebook.md); RB-16 to RB-21, RB-26 and
RB-31 are the ones this section explains.

Measured on 14.18.0: an isolated install with no catalog file and a backend that never answered
(`CLAUDISH_CATALOG_URL=http://10.255.255.1/`), holding only a Codex login, ran
`claudish --model gpt-6.1-sol -p …` and exited 1 after 0.2 s with
`Error: OpenAI API Key is required for model "gpt-6.1-sol"`. With a catalog file the same command
answered in 6.5 s. A new user had no route to anything.

So each release ships a list generated from the backend at the version bump
(`providers/bundled-recommended-list.json`, `generate:bundled-list`): the five recommendation tiers
and their efforts, and only each vendor's own direct and subscription connections. It answers only
when no catalog file can be read and the backend is settled as unreachable. Any catalog file of any
age wins. `CLAUDISH_DISABLE_BUNDLED_LIST=1` turns it off.

**Reachability** (`catalog-reachability.ts`). Only the refresh writes it, and a caller's wait that
times out never marks anything:

| State | Means |
|---|---|
| `unknown` | no catalog request has answered yet |
| `contacted` | a catalog request got a 2xx; the refresh is still running |
| `reached` | a refresh succeeded in this process |
| `unreachable` | the backend could not deliver a catalog: `disabled`, `transport`, `http-status` or `refresh-failed` |

A slow working backend is `contacted`, never `unreachable`, so an online cold launch does not read
the list unless its refresh fails. Only `readAllModelsCache`'s default path answers from the list.
Readiness, freshness, the refresh compare, the memo and recommended generation checks read
`readDiskCatalog` (RB-16).

**The launch verdict wait.** With no catalog file and a bare name to route, a launch cannot tell
offline from online, and guessing is wrong either way. `startup:catalog-verdict` waits once, before
`startup:validate-api-keys`, for the backend's first answer. Offline that takes milliseconds (DNS
failure, `ECONNREFUSED`) or the first request's own 8 s timeout for a black-holed address.
`--models-skip-update` says the launch is offline, so it counts as `unreachable/disabled` with no
wait. `--probe`, the TUI probe and MCP `preflight` make the same wait
(`explainRouteSettled`), and the MCP server settles it before its model checks.

**The one refresh wait.** On a `contacted` launch the key check can refuse because the catalog body
has not landed yet. Only then does the launch wait for the running refresh, up to its own time
limit, and check again: a landed refresh routes from the real catalog, a failed one counts as
unreachable and uses the list (RB-31). A launch with a working key never waits for the refresh.

**Offline order.** A chain gathered from the list runs: the vendor's own catalog subscription, then
its own dynamic subscription, then other subscriptions an account's dynamic models catalog lists
(any vendor), then the vendor's native API, then the fallback (RB-18). A cross-vendor catalog
connection is never a candidate, because the list keeps none. A name outside the list is treated
as no catalog (RB-20), and account-listed candidates still count.

**The fallback offline.** The list keeps no gateway connections, so a fallback hop was never
published for the model. It is appended only when the `defaultProvider` was actually set up: a flag,
the env var, the config, or an OpenRouter key in any store. With the hardcoded default the hop is
withheld as `bundled-no-default-provider` (RB-19), so nobody is billed by a gateway they did not
choose. With no entry for the name, no fallback is appended at all (RB-14).

**Gateway wire ids offline.** The list has no gateway ids, so a gateway-bound hop asks that gateway's
own models list for an exact match at runtime (`gateway-models-list.ts`); with no exact id the hop
is excluded as `gateway-id-unknown` (RB-4). One deadline per routing decision bounds these fetches.
On a launch (`network: "background"`) a gateway list is never waited for: only one already in memory
counts, and a fetch starts for the next decision (RB-29). A failed list is not remembered, so while
a gateway is down each decision that needs it waits up to the deadline again.

**Bundled data denies nothing** (RB-21). `catalogDeniesProvider` answers false, and MCP never answers
`unknown_model` from a name's absence from the list. A recommended list check still runs offline
against the list (`not_recommended`, RB-30).

**The advisor** reads the list on a `contacted` launch too, through `withBundledListScope` around the
same `explainRoute` and handler getters (RB-26); the main chain does not.

**Display.** Everywhere a chain was built from the list names it: `--probe` (text and `--json`
`catalogSource`), the TUI probe, MCP `preflight`, MCP `list_models`, the `[Route]` log line, the launch
error and the advisor notice. Each gives its generation, and the fetch date where a reader chooses
from it. A chain or handler built from the list is tagged and rebuilt once a disk catalog exists; a
request in flight finishes on its handler. Efforts follow the same source: on the bundled list, the
sidecar's row only for the list's generation, else the list's own; on a disk catalog, the newest
sidecar row when it has none for the active generation (RB-23).

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
4. An OpenRouter key present → `"openrouter"`
5. Hardcoded `"openrouter"`

An OpenRouter key counts from the environment, config `apiKeys`, the Keychain or a config `op://`
reference, checked for presence without reading a value (`openRouterKeyPresent`). A key only in a
1Password Environment or glob import that has not been fetched in this process does not count: a
presence check never opens the 1Password SDK.

With a catalog, steps 4 and 5 route identically and differ only in the `source` the route-table gate
records. On the bundled recommended list they differ: step 5 is nobody's choice, so its fallback hop
is withheld.

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
flag still beats a value they hydrate. Children see it because every spawn site of a claudish
child copies `process.env` explicitly at spawn time: `team-grid.ts` (`env: { ...process.env }`),
`claude-runner.ts` (its env built from `{ ...process.env, … }`), the pane launch for MCP sessions
and team slots (`buildPaneEnv(parentEnv)`, `parentEnv = o.parentEnv ?? process.env`) and
`run-prompt-claude-code.ts` (`opts.parentEnv ?? process.env`). Keep that property in any new spawn
site: a child spawned with no `env` option does not see in-process writes, with `Bun.spawn` on any
bun and, measured 2026-10-22, with `node:child_process` too on bun 1.3.10 (the CI pin), where it
gets the original environment (`testing.md`, the spawn rule).

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

The connection rule (`providers/content-use.ts`, decision 2026-10-22) reads `contentUse` first:
`contributor` means opt-in; `standard` never means opt-in, even with a contributor suffix.
Without the field, `isOptInWireId` matches `-contributor` and `-contributor-free` on the last
path segment. The connection rule is enforced where catalog data enters memory, not at each
reader, so a reader added later inherits it:

| Entry point | What it does |
|---|---|
| `readAllModelsCache`, the refreshed `_memCache`, `_setCatalogEntriesForTest` | `splitOptInConnections`: matching rows move from `aggregators[]` to `optInConnections[]` |
| `fetchCatalogPage` (Firebase `ModelDoc`s) | `normaliseCatalogPayload`, the same split |
| `getProbeModel`, `rankProbeCandidates`, `expandSelection` | skip an opt-in id |
| `discoverProviderModelsCatalog` | offered rows exclude opt-in ids; `discoverProviderServedIds` returns both lists for entitlement |

The rows are moved, never deleted. Only EXACT-id readers consult `allConnections()`:
`resolveExternalId`'s first step (`publishesWireIdFor`), `findConnection`'s exact step, the
availability reverse lookup, and `allExternalIds`. `reconcileWires` still checks every row: it
walks `aggregators[]` and `optInConnections` both. A reader that CHOOSES a wire id reads `aggregators[]` and cannot see an opt-in one.

A provider whose only connection for a model is a contributor one is not gathered. `--probe`
shows it as `excluded-by-content-use`. A provider that maps both ids keeps its plain candidate
and shows no drop. Measured on the pinned generation `g-20261016053727894-8a743761` (1189
models): three chains changed, and each lost only `zengo@<id>-contributor` (`gemini-4-argon`,
`muse-spark-1.3`, `muse-spark-1.2`).

**Suffix-fallback removal trigger:** models-index publishes `contentUse` on every connection
(backend task M3, `ai-docs/reports/BACKEND_TASKS_meta_muse_code_route-20261016.md`). Readers with
only a wire id still use the suffix rule. Until then this is the one wire-id name rule claudish
keeps.

## Route bindings: which claudish provider a catalog route means

A connection names a route binding `(routeId, routeProfileId)`, never a claudish provider.
`providers/catalog-route-bindings.ts` maps the two in two tables, split by job:

- **`CATALOG_ROUTE_BINDINGS`, the routing table.** Every key is a claudish provider, built-in or
  a bundled endpoint (`together`, `fireworks`), that owns one endpoint and one credential silo.
  The candidate gatherer reads it through `routingProvidersForRoute`, which returns EVERY name
  bound to a route: `z-ai` and `glm` share `z-ai/direct-api` because their keys sit in two
  silos, and the credential filter decides which one serves.
- **`LOOKUP_ONLY_ROUTE_BINDINGS`: `moonshotai`, `zen`.** Names that catalog READS ask about
  (the Kimi picker list, a legacy picker value) and that no claudish provider answers to. They
  are never route candidates. In the routing table they were candidates by accident of
  spelling. `anthropic` sat here until claudish had a provider for Anthropic's native API: then
  a custom endpoint named `anthropic` would have been gathered for every model that route
  serves. It is now the Claude API's binding in the routing table, and the savings panel reads
  its first-party price through the same name.

Reads see both tables (`catalogRouteForProvider`; `catalogReadProvidersForRoute` lists routing
names first), so each read answers as it did before the split. A name that owns no endpoint and
no credential silo gets no routing binding, whatever its spelling (CLAUDE.md's invariant).

## Runtime subscription routes come from the backend contract

Claudish refreshes the v3 slim model catalog and `queryPlans` together, pins
each page to one generation, and stores the complete snapshot in
`~/.claudish/cloud-models-catalog-v3.json`. A model's `subscriptionPlanIds[]` contains
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

**A subscription's rejected credential moves the chain to its next hop, metered included**
(owner, 2026-10-21). An expired, wrong or revoked credential on any `SUBSCRIPTION_PROVIDERS`
member (and `openai-codex` when its OAuth arm signed) answers 400 with its login hint and the
terminal verdict. An explicit spec stops there. A routing chain moves on to its next hop, whatever
that hop bills, and prints one stderr notice per provider and upstream status naming the next hop
and its billing (`subscription` or `metered, billed per token`) with the login or renewal hint.
The reason: an expired key must not block the chain, and a metered key the user configured is
consent to be billed by it. The rule it replaced (2026-10-16, amended 2026-10-20) stopped the
chain, then tried only later subscription hops, so one stale key on a plan the user had stopped
paying for hid every metered key they held. Billing follows the signing arm of the hop that
served. Connection faults, the recovery hold and stream failures still hold the chain, so a network
fault never walks onto metered billing. A model the plan does not carry and a spent allowance
advance too; for a Codex account pool "spent" means no account is eligible, and a request that
merely used its one account rotation answers a transient 429 on the same hop instead
(`accounts.md`). The mechanism is in `adapters.md` ("A subscription's credential failure").

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
| lifetime | cached on disk in `~/.claudish/cloud-models-catalog-v3.json` | on disk per account (at most 72 h); only a list at most 5 min old may deny |
| owns | model IDENTITY and published plan membership | ENTITLEMENT — which models this key may call |

**A dynamic models catalog is persisted per account, and only a live one may deny.** After a
successful, complete answer, `providers/dynamic-models-catalog.ts` writes the list to
`~/.claudish/dynamic-models-catalog/<provider>.json` (0600, directory 0700) through
`dynamic-models-catalog-store.ts`. The entry is keyed by an HMAC-SHA256 of the credential
identity that would sign, under a local secret in `~/.claudish/dynamic-models-catalog.key`
(0600). The secret sits outside the directory, so a copied directory cannot be tested against a
guessed key. A file holds no credential and no URL, and at most 4 accounts per provider.

The ages (`classifyListAge`): `live` up to 5 min, `fresh` up to 24 h, `stale` up to 72 h; an
older entry is ignored. A stored list of any of those ages may ADD a candidate (an
account-listed candidate, above) and CONFIRM one (`serves`). Only a `live` list may answer
`not-served`, whichever process wrote it, for the same account key. When an older list would
deny, the request path asks the account once and the live answer decides; a launch reads
`unknown`. The in-memory five-minute list in `providers/model-discovery.ts` stays as the live
layer. An account whose credential yields no identity material gets plain discovery held in
memory only, and nothing is written for it.

**The request path waits for missing lists; a launch never does.** `loadChainAccountLists`
(`routing-rules.ts`) runs before the chain is gathered, for every provider that keeps a list
and whose credential reads present (no 1Password prompt). A list that is missing or expired is
fetched for all such providers in parallel, under one bound of `MISSING_LIST_WAIT_MS` (5 s). A
list that fails or runs out of time is left out, and the chain is built without it. The chain
is built once from what that returns, and the proxy caches it for the session
(`fallbackHandlerCache`): a list that lands later changes the next process's chain, never the
running one. Launch callers (`claude-runner.ts`, `advisor-route-plan.ts`, `team-grid.ts`) route
with `network: "background"`, which starts those fetches and waits for none. The launch's
context-window lookup does not wait either: `discoverContextWindow` with `cached-first` answers
from a stored list, and with none it returns at once and starts one background refresh
(`cold-account`). `computeMainThreadContextWindow` then takes the cloud models catalog's window.

**What empties or refreshes a list.** A new credential derives a new key and misses. A login or
logout through the credential authority or `auth-commands.ts` deletes the provider's file
(`forgetAccountModelsLists`). An `unauthorized` answer deletes that account's entry; any other
failure leaves disk untouched. Refreshes start, without being awaited, on bare-name routing (a
list older than 24 h, and the chain's own providers past 5 min), on an explicit spec, on
opening the picker or one of its providers, and on a cross-provider search (the picker's
all-models scope, MCP `search_models`). A stored list is the account's own answer, bound to its
credential, not a remembered routing outcome: a spent subscription limit is still never
remembered.

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
   listed is `serves`, unlisted is `not-served` when the list is live (a stored list older
   than 5 min is asked again first, or reads `unknown` at launch). The cloud models catalog
   may only confirm, never deny.

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
(`makeCodexCredential()` in `codex-credential.ts`). `auth/credentials/equivalence.test.ts:302-305` —
*"OPENAI_API_KEY alias alone → false (excluded)"* — asserts it. The alias survives only in
display and hint code (`tui/providers.ts`, `keychain-command.ts`, `getApiKeyInfo`), which is
its own cosmetic bug: the config TUI shows `cx@` as key-configured from a key that cannot
sign it.

The real dual mode is **two hosts**, which is a code fact rather than an inference: OAuth
(`codex-oauth.json`) signs `chatgpt.com/backend-api/codex/responses`
(`CODEX_RESPONSES_ENDPOINT` in `codex-credential.ts`), while `OPENAI_CODEX_API_KEY` signs
`api.openai.com/v1/responses` (`provider-definitions.ts:408`, `:410`), and the
`transport/openai-codex.ts` header documents that OAuth tokens do not work against
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

- The transport records which arm actually signed: `OpenAICodexTransport.signRequest()` calls
  `recordSignedArm` from the ACCEPTED artifact's `arm` (`"oauth"` ⇒ subscription, anything else
  ⇒ metered), after a pre-record check that rejects a non-OAuth artifact wherever OAuth is
  reserved, and has no catch. Once an account is configured (a Codex row in
  `subscriptionAccounts`, enabled or not, or the unsuppressed legacy `codex-oauth.json`) the
  composite commits to `CodexPoolHalf` and never falls through to `OPENAI_CODEX_API_KEY`: a
  failed refresh or an unreadable account list is a typed accounts error answered by the shared
  classifier (`accounts.md`, "The error surface, as built"). Nothing is signed and nothing is
  recorded, so "OAuth configured, api-key signing" is not reachable; the key signs only when no
  account is configured. The record is still read FIRST because it is exact for the request
  that signed (`TokenTracker.getPricing` asks again on every stream delta), while the probe below
  predicts. The Codex `refreshAuth()` bridge is deleted.
- Before any request has been signed, the probe answers "which credential WOULD sign" with
  `getAccountRegistry().mayHaveConfiguredAccounts("openai-codex")`: the same presence fact
  `CodexPoolHalf.isAvailable()` reads, except that an unreadable or invalid account list answers
  subscription instead of throwing. Safe as money, since that state meters nothing: the request
  fails with a typed error. A throw from the registered callback is contained as subscription.
  **Never** `CodexOAuth.hasCredentials()`, `hasOAuthCredentials` or `describeSourceSync`: the
  first ignores configured rows and suppression, and the other two return true for an
  `access_token` with an unexpired `expires_at` and no `refresh_token`
  (`oauth-registry.ts:88-97`), a state where the API key signs.
- **A failed Codex account list keeps its route candidate.** `applyCandidateFilters` drops a
  `failed` readiness verdict, which for Codex would send a bare `gpt-*` to the next, metered hop
  whenever `config.json` was momentarily unreadable. The authority marks a failure caused by the
  account list with `failureReason: "accounts-list"`, and `isCodexAccountsFailure` keeps that
  candidate at its position with its diagnostic and unknown availability (no discovery call), so
  the handler answers the typed 503 (I/O) or 400 (malformed config). Every other failed
  credential is still filtered.
- Unregistered probe ⇒ metered. Safe as money; the cost is one suppressed cost warning at
  `routing-rules.ts:413`.

`antigravity` (no `apiKeyEnvVar` at all) and `sakana-subscription` (which deliberately does
not alias the PAYG `SAKANA_API_KEY`) have no such ambiguity, which is why they sit in the
plain name set. Adding `openai-codex` to that set as well would short-circuit the probe and
report `SUB` to every API-key user — do not.

## LM Studio machines through LM Link

With LM Link connected and LM Studio on this machine, the picker lists one row per machine that holds a model: `lms@qwen/qwen3.8-27b~local`, `lms@qwen/qwen3.8-27b~m1`. The `~<machine>` suffix is claudish's and never reaches LM Studio. A server on another host keeps one row per model, because `lms` describes only the machine it runs on.

LM Studio has no per-request device (measured: a `<device>:<model>` name answers 400, a `device` field on the REST load answers 400). `LocalTransport` places the model before the first request (`lmstudio-devices.ts`):

- This machine: `lms load --identifier <model>~local`. `lms load` stays local even with another machine preferred.
- A linked machine: a REST load with that machine preferred for the duration of the load. A REST load follows the preferred device.

The identifier matters because LM Studio gives two REST-loaded copies the same identifier, and a request names only the identifier. With both copies loaded under that one name, a chat request is served by the preferred device (measured on two Macs through `lastUsedTime`). Nothing in a request can choose otherwise: `lms ps` does tell the copies apart by `deviceIdentifier` and `indexedModelIdentifier`, but a chat request naming either form answers 400 `Invalid model identifier`, and a REST load with an `identifier` field answers 400 `Unrecognized key(s) in object: 'identifier'`. Two instances sharing a name on different machines are refused rather than guessed at. After every load, `lms ps` must show the instance on the requested machine, or the request fails.

A load asks for `unknownContextWindow` (128,000), or the copy's `maxContextLength` when that is lower. `--context-window` and the picker's size dialog replace the request; both end up in `CLAUDISH_CONTEXT_WINDOW`, so the launch window, the load and the status line read one value. The value is a limit: the window Claude Code gets is the lesser of it and the size that loaded. The dialog appears only for a row that reports `maxContextWindow`, which means a load claudish starts itself, and a copy already running offers only the size it runs with. After a load, and for an instance already running, `lms ps` must report at least that size or the request fails with both numbers (measured: `m1` loads with 8,192 when no size is given). An unloaded copy whose maximum is below the default reports that maximum, so Claude Code compacts before the model overflows. A row's `contextCeiling` is its own `max_context_length`; a machine row's is that machine's loaded size, else its stored maximum. A copy loaded on one machine never caps the copy on another.

The preferred device is a setting of the whole Mac, so a linked-machine load runs under one lock directory, `~/.claudish/lmstudio-machine.lock`, shared by every claudish process (`withMachineLock`). `mkdir` takes it, and the owner's pid is written to a draft and renamed into place, so no reader sees a partial owner. Every race in this design was in the takeover of a lock whose owner exited. The rules that settled it:

- A waiter claims a dead lock by linking its pid file inside it: `takeover/pid`, or `after-<pid>` behind a claimant that exited. A link to an existing name fails, so one waiter makes each entry, and no waiter ever deletes another's entry. An expiry by age was wrong: a paused waiter lost its claim and then deleted a later live lock.
- The claimant checks that the lock is still the one it judged dead (inode, birth time, owner), renames it aside, then deletes the copy. A recursive delete in place empties the directory before it removes it, and a waiter that claims it in between leaves an empty, ownerless lock that every waiter reads as freshly taken.
- The claim directory is made without recursive `mkdir`, which would make again a lock another waiter removed. A copy left aside by a claimant that exited is removed by the next waiter.

Measured: eight processes placing a model five times each from a dead lock, 15 of 15 runs with never more than one process inside and no lock left; the same code deleting in place stalled 2 of 15.

A request whose placement failed must not be sent, because its payload still names `model~machine`, which LM Studio does not serve. One transport serves concurrent requests, so the failure is recorded in the payload, not on the transport: `model` becomes `<model>~<machine> (not placed #<n>)`, and `transformPayload` refuses that payload with its own request's error. The model spec cannot serve as the mark, because a copy on this Mac is placed under exactly `<model>~local`. The probes and the placement sign with the API key before the request's own signing lease exists, so `refreshAuth` holds a lease of its own, and each probe adds the key it signs with.
