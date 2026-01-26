# Quick Start Guide

**From zero to running in 3 minutes. No fluff.**

---

## Prerequisites

You need two things:

1. **Claude Code installed** - The official CLI from Anthropic
2. **Node.js 18+** or **Bun 1.0+** - Pick your poison

Don't have Claude Code? Get it at [claude.ai/claude-code](https://claude.ai/claude-code).

---

## Step 1: Get Your API Key

Head to [openrouter.ai/keys](https://openrouter.ai/keys).

Sign up (it's free), create a key. Copy it somewhere safe.

The key looks like: `sk-or-v1-abc123...`

---

## Step 2: Set the Key

**Option A: Export it (session only)**
```bash
export OPENROUTER_API_KEY='sk-or-v1-your-key-here'
```

**Option B: Add to .env (persistent)**
```bash
echo "OPENROUTER_API_KEY=sk-or-v1-your-key-here" >> ~/.env
```

**Option C: Let Claudish prompt you**
Just run `claudish` - it'll ask for the key interactively.

---

## Step 3: Choose Your Mode

Claudish runs two ways. Pick what fits your workflow.

### Option A: CLI Mode (Replace Claude)

**Interactive:**
```bash
npx claudish@latest
```
Shows model selector. Pick one, start a full session with that model.

**Single-shot:**
```bash
# Auto-detected routing (model name determines provider)
npx claudish@latest --model gpt-4o "add error handling to api.ts"         # → OpenAI
npx claudish@latest --model gemini-2.0-flash "quick review"               # → Google

# Explicit provider routing (new @ syntax)
npx claudish@latest --model openrouter@x-ai/grok-3-fast "complex task"    # → OpenRouter
```
One task, result printed, exit. Perfect for scripts.

### Option B: MCP Mode (Claude + External Models)

Add Claudish as an MCP server. Claude can then call external models as tools.

**Add to Claude Code settings** (`~/.config/claude-code/settings.json`):
```json
{
  "mcpServers": {
    "claudish": {
      "command": "npx",
      "args": ["claudish@latest", "--mcp"],
      "env": {
        "OPENROUTER_API_KEY": "sk-or-v1-your-key-here"
      }
    }
  }
}
```

**Restart Claude Code**, then:
```
"Ask Grok to review this function"
"Use GPT-5 Codex to explain this error"
```

Claude uses the `run_prompt` tool to call external models. Best of both worlds.

---

## Step 4: Install the Skill (Optional)

This teaches Claude Code how to use Claudish automatically:

```bash
# Navigate to your project
cd /path/to/your/project

# Install the skill
claudish --init

# Restart Claude Code to load it
```

Now when you say "use Grok to review this code", Claude knows exactly what to do.

---

## Install Globally (Optional)

Tired of `npx`? Install it:

```bash
# With npm
npm install -g claudish

# With Bun (faster)
bun install -g claudish
```

Now just run `claudish` directly.

---

## Verify It Works

Quick test:
```bash
# Auto-detected: gemini-* routes to Google API
claudish --model gemini-2.0-flash "print hello world in python"

# Or explicit provider routing
claudish --model mm@MiniMax-M2 "print hello world in python"
```

You should see the model write a Python hello world through Claude Code's interface.

---

## What Just Happened?

Behind the scenes:

1. Claudish started a local proxy server
2. It configured Claude Code to talk to this proxy
3. Your prompt went to OpenRouter, which routed to MiniMax
4. The response came back through the proxy
5. Claude Code displayed it like normal

You didn't notice any of this. That's the point.

---

## Next Steps

- **[Interactive Mode](../usage/interactive-mode.md)** - Full CLI experience
- **[MCP Server Mode](../usage/mcp-server.md)** - Use external models as Claude tools
- **[Choosing Models](../models/choosing-models.md)** - Pick the right model for your task
- **[Environment Variables](../advanced/environment.md)** - Configure everything

---

## Stuck?

**"Command not found"**
Make sure Node.js 18+ is installed: `node --version`

**"Invalid API key"**
Check your key at [openrouter.ai/keys](https://openrouter.ai/keys). Make sure it starts with `sk-or-v1-`.

**"Model not found"**
Use `claudish --models` to see all available models.

**"Claude Code not installed"**
Install it first: [claude.ai/claude-code](https://claude.ai/claude-code)

More issues? Check [Troubleshooting](../troubleshooting.md).
