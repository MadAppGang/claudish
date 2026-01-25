// Claudish configuration constants

export const DEFAULT_PORT_RANGE = { start: 3000, end: 9000 };

// Environment variable names
export const ENV = {
  OPENROUTER_API_KEY: "OPENROUTER_API_KEY",
  CLAUDISH_MODEL: "CLAUDISH_MODEL",
  CLAUDISH_PORT: "CLAUDISH_PORT",
  CLAUDISH_ACTIVE_MODEL_NAME: "CLAUDISH_ACTIVE_MODEL_NAME", // Set by claudish to show active model in status line
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
} as const;

// OpenRouter API Configuration
export const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_HEADERS = {
  "HTTP-Referer": "https://claudish.com",
  "X-Title": "Claudish - OpenRouter Proxy",
} as const;
