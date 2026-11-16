/**
 * The text of an Antigravity request's history, worded as the Antigravity CLI
 * (`agy` 1.5.9, recorded 2026-11-15 and 2026-11-17) words it:
 *
 * - the user's words inside `<USER_REQUEST>`, followed by an
 *   `<ADDITIONAL_METADATA>` block holding the local time, and on the first
 *   message a `<USER_SETTINGS_CHANGE>` block naming the model;
 * - a file or shell tool's result under a `Created At` / `Completed At` header,
 *   then the tool's own sentence where Claude Code's result holds what that
 *   sentence states.
 *
 * Pure: the caller supplies the time of each entry (`timeOf`), so one entry
 * carries one time on every request that repeats it.
 */

/** A time as Go's RFC 3339 writes local time: `2026-11-17T00:05:02+11:00`. */
export function agyLocalTime(date: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const zone =
    offset === 0
      ? "Z"
      : `${sign}${two(Math.floor(Math.abs(offset) / 60))}:${two(Math.abs(offset) % 60)}`;
  return (
    `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}` +
    `T${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}${zone}`
  );
}

/** One user message as `agy` sends it. `model` is given on a conversation's first message only. */
export function agyUserRequest(text: string, time: string, model?: string): string {
  const blocks = [
    `<USER_REQUEST>\n${text}\n</USER_REQUEST>`,
    `<ADDITIONAL_METADATA>\nThe current local time is: ${time}.\n</ADDITIONAL_METADATA>`,
  ];
  if (model) {
    blocks.push(
      `<USER_SETTINGS_CHANGE>\nThe user changed setting \`Model Selection\` from None to ${model}. No need to comment on this change if the user doesn't ask about it. If reporting what model you are, please use a human readable name instead of the exact string.\n</USER_SETTINGS_CHANGE>`
    );
  }
  return blocks.join("\n");
}

/** Text the harness adds to a user turn; it is not the user's request. */
function isHarnessText(text: string): boolean {
  return text.trimStart().startsWith("<system-reminder>");
}

/** Claude Code's `Read` output: every line is a line number, a tab, the text. */
const NUMBERED_LINE = /^\s*(\d+)\t(.*)$/;

/** The whole-file read limit of Claude Code's `Read`; a longer answer may be cut. */
const READ_DEFAULT_LINES = 2000;

function readFileBody(text: string, args: Record<string, unknown> | null): string {
  const lines = text.split("\n");
  const whole = args !== null && args.StartLine === undefined && args.EndLine === undefined;
  // A whole file ending in a newline is shown with one more, empty, numbered
  // line. In a read of a range the last empty line can be a line of the file.
  if (whole && lines.length > 1 && /^\s*\d+\t$/.test(lines[lines.length - 1])) lines.pop();
  const numbered: Array<[number, string]> = [];
  for (const line of lines) {
    const match = NUMBERED_LINE.exec(line);
    if (!match) return text;
    numbered.push([Number(match[1]), match[2]]);
  }
  if (numbered.length === 0) return text;
  const body = numbered.map(([n, content]) => `${n}: ${content}`).join("\n");
  // The file's length is known only when the whole file was asked for and the
  // answer is shorter than the read limit.
  if (!whole || numbered[0][0] !== 1 || numbered.length >= READ_DEFAULT_LINES) return body;
  const last = numbered[numbered.length - 1][0];
  return `Showing lines 1-${last} of ${last}\n${body}`;
}

/** `args` is null when the call behind the result is not in the history. */
const RESULT_BODY: Record<string, (text: string, args: Record<string, unknown> | null) => string> =
  {
    // The exit code is not known here: a first line `Exit code 7` can be the command's own output.
    run_command: (text) => text,
    read_file: readFileBody,
    write_file: (text) =>
      text.startsWith("File created successfully at:") ? "Created file." : text,
    edit_file: (text) => text,
  };

/** A tool result's text as `agy` words it, or null for a tool it does not cover. */
export function agyToolResult(
  tool: string,
  text: string,
  args: Record<string, unknown> | null,
  time: string
): string | null {
  if (!Object.hasOwn(RESULT_BODY, tool)) return null;
  const body = RESULT_BODY[tool];
  return `Created At: ${time}\nCompleted At: ${time}\n${body(text, args)}`;
}

interface Part {
  text?: unknown;
  functionCall?: { id?: unknown; name?: unknown; args?: unknown };
  functionResponse?: { id?: unknown; name?: unknown; response?: { output?: unknown } };
}
interface Content {
  role?: string;
  parts?: Part[];
}

export interface AgyContentOptions {
  /** The time of the entry or tool result named by `key`; the same key always gets the same time. */
  timeOf: (key: string) => string;
  /** The model's display name (`Gemini 4 Argon (Medium)`), for the first message. */
  modelDisplayName?: string;
  /**
   * The tools whose results are worded: the ones this request declares under
   * `agy`'s name AND `agy`'s arguments. A tool of the user's own that happens
   * to be called `write_file` keeps its result as it is.
   */
  wordedTools: ReadonlySet<string>;
}

/** The argument only the renamed form of each tool declares. */
const AGY_ARGUMENT: Record<string, string> = {
  run_command: "CommandLine",
  read_file: "Path",
  write_file: "Content",
  edit_file: "Target",
};

/** The file and shell tools `tools` declares with `agy`'s arguments. */
export function agyWordedTools(tools: unknown): Set<string> {
  const found = new Set<string>();
  if (!Array.isArray(tools)) return found;
  for (const entry of tools) {
    const declarations = (entry as { functionDeclarations?: unknown } | null)?.functionDeclarations;
    if (!Array.isArray(declarations)) continue;
    for (const declaration of declarations as Array<Record<string, unknown>>) {
      const name = declaration?.name;
      if (typeof name !== "string" || !(name in AGY_ARGUMENT)) continue;
      const schema = (declaration.parameters ?? declaration.parametersJsonSchema) as
        | { properties?: Record<string, unknown> }
        | undefined;
      if (schema?.properties && AGY_ARGUMENT[name] in schema.properties) found.add(name);
    }
  }
  return found;
}

function shapeUserEntry(content: Content, index: number, options: AgyContentOptions): Content {
  const parts = content.parts ?? [];
  const isRequest = (part: Part) => typeof part.text === "string" && !isHarnessText(part.text);
  if (!parts.some(isRequest)) return content;
  const time = options.timeOf(`user:${index}`);
  // Text parts that follow one another are one request. Text on the two sides
  // of an image or of the harness's text stays on its side, each run wrapped.
  const out: Part[] = [];
  let run: Part[] = [];
  let first = true;
  const closeRun = () => {
    if (run.length === 0) return;
    const text = run.map((part) => part.text as string).join("\n");
    const model = first && index === 0 ? options.modelDisplayName : undefined;
    out.push({ ...run[0], text: agyUserRequest(text, time, model) });
    run = [];
    first = false;
  };
  for (const part of parts) {
    if (isRequest(part)) {
      run.push(part);
    } else {
      closeRun();
      out.push(part);
    }
  }
  closeRun();
  return { ...content, parts: out };
}

/**
 * The history with user messages and file and shell tool results worded as
 * `agy` words them. `contents` is the history BEFORE tool results are moved to
 * entries of their own, so an entry's index is the same on every request of a
 * conversation. Never mutates what it is given.
 */
export function agyContents(contents: unknown, options: AgyContentOptions): unknown {
  if (!Array.isArray(contents)) return contents;
  const callArgs = new Map<string, Record<string, unknown>>();
  for (const content of contents as Content[]) {
    for (const part of content?.parts ?? []) {
      const call = part?.functionCall;
      if (call && typeof call.id === "string" && call.args && typeof call.args === "object") {
        callArgs.set(call.id, call.args as Record<string, unknown>);
      }
    }
  }
  return (contents as Content[]).map((content, index) => {
    if (!content || content.role !== "user" || !Array.isArray(content.parts)) return content;
    let results = 0;
    const parts = content.parts.map((part) => {
      const result = part?.functionResponse;
      const output = result?.response?.output;
      if (!result || typeof result.name !== "string" || typeof output !== "string") return part;
      if (!options.wordedTools.has(result.name)) return part;
      const id = typeof result.id === "string" ? result.id : `${index}:${results}`;
      results += 1;
      const text = agyToolResult(
        result.name,
        output,
        callArgs.get(id) ?? null,
        options.timeOf(`result:${id}`)
      );
      if (text === null) return part;
      return { ...part, functionResponse: { ...result, response: { output: text } } };
    });
    return shapeUserEntry({ ...content, parts }, index, options);
  });
}
