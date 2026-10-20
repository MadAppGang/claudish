import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeTargets } from "../providers/probe-runner.js";
import type { RouteExplanation } from "../providers/routing-rules.js";
import { type ProbeChainLink, type ProbeDroppedLink, resultLinksFrom } from "./probe-chain.js";

const CATALOG_FIXTURE = join(
  import.meta.dir,
  "..",
  "test-fixtures",
  "stage5-explain-route-catalog.json"
);
const CLI_ENTRY = join(import.meta.dir, "..", "index.ts");
const REPO_ROOT = join(import.meta.dir, "../../../..");

interface ProbeJson {
  model: string;
  nativeProvider: string;
  isExplicit: boolean;
  routingSource: RouteExplanation["source"];
  routingExplanation: string;
  chain: ProbeChainLink[];
  dropped: ProbeDroppedLink[];
  catalog?: RouteExplanation["catalog"];
  fallbackWithheld?: RouteExplanation["fallbackWithheld"];
  outcome: RouteExplanation["outcome"];
}

function sandboxedProbe(model: string, keys: Record<string, string> = {}): ProbeJson {
  const home = mkdtempSync(join(tmpdir(), "claudish-stage6-probe-"));
  const configDir = join(home, ".claudish");
  mkdirSync(configDir, { recursive: true });
  copyFileSync(CATALOG_FIXTURE, join(configDir, "cloud-models-catalog-v3.json"));
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      version: "1.0.0",
      defaultProfile: "default",
      profiles: {},
      routing: { "rule-*": ["openrouter", "openai"] },
    }),
    "utf8"
  );

  const env: Record<string, string> = {
    HOME: home,
    PATH: process.env.PATH ?? "",
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    CLAUDISH_DISABLE_CATALOG_WARM: "1",
    CLAUDISH_DISABLE_OP: "1",
    CLAUDISH_DISABLE_KEYCHAIN: "1",
    CLAUDISH_SKIP_LIVE_E2E: "1",
    ...keys,
  };

  try {
    const child = Bun.spawnSync(
      [process.execPath, "--no-env-file", CLI_ENTRY, "--probe", model, "--json", "--no-probe"],
      {
        cwd: REPO_ROOT,
        env,
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const stdout = child.stdout.toString();
    const stderr = child.stderr.toString();
    expect(child.exitCode, stderr || stdout).toBe(0);
    const results = JSON.parse(stdout) as ProbeJson[];
    expect(results).toHaveLength(1);
    return results[0];
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function candidate(
  provider: string,
  outcome: RouteExplanation["candidates"][number]["outcome"]
): RouteExplanation["candidates"][number] {
  return {
    provider,
    displayName: provider,
    modelSpec: `${provider}@target`,
    wireId: "target",
    position: "candidate",
    tier: provider === "openrouter" ? "gateway" : "native",
    outcome,
  };
}

describe("--probe explanation JSON", () => {
  test("uses the new source union and the route() chain order", () => {
    const keys = {
      OPENAI_API_KEY: "stage6-openai",
      OPENROUTER_API_KEY: "stage6-openrouter",
    };
    const catalog = sandboxedProbe("cat-found", keys);
    const userRule = sandboxedProbe("rule-mix", keys);
    const explicit = sandboxedProbe("openai@cat-found", keys);
    const vendorQualified = sandboxedProbe("anthropic/claude-opus-5", keys);
    const native = sandboxedProbe("claude-opus-5", keys);

    expect(catalog.routingSource).toBe("catalog");
    expect(catalog.chain.map((entry) => entry.provider)).toEqual(["openai", "openrouter"]);
    expect(catalog.dropped).toEqual([]);

    expect(userRule.routingSource).toBe("user-rule");
    expect(userRule.chain.map((entry) => entry.provider)).toEqual(["openrouter", "openai"]);

    expect(explicit).toMatchObject({ routingSource: "explicit", isExplicit: true });
    expect(explicit.chain).toHaveLength(1);
    expect(explicit.chain[0]).toMatchObject({ provider: "openai", wireId: "cat-found" });

    expect(vendorQualified).toMatchObject({ routingSource: "explicit", isExplicit: true });
    expect(vendorQualified.chain).toEqual([
      expect.objectContaining({
        provider: "openrouter",
        modelSpec: "anthropic/claude-opus-5",
        wireId: "anthropic/claude-opus-5",
      }),
    ]);

    expect(native.routingSource).toBe("native");
    expect(native.chain).toEqual([
      expect.objectContaining({
        provider: "native-anthropic",
        notProbed: "native-auth",
      }),
    ]);
    expect(native.dropped).toEqual([]);
  });

  test("keeps only credentialed candidates and lists every dropped outcome", () => {
    const result = sandboxedProbe("cat-found", {
      OPENROUTER_API_KEY: "stage6-openrouter",
    });

    expect(result.chain.map((entry) => entry.provider)).toEqual(["openrouter"]);
    expect(result.dropped).toEqual([
      expect.objectContaining({
        provider: "openai",
        position: "candidate",
        outcome: "no-credential",
      }),
    ]);
    expect(result.outcome).toEqual({ kind: "ok" });
  });

  test("unknown names keep exactly the labelled fallback and explain the absent entry", () => {
    const result = sandboxedProbe("no-such-model-xyz", {
      OPENROUTER_API_KEY: "stage6-openrouter",
    });

    expect(result).toMatchObject({
      routingSource: "catalog",
      catalog: "absent",
      routingExplanation: 'catalog has no entry for "no-such-model-xyz" · fallback only',
      outcome: { kind: "ok" },
    });
    expect(result.chain).toEqual([
      expect.objectContaining({
        provider: "openrouter",
        position: "fallback",
        label: "fallback",
      }),
    ]);
    expect(result.dropped).toEqual([]);
  });

  test("an uncredentialed fallback is dropped and described by its outcome", () => {
    const result = sandboxedProbe("no-such-model-xyz");

    expect(result.chain).toEqual([]);
    expect(result.dropped).toEqual([
      expect.objectContaining({
        provider: "openrouter",
        position: "fallback",
        label: "fallback",
        outcome: "no-credential",
      }),
    ]);
    expect(result.routingExplanation).toBe(
      'catalog has no entry for "no-such-model-xyz" · fallback OpenRouter has no credential'
    );
    expect(result.routingExplanation).not.toContain("fallback only");
  });
});

describe("probe targets and TUI links", () => {
  test("probeTargets returns kept candidates only and preserves explicit input", () => {
    const explanation: RouteExplanation = {
      requestedModel: "openai@target",
      routedModel: "target",
      source: "explicit",
      via: "model-spec",
      candidates: [
        candidate("openai", "kept"),
        candidate("openrouter", "no-credential"),
        candidate("poe", "not-served"),
      ],
      outcome: { kind: "ok" },
      warnings: [],
    };

    expect(probeTargets(explanation)).toEqual([
      expect.objectContaining({
        provider: "openai",
        outcome: "kept",
        probeSpec: "openai@target",
      }),
    ]);

    const native: RouteExplanation = {
      requestedModel: "claude-opus-5",
      routedModel: "claude-opus-5",
      source: "native",
      candidates: [],
      outcome: { kind: "ok" },
      warnings: [],
      native: {
        provider: "native-anthropic",
        modelSpec: "claude-opus-5",
        displayName: "Anthropic (Native)",
        isTierAlias: false,
      },
    };
    expect(probeTargets(native)).toEqual([]);
  });

  test("o4-mini and a bare no-route have no auto-route TUI link", () => {
    const o4Links = resultLinksFrom(
      [
        {
          provider: "openai",
          displayName: "OpenAI",
          modelSpec: "oai@o4-mini",
          wireId: "o4-mini",
          position: "candidate",
          tier: "native",
          label: "native API",
          hasCredentials: true,
        },
      ],
      []
    );
    const noRouteLinks = resultLinksFrom(
      [],
      [
        {
          provider: "openrouter",
          displayName: "OpenRouter",
          wireId: "no-such-model-xyz",
          position: "fallback",
          tier: "gateway",
          label: "fallback",
          outcome: "no-credential",
          credentialHint: "OPENROUTER_API_KEY",
        },
      ]
    );

    expect(o4Links[0]?.displayName).toBe("OpenAI");
    expect(noRouteLinks).toEqual([
      expect.objectContaining({
        provider: "openrouter",
        displayName: "OpenRouter",
        dropped: "no-credential",
      }),
    ]);
    expect(JSON.stringify({ o4Links, noRouteLinks })).not.toContain("auto-route");
  });
});
