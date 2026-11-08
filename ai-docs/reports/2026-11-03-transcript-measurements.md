# Reading a child's transcript as text lines: measurements behind `transcript_session` (MTL-373, 2026-11-03)

The scripts (`measure-transcripts.ts`, `measure-render.ts`, `measure-scan.ts`) and their raw output
lived in the gitignored session directory
`ai-docs/sessions/dev-feature-session-transcript-20261103-205833-9e228167/`; this file keeps their
results. Corpus: the 400 newest `~/.claude/projects/*/*.jsonl` files on the development machine.
Rationale: `ai-docs/architecture/mcp-sessions.md`, `transcript_session`.

## The transcript is complete and append-only

- 0 unparseable lines, 0 files ending without a newline at the time of reading. A file being
  written can still end in a partial line, so the reader stops at the last `\n`.
- Compaction appends: 42 of 400 files hold a `system/compact_boundary`, each followed by a
  `user` entry with `isCompactSummary: true`. Earlier lines stay in the file (one transcript: 1,340
  lines before its first boundary, three boundaries, 5,058 lines in all). The file is complete
  from the first turn.
- Subagent turns never appear in the main file (`isSidechain: true` in main files: 0). They live
  in `<transcript>/subagents/*.jsonl`: 64 sessions, 1,812 files.
- `continued-in` (`{type, sessionId, continuedInSessionId}`): 4 files on the whole machine, none of
  them a claudish child (claudish refuses `/clear` and `/resume` in `send`).
- System subtypes, machine-wide: `stop_hook_summary` 17,681, `turn_duration` 16,062,
  `away_summary` 2,371, `informational` 868, `local_command` 661, `compact_boundary` 500,
  `scheduled_task_fire` 67, `api_error` 22, `model_refusal_fallback` 5, `agents_killed` 3,
  `model_refusal_no_fallback` 1.

## Sizes (334,715 JSONL lines)

| Quantity | p50 | p90 | p99 | p99.9 | max |
|---|---|---|---|---|---|
| JSONL line bytes | 954 | 4,960 | 57,594 | 193,169 | 1,363,603 (a `user` entry) |
| assistant text chars (n 9,890; 85 over 8,000) | 171 | 2,191 | 7,249 | 20,941 | 48,788 |
| user text chars (n 3,481; 156 over 8,000) | 444 | 4,680 | 26,440 | 63,088 | 100,039 |
| rendered lines per transcript | 47 | 248 | 1,358 | 1,707 | 1,806 |

Lines over 1 MiB: 7; over 256 KiB: 115. No assistant entry carried more than one visible block.
These set the 200-line page (most sessions arrive in 1–2 calls, the largest in 10), the 8,000
character / 16,000 serialised byte split (99 % of replies are one line), and the 32 MiB skip bound
for a single line.

## Scan cost

The largest transcript on the machine is 124,307,301 bytes, mostly `api-request*` and `attachment`
entries that render nothing. Reading and `JSON.parse`-ing a budget of it from offset 0:

| Budget | read | parse |
|---|---|---|
| 8 MiB | 2 ms | 15 ms |
| 16 MiB | 3 ms | 31 ms |

The page reader scans at most 16 MiB per call, so the worst transcript is crossed in 8 calls.

## Locating a transcript by uuid

A session running under another MCP server has `spawn.json` (uuid, no `cwd`) and no `meta.json`.
One `readdir` of the projects directory and a `stat` of `<dir>/<uuid>.jsonl` per entry, over 1,187
project directories: 1.8–2.0 ms warm, 4.6 ms cold.

## Answer size

Claude Code replaced an MCP result of 61,681 bytes with a "saved to file" stub and accepted
37,758 bytes (`allowance_status`, `mcp-sessions.md`). The transcript answer is budgeted at 32,000
UTF-8 bytes of its compact JSON, 15 % under the accepted size; Claude Code's exact cap was not
measured.

## Tool input keys (salient argument of the `tool` line)

Keys of each built-in tool's input, with their counts: `Read file_path:10220`; `Bash
command:16626 description:14230`; `Skill skill:142`; `AskUserQuestion questions:215`; `Write
file_path:1625`; `Agent description:916 subagent_type:910`; `Edit file_path:1673`; `ToolSearch
query:575`; `SendMessage to:850 recipient:850`; `TaskStop task_id:82`; `WebSearch query:37`;
`WebFetch url:24`; `Glob pattern:1`; `Grep pattern:5`; `Monitor command:62 description:62`;
`CronCreate cron:4`; `ScheduleWakeup reason:7`; `TaskCreate subject:4`; `TaskUpdate taskId:8`.
Any other tool, MCP tools included, shows its first non-blank string input.
