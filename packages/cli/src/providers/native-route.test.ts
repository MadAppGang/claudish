// Protect native passthrough for bare Claude names before credential-filtered route():
// the MCP preflight tool (mcp-server.ts) and TUI route probe (tui/hooks/useRouteProbe.ts)
// need this guard, while explicit provider specs must retain their chosen provider.
import { describe, expect, test } from "bun:test";
import { claudeCodeTierAlias, normalizeNativeModelSpec } from "./claude-code-aliases.js";
import {
  claudeLaunchMarkersRefusal,
  claudeSubscriptionSpecRefusal,
  nativeRouteFor,
} from "./native-route.js";

describe("nativeRouteFor", () => {
  test("slash-qualified ids are not native passthrough", () => {
    // Mirror proxy-server.ts:826: native requires !target.includes("/") && !hasExplicitProvider.
    expect(nativeRouteFor("anthropic/claude-opus-5")).toBeNull();
    expect(nativeRouteFor("anthropic/claude-sonnet-5")).toBeNull();
  });

  test("recognizes bare native names, normalizes tier aliases, and excludes other providers and explicit specs", () => {
    expect(nativeRouteFor("claude-opus-5")).toEqual({
      provider: "native-anthropic",
      modelSpec: "claude-opus-5",
      displayName: "Claude subscription",
      isTierAlias: false,
    });
    expect(nativeRouteFor("claude-fable-5-1")).toEqual({
      provider: "native-anthropic",
      modelSpec: "claude-fable-5-1",
      displayName: "Claude subscription",
      isTierAlias: false,
    });

    for (const alias of ["opus", "internal"]) {
      expect(nativeRouteFor(alias)).toEqual({
        provider: "native-anthropic",
        modelSpec: normalizeNativeModelSpec(alias),
        displayName: "Claude subscription",
        isTierAlias: claudeCodeTierAlias(alias) !== null,
      });
    }

    expect(nativeRouteFor("grok-4.6")).toBeNull();
    expect(nativeRouteFor("kimi-k3")).toBeNull();
    expect(nativeRouteFor("anthropic@claude-opus-5")).toBeNull();
    expect(nativeRouteFor("dv@claude-opus-5-high")).toBeNull();
  });

  test("does not route unrecognised bare names through the native passthrough", () => {
    expect(nativeRouteFor("some-typo-model")).toBeNull();
  });
});

describe("claudeLaunchMarkersRefusal", () => {
  const launchText = "a Claude launch talks to Anthropic through Claude Code itself";

  test("refuses a known, an unknown and a repeated marker with the Claude launch sentence", () => {
    for (const spec of [
      "anthropic@claude-haiku-5-5#fast",
      "anthropic@claude-haiku-5-5+pro",
      "anthropic@claude-haiku-5-5#bogus",
      "anthropic@claude-haiku-5-5#fast#flex",
      "claude@claude-haiku-5-5#bogus",
    ]) {
      const refusal = claudeLaunchMarkersRefusal(spec);
      expect(refusal).toContain(launchText);
      expect(refusal).not.toContain("unknown speed");
    }
  });

  test("passes a spec with no marker, a :N suffix included", () => {
    expect(claudeLaunchMarkersRefusal("anthropic@claude-haiku-5-5")).toBeNull();
    expect(claudeLaunchMarkersRefusal("anthropic@claude-haiku-5-5:3")).toBeNull();
  });

  test("claude@ with an unknown marker gets the same sentence", () => {
    expect(claudeSubscriptionSpecRefusal("claude@claude-haiku-5-5#bogus")).toContain(launchText);
  });
});
