# MCP Server Mode

**Use any claudish model as a tool inside Claude Code.**

Claudish isn't just a CLI. It's also an MCP server that exposes external AI models as tools.

Claude can call Grok, GPT-5, or Gemini mid-conversation to get a second opinion, run a comparison, or delegate specialized tasks. With channel mode, it can also spawn full async sessions — complete with push notifications and interactive input.

The server exposes **11 tools** across three groups: low-level (4), agentic (2), and channel (5).

---

## Quick Setup

**1. Add to your Claude Code MCP settings:**

```json
{
  "mcpServers": {
    "claudish": {
      "command": "claudish",
      "args": ["--mcp"],
      "env": {
        "OPENROUTER_API_KEY": "sk-or-v1-your-key-here"
      }
    }
  }
}
```

**2. Restart Claude Code**

**3. Use it:**
```
Ask Grok to review this function
```

Claude will use the `run_prompt` tool to call Grok.

---

## Available Tools

### `run_prompt`

Run a prompt through any model. Supports all providers (Kimi, GLM, Qwen, MiniMax, Gemini, GPT, Grok, etc.) with auto-routing, fallback chains, and custom routing rules.

**Parameters:**
- `model` (required) - Model name or ID. Short names auto-route to the best provider (e.g., `kimi-k2.5`, `glm-5`). Provider prefix optional (e.g., `google@gemini-3.1-pro-preview`, `or@x-ai/grok-3`).
- `prompt` (required) - The prompt to send
- `system_prompt` (optional) - System prompt for context
- `max_tokens` (optional) - Max response length (default: 4096)

**Model IDs:**
| Common Name | Model ID |
|-------------|----------|
| Grok | `x-ai/grok-code-fast-1` |
| GPT-5 Codex | `openai/gpt-5.1-codex` |
| Gemini 3 Pro | `google/gemini-3-pro-preview` |
| MiniMax M2 | `minimax/minimax-m2` |
| GLM 4.6 | `z-ai/glm-4.6` |
| Qwen3 VL | `qwen/qwen3-vl-235b-a22b-instruct` |

**Example usage:**
```
Ask Grok to review this function
→ run_prompt(model: "x-ai/grok-code-fast-1", prompt: "Review this function...")

Use GPT-5 Codex to explain the error
→ run_prompt(model: "openai/gpt-5.1-codex", prompt: "Explain this error...")
```

**Tip:** Use `list_models` first to see all available models with pricing.

---

### `list_models`

List recommended models with pricing and capabilities.

**Parameters:** None

**Returns:** Table of curated models with:
- Model ID
- Provider
- Pricing (per 1M tokens)
- Context window
- Capabilities (Tools, Reasoning, Vision)

---

### `search_models`

Search all OpenRouter models.

**Parameters:**
- `query` (required) - Search term (name, provider, capability)
- `limit` (optional) - Max results (default: 10)

**Example:**
```
Search for models with "vision" capability
```

---

### `compare_models`

Run the same prompt through multiple models and compare.

**Parameters:**
- `models` (required) - Array of model IDs
- `prompt` (required) - The prompt to compare
- `system_prompt` (optional) - System prompt
- `max_tokens` (optional) - Max response length

**Example:**
```
Compare responses from Grok, GPT-5, and Gemini for: "Explain this regex"
```

---

### `team`

Run AI models on a task with anonymized outputs and optional blind judging.

**Parameters:**
- `mode` (required) - One of: `run`, `judge`, `run-and-judge`, `status`
- `path` (required) - Session directory path (must be within current working directory)
- `models` (optional) - Model IDs to run (required for `run` and `run-and-judge` modes)
- `judges` (optional) - Model IDs to use as judges (default: same as runners)
- `input` (optional) - Task prompt text. Alternatively, place `input.md` in the session directory before calling.
- `timeout` (optional) - Per-model timeout in seconds (default: 300)

**Modes:**
| Mode | What it does |
|------|-------------|
| `run` | Start the models on the task and return at once; outputs are written anonymized to the session directory. The result's `monitor_record` names the run's record under `~/.claudish/sessions/` (see "Session records on disk") |
| `judge` | Blind-vote on existing outputs in the session directory |
| `run-and-judge` | Full pipeline: run models, then judge the outputs |
| `status` | Check progress of a running or completed session |

**Example:**
```
Use team run-and-judge with Grok and GPT-5 on this architecture decision
→ team(mode: "run-and-judge", path: "./team-session", models: ["x-ai/grok-3", "openai/gpt-5.1-codex"], input: "Which approach is better: A or B?")
```

---

### `report_error`

Report a claudish error to developers. Always ask the user for consent before calling. All data is sanitized: API keys, user paths, and emails are stripped before sending.

**Parameters:**
- `error_type` (required) - One of: `provider_failure`, `team_failure`, `stream_error`, `adapter_error`, `other`
- `model` (optional) - Model ID that failed
- `command` (optional) - Command that was run
- `stderr_snippet` (optional) - First 500 chars of stderr output
- `exit_code` (optional) - Process exit code
- `error_log_path` (optional) - Path to full error log file
- `session_path` (optional) - Path to team session directory
- `additional_context` (optional) - Extra context about the error
- `auto_send` (optional) - If true, suggest the user enable automatic error reporting

---

## Channel Mode

Channel mode lets Claude Code spawn external model sessions asynchronously and receive push notifications as they run.

Sessions are long-running claudish processes. Claude Code gets notified at each state change via `<channel>` tags — no polling needed. When a session asks a question, Claude answers it via `send_input`. When it completes, `get_output` retrieves the full response.

**Enable channel tools:**

```json
{
  "mcpServers": {
    "claudish": {
      "command": "claudish",
      "args": ["--mcp"],
      "env": {
        "OPENROUTER_API_KEY": "sk-or-v1-...",
        "CLAUDISH_MCP_TOOLS": "all"
      }
    }
  }
}
```

`CLAUDISH_MCP_TOOLS` accepts: `all` (default), `channel`, `agentic`, or `low-level`. Channel tools are included in `all` by default.

### Channel events

When a session runs, Claude Code receives `<channel source="claudish">` notifications with these event types:

| Event | Meaning |
|-------|---------|
| `session_started` | Session began. Note the `session_id` for future calls. |
| `tool_executing` | Model is using a tool (Read, Write, Bash, etc.). |
| `input_required` | The session finished a turn and waits for `send_input`. Only interactive sessions do this: created without a `prompt`, or after a `send_input`. |
| `finishing` | The session's last turn ended and claudish closed its input; it is exiting. Nothing to do — `completed` follows. |
| `completed` | Session finished. Call `get_output` for the full response. |
| `failed` | Session exited with an error. Check the notification content for details. |
| `cancelled` | Session was cancelled via `cancel_session`. |

### Workflow example

One-shot — a `prompt` is given, so the session ends on its own after its answer:

```
1. create_session(model: "google@gemini-2.0-flash", prompt: "Refactor this module")
   → { session_id: "sess_abc123", status: "starting" }

2. <channel event="session_started" session_id="sess_abc123" ...>
   <channel event="tool_executing" tool_count="3" ...>

3. <channel event="finishing" session_id="sess_abc123">

4. <channel event="completed" session_id="sess_abc123">

5. get_output(session_id: "sess_abc123")
   → { lines: [...], status: "completed" }
```

Interactive — no `prompt`, so the session waits for input from the start and after every
turn, until you cancel it or it times out:

```
1. create_session(model: "google@gemini-2.0-flash")
   → { session_id: "sess_def456", status: "starting" }

2. <channel event="input_required" session_id="sess_def456">

3. send_input(session_id: "sess_def456", text: "Refactor this module")

4. <channel event="tool_executing" ...>
   <channel event="input_required" session_id="sess_def456">

5. get_output(session_id: "sess_def456"), then send_input again or cancel_session
```

### `create_session`

Spawn an async external model session.

**Parameters:**
- `model` (required) - Model identifier (e.g., `google@gemini-2.0-flash`, `x-ai/grok-code-fast-1`)
- `prompt` (optional) - Initial prompt. If omitted, send later via `send_input`.
- `timeout_seconds` (optional) - Session timeout (default: 600, max: 3600)
- `claude_flags` (optional) - Extra flags to pass to claudish (space-separated)
- `work_dir` (optional) - Working directory for the session (default: current directory)

**Returns:** `{ session_id: "...", status: "starting" }`

---

### `send_input`

Send text to a session's stdin. Use when the session is in `waiting_for_input` state (after an `input_required` channel event). A session in `finishing` has already closed its input and refuses it.

**Parameters:**
- `session_id` (required) - Session ID from `create_session`
- `text` (required) - Text to send

**Returns:** `{ success: true }`

---

### `get_output`

Retrieve output from a session's scrollback buffer. Call after the `completed` channel event.

**Parameters:**
- `session_id` (required) - Session ID from `create_session`
- `tail_lines` (optional) - Number of lines from the end (default: all)

---

### `cancel_session`

Cancel a running session. Sends SIGTERM, then SIGKILL after 5 seconds if still running.

**Parameters:**
- `session_id` (required) - Session ID to cancel

**Returns:** `{ success: true }`

---

### `list_sessions`

List all active channel sessions.

**Parameters:**
- `include_completed` (optional) - Include completed, failed, and cancelled sessions (default: false)

**Returns:** Array of session objects with ID, model, status, and elapsed time.

---

### Session records on disk

Every `create_session` session keeps its record under `~/.claudish/sessions/<session_id>/`
(`CLAUDISH_SESSIONS_DIR` overrides the root). Tools that watch sessions from outside the MCP
server — such as the magus `claudish` plugin's monitor — read these files; they are a stable
contract.

| File | Written | Contents |
|------|---------|----------|
| `spawn.json` | once, before the session's process starts; atomic | `schema`, `kind: "session"`, `sessionId`, `hostPid` (the Claude Code process running this MCP server), `mcpPid`, `startedAt`, `model`, `timeoutSeconds`, `claudeSessionId`; `launcherPid` when claudish runs through the npm launcher; `parentClaudeSessionId` only when claudish proved which Claude Code conversation made the call |
| `waits.jsonl` | one line each time the session starts and stops waiting for `send_input` | `{"wait":"open","since":…,"turns":…}` then `{"wait":"closed","since":…,"at":…,"to":…}`. Interactive sessions only; append-only, so a wait that opened and closed between two reads still shows. Stops at 1 MB |
| `meta.json` | once, when the session ends | the final `SessionInfo`: status, exit code, turns, tokens, cost, and `parentClaudeSessionId` exactly when `spawn.json` has it |

A `team(mode:"run")` gets a record in the same directory, `team-<8 hex>/`, named by the
`monitor_record` key of the `run` result. Its `spawn.json` has `kind: "team"`, `teamPath` and
`slots` in place of the session fields; its `meta.json`, written atomically once the run
settles (or fails to start), is `{"kind":"team","status":…,"startedAt":…,"completedAt":…,"elapsedSeconds":…,"slots":…,"ok":…,"failed":…,"cancelled":…}`,
plus `"reason":"start-failed"` when no run started. Session tools such as `get_session`
answer a `team-*` id as unknown; use `team(mode:"status")` for the run itself.

---

## Error Reporting

When a tool call fails (provider errors, model not found, timeouts), the error response includes a hint to use the `report_error` tool. This applies to:

- `run_prompt` — single model failures
- `compare_models` — per-model failures in comparison
- `team` — model failures during team runs
- `create_session` — session spawn failures
- Channel `failed` events — session runtime failures

### For plugin authors

If your plugin uses claudish MCP tools, handle error reporting by:

1. **Check for `isError: true`** in the tool response — this indicates a failure
2. **Look for the `report_error` hint** in the error text — it tells you the error_type and model
3. **Ask user consent** before calling `report_error` — the tool description requires this
4. **Pass the error context** — include `stderr_snippet`, `model`, and `error_type`

Example flow in a command:
```
1. Call run_prompt(model="grok", prompt="...")
2. Response has isError: true
3. Show error to user
4. Ask: "Would you like to report this error to claudish developers?"
5. If yes: call report_error(error_type="provider_failure", model="grok", stderr_snippet="...")
```

### Automatic reporting

Users can enable automatic error reporting via:
- `claudish config` → Privacy → toggle Telemetry
- `CLAUDISH_TELEMETRY=1` environment variable

When enabled, errors are sent automatically without asking. All data is sanitized before sending.

---

## Use Cases

### Get a second opinion

```
Claude, use GPT-5 Codex to review the error handling in this function
```

### Specialized tasks

```
Use Gemini 3 Pro (it has 1M context) to analyze this entire codebase
```

### Multi-model validation

```
Compare what Grok, GPT-5, and Gemini think about this architecture decision
```

### Budget optimization

```
Use MiniMax M2 to generate basic boilerplate for these interfaces
```

### Blind judging with `team`

```
Run Grok and Kimi on this refactoring task, then have GLM judge the results
→ team(mode: "run-and-judge", path: "./session", models: ["x-ai/grok-3", "moonshot/kimi-k2.5"], judges: ["z-ai/glm-5"])
```

---

## Configuration

### Environment variables

The MCP server reads `OPENROUTER_API_KEY` from environment.

**In Claude Code settings:**
```json
{
  "mcpServers": {
    "claudish": {
      "command": "claudish-mcp",
      "env": {
        "OPENROUTER_API_KEY": "sk-or-v1-...",
        "CLAUDISH_MCP_TOOLS": "all"
      }
    }
  }
}
```

**Or export globally:**
```bash
export OPENROUTER_API_KEY='sk-or-v1-...'
```

### Using npx (no install)

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

---

## How it works

```
┌─────────────┐     MCP Protocol      ┌─────────────┐     HTTP      ┌─────────────┐
│ Claude Code │ ◄──────────────────► │   Claudish  │ ◄───────────► │ OpenRouter  │
│             │     (stdio)           │  MCP Server │               │    API      │
│             │                       │             │               └─────────────┘
│  Receives   │  channel notifications│  Sessions   │     spawn
│  <channel>  │ ◄─────────────────── │  Manager    │ ──────────► claudish child
│  tags       │                       │             │               processes
└─────────────┘                       └─────────────┘
```

**Standard tool call flow (low-level tools):**
1. Claude Code sends tool call via MCP (stdio)
2. Claudish MCP server receives it
3. Server calls the target model via the proxy engine
4. Response returned to Claude Code

**Channel session flow:**
1. Claude Code calls `create_session`
2. Claudish spawns a child claudish process
3. Session manager monitors the process and fires channel notifications
4. Claude Code receives `<channel>` tags at each state change
5. On completion, Claude Code calls `get_output`

---

## CLI vs MCP: when to use which

| Use Case | Mode | Why |
|----------|------|-----|
| Full alternative session | CLI | Replace Claude entirely |
| Get second opinion | MCP | Quick tool call mid-conversation |
| Batch automation | CLI | Scripts and pipelines |
| Model comparison | MCP | Easy multi-model comparison |
| Interactive coding | CLI | Full Claude Code experience |
| Specialized subtask | MCP | Delegate to expert model |
| Blind judging | MCP | `team` tool with anonymized outputs |
| Long async task | MCP | Channel session with notifications |

---

## Debugging

**Check if MCP server starts:**
```bash
OPENROUTER_API_KEY=sk-or-v1-... claudish --mcp
# Should output: [claudish] MCP server started (tools: all, 11 tools)
```

**Test the tools:**
Use Claude Code and ask it to list available MCP tools. You should see all 11: `run_prompt`, `list_models`, `search_models`, `compare_models`, `team`, `report_error`, `create_session`, `send_input`, `get_output`, `cancel_session`, and `list_sessions`.

**Check which tool group is active:**
```bash
CLAUDISH_MCP_TOOLS=channel OPENROUTER_API_KEY=sk-or-v1-... claudish --mcp
# [claudish] MCP server started (tools: channel, 5 tools)
```

---

## Limitations

**Streaming:** MCP tools don't stream. You get the full response when complete.

**Context:** The MCP tool doesn't share Claude Code's context. Pass relevant info in the prompt.

**Rate limits:** OpenRouter has rate limits. Heavy parallel usage might hit them.

**Channel notifications:** Channel mode requires Claude Code to support the `claude/channel` experimental MCP capability.

---

## Next

- **[CLI Interactive Mode](interactive-mode.md)** - Full session replacement
- **[Model Selection](../models/choosing-models.md)** - Pick the right model
