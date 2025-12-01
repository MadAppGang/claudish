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
  POE_API_KEY: "POE_API_KEY",
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
} as const;

// OpenRouter API Configuration
export const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_HEADERS = {
  "HTTP-Referer": "https://github.com/MadAppGang/claude-code",
  "X-Title": "Claudish - OpenRouter Proxy",
} as const;

// Poe API Configuration
export const POE_API_URL = "https://api.poe.com/v1/chat/completions";
export const POE_HEADERS = {
  "User-Agent": "Claudish-Poe-Proxy/1.0",
} as const;

// Poe model metadata for validation and display
export const POE_MODEL_INFO: Record<
  string,
  { name: string; description: string; priority: number; provider: string }
> = {
  "poe/grok-4-fast-reasoning": {
    name: "Grok 4 Fast Reasoning",
    description: "Fast reasoning model from xAI via Poe with 2M context window",
    priority: 1,
    provider: "Poe",
  },
  "poe/grok-4": {
    name: "Grok 4",
    description: "Latest Grok model via Poe with state-of-the-art coding and reasoning",
    priority: 2,
    provider: "Poe",
  },
  "poe/gpt-5.1-codex": {
    name: "GPT-5.1 Codex",
    description: "OpenAI's specialized coding model via Poe",
    priority: 3,
    provider: "Poe",
  },
  "poe/gpt-5.1": {
    name: "GPT-5.1",
    description: "OpenAI's flagship general-purpose model via Poe",
    priority: 4,
    provider: "Poe",
  },
  "poe/claude-sonnet-4.5": {
    name: "Claude Sonnet 4.5",
    description: "Anthropic's most advanced model with major improvements in reasoning and coding via Poe",
    priority: 5,
    provider: "Poe",
  },
  "poe/gemini-2.5-flash": {
    name: "Gemini 2.5 Flash",
    description: "Google's advanced model with major upgrade in reasoning capabilities via Poe",
    priority: 6,
    provider: "Poe",
  },
  "poe/deepseek-r1": {
    name: "DeepSeek R1",
    description: "Top open-source reasoning LLM rivaling OpenAI's o1 model via Poe",
    priority: 7,
    provider: "Poe",
  },
  "poe/gpt-4o": {
    name: "GPT-4o",
    description: "OpenAI GPT-4o via Poe",
    priority: 8,
    provider: "Poe",
  },
  "poe/claude-opus-4.5": {
    name: "Claude Opus 4.5",
    description: "Anthropic's Claude Opus 4.5 with customizable thinking budget via Poe",
    priority: 9,
    provider: "Poe",
  },
  "poe/llama-3.1-405b": {
    name: "Llama 3.1 405B",
    description: "Meta's open-source flagship model via Poe",
    priority: 10,
    provider: "Poe",
  },
  "poe/qwen3-235b-a22b-t": {
    name: "Qwen3 235B",
    description: "Alibaba's large multimodal model via Poe",
    priority: 11,
    provider: "Poe",
  },
  "poe/glm-4.6": {
    name: "GLM-4.6",
    description: "High-performance AI model for advanced reasoning and coding via Poe",
    priority: 12,
    provider: "Poe",
  },
  "poe/gpt-5.1-codex-mini": {
    name: "GPT-5.1 Codex Mini",
    description: "Lightweight and fast code generation model derived from GPT-5.1 Codex via Poe",
    priority: 13,
    provider: "Poe",
  },
};
