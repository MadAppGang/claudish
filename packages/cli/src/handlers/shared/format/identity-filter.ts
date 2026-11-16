/**
 * Identity filter: removes the Claude Code / Anthropic identity that Claude Code
 * writes into a request, before the request reaches a foreign model.
 *
 * Every rule matches a fixed string or a fixed grammar Claude Code itself
 * emits, so the result is deterministic. The scrub reaches only text Claude
 * Code injects:
 *
 * - the system prompt, and `role: "system"` messages inside `messages`;
 * - `<system-reminder>` spans and Claude Code's fixed wrapper sentences inside
 *   user messages;
 * - tool descriptions and the `description` fields of their input schemas,
 *   for the request's tools and for the tool definitions a system message adds.
 *
 * Never changed: user-typed text, assistant turns, tool results, tool names,
 * schema keys and enum values. A tool result can hold file contents, and a
 * rewritten one would make the model's next edit quote text the file lacks.
 *
 * Three kinds of text are told apart:
 *
 * 1. A statement of who the reader is ("You are Claude Code…", its model name
 *    and knowledge cutoff) is removed.
 * 2. Text that addresses the reader as "Claude" ("Claude uses it when…") or
 *    names the harness "Claude Code" is renamed.
 * 3. A name of a real product, model, tool or file stays ("Claude Docs",
 *    "Claude API", "Anthropic SDK", `claude-opus-5-5`, `CLAUDE.md`,
 *    `~/.claude/`): the model must still be able to use the thing named.
 */

/** The header a foreign model gets in place of Claude Code's identity line. */
export const NEUTRAL_IDENTITY_HEAD =
  "You are an AI coding agent working in a command-line agent harness. If asked who you are, name your actual model and the company that made it.";

/**
 * The identity block Google's own Antigravity client opens its system prompt
 * with (the default, non-autonomous variant of its `antigravity_identity`
 * template). The template's third line, which says user requests arrive inside
 * `<USER_REQUEST>` tags, is left out: claudish does not wrap user turns in them.
 */
export const ANTIGRAVITY_IDENTITY_HEAD = [
  "You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.",
  "You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.",
].join("\n");

const KNOWN_HEADS = [NEUTRAL_IDENTITY_HEAD, ANTIGRAVITY_IDENTITY_HEAD];

/** The name a foreign model reads wherever Claude Code names itself. */
const HARNESS_NAME = "Agent CLI";

/** Whole lines of Claude Code's environment section that describe Claude. */
const LINE_RULES: RegExp[] = [
  /^[ \t]*(?:-[ \t]+)?The most recent Claude models are[^\n]*(?:\n|$)/gm,
  /^[ \t]*(?:-[ \t]+)?Claude Code is available as a CLI[^\n]*(?:\n|$)/gm,
  /^[ \t]*(?:-[ \t]+)?Fast mode for Claude Code[^\n]*(?:\n|$)/gm,
];

/**
 * Identity sentences. A sentence ends at a full stop followed by whitespace,
 * the end of the text, or a tag (`.</system-reminder>`), so a model name such
 * as "Opus 5.5" is removed whole.
 *
 * The scan for that full stop is BOUNDED (`{0,300}`). An unbounded `[^\n]*?`
 * runs to the end of the line for every occurrence of the prefix when no full
 * stop follows, which is quadratic in the line; an identity sentence is short.
 */
const SENTENCE_RULES: RegExp[] = [
  /You are Claude Code, Anthropic's official CLI(?:[^\n]{0,300}?\.(?=\s|$|<)|[^.\n]{0,300})/g,
  /You are a Claude agent, built on Anthropic's Claude Agent SDK\.?/g,
  /You are powered by the model named [^\n]{0,300}?\.(?=\s|$|<)/g,
  /The exact model ID is [^\s<]{1,200}?\.(?=\s|$|<)/g,
  /Assistant knowledge cutoff is [^\n]{0,300}?\.(?=\s|$|<)/g,
];

const BACKGROUND_OPEN = "<claude_background_info>";
const BACKGROUND_CLOSE = "</claude_background_info>";

/**
 * Removes every `<claude_background_info>…</claude_background_info>` block. A
 * plain search, one pass: once no closing tag follows, no later block can
 * close either, so the search stops. A `[\s\S]*?` pattern scanned to the end of
 * the text for every opening tag.
 */
function removeBackgroundInfo(text: string): string {
  let start = text.indexOf(BACKGROUND_OPEN);
  if (start === -1) return text;
  let out = "";
  let done = 0;
  while (start !== -1) {
    const end = text.indexOf(BACKGROUND_CLOSE, start + BACKGROUND_OPEN.length);
    if (end === -1) break;
    out += text.slice(done, start);
    done = end + BACKGROUND_CLOSE.length;
    start = text.indexOf(BACKGROUND_OPEN, done);
  }
  return out + text.slice(done);
}

/**
 * Code and literals, where no name is ever renamed: a fenced block, an inline
 * code span, and a double-quoted string on one line, read with its escapes
 * (`"Say \\"hi\\" now"` is one string). Injected text can carry a
 * file the user wrote (a `CLAUDE.md`, a memory file, a quoted line to replace),
 * and a name renamed inside `const label = "Ask Claude to help"` no longer
 * matches the file. Prose in double quotes is kept too; that is the price.
 */
/**
 * A Markdown fence: an opening line of three or more backticks or tildes, up to
 * a closing line of at least as many of the SAME character, or to the end of the
 * text when no such line follows (Markdown leaves an unclosed fence open).
 *
 * - The length match lets a four-backtick block hold a three-backtick example.
 * - The line start keeps `~~~` inside a prose line from opening a block.
 * - The opening line can sit in a list item or a blockquote (`- `, `1. `, `> `),
 *   and the closing line in a blockquote. A list marker needs its space:
 *   `-` directly before the backticks is prose.
 * - A line of fence characters followed by other text does not close the block.
 *
 * Groups 1 and 2 are the fence and its character.
 */
const FENCE_OPEN = String.raw`^(?:[ \t]*(?:>|[-*+][ \t]|\d+[.)][ \t]))*[ \t]*((\x60|~)\2{2,})[^\n]*`;
const FENCE_CLOSE = String.raw`^(?:[ \t]*>)*[ \t]*\1\2*[ \t]*$`;
/**
 * A fence with its closing line, or open to the end of the text. An opening
 * line with no closing line takes everything after it, so the pattern never
 * scans the rest of the text more than once.
 */
const FENCE = String.raw`${FENCE_OPEN}(?:\n[\s\S]*?(?:${FENCE_CLOSE}|(?![\s\S]))|(?![\s\S]))`;

const FENCE_RE = new RegExp(FENCE, "gm");

/** A `[from, to)` range of a text. */
type Range = [number, number];

/** `[from, to)` ranges of the text that `spans` matches. */
function rangesOf(text: string, spans: RegExp): Range[] {
  return [...text.matchAll(spans)].map((m) => [m.index, m.index + m[0].length]);
}

/** Sorted by start, with overlapping ranges joined, so `inside` can bisect. */
function merged(ranges: Range[]): Range[] {
  if (ranges.length < 2) return ranges;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Range[] = [sorted[0]];
  for (const [from, to] of sorted.slice(1)) {
    const last = out[out.length - 1];
    if (from <= last[1]) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  }
  return out;
}

/** Whether `at` is inside one of `ranges`, which `merged` produced. */
function inside(ranges: Range[], at: number): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (at < ranges[mid][0]) high = mid - 1;
    else if (at >= ranges[mid][1]) low = mid + 1;
    else return true;
  }
  return false;
}

/**
 * Inline code on one line: a run of backticks, closed by the next run of the
 * SAME length on that line (``a `b` c`` is one span).
 *
 * A scanner, not a regex, and it reads each character once. A regex for this
 * (`(\x60+)…\1`) retries from every position of a long run with no closing run
 * and took 2 to 3 s on 25 KB of backticks.
 *
 * One line only, by decision. Markdown lets inline code cross a line break, but
 * a stray backtick in prose would then pair with a backtick lines later, and a
 * real reminder between the two would count as code and escape the scrub.
 */
function inlineCodeRanges(text: string, fences: Range[]): Range[] {
  if (!text.includes("\x60")) return [];
  const out: Range[] = [];
  /** The backtick runs of the current line, as [start, length]. */
  let runs: Range[] = [];
  const closeLine = () => {
    if (runs.length > 1) {
      // next[i]: the nearest later run of the same length, found in one pass
      // from the right.
      const next = new Array<number>(runs.length).fill(-1);
      const seen = new Map<number, number>();
      for (let k = runs.length - 1; k >= 0; k--) {
        next[k] = seen.get(runs[k][1]) ?? -1;
        seen.set(runs[k][1], k);
      }
      for (let k = 0; k < runs.length; ) {
        const close = next[k];
        if (close === -1) {
          k++;
        } else {
          out.push([runs[k][0], runs[close][0] + runs[close][1]]);
          k = close + 1;
        }
      }
    }
    runs = [];
  };
  for (let at = 0; at < text.length; at++) {
    const char = text.charCodeAt(at);
    if (char === 10) {
      closeLine();
    } else if (char === 96) {
      let end = at + 1;
      while (end < text.length && text.charCodeAt(end) === 96) end++;
      if (!inside(fences, at)) runs.push([at, end - at]);
      at = end - 1;
    }
  }
  closeLine();
  return out;
}

/**
 * Double-quoted strings, each on one line, read with their escapes. A scanner
 * for the same reason as `inlineCodeRanges`: a regex retried from every quote
 * of a line of `\"` with no closing quote and took over 1 s on 40 KB.
 *
 * One pass, left to right. A quote that finds no closing quote on its line
 * opens nothing, and the scan goes on from the next line.
 */
function stringRanges(text: string): Range[] {
  if (!text.includes('"')) return [];
  const out: Range[] = [];
  let open = -1;
  for (let at = 0; at < text.length; at++) {
    const char = text.charCodeAt(at);
    if (char === 10) {
      open = -1;
    } else if (open === -1) {
      if (char === 34) open = at;
    } else if (char === 92) {
      // A backslash takes the next character with it, but not a line end.
      if (text.charCodeAt(at + 1) !== 10) at++;
    } else if (char === 34) {
      out.push([open, at + 1]);
      open = -1;
    }
  }
  return out;
}

/**
 * Code: fenced blocks and inline code. A tag or a wrapper line inside it is
 * source the user pasted.
 */
function codeRanges(text: string): Range[] {
  const fences = merged(rangesOf(text, FENCE_RE));
  return merged([...fences, ...inlineCodeRanges(text, fences)]);
}

/** Code and double-quoted strings: where no name is ever renamed. */
function literalRanges(text: string): Range[] {
  return merged([...codeRanges(text), ...stringRanges(text)]);
}

type Replacer = (match: string, offset: number, groups: string[]) => string;

/** `text.replace(rule, …)`, skipping every match that starts inside `ranges`. */
function replaceOutside(text: string, ranges: Range[], rule: RegExp, replacer: Replacer): string {
  return text.replace(rule, (match: string, ...rest: unknown[]) => {
    const offsetAt = rest.findIndex((arg) => typeof arg === "number");
    const offset = rest[offsetAt] as number;
    if (inside(ranges, offset)) return match;
    return replacer(match, offset, rest.slice(0, offsetAt) as string[]);
  });
}

/**
 * "Claude Code" as prose. Refused inside a path (`/Applications/Claude Code.app`)
 * and beside a single quote. The possessive ("Claude Code's hooks") is prose.
 */
const HARNESS_IN_PROSE = /(?<![\w/\\"'`.-])Claude Code(?![\w"`/\\]|'(?!s\b)|\.\w)/g;

const RENAMES: Array<[RegExp, Replacer]> = [
  // One optional space, not a run: `[ \t]*` here rescans a long run of spaces
  // from every position and took 2 s on a 100 KB reminder.
  [/ ?\(claude\.ai\/code\)/g, () => ""],
  [HARNESS_IN_PROSE, () => HARNESS_NAME],
  [/\bClaude (sessions?)\b/g, (_match, _offset, groups) => `${HARNESS_NAME} ${groups[0]}`],
];

/** What the reader is called where injected text addresses it as "Claude". */
const READER_NAME = "the assistant";

/**
 * "Claude" where it names the reader, and nowhere else. A match is refused when
 * the word is part of a longer name, a path or an id; when a determiner comes
 * before it ("a Claude model"); when a capitalised word or a version comes after
 * it ("Claude Docs", "Claude Opus", "Claude 4"); for the lower-case product
 * phrases listed; for a file name or a Windows path segment (`Claude.json`,
 * `C:\\Users\\Claude\\`); and for an assignment (`Claude = true`). Literal spans
 * are skipped before this rule runs (`literalRanges`).
 */
const READER_CLAUDE = new RegExp(
  [
    String.raw`(?<![\w/\\.@"'\x60-])`,
    String.raw`(?<!\b(?:a|an|the|other|another|internal|each|every|any|your|real)\s)`,
    String.raw`Claude(?:['’]s)?`,
    String.raw`(?![\w/\\'’"\x60-])`,
    String.raw`(?!\s*=)`,
    String.raw`(?!\.\w)`,
    String.raw`(?!\.\.\.)`,
    String.raw`(?!,\s+[A-Z])`,
    String.raw`(?!\s+(?:[A-Z\d]|in\s+(?:Chrome|Slack)\b|(?:models?|desktop|login|account|subscription|family|apps?|plans?)\b))`,
  ].join(""),
  "g"
);

/** The text before a match ends a sentence, or opens a line or a list item. */
const SENTENCE_START = /(?:[.!?]["')\]*]*\s+|(?:^|\n)[ \t]*(?:(?:[-*•]|\d+\.)[ \t]+)?(?:\*\*)?)$/;

function renameReader(text: string): string {
  if (!text.includes("Claude")) return text;
  return replaceOutside(text, literalRanges(text), READER_CLAUDE, (match, offset) => {
    const name = SENTENCE_START.test(text.slice(Math.max(0, offset - 16), offset))
      ? READER_NAME[0].toUpperCase() + READER_NAME.slice(1)
      : READER_NAME;
    return name + match.slice("Claude".length);
  });
}

/** Applies every rule to one span of injected text. Whitespace is kept as is. */
function scrubText(text: string): string {
  let out = text;
  for (const rule of SENTENCE_RULES) out = out.replace(rule, "");
  out = removeBackgroundInfo(out);
  for (const rule of LINE_RULES) out = out.replace(rule, "");
  for (const [rule, to] of RENAMES) out = replaceOutside(out, literalRanges(out), rule, to);
  return renameReader(out);
}

/** Claude Code's identity opener, the anchor for whether to add a header. */
const IDENTITY_OPENER =
  /You are Claude Code, Anthropic's official CLI|You are a Claude agent, built on Anthropic's Claude Agent SDK/;

function stripKnownHead(text: string): { body: string; hadHead: boolean } {
  for (const head of KNOWN_HEADS) {
    if (text.startsWith(head)) return { body: text.slice(head.length).trimStart(), hadHead: true };
  }
  return { body: text, hadHead: false };
}

/**
 * Scrubs a system prompt and, when it stated Claude Code's identity, puts an
 * identity header first. A prompt with no identity opener (a caller's own
 * "Be brief.") is scrubbed and gets no header: there is nothing to replace.
 *
 * With no `head`, a text that already starts with a known header keeps it, so
 * an adapter that filters again after `scrubHarnessIdentity` changes nothing.
 * With a `head`, that header replaces any known one.
 */
export function filterIdentity(content: string, head?: string): string {
  const hadIdentity = IDENTITY_OPENER.test(content);
  const scrubbed = scrubText(content)
    .replace(/\n{3,}/g, "\n\n")
    .trimStart();
  const { body, hadHead } = stripKnownHead(scrubbed);
  if (!hadIdentity && !hadHead) return scrubbed;
  if (head === undefined && hadHead) return scrubbed;
  const chosen = head ?? NEUTRAL_IDENTITY_HEAD;
  return body ? `${chosen}\n\n${body}` : chosen;
}

/**
 * The spans Claude Code injects into a user message: reminders, and the fixed
 * sentences it wraps around a local command, a mid-turn message, a plugin
 * prompt and a message from another session. Each is matched whole.
 */
const INJECTED_TAGS = ["system-reminder", "local-command-caveat"];

/** The first `needle` at or after `from` that is not inside code, or -1. */
function indexOutsideCode(text: string, needle: string, from: number, code: Range[]): number {
  for (let at = text.indexOf(needle, from); at !== -1; at = text.indexOf(needle, at + 1)) {
    if (!inside(code, at)) return at;
  }
  return -1;
}

/**
 * Where the span that opens at `start` ends: the index of its closing tag, or
 * -1. Opening and closing tags are COUNTED, so a pair inside the span (a
 * reminder nested in a reminder, or a fenced example of one inside a reminder
 * that carries a `CLAUDE.md`) does not end the outer span early. Tags inside
 * inline code are not counted: a line that only mentions a tag has no partner.
 *
 * Fences are deliberately not consulted here. A fence that opens inside the
 * span and never closes (a memory file cut off in the middle of a block) would
 * otherwise hide the real closing tag and the whole reminder would go out
 * unscrubbed; and a balanced example needs no fence to be skipped.
 */
function closingTagAt(
  text: string,
  start: number,
  open: string,
  close: string,
  inlineCode: Range[]
): number {
  let depth = 0;
  let at = start;
  for (;;) {
    const nextClose = indexOutsideCode(text, close, at, inlineCode);
    if (nextClose === -1) return -1;
    const nextOpen = indexOutsideCode(text, open, at, inlineCode);
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      at = nextOpen + open.length;
      continue;
    }
    depth--;
    if (depth === 0) return nextClose;
    at = nextClose + close.length;
  }
}

/**
 * Scrubs every `<tag>…</tag>` span Claude Code injected. An OPENING tag inside
 * code (a fence, also one that never closes, or inline code) is source the user
 * pasted, so it starts no span. Where the span ends: `closingTagAt`.
 */
function scrubTagged(text: string, tag: string): string {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  if (!text.includes(open)) return text;
  const code = codeRanges(text);
  const inlineCode = merged(inlineCodeRanges(text, []));
  let out = "";
  let done = 0;
  for (;;) {
    const start = indexOutsideCode(text, open, done, code);
    if (start === -1) break;
    const end = closingTagAt(text, start, open, close, inlineCode);
    if (end === -1) break;
    const stop = end + close.length;
    out += text.slice(done, start) + scrubText(text.slice(start, stop));
    done = stop;
  }
  return out + text.slice(done);
}

/**
 * A wrapper sentence counts only as a WHOLE LINE in Claude Code's own wording,
 * outside code. The same words inside a line the user typed (a quoted
 * literal to replace, a sentence about the harness) or inside source the user
 * pasted in a fence are the user's text and stay as written.
 */
const INJECTED_LINES: RegExp[] = [
  /^This is how Claude Code surfaces (?:messages the user sends mid-turn|a prompt a plugin submits between turns)[^\n]*$/gm,
  /^Another Claude session sent a message:[ \t]*$/gm,
  /^This came from another Claude session[^\n]*$/gm,
];

/** Cheap test for "this text can hold an injected span at all". */
const MAY_HOLD_SPAN = /<system-reminder>|<local-command-caveat>|Claude/;

function scrubInjectedSpans(text: string): string {
  if (!MAY_HOLD_SPAN.test(text)) return text;
  let out = text;
  // A tag or a wrapper line inside code is source the user pasted, not an
  // injected span.
  for (const tag of INJECTED_TAGS) out = scrubTagged(out, tag);
  for (const line of INJECTED_LINES) out = replaceOutside(out, codeRanges(out), line, scrubText);
  return out;
}

function systemTextOf(system: unknown): string {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system
    .map((item: any) => (typeof item === "string" ? item : (item?.text ?? "")))
    .filter((text: string) => text.trim() !== "")
    .join("\n\n");
}

/** Schema keys whose values are data the model sends back, never prose. */
const SCHEMA_VALUE_KEYS = new Set(["enum", "const", "default", "examples"]);

/** A copy of a JSON schema with only its `description` strings scrubbed. */
function scrubSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(scrubSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "description" && typeof value === "string") out[key] = scrubText(value);
    else if (SCHEMA_VALUE_KEYS.has(key)) out[key] = value;
    else if (SCHEMA_NAME_MAPS.has(key)) out[key] = scrubNamedSchemas(value);
    else out[key] = scrubSchema(value);
  }
  return out;
}

/**
 * Keys whose value maps a NAME the tool author chose to a schema. A name there
 * can be `default`, `enum` or `description`; it is a name, never a keyword.
 */
const SCHEMA_NAME_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions"]);

function scrubNamedSchemas(map: unknown): unknown {
  if (!map || typeof map !== "object" || Array.isArray(map)) return map;
  const out: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(map)) out[name] = scrubSchema(schema);
  return out;
}

/** A copy of a tool definition: description and schema descriptions scrubbed. */
function scrubToolDefinition(tool: any): any {
  if (!tool || typeof tool !== "object") return tool;
  const out = { ...tool };
  if (typeof tool.description === "string") out.description = scrubText(tool.description);
  if (tool.input_schema) out.input_schema = scrubSchema(tool.input_schema);
  return out;
}

function scrubUserContent(content: unknown): unknown {
  if (typeof content === "string") return scrubInjectedSpans(content);
  if (!Array.isArray(content)) return content;
  return content.map((block: any) =>
    block?.type === "text" && typeof block.text === "string"
      ? { ...block, text: scrubInjectedSpans(block.text) }
      : block
  );
}

/** An inline `role: "system"` message is injected whole, so all of it is scrubbed. */
function scrubSystemContent(content: unknown): unknown {
  if (typeof content === "string") return scrubText(content);
  if (!Array.isArray(content)) return content;
  return content.map((block: any) => {
    if (block?.type === "text" && typeof block.text === "string") {
      return { ...block, text: scrubText(block.text) };
    }
    if (block?.type === "tool_addition" && block.tool?.definition) {
      return {
        ...block,
        tool: { ...block.tool, definition: scrubToolDefinition(block.tool.definition) },
      };
    }
    return block;
  });
}

const collapse = (text: string) => text.replace(/\n{3,}/g, "\n\n").trimStart();

/**
 * Scrubs the system prompt and, only when Claude Code's identity opener was
 * present, puts `head` first. The header exists to replace the model's "you are
 * Claude" self-identification; with no such line (a hook that set a short system
 * note, an empty prompt) there is nothing to replace, so none is added.
 *
 * The SHAPE is preserved: an array system stays an array, so `cache_control`
 * breakpoints on the surviving blocks live on. A block scrubbed down to nothing
 * is dropped (an empty text block is a 400 on Anthropic-compat endpoints). The
 * header is prepended as its own block.
 */
function scrubSystem(system: unknown, head: string, hadIdentity: boolean): unknown {
  if (typeof system === "string") {
    const body = collapse(scrubText(system));
    if (!hadIdentity) return body;
    return body ? `${head}\n\n${body}` : head;
  }
  if (Array.isArray(system)) {
    const blocks = system
      .map((b: any) => (typeof b === "string" ? { type: "text", text: b } : b))
      .map((b: any) =>
        b?.type === "text" && typeof b.text === "string"
          ? { ...b, text: collapse(scrubText(b.text)) }
          : b
      )
      .filter((b: any) => !(b?.type === "text" && (b.text ?? "").trim() === ""));
    if (hadIdentity) blocks.unshift({ type: "text", text: head });
    return blocks;
  }
  return hadIdentity ? head : system;
}

/**
 * A copy of a Claude-format request with Claude Code's identity removed from
 * the text Claude Code injects, and `head` as the system prompt's first line
 * when an identity opener was there to replace. The request given is not changed.
 */
export function scrubHarnessIdentity<T extends Record<string, any>>(req: T, head: string): T {
  const out: Record<string, any> = { ...req };
  const hadIdentity = IDENTITY_OPENER.test(systemTextOf(req.system));
  out.system = scrubSystem(req.system, head, hadIdentity);
  if (Array.isArray(req.tools)) out.tools = req.tools.map(scrubToolDefinition);
  if (Array.isArray(req.messages)) {
    out.messages = req.messages.map((msg: any) => {
      if (msg?.role === "user") return { ...msg, content: scrubUserContent(msg.content) };
      if (msg?.role === "system") return { ...msg, content: scrubSystemContent(msg.content) };
      return msg;
    });
  }
  return out as T;
}

/** The identity header for a claudish provider: Antigravity's own, or neutral. */
export function identityHeadFor(providerName: string): string {
  return providerName === "antigravity" ? ANTIGRAVITY_IDENTITY_HEAD : NEUTRAL_IDENTITY_HEAD;
}

/**
 * Whether the upstream model really is Claude, so Claude Code's identity is
 * true for it. The catalog connection's vendor decides when there is one, and
 * it outranks `native`: the handler's `native` flag is a NAME rule (`claude-*`),
 * so a foreign model that only carries a Claude-like name would pass it. With
 * no vendor, a native route or a Claude model id decides. The id rule accepts
 * the dotted cloud spellings (`anthropic.claude-…`, `us.anthropic.claude-…`).
 */
export function keepsClaudeIdentity(route: {
  native: boolean;
  vendor: string | null;
  model: string;
}): boolean {
  if (route.vendor) return route.vendor.toLowerCase() === "anthropic";
  if (route.native) return true;
  return /(^|[/.])claude-/i.test(route.model);
}
