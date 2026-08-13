# Claudish - Development Notes

For planned but not-yet-implemented work — including the SEP-1686 channel migration, optional `notifications/progress` for terminal UI, and the Anthropic plugin allowlist consideration — see `ROADMAP.md`. Each item there has an explicit trigger condition; if a condition is met, the item moves to active development.

## Release Process

**Releases are handled by CI/CD** - do NOT manually run `npm publish`.

1. Bump version in `package.json`
2. Commit with conventional commit message (e.g., `feat!: v3.0.0 - description`)
3. Create annotated tag: `git tag -a v3.0.0 -m "message"`
4. Push with tags: `git push origin main --tags`
5. CI/CD will automatically publish to npm

## Build Commands

- `bun run build` - Build CLI and macOS bridge bundles
- `bun run dev` - Development mode

## Model Routing (v4.0+)

### New Syntax: `provider@model[:concurrency]`

```bash
# Explicit provider routing
claudish --model google@gemini-2.0-flash "task"
claudish --model openrouter@deepseek/deepseek-r1 "task"

# Native auto-detection (no prefix needed)
claudish --model gpt-4o "task"          # → OpenAI
claudish --model gemini-2.0-flash "task" # → Google
claudish --model llama-3.1-70b "task"   # → OllamaCloud

# Local models with concurrency
claudish --model ollama@llama3.2:3 "task"  # 3 concurrent requests
```

### Provider Shortcuts
- `g@`, `google@` → Google Gemini
- `oai@` → OpenAI Direct
- `cx@`, `codex@` → OpenAI Codex (Responses API)
- `or@`, `openrouter@` → OpenRouter
- `mm@`, `mmax@` → MiniMax
- `mmc@` → MiniMax Coding Plan
- `kimi@`, `moon@` → Kimi
- `glm@`, `zhipu@` → GLM
- `gc@` → GLM Coding Plan
- `llama@`, `oc@` → OllamaCloud
- `litellm@`, `ll@` → LiteLLM (requires LITELLM_BASE_URL)
- `ollama@` → Ollama (local)
- `lmstudio@` → LM Studio (local)
- Custom endpoint names also work as provider prefixes (e.g., `my-vllm@model-name`) — see "Custom Endpoints" below

### Default Provider Configuration (v7.0.0+)

`defaultProvider` is a **last-resort fallback** appended to every bare-name routing chain. It is not a "front of the line" override — specific patterns (`gpt-*`, `gemini-*`, etc.) still try their normal providers first. `defaultProvider` only catches models whose explicit chain has zero credentialed providers, or models that match no rule at all.

Set it via:

- **Config file**: `"defaultProvider": "openrouter"` in `~/.claudish/config.json`
- **Env var**: `CLAUDISH_DEFAULT_PROVIDER=openrouter`
- **CLI flag**: `claudish --default-provider openrouter "task"`

**Precedence** (highest to lowest):
1. CLI flag `--default-provider`
2. `CLAUDISH_DEFAULT_PROVIDER` env var
3. `defaultProvider` in config file
4. `OPENROUTER_API_KEY` present → `"openrouter"`
5. Hardcoded `"openrouter"`

**Example config**:
```json
{
  "defaultProvider": "openrouter",
  "customEndpoints": { ... }
}
```

Valid values: any built-in provider name (`"openrouter"`, `"openai"`, `"google"`, `"litellm"`, etc.) or a custom endpoint name defined in `customEndpoints`.

**How it interacts with routing rules**: For each bare-name model, `route()` matches against the rules table, builds the candidate chain, then **appends `defaultProvider` to the end** if it isn't already in the chain (deduped against shortcuts — `or` and `openrouter` are treated as the same provider). The combined chain is then credential-filtered. Explicit `provider@model` specs are not affected — `defaultProvider` only applies to bare names.

**No more LiteLLM auto-promotion** (removed in commit 5 of the model-catalog and routing redesign): Setting `LITELLM_BASE_URL` + `LITELLM_API_KEY` no longer makes LiteLLM the default. Users who want LiteLLM as the catch-all must set `defaultProvider: "litellm"` explicitly.

### Vendor Prefix Auto-Resolution (ModelCatalogResolver)

API aggregators (OpenRouter, LiteLLM) require vendor-prefixed model names that users shouldn't need to know. The `ModelCatalogResolver` interface searches each aggregator's dynamic model catalog to find the correct prefix automatically.

**How it works**: User types bare model name → resolver searches the provider's already-fetched model list → finds the exact match with vendor prefix → sends the prefixed name to the API.

**Current resolvers**:
- **OpenRouter**: `or@qwen3-coder-next` → searches catalog → sends `qwen/qwen3-coder-next`
- **LiteLLM**: `ll@gpt-4o` → searches model groups → finds `openai/gpt-4o` (prefix-strip match)
- **Static fallback**: `OPENROUTER_VENDOR_MAP` for cold starts when catalog isn't loaded yet

**Key design rules**:
- Exact match only — no fuzzy/normalized matching. Find the right prefix, don't guess the model.
- Dynamic catalogs (from provider APIs) are PRIMARY. Static map is cold-start fallback only.
- Resolution happens BEFORE handler construction (in `proxy-server.ts`), not inside adapters.
- Sync entry point (`resolveModelNameSync()`) — uses in-memory caches + `readFileSync`, no async propagation.

**Firebase slim catalog** (v7.0.0+): The `aggregators[]` field on model documents provides a typed multi-provider routing index. Each entry is `{ provider, externalId, confidence }`. Claudish only consumes this hosted catalog at runtime. Catalog extraction, recommendation generation, portal hosting, and API documentation live in the [models-index](https://github.com/MadAppGang/models-index) repo.

**Adding a new aggregator resolver**: Implement `ModelCatalogResolver` interface in `providers/catalog-resolvers/`, register in `model-catalog-resolver.ts`. No changes to proxy-server or provider-resolver needed.

**Architecture doc**: `ai-docs/sessions/dev-arch-20260305-104836-a48a463d/architecture.md`

## Local Model Support

Claudish supports local models via:
- **Ollama**: `claudish --model ollama@llama3.2` (or `ollama@llama3.2:3` for concurrency)
- **LM Studio**: `claudish --model lmstudio@model-name`
- **Custom URLs**: `claudish --model http://localhost:11434/model`

### Context Tracking for Local Models

Local model APIs (LM Studio, Ollama) report `prompt_tokens` as the **full conversation context** each request, not incremental tokens. The `writeTokenFile` function uses assignment (`=`) not accumulation (`+=`) for input tokens to handle this correctly.

## Custom Endpoints (v7.0.0+)

Define named custom endpoints in `~/.claudish/config.json` under the `customEndpoints` key. Each endpoint registers as a provider prefix usable with `@` syntax.

### Config schema

**Simple endpoint** (most common):
```json
{
  "customEndpoints": {
    "my-vllm": {
      "kind": "simple",
      "url": "http://gpu-box:8000",
      "format": "openai",
      "apiKey": "${VLLM_API_KEY}",
      "modelPrefix": "my-org/",
      "models": ["llama3.1-70b", "qwen2.5-72b"]
    }
  }
}
```

**Complex endpoint** (full control):
```json
{
  "customEndpoints": {
    "corp-proxy": {
      "kind": "complex",
      "displayName": "Corporate LLM Proxy",
      "transport": "openai",
      "baseUrl": "https://llm.corp.internal",
      "apiPath": "/api/v2/chat/completions",
      "apiKey": "${CORP_LLM_KEY}",
      "authScheme": "X-Api-Key",
      "headers": { "X-Team": "platform" },
      "streamFormat": "openai-sse",
      "modelPrefix": "",
      "models": ["gpt-4o", "claude-sonnet"]
    }
  }
}
```

Use as: `claudish --model my-vllm@llama3.1-70b "task"` or `claudish --model corp-proxy@gpt-4o "task"`.

### Key details

- **`${VAR_NAME}` expansion**: The `apiKey` field expands environment variables at startup. Use this instead of hardcoding secrets in config.
- **Zod validation**: Claudish validates all custom endpoints at proxy startup. Invalid entries emit a stderr warning and are skipped — they don't crash the proxy.
- **Runtime registration**: Endpoints call `registerRuntimeProvider()` and `registerRuntimeProfile()` to inject themselves into the provider resolver and transport layers.
- **`models` field** (optional): When present, limits the endpoint to listed models. Omit to allow any model name.
- **`modelPrefix` field** (optional): Prepended to the user-specified model name before sending to the API.

## Three-Layer Adapter Architecture (v5.14.0+)

The translation pipeline has three decoupled layers:

### Layer 1: FormatConverter — wire format translation
Translates between Claude API format and target model's wire format (messages, tools, payload).
Each converter declares its stream format via `getStreamFormat()`.
- **Interface**: `adapters/format-converter.ts`
- **Implementations**: OpenAIAdapter, AnthropicPassthroughAdapter, GeminiAdapter, CodexAdapter, OllamaCloudAdapter, LiteLLMAdapter
- **Message/tool conversion**: `handlers/shared/format/openai-messages.ts`, `openai-tools.ts`

### Layer 2: ModelTranslator — model dialect translation
Translates model-specific dialect differences (context windows, thinking→reasoning_effort, vision rules).
- **Interface**: `adapters/model-translator.ts`
- **Implementations**: GLMAdapter, GrokAdapter, MiniMaxAdapter, DeepSeekAdapter, QwenAdapter, CodexAdapter
- **Selection**: `AdapterManager` auto-selects based on model ID

### Layer 3: ProviderTransport — HTTP transport
Handles auth, endpoints, headers, rate limiting. Optionally overrides stream format for aggregators.
- **Interface**: `providers/transport/types.ts`
- **Stream format override**: LiteLLM and OpenRouter implement `overrideStreamFormat()` → `"openai-sse"`

### Composition in ComposedHandler
```
ComposedHandler = FormatConverter (explicit adapter) + ModelTranslator (auto-selected) + ProviderTransport
```

**Stream parser selection** (3-tier priority):
```typescript
transport.overrideStreamFormat() ?? modelAdapter.getStreamFormat() ?? providerAdapter.getStreamFormat()
```

**Adding a new provider**: Add one entry to `PROVIDER_PROFILES` table in `providers/provider-profiles.ts`.
**Adding a new model**: Create a ModelTranslator adapter, register in `adapters/adapter-manager.ts`.
**Verifying wiring**: `claudish --probe <model>` shows the full adapter composition.

### Stream Parsers
Located in `handlers/shared/stream-parsers/`:
- `openai-sse.ts` — OpenAI SSE → Claude SSE (used by most providers)
- `anthropic-sse.ts` — Anthropic SSE passthrough (MiniMax, Kimi direct)
- `gemini-sse.ts` — Gemini SSE → Claude SSE
- `ollama-jsonl.ts` — Ollama JSONL → Claude SSE
- `openai-responses-sse.ts` — OpenAI Responses API → Claude SSE (Codex)

### Non-Streaming (`stream: false`) Support

Claude Code's agentic loop always sends `stream: true`, but **`/compact` (context condensation) and any non-streaming Anthropic API caller send `stream: false`** and expect a single JSON `message` body (`Content-Type: application/json`), NOT SSE. Returning SSE to such a client surfaces as `"API Error: API returned an empty or malformed response (HTTP 200) — check for a proxy or gateway intercepting the request"` and **blocks the affected operation** (a session that can't compact eventually overflows and the agent stalls — a never-hang-priority violation).

Every adapter's `buildPayload` hardcodes `stream: true` (the proxy always drives the upstream provider in streaming mode), and the whole translation pipeline emits Claude SSE. To serve non-streaming clients, `ComposedHandler.handle()` buffers the already-translated SSE back into one Anthropic message via `collectAnthropicSseToMessage()` (`handlers/shared/collect-sse-message.ts`):

- The trigger mirrors `request-logger.ts`'s `stream` definition exactly: `wantsStreaming = payload?.stream === true`. Anything else → buffer to JSON.
- `NativeHandler` (Anthropic-direct/Opus) already honored `stream: false` natively — that is why `/compact` worked on Opus but failed on every proxied/composed model. This closes the same gap for ComposedHandler (and therefore FallbackHandler, which delegates to it).
- The collector **never throws** (never-hang-priority): a broken/empty stream degrades to a well-formed message with an empty text block. It reuses the full pipeline (all stream formats, web-tool interception, empty-response classification) verbatim — it just collapses the SSE into a message at the end.
- Regression tests: `handlers/shared/collect-sse-message.test.ts` (text, tool_use, mixed thinking/text order, empty body, malformed lines, unparseable tool JSON).

## Web Search Interception (v7.1+)

When providers emit web search tool calls (`web_search`, `brave_web_search`, `tavily_search`) or GLM's `<searchWeb>` tags, claudish intercepts them instead of forwarding to the provider (which would fail for non-Anthropic providers).

**HARD constraint**: a failed search/fetch must NEVER stop the agent. Every path degrades gracefully to well-formed text — no throws, no hung streams.

### Architecture

Three interception paths:

1. **Structured tool_call** (`openai-sse.ts`): provider web search tool calls are detected via `web-search-detector.ts`. **If the client declared a `WebSearch` tool in the request** (checked against `toolSchemas`), the call is **remapped** to a synthetic `WebSearch` tool_use block with `stop_reason: "tool_use"` — Claude Code then executes its own WebSearch (which arrives as a sub-agent request, path 3) and the agentic loop continues. If WebSearch is NOT declared (e.g. sub-agents without web tools), the call is `suppressed` and results are injected as a text block with `end_turn` (legitimate there).

2. **GLM `<searchWeb>` tags** (`openai-sse.ts`): GLM models emit `<searchWeb><query>...</query></searchWeb>` in text content. At finalize, same remap logic: WebSearch declared → synthetic tool_use; otherwise SearXNG is called and results are appended as a text block.

3. **Sub-agent requests** (`proxy-server.ts`): Claude Code's own WebSearch/WebFetch tools send a single user message ("Perform a web search for the query: X" / "Perform a web fetch for the URL: X"). Intercepted at the proxy level before handler selection; results returned as text with `end_turn` (correct — the sub-agent's job is to return text).

**Why the remap matters (CoursIA incident 2026-06-10)**: suppress + inject-text + `end_turn` ends the assistant turn on raw search results — the agent stalls instead of using them. Remapping to the client's WebSearch keeps `stop_reason: "tool_use"`, so results come back as a tool_result and the loop continues. Regression tests: `format-translation.test.ts` ("web search remap").

### Execution backends (fallback chains)

`web-search-executor.ts` resolves each search/fetch through a chain; the first usable result wins:

- **Search**: MCP `searxng_web_search` (if `SEARXNG_MCP_URL` set, 5s deadline) → direct HTTP `{SEARXNG_URL}/search?format=json` (3s) → error text.
- **Fetch**: MCP `web_url_read` (12s, real fetch + markdown) → MCP `web_url_read` with `https://r.jina.ai/<url>` prefix (bypasses 403 on bot-hostile hosts, e.g. npmjs) → direct streaming HTTP with 500KB byte cap → error text.

The MCP client (`handlers/shared/mcp-searxng-client.ts`) is a minimal JSON-RPC streamable-http client (no SDK, no stdio): handles both `application/json` and `text/event-stream` response formats, lazy `initialize` handshake with `mcp-session-id` caching when the server demands a session, strict `AbortSignal.timeout` deadlines, and a non-throwing `{ ok, text|error }` contract. Per-call duration is logged as `[MCP-SearXNG] tools/call <name> <ms>ms ok=<bool>` for overhead measurement vs direct HTTP.

### Configuration

- **`SEARXNG_MCP_URL`** env var (optional): URL of the MCP searxng endpoint (e.g. `https://mcp-tools.myia.io/searxng/mcp`). When unset, the MCP layer is skipped entirely — zero behavior change for existing deployments.
- **`MCP_AUTH`** or **`SEARXNG_MCP_TOKEN`** env var: bearer token for the MCP endpoint. Never hardcode; provisioned via RooSync.
- **`SEARXNG_URL`** env var: URL of the SearXNG instance (e.g. `http://search.myia.io`) for the direct HTTP fallback. When unset, interception falls through gracefully with a fallback message.
- **Deadlines**: MCP search 5s, MCP fetch 12s, direct HTTP search 3s (5s sub-agent path), direct fetch 10s. Non-blocking — every call races a timeout.

### Components

- `handlers/shared/mcp-searxng-client.ts` — MCP streamable-http JSON-RPC client (non-throwing)
- `handlers/shared/web-search-executor.ts` — fallback chains, result formatting, query extraction
- `handlers/shared/web-search-detector.ts` — provider web-search tool name detection
- `handlers/shared/stream-parsers/openai-sse.ts` — remap/suppression + `<searchWeb>` tag detection
- `proxy-server.ts` — sub-agent request interception

### Inline System Message Handling

Claude Code v2.1.153+ injects `role: "system"` messages inline (e.g. system-reminders). Anthropic-compatible providers (Z.AI, MiniMax, Kimi) reject these — only "user"/"assistant" accepted. The fix:
- `composed-handler.ts`: strips inline system messages from `requestPayload.messages` for `anthropic-sse` transport, merges into top-level `system` field
- `openai-messages.ts`: same strip for the OpenAI format path

### Diagnostic Body Capture

Set `CLAUDISH_CAPTURE_DIR` env var to enable full request body capture for offline reproduction of hangs or malformed responses. Disabled by default (no-op when unset). Files written as JSON with metadata (timestamp, source IP, model, PID, machine header).

In the Docker deployment, `CLAUDISH_CAPTURE_DIR=/captures` is bind-mounted to `D:\claudish-captures` on the host, so captures persist across container recreates. Compacted nightly to 7z, then backed up to GDrive (see `capture-retention.md` memory).

## Relay / Sidecar Mode (v7.2+)

**Motivation.** Historically every cluster machine pointed Claude Code's `ANTHROPIC_BASE_URL` directly at po-2023's proxy container. That made po-2023 a **single point of failure** — when it crashed (2026-07-02), the whole cluster stalled. The relay design removes that: each capable machine runs its own claudish container (a **sidecar**) that relays to the central hub in nominal mode but takes over locally when the hub dies.

**One binary, three modes** — selected by `CLAUDISH_RELAY_UPSTREAM`:

| `CLAUDISH_RELAY_UPSTREAM` | Mode | Behavior |
| --- | --- | --- |
| **unset** | **HUB** (po-2023) | Always local. Zero change vs. before. |
| set + hub **alive** | **NOMINAL relay** | Forwards the raw request to the hub; response repiped through the never-hang passthrough. No local capture (hub captures centrally). |
| set + hub **dead** (hysteresis) | **AUTONOMOUS** | Falls through to the normal local pipeline + local capture. Leak-policy hard: never Anthropic on non-ai-01. |

**Components** (`packages/cli/src/fork/server/relay.ts`):

- `forwardToUpstream(c, body, state)` — builds outbound headers (copies inbound minus hop-by-hop, **preserves `X-Claudish-Machine`** so central attribution survives the relay, then **injects the cluster key as `x-proxy-key`** — NOT `x-api-key` — and **keeps the client `authorization`**). The `x-proxy-key` form passes the hub's auth gate without triggering `NativeHandler`'s proxyKey→Anthropic swap, so a relayed native (Opus) request from ai-01 passes through to Anthropic on ai-01's own OAuth (the hub stores no Anthropic key). `x-api-key` would arm the swap → strip auth → 401. Optionally gzips the request body, `fetch`es `${upstream}/v1/messages`. Pre-stream failure → returns `null` (caller falls through to local for that request). Success streaming → repiped via `createAnthropicPassthroughStream(…, { capture: false })` (ping keepalive + `finalizeWithError`, so a mid-stream hub death still emits a terminal `message_stop`).
- `startUpstreamProber(state)` — heartbeat `GET /health` every 10s. **Hysteresis:** 2 consecutive failures → AUTONOMOUS (fast failover); recovery needs 3 OK heartbeats **+ 60s cooldown + a deep tool-call probe** (`glm-5.2`, must complete with `message_stop`) before returning to NOMINAL (anti-flap).
- `readRequestBody(c)` — inflates a gzipped request body on the hub (detects gzip magic bytes, so it's correct whether or not the runtime auto-inflates). Zero cost on the uncompressed LAN path.

**Wiring:** the relay branch sits in the `/v1/messages` route **before** `interceptWebTools` / `getHandlerForRequest` / `logRequest` — so nominal forwards bypass local capture automatically (mode-aware capture for free). `standalone-proxy.ts` reads the env, builds `RelayState`, passes it in `ProxyServerOptions.relay`, and starts the prober.

**Leak-policy backstop (defense in depth).** `CLAUDISH_NO_ANTHROPIC=1` (set on every machine ≠ ai-01) makes `getHandlerForRequest` reroute any bare native (`isNative`) target to the budget `modelMap.sonnet` instead of real `api.anthropic.com`. Depth-guarded recursion + a fail-closed refusal handler prevent both infinite loops and leaks on a misconfigured mapping. See memory `leak-policy-binary-by-machine`.

**Compression (Phase B, WAN only).** LAN sidecars do **not** compress (the hub decompresses to proxy anyway; the LAN isn't the bottleneck). WAN externals (po-2025, web1 → models.myia.io) set `CLAUDISH_RELAY_COMPRESS=1` → native `Content-Encoding: gzip` on the **request body only** (never the SSE response — gzip buffering would risk a hang). The uplink (system + history + tools) is the constrained asymmetric direction.

**Outage capture reconciliation (Phase C).** On a sidecar, loose captures exist *only* because an outage forced AUTONOMOUS mode — so any loose `req-*/resp-*` files ARE outage captures. `scripts/reconcile-outage-captures.ps1` packs them into `reconcile/outage-<machine>-<start>_<end>.7z` (machine-namespaced, no collision with daily `captures-YYYY-MM-DD.7z`), uploads to GDrive `reconcile/`, and deletes loose only after a verified archive + confirmed off-site copy. The hub merges them nightly; attribution is correct because each `req-*.json` body carries `machine` (commit 141d160). `CaptureUtils.psm1` → `Get-OutageArchives`.

**Env vars** (`docker-compose.yml`, every default reproducing hub behavior, so the hub runs with **no `.env` at all**): `CLAUDISH_RELAY_UPSTREAM`, `CLAUDISH_RELAY_COMPRESS`, `CLAUDISH_NO_ANTHROPIC` (relay), plus the host bindings a sidecar must override — `CLAUDISH_CONFIG_DIR`, `CLAUDISH_CAPTURE_HOST_DIR`, `CLAUDISH_HOST_PORT`, `CLAUDISH_CONTAINER_NAME`. Template: `.env.sidecar.example`.

`CLAUDISH_HOST_PORT` is **load-bearing, not cosmetic**: port 3000 is already taken on some hosts (ai-01), so a hardcoded binding makes `docker compose up` fail outright there. The container side always stays 3000.

Two capture variables, one letter apart in meaning and deliberately *not* in spelling: `CLAUDISH_CAPTURE_HOST_DIR` (host bind path) vs `CLAUDISH_CAPTURE_DIR` (in-container path, **empty = write nothing**). Sidecars keep capture **on**: NOMINAL relay writes nothing, so any file appearing on a sidecar is by construction an AUTONOMOUS-mode outage capture — the trail `reconcile-outage-captures.ps1` needs. Disabling it is a disk-starvation escape hatch that silently destroys that trail.

**Tests:** `relay.test.ts` (16 — hysteresis, header build incl. ai-01 Opus passthrough, gzip, never-hang delegation). Budget-free resilience E2E: `bun run packages/cli/src/fork/server/relay-e2e.ts` (real prober + mock hub: NOMINAL → FAILOVER → RECOVERY over real HTTP, ~2-3 min).

**Fleet deployment.** `scripts/install-sidecar.ps1` idempotently stands up a sidecar on a target machine (clone/pull, per-machine `.env`, `docker compose up --build`, end-to-end probe). Runbook + per-machine config table: `docs/deployment/relay-sidecar-deployment.md`. Sidecars go on every machine except po-2023 (hub) and web1 (stays on `models.myia.io`). The client prerequisite — the `x-proxy-key` custom header — is documented in memory `proxy-key-custom-header-auth`.

## Budget Failover (v7.2+)

**Not the same thing as `FallbackHandler`.** That one swaps *providers* for the *same* model when a provider is unhealthy — a transport concern. This one substitutes the *model itself* for a whole **role** (`opus`/`sonnet`/`haiku`) when that role's metered plan is exhausted — a subscription concern. They compose: a failover target still gets the normal provider fallback chain.

**Why it exists.** The cluster runs on weekly-metered plans (Anthropic, MiniMax, Z.AI). When a plan burns faster than its reset window, the choice is to stop working or to serve the role from another pool. Serving it *silently* is the dangerous option: the agent keeps assuming capabilities it no longer has, or — in the MiniMax→DeepSeek direction — fails to use capabilities it just gained. So every substitution is announced.

**Transitive cascade of degradations (2026-08-12).** A role's failover is an **ordered list of substitute steps**, not a single target. When the nominal walls, serve step 0; when step 0 *also* walls, serve step 1; and so on. Opus→GLM today is not a special route — it is Opus→Qwen where Qwen is also dead, so the walk falls to Qwen's own successor GLM. The last step (typically PAYG) is always served when everything above is down, because PAYG has no weekly wall. **GLM is a rolling ~5h window** (it dies AND restarts every 5h — not a consumable pool like the Qwen weekly quota); DeepSeek PAYG fills GLM's holes. The cascade models this as a walk, so the expected end-of-week state (GLM down 3-4h, PAYG holding everyone for ~1h before GLM reset) needs no new routing — just each step walling in sequence.

**Where the notice goes: condensation + the moment of failover + recovery.** Notices are centralized in `proxy-server.ts`'s `applyFailoverNotices` (covers `ComposedHandler` AND `NativeHandler` — moving them out of `composed-handler` fixed the gap where Opus-on-native recovered silently). There are two distinct notices, for two distinct moments:

1. **Condensation** (`appendFailoverNoticeToMessage`, non-streaming / `/compact` path). `applyFailoverNotices` appends it to the collected message. That boundary is chosen because it is the only moment in an agentic session where the context is rebuilt from scratch anyway — the notice costs nothing there, is guaranteed to survive into the continuing context, and the prompt cache is already cold so re-routing is free. Targets the **trailing** text block (clients may read `content[0]`) and **never throws**: a thrown error would turn a working condensation into a failed one, and a session that cannot condense eventually stalls. Fires at every condensation while a role is armed, and names the **currently-resolved step** with depth ("the 2nd fallback") + which prior steps are exhausted ("Qwen 3.8 Max ahead of it is also exhausted"). When the resolved step changes between condensations, the next compact reflects the new step — this is why the notice re-fires every time rather than once.

2. **Moment of failover** (`consumeStreamNotice` + `prependNoticeToAnthropicStream`, streaming path). The FIRST streamed response a session receives under an active role failover gets a risk-adjustment notice prepended as content block 0, with every real block's `index` shifted by +1. The substitute model then reads its own prior turn — starting with this notice — on the next turn's history, so it knows it inherited a context built for a different model and recalibrates (degraded → "be more conservative, take fewer risks than you would under Opus"; improved → "you are stronger, use it"; lateral → "continue as normal"). Direction-aware text per step. **Depth-aware re-notify:** `notifiedSessions` is now `Map<role, Map<sessionKey, stepIndex>>`, so when the resolved step changes mid-session (step 0 walls, fall to step 1) the stream notice fires *again* naming the new depth — one notice per resolved step per session. Dedup set cleared when an auto-arm TTL-disarms (fresh episode re-notifies); a config-arm holds the set for the whole operator window. Never-throws: any stream parse anomaly degrades to passthrough; the worst case is a missing notice, never a broken stream. Zero bytes on non-failover traffic. Tests: `handlers/shared/failover-stream-notice.test.ts`.

3. **Recovery** (`buildFailoverNotice`/`buildStreamRecoveryText`, same two channels). When a role returns to nominal after failover, a symmetric recovery notice fires so the model can recalibrate upward and "corriger ses mémoires." Detection is the auto-arm TTL probe (no background timer): when the 10-min TTL expires, the next request probes nominal; on success, `onNominalSuccess` seeds a `recovering` state (`RECOVERY_CONDENSATIONS=3`) carrying the step it WAS serving. Recovery then fires at the next 3 condensations ("back on nominal after serving as GLM-5.2; recalibrate upward") and once per session on the stream. Works on `NativeHandler` now that it propagates upstream status (commit 30a974f). Re-arming a role clears stale recovery (we're back in failover; a stale recovery notice would mislead). Config-arms don't self-probe, so their recovery is the operator lifting them — at which point AUTO retakes and emits the notice.

The three compose: one stream notice at the moment of failover (per resolved step), then one at each condensation for the rest of the window, then recovery notices (stream once + 3 condensations) when nominal returns.

**Configuration** (env, read at proxy startup; see `.env.sidecar.example`):

| Var | Meaning |
|---|---|
| `CLAUDISH_FAILOVER_<ROLE>` | Ordered cascade of substitutes, `>`-separated. Step 0 is served when the nominal walls; step 1 when step 0 *also* walls; etc. No `>` = single-step (backward compatible). The nominal itself is NOT in the list. Any spec `getHandlerForRequest` accepts per step. |
| `..._LABEL` | Human name(s) for the notice, `>`-separated to match steps. Missing/padded entries default to the step's target string. |
| `..._DIRECTION` | `>`-separated per step: `degraded` (default) · `improved` · `lateral`. Unset means degraded — never flatter the substitute. |
| `..._NOTE` | Extra guidance appended to that step's notice line, `>`-separated. |
| `CLAUDISH_FAILOVER_ROLE_MODELS` | Deployment-specific `pattern:role,pattern:role` aliases (lowercase substring match) so clients that name the nominal model directly (`glm-5.2`, `MiniMax-M3`) instead of a role keyword (`claude-sonnet-4-6`) still get cascade protection. Role keywords win when both match; unset = keywords only. Used by `roleFromModelName` — the single role-detection source shared by the swap and the cascade loop. |
| `CLAUDISH_FAILOVER_ACTIVE` | Roles armed **now**, comma-separated, or `none`. Use to conserve a plan *before* it dies. |
| `CLAUDISH_FAILOVER_AUTO` | `1` = also arm on genuine upstream quota exhaustion. |

**With nothing set, every code path is inert** — no routing change, no notice, zero added bytes. Configuring a target does **not** activate it; arming is separate and deliberate.

**Resolution is a single source of truth.** `resolveFailoverTarget(role)` walks the rule's steps skipping TTL-failed ones, returning the first live step (or the last step anyway, since PAYG is meant to always work). It is the ONLY resolution path — used by BOTH `getHandlerForRequest`'s swap AND the `handleWithCascade` loop. The loop never passes an override target in; it mutates failover state (`armFailover`/`markStepFailed`), and the next iteration re-reads via the same `resolveFailoverTarget`. No double-resolution.

**`handleWithCascade`** (proxy-server.ts, both `/v1/messages` and `/v1/chat/completions`) replaces the old single-shot retry with a bounded loop: nominal → step 0 → step 1 → …, capped at `steps.length + 1` attempts. On `response.ok`: nominal success resets all step failures for the role (fresh episode); step success resets just that step. On `!ok` + `isQuotaExhaustion`: a nominal wall arms the role; a step wall marks that step failed. Non-quota errors (401/404/wiring) return as-is without advancing. Bounded, no `while(true)`, never hangs. The **c-reuse invariant** is load-bearing: handlers must not mutate the Hono `Context` before returning a non-ok `Response`, so re-calling `handler.handle(c, body)` across iterations is safe.

### Per-step backoff (cascade TTL)

Each step tracks its own failure count + last-failure timestamp in `stepFailures: Map<role, StepFailure[]>`. `stepTtlMs(count)` indexes `BACKOFF_MS = [10m, 30m, 1h, 4h, 24h]` (caps at 24h). A TTL-failed step is skipped by `resolveFailoverTarget` until its TTL elapses.

**Critical invariant: `stepFailures` survives the role-arm TTL cycle.** The role-level auto-arm TTL (10 min) re-probes the nominal on expiry — but it must NOT re-probe a TTL-failed step. Without this, the 10-min nominal re-probe cycle would re-probe Qwen (weekly wall) every 10 min, defeating the backoff that caps it at ~6 probes over 6 days. The schedule fits both failure shapes: Qwen's weekly wall is probed a handful of times then left alone; GLM's 10m+30m+1h+4h ≈ 5h30 naturally lands a probe shortly after its 5h window resets. `stepFailures` IS cleared (whole role) when the **nominal** itself recovers — a healthy nominal means a fresh episode.

**`isQuotaExhaustion` is deliberately narrower than `FallbackHandler.isRetryableError`.** 402 arms on status alone; 429 arms only when the body names a quota/credit/balance/weekly/plan wall — a plain per-minute rate limit must **not** burn the weekly switch because a burst hit a 60-second window. 401 and 404 **never** arm: those are wiring mistakes, and swapping the model would hide a bad key or a bad model id behind a plausible-looking answer.

**Placement.** These belong on the machine that actually *calls* the models. A NOMINAL sidecar only relays, so on a sidecar they matter solely for AUTONOMOUS (hub-down) mode — the hub is the normal home. A failover target must be resolvable *on that machine*: pointing a sidecar at a custom endpoint defined only in the hub's `config.json` configures a fallback that fails exactly when it is needed.

### `CLAUDISH_QWEN_THINKING`

Qwen reasons by default, so an unset `thinking` is not neutral — it means "think, at length", and the Token Plan bills on **output**. Values: `disabled` (default) · `passthrough` · `budget:<n>`. Re-read on **every request**, deliberately: the fleet flips this during a budget crunch, and a cached value would require restarting the proxy that is at that moment the thing keeping everyone working.

The subtlety this encodes: Qwen exposes **two switches on two wires, and each endpoint ignores the other's form**. The OpenAI-compatible endpoint takes `enable_thinking` + `thinking_budget`; the Anthropic-compatible one takes the native `thinking` object. `QwenModelDialect.prepareRequest` therefore branches on `ctx.wireFormat` (`PrepareRequestContext`, threaded from `ComposedHandler.resolveStreamFormat()`). Before this, the adapter converted `thinking` → `enable_thinking` unconditionally, which on the Anthropic wire **deleted the only switch that works**.

Measured against Qwen Token Plan, `max_tokens: 400`, prompt `"Reponds exactement: ok"` (2026-08-11): baseline `67 in / 43 out` with a thinking block; `enable_thinking: false` → `67 / 48`, still thinking; `thinking: {type: "disabled"}` → `31 / 1`. Note the **input** count moves too (67 → 31) — Alibaba appears to inject a reasoning preamble when thinking is on. That makes a crisp post-deploy check: **if `input_tokens` drops from 67 to 31 on that prompt, the native switch reached Qwen.**

## OpenAI-Compatible Ingress (v7.2+)

Anthropic is the **native** ingress (`/v1/messages`). The OpenAI ingress `POST /v1/chat/completions` is a **translated** ingress: an OpenAI-format request (sk-agent, any `AsyncOpenAI` consumer) is converted to Anthropic shape, run through the **same** routing pipeline (`getHandlerForRequest` → `ComposedHandler.handle`), and the response translated back to OpenAI wire shape. The OpenAI client therefore inherits the routing cascade, budget failover, accounting, and leak policy for free — it flips onto the hub by changing `base_url` alone.

- **Request converter**: `handlers/shared/format/openai-request-to-anthropic.ts` — system/developer → top-level `system`; user (string or parts incl. `image_url`) → content blocks; assistant (`tool_calls`/`reasoning_content`) → `tool_use`/`thinking` blocks; `tool` role → `tool_result`; function tools → Anthropic `input_schema`; `tool_choice` mapping; defaults `max_tokens` (Anthropic requires it, OpenAI doesn't).
- **Response translators**: `handlers/shared/anthropic-to-openai.ts` — `anthropicMessageToChatCompletion` (non-streaming: collected message → `chat.completion` JSON, computes `total_tokens`) and `createOpenAIChatStreamFromAnthropic` (streaming: Anthropic SSE → `chat.completion.chunk` SSE + `data: [DONE]`). `thinking` blocks surface as `reasoning_content` (the OpenAI extension DeepSeek/GLM use); `stop_reason` maps to `finish_reason` (`end_turn`/`stop_sequence`→`stop`, `tool_use`→`tool_calls`, `max_tokens`→`length`). Never-hang holds: a malformed stream degrades to a single terminal chunk + `[DONE]`.
- **Relay**: path-aware (`relay.ts`) — a sidecar forwards to the SAME route the client hit, so an OpenAI request on a sidecar reaches the hub's `/v1/chat/completions` in NOMINAL mode (preserves the resilience model). The deep liveness probe stays on `/v1/messages`.
- **Out of scope** (for now): `/v1/models` discovery, OpenAI web-search tool interception, per-role thinking policy on the OpenAI path.

## Traffic Analysis

**Use the scripts, not hand-rolled grep.** The proxy log format has traps that produce false positives when grepped naively (see `proxy-log-monitoring` memory: `bytes=NNNN` matching error codes, timestamp digits matching `429`, `[msg:N]` body previews matching keywords). The scripts below encode the precise filters.

Three levels of analysis — pick by need:

| Need | Script | Source | Speed |
|------|--------|--------|-------|
| **Live surveillance** (cron, quick health check) | `traffic-live.ps1` | `docker logs` stdout | fast |
| **Rich detail** (workspace, session, CC version, tokens) | `traffic-summary.ps1` / `traffic-sessions.ps1` | `req-*.json` captures | slower |
| **"Where's the Anthropic traffic from?"** (recurring leak question) | `traffic-anthropic.ps1` | `req-*.json` captures | slower |
| **History** (past days from compressed archives) | `traffic-history.ps1` | `captures-*.7z` | slow |

### Scripts

| Script | Purpose | Usage |
|--------|---------|-------|
| `traffic-live.ps1` | **Live analysis from docker logs** — model/machine/handler distribution, precise error counts, never-hang check, Anthropic leak check, session-loop detection. This is what the 6h surveillance cron runs. **`-Container` defaults to `claudish-proxy` (the hub name) — on a sidecar machine you MUST pass `-Container claudish-sidecar`, otherwise the script exits 1 with `No such container`.** | `.\scripts\traffic-live.ps1 [-Hours N] [-Container name] [-AnthropicMachines 'host1,host2']` |
| `traffic-summary.ps1` | Overview from captures: machines, models, workspaces, sessions | `.\scripts\traffic-summary.ps1 [-Hours N]` |
| `traffic-sessions.ps1` | Detailed session list with timing, models, data volume | `.\scripts\traffic-sessions.ps1 [-Hours N] [-All]` |
| `traffic-anthropic.ps1` | **Answers "where does the Anthropic traffic come from?"** — attributes every Anthropic-native (opus/fable) request by **machine + workspace** (workspace = proof, from the system prompt; not stdout). Per-request verdict: `[OK]` ai-01 · `[REVIEW]` po-2025 · `[INFO]` fable during a `-FableOverrideActive` window · `[LEAK-SUBAGENT]` rogue Opus sub-agent (`cc_is_subagent=true`, **exit 1**) · `[REVIEW-INTERACTIVE]` user-driven non-ai-01 session (exit 0). sonnet-4-6 shown separately (remapped to glm → not Anthropic). | `.\scripts\traffic-anthropic.ps1 [-Hours N] [-FableOverrideActive]` |
| `traffic-history.ps1` | Historical analysis from 7z archives | `.\scripts\traffic-history.ps1 [-Date yyyy-MM-dd] [-Days N]` |
| `compress-captures.ps1` | Nightly 7z compaction + GDrive backup + 30d local purge (scheduled task) | Runs automatically at 04:17 |
| `claudish-watchdog.ps1` | Proxy health: tool-call stream test + proactive restart (uptime >11h) + auto-recovery on hang. Scheduled every 15min. | Runs automatically |
| `CaptureUtils.psm1` | Shared module (capture parsing, device mapping, 7z extraction) | Imported by the scripts above |

### Quick Commands

```powershell
# Live health check — what's happening right now?
.\scripts\traffic-live.ps1 -Hours 1

# Standard 6h surveillance window (cron default)
.\scripts\traffic-live.ps1 -Hours 6

# On a SIDECAR machine (ai-01, po-2024...) the container is not named claudish-proxy.
# Expect ~0 requests when the sidecar is NOMINAL: a relayed request writes no capture
# and emits no [Request] line, so local traffic analysis is blind by construction.
.\scripts\traffic-live.ps1 -Hours 3 -Container claudish-sidecar

# Rich detail: which workspace/session is active?
.\scripts\traffic-summary.ps1 -Hours 2
.\scripts\traffic-sessions.ps1

# Historical analysis from compressed archives
.\scripts\traffic-history.ps1 -Days 7
```

### Capture Format

- **`req-*.json`** — Single-line JSON with full Anthropic request body (messages, system, tools, metadata). Extractable: machine (X-Claudish-Machine header), workspace (from system prompt), session_id (from metadata.user_id), CC version (from billing header). Written to `/captures` inside the container, bind-mounted to `D:\claudish-captures` (persists across container recreates).
- **`resp-*.sse`** — Response SSE with metadata header (elapsed_ms, stop_reason, event count). Correlates with req via shared counter (req-1-0042 → resp-1-r0042).
- **Archives** — `D:\claudish-captures\archive\captures-YYYY-MM-DD.7z` (LZMA2, ~100-130:1 ratio), mirrored to `G:\Mon Drive\MyIA\backups\claudish-captures\` via Google Drive Desktop (plain Windows file copy, no API). Local purge >30 days (only after confirming the GDrive copy).

### Machine Attribution

Machines are identified by the `X-Claudish-Machine` header (set via `ANTHROPIC_CUSTOM_HEADERS` in Claude Code settings). When missing, `CaptureUtils.psm1` falls back to device_id fingerprinting. Known device IDs are hardcoded in the module's `$DeviceMap` (currently partial — po-2023 + ai-01 only; update when new machines are seen without the header).

### Anthropic Leak Diagnostics

By cluster policy, **Anthropic-billed models (Opus, Fable, Sonnet) must come from `myia-ai-01` only**.

**For the recurring "where is the Anthropic traffic coming from (machine + workspace)?" question, use `traffic-anthropic.ps1`** — it attributes each Anthropic-native request to its machine AND workspace (the workspace is the proof, read from the system prompt in the capture, not stdout), and — crucially — it splits a non-ai-01 hit into `[LEAK-SUBAGENT]` (a rogue Opus sub-agent, `cc_is_subagent=true`, the dangerous kind → exit 1) vs `[REVIEW-INTERACTIVE]` (a user driving their own interactive session on their own machine → exit 0, not alarmed). That split is what stops the tool from crying wolf on legitimate dev sessions.

`traffic-live.ps1` gives the faster stdout-only pass and flags Anthropic traffic from other machines automatically:

- **[OK]** — authorized machine (`-AnthropicMachines`, default `myia-ai-01`).
- **[REVIEW]** — `myia-po-2025`: may run an authorized Safari workflow (agent-sdk / VS Code) under Anthropic. **Do not auto-flag as leak** — confirm with the user first (lesson 2026-06-21: 6 false WARNs raised on po-2025 before learning Safari was authorized).
- **[LEAK]** — any other machine on Anthropic. Investigate.

**Sub-agent leaks vs legitimate sessions** — the distinction that matters:
- **Real sub-agent leak** = requests carry `cc_is_subagent=true` (in the billing header, *not* on the stdout `[Request]` line) + Anthropic model + non-authorized machine. The Agent tool spawns sub-agents that default to "best available" = Opus.
- **Legitimate Anthropic session** = `agent-sdk/X` + entrypoint `claude-vscode` + same source IP across requests + `msgs=60+` (large context = main session, not sub-agent). No `cc_is_subagent`.

`cc_is_subagent` lives in the request body, not stdout — so it's not visible via `docker logs` alone. To confirm a sub-agent leak, inspect a capture:
```bash
# Find the billing header in a suspect capture
docker exec claudish-proxy sh -c "head -c 500 /captures/req-1-NNNN-*.json"
# Look for: cc_is_subagent=true  → sub-agent. Absent → main session (not a leak).
```

**Fix for a confirmed leak:** add a global rule in `~/.claude/rules/` instructing the model to always specify `model: "sonnet"` (or equivalent) when spawning sub-agents, reserving Opus for genuinely complex tasks. This is client-side behavior — not fixable in the proxy.

## Debug Logging

Debug logging is behind the `--debug` flag and outputs to `logs/` directory. It's disabled by default.
Keep full debug logging (including empty chunks, raw deltas) in log files — needed to understand real model streaming behavior. Suppress noise at the registration/initialization level (e.g., conditional middleware), not at the streaming data level.

### Raw SSE Capture (v5.14.0+)

When `--debug` is active, both stream parsers log raw SSE events:
- `[SSE:openai] {...}` — every OpenAI SSE data line
- `[SSE:anthropic] {...}` — every Anthropic SSE data line

These are greppable and extractable into test fixtures for regression testing.

## Debugging Failed Model Translations

When a model produces wrong output (0 bytes, garbled, wrong format), use this workflow:

### 1. Reproduce with --debug
```bash
claudish --model minimax-m2.5 --debug "say hello"
# Debug log written to logs/claudish_YYYY-MM-DD_HH-MM-SS.log
```

### 2. Verify wiring with --probe
```bash
claudish --probe minimax-m2.5
# Shows: transport, format adapter, model translator, stream format, overrides
```

### 3. Analyze the debug log
Use the `/debug-logs` slash command in Claude Code:
```
/debug-logs logs/claudish_2026-03-17_09-41-32.log
```

This command:
1. Reads the log and counts text chunks, tool calls, HTTP errors, fallback chains
2. Diagnoses the failure mode (no SSE content, text but 0 stdout, wrong parser, etc.)
3. Extracts SSE fixtures from `[SSE:*]` lines using `test-fixtures/extract-sse-from-log.ts`
4. Adds a regression test to `format-translation.test.ts`
5. Runs tests to confirm the regression is captured

### 4. Extract fixtures manually (alternative)
```bash
bun run packages/cli/src/test-fixtures/extract-sse-from-log.ts logs/claudish_*.log
# Creates: test-fixtures/sse-responses/<model>-<format>-turn<N>.sse
```

### 5. Run format translation tests
```bash
bun test packages/cli/src/format-translation.test.ts
```

## Channel Mode (v6.4.0+)

The MCP server supports a channel mode that enables async model sessions with push notifications.

### Architecture

Uses the low-level `Server` class (not `McpServer`) from `@modelcontextprotocol/sdk/server/index.js` to declare `experimental: { 'claude/channel': {} }` capability. The SDK's `assertNotificationCapability()` has no default case — custom notification methods like `notifications/claude/channel` pass through.

### Components (`packages/cli/src/channel/`)

- **SessionManager** — spawns `claudish --model X --stdin --quiet` child processes, tracks lifecycle, enforces timeouts
- **SignalWatcher** — per-session state machine (starting→running→tool_executing→waiting_for_input→completed/failed/cancelled)
- **ScrollbackBuffer** — in-memory ring buffer (2000 lines) for session output

### MCP Tools (11 total)

- **Low-level** (4): `run_prompt`, `list_models`, `search_models`, `compare_models`
- **Agentic** (2): `team`, `report_error`
- **Channel** (5): `create_session`, `send_input`, `get_output`, `cancel_session`, `list_sessions`

Tool gating via `CLAUDISH_MCP_TOOLS` env var: `all` (default), `low-level`, `agentic`, `channel`.

### Tool Registration Pattern

Uses a `ToolDefinition[]` registry with raw JSON Schema (not Zod). Two `setRequestHandler` calls replace McpServer's ergonomic API:
- `ListToolsRequestSchema` → returns filtered tool list
- `CallToolRequestSchema` → dispatches to handler by name

### Channel Notifications

`server.notification({ method: "notifications/claude/channel", params: { content, meta } })` — pushed by SessionManager's `onStateChange` callback on state transitions. The method, capability, and params shape match Anthropic's [Channels reference](https://code.claude.com/docs/en/channels-reference) byte-for-byte.

The wire format is contractually pinned by `channel-wire-format.test.ts`:

```json
{
  "method": "notifications/claude/channel",
  "params": {
    "content": "<string>",
    "meta": {
      "session_id": "<8-char hex>",
      "event": "starting|running|tool_executing|waiting_for_input|completed|failed|cancelled",
      "model": "<model-id>",
      "elapsed_seconds": "<numeric string>",
      "task_id": "<same as session_id>",
      "status": "working|input_required|completed|failed|cancelled",
      "created_at": "<ISO 8601 from session start>",
      "last_updated_at": "<ISO 8601 at notification time>"
    }
  },
  "jsonrpc": "2.0"
}
```

When rendered by Claude Code, each notification arrives in the agent's context as:

```
<channel source="claudish" session_id="…" event="…" model="…" elapsed_seconds="…">
<content here>
</channel>
```

`meta` keys must match `[a-zA-Z0-9_]+` — Claude Code silently drops keys with hyphens or other characters. Our schema uses underscore-only keys (`session_id`, `elapsed_seconds`, etc.); when adding new `extraMeta` keys via `SignalWatcher`, keep this constraint.

The `task_id` / `status` / `created_at` / `last_updated_at` fields are SEP-1686 (MCP Tasks) forward-compatibility — additive only, no current consumer behavior change. The 7-value `event` collapses to the 5-value `status` per `EVENT_TO_TASK_STATUS` in `mcp-server.ts`. When Claude Code ships `notifications/tasks/status` receiver support, the migration is a method-name swap + payload restructure; see `ROADMAP.md` (Channel notifications → Phase 2) and `ai-docs/sessions/dev-research-mcp-tool-progress-20260508-235612-8d9da3e8/sep-1686-migration-schema.md` for the full plan.

### Enabling channel rendering in Claude Code

The Claudish MCP server emits the documented wire format, but Claude Code gates channel **registration** behind several conditions that have nothing to do with the wire contract. All of these must be satisfied for `<channel>` blocks to surface in the agent's context:

| Requirement | Why |
|---|---|
| Claude Code v2.1.80 or later | Channels feature minimum version |
| Anthropic auth via claude.ai OR Console API key | Channels are NOT supported on Bedrock, Vertex, or Foundry |
| Interactive session (no `-p` / `--print`) | Channel registration is bound to the interactive event loop. Empirically verified: in `-p` mode the registration codepath never runs and frames are silently dropped |
| Server defined in project `.mcp.json` or `~/.claude.json` | `--mcp-config` is NOT consulted by the channel resolver. Tools loaded via `--mcp-config` work; channels declared by the same server do not register |
| Server explicitly named in `--channels` OR `--dangerously-load-development-channels` | Being in MCP config alone is not enough. Per Anthropic docs: *"a server also has to be named in `--channels`"* |
| Org policy `channelsEnabled: true` (Team/Enterprise only) | Pro/Max users without an org skip this check |

**Launch command — bare server**:

```bash
# in a directory with .mcp.json containing a "claudish" entry
claude --dangerously-load-development-channels server:claudish
```

**Launch command — via the Magus `code-analysis` plugin** (Claudish is bundled there as an MCP server):

```bash
claude --dangerously-load-development-channels plugin:code-analysis@magus
```

The `--dangerously-load-development-channels` flag triggers a one-time confirmation prompt per session. To remove that prompt, the plugin would need to be added to Anthropic's curated channel allowlist (security review required) or to your org's `allowedChannelPlugins` managed setting.

### Diagnostic tracing — `CLAUDISH_CHANNEL_TRACE=1`

When the channel pipeline appears broken (e.g., client never renders `<channel>` blocks), set `CLAUDISH_CHANNEL_TRACE=1` before starting the MCP server. The diagnostics module (`packages/cli/src/channel/diagnostics.ts`) then emits `[channel-trace] …` lines to stderr at three checkpoints:

1. `fired sid=… type=… model=… elapsed=…s` — onStateChange callback entered (producer side fires)
2. `callback returned sid=… type=…` — bridge invoked `server.notification()` without throwing
3. `WIRE-OUT {…json…}` — the JSON-RPC frame literally hit stdout

If you see (1) but not (2): the bridge is throwing or rejecting silently.
If you see (1)+(2) but not (3): the SDK's transport is dropping the frame.
If you see all three but the client doesn't render the notification: the issue is client-side — most often one of the gating conditions in "Enabling channel rendering in Claude Code" above is unmet.

Off by default. Zero overhead in production.

When the MCP server is spawned by a host that captures stderr (e.g. Claude Code), set `CLAUDISH_CHANNEL_TRACE_FILE=/path/to/log` alongside `CLAUDISH_CHANNEL_TRACE=1` to mirror trace lines to a file you can `tail` from outside the host process. The file is opened with `appendFileSync` so multiple sessions append safely.

Two diagnostic scripts:
- `packages/cli/src/channel/test-helpers/channel-diagnostic.ts` — drives the MCP server with raw JSON-RPC against the OpenRouter free model. Confirms the producer→bridge→wire pipeline.
- `packages/cli/src/channel/test-helpers/client-diagnostic.ts` — spawns `claude -p` against the instrumented MCP server and compares what the server sent vs. what the client surfaced. Useful for diagnosing client-side gating.
- `packages/cli/src/channel/test-helpers/claudish-mock.ts` — a standalone mock MCP server that exposes a single `start_mock_session` tool, then emits a scripted sequence of 6 channel notifications over ~9 seconds. Decouples channel-rendering tests from real-model behavior.

### Testing

```bash
bun test --cwd . ./packages/cli/src/channel/*.test.ts
```

65 tests across 5 files: scrollback-buffer (11), signal-watcher (12), session-manager (21), e2e-channel (15), channel-wire-format (6). The wire-format tests run without an API key by using the fake-claudish PATH shim, so they execute on every CI run.

E2E tests use `--strict-mcp-config --bare --dangerously-skip-permissions` for isolation. SessionManager tests use a fake-claudish PATH shim (`channel/test-helpers/fake-claudish.ts`).

## Test Infrastructure

### Format Translation Test Harness
`packages/cli/src/format-translation.test.ts` — SSE replay tests for the full translation pipeline.

**Fixture-based**: Each `.sse` file in `test-fixtures/sse-responses/` is a captured SSE stream from a real provider response. Tests replay fixtures through the stream parser and assert correct Claude SSE output.

**Helpers**: `parseClaudeSseStream()`, `extractText()`, `extractToolNames()`, `extractStopReason()`, `fixtureToResponse()`

**Adding regression tests**: After extracting fixtures from a debug log, add a `describe("Regression: <model>")` block. Template is at the bottom of the test file.

## Version Bumping Checklist

When releasing a new version, update ALL of these locations:
1. `package.json` (root monorepo version)
2. `packages/cli/package.json` (npm-published package - **CI/CD publishes from here**)
3. `packages/cli/src/version.ts` (fallback VERSION constant — moved from cli.ts in v7.0.0)

The fallback VERSION in version.ts ensures compiled binaries (Homebrew, standalone) display the correct version when package.json isn't available. The `packages/cli/package.json` version is what npm publishes - if it's not updated, npm publish will fail.

## Learned Preferences

### Tools & Commands
<!-- learned: 2026-03-28 session: 03cd7cc5 source: repeated_pattern -->
- Use `bun` for all package management and scripts (`bun run build`, `bun test`, etc.) — not npm or yarn
<!-- learned: 2026-04-06 session: df311293 source: repeated_pattern -->
- Use Grep/grep tool for code investigation instead of mnemex — prefer built-in search tools during investigation phases

### Workflow
<!-- learned: 2026-04-06 session: df311293 source: explicit_rule -->
- Don't run claudish directly in main bash — use dedicated channel sessions or `/delegate`
