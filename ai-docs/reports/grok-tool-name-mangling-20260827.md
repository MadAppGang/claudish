# Tool names are mangled on the openai-sse wire (grok-subscription)

**Date:** 2026-08-27
**Area:** Layer 1/2 stream translation, tool-call parsing
**Severity:** high — the malformed name was DISPATCHED, not only recorded
**Status:** root-caused, fixed, reproduced before and after

> This supersedes the first draft of this report. That draft named a leading
> hypothesis that is wrong, ruled out a path that is in fact the cause, and left
> the severity question open. All three are corrected below, with the runs.

---

## Summary

A `gk@grok-4.6` run recorded a tool call whose NAME is a concatenation of a tool
name, a parameter name, a type fragment, and an argument value:

```
web_search_query_listOpposed["macos security add-generic-password -X hex password flag"]
```

Three defects combined to produce it. All three are on `openai-sse`, the busiest
wire in claudish.

| # | Defect | Site |
|---|---|---|
| 1 | Text extraction ran even when the model already emitted a structured tool call | `openai-sse.ts` finalize |
| 2 | Only Pattern 5 of six had an allowlist; Patterns 0–4 had none | `tool-call-recovery.ts` |
| 3 | Pattern 0 captured `[^>]+`, so prose became a tool name | `tool-call-recovery.ts` |

---

## Environment

| | |
|---|---|
| Model spec | `gk@grok-4.6+x-ai@grok-4.6+or@x-ai/grok-4.6` |
| Provider | Grok-subscription (`"provider_name":"Grok-subscription"`) |
| Wire | `openai-sse` |
| Host | macOS (darwin 25.6.0) |

---

## Root cause

`extractToolCallsFromText` scrapes tool calls out of assistant prose, for local
models that cannot emit structured `tool_calls`. Its Pattern 0 read:

```ts
const qwenPattern = /<function=([^>]+)>([\s\S]*?)(?=<function=|$)/gi;
```

`[^>]+` accepts every character except `>`. There was no length bound, no
character class, and no allowlist. A model that opened `<function=` in prose had
every following character up to the next `>` taken as the tool name.

Running the real function against candidate inputs, before the fix:

```
--- qwen style, name swallows all
    name="web_search_query_listOpposed[\"macos security add-generic-password -X hex password flag\"]" source=xml_text args={}
    *** EXACT MATCH TO REPORTED NAME ***
--- arbitrary garbage name
    name="TOTALLY_NOT_A_TOOL_$$$" source=xml_text args={"x":"1"}
```

### What the first draft got wrong

**The leading hypothesis was wrong.** It proposed that the parser appends
`function.name` deltas without respecting index boundaries. It does not append.
The name is assigned once, inside `if (!t)`, and a later delta at the same index
is ignored (`openai-sse.ts`, structured tool-call branch). Also cleared by
inspection: the truncation map in `base-api-format.ts` only maps a short key to a
longer original; `GrokModelDialect` matches `name="([^"]+)"` so its names cannot
contain a quote; `collect-sse-message.ts` reads `block.name` without appending.

**The "Ruled out" section was wrong.** The allowlist it quotes guards **Pattern 5**
only, the natural-language pattern. Patterns 0–4 sit above it in the same
function and had no guard. A `continue` inside one loop of a six-pattern function
reads like a function-wide filter; it is not.

---

## The open question, answered: it reached the wire

`onToolCallObserved` is hooked inside `send()`, the single frame writer, not at
the `content_block_start` sites. Observation and dispatch are therefore the same
event. Driving the real `createStreamingResponseHandler` end to end, before the fix:

```
OBSERVED (goes to stats/*.json):
  "web_search_query_listOpposed[\"macos security add-generic-password -X hex password flag\"]"
DISPATCHED to Claude Code (tool_use content_block_start):
  "web_search_query_listOpposed[\"macos security add-generic-password -X hex password flag\"]"

SAME SET: YES — corruption reaches the client
```

Claude Code received a `tool_use` block naming a tool that does not exist. The
turn was lost. Severity is high, not medium.

---

## The three records explained

The stats file held three entries (`web_search`, `WebSearch`, and the malformed
one) for what looked like one or two real calls. `extractToolCallsFromText` ran
unconditionally at finalization, with no check on whether structured calls had
already arrived. One structured call plus prose mentioning a function tag, before
the fix:

```
Model made ONE structured tool call. Recorded tool names:
  "WebSearch"
  "web_search"
count = 2
```

---

## Fix

| # | Change | File |
|---|---|---|
| 1 | Skip text extraction when `state.tools.size > 0`; pass the request's advertised tool names to the extractor | `handlers/shared/stream-parsers/openai-sse.ts` |
| 2 | New optional `knownToolNames` parameter; `keepOnlyRealTools` applied to the return of all six patterns | `handlers/shared/tool-call-recovery.ts` |
| 3 | Pattern 0 bounded to `TOOL_NAME_SOURCE`; `hasExtractableFunctionTag` exported so the parser's hold-back test cannot drift from it | `handlers/shared/tool-call-recovery.ts` |
| 4 | `recordToolUse` buckets a non-identifier name under `malformed` | `handlers/shared/token-tracker.ts` |
| 5 | `TOOL_NAME_SOURCE` / `TOOL_NAME_SHAPE` as the single definition | `adapters/tool-name-utils.ts` |

Fix 3 needed fix 5's shared constant for a reason worth recording: the parser's
text hold-back test used its own loose copy of the pattern. Tightening only the
extractor would have left text that matches the hold-back test but not the
extractor withheld from the client and then never emitted, a silent text loss
with no tool call to show for it.

### After the fix

```
--- qwen style clean
    name="web_search" source=xml_text args={"query_list":"[\"macos security add-generic-password -X hex password flag\"]"}
--- qwen style, name swallows all
    (none)
--- arbitrary garbage name
    (none)
--- unclosed function tag mid-prose
    (none)
```

The legitimate recovery path, which is the reason this code exists, still works.
The duplicate-dispatch case now reports `count = 1`.

Suite: **2986 pass, 17 skip, 0 fail** (`packages/cli`).

---

## Still unknown

Grok's raw bytes were not recovered. The session directory
`/Users/jack/mag/madbench/.claude/worktrees/keychain/ai-docs/sessions/team-20260827-0015`
no longer exists, and a sweep of `/Users/jack/mag` and `~/.claude` found no
surviving copy of the malformed name. This is the `ai-docs/sessions/` loss mode
`CLAUDE.md` warns about: gitignored, and removed with the worktree.

The mechanism is proven and reproduced. The exact text Grok emitted is not known.
Confirming it needs a `gk@grok-4.6` run with `--debug` on a task that provokes a
web search.

---

## Related

The `web_search` tool itself is unimplemented: `handlers/shared/web-search-detector.ts`
is a v1 stub that warns and passes through. Tracked separately.
