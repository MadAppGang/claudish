/**
 * Proxy-key set — one key, or two during a rotation.
 *
 * The proxy key gates non-Anthropic ingress (proxy-auth middleware) and arms
 * the proxyKey→Anthropic swap (NativeHandler + the native-forward branch of
 * proxy-server). Rotating the fleet's shared key used to be a hard cut: the
 * moment the hub's key changed, every client still holding the old one got
 * 401s, and repointing them all in one synchronized gesture is exactly the
 * kind of fleet-wide change this repo avoids. `CLAUDISH_PROXY_KEY_PREVIOUS`
 * keeps the retiring key accepted for a transition window so clients can be
 * repointed one by one; unsetting the variable ends the window.
 *
 * Deliberately a leaf module: needed by both the core handlers (native-handler,
 * proxy-server) and the fork middleware, and the fork layer imports core —
 * never the reverse.
 */

/** Accepted keys in check order: primary first, previous second, deduped. */
export function resolveProxyKeys(
  primary: string | undefined,
  previous: string | undefined
): string[] {
  const keys = [primary, previous].filter((k): k is string => !!k && k.length > 0);
  return [...new Set(keys)];
}

export function matchesProxyKey(
  provided: string | undefined,
  keys: string[]
): boolean {
  return !!provided && keys.includes(provided);
}
