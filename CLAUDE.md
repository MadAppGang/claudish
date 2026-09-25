# Claudish - Development Notes

CLI proxy that runs Claude Code against non-Anthropic models.

Engineering rationale lives in `ai-docs/architecture/` — **read the relevant file before editing
that area**; it records measurements the source cannot show you. Filenames below are relative to
that directory, whose `README.md` is the full index. Parked work with explicit trigger conditions
lives in `ROADMAP.md`.

## Where the rationale lives — all files below are in `ai-docs/architecture/`

- `routing.md` — `provider@model` syntax, every provider prefix, catalog-gathered route candidates and their tier order, `defaultProvider` as the fallback position, the derived picker provider list, `SUBSCRIPTION_PROVIDERS`, local models
- `adapters.md` — Layers 1–3, stream parsers, error classification and retry, the 400 remap, why Gemini tool schemas need `items` on every array
- `network-recovery.md` — the two-tier connection hold: the DERIVED deadline (`API_TIMEOUT_MS`, not a
  watchdog), why tier 2 answers 503 and never 429, why the banner is magmux's `overlay` and never a
  pane of ours (closing a pane wedged Claude Code), the five auth sites
- `behavior-layer.md` — Layer 4, the harness-conformance supervisor
- `advisor.md` — `--advisor` for any main model: independent of `--monitor`, decorator on the routed handler, ids by tool name, retained session state, stub paths S1-S10, Claude Code's gates, metered panel billing; read before editing advisor, decorator, monitor-launch or native-auth code
- `providers/devin.md`, `providers/grok-subscription.md`, `providers/antigravity.md`, `providers/qwen-alibaba.md` — one per reverse-engineered provider
- `headless-vs-interactive.md` — `-p` is not interactive-minus-a-TTY; an UNKNOWN `--agent` name is
  silently unvalidated under `--input-format stream-json` (a VALID one is applied correctly); why magmux
- `first-party.md` — what Claude Code gates on trusting its base URL, why a `--monitor` session can be given that trust, and what the proxy then owes each request; read before editing native forwarding
- `daemon-mode.md` — `claudish daemon` as the service manager of Claude Code's supervisor: what `claude daemon run` does per origin, the exit-70 restart and its reinstall wait, one signal through a separate process group, and why sessions reach the proxy only through a settings `env` block; read before editing `daemon-command.ts`
- `custom-endpoints.md`, `predefined-endpoints.md` — user config; the 25-vendor bundled catalog
- `onepassword.md` — secret resolution, the four denial causes, the handshake lock, route pinning
- `keychain.md` — the macOS Keychain backend: enumerate-for-presence vs read-for-value, the `security` traps, the Providers-tab write/delete
- `mcp-channel.md` — MCP tool surface, channel wire format, progress keepalive
- `team-capture.md` — why `team`'s exit 0 proves nothing
- `team-lifecycle.md` — why no slot is ever killed on a timer, why `run` returns before its
  children finish, idle time as information, why `outputSize` reads 0 on a RUNNING slot and
  what to read instead, and why `keepUnrecognizedJson` is an option
  rather than one rule for both the channel and `team`
- `picker.md` — the OpenTUI model picker: a dialog, not a dashboard; the provider list first
  with nothing prefetched; why an empty list must say WHY; the no-terminal gate; capture and
  compiled-binary traps. Read before editing `picker/` or `selectModel`
- `context-window.md`, `theming.md`, `debugging.md`, `testing.md`

Evidence behind them: `ai-docs/reports/`. Evals: `ai-docs/benches/`. User-facing site: `docs/`.

## Thesaurus — one name per concept

Every agent and the main thread use these words, in code, comments, commit messages, docs and
conversation. A concept with two names reads as two concepts. The "Never write" column is the
negative case: if you are about to type one of those words, stop and use the left column.
`AGENTS.md` is a symlink to this file, so Codex reads the same list.

**Catalog and data**

| Use | Never write | Means |
|---|---|---|
| cloud models catalog | "catalog" alone when the kind matters; "Firebase catalog" | the hosted models-index metadata, keyed by canonical model id, read with no credential |
| dynamic models catalog | roster, account roster, live roster, served set | the models a provider's discovery endpoint returns for ONE credential; never persisted |
| membership | roster, plan roster, included models | the models a subscription plan publishes (`subscriptionPlanIds`); coverage, not access |
| entitlement | membership, coverage (when you mean access) | what one account may actually call; only its dynamic models catalog or a live request proves it |
| generation | revision, snapshot, catalog version | one immutable catalog publication (`generationId`); every read of one refresh is pinned to it |
| canonical model id | model name, catalog name | the catalog record's `modelId` (`kimi-k3`) |
| wire id | provider name for the model, external name | the exact string sent to a provider (`externalModelId`: `k3`, `MiniMax-M3`) |
| moving pointer | alias, latest alias | an id that redirects over time (`~moonshotai/kimi-latest`); send it only when the user asked for "latest" |
| route binding | provider id, route alone | the `(routeId, routeProfileId)` pair; it names one endpoint and one credential silo |
| route variant | effort model, model preset | a preset entry of a base model (`routeVariant`, e.g. `kimi-k3-256k`, context=256k) |
| connection | aggregator row, provider row | one mapped way to call a model: an `aggregators[]` entry with `routeStatus: "mapped"` |
| input modality, output modality | capability (for what goes in or out) | what a model accepts and produces: text, image, audio, video, file |
| chat model | text model, LLM | text among its input modalities AND among its output modalities; other modalities on either side never exclude one (`in: [file,image,text]` is a chat model, `in: [audio]` is not) |
| type | shape, kind, variant (for a discriminator) | the field that says how to read the rest of an object: `pricing.type` is `flat`, `tiered`, `free` or `unavailable`. The catalog spelled it `shape` until the cutover on generation `g-20260921062451697-f490edba`; claudish reads `type` only, with no alias |
| route candidate | option, hop (before filtering), chain entry | one `(provider, wire id)` pair gathered for a model, BEFORE the credential and availability filters. A candidate is a proposal; a hop is what survived |
| tier | class, category, rank, level | a provider's routing class: `subscription`, `dynamic-subscription`, `native`, `gateway`, `fallback`. Ordering is by tier first, and only then by vendor and price — except that the two subscription tiers count as one, so a vendor's own dynamic subscription leads another vendor's catalog subscription (`gk@` before `zengo@` for `grok-4.x`) |
| namespace claim | pattern match, native claim | a dynamic subscription becoming a candidate because its `nativeModelPatterns` match the name. It exists so the availability filter can ASK the account; it is never evidence that the account is served |

**Providers and routing**

| Use | Never write | Means |
|---|---|---|
| claudish provider | provider (when ambiguous), vendor | an entry in `BUILTIN_PROVIDERS` (`openai-codex`, `qwen-token-plan`) |
| vendor | provider (for the model's maker) | the company that makes the model; the catalog's `provider` field |
| provider shortcut | prefix | `cx` in `cx@gpt-6-astra`. "Prefix" already means three other things in `provider-definitions.ts` |
| model spec | model string | `provider@model`, explicit on argv |
| bare name | unprefixed model | a model with no `provider@`; routing chooses its provider |
| routing chain | fallback chain | the ordered, credential-filtered candidates for one request |
| fallback | (the whole chain) | only the last-resort `defaultProvider` hop |
| subscription | plan (as a billing category) | claudish's flat-rate category (`SUBSCRIPTION_PROVIDERS`); "plan" is the vendor's product name |
| dynamic subscription | client subscription | a subscription whose models the account's own discovery decides (Antigravity, SuperGrok, Devin) |
| native API | direct API | the vendor's own metered endpoint (the `direct-api` profile) |
| gateway | aggregator (as a tier) | a metered service reselling many vendors: OpenRouter, Together, Fireworks, Poe, Vertex |
| metered | pay-as-you-go, PAYG | billed per token. PAYG survives only in the names `qwen-payg` and "Alibaba PAYG" |
| probe pick | probe model, test model | the first model Test All tries on a provider |

**Harness and runtime**

| Use | Never write | Means |
|---|---|---|
| harness | host | Claude Code driving the session; "host" is the MCP host that spawns the server |
| foreign model | external model | any model not native to the harness; a local Ollama model is foreign too |
| picker | selector | the interactive model chooser (`PICKER_ORDER`), although the file is `model-selector.ts` |
| hydrate | resolve (for writing a secret into the environment) | resolving fetches a secret from 1Password; hydrating writes it into `process.env` |
| stream format | wire format | the SSE dialect one parser consumes; wire format is a converter's whole encoding |

**Negative cases, in context**

- Wrong: "the account's roster lacks the model." Right: "the account's dynamic models catalog lacks the model."
- Wrong: "the plan's roster has 31 models." Right: "the plan's membership has 31 models."
- Wrong: "fall back to the Kimi alias." Right: "send the exact wire id `moonshotai/kimi-k3`, not the moving pointer."
- Wrong: "the provider `qwen`" when you mean the Alibaba Token Plan. Right: "the claudish provider `qwen-token-plan`" or "the vendor `qwen`".
- Wrong: "the fallback chain." Right: "the routing chain", whose last hop is the fallback.

**Static values** (provider names, shortcuts, credential names, hosts) are copied from the backend contract: models-index `ai-docs/alibaba-provider-changes.md` and the binding fixture. A rename REMOVES the old name: no alias, no shim, no deprecation notice. Wire names the backend has not renamed yet (`rosterCoverage`) are quoted verbatim, never adopted as prose.

## Invariants — each of these fails SILENTLY

- A new provider needs entries in BOTH `BUILTIN_PROVIDERS` and `PROVIDER_PROFILES`; a missing profile routes to OpenRouter with no error.
- `apiKeyEnvVar` stays `""` for `devin`, `antigravity`, `grok-subscription` — non-empty means the handler is never built and the model falls through to OpenRouter.
- Never hardcode a provider's models, a plan's membership, context windows, `maxOutputTokens`, or pricing. Discover live; a default is a rule, never a pinned id.
- Terminal errors are remapped to 400, so any `status ===` under `handlers/` is suspect — recover the real one with `extractUpstreamStatus`.
- Read `C.*` / `tokens.*` at RENDER time; a module-level `const` snapshots the dark palette before detection runs.
- A provider absent from `SUBSCRIPTION_PROVIDERS` quotes flat-rate users a per-token price and accrues fictional spend.
- `openai-codex` bills by the CREDENTIAL that signed, never by its name, so it is in `CREDENTIAL_DECIDED_PROVIDERS` and must never also be in `SUBSCRIPTION_PROVIDERS` — the name check short-circuits the probe. The probe is installed only as a side effect of importing `auth/credentials/authority.ts`; unregistered, `cx@` silently reports metered (safe as money, but it also suppresses the `routing-rules.ts:413` cost warning). Probe with `CodexOAuth.hasCredentials()`, never `hasOAuthCredentials`/`describeSourceSync`.
- What makes an arm the SUBSCRIPTION arm is `RequestAuth.arm === "oauth"`, set by the credential half itself — never "the composite returned an artifact". `CompositeCredentialProvider` falls through to the api-key half, which ALWAYS returns an object (`{headers:{}}` even with no key), so a truthiness test on the cached artifact labels every metered request SUB and accrues $0. Absent `arm` ⇒ metered. This shipped once and three reviewers read it as correct.
- Cross-vendor subscriptions such as Devin and the Alibaba Token Plan send a candidate only when its exact catalog route/profile membership includes it; a model the account itself selects stays discoverable through the provider's dynamic models catalog.
- `gk@` is the Grok SUBSCRIPTION; `grok@`/`xai@` is the metered `x-ai`. `moonshot-cn@` is a different service from `moonshot@`.
- A bare Claude name (`claude-opus-5`, `opus`, `internal`) must never reach `route()`: `native-anthropic` has no credential store, so the credential filter drops it and the chain degrades to OpenRouter. Check `nativeRouteFor()` (`providers/native-route.ts`) FIRST, as the proxy does — `preflight` and the TUI probe once didn't and told agents to drop their own subscription's models. Native routes also cannot be probed from outside a session (the handler forwards the inbound Claude Code header); report them as a third outcome, never as success or failure.
- A new `ClaudishProfileConfig` field MUST be added to `loadConfig`'s allowlist in `profile-config.ts`; otherwise it survives on disk until the first global save and is then dropped. Bit `onepasswordEnvironments`, then `keychain`.
- A new `StatsEvent` field MUST also be pushed in `eventToLogRecord` — `stats-otlp.ts` is a HAND-WRITTEN attribute allowlist, so a field wired only into the interface and `stats.ts` is typed, buffered to `~/.claudish/stats-buffer.json`, and never sent. Nothing errors; the number is just missing from every dashboard, a quarter later. `stats-otlp.test.ts`'s table is `satisfies Record<OptionalStatsKey, …>`, so adding the field breaks compilation until it is listed there too — keep that.
- A connection failure can arrive wearing an AUTH status code, at FIVE sites in `composed-handler.ts` (`refreshAuth`, `forceRefreshAuth`, the parameter-recovery re-fetch, `getHeaders`, the primary fetch). 401 is retryable to `FallbackHandler`, so answering it for a network fault walks a subscription user onto metered billing mid-outage; an unclassified THROW is the same bug one layer out (`{status: 0}` + an unconditional advance, with no cost warning). Classify first or rethrow unchanged — never invent a status. `getHeaders()` is the non-obvious one: for `gk@` it is the request's first network touch, and refresh-conditional, so it is rare rather than safe. A TRANSPORT's own `refreshAuth` catch that returns normally is the same bug one layer earlier: `openai-codex.ts` swallowed an unreachable token host and fell through to the metered api-key path.
- Anything that renders a TUI to **stderr** must `setStderrQuiet(true)` for as long as it owns the screen, and release it in a `finally`. `logStderr` writes there too, so the two interleave inside one frame: the TUI repaints its own cells over part of the line and the surviving fragments read as a layout bug. `--probe` hit this — the tell was a stray `[c`, the head of `[claudish] `, left in a failed row. The message is not lost; `logStderr` always writes the debug log as well.
- A `route binding` names one endpoint AND one credential silo. A provider that owns neither does not belong in `CATALOG_ROUTE_BINDINGS`, even when its name matches the `routeId`: since `routingProvidersForRoute` returns every provider bound to a route, a placeholder listed there becomes a route candidate and `--probe` prints a hop no key can ever satisfy. A name that only READS catalog data through a route (a vendor slug such as `anthropic` for the savings-panel price, `moonshotai` for the Kimi picker list) goes in `LOOKUP_ONLY_ROUTE_BINDINGS`, which the lookups consult and routing never does; a test pins that table's members. Do NOT fix that by filtering `reason: "virtual"` out of the gatherer — `native-anthropic` is virtual and genuinely routable through the native passthrough, so that filter takes `claude-*` away from anyone holding an `ANTHROPIC_API_KEY`.

## Commands

- `bun run build` — CLI and macOS bridge bundles. `bun run dev` — development mode.
- `bun run test` — full suite. `bun run test:safe` — same, guarded against touching the real config.
- `bun run typecheck`, `bun run lint`, `bun run format`
- `claudish --probe <model>` shows the adapter composition; `--debug` writes a log to `logs/`.
- Model syntax is `provider@model[:concurrency]` (`google@gemini-2.0-flash`, `ollama@llama3.2:3`); a bare name auto-routes by pattern. Prefix meanings: `routing.md`.

## Commit messages

**The subject line is the release note.** `git cliff` copies it verbatim into `CHANGELOG.md`
and the GitHub Release (`cliff.toml`), and `claudish update` shows that text to users under
"What's New" (`update-command.ts`). Write it for a user scanning a list of changes. The same
rule covers PR titles and tag messages.

**Subject: `type(scope): verb object [condition]`**, at most 72 characters.

- `type` picks the changelog section: `feat` new capability, `fix` defect repaired, `perf`,
  `refactor` (no behaviour change), `docs`, `test`, `chore`. `chore: bump version` is skipped.
  Add `!` and a `BREAKING CHANGE:` footer when users lose something they relied on.
- `scope` is the component or provider: `picker`, `probe`, `routing`, `catalog`, `discovery`,
  `effort`, `errors`, `adapters`, `mcp`, `team`, `release`, or a provider name (`devin`,
  `ollama`). Required on `feat` and `fix`.
- Imperative verb, lowercase: add, remove, fix, send, resolve, read, reject, map, show, hide.
- Name the concrete thing: the function, flag, field, endpoint, provider, model id or HTTP status.
  A `fix` states the defect's symptom or condition.
- One change per commit. A subject that needs "and" is two commits.

**Never write:** metaphor or personification ("lowest rung", "off switch", "tearing its own
rows", "ask Devin", "in Devin's own spelling"); a principle instead of a change ("a model is
offered when something says it works"); grab bags ("and three release-review findings",
"misc fixes", "address review"); words that need the body to decode ("properly", "correctly",
"handle", "improve", "clean up").

**Body**, wrapped at 72, plain paragraphs in this order, each only when it applies: the problem
as observed (exact error text, status code, measured numbers); the cause (file and function);
what the code does now; the verification (the test that fails without the fix, or the live
measurement). The thesaurus applies. No narrative or rhetorical framing.

| Was (v10.1.1) | Write |
|---|---|
| ask Devin about swe-1.7 in Devin's own spelling | `fix(devin): route bare swe-1.7-style names to Devin, not OpenRouter` |
| minimal effort is the lowest rung, not the off switch | `fix(effort): map minimal to the lowest advertised effort level` |
| a model is offered when something says it works, never when nothing does | `fix(discovery): list only models with published chat capability` |
| show the provider's own error, not claudish's guess about it | `fix(probe): show the provider's error message instead of a derived hint` |
| stop the probe tearing its own rows, and drop a hop no key can satisfy | `fix(probe): suppress stderr log lines while the probe TUI is drawn` + `fix(routing): remove the qwen route binding that has no endpoint` |
| ask an older Ollama daemon for capabilities it lists only in /api/show | `fix(ollama): use the /api/show capability fallback in picker discovery` |
| keep what a provider says about its own models, and three release-review findings | `fix(picker): pass provider-reported capability to the chat filter`, plus one commit per finding |

## Releasing

**CI/CD publishes — do NOT run `npm publish`.** `release.yml` fires on the `v*` tag push,
generates `CHANGELOG.md` with `git cliff`, and publishes over OIDC. It runs NO test suite, so
the tag is the gate: everything must be green before it leaves the machine.

Bump TWO files by hand — `package.json` and `packages/cli/package.json` (what npm publishes;
a stale value fails the publish) — then run
`bun run --cwd packages/cli scripts/generate-version.ts`. `packages/cli/src/version.ts` is
GENERATED from `packages/cli/package.json` and says so in its header; editing it by hand is
silently overwritten by the next `build`.

**Never `git push --tags`.** Local `v7.8.2` diverges from origin's, so `--tags` exits
non-zero on every release — after the new tag has already landed. It reports failure over
success, which is the one outcome an automated release cannot recover from. Push the
explicit ref, which touches nothing else:

```
git tag -a v9.2.0 -F <message-file> <merge-sha>   # -F, not -m: backticks in -m are command substitution
git push origin refs/tags/v9.2.0
```

Re-check `git ls-remote --tags origin refs/tags/vX.Y.Z` IMMEDIATELY before tagging, not once
at preflight — a concurrent release burns the number in that gap, and the losing rebase
silently drops the now-empty bump commit.

**From a worktree** you cannot `git checkout main` (the primary checkout holds it). Open a PR
and merge it, or `git push origin HEAD:main` after `git rebase origin/main`. Either way, tag
the MERGE COMMIT, never the branch head CI did not validate. After any rebase merge, verify
`git show origin/main:packages/cli/package.json | grep version` really carries your bump.

## Session artifacts

`ai-docs/` is TRACKED; `ai-docs/sessions/{task-slug}-{YYYYMMDD-HHMMSS}-{hash}/` is GITIGNORED and
does not survive a fresh clone or `git worktree remove`. Work there — scratch notes, raw runs,
probe scripts — rather than `/tmp`, but put anything meant to outlive the session somewhere
tracked: `ai-docs/reports/` for findings, `ai-docs/benches/` for evals, `ai-docs/architecture/`
for rationale. Three write-ups already died this way.

## Learned Preferences

### Tools & Commands
<!-- learned: 2026-03-28 session: 03cd7cc5 source: repeated_pattern -->
- Use `bun` for all package management and scripts (`bun run build`, `bun test`, etc.) — not npm or yarn
<!-- learned: 2026-04-06 session: df311293 source: repeated_pattern -->
<!-- revised: 2026-07-26 — root cause was a missing Ollama embedding model, not mnemex itself -->
- Prefer mnemex AST lookups over grep for symbol/caller questions: `mnemex --agent symbol|callers|callees "Name"`
- Semantic search is `mnemex --agent search "concept"` — NOT `map`, which ignores its argument entirely and always dumps the same PageRank overview
- `search` needs Ollama serving `nomic-embed-text` — without it embeddings are zero-length, so search is useless and `status` panics with a lance divide-by-zero. Fix: `ollama pull nomic-embed-text` → `rm -rf .mnemex/vectors` → `mnemex index`

### Workflow
<!-- learned: 2026-04-06 session: df311293 source: explicit_rule -->
- Don't run claudish directly in main bash — use dedicated channel sessions or `/delegate`
<!-- learned: 2026-09-02 source: near_miss -->
- NEVER `git stash` from a worktree. The stash stack is shared with the main checkout and
  every sibling worktree, and concurrent sessions push and pop it. A bare push/pop pair is
  not symmetric: another session can push between yours, so your `pop` takes THEIR work and
  buries yours where nobody is looking. Both trees then look plausible and neither errors.
  Set work aside with a temporary WIP commit, or copy the file out and back. To revert a
  file for a mutation test, copy it — do not use git.
- Deep rationale goes in `ai-docs/architecture/`, not here. Add it there and name the trigger in the list above.
