/**
 * Transform module for converting between OpenAI and Claude API formats
 * Design document reference: https://github.com/kiyo-e/claude-code-proxy/issues
 * Related classes: src/index.ts - Main proxy service implementation
 */

// OpenAI-specific parameters that Claude doesn't support
const DROP_KEYS = [
  "n",
  "presence_penalty",
  "frequency_penalty",
  "best_of",
  "logit_bias",
  "seed",
  "stream_options",
  "logprobs",
  "top_logprobs",
  "user",
  "response_format",
  "service_tier",
  "parallel_tool_calls",
  "functions",
  "function_call",
  "developer", // o3 developer messages
  "strict", // o3 strict mode for tools
  "reasoning_effort", // o3 reasoning effort parameter
];

interface DroppedParams {
  keys: string[];
}

/**
 * Sanitize root-level parameters from OpenAI to Claude format
 */
export function sanitizeRoot(req: any): DroppedParams {
  const dropped: string[] = [];

  // Rename stop → stop_sequences
  if (req.stop !== undefined) {
    req.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];
    delete req.stop;
  }

  // Convert user → metadata.user_id
  if (req.user) {
    req.metadata = { ...req.metadata, user_id: req.user };
    dropped.push("user");
    delete req.user;
  }

  // Drop all unsupported OpenAI parameters
  for (const key of DROP_KEYS) {
    if (key in req) {
      dropped.push(key);
      delete req[key];
    }
  }

  // Ensure max_tokens is set (Claude requirement)
  if (req.max_tokens == null) {
    req.max_tokens = 4096; // Default max tokens
  }

  return { keys: dropped };
}

/**
 * Map OpenAI tools/functions to Claude tools format
 */
export function mapTools(req: any): void {
  // Combine tools and functions into a unified array
  const openAITools = (req.tools ?? []).concat(
    (req.functions ?? []).map((f: any) => ({
      type: "function",
      function: f,
    }))
  );

  // Convert to Claude tool format
  req.tools = openAITools.map((t: any) => {
    const tool: any = {
      name: t.function?.name ?? t.name,
      description: t.function?.description ?? t.description,
      input_schema: removeUriFormat(t.function?.parameters ?? t.input_schema),
    };

    // Handle o3 strict mode
    if (t.function?.strict === true || t.strict === true) {
      // Claude doesn't have a direct equivalent to strict mode,
      // but we ensure the schema is properly formatted
      if (tool.input_schema) {
        tool.input_schema.additionalProperties = false;
      }
    }

    return tool;
  });

  // Clean up original fields
  delete req.functions;
}

/**
 * Map OpenAI function_call/tool_choice to Claude tool_choice
 */
export function mapToolChoice(req: any): void {
  // Handle both function_call and tool_choice (o3 uses tool_choice)
  const toolChoice = req.tool_choice || req.function_call;

  if (!toolChoice) return;

  // Convert to Claude tool_choice format
  if (typeof toolChoice === "string") {
    // Handle string values: 'auto', 'none', 'required'
    if (toolChoice === "none") {
      req.tool_choice = { type: "none" };
    } else if (toolChoice === "required") {
      req.tool_choice = { type: "any" };
    } else {
      req.tool_choice = { type: "auto" };
    }
  } else if (toolChoice && typeof toolChoice === "object") {
    if (toolChoice.type === "function" && toolChoice.function?.name) {
      // o3 format: {type: 'function', function: {name: 'tool_name'}}
      req.tool_choice = {
        type: "tool",
        name: toolChoice.function.name,
      };
    } else if (toolChoice.name) {
      // Legacy format: {name: 'tool_name'}
      req.tool_choice = {
        type: "tool",
        name: toolChoice.name,
      };
    }
  }

  delete req.function_call;
}

/**
 * Extract text content from various message content formats
 */
function extractTextContent(content: any): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    // Handle array of content blocks
    const textParts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") {
        textParts.push(block);
      } else if (block && typeof block === "object") {
        if (block.type === "text" && block.text) {
          textParts.push(block.text);
        } else if (block.content) {
          textParts.push(extractTextContent(block.content));
        }
      }
    }
    return textParts.join("\n");
  }

  if (content && typeof content === "object") {
    // Handle object content
    if (content.text) {
      return content.text;
    }
    if (content.content) {
      return extractTextContent(content.content);
    }
  }

  // Fallback to JSON stringify for debugging
  return JSON.stringify(content);
}

/**
 * Transform messages from OpenAI to Claude format
 */
export function transformMessages(req: any): void {
  if (!req.messages || !Array.isArray(req.messages)) return;

  const transformedMessages: any[] = [];
  const systemMessages: string[] = [];

  for (const msg of req.messages) {
    // Handle developer messages (o3 specific) - treat as system messages
    if (msg.role === "developer") {
      const content = extractTextContent(msg.content);
      if (content) systemMessages.push(content);
      continue;
    }

    // Extract system messages
    if (msg.role === "system") {
      const content = extractTextContent(msg.content);
      if (content) systemMessages.push(content);
      continue;
    }

    // Handle function role → user role with tool_result
    if (msg.role === "function") {
      transformedMessages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.tool_call_id || msg.name,
            content: msg.content,
          },
        ],
      });
      continue;
    }

    // Handle assistant messages with function_call
    if (msg.role === "assistant" && msg.function_call) {
      const content: any[] = [];

      // Add text content if present
      if (msg.content) {
        content.push({
          type: "text",
          text: msg.content,
        });
      }

      // Add tool_use block
      content.push({
        type: "tool_use",
        id: msg.function_call.id || `call_${Math.random().toString(36).substring(2, 10)}`,
        name: msg.function_call.name,
        input:
          typeof msg.function_call.arguments === "string"
            ? JSON.parse(msg.function_call.arguments)
            : msg.function_call.arguments,
      });

      transformedMessages.push({
        role: "assistant",
        content,
      });
      continue;
    }

    // Handle assistant messages with tool_calls
    if (msg.role === "assistant" && msg.tool_calls) {
      const content: any[] = [];

      // Add text content if present
      if (msg.content) {
        content.push({
          type: "text",
          text: msg.content,
        });
      }

      // Add tool_use blocks
      for (const toolCall of msg.tool_calls) {
        content.push({
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.function.name,
          input:
            typeof toolCall.function.arguments === "string"
              ? JSON.parse(toolCall.function.arguments)
              : toolCall.function.arguments,
        });
      }

      transformedMessages.push({
        role: "assistant",
        content,
      });
      continue;
    }

    // Handle tool role → user role with tool_result
    if (msg.role === "tool") {
      transformedMessages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.tool_call_id,
            content: msg.content,
          },
        ],
      });
      continue;
    }

    // Pass through other messages
    transformedMessages.push(msg);
  }

  // Set system message (Claude takes a single system string, not array)
  if (systemMessages.length > 0) {
    req.system = systemMessages.join("\n\n");
  }

  req.messages = transformedMessages;
}

/**
 * Recursively remove format: 'uri' from JSON schemas
 */
export function removeUriFormat(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;

  // If this is a string type with uri format, remove the format
  if (schema.type === "string" && schema.format === "uri") {
    const { format, ...rest } = schema;
    return rest;
  }

  // Handle array of schemas
  if (Array.isArray(schema)) {
    return schema.map((item) => removeUriFormat(item));
  }

  // Recursively process all properties
  const result: any = {};
  for (const key in schema) {
    if (key === "properties" && typeof schema[key] === "object") {
      result[key] = {};
      for (const propKey in schema[key]) {
        result[key][propKey] = removeUriFormat(schema[key][propKey]);
      }
    } else if (key === "items" && typeof schema[key] === "object") {
      result[key] = removeUriFormat(schema[key]);
    } else if (key === "additionalProperties" && typeof schema[key] === "object") {
      result[key] = removeUriFormat(schema[key]);
    } else if (["anyOf", "allOf", "oneOf"].includes(key) && Array.isArray(schema[key])) {
      result[key] = schema[key].map((item: any) => removeUriFormat(item));
    } else {
      result[key] = removeUriFormat(schema[key]);
    }
  }
  return result;
}

/**
 * Claude Code prepends a billing header to the system prompt as its own text
 * block:
 *
 *   x-anthropic-billing-header: cc_version=2.1.107.3d9; cc_entrypoint=cli; cch=74943;
 *
 * `cch=` is a PER-TURN hash, so the first bytes of a ~31k-token system prompt
 * differ on every single request. Any backend doing prefix caching therefore
 * re-reads the entire prefix each turn. @mtparet measured it against vLLM in
 * #101: 48 tokens cached before, 31,728 after.
 *
 * Stripped HERE rather than in filterIdentity() because filterIdentity is only
 * honoured by the OpenAI-shaped adapters and Gemini. AnthropicApiFormat ignores
 * its filter argument entirely, and CodexAPIFormat assigns `system` straight to
 * `payload.instructions` — so MiniMax, Kimi, GLM, Z.AI, vertex-anthropic, Codex
 * and OllamaCloud would all keep leaking the hash.
 *
 * transformOpenAIToClaude runs once per ComposedHandler request and NEVER for
 * NativeHandler, which is what makes this safe without an `instanceof` guard:
 * native Anthropic traffic keeps the header, and Anthropic is the party the
 * header is actually for.
 */
const BILLING_HEADER_RE = /x-anthropic-billing-header:[^\n]*\n?/gi;

export function stripBillingHeader(text: string): string {
  if (!text || !text.includes("x-anthropic-billing-header")) return text;
  return text.replace(BILLING_HEADER_RE, "");
}

/**
 * Whether a system text block is Claude Code's billing-header block. A
 * predicate, so it never touches the global (stateful) `BILLING_HEADER_RE`:
 * a case-insensitive substring test of the same header name.
 */
export function isBillingHeaderText(text: string): boolean {
  return typeof text === "string" && text.toLowerCase().includes("x-anthropic-billing-header:");
}

/**
 * Main transformation function from OpenAI to Claude format
 */
export function transformOpenAIToClaude(claudeRequestInput: any): {
  claudeRequest: any;
  droppedParams: string[];
} {
  const req = JSON.parse(JSON.stringify(claudeRequestInput));

  if (Array.isArray(req.system)) {
    // Extract text content from each system message item
    req.system = req.system
      .map((item: any) => {
        if (typeof item === "string") {
          return item;
        }
        if (item && typeof item === "object") {
          // Handle content blocks
          if (item.type === "text" && item.text) {
            return item.text;
          }
          if (item.type === "text" && item.content) {
            return item.content;
          }
          if (item.text) {
            return item.text;
          }
          if (item.content) {
            return typeof item.content === "string" ? item.content : JSON.stringify(item.content);
          }
        }
        // Fallback
        return JSON.stringify(item);
      })
      // Strip before the empty-filter below, so a block that held ONLY the
      // billing header is dropped rather than left as an empty string. An
      // empty text block is a 400 on Anthropic-compat endpoints.
      .map((text: string) => stripBillingHeader(text))
      .filter((text: string) => text && text.trim() !== "")
      .join("\n\n");
  } else if (typeof req.system === "string") {
    req.system = stripBillingHeader(req.system);
  }

  if (!Array.isArray(req.messages)) {
    if (req.messages == null) req.messages = [];
    else req.messages = [req.messages];
  }

  if (!Array.isArray(req.tools)) req.tools = [];

  for (const t of req.tools) {
    if (t?.input_schema) {
      t.input_schema = removeUriFormat(t.input_schema);
    }
  }

  const dropped: string[] = [];

  return {
    claudeRequest: req,
    droppedParams: dropped,
  };
}
