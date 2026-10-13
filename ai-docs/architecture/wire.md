# The wire reader: every request from the connection's `wire`

> How claudish decides the API, URL, output-limit field, reasoning encoding, mode and speed of
> a request: from the catalog's per-connection `wire` and the route registry, never from a
> model name. Read before touching `providers/connection-*.ts`, `providers/wire-*.ts`,
> `providers/declared-wire.ts`, `ComposedHandler` step 5w, an adapter's token or reasoning
> fields, or the advisor's request building.

Spec: Models Index `ai-docs/claudish-wire-requirements.md` (R1–R13) and
`ai-docs/claudish-catalog-3.7.0.md`. Plan and gap counts: `ai-docs/reports/wire-reader-plan-20261012.md`.

## Why it exists

Catalog 3.7.0 (live 2026-10-08) changed what the model-level `tokenParam` and `endpoints` mean:
they now describe the model OWNER's direct connection only. claudish 10.4.1 applied the
model-level field to every chat body on every host, so GPT and Grok chat requests to gateways
carried `max_output_tokens` (a Responses-only field): about 150 chat connections on generation
`g-20261012101007285-7770c36e`; `fireworks@qwen3.8-max` answered 400. Before that, months of
regressions came from name rules (`requiresResponsesApi`, `includes("codex")`, OpenCode family
lists, effort ladders by `gpt-5.x`) being falsified by each new model release.

## The pipeline

1. **Data** (`all-models-cache.ts`, `catalog-client.ts`). The refresh reads the slim model pages,
   the plans, and `queryModels?catalog=routes&generationId=<same>`; a different generationId
   restarts the whole refresh once. A 3.7.0 cache is rejected whole if any mapped connection lacks
   a wire, names a missing route profile, or has a known API without a base URL — a partial wire
   table would send some requests from data and the rest from nothing. Reads are memoized by mtime
   and size: the request path reads the 2.7 MB file per request.
2. **Connection** (`connection-resolver.ts`). The provider's exact route binding plus the exact
   wire id; never a family or sibling. It carries the wire, the registry profile, the model's
   VENDOR (catalog `provider`) and the owner's direct-connection wire.
3. **Handler** (`wire-handler.ts`, from `createHandlerForProvider` before any profile). Adapter by
   `wire.api`, URL from the registry (a user base-URL override is kept and logged), the provider's
   own transport only for auth and identity headers (Codex keeps its credential-decided host:
   OAuth → chatgpt.com, API key → api.openai.com).
4. **Request** (`ComposedHandler` step 5w → `wire-request.ts`). After every adapter has run, every
   field any of them may have emitted for the limit, reasoning, mode or speed is removed, then the
   wire's values are written at their RFC 6901 pointers.

## Decisions (Jack, 2026-10-12) and where they diverge from the backend spec

| Topic | Backend spec | claudish |
|---|---|---|
| Effort not in `effort.values` | refuse | clamp to the nearest published value, ties up |
| `tokenParam` / `reasoning` `unknown` | send nothing | try the owner's direct-connection value when it is on the SAME API; drop exactly those borrowed fields on the 400 that names them (`recoverBorrowedWireFields`) |
| `wire.status: unknown`, or model not published for the provider | APIs in fixed order | same (`TryInTurnHandler`): advance only on 404/405/protocol-400, remember the winner per generation |
| No catalog | wait or fail | local providers only; catalog providers wait, then refuse per request (below) |
| Pro / speed | `--mode`, `--speed` suggested | `model+pro`, `model#fast` |

`not_applicable` is an ANSWER, never borrowed over (Codex found the shaper treating it like
`unknown`). Mode and speed are never borrowed: they carry entitlement and price.

## Traps

- **Older claudish erases the registry.** Releases before 10.5.0 rewrite
  `cloud-models-catalog-v3.json` on every refresh without `routeRegistry` (measured 2026-10-14:
  an installed 10.4.1 in another session replaced the cache with a newer generation). The
  registry therefore also lives in a sidecar, `cloud-models-catalog-v3.routes.json`, attached on
  read when its generation matches; when it does not, `ensureRouteRegistryReady` fetches only
  `catalog=routes` for the cache's generation (1.4 s live, against 9.3 s for a full refresh).
- **The first run after an upgrade.** The old cache has no registry; the refresh that writes it
  measured 9.3 s, and the request path first waited 5 s and refused. The proxy caches handlers
  per model, so the refusal stuck for the whole session (`--probe gpt-6-sol` refused cx@, oai@ and
  zen@ while grok-4.7, built after the refresh, answered). Now: 30 s wait, then
  `CatalogPendingHandler`, which rebuilds per request and refuses only while the catalog is still
  missing. Never return a cached refusal for a transient state.
- **`+` is ALSO the route-chain separator** (`team` spawns `zgo@x+mm@y+or@z`). `parseModelChain`
  attaches a segment that is only a mode word to the spec before it; real chain elements always
  contain `@`. `-pro` (102 ids) and `-fast` (22) are real model ids; `>>` and `|` are shell
  operators (an unquoted `>>fast` silently redirects to a file). `#` is literal mid-word in bash
  and default zsh; with zsh `extendedglob` it fails loudly ("no matches found").
- **Markers travel per request** (`wireMarkerContext`, AsyncLocalStorage), never in a cached
  handler or a body: the native passthrough forwards the body verbatim.
- **A name gate one layer down.** Removing the dialect choice left two: the shared message
  converter added the Grok tool prompt for any id containing "grok", and the Gemini
  thought-signature middleware re-filtered itself by name after being selected from data. Both
  now read the connection's vendor (`setUpstreamVendor`, `alwaysHandle`). Search for the NAME
  check at every layer, not just the selector.
- **Codex's reasoning summary.** The wire does not publish `reasoning.summary`; the shaper drops
  the whole `reasoning` object. Claude Code's visible thinking needs it, so the Codex transport
  restores `summary: "auto"` where reasoning was sent.
- **Kimi Code `k3`.** Its `disable` is served by K2.8 Preview (`served_model_changes`). Reasoning
  stays on and the log says why, unless `--accept-served-model` (env
  `CLAUDISH_ACCEPT_SERVED_MODEL=1`) names the swap.

## Off-catalog requests

- **Custom endpoints** declare their wire (`config-schema.ts` `CustomEndpointWireSchema`); the
  documented default is the transport's API, `max_tokens` (`max_output_tokens` on Responses), no
  reasoning. They go through step 5w like a catalog connection (`declared-wire.ts`). LiteLLM and
  OpenRouter/Poe models the catalog does not publish get the same default.
- **Dynamic subscriptions** (`gk@`, `ag@`, `dv@`) publish no wire; the account decides what they
  serve. Only `gk@` names a dialect, explicitly in its profile (Grok effort with learn-on-400).
  Nothing picks a dialect by model name any more; `dialect-manager.ts` serves local models only.
  One model quirk no wire field describes stays, keyed on the catalog VENDOR: a `minimax` model
  on any connection gets the MiniMax dialect for its temperature clamp (its reasoning fields are
  overwritten by step 5w). Dropping it with the name dialects was caught in test review.
- **The advisor** resolves the same connection, follows `wire.api` (Chat, Responses, Messages or
  Gemini, non-streamed), takes its URL from the registry and shapes the body with the same step.
  The provider docs' endpoints remain only as the cold-catalog fallback, logged when used.
- **Discovery** (`model-discovery.ts`) lists models from the registry base + `/models` for a
  catalog-routed provider (OpenCode moved Zen to `opencode.ai/inference/v1` on 2026-10-12);
  a user base-URL override keeps the definition's path.
- **Vision** with a connection reads the catalog's `inputModalities` / `supportsVision`; unknown
  sends the image the user attached.

## Verification on record

- 1770 mapped connections on generation `g-20261012101007285-7770c36e`: every one carries a wire,
  every known API has a base URL, the registry covers every claudish route binding.
- Intercepted end-to-end capture of 19 connections, each body exactly the wire's
  (`ai-docs/sessions/…/p3-capture.ts`, gitignored).
- Live `--probe` (2026-10-12): every funded hop answered — `oai@gpt-6-sol` on `/v1/responses`,
  `zengo@grok-4.7` on Responses, `kc@` on `api.kimi.ai`, `oc@` on `ollama.com/v1` with plain ids,
  `qtoken@` on the qwencloud host, `fireworks@qwen3.8-max` with `max_tokens`. Zen and Together
  answered 402 (account funds).
- `providers/no-name-rules.test.ts` scans every non-test source file (NUL-safe: `devin.ts` and
  `grok-effort-support.ts` contain NUL bytes) for the removed identifiers.
