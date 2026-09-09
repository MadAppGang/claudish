/**
 * OpenAI tool schema conversion utilities.
 *
 * Converts Claude/Anthropic tool definitions to OpenAI function format.
 */

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
 * Remove regex constraints unsupported by OpenAI while preserving property names.
 *
 * A blind recursive key deletion would also remove a user parameter literally
 * named "pattern" from a `properties` map. Traverse only JSON Schema positions
 * so `pattern` is removed as a schema keyword, never as a property name.
 */
function removeUnsupportedPatterns(schema: any): any {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;

  const result: any = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "pattern") continue;

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
export function sanitizeSchemaForOpenAI(schema: any): any {
  if (!schema || typeof schema !== "object") {
    return removeUriFormat(schema);
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
  if (!schema) return schema;

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
