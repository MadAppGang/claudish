# Single-Shot Mode

**One task. One result. Exit.**

Interactive sessions are great for exploration. But sometimes you just need to run a command, get the output, and move on.

That's single-shot mode.

---

## Basic Usage

```bash
claudish --model x-ai/grok-code-fast-1 "add input validation to the login form"
```

Claudish:
1. Spins up a proxy
2. Runs Claude Code with your prompt
3. Prints the result
4. Exits

No interaction. No model selector. Just results.

A listing entry (`--model devin@`, a shortcut with no model) fills `/model` in an interactive
session. Single-shot mode accepts it but fetches no list; the session starts on the last full
model spec, or on Claude's default model when there is none. See
[Listing providers' models in `/model`](../settings-reference.md#522-listing-providers-models-in-claude-codes-model).

---

## When to Use This

**Scripts and automation:**
```bash
#!/bin/bash
claudish --model minimax/minimax-m2 "generate unit tests for src/utils.ts"
```

**Quick fixes:**
```bash
claudish --model x-ai/grok-code-fast-1 "fix the typo in README.md"
```

**Code reviews:**
```bash
claudish --model openai/gpt-5.1-codex "review the changes in the last commit"
```

**Batch operations:**
```bash
for file in src/*.ts; do
  claudish --model minimax/minimax-m2 "add JSDoc comments to $file"
done
```

---

## Quiet by Default

Single-shot mode suppresses `[claudish]` logs automatically.

You only see the model's output. Clean.

Want the logs?
```bash
claudish --verbose --model x-ai/grok-code-fast-1 "your prompt"
```

---

## JSON Output

Need structured data for tooling?

```bash
claudish --json --model minimax/minimax-m2 "list 5 common TypeScript patterns"
```

Output is valid JSON. Perfect for piping to `jq` or other tools.

---

## Reading from Stdin

Got a massive prompt? Don't paste it in quotes. Pipe it:

```bash
echo "Review this code and suggest improvements" | claudish --stdin --model openai/gpt-5.1-codex
```

**Real-world example - code review a diff:**
```bash
git diff HEAD~1 | claudish --stdin --model openai/gpt-5.1-codex "Review these changes"
```

**Review a whole file:**
```bash
cat src/complex-module.ts | claudish --stdin --model google/gemini-3-pro-preview "Explain this code"
```

---

## Combining Flags

```bash
# Quiet + JSON + stdin
git diff | claudish --stdin --json --quiet --model x-ai/grok-code-fast-1 "summarize changes"
```

This gives you:
- No log noise (`--quiet`)
- Structured output (`--json`)
- Input from pipe (`--stdin`)

---

## Dangerous Mode

Need full autonomy? No sandbox restrictions?

```bash
claudish --dangerous --model x-ai/grok-code-fast-1 "refactor the entire auth module"
```

This passes `--dangerouslyDisableSandbox` to Claude Code.

**Use with caution.** The model can do anything.

---

## Exit Codes

- `0` - Success
- `1` - Error (model failure, API issue, etc.)

Script it:
```bash
if claudish --model minimax/minimax-m2 "run tests"; then
  echo "Tests passed"
else
  echo "Something broke"
fi
```

---

## Performance Tips

**Use the right model for the task:**
- Quick fixes → `minimax/minimax-m2` ($0.60/1M, fast)
- Complex reasoning → `google/gemini-3-pro-preview` (slower, smarter)

**Set a default model:**
```bash
export CLAUDISH_MODEL='minimax/minimax-m2'
claudish "quick fix"  # Uses MiniMax by default
```

**Skip network latency on repeated runs:**
The proxy stays warm for ~200ms after each request. Quick sequential calls benefit from this.

---

## Examples

**Generate a commit message:**
```bash
git diff --staged | claudish --stdin --model x-ai/grok-code-fast-1 "write a commit message for these changes"
```

**Explain an error:**
```bash
npm run build 2>&1 | claudish --stdin --model openai/gpt-5.1-codex "explain this error and how to fix it"
```

**Convert code:**
```bash
cat legacy.js | claudish --stdin --model minimax/minimax-m2 "convert to TypeScript"
```

**Document a function:**
```bash
claudish --model x-ai/grok-code-fast-1 "add JSDoc to the processPayment function in src/payments.ts"
```

---

## Next

- **[Automation Guide](../advanced/automation.md)** - CI/CD integration
- **[Interactive Mode](interactive-mode.md)** - When you need back-and-forth
