/**
 * What an exec script produced, and how it is sent back to the model as a
 * `custom_tool_call_output`.
 *
 * The form is the official Codex client's (R1 §3, `code_mode/output.rs`):
 * a header `"{status}\nWall time {secs:.1} seconds\nOutput:\n"`, then one
 * `input_text` part per `text()` call in order, then on failure
 * `"Script error:\n{stack or string}"`. Token truncation to
 * `max_output_tokens` runs after the error is appended and before the header is
 * prepended, at 4 bytes per token.
 *
 * Images never travel through the script: a nested tool result's image is a
 * reference `(tool_use_id, index)` in the output, resolved from the request's
 * own history when the output is rendered (input builder), so the image bytes
 * are never stored by claudish and appear exactly once in the request.
 */

/** An image of a nested tool result: the tool_use id and the image's index among that result's image blocks. */
export interface ImageRef {
  toolUseId: string;
  index: number;
}

/** One item of a script's output, in the order it was produced. */
export type OutputPart = { type: "text"; text: string } | { type: "image"; ref: ImageRef };

/** A finished script. `failed` carries `error`; `terminated` was ended from outside. */
export interface ExecOutput {
  status: "completed" | "failed" | "terminated";
  /** Wall time from start to finish; undefined when unknown (a reconstructed output). */
  wallMs: number | undefined;
  parts: OutputPart[];
  error?: string;
}

/** A `custom_tool_call_output` content part. */
export type ResponsesOutputPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string };

/** Lower and upper bound of the `max_output_tokens` pragma (claudish policy). */
export const MIN_EXEC_OUTPUT_TOKENS = 1;
export const MAX_EXEC_OUTPUT_TOKENS = 50_000;
/** Bytes per token for output truncation (Codex's own approximation). */
export const BYTES_PER_TOKEN = 4;

/** The pragma keys the Codex grammar defines; any other key is rejected. */
const PRAGMA_KEYS = new Set(["yield_time_ms", "max_output_tokens"]);
const PRAGMA_LINE = /^[ \t]*\/\/ @exec:([^\r\n]*)$/;

export interface ExecPragma {
  /** The source to run: the input with a pragma line blanked (line numbers kept). */
  source: string;
  /** The pragma's `max_output_tokens`, when given. */
  maxOutputTokens?: number;
  /** Why the pragma was rejected; the script is then not run. */
  error?: string;
}

/**
 * Split the optional first-line `// @exec: {...}` pragma from an exec input.
 *
 * Only `yield_time_ms` (accepted and ignored: claudish never yields) and
 * `max_output_tokens` are accepted, as in Codex; an unknown key or a body that
 * is not a JSON object is an error. The pragma line is replaced by an empty line
 * so error line numbers still match the model's input.
 */
export function parseExecPragma(input: string): ExecPragma {
  const newline = input.search(/\r?\n/);
  const firstLine = newline === -1 ? input : input.slice(0, newline);
  const match = PRAGMA_LINE.exec(firstLine);
  if (!match) return { source: input };
  // Keep the line break, so the pragma's line becomes an empty first line.
  const source = newline === -1 ? "" : input.slice(newline);
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1].trim());
  } catch {
    return { source, error: "the // @exec: pragma is not a JSON object" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { source, error: "the // @exec: pragma is not a JSON object" };
  }
  for (const key of Object.keys(parsed)) {
    if (!PRAGMA_KEYS.has(key)) {
      return { source, error: `unsupported key ${JSON.stringify(key)} in the // @exec: pragma` };
    }
  }
  const tokens = (parsed as { max_output_tokens?: unknown }).max_output_tokens;
  if (tokens !== undefined && (typeof tokens !== "number" || !Number.isFinite(tokens))) {
    return { source, error: "max_output_tokens in the // @exec: pragma must be a number" };
  }
  return typeof tokens === "number" ? { source, maxOutputTokens: tokens } : { source };
}

/**
 * The default output budget for one exec: discovery's truncation limit when its
 * mode is `tokens`, else `fallback` (10,000, the protocol default the exec
 * description states).
 */
export function defaultExecOutputTokens(
  truncationPolicy: { mode: string; limit: number } | undefined,
  fallback: number
): number {
  if (truncationPolicy?.mode === "tokens" && Number.isFinite(truncationPolicy.limit)) {
    return clampExecOutputTokens(truncationPolicy.limit);
  }
  return clampExecOutputTokens(fallback);
}

/** A requested token budget clamped to [1, 50,000]. */
export function clampExecOutputTokens(tokens: number): number {
  if (!Number.isFinite(tokens)) return MAX_EXEC_OUTPUT_TOKENS;
  return Math.min(MAX_EXEC_OUTPUT_TOKENS, Math.max(MIN_EXEC_OUTPUT_TOKENS, Math.floor(tokens)));
}

/**
 * A script error's stack with line numbers mapped back to the model's input:
 * the source runs wrapped as `(async () => {\n<src>\n})()`, so a frame at
 * `exec.js:N` is input line `N - 1`.
 */
export function mapScriptStack(stack: string, filename = "exec.js"): string {
  const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return stack.replace(new RegExp(`${escaped}:(\\d+)`, "g"), (_m, line: string) => {
    const n = Math.max(1, Number(line) - 1);
    return `${filename}:${n}`;
  });
}

function statusLine(status: ExecOutput["status"]): string {
  if (status === "completed") return "Script completed";
  if (status === "failed") return "Script failed";
  return "Script terminated";
}

/** `"{status}\nWall time {secs} seconds\nOutput:\n"`, Codex's header. */
export function execOutputHeader(output: Pick<ExecOutput, "status" | "wallMs">): string {
  const wall =
    output.wallMs === undefined
      ? "Wall time unknown"
      : `Wall time ${(Math.max(0, output.wallMs) / 1000).toFixed(1)} seconds`;
  return `${statusLine(output.status)}\n${wall}\nOutput:\n`;
}

/** Truncate text parts to `maxBytes` in order; images are kept. */
function truncateParts(
  parts: ResponsesOutputPart[],
  maxBytes: number
): { parts: ResponsesOutputPart[]; truncated: boolean; totalBytes: number; totalLines: number } {
  let totalBytes = 0;
  let totalLines = 0;
  for (const part of parts) {
    if (part.type !== "input_text") continue;
    totalBytes += Buffer.byteLength(part.text, "utf8");
    totalLines += part.text.split("\n").length;
  }
  if (totalBytes <= maxBytes) return { parts, truncated: false, totalBytes, totalLines };
  const out: ResponsesOutputPart[] = [];
  let room = maxBytes;
  for (const part of parts) {
    if (part.type !== "input_text") {
      out.push(part);
      continue;
    }
    if (room <= 0) continue;
    const bytes = Buffer.byteLength(part.text, "utf8");
    if (bytes <= room) {
      out.push(part);
      room -= bytes;
      continue;
    }
    // Cut on a character boundary: decode the byte prefix and drop a split
    // trailing character.
    const cut = Buffer.from(part.text, "utf8").subarray(0, room).toString("utf8").replace(/�$/, "");
    out.push({ type: "input_text", text: `${cut}…` });
    room = 0;
  }
  return { parts: out, truncated: true, totalBytes, totalLines };
}

export interface FormatExecOutputOptions {
  /** The exec's output budget in tokens (pragma, else the default). */
  maxOutputTokens: number;
  /**
   * The `image_url` for an image reference, from the tool_results in this
   * request; undefined drops the image with a text note.
   */
  resolveImage?: (ref: ImageRef) => string | undefined;
}

/**
 * The `custom_tool_call_output.output` parts for `output`: Codex's header, the
 * output items, the error, truncated to the token budget.
 */
export function formatExecOutput(
  output: ExecOutput,
  options: FormatExecOutputOptions
): ResponsesOutputPart[] {
  const body: ResponsesOutputPart[] = [];
  for (const part of output.parts) {
    if (part.type === "text") {
      body.push({ type: "input_text", text: part.text });
      continue;
    }
    const url = options.resolveImage?.(part.ref);
    if (url) body.push({ type: "input_image", image_url: url });
    else {
      body.push({
        type: "input_text",
        text: `[image ${part.ref.index} of ${part.ref.toolUseId} is no longer in the conversation]`,
      });
    }
  }
  if (output.error !== undefined && output.error !== "") {
    body.push({ type: "input_text", text: `Script error:\n${output.error}` });
  }
  const maxBytes = clampExecOutputTokens(options.maxOutputTokens) * BYTES_PER_TOKEN;
  const truncated = truncateParts(body, maxBytes);
  const head: ResponsesOutputPart[] = [{ type: "input_text", text: execOutputHeader(output) }];
  if (truncated.truncated) {
    head.push({
      type: "input_text",
      text: `Warning: truncated output (original token count: ${Math.ceil(truncated.totalBytes / BYTES_PER_TOKEN)})\nTotal output lines: ${truncated.totalLines}\n\n`,
    });
  }
  return [...head, ...truncated.parts];
}
