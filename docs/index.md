# Claudish Documentation

**Run Claude Code with any AI model. Simple as that.**

You've got Claude Code. It's brilliant. But what if you want to use GPT-5 Codex? Or Grok? Or that new model everyone's hyping on Twitter?

That's Claudish. Two ways to use it:

**CLI Mode** - Replace Claude with any model:
```bash
claudish --model x-ai/grok-code-fast-1 "refactor this function"
```

**MCP Server** - Use external models as tools inside Claude:
```
"Claude, ask Grok to review this code"
```

Both approaches, zero friction.

---

## Why Would You Want This?

Real talk - Claude is excellent. So why bother with alternatives?

**Cost optimization.** Some models are 10x cheaper for simple tasks. Why burn premium tokens on "add a console.log"?

**Capabilities.** Gemini 3 Pro has 1M token context. GPT-5 Codex is trained specifically for coding. Different tools, different strengths.

**Comparison.** Run the same prompt through 3 models, see who nails it. I do this constantly.

**Experimentation.** New models drop weekly. Try them without leaving your Claude Code workflow.

---

## 60-Second Quick Start

**Step 1: Get an OpenRouter key** (free tier exists)
```bash
# Go to https://openrouter.ai/keys
# Copy your key
export OPENROUTER_API_KEY='sk-or-v1-...'
```

**Step 2: Pick your mode**

### CLI Mode - Replace Claude entirely
```bash
# Interactive - pick a model, start coding
npx claudish@latest

# Single-shot - one task and exit
npx claudish@latest --model x-ai/grok-code-fast-1 "fix the bug in auth.ts"
```

### MCP Mode - Use external models as Claude tools

Add to your Claude Code settings (`~/.config/claude-code/settings.json`):
```json
{
  "mcpServers": {
    "claudish": {
      "command": "npx",
      "args": ["claudish@latest", "--mcp"],
      "env": {
        "OPENROUTER_API_KEY": "sk-or-v1-..."
      }
    }
  }
}
```

Then just ask Claude:
```
"Use Grok to review this authentication code"
"Ask GPT-5 Codex to explain this regex"
"Compare what 3 models think about this architecture"
```

---

## CLI vs MCP: Which to Use?

| Scenario | Mode | Why |
|----------|------|-----|
| Full coding session with different model | CLI | Replace Claude entirely |
| Quick second opinion mid-conversation | MCP | Tool call, stay in Claude |
| Batch automation/scripts | CLI | Single-shot mode |
| Multi-model comparison | MCP | `compare_models` tool |
| Cost-sensitive simple tasks | Either | Pick cheap model |

**TL;DR:** CLI when you want a different brain. MCP when you want Claude + friends.

---

## Documentation

### Getting Started
- **[Quick Start](getting-started/quick-start.md)** - Full setup guide with all the details

### Usage Modes
- **[Interactive Mode](usage/interactive-mode.md)** - The default experience, model selector, persistent sessions
- **[Single-Shot Mode](usage/single-shot-mode.md)** - Run one task, get result, exit. Perfect for scripts
- **[MCP Server Mode](usage/mcp-server.md)** - Use external models as tools inside Claude Code
- **[Monitor Mode](usage/monitor-mode.md)** - Debug by watching real Anthropic API traffic
- **[Daemon Mode](usage/daemon-mode.md)** - Run Claude Code's background sessions and agent view through claudish

### Models
- **[Choosing Models](models/choosing-models.md)** - Which model for which task? I'll share my picks
- **[Model Mapping](models/model-mapping.md)** - Use different models for Opus/Sonnet/Haiku roles

### Advanced
- **[Environment Variables](advanced/environment.md)** - All configuration options explained
- **[Cost Tracking](advanced/cost-tracking.md)** - Monitor your API spending
- **[Automation](advanced/automation.md)** - Pipes, scripts, CI/CD integration

### AI Integration
- **[For AI Agents](ai-integration/for-agents.md)** - How Claude sub-agents should use Claudish

### Help
- **[Troubleshooting](troubleshooting.md)** - Common issues and how to fix them

---

## The Model Selector

When you run `claudish` with no arguments, you get this:

```
╭──────────────────────────────────────────────────────────────────────────────────╮
│  Select an OpenRouter Model                                                      │
├──────────────────────────────────────────────────────────────────────────────────┤
│  #   Model                             Provider   Pricing   Context  Caps       │
├──────────────────────────────────────────────────────────────────────────────────┤
│   1  google/gemini-3-pro-preview       Google     $7.00/1M  1048K    ✓ ✓ ✓      │
│   2  openai/gpt-5.1-codex              OpenAI     $5.63/1M  400K     ✓ ✓ ✓      │
│   3  x-ai/grok-code-fast-1             xAI        $0.85/1M  256K     ✓ ✓ ·      │
│   4  minimax/minimax-m2                MiniMax    $0.60/1M  204K     ✓ ✓ ·      │
│   5  z-ai/glm-4.6                      Z.AI       $1.07/1M  202K     ✓ ✓ ·      │
│   6  qwen/qwen3-vl-235b-a22b-instruct  Qwen       $1.06/1M  131K     ✓ · ✓      │
│   7  Enter custom OpenRouter model ID...                                        │
├──────────────────────────────────────────────────────────────────────────────────┤
│  Caps: ✓/· = Tools, Reasoning, Vision                                           │
╰──────────────────────────────────────────────────────────────────────────────────╯
```

Pick a number, hit enter, you're coding.

**Caps legend:**
- **Tools** - Can use Claude Code's file/bash tools
- **Reasoning** - Extended thinking capabilities
- **Vision** - Can analyze images/screenshots

---

## My Personal Model Picks

After months of testing, here's my honest take:

| Task | Model | Why |
|------|-------|-----|
| Complex architecture | `google/gemini-3-pro-preview` | 1M context, solid reasoning |
| Fast coding | `x-ai/grok-code-fast-1` | Cheap ($0.85/1M), surprisingly capable |
| Code review | `openai/gpt-5.1-codex` | Trained specifically for code |
| Quick fixes | `minimax/minimax-m2` | Cheapest ($0.60/1M), good enough |
| Vision tasks | `qwen/qwen3-vl-235b-a22b-instruct` | Best vision + code combo |

These aren't sponsored opinions. Just what works for me.

---

## Questions?

**"Is this official?"**
Nope. Community project. OpenRouter is a third-party service.

**"Will my code be secure?"**
Same as using OpenRouter directly. Check their privacy policy.

**"Can I use my company's private models?"**
If they're on OpenRouter, yes. Option 7 lets you enter any model ID.

**"What if a model fails?"**
Claudish handles errors gracefully. You'll see what went wrong.

---

## Links

- [OpenRouter](https://openrouter.ai) - The model aggregator
- [Claude Code](https://claude.ai/claude-code) - The CLI this extends
- [GitHub Issues](https://github.com/MadAppGang/claude-code/issues) - Report bugs
- [Changelog](../CHANGELOG.md) - What's new

---

*Built by Jack @ MadAppGang. MIT License.*
