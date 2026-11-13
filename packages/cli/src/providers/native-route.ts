/**
 * The native-passthrough answer that `route()` cannot give, and the proxy's
 * pre-route decision that produces it.
 *
 * A bare name Claude Code owns (`claude-opus-5`, `opus`, `opusplan`,
 * `sonnet[1m]`, `internal`; see `isClaudeCodeModelName`) is served by the
 * proxy's native branch on the harness's own Claude Code auth. `native-anthropic`
 * has no credential store — on purpose, it is not a remote provider — so
 * `route()`'s credential filter drops it and the chain degrades to OpenRouter.
 * The proxy avoids that by asking {@link proxyRouteDecision} BEFORE it ever
 * routes (proxy-server.ts step 2c). Every other caller that consults `route()`
 * for a bare name must ask the same question first, or it reports a
 * subscription model as "no route" / "OpenRouter, metered" — which is what the
 * MCP `preflight` tool and the TUI route probe did.
 *
 * Only Claude Code's names are native, plus `""` and `@model`, which are not
 * model names and which the harness rejects. Any other bare name with no `/`
 * (`o4-mini`, a typo) is `bare`: `parseModelSpec` gives it `AUTO_ROUTE_PROVIDER`,
 * and `route()` decides it like every other bare name. The native passthrough
 * serves none of them, so it used to answer each with an Anthropic 404.
 *
 * Explicit specs are never native, with one exception: `claude@<id>` names the
 * Claude subscription itself, so it is exactly the decision of `<id>` when `<id>`
 * is a name Claude Code owns. Every other explicit spec names a route of its own:
 * `anthropic@claude-opus-5` is the Claude API (metered on the user's Anthropic
 * key), and `dv@claude-opus-5-high` is Devin re-serving a Claude id under its own
 * prefix. `parseModelSpec` already resolves that precedence; this only reads it.
 *
 * A `claude@` spec is checked once, on the caller's original string, by
 * {@link claudeSubscriptionSpecRefusal} before anything strips or normalizes it.
 */

import { claudeCodeTierAlias, normalizeNativeModelSpec } from "./claude-code-aliases.js";
import { parseModelChain, parseModelSpec } from "./model-parser.js";
import { WireMarkerError, splitWireMarkers } from "./wire-markers.js";

export interface NativeRoute {
  provider: "native-anthropic";
  /** The tier id that will actually be sent — `opus` and `internal` are normalized. */
  modelSpec: string;
  displayName: string;
  /**
   * True when `model` is a Claude Code tier alias (`opus`, `internal`, …). Those
   * are selectors, not API model ids: the native handler forwards the request's
   * model verbatim and Anthropic rejects an alias, so a probe must SKIP them and
   * send only concrete names. Everything else — including a `claude-` typo,
   * which the proxy really does send natively — must be probed, never declared
   * live.
   */
  isTierAlias: boolean;
}

/**
 * What the proxy does with a target before `route()` could see it.
 *
 * Only `bare` reaches `route()`. The other three are served without a routing
 * chain, by the proxy steps that follow its gate.
 */
export type ProxyRouteDecision =
  /** Served on Claude Code's own auth by the native passthrough. */
  | { type: "native"; route: NativeRoute }
  /**
   * No routing chain. `spec` is the target verbatim, the string the proxy carries
   * past its gate. `via: "vendor-qualified-id"` is `anthropic/<id>`: it matches
   * native-anthropic's `/^anthropic\//i` pattern, yet the proxy never serves it
   * natively (its native branch refuses any `/`), so it reaches the OpenRouter
   * handler with the id unchanged.
   */
  | {
      type: "explicit";
      provider: string;
      model: string;
      spec: string;
      via: "model-spec" | "vendor-qualified-id";
    }
  /** `poe:<id>`, served by the Poe handler. `model` is the id without the prefix. */
  | { type: "poe"; model: string }
  /** `route()` decides. `model` is the parsed name: a known `vendor/` is stripped. */
  | { type: "bare"; model: string };

/** The user-facing name of the native passthrough: the user's own Claude Code login. */
export const CLAUDE_SUBSCRIPTION_LABEL = "Claude subscription";

/**
 * What every surface says about a native link instead of a probe result: `--probe`,
 * the MCP preflight and the config TUI's route probe.
 *
 * A native link is never probed. The native handler authenticates by forwarding
 * the INBOUND request's Claude Code header, and a synthetic request from this
 * process carries none, so its answer is noise: "x-api-key header is required"
 * for a healthy model and a typo alike. Signing it with `ANTHROPIC_API_KEY` would
 * probe a different route: that is the Claude API (`anthropic@<id>`), which
 * `--probe` lists and probes as its own row. So the Claude subscription is a third
 * outcome, neither live nor failed.
 */
export const NATIVE_NOT_PROBED =
  "not probed — the Claude subscription is served on Claude Code's own login, which this process cannot forward";

/** The prefix the proxy's `isPoeModel` tests, case-sensitively, as it always has. */
const POE_PREFIX = "poe:";

/**
 * The proxy's gate (proxy-server.ts step 2c) as one function. The proxy, the
 * native test below, prehydrate's pin and `--probe` all read this, so none of
 * them can disagree with the proxy about which names reach `route()`.
 *
 * The checks run in the order the proxy applies them: an explicit spec (which
 * covers `provider@model`, a URL and a legacy prefix), then `poe:`, then a name
 * the parser attributes to native-anthropic, then everything else.
 */
export function proxyRouteDecision(target: string): ProxyRouteDecision {
  const parsed = parseModelSpec(target);
  if (parsed.isExplicitProvider && parsed.provider === "native-anthropic") {
    // `claude@<id>` is the Claude subscription: the decision of the bare `<id>`
    // after it (`parsed.model` carries no marker). An inner name Claude Code does
    // not own stays an explicit native-anthropic spec, which nothing serves, so
    // it is refused and never routed.
    const inner = proxyRouteDecision(parsed.model);
    if (inner.type === "native") return inner;
    return {
      type: "explicit",
      provider: "native-anthropic",
      model: parsed.model,
      spec: target,
      via: "model-spec",
    };
  }
  if (parsed.isExplicitProvider) {
    return {
      type: "explicit",
      provider: parsed.provider,
      model: parsed.model,
      spec: target,
      via: "model-spec",
    };
  }
  if (target.startsWith(POE_PREFIX)) {
    return { type: "poe", model: target.slice(POE_PREFIX.length) };
  }
  if (parsed.provider === "native-anthropic") {
    // A slash-qualified id (`anthropic/claude-opus-5`) matches native-anthropic's
    // `/^anthropic\//i` pattern in parseModelSpec, but the proxy does not serve it
    // natively — its native branch is `!target.includes("/") && !hasExplicitProvider`,
    // so it goes to OpenRouter, metered. Calling it native would be the same lie
    // the native test exists to remove, in the other direction.
    if (target.includes("/")) {
      return {
        type: "explicit",
        provider: "openrouter",
        model: target,
        spec: target,
        via: "vendor-qualified-id",
      };
    }
    return { type: "native", route: nativeRouteOf(target) };
  }
  return { type: "bare", model: parsed.model };
}

function nativeRouteOf(model: string): NativeRoute {
  return {
    provider: "native-anthropic",
    modelSpec: normalizeNativeModelSpec(model),
    displayName: CLAUDE_SUBSCRIPTION_LABEL,
    isTierAlias: claudeCodeTierAlias(model) !== null,
  };
}

/**
 * Non-null only for the proxy's `native` decision: a BARE name (no `@`, no `/`)
 * that `parseModelSpec` attributes to native-anthropic, or `claude@` before one.
 */
export function nativeRouteFor(model: string): NativeRoute | null {
  const decision = proxyRouteDecision(model);
  return decision.type === "native" ? decision.route : null;
}

/** True for a spec whose explicit provider is the Claude subscription (`claude@…`). */
function isClaudeSubscriptionSpec(spec: string): boolean {
  const parsed = parseModelSpec(spec);
  return parsed.isExplicitProvider && parsed.provider === "native-anthropic";
}

/**
 * The refusal for a Claude launch spec that carries a speed or mode marker. The
 * Claude subscription and the Claude API launch talk to Anthropic through Claude
 * Code itself, so a marker claudish puts on routed hops cannot be honoured, and a
 * marker that cannot be honoured is refused, never dropped.
 */
export function claudeLaunchMarkerRefusal(spec: string): string {
  return (
    `${spec}: a Claude launch talks to Anthropic through Claude Code itself, so ` +
    "claudish's speed and mode markers cannot apply; use /fast and /effort inside the session."
  );
}

/**
 * The one check of a `claude@` spec, run on the caller's ORIGINAL string before
 * anything strips or normalizes it. `null` for a spec that is not `claude@…`,
 * and for one `claude@<name Claude Code owns>` with no marker and no `:N`
 * concurrency suffix. Otherwise the sentence that refuses it:
 *
 * - `claude@` inside a `+` chain: the Claude subscription is served by Claude
 *   Code itself, so it cannot be one hop of a chain claudish routes;
 * - a mode or speed marker (split strictly: `#bogus` gives the marker error);
 * - a `:N` suffix, which `parseModelSpec` would split off silently;
 * - an inner name that is not Claude Code's own (`claude@gpt-6`).
 */
export function claudeSubscriptionSpecRefusal(spec: string): string | null {
  const elements = parseModelChain(spec);
  if (elements.length > 1) {
    return elements.some(isClaudeSubscriptionSpec)
      ? "claude@ is the Claude subscription, which Claude Code serves itself; it cannot be a hop of a + chain"
      : null;
  }
  if (!isClaudeSubscriptionSpec(spec)) return null;
  let markers: ReturnType<typeof splitWireMarkers>;
  try {
    markers = splitWireMarkers(spec);
  } catch (err) {
    if (err instanceof WireMarkerError) return err.message;
    throw err;
  }
  if (markers.mode || markers.speed) return claudeLaunchMarkerRefusal(spec);
  const rawModel = spec.slice(spec.indexOf("@") + 1);
  if (/:\d+$/.test(rawModel)) {
    return `${spec}: claude@ is the Claude subscription, which Claude Code serves itself; it takes no :N concurrency suffix`;
  }
  const inner = parseModelSpec(spec).model;
  if (nativeRouteFor(inner) === null) {
    return `claude@ serves Claude Code's own Claude models; ${inner} is not one`;
  }
  return null;
}

/**
 * The bare name after `claude@` for a `claude@` spec that
 * {@link claudeSubscriptionSpecRefusal} accepts; any other spec unchanged. Call
 * it only after that check: a refused spec is never reduced to its inner name.
 */
export function claudeSubscriptionInner(spec: string): string {
  if (!isClaudeSubscriptionSpec(spec) || claudeSubscriptionSpecRefusal(spec) !== null) return spec;
  return parseModelSpec(spec).model;
}
