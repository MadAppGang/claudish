// AUTO-GENERATED from shared/recommended-models.md
// DO NOT EDIT MANUALLY - Run 'bun run extract-models' to regenerate

// OpenRouter Models - Top Recommended for Development (Priority Order)
export const OPENROUTER_MODELS = [
  "x-ai/grok-code-fast-1",
  "minimax/minimax-m2",
  "google/gemini-2.5-flash",
  "openai/gpt-5",
  "openai/gpt-5.1-codex",
  "qwen/qwen3-vl-235b-a22b-instruct",
  "openrouter/polaris-alpha",
  "custom",
] as const;

export type OpenRouterModel = (typeof OPENROUTER_MODELS)[number];

// CLI Configuration
export interface ClaudishConfig {
  model?: OpenRouterModel | string; // Optional - will prompt if not provided
  port?: number;
  autoApprove: boolean;
  dangerous: boolean;
  interactive: boolean;
  debug: boolean;
  logLevel: "debug" | "info" | "minimal"; // Log verbosity level (default: info)
  quiet: boolean; // Suppress [claudish] log messages (default true in single-shot mode)
  jsonOutput: boolean; // Output in JSON format for tool integration
  monitor: boolean; // Monitor mode - proxy to real Anthropic API and log everything
  stdin: boolean; // Read prompt from stdin instead of args
  openrouterApiKey?: string; // Optional in monitor mode
  anthropicApiKey?: string; // Required in monitor mode
  googleApiKey?: string; // Optional - for direct Gemini API access
  agent?: string; // Agent to use for execution (e.g., "frontend:developer")
  freeOnly?: boolean; // Show only free models in selector
  profile?: string; // Profile name to use for model mapping
  claudeArgs: string[];

  // Model Mapping
  modelOpus?: string;
  modelSonnet?: string;
  modelHaiku?: string;
  modelSubagent?: string;

  // Cost tracking
  costTracking?: boolean;
  auditCosts?: boolean;
  resetCosts?: boolean;

  // Local model optimizations
  summarizeTools?: boolean; // Summarize tool descriptions to reduce prompt size for local models
}

// Anthropic API Types
export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface ContentBlock {
  type: "text" | "image";
  text?: string;
  source?: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  system?: string;
}

export interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: ContentBlock[];
  model: string;
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

// OpenRouter API Types
export interface OpenRouterMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OpenRouterRequest {
  model: string;
  messages: OpenRouterMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
}

export interface OpenRouterResponse {
  id: string;
  model: string;
  choices: Array<{
    message: {
      role: "assistant";
      content: string;
    };
    finish_reason: string | null;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// Proxy Server
export interface ProxyServer {
  port: number;
  url: string;
  shutdown: () => Promise<void>;
}
