/**
 * Code mode for `openai-codex`: the user's setting.
 *
 * Precedence: `--code-mode <auto|on|off>` > `CLAUDISH_CODE_MODE` > `codeMode`
 * in the project `.claudish.json` > `codeMode` in the global config > the
 * default. The default is `off` until code mode has passed live validation;
 * `auto` then turns it on where the Codex `/models` endpoint reports
 * `tool_mode: code_mode_only`.
 *
 * Pure: no imports from the request path, so the CLI can read it without
 * loading anything else of code mode.
 */

/** `auto`: on where discovery says so; `on`: forced; `off`: never. */
export type CodeModeSetting = "auto" | "on" | "off";

/** Every accepted value, for parsing and for messages. */
export const CODE_MODE_SETTINGS: readonly CodeModeSetting[] = ["auto", "on", "off"];

/** The setting when nothing states one. */
export const DEFAULT_CODE_MODE_SETTING: CodeModeSetting = "off";

/** The env var that sets code mode when no flag does. */
export const CODE_MODE_ENV_VAR = "CLAUDISH_CODE_MODE";

/**
 * `value` as a setting (trimmed, case-insensitive), or undefined when it is
 * not one of `auto`, `on`, `off`.
 */
export function parseCodeModeSetting(value: unknown): CodeModeSetting | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  return (CODE_MODE_SETTINGS as readonly string[]).includes(v) ? (v as CodeModeSetting) : undefined;
}
