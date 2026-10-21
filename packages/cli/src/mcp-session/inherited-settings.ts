/**
 * The caller's project settings, carried into a `create_session` child that runs
 * in another directory (MTL-185, claudish#284).
 *
 * Claude Code reads project-scope settings only from `<cwd>/.claude/`, and a child
 * started in `work_dir` has that as its cwd, so every plugin the caller's project
 * enables is off in the child. The layer built here is handed to the child as ONE
 * `--settings` value: Claude Code keeps only the LAST `--settings`, so a second one
 * would replace either this layer or claudish's own overlay. See
 * ai-docs/architecture/mcp-sessions.md § A work_dir child inherits the caller's
 * settings layer.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

type SettingsLayer = Record<string, unknown>;

function isPlainObject(value: unknown): value is SettingsLayer {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `values` with repeats removed, the first occurrence kept, compared by JSON value. */
function uniqueByJson(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Deep-merge two settings layers the way Claude Code merges settings sources:
 * plain objects merge recursively; arrays concatenate with duplicates removed
 * (first occurrence kept, compared by JSON value); any other value: `over` wins.
 * Neither input is mutated.
 */
export function mergeSettingsLayers(base: SettingsLayer, over: SettingsLayer): SettingsLayer {
  const merged: SettingsLayer = structuredClone(base);
  for (const [key, value] of Object.entries(over)) {
    const current = merged[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      merged[key] = mergeSettingsLayers(current, value);
    } else if (Array.isArray(current) && Array.isArray(value)) {
      merged[key] = uniqueByJson([...current, ...structuredClone(value)]);
    } else {
      merged[key] = structuredClone(value);
    }
  }
  return merged;
}

/** One layer's JSON object; anything else is `invalid_args` naming `source`. */
function parseLayer(text: string, source: string): SettingsLayer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `invalid_args: settings ${source} is not valid JSON (${(err as Error).message})`
    );
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`invalid_args: settings ${source} is not a JSON object`);
  }
  return parsed;
}

/** A `--settings` value: inline JSON when it starts with `{`, else a file path. */
function readSettingsValue(value: string): SettingsLayer {
  if (value.trim().startsWith("{")) return parseLayer(value, value);
  let text: string;
  try {
    text = readFileSync(value, "utf-8");
  } catch (err) {
    throw new Error(`invalid_args: settings ${value} cannot be read (${(err as Error).message})`);
  }
  return parseLayer(text, value);
}

/**
 * The layer a child in another directory needs to see the caller's project setup.
 * Reads `<setupFrom>/.claude/settings.json` then `<setupFrom>/.claude/settings.local.json`
 * (a missing file is skipped), then folds EVERY `--settings` value found in `callerFlags`
 * on top, in order. Both forms count: `--settings <v>` and `--settings=<v>`.
 *
 * `permissions.additionalDirectories` is removed from the result: it is `--add-dir` in
 * settings form and would widen the child's file access beyond work_dir.
 *
 * `restFlags` is `callerFlags` with every `--settings` token (and its value) removed.
 * `layer` is null when no settings file exists in setupFrom and no `--settings` was given.
 * A source that is not a JSON object throws `invalid_args:` naming it. Never writes.
 */
export function buildInheritedSettingsLayer(
  setupFrom: string,
  callerFlags: readonly string[]
): { layer: SettingsLayer | null; restFlags: string[] } {
  const layers: SettingsLayer[] = [];
  for (const name of ["settings.json", "settings.local.json"]) {
    const file = join(setupFrom, ".claude", name);
    if (!existsSync(file)) continue;
    layers.push(parseLayer(readFileSync(file, "utf-8"), file));
  }

  const restFlags: string[] = [];
  for (let i = 0; i < callerFlags.length; i++) {
    const flag = callerFlags[i];
    if (flag === "--settings") {
      const value = callerFlags[i + 1];
      if (value === undefined) throw new Error("invalid_args: --settings needs a value");
      layers.push(readSettingsValue(value));
      i++;
    } else if (flag.startsWith("--settings=")) {
      layers.push(readSettingsValue(flag.slice("--settings=".length)));
    } else {
      restFlags.push(flag);
    }
  }

  if (layers.length === 0) return { layer: null, restFlags };
  const layer = layers.reduce((acc, next) => mergeSettingsLayers(acc, next), {});
  if (isPlainObject(layer.permissions)) delete layer.permissions.additionalDirectories;
  return { layer, restFlags };
}

/**
 * The setup directory a create_session call uses: `null` opts out, a string is
 * resolved, `undefined` is the server's cwd (the caller's project). Undefined when
 * that is the child's own directory, whose files Claude Code already reads natively.
 */
export function resolveSetupFrom(
  arg: unknown,
  workDir: string | undefined,
  serverCwd: string
): string | undefined {
  if (arg === null) return undefined;
  const setupFrom = typeof arg === "string" ? resolve(arg) : serverCwd;
  return setupFrom === resolve(workDir ?? serverCwd) ? undefined : setupFrom;
}
