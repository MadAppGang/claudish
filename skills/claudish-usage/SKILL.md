---
name: claudish-usage
description: CRITICAL - Guide for using Claudish CLI ONLY through sub-agents to run Claude Code with any AI model (OpenRouter, Gemini, OpenAI, local models). NEVER run Claudish directly in main context unless user explicitly requests it. Use when user mentions external AI models, Claudish, OpenRouter, Gemini, OpenAI, Ollama, or alternative models. Includes mandatory sub-agent delegation patterns, agent selection guide, file-based instructions, and strict rules to prevent context window pollution.
---

# Claudish Usage Skill

**Version:** 2.0.0
**Purpose:** Guide AI agents on how to use Claudish CLI to run Claude Code with any AI model
**Status:** Production Ready

## ⚠️ CRITICAL RULES - READ FIRST

### 🚫 NEVER Run Claudish from Main Context

**Claudish MUST ONLY be run through sub-agents** unless the user **explicitly** requests direct execution.

**Why:**
- Running Claudish directly pollutes main context with 10K+ tokens (full conversation + reasoning)
- Destroys context window efficiency
- Makes main conversation unmanageable

**When you can run Claudish directly:**
- ✅ User explicitly says "run claudish directly" or "don't use a sub-agent"
- ✅ User is debugging and wants to see full output
- ✅ User specifically requests main context execution

**When you MUST use sub-agent:**
- ✅ User says "use Grok to implement X" (delegate to sub-agent)
- ✅ User says "ask GPT-5 to review X" (delegate to sub-agent)
- ✅ User mentions any model name without "directly" (delegate to sub-agent)
- ✅ Any production task (always delegate)

### 📋 Workflow Decision Tree

```
User Request
    ↓
Does it mention Claudish/OpenRouter/model name? → NO → Don't use this skill
    ↓ YES
    ↓
Does user say "directly" or "in main context"? → YES → Run in main context (rare)
    ↓ NO
    ↓
Find appropriate agent or create one → Delegate to sub-agent (default)
```

## 🤖 Agent Selection Guide

### Step 1: Find the Right Agent

**When user requests Claudish task, follow this process:**

1. **Check for existing agents** that support proxy mode or external model delegation
2. **If no suitable agent exists:**
   - Suggest creating a new proxy-mode agent for this task type
   - Offer to proceed with generic `general-purpose` agent if user declines
3. **If user declines agent creation:**
   - Warn about context pollution
   - Ask if they want to proceed anyway

### Step 2: Agent Type Selection Matrix

| Task Type | Recommended Agent | Fallback | Notes |
|-----------|------------------|----------|-------|
| **Code implementation** | Create coding agent with proxy mode | `general-purpose` | Best: custom agent for project-specific patterns |
| **Code review** | Use existing code review agent + proxy | `general-purpose` | Check if plugin has review agent first |
| **Architecture planning** | Use existing architect agent + proxy | `general-purpose` | Look for `architect` or `planner` agents |
| **Testing** | Use existing test agent + proxy | `general-purpose` | Look for `test-architect` or `tester` agents |
| **Refactoring** | Create refactoring agent with proxy | `general-purpose` | Complex refactors benefit from specialized agent |
| **Documentation** | `general-purpose` | - | Simple task, generic agent OK |
| **Analysis** | Use existing analysis agent + proxy | `general-purpose` | Check for `analyzer` or `detective` agents |
| **Other** | `general-purpose` | - | Default for unknown task types |

### Step 3: Agent Creation Offer (When No Agent Exists)

**Template response:**
```
I notice you want to use [Model Name] for [task type].

RECOMMENDATION: Create a specialized [task type] agent with proxy mode support.

This would:
✅ Provide better task-specific guidance
✅ Reusable for future [task type] tasks
✅ Optimized prompting for [Model Name]

Options:
1. Create specialized agent (recommended) - takes 2-3 minutes
2. Use generic general-purpose agent - works but less optimized
3. Run directly in main context (NOT recommended - pollutes context)

Which would you prefer?
```

### Step 4: Common Agents by Plugin

**Frontend Plugin:**
- `typescript-frontend-dev` - Use for UI implementation with external models
- `frontend-architect` - Use for architecture planning with external models
- `senior-code-reviewer` - Use for code review (can delegate to external models)
- `test-architect` - Use for test planning/implementation

**Bun Backend Plugin:**
- `backend-developer` - Use for API implementation with external models
- `api-architect` - Use for API design with external models

**Code Analysis Plugin:**
- `codebase-detective` - Use for investigation tasks with external models

**No Plugin:**
- `general-purpose` - Default fallback for any task

### Step 5: Example Agent Selection

**Example 1: User says "use Grok to implement authentication"**
```
Task: Code implementation (authentication)
Plugin: Bun Backend (if backend) or Frontend (if UI)

Decision:
1. Check for backend-developer or typescript-frontend-dev agent
2. Found backend-developer? → Use it with Grok proxy
3. Not found? → Offer to create custom auth agent
4. User declines? → Use general-purpose with file-based pattern
```

**Example 2: User says "ask GPT-5 to review my API design"**
```
Task: Code review (API design)
Plugin: Bun Backend

Decision:
1. Check for api-architect or senior-code-reviewer agent
2. Found? → Use it with GPT-5 proxy
3. Not found? → Use general-purpose with review instructions
4. Never run directly in main context
```

**Example 3: User says "use Gemini to refactor this component"**
```
Task: Refactoring (component)
Plugin: Frontend

Decision:
1. No specialized refactoring agent exists
2. Offer to create component-refactoring agent
3. User declines? → Use typescript-frontend-dev with proxy
4. Still no agent? → Use general-purpose with file-based pattern
```

## Overview

**Claudish** is a CLI tool that allows running Claude Code with any AI model via prefix-based routing. Supports OpenRouter (100+ models), direct Google Gemini API, direct OpenAI API, and local models (Ollama, LM Studio, vLLM, MLX).

**Key Principle:** **ALWAYS** use Claudish through sub-agents with file-based instructions to avoid context window pollution.

## What is Claudish?

Claudish (Claude-ish) is a proxy tool that:
- ✅ Runs Claude Code with **any AI model** via prefix-based routing
- ✅ Supports OpenRouter, Gemini, OpenAI, and local models
- ✅ Uses local API-compatible proxy server
- ✅ Supports 100% of Claude Code features
- ✅ Provides cost tracking and model selection
- ✅ Enables multi-model workflows

## Model Routing

| Prefix | Backend | Example |
|--------|---------|---------|
| _(none)_ | OpenRouter | `openai/gpt-5.2` |
| `g/` `gemini/` | Google Gemini | `g/gemini-2.0-flash` |
| `oai/` `openai/` | OpenAI | `oai/gpt-4o` |
| `ollama/` | Ollama | `ollama/llama3.2` |
| `lmstudio/` | LM Studio | `lmstudio/model` |
| `http://...` | Custom | `http://localhost:8000/model` |

**Use Cases:**
- Run tasks with different AI models (Grok for speed, GPT-5 for reasoning, Gemini for large context)
- Use direct APIs for lower latency (Gemini, OpenAI)
- Use local models for free, private inference (Ollama, LM Studio)
- Compare model performance on same task
- Reduce costs with cheaper models for simple tasks

## Requirements

### System Requirements
- **Claudish CLI** - Install with: `npm install -g claudish` or `bun install -g claudish`
- **Claude Code** - Must be installed
- **At least one API key** (see below)

### Environment Variables

```bash
# API Keys (at least one required)
export OPENROUTER_API_KEY='sk-or-v1-...'  # OpenRouter (100+ models)
export GEMINI_API_KEY='...'               # Direct Gemini API (g/ prefix)
export OPENAI_API_KEY='sk-...'            # Direct OpenAI API (oai/ prefix)

# Placeholder (required to prevent Claude Code dialog)
export ANTHROPIC_API_KEY='sk-ant-api03-placeholder'

# Custom endpoints (optional)
export GEMINI_BASE_URL='https://...'      # Custom Gemini endpoint
export OPENAI_BASE_URL='https://...'      # Custom OpenAI/Azure endpoint
export OLLAMA_BASE_URL='http://...'       # Custom Ollama server
export LMSTUDIO_BASE_URL='http://...'     # Custom LM Studio server

# Default model (optional)
export CLAUDISH_MODEL='openai/gpt-5.2'    # Default model
```

**Get API Keys:**
- OpenRouter: https://openrouter.ai/keys (free tier available)
- Gemini: https://aistudio.google.com/apikey
- OpenAI: https://platform.openai.com/api-keys
- Local models: No API key needed

## Quick Start Guide

### Step 1: Install Claudish

```bash
# With npm (works everywhere)
npm install -g claudish

# With Bun (faster)
bun install -g claudish

# Verify installation
claudish --version
```

### Step 2: Get Available Models

```bash
# List ALL OpenRouter models grouped by provider
claudish --models

# Fuzzy search models by name, ID, or description
claudish --models gemini
claudish --models "grok code"

# Show top recommended programming models (curated list)
claudish --top-models

# JSON output for parsing
claudish --models --json
claudish --top-models --json

# Force update from OpenRouter API
claudish --models --force-update
```

### Step 3: Run Claudish

**Interactive Mode (default):**
```bash
# Shows model selector, persistent session
claudish
```

**Single-shot Mode:**
```bash
# One task and exit (requires --model)
claudish --model x-ai/grok-code-fast-1 "implement user authentication"
```

**With stdin for large prompts:**
```bash
# Read prompt from stdin (useful for git diffs, code review)
git diff | claudish --stdin --model openai/gpt-5-codex "Review these changes"
```

## Recommended Models

**Top Models for Development (v3.1.1):**

| Model | Provider | Best For |
|-------|----------|----------|
| `openai/gpt-5.2` | OpenAI | **Default** - Most advanced reasoning |
| `minimax/minimax-m2.1` | MiniMax | Budget-friendly, fast |
| `z-ai/glm-4.7` | Z.AI | Balanced performance |
| `google/gemini-3-pro-preview` | Google | 1M context window |
| `moonshotai/kimi-k2-thinking` | MoonShot | Extended thinking |
| `deepseek/deepseek-v3.2` | DeepSeek | Code specialist |
| `qwen/qwen3-vl-235b-a22b-thinking` | Alibaba | Vision + reasoning |

**Direct API Options (lower latency):**

| Model | Backend | Best For |
|-------|---------|----------|
| `g/gemini-2.0-flash` | Gemini | Fast tasks, large context |
| `oai/gpt-4o` | OpenAI | General purpose |
| `ollama/llama3.2` | Local | Free, private |

**Get Latest Models:**
```bash
# List all models (auto-updates every 2 days)
claudish --models

# Search for specific models
claudish --models grok
claudish --models "gemini flash"

# Show curated top models
claudish --top-models

# Force immediate update
claudish --models --force-update
```

## NEW: Direct Agent Selection (v2.1.0)

**Use `--agent` flag to invoke agents directly without the file-based pattern:**

```bash
# Use specific agent (prepends @agent- automatically)
claudish --model x-ai/grok-code-fast-1 --agent frontend:developer "implement React component"

# Claude receives: "Use the @agent-frontend:developer agent to: implement React component"

# List available agents in project
claudish --list-agents
```

**When to use `--agent` vs file-based pattern:**

**Use `--agent` when:**
- Single, simple task that needs agent specialization
- Direct conversation with one agent
- Testing agent behavior
- CLI convenience

**Use file-based pattern when:**
- Complex multi-step workflows
- Multiple agents needed
- Large codebases
- Production tasks requiring review
- Need isolation from main conversation

**Example comparisons:**

**Simple task (use `--agent`):**
```bash
claudish --model x-ai/grok-code-fast-1 --agent frontend:developer "create button component"
```

**Complex task (use file-based):**
```typescript
// multi-phase-workflow.md
Phase 1: Use api-architect to design API
Phase 2: Use backend-developer to implement
Phase 3: Use test-architect to add tests
Phase 4: Use senior-code-reviewer to review

then:
claudish --model x-ai/grok-code-fast-1 --stdin < multi-phase-workflow.md
```

## Best Practice: File-Based Sub-Agent Pattern

### ⚠️ CRITICAL: Don't Run Claudish Directly from Main Conversation

**Why:** Running Claudish directly in main conversation pollutes context window with:
- Entire conversation transcript
- All tool outputs
- Model reasoning (can be 10K+ tokens)

**Solution:** Use file-based sub-agent pattern

### File-Based Pattern (Recommended)

**Step 1: Create instruction file**
```markdown
# /tmp/claudish-task-{timestamp}.md

## Task
Implement user authentication with JWT tokens

## Requirements
- Use bcrypt for password hashing
- Generate JWT with 24h expiration
- Add middleware for protected routes

## Deliverables
Write implementation to: /tmp/claudish-result-{timestamp}.md

## Output Format
```markdown
## Implementation

[code here]

## Files Created/Modified
- path/to/file1.ts
- path/to/file2.ts

## Tests
[test code if applicable]

## Notes
[any important notes]
```
```

**Step 2: Run Claudish with file instruction**
```bash
# Read instruction from file, write result to file
claudish --model x-ai/grok-code-fast-1 --stdin < /tmp/claudish-task-{timestamp}.md > /tmp/claudish-result-{timestamp}.md
```

**Step 3: Read result file and provide summary**
```typescript
// In your agent/command:
const result = await Read({ file_path: "/tmp/claudish-result-{timestamp}.md" });

// Parse result
const filesModified = extractFilesModified(result);
const summary = extractSummary(result);

// Provide short feedback to main agent
return `✅ Task completed. Modified ${filesModified.length} files. ${summary}`;
```

### Complete Example: Using Claudish in Sub-Agent

```typescript
/**
 * Example: Run code review with Grok via Claudish sub-agent
 */
async function runCodeReviewWithGrok(files: string[]) {
  const timestamp = Date.now();
  const instructionFile = `/tmp/claudish-review-instruction-${timestamp}.md`;
  const resultFile = `/tmp/claudish-review-result-${timestamp}.md`;

  // Step 1: Create instruction file
  const instruction = `# Code Review Task

## Files to Review
${files.map(f => `- ${f}`).join('\n')}

## Review Criteria
- Code quality and maintainability
- Potential bugs or issues
- Performance considerations
- Security vulnerabilities

## Output Format
Write your review to: ${resultFile}

Use this format:
\`\`\`markdown
## Summary
[Brief overview]

## Issues Found
### Critical
- [issue 1]

### Medium
- [issue 2]

### Low
- [issue 3]

## Recommendations
- [recommendation 1]

## Files Reviewed
- [file 1]: [status]
\`\`\`
`;

  await Write({ file_path: instructionFile, content: instruction });

  // Step 2: Run Claudish with stdin
  await Bash(`claudish --model x-ai/grok-code-fast-1 --stdin < ${instructionFile}`);

  // Step 3: Read result
  const result = await Read({ file_path: resultFile });

  // Step 4: Parse and return summary
  const summary = extractSummary(result);
  const issueCount = extractIssueCount(result);

  // Step 5: Clean up temp files
  await Bash(`rm ${instructionFile} ${resultFile}`);

  // Step 6: Return concise feedback
  return {
    success: true,
    summary,
    issueCount,
    fullReview: result  // Available if needed, but not in main context
  };
}

function extractSummary(review: string): string {
  const match = review.match(/## Summary\s*\n(.*?)(?=\n##|$)/s);
  return match ? match[1].trim() : "Review completed";
}

function extractIssueCount(review: string): { critical: number; medium: number; low: number } {
  const critical = (review.match(/### Critical\s*\n(.*?)(?=\n###|$)/s)?.[1].match(/^-/gm) || []).length;
  const medium = (review.match(/### Medium\s*\n(.*?)(?=\n###|$)/s)?.[1].match(/^-/gm) || []).length;
  const low = (review.match(/### Low\s*\n(.*?)(?=\n###|$)/s)?.[1].match(/^-/gm) || []).length;

  return { critical, medium, low };
}
```

## Sub-Agent Delegation Pattern

When running Claudish from an agent, use the Task tool to create a sub-agent:

### Pattern 1: Simple Task Delegation

```typescript
/**
 * Example: Delegate implementation to Grok via Claudish
 */
async function implementFeatureWithGrok(featureDescription: string) {
  // Use Task tool to create sub-agent
  const result = await Task({
    subagent_type: "general-purpose",
    description: "Implement feature with Grok",
    prompt: `
Use Claudish CLI to implement this feature with Grok model:

${featureDescription}

INSTRUCTIONS:
1. Search for available models:
   claudish --models grok

2. Run implementation with Grok:
   claudish --model x-ai/grok-code-fast-1 "${featureDescription}"

3. Return ONLY:
   - List of files created/modified
   - Brief summary (2-3 sentences)
   - Any errors encountered

DO NOT return the full conversation transcript or implementation details.
Keep your response under 500 tokens.
    `
  });

  return result;
}
```

### Pattern 2: File-Based Task Delegation

```typescript
/**
 * Example: Use file-based instruction pattern in sub-agent
 */
async function analyzeCodeWithGemini(codebasePath: string) {
  const timestamp = Date.now();
  const instructionFile = `/tmp/claudish-analyze-${timestamp}.md`;
  const resultFile = `/tmp/claudish-analyze-result-${timestamp}.md`;

  // Create instruction file
  const instruction = `# Codebase Analysis Task

## Codebase Path
${codebasePath}

## Analysis Required
- Architecture overview
- Key patterns used
- Potential improvements
- Security considerations

## Output
Write analysis to: ${resultFile}

Keep analysis concise (under 1000 words).
`;

  await Write({ file_path: instructionFile, content: instruction });

  // Delegate to sub-agent
  const result = await Task({
    subagent_type: "general-purpose",
    description: "Analyze codebase with Gemini",
    prompt: `
Use Claudish to analyze codebase with Gemini model.

Instruction file: ${instructionFile}
Result file: ${resultFile}

STEPS:
1. Read instruction file: ${instructionFile}
2. Run: claudish --model google/gemini-2.5-flash --stdin < ${instructionFile}
3. Wait for completion
4. Read result file: ${resultFile}
5. Return ONLY a 2-3 sentence summary

DO NOT include the full analysis in your response.
The full analysis is in ${resultFile} if needed.
    `
  });

  // Read full result if needed
  const fullAnalysis = await Read({ file_path: resultFile });

  // Clean up
  await Bash(`rm ${instructionFile} ${resultFile}`);

  return {
    summary: result,
    fullAnalysis
  };
}
```

### Pattern 3: Multi-Model Comparison

```typescript
/**
 * Example: Run same task with multiple models and compare
 */
async function compareModels(task: string, models: string[]) {
  const results = [];

  for (const model of models) {
    const timestamp = Date.now();
    const resultFile = `/tmp/claudish-${model.replace('/', '-')}-${timestamp}.md`;

    // Run task with each model
    await Task({
      subagent_type: "general-purpose",
      description: `Run task with ${model}`,
      prompt: `
Use Claudish to run this task with ${model}:

${task}

STEPS:
1. Run: claudish --model ${model} --json "${task}"
2. Parse JSON output
3. Return ONLY:
   - Cost (from total_cost_usd)
   - Duration (from duration_ms)
   - Token usage (from usage.input_tokens and usage.output_tokens)
   - Brief quality assessment (1-2 sentences)

DO NOT return full output.
      `
    });

    results.push({
      model,
      resultFile
    });
  }

  return results;
}
```

## Common Workflows

### Workflow 1: Quick Code Generation with Grok

```bash
# Fast, agentic coding with visible reasoning
claudish --model x-ai/grok-code-fast-1 "add error handling to api routes"
```

### Workflow 2: Complex Refactoring with GPT-5

```bash
# Advanced reasoning for complex tasks
claudish --model openai/gpt-5 "refactor authentication system to use OAuth2"
```

### Workflow 3: UI Implementation with Qwen (Vision)

```bash
# Vision-language model for UI tasks
claudish --model qwen/qwen3-vl-235b-a22b-instruct "implement dashboard from figma design"
```

### Workflow 4: Code Review with Gemini

```bash
# State-of-the-art reasoning for thorough review
git diff | claudish --stdin --model google/gemini-2.5-flash "Review these changes for bugs and improvements"
```

### Workflow 5: Multi-Model Consensus

```bash
# Run same task with multiple models
for model in "x-ai/grok-code-fast-1" "google/gemini-2.5-flash" "openai/gpt-5"; do
  echo "=== Testing with $model ==="
  claudish --model "$model" "find security vulnerabilities in auth.ts"
done
```

## Claudish CLI Flags Reference

### Essential Flags

| Flag | Description | Example |
|------|-------------|---------|
| `--model <model>` | OpenRouter model to use | `--model x-ai/grok-code-fast-1` |
| `--stdin` | Read prompt from stdin | `git diff \| claudish --stdin --model grok` |
| `--models` | List all models or search | `claudish --models` or `claudish --models gemini` |
| `--top-models` | Show top recommended models | `claudish --top-models` |
| `--json` | JSON output (implies --quiet) | `claudish --json "task"` |
| `--help-ai` | Print AI agent usage guide | `claudish --help-ai` |

### Advanced Flags

| Flag | Description | Default |
|------|-------------|---------|
| `--interactive` / `-i` | Interactive mode | Auto (no prompt = interactive) |
| `--quiet` / `-q` | Suppress log messages | Quiet in single-shot |
| `--verbose` / `-v` | Show log messages | Verbose in interactive |
| `--debug` / `-d` | Enable debug logging to file | Disabled |
| `--port <port>` | Proxy server port | Random (3000-9000) |
| `--no-auto-approve` | Require permission prompts | Auto-approve enabled |
| `--dangerous` | Disable sandbox | Disabled |
| `--monitor` | Proxy to real Anthropic API (debug) | Disabled |
| `--force-update` | Force refresh model cache | Auto (>2 days) |

### Output Modes

1. **Quiet Mode (default in single-shot)**
   ```bash
   claudish --model grok "task"
   # Clean output, no [claudish] logs
   ```

2. **Verbose Mode**
   ```bash
   claudish --verbose "task"
   # Shows all [claudish] logs for debugging
   ```

3. **JSON Mode**
   ```bash
   claudish --json "task"
   # Structured output: {result, cost, usage, duration}
   ```

## Cost Tracking

Claudish automatically tracks costs in the status line:

```
directory • model-id • $cost • ctx%
```

**Example:**
```
my-project • x-ai/grok-code-fast-1 • $0.12 • 67%
```

Shows:
- 💰 **Cost**: $0.12 USD spent in current session
- 📊 **Context**: 67% of context window remaining

**JSON Output Cost:**
```bash
claudish --json "task" | jq '.total_cost_usd'
# Output: 0.068
```

## Error Handling

### Error 1: OPENROUTER_API_KEY Not Set

**Error:**
```
Error: OPENROUTER_API_KEY environment variable is required
```

**Fix:**
```bash
export OPENROUTER_API_KEY='sk-or-v1-...'
# Or add to ~/.zshrc or ~/.bashrc
```

### Error 2: Claudish Not Installed

**Error:**
```
command not found: claudish
```

**Fix:**
```bash
npm install -g claudish
# Or: bun install -g claudish
```

### Error 3: Model Not Found

**Error:**
```
Model 'invalid/model' not found
```

**Fix:**
```bash
# List available models
claudish --models

# Use valid model ID
claudish --model x-ai/grok-code-fast-1 "task"
```

### Error 4: OpenRouter API Error

**Error:**
```
OpenRouter API error: 401 Unauthorized
```

**Fix:**
1. Check API key is correct
2. Verify API key at https://openrouter.ai/keys
3. Check API key has credits (free tier or paid)

### Error 5: Port Already in Use

**Error:**
```
Error: Port 3000 already in use
```

**Fix:**
```bash
# Let Claudish pick random port (default)
claudish --model grok "task"

# Or specify different port
claudish --port 8080 --model grok "task"
```

## Best Practices

### 1. ✅ Use File-Based Instructions

**Why:** Avoids context window pollution

**How:**
```bash
# Write instruction to file
echo "Implement feature X" > /tmp/task.md

# Run with stdin
claudish --stdin --model grok < /tmp/task.md > /tmp/result.md

# Read result
cat /tmp/result.md
```

### 2. ✅ Choose Right Model for Task

**Fast Coding:** `x-ai/grok-code-fast-1`
**Complex Reasoning:** `google/gemini-2.5-flash` or `openai/gpt-5`
**Vision/UI:** `qwen/qwen3-vl-235b-a22b-instruct`

### 3. ✅ Use --json for Automation

**Why:** Structured output, easier parsing

**How:**
```bash
RESULT=$(claudish --json "task" | jq -r '.result')
COST=$(claudish --json "task" | jq -r '.total_cost_usd')
```

### 4. ✅ Delegate to Sub-Agents

**Why:** Keeps main conversation context clean

**How:**
```typescript
await Task({
  subagent_type: "general-purpose",
  description: "Task with Claudish",
  prompt: "Use claudish --model grok '...' and return summary only"
});
```

### 5. ✅ Update Models Regularly

**Why:** Get latest model recommendations

**How:**
```bash
# Auto-updates every 2 days
claudish --models

# Search for specific models
claudish --models deepseek

# Force update now
claudish --models --force-update
```

### 6. ✅ Use --stdin for Large Prompts

**Why:** Avoid command line length limits

**How:**
```bash
git diff | claudish --stdin --model grok "Review changes"
```

## Anti-Patterns (Avoid These)

### ❌❌❌ NEVER Run Claudish Directly in Main Conversation (CRITICAL)

**This is the #1 mistake. Never do this unless user explicitly requests it.**

**WRONG - Destroys context window:**
```typescript
// ❌ NEVER DO THIS - Pollutes main context with 10K+ tokens
await Bash("claudish --model grok 'implement feature'");

// ❌ NEVER DO THIS - Full conversation in main context
await Bash("claudish --model gemini 'review code'");

// ❌ NEVER DO THIS - Even with --json, output is huge
const result = await Bash("claudish --json --model gpt-5 'refactor'");
```

**RIGHT - Always use sub-agents:**
```typescript
// ✅ ALWAYS DO THIS - Delegate to sub-agent
const result = await Task({
  subagent_type: "general-purpose", // or specific agent
  description: "Implement feature with Grok",
  prompt: `
Use Claudish to implement the feature with Grok model.

CRITICAL INSTRUCTIONS:
1. Create instruction file: /tmp/claudish-task-${Date.now()}.md
2. Write detailed task requirements to file
3. Run: claudish --model x-ai/grok-code-fast-1 --stdin < /tmp/claudish-task-*.md
4. Read result file and return ONLY a 2-3 sentence summary

DO NOT return full implementation or conversation.
Keep response under 300 tokens.
  `
});

// ✅ Even better - Use specialized agent if available
const result = await Task({
  subagent_type: "backend-developer", // or frontend-dev, etc.
  description: "Implement with external model",
  prompt: `
Use Claudish with x-ai/grok-code-fast-1 model to implement authentication.
Follow file-based instruction pattern.
Return summary only.
  `
});
```

**When you CAN run directly (rare exceptions):**
```typescript
// ✅ Only when user explicitly requests
// User: "Run claudish directly in main context for debugging"
if (userExplicitlyRequestedDirect) {
  await Bash("claudish --model grok 'task'");
}
```

### ❌ Don't Ignore Model Selection

**Wrong:**
```bash
# Always using default model
claudish "any task"
```

**Right:**
```bash
# Choose appropriate model
claudish --model x-ai/grok-code-fast-1 "quick fix"
claudish --model google/gemini-2.5-flash "complex analysis"
```

### ❌ Don't Parse Text Output

**Wrong:**
```bash
OUTPUT=$(claudish --model grok "task")
COST=$(echo "$OUTPUT" | grep cost | awk '{print $2}')
```

**Right:**
```bash
# Use JSON output
COST=$(claudish --json --model grok "task" | jq -r '.total_cost_usd')
```

### ❌ Don't Hardcode Model Lists

**Wrong:**
```typescript
const MODELS = ["x-ai/grok-code-fast-1", "openai/gpt-5"];
```

**Right:**
```typescript
// Query dynamically
const { stdout } = await Bash("claudish --models --json");
const models = JSON.parse(stdout).models.map(m => m.id);
```

### ✅ Do Accept Custom Models From Users

**Problem:** User provides a custom model ID that's not in --top-models

**Wrong (rejecting custom models):**
```typescript
const availableModels = ["x-ai/grok-code-fast-1", "openai/gpt-5"];
const userModel = "custom/provider/model-123";

if (!availableModels.includes(userModel)) {
  throw new Error("Model not in my shortlist"); // ❌ DON'T DO THIS
}
```

**Right (accept any valid model ID):**
```typescript
// Claudish accepts ANY valid OpenRouter model ID, even if not in --top-models
const userModel = "custom/provider/model-123";

// Validate it's a non-empty string with provider format
if (!userModel.includes("/")) {
  console.warn("Model should be in format: provider/model-name");
}

// Use it directly - Claudish will validate with OpenRouter
await Bash(`claudish --model ${userModel} "task"`);
```

**Why:** Users may have access to:
- Beta/experimental models
- Private/custom fine-tuned models
- Newly released models not yet in rankings
- Regional/enterprise models
- Cost-saving alternatives

**Always accept user-provided model IDs** unless they're clearly invalid (empty, wrong format).

### ✅ Do Handle User-Preferred Models

**Scenario:** User says "use my custom model X" and expects it to be remembered

**Solution 1: Environment Variable (Recommended)**
```typescript
// Set for the session
process.env.CLAUDISH_MODEL = userPreferredModel;

// Or set permanently in user's shell profile
await Bash(`echo 'export CLAUDISH_MODEL="${userPreferredModel}"' >> ~/.zshrc`);
```

**Solution 2: Session Cache**
```typescript
// Store in a temporary session file
const sessionFile = "/tmp/claudish-user-preferences.json";
const prefs = {
  preferredModel: userPreferredModel,
  lastUsed: new Date().toISOString()
};
await Write({ file_path: sessionFile, content: JSON.stringify(prefs, null, 2) });

// Load in subsequent commands
const { stdout } = await Read({ file_path: sessionFile });
const prefs = JSON.parse(stdout);
const model = prefs.preferredModel || defaultModel;
```

**Solution 3: Prompt Once, Remember for Session**
```typescript
// In a multi-step workflow, ask once
if (!process.env.CLAUDISH_MODEL) {
  const { stdout } = await Bash("claudish --models --json");
  const models = JSON.parse(stdout).models;

  const response = await AskUserQuestion({
    question: "Select model (or enter custom model ID):",
    options: models.map((m, i) => ({ label: m.name, value: m.id })).concat([
      { label: "Enter custom model...", value: "custom" }
    ])
  });

  if (response === "custom") {
    const customModel = await AskUserQuestion({
      question: "Enter OpenRouter model ID (format: provider/model):"
    });
    process.env.CLAUDISH_MODEL = customModel;
  } else {
    process.env.CLAUDISH_MODEL = response;
  }
}

// Use the selected model for all subsequent calls
const model = process.env.CLAUDISH_MODEL;
await Bash(`claudish --model ${model} "task 1"`);
await Bash(`claudish --model ${model} "task 2"`);
```

**Guidance for Agents:**
1. ✅ **Accept any model ID** user provides (unless obviously malformed)
2. ✅ **Don't filter** based on your "shortlist" - let Claudish handle validation
3. ✅ **Offer to set CLAUDISH_MODEL** environment variable for session persistence
4. ✅ **Explain** that --top-models shows curated recommendations, --models shows all
5. ✅ **Validate format** (should contain "/") but not restrict to known models
6. ❌ **Never reject** a user's custom model with "not in my shortlist"

### ❌ Don't Skip Error Handling

**Wrong:**
```typescript
const result = await Bash("claudish --model grok 'task'");
```

**Right:**
```typescript
try {
  const result = await Bash("claudish --model grok 'task'");
} catch (error) {
  console.error("Claudish failed:", error.message);
  // Fallback to embedded Claude or handle error
}
```

## Agent Integration Examples

### Example 1: Code Review Agent

```typescript
/**
 * Agent: code-reviewer (using Claudish with multiple models)
 */
async function reviewCodeWithMultipleModels(files: string[]) {
  const models = [
    "x-ai/grok-code-fast-1",      // Fast initial scan
    "google/gemini-2.5-flash",    // Deep analysis
    "openai/gpt-5"                // Final validation
  ];

  const reviews = [];

  for (const model of models) {
    const timestamp = Date.now();
    const instructionFile = `/tmp/review-${model.replace('/', '-')}-${timestamp}.md`;
    const resultFile = `/tmp/review-result-${model.replace('/', '-')}-${timestamp}.md`;

    // Create instruction
    const instruction = createReviewInstruction(files, resultFile);
    await Write({ file_path: instructionFile, content: instruction });

    // Run review with model
    await Bash(`claudish --model ${model} --stdin < ${instructionFile}`);

    // Read result
    const result = await Read({ file_path: resultFile });

    // Extract summary
    reviews.push({
      model,
      summary: extractSummary(result),
      issueCount: extractIssueCount(result)
    });

    // Clean up
    await Bash(`rm ${instructionFile} ${resultFile}`);
  }

  return reviews;
}
```

### Example 2: Feature Implementation Command

```typescript
/**
 * Command: /implement-with-model
 * Usage: /implement-with-model "feature description"
 */
async function implementWithModel(featureDescription: string) {
  // Step 1: Get available models
  const { stdout } = await Bash("claudish --models --json");
  const models = JSON.parse(stdout).models;

  // Step 2: Let user select model
  const selectedModel = await promptUserForModel(models);

  // Step 3: Create instruction file
  const timestamp = Date.now();
  const instructionFile = `/tmp/implement-${timestamp}.md`;
  const resultFile = `/tmp/implement-result-${timestamp}.md`;

  const instruction = `# Feature Implementation

## Description
${featureDescription}

## Requirements
- Write clean, maintainable code
- Add comprehensive tests
- Include error handling
- Follow project conventions

## Output
Write implementation details to: ${resultFile}

Include:
- Files created/modified
- Code snippets
- Test coverage
- Documentation updates
`;

  await Write({ file_path: instructionFile, content: instruction });

  // Step 4: Run implementation
  await Bash(`claudish --model ${selectedModel} --stdin < ${instructionFile}`);

  // Step 5: Read and present results
  const result = await Read({ file_path: resultFile });

  // Step 6: Clean up
  await Bash(`rm ${instructionFile} ${resultFile}`);

  return result;
}
```

## Troubleshooting

### Issue: Slow Performance

**Symptoms:** Claudish takes long time to respond

**Solutions:**
1. Use faster model: `x-ai/grok-code-fast-1` or `minimax/minimax-m2`
2. Reduce prompt size (use --stdin with concise instructions)
3. Check internet connection to OpenRouter

### Issue: High Costs

**Symptoms:** Unexpected API costs

**Solutions:**
1. Use budget-friendly models (check pricing with `--models` or `--top-models`)
2. Enable cost tracking: `--cost-tracker`
3. Use --json to monitor costs: `claudish --json "task" | jq '.total_cost_usd'`

### Issue: Context Window Exceeded

**Symptoms:** Error about token limits

**Solutions:**
1. Use model with larger context (Gemini: 1000K, Grok: 256K)
2. Break task into smaller subtasks
3. Use file-based pattern to avoid conversation history

### Issue: Model Not Available

**Symptoms:** "Model not found" error

**Solutions:**
1. Update model cache: `claudish --models --force-update`
2. Check OpenRouter website for model availability
3. Use alternative model from same category

## Additional Resources

**Documentation:**
- Full README: `mcp/claudish/README.md` (in repository root)
- AI Agent Guide: Print with `claudish --help-ai`
- Model Integration: `skills/claudish-integration/SKILL.md` (in repository root)

**External Links:**
- Claudish GitHub: https://github.com/MadAppGang/claude-code
- OpenRouter: https://openrouter.ai
- OpenRouter Models: https://openrouter.ai/models
- OpenRouter API Docs: https://openrouter.ai/docs

**Version Information:**
```bash
claudish --version
```

**Get Help:**
```bash
claudish --help        # CLI usage
claudish --help-ai     # AI agent usage guide
```

---

**Maintained by:** MadAppGang
**Last Updated:** January 5, 2026
**Skill Version:** 2.0.0
