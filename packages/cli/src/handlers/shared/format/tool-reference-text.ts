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
 * sees. Text is the one item every converter carries. A pointer to a tool the
 * request does not declare (the provider's tool limit cut it) gets a sentence
 * that says that instead.
 */

const identity = (name: string) => name;
const always = () => true;

const loadedText = (name: string) => `Loaded: ${name}. It is in your tool list now.`;
const notLoadedText = (name: string) => `Not loaded: ${name}. It is not in your tool list.`;

/** How a pointer is put into words for one request. */
export interface ToolReferenceWording {
  /** A Claude Code tool name as this request declares it. */
  nameOf?: (name: string) => string;
  /** Whether this request declares the tool, by its Claude Code name. */
  isDeclared?: (name: string) => boolean;
}

const isReference = (item: any) => item?.type === "tool_reference";

/** The items of one tool result, or the same array when it holds no reference. */
function itemsAsText(items: any[], wording: Required<ToolReferenceWording>): any[] {
  if (!items.some(isReference)) return items;
  const out: any[] = [];
  for (const item of items) {
    if (!isReference(item)) {
      out.push(item);
      continue;
    }
    // A pointer with no name says nothing a sentence could repeat.
    if (typeof item.tool_name !== "string" || item.tool_name === "") continue;
    const name = wording.nameOf(item.tool_name);
    const text = wording.isDeclared(item.tool_name) ? loadedText(name) : notLoadedText(name);
    out.push({ type: "text", text });
  }
  return out;
}

function blocksAsText(blocks: any[], wording: Required<ToolReferenceWording>): any[] {
  let changed = false;
  const out = blocks.map((block: any) => {
    if (block?.type !== "tool_result" || !Array.isArray(block.content)) return block;
    const content = itemsAsText(block.content, wording);
    if (content === block.content) return block;
    changed = true;
    return { ...block, content };
  });
  return changed ? out : blocks;
}

/**
 * `messages` with each `tool_reference` item of a user message's tool result
 * replaced by a text item. The same array is returned when nothing changes;
 * the messages given are not mutated.
 */
export function toolReferencesAsText<T extends { role?: string; content?: unknown }>(
  messages: T[],
  wording: ToolReferenceWording = {}
): T[] {
  const full = { nameOf: wording.nameOf ?? identity, isDeclared: wording.isDeclared ?? always };
  let changed = false;
  const out = messages.map((message) => {
    if (message?.role !== "user" || !Array.isArray(message.content)) return message;
    const content = blocksAsText(message.content, full);
    if (content === message.content) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? out : messages;
}
