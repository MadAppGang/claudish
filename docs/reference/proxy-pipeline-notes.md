# Proxy pipeline notes — non-streaming, inline system messages, capture, debugging

**Deferred from `CLAUDE.md`.** The hard constraints stay as one-liners in `CLAUDE.md`; this file holds the reasoning, the regression-test inventory, and the step-by-step workflows.

## Non-streaming (`stream: false`) support

Claude Code's agentic loop always sends `stream: true`, but **`/compact` (context condensation) and any non-streaming Anthropic API caller send `stream: false`** and expect a single JSON `message` body (`Content-Type: application/json`), NOT SSE. Returning SSE to such a client surfaces as `"API Error: API returned an empty or malformed response (HTTP 200) — check for a proxy or gateway intercepting the request"` and **blocks the affected operation** (a session that can't compact eventually overflows and the agent stalls — a never-hang-priority violation).

Every adapter's `buildPayload` hardcodes `stream: true` (the proxy always drives the upstream provider in streaming mode), and the whole translation pipeline emits Claude SSE. To serve non-streaming clients, `ComposedHandler.handle()` buffers the already-translated SSE back into one Anthropic message via `collectAnthropicSseToMessage()` (`handlers/shared/collect-sse-message.ts`):

- The trigger mirrors `request-logger.ts`'s `stream` definition exactly: `wantsStreaming = payload?.stream === true`. Anything else → buffer to JSON.
- `NativeHandler` (Anthropic-direct/Opus) already honored `stream: false` natively — that is why `/compact` worked on Opus but failed on every proxied/composed model. This closes the same gap for ComposedHandler (and therefore FallbackHandler, which delegates to it).
- The collector **never throws** (never-hang-priority): a broken/empty stream degrades to a well-formed message with an empty text block. It reuses the full pipeline (all stream formats, web-tool interception, empty-response classification) verbatim — it just collapses the SSE into a message at the end.
- Regression tests: `handlers/shared/collect-sse-message.test.ts` (text, tool_use, mixed thinking/text order, empty body, malformed lines, unparseable tool JSON).

## Inline system message handling

Claude Code v2.1.153+ injects `role: "system"` messages inline (e.g. system-reminders). Anthropic-compatible providers (Z.AI, MiniMax, Kimi) reject these — only "user"/"assistant" accepted. The fix:

- `composed-handler.ts`: strips inline system messages from `requestPayload.messages` for `anthropic-sse` transport, merges into top-level `system` field
- `openai-messages.ts`: same strip for the OpenAI format path

## Diagnostic body capture

Set `CLAUDISH_CAPTURE_DIR` env var to enable full request body capture for offline reproduction of hangs or malformed responses. Disabled by default (no-op when unset). Files written as JSON with metadata (timestamp, source IP, model, PID, machine header).

In the Docker deployment, `CLAUDISH_CAPTURE_DIR=/captures` is bind-mounted to `D:\claudish-captures` on the host, so captures persist across container recreates. Compacted nightly to 7z, then backed up to GDrive (see `capture-retention.md` memory). Capture format and analysis: `docs/reference/traffic-analysis.md`.

## Debug logging

Debug logging is behind the `--debug` flag and outputs to the `logs/` directory. It's disabled by default.

Keep full debug logging (including empty chunks, raw deltas) in log files — needed to understand real model streaming behavior. Suppress noise at the registration/initialization level (e.g., conditional middleware), not at the streaming data level.

### Raw SSE capture (v5.14.0+)

When `--debug` is active, both stream parsers log raw SSE events:

- `[SSE:openai] {...}` — every OpenAI SSE data line
- `[SSE:anthropic] {...}` — every Anthropic SSE data line

These are greppable and extractable into test fixtures for regression testing.

## Debugging failed model translations

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

## Format translation test harness

`packages/cli/src/format-translation.test.ts` — SSE replay tests for the full translation pipeline.

**Fixture-based**: Each `.sse` file in `test-fixtures/sse-responses/` is a captured SSE stream from a real provider response. Tests replay fixtures through the stream parser and assert correct Claude SSE output.

**Helpers**: `parseClaudeSseStream()`, `extractText()`, `extractToolNames()`, `extractStopReason()`, `fixtureToResponse()`

**Adding regression tests**: After extracting fixtures from a debug log, add a `describe("Regression: <model>")` block. Template is at the bottom of the test file.

---

## `omitReasoningContent` and the structural no-op on the OpenAI wire

Merged from `CLAUDE.md` on 2026-08-23. Source: `810aeb4`, `7681f11`.

`omitReasoningContent` is an optional custom-endpoint field (default `false`) that drops
`reasoning_content` from outbound assistant messages. Set it for backends that validate their request
body strictly.

**Why it has to exist at all.** The OpenAI-format converter emits `reasoning_content` whenever a
thinking block is present in history (`processAssistantMessage`, gated on `hasThinking`) —
**independent of any opt-in** — because the consumers disagree with each other:

| Backend | Requirement |
|---|---|
| DeepSeek | *Requires* it echoed back; a thinking-mode conversation whose recent assistant messages lack the field is rejected with HTTP 400. |
| Kimi K2.5 | Requires it from turn 2 onward, without opting into `preserveThinkingInHistory()`. |
| GLM | Ignores it. |
| Mistral | Rejects it: `HTTP 422 extra_forbidden` on `body.messages[N].assistant.reasoning_content`, failing **every** turn of a real thinking-mode session. |

**Why the existing strip cannot handle it.** `ComposedHandler` filters `type:"thinking"` blocks out of
message content arrays — but that strip runs *after* `convertMessages`, by which point the OpenAI
conversion has already flattened content to a string and hoisted the reasoning into a sibling scalar.
On the OpenAI wire the block filter is a **structural no-op**: it can never reach the field. Hence a
separate pass, `stripReasoningContent()` in `openai-messages.ts`, applied to the *converted* messages.

### Production incident, 2026-08-20

Mistral was promoted to step 0 of the sonnet cascade while the GLM nominal was walled, so 100% of
sonnet traffic hit it: **28 of 32 requests failed (87%)**. Compounding it, the hub image predated
`6bd6f7a`, so the non-quota 422 surfaced to clients instead of failing forward to the next step, and
the fleet stalled.

Two independent causes, each necessary: the field should not have been sent, **and** a sick
intermediate step should have degraded rather than blocked. Interactive sessions had to be resumed by
hand on each machine — a 422 is a hard 4xx and Claude Code does not auto-retry it; only scheduled
agents self-recovered.

Measured the same day: Mistral's `zai-glm-5-2` emits **no** reasoning traces at all (0 thinking
blocks, 0 `reasoning_content` in its SSE) — it reasons in plain text inside the answer. So nothing is
lost by stripping, and that step is `degraded`, not `lateral`: a non-thinking GLM 5.2 standing in for
a thinking nominal.
