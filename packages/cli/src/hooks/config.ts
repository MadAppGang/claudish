/**
 * Hook-system configuration: the `hooks` key's schema, severity resolution, and
 * the two reporters for config that is no longer read.
 *
 * Validation lives here rather than in profile-config.ts on purpose — that
 * module is deliberately Zod-free because `loadConfig` runs on many lightweight
 * startup paths. Same rule as custom endpoints: validate at the point of
 * consumption, warn and fall back rather than throwing, so a malformed `hooks`
 * block can never stop claudish from starting.
 *
 * `hooks` is read from the GLOBAL config only (`~/.claudish/config.json`, or the
 * `--config` / `CLAUDISH_CONFIG` override, which replaces both scopes). A
 * project `.claudish.json` is repo-controlled, and executing code it names would
 * need a trust model claudish does not have.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { getConfigFileOverride } from "../config-override.js";
import { logStderr } from "../logger.js";
import { activeConfigFile, getLocalConfigPath } from "../profile-config.js";
import type { Severity } from "./public.js";

const SeveritySchema = z.enum(["off", "warn", "fix"]);

/** Default and bounds of the host cap on consecutive hook-caused turns. */
export const INJECTION_MAX_CONSECUTIVE_DEFAULT = 3;

export const HooksConfigSchema = z.object({
  /** Loaded in order. Absolute, "~/…", or relative to the CONFIG FILE's directory. */
  modules: z.array(z.string().min(1)).optional(),
  /** "[modelGlob:]hookIdGlob" → severity. */
  severity: z.record(z.string(), SeveritySchema).optional(),
  injection: z
    .object({
      maxConsecutive: z.number().int().min(1).max(20).optional(),
    })
    .optional(),
  observer: z
    .object({
      enabled: z.boolean().optional(),
      // "enforce" is deliberately NOT accepted. The observer is advisory and
      // fire-and-forget; a user who asks for enforcement must be told it does
      // not exist, not left believing their calls are being gated.
      mode: z.enum(["off", "suggest"]).optional(),
      model: z.string().optional(),
      timeoutMs: z.number().int().positive().optional(),
      watchTools: z.array(z.string()).optional(),
    })
    .optional(),
  /** Behaviour-telemetry upload consent. Default off. Local journaling is always on. */
  telemetry: z.object({ enabled: z.boolean().optional() }).optional(),
});

export type HooksConfig = z.infer<typeof HooksConfigSchema>;

/** Where warnings go. A parameter so tests can capture them without touching stderr. */
export type WarnSink = (line: string) => void;

/** `logStderr` prefixes `[claudish] ` itself. */
const defaultWarn: WarnSink = (line) => logStderr(line);

/**
 * Parse a raw `hooks` value. Invalid input warns once per Zod issue and degrades
 * to `{}`: built-in hooks run at their default severity and no user module
 * loads. claudish always starts.
 */
export function parseHooksConfig(raw: unknown, warn: WarnSink = defaultWarn): HooksConfig {
  if (raw === undefined || raw === null) return {};
  const result = HooksConfigSchema.safeParse(raw);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const where = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      warn(`hooks config: ${where}${issue.message}`);
    }
    return {};
  }
  return result.data;
}

/** The host cap on consecutive hook-caused turns for this config. */
export function maxConsecutiveInjections(config: HooksConfig): number {
  return config.injection?.maxConsecutive ?? INJECTION_MAX_CONSECUTIVE_DEFAULT;
}

/**
 * The directory relative module paths resolve against: the ACTIVE config file's
 * directory, never `process.cwd()` — in a pane child the cwd is the MCP
 * server's.
 */
export function hooksConfigDir(): string {
  return dirname(activeConfigFile());
}

/* ───────────── severity ───────────── */

/**
 * Resolve the effective severity for a hook id.
 *
 * Ported verbatim from the behavior layer (`behavior/config.ts`), with the map
 * now read from `hooks.severity`. Precedence: model-scoped keys beat unscoped
 * ones; within a tier an exact id beats a glob and a longer glob beats a
 * shorter one; otherwise the hook's own default.
 *
 *   { "plan-mode/*": "off", "plan-mode/plan-file-path": "fix" }
 */
export function resolveSeverity(
  hookId: string,
  defaultSeverity: Severity,
  severityMap: Record<string, Severity> | undefined,
  modelId?: string
): Severity {
  const rules = severityMap;
  if (!rules) return defaultSeverity;

  // Model-scoped keys beat unscoped ones. Nothing transfers between models — a
  // rule proven on one is a hypothesis on the next — so a user must be able to
  // arm a rule for the model that needs it without arming it for every model:
  //
  //   { "plan-mode/*": "warn", "gpt-5.6-*:plan-mode/plan-file-path": "fix" }
  //
  // Pass 1 considers only `model:rule` keys, pass 2 only unscoped keys.
  if (modelId) {
    const scoped = bestMatch(rules, hookId, modelId);
    if (scoped) return scoped;
  }
  return bestMatch(rules, hookId, undefined) ?? defaultSeverity;
}

/**
 * Best matching severity within one scope tier.
 *
 * Specificity wins: an exact match beats a glob, and a longer glob beats a
 * shorter one, so `{"plan-mode/*":"off","plan-mode/plan-file-path":"fix"}`
 * re-enables the single rule.
 */
function bestMatch(
  rules: Record<string, Severity>,
  ruleId: string,
  modelId: string | undefined
): Severity | null {
  let best: { score: number; severity: Severity } | null = null;

  for (const [key, severity] of Object.entries(rules)) {
    const { model: keyModel, rule: keyRule } = parseRuleKey(key);
    if (!scopeMatches(keyModel, modelId)) continue;
    if (!globMatches(keyRule, ruleId)) continue;
    const score = specificity(keyRule);
    if (!best || score > best.score) best = { score, severity };
  }

  return best ? best.severity : null;
}

/**
 * Split a config key into its optional model scope and its rule pattern.
 *
 * A `:` only introduces a model scope when it precedes the rule namespace. Rule
 * ids themselves never contain one, but HOOK ids look like `hook:file/rule` —
 * an unanchored split would silently mis-read every hook rule as model-scoped.
 */
function parseRuleKey(key: string): { model?: string; rule: string } {
  const sep = key.indexOf(":");
  if (sep <= 0 || key.startsWith("hook:")) return { rule: key };
  return { model: key.slice(0, sep), rule: key.slice(sep + 1) };
}

/** Scoped keys match only in the scoped pass, unscoped keys only in the unscoped pass. */
function scopeMatches(keyModel: string | undefined, modelId: string | undefined): boolean {
  if (modelId === undefined) return keyModel === undefined;
  return keyModel !== undefined && globMatches(keyModel, modelId);
}

/** Exact beats glob; among globs, more literal characters wins. */
function specificity(pattern: string): number {
  return pattern.includes("*") ? pattern.replace(/\*/g, "").length : Number.MAX_SAFE_INTEGER;
}

/** `*` matches any run of characters, including `/`. Anchored at both ends. */
export function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

/* ───────────── reporters ───────────── */

/** Pre-hook-system `behavior` keys and what replaced each. */
const BEHAVIOR_MOVES: ReadonlyArray<readonly [string, string]> = [
  ["rules", "behavior.rules → hooks.severity"],
  [
    "hooks",
    "behavior.hooks → hooks.modules (modules must be rewritten to the claudish/hooks contract, apiVersion: 1)",
  ],
  ["observer", "behavior.observer → hooks.observer"],
  [
    "telemetry",
    "behavior.telemetry → hooks.telemetry (consent is NOT carried over: set hooks.telemetry.enabled yourself)",
  ],
  ["preset", "behavior.preset → removed"],
];

let behaviorReported = false;

/**
 * Report a `behavior` block in the global config, once per process.
 *
 * Reported, never migrated: old modules cannot be ported mechanically, so an
 * automatic rewrite would point `hooks.modules` at files that fail the shape
 * check, and copying telemetry consent silently would launder it.
 *
 * @returns true when it printed.
 */
export function reportBehaviorBlock(behavior: unknown, warn: WarnSink = defaultWarn): boolean {
  if (behaviorReported || behavior === undefined || behavior === null) return false;
  behaviorReported = true;
  const keys =
    typeof behavior === "object" && !Array.isArray(behavior)
      ? Object.keys(behavior as Record<string, unknown>)
      : [];
  warn('the "behavior" config block is no longer read. Move it to "hooks":');
  const relevant = BEHAVIOR_MOVES.filter(([key]) => keys.includes(key));
  for (const [, line] of relevant.length > 0 ? relevant : BEHAVIOR_MOVES) warn(`  ${line}`);
  return true;
}

let projectHooksReported = false;

/**
 * Report a `hooks` key in the project `.claudish.json`, once per process.
 *
 * With a `--config` / `CLAUDISH_CONFIG` override the project scope is suppressed
 * entirely, so there is nothing to report.
 *
 * @returns true when it printed.
 */
export function reportProjectHooks(
  projectConfigPath: string = getLocalConfigPath(),
  warn: WarnSink = defaultWarn
): boolean {
  if (projectHooksReported || getConfigFileOverride()) return false;
  try {
    if (!existsSync(projectConfigPath)) return false;
    const parsed = JSON.parse(readFileSync(projectConfigPath, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || !("hooks" in parsed)) return false;
  } catch {
    // An unreadable or garbled project file is someone else's error to report.
    return false;
  }
  projectHooksReported = true;
  warn(`hooks in ${projectConfigPath} ignored: hooks are read from the global config only`);
  return true;
}

/** Test seam: let both reporters print again. */
export function resetConfigReportersForTests(): void {
  behaviorReported = false;
  projectHooksReported = false;
}
