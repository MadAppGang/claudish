import { describe, expect, test } from "bun:test";
import { resolveNativeModelPin, resolveRoleMappedModel } from "./proxy-server.js";

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
