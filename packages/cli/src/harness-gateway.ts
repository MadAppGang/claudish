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

/**
 * Set to `1` in the environment of a claudish that must not use the gateway:
 * MCP `run_prompt`'s single print child, which runs with no tools, so a gateway
 * that shortens tool results has nothing to do there, and a stopped gateway
 * would fail the call. The launch removes it from Claude Code's environment.
 */
export const HARNESS_GATEWAY_OFF_VAR = "CLAUDISH_HARNESS_GATEWAY_OFF";

export type HarnessGatewaySetting =
  | { kind: "off" }
  | { kind: "on"; url: string }
  | { kind: "invalid"; message: string };

const RULE =
  "it must be an http:// or https:// URL whose host is 127.0.0.1 (any 127.x.x.x), ::1 or localhost, with no user:password@, backslash or control character";

/**
 * Text the WHATWG parser reads differently from other URL parsers, or silently
 * drops: a backslash (read as `/` in http URLs, as part of userinfo elsewhere)
 * and any control character (tab, CR and LF are removed before parsing).
 */
function isAmbiguous(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x5c || code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * The parsed URL as text, with no trailing `/` added to a bare origin, so the
 * value matches what the user wrote when it was already canonical.
 */
function canonical(parsed: URL, written: string): string {
  const bareOrigin = parsed.pathname === "/" && !parsed.search && !parsed.hash;
  return bareOrigin && !written.endsWith("/") ? parsed.origin : parsed.href;
}

/**
 * Read `harnessGateway` from a loaded global config. An absent block, or a block
 * with no `url`, is `off`. Anything else that is not a loopback http(s) URL is
 * `invalid`, with a message naming the key and the rule. The message never
 * repeats the value, which may carry userinfo.
 *
 * An accepted value is handed over in its canonical form: the child and every
 * process it starts read `ANTHROPIC_BASE_URL`, and some of them parse URLs by
 * other rules than the check did. Userinfo is refused because Claude Code on
 * Node cannot send a request to a URL that holds credentials, and would print
 * that URL in its error.
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
  const written = parsed.data.url.trim();
  const refused = {
    kind: "invalid",
    message: `harnessGateway.url is not accepted: ${RULE}`,
  } as const;
  if (isAmbiguous(written) || !isLoopbackTarget(written)) return refused;
  let url: URL;
  try {
    url = new URL(written);
  } catch {
    return refused;
  }
  if (url.username || url.password) return refused;
  return { kind: "on", url: canonical(url, written) };
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
  env[HARNESS_GATEWAY_TARGET_RECORD] = proxyUrl;
}

/**
 * Records the `X-Target-URL` value claudish set, so that a launch started inside
 * that session (a tool shell, a nested claudish, the MCP server) can remove it.
 */
export const HARNESS_GATEWAY_TARGET_RECORD = "CLAUDISH_SET_HARNESS_GATEWAY_TARGET";

/**
 * Remove the `X-Target-URL` line a parent claudish session set, and the record.
 * Only a line whose value equals the record goes: a user's own `X-Target-URL`
 * stays. Without a record nothing is touched. An `ANTHROPIC_CUSTOM_HEADERS` left
 * with no line is deleted. Mutates `env` in place.
 */
export function scrubInheritedHarnessGatewayTarget(env: Record<string, string | undefined>): void {
  const record = env[HARNESS_GATEWAY_TARGET_RECORD];
  if (record === undefined) return;
  delete env[HARNESS_GATEWAY_TARGET_RECORD];
  const headers = env.ANTHROPIC_CUSTOM_HEADERS;
  if (headers === undefined) return;
  const target = HARNESS_GATEWAY_TARGET_HEADER.toLowerCase();
  const kept = headers.split(/\r?\n/).filter((line) => {
    if (!line.trim()) return false;
    const colon = line.indexOf(":");
    if (colon <= 0) return true;
    const name = line.slice(0, colon).trim().toLowerCase();
    return name !== target || line.slice(colon + 1).trim() !== record;
  });
  if (kept.length === 0) delete env.ANTHROPIC_CUSTOM_HEADERS;
  else env.ANTHROPIC_CUSTOM_HEADERS = kept.join("\n");
}

/**
 * The URL's origin only, for display. Userinfo, path, query and fragment can each
 * carry a credential, so none of them is shown; an unparseable value is never echoed.
 */
function displayUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "the configured harnessGateway.url";
  }
}

/** The one startup line for a session that goes through the gateway. */
export function harnessGatewayNotice(gatewayUrl: string, nativeRoute: boolean): string {
  const base = `Claude Code's requests go through the gateway at ${displayUrl(gatewayUrl)}`;
  return nativeRoute
    ? `${base}; on this native Claude route the Claude login token passes through it`
    : base;
}
