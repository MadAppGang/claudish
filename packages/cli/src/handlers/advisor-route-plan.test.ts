import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type AdvisorLaunchFacts,
  decideAdvisorStartup,
  evaluateAdvisorStartup,
} from "../advisor-startup.js";
import type { ExplainedCandidate, RouteExplanation } from "../providers/routing-rules.js";
import { RefusingHandler } from "../providers/wire-handler.js";
import type { ClaudishConfig } from "../types.js";
import { createAdvisorPanelGateway } from "./advisor-panel-gateway.js";
import {
  type AdvisorModelPlan,
  type PlanAdvisorDeps,
  advisorChainKey,
  buildAdvisorChains,
  describeAdvisorPlan,
  describeAdvisorRefusal,
  planAdvisorModel,
} from "./advisor-route-plan.js";
import { ComposedHandler } from "./composed-handler.js";
import type { HandlerSet } from "./handler-set.js";
import type { ModelHandler } from "./types.js";

const timeout = 10_000;
type RoutedPlan = Extract<AdvisorModelPlan, { kind: "routed" }>;

function candidate(provider: string, displayName: string, modelSpec: string): ExplainedCandidate {
  return {
    provider,
    displayName,
    modelSpec,
    wireId: modelSpec.slice(modelSpec.indexOf("@") + 1),
    position: "candidate",
    outcome: "kept",
  };
}

function explanation(
  spec: string,
  candidates: ExplainedCandidate[],
  outcome: RouteExplanation["outcome"] = { kind: "ok" }
): RouteExplanation {
  return {
    requestedModel: spec,
    routedModel: spec.includes("@") ? spec.slice(spec.indexOf("@") + 1) : spec,
    source: spec.includes("@") ? "explicit" : "catalog",
    candidates,
    outcome,
    warnings: [],
  };
}

function planningDeps(explain: PlanAdvisorDeps["explain"]): PlanAdvisorDeps {
  return {
    childAuth: { controlled: true },
    anthropicKeyPresent: async () => false,
    ensureCatalog: async () => {},
    explain,
    isSubscription: (provider) => provider === "openai-codex",
  };
}

function handlerSet(remote: HandlerSet["remote"]): HandlerSet {
  return {
    remote,
    openRouter: () => {
      throw new Error("unexpected OpenRouter getter");
    },
    poe: async () => null,
    local: () => null,
    openRouterHandlers: new Map(),
    remoteProviderHandlers: new Map(),
    localProviderHandlers: new Map(),
    poeHandlers: new Map(),
  };
}

// A getter double with the public ComposedHandler identity, without constructing
// a transport, token tracker or credential authority. Only public methods are supplied.
function composedDouble(name: string): ModelHandler {
  return Object.assign(Object.create(ComposedHandler.prototype), {
    getProviderName: () => name,
    handle: async () => {
      throw new Error("this classification test must not run a transport");
    },
    shutdown: async () => {},
  });
}

function facts(
  plans: AdvisorModelPlan[],
  builds: AdvisorLaunchFacts["builds"]
): AdvisorLaunchFacts {
  return {
    panel: plans.map((plan) => plan.spec),
    collector: null,
    collectorDefaulted: false,
    mainModels: [],
    childEnv: {},
    toolEnv: { vars: {}, source: "inherited" },
    panelPlans: plans,
    collectorPlan: null,
    builds,
    childAuth: { controlled: true },
  };
}

const launchConfig: ClaudishConfig = {
  advisor: true,
  advisorModels: ["gpt-test"],
  advisorCollector: null,
  autoApprove: false,
  dangerous: false,
  interactive: false,
  debug: false,
  logLevel: "minimal",
  quiet: true,
  jsonOutput: false,
  monitor: false,
  stdin: false,
  claudeArgs: [],
  noLogs: true,
  diagMode: "off",
};

describe("G1 — one startup and runtime advisor plan", () => {
  test(
    "notice and runtime retain the exact plan and startup-built chain",
    async () => {
      const seen: string[] = [];
      let planned: AdvisorModelPlan | undefined;
      const deps = planningDeps(async (spec) => {
        seen.push(spec);
        return explanation(spec, [candidate("openai-codex", "OpenAI Codex", "cx@gpt-test")]);
      });
      const decision = await evaluateAdvisorStartup(
        launchConfig,
        { vars: {}, source: "inherited" },
        {},
        {
          childAuth: { controlled: true },
          anthropicKeyPresent: async () => false,
          plan: async (spec, role) => {
            planned = await planAdvisorModel(spec, role, deps);
            return planned;
          },
          createHandlerSet: () => handlerSet(async () => composedDouble("openai-codex")),
        }
      );
      expect(decision?.kind).toBe("proceed");
      if (decision?.kind !== "proceed" || !planned) throw new Error("startup did not proceed");
      const key = advisorChainKey("panel", planned.spec);
      const build = decision.runtime.chains.get(key);
      expect(decision.runtime.plans.get(key)).toBe(planned);
      expect(decision.notice.join("\n")).toContain(describeAdvisorPlan(planned, build));
      expect(decision.notice.join("\n")).toContain("gpt-test -> OpenAI Codex (subscription)");
      expect(decision.notice.join("\n")).not.toContain("panel calls never use a subscription");
      const gateway = createAdvisorPanelGateway(decision.runtime);
      expect(gateway.plan(planned.spec, "panel")).toBe(planned);
      expect(seen).toEqual(["gpt-test"]);
      expect(build?.firstCallableHop).toBe(0);
    },
    timeout
  );

  test(
    "startup refuses an unservable member with the plan's verbatim reason and hint",
    async () => {
      let planned: AdvisorModelPlan | undefined;
      let explains = 0;
      const deps = planningDeps(async (spec) => {
        explains++;
        return explanation(spec, [], {
          kind: "no-route",
          cause: "no-credential",
          reason: "No credential can serve gpt-test.",
          hint: "Configure a credential for the requested model.",
        });
      });
      const decision = await evaluateAdvisorStartup(
        launchConfig,
        { vars: {}, source: "inherited" },
        {},
        {
          childAuth: { controlled: true },
          anthropicKeyPresent: async () => false,
          plan: async (spec, role) => {
            planned = await planAdvisorModel(spec, role, deps);
            return planned;
          },
          createHandlerSet: () => handlerSet(async () => null),
        }
      );
      expect(planned?.kind).toBe("refused");
      expect(decision?.kind).toBe("refuse");
      if (planned?.kind !== "refused" || decision?.kind !== "refuse") {
        throw new Error("missing startup refusal");
      }
      const refusal =
        "gpt-test: No credential can serve gpt-test. Configure a credential for the requested model.";
      expect(describeAdvisorRefusal(planned)).toBe(refusal);
      expect(decision.reason).toContain(`advisor panel model cannot be called: ${refusal}`);
      const gateway = createAdvisorPanelGateway({
        plans: new Map([[advisorChainKey("panel", planned.spec), planned]]),
        chains: new Map(),
        childAuth: { controlled: true },
      });
      expect(gateway.plan(planned.spec, "panel")).toBe(planned);
      expect(describeAdvisorRefusal(gateway.plan(planned.spec, "panel") as typeof planned)).toBe(
        refusal
      );
      expect(explains).toBe(1);
    },
    timeout
  );

  test(
    "a refused built chain is a startup refusal using the same build text",
    async () => {
      const plan = await planAdvisorModel(
        "openai@gpt-test",
        "panel",
        planningDeps(async (spec) => explanation(spec, [candidate("openai", "OpenAI", spec)]))
      );
      if (plan.kind !== "routed") throw new Error("expected routed plan");
      const message = "OpenAI speaks an unsupported protocol for this connection";
      const builds = await buildAdvisorChains(
        [plan],
        handlerSet(async () => new RefusingHandler(message))
      );
      const build = builds.get(advisorChainKey("panel", plan.spec));
      if (!build) throw new Error("missing build");
      const decision = decideAdvisorStartup(facts([plan], builds));
      expect(decision.kind).toBe("refuse");
      if (decision.kind !== "refuse") throw new Error("refusing handler was accepted");
      expect(build.firstCallableHop).toBeNull();
      expect(decision.reason).toContain(describeAdvisorRefusal({ plan, build }));
      expect(decision.reason).toContain(message);
    },
    timeout
  );
});

describe("G2 — chain construction outcomes", () => {
  async function routed(hops: ExplainedCandidate[], explicit = false): Promise<RoutedPlan> {
    const spec = explicit ? hops[0].modelSpec : "gpt-test";
    const plan = await planAdvisorModel(
      spec,
      "panel",
      planningDeps(async () => explanation(spec, hops))
    );
    if (plan.kind !== "routed") throw new Error("expected routed plan");
    return plan;
  }

  test(
    "ComposedHandler is built with its transport-to-planned-uid mapping",
    async () => {
      const plan = await routed([candidate("google", "Google planned name", "google@gemini-test")]);
      const handler = composedDouble("gemini");
      const builds = await buildAdvisorChains(
        [plan],
        handlerSet(async () => handler)
      );
      const build = builds.get(advisorChainKey("panel", plan.spec));
      expect(build?.builds).toEqual([{ kind: "built", handler, transportName: "gemini" }]);
      expect(build?.firstCallableHop).toBe(0);
      expect(build?.uidByTransportName.get("gemini")).toBe("google");
      expect(describeAdvisorPlan(plan, build)).toContain(
        "Google planned name (metered, billed per token)"
      );
    },
    timeout
  );

  test(
    "RefusingHandler is refused and stops a chain before a later callable hop",
    async () => {
      const plan = await routed([
        candidate("openai", "OpenAI", "openai@gpt-test"),
        candidate("google", "Google", "google@gemini-test"),
      ]);
      const refusal = new RefusingHandler("This connection speaks an unsupported protocol");
      const builds = await buildAdvisorChains(
        [plan],
        handlerSet(async (spec) =>
          spec.startsWith("openai@") ? refusal : composedDouble("gemini")
        )
      );
      const build = builds.get(advisorChainKey("panel", plan.spec));
      expect(build?.builds[0]).toMatchObject({
        kind: "refused",
        message: "This connection speaks an unsupported protocol",
        chainContinues: false,
      });
      expect(build?.builds[1].kind).toBe("built");
      expect(build?.firstCallableHop).toBeNull();
      expect(decideAdvisorStartup(facts([plan], builds)).kind).toBe("refuse");
    },
    timeout
  );

  test(
    "a null getter is not-built and a throwing getter is a failed hop",
    async () => {
      const plan = await routed([
        candidate("openai", "OpenAI", "openai@gpt-test"),
        candidate("google", "Google", "google@gemini-test"),
      ]);
      const builds = await buildAdvisorChains(
        [plan],
        handlerSet(async (spec) => {
          if (spec.startsWith("openai@")) return null;
          throw new Error("construction unavailable");
        })
      );
      const build = builds.get(advisorChainKey("panel", plan.spec));
      expect(build?.builds).toEqual([
        { kind: "not-built" },
        { kind: "failed", message: "construction unavailable" },
      ]);
      expect(build?.handler).toBeNull();
      expect(build?.firstCallableHop).toBeNull();
      if (!build) throw new Error("missing build");
      expect(describeAdvisorRefusal({ plan, build })).toBe(
        "gpt-test: no hop could be built — OpenAI: could not be built; Google: could not be built: construction unavailable"
      );
    },
    timeout
  );

  test(
    "a failed lower-priority getter does not discard the first callable hop",
    async () => {
      const plan = await routed([
        candidate("openai-codex", "OpenAI Codex", "cx@gpt-test"),
        candidate("openai", "OpenAI", "openai@gpt-test"),
      ]);
      const builds = await buildAdvisorChains(
        [plan],
        handlerSet(async (spec) => {
          if (spec.startsWith("cx@")) return composedDouble("openai-codex");
          throw new Error("lower-priority construction unavailable");
        })
      );
      const build = builds.get(advisorChainKey("panel", plan.spec));
      expect(build?.builds.map((entry) => entry.kind)).toEqual(["built", "failed"]);
      expect(build?.firstCallableHop).toBe(0);
      expect(decideAdvisorStartup(facts([plan], builds)).kind).toBe("proceed");
    },
    timeout
  );

  test(
    "an unknown handler stays built-pending without reading its provider property",
    async () => {
      const plan = await routed([candidate("google", "Google", "google@gemini-test")]);
      let reads = 0;
      const handler: ModelHandler = {
        handle: async () => {
          throw new Error("must not execute during construction");
        },
        shutdown: async () => {},
      };
      Object.defineProperty(handler, "provider", {
        get() {
          reads++;
          throw new Error("unknown handlers have no public provider");
        },
      });
      const builds = await buildAdvisorChains(
        [plan],
        handlerSet(async () => handler)
      );
      const build = builds.get(advisorChainKey("panel", plan.spec));
      expect(reads).toBe(0);
      expect(build?.builds[0]).toMatchObject({ kind: "built-pending", handlerKind: "other" });
      expect(build?.firstCallableHop).toBe(0);
    },
    timeout
  );
});

// Catalog/alias readers are exercised in a subprocess: Bun's homedir() does not
// follow an in-process HOME change. The catalog input is structural, derived from
// the real model id in advisor/inbound-login.jsonl, never a pinned production id.
async function selectorPlans(selectors: string[]) {
  const home = mkdtempSync(join(tmpdir(), "claudish-t3-selectors-"));
  const moduleUrl = pathToFileURL(join(import.meta.dir, "advisor-route-plan.ts")).href;
  const startupUrl = pathToFileURL(join(import.meta.dir, "../advisor-startup.ts")).href;
  const catalogUrl = pathToFileURL(join(import.meta.dir, "../providers/catalog-client.ts")).href;
  const aliasesUrl = pathToFileURL(
    join(import.meta.dir, "../providers/claude-code-aliases.ts")
  ).href;
  const captures = readFileSync(
    join(import.meta.dir, "../test-fixtures/advisor/inbound-login.jsonl"),
    "utf8"
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const model = captures.find((capture) => capture.path === "/v1/messages").body.model as string;
  const script = `
    const { planAdvisorModel, describeAdvisorRefusal } = await import(${JSON.stringify(moduleUrl)});
    const { decideAdvisorStartup } = await import(${JSON.stringify(startupUrl)});
    const { _setCatalogEntriesForTest } = await import(${JSON.stringify(catalogUrl)});
    const { CLAUDE_CODE_MODEL_ALIASES } = await import(${JSON.stringify(aliasesUrl)});
    _setCatalogEntriesForTest([{ modelId: ${JSON.stringify(model)}, aliases: ["opus"], provider: "anthropic" }]);
    const selectors = ${JSON.stringify(selectors)};
    const rows = [];
    for (const spec of selectors) {
      const plan = await planAdvisorModel(spec, "panel", {
        childAuth: { controlled: true }, anthropicKeyPresent: async () => { throw new Error("native login must not resolve a key"); },
        ensureCatalog: async () => { throw new Error("native selectors must bypass routed catalog waits"); },
        explain: async () => { throw new Error("native selectors must not enter route()"); }
      });
      const decision = decideAdvisorStartup({
        panel: [spec], collector: null, collectorDefaulted: false, mainModels: [],
        childEnv: {}, toolEnv: {vars: {}, source: "inherited"}, panelPlans: [plan],
        collectorPlan: null, builds: new Map(), childAuth: {controlled: true}
      });
      rows.push({plan, decision, refusal: plan.kind === "refused" ? describeAdvisorRefusal(plan) : null});
    }
    console.log(JSON.stringify({ model: ${JSON.stringify(model)}, aliases: CLAUDE_CODE_MODEL_ALIASES, rows }));
  `;
  try {
    const child = Bun.spawn([process.execPath, "--eval", script], {
      env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude") },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    return JSON.parse(stdout) as {
      model: string;
      aliases: string[];
      rows: Array<{
        plan: AdvisorModelPlan;
        decision: { kind: string; reason?: string };
        refusal: string | null;
      }>;
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("G3 — Claude selectors are decided before routing", () => {
  test(
    "internal and default resolve to the captured opus tier and startup accepts them",
    async () => {
      const result = await selectorPlans(["internal", "default", "opus"]);
      for (const row of result.rows) {
        expect(row.plan).toMatchObject({
          kind: "claude-native",
          model: result.model,
          expectedArm: "claude-login",
        });
        expect(row.decision.kind).toBe("proceed");
        expect(row.plan.kind === "claude-native" && row.plan.model.startsWith("claude-opus-")).toBe(
          true
        );
      }
    },
    timeout
  );

  test(
    "opusplan, best and 1M forms are startup refusals with the plan's selector explanation",
    async () => {
      const selectors = ["opusplan", "best", "sonnet[1m]", "internal[1m]", "CLAUDE-OPUS-5[1M]"];
      const result = await selectorPlans(selectors);
      for (const [index, row] of result.rows.entries()) {
        expect(row.plan).toMatchObject({
          kind: "refused",
          spec: selectors[index],
          cause: "claude-selector",
        });
        expect(row.decision.kind).toBe("refuse");
        expect(row.decision.reason).toContain(row.refusal!);
      }
      expect(result.rows[0].refusal).toContain("switches tier with Claude Code's mode");
      expect(result.rows[1].refusal).toContain("claudish has no source for it");
      for (const row of result.rows.slice(2))
        expect(row.refusal).toContain("name the model without");
    },
    timeout
  );
});

describe("G5 — explicit advisor specs retain their provider", () => {
  test.each([
    ["cx@gpt-test", "openai-codex", "OpenAI Codex", "subscription"],
    ["openai@gpt-test", "openai", "OpenAI", "metered"],
    ["google@gemini-test", "google", "Google", "metered"],
  ] as const)(
    "%s uses the planned provider, not the OpenRouter getter",
    async (spec, provider, displayName, billing) => {
      const explained: string[] = [];
      const plan = await planAdvisorModel(
        spec,
        "panel",
        planningDeps(async (target) => {
          explained.push(target);
          return explanation(target, [candidate(provider, displayName, spec)]);
        })
      );
      expect(plan).toMatchObject({
        kind: "routed",
        invocationMode: "explicit-model",
        hops: [{ provider, billing, modelSpec: spec }],
      });
      if (plan.kind !== "routed") throw new Error("explicit spec was refused");
      const calls: string[] = [];
      await buildAdvisorChains(
        [plan],
        handlerSet(async (target, mode) => {
          calls.push(`${target}:${mode}`);
          return composedDouble(provider);
        })
      );
      expect(explained).toEqual([spec]);
      expect(calls).toEqual([`${spec}:explicit-model`]);
    },
    timeout
  );
});
