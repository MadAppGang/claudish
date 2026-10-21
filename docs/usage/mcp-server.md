# MCP Server Mode

**Use any claudish model as a tool inside Claude Code.**

Claudish isn't just a CLI. It's also an MCP server that exposes external AI models as tools.

Claude can call Grok, GPT-5, or Gemini mid-conversation to get a second opinion, or delegate a task to another model as a full async session that it polls and answers with `send_input`.

The server exposes **15 tools** across four groups: low-level (3), agentic (3), session (8), and debug (1).

### Requirements for `team` and sessions

Every `team` slot and every `create_session` session is a real, interactive Claude Code session
running your model, inside its own headless [magmux](magmux.md) pane. That needs:

- **magmux 0.18.0 or newer.** It is bundled with the npm package on macOS and Linux; otherwise
  install it with `brew install MadAppGang/tap/magmux`. Without it, `team(mode:"run")`,
  `create_session` and the CLI's `claudish team` / `--team` refuse with
  `Error: magmux_unavailable: …` instead of falling back to anything else.
- **macOS or Linux.** Windows is not supported for MCP `team`, `create_session`, or the CLI's
  `claudish team` / `--team`. The other tools work everywhere.
- At most 48 live panes per user, across every claudish process; past that a new run or session is
  refused with `Error: pane_limit: …`.

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

One quick prompt, straight to one model's API: a single request and its answer. No Claude Code
session, no tools, no conversation state, and files only as contents appended with `files` — this
is not subagent work. For a task that needs tools, files or more than one turn, use
`create_session` (one model) or `team` (several models). Non-Claude models (Kimi, GLM, Qwen, MiniMax, Gemini, GPT, Grok, …) go through claudish's
routing straight to the provider's API.

**Parameters:**
- `model` (required) - Model name or model spec. A bare name auto-routes to the best provider (e.g., `kimi-k3`, `glm-5.3`); `provider@model` pins the provider (e.g., `google@gemini-4-argon`, `or@x-ai/grok-4.7`).
- `prompt` (required) - The prompt to send
- `system_prompt` (optional) - System prompt for context
- `files` (optional) - Local file paths, resolved against the working directory, whose contents are appended to the prompt as labeled code blocks; a file that cannot be read becomes a one-line warning in its place

There is no output-limit parameter. The request carries no `max_tokens`, so the provider applies
its own default.

**Claude models.** A bare Claude name (`claude-*`, `opus`, `sonnet`, `haiku`, `internal`) does not
go to an API from the MCP server. It runs as one Claude Code print-mode call through claudish
(`claudish -p --model <model> --output-format json …`) on your own Claude Code login: tools, MCP
servers, settings sources and slash commands are off, Claude Code's default system prompt is
replaced by yours (or by an empty one), and it runs in a new empty working directory so no
project `CLAUDE.md` or memory is loaded. claudish never reads your Claude Code login itself; the
`claude` binary signs in on its own. The answer ends with an `Auth:` line,
`Auth: Claude Code login (subscription)` on a subscription. If you never signed in, the error is
Claude Code's own "Not logged in" text: run `claude` once. An explicit spec such as
`anthropic@claude-opus-5-5` is the metered Anthropic API and takes the ordinary routing path.

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

### `compare_models` (debug)

A debug tool, in the `debug` group. Send the same single prompt to several models, one after
another, and show their answers side by side — to check that routes answer or to eyeball raw
answers. Each model gets exactly what `run_prompt` sends: one request, no tools, no Claude Code
session (a Claude entry takes `run_prompt`'s Claude Code path). Not for real work: use `team` for
a blind-judged multi-model run, or `create_session` for one model doing a task.

**Parameters:**
- `models` (required) - Array of model names or model specs, in the order to run them
- `prompt` (required) - The prompt to compare
- `system_prompt` (optional) - System prompt
- `files` (optional) - As for `run_prompt`; every model receives the same appended contents, and the comparison header keeps the prompt as given

**Example:**
```
Check that kimi-k3, glm-5.3 and minimax-m3 all answer: "Say OK"
```

---

### `preflight`

Diagnostic: for a list of models, report which provider would serve each, whether that hop is
subscription or metered, and whether it is reachable now. It is not a step before `team`,
`create_session` or `run_prompt`; they resolve their own routing.

---

### `team`

Run AI models on a task with anonymized outputs and optional blind judging. Each slot is an
interactive Claude Code session in its own headless magmux pane (see "Requirements" above).

**Parameters:**
- `mode` (required) - One of: `run`, `status`, `list`, `capture`, `cancel`, `resize`, `judge`, `run-and-judge`
- `path` - Session directory path (must be within current working directory). Required by every mode except `list`
- `models` - Model IDs to run (required for `run` and `run-and-judge`). Native Claude names (`opus`, `sonnet`, `haiku`, `internal`) are runnable slots too
- `judges` - Model IDs to use as judges (default: same as runners)
- `input_file` - Path to a file holding the task prompt (preferred for anything longer than a sentence)
- `input` - Task prompt as inline text. If neither is given, an `input.md` already in the session directory is used
- `require_pattern` - Regex (no flags) each slot's answer must match, or the slot is EMPTY `shape_mismatch`. Recommended whenever your prompt mandates an output shape, e.g. ```` ```vote ````
- `min_output_bytes` - Report a slot EMPTY when its answer is shorter than this (default 0 = off)
- `agent` - Claude Code subagent every slot runs as (e.g. `dev:reviewer`); an unknown agent fails the slot `agent_rejected`
- `claude_flags` - Other Claude Code flags and their values, space-separated, never positional text (write `--allowedTools Read,Bash`; a value after a Claude Code switch, as in `--brief now`, would be the session's first prompt and is refused). Flags that would break the interactive pane (`-p`, `--output-format`, `--resume`, …) and print-mode-only flags (`--max-turns`, `--max-budget-usd`, …) are refused
- `slot` - For `capture` and `resize` (required) and `cancel` (omit to stop the whole run): the anonymised slot id
- `run_id` - For `status`, `capture`, `cancel` and `resize`: the `run_id` a `run` answer returned; addresses that run even after a newer run reused the path. Omit it for the newest run at `path`
- `since_seq`, `spans` - For `capture`: see `capture_session`
- `cols`, `rows` - For `resize` (required): see `resize_session`

**Modes:**
| Mode | What it does |
|------|-------------|
| `run` | Start the models and return once every slot has taken its prompt (at most about two minutes, usually seconds) — it does not wait for answers. Outputs are written anonymized to the session directory. The result carries `run_id` and `monitor_record`, the run's record under `~/.claudish/sessions/` (see "Session records on disk") |
| `status` | Progress of a run: per-slot rows under `run.slots` (state, reason, reason_detail, tokens, idle seconds, activity), plus `contract_version` and `capabilities` |
| `list` | Every run this server holds: `{contract_version, capabilities, runs}`. Finished runs stay listed for 30 minutes |
| `capture` | One slot's current terminal screen (same shape as `capture_session`) |
| `cancel` | Stop one slot (`slot`) or every slot of the run; answers each slot's `{state, changed}` |
| `resize` | Set one slot's terminal size; answers `{run_id, path, slot, cols, rows, changed, seq, pending?}` (same rules as `resize_session`) |
| `judge` | Blind-vote on existing outputs in the session directory |
| `run-and-judge` | Full pipeline: run models, then judge the outputs; holds the call open for the whole run |

No slot is ever stopped on a timer once its prompt is accepted. A slot inside a long build or test
suite can be silent for minutes and still be working; read `idle_seconds` and `activity`, and use
`cancel` if you decide a slot is stuck. A slot that stops on a question or a permission dialog it
cannot answer is FAILED `blocked`, with the question in its detail. A path holds at most one active
run.

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

## Sessions

`create_session` starts an external model session asynchronously. Each session is an interactive
Claude Code running your model in its own headless magmux pane (see "Requirements" above).
Nothing is pushed to you while it runs: poll `list_sessions`. When a session asks a question,
answer it with `send_input`. When it completes, `get_output` returns the full response.

The session tools are in the `session` group, which `all` (the default) includes:

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

`CLAUDISH_MCP_TOOLS` selects the tools the server lists:

| `CLAUDISH_MCP_TOOLS` | Tools |
|---|---|
| unset, `all` | all 15 |
| `low-level` | `run_prompt`, `list_models`, `search_models` |
| `agentic` | `preflight`, `team`, `report_error` |
| `session` | `create_session`, `send_input`, `get_output`, `cancel_session`, `list_sessions`, `get_diagnostics`, `capture_session`, `resize_session` |
| `debug` | `compare_models` |
| any other value | all 15, with a warning on stderr |

Inside a session that claudish itself started (a `create_session` or `team` pane), the server runs in nested mode. Whatever `CLAUDISH_MCP_TOOLS` says, it offers at most the four one-shot tools (`run_prompt`, `compare_models`, `list_models`, `search_models`) and no session tools. A model-running `claudish` launched from that session's shell (`-p`, interactive, `team run`) exits 64 with `nested session refused`. One level of nesting is the limit.

Any other value still selects all 15 tools, and the server writes one line to stderr naming the
value and the valid ones:

```
[claudish] CLAUDISH_MCP_TOOLS="agentc" is not a tool mode; selecting all tools. Valid values: all, low-level, agentic, session, debug
```

`channel` was the old name of the `session` group. It is no longer a group, so it selects all 15
tools, and the warning says it was renamed to `session`.

### Polling workflow

1. `create_session` returns `{session_id, state: "STARTING"}` at once while Claude Code boots.
2. Poll `list_sessions` (`include_completed: true`) about once every 10 seconds. Each row has
   `state`, `activity`, `idle_seconds` and accounting:
   - `STARTING`: booting, or the first prompt is not yet accepted.
   - `RUNNING`: a turn is in progress (`activity` names the tool in use).
   - `AWAITING_INPUT`: waiting for `send_input` — an interactive session between turns, or a turn
     stopped on a question (`activity` `AskUserQuestion`). A send declines a question and becomes
     the next prompt.
   - `AWAITING_PERMISSION`: a permission or plan-approval dialog is open (only when your
     `claude_flags` ask for one, e.g. `--permission-mode plan`). A send declines it and becomes
     the next prompt.
   - `COMPLETED`, `FAILED`, `TIMEOUT`, `CANCELLED`, `EMPTY`: finished.
3. `send_input` may be called at any time; it is queued until the session is idle.
4. `COMPLETED`: call `get_output` for the answer.
5. `FAILED` or `TIMEOUT` — or `COMPLETED` with an empty or surprising answer — call
   `get_diagnostics`. It returns the child's final screen, the upstream error bodies, the recent
   state records, the resolved model chain and the paths to the full records. It needs no re-run
   and no debug flag.
6. `capture_session` reads a session's current screen; `cancel_session` stops it. Nothing stops a
   session for being idle: a child inside a long build is silent and working.

One-shot — a `prompt` is given, so the session ends on its own after its answer:

```
1. create_session(model: "google@gemini-2.0-flash", prompt: "Refactor this module")
   → { session_id: "1a2b3c4d", state: "STARTING" }

2. list_sessions(include_completed: true)   every ~10 s
   → state RUNNING, activity "Read" … then state COMPLETED

3. get_output(session_id: "1a2b3c4d")
   → { output: "...", state: "COMPLETED", turnsCompleted: 1, ... }
```

Interactive — no `prompt`, so the session waits for input once Claude Code has booted and after
every turn, until you cancel it or it times out:

```
1. create_session(model: "google@gemini-2.0-flash")
   → { session_id: "5e6f7a8b", state: "STARTING" }

2. list_sessions → state AWAITING_INPUT

3. send_input(session_id: "5e6f7a8b", text: "Refactor this module")
   → { success: true, queued: 0 }

4. list_sessions → RUNNING … then AWAITING_INPUT again

5. get_output(session_id: "5e6f7a8b"), then send_input again or cancel_session
```

### `create_session`

Start an async session on any model: an interactive Claude Code running the model in its own
headless magmux pane. With a `prompt` it is one-shot and ends when that turn settles; without one it
is interactive and waits for `send_input`.

**Parameters:**
- `model` (required) - Model identifier (e.g., `google@gemini-2.0-flash`, `x-ai/grok-code-fast-1`)
- `prompt` (optional) - Initial prompt. If omitted, send later via `send_input`.
- `timeout_seconds` (optional) - Session timeout in whole seconds, 1-3600 (default: 600). A fractional value is rounded and an out-of-range one clamped, so `spawn.json` always carries an integer in that range
- `agent` (optional) - Claude Code subagent the session runs as, e.g. `dev:reviewer`
- `claude_flags` (optional) - Other Claude Code / claudish flags and their values, space-separated, never positional text (write `--allowedTools Read,Bash`; a value after a Claude Code switch, as in `--brief now`, would be the session's first prompt and is refused). Flags the pane owns (`-p`, `--resume`, `--model`, …) and print-mode-only flags (`--max-turns`, `--max-budget-usd`, …) are refused
- `work_dir` (optional) - Working directory for the session (default: current directory)

**Returns:** `{ session_id: "...", state: "STARTING" }` as soon as the pane exists; Claude Code then boots in it.

---

### `send_input`

Send a prompt to a session. Accepted in every state that has not ended, and queued until the
session is idle: during `STARTING` and `RUNNING` it waits its turn; in `AWAITING_INPUT` it is
delivered at once; during a question or a permission dialog the dialog is declined and the text
becomes the next prompt. Any accepted send makes a one-shot session interactive. `/clear` and
`/resume` are not accepted.

**Parameters:**
- `session_id` (required) - Session ID from `create_session`
- `text` (required) - Text to send

**Returns:** `{ success: true, queued: <n> }`, or `{ success: false, reason, state }` with `reason` one of `terminal`, `delivery_unavailable`, `unsupported_command`, `unknown_session`.

---

### `get_output`

Retrieve a session's answer prose: each settled turn's assistant text, read from Claude Code's
own transcript. Call once `list_sessions` shows the session `COMPLETED` (or between turns of an
interactive session).

**Parameters:**
- `session_id` (required) - Session ID from `create_session`
- `tail_lines` (optional) - Number of lines from the end (default: all)

**Returns:** `{ sessionId, state, output, totalLines, turnsCompleted, tokensIn, tokensOut, elapsedSeconds, idleSeconds }`.

---

### `cancel_session`

Cancel a session. It is `CANCELLED` when the call returns; closing the pane and stopping its
processes finish in the background. Calling it again changes nothing.

**Parameters:**
- `session_id` (required) - Session ID to cancel

**Returns:** `{ session_id, state, changed }`. An unknown session is a JSON error `{error: {code: "unknown_session", message}}`.

---

### `list_sessions`

List the sessions this server holds.

**Parameters:**
- `include_completed` (optional) - Include completed, failed, and cancelled sessions (default: false)

**Returns:** `{ contract_version: 1, capabilities: [...], sessions: [...] }`. Each row has `session_id`,
`model`, `provider`, `state`, `reason`, `reason_detail`, `tokens_in`, `tokens_out`, `cost_usd` (null
for native Claude models), `tool_calls`, `turns_completed`, `last_activity_at`, `idle_seconds`, `activity`, `started_at`,
`completed_at` and `elapsed_seconds`. `reason_detail` is one line (at most 160 characters) saying
why a failed session failed — for `api_error`, the provider's own error message (`no-such-model-zz9
is not a valid model ID`) — and null while the session is live, on COMPLETED, and when nothing
readable exists. Team status rows carry the same field. Nothing stops a session for being idle; `idle_seconds` is for
you to judge.

---

### `get_diagnostics`

Explain what a session actually did. Call it first whenever a session fails, times out, or
completes with empty or surprising output — it needs no re-run and no debug flag. Returns the
session's final screen, the upstream error bodies, the recent state records, anomalies, the
resolved model chain, accounting, and the paths to the full records (the transcript included).
For a prompt that was not accepted, `gate` is magmux's current input-gate reading (`ready`,
`reason`, `detail`) and `lastSend` is magmux's answer to claudish's last gated send (`kind`,
`reason`, `accept`, `evidence`, `retypeCause`, `attempts`).

**Parameters:**
- `session_id` (required) - Session ID from `create_session`
- `event_limit` (optional) - How many recent state records to include (default 40, max 200)

---

### `capture_session`

Read a session's current terminal screen at its current size (160×50 unless someone resized it
with `resize_session`): what you would see if you were looking at its pane. It is a memory read, cheap enough to poll about once a second.

**Parameters:**
- `session_id` (required) - Session ID from `create_session`
- `since_seq` (optional) - The `seq` of your previous capture; when nothing changed the answer is `{unchanged: true, seq, final}`
- `spans` (optional) - Also return each row's colour and attribute runs

**Returns:** `{ seq, cols, rows, cursor, lines, final, spans? }`. `seq` grows by one for every visible
change; `final: true` is the last screen of a closed pane. `team(mode:"capture", path, slot)` returns
the same shape for a team slot.

---

### `resize_session`

Set a session's terminal size. The child gets a real resize signal and Claude Code redraws at the
new width; the next `capture_session` reports the new `cols`/`rows` under a new `seq`. Allowed in
every state, mid-turn included. When several callers resize the same session, the last one wins.

Works with every magmux sessions accept (0.18.0 or newer). Resizing itself needs 0.15.1: 0.15.0
added the resize op, but a pane that grew taller kept its old scroll region, which garbled Claude
Code's input box and stopped its turns from ending. `list_sessions` and
`team` list `resize` in `capabilities`. If magmux lacks the `resize` verb, the call answers
`resize_unsupported`.

**Parameters:**
- `session_id` (required) - Session ID from `create_session`
- `cols` (required) - Columns, an integer; clamped to 40–9999
- `rows` (required) - Rows, an integer; clamped to 24–9999, then lowered so that `cols × rows` is at
  most 4 000 000 (magmux's own limits; 9999 columns leave 400 rows)

**Returns:** `{ session_id, cols, rows, changed, seq, pending? }`. `cols`/`rows` are the size actually
set, after clamping. `changed: false` means the session already had that size, or has ended (it then
answers its final size). `seq` is the screen's sequence after the redraw, so a capture with that
`since_seq` sees the new size. `pending: true` means the pane is still starting or briefly
disconnected: the size is stored and applied as soon as it can be. Errors are JSON
`{error: {code, message}}` with `unknown_session`, `invalid_args` (missing or non-integer
`cols`/`rows`), `resize_unsupported`, or `delivery_unavailable` (magmux refused or the pane is
unreachable; the message carries magmux's reason). `team(mode:"resize", path, slot, cols, rows)` does
the same for a team slot.

---

### Session records on disk

Every `create_session` session keeps its record under `~/.claudish/sessions/<session_id>/`
(`CLAUDISH_SESSIONS_DIR` overrides the root). Tools that watch sessions from outside the MCP
server read these files; they are a stable contract.

| File | Written | Contents |
|------|---------|----------|
| `spawn.json` | once, before the session's pane starts; atomic | `schema`, `kind: "session"`, `sessionId`, `hostPid` (the Claude Code process running this MCP server), `mcpPid`, `startedAt`, `model`, `timeoutSeconds`, `claudeSessionId`; `launcherPid` when claudish runs through the npm launcher; `parentClaudeSessionId`, the Claude Code conversation live in the calling window when the call ran (read from Claude Code's session record for `hostPid`, else from `CLAUDE_CODE_SESSION_ID`; absent when neither has an id) |
| `waits.jsonl` | one line each time the session starts and stops waiting for `send_input` | `{"wait":"open","since":…,"turns":…}` then `{"wait":"closed","since":…,"at":…,"to":…}`. Written by interactive sessions, and by any session stopped on a question or permission dialog; append-only, so a wait that opened and closed between two reads still shows. Stops at 1 MB |
| `meta.json` | once, when the session ends, before its pane is closed | the final record: `status`, `terminalReason`, `exitCode`, `turnsCompleted`, `toolCallCount`, `costUsd` (null for native Claude models), plus `state`, `detail`, `tokensIn`, `tokensOut`, and `parentClaudeSessionId` exactly when `spawn.json` has it |
| `events.jsonl` | while the session runs | claudish's own records: state changes, tools, anomalies, and one `{"type":"assistant","message":{"id":…}}` line per model reply. Capped at 4 MB |
| `output.log`, `screen.txt` | while it runs / when it ends | the answer prose; the pane's final screen |

A `team(mode:"run")` gets a record in the same directory, `team-<8 hex>/`, named by the
`monitor_record` key of the `run` result. Its `spawn.json` has `kind: "team"`, `teamPath` and
`slots` in place of the session fields; its `meta.json`, written atomically once the run
settles (or fails to start), is `{"kind":"team","status":…,"startedAt":…,"completedAt":…,"elapsedSeconds":…,"slots":…,"ok":…,"failed":…,"cancelled":…}`,
plus `"reason":"start-failed"` when no run started. Session tools such as `get_output`
answer a `team-*` id as unknown; use `team(mode:"status")` for the run itself.

---

## Error Reporting

When a tool call fails (provider errors, model not found, timeouts), the error response includes a hint to use the `report_error` tool. This applies to:

- `run_prompt` — single model failures
- `compare_models` — per-model failures in comparison
- `team` — model failures during team runs
- `create_session` — session spawn failures
- Sessions that end `FAILED` — call `get_diagnostics`, then report

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
Have Grok, GPT-5, and Gemini each review this architecture decision, then judge blind
→ team(mode: "run-and-judge", ...)
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
│  polls      │  list_sessions,       │  Sessions   │  headless magmux pane, one per session
│  sessions   │  get_output (answers) │  Manager    │ ──────────► claudish -i → Claude Code
│             │ ◄──────────────────► │             │               (interactive)
└─────────────┘                       └─────────────┘
```

**`run_prompt` flow:**
1. Claude Code sends tool call via MCP (stdio)
2. Claudish MCP server receives it
3. A non-Claude model: the server calls it through the proxy engine. A bare Claude name: the server
   runs one `claudish -p` on your Claude Code login
4. Response returned to Claude Code

**Session flow:**
1. Claude Code calls `create_session`
2. Claudish starts a headless magmux pane running an interactive Claude Code on your model
3. The session manager follows Claude Code's own transcript and screen and writes the session's
   state and records
4. Claude Code polls `list_sessions` for the state
5. On completion, Claude Code calls `get_output`

The pane is closed when the session ends, and nothing it started outlives the MCP server: if the
server exits — even if it is killed — a small watcher process per pane stops the pane and removes
its files.

---

## CLI vs MCP: when to use which

| Use Case | Mode | Why |
|----------|------|-----|
| Full alternative session | CLI | Replace Claude entirely |
| Get second opinion | MCP | Quick tool call mid-conversation |
| Batch automation | CLI | Scripts and pipelines |
| Model comparison | MCP | `team` runs several models on one task |
| Interactive coding | CLI | Full Claude Code experience |
| Specialized subtask | MCP | Delegate to expert model |
| Blind judging | MCP | `team` tool with anonymized outputs |
| Long async task | MCP | `create_session`, polled with `list_sessions` |

---

## Debugging

**Check if MCP server starts:**
```bash
OPENROUTER_API_KEY=sk-or-v1-... claudish --mcp
# Should output: [claudish] MCP server started (tools: all, 15 tools)
```

**Test the tools:**
Use Claude Code and ask it to list available MCP tools. You should see all 15: `run_prompt`, `list_models`, `search_models`, `compare_models`, `preflight`, `team`, `report_error`, `create_session`, `send_input`, `get_output`, `cancel_session`, `list_sessions`, `get_diagnostics`, `capture_session`, and `resize_session`.

**Check which tool group is active:**
```bash
CLAUDISH_MCP_TOOLS=session OPENROUTER_API_KEY=sk-or-v1-... claudish --mcp
# [claudish] MCP server started (tools: session, 8 tools)
```

**Write the debug log** (`logs/` in the server's working directory; standard output stays
JSON-RPC only):
```bash
claudish --mcp --debug-claudish      # or -d, or CLAUDISH_DEBUG=1
```

**Check magmux** (needed by `team` and sessions):
```bash
magmux --version   # 0.18.0 or newer
```

---

## Limitations

**Streaming:** MCP tools don't stream. You get the full response when complete.

**Context:** The MCP tool doesn't share Claude Code's context. Pass relevant info in the prompt.

**Rate limits:** OpenRouter has rate limits. Heavy parallel usage might hit them.

**Platforms:** `team` and sessions need magmux 0.18.0+ and run on macOS and Linux only; Windows is not supported for them.

---

## Next

- **[CLI Interactive Mode](interactive-mode.md)** - Full session replacement
- **[Model Selection](../models/choosing-models.md)** - Pick the right model
