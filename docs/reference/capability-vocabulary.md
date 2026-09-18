# Negotiated Capability Vocabulary (#83) — design

Status: **wired (grain 2, 2026-09-18) — gate `CLAUDISH_CAPABILITY_VOCAB` default off, so the
feature is inert on every machine until an operator opts in.**
User directive 2026-09-08 (pivot mandate, track 2): propose a vocabulary of injected messages
that interrogate the session on the capabilities it needs at each condensation — the proxy and
the session negotiate, instead of the proxy guessing from model ids.

Companion track: #82 (semantic-fleet routing absorption) consumes these signals once they exist.
Family precedent: routing changes get specified (#79, #21), arbitrated, then built.

## 1. What is being negotiated

Five fields, each mapping to a routing lever that already exists in the proxy:

| Field | Type | Routing lever it feeds |
| --- | --- | --- |
| `vision` | `boolean` | step selection on vision-capable lanes (a blind substitute turns an image-bearing session into deterministic 400s — the PDF-blind-model incident) |
| `context_tokens_min` | `number` | window pre-flight (#79): skip any step whose context window is smaller than the session's declared floor |
| `reasoning_depth` | `low \| medium \| high` | thinking-policy flips (`CLAUDISH_QWEN_THINKING`, `CLAUDISH_GLM_THINKING`) — a declared `low` licenses `disabled` on the next step |
| `tool_call_density` | `low \| medium \| high` | lane preference where tool-heavy loops block (sub-agent blocking class) |
| `cost_class` | `budget \| any` | whether the session accepts the PAYG tail of a cascade or should stay on subscription lanes |

Anything outside this whitelist is dropped by the parser. A declaration is a *weak preference
signal* — see §5 — never a routing command.

## 2. Wire format

The declaration is a fenced code block with a stable info-string marker, written by the model
in its own next assistant message:

````
```claudish-needs
{"v":1,"vision":true,"context_tokens_min":200000,"reasoning_depth":"medium"}
```
````

Why a fence and not bare JSON: the info string `claudish-needs` is the marker — greppable,
survives markdown rendering, and cannot collide with prose. Why model-authored text and not a
tool call for v1: see §4.

## 3. Injection moment — the condensation rail

The query rides the existing notice rail (`buildFailoverNotice` / `appendFailoverNoticeToMessage`
in `fork/failover.ts`): the `/compact` response is the one moment the context is rebuilt anyway,
so an appended block costs no extra interruption. Composition rules for the wiring grain:

- Appended **after** any failover/recovery notice, separated by `---`, under the same
  `[claudish]` sender label — one origin, never two.
- **Trigger policy**: ask while the session has no declaration on record, capped at
  `CAPABILITY_QUERY_MAX_ASKS = 3` condensations (a session that has not declared after three
  asks is saying "nothing to declare" by silence — stop spending its context on the question).
- **Session key**: same `extractSessionKey()` seam as the per-session dwell (#91 point 4) —
  declarations are per-conversation, never global.
- Gated by `CLAUDISH_CAPABILITY_VOCAB` (default **off**) — read per request like the thinking
  knobs, so the fleet can flip it during a crunch without a restart.

The query text (built by `buildCapabilityQuery()`) is factual: it states what the router does
today, offers the declaration channel, and says exactly what a declaration can and cannot do.
It never touches risk posture, scope of work, or prior decisions — the 2026-08-23 doctrine,
applied verbatim.

## 4. Return path — options weighed

| Option | Arrival | Verdict |
| --- | --- | --- |
| **a. Transparent text block (v1)** | model writes the fence in its next assistant message; proxy parses it from the outbound text | **Recommended.** Zero conversation mutation — the block stays visible (no invisible content surgery), needs no client cooperation, survives every CC path that carries assistant text. Cost: one small block of client-visible output. |
| b. Proxy-injected MCP tool | proxy adds a `claudish_declare_needs` tool; declaration arrives as `tool_use` | Cleaner arrival, but requires web-search-interception-grade machinery (tool injection, call interception, synthetic `tool_result` injected into the conversation) — heavy mutation for a signal this soft. Candidate v2 if v1 declarations prove noisy. |
| c. Client echo header | CC repeats the declaration in a request header | Rejected: needs client-side changes we do not control. |

For v1 the lift happens at response finalization (stream) and on the collected message
(non-stream), keyed by session. **The block is parsed, not stripped** — transparency is the
design decision, not an oversight: stripping model-authored text the client would otherwise see
is exactly the invisible-mutation class #65 §4 and #82's non-goals forbid.

## 5. Trust boundary

A self-declaration ranks **below** every measured signal. Concretely, in the wiring grain:

- It can *reorder preference* among steps that are all servable (e.g. prefer a vision-capable
  step when `vision: true`).
- It can *raise a floor* (`context_tokens_min` participates in #79's pre-flight the same way a
  measured context size does).
- It can **never**: override the leak policy, bypass `isQuotaExhaustion` arming, un-wall a
  backoff-failed step, or promote PAYG when the operator has not configured it as a step.
- Declarations expire with the session. Nothing is persisted, aggregated, or attributed beyond
  the conversation that made them.

A malicious or confused session declaring `{"cost_class":"any"}` at worst states a preference
the router was already free to ignore — the schema-validated whitelist is the whole attack
surface, and it contains no verbs.

## 6. Client compatibility

- The declaration is **outbound** (assistant text) — the inline `role:"system"` hoisting paths
  touch inbound requests only, so they cannot mangle it.
- The fence survives markdown rendering and CC's condensation rewrite (the block is re-emitted
  as part of the summary the client keeps, which is also why the parser takes the *last*
  occurrence in a message: latest declaration wins).
- Malformed JSON, wrong `v`, unknown fields, wrong enum values: the parser drops the field or
  the whole block, returns `null`, and the session is simply undeclared. Nothing throws —
  same contract as the notice rail.

## 7. What landed

**Grain 1 (inert, #133)** — `packages/cli/src/fork/capability-vocabulary.ts` + tests:

- `buildCapabilityQuery()` — the factual query block.
- `parseCapabilityDeclaration(text)` — strict, never-throws lifter; last-block-wins; whitelist +
  enum validation; `null` when absent or nothing valid survives.
- `isCapabilityVocabEnabled(env)` — the `CLAUDISH_CAPABILITY_VOCAB` gate, default off.
- `CAPABILITY_VOCAB_FENCE`, `CapabilityDeclaration`, `CAPABILITY_QUERY_MAX_ASKS`.

**Grain 2 (wiring, 2026-09-18, arbitrated by ai-01 the same day)** — same module + `proxy-server.ts`:

- Per-session channel state keyed on `extractSessionKey` (the #91 p4 dwell seam — one definition
  of session identity, FIFO-evicted at 512 entries).
- `liftCapabilityDeclaration(sessionKey, payload)` — scans the trailing 6 assistant messages on
  each `/v1/messages` request (gate on); the first successful parse registers and short-circuits
  every later scan. Malformed/degenerate history → undeclared, never throws (K3 echo-loop
  regression fixture).
- `appendCapabilityQueryToMessage(message, sessionKey, env)` — appends the query to the
  **non-streaming** response at the condensation rail (the `applyFailoverNotices` seam), at most
  `CLAUDISH_CAPABILITY_QUERY_MAX_ASKS` times per session while undeclared (default 3, `0` =
  never ask, re-read per call), stopping the moment a declaration lands.
- The arbitration's added requirement (18/09, after the K3 degeneration episodes of 13-14 and
  17/09): degenerate echo-loop text carrying a *malformed* `claudish-needs` fence must arm
  nothing and leave the session eligible for later asks — covered by a dedicated regression test.

With the gate off (the default) the wired path is: one `isCapabilityVocabEnabled` check per
request, zero work beyond it. Route: lift sits before `getHandlerForRequest` in `/v1/messages`
(after the relay branch, so relayed requests stay untouched — the hub owns them); the append
sits at the end of the return chain, after `applyFailoverNotices`.

Ties: #21 (cost-aware routing — this is its intelligence input), #79 (window pre-flight),
#65 (same injection family, same surface-not-terminal discipline), #91 point 4 (the session-key
seam), the 2026-08-23 notice doctrine.
