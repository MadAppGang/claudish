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
| S4 | `PANEL_EMPTY` | a panel model returned 2xx with no text block; the reason names why (below) |
| S5 | `ANTHROPIC_COLLECTOR_EMPTY` | a Claude collector returned 2xx with no text block |
| S6 | `COLLECTOR_EMPTY` | a routed collector returned 2xx with no text |
| S7 | `PANEL_ERROR` | a panel model failed: non-2xx, network error, timeout, a stream that failed after its 200, no hop could be built, a refused plan (Claude selector, no route), no Claude credential on the request, the Claude shape refusal, or "advisor runtime not planned for this launch" |
| S8 | `ALL_PANEL_FAILED` | every panel model failed |
| S9 | `COLLECTOR_FAILED` | the collector failed |
| S10 | `NOT_REWRITTEN` | Claude Code's `No such tool available: advisor` was never rewritten |

S10 can only be seen on a later request. `reportUnrecordedAdvisorCalls` runs after the rewrite and
reports any advisor tool result still carrying that error for an id this session never recorded.

`origin` is `upstream` (real, non-empty bytes from the named model), `stub` (claudish produced
the text) or `absent` (no call was made). `resultOrigin` is `upstream` only when at least one panel
model was upstream AND the collector, if it ran, was upstream. `upstreamStatus` is
`extractUpstreamStatus(body) ?? response.status`, with `upstreamStatusSource` saying which. A
routed call now goes through `ComposedHandler`, whose 400 remap writes `error.upstream_status`,
so `upstreamStatusSource: "error.upstream_status"` is a normal value: a terminal 401 from a
subscription arrives as HTTP 400 and is recorded as 401 (`classifyPanelResult`,
`handlers/native-handler-advisor.ts:2830`).

An empty 2xx is never a bare "no advice". `extractAdvice` (`handlers/advisor-route-plan.ts:744`)
joins every text block and, when there is none, names the reason: `no-content`,
`reasoning-only` (a thinking block and no text), `max-tokens-before-text` or
`max-tokens-during-reasoning` (stop reason `max_tokens`, with or without a thinking block). The
stub reads e.g. `HTTP 200 but the response carried no advice text (max-tokens-during-reasoning:
the 2048-token output limit was reached while the model was still reasoning; stop_reason
max_tokens)` (`emptyAdviceReason`, `:2332`), and the record carries `emptyReason` and
`stopReason`.

Each `advisor_call` / `advisor_collector_call` record (`modelCallRecord`, `:2419`) also says who
served and how it billed, as labels, never a credential value:

| Field | Meaning |
|---|---|
| `provider` | the claudish provider that SERVED the call (`openai-codex`, `native-anthropic`); null when none served |
| `route` | `{kind: "routed", plannedChain: [display names]}` or `{kind: "claude-native", host: "api.anthropic.com"}` |
| `routedModel` | the serving hop's wire model, or the resolved Anthropic id |
| `servedBy` | `{provider, displayName, arm, billing}` when `origin` is `upstream`, else null |
| `billing` | `servedBy.billing`: `subscription` or `metered`; null when nothing served |
| `hopsTried` | routed only: provider uids whose `handle()` was entered, in order, once each |
| `usage` | `{input_tokens, output_tokens}` when the answer carried it |
| `credentialSource` | Claude only: `claude-code-login`, `inbound-x-api-key` or `ANTHROPIC_API_KEY` |
| `loginSkipped` | Claude only, a bearer was present but not used: `placeholder`, `user-auth-token` or `launch-auth-not-claudish-controlled` |
| `systemHead` | Claude login arm only: `identity` or `none` (the system head actually sent) |
| `shapeRefusal` | Claude only: the 429 "Error" shape refusal (see "Panel routing and billing") |

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

Through v12.1.2 every panel and collector call was one bare `fetch` with a metered key chosen by a
hand-written `advisorRouteFor`: a Codex, SuperGrok or Antigravity subscriber paid per token, `cx@`
and `gk@` went to OpenRouter, a Claude panel member went to OpenRouter, and no panel spend reached
stats. That function is gone. Each member is now planned by the function main routing is derived
from, and called through the same handler machinery as a main-model request. Session
`dev-feature-advisor-subscription-20261020-233354-f7e4` holds the design (`architecture.md`, its
amendments A1–A9) and the S0 measurement; the session directory is gitignored, so the load-bearing
facts are copied here.

### One routing function, planned and built before the port exists

`planAdvisorModel(spec, role, deps)` (`handlers/advisor-route-plan.ts:149`) decides each member,
in this order:

1. `splitWireMarkers` — a marker error (`+pro`, `#fast` misuse) is a refused plan.
2. `nativeRouteFor` FIRST, as the proxy does (CLAUDE.md invariant). A Claude name becomes a
   `claude-native` plan (`planClaudeMember`, `:214`) and never reaches `explainRoute`; Claude Code
   selectors are refused (`claudeAdvisorModelFor`, `handlers/advisor-claude-route.ts`):
   `opusplan`, `best` and any `[1m]` form name no single model id the API accepts; `internal` and
   `default` resolve to the opus tier; a tier alias resolves through the catalog alias, then the
   newest `claude-<tier>-*` id; a concrete `claude-*` id is passed through.
3. `ensureCatalogReady(5000)`, the proxy's wait.
4. `explainRoute(model)` — the function `route()` is derived from. `no-route` is a refused plan
   with routing's own cause, reason and hint; otherwise the plan's hops are the `kept` candidates
   in chain order, each billed by `isSubscriptionProvider` at plan time.

An explicit `anthropic@…` spec is NOT native (explicit specs never are, in the proxy either), so
it is planned through `explainRoute`; only a bare Claude name takes the Claude arm.

`evaluateAdvisorStartup` (`advisor-startup.ts:494`) plans every member strictly one after
another, panel then collector, each in its own trace span (`startup:advisor-plan:<role>:<i>`),
then builds every routed member's chain with `buildAdvisorChains`
(`handlers/advisor-route-plan.ts:436`, span `startup:advisor-build`), also strictly sequential:
a build may resolve a credential value (1Password, Keychain), and concurrent handshakes are what
1Password refuses. The builder copies the proxy's dispatch (a `poe:` spec to the Poe getter, an
`openrouter` hop to the OpenRouter getter, everything else to the remote getter, and the local
getter only for an explicit single-hop plan) and classifies each hop: `built` (a
`ComposedHandler`), `built-pending` (a `TryInTurnHandler` or `CatalogPendingHandler`, whose
transport is chosen per request), `refused` (a `RefusingHandler`, asked once at build, no
network; whether the chain continues past it is `FallbackHandler`'s own `isRetryableError` on its
answer), `not-built` (getter returned null) or `failed` (getter threw; message redacted).

The notice, the refusal and the runtime all read those plans and builds. `index.ts` hands them to
`createProxyServer` as `advisorRuntime` (`index.ts:1119`); there is **no lazy path**: a spec the
startup map lacks is S7 "advisor runtime not planned for this launch". A refusal shuts down every
handler it built. Plans and chains are frozen per launch, like main's handler caches.

### Credentials are resolved at launch, fallback hops included

Startup planning reads the key of every candidate the routing chain keeps for a configured panel
or collector model, once, at launch, through the same credential filter main routing runs on each
request: `explainRoute` asks `credentials.describeReadiness` / `hasCredentialsForProvider` for
every candidate (`providers/routing-rules.ts:1112-1120`), and `ApiKeyCredentialProvider`
answers anything that is not in env, config or an OAuth file by resolving the value
(`auth/credentials/api-key-credential.ts:336` → Keychain read, then op:// through
`resolveOpKeyForEnvVars` at `:275`). The value is cached (`:234`), so the chain build's
`getRequestAuth` (`handlers/handler-set.ts:368`) asks no vault a second time. With op:// keys
this can mean a 1Password prompt at launch for a panel model's fallback hops, which a call may
never reach.

This is accepted (owner decision, 2026-10-21; requirement N4 is worded accordingly), because
presence cannot be checked without reading the value: `op-source.ts` offers only `hasOpSources()`
(`:458`, "is any 1Password source configured at all") and `resolveOpKeyForEnvVars` (`:831`), and
glob entries and 1Password Environments name their variables only after the fetch, which needs
the handshake. The Keychain can enumerate for presence (`keychain.md`); 1Password cannot.
Changing this would mean changing main routing's credential filter for every request. The
notice says it, on one line printed when any advisor member is routed:

```
  credentials: each routed advisor model's chain had its keys resolved at launch, including fallback hops (1Password or Keychain may have been asked once)
```

### The advisor handler set, and why panel calls never touch the status line

Chains are built in their own `createHandlerSet({requestRole: "advisor", port: 0, …})`
(`advisor-startup.ts`). A handler owns a `TokenTracker` with cumulative counters, and one instance
serving both main and panel traffic would mix them; the advisor set also has its own
`FallbackHandler`s, so `lastSuccessIndex` never crosses between main and panel requests.
`requestRole: "advisor"` on a `ComposedHandler`:

- writes no token file (`composed-handler.ts:470` → `TokenTracker.writeFile` returns at once,
  `shared/token-tracker.ts:504`), so the main status line is never repainted with the panel model.
  A port cannot isolate it: `CLAUDISH_TOKEN_FILE` outranks the port;
- skips the plan-usage scrape (`composed-handler.ts:3440`) and Layer 4 (`:1360`): a panel call is
  not a harness turn;
- tags every stats event `request_role: "advisor"` (`:593`).

`requestRole` must stay in `sharedOpts`' `Pick` (`providers/provider-profiles.ts`); a
profile-built handler without it writes the token file again, and nothing errors.

### The panel gateway: a never-served Hono app

`createAdvisorPanelGateway` (`handlers/advisor-panel-gateway.ts:83`) is two functions: `plan`
(the startup map only) and `call`, which never rejects. `call` POSTs the payload to an internal
Hono app that is never passed to `Bun.serve`, whose one route installs the call's abort signal,
hop log and signing secrets on a real `Context` and hands it to the startup-built chain. It never
goes through `resolveHandlerForRequest`, so the monitor branch, the `serve` slot map and the
`--model` remap cannot touch a panel call, and no advisor wrapper is applied (no recursion). A
loopback `fetch(proxy.url)` was rejected for exactly that reason: the `--model` remap would
re-route the panel request to the main model.

The synthetic request carries no auth header (and `ComposedHandler` forwards no inbound
`authorization`), so Claude Code's bearer cannot reach a panel hop. Its payload is exactly
`{model, system, messages, max_tokens: 2048, stream: false}` (`buildAdvisorPanelPayload`,
`handlers/advisor-route-plan.ts:679`): no tools and no session id, so code mode stays off and
Layer 4 has nothing to drain. The body is read inside the deadline (60 s panel, 30 s collector)
and redacted by value against every credential the chain signed with, before the call's lease is
released when its work settles (`:170`). A timeout aborts every piece of upstream work the chain
started (`adapters.md`, "An internal call's deadline reaches every piece of upstream work").

Deliberate deviations from main routing:

- **Tier-1 network recovery is skipped** (`x-claudish-no-recovery: advisor`,
  `composed-handler.ts:895`). Routing, classification and the connection verdict are identical;
  only the hold ladder is skipped, because a 60 s budget cannot use a multi-minute hold and a
  tier-2 503 means nothing to an internal caller.
- **Explicit specs get the availability check at startup**, stricter than a main request. Where
  the provider cannot answer (`openai-codex` has no discovery), the hop is kept, as on main; a
  model the Codex account lacks is then an S7 carrying Codex's own (redacted) message.
- **A cold catalog refuses a bare member at launch** (`catalog-unreadable`), which is the
  runtime's answer too. The cold-catalog WARNING (`index.ts`) names only explicit-spec members,
  whose provider was taken as written.

### Stickiness is main routing's, and it is not silent

`FallbackHandler` starts each call at the last hop that served (`lastSuccessIndex`). After one
transient subscription failure that a metered hop answered, every later call of that member
starts at the metered hop, exactly as on main (R3). A rejected subscription LOGIN is never routed
onto a metered hop (only subscription hops are tried after a terminal credential verdict), which
the notice says when a member's chain mixes the two. When a call is served by a hop whose billing
differs from the hop the notice named, one line is written per change
(`warnWhenServedUnlikePlan`, `handlers/native-handler-advisor.ts:2771`):

```
[advisor] gpt-x was served by OpenAI (metered, billed per token), not OpenAI Codex (subscription) as the notice said; later calls start there (routing keeps the last hop that served)
```

### Claude members and the Claude collector

A Claude member is one request to the fixed `ANTHROPIC_MESSAGES_URL` (`https://api.anthropic.com/
v1/messages`, `handlers/advisor-claude-route.ts`; `NativeHandler` imports the same origin), sent
by `runClaudeAdvisorCall` (`handlers/native-handler-advisor.ts:2114`), which takes no URL
parameter. The advisor applies the native passthrough's forwarding RULE here, not through a
`NativeHandler` instance: that handler's fetch has no abort signal and records no stats, and its
no-auth fallback hands out `ANTHROPIC_AUTH_TOKEN`.

**These are claudish-composed requests signed with the Claude Code login, not Claude Code's own
requests** (unlike `team` native slots, which are Claude Code's requests passed through). The
owner can judge them against Anthropic's terms for subscription use with that stated plainly.

**The login signs only on a launch where claudish controls the child's auth.** S0 (below) showed
that a request cannot prove its bearer is the claude.ai login: the `oauth-2025-04-20` beta that
login requests carry is client-declared (`ANTHROPIC_BETAS` adds it to any bearer) and the server
does not require it. So the decision is made at launch by `childAuthControl(config, env)`
(`claude-runner.ts:390`): controlled only when the launch is native-auth (no foreign `--model`
handing the child claudish's placeholder), no user `ANTHROPIC_AUTH_TOKEN` and no real
`ANTHROPIC_API_KEY` reaches the child, `ANTHROPIC_CUSTOM_HEADERS` carries no auth header, and no
settings layer claudish can read (managed settings, `~/.claude/settings.json`,
`$CLAUDE_CONFIG_DIR/settings.json`, the project and project-local files, `--settings`) names an
`apiKeyHelper` or sets an Anthropic credential in its `env`. It cannot see settings delivered by a
mechanism it does not read (an MDM profile). The decision travels in `AdvisorRuntime.childAuth`
to the decorator (`proxy-server.ts:326`); a decorator given none treats the launch as not
controlled.

Per main request, the decorator reads the Claude facts once, before any member runs
(`claudeRequestFacts`, `handlers/native-handler-advisor.ts:1854`), which also registers every real
inbound bearer and `x-api-key` on that request's signing lease. The login arm needs ALL of: an
inbound `Bearer` that is not a claudish placeholder; a value that is not this process's
`ANTHROPIC_AUTH_TOKEN`; and `childAuth.controlled`. The value is held in `ClaudeLogin` (`:1762`),
whose `String()`, `toJSON()` and inspect print `[redacted]`; only `runClaudeAdvisorCall` reads it.

The credential for one advisor call is chosen by presence and provenance, never by failure
(`resolveClaudeAdvisorAuth`, `:1937`), and resolved at most once per call and only when a Claude
member runs (a routed-only panel never resolves an Anthropic key):

1. the login, when every check passed — `arm: oauth`, `billing: subscription`;
2. else the inbound `x-api-key` when it is real — metered;
3. else `ANTHROPIC_API_KEY` through `resolveAdvisorCredential` (env, config, Keychain,
   1Password; never `ANTHROPIC_AUTH_TOKEN`, never a placeholder) — metered;
4. else S7/S9 "no Claude credential".

A real bearer that failed a check, or a request with no bearer, is never moved to a metered key
silently: the call writes an `[advisor]` warning naming the reason. claudish's own placeholder (a
proxy-auth launch, whose notice already says metered) is not a credential and only shows as
`loginSkipped: "placeholder"`. A login the API rejects (401, 429) is reported with Anthropic's
message and never retried on a metered key, as the native passthrough never does.

**Request shape on the login arm** (S0 shape A): `authorization` (inbound, verbatim),
`anthropic-version` (inbound, else `2023-06-01`), `anthropic-beta` (inbound, through
`stripAdvisorBeta`), `content-type`; no `x-api-key`. `system` is `[identity block, advisor
prompt]`, where the identity block is the first inbound system text block that is not Claude
Code's billing-header block and spans one line, copied without its `cache_control`
(`claudeIdentityBlock`). With no such block the prompt is sent alone and the record says
`systemHead: "none"`. The API-key arms send the earlier metered request byte for byte: `x-api-key`,
`anthropic-version: 2023-06-01`, a string `system`, shaped by the connection's wire when known
(`claudeAdvisorRequestInit`, `:2050`).

**HTTP 429 `rate_limit_error` "Error" with no `anthropic-ratelimit-unified-*` header is a shape
refusal, not quota exhaustion** (`isClaudeShapeRefusal`, `:1988`). S0 got it for the prompt alone
(shape A0) on every tier, deterministically, with `x-should-retry: true`. It is never retried and
never cools anything down; the stub says so and the record carries `shapeRefusal: true`.

Immediately before the fetch, one boundary line is logged from the `Request` being sent, never a
value:

```
[advisor] Calling API: https://api.anthropic.com/v1/messages (role: panel, auth: bearer, source: claude-code-login, systemHead: identity)
```

### Billing and stats

`billing` is decided by the arm that signed, never by the provider name: routed calls read it
from the hop log after signing (`HopAttempt.billing`, set by `markHopSigned`: for
`openai-codex`, the one credential-decided provider, it is that request's own
`RequestAuth.arm`, `oauth` = subscription and anything else metered, never the name check, whose
probe reads a process-wide last-signed arm; for every other provider it is its
`SUBSCRIPTION_PROVIDERS` membership); Claude calls
are `subscription` iff `arm === "oauth"` (`native-anthropic` is in neither billing set). That is
the $0 evidence with stats on or off: `getModelPricing` returns zero exactly when
`isSubscriptionProvider` is true, or, for a `ComposedHandler` request, when that request's own
`RequestBilling` says subscription. The hop label and the token cost share one derivation
(`ComposedHandler.signedBilling`), passed per call into every `TokenTracker` cost update,
retry-leg input included, so a concurrent request's signing cannot reprice this one.

Every advisor call records stats with `request_role: "advisor"`, with main's semantics:
`estimated_cost` is the emitting handler's running total for the launch and `is_free_model` is
"that total is 0". Routed calls get it from their advisor-set `TokenTracker`; Claude calls from a
per-launch accumulator per model id (`claudeAdvisorSpend`, `:2182`), which adds 0 on the login arm
and `calculateCost("native-anthropic", …)` on an API-key arm. A launch's advisor spend is the last
`estimated_cost` per `(model_id, provider_name)` with `request_role = advisor`. Panel spend stays
off the main status line by design.

### The notice

```
[claudish] --advisor is on for this launch
  panel (each model is routed like a main-model request):
    gpt-6.1-sol -> OpenAI Codex (subscription); then OpenAI (metered, billed per token) (a rejected subscription login is reported, never routed onto a metered hop)
    sonnet -> api.anthropic.com (subscription: your Claude Code login; if a request carries none: its x-api-key or ANTHROPIC_API_KEY, metered, billed per token)
  collector:  none — haiku is a Claude model; this launch gives the advisor no Claude login (…), and no ANTHROPIC_API_KEY was found in env, config, keychain or 1Password. …; panel answers will be concatenated
  main model: your Claude Code session
  CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL=1 set by claudish
  cost: each advisor call sends the FULL conversation to every panel model, uncached; subscription hops draw on the plan's allowance, metered hops bill per token; routing keeps using the last hop that served
  credentials: each routed advisor model's chain had its keys resolved at launch, including fallback hops (1Password or Keychain may have been asked once)
```

A routed member reads from its BUILT chain (`describeAdvisorPlan`,
`handlers/advisor-route-plan.ts:618`): the first callable hop, each later hop a call can reach, a
refusing hop the chain stops at, the subscription candidates routing skipped and why
(`skipped: … — no credential`), and hops that could not be built. A routed member's
`subscription-not-served` / `subscription-credential-unreadable` warnings print under it as
`note:` lines, because `route()`'s per-request notices never run for a panel call. A Claude
member on a launch claudish does not control reads `<spec> -> api.anthropic.com (metered, billed
per token: ANTHROPIC_API_KEY; <why there is no login>, so the advisor never signs with a bearer on
this launch. <how to restore it>)` (`describeClaudeAdvisorPlan`, `:317`). `index.ts` writes the
notice to stderr and logs each line as `[advisor-notice] <line>`, so a run's log shows what the
launch promised next to what each call did.

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
4. Any panel member that cannot be called (`advisorMemberRefusal`, `advisor-startup.ts:299`):
   a refused plan (routing's no-route cause with its reason and hint, a wire-marker error, a
   Claude selector, an unresolved Claude alias, a Claude member on a launch with no login and no
   `ANTHROPIC_API_KEY`), or a routed plan whose built chain has no callable hop (each hop named
   with its outcome). Every one is listed.
5. A collector the user NAMED that cannot be called, by the same rule.

Checks 1 to 3 need no planning and run first, so a launch that is refused anyway never routes,
resolves a credential or opens a 1Password prompt. A refusal after building shuts down every
handler the build created.

```
[claudish] Error: --advisor cannot work in this launch: advisor panel model cannot be called: gpt-x: no hop could be built — OpenAI Codex: could not be built. Remove the model from --advisor, or fix what the reason names (claudish --probe gpt-x shows the routing decision).
```

**Default vs named collector.** `parseAdvisorFlag` defaults the collector to `haiku` when the
panel has two or more models and the value has no `:`, and records `collectorDefaulted`
(launch-only, never in `ClaudishProfileConfig`). A launch with a non-Claude `--model` has no
Claude login and usually no `ANTHROPIC_API_KEY`, so "refuse when the collector cannot be called"
would refuse every default multi-model panel there (`decideCollector`, `advisor-startup.ts:345`).

| Collector | Cannot be called at launch | Result |
|---|---|---|
| named by the user | yes | refuse; the user asked for it |
| defaulted `haiku` | yes | proceed with no collector; the notice reads `collector:  none — <reason>; panel answers will be concatenated` |

The defaulted case ends where it always did (concatenation), but visibly and without the doomed
call. `index.ts` applies `effectiveCollector` to the config before `createProxyServer` reads it.

Runtime warnings are only for what the child decides:

- one `[advisor]` warning per call in which a model failed;
- one warning per launch per Claude member AND reason when a call cannot use the bearer the
  request carried, or the request carried none, and signs with a metered key instead (every
  request of such a launch gives the same answer; each call's record still carries
  `loginSkipped`). Keyed by the warning text, which names only the reason and the key source,
  never a value, so a later different reason (no bearer, then a skipped one; the request's
  x-api-key, then ANTHROPIC_API_KEY) is printed too and the set stays bounded;
- one warning per change when a routed call is served by a hop whose billing differs from the
  notice's (stickiness, above);
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
`"placeholder"`), and the advisor's `isPlaceholderAnthropicKey` (`/placeholder/i`), which
`claudeRequestFacts` applies to the inbound bearer and `x-api-key` before either can sign a Claude
advisor call.

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

### Subscription-aware routing: S0, the login-arm request shape (2026-10-21)

Measured before the Claude login arm was written, from an INTERACTIVE Claude Code 2.1.305 (TUI in
a terminal pane, not `claude -p`) whose `ANTHROPIC_BASE_URL` pointed at a local capture proxy. The
login bearer was held in process memory only; non-login scenarios used fake tokens and were never
forwarded. Captures, redacted before they touched disk, are committed as test data in
`packages/cli/src/test-fixtures/advisor/` (`inbound-{login,oauthenv,authenv,settingsenv,helper,
authbetas}.jsonl`, `replay-results-*.json`).

| Tier | A0: advisor prompt alone | A: identity block + prompt | B: billing + identity + prompt |
|---|---|---|---|
| `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-fable-5-1` | 429 `rate_limit_error` "Error", no unified rate-limit headers (haiku repeated: deterministic) | 200 | 200 |

- Shape A is accepted on every tier and is what the login arm sends; B adds nothing (same input
  tokens; the billing line appears to be stripped server-side). The login bearer with
  `oauth-2025-04-20` removed from the beta list still got 200 on shape A.
- The inbound system layout is `[billing-header block, one-line identity block, main prompt]`;
  the interactive 2.1.305 billing line carries no `cch=`.
- `oauth-2025-04-20` was present on every login request (keychain login and
  `CLAUDE_CODE_OAUTH_TOKEN`) and absent from `ANTHROPIC_AUTH_TOKEN`, settings-`env` and
  `apiKeyHelper` requests, but `ANTHROPIC_BETAS=oauth-2025-04-20` put it on a non-login bearer on
  all 12 requests. It is a client declaration, not provenance, which is why the login arm is
  decided by the launch (`childAuthControl`) and not by the request.

The live checks of the routed panel (L1–L7: a Codex panel member served by `openai-codex` on the
subscription, the notice matching `servedBy`, launch refusals, code mode unaffected, the Claude
login arm on a no-model launch) are a separate madbench Bench, `ai-docs/benches/advisor-subscription/`.

### Evidence files

Under the session directory (gitignored):
`validation/phase7-*` for the pre-fix runs including the released-build control,
`validation/phase7b-*` for the runs above, each with the pane output, the
claudish debug log and the advisor origin records. The Grok SSE fixture carrying
a real advisor tool call is committed at
`packages/cli/src/test-fixtures/sse-responses/grok-4.6-openai-advisor-turn1.sse`.
