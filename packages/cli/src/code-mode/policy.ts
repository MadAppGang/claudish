/**
 * Code mode for `openai-codex`: the user's setting.
 *
 * Precedence: `--code-mode <auto|on|off>` > `CLAUDISH_CODE_MODE` > `codeMode`
 * in the project `.claudish.json` > `codeMode` in the global config > the
 * default, `auto`: on where the Codex `/models` endpoint reports
 * `tool_mode: code_mode_only`, and only for `openai-codex` on the OAuth arm
 * with tools declared. `off` turns it off everywhere.
 *
 * Pure: no runtime imports from the request path (types only), so the CLI can
 * read it without loading anything else of code mode.
 */

import type { CredentialArm } from "../auth/credentials/types.js";
import type { ClaudeToolChoice } from "../handlers/shared/format/openai-tools.js";
import type { CodexModelInfo } from "../providers/codex-models-discovery.js";
import type { WireApi } from "../providers/connection-wire.js";

/** `auto`: on where discovery says so; `on`: forced; `off`: never. */
export type CodeModeSetting = "auto" | "on" | "off";

/** Every accepted value, for parsing and for messages. */
export const CODE_MODE_SETTINGS: readonly CodeModeSetting[] = ["auto", "on", "off"];

/** The setting when nothing states one. */
export const DEFAULT_CODE_MODE_SETTING: CodeModeSetting = "auto";

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

/** The `tool_mode` value `/models` publishes for models the official client drives in code mode. */
export const CODE_MODE_ONLY_TOOL_MODE = "code_mode_only";

/** Why a request is or is not in code mode. */
export type CodeModeDecision =
  | {
      on: false;
      reason:
        | "not-openai-codex"
        | "metered-arm"
        | "no-account-id"
        | "not-responses"
        | "no-tools"
        | "forced-tool-choice"
        | "no-session-id"
        | "setting-off"
        | "discovery-unknown"
        | "classic-by-discovery"
        | "sandbox-unavailable";
    }
  | { on: true; shape: "lite" | "classic"; reason: "discovery" | "forced" | "pinned" };

export interface CodeModeDecisionInput {
  providerName: string;
  /** From THIS request's auth binding. */
  arm: CredentialArm | undefined;
  /** `accountKeyFromBinding`; undefined when the login has no account id. */
  accountKey: string | undefined;
  api: WireApi | undefined;
  hasTools: boolean;
  toolChoice: ClaudeToolChoice | null | undefined;
  hasSessionId: boolean;
  setting: CodeModeSetting;
  modelInfo?: CodexModelInfo;
  /** This session already relayed an exec (its arm is still OAuth). */
  pinned: boolean;
  sandboxAvailable: boolean;
  /** A lite request was rejected for this model within the discovery TTL. */
  liteFallbackActive: boolean;
}

/** `tool_choice` absent or `auto`: the only choices code mode honours exactly. */
function isAutoToolChoice(choice: ClaudeToolChoice | null | undefined): boolean {
  return !choice || choice.type === undefined || choice.type === "auto";
}

/**
 * The code-mode decision for one request (architecture §5.1).
 *
 * On only if all hold: claudish provider `openai-codex`; the setting is not
 * `off`; the binding's arm is `oauth`; an account key exists; the wire API is
 * Responses; the request declares ≥ 1 tool; `tool_choice` is absent or `auto`
 * (a named tool, `any` or `none` stays classic, which honours it exactly); the
 * request carries a Claude Code session id; the sandbox loads. Then `on`
 * forces; `auto` needs discovery's `tool_mode: code_mode_only`, or a pinned
 * session (one that already relayed an exec, so a later discovery failure
 * cannot flip a code-mode conversation back). The shape is `lite` iff
 * discovery says `use_responses_lite` and no lite rejection is remembered.
 */
export function decideCodeMode(i: CodeModeDecisionInput): CodeModeDecision {
  if (i.providerName !== "openai-codex") return { on: false, reason: "not-openai-codex" };
  if (i.setting === "off") return { on: false, reason: "setting-off" };
  if (i.arm !== "oauth") return { on: false, reason: "metered-arm" };
  if (!i.accountKey) return { on: false, reason: "no-account-id" };
  if (i.api !== "responses") return { on: false, reason: "not-responses" };
  if (!i.hasTools) return { on: false, reason: "no-tools" };
  if (!isAutoToolChoice(i.toolChoice)) return { on: false, reason: "forced-tool-choice" };
  if (!i.hasSessionId) return { on: false, reason: "no-session-id" };
  if (!i.sandboxAvailable) return { on: false, reason: "sandbox-unavailable" };

  const shape: "lite" | "classic" =
    i.modelInfo?.useResponsesLite === true && !i.liteFallbackActive ? "lite" : "classic";
  if (i.setting === "on") return { on: true, shape, reason: "forced" };
  if (i.modelInfo?.toolMode === CODE_MODE_ONLY_TOOL_MODE) {
    return { on: true, shape, reason: "discovery" };
  }
  if (i.pinned) return { on: true, shape, reason: "pinned" };
  if (!i.modelInfo) return { on: false, reason: "discovery-unknown" };
  return { on: false, reason: "classic-by-discovery" };
}

/** `[CodeMode] on (lite, discovery: code_mode_only)` / `[CodeMode] off (<reason>)`. */
export function describeCodeModeDecision(
  decision: CodeModeDecision,
  modelInfo: CodexModelInfo | undefined
): string {
  if (!decision.on) return `[CodeMode] off (${decision.reason})`;
  const why =
    decision.reason === "discovery"
      ? `discovery: ${modelInfo?.toolMode ?? CODE_MODE_ONLY_TOOL_MODE}`
      : decision.reason;
  return `[CodeMode] on (${decision.shape}, ${why})`;
}
