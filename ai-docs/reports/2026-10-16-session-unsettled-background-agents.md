# One-shot session never settles: background-agent notifications delivered mid-turn are not read

Date: 2026-10-16. Status: diagnosed, not fixed. Diagnosis verdict: **Confirmed** (offline replay of the real transcript through the production reducer and settle rule).

## Summary

One-shot `create_session` 779a03f0 stayed RUNNING after its child had finished, and ended only by `cancel_session`. The injected plugin message is NOT the cause. The cause is that the child had launched two background agents earlier in the same turn, and Claude Code 2.1.301 delivered the `<task-notification>` of each of them **while the turn was still running**, as `attachment` records of type `queued_command`, not as main-chain `user` records. The transcript follower counts a background agent as completed only from a `user` record (`applyUser` -> `applyNotification`), so it kept `agentsLaunched 2, agentsCompleted 0`. `pathPrimary` refuses to settle while agents are unbalanced, so neither `turn_duration` (08:19:00, 08:19:24) could ever settle the turn; the reported activity was `background`.

## Symptom (as reported, and in the session records)

- `list_sessions`: 779a03f0 `RUNNING` for 70 s+ after the last assistant message.
- `get_output`: `output ""`, `turnsCompleted 0`.
- Ended only by `cancel_session` at `2026-10-16T08:20:30.953Z`.
- `~/.claudish/sessions/779a03f0/meta.json`: `"status": "cancelled"`, `"turnsCompleted": 0`, `"terminalReason": "cancelled"`, `"toolCallCount": 97`, `"turnSource": "transcript"`, `"lastActivityAt": "2026-10-16T08:19:25.401Z"`, `"timeoutSeconds": 1800`.
- `events.jsonl`: `STARTING->RUNNING` 07:54:47.148Z, assistant records to 08:19:24.718Z, then `RUNNING->CANCELLED` 08:20:30.953Z. No settle in between.

## Environment

- claudish 10.6.1 MCP server (reported); the diagnosis read worktree `claudish-mcp-update` at HEAD `87d31943`.
- Claude Code 2.1.301 (every record of the child transcript carries `"version":"2.1.301"`).
- magmux 0.15.1 (reported).
- Child model `cx@gpt-6.1-sol` (spawn routing chain `cx@gpt-6.1-sol+oai@gpt-6.1-sol+zen@gpt-6.1-sol+or@openai/gpt-6.1-sol`), magus claudish plugin enabled inside the child.

## Timeline (child transcript `f2f921c4-...jsonl`; "line" is the JSONL line number)

| time (Z) | line | record | effect on the follower turn view |
|---|---|---|---|
| 07:54:46.847 | 11 | `user`, `origin.kind:"human"`, "Your task is in the file ...turn-1.md..." | witness; `acceptedAt` set |
| 07:56:42.873 | | child calls `create_session` -> 969aa273 (FAILED `prompt_not_accepted` 07:57:16) | ordinary MCP tool_use + tool_result, balanced |
| 08:10:38.845 | 497 | tool_result `toolUseResult.isAsync:true, agentId:"ae0168d27fc09161c"` | `agentsLaunched` 1 |
| 08:10:49.324 / .581 | 503-504 | `TaskStop ae0168d27fc09161c` -> "Successfully stopped task" | nothing |
| 08:10:50.745 | 517 | **`attachment` `queued_command`**, prompt `<task-notification><task-id>ae0168d27fc09161c</task-id>...<status>killed</status>` | **ignored** (no attachment branch) |
| 08:11:04.038 | 516 | tool_result `isAsync:true, agentId:"ab9d8b94e58c3540a"` | `agentsLaunched` 2 |
| 08:15:13.581 | 561 | **`attachment` `queued_command`**, `<task-id>ab9d8b94e58c3540a</task-id>...<status>completed</status>` | **ignored** |
| 08:15:44.725 | 597 | same agent, completed again (after a `SendMessage` resume) | **ignored** |
| 08:15:58.756 | 609 | same agent, completed again | **ignored** |
| 08:18:39.831 | 647 | `TaskStop ab9d8b94e58c3540a` -> "No task found" (Claude Code already holds it finished) | nothing |
| 08:19:00.501 | 652 | assistant `end_turn` "Applied the test-only fixes..." | lastAssistant |
| 08:19:00.566 | 653 | `system/stop_hook_summary` | `stopHookSummaryAfterLast` true |
| 08:19:00.571 | 654 | `system/turn_duration` 1453731 ms, NO `pendingBackgroundAgentCount` (Claude Code: 0 pending) | `td` set; agents 2/0 -> not settled, activity `background` |
| 08:19:10.593 | 663 | `user`, `origin.kind:"plugin"`, "The claudish plugin sent a message: 1 slot finished... 969aa273" | `wakingAfterLast` true (correct: the model did continue) |
| 08:19:16.583 - 08:19:24.295 | 665-671 | `get_diagnostics` tool round; assistant `end_turn` "Confirmed: this is the delayed notification..." | waking cleared by the assistant record |
| 08:19:24.366 | 673 | `system/turn_duration` 13778 ms, no `pendingBackgroundAgentCount` | `td` set; agents still 2/0 -> not settled, activity `background` |
| 08:20:30.953 | | `cancel_session` | RUNNING -> CANCELLED |

## Root cause

**Location:** `packages/cli/src/pane/transcript-follower.ts:494-524` (`applyRecord` has no branch for `attachment` records), consumed by `packages/cli/src/pane/settle-rule.ts:145` (`pathPrimary` returns null while `!agentsBalanced(t)`).

### Observed

1. The transcript has exactly two background-agent launches (lines 497, 516) and **zero** main-chain `user` records containing `<task-notification>`. Every notification for those two agents is an `attachment` record with `attachment.type:"queued_command"` whose `attachment.prompt` starts `<task-notification>` (lines 517, 561, 597, 609), each mirrored by a `queue-operation` enqueue/remove pair.
2. `applyRecord` (`transcript-follower.ts:494-524`) dispatches only `assistant` (516), `user` (517), `system/local_command` (518), `system/stop_hook_summary` (519-520) and `system/turn_duration` (521). An `attachment` record falls through every branch.
3. An agent is counted on launch at `transcript-follower.ts:417` and completed only in `applyNotification` (`transcript-follower.ts:442-447`), reached only from `applyUser` (`transcript-follower.ts:470`) through `isTaskNotification` (`transcript-follower.ts:226-228`), i.e. only for a `user` record.
4. `agentsBalanced` (`settle-rule.ts:72-74`) is `agentsLaunched === agentsCompleted`. With a `turn_duration` present, `decideSettle` returns `pathPrimary(...) ?? notYet` (`settle-rule.ts:172`), and `pathPrimary` returns null on `!agentsBalanced(t)` (`settle-rule.ts:145`) before it ever consults the screen. Path S is unreachable once a `turn_duration` exists (line 172 returns first). `activityOf` reports `background` for this state (`settle-rule.ts:96-98`).
5. Offline replay of the real transcript through `applyRecord` / `turnView` / `decideSettle` (recipe 2 below):

   | cut | waking | agents launched / completed | decision |
   |---|---|---|---|
   | after line 654 (08:19:00 `turn_duration`) | false | 2 / 0 | `{settled:false, activity:"background"}` |
   | after line 663 (plugin message) | true | 2 / 0 | `{settled:false, activity:"thinking"}` |
   | after line 673 (08:19:24 `turn_duration`) | false | 2 / 0 | `{settled:false, activity:"background"}` |
   | end of file | false | 2 / 0 | `{settled:false, activity:"background"}` |
   | end of file, counterfactual `agentsCompleted := agentsLaunched` | false | 2 / 2 | `{settled:true, by:"turn_duration", stopReason:"end_turn", anomalies:[]}` |

   `acceptedAt` stays `2026-10-16T07:54:46.847Z` and `pendingTool` stays null at every cut.
6. Screen facts computed with the production classifier (`inputBox`, `hasChoiceDialog`, `isWorking`, exactly as `pane-session.ts:1171-1180` builds them) on the saved final screen `~/.claudish/sessions/779a03f0/screen.txt`: `boxEmpty:true, choiceDialog:false, working:false`, box rows 45-47. The magus band (`◆ claudish · 1 failed`, `#969aa2 ✕ failed ...`) sits above the box and is neither a choice dialog nor a working row.

### The four candidates

- **(a) screen corroboration fails because of the mod band: rejected.** The final screen corroborates (observation 6) and the counterfactual settles with that same screen (observation 5). Intermediate frames were not captured, but they cannot matter: `pathPrimary` returns before `corroborated` is called (`settle-rule.ts:145-146`).
- **(b) the injected plugin message keeps `wakingAfterLast` true or resets `acceptedAt`: rejected.** It sets `waking` (`transcript-follower.ts:471-474`), which is right because the model did answer it, and the assistant record at 08:19:16 clears it (`transcript-follower.ts:379`). `acceptedAt` never changes (observation 5). The plugin message delayed the turn by 24 s; the turn was already unsettleable at 08:19:00.
- **(c) `pendingTool` or the agent count left unbalanced by the child own `create_session` MCP call: rejected as stated.** Every MCP tool_use (`create_session`, `capture_session`, `get_diagnostics`) has its result; `pendingTool` is null. The agents ARE unbalanced, but by the two built-in background `Agent` launches, not by the MCP call.
- **(d) confirmed:** a background-agent completion arrives as `attachment/queued_command` when Claude Code folds its queue into a turn that is still running; the follower never reads attachments, so the agent tally can never balance and P can never fire.

### Inferred (not directly observed)

- Claude Code writes a notification as a `user` record (`origin.kind:"task-notification"`, as in fixture `tools-session.jsonl`, 2.1.290) when it arrives while the REPL is idle and becomes a new prompt, and as an `attachment/queued_command` when it arrives while a turn is in flight and rides the next API request of that turn. Each notification here sits between a tool round and the next assistant record of the same turn, which fits. The attachment form is not new in 2.1.301: corpus fixture `corpus-redacted/auto-compaction-in-turn.jsonl` (2.1.263) already contains one `queued_command` `<task-notification>` attachment.
- Claude Code itself counted 0 pending agents at both `turn_duration` records (it writes the field only above 0, `pane-session.md` "Background work (D23)"), so the claudish tally and the Claude Code count diverged.
- Without the cancel the session would have hit `timeoutSeconds: 1800` at about 08:24:44Z and ended `timeout`, still with no output.
- `get_output` was `""` because the answer is assembled when the turn settles; no settle, no answer.

## Reproduction

### 1. Live recipe (not run for this report: no live model session was started)

Needs the claudish MCP server and any routable model. The magus claudish plugin is NOT needed to trigger the defect.

1. From the harness, call `create_session` (one-shot) with model `cx@gpt-6.1-sol` (any model works) and this prompt:

   > Launch one background agent with the Agent tool (run_in_background: true), description "noop", prompt "Reply OK and stop." Immediately after it is launched, run the Bash command `sleep 20` in the foreground. Then reply with exactly DONE.

   The foreground `sleep 20` keeps the turn in flight while the agent finishes, so its notification is folded into the turn as `attachment/queued_command`. A variant closer to 779a03f0: launch the background agent, immediately call `TaskStop` on its id, then reply DONE (the `killed` notification is queued mid-turn, as at line 517).
2. Wait until `capture_session` shows `DONE` and an empty input box.
3. At least 40 s later call `list_sessions` and `get_output`.

Expected: state `COMPLETED`, `turnsCompleted 1`, `get_output` returns `DONE`.

Actual (predicted from the confirmed mechanism): state `RUNNING`, activity `background`, `get_output` returns `output ""` and `turnsCompleted 0`, until `cancel_session` or the session timeout.

Confirm the trigger fired: the child transcript (`transcriptPath` in `meta.json`) must hold a `"type":"attachment"` record with `"type":"queued_command"` whose prompt starts `<task-notification>`. If the notification arrived instead as a `user` record (`origin.kind:"task-notification"`), the agent finished after the turn ended and the session settles normally; lengthen the `sleep`.

The recipe this investigation started from (the child calls `create_session` on a model that fails fast, e.g. `no-such-model-zz9`, then replies DONE at once, magus claudish plugin enabled) does NOT reproduce the defect on its own: the plugin message is a `user` record after the turn ended, which the follower reads as a wake and settles at the next `turn_duration` once agents are balanced (observation 5, counterfactual row). It reproduces only when the child also ran a background agent whose notification was folded into a running turn.

### 2. Offline recipe (run; its output is the table in observation 5)

Script (tracked): `ai-docs/reports/2026-10-16-session-unsettled-replay.ts`. It imports `initialFollowerState`, `openTurnState`, `applyRecord`, `turnView` from `packages/cli/src/pane/transcript-follower.ts` and `decideSettle` from `settle-rule.ts`; builds screen facts from `screen.txt` with `screen-model.ts` `applyCapture` and the `screen-classifier.ts` predicates; opens turn 1 at offset 0 with the witness text of line 11; folds the records up to each cut; and calls `decideSettle` with `transcriptQuietMs = chatQuietMs = 120000`, `paneExited:false`.

```
cd /Users/jack/mag/claudish/.claude/worktrees/claudish-mcp-update
bun ai-docs/reports/2026-10-16-session-unsettled-replay.ts \
  /Users/jack/mag/claudish/.claude/worktrees/claudish-mcp-update \
  /Users/jack/.claude/projects/-Users-jack-mag-claudish--claude-worktrees-claudish-mcp-update/f2f921c4-efb3-4103-b089-c9397b667f56.jsonl \
  /Users/jack/.claudish/sessions/779a03f0/screen.txt
```

Without the script, the decisive facts are three `jq` calls:

```
T=/Users/jack/.claude/projects/-Users-jack-mag-claudish--claude-worktrees-claudish-mcp-update/f2f921c4-efb3-4103-b089-c9397b667f56.jsonl
# launches: 2 (ae0168d27fc09161c, ab9d8b94e58c3540a)
jq -c "select(.toolUseResult|type==\"object\") | select(.toolUseResult.isAsync==true) | .toolUseResult.agentId" "$T"
# task-notification user records: 0
jq -c "select(.type==\"user\" and ((.message.content|tostring)|test(\"task-notification\")))" "$T" | wc -l
# where the notifications are: 5 attachment/queued_command records, 4 of them task-notifications (line 608 is an agent-message)
jq -c "select(.type==\"attachment\" and .attachment.type==\"queued_command\") | .attachment.prompt[0:80]" "$T"
```

## Impact

- Every pane session that settles through `decideSettle` (`pane-session.ts:1200`): one-shot and interactive `create_session`, `team` slots, channel sessions, whenever the child launches a background agent (built-in `Agent` with `run_in_background`, or any agent Claude Code runs async) that finishes, or is stopped with `TaskStop`, while the same turn is still running. That is the normal pattern of a delegate that delegates: it launches a runner, keeps working or sleeps, and the runner finishes mid-turn.
- Symptom: RUNNING with activity `background` forever, empty `get_output`, `turnsCompleted 0`; the session ends only by `cancel_session` or `timeout`. A `team` slot in this state holds `judge` / `run-and-judge` until its timeout; an interactive session queues every later `send_input` behind a turn that never settles.
- Prompt-injecting plugins inside the child (the magus claudish status mod) are not the trigger. They co-occur because a child that uses claudish itself is also the kind that runs background runners.
- It fails silently: no anomaly, no error, and `background` reads as legitimate waiting.

## Suggested fix (no code)

1. In the follower, read main-chain `attachment` records whose `attachment.type` is `queued_command` and whose `attachment.prompt` contains `<task-notification>`: take the `<task-id>` and complete the agent / drop the background shell exactly as `applyNotification` does. Do NOT mark the turn waking on it: the attachment rides an API request already in flight, and the assistant record that answers it follows anyway. One agent may notify several times (lines 561, 597, 609); the `agentsDone` set already counts it once. Read the attachment, not the `queue-operation` records, so a queued item that is removed without reaching the model is not counted.
2. Treat a terminal `<status>killed</status>` (TaskStop) like `completed` for balancing; the current `applyNotification` already ignores status, keep it that way.
3. Defence in depth, optional: at `turn_duration`, Claude Code own count (field absent means 0 pending) disagreeing with the claudish tally should at least record an anomaly (for example `agent_tally_mismatch`) so the next divergence is visible. Whether an absent field may override the tally is a design decision for `pane-session.md` D23; this report does not recommend it alone, because the tally exists to mirror that count, not to be replaced by it.
4. Tests: a fixture cut from this real transcript (redacted), asserting `agentsCompleted === agentsLaunched` after line 609 and `settled:true, by:"turn_duration"` after line 654; also assert the already-present attachment in `corpus-redacted/auto-compaction-in-turn.jsonl` is read. Update `pane-session.md` "Background work (D23)" and "Waking records" to name both delivery forms of a notification.

## Evidence paths

- Child transcript: `/Users/jack/.claude/projects/-Users-jack-mag-claudish--claude-worktrees-claudish-mcp-update/f2f921c4-efb3-4103-b089-c9397b667f56.jsonl` (lines 11, 497, 503-504, 516, 517, 561, 597, 609, 647, 652-654, 663, 665-673)
- Session records: `/Users/jack/.claudish/sessions/779a03f0/` (`meta.json`, `events.jsonl`, `spawn.json`, `screen.txt`, `output.log`)
- Nested failed session: `/Users/jack/.claudish/sessions/969aa273/`
- Code: `packages/cli/src/pane/transcript-follower.ts:226-228, 417, 442-447, 449-475, 494-524, 526-536`; `packages/cli/src/pane/settle-rule.ts:72-74, 92-101, 141-148, 162-178`; `packages/cli/src/pane/pane-session.ts:1171-1216`
- Fixtures with each notification form: `packages/cli/src/pane/test-fixtures/transcripts/tools-session.jsonl` (`user`, 2.1.290); `packages/cli/src/pane/test-fixtures/transcripts/corpus-redacted/auto-compaction-in-turn.jsonl` (`attachment/queued_command`, 2.1.263)
- Rationale: `ai-docs/architecture/pane-session.md`, sections "Settle" and "Background work (D23)"
- Offline replay script: `ai-docs/reports/2026-10-16-session-unsettled-replay.ts`
