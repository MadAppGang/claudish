// Claudish configuration constants

export const DEFAULT_PORT_RANGE = { start: 3000, end: 9000 };

// Environment variable names
export const ENV = {
  OPENROUTER_API_KEY: "OPENROUTER_API_KEY",
  CLAUDISH_MODEL: "CLAUDISH_MODEL",
  CLAUDISH_PORT: "CLAUDISH_PORT",
  CLAUDISH_ACTIVE_MODEL_NAME: "CLAUDISH_ACTIVE_MODEL_NAME", // Set by claudish to show active model in status line
  // Contract published to ANY status line running inside a claudish session
  // (claudish's own, or a chained user/plugin line such as magus statusline).
  // A status line that sees either CLAUDISH_ACTIVE_MODEL_NAME or
  // CLAUDISH_TOKEN_FILE is running against a proxied, non-Anthropic account and
  // must not render Anthropic plan/rate-limit data.
  CLAUDISH_TOKEN_FILE: "CLAUDISH_TOKEN_FILE", // Absolute path to ~/.claudish/tokens-<port>.json for this session
  CLAUDISH_PROVIDER_NAME: "CLAUDISH_PROVIDER_NAME", // Provider display name (e.g. "Qwen Plan"); UNSET when not known at spawn time
  ANTHROPIC_MODEL: "ANTHROPIC_MODEL", // Claude Code standard env var for model selection
  ANTHROPIC_SMALL_FAST_MODEL: "ANTHROPIC_SMALL_FAST_MODEL", // Claude Code standard env var for fast model
  // Claudish model mapping overrides (highest priority)
  CLAUDISH_MODEL_OPUS: "CLAUDISH_MODEL_OPUS",
  CLAUDISH_MODEL_SONNET: "CLAUDISH_MODEL_SONNET",
  CLAUDISH_MODEL_HAIKU: "CLAUDISH_MODEL_HAIKU",
  CLAUDISH_MODEL_SUBAGENT: "CLAUDISH_MODEL_SUBAGENT",
  // Claude Code standard model configuration (fallback if CLAUDISH_* not set)
  ANTHROPIC_DEFAULT_OPUS_MODEL: "ANTHROPIC_DEFAULT_OPUS_MODEL",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "ANTHROPIC_DEFAULT_SONNET_MODEL",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  CLAUDE_CODE_SUBAGENT_MODEL: "CLAUDE_CODE_SUBAGENT_MODEL",
  // Auto-compaction window override — set to the main-thread model's REAL
  // per-backend context window so Claude Code compacts BEFORE a smaller-than-
  // advertised backend (e.g. the ChatGPT Codex OAuth cap on gpt-5.6-sol,
  // ~372K vs its 1.05M API spec) rejects the request. Claude Code clamps this
  // to [100K, its own understood window], so it can only compact earlier.
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  // The "its own understood window" half of that clamp. Claude Code resolves the
  // compaction point as min(CLAUDE_CODE_AUTO_COMPACT_WINDOW, maxContextTokens),
  // and for a model name it doesn't recognise — every proxied model — that
  // second term falls back to a hardcoded 200K. So the window override alone is
  // silently clamped to 200K. This var is the lever that moves the cap; Claude
  // Code honours it ONLY for model names that don't start with `claude-`, which
  // is exactly the pure-proxy case where claudish sets it.
  CLAUDE_CODE_MAX_CONTEXT_TOKENS: "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
  // Local provider endpoints (OpenAI-compatible)
  OLLAMA_BASE_URL: "OLLAMA_BASE_URL", // Ollama server (default: http://localhost:11434)
  OLLAMA_HOST: "OLLAMA_HOST", // Alias for OLLAMA_BASE_URL
  LMSTUDIO_BASE_URL: "LMSTUDIO_BASE_URL", // LM Studio server (default: http://localhost:1234)
  VLLM_BASE_URL: "VLLM_BASE_URL", // vLLM server (default: http://localhost:8000)
  // Remote cloud provider API keys and endpoints
  GEMINI_API_KEY: "GEMINI_API_KEY", // Google Gemini API key (for g/, gemini/ prefixes)
  GEMINI_BASE_URL: "GEMINI_BASE_URL", // Custom Gemini API endpoint (default: https://generativelanguage.googleapis.com)
  OPENAI_API_KEY: "OPENAI_API_KEY", // OpenAI API key (for oai/ prefix - Direct API)
  OPENAI_BASE_URL: "OPENAI_BASE_URL", // Custom OpenAI API endpoint (default: https://api.openai.com)
  // Local model optimizations
  CLAUDISH_SUMMARIZE_TOOLS: "CLAUDISH_SUMMARIZE_TOOLS", // Summarize tool descriptions to reduce prompt size
  CLAUDISH_DIAG_MODE: "CLAUDISH_DIAG_MODE", // Diagnostic output mode: auto (default), logfile, off
  CLAUDISH_DEBUG: "CLAUDISH_DEBUG", // Always-on claudish debug logging (equivalent to -d / --debug-claudish)
  // Opt IN to using a real ANTHROPIC_API_KEY for native Claude models (metered
  // API billing) instead of the claude.ai subscription. Off by default.
  CLAUDISH_ANTHROPIC_API_BILLING: "CLAUDISH_ANTHROPIC_API_BILLING",
  // Classifier passthrough (auto-mode permission classifier → native Anthropic)
  CLAUDISH_CLASSIFIER_PROVIDER: "CLAUDISH_CLASSIFIER_PROVIDER", // "anthropic" enables classifier passthrough
  CLAUDISH_CLASSIFIER_MODEL: "CLAUDISH_CLASSIFIER_MODEL", // native Claude model to rewrite the classifier onto (also enables)
} as const;

// OpenRouter API Configuration
export const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_HEADERS = {
  "HTTP-Referer": "https://claudish.com",
  "X-Title": "Claudish - OpenRouter Proxy",
} as const;
