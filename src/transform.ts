/**
 * Transform module for converting between OpenAI and Claude API formats
 * Design document reference: https://github.com/kiyo-e/claude-code-proxy/issues
 * Related classes: src/index.ts - Main proxy service implementation
 */

// OpenAI-specific parameters that Claude doesn't support
const DROP_KEYS = [
  'n',
  'presence_penalty',
  'frequency_penalty',
  'best_of',
  'logit_bias',
  'seed',
  'stream_options',
  'logprobs',
  'top_logprobs',
  'user',
  'response_format',
  'service_tier',
  'parallel_tool_calls',
  'functions',
  'function_call',
  'developer',  // o3 developer messages
  'strict',  // o3 strict mode for tools
  'reasoning_effort'  // o3 reasoning effort parameter
]

interface DroppedParams {
  keys: string[]
}

/**
 * Sanitize root-level parameters from OpenAI to Claude format
 */
export function sanitizeRoot(req: any): DroppedParams {
  const dropped: string[] = []
  
  // Rename stop → stop_sequences
  if (req.stop !== undefined) {
    req.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop]
    delete req.stop
    
  }
  
  // Convert user → metadata.user_id
  if (req.user) {
    req.metadata = { ...req.metadata, user_id: req.user }
    dropped.push('user')
    delete req.user
  }
  
  // Drop all unsupported OpenAI parameters
  for (const key of DROP_KEYS) {
    if (key in req) {
      dropped.push(key)
      delete req[key]
    }
  }
  
  // Ensure max_tokens is set (Claude requirement)
  if (req.max_tokens == null) {
    req.max_tokens = 4096 // Default max tokens
  }
  
  return { keys: dropped }
}

/**
 * Map OpenAI tools/functions to Claude tools format
 */
export function mapTools(req: any): void {
  // Combine tools and functions into a unified array
  const openAITools = (req.tools ?? [])
    .concat((req.functions ?? []).map((f: any) => ({
      type: 'function',
      function: f
    })))
  
  // Convert to Claude tool format
  req.tools = openAITools.map((t: any) => {
    const tool: any = {
      name: t.function?.name ?? t.name,
      description: t.function?.description ?? t.description,
      input_schema: removeUriFormat(t.function?.parameters ?? t.input_schema)
    }
    
    // Handle o3 strict mode
    if (t.function?.strict === true || t.strict === true) {
      // Claude doesn't have a direct equivalent to strict mode,
      // but we ensure the schema is properly formatted
      if (tool.input_schema) {
        tool.input_schema.additionalProperties = false
      }
    }
    
    return tool
  })
  
  // Clean up original fields
  delete req.functions
}

/**
 * Map OpenAI function_call/tool_choice to Claude tool_choice
 */
export function mapToolChoice(req: any): void {
  // Handle both function_call and tool_choice (o3 uses tool_choice)
  const toolChoice = req.tool_choice || req.function_call
  
  if (!toolChoice) return
  
  // Convert to Claude tool_choice format
  if (typeof toolChoice === 'string') {
    // Handle string values: 'auto', 'none', 'required'
    if (toolChoice === 'none') {
      req.tool_choice = { type: 'none' }
    } else if (toolChoice === 'required') {
      req.tool_choice = { type: 'any' }
    } else {
      req.tool_choice = { type: 'auto' }
    }
  } else if (toolChoice && typeof toolChoice === 'object') {
    if (toolChoice.type === 'function' && toolChoice.function?.name) {
      // o3 format: {type: 'function', function: {name: 'tool_name'}}
      req.tool_choice = {
        type: 'tool',
        name: toolChoice.function.name
      }
    } else if (toolChoice.name) {
      // Legacy format: {name: 'tool_name'}
      req.tool_choice = {
        type: 'tool',
        name: toolChoice.name
      }
    }
  }
  
  delete req.function_call
}

/**
 * Extract text content from various message content formats
 */
function extractTextContent(content: any): string {
  if (typeof content === 'string') {
    return content
  }
  
  if (Array.isArray(content)) {
    // Handle array of content blocks
    const textParts: string[] = []
    for (const block of content) {
      if (typeof block === 'string') {
        textParts.push(block)
      } else if (block && typeof block === 'object') {
        if (block.type === 'text' && block.text) {
          textParts.push(block.text)
        } else if (block.content) {
          textParts.push(extractTextContent(block.content))
        }
      }
    }
    return textParts.join('\n')
  }
  
  if (content && typeof content === 'object') {
    // Handle object content
    if (content.text) {
      return content.text
    } else if (content.content) {
      return extractTextContent(content.content)
    }
  }
  
  // Fallback to JSON stringify for debugging
  return JSON.stringify(content)
}

/**
 * Transform messages from OpenAI to Claude format
 */
export function transformMessages(req: any): void {
  if (!req.messages || !Array.isArray(req.messages)) return
  
  const transformedMessages: any[] = []
  let systemMessages: string[] = []
  
  for (const msg of req.messages) {
    // Handle developer messages (o3 specific) - treat as system messages
    if (msg.role === 'developer') {
      const content = extractTextContent(msg.content)
      if (content) systemMessages.push(content)
      continue
    }
    
    // Extract system messages
    if (msg.role === 'system') {
      const content = extractTextContent(msg.content)
      if (content) systemMessages.push(content)
      continue
    }
    
    // Handle function role → user role with tool_result
    if (msg.role === 'function') {
      transformedMessages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: msg.tool_call_id || msg.name,
          content: msg.content
        }]
      })
      continue
    }
    
    // Handle assistant messages with function_call
    if (msg.role === 'assistant' && msg.function_call) {
      const content: any[] = []
      
      // Add text content if present
      if (msg.content) {
        content.push({
          type: 'text',
          text: msg.content
        })
      }
      
      // Add tool_use block
      content.push({
        type: 'tool_use',
        id: msg.function_call.id || `call_${Math.random().toString(36).substring(2, 10)}`,
        name: msg.function_call.name,
        input: typeof msg.function_call.arguments === 'string' 
          ? JSON.parse(msg.function_call.arguments)
          : msg.function_call.arguments
      })
      
      transformedMessages.push({
        role: 'assistant',
        content
      })
      continue
    }
    
    // Handle assistant messages with tool_calls
    if (msg.role === 'assistant' && msg.tool_calls) {
      const content: any[] = []
      
      // Add text content if present
      if (msg.content) {
        content.push({
          type: 'text',
          text: msg.content
        })
      }
      
      // Add tool_use blocks
      for (const toolCall of msg.tool_calls) {
        content.push({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.function.name,
          input: typeof toolCall.function.arguments === 'string'
            ? JSON.parse(toolCall.function.arguments)
            : toolCall.function.arguments
        })
      }
      
      transformedMessages.push({
        role: 'assistant',
        content
      })
      continue
    }
    
    // Handle tool role → user role with tool_result
    if (msg.role === 'tool') {
      transformedMessages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: msg.tool_call_id,
          content: msg.content
        }]
      })
      continue
    }
    
    // Pass through other messages
    transformedMessages.push(msg)
  }
  
  // Set system message (Claude takes a single system string, not array)
  if (systemMessages.length > 0) {
    req.system = systemMessages.join('\n\n')
  }
  
  req.messages = transformedMessages
}

/**
 * Recursively remove format: 'uri' from JSON schemas
 */
export function removeUriFormat(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema
  
  // If this is a string type with uri format, remove the format
  if (schema.type === 'string' && schema.format === 'uri') {
    const { format, ...rest } = schema
    return rest
  }
  
  // Handle array of schemas
  if (Array.isArray(schema)) {
    return schema.map(item => removeUriFormat(item))
  }
  
  // Recursively process all properties
  const result: any = {}
  for (const key in schema) {
    if (key === 'properties' && typeof schema[key] === 'object') {
      result[key] = {}
      for (const propKey in schema[key]) {
        result[key][propKey] = removeUriFormat(schema[key][propKey])
      }
    } else if (key === 'items' && typeof schema[key] === 'object') {
      result[key] = removeUriFormat(schema[key])
    } else if (key === 'additionalProperties' && typeof schema[key] === 'object') {
      result[key] = removeUriFormat(schema[key])
    } else if (['anyOf', 'allOf', 'oneOf'].includes(key) && Array.isArray(schema[key])) {
      result[key] = schema[key].map((item: any) => removeUriFormat(item))
    } else {
      result[key] = removeUriFormat(schema[key])
    }
  }
  return result
}

/**
 * Main transformation function from OpenAI to Claude format
 */
export function transformOpenAIToClaude(claudeRequestInput: any): { claudeRequest: any, droppedParams: string[], isO3Model?: boolean } {
  const req = JSON.parse(JSON.stringify(claudeRequestInput))
  const isO3Model = typeof req.model === 'string' && (req.model.includes('o3') || req.model.includes('o1'))

  if (Array.isArray(req.system)) {
    // Extract text content from each system message item
    req.system = req.system
      .map((item: any) => {
        if (typeof item === 'string') {
          return item
        } else if (item && typeof item === 'object') {
          // Handle content blocks
          if (item.type === 'text' && item.text) {
            return item.text
          } else if (item.type === 'text' && item.content) {
            return item.content
          } else if (item.text) {
            return item.text
          } else if (item.content) {
            return typeof item.content === 'string' ? item.content : JSON.stringify(item.content)
          }
        }
        // Fallback
        return JSON.stringify(item)
      })
      .filter((text: string) => text && text.trim() !== '')
      .join('\n\n')
  }

  if (!Array.isArray(req.messages)) {
    if (req.messages == null) req.messages = []
    else req.messages = [req.messages]
  }

  if (!Array.isArray(req.tools)) req.tools = []

  for (const t of req.tools) {
    if (t && t.input_schema) {
      t.input_schema = removeUriFormat(t.input_schema)
    }
  }

  const dropped: string[] = []

  return {
    claudeRequest: req,
    droppedParams: dropped,
    isO3Model
  }
}

/**
 * Clean JSON Schema for Gemini API compatibility
 * Gemini doesn't support certain JSON Schema validation fields
 */
function cleanSchemaForGemini(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema

  if (Array.isArray(schema)) {
    return schema.map(item => cleanSchemaForGemini(item))
  }

  const UNSUPPORTED_FIELDS = [
    '$schema',
    'additionalProperties',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
    'patternProperties',
    'dependencies',
    'const',
    'if',
    'then',
    'else',
    'allOf',
    'anyOf',
    'oneOf',
    'not'
  ]

  const cleaned: any = {}
  for (const key in schema) {
    if (UNSUPPORTED_FIELDS.includes(key)) {
      continue
    }

    if (key === 'properties' && typeof schema[key] === 'object') {
      cleaned[key] = {}
      for (const propKey in schema[key]) {
        cleaned[key][propKey] = cleanSchemaForGemini(schema[key][propKey])
      }
    } else if (key === 'items' && typeof schema[key] === 'object') {
      cleaned[key] = cleanSchemaForGemini(schema[key])
    } else if (typeof schema[key] === 'object' && !Array.isArray(schema[key])) {
      cleaned[key] = cleanSchemaForGemini(schema[key])
    } else if (Array.isArray(schema[key])) {
      cleaned[key] = schema[key].map((item: any) =>
        typeof item === 'object' ? cleanSchemaForGemini(item) : item
      )
    } else {
      cleaned[key] = schema[key]
    }
  }

  return cleaned
}

/**
 * Transform Claude format to Gemini's native format
 * Gemini uses a different structure: contents array with parts, generationConfig, etc.
 */
export function transformClaudeToGemini(claudePayload: any, modelId: string): { geminiPayload: any, claudeRequest: any } {
  const claudeRequest = claudePayload;
  const geminiPayload: any = {
    contents: [],
    generationConfig: {},
  };

  // Add system instruction (Gemini supports this at the root level)
  if (claudeRequest.system) {
    let systemContent = claudeRequest.system;
    if (Array.isArray(systemContent)) {
      systemContent = systemContent.map((i: any) => i.text || i).join("\n\n");
    }
    geminiPayload.systemInstruction = {
      parts: [{ text: systemContent }]
    };
  }

  // Convert messages to Gemini's contents format
  if (claudeRequest.messages && Array.isArray(claudeRequest.messages)) {
    for (const msg of claudeRequest.messages) {
      const geminiMessage: any = {
        role: msg.role === "assistant" ? "model" : msg.role,
        parts: [],
      };

      // Handle message content
      if (typeof msg.content === "string") {
        geminiMessage.parts.push({ text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text") {
            geminiMessage.parts.push({ text: block.text });
          } else if (block.type === "image") {
            // Convert Claude image format to Gemini format
            geminiMessage.parts.push({
              inlineData: {
                mimeType: block.source.media_type || "image/png",
                data: block.source.data,
              },
            });
          } else if (block.type === "tool_use") {
            // Gemini uses functionCall format
            // Extract thought_signature from tool ID if present (format: toolu_xxx__ts_base64sig)
            const part: any = {
              functionCall: {
                name: block.name,
                args: block.input,
              }
            };

            if (block.id && block.id.includes('__ts_')) {
              const [, sigEncoded] = block.id.split('__ts_');
              if (sigEncoded) {
                try {
                  // Decode the thought_signature from URL encoding
                  // IMPORTANT: preserve exactly as received
                  // thoughtSignature goes at the SAME LEVEL as functionCall, not inside it
                  const thoughtSignature = decodeURIComponent(sigEncoded);
                  part.thoughtSignature = thoughtSignature;
                } catch (e) {
                  // Silently ignore decode errors
                }
              }
            }

            geminiMessage.parts.push(part);
          } else if (block.type === "tool_result") {
            // Tool results go in a separate message
            geminiPayload.contents.push({
              role: "function",
              parts: [{
                functionResponse: {
                  name: block.tool_use_id,
                  response: {
                    content: typeof block.content === "string" ? block.content : JSON.stringify(block.content),
                  },
                },
              }],
            });
            continue;
          }
        }
      }

      if (geminiMessage.parts.length > 0) {
        geminiPayload.contents.push(geminiMessage);
      }
    }
  }

  // Convert generation parameters
  if (claudeRequest.temperature !== undefined) {
    geminiPayload.generationConfig.temperature = claudeRequest.temperature;
  }
  if (claudeRequest.max_tokens !== undefined) {
    geminiPayload.generationConfig.maxOutputTokens = claudeRequest.max_tokens;
  }
  if (claudeRequest.stop_sequences && Array.isArray(claudeRequest.stop_sequences)) {
    geminiPayload.generationConfig.stopSequences = claudeRequest.stop_sequences;
  }
  if (claudeRequest.top_p !== undefined) {
    geminiPayload.generationConfig.topP = claudeRequest.top_p;
  }
  if (claudeRequest.top_k !== undefined) {
    geminiPayload.generationConfig.topK = claudeRequest.top_k;
  }

  // Convert tools to Gemini's functionDeclarations format
  if (claudeRequest.tools && Array.isArray(claudeRequest.tools)) {
    geminiPayload.tools = [{
      functionDeclarations: claudeRequest.tools.map((tool: any) => ({
        name: tool.name,
        description: tool.description,
        parameters: cleanSchemaForGemini(tool.input_schema),
      })),
    }];
  }

  // Handle thinking/reasoning config
  if (claudeRequest.thinking) {
    const { budget_tokens } = claudeRequest.thinking;
    if (modelId.includes("gemini-3")) {
      const level = budget_tokens >= 16000 ? "high" : "low";
      geminiPayload.generationConfig.thinkingConfig = {
        thinkingLevel: level
      };
    } else {
      geminiPayload.generationConfig.thinking_config = {
        thinking_budget: Math.min(budget_tokens, 24576),
      };
    }
  }

  return { geminiPayload, claudeRequest };
}

/**
 * Transform a Gemini streaming chunk to Claude format
 * (This is handled inline in the GeminiHandler for better control)
 */
export function transformGeminiChunkToClaude(geminiChunk: any): any {
  // This function is provided for completeness but the actual transformation
  // is done in GeminiHandler.handleStreamingResponse() for better streaming control
  return geminiChunk;
}