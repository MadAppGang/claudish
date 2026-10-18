# Claudish Settings Reference

**Session**: dev-research-claudish-settings-20260316-012741-6e25c3bb
**Date**: 2026-03-16
**Status**: COMPLETE
**Sources**: Live codebase investigation (cli.ts, config.ts, model-parser.ts, provider-resolver.ts, auto-route.ts, remote-provider-registry.ts, profile-config.ts, routing-rules.ts, local.ts, gemini-oauth.ts, vertex-auth.ts, local-queue.ts)

---

## Executive Summary

Claudish is a proxy tool that wraps Claude Code with support for non-Anthropic AI providers. It intercepts Claude Code's API calls and reroutes them to providers like OpenRouter, Google Gemini, OpenAI, MiniMax, Kimi, GLM, and local models (Ollama, LM Studio, vLLM, MLX). Configuration is layered: CLI flags override environment variables, which override profile settings from config files. The routing syntax uses `provider@model[:concurrency]` (v4.0+, preferred) or the legacy `prefix/model` format (still supported, deprecated). Auto-routing selects a provider automatically based on available credentials. The priority chain is configurable via `defaultProvider` (v7.0.0+). The default chain (when no `defaultProvider` is set and only `OPENROUTER_API_KEY` is present) is: OpenCode Zen → provider subscription plan → native API → OpenRouter fallback. LiteLLM is never promoted into that chain automatically — it must be named through `defaultProvider` (see §6.3). Configuration files live at `~/.claudish/config.json` (global) and `.claudish.json` (local/project); local always takes precedence.

---

## 1. CLI Flags and Options

All flags recognized by `parseArgs()` in `packages/cli/src/cli.ts`.

| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--model` | `-m` | string | none (prompts interactively) | Model to use. Accepts `provider@model` syntax, legacy `prefix/model`, or bare model name for auto-detection |
| `--default-provider` | | string | none | Default provider for auto-routing (v7.0.0+). Overrides env var and config file. Valid: built-in provider names or custom endpoint names |
| `--model-opus` | | string | none | Model for Opus role (planning, complex tasks) |
| `--model-sonnet` | | string | none | Model for Sonnet role (default coding) |
| `--model-haiku` | | string | none | Model for Haiku role (fast tasks, background) |
| `--model-fable` | | string | none | Model for Fable role (version-independent family mapping) |
| `--model-subagent` | | string | none | Model for sub-agents (Task tool) |
| `--model-freshness` | | action | | Check configured Fable/Astra pins via catalog metadata; no inference or mutation |
| `--port` | | number | random (3000–9000) | Proxy server port |
| `--auto-approve` | `-y` | boolean | false | Skip permission prompts (passes `--dangerously-skip-permissions` to Claude Code) |
| `--no-auto-approve` | | boolean | | Explicitly enable permission prompts (overrides -y) |
| `--dangerous` | | boolean | false | Pass `--dangerouslyDisableSandbox` to Claude Code |
| `--interactive` | `-i` | boolean | auto | Interactive mode (default when no prompt argument given) |
| `--debug` | `-d` | boolean | false | Enable debug logging to `logs/claudish_*.log`; also sets `--log-level debug` unless overridden |
| `--log-level` | | string | `"info"` | Log verbosity: `debug` (full content), `info` (truncated content), `minimal` (labels only) |
| `--quiet` | `-q` | boolean | auto | Suppress `[claudish]` log messages (default in single-shot mode) |
| `--verbose` | `-v` | boolean | auto | Show `[claudish]` messages (default in interactive mode) |
| `--json` | | boolean | false | Output JSON format for tool integration; implies `--quiet` |
| `--monitor` | | boolean | false | Proxy to real Anthropic API and log all traffic (uses Claude Code's native auth) |
| `--stdin` | | boolean | false | Read prompt from stdin instead of positional arguments |
| `--free` | | boolean | false | Show only free models in interactive model selector |
| `--profile` | `-p` | string | default profile | Named profile for model mapping |
| `--cost-tracker` | | boolean | false | Enable cost tracking; also enables monitor mode |
| `--audit-costs` | | action | | Show cost analysis report and exit |
| `--reset-costs` | | action | | Reset accumulated cost statistics and exit |
| `--models` / `--list-models` | `-s` / `--search` | action | | List ALL models (from OpenRouter + LiteLLM + local Ollama) or fuzzy-search by query |
| `--top-models` | | action | | List curated recommended models and exit |
| `--force-update` | | boolean | false | Force refresh of model catalog cache (used with `--models` or `--top-models`) |
| `--summarize-tools` | | boolean | false | Summarize tool descriptions to reduce prompt size for local/small models |
| `--version` | | action | | Show version and exit |
| `--help` | `-h` | action | | Show help message and exit |
| `--help-ai` | | action | | Show AI agent usage guide (from `AI_AGENT_GUIDE.md`) and exit |
| `--init` | | action | | Install Claudish skill in `.claude/skills/claudish-usage/SKILL.md` |
| `--mcp` | | action | | Run as MCP server |
| `--gemini-login` | | action | | Login to Gemini Code Assist via OAuth |
| `--gemini-logout` | | action | | Clear Gemini OAuth credentials |
| `--kimi-login` | | action | | Login to Kimi/Moonshot AI via OAuth |
| `--kimi-logout` | | action | | Clear Kimi OAuth credentials |
| `--` | | separator | | Everything after `--` passes directly to Claude Code without processing |

**Passthrough behavior**: Any unrecognized flag is automatically forwarded to Claude Code. If the token immediately following the flag does not start with `-`, it is consumed as that flag's value. Examples: `--agent detective`, `--effort high`, `--permission-mode plan`.

**Positional arguments**: Tokens without a leading `-` are treated as the prompt text and forwarded to Claude Code.

**Interactive mode detection**: If no positional arguments are given and `--stdin` is not set, Claudish automatically enters interactive mode (as if `--interactive` was specified).

**`--json` implies `--quiet`**: When `--json` is set, `config.quiet` is forced to `true` regardless of other flags.

**`--cost-tracker` enables monitor mode**: Setting `--cost-tracker` automatically sets `config.monitor = true` if it is not already set.

---

## 2. Subcommands

These are top-level subcommands recognized before flag parsing begins (checked in `packages/cli/src/index.ts`).

| Command | Description |
|---------|-------------|
| `claudish init [--local\|--global]` | Setup wizard: creates config file and first profile interactively |
| `claudish profile list [--local\|--global]` | List all profiles from one or both scopes |
| `claudish profile add [--local\|--global]` | Add a new profile interactively |
| `claudish profile remove <name> [--local\|--global]` | Remove a named profile |
| `claudish profile use <name> [--local\|--global]` | Set the default profile |
| `claudish profile show [name] [--local\|--global]` | Show profile details (models, timestamps) |
| `claudish profile edit [name] [--local\|--global]` | Edit a profile interactively |
| `claudish update` | Check for updates and install the latest version (detects npm, bun, brew) |
| `claudish telemetry on` | Enable telemetry (opt-in) |
| `claudish telemetry off` | Disable telemetry |
| `claudish telemetry status` | Show current telemetry consent and configuration |
| `claudish telemetry reset` | Reset telemetry consent to unasked state |

**Scope flags for profile commands**:
- `--local`: Target `.claudish.json` in the current working directory
- `--global`: Target `~/.claudish/config.json`
- (omit): Prompted interactively; suggests `--local` if CWD appears to be a project directory (has `.git`, `package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, or `.claudish.json`)

---

## 3. Environment Variables

Claudish automatically loads `.env` from the current working directory at startup using dotenv. All variables below can be set in `.env`.

### 3.1 Claudish-Specific Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `CLAUDISH_DEFAULT_PROVIDER` | Default provider for auto-routing (v7.0.0+); overrides config file `defaultProvider` | none |
| `CLAUDISH_MODEL` | Default model (higher priority than `ANTHROPIC_MODEL`) | none |
| `CLAUDISH_PORT` | Default proxy port | random (3000–9000) |
| `CLAUDISH_CONTEXT_WINDOW` | Override context window size for local models (integer) | auto-detected |
| `CLAUDISH_MODEL_OPUS` | Override model for Opus role | none |
| `CLAUDISH_MODEL_SONNET` | Override model for Sonnet role | none |
| `CLAUDISH_MODEL_HAIKU` | Override model for Haiku role | none |
| `CLAUDISH_MODEL_FABLE` | Override model for Fable role | none |
| `CLAUDISH_MODEL_SUBAGENT` | Override model for sub-agents | none |
| `CLAUDISH_SUMMARIZE_TOOLS` | Summarize tool descriptions (`true` or `1` to enable) | false |
| `CLAUDISH_TELEMETRY` | Override telemetry (`0`, `false`, or `off` to disable) | from config |
| `CLAUDISH_ACTIVE_MODEL_NAME` | (Internal) Set by Claudish to display model name in status line | auto |
| `CLAUDISH_IS_LOCAL` | (Internal) Set to `"true"` for local models; used by status line to show "LOCAL" instead of cost | auto |
| `CLAUDISH_LOCAL_QUEUE_ENABLED` | Enable/disable local model request queue (`false` or `0` to disable) | `true` |
| `CLAUDISH_LOCAL_MAX_PARALLEL` | Max concurrent local model requests (integer 1–8; values above 8 are capped) | `1` |
| `CLAUDISH_QWEN_NO_THINK` | Prepend `/no_think` to system prompt for Qwen local models (set to `"1"`) | none |

### 3.2 Claude Code Compatibility Variables

| Variable | Purpose | Fallback for |
|----------|---------|-------------|
| `ANTHROPIC_MODEL` | Claude Code standard model selection | `CLAUDISH_MODEL` (lower priority) |
| `ANTHROPIC_SMALL_FAST_MODEL` | Claude Code standard fast model var | — |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | Claude Code opus model var | `CLAUDISH_MODEL_OPUS` (lower priority) |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | Claude Code sonnet model var | `CLAUDISH_MODEL_SONNET` (lower priority) |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | Claude Code haiku model var | `CLAUDISH_MODEL_HAIKU` (lower priority) |
| `ANTHROPIC_DEFAULT_FABLE_MODEL` | Claude Code fable model var | `CLAUDISH_MODEL_FABLE` (lower priority) |
| `CLAUDE_CODE_SUBAGENT_MODEL` | Claude Code subagent model var | `CLAUDISH_MODEL_SUBAGENT` (lower priority) |
| `ANTHROPIC_API_KEY` | Non-secret onboarding placeholder in proxy-only mode | (placeholder set by Claudish) |
| `ANTHROPIC_AUTH_TOKEN` | Non-secret onboarding placeholder in proxy-only mode | (placeholder set by Claudish) |
| `CLAUDE_PATH` | Custom path to Claude Code binary | `~/.claude/local/claude`, then global `PATH` |

The two placeholder values only satisfy Claude Code's local API/login checks. They do **not** authenticate an upstream provider or the Claudish hub. Hub access is authenticated separately, commonly through `x-proxy-key` in `ANTHROPIC_CUSTOM_HEADERS`; provider credentials remain on the Claudish host.

Claudish applies the placeholders together with `forceLoginMethod: "console"` only when every configured role is proxied to a non-native provider. Monitor mode and any configuration containing a `native-anthropic` mapping preserve the user's Claude/Anthropic authentication instead. An OS-managed policy forcing `forceLoginMethod: "claudeai"` cannot be overridden by a temporary `--settings` file and blocks proxy-only onboarding until an administrator permits Console/API authentication.

**Priority for model selection (highest to lowest)**:
1. CLI flag (`--model`, `--model-opus`, etc.)
2. `CLAUDISH_MODEL_*` environment variables
3. `ANTHROPIC_DEFAULT_*` / `CLAUDE_CODE_SUBAGENT_MODEL` environment variables
4. Profile models from config (local `.claudish.json` first, then global)
5. Interactive selector (if no model specified in interactive mode)

### 3.3 API Keys (Cloud Providers)

| Variable | Provider | Aliases | Where to Get |
|----------|----------|---------|-------------|
| `OPENROUTER_API_KEY` | OpenRouter (default backend / universal fallback) | | https://openrouter.ai/keys |
| `GEMINI_API_KEY` | Google Gemini direct API (`g@`, `google@`) | | https://aistudio.google.com/app/apikey |
| `OPENAI_API_KEY` | OpenAI direct API (`oai@`) | | https://platform.openai.com/api-keys |
| `MINIMAX_API_KEY` | MiniMax (`mm@`, `mmax@`) | | https://www.minimaxi.com/ |
| `MINIMAX_CODING_API_KEY` | MiniMax Coding Plan (`mmc@`) | | https://platform.minimax.io/ |
| `MOONSHOT_API_KEY` | Kimi/Moonshot (`kimi@`, `moon@`) | `KIMI_API_KEY` | https://platform.moonshot.cn/ |
| `KIMI_CODING_API_KEY` | Kimi Coding Plan (`kc@`); also accepts OAuth via `claudish --kimi-login` | | https://kimi.com/code |
| `ZHIPU_API_KEY` | GLM/Zhipu direct API (`glm@`, `zhipu@`) | `GLM_API_KEY` | https://open.bigmodel.cn/ |
| `GLM_CODING_API_KEY` | GLM Coding Plan at Z.AI (`gc@`) | `ZAI_CODING_API_KEY` | https://z.ai/subscribe |
| `ZAI_API_KEY` | Z.AI Anthropic-compatible API (`zai@`) | | https://z.ai/ |
| `OLLAMA_API_KEY` | OllamaCloud hosted API (`oc@`, `llama@`, `lc@`, `meta@`) | | https://ollama.com/account |
| `OPENCODE_API_KEY` | OpenCode Zen (`zen@`); optional for free models (falls back to `"public"` bearer) | | https://opencode.ai/ |
| `XAI_API_KEY` | xAI / Grok (direct API, detected in model selector) | | https://x.ai/ |
| `LITELLM_API_KEY` | LiteLLM proxy (`ll@`, `litellm@`) | | https://docs.litellm.ai/ |
| `POE_API_KEY` | Poe (`poe@`) | | https://poe.com/ |
| `VERTEX_API_KEY` | Vertex AI Express mode (`v@`, `vertex@`) | | https://console.cloud.google.com/vertex-ai |
| `VERTEX_PROJECT` | Vertex AI OAuth mode — GCP project ID | `GOOGLE_CLOUD_PROJECT` | GCP Console |
| `VERTEX_LOCATION` | Vertex AI region | `us-central1` | |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to GCP service account JSON file (Vertex OAuth) | | GCP Console |
| `GOOGLE_CLOUD_PROJECT` | GCP project ID (also used by Gemini Code Assist OAuth) | `GOOGLE_CLOUD_PROJECT_ID` | |

**Note on Vertex AI**: Vertex supports two authentication modes:
- Express mode (`VERTEX_API_KEY`): Uses the Gemini API endpoint; supports Gemini models only.
- OAuth mode (`VERTEX_PROJECT` + Application Default Credentials via `gcloud auth application-default login` or `GOOGLE_APPLICATION_CREDENTIALS`): Supports all Vertex models including partner models (Anthropic Claude, Mistral, etc.).

**Note on OpenCode Zen**: Free-tier models (cost.input === 0) work without any API key; Claudish automatically uses `"Bearer public"`. Paid models on the zen endpoint require `OPENCODE_API_KEY`.

### 3.4 Custom Endpoints (Remote Providers)

| Variable | Provider | Default |
|----------|----------|---------|
| `GEMINI_BASE_URL` | Google Gemini API | `https://generativelanguage.googleapis.com` |
| `OPENAI_BASE_URL` | OpenAI API (also for Azure-compatible) | `https://api.openai.com` |
| `MINIMAX_BASE_URL` | MiniMax API | `https://api.minimaxi.com` |
| `MINIMAX_CODING_BASE_URL` | MiniMax Coding Plan endpoint | `https://api.minimax.io` |
| `MOONSHOT_BASE_URL` | Kimi/Moonshot API | `https://api.moonshot.ai` |
| `KIMI_BASE_URL` | Alias for `MOONSHOT_BASE_URL` | |
| `ZHIPU_BASE_URL` | GLM/Zhipu API | `https://open.bigmodel.cn` |
| `GLM_BASE_URL` | Alias for `ZHIPU_BASE_URL` | |
| `ZAI_BASE_URL` | Z.AI API | `https://api.z.ai` |
| `OLLAMACLOUD_BASE_URL` | OllamaCloud hosted API | `https://ollama.com` |
| `OPENCODE_BASE_URL` | OpenCode Zen API (base; `/v1/chat/completions` appended) | `https://opencode.ai/zen` |
| `LITELLM_BASE_URL` | LiteLLM proxy server URL (**required** to enable LiteLLM routing) | none |

**Note on `OPENCODE_BASE_URL`**: For the Zen Go plan endpoint, Claudish replaces `/zen` with `/zen/go` automatically. Setting `OPENCODE_BASE_URL=https://opencode.ai/zen` is equivalent to the default.

### 3.5 Local Provider Endpoints

| Variable | Provider | Default |
|----------|----------|---------|
| `OLLAMA_BASE_URL` | Ollama local server | `http://localhost:11434` |
| `OLLAMA_HOST` | Alias for `OLLAMA_BASE_URL` | |
| `LMSTUDIO_BASE_URL` | LM Studio local server | `http://localhost:1234` |
| `VLLM_BASE_URL` | vLLM local server | `http://localhost:8000` |
| `MLX_BASE_URL` | MLX local server | `http://127.0.0.1:8080` |

### 3.6 Gemini OAuth (Advanced)

| Variable | Purpose | Default |
|----------|---------|---------|
| `GEMINI_CLIENT_ID` | Custom OAuth client ID for Gemini Code Assist | built-in (from Claudish installation) |
| `GEMINI_CLIENT_SECRET` | Custom OAuth client secret for Gemini Code Assist | built-in (from Claudish installation) |

These are only needed if you want to use your own Google Cloud OAuth application instead of Claudish's built-in credentials.

---

## 4. Configuration Files

### 4.1 `~/.claudish/config.json` (Global Configuration)

```json
{
  "version": "1.0.0",
  "defaultProfile": "default",
  "defaultProvider": "openrouter",
  "profiles": {
    "default": {
      "name": "default",
      "description": "Default profile",
      "models": {
        "opus": "oai@gpt-5.3",
        "sonnet": "google@gemini-3-pro",
        "haiku": "mm@MiniMax-M2.1",
        "subagent": "google@gemini-2.0-flash"
      },
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z"
    }
  },
  "telemetry": {
    "enabled": false,
    "askedAt": "2026-01-01T00:00:00Z",
    "promptedVersion": "5.10.0"
  },
  "routing": {
    "kimi-*": ["kc", "kimi", "openrouter"],
    "glm-*": ["gc", "glm", "openrouter"],
    "*": ["litellm", "openrouter"]
  },
  "customEndpoints": {
    "my-vllm": {
      "kind": "simple",
      "url": "http://gpu-box:8000",
      "format": "openai",
      "apiKey": "${VLLM_API_KEY}"
    }
  }
}
```

**Field descriptions**:

- **`version`**: Config schema version string (currently `"1.0.0"`).
- **`defaultProfile`**: Name of the profile to use when `--profile` is not specified.
- **`defaultProvider`** (v7.0.0+): Default provider for auto-routing. Accepts built-in provider names (`"openrouter"`, `"litellm"`, `"openai"`, `"anthropic"`, `"google"`) or a custom endpoint name. See Section 6.1 for precedence. Absent means use legacy auto-detection.
- **`customEndpoints`** (v7.0.0+): Named map of custom endpoint definitions. See Section 7.5 for schema.
- **`profiles`**: Map of profile name to profile object. Each profile has:
  - **`name`**: Profile identifier (matches the map key).
  - **`description`**: Optional human-readable description.
  - **`models`**: Model mapping with optional keys `opus`, `sonnet`, `haiku`, `fable`, `subagent`. Each value is a full model spec (e.g., `"google@gemini-3-pro"`). Absent keys mean no override for that role.
  - **`createdAt`** / **`updatedAt`**: ISO 8601 timestamps (managed by Claudish).
- **`telemetry`**: Consent state.
  - **`enabled`**: Whether telemetry is on. Default is `false` until user explicitly opts in.
  - **`askedAt`**: ISO 8601 timestamp of when the user was last prompted. Absent means never prompted.
  - **`promptedVersion`**: Claudish version string at time of prompting.
- **`routing`**: Custom routing rules (see Section 7). Absent means use default auto-routing chain.

### 4.2 `.claudish.json` (Local/Project Configuration)

Same schema as `~/.claudish/config.json`. Placed in the project root directory (wherever Claudish is run from).

**Resolution order**:
- Profile lookup: local `.claudish.json` profiles checked first, then global `~/.claudish/config.json`.
- Default profile: local `defaultProfile` takes precedence if the local config exists and specifies one.
- Custom routing rules: local `routing` key **entirely replaces** global routing rules (no merge).
- Local config does not include `telemetry` (consent is global only).

**Note**: The default profile in the local config is looked up first in local profiles, then in global profiles. A local config can reference global profiles by name.

### 4.3 `~/.claudish/` Directory Contents

| File | Purpose | Auto-updated |
|------|---------|-------------|
| `config.json` | Global config: profiles, telemetry, routing | Manual (via `claudish profile` commands) |
| `all-models.json` | Cached full model catalog from OpenRouter | Every 2 days, or on `--force-update` |
| `litellm-models-{hash}.json` | Cached LiteLLM model list per server (hash = SHA-256 of `LITELLM_BASE_URL`) | On each LiteLLM model fetch |
| `kimi-oauth.json` | Kimi OAuth credentials (access + refresh tokens) | On `claudish --kimi-login` |
| `gemini-oauth.json` | Gemini Code Assist OAuth credentials | On `claudish --gemini-login` |
| `logs/` | Debug log files (created when `--debug` is used) | Per session |

---

## 5. Provider Routing Syntax

### 5.1 Current Syntax (v4.0+): `provider@model[:concurrency]`

The preferred syntax. The `@` separator unambiguously identifies the provider.

```
google@gemini-3-pro              # Direct Google Gemini API
oai@gpt-5.3                     # Direct OpenAI API
openrouter@deepseek/deepseek-r1  # Explicit OpenRouter with vendor-prefixed model
ollama@llama3.2                  # Local Ollama, sequential (default)
ollama@llama3.2:3                # Local Ollama, allow up to 3 concurrent requests
ollama@llama3.2:0                # Local Ollama, no concurrency limit (bypass queue)
ll@my-model                      # LiteLLM proxy with auto catalog resolution
```

Provider part is **case-insensitive**. Shortcuts are resolved to canonical provider names.

### 5.2 Provider Shortcuts

#### Remote Providers

| Shortcut(s) | Canonical Provider | Notes |
|-------------|-------------------|-------|
| `g`, `gemini` | `google` | Direct Google Gemini API (`GEMINI_API_KEY`) |
| `oai` | `openai` | Direct OpenAI API (`OPENAI_API_KEY`) |
| `cx`, `codex` | `openai-codex` | OpenAI Codex — Responses API (`OPENAI_CODEX_API_KEY` or OAuth via `claudish login codex`; `OPENAI_API_KEY` is accepted as an auth-header alias but does **not** make the lane routable — plain OpenAI keys get 400 on `/v1/responses`; `OPENAI_CODEX_BASE_URL` overrides) |
| `or`, `openrouter` | `openrouter` | OpenRouter (`OPENROUTER_API_KEY`) |
| `mm`, `mmax` | `minimax` | MiniMax direct API (`MINIMAX_API_KEY`) |
| `mmc` | `minimax-coding` | MiniMax Coding Plan (`MINIMAX_CODING_API_KEY`) |
| `kimi`, `moon`, `moonshot` | `kimi` | Kimi/Moonshot API (`MOONSHOT_API_KEY` or `KIMI_API_KEY`) |
| `kc` | `kimi-coding` | Kimi Coding Plan (`KIMI_CODING_API_KEY` or OAuth) |
| `glm`, `zhipu` | `glm` | GLM/Zhipu direct API (`ZHIPU_API_KEY` or `GLM_API_KEY`) |
| `gc` | `glm-coding` | GLM Coding Plan at Z.AI (`GLM_CODING_API_KEY` or `ZAI_CODING_API_KEY`) |
| `zai` | `zai` | Z.AI Anthropic-compatible API (`ZAI_API_KEY`) |
| `oc`, `llama`, `lc`, `meta` | `ollamacloud` | OllamaCloud hosted API (`OLLAMA_API_KEY`) |
| `zen` | `opencode-zen` | OpenCode Zen (`OPENCODE_API_KEY`; optional for free models) |
| `zengo`, `zgo` | `opencode-zen-go` | OpenCode Zen Go subscription plan |
| `v`, `vertex` | `vertex` | Vertex AI (`VERTEX_API_KEY` or `VERTEX_PROJECT`) |
| `go` | `gemini-codeassist` | Gemini Code Assist via OAuth (`claudish --gemini-login`) |
| `litellm`, `ll` | `litellm` | LiteLLM proxy (`LITELLM_BASE_URL` + `LITELLM_API_KEY`) |
| `poe` | `poe` | Poe API (`POE_API_KEY`) |

#### Local Providers (no API key required)

| Shortcut(s) | Provider | Default Endpoint |
|-------------|----------|-----------------|
| `ollama` | Ollama | `http://localhost:11434` |
| `lms`, `lmstudio`, `mlstudio` | LM Studio | `http://localhost:1234` |
| `vllm` | vLLM | `http://localhost:8000` |
| `mlx` | MLX | `http://127.0.0.1:8080` |

### 5.3 Native Auto-Detection (no provider prefix)

When no `provider@` prefix is given, Claudish detects the provider from the model name pattern. Resolution is by the first matching pattern:

| Pattern | Routes To | Notes |
|---------|-----------|-------|
| `google/*` or `gemini-*` | Google Gemini | |
| `openai/*` or `gpt-*` or `o1-*` or `o3-*` or `chatgpt-*` | OpenAI | |
| `minimax/*` or `minimax-*` or `abab-*` | MiniMax | |
| `kimi-for-coding` (exact) | Kimi Coding Plan | Must match exactly; checked before `kimi-*` |
| `moonshot/*` or `moonshot-*` or `kimi-*` | Kimi | |
| `zhipu/*` or `glm-*` or `chatglm-*` | GLM | |
| `z-ai/*` or `zai/*` | Z.AI | |
| `ollamacloud/*` or `meta-llama/*` or `llama-*` or `llama3*` | OllamaCloud | |
| `qwen*` | Auto-routed (no direct API) | Falls to OpenRouter or LiteLLM |
| `poe:*` | Poe | Literal `poe:` prefix |
| `anthropic/*` or `claude-*` | Native Anthropic | Claude Code's own auth, no proxy |
| `vendor/model` (unknown vendor) | Error | Must use explicit `openrouter@vendor/model` |
| bare name (no `/`) | Native Anthropic | Treated as Claude model; no proxy |

### 5.4 Legacy Prefix Syntax (deprecated, still supported)

The old `prefix/model` format works but emits a deprecation warning suggesting the `@` syntax.

| Legacy Prefix | Provider | New Equivalent |
|---------------|----------|----------------|
| `g/` | Google Gemini | `g@` |
| `gemini/` | Google Gemini | `gemini@` |
| `go/` | Gemini Code Assist | `go@` |
| `oai/` | OpenAI | `oai@` |
| `or/` | OpenRouter | `or@` |
| `mmax/`, `mm/` | MiniMax | `mm@` |
| `mmc/` | MiniMax Coding | `mmc@` |
| `kimi/`, `moonshot/` | Kimi | `kimi@` |
| `kc/` | Kimi Coding | `kc@` |
| `glm/`, `zhipu/` | GLM | `glm@` |
| `gc/` | GLM Coding | `gc@` |
| `zai/` | Z.AI | `zai@` |
| `oc/` | OllamaCloud | `oc@` |
| `zen/` | OpenCode Zen | `zen@` |
| `zengo/`, `zgo/` | OpenCode Zen Go | `zengo@` |
| `v/`, `vertex/` | Vertex AI | `v@` |
| `litellm/`, `ll/` | LiteLLM | `ll@` |
| `ollama/`, `ollama:` | Ollama (local) | `ollama@` |
| `lmstudio/`, `lmstudio:`, `mlstudio/`, `mlstudio:` | LM Studio (local) | `lms@` |
| `vllm/`, `vllm:` | vLLM (local) | `vllm@` |
| `mlx/`, `mlx:` | MLX (local) | `mlx@` |

### 5.5 Custom URL Syntax

A full URL is accepted directly as a model spec and treated as a local custom endpoint (no API key required):

```
http://localhost:11434/llama3.2
http://192.168.1.100:8000/mistral
https://localhost:8080/model
```

---

## 6. Auto-Routing Priority Chain

When a model name has no explicit provider prefix and does not match a native pattern that maps to a provider with credentials, Claudish builds a fallback chain (implemented in `auto-route.ts` / `getFallbackChain()`).

### 6.1 Default Provider (v7.0.0+)

The fallback chain is **configurable** via the `defaultProvider` setting. Set it in any of these locations:

| Method | Example |
|--------|---------|
| Config file | `"defaultProvider": "litellm"` in `~/.claudish/config.json` |
| Env var | `CLAUDISH_DEFAULT_PROVIDER=openrouter` |
| CLI flag | `claudish --default-provider google "task"` |

**Precedence** (highest to lowest):
1. CLI flag `--default-provider`
2. `CLAUDISH_DEFAULT_PROVIDER` env var
3. `defaultProvider` in config file
4. `OPENROUTER_API_KEY` present → OpenRouter
5. Hardcoded `"openrouter"`

Valid values: any built-in provider name (`"openrouter"`, `"litellm"`, `"openai"`, `"anthropic"`, `"google"`) or a custom endpoint name from `customEndpoints`.

**Where it applies (proxy side, #468):** the proxy server resolves the effective default once at startup and passes it to `route()`, so **every bare-name chain served through the proxy** gets the default appended as a final fallback hop (deduped — `or` ≡ `openrouter`; explicit `provider@model` targets are never affected). Before #468 the proxy routed bare names with **no** fallback hop at all, whatever `defaultProvider` said — the setting only governed the CLI-side chain.

**Strict no-fallback mode takes TWO settings**: `routing["*"] = []` in user config AND a present-empty default — **in the env form only** (`CLAUDISH_DEFAULT_PROVIDER=""`). The resolver is asymmetric here (pinned): an env value that is present but empty is an explicit opt-out, but a config-file `defaultProvider: ""` is **not** — the truthiness guard in `resolveDefaultProvider()` (`default-provider.ts`) drops it and falls through to `OPENROUTER_API_KEY`/the hardcoded `openrouter` (precedence steps 4–5). An absent default is not an empty one either: with nothing set, the fallback hop resolves to the hardcoded `openrouter` and lands on every bare-name chain, an empty one included. Compose-deployed containers pass `CLAUDISH_DEFAULT_PROVIDER` empty by default (`docker-compose.yml`), which keeps them opt-out; a non-empty value there would add an OpenRouter (PAYG) hop to every bare-name chain.

### 6.2 Default chain (no `defaultProvider` set)

When `defaultProvider` is absent and only `OPENROUTER_API_KEY` is present:

1. **OpenCode Zen** — if `OPENCODE_API_KEY` is set.
2. **Provider subscription/coding plan** — if the native provider has a subscription alternative and credentials exist:
   - `kimi` → Kimi Coding Plan (`kc@kimi-for-coding`) if `KIMI_CODING_API_KEY` or OAuth present.
   - `minimax` → MiniMax Coding Plan (`mmc@`) if `MINIMAX_CODING_API_KEY` present.
   - `glm` → GLM Coding Plan at Z.AI (`gc@`) if `GLM_CODING_API_KEY` or `ZAI_CODING_API_KEY` present.
   - `google` → Gemini Code Assist (`go@`) if OAuth credentials present.
3. **Native provider API** — if the detected native provider has an API key or OAuth credentials.
4. **OpenRouter** — if `OPENROUTER_API_KEY` is set (universal fallback).

### 6.3 LiteLLM is never promoted automatically

Setting `LITELLM_BASE_URL` + `LITELLM_API_KEY` does **not** make LiteLLM the default. It once did, and the stderr hint that used to suggest making it explicit is gone too — `buildLegacyHint()` is a stub returning `null`, and `resolveDefaultProvider()` has no LiteLLM branch at all (`default-provider.ts`). Both were removed in commit 5 of the model-catalog/routing redesign.

To route through LiteLLM by default, say so explicitly:

```jsonc
{ "defaultProvider": "litellm" }      // ~/.claudish/config.json
```

or `CLAUDISH_DEFAULT_PROVIDER=litellm`. Explicit `litellm@model` targets are unaffected and always were.

If none of the chain entries have valid credentials, Claudish returns an error with instructions on how to authenticate.

---

## 7. Custom Routing Rules

Custom routing rules are defined in the `routing` key of `config.json` or `.claudish.json`. Local rules **entirely replace** global rules (no merge).

```json
{
  "routing": {
    "kimi-for-coding": ["kc", "kimi", "or"],
    "kimi-*": ["kimi", "or@moonshot/kimi-k2"],
    "glm-*": ["gc", "glm"],
    "*": ["litellm", "openrouter"]
  }
}
```

### Pattern Matching (priority order)

1. **Exact match** — e.g., `"kimi-for-coding"`: checked first.
2. **Glob patterns** — single `*` wildcard, e.g., `"kimi-*"`. Multiple patterns are sorted longest-first (most specific wins).
3. **Catch-all** — `"*"`: matches any model not matched above.

### Entry Format

Each entry in the routing chain array is a string. Format options:

- **`"provider"`** — Use the original model name on the specified provider (e.g., `"kimi"` uses `kimi@{originalModelName}`).
- **`"provider@model"`** — Use a specific model on the provider (e.g., `"or@moonshot/kimi-k2"` uses OpenRouter with the given model ID).

Provider shortcuts (same as `@` syntax) are resolved in entries. LiteLLM entries automatically use the model catalog resolver to find the vendor-prefixed model name.

### Catch-All Synthesis from `defaultProvider` (v7.0.0+)

When `defaultProvider` is set and no explicit `routing["*"]` catch-all exists in the config, Claudish synthesizes `routing["*"] = [<defaultProvider>]` at config load time. An explicit `routing["*"]` always takes precedence over the synthesized one.

```json
{
  "defaultProvider": "litellm",
  "routing": {
    "kimi-*": ["kc", "kimi", "or"]
  }
}
```

The above is equivalent to:

```json
{
  "routing": {
    "kimi-*": ["kc", "kimi", "or"],
    "*": ["litellm"]
  }
}
```

### Validation

Claudish warns at load time if:
- A pattern has multiple `*` wildcards (only single `*` is supported).
- A rule's entry list is empty (the pattern would have no fallback).

---

## 7.5 Custom Endpoints (v7.0.0+)

Define named custom endpoints in `~/.claudish/config.json` (or `.claudish.json`) under the `customEndpoints` key. Each endpoint becomes a provider prefix usable with `@` syntax.

### Simple endpoint

For OpenAI- or Anthropic-compatible servers:

```json
{
  "customEndpoints": {
    "my-vllm": {
      "kind": "simple",
      "url": "http://gpu-box:8000",
      "format": "openai",
      "apiKey": "${VLLM_API_KEY}",
      "modelPrefix": "my-org/",
      "models": ["llama3.1-70b", "qwen2.5-72b"]
    }
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `kind` | `"simple"` | yes | Discriminator |
| `url` | string | yes | Base URL of the server |
| `format` | `"openai"` or `"anthropic"` | yes | Wire format |
| `apiKey` | string | no | API key; supports `${VAR}` env expansion |
| `modelPrefix` | string | no | Prepended to model name before sending to API |
| `models` | string[] | no | Restrict to listed models; omit to allow any |
| `maxConcurrency` | integer 0–32 | no | Max concurrent in-flight requests (0 = unlimited, 1 = sequential; omit = unbounded). For capacity-limited backends (single-GPU vLLM). An out-of-range value **fails validation and skips the whole entry** — the endpoint leaves the routing table. |
| `maxOutputTokens` | integer ≥ 1 | no | #431 — clamps `max_tokens` DOWN to this before the request leaves (never up; unset = verbatim). vLLM counts `prompt + max_tokens` against `--max-model-len` and refuses rather than trims: a ~240k prompt with the fleet-standard `max_tokens: 32000` against a 262144 window is a refusal; with the cap at 8192 the same prompt is served. Same field on simple and complex kinds. |
| `contextLimit` | integer ≥ 1 | no | #441 — the endpoint's TOTAL window (`--max-model-len` on vLLM: prompt + output counted together, refusal never trim). When set, `max_tokens` is clamped per request to `contextLimit − promptEstimate − max(2048, est/64)` (the proportional margin tracks the /4→/3.5 estimator drift on code-dense prompts — pre-review #442). The clamp estimate replaces each image/document base64 block with a fixed **1600-token allocation** (`estimateClampTokens`) — a 1 MB screenshot scores ~1.6k tokens, not ~750k (#442 review: without this, a screenshot turn clamped 16384 → 558). Below a useful floor of `min(max_tokens asked, 4096)` the clamp **stands down** (max_tokens verbatim) so the upstream refusal stays recoverable (#431 SKIP). This is the dynamic complement of `maxOutputTokens`: a compaction turn at the RX95 window (~250k prompt) with the fleet-standard `max_tokens: 32000` ships ~8.4k against a 262144 window instead of 400ing. Smallest cap wins when both fields are set. Unset = verbatim passthrough. Zero-code alternative (#441 option A): a plain `maxOutputTokens: 12000` also fits the RX95 window, but caps EVERY request — `contextLimit` only caps the ones near the window. Same field on simple and complex kinds. |

Usage: `claudish --model my-vllm@llama3.1-70b "task"`

### Complex endpoint

Full control over transport, auth, headers, and stream format:

```json
{
  "customEndpoints": {
    "corp-proxy": {
      "kind": "complex",
      "displayName": "Corporate LLM Proxy",
      "transport": "openai",
      "baseUrl": "https://llm.corp.internal",
      "apiPath": "/api/v2/chat/completions",
      "apiKey": "${CORP_LLM_KEY}",
      "authScheme": "X-Api-Key",
      "headers": { "X-Team": "platform" },
      "streamFormat": "openai-sse",
      "modelPrefix": "",
      "models": ["gpt-4o", "claude-sonnet"]
    }
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `kind` | `"complex"` | yes | Discriminator |
| `displayName` | string | no | Human-readable name (shown in logs) |
| `transport` | string | yes | Transport type (e.g., `"openai"`, `"anthropic"`) |
| `baseUrl` | string | yes | Server base URL |
| `apiPath` | string | no | Custom API path (overrides default for transport) |
| `apiKey` | string | no | API key; supports `${VAR}` env expansion |
| `authScheme` | string | no | Auth header scheme (default: `Bearer`; use `X-Api-Key` for header-name auth) |
| `headers` | object | no | Additional HTTP headers |
| `streamFormat` | string | no | Stream parser override (e.g., `"openai-sse"`, `"anthropic-sse"`) |
| `modelPrefix` | string | no | Prepended to model name |
| `models` | string[] | no | Restrict to listed models |
| `maxConcurrency` | integer 0–32 | no | Same as the simple kind |
| `maxOutputTokens` | integer ≥ 1 | no | #431 — same as the simple kind: clamps `max_tokens` down before the request leaves |
| `contextLimit` | integer ≥ 1 | no | #441 — same as the simple kind: dynamic `contextLimit − promptEstimate − max(2048, est/64)` clamp |
| `omitReasoningContent` | boolean | no | Drops `reasoning_content` from outbound assistant messages (strict-schema backends) |

### Environment variable expansion

The `apiKey` field supports `${VAR_NAME}` syntax. Claudish expands it from `process.env` at startup. This avoids hardcoding secrets in config files:

```json
"apiKey": "${MY_CUSTOM_API_KEY}"
```

### Validation

Claudish validates all `customEndpoints` entries with Zod at proxy startup. Invalid entries:
- Emit a warning to stderr with the validation error
- Are skipped (not registered)
- Do not prevent the proxy from starting

### Runtime registration

Each valid custom endpoint calls `registerRuntimeProvider()` (injects into the provider resolver) and `registerRuntimeProfile()` (injects into the transport layer). The endpoint name becomes a valid provider shortcut immediately.

---

## 7.6 Scoped Inbound Keys (#400)

For external consumers (a shared GPU lane, a friend testing the fleet): a key that authenticates exactly like the proxy key but reaches **only** the models its allowlist names. Subscriptions stay fleet-internal; revoking the external is deleting one config entry, never rotating `CLAUDISH_PROXY_KEY` fleet-wide.

```json
{
  "apiKeys": {
    "INBOUND_EXTERNAL_KEY": "ck-xxxxxxxx"
  },
  "inboundKeys": {
    "external-jamin": {
      "key": "${INBOUND_EXTERNAL_KEY}",
      "allowModels": ["swift-1.5-27b", "qwen3.6-35b-a3b", "frognano-4b"]
    }
  }
}
```

| Field         | Type     | Required | Description                                                        |
|---------------|----------|----------|--------------------------------------------------------------------|
| `key`         | string   | yes      | Secret; supports `${VAR}` expansion from `apiKeys` first, then env |
| `allowModels` | string[] | yes      | Model ids this key may serve. Non-empty.                           |

Semantics (resolved in `handlers/shared/inbound-keys.ts`):

- **Bare names** pass iff the **client-sent model string** is allowlisted. For a bare name that string *is* the parsed id (`parseModelSpec` returns it unchanged) — the `routing` / `customEndpoints` resolution that picks the serving target runs **later**, inside the route handler, so it never feeds this gate. A name that exists only as a routing **alias** is therefore refused unless the alias is listed **as the client spells it**. Measured 2026-10-08 on the hub: `swift-1.5-27b` → `403`, which listed only `qwen3.6-35b-a3b`; both spellings name the same routing target (`vllm-myia@qwen3.6-35b-a3b`), so the two are independent allowlist entries, not one name in two forms.
- **Explicit provider forms** (`provider@model`) pass only on an **exact raw allowlist hit** — `or@swift-1.5-27b` is refused, an allowlisted id must not ride onto a different transport's wire.
- Anything else is a labeled `403 permission_error` (`[InboundKey] key '<name>' is not permitted to use model '<model>'…`) + one `[InboundKey] refused key=<name> model=<model>` marker per refusal. Wording deliberately free of quota-class words (#296 doctrine: `isQuotaExhaustion` must never arm on it).
- The gate runs **before** the Anthropic passthrough exemption — a scoped key never rides the native lane either.
- Applies to every ingress this auth covers: `/v1/messages`, `/v1/chat/completions`, `/v1/messages/count_tokens`.
- **Attribution**: requests authed by a scoped key carry `inbound_key: "<name>"` in the capture envelope (`req-*.json`) — key-based, stable where external IPs are dynamic. The stdout `[Request]` line is unchanged (pinned consumer contract).

Validation doctrine (same as `customEndpoints`): an entry failing validation — missing/empty key, unresolvable `${VAR}`, empty `allowModels`, a key value equal to a full-access proxy key or duplicated across entries — is **skipped with one stderr warning, never a crash**. Inert with no `inboundKeys` config: zero behavior change. An entry may also carry a `maxConcurrency` (#406) capping that key's concurrent in-flight requests: acquired at authentication, released on the response lifecycle (immediately for a non-SSE response, on stream close/cancel for SSE); at the cap the refusal is a labeled `429` whose wording deliberately never arms `isQuotaExhaustion`. An unreadable cap (`0`, negative, non-integer, `null`) **skips the entry** — never "unlimited".

Requires a proxy restart to take effect (config read once per proxy lifetime — same lifecycle as `customEndpoints`).

---

## 8. Model Mapping Priority

For each role slot (opus, sonnet, haiku, fable, subagent), resolution from highest to lowest priority:

1. CLI flag: `--model-opus`, `--model-sonnet`, `--model-haiku`, `--model-fable`, `--model-subagent`
2. `CLAUDISH_MODEL_OPUS`, `CLAUDISH_MODEL_SONNET`, `CLAUDISH_MODEL_HAIKU`, `CLAUDISH_MODEL_FABLE`, `CLAUDISH_MODEL_SUBAGENT`
3. `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_DEFAULT_FABLE_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`
4. Profile `models` fields from active profile (local `.claudish.json` first, then global `~/.claudish/config.json`)
5. No mapping set: Claude Code uses its own internal defaults for that role

The **primary model** (`--model` / `CLAUDISH_MODEL` / `ANTHROPIC_MODEL`) is separate from role mappings and determines what provider/model handles the main conversation. Role mappings tell Claude Code which models to use internally for different task types.

---

## 9. Local Model Support

Claudish provides specialized support for local inference servers with these behaviors:

### Context Window

- Detected automatically via Ollama's `/api/show` endpoint or LM Studio's `/v1/models` endpoint.
- Override with `CLAUDISH_CONTEXT_WINDOW=<integer>`.
- For Ollama, Claudish explicitly sets `options.num_ctx` to at least 32768 to prevent Ollama's default 2048-token silent truncation.

### Request Queue

The `LocalModelQueue` (in `handlers/shared/local-queue.ts`) serializes requests to prevent GPU out-of-memory errors:
- Default: sequential (1 at a time), controlled by `CLAUDISH_LOCAL_MAX_PARALLEL`.
- Range: 1–8 (values above 8 are capped at 8).
- Disable entirely: `CLAUDISH_LOCAL_QUEUE_ENABLED=false`.
- Per-model override via concurrency suffix: `ollama@llama3.2:3` allows 3 concurrent requests for that model spec.
- `ollama@model:0` means no concurrency limit (bypasses the queue).

### Timeouts

Local provider requests use extended timeouts (10 minutes for headers + body) to accommodate slow local inference. Default undici headersTimeout of 30s is too short.

### Tool Description Summarization

For small local models with limited context, `--summarize-tools` (or `CLAUDISH_SUMMARIZE_TOOLS=1`) compresses Claude Code's tool descriptions to reduce prompt token usage.

### Qwen No-Think Mode

For local Qwen models, setting `CLAUDISH_QWEN_NO_THINK=1` prepends `/no_think` to the system prompt to disable the model's chain-of-thought reasoning mode, reducing latency.

---

## 10. Cache and Data Files

| Path | Purpose | Auto-update Trigger |
|------|---------|---------------------|
| `~/.claudish/config.json` | Global settings, profiles, telemetry, routing | Profile/telemetry commands |
| `~/.claudish/all-models.json` | Full OpenRouter model catalog | Every 2 days; or `--force-update` |
| `~/.claudish/litellm-models-{hash}.json` | LiteLLM model list (one file per unique `LITELLM_BASE_URL`) | On each LiteLLM model list fetch |
| `~/.claudish/kimi-oauth.json` | Kimi OAuth access + refresh tokens | `claudish --kimi-login` |
| `~/.claudish/gemini-oauth.json` | Gemini Code Assist OAuth tokens | `claudish --gemini-login` |
| `.claudish.json` | Local/project config | Profile commands with `--local` |
| `.env` | Environment variables (auto-loaded at startup) | Manual |

Cache files can be force-refreshed with `claudish --models --force-update` or `claudish --top-models --force-update`. The `--force-update` flag deletes `all-models.json`, `pricing-cache.json`, and all `litellm-models-*.json` files before fetching fresh data.

---

## 11. MCP (Model Context Protocol) Server Mode

Running `claudish --mcp` starts Claudish as an MCP server. In this mode, Claudish exposes itself as a tool provider to MCP-compatible clients rather than launching Claude Code.

---

## 12. Vendor Prefix Auto-Resolution (ModelCatalogResolver)

When routing through aggregators like OpenRouter or LiteLLM, models require vendor-prefixed names (e.g., `qwen/qwen3-coder-next`) that users should not need to know. The `ModelCatalogResolver` interface in `providers/model-catalog-resolver.ts` automatically finds the correct prefix.

**How it works**:
1. User specifies bare model name (e.g., `or@qwen3-coder-next`).
2. Resolver searches the provider's cached model catalog for an exact suffix match.
3. If found, uses the vendor-prefixed ID (e.g., `qwen/qwen3-coder-next`).
4. If the in-memory cache is cold, falls back to the disk cache (`~/.claudish/all-models.json`, persisted by the last successful refresh); if that is absent too, the bare name is passed through unchanged — there is no static fallback map (removed upstream `ba650d5`).

**Rules**:
- Exact match only; no fuzzy or normalized matching.
- Dynamic catalogs (from provider APIs) are primary; disk cache next; passthrough unchanged otherwise.
- Resolution is synchronous (`resolveModelNameSync()`) using in-memory cache + `readFileSync`.

**Current resolvers**:
- **OpenRouter**: Searches the slim in-memory catalog + `all-models.json` by exact suffix (modelId → aliases → externalId → suffix).
- **LiteLLM**: Searches `litellm-models-{hash}.json` by exact match and prefix-stripping.

---

## 13. Limitations

This reference does NOT cover:

1. **Claude Code flags**: The full list of flags that can be passed through to Claude Code (use `claude --help`). Claudish forwards any unrecognized flag automatically.
2. **Cost tracking internals**: The detailed algorithm for cost accumulation and the format of cost data files.
3. **MCP server protocol**: The specific MCP tool definitions and protocol details when running in `--mcp` mode.
4. **Smoke test configuration**: The `packages/cli/scripts/smoke/` configuration for provider smoke tests.
5. **Token file format**: The internal token counting files used by `writeTokenFile` for the status line display.

---

## Appendix: Quick Reference Card

```
# Install / verify
npm install -g claudish
claudish --version

# Interactive mode (model selector appears)
claudish
claudish --free          # only free models
claudish -p myprofile    # with specific profile

# Single-shot (no model selector)
claudish --model g@gemini-2.0-flash "task"
claudish --model oai@gpt-4o "task"
claudish --model ollama@llama3.2 "task"

# Model role mapping
claudish --model-opus g@gemini-3-pro --model-sonnet oai@gpt-5.3

# Auto-approve + disable sandbox (CI/automation)
claudish -y --dangerous --model g@gemini-2.0-flash "task"

# Debug
claudish --debug --model g@gemini-2.0-flash "task"

# Profile management
claudish init
claudish profile list
claudish profile add --global
claudish profile use myprofile --global

# Model discovery
claudish --models               # all models
claudish --models gemini        # search
claudish --top-models           # curated list
claudish --models --json        # JSON output

# OAuth login
claudish --gemini-login
claudish --kimi-login

# Telemetry
claudish telemetry status
claudish telemetry off
```

---

*This document was generated from direct codebase analysis of Claudish source at `packages/cli/src/`. Last updated for v7.0.0 (default provider, custom endpoints, routing rules catch-all synthesis). Key files: `cli.ts`, `config.ts`, `model-parser.ts`, `provider-resolver.ts`, `auto-route.ts`, `remote-provider-registry.ts`, `profile-config.ts`, `routing-rules.ts`.*
