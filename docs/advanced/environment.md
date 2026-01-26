# Environment Variables

**Every knob you can turn. Complete reference.**

---

## Required

### `OPENROUTER_API_KEY`

Your OpenRouter API key. Get one at [openrouter.ai/keys](https://openrouter.ai/keys).

```bash
export OPENROUTER_API_KEY='sk-or-v1-abc123...'
```

**Without this:** Claudish will prompt you interactively in interactive mode, or fail in single-shot mode.

---

## Model Selection

### `CLAUDISH_MODEL`

Default model when `--model` flag isn't provided.

```bash
# Auto-detected routing (model name determines provider)
export CLAUDISH_MODEL='gpt-4o'              # → OpenAI
export CLAUDISH_MODEL='gemini-2.0-flash'    # → Google
export CLAUDISH_MODEL='llama-3.1-70b'       # → OllamaCloud

# Explicit provider routing (new @ syntax)
export CLAUDISH_MODEL='google@gemini-2.5-pro'
export CLAUDISH_MODEL='openrouter@deepseek/deepseek-r1'
```

Takes priority over `ANTHROPIC_MODEL`.

### `ANTHROPIC_MODEL`

Claude Code standard. Fallback if `CLAUDISH_MODEL` isn't set.

```bash
export ANTHROPIC_MODEL='gpt-4o'  # Auto-detected → OpenAI
```

---

## Model Mapping

Map different models to different Claude Code tiers.

### `CLAUDISH_MODEL_OPUS`
Model for Opus-tier requests (complex planning, architecture).
```bash
export CLAUDISH_MODEL_OPUS='gemini-2.5-pro'           # Auto-detected → Google
export CLAUDISH_MODEL_OPUS='google@gemini-2.5-pro'    # Explicit
```

### `CLAUDISH_MODEL_SONNET`
Model for Sonnet-tier requests (default coding tasks).
```bash
export CLAUDISH_MODEL_SONNET='gpt-4o'                 # Auto-detected → OpenAI
```

### `CLAUDISH_MODEL_HAIKU`
Model for Haiku-tier requests (fast, simple tasks).
```bash
export CLAUDISH_MODEL_HAIKU='llama-3.1-8b'            # Auto-detected → OllamaCloud
export CLAUDISH_MODEL_HAIKU='mm@MiniMax-M2'           # MiniMax direct
```

### `CLAUDISH_MODEL_SUBAGENT`
Model for sub-agents spawned via Task tool.
```bash
export CLAUDISH_MODEL_SUBAGENT='llama-3.1-8b'         # OllamaCloud
```

### Fallback Variables

Claude Code standard equivalents (used if `CLAUDISH_MODEL_*` not set):

```bash
export ANTHROPIC_DEFAULT_OPUS_MODEL='...'
export ANTHROPIC_DEFAULT_SONNET_MODEL='...'
export ANTHROPIC_DEFAULT_HAIKU_MODEL='...'
export CLAUDE_CODE_SUBAGENT_MODEL='...'
```

---

## Network Configuration

### `CLAUDISH_PORT`

Fixed port for the proxy server. By default, Claudish picks a random available port.

```bash
export CLAUDISH_PORT='3456'
```

Useful when you need a predictable port for firewall rules or debugging.

---

## Read-Only Variables

### `CLAUDISH_ACTIVE_MODEL_NAME`

Set automatically by Claudish during runtime. Shows the currently active model.

**Don't set this yourself.** It's informational.

---

## Example .env File

```bash
# Required
OPENROUTER_API_KEY=sk-or-v1-your-key-here

# Default model
CLAUDISH_MODEL=x-ai/grok-code-fast-1

# Model mapping (optional)
CLAUDISH_MODEL_OPUS=google/gemini-3-pro-preview
CLAUDISH_MODEL_SONNET=x-ai/grok-code-fast-1
CLAUDISH_MODEL_HAIKU=minimax/minimax-m2
CLAUDISH_MODEL_SUBAGENT=minimax/minimax-m2

# Fixed port (optional)
# CLAUDISH_PORT=3456
```

---

## Loading .env Files

Claudish automatically loads `.env` from the current directory using `dotenv`.

**Priority order:**
1. Actual environment variables (highest)
2. `.env` file in current directory

---

## Checking Configuration

See what's set:

```bash
# All Claudish-related vars
env | grep CLAUDISH

# All model-related vars
env | grep -E "(CLAUDISH|ANTHROPIC).*MODEL"

# OpenRouter key (check it exists, don't print it)
[ -n "$OPENROUTER_API_KEY" ] && echo "API key is set"
```

---

## Security Notes

**Never commit `.env` files.** Add to `.gitignore`:

```gitignore
.env
.env.*
!.env.example
```

**Keep a template:**
```bash
# .env.example (safe to commit)
OPENROUTER_API_KEY=your-key-here
CLAUDISH_MODEL=x-ai/grok-code-fast-1
```

---

## Troubleshooting

**"API key not found"**
Check the variable is exported:
```bash
echo $OPENROUTER_API_KEY
```

**"Model not found"**
Verify the model ID is correct:
```bash
claudish --models your-model-name
```

**"Port already in use"**
Either unset `CLAUDISH_PORT` (use random) or pick a different port.

---

## Next

- **[Model Mapping](../models/model-mapping.md)** - Detailed mapping guide
- **[Automation](automation.md)** - Using env vars in scripts
