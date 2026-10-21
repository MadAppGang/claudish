# Codex `parallel` wrapper degeneration: request-factor experiment (2026-10)

**Decision: no variant significantly better.** Lowering reasoning effort to `low` (the official client's default for `gpt-6.1-sol`) or `medium` does not prevent the degenerate `parallel` wrapper: both leaked at the same rate as claudish's `xhigh`. Cutting the tool surface to 4 tools or making every schema non-strict produced 0 leaks in 50 runs each. At a base rate near 1%, that is not significant (Fisher p = 1.000 for each).

Provider `openai-codex` (`cx@gpt-6.1-sol`), endpoint `https://chatgpt.com/backend-api/codex/responses`, claudish source at v10.6.1 (086cf608).

## Method

**The request body was captured, not reconstructed.** claudish's debug log records only the `response.created` echo (`instructions`, `tools`, `reasoning`), never `input`. So one claudish session ran from worktree source with a Bun preload (`capture-preload.ts`) that wraps `globalThis.fetch`. The wrapper re-wraps when `fetch` is reassigned, because hono swaps it. It appends every POST bound for the Codex backend to a JSONL file.
- Runner: `capture-run.ts`, model `cx@gpt-6.1-sol`, `-p`, the parallel-Read prompt, a work dir holding `a.ts`, `b.ts`, `c.ts`.
- The first capture's first turn had only 24 tools, because the Linear MCP server had not connected yet. The second capture had 90 tools, matching the original leak run. That one is `base-body.json`.
- Body fields: `model, input, stream, store, include, instructions (5708 chars), tools (90), max_output_tokens 32000, reasoning {xhigh, summary auto}, prompt_cache_key`.
- claudish sends no `strict`, `parallel_tool_calls` or `tool_choice`. The backend echoes `parallel_tool_calls: true` and rewrites `strict` to 83 true and 7 false.

**Replay harness.** `replay.ts` POSTs `base-body.json` with one variant change, using claudish's `CodexOAuth` and the headers from `codex-credential.ts`. Runs are interleaved at concurrency 4, each raw stream is saved as `raw/<variant>-<n>.sse`, and a 429 or 5xx backs off (none occurred). The backend's echo confirmed every variant was applied unchanged.

**Why the abort is time-based.** The degenerate item is never streamed. Both confirmed leaks sent only keepalives for 6–8 minutes. Then `output_item.added`, `function_call_arguments.done` (the whole 41–96 KB string) and `output_item.done` arrived together, followed by `response.incomplete` with `max_output_tokens`. The first two stalls past 150 s ran to completion as confirmation, and both were degenerate. Later stalls were aborted at 150 s and counted as degenerate (inferred).

## Results

| variant | change | zero-delta multi | single | degenerate (confirmed) | stall-aborted (inferred) | valid parallel | error | total |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| V0 | as sent (`xhigh`) | 95 | 4 | 1 | 0 | 0 | 0 | 100 |
| V1 | effort `low` | 46 | 3 | 1 | 0 | 0 | 0 | 50 |
| V2 | effort `medium` | 48 | 1 | 0 | 1 | 0 | 0 | 50 |
| V3 | tools: Read, Bash, Edit, Write\* | 50 | 0 | 0 | 0 | 0 | 0 | 50 |
| V4 | `strict:false` on all 90 | 46 | 4 | 0 | 0 | 0 | 0 | 50 |

\* This Claude Code's tool list has no Glob or Grep. No `ok-parallel-delta` or `ok-other` runs occurred.

| variant | n | leaks | rate | Wilson 95% CI | Fisher p vs V0 | zero-delta, multi-call turns |
|---|---:|---:|---:|---|---:|---:|
| V0 | 100 | 1 | 1.0% | 0.2–5.4% | — | 95/95 |
| V1 | 50 | 1 | 2.0% | 0.4–10.5% | 1.000 | 46/46 |
| V2 | 50 | 1 | 2.0% | 0.4–10.5% | 1.000 | 48/48 |
| V3 | 50 | 0 | 0% | 0–7.1% | 1.000 | 50/50 |
| V4 | 50 | 0 | 0% | 0–7.1% | 1.000 | 46/46 |

- All runs pooled: 3/350 = 0.86% (CI 0.29–2.49%).
- Pooled V3+V4 (0/100) vs pooled V0–V2 (3/200): Fisher p = 0.553.

**Time from `response.created` to the first output item.**
- Healthy runs (n = 297): min 1.09 s, p50 4.05 s, p90 4.94 s, p99 6.24 s, max 7.38 s.
- Leaks: 456 s (V0-21), 361 s (V1-33), over 150 s (V2-49, aborted).

**The leaks.** All three opened with `{"tool_uses":[{"recipient_name":"functions.Read","parameters":{"file_path":"…`. V0-21's path was wrong from the first character: it named the worktree root plus `a.ts.js.md.txt.xK9pQ2rN7mL4…`, then looped to 41,591 bytes.

## Interpretation
1. **Effort is not the cause.** No change to effort is supported, so B3 does not apply.
2. **Tool surface and strictness are unproven either way.** With a 1% base rate, 0/50 is expected by chance about 61% of the time, and telling 1% from 0% needs roughly 1,000+ runs per arm. The `recipient_name: functions.X` wrapper is the model's native multi-tool protocol leaking through, which points to section C (code mode) as the structural fix.
3. **For A4, detect the stall, not the arguments.** The 7.4 s ceiling comes from a short task. Longer `xhigh` turns can legitimately think much longer, so measure on longer tasks before choosing a threshold.

Data (gitignored), in `ai-docs/sessions/dev-feature-codex-tool-calls-20261016-143706-dc2c/evidence/b-experiment/`:
- `results.jsonl` (400 rows) and `raw/*.sse`
- `base-body.json` and the capture files
- `replay.ts` and `analyze.ts`
- the run logs

The raw streams used as test data in the fix (`V0-1.sse`, `V0-21.sse`, `V1-33.sse`) are copied into `packages/cli/src/test-fixtures/` by the implementation commits.
