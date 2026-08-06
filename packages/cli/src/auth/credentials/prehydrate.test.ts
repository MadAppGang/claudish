import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { PROVIDER_TO_PREFIX } from "../../providers/auto-route.js";
import { parseModelSpec } from "../../providers/model-parser.js";
import type { Route } from "../../providers/routing-rules.js";
import { __resetSniffForTests } from "./op-source.js";
import { normalizePinnedSpec, pinSpecFor, prehydrateCredentialsForSpawn } from "./prehydrate.js";

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

describe("pinSpecFor routing gate", () => {
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
