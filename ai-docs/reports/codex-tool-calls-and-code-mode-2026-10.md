# Codex tool calls: zero-delta fix, parallel-wrapper retry, code mode (2026-10)

Branch `worktree-investgiage-gpt-file`, base `086cf608`. Sibling report:
`codex-parallel-wrapper-degeneration-2026-10.md` (the request-factor experiment, part B).

## The defect

`cx@` sessions failed parallel tool calls with Claude Code's
`InputValidationError: … The required parameter 'file_path' is missing`. Two causes, both measured:

1. Since late July 2026 the Codex backend sends every multi-call turn with ZERO
   `function_call_arguments.delta` events (330/330 multi-call turns in 400 replays). The arguments
   arrive only in `function_call_arguments.done` / `output_item.done.item.arguments`. claudish's
   Responses parser forwarded arguments only from deltas, so Claude Code received `{}`.
2. About 1% of turns: the model emits a degenerate `parallel` wrapper (`{"tool_uses":[{"recipient_name":
   "functions.Read",…`) after a 361–484 s keepalive-only stall, looping until `max_output_tokens`.
   No request factor changes the rate (Fisher p = 1.000 for effort low/medium, 4 tools, strict:false).

The root of both: claudish drove Codex models with classic parallel function calling, which the
official Codex client no longer uses for these models (`/models` publishes `tool_mode: code_mode_only`).

## What changed

**Part A, translation (every Responses connection):** final arguments emitted when no delta arrived;
a valid `parallel` wrapper expanded into tool_use blocks; the parser split into a leg parser and a turn
driver so a degenerate wrapper or a 150 s stall (Codex OAuth only; healthy max over 8,239 real legs was
61.7 s) is retried inside the same turn, with honest usage for the abandoned leg; a non-streamed turn
that ends in an SSE error is answered with an error response carrying `x-claudish-stream-failure`, which
FallbackHandler returns verbatim (a model fault never walks a subscription user onto a metered hop).

**Part C, code mode for `openai-codex`, default `auto`:** one freeform `exec` tool rendered from Claude
Code's tools; scripts run in a QuickJS-wasm sandbox (CPU, heap and wasm-growth limits, no host escapes);
each `tools.X()` call is relayed to Claude Code as a `toolu_cx_<exec>_<seq>` tool_use, so every effect
still goes through Claude Code's permissions; the script resumes from the tool_results; history is
rebuilt as `custom_tool_call` items; a script whose state is gone (restart, eviction) is answered
honestly (`Script failed` with the results, `Script terminated` when the results never arrived). Code
mode turns on only when the account's `/models` reports `code_mode_only` for the model, on the OAuth
arm, with tools. Rationale and measurements: `ai-docs/architecture/code-mode.md`.

## Review

Three reviewers on the full branch (internal, gpt-6.1-sol, gemini-4-argon), then two on each fix round.
Round 1: FAIL — 1 CRITICAL (a script's `toJSON()` ran with the CPU limit disarmed and could hang the
proxy), 12 HIGH, 9 MEDIUM. All fixed or rejected with cited lines (23 commits); round 2 PASS ×2 with 6
small findings, fixed (7 commits). The CRITICAL was found by one reviewer and confirmed by a second; the
third missed it.

## Tests

379 new black-box tests (written blind from the design and the public seams by external GPT models; the
last 13, and one updated assertion, by the Codex CLI after the OpenAI API account ran out of credits).
Test data copied from real captures. 18 source mutations, each re-introducing a defect the tests guard,
all turned the tests red;
the K1 mutation made the sandbox test hang until a 60 s timeout. Full suite: 5645 pass, 0 fail.

## Live validation (real Claude Code → this branch's build → real Codex backend, `cx@gpt-6.1-sol`)

| check | iteration 1 | iteration 2 (after fixes) |
|---|---|---|
| classic mode, parallel Read ×10 | 10/10 answer 6, 0 input errors | 6/6 |
| code mode `auto` ×10 per Claude Code version | answers right, but 0/39 scripts resumed on 2.1.303 (D1) | 19/19 (2.1.303) and 20/20 (2.1.304) resumed |
| code mode forced ×5 per version | 0/9 resumed (D1) | 10/10 and 9/9 |
| edit + Bash ×3 per version | fail on 2.1.303 | 3/3 and 3/3 |
| restart mid-script | unanswered script called `Script completed` (D2) | `Script terminated` |
| compiled binary | sandbox loaded, answer 6 | same, script resumed |
| `openai@` regression ×3 | BLOCKED: `credit_balance_exhausted` | BLOCKED |

D1: Claude Code 2.1.303 ends every request with a `role: "system"` message (2.1.304 sometimes ends with a
"deferred tools" system message); code mode looked only at the last message, so no script ever resumed
while every answer still came out right (the lost-state answer carries the results). Code mode now reads
only user/assistant messages. Neither the reviews nor the unit tests caught it: every test built the
request shape from the design, not from the harness.

## Open items

- Re-run check: `ai-docs/benches/codex-code-mode/` (madbench; `classic`, `auto`, `auto-edit` on
  `cx@gpt-6.1-sol`, subscription only). First run 2026-10-20 on Claude Code 2.1.304: 15/15, 19/19 exec
  scripts resumed, 0 input errors in tool_results. Second run with the `single-call` scenario (V3's
  purpose on the subscription: 32–34 streamed deltas, forwarded once): 20/20 at `--concurrency 4`.
  Claude Code 2.1.303, where D1 lived, was not pinned.
- claudish defect found by the bench: `createTempSettingsFile` (`claude-runner.ts:815`) names the file
  `settings-<Date.now()>.json`, so two sessions started in the same millisecond share one settings file
  (status line, hooks). The bench spaces launches 100 ms apart until this is fixed.
- Behaviour changes outside code mode, for the PR and release notes: `d6629064` identity-filters
  `instructions` on every `cx@`/`openai@` Responses request; a 401 whose forced refresh lands on another
  ChatGPT account is answered with the upstream 401, not resent (`1fe1b580`, `a808fab2`).
- `openai@` regression check (V3) not run: on 2026-10-20, after a credit top-up, the Keychain
  `OPENAI_API_KEY` (`sk-proj-…`) still got `credit_balance_exhausted` inside a 200 stream; claudish
  reached `https://api.openai.com/v1/responses` on the `direct-api` arm as intended.
- Not proven live: a mixed classic/code-mode history after `--resume`; Esc on a nested permission prompt.
- Not covered by tests (no seam or no capture): the real OAuth refresh single-flight; `codeMode` through a
  provider profile; an image tool_result inside an exec output.
- Out of scope, seen: system messages inside the conversation never reach any OpenAI-format model;
  claudish sets `CLAUDE_CODE_AUTO_COMPACT_WINDOW=1050000`, which Claude Code 2.1.304 caps at 1M with a
  warning; `packages/cli` pins `@types/bun: "latest"`, which `bun add` drifted to 1.4.3 (+3 type errors;
  set back to 1.3.14 by hand).
