/**
 * A custom endpoint the loader skipped because a Claude builtin owns its name.
 *
 * `customEndpoints` entries named `anthropic`, `a`, `api` (the Claude API) or
 * `claude` (the Claude subscription) are refused by `loadCustomEndpoints`,
 * since the builtin owns the name. A spec the user writes on that name
 * (`anthropic@<id>`) would otherwise reach the builtin instead: their traffic
 * would move from their own endpoint and key to api.anthropic.com on
 * ANTHROPIC_API_KEY, or onto their Claude login, with one stderr line as the
 * only signal. So such a spec is refused at first use, naming the rename,
 * until the entry is renamed.
 *
 * Read from the global config (the only scope `customEndpoints` is read
 * from), once per process: endpoint registration is latched per process too.
 */

import { loadConfig } from "../profile-config.js";
import { parseModelChain, parseModelSpec } from "./model-parser.js";
import { CLAUDE_SUBSCRIPTION_LABEL } from "./native-route.js";
import { getProviderByName } from "./provider-definitions.js";
import { reservedNamespaceOwner } from "./reserved-namespace.js";

/** The builtins whose names became reserved with the Claude routes. */
const CLAUDE_ROUTE_PROVIDERS: ReadonlySet<string> = new Set(["anthropic", "native-anthropic"]);

let shadowedNames: ReadonlyMap<string, string> | undefined;

/** The skipped names of this process, read once. */
function shadowedEndpointNames(): ReadonlyMap<string, string> {
  if (!shadowedNames) shadowedNames = readShadowedNames();
  return shadowedNames;
}

/** Lowercased endpoint name → the Claude builtin that owns it, for every skipped entry. */
function readShadowedNames(): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  try {
    const endpoints = loadConfig().customEndpoints;
    if (!endpoints || typeof endpoints !== "object") return out;
    for (const name of Object.keys(endpoints)) {
      const owner = reservedNamespaceOwner(name);
      if (owner && CLAUDE_ROUTE_PROVIDERS.has(owner)) out.set(name.toLowerCase(), owner);
    }
  } catch {
    // An unreadable config registers no custom endpoint either, so nothing
    // can be shadowed.
  }
  return out;
}

/**
 * The refusal for the first element of `specs` (each may be a `+` chain) whose
 * explicit provider is a custom endpoint name a Claude builtin took over;
 * null when none is. `names` is a seam for tests.
 */
export function shadowedEndpointRefusal(
  specs: readonly string[],
  names: ReadonlyMap<string, string> = shadowedEndpointNames()
): string | null {
  if (names.size === 0) return null;
  for (const spec of specs) {
    for (const element of parseModelChain(spec)) {
      const at = element.indexOf("@");
      if (at <= 0 || !parseModelSpec(element).isExplicitProvider) continue;
      const typed = element.slice(0, at);
      const owner = names.get(typed.toLowerCase());
      if (!owner) continue;
      const builtin = getProviderByName(owner);
      const label =
        owner === "native-anthropic" ? CLAUDE_SUBSCRIPTION_LABEL : (builtin?.displayName ?? owner);
      const shortcuts = (builtin?.shortcuts ?? []).map((s) => `${s}@`).join(", ");
      return (
        `${element}: '${typed}@' is the builtin ${label}${shortcuts ? ` (${shortcuts})` : ""}, ` +
        `not your custom endpoint '${typed}', which claudish skipped because the builtin owns ` +
        `that name. Rename customEndpoints['${typed}'] in ~/.claudish/config.json ` +
        `(e.g. '${typed}-custom') and use ${typed}-custom@<model>, then restart the claudish ` +
        "MCP server if one is running: it reads custom endpoints once, when it starts."
      );
    }
  }
  return null;
}
