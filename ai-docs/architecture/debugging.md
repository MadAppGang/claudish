# Debugging

> Debug logging, `CLAUDISH_UPSTREAM_ERROR_LOG`, raw SSE capture, and the failed-translation workflow.
>
> Extracted from `CLAUDE.md` (v7.64.0). Indexed in [`README.md`](./README.md).

## Debug Logging

Debug logging is behind the `--debug` flag and outputs to `logs/` directory. It's disabled by default.
Keep full debug logging (including empty chunks, raw deltas) in log files — needed to understand real model streaming behavior. Suppress noise at the registration/initialization level (e.g., conditional middleware), not at the streaming data level.

### `CLAUDISH_UPSTREAM_ERROR_LOG` — the one thing `--debug` being off loses forever

A non-ok upstream response short-circuits before the stream parser, so
`response-capture` never sees it. `composed-handler.ts` reads the body, hands it
to the classifier, and drops it — and `log()` persists **nothing** unless
`--debug` set a log file. So on a normal run the literal 429/402 body is gone
the instant it has been classified, which is exactly the artifact that
distinguishes a rate limit worth retrying from a hard quota wall that is not.
Reported by @jsboige (#184) from a real incident: a GLM coding-plan 5h cap
saturated, the shape was reconstructable from request counts, the body was not.

`CLAUDISH_UPSTREAM_ERROR_LOG=<path>` appends one JSON line per non-ok upstream
response: `{at, provider, model, status, body}`. Unset = off, and off is the
default **on purpose** — this writes provider error text, which can carry
account identifiers, to a path the user names. It is not part of `--debug`
because the two answer different questions: `--debug` is "show me everything
about this run", this is "keep the one field I will want next week".

Three properties worth preserving if it is ever touched: the body is capped at
2KB; truncation is **marked** (`truncated` + `original_bytes` appear only when
it happened, so an unmarked body can be trusted as whole); and it **never
throws**, because it runs on the error path where something is already going
wrong and a capture facility that can break a request is worse than none.

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

## A session log that stops at `[Proxy] Server started`

That log is not truncated and the proxy did not hang. It means Claude Code
exited before it sent its first `/v1/messages`, so no handler was ever built and
no SSE line was ever written. The always-on log records model traffic; a run
that produced none leaves the header, the port line, and nothing else.

Read the `[Claude Code] Exited …` line that follows it. `claude-runner` writes
one on every exit, naming either the code or the signal, and
`isStructuralLogWorthy` keeps it in the always-on log. It is the only durable
record of why a run ended: without it, the failure notice cites a file that
cannot explain the failure it was cited for.

### The trust prompt is the usual cause

On a machine where claudish otherwise works, the common cause is Claude Code's
own first-run workspace trust prompt, shown in a directory it has never been
trusted in:

```
 Quick safety check: Is this a project you created or one you trust?

 ❯ No, exit
   Yes, I trust this folder
```

The cursor starts on **"No, exit"**, so pressing Enter accepts that default and
Claude Code exits 1. Three properties make this hard to see:

- **claudish is not at fault, and cannot waive it.** Plain
  `claude --dangerously-skip-permissions`, with no claudish involved, shows the
  identical dialog with the identical default. claudish passes that flag
  through; it does not skip the trust check.
- **Declining writes nothing.** `~/.claude.json` gains no entry for the
  directory, so there is no trace on the Claude Code side either. The *absence*
  of a project key for the working directory is therefore the confirming
  evidence, and its presence with `hasTrustDialogAccepted: true` is the fix.
- **It is once per directory.** After accepting, later runs go straight in. A
  user who only ever hits it in one scratch directory can reasonably conclude
  every session is broken.

Verified by reproducing both paths in a terminal: under claudish, and with the
`claude` binary directly, in a directory absent from `~/.claude.json`.

### Why "did any request arrive?" counts `/v1/messages` only

`modelRequestCount()` on the proxy answers whether a model was ever contacted,
which is what separates a harness fault from a provider fault. It counts
`/v1/messages` and nothing else, deliberately.

Claude Code pings discovery and health routes while it starts up, and it emits
those **even when it gets no further than the trust prompt** — measured, not
assumed: a counter over all routes stayed non-zero through a real trust-prompt
exit and so stayed silent in exactly the case it existed to detect. Any future
widening of that counter reintroduces the blind spot.
