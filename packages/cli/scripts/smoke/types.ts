/**
 * Smoke test types and interfaces
 */

// Wire format classification
export type WireFormat = "anthropic-compat" | "openai-compat" | "ollama";

// Capability probe identifiers
export type Capability = "tool_calling" | "reasoning" | "vision";

// Per-probe outcome
export type ProbeStatus = "pass" | "fail" | "skip";

export interface ProbeResult {
  capability: Capability;
  status: ProbeStatus;
  durationMs: number;
  /** Human-readable reason for fail or skip */
  reason?: string;
  /** Raw response excerpt (first 200 chars of content) for debugging */
  excerpt?: string;
}

export interface ProviderResult {
  provider: string;
  model: string;
  wireFormat: WireFormat;
  timestamp: string;
  probes: ProbeResult[];
}

export interface SmokeRunResult {
  runId: string;
  timestamp: string;
  durationMs: number;
  providers: ProviderResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
  };
}

// Config for a provider as understood by the smoke runner
export interface SmokeProviderConfig {
  name: string;
  baseUrl: string;
  apiPath: string;
  apiKey: string;
  authScheme: "x-api-key" | "bearer" | "openai";
  extraHeaders: Record<string, string>;
  wireFormat: WireFormat;
  representativeModel: string;
  capabilities: {
    supportsTools: boolean;
    supportsVision: boolean;
    supportsReasoning: boolean;
  };
}

// Probe function signature
export type ProbeFn = (config: SmokeProviderConfig, signal: AbortSignal) => Promise<ProbeResult>;

// Anthropic-compat raw response shape (subset)
export interface AnthropicResponse {
  id: string;
  stop_reason: "tool_use" | "end_turn" | "max_tokens" | string;
  content: Array<
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  >;
}

// Ollama raw response shape (subset)
export interface OllamaResponse {
  model: string;
  message: {
    role: string;
    content: string;
    tool_calls?: Array<{
      id?: string;
      function: {
        name: string;
        arguments: Record<string, unknown>;
      };
    }>;
  };
  done: boolean;
  done_reason?: string;
}

// OpenAI-compat raw response shape (subset)
export interface OpenAIResponse {
  id: string;
  choices: Array<{
    finish_reason: "tool_calls" | "stop" | "length" | string;
    message: {
      role: string;
      content: string | null;
      reasoning_content?: string;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
  }>;
}
