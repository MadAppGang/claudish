> FormatConverter / ModelTranslator / ProviderTransport, stream-parser selection, and errors that ride an HTTP 200.
>
> Extracted from `CLAUDE.md` (v7.64.0). Indexed in [`README.md`](./README.md).

# Three-Layer Adapter Architecture (v5.14.0+)

The translation pipeline has three decoupled layers:

## Layer 1: FormatConverter — wire format translation
Translates between Claude API format and target model's wire format (messages, tools, payload).
Each converter declares its stream format via `getStreamFormat()`.
- **Interface**: `adapters/format-converter.ts`
- **Implementations**: OpenAIAdapter, AnthropicPassthroughAdapter, GeminiAdapter, CodexAdapter, OllamaCloudAdapter, LiteLLMAdapter
- **Message/tool conversion**: `handlers/shared/format/openai-messages.ts`, `openai-tools.ts`

## Layer 2: ModelTranslator — model dialect translation
Translates model-specific dialect differences (context windows, thinking→reasoning_effort, vision rules).
- **Interface**: `adapters/model-translator.ts`
- **Implementations**: GLMAdapter, GrokAdapter, MiniMaxAdapter, DeepSeekAdapter, QwenAdapter, CodexAdapter
- **Selection**: `AdapterManager` auto-selects based on model ID

## Layer 3: ProviderTransport — HTTP transport
Handles auth, endpoints, headers, rate limiting. Optionally overrides stream format for aggregators.
- **Interface**: `providers/transport/types.ts`
- **Stream format override**: LiteLLM and OpenRouter implement `overrideStreamFormat()` → `"openai-sse"`

## Composition in ComposedHandler
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

## Stream Parsers
Located in `handlers/shared/stream-parsers/`:
- `openai-sse.ts` — OpenAI SSE → Claude SSE (used by most providers)
- `anthropic-sse.ts` — Anthropic SSE passthrough (MiniMax, Kimi direct)
- `gemini-sse.ts` — Gemini SSE → Claude SSE
- `ollama-jsonl.ts` — Ollama JSONL → Claude SSE
- `openai-responses-sse.ts` — OpenAI Responses API → Claude SSE (Codex)

## Errors that ride an HTTP 200 stream (`stream-head-sniffer.ts`)

The Codex backend (`chatgpt.com/backend-api/codex/responses`) reports capacity faults **inside** a 200 body, not via the status code:

```
200 OK
data: {"type":"response.created", ...}
data: {"type":"response.in_progress", ...}
data: {"type":"error","error":{"code":"server_is_overloaded", ...},"sequence_number":2}
```

Every retry hook in claudish keys off the HTTP **status** (`anthropic-compat.ts`'s 429 loop, `antigravity.ts`'s 429 classifier), so this class of failure bypassed all of them. The parser turned it into an assistant **text block** with `stop_reason: "end_turn"` and `onApiError` only flagged stats — so a transient, textbook-retryable fault became a permanent, successful-looking answer reading `[API Error: server_is_overloaded]`.

`sniffResponsesStreamHead()` peeks at the stream head in `composed-handler.ts` step **7b**, which is the only window where the status code is still ours to choose (once Hono flushes the 200, a 503 is no longer expressible):

- **Retryable** (`server_is_overloaded`, `server_error`, `service_unavailable_error`, prose "overloaded"/"try again later") → re-issue upstream with **progressive** backoff `3s → 15s → 30s` (`STREAM_RETRY_DELAYS_MS`). Progressive, not tight: the outage that motivated this ran ~6.5 minutes, so only the late attempts recover anything.
- **All retries exhausted** → HTTP **503** `overloaded_error`. Safe specifically because `fallback-handler.ts`'s `isRetryableError` does NOT list 503 — it cannot silently switch the user off a pinned model, it reaches Claude Code, which runs its own retry loop.
- **Terminal** in-stream errors (`context_length_exceeded`, `invalid_request_error`) are NOT retried — they keep the existing inline-text treatment, which is the actionable path for them.
- **Anything else** (any content event) → `clean`, and the consumed bytes are **replayed byte-identically** so the real parser sees an unchanged stream.

This is the one place the 400-not-503 doctrine (`composed-handler.ts` ~line 461) is deliberately inverted. That rule exists because a 503 makes Claude Code show "API error · Retrying · attempt N/10" with the real reason buried — correct for **terminal** faults, where retrying is theatre. An upstream overload is the opposite: genuinely transient, and the retry banner is the appropriate behaviour because retrying is the actual remedy. Terminal → 400 inline; transient-after-our-own-retries → 503.

**Trade-off to know:** sniffing withholds response headers until the first decisive event, capped by `DEFAULT_SNIFF_BUDGET_MS` (12s, chosen above the 0.85s–7.7s error latencies observed in the real log). On a healthy xhigh-reasoning turn that delays `message_start` by however long the model thinks before its first output item. No content is lost or reordered — the client shows a spinner either way — but time-to-first-byte is genuinely later than before. Past the budget claudish flushes and degrades gracefully to the inline-text path.

`latency_ms` for a retried turn includes the backoff waits by design: the honest figure is time-to-usable-response.

## The remap has a downstream reader: `upstream_status` (v7.62.0, #148)

The 400-not-503 remap is right for the CLIENT and wrong for anything downstream that
still has a decision to make from the status. `FallbackHandler.isRetryableError`
is exactly that: every candidate in a chain IS a `ComposedHandler`, so by the time
the fallback inspects a response the 401/403/terminal-429 has already become a 400.
It fell into the model-not-found branch, matched none of its phrases, and **stopped
the chain at the first provider** — inverting the intent exactly, since "terminal"
means *this* provider will not recover on retry, which is precisely when the next
one should be tried. The errors that most warrant a fallback were the only ones that
could no longer trigger one.

The true status was already on the wire as `error.upstream_status`, attached at the
single remap site. `extractUpstreamStatus` is shared from `anthropic-error.ts` now
rather than living as a private copy in `probe-live.ts`, because two private readers
of one wire field is how they drift.

Three properties keep this safe:

- **Strictly ADDITIVE.** It only turns a `false` into a `true`, and only for
  401/403/402/429. A remapped 400 carrying an upstream 400 falls through to the
  unchanged branches, so nothing that used to surface can now be swallowed by a
  chain advance.
- **A pinned single provider cannot be affected at all.** `proxy-server.ts` builds
  `candidates.length > 1 ? new FallbackHandler(candidates) : candidates[0].handler`,
  so an explicit `provider@model` spec resolves to one candidate and never
  constructs a `FallbackHandler`. There is no chain to advance along, which is what
  makes "could this silently move someone onto per-token billing?" answerable with
  *structurally no* rather than with a heuristic.
- **The quota half was already fixed** by `hasQuotaExhaustionWording` in v7.40.0,
  which is wording-based precisely because the status has been remapped by then.
  This closes the auth half: a revoked or rotated key, where the wording check has
  nothing to match on.

### "Out of credit" and "plan limit reached" are two different facts

`quota-exhaustion.ts` holds two phrase families, not one list. `BALANCE_PHRASES`
means the account cannot be billed and the remedy is to pay; `PLAN_LIMIT_PHRASES`
means a flat-rate allowance is spent and the remedy is to wait or upgrade.
`EXHAUSTION_PHRASES` is their union, so `hasQuotaExhaustionWording` and every
caller of it behave exactly as before — the split only adds
`hasPlanLimitWording`, which `probe-live.ts` uses to choose between the
`out-of-credit` and `plan-limit` probe states.

Balance wins ties: a body carrying both families is a payment problem with plan
wording next to it, and "pay" is the safer of the two instructions to give.

Two live 429s, measured the same afternoon, are why the distinction exists:

| Provider | Body | State |
|---|---|---|
| MiniMax Coding | `Token Plan usage limit reached: Upgrade your Token Plan or purchase Credits for more usage. (2056)` | `plan-limit` |
| GLM (metered) | `Insufficient balance or no resource package. Please recharge.` | `out-of-credit` |

Both rendered as `out of credit` before. For a flat-rate subscriber that is
actively misleading — it sends someone to a billing page to fix a plan that is
working and resets on its own.

The provider's own sentence is the diagnosis, so it must survive to the screen.
`extractErrorMessage`'s cap is therefore sized for the WIDEST consumer (400
chars), not the narrowest: every consumer already bounds itself — the probe row
clips to its column, the TUI detail panel wraps to 2 lines, and
`probe-results-printer` word-wraps to `MAX_ERROR_LINES`. At its old 160 the cap
was no longer protecting a layout, only deleting the remedy from the end of the
MiniMax sentence.

**`exhaustedChainStatus` had the same defect, and fixing the first one exposed it.**
It read `e.status` to decide whether a whole chain failed transiently, and by then
the remap may have rewritten that to 400 — so it was asking a number that no longer
says. The wording check covered the common case *by accident* (a spent plan says so
in words that survive the remap), while a bare `Too Many Requests` came out as a
terminal 400 where Claude Code's retry loop was the actual remedy. It only became
reachable because `isRetryableError` now advances the chain: before, a remapped 429
with no quota wording stopped at candidate 1 and exhaustion was never reached. Both
now recover `upstream_status`, scoped to 429/503 — exactly the set already treated
as transient for un-remapped statuses, so the rule became independent of whether a
remap happened rather than gaining a new special case.

The general lesson: **any code that branches on an HTTP status downstream of the
remap is suspect.** Grep for `status ===` under `handlers/` before assuming a new
one is safe.
