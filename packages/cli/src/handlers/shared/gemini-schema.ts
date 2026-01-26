/**
 * Gemini Schema Utilities
 *
 * Shared utilities for converting JSON Schema to Gemini's API format.
 * Used by both GeminiHandler (API key) and GeminiCodeAssistHandler (OAuth).
 */

/**
 * Normalize type field - Gemini requires single string type, not arrays
 * JSON Schema allows: type: ["string", "null"] but Gemini needs: type: "string"
 */
export function normalizeType(type: any): string {
  if (!type) return "string";

  // Handle array types (e.g., ["string", "null"])
  if (Array.isArray(type)) {
    // Filter out "null" and take the first non-null type
    const nonNullTypes = type.filter((t: string) => t !== "null");
    return nonNullTypes[0] || "string";
  }

  return type;
}

/**
 * Recursively sanitize schema for Gemini API compatibility
 *
 * Gemini's API is strict about schema format:
 * - type must be a single string, not an array
 * - No additionalProperties, $schema, $ref, $id, $defs, definitions
 * - No anyOf, oneOf, allOf (complex unions not supported)
 * - No format field (uri, date-time, etc.)
 * - No default, const, examples
 * - Properties inside objects must be sanitized recursively
 */
export function sanitizeSchemaForGemini(schema: any): any {
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  // Handle arrays (shouldn't be at top level, but handle anyway)
  if (Array.isArray(schema)) {
    return schema.map((item) => sanitizeSchemaForGemini(item));
  }

  const result: any = {};

  // Normalize and set type (MUST be single string)
  const normalizedType = normalizeType(schema.type);
  result.type = normalizedType;

  // Copy allowed properties
  if (schema.description && typeof schema.description === "string") {
    result.description = schema.description;
  }

  // Handle enum (must be array of strings/numbers)
  if (Array.isArray(schema.enum)) {
    result.enum = schema.enum.filter(
      (v: any) => typeof v === "string" || typeof v === "number" || typeof v === "boolean"
    );
  }

  // Handle required array
  if (Array.isArray(schema.required)) {
    result.required = schema.required.filter((r: any) => typeof r === "string");
  }

  // Handle properties (for objects)
  if (schema.properties && typeof schema.properties === "object") {
    result.properties = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      if (value && typeof value === "object") {
        result.properties[key] = sanitizeSchemaForGemini(value);
      }
    }
  }

  // Handle items (for arrays)
  if (schema.items) {
    if (typeof schema.items === "object" && !Array.isArray(schema.items)) {
      result.items = sanitizeSchemaForGemini(schema.items);
    } else if (Array.isArray(schema.items)) {
      // Tuple validation - take first item's schema
      result.items = sanitizeSchemaForGemini(schema.items[0]);
    }
  }

  // Handle nullable - Gemini doesn't support nullable directly
  // We just use the base type (already handled by normalizeType)

  // IMPORTANT: Do NOT copy these unsupported fields:
  // - additionalProperties (causes "Proto field is not repeating" error)
  // - $schema, $ref, $id, $defs, definitions
  // - anyOf, oneOf, allOf (complex unions)
  // - format (uri, date-time, etc.)
  // - default, const, examples
  // - minimum, maximum, minLength, maxLength, pattern (validation constraints)

  return result;
}

/**
 * Convert Claude/Anthropic tools to Gemini function declarations format
 */
export function convertToolsToGemini(tools: any[] | undefined): any {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  const functionDeclarations = tools.map((tool: any) => ({
    name: tool.name,
    description: tool.description,
    parameters: sanitizeSchemaForGemini(tool.input_schema),
  }));

  return [{ functionDeclarations }];
}
