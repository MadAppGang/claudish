/**
 * The model variables claudish sets in a Claude Code child, and their removal
 * where a later launch must not inherit them.
 *
 * Every claudish launch with a model sets `ANTHROPIC_MODEL` and
 * `ANTHROPIC_SMALL_FAST_MODEL` in the Claude Code child's environment. From
 * there both reach every process that session starts: tool shells, a nested
 * `claudish`, the claudish MCP server. A nested launch that sets neither (one
 * that starts on Claude's default model, or a profile launch with no `--model`)
 * would otherwise start Claude Code on the parent's model, and on a launch that
 * keeps the user's Claude login a claudish provider spec there is a model Claude
 * Code cannot serve.
 *
 * `CLAUDISH_SET_MODEL_VARS` records what claudish set, as JSON (name → value).
 * A nested launch reads that record twice: `parseArgs` does not take an
 * `ANTHROPIC_MODEL` that still equals the recorded value as its launch model
 * (`isModelVarSetByClaudish`), and the child's environment drops a variable
 * whose value still equals the recorded one (`scrubInheritedModelVars`). On a launch
 * whose child keeps the user's login, a value that is an explicit claudish
 * provider spec is removed too, record or not: a claudish older than the record
 * set it, and Claude Code on a login cannot serve it. On a proxy-auth launch the
 * proxy routes such a spec, so a value the user exported themselves stays.
 *
 * Imports nothing heavier than the model parser, so the MCP print child can use
 * it as well as the launcher.
 */
import { ENV } from "./config.js";
import { parseModelSpec } from "./providers/model-parser.js";

/** The two variables claudish sets in a child and records. */
export type ModelVarName = "ANTHROPIC_MODEL" | "ANTHROPIC_SMALL_FAST_MODEL";

const MODEL_VAR_NAMES: readonly ModelVarName[] = ["ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL"];

/**
 * Write each given variable into `env` and record its value in
 * `CLAUDISH_SET_MODEL_VARS`. Called wherever claudish sets one of the two.
 * With nothing given, no record is written.
 */
export function recordModelVars(
  env: Record<string, string | undefined>,
  set: Partial<Record<ModelVarName, string>>
): void {
  const record: Partial<Record<ModelVarName, string>> = {};
  for (const name of MODEL_VAR_NAMES) {
    const value = set[name];
    if (typeof value !== "string" || value.length === 0) continue;
    env[name] = value;
    record[name] = value;
  }
  if (Object.keys(record).length > 0) {
    env[ENV.CLAUDISH_SET_MODEL_VARS] = JSON.stringify(record);
  }
}

/** The recorded values, or an empty record when there is none or it cannot be read. */
function readRecord(
  env: Record<string, string | undefined>
): Partial<Record<ModelVarName, string>> {
  const raw = env[ENV.CLAUDISH_SET_MODEL_VARS];
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record: Partial<Record<ModelVarName, string>> = {};
    for (const name of MODEL_VAR_NAMES) {
      const value = (parsed as Record<string, unknown>)[name];
      if (typeof value === "string") record[name] = value;
    }
    return record;
  } catch {
    return {};
  }
}

/**
 * True when `env[name]` still holds the value a parent claudish recorded for it
 * in `CLAUDISH_SET_MODEL_VARS`: the variable was set by claudish, not by the
 * user. `parseArgs` skips such an `ANTHROPIC_MODEL` as the launch model.
 */
export function isModelVarSetByClaudish(
  env: Record<string, string | undefined>,
  name: ModelVarName
): boolean {
  const value = env[name];
  return typeof value === "string" && value.length > 0 && readRecord(env)[name] === value;
}

/** An explicit claudish provider spec (`devin@swe-1.7`), not the Claude subscription. */
function isClaudishProviderSpec(value: string): boolean {
  const parsed = parseModelSpec(value);
  return parsed.isExplicitProvider && parsed.provider !== "native-anthropic";
}

export interface ModelVarsScrub {
  /** Names removed, never values. */
  removed: string[];
  /**
   * Values that stay in the child although claudish did not set them this
   * launch: a user's own `ANTHROPIC_MODEL` / `ANTHROPIC_SMALL_FAST_MODEL`, and
   * `ANTHROPIC_DEFAULT_HAIKU_MODEL`, which claudish never sets or removes.
   */
  survived: Array<{ name: string; value: string }>;
}

/**
 * Remove the inherited model variables claudish set, for a launch that does not
 * set them itself. `keep.model` / `keep.smallFast`: this launch sets that
 * variable, so it is neither removed nor reported. `opts.keepsLogin`: the child
 * keeps the user's Claude login, so an explicit claudish provider spec is
 * removed even with no record. The record itself is always removed. Mutates
 * `env` in place.
 */
export function scrubInheritedModelVars(
  env: Record<string, string | undefined>,
  keep: { model: boolean; smallFast: boolean },
  opts: { keepsLogin?: boolean } = {}
): ModelVarsScrub {
  const record = readRecord(env);
  const removed: string[] = [];
  const survived: Array<{ name: string; value: string }> = [];
  for (const name of MODEL_VAR_NAMES) {
    if (name === "ANTHROPIC_MODEL" ? keep.model : keep.smallFast) continue;
    const value = env[name];
    if (typeof value !== "string" || value.length === 0) continue;
    const setByClaudish = record[name] === value;
    if (setByClaudish || (opts.keepsLogin === true && isClaudishProviderSpec(value))) {
      delete env[name];
      removed.push(name);
    } else {
      survived.push({ name, value });
    }
  }
  if (ENV.CLAUDISH_SET_MODEL_VARS in env) delete env[ENV.CLAUDISH_SET_MODEL_VARS];
  const haiku = env[ENV.ANTHROPIC_DEFAULT_HAIKU_MODEL];
  if (typeof haiku === "string" && haiku.length > 0) {
    survived.push({ name: ENV.ANTHROPIC_DEFAULT_HAIKU_MODEL, value: haiku });
  }
  return { removed, survived };
}
