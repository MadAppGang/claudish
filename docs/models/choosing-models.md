# Choosing the Right Model

**Different models, different strengths. Here's how to pick.**

OpenRouter gives you access to 100+ models. That's overwhelming. Let me cut through the noise.

---

## The Quick Answer

Just getting started? Use these:

| Use Case | Model | Why |
|----------|-------|-----|
| General coding | `x-ai/grok-code-fast-1` | Fast, cheap, capable |
| Complex problems | `google/gemini-3-pro-preview` | 1M context, solid reasoning |
| Code-specific | `openai/gpt-5.1-codex` | Trained specifically for code |
| Budget mode | `minimax/minimax-m2` | Cheapest that actually works |

Pick one. Start working. Switch later if needed.

---

## Discovering Models

**Top recommended (curated list):**
```bash
claudish --top-models
```

**All OpenRouter models (hundreds):**
```bash
claudish --models
```

**Search for specific models:**
```bash
claudish --models grok
claudish --models codex
claudish --models gemini
```

**JSON output (for scripts):**
```bash
claudish --top-models --json
claudish --models --json
```

---

## Understanding the Columns

When you see the model table:

```
Model                             Provider   Pricing   Context  Caps
google/gemini-3-pro-preview       Google     $7.00/1M  1048K    ✓ ✓ ✓
```

**Model** - The ID you pass to `--model`

**Provider** - Who made it (Google, OpenAI, xAI, etc.)

**Pricing** - Average cost per 1 million tokens. Input and output prices vary, this is the midpoint.

**Context** - Maximum tokens the model can handle (input + output combined)

**Caps (Capabilities):**
- First ✓ = **Tools** - Can use Claude Code's file/bash tools
- Second ✓ = **Reasoning** - Extended thinking mode
- Third ✓ = **Vision** - Can analyze images/screenshots

---

## My Honest Model Breakdown

### Grok Code Fast 1 (`x-ai/grok-code-fast-1`)
**Price:** $0.85/1M | **Context:** 256K

My daily driver. Fast responses, good code quality, reasonable price. Handles most tasks without drama.

**Good for:** General coding, refactoring, quick fixes
**Bad for:** Very long files (256K limit), vision tasks

### Gemini 3 Pro (`google/gemini-3-pro-preview`)
**Price:** $7.00/1M | **Context:** 1M (!)

The context king. A million tokens means you can dump entire codebases into context. Reasoning is solid. Vision works.

**Good for:** Large codebase analysis, complex architecture, image-based tasks
**Bad for:** Quick tasks (overkill), budget-conscious work

### GPT-5.1 Codex (`openai/gpt-5.1-codex`)
**Price:** $5.63/1M | **Context:** 400K

OpenAI's coding specialist. Trained specifically for software engineering. Does code review really well.

**Good for:** Code review, debugging, complex refactoring
**Bad for:** General chat (waste of a specialist)

### MiniMax M2 (`minimax/minimax-m2`)
**Price:** $0.60/1M | **Context:** 204K

The budget champion. Cheapest model that doesn't suck. Surprisingly capable for simple tasks.

**Good for:** Quick fixes, simple generation, high-volume tasks
**Bad for:** Complex reasoning, architecture decisions

### GLM 4.6 (`z-ai/glm-4.6`)
**Price:** $1.07/1M | **Context:** 202K

Underrated. Good balance of price and capability. Handles long context well.

**Good for:** Documentation, explanations, medium complexity tasks
**Bad for:** Cutting-edge reasoning

### Qwen3 VL (`qwen/qwen3-vl-235b-a22b-instruct`)
**Price:** $1.06/1M | **Context:** 131K

Vision + code combo. Best for when you need to work with screenshots, designs, or diagrams.

**Good for:** UI work from screenshots, diagram understanding, visual debugging
**Bad for:** Extended reasoning (no reasoning capability)

---

## Pricing Reality Check

Let's do real math.

**Average coding session:** ~50K tokens (input + output)

| Model | Cost per 50K tokens |
|-------|---------------------|
| MiniMax M2 | $0.03 |
| Grok Code Fast | $0.04 |
| GLM 4.6 | $0.05 |
| Qwen3 VL | $0.05 |
| GPT-5.1 Codex | $0.28 |
| Gemini 3 Pro | $0.35 |

For most tasks, we're talking cents. Don't obsess over pricing unless you're doing high-volume automation.

---

## Model Selection Strategy

**For experiments:** Start cheap (MiniMax M2). See if it works.

**For important code:** Use a capable model (Grok, Codex). It's still cheap.

**For architecture decisions:** Go premium (Gemini 3 Pro). Context and reasoning matter.

**For automation:** Pick the cheapest that works reliably for your task.

---

## Custom Models

### Native Providers (Auto-Detected)

Models from these providers route automatically to their native APIs:

```bash
# Auto-detected from model name (no prefix needed)
claudish --model gpt-4o "your prompt"              # → OpenAI
claudish --model gemini-2.0-flash "your prompt"    # → Google
claudish --model llama-3.1-70b "your prompt"       # → OllamaCloud
claudish --model glm-4 "your prompt"               # → GLM/Zhipu
```

### Explicit Provider Routing

Use `provider@model` syntax for explicit control:

```bash
# Explicit provider routing
claudish --model google@gemini-2.5-pro "your prompt"
claudish --model oai@o1 "your prompt"
claudish --model mm@MiniMax-M2.1 "your prompt"
```

### OpenRouter Models

For models not available via direct API, use explicit OpenRouter routing:

```bash
# Unknown vendors require explicit openrouter@
claudish --model openrouter@mistralai/mistral-large-2411 "your prompt"
claudish --model or@deepseek/deepseek-r1 "your prompt"
claudish --model openrouter@qwen/qwen-2.5 "your prompt"
```

Any valid OpenRouter model ID works with the `openrouter@` or `or@` prefix.

---

## Force Update Model List

The model cache updates automatically every 2 days. Force it:

```bash
claudish --top-models --force-update
```

---

## Next

- **[Model Mapping](model-mapping.md)** - Use different models for different Claude Code roles
- **[Cost Tracking](../advanced/cost-tracking.md)** - Monitor your spending
