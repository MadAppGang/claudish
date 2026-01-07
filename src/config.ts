// AUTO-GENERATED from shared/recommended-models.md
// DO NOT EDIT MANUALLY - Run 'bun run extract-models' to regenerate

import type { OpenRouterModel } from "./types.js";

export const DEFAULT_MODEL: OpenRouterModel = "openai/gpt-5.2";
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
  "minimax/minimax-m2.1": {
    name: "Compact high-efficiency v2.1",
    description: "Compact high-efficiency v2.1",
    priority: 2,
    provider: "MiniMax",
  },
  "z-ai/glm-4.7": {
    name: "GLM 4.7 balanced model",
    description: "GLM 4.7 balanced model",
    priority: 3,
    provider: "Z.AI",
  },
  "google/gemini-3-pro-preview": {
    name: "Gemini 3 Pro preview",
    description: "Gemini 3 Pro preview (1M context)",
    priority: 4,
    provider: "Google",
  },
  "openai/gpt-5.2": {
    name: "GPT-5.2 most advanced",
    description: "GPT-5.2 most advanced reasoning",
    priority: 5,
    provider: "OpenAI",
  },
  "moonshotai/kimi-k2-thinking": {
    name: "Kimi K2 with reasoning",
    description: "Kimi K2 with extended thinking",
    priority: 6,
    provider: "MoonShot",
  },
  "deepseek/deepseek-v3.2": {
    name: "DeepSeek V3.2 coding",
    description: "DeepSeek V3.2 coding specialist",
    priority: 7,
    provider: "DeepSeek",
  },
  "qwen/qwen3-vl-235b-a22b-thinking": {
    name: "Qwen3 VL thinking",
    description: "Qwen3 VL 235B with reasoning",
    priority: 8,
    provider: "Alibaba",
  },
  custom: {
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
