import { loadConfig, loadLocalConfig } from "../profile-config.js";
import type { RoutingRules, RoutingEntry } from "../profile-config.js";
import type { FallbackRoute } from "./auto-route.js";
import { PROVIDER_TO_PREFIX, DISPLAY_NAMES } from "./auto-route.js";
import { PROVIDER_SHORTCUTS } from "./model-parser.js";
import { resolveModelNameSync } from "./model-catalog-resolver.js";

/**
 * Load effective routing rules (local replaces global entirely).
 * Returns null if no routing configured.
 * Warns about invalid patterns/entries at load time.
 */
export function loadRoutingRules(): RoutingRules | null {
  const local = loadLocalConfig();
  if (local?.routing && Object.keys(local.routing).length > 0) {
    validateRoutingRules(local.routing);
    return local.routing;
  }
  const global_ = loadConfig();
  if (global_.routing && Object.keys(global_.routing).length > 0) {
    validateRoutingRules(global_.routing);
    return global_.routing;
  }
  return null;
}

/** Warn about config issues that would silently misbehave. */
function validateRoutingRules(rules: RoutingRules): void {
  for (const key of Object.keys(rules)) {
    // Multi-wildcard patterns only use the first *, rest become literals
    if (key !== "*" && (key.match(/\*/g) || []).length > 1) {
      console.error(
        `[claudish] Warning: routing pattern "${key}" has multiple wildcards — only single * is supported. This pattern may not match as expected.`
      );
    }
    // Empty chain
    const entries = rules[key];
    if (!Array.isArray(entries) || entries.length === 0) {
      console.error(
        `[claudish] Warning: routing rule "${key}" has no provider entries — models matching this pattern will have no fallback chain.`
      );
    }
  }
}

/**
 * Match a model name against routing rules.
 * Priority: exact → longest glob → "*" catch-all → null (use default chain).
 */
export function matchRoutingRule(modelName: string, rules: RoutingRules): RoutingEntry[] | null {
  // 1. Exact match
  if (rules[modelName]) return rules[modelName];

  // 2. Glob patterns (sorted longest-first = most specific)
  const globKeys = Object.keys(rules)
    .filter((k) => k !== "*" && k.includes("*"))
    .sort((a, b) => b.length - a.length);

  for (const pattern of globKeys) {
    if (globMatch(pattern, modelName)) return rules[pattern];
  }

  // 3. Catch-all
  if (rules["*"]) return rules["*"];

  return null;
}

/**
 * Convert routing entries to FallbackRoute objects.
 * Plain name "provider" uses originalModelName.
 * Explicit "provider@model" uses the specified model.
 */
export function buildRoutingChain(
  entries: RoutingEntry[],
  originalModelName: string
): FallbackRoute[] {
  const routes: FallbackRoute[] = [];

  for (const entry of entries) {
    const atIdx = entry.indexOf("@");
    let providerRaw: string;
    let modelName: string;

    if (atIdx !== -1) {
      providerRaw = entry.slice(0, atIdx);
      modelName = entry.slice(atIdx + 1);
    } else {
      providerRaw = entry;
      modelName = originalModelName;
    }

    // Resolve shortcut
    const provider = PROVIDER_SHORTCUTS[providerRaw.toLowerCase()] ?? providerRaw.toLowerCase();

    // Build modelSpec
    let modelSpec: string;
    if (provider === "openrouter") {
      const resolution = resolveModelNameSync(modelName, "openrouter");
      modelSpec = resolution.resolvedId;
    } else {
      const prefix = PROVIDER_TO_PREFIX[provider] ?? provider;
      modelSpec = `${prefix}@${modelName}`;
    }

    const displayName = DISPLAY_NAMES[provider] ?? provider;
    routes.push({ provider, modelSpec, displayName });
  }

  return routes;
}

/** Single-wildcard glob: "kimi-*" matches "kimi-k2.5" */
function globMatch(pattern: string, value: string): boolean {
  const star = pattern.indexOf("*");
  if (star === -1) return pattern === value;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  return (
    value.startsWith(prefix) &&
    value.endsWith(suffix) &&
    value.length >= prefix.length + suffix.length
  );
}
