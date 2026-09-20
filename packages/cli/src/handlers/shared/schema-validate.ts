/**
 * A minimal JSON Schema reader for TOOL schemas.
 *
 * Scope is deliberate, and recorded in this session's `decisions.md` (ruling 1):
 * the keywords a Claude Code tool `input_schema` actually uses — `type`,
 * `properties`, `required`, `enum`, `items`, `default` — and nothing else. It is
 * not a general-purpose validator and must not grow into one. The trigger to
 * replace it with a real library (`ajv`) is a tool schema in the wild that it
 * mis-validates; until then a published CLI with a `--compile` binary target
 * (`packages/cli/package.json` `build:binary`) carries no new runtime dependency
 * for this.
 *
 * The one rule that matters more than any other lives in {@link missingRequired}:
 * **presence is key presence, never truthiness.** The hand-written filter this
 * replaces tested `parsedArgs[param] === ""` and so declared a legitimately empty
 * string missing. A live `gk@grok-4.6` turn emitted
 * `Edit{…,"new_string":""}` — a deletion, the whole point of the call — and
 * claudish rejected it as "missing required parameters: new_string". The file was
 * left unchanged and the model was told its own correct call was malformed. See
 * `test-fixtures/sse-responses/grok-4.6-openai-edit-empty-new-string.sse`.
 */

/** The slice of JSON Schema this module reads. Anything else is ignored. */
export interface JsonSchemaNode {
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode | undefined>;
  required?: string[];
  enum?: unknown[];
  items?: JsonSchemaNode;
  default?: unknown;
  [key: string]: unknown;
}

/**
 * Which of the schema's `required` keys are genuinely absent from `args`?
 *
 * Present means **the key exists and its value is neither `undefined` nor
 * `null`**. `""`, `0`, `false`, `[]` and `{}` are all present values a model may
 * legitimately mean: an empty replacement string, a zero offset, a disabled flag,
 * an empty list.
 *
 * `null` counts as absent rather than present because JSON's `null` is how a
 * model spells "I have no value for this", and no Claude Code tool declares a
 * nullable required parameter.
 */
export function missingRequired(
  schema: JsonSchemaNode | undefined,
  args: Record<string, unknown> | undefined
): string[] {
  const required = schema?.required;
  if (!Array.isArray(required) || required.length === 0) return [];
  const supplied = args ?? {};
  return required.filter((key) => {
    if (typeof key !== "string") return false;
    if (!Object.hasOwn(supplied, key)) return true;
    const value = supplied[key];
    return value === undefined || value === null;
  });
}

/** Is this key absent by the same rule {@link missingRequired} uses? */
function isAbsent(args: Record<string, unknown>, key: string): boolean {
  if (!Object.hasOwn(args, key)) return true;
  const value = args[key];
  return value === undefined || value === null;
}

/** The declared type(s) of one property, normalized to a list. */
function declaredTypes(node: JsonSchemaNode | undefined): string[] {
  if (!node) return [];
  const t = node.type;
  if (typeof t === "string") return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
  // No `type`, but an `enum` — the members' own kinds are the declaration.
  // That is the ONLY thing `enum` is read for here. A value is never snapped to
  // a near-matching member: picking "all" for a model that wrote "All" is
  // choosing a value the model did not write, which is the fabrication this
  // module exists to have removed.
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    const kinds = new Set<string>();
    for (const member of node.enum) {
      if (member === null || member === undefined) continue;
      if (Array.isArray(member)) kinds.add("array");
      else if (typeof member === "object") kinds.add("object");
      else if (typeof member === "number")
        kinds.add(Number.isInteger(member) ? "integer" : "number");
      else if (typeof member === "boolean") kinds.add("boolean");
      else if (typeof member === "string") kinds.add("string");
    }
    return [...kinds];
  }
  return [];
}

/**
 * A number literal spelled out in full — never `parseInt`, which reads `"3abc"`
 * as `3` and would hand a tool an argument the model did not write.
 */
const FULL_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Coerce one value to one declared type, or return `undefined` on failure. */
function coerceOne(value: unknown, type: string, node: JsonSchemaNode | undefined): unknown {
  switch (type) {
    case "string":
      return typeof value === "string"
        ? value
        : typeof value === "number" || typeof value === "boolean"
          ? String(value)
          : undefined;
    case "number":
    case "integer": {
      if (typeof value === "number") {
        return type === "integer" && !Number.isInteger(value) ? undefined : value;
      }
      if (typeof value !== "string" || !FULL_NUMBER.test(value.trim())) return undefined;
      const n = Number(value.trim());
      if (!Number.isFinite(n)) return undefined;
      return type === "integer" && !Number.isInteger(n) ? undefined : n;
    }
    case "boolean": {
      if (typeof value === "boolean") return value;
      if (typeof value !== "string") return undefined;
      const s = value.trim().toLowerCase();
      return s === "true" ? true : s === "false" ? false : undefined;
    }
    case "array": {
      const arr = Array.isArray(value) ? value : parseJsonOfKind(value, "array");
      if (!Array.isArray(arr)) return undefined;
      const items = node?.items;
      if (!items) return arr;
      return arr.map((el) => {
        const target = declaredTypes(items);
        for (const t of target) {
          const c = coerceOne(el, t, items);
          if (c !== undefined) return c;
        }
        return el;
      });
    }
    case "object":
      return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : parseJsonOfKind(value, "object");
    default:
      return undefined;
  }
}

/** JSON-parse a string and keep it only if it decoded to the expected kind. */
function parseJsonOfKind(value: unknown, kind: "array" | "object"): unknown {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value);
    if (kind === "array") return Array.isArray(parsed) ? parsed : undefined;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Give each supplied argument the type its schema declares.
 *
 * Needed because the `<function=NAME><parameter=P>` envelope has no types at
 * all — every value arrives as a string, so a `number` parameter reaches the
 * tool as `"5"` and a `boolean` as `"true"`.
 *
 * **A failed coercion keeps the original value.** It is never dropped and never
 * replaced by a guess: the harness re-validates the call on arrival, so a wrong
 * type is visible to the user while a missing key is not. Undeclared keys are
 * left exactly as they came.
 */
export function coerceToSchema(
  schema: JsonSchemaNode | undefined,
  args: Record<string, unknown>
): { args: Record<string, unknown>; coerced: string[] } {
  const properties = schema?.properties;
  if (!properties) return { args, coerced: [] };

  const out: Record<string, unknown> = { ...args };
  const coerced: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    const node = properties[key];
    if (!node || value === undefined || value === null) continue;
    const types = declaredTypes(node);
    if (types.length === 0) continue;
    if (types.some((t) => matchesType(value, t))) continue;
    for (const t of types) {
      const c = coerceOne(value, t, node);
      if (c !== undefined) {
        out[key] = c;
        coerced.push(key);
        break;
      }
    }
  }
  return { args: coerced.length > 0 ? out : args, coerced };
}

/** Does this value already satisfy the declared type? Then leave it alone. */
function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return !!value && typeof value === "object" && !Array.isArray(value);
    case "null":
      return value === null;
    default:
      return false;
  }
}

/**
 * Fill absent REQUIRED arguments from the schema's own `default`.
 *
 * The value comes from the client's declaration of its own tool, so this is the
 * schema speaking, not us guessing. This is how `ToolSearch.max_results = 5`
 * survives the deletion of the hardcoded per-tool inference: tool-agnostically,
 * as a `default` read.
 *
 * Scoped to `required` keys ON PURPOSE. An optional parameter with a default
 * needs no help — Claude Code applies its own when it re-validates — and filling
 * every optional default would flip `repaired` to true on calls that were
 * already perfectly valid, which in `openai-sse.ts` supersedes an
 * already-streamed tool block with a second one. The narrow rule keeps
 * `repaired` meaning "this call would otherwise have failed".
 */
export function applySchemaDefaults(
  schema: JsonSchemaNode | undefined,
  args: Record<string, unknown>
): { args: Record<string, unknown>; applied: string[] } {
  const properties = schema?.properties;
  const required = schema?.required;
  if (!properties || !Array.isArray(required)) return { args, applied: [] };

  const out: Record<string, unknown> = { ...args };
  const applied: string[] = [];
  for (const key of required) {
    if (typeof key !== "string" || !isAbsent(out, key)) continue;
    const node = properties[key];
    if (!node || !Object.hasOwn(node, "default") || node.default === undefined) continue;
    out[key] = node.default;
    applied.push(key);
  }
  return { args: applied.length > 0 ? out : args, applied };
}

/**
 * Names a model reaches for when it does not use the one the schema declares.
 *
 * This is a synonym vocabulary, not a roster in CLAUDE.md's sense: it is not
 * per-user, not per-account, not time-varying, and it names no tool and no
 * agent. Every entry RENAMES A VALUE THE MODEL SUPPLIED; none invents one. The
 * gate in {@link renameToDeclaredKeys} is what makes that safe.
 */
const KEY_SYNONYMS: Record<string, string[]> = {
  command: ["cmd", "shell", "script"],
  file_path: ["path", "file", "filename"],
  content: ["text", "data", "body"],
  pattern: ["query", "search", "regex", "glob"],
  query: ["search", "keyword"],
  prompt: ["query", "task"],
};

/**
 * Move a supplied value onto the key the schema actually declares.
 *
 * Three conditions, all required, and together they are why this is not the
 * fabrication that was deleted:
 *
 *  1. the SOURCE key is one the schema does **not** declare — so nothing the
 *     tool asked for is ever overwritten or taken away;
 *  2. the TARGET key **is** declared and **is** required — so this only ever
 *     rescues a call that would otherwise fail;
 *  3. the target is **absent** — so a value the model did supply always wins.
 *
 * The value itself is untouched. A first matching synonym wins, and the source
 * key is removed so the tool does not receive both spellings.
 */
export function renameToDeclaredKeys(
  schema: JsonSchemaNode | undefined,
  args: Record<string, unknown>
): { args: Record<string, unknown>; renamed: string[] } {
  const properties = schema?.properties;
  const required = schema?.required;
  if (!properties || !Array.isArray(required)) return { args, renamed: [] };

  const out: Record<string, unknown> = { ...args };
  const renamed: string[] = [];
  for (const target of required) {
    if (typeof target !== "string") continue;
    if (!properties[target] || !isAbsent(out, target)) continue;
    for (const source of KEY_SYNONYMS[target] ?? []) {
      if (properties[source]) continue; // the schema declares it: it means something else
      if (isAbsent(out, source)) continue;
      out[target] = out[source];
      delete out[source];
      renamed.push(`${source}→${target}`);
      break;
    }
  }
  return { args: renamed.length > 0 ? out : args, renamed };
}
