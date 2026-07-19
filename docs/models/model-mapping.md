# Model Mapping

**Different models for different roles. Advanced optimization.**

Claude Code uses different model "tiers" internally:
- **Opus** - Complex planning, architecture decisions
- **Sonnet** - Default coding tasks (most work happens here)
- **Haiku** - Fast, simple tasks, background operations
- **Subagent** - When Claude spawns child agents

With model mapping, you can route each tier to a different model.

---

## Why Bother?

**Cost optimization.** Use a cheap model for simple Haiku tasks, premium for Opus planning.

**Capability matching.** Some models are better at planning vs execution.

**Hybrid approach.** Keep real Anthropic Claude for Opus, use OpenRouter for everything else.

---

## Basic Mapping

```bash
# Using new @ syntax (recommended)
claudish \
  --model-opus google@gemini-3-pro \
  --model-sonnet gpt-4o \
  --model-haiku mm@MiniMax-M2

# Or with auto-detected models
claudish \
  --model-opus gemini-2.5-pro \
  --model-sonnet gpt-4o \
  --model-haiku llama-3.1-8b
```

This routes:
- Architecture/planning (Opus) → Google Gemini
- Normal coding (Sonnet) → OpenAI GPT-4o
- Quick tasks (Haiku) → MiniMax M2 or OllamaCloud

---

## Environment Variables

Set defaults so you don't type flags every time:

```bash
# Claudish-specific (takes priority) - use new @ syntax or auto-detected
export CLAUDISH_MODEL_OPUS='google@gemini-2.5-pro'      # Explicit provider
export CLAUDISH_MODEL_SONNET='gpt-4o'                    # Auto-detected → OpenAI
export CLAUDISH_MODEL_HAIKU='llama-3.1-8b'               # Auto-detected → OllamaCloud
export CLAUDISH_MODEL_SUBAGENT='llama-3.1-8b'

# For OpenRouter models, use explicit routing
export CLAUDISH_MODEL_OPUS='openrouter@anthropic/claude-3.5-sonnet'

# Or use Claude Code standard format (fallback)
export ANTHROPIC_DEFAULT_OPUS_MODEL='gemini-2.5-pro'
export ANTHROPIC_DEFAULT_SONNET_MODEL='gpt-4o'
export ANTHROPIC_DEFAULT_HAIKU_MODEL='llama-3.1-8b'
export CLAUDE_CODE_SUBAGENT_MODEL='llama-3.1-8b'
```

Now just run:
```bash
claudish "do something"
```

Each tier uses its mapped model automatically.

---

## Hybrid Mode: Real Claude + OpenRouter

Here's a powerful setup: Use actual Claude for complex tasks, OpenRouter for everything else.

```bash
claudish \
  --model-opus claude-3-opus-20240229 \
  --model-sonnet x-ai/grok-code-fast-1 \
  --model-haiku minimax/minimax-m2
```

Wait, `claude-3-opus-20240229` without the provider prefix?

Yep. Claudish detects this is an Anthropic model ID and routes directly to Anthropic's API (using your native Claude Code auth).

**Result:** Premium Claude intelligence for planning, cheap OpenRouter models for execution.

---

## Auto-Mode Classifier Passthrough

When you run Claude Code in **auto mode** (`--permission-mode auto`), Claude Code sends a
dedicated **permission-classifier** request — Anthropic's "security monitor" — to decide
whether each tool call is safe to run automatically. That classifier only behaves correctly
on a real Claude model. If your hybrid setup routes it to a non-Claude provider (Codex, GPT,
Gemini, …), it over-blocks or times out with *"safety classifier temporarily unavailable"* —
and even harmless commands get denied.

**Classifier passthrough** fixes this: it detects the classifier request by content and
reroutes **only that request** to native Anthropic (`claude-sonnet-5` by default, via your
Claude Max OAuth), while your main loop keeps running on whatever provider you mapped.

### Enable it

Opt-in (default off) via a flag or an env var:

```bash
# Flag
claudish --model-opus cx@gpt-5.6-sol --model-sonnet claude-sonnet-5 \
  --classifier-provider anthropic \
  -- --permission-mode auto "your task"

# Or env var
export CLAUDISH_CLASSIFIER_PROVIDER=anthropic
```

Choose a specific classifier model with `--classifier-model` / `CLAUDISH_CLASSIFIER_MODEL`
(defaults to `claude-sonnet-5` — fast, cheap, and correct for the classifier):

```bash
claudish --classifier-model claude-sonnet-5 ...
```

### Example: main loop on Codex, safety classifier on Claude

```bash
claudish \
  --model-opus cx@gpt-5.6-sol \
  --model-sonnet claude-sonnet-5 \
  --classifier-provider anthropic \
  -- --permission-mode auto -p 'refactor the auth module'
```

The main loop (Opus/Sonnet tiers) runs on Codex; only the permission-classifier request is
rerouted to `claude-sonnet-5` on `api.anthropic.com`.

### Requirements

- You need working Anthropic credentials (Claude Max OAuth, or `ANTHROPIC_API_KEY`). The
  simplest way is to **map a role to a native Claude model** — e.g.
  `--model-sonnet claude-sonnet-5` as above — which preserves your real Claude Code auth
  automatically. If you enable the flag with no native mapping *and* no resolvable Anthropic
  credentials, claudish keeps your main loop working and prints a warning that the classifier
  can't authenticate.
- Only the classifier request is rerouted; every other request follows your normal role
  mapping.

> **Consent model:** Claude Code's classifier treats a command you *explicitly name* in your
> prompt (e.g. literally asking it to run `curl … | bash`) as informed consent and allows it.
> Visible blocks are for dangerous actions the agent formulates on its own, or for
> hard-blocked operations — so a "dangerous" prompt that spells out the exact command may be
> allowed by design.

### Debugging

Set `CLAUDISH_CLASSIFIER_DEBUG=1` to append each incoming request's model / sampling params /
system prompt / headers to `logs/classifier-capture.jsonl` — handy for confirming the
classifier is detected and rerouted. With `--debug-claudish`, a
`[Classifier] … → native Anthropic` line is written when the passthrough fires.

---

## Subagent Mapping

When Claude Code spawns sub-agents (via the Task tool), they use the subagent model:

```bash
export CLAUDISH_MODEL_SUBAGENT='minimax/minimax-m2'
```

This is especially useful for parallel multi-agent workflows. Cheap models for workers, premium for the orchestrator.

---

## Priority Order

When multiple sources set the same model:

1. **CLI flags** (highest priority)
   - `--model-opus`, `--model-sonnet`, etc.
2. **CLAUDISH_MODEL_*** environment variables
3. **ANTHROPIC_DEFAULT_*** environment variables (lowest)

Example:
```bash
export CLAUDISH_MODEL_SONNET='minimax/minimax-m2'

claudish --model-sonnet x-ai/grok-code-fast-1 "prompt"
# Uses Grok (CLI flag wins)
```

---

## My Recommended Setup

For cost-optimized development:

```bash
# .env or shell profile
export CLAUDISH_MODEL_OPUS='google/gemini-3-pro-preview'    # $7.00/1M - for complex planning
export CLAUDISH_MODEL_SONNET='x-ai/grok-code-fast-1'        # $0.85/1M - daily driver
export CLAUDISH_MODEL_HAIKU='minimax/minimax-m2'            # $0.60/1M - quick tasks
export CLAUDISH_MODEL_SUBAGENT='minimax/minimax-m2'         # $0.60/1M - parallel workers
```

For maximum capability:

```bash
export CLAUDISH_MODEL_OPUS='google/gemini-3-pro-preview'    # 1M context
export CLAUDISH_MODEL_SONNET='openai/gpt-5.1-codex'         # Code specialist
export CLAUDISH_MODEL_HAIKU='x-ai/grok-code-fast-1'         # Fast and capable
export CLAUDISH_MODEL_SUBAGENT='x-ai/grok-code-fast-1'
```

---

## Checking Your Configuration

See what's configured:

```bash
# Current environment
env | grep -E "(CLAUDISH|ANTHROPIC)" | grep MODEL
```

---

## Common Patterns

**Budget maximizer:**
All tasks → MiniMax or OllamaCloud. Cheapest options that work.

```bash
claudish --model mm@MiniMax-M2 "prompt"        # MiniMax direct
claudish --model llama-3.1-8b "prompt"          # OllamaCloud (auto-detected)
```

**Quality maximizer:**
All tasks → Google or OpenAI direct API.

```bash
claudish --model gemini-2.5-pro "prompt"        # Google (auto-detected)
claudish --model gpt-4o "prompt"                # OpenAI (auto-detected)
```

**OpenRouter for variety:**
Use explicit routing for models not available via direct API.

```bash
claudish --model openrouter@deepseek/deepseek-r1 "prompt"
claudish --model or@mistralai/mistral-large "prompt"
```

**Balanced approach:**
Map by complexity (shown above).

**Real Claude for critical paths:**
Hybrid with native Anthropic for Opus tier.

---

## Debugging Model Selection

Not sure which model is being used? Enable verbose mode:

```bash
claudish --verbose --model x-ai/grok-code-fast-1 "prompt"
```

You'll see logs showing which model handles each request.

---

## Next

- **[Environment Variables](../advanced/environment.md)** - Full configuration reference
- **[Choosing Models](choosing-models.md)** - Which model for which task
