# Compaction — claudish's own context compaction

`--compaction` (`CLAUDISH_COMPACTION=1`, `compaction.enabled`) makes a session's context smaller
with a small Claude model on the Claude API: large tool outputs are compressed once, on first
sighting, and the earlier conversation is replaced by a summary at a human-turn start or after a
complete tool round. Code:
`packages/cli/src/compaction/`. User guide: `docs/advanced/compaction.md`.

Read this before editing anything under `compaction/`, the decorator chain at the
`/v1/messages` route, the `count_tokens` route, or the compaction branch of `claude-runner.ts`.

## Why it exists: the gateway measurement

A bench of outside context tools ran Context-Gateway, a proxy that shortens `tool_result` text
between Claude Code and claudish. Its trimming **added 33% prompt tokens**: the agent asked again
for content that had been cut, and uncached input rose **from 120 to 13,284** tokens, which points
to prompt-cache breaks. The gateway rewrites a tool output AFTER the model has seen it, in the
background, and swaps the short form into later requests. Every swap changes history the model
already read.

That measurement is the design constraint: compaction must never change what the model has already
seen, except at one deliberate point (a history swap) that costs exactly one cache write.

## Why a request decorator, and not a hook action

`withCompaction(handler, runtime)` (`compaction/decorator.ts`) wraps the RESOLVED handler at the
`/v1/messages` route, as `withAdvisor(withCompaction(withRequestHooks(h)))`:

- **It covers every route.** A top-level `claude@` or `anthropic@` launch runs in monitor mode
  (`launcher/claude-launch.ts:401`, `:415` set `config.monitor = true`), and monitor mode loads no
  hooks (`proxy-server.ts`, `options.hooks !== false && !monitorMode`). A hook action would never
  run there. A bare `claude-sonnet-5-5` is a normal session and does load hooks, but the decorator
  does not depend on that.
- **No hook budget limits it.** A request-stage hook has a 5 s budget; one compression of a large
  output can take longer. The decorator waits up to `toolOutputs.timeoutMs` (20 s) in total.
- **Order.** It runs after the advisor's rewrite of its own tool_results (which it skips, by the
  tool name `ADVISOR_TOOL_NAME`) and before the hooks, which see the compacted body. The classifier
  shortcut is not touched.
- `count_tokens` applies the RECORDED forms only (`applyStoredForms`: the advisor's results
  already delivered, `rewriteAdvisorToolResults` with `getAdvisorCall`, then tool-output replay,
  then a recorded history swap), with no model call, so Claude Code's gauge reads what
  `/v1/messages` sends. The advisor step comes first because the history hashes cover the
  advisor's tool_results as `/v1/messages` rewrote them.

The session key is `session_id` from `metadata.user_id`. A request with no session id, or an id
that is not one safe path segment (`isSafeSessionId`), passes through untouched.

## Why compress on first sighting, inline

Two things bind to the exact history the model already saw:

- the **prompt cache**, which matches the request prefix by content;
- the **thinking blocks** of Sonnet 5.5, Opus 5.5 and Haiku 5.5, each bound to the history before
  it. The bundled `claude-api` skill (cached 2026-11-03) states that accounts created on or after
  2026-08-31 get a 400 when an earlier message changed. **That is a documented claim, not
  measured here.**

A cache break and a thinking break have one cause: an edit to history the model already saw. So a
tool output may be compressed only BEFORE the model sees it the first time. A background
compression with a later swap (the gateway's pattern) cannot be made cache-stable. The cost of
doing it inline is a wait of a few seconds on the turn that produced a large output.

## Cache-stability rules

Each rule has a test.

1. **Decide once.** A `tool_result`'s form is decided on its FIRST SIGHTING, which is when it is
   in the request's last message. The decision is keyed by `sha256(session_id, tool_use_id,
   original text)` (`toolOutputKey`).
2. **Never compress what the model saw.** An eligible `tool_result` first seen anywhere else
   (compaction switched on mid-session, a store lost) is recorded `original` and never compressed.
3. **Replay, never regenerate.** Every later request sends the recorded form. The store is on disk
   (dir `0700`, files `0600`, published by a no-replace hard link), so a proxy restart or
   `claude --resume` replays the same text.
4. **A failure is final.** A timeout, a 429 "Error" shape refusal, any 4xx or 5xx, an incomplete
   answer, or a result above `maxRatio` records `original`. It is never retried: a retry on a
   later turn is a cache break.
5. **Content, not formatting.** The cache matches content after JSON parsing. The native forward
   re-serialises the body (`bodyToForward`); identical content serialises identically.
6. **History swaps** happen only at a swap point (`isSwapPoint`): the last message starts a new
   human turn (a user message with user text and NO `tool_result` block; Claude Code adds text
   blocks beside tool results, so "has text" alone is not a turn start), or it is a user message
   whose tool_results answer EVERY tool_use of the assistant message before it
   (`isCompleteToolRound`). Never between a tool_use and its result. The boundary message never
   holds a tool_result (`isSafeBoundary`), so every kept tool_result keeps its tool_use. A swap strips `thinking` and
   `redacted_thinking` from the turns it keeps (the safe shape for keep-tail compaction). Until the
   next swap, every later request sends the same summary bytes and the same stripped turns. Each
   swap costs one cache write.

## What is never compressed

A `tool_result` is a candidate only when its content is a string or text blocks only, it has no
`is_error`, it reaches `minTokens` (characters / 4), and none of these holds. A block that matches
one of them is never compressed and never recorded, so it is sent as it is on every request:

- **The advisor's results**, by the tool name `ADVISOR_TOOL_NAME`.
- **A tool named in `toolOutputs.skipTools`**, by the tool_use's name; default `["Read"]`, and an
  empty list skips nothing. `Read` is skipped because the model edits with `Edit`, which needs the
  file's exact text: a compressed Read drops the lines an edit has to match, so the model reads the
  file again. A record made before a tool was listed is still replayed (`replay` reads records,
  not the list): dropping a compressed form the model has seen would change its history. The
  recovery-read rule below is checked first, so its log line is written also when `Read` is
  listed.
- **A read of this session's recovery files.** The tool_use's input `file_path`, after
  `path.resolve`, lies inside `store.sessionDir(sessionId)` or inside that folder's real path (the
  store root may sit behind a symlink). It is checked by the input path, not by the tool name.
  Compressed again, the read would get one more Haiku call and a footer pointing to ANOTHER `.txt`,
  and the model would never see the full original. When such a block is in the request's last
  message, the debug log gets one line, `[compaction] session <sessionId>: recovery read <key>`
  (the file's basename without `.txt` when it is a record key, else the basename); a later request
  that carries it earlier in the history logs nothing. A sibling session's folder is not exempt.
- **A Bash command that only prints files** (`compaction/file-print.ts`, `isFilePrintCommand`). It
  is the Read loss through Bash, measured in the context-reduction bench's refactor case on build
  `a6952916`. Every trial's first call was
  `cd packages/cli && grep -rn "nativeRouteFor" src; echo ---; cat src/providers/native-route.ts`
  (17,088 to 17,176 characters). Compressed, the agent printed and grepped the file again to get
  the exact text to edit: 17 to 22 tool results instead of 10, and +42.9% cost against the
  baseline ($0.2541 vs $0.1778 mean, 3/3 passing in both variants). The rule is an allowlist, so a miss
  only compresses as before. Outside quotes, the command splits into segments on `;`, `&&`, `||`
  and newlines, and each segment into stages on `|`. Every stage must be a printer (`cat`, `nl`,
  `head`, `tail`, `bat`, `less`, `more`, `sed -n '<range>p'`) or a locator (`cd`, `pwd`, `echo`,
  `ls`, `wc`, `grep`, `egrep`, `rg`, `sort`, `uniq`, `cut`). At least one segment must start with
  a printer that has a file operand and pipe it only into printers. `cat f | grep x` shows matches,
  not the file, so it does not count. It is refused for any other program (`bun test`, a build),
  a redirection other than `2>/dev/null` / `2>&1`, `$(…)`, backticks, `<(…)`, `&`, a heredoc,
  `tail -f`, `sed -i`, or a shell keyword (`for`). It is checked after the size test, so only an
  output that would have been compressed logs `[compaction] session <sessionId>: file print
  <tool_use_id> not compressed`, and only when the block is in the request's last message. It is
  not configurable.
- **Every other skip of a fresh block is logged too**, so a session whose outputs never reach
  Haiku says why: `[compaction] session <sessionId>: tool_result <tool_use_id> (<tool>) not
  compressed: <reason>`, where the reason is `is_error`, `<tool> is in skipTools`, `content is not
  text only`, or `<N> tokens, below minTokens <minTokens>` (`candidateVerdict`). Only a block in
  the request's last message logs, so each output logs once, on its first sighting. The advisor's
  result logs nothing, and a recovery read keeps its own line. Before this line, a case-b bench
  trial on `glm@glm-5-turbo` (53 requests) logged only the `[compaction] on` line, and its log
  could not tell outputs below the minimum from outputs of a skipped tool.

## History swap shape (`compaction/history.ts`)

- **Limit** = min(the request model's catalog context window, the `CLAUDE_CODE_AUTO_COMPACT_WINDOW`
  Claude Code runs with). Claude Code writes the `env` block of its enabled settings layers over the
  environment it was given, so the runner records the value of the highest-precedence enabled
  layer that names the variable (managed, `--settings`, local, project, user, with
  `--setting-sources` honoured; `recordLaunchAutoCompactWindow` through `settingsEnvValue`,
  `claude-runner.ts`, the same layer reader as the login-token check), else the child env's
  value, just before the spawn. A user `~/.claude/settings.json` setting `200000` therefore limits
  a 1M model to 200K here too, as it does in Claude Code. An empty layer value clears the window;
  an unreadable layer at or above the deciding tier, or two layers of that tier that disagree,
  keep the child env's value. The value is clamped to Claude Code's 100K floor and 1M ceiling
  (`setLaunchAutoCompactWindow`); empty or non-numeric records none. No catalog window ⇒ history off for that request, with one
  "history off: the catalog publishes no context window for <model>" line per session and model
  (before it, the skip wrote nothing, and a foreign model the catalog does not size, such as
  `glm-4.7` in generation `g-20261116161706980-7c7c9818`, looked like a route history never ran on). The model is the one the proxy
  routes the request to (`resolveHandlerForRequest`'s target after the slot map, role mapping and
  `--model`; the bare id for `claude@<id>`), never the raw `body.model`: a role mapping can send
  `claude-sonnet-*` to a model with a smaller window, or none. A `[1m]` suffix is removed for the
  lookup. The catalog window comes from the named provider for `provider@model`, the Claude API
  connection for `claude-*`, else the model's own.
- **Measure** with the real count (`compaction/real-count.ts`, `RealTokenCount`), NOT
  `localTokenEstimate`. Measured in the context-reduction bench (case d, build `a6952916`,
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000`): the main thread peaked at 173,646 real tokens while
  JSON length / 4 read about 105K (about 2.4 characters a token), under the 120K precompute mark.
  Claude Code compacted twice (first at real ~161K) and claudish never started a summary; baseline
  trials compact at real 159K to 170K. Now `withCompaction` taps every 2xx response
  (`tapUsage`: an SSE stream's `message_start`/`message_delta` usage through `mergeSseUsage`, or a
  JSON body's `usage`) and records `input_tokens + cache_read_input_tokens +
  cache_creation_input_tokens` against what that request sent (thread, message count, hash of the
  last message, JSON length). The next request of the thread counts as that number + the JSON
  characters appended since / the characters-per-token ratio of the same measurement (clamped to
  1..8). A thread with no matching measurement uses the session's newest ratio ("calibrated"); a
  session with none yet uses JSON length / 4. A request at or above `precomputeAt` logs
  `[compaction] session <id>: history count <n> of <limit> tokens (<source>)`, the source naming
  the measured usage and the appended estimate. `count_tokens` still answers with
  `localTokenEstimate`: it is Claude Code's gauge, not this decision.
- **One bounded wait** (`waitBeforeCcCompact`, `HISTORY_SWAP_WAIT_MS` = 20 s, the
  `toolOutputs.timeoutMs` default). Claude Code decides to compact from the usage claudish
  returned for the previous request plus what it appended, before it sends the next request. So a
  swap must be in the response of the last request before that point; a swap on the compaction
  request itself is too late (and is not made, see Claude Code's own compaction request below). A
  request waits for the thread's summary in flight only when it is a swap point, its count is at
  or above the swap gate (`applyAt`, or `precomputeAt` under `cost`), and its count plus one
  request's measured growth reaches `CLAUDE_CODE_COMPACT_AT` of the limit. The count is of the
  request as sent, the active swap applied: the wait runs before `compact` replays the swap, and
  the original history stays above Claude Code's point once a swap is active (measured on
  `8c6e053f`: "237850 tokens now" up to "769903", so nearly every request with a summary in
  flight waited 5 to 19 s). It then swaps if the summary is ready. Every wait logs
  `[compaction] history waited <ms> ms in session <id>: <N> tokens now, next request projected <P>, Claude Code compacts at <M>; summary ready|summary not ready after <cap> ms`.
  A summary that is not ready by the cap leaves the request unchanged; Claude Code's compaction
  stays the fallback. Every other request never waits.
- **Prepare** at `precomputeAt`, in the background, not awaited (except by the one wait above).
  Boundary `b` =
  `summaryBoundary`: the start of the last human turn when the last message starts one; inside a
  turn, the later of that and the assistant message that begins the second-newest complete tool
  round (`MID_TURN_TAIL_ROUNDS` = 2), so the newest two rounds' outputs stay verbatim after a
  swap (the file-print loss above is the cost of losing them). Inside a turn a new summary starts
  only `MID_TURN_MIN_ADVANCE` (8) messages past the thread's newest summary, so a long turn does
  not start one per request. **A summary also starts early by projection** (`projectedTokens`):
  when `count + growthPerRequest × K` reaches `precomputeAt`, where K is the session's newest
  summary duration over the gap since the previous request (15 s assumed until one is timed,
  at most 8 requests). Bench E1 cost t1 grew 42,284 -> 162,022 in 4 requests over 27 s; its
  rolling summary started at 139,555 and was ready 14 s later, after Claude Code compacted at
  167,869. Growth needs two measured responses, so the first request of a thread never
  projects. An early start logs
  `[compaction] history summary started early in session <id>: <N> tokens now, projected <P> in <K> requests, prepareAt <M>`.
  Messages `[0, b)` are rendered as plain text (tool_results in the form this
  request sends, cut to 2,000 characters; no thinking; the whole input capped at 400,000
  characters by dropping the oldest messages after the first). A summary rolls forward from the
  newest ready summary below `b`. `max_tokens` 8192, claudish's own system prompt. One summary in
  flight per (session, thread); the thread is the hash of the first message.
- **Apply** at `applyAt` (default 0.75), when a summary is ready and the request is at a swap
  point (rule 6). In agent work the window fills inside one long turn, so a swap that waited for a
  human turn start lost to Claude Code's own compaction every time. The default sits below the
  point near 0.8 of the window where Claude Code compacts (159K to 170K of 200K measured), leaving
  about 10K tokens, a few tool rounds, for the swap to land first. A swap inside a turn logs
  `[compaction] history swap in session <id> mid-turn, after a complete tool round: messages 0..<b> ...`.
  Stripping thinking inside a tool loop is a request shape the API accepts (the model continues
  the turn without the stripped reasoning; the claude-api skill's "strip every thinking block"
  path).
  `[user "[claudish: summary of the earlier conversation]\n<summary>"]` + messages `[b, end)`
  without thinking + messages after `end` unchanged. Recorded as a `history-swap` with
  `(prefixHash over [0,b), tailHash over [b,end), one hash per message of [b,end), b, end)`.
- **A swap inside a turn keeps that turn's user prompt verbatim** (`pinnedPromptIndex`,
  `summaryMessage`). Inside a turn `b` is past the turn's human message, so `[0, b)` held the
  user's own prompt and only the summary carried it. Bench XL Haiku early t1 lost its turn-1 spec
  this way (boundary 104, messages 0..103); the summary kept only a headline, and the agent then
  accepted a wrong review finding and deleted correct code (inferred, not proven, that the lost
  text decided it). Now the summary message is blocks: the summary text,
  `[claudish: the user's request for this turn, verbatim]`, then the prompt's own blocks (text,
  image, document) with cache markers dropped, so the bytes are equal on every request whatever
  message Claude Code marks. The record keeps `pinned` (that message's index); the prefix hash
  covers it, so a changed prompt matches no swap. A record without `pinned` (written before) replays
  the summary alone. The decision's `S` is this whole message. A swap whose pinned prompt and kept
  rounds stay at or above Claude Code's compaction point is held, with the reason
  `the current turn's prompt and newest rounds are <N> tokens, at or above Claude Code's compaction point <M>`:
  the prompt is never cut or summarised, and Claude Code's own compaction stays the fallback. A
  swap at a human turn start keeps the plain string form (its prompt is message `b`).
  Hashes are taken over canonical JSON (sorted keys, `cache_control` markers removed) of the
  messages as the tool-output pass left them.
- **Replay** on every later request of the same thread whose prefix `[0,b)` hashes to
  `prefixHash` and which has at least `end` messages. The tail is NOT required to match. Measured
  on native claude-sonnet-5-5: the request after a swap changed the one message in `[b,end)` (the
  turn's human message, newest at swap time), and the old rule then resent the whole original
  history (upstream cache_read back at the old prefix, 34,387 tokens against 27,762 on the swap
  request; no replay in the session). The summary bytes that replace `[0,b)` are identical either
  way; a changed tail message changes only its own bytes. Thinking is stripped from the CURRENT
  `[b,end)` on every replay; messages after `end` keep theirs (they were produced on the swapped
  history). A rewind into `[b,end)` (fewer than `end` messages) or a changed prefix does not match.
  When a message of `[b, end)` differs from the record by `messageHash`, the debug log names it
  without content. `messageHash` hashes a content of exactly one text block as that text, because
  Claude Code 2.1.325 sends its newest message as `[{type: "text", text, cache_control}]` and
  the same message as a plain string on every later request (captured from its requests against a
  local mock, interactive and `-p`). Without that, bench case d on `0aed68ec` logged a tail change
  on all 7 replays after a swap, only for message `end - 1`, with no cache break; and the real
  count lost its measurement after every human-turn request. The prefix hashes
  (`messagesHash`) keep the raw form. A record without per-message hashes compares the whole
  `[b, end)`:
  `[compaction] session <id>: history replayed at <b>, tail changed: recorded [<12hex>,...] current [<12hex>,...]`.
- A request with another prefix (a subagent's transcript) matches no swap and is untouched.
  Several threads per session are possible; records are keyed by prefix hash.
- **Claude Code's own compaction request keeps the conversation's prefix** and adds one
  instruction at the end (`compaction/harness-compaction.ts`). Measured on Claude Code 2.1.326
  against a local mock: system, tools, `max_tokens`, thinking and metadata equal the request
  before it. Auto compaction at a turn start sends the instruction as the whole last user message
  (a string), and `/compact` after a tool round sends it as a text block after the tool_results.
  Both start `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.` On that request the
  history pass replays the active swap (the model has worked from the swapped view, and the
  replay is a cache read) and decides nothing else: no new swap, no summary, no topic decision.
  The instruction never counts as a human turn start. Before this, bench E1 (threshold t3) swapped
  that request (messages 0..102), a swap no later request repeats. The request also carries the
  `fallback-credit-2026-06-01` beta, but so do other requests (4 of 13 in one bench run), so the
  beta is not the signal. A request with the beta and without the instruction logs
  `history pass: fallback-credit-2026-06-01 without Claude Code's compaction instruction`, so a
  changed instruction shows in the debug log.
- A summary that fails is recorded `failed` for its boundary and never retried there. A swap whose
  record did not reach disk is not sent (it could not be replayed after a restart).

### The swap policy (`compaction/swap-policy.ts`, `compaction.history.policy`)

A swap is one cache break. Bench case d on `0aed68ec` (Sonnet 5.5, 200K): the swap request wrote
60,897 tokens fresh and removed about 74K; Claude Code compacted on its own about 6 requests
later; the session cost +1.0% against no swap. So the swap paid less than its write. The break-even
in requests after the swap is

```
N* = [(writeRatio − readRatio)·(L + S) + haikuCost / p] / (readRatio·R)
```

with `L` the kept tail, `S` the summary message with the inline system messages it keeps, `R` the
removed tokens, `p` the main model's input price per token. `R` is what the request sends now (an
active swap already applied) less what it sends with the new summary swapped in, both built by
`applySwap`. It is never the original prefix less `S`: with a swap active the request no longer
sends that prefix. Measured on `8c6e053f`, that error put `R` at 109,629 to 614,046 tokens while
the request sent was about 160,000, and `nStar` fell to 2.3. Case d:
`(1.25 − 0.05)·60,897 / (0.05·74,000) ≈ 19.7` requests on Sonnet 5.5, about 40 on Fable 5.2
(cache read 0.025× input). Six requests were far short.

- `decideHistorySwap` is pure: every number is an argument, so the tests use the measured figures
  directly. `threshold` and `early` swap at `applyAt` and only log `nStar`. `cost`, in this order:
  holds below `precomputeAt`; swaps when the gap since the thread's previous request exceeds the
  cache TTL (a cold cache rewrites everything anyway, so the swap writes nothing extra); when the
  projection `ceil((0.83·limit − count) / growth)` is ≤ 1 (the forced point: the next request
  crosses Claude Code's point), decides the swap against Claude Code's compaction (below);
  otherwise holds when the swap leaves less room than `N*` (below), and swaps when the
  projection reaches `N*`. Without prices it never swaps on `N*`; without growth it holds until
  one of the other cases.
- **The room a swap leaves.** The swapped request is `count − R` tokens: the fixed prefix, `S` and
  `L`. `requestsAfterSwap = ceil((0.83·limit − (count − R)) / growth)` is when it reaches Claude
  Code's point again, and the next swap writes the cache again there. Before the forced point a
  swap with `requestsAfterSwap < N*` cannot pay back its write first, so it holds. Measured on
  `8c6e053f` (Claude Code 2.1.328, Sonnet 5.5, 1-hour writes, prompts growing about 12,700 tokens
  a request): forced swaps left 83,003 to 120,054 of 166,000 tokens, about 4 requests of room. 16
  swaps, 14 of them in 8 minutes of one turn, cost $8.82 against $5.84 for no compaction, all of
  the difference in cache writes.
- **At the forced point: the swap against Claude Code's compaction.** Holding there is not "no
  swap": Claude Code compacts, which also writes the cache and costs a main-model call. So the swap
  is made when `requestsAfterSwap ≥ requestsAfterCcCompact`, the requests a request of Claude
  Code's post-compaction size has before the point; equal room swaps. That size is measured on
  the compacted request: after Claude Code's compaction request, the first request on another
  thread with a user message, before the first assistant message, whose text block opens with
  `HARNESS_COMPACTED_START`
  (`[compaction] session <id>: Claude Code's compaction measured, the next request is <N> tokens`);
  with none measured yet, the forced swap is made. "The next request" is not enough: Claude Code
  2.1.329 sends its compaction request in advance, beside the main loop (`precomputed compact:
  started (main, 135 msgs, ~151921 tok, attempt 1, trigger estimate)` at autocompact `level=warn`,
  `ready` 23 s later), and compacts only when it must. Live on `cea773eb`, the main request sent
  2 ms beside it (167,105 tokens) was measured as the post-compaction size, so
  `requestsAfterCcCompact` read 0 and every forced decision swapped. The compacted request is
  recognisable: in 9 compactions of the `55f34661` session the summary opened block 2 of message 0
  at offset 0, and the message count dropped from 50 or 38 to 14. A reactive compaction lays it out
  differently: live on `61ea03db` (04:44:55Z), Claude Code first re-attached the files it had read
  as their own user message, and the summary was block 8 of 9 of message 1, at offset 0. A check
  of message 0 alone missed it, so one of four compactions in that run went unmeasured. A subagent
  request has no such
  block, and a main request sent beside the compaction request keeps the old thread. Measured on `55f34661`, where the room rule
  also held forced swaps: 52 holds, 0 swaps, and Claude Code compacted 9 times in 6 minutes, each
  first request after it writing 95,171 to 101,098 tokens; at 03:04:06 the swap would have left
  12 requests, Claude Code's compaction left 8. The decision line shows `requestsAfterSwap` and
  `requestsAfterCcCompact`.
- **A forced swap soon after a forced swap holds, while nothing is measured.** With no Claude Code
  compaction measured, the forced swap is made unless the session's previous swap was forced too
  and fewer than `nStar` requests have passed since (`lastForcedSwapGap` on the decision line).
  Then the swaps cannot pay, and the hold lets Claude Code compact once, so its size is measured.
  The gap is the outcome itself, so it corrects every error in `requestsAfterSwap`. The Opus 5.5
  bench trial on `4f33a968` (Claude Code never compacted) made six forced swaps 5, 6, 8, 7 and 11
  requests apart, each predicting about 10: the growth used was low at 04:25:17 (13K against
  20.6K) but high at 04:25:38 (17K against 6.7K), and the first request after a swap sat 6K to
  42K tokens above `count − R`, so `R`, converted at the session's characters per token, was also
  high. Cache writes cost $8.58 against $4.91 for no compaction. A growth estimate that follows
  recent requests fixes only part of that, and a fallback compaction size would be a guess:
  Claude Code's `postTokens` (37,264 in one run) is not the request size (117,321 in the same
  run). The gap counts only after a forced swap: a cost swap is made early, and the room it
  leaves says nothing about a swap at the compaction point. The Sonnet 5.5 XL trial keeps its 3
  swaps, 47, 29 and 44 requests apart: its forced swap followed a cost swap, and its last had a
  measured compaction.
- Read ratio and base price: the model's own Claude API connection (`claudeApiTurnPricing`, the
  meter's banded reader), `cachedRead / input`. Measured on the catalog: Sonnet 5.5 0.1/2, Opus 5.5
  0.2/4, Fable 5.2 0.2/8, Haiku 5.5 tiered with a cache-read rate per band. A name that is not
  `claude-*`, an estimate, or no published cache-read rate gives no ratios; nothing is guessed.
- Write ratio: no Claude connection publishes `cachedWrite`, so `cache-prices.ts` uses Anthropic's
  rule by TTL (5m 1.25×, 1h 2×), weighted by the newest `usage.cache_creation` split
  (`ephemeral_5m_input_tokens`, `ephemeral_1h_input_tokens`, kept by `mergeSseUsage`). A published
  `cachedWrite` replaces the 5m multiplier. The TTL is 1 h when that write held any 1-hour entry:
  the split does not say where the 1-hour entries sit, so a mixed write is cold only after 1 h. No
  logged run has shown a mixed write (0 among about 1,400 writes in the live and bench logs of
  2026-11-16 to 2026-11-20).
- Growth: the mean over the thread's last 6 measured counts; a drop (a swap, Claude Code's own
  compaction) restarts the window. Gap: from the thread's previous `mark` (send time).
- `haikuCost`: the ready summary record keeps the Haiku call's `inputTokens`/`outputTokens`, priced
  at the Haiku model's band. By decision time this money is already spent; the formula keeps it
  as specified.
- `CLAUDE_CODE_COMPACT_AT` = 0.83 of the effective limit, from the 159K–170K of 200K measured.

### The topic policy (`compaction/topic.ts`, `history.policy: "topic"`)

A swap at a topic change drops history the next task does not need, when it is cheapest: a human
turn start is a swap point, and after a gap longer than the cache TTL the cache is cold anyway.

- **Not a hook.** A `request` hook has a 5 s budget for its whole chain and returns closed actions,
  none of which replaces history (see "Why a request decorator"). The decision runs in the history
  module's request path: `compactAsync` awaits the decider, then runs the synchronous `compact`
  with the chosen summary. Every other policy goes straight to `compact`; its tests are unchanged.
- **When it asks.** Only at a human turn start, with at least `floorTokens` (default 30K) counted,
  and with a ready summary above the active swap. Without a summary the line is logged as a hold
  and no decider is called: "never drop history without a summary" makes every answer a hold, so
  a call would buy nothing. The first request above the floor of a session always logs that hold.
- **Summaries.** Under `topic`, summaries start at `min(precomputeAt·limit, floorTokens)`, so one
  starts at every human turn start above the floor (one Haiku call each, rolling forward).
- **`haiku`**: claudish's own system prompt; the summary and the recent turns (8,000 characters)
  as a first user block with a cache marker, then the new message; `output_config.format`
  `json_schema` `{topic: same|related|new, confidence, reason}`; `max_tokens` 256. Haiku 5.5 caches
  a prefix only from 512 tokens (claude-api skill, prompt-caching table), so the marker is placed
  after the summary, not on the short system prompt.
- **`embed`**: Ollama `/api/embed` at the Ollama provider's base URL. The highest cosine similarity
  of the message to the summary and to each recent turn; below `similarityBelow` is `new`.
  `confidence` is reported as 1. The default 0.5 is not measured on real sessions.
- **Failures hold.** A timeout, Ollama unreachable, or an answer off the schema is no verdict:
  `topic decision <decider>: unknown, …, action=hold, reason=no verdict: <cause>`.
- **Cost line.** The swap reason says `cold cache` when the gap since the thread's previous request
  exceeds the TTL from `cacheTtlMs` (the same rule as the `cost` policy), else `warm cache`.

**Who owns compaction.** With a summary applied, Claude Code's view of the input (from the
response `usage`) drops below its auto-compact threshold, so it does not compact. Its auto-compact
stays on as the safety net when no summary is ready. No Claude Code setting is changed. On a
native Claude route with no launch auto-compact window, the catalog window (possibly 1M) is larger
than the window Claude Code compacts at, so Claude Code may compact first; changing that would need
a launch-scoped `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, measured first.

## The key and its sinks

- Resolved once at startup with `credentials.resolveForUse("anthropic")` (environment, config,
  Keychain, then 1Password), which never writes `process.env`. `resolveAdvisorCredential` does
  write `process.env` from 1Password, so it is not used.
- Held only in the proxy's memory. The proxy runs in the launcher process and Claude Code is its
  only child, so the key never needs an environment variable, and nothing new is written to the
  child's env. The monitor branch still deletes an inherited `ANTHROPIC_API_KEY`.
- The proxy's `shutdown()` calls `CompactionRuntime.shutdown()`: the client aborts every call in
  flight (a background summary included; a cancelled call records nothing), waits for them, and
  then releases the lease below.
- Registered on a launch-wide signing lease (`acquireSigningLease`), so `log`, `logStderr`,
  `redactSecrets`, telemetry and `redactForClient` redact it by value. Upstream text the client
  logs passes `redactForClient` and `redactExactValues`.
- Requests go to the fixed `ANTHROPIC_MESSAGES_URL` with `x-api-key` and `anthropic-version`
  only. The inbound `authorization`, the inbound `x-api-key` and the Claude login are never read.
  The `system` prompt is claudish's own string; no Claude Code identity text is sent.
- A 429 "Error" shape (`isClaudeShapeRefusal`) or a 401 is a final failure. Three 401s in one
  launch switch compaction off, with one warning.
- Every call records a `StatsEvent` with `request_role: "compaction"`, provider `anthropic`, priced
  with `calculateCost`; no price is hardcoded.

## The model

The default is the tier alias `haiku`, resolved at startup like the advisor's defaulted collector
(`claudeAdvisorModelFor`): the catalog alias table, then the newest `claude-haiku-*` id. No model
id literal is in code. When the alias finds no id because no catalog has been fetched yet (a first
launch), startup waits for it with `ensureCatalogReady` (up to 5 s, `COMPACTION_CATALOG_WAIT_MS`)
and resolves again. A name that still does not resolve to a `claude-*` id turns compaction off,
with one warning.

## The store and retention

```
~/.claudish/compaction/                  0700
~/.claudish/compaction/<session_id>/     0700   (the only folder the Read rule allows)
  <key>.json  0600   one record: tool-output, history-summary or history-swap
  <key>.txt   0600   the original tool output, for Read
```

A record is never rewritten (`put`: first decision wins, disk first, then memory; a complete temp
file is hard-linked to its name, so of two proxies on one session the first on disk wins and the
other reads it back). A session folder
is deleted 7 days after its newest mtime (the folder's own or any file's), checked at startup; a
session the arguments name (`--resume <id>`, `-r <id>`, `--resume=<id>`, `--session-id <id>`, read
by `compactionSessionPlan`) or the resume picker chose is kept. Opening a session's records and the
launcher's folder setup set the folder's mtime to now (`touchSessionFolder`), so a resumed session
that only replays records does not expire. The folder's own mtime counts because the launcher creates the
folder before Claude Code starts, and it stays empty until the first large output: a rule on
files alone would let a second claudish starting at that moment delete a live session's folder.

The launcher passes `--allowedTools "Read(//<folder>/**)"` for the session's own folder only, so no
session can Read another's outputs. The session id is known before Claude Code starts
(`--session-id`, `--resume <uuid>`, or one claudish mints); with `--continue`, a bare `--resume` or
`--fork-session` alone, no rule is added and Read asks for permission.

Why not `--add-dir`, measured on Claude Code 2.1.326 against a mock Messages endpoint in a sandbox
HOME, the mock answering one Read of a file in the session folder:

| Launch | Result |
|---|---|
| `--add-dir <folder>`, interactive | stops at "Adding a new directory: … Is this a directory you created or one you trust? … Your answer holds for this session." (`No, exit` / `Yes, add it`) |
| no flag, `-p`, `--permission-mode default` | Read refused: "Claude requested permissions to read from … but you haven't granted it yet." |
| `--allowedTools "Read(//<folder>/**)"`, `-p` and interactive | no question, Read returns the file |
| the same, two rules (real and given spelling) after one `--allowedTools` | Read returns the file |
| claudish's rule first, the user's `--allowedTools "Bash(ls:*)"` later | Read returns the file |
| a rule for another session's folder | Read prompts |

The answer to the trust question holds for one session, so one stable folder per user would ask on
every launch too. Claude Code matches the real path, so the rule names the real spelling and, when it
differs (`/var` → `/private/var`), the given one. claudish never writes Claude Code's trust records.

## Out of scope, and why

- **A `replaceToolResult` hook action.** Hooks do not run in monitor sessions and carry a 5 s
  budget; the decorator has neither limit.
- **Server-side compaction (`compact-2026-09-04`).** Native-only, and Claude Code owns that
  request shape.
- **An injected "expand" tool.** `Read` on a recovery file works on every route without the proxy
  answering tool calls.
- Images, `is_error` results, the advisor's results; per-project config.
- **`claudish serve`.** `serve` builds no compaction runtime and passes none to its proxy, so its
  requests are never compacted, and it has no `--compaction` flag. When `CLAUDISH_COMPACTION` or
  `compaction.enabled` turns compaction on, `serve` prints one stderr warning saying so
  (`serveCompactionWarning`).
