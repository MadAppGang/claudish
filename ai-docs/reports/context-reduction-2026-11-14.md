# Context reduction tools on a long Claude Code session with subagents

Measured 2026-11-14 to 2026-11-15 with madbench 0.58.2 and Claude Code 2.1.325.
Bench: `ai-docs/benches/context-reduction/`.

## Result

On this task, no tool cut tokens or cost by a margin larger than the spread
between trials.

- **rtk** was 6.7% lower on prompt tokens and 4.9% lower on main-thread cost
  natively, and 1.5% and 2.0% lower through claudish. Both are inside the
  baseline's own range.
- **context-mode** used more: 18.6% more prompt tokens and 14.4% more
  main-thread cost natively, 16.2% and 13.7% more through claudish.
- **Context Gateway in local mode** used more natively: 33.3% more prompt
  tokens and 32.1% more main-thread cost. Through claudish v0.5.3 could not
  complete: 4 of 4 trials errored at the gateway's `expand_context` append
  (Compresr-ai/Context-Gateway#48). With v0.5.3 locally patched for #48, all
  3 claudish trials passed all 114 tests, with 34.1% more prompt tokens and
  26.8% more main-thread cost than `claudish-baseline`.
- **A Haiku subagent** (`output-digest` on `claude-haiku-5-5`) moved work off
  the main thread: main-thread prompt tokens fell 15.8%, subagent prompt
  tokens rose 48.7%, and the total was 1.0% lower. Main-thread cost was 7.2%
  higher, and output tokens 25.0% higher.
- **Context Gateway with Haiku on an API key** (compression and history
  summary by `claude-haiku-5-5`): 2 of 3 trials errored with the same
  malformed stream. The one graded trial passed all 114 tests and used 45.6%
  more prompt tokens and 35.1% more main-thread cost than the baseline mean,
  plus 53 Haiku calls on the key.
- **claudish's own compaction** (build 04cbb471 with known defects, Haiku on
  an API key) was 9.4% lower on prompt tokens and 8.2% lower on main-thread
  cost than `claudish-baseline`, inside the baseline's range. It compressed 1
  to 3 Bash outputs per trial, with 1 to 3 Haiku calls, and broke the cache 0
  times: the stored text replayed byte for byte.

Every variant that completed built the feature: 27 of 31 graded trials passed
all 114 hidden tests, and the other four missed one test each. The
compaction trial with the wrong flag is not counted.

No Session reached compaction. The largest single request was 122,396 tokens.
So this task measures what the tools cost and save in normal work. It does
not measure them where the context window runs out, which is where they are
meant to help most.

## Cache reuse

Most prompt tokens in every variant are cache reads of the same history, and
a cache read costs a tenth of an uncached token. So a tool saves money only
if it keeps the cached prefix intact, and it loses money when it rewrites
something early in the prompt. Computed by `summarize.ts` from the `llm_call`
usage in the report JSON files, over the same graded trials as the tables
below; errored trials are in no row.

Definitions:

- **Hit rate** = cache read / (cache read + cache creation + uncached input),
  in tokens, per thread kind and over all threads.
- **Billed-equivalent input** = uncached input + 1.25 × cache creation + 0.1 ×
  cache read. These are the list multipliers for 5-minute cache writes, not a
  measured price.
- **Thread**: one `agent_id` of the `llm_call` Events. The main thread has no
  `agent_id`; each subagent has its own. Requests are ordered by the Event's
  `seq`. This mapping is an assumption about madbench's Events, not checked
  against Claude Code's transcripts.
- **Cache break**: a request whose cache read is smaller than the previous
  request's cache read + cache creation in the same thread, so the cached
  prefix was not reused. **Tokens lost** is that shortfall, summed. The first
  request of a thread is never a break.

Native, mean over 3 trials (`context-gateway-haiku-key`: 1 graded trial):

| Variant | Hit rate main / sub / all | Cache read | Cache creation | Uncached input | Billed-equivalent input | Breaks main/sub per trial | Tokens lost per trial |
|---|---|---|---|---|---|---|---|
| `baseline` | 96.8% / 84.3% / 94.0% | 3,421,279 | 218,861 | 120 | 615,824 | 0/0 | 0 |
| `rtk` | 96.9% / 83.7% / 93.9% | 3,189,441 | 205,982 | 119 | 576,541 (-6.4%) | 0/0 | 0 |
| `context-mode` | 96.6% / 88.8% / 94.5% | 4,080,114 | 237,896 | 149 | 705,531 (+14.6%) | 0/0 | 0 |
| `context-gateway-local` | 95.9% / 89.8% / 94.2% | 4,576,035 | 263,984 | 13,284 | 800,867 (+30.0%) | 1.0/1.0 | 46,859 |
| `haiku-subagent` | 96.3% / 83.4% / 92.3% | 3,332,716 | 271,266 | 143 | 672,496 (+9.2%) | 0/1.0 | 6,126 |
| `context-gateway-haiku-key` | 97.0% / 92.7% / 95.7% | 5,070,602 | 189,947 | 38,190 | 782,684 (+27.1%) | 5/2 | 39,357 |

Through claudish, mean over 3 trials:

| Variant | Hit rate main / sub / all | Cache read | Cache creation | Uncached input | Billed-equivalent input | Breaks main/sub per trial | Tokens lost per trial |
|---|---|---|---|---|---|---|---|
| `claudish-baseline` | 97.2% / 85.9% / 94.2% | 3,598,940 | 220,944 | 130 | 636,204 | 0/0 | 0 |
| `claudish-rtk` | 97.1% / 81.9% / 94.4% | 3,554,089 | 210,203 | 122 | 618,285 (-2.8%) | 0/0 | 0 |
| `claudish-context-mode` | 96.7% / 90.1% / 94.4% | 4,197,764 | 242,079 | 157 | 722,532 (+13.6%) | 0/0 | 0 |
| `claudish-context-gateway-local-streamfix` | 96.2% / 88.8% / 94.1% | 4,823,787 | 269,314 | 28,261 | 847,282 (+33.2%) | 1.7/2.0 | 82,489 |
| `claudish-compaction`, build 04cbb471 with known defects | 97.1% / 81.4% / 94.3% | 3,265,116 | 195,703 | 117 | 571,257 (-10.2%) | 0/0 | 0 |

What the tables show:

- **No break in 18 trials** of `baseline`, `rtk` and `context-mode`, native
  and through claudish, nor in the 3 trials of `claudish-compaction`, whose
  compressed outputs are sent as the same stored text every time. rtk and context-mode change tool output before the
  agent sees it, so the history they produce stays fixed once sent. Their
  cost differences come from how much the agent sends, not from the cache.
- **The gateways break the cache 1 to 7 times per trial** and send 111 to 318
  times more uncached input than their baseline. Each break writes the lost prefix again at 1.25×
  instead of reading it at 0.1×. Computed with the list multipliers, the breaks
  account for 29% of `context-gateway-local`'s extra billed-equivalent input
  (46,859 × 1.15 = 53,888 of 185,043) and 45% of the patched gateway's
  (82,489 × 1.15 = 94,862 of 211,078). The rest is its extra requests: 90 and
  93 per trial against 60 and 65.
- **`haiku-subagent`'s one break per trial comes after a pause of more than 300
  seconds** in a subagent thread. That fits cache expiry while the thread
  waited, not a rewrite (inferred).
- **Hit rate alone hides the breaks**: every variant reads 92% to 96% from
  the cache, because a break loses tens of thousands of tokens out of
  millions.

Where the breaks fall, `claudish-context-gateway-local-streamfix` trial 1
(request = position in its thread; the tool_use is the last tool result in
that thread before the request):

| Thread | Request | Tokens lost | Cache creation | Seconds since the previous request | Last tool_use before it |
|---|---|---|---|---|---|
| main | 2 | 8,908 | 14,766 | 65 | none |
| main | 39 | 59,914 | 59,255 | 129 | `toolu_012hRQACFgswU4AToLPzTfmA` |
| subagent `a75ce4ee206a8aadc` | 3 | 7,686 | 9,867 | 3 | `toolu_01UZvJYS4RFV29G3w1G3iqMA` |
| subagent `a9ff22e2f1afbc8d6` | 2 | 26,253 | 28,303 | 3 | `toolu_014Y6MQnGCB7kaN7ZC9KZPPs` |

The native `context-gateway-local` trial 1 has one break, at main request 2
(34,068 tokens lost). Main request 2 breaks in both: the gateway changes the
first request's content once it has seen it (inferred).

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
- One Scenario, 3 graded trials per variant, run one at a time
  (`--concurrency 1`), each on the Claude Max subscription.
- Every model call went to `claude-sonnet-5-5`, main thread and subagents,
  except the `output-digest` subagent of `haiku-subagent`, which ran on
  `claude-haiku-5-5` in every call (see that variant's section).
- The variants differ only in the composed `~/.claude` files, the staged
  plugin and the provision step that starts the variant's tool; madbench's
  guard reported `ALLOWED` for each.
- A graded `VariantCheck` proves a variant's tool ran as configured where the
  tool ships a check: every `output-digest` call on `claude-haiku-5-5`, and for
  the gateway key variant, the main thread on the subscription.

| Variant | What differs |
|---|---|
| `baseline` | nothing |
| `rtk` | rtk 1.2.0 as a `PreToolUse` hook on `Bash` (`/opt/homebrew/bin/rtk hook claude`), plus the instruction files `rtk init` writes |
| `context-mode` | the context-mode plugin, tag `v2.1.10` (Elastic License 2.0, fetched at staging time, not committed) |
| `context-gateway-local` | Context Gateway v0.5.3 as a local proxy (`ANTHROPIC_BASE_URL`); tool output shortened by its built-in `trimming` strategy; no summarizer, no provider, no model call of its own |
| `haiku-subagent` | a Claude Code subagent, `output-digest` (`model: claude-haiku-5-5`, tools Bash, Read, Grep, Glob, read-only), and a `CLAUDE.md` that tells the main agent to hand large output to it |
| `context-gateway-haiku-key` | Context Gateway with tool output compression and history summarization on `claude-haiku-5-5`, signed with an Anthropic API key; Claude Code's own requests stay on the subscription |
| `claudish-*` | the same as the native variant of the same name, with claudish between Claude Code and the API; see "Through claudish" |

## How the numbers were taken

madbench's token and cost metrics count the main thread only, and it has no
source for a subagent's tokens or cost (madbench #212). As a temporary
stand-in, `ai-docs/benches/context-reduction/summarize.ts` sums the `usage`
of every `llm_call` Event in the report JSON, split by `agent_id` into main
thread and subagents and by model. The main-thread sums equal madbench's own
figures. A trial that errored before it was graded is listed apart and
counted in no mean.

"Prompt tokens" below is everything the model was sent: fresh input, cache
creation and cache read together. "Main-thread cost" is madbench's
`session.cost`; it covers the main thread only.

## Per variant: mean over 3 trials, change against the baseline

| Variant | Hidden tests passed | Prompt tokens, main thread (madbench) | Prompt tokens, subagents (Events) | Prompt tokens, all | Output tokens, all | Main-thread cost (madbench) | Requests main/sub | Duration |
|---|---|---|---|---|---|---|---|---|
| `baseline` | 3/3 | 2,805,029 | 835,231 | 3,640,260 | 48,770 | $1.51 | 36/24 | 21.4 min |
| `rtk` | 3/3 | 2,573,729 (-8.2%) | 821,813 (-1.6%) | 3,395,542 (-6.7%) | 48,396 (-0.8%) | $1.44 (-4.9%) | 33/26 | 27.8 min |
| `context-mode` | 2/3 | 3,121,309 (+11.3%) | 1,196,851 (+43.3%) | 4,318,160 (+18.6%) | 56,659 (+16.2%) | $1.73 (+14.4%) | 39/37 | 31.7 min |
| `context-gateway-local` | 2/3 | 3,521,747 (+25.6%) | 1,331,556 (+59.4%) | 4,853,302 (+33.3%) | 56,407 (+15.7%) | $1.99 (+32.1%) | 48/42 | 28.1 min |
| `haiku-subagent` | 3/3 | 2,362,193 (-15.8%) | 1,241,932 (+48.7%) | 3,604,125 (-1.0%) | 60,963 (+25.0%) | $1.62 (+7.2%) | 31/41 | 22.4 min |
| `context-gateway-haiku-key`, 1 graded trial of 3 | 1/1 | 3,684,453 (+31.4%) | 1,614,286 (+93.3%) | 5,298,739 (+45.6%) | 53,934 (+10.6%) | $2.04 (+35.1%) | 56/49 | 29.9 min |

The `context-gateway-haiku-key` row is one trial, not a mean: the other two
errored. Its tokens and cost leave out the gateway's own Haiku calls; see
that variant's section.

Ranges over the 3 trials (least to most):

| Variant | Prompt tokens, all | Main-thread cost | Duration |
|---|---|---|---|
| `baseline` | 3,418,007 to 3,883,947 | $1.49 to $1.53 | 18.5 to 22.9 min |
| `rtk` | 3,090,437 to 3,678,830 | $1.30 to $1.57 | 15.5 to 41.3 min |
| `context-mode` | 4,112,256 to 4,548,856 | $1.65 to $1.78 | 25.7 to 41.6 min |
| `context-gateway-local` | 4,328,291 to 5,561,285 | $1.90 to $2.09 | 18.9 to 41.7 min |
| `haiku-subagent` | 2,763,716 to 4,644,575 | $1.35 to $1.97 | 21.3 to 23.5 min |

Every trial: 1 turn, 0 compactions. Every trial of the first four variants
started 3 subagents; `haiku-subagent` started 4, 4 and 8. Cache read made up
92% to 94% of all prompt tokens in every variant.

rtk's range overlaps the baseline's on every row, so with 3 trials its saving
is not separable from noise. context-mode and the gateway lie above the
baseline's range on prompt tokens and cost in all three trials.
`haiku-subagent`'s range contains the baseline's on prompt tokens and cost.

## Per trial

| Trial | Variant | Hidden tests | Prompt main | Prompt sub | Output main | Output sub | Main-thread cost | Duration |
|---|---|---|---|---|---|---|---|---|
| 1 | `baseline` | 114 pass | 3,110,809 | 773,138 | 32,508 | 18,552 | $1.53 | 22.9 min |
| 1 | `rtk` | 114 pass | 2,291,038 | 799,399 | 23,425 | 19,704 | $1.30 | 15.5 min |
| 1 | `context-mode` | 113 pass, 1 fail | 3,056,590 | 1,236,777 | 34,976 | 26,762 | $1.76 | 27.8 min |
| 1 | `context-gateway-local` | 113 pass, 1 fail | 4,110,357 | 1,450,928 | 33,312 | 25,029 | $2.00 | 41.7 min |
| 1 | `haiku-subagent` | 114 pass | 2,800,614 | 1,843,961 | 31,841 | 34,485 | $1.97 | 21.3 min |
| 2 | `baseline` | 114 pass | 2,574,246 | 843,761 | 27,656 | 17,510 | $1.49 | 18.5 min |
| 2 | `rtk` | 114 pass | 2,597,077 | 1,081,753 | 31,474 | 22,799 | $1.57 | 26.7 min |
| 2 | `context-mode` | 114 pass | 3,078,230 | 1,034,026 | 30,679 | 21,359 | $1.65 | 41.6 min |
| 2 | `context-gateway-local` | 114 pass | 3,064,309 | 1,263,982 | 32,033 | 24,218 | $1.90 | 18.9 min |
| 2 | `haiku-subagent` | 114 pass | 2,699,843 | 704,240 | 32,821 | 23,638 | $1.53 | 22.3 min |
| 3 | `baseline` | 114 pass | 2,730,032 | 888,794 | 30,039 | 20,044 | $1.51 | 22.9 min |
| 3 | `rtk` | 114 pass | 2,833,071 | 584,287 | 30,609 | 17,176 | $1.43 | 41.3 min |
| 3 | `context-mode` | 114 pass | 3,229,106 | 1,319,750 | 31,940 | 24,260 | $1.78 | 25.7 min |
| 3 | `context-gateway-local` | 114 pass | 3,390,574 | 1,279,757 | 31,411 | 23,217 | $2.09 | 23.9 min |
| 3 | `haiku-subagent` | 114 pass | 1,586,121 | 1,177,595 | 25,184 | 34,920 | $1.35 | 23.5 min |

The two failed tests:

- `context-mode`, trial 1: `lmstudio discovery with LM Link > without lms the rows stay unlabelled`
- `context-gateway-local`, trial 1: `LocalTransport with a machine suffix > a model with no suffix loads nothing and adds no payload field`

Each is one of 114 tests in one of three trials. Three trials cannot tell a
tool effect from chance here. The haiku-subagent trials ran after the other
four variants' full run, so they also differ in time of day.

## What each tool did

Each tool was active in every graded trial. The figures are the tools' own
counts, not madbench's.

| Variant | Trial 1 | Trial 2 | Trial 3 |
|---|---|---|---|
| `rtk` (`rtk gain`) | 73 commands, 10.4K tokens saved (39.2%) | 64, 15.8K (49.5%) | 47, 12.5K (45.2%) |
| `context-mode` (Bash outputs its `PostToolUse` hook rewrote) | 11 | 14 | 14 |
| `context-gateway-local` (gateway's `session_stats.json`) | 103 requests, 57 tool outputs shortened, `tokens_saved` 525,270, 2 expand calls | 83, 46, 467,840, 5 | 95, 45, 362,194, 5 |
| `haiku-subagent` (`output-digest` started; its calls by model) | 1 started; 11 transcript lines, all `claude-haiku-5-5` | 1; 69, all `claude-haiku-5-5` | 5; 49, all `claude-haiku-5-5` |

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

## haiku-subagent: the Haiku calls

`output-digest` names `model: claude-haiku-5-5`, not the alias `haiku`, so
Claude Code cannot map it to another Haiku. The graded `VariantCheck` reads
Claude Code's own transcripts in the sandbox and passes only when at least
one subagent answer came from `claude-haiku-5-5` and none from any other
Haiku. It passed in all 3 trials: `pinned=11 other=0`, `pinned=69 other=0`,
`pinned=49 other=0` (transcript lines; one call can write several). The same
script exits 1 on a real `claude-haiku-4-5-20251001` transcript
(`pinned=0 other=35`) and on an empty folder.

Mean per trial, all threads, by model (madbench `llm_call` Events):

| Model | Requests | Prompt tokens | Output tokens |
|---|---|---|---|
| `claude-sonnet-5-5` | 61 | 3,518,293 | 53,975 |
| `claude-haiku-5-5` | 10 | 85,832 | 6,988 |

The main agent used `output-digest` once in two trials and five times in the
third, and still started its two explorers and one reviewer each time. The
Haiku calls carried 2.4% of the prompt tokens. The shift the table above
shows is larger than that: subagent prompt tokens rose 48.7% while
main-thread prompt tokens fell 15.8%, so most of the moved work went to the
Sonnet explorers and reviewer, not to Haiku. Why is not established.

madbench prices the main thread only, so the Haiku calls' cost is not in
"main-thread cost". They were billed to the subscription, as Claude Code's own
calls.

An earlier haiku-subagent trial, stopped and not counted, showed one more
behaviour: `output-digest`, given a task that called for a subagent, replied
"I don't have the Agent tool here" and ran the commands itself. A subagent
reads the same `CLAUDE.md` and cannot start a subagent of its own.

## context-gateway-haiku-key

Context Gateway v0.5.3 (the installed release, as in the native gateway
variant), run 2026-11-15, 3 trials, one at a time.

| Trial | Outcome | Duration | Haiku calls | Haiku input tokens | Haiku output tokens |
|---|---|---|---|---|---|
| 1 | errored: `API Error: The response stream was malformed. The response above may be incomplete.` | about 1.5 min | 14 | 47,893 | 13,388 |
| 2 | 114 pass, all Checks passed | 29.9 min | 53 | 149,847 | 39,123 |
| 3 | errored, same message | about 2.5 min | 20 | 57,245 | 14,802 |
| all | | | 87 | 254,985 | 67,313 |

The Haiku figures come from the usage recorder's log of each trial
(`out/context-gateway-haiku-key-live-20261115T214500`, `…T214634`,
`…T221639`). Every one of the 87 calls answered 200 from `claude-haiku-5-5`,
signed with `x-api-key`; no cache read or cache creation. madbench prices
none of them, and this report does not convert them to dollars: the price
in the cloud models catalog carries no unit this report could verify. The
durations of the errored trials are the gap between their log folders'
start times.

The graded trial's `VariantCheck` output:

```
main requests: total=112 subscription=112 fallback=0
gateway auth_fallback lines: 0
haiku calls: total=53 status200=53 bearer=0
answered by model:
  53 "model":"claude-haiku-5-5"
tool outputs compressed: 47
```

The gateway's own counts for that trial (`session_stats`): 1,275 tool
outputs, 47 compressed, 1,069 cache hits, 1,674,423 tokens before
compression and 576,118 after; `expand_context` was called 21 times;
preemptive summarization triggered 0 times.

The two errored trials end with the message the claudish gateway trials
ended with, so the stream defect in "Through claudish" can end a native
trial too. That cause is likely, not captured: an errored trial gets no
Check, and these runs did not record the stream. An errored trial left its
gateway and recorder running; they were stopped by hand after the run.

Against the baseline mean, the graded trial used 45.6% more prompt tokens and
35.1% more main-thread cost. One trial is no basis for a comparison of
means.

How the variant keeps the key away from Claude Code:

- **The key reaches the gateway only.** The Bench copies the file named by
  `--param gateway_env` to `~/.config/context-gateway/.env`, which the gateway
  loads at startup. `start.sh` starts the gateway with `ANTHROPIC_API_KEY`
  removed from its environment and deletes the file before the agent starts.
  Claude Code never receives the key: in a dry run with a fake key, the
  agent's own Bash printed `AGENT_ENV_KEY_UNSET`.
- **The source key file outlives the run.** The provision step deletes only
  the sandbox's copy. The file named by `--param gateway_env` stays where it
  is until someone removes it. For these trials it was removed by hand on
  2026-11-15, after the run.
- **The main thread stays on the subscription.** `config.yaml` names
  `auth: "api_key"`. Without that line, a provider that has a key gets the
  mode "both" (`internal/auth/setup.go`, `parseAuthFromConfig`; the comment in
  `config/providers.go` that calls `api_key` the default is wrong), and on a
  429, 529 or 402 from the subscription the gateway re-signs the main
  session's requests with the key. The graded `VariantCheck` requires every
  forwarded request to show `auth_mode_initial` and `auth_mode_effective`
  `subscription` with no `auth_fallback_used`. The dry run printed
  `main requests: total=4 subscription=4 fallback=0`.
- **The Haiku spend is measured.** The gateway keeps no usage of its own
  calls (the tool output pipe drops `CallLLM`'s usage). A local recorder
  between the gateway and `api.anthropic.com` writes the model, status and
  usage of every answer, never a header. The summarizer ignores the
  provider's endpoint, so the config names the recorder twice.
- **Mock control:** `5/5 checks failed as required · 0 wrongly passed`.

The first dry run was not dry. madbench's own keychain holds an
`ANTHROPIC_API_KEY` (last 4 `ZgAA`, stored 2026-09-19; not the key meant for
this variant), madbench puts it into the sandbox environment, and a
provision step inherits it although the agent does not. The gateway's
`.env` loader never overrides a set variable, so it signed one compression
call with that key: status 200, `claude-haiku-5-5`, 5,784 input and 1,692
output tokens. The `env -u ANTHROPIC_API_KEY` in `start.sh` closes this; the
re-run got `401 "invalid x-api-key"` from the fake key. The leak into
provision steps is filed as MadAppGang/madbench#216.


## Through claudish

The `context-reduction-claudish` Experiment runs the same Bench with claudish
between Claude Code and the API. The model is the bare name
`claude-sonnet-5-5`, so claudish runs a normal session on the Claude
subscription through its native passthrough and loads its hooks; rtk runs as
a claudish `toolCall` hook instead of a Claude Code hook.

**Build.** Every claudish trial except `claudish-compaction`'s (see its own
section) used the worktree build of this branch, version 14.24.0: `claudish --version` prints `claudish version 14.24.0`, and
the file was built at 09:39, before the first run started at 09:54.

**Errored trials, excluded and re-run.** 9 of the first run's 12 trials
errored with `agent never started: agent did not start within 1m0s`.
claudish 14.25.0 was published during the run, and from then on each trial's
claudish stopped at `Update available: 14.24.0 → 14.25.0` / `Update now? [Y/n]`
before it started Claude Code; nothing answers a question in an unattended
trial. The 3 trials that ran before the release are kept. The 9 were
excluded and re-run with the binary `./bin/claudish-unattended`, which runs
`claudish --quiet -y`: `--quiet` skips the update offer, and `-y` skips
`Enable auto-approve? [Y/n]`, which appeared on the fresh config once the
first question was gone. Auto-approve is claudish's default, so the session
is the same. Why the first 3 trials passed the auto-approve question is not
known.

Mean over 3 trials, change against `claudish-baseline`:

| Variant | Hidden tests passed | Prompt tokens, main thread | Prompt tokens, subagents | Prompt tokens, all | Output tokens, all | Main-thread cost | Requests main/sub | Duration |
|---|---|---|---|---|---|---|---|---|
| `claudish-baseline` | 2/3 | 2,793,813 | 1,026,200 | 3,820,013 | 51,006 | $1.54 | 36/29 | 29.1 min |
| `claudish-rtk` | 3/3 | 3,070,693 (+9.9%) | 693,721 (-32.4%) | 3,764,414 (-1.5%) | 49,559 (-2.8%) | $1.51 (-2.0%) | 38/23 | 27.0 min |
| `claudish-context-mode` | 3/3 | 2,938,283 (+5.2%) | 1,501,717 (+46.3%) | 4,440,000 (+16.2%) | 58,570 (+14.8%) | $1.76 (+13.7%) | 36/44 | 32.3 min |
| `claudish-context-gateway-local`, Context-Gateway v0.5.3 | could not complete: 4/4 trials errored at the gateway's `expand_context` append | | | | | | | |
| `claudish-context-gateway-local-streamfix`, Context-Gateway v0.5.3, locally patched for Compresr-ai/Context-Gateway#48 | 3/3 | 3,584,736 (+28.3%) | 1,536,626 (+49.7%) | 5,121,362 (+34.1%) | 55,533 (+8.9%) | $1.96 (+26.8%) | 50/43 | 33.3 min |

Ranges (least to most): `claudish-baseline` 3,286,752 to 4,577,894 prompt
tokens, $1.38 to $1.80, 16.1 to 42.7 min; `claudish-rtk` 3,357,195 to
4,218,521, $1.48 to $1.58, 9.1 to 44.1 min; `claudish-context-mode` 3,766,588
to 5,322,884, $1.62 to $1.94, 27.0 to 42.0 min;
`claudish-context-gateway-local-streamfix` 4,535,753 to 6,274,336, $1.62 to
$2.31, 26.6 to 44.1 min.

The failed test: `claudish-baseline`, trial 1, 113 pass, 1 fail.

claudish itself, against the native baseline: 4.9% more prompt tokens and
2.3% more main-thread cost, inside both baselines' ranges. Per variant the
claudish results match the native ones in direction: rtk inside the noise,
context-mode about 15% above.

rtk ran in every claudish trial: 48, 56 and 46 commands, 10.1K, 11.1K and
2.6K tokens saved by its own count.

### claudish-context-gateway-local: could not complete

All 3 trials of the re-run, and one diagnostic trial, errored after 1.1 to
1.5 minutes with `API Error: The response stream was malformed. The response
above may be incomplete.`

Observed, in the diagnostic trial's gateway log: at 14:46:46 the gateway
shortened the two explorer subagents' reports (`original_tokens=2186`,
`3402`, `strategy=trimming tool=Agent`); the main agent called
`expand_context` for them; at 14:46:48 the gateway logged `streaming:
expand_context detected, appending expanded content expand_calls=2`, then
`expansion complete (append-only)`, and Claude Code rejected the stream.

Cause, **likely, not captured** (the failing bytes were never recorded):
after an expansion, the gateway streams the retry response through
`streamResponseWithFilterAndUsage` (Context Gateway v0.5.3,
`internal/gateway/handler_streaming.go:417-450`). It reads 4096 bytes at a
time (`config/defaults.go:39`) and passes each read to
`StreamBuffer.ProcessChunk` (`internal/pipes/tool_output/stream_buffer.go`),
which splits that read on `\n` with no carry-over to the next read (line 39)
and writes every piece followed by a new `\n` (lines 45-46, 180-181). A line
cut by a read boundary becomes broken JSON, and an extra `\n` splits an event
from its data line. claudish forwards only whole events, but sends all
complete events of one upstream read in one chunk, so a 4096-byte boundary
almost always falls inside an event. That api.anthropic.com usually flushes
one event at a time is inferred, not measured. Reproduced offline: a port of
`ProcessChunk` fed two streams claudish recorded in the diagnostic trial, cut
into 4096-byte reads, produced 11 and 17 broken events; fed one event per
read, it produced 0. The padded `message_stop` in claudish's log is valid
JSON and is not the cause.

Natively, the gateway trials made 2 to 5 expansions each and completed; one
native dry run of the Haiku key variant failed the same way after an
expansion.

The defect is filed upstream as Compresr-ai/Context-Gateway#48.

### claudish-context-gateway-local-streamfix: the patched gateway

The same variant, on Context-Gateway v0.5.3 locally patched for
Compresr-ai/Context-Gateway#48. The patch is
`/private/tmp/claude-501/-Users-jack-mag-claudish/909617a1-1a03-4869-b84e-16c834d287fc/scratchpad/gw-fix/streamfix.diff`,
outside this repository. It makes two changes:

- the read loop carries an unfinished SSE event over to the next 4096-byte
  read;
- `ProcessChunk` no longer adds a `\n` that the input did not have.

A new Go test in the gateway fails on v0.5.3 and passes with the patch.

The variant's own `gateway_bin` is `config/no-gateway-bin`, which refuses to
start. The run named the build with `--param gateway_bin=<path>`. Each
trial's start log shows the build that served it:

```
start: gateway binary …/madbench-927608326/home/.bench-gateway/context-gateway sha256 84c97c450bf0d7a9707351542a1379235c40b35ccb105fe1a1ce7406c0a312a9
start: gateway binary …/madbench-1930447487/home/.bench-gateway/context-gateway sha256 84c97c450bf0d7a9707351542a1379235c40b35ccb105fe1a1ce7406c0a312a9
start: gateway binary …/madbench-2157266720/home/.bench-gateway/context-gateway sha256 84c97c450bf0d7a9707351542a1379235c40b35ccb105fe1a1ce7406c0a312a9
```

The installed v0.5.3 is `98045fd35ec76afec55500f32b7c2b16dd7fb6af838e32d9f231f237c633ca80`.
The evidence line `tool=context-gateway v0.5.3` names the installed release
in every trial and does not tell the two builds apart.

All 3 trials passed all 114 hidden tests and all Checks. The path that broke
v0.5.3 ran in each trial, and no stream error occurred. This supports the
cause given above, because the patch changes only the two lines of code that
cause names. The failing bytes are still not captured. From the gateway's
`session_stats.json`:

| Trial | Tool outputs | Compressed | Cache hits | Tokens before / after compression | `expand_context` calls |
|---|---|---|---|---|---|
| 1 | 787 | 56 | 731 | 1,026,649 / 571,914 | 9 |
| 2 | 769 | 40 | 729 | 866,321 / 496,769 | 7 |
| 3 | 1,079 | 51 | 1,028 | 1,295,378 / 740,614 | 8 |

The gateway removed 369,552 to 554,764 tokens of tool output per trial, and
the trials still sent 34.1% more prompt tokens than `claudish-baseline`.
Uncached input rose from a mean of 130 tokens per trial to 28,261, and cache
creation rose 21.9%. This matches the native gateway result (see "Why the
gateway costs more").

### claudish-compaction: claudish's own compaction

claudish's `--compaction` on `claude-haiku-5-5`: a tool output of 4,000
tokens or more (by chars/4, about 16,000 characters) is compressed once by a
Haiku call, stored, and the stored text is sent again byte for byte on every
later request. A history summary is prepared ahead and swapped in near the
window limit.

**Build: 04cbb471 with known defects.** Every trial ran a compiled claudish
from the compaction branch at source 7dd0e577, sha256
`04cbb471e9578072c0b9c8d601b9af64bfd851587b939cf64035a5aefb88d170`, started by
`./bin/claudish-compaction` with `--compaction --debug-claudish`. Each trial's
launch log records that sha256. The build has two known defects, fixed in a
later build:

- a re-read of a compressed output's recovery file is compressed again;
- a Read before an Edit is compressed.

Neither occurred in these trials: no Read output was compressed, and no
recovery file was read. This build is not the 14.24.0 build of the other
claudish variants, so the comparison below mixes compaction with any other
change between the two builds.

**The key.** The Haiku calls are signed with an Anthropic API key from the
run's `~/.claudish/config.json`, not passed with `--config`, which would
reach Claude Code as `CLAUDISH_CONFIG`. Each trial checked, and passed:

- `ANTHROPIC_API_KEY entries in the launcher environment: 0`;
- Claude Code's own environment, read with `ps`: `AGENT_ENV_KEY_UNSET
  CLAUDISH_CONFIG_present=0`;
- `agent tool calls naming the config: 0`;
- every compaction call logged `model: claude-haiku-5-5, auth: x-api-key`.

Before each trial, one more start had the key in its environment and was
refused by the launcher's check (`launcher environment: 1`); the trial's
session then started with 0. Inferred: madbench's harness probe, which starts
the harness binary once with madbench's own environment before the session.

Mean over 3 trials, change against `claudish-baseline`:

| Variant | Hidden tests passed | Prompt tokens, main thread | Prompt tokens, subagents | Prompt tokens, all | Output tokens, all | Main-thread cost | Requests main/sub | Duration |
|---|---|---|---|---|---|---|---|---|
| `claudish-baseline` | 2/3 | 2,793,813 | 1,026,200 | 3,820,013 | 51,006 | $1.54 | 36/29 | 29.1 min |
| `claudish-compaction`, build 04cbb471 with known defects | 2/3 | 2,798,125 (+0.2%) | 662,811 (-35.4%) | 3,460,936 (-9.4%) | 47,853 (-6.2%) | $1.42 (-8.2%) | 36/22 | 25.9 min |
| `claudish-compaction`, trial with the wrong flag (not in the mean) | 113 pass, 1 fail | | | 3,288,962 | | $1.47 | | |

Ranges (least to most): `claudish-compaction` 3,005,411 to 4,152,207 prompt
tokens, $1.30 to $1.65, 18.9 to 33.5 min. The range lies inside
`claudish-baseline`'s (3,286,752 to 4,577,894), so the -9.4% is not larger
than the spread between trials.

The failed test: trial 2, `computeMainThreadContextWindow on lmstudio > the
limit caps another local provider`, 113 pass, 1 fail.

**The trial with the wrong flag.** The first complete trial ran with `--debug`,
which claudish passes on to Claude Code; claudish's own debug log needs
`--debug-claudish`. So Claude Code ran with `--debug`, and no claudish debug
log exists for it: what compaction did in that trial cannot be shown from the
log. The wrong flag came from the brief for this variant, which repeated the
compaction branch's own command line. Matched by length from the report's
tool results, 2 outputs crossed the size limit: one Bash output of 16,501
characters and one Read of `providers/lmstudio-devices.ts` of 16,126
characters. It is reported on its own row and is in no mean.

Haiku calls, from the debug logs (tokens only):

| Trial | Calls | Signed | Answers | Tokens in / out |
|---|---|---|---|---|
| 1 | 3 | 3 `x-api-key` on `claude-haiku-5-5` | 3 HTTP 200 | 26,331 / 3,924 |
| 2 | 1 | 1 `x-api-key` on `claude-haiku-5-5` | 1 HTTP 200 | 9,356 / 1,942 |
| 3 | 1 | 1 `x-api-key` on `claude-haiku-5-5` | 1 HTTP 200 | 7,844 / 727 |

Compressed tool outputs, from the debug logs joined to the report's Events.
All 5 were Bash outputs in subagent threads. 0 were Read outputs.

| Trial | Tool | Characters before / after | Sends of the stored text | Distinct sha256 | Cache breaks after it |
|---|---|---|---|---|---|
| 1 | Bash | 17,405 / 2,526 | 7 | 1 | 0 |
| 1 | Bash | 19,865 / 2,126 | 3 | 1 | 0 |
| 1 | Bash | 23,505 / 3,216 | 10 | 1 | 0 |
| 2 | Bash | 22,011 / 4,073 | 4 | 1 | 0 |
| 3 | Bash | 18,049 / 1,573 | 3 | 1 | 0 |

**Re-expansions: 0** in all 3 trials. A re-expansion is a Read whose
`file_path` contains `/.claudish/compaction/`, the agent reading a compressed
output's recovery file.

What this shows:

- **The stored text replays byte for byte.** Every compressed output was
  resent with one sha256, and no request after it broke the cache. The
  variant had 0 breaks in 3 trials, as rtk and context-mode had.
- **Compression explains little of the difference.** Over all its sends,
  compression removed about 360K, 72K and 49K characters per trial, about
  90K, 18K and 12K tokens by chars/4. The mean difference against
  `claudish-baseline` is about 359K prompt tokens per trial. Most of it is
  the spread between trials (inferred).
- **Few outputs qualify.** 1 to 3 outputs per trial reached the size limit.
  The transcripts hold some subagent outputs twice: in trials 2 and 3, 2
  large transcript results are 1 distinct tool_use id. Trial 1's transcripts
  had 5 large results for 3 compressed outputs; the ids were not recorded in
  that trial.
- **No history summary ran.** No debug log has a `[compaction] history`
  line, so the history part of compaction was not tested here.

### Compaction history check (not a variant, in no mean)

A separate Bench, `history/madbench.yaml`: one interactive session through
claudish with `--compaction`, in a small git repository, with a config whose
history thresholds are low enough for a short session. Build: source
6f869a1d, sha256
`65063e0bd1e1562045ed77d9dd217c25c5b9090f9a042b4839087365d170114a`
(`claudish version 14.25.0`), a later build than the trials above. Four turns:

1. "Read package.json and tell me the package name and its scripts."
2. "List the files in the top-level folder and name the three largest."
3. "Run `git log --oneline -5` and then `git status --short`, and summarise both."
4. "In one sentence, what did my first question ask, and what was the answer?"

The debug log shows three summaries and two swaps:

```
[compaction] history summary started in session f4bb71fa-…: messages 0..9
[compaction] history summary ready in session f4bb71fa-…: messages 0..9, 1344 characters
[compaction] history swap in session f4bb71fa-…: messages 0..9 replaced by a summary of 1344 characters
[compaction] history summary started in session f4bb71fa-…: messages 0..13, rolling forward from 9
[compaction] history summary ready in session f4bb71fa-…: messages 0..13, 1939 characters
[compaction] history swap in session f4bb71fa-…: messages 0..13 replaced by a summary of 1939 characters
[compaction] history summary started in session f4bb71fa-…: messages 0..15, rolling forward from 13
[compaction] history summary ready in session f4bb71fa-…: messages 0..15, 2343 characters
```

3 Haiku calls, all `claude-haiku-5-5` with `x-api-key`, HTTP 200, 9,492 in /
2,391 out tokens; 0 failed, 0 skipped. The third summary was ready when the
session ended and was not swapped in. The key checks passed as in the trials.

The fourth answer, after both swaps:

> Your first question asked me to read `package.json` and report the package
> name and scripts. The package is `tally-sheet` (v0.3.1), and its scripts
> are `start` (`bun src/index.ts`), `test` (`bun test`), `lint` (`biome check
> src`) and `build` (`bun build src/index.ts --outdir dist`).

The answer is right: the summary kept the first turn's facts. This is one
session of four short turns; it shows that the history path runs end to end,
not what it saves.

## Explanations (inference, not verified)

- **Why the gateway costs more.** Shortened tool output leaves the agent
  with less to work from, so it runs more commands and asks for more
  (2 to 5 expand calls per trial). Each extra request re-sends the history.
  The rewritten history also changes the start of later prompts, which
  matches the rise in uncached input and cache creation (+20.6%).
- **Why context-mode costs more.** Its subagents made 56% more requests than
  the baseline's. A rewritten output that hides the middle of a long result
  can send the agent back for it with a narrower command.
- **Why rtk changes little.** Its savings are 2.6K to 15.8K tokens of
  command output per trial, while each trial sends about 3.4M to
  3.8M prompt tokens, 92% to 94% of them cache reads of the same history.
- **Why the Haiku subagent saves nothing in total.** It handled few outputs
  (1 to 5 per trial), and each handoff is itself a prompt plus an answer
  the main agent reads.

## Not measured

- **Total cost.** madbench's cost covers the main thread only. Subagent
  tokens are reported above; no subagent cost figure exists in the report.
- **Behaviour near or past the context window.** No Session compacted; the
  largest request was 122,396 tokens. Context Gateway's history summarizer
  triggers at 85% and did not run in any trial.
- **Background subagents.** Every variant ran them in the foreground.
- **`context-gateway-haiku-key` beyond one trial.** 2 of 3 trials errored, so
  its row is one graded trial. Its Haiku calls are given in tokens, with no
  dollar figure.
- **`claudish-context-gateway-local` on the released gateway.** v0.5.3 could
  not complete; only the locally patched build was measured through claudish.
- **Variance.** 3 trials per variant give a range, not a confidence
  interval. Durations vary up to 4.8 times within one variant, mostly from
  how often the agent ran the full test collection.
- **Other tasks.** One Scenario, one repository, one model for the main
  thread.
- **Claude Code's own `/compact` and the `ctx_*` tools,** because nothing
  triggered them.

## Gaps found in madbench

The manager session filed the draft's items as madbench issues #211 to #215;
#212 covers item 3 and #215 covers item 5. The draft is in the session folder,
`ai-docs/sessions/context-reduction-bench-20261114-101500-a7c3/madbench-gaps-draft.md`
(git-ignored).

1. A background subagent is closed at once, and the Session ends while it
   runs.
2. A follow-up is typed while background subagents still run.
3. madbench's metrics and cost are main thread only; there is no source for
   a subagent's tokens or cost. `summarize.ts` stands in for this item.
4. Nothing owns a process that a provision step starts; `config.dirs` files
   are absent at provision time.
5. A Harness error drops the whole Session: the first context-mode trial ended
   after 21.7 min with `OAuth token revoked · Please run /login
   (api_error_status 401)` and kept no Events and no Checks. The same holds
   for every errored trial above: madbench deletes the sandbox and runs no
   Check, so the bench now writes tool logs to its `out/` folder from the
   start.
6. `madbench check` refuses `--plain`; `--no-update-check` does not exist.

One more, filed as MadAppGang/madbench#216: a secret madbench withholds from
the agent under `use_subscription: required` (its keychain
`ANTHROPIC_API_KEY`) still reaches `sandbox.provision` steps, and a process a
step starts inherits it. `tools/context-gateway-haiku-key/start.sh` works
around it with `env -u ANTHROPIC_API_KEY`.

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
- One forwarded request per gateway run, native and through claudish, got
  `429 rate_limit_error "Error"`; it is the same in every gateway variant.
- The shared gateway `evidence.sh` counts `summaries=1` when the compaction
  log holds only its `logger_initialized` line; that is not a summary.
- madbench resolves `binary: claudish` from `PATH`; `MADBENCH_CLAUDISH` does
  not change it. A binary from `bun run build:binary` is killed by macOS
  (exit 137) until it is re-signed with `codesign --force --sign -`.
- The prompt's bare `bun test` runs claudish's whole test collection, which
  takes several minutes; this is the same for every variant.

## Reproduce

```
PATH=/opt/homebrew/bin:$PATH madbench ai-docs/benches/context-reduction/context-reduction.experiment.yaml \
  --variant baseline --variant rtk --variant context-mode --variant context-gateway-local --variant haiku-subagent \
  --trials 3 --concurrency 1 --report-json /absolute/path/native.json
PATH=/path/to/claudish-build/bin:/opt/homebrew/bin:$PATH madbench \
  ai-docs/benches/context-reduction/context-reduction-claudish.experiment.yaml \
  --trials 3 --concurrency 1 --report-json /absolute/path/claudish.json
bun ai-docs/benches/context-reduction/summarize.ts /absolute/path/native.json
```

The gateway key variant needs `--variant context-gateway-haiku-key
--param gateway_env=/absolute/path/to/a/0600/key/file`.

The report JSON files are in the git-ignored session folder
`ai-docs/sessions/context-reduction-bench-20261114-101500-a7c3/`:
`full-4variants.json` (191 MB), `full-haiku-subagent-3trials.json`,
`full-claudish.json`, `full-claudish-rerun-a.json`, `full-claudish-rerun-b.json`
and `diag-claudish-gateway.json`.
