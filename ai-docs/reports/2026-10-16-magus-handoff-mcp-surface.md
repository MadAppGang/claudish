# Handoff to magus — claudish MCP surface changes (branch `worktree-claudish-mcp-update`)

Date: 2026-10-16. From: session claudish-mcp-update (claudish). To: the magus repo owner
(session claudish-mcp-feedback edits magus; claudish source is edited only in claudish).

Status: on branch `worktree-claudish-mcp-update`, 15+ commits on v10.6.1 (`086cf608`). NOT pushed, NOT
released. Nothing below is live for a user until the release that carries it; the version is named in
that release's notes. Until then the installed claudish 10.6.1 still behaves the old way — including the
"Channel Mode" text in its MCP `instructions`.

## 1. What changes for a magus caller

| # | Change | Old (10.6.1) | New | Breaking? |
|---|---|---|---|---|
| 1 | `run_prompt` on a Claude model | proxy POST with no credential → `Proxy error: 401 … x-api-key header is required` | runs `claudish -p` once; Claude Code signs in with the user's own login; answer ends `Auth: Claude Code login (subscription)` | no (fix) |
| 2 | `run_prompt` / `compare_models` `max_tokens` param | accepted, default 4096 | **removed from both schemas**; a call that passes it gets the MCP schema's unknown-argument handling | yes, for callers that pass it |
| 3 | Tool group `channel` | `CLAUDISH_MCP_TOOLS=channel` → 7 session tools | renamed **`session`**; `channel` is no longer a group (see §3 for what it selects) | yes |
| 4 | New group `debug` | — | `CLAUDISH_MCP_TOOLS=debug` → `compare_models` only | — |
| 5 | `compare_models` group | `low-level` | **`debug`**; `low-level` is now `list_models, run_prompt, search_models` | yes, for `low-level` profiles that use it |
| 6 | Push notifications | `notifications/claude/channel` frames + `experimental: {"claude/channel": {}}` capability | **removed**. Hosts poll `list_sessions` / `team status`; `<channel source="claudish">` blocks never arrive | yes |
| 7 | MCP `instructions` text | had a "Channel Mode" section (events, `<channel>` tags) | rewritten: which tool to use + polling workflow; no `<channel`, no "notification" | — |
| 8 | `serverInfo.version` | hard-coded `9.0.0` | the package version | no |
| 9 | `SlotRow` (team status rows, `list_sessions` rows) | no detail on failure | new field **`reason_detail: string \| null`** (your request 4): provider's `error.message`, or the first line of the kept detail; null on non-terminal, COMPLETED, nothing readable; ≤160 chars; never the raw body | no (additive; contract v1 allows new fields) |
| 10 | Pane children (create_session sessions, team slots) | inherit the user's `editorMode` | forced `editorMode: "normal"` in claudish's `--settings` overlay, and the prompt waits out Claude Code's stdin reset before typing (≥3 s stable prompt box; retypes once if the box still holds the text) | no (fix for `prompt_not_accepted` under vim mode) |

Unchanged: tool names; every session tool's input schema and answer; `team` modes; session records on disk
(`~/.claudish/sessions/<id>/{spawn.json,waits.jsonl,meta.json,events.jsonl,screen.txt}`) and team records,
which the status mod and `session-monitor.ts` read; `notifications/progress` keepalive on `team`,
`run_prompt`, `compare_models`, `preflight` when the call carries `_meta.progressToken`.

Tool lists per `CLAUDISH_MCP_TOOLS` (exact):

| Value | Tools |
|---|---|
| unset / `all` | all 14 |
| `low-level` | `list_models`, `run_prompt`, `search_models` |
| `agentic` | `preflight`, `report_error`, `team` |
| `session` | `cancel_session`, `capture_session`, `create_session`, `get_diagnostics`, `get_output`, `list_sessions`, `send_input` |
| `debug` | `compare_models` |

`run_prompt`'s new description starts "One quick prompt, straight to one model's API" and says it is not
subagent work — use `create_session` or `team` for that. `compare_models`' description starts "DEBUG.".

## 2. Magus files that go stale (paths relative to the magus-src root; lines from claudish-mcp-feedback's survey on 2026-10-16)

| File | Line(s) | What is stale | Change to make |
|---|---|---|---|
| `plugins/claudish/README.md` | 45 | `compare_models` listed under low-level | move it to a `debug` group row |
| same | 50-51 | `CLAUDISH_MCP_TOOLS` groups incl. `channel` | `all \| low-level \| agentic \| session \| debug` |
| same | 230 | heading "Monitor and channel mode" | "Monitoring sessions" (polling) |
| same | 349-363 | `notifications/claude/channel`, `--dangerously-load-development-channels` | delete; describe polling `list_sessions` |
| `plugins/claudish/skills/claudish-usage/SKILL.md` | 25, 586 | `compare_models` | mark as a debug tool, group `debug` |
| same | 576 | `run_prompt(model, prompt, system_prompt, max_tokens)` | `run_prompt(model, prompt, system_prompt)`; add "one completion, no tools, no session — not subagent work" |
| same | 559-561 | "Channel mode (optional; needs `--channels`)" | delete |
| same | 882 | channel events | polling |
| `plugins/multimodel/commands/delegate.md` | 4 | description "via claudish MCP channel session" | "via a claudish MCP session" |
| same | 144-160 | `<channel source="claudish" …>` handling, "Monitor line / channel event" table column | poll `list_sessions` (state, activity, idle_seconds, `reason_detail`) |
| `plugins/multimodel/skills/multi-model-validation/SKILL.md` | 679, 686, 2004, 2013 | wait for `completed` channel events | poll `team status` / `list_sessions` until no slot is RUNNING |
| `plugins/multimodel/skills/error-recovery/SKILL.md` | 148, 654, 804, 817 | channel events | `get_diagnostics` + `reason_detail` |
| `userdocs/guides/multimodel.md` | 234 | diagram alt text "channel events" | "session polling" |
| `autotest/delegate/test-cases.json` | 3, 6, 120 (`delegate-channel-event-input-15`) | "channel-based" workflow, channel-event input case | reword; drop or rewrite the channel-event case |
| `benches/model-tracking-protocol/stub/claudish-stub.ts` | 288, 315 (`max_tokens`), 307, 703 (`compare_models`) | copied tool schema | drop `max_tokens`; `compare_models` in `debug` |
| `benches/model-tracking-protocol/grade.ts` | 321, 382 | counts `compare_models` as a dispatch | keep or drop by intent; it is now a debug tool |

Not stale: `plugins/claudish/.mcp.json` (sets no `CLAUDISH_MCP_TOOLS`, so it gets `all`);
`plugins/claudish/hooks/status/` (polls `team status` / `list_sessions`; can now show `row.reason_detail`
— already done per claudish-mcp-feedback); `plugins/claudish/scripts/session-monitor.ts`. Historical files
under `docs/plans/`, `docs/research/`, `ai-docs/` are point-in-time records; leave them.

Line numbers drift; re-grep `channel`, `max_tokens`, `compare_models`, `CLAUDISH_MCP_TOOLS` before editing.

## 3. Behaviours a magus prompt must not rely on

- `CLAUDISH_MCP_TOOLS=channel` (the removed name) currently falls to the unknown-value rule = all 14 tools,
  on 10.6.1; on this branch it writes one stderr warning naming `session` and still selects all tools. Use `session`.
- No push: a host that waits for a `<channel>` block waits forever. Poll `list_sessions` (about every 10 s
  is enough; `idle_seconds` and `activity` say whether a session is working).
- `run_prompt` is one completion. It runs no tools and keeps no session. Magus skills that use it for real
  work (dev `/dev:fix`, `/dev:architect`; seo review; agentdev develop) get an answer only.

## 4. Known claudish defects magus will see (not fixed by this branch)

1. `prompt_not_accepted` in panes — Claude Code resets stdin 1-2 s after drawing its prompt box; claudish
   can type into that window. Vim mode makes it unrecoverable. claudish-side mitigation is committed on
   this branch (measured: the MCP Bench passed `create-session` and `team` for all 9 programming models,
   27/27 with `run-prompt`, with `"editorMode":"vim"` still in the user's settings); the full fix is magmux 0.16.0 (owner: session broke-vim-mode), after which claudish passes a
   `claude-code` controller declaration to magmux.
2. A session whose child launches background agents never settles: it stays RUNNING (activity
   `background`) with empty `get_output`. Claude Code 2.1.301 delivers the agents' `task-notification`s
   mid-turn as `attachment`/`queued_command` transcript records, and claudish's transcript follower counts
   a completion only from a `user` record, so launched stays above completed forever. Confirmed by replaying
   the real transcript through the production settle functions. The magus status mod's injected wake
   message was ruled out as the cause. Report:
   `ai-docs/reports/2026-10-16-session-unsettled-background-agents.md` (claudish repo). Until fixed, a
   magus delegate prompt that tells the child to use background agents produces a session that must be
   cancelled.
3. A delegated child's own `create_session` calls do not inherit a parent's `claude_flags` workaround.

## 5. Evidence

- claudish branch commits: `git log --oneline 086cf608..worktree-claudish-mcp-update` in the claudish repo.
- Live run: madbench MCP Bench `run-prompt` Scenario, 9 models, 9/9 pass on the branch build
  (session dir `ai-docs/sessions/dev-feature-mcp-run-prompt-claude-20261016-a7c3/validation/result.md`).
- Architecture: `ai-docs/architecture/mcp-sessions.md` (was `mcp-channel.md`; the source module moved from `channel/` to `mcp-session/`), `pane-session.md`.
