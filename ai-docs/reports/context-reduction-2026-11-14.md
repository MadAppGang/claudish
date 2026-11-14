# Context reduction tools on a long Claude Code session with subagents

Measured 2026-11-14 to 2026-11-15 with madbench 0.58.2 and Claude Code 2.1.325.
Bench: `ai-docs/benches/context-reduction/`.

## Result

On this task, no tool cut tokens or cost by a margin larger than the spread
between trials. rtk was 6.7% lower on prompt tokens and 4.9% lower on
main-thread cost, inside the baseline's own range. context-mode and
Context Gateway in local mode used more: 18.6% and 33.3% more prompt tokens,
14.4% and 32.1% more main-thread cost. Every variant built the feature: 10 of
12 trials passed all 114 hidden tests, and the other two missed one test each.

No Session reached compaction. The largest single request was 122,396 tokens.
So this task measures what the tools cost and save in normal work. It does
not measure them where the context window runs out, which is where they are
meant to help most.

## The task

Claude Code on `claude-sonnet-5-5` gets claudish at `fe1a93ec`, one commit
before `--context-window` was added. The prompt asks for that feature in four
steps: two exploration subagents, the build with tests, a third subagent that
reviews the work, then the fixes and a final test run. The agent works alone,
with `--permission-mode bypassPermissions`, until it finishes.

The grade is the seven test files of the commit that added the feature: 114
tests, copied into the workspace only after the agent stopped. The untouched
checkout gives `82 pass`, `19 fail`; the real feature gives `114 pass`, `0 fail`.

## Conditions of the measurement

- **Subagents run in the foreground** in every variant
  (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`). With background subagents,
  madbench 0.58.2 ended the Session while they still ran (two smoke trials,
  27 s and 26.8 s, no file changed). The results do not say how the tools
  behave with background subagents.
- One Scenario, 3 trials per variant, run one at a time
  (`--concurrency 1`), each on the Claude Max subscription.
- Every model call in every trial went to `claude-sonnet-5-5`, main thread
  and subagents.
- The variants differ only in the composed `~/.claude` files, the staged
  plugin and the second provision step; madbench's guard reported `ALLOWED`
  for each.

| Variant | What differs |
|---|---|
| `baseline` | nothing |
| `rtk` | rtk 1.2.0 as a `PreToolUse` hook on `Bash` (`/opt/homebrew/bin/rtk hook claude`), plus the instruction files `rtk init` writes |
| `context-mode` | the context-mode plugin, tag `v2.1.10` (Elastic License 2.0, fetched at staging time, not committed) |
| `context-gateway-local` | Context Gateway v0.5.3 as a local proxy (`ANTHROPIC_BASE_URL`); tool output shortened by its built-in `trimming` strategy; no summarizer, no provider, no model call of its own |

## How the numbers were taken

madbench's token and cost metrics count the main thread only, and it has no
source for a subagent's tokens or cost (draft gap item 3). As a temporary
stand-in, `ai-docs/benches/context-reduction/summarize.ts` sums the `usage`
of every `llm_call` Event in the report JSON, split by `agent_id` into main
thread and subagents. The main-thread sums equal madbench's own figures.

"Prompt tokens" below is everything the model was sent: fresh input, cache
creation and cache read together. "Main-thread cost" is madbench's
`session.cost`; it covers the main thread only.

## Per variant: mean over 3 trials, change against the baseline

| Variant | Hidden tests passed | Prompt tokens, main thread (madbench) | Prompt tokens, subagents (Events) | Prompt tokens, all | Output tokens, all | Main-thread cost (madbench) | Requests main/sub | Duration |
|---|---|---|---|---|---|---|---|---|
| `baseline` | 3/3 | 2,805,029 | 835,231 | 3,640,260 | 48,770 | $1.51 | 36/24 | 21.4 min |
| `rtk` | 3/3 | 2,573,729 (-8.2%) | 821,813 (-1.6%) | 3,395,542 (-6.7%) | 48,396 (-0.8%) | $1.44 (-4.9%) | 33/26 | 27.8 min |
| `context-mode` | 2/3 | 3,121,309 (+11.3%) | 1,196,851 (+43.3%) | 4,318,160 (+18.6%) | 56,659 (+16.2%) | $1.73 (+14.4%) | 39/37 | 31.7 min |
| `context-gateway-local` | 2/3 | 3,521,747 (+25.6%) | 1,331,556 (+59.4%) | 4,853,302 (+33.3%) | 56,407 (+15.7%) | $2.00 (+32.1%) | 48/42 | 28.1 min |

Ranges over the 3 trials (least to most):

| Variant | Prompt tokens, all | Main-thread cost | Duration |
|---|---|---|---|
| `baseline` | 3,418,007 to 3,883,947 | $1.49 to $1.53 | 18.5 to 22.9 min |
| `rtk` | 3,090,437 to 3,678,830 | $1.30 to $1.57 | 15.5 to 41.3 min |
| `context-mode` | 4,112,256 to 4,548,856 | $1.65 to $1.78 | 25.7 to 41.6 min |
| `context-gateway-local` | 4,328,291 to 5,561,285 | $1.90 to $2.09 | 18.9 to 41.7 min |

Every trial of every variant: 3 subagents, 1 turn, 0 compactions. Cache read
made up 94% of all prompt tokens in every variant.

rtk's range overlaps the baseline's on every row, so with 3 trials its saving
is not separable from noise. context-mode and the gateway lie above the
baseline's range on prompt tokens and cost in all three trials.

## Per trial

| Trial | Variant | Hidden tests | Prompt main | Prompt sub | Output main | Output sub | Main-thread cost | Duration |
|---|---|---|---|---|---|---|---|---|
| 1 | `baseline` | 114 pass | 3,110,809 | 773,138 | 32,508 | 18,552 | $1.53 | 22.9 min |
| 1 | `rtk` | 114 pass | 2,291,038 | 799,399 | 23,425 | 19,704 | $1.30 | 15.5 min |
| 1 | `context-mode` | 113 pass, 1 fail | 3,056,590 | 1,236,777 | 34,976 | 26,762 | $1.76 | 27.8 min |
| 1 | `context-gateway-local` | 113 pass, 1 fail | 4,110,357 | 1,450,928 | 33,312 | 25,029 | $2.00 | 41.7 min |
| 2 | `baseline` | 114 pass | 2,574,246 | 843,761 | 27,656 | 17,510 | $1.49 | 18.5 min |
| 2 | `rtk` | 114 pass | 2,597,077 | 1,081,753 | 31,474 | 22,799 | $1.57 | 26.7 min |
| 2 | `context-mode` | 114 pass | 3,078,230 | 1,034,026 | 30,679 | 21,359 | $1.65 | 41.6 min |
| 2 | `context-gateway-local` | 114 pass | 3,064,309 | 1,263,982 | 32,033 | 24,218 | $1.90 | 18.9 min |
| 3 | `baseline` | 114 pass | 2,730,032 | 888,794 | 30,039 | 20,044 | $1.51 | 22.9 min |
| 3 | `rtk` | 114 pass | 2,833,071 | 584,287 | 30,609 | 17,176 | $1.43 | 41.3 min |
| 3 | `context-mode` | 114 pass | 3,229,106 | 1,319,750 | 31,940 | 24,260 | $1.78 | 25.7 min |
| 3 | `context-gateway-local` | 114 pass | 3,390,574 | 1,279,757 | 31,411 | 23,217 | $2.09 | 23.9 min |

The two failed tests:

- `context-mode`, trial 1: `lmstudio discovery with LM Link > without lms the rows stay unlabelled`
- `context-gateway-local`, trial 1: `LocalTransport with a machine suffix > a model with no suffix loads nothing and adds no payload field`

Each is one of 114 tests in one of three trials. Three trials cannot tell a
tool effect from chance here.

## What each tool did

Each tool was active in every trial. The figures are the tools' own counts,
not madbench's.

| Variant | Trial 1 | Trial 2 | Trial 3 |
|---|---|---|---|
| `rtk` (`rtk gain`) | 10.4K tokens saved (39.2%) | 15.8K (49.5%) | 12.5K (45.2%) |
| `context-mode` (Bash outputs its `PostToolUse` hook rewrote) | 11 | 14 | 14 |
| `context-gateway-local` (gateway's `session_stats.json`) | 103 requests, 57 tool outputs shortened, `tokens_saved` 525,270, 2 expand calls | 83, 46, 467,840, 5 | 95, 45, 362,194, 5 |

The agent never called one of context-mode's eight `ctx_*` tools, although
they were offered and the `SessionStart` hook told it to call `ctx_resume`.
context-mode acted only through its hooks: a rewritten output ends with a
pointer to `ctx_search`, which the agent did not follow either.

The gateway's `tokens_saved` is not a net saving. It counts a saving each time
a shortened output is sent again in the history, and it does not count what
the shortening caused. The API usage tells the other side: the gateway trials
made more requests (48/42 against 36/24) and more tool calls (144, 122 and
124 against the baseline's 98, 74 and 74), and their fresh, uncached input
rose from 120 to 13,284 tokens per trial.

## Explanations (inference, not verified)

- **Why the gateway costs more.** Shortened tool output leaves the agent
  with less to work from, so it runs more commands and asks for more
  (2 to 5 expand calls per trial). Each extra request re-sends the history.
  The rewritten history also changes the start of later prompts, which
  matches the rise in uncached input and cache creation (+20.6%).
- **Why context-mode costs more.** Its subagents made 56% more requests than
  the baseline's. A rewritten output that hides the middle of a long result
  can send the agent back for it with a narrower command.
- **Why rtk changes little.** Its savings are on the order of 10K to 16K
  tokens of command output per trial, while each trial sends about 3.4M
  prompt tokens, 94% of them cache reads of the same history.

## Not measured

- **Total cost.** madbench's cost covers the main thread only. Subagent
  tokens are reported above; no subagent cost figure exists in the report.
- **Behaviour near or past the context window.** No Session compacted; the
  largest request was 122,396 tokens.
- **Background subagents.** Every variant ran them in the foreground.
- **Context Gateway with its Haiku summarizer** (`context-gateway-haiku`).
  In its one trial, every Haiku call the gateway signed with the captured
  Claude login got `429 rate_limit_error "Error"` (329 times); the gateway
  sent every output on unchanged. This is the shape refusal recorded in
  `ai-docs/architecture/advisor.md`: the API accepts a login-signed call only
  with Claude Code's identity block. The variant is in the Experiment but not
  in the full run; whether to sign it with a metered API key is open.
- **Variance.** 3 trials per variant give a range, not a confidence
  interval. Durations vary up to 2.7 times within one variant, mostly from
  how often the agent ran the full test collection.
- **Other tasks.** One Scenario, one repository, one model.
- **Claude Code's own `/compact` and the `ctx_*` tools,** because nothing
  triggered them.

## Gaps found in madbench (draft, not filed)

The draft is in the session folder,
`ai-docs/sessions/context-reduction-bench-20261114-101500-a7c3/madbench-gaps-draft.md`
(git-ignored), and waits for a decision to file it:

1. A background subagent is closed at once, and the Session ends while it
   runs.
2. A follow-up is typed while background subagents still run.
3. madbench's metrics and cost are main thread only; there is no source for
   a subagent's tokens or cost. `summarize.ts` stands in for this item.
4. Nothing owns a process that a provision step starts; `config.dirs` files
   are absent at provision time.
5. A Harness error drops the whole Session: the first context-mode trial ended
   after 21.7 min with `OAuth token revoked · Please run /login
   (api_error_status 401)` and kept no Events and no Checks. A second trial
   ran without error.
6. `madbench check` refuses `--plain`; `--no-update-check` does not exist.

## Other facts for whoever runs this again

- rtk's hook uses the absolute path `/opt/homebrew/bin/rtk hook claude`, where
  `rtk init` writes a bare `rtk`. The composed files were taken from
  `CLAUDE_CONFIG_DIR=… rtk -v init -g --auto-patch --dry-run`, never from
  `rtk init -g` against the real home.
- context-mode needs node 24.15.0 or later; the default `PATH` here had
  v22.23.1, so every command ran with `PATH=/opt/homebrew/bin:$PATH`
  (node v26.13.1).
- Context Gateway makes one call its config cannot turn off:
  `GET https://api.github.com/repos/Compresr-ai/Context-Gateway/releases/latest`.
  It carries no workspace data. No variant uses the `compresr` strategy.
- The gateway's compression log stores the original tool output (claudish
  source) on the run's own disk, although `verbose_payloads` is false. The
  bench copies it to its git-ignored `out/` folder.
- The prompt's bare `bun test` runs claudish's whole test collection, which
  takes several minutes; this is the same for every variant.

## Reproduce

```
PATH=/opt/homebrew/bin:$PATH madbench ai-docs/benches/context-reduction/context-reduction.experiment.yaml \
  --variant baseline --variant rtk --variant context-mode --variant context-gateway-local \
  --trials 3 --concurrency 1 --report-json /absolute/path/report.json
bun ai-docs/benches/context-reduction/summarize.ts /absolute/path/report.json
```

The full run's report JSON (191 MB) is
`ai-docs/sessions/context-reduction-bench-20261114-101500-a7c3/full-4variants.json`,
in the git-ignored session folder.
