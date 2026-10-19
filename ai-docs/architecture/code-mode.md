# Code mode — Codex models driven the way their own client drives them

`--code-mode <auto|on|off>` (> `CLAUDISH_CODE_MODE` > `codeMode` in the project `.claudish.json`
> `codeMode` in the global config > the default `off`) changes how the claudish provider
`openai-codex` (the ChatGPT Codex backend, `cx@`) is asked to call tools. Instead of Claude
Code's ~90 tools as classic function tools, the request carries ONE freeform tool, `exec`, whose
input is a JavaScript script that calls `tools.<Name>(args)`; claudish runs the script in a QuickJS
sandbox and relays every nested call to Claude Code as an ordinary `tool_use` block. The official
Codex client has driven these models this way since `tool_mode: code_mode_only`; claudish was the
only client still sending them classic parallel function calls.

The default is `off` until the Phase 7 live validation passes; a separate change then makes `auto`
the default (on where the account's dynamic models catalog reports `code_mode_only`). Every
request with code mode off is byte-for-byte what it was before code mode existed, apart from one
`[CodeMode] off (setting-off)` log line per session.

Design and evidence: `ai-docs/sessions/dev-feature-codex-tool-calls-20261016-143706-dc2c/`
(`architecture.md`, `research-codemode.md`, `research-sandbox.md`, `evidence/r1/`, `evidence/r2/`)
— gitignored; the numbers that matter are copied here.

## Why

Three failures on `cx@`, one root cause:

- **Zero-delta arguments.** Since 2026-07-29 the backend sends every multi-call turn with no
  `function_call_arguments.delta`; claudish forwarded arguments only from deltas, so Claude Code
  got `{}` (`InputValidationError: … The required parameter 'file_path' is missing`). Fixed in the
  classic path ([`adapters.md`](adapters.md), "Zero-delta function calls").
- **The degenerate `parallel` wrapper.** About 1% of turns end on a 41–96 KB `a.ts.tsaaa.ts…`
  argument string after a 361–484 s keepalive-only stall. The B experiment found no request factor
  that helps (Fisher p = 1.000 for effort, tool count and `strict:false`;
  `ai-docs/reports/codex-parallel-wrapper-degeneration-2026-10.md`). Contained in the classic path
  by the in-turn retry and the 150 s stall guard ([`adapters.md`](adapters.md)).
- **Both are symptoms of a legacy protocol.** A live capture of codex-cli 0.161.0 shows the model's
  native tool protocol is one `exec` call per response running `Promise.allSettled([...])`. Custom
  tool input is ALWAYS streamed as deltas (9/9 captured calls), so the zero-delta failure cannot
  occur, and there is no wrapper to degenerate.

## The decision, and its order (`code-mode/policy.ts`, step 5d)

Code mode is decided per request, after 5c, from THIS request's auth binding. The gates run in
this order, and the order is deliberate — the static gates come first, so a request that can never
be in code mode pays no discovery wait, creates no store and loads no sandbox:

| # | Gate | Off reason | Why |
|---|---|---|---|
| 1 | claudish provider is `openai-codex` | `not-openai-codex` | the only backend measured |
| 2 | setting is not `off` | `setting-off` | the default |
| 3 | the binding's arm is `oauth` | `metered-arm` | the api-key arm reaches api.openai.com, which publishes no `tool_mode` |
| 4 | the login has a ChatGPT account id | `no-account-id` | every record is keyed by account (below); a login without one never gets code mode |
| 5 | the wire API is Responses | `not-responses` | |
| 6 | ≥ 1 tool declared | `no-tools` | Claude Code's first request is often tool-less |
| 7 | `tool_choice` absent or `auto` | `forced-tool-choice` | a named tool, `any` and `none` are Claude Code's internal one-shot calls; the classic payload honours them exactly (`none` keeps the tools declared, it does not remove them) |
| 8 | the request carries a Claude Code session id | `no-session-id` | the process-wide `conversationKey()` fallback is a cache hint and must never key stateful execution |
| 9 | the sandbox loads | `sandbox-unavailable` | |
| 10 | setting `on` | on, `forced` | |
| 11 | discovery reports `tool_mode: code_mode_only` | on, `discovery` | `auto` |
| 12 | the session is pinned | on, `pinned` | it already relayed an exec, so a later discovery failure cannot flip a code-mode conversation back to classic mid-script |
| 13 | otherwise | `discovery-unknown` / `classic-by-discovery` | |

The shape is `lite` iff discovery says `use_responses_lite: true` and no lite rejection is
remembered for the model; otherwise `classic`. Logged once per session per change:
`[CodeMode] on (lite, discovery: code_mode_only)` / `[CodeMode] off (<reason>)`; the two
process-wide reasons (`no-account-id`, `no-session-id`) once per process.

Discovery is the account's dynamic models catalog (`GET …/codex/models?client_version=`,
`providers/codex-models-discovery.ts`): memoised per account for 1 h, single-flight,
stale-while-error, `AbortSignal.timeout(10_000)` on every fetch, a 60 s back-off while no good
answer exists, and a tool-bearing request with an empty memo waits at most 2 s before going
classic. Never persisted. Discovery is not an auth site: every throw resolves to
`discovery-unknown`, never to a status.

## Two shapes, one tool (`code-mode/request.ts`)

| | lite | classic |
|---|---|---|
| tools | none top-level; `input[0]` is `{type:"additional_tools", id:"at_<uuidv5>", role:"developer", tools:[exec]}` | `tools: [exec]` |
| instructions | none; `input[1]` is a developer message with the system text | `instructions` = the system text |
| reasoning | `context: "all_turns"` (effort: Claude Code's, else discovery's `default_reasoning_level`; neither → classic shape) | unchanged |
| header | `x-openai-internal-codex-responses-lite: true` through `wireHeaders`, so every header fetch (primary, parameter retry, 401 retry, legs) carries it | none |
| both | `parallel_tool_calls: false` (parallelism lives in the script), `tool_choice: "auto"`, `input` from the input builder | |

The system text is Claude Code's system prompt (identity-filtered at step 4, after Layer 4) plus a
three-line claudish note — not the 21.7 KB Codex persona. Step 5a' re-applies `--model-params`
only to a code-mode payload, so the user's explicit fields still win. A build that throws sends
that request non-code-mode (logged); it never refuses.

Live probes of what the backend accepts (R1 §1d):

| Variant | Shape | Result |
|---|---|---|
| A | lite + header + `context: all_turns` | 200 |
| C | classic `tools:[exec]`, no header | 200 |
| D | classic + lite header, no `reasoning.context` | **400** `X-OpenAI-Internal-Codex-Responses-Lite requires \`reasoning.context\` to be \`all_turns\`.` |
| G, H, I | round trips: `custom_tool_call` + `custom_tool_call_output` as parts, as a string, and a `Script failed` output | 200 |

### Lite → classic fallback

The lite header is internal to OpenAI. The first check of the 4xx block, on the RAW upstream status
(before the terminal remap to 400): a lite request answered 400 whose body names the lite header or
`reasoning.context` is rebuilt in the classic code-mode shape — the same exec tool and the same
input, never the non-code-mode function tools — from the post-5c payload clone, `--model-params`
re-applied, the lite header REMOVED from `wireHeaders` (variant D: a classic body with the header is
itself a 400), and resent once through the parameter-retry fetch with fresh headers for this
request's binding. The model stays classic for the discovery TTL (1 h). A retry that also fails
falls through to the error path with the ORIGINAL response.

## Identity: the binding, the account and the session

Every value that depends on auth comes from ONE artifact the request holds in a local
(`AuthBinding`, returned by `refreshAuth` at 5b), never from the transport's shared `cachedAuth`:
another request's refresh can land during the 2 s discovery wait or between legs, and the login
can change in-process (`reloadCredentials`).

- `accountKey` = `sha256("openai-codex\0" + chatgpt-account-id)` from the binding's headers; defined
  only for the `oauth` arm with the header present.
- `sessionKey` = `sha256(session id + "\0" + accountKey)`.
- Exec records are keyed `(accountKey, exec key)`: upstream call ids are unique, so a forked session
  (`--fork-session`: new session id, same history, same account) still finds its execs and renders
  their completed outputs byte-identically. Each record stores its OWNER session; only the owner may
  resume it. Turn records and the pin are keyed by `sessionKey`.
- Another account never finds, resumes or renders this account's records (their encrypted reasoning
  would be rejected under another account anyway).

## The exec tool (`code-mode/exec-tool.ts`)

The definition is the official one (`type:"custom"`, `name:"exec"`, the lark grammar with the
`// @exec:` pragma). The description lists only what claudish implements (`text()`, `exit()`,
`tools`, `ALL_TOOLS`) and one section per tool rendered from `claudeRequest.tools` AFTER Layer 4,
so names are Claude Code's own, never the step-5 encoded wire names. Schemas become TypeScript
declarations (property descriptions as `//` comments, depth ≤ 4, else `unknown`). Identifiers are
normalised to `[A-Za-z0-9_$]` with the later of two colliding names skipped, as Codex does. Budget:
≤ 6 KB per tool, ≤ 48 KB in all, in Claude Code's order; the rest are listed as "Deferred tools"
and stay callable (`ALL_TOOLS` carries every tool). The rule is pinned, never a count.

## A turn: relay, continue, resume

### The leg and the driver

The Responses parser is split into a leg parser (one upstream body) and a turn driver (one
downstream Claude message) — the same mechanism that retries a degenerate leg
([`adapters.md`](adapters.md)). With code mode on:

- The leg HOLDS the `custom_tool_call` named `exec` (never a content block). Its input is
  `custom_tool_call_input.done` ?? `output_item.done.item.input` ?? the accumulated deltas. The leg
  keeps reading until `response.completed` / `.incomplete` / end of body, at most
  `EXEC_DRAIN_MS = 10_000` (R1: the terminal event arrives milliseconds after the exec item), so the
  outcome carries its usage. An exec cut by `response.incomplete` is never run: the model gets
  `Script failed … exec input was truncated by max_output_tokens` and can send a shorter script.
  An exec cut by a dropped socket (or a body that ends inside it) ends the message with an SSE
  `error`, as a cut classic tool block does: the script never ran and nothing reached Claude Code,
  so its retry is safe, where `end_turn` would stop the agent.
- The hooks (`code-mode/relay.ts`) create the record, pin the session and run the script:
  - **blocked** on N nested calls → N whole `tool_use` blocks `toolu_cx_<hex>_<seq>` (Claude Code's
    tool names; buffered tools repaired through Layer 4; `onToolCallObserved` once per nested
    block, never for `exec`), the message's Responses items stored as a turn record, `stop_reason:
    tool_use`. Claude Code runs the tools under its own permissions.
  - **finished** without blocking → its output is stored and another leg is issued: the current
    leg's body with this leg's items and the exec call + output appended to `input`.
- `MAX_LEGS_PER_TURN = 6` and `MAX_INTERSTITIAL_EXECS = 6` (legs count continuations AND retries)
  end the message with `[claudish: stopped after 6 code-mode attempts]`. A retry inside a code-mode
  turn re-sends the CURRENT leg's body; retries count per leg position.
- Usage stays honest: the context figure is the LAST leg's input, output is summed over legs, the
  earlier legs' input is billed once (cost only) before the one `onTokenUpdate` that fires the
  request's stats record.
- A client gone before the `message_stop` of a relayed batch → the record is terminated: Claude
  Code never saw the batch, and its retry starts a new upstream turn with a new exec id.

`nestedId` decoding is strict (`^toolu_cx_([0-9a-f]{32})_(\d{1,4})$`): classic ids and the
parallel wrapper's `toolu_<id>_p<k>` never decode, so history grouping never depends on the store.

### Step 5r: resuming a script (`code-mode/resume.ts`)

After 5b (the account is THIS request's) and after 3c (a synthetic reply gets the same Layer 4
hooks), before 5c. Synchronous from record lookup to state transition, so two concurrent requests
for one record serialise. Guard: `openai-codex`, `oauth` arm, an account key, a session id, ≥ 1
declared tool (5d's `no-tools` gate: a tool-less compaction or summary request is never code mode,
so it must not consume a batch, end other scripts, or get tool_use blocks), `tool_choice` absent or
`auto`. A request with a named tool, `any` or `none` never resumes a
script: consuming a batch there would run the script's next tools outside the turn that owns it;
the next ordinary request resumes it. It reads the stores only if a code-mode request already
created them, with one exception: when none exist (the first request after a restart) but the last
message answers nested ids, 5r creates them (setting not `off`), so the lost script's tombstone is
stored BEFORE 5d builds the input. Without it the builder rendered an unstored `Script failed` on
that request and `Script completed` ("output unavailable after a claudish restart") on the next,
for the same script.

| Situation (the last user message answers nested ids) | Behaviour |
|---|---|
| suspended, owned by this session, expected batch | results resolve or reject by seq (`is_error` rejects with a plain string, as Codex); missing → "no tool_result returned"; blocked again → **synthetic reply**; done → output stored, the upstream turn continues and the input builder renders it |
| `[Request interrupted by user` beside the results | terminated: output so far, the results, "interrupted by the user"; continue. A LOST record is replayed only up to the answered round and terminated there (never fed its results), so Esc yields no further tool call |
| consumed batch, same `batchHash` (a duplicate request) | the memoised step: the same synthetic reply, or the stored completion. The reply goes to the OWNER only: a fork asking while the owner's next batch is pending gets the forked-script `Script failed` below, never that batch (its tools would run twice) |
| consumed batch, different `batchHash` (a rewind that re-ran tools) | lost path, tombstone under the new completion key |
| suspended, owned by ANOTHER session (a fork) | untouched; the fork gets `Script failed` "this script belongs to the session this one was forked from; claudish cannot run it twice"; the owner's later run output wins every lookup |
| record lost, source kept, owned by this session, the request answers its LAST round | **replay** (`replay.ts`): the source re-runs in a fresh runtime and each batch is answered from history, provided batch k is exactly the k-th round (same ids, names and canonical inputs — or, for a call Layer 4 repaired when it was relayed, the script's input and history's input equal the hashes recorded then); then as the first row. The emitter writes a repaired input back onto the record's block (the script's own kept as `scriptInput`), so a duplicate reply re-sends exactly what was relayed, repaired once. `Math.random` is seeded by the call id; a script that branches on `Date` diverges |
| record lost (eviction, poisoned module, or a replay that diverged) or none (restart, another account) | `Script failed` "claudish lost this script's state (proxy restart or eviction); the nested tool results it was waiting for follow" + the results, stored as a TOMBSTONE (a minimal record when none) |
| late results for a settled record | nothing; history renders its output |

For every OTHER suspended record of the session: a pending batch the conversation moved past
(a typed prompt instead of results) is terminated ("the conversation moved on without the tool
results"); one on the LAST message (a prefill) or absent from the request (a Task subagent sharing
the session id, compaction) is left alone — a subagent can legitimately run while the main thread's
script waits on its `Task` call. TTL and LRU end those.

The **synthetic reply** is written by the same sink and hooks as a driver batch, with
`message_start`/`message_delta` usage = the previous request's input / 0, through the same exit as
step 8 (`stream === true ? SSE : sseResponseToJson`). No upstream call, no auth beyond 5b's, no
stats record: nothing was billed.

Tombstones exist so the NEXT request renders the same bytes as this one: a function of history,
stored under the completion key the history gives, rendered only for the session that stored it.
A `run` output (a function of source + results) is rendered for any session; a tombstone never
overwrites one.

## History: the input builder (`code-mode/input-builder.ts`)

Built from `claudeRequest.messages`, never from the step-3 conversion, which is lossy here: it lifts
tool_result images into separate messages, synthesizes results for unanswered calls, joins
assistant text blocks and knows nothing of scripts.

- **Assistant message**: its turn record's items verbatim when one exists (how interstitial execs,
  multi-leg text and reasoning come back in order), else its text blocks; thinking blocks are never
  sent (reasoning travels as encrypted items).
- **Exec group** (the nested tool_uses of one exec, across every round trip): its reasoning and
  `custom_tool_call` ONCE at the first round; its `custom_tool_call_output` ONCE after the round
  that completed it, looked up by completion key (`batchHash` of each batch's results, in order;
  one function shared with 5r). Images are referenced, never stored, and resolved from the request
  so each appears exactly once, inside the output.
- **Record gone**: evicted → reconstructed source + `Script completed` "claudish evicted this
  script's stored output under its memory limit"; gone for any other reason → the same with
  "output unavailable after a claudish restart". Never `Script failed` for a script that resolved
  in the past.
- **Classic tool round** (a session that started classic, a `/model` switch, wrapper `_p<k>` ids,
  a stray classic call) → ONE synthetic exec (`transliterate.ts`): `call_` + 32 hex of
  sha256(first tool_use id), `Promise.allSettled([tools.Read({...}), …])` (`tools["name"]` for a
  tool absent from today's list), `Script completed` with one part per result. A request therefore
  never mixes classic `function_call` items with the exec tool — the one shape no probe proved.
- **Orphan tool_result** (its call was compacted away) → user text `[Tool Result]: <text>`, as the
  step-3 converter renders it; never dropped.
- Text beside results (reminders, hook context) → a user message right after the output (or after
  the call while the script is open).

Output is byte-identical for byte-identical history and store state. The eviction renderings are
pure functions of history plus the eviction sets, so the prompt-cache prefix changes ONCE, on the
first request after an eviction.

## Stores and their byte ceilings

Process memory only (`code-mode/stores.ts`, created by the first code-mode request); a restart
loses them, and the restart rendering covers that. Every store has a ceiling the model cannot
raise:

| Store | Ceiling | Eviction |
|---|---|---|
| suspended runtimes | 32 (one running + ≤ 31 suspended), all in the current module | LRU → record `lost`; a retired module's at once |
| suspended idle | 6 h | `expire` → `lost` |
| exec records (settled) | ≤ 2,000 AND ≤ 32 MiB (source + output text + reasoning JSON; images are references) | LRU; id kept in `evictedExecs` |
| turn records | ≤ 2,000 AND ≤ 32 MiB; one record > 8 MiB is never stored | LRU by last render; anchor kept in `evictedTurns` |
| eviction sets | ≤ 20,000 ids each (≈ 1.3 MiB) | FIFO |
| relayed batch blocks | kept only while the record is live (inputs up to 8 MiB a batch, not in the byte cap) | dropped when it settles |

A 60 s reaper applies the TTL and caps. Record states are a transition table
(`patterns/state.md`); an illegal transition is logged and coerced to `lost`, never thrown —
this runs on the request path, and a refused request is worse than a degraded script.

## The sandbox (`code-mode/sandbox/`)

QuickJS compiled to wasm, `quickjs-emscripten-core` + `@jitl/quickjs-singlefile-mjs-release-sync`
0.32.0 (the singlefile variant inlines the wasm, so `dist/` and `bun build --compile` take one
path). One module per process, loaded lazily on the first code-mode decision; one runtime + context
per script; the script suspends across Claude Code round trips as deferred QuickJS promises, so a
`Promise.all` of N calls is one batch of N tool_use blocks with no extra logic.

**Packaging spike (measured).** Module load 27 ms cold, 12 ms warm. A `bun build --target bun`
bundle (1.40 MB) ran from a directory with no `node_modules` in 12 ms; a `bun build --compile`
binary, re-signed with `codesign --force -s -`, in 22.5 ms, Promise.all suspend/resume working.
No wasm asset and no `files` change. `dist/` grew 3.37 → 4.69 MB (the variant sits behind a lazy
`init_*()`); `dist/index.js --version` 0.09 s.

**Handle ownership (measured).** A host function's RETURNED handle is consumed by the library
(`scope.manage(result)` + `QTS_DupValuePointer`): `deferred.handle.alive === false` after return,
so a runtime owns only each deferred's resolve/reject. `dispose()` is idempotent and runs on every
terminal transition, in order: unsettled deferreds, the top-level promise handle, the helper
handles, the context, the runtime. Leak test: 1,000 × (start a script suspended on 3 deferreds and
a pending top promise → dispose → run a new script) in one module: 367 ms, no error, not poisoned,
0 live after. A wasm trap or a library lifetime error anywhere poisons the module: every runtime in
it is abandoned (handles dropped, never disposed), its records go `lost`, and the next script loads
a fresh module.

**The per-runtime memory limit does NOT bound wasm memory (measured).** Under a 32 MiB
`setMemoryLimit`, `a.push("x".repeat(1024) + a.length)` grew the module's linear memory to the
2048 MiB wasm maximum in 3.8 s before QuickJS reported out of memory; `a.push({i})` reached
143 MiB. Linear memory never shrinks. So the interrupt handler also checks the module's
`HEAPU8.byteLength` (private, guarded; a module where it reads 0 logs once that the ceilings are
off): a slice that grows it past `WASM_CEILING_BYTES = 256 MiB` is stopped (`out of memory: the
script grew the sandbox's memory past claudish's limit`) and the module is RETIRED: no new script
is admitted, and every SUSPENDED runtime in it is evicted at once (its record goes `lost`; replay
re-runs it in the next module), because a suspended runtime holds the whole module and may wait on
Claude Code for hours. An idle module over 256 MiB is dropped for reload when its last runtime
ends. Admission is also gated process-wide: a new runtime is refused while the wasm memory summed
over every module still alive exceeds `PROCESS_WASM_CEILING_BYTES = 512 MiB`, so the per-module
ceiling is a per-process one too. 256 MiB, not the 1 GiB first shipped: linear memory never
shrinks, so whatever one runaway script reaches stays resident in the proxy.

**Settlement after every slice.** The top-level promise is read FIRST: fulfilled, or rejected with
the `exit()` sentinel → completed, and every outstanding call is DISCARDED (in claudish an unawaited
call never runs; in Codex it may already have run); rejected otherwise → failed; pending with calls
created in this slice → blocked; pending with none → failed (`deadlocked: the script awaits a
promise that can never settle`). `blocked([])` is unrepresentable.

| Limit (claudish policy, model-independent) | Value | When exceeded |
|---|---|---|
| QuickJS heap per runtime | 32 MiB | `failed` (out of memory) |
| CPU per script, cumulative across slices | 2 s | `failed` (`interrupted: exceeded the 2 s CPU budget`) |
| wasm linear memory per module / summed over live modules | 256 MiB / 512 MiB | slice stopped, module retired, its suspended scripts lost / new script refused |
| source | 256 KB | `failed` before running |
| calls per batch / per script | 32 / 256 | the excess call rejects with a string, so `Promise.allSettled` still finishes |
| one call input / one batch | 2 MiB / 8 MiB | that call rejects |
| tool result into the script | 1 MiB each (truncated, marked) / 8 MiB per script | rejects |
| `text()` output | 1 MiB per exec, enforced by the HOST on what it receives (a tampered prelude can waste one bounded copy, never raise the total); `text("")` adds no part; ≤ 1,024 parts (the store counts 64 bytes per part) | dropped, with a warning line; past 1,024 parts, text joins the last part |
| output tokens | `max_output_tokens` pragma clamped to [1, 50,000]; default discovery's `truncation_policy.limit` in tokens, else 10,000 | Codex's truncation header, at 4 B/token |

Why 32 MiB and 2 s: the heap limit stops one runtime's ordinary allocations; it bounds nothing
process-wide (above), which is the wasm ceilings' job. The interrupt handler can only TERMINATE a slice, never yield it (R2 §2:
`InternalError: interrupted`, 202 ms against a 200 ms budget), so the cumulative CPU budget is also
the longest one script can block the event loop, and 2 s keeps one script from pausing every
stream of a `serve` process for longer. Orchestration scripts need milliseconds. Neither value was
tuned against a measured script workload; a worker thread is the alternative if real logs show
CPU-heavy scripts.

**Isolation.** QuickJS built-ins plus four globals (`text`, `exit`, `tools`, `ALL_TOOLS`), the host
bridge closure-only behind a prelude that captures every intrinsic it uses at load (a script that
overwrites `String.prototype.slice`, `Reflect.apply` or `Function.prototype.call` cannot alter the
bridge). `SharedArrayBuffer`, `Atomics`, `WeakRef`, `FinalizationRegistry` deleted; no `console`
(as Codex); `Date` kept; `Math.random` seeded from the exec call id. Every effect goes through
`tools.*` → a `tool_use` block → Claude Code's permissions. Script errors are data: `Script failed`
with `Script error:` and the stack (line numbers mapped back to the model's input), returned to the
model, never an HTTP error.

## Not proven yet

- Phase 7 live validation (the real `auto` path ×10, edit + Bash, a mixed classic → code-mode
  history after `claude --resume`, Esc on a nested permission prompt, `--resume` across a claudish
  restart mid-script, the compiled-binary smoke). The default stays `off` until it passes.
- Reasoning replayed before a first nested call after a switch to non-code-mode (remembered under
  `toolu_cx_<hex>_0`, the A3 `_p0` rule) was never observed live.
- A login without a ChatGPT account id never gets code mode; if real logins lack it, a fallback
  identity is a follow-up, not a guess.
- `console is not defined` failures are counted in Phase 7; the model is trained on Codex's
  `exec_command` object and gets Claude Code's `Bash` string.
