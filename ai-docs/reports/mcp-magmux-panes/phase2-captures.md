# Phase 2 captures: interactive Claude Code in a headless magmux pane

Date 2026-10-06. Claude Code **2.1.290** (the design assumed 2.1.287), magmux 0.14.0 (1900271), claudish
from this worktree (`bun packages/cli/src/index.ts`, head 68e30e53). Model: native `haiku`
(`claude-haiku-4-5-20251001`). Spend: $1.39 at API rates per Claude Code's `cost-state` (subscription-billed).

These captures are the gate for the pane design (`architecture.md` §13 phase 2): every screen
marker of §2.6 and every record shape of §2.7–2.8 is checked against a verbatim capture below.
Where a capture contradicts the design, the code in `packages/cli/src/pane/` follows the capture
and the correction is listed in §9.

Fixtures copied from these runs: `packages/cli/src/pane/test-fixtures/` (`screens/`, `transcripts/`,
`frames/`). Session scratch (harness, raw runs, every frame and snapshot):
`ai-docs/sessions/dev-feature-mcp-magmux-panes-20261002-a7c3/phase2/` (gitignored).

## 1. How the captures were taken

The harness (`phase2/cap.ts`) launches the pane the way §2.3 specifies, not the way the old
reference driver did:

- `magmux --headless --no-status --id cc2-<name>-<hex> --sock-dir /tmp/cc2/s -e ". '<ctl>/pane-launch.sh'"`,
  `COLUMNS=160 LINES=50`, detached; the launcher is `cd -- '<realpath cwd>' || exit 97` +
  `exec bun …/index.ts -i --model haiku -y --quiet --session-id <uuid> --add-dir <turnDir> [caller flags]`.
- `SHELL=<ctl>/sh-shim` (drops `-l`), set after the snapshot; the real `SHELL` travels in the snapshot.
- An **allowlisted** environment (`PATH`, `TMPDIR`, `USER`, `LOGNAME`, `LANG`, `SHELL=/bin/zsh`), a
  hermetic `HOME=/tmp/cc2/<name>/home`, `CLAUDE_CONFIG_DIR=$HOME/.claude`, `ZDOTDIR=$HOME`,
  `CLAUDISH_DISABLE_{KEYCHAIN,OP,CATALOG_WARM}=1`, `CLAUDISH_NO_PREDEFINED_ENDPOINTS=1`, a per-run
  `CLAUDISH_TOKEN_FILE` and `CLAUDISH_UPSTREAM_ERROR_LOG`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`,
  `CLAUDISH_PANE_CHILD=1`, `CLAUDISH_PANE_CWD`, and `CLAUDISH_PANE_ENV` = the JSON snapshot. No
  terminal-identity variable, no `CLAUDECODE`/`CLAUDE_CODE_*` of the driving session. The phase-1
  child code (`pane/child-env.ts`, the overlay key) therefore ran in every capture.
- `<config>/.claude.json` is seeded with `hasCompletedOnboarding` and trust for the cwd (except in
  the dialog captures). No real `~/.claude` or `~/.claudish` file was read or written.
- **Login.** A hermetic config dir is not logged in: Claude Code keys its keychain item by config
  dir (measured: `Not logged in · Please run /login` with `HOME` redirected and with
  `CLAUDE_CONFIG_DIR` set). The harness reads the subscription access token once, in memory, with
  `/usr/bin/security find-generic-password -s "Claude Code-credentials" -w` (the binary Claude Code
  itself uses, so no ACL prompt) and passes it as `CLAUDE_CODE_OAUTH_TOKEN`. It is never written to
  disk, and no fixture contains it. The banner therefore reads `Haiku 4.5 · Claude API` rather than
  `· Claude Max`.
- A persistent `watch {mode:"frames", fps:4}` connection applies frames to an in-memory screen
  (text + spans). Snapshots are that screen; frames are recorded verbatim.

Process and socket listings were appended before and after every run to `phase2/runs/ps.log`. After
the last run: no process whose argv contains `cc2`, `/tmp/cc2/s` empty, every magmux exited 0 after
`close_pane {force:true}`.

## 2. Runs

| run | config | what |
|---|---|---|
| s01-basic | hookless | boot, keylog (ctrl-j, ctrl-u, backspace, `@` menu, `/` menu, Esc), plain turn |
| s02-suggest | hookless, nonessential traffic allowed | fresh-boot placeholder, prompt-suggestion attempt |
| s03-tools / s03b-tools | hookless, `~/.claude/commands/pear.md` | long Bash, numbered prose over a running Bash, background Bash, background Agent, AskUserQuestion + Esc, Esc during Bash, plain interrupt, `/cost`, `/pear`, Read limits, the file-delivery template, `/compact` |
| s04-stophook | Stop hook `sleep 30` | end_turn, long answer, Esc during Bash, plain interrupt; screen sampled every 1 s during the hook |
| s05-maxtok-{hookless,stop-hook} | `CLAUDE_CODE_MAX_OUTPUT_TOKENS=60` | `max_tokens` |
| s06-* | boot only, no request | onboarding, trust, bypass dialogs; `.mcp.json` server dialog (unnamed); `--agent zzz-not-real` |
| s07-slowprompt | UserPromptSubmit hook `sleep 12` | box / echo / witness timeline |
| s08-plan, s08-permission, s08-bash-perm | caller `--permission-mode plan` / `default` | plan approval; `default` produces NO dialog under `-y` |
| s09-noauto-{write,bash} | caller `--no-auto-approve` | permission dialogs + Esc |
| s10-apierr-{hookless,stop-hook} | invalid OAuth token | API error |
| s11-readlimits | hookless | Read of a 40k-char and a 90k-char line; paged read of a token-capped file |
| s12-suggest-menu | nonessential traffic allowed | prompt suggestion after 3 turns; Enter on an open `@` menu |

## 3. Screens

Layout at 160×50 with `--no-status`: content from row 0 down; the input box is a full-width `─`
rule, the box row(s) starting `❯`, a second rule; two status rows under it (claudish's
`  cwd • haiku • $0.000 • N/A` and the mode line). The REPL is on the **alternate** screen
(`alt:true`); every boot dialog and the agent rejection are on the **primary** screen (`alt:false`).

**Boot, empty box** (`repl-boot-empty`, ≈0.7–2.0 s after spawn with catalog warm-up off):

```
 ▐▛███▛█   Claude Code v2.1.290
▝▜██████▀  Haiku 4.5 · Claude API
 ▝▝   ▝▝   /private/tmp/cc2/s01-basic/cwd
────────────────────────────…  (row 45)
❯                               (row 46, cursor x=2)
────────────────────────────…  (row 47)
  cwd • haiku • $0.000 • N/A
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents
```

The box prompt is `❯` followed by U+00A0 NO-BREAK SPACE; echo rows of earlier prompts above the box
(`❯ Reply with …`) use a plain space.

**Placeholder** (`repl-boot-placeholder`, only with nonessential traffic allowed):
`❯ Try "how does <filepath> work?"` with span `[2,31,-1,-1,2]`: the placeholder cells carry
**attr 2 (faint)**. Typed text (`❯ alpha`) has no span at all; the cursor cell carries attr 16
(inverse). magmux documents only bit 1 (bold) but passes faint and inverse through.

**Prompt suggestion:** not shown in 2 sessions (s02: 1 turn, s12: 3 turns, nonessential traffic
allowed). With the production default `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` it is not expected
at all. Skipped; the faint-cell rule covers any ghost text the same way.

**Keylog** (s01): ctrl-j inserts a line in the box (`❯ alpha` / `  beta`, both above the bottom rule);
typing shows `ctrl+g to edit in VS Code` right-aligned on the row above the top rule; ctrl-u clears and
shows `Ctrl+Y to paste deleted text` there. A trailing `@` opens a menu ABOVE the top rule
(`    * claude (agent) – …`, `    + notes.md`); a leading `/` opens
`  ❯ /add-dir                    Add a new working directory`. Esc closes either menu and keeps the
text. **Enter on an open `@` menu submits the text unchanged** (s12: the witness was `look at @not`).
Enter on `/pear` with the menu open ran `/pear`.

**Working rows.** No `esc to interrupt` text exists anywhere in 2.1.290. The working row is a glyph,
a word with `…`, and an optional parenthesis:

```
✶ Simmering… (3s · ↓ 154 tokens · thought for 1s)
✽ Propagating…
· Processing… (running Stop hook · 2s · ↓ 105 tokens · thinking)
✶ Blanching… (running UserPromptSubmit hook · 2s)
```

The finished row has no `…`: `✻ Cogitated for 1s · done 12:06 PM`. A background-agent wait is
`✻ Waiting for 1 background agent to finish`. A tip row may follow: `  ⎿  Tip: …`.

**Tools on screen.** `⏺ Write(hello.txt)` and `⏺ Agent(fruit)` keep the `Name(` form; Bash does not:
`⏺ Running sleep and echo command` / `  ⎿  $ sleep 12; echo LONGDONE` while running, collapsed to
`  Ran 1 shell command` afterwards; Read collapses to `  Read 1 file`. Background:
`⏺ Agent "fruit" finished · 1s`, `⏺ Background command "Background sleep and echo" completed (exit code 0)`.

**R3-H1 negative** (`numbered-prose-bash-running`): numbered prose with a `No…` and an `(esc)` row,
while a Bash runs, with the input box visible:

```
⏺ 1. Yes, it ran
  2. No, and tell Claude what to do differently (esc)
  3. Maybe later
  Sleeping for 12 seconds · 4s
  ⎿  $ sleep 12 (5s)
     (ctrl+b to run in background)
✢ Undulating… (6s · ↓ 165 tokens)
```

**AskUserQuestion** (`ask-user-question`); the input box is gone:

```
 ☐ Fruit
Which fruit do you prefer?
❯ 1. Apple
     A crisp, round fruit
  2. Pear
     A sweet, bell-shaped fruit
  3. Type something.
────…
  4. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel
```

Esc → `⏺ User declined to answer questions` / `  ⎿  · Which fruit do you prefer? (Apple / Pear)`.

**Permission** (`permission-write`, `permission-bash`; caller `--no-auto-approve`):

```
 Do you want to create hello.txt?          | Do you want to proceed?
 ❯ 1. Yes                                  | ❯ 1. Yes
   2. Yes, and switch to accept edits …    |   2. Yes, and always allow access to … from this project
   3. No                                   |   3. No
 Esc to cancel · Tab to amend              | Esc to cancel · Tab to amend
```

There is no `No, and tell Claude what to do differently (esc)` row. Esc on the Write dialog →
`  ⎿  User rejected write to hello.txt`; on Bash → `  ⎿  Interrupted · What should Claude do instead?`.
A caller `--permission-mode default` does **not** override `-y` (s08-permission, s08-bash-perm:
no dialog, the tool ran); `--no-auto-approve` does.

**Plan approval** (`plan-approval`, caller `--permission-mode plan`):

```
   Ready to code?
   Here is Claude's plan:
   …
   Claude has written up a plan and is ready to execute. Would you like to proceed?
   ❯ 1. Yes, and switch to BYPASS PERMISSIONS (no further prompts) for this session
     2. Yes, manually approve edits
     3. Tell Claude what to change
        shift+tab to approve with this feedback
   ctrl+g to edit in VS Code · ~/.claude/plans/tender-swimming-creek.md
```

No `No` row and no `(esc)` row.

**Stop hook running** (`stop-hook-running`): `· Processing… (running Stop hook · 2s · ↓ 105 tokens · thinking)`
on the row above the box, rewritten **every second** (30 above-box changes in 30 s), so no quiet
window can elapse while a Stop hook runs.

**UserPromptSubmit hook running** (`prompt-hook-running`): the box is empty 160 ms after Enter, the
echo `❯ Reply with exactly FIG and nothing else.` and `✶ Blanching… (running UserPromptSubmit hook · 2s)`
are drawn, and the transcript gets the user record only when the hook returns: **12,501 ms** after
the send.

**API error** (`api-error`): `⏺ Please run /login · API Error: 401 OAuth access token is invalid.` —
a `⏺` row, not a `⎿  API Error` row.

**Interrupts**: `  ⎿  Interrupted · What should Claude do instead?` under the cut answer or tool.

**`/cost`** (`usage-panel`): opens the full-screen `Settings  Status   Config   Usage   Stats` panel
(`/usage (cost)` in the menu) with `Esc to cancel`, no input box, and writes **no transcript record**.
Input typed while it is open is swallowed until Esc.

**Boot dialogs** (primary screen, below claudish's three-line stats notice on a fresh claudish config):

```
 Let's get started.
 Choose the text style that looks best with your terminal       (onboarding)
 ❯ ✔ Dark mode

 Quick safety check: Is this a project you created or one you trust? (Like your own code, …   (trust)
 ❯ No, exit
   Yes, I trust this folder
 Enter to confirm · Esc to cancel

  WARNING: Claude Code running in Bypass Permissions mode         (bypass: overlay without the pane marker)
  ❯ No, exit
    Yes, I accept
  Enter to confirm · Esc to cancel

  New MCP server found in this project: demo                      (unnamed: .mcp.json)
    Use this MCP server
    Use this and all future MCP servers in this project
  ❯ Continue without using this MCP server
  Enter to confirm · Esc to cancel
```

None of them has numbered options. The API-key dialog (`Detected a custom API key in your environment`)
needs a foreign route with `ANTHROPIC_API_KEY` set and was not recaptured; its verbatim 2.1.287 text is
`research-scratch/run-empty-config5-claudish-foreign.txt`.

**Agent rejection** (`agent-rejected`, primary screen):
`--agent 'zzz-not-real' not found. Available agents: claude, claude-code-guide, Explore, general-purpose, Plan, statusline-setup`.
magmux's `exit` event: `{"duration":"319ms","exitCode":1,"lastLine":"--agent 'zzz-not-real' not found. Avail…"}` —
**`lastLine` is truncated** with `…`.

## 4. Records

Common: a witness is `{"type":"user","message":{"content":"<typed line>"},"origin":{"kind":"human"}}`,
written 370–470 ms after a typed send. Between the last assistant record and `turn_duration` Claude
Code writes `attachment/prompt_snapshot` (and state records `last-prompt`, `mode`, `permission-mode`,
`atis-latch` around it). `turn_duration` carries `durationMs`, `messageCount`, `isMeta:false`, sometimes
`slug`, and `pendingBackgroundAgentCount` **only when it is > 0**. Each assistant content block is its own
line; all lines of one `message.id` repeat the same usage.

### 4.1 Ending matrix

| ending | hookless | Stop hook `sleep 30` |
|---|---|---|
| `end_turn` | assistant → `att/prompt_snapshot` → `turn_duration` (no `stop_hook_summary`) | assistant → … → `stop_hook_summary` **30,077 ms later** `{"hookCount":1,"hookInfos":[{"command":"sleep 30","durationMs":30011}],…}` → `turn_duration` |
| API error (401) | `isApiErrorMessage`, `model:"<synthetic>"`, `stop_reason:"stop_sequence"`, `error:"authentication_failed"`, `apiErrorStatus:401` → `turn_duration` | same; **no `stop_hook_summary`** |
| `max_tokens` (cap 60) | 4 × (assistant `sr=max_tokens` → **`isMeta` user** `Output token limit hit. Resume directly — …`) then synthetic API error `error:"max_output_tokens"`, `apiErrorStatus` absent, text `API Error: Claude's response exceeded the 60 output token maximum. …` → `turn_duration` | same; no `stop_hook_summary` |
| Esc during a running Bash | `tool_result` `is_error` (`toolUseResult:"User rejected tool use"`) → user text block `[Request interrupted by user for tool use]`; **no `turn_duration`** | same; no summary, no `turn_duration` |
| Esc on a dialog (AskUserQuestion, permission, plan) | the same two records **then `turn_duration`** | (not run) |
| plain interrupt while streaming | assistant `sr=null` (thinking + partial text) → `[Request interrupted by user]`; no `turn_duration` | same |
| `refusal` | not elicitable on native haiku; corpus record (below) | corpus record |

**Refusal** (documented skip, redacted corpus fixture `transcripts/corpus-redacted/refusal-then-fallback.jsonl`,
2.1.282, one message, the only refusal in 3,001 files): assistant lines `stop_reason:"refusal"` with
`stop_details:{type:"refusal",category,explanation}`; its `tool_use` gets `tool_result is_error`
`Not run: the response that made this tool call was stopped by a safety classifier.`
(`toolDenialKind:"cancelled"`), then `system/informational`
`Opus 5.5's safeguards stopped the response above · continuing once with that noted`, then an
**`isMeta` user record** (`turnCompanion:true`), then the model **continues** on a fallback model
(`system/model_refusal_fallback`). No `turn_duration` and no `stop_hook_summary` follow the refusal itself.

### 4.2 Background work

- **Background Bash**: `tool_use` input `run_in_background:true`; `toolUseResult.backgroundTaskId`;
  `turn_duration` with no pending count; 9 s later `queue-operation` enqueue/dequeue and a user record
  `<task-notification>…` with `origin:{kind:"task-notification",producer:"session-task"}` wakes the
  model → assistant → a second `turn_duration`.
- **Background Agent**: haiku called `Agent` with `{description, prompt, subagent_type, isolation:"remote"}`
  and **no `run_in_background`**, yet the launch was asynchronous: `toolUseResult:{isAsync:true,
  status:"async_launched", agentId:"a6d024f5474e98666", …}`. `turn_duration` then carried
  `pendingBackgroundAgentCount:1`; the `<task-notification>` (whose `<task-id>` is the agentId) followed,
  then the answer and a `turn_duration` without the count. Subagent records:
  `<uuid>/subagents/agent-<agentId>.jsonl` + `.meta.json`.

### 4.3 Commands and compaction

- `/pear` (user command): one user record
  `<command-message>pear</command-message>\n<command-name>/pear</command-name>`, then a normal turn.
- `/compact`: `system/compact_boundary` (`compactMetadata.trigger:"manual"`, `preTokens`, `postTokens`),
  user `isCompactSummary:true`, user `isMeta` `<local-command-caveat>…`, user
  `<command-name>/compact</command-name>…` (file order AFTER the boundary although its timestamp is
  earlier), user `<local-command-stdout>…Compacted…</local-command-stdout>`. No `turn_duration`.
- `/cost`: no record at all (§3).
- Automatic compaction inside a turn: 33 in the corpus; one redacted turn (human prompt → 5 assistant
  messages → boundary → 52 assistant messages → `turn_duration`) is
  `transcripts/corpus-redacted/auto-compaction-in-turn.jsonl`.

### 4.4 Read on 2.1.290

`toolUseResult = {type:"text", file:{filePath, content, numLines, startLine, totalLines[, truncatedByTokenCap]}}`;
the `tool_result` text is `N\t<line>` per line, no padding.

| input | result |
|---|---|
| 4-line file with a 6,099-char line | returned whole (line length 6,101 with the `2\t` prefix) |
| a 40,000-char line / a 90,005-char line | returned whole: **no per-line truncation** |
| 2,600 lines, 25 KB | all 2,601 lines (no 2,000-line cap); the trailing empty line after the last `\n` is a numbered line |
| 1,800 lines, 51,023 tokens, no limit | lines 1–750, `truncatedByTokenCap:true`, plus `attachment/read_truncation_notice` `[Truncated: PARTIAL view — … showing lines 1-750 of 1801 total (51023 tokens, cap 25000). …]`; the model replied `READ` anyway |
| same, `limit:2000` | `is_error:true` `File content (51023 tokens) exceeds maximum allowed tokens (25000). …` |
| `offset:0, limit:500` | `startLine:0`, rendering numbered **from 0** (`0\t1 lorem…`): the content is file lines 1–500 |
| `offset:500, limit:500` | `startLine:500`, `500\t500 lorem…` (file line 500) |
| `alpha\r\nbeta\r\ngamma\r\n` | content `alpha\nbeta\ngamma\n`: **CR stripped**, tab kept |
| any of the above (largest result 87.5 KB) | inline; **no `tool-results/` spill file** |

The file-delivery template (`Your task is in the file \`/tmp/cc2/launch-XW9UoC/turn-1.md\`. Read all of
it …`) was typed, witnessed verbatim, Read once and answered `KIWI\n5`.

## 5. `secondaryQuietMs`

Corpus: 3,001 main transcripts under `~/.claude/projects` (read-only, `phase2/corpus.ts`). Of 8,497
`stop_hook_summary` records, 5,285 are followed by `turn_duration`, 2,125 by an assistant record
(1,944 of those after an `end_turn`), 230 by a user record. The gap `stop_hook_summary` → next
main-chain assistant record after an `end_turn`: p50 2,122 ms, p90 3,545, p95 4,918, **p99 15,832**,
max 810,544 (a background notification). `secondaryQuietMs = max(15 000, 2 × 15 832) = 31 664` →
**32,000 ms**.

## 6. Timings

- Spawn → REPL box: 0.67–1.97 s (catalog warm-up disabled, `--quiet`); the research's 11 s included
  claudish's 4–7 s catalog warm-up and the logo.
- Typed send → witness: 370–470 ms. Plain turn send → `turn_duration`: 1.5–2.2 s.
- Permission/plan dialog visible 2.4–10 s after the witness.
- `--agent` rejection: pane exit 319 ms after the child started.

## 7. Gate: markers (§2.6)

| marker | capture | verdict |
|---|---|---|
| REPL box (rule ≥20 `─` / `❯` row / rule) | every REPL screen | holds; the box can span several rows (ctrl-j), menus sit above the top rule |
| dialog `Choose the text style` | `dialog-onboarding` | holds |
| dialog `Is this a project you created or one you trust` | `dialog-trust` | holds |
| dialog `running in Bypass Permissions mode` | `dialog-bypass` | holds |
| dialog `Detected a custom API key in your environment` | research text (2.1.287) | not recaptured (skip, §3) |
| unnamed choice = numbered row + Yes/No | `dialog-unnamed-mcp-server` | **corrected**: 2.1.290 dialogs are unnumbered; `Enter to confirm · Esc to cancel` footer added |
| permission `Do you want to proceed?` / `…create…` + `No, and tell Claude …(esc)` | `permission-*` | **corrected**: the No row is `3. No`; footer `Esc to cancel` |
| plan `Would you like to proceed?` + `1. Yes,` | `plan-approval` | holds; there is no No/(esc) row |
| AskUserQuestion `Type something` / `Other` | `ask-user-question` | **corrected**: `Type something.` + footer `Enter to select · ↑/↓ to navigate · Esc to cancel`; no `Other` |
| `isWorking` = `esc to interrupt` | every working screen | **corrected**: text absent in 2.1.290; the `<glyph> <Word>… (…)` row |
| `Transcript saving is off` | research text | not recaptured (F4 removes its cause) |
| error rows `⎿  API Error…` | `api-error` | **corrected**: `⏺ … API Error: …` / `⏺ Please run /login …` |
| `screenAnswer` excludes `⏺ Name(` | `long-bash-running`, `background-agent-wait` | **extended**: Bash description rows, `Agent "…" finished`, `Background command …`, collapsed `Ran …`/`Read …` rows |
| `agentRejectedLine` on `exit.lastLine` | `agent-rejected` | **corrected**: lastLine is truncated; match `--agent '…' not found.` and read the full line from the screen |
| placeholder = dim/faint | `repl-boot-placeholder` | holds: attr bit 2 |

## 8. Gate: record shapes (§2.7–2.8)

| shape | capture | verdict |
|---|---|---|
| text witness | every turn | holds (`origin.kind:"human"` also present) |
| command witness `<command-name>/x</command-name>` | `/pear`, `/compact` | holds as a substring (tag order varies) |
| local command settles on `<local-command-stdout>` | `/compact` yes, `/cost` no record | **corrected**: a panel command writes nothing |
| usage once per `message.id` | all | holds |
| `turn_duration` after Stop hooks | s04 | holds |
| `provenHookless` = `end_turn` "directly followed" by `turn_duration` | s01 | **corrected**: `prompt_snapshot` and state records sit between; "no `stop_hook_summary` between" is the rule |
| `pendingBackgroundAgentCount` | s03 | holds; absent means 0 |
| background agents counted by `run_in_background` | s03 | **corrected**: count `toolUseResult.isAsync === true` launches; complete on the notification whose `<task-id>` is the `agentId` |
| background Bash not awaited, notification re-wakes | s03 | holds |
| interrupt, both forms; `turn_duration` optional | s03, s04, s08, s09 | holds (dialog declines write it, a running-tool Esc does not) |
| Stop hooks do not run after an API error | s10 | holds |
| `max_tokens` settles with the truncation note | s05 | **corrected**: Claude Code auto-continues (isMeta user record) and ends with a `max_output_tokens` API error → FAILED `api_error` |
| `refusal` → EMPTY `refused` | corpus | **corrected**: an isMeta companion record continues the turn; isMeta user records are waking records |
| compaction keeps one answer | s03 + corpus | holds |
| Read numbered rendering, `READ_LINE_LIMIT`, per-call cap | s03b, s11 | **corrected**: no line limit, no line cap; a 25,000-token cap; `offset:0` numbers from 0; CR stripped |
| large results spill to `tool-results/` | s03b, s11 | no spill observed up to 87.5 KB |
| slow UserPromptSubmit hook: box clears before the witness | s07 | holds (12.5 s) |

## 9. Design corrections applied in code

Each is recorded as an `[impl-2]` note in the session's `architecture.md`.

1. `hasChoiceDialog` (R3-H1): closed list of named dialogs — permission (`Do you want to proceed?`,
   `Do you want to create …?`, `Do you want to make this edit to …?`, `Do you want to overwrite …?`),
   plan approval (`Would you like to proceed?`), AskUserQuestion (`Enter to select · ↑/↓ to navigate`);
   each needs a numbered `1.` option row below the last `⏺` block and no input box. No `No`/`(esc)`
   row is required (none exists in 2.1.290).
2. Unnamed boot choice: also `Enter to confirm · Esc to cancel` or `Enter to select`.
3. `isWorking`: the spinner-row pattern; `running Stop hook` is exposed as `stopHookRunning`.
4. `screenErrorRows`: `⏺` rows with `API Error` or the login/quota texts.
5. `agentRejectedLine`: tolerates the truncated `lastLine`.
6. Placeholder: faint = `attr & 2`.
7. Follower: `provenHookless` ignores non-chat records; background agents are counted from
   `toolUseResult.isAsync`; `isMeta` user records after the last assistant message wake the model
   (max_tokens continuation, refusal companion).
8. Read coverage: effective first line `max(1, startLine)`; returned text compared line by line with
   the file (CR stripped on both sides); a file's line count includes the empty line after a final
   newline, exactly as Read numbers it.
9. `READ_LINE_LIMIT = 20 000` characters: not a Read limit (none exists) but a page budget — one line
   must fit a 25,000-token page with room for its neighbours.
10. Settle path S's Stop-hook gate also opens for `stop_reason:"refusal"` (Stop hooks did not run
    after the corpus refusal), in case a refusal ever ends a turn.
11. `secondaryQuietMs = 32 000`.

## 10. Notes for Phase 3 (not changed here)

- A caller `--permission-mode default` is not a way to get AWAITING_PERMISSION; `--no-auto-approve`
  is, and it is not reserved.
- A delivered slash command that opens a panel (`/cost`, `/usage`, `/config`, `/status`, …) writes no
  record and swallows input until Esc. The admission bound will fail it; the pump should press Esc
  when the screen shows a panel (`Esc to cancel`, no input box) so the session is usable again.
- claudish prints a three-line stats notice on a fresh claudish config even with `--quiet` (primary
  screen, before Claude Code takes the alt screen).
- In plan mode Claude Code switched the model to `claude-sonnet-5-5` (s08-plan).
- A native route wrote **no** `CLAUDISH_TOKEN_FILE` at all in any capture (not even the initialised
  zeros research §2.5 saw), so native accounting is transcript-only.
- The real-capture token-file fixtures (`test-fixtures/token-files/`) are a served foreign session
  (`provider_name:"X-ai"`, `billed_input_tokens` 221,807 vs `input_tokens` 39,594) and the initialised
  zeros, both copied from `~/.claudish/tokens-*.json` (counts only, no content).
