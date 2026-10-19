# `SlotRow.recent`: live validation (2026-10-16)

`recent` is an additive field on mod contract v1 rows (`team` `SlotRow` and `list_sessions`
`SessionRow`): the current turn's last steps, one per main-chain assistant block, at most
`RECENT_STEP_LIMIT` (20). Design: `ai-docs/architecture/pane-session.md`, mod contract section;
code: `packages/cli/src/pane/slot-steps.ts` and `pane/transcript-follower.ts`.

## Method

The MCP server from this branch's build (`packages/cli/dist/index.js --mcp`, `CLAUDISH_MCP_TOOLS=all`)
was driven over stdio by an MCP SDK client. It ran `team` `mode: "run"` with one slot on
`gpt-6.1-sol` (served by `cx@`, Claude Code 2.1.301) and the prompt "Use the Read tool to read the
file ai-docs/release.md in the current directory. Then reply with one sentence that quotes its first
heading line." It polled `team` status every ~7 s until the run settled.

## Result

| Poll (UTC) | state | activity | `recent` kinds |
|---|---|---|---|
| 13:47:33.296 | RUNNING | thinking | `null` (no step yet) |
| 13:47:40.317 | RUNNING | thinking | `tool:Read` |
| 13:47:46.339 | COMPLETED | null | `tool:Read`, `thinking`, `text` |

The settled row's `recent`, verbatim:

```json
[
  {"at":"2026-10-16T13:47:39.271Z","kind":"tool","tool":"Read","summary":"/Users/jack/mag/claudish/.claude/worktrees/claudish-mcp-update/ai-docs/release.md"},
  {"at":"2026-10-16T13:47:44.925Z","kind":"thinking","tool":null,"summary":"**Evaluating file reading**"},
  {"at":"2026-10-16T13:47:45.399Z","kind":"text","tool":null,"summary":"The first heading line is “# Release playbook — claudish”."}
]
```

What this shows:

- A RUNNING row carries the steps so far; a caller does not wait for settle to see the turn move.
- A COMPLETED row keeps the turn's steps (the field is not cleared at settle).
- A tool step's summary is the ONE named target field (`file_path` for Read), never the whole
  input and never the tool result. Paths keep the home directory, by design: the rows stay on
  this machine and the path is the point.
- `at` is the transcript record's own timestamp, so steps order by when Claude Code wrote them,
  not by when claudish polled.

## Unit coverage

`pane/slot-steps.test.ts` (step extraction per block type, the 100-character cut, `redactSecrets`
on summaries, a whitespace-only first `AskUserQuestion` question falls through to the next) and
`pane/transcript-recent.test.ts` (sidechain records skipped, the 20-step cap, a new turn resets).
The whitespace-question case was a real defect the tests found before release.
