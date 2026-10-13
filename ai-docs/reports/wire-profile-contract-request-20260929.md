# Wire profile per connection — request to Models Index

Date: 2026-09-29. From: claudish. Status: proposal for the backend developer.

## What claudish needs

To call a model on a provider, claudish needs three facts about that exact connection:

1. **API** — `chat-completions`, `responses`, `anthropic-messages` or `gemini`.
2. **Token parameter** — `max_tokens`, `max_completion_tokens` or `max_output_tokens`.
3. **Reasoning-effort encoding** — where the effort goes in the request body, and the exact wire value for each catalog effort name.

Today the catalog carries (1) and (2) for 73 of 1,143 entries, at model level only, keyed by API family
(`endpoints.openai`, `endpoints.anthropic`, …) rather than by connection. (3) exists as
`reasoning.request` on one connection: `glm-5.3` on `z-ai/direct-api`. Everything else claudish
currently guesses from the model name. claudish is deleting every such guess, so the data must
come from the catalog.

## Failures this week, all from guessing

| Connection | Observed | Catalog state |
|---|---|---|
| `openai/direct-api` · `gpt-6-sol` | Chat Completions: 400 `Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.` With that fixed: 400 `Function tools with reasoning_effort are not supported for gpt-6-sol in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.` `/v1/responses` with the same tools and effort: 200 (effort `medium` and `max`). | No `endpoints`, no `tokenParam`. `curated-reasoning-metadata` has rows for `gpt-6-astra` and `gpt-5.6-*` but none for `gpt-6-sol` or `gpt-6-luna` (both released 2026-09-22). |
| `opencode/go-subscription` · `grok-4.7` | `/zen/go/v1/chat/completions`: 400 `ModelProtocolUnsupported` "Model does not support this protocol." `/zen/go/v1/responses`: 200. | The OpenCode Go docs table lists `/zen/go/v1/responses`. `opencode-zen-pricing.ts` scrapes it into `endpointPath` and uses it only to exclude SystemOne; it is never published. |
| `opencode/*` · `muse-spark-*`, Zen `qwen3.8-max`, Zen `gemini-*` | Not yet failing in claudish only because nobody probed them: the docs tables say `responses`, `chat-completions` and `/v1/models/gemini` respectively, and claudish's family list says otherwise. | Same discarded `endpointPath`. |
| `openai/codex-subscription` · `gpt-6-sol` at effort `max` | claudish sends `high`. | Model-level `reasoning.efforts` says `max` is allowed; claudish's Responses path ignored it (claudish-side bug, being fixed). Shows why the effort encoding must be data. |

Measurements: 2026-09-26, direct requests with the account's own keys.

## Decisions (Jack, 2026-09-29)

1. **Known, never guessed.** claudish reads these facts from the catalog and removes every model-name rule.
2. **Default plus override.** The model carries a default wire profile. A connection carries only the fields
   where that provider differs. Effective value for each field = connection field if present, else model field.
3. **Absent means unknown.** When neither level has the field, claudish tries the provider's declared APIs in
   turn, advances only on a protocol-mismatch answer (never on auth, rate-limit or network errors), and
   remembers what worked for that connection. That keeps a gap survivable, but every gap costs users a failed
   request, so the gap report below matters.
4. **Dynamic subscriptions are out of scope.** `grok-subscription`, `antigravity` and `devin` get their models
   from the account's own dynamic models catalog, so their wire facts come from there too (`gk@` discovery
   already declares `api_backend` per model; Antigravity and Devin have one protocol for every model).

## Proposed contract

Model level, the default:

```json
{
  "modelId": "minimax-m3",
  "wire": {
    "api": "anthropic-messages",
    "tokenParam": "max_tokens",
    "evidence": { "method": "docs", "sourceUrl": "https://…", "observedAt": "2026-09-29" }
  }
}
```

Connection level, only what differs:

```json
{
  "routeStatus": "mapped",
  "route": { "routeId": "opencode", "routeProfileId": "zen" },
  "externalModelId": "minimax-m3",
  "wire": {
    "api": "chat-completions",
    "evidence": { "method": "endpoint-table", "sourceUrl": "https://opencode.ai/docs/zen/", "observedAt": "2026-09-29" }
  }
}
```

The `opencode/go-subscription` connection for `minimax-m3` carries no `wire`: Go serves it at `/v1/messages`,
the same as the default.

`gpt-6-sol` would carry a model-level `wire` of `api: "responses"`, `tokenParam: "max_output_tokens"`,
plus the effort encoding, and no override on `openai/direct-api` or `openai/codex-subscription`.

Fields of `wire` (every field optional at connection level):

| Field | Type | Notes |
|---|---|---|
| `api` | existing `EndpointApi` | |
| `tokenParam` | existing `TokenParam` | |
| `toolsWithReasoning` | existing enum | Keep for connections where tools plus reasoning restrict the API. |
| `reasoning` | `{ enable?, disable?, effort? }` | Same shapes as today's `RouteReasoningRequestCapabilities` (JSON Pointer paths, exact wire values keyed by catalog effort name). |
| `evidence` | `{ method, sourceUrl, observedAt }` | `method`: `docs`, `endpoint-table`, `probe`. |

Allowed effort choices stay where they are: model-level `reasoning.efforts` and `defaultEffort`.
`wire.reasoning.effort.values` says how each allowed choice is spelled on this connection.

## Where the data comes from

| Route | Source |
|---|---|
| `opencode/zen`, `opencode/go-subscription` | The OpenCode docs endpoint tables, already scraped. Map `/v1/chat/completions` → `chat-completions`, `/v1/responses` → `responses`, `/v1/messages` → `anthropic-messages`, `/v1/models/gemini` → `gemini`. Emit an override only where it differs from the model default. |
| `openai/direct-api` | The model's OpenAI docs page, plus a probe when a new model appears: one Chat Completions request with one function tool and `reasoning_effort` set. OpenAI's 400 names both the API and the token parameter. |
| Routes with one API for every model (`openai/codex-subscription` → `responses`; `openrouter/gateway`, the Anthropic-compatible subscriptions, …) | Declare it once on the route profile inside Models Index and let the builder emit connection overrides wherever the model default differs. The published contract stays two-level. |
| Effort encoding | Provider documentation for that API (for OpenAI: `/reasoning_effort` on Chat Completions, `/reasoning/effort` on Responses), or a probe. Publish nothing that neither establishes. |

## Gap report

Each generation's publication report lists mapped connections whose effective `wire.api` is missing,
grouped by route. A model that has an `openai/direct-api` (or any other native API) connection but no
model-level `wire` is flagged by name — that is exactly the `gpt-6-sol` case, and it went unnoticed for
four days while the `curated-reasoning-metadata` file was edited on the model's release day.

## What claudish does with it

- Resolves the effective `wire` for the selected connection and builds the request from it: endpoint, body
  format, token parameter, effort encoding.
- Falls back to trying the provider's declared APIs in turn only when `wire.api` is absent (decision 3).
- Deletes: the OpenCode model-family list in `openCodeZenProfile`, the name test in `requiresResponsesApi`,
  the `codex` substring test in `OpenAIProviderTransport`, and the name fallbacks in `OpenAIAPIFormat` and
  `CodexAPIFormat`.
- Reads `api_backend` from `gk@` discovery.

## Open questions for Models Index

1. Replace `reasoning.request` with `wire.reasoning`? claudish does not read `reasoning.request` yet, so
   nothing released depends on it.
2. Is `api` enough, or should `wire` also carry the endpoint path? OpenCode's Gemini path (`/v1/models/gemini`)
   is not the standard Gemini path, which argues for an optional `path`.
3. Model-level `endpoints` and `tokenParam` are read by released claudish. Retire them on a named generation,
   as `pricing.shape` → `pricing.type` was retired?
4. The live generation on 2026-09-27 was `g-20260923145315478-d7a326bd`. Is four days the expected
   publication cadence?
