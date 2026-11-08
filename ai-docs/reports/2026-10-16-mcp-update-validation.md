# MCP update (10.7.0) — live validation and measurements

Date: 2026-10-16. Branch `worktree-claudish-mcp-update`, released as 10.7.0. Claude Code 2.1.301,
magmux 0.15.1 locally (CI pin v0.14.0), madbench 0.46.0. The rationale for each change is in
`ai-docs/architecture/mcp-sessions.md` and `pane-session.md`; this file keeps the evidence.

## The defect that started it

`run_prompt {model:"claude-opus-5-5"}` on 10.6.1 answered
`Proxy error: 401 ... "x-api-key header is required"` (madbench MCP Bench, 8/9 variants passing).
`runPromptViaProxy` POSTed a bare Messages body to the in-process proxy, whose native route forwards
the caller's credential, and an MCP call carries none. A Claude model now runs as one
`claudish -p` call on the user's Claude Code login (`mcp/run-prompt-claude-code.ts`).

## madbench MCP Bench, run bare in a visible pane

Bench `ai-docs/benches/recommended-models/mcp.madbench.yaml`, the 9-model programming Experiment
(now `experiments/flagship.mcp.experiment.yaml`), worktree build first on `PATH`.

| Run | Scenarios | Result |
|---|---|---|
| run-prompt only, before the pane fixes | run-prompt | 9/9 variants pass 5/5 checks |
| full, with editorMode and retype fixes | run-prompt, create-session, team | `{"errors":0,"failed":0,"passed":27,"skipped":0,"total":27}` |
| full, final pre-merge build (21:05 AEDT) | same | `{"errors":0,"failed":0,"passed":27,"skipped":0,"total":27}` |

Models: claude-opus-5-5, gpt-6.1-sol, kimi-k3, grok-4.7, gemini-4-argon, qwen3.8-max, glm-5.3,
minimax-m3, deepseek-v4-pro. `~/.claude/settings.json` kept `editorMode: "vim"` throughout.

Proof of path:
- claude-opus-5-5 answered with `Auth: Claude Code login (subscription)`, and
  `Tokens: 590 input`: the child ran in an empty directory and loaded no CLAUDE.md (8,718 input
  tokens when it does).
- Every `create_session` record (`~/.claudish/sessions/<id>/meta.json`) and team slot row carries a
  claudish-resolved `provider` (Alibaba PAYG, Gemini, DeepSeek, GLM, Openai-codex,
  Grok-subscription, MiniMax Coding, Kimi-coding, Anthropic (Native)), so every pane ran claudish
  in proxy mode, never a bare `claude`.

## Pane prompt delivery under vim mode and under load

- With `editorMode: "vim"`, every slot failed `prompt_not_accepted`, anomaly `resent_enter`: the
  submit Enter is swallowed in `-- INSERT --`. Fix: the pane child's `--settings` overlay sets
  `editorMode: "normal"`.
- Claude Code resets its input box shortly after the REPL first draws, and text typed before the
  reset is lost. Fix: wait for a 3 s stable box (`REPL_STABLE_MS`), and retype once if the prompt
  is still in the box at the resend check.
- Under load (3 parallel slots, 8 CPU test workers) the first retype version failed 1 run in 3:
  ctrl-u at +1020 ms, a bare Enter at +1667 ms on a stale frame, the empty box first drawn at
  +1830 ms, so Enter hit an empty box. Measured ctrl-u to empty-box latency: 810 ms. Fix: read
  frames until the box clears, up to `NUDGE_CLEAR_DEADLINE_MS` (3 s). After it: 6/6 loaded runs
  and 7/7 reruns of `pane-session.integration` at 54/0.

## max_tokens

- `max_tokens` was removed from `run_prompt` and `compare_models`; Claude Code itself does not set it.
- `claudish --probe anthropic@claude-haiku-5-5` reports an unregistered provider with no credential
  on the measuring machine, so no metered native Anthropic route existed to break.
- On catalog connections, step 5w had already dropped the adapter's fixed 4096, so
  `anthropic-messages` requests (minimax-m3, qwen3.8-max via opencode) carried no `max_tokens`.
  MiniMax answered 200 without it. The Messages API requires the field, so a missing value is now
  filled from the catalog `maxOutputTokens`; with no published ceiling (minimax-m3, and 6 of the 58
  Messages connections in that generation) none is sent. 4096 reached a provider only on the
  no-wire profile path.

## Merge with 10.6.3 (one level of nesting)

PR #296 keeps `CLAUDISH_PANE_CHILD=1` in a session's environment, so a `claudish -p` started below a
session exits 64 "nested session refused". `run_prompt` is one of the four tools a nested server
keeps, and on a Claude model it starts `claudish -p`. The print child drops `CLAUDISH_PANE_CHILD`
with the launch markers; it runs with no tools, no MCP servers, no setting sources and no slash
commands, so the depth stays one. `run-prompt-claude-code.env.test.ts` pins it: with the flag
kept, `nestedLaunchRefusal(child)` returns the refusal text and 2 of 7 tests fail.

## Tests

Written by gpt-6.1-sol through the claudish MCP. Each new suite has a recorded mutation check (the
change reverted, the test failing with the named assertion, then restored by `cp`). Final suite
numbers are in the release PR.
