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
files, and not a Bash command that only prints files. It is decided **once**, the first time it appears, before the model sees it:

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

So that `Read` needs no permission prompt, claudish starts Claude Code with
`--add-dir ~/.claudish/compaction/<session_id>/`, the session's own folder and no other. To know the
session id before Claude Code starts, claudish:

- uses the id you passed with `--session-id <uuid>` or `--resume <uuid>`;
- otherwise passes a new `--session-id <uuid>` itself.

In these cases the id is not known in advance, no folder is added, and Claude Code asks before it
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

When the catalog lists no window for the model, history compaction is off for that request.

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
  from the previous one.
- **At `applyAt`** (75%), when a summary is ready, claudish sends it at the next new user turn or
  at the next request whose tool results answer every tool call before them. It never sends it
  between a tool call and its result. claudish sends one user message,

  ```
  [claudish: summary of the earlier conversation]
  <summary>
  ```

  followed by the turns the summary does not cover, with their reasoning blocks removed. Every
  later request of the session sends the same summary and the same turns.
- A conversation that does not match the one the summary was made for (a subagent, or after
  Claude Code's own `/compact`) is left unchanged.
- A summary that fails is not retried for the same point. Nothing waits for it.

**Claude Code's auto-compact stays on.** It is the safety net for the case where no summary is ready
in time. Claude Code compacts near 80% of its window, so `applyAt` defaults to 75%: a ready summary
is sent first. Once claudish sends a summary, Claude Code sees a smaller input in its usage numbers
and does not compact.

On a native Claude route launched with no `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, the limit is the
catalog's window for the model, which can be larger than the window Claude Code compacts at. Claude
Code may then compact before claudish's thresholds are reached.

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
