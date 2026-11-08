/**
 * A tool's JSON Schema `input_schema` rendered as a TypeScript type, for the
 * `exec tool declaration:` block of the exec tool's description.
 *
 * The form follows the official Codex client's renderer (R1 §1c,
 * `render_json_schema_to_typescript`): each property's description becomes a
 * `//` comment above it, required properties are bare and optional ones carry
 * `?`. Supported: `enum`, `const`, `anyOf` / `oneOf` unions, type arrays,
 * arrays (and tuples), nested objects to a depth of 4, `additionalProperties`.
 * Anything else, and anything deeper, is `unknown` — the type is guidance for
 * the model; Claude Code validates the real call.
 */

/** Deepest object/array nesting rendered; below it a value is `unknown`. */
export const MAX_SCHEMA_DEPTH = 4;

type Schema = Record<string, unknown>;

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function isSchema(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function literal(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  return "unknown";
}

function union(parts: string[]): string {
  const unique = [...new Set(parts)];
  if (unique.length === 0) return "unknown";
  if (unique.includes("unknown")) return "unknown";
  return unique.join(" | ");
}

function propertyKey(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

function commentLines(description: unknown, pad: string): string[] {
  if (typeof description !== "string") return [];
  const text = description.trim();
  if (!text) return [];
  return text.split(/\r?\n/).map((line) => `${pad}// ${line.trimEnd()}`.trimEnd());
}

function renderObject(schema: Schema, depth: number, indent: number): string {
  const properties = isSchema(schema.properties) ? schema.properties : undefined;
  const additional = schema.additionalProperties;
  if (!properties) {
    if (isSchema(additional)) {
      return `Record<string, ${render(additional, depth + 1, indent)}>`;
    }
    return "Record<string, unknown>";
  }
  const names = Object.keys(properties);
  if (names.length === 0) return "{}";
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((r) => typeof r === "string") : []
  );
  const pad = "  ".repeat(indent + 1);
  const lines: string[] = ["{"];
  for (const name of names) {
    const prop = properties[name];
    lines.push(...commentLines(isSchema(prop) ? prop.description : undefined, pad));
    const optional = required.has(name) ? "" : "?";
    lines.push(`${pad}${propertyKey(name)}${optional}: ${render(prop, depth + 1, indent + 1)};`);
  }
  if (isSchema(additional)) {
    lines.push(`${pad}[key: string]: ${render(additional, depth + 1, indent + 1)};`);
  }
  lines.push(`${"  ".repeat(indent)}}`);
  return lines.join("\n");
}

function renderArray(schema: Schema, depth: number, indent: number): string {
  const tuple = Array.isArray(schema.prefixItems)
    ? schema.prefixItems
    : Array.isArray(schema.items)
      ? schema.items
      : undefined;
  if (tuple) {
    return `[${tuple.map((item) => render(item, depth + 1, indent)).join(", ")}]`;
  }
  if (schema.items === undefined) return "Array<unknown>";
  return `Array<${render(schema.items, depth + 1, indent)}>`;
}

function renderType(type: string, schema: Schema, depth: number, indent: number): string {
  switch (type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return renderArray(schema, depth, indent);
    case "object":
      return renderObject(schema, depth, indent);
    default:
      return "unknown";
  }
}

function render(schema: unknown, depth: number, indent: number): string {
  if (!isSchema(schema)) return "unknown";
  if (depth > MAX_SCHEMA_DEPTH) return "unknown";
  if ("const" in schema) return literal(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return union(schema.enum.map(literal));
  }
  const branches = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : undefined;
  if (branches && branches.length > 0) {
    return union(branches.map((branch) => render(branch, depth, indent)));
  }
  const type = schema.type;
  if (Array.isArray(type)) {
    return union(
      type
        .filter((t): t is string => typeof t === "string")
        .map((t) => renderType(t, schema, depth, indent))
    );
  }
  if (typeof type === "string") return renderType(type, schema, depth, indent);
  if (isSchema(schema.properties)) return renderObject(schema, depth, indent);
  if (schema.items !== undefined || Array.isArray(schema.prefixItems)) {
    return renderArray(schema, depth, indent);
  }
  return "unknown";
}

/**
 * `schema` as the TypeScript type of a nested tool's `args` parameter.
 * A schema that is not an object, or names no properties, renders as `{}` /
 * `Record<string, unknown>` (never a primitive: nested tools take an object).
 */
export function schemaToTs(schema: unknown): string {
  if (!isSchema(schema)) return "Record<string, unknown>";
  const rendered = render({ ...schema, type: "object" }, 1, 0);
  return rendered === "unknown" ? "Record<string, unknown>" : rendered;
}
