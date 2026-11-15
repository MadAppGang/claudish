/**
 * Text in Claude Code's system prompt that one provider's server refuses.
 *
 * The Antigravity backend answers `429 RESOURCE_EXHAUSTED`, with no reason and
 * no retry delay, to a request whose system instruction holds Claude Code's
 * security paragraph. The phrase it reacts to is the parenthetical
 * `(C2 frameworks, credential testing, exploit development)`; the same request
 * without the paragraph answers 200. The whole paragraph is removed, found by
 * its opening words, so a reworded parenthetical in a later Claude Code is
 * still covered.
 *
 * This is keyed on the claudish provider and not on the model: the filter sits
 * in front of every model the provider serves, Claude models included.
 */
const REFUSED_PARAGRAPH_OPENINGS: Record<string, string[]> = {
  antigravity: ["IMPORTANT: Assist with authorized security testing"],
};

const isLineEnd = (ch: string | undefined) => ch === "\n" || ch === "\r";
const isBlank = (ch: string | undefined) => ch === " " || ch === "\t" || ch === "\r";

/** Index just after the blank lines that start at line start `from`. */
function skipBlankLines(text: string, from: number): number {
  let lineStart = from;
  for (;;) {
    let i = lineStart;
    while (isBlank(text[i])) i++;
    if (text[i] !== "\n") return lineStart;
    lineStart = i + 1;
  }
}

/**
 * Start of the first line after the blank lines that end the paragraph at
 * `from`, or -1 when no blank line follows. A blank line may hold spaces and
 * tabs.
 */
function afterParagraph(text: string, from: number): number {
  let nl = text.indexOf("\n", from);
  while (nl !== -1) {
    const next = skipBlankLines(text, nl + 1);
    if (next > nl + 1) return next;
    nl = text.indexOf("\n", nl + 1);
  }
  return -1;
}

/**
 * `text` without each paragraph that starts, at the start of a line, with
 * `opening`. A paragraph ends at the next blank line, with LF or CRLF line
 * ends. Linear on any input.
 */
function removeParagraphs(text: string, opening: string): string {
  let out = "";
  let from = 0;
  let cutAtEnd = false;
  let at = text.indexOf(opening);
  while (at !== -1) {
    if (at > 0 && text[at - 1] !== "\n") {
      at = text.indexOf(opening, at + opening.length);
      continue;
    }
    const next = afterParagraph(text, at);
    const end = next === -1 ? text.length : next;
    if (next === -1) cutAtEnd = true;
    out += text.slice(from, at);
    from = end;
    at = text.indexOf(opening, end);
  }
  if (from === 0) return text;
  out += text.slice(from);
  if (!cutAtEnd) return out;
  let last = out.length;
  while (last > 0 && isLineEnd(out[last - 1])) last--;
  return out.slice(0, last);
}

function clean(text: string, openings: string[]): string {
  return openings.reduce(removeParagraphs, text);
}

/**
 * A copy of a Claude-format request whose system prompt has lost the
 * paragraphs `providerName`'s server refuses. The request itself is returned
 * when nothing changes. Only the system prompt is read: the conversation is the
 * user's own text. An array system stays an array, so `cache_control` on the
 * surviving blocks lives on; a text block left empty is dropped.
 */
export function removeProviderRefusedText<T extends Record<string, any>>(
  req: T,
  providerName: string
): T {
  const openings = REFUSED_PARAGRAPH_OPENINGS[providerName];
  if (!openings) return req;
  const system = req.system;
  if (typeof system === "string") {
    const text = clean(system, openings);
    return text === system ? req : { ...req, system: text };
  }
  if (!Array.isArray(system)) return req;
  let changed = false;
  const blocks = [];
  for (const block of system) {
    const text = typeof block === "string" ? block : block?.type === "text" ? block.text : null;
    if (typeof text !== "string") {
      blocks.push(block);
      continue;
    }
    const cleaned = clean(text, openings);
    if (cleaned === text) {
      blocks.push(block);
      continue;
    }
    changed = true;
    if (cleaned.trim() === "") continue;
    blocks.push(typeof block === "string" ? cleaned : { ...block, text: cleaned });
  }
  return changed ? { ...req, system: blocks } : req;
}
