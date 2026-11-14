/**
 * `harnessGateway.url`: a local HTTP gateway between Claude Code and claudish's
 * proxy.
 *
 * Claude Code speaks the Anthropic format to claudish's proxy on every route, so
 * a gateway placed there sees the same requests on a native route and on a
 * foreign one. With the key set, the child's `ANTHROPIC_BASE_URL` is the gateway
 * URL, and the gateway learns where to send each request from an
 * `X-Target-URL: <proxy URL>` line in `ANTHROPIC_CUSTOM_HEADERS`. Every session
 * carries its own proxy URL, so one gateway serves any number of sessions.
 *
 * Loopback only (`isLoopbackTarget`, the `CLAUDISH_TEST_UPSTREAM` rule): on a
 * native route Claude Code sends the user's Claude login token with every
 * request, so a gateway URL that leaves the machine would send that token
 * across the network. A value that breaks the rule refuses the launch; it never
 * falls back to the proxy URL.
 *
 * claudish neither starts nor stops the gateway. The proxy never forwards
 * `X-Target-URL` upstream: the native forward is a header allowlist
 * (`handlers/shared/anthropic-forward.ts`), and the composed path reads only
 * `x-api-key` from the inbound request.
 */

import { HarnessGatewayConfigSchema } from "./config-schema.js";
import type { ClaudishProfileConfig } from "./profile-config.js";
import { isLoopbackTarget } from "./test-upstream.js";

/** The header that carries claudish's proxy URL to the gateway. */
export const HARNESS_GATEWAY_TARGET_HEADER = "X-Target-URL";

export type HarnessGatewaySetting =
  | { kind: "off" }
  | { kind: "on"; url: string }
  | { kind: "invalid"; message: string };

const RULE =
  "it must be an http:// or https:// URL whose host is 127.0.0.1 (any 127.x.x.x), ::1 or localhost";

/**
 * Read `harnessGateway` from a loaded global config. An absent block, or a block
 * with no `url`, is `off`. Anything else that is not a loopback http(s) URL is
 * `invalid`, with a message naming the key and the rule. The message never
 * repeats the value, which may carry userinfo.
 */
export function resolveHarnessGateway(config: ClaudishProfileConfig): HarnessGatewaySetting {
  const block = config.harnessGateway;
  if (block === undefined) return { kind: "off" };
  if (block === null || typeof block !== "object" || Array.isArray(block)) {
    return { kind: "invalid", message: `harnessGateway must be an object { "url": "..." }` };
  }
  if (!("url" in block) || block.url === undefined) return { kind: "off" };
  const parsed = HarnessGatewayConfigSchema.safeParse(block);
  if (!parsed.success) {
    return { kind: "invalid", message: `harnessGateway.url must be a string: ${RULE}` };
  }
  const url = parsed.data.url.trim();
  if (!isLoopbackTarget(url)) {
    return { kind: "invalid", message: `harnessGateway.url is not accepted: ${RULE}` };
  }
  return { kind: "on", url };
}

/**
 * Point a child environment at the gateway: `ANTHROPIC_BASE_URL` becomes the
 * gateway URL, and `ANTHROPIC_CUSTOM_HEADERS` gains `X-Target-URL: <proxyUrl>`.
 * Every other header line is kept as it was. An existing `X-Target-URL` line
 * (any case), for example one inherited from a parent claudish session, is
 * replaced, so the gateway never sees two targets.
 */
export function applyHarnessGateway(
  env: Record<string, string>,
  gatewayUrl: string,
  proxyUrl: string
): void {
  env.ANTHROPIC_BASE_URL = gatewayUrl;
  const target = HARNESS_GATEWAY_TARGET_HEADER.toLowerCase();
  const kept = (env.ANTHROPIC_CUSTOM_HEADERS ?? "").split(/\r?\n/).filter((line) => {
    if (!line.trim()) return false;
    const colon = line.indexOf(":");
    return colon <= 0 || line.slice(0, colon).trim().toLowerCase() !== target;
  });
  kept.push(`${HARNESS_GATEWAY_TARGET_HEADER}: ${proxyUrl}`);
  env.ANTHROPIC_CUSTOM_HEADERS = kept.join("\n");
}

/** The URL without any userinfo, for display. */
function displayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

/** The one startup line for a session that goes through the gateway. */
export function harnessGatewayNotice(gatewayUrl: string, nativeRoute: boolean): string {
  const base = `Claude Code's requests go through the gateway at ${displayUrl(gatewayUrl)}`;
  return nativeRoute
    ? `${base}; on this native Claude route the Claude login token passes through it`
    : base;
}
