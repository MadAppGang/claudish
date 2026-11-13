# Interactive Mode

**The full Claude Code experience, different brain.**

This is how most people use Claudish. You pick a model, start a session, and work interactively just like normal Claude Code.

---

## Starting a Session

```bash
claudish
```

That's it. No flags needed.

You'll see the model selector:

```
╭──────────────────────────────────────────────────────────────────────────────────╮
│  Select an OpenRouter Model                                                      │
├──────────────────────────────────────────────────────────────────────────────────┤
│  #   Model                             Provider   Pricing   Context  Caps       │
├──────────────────────────────────────────────────────────────────────────────────┤
│   1  google/gemini-3-pro-preview       Google     $7.00/1M  1048K    ✓ ✓ ✓      │
│   2  openai/gpt-5.1-codex              OpenAI     $5.63/1M  400K     ✓ ✓ ✓      │
│   ...                                                                            │
╰──────────────────────────────────────────────────────────────────────────────────╯

Enter number (1-7) or 'q' to quit:
```

Pick a number, hit Enter. You're in.

---

## Claude in the Selector

The provider list starts with two Claude rows:

- **Claude subscription**: Claude models on your own Claude Code login. Listed when Claude Code
  is signed in; an Anthropic API key does not count. Prices show `SUB`.
- **Claude API**: Claude models on Anthropic's API, billed per token to your `ANTHROPIC_API_KEY`.
  Listed when a key is in your environment, `~/.claudish/config.json`, the macOS Keychain or
  1Password. Without one the row is hidden; `k` shows it as `needs ANTHROPIC_API_KEY`, and with
  the cursor on it the hint line names where claudish looked: `looked in: env, config, Keychain,
  1Password`.

Picking a model under either row starts a [monitor-mode](monitor-mode.md#claude-subscription-or-claude-api)
session, the same as `--model claude@<id>` or `--model anthropic@<id>`.

---

## Skip the Selector

Already know which model you want? Skip straight to it:

```bash
claudish --model x-ai/grok-code-fast-1
```

This starts an interactive session with Grok immediately.

---

## What You Get

Everything Claude Code offers:

- **File operations** - Read, write, edit files
- **Bash commands** - Run terminal commands
- **Multi-turn conversation** - Context persists across messages
- **Project awareness** - Reads your `.claude/` settings
- **Tool use** - All Claude Code tools work normally

The only difference is the model processing your requests.

---

## Auto-Approve Mode

By default, Claudish runs with `--dangerously-skip-permissions`.

Why? Because you're explicitly choosing to use an alternative model. You've already made the decision to trust it.

Want prompts back?
```bash
claudish --no-auto-approve
```

Now it'll ask before file writes and bash commands.

---

## Verbose vs Quiet

**Default behavior:**
- Interactive mode: Shows `[claudish]` status messages
- Single-shot mode: Quiet by default

**Override:**
```bash
# Force verbose
claudish --verbose

# Force quiet
claudish --quiet
```

---

## Using a Custom Model

See option 7 in the selector? That's your escape hatch.

Any model on OpenRouter works. Just enter the full ID:

```
Enter custom OpenRouter model ID:
> mistralai/mistral-large-2411
```

Boom. You're running Mistral Large.

Or skip the selector entirely:
```bash
claudish --model mistralai/mistral-large-2411
```

---

## Session Tips

**Switching models mid-session?** You can't. Exit and restart with a different model.

**Context window exhausted?** Start fresh. Or switch to a model with larger context (Gemini 3 Pro has 1M tokens).

**Model acting weird?** Some models handle tool use differently. If file edits are broken, try a different model.

---

## Keyboard Shortcuts

Same as Claude Code:

- `Ctrl+C` - Cancel current operation
- `Ctrl+D` - Exit session
- `Escape` - Cancel multi-line input

---

## Environment Variable Shortcut

Set a default model so you don't have to pick every time:

```bash
export CLAUDISH_MODEL='x-ai/grok-code-fast-1'
claudish  # Now uses Grok by default
```

Or the Claude Code standard:
```bash
export ANTHROPIC_MODEL='openai/gpt-5.1-codex'
```

`CLAUDISH_MODEL` takes priority if both are set.

---

## Next

- **[Single-Shot Mode](single-shot-mode.md)** - For automation and scripts
- **[Model Mapping](../models/model-mapping.md)** - Different models for different roles
