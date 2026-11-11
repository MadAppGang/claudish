import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RoutingRules } from "../../profile-config.js";
import type { DiskCacheV3 } from "../all-models-cache.js";
import { type BundledListInputs, buildBundledList } from "../bundled-list-build.js";

export const GENERATION = "g-20261012101007285-7770c36e";
export const PRODUCTION_SOURCE = "https://us-central1-claudish-6da10.cloudfunctions.net";
export const RECOMMENDED_IDS = [
  "gpt-6.1-sol",
  "kimi-k3",
  "grok-4.7",
  "gemini-3.8-flash",
  "glm-5.3",
] as const;
export const TIERS = [
  "flagship",
  "cost_efficient",
  "lightweight",
  "luxury",
  "subscription",
] as const;
export const KEPT_BINDINGS: Record<string, string[]> = {
  "gpt-6.1-sol": ["openai/codex-subscription", "openai/direct-api"],
  "kimi-k3": ["moonshotai/direct-api", "moonshotai/kimi-code-subscription"],
  "grok-4.7": ["x-ai/direct-api"],
  "glm-5.3": ["z-ai/direct-api", "z-ai/glm-coding-subscription"],
  "gemini-3.8-flash": ["google/direct-api"],
};

// REQ-15 / R4.1: the only synthetic changes to the captured catalog.
export function routingSetupCatalog() {
  const cache: DiskCacheV3 = JSON.parse(
    readFileSync(
      new URL(
        "../../test-fixtures/catalog-v3/wire-g-20261012101007285-7770c36e.json",
        import.meta.url
      ),
      "utf8"
    )
  );
  for (const entry of cache.entries) {
    if (entry.modelId === "kimi-k3" || entry.modelId === "minimax-m3")
      entry.inputModalities = ["text"];
  }
  if (cache.catalogGenerationId !== GENERATION || !cache.routeRegistry)
    throw new Error("wrong setup generation");
  const entries = RECOMMENDED_IDS.map((modelId, i) => ({
    modelId,
    tier: TIERS[i],
    ...(modelId === "glm-5.3"
      ? {
          route: { routeId: "qwen", routeProfileId: "qwencloud-token-plan" },
          planId: "alibaba-token-plan-individual",
        }
      : {}),
  }));
  const efforts = Object.fromEntries(
    RECOMMENDED_IDS.map((id) => {
      const model = cache.entries.find((m) => m.modelId === id)!;
      return [
        id,
        {
          coding: {
            effort: "high",
            basis: "synthetic setup recommendation",
            sendableOn: (model.aggregators ?? [])
              .filter((c) => c.routeStatus === "mapped")
              .map((c) => ({
                routeId: c.route!.routeId,
                routeProfileId: c.route!.routeProfileId,
                externalModelId: c.externalModelId!,
                encoding: "request_parameter",
              })),
          },
        },
      ];
    })
  );
  const inputs: BundledListInputs = {
    source: PRODUCTION_SOURCE,
    fetchedAt: "2026-11-09T12:00:00.000Z",
    recommended: {
      contractVersion: 3,
      generationId: GENERATION,
      generatedAt: cache.lastUpdated,
      recommendations: { contractVersion: 3, generationId: GENERATION, entries, efforts },
    },
    routes: { generationId: GENERATION, registry: structuredClone(cache.routeRegistry.registry) },
    plans: { generationId: GENERATION, plans: structuredClone(cache.plans) },
    slim: { generationId: GENERATION, models: structuredClone(cache.entries) },
  };
  const dir = mkdtempSync(join(tmpdir(), "routing-setup-data-"));
  const cachePath = join(dir, "cloud-models-catalog-v3.json");
  writeFileSync(cachePath, JSON.stringify(cache));
  return {
    cache,
    cachePath,
    inputs,
    bundle: buildBundledList(inputs),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export type Column = "C" | "B" | "disabled";
export interface ExpectedRoute {
  hops: string[];
  cause?: string;
  withheld?: string;
  excluded?: string;
}
export interface Setup {
  id: string;
  model: string;
  credentials: string[];
  rules?: RoutingRules;
  fallback?: string;
  keychain?: boolean;
  rulesOnly?: boolean;
  gateway?: "fail" | "together" | "held" | "hang";
  account?: "grok" | "go" | "go-missing";
  feature?: "advisor" | "launch" | "efforts" | "slow" | "rebuild";
  refresh?: "transport" | "timeout" | "held-fail" | "held-success" | "skip";
  C: ExpectedRoute;
  B: ExpectedRoute;
  disabled: ExpectedRoute;
  rb: string;
}
const ok = (...hops: string[]): ExpectedRoute => ({ hops });
const no = (cause = "catalog-unreadable", withheld?: string): ExpectedRoute => ({
  hops: [],
  cause,
  ...(withheld ? { withheld } : {}),
});
const or = "openrouter@moonshotai/kimi-k3";
const openai = "openai@gpt-6.1-sol";
const codex = "openai-codex@gpt-6.1-sol";
const kimi = "kimi@kimi-k3";
const lab = "mylab@glm-5.3";
const go = "opencode-zen-go@kimi-k3";

export const ROUTING_SETUPS: Setup[] = [
  {
    id: "S1",
    model: "kimi-k3",
    credentials: ["openrouter"],
    C: ok(or),
    B: ok(or),
    disabled: no(),
    rb: "RB-4 RB-11 RB-19",
  },
  {
    id: "S1-outside",
    model: "minimax-m3",
    credentials: ["openrouter"],
    C: ok("openrouter@minimax/minimax-m3"),
    B: no(),
    disabled: no(),
    rb: "RB-14 RB-20",
  },
  {
    id: "S1-kc",
    model: "kimi-k3",
    credentials: ["openrouter"],
    keychain: true,
    C: ok(or),
    B: ok(or),
    disabled: no(),
    rb: "RB-10 RB-19",
  },
  {
    id: "S1b",
    model: "kimi-k3",
    credentials: ["openrouter"],
    gateway: "fail",
    C: ok(or),
    B: { ...no("no-credential"), excluded: "openrouter" },
    disabled: no(),
    rb: "RB-4",
  },
  {
    id: "S1c",
    model: "kimi-k3",
    credentials: ["together"],
    fallback: "together",
    gateway: "together",
    C: ok("together@moonshotai/Kimi-K3"),
    B: { ...no("no-credential"), excluded: "together" },
    disabled: no(),
    rb: "RB-4",
  },
  {
    id: "S2",
    model: "gpt-6.1-sol",
    credentials: ["openai-codex", "openai"],
    C: ok(codex, openai),
    B: { ...ok(codex, openai), withheld: "bundled-no-default-provider" },
    disabled: no(),
    rb: "RB-8 RB-9 RB-12 RB-19",
  },
  {
    id: "S3",
    model: "kimi-k3",
    credentials: ["kimi", "openrouter"],
    rules: { "kimi-*": ["kimi", "openrouter"] },
    C: ok(kimi, or),
    B: ok(kimi, or),
    disabled: ok(kimi, "openrouter@kimi-k3"),
    rb: "RB-3 RB-4 RB-29",
  },
  {
    id: "S3b",
    model: "kimi-k3",
    credentials: ["kimi", "openrouter"],
    rules: { "kimi-*": ["kimi", "openrouter"] },
    gateway: "fail",
    C: ok(kimi, or),
    B: { ...ok(kimi), excluded: "openrouter" },
    disabled: ok(kimi, "openrouter@kimi-k3"),
    rb: "RB-3 RB-4",
  },
  {
    id: "S4",
    model: "glm-5.3",
    credentials: ["mylab"],
    fallback: "mylab",
    C: ok(lab),
    B: ok(lab),
    disabled: no(),
    rb: "RB-15 RB-19 RB-21",
  },
  {
    id: "S4-outside",
    model: "minimax-m3",
    credentials: ["mylab"],
    fallback: "mylab",
    C: ok("mylab@minimax-m3"),
    B: no(),
    disabled: no(),
    rb: "RB-20",
  },
  {
    id: "S5",
    model: "kimi-k3",
    credentials: [],
    C: no("no-credential"),
    B: no("no-credential", "bundled-no-default-provider"),
    disabled: no(),
    rb: "RB-12 RB-14",
  },
  {
    id: "S6",
    model: "kimi-k3",
    credentials: ["kimi-coding", "kimi", "openrouter"],
    C: ok("kimi-coding@k3", kimi, or),
    B: ok("kimi-coding@k3", kimi, or),
    disabled: no(),
    rb: "RB-8 RB-18",
  },
  {
    id: "S7",
    model: "grok-4.7",
    credentials: ["grok-subscription", "x-ai"],
    account: "grok",
    C: ok("grok-subscription@grok-4.7", "x-ai@grok-4.7"),
    B: ok("grok-subscription@grok-4.7", "x-ai@grok-4.7"),
    disabled: ok("grok-subscription@grok-4.7"),
    rb: "RB-5 RB-13 RB-18",
  },
  {
    id: "S8",
    model: openai,
    credentials: ["openai"],
    C: ok(openai),
    B: ok(openai),
    disabled: ok(openai),
    rb: "RB-2",
  },
  {
    id: "S8b",
    model: "openai@minimax-m3",
    credentials: ["openai"],
    C: ok("openai@minimax-m3"),
    B: ok("openai@minimax-m3"),
    disabled: ok("openai@minimax-m3"),
    rb: "RB-2",
  },
  {
    id: "S8c",
    model: go,
    credentials: ["opencode-zen-go"],
    C: ok(go),
    B: ok(go),
    disabled: ok(go),
    rb: "RB-2 RB-17",
  },
  {
    id: "S9",
    model: "kimi-k3",
    credentials: ["openrouter"],
    fallback: "",
    C: ok(or),
    B: no("no-credential", "disabled"),
    disabled: no(),
    rb: "RB-10 RB-19",
  },
  {
    id: "S10",
    model: "kimi-k3",
    credentials: ["opencode-zen-go"],
    account: "go",
    C: ok(go),
    B: ok(go),
    disabled: ok(go),
    rb: "RB-17 RB-18",
  },
  {
    id: "S10b",
    model: "kimi-k3",
    credentials: ["opencode-zen-go"],
    account: "go-missing",
    C: ok(go),
    B: no("no-credential"),
    disabled: no(),
    rb: "RB-17 RB-18",
  },
  {
    id: "S11",
    model: "gpt-6.1-sol",
    credentials: ["openai"],
    feature: "advisor",
    C: ok(openai),
    B: ok(openai),
    disabled: no(),
    rb: "RB-26",
  },
  {
    id: "S11b",
    model: "gpt-6.1-sol",
    credentials: ["openai"],
    feature: "advisor",
    refresh: "transport",
    C: ok(openai),
    B: ok(openai),
    disabled: no(),
    rb: "RB-26 RB-31",
  },
  {
    id: "S11c",
    model: "gpt-6.1-sol",
    credentials: ["openai"],
    feature: "advisor",
    refresh: "held-fail",
    C: ok(openai),
    B: ok(openai),
    disabled: no(),
    rb: "RB-16 RB-26",
  },
  {
    id: "S11d",
    model: "kimi-k3",
    credentials: ["openrouter"],
    feature: "advisor",
    gateway: "hang",
    C: ok(or),
    B: { ...no("no-credential"), excluded: "openrouter" },
    disabled: no(),
    rb: "RB-4 RB-26 RB-29",
  },
  {
    id: "S11e",
    model: "kimi-k3",
    credentials: ["openrouter"],
    feature: "advisor",
    gateway: "held",
    C: ok(or),
    B: ok(or),
    disabled: no(),
    rb: "RB-4 RB-26 RB-29",
  },
  {
    id: "S12",
    model: "gpt-6.1-sol",
    credentials: ["openai-codex"],
    feature: "launch",
    refresh: "transport",
    C: ok(codex),
    B: ok(codex),
    disabled: no(),
    rb: "RB-31",
  },
  {
    id: "S12b",
    model: "minimax-m3",
    credentials: ["openai-codex"],
    feature: "launch",
    refresh: "transport",
    C: no("no-credential"),
    B: no(),
    disabled: no(),
    rb: "RB-14 RB-31",
  },
  {
    id: "S12c",
    model: "gpt-6.1-sol",
    credentials: ["openai-codex"],
    feature: "launch",
    refresh: "timeout",
    C: ok(codex),
    B: ok(codex),
    disabled: no(),
    rb: "RB-31",
  },
  {
    id: "S12d",
    model: "gpt-6.1-sol",
    credentials: ["openai-codex"],
    feature: "launch",
    refresh: "skip",
    C: ok(codex),
    B: ok(codex),
    disabled: no(),
    rb: "RB-16 RB-31",
  },
  {
    id: "S12e",
    model: "minimax-m3",
    credentials: [],
    feature: "launch",
    refresh: "transport",
    C: no("no-credential"),
    B: no(),
    disabled: no(),
    rb: "RB-14 RB-31",
  },
  {
    id: "S13",
    model: "gpt-6.1-sol",
    credentials: ["openai"],
    feature: "efforts",
    C: ok(openai),
    B: ok(openai),
    disabled: no(),
    rb: "RB-23",
  },
  {
    id: "S14",
    model: "kimi-k3",
    credentials: ["openrouter"],
    feature: "slow",
    refresh: "held-success",
    C: ok(or),
    B: ok(or),
    disabled: no(),
    rb: "RB-16",
  },
  {
    id: "S15",
    model: "kimi-k3",
    credentials: ["kimi"],
    feature: "rebuild",
    C: ok(kimi),
    B: ok(kimi),
    disabled: no(),
    rb: "RB-16",
  },
  {
    id: "S16",
    model: "gpt-6.1-sol",
    credentials: ["openai-codex"],
    feature: "launch",
    refresh: "held-success",
    C: ok(codex),
    B: ok(codex),
    disabled: no(),
    rb: "RB-16 RB-31",
  },
  {
    id: "S16b",
    model: "gpt-6.1-sol",
    credentials: ["openai-codex"],
    feature: "launch",
    refresh: "held-fail",
    C: ok(codex),
    B: ok(codex),
    disabled: no(),
    rb: "RB-16 RB-31",
  },
  {
    id: "S16c",
    model: "gpt-6.1-sol",
    credentials: ["openai-codex", "openai"],
    feature: "launch",
    refresh: "held-success",
    C: ok(codex, openai),
    B: no(),
    disabled: no(),
    rb: "RB-31",
  },
  {
    id: "S17",
    model: "glm-5.3",
    credentials: ["mylab"],
    rules: { "not-this-model": ["openai"] },
    fallback: "mylab",
    C: ok(lab),
    B: ok(lab),
    disabled: no(),
    rb: "RB-10 RB-19",
  },
  {
    id: "S17b",
    model: "glm-5.3",
    credentials: ["mylab"],
    rules: { "not-this-model": ["openai"] },
    fallback: "mylab",
    rulesOnly: true,
    C: no("no-credential"),
    B: no("no-credential", "bundled-no-default-provider"),
    disabled: no(),
    rb: "RB-10",
  },
];
