# Issue Triage Bot Setup

The Claudish project uses an automated issue triage bot powered by [Claude Code](https://github.com/anthropics/claude-code) (Opus 4.5) to categorize and respond to new GitHub issues.

## How It Works

When a new issue is opened:

1. **Checkout**: Full repository is checked out
2. **Claude Code Agent**: Runs with full codebase access via claudish
3. **Exploration**: Agent reads `README.md`, checks `src/` implementations, looks at `docs/`
4. **Analysis**: Determines if feature exists, is planned, or is new
5. **Response**: Posts a conversational reply with specific file references

## Key Difference: Full Codebase Access

Unlike simple API-based bots, this triage bot runs Claude Code with full access to:
- All source code in `src/`
- Documentation in `docs/` and `ai_docs/`
- Working examples in `README.md`
- Protocol documentation in `*.md` files

This means it can give accurate answers like "that's already implemented in `src/transform.ts`" or "see the Extended Thinking section in `README.md` for usage."

## Labels Used

| Label | Description |
|-------|-------------|
| `bug` | Something broken in existing feature |
| `enhancement` | New feature or improvement |
| `question` | User needs help/clarification |
| `discussion` | Open-ended topic for feedback |
| `duplicate` | Already exists as issue/feature |
| `P0-critical` | Critical - blocking users |
| `P1-high` | High - significant impact |
| `P2-medium` | Medium - quality of life |
| `P3-low` | Low - nice to have |
| `already-implemented` | Feature already exists |
| `planned` | Feature is on the roadmap |
| `provider-specific` | Related to specific provider (OpenRouter, Poe) |
| `protocol` | Related to Anthropic/OpenAI protocol translation |

## Setup Requirements

Add these secrets to your repository:

| Secret | Required | Description |
|--------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for Claude Code (Opus 4.5) |
| `CLAUDISH_BOT_APP_ID` | Yes | GitHub App ID for the triage bot |
| `CLAUDISH_BOT_PRIVATE_KEY` | Yes | GitHub App private key |

## Response Style

The bot uses a conversational, specific response style:
- 2-4 sentences max
- References specific files/examples from the codebase
- No generic phrases like "Thanks for sharing!"
- Points to documentation for planned features
- Willing to push back respectfully when needed

## Example Responses

**Already implemented:**
> The token scaling you're asking about is already in place - check out `src/transform.ts` and the Context Scaling section in `README.md`. The implementation handles any context window from 128k to 2M+.

**Configuration question:**
> You can set the model via `CLAUDISH_MODEL` env var or `--model` flag. See the Environment Variables table in README.md - if you're hitting rate limits, try `x-ai/grok-code-fast-1` which has generous limits.

**New idea:**
> Interesting angle on supporting local LLMs. We'd need to add a new provider handler in `src/proxy-server.ts`. Converting this to a discussion to gather more input on which local LLM APIs to prioritize.

**Bug Report:**
> I can reproduce this streaming issue. Looks like it's in the SSE handling in `src/transform.ts:245`. The `content_block_start` needs to fire before `ping` - that's documented in `STREAMING_PROTOCOL.md`.
