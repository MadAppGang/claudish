# Claudish AI Agent Usage Guide

**Version:** 2.0.0
**Target Audience:** AI Agents running within Claude Code
**Purpose:** Quick reference for using Claudish CLI in agentic workflows

---

## TL;DR - Quick Start

```bash
# 1. Get available models
claudish --models --json

# 2. Run task with specific model (OpenRouter)
claudish --model openai/gpt-5.2 "your task here"

# 3. Run with direct Gemini API
claudish --model g/gemini-2.0-flash "your task here"

# 4. Run with local model
claudish --model ollama/llama3.2 "your task here"

# 5. For large prompts, use stdin
echo "your task" | claudish --stdin --model openai/gpt-5.2
```

## What is Claudish?

Claudish = Claude Code + Any AI Model

- ✅ Run Claude Code with **any AI model** via prefix-based routing
- ✅ Supports OpenRouter (100+ models), direct Gemini API, direct OpenAI API
- ✅ Supports local models (Ollama, LM Studio, vLLM, MLX)
- ✅ 100% Claude Code feature compatibility
- ✅ Local proxy server (no data sent to Claudish servers)
- ✅ Cost tracking and model selection

## Model Routing

| Prefix | Backend | Example |
|--------|---------|---------|
| _(none)_ | OpenRouter | `openai/gpt-5.2` |
| `g/` `gemini/` | Google Gemini | `g/gemini-2.0-flash` |
| `oai/` `openai/` | OpenAI | `oai/gpt-4o` |
| `ollama/` | Ollama | `ollama/llama3.2` |
| `lmstudio/` | LM Studio | `lmstudio/model` |
| `http://...` | Custom | `http://localhost:8000/model` |

## Prerequisites

1. **Install Claudish:**
   ```bash
   npm install -g claudish
   ```

2. **Set OpenRouter API Key:**
   ```bash
   export OPENROUTER_API_KEY='sk-or-v1-...'
   ```

3. **Optional but recommended:**
   ```bash
   export ANTHROPIC_API_KEY='sk-ant-api03-placeholder'
   ```

## Top Models for Development

| Model ID | Provider | Category | Best For |
|----------|----------|----------|----------|
| `openai/gpt-5.2` | OpenAI | Reasoning | **Default** - Most advanced reasoning |
| `minimax/minimax-m2.1` | MiniMax | Coding | Budget-friendly, fast |
| `z-ai/glm-4.7` | Z.AI | Coding | Balanced performance |
| `google/gemini-3-pro-preview` | Google | Reasoning | 1M context window |
| `moonshotai/kimi-k2-thinking` | MoonShot | Reasoning | Extended thinking |
| `deepseek/deepseek-v3.2` | DeepSeek | Coding | Code specialist |
| `qwen/qwen3-vl-235b-a22b-thinking` | Alibaba | Vision | Vision + reasoning |

**Direct API Options (lower latency):**

| Model ID | Backend | Best For |
|----------|---------|----------|
| `g/gemini-2.0-flash` | Gemini | Fast tasks, large context |
| `oai/gpt-4o` | OpenAI | General purpose |
| `ollama/llama3.2` | Local | Free, private |

**Update models:**
```bash
claudish --models --force-update
```

## Critical: File-Based Pattern for Sub-Agents

### ⚠️ Problem: Context Window Pollution

Running Claudish directly in main conversation pollutes context with:
- Entire conversation transcript
- All tool outputs
- Model reasoning (10K+ tokens)

### ✅ Solution: File-Based Sub-Agent Pattern

**Pattern:**
1. Write instructions to file
2. Run Claudish with file input
3. Read result from file
4. Return summary only (not full output)

**Example:**
```typescript
// Step 1: Write instruction file
const instructionFile = `/tmp/claudish-task-${Date.now()}.md`;
const resultFile = `/tmp/claudish-result-${Date.now()}.md`;

const instruction = `# Task
Implement user authentication

# Requirements
- JWT tokens
- bcrypt password hashing
- Protected route middleware

# Output
Write to: ${resultFile}
`;

await Write({ file_path: instructionFile, content: instruction });

// Step 2: Run Claudish
await Bash(`claudish --model x-ai/grok-code-fast-1 --stdin < ${instructionFile}`);

// Step 3: Read result
const result = await Read({ file_path: resultFile });

// Step 4: Return summary only
const summary = extractSummary(result);
return `✅ Completed. ${summary}`;

// Clean up
await Bash(`rm ${instructionFile} ${resultFile}`);
```

## Using Claudish in Sub-Agents

### Method 1: Direct Bash Execution

```typescript
// For simple tasks with short output
const { stdout } = await Bash("claudish --model x-ai/grok-code-fast-1 --json 'quick task'");
const result = JSON.parse(stdout);

// Return only essential info
return `Cost: $${result.total_cost_usd}, Result: ${result.result.substring(0, 100)}...`;
```

### Method 2: Task Tool Delegation

```typescript
// For complex tasks requiring isolation
const result = await Task({
  subagent_type: "general-purpose",
  description: "Implement feature with Grok",
  prompt: `
Use Claudish to implement feature with Grok model:

STEPS:
1. Create instruction file at /tmp/claudish-instruction-${Date.now()}.md
2. Write feature requirements to file
3. Run: claudish --model x-ai/grok-code-fast-1 --stdin < /tmp/claudish-instruction-*.md
4. Read result and return ONLY:
   - Files modified (list)
   - Brief summary (2-3 sentences)
   - Cost (if available)

DO NOT return full implementation details.
Keep response under 300 tokens.
  `
});
```

### Method 3: Multi-Model Comparison

```typescript
// Compare results from multiple models
const models = [
  "x-ai/grok-code-fast-1",
  "google/gemini-2.5-flash",
  "openai/gpt-5"
];

for (const model of models) {
  const result = await Bash(`claudish --model ${model} --json "analyze security"`);
  const data = JSON.parse(result.stdout);

  console.log(`${model}: $${data.total_cost_usd}`);
  // Store results for comparison
}
```

## Essential CLI Flags

### Core Flags

| Flag | Description | Example |
|------|-------------|---------|
| `--model <model>` | OpenRouter model to use | `--model x-ai/grok-code-fast-1` |
| `--stdin` | Read prompt from stdin | `cat task.md \| claudish --stdin --model grok` |
| `--json` | JSON output (structured) | `claudish --json "task"` |
| `--list-models` | List available models | `claudish --list-models --json` |

### Useful Flags

| Flag | Description | Default |
|------|-------------|---------|
| `--quiet` / `-q` | Suppress logs | Enabled in single-shot |
| `--verbose` / `-v` | Show logs | Enabled in interactive |
| `--debug` / `-d` | Debug logging to file | Disabled |
| `--no-auto-approve` | Require prompts | Auto-approve enabled |

## Common Workflows

### Workflow 1: Quick Code Fix (Grok)

```bash
# Fast coding with visible reasoning
claudish --model x-ai/grok-code-fast-1 "fix null pointer error in user.ts"
```

### Workflow 2: Complex Refactoring (GPT-5)

```bash
# Advanced reasoning for architecture
claudish --model openai/gpt-5 "refactor to microservices architecture"
```

### Workflow 3: Code Review (Gemini)

```bash
# Deep analysis with large context
git diff | claudish --stdin --model google/gemini-2.5-flash "review for bugs"
```

### Workflow 4: UI Implementation (Qwen Vision)

```bash
# Vision model for visual tasks
claudish --model qwen/qwen3-vl-235b-a22b-instruct "implement dashboard from design"
```

## Getting Model List

### JSON Output (Recommended)

```bash
claudish --list-models --json
```

**Output:**
```json
{
  "version": "1.8.0",
  "lastUpdated": "2025-11-19",
  "source": "https://openrouter.ai/models",
  "models": [
    {
      "id": "x-ai/grok-code-fast-1",
      "name": "Grok Code Fast 1",
      "description": "Ultra-fast agentic coding",
      "provider": "xAI",
      "category": "coding",
      "priority": 1,
      "pricing": {
        "input": "$0.20/1M",
        "output": "$1.50/1M",
        "average": "$0.85/1M"
      },
      "context": "256K",
      "supportsTools": true,
      "supportsReasoning": true
    }
  ]
}
```

### Parse in TypeScript

```typescript
const { stdout } = await Bash("claudish --list-models --json");
const data = JSON.parse(stdout);

// Get all model IDs
const modelIds = data.models.map(m => m.id);

// Get coding models
const codingModels = data.models.filter(m => m.category === "coding");

// Get cheapest model
const cheapest = data.models.sort((a, b) =>
  parseFloat(a.pricing.average) - parseFloat(b.pricing.average)
)[0];
```

## JSON Output Format

When using `--json` flag, Claudish returns:

```json
{
  "result": "AI response text",
  "total_cost_usd": 0.068,
  "usage": {
    "input_tokens": 1234,
    "output_tokens": 5678
  },
  "duration_ms": 12345,
  "num_turns": 3,
  "modelUsage": {
    "x-ai/grok-code-fast-1": {
      "inputTokens": 1234,
      "outputTokens": 5678
    }
  }
}
```

**Extract fields:**
```bash
claudish --json "task" | jq -r '.result'          # Get result text
claudish --json "task" | jq -r '.total_cost_usd'  # Get cost
claudish --json "task" | jq -r '.usage'           # Get token usage
```

## Error Handling

### Check Claudish Installation

```typescript
try {
  await Bash("which claudish");
} catch (error) {
  console.error("Claudish not installed. Install with: npm install -g claudish");
  // Use fallback (embedded Claude models)
}
```

### Check API Key

```typescript
const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error("OPENROUTER_API_KEY not set. Get key at: https://openrouter.ai/keys");
  // Use fallback
}
```

### Handle Model Errors

```typescript
try {
  const result = await Bash("claudish --model x-ai/grok-code-fast-1 'task'");
} catch (error) {
  if (error.message.includes("Model not found")) {
    console.error("Model unavailable. Listing alternatives...");
    await Bash("claudish --list-models");
  } else {
    console.error("Claudish error:", error.message);
  }
}
```

### Graceful Fallback

```typescript
async function runWithClaudishOrFallback(task: string) {
  try {
    // Try Claudish with Grok
    const result = await Bash(`claudish --model x-ai/grok-code-fast-1 "${task}"`);
    return result.stdout;
  } catch (error) {
    console.warn("Claudish unavailable, using embedded Claude");
    // Run with standard Claude Code
    return await runWithEmbeddedClaude(task);
  }
}
```

## Cost Tracking

### View Cost in Status Line

Claudish shows cost in Claude Code status line:
```
directory • x-ai/grok-code-fast-1 • $0.12 • 67%
```

### Get Cost from JSON

```bash
COST=$(claudish --json "task" | jq -r '.total_cost_usd')
echo "Task cost: \$${COST}"
```

### Track Cumulative Costs

```typescript
let totalCost = 0;

for (const task of tasks) {
  const result = await Bash(`claudish --json --model grok "${task}"`);
  const data = JSON.parse(result.stdout);
  totalCost += data.total_cost_usd;
}

console.log(`Total cost: $${totalCost.toFixed(4)}`);
```

## Best Practices Summary

### ✅ DO

1. **Use file-based pattern** for sub-agents to avoid context pollution
2. **Choose appropriate model** for task (Grok=speed, GPT-5=reasoning, Qwen=vision)
3. **Use --json output** for automation and parsing
4. **Handle errors gracefully** with fallbacks
5. **Track costs** when running multiple tasks
6. **Update models regularly** with `--force-update`
7. **Use --stdin** for large prompts (git diffs, code review)

### ❌ DON'T

1. **Don't run Claudish directly** in main conversation (pollutes context)
2. **Don't ignore model selection** (different models have different strengths)
3. **Don't parse text output** (use --json instead)
4. **Don't hardcode model lists** (query dynamically)
5. **Don't skip error handling** (Claudish might not be installed)
6. **Don't return full output** in sub-agents (summary only)

## Quick Reference Commands

```bash
# Installation
npm install -g claudish

# Get models
claudish --list-models --json

# Run task
claudish --model x-ai/grok-code-fast-1 "your task"

# Large prompt
git diff | claudish --stdin --model google/gemini-2.5-flash "review"

# JSON output
claudish --json --model grok "task" | jq -r '.total_cost_usd'

# Update models
claudish --list-models --force-update

# Get help
claudish --help
```

## Example: Complete Sub-Agent Implementation

```typescript
/**
 * Example: Implement feature with Claudish + Grok
 * Returns summary only, full implementation in file
 */
async function implementFeatureWithGrok(description: string): Promise<string> {
  const timestamp = Date.now();
  const instructionFile = `/tmp/claudish-implement-${timestamp}.md`;
  const resultFile = `/tmp/claudish-result-${timestamp}.md`;

  try {
    // 1. Create instruction
    const instruction = `# Feature Implementation

## Description
${description}

## Requirements
- Clean, maintainable code
- Comprehensive tests
- Error handling
- Documentation

## Output File
${resultFile}

## Format
\`\`\`markdown
## Files Modified
- path/to/file1.ts
- path/to/file2.ts

## Summary
[2-3 sentence summary]

## Tests Added
- test description 1
- test description 2
\`\`\`
`;

    await Write({ file_path: instructionFile, content: instruction });

    // 2. Run Claudish
    await Bash(`claudish --model x-ai/grok-code-fast-1 --stdin < ${instructionFile}`);

    // 3. Read result
    const result = await Read({ file_path: resultFile });

    // 4. Extract summary
    const filesMatch = result.match(/## Files Modified\s*\n(.*?)(?=\n##|$)/s);
    const files = filesMatch ? filesMatch[1].trim().split('\n').length : 0;

    const summaryMatch = result.match(/## Summary\s*\n(.*?)(?=\n##|$)/s);
    const summary = summaryMatch ? summaryMatch[1].trim() : "Implementation completed";

    // 5. Clean up
    await Bash(`rm ${instructionFile} ${resultFile}`);

    // 6. Return concise summary
    return `✅ Feature implemented. Modified ${files} files. ${summary}`;

  } catch (error) {
    // 7. Handle errors
    console.error("Claudish implementation failed:", error.message);

    // Clean up if files exist
    try {
      await Bash(`rm -f ${instructionFile} ${resultFile}`);
    } catch {}

    return `❌ Implementation failed: ${error.message}`;
  }
}
```

## Additional Resources

- **Full Documentation:** `<claudish-install-path>/README.md`
- **Skill Document:** `skills/claudish-usage/SKILL.md` (in repository root)
- **Model Integration:** `skills/claudish-integration/SKILL.md` (in repository root)
- **OpenRouter Docs:** https://openrouter.ai/docs
- **Claudish GitHub:** https://github.com/MadAppGang/claude-code

## Get This Guide

```bash
# Print this guide
claudish --help-ai

# Save to file
claudish --help-ai > claudish-agent-guide.md
```

---

**Version:** 2.0.0
**Last Updated:** January 5, 2026
**Maintained by:** MadAppGang
