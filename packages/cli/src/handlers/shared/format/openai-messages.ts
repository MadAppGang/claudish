/**
 * OpenAI message format conversion utilities.
 *
 * Converts Claude/Anthropic message format to OpenAI message format.
 */

/**
 * Convert Claude/Anthropic messages to OpenAI format
 * @param simpleFormat - If true, use simple string content only (for MLX and other basic providers)
 * @param reasoningRoundtrip - If true, emit reasoning_content on EVERY assistant message
 *   (empty string when no thinking block). DeepSeek rejects with HTTP 400 "The reasoning_content
 *   in the thinking mode must be passed back to the API" when a conversation in thinking mode
 *   has recent assistant messages without the field — including tool_use-only turns that never
 *   carried a thinking block. Empty string satisfies the presence check.
 */
export function convertMessagesToOpenAI(
  req: any,
  modelId: string,
  filterIdentityFn?: (s: string) => string,
  simpleFormat = false,
  reasoningRoundtrip = false
): any[] {
  const messages: any[] = [];

  if (req.system) {
    let content = Array.isArray(req.system)
      ? req.system.map((i: any) => i.text || i).join("\n\n")
      : req.system;
    if (filterIdentityFn) content = filterIdentityFn(content);
    messages.push({ role: "system", content });
  }

  // Add instruction for Grok models to use proper tool format
  if (modelId.includes("grok") || modelId.includes("x-ai")) {
    const msg =
      "IMPORTANT: When calling tools, you MUST use the OpenAI tool_calls format with JSON. NEVER use XML format like <xai:function_call>.";
    if (messages.length > 0 && messages[0].role === "system") {
      messages[0].content += "\n\n" + msg;
    } else {
      messages.unshift({ role: "system", content: msg });
    }
  }

  if (req.messages) {
    for (const msg of req.messages) {
      if (msg.role === "user") processUserMessage(msg, messages, simpleFormat);
      else if (msg.role === "assistant") processAssistantMessage(msg, messages, simpleFormat, reasoningRoundtrip);
      else if (msg.role === "system") {
        // Inline system messages (Claude Code v2.1.153+): merge into the system prompt
        // or prepend as a user message if no system prompt exists.
        const content = typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.map((c: any) => c.text || "").join("\n")
            : "";
        if (content) {
          if (messages.length > 0 && messages[0].role === "system") {
            messages[0].content += "\n\n" + content;
          } else {
            messages.unshift({ role: "system", content });
          }
        }
      }
    }
  }

  return messages;
}

function processUserMessage(msg: any, messages: any[], simpleFormat = false) {
  if (Array.isArray(msg.content)) {
    const textParts: string[] = [];
    const contentParts: any[] = [];
    const toolResults: any[] = [];
    const seen = new Set<string>();

    for (const block of msg.content) {
      if (block.type === "text") {
        textParts.push(block.text);
        if (!simpleFormat) {
          contentParts.push({ type: "text", text: block.text });
        }
      } else if (block.type === "image") {
        if (!simpleFormat) {
          contentParts.push({
            type: "image_url",
            image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
          });
        }
        // Skip images in simple format - MLX doesn't support vision
      } else if (block.type === "tool_result") {
        if (seen.has(block.tool_use_id)) continue;
        seen.add(block.tool_use_id);
        const resultContent =
          typeof block.content === "string" ? block.content : JSON.stringify(block.content);
        if (simpleFormat) {
          // In simple format, include tool results as text in user message
          textParts.push(`[Tool Result]: ${resultContent}`);
        } else {
          toolResults.push({
            role: "tool",
            content: resultContent,
            tool_call_id: block.tool_use_id,
          });
        }
      }
    }

    if (simpleFormat) {
      // Simple format: just concatenate all text
      if (textParts.length) {
        messages.push({ role: "user", content: textParts.join("\n\n") });
      }
    } else {
      if (toolResults.length) messages.push(...toolResults);
      if (contentParts.length) messages.push({ role: "user", content: contentParts });
    }
  } else {
    messages.push({ role: "user", content: msg.content });
  }
}

function processAssistantMessage(msg: any, messages: any[], simpleFormat = false, reasoningRoundtrip = false) {
  if (Array.isArray(msg.content)) {
    const strings: string[] = [];
    const toolCalls: any[] = [];
    const seen = new Set<string>();
    let reasoningContent = "";
    let hasThinking = false;

    for (const block of msg.content) {
      if (block.type === "text") {
        strings.push(block.text);
      } else if (block.type === "thinking") {
        // Accumulate thinking content to send back as reasoning_content.
        // Track presence regardless of content — Kimi K2.5 requires the field
        // even when the thinking text is empty.
        // Skip in simpleFormat (same as tool calls).
        if (!simpleFormat) {
          hasThinking = true;
          reasoningContent += block.thinking || "";
        }
      } else if (block.type === "tool_use") {
        if (seen.has(block.id)) continue;
        seen.add(block.id);
        if (simpleFormat) {
          // In simple format, include tool calls as text
          strings.push(`[Tool Call: ${block.name}]: ${JSON.stringify(block.input)}`);
        } else {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: JSON.stringify(block.input) },
          });
        }
      }
    }

    if (simpleFormat) {
      // Simple format: just string content, no tool_calls
      if (strings.length) {
        messages.push({ role: "assistant", content: strings.join("\n") });
      }
    } else {
      const m: any = { role: "assistant" };
      if (strings.length) m.content = strings.join(" ");
      else if (toolCalls.length) m.content = null;
      if (toolCalls.length) m.tool_calls = toolCalls;
      // Include reasoning_content whenever ANY thinking block was present,
      // even if the concatenated text is empty — Kimi K2.5 rejects turn 2+
      // with HTTP 400 if the field is missing after thinking was active.
      // With reasoningRoundtrip (DeepSeek), emit on every assistant message —
      // even tool_use-only turns with no thinking block — because DeepSeek
      // requires the field on recent assistant messages of a thinking-mode
      // conversation (empty string satisfies the presence check).
      if (hasThinking || reasoningRoundtrip) m.reasoning_content = reasoningContent;
      if (m.content !== undefined || m.tool_calls) messages.push(m);
    }
  } else {
    messages.push({ role: "assistant", content: msg.content });
  }
}

/**
 * Remove `reasoning_content` from already-converted OpenAI messages, in place.
 * Returns how many messages were changed.
 *
 * The counterpart to the emission in processAssistantMessage: that one writes
 * the field whenever a thinking block is present in history, which is right for
 * backends that require it (DeepSeek) or tolerate it (GLM, Kimi) and wrong for
 * ones that validate their body strictly. Mistral answers HTTP 422
 * `extra_forbidden` on `body.messages[N].assistant.reasoning_content`, which
 * fails every turn of a real thinking-mode conversation.
 *
 * This exists as a separate pass rather than a condition on the emitter because
 * the two needs genuinely conflict: Kimi K2.5 requires the field on turn 2+ of a
 * thinking conversation without opting into preserveThinkingInHistory(), so the
 * emitter cannot be gated on that capability alone.
 *
 * Note it cannot be folded into ComposedHandler's thinking-block strip either:
 * that one filters `type:"thinking"` blocks out of message content arrays, but
 * by this point the OpenAI conversion has flattened content to a string and
 * hoisted the reasoning into a sibling scalar — a block filter can never see it.
 */
export function stripReasoningContent(messages: any[]): number {
  if (!Array.isArray(messages)) return 0;
  let dropped = 0;
  for (const msg of messages) {
    if (msg && typeof msg === "object" && "reasoning_content" in msg) {
      delete msg.reasoning_content;
      dropped++;
    }
  }
  return dropped;
}
