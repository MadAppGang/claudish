# Compaction

**claudish can make a session's context smaller with a small Claude model, on every route.**

Compaction is off by default. When you turn it on, claudish does two things inside its proxy:

1. **Tool outputs.** A large tool output is compressed by the compaction model the first time the
   model would see it. The compressed text replaces the output in that request and in every later
   request of the session. The full output stays on disk, and the compressed text ends with a line
   that names the file.
2. **History.** When the conversation grows past a share of the model's context, claudish prepares
   a summary of the earlier turns in the background. At the next new user turn, or after the next
   complete tool round, it sends the summary in place of those turns.

Compaction runs on every route: native Claude (`claude@`, `anthropic@` and a bare Claude name) and
foreign models alike. It needs no hook, and it works in monitor sessions, where hooks do not run.

> **What leaves your machine.** The compaction model is an Anthropic model, called on Anthropic's
> API. The tool outputs it compresses and the conversation it summarises are sent to Anthropic,
> even when the session itself runs a foreign model.

---

## Turn it on

For one launch:

```bash
claudish --compaction --model claude-sonnet-5-5
claudish --no-compaction ...        # off for this launch, whatever the config says
```

With the environment:

```bash
export CLAUDISH_COMPACTION=1        # 1, true, on, yes  → on
                                    # 0, false, off, no → off
```

In the global config `~/.claudish/config.json` (or a file passed with `--config`). These are the
defaults:

```jsonc
"compaction": {
  "enabled": false,
  "model": "haiku",
  "toolOutputs": {
    "enabled": true,
    "minTokens": 4000,      // smaller outputs are never touched (estimated as characters / 4)
    "timeoutMs": 20000,     // the longest a request waits for its compressions
    "maxRatio": 0.6,        // a result longer than 60% of the original is discarded
    "skipTools": ["Read"]   // outputs of these tools are never compressed; [] skips none
  },
  "history": {
    "enabled": true,
    "policy": "threshold",  // when a ready summary is sent: threshold, early, cost or topic
    "precomputeAt": 0.6,    // start a summary at 60% of the limit
    "applyAt": 0.75         // send it at 75%, at the next user turn or complete tool round
  }
}
```

The switch is read in this order: the flag, then `CLAUDISH_COMPACTION`, then `compaction.enabled`,
then off. The other settings come from the config file only. A block claudish cannot read is
ignored with one warning; it never turns compaction on.

From an MCP session, pass the flag through: `create_session` with `claude_flags: "--compaction"`.

`claudish serve` does not support compaction. It has no `--compaction` flag, and its requests are
sent as they arrive. When `CLAUDISH_COMPACTION` or `compaction.enabled` turns compaction on, `serve`
prints one warning saying so.

## The model

`model` takes a tier alias (`haiku`, `sonnet`, `opus`) or an exact `claude-*` id. The default is
the alias `haiku`. At startup claudish resolves it from the cloud models catalog: the catalog's
alias table first, then the newest `claude-haiku-*` model it lists. The debug log names the model
it chose. A name that does not resolve to a Claude model turns compaction off for the launch, with
one warning.

## The key

Compaction signs with **your Anthropic API key** and nothing else. It is the Claude API, billed per
token.

- claudish looks for `ANTHROPIC_API_KEY` in the environment, the claudish config, the macOS
  Keychain, then 1Password, once at startup.
- With no key, compaction is off for the launch with one warning. The session starts as usual.
- It never uses your Claude login or the credentials Claude Code sends, on any route.
- The key stays in claudish's memory. It is never put into Claude Code's environment, and every log
  line and error body is redacted against it.
- If Anthropic refuses the key three times (HTTP 401), compaction turns off for the rest of the
  launch, with one warning.

To store the key in the Keychain:

```bash
claudish keychain set ANTHROPIC_API_KEY
```

## Tool outputs

A tool output is a candidate when it is text only, not an error, at least `minTokens` long, not
the advisor's, not from a tool listed in `skipTools`, not a read of the session's own recovery
files, and not a Bash command that only prints files. An output that is not a candidate gets one
debug log line on its first sighting, with the reason:
`[compaction] session <id>: tool_result <tool_use_id> (<tool>) not compressed: 3120 tokens, below minTokens 4000`.
A candidate is decided **once**, the first time it appears, before the model sees it:

- **Compressed:** the compression keeps every error line, file path, line number, identifier,
  command and number, and drops repeats, boilerplate and progress lines. The result ends with:

  ```
  [claudish compressed this output from N to M characters. Full output: <path>. Read it if you need anything that is not here.]
  ```

- **Original:** when the call fails, times out, is refused, or the result is not short enough
  (`maxRatio`), the output is sent unchanged, and it stays unchanged. claudish does not try again on
  a later turn.

Every later request sends exactly the same text. That keeps Anthropic's prompt cache valid and the
model's earlier reasoning blocks accepted. An output the model has already seen in full is never
compressed afterwards.

### Tools that are never compressed

`skipTools` lists tool names, exactly as Claude Code calls them, whose outputs are always sent as
they are. The default is `["Read"]`: the model edits files with `Edit`, which needs the file's exact
text, and a compressed `Read` drops the lines it would have to match. Set `"skipTools": []` to let
`Read` outputs be compressed too, or add a tool, such as `"Grep"`, to keep its outputs whole.

A read of the session's recovery files (any tool call whose `file_path` lies inside
`~/.claudish/compaction/<session_id>/`) is never compressed either, whatever `skipTools` says, so
the model always gets the full original it asked for.

A Bash command that only prints files is never compressed either, for the same reason as `Read`.
For example, `cd packages/cli && grep -rn "nativeRouteFor" src; cat src/providers/native-route.ts`
is not compressed. claudish counts a command as a file print only when it is made of nothing but
file printers (`cat`, `nl`, `head`, `tail`, `bat`, `less`, `more`, `sed -n '<range>p'`) and
`cd`, `pwd`, `echo`, `ls`, `wc`, `grep`, `rg`, `sort`, `uniq` or `cut`, and at least one part
prints a file. A command that runs anything else, such as `bun test` or a build, is compressed as
usual, and so is a command with a redirection into a file or a `$(…)` substitution.

### The wait

The request that carries a new large output waits for its compressions before it goes upstream,
for at most `timeoutMs` in total (20 seconds by default). Compressions of one request run in
parallel. An output still unanswered at the deadline is sent unchanged.

### Reading the full output

The original is written to `~/.claudish/compaction/<session_id>/<key>.txt` (the folder is `0700`,
the files `0600`). The model reads it with the `Read` tool when the compressed text is not enough.

So that `Read` needs no permission prompt, claudish starts Claude Code with a Read allow rule for
the session's own folder and no other:
`--allowedTools "Read(//<home>/.claudish/compaction/<session_id>/**)"`. The rule adds to any
`--allowedTools` rules of your own. claudish does not use `--add-dir` here: Claude Code asks whether
you trust each added folder, and the launch waits on that question. To know the
session id before Claude Code starts, claudish:

- uses the id you passed with `--session-id <uuid>` or `--resume <uuid>`;
- otherwise passes a new `--session-id <uuid>` itself.

In these cases the id is not known in advance, no rule is added, and Claude Code asks before it
reads a recovery file:

- `--continue` (`-c`);
- `--resume` with no id, or with a search term instead of an id;
- `--fork-session` with no `--session-id`.

### Retention

A session folder is deleted 7 days after its last write, when claudish next starts with compaction
on. A session that is still in use keeps writing to its folder, so it is not deleted. A session you
are resuming is kept. To remove everything now:

```bash
rm -rf ~/.claudish/compaction
```

## History

The **limit** of a request is the lower of two numbers:

- the context window the cloud models catalog lists for the request's model;
- the `CLAUDE_CODE_AUTO_COMPACT_WINDOW` Claude Code was started with, when there is one.

When the catalog lists no window for the model, history compaction is off for that request. The
debug log says so once per session and model:
`[compaction] session <id>: history off: the catalog publishes no context window for <model>`.

A request is measured with the **real token count**: the input tokens the model's provider
reported for the previous request of the same conversation (uncached, cache read and cache write
together), plus an estimate for the messages added since. The estimate uses the characters per
token that same report showed. Before the first report of a session, claudish uses the request's
JSON length / 4. The debug log shows the count it used:

```
[compaction] session <id>: history count 161234 of 200000 tokens (usage 158000 + ~3234 appended since)
```

- **At `precomputeAt`** (60%), claudish starts a summary in the background. The request does not
  wait for it. The summary covers every message before the latest new user turn. Inside a long
  turn of tool calls, it covers everything except the newest two tool rounds, which stay word for
  word. Tool outputs in it are cut short, and reasoning blocks are left out. A later summary starts
  from the previous one. When the conversation grows fast (for example, a run of large file
  reads), claudish starts the summary earlier, at the point where the growth it has measured would
  reach 60% before a summary started now could finish.
- **At `applyAt`** (75%), when a summary is ready, claudish sends it at the next new user turn or
  at the next request whose tool results answer every tool call before them. It never sends it
  between a tool call and its result. claudish sends one user message,

  ```
  [claudish: summary of the earlier conversation]
  <summary>
  ```

  followed by the turns the summary does not cover, with their reasoning blocks removed. Every
  later request of the session sends the same summary and the same turns.
- When the summary is sent inside a long turn, the same message also carries that turn's request
  exactly as you wrote it, after the line `[claudish: the user's request for this turn, verbatim]`.
  Your instructions are never summarised. If that request is so large that the conversation would
  still be near Claude Code's own compaction point, claudish does not send a summary.
- A conversation that does not match the one the summary was made for (a subagent) is left
  unchanged. Claude Code's own compaction request (`/compact`, or its automatic compaction) gets
  the summary already in use, and claudish starts nothing new on it.
- A summary that fails is not retried for the same point.
- A request normally never waits for a summary. One exception: when the next request would reach
  the point where Claude Code compacts on its own, and a summary is still being written, that one
  request waits for it, for at most 20 seconds, so the summary is sent first. If it is not ready
  by then, the request goes on unchanged and Claude Code's own compaction happens as before. The
  debug log shows the wait as `history waited <ms> ms`.

**Claude Code's auto-compact stays on.** It is the safety net for the case where no summary is ready
in time. Claude Code compacts near 80% of its window, so `applyAt` defaults to 75%: a ready summary
is sent first. Once claudish sends a summary, Claude Code sees a smaller input in its usage numbers
and does not compact.

On a native Claude route launched with no `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, the limit is the
catalog's window for the model, which can be larger than the window Claude Code compacts at. Claude
Code may then compact before claudish's thresholds are reached.

### When the summary is sent: `history.policy`

| Policy | Default thresholds | Sends a ready summary |
|---|---|---|
| `threshold` (default) | 0.6 / 0.75 | once the count reaches `applyAt` |
| `early` | 0.5 / 0.7 | once the count reaches `applyAt` |
| `cost` | 0.5 / (unused) | only when the swap pays for itself, see below |
| `topic` | 0.6 / 0.75 | on a new topic at a new user message, else at `applyAt`, see below |

The policy sets the default thresholds. A threshold written in the block wins.

A swap is not free. It changes the start of the prompt, so the summary and every turn after it
are written to the prompt cache again, at 1.25 times the input price for a 5-minute cache entry
or 2 times for a 1-hour one, instead of read at the cache-read price. It then saves the cache read
of the removed tokens on every later request. `cost` swaps only in one of three cases:

- the requests projected before Claude Code compacts on its own (near 83% of the limit, at the
  recent growth per request) reach the break-even count `nStar`;
- the next request is projected to cross Claude Code's compaction point, so the swap replaces
  Claude Code's own compaction;
- more time than the cache lifetime passed since the previous request, so the cache is cold
  and the request is written in full anyway.

Except on a cold cache, `cost` also holds a swap that leaves too little room: when the swapped
request would reach Claude Code's compaction point again in fewer requests than `nStar`, the next
swap would write the cache again before this one pays for itself. This holds the second case too,
and Claude Code then compacts on its own.

The prices come from the model's Claude API rates in the cloud models catalog. A model with no
published cache-read rate (any non-Claude model) gets only the last two cases. Each decision is
logged:

```
[compaction] history decision cost: hold, nStar=26.0, projected=6, requestsAfterSwap=43, L=80258, S=22, R=74004, reason=projected 6 < nStar 26.0
```

`L` is the kept tail, `S` the summary with the Claude Code system messages it keeps, and `R` the
tokens the swap removes from the request as sent. `requestsAfterSwap` is the number of requests
until the swapped request reaches Claude Code's compaction point.

### Swapping on a new topic: `history.policy: "topic"`

With `topic`, every new user message, once the history holds at least `floorTokens`, is checked
for a change of topic. On a confident new topic, the earlier history is replaced at once by its
ready summary. A follow-up that refers back to earlier work ("add a test for the fix you made
earlier") keeps the history. Near the limit, the `threshold` rule still applies.

```jsonc
"history": {
  "policy": "topic",
  "topic": {
    "decider": "haiku",          // or "embed": a local Ollama embedding model, no API cost
    "floorTokens": 30000,        // no check below this; summaries start here too
    "minConfidence": 0.7,        // a new topic below this confidence keeps the history
    "similarityBelow": 0.5,      // embed: a similarity below this is a new topic
    "timeoutMs": 5000,           // the longest a request waits for the decision
    "embedModel": "nomic-embed-text"
  }
}
```

- `haiku` asks the compaction model, with the summary and the recent turns, whether the message
  is the same task, a related one or a new one.
- `embed` compares the message with the summary and the recent turns through Ollama at
  `OLLAMA_BASE_URL` (or `OLLAMA_HOST`, default `http://localhost:11434`). If Ollama does not answer,
  the history is kept.
- History is never dropped without a summary: with no summary ready, the history is kept.
- Under `topic`, a summary is prepared at every new user message above `floorTokens`, one Haiku
  call each.

Each check is logged:

```
[compaction] topic decision haiku: new, confidence=0.92, similarity=unknown, action=swap, reason=new topic: baking, not the parser; cold cache: the swap's write costs nothing extra
```

## Cost

These figures are an **estimate** from list prices, not a measurement. The Haiku 5.5 prices used are
$0.10 per million input tokens and $0.50 per million output tokens for requests up to 100K input
tokens, as stated in the bundled `claude-api` skill (cached 2026-11-03). claudish has not verified
them.

| Work | Estimate |
|---|---|
| 30 large tool outputs of about 15K tokens each | about $0.07 |
| One history summary on a 200K limit | about $0.08 |
| A long session in total | about $0.10–0.25 |
| A session with no large output that stays under 60% of its limit | $0 |

Each compaction call is recorded in claudish's stats as a separate request (`request_role:
"compaction"`, provider `anthropic`), priced from the catalog.

## See also

- [Hooks](hooks.md), "Context tools": outside tools that make a session's context smaller.
- [Environment Variables](environment.md).
