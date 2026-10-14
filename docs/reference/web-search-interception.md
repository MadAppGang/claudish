# Web search interception — full reference

**Deferred from `CLAUDE.md` (v7.1+ section).** The decisional summary stays in `CLAUDE.md`; this file holds the detail.

When providers emit web search tool calls (`web_search`, `brave_web_search`, `tavily_search`) or GLM's `<searchWeb>` tags, claudish intercepts them instead of forwarding to the provider (which would fail for non-Anthropic providers).

**HARD constraint**: a failed search/fetch must NEVER stop the agent. Every path degrades gracefully to well-formed text — no throws, no hung streams.

## Three interception paths

1. **Structured tool_call** (`openai-sse.ts`): provider web search tool calls are detected via `web-search-detector.ts`. **If the client declared a `WebSearch` tool in the request** (checked against `toolSchemas`), the call is **remapped** to a synthetic `WebSearch` tool_use block with `stop_reason: "tool_use"` — Claude Code then executes its own WebSearch (which arrives as a sub-agent request, path 3) and the agentic loop continues. If WebSearch is NOT declared (e.g. sub-agents without web tools), the call is `suppressed` and results are injected as a text block with `end_turn` (legitimate there).

2. **GLM `<searchWeb>` tags** (`openai-sse.ts`): GLM models emit `<searchWeb><query>...</query></searchWeb>` in text content. At finalize, same remap logic: WebSearch declared → synthetic tool_use; otherwise SearXNG is called and results are appended as a text block.

3. **Sub-agent requests** (`proxy-server.ts`): Claude Code's own WebSearch/WebFetch tools send a single user message ("Perform a web search for the query: X" / "Perform a web fetch for the URL: X"). Intercepted at the proxy level before handler selection; results returned as text with `end_turn` (correct — the sub-agent's job is to return text).

**Why the remap matters (CoursIA incident 2026-06-10)**: suppress + inject-text + `end_turn` ends the assistant turn on raw search results — the agent stalls instead of using them. Remapping to the client's WebSearch keeps `stop_reason: "tool_use"`, so results come back as a tool_result and the loop continues. Regression tests: `format-translation.test.ts` ("web search remap").

## Execution backends (fallback chains)

`web-search-executor.ts` resolves each search/fetch through a chain; the first usable result wins:

- **Search**: MCP `searxng_web_search` (if `SEARXNG_MCP_URL` set, deadline ≥ 5s) → direct HTTP `{SEARXNG_URL}/search?format=json` (2 attempts inside the caller's budget, 5s/attempt) → error text.
- **Fetch**: MCP `web_url_read` (12s, real fetch + markdown) → MCP `web_url_read` with `https://r.jina.ai/<url>` prefix (bypasses 403 on bot-hostile hosts, e.g. npmjs) → direct streaming HTTP with 500KB byte cap → error text.

The MCP client (`handlers/shared/mcp-searxng-client.ts`) is a minimal JSON-RPC streamable-http client (no SDK, no stdio): handles both `application/json` and `text/event-stream` response formats, lazy `initialize` handshake with `mcp-session-id` caching when the server demands a session, strict `AbortSignal.timeout` deadlines, and a non-throwing `{ ok, text|error }` contract. Per-call duration is logged as `[MCP-SearXNG] tools/call <name> <ms>ms ok=<bool>` for overhead measurement vs direct HTTP.

## Configuration

- **`SEARXNG_MCP_URL`** env var (optional): URL of the MCP searxng endpoint (e.g. `https://mcp-tools.myia.io/searxng/mcp`). When unset, the MCP layer is skipped entirely — zero behavior change for existing deployments.
- **`MCP_AUTH`** or **`SEARXNG_MCP_TOKEN`** env var: bearer token for the MCP endpoint. Never hardcode; provisioned via RooSync.
- **`SEARXNG_URL`** env var: URL of the SearXNG instance (e.g. `http://search.myia.io`) for the direct HTTP fallback. **No built-in default** (#26 port of the pre-sync `1fffab8` fix): the old `|| "http://search.myia.io"` fallback was removed because the host has required Basic Auth since 2026-08-19 — the default could only 401. When unset, direct HTTP search is disabled (one `logStderr` line **per process** — visible with debug off — then a factual "not configured" text, zero network calls, no latency sample) and interception falls through gracefully with a fallback message.
- **Deadlines**: MCP search ≥ 5s, MCP fetch 12s, direct HTTP search 5s/attempt × 2 attempts inside an 8s total budget (both call paths; `SEARXNG_ATTEMPT_TIMEOUT_MS` overrides the per-attempt value), direct fetch 10s. Non-blocking — every call is bounded. Attempt durations are recorded in a rolling 50-sample window; p50/p95 are logged every 10th sample (`[WebSearch] latency window: n=… p50=…ms p95=…ms`) to quantify drift (roo-extensions #3388 — measured p50 0.92s / p95 2.97s on the LAN endpoint 2026-09-03, 20 samples mixed warm/cold).

## Components

- `handlers/shared/mcp-searxng-client.ts` — MCP streamable-http JSON-RPC client (non-throwing)
- `handlers/shared/web-search-executor.ts` — fallback chains, result formatting, query extraction
- `handlers/shared/web-search-detector.ts` — provider web-search tool name detection
- `handlers/shared/stream-parsers/openai-sse.ts` — remap/suppression + `<searchWeb>` tag detection
- `proxy-server.ts` — sub-agent request interception

---

## `SEARXNG_URL` and Basic-auth credentials

Merged from `CLAUDE.md` on 2026-08-23. Source: `78addbe`.

`SEARXNG_URL` names the SearXNG instance used by the direct-HTTP fallback (for example
`http://search.myia.io`). When unset, the direct-HTTP backend is disabled — no built-in default, one
`logStderr` line per process (visible with debug off), zero network calls — and `executeWebSearch`
short-circuits to the factual "not configured" text (`openai-sse.ts`'s own formula for the same
state) without recording a latency sample — never a throw, never a hung stream.

**Basic-auth credentials go in the URL userinfo**, the standard curl form:

```
SEARXNG_URL=https://user:pass@search.myia.io
```

`searxngConfig()` parses them into an `Authorization: Basic` header and **strips them from the logged
base URL**, so credentials never reach a log line.

**Why this exists.** The public `search.myia.io` has been behind IIS Basic Auth since 2026-08-19
(Windows account `searxng-user`, module `authbas.dll`, realm `myia`) to stop external scraping.
Credential-less WAN clients get 401 — that is what cost one machine its fleet-wide WebSearch that day.

**LAN deployments do not use it.** They reach the backend directly (`http://<lan-ip>:8181`, no auth),
bypassing IIS, and send no header.

**Known follow-up on the infra lane**: SearXNG's own limiter on the backend rejects proxied public
traffic (instant 429 even with valid credentials, user-agent independent — the ARR always sets
`X-Forwarded-For`). Lifting it is coordinated with the maintenance lane, since Basic Auth is the real
gate.


---

# Migrated verbatim from the repo-level `CLAUDE.md` (#445 A1, 2026-10-12)

## Web Search Interception (v7.1+)

Provider web-search tool calls (`web_search`, `brave_web_search`, `tavily_search`) and GLM `<searchWeb>` tags are intercepted, never forwarded (they would fail on non-Anthropic providers).

**The decision that matters**: if the client declared a `WebSearch` tool, **remap** the call to a synthetic `WebSearch` tool_use block with `stop_reason: "tool_use"`, so Claude Code runs its own search and the loop continues. Only when WebSearch is *not* declared (sub-agents without web tools) do we suppress and inject results as a text block with `end_turn`. Suppress-and-inject in the declared case ends the assistant turn on raw search results and **stalls the agent** — the CoursIA incident, 2026-06-10. Regression: `format-translation.test.ts` ("web search remap").

**On the Z.AI wire, `server_tool_use` comes with two siblings** (live capture 2026-08-11, `regression-zai-server-tool-use-live.sse`): the tool **input arrives whole in `content_block_start`** (zero `input_json_delta` — delta-based accumulation left `rawInput` empty on every real stream), and the provider also emits a **`tool_result` block assistant-side** after executing the tool server-side. `tool_result` is user-turn-only on the Anthropic wire, so it must be suppressed exactly like `server_tool_use` (the same results arrive as the preceding text block) — and because that removes a second block, the parser must remap the following deltas/stops down or indices desync ("Content block not found"). Regression: `format-translation.test.ts` ("Chantier D", structural asserts).


**Any frame the parser drops takes its `event:` line and blank separator with it** (S4-a): an `event:` header that reaches the client without its `data:` body kills the turn with `Could not parse message into JSON` — so `event:` lines are held until the data line is adjudicated, on **both** branches (thinking filter and passthrough). The index-mapping layer (jumped starts remapped, the pair remembered so deltas/stops follow) also runs on **both** branches — MiniMax (`shouldFilterThinking()` = true) takes the filtered one — and an **orphan delta/stop** (no block the client opened at that index, e.g. MiniMax-M3's implicit signature block: `signature_delta` + stop at 0 with no `content_block_start`) is **dropped whole**, never re-attached. Synthetic tails (`finalizeWithError`, empty-stream finalization) are built with `JSON.stringify` — never string interpolation of the model name — preserve an upstream-reported `stop_reason`, and never emit a second terminal pair after a real `message_stop`. Production fixtures + pins: `anthropic-sse-s4a.test.ts` (`minimax-m3-anthropic-implicit-signature-r10324/r10416.sse`).

Backends, first usable result wins: MCP `searxng_web_search` (`SEARXNG_MCP_URL`, ≥ 5s) → direct HTTP `{SEARXNG_URL}/search?format=json` (**2 attempts inside an 8s total budget, 5s/attempt** — dimensioned from measured p50 0.92s / p95 2.97s, roo-extensions #3388; `SEARXNG_ATTEMPT_TIMEOUT_MS` overrides) → error text; fetch adds an `r.jina.ai` retry for bot-hostile hosts and a 500KB cap. Every call is deadline-bounded, and direct-HTTP attempt durations feed a rolling 50-sample p50/p95 log (`[WebSearch] latency window: …`) for drift detection. **Basic-auth credentials belong in the `SEARXNG_URL` userinfo** (`https://user:pass@host`, standard curl form): `searxngConfig()` parses them into an `Authorization: Basic` header and strips them from the logged base URL. `search.myia.io` sits behind IIS Basic Auth since 2026-08-19, so credential-less WAN clients get 401; LAN deployments reach the backend directly and send no header. `MCP_AUTH` / `SEARXNG_MCP_TOKEN` are provisioned via RooSync — never hardcode. When `SEARXNG_MCP_URL` is unset the MCP layer is skipped entirely (zero behavior change). Detail: `docs/reference/web-search-interception.md`.
