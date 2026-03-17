# Pipe Mode + JSON Output Fix

## Problem Statement

We're using claudish as a backend for an AI automation pipeline (OpenClaw) that sends prompts programmatically. Two critical issues prevent us from using claudish for automation:

### 1. `--json` output is broken

When running:
```bash
echo "hello" | npx claudish --model openrouter/healer-alpha --json
```

The expected output:
```json
{
  "result": "Hello! How can I help you today?",
  "sessionId": "abc-123",
  "model": "openrouter/healer-alpha"
}
```

Actual output:
```json
{
  "result": "",
  ...
}
```

**Root cause:** In `claude-runner.ts`, the `spawn()` call uses `stdio: "inherit"` (line 387), which means Claude Code's stdout goes directly to the terminal, NOT captured by claudish. When `--json` is set, claudish tries to emit JSON with `result: ""` because it never actually captured Claude Code's output.

### 2. No pipe mode for automation

The only ways to send prompts to claudish:
- **Interactive mode** (`claudish` with no args) → shows TUI, requires PTY
- **Single-shot mode** (`claudish --model X "prompt"`) → exits after one prompt
- **`--stdin`** (`echo "prompt" | claudish --stdin`) → exits after one prompt, fires and forgets

**What's missing:** A persistent mode where you can send multiple prompts in sequence, get responses, and Claude Code maintains session context. Essential for automation, chatbots, CI/CD pipelines, and programmatic use.

We tried building a PTY bridge (sending messages to the TUI via node-pty), but it's fundamentally unreliable:
- Claude Code's TUI uses complex Ink/React components with terminal control sequences
- Text sent via PTY often goes to an edit buffer instead of being submitted
- The `❯` prompt indicator doesn't reliably signal "ready to accept input"
- Different Claude Code versions may change TUI internals

## Solution

### Fix 1: Capture stdout when `--json` is used

When `config.jsonOutput` is true, spawn Claude Code with `stdio: ["inherit", "pipe", "inherit"]` so we capture stdout. The output is both written to terminal (for user visibility) and captured in a variable.

### Fix 2: Add `--pipe` mode

A new `--pipe` flag that:
- Spawns Claude Code with piped I/O (`stdio: ["pipe", "pipe", "inherit"]`)
- Relays stdin → Claude Code's stdin and Claude Code's stdout → stdout
- Does NOT show TUI (Claude Code runs in `-p` mode with `stream-json` output)
- Maintains a persistent Claude Code session (process stays alive)
- For automation tooling, chatbots, and programmatic use

```bash
# Single message (will exit after response):
echo "implement feature X" | claudish --pipe --model openrouter@provider/model

# Pipe mode with --json for structured output:
echo "review this code" | claudish --pipe --json --model google@gemini-3-pro
```

## Changes

- `packages/cli/src/types.ts`: Add `pipe: boolean` config field
- `packages/cli/src/cli.ts`: Add `--pipe` flag parsing, exclude from interactive fallback, update help text and examples
- `packages/cli/src/claude-runner.ts`: 
  - Pipe mode: spawn with `stdio: ["pipe", "pipe", "inherit"]`, relay stdin/stdout
  - JSON mode: spawn with `stdio: ["inherit", "pipe", "inherit"]`, capture stdout
  - Pipe mode args: `-p --output-format stream-json --verbose` for structured output

## Why This Matters

Claudish's tagline is "Run Claude Code with any AI model." But without programmatic access, it can only be used by humans in an interactive terminal. This limits its use in:

- **CI/CD pipelines** (automated code review)
- **Chatbots and Discord bots**
- **AI automation frameworks** (like OpenClaw)
- **Batch processing** (running multiple prompts sequentially)
- **Testing and benchmarking** (programmatic model comparison)

The pipe mode makes claudish a proper **API-like interface** for Claude Code, usable both interactively (TUI) and programmatically (pipe).

## Testing

```bash
# Test pipe mode
echo "say hello" | npx claudish --pipe --model openrouter@anthropic/claude-sonnet-4

# Test JSON output fix
echo "say hello" | npx claudish --json --model openrouter@anthropic/claude-sonnet-4

# Test normal interactive mode still works
npx claudish --model openrouter@anthropic/claude-sonnet-4

# Test single-shot still works
npx claudish --model openrouter@anthropic/claude-sonnet-4 "say hello"
```
