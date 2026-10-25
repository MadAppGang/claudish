/**
 * Client attribution to custom endpoints (#686).
 *
 * The engine behind a custom endpoint (our own vLLM front) sees ONE credential
 * for almost everything: fingerprint `be312daf7c1c` = `VLLM_API_KEY_MEDIUM`
 * covered 1 639/1 703 requests in 6 h = 96 % of engine traffic (measured
 * ai-01:vllm, 2026-10-25). A known key says nothing about the client behind
 * it, so attribution rides a header the CLIENT controls (po-2025 arbitration
 * 09/10: `machine:workspace` is the only discriminant).
 *
 * Frozen format (announced to ai-01:vllm 2026-10-25 ~12:32Z — will not change):
 *
 *   - client seats send `x-claudish-workspace: <workspace>` alongside the
 *     existing `x-claudish-machine` (a roo-extensions settings campaign);
 *   - the hub composes `x-claudish-client: <machine>:<workspace>` and sends it
 *     on the OpenAI wire to endpoints that OPTED IN (`clientAttribution: true`
 *     on the custom endpoint — opt-in because a custom endpoint can point at a
 *     third party (qwen-token-plan = Aliyun, mistral = La Plateforme) and our
 *     internal names must not leak there by default);
 *   - a missing part reads `unknown` — the header is NEVER absent on an opted-in
 *     endpoint, so "not attributable" is sayable, not guessed;
 *   - the native Anthropic lane strips every `x-claudish-*` header as it
 *     already does (#282 prefix sweep) — api.anthropic.com never needs it.
 *
 * Kill switch `CLAUDISH_CLIENT_ATTRIBUTION=0` (read per request).
 */

import type { Context } from "hono";

export const CLIENT_ATTRIBUTION_HEADER = "x-claudish-client";
export const WORKSPACE_HEADER = "x-claudish-workspace";
const MACHINE_HEADER = "x-claudish-machine";

/** Global kill switch — `0` disables; unset (or any other value) stays armed. */
export function clientAttributionEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  // `||`, not `??` (#310 review): compose injects this name as "" and "" is
  // not nullish — the `??` shape made the fallback unreachable in containers.
  return (env.CLAUDISH_CLIENT_ATTRIBUTION || "1") !== "0";
}

/**
 * `<machine>:<workspace>`, each missing/blank part reading `unknown`.
 * Blank-to-null here, not at the call site: a present-but-empty header must
 * read as "not attributable", never as a value.
 */
export function composeClientAttributionValue(
  machine: string | null | undefined,
  workspace: string | null | undefined
): string {
  const m = machine && machine.trim().length > 0 ? machine.trim() : null;
  const w = workspace && workspace.trim().length > 0 ? workspace.trim() : null;
  return `${m ?? "unknown"}:${w ?? "unknown"}`;
}

function readHeader(c: Context, name: string): string | null {
  const v = c.req.header(name);
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/**
 * The headers to merge into an opted-in endpoint's outbound set:
 * `x-claudish-client` always; `x-claudish-machine` verbatim when the client
 * sent one (the engine's middleware logs both — the machine header is a
 * courtesy, never fabricated).
 */
export function clientAttributionHeaders(c: Context): Record<string, string> {
  const machine = readHeader(c, MACHINE_HEADER);
  const workspace = readHeader(c, WORKSPACE_HEADER);
  const out: Record<string, string> = {
    [CLIENT_ATTRIBUTION_HEADER]: composeClientAttributionValue(machine, workspace),
  };
  if (machine) out[MACHINE_HEADER] = machine;
  return out;
}
