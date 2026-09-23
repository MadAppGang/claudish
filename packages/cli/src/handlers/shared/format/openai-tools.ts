/**
 * OpenAI tool schema conversion utilities.
 *
 * Converts Claude/Anthropic tool definitions to OpenAI function format.
 */

import { log } from "../../../logger.js";
import { removeUriFormat } from "../../../transform.js";

const SCHEMA_MAP_KEYWORDS = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);

const SCHEMA_ARRAY_KEYWORDS = new Set([
  "allOf",
  "anyOf",
  "oneOf",
  "prefixItems",
]);

const SCHEMA_KEYWORDS = new Set([
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

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
 * Every non-letter escape (`\.`, `\\`, `\[`) and every digit backreference is
 * portable and is not listed. (Upstream 0997da5, S3 lot 1.)
 */
const PORTABLE_ESCAPE_LETTERS = new Set([
  "A", "b", "B", "d", "D", "s", "S", "w", "W", "Z",
  "a", "f", "n", "r", "t", "v",
  "x", "u", "U", "N",
]);

/**
 * Report whether a `pattern` compiles under the strictest validator measured.
 *
 * A pattern is advisory: it steers the model, and the harness validates the
 * tool call again on arrival. An unportable one is not advisory — it fails the
 * whole request before any model runs. So drop what cannot be proven portable,
 * keep the rest. (Our previous walker dropped EVERY `pattern` — correct on the
 * failing axis, but it also discarded the advisory value of every portable
 * pattern on every tool.)
 */
export function isPortablePattern(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];

    if (char === "\\") {
      const escaped = pattern[i + 1];
      // Consume the escaped character, or `\\p` reads as an opener for `p`.
      i++;
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
 * Remove `pattern` constraints the provider cannot compile, keeping portable
 * ones, while preserving property names.
 *
 * A blind recursive key deletion would also remove a user parameter literally
 * named "pattern" from a `properties` map. Traverse only JSON Schema positions
 * so `pattern` is treated as a schema keyword, never as a property name — the
 * same position-aware walk as before (S4-b), with the portability predicate of
 * upstream 0997da5 replacing the unconditional drop.
 */
function removeUnsupportedPatterns(schema: any): any {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;

  const result: any = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "pattern") {
      if (typeof value === "string" && isPortablePattern(value)) {
        result[key] = value;
      } else {
        log(
          `[OpenAITools] Dropping unportable pattern ${JSON.stringify(String(value))} — the provider's regex validator cannot compile it`
        );
      }
      continue;
    }

    if (SCHEMA_MAP_KEYWORDS.has(key) && value && typeof value === "object") {
      result[key] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [
          name,
          removeUnsupportedPatterns(child),
        ])
      );
    } else if (SCHEMA_ARRAY_KEYWORDS.has(key) && Array.isArray(value)) {
      result[key] = value.map(removeUnsupportedPatterns);
    } else if (SCHEMA_KEYWORDS.has(key)) {
      result[key] = Array.isArray(value)
        ? value.map(removeUnsupportedPatterns)
        : removeUnsupportedPatterns(value);
    } else {
      result[key] = value;
    }
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
 * (Upstream 7016311, S3 lot 1.)
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

  return removeUnsupportedPatterns(removeUriFormat(root));
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
  let clean = description
    .replace(/```[\s\S]*?```/g, "") // Remove code blocks
    .replace(/<[^>]+>/g, "") // Remove HTML/XML tags
    .replace(/\n+/g, " ") // Replace newlines with spaces
    .replace(/\s+/g, " ") // Collapse whitespace
    .trim();

  // Get first sentence
  const firstSentence = clean.match(/^[^.!?]+[.!?]/)?.[0] || clean;

  // Limit to 150 chars
  if (firstSentence.length > 150) {
    return firstSentence.slice(0, 147) + "...";
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
    for (const [key, prop] of Object.entries(summarized.properties)) {
      const p = prop as any;
      if (p.description && p.description.length > 80) {
        // Keep first sentence or truncate
        const firstSentence = p.description.match(/^[^.!?]+[.!?]/)?.[0] || p.description;
        p.description =
          firstSentence.length > 80 ? firstSentence.slice(0, 77) + "..." : firstSentence;
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
 * `any` is the one that falls through every OpenAI-shaped builder in this tree:
 * openai/litellm/local each carry a three-branch mapping that handles `tool`,
 * and passes every OTHER type through as the raw string — so "you MUST call a
 * tool" reached the model as `tool_choice: "any"`, a value the wire does not
 * define. Omitting it inverts the caller's instruction — the model answers in
 * prose while the harness waits for a call — and there is no error anywhere.
 * (Upstream d170a3f, item 10; the adapter-side wiring of this mapper is the
 * next grain — this file is the single definition.)
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
 * THE single definition for every OpenAI-shaped adapter. Returns `undefined`
 * for "send no tool_choice at all", which is the right answer for an absent
 * choice, an unrecognised type, and a `tool` choice that names no tool.
 *
 * @param choice - the inbound `tool_choice`, if any
 * @param encodeName - applied to the named tool, so a wire that renames tools
 *   names the SAME tool here as in `tools[]`. Identity when omitted.
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
 * `mode` is a protobuf ENUM: `AUTO`, `ANY` and `NONE` are the spellings the
 * server accepts, and a misspelling is a 400 on the first tool-using request
 * of a session, not a degraded response. `tool` maps to `ANY` restricted by
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
