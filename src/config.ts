// AUTO-GENERATED from shared/recommended-models.md
// DO NOT EDIT MANUALLY - Run 'bun run extract-models' to regenerate

import type { OpenRouterModel } from "./types.js";

export const DEFAULT_MODEL: OpenRouterModel = "x-ai/grok-code-fast-1";
export const DEFAULT_PORT_RANGE = { start: 3000, end: 9000 };

// Model metadata for validation and display
export const MODEL_INFO: Record<
  OpenRouterModel,
  { name: string; description: string; priority: number; provider: string }
> = {
  "x-ai/grok-code-fast-1": {
    name: "Ultra-fast coding",
    description: "Ultra-fast coding",
    priority: 1,
    provider: "xAI",
  },
  "minimax/minimax-m2": {
    name: "Compact high-efficiency",
    description: "Compact high-efficiency",
    priority: 2,
    provider: "MiniMax",
  },
  "google/gemini-2.5-flash": {
    name: "Advanced reasoning + vision",
    description: "Advanced reasoning + vision",
    priority: 6,
    provider: "Google",
  },
  "openai/gpt-5": {
    name: "Most advanced reasoning",
    description: "Most advanced reasoning",
    priority: 4,
    provider: "OpenAI",
  },
  "openai/gpt-5.1-codex": {
    name: "Specialized for software engineering",
    description: "Specialized for software engineering",
    priority: 5,
    provider: "OpenAI",
  },
  "qwen/qwen3-vl-235b-a22b-instruct": {
    name: "Multimodal with OCR",
    description: "Multimodal with OCR",
    priority: 7,
    provider: "Alibaba",
  },
  "openrouter/polaris-alpha": {
    name: "FREE experimental (logs usage)",
    description: "FREE experimental (logs usage)",
    priority: 8,
    provider: "OpenRouter",
  },
  "custom": {
    name: "Custom Model",
    description: "Enter any OpenRouter model ID manually",
    priority: 999,
    provider: "Custom",
  },
};

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
  // Local model optimizations
  CLAUDISH_SUMMARIZE_TOOLS: "CLAUDISH_SUMMARIZE_TOOLS", // Summarize tool descriptions to reduce prompt size
  // Google Gemini API (direct access)
  GOOGLE_API_KEY: "GOOGLE_API_KEY", // Google API key for direct Gemini access
} as const;

// OpenRouter API Configuration
export const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_HEADERS = {
  "HTTP-Referer": "https://claudish.com",
  "X-Title": "Claudish - OpenRouter Proxy",
} as const;
