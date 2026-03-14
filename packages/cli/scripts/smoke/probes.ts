/**
 * Smoke test probe implementations.
 *
 * Three probes: tool calling, reasoning, vision.
 * Each returns a ProbeResult and uses AbortSignal for timeout.
 */

import type {
  SmokeProviderConfig,
  ProbeResult,
  ProbeFn,
  AnthropicResponse,
  OpenAIResponse,
} from "./types.js";

// 32x32 solid red PNG, base64-encoded (no filesystem dependency)
// 1x1 is rejected by many providers as too small
const TEST_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==";
const TEST_IMAGE_MEDIA_TYPE = "image/png";

// Error phrases that indicate vision is not supported
const VISION_ERROR_PHRASES = [
  "not support",
  "cannot process",
  "unable to analyze",
  "does not support image",
  "image type not supported",
  "cannot view image",
  "cannot see image",
];

/**
 * Determine if a model ID indicates a reasoning/thinking model.
 */
function isReasoningModel(modelId: string): boolean {
  return /\br1\b|qwq|thinking|o1(?:[-/]|\b)|reasoning/i.test(modelId);
}

/**
 * Build auth headers based on the provider's auth scheme.
 */
function buildHeaders(config: SmokeProviderConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...config.extraHeaders,
  };

  switch (config.authScheme) {
    case "x-api-key":
      headers["x-api-key"] = config.apiKey;
      headers["anthropic-version"] = "2023-06-01";
      break;
    case "bearer":
      headers["Authorization"] = `Bearer ${config.apiKey}`;
      headers["anthropic-version"] = "2023-06-01";
      break;
    case "openai":
      headers["Authorization"] = `Bearer ${config.apiKey}`;
      break;
  }

  return headers;
}

/**
 * Make an HTTP POST to the provider and return the parsed JSON response.
 * Throws on non-2xx status codes.
 */
export async function callProvider(
  config: SmokeProviderConfig,
  body: Record<string, unknown>,
  signal: AbortSignal
): Promise<unknown> {
  const url = config.baseUrl + config.apiPath;
  const headers = buildHeaders(config);

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  return response.json();
}

/**
 * Wrap a probe function with timeout and error handling.
 */
export async function runProbe(
  capability: ProbeResult["capability"],
  fn: ProbeFn,
  config: SmokeProviderConfig,
  timeoutMs = 30_000
): Promise<ProbeResult> {
  const controller = new AbortController();
  const t0 = Date.now();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const result = await fn(config, controller.signal);
    return result;
  } catch (err: unknown) {
    const elapsed = Date.now() - t0;
    const error = err as { name?: string; message?: string };
    if (error.name === "AbortError") {
      return {
        capability,
        status: "fail",
        durationMs: timeoutMs,
        reason: `timeout after ${timeoutMs}ms`,
      };
    }
    return {
      capability,
      status: "fail",
      durationMs: elapsed,
      reason: error.message ?? String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────
// Probe 1: Tool Calling
// ─────────────────────────────────────────────────────────────

export const runToolCallingProbe: ProbeFn = async (
  config: SmokeProviderConfig,
  signal: AbortSignal
): Promise<ProbeResult> => {
  const t0 = Date.now();

  if (!config.capabilities.supportsTools) {
    return {
      capability: "tool_calling",
      status: "skip",
      durationMs: 0,
      reason: "provider does not support tools",
    };
  }

  let body: Record<string, unknown>;

  if (config.wireFormat === "anthropic-compat") {
    body = {
      model: config.representativeModel,
      max_tokens: 256,
      stream: false,
      system: "You are a helpful assistant. When asked about weather, use the get_weather tool.",
      messages: [{ role: "user", content: "What's the weather in Tokyo?" }],
      tools: [
        {
          name: "get_weather",
          description: "Get current weather for a city",
          input_schema: {
            type: "object",
            properties: {
              city: { type: "string", description: "City name" },
            },
            required: ["city"],
          },
        },
      ],
    };
  } else {
    body = {
      model: config.representativeModel,
      max_tokens: 256,
      stream: false,
      messages: [
        {
          role: "system",
          content:
            "You are a helpful assistant. When asked about weather, use the get_weather tool.",
        },
        { role: "user", content: "What's the weather in Tokyo?" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get current weather for a city",
            parameters: {
              type: "object",
              properties: {
                city: { type: "string", description: "City name" },
              },
              required: ["city"],
            },
          },
        },
      ],
      tool_choice: "auto",
    };
  }

  const raw = await callProvider(config, body, signal);
  const elapsed = Date.now() - t0;

  if (config.wireFormat === "anthropic-compat") {
    const resp = raw as AnthropicResponse;
    const toolBlock = resp.content?.find((b) => b.type === "tool_use") as
      | { type: "tool_use"; name: string; input: Record<string, unknown> }
      | undefined;

    if (
      resp.stop_reason === "tool_use" &&
      toolBlock &&
      toolBlock.name === "get_weather" &&
      toolBlock.input &&
      Object.keys(toolBlock.input).length > 0
    ) {
      return {
        capability: "tool_calling",
        status: "pass",
        durationMs: elapsed,
        reason: "tool_use detected",
        excerpt: `tool: ${toolBlock.name}, input: ${JSON.stringify(toolBlock.input).slice(0, 100)}`,
      };
    }

    return {
      capability: "tool_calling",
      status: "fail",
      durationMs: elapsed,
      reason: `no tool_use block (stop_reason was: ${resp.stop_reason})`,
      excerpt: JSON.stringify(resp.content).slice(0, 200),
    };
  } else {
    const resp = raw as OpenAIResponse;
    const choice = resp.choices?.[0];
    const toolCalls = choice?.message?.tool_calls;

    // Some providers (e.g. opencode-zen) return finish_reason: null even when
    // tool_calls is present. Check tool_calls presence first; finish_reason is
    // informational only.
    if (
      toolCalls &&
      toolCalls.length > 0 &&
      toolCalls[0].function.name === "get_weather" &&
      toolCalls[0].function.arguments.length > 0
    ) {
      return {
        capability: "tool_calling",
        status: "pass",
        durationMs: elapsed,
        reason: "tool_calls detected",
        excerpt: `tool: ${toolCalls[0].function.name}, args: ${toolCalls[0].function.arguments.slice(0, 100)}`,
      };
    }

    return {
      capability: "tool_calling",
      status: "fail",
      durationMs: elapsed,
      reason: `no tool_calls (finish_reason was: ${choice?.finish_reason ?? "unknown"})`,
      excerpt: JSON.stringify(choice?.message).slice(0, 200),
    };
  }
};

// ─────────────────────────────────────────────────────────────
// Probe 2: Reasoning
// ─────────────────────────────────────────────────────────────

export const runReasoningProbe: ProbeFn = async (
  config: SmokeProviderConfig,
  signal: AbortSignal
): Promise<ProbeResult> => {
  const t0 = Date.now();

  let body: Record<string, unknown>;

  if (config.wireFormat === "anthropic-compat") {
    body = {
      model: config.representativeModel,
      max_tokens: 512,
      stream: false,
      system: "You are a helpful math assistant.",
      messages: [{ role: "user", content: "What is 17 × 23? Show your reasoning step by step." }],
    };
  } else {
    body = {
      model: config.representativeModel,
      max_tokens: 512,
      stream: false,
      messages: [
        { role: "system", content: "You are a helpful math assistant." },
        { role: "user", content: "What is 17 × 23? Show your reasoning step by step." },
      ],
    };
  }

  const raw = await callProvider(config, body, signal);
  const elapsed = Date.now() - t0;
  const isReasoning = isReasoningModel(config.representativeModel);

  if (config.wireFormat === "anthropic-compat") {
    const resp = raw as AnthropicResponse;
    const thinkingBlock = resp.content?.find((b) => b.type === "thinking") as
      | { type: "thinking"; thinking: string }
      | undefined;
    const textBlock = resp.content?.find((b) => b.type === "text") as
      | { type: "text"; text: string }
      | undefined;

    if (isReasoning) {
      if (thinkingBlock && thinkingBlock.thinking.length > 0) {
        return {
          capability: "reasoning",
          status: "pass",
          durationMs: elapsed,
          reason: "thinking tokens detected",
          excerpt: thinkingBlock.thinking.slice(0, 200),
        };
      }
      if (textBlock && textBlock.text.length > 0) {
        return {
          capability: "reasoning",
          status: "pass",
          durationMs: elapsed,
          reason: "text response (reasoning not surfaced as tokens)",
          excerpt: textBlock.text.slice(0, 200),
        };
      }
      return {
        capability: "reasoning",
        status: "fail",
        durationMs: elapsed,
        reason: "no thinking block and no text response",
      };
    }

    // Non-reasoning model: any non-empty text response is a pass
    if (textBlock && textBlock.text.length > 0) {
      return {
        capability: "reasoning",
        status: "pass",
        durationMs: elapsed,
        excerpt: textBlock.text.slice(0, 200),
      };
    }
    return {
      capability: "reasoning",
      status: "fail",
      durationMs: elapsed,
      reason: "empty response",
    };
  } else {
    const resp = raw as OpenAIResponse;
    const msg = resp.choices?.[0]?.message;

    if (!msg) {
      return {
        capability: "reasoning",
        status: "fail",
        durationMs: elapsed,
        reason: "no choices in response",
      };
    }

    if (isReasoning) {
      if (msg.reasoning_content && msg.reasoning_content.length > 0) {
        return {
          capability: "reasoning",
          status: "pass",
          durationMs: elapsed,
          reason: "reasoning_content tokens detected",
          excerpt: msg.reasoning_content.slice(0, 200),
        };
      }
      if (msg.content && msg.content.length > 0) {
        return {
          capability: "reasoning",
          status: "pass",
          durationMs: elapsed,
          reason: "text response (reasoning not surfaced as tokens)",
          excerpt: msg.content.slice(0, 200),
        };
      }
      return {
        capability: "reasoning",
        status: "fail",
        durationMs: elapsed,
        reason: "empty response for reasoning model",
      };
    }

    // Non-reasoning model: any non-empty content is a pass
    if (msg.content && msg.content.length > 0) {
      return {
        capability: "reasoning",
        status: "pass",
        durationMs: elapsed,
        excerpt: msg.content.slice(0, 200),
      };
    }
    return {
      capability: "reasoning",
      status: "fail",
      durationMs: elapsed,
      reason: "empty response",
    };
  }
};

// ─────────────────────────────────────────────────────────────
// Probe 3: Vision
// ─────────────────────────────────────────────────────────────

export const runVisionProbe: ProbeFn = async (
  config: SmokeProviderConfig,
  signal: AbortSignal
): Promise<ProbeResult> => {
  const t0 = Date.now();

  if (!config.capabilities.supportsVision) {
    return {
      capability: "vision",
      status: "skip",
      durationMs: 0,
      reason: "provider does not support vision",
    };
  }

  let body: Record<string, unknown>;

  if (config.wireFormat === "anthropic-compat") {
    body = {
      model: config.representativeModel,
      max_tokens: 128,
      stream: false,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: TEST_IMAGE_MEDIA_TYPE,
                data: TEST_IMAGE_BASE64,
              },
            },
            {
              type: "text",
              text: "Describe what you see in this image in one sentence.",
            },
          ],
        },
      ],
    };
  } else {
    body = {
      model: config.representativeModel,
      max_tokens: 128,
      stream: false,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: {
                url: `data:${TEST_IMAGE_MEDIA_TYPE};base64,${TEST_IMAGE_BASE64}`,
              },
            },
            {
              type: "text",
              text: "Describe what you see in this image in one sentence.",
            },
          ],
        },
      ],
    };
  }

  const raw = await callProvider(config, body, signal);
  const elapsed = Date.now() - t0;

  // Extract text content from the response
  let textContent = "";
  if (config.wireFormat === "anthropic-compat") {
    const resp = raw as AnthropicResponse;
    const textBlock = resp.content?.find((b) => b.type === "text") as
      | { type: "text"; text: string }
      | undefined;
    textContent = textBlock?.text ?? "";
  } else {
    const resp = raw as OpenAIResponse;
    textContent = resp.choices?.[0]?.message?.content ?? "";
  }

  if (!textContent) {
    return {
      capability: "vision",
      status: "fail",
      durationMs: elapsed,
      reason: "empty response",
    };
  }

  // Check for error phrases indicating vision is not supported
  const lowerText = textContent.toLowerCase();
  for (const phrase of VISION_ERROR_PHRASES) {
    if (lowerText.includes(phrase)) {
      return {
        capability: "vision",
        status: "fail",
        durationMs: elapsed,
        reason: `vision error phrase detected: "${phrase}"`,
        excerpt: textContent.slice(0, 200),
      };
    }
  }

  return {
    capability: "vision",
    status: "pass",
    durationMs: elapsed,
    excerpt: textContent.slice(0, 200),
  };
};
