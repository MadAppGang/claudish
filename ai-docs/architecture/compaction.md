# Compaction — claudish's own context compaction

`--compaction` (`CLAUDISH_COMPACTION=1`, `compaction.enabled`) makes a session's context smaller
with a small Claude model on the Claude API: large tool outputs are compressed once, on first
sighting, and the earlier conversation is replaced by a summary at a human-turn boundary. Code:
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
6. **History swaps** happen only when the last message starts a new human turn: a user message
   with user text and NO `tool_result` block (Claude Code adds text blocks beside tool results, so
   "has text" alone would swap inside a tool round). A swap strips `thinking` and
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

## History swap shape (`compaction/history.ts`)

- **Limit** = min(the request model's catalog context window, the `CLAUDE_CODE_AUTO_COMPACT_WINDOW`
  this launch gave Claude Code). The runner records the child env's value
  (`setLaunchAutoCompactWindow`, clamped to Claude Code's 100K floor and 1M ceiling) just before
  the spawn. No catalog window ⇒ history off for that request. The model is the one the proxy
  routes the request to (`resolveHandlerForRequest`'s target after the slot map, role mapping and
  `--model`; the bare id for `claude@<id>`), never the raw `body.model`: a role mapping can send
  `claude-sonnet-*` to a model with a smaller window, or none. A `[1m]` suffix is removed for the
  lookup. The catalog window comes from the named provider for `provider@model`, the Claude API
  connection for `claude-*`, else the model's own.
- **Measure** with `localTokenEstimate` (`token-estimate.ts`, JSON length / 4), the same number
  `count_tokens` answers with locally.
- **Prepare** at `precomputeAt`, in the background, never awaited. Boundary `b` = the start of the
  last human turn. Messages `[0, b)` are rendered as plain text (tool_results in the form this
  request sends, cut to 2,000 characters; no thinking; the whole input capped at 400,000
  characters by dropping the oldest messages after the first). A summary rolls forward from the
  newest ready summary below `b`. `max_tokens` 8192, claudish's own system prompt. One summary in
  flight per (session, thread); the thread is the hash of the first message.
- **Apply** at `applyAt`, when a summary is ready and the last message starts a human turn:
  `[user "[claudish: summary of the earlier conversation]\n<summary>"]` + messages `[b, end)`
  without thinking + messages after `end` unchanged. Recorded as a `history-swap` with
  `(prefixHash over [0,b), tailHash over [b,end), b, end)`, and replayed on every later request
  whose two hashes match. Hashes are taken over canonical JSON (sorted keys) of the messages as the
  tool-output pass left them.
- A request with another prefix (Claude Code's own `/compact`, a subagent's transcript) matches no
  swap and is untouched. Several threads per session are possible; records are keyed by prefix
  hash.
- A summary that fails is recorded `failed` for its boundary and never retried there. A swap whose
  record did not reach disk is not sent (it could not be replayed after a restart).

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
~/.claudish/compaction/<session_id>/     0700   (also the only --add-dir)
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
files alone would let a second claudish starting at that moment delete a live session's folder. `--add-dir` names the session's own folder only, so no session can Read another's
outputs. The session id is known before Claude Code starts (`--session-id`, `--resume <uuid>`, or
one claudish mints); with `--continue`, a bare `--resume` or `--fork-session` alone, no
folder is added and Read asks for permission.

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
