import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAllModelsCache, writeAllModelsCache } from "../providers/all-models-cache.js";
import type { RouteExplanation } from "../providers/routing-rules.js";
import {
  type AdvisorModelPlan,
  type PlanAdvisorDeps,
  describeAdvisorRefusal,
  planAdvisorModel,
} from "./advisor-route-plan.js";

const startupBudgetMs = 250;
const bareModel = "gpt-6.1-sol";
let root: string;
let cachePath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "claudish-advisor-catalog-startup-"));
  cachePath = join(root, "cloud-models-catalog-v3.json");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// The background refresh stays pending independently of the blocking readiness check.
type CatalogPlanningDeps = PlanAdvisorDeps & {
  warmCatalog: () => Promise<void>;
};

function planningDeps() {
  const pendingWarm = new Promise<void>(() => {});
  const readCatalog = mock(() => readAllModelsCache(cachePath));
  const warmCatalog = mock(() => pendingWarm);
  const ensureCatalog = mock((_timeoutMs: number) =>
    readCatalog() ? Promise.resolve() : pendingWarm
  );
  const explain = mock(async (spec: string): Promise<RouteExplanation> => {
    const explicit = spec.includes("@");
    const model = explicit ? spec.slice(spec.indexOf("@") + 1) : spec;
    const cached = explicit ? null : readCatalog();
    if (!explicit && !cached?.entries.some((entry) => entry.modelId === model)) {
      return {
        requestedModel: spec,
        routedModel: model,
        source: "catalog",
        candidates: [],
        outcome: {
          kind: "no-route",
          cause: "catalog-unreadable",
          reason: `The cloud models catalog is unavailable for "${model}".`,
          hint: "Use provider@model or launch again.",
        },
        warnings: [],
      };
    }
    return {
      requestedModel: spec,
      routedModel: model,
      source: explicit ? "explicit" : "catalog",
      candidates: [
        {
          provider: "openai",
          displayName: "OpenAI",
          modelSpec: explicit ? spec : `openai@${model}`,
          wireId: model,
          position: "candidate",
          outcome: "kept",
        },
      ],
      outcome: { kind: "ok" },
      warnings: [],
    };
  });
  const deps: CatalogPlanningDeps = {
    childAuth: { controlled: true },
    anthropicKeyPresent: async () => false,
    ensureCatalog,
    warmCatalog,
    explain,
    isSubscription: () => false,
  };
  return { deps, ensureCatalog, warmCatalog, readCatalog, explain };
}

async function withinStartupBudget<T>(operation: () => Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const started = performance.now();
  try {
    const value = await Promise.race([
      operation(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), startupBudgetMs);
      }),
    ]);
    return { value, elapsedMs: performance.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

function expectCatalogRefusal(plan: AdvisorModelPlan | null) {
  expect(plan?.kind).toBe("refused");
  if (plan?.kind !== "refused") throw new Error("missing cloud models catalog refusal");
  const refusal = describeAdvisorRefusal(plan);
  expect(refusal).toMatch(/models? catalog/i);
  expect(refusal).toMatch(/provider@model|launch again/i);
}

describe("advisor startup never waits for the cloud models catalog", () => {
  test("a bare member with no catalog file refuses while a background refresh stays pending", async () => {
    const { deps, ensureCatalog, warmCatalog } = planningDeps();
    expect(existsSync(cachePath)).toBe(false);

    const result = await withinStartupBudget(() => planAdvisorModel(bareModel, "panel", deps));

    expect(result.elapsedMs).toBeLessThan(startupBudgetMs);
    expectCatalogRefusal(result.value);
    expect(ensureCatalog).not.toHaveBeenCalled();
    expect(warmCatalog).toHaveBeenCalledTimes(1);
    expect(existsSync(cachePath)).toBe(false);
  });

  test("two sequential bare members with no catalog file share one short startup budget", async () => {
    const { deps, ensureCatalog, warmCatalog } = planningDeps();
    expect(existsSync(cachePath)).toBe(false);

    const result = await withinStartupBudget(async () => {
      const plans: AdvisorModelPlan[] = [];
      for (const spec of [bareModel, "gemini-advisor-test"]) {
        plans.push(await planAdvisorModel(spec, "panel", deps));
      }
      return plans;
    });

    expect(result.elapsedMs).toBeLessThan(startupBudgetMs);
    expect(result.value).toHaveLength(2);
    for (const plan of result.value ?? []) expectCatalogRefusal(plan);
    expect(ensureCatalog).not.toHaveBeenCalled();
    expect(warmCatalog).toHaveBeenCalled();
    expect(existsSync(cachePath)).toBe(false);
  });

  test("a bare member is planned from an existing catalog file", async () => {
    writeAllModelsCache(
      {
        version: 3,
        lastUpdated: new Date().toISOString(),
        catalogGenerationId: "advisor-startup-test-generation",
        entries: [{ modelId: bareModel, aliases: [], provider: "openai" }],
        models: [{ id: bareModel }],
        plans: [],
      },
      cachePath
    );
    const { deps, explain } = planningDeps();
    expect(existsSync(cachePath)).toBe(true);
    expect(readAllModelsCache(cachePath)?.entries.map((entry) => entry.modelId)).toEqual([
      bareModel,
    ]);

    const result = await withinStartupBudget(() => planAdvisorModel(bareModel, "panel", deps));

    expect(result.elapsedMs).toBeLessThan(startupBudgetMs);
    expect(result.value).toMatchObject({
      kind: "routed",
      spec: bareModel,
      invocationMode: "auto-route",
      hops: [{ provider: "openai", modelSpec: `openai@${bareModel}`, wireId: bareModel }],
    });
    expect(explain).toHaveBeenCalledWith(bareModel);
  });

  test("an explicit provider@model member never touches the catalog", async () => {
    const { deps, ensureCatalog, warmCatalog, readCatalog, explain } = planningDeps();
    const spec = `openai@${bareModel}`;
    expect(existsSync(cachePath)).toBe(false);

    const result = await withinStartupBudget(() => planAdvisorModel(spec, "collector", deps));

    expect(result.elapsedMs).toBeLessThan(startupBudgetMs);
    expect(result.value).toMatchObject({
      kind: "routed",
      spec,
      invocationMode: "explicit-model",
      hops: [{ provider: "openai", modelSpec: spec }],
    });
    expect(ensureCatalog).not.toHaveBeenCalled();
    expect(warmCatalog).not.toHaveBeenCalled();
    expect(readCatalog).not.toHaveBeenCalled();
    expect(explain).toHaveBeenCalledWith(spec);
    expect(existsSync(cachePath)).toBe(false);
  });
});
