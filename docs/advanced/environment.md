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

## Classifier Passthrough

Route Claude Code's auto-mode permission classifier to native Anthropic while your main loop
runs on another provider. Full guide: [Model Mapping → Auto-Mode Classifier Passthrough](../models/model-mapping.md#auto-mode-classifier-passthrough).

### `CLAUDISH_CLASSIFIER_PROVIDER`

Set to `anthropic` to enable classifier passthrough (default off). CLI equivalent: `--classifier-provider anthropic`.

```bash
export CLAUDISH_CLASSIFIER_PROVIDER=anthropic
```

### `CLAUDISH_CLASSIFIER_MODEL`

Native Claude model the classifier request is rewritten onto. Setting it also enables passthrough. Defaults to `claude-sonnet-5`. CLI equivalent: `--classifier-model <id>`.

```bash
export CLAUDISH_CLASSIFIER_MODEL=claude-sonnet-5
```

### `CLAUDISH_CLASSIFIER_DEBUG`

Set to `1` to dump each request's raw model / sampling params / system prompt / headers to `logs/classifier-capture.jsonl` for troubleshooting detection. Off by default.

Off by default deliberately: the captured `system` array is the **full** system prompt, which carries your CLAUDE.md and project rules, and the classifier request additionally names the command being classified. Credentials are recorded only as `<present>`, never as values. Turn it on to diagnose a drifted detection marker, then turn it back off and delete the file.

```bash
export CLAUDISH_CLASSIFIER_DEBUG=1
```

---

## Network Configuration

### `CLAUDISH_PORT`

Fixed port for the proxy server. By default, Claudish picks a random available port.

```bash
export CLAUDISH_PORT='3456'
```

Useful when you need a predictable port for firewall rules or debugging.

### `CLAUDISH_RECOVERY`

Master switch for network recovery. Default **on**.

```bash
export CLAUDISH_RECOVERY=0        # or: claudish --no-recovery
```

When claudish cannot reach a provider — DNS unresolved, connection refused, host unreachable — it no longer fails the turn immediately. It retries on a `5s → 10s → 30s → 60s → 60s…` ladder for up to a derived deadline (see below), and if the network comes back the turn continues as if nothing happened.

**Turn it off in CI and in scripted `-p` runs.** With recovery on, a genuinely dead endpoint — a wrong host, a firewalled port, a service you forgot to start — holds the request for the whole deadline before reporting. Off restores the previous behaviour exactly: an immediate error with the same message.

The deadline is **derived from `API_TIMEOUT_MS`**, not fixed:

```
min(API_TIMEOUT_MS, 300s) − 30s        # ~270s at the 360s default
```

Claude Code aborts its own request at `API_TIMEOUT_MS` (360 000 ms by default), so a hold longer than that would be cut off by the client mid-wait. If you have shortened `API_TIMEOUT_MS`, claudish shortens the hold to match and says so with a `[Recovery]` line.

The deadline is the ceiling on the **whole** attempt, including the first one: a connect that never completes is abandoned when the budget runs out rather than waiting out the operating system's own connect timeout (75 s on macOS), which on a shortened `API_TIMEOUT_MS` would answer you after the client had already given up.

**Where the `[Recovery]` lines go.** A recovery episode reports itself on **stderr** — opened, each attempt, each wait and how it ended — with no `--debug` anywhere, because a request can be held for minutes and a hold nobody can see is worse than a fast failure. In an interactive session they are routed to the session log instead of the terminal, so they cannot corrupt Claude Code's display; `~/.claudish/logs/` keeps them either way.

### `CLAUDISH_RECOVERY_UI`

Whether claudish may open a magmux pane showing the recovery banner. Default **on**.

```bash
export CLAUDISH_RECOVERY_UI=0     # or: claudish --no-recovery-ui
```

The banner names the provider, the host, the reason, the attempt count and a live countdown, with `[r] try now` and `[q] give up`. Turning it off keeps the retries and drops only the surface — and with it the ability to hand a retry back to Claude Code, since claudish will not ask a client to retry a failure it cannot show you.

Independent of `CLAUDISH_RECOVERY`: the UI switch never decides whether a retry happens, only whether it is visible.

Full rationale — the measurements behind the deadline, and why the handoff status is 503 — is in `ai-docs/architecture/network-recovery.md`.

---

## Read-Only Variables

### `CLAUDISH_ACTIVE_MODEL_NAME`

Set automatically by Claudish during runtime. Shows the currently active model.

**Don't set this yourself.** It's informational.

---

## Example .env File

A `.env` in the working directory may set provider API keys and claudish model settings only:

```bash
OPENROUTER_API_KEY=sk-or-v1-your-key-here
# GEMINI_API_KEY=...
# CUSTOM_MY_VLLM_KEY=...   # the key for a custom endpoint named my-vllm

# Default model
CLAUDISH_MODEL=x-ai/grok-code-fast-1

# Model mapping (optional)
CLAUDISH_MODEL_OPUS=google/gemini-3-pro-preview
CLAUDISH_MODEL_SONNET=x-ai/grok-code-fast-1
CLAUDISH_MODEL_HAIKU=minimax/minimax-m2
CLAUDISH_MODEL_SUBAGENT=minimax/minimax-m2
```

Everything else goes in your shell profile, or an MCP server's `env`:

```bash
# Fixed port (optional)
# export CLAUDISH_PORT=3456

# CI: fail fast on an unreachable provider instead of retrying for ~270s
# export CLAUDISH_RECOVERY=0
```

---

## Loading .env Files

Claudish loads `.env` from the current directory at startup.

**Priority order:**
1. Actual environment variables (highest)
2. `.env` file in current directory

Only these are read from it: each provider's key variable and its aliases, every
`CUSTOM_<NAME>_KEY`, `ANTHROPIC_API_KEY`, `VERTEX_LOCATION`,
`CLAUDISH_MODEL` and `CLAUDISH_MODEL_OPUS|SONNET|HAIKU|SUBAGENT`. Any other variable in the file is
ignored, and claudish prints one line naming them. The directory is often a checkout you have not
reviewed, and a variable such as `CLAUDE_PATH`, `BUN_OPTIONS`, `OLLAMA_HOST` or a provider base URL
would let it choose the code claudish runs or send your key and prompts elsewhere. See
[Settings Reference](../settings-reference.md#3-environment-variables).

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
