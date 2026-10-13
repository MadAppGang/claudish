# Wire reader: build every request from the connection's `wire`

Date: 2026-10-12. Branch `worktree-gpt-routing-fix`, rebased on v10.4.1 (`2e4ac246`).
Spec: Models Index `ai-docs/claudish-wire-requirements.md` (R1–R13, acceptance §4) and
`ai-docs/claudish-catalog-3.7.0.md`, both in the models-index repo. Live generation at writing:
`g-20261012101007285-7770c36e`.

## Why

v10.4.1 is the latest release and is broken against catalog 3.7.0, which has been live since
2026-10-08. `OpenAIAPIFormat.tokenParamName()` applies the model-level `tokenParam` to every chat
body. Since 3.7.0 that field describes the owner's direct connection only, so GPT and Grok chat
requests to gateways carry `max_output_tokens`.

- About 150 chat connections are affected.
- `fireworks@qwen3.8-max` answers 400 (reproduced).

There is no hotfix. Jack chose the full reader, with no backward compatibility.

## Where claudish departs from the backend spec (Jack's decisions)

| Topic | Backend spec | claudish |
|---|---|---|
| Effort not in `effort.values` | refuse (R3) | **clamp to the nearest published value** (C2) |
| `reasoning` / `tokenParam` `unknown` on a known wire | send nothing (R3) | **try in turn**: the owner's direct connection value when it is on the same `api`, then without it after a 400 that names the field. A different `api` has nothing to borrow, so send nothing. Every fallback is logged as a catalog gap. |
| `wire.status: unknown` | profile `apis` in fixed order, advance on protocol mismatch (R4) | same, any order is fine (3.2); remembered per connection until the next generation |
| No catalog | wait, or fail clearly (R4) | local providers only (C7), which already holds for bare names |
| `qtoken@` host | registry `qwencloud-token-plan` is "a different product" | same product, same key (C4): use the registry host; confirm live with Jack's key |
| Pro / speed syntax | `--mode pro`, `--speed fast` suggested (R13) | `model+pro`, `model#fast`, `model+pro#flex` |

Pro mode is kept. `proOnUltracode` still turns it on under ultracode, but only where the
connection's `wire.reasoning.mode` is `supported` with `pro`.

## Phases (one commit or more each, tests authored by Codex, run by a subagent)

### P1. Data: registry and connection wire (R1, R2, R6)

- **Types.** `ConnectionWire`, `WireControl`, `WireReasoningWarning` and the registry, in one
  module. `AggregatorEntry` / `SlimModelEntry` gain `wire`.
- **Fetch.** `catalog-client.ts` refreshCatalog fetches `catalog=routes&generationId=<same>` after the
  slim pages. If the `generationId` differs, refetch both. The registry is stored in the same cache
  file.
- **Validation.**
  - Reject a 3.7.0+ cache that has a mapped connection without `wire`.
  - Reject a `known` wire whose `api` is missing from its profile's `apis`.
- **Memoize** the cache read by mtime: the request path reads it on every request.
- **`resolveConnection(provider, modelName)`** returns `{route, externalModelId, wire, baseUrlFor(api)}`.
  - Uses exact route binding plus exact wire id; never family or sibling.
  - This is the only source of request decisions.
- **Model-level `tokenParam` / `endpoints` leave every request path.** Model-level `reasoning` stays
  for the effort vocabulary only.

### P2. Thread the connection through the pipeline

The connection travels `RouteCandidate` → `ProfileContext` → `ComposedHandlerOptions`. The
gatherer keeps the connection it already holds (`route-candidates.ts:204`) and skips `unsupported`
connections. An explicit `provider@model` resolves the connection the same way. Dynamic
subscriptions (`gk@`, `ag@`, `dv@`) keep their own discovery and are out of scope (R4).

### P3. Request building from `wire` (R3, R8, R9)

- **RFC 6901 pointer writer.** One helper, unit-tested with `~0` / `~1`.
- **Adapter by `wire.api`:**
  - chat → `OpenAIAPIFormat`;
  - responses → a new generic `ResponsesAPIFormat`, with the Codex extras only on
    `openai/codex-subscription`;
  - messages → Anthropic;
  - gemini → Gemini.
- **URL:** registry `baseUrl` plus the suffix. User env/config base-URL overrides stay, logged.
- **Token limit at `wire.tokenParam`.** Gemini keeps `generationConfig.maxOutputTokens`.
- **Reasoning:**
  - `enable` / `disable` / `effort` at their pointers;
  - effort clamped to the nearest published value;
  - `effort.default` when the user picked none;
  - `disable: not_applicable` means reasoning cannot be turned off, and the user is told.
- **`toolsWithReasoning`:**
  - `requires-responses`: drop reasoning when tools are present, and log it;
  - `requires-effort-none`: send `values.none` or no effort.
- **Warnings.** A `served_model_changes` part (Kimi Code `k3` disable → K2.8 Preview) is never sent
  silently.
- **Poe** keys go at the body root, never under `extra_body`.
- **OpenCode** requests send `x-opencode-session`; OpenCode Messages uses `x-api-key`.

### P4. `unknown` and `unsupported` (R4)

- `unsupported`: no request, and an error that names the connection and the protocol.
- `unknown` wire: try the profile's `apis` in turn, advancing only on 404, 405 or a 400 that names
  the protocol. Never advance on 401, 403, 429, 5xx or a network error. Remember what worked per
  connection until the next generation.
- `unknown` sub-fields: try in turn (table above), through a new arm of the parameter-recovery
  retry (`composed-handler.ts:1440`), which today can only drop `stop`/`top_p` or step Grok effort
  down.

### P5. Pro and speed (R13)

- **Parser.** `model-parser.ts` reads `+pro` and `#<speed>`; `:N` stays as concurrency for local
  providers. No catalog id contains `+` or `#`, but `-pro` (102 ids) and `-fast` (22) are real
  models, so a dash suffix can never be used.
- **Validation.** Each value is checked against the connection's control.
  - Unsupported: an error that lists what the connection offers.
  - `rejected`, `unknown`, `not_applicable`: never sent.
- **Sending.**
  - The native value goes at the control's `path`.
  - `headers` use append-comma, without duplicates.
  - Standard is `values.standard`, otherwise the field is omitted.
  - `access` `entitlement` or `usage-credits`: the 429 is surfaced and never retried in a loop.
- **Pro source.** `pro-injection.ts` moves its source to `wire.reasoning.mode`. That also
  removes its hardcoded `{reasoning:{mode:"pro"}}` pointer.

### P6. Delete the name rules (R5, R7, R10, R11, R12)

- **What goes.** Everything listed in R5:
  - `requiresResponsesApi`, the `openCodeZenProfile` family list, `includes("codex")` in
    `transport/openai.ts`;
  - `tokenParamName`'s fallback, `clampOpenAIEffortByName`, `isGpt51Plus` / `isOSeries`;
  - `clampCodexEffort` / `acceptsXhigh` / `acceptsMax`;
  - `SEED_REJECTS`;
  - each dialect's `shouldHandle` as a routing decision;
  - the name-picked thought-signature middleware and `isNativeAnthropic`, plus the other name rules
    in R5's list.
- **Dialects.** Any that survive are pure body transforms that the wire selects.
- **Hosts.** Hardcoded hosts for catalog-routed providers come from the registry.
- **`oc@`.** Moves to `https://ollama.com/v1` with plain ids and keeps its tools. The native
  `/api/chat` stays for local Ollama only.
- **Custom endpoints.** These use only what the user declares.
- **The advisor** resolves a connection like any request.
- **Grep test** (§4.1.5) pins the deletions.
- **Kept.** Local-only behaviour (`local-adapter.ts`, the MiniMax temperature clamp) stays.

### P7. Verify

- **Unit (§4.1).** The table is built from a real fixture: a trimmed subset of a sealed
  generation's models plus its registry, never hand-written rows.
- **Route-table gate.** `scripts/route-table-snapshot.ts capture` runs BEFORE P2 and
  `diff` runs after P6, on the same generation.
- **Live (§4.2).** One tool call per routable connection of the recommended models, using
  claudish's own credentials. The redacted exchanges go in the release PR.
- **Blocked.** OpenCode Zen and Go wait until the account is funded; both sides get 402 today.

## Recommended-model gaps at writing

13 of 17 recommended models have a gap on at least one connection. That is 36 of 85 connections:

| Cause | Connections | Fix |
|---|---|---|
| OpenCode, blocked on funding | 16 | Fund the OpenCode account. |
| Gateway probes | 13 | The backend's probes. |
| Vendors' own documented APIs (Gemini 2, Mistral, `grok-build-0.1`, MiniMax coding-plan effort) | 5 | Report to the backend. |
| Claude through native passthrough | 2 | Not used by claudish. |

Script: `ai-docs/sessions/gpt-grok-routing-20260926-231500-a1f3/recommended-gaps.ts`.
