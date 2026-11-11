/**
 * The request header a probe sends when the hop it tests belongs to the routing
 * chain of a bare name.
 *
 * Real traffic builds such a hop with `hopOrigin: "routed"` (proxy step 2c), so
 * offline it may try the provider's APIs in turn. A probe sends each hop to its
 * proxy as a model spec, which on its own reads as an explicit spec (RB-2) and is
 * refused offline when the bundled recommended list has no connection for it.
 * The header tells the proxy which of the two the probe is testing.
 *
 * Only a proxy started for probing (`ProxyServerOptions.probeProxy`) reads it. A
 * proxy that serves Claude Code ignores it, so no client can turn an explicit
 * spec into a routed hop.
 */
export const PROBE_HOP_ORIGIN_HEADER = "x-claudish-hop-origin";

/** The hop origin a request asks for, honoured only by a probe proxy. */
export function probeHopOriginOf(
  headerValue: string | undefined,
  probeProxy: boolean | undefined
): "routed" | undefined {
  return probeProxy === true && headerValue === "routed" ? "routed" : undefined;
}
