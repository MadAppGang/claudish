> The hook system: one engine for the proxy and the pane session, closed actions, the unsafe raw
> tier and its containment, the response seam, cross-process injection, the settle hold, and the
> harness-convention supervisor it carries over (the 115-call plan-mode measurement, telemetry).
>
> Replaces `behavior-layer.md` (the Layer 4 behavior layer and the `MiddlewareManager`, both
> deleted). Indexed in [`README.md`](./README.md). The user guide is `docs/advanced/hooks.md`.

# Hooks (`hooks/`)

One hook system replaces two older mechanisms. The behavior layer (`behavior/`) ran user and
built-in rules at three points (`onRequest`, `onToolCall`, `onModelOutput`) with a closed set of four
actions. The `MiddlewareManager` (`middleware/`) was built-in only and carried one middleware, the
Gemini thought-signature one. Neither could change a response before Claude Code read it, and neither
could start a turn. Both are deleted. Their behaviour runs as built-in hooks with **unchanged ids**:
`plan-mode/plan-file-path`, `session-context/no-harness-echo`, `observer/divergence`,
`gemini/thought-signature`, and the synthetic `behavior/pending-correction` for queued notes.

The public contract is `hooks/public.ts`. It imports nothing from the rest of claudish, has no side
effects, and is built on its own into `dist/hooks.js` and `dist/hooks.d.ts` (`build:hooks`). Every
internal module takes its types from it.

## Why it is a SUPERVISOR, not a hint system

This rationale predates the hook system and is unchanged by it.

Claudish routes **arbitrary models, in arbitrary combinations**: a `team` run mixes vendors in one
session, and any of them may be swapped tomorrow. There is no capability floor to design against.
None of the following can be assumed of a model claudish is asked to drive:

- that it follows an instruction it was given many turns ago, under context pressure;
- that it invokes a skill, plugin or tool that is merely *available* to it;
- that it knows Claude Code's conventions at all, let alone the current release's;
- that it honours the user's own rules (CLAUDE.md, project conventions) rather than taking a shortcut;
- that a capability present in one model of a team is present in its siblings.

So conformance cannot be left to the model's judgement. The built-in hooks enforce from outside
rather than asking from inside.

**The motivating case.** Claude Code 2.1.220's `ExitPlanModeV2` takes **no** `plan` parameter. Its
advertised schema is `{allowedPrompts?}`, and its description says "This tool does NOT take the plan
content as a parameter - it will read the plan from the file you wrote". `normalizeToolInput` injects
`plan` from disk at the session's assigned path. So `ExitPlanMode({})` is **correct**, and the failure
is upstream. gpt-5.6-sol wrote a complete 12.9 KB plan under a filename it invented. Claude Code read
the assigned path, found nothing, and returned `plan: null`. That downgrades the approval dialog from
the rich form (`Yes, and bypass permissions` / `Yes, auto-accept edits` / `Yes, manually approve
edits`) to a bare "Exit plan mode?" yes/no. The rich dialog is the **only** surface that offers
permission elevation on exit, so the session always falls back to `prePlanMode ?? "default"`, which is
manual approval.

**The measurement** (115 recorded `ExitPlanMode` calls across 8 models): native Claude 87/87 carried
a plan, Kimi-via-claudish 4/4, gpt-5.6-sol 17/24 empty. The discriminator was exact. Sessions that
wrote to the assigned path got the rich dialog 7/7, and sessions that did not got the degraded one
17/17. Failures ran at about 1.75x the context (178K against 102K median input tokens). The plan-file
path was in the conversation the whole time, because Claude Code re-injects it every turn. The
information was present, the model stopped acting on it, and *which* model it was mattered more than
anything else. It is not a translation bug: the same model through the same proxy got the random slug
right in a shorter session.

The design rule that follows:

> **Put the fact where the decision is made, deterministically. Do not ask the model to go and get it.**

Hence `plan-mode/plan-file-path` rewrites the **`ExitPlanMode` tool description** rather than
re-stating the reminder. A tool description is re-read at the instant the model decides to call the
tool; a system reminder can sit 178K tokens away. Consequences for every built-in hook:

- Prefer **injecting content** over telling the model to fetch it. If a skill matters, inline what it
  says.
- Prefer **deterministic repair** over guidance whenever the correct value is knowable.
- Treat "the model was told" as **no evidence** of compliance. A hook is validated by outcome (did the
  plan file exist at the assigned path), never by whether the instruction was delivered.
- Assume **nothing transfers between models**. A hook proven on one model is a hypothesis on the
  next. That is why severity keys can be model-scoped (`gpt-5.6-*:plan-mode/plan-file-path`) and why
  the corpus is per model.
- Built-ins are scoped to **foreign models** (`routes: "foreign"`). Native Claude honours Claude
  Code's own mechanisms, so the built-ins stay off for it rather than compete with a harness that
  works. `RouteInfo.native` is `!forceForeignModel && (/^claude[-.]/i.test(modelId) || provider ===
  "anthropic")`, a naming rule and never a model list.

*Related reading, as one illustration of the same class from another team: Vercel's
[AGENTS.md outperforms Skills in our agent evals](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals)
found a skill went uninvoked in 56% of cases, with always-in-context docs scoring 100% against 53%
for skills. Single model, and a narrow eval targeting APIs absent from training data, so it is an
anecdote about one symptom, not a basis for this design.*

**Anchors live in `hooks/harness.ts` only.** `PLAN_MODE_HINT` is a cheap pre-test and **must stay a
superset of the anchors**: an earlier version omitted "create your plan at" and short-circuited a
valid anchor away. Never assume `~/.claude/plans`. Claude Code has a `planDir` setting, so the path is
always taken from the reminder. `extractAvailableSkills()` returns `[]` when no listing is present,
which means *unknown*, not "the user has no skills".

## Closed actions

Hooks **return** actions; the engine applies them. Nothing else mutates the request or the response,
which is what makes severity meaningful and every change attributable to a hook id.

- **Actions are a closed, per-event union of plain data** (`{type: "appendText", text}`), with
  `assertNever` over it. An open "run this callback" action would make effects unauditable and defeat
  severity. Plain data is also what lets `injectUserTurn` and `annotateTurn` cross a process boundary
  as JSON lines.
- **Severity is linter semantics**: `off` (not called), `warn` (called, journaled `warned`, not
  applied), `fix` (applied). Resolution is model-scoped key, then unscoped key; within each, exact id,
  then the longest glob, then the hook's default. `hook:` ids contain a colon and are deliberately
  *not* parsed as model-scoped. `resolveSeverity` is ported unchanged from the behavior layer.
- **Hooks run as a chain** (user decision 2026-10-14; `HookEngine.runChain`). A *dispatch* is one
  firing of one event: one attempt's `request`, one tool call's `toolCall`, one response's
  `responseRewrite` or `responseEnd`, one settle's `sessionIdle`. Its applicable hooks run one at a
  time in effective order (`order` bucket, built-ins before user hooks, `hooks.modules` order, export
  order). Each *step* builds a fresh shallow-frozen context from the dispatch's working state (the
  event's input plus every action earlier steps applied), calls the handler with its own step timeout
  and `AbortSignal`, then severity-gates the result and applies the step's fix actions, in the order
  returned, before the next hook is called. `ctx.prior` lists what earlier steps applied or handed
  on. Separate dispatches (two requests, two tool calls of one response, the tap's `responseEnd` and
  warn `responseRewrite`) stay independent.
- **Pattern.** Chain of Responsibility in its middleware form, for both tiers. No closed action can
  stop the chain, so by the catalog's "every handler must run" note it is a pipeline: a left fold the
  engine drives, not `next()` middleware, which would hand control flow to user code (a hook that
  never calls `next()` stalls the request, which fail-open forbids). Hooks keep returning plain data,
  and the engine owns the loop, the timeouts and the application between steps. The raw tier already
  had this shape. *Cost:* order is significant and invisible at the call site (`claudish hooks list`
  prints it, every step journals its hook id, `ctx.prior` shows earlier steps), and latency is the
  sum of the steps. *Rejected:* the concurrent fan-out it replaced ("closed handlers cannot see each
  other's results"), because hooks could not build on, or avoid repeating, what another hook did.
- **Working state per event.** `request`: `systemText`, `messages` and `tools` change between steps;
  `harness` is detected ONCE from the request as Claude Code sent it (recomputing it walks ~180K
  tokens, and would let one hook's text edit flip another's plan-mode facts). Description actions are
  an overlay: `ctx.request.tools` shows the description stage B will set, but the Claude-format tools
  `convertTools` summarises stay unedited, and stage B replays the actions in chain order on both
  representations. `toolCall`: `ctx.tool.args` is the working args; `rawArgs` is always the model's.
  `responseRewrite`: the held blocks after earlier text actions. `responseEnd`, `sessionStart`,
  `sessionIdle`: only `prior` changes. Step 0 of `request` is the pending notes.
- **No first-wins.** Every action applies over the result of every action before it, earlier
  actions of the same hook and all actions of earlier steps. Two schemas, two description actions or
  two argument repairs both apply; the second sees the first. `superseded` remains only for a
  duplicate system note or appended user text, an action on a tool an earlier step removed
  (`tool_removed`), a second removal (`already_removed`), and a description action on a tool a later
  step removed. A step's application is atomic: the applier returns a new working state, so a throw
  (a claudish bug) leaves it intact and journals the step's actions `error: apply_failed:…`.
- **Event budgets.** Per-hook timeouts now add up, so each event has a budget for its whole chain,
  equal to its per-hook maximum: `request` 5 s, `toolCall` 5 s per call, `responseRewrite` 10 s,
  `responseEnd` and the session events 30 s, `sessionEnd` 1.5 s, raw `providerRequest` and
  `providerStreamEnd` 5 s; raw `providerChunk` (synchronous) and raw `response` (per-step call and
  close deadlines) have none. A step's timeout is the smaller of its own and the budget left; with
  none left the hook is journaled `skipped` (local only). A timeout the budget caused is journaled
  `timeout` with detail `event_budget`, and neither counts toward the breaker: a slow hook A must not
  disable a healthy hook B. "The budget caused it" means the step was clipped by MORE than
  `clipMarginMs(own)` = min(50 % of own, max(250 ms, 10 % of own)) (`stepTimeout`, shared by
  the raw tier). The 50 % cap keeps a short hook (own ≤ 250 ms) from being blamed for a clip a
  slow earlier hook caused. A smaller clip counts as the hook's own timeout: exempting any clip at all let a hook
  hanging at its own maximum escape the breaker forever once any step ran before it — the
  `request` built-ins always do. With the budget equal to the per-hook maximum, no worst case grew; the
  *dispatch bound* `min(budget, Σ step timeouts)` replaces "the largest timeout" in the inbox wait,
  the hold watchdog and the `sessionStart` term (`dispatchBoundMs`).
- **Fail open, always.** A throw, a rejection, a timeout or an invalid return is journaled and treated
  as "no actions"; the next step sees what the failed one saw. There is no fail-closed option: a throwing hook must never break a request or a
  session. A circuit breaker disables a hook for the process after 5 consecutive failures. Invalid
  individual actions do not count toward it; a non-array return does.
- **Typos are errors, not no-ops.** The loader rejects unknown `on.*` or `raw.*` keys
  (`on.onRequest is not a hook event`), and a text action with `flags` but no `regex: true` is
  `invalid` (`flags_without_regex`). Both catch a mistake that would otherwise read as "the hook did
  nothing".

## Process topology

Hooks load once per process (`loadHooksOnce()`, a memoised promise that never rejects). **Module
state is per process**, and the events of one session can span two processes:

| Launch | Proxy events | Session events | Sink for proxy-event injections |
|---|---|---|---|
| interactive launcher, `wrap` (claudish starts a visible magmux) | the CLI process | same process, `InteractiveDriver` on the wrap socket | in memory (`InProcessSink`) |
| interactive launcher, `ambient` (already in a magmux pane) | the CLI process | same process, on `MAGMUX_SOCK`, pane found by `findOwnPane` | in memory |
| interactive launcher, no surface (`no-tty`, `no-magmux`, `-p`) | the CLI process | `sessionStart` at spawn, `sessionEnd` at exit only | dropped `unavailable` |
| `create_session` child | the pane child | the MCP server (`PaneSession` owner) | the inbox file |
| `team` slot or judge (MCP or CLI) | the pane child | the MCP server or the CLI `team` process | the inbox file |
| `serve`, the MCP server's own proxy | that process | none | dropped `unavailable` |
| `--probe` | none (`hooks: false`) | none | — |

A pane child's `magmuxPaneCapability()` answers `{kind: "none", reason: "pane-child"}` before its
ambient branch, so a child never creates a driver even though its pane exports `MAGMUX_SOCK`. Each
session has exactly one session-event host.

**The inbox.** Two actions cross from a pane child's proxy to its owner: `injectUserTurn` and
`annotateTurn`, both returned from `responseEnd`. The owner creates `hook-inbox.jsonl` (0600,
exclusive create after removing a stale file; a team slot's is `work/<slot>.hook-inbox.jsonl`) for
**every** child and passes its path in `CLAUDISH_HOOK_INBOX`, with `CLAUDISH_HOOK_SESSION`
(`{"kind","id","role"}`). Both are pane marker variables: they survive the child's environment
rebuild and are deleted from Claude Code's own environment, so the model's Bash tool never sees the
path. Every child gets them, because a long-lived owner and a freshly spawned child can load different
hook sets after a config edit. If the file cannot be created the child has no inbox, which costs its
injections, never the session.

- **Ordering by construction.** The seam's observe tap appends `{"kind":"stop"}` synchronously
  **before** it enqueues the chunk carrying `message_stop`. Claude Code writes a turn's
  `turn_duration` only after reading the final `message_stop`, so `stop` is on disk before the owner
  can settle the turn. Payload lines follow, and `end` is appended in a `finally` (`aborted: true` on a
  stream error or a client cancel). A client cancel or an upstream read error **after**
  `message_stop` went out writes no `end` of its own: the `responseEnd` dispatch is still running and
  owns it. Writing `end aborted` there
  told the owner to stop waiting, and the hook's lines landed after the drain. The warn-mode
  `responseRewrite` and `responseEnd` are separate dispatches and run independently, so nothing is
  awaited ahead of `responseEnd` and the owner's bound below covers the `end` line. Run in sequence,
  a 9 s warn rewrite and a 29 s `responseEnd` outran the 30.5 s bound although each was inside its
  own timeout.
- **The owner waits only for what it must.** At settle it reads up to the file's length, then waits
  only for requests that have a `stop` and no `end`, i.e. whose `responseEnd` hooks are still running.
  While it waits it keeps reading past that length, because those requests' lines can only appear
  there. A request with no `stop` is still streaming (a background subagent, a side request) and is
  not waited for; its lines go to the next settle. The wait is bounded by the `responseEnd` dispatch
  bound (never below the default timeout) plus 500 ms — 5.5 s with one default hook, 30.5 s at most —
  and aborts when the pane exits or the session ends. A request still running at
  the bound records `hook_inbox_wait_timeout` (and a `timeout` journal line); its later lines go to
  the next settle. When there is none (the last turn of a one-shot chain), the owner **sweeps** the
  inbox at reap (`SessionHookBinding.sweepInbox`, also called by the launcher before its proxy shuts
  down) and journals every payload line no settle took as dropped `session_ended`.
- **The owner trusts no line.** The inbox is a same-user file, so a line in it is no proof a hook
  wrote it. The owner applies the child's action rules again at read (`validateAction`: no leading
  `/`, the 100,000-character limit, annotation key and value limits) and drops a failing line
  `invalid`. Independently, hook text never takes the command or control path: a pane's and the
  driver's `canDeliver` refuse a leading `/`. And `sinkFromEnv` honours `CLAUDISH_HOOK_INBOX` only in
  a pane child (`CLAUDISH_PANE_CHILD=1`). Both are control variables (see "Loading and authoring"):
  no env file in the cwd can set either, so a repository cannot point claudish at an inbox.
- **Partial lines are bytes.** The reader keeps an incomplete last line undecoded and cuts only at
  `0x0A`, which never occurs inside a multi-byte UTF-8 sequence. Decoding each read on its own turned
  a character split across two reads into two U+FFFD.
- **Cap.** 1 MiB of `inject` and `annotate` payload per inbox; `stop` and `end` do not count, so a long
  tool loop never reaches it by bookkeeping. Past it, one `capped` line and the anomaly
  `hook_injection_dropped:inbox_cap`. The owner deletes the file at reap.
- **Why a file**, not a socket or the child typing into its own pane. The child can reach its pane
  through `MAGMUX_SOCK`, but the owner's `PaneSession` is the pane's sole driver (turn offsets, the
  admission witness, settle). An unaccounted send would read as a background re-wake of the settled
  turn. A socket adds a server lifecycle to every child for one message per turn. The file is
  crash-safe, owner-scoped, already the pattern for child-to-owner data (`CLAUDISH_TOKEN_FILE`,
  `CLAUDISH_UPSTREAM_ERROR_LOG`), and its ordering guarantee is one synchronous append.
- **An owner without hooks.** At reap, an owner with no session binding checks the inbox once. An
  `inject` or `annotate` line there means the child loaded hooks the owner did not. It journals
  `hook_injection_dropped:owner_without_hooks` and prints one stderr line per process telling the user
  to restart the MCP server.

In the launcher the same `InjectionSink` interface is in memory: `stop` increments an in-flight count
at the same point, `end` decrements it, and the driver's settle waits for zero under the same bound.

`ctx.session` on proxy events comes from `CLAUDISH_HOOK_SESSION`, so it is set in pane children and
`null` in the launcher and in `serve`. A hook excludes team judges with `ctx.session?.role ===
"judge"`.

`hooks/session/cross-process.integration.test.ts` runs a real pane child against a stub upstream and
asserts an annotation reaches `ctx.turn.annotations` in the owner.

## The proxy pipeline

### Request stage, in two halves

Each terminal handler runs the stage on the request it already owns. The `request` hook chain runs
**once** per upstream attempt; its actions apply at two points.

- **Stage A, before conversion, at each step**: `injectSystemNote` (pending notes as step 0), the
  message actions, `replaceToolSchema`, `removeTool`, applied to the chain's working state after the
  hook that returned them, in array order, before the next hook runs; the final state becomes the
  attempt's request. In `ComposedHandler` it runs right after
  `transformOpenAIToClaude`, which deep-copies its input, so each routing-chain attempt starts from a
  fresh request and no action leaks into the next attempt.
- **Stage B, after conversion**: `rewriteToolDescription` and `replaceToolDescription`, replayed in
  chain order, each over the description the earlier ones produced, on the Claude-format tools
  **and** the converted ones, after `convertTools` and the tool-count cap. The provider copy gets the
  summarised description followed by every append; a replace resets both copies.
  This is why plan mode survives `--summarize-tools`: `summarizeToolDescription` keeps only the first
  sentence, capped at 150 characters, and the append lands after it. Stage B replaces array elements
  rather than mutating tool objects, so `NativeHandler`'s copy-on-write view of the payload holds.
- **Native requests** run both stages at the top of `handle()` on a copy-on-write view: `system`,
  `messages` and `tools` replaced, never mutated, because the payload object is shared with
  `withAdvisor`.
- **The order changed on purpose.** The old middleware step ran before the behavior step. Raw
  `providerRequest` now runs **after** stage B, so a raw hook sees the request the closed actions
  produced. That changed nothing for the only old middleware: Gemini's `beforeRequest` edits
  `messages[].reasoning_details`, and stage B edits only tool descriptions.

**System notes now reach chat-completions routes.** The old behavior layer appended its note to
`claudeRequest.system` after `convertMessagesToOpenAI` had already copied the system prompt into
`messages[0]`, and those adapters' `buildPayload` reads only `messages`. On OpenRouter and OpenAI chat
the session-context note and every pending correction were silently dropped. Stage A applies them
before conversion, so they reach every route. It shifted those routes' prompt-cache prefix once.
`handlers/composed-handler-hooks.test.ts` asserts the note is inside the built payload's system
message.

**Pending notes are peeked, then consumed on commit.** An `injectSystemNote` from `responseEnd` is
stored per Claude Code session id (64 sessions, oldest evicted) and applied to that session's next
request. It is removed only when a request carrying it gets a 2xx response. The old code drained it on
read, which lost the correction whenever the routing chain's first attempt failed. The cost: concurrent
requests of one session that start before either commits each carry the note. The notes are step 0
of the request chain (hook id `behavior/pending-correction`), so every request hook sees them in
`systemText` and `ctx.prior`; their paragraph precedes the hooks' notes, and a hook returning the
same text is the `superseded` copy.

**The session id is nested JSON.** Claude Code sends it inside `metadata.user_id`, which is itself a
JSON *string*:

```
metadata.user_id = '{"device_id":"073c…","account_uuid":"","session_id":"ce7d…"}'
```

`extractSessionId()` returns only `session_id`. **`device_id` is a stable machine identifier and
must never be journaled or uploaded.**

### The response seam

`withHooks(handler)` wraps the **resolved** handler at the `/v1/messages` call site:
`withAdvisor(withHooks(await getHandlerForRequest(model)))`. It is never applied inside
`getHandlerForRequest` or to a routing-chain candidate, so the `instanceof ComposedHandler` checks in
`fallback-handler.ts` and the `instanceof NativeHandler` check in count_tokens keep working. It sits
inside the advisor, so the advisor's tee scans what the client receives, and it forwards `shutdown()`,
which `AdvisorSwapHandler` calls on whatever it wraps. Every parser's output converges here as Claude
SSE, so **one seam covers every route**, Ollama and native included.

Three stages in a fixed order, each present only when an applicable hook needs it:

1. **Closed transform**, one mode per request: `none`; `intercept` (a `fix` `toolCall` hook applies
   to the request and its `armed()` returned true: only that tool's block is held until
   `content_block_stop`, then re-emitted as one delta; no index changes); or `buffer` (a `fix`
   `responseRewrite` hook claimed the request).
2. **Raw `response` hooks.**
3. **Observe tap**: a synchronous pass-through that parses chunks and enqueues them unchanged. It
   writes the inbox `stop`, and `responseEnd`, observe-mode and warn-mode consumers read its parsed
   events. Because it is last, every consumer sees exactly what Claude Code received.

When no stage is needed the seam returns **the same `Response` object**, so an unclaimed request
streams byte for byte as before. The debug log prints `[hooks] seam mode=<none|intercept|buffer>
raw=<n> tap=<0|1>` per request.

**`buffer` holds from the first non-thinking block.** `message_start` and leading
`thinking`/`redacted_thinking` blocks stream live. From the first `content_block_start` of any other
type (text, `tool_use`, server tool, unknown) everything but `ping` is held until `message_delta`.
Starting at the first *text* block was rejected: `prependText` on a tool-only response would then
have no held position to insert at. The cost is that tool input in a claimed response is delivered at
`message_delta`. Claude Code runs a tool only once its block is complete, so only the live display
changes, and only for requests a rewriting hook claimed.

**Re-indexing.** Once a block is inserted (an append or prepend with no text block to extend) or
dropped (a text block left empty, which is a 400 on Anthropic-compatible endpoints when replayed),
every later `content_block_*` event is re-serialised with its new index. Every other field,
`signature` and `partial_json` included, is carried unchanged, and the emitted indices are `0…n` with
no gap or repeat. A rewritten text block is emitted in `text_delta`s of at most 1,024 UTF-16 code
units, never splitting a surrogate pair. A text block carrying a non-`text_delta` delta (citations) is
excluded from rewriting.

**Safety rules.** One streaming `TextDecoder` and a blank-line event splitter, so a rewrite never
splits a multi-byte character that arrived split across network chunks; unparseable events pass
through raw. The splitter visits each `\n` once and slices its buffer once per chunk. Searching both
terminators over the whole remainder once per event was quadratic in one chunk's size: 5.5 s of
blocked event loop for an 8 MB chunk of 40,000 deltas (what a raw replacement built with
`new Response(text)` delivers), measured on Bun 1.4.0. `sse-codec.test.ts` bounds it, and checks
every split position of mixed LF and CRLF terminators. Pings are forwarded out of order with held events, and the seam emits its own once a
second while it holds content with no upstream ping. More than 8 MiB held → flush unchanged, stop
holding, journal `invalid: buffer_cap`. An upstream `event: error` while holding flushes, then
forwards the error. A throw inside the seam flushes and passes the rest through. An upstream read
error flushes and only then errors the stream: **`controller.error()` discards chunks already
queued** (measured; the first test run lost the flushed events), so the error is deferred until the
client has drained them.

**Tool-argument repair moved from five parsers to the seam.** Repair used to be wired into
`openai-sse`, `openai-responses-sse`, `anthropic-sse`, `gemini-sse` and `devin-connect`, five shapes,
and `onToolCall` had to be synchronous because the parsers consumed its return inline. At the seam a
tool block is already a Claude `tool_use` with `input_json_delta` fragments, so one implementation
covers every route, `toolCall` handlers may be async, and the observer no longer forces its
`watchTools` to buffer. Parity was proven against goldens captured from the old parsers before they
were deleted (`parser-goldens.test.ts`): all 15 parser goldens are byte-identical after
normalisation. One golden is marked `defect`: the old `anthropic-sse` interceptor emitted
`event: content_block_stop\nevent: content_block_delta\ndata: <delta>\n\ndata: <stop>`, which made
the stop an unnamed SSE event, so a client dispatching on event names never closed the repaired block.
It affected plan-mode repair on MiniMax, Kimi direct and Z.AI. The seam frames it correctly, and that
golden is compared by `data:` payloads. `openai-sse` still buffers tool calls whenever the request
carries tool schemas; that is schema validation, not a hook concern. `onToolCallObserved` stays in
every parser: it is the token tracker's tool count.

## The raw tier and its containment

`unsafe: true` plus `raw` hands a hook provider-format objects. A user raw hook prints
`[claudish] hook <id> is UNSAFE (raw middleware): …` at load, and every request it touches writes one
journal line (`decision: "raw"`, stages listed) and a debug-log line. Built-in raw hooks journal the
same way and print nothing at load. All raw rows are local-only.

The requirement was that a raw hook's failure is contained like any other hook's. The first designs
were not:

- a `structuredClone` snapshot taken **at the timeout** kept every mutation made before the timeout or
  before a throw, and the provider payload is built from those objects immediately afterwards, so a
  hook that emptied `messages` and then threw sent an invalid request;
- committing a `providerChunk` clone on a synchronous return applied the mutations of an `async`
  function whose body threw after mutating, because an `async` function returns a promise either way;
- copying a committed clone's properties onto the live chunk left the values the parser had already
  derived (`delta`, `finishReason` in `openai-sse`) pointing at the uncommitted originals, and a
  property copy cannot express a deletion;
- giving a `response` hook one `tee()` branch and keeping the other as the fallback stalled the
  original under backpressure when the hook ignored its branch, and a never-closing replacement then
  waited for an end that never came.

So containment is **transactional**:

| Stage | Where it runs | Containment |
|---|---|---|
| `providerRequest` | `ComposedHandler` only, after stage B, before `buildPayload` | Clones of `claudeRequest`, `messages`, `tools`. Committed only when the call returns or resolves within its timeout; otherwise discarded, and the pipeline continues from the objects as they were. |
| `providerChunk` | `openai-sse` and `openai-responses-sse`, through `RawStreamTap.chunk()` | **Synchronous.** A clone per chunk, committed **by identity**: `chunk()` returns it and the parser assigns it before deriving anything (`openai-sse` moved its tap ahead of `delta` and `finish_reason`; `openai-responses-sse` reassigns `event`). A thenable return discards the clone, journals `invalid` (`async_return`), counts toward the breaker, and gets a rejection handler. A declared `async` function is rejected at load, since it could never commit. |
| `providerStreamEnd` | `openai-sse`, `openai-responses-sse`, `gemini-sse` | Bounded; it sees only its own `metadata` map, so there is nothing to undo. |
| `response` | the seam, every route | A `ResponseRecorder` drains the stage's input at upstream speed whatever the hook does. The hook reads a replay **of copies** (`replay({copy: true})`, each `new Uint8Array(chunk)`: a Node `Buffer`, which an earlier raw hook may return, has a `slice` that is a view, so `chunk.slice()` copied nothing for one); the fallback is a second replay of the retained bytes. Sharing them let a hook that edited a chunk in place and then threw corrupt the original it fell back to, and let a `warn` hook change forwarded bytes. A replacement is read whole and forwarded only if it closes cleanly within the hook's timeout after the **later** of the call's return and the recorder's end; otherwise the original goes from its first byte. 8 MiB recorded plus held → the original. The view ends when the call returns, except that a `warn` replacement is read against it to its end before it detaches, since a replacement can stream `ctx.response`. |

At `warn` a raw hook runs on clones that are never committed, and a replacement is read and
discarded. That is how the Gemini built-in at `warn` computes and journals signatures without sending
them. Containment isolates failure; it does not validate what a hook deliberately produces. A hook
that returns normally after emptying `messages` is applied as written, which is what `unsafe` means.

`handlers/composed-handler-raw.test.ts` holds one test per failure mode above (X-1 to X-8), each with a
control, plus the in-place edit and the `warn` replacement built from the view.

**The Gemini built-in** (`gemini/thought-signature`, `order: "pre"`) is selected from catalog data
when the handler has a catalog connection: a Gemini-API wire, or a model whose catalog vendor is
`google` behind a gateway, whatever its (possibly opaque) id. This is `BuiltinHook.selectByUpstream`
over the internal `UpstreamFacts` that `ComposedHandler` passes in the applicability scope; they never
reach a hook context. Without a connection (custom endpoints, dynamic subscriptions) its `models`
globs decide: names containing `gemini` or `google/`. It keeps a cache keyed `"<provider>\0<modelId>"`, which reproduces the old per-handler
scope. The old middleware's `afterResponse` had no production caller and was deleted, not migrated.
`statsNames()` reports the `statsName` of the built-in raw hooks active for a model, so the OTLP
`middleware_names` attribute is unchanged and user hooks never appear in it.

## Hook output, and the MCP protocol stream

Every module import and handler call runs inside an `AsyncLocalStorage` scope
(`hooks/output-capture.ts`). Inside it, `console.*` and `process.stdout`/`stderr.write` go to the
debug log as `[hook <id>]`. Claudish's own writes are untouched.

Two measurements on Bun 1.4.0 shaped this:

- **ALS does not reach a module's top-level code.** `AsyncLocalStorage.run(store, () => import(url))`
  does not cover the module's top level or timers it schedules at import, and stack attribution fails
  too (JSC tail calls drop the callback frame). So imports, which are serial, run in an **import
  window**: unscoped writes during it are attributed to the module, and timers registered in it are
  bound to the module's scope. The cost: claudish's own writes in that short window also go to the
  debug log.
- **Code that replaces a writer later dropped the capture for good** when `install()` ran once per
  process. It now runs on every scope entry and re-wraps any writer that is not its own.

The scope is for attribution only, **never for protocol safety**, because a callback it does not
reach (a listener registered at import and fired later by claudish's own I/O) runs unscoped. In the
MCP server stdout is the JSON-RPC channel, so `isolateProtocolStdout()` is the first statement of the
MCP entry: through `bun:ffi` it calls `dup(1)` for a private descriptor and `dup2(2, 1)`, so
descriptor 1 is stderr from then on. `StdioServerTransport` writes through a `Writable` on the private
descriptor, with backpressure from a Bun `FileSink`. Measured: **Bun's `console.log` does not go
through `process.stdout.write`**, so replacing that function alone would not have closed the leak.
After the `dup2`, native `console.log`, `process.stdout.write`, `fs.writeSync(1)`,
`Bun.write(Bun.stdout)` and an inheriting child all reached stderr, only the protocol writer reached
stdout, and a 4 MiB frame written into a pipe first read after 1 s arrived whole. Where the libc
symbols cannot be bound, the MCP server loads **no user module** and says so. `hooks/mcp-isolation.test.ts`
is the check, with a positive control.

## The session pipeline: the settle hold

`responseEnd` means one upstream response finished; a Claude Code turn is many responses in a tool
loop, plus side requests. `sessionIdle` means the transcript oracle settled the turn
([`pane-session.md`](pane-session.md)). Only `sessionIdle` means "the session is about to wait".

**Record, then conclude.** A settled turn is **recorded** first: its answer is published to the owner
at once through `onTurnRecorded` (the channel's `recordAnswer`, the team's response file). Then the
pane sits in an internal phase **`SETTLING`** (wire `RUNNING`, activity `hook`) while the binding
drains the inbox and runs `sessionIdle`, and only then is the turn **concluded** (the owner's
`decide()`). Publishing first is what makes every terminal path safe: a timeout, cancel, pane exit,
lost pane or abandoned injection during the hold cannot lose a settled answer. Before this split,
`onTerminal` recovered `turnAnswer(turnsCompleted + 1)`, which after recording names the next turn
and returns `""`.

**Why a phase and not a boolean.** The hold changes what the ticker evaluates, what a pane exit does
and which events are legal. A flag would have to be consulted in `evaluate()`, the exit path and the
pump, and an earlier draft's defect was exactly a flag nobody checked. `SETTLING` is a row of the
transition table in `pane/slot-state.ts`, and `wireState`, `evaluate()` and `phaseActivity()` are
exhaustive over it. Every way out of it is a table edge, and every edge aborts the hold with a reason
that decides what happens to inbox items already drained:

| Reason | Drained proxy items and annotations |
|---|---|
| `rewake` (a background task woke the settled turn) | kept and offered at the next settle of the same turn, because they describe responses that happened |
| `caller` (input queued during the hold) | dropped `stale`; the hold ends in the step that queues the input, so the caller never waits for hooks |
| `watchdog`, `error` | dropped, detail `hold_ended` |
| `exit`, `terminal` | dropped, detail `session_ended` |

**The watchdog** (`holdBoundMs()`, read when the hold starts) is the sum of the bounds of the stages
`settle()` awaits in turn: what remains of a running `sessionStart` dispatch's bound, the inbox wait,
the `sessionIdle` dispatch bound, and 1,000 ms (a dispatch bound is `min(event budget, Σ step
timeouts)`). The `sessionStart` term exists because a
fast first answer could otherwise settle while its `sessionStart` injection was still being computed,
and a one-shot session would end before it arrived.

**The result is applied only on current evidence.** `settle()` resolves in its own step, up to a
frame-debounce (250 ms) or a backstop (1 s) after the last tick read the transcript. `completeHold`
therefore polls the transcript itself first: a re-wake written since ends the hold `rewake` exactly
as a tick would have, and the returned result goes back to the binding (`abandon(result, reason)`),
which carries its proxy items and annotations and drops its `sessionIdle` items `rewake`. Then the
injection is admitted only when the screen shows the session idle (box drawn and empty, no menu, no
dialog, no working row) — the screen half of the driver's gate, without its 1,500 ms stability term,
which exists for a human typing. A background re-wake shows its working row before its first
transcript record, so until both read idle the result waits in `SETTLING` (`heldResult`) and every
tick re-checks it. A tick's view is only as fresh as its debounced poll, so when the screen turns idle
the transcript is read once more, forced, before anything is typed: a re-wake whose records landed in
the same instant the working row cleared ends the hold there (a pane-hooks row reproduces it with the
poll debounce widened, so the clearing frame is guaranteed a stale view; magmux coalesces frames
closer than about 200 ms, so a fake child cannot land one inside the default 250 ms debounce on
purpose). Every exit from `SETTLING` hands a waiting result back under its reason. After the
admission bound with the screen still busy and no transcript evidence, the result is abandoned as the
watchdog's would be and the turn concludes. A hook item queued outside a hold (a `sessionStart`
injection) passes the same check before `pump()` admits it from `IDLE`. Before this, `completeHold`
went `hold_inject` → `IDLE` → admission on the phase alone, and `startAdmission`'s own poll marked the
new turn's offset after the re-wake's records, so the re-woken answer was lost and the hook text
typed into the running turn.

**An interactive turn is judged before a hook follows it.** On an interactive session the held turn
is concluded (`decide()`) before the injection is admitted: an API error fails the session there
(the injection is dropped `session_ended`), and an unread caller task file is reported
`prompt_not_read`. `continue` goes to `IDLE` and the injection is admitted in the same step, so the
wire never shows the gap. A one-shot chain still takes its verdict once, at the end. An injected
admission that fails with a turn still held concludes it on any shape (a `send_input` during the
admission converts a one-shot).

**Three exit races, each with its own branch.** A magmux exit during the hold concludes the recorded
chain (`onMagmuxExit` has a `SETTLING` branch) instead of failing it `pane_lost`. A hold that ends in
the up-to-1 s exit-capture window checks `paneExited` first and types nothing into a dead pane. A pane
exit during a hook item's admission routes to `hook_admit_abandoned`, not `child_exited`.

**The injection queue** (`hooks/injection/queue.ts`) is a pure policy over two item kinds. Caller
items always go first and are the only kind that may press Esc on a dialog. Hook items are delivered
only in `IDLE`. A hook item is stale once a caller turn is **admitted** after it was queued; staleness
counts caller admissions, not time, so a `sessionStart` injection survives the initial prompt. All
hook items of one idle merge into one turn. The merged text is checked against the prompt-delivery
rules **before** admission, so one that cannot be delivered is dropped `delivery_unavailable` and
never retried. The cap is `hooks.injection.maxConsecutive` (default 3), reset by a caller admission.

**One-shot sessions become chains.** A team slot or one-shot `create_session` is terminal at its
verdict, so an injection can only extend it *before* the verdict: the hold runs before `decide()`.
The verdict is taken once, at the end, on the joined chain answer, with the **chain head's**
prompt-read result (`SettledTurn.chainDelivery`), since each admission replaces the current delivery.
`require_pattern` passes when it matches the joined answer or any single turn's, so a `^`-anchored
pattern still matches a turn that starts with it. An unread hook-turn file records
`hook_injection_not_read`, never the caller-facing `prompt_not_read`. `timeout_seconds` spans the
chain. The cost, stated plainly: an injecting hook changes what a slot's answer is. That is opt-in by
loading such a hook, and capped.

Every hold behaviour has one hermetic test: H-1 to H-34 in `pane/pane-hooks.integration.test.ts`, on
a real magmux with the fake child, and H-35 and H-36 in `hooks/session/binding.test.ts`.

## The interactive driver

`InteractiveDriver` (`hooks/session/interactive-driver.ts`) runs in the launcher when a loaded hook
declares `responseEnd` or a session event.

- **Surface.** The magmux wrap gains a second reason: it is planned when
  `capability.kind === "wrap" && (recoverySurfaceAllowed() || sessionHooksNeedDriver)`. The recovery
  UI and the retry watchdog stay gated on `recoverySurfaceAllowed()` alone, so `--no-recovery` keeps
  its promise for the response even when a hook needs the pane (`interactive-launch.ts`, with tests).
  In `ambient` mode the pane is found by `findOwnPane` (process ancestry against `list`), moved to
  `pane/own-pane.ts` and shared with the recovery UI.
- **Session id.** claudish mints `--session-id` and an `--add-dir` turn directory, unless the user
  passed `--session-id`, `--resume`/`-r`, `--continue`/`-c` or `--fork-session`. Then the driver
  learns the id from the first main-chain proxy request. The driver retargets to any new session id a
  request carries (after `/clear`), whose transcript exists under the launcher's cwd. Known limit, not
  measured live: a nested `claude` started from the session's Bash tool in the same cwd inherits
  `ANTHROPIC_BASE_URL`, so its requests would retarget the driver.
- **Turns.** The first turn opens at **offset 0** of the minted transcript with a `{kind: "human"}`
  witness, so a prompt passed on the command line is witnessed even when Claude Code writes it before
  boot-ready. The human witness is matched by **provenance**: a main-chain `user` record, not
  `isMeta`, no `tool_result`, not a task notification, local command, interrupt marker or compact
  summary, and `origin.kind === "human"` when `origin` is present. Background task notifications are
  non-meta user records with plain content (`origin.kind: "task-notification"`), so a shape-only match
  would have read every notification as a human prompt, reset the cap and staled pending injections.
- **The latch is structural.** The next human turn opens at **record**, in the settling step. A human
  prompt during the hold is then that turn's witness and ends the hold `caller`. A re-wake is detected
  on the open turn and re-reads the settled turn (`rewindTo`), which keeps it the same turn. The
  hold's result and every gate check poll the transcript **at that moment** (`completeHold`,
  `openTurnIdleNow`), and `deliver` takes its turn boundary from that same read: a prompt or re-wake
  written after the last tick moves the phase and the item waits, rather than being read and then
  overwritten by the injection's witness.
- **Delivery gate.** IDLE, booted, the box drawn and empty with no menu or dialog, not working, the box
  unchanged for 1,500 ms, no recovery overlay lease held. One `send {typed, enter}` of a plain line,
  or a turn file in the `--add-dir` directory. Never Esc. The text witness must appear within 30 s,
  else `send_not_accepted`. A **lost reply** (`client_timeout`, `client_lost`) is not a refusal:
  as in a pane's `typeLine`, the driver waits a frame, presses Enter when the line sits in the box,
  and otherwise accepts it when its echo or witness is there. `client_lost` means the connection
  closed and its client delivers nothing more, so the screen is judged and Enter sent through the
  client `reconnect()` brought up (waiting up to 10 s), after a frame it delivered, only while the
  same admission is pending, and Enter counts only on its own `ok` reply (one retry), else on the
  witness or echo. Sending it through the closed client returned `client_closed`, was taken as
  success, and left the line in the box. Dropping it on the reply alone counted
  an injection Claude Code had received as the human's turn, which reset the cap. **Residual race, accepted:** a keystroke in the frame between the last
  check and the send joins the injected line; magmux has no atomic "send if empty".

`hooks/session/interactive-driver.integration.test.ts` includes an end-to-end row: the real
`claudish -i` inside a headless magmux pane (ambient mode), the proxied fake Claude Code and a stub
upstream. A `responseEnd` annotation crosses the in-process sink into `sessionIdle`, whose injection
is typed, and the transcript order is exactly prompt, answer, injection, answer.

**Rejected for no-surface launches**: a Claude Code `asyncRewake` hook through the `--settings`
overlay. Its output reaches the model as hook feedback, not a human user record, and a Stop-hook block
continues the *same* turn, which a driver reads as a re-wake.

## Loading and authoring

- **Global config only.** A project `.claudish.json` is repo-controlled, and running code it names
  would need a trust model claudish does not have. A project `hooks` key is reported and ignored.
  The same holds for a repository choosing the config **file**, or posing as a pane child. The
  **control variables** (`CLAUDISH_CONFIG`, `CLAUDISH_PANE_CHILD`, `CLAUDISH_PANE_ENV`,
  `CLAUDISH_PANE_CWD`, `CLAUDISH_HOOK_INBOX`, `CLAUDISH_HOOK_SESSION`, `CLAUDISH_BIN`;
  `launch-env.ts`) come only from the real environment of the process, never from a file in its cwd.
  Bun loads the cwd's `.env`, `.env.local`, `.env.<NODE_ENV>` and `.env.<NODE_ENV>.local` before any
  claudish code runs, merged into `process.env` with no provenance (measured, Bun 1.4.0: under
  `NODE_ENV=test` too, `.env.test.local` loads). A `bun build --compile` binary does the same unless
  built with `--no-compile-autoload-dotenv` (measured: default on, loads `.env.development.local`).
  Each loader is closed at its source:
  - every launch path turns Bun's autoload off: the npm launcher (`bunArgv` in `bin/claudish.cjs`)
    and the `dist/index.js` shebang pass `--no-env-file`; `build:binary` and `release.yml` compile
    with `--no-compile-autoload-dotenv`; a child under `CLAUDISH_BIN=<file>.ts` runs
    `bun --no-env-file run <file>` (`spawn-claudish.ts`); the madbench MCP config and the test
    harnesses spawn the entry the same way. `launch-env.test.ts` pins each of these;
  - `launch-guard.ts`, the entry's first import, drops every control variable, and every name the
    cwd's env files set, when `process.execArgv` lacks `--no-env-file` and the entry is not compiled
    (`/$bunfs/`, `B:\~BUN\`), before `child-env.ts` can act on a planted marker. The names come from
    Bun itself (`bin/env-files.cjs`: `bun --config=<null device> --print` in the same cwd with an
    empty environment, once with `NODE_ENV` unset and once with the current value). A Bun that
    cannot answer stops the launch. A hand-typed `bun <entry>` is fail-closed, not trusted;
  - the npm launcher does the same for itself when Bun runs it (`bun <path>/claudish.cjs`): it
    leaves those names out of the child's environment, since its child's `--no-env-file` would
    otherwise vouch for them. It drops names only, not every control variable: under `bun x` /
    `bun run <bin>` Bun runs the launcher through a `node` shim with no autoload, and a pane child
    started that way carries real pane markers;
  - claudish's own `.env` load (`loadDotenvText` in `dotenv-allowlist.ts`, dotenv semantics: no
    overwrite, no expansion) sets provider API keys and claudish model settings only. The key part
    is derived from the provider definitions (`BUILTIN_PROVIDERS`, `PREDEFINED_ENDPOINTS`:
    `apiKeyEnvVar` + `apiKeyAliases`) plus the `CUSTOM_<NAME>_KEY` shape; `NAMED_KEYS` adds
    `ANTHROPIC_API_KEY`, `VERTEX_LOCATION` and `CLAUDISH_MODEL*`, each with its reason. Base URLs
    and hosts stay out (key exfiltration), and so does `GOOGLE_APPLICATION_CREDENTIALS`: its value is
    a path gcloud reads as credentials, and an `external_account` JSON names a local file and a
    `token_url` gcloud POSTs it to — a destination, not a secret. A `CLAUDISH_MODEL*` whose spec
    resolves to the raw-URL `custom-url` provider is refused by value (`modelSpecNamesRawUrl`), since
    the credential authority has no notion of a spec's source and that is the `.env` boundary it
    relies on. Three consumers were made safe for a repo-set value: `vertexApiHost` refuses a
    non-location `VERTEX_LOCATION` and `resolveVertexConfig` a non-project-id `VERTEX_PROJECT` (both
    become part of the Vertex request URL / host the Google token is sent to), and the
    service-account `gcloud` call takes the credentials path as an argument, not shell text. A denylist of seven names left `CLAUDE_PATH`,
    `BUN_OPTIONS`, `NODE_OPTIONS`, `CLAUDE_CONFIG_DIR` and the routing variables settable (measured:
    a repo `CLAUDE_PATH` was executed by claudish).
  The parent passes its config to a pane explicitly (`buildPaneEnv`'s `configFile`, from
  `getConfigFileOverride()`), and the pane markers only ever travel in the spawn environment.
  Rejected: comparing values against a list of env files parsed with dotenv. It shipped once and was
  bypassed three ways, each reproduced end to end: `.env.development.local` (not in the list), a
  quoted value Bun and dotenv parse differently (`"./x.json"x`), and `CLAUDISH_PANE_CHILD=1` with a
  `CLAUDISH_PANE_ENV` snapshot carrying `CLAUDISH_CONFIG`, which `bootstrapPaneChild` applied before
  the comparison ran. It also discarded a parent's `--config` in a child whose cwd `.env` held a
  `$`-expanded value. Not closed by any of this, and out of this change's scope: a cwd `bunfig.toml`
  `preload` still runs under `bun --no-env-file <entry>` and in a compiled binary (measured, Bun
  1.4.0); `--no-compile-autoload-bunfig` and a neutral `--config` for the launcher are its candidate
  fixes. Measured too: `bun run <script>` and `bunx`/`bun x` do not pass the cwd `.env` to the
  process they start.
  `hooks` is on `loadConfig`'s allowlist; so is `behavior`, as an opaque passthrough, so a user's old
  block is not dropped by the next global save before they move it.
- **Paths** resolve against the active config file's directory, never `process.cwd()`, which in a
  pane child is the MCP server's cwd.
- **The `claudish/hooks` virtual module.** Before the first user import, the host registers a
  `Bun.plugin` runtime plugin that resolves `claudish/hooks` to its own `public.ts` exports. Order
  matters: plain `bun` (the npm route) has auto-install on, and an import of an uninstalled bare
  package triggers a network fetch at load (measured about 1 s). Type-only imports are erased on
  transpile and need no resolution.
- **Compiled binaries load external hooks.** Measured: a `bun build --compile` binary and the
  `--target bun` bundle both imported a type-only `.ts`, a value-import `.ts` and a `.js` from a
  directory with no `node_modules`, on macOS arm64 (Bun 1.3.10 and 1.4.0), Linux arm64 (1.3.10 and
  1.4.3) and Linux x86_64 (1.4.3, emulated). macOS x64 was not measured locally. `hooks/s1-probe/s1-loading.test.ts` keeps it true, and the CI `hooks-loading`
  job runs it on the release workflow's runners. Trap: a freshly compiled local binary on macOS exits
  **137** (SIGKILL) before any code runs until it is ad-hoc re-signed (`codesign --force -s -`). That
  is a signature property of a local build, not an import failure; the release workflow signs.
- **Bun caches a directory's entries on first import.** A hook file written later into an
  already-imported directory fails "Cannot find module". Production loads once per process; tests use
  one temp directory per module.
- **Types for authors.** `scripts/generate-hooks-dts.ts` emits `src/hooks/ambient-dts.generated.ts`
  (committed, like `version.ts`, so typecheck and the binary need no build step), the text
  `claudish hooks init` writes as `claudish-hooks.d.ts`. `--check` fails on drift.
  `hooks-command.test.ts` compiles every whole-file example in `docs/advanced/hooks.md` against it,
  loads each with `claudish hooks check`, and asserts the doc shows the init example verbatim.

**`behavior` is reported, not migrated.** Old modules cannot be ported mechanically (different shape,
no `apiVersion`), so an automatic rewrite would point `hooks.modules` at files that fail to load, and
copying telemetry consent silently would launder it. The reporter prints the moves once per process.
`claudish behavior` is removed with no alias.

## Telemetry: the cross-user corpus

`hooks/observer/corpus.ts` (`claudish hooks corpus`) replays recorded Claude Code transcripts offline
to build a **labelled** divergence corpus with no live traffic. Claude Code records
`toolUseResult.filePath` (the path it read) and `plan: null` (whether it found anything), so every
replayed session is known-good or known-degraded for free. Over 1,129 local transcripts it reproduced
the diagnosis: 11 degraded, all gpt-5.6-sol, every Claude and Kimi model clean, and the plan-mode hook
would have caught 11 of 11.

That corpus is one developer's models on one developer's projects. A hook for a model the maintainer
never runs needs evidence from someone who does, which is what `POST https://claudish.com/v1/behavior`
collects. Contract: `docs/specs/behavior-telemetry-backend.md`. Server-side retention is 12 months,
then non-identifying weekly aggregates.

- **Opt-in, default off**, via `hooks.telemetry.enabled` or `claudish hooks telemetry --enable`.
  Deliberately not `stats.enabled`: that consent was granted for usage statistics, and reusing it for
  behavioural records would be consent laundering. An old `behavior.telemetry` consent is **not**
  carried over. Local journaling (`~/.claudish/behavior-journal.jsonl`, schema 2) is always on.
- **Session aggregates, not decision records.** One payload per session, counters only. One private
  `journal()` fan-out writes the local line and, for the surfaces and decisions the backend accepts,
  calls `recordTelemetryDecision`, so the two can never disagree.
- **User hook ids upload as `"user"`,** and an `mcp__` tool name on such a row is withheld, both in
  that fan-out, before the aggregate is keyed. Hook ids and MCP server names are user-chosen strings.
  Built-in ids pass through. Raw rows and the new `response` and `session` surfaces are local-only.
  The old `toUploadable()` projection had no production caller and is deleted; the test asserts on the
  spooled report object.
- **Safety is structural.** `pathRelation` is the pattern: `same_dir_wrong_name` is the exact
  discriminator the plan-mode hook keys off, and it carries no path. Categorical instead of literal.
- **`session_id` is a salted SHA-256** with a per-process salt that is never persisted: no key on disk
  to steal, and no way for anyone to reverse a delivered id. The model id is folded in, so one session
  routing to several models yields one aggregate per model.
- **`context_bucket` is a closed set** (`0-50k` … `200k+`) validated server-side. Adding a value is a
  spec change, not a client change.
- **Spool, then upload.** `process.on("exit")` is synchronous, so a `fetch` started there never
  completes. Exit does the one reliable thing, `appendFileSync` to `~/.claudish/behavior-outbox.jsonl`,
  and a later run drains it in the background. A hard kill loses nothing.
- **The drain timeout is 15 s**, not the 3 s `/v1/report` uses. Measured against the deployed
  service: warm about 600 ms, but a cold start exceeds 3 s, so at 3 s the first drain after any idle
  period failed every time. 429 is not honoured by waiting: a background drain must not sit on a 60 s
  timer, and deferring to the next run is the same outcome later.
- **The file names keep `behavior`.** They name the behaviour-telemetry product and its
  `/v1/behavior` endpoint, not the deleted module, and renaming the outbox would orphan spooled
  reports.

The **observer** (`observer/divergence`) is a small local model under the vision-proxy contract: hard
timeout, `null` on failure, never blocks. It sees only a digest (tool names, harness facts, the call's
argument keys plus path-like values), never conversation text. Its model is discovered
(`ollama-discovery`, smallest non-embedding), never pinned, and ids outside the vocabulary are
discarded. It is an observe-mode `toolCall` hook, so turning it on no longer holds `Write` content.

## Where to look

| File | What |
|---|---|
| `hooks/public.ts` | the contract: types, `HOOK_API_VERSION`, `defineHook`, `act` |
| `hooks/index.ts` | `loadHooksOnce`, `loadHookSet` |
| `hooks/config.ts` | the `hooks` schema, `resolveSeverity`, the `behavior` and project-`hooks` reporters |
| `hooks/loader.ts` | module loading, shape checks, the virtual module, the `mcp` refusal |
| `hooks/registry.ts`, `hooks/engine.ts` | effective order, applicability, `runChain` (the hook chain, event budgets, dispatch bounds, `ctx.prior`), severity, breaker, journal fan-out, pending notes |
| `hooks/actions.ts`, `hooks/text-rewrite.ts` | per-step request and tool-call appliers, the description overlay; text actions for messages and responses |
| `hooks/request-stage.ts` | stages A and B, the per-attempt scope, the response plan |
| `hooks/response-seam.ts`, `seam-transform.ts`, `seam-tap.ts`, `seam-hooks.ts`, `sse-codec.ts` | the seam |
| `hooks/raw.ts` | the raw tier: clone-and-commit, `RawStreamTap`, `ResponseRecorder`, `statsNames` |
| `hooks/output-capture.ts` | hook output scope, `isolateProtocolStdout` |
| `hooks/injection/` | the queue policy, sinks, the inbox reader |
| `hooks/session/binding.ts` | `SessionHookBinding`: the hold, the watchdog, abort reasons |
| `hooks/session/interactive-driver.ts`, `interactive-launch.ts`, `no-surface.ts` | the launcher's driver and surface plan |
| `hooks/builtins/` | the four built-in hooks |
| `hooks/journal.ts`, `hooks/telemetry/`, `hooks/observer/` | journal, upload, observer and corpus |
| `hooks-command.ts` | `claudish hooks list\|check\|init\|corpus\|telemetry` |
| `scripts/generate-hooks-dts.ts`, `tsconfig.hooks.json` | the author-facing declaration |
