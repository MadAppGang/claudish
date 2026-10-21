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

### A header that names the conversation is derived per call, never stored

`getHeaders(claudeRequest?)` receives the ORIGINAL inbound body Claude Code sent
(`handle()`'s `payload`, not the normalized `claudeRequest` clone, which adds
`tools: []`). ComposedHandler passes it at all three call sites: the main request,
the parameter-rejection retry and the 401 refresh retry. A header computed only on
the main path goes missing on the retry.

The value must be derived from the argument on every call. Handlers, and so
transports, are cached one per model, and `claudish serve` hosts several
conversations in one process. A value stored on the transport in
`transformPayload` and read back in `getHeaders` would let a retry, which runs
after an awaited fetch, carry another conversation's id.

The one derivation is `conversationKey()` (`providers/transport/conversation-key.ts`):
`claudish_` + sha256 of Claude Code's `session_id` from `metadata.user_id`, 32 hex.
Codex sends it as `prompt_cache_key`; OpenCode Zen sends it as `x-opencode-session`.

OpenCode Zen Go began answering every request without that header with
`400 {"type":"MissingSessionID"}` (measured 2026-09-12; claudish's routing chain
then stepped silently to the next provider). `OpenCodeZenTransport` adds it on
both Zen tiers. The metered `opencode-zen` tier sends it too, on OpenCode's docs
sentence alone: it is NOT verified live, because no `OPENCODE_API_KEY` was
available.

The fallback key costs Zen more than it costs Codex. With no session id, the key is
one random value per process. For Codex that shares a cache hint; for Zen it is the
upstream's routing identity, so under `serve` every sessionless conversation shares
one `x-opencode-session`. OpenCode's error text calls a missing header a routing
inefficiency, so a shared value is not expected to fail, but it is less precise.

### Zen also needs a User-Agent, and its two routes proved it separately

`OpenCodeZenTransport` sends `User-Agent: claudish/<version>` beside the session
id. OpenCode's docs ask a client to identify itself "rather than a generic SDK or
HTTP-library name", and this relay enforces it: `providers/model-discovery.ts`
records that a UA-less discovery request to Zen Go answers `403 error code: 1010`,
Cloudflare's browser-integrity block, while the identical request carrying one
returns 200 with 26 models (measured 2026-08-18). The chat path sits behind the
same edge and went without a UA until 2026-09-15.

Read the two together, because the failure modes are unalike and each is mistaken
for a credential problem. A missing UA is a Cloudflare 403 at the edge, before the
relay sees the request. A missing session id is a 400 from the relay itself. Both
send a user to check a key that is fine.

Precedence is the same on both routes: the generated headers are written FIRST and
the provider definition's own `headers` merge over them, so an endpoint that pins
either value keeps it. Auth is applied last and nothing can displace it.

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
- `openai-responses-sse.ts` — OpenAI Responses API → Claude SSE (Codex). The module entry point
  only; the work is under `responses/`: `claude-sse-sink.ts` (the one writer of Claude SSE for a
  downstream message), `responses-leg.ts` (one upstream body → a `LegOutcome`), `responses-turn.ts`
  (how the message ends, in-turn retry, usage), `parallel-wrapper.ts`, `stall-guard.ts`. See
  "Codex tool calls" below.

## Gemini tool schemas are protobuf, not JSON Schema (`handlers/shared/gemini-schema.ts`)

`convertToolsToGemini` serves BOTH the Gemini direct-API handler and the Antigravity
OAuth handler, through the single call site `adapters/gemini-api-format.ts`. A bug here
takes out both providers at once, on the first request that carries tools.

Gemini validates the request against a protobuf message, so its errors name proto
fields, not JSON Schema keywords. Every node with `type: "array"` MUST carry `items`;
an absent one is a missing field, not an omitted optional. The failure looks like this,
and it names a path the caller never wrote:

```
400 * GenerateContentRequest.tools[0].function_declarations[1]
  .parameters.properties[query].properties[where].items.items: missing field.
```

`sanitizeSchemaForGemini` copies an ALLOWLIST of keywords and silently drops the rest.
That is what makes this class of bug recur: a tool ships a keyword the allowlist has
never heard of, the element description vanishes, and a bare `{ type: "array" }` goes
out. Two shapes did it before v9.0.3:

- a tuple written with `prefixItems` (JSON Schema 2020-12, e.g. the `Artifact` tool's
  `query.where`), which the allowlist did not carry;
- a bare `{ type: "array" }` that never described its elements at all.

The `Artifact` case was nested, which is why it survived review: the OUTER `items`
existed, so the sanitizer recursed happily, and only the inner node came out bare.

Two defences, and the second is the load-bearing one:

1. `tupleElementSchema` handles both tuple spellings — 2020-12 `prefixItems` and
   draft-07 `items: [...]`.
2. A closing invariant: an array that still has no `items` gets `{ type: "string" }`.
   This holds at every depth and kills the class, not the two known shapes. Keep it
   even when a specific keyword gets handled — the next unknown keyword is the point.

## The stale comment cost more than the 400

The same function stripped `anyOf`, `oneOf`, `minItems`, `maxItems`, `format` and
`nullable`, under a comment asserting Gemini supports none of them. That comment
predates v7.36.0, which repointed `gemini-*` from the retired Code Assist backend
to Antigravity. Nobody re-measured it.

Measured 2026-09-03 against the live backend — full table in
`ai-docs/reports/gemini-tool-schema-support-20260903.md`. **`anyOf`, `oneOf`,
`minItems`, `maxItems`, `enum` and `nullable` are all accepted.** Only `allOf` and
`format` are still stripped, the latter because its per-type allowlist is narrow
enough that a tool shipping `format: "uri"` is a live 400 risk.

Stripping was never free. `normalizeType(undefined)` answers `"string"`, so a
property declared as a union came out `{ type: "string" }` — the model was told to
quote its numbers. A tuple is therefore NOT collapsed to one type; it becomes the
UNION of its position schemas:

```
where: [field, operator, value]        # value is `{}` — any type

  ->  { type: "array", maxItems: 10,
        items: { type: "array",
                 items: { anyOf: [ {type:"string"},
                                   {type:"string", enum:["eq","ne", ...]},
                                   {type:"number"}, {type:"boolean"} ] },
                 description: "Ordered 3-element array: [string, string (one of: \"eq\", ...), any]." } }
```

A union is WIDER than a tuple and never rejects a valid call. The old collapse was
not wider, it was WRONG: it rejected the numbers and booleans the other positions
accept. `{}` — JSON Schema for "any value" — is the case that matters, because
`normalizeType` silently reads it as string.

**Positional binding is the one thing that cannot survive.** Gemini validates every
element against ONE `items` schema, so "position 1 must be one of these operators"
is unsayable. Measured live: with the enum as a bare union branch, the model
answered `">"` and `"=="` instead of `gt` and `eq` — valid, because a free string is
also a branch. `describeTuple` therefore writes the arity, the order AND the
per-position enum values into the `description`, which is free-form and cannot
wrongly reject anything. With that in place the same prompt produced `gt` and `eq`.

## Validation is a live A/B, not a unit test

A unit test here asserts on a payload claudish itself built, so it cannot see this
bug class at all. The evidence is six real interactive `ag@gemini-3.6-flash-high`
sessions — three per build, fresh session each, identical prompt, an MCP tool whose
parameter is a `prefixItems` tuple. Full method and raw records in
`ai-docs/reports/gemini-tool-schema-support-20260903.md`.

| Build | Operator produced | Value type |
|---|---|---|
| pre-fix | no tool call — `400 ... function_declarations[1] ... properties[where].items.items: missing field` | — |
| collapse to one type | `>`/`==`, `>`/`==`, `>`/`=` — 0 of 3 from the schema | `number` |
| union + description | `gt`/`eq` — 3 of 3 from the schema | `number` |

Declaration `[1]` is Claude Code's own `Artifact` tool, the same index users hit, so
the failure is not synthetic and not confined to MCP tools.

**The declared element type is not enforced.** `500` arrived as a JSON `number` on
both accepted builds, including the one declaring `string`. Do not claim the union
"keeps the number a number" — it was never at risk. What the narrow declaration
costs is the vocabulary the model reads: given only a union, the model invented a
symbolic operator in every run, and inconsistently. The description is what moved
that to 3/3.

## Text-based tool recovery is a fallback, and it is load-bearing on the busiest wire

`openai-sse.ts` calls `extractToolCallsFromText` (`handlers/shared/tool-call-recovery.ts`)
at finalization. That function scrapes tool calls out of assistant PROSE, for local models
that cannot emit structured `tool_calls` at all. It is the only production caller, so this
path is exactly the `openai-sse` provider list: GLM, Kimi, Grok, DeepSeek, Qwen, OpenRouter, LiteLLM.

Three properties are not obvious from the source and each one shipped as a defect
(v7.68.0, `ai-docs/reports/grok-tool-name-mangling-20260827.md`):

1. **It must not run when the model already emitted a structured call.** Recovery can only
   ADD calls, never repair one. Ungated, a turn holding one real call plus prose mentioning
   a function tag dispatched TWO `tool_use` blocks. The gate is `state.tools.size > 0`.
2. **Every pattern needs the allowlist, not just the last one.** The function stacks six
   patterns; only Pattern 5 (natural language) had a `knownTools` guard, and its `continue`
   reads like a function-wide filter. Patterns 0–4 had none. The allowlist is now the
   request's own advertised tool list, applied to the return value of all six.
3. **A tool name is an identifier, and nothing else may occupy that slot.** Pattern 0 matched
   `<function=([^>]+)>`, which accepts every character except `>`. A `<function=` opened in
   prose swallowed everything up to the next `>`, so parameter names and ARGUMENT VALUES
   became the tool name. `TOOL_NAME_SHAPE` (`adapters/tool-name-utils.ts`) is the one
   definition; `hasExtractableFunctionTag` exists so the parser's text hold-back test cannot
   drift from what the extractor accepts. Drift there withheld text that nothing later emitted.

`TokenTracker.recordToolUse` re-checks the shape and buckets a failure under `malformed`.
The map is written to `stats/*.json` and printed in the session summary, neither of which is
redacted, so a swallowed argument value must never reach it.

**Observation and dispatch are the same event.** `onToolCallObserved` is hooked inside
`send()`, the single frame writer (`openai-sse.ts`), not at the `content_block_start` sites.
That makes "a tool name was only mis-REPORTED" impossible: anything counted in the stats was
also dispatched to Claude Code.

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
- **All retries exhausted** → HTTP **503** `overloaded_error`. For a pinned `provider@model` (no `FallbackHandler`) it reaches Claude Code, which runs its own retry loop. Inside a bare-name chain, `isRetryableError` advances on it to the next candidate (since 2026-09-24, see "An unavailable endpoint advances the chain" below).
- **Terminal** in-stream errors (`context_length_exceeded`, `invalid_request_error`) are NOT retried — they keep the existing inline-text treatment, which is the actionable path for them.
- **Anything else** (any content event) → `clean`, and the consumed bytes are **replayed byte-identically** so the real parser sees an unchanged stream.

This is **one of two** places the 400-not-503 doctrine (`composed-handler.ts`'s `respondConnectionError`) is deliberately inverted. That rule exists because a 503 makes Claude Code show "API error · Retrying · attempt N/10" with the real reason buried — correct for **terminal** faults, where retrying is theatre. An upstream overload is the opposite: genuinely transient, and the retry banner is the appropriate behaviour because retrying is the actual remedy. Terminal → 400 inline; transient-after-our-own-retries → 503.

The second inversion is network recovery's tier-2 handoff, which earns the same 503 by a different argument — not "the banner is the remedy" but "a pane is painting the reason, so the status no longer has to carry it". See [`network-recovery.md`](network-recovery.md).

> This reference was `~line 461` until v9.2.x, then really `:665-675`, and is now inside a named method. **Cite the symbol, not the line.** Three separate readers have been sent to the wrong part of this 2,000-line file by a number that was correct when it was written.

**Trade-off to know:** sniffing withholds response headers until the first decisive event, capped by `DEFAULT_SNIFF_BUDGET_MS` (12s, chosen above the 0.85s–7.7s error latencies observed in the real log). On a healthy xhigh-reasoning turn that delays `message_start` by however long the model thinks before its first output item. No content is lost or reordered — the client shows a spinner either way — but time-to-first-byte is genuinely later than before. Past the budget claudish flushes and degrades gracefully to the inline-text path.

`latency_ms` for a retried turn includes the backoff waits by design: the honest figure is time-to-usable-response.

## A stream that dies mid tool-call (`openai-responses-sse.ts`)

`content_block_start` for a tool goes out the moment `response.output_item.added` arrives — before a single argument byte exists. From that point the block is committed and claudish cannot un-send it. So when the socket dies while `function_call_arguments.delta` is still streaming, the only lever left is **how the message ends**.

It used to end `end_turn`. That is the one ending which means "the turn finished, run the tool", so Claude Code ran it on truncated JSON:

```
InputValidationError: Write was called with input that could not be parsed as JSON.
You sent (first 200 of 9437 bytes): {"file_path":".../catalog-generation.test.ts","content":"import { describe, expect, it } from \"bun:test\";\nimport typ
```

models-index subagent `acd91c47262e06a7a`, `gpt-5.6-sol` via `openai-codex`, 2026-09-09 15:48:27Z, followed by `[Stream error: TypeError: The socket connection was closed unexpectedly]`. It recurred at 15:56:32Z in the same run. Across the local Claude Code transcripts, 10 of 20 `__unparsedToolInput` failures are this path; the other 10 are the model emitting genuinely invalid JSON (`{"file_path": "...", "offset": 55, , "limit": 135}`), which is not claudish's to fix — the harness error prompts a retry that works.

**The head sniffer cannot cover this.** `stream-head-sniffer.ts` decides while the status code is still ours, which is the first seconds of the stream. This failure landed 93 s in, deep in the body. Once content bytes are flowing there is no retry claudish can perform on the client's behalf.

**`max_tokens` does not rescue it.** v7.12.7 reports `stop_reason: "max_tokens"` for a turn cut off by `response.incomplete`, on the stated contract that the client then discards the partial block. It does not. Claude Code **2.1.217** executed a `max_tokens`-terminated `Write` and returned the same `InputValidationError` (passflow session, 2026-07-22 13:27:31Z — six days after that fix shipped). The `max_output_tokens` path keeps the label anyway: it is the honest one, and that truncation is *deterministic*, so an `error` event there would only make the client retry a request that truncates again at the same place.

**VERIFIED against a real client (2026-09-10).** Claude Code does honour a mid-stream `error` event: it discards the partial `tool_use` and retries the turn. Measured before/after against one mock upstream — released v9.0.8 executed the truncated `Write` and returned `InputValidationError`, the fixed build executed no tool at all. This was measured rather than argued precisely because the `max_tokens` assumption above turned out to be false. Method, traps and raw logs: [`../reports/truncated-toolcall-live-verification.md`](../reports/truncated-toolcall-live-verification.md).

**The fix:** when `openToolBlocks` is non-empty in the parser's catch block, end the turn with an SSE `error` event instead of `end_turn`. No completed `tool_use` reaches the client, and a dead socket is transient, so the client's own retry is the right remedy. `devin-connect.ts` ends a mid-stream fault the same way. With no tool call in flight the inline `[Stream error: ...]` text block is kept — partial prose is harmless and visible.

Since the leg/turn split the catch block is `responses-leg.ts` (it reports `stream-error` with
`openToolBlock`) and the ending is chosen in `responses-turn.ts`; the rule is unchanged.

## Codex tool calls: zero-delta arguments, the `parallel` wrapper, retry within the turn

`cx@` sessions (claudish provider `openai-codex`, the ChatGPT Codex backend) failed parallel tool
calls with `InputValidationError: … The required parameter 'file_path' is missing`. Three
mechanisms, each with its own evidence; the measurements are in
`ai-docs/reports/codex-parallel-wrapper-degeneration-2026-10.md` and the session evidence it cites.

### Zero-delta function calls

Since 2026-07-29 the Codex backend sends every MULTI-call turn with zero
`response.function_call_arguments.delta` events (100% of multi-call turns in the B replays). The
arguments exist only in `response.function_call_arguments.done` and in the `output_item.done`
item. The parser forwarded arguments only from deltas, so Claude Code got `{}`.

Each call now counts the bytes it forwarded (`forwardedBytes`) and keeps the `.done` string. At
`output_item.done` the final arguments are `.done ?? item.arguments ?? accumulator`:

| what the deltas carried | what goes out at `output_item.done` |
|---|---|
| nothing (Codex multi-call) | the final string as ONE `input_json_delta`; log `zero-delta function_call <name>: emitted <n> bytes from <done\|item>` |
| a strict prefix of the final string | the missing suffix only (logged) |
| the whole final string (native `openai@`, single-call Codex) | nothing more |
| something that is not a prefix | nothing more; log `done arguments diverge from streamed deltas for <name>` |

A buffered call (plan-mode Write/Edit) hands the final string to `onToolCall`, then one delta.
`BehaviorSession.repairToolCall` ignores an empty argument string: reading it as `{}` journalled
false `tool_call/ignored` entries.

### The `parallel` wrapper

About 1% of turns end with a function_call named `parallel` (the model's built-in
`multi_tool_use.parallel`), which no tool in the request declares. In every observed case its
arguments are a degenerate 41–96 KB string (`a.ts.tsaaa.ts.ts…`) that arrives in ONE burst after a
361–484 s keepalive-only stall, then `response.incomplete` `max_output_tokens`. The B experiment
found no request factor (effort low/medium, 4 tools, `strict:false`) significantly better
(Fisher p = 1.000), so the remedy is in claudish, not in the request.

`isParallelWrapperName(name, declaredNames)` is true for `parallel` / `multi_tool_use.parallel`
(optional `functions.` prefix) only when no tool Claude Code declared has that name, so a user tool
really called `parallel` is untouched. Such a call is HELD (no `content_block_start`), and the
pending reasoning moves into it. At `output_item.done`:

- a valid `{tool_uses:[{recipient_name, parameters}]}` becomes one tool_use block per entry (name
  `functions.`-stripped and decoded through `toolNameMap`, id `toolu_<call id>_p<k>`). The
  reasoning is remembered under the `_p0` id ONLY, so the next request replays it exactly once.
  No valid wrapper has ever been captured (the backend unpacks those itself), so this branch rests
  on the documented shape, not on a capture;
- anything else (unparseable, wrong shape, empty, or still held at `response.incomplete` or at the
  end of the stream) is degenerate and never reaches Claude Code. A wrapper judged degenerate at its
  `output_item.done` does not end the leg there: the leg keeps reading, emitting nothing, until the
  terminal event (at most `EXEC_DRAIN_MS = 10 s`, the exec's drain), because that event carries the
  usage the provider billed. In the V0-21 capture `response.incomplete` came six lines later with
  39,429 input and 32,000 output tokens, which an immediate stop dropped from the accounting.

There is no byte-level repetition detector: the degenerate string is never streamed, so a streaming
detector has nothing to observe on the real failure, and its low-diversity condition is met by
legitimate repetitive Write content.

### Retry within the turn

A degenerate leg is retried by re-sending the SAME body while the downstream message stays open
(`responses-turn.ts`); the next leg continues at the next block index on the same `ClaudeSseSink`.
`MAX_LEG_RETRIES = 2` (3 attempts). Tool blocks have three states on the sink (started, arguments
complete, stopped), and a leg is issued only while no tool_use was emitted:

| state of the message when the trigger fires | action |
|---|---|
| `message_start` + pings, or closed text/thinking only | retry (repeated commentary is possible, cosmetic, logged) |
| ≥ 1 tool_use stopped with its arguments, none cut off | no retry: end `stop_reason: tool_use` for those calls — re-emitting could run a side-effecting Bash twice |
| any tool_use started but cut off | no retry: SSE `error` (the cut-off rule above) |
| retries exhausted | SSE `error`: `degenerate parallel tool wrapper after 3 attempts` / `no output for 300 s after 3 attempts` |

Log: `[ResponsesTurn] <stall 150s|degenerate NB> — retry k/2`.

**Why the parser layer, and nowhere else.** Not 7b: the status is already flushed. Not
`FallbackHandler`: a model fault must never move a subscription user onto a metered hop. Not the
transport. After the flush every failure ends with an SSE `error`; no status is invented, no
network-recovery hold starts, and the five auth sites are untouched.

**Legs 2..n** come from `createLegIssuer` (`handlers/shared/responses-leg-issuer.ts`), built in
`handle()` from THIS request's header builder, current body (after parameter recovery) and
transport hooks. Per leg: `refreshAuth`, and when the returned binding's arm or account differs
from the turn's (`isSameCredentialSilo`), stop ("Codex sign-in changed during the turn") rather
than continue on another credential silo (`openai-codex` returns a binding from `refreshAuth` and
`forceRefreshAuth`; a transport that returns none keeps the no-binding path, identical to the
primary fetch, and the primary 401 retry applies the same check before it resends the body); its
own `deadlineClamp` ceiling merged with the turn signal (the primary's clamp is disarmed at
headers and bounds nothing later); one `forceRefreshAuth` re-fetch on 401; any
other non-200 → SSE `error` carrying the status and the first 500 body bytes (`HTTP 429 on retry
leg 2: …`), no parameter recovery; the 7b settle, abortable; a throw is classified for the log only.
The previous leg's reader is cancelled (awaited) first, so two upstream streams never overlap.

**Usage.** Each leg reads its own usage, including `input_tokens_details.cached_tokens`. At turn
end, in this order: `onExtraBilledInput` (input of EARLIER legs that reported usage) →
`TokenTracker.addBilledInputTokens` (cost and billed input only, never the context figures, same
cache clamp as `update()`); `onTurnSummary`; then `onTokenUpdate(final leg's input, every leg's
output)`, which fires the request's ONE stats record, so it already contains both. Each earlier leg
was a separate request the provider billed in full; under `delta-aware` the last leg is still
charged only its growth, which is that strategy's model of the conversation, not of a retry. On the
default stall scope (subscription) this is $0. StatsEvent `leg_retries` (absent when 0) is pushed in
`eventToLogRecord` as `llm.leg_retries`.

### The stall guard (`stall-guard.ts`)

The leak's keepalive-only wait (361–484 s) is not bounded by `API_TIMEOUT_MS`, which does not bound
a flushed, pinging stream (the leak ran 472 s). A leg with no output-bearing event
(`output_item.added` of any type, or any `*.delta`; NOT `created`, `in_progress`, keepalives,
metadata) within the threshold after its RESPONSE HEADERS is cut off and retried like a degenerate
leg.

| sample (all `openai-codex`, ChatGPT backend) | n | headers → first output item |
|---|---|---|
| real sessions, 19 debug logs, 2026-07-15..10-16 | 8,239 | p50 1.2 s, p90 3.6 s, p99 8.5 s, p99.9 28.3 s, healthy max 61.7 s |
| B experiment, healthy legs | 297 | max 7.38 s (from `response.created`) |
| leaks | 4 | 361 s, 456 s, 484.5 s, > 150 s (aborted) |

The clock starts at the headers, not at `response.created`: in the 61.7 s legs the backend held
`response.created` until the first item. ComposedHandler stamps it where the 200 arrives and again
on each 7b re-issue, so the 12 s sniff window counts against the guard. Thresholds: 150 s for
attempts 1..n-1 (2.4× the healthy max, 2.4× below the fastest leak), 300 s for the final attempt
(4.9× the healthy max, still below the fastest leak). Worst case 150 + 150 + 300 s, against an
unbounded wait; a single stall costs ~150 s plus one healthy leg, against 361–484 s.

**Scope.** The data is from the ChatGPT backend only, so the default is exactly that: claudish
provider `openai-codex` AND the arm that signs this request is `oauth` (the request's
`binding.auth.arm`, from the binding `refreshAuth` returned at 5b). Native `openai@`, the
`openai-codex` api-key arm and custom `responses` endpoints are unarmed unless
`CLAUDISH_RESPONSES_STALL_MS` is set: > 0 arms it everywhere (final attempt 2×), `0` disarms it
everywhere.

### Downstream cancel

`cancel()` on the downstream stream (Claude Code disconnected, aborted, timed out) used to stop only
the ping, and the upstream response kept streaming to completion with nobody reading it. Now the
sink aborts the turn's `AbortController`: the leg cancels its reader, the signal reaches
`issueLeg` (a leg fetch or 7b backoff in progress is aborted), and the driver issues nothing more.
Usage is recorded after a cancel only if a leg had already reported it (what was billed is billed).

## A non-streamed turn that ends in an SSE error (`collect-sse-message.ts`)

`sseResponseToJson` folds every ComposedHandler stream into one JSON message for a request with
`stream` absent or false (`/compact`). It had no `error` case: a stream that ended on an SSE
`error` came back as 200 with partial or empty-input content and an inferred `stop_reason`, while
the streamed form of the same failure made Claude Code discard the message and retry.

Now, when the folded stream carried an SSE `error`, every collected block is discarded and the
answer is the Anthropic error body `{type:"error", error:{type, message}}` with the status the
Messages API defines for that type (`invalid_request_error` 400, `api_error` 500,
`overloaded_error` 529, any other 500) and the header `x-claudish-stream-failure: 1`. This is the
error the event declares, not an upstream status claim, so `extractUpstreamStatus` does not apply.

**Scope is every parser, deliberately.** openai-responses-sse, openai-sse, gemini-sse,
ollama-jsonl, devin-connect and anthropic-sse all emit SSE `error` from their terminal failure path,
so the contract reaches all of them: the non-streamed 200-with-partial-content was the
inconsistent case, not the new one. The Responses parser's non-tool stream error (an inline text
block, `end_turn`) emits no SSE `error` and still returns 200.

**Why a marker.** A stream-failure answer is not a provider's verdict on the request and must never
advance a routing chain. A status cannot hold it, because `isRetryableError` reads quota wording
before any status and a retry leg's error quotes the upstream body. So `FallbackHandler.handle`
returns it verbatim before reading the body (beside the recovery marker), and `isRetryableError`
returns `false` for it above the wording match. Unforgeable for the recovery marker's reason: the
collector builds a new `Response` whose headers start empty. See `network-recovery.md`, "A third
marker".

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

### The status is not always enough: `x-claudish-recovery` (network recovery, Tier 2)

There is now one response `FallbackHandler` must treat specially **before it looks
at a status or a body at all**: the 503 an exhausted tier-1 connection hold hands
back so Claude Code will re-POST (`handlers/shared/recovery-marker.ts`).

The status cannot hold the chain: since 2026-09-24 `isRetryableError` ADVANCES on an
upstream 502/503/504 (next section), so the marker is the only thing that keeps a
recovery 503 in place. Even before that, when a 503 stopped the chain on status
alone, the status was not enough, twice:

- **`isRetryableError`'s FIRST statement is `hasQuotaExhaustionWording(errorBody)`**,
  status-agnostic on purpose (it exists *because* of the remap above), and its list
  carries the bare substring `"quota"`. A 503 whose MESSAGE happened to contain that
  word advanced the chain — and per CLAUDE.md's standing invariant, advancing off a
  `SUBSCRIPTION_PROVIDERS` candidate onto a metered one quotes real money, during an
  outage, for a fault no provider caused.
- **`exhaustedChainStatus` could demote it.** With an earlier candidate already
  failed, a non-retryable response goes to `formatCombinedError`, whose status is 503
  only if EVERY accumulated error is transient. One earlier auth/404 turns our 503
  into a terminal 400 and the client never re-POSTs.

So the marker is a **header**, checked in two independent places: `handle()` returns
a marked response VERBATIM before reading the body (which is what defeats the
combining), and `isRetryableError` returns `false` on it ABOVE the quota match
(which is what defeats the wording). The second is unreachable in the shipped call
graph and is kept anyway, so the guarantee belongs to the decision rather than to one
call site.

**Order is the property, not presence.** Moving the marker check below the quota
match — present, but late — is a live billing bug, and is mutation-covered as one.

It cannot be forged: every non-ok exit from `ComposedHandler` is `c.json(...)`, which
builds headers from nothing, and the only path that copies upstream headers verbatim
(`stream-head-sniffer.ts`'s `replayResponse()`) runs after `!response.ok` has already
returned, i.e. on a 200. **If a future edit ever returns an upstream `Response` object
on a non-ok path, the marker must be stripped there.**

Evidence, including the live chain runs and the mutation set:
`ai-docs/reports/network-recovery-phase4-status-flip-20260911.md`.

### An unavailable endpoint advances the chain (2026-09-24)

A bare `grok-4.7` failed on every request while OpenCode Zen Go, its first candidate,
answered `503 {"type":"server_error","message":"Upstream request failed: Endpoint is
unavailable."}`. `--probe grok-4.7` in the same minute showed the five candidates behind it
answering (Grok Build, xAI, OpenRouter, OpenCode Zen, Poe). `isRetryableError` had no
502/503/504 branch, so the first attempt's 503 was returned as-is with no `[Fallback]` line,
and Claude Code's retry loop re-sent the same chain to the same dead hop, ten times.

The exclusion rested on "a 503 cannot silently switch the user off a pinned model". A pinned
`provider@model` builds no `FallbackHandler`, so inside a chain that protected nothing. Now:

- `isRetryableError` returns `true` for 502, 503 and 504. A plain 500 still stops the chain
  unless it carries billing wording: it can carry account state, and it is the one 5xx a
  request's own payload can provoke on every provider alike.
- `exhaustedChainStatus` counts 502 and 504 as transient beside 429 and 503, so a chain in
  which every hop was unavailable still ends retryable (503), as the single 502 that used to be
  returned as-is did.
- Unchanged, and the reason this is safe: claudish's own connection verdicts
  (`x-claudish-recovery` on the 503 arm, `x-claudish-connection-error` on the 400 arm) are
  checked before any status, in `handle()` and on `isRetryableError`'s first line. A network
  outage on this machine still holds the chain.
- Changed on purpose: the stream sniffers' exhaustion 503 (overloaded after 3s → 15s → 30s of
  retries) now advances a bare-name chain instead of returning to Claude Code.
- Except when a retry could not REACH the provider. `settleResponsesStreamHead` and
  `settleDevinStreamHead` return `exhausted` with `unreachable: true` when `reissue()` throws,
  and the caller adds `x-claudish-connection-error` to that 503, so the chain holds. Without it a
  DNS or connection failure on a Codex subscription hop advanced onto a metered OpenAI hop
  (found by the 10.3.0 release review, source-traced; the status alone could not tell a
  connection fault from an overload).

### A subscription's credential failure stops the chain (2026-10-16)

The `upstream_status` recovery above made a remapped 401/403 advance the chain, on the reasoning
that a revoked key on one provider is exactly when the next should be tried. For a SUBSCRIPTION
that reasoning bills money: a user whose Kimi Code, Grok Build or Zen Go login had expired was
walked onto the next hop, usually metered, and never told to log in. Jack's decision: a terminal
credential failure of any subscription provider stops with its message, and a transient fault
never becomes a 401. This narrows the "strictly additive" property for exactly that case.

**Amended 2026-10-20: the chain moves on to the other SUBSCRIPTIONS, never to a metered hop.**
The Bench run of that day (`ai-docs/reports/recommended-models-bench-run-20261020.md`) showed the
stop costing availability the rule was never meant to cost: a bare `glm-5.3` whose Zen Go key had
expired stopped dead although the Qwen Token Plan, also a subscription, was two hops later. Jack:
"it should not go to metered providers, but that models has native subscription". So after a
subscription candidate's terminal verdict (or a headerless 401/403 credential rejection,
`isSubscriptionCredentialRejection`), `FallbackHandler.handle` skips every metered candidate and
tries only the remaining subscription ones. Any failure of those is logged and passed over; if none
serves, the answer is the FIRST rejection's response unchanged (its status, verdict header and
"log in" message), never a combined `all_providers_failed`. An explicit spec (`zengo@glm-5.3`) has
one candidate, so it still stops. A transient verdict, and a terminal verdict from a metered
candidate, still return at once. Tests: `fallback-handler.subscription-only.test.ts`.

**The verdict rides a header, `x-claudish-auth-verdict`** (`terminal` or `transient`), from
`handlers/shared/auth-failure.ts`. The status cannot carry it: a terminal failure is answered 400
so Claude Code shows it inline, and a 400 with `upstream_status: 401` is precisely what the
recovery above reads as retryable. `isRetryableError` checks the verdict right after the
connection verdict, BEFORE the quota wording and the `upstream_status` recovery. It cannot be
forged for the same reason `x-claudish-recovery` cannot: every non-ok `ComposedHandler` exit is a
`c.json(...)`.

One classifier, `classifyAuthFailure(err)`, reads only fields a credential path sets on purpose,
in one order:

| Kind | Read from | Answer (`respondAuthFailure`) |
|---|---|---|
| connection | `classifyConnectionError` | none; the caller runs connection recovery first |
| terminal | `err.terminal === true` | 400 `invalid_request_error`, verdict `terminal`, `upstream_status` kept |
| transient | `upstreamStatus` 429 or 5xx, or `transient: true` | 429 for a 429, otherwise 503, verdict `transient` |
| unknown, subscription | anything else | 503 `overloaded_error`, verdict `transient` (retried on the same hop, never walked) |
| unknown, metered | anything else | 401 at `refreshAuth` and `forceRefreshAuth` only; other sites rethrow |

**The rule: a dead or unsubscribed credential is a terminal 400 that stops the chain; an
unclassified failure is a retryable 503.** It holds because the PRODUCERS say what their failure
is, through `auth/credentials/credential-error.ts` (`d86e3d86`): a missing login or a rejected
grant is `terminalCredentialError`, a token host's 429/5xx is `credentialHttpError` (transient,
with its `upstreamStatus`). Kimi's "No Kimi OAuth credentials found. Please run `claudish login
kimi` first." is therefore `terminal`, not `unknown`. What is still `unknown` is a failure nobody
classified, and for a subscription the conservative answer is retry: stopping a working plan with a
login instruction because a token host blinked is the worse error. (An earlier cut answered
`unknown` as terminal; it turned Grok's token-host 503 into a fatal "run `claudish login grok`".)

The producers that must keep this contract, and the first place a NEW subscription provider must
follow it: `auth/grok-oauth.ts`, `providers/grok/grok-credentials.ts`, `auth/kimi-oauth.ts`,
`auth/codex-oauth.ts`, `auth/antigravity-token.ts` (both the expiry and the forced refresh),
`auth/antigravity-user.ts`, `auth/oauth-manager.ts` (missing login), and the Muse Code mint and
core (`providers/meta-muse/`). A TRANSPORT must not swallow what they throw: a catch that returns
normally hands ComposedHandler nothing to classify (CLAUDE.md's transport-catch invariant). The
Codex and Kimi Code transports each had one, and both now rethrow (`ecbb92d1`, `2bf1f736`).

All five auth sites in `composed-handler.ts` (`refreshAuth`, `getHeaders`, the primary fetch, the
parameter-recovery re-fetch, `forceRefreshAuth`) use it, and so does a `recoverConnection` that
throws a non-connection error (`c6a7b4a5`). `settleAuthRetry` answers a 401/403 after a refresh as
terminal when the provider is a subscription or `classifyTerminalError` says so, and leaves every
other status alone, so Antigravity's terminal 429 is unchanged.

**Not every 401/403 is a credential verdict** (`isCredentialRejection`, `a5a29f36`). The first
cut read the status alone and stopped three answers that must keep advancing:

| Body | Measured | Why it advances |
|---|---|---|
| Zen Go `401 "Model deepseek-v4-pro-0813 is not supported"` | 2026-08-18, same key serving `kimi-k3` with 200 | the model, not the credential (`hasModelUnsupportedWording`) |
| Kimi Code `403 "You've reached your usage limit for this billing cycle"` | `quota-exhaustion.ts` | a spent allowance, which advances with its per-token warning |
| Zen Go `403 {"error":{"type":"RegionError",…}}` | 2026-08-19 | the provider's own error type names a region |

`FallbackHandler`'s subscription rule, the generic remap's verdict header and `settleAuthRetry` all
ask the same predicate. A spent allowance still advances because the quota wording is checked
before the subscription 401 rule. An `"Invalid API key."` 401 or 403 is still a rejection.

`FallbackCandidate.provider` now carries the claudish provider uid. `isRetryableError` used to
receive the candidate's DISPLAY name, and `isSubscriptionProvider("Kimi Coding")` is false.

## The catalog's endpoint contract has two halves (v9.0.7)

> **Superseded (10.5.0).** The gate, the name rule and the model-level `tokenParam` read
> described here are deleted. Every request is now built from its connection's `wire`
> ([`wire.md`](wire.md)). Kept for the history of why reading half a contract is worse
> than reading none.

`gpt-6-astra` was in the catalog and could not run. The child exited 1 on

```
400 unknown_parameter — "Unknown parameter: 'max_output_tokens'."
```

`max_output_tokens` is not a wrong parameter. It is the RESPONSES spelling, and
the catalog says so in the same record that names it:

```json
{ "modelId": "gpt-6-astra",
  "endpoints": { "openai": { "api": "responses",
                             "toolsWithReasoning": "requires-responses" } },
  "tokenParam": "max_output_tokens" }
```

claudish read `tokenParam` (in `OpenAIAPIFormat.tokenParamName`) and ignored
`endpoints.openai.api`. `lookupModelEndpoint` had been written for that field
and had **never had a caller**. So the request carried the Responses parameter
name to the Chat Completions endpoint.

Reading one half is worse than reading neither. Had the gate ignored
`tokenParam` too, the name rule would have guessed `max_tokens` and the request
would have been merely suboptimal instead of rejected. A parameter name is only
meaningful against the API it belongs to, so the two fields must be read
together or not at all.

**Why the name rule could not survive.** `requiresResponsesApi` decided the wire
API from `/^gpt-5\.6/ || includes("codex")`. `gpt-6-astra` shipped 2026-09-03
and matches neither. This is the failure mode CLAUDE.md names — *a default is a
rule, never a pinned id* — arriving on a schedule nobody controls: the rule was
correct when written and was falsified by a release. The gate now reads the
catalog first and keeps the name rule as the cold-cache fallback, the same
catalog-first shape `tokenParamName` already used for the sibling question.

**The catalog may only WIDEN that gate, never narrow it.**
`OpenAIProviderTransport.getEndpoint()` independently forces `/v1/responses` for
any name containing `codex`. A catalog record that said "chat completions" for
such an id would put an `OpenAIAPIFormat` body on a Responses endpoint — the
same format/endpoint split the Zen Go MiniMax bug produced, in the other
direction. The name rule therefore stays an unconditional `||`.

### A hint that infers must not outrank a body that states

The same 400 was rendered as:

```
Input too large. Reduce message history or use a larger-context model.
```

for a 6.7 KB prompt against a 1.05M window. `getRecoveryHint`'s 400 branch
detects an oversized prompt with `lower.includes("token")`, and OpenAI's
parameter NAMES contain that word — `max_output_tokens`,
`max_completion_tokens`. So a parameter rejection matched the size test and the
advice contradicted the body printed beside it on the same line. A reader
following it would shrink a prompt that was never the problem.

`isRequestShapeError` (`handlers/shared/request-shape.ts`) now runs first and
reads the provider's own `code`. It is deliberately narrow: a genuine overflow
names a LENGTH, not a parameter (`context_length_exceeded`, "maximum context
length is N tokens"), so widening the predicate is how the size hint — which
still has to work — gets broken.

This is the third entry in this file where a heuristic talked over a provider
that had already stated the fact, after `RegionError`'s link and MiniMax's plan
wording. The general lesson: **when the provider ships a structured `code`,
branch on it before pattern-matching its prose.** Prose heuristics are for
providers that give you nothing else.

Note the status here is safe to branch on: `getRecoveryHint` is called with the
raw `response.status` at the upstream error site, upstream of the remap
described above.

## A tool `pattern` is validated by the provider, in Python (v9.0.8, `format/openai-tools.ts`)

OpenAI checks every tool schema's `pattern` as JSON Schema `format: "regex"`, and
the checker compiles the value in Python. Claude Code 2.1.266 added the `Artifact`
tool, whose `field` property carries:

```
^(?!__.*__$)[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}"\\./[\]]{1,200}$
```

Every `cx@` session then died on its FIRST request, before any model ran:

```
HTTP 400 invalid_request_error, code invalid_function_parameters, param tools[1].parameters
"Invalid schema for function 'Artifact': '...' is not a 'regex'."
```

Measured against `python3 -c "import re"`, one construct at a time:

| pattern | Python `re` |
|---|---|
| the full Artifact one | `bad escape \p` |
| its `(?!__.*__$)` lookahead alone | compiles |
| `^[^\p{Cc}]{1,200}$` alone | `bad escape \p` |

So the Unicode property escape is the whole cause, and the lookahead is innocent.
That matters for the shape of the fix: "strip every `pattern`" throws away working
constraints, and "strip lookarounds" fixes nothing. `isPortablePattern` instead
allows only the escape letters Python's `re` knows (`\A \b \B \d \D \s \S \w \W \Z`,
the character escapes, `\x \u \U \N`), plus every non-letter escape and every digit
backreference. It also rejects a bare `(?<name>)`, which Python spells `(?P<name>)`,
while allowing the `(?<=` and `(?<!` lookbehinds.

Dropping is right because a `pattern` is ADVISORY — it steers the model, and the
harness re-validates the tool call on arrival. An unportable one is not advisory: it
fails the whole request. The costs are asymmetric, so a pattern that cannot be
proven portable is not sent.

Two things this uncovered:

1. `openrouter-api-format.ts` had its own `convertTools` calling `removeUriFormat`
   directly, so it skipped the top-level `oneOf` collapse, the never-undefined
   `parameters` guard, and this strip. It now calls the shared
   `convertToolsToOpenAI`. OpenRouter forwards to OpenAI models and inherits the
   same validator, so the divergent copy was a latent second instance of this bug.
2. The strip's log line is invisible in the default session log. `log()` writes to
   the always-on structural log only through `isStructuralLogWorthy`, a whitelist.
   Use `-d` / `--debug-claudish` (which writes `./logs/`), not `--debug` — the
   latter is passed through to Claude Code and tells you nothing about the proxy.

## A credential a request signed with is redacted by value in every sink (`redact.ts`)

A provider can echo the key it received: in a 401 body, in an error frame of a 200 stream, in the
message of a token-refresh exception, in an OpenRouter 429. Shape rules (`sk-…`, `Bearer …`)
cannot recognise an opaque key, and patching each sink leaves the next `log(` call open. So the
exact values a request signed with are held in ONE process-wide registry and applied at the few
places text leaves claudish.

**The registry.** `acquireSigningLease()` (`redact.ts:165`) returns a lease; `lease.add(values)`
holds each value (8 characters or more) refcounted in one module-level map (`:116`), in its
verbatim, JSON-escaped, twice-JSON-escaped and URL-encoded forms (`holdSigningValue`, `:154`);
`release()` drops the lease's hold once. `redactSigningValues(text)` (`:197`) returns the text
untouched when nothing is held and otherwise replaces every held form, longest first, with
`[redacted]` by plain substring replacement (no regex, so no stateful predicate). Replacements
only shorten, so JSON stays JSON. There is **no timer**: a lease lives until its work ends. A fixed
TTL could expire under a stream that is still producing frames.

Why one process-wide union and not a per-request `AsyncLocalStorage` scope:
`OpenRouterRequestQueue`'s loop runs in the async context of whichever request first started it,
so its 429 line for request B would be attributed to request A's scope. Over-redaction across
concurrent requests is harmless; a missed value is not.

**Where values come from.** Every header fetch of a request, through `ComposedHandler`'s one
choke point `fetchHeaders` (`composed-handler.ts:1755`): `credentialValuesFromRequest` takes
every credential-bearing header (authorization, `x-api-key`, `api-key`, `x-goog-api-key`,
cookie values, any header whose name contains `token`, `secret` or `key`), with and without its
scheme word, plus the endpoint's credential query parameters. That covers the primary fetch, the
parameter re-fetch, the 401 retry's fresh token and every Responses leg. A transport that signs
outside its headers exposes the value through `redactionSecrets?()`: Devin (the key is in the
body) and Antigravity (its capacity fallback sends the access token itself). The advisor adds
Claude Code's inbound bearer and `x-api-key` to the main request's lease when it reads them
(`claudeRequestFacts`, `handlers/native-handler-advisor.ts`). The native passthrough registers the
exact headers it sends (the inbound bearer or key, or its fallback key) on EVERY native request,
before its fetch (`NativeHandler.handle`), so an ordinary native turn's lease is not empty.

**Who holds a lease, and when it is released.**

| Request | Installed by | Released when |
|---|---|---|
| Every session-app route | `app.use("*", …)` (`proxy-server.ts:793`) sets `SIGNING_SECRETS_KEY` | the response body is fully read, cancelled or errors; at once for no body (`releaseWhenBodyEnds`, `handlers/shared/call-context.ts`). A cancel releases only after the parser has cancelled its upstream reader AND its read loop has settled (`cancelEndsUpstreamWork`, `stream-parsers/upstream-cancel.ts`): a flag-only parser cancel left the loop reading and logging frames after the release. A cancel owns the release once it has begun: cancelling resolves an outstanding read with `done` before the source's cancel settles, so `releaseWhenBodyEnds` sets `cancelling` before `reader.cancel()` and a pull that wakes during it never releases. A parser's `cancel()` sets its own `cancelled` flag, and its finalize then writes one neutral "Client cancelled the stream" line, with no ending classification, no turn-end hook and a token update only for usage the provider sent. That token update still fires `ComposedHandler`'s stats callback, so the handler wraps its streamed body in `notifyOnDownstreamCancel` (`stream-parsers/upstream-cancel.ts`), which flags the cancel BEFORE forwarding it; the record of a cancelled turn carries `success: false`, `error_class: "cancelled"`, `error_code: "client_cancelled"` (the existing error pair, no new `StatsEvent` field), and a cancelled turn without provider usage records nothing. On a throw that reaches the middleware (only when an inner `onError` itself threw: hono's compose answers a route's Error inside `next()`), the error's message and stack are redacted against this request's own set before the release |
| An advisor panel call | the panel gateway (`handlers/advisor-panel-gateway.ts`) | when the call's work settles, after the body was read and redacted; a timed-out call's aborted work can still log |
| A Claude advisor call | `runClaudeAdvisorCall`, for its own headers | when it returns (the login value is also on the main request's lease) |
| A Context nothing installed (tests) | `signingSecretsOf` (`call-context.ts:57`) | never: retention costs redaction, never exposure |

The lease belongs to the INBOUND request, never to one hop, because `FallbackHandler` logs its
combined error after every hop has returned; and it outlives `handle()`, because a streamed body
is parsed and logged long after the handler returned.

**Every sink, and how it is covered.**

| Sink | Covered by |
|---|---|
| `--debug` file, always-on `~/.claudish/logs/`, stderr, `DiagOutput` | `log()` and `logStderr()` call `redactSigningValues` before any write (`logger.ts:282`, `:320`); `logStructured`/`logRecovery` go through them. This covers the queue's 429 line, the parsers' frame and error lines, the auth-refresh exception and `FallbackHandler`'s stderr |
| `CLAUDISH_UPSTREAM_ERROR_LOG`, team/pane/MCP error text | `redactSecrets` runs the registry pass before its shape rules (`redact.ts:246`) |
| Telemetry report | `buildReport` runs it before `sanitizeMessage` (`telemetry.ts:439`, `:473`) |
| Text sent back to Claude Code | `redactForClient` (`redact.ts:235`) at each client-body family: the native passthrough's non-success JSON body and the data lines of an SSE error event (every other byte passes unchanged). The passthrough holds each SSE event until its blank separator and only then decides: SSE fixes an event's type at dispatch and `event:` may legally follow the `data:` it names, so redacting line by line once `event: error` had been seen let `data: …` then `event: error` through unredacted. An event is an error when its LAST `event:` names `error` or its data is JSON with `type: "error"` (`redactSseErrorEvent`, `handlers/native-handler.ts`); a non-error event is forwarded byte for byte, one event late at most, `ComposedHandler`'s error bodies, the Responses leg issuer, the error frames of every stream parser (`anthropic-sse`, `openai-sse`, `gemini-sse`, `ollama-jsonl`, `devin-connect`, `responses/claude-sse-sink`), `FallbackHandler`'s combined body and thrown messages, the auth-failure bodies (`respondAuthFailure`), the 7b/7c stream-head failure bodies (`surfaced` and `provider_message`), the proxy's catch and `onError` bodies |
| An advisor result | the gateway redacts the whole body by value against the call's own set (`redactExactValues`, `redact.ts:215`) before the reason reaches records, warnings or the tool result |

**Parser rule: close last.** On a normal end the lease is released when the consumer reads
`done`, which follows the parser's `controller.close()`. A parser that awaits anything, or logs
upstream-derived text, after its close does so with the lease possibly gone. Every parser here
closes in its teardown, after its last log line; keep it that way.

A new sink that writes upstream text without going through `log`, `logStderr` or
`redactSecrets`, or a client body built from upstream text without `redactForClient`, reopens
credential echo, and nothing errors. A refresh token the credential layer sends to a token host
is not a signing value of the model request and is not registered; that layer formats its own
errors through its shape redactor.

## An internal call's deadline reaches every piece of upstream work (`handlers/shared/call-context.ts`)

An advisor panel call has a deadline (60 s, 30 s for the collector). `Promise.race` alone would
stop the WAITING, not the work: the chain would advance to its next hop, a queued request would
still start, and a retry sleep would still fire, all billed. The gateway therefore installs an
abort signal on the call's Context (`CALL_ABORT_SIGNAL_KEY`, `call-context.ts:241`), and every
place upstream work can start or wait checks it. Main requests never install it, so
`callAbortSignal(c)` is `undefined` and every expression below collapses to the main path's code.

| Upstream work | Reach point |
|---|---|
| Handler entry | already aborted → `abortedResponse()` (`composed-handler.ts:1203`) |
| Token refresh (5b), header fetch | `raceCallAbort(...)` (`:1515`, `:1762`); the shared single-flight refresh is not cancelled (unbilled), the handler stops waiting; `raceCallAbort` owns the losing promise's rejection |
| Queued work | `doFetch` rejects with `AbortError` before calling `fetch` when the signal is aborted (`:1833`); every `enqueueRequest` call gets `{signal}` (`:1852`, `:1931`); the OpenRouter and Gemini queues drop a waiting entry on abort and reject an aborted entry before and after their rate-limit wait (`shared/openrouter-queue.ts`, `shared/gemini-queue.ts`); `LocalModelQueue` already honoured it |
| Primary fetch and its body | the signal is composed with the deadline clamp (`withCallSignal`, `:1843`), so it still governs the body read after the clamp is disarmed; an abort returns before any connection-error classification, stderr line or recovery (`:1866`) |
| Parameter re-fetch, 401 auth retry | pre-start check, `raceCallAbort` on the forced refresh, composed fetch signal (`:2087`, `:2189`) |
| 7b stream-head re-issue and its backoff | `sleepUnlessAborted` ends the wait (`:3002`); the re-issue uses `doFetch` |
| Responses legs | `AbortSignal.any([turnSignal, callSignal])` (`:2851`) |
| Antigravity retries and capacity fallback | signal checked before each attempt and each fallback candidate, passed to the candidate `fetch`; the retry sleep is `sleepUnlessAborted` (`providers/transport/antigravity.ts:614`); the quota reads are raced, not cancelled |
| OpenAI and anthropic-compat retry waits | `sleepUnlessAborted(delay, opts.signal)` (`providers/transport/openai.ts:149`, `anthropic-compat.ts:203`) |
| Routing chain advancement | `FallbackHandler` checks at the top of each iteration, right after `handle()` returns (returning that response before `isRetryableError` or any `[Fallback] … failed` line), and in its catch (`fallback-handler.ts:71`, `:90`, `:241`) |

`abortedResponse()` (`call-context.ts:332`) is HTTP 408, error type `timeout_error`, header
`x-claudish-call-aborted: 1`. Nothing classifies it by status, it writes nothing to stderr, and
main requests never produce it. Accepted residuals: the 7c Devin re-issue's backoff sleep can
outlive the deadline by one delay (no upstream work starts after it), and the tier-1 recovery
re-issue is not given the signal, because advisor calls skip tier 1
(`x-claudish-no-recovery: advisor`) and the primary catch returns on abort before recovery.
