/**
 * OpenAI tool schema conversion utilities.
 *
 * Converts Claude/Anthropic tool definitions to OpenAI function format.
 */

import { log } from "../../../logger.js";
import { removeUriFormat } from "../../../transform.js";

/**
 * The escape letters a `pattern` may use and still compile everywhere.
 *
 * OpenAI validates each tool's `pattern` as JSON Schema `format: "regex"`, and
 * the validator compiles the value in Python. Claude Code 2.1.266 ships an
 * `Artifact` tool whose `field` property carries
 * `^(?!__.*__$)[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}"\\./[\]]{1,200}$`, and Codex answers
 * the FIRST request of the session with HTTP 400:
 *
 *   invalid_function_parameters, param tools[1].parameters
 *   "Invalid schema for function 'Artifact': '...' is not a 'regex'."
 *
 * Measured against python3 `re`: the negative lookahead in that same pattern
 * compiles, and `\p{Cc}` raises "bad escape \p". The Unicode property escape is
 * the whole cause, so this list is the letters Python's `re` knows —
 * `\A \b \B \d \D \s \S \w \W \Z`, the character escapes, and `\x \u \U \N`.
 * Every non-letter escape (`\.`, `\\`, `\[`) and every `\1`..`\9` backreference
 * is portable and is not listed. `\0` is not: DeepSeek rejects `^[^\0]*$` with
 * "is not a regex". A lone `\0` is rewritten to `\x00` first (see
 * `rewriteNulEscapes`); a `\0` followed by digits is an octal escape and is dropped.
 */
const PORTABLE_ESCAPE_LETTERS = new Set([
  "A",
  "b",
  "B",
  "d",
  "D",
  "s",
  "S",
  "w",
  "W",
  "Z",
  "a",
  "f",
  "n",
  "r",
  "t",
  "v",
  "x",
  "u",
  "U",
  "N",
]);

/**
 * Report whether a `pattern` compiles under the strictest validator measured.
 *
 * A pattern is advisory: it steers the model, and the harness validates the
 * tool call again on arrival. An unportable one is not advisory — it fails the
 * whole request before any model runs. So drop what cannot be proven portable.
 */
export function isPortablePattern(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];

    if (char === "\\") {
      const escaped = pattern[i + 1];
      // Consume the escaped character, or `\\p` reads as an opener for `p`.
      i++;
      // `\0` is NUL or octal, not a backreference; strict engines reject it.
      if (escaped === "0") return false;
      if (escaped && /[A-Za-z]/.test(escaped) && !PORTABLE_ESCAPE_LETTERS.has(escaped)) {
        return false;
      }
      continue;
    }

    // Python spells a named group `(?P<name>)`. A bare `(?<name>)` does not
    // compile there. Lookbehind, `(?<=` and `(?<!`, does.
    if (char === "(" && pattern[i + 1] === "?" && pattern[i + 2] === "<") {
      const after = pattern[i + 3];
      if (after !== "=" && after !== "!") return false;
    }
  }

  return true;
}

/**
 * Rewrite a lone `\0` (NUL) to `\x00`, which every engine measured accepts, so
 * the constraint survives. `\0` followed by a digit is an octal escape: left
 * alone, so `isPortablePattern` rejects it.
 */
export function rewriteNulEscapes(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "\\" && i + 1 < pattern.length) {
      const escaped = pattern[i + 1];
      if (escaped === "0" && !/[0-9]/.test(pattern[i + 2] ?? "")) {
        out += "\\x00";
      } else {
        out += char + escaped;
      }
      i++;
      continue;
    }
    out += char;
  }
  return out;
}

/**
 * The keywords whose keys are author-chosen names rather than schema keywords.
 *
 * A property called `pattern` lives under `properties`, so the walk must not
 * read that key as the `pattern` keyword and delete the property itself.
 */
const NAMED_SCHEMA_MAPS = new Set(["properties", "$defs", "definitions"]);

function isNamedSchemaMap(key: string, value: any): boolean {
  return (
    NAMED_SCHEMA_MAPS.has(key) && !!value && typeof value === "object" && !Array.isArray(value)
  );
}

function stripInNamedSchemaMap(map: any, path: string): any {
  const result: any = {};
  for (const name in map) {
    result[name] = stripUnportablePatterns(map[name], `${path}.${name}`);
  }
  return result;
}

/**
 * Remove every `pattern` that `isPortablePattern` rejects, at any depth.
 */
function stripUnportablePatterns(schema: any, path = "parameters"): any {
  if (Array.isArray(schema)) {
    return schema.map((item, index) => stripUnportablePatterns(item, `${path}[${index}]`));
  }
  if (!schema || typeof schema !== "object") return schema;

  const result: any = {};
  for (const key in schema) {
    const value = schema[key];

    if (key === "pattern" && typeof value === "string") {
      const rewritten = rewriteNulEscapes(value);
      if (isPortablePattern(rewritten)) {
        result[key] = rewritten;
      } else {
        log(`[OpenAITools] Dropped unportable pattern at ${path}: ${value}`);
      }
      continue;
    }

    if (isNamedSchemaMap(key, value)) {
      result[key] = stripInNamedSchemaMap(value, path);
      continue;
    }

    result[key] = stripUnportablePatterns(value, `${path}.${key}`);
  }

  return result;
}

/**
 * Sanitize a JSON Schema for OpenAI function calling compatibility.
 *
 * OpenAI rejects schemas that have oneOf/anyOf/allOf/enum/not at the TOP LEVEL
 * of function parameters. Nested occurrences inside properties are fine.
 *
 * Strategy:
 * - If root has oneOf/anyOf/allOf: collapse by picking the first branch that
 *   has type "object", or fall back to { type: "object", properties: {},
 *   additionalProperties: true }.
 * - If root has enum or not: remove them.
 * - Ensure root always has type: "object".
 * - Then run removeUriFormat() for the existing uri-format sanitization.
 */
/**
 * The schema a tool gets when it declares no inputs.
 *
 * Returned fresh on every call: callers (summarizeToolParameters) mutate the
 * object they get back, so a shared constant would leak edits between tools.
 */
function emptyParamsSchema(): any {
  return { type: "object", properties: {} };
}

export function sanitizeSchemaForOpenAI(schema: any): any {
  if (!schema || typeof schema !== "object") {
    // A tool with a missing or non-object input_schema must STILL serialize a
    // `parameters` object. Returning undefined here makes JSON.stringify drop
    // the key entirely, and strict endpoints reject the request outright —
    // X-ai answers HTTP 422 "tools[0]: missing field `parameters`".
    return emptyParamsSchema();
  }

  let root = { ...schema };

  // Collapse top-level oneOf / anyOf / allOf
  const combinerKey = ["oneOf", "anyOf", "allOf"].find(
    (k) => Array.isArray(root[k]) && root[k].length > 0
  );
  if (combinerKey) {
    const branches: any[] = root[combinerKey];
    // Prefer the first branch that is explicitly typed as an object
    const objectBranch = branches.find(
      (b: any) => b && typeof b === "object" && b.type === "object"
    );
    if (objectBranch) {
      // Merge the chosen branch onto the root, dropping the combiner key
      const { [combinerKey]: _dropped, ...rest } = root;
      root = { ...rest, ...objectBranch };
    } else {
      // No object branch found — produce a permissive object schema
      root = { type: "object", properties: {}, additionalProperties: true };
    }
  }

  // Remove top-level enum and not (not valid at the parameters root for OpenAI)
  const { enum: _enum, not: _not, ...withoutForbidden } = root;
  root = withoutForbidden;

  // Ensure root type is "object" with properties (OpenAI requires both)
  root.type = "object";
  if (!root.properties) root.properties = {};

  return stripUnportablePatterns(removeUriFormat(root));
}

/**
 * Convert Claude tools to OpenAI function format
 */
export function convertToolsToOpenAI(req: any, summarize = false): any[] {
  return (
    req.tools?.map((tool: any) => ({
      type: "function",
      function: {
        name: tool.name,
        description: summarize
          ? summarizeToolDescription(tool.name, tool.description)
          : tool.description,
        parameters: summarize
          ? summarizeToolParameters(tool.input_schema)
          : sanitizeSchemaForOpenAI(tool.input_schema),
      },
    })) || []
  );
}

/**
 * Summarize tool description to reduce token count
 * Keeps first sentence or first 150 chars, whichever is shorter
 */
function summarizeToolDescription(name: string, description: string): string {
  if (!description) return name;

  // Remove markdown, examples, and extra whitespace
  const clean = description
    .replace(/```[\s\S]*?```/g, "") // Remove code blocks
    .replace(/<[^>]+>/g, "") // Remove HTML/XML tags
    .replace(/\n+/g, " ") // Replace newlines with spaces
    .replace(/\s+/g, " ") // Collapse whitespace
    .trim();

  // Get first sentence
  const firstSentence = clean.match(/^[^.!?]+[.!?]/)?.[0] || clean;

  // Limit to 150 chars
  if (firstSentence.length > 150) {
    return `${firstSentence.slice(0, 147)}...`;
  }

  return firstSentence;
}

/**
 * Summarize tool parameters schema to reduce token count
 * Keeps required fields and simplifies descriptions
 */
function summarizeToolParameters(schema: any): any {
  // Same contract as sanitizeSchemaForOpenAI: never return undefined, or the
  // `parameters` key vanishes from the serialized tool and strict endpoints 422.
  if (!schema || typeof schema !== "object") return emptyParamsSchema();

  const summarized = sanitizeSchemaForOpenAI({ ...schema });

  // Summarize property descriptions
  if (summarized.properties) {
    for (const prop of Object.values(summarized.properties)) {
      const p = prop as any;
      if (p.description && p.description.length > 80) {
        // Keep first sentence or truncate
        const firstSentence = p.description.match(/^[^.!?]+[.!?]/)?.[0] || p.description;
        p.description =
          firstSentence.length > 80 ? `${firstSentence.slice(0, 77)}...` : firstSentence;
      }
      // Remove examples from enum descriptions
      if (p.enum && Array.isArray(p.enum) && p.enum.length > 5) {
        p.enum = p.enum.slice(0, 5); // Limit enum values
      }
    }
  }

  return summarized;
}

// ─── tool_choice ────────────────────────────────────────────────────────────

/**
 * Claude's `tool_choice`, as Claude Code sends it.
 *
 * `any` is the one that used to fall through every OpenAI-shaped builder in
 * this tree: four verbatim copies of a three-branch mapping each handled
 * `tool`, `auto` and `none`, and silently omitted `any`. Omitting it inverts the
 * caller's instruction — "you MUST call a tool" became "call one if you feel
 * like it" — and there is no error anywhere, only a model that answers in prose
 * when the harness was waiting for a call.
 */
export interface ClaudeToolChoice {
  type?: string;
  name?: string;
}

/** An OpenAI Chat Completions `tool_choice` value. */
export type OpenAIToolChoice = string | { type: "function"; function: { name: string } };

/** An OpenAI Responses API `tool_choice` value (the function form is flat). */
export type ResponsesToolChoice = string | { type: "function"; name: string };

/**
 * Map Claude's `tool_choice` onto the OpenAI Chat Completions spelling.
 *
 * THE single definition for every OpenAI-shaped adapter — openai, openrouter,
 * litellm and local each carried their own copy, and `adapters.md:476-482`
 * records that class of duplication for these exact files. A fifth copy is how
 * the next `any` gets forgotten.
 *
 * Returns `undefined` for "send no tool_choice at all", which is the right
 * answer for an absent choice, an unrecognised type, and a `tool` choice that
 * names no tool.
 *
 * @param choice - the inbound `tool_choice`, if any
 * @param encodeName - applied to the named tool, so a wire that renames tools
 *   names the SAME tool here as in `tools[]`. Identity when omitted.
 *
 * NOTE on `encodeName`: production does not pass it. Tool-name encoding runs as
 * a post-pass over the BUILT payload (`BaseAPIFormat.encodeToolNames`), because
 * the name also lives in the message history, which no `tool_choice` mapper can
 * reach — and because the codec's map is minted there. The hook stays for a
 * builder that ever has the bindings in hand before it builds.
 */
export function mapToolChoiceToOpenAI(
  choice: ClaudeToolChoice | null | undefined,
  encodeName?: (name: string) => string
): OpenAIToolChoice | undefined {
  if (!choice) return undefined;
  const { type, name } = choice;

  if (type === "tool" && name) {
    return { type: "function", function: { name: encodeName ? encodeName(name) : name } };
  }
  // Claude's "any" means "you must call one of the tools"; OpenAI spells that
  // "required".
  if (type === "any") return "required";
  if (type === "auto" || type === "none") return type;
  return undefined;
}

/**
 * The same mapping in the Responses API spelling, where the function form is
 * `{type:"function", name}` rather than nesting it under `function`.
 */
export function mapToolChoiceToResponsesAPI(
  choice: ClaudeToolChoice | null | undefined,
  encodeName?: (name: string) => string
): ResponsesToolChoice | undefined {
  const mapped = mapToolChoiceToOpenAI(choice, encodeName);
  if (mapped === undefined || typeof mapped === "string") return mapped;
  return { type: "function", name: mapped.function.name };
}

/** Gemini's `toolConfig` — the same instruction in the protobuf spelling. */
export interface GeminiToolConfig {
  functionCallingConfig: {
    mode: "AUTO" | "ANY" | "NONE";
    allowedFunctionNames?: string[];
  };
}

/**
 * Map Claude's `tool_choice` onto Gemini's `toolConfig`.
 *
 * Gemini had NO tool_choice handling at all: `buildPayload` wrote `contents`,
 * `generationConfig`, `systemInstruction`, `tools` and `thinkingConfig` and
 * nothing else, so every forced-tool turn on `g@`/`go@`/`ag@` ran as if the
 * caller had said `auto`.
 *
 * `mode` is a protobuf ENUM: `AUTO`, `ANY` and `NONE` are the spellings the
 * server accepts, and a misspelling is a 400 on the first tool-using request of
 * a session, not a degraded response. `tool` maps to `ANY` restricted by
 * `allowedFunctionNames` — Gemini has no single-function mode.
 */
export function mapToolChoiceToGemini(
  choice: ClaudeToolChoice | null | undefined,
  encodeName?: (name: string) => string
): GeminiToolConfig | undefined {
  if (!choice) return undefined;
  const { type, name } = choice;

  if (type === "tool" && name) {
    return {
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: [encodeName ? encodeName(name) : name],
      },
    };
  }
  if (type === "any") return { functionCallingConfig: { mode: "ANY" } };
  if (type === "auto") return { functionCallingConfig: { mode: "AUTO" } };
  if (type === "none") return { functionCallingConfig: { mode: "NONE" } };
  return undefined;
}
