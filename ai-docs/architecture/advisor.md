# Advisor: `--advisor` for any main model

`--advisor "m1,m2[:collector]"` replaces Claude Code's built-in advisor with a panel of external
models. When the main model calls the `advisor` tool, claudish sends the conversation to every
panel model, optionally has a collector model merge the answers, and hands the result back as the
tool result. This file records why the code is shaped the way it is, what two design reviews
caught, and which failures are silent.

Baseline for the work: claudish 9.0.6 (`1eed9e5`), Claude Code 2.1.263. Sources: the session
`ai-docs/sessions/dev-feature-advisor-any-model-20260909-0001/` (gitignored, so it will not
survive; everything load-bearing from it is copied here). Three of its records are archived
verbatim in `ai-docs/reports/`: the build report (`advisor-build-report-20260911.md`), the
mutation proofs behind each guard (`advisor-mutation-proofs-20260911.md`), and the scope
decisions (`advisor-scope-decisions-20260910.md`).

```
claudish --advisor "gpt-5.6-sol" -p "task"                          # A: no main model, Claude Code's own
claudish --model claude-sonnet-5 --advisor "gpt-5.6-sol" -p "task"  # B: bare Anthropic name
claudish --model grok-4.6 --advisor "gpt-5.6-sol,gemini-3.8-flash:haiku" -p "task"  # C: foreign main model
```

The three configurations recur below as A, B and C.

## `--advisor` is independent of `--monitor`

`--advisor` used to set `config.monitor = true`. Monitor makes `getHandlerForRequest` return
`nativeHandler` as its FIRST branch, before the model string is read. So in configuration C,
`claudish --model grok-4.6 --advisor X` served `grok-4.6` by forwarding that name to
api.anthropic.com. Four independent reviewers confirmed the diagnosis. The cli.ts flag handler
now sets `config.advisor` and leaves `config.monitor` alone. Monitor itself is unchanged.

Monitor is not one behaviour, though. It gates many sites, and decoupling the advisor from it
without auditing them is how the second design broke configuration A at launch:

| Monitor-gated site | Under `--monitor` | No-model `--advisor` (A) | `--advisor --model X` (B, C) |
|---|---|---|---|
| `getHandlerForRequest` dispatch | everything to `NativeHandler` | not inherited | not inherited |
| interactive model picker (`index.ts`) | skipped | **skipped** | runs if needed |
| "Model must be specified" abort (`index.ts`) | skipped | **skipped** | runs if needed |
| `modelId` in `runClaudeWithProxy` | `undefined` | **`undefined`** | the named model |
| native auth in `runClaudeWithProxy` | deletes `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`, no `forceLoginMethod` overlay | **same** | proxy auth for C |
| API-key validation (`index.ts`) | skipped | runs (nothing to validate) | runs |
| `modelChain` passed to the proxy | dropped | kept | kept |
| classifier passthrough | skipped | can run | can run |
| `managedSettingsForcesClaudeAi` abort | skipped | skipped | runs for C |
| unserved paths forwarded (`isPassthroughSession`, [first-party.md](first-party.md)) | yes, unless `--advisor` is also given | not inherited | not inherited |

The four bold rows are the "four launch bits". Without them A cannot start:

1. The picker would prompt for a model, and picking one turns A into B or C.
2. `claudish --advisor "X" -p "task"` would hit `process.exit(1)` for a missing model.
3. `modelId` would become `"unknown"`, the child would get `ANTHROPIC_MODEL=unknown`, and
   Anthropic returns 400 on the first request.
4. The child would get the placeholder key, `NativeHandler` would forward it, and Anthropic
   returns 401.

One predicate carries all four: `isAdvisorNativeSession(config)` in `claude-runner.ts`, true when
`config.advisor && !config.model && !config.modelChain`. The picker, the abort, `modelId`,
`isProxyAuthMode` and the native-auth branch all read it. A no-model session takes the monitor
auth branch rather than the `shouldPreserveNativeAuth` one, so its child env stays byte-identical
to what `--advisor` produced while it implied monitor.

The other rows are deliberately NOT inherited, and each is a gain. A pinned chain
`--model "grok-4.6,gpt-5.6" --advisor X` used to collapse silently to its first element. Startup
key validation now runs for the main model. And C keeps its credentials, so a user with no Claude
subscription can run `--advisor --model grok-4.6` at all, which was the feature's motivation.
`managedSettingsForcesClaudeAi` stays skipped for A, because A survived that org policy under
monitor and must not start aborting on it.

## The swap is a decorator around the routed handler

Claude Code's advisor is a SERVER tool, `{type: "advisor_20260301", name: "advisor", model}`,
sent with the beta flag `advisor-tool-2026-03-01`. Foreign format converters keep function tools
and drop server tools. Observed: the Codex handler sent 28 tools upstream and no `advisor`. So the
swap to a function tool named `advisor` (no arguments; the panel reads the conversation) must
happen BEFORE the inner handler converts the request.

The advisor code used to live inside `NativeHandler.handle`, so it ran only for native traffic.
It now lives in `withAdvisorSwap` (`handlers/advisor-decorator.ts`), which wraps whatever handler
the proxy resolved:

```ts
// proxy-server.ts, main request path
const handler = withAdvisor(await getHandlerForRequest(body.model), advisorPresence);
```

**Wrap the RESULT of `getHandlerForRequest`, never inside it and never a candidate.**
`FallbackHandler.handle` tests `handler instanceof ComposedHandler` to attach fallback metadata and
the provider display name. A wrapped candidate fails that test, and the metadata is dropped
without an error. Wrapping inside `getHandlerForRequest` would likewise hide the handler from
`count_tokens`' `instanceof NativeHandler` check. The classifier passthrough is wrapped separately,
without the presence monitor.

**Exactly once.** `NativeHandler` no longer swaps, scans or rewrites. `withAdvisorSwap` never
wraps an `AdvisorSwapHandler`, and a request whose Hono context already has `advisorHandled` passes
straight through. A `FallbackHandler` that tries a native candidate and then a foreign one therefore
sees one swap and one rewrite.

**The beta strip stays in `NativeHandler`.** Its outbound headers are built inside
`NativeHandler.handle` from `c.req.header()`, and a decorator cannot reach them through
`ModelHandler`. Anthropic rejects a request that enables the advisor beta without declaring the
server tool, so the swap without the strip 400s every native request (A and B). The decorator sets
`c.set("advisorSwapped", true)` when it swapped, and `NativeHandler` calls `stripAdvisorBeta` on
that signal (`ADVISOR_SWAPPED_CONTEXT_KEY`). An earlier option, "do not wrap a `NativeHandler`",
breaks the strip whenever a native handler sits under a `FallbackHandler`.

**Off means off.** `withAdvisorSwap` returns `inner` unchanged when `loadAdvisorSwapConfig(...)`
is disabled. `--monitor` without `--advisor` never builds a wrapper.

## Advisor tool-use ids are captured by tool NAME

The rewrite needs to know which `tool_result` blocks answer an advisor call, so the response is
scanned for `tool_use` blocks and their ids are recorded. The old scanner hard-required the
`toolu_` prefix:

```
/"type"\s*:\s*"tool_use"\s*,\s*"id"\s*:\s*"(toolu_[A-Za-z0-9_-]+)"\s*,\s*"name"\s*:\s*"advisor"/g
```

`toolu_` is Anthropic's spelling. `openai-sse.ts` forwards the upstream `call_*` id or mints
`tool_${Date.now()}_${idx}`, and `base-api-format.ts` makes `openai-sse` the DEFAULT stream format.
The result was stub path S10 on every foreign provider (xAI, OpenRouter, DeepSeek, Moonshot, Qwen,
GLM, MiniMax, Ollama, LM Studio, Poe, Devin): no external call, no rewrite, no log line, and
Claude Code's own `No such tool available: advisor` reached the model as the advice. The first
design asserted the opposite. All four reviewers found it.

Capture now records the id of any object with `type: "tool_use"` and `name: "advisor"`, whatever
the id looks like (`collectAdvisorIdsFromValue`). Structural parsing also removes a key-order
dependency: the old regex required `type`, `id`, `name` adjacent and in that order, which only
unpinned object literals guaranteed. A prefix-agnostic regex (`ADVISOR_ID_PATTERNS`) remains as a
fallback for frames that do not parse.

**SSE is reassembled across chunks** (`SseFrameBuffer`, buffered to `\n\n`, `data:` lines joined).
There are two separate reasons. Anthropic splits `content_block_start` across byte boundaries, and
a buffered `content_block_start` from `openai-sse` arrives only once the arguments are complete. A
per-chunk `JSON.parse` of `data:` lines misses split frames. A non-stream response is not a
`content_block_start` at all; `recordAdvisorEventsFromResponseBody` walks its `content[]`.
Each stream gets its own buffer from `createAdvisorStreamScanner`, so concurrent streams cannot
splice frames into each other.

## The response is tee'd

`inner.handle` returns a `Response` whose body is a one-shot `ReadableStream`. Reading it to scan
consumes it; returning it unread records nothing. The second design specified neither, which would
have made configuration C stub path S10 again, one layer out.

`tapAdvisorResponse` splits the body with `body.tee()` and scans only `text/event-stream` and
`*json*` bodies:

- The client branch carries the same chunks in the same order, re-exposed through a pull-only
  stream (`highWaterMark: 0`). Its one job is `cancel`: a tee releases its source only when BOTH
  branches cancel, so without it the upstream would keep generating (and billing) for a client that
  has gone.
- The scan branch is drained eagerly and never paused, so the tee never queues bytes for it. Ids
  are recorded while the stream is in flight, long before Claude Code sends the tool result.
- A scan fault is logged (`[advisor-swap] response scan stopped: ...`) and cancels only the scan
  branch. A body that `tee()` refuses is returned untouched.

## Pending calls are keyed by session and retained after use

State is `Map<sessionKey, Map<toolUseId, PendingAdvisorCall>>` in `native-handler-advisor.ts`.
It replaced a module-global `Set<string>` of ids.

**Keyed by session**, because `serve` and the MCP path run several conversations through one
proxy. With one shared 256-entry set, one conversation could evict another's pending id, and
generated `tool_<ts>_<idx>` ids can collide across conversations. The key comes from
`extractSessionId` in `behavior/harness.ts`, which takes the whole request and reads the
`session_id` inside `metadata.user_id`. A different function with the same name exists in
`session-events/index.ts` and takes the metadata object; the import names the path.

The session id can be absent on the request whose response records the call and present on the
request that consumes it. The `NO_SESSION_BUCKET` (`"__no_session__"`) rule:

- Record: a session-less request records into `__no_session__`.
- Consume: look in the request's own session bucket first, then `__no_session__`.
- Adopt: an entry a known session finds in `__no_session__` moves into that session's bucket, so
  two known, different sessions never resolve the same entry.

**Retained after use.** The second design deleted an entry once its advice was delivered. The
tool-use id stays in the conversation history, and Claude Code re-sends every earlier advisor
tool result on each turn, still carrying its own "No such tool" error. Turn two found no entry
and delivered that error: S10 by a new route. Now `markAdvisorCallConsumed` stores the delivered
`AdvisorToolResult` on the entry, and later turns replay it verbatim without calling the panel.
Pass 1 of the rewrite restores earlier advice BEFORE the panel runs, so the panel reads the
conversation the model saw.

Eviction is the only bound (`ADVISOR_PENDING_LIMITS`): 256 calls per session and 64 sessions,
both LRU, plus a 24-hour sliding TTL. Every record or lookup refreshes the TTL, so an active
conversation never expires.

Known limit: two concurrent requests in one session that both carry the same unconsumed id can
each call the panel. The last result wins; there is no in-flight de-duplication.

## Ten stub paths, and where advice origin is recorded

Research found that success was unfalsifiable. The log recorded the CONFIGURED model list, never
which model answered, and every failure reached the model with `is_error` forced to `false`. A
log from a working advisor and one from a stub looked identical. Every path that delivers
something other than real advice is now a named constant in `ADVISOR_STUB_PATHS`:

| Path | Constant | When |
|---|---|---|
| S1 | `LEGACY_STUB` | `CLAUDISH_SWAP_ADVISOR=1` with no panel; the canary stub is delivered |
| S2 | `PREPARED_RESULT_MISSING` | a recorded call reached the rewrite with no prepared result (internal error) |
| S3 | `DISABLED_STUB` | the canary text itself (`stubAdvisorAdvice`) |
| S4 | `PANEL_EMPTY` | a panel model returned 2xx with no extractable text |
| S5 | `ANTHROPIC_COLLECTOR_EMPTY` | the Anthropic collector returned 2xx with no text block |
| S6 | `COLLECTOR_EMPTY` | another collector returned 2xx with no text |
| S7 | `PANEL_ERROR` | a panel model failed: non-2xx, network error or timeout |
| S8 | `ALL_PANEL_FAILED` | every panel model failed |
| S9 | `COLLECTOR_FAILED` | the collector failed |
| S10 | `NOT_REWRITTEN` | Claude Code's `No such tool available: advisor` was never rewritten |

S10 can only be seen on a later request. `reportUnrecordedAdvisorCalls` runs after the rewrite and
reports any advisor tool result still carrying that error for an id this session never recorded.

`origin` is `upstream` (real, non-empty bytes from the named model), `stub` (claudish produced
the text) or `absent` (no call was made). `resultOrigin` is `upstream` only when at least one panel
model was upstream AND the collector, if it ran, was upstream. `upstreamStatus` is
`extractUpstreamStatus(body) ?? response.status`, with `upstreamStatusSource` saying which.
`extractUpstreamStatus` alone always returns `undefined` here, because the advisor calls
providers with a bare `fetch` and no claudish handler writes `error.upstream_status` on that path.

Records are written by `logAdvisorEvent`, one per panel model (`advisor_call`), one per collector
run (`advisor_collector_call`) and one per call (`advisor_rewrite`):

- to the file named by `CLAUDISH_SWAP_ADVISOR_LOG`, as JSON lines, when that variable is set;
- to claudish's debug log whenever it is on (`--debug-claudish`), one line each after the prefix
  `[advisor-origin]` (`ADVISOR_ORIGIN_LOG_PREFIX`). The mirror scrubs `Bearer`, `sk-`, `AIza` and
  `xai-` tokens, because `reason` quotes provider error bodies.

```
grep '\[advisor-origin\]' logs/claudish_*.log
# one JSON object per line; check "origin", "stubPath", "requestedModel", "upstreamStatus"
```

**Failures are textual first.** The 400 remap does not touch `tool_result.is_error`, but
`is_error` is not portable: the OpenAI conversion builds `{role: "tool", content, tool_call_id}`
and drops it, and the Gemini conversion builds `functionResponse` without it. So every failure
text starts `[claudish advisor error]`, names each model and its reason, and ends "This tool
result is an error report from the claudish proxy, not advice." `is_error: true` is set as well,
as a supplementary signal for Anthropic-shaped transports. S1 and S3 are the feature-off answer and
keep `is_error: false`. Each call with a failed model also raises one `[advisor]` warning through
`logStderr`.

## Claude Code's gates

Read from the minified Claude Code 2.1.263 binary (function names are the minifier's). Two gates
decide whether the advisor exists:

- **Gate A** (does the tool exist): false if `CLAUDE_CODE_DISABLE_ADVISOR_TOOL` is true; false
  unless the provider is `firstParty` and experimental betas are allowed; then true if
  `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL` is true; otherwise a feature flag decides. The
  provider check ignores `ANTHROPIC_BASE_URL`, so a claudish session stays `firstParty`.
- **Gate B** (per model): the base model needs an `advisor_rank`; the advisor model must be
  entitled for the account, must not be a credit-billed fable model without credit consent, and
  needs rank 2 or more; and the base rank must not exceed the advisor rank.

`CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL` bypasses exactly the three rank checks (`K9`, `xtn`,
`vue`) and invents no default rank. It does NOT bypass the kill switch, the firstParty/betas check,
or the entitlement and fable-credits checks. Never present it as a master switch. Configuration B
failed at the rank check; configuration C has no rank at all, so the variable is its only route.

**It is parsed as a strict boolean.** Claude Code declares it `I.bool()`, whose reader accepts only
`1`, `true`, `yes`, `on` after trim and lowercase. `"2"` and `"enabled"` are FALSE, and a false
value is a silent no-op. The kill switch uses the same reader. In claudish:

```ts
// claude-runner.ts
resolveAdvisorToolEnv(config)
// --advisor, variable unset in the parent     -> { vars: { CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL: "1" }, source: "claudish" }
// --advisor, variable present (even empty)    -> { vars: {}, source: "inherited" }  (the user's value reaches the child)
// no --advisor                                -> { vars: {}, source: "off" }
```

The startup notice says which, and warns when an inherited value reads as false.
`isClaudeCodeBoolTrue` in `advisor-startup.ts` reproduces the reader for the kill-switch refusal.

**`advisor_rank` is compiled into the Claude Code binary.** It lives in a hand-maintained baked
catalog. The published catalog path (`CLAUDE_CODE_MODEL_CATALOG_URL`) feeds a different accessor
and does not supply it. No foreign model can earn a rank, and the table changes on every Claude
Code release. Never copy it into claudish: conditioning the variable on rank would mean
duplicating that table, which CLAUDE.md forbids. claudish sets the variable unconditionally
under `--advisor` instead.

The advisor model itself must still be configured on the Claude Code side (`advisorModel` in
settings, `/advisor`). The variable alone yields no advisor.

## Panel routing and billing

Panel and collector calls never go through `route()`. `advisorRouteFor(modelSpec, role)` is the
only place the branching lives. Request building, key resolution (`advisorCredentialsFor`), the
origin records and the startup checks all read it, so startup cannot drift from runtime.

| Spec | Host | Key |
|---|---|---|
| `gemini-*`, `google@`, `gemini@` | generativelanguage.googleapis.com | `GEMINI_API_KEY` (`GOOGLE_API_KEY` as last-resort env fallback) |
| `gpt-*`, `openai@`, `oai@` | api.openai.com | `OPENAI_API_KEY`, never the Codex login |
| Claude model, as COLLECTOR only | api.anthropic.com | inbound `x-api-key` if real, else `ANTHROPIC_API_KEY` |
| everything else, including `grok-*`, `cx@`, `gk@` | openrouter.ai | `OPENROUTER_API_KEY` |

Every panel call is billed per token on a raw API key. A Codex or SuperGrok subscriber pays
metered rates for panel calls, and a `cx@` or `gk@` panel spec goes to OpenRouter. The startup
notice says so on every launch:

```
[claudish] --advisor is on for this launch
  panel (panel calls never use a subscription):
    gpt-5.6-sol -> api.openai.com (OPENAI_API_KEY, billed per token)
  collector:  none
  main model: your Claude Code session
  CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL=1 set by claudish
  cost: each advisor call sends the FULL conversation to every panel model, uncached; cost grows with panel size and transcript length
```

Subscription-aware panel routing is parked in `ROADMAP.md`: it rewrites the retrieval path, and
the origin records above were built around one bare `fetch` per model.

Keys resolve through the credential authority (env, config, keychain, 1Password), and only for the
routes the configuration uses, so an unused provider never triggers a 1Password handshake. The
Anthropic collector never receives the inbound `authorization` header (Claude Code's OAuth bearer)
or `ANTHROPIC_AUTH_TOKEN`. Before this work it read only the inbound `x-api-key`, which an OAuth
session does not send, so it got a 401 and fell back to concatenation, and only the debug log said
so.

The same trace found a bug that broke every OpenRouter panel member: `resolveModelNameSync` was
called with its arguments swapped, and its result is an object that is never nullish, so
`?? rawModelId` never fired and the request body carried an object as `model`. The body was typed
`any`, so the type checker missed it. `advisorRouteFor` now calls
`resolveModelNameSync(rawModelId, "openrouter").resolvedId`.

## Startup refusals vs runtime warnings

Rule: anything claudish can determine at launch is a refusal with a named reason and exit 1,
before a port is bound or the child spawns. A session that silently has no advisor looks exactly
like one that works. `evaluateAdvisorStartup` decides; `index.ts` prints to stderr (never stdout,
which belongs to Claude Code in `-p` mode, and regardless of `--quiet`) and exits.

Refusals, in order:

1. `CLAUDE_CODE_DISABLE_ADVISOR_TOOL` is true in the child env (strict boolean).
2. A main-model path that drops every tool. `formatCarriesTools` probes the resolved transport's
   pinned format with a one-tool request; `OllamaAPIFormat.convertTools` returns `[]`, so
   OllamaCloud refuses. There is no model list, so a format that learns tools lifts the refusal
   with no edit. `resolveMainModelFact` checks `nativeRouteFor` first, per the CLAUDE.md invariant.
3. An empty panel.
4. Any panel model whose credential does not resolve. Every missing one is listed.
5. A collector the user NAMED whose credential does not resolve.

Checks 1 to 3 need no credentials and run first, so a launch that is refused anyway never opens a
1Password prompt.

```
[claudish] Error: --advisor cannot work in this launch: advisor panel model cannot be called: gpt-5.6-sol calls api.openai.com and needs OPENAI_API_KEY; none found in env, config, keychain or 1Password. Set the key, or remove the model from --advisor.
```

**Default vs named collector.** `parseAdvisorFlag` defaults the collector to `haiku` when the
panel has two or more models and the value has no `:`, and records `collectorDefaulted`
(launch-only, never in `ClaudishProfileConfig`). An OAuth session usually has no
`ANTHROPIC_API_KEY`, so "refuse when the collector has no key" would refuse every default
multi-model panel.

| Collector | Credential missing at launch | Result |
|---|---|---|
| named by the user | yes | refuse; the user asked for it |
| defaulted `haiku` | yes | proceed with no collector; the notice says the answers will be concatenated |

The defaulted case ends where it always did (concatenation), but visibly and without the doomed
call. `index.ts` applies `effectiveCollector` to the config before `createProxyServer` reads it.

Runtime warnings are only for what the child decides:

- one `[advisor]` warning per call in which a model failed;
- one warning per unrecorded call (S10);
- one warning, once per proxy, after `ADVISOR_ABSENT_WARN_AFTER` (3) consecutive requests that
  offer tools but no advisor (`createAdvisorPresenceMonitor`). A request with no `tools[]` neither
  counts nor resets: title generation and the quota probe carry no tools and open every session,
  so counting them would warn on a healthy launch.

## The inherited placeholder credential trap

A proxied claudish session puts placeholder credentials in its child's env
(`CLAUDISH_PLACEHOLDER_API_KEY`, `CLAUDISH_PLACEHOLDER_AUTH_TOKEN`). They leak into every process
that session starts: tool shells, tmux panes, nested claudish runs, `team` slots. A claudish
started from such an env with a native Claude model forwards `Bearer <placeholder>` to
api.anthropic.com and gets 401 on every request.

Measured 2026-09-10 with `--model claude-sonnet-5 --debug-claudish`, prompt "Reply with exactly
the word PONG.", in a terminal-mux pane that had inherited both placeholders:

| Run | Build | `--advisor` | Result |
|---|---|---|---|
| T1 | after the decoupling | no | 401 `Invalid bearer token` |
| T1b | same, `env -u` both variables | no | PONG |
| T2 | after the decoupling | yes | 401 |
| T3 | before the decoupling | no | 401 |
| T4 | before the decoupling | yes | PONG (monitor mode on) |
| T5 | released 9.0.8 | no | 401 |

The decoupling did not introduce the defect; it existed without `--advisor` on every build.
`--advisor` had masked it by forcing monitor mode, whose auth branch deletes both variables.
Removing the implication exposed it.

The fix is `scrubInheritedClaudishPlaceholders(env)` in `claude-runner.ts`, called on the child
env at the top of the `shouldPreserveNativeAuth` branch. It deletes a variable only on an EXACT
match with claudish's own placeholder (`isClaudishPlaceholderCredential`), because any other value
is the user's credential, and a user's `ANTHROPIC_AUTH_TOKEN` is set deliberately. It runs before
`shouldHideIncidentalAnthropicKey(config, env)`, so a scrubbed placeholder is not reported as a
hidden real key. `hasResolvableAnthropicAuth` also ignores placeholder values, so an env whose only
Anthropic "credential" is a placeholder no longer counts as having one.

Two looser checks exist elsewhere, and both only decide whether claudish itself uses a key: the
cli.ts scrub of `process.env.ANTHROPIC_API_KEY` under `--monitor` or `--advisor` (substring
`"placeholder"`), and the decorator's collector-key filter (`/placeholder/i`).

## What the reviews caught

Two blind four-model panels reviewed the design before any code. Each found a new way to reach
S10 that the design had asserted was impossible:

- v1 (3 FAIL, 1 CONDITIONAL): the `toolu_` prefix; the beta strip cannot move into a decorator;
  monitor is a bundle of behaviours; a pinned chain collapses; `extractUpstreamStatus` is the
  wrong instrument on a bare `fetch`.
- v2 (2 FAIL, 2 CONDITIONAL): decoupling breaks A at launch; the decorator never sees C's stream
  unless it tees; OllamaCloud cannot carry any tool; delete-on-consume loses turn-two advice; two
  functions are named `extractSessionId`.

Assume a third route exists. A green suite without a test that FAILS when origin is stubbed is
not evidence; read `origin` and `stubPath` from a real run.

## Validation evidence

Real `claudish` launches, each on a clean build of the named commit, from a
terminal pane that carried claudish's placeholder auth token. Evidence files are
listed at the end of this section.

### Before an advisor model was passed (commit 7aaaa24)

Claude Code offered **no advisor tool in any configuration**, so the swap never
ran. Every request logged `[advisor-swap] request offers N tool(s) but no
advisor`, and no `advisor_call` record exists anywhere. A control run on the
RELEASED build behaved the same way, so this was not caused by the change: the
released build implements `--advisor` and ships `advisor_20260301` but never
sets `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL`, and even with that variable
set Claude Code 2.1.267 offers nothing without an advisor model.

The claim that `--advisor` with no `--model` "already worked" was never
supported by a run.

### After the advisor model is passed (commit 6216b79)

Every `--advisor` run logs `child advisor model=sonnet (claudish via
--advisor)`, Claude Code offers `advisor_20260301`, and the proxy logs
`replaced advisor_20260301 with function tool 'advisor'`. The "no advisor"
warning appears zero times.

| Run | Main model | Advisor tool | Advisor calls | Result |
|---|---|---|---|---|
| A | `cx@gpt-6-astra` (Claude Code's own default) | offered | 2 | stubbed by the `max_tokens` defect below |
| B | `claude-sonnet-5`, native | offered | 2 | same defect |
| C | `grok-4.6`, xAI | offered | 2 | same defect |
| C2 | `grok-4.6`, advisor `deepseek-v4-pro` | offered | 2 | **both HTTP 200, real advice** |
| D | `grok-4.6`, panel of two plus collector | offered | 2 rounds | panel and collector `upstream`; one member stubbed, named in `failedModels`, `isError: false` |
| E | `grok-4.6`, no `--advisor` | not offered | 0 | no swap, no records, no log file |

What these runs prove, beyond unit tests:

- **Capture by tool name, not id prefix.** Run C's advisor ids were
  `call-<uuid>-<index>` from the `openai-sse` parser. They were captured and
  rewritten. Under the old prefix-anchored regexes this is precisely the case
  that silently did nothing.
- **Retained entries.** The second advisor call in a session logs
  `replayed=[<first id>]`: a re-sent `tool_result` gets the stored advice
  instead of "No such tool available".
- **Opt-in per launch.** Run E produced no advisor traffic of any kind.
- **Failures are loud.** A failed panel call reached the model as text naming
  the model and the reason, raised one warning, and recorded `origin: "stub"`
  with its stub path. The main model then told the user the tool was failing,
  rather than treating an error as advice.

### Defects these runs found, which no test had caught

- The OpenAI route sent `max_tokens`; that endpoint requires
  `max_completion_tokens`, so the plan's own example panel model returned 400.
- A bare panel name resolved to another provider's id
  (`accounts/fireworks/models/kimi-k3`) on the OpenRouter route.
- `reportUnrecordedAdvisorCalls` matched the phrase "No such tool available:
  advisor" in ANY tool_result text, so a model running `rg "advisor"` in Bash
  minted a fake advisor record and a false user-visible warning. Text the model
  wrote is untrusted input and can never be the sole signal.

### After the panel-prompt and logger fixes

Three further runs, from a build of the working tree:

| Run | Config | Origins | Advice |
|---|---|---|---|
| C | `grok-4.6`, panel `deepseek-v4-pro` | 2 x `upstream` 200 | answers the questions asked |
| B | `claude-sonnet-5`, native | 2 x `upstream` 200 | answers the questions asked (was off topic before) |
| F | `grok-4.6`, two panel models, default collector | 4 x `upstream` 200 | collector correctly dropped, answers concatenated |

`grep -c "No such tool"` returns 0 across every debug log, origin log and
stdout in all three runs.

Run F is the collector rule working end to end: the notice reads `collector:
none — the default collector haiku needs ANTHROPIC_API_KEY, which was not
found; panel answers will be concatenated`, and the log agrees.

The logger fix is confirmed the same way: the extractor now exits 0 on a fresh
log, every `data:` payload parses, and the longest lines are 571 to 578
characters, past the old 300-character cut. Replacing the corrupt fixture with a
clean capture turned the four failing capture tests green **without editing
them**, which is the proof that the tests were right and the fixture was wrong.

### Evidence files

Under the session directory (gitignored):
`validation/phase7-*` for the pre-fix runs including the released-build control,
`validation/phase7b-*` for the runs above, each with the pane output, the
claudish debug log and the advisor origin records. The Grok SSE fixture carrying
a real advisor tool call is committed at
`packages/cli/src/test-fixtures/sse-responses/grok-4.6-openai-advisor-turn1.sse`.
