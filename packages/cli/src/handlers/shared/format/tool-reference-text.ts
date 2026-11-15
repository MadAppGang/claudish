/**
 * `tool_reference` items of a tool result, as text for a foreign model.
 *
 * Claude Code loads a deferred tool through `ToolSearch`, and the result is a
 * pointer with no text: `{type: "tool_reference", tool_name: "WebFetch"}`. The
 * Anthropic API replaces the pointer with the tool's definition before the
 * model reads it. No other provider knows the item, and the converters each
 * did something else with it: the Gemini converter sent the string `"OK"`, the
 * Anthropic-shaped one an empty text, Chat Completions and Ollama Cloud the
 * item's JSON. The model could not tell a loaded tool from an empty search.
 *
 * The definition itself needs no place in the result: Claude Code adds the
 * tool to `tools` on the next request, and every converter declares it there.
 * So each pointer becomes one sentence that says so, in the name the model
 * sees. Text is the one item every converter carries.
 */

const identity = (name: string) => name;

const loadedText = (name: string) => `Loaded: ${name}. It is in your tool list now.`;

const isReference = (item: any) => item?.type === "tool_reference";

/** The items of one tool result, or the same array when it holds no reference. */
function itemsAsText(items: any[], nameOf: (name: string) => string): any[] {
  if (!items.some(isReference)) return items;
  const out: any[] = [];
  for (const item of items) {
    if (!isReference(item)) {
      out.push(item);
      continue;
    }
    // A pointer with no name says nothing a sentence could repeat.
    if (typeof item.tool_name !== "string" || item.tool_name === "") continue;
    out.push({ type: "text", text: loadedText(nameOf(item.tool_name)) });
  }
  return out;
}

function blocksAsText(blocks: any[], nameOf: (name: string) => string): any[] {
  let changed = false;
  const out = blocks.map((block: any) => {
    if (block?.type !== "tool_result" || !Array.isArray(block.content)) return block;
    const content = itemsAsText(block.content, nameOf);
    if (content === block.content) return block;
    changed = true;
    return { ...block, content };
  });
  return changed ? out : blocks;
}

/**
 * `messages` with each `tool_reference` item of a user message's tool result
 * replaced by a text item. `nameOf` maps a Claude Code tool name to the name
 * sent on the wire (the tool-name alias). The same array is returned when
 * nothing changes; the messages given are not mutated.
 */
export function toolReferencesAsText<T extends { role?: string; content?: unknown }>(
  messages: T[],
  nameOf: (name: string) => string = identity
): T[] {
  let changed = false;
  const out = messages.map((message) => {
    if (message?.role !== "user" || !Array.isArray(message.content)) return message;
    const content = blocksAsText(message.content, nameOf);
    if (content === message.content) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? out : messages;
}
