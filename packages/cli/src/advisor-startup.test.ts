import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  type AdvisorLaunchFacts,
  type AdvisorStartupDecision,
  advisorMemberRefusal,
  decideAdvisorStartup,
  evaluateAdvisorStartup,
  resolveMainModelFact,
} from "./advisor-startup.js";
import { resolveAdvisorToolEnv } from "./claude-runner.js";
import {
  type AdvisorChainBuild,
  type AdvisorHop,
  type AdvisorModelPlan,
  advisorChainKey,
  planAdvisorModel,
} from "./handlers/advisor-route-plan.js";
import type { HandlerSet } from "./handlers/handler-set.js";
import type { ModelHandler } from "./handlers/types.js";
import { _resetCatalogClient, _setCatalogEntriesForTest } from "./providers/catalog-client.js";
import type { ClaudishConfig } from "./types.js";

const ENABLE_ENV_VAR = "CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL";
const DISABLE_ENV_VAR = "CLAUDE_CODE_DISABLE_ADVISOR_TOOL";

type RoutedPlan = Extract<AdvisorModelPlan, { kind: "routed" }>;

function config(overrides: Partial<ClaudishConfig> = {}): ClaudishConfig {
  return {
    autoApprove: false,
    dangerous: false,
    interactive: false,
    debug: false,
    logLevel: "info",
    quiet: false,
    jsonOutput: false,
    monitor: false,
    stdin: false,
    claudeArgs: [],
    noLogs: false,
    diagMode: "auto",
    ...overrides,
  };
}

function routedPlan(
  spec = "openai/gpt-5.6-sol",
  role: "panel" | "collector" = "panel",
  hops: AdvisorHop[] = [
    {
      provider: "openai-codex",
      displayName: "OpenAI Codex",
      modelSpec: "cx@gpt-6.1-sol",
      wireId: "gpt-6.1-sol",
      billing: "subscription",
      tier: "subscription",
    },
  ]
): RoutedPlan {
  return {
    kind: "routed",
    spec,
    role,
    explanation: {
      requestedModel: spec,
      routedModel: spec,
      source: "catalog",
      candidates: [],
      warnings: [],
      outcome: { kind: "ok" },
    },
    hops,
    invocationMode: "auto-route",
  };
}

function builtChain(plan: RoutedPlan): AdvisorChainBuild {
  const handler: ModelHandler = {
    async handle() {
      throw new Error("Startup must not invoke a built handler");
    },
    async shutdown() {},
  };
  return {
    key: advisorChainKey(plan.role, plan.spec),
    builds: plan.hops.map((hop) => ({ kind: "built", handler, transportName: hop.provider })),
    handler,
    firstCallableHop: 0,
    uidByTransportName: new Map(plan.hops.map((hop) => [hop.provider, hop.provider])),
  };
}

function collectorRefusal(
  cause: "claude-no-credential" | "unresolved-alias" = "claude-no-credential"
): Extract<AdvisorModelPlan, { kind: "refused" }> {
  return {
    kind: "refused",
    spec: "haiku",
    role: "collector",
    cause,
    reason:
      cause === "unresolved-alias"
        ? 'Cannot resolve Claude alias "haiku" without the cloud models catalog.'
        : "haiku is a Claude model; this launch gives the advisor no Claude login (a --model of another provider), and no ANTHROPIC_API_KEY was found in env, config, keychain or 1Password",
  };
}

function facts(overrides: Partial<AdvisorLaunchFacts> = {}): AdvisorLaunchFacts {
  const toolEnv = resolveAdvisorToolEnv(config({ advisor: true }), {});
  const panelPlans = overrides.panelPlans ?? [routedPlan()];
  const collectorPlan = overrides.collectorPlan ?? null;
  const routed = [...panelPlans, ...(collectorPlan ? [collectorPlan] : [])].filter(
    (plan): plan is RoutedPlan => plan.kind === "routed"
  );
  return {
    panel: ["openai/gpt-5.6-sol"],
    collector: null,
    collectorDefaulted: false,
    mainModels: [],
    childEnv: { ...toolEnv.vars },
    toolEnv,
    panelPlans,
    collectorPlan,
    builds: new Map(
      routed.map((plan) => [advisorChainKey(plan.role, plan.spec), builtChain(plan)])
    ),
    childAuth: { controlled: true },
    ...overrides,
  };
}

function expectProceed(decision: AdvisorStartupDecision) {
  expect(decision.kind).toBe("proceed");
  if (decision.kind !== "proceed") throw new Error(decision.reason);
  return decision;
}

beforeEach(() => {
  _resetCatalogClient();
  _setCatalogEntriesForTest(null);
});

afterEach(() => {
  _resetCatalogClient();
});

describe("resolveMainModelFact", () => {
  it("labels a bare non-Claude name as unresolved until its first routed request", () => {
    expect(resolveMainModelFact("o4-mini")).toEqual({
      model: "o4-mini",
      providerName: "unresolved (routed on the first request)",
      carriesTools: true,
      wireFormat: undefined,
    });
  });
});

describe("decideAdvisorStartup", () => {
  describe("CLAUDE_CODE_DISABLE_ADVISOR_TOOL", () => {
    it.each(["1", "true", "yes", "on", " TRUE "])("refuses when the child value is %p", (value) => {
      const decision = decideAdvisorStartup(
        facts({ childEnv: { [ENABLE_ENV_VAR]: "1", [DISABLE_ENV_VAR]: value } })
      );

      expect(decision.kind).toBe("refuse");
      if (decision.kind === "refuse") expect(decision.reason).toContain(DISABLE_ENV_VAR);
    });

    it.each(["2", "false", "0", ""])(
      "does not refuse for the disable variable when the child value is %p",
      (value) => {
        const decision = decideAdvisorStartup(
          facts({ childEnv: { [ENABLE_ENV_VAR]: "1", [DISABLE_ENV_VAR]: value } })
        );

        expectProceed(decision);
      }
    );
  });

  it.each(["no-credential", "explicit-no-credential"] as const)(
    "refuses a panel plan with %s and names the model and credential",
    (cause) => {
      const model = "openai/gpt-5.6-sol";
      const reason = "No OPENAI_API_KEY was found";
      const hint = "Set OPENAI_API_KEY.";
      const decision = decideAdvisorStartup(
        facts({
          panelPlans: [{ kind: "refused", spec: model, role: "panel", cause, reason, hint }],
        })
      );

      expect(decision.kind).toBe("refuse");
      if (decision.kind === "refuse") {
        expect(decision.reason).toBe(
          // One full stop: the hint's own ends the reason (it printed `..`).
          `advisor panel model cannot be called: ${model}: ${reason} ${hint} Remove the model from --advisor, or fix what the reason names (claudish --probe ${model} shows the routing decision).`
        );
      }
    }
  );

  it.each([
    { build: { kind: "not-built" } as const, reason: "could not be built" },
    {
      build: { kind: "failed", message: "construction failed" } as const,
      reason: "could not be built: construction failed",
    },
    {
      build: { kind: "refused", message: "unsupported wire", chainContinues: false } as const,
      reason: "unsupported wire",
    },
  ])("refuses a routed panel when its only hop is $build.kind", ({ build, reason }) => {
    const plan = routedPlan();
    const chain = builtChain(plan);
    chain.firstCallableHop = null;
    chain.builds = [build.kind === "refused" ? { ...build, handler: chain.handler! } : build];
    const decision = decideAdvisorStartup(facts({ builds: new Map([[chain.key, chain]]) }));

    expect(decision.kind).toBe("refuse");
    if (decision.kind === "refuse") {
      expect(decision.reason).toContain(
        `${plan.spec}: no hop could be built — OpenAI Codex: ${reason}`
      );
    }
  });

  it("proceeds when all panel chains are callable and there is no collector", () => {
    const decision = expectProceed(decideAdvisorStartup(facts()));

    expect(decision.effectiveCollector).toBeNull();
    expect(decision.runtime.plans.has("panel:openai/gpt-5.6-sol")).toBe(true);
  });

  it("refuses when a user-named collector credential is missing and names it", () => {
    const collectorPlan = collectorRefusal();
    const decision = decideAdvisorStartup(
      facts({ collector: collectorPlan.spec, collectorDefaulted: false, collectorPlan })
    );

    expect(decision.kind).toBe("refuse");
    if (decision.kind === "refuse") {
      expect(decision.reason).toBe(
        `collector ${collectorPlan.reason}. Name another collector ("a,b:collector"), or end the value with ":" for no collector (claudish --probe haiku shows the routing decision).`
      );
      expect(decision.reason).toContain("haiku");
      expect(decision.reason).toContain("ANTHROPIC_API_KEY");
    }
  });

  it("drops an unavailable default collector and explains concatenation", () => {
    const collectorPlan = collectorRefusal();
    const decision = expectProceed(
      decideAdvisorStartup(facts({ collector: "haiku", collectorDefaulted: true, collectorPlan }))
    );

    expect(decision.effectiveCollector).toBeNull();
    expect(decision.notice).toContain(
      `  collector:  none — ${collectorPlan.reason}; panel answers will be concatenated`
    );
    expect(decision.runtime.plans.has("collector:haiku")).toBe(false);
  });

  describe("unresolved collector aliases", () => {
    it.each([true, false])(
      "keeps an unresolved alias uncallable when credential presence is %p",
      async (keyPresent) => {
        const plan = await planAdvisorModel("haiku", "collector", {
          childAuth: { controlled: false, reason: "proxy-auth", where: "--model" },
          anthropicKeyPresent: async () => keyPresent,
          ensureCatalog: async () => {},
          explain: async () => {
            throw new Error("A native Claude alias must not reach explainRoute");
          },
        });

        expect(plan).toMatchObject({ kind: "refused", cause: "unresolved-alias", spec: "haiku" });
        const refusal = advisorMemberRefusal(plan, new Map());
        expect(refusal).not.toBeNull();
        expect(refusal).toContain("haiku");
      }
    );

    it("refuses an unresolved collector named by the user", () => {
      const decision = decideAdvisorStartup(
        facts({
          collector: "haiku",
          collectorDefaulted: false,
          collectorPlan: collectorRefusal("unresolved-alias"),
        })
      );

      expect(decision.kind).toBe("refuse");
      if (decision.kind === "refuse") expect(decision.reason).toContain("haiku");
    });

    it("drops an unresolved default collector and explains concatenation", () => {
      const decision = expectProceed(
        decideAdvisorStartup(
          facts({
            collector: "haiku",
            collectorDefaulted: true,
            collectorPlan: collectorRefusal("unresolved-alias"),
          })
        )
      );

      expect(decision.effectiveCollector).toBeNull();
      expect(decision.notice.some((line) => line.includes("haiku"))).toBe(true);
      expect(decision.notice.some((line) => line.includes("concatenat"))).toBe(true);
      expect(decision.runtime.plans.has("collector:haiku")).toBe(false);
    });

    it.each([true, false])(
      "keeps a resolved collector when collectorDefaulted is %p",
      (collectorDefaulted) => {
        const collector = "claude-haiku-4-5";
        const decision = expectProceed(
          decideAdvisorStartup(
            facts({
              collector,
              collectorDefaulted,
              collectorPlan: {
                kind: "claude-native",
                spec: collector,
                role: "collector",
                model: collector,
                expectedArm: "claude-login",
              },
            })
          )
        );

        expect(decision.effectiveCollector).toBe(collector);
        expect(decision.runtime.plans.has(`collector:${collector}`)).toBe(true);
      }
    );
  });

  it("refuses when a main-model path cannot carry tools", () => {
    const decision = decideAdvisorStartup(
      facts({
        mainModels: [
          {
            model: "ollamacloud/qwen3",
            providerName: "ollamacloud",
            carriesTools: false,
            wireFormat: "Ollama",
          },
        ],
      })
    );

    expect(decision.kind).toBe("refuse");
    if (decision.kind === "refuse") {
      expect(decision.reason).toContain("ollamacloud/qwen3");
      expect(decision.reason.toLowerCase()).toContain("tool");
    }
  });

  it("reports panel routing, credential billing, cost, and a claudish-set enable variable", () => {
    const plan = routedPlan("gpt-6.1-sol");
    plan.hops.push({
      provider: "openai",
      displayName: "OpenAI",
      modelSpec: "openai@gpt-6.1-sol",
      wireId: "gpt-6.1-sol",
      billing: "metered",
      tier: "native",
    });
    plan.explanation.warnings = [
      {
        type: "subscription-not-served",
        providers: ["antigravity"],
        usedInstead: "openai-codex",
        message: "Antigravity does not serve this model",
      },
      {
        type: "subscription-credential-unreadable",
        providers: ["devin"],
        usedInstead: "openai-codex",
        message: "Devin credential could not be read",
      },
    ];
    const decision = expectProceed(
      decideAdvisorStartup(
        facts({
          panel: [plan.spec, "haiku"],
          panelPlans: [
            plan,
            {
              kind: "claude-native",
              spec: "haiku",
              role: "panel",
              model: "claude-haiku-4-5",
              expectedArm: "claude-login",
            },
          ],
        })
      )
    );

    expect(decision.notice).toContain("  panel (each model is routed like a main-model request):");
    expect(decision.notice).toContain(
      "    gpt-6.1-sol -> OpenAI Codex (subscription); then OpenAI (metered, billed per token) (if the subscription login is rejected, calls move on to the metered hop)"
    );
    expect(decision.notice).toContain(
      "    haiku -> api.anthropic.com (subscription: your Claude Code login; if a request carries none: its x-api-key or ANTHROPIC_API_KEY, metered, billed per token)"
    );
    for (const warning of plan.explanation.warnings) {
      expect(decision.notice).toContain(`      note: ${warning.message}`);
    }
    expect(decision.notice.join("\n")).not.toContain("never use a subscription");
    expect(decision.notice).toContain(
      "  cost: each advisor call sends the FULL conversation to every panel model, uncached; subscription hops draw on the plan's allowance, metered hops bill per token; routing keeps using the last hop that served"
    );
    expect(
      decision.notice.some(
        (line) => line.includes(ENABLE_ENV_VAR) && line.includes("set by claudish")
      )
    ).toBe(true);
  });

  it("reports an inherited advisor-enable variable", () => {
    const parentEnv = { [ENABLE_ENV_VAR]: "true" };
    const toolEnv = resolveAdvisorToolEnv(config({ advisor: true }), parentEnv);
    const decision = expectProceed(
      decideAdvisorStartup(facts({ toolEnv, childEnv: { ...parentEnv, ...toolEnv.vars } }))
    );

    expect(
      decision.notice.some(
        (line) =>
          line.includes(ENABLE_ENV_VAR) && line.includes("true") && line.includes("inherited")
      )
    ).toBe(true);
  });

  it("mentions the main model only when it is also a panel member", () => {
    const matching = expectProceed(
      decideAdvisorStartup(
        facts({
          mainModels: [{ model: "openai/gpt-5.6-sol", providerName: "openai", carriesTools: true }],
        })
      )
    );
    const different = expectProceed(
      decideAdvisorStartup(
        facts({
          mainModels: [
            { model: "anthropic/claude-sonnet-4-5", providerName: "anthropic", carriesTools: true },
          ],
        })
      )
    );

    expect(
      matching.notice.some((line) => line.toLowerCase().includes("panel includes the main model"))
    ).toBe(true);
    expect(
      different.notice.some((line) => line.toLowerCase().includes("panel includes the main model"))
    ).toBe(false);
  });
});

describe("evaluateAdvisorStartup", () => {
  function handlerSet(): HandlerSet {
    const unexpected = () => {
      throw new Error("Injected chain builder must not call a provider getter");
    };
    return {
      openRouter: unexpected,
      poe: unexpected,
      local: unexpected,
      remote: unexpected,
      openRouterHandlers: new Map(),
      localProviderHandlers: new Map(),
      remoteProviderHandlers: new Map(),
      poeHandlers: new Map(),
    };
  }

  it("returns null without --advisor and performs no planning, credential lookup or construction", async () => {
    const plan = mock(async () => routedPlan());
    const anthropicKeyPresent = mock(async () => false);
    const createHandlerSet = mock(handlerSet);
    const buildChains = mock(async () => new Map<string, AdvisorChainBuild>());
    const toolEnv = resolveAdvisorToolEnv(config({ advisor: false }), {});

    const decision = await evaluateAdvisorStartup(
      config({ advisor: false }),
      toolEnv,
      {},
      {
        childAuth: { controlled: true },
        plan,
        anthropicKeyPresent,
        createHandlerSet,
        buildChains,
      }
    );

    expect(decision).toBeNull();
    expect(plan).not.toHaveBeenCalled();
    expect(anthropicKeyPresent).not.toHaveBeenCalled();
    expect(createHandlerSet).not.toHaveBeenCalled();
    expect(buildChains).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "plans members sequentially and shuts built chains down only on refusal (%p)",
    async (refusePanel) => {
      const panel = ["gpt-6.1-sol", "google@gemini-3.8-flash"];
      const collector = "claude-opus-5-5";
      const events: string[] = [];
      let planning = false;
      const plans = panel.map((spec) => routedPlan(spec));
      const chains = new Map(
        plans.map((plan) => {
          const chain = builtChain(plan);
          if (refusePanel && plan.spec === panel[1]) {
            chain.firstCallableHop = null;
            chain.handler = null;
            chain.builds = [{ kind: "not-built" }];
          }
          return [chain.key, chain];
        })
      );
      const set = handlerSet();
      const createHandlerSet = mock(() => set);
      const buildChains = mock(async (routed: readonly RoutedPlan[], receivedSet: HandlerSet) => {
        expect(planning).toBe(false);
        expect(routed).toEqual(plans);
        expect(receivedSet).toBe(set);
        events.push("build");
        return chains;
      });
      const shutdownChains = mock(async (builds: Iterable<AdvisorChainBuild>) => {
        expect([...builds]).toEqual([...chains.values()]);
      });
      const launch = config({ advisor: true, advisorModels: panel, advisorCollector: collector });
      const toolEnv = resolveAdvisorToolEnv(launch, {});
      const decision = await evaluateAdvisorStartup(launch, toolEnv, toolEnv.vars, {
        childAuth: { controlled: true },
        anthropicKeyPresent: async () => false,
        async plan(spec, role, deps) {
          expect(planning).toBe(false);
          expect(deps.childAuth).toEqual({ controlled: true });
          planning = true;
          events.push(`start:${role}:${spec}`);
          await Promise.resolve();
          events.push(`end:${role}:${spec}`);
          planning = false;
          return role === "panel"
            ? plans[panel.indexOf(spec)]
            : { kind: "claude-native", spec, role, model: spec, expectedArm: "claude-login" };
        },
        createHandlerSet,
        buildChains,
        shutdownChains,
      });

      expect(events).toEqual([
        `start:panel:${panel[0]}`,
        `end:panel:${panel[0]}`,
        `start:panel:${panel[1]}`,
        `end:panel:${panel[1]}`,
        `start:collector:${collector}`,
        `end:collector:${collector}`,
        "build",
      ]);
      expect(createHandlerSet).toHaveBeenCalledTimes(1);
      expect(buildChains).toHaveBeenCalledTimes(1);
      expect(decision?.kind).toBe(refusePanel ? "refuse" : "proceed");
      expect(shutdownChains).toHaveBeenCalledTimes(refusePanel ? 1 : 0);
    }
  );

  it("does not construct chains for a Claude-only panel", async () => {
    const launch = config({
      advisor: true,
      advisorModels: ["claude-opus-5-5"],
      advisorCollector: null,
    });
    const toolEnv = resolveAdvisorToolEnv(launch, {});
    const createHandlerSet = mock(handlerSet);
    const buildChains = mock(async () => new Map<string, AdvisorChainBuild>());
    const decision = await evaluateAdvisorStartup(launch, toolEnv, toolEnv.vars, {
      childAuth: { controlled: true },
      anthropicKeyPresent: async () => false,
      plan: async (spec, role) => ({
        kind: "claude-native",
        spec,
        role,
        model: spec,
        expectedArm: "claude-login",
      }),
      createHandlerSet,
      buildChains,
    });

    expect(decision?.kind).toBe("proceed");
    expect(buildChains).not.toHaveBeenCalled();
  });
});
