# OpenAI-Compatible Ingress (`/v1/chat/completions`)

Decision layer: `CLAUDE.md` § "OpenAI-Compatible Ingress". This file holds the translation detail.

Anthropic is the **native** ingress (`/v1/messages`). `POST /v1/chat/completions` is a **translated**
ingress: an OpenAI-format request is converted to Anthropic shape, run through the **same** routing
pipeline (`getHandlerForRequest` → `ComposedHandler.handle`), and the response translated back to
OpenAI wire shape. Everything the Anthropic path earns — routing cascade, budget failover,
accounting, leak policy — the OpenAI path inherits for free. A consumer flips onto the hub by
changing `base_url` alone.

## Request converter

`handlers/shared/format/openai-request-to-anthropic.ts`:

| OpenAI | Anthropic |
|---|---|
| `system` / `developer` role | top-level `system` field |
| `user` (string, or parts incl. `image_url`) | content blocks |
| assistant `tool_calls` | `tool_use` blocks |
| assistant `reasoning_content` | `thinking` blocks |
| `tool` role | `tool_result` |
| function tools | `input_schema` |
| `tool_choice` | mapped |
| `enable_thinking` / `chat_template_kwargs.enable_thinking` / `reasoning_effort` | `thinking` object — see #435 below |
| *(absent)* `max_tokens` | defaulted — Anthropic requires it, OpenAI does not |

## Request-side thinking controls (#435)

vLLM-style `enable_thinking` (top level, or under `chat_template_kwargs`) and OpenAI's
`reasoning_effort` were **silently dropped** by the converter until #435: the reasoning decision
fell to the served dialect's policy (`CLAUDISH_GLM_THINKING` passthrough by default = GLM thinks;
`CLAUDISH_QWEN_THINKING` disabled) and the client's ask never reached `prepareRequest`. They now
map onto the house `thinking` object — the seam every dialect already consults
(`originalRequest.thinking`):

| Client field | Mapped shape |
|---|---|
| `enable_thinking: false` | `{type: "disabled"}` |
| `enable_thinking: true` | `{type: "enabled", budget_tokens: 2048}` |
| `reasoning_effort: minimal/low/medium/high` | `{type: "enabled", budget_tokens: 2000/8000/24000/32000}` |

- Top-level `enable_thinking` wins over the `chat_template_kwargs` spelling; an unknown
  `reasoning_effort` value is ignored (no partial mapping); no controls → no `thinking` field
  (pre-#435 behavior).
- The effort ladder is the exact inverse of `openai-api-format.ts`'s budget→effort map, so an
  o1/o3 round trip (`reasoning_effort` in, budget back out) is stable.
- **Budget legality**: an enabled block always carries `budget_tokens ≥ 1024` (native Anthropic
  floor) and `< max_tokens` (Qwen requirement). Against a **client-sent** `max_tokens` the budget
  clamps into it; against **our 4096 placeholder** it instead *raises* the placeholder to
  `budget + 1` — clamping "high" (32000) to 4095 would invert the ask to "minimal" downstream.
  No room for a legal block (tiny `max_tokens`) → the mapping is skipped; dialect policy decides.

**Downstream fates** (dialect `prepareRequest`): GLM openai wire forwards `{type:"disabled"}`
verbatim and reduces an enabled block to its binary `{type:"enabled"}`; Qwen maps to
`enable_thinking` + `thinking_budget` (openai wire) or keeps the native object (anthropic wire);
o1/o3 remaps budget → `reasoning_effort`. `#435` also fixed the Qwen openai-wire passthrough,
which mapped *any* `originalRequest.thinking` to `enable_thinking: true` — inverting an explicit
disabled ask.

**Measured on the real lane (2026-10-11)**, probe proxy → hub `/v1/messages` → sonnet nominal
`gc@glm-5.3`, prompt `"Reponds exactement: ok"`, `max_tokens: 200`: no controls → **36 completion
tokens, 131 chars of `reasoning_content`**; `enable_thinking: false` → **3 completion tokens,
reasoning absent** — the 37→3 shape of the 2026-08-20 probe of record, end to end through the
ingress. Pins: `openai-request-to-anthropic.test.ts` (mapping matrix),
`qwen-model-dialect.test.ts` + `glm-model-dialect.test.ts` (dialect ends).

## Response translators

`handlers/shared/anthropic-to-openai.ts`:

- `anthropicMessageToChatCompletion` — non-streaming: collected message → `chat.completion` JSON,
  computes `total_tokens`.
- `createOpenAIChatStreamFromAnthropic` — streaming: Anthropic SSE → `chat.completion.chunk` SSE,
  terminated by `data: [DONE]`.

`thinking` blocks surface as `reasoning_content` (the OpenAI extension DeepSeek and GLM use).
`stop_reason` maps to `finish_reason`: `end_turn`/`stop_sequence` → `stop`, `tool_use` →
`tool_calls`, `max_tokens` → `length`.

**A reasoning model can spend the whole `max_tokens` budget before any text** (measured
2026-10-22, RSM condensation probe): `/v1/chat/completions` with `model: "claude-sonnet-5-5"`
served by the GLM lane at `max_tokens: 2000` returned **no text with `finish_reason: "length"`**
after 25.6 s: `reasoning_content` is billed out of the same `max_tokens` as `content`, and the
reasoning consumed it all before a text block started. On the JSON (non-streaming) response,
`choices[0].message.content` is then **`null`**; on the streaming response no `content` delta
arrives. A consumer that reads only `content` gets no answer and no error, and one that calls
a string method on it throws. Mitigations: raise `max_tokens`, or send `enable_thinking: false`
or `reasoning_effort` (mapped per #435; honored by the DeepSeek dialect under `passthrough`
since #612). Alternatively, use `/v1/messages`: it shares the same budget, but exhaustion is
*visible* there (a `thinking` block plus `stop_reason: "max_tokens"`).

**Never-hang holds on this path**: a malformed stream degrades to a single terminal chunk plus
`[DONE]` rather than stalling the consumer.

## Failover notices (#229)

On this route a failover notice is **never** written into the
content. It is set as the `x-claudish-failover-notice` response header, whose value is base64 of the
UTF-8 notice text (header values are single-line ASCII; the notice is multi-line markdown). It is
present on both the streaming and the non-streaming response, and a relay passes it through from the hub.

Why: the notices exist for an agent in the loop, which recalibrates when told its model changed
(#126). A programmatic consumer cannot, and for it a notice in the content IS the answer. Measured
on 2026-09-23: a code-review step whose entire content was the recovery notice over an empty model
output, so an empty-output guard never fired. The discriminator is the route
(`noticePolicyForIngress` in `handlers/shared/failover-stream-notice.ts`) and deliberately not the
user-agent, which drifts with client versions. `/v1/messages` keeps the in-content notice.

Route-level pin: `proxy-server-openai-notice.test.ts` (header present, content byte-clean, inert
when nothing is armed).

## Relay behavior

`relay.ts` is **path-aware**: a sidecar forwards to the SAME route the client hit, so an OpenAI
request on a sidecar reaches the hub's `/v1/chat/completions` in NOMINAL mode. That preserves the
whole resilience model rather than special-casing one ingress. The deep liveness probe stays on
`/v1/messages`.

## Out of scope (for now)

`/v1/models` discovery · OpenAI web-search tool interception · per-role thinking policy on the
OpenAI path.


---

# Migrated verbatim from the repo-level `CLAUDE.md` (#445 A1, 2026-10-12)

## OpenAI-Compatible Ingress (v7.2+)

`/v1/messages` is the **native** ingress; `POST /v1/chat/completions` is a **translated** one — converted to Anthropic shape, run through the **same** `getHandlerForRequest` → `ComposedHandler.handle` pipeline, then translated back. An OpenAI client (sk-agent, any `AsyncOpenAI` consumer) therefore inherits the routing cascade, budget failover, accounting and leak policy for free, by changing `base_url` alone.

- **Never-hang holds here too**: a malformed stream degrades to a single terminal chunk + `data: [DONE]`. `thinking` blocks surface as `reasoning_content`; `stop_reason` maps to `finish_reason`.
- **Request-side thinking controls are mapped (#435)** — `enable_thinking` (top level or under `chat_template_kwargs`) and `reasoning_effort` land on the house `thinking` object: `false` → `{type:"disabled"}`, `true` → enabled with a 2048 default budget, effort → the inverse of `openai-api-format`'s budget ladder (2000/8000/24000/32000). An enabled block is always legal (≥1024, `< max_tokens`): against a client-sent `max_tokens` it clamps; against our own 4096 placeholder it *raises* the placeholder — clamping "high" to 4095 would invert the ask to "minimal" downstream. Same fix closes the Qwen openai-wire passthrough, which mapped *any* `originalRequest.thinking` to `enable_thinking: true` — the exact inversion of a disabled ask. Measured end-to-end on gc@glm-5.3 via the hub (2026-10-11): 36→3 completion tokens, reasoning gone.
- **A failover notice never rides the content here (#229)** — it arrives in the `x-claudish-failover-notice` response header (base64 of the UTF-8 text), on both the streaming and JSON responses, and the relay passes it through. `/v1/messages` keeps the in-content block 0 for the Claude Code agent loop. The gate is the route (`noticePolicyForIngress`), never a user-agent: a programmatic consumer reading a notice as its answer is how an empty model output passed a code review on 2026-09-23.
- **The relay is path-aware** — a sidecar forwards to the *same* route the client hit, so an OpenAI request reaches the hub's `/v1/chat/completions` in NOMINAL mode and the resilience model is preserved. The deep liveness probe stays on `/v1/messages`.
- Out of scope for now: `/v1/models` discovery, OpenAI web-search interception, per-role thinking policy on this path. Detail: `docs/reference/openai-ingress.md`.
