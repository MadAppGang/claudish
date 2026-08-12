/**
 * OpenAI → Anthropic request conversion.
 *
 * The mirror of `openai-messages.ts` (which goes Anthropic → OpenAI for upstream
 * providers). This module sits at the *ingress* edge: an OpenAI-compatible
 * client (sk-agent, any `AsyncOpenAI` consumer) POSTs to `/v1/chat/completions`,
 * and we translate its body into the Anthropic shape that the rest of the
 * pipeline (`getHandlerForRequest` → `ComposedHandler.handle`) already speaks.
 * Reusing that pipeline is the whole point: the OpenAI client inherits the
 * routing cascade, budget failover, accounting, and leak policy for free.
 *
 * References the mapping logic of the dormant `transform.ts` primitives
 * (`sanitizeRoot`, `mapTools`, `mapToolChoice`, `transformMessages`) for
 * consistency, but is self-contained and tested — those primitives were never
 * wired to a live path and coupling a new critical client surface to untested
 * internals is the wrong risk.
 *
 * Never throws: a malformed OpenAI body degrades to a best-effort Anthropic
 * body rather than killing the request (never-hang priority).
 */

/** Anthropic image source. */
function imageSourceFromImageUrl(url: string): any {
  // data:[<mediatype>][;base64],<data>
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
  if (m) {
    return {
      type: "base64",
      media_type: m[1] || "image/png",
      data: m[3] ?? "",
    };
  }
  // Plain URL — Anthropic accepts a `url` source for URL-reachable images.
  return { type: "url", url };
}

/** Parse a tool-call arguments payload (OpenAI sends it stringified). Never throws. */
function parseArguments(raw: unknown): any {
  if (raw == null) return {};
  if (typeof raw === "object") return raw;
  if (typeof raw !== "string") return {};
  try {
    return JSON.parse(raw);
  } catch {
    // Partial/malformed JSON (rare, but a streaming accumulator could land here).
    return {};
  }
}

/** Convert an OpenAI content part (or string) to Anthropic content blocks. */
function openAIContentToBlocks(content: any): any[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];

  const blocks: any[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      if (part) blocks.push({ type: "text", text: part });
      continue;
    }
    if (!part || typeof part !== "object") continue;
    if (part.type === "text") {
      if (part.text) blocks.push({ type: "text", text: part.text });
    } else if (part.type === "image_url" && part.image_url?.url) {
      blocks.push({ type: "image", source: imageSourceFromImageUrl(part.image_url.url) });
    } else if (part.type === "input_text" && part.text) {
      // Some newer OpenAI reasoning schemas use input_text.
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "input_image" && part.image_url) {
      blocks.push({ type: "image", source: imageSourceFromImageUrl(part.image_url) });
    }
    // Unknown part types are dropped rather than corrupting the Anthropic body.
  }
  return blocks;
}

/** Extract flat text from an OpenAI message content (for system extraction). */
function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p: any) => (typeof p === "string" ? p : p?.text ?? ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** Map an OpenAI tool_choice to the Anthropic tool_choice shape. */
function mapToolChoice(tc: any): any | undefined {
  if (tc == null) return undefined;
  if (typeof tc === "string") {
    if (tc === "none") return { type: "none" };
    if (tc === "required") return { type: "any" };
    return { type: "auto" }; // "auto" and unknown → auto
  }
  if (typeof tc === "object") {
    // OpenAI: {type:"function", function:{name}} — also handle legacy function_call.
    const name = tc.function?.name ?? tc.name;
    if (name) return { type: "tool", name };
  }
  return undefined;
}

/** Map OpenAI function tools to Anthropic tool definitions. */
function mapTools(tools: any[] | undefined): any[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const out: any[] = [];
  for (const t of tools) {
    const fn = t?.function ?? (t?.type === "function" ? t : null);
    // Legacy `functions[]` entries (no wrapper) — tolerate.
    const def = fn ?? t;
    if (!def?.name) continue;
    const tool: any = {
      name: def.name,
      description: def.description ?? "",
      input_schema: def.parameters ?? { type: "object", properties: {} },
    };
    if (def.strict === true || t?.strict === true) {
      tool.input_schema = { ...tool.input_schema, additionalProperties: false };
    }
    out.push(tool);
  }
  return out.length ? out : undefined;
}

/**
 * Convert an OpenAI `/v1/chat/completions` request body to the Anthropic
 * `/v1/messages` request shape. Returns a fresh object; the input is untouched.
 */
export function convertOpenAIRequestToAnthropic(openai: any): any {
  const src = openai ?? {};
  const out: any = {};

  // Model + stream pass straight through — `getHandlerForRequest` does all
  // provider/role resolution on the model string.
  out.model = src.model;
  if (src.stream === true) out.stream = true;

  // System / developer messages → top-level `system` (Anthropic takes one string).
  const systemParts: string[] = [];
  const transformed: any[] = [];
  for (const msg of Array.isArray(src.messages) ? src.messages : []) {
    if (!msg) continue;
    if (msg.role === "system" || msg.role === "developer") {
      const t = extractText(msg.content);
      if (t) systemParts.push(t);
      continue;
    }

    if (msg.role === "tool" || msg.role === "function") {
      // OpenAI tool result → Anthropic user/tool_result block.
      transformed.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.tool_call_id ?? msg.name ?? "unknown",
            content: msg.content ?? "",
          },
        ],
      });
      continue;
    }

    if (msg.role === "assistant") {
      const blocks: any[] = [];
      // Round-trip reasoning_content (DeepSeek/GLM emit it) as a thinking block.
      if (msg.reasoning_content) {
        blocks.push({ type: "thinking", thinking: msg.reasoning_content });
      }
      const contentBlocks = openAIContentToBlocks(msg.content);
      blocks.push(...contentBlocks);
      // tool_calls / function_call → tool_use blocks.
      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      for (let i = 0; i < calls.length; i++) {
        const tc = calls[i];
        const fn = tc?.function;
        if (!fn?.name) continue;
        blocks.push({
          type: "tool_use",
          id: tc.id ?? `call_${i}`,
          name: fn.name,
          input: parseArguments(fn.arguments),
        });
      }
      if (msg.function_call?.name) {
        blocks.push({
          type: "tool_use",
          id: msg.function_call.id ?? "call_legacy",
          name: msg.function_call.name,
          input: parseArguments(msg.function_call.arguments),
        });
      }
      // Anthropic requires non-empty content on assistant turns; a bare tool call
      // with no text is still valid (tool_use blocks count).
      transformed.push({ role: "assistant", content: blocks.length ? blocks : "" });
      continue;
    }

    // user (and any unknown role treated as user-ish): content parts → blocks.
    if (msg.role === "user") {
      const blocks = openAIContentToBlocks(msg.content);
      transformed.push({ role: "user", content: blocks.length ? blocks : "" });
      continue;
    }

    // Unknown role — pass through as-is (best-effort).
    transformed.push({ role: msg.role, content: msg.content ?? "" });
  }

  if (systemParts.length) out.system = systemParts.join("\n\n");
  out.messages = transformed;

  // Sampling / stop params.
  if (typeof src.max_tokens === "number") {
    out.max_tokens = src.max_tokens;
  } else if (typeof src.max_completion_tokens === "number") {
    // o1+/reasoning models use max_completion_tokens.
    out.max_tokens = src.max_completion_tokens;
  } else {
    out.max_tokens = 4096; // Anthropic requires max_tokens; OpenAI doesn't send it.
  }
  if (typeof src.temperature === "number") out.temperature = src.temperature;
  if (typeof src.top_p === "number") out.top_p = src.top_p;
  if (src.stop !== undefined) {
    out.stop_sequences = Array.isArray(src.stop) ? src.stop : [src.stop];
  }
  if (src.user) out.metadata = { ...(out.metadata ?? {}), user_id: src.user };

  // Tools + tool_choice.
  const tools = mapTools(src.tools);
  if (tools) out.tools = tools;
  const tc = mapToolChoice(src.tool_choice ?? src.function_call);
  if (tc) out.tool_choice = tc;

  return out;
}
