// Classifier passthrough — detect Claude Code's auto-mode permission classifier
// request by CONTENT (a marker in its system prompt) and resolve the opt-in config
// that reroutes it to native Anthropic while the main loop runs on another provider.
//
// This module is intentionally dependency-light (only a type import) and free of
// cycles with cli.ts / proxy-server.ts, mirroring default-provider.ts, so it can be
// unit-tested in isolation.

import type { ClaudishConfig } from "./types.js";

/**
 * Anchor prefix of the auto-mode permission classifier's system prompt.
 *
 * Claude Code's auto-mode ("--permission-mode auto") sends a dedicated request whose
 * `system` array contains a text block that starts with this sentence. The request's
 * `system[0]` is a separate `x-anthropic-billing-header:` block, so detection must scan
 * ALL system blocks (see isAutoModeClassifierRequest), not just the first.
 *
 * Pinned as a single constant so a Claude Code version bump is a one-line update.
 * Verify verbatim from a `--debug-claudish` capture if the wording ever drifts.
 */
export const CLASSIFIER_SYSTEM_MARKER =
  "You are a security monitor for autonomous AI coding agents.";

/**
 * Default native Claude model the classifier is rewritten onto when the passthrough is
 * enabled without an explicit model. Must be a currently-valid Anthropic API model id.
 * Sonnet is fast, cheap, and correct for the classifier.
 */
export const DEFAULT_CLASSIFIER_MODEL = "claude-sonnet-5";

export interface ClassifierConfig {
  /** Whether classifier passthrough is active for this session. */
  enabled: boolean;
  /** Native Claude model id the classifier request is rewritten onto. */
  model: string;
}

type ClassifierConfigInput = Pick<ClaudishConfig, "classifierModel" | "classifierProvider">;

/**
 * Extract the text of a single Claude Messages `system` content block, or null if the
 * block carries no usable text. Accepts a bare string element or a `{type:"text",text}`
 * object; skips everything else. Never throws.
 */
function blockText(block: unknown): string | null {
  if (typeof block === "string") return block;
  if (
    block &&
    typeof block === "object" &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
  ) {
    return (block as { text: string }).text;
  }
  return null;
}

/**
 * Allocation-free test for "text, ignoring leading whitespace, starts with the marker".
 * Avoids `trimStart()` — which copies the whole (often multi-KB) system block — on the
 * per-request hot path.
 */
function startsWithMarker(text: string): boolean {
  let i = 0;
  while (i < text.length) {
    const ch = text.charCodeAt(i);
    // space, tab, LF, CR, form feed, vertical tab
    if (ch !== 32 && ch !== 9 && ch !== 10 && ch !== 13 && ch !== 12 && ch !== 11) break;
    i++;
  }
  return text.startsWith(CLASSIFIER_SYSTEM_MARKER, i);
}

/**
 * True iff the request body looks like Claude Code's auto-mode permission classifier —
 * i.e. ANY of its `system` text blocks (ignoring leading whitespace) starts with
 * CLASSIFIER_SYSTEM_MARKER. Handles the string-vs-array `system` duality, short-circuits
 * on the first match, and allocates nothing. Never throws.
 */
export function isAutoModeClassifierRequest(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const system = (body as { system?: unknown }).system;
  if (typeof system === "string") return startsWithMarker(system);
  if (!Array.isArray(system)) return false;
  for (const block of system) {
    const text = blockText(block);
    if (text !== null && startsWithMarker(text)) return true;
  }
  return false;
}

/**
 * Prepare a detected classifier request for the native Anthropic passthrough: force it
 * onto `model` and strip fields a rewritten model is most likely to reject. The
 * classifier is a fast, structured call, so `thinking` (extended-thinking config) is
 * dropped — it's the most likely 400 trigger when the model is swapped (thinking +
 * forced tool_choice / non-default temperature). Mutates `body` in place. Extend the
 * strip list (temperature/top_p/top_k) if a captured payload / E2E surfaces a 400.
 */
export function rewriteClassifierForNative(body: Record<string, unknown>, model: string): void {
  body.model = model;
  delete body.thinking;
}

/**
 * Resolve the classifier-passthrough opt-in. Enabled (default OFF) when any of:
 *   - `--classifier-model <m>` flag (config.classifierModel)
 *   - `--classifier-provider anthropic` flag (config.classifierProvider)
 *   - `CLAUDISH_CLASSIFIER_PROVIDER=anthropic` env
 *   - `CLAUDISH_CLASSIFIER_MODEL=<m>` env
 * Model precedence when enabled: flag model → env model → DEFAULT_CLASSIFIER_MODEL.
 */
export function resolveClassifierConfig(
  config: ClassifierConfigInput,
  env: NodeJS.ProcessEnv = process.env
): ClassifierConfig {
  const flagModel = config.classifierModel?.trim();
  const flagProvider = config.classifierProvider?.trim().toLowerCase();
  const envProvider = env.CLAUDISH_CLASSIFIER_PROVIDER?.trim().toLowerCase();
  const envModel = env.CLAUDISH_CLASSIFIER_MODEL?.trim();

  const enabled =
    !!flagModel || flagProvider === "anthropic" || envProvider === "anthropic" || !!envModel;

  // When disabled, both flagModel and envModel are necessarily empty, so `model`
  // resolves to the default — one return covers both cases.
  return { enabled, model: flagModel || envModel || DEFAULT_CLASSIFIER_MODEL };
}

/** Convenience wrapper: whether classifier passthrough is enabled for this session. */
export function classifierPassthroughEnabled(
  config: ClassifierConfigInput,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return resolveClassifierConfig(config, env).enabled;
}
