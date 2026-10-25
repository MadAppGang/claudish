# Claudish - Development Notes

Planned-but-unimplemented work — the SEP-1686 channel migration, optional `notifications/progress` for terminal UI, the Anthropic plugin allowlist — lives in `ROADMAP.md`, each item with an explicit trigger condition.

**This file is the decision layer: what an agent must know *before* acting.** Detail is deferred, not deleted — each pointer below leads to the full text:

| Topic | Full reference |
|---|---|
| Routing syntax, provider shortcuts, `defaultProvider`, custom endpoints, vendor prefixes, local models | `docs/settings-reference.md` (§5–§7.5, §9, §12) |
| Scoped inbound keys (`inboundKeys` — external consumers, allowlist-only access, per-key capture attribution) | `docs/settings-reference.md` §7.6 |
| Three-layer adapter architecture (class-name Rosetta stone, per-layer detail) | `docs/three-layer-architecture.md` |
| `stream:false`, inline system messages, body capture, debug logging, translation-debugging workflow | `docs/reference/proxy-pipeline-notes.md` |
| Web search interception paths, SearXNG/MCP fallback chains, components | `docs/reference/web-search-interception.md` |
| Relay internals (header build, prober, compression, outage reconciliation) | `docs/reference/relay-internals.md` |
| Budget failover: cascade walk, notice channels, per-step backoff, Qwen/GLM thinking measurements | `docs/reference/budget-failover.md` · `.env.sidecar.example` |
| Negotiated capability vocabulary (#83 — wired: lift at `/v1/messages` entry + query at the condensation rail, gate `CLAUDISH_CAPABILITY_VOCAB` default off, ask cap `CLAUDISH_CAPABILITY_QUERY_MAX_ASKS` default 3) | `docs/reference/capability-vocabulary.md` |
| Signature-based role routing (#82 — proposition de design, non arbitrée, aucun code) | `docs/reference/signature-routing.md` · entry `ROADMAP.md` |
| OpenAI-compatible ingress (`/v1/chat/completions`) request/response translation | `docs/reference/openai-ingress.md` |
| Traffic scripts, capture format, leak diagnostics | `docs/reference/traffic-analysis.md` |
| Ops scripts runbook — watchdog, drained restart/recreate, docker lifecycle events, nightly compaction and the shared off-site archive namespace | `docs/reference/ops-scripts.md` |
| Channel wire format, client gating, tracing | `docs/reference/channel-mode.md` |
| Sidecar deployment runbook | `docs/deployment/relay-sidecar-deployment.md` |
| Model routing narratives (native pin #218, foreign-credential guard #296, MiniMax forced-thinking chain, input counters #179) | `docs/reference/model-routing.md` |
| Never-hang narratives (drain design and measurements, 1017-response corpus, instrument-filter calibration) | `docs/reference/never-hang.md` |
| `test:strict` full mechanics (#175 — entry keys, module-load deaths, bun double-count, classes 2/2b) | `docs/reference/test-strict.md` |

## Fleet-Rollout Verification (hard rule, mandate 2026-09-12)

**A fleet-affecting change declared DONE requires a measured per-consumer verification artifact, produced in the same session** — for every client: where it actually lands, read from the live config/path, not from the change's intent. "The container moved" is not "the fleet migrated". The 2026-09-05 cutover had this and passed — then the ARR flip was silently reverted on 07/09 15:37 (byte-identical restore of the pre-flip `web.config`), and no cycle caught it until the 11/09 hub outage exposed it: 2 779 requests / 263.6M tokens served by the po-203 local cascade (106M on PAYG), invisible to the hub. Consequences, now standing:

- **Surveillance covers the path, not just the traffic**: a cycle checking hub health also checks the entry points that feed it (ARR backend, per-machine base URLs) — a silent revert must be catchable within one cycle, not one outage.
- **An outage detected is an outage escalated — in the SAME cycle** (DM URGENT + dashboard). "Chronic" thresholds (#80-style counts) never apply to a total outage.
- **An issue treated halfway is an issue in failure**: no next grain until the current issue's DoD is met or the rescope is explicitly recorded.
- Rollback of a fleet change goes through the same channel as the change: an unlogged revert of shared infra (IIS web.config, .env, NAT) is an incident, not a fix.
- The hub's entry form is the published container port (`.50:3000`); any change to the fleet-facing entry point (ARR rule, forwarder port, socket owner, published port) is announced on the `global` dashboard BEFORE it is applied — engagement 2026-10-03, approved 2026-10-19 (the 07/09 silent ARR revert and the 30/09 orphan socket each cut part of the fleet undetected). Detail: `docs/reference/relay-internals.md` §Stable entry form (roo-extensions#3963).

## Build, Release, Versioning

- `bun run build` (CLI + macOS bridge bundles) · `bun run dev`. Use **bun**, never npm or yarn.
- **Releases are handled by CI/CD — never run `npm publish` by hand.** Bump version → conventional commit → `git tag -a vX.Y.Z -m "…"` → `git push origin main --tags`.
- **Every PR that resolves an issue carries `Closes #NN` in its body.** GitHub only auto-closes on merge when the keyword is present: a descriptive "Issue #79 asked for…" leaves the issue open with its fix already merged and live, and the registry drifts silently (measured 2026-09-12: #65/#79/#80 all in that state — three merged fixes, three orphaned issues).
- **A version bump touches three files, all mandatory**: root `package.json`; `packages/cli/package.json` (**this is what CI publishes — stale here and `npm publish` fails**); `packages/cli/src/version.ts` (fallback `VERSION`, so compiled binaries with no package.json still report correctly).

## Model Routing (v4.0+)

Syntax `provider@model[:concurrency]` — `google@gemini-2.0-flash`, `or@deepseek/deepseek-r1`, `ollama@llama3.2:3`. Bare names auto-detect (`gpt-4o` → OpenAI, `gemini-*` → Google). Shortcuts (`g@ oai@ cx@ or@ openrouter@ mm@ mmax@ mmc@ kimi@ moon@ glm@ zhipu@ gc@ llama@ ll@ litellm@ ollama@ lmstudio@` + aliases) plus any custom-endpoint name: full table in `docs/settings-reference.md` §5.2.

Rules (narratives, measurements and code pointers: `docs/reference/model-routing.md`):

- **A role's `modelMap` entry picks the LANE; since #218 it also pins the VERSION, but only on the native lane and only for `claude-*` targets** — applied by `resolveNativeModelPin()` inside `handleWithCascade`'s loop (the cascade re-resolves per attempt), never at the route. Kill switch `CLAUDISH_NATIVE_MODEL_PIN=0`, read per request. ⚠ The guard is `startsWith("claude-")`, NOT "is bare" — conflating the two would put a bare `glm-5.3` on the Anthropic wire. The hub holds no Anthropic credential, so `/v1/models` auto-resolution is impossible (#219).
- **The native lane refuses to forward a credential that is not Anthropic's (#296), strips the foreign sibling of a mixed pair (#305), and the vision fallback gates on the same shape predicate (#315)** — one predicate shared by all three sites; kill switch `CLAUDISH_NATIVE_FOREIGN_TOKEN_GUARD=0`. The refusal wording is load-bearing (`isQuotaExhaustion` must never match it); post-strip, hub-side header measurements are non-decisive by design. Shapes, instruments, measurements: `docs/reference/model-routing.md`.
- **`defaultProvider` is a last-resort fallback**, appended to the end of each bare-name chain (deduped — `or` ≡ `openrouter`); explicit `provider@model` is never affected; since #468 the proxy applies it too. Strict no-fallback needs `routing["*"] = []` **and** a present-empty `CLAUDISH_DEFAULT_PROVIDER` — **env form only** (a config `defaultProvider: ""` is dropped by the resolver's truthiness guard; absent ≠ empty either). Precedence: `--default-provider` > `CLAUDISH_DEFAULT_PROVIDER` > config `defaultProvider` > `OPENROUTER_API_KEY` present > hardcoded `openrouter`. LiteLLM auto-promotion was **removed** — `docs/settings-reference.md` §6.3.
- **Vendor prefix resolution is exact-match only** — find the right prefix, never guess the model. Dynamic provider catalogs are PRIMARY; a cold cache falls back to the disk cache (`~/.claudish/all-models.json`), then to **passthrough unchanged** (the static vendor-map fallback no longer exists). Resolution is sync (`resolveModelNameSync()` in `proxy-server.ts`, before handler construction — do not make it async). Paged catalog (#635 AC4): `data.nextCursor` followed under ONE deadline; `coverage` records what was fetched.
- **Custom endpoints**: `apiKey` expands `${VAR_NAME}` from the environment (never hardcode secrets); entries failing Zod validation emit a stderr warning and are skipped — they must never crash the proxy. Injection via `registerRuntimeProvider()` / `registerRuntimeProfile()`; full schema: `docs/settings-reference.md` §7.
- **`omitReasoningContent`** (custom endpoints, default `false`) drops `reasoning_content` from outbound assistant messages for strict-schema backends (Mistral answers `422 extra_forbidden`) — a separate `stripReasoningContent()`, because ComposedHandler's thinking-block strip is a structural no-op on the OpenAI wire. Per-provider disagreement: `docs/reference/model-routing.md`.
- **The MiniMax `forced` thinking chain has TWO filters (#295 outgoing, #324 incoming)** — `shouldFilterThinking()` returns false under `forced`; the history strip consults `preserveThinkingBlock(block)` per block (MiniMax keeps its own unsigned/64-hex blocks, strips the rest), deliberately NOT `preserveThinkingInHistory()`. Discriminant measurements: `docs/reference/model-routing.md`. Pins: `composed-handler-minimax-thinking.test.ts` + `minimax-model-dialect.test.ts`. **M3.1-Flash rejects `thinking.type:"disabled"` with 400/2013** — the dialect rewrites it to `adaptive` after the policy block, under every policy (client WebFetch one-shots and operator `disabled` alike); M3 keeps disabled. Detail: `docs/reference/model-routing.md`.
- **Local model APIs report `prompt_tokens` as the FULL conversation context each request** — `writeTokenFile` assigns (`=`) input tokens, never accumulates (`+=`).
- **The three input counters ship TOGETHER on every terminal `message_delta`, and a zero `input_tokens` is a trap (#179)**: since #444 ALL five stream parsers seed via `messageStartUsage(priorInputTokens)` and shape terminal deltas through `toAnthropicUsage` — a provider dialect maps at the parser call site, never inside the shared shaper; since #518 the seed is keyed **per session** (`extractSessionKey`), never read from the per-model handler's tracker — unknown/keyless → the first-turn constant. `splitPromptTokens()` clamps `prompt_tokens` to sum back (Claude Code sums the three raw); derivation, seed-0/NaN mechanism, `fullyCached` rule and pin: `docs/reference/model-routing.md`.

Adding an aggregator resolver: implement `ModelCatalogResolver` in `providers/catalog-resolvers/`, register in `model-catalog-resolver.ts` — proxy-server and provider-resolver need no changes. The hosted slim catalog's `aggregators[]` field is a typed multi-provider routing index, consumed read-only; extraction, recommendations and portal live in [models-index](https://github.com/MadAppGang/models-index).

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

The proxy sits inside an agentic loop: whatever stalls a turn stalls the agent. Rules below; measurement corpora, drain design and instrument-filter calibration: `docs/reference/never-hang.md`.

- **A restart is a stream killer, so the drain waits for a true zero first, then picks its moment** — `scripts/claudish-drain.ps1` (true-zero wait then adaptive stage, `$MaxWaitSec=600`; design and measurements: `docs/reference/never-hang.md`). **No scheduled daily restart is left on the fleet** (#280) — the watchdog's proactive restart (uptime ≥ 11 h, quiet window 03:00-06:00 local) is the single nightly restart source. A `$null` count means *no signal* → undrained restart, never an unbounded wait. **Invoking it**: only via `claudish-drain.ps1`, never a bare `docker restart`; deploying needs `-Recreate -EnvFile` (refused if it would gut an armed cascade, #141); agent callers run it `-Detach` and poll `drain.log` for `OUTCOME` — never inside a capped tool call (a killed caller left the hub down 16 min, 23/09).
- **The proxy itself never breaks a stream**: no `controller.error()` anywhere in production sources under `packages/cli/src` (test harnesses legitimately call it), and every terminating path emits `message_stop` — including `finalizeWithError` and the relay passthrough. A client-visible mid-response drop is never the stream logic; the socket died underneath it. ⚠ Checking the `controller.error()` half needs a filter that drops comments AND tests, and **before concluding from a count, run the same filter on the merge base** — a hit class that predates the change is not the change's.
- **`stream: false` must return a single JSON `message`, never SSE** (`/compact` is the real-world caller; SSE back to it wedges the session). `ComposedHandler.handle()` buffers via `collectAnthropicSseToMessage()`, triggered by exactly `payload?.stream === true`. The collector never throws — a broken or empty stream degrades to a well-formed message with an empty text block.
- **A failed web search/fetch must never stop the agent** — every backend path degrades to well-formed text. No throws, no hung streams.
- **Never gzip the SSE response** — gzip buffering risks a hang. Request body only, WAN only.
- **A stream admitted with 200 that never produces a first useful event is confined, not held**: `withFirstUsefulEventWatchdog` (wired in `ComposedHandler.handleStream`, all SSE formats, not ollama-jsonl) cancels the upstream after `CLAUDISH_FIRST_EVENT_TIMEOUT_MS` without a first `data:` line (default 300s, `0`=off, re-read per request). The window covers the FIRST useful event only — a `: keep-alive` comment or `event:` line is not one.
- **A retried stream needs its OWN watchdog — the original wrap has already disarmed.** `boundRetryUpstream()` (`first-event-watchdog.ts`) wraps the closure once in `handleStream`; non-ok/bodyless responses pass through untouched; `ollama-jsonl` is excluded (no `data:` lines). Corollary for any future recovery path: **a guard that disarms on a signal cannot protect what that same signal triggers.**
- **An upstream death before any client-visible event is recovered, not finalized (#170).** `anthropic-sse.ts` re-forwards both death shapes, gated by `!sawMessageStart && highestSeenIndex === -1 && !lastBlockOpen` — past any of those, a replacement stream would duplicate what the client holds. Bound `CLAUDISH_PREVISIBLE_REFORWARD_MAX` (default 2); no `markFail` — a re-forward is a recovery attempt, never a liveness measurement; it can bill twice, the bound keeps that cheap. Wrap and walk order: `docs/reference/never-hang.md`.
- **A policy refusal is retried, then surfaced labeled — never bare, never silent (#65).** Bounded transparent retry of the identical body (`[1000, 3000]ms`, max 2), fired only while nothing client-visible exists (`anthropic-sse` additionally requires no forwarded `message_start`). Persistent refusal becomes `[Upstream policy refusal — invalid_prompt: …]` + `end_turn` + `message_stop`. The classifier deliberately excludes transport errors, quota walls and rate limits — it can never divert a subscription wall away from `isQuotaExhaustion`.
- **A request larger than every DECLARED window is refused at admission, with numbers (#565)** — the census runs over the nominal + every cascade step's declared `contextLimit`, before any handler exists and in both ingresses; declared-only: a path with ANY undeclared candidate falls open — the nominal, every step, and a `role:` step's target path (its nominal + steps) are all weighed, and the declared subset never vetoes them (22/10: swift's 262 144 refused a haiku session's `/compact` while its undeclared nominal and PAYG terminator could serve); a native nominal is one such undeclared candidate. The answer is the #79 recoverable turn (200 + real `input_tokens`, so the client compacts), never a bare 400 — which would reproduce the `/compact` retry loop. Wording never matches `isQuotaExhaustion`. Kill switch `CLAUDISH_CONTEXT_ADMISSION=0`. Detail: `docs/reference/proxy-pipeline-notes.md`.
- **The failover notice never throws** — a thrown error would turn a working condensation into a failed one.
- **Strip inline `role: "system"` messages** (Claude Code v2.1.153+ injects them) and merge into the top-level `system` field — `anthropic-sse` in `composed-handler.ts` and the OpenAI path in `openai-messages.ts`. Z.AI, MiniMax and Kimi reject anything but `user`/`assistant`.

## Web Search Interception (v7.1+)

Provider web-search tool calls (`web_search`, `brave_web_search`, `tavily_search`) and GLM `<searchWeb>` tags are dispositioned **three ways** — a bare forward to a provider tool would fail on non-Anthropic providers, but a tool the client itself declared under that exact name is the client's to serve.

- **The decision that matters — three lanes, in order**: (1) client declared a web tool under the **provider's exact name** (`web_search`) → **forward verbatim** — `tool_use` under the client's own name, real contiguous `content_block_start` index (the sentinel `-1` follows `suppressWebSearch`, never the tool name — #498, the #484 class). (2) `WebSearch` declared, not the exact name → **remap** to a synthetic tool_use. (3) Nothing web-capable declared → suppress and inject as text + `end_turn`. The loop must never stall either way — suppress-and-inject on a declared tool stalls it (CoursIA, 2026-06-10); both names declared → lane 1; the `<searchWeb>` TAG path keeps lanes 2/3. Detail + regression pins: `docs/reference/web-search-interception.md`.
- **On the Z.AI wire, `server_tool_use` comes with two siblings** — whole-input `content_block_start` (zero `input_json_delta`) and an assistant-side `tool_result` after server-side execution, both suppressed (user-turn-only on the Anthropic wire); the following deltas/stops remap down or indices desync. Regression: `format-translation.test.ts` ("Chantier D").
- **Any frame the parser drops takes its `event:` line and blank separator with it (S4-a)**: `event:` lines are held until the data line is adjudicated, on both branches; the index-mapping layer (jumped starts, orphan delta/stop) also runs on both branches; an orphan delta/stop is dropped whole, never re-attached. Synthetic tails are built with `JSON.stringify`, preserve an upstream-reported `stop_reason`, and never emit a second terminal pair after a real `message_stop`. Pins: `anthropic-sse-s4a.test.ts`.

Backend fallback chain (MCP SearXNG → direct HTTP, 2 attempts in an 8s budget → error text), `r.jina.ai` retry, 500KB cap, latency logging, basic-auth userinfo placement: `docs/reference/web-search-interception.md`.

## Relay / Sidecar Mode (v7.2+)

One binary, three modes, selected by `CLAUDISH_RELAY_UPSTREAM`. Each machine runs its own container so the hub stops being a single point of failure.

| `CLAUDISH_RELAY_UPSTREAM` | Mode | Behavior |
| --- | --- | --- |
| **unset** | **HUB** (po-2025) | Always local. Zero change vs. before. |
| set + hub **alive** | **NOMINAL relay** | Forwards the raw request to the hub; response repiped through the never-hang passthrough. **No local capture** (hub captures centrally). |
| set + hub **dead** (hysteresis) | **AUTONOMOUS** | Falls through to the normal local pipeline + local capture. |

Gotchas (decision layer; internals, capture-reading rules and incident narratives: `docs/reference/relay-internals.md` + `docs/reference/ops-scripts.md`; install: `docs/deployment/relay-sidecar-deployment.md`):

- **The cluster key is injected as `x-proxy-key`, NOT `x-api-key`** (which arms `NativeHandler`'s swap and 401s); client `authorization` is kept; `X-Claudish-Machine` must survive the hop. The native lane strips `x-proxy-key` and every `x-claudish-*` header before api.anthropic.com (#282); the vision fallback is the third strip site (#289) with the shared shape gate (#315).
- **Loop topology is detected by identity, on two planes (#156/#279)**: `/health` publishes a per-process `instanceId` (heartbeat self-comparison), and every forward appends the sender's id to `x-claudish-hops` — a node finding its own id serves locally, never refuses. The hop append never touches auth headers.
- **Hysteresis is asymmetric on purpose**: 2 consecutive `/health` failures → AUTONOMOUS; recovery needs 3 OK heartbeats + 60s cooldown + a deep tool-call probe (`message_stop` required). Anti-flap.
- **`CLAUDISH_NO_ANTHROPIC=1` on every machine except ai-01** (defense in depth); **`CLAUDISH_HOST_PORT` is load-bearing** (port 3000 taken on some hosts — hardcoded binding breaks `docker compose up`).
- **Two capture variables, one letter apart**: `CLAUDISH_CAPTURE_HOST_DIR` (host bind) vs `CLAUDISH_CAPTURE_DIR` (in-container, **empty = write nothing**). Keep capture on; **capture files are not a count of mode switches** (~30× over-count measured).
- **An armed cascade is always hand-added and lives only in the container record (#141)** — `install-sidecar.ps1` never writes `CLAUDISH_FAILOVER_*`; it carries runtime-policy lines verbatim, exits non-zero before gutting a live armed cascade, and `-RebuildEnvFromContainer` recovers container-only state. Before any recreate: **diff by VALUE** (name diffs answer a different question — every container shows all 23 names).
- **The relay branch must stay before `interceptWebTools` / `getHandlerForRequest` / `logRequest`** in the `/v1/messages` route — that ordering makes capture mode-aware for free.
- **A forward connect failure gets exactly one retry (+250 ms) before falling through (#80 part 2)**; an absorbed retry does not `markFail`. A header deadline is never retried, nor is an HTTP 5xx (hysteresis owns it).
- **Two upstream failure signatures — only one is a client-side transport artifact**: a connect failure is client-side only under #80's precondition (hub independently reachable); TCP accepted + an invalid response is hub-end unavailability, client-visible on the WAN edge. Count WAN client impact from the ingress IIS log, never from the relay's own tally. Table: `docs/reference/relay-internals.md`.
- **`hub HTTP 500` is the relay's reading — corroborate hub-side before hunting a provider** (two pass-throughs by design, #299 A / #318; `retry-after` relayed on every non-streaming error; the 500 branches log via `logStderr` since #212 — an empty hub log was never evidence of a healthy hub).

Tests and E2E: `docs/reference/relay-internals.md`.

## Budget Failover (v7.2+)

Substitutes the *model itself* for a whole **role** (`opus`/`sonnet`/`haiku`/`fable`) when that role's metered plan is exhausted — a subscription concern, distinct from `FallbackHandler` (provider swap, a transport concern). They compose. Every substitution is **announced** (centralized in `applyFailoverNotices`); none may ever throw. **Notices state facts, never instructions** (doctrine 2026-08-23). Rules, narratives and probe matrices: `docs/reference/budget-failover.md`.

- **A role's failover is an ordered list of steps** (`CLAUDISH_FAILOVER_<ROLE>`, `>`-separated; the last step is typically PAYG).
- **A wall is keyed by provider BUCKET, never by role (#275)**: a qualifying refusal while serving the nominal walls `bucket(nominal)`; only a request whose own resolved nominal sits in a walled bucket diverts to *its* role's cascade. A bare `claude-*` takes a per-model native bucket (`anthropic-native/<model>`) and never consults `route()`. Config-arms (`CLAUDISH_FAILOVER_ACTIVE`) divert the whole role — except a `role@machine` piece, which diverts only requests whose `X-Claudish-Machine` names that machine.
- **A cascade step can delegate to another ROLE — `role:<r>` (#274)**: resolves to the target's nominal when healthy, else its resolved step (shared walk state); the graph is proven **acyclic at load**; its per-step backoff binds only the CONCRETE it was recorded against (#331); a failed delegated concrete walks the target's remaining path in the same request, never re-paying a concrete the request already paid (#609).
- **Per-step backoff `[10m, 30m, 1h, 4h, 24h]`**, one rung per failure EPISODE (a mark on an already-benched step refreshes it without climbing, #553); overridden by a known reset; ⚠ a future `..._RESET` is a **CLOSURE (#261)** — read `_RESET` **by value** before any deploy. The bucket-wall TTL grows while the wall holds (10m → 20m → 40m capped); any nominal success on that bucket resets it.
- **A session keeps its resolved step for a minimum dwell** (`CLAUDISH_FAILOVER_SESSION_DWELL_MS`, default 10 min, sliding): holds through role-level churn, yields when the pinned step TTL-fails, on VERIFIED nominal recovery (`..._RECOVERY_GRACE_MS`, default 2 min), and on a VERIFIED earlier-step recovery past that same grace (#619 — the step's first success since its last mark un-pins later sessions; a new mark voids the stamp). A NON-quota death of the pinned step forfeits the dwell instead of re-pinning (#276).
- **A nominal's transient OVERLOAD walks the cascade once, writing no failure state (#299-B)** — via `forceTarget`: no arm, no mark, no wall, no pin; a failing step surfaces the ORIGINAL overload; skipped when the nominal already spent `CLAUDISH_FAILOVER_WALK_BUDGET_MS` (default 300 s — at that default the 429/503 class never fires); native lane excluded. Walk classes and probe matrix: `docs/reference/budget-failover.md`.
- **A cascade step that cannot take THIS request skips forward (#431)** — context overflow, a saturated limiter, or the engine's per-prompt image cap (#575), signaled by `x-claudish-step-skip` (`context`/`busy`/`media`), acted on only for a non-last step: advance with **no markStepFailed, no wall, no arm**; the dwell pin yields. `CLAUDISH_FAILOVER_STEP_BUSY_WAIT_MS` bounds step attempts only; kill switch `CLAUDISH_FAILOVER_STEP_SKIP=0`.
- **`resolveFailoverTarget(role)` is the single resolution path** (swap + `handleWithCascade` loop re-read state; no override passed in); **`handleWithCascade` is bounded** (nominal → steps, capped `steps.length + 1`); the c-reuse invariant is load-bearing (a handler must not mutate the Hono `Context` before returning a non-ok `Response`).
- **`isQuotaExhaustion` is deliberately narrower than `FallbackHandler.isRetryableError`**: 402 on status; 429 only when the body names a quota wall. **401 and 404 never arm** — swapping would hide a wiring mistake behind a plausible answer.
- **With nothing set every code path is inert** — configuring a target does not activate it; arming is separate and deliberate. Unset `_DIRECTION` means degraded.
- **A failover target must resolve on the machine that calls the models** — arm cascades on sidecars too. ⚠ Count armed state **by VALUE** (`grep -cE '^CLAUDISH_FAILOVER_[A-Z0-9_]+=.+'`), never by name; `roleFromModelName()` matches only the four role keywords — set `CLAUDISH_FAILOVER_ROLE_MODELS` for bare provider ids.
- ⚠ **In a compose-deployed container the environment is fixed at create time (#310)** — a name absent from `docker-compose.yml`'s `environment:` list NEVER reaches the process (`compose-env-coverage.test.ts` cross-checks); "read per request" still means a NEW value enters only at the next **recreate**.
- **A session's UPSTREAM output tokens can be capped (#317 option B, `fork/session-budget.ts`)** — counter per `(X-Claudish-Machine, session_id)` on the dwell seam, 24 h sliding, every cascade attempt counted. Bars `CLAUDISH_SESSION_BUDGET_CEILING` (refusal — local labeled 429 + `retry-after`, **before any upstream is paid**; wording load-bearing, no quota-class word or `isQuotaExhaustion` would arm off our own ceiling) and `CLAUDISH_SESSION_BUDGET_WARN` (marker-only, defaults to 80%); both inert without env — **fleet pose: WARN-only until the user fixes the values** (an agent never arms the ceiling alone). Subagent sid sharing: `docs/reference/budget-failover.md`.

### `CLAUDISH_QWEN_THINKING`

`disabled` (default) · `passthrough` · `budget:<n>`. **Unset is not neutral** — Qwen reasons by default and the Token Plan bills on **output**; re-read on every request. **Two switches on two wires** (OpenAI: `enable_thinking` + `thinking_budget`; Anthropic: the native `thinking` object) — each endpoint ignores the other's form. Post-deploy check + measurements: `docs/reference/budget-failover.md`.

### `CLAUDISH_GLM_THINKING`

`passthrough` (default) · `disabled`. GLM's switch is **binary** on the OpenAI wire (`thinking: {"type":"enabled"|"disabled"}`), no budget control; only an explicit `disabled` sets the field on the unprobed `zai@` anthropic wire. Re-read per request, same crunch-flip rationale.

## OpenAI-Compatible Ingress (v7.2+)

`/v1/messages` is the **native** ingress; `POST /v1/chat/completions` is a **translated** one — converted to Anthropic shape, run through the **same** `getHandlerForRequest` → `ComposedHandler.handle` pipeline, then translated back. An OpenAI client inherits the routing cascade, budget failover, accounting and leak policy for free, by changing `base_url` alone. Detail: `docs/reference/openai-ingress.md`.

- **Never-hang holds here too**: a malformed stream degrades to a single terminal chunk + `data: [DONE]`; `thinking` blocks surface as `reasoning_content`; `stop_reason` maps to `finish_reason`.
- **A failover notice never rides the content here (#229)** — it arrives in the `x-claudish-failover-notice` response header (base64 UTF-8), streaming and JSON alike, relayed transparently. The gate is the route (`noticePolicyForIngress`), never a user-agent. `/v1/messages` keeps the in-content block 0 for the Claude Code agent loop.
- **Request-side thinking controls are mapped (#435)** — `enable_thinking` / `reasoning_effort` land on the house `thinking` object; an enabled block is always legal (≥1024, `< max_tokens`) — clamping against a client `max_tokens`, *raising* our own 4096 placeholder.
- **A reasoning model can return no text (`content: null` on the JSON response) with `finish_reason:"length"` here** — `reasoning_content` shares the `max_tokens` budget and can consume it all before any text; a `content` consumer gets no answer and no error, and a string method on it throws. Raise the budget, disable thinking (`enable_thinking:false`, #435; honored by DeepSeek `passthrough` since #612), or use `/v1/messages` — the budget is shared there too, but the exhaustion is visible (`thinking` block + `stop_reason:"max_tokens"`): `docs/reference/openai-ingress.md`.
- **The relay is path-aware** — a sidecar forwards to the same route the client hit; the deep liveness probe stays on `/v1/messages`.

## Traffic Analysis & Anthropic Policy

**Default instrument for a live trace question is the `claudish_traffic` MCP tool (#72)** — histogram rendered up to now, declarative `GAP`, cron/interactive split, `UNKNOWN` on a rotated corpus (a script there passed a stale corpus off as current and manufactured false hang suspects, 04/10). The scripts remain for the scheduled surveillance pass and capture-side analysis — never hand-rolled grep: the proxy log format produces false positives when grepped naively (memory `proxy-log-monitoring`). Per-script usage, flags, and the ⚠ reading rules: `docs/reference/traffic-analysis.md` + `docs/reference/ops-scripts.md`.

| Instrument | Use |
|---|---|
| `claudish_traffic` (MCP) | live trace questions, default (#72) |
| `traffic-live.ps1` | 6h surveillance cron — **no new callers (#72)**: cannot detect a rotated corpus |
| `traffic-summary.ps1` · `traffic-sessions.ps1` | rich detail from `req-*.json` captures |
| `traffic-anthropic.ps1` | Anthropic traffic attribution (machine + workspace) — requires `pwsh` |
| `traffic-history.ps1` | past days, from `captures-*.7z` archives |
| `harness-injection-measure.py` | harness context cost — chars/token per request |
| `turn-autopsy.py` | turn classification (#328 G12): sample · show · label · stats · aggregate |
| `native-consumption.py` | who burns the Anthropic-native budget (OUT is the money) |
| `native-trend.py` | cost-per-turn drift, whole days, compaction split |
| `lane-matrix.py` | per-lane day/hour response series (Epic #116 P1, sqlite) |
| `compaction-trend.py` | compaction cost across all lanes (#89) |
| `compress-captures.ps1` · `claudish-watchdog.ps1` | nightly 7z + GDrive backup · health/proactive-restart/hang recovery |
| `claudish-drain.ps1` | restart without dropping agent turns — deploying needs `-Recreate -EnvFile`; agent callers `-Detach` |
| `docker-events-collect.ps1` | container lifecycle events (~35 min, #169) — 🔴 never widen the filter (`exec_*` carries credentials, #192) |
| `failover-events-collect.ps1` | persists `[Failover]` markers (recreate destroys docker logs, #347) — 🔴 past-window `[Failover]` counts read THIS log, never `docker logs` |
| `split-brain-scan.ps1` | read-only ghost-session / split-brain scan (#341) |

Reading rules that change verdicts (full narratives in the reference files):

- **`traffic-live.ps1 -Container` defaults to `claudish-proxy`** — pass `-Container claudish-sidecar` on a sidecar; the MCP tool takes the same distinction.
- **On a NOMINAL sidecar, ~0 requests is the correct answer** — a relayed request writes no capture; count `[ttft]` lines instead (a sidecar's real volume is invisible to `[Request]` counting by ~100×). What `model=` means depends on the emitter: NOMINAL sidecar = the client's requested id, pre-remap; hub or AUTONOMOUS = the resolved concrete that served. `[ttft]` counts served turns with a first event, never requests. Detail: `docs/reference/traffic-analysis.md`.
- **Counting AUTONOMOUS episodes by grepping `AUTONOMOUS` overcounts ~6×** — transitions are the lines that END with the word; anchor on the word ALONE, never a visual arrow glyph (an ASCII variant matches nothing, silently).
- **A `$null`/quiet span in `--since` mode means a quiet container** — but cross-check the mode line the script prints.
- **Policy (user 20/10): every machine authenticates its own Anthropic use — no hard per-machine restriction.** Opus off ai-01 stays exceptional, and only po-2024 CoursIA-3 holds it durably; a user-authorized temporary switch (po-2025, 20/10) is tracked until it reverts. Flag a DURABLE Opus elsewhere, never a one-off. A client `settings.json` carrying `ANTHROPIC_API_KEY` sends that key instead of its login and is refused by #296 shape B (po-2028, 20/10) — fleet settings are read each cycle with `scripts/settings-matrix.py`.
- **`cc_is_subagent=true` is the leak signature, and it lives in the request body, not stdout** — `docker logs` cannot see it; inspect a capture. The `[LEAK-SUBAGENT]` vs `[REVIEW-INTERACTIVE]` split stops the tool crying wolf. A confirmed sub-agent leak is fixed client-side (rules pinning `model: "sonnet"` on spawns), not in the proxy.

Capture format, archive/GDrive retention, device-id attribution, exact commands: `docs/reference/traffic-analysis.md`.

## Channel Mode (MCP, v6.4.0+)

Async model sessions with push notifications, built on the low-level `Server` class declaring `experimental: { 'claude/channel': {} }`. 11 tools, gated by `CLAUDISH_MCP_TOOLS` (`all` default · `low-level` · `agentic` · `channel`). The wire contract is pinned by `channel-wire-format.test.ts`.

- **`meta` keys must match `[a-zA-Z0-9_]+`** — Claude Code **silently drops** keys with hyphens or other characters. Keep new `extraMeta` keys underscore-only.
- **Emitting a correct frame is not enough.** Rendering is gated client-side: CC ≥ v2.1.80; Anthropic auth via claude.ai or Console key; an **interactive** session (`-p` mode drops frames silently); the server declared in `.mcp.json` / `~/.claude.json` (**`--mcp-config` is not consulted**); and the server **named in `--channels`** or `--dangerously-load-development-channels`. Detail: `docs/reference/channel-mode.md`.
- `CLAUDISH_CHANNEL_TRACE=1` (+ `CLAUDISH_CHANNEL_TRACE_FILE` when the host swallows stderr) traces producer → bridge → wire, so a server-side drop is distinguishable from client-side gating. Off by default, zero production overhead.

Full contract, launch commands, diagnostic scripts: `docs/reference/channel-mode.md`. Tests: `bun test --cwd . ./packages/cli/src/channel/*.test.ts` (win32 counts and skip classes: `docs/reference/channel-mode.md`).

## Debugging & Tests

Failed-translation workflow: `claudish --model X --debug "say hello"` → `claudish --probe X` (verify the composition) → `/debug-logs logs/claudish_*.log` (diagnoses the failure mode, extracts SSE fixtures, writes a regression test) → `bun test packages/cli/src/format-translation.test.ts`. Manual extraction and fixtures: `docs/reference/proxy-pipeline-notes.md`.

**Keep debug logs verbose** — empty chunks and raw deltas included; that is what makes real model streaming behavior legible. Suppress noise at the registration/initialization level (e.g. conditional middleware), **never at the streaming-data level**. Under `--debug` both parsers emit greppable `[SSE:openai]` / `[SSE:anthropic]` lines, which become test fixtures.

`format-translation.test.ts` replays `.sse` fixtures from `test-fixtures/sse-responses/` through the stream parser. Helpers: `parseClaudeSseStream()`, `extractText()`, `extractToolNames()`, `extractStopReason()`, `fixtureToResponse()`. Add regressions as a `describe("Regression: <model>")` block (template at the bottom of the file).

**`bun run test:strict` (#175) is how a review gets an opposable verdict from a noisy suite.** Comparison against the baseline is by **reproduction, never by count**; the runner **refuses a verdict** (exit 3) when it cannot account for bun's own counters; the systematic failing population is machine-dependent and lives in each machine's gitignored `.test-strict-baseline.json` — never in this file. First use on a machine: `--learn`; re-learn after any land that removes a cause of load-time death. ⚠ The repo pins no bun and CI installs `bun-version: latest`: a seat on an older bun is not commensurable with CI. Full mechanics: `docs/reference/test-strict.md`.

**Never mock HTTP with `Bun.serve` in a test file (#604).** Once any `node:http` server has lived in the `bun test` process — every `proxy-server-*.test.ts` route test is one, the proxy being `@hono/node-server` — every `Bun.serve` created afterwards is unreachable: fetch answers Bun's `"Welcome to Bun!"` page, so the JSON client reports `Failed to parse JSON`. Hostname, port and shutdown order change nothing. Use `packages/cli/src/test-support/stub-fetch.ts` (`installStubFetch` / `hangUntilAborted`): same wire semantics, no socket. Mechanism, measurements and the per-file sweep: `docs/reference/test-strict.md`.

**PowerShell operations scripts have their own suite**: `bun run test:scripts` (pwsh 7) and `bun run test:scripts:win51` (Windows PowerShell 5.1 — **the interpreter the scheduled tasks actually use**; run both, they do not agree, and the one that ships is 5.1). Pure logic lives in `scripts/lib/claudish-engine.psm1` so it can be exercised without touching Docker, WSL, the task scheduler or the network. ⚠ **Dot-sourcing `claudish-drain.ps1` runs its `param()` defaults in the caller's scope and clobbers `$ClaudishHome`** — any test claiming a sandbox must assert on the log path too, or it is lying about its blast radius (measured 2026-09-20: 2 stray prod lines). Runbook: `docs/reference/ops-scripts.md`.

Detail: `docs/reference/proxy-pipeline-notes.md` · strict-runner mechanics: `docs/reference/test-strict.md`.

## Learned Preferences

### Tools & Commands
<!-- learned: 2026-03-28 session: 03cd7cc5 source: repeated_pattern -->
- Use `bun` for all package management and scripts (`bun run build`, `bun test`, etc.) — not npm or yarn
<!-- learned: 2026-04-06 session: df311293 source: repeated_pattern -->
- Use Grep/grep tool for code investigation instead of mnemex — prefer built-in search tools during investigation phases

### Workflow
<!-- learned: 2026-04-06 session: df311293 source: explicit_rule -->
- Don't run claudish directly in main bash — use dedicated channel sessions or `/delegate`
