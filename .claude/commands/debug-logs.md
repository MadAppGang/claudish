---
description: Analyze claudish debug logs from a failed model run. Extracts SSE fixtures, diagnoses failures, adds regression tests.
---

Analyze the claudish debug log at: $ARGUMENTS

## Step 1: Read and analyze the log file

Read the log file. Look for these patterns:

- `[SSE:openai] {...}` — raw OpenAI-format SSE events from the provider
- `[SSE:anthropic] {...}` — raw Anthropic-format SSE events from the provider
- `[Streaming] Text chunk:` — parsed text content (OpenAI path)
- `[Streaming] Chunk: content=N chars, finish_reason=` — chunk metadata
- `[Streaming] Received N structured tool call(s)` — tool calls
- `[AnthropicSSE] Text chunk:` — parsed text content (Anthropic path)
- `[AnthropicSSE] Stream complete for` — stream summary
- `HANDLER STARTED for` — API turn boundaries
- `Calling API:` — provider endpoint calls
- `Response status:` — HTTP status codes
- `[Fallback]` — provider fallback chain events
- `Error` / `error` — any errors

## Step 2: Produce a diagnosis report

Summarize what happened:

1. **Model & Provider**: Which model, which provider(s) handled it, any fallback chain
2. **API turns**: How many turns, which succeeded/failed (HTTP status)
3. **Text content**: How many text chunks, total characters, did text reach output?
4. **Tool calls**: How many, which tools, did finish_reason=tool_calls occur?
5. **Stop reason**: What was the final stop_reason? (end_turn vs tool_use vs unexpected)
6. **Root cause hypothesis**: Based on the patterns, what went wrong?

## Step 3: Extract SSE fixtures

If the log contains `[SSE:openai]` or `[SSE:anthropic]` lines:

1. Run the extractor: `bun run packages/cli/src/test-fixtures/extract-sse-from-log.ts <log-path>`
2. Report which fixture files were created
3. Show a summary of each fixture (event count, text chunks, tool calls)

If the log does NOT contain raw SSE lines (older claudish version without `[SSE:*]` logging):
- Report that raw SSE logging is not available
- Still provide the diagnosis from Step 2 using the parsed `[Streaming]` lines
- Suggest re-running with `claudish v5.13.2+` which includes raw SSE capture

## Step 4: Add regression test

If fixtures were extracted, add a new `describe()` block to `packages/cli/src/format-translation.test.ts` for this specific failure. Use the template at the bottom of that file. The test should assert what SHOULD work (e.g., text content > 0 bytes, correct stop_reason).

## Step 5: Run tests

Run `bun test packages/cli/src/format-translation.test.ts` to see if the new regression test passes or fails. Report the result.

If it fails — that's the regression test capturing the bug. Propose a fix in the relevant parser or adapter.
If it passes — the issue may be upstream (Claude Code behavior, not claudish translation).
