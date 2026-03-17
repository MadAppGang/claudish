<div align="center">

# 🔮 Claudish

### Claude Code. Any Model.

[![npm version](https://img.shields.io/npm/v/claudish.svg?style=flat-square&color=00D4AA)](https://www.npmjs.com/package/claudish)
[![license](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude_Code-Compatible-d97757?style=flat-square)](https://claude.ai/claude-code)

**Use your existing AI subscriptions with Claude Code.** Works with Anthropic Max, Gemini Advanced, ChatGPT Plus/Codex, Kimi, GLM, OllamaCloud — plus 580+ models via OpenRouter and local models for complete privacy.

[Website](https://claudish.com) · [Documentation](https://github.com/MadAppGang/claudish/blob/main/docs/index.md) · [Report Bug](https://github.com/MadAppGang/claudish/issues)

</div>

---

**Claudish** (Claude-ish) is a CLI tool that allows you to run Claude Code with any AI model by proxying requests through a local Anthropic API-compatible server.

**Supported Providers:**
- **Cloud:** OpenRouter (580+ models), Google Gemini, OpenAI, MiniMax, Kimi, GLM, Z.AI, OllamaCloud, OpenCode Zen
- **Local:** Ollama, LM Studio, vLLM, MLX
- **Enterprise:** Vertex AI (Google Cloud)

## Use Your Existing AI Subscriptions

**Stop paying for multiple AI subscriptions.** Claudish lets you use subscriptions you already have with Claude Code's powerful interface:

| Your Subscription | Command |
|-------------------|---------|
| **Anthropic Max** | Native support (just use `claude`) |
| **Gemini Advanced** | `claudish --model g@gemini-3-pro-preview` |
| **ChatGPT Plus/Codex** | `claudish --model oai@gpt-5.3` or `oai@gpt-5.3-codex` |
| **Kimi** | `claudish --model kimi@kimi-k2.5` |
| **GLM** | `claudish --model glm@GLM-4.7` |
| **MiniMax** | `claudish --model mm@minimax-m2.1` |
| **OllamaCloud** | `claudish --model oc@qwen3-next` |
| **OpenCode Zen Go** | `claudish --model zgo@glm-5` |

**100% Offline Option — Your code never leaves your machine:**
```bash
claudish --model ollama@qwen3-coder:latest "your task"
```

## Bring Your Own Key (BYOK)

Claudish is a **BYOK AI coding assistant**:
- ✅ Use API keys you already have
- ✅ No additional subscription fees
- ✅ Full cost control — pay only for what you use
- ✅ Works with any provider
- ✅ Switch models mid-session

## Features

- ✅ **Multi-provider support** - OpenRouter, Gemini, Vertex AI, OpenAI, OllamaCloud, and local models
- ✅ **New routing syntax** - Use `provider@model[:concurrency]` for explicit routing (e.g., `google@gemini-2.0-flash`)
- ✅ **Native auto-detection** - Models like `gpt-4o`, `gemini-2.0-flash`, `llama-3.1-70b` route to their native APIs automatically
- ✅ **Direct API access** - Google, OpenAI, MiniMax, Kimi, GLM, Z.AI, OllamaCloud, Poe with direct billing
- ✅ **Vertex AI Model Garden** - Access Google + partner models (MiniMax, Mistral, DeepSeek, Qwen, OpenAI OSS)
- ✅ **Local model support** - Ollama, LM Studio, vLLM, MLX with `ollama@`, `lmstudio@` syntax and concurrency control
- ✅ **Cross-platform** - Works with both Node.js and Bun (v1.3.0+)
- ✅ **Universal compatibility** - Use with `npx` or `bunx` - no installation required
- ✅ **Interactive setup** - Prompts for API key and model if not provided (zero config!)
- ✅ **Monitor mode** - Proxy to real Anthropic API and log all traffic (for debugging)
- ✅ **Protocol compliance** - 1:1 compatibility with Claude Code communication protocol
- ✅ **Headless mode** - Automatic print mode for non-interactive execution
- ✅ **Quiet mode** - Clean output by default (no log pollution)
- ✅ **JSON output** - Structured data for tool integration
- ✅ **Real-time streaming** - See Claude Code output as it happens
- ✅ **Parallel runs** - Each instance gets isolated proxy
- ✅ **Autonomous mode** - Bypass all prompts with flags
- ✅ **Context inheritance** - Runs in current directory with same `.claude` settings
- ✅ **Claude Code flag passthrough** - Forward any Claude Code flag (`--agent`, `--effort`, `--permission-mode`, etc.) in any order
- ✅ **Vision proxy** - Non-vision models automatically get image descriptions via Claude, so every model can "see"

## Installation

### Quick Install

```bash
# Shell script (Linux/macOS)
curl -fsSL https://raw.githubusercontent.com/MadAppGang/claudish/main/install.sh | bash

# Homebrew (macOS)
brew tap MadAppGang/tap && brew install claudish

# npm
npm install -g claudish

# Bun
bun install -g claudish
```

### Prerequisites

- [Claude Code](https://claude.com/claude-code) - Claude CLI must be installed
- At least one API key:
  - [OpenRouter API Key](https://openrouter.ai/keys) - Access 100+ models (free tier available)
  - [Google Gemini API Key](https://aistudio.google.com/apikey) - For direct Gemini access
  - [OpenAI API Key](https://platform.openai.com/api-keys) - For direct OpenAI access
  - [OllamaCloud API Key](https://ollama.com/account) - For cloud-hosted Ollama models (`oc/` prefix)
  - Or local models (Ollama, LM Studio) - No API key needed

### Other Install Options

**Use without installing:**

```bash
npx claudish@latest --model x-ai/grok-code-fast-1 "your prompt"
bunx claudish@latest --model x-ai/grok-code-fast-1 "your prompt"
```

**Install from source:**

```bash
git clone https://github.com/MadAppGang/claudish.git
cd claudish
bun install && bun run build && bun link
```

## Quick Start

### Step 0: Initialize Claudish Skill (First Time Only)

```bash
# Navigate to your project directory
cd /path/to/your/project

# Install Claudish skill for automatic best practices
claudish --init

# Reload Claude Code to discover the skill
```

**What this does:**
- ✅ Installs Claudish usage skill in `.claude/skills/claudish-usage/`
- ✅ Enables automatic sub-agent delegation
- ✅ Enforces file-based instruction patterns
- ✅ Prevents context window pollution

**After running --init**, Claude will automatically:
- Use sub-agents when you mention external models (Grok, GPT-5, etc.)
- Follow best practices for Claudish usage
- Suggest specialized agents for different tasks

### Option 1: Interactive Mode (Easiest)

```bash
# Just run it - will prompt for API key and model
claudish

# Enter your OpenRouter API key when prompted
# Select a model from the list
# Start coding!
```

### Option 2: With Environment Variables

```bash
# Set up environment
export OPENROUTER_API_KEY=sk-or-v1-...     # For OpenRouter models
export GEMINI_API_KEY=...                   # For direct Google API
export OPENAI_API_KEY=sk-...                # For direct OpenAI API
export ANTHROPIC_API_KEY=sk-ant-api03-placeholder  # Required placeholder

# Run with auto-detected model
claudish --model gpt-4o "implement user authentication"     # → OpenAI
claudish --model gemini-2.0-flash "add tests"               # → Google

# Or with explicit provider
claudish --model openrouter@anthropic/claude-3.5-sonnet "review code"
```

**Note:** In interactive mode, if `OPENROUTER_API_KEY` is not set, you'll be prompted to enter it. This makes first-time usage super simple!

## AI Agent Usage

**For AI agents running within Claude Code:** Use the dedicated AI agent guide for comprehensive instructions on file-based patterns and sub-agent delegation.

```bash
# Print complete AI agent usage guide
claudish --help-ai

# Save guide to file for reference
claudish --help-ai > claudish-agent-guide.md
```

**Quick Reference for AI Agents:**

### Main Workflow for AI Agents

1. **Get available models:**
   ```bash
   # List all models or search
   claudish --models
   claudish --models gemini

   # Get top recommended models (JSON)
   claudish --top-models --json
   ```

2. **Run Claudish through sub-agent** (recommended pattern):
   ```typescript
   // Don't run Claudish directly in main conversation
   // Use Task tool to delegate to sub-agent
   const result = await Task({
     subagent_type: "general-purpose",
     description: "Implement feature with Grok",
     prompt: `
   Use Claudish to implement feature with Grok model.

   STEPS:
   1. Create instruction file: /tmp/claudish-task-${Date.now()}.md
   2. Write feature requirements to file
   3. Run: claudish --model x-ai/grok-code-fast-1 --stdin < /tmp/claudish-task-*.md
   4. Read result and return ONLY summary (2-3 sentences)

   DO NOT return full implementation. Keep response under 300 tokens.
     `
   });
   ```

3. **File-based instruction pattern** (avoids context pollution):
   ```typescript
   // Write instructions to file
   const instructionFile = `/tmp/claudish-task-${Date.now()}.md`;
   const resultFile = `/tmp/claudish-result-${Date.now()}.md`;

   await Write({ file_path: instructionFile, content: `
   # Task
   Your task description here

   # Output
   Write results to: ${resultFile}
   ` });

   // Run Claudish with stdin
   await Bash(`claudish --model x-ai/grok-code-fast-1 --stdin < ${instructionFile}`);

   // Read result
   const result = await Read({ file_path: resultFile });

   // Return summary only
   return extractSummary(result);
   ```

**Key Principles:**
- ✅ Use file-based patterns to avoid context window pollution
- ✅ Delegate to sub-agents instead of running directly
- ✅ Return summaries only (not full conversation transcripts)
- ✅ Choose appropriate model for task (see `--models` or `--top-models`)

**Resources:**
- Full AI agent guide: `claudish --help-ai`
- Skill document: `skills/claudish-usage/SKILL.md` (in repository root)
- Model integration: `skills/claudish-integration/SKILL.md` (in repository root)

## Usage

### Basic Syntax

```bash
claudish [OPTIONS] <claude-args...>
```

### Options

> For the exhaustive reference with all details, see [Settings Reference](docs/settings-reference.md).

| Flag | Short | Description | Default |
|------|-------|-------------|---------|
| `--model <model>` | `-m` | Model to use (`provider@model` syntax) | Interactive selector |
| `--model-opus <model>` | | Model for Opus role (planning, complex tasks) | |
| `--model-sonnet <model>` | | Model for Sonnet role (default coding) | |
| `--model-haiku <model>` | | Model for Haiku role (fast tasks) | |
| `--model-subagent <model>` | | Model for sub-agents (Task tool) | |
| `--profile <name>` | `-p` | Named profile for model mapping | Default profile |
| `--interactive` | `-i` | Interactive mode (persistent session) | Auto when no prompt |
| `--auto-approve` | `-y` | Skip permission prompts | `false` |
| `--no-auto-approve` | | Explicitly enable permission prompts | |
| `--dangerous` | | Pass `--dangerouslyDisableSandbox` | `false` |
| `--port <port>` | | Proxy server port | Random (3000-9000) |
| `--debug` | `-d` | Enable debug logging to `logs/` | `false` |
| `--log-level <level>` | | Log verbosity: `debug`, `info`, `minimal` | `info` |
| `--quiet` | `-q` | Suppress `[claudish]` messages | Default in single-shot |
| `--verbose` | `-v` | Show `[claudish]` messages | Default in interactive |
| `--json` | | JSON output for tool integration (implies `--quiet`) | `false` |
| `--stdin` | | Read prompt from stdin | `false` |
| `--free` | | Show only free models in selector | `false` |
| `--monitor` | | Proxy to real Anthropic API and log traffic | `false` |
| `--summarize-tools` | | Summarize tool descriptions (for local models) | `false` |
| `--cost-tracker` | | Enable cost tracking (enables monitor mode) | `false` |
| `--audit-costs` | | Show cost analysis report | |
| `--reset-costs` | | Reset accumulated cost statistics | |
| `--models [query]` | `-s` | List all models or fuzzy search | |
| `--top-models` | | Show curated recommended models | |
| `--force-update` | | Force refresh model cache | |
| `--init` | | Install Claudish skill in current project | |
| `--mcp` | | Run as MCP server | |
| `--gemini-login` | | Login to Gemini Code Assist via OAuth | |
| `--gemini-logout` | | Clear Gemini OAuth credentials | |
| `--kimi-login` | | Login to Kimi via OAuth | |
| `--kimi-logout` | | Clear Kimi OAuth credentials | |
| `--help-ai` | | Show AI agent usage guide | |
| `--version` | | Show version | |
| `--help` | `-h` | Show help message | |
| `--` | | Everything after passes to Claude Code | |

**Flag passthrough**: Any unrecognized flag is automatically forwarded to Claude Code (e.g., `--agent`, `--effort`, `--permission-mode`).

### Environment Variables

Claudish automatically loads `.env` from the current directory at startup. For the full list, see [Settings Reference](docs/settings-reference.md).

#### API Keys (at least one required for cloud models)

| Variable | Provider | Aliases |
|----------|----------|---------|
| `OPENROUTER_API_KEY` | OpenRouter (default backend, 580+ models) | |
| `GEMINI_API_KEY` | Google Gemini (`g@`, `google@`) | |
| `OPENAI_API_KEY` | OpenAI (`oai@`) | |
| `MINIMAX_API_KEY` | MiniMax (`mm@`, `mmax@`) | |
| `MINIMAX_CODING_API_KEY` | MiniMax Coding Plan (`mmc@`) | |
| `MOONSHOT_API_KEY` | Kimi/Moonshot (`kimi@`) | `KIMI_API_KEY` |
| `KIMI_CODING_API_KEY` | Kimi Coding Plan (`kc@`) | Or OAuth via `--kimi-login` |
| `ZHIPU_API_KEY` | GLM/Zhipu (`glm@`) | `GLM_API_KEY` |
| `GLM_CODING_API_KEY` | GLM Coding Plan (`gc@`) | `ZAI_CODING_API_KEY` |
| `ZAI_API_KEY` | Z.AI (`zai@`) | |
| `OLLAMA_API_KEY` | OllamaCloud (`oc@`) | |
| `OPENCODE_API_KEY` | OpenCode Zen (`zen@`) — optional for free models | |
| `LITELLM_API_KEY` | LiteLLM (`ll@`) — requires `LITELLM_BASE_URL` | |
| `POE_API_KEY` | Poe (`poe@`) | |
| `VERTEX_API_KEY` | Vertex AI Express (`v@`) | |
| `VERTEX_PROJECT` | Vertex AI OAuth mode (`v@`) | `GOOGLE_CLOUD_PROJECT` |
| `ANTHROPIC_API_KEY` | Placeholder (suppresses Claude Code dialog) | |

#### Claudish Settings

| Variable | Description | Default |
|----------|-------------|---------|
| `CLAUDISH_MODEL` | Default model (overrides `ANTHROPIC_MODEL`) | Interactive selector |
| `CLAUDISH_PORT` | Default proxy port | Random (3000-9000) |
| `CLAUDISH_CONTEXT_WINDOW` | Override context window size (local models) | Auto-detected |
| `CLAUDISH_MODEL_OPUS` | Model for Opus role | |
| `CLAUDISH_MODEL_SONNET` | Model for Sonnet role | |
| `CLAUDISH_MODEL_HAIKU` | Model for Haiku role | |
| `CLAUDISH_MODEL_SUBAGENT` | Model for sub-agents | |
| `CLAUDISH_SUMMARIZE_TOOLS` | Summarize tool descriptions (`true`/`1`) | `false` |
| `CLAUDISH_TELEMETRY` | Override telemetry (`0`/`false`/`off` to disable) | From config |
| `CLAUDISH_LOCAL_MAX_PARALLEL` | Max concurrent local model requests (1-8) | `1` |
| `CLAUDISH_LOCAL_QUEUE_ENABLED` | Enable/disable local model queue | `true` |
| `CLAUDISH_QWEN_NO_THINK` | Disable thinking for Qwen models (`1`) | |

#### Claude Code Compatibility

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_MODEL` | Fallback for `CLAUDISH_MODEL` |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | Fallback for `CLAUDISH_MODEL_OPUS` |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | Fallback for `CLAUDISH_MODEL_SONNET` |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | Fallback for `CLAUDISH_MODEL_HAIKU` |
| `CLAUDE_CODE_SUBAGENT_MODEL` | Fallback for `CLAUDISH_MODEL_SUBAGENT` |
| `CLAUDE_PATH` | Custom path to Claude Code binary |

#### Custom Endpoints

| Variable | Provider | Default |
|----------|----------|---------|
| `GEMINI_BASE_URL` | Gemini API | `https://generativelanguage.googleapis.com` |
| `OPENAI_BASE_URL` | OpenAI/Azure | `https://api.openai.com` |
| `MINIMAX_BASE_URL` | MiniMax | `https://api.minimax.io` |
| `MOONSHOT_BASE_URL` | Kimi/Moonshot | `https://api.moonshot.ai` |
| `ZHIPU_BASE_URL` | GLM/Zhipu | `https://open.bigmodel.cn` |
| `ZAI_BASE_URL` | Z.AI | `https://api.z.ai` |
| `OLLAMACLOUD_BASE_URL` | OllamaCloud | `https://ollama.com` |
| `OPENCODE_BASE_URL` | OpenCode Zen | `https://opencode.ai/zen` |
| `LITELLM_BASE_URL` | LiteLLM proxy server | _(required with LITELLM_API_KEY)_ |
| `OLLAMA_BASE_URL` | Ollama (local) | `http://localhost:11434` |
| `OLLAMA_HOST` | Alias for `OLLAMA_BASE_URL` | |
| `LMSTUDIO_BASE_URL` | LM Studio (local) | `http://localhost:1234` |
| `VLLM_BASE_URL` | vLLM (local) | `http://localhost:8000` |
| `MLX_BASE_URL` | MLX (local) | `http://127.0.0.1:8080` |

**Priority order**: CLI flags > `CLAUDISH_*` env vars > `ANTHROPIC_*` env vars > profile config > interactive selector.

**Important Notes:**
- Set `ANTHROPIC_API_KEY=sk-ant-api03-placeholder` (or any value) to suppress the Claude Code login dialog
- In interactive mode, if no API key is set, you'll be prompted to enter one

### Configuration Files

Claudish uses a two-scope configuration system:

| File | Scope | Purpose |
|------|-------|---------|
| `~/.claudish/config.json` | Global | Profiles, telemetry, routing rules (shared across projects) |
| `.claudish.json` | Local | Project-specific profiles and routing rules (overrides global) |
| `.env` | Local | Environment variables (auto-loaded at startup) |

**Profile configuration** (`~/.claudish/config.json`):

```json
{
  "version": "1.0.0",
  "defaultProfile": "default",
  "profiles": {
    "default": {
      "name": "default",
      "models": {
        "opus": "oai@gpt-5.3",
        "sonnet": "google@gemini-3-pro",
        "haiku": "mm@MiniMax-M2.1",
        "subagent": "google@gemini-2.0-flash"
      }
    }
  },
  "routing": {
    "kimi-*": ["kc", "kimi", "openrouter"],
    "glm-*": ["gc", "glm"],
    "*": ["litellm", "openrouter"]
  }
}
```

**Custom routing rules** map model name patterns to ordered provider fallback chains. Patterns support exact names, globs (`kimi-*`), and `*` catch-all. Local `.claudish.json` routing rules **replace** global rules entirely.

Manage profiles with:

```bash
claudish init [--local|--global]            # Setup wizard
claudish profile list [--local|--global]    # List profiles
claudish profile add [--local|--global]     # Add profile
claudish profile use <name>                 # Set default
claudish profile edit <name>                # Edit profile
```

For the complete configuration reference, see [Settings Reference](docs/settings-reference.md).

## Model Routing (v4.0.0+)

Claudish uses **`provider@model[:concurrency]`** syntax for explicit routing, plus **smart auto-detection** for native providers:

### New Syntax: `provider@model[:concurrency]`

```bash
# Explicit provider routing
claudish --model google@gemini-2.0-flash "quick task"
claudish --model openrouter@deepseek/deepseek-r1 "analysis"
claudish --model oai@gpt-4o "implement feature"
claudish --model ollama@llama3.2:3 "code review"  # 3 concurrent requests
```

### Provider Shortcuts

| Shortcut | Provider | API Key | Example |
|----------|----------|---------|---------|
| `g@`, `google@` | Google Gemini | `GEMINI_API_KEY` | `g@gemini-2.0-flash` |
| `oai@` | OpenAI Direct | `OPENAI_API_KEY` | `oai@gpt-4o` |
| `or@`, `openrouter@` | OpenRouter | `OPENROUTER_API_KEY` | `or@deepseek/deepseek-r1` |
| `mm@`, `mmax@` | MiniMax Direct | `MINIMAX_API_KEY` | `mm@MiniMax-M2.1` |
| `kimi@`, `moon@` | Kimi Direct | `MOONSHOT_API_KEY` | `kimi@kimi-k2` |
| `glm@`, `zhipu@` | GLM Direct | `ZHIPU_API_KEY` | `glm@glm-4` |
| `zai@` | Z.AI Direct | `ZAI_API_KEY` | `zai@glm-4` |
| `llama@`, `lc@`, `meta@` | OllamaCloud | `OLLAMA_API_KEY` | `llama@llama-3.1-70b` |
| `oc@` | OllamaCloud | `OLLAMA_API_KEY` | `oc@llama-3.1-70b` |
| `zen@` | OpenCode Zen (free/paid) | `OPENCODE_API_KEY` _(optional)_ | `zen@gpt-5-nano` |
| `zgo@`, `zengo@` | OpenCode Zen Go plan | `OPENCODE_API_KEY` | `zgo@glm-5` |
| `v@`, `vertex@` | Vertex AI | `VERTEX_API_KEY` | `v@gemini-2.5-flash` |
| `go@` | Gemini CodeAssist | _(OAuth)_ | `go@gemini-2.5-flash` |
| `poe@` | Poe | `POE_API_KEY` | `poe@GPT-4o` |
| `ollama@` | Ollama (local) | _(none)_ | `ollama@llama3.2` |
| `lms@`, `lmstudio@` | LM Studio (local) | _(none)_ | `lms@qwen2.5-coder` |
| `vllm@` | vLLM (local) | _(none)_ | `vllm@mistral-7b` |
| `mlx@` | MLX (local) | _(none)_ | `mlx@llama-3.2-3b` |

### Native Model Auto-Detection

When no provider is specified, Claudish auto-detects from model name:

| Model Pattern | Routes To | Example |
|---------------|-----------|---------|
| `gemini-*`, `google/*` | Google Gemini | `gemini-2.0-flash` |
| `gpt-*`, `o1-*`, `o3-*` | OpenAI Direct | `gpt-4o` |
| `llama-*`, `meta-llama/*` | OllamaCloud | `llama-3.1-70b` |
| `abab-*`, `minimax/*` | MiniMax Direct | `abab-6.5` |
| `kimi-*`, `moonshot-*` | Kimi Direct | `kimi-k2` |
| `glm-*`, `zhipu/*` | GLM Direct | `glm-4` |
| `poe:*` | Poe | `poe:GPT-4o` |
| `claude-*`, `anthropic/*` | Native Anthropic | `claude-sonnet-4` |
| **Unknown `vendor/model`** | **Error** | Use `openrouter@vendor/model` |

### Examples

```bash
# Auto-detected native routing (no prefix needed!)
claudish --model gemini-2.0-flash "quick task"      # → Google API
claudish --model gpt-4o "implement feature"          # → OpenAI API
claudish --model llama-3.1-70b "code review"         # → OllamaCloud

# Explicit provider routing
claudish --model google@gemini-2.5-pro "complex analysis"
claudish --model oai@o1 "complex reasoning"
claudish --model openrouter@deepseek/deepseek-r1 "deep analysis"

# OllamaCloud - cloud-hosted Llama models
claudish --model llama@llama-3.1-70b "code review"
claudish --model oc@llama-3.2-vision "analyze image"

# Vertex AI - Google Cloud
VERTEX_API_KEY=... claudish --model v@gemini-2.5-flash "task"
VERTEX_PROJECT=my-project claudish --model vertex@gemini-2.5-flash "OAuth mode"

# Local models with concurrency control
claudish --model ollama@llama3.2:3 "review"     # 3 concurrent requests
claudish --model ollama@llama3.2:0 "fast"       # No limit (bypass queue)

# Unknown vendors require explicit OpenRouter
claudish --model openrouter@qwen/qwen-2.5 "task"
claudish --model or@mistralai/mistral-large "analysis"
```

### Legacy Syntax (Deprecated)

The old `prefix/model` syntax still works but shows deprecation warnings:

```bash
# Old (deprecated)          →  New (recommended)
claudish --model g/gemini-pro     →  claudish --model g@gemini-pro
claudish --model oai/gpt-4o       →  claudish --model oai@gpt-4o
claudish --model ollama/llama3.2  →  claudish --model ollama@llama3.2
```

## Curated Models

Top recommended models for development (v3.1.1):

| Model | Provider | Best For |
|-------|----------|----------|
| `openai/gpt-5.3` | OpenAI | **Default** - Most advanced reasoning |
| `minimax/minimax-m2.1` | MiniMax | Budget-friendly, fast |
| `z-ai/glm-4.7` | Z.AI | Balanced performance |
| `google/gemini-3-pro-preview` | Google | 1M context window |
| `moonshotai/kimi-k2-thinking` | MoonShot | Extended reasoning |
| `deepseek/deepseek-v3.2` | DeepSeek | Code specialist |
| `qwen/qwen3-vl-235b-a22b-thinking` | Alibaba | Vision + reasoning |

**Vertex AI Partner Models (MaaS - Google Cloud billing):**

| Model | Provider | Best For |
|-------|----------|----------|
| `vertex/minimax/minimax-m2-maas` | MiniMax | Fast, budget-friendly |
| `vertex/mistralai/codestral-2` | Mistral | Code specialist |
| `vertex/deepseek/deepseek-v3-2-maas` | DeepSeek | Deep reasoning |
| `vertex/qwen/qwen3-coder-480b-a35b-instruct-maas` | Qwen | Agentic coding |
| `vertex/openai/gpt-oss-120b-maas` | OpenAI | Open-weight reasoning |

List all models:

```bash
claudish --models              # List all OpenRouter models
claudish --models gemini       # Search for specific models
claudish --top-models          # Show curated recommendations
```

## Claude Code Flag Passthrough (NEW in v5.3.0)

Claudish forwards all unrecognized flags directly to Claude Code. This means any Claude Code flag works with claudish — no wrapper needed:

```bash
# Use Claude Code agents
claudish --model grok --agent code-review "review auth system"

# Control effort and permissions
claudish --model grok --effort high --permission-mode plan "design API"

# Set budget caps
claudish --model grok --max-budget-usd 0.50 "quick fix"

# Custom system prompts
claudish --model grok --append-system-prompt "Always respond in JSON" "list files"

# Restrict available tools
claudish --model grok --allowedTools "Read,Grep" "search for auth bugs"
```

Claudish flags (`--model`, `--stdin`, `--quiet`, `-y`, etc.) can appear in **any order** — they are always recognized regardless of position.

Use `--` when a Claude Code flag value starts with `-`:
```bash
claudish --model grok -- --system-prompt "-verbose logging" "task"
```

## Vision Proxy (NEW in v5.1.0)

**Every model can now "see" images** — even models without native vision support.

When you send an image to a non-vision model (like local Ollama models), Claudish automatically:

1. Detects that the model cannot process images
2. Sends each image to the Anthropic API (Claude Sonnet) for a rich description
3. Replaces the image block with `[Image Description: ...]` text
4. Forwards the enriched message to the target model

```
Claude Code → image + "what's in this?" → Claudish
                                             ↓
                              ┌──────────────────────────────┐
                              │ Model supports vision?       │
                              │  YES → pass image through    │
                              │  NO  → describe via Claude → │
                              │        replace with text     │
                              └──────────────────────────────┘
                                             ↓
                                      Target Model
```

**How it works:**
- Uses your existing `x-api-key` from Claude Code (no extra configuration)
- Each image is described in parallel (fast even with multiple images)
- 30-second timeout per image with graceful fallback to stripping
- Descriptions include text content, layout, colors, code, diagrams, and UI elements

**Example:**

```bash
# Local Ollama model (no vision) — images are automatically described
claudish --model ollama@llama3.2 "what's in this screenshot?"

# Vision-capable model — images pass through unchanged
claudish --model g@gemini-2.5-flash "what's in this screenshot?"
```

**Fallback behavior:** If the vision proxy fails (network error, timeout, API issue), Claudish falls back to stripping images — the request still goes through, just without image context.

## Status Line Display

Claudish automatically shows critical information in the Claude Code status bar - **no setup required!**

**Ultra-Compact Format:** `directory • model-id • $cost • ctx%`

**Visual Design:**
- 🔵 **Directory** (bright cyan, bold) - Where you are
- 🟡 **Model ID** (bright yellow) - Actual OpenRouter model ID
- 🟢 **Cost** (bright green) - Real-time session cost from OpenRouter
- 🟣 **Context** (bright magenta) - % of context window remaining
- ⚪ **Separators** (dim) - Visual dividers

**Examples:**
- `claudish • x-ai/grok-code-fast-1 • $0.003 • 95%` - Using Grok, $0.003 spent, 95% context left
- `my-project • openai/gpt-5-codex • $0.12 • 67%` - Using GPT-5, $0.12 spent, 67% context left
- `backend • minimax/minimax-m2 • $0.05 • 82%` - Using MiniMax M2, $0.05 spent, 82% left
- `test • openrouter/auto • $0.01 • 90%` - Using any custom model, $0.01 spent, 90% left

**Critical Tracking (Live Updates):**
- 💰 **Cost tracking** - Real-time USD from Claude Code session data
- 📊 **Context monitoring** - Percentage of model's context window remaining
- ⚡ **Performance optimized** - Ultra-compact to fit with thinking mode UI

**Thinking Mode Optimized:**
- ✅ **Ultra-compact** - Directory limited to 15 chars (leaves room for everything)
- ✅ **Critical first** - Most important info (directory, model) comes first
- ✅ **Smart truncation** - Long directories shortened with "..."
- ✅ **Space reservation** - Reserves ~40 chars for Claude's thinking mode UI
- ✅ **Color-coded** - Instant visual scanning
- ✅ **No overflow** - Fits perfectly even with thinking mode enabled

**Custom Model Support:**
- ✅ **ANY OpenRouter model** - Not limited to shortlist (e.g., `openrouter/auto`, custom models)
- ✅ **Actual model IDs** - Shows exact OpenRouter model ID (no translation)
- ✅ **Context fallback** - Unknown models use 100k context window (safe default)
- ✅ **Shortlist optimized** - Our recommended models have accurate context sizes
- ✅ **Future-proof** - Works with new models added to OpenRouter

**How it works:**
- Each Claudish instance creates a temporary settings file with custom status line
- Settings use `--settings` flag (doesn't modify global Claude Code config)
- Status line uses simple bash script with ANSI colors (no external dependencies!)
- Displays actual OpenRouter model ID from `CLAUDISH_ACTIVE_MODEL_NAME` env var
- Context tracking uses model-specific sizes for our shortlist, 100k fallback for others
- Temp files are automatically cleaned up when Claudish exits
- Each instance is completely isolated - run multiple in parallel!

**Per-instance isolation:**
- ✅ Doesn't modify `~/.claude/settings.json`
- ✅ Each instance has its own config
- ✅ Safe to run multiple Claudish instances in parallel
- ✅ Standard Claude Code unaffected
- ✅ Temp files auto-cleanup on exit
- ✅ No external dependencies (bash only, no jq!)

## Examples

### Basic Usage

```bash
# Simple prompt
claudish "fix the bug in user.ts"

# Multi-word prompt
claudish "implement user authentication with JWT tokens"
```

### With Specific Model

```bash
# Auto-detected native routing (model name determines provider)
claudish --model gpt-4o "refactor entire API layer"           # → OpenAI
claudish --model gemini-2.0-flash "quick fix"                 # → Google
claudish --model llama-3.1-70b "code review"                  # → OllamaCloud

# Explicit provider routing (new @ syntax)
claudish --model google@gemini-2.5-pro "complex analysis"
claudish --model oai@o1 "deep reasoning task"
claudish --model openrouter@deepseek/deepseek-r1 "analysis"   # Unknown vendors need explicit OR

# Local models with concurrency control
claudish --model ollama@llama3.2 "code review"
claudish --model ollama@llama3.2:3 "parallel processing"      # 3 concurrent
claudish --model lmstudio@qwen2.5-coder "implement dashboard UI"
```

### Autonomous Mode

Auto-approve is **enabled by default**. For fully autonomous mode, add `--dangerous`:

```bash
# Basic usage (auto-approve already enabled)
claudish "delete unused files"

# Fully autonomous (auto-approve + dangerous sandbox disabled)
claudish --dangerous "install dependencies"

# Disable auto-approve if you want prompts
claudish --no-auto-approve "make important changes"
```

### Custom Port

```bash
# Use specific port
claudish --port 3000 "analyze codebase"

# Or set default
export CLAUDISH_PORT=3000
claudish "your task"
```

### Passing Claude Flags

```bash
# Verbose mode
claudish "debug issue" --verbose

# Custom working directory
claudish "analyze code" --cwd /path/to/project

# Multiple flags
claudish --model openai/gpt-5.3-codex "task" --verbose --debug
```

### Monitor Mode

**NEW!** Claudish now includes a monitor mode to help you understand how Claude Code works internally.

```bash
# Enable monitor mode (requires real Anthropic API key)
claudish --monitor --debug "implement a feature"
```

**What Monitor Mode Does:**
- ✅ **Proxies to REAL Anthropic API** (not OpenRouter) - Uses your actual Anthropic API key
- ✅ **Logs ALL traffic** - Captures complete requests and responses
- ✅ **Both streaming and JSON** - Logs SSE streams and JSON responses
- ✅ **Debug logs to file** - Saves to `logs/claudish_*.log` when `--debug` is used
- ✅ **Pass-through proxy** - No translation, forwards as-is to Anthropic

**When to use Monitor Mode:**
- 🔍 Understanding Claude Code's API protocol
- 🐛 Debugging integration issues
- 📊 Analyzing Claude Code's behavior
- 🔬 Research and development

**Requirements:**
```bash
# Monitor mode requires a REAL Anthropic API key (not placeholder)
export ANTHROPIC_API_KEY='sk-ant-api03-...'

# Use with --debug to save logs to file
claudish --monitor --debug "your task"

# Logs are saved to: logs/claudish_TIMESTAMP.log
```

**Example Output:**
```
[Monitor] Server started on http://127.0.0.1:8765
[Monitor] Mode: Passthrough to real Anthropic API
[Monitor] All traffic will be logged for analysis

=== [MONITOR] Claude Code → Anthropic API Request ===
{
  "model": "claude-sonnet-4.5",
  "messages": [...],
  "max_tokens": 4096,
  ...
}
=== End Request ===

=== [MONITOR] Anthropic API → Claude Code Response (Streaming) ===
event: message_start
data: {"type":"message_start",...}

event: content_block_start
data: {"type":"content_block_start",...}
...
=== End Streaming Response ===
```

**Note:** Monitor mode charges your Anthropic account (not OpenRouter). Use `--debug` flag to save logs for analysis.

### Output Modes

Claudish supports three output modes for different use cases:

#### 1. Quiet Mode (Default in Single-Shot)

Clean output with no `[claudish]` logs - perfect for piping to other tools:

```bash
# Quiet by default in single-shot
claudish "what is 2+2?"
# Output: 2 + 2 equals 4.

# Use in pipelines
claudish "list 3 colors" | grep -i blue

# Redirect to file
claudish "analyze code" > analysis.txt
```

#### 2. Verbose Mode

Show all `[claudish]` log messages for debugging:

```bash
# Verbose mode
claudish --verbose "what is 2+2?"
# Output:
# [claudish] Starting Claude Code with openai/gpt-4o
# [claudish] Proxy URL: http://127.0.0.1:8797
# [claudish] Status line: dir • openai/gpt-4o • $cost • ctx%
# ...
# 2 + 2 equals 4.
# [claudish] Shutting down proxy server...
# [claudish] Done

# Interactive mode is verbose by default
claudish --interactive
```

#### 3. JSON Output Mode

Structured output perfect for automation and tool integration:

```bash
# JSON output (always quiet)
claudish --json "what is 2+2?"
# Output: {"type":"result","result":"2 + 2 equals 4.","total_cost_usd":0.068,"usage":{...}}

# Extract just the result with jq
claudish --json "list 3 colors" | jq -r '.result'

# Get cost and token usage
claudish --json "analyze code" | jq '{result, cost: .total_cost_usd, tokens: .usage.input_tokens}'

# Use in scripts
RESULT=$(claudish --json "check if tests pass" | jq -r '.result')
echo "AI says: $RESULT"

# Track costs across multiple runs
for task in task1 task2 task3; do
  claudish --json "$task" | jq -r '"\(.total_cost_usd)"'
done | awk '{sum+=$1} END {print "Total: $"sum}'
```

**JSON Output Fields:**
- `result` - The AI's response text
- `total_cost_usd` - Total cost in USD
- `usage.input_tokens` - Input tokens used
- `usage.output_tokens` - Output tokens used
- `duration_ms` - Total duration in milliseconds
- `num_turns` - Number of conversation turns
- `modelUsage` - Per-model usage breakdown

## How It Works

### Architecture

```
claudish "your prompt"
    ↓
1. Parse arguments (--model, --no-auto-approve, --dangerous, etc.)
2. Find available port (random or specified)
3. Start local proxy on http://127.0.0.1:PORT
4. Spawn: claude --auto-approve --env ANTHROPIC_BASE_URL=http://127.0.0.1:PORT
5. Proxy translates: Anthropic API → OpenRouter API
6. Stream output in real-time
7. Cleanup proxy on exit
```

### Request Flow

**Normal Mode (OpenRouter):**
```
Claude Code → Anthropic API format → Local Proxy → OpenRouter API format → OpenRouter
                                         ↓
Claude Code ← Anthropic API format ← Local Proxy ← OpenRouter API format ← OpenRouter
```

**Monitor Mode (Anthropic Passthrough):**
```
Claude Code → Anthropic API format → Local Proxy (logs) → Anthropic API
                                         ↓
Claude Code ← Anthropic API format ← Local Proxy (logs) ← Anthropic API
```

### Parallel Runs

Each `claudish` invocation:
- Gets a unique random port
- Starts isolated proxy server
- Runs independent Claude Code instance
- Cleans up on exit

This allows multiple parallel runs:

```bash
# Terminal 1
claudish --model x-ai/grok-code-fast-1 "task A"

# Terminal 2
claudish --model openai/gpt-5.3-codex "task B"

# Terminal 3
claudish --model minimax/minimax-m2 "task C"
```

## Extended Thinking Support

**NEW in v1.1.0**: Claudish now fully supports models with extended thinking/reasoning capabilities (Grok, o1, etc.) with complete Anthropic Messages API protocol compliance.

### Thinking Translation Model (v1.5.0)

Claudish includes a sophisticated **Thinking Translation Model** that aligns Claude Code's native thinking budget with the unique requirements of every major AI provider.

When you set a thinking budget in Claude (e.g., `budget: 16000`), Claudish automatically translates it:

| Provider | Model | Translation Logic |
| :--- | :--- | :--- |
| **OpenAI** | o1, o3 | Maps budget to `reasoning_effort` (minimal/low/medium/high) |
| **Google** | Gemini 3 | Maps to `thinking_level` (low/high) |
| **Google** | Gemini 2.x | Passes exact `thinking_budget` (capped at 24k) |
| **xAI** | Grok 3 Mini | Maps to `reasoning_effort` (low/high) |
| **Qwen** | Qwen 2.5 | Enables `enable_thinking` + exact budget |
| **MiniMax** | M2 | Enables `reasoning_split` (interleaved thinking) |
| **DeepSeek** | R1 | Automatically manages reasoning (params stripped for safety) |

This ensures you can use standard Claude Code thinking controls with **ANY** supported model, without worrying about API specificities.

### What is Extended Thinking?

Some AI models (like Grok and OpenAI's o1) can show their internal reasoning process before providing the final answer. This "thinking" content helps you understand how the model arrived at its conclusion.

### How Claudish Handles Thinking

Claudish implements the Anthropic Messages API's `interleaved-thinking` protocol:

**Thinking Blocks (Hidden):**
- Contains model's reasoning process
- Automatically collapsed in Claude Code UI
- Shows "Claude is thinking..." indicator
- User can expand to view reasoning

**Text Blocks (Visible):**
- Contains final response
- Displayed normally
- Streams incrementally

### Supported Models with Thinking

- ✅ **x-ai/grok-code-fast-1** - Grok's reasoning mode
- ✅ **openai/gpt-5-codex** - o1 reasoning (when enabled)
- ✅ **openai/o1-preview** - Full reasoning support
- ✅ **openai/o1-mini** - Compact reasoning
- ⚠️ Other models may support reasoning in future

### Technical Details

**Streaming Protocol (V2 - Protocol Compliant):**
```
1. message_start
2. content_block_start (text, index=0)      ← IMMEDIATE! (required)
3. ping
4. [If reasoning arrives]
   - content_block_stop (index=0)           ← Close initial empty block
   - content_block_start (thinking, index=1) ← Reasoning
   - thinking_delta events × N
   - content_block_stop (index=1)
5. content_block_start (text, index=2)      ← Response
6. text_delta events × M
7. content_block_stop (index=2)
8. message_delta + message_stop
```

**Critical:** `content_block_start` must be sent immediately after `message_start`, before `ping`. This is required by the Anthropic Messages API protocol for proper UI initialization.

**Key Features:**
- ✅ Separate thinking and text blocks (proper indices)
- ✅ `thinking_delta` vs `text_delta` event types
- ✅ Thinking content hidden by default
- ✅ Smooth transitions between blocks
- ✅ Full Claude Code UI compatibility

### UX Benefits

**Before (v1.0.0 - No Thinking Support):**
- Reasoning visible as regular text
- Confusing output with internal thoughts
- No progress indicators
- "All at once" message updates

**After (v1.1.0 - Full Protocol Support):**
- ✅ Reasoning hidden/collapsed
- ✅ Clean, professional output
- ✅ "Claude is thinking..." indicator shown
- ✅ Smooth incremental streaming
- ✅ Message headers/structure visible
- ✅ Protocol compliant with Anthropic Messages API

### Documentation

For complete protocol documentation, see:
- [STREAMING_PROTOCOL.md](./STREAMING_PROTOCOL.md) - Complete SSE protocol spec
- [PROTOCOL_FIX_V2.md](./PROTOCOL_FIX_V2.md) - Critical V2 protocol fix (event ordering)
- [COMPREHENSIVE_UX_ISSUE_ANALYSIS.md](./COMPREHENSIVE_UX_ISSUE_ANALYSIS.md) - Technical analysis
- [THINKING_BLOCKS_IMPLEMENTATION.md](./THINKING_BLOCKS_IMPLEMENTATION.md) - Implementation summary

## Dynamic Reasoning Support (NEW in v1.4.0)

**Claudish now intelligently adapts to ANY reasoning model!**

No more hardcoded lists or manual flags. Claudish dynamically queries OpenRouter metadata to enable thinking capabilities for any model that supports them.

### 🧠 Dynamic Thinking Features

1.  **Auto-Detection**:
    - Automatically checks model capabilities at startup
    - Enables Extended Thinking UI *only* when supported
    - Future-proof: Works instantly with new models (e.g., `deepseek-r1` or `minimax-m2`)

2.  **Smart Parameter Mapping**:
    - **Claude**: Passes token budget directly (e.g., 16k tokens)
    - **OpenAI (o1/o3)**: Translates budget to `reasoning_effort`
        - "ultrathink" (≥32k) → `high`
        - "think hard" (16k-32k) → `medium`
        - "think" (<16k) → `low`
    - **Gemini & Grok**: Preserves thought signatures and XML traces automatically

3.  **Universal Compatibility**:
    - Use "ultrathink" or "think hard" prompts with ANY supported model
    - Claudish handles the translation layer for you

## Context Scaling & Auto-Compaction

**NEW in v1.2.0**: Claudish now intelligently manages token counting to support ANY context window size (from 128k to 2M+) while preserving Claude Code's native auto-compaction behavior.

### The Challenge

Claude Code naturally assumes a fixed context window (typically 200k tokens for Sonnet).
- **Small Models (e.g., Grok 128k)**: Claude might overuse context and crash.
- **Massive Models (e.g., Gemini 2M)**: Claude would compact way too early (at 10% usage), wasting the model's potential.

### The Solution: Token Scaling

Claudish implements a "Dual-Accounting" system:

1. **Internal Scaling (For Claude):**
   - We fetch the *real* context limit from OpenRouter (e.g., 1M tokens).
   - We scale reported token usage so Claude *thinks* 1M tokens is 200k.
   - **Result:** Auto-compaction triggers at the correct *percentage* of usage (e.g., 90% full), regardless of the actual limit.

2. **Accurate Reporting (For You):**
   - The status line displays the **Real Unscaled Usage** and **Real Context %**.
   - You see specific costs and limits, while Claude remains blissfully unaware and stable.

**Benefits:**
- ✅ **Works with ANY model** size (128k, 1M, 2M, etc.)
- ✅ **Unlocks massive context** windows (Claude Code becomes 10x more powerful with Gemini!)
- ✅ **Prevents crashes** on smaller models (Grok)
- ✅ **Native behavior** (compaction just works)


## Development

### Project Structure

```
mcp/claudish/
├── src/
│   ├── index.ts              # Main entry point
│   ├── cli.ts                # CLI argument parser
│   ├── proxy-server.ts       # Hono-based proxy server
│   ├── transform.ts          # API format translation (from claude-code-proxy)
│   ├── claude-runner.ts      # Claude CLI runner (creates temp settings)
│   ├── port-manager.ts       # Port utilities
│   ├── config.ts             # Constants and defaults
│   ├── types.ts              # TypeScript types
│   └── services/
│       └── vision-proxy.ts   # Image description for non-vision models
├── tests/                    # Test files
├── package.json
├── tsconfig.json
└── biome.json
```

### Proxy Implementation

Claudish uses a **Hono-based proxy server** inspired by [claude-code-proxy](https://github.com/kiyo-e/claude-code-proxy):

- **Framework**: [Hono](https://hono.dev/) - Fast, lightweight web framework
- **API Translation**: Converts Anthropic API format ↔ OpenAI format
- **Streaming**: Full support for Server-Sent Events (SSE)
- **Tool Calling**: Handles Claude's tool_use ↔ OpenAI's tool_calls
- **Battle-tested**: Based on production-ready claude-code-proxy implementation

**Why Hono?**
- Native Bun support (no adapters needed)
- Extremely fast and lightweight
- Middleware support (CORS, logging, etc.)
- Works across Node.js, Bun, and Cloudflare Workers

### Build & Test

```bash
# Install dependencies
bun install

# Development mode
bun run dev "test prompt"

# Build
bun run build

# Lint
bun run lint

# Format
bun run format

# Type check
bun run typecheck

# Run tests
bun test
```

### Protocol Compliance Testing

Claudish includes a comprehensive snapshot testing system to ensure 1:1 compatibility with the official Claude Code protocol:

```bash
# Run snapshot tests (13/13 passing ✅)
bun test tests/snapshot.test.ts

# Full workflow: capture fixtures + run tests
./tests/snapshot-workflow.sh --full

# Capture new test fixtures from monitor mode
./tests/snapshot-workflow.sh --capture

# Debug SSE events
bun tests/debug-snapshot.ts
```

**What Gets Tested:**
- ✅ Event sequence (message_start → content_block_start → deltas → stop → message_delta → message_stop)
- ✅ Content block indices (sequential: 0, 1, 2, ...)
- ✅ Tool input streaming (fine-grained JSON chunks)
- ✅ Usage metrics (present in message_start and message_delta)
- ✅ Stop reasons (always present and valid)
- ✅ Cache metrics (creation and read tokens)

**Documentation:**
- [Quick Start Guide](./QUICK_START_TESTING.md) - Get started with testing
- [Snapshot Testing Guide](./SNAPSHOT_TESTING.md) - Complete testing documentation
- [Implementation Details](./ai_docs/IMPLEMENTATION_COMPLETE.md) - Technical implementation summary
- [Protocol Compliance Plan](./ai_docs/PROTOCOL_COMPLIANCE_PLAN.md) - Detailed compliance roadmap

### Install Globally

```bash
# Link for global use
bun run install:global

# Now use anywhere
claudish "your task"
```

## Troubleshooting

### "Claude Code CLI is not installed"

Install Claude Code:

```bash
npm install -g claude-code
# or visit: https://claude.com/claude-code
```

### "OPENROUTER_API_KEY environment variable is required"

Set your API key:

```bash
export OPENROUTER_API_KEY=sk-or-v1-...
```

Or add to your shell profile (`~/.zshrc`, `~/.bashrc`):

```bash
echo 'export OPENROUTER_API_KEY=sk-or-v1-...' >> ~/.zshrc
source ~/.zshrc
```

### "No available ports found"

Specify a custom port:

```bash
claudish --port 3000 "your task"
```

Or increase port range in `src/config.ts`.

### Proxy errors

Check OpenRouter API status:
- https://openrouter.ai/status

Verify your API key works:
- https://openrouter.ai/keys

### Status line not showing model

If the status line doesn't show the model name:

1. **Check if --settings flag is being passed:**
   ```bash
   # Look for this in Claudish output:
   # [claudish] Instance settings: /tmp/claudish-settings-{timestamp}.json
   ```

2. **Verify environment variable is set:**
   ```bash
   # Should be set automatically by Claudish
   echo $CLAUDISH_ACTIVE_MODEL_NAME
   # Should output something like: xAI/Grok-1
   ```

3. **Test status line command manually:**
   ```bash
   export CLAUDISH_ACTIVE_MODEL_NAME="xAI/Grok-1"
   cat > /dev/null && echo "[$CLAUDISH_ACTIVE_MODEL_NAME] 📁 $(basename "$(pwd)")"
   # Should output: [xAI/Grok-1] 📁 your-directory-name
   ```

4. **Check temp settings file:**
   ```bash
   # File is created in /tmp/claudish-settings-*.json
   ls -la /tmp/claudish-settings-*.json 2>/dev/null | tail -1
   cat /tmp/claudish-settings-*.json | head -1
   ```

5. **Verify bash is available:**
   ```bash
   which bash
   # Should show path to bash (usually /bin/bash or /usr/bin/bash)
   ```

**Note:** Temp settings files are automatically cleaned up when Claudish exits. If you see multiple files, you may have crashed instances - they're safe to delete manually.

## Comparison with Claude Code

| Feature | Claude Code | Claudish |
|---------|-------------|----------|
| Model | Anthropic models only | Any OpenRouter model |
| API | Anthropic API | OpenRouter API |
| Cost | Anthropic pricing | OpenRouter pricing |
| Setup | API key → direct | API key → proxy → OpenRouter |
| Speed | Direct connection | ~Same (local proxy) |
| Features | All Claude Code features | All Claude Code features |
| Vision | Native (Anthropic models) | Any model (auto-described via Claude) |

**When to use Claudish:**
- ✅ Want to try different models (Grok, GPT-5, etc.)
- ✅ Need OpenRouter-specific features
- ✅ Prefer OpenRouter pricing
- ✅ Testing model performance

**When to use Claude Code:**
- ✅ Want latest Anthropic models only
- ✅ Need official Anthropic support
- ✅ Simpler setup (no proxy)

## Contributing

Contributions welcome! Please:

1. Fork the repo
2. Create feature branch: `git checkout -b feature/amazing`
3. Commit changes: `git commit -m 'Add amazing feature'`
4. Push to branch: `git push origin feature/amazing`
5. Open Pull Request

## License

MIT © MadAppGang

## Acknowledgments

Claudish's proxy implementation is based on [claude-code-proxy](https://github.com/kiyo-e/claude-code-proxy) by [@kiyo-e](https://github.com/kiyo-e). We've adapted their excellent Hono-based API translation layer for OpenRouter integration.

**Key contributions from claude-code-proxy:**
- Anthropic ↔ OpenAI API format translation (`transform.ts`)
- Streaming response handling with Server-Sent Events
- Tool calling compatibility layer
- Clean Hono framework architecture

Thank you to the claude-code-proxy team for building a robust, production-ready foundation! 🙏

## Links

- **GitHub**: https://github.com/MadAppGang/claudish
- **OpenRouter**: https://openrouter.ai
- **Claude Code**: https://claude.com/claude-code
- **Bun**: https://bun.sh
- **Hono**: https://hono.dev
- **claude-code-proxy**: https://github.com/kiyo-e/claude-code-proxy

---

Made with ❤️ by [MadAppGang](https://madappgang.com)
