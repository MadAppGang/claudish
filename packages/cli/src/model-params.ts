/**
 * --model-params parsing and payload merging.
 *
 * `--model-params k=v[,k=v...]` injects arbitrary extra request parameters into
 * the outbound provider payload (deep-merged AFTER the adapter's
 * buildPayload/prepareRequest, so user params win over adapter defaults).
 *
 * Parsing rules:
 * - Items split on commas; each item is `key=value` (the value may contain `=`
 *   after the first).
 * - Values are JSON-coerced when they parse as JSON (numbers, true/false,
 *   null, quoted strings); otherwise kept as raw strings.
 * - Dot-notation keys create nested objects: `reasoning.mode=pro` →
 *   `{ reasoning: { mode: "pro" } }`.
 * - The flag may repeat; later occurrences merge over earlier ones (pass the
 *   accumulated map back in as `into`).
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep-merge `source` into `target` (mutates and returns `target`).
 * Objects merge recursively; scalars and arrays replace. Object values copied
 * FROM `source` are cloned so later in-place payload mutations can't write
 * back into a shared params map (the same map is reused on every request).
 */
export function deepMergeParams(
  target: Record<string, any>,
  source: Record<string, unknown>
): Record<string, any> {
  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(value) && isPlainObject(target[key])) {
      deepMergeParams(target[key], value);
    } else if (isPlainObject(value)) {
      target[key] = deepMergeParams({}, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

/** JSON-coerce a raw value: numbers/booleans/null/quoted strings parse; everything else stays a raw string. */
function coerceValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Parse one `--model-params` flag value into (or on top of) `into`.
 * Throws on malformed items (missing `=`, empty key/segment) — the CLI layer
 * catches and exits with the message.
 */
export function parseModelParams(
  spec: string,
  into: Record<string, unknown> = {}
): Record<string, unknown> {
  for (const item of spec.split(",")) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      throw new Error(`--model-params item "${trimmed}" must be key=value`);
    }
    const key = trimmed.slice(0, eq).trim();
    const raw = trimmed.slice(eq + 1);
    const path = key.split(".");
    if (path.some((seg) => seg.length === 0)) {
      throw new Error(`--model-params key "${key}" has an empty dot segment`);
    }

    // Build the nested single-entry object for this item, then deep-merge so
    // repeated keys / sibling dot-paths combine instead of clobbering.
    const nested: Record<string, unknown> = {};
    let cursor = nested;
    for (const seg of path.slice(0, -1)) {
      const child: Record<string, unknown> = {};
      cursor[seg] = child;
      cursor = child;
    }
    cursor[path[path.length - 1]] = coerceValue(raw);
    deepMergeParams(into, nested);
  }
  return into;
}
