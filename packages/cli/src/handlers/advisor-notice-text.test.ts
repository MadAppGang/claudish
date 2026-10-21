import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdvisorLaunchFacts } from "../advisor-startup.js";
import type { ClaudishConfig } from "../types.js";
import type { AdvisorChainBuild, AdvisorHop, AdvisorModelPlan } from "./advisor-route-plan.js";

if (process.env.CLAUDISH_T5_NOTICE_WORKER !== "1") {
  test("T5 G5 startup notice tests run with an isolated HOME and no network", () => {
    const home = mkdtempSync(join(tmpdir(), "claudish-t5-notice-"));
    try {
      const child = Bun.spawnSync([process.execPath, "test", import.meta.path], {
        env: {
          ...process.env,
          HOME: home,
          CLAUDISH_DISABLE_KEYCHAIN: "1",
          CLAUDISH_T5_NOTICE_WORKER: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 18_000,
      });
      console.log(child.stdout.toString() + child.stderr.toString());
      expect(child.exitCode).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);
} else {
  const realFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      // OpenTUI loads its bundled Yoga wasm from a data URL, not the network.
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith("data:")) return realFetch(input, init);
      throw new Error("T5 forbids all network requests");
    },
    { preconnect: () => {} }
  ) as unknown as typeof fetch;
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  const { decideAdvisorStartup } = await import("../advisor-startup.js");
  const { resolveAdvisorToolEnv } = await import("../claude-runner.js");
  const { advisorChainKey, describeAdvisorPlan } = await import("./advisor-route-plan.js");
  type RoutedPlan = Extract<AdvisorModelPlan, { kind: "routed" }>;
  type RefusedPlan = Extract<AdvisorModelPlan, { kind: "refused" }>;

  const config: ClaudishConfig = {
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
    noLogs: true,
    diagMode: "auto",
    advisor: true,
  };
  // Structural routing plans: grok-4.7 and its subscription service are the
  // observed inputs in model-failures-2026-10-21.md D1 and D7. No discovery runs.
  function plan(hops: AdvisorHop[]): RoutedPlan {
    return {
      kind: "routed",
      spec: "grok-4.7",
      role: "panel",
      explanation: {
        requestedModel: "grok-4.7",
        routedModel: "grok-4.7",
        source: "catalog",
        candidates: [],
        warnings: [],
        outcome: { kind: "ok" },
      },
      hops,
      invocationMode: "auto-route",
    };
  }
  const subscription: AdvisorHop = {
    provider: "grok-subscription",
    displayName: "Grok Build (subscription)",
    modelSpec: "gk@grok-4.7",
    wireId: "grok-4.7",
    billing: "subscription",
    tier: "dynamic-subscription",
  };
  const metered: AdvisorHop = {
    provider: "openrouter",
    displayName: "OpenRouter",
    modelSpec: "or@x-ai/grok-4.7",
    wireId: "x-ai/grok-4.7",
    billing: "metered",
    tier: "gateway",
  };
  function builtChain(routed: RoutedPlan): AdvisorChainBuild {
    const handler = {
      async handle(): Promise<Response> {
        throw new Error("Startup notice generation must not invoke an upstream handler");
      },
      async shutdown() {},
    };
    return {
      key: advisorChainKey(routed.role, routed.spec),
      builds: routed.hops.map((hop) => ({ kind: "built", handler, transportName: hop.provider })),
      handler,
      firstCallableHop: 0,
      uidByTransportName: new Map(routed.hops.map((hop) => [hop.provider, hop.provider])),
    };
  }
  function facts(
    panelPlan: AdvisorModelPlan,
    collectorPlan: AdvisorModelPlan | null = null,
    collectorDefaulted = false
  ): AdvisorLaunchFacts {
    const toolEnv = resolveAdvisorToolEnv(config, {});
    const routed = [panelPlan, ...(collectorPlan ? [collectorPlan] : [])].filter(
      (member): member is RoutedPlan => member.kind === "routed"
    );
    return {
      panel: [panelPlan.spec],
      collector: collectorPlan?.spec ?? null,
      collectorDefaulted,
      mainModels: [],
      childEnv: { ...toolEnv.vars },
      toolEnv,
      panelPlans: [panelPlan],
      collectorPlan,
      builds: new Map(
        routed.map((member) => {
          const build = builtChain(member);
          return [build.key, build];
        })
      ),
      childAuth: { controlled: true },
    };
  }
  function refusal(role: "panel" | "collector", reason: string): RefusedPlan {
    return {
      kind: "refused",
      spec: "grok-4.7",
      role,
      cause: "no-callable-hop",
      reason,
    };
  }

  describe("T5 G5 advisor notice text", () => {
    test("the startup notice prints the subscription billing label once", () => {
      const decision = decideAdvisorStartup(facts(plan([subscription, metered])));
      expect(decision.kind).toBe("proceed");
      if (decision.kind !== "proceed") throw new Error(decision.reason);
      const line = decision.notice.find((entry) => entry.includes("grok-4.7 ->"));
      expect(line).toContain(
        "grok-4.7 -> Grok Build (subscription); then OpenRouter (metered, billed per token)"
      );
      expect(line?.match(/Grok Build \(subscription\)/g)).toHaveLength(1);
      expect(line).not.toContain("(subscription) (subscription)");
    }, 5_000);

    test("billing labels are not duplicated on later hops either", () => {
      const routed = plan([metered, subscription]);
      const text = describeAdvisorPlan(routed, builtChain(routed));
      expect(text).toContain(
        "OpenRouter (metered, billed per token); then Grok Build (subscription)"
      );
      expect(text).not.toContain("(subscription) (subscription)");
    }, 5_000);

    test("a mixed-chain startup notice says a rejected login moves on to the metered hop", () => {
      const decision = decideAdvisorStartup(facts(plan([subscription, metered])));
      expect(decision.kind).toBe("proceed");
      if (decision.kind !== "proceed") throw new Error(decision.reason);
      const text = decision.notice.join("\n");
      expect(text).toContain(
        "(if the subscription login is rejected, calls move on to the metered hop)"
      );
      expect(text).not.toContain("never routed onto a metered hop");
    }, 5_000);

    for (const trailingStop of [true, false]) {
      const reason = `Use a model id${trailingStop ? "." : ""}`;
      test(`a panel refusal ${trailingStop ? "with" : "without"} a trailing stop has one full stop before Remove`, () => {
        const decision = decideAdvisorStartup(facts(refusal("panel", reason)));
        expect(decision.kind).toBe("refuse");
        if (decision.kind !== "refuse") throw new Error("Expected panel refusal");
        expect(decision.reason).toContain("Use a model id. Remove the model from --advisor");
        expect(decision.reason).not.toContain("..");
      }, 5_000);

      test(`an explicit collector refusal ${trailingStop ? "with" : "without"} a trailing stop has one full stop before Name`, () => {
        const decision = decideAdvisorStartup(
          facts(plan([subscription]), refusal("collector", reason))
        );
        expect(decision.kind).toBe("refuse");
        if (decision.kind !== "refuse") throw new Error("Expected collector refusal");
        expect(decision.reason).toContain("Use a model id. Name another collector");
        expect(decision.reason).not.toContain("..");
      }, 5_000);
    }

    test("a dropped default collector does not leave a full stop before the semicolon", () => {
      const decision = decideAdvisorStartup(
        facts(plan([subscription]), refusal("collector", "Use a model id."), true)
      );
      expect(decision.kind).toBe("proceed");
      if (decision.kind !== "proceed") throw new Error(decision.reason);
      expect(decision.effectiveCollector).toBeNull();
      expect(decision.notice.join("\n")).toContain(
        "Use a model id; panel answers will be concatenated"
      );
      expect(decision.notice.join("\n")).not.toContain(".; panel answers");
    }, 5_000);
  });
}
