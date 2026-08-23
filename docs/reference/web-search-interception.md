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

- **Search**: MCP `searxng_web_search` (if `SEARXNG_MCP_URL` set, 5s deadline) → direct HTTP `{SEARXNG_URL}/search?format=json` (3s) → error text.
- **Fetch**: MCP `web_url_read` (12s, real fetch + markdown) → MCP `web_url_read` with `https://r.jina.ai/<url>` prefix (bypasses 403 on bot-hostile hosts, e.g. npmjs) → direct streaming HTTP with 500KB byte cap → error text.

The MCP client (`handlers/shared/mcp-searxng-client.ts`) is a minimal JSON-RPC streamable-http client (no SDK, no stdio): handles both `application/json` and `text/event-stream` response formats, lazy `initialize` handshake with `mcp-session-id` caching when the server demands a session, strict `AbortSignal.timeout` deadlines, and a non-throwing `{ ok, text|error }` contract. Per-call duration is logged as `[MCP-SearXNG] tools/call <name> <ms>ms ok=<bool>` for overhead measurement vs direct HTTP.

## Configuration

- **`SEARXNG_MCP_URL`** env var (optional): URL of the MCP searxng endpoint (e.g. `https://mcp-tools.myia.io/searxng/mcp`). When unset, the MCP layer is skipped entirely — zero behavior change for existing deployments.
- **`MCP_AUTH`** or **`SEARXNG_MCP_TOKEN`** env var: bearer token for the MCP endpoint. Never hardcode; provisioned via RooSync.
- **`SEARXNG_URL`** env var: URL of the SearXNG instance (e.g. `http://search.myia.io`) for the direct HTTP fallback. When unset, interception falls through gracefully with a fallback message.
- **Deadlines**: MCP search 5s, MCP fetch 12s, direct HTTP search 3s (5s sub-agent path), direct fetch 10s. Non-blocking — every call races a timeout.

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
`http://search.myia.io`). When unset, interception falls through gracefully with a fallback message —
never a throw, never a hung stream.

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
