# Claudish

> Run Claude Code with OpenRouter models via local proxy

**Claudish** (Claude-ish) is a CLI tool that allows you to run Claude Code with any OpenRouter model by proxying requests through a local Anthropic API-compatible server.

## Features

- ✅ **Cross-platform** - Works with both Node.js and Bun (v1.3.0+)
- ✅ **Universal compatibility** - Use with `npx` or `bunx` - no installation required
- ✅ **Interactive setup** - Prompts for API key and model if not provided (zero config!)
- ✅ **Monitor mode** - Proxy to real Anthropic API and log all traffic (for debugging)
- ✅ **Protocol compliance** - 1:1 compatibility with Claude Code communication protocol
- ✅ **Snapshot testing** - Comprehensive test suite with 13/13 passing tests
- ✅ **Headless mode** - Automatic print mode for non-interactive execution
- ✅ **Quiet mode** - Clean output by default (no log pollution)
- ✅ **JSON output** - Structured data for tool integration
- ✅ **Real-time streaming** - See Claude Code output as it happens
- ✅ **Parallel runs** - Each instance gets isolated proxy
- ✅ **Autonomous mode** - Bypass all prompts with flags
- ✅ **Context inheritance** - Runs in current directory with same `.claude` settings
- ✅ **Multiple models** - 10+ prioritized OpenRouter models
- ✅ **Agent support** - Use Claude Code agents in headless mode with `--agent`

## Installation

### Prerequisites

- **Node.js 18+** or **Bun 1.0+** - JavaScript runtime (either works!)
- [Claude Code](https://claude.com/claude-code) - Claude CLI must be installed
- [OpenRouter API Key](https://openrouter.ai/keys) - Free tier available

### Install Claudish

**✨ NEW in v1.3.0: Universal compatibility! Works with both Node.js and Bun.**

**Option 1: Use without installing (recommended)**

```bash
# With Node.js (works everywhere)
npx claudish@latest --model x-ai/grok-code-fast-1 "your prompt"

# With Bun (faster execution)
bunx claudish@latest --model openai/gpt-5-codex "your prompt"
```

**Option 2: Install globally**

```bash
# With npm (Node.js)
npm install -g claudish

# With Bun (faster)
bun install -g claudish
```

**Option 3: Install from source**

```bash
cd mcp/claudish
bun install        # or: npm install
bun run build      # or: npm run build
bun link           # or: npm link
```

**Performance Note:** While Claudish works with both runtimes, Bun offers faster startup times. Both provide identical functionality.

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
export OPENROUTER_API_KEY=sk-or-v1-...
export ANTHROPIC_API_KEY=sk-ant-api03-placeholder

# Run with specific task
claudish "implement user authentication"

# Or with specific model
claudish --model openai/gpt-5-codex "add tests"
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

| Flag | Description | Default |
|------|-------------|---------|
| `-i, --interactive` | Run in interactive mode (persistent session) | Single-shot mode |
| `-m, --model <model>` | OpenRouter model to use | `x-ai/grok-code-fast-1` |
| `-p, --port <port>` | Proxy server port | Random (3000-9000) |
| `-q, --quiet` | Suppress [claudish] log messages | **Quiet in single-shot** |
| `-v, --verbose` | Show [claudish] log messages | Verbose in interactive |
| `--json` | Output in JSON format (implies --quiet) | `false` |
| `-d, --debug` | Enable debug logging to file | `false` |
| `--no-auto-approve` | Disable auto-approve (require prompts) | Auto-approve **enabled** |
| `--dangerous` | Pass `--dangerouslyDisableSandbox` | `false` |
| `--provider <provider>` | Filter models by provider (openrouter, poe, all) | `all` |
| `--force-update` | Force refresh model cache from all providers | `false` |
| `--force-update=<p>` | Force update specific provider (poe, openrouter, all) | `all` |
| `--agent <agent>` | Use specific agent (e.g., `frontend:developer`) | - |
| `--models` | List all models or search (e.g., `--models gemini`) | - |
| `--top-models` | Show top recommended programming models | - |
| `--list-agents` | List available agents in current project | - |
| `--force-update` | Force refresh model cache | - |
| `--init` | Install Claudish skill in current project | - |
| `--help-ai` | Show AI agent usage guide | - |
| `-h, --help` | Show help message | - |

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `OPENROUTER_API_KEY` | Your OpenRouter API key | ⚡ **Optional in interactive mode** (will prompt if not set)<br>✅ **Required in non-interactive mode** |
| `ANTHROPIC_API_KEY` | Placeholder to prevent Claude Code dialog (not used for auth) | ✅ **Required** |
| `CLAUDISH_MODEL` | Default model to use | ❌ No |
| `CLAUDISH_PORT` | Default proxy port | ❌ No |
| `CLAUDISH_ACTIVE_MODEL_NAME` | Automatically set by claudish to show active model in status line (read-only) | ❌ No |

**Important Notes:**
- **NEW in v1.3.0:** In interactive mode, if `OPENROUTER_API_KEY` is not set, you'll be prompted to enter it
- You MUST set `ANTHROPIC_API_KEY=sk-ant-api03-placeholder` (or any value). Without it, Claude Code will show a dialog

## Available Models

Claudish supports models from multiple providers:

### OpenRouter Models
- **x-ai/grok-code-fast-1** (Default) - Fast coding-focused model from xAI
- **openai/gpt-5-codex** - Advanced coding model from OpenAI
- **minimax/minimax-m2** - High-performance model from MiniMax
- And many more OpenRouter models

### Poe Models
- **poe/grok-4** - Grok model with reasoning capabilities
- **poe/claude-4.5-series** - Latest Claude models (Opus, Sonnet, Haiku)
- **poe/gemini-2.5-series** - Google's latest models
- **poe/deepseek-series** - Advanced reasoning models
- And 300+ more models from 31 providers

### Multi-Provider Commands

**List all models:**
```bash
claudish --models
```

**List only Poe models:**
```bash
claudish --models --provider poe
```

**List only OpenRouter models:**
```bash
claudish --models --provider openrouter
```

**Update all models:**
```bash
claudish --force-update
```

**Update only Poe models:**
```bash
claudish --force-update=poe
```

**Update only OpenRouter models:**
```bash
claudish --force-update=openrouter
```

## Agent Support (NEW in v2.1.0)

Run specialized agents in headless mode with direct agent selection:

```bash
# Use frontend developer agent
claudish --model x-ai/grok-code-fast-1 --agent frontend:developer "create a React button component"

# Use API architect agent
claudish --model openai/gpt-5-codex --agent api-architect "design REST API for user management"

# Discover available agents in your project
claudish --list-agents
```

**Agent Features:**

- ✅ **Direct agent selection** - No need to ask Claude to use an agent
- ✅ **Automatic prefixing** - Adds `@agent-` automatically (`frontend:developer` → `@agent-frontend:developer`)
- ✅ **Project-specific agents** - Works with any agents installed in `.claude/agents/`
- ✅ **Agent discovery** - List all available agents with `--list-agents`

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
# Use Grok for fast coding
claudish --model x-ai/grok-code-fast-1 "add error handling"

# Use GPT-5 Codex for complex tasks
claudish --model openai/gpt-5-codex "refactor entire API layer"

# Use Qwen for UI tasks
claudish --model qwen/qwen3-vl-235b-a22b-instruct "implement dashboard UI"
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
claudish --model openai/gpt-5-codex "task" --verbose --debug
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
claudish --model openai/gpt-5-codex "task B"

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
│   └── types.ts              # TypeScript types
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

- **GitHub**: https://github.com/MadAppGang/claude-code
- **OpenRouter**: https://openrouter.ai
- **Claude Code**: https://claude.com/claude-code
- **Bun**: https://bun.sh
- **Hono**: https://hono.dev
- **claude-code-proxy**: https://github.com/kiyo-e/claude-code-proxy

---

Made with ❤️ by [MadAppGang](https://madappgang.com)
