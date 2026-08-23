# Claudish - Development Notes

Planned-but-unimplemented work — the SEP-1686 channel migration, optional `notifications/progress` for terminal UI, the Anthropic plugin allowlist — lives in `ROADMAP.md`, each item with an explicit trigger condition.

**This file is the decision layer: what an agent must know *before* acting.** Detail is deferred, not deleted — each pointer below leads to the full text:

| Topic | Full reference |
|---|---|
| Routing syntax, provider shortcuts, `defaultProvider`, custom endpoints, vendor prefixes, local models | `docs/settings-reference.md` (§5–§7.5, §9, §12) |
| Three-layer adapter architecture (class-name Rosetta stone, per-layer detail) | `docs/three-layer-architecture.md` |
| `stream:false`, inline system messages, body capture, debug logging, translation-debugging workflow | `docs/reference/proxy-pipeline-notes.md` |
| Web search interception paths, SearXNG/MCP fallback chains, components | `docs/reference/web-search-interception.md` |
| Relay internals (header build, prober, compression, outage reconciliation) | `docs/reference/relay-internals.md` |
| Budget failover: cascade walk, notice channels, per-step backoff, Qwen/GLM thinking measurements | `docs/reference/budget-failover.md` · `.env.sidecar.example` |
| OpenAI-compatible ingress (`/v1/chat/completions`) request/response translation | `docs/reference/openai-ingress.md` |
| Traffic scripts, capture format, leak diagnostics | `docs/reference/traffic-analysis.md` |
| Channel wire format, client gating, tracing | `docs/reference/channel-mode.md` |
| Sidecar deployment runbook | `docs/deployment/relay-sidecar-deployment.md` |

## Build, Release, Versioning

- `bun run build` (CLI + macOS bridge bundles) · `bun run dev`. Use **bun**, never npm or yarn.
- **Releases are handled by CI/CD — never run `npm publish` by hand.** Bump version → conventional commit → `git tag -a vX.Y.Z -m "…"` → `git push origin main --tags`.
- **A version bump touches three files, all mandatory**: root `package.json`; `packages/cli/package.json` (**this is what CI publishes — stale here and `npm publish` fails**); `packages/cli/src/version.ts` (fallback `VERSION`, so compiled binaries with no package.json still report correctly).

## Model Routing (v4.0+)

Syntax `provider@model[:concurrency]` — `google@gemini-2.0-flash`, `or@deepseek/deepseek-r1`, `ollama@llama3.2:3`. Bare names auto-detect (`gpt-4o` → OpenAI, `gemini-*` → Google). Shortcuts (`g@ oai@ or@ openrouter@ mm@ mmax@ mmc@ kimi@ moon@ glm@ zhipu@ gc@ llama@ ll@ litellm@ ollama@ lmstudio@` + aliases) plus any custom-endpoint name: full table in `docs/settings-reference.md` §5.2 — except **`cx@` / `codex@` → OpenAI Codex (Responses API), which that table does not list**; this file is its only record.

Gotchas:

- **`defaultProvider` is a last-resort fallback, not a front-of-line override.** It is appended to the *end* of each bare-name chain (deduped — `or` ≡ `openrouter`) and only catches models whose chain has zero credentialed providers. Explicit `provider@model` is never affected. Precedence: `--default-provider` > `CLAUDISH_DEFAULT_PROVIDER` > config `defaultProvider` > `OPENROUTER_API_KEY` present > hardcoded `openrouter`.
- **LiteLLM auto-promotion was removed** (commit 5 of the model-catalog/routing redesign; see `default-provider.ts`). `LITELLM_BASE_URL` + `LITELLM_API_KEY` no longer makes LiteLLM the default — set `defaultProvider: "litellm"` explicitly. ⚠ `docs/settings-reference.md` §6.1/§6.3 still documents the legacy promotion; that text is **stale — trust the code**.
- **Vendor prefix resolution is exact-match only** — find the right prefix, never guess the model. Dynamic provider catalogs are PRIMARY; `OPENROUTER_VENDOR_MAP` is a cold-start fallback only. Resolution happens in `proxy-server.ts` **before** handler construction, through the sync `resolveModelNameSync()` (in-memory caches + `readFileSync` — do not make it async).
- **Custom endpoints**: `apiKey` expands `${VAR_NAME}` from the environment (never hardcode secrets); entries failing Zod validation **emit a stderr warning and are skipped — they must never crash the proxy**. Endpoints inject themselves through `registerRuntimeProvider()` / `registerRuntimeProfile()` (`providers/custom-endpoints-loader.ts`); the full `customEndpoints` schema (`modelPrefix`, `CLAUDISH_CONFIG_DIR`, per-endpoint key vars) is in `docs/settings-reference.md` §7.
- **`omitReasoningContent`** (custom endpoints, default `false`) drops `reasoning_content` from outbound assistant messages, for backends that validate their body strictly. It is needed because the OpenAI converter emits that field whenever history holds a thinking block — **independent of any opt-in**, since the consumers disagree: DeepSeek *requires* it echoed back, Kimi K2.5 needs it from turn 2, GLM ignores it. Mistral answers `HTTP 422 extra_forbidden` and fails **every** turn of a thinking-mode session. ComposedHandler's thinking-block strip cannot reach it: on the OpenAI wire that strip is a **structural no-op** (it runs after `convertMessages`, by which point content is flattened and reasoning hoisted to a sibling scalar) — hence a separate `stripReasoningContent()` in `openai-messages.ts`. Incident of 2026-08-20 and the measurement that Mistral's `zai-glm-5-2` emits no traces at all: `docs/reference/proxy-pipeline-notes.md`.
- **Local model APIs report `prompt_tokens` as the FULL conversation context each request**, not a delta. `writeTokenFile` therefore assigns (`=`) input tokens rather than accumulating (`+=`).

Adding an aggregator resolver: implement `ModelCatalogResolver` in `providers/catalog-resolvers/`, register in `model-catalog-resolver.ts` — proxy-server and provider-resolver need no changes. The hosted slim catalog's `aggregators[]` field — entries of `{ provider, externalId, confidence }` — is a typed multi-provider routing index, consumed read-only; extraction, recommendations and portal live in [models-index](https://github.com/MadAppGang/models-index). Design notes: `ai-docs/sessions/dev-arch-20260305-104836-a48a463d/architecture.md`.

## Adapter Pipeline (v5.14.0+)

`ComposedHandler = FormatConverter (explicit adapter) + ModelTranslator (auto-selected by model id) + ProviderTransport`

- **L1 FormatConverter** (`adapters/api-format.ts`) — wire format: OpenAI, AnthropicPassthrough, Gemini, Codex, OllamaCloud, LiteLLM. Message/tool conversion in `handlers/shared/format/openai-messages.ts`, `openai-tools.ts`.
- **L2 ModelTranslator** (`adapters/model-dialect.ts`) — model dialect (context windows, thinking→reasoning_effort, vision rules): GLM, Grok, MiniMax, DeepSeek, Qwen, Codex.
- **L3 ProviderTransport** (`providers/transport/types.ts`) — auth, endpoints, headers, rate limits; aggregators (LiteLLM, OpenRouter) may override the stream format to `openai-sse`.

**Stream parser selection — 3-tier priority, in this order:**

```typescript
transport.overrideStreamFormat() ?? modelAdapter.getStreamFormat() ?? providerAdapter.getStreamFormat()
```

Parsers in `handlers/shared/stream-parsers/`: `openai-sse` (most providers), `anthropic-sse` (MiniMax/Kimi direct), `gemini-sse`, `ollama-jsonl`, `openai-responses-sse` (Codex).

- **Add a provider**: one entry in `PROVIDER_PROFILES` (`providers/provider-profiles.ts`).
- **Add a model**: a ModelTranslator adapter, registered in `adapters/dialect-manager.ts`.
- **Verify wiring**: `claudish --probe <model>` prints the full composition.

## Never-Hang Constraints (non-negotiable)

The proxy sits inside an agentic loop: whatever stalls a turn stalls the agent.

- **`stream: false` must return a single JSON `message`, never SSE.** `/compact` is the real-world caller; SSE back to it surfaces as `"API returned an empty or malformed response (HTTP 200)"`, the session can no longer condense, and it eventually overflows and stalls. `ComposedHandler.handle()` buffers the already-translated SSE via `collectAnthropicSseToMessage()`. The trigger is exactly `payload?.stream === true` (mirrors `request-logger.ts`); anything else buffers to JSON. The collector **never throws** — a broken or empty stream degrades to a well-formed message with an empty text block.
- **A failed web search/fetch must never stop the agent** — every backend path degrades to well-formed text. No throws, no hung streams.
- **Never gzip the SSE response** — gzip buffering risks a hang. Request body only, WAN only.
- **The failover notice never throws** — a thrown error would turn a working condensation into a failed one.
- **Strip inline `role: "system"` messages** (Claude Code v2.1.153+ injects them, e.g. system-reminders) and merge into the top-level `system` field — for `anthropic-sse` in `composed-handler.ts` and for the OpenAI path in `openai-messages.ts`. Z.AI, MiniMax and Kimi reject anything but `user`/`assistant`.

## Web Search Interception (v7.1+)

Provider web-search tool calls (`web_search`, `brave_web_search`, `tavily_search`) and GLM `<searchWeb>` tags are intercepted, never forwarded (they would fail on non-Anthropic providers).

**The decision that matters**: if the client declared a `WebSearch` tool, **remap** the call to a synthetic `WebSearch` tool_use block with `stop_reason: "tool_use"`, so Claude Code runs its own search and the loop continues. Only when WebSearch is *not* declared (sub-agents without web tools) do we suppress and inject results as a text block with `end_turn`. Suppress-and-inject in the declared case ends the assistant turn on raw search results and **stalls the agent** — the CoursIA incident, 2026-06-10. Regression: `format-translation.test.ts` ("web search remap").

Backends, first usable result wins: MCP `searxng_web_search` (`SEARXNG_MCP_URL`, 5s) → direct HTTP `{SEARXNG_URL}/search?format=json` (3s) → error text; fetch adds an `r.jina.ai` retry for bot-hostile hosts and a 500KB cap. Every call races a deadline. **Basic-auth credentials belong in the `SEARXNG_URL` userinfo** (`https://user:pass@host`, standard curl form): `searxngConfig()` parses them into an `Authorization: Basic` header and strips them from the logged base URL. `search.myia.io` sits behind IIS Basic Auth since 2026-08-19, so credential-less WAN clients get 401; LAN deployments reach the backend directly and send no header. `MCP_AUTH` / `SEARXNG_MCP_TOKEN` are provisioned via RooSync — never hardcode. When `SEARXNG_MCP_URL` is unset the MCP layer is skipped entirely (zero behavior change). Detail: `docs/reference/web-search-interception.md`.

## Relay / Sidecar Mode (v7.2+)

One binary, three modes, selected by `CLAUDISH_RELAY_UPSTREAM`. Each machine runs its own container so the hub stops being a single point of failure.

| `CLAUDISH_RELAY_UPSTREAM` | Mode | Behavior |
| --- | --- | --- |
| **unset** | **HUB** (po-2023) | Always local. Zero change vs. before. |
| set + hub **alive** | **NOMINAL relay** | Forwards the raw request to the hub; response repiped through the never-hang passthrough. **No local capture** (hub captures centrally). |
| set + hub **dead** (hysteresis) | **AUTONOMOUS** | Falls through to the normal local pipeline + local capture. |

Gotchas:

- **The cluster key is injected as `x-proxy-key`, NOT `x-api-key`**, and the client `authorization` is kept. `x-api-key` arms `NativeHandler`'s proxyKey→Anthropic swap, which strips auth → **401**. `X-Claudish-Machine` must survive the hop or central attribution is lost.
- **Hysteresis is asymmetric on purpose**: 2 consecutive `/health` failures → AUTONOMOUS (fast failover); recovery needs 3 OK heartbeats **+ 60s cooldown + a deep tool-call probe** (`glm-5.3` — the current sonnet nominal — must reach `message_stop`). Anti-flap.
- **`CLAUDISH_NO_ANTHROPIC=1` on every machine except ai-01** — reroutes bare native targets to the budget `modelMap.sonnet` instead of `api.anthropic.com`. Defense in depth, not the primary policy.
- **`CLAUDISH_HOST_PORT` is load-bearing, not cosmetic**: port 3000 is already taken on some hosts (ai-01), so a hardcoded binding makes `docker compose up` fail outright. The container side always stays 3000.
- **Two capture variables, one letter apart in meaning and deliberately not in spelling**: `CLAUDISH_CAPTURE_HOST_DIR` (host bind path) vs `CLAUDISH_CAPTURE_DIR` (in-container path, **empty = write nothing**). Keep capture **on** for sidecars: NOMINAL writes nothing, so any file that appears IS an AUTONOMOUS-mode outage capture — the trail `reconcile-outage-captures.ps1` needs. Disabling it is a disk-starvation escape hatch that silently destroys that trail.
- **The relay branch must stay before `interceptWebTools` / `getHandlerForRequest` / `logRequest`** in the `/v1/messages` route — that ordering is what makes capture mode-aware for free.

Tests: `relay.test.ts` (16 — hysteresis, header build incl. ai-01 Opus passthrough, gzip, never-hang delegation). Budget-free E2E: `bun run packages/cli/src/fork/server/relay-e2e.ts` (~2-3 min). Internals: `docs/reference/relay-internals.md`. Fleet install: `scripts/install-sidecar.ps1` + `docs/deployment/relay-sidecar-deployment.md`.

## Budget Failover (v7.2+)

Substitutes the *model itself* for a whole **role** (`opus`/`sonnet`/`haiku`) when that role's metered plan is exhausted — a subscription concern, distinct from `FallbackHandler`, which swaps *providers* for the same model (a transport concern). They compose. Every substitution is **announced**, because silent degradation leaves the agent assuming capabilities it lost (or missing ones it gained).

**Three notice moments, two channels**, centralized in `applyFailoverNotices` so `ComposedHandler` *and* `NativeHandler` are covered: at **condensation** (appended to the `/compact` message — the one moment context is rebuilt anyway — naming the currently-resolved step and its depth); at the **moment of failover** (prepended as stream content block 0, every real block's `index` shifted `+1`, re-fired when the resolved step changes mid-session); and on **recovery** (symmetric, so the model recalibrates after the nominal returns). None of the three may throw — a missing notice beats a broken stream, and a thrown error would turn a working condensation into a failed one.

> ⚠ **The recovery notice is currently worded as a behavioral instruction** — it tells the agent to "resume your normal capability and **risk appetite**" and to "clean up any over-conservative decisions made under the substitute" (`failover.ts`). Arriving unexplained in content block 0, that is indistinguishable from a prompt injection: it was reported as one on 2026-08-23 by a fleet agent whose security reflex fired correctly, before being traced back to our own code. Keep such notices **factual** (which role, which model, which direction); state capability or scope, never risk posture, and never ask an agent to undo decisions it already made.

**A role's failover is an ordered list of steps, not a single target.** `CLAUDISH_FAILOVER_<ROLE>` is `>`-separated: step 0 serves when the nominal walls, step 1 when step 0 *also* walls, and so on; the last step is typically PAYG, which has no weekly wall. Opus→GLM is not a special route — it is Opus→Qwen with Qwen also dead, falling through to Qwen's own successor. GLM is a **rolling ~5h window** (it dies *and* restarts every 5h, unlike Qwen's consumable weekly pool), so PAYG naturally fills GLM's holes with no extra routing.

Env, read at proxy startup (canonical annotated template: `.env.sidecar.example`): `CLAUDISH_FAILOVER_<ROLE>` (the `>`-separated cascade), `..._LABEL`, `..._DIRECTION` (`degraded` default · `improved` · `lateral`), `..._NOTE`, `..._RESET` (operator-declared wall-lift per step, ISO 8601), `CLAUDISH_FAILOVER_ROLE_MODELS` (aliases so clients naming the nominal model directly still get cascade protection), `CLAUDISH_FAILOVER_ACTIVE`, `CLAUDISH_FAILOVER_AUTO`. All `>`-separated fields are position-preserving against the step list.

- **With nothing set every code path is inert.** Configuring a target does **not** activate it — arming is separate and deliberate.
- **Unset `_DIRECTION` means degraded** — never flatter the substitute.
- **`isQuotaExhaustion` is deliberately narrower than `FallbackHandler.isRetryableError`**: 402 arms on status alone; 429 arms *only* when the body names a quota/credit/balance/weekly/plan wall — a per-minute burst must not burn the weekly switch. **401 and 404 never arm**: those are wiring mistakes, and swapping the model would hide a bad key or bad model id behind a plausible-looking answer.
- **`resolveFailoverTarget(role)` is the single resolution path** — used by both the swap in `getHandlerForRequest` and the `handleWithCascade` loop. The loop never passes an override target in; it mutates failover state and the next iteration re-reads. No double resolution.
- **`handleWithCascade` is bounded, never `while(true)`**: nominal → step 0 → step 1 → …, capped at `steps.length + 1` attempts. The **c-reuse invariant** is load-bearing — a handler must not mutate the Hono `Context` before returning a non-ok `Response`, or re-calling `handler.handle()` across iterations breaks.
- **Per-step backoff `[10m, 30m, 1h, 4h, 24h]`, and a known reset time overrides it entirely.** Re-probing a 24h-capped cycle against an 11-day wall is pure waste, so `..._RESET` (or a date parsed from the body — Qwen names its reset, MiniMax counts down) holds the step skipped until that instant, then makes it probeable the moment it passes. **`stepFailures` survives the role-arm TTL cycle**: without that, the 10-min nominal re-probe would re-probe a weekly-walled step every 10 minutes, defeating the backoff. It IS cleared for the whole role when the *nominal* recovers — a healthy nominal means a fresh episode.
- **A failover target must resolve on the machine that calls the models.** Pointing a sidecar at a custom endpoint defined only in the hub's `config.json` configures a fallback that fails exactly when it is needed. The hub is the normal home; on a sidecar these matter only in AUTONOMOUS mode.

### `CLAUDISH_QWEN_THINKING`

`disabled` (default) · `passthrough` · `budget:<n>`. **Unset is not neutral** — Qwen reasons by default, so unset means "think, at length", and the Token Plan bills on **output**. Re-read on **every request**, deliberately: the fleet flips this during a budget crunch, and a cached value would require restarting the proxy that is at that moment keeping everyone working.

**Two switches on two wires, and each endpoint ignores the other's form**: the OpenAI-compatible endpoint takes `enable_thinking` + `thinking_budget`, the Anthropic-compatible one takes the native `thinking` object. `QwenModelDialect.prepareRequest` branches on `ctx.wireFormat`; converting unconditionally (the old behavior) **deleted the only switch that works** on the Anthropic wire. Post-deploy check: on prompt `"Reponds exactement: ok"`, `input_tokens` dropping 67 → 31 proves the native switch reached Qwen. Full measurements: `docs/reference/budget-failover.md`.

### `CLAUDISH_GLM_THINKING`

`passthrough` (default) · `disabled`. GLM's switch is **binary** on the OpenAI wire (`thinking: {"type":"enabled"|"disabled"}`) — no budget control, unlike Qwen. Re-read on every request, same crunch-flip rationale.

**GLM thought by default and had no off switch at all**: `GLMModelDialect` deleted `thinking` unconditionally (a GLM-4.x-era artifact) and the OpenAI `buildPayload` never emitted the field either, so the client's ask was inert in both directions. Probed 2026-08-20 against the `gc@` Coding Plan (`glm-5.3`, prompt `"Reponds exactement: ok"`): field absent → 37 output tokens / 131 reasoning chars; `{"type":"disabled"}` → **3 tokens, 0 reasoning**; `budget_tokens` tolerated and **ignored**. `passthrough` preserves today's effective behavior; the `zai@` anthropic wire is unprobed, so only an explicit `disabled` sets the field there.

## OpenAI-Compatible Ingress (v7.2+)

`/v1/messages` is the **native** ingress; `POST /v1/chat/completions` is a **translated** one — converted to Anthropic shape, run through the **same** `getHandlerForRequest` → `ComposedHandler.handle` pipeline, then translated back. An OpenAI client (sk-agent, any `AsyncOpenAI` consumer) therefore inherits the routing cascade, budget failover, accounting and leak policy for free, by changing `base_url` alone.

- **Never-hang holds here too**: a malformed stream degrades to a single terminal chunk + `data: [DONE]`. `thinking` blocks surface as `reasoning_content`; `stop_reason` maps to `finish_reason`.
- **The relay is path-aware** — a sidecar forwards to the *same* route the client hit, so an OpenAI request reaches the hub's `/v1/chat/completions` in NOMINAL mode and the resilience model is preserved. The deep liveness probe stays on `/v1/messages`.
- Out of scope for now: `/v1/models` discovery, OpenAI web-search interception, per-role thinking policy on this path. Detail: `docs/reference/openai-ingress.md`.

## Traffic Analysis & Anthropic Policy

**Use the scripts, not hand-rolled grep.** The proxy log format produces false positives when grepped naively (`bytes=NNNN` matching error codes, timestamp digits matching `429`, `[msg:N]` body previews matching keywords — memory `proxy-log-monitoring`). The scripts encode the precise filters.

| Script | Use |
|---|---|
| `traffic-live.ps1` | live, from `docker logs` — fast; what the 6h surveillance cron runs |
| `traffic-summary.ps1` · `traffic-sessions.ps1` | rich detail (workspace, session, CC version, tokens) from `req-*.json` captures |
| `traffic-anthropic.ps1` | **"where is the Anthropic traffic coming from?"** — attributes each request by machine **and workspace** |
| `traffic-history.ps1` | past days, from `captures-*.7z` archives |
| `harness-injection-measure.py` | **"what does the harness actually cost in context?"** — pairs `req-*`/`resp-*` captures by `(pid, reqN)` and reports **characters injected per token** (~2,15); six documented traps, each of which yields a wrong-but-plausible number |
| `compress-captures.ps1` · `claudish-watchdog.ps1` | nightly 7z compaction + GDrive backup (02:47 — moved off 04:17 on 2026-08-20: the 60-70 min run collided with the 04:00 container restart) · health check, proactive restart, hang recovery (15 min) |

- **`traffic-live.ps1 -Container` defaults to `claudish-proxy` (the hub name).** On a sidecar machine you MUST pass `-Container claudish-sidecar`, or the script exits 1 with `No such container`.
- **On a NOMINAL sidecar, ~0 requests is the correct answer, not a broken script**: a relayed request writes no capture and emits no `[Request]` line, so local traffic analysis is blind there by construction.
- **Policy: Anthropic-billed models (Opus, Fable, Sonnet) must come from `myia-ai-01` only.** Verdicts: `[OK]` ai-01 · `[REVIEW]` po-2025, which may run an authorized Safari/agent-sdk workflow — **confirm with the user before calling it a leak** (2026-06-21: six false WARNs were raised by skipping that step) · `[LEAK]` any other machine.
- **`cc_is_subagent=true` is the leak signature, and it lives in the request body, not stdout** — `docker logs` alone cannot see it; inspect a capture. The `[LEAK-SUBAGENT]` (rogue Opus sub-agent, exit 1) vs `[REVIEW-INTERACTIVE]` (user driving their own session, exit 0) split is what stops the tool crying wolf on legitimate dev sessions.
- **A confirmed sub-agent leak is fixed client-side** — a `~/.claude/rules/` rule pinning `model: "sonnet"` on spawns, reserving Opus for genuinely complex tasks. Not fixable in the proxy.

Capture format, archive/GDrive retention, device-id attribution, exact commands: `docs/reference/traffic-analysis.md`.

## Channel Mode (MCP, v6.4.0+)

Async model sessions with push notifications, built on the low-level `Server` class declaring `experimental: { 'claude/channel': {} }`. 11 tools, gated by `CLAUDISH_MCP_TOOLS` (`all` default · `low-level` · `agentic` · `channel`). The wire contract is pinned by `channel-wire-format.test.ts`.

- **`meta` keys must match `[a-zA-Z0-9_]+`** — Claude Code **silently drops** keys with hyphens or other characters. Keep new `extraMeta` keys underscore-only.
- **Emitting a correct frame is not enough.** Rendering is gated client-side: CC ≥ v2.1.80; Anthropic auth via claude.ai or Console key (not Bedrock/Vertex/Foundry); an **interactive** session (in `-p` mode registration never runs and frames are silently dropped); the server declared in `.mcp.json` / `~/.claude.json` (**`--mcp-config` is not consulted by the channel resolver**); and the server **named in `--channels`** or `--dangerously-load-development-channels`.
- `CLAUDISH_CHANNEL_TRACE=1` (+ `CLAUDISH_CHANNEL_TRACE_FILE` when the host swallows stderr) traces producer → bridge → wire, so a server-side drop is distinguishable from client-side gating. Off by default, zero production overhead.

Full contract, launch commands, diagnostic scripts: `docs/reference/channel-mode.md`. Tests: `bun test --cwd . ./packages/cli/src/channel/*.test.ts` (65 across 5 files).

## Debugging & Tests

Failed-translation workflow: `claudish --model X --debug "say hello"` → `claudish --probe X` (verify the composition) → `/debug-logs logs/claudish_*.log` (diagnoses the failure mode, extracts SSE fixtures, writes a regression test) → `bun test packages/cli/src/format-translation.test.ts`. Manual extraction: `bun run packages/cli/src/test-fixtures/extract-sse-from-log.ts logs/claudish_*.log`.

**Keep debug logs verbose** — empty chunks and raw deltas included; that is what makes real model streaming behavior legible. Suppress noise at the registration/initialization level (e.g. conditional middleware), **never at the streaming-data level**. Under `--debug` both parsers emit greppable `[SSE:openai]` / `[SSE:anthropic]` lines, which become test fixtures.

`format-translation.test.ts` replays `.sse` fixtures from `test-fixtures/sse-responses/` through the stream parser. Helpers: `parseClaudeSseStream()`, `extractText()`, `extractToolNames()`, `extractStopReason()`, `fixtureToResponse()`. Add regressions as a `describe("Regression: <model>")` block (template at the bottom of the file).

Detail: `docs/reference/proxy-pipeline-notes.md`.

## Learned Preferences

### Tools & Commands
<!-- learned: 2026-03-28 session: 03cd7cc5 source: repeated_pattern -->
- Use `bun` for all package management and scripts (`bun run build`, `bun test`, etc.) — not npm or yarn
<!-- learned: 2026-04-06 session: df311293 source: repeated_pattern -->
- Use Grep/grep tool for code investigation instead of mnemex — prefer built-in search tools during investigation phases

### Workflow
<!-- learned: 2026-04-06 session: df311293 source: explicit_rule -->
- Don't run claudish directly in main bash — use dedicated channel sessions or `/delegate`
