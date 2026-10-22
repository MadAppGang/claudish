/**
 * An explicit spec whose provider shortcut names no claudish provider.
 *
 * `parseModelSpec` passes an unknown shortcut through as the provider name, so before
 * this module `go@gemini-3.8-flash` (`go@` was removed in v7.36.0) reached the credential
 * filter and was answered `No credentials configured for "go"`: a credential hunt for a
 * name that cannot exist (model-failures-2026-10-21.md, D9). Routing, the proxy and
 * every display built on `explainRoute` (preflight, `--probe`, the config TUI) now ask
 * {@link isKnownProviderName} first and print {@link describeUnknownShortcut}'s two
 * strings, so the same spec is never worded two ways.
 *
 * The suggestions come from the route candidates gathered for the model, spelled as the
 * shortcut table spells them. No model id and no provider name is hardcoded here, and
 * no alias is added for a removed shortcut (CLAUDE.md, static values).
 */
import { loadConfig } from "../profile-config.js";
import { ensureEndpointsRegistered } from "./endpoint-registration.js";
import { PREDEFINED_ENDPOINTS } from "./predefined-catalog.js";
import { getProviderByName, getShortcuts, getShortestPrefix } from "./provider-definitions.js";
import { gatherRouteCandidates } from "./route-candidates.js";
import { hopLabel } from "./routing-rules.js";

/** The raw-URL provider `parseModelSpec` produces for `http(s)://…`; it has no definition. */
const CUSTOM_URL_PROVIDER = "custom-url";

/**
 * A name claudish can route an explicit spec to, whether or not it holds a credential:
 * a builtin or runtime-registered provider or one of its declared shortcuts (resolved
 * through `getShortcuts`, so `g` is known because it names `google`), a bundled
 * endpoint (known even with no key, so it keeps the credential message), a
 * `customEndpoints` key in the global config
 * (known even when its registration failed, so the recorded reason still wins), or
 * `custom-url`.
 */
export function isKnownProviderName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === CUSTOM_URL_PROVIDER) return true;
  // Latched and config-only; routing calls it on the same path.
  ensureEndpointsRegistered();
  if (getProviderByName(lower)) return true;
  const viaShortcut = getShortcuts()[lower];
  if (viaShortcut !== undefined && getProviderByName(viaShortcut)) return true;
  if (PREDEFINED_ENDPOINTS.some((endpoint) => endpoint.name === lower)) return true;
  const custom = loadConfig().customEndpoints;
  return custom !== undefined && Object.keys(custom).some((key) => key.toLowerCase() === lower);
}

/** One provider that serves the model, as a user would type it. */
export interface ShortcutSuggestion {
  /** The shortcut the picker emits for the provider (`getShortestPrefix`). */
  shortcut: string;
  /** claudish provider. */
  provider: string;
  displayName: string;
  /** The tier words `--probe` shows (`hopLabel`). */
  label: string;
}

/**
 * Providers that serve `model`, in routing-chain order: the catalog's connections and
 * the namespace claims (`gatherRouteCandidates`). No credential filter: the question is
 * what the user meant, not what they can pay for. Every gathered provider, no cap.
 */
export function suggestProviderShortcuts(model: string, cachePath?: string): ShortcutSuggestion[] {
  const seen = new Set<string>();
  const out: ShortcutSuggestion[] = [];
  for (const candidate of gatherRouteCandidates(model, cachePath).candidates) {
    if (seen.has(candidate.provider)) continue;
    seen.add(candidate.provider);
    out.push({
      shortcut: getShortestPrefix(candidate.provider),
      provider: candidate.provider,
      displayName: getProviderByName(candidate.provider)?.displayName ?? candidate.provider,
      label: hopLabel({ tier: candidate.tier }),
    });
  }
  return out;
}

/** Shortcuts one edit away from `typed`, for a model nothing was gathered for. */
function nearbyShortcuts(typed: string): string[] {
  const lower = typed.toLowerCase();
  return Object.keys(getShortcuts())
    .filter((shortcut) => shortcut !== lower && withinOneEdit(shortcut, lower))
    .sort();
}

/** Levenshtein distance ≤ 1, without building the matrix. */
function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (a.length < b.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

const EVERY_SHORTCUT = "Every shortcut: claudish --help.";

/**
 * The ONE wording for an unknown shortcut. Every surface prints exactly these strings.
 *
 * @param typed    the shortcut as the user wrote it (the spec before its first `@`)
 * @param model    the model part, which the suggestions are spelled with
 * @param spec     the whole spec as typed, markers included (`go@gemini-3.8-flash+pro`);
 *                 defaults to `typed@model`
 */
export function describeUnknownShortcut(
  typed: string,
  model: string,
  cachePath?: string,
  spec = `${typed}@${model}`
): { reason: string; hint: string } {
  const reason = `Unknown provider shortcut "${typed}" in "${spec}".`;
  const suggestions = suggestProviderShortcuts(model, cachePath);
  if (suggestions.length > 0) {
    const list = suggestions
      .map((s) => `${s.shortcut}@${model} (${s.displayName}, ${s.label})`)
      .join(" · ");
    return { reason, hint: `Providers that serve ${model}: ${list}. ${EVERY_SHORTCUT}` };
  }
  const near = nearbyShortcuts(typed);
  if (near.length > 0) {
    return {
      reason,
      hint: `Shortcuts close to "${typed}": ${near.map((s) => `${s}@`).join(", ")}. ${EVERY_SHORTCUT}`,
    };
  }
  return { reason, hint: EVERY_SHORTCUT };
}

/** The shortcut as typed: the part of the original spec before its first `@`. */
export function typedShortcutOf(originalSpec: string): string {
  const at = originalSpec.indexOf("@");
  return at < 0 ? originalSpec : originalSpec.slice(0, at);
}
