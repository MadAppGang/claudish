# Routing rulebook

> The numbered rules every setup's routing chain must obey. Each rule is one statement, the code
> it polices, and the test that tells its cases apart. [`routing.md`](./routing.md) explains why
> routing is shaped this way; this file states what must hold.

A reviewer applies a rule to the files named in its **Scope**. Every path is relative to
`packages/cli/src/`. In a **Check** line, `S1`, `S11c` and the like are rows of
`providers/routing-setups.test.ts`, whose setups are data in `providers/test-data/routing-setups.ts`.

Words follow the thesaurus in `CLAUDE.md`. The **bundled recommended list** is the
`providers/bundled-recommended-list.json` file generated at release time. A **bundled origin** means
that list is the catalog source of this routing decision. **Offline** means no readable disk cache
and a backend that could not deliver one.

Out of scope for this rulebook: picker ordering (`picker.md`), stats and pricing display, and the
hooks system.

## Which names are routed

### RB-1

Only a `proxyRouteDecision` → `bare` target reaches `route()`. `nativeRouteFor()` answers native
Claude names first in the proxy, `--probe`, the TUI probe, MCP `preflight` and `planAdvisorModel`.
`claude@<id>` is the native decision of `<id>` and never reaches `route()`; the MCP strip never
removes `claude@` (a bare name follows the API-billing opt-in, `claude@` never does), and the pane
child that receives it keeps the choice as `claudeSubscriptionPin`. A `claude@` spec
`claudeSubscriptionSpecRefusal` refuses (a marker, `:N`, a chain hop, a name Claude Code does not
own) is refused on the spec as given BEFORE native recognition, in `explainRoute` (no-route
`explicit-refused`) and in `preflightModel` as in every launch. `--probe` and the config TUI may also list a
BARE native name's catalog routes (`comparisonCandidates`: no user rule, no fallback hop, the native
provider excluded before the credential filter, plus one off-catalog `anthropic` candidate when the
catalog has no entry); that list is never a `RoutePlan` and no request is routed from it.

- **Scope:** `providers/native-route.ts`, `proxy-server.ts`, `cli.ts`, `tui/hooks/useRouteProbe.ts`, `providers/preflight-chain.ts`, `handlers/advisor-route-plan.ts`, `mcp-server.ts` (`stripUnrequestedProvider`), `providers/routing-rules.ts` (`explainRoute`'s comparison), `providers/explain-route-settled.ts`, `providers/probe-runner.ts`, `launcher/claude-launch.ts`.
- **Check:** `providers/native-route.test.ts`, `providers/preflight-chain.test.ts`, `providers/native-route.claude-prefix.test.ts`, `mcp-provider-strip.test.ts` (the `claude@` cases), `providers/routing-rules.comparison.test.ts`.

### RB-2

An explicit `provider@model` is a one-hop chain to that provider: no gathering, rules or fallback.
Its outcomes are `explicit-unknown-shortcut`, `explicit-no-credential`, `explicit-unbuildable`,
`explicit-not-served` and `explicit-refused`, for a refused `claude@` spec (RB-1) or a spec on a
custom endpoint name a Claude builtin took over (`shadowedEndpointRefusal`). Offline, a model outside the bundled recommended list, or a bundled
model with no bundled connection for that provider, is refused as with no catalog. A probe sends
each hop of a bare name's routing chain as a spec marked `x-claudish-hop-origin: routed`; only a
proxy started for probing (`probeProxy`) honours the mark and builds that hop as a routed hop, so a
spec the user typed stays explicit, and a proxy serving Claude Code ignores the mark.

- **Scope:** `providers/routing-rules.ts` (`explainExplicitSpec`), `providers/wire-handler.ts`, `handlers/handler-set.ts`, `providers/probe-hop-origin.ts`, `providers/probe-runner.ts`, `providers/probe-live.ts`.
- **Check:** S8, S8b, S8c, `providers/probe-hop-origin.test.ts`.

### RB-3

A matching user rule (project over global) is used verbatim, never merged or given a fallback. A
matched `[]` is no-route `rule-empty`. A matched rule with an entry on a custom endpoint name a
Claude builtin took over, or an entry naming the Claude subscription (`claude`, `claude@<id>`,
which Claude Code serves on its own login and is never a routed hop), is refused whole: no-route
`explicit-refused`, decided before any candidate is gathered and never replaced by `rule-empty`
or `catalog-unreadable` (`userRuleRefusal`).

- **Scope:** `providers/routing-rules.ts`.
- **Check:** `providers/routing-rules.test.ts`, S3.

### RB-4

A rule or fallback entry without `@` gets its wire id, in order: plan membership
(`resolveSubscriptionRouting` `serves`); else `resolveExternalId`; else, ONLY with a bundled origin
and a gateway-bound provider, an exact id from that gateway's models list, or the entry is excluded
`gateway-id-unknown`; in every other case the name passes through unchanged. A bare name whose
candidates are all excluded before the credential filter, one of them `gateway-id-unknown`, is
no-route `gateway-id-unknown`, never `rule-empty` or `catalog-empty`.

- **Scope:** `providers/routing-rules.ts` (`resolveRoutingEntries`), `providers/catalog-client.ts` (`resolveExternalId`).
- **Check:** S1, S1b, S1c, S3, S3b, S11d.

## Gathering and ordering candidates

### RB-5

In `route-candidates.ts`, candidates come only from mapped catalog connections bound to a claudish
provider (wire id = `externalIdFor`, never a moving pointer or opt-in id), vendor claims, and
account-listed rows. Candidate gathering applies no name pattern. Not covered: model-spec parsing
(`model-parser.ts`, `nativeModelPatterns` attribution) and `normalizeGlmSlug`, which rewrite the
name before routing.

- **Scope:** `providers/route-candidates.ts`.
- **Check:** `providers/route-candidates.test.ts`, S7.

### RB-6

Dedupe by `(provider, wireId)`: connection > claim > account list.

- **Scope:** `providers/route-candidates.ts`.
- **Check:** `providers/route-candidates.test.ts`.

### RB-7

When `resolveSubscriptionRouting` answers `not-served` (a plan whose membership the catalog
publishes and which lacks the model), the candidate is `excluded-by-membership`: shown, never a hop.
Other plans answer `unknown` and the candidate stays.

- **Scope:** `providers/route-candidates.ts`, `adapters/model-catalog.ts` (`resolveSubscriptionRouting`).
- **Check:** `providers/route-candidates.test.ts`, `providers/routing-rules.test.ts`.

### RB-8

Order: band → vendor-own → tier → price (unknown last) → window → provider → wire id. Tier is the
provider's definition, never data.

- **Scope:** `providers/route-candidates.ts` (`compareRouteCandidates`).
- **Check:** `providers/route-candidates.test.ts`, S2, S6.

### RB-9

Vendor-own = the connection's `routeId` equals the entry's vendor.

- **Scope:** `providers/route-candidates.ts` (`isVendorOwnRoute`), `providers/bundled-list-build.ts`.
- **Check:** `providers/route-candidates.test.ts`, S2.

## The fallback hop

### RB-10

`defaultProvider` precedence: flag → env → config → an OpenRouter key present in env, config
`apiKeys`, Keychain or a config `op://` reference → hardcoded `openrouter`. `""` disables. Presence
is checked without reading a value.

- **Scope:** `default-provider.ts`.
- **Check:** `default-provider.test.ts`, S1-kc, S9, S17, S17b.

### RB-11

With a disk catalog, the fallback is appended last unless disabled, already a kept candidate, or
denied by `catalogDeniesProvider`. A disk catalog that lacks the name (`catalog: "absent"`) still
appends it, with the name resolved by RB-4.

- **Scope:** `providers/routing-rules.ts`, `providers/route-candidates.ts` (`catalogDeniesProvider`).
- **Check:** `providers/routing-rules.test.ts`, S1 column C.

## Filters

### RB-12

Credential filter: readiness `absent` → `no-credential`; `failed` → `credential-unreadable` (only a
subscription or `openai-codex` candidate is described with a full readiness; others are `present`
or `absent`); `present` keeps the candidate. Exception: a Codex typed account-list failure
(`failed`, `failureReason: "accounts-list"`) is kept for signing.

- **Scope:** `providers/routing-rules.ts` (`applyCandidateFilters`).
- **Check:** `providers/routing-rules.test.ts`, S2, S5.

### RB-13

Availability removes a candidate only on a positive `not-served` from the account's dynamic models
catalog (≤ 5 min old). An older list only adds or confirms.

- **Scope:** `providers/model-availability.ts`, `providers/dynamic-models-catalog.ts`.
- **Check:** `providers/model-availability.test.ts`, S7.

### RB-14

No-route causes are `NoRouteCause` only. With no catalog, or a bundled miss, no fallback is appended
(`fallbackWithheld: catalog-unreadable`), so claudish never sends `<gateway>@<name>` for a name
nobody published offline. With a disk catalog lacking the name, RB-11 applies.

- **Scope:** `providers/routing-rules.ts`.
- **Check:** S1 (`minimax-m3`), S5, S12b, S12e.

### RB-15

A user `customEndpoints` entry (no route binding) reaches a chain only by user rule, explicit spec
or `defaultProvider`. The catalog never denies it and RB-4's gateway lookup never applies to it.
Predefined endpoints with a route binding (`together`, `fireworks`) are catalog providers and follow
RB-5.

- **Scope:** `providers/routing-rules.ts`, `providers/route-candidates.ts`, `providers/catalog-route-bindings.ts`.
- **Check:** S4.

## The catalog source

### RB-16

Catalog source: a readable disk cache of any age; else the bundled recommended list only when
reachability is `unreachable` (settled; a caller timeout never counts), or inside
`withBundledListScope` (the advisor, RB-26); else none. `CLAUDISH_DISABLE_BUNDLED_LIST=1` turns the
list off in both cases. These read disk only, through `readDiskCatalog`: `ensureCatalogReady`,
`ensureRouteRegistryReady`, the refresh's on-disk compare, `_memCache` and `isCatalogWarm`, the
recommended generation checks in `model-loader.ts`, `classifyCatalogState`, the advisor's "catalog
not loaded" warning, `latestAnthropicTierModelId`, `clearAllModelCaches`, and the picker's
`createCatalogClient`.

- **Scope:** `providers/all-models-cache.ts`, `providers/catalog-client.ts`, `providers/catalog-reachability.ts`, `model-loader.ts`, `launcher/catalog-warm.ts`, `index.ts`, `cli.ts`, `providers/model-catalog.ts`.
- **Check:** the reader-table test over every `readAllModelsCache` and `getCatalogEntries` identifier, S11c, S12d, S14, S15, S16, S16b.

### RB-17

The bundled recommended list holds the five recommendation tiers' models and only vendor-own direct
or subscription CATALOG connections, derived by data equality, with no regex. It trims nothing an
account's own list adds.

- **Scope:** `providers/bundled-list-build.ts`, `scripts/generate-bundled-list.ts` (under `packages/cli`).
- **Check:** `providers/bundled-list-build.test.ts`, `providers/bundled-recommended-list.test.ts`, S8c, S10, S10b.

### RB-18

Offline order: own catalog subscription → own dynamic subscription → other subscriptions listed by
their accounts' dynamic models catalogs (any vendor) → own native → fallback. A cross-vendor catalog
connection is never a candidate offline.

- **Scope:** `providers/route-candidates.ts`, `providers/bundled-list-build.ts`.
- **Check:** S6, S7, S10, S10b.

### RB-19

With a bundled origin, the fallback is appended only when the `defaultProvider` source is not
`hardcoded` (`fallbackWithheld: bundled-no-default-provider`).

- **Scope:** `providers/routing-rules.ts`, `default-provider.ts`.
- **Check:** S1, S1-kc, S2, S4, S5, S9, S17, S17b.

### RB-20

With a bundled origin, a bare name outside the list is treated as no catalog. Account-listed
candidates still count.

- **Scope:** `providers/routing-rules.ts`, `providers/route-candidates.ts`.
- **Check:** S1 (`minimax-m3`), S4 (`minimax-m3`).

### RB-21

Bundled data denies nothing: `catalogDeniesProvider` is false, and MCP never answers `unknown_model`
from absence in the list.

- **Scope:** `providers/route-candidates.ts`, `providers/model-availability.ts`, `mcp-server.ts`.
- **Check:** S4, `mcp-model-choice.test.ts`.

### RB-22

With a bundled origin these name the bundled source and its generation: `--probe` (text and
`--json` `catalogSource`), the TUI probe note, MCP `preflight`, the MCP `list_models` note, the
`[Route]` log line, the launch error and the advisor notice.

- **Scope:** `cli.ts`, `tui/hooks/useRouteProbe.ts`, `providers/preflight-chain.ts`, `mcp-server.ts`, `providers/routing-rules.ts`, `providers/provider-resolver.ts`, `handlers/advisor-route-plan.ts`.
- **Check:** `providers/route-description.test.ts`, `tui/routing-explanation.test.ts`, S11, S12b.

### RB-23

Efforts: the sidecar's row for the active source's generation when it holds one. Else, with a
bundled origin, the bundled list's own efforts, never a sidecar row of another generation. Else
(a disk catalog whose generation the sidecar lacks, or no catalog at all) the newest row the
sidecar holds, as `list_models` and the effort check read it before the bundled list existed.

- **Scope:** `providers/effort-recommendations.ts`, `mcp-server.ts`.
- **Check:** S13.

### RB-24

Same inputs give the same chain (total order).

- **Scope:** `providers/route-candidates.ts`, `providers/routing-rules.ts`.
- **Check:** `providers/route-candidates.test.ts`.

### RB-25

No model ids, membership, windows, limits or pricing are written by hand in `src/`. The bundled
recommended list is the one release-generated exception, written only by its generator.

- **Scope:** every non-test file under `packages/cli/src/`, `providers/bundled-recommended-list.json`.
- **Check:** `providers/no-name-rules.test.ts`, `providers/bundled-recommended-list.test.ts`.

## Other call paths

### RB-26

With no catalog file, a bare advisor member is planned and its hops are built from the bundled
recommended list whatever the reachability verdict (`unreachable` or `contacted`), through
`withBundledListScope` around the same `explainRoute` and handler getters as the main chain, never
a separate gatherer. Advisor planning adds no wait of its own and is never refused for a model in
the list while a hop is usable; the launch's verdict wait (RB-31) is the launch's, not the
advisor's. The plan is kept for the session. Only the advisor reads the list on a `contacted`
launch; the main chain does not.

- **Scope:** `handlers/advisor-route-plan.ts`, `providers/catalog-reachability.ts`, `providers/all-models-cache.ts`.
- **Check:** S11, S11b, S11c, S11d, S11e.

### RB-27

A `+` model chain reaching the proxy's pinned-chain branch (`options.modelChain`, length > 1) is
built element by element and no element calls `route()`. An element may be a bare name
(`parseModelChain` accepts one): it is handed to the handler getters as written, with no chain
gathered for it. Its elements are routed hops (`hopOrigin: "routed"`) only when a parent claudish
pinned the value (`--model-pinned`, written by `team` and `create_session` for a bare name), and a
pin of one spec is a routed hop too. The flag is honoured only in a pane child (`isPaneChild()`,
`modelPinnedHonoured`); anywhere else it is dropped with a debug line. A chain the user typed is a
list of explicit specs, each under RB-2. Routed origin is never inferred from a provider shortcut.

- **Scope:** `proxy-server.ts`, `providers/model-parser.ts`, `cli.ts`, `index.ts`,
  `pane/child-env.ts`, `pane/pane-launch.ts`, `pane/pane-session.ts`,
  `mcp-session/session-manager.ts`, `mcp-server.ts`, `team-orchestrator.ts`.
- **Check:** `providers/model-chain.test.ts`, `proxy-server.test.ts`.

### RB-28

A local-transport handler (`getLocalProviderHandler`) takes no connection, wire or registry from a
catalog or the bundled recommended list. A local explicit spec may pass the proxy's generic wire-id
lookup (step 2b), which finds nothing and leaves the name unchanged.

- **Scope:** `handlers/handler-set.ts`, `proxy-server.ts`.
- **Check:** `proxy-server.test.ts`, `providers/local-liveness.test.ts`.

### RB-29

One deadline per routing decision (`MISSING_LIST_WAIT_MS`, 5 s) bounds account lists, gateway lists
and the availability filter; on the user-rule branch it bounds gateway lists only. With
`network: "background"` a gateway list is never waited for: only a list already held in memory
counts, and a fetch is started for the next decision.

- **Scope:** `providers/routing-rules.ts` (`loadChainAccountLists`, `loadGatewayWireLists`).
- **Check:** `providers/routing-rules.availability-deadline.test.ts`, S3, S11d, S11e.

### RB-30

MCP tools remove an unrequested `provider@` (`user_required_provider`) and refuse a bare name
outside the recommended list (`not_recommended`). Offline the recommended list is the bundled one.

- **Scope:** `mcp-server.ts`.
- **Check:** `mcp-provider-strip.test.ts`, `mcp-model-choice.test.ts`.

### RB-31

A launch with no catalog file and a bare name waits once for the reachability verdict (bounded by
the first catalog request's own timeout) before `startup:validate-api-keys`. If a key check is then
refused because the catalog body has not landed (`catalog-unreadable` with verdict `contacted`),
the launch waits once for the running refresh, up to its own time limit, and checks again: a landed
refresh routes from the real catalog; a failed one counts as unreachable and uses the bundled
recommended list. A launch with a working key never waits for the refresh. A missing-key verdict
for a name with no catalog source, or a bundled chain with no surviving hop, prints the routing
cause (`<why>` by reachability / not in the bundled recommended list / `claudish
--models-refresh`), never a vendor-key demand.

- **Scope:** `index.ts`, `launcher/catalog-warm.ts`, `providers/catalog-client.ts` (`settleCatalogVerdict`, `settleCatalogRefresh`), `providers/provider-resolver.ts`.
- **Check:** S12, S12b, S12c, S12d, S12e, S16, S16b, S16c.

## Changing a rule

The CI review reads this file from the PR's base. A PR that changes a rule and its code together
carries the label `routing-rule-change`; the review job then reads this file from HEAD, prints the
diff of this file first in the job summary, and the human approval covers it. The label counts only
when it is on the PR now and its MOST RECENT `labeled` event has an actor whose repository
permission is `write`, `maintain` or `admin`. A PR that changes only this file needs no label.
