> The 25-vendor bundled catalog: credential-gated activation, the registration seam, evidence tiers, and the no-model-data rule.
>
> Extracted from `CLAUDE.md` (v7.64.0). Indexed in [`README.md`](./README.md).

# Predefined Endpoints (v7.51.0+)

A **predefined endpoint** is a `customEndpoints` entry that ships inside the package. The user gets `groq@llama-3.3-70b` with no config file at all, and adding vendor N+1 is appending one object literal to `providers/predefined-catalog.ts` — no new transport, no `PROVIDER_PROFILES` row, no `provider-definitions.ts` entry, no other file touched. That constraint is the feature: the two-table coupling between `BUILTIN_PROVIDERS` and `PROVIDER_PROFILES` is this project's documented worst failure class (a missing profile routes silently to OpenRouter), and a catalog row cannot create one because it never becomes a builtin. A row compiles into exactly the `CustomEndpointComplex` object a user would have hand-written and travels the same validate → definition → profile → register×3 path.

25 vendors ship. PR #136 (@cerebrixos) proposed one of them — `tuningengines` — as a full built-in provider; it lands here as a data row instead, which is a better outcome for that PR than closing it.

## Activation is gated on a LOCALLY-PRESENT credential

A row registers only when its key is already in `process.env`, one of its aliases, or `config.apiKeys`. Not because 25 dead providers would be untidy — because registration is what makes a provider visible at all. `buildProviderDefinition` sets `shortcuts: [name]`, and both the picker roster and the `@prefix` alias table are DERIVED from that, so registering unconditionally would pollute the `@prefix` namespace and its partial-match resolver with vendors that cannot serve a request, and would cost one async credential resolution per row per picker open — each able to open a 1Password handshake on a machine where concurrent handshakes are arbitrated globally and a burst of denials trips a 15-second machine-wide suppression.

Which is why the question is asked with `hasLocalApiKey()` — env → aliases → `config.apiKeys`, **sync**, structurally unable to reach the SDK. Not `credentials.isAvailable()`: a bundled row is not in the authority's map until `registerEndpoint` puts it there, so that call answers `false` for every row and the catalog would never activate at all.

**The honest consequence: a key that lives ONLY behind an `op://` reference will not make its vendor appear.** Activation is sync and 1Password is async; there is no ordering that fixes this without re-opening the handshake-storm door. Once a row IS active its op:// key resolves through the normal authority path with no special-casing. Two escape hatches, both explicit:

```json
{ "predefinedEndpoints": {
    "enabled": true,
    "enable": ["groq", "cerebras"],
    "disable": ["perplexity"] } }
```

`enable` registers a row regardless of credential; `disable` beats `enable`; `"enabled": false` (or `CLAUDISH_NO_PREDEFINED_ENDPOINTS=1`) turns the whole catalog off. An INVALID `predefinedEndpoints` block warns once and is treated as ABSENT rather than as "off" — a typo in an opt-out section must not silently remove providers a user relies on.

**Disabling requires a RESTART, and claudish now says so.** Re-evaluation (`ensureEndpointsRegistered({ force: true })`, which the config TUI runs after a key import) can only ADD: `registerRuntimeProvider` is a `Map.set` with no removal, and the same name is simultaneously live in the credential authority, in the derived `@prefix` alias table and in any handler cache built since. De-registration was considered and NOT built — a partial removal (definition gone, credential still registered) is a provider that half-exists, which is worse than a stale one, and its only consumer is a config edit made mid-session. The actual defect was silence: "I turned it off and it kept answering" reads as a bug rather than as a documented limit. So a row that this process registered and that is no longer eligible — disabled, catalog switched off, credential gone, or now replaced by a `customEndpoints` entry — emits one warning naming the reason and stating that a restart is required.

The refusals (collision with a builtin, duplicate row, already registered, replaced by user config) are checked BEFORE the permissions. A user may opt in to a vendor they have no key for; a user may not opt in to shadowing a builtin, because that is one provider quietly answering in another's namespace.

## ONE registration seam for BOTH halves (v7.62.0) — and the two bugs that forced it

`ensureEndpointsRegistered()` now registers the bundled catalog **and** the user's
own `customEndpoints`, in that order. It used to do only the first, with
`loadCustomEndpoints` called separately from `proxy-server.ts` and `prehydrate.ts`.
That split cost two live bugs:

- **#192 — user endpoints were invisible to every surface that enumerates providers.**
  Both call sites run AFTER `--probe` (which `process.exit(0)`s in its own branch)
  and after the interactive picker has drawn its list. So a configured endpoint
  served real requests correctly and could not be seen or probed. Same defect, one
  layer down, produced `tui/providers.ts`'s `PROVIDERS` **module-load snapshot**:
  a `const` evaluated at import time can never contain a provider registered at
  runtime, no matter when the caller asks. It is `getProviderDefs()` now, and there
  is deliberately no `PROVIDERS` export left to reintroduce it — `PROVIDER_PREFIXES`
  and `CHAIN_PROVIDERS` went the same way.
- **#191 — a `customEndpoints` entry named after a builtin stole its credential.**
  `credentials.registerApiKeyProvider` is a plain `Map.set` with no guard, so an
  entry keyed `openrouter` landed in a SPLIT state: definition and profile still
  resolved to the builtin (so `baseUrl` stayed `https://openrouter.ai`) while the
  credential flipped. Requests to openrouter.ai were signed with
  `CUSTOM_OPENROUTER_KEY`. Quiet in BOTH directions — the user got neither their
  endpoint nor the builtin's key, and the config, the definition and `--probe` all
  showed a consistent "builtin" picture.

`reservedNamespace()` moved out of `predefined-endpoints.ts` into its own module so
both halves import ONE definition of what a builtin owns (name, shortcut, legacy
prefix, `PROVIDER_FILTER_ALIAS_EXTRA`). The bundled catalog had refused collisions
since it shipped; user entries now do too. Refusing beats any merge: there is no
reading of `customEndpoints.openrouter` under which sending the user's key to the
builtin's URL is what they meant.

**Each half gets its OWN `try`.** Merging them under one would couple them — a throw
anywhere in a vendor list *claudish ships* would silently skip the user's
hand-written endpoints, which is a strictly worse failure than the one being fixed.

**ORDER IS LOAD-BEARING**: bundled first, user second. `loadPredefinedEndpoints`
suppresses a bundled row whose name a user entry claims (R4 below) and decides that
from `config.customEndpoints`, not from write order; registering users first would
instead trip its `runtime.has(name) && !ownRegistrations.has(name)` branch and warn
"already registered" about a row being correctly replaced.

**CONFIG SCOPE stays GLOBAL-ONLY, deliberately.** `loadConfig()` and
`loadLocalConfig()` are separate reads with no merge, and the catalog's suppression
set must be built from the SAME object the loader reads — otherwise a project-scoped
`customEndpoints.groq` suppresses the bundled row while its replacement, read from
global config, never registers, and the provider disappears outright. A project
`.claudish.json` declaring `customEndpoints` is therefore ignored, and
`warnOnProjectScopedEndpoints` says so. Before, the failure was total silence.

Two traps found by a multi-model review of the diff, both real:

- **Ordering.** `index.ts`'s config branch resolves every provider's credentials —
  the one pass that pulls `op://` keys — BEFORE `startConfigTui()` runs its own
  `ensureEndpointsRegistered()`. A runtime provider whose key lives only in
  1Password was therefore enumerated and then displayed as not-configured. The
  config branch registers first now; the latch makes the second call free.
- **Registration warnings must use `logStderr`, never `console.error`.**
  `App.tsx`'s `refreshConfig` re-runs registration with `force: true` from INSIDE
  the fullscreen TUI, on every config save and every 1Password import.
  `tui/index.tsx` calls `setStderrQuiet(true)` on mount precisely because a raw
  stderr write there leaves ghost cells OpenTUI cannot invalidate, and
  `console.error` walks straight past that flag. Nothing is lost by deferring:
  `logStderr` always writes the debug log, and a refusal has already called
  `recordEndpointUnavailable`, so the reason resurfaces verbatim when anyone tries
  to route to that provider. (`predefined-endpoints.ts`'s own `warnOnce` still uses
  `console.error` and is reachable on the same path — a latent instance of the same
  hazard.)

**The latch is NOT set when the config read fails.** Latching first and returning
would burn the one registration this process gets on a read that produced nothing:
every later call, including one passing an explicit config, would short-circuit and
the user would run builtin-only for the rest of the session from a transient
failure. In practice `loadConfig()` catches its own parse errors and returns
defaults, so the path is close to unreachable — but the ordering is what makes that
a nicety rather than the only thing holding it up.

## A user `customEndpoints` entry REPLACES a bundled row entirely

No deep merge. The user's entry and the bundled row are both registered from
`ensureEndpointsRegistered()` now, and the bundled row simply stands aside —
suppression rather than write-order, because that seam runs from seven sites and
"whoever registers last wins" is a guarantee a future reordering would silently flip.

The consequence worth stating: **the replacement does not inherit the vendor's conventional env var.** A hand-written `customEndpoints.groq` gets `CUSTOM_GROQ_KEY`, so a perfectly good `GROQ_API_KEY` sitting in the environment is now ignored — silently, and from neither file's point of view. Claudish warns about this exactly when it can bite (the vendor's own variable is actually set) and says the fix: add `"apiKey": "${GROQ_API_KEY}"` to your entry. It stays quiet otherwise, because an unconditional line would print on every launch of a correct config, into a stderr that during an interactive session is Claude Code's own TTY.

## Base-URL override (R12): a malformed override SKIPS, it does not fall back

Gateway-shaped vendors declare `baseUrlEnvVars` — `tuningengines` carries `TUNING_ENGINES_BASE_URL`, the variable PR #136 shipped — because a self-hosted instance does not live at the public hostname and without the override those users cannot use the bundled row at all.

The override is read through **`baseUrlOverrideCandidates()`, the same chain `getEffectiveBaseUrl()` uses**: `config.endpoints[VAR]` (what the config TUI's URL editor and `claudish config` persist) for every declared variable, then `process.env[VAR]` for every declared variable, then the bundled default. Config wins as a TIER, not per variable — matching the `apiKeys` rule. One resolver, because an earlier revision had two: this path read `process.env` only, and since the TUI writes BOTH the config entry and the env var it looked correct for the rest of the session and diverged after a restart, at which point the TUI still DISPLAYED the saved private URL while requests went to the bundled public host. UI says private, wire says public — the same data-egress class as a silent fallback, inverted.

If the override is set but malformed, the row is **skipped with a warning** — from either source. It does NOT silently fall back to the bundled public URL. The reasoning is data egress: a user who exported `TUNING_ENGINES_BASE_URL` did so to keep their prompts inside their own network, and a typo that quietly redirected the traffic to a vendor's public host would send exactly the data they were isolating to exactly the place they were isolating it from. A provider that fails to appear is diagnosable in one warning line; a provider that appears and sends conversations somewhere unintended is not diagnosable at all. The check runs at the gate AND at handler build — at the gate so a bad override never produces a provider that cannot serve, at handler build so a URL exported AFTER startup is checked too.

## Evidence tiers — ALL 25 rows are probe-verified. NONE is live-verified.

Every row carries `evidence` and it is never read at run time; it exists for the catalog invariant test, `claudish providers --json`, and the reviewer of the next vendor PR.

- `tier: "live"` — a real turn was driven through claudish with a real key. **No shipped row carries this tier.**
- `tier: "probe"` — a POST to the CONFIGURED chat path with a deliberately invalid key was answered by the vendor's own auth layer (`verdict: "auth-realm"`, 401/403) or by its model gate (`verdict: "model-gate"`, the route resolved and rejected a nonexistent model), and the reply DIFFERED from a deliberately bogus sibling path.

**25 of 25 are `probe`; 0 are `live`.** Live verification needs a paid account per vendor, and claudish holds a key for none of them. Say exactly what the probe method does and does not establish, because the difference decides what a bug report against one of these rows means:

- It is **strong evidence about ROUTING** — that `baseUrl + apiPath` reaches a live endpoint which authenticates, and that the configured path is the vendor's real one rather than a catch-all. The sibling-path comparison is what buys that: a bogus sibling answering differently proves the route resolved. It exists because pass 1 ("401/403 with a JSON `error` object?") produced four false negatives, and because a status alone proves nothing about a route.
- It is **weak evidence about the vendor's STREAMING DIALECT.** A 401 says nothing about SSE chunking, tool-call encoding, `finish_reason` vocabulary or error-body shape on a successful turn. Those remain untested per vendor until someone holding each key runs a turn.

`GET /v1/models` is **never** evidence here: Alibaba's `coding-intl` roster endpoint returns its full list to a bogus key and to no key at all.

**The LAYER itself is verified end to end, live.** A shipped catalog row (`tuningengines`, whose `apiPath` is byte-identical to OpenAI's) was pointed at `https://api.openai.com` via its own `TUNING_ENGINES_BASE_URL` override with a real key, and produced correct model output through the whole path — catalog → credential gate → compile → collision check → runtime registration → explicit `provider@model` routing → `OpenAIProviderTransport` → SSE parse → stdout — with no source change. The invisible-without-a-key gate, the malformed-override refusal and the placeholder-is-unset rule were confirmed on real traffic at the same time. Transcript, debug-log line numbers and the exact wire URL: `ai-docs/reports/predefined-endpoints/live-run.md`. That run proves the mechanism for every row; it proves the DIALECT of none of them, including Tuning Engines' own (the row was deliberately pointed away from its vendor).

Measured 2026-08-14: **DeepInfra** (`/v1/openai` + `/chat/completions`), **Novita** (`/v3/openai` + `/chat/completions`) and **Perplexity** (`/chat/completions`, no `/v1`) do not use `/v1/chat/completions`. That is why `apiPath` is REQUIRED with no default — an optional field with a default makes the failure mode *omission*, and omission is invisible in review.

Two rows (`parasail`, `writer`) return non-OpenAI error shapes and say so in `evidence.note`. Probed against claudish's own classifiers: both are 401s, so `isTerminalError` returns true on the status before any body is inspected, they are remapped to a 400 surfaced inline, and the 3s/15s/30s in-stream ladder is structurally unreachable (it is gated on HTTP 200 + `openai-responses-sse`/devin). `JSON.parse` failures are caught. The degradation is one long unparsed line for Writer, whose message lives at `errors[0].description` where `extractProviderMessage` does not look. Full write-up: `ai-docs/reports/predefined-endpoints/error-shape-probe.md`.

## No model data, ever (R7)

The schema is `.strict()` and has no `models`, `contextWindow`, `maxOutputTokens`, `pricing`, `capabilities` or `modelDiscovery` field, so a future contributor cannot add one by accident — an unknown key is a parse error, not a silently ignored field. A shipped roster is exactly the hardcoded model data this project forbids: it rots the moment a vendor adds a model, and the failure shape is claudish refusing a model that actually works. So a catalog vendor gets a **free-text model prompt** in the picker rather than a list. Model metadata comes from models-index or is absent.

## The caveat: activation infers intent from an ambient env var

A user who exported `PERPLEXITY_API_KEY` for some unrelated tool silently gains a claudish provider they never asked for. That is real, and it is stated rather than argued away.

It is acceptable for one specific reason: **nothing claudish ships puts a catalog row in a bare-name routing chain.** No row declares `nativeModelPatterns` (the schema has no such field), none owns a legacy prefix, and none appears anywhere in `DEFAULT_ROUTING_RULES` — all three are pinned by `predefined-containment.test.ts`, the third because it is the one a future contributor can open with a single well-meaning edit ("`llama-*` should try Groq first"). So a row is reachable only by typing `perplexity@model` — the same explicit-access rule Devin and Alibaba Token Plan already follow, for the same reason. The cost of the wrong inference is therefore one extra row in a picker, never a request billed to a provider the user did not choose.

The one qualification, stated because the absolute version is false: `route()` appends `defaultProvider` to EVERY bare chain, so a user who sets `"defaultProvider": "groq"` really does put a catalog row in bare chains. That is explicit user action naming the vendor, not a silent path, so the safety argument survives — but "can never" does not. If a catalog row ever becomes bare-name reachable WITHOUT the user naming it, this gate has to be revisited, because the inference would then be able to move money.
