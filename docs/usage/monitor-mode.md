# Monitor Mode

**See exactly what Claude Code is doing under the hood.**

Monitor mode is different. Instead of routing to OpenRouter, it proxies to the real Anthropic API and logs everything.

Why would you want this? Learning. Debugging. Curiosity.

---

## What It Does

```bash
claudish --monitor --debug-claudish "analyze the project structure"
```

This:
1. Starts a proxy to the **real** Anthropic API (not OpenRouter)
2. Logs all requests and responses to a file
3. Runs Claude Code normally
4. You see everything that was sent and received

---

## Requirements

Monitor mode uses your actual Anthropic credentials.

You need to be logged in:
```bash
claude auth login
```

Claudish extracts the token from Claude Code's requests. No extra config needed.

---

## Claude subscription or Claude API

Two model specs start a monitor session for you, one per Claude route:

```bash
claudish --model claude@claude-haiku-5-5      # Claude subscription: your Claude Code login
claudish --model anthropic@claude-haiku-5-5   # Claude API: billed to your ANTHROPIC_API_KEY
```

`a@` and `api@` are short for `anthropic@`. The model picker's **Claude subscription** and
**Claude API** rows start the same two sessions.

- **Claude subscription** (`claude@`): Claude Code uses its own login. claudish never signs these
  requests with an API key. If your Claude Code settings would give the session an API key or
  token (`ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` in a settings `env` block, an
  `apiKeyHelper`, auth headers in `ANTHROPIC_CUSTOM_HEADERS`), claudish refuses to start and names
  the file.
- **Claude API** (`anthropic@`): Claude Code holds only a claudish placeholder token, and claudish
  adds your key to each request on its way to Anthropic. The key never reaches Claude Code's
  environment, its tool shells or MCP servers. Each request is recorded in claudish's stats and
  cost line, priced by the model that served it.

In both, claudish's hooks do not run, and a failed request is not retried or moved to another
route: Claude Code's requests go to Anthropic as they are. Speed and mode markers (`#fast`,
`+pro`) are refused on these launches; use `/fast` and `/effort` inside the session.

Details, refusals and the behaviour in `team`, MCP and `--probe`:
[Settings Reference § 5.2.1](../settings-reference.md#521-claude-the-claude-subscription-and-the-claude-api).

---

## Debug Logs

Enable debug mode to save logs:
```bash
claudish --monitor --debug-claudish "your prompt"
```

Logs are saved to `logs/claudish_*.log`.

**What you'll see:**
- Full request bodies (prompts, system messages, tools)
- Response content (streaming chunks)
- Token counts
- Timing information

---

## Use Cases

**Learning Claude Code's protocol:**
Ever wondered how Claude Code structures its requests? Tool definitions? System prompts? Monitor mode shows you.

**Debugging weird behavior:**
Something broken? See exactly what's being sent and what's coming back.

**Building integrations:**
Understanding the protocol helps if you're building tools that work with Claude Code.

**Comparing models:**
Run the same task in monitor mode (Claude) and regular mode (OpenRouter model). Compare the outputs.

---

## Example Session

```bash
$ claudish --monitor --debug-claudish "list files in the current directory"

[claudish] Monitor mode enabled - proxying to real Anthropic API
[claudish] API key will be extracted from Claude Code's requests
[claudish] Debug logs: logs/claudish_2024-01-15_103042.log

# ... Claude Code runs normally ...

[claudish] Session complete. Check logs for full request/response data.
```

Then check the log file:
```bash
cat logs/claudish_2024-01-15_103042.log
```

---

## Log Levels

Control how much gets logged:

```bash
# Full detail (default with --debug-claudish)
claudish --monitor --log-level debug "prompt"

# Truncated content (easier to read)
claudish --monitor --log-level info "prompt"

# Just labels, no content
claudish --monitor --log-level minimal "prompt"
```

---

## Privacy Note

Monitor mode logs can contain sensitive data:
- Your prompts
- Your code
- File contents Claude Code reads

Don't commit log files. They're gitignored by default.

---

## Cost Tracking (Experimental)

Want to see how much your sessions cost?

```bash
claudish --monitor --cost-track "do some work"
```

This tracks token usage and estimates costs.

**View the report:**
```bash
claudish --cost-audit
```

**Reset tracking:**
```bash
claudish --cost-reset
```

Note: Cost tracking is experimental. Estimates may not be exact.

---

## When NOT to Use Monitor Mode

- **For production work** - Use regular mode or interactive mode
- **For OpenRouter models** - Monitor mode only works with Anthropic's API
- **For private/sensitive projects** - Logs persist on disk

---

## Next

- **[Cost Tracking](../advanced/cost-tracking.md)** - Detailed cost monitoring
- **[Interactive Mode](interactive-mode.md)** - Normal usage
