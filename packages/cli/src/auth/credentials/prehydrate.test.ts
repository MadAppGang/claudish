import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { PROVIDER_TO_PREFIX } from "../../providers/auto-route.js";
import { parseModelChain, parseModelSpec } from "../../providers/model-parser.js";
import { nativeRouteFor, proxyRouteDecision } from "../../providers/native-route.js";
import type { Route } from "../../providers/routing-rules.js";
import { __resetSniffForTests } from "./op-source.js";
import {
  joinPinnedChain,
  normalizePinnedSpec,
  pinSpecFor,
  prehydrateCredentialsForSpawn,
} from "./prehydrate.js";

let savedDisableOp: string | undefined;

beforeEach(() => {
  savedDisableOp = process.env.CLAUDISH_DISABLE_OP;
  process.env.CLAUDISH_DISABLE_OP = "1";
  __resetSniffForTests();
});

afterEach(() => {
  if (savedDisableOp === undefined) delete process.env.CLAUDISH_DISABLE_OP;
  else process.env.CLAUDISH_DISABLE_OP = savedDisableOp;
  __resetSniffForTests();
});

describe("prehydrateCredentialsForSpawn", () => {
  it("is a no-op for empty and undefined-only model lists", async () => {
    expect((await prehydrateCredentialsForSpawn([])).pinned.size).toBe(0);
    expect((await prehydrateCredentialsForSpawn([undefined, undefined])).pinned.size).toBe(0);
  });

  it("does not throw for a network-free local-model validation", async () => {
    // Explicit spec → nothing to pin (the child already skips routing).
    expect((await prehydrateCredentialsForSpawn(["ollama@llama3.2"])).pinned.size).toBe(0);
  });

  it("keeps phase A enabled when route pinning is disabled", async () => {
    const validator = mock(async () => []);
    const router = mock(async () => ({
      kind: "ok" as const,
      primary: { provider: "openrouter", modelSpec: "vendor/model", displayName: "" },
      fallbacks: [],
    }));

    const plan = await prehydrateCredentialsForSpawn(["or@vendor/model"], {
      pin: false,
      router,
      validator,
    });

    expect(plan.pinned.size).toBe(0);
    expect(validator).toHaveBeenCalledTimes(1);
    expect(validator).toHaveBeenCalledWith(["or@vendor/model"]);
    expect(router).not.toHaveBeenCalled();
  });

  it("omits a model that cannot be pinned instead of recording an error", async () => {
    const router = mock(async () => ({
      kind: "ok" as const,
      primary: { provider: "openrouter", modelSpec: "opus", displayName: "" },
      fallbacks: [],
    }));

    const plan = await prehydrateCredentialsForSpawn(["opus"], { router });

    expect(plan.pinned.has("opus")).toBe(false);
    expect(plan.pinned.size).toBe(0);
    expect(router).not.toHaveBeenCalled();
  });

  it("swallows a thrown phase-A validator without routing or throwing", async () => {
    const validator = mock(async () => {
      throw new Error("credential validation failed");
    });
    const router = mock(async () => ({
      kind: "ok" as const,
      primary: { provider: "openrouter", modelSpec: "vendor/model", displayName: "" },
      fallbacks: [],
    }));

    const plan = await prehydrateCredentialsForSpawn(["x-ai/grok-4.20"], {
      validator,
      router,
    });

    expect(plan.pinned.size).toBe(0);
    expect(validator).toHaveBeenCalledTimes(1);
    expect(router).not.toHaveBeenCalled();
  });
});

function candidate(provider: string, modelSpec: string): Route {
  return { provider, modelSpec, displayName: "" };
}

describe("normalizePinnedSpec", () => {
  it("round-trips every provider prefix as the same explicit canonical provider", () => {
    for (const [provider, prefix] of Object.entries(PROVIDER_TO_PREFIX)) {
      const normalized = normalizePinnedSpec(candidate(provider, "m"));
      expect(normalized, `${provider} should normalize through ${prefix}@`).not.toBeNull();

      const parsed = parseModelSpec(normalized!);
      expect(parsed.provider, `${provider} should round-trip through ${normalized}`).toBe(provider);
      expect(parsed.isExplicitProvider, `${normalized} must remain explicit`).toBe(true);
    }
  });

  it("adds the OpenRouter prefix that makes a vendor-qualified id explicit", () => {
    const bare = parseModelSpec("x-ai/grok-4.20");
    expect(bare.provider).toBe("x-ai");
    expect(bare.isExplicitProvider).toBe(false);

    const normalized = normalizePinnedSpec(candidate("openrouter", "x-ai/grok-4.20"));
    expect(normalized).toBe("or@x-ai/grok-4.20");

    const parsed = parseModelSpec(normalized!);
    expect(parsed.provider).toBe("openrouter");
    expect(parsed.isExplicitProvider).toBe(true);
  });

  it("passes through an already-explicit spec without losing its concurrency suffix", () => {
    expect(normalizePinnedSpec(candidate("ollama", "ollama@llama3.2:3"))).toBe("ollama@llama3.2:3");
  });

  it("prefixes an @-leading wire id with its provider", () => {
    const normalized = normalizePinnedSpec(candidate("openrouter", "@preset/example"));
    expect(normalized).toBe("or@@preset/example");

    const parsed = parseModelSpec(normalized!);
    expect(parsed.provider).toBe("openrouter");
    expect(parsed.isExplicitProvider).toBe(true);
  });

  it("passes through an already-explicit spec whose wire id starts with @", () => {
    expect(normalizePinnedSpec(candidate("openrouter", "or@@preset/x"))).toBe("or@@preset/x");
  });

  it("passes through http(s) model URLs unchanged", () => {
    for (const url of ["http://localhost:11434/model", "https://models.example.test/v1"]) {
      expect(normalizePinnedSpec(candidate("custom-url", url))).toBe(url);
    }
  });

  it("returns null for an empty or whitespace-only model spec", () => {
    expect(normalizePinnedSpec(candidate("openrouter", ""))).toBeNull();
    expect(normalizePinnedSpec(candidate("openrouter", "   \t\n"))).toBeNull();
  });
});

describe("joinPinnedChain", () => {
  it("joins several routes in order with plus", () => {
    const joined = joinPinnedChain([
      candidate("z-ai", "zgo@minimax-m2.5"),
      candidate("minimax", "mm@MiniMax-M2.5"),
      candidate("openrouter", "or@minimax/minimax-m2.5"),
    ]);

    expect(joined).toBe("zgo@minimax-m2.5+mm@MiniMax-M2.5+or@minimax/minimax-m2.5");
  });

  it("normalizes OpenRouter before joining so every candidate remains explicit", () => {
    const joined = joinPinnedChain([
      candidate("z-ai", "zgo@grok-4.20"),
      candidate("openrouter", "x-ai/grok-4.20"),
    ]);

    expect(joined).toContain("or@x-ai/grok-4.20");
    expect(joined).not.toBeNull();
    expect(parseModelChain(joined!).every((spec) => parseModelSpec(spec).isExplicitProvider)).toBe(
      true
    );
  });

  it("drops an unnormalizable route while preserving the rest", () => {
    expect(
      joinPinnedChain([
        candidate("z-ai", "zgo@minimax-m2.5"),
        candidate("openrouter", "   "),
        candidate("minimax", "mm@MiniMax-M2.5"),
      ])
    ).toBe("zgo@minimax-m2.5+mm@MiniMax-M2.5");
  });

  it("returns null when no route can be normalized", () => {
    expect(joinPinnedChain([])).toBeNull();
    expect(joinPinnedChain([candidate("openrouter", ""), candidate("minimax", "   ")])).toBeNull();
  });
});

describe("pinSpecFor routing gate", () => {
  it("returns the primary and fallbacks in credential-filtered preference order", async () => {
    const router = mock(async () => ({
      kind: "ok" as const,
      primary: candidate("z-ai", "zgo@minimax-m2.5"),
      fallbacks: [
        candidate("minimax", "mm@MiniMax-M2.5"),
        candidate("openrouter", "minimax/minimax-m2.5"),
      ],
    }));

    expect(await pinSpecFor("minimax-m2.5", router)).toBe(
      "zgo@minimax-m2.5+mm@MiniMax-M2.5+or@minimax/minimax-m2.5"
    );
  });

  it("keeps a single-candidate pin byte-identical and separator-free", async () => {
    const router = mock(async () => ({
      kind: "ok" as const,
      primary: candidate("openrouter", "x-ai/grok-4.20"),
      fallbacks: [],
    }));

    const pinned = await pinSpecFor("x-ai/grok-4.20", router);
    expect(pinned).toBe("or@x-ai/grok-4.20");
    expect(pinned).not.toContain("+");
  });

  it("does not route already-explicit specs", async () => {
    const router = mock(async () => ({
      kind: "ok" as const,
      primary: { provider: "openrouter", modelSpec: "wrong", displayName: "" },
      fallbacks: [],
    }));

    for (const spec of ["gc@glm-5", "ollama@llama3.2:3"]) {
      expect(await pinSpecFor(spec, router)).toBeNull();
    }
    expect(router).not.toHaveBeenCalled();
  });

  it("does not route poe-prefixed models", async () => {
    const router = mock(async () => ({
      kind: "ok" as const,
      primary: { provider: "openrouter", modelSpec: "wrong", displayName: "" },
      fallbacks: [],
    }));

    expect(await pinSpecFor("poe:claude-opus", router)).toBeNull();
    expect(router).not.toHaveBeenCalled();
  });

  it("never routes native models even when the router would default them to OpenRouter", async () => {
    const router = mock(async (spec: string) => ({
      kind: "ok" as const,
      primary: { provider: "openrouter", modelSpec: spec, displayName: "OpenRouter" },
      fallbacks: [],
    }));

    for (const spec of ["opus", "sonnet", "claude-sonnet-5"]) {
      expect(await pinSpecFor(spec, router)).toBeNull();
    }
    expect(router).not.toHaveBeenCalled();
  });

  it("routes a bare non-Claude name", async () => {
    const router = mock(async (spec: string) => ({
      kind: "ok" as const,
      primary: { provider: "openrouter", modelSpec: spec, displayName: "OpenRouter" },
      fallbacks: [],
    }));

    expect(await pinSpecFor("o4-mini", router)).toBe("or@o4-mini");
    expect(router).toHaveBeenCalledTimes(1);
    expect(router).toHaveBeenCalledWith("o4-mini");
  });

  it("returns null without throwing when the router finds no route", async () => {
    const router = mock(async () => ({
      kind: "no-route" as const,
      reason: "no credentialed provider",
    }));

    await expect(pinSpecFor("x-ai/grok-4.20", router)).resolves.toBeNull();
    expect(router).toHaveBeenCalledTimes(1);
  });

  it("returns null without throwing when the router throws", async () => {
    const router = mock(async () => {
      throw new Error("routing failed");
    });

    await expect(pinSpecFor("x-ai/grok-4.20", router)).resolves.toBeNull();
    expect(router).toHaveBeenCalledTimes(1);
  });
});

describe("pre-route target characterization", () => {
  const native = (modelSpec: string, isTierAlias = false) => ({
    provider: "native-anthropic" as const,
    modelSpec,
    displayName: "Anthropic (Native)",
    isTierAlias,
  });

  const rows = [
    {
      target: "opus",
      nativeRoute: native("opus", true),
      parsed: {
        provider: "native-anthropic",
        model: "opus",
        original: "opus",
        isLegacySyntax: false,
        isExplicitProvider: false,
      },
      callsRouter: false,
    },
    {
      target: "opus[1m]",
      nativeRoute: native("opus[1m]"),
      parsed: {
        provider: "native-anthropic",
        model: "opus[1m]",
        original: "opus[1m]",
        isLegacySyntax: false,
        isExplicitProvider: false,
      },
      callsRouter: false,
    },
    {
      target: "opusplan",
      nativeRoute: native("opusplan"),
      parsed: {
        provider: "native-anthropic",
        model: "opusplan",
        original: "opusplan",
        isLegacySyntax: false,
        isExplicitProvider: false,
      },
      callsRouter: false,
    },
    {
      target: "best",
      nativeRoute: native("best"),
      parsed: {
        provider: "native-anthropic",
        model: "best",
        original: "best",
        isLegacySyntax: false,
        isExplicitProvider: false,
      },
      callsRouter: false,
    },
    {
      target: "internal",
      nativeRoute: native("opus", true),
      parsed: {
        provider: "native-anthropic",
        model: "internal",
        original: "internal",
        isLegacySyntax: false,
        isExplicitProvider: false,
      },
      callsRouter: false,
    },
    {
      target: "claude-opus-4-6[1m]",
      nativeRoute: native("claude-opus-4-6[1m]"),
      parsed: {
        provider: "native-anthropic",
        model: "claude-opus-4-6[1m]",
        original: "claude-opus-4-6[1m]",
        isLegacySyntax: false,
        isExplicitProvider: false,
      },
      callsRouter: false,
    },
    {
      target: "claude-haiku-4-5-20251001",
      nativeRoute: native("claude-haiku-4-5-20251001"),
      parsed: {
        provider: "native-anthropic",
        model: "claude-haiku-4-5-20251001",
        original: "claude-haiku-4-5-20251001",
        isLegacySyntax: false,
        isExplicitProvider: false,
      },
      callsRouter: false,
    },
    {
      target: "anthropic/claude-opus-5",
      nativeRoute: null,
      parsed: {
        provider: "native-anthropic",
        model: "claude-opus-5",
        original: "anthropic/claude-opus-5",
        isLegacySyntax: false,
        isExplicitProvider: false,
      },
      callsRouter: false,
    },
    {
      target: "poe:x",
      nativeRoute: null,
      parsed: {
        provider: "poe",
        model: "poe:x",
        original: "poe:x",
        isLegacySyntax: false,
        isExplicitProvider: false,
      },
      callsRouter: false,
    },
    {
      target: "kc@kimi-k3",
      nativeRoute: null,
      parsed: {
        provider: "kimi-coding",
        model: "kimi-k3",
        original: "kc@kimi-k3",
        concurrency: undefined,
        isLegacySyntax: false,
        isExplicitProvider: true,
      },
      callsRouter: false,
    },
    {
      target: "o4-mini",
      nativeRoute: null,
      parsed: {
        provider: "auto-route",
        model: "o4-mini",
        original: "o4-mini",
        isLegacySyntax: false,
        isExplicitProvider: false,
      },
      callsRouter: true,
    },
    {
      target: "no-such-model-xyz",
      nativeRoute: null,
      parsed: {
        provider: "auto-route",
        model: "no-such-model-xyz",
        original: "no-such-model-xyz",
        isLegacySyntax: false,
        isExplicitProvider: false,
      },
      callsRouter: true,
    },
    {
      target: "kimi-k3",
      nativeRoute: null,
      parsed: {
        provider: "kimi",
        model: "kimi-k3",
        original: "kimi-k3",
        isLegacySyntax: false,
        isExplicitProvider: false,
      },
      callsRouter: true,
    },
    {
      target: "openai/gpt-5",
      nativeRoute: null,
      parsed: {
        provider: "openai",
        model: "gpt-5",
        original: "openai/gpt-5",
        isLegacySyntax: false,
        isExplicitProvider: false,
      },
      callsRouter: true,
    },
    {
      target: "foo/bar",
      nativeRoute: null,
      parsed: {
        provider: "unknown",
        model: "foo/bar",
        original: "foo/bar",
        isLegacySyntax: false,
        isExplicitProvider: false,
      },
      callsRouter: true,
    },
    {
      target: "",
      nativeRoute: native(""),
      parsed: {
        provider: "native-anthropic",
        model: "",
        original: "",
        isLegacySyntax: false,
        isExplicitProvider: false,
      },
      callsRouter: false,
    },
    {
      target: "@model",
      nativeRoute: native("@model"),
      parsed: {
        provider: "native-anthropic",
        model: "@model",
        original: "@model",
        isLegacySyntax: false,
        isExplicitProvider: false,
      },
      callsRouter: false,
    },
  ];

  it.each(rows)("pins today's pre-route decision for $target", async (row) => {
    const router = mock(async () => ({
      kind: "no-route" as const,
      reason: "characterization router",
    }));

    expect(nativeRouteFor(row.target)).toEqual(row.nativeRoute);
    expect(parseModelSpec(row.target)).toEqual(row.parsed);
    expect(await pinSpecFor(row.target, router)).toBeNull();
    if (row.callsRouter) {
      expect(router).toHaveBeenCalledTimes(1);
      expect(router).toHaveBeenCalledWith(row.target);
    } else {
      expect(router).not.toHaveBeenCalled();
    }
  });
});

describe("proxyRouteDecision consistency", () => {
  const rows: Array<{
    target: string;
    type: ReturnType<typeof proxyRouteDecision>["type"];
  }> = [
    { target: "opus", type: "native" },
    { target: "opus[1m]", type: "native" },
    { target: "opusplan", type: "native" },
    { target: "best", type: "native" },
    { target: "internal", type: "native" },
    { target: "claude-opus-4-6[1m]", type: "native" },
    { target: "claude-haiku-4-5-20251001", type: "native" },
    { target: "anthropic/claude-opus-5", type: "explicit" },
    { target: "poe:x", type: "poe" },
    { target: "kc@kimi-k3", type: "explicit" },
    { target: "o4-mini", type: "bare" },
    { target: "no-such-model-xyz", type: "bare" },
    { target: "kimi-k3", type: "bare" },
    { target: "openai/gpt-5", type: "bare" },
    { target: "foo/bar", type: "bare" },
    { target: "", type: "native" },
    { target: "@model", type: "native" },
  ];

  it.each(rows)("classifies $target as $type", ({ target, type }) => {
    expect(proxyRouteDecision(target).type).toBe(type);
  });

  it.each(rows)("keeps nativeRouteFor consistent for $target", ({ target }) => {
    const decision = proxyRouteDecision(target);
    expect(nativeRouteFor(target) !== null).toBe(decision.type === "native");
  });

  it.each(rows)("calls pinSpecFor's router exactly when $target is bare", async ({ target }) => {
    const router = mock(async () => ({
      kind: "no-route" as const,
      reason: "decision consistency router",
    }));
    const decision = proxyRouteDecision(target);

    await pinSpecFor(target, router);

    expect(router).toHaveBeenCalledTimes(decision.type === "bare" ? 1 : 0);
    if (decision.type === "bare") expect(router).toHaveBeenCalledWith(target);
  });

  it("keeps anthropic/<id> explicit when the parser attributes it to native-anthropic", () => {
    expect(proxyRouteDecision("anthropic/claude-opus-5")).toEqual({
      type: "explicit",
      provider: "openrouter",
      model: "anthropic/claude-opus-5",
      spec: "anthropic/claude-opus-5",
      via: "vendor-qualified-id",
    });
    expect(nativeRouteFor("anthropic/claude-opus-5")).toBeNull();
  });
});
