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

  // A conversation holding ONLY system/developer messages — Semantic Kernel's
  // ITextGenerationService serializes a plain prompt string exactly this way —
  // would leave `messages` empty, and the upstream rejects the degenerate body
  // ("No user query found in messages.", measured on the Qwen lane 2026-10-15,
  // relayed verbatim to the client as a 400) while api.openai.com, vLLM direct
  // and OpenRouter all answer it. Drop-in parity: the prompt rides as the user
  // turn (system stays unset — no duplicated text). A body with NO message at
  // all still forwards empty and fails upstream, same as api.openai.com.
  if (systemParts.length) {
    if (transformed.length) {
      out.system = systemParts.join("\n\n");
    } else {
      transformed.push({
        role: "user",
        content: [{ type: "text", text: systemParts.join("\n\n") }],
      });
    }
  }
  out.messages = transformed;

  // Sampling / stop params.
  let maxTokensDefaulted = false;
  if (typeof src.max_tokens === "number") {
    out.max_tokens = src.max_tokens;
  } else if (typeof src.max_completion_tokens === "number") {
    // o1+/reasoning models use max_completion_tokens.
    out.max_tokens = src.max_completion_tokens;
  } else {
    out.max_tokens = 4096; // Anthropic requires max_tokens; OpenAI doesn't send it.
    maxTokensDefaulted = true;
  }
  if (typeof src.temperature === "number") out.temperature = src.temperature;
  if (typeof src.top_p === "number") out.top_p = src.top_p;
  if (src.stop !== undefined) {
    out.stop_sequences = Array.isArray(src.stop) ? src.stop : [src.stop];
  }
  if (src.user) out.metadata = { ...(out.metadata ?? {}), user_id: src.user };

  // #435 — request-side thinking controls. vLLM-style `enable_thinking` (top
  // level or under `chat_template_kwargs`) and OpenAI's `reasoning_effort` were
  // silently DROPPED here, so the reasoning decision fell to the served
  // dialect's policy (CLAUDISH_GLM_THINKING passthrough by default = GLM thinks;
  // CLAUDISH_QWEN_THINKING disabled) — the client's ask never reached
  // `prepareRequest`. Mapping them onto the house `thinking` object is the seam
  // every dialect already consults (`originalRequest.thinking`).
  //
  // Shapes and their downstream fate (measured/probed conventions):
  //  - {type:"disabled"} — GLM openai wire forwards it verbatim (the 37→3 token
  //    probe shape, 2026-08-20); Qwen anthropic wire accepts it natively.
  //  - {type:"enabled", budget_tokens} — GLM reduces to its binary
  //    {type:"enabled"}; Qwen maps to enable_thinking + thinking_budget under
  //    `passthrough`; o1/o3 converts back to reasoning_effort (the effort ladder
  //    below is the exact inverse of openai-api-format's budget→effort map, so
  //    the round trip is stable).
  //  - The enabled block always carries a budget ≥ 1024 and < max_tokens: the
  //    native Anthropic lane requires budget_tokens ≥ 1024, Qwen requires
  //    budget < max_tokens, and the ingress defaults max_tokens to 4096. When
  //    there is no room for a legal block (tiny max_tokens), the mapping is
  //    skipped entirely — a logged-none no-op beats an invalid body or silently
  //    inverting the client's ask.
  const enableThinking =
    typeof src.enable_thinking === "boolean"
      ? src.enable_thinking
      : typeof src.chat_template_kwargs?.enable_thinking === "boolean"
        ? src.chat_template_kwargs.enable_thinking
        : undefined;
  const effortBudget: Record<string, number> = {
    minimal: 2_000,
    low: 8_000,
    medium: 24_000,
    high: 32_000,
  };
  const fromEffort =
    typeof src.reasoning_effort === "string"
      ? effortBudget[src.reasoning_effort.toLowerCase()]
      : undefined;
  if (enableThinking !== undefined || fromEffort !== undefined) {
    if (enableThinking === false) {
      out.thinking = { type: "disabled" };
    } else {
      let budget = fromEffort ?? 2_048;
      if (maxTokensDefaulted) {
        // The 4096 ceiling is OUR placeholder, not the client's — clamping an
        // explicit "high" (32000) to 4095 would invert the ask downstream
        // (o1/o3 remap 4095 back to "minimal"). Raise the placeholder to fit.
        if (budget >= out.max_tokens) out.max_tokens = budget + 1;
      } else {
        // A CLIENT-sent max_tokens is their ceiling: clamp into it (Qwen
        // requires budget < max_tokens), or drop the mapping when no legal
        // block fits — never fail the body, never silently invert.
        budget = Math.min(budget, out.max_tokens - 1);
        if (budget < 1_024) budget = 0;
      }
      if (budget >= 1_024) {
        out.thinking = { type: "enabled", budget_tokens: budget };
      }
    }
  }

  // Tools + tool_choice.
  const tools = mapTools(src.tools);
  if (tools) out.tools = tools;
  const tc = mapToolChoice(src.tool_choice ?? src.function_call);
  if (tc) out.tool_choice = tc;

  return out;
}
