import { describe, expect, test } from "bun:test";
import {
  isNativeTarget,
  noAnthropicDecision,
  resolveNativeModelPin,
  resolveRoleMappedModel,
} from "./proxy-server.js";
import type { RoleModelMap } from "./proxy-server.js";

const modelMap = {
  opus: "claude-opus-5",
  sonnet: "glm@glm-5.3",
  haiku: "mmc@MiniMax-M3",
  fable: "cx@gpt-6-astra",
};

describe("resolveRoleMappedModel", () => {
  test("maps every Fable version to the configured role target", () => {
    expect(resolveRoleMappedModel("claude-fable-5", modelMap)).toBe("cx@gpt-6-astra");
    expect(resolveRoleMappedModel("claude-fable-5-1", modelMap)).toBe("cx@gpt-6-astra");
    expect(resolveRoleMappedModel("claude-fable-6", modelMap)).toBe("cx@gpt-6-astra");
  });

  test("preserves existing role mappings", () => {
    expect(resolveRoleMappedModel("claude-opus-5", modelMap)).toBe("claude-opus-5");
    expect(resolveRoleMappedModel("claude-sonnet-5", modelMap)).toBe("glm@glm-5.3");
    expect(resolveRoleMappedModel("claude-haiku-4-5", modelMap)).toBe("mmc@MiniMax-M3");
  });

  test("does not map unrelated models", () => {
    expect(resolveRoleMappedModel("gpt-6-astra", modelMap)).toBeUndefined();
    expect(resolveRoleMappedModel("claude-fable-5-1", { ...modelMap, fable: undefined })).toBeUndefined();
  });
});

// The native lane historically ignored the version half of a role mapping: NativeHandler
// forwards payload.model verbatim, so `opus: "claude-opus-4-8"` classified the lane and
// pinned nothing (measured on the hub 2026-09-22: 6 487 native responses served as
// claude-opus-5 over 48 h while the map read claude-opus-4-8).
describe("resolveNativeModelPin", () => {
  const pinMap = { ...modelMap, opus: "claude-opus-5-5" };

  test("pins a native role request to the configured Anthropic version", () => {
    expect(resolveNativeModelPin("claude-opus-5", pinMap)).toBe("claude-opus-5-5");
    expect(resolveNativeModelPin("claude-opus-4-8", pinMap)).toBe("claude-opus-5-5");
    expect(resolveNativeModelPin("CLAUDE-OPUS-5", pinMap)).toBe("claude-opus-5-5");
  });

  test("never rewrites a no-op", () => {
    expect(resolveNativeModelPin("claude-opus-5-5", pinMap)).toBeUndefined();
  });

  test("leaves the budget lane alone — a provider target never reaches NativeHandler", () => {
    // sonnet/haiku/fable map to vendor@model: pinning those into the body would put a
    // provider spec on the Anthropic wire.
    expect(resolveNativeModelPin("claude-sonnet-5", pinMap)).toBeUndefined();
    expect(resolveNativeModelPin("claude-haiku-4-5", pinMap)).toBeUndefined();
    expect(resolveNativeModelPin("claude-fable-5-1", pinMap)).toBeUndefined();
  });

  // Bare and native are not the same predicate. `glm-5.3` is bare, and is kept off
  // the native lane today only by resolving to a remote handler — if it ever stopped
  // resolving, `isNative` would call it native and a bare-only guard would put it on
  // the Anthropic wire, which is strictly worse than the passthrough it replaced.
  test("only pins Anthropic ids — a bare budget target is never a native pin", () => {
    expect(resolveNativeModelPin("claude-opus-5", { opus: "glm-5.3" })).toBeUndefined();
    expect(resolveNativeModelPin("claude-opus-5", { opus: "MiniMax-M3" })).toBeUndefined();
    expect(resolveNativeModelPin("claude-opus-5", { opus: "gpt-6-astra" })).toBeUndefined();
  });

  test("leaves an explicitly provider-routed request alone despite the role keyword", () => {
    expect(resolveNativeModelPin("zai@claude-opus-5", pinMap)).toBeUndefined();
    expect(resolveNativeModelPin("anthropic/claude-opus-5", pinMap)).toBeUndefined();
  });

  test("no mapping, no pin", () => {
    expect(resolveNativeModelPin("claude-opus-5", undefined)).toBeUndefined();
    expect(resolveNativeModelPin("gpt-6-astra", pinMap)).toBeUndefined();
    expect(resolveNativeModelPin("claude-opus-5", { ...pinMap, opus: undefined })).toBeUndefined();
  });

  test("kill switch restores the pre-pin passthrough", () => {
    expect(resolveNativeModelPin("claude-opus-5", pinMap, { CLAUDISH_NATIVE_MODEL_PIN: "0" })).toBeUndefined();
    // Only an explicit "0" disarms: unset and any other value keep the pin armed, so a
    // stray empty string cannot silently un-pin the fleet.
    expect(resolveNativeModelPin("claude-opus-5", pinMap, {})).toBe("claude-opus-5-5");
    expect(resolveNativeModelPin("claude-opus-5", pinMap, { CLAUDISH_NATIVE_MODEL_PIN: "1" })).toBe("claude-opus-5-5");
    expect(resolveNativeModelPin("claude-opus-5", pinMap, { CLAUDISH_NATIVE_MODEL_PIN: "" })).toBe("claude-opus-5-5");
  });
});

// The relay deep probe asks the hub for a haiku-shaped model; what the hub does with
// it decides whether "hub healthy" means anything. #613's precondition: the probe
// measures the hub ON ITS HAIKU LANE only while `modelMap.haiku` is non-native.
// Remove that mapping on the hub and the probe silently reports the sonnet lane's
// health instead — that is not a bug to fix here, it is the trap this pin keeps lit.
describe("hub target for a role-shaped probe (#613 precondition)", () => {
  const PROBE_MODEL = "claude-haiku-4-5-20251001"; // fork/server/relay.ts DEFAULT_PROBE_MODEL

  // Composition of the two decisions the hub applies, in the order
  // `getHandlerForRequest` applies them: role mapping, then — only if the result
  // is still native — the CLAUDISH_NO_ANTHROPIC guard.
  function hubServeTarget(map: RoleModelMap | undefined): string {
    const mapped = resolveRoleMappedModel(PROBE_MODEL, map) ?? PROBE_MODEL;
    // A provider target (`@`) or vendor path (`/`) never reaches the guard.
    if (!isNativeTarget(mapped)) return mapped;
    const decision = noAnthropicDecision(map, { depth: 0 });
    if (decision.kind === "refuse") return "<refused>";
    return decision.kind === "reroute" ? decision.to : mapped;
  }

  test("a non-native haiku mapping is what the probe actually measures", () => {
    expect(hubServeTarget({ sonnet: "glm-5.3", haiku: "mmc@MiniMax-M3" })).toBe("mmc@MiniMax-M3");
  });

  test("an UNSET haiku mapping measures the sonnet lane, not haiku", () => {
    expect(hubServeTarget({ sonnet: "glm-5.3" })).toBe("glm-5.3");
  });

  test("a native haiku mapping is the same trap by another route", () => {
    expect(hubServeTarget({ sonnet: "glm-5.3", haiku: PROBE_MODEL })).toBe("glm-5.3");
  });

  test("nothing to reroute to and no budget mapping: refuse, never leak", () => {
    expect(hubServeTarget({ haiku: PROBE_MODEL })).toBe("<refused>");
    expect(hubServeTarget(undefined)).toBe("<refused>");
  });

  test("the guard fails closed below depth 0", () => {
    expect(noAnthropicDecision({ sonnet: "glm-5.3" }, { depth: 1 })).toEqual({ kind: "refuse" });
  });
});
