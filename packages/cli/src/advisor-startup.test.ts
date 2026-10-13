import { describe, expect, it } from "bun:test";
import {
  type AdvisorLaunchFacts,
  type AdvisorModelStatus,
  type AdvisorRoute,
  type AdvisorStartupDecision,
  advisorModelStatus,
  decideAdvisorStartup,
  evaluateAdvisorStartup,
  resolveMainModelFact,
} from "./advisor-startup.js";
import { resolveAdvisorToolEnv } from "./claude-runner.js";
import type { ClaudishConfig } from "./types.js";

const ENABLE_ENV_VAR = "CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL";
const DISABLE_ENV_VAR = "CLAUDE_CODE_DISABLE_ADVISOR_TOOL";

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

const openAiRoute: AdvisorRoute = {
  kind: "openai",
  api: "chat-completions",
  host: "api.openai.com",
  url: "https://api.openai.com/v1/chat/completions",
  credential: "openai",
  wireModel: "gpt-5.6-sol",
};

const googleRoute: AdvisorRoute = {
  kind: "google",
  api: "chat-completions",
  host: "generativelanguage.googleapis.com",
  url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  credential: "google",
  wireModel: "gemini-2.5-pro",
};

const anthropicRoute: AdvisorRoute = {
  kind: "anthropic",
  api: "anthropic-messages",
  host: "api.anthropic.com",
  url: "https://api.anthropic.com/v1/messages",
  credential: "anthropic",
  wireModel: "haiku",
};

function modelStatus(
  model: string,
  route: AdvisorRoute,
  callable = true,
  credentialName = "OPENAI_API_KEY"
): AdvisorModelStatus {
  return { model, route, callable, credentialName };
}

function facts(overrides: Partial<AdvisorLaunchFacts> = {}): AdvisorLaunchFacts {
  const toolEnv = resolveAdvisorToolEnv(config({ advisor: true }), {});
  return {
    panel: ["openai/gpt-5.6-sol"],
    collector: null,
    collectorDefaulted: false,
    mainModels: [],
    childEnv: { ...toolEnv.vars },
    toolEnv,
    panelStatus: [modelStatus("openai/gpt-5.6-sol", openAiRoute)],
    collectorStatus: null,
    ...overrides,
  };
}

function expectProceed(decision: AdvisorStartupDecision) {
  expect(decision.kind).toBe("proceed");
  if (decision.kind !== "proceed") throw new Error(decision.reason);
  return decision;
}

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

  it("refuses when a panel model credential is missing and names both", () => {
    const model = "openai/gpt-5.6-sol";
    const credentialName = "OPENAI_API_KEY";
    const decision = decideAdvisorStartup(
      facts({ panelStatus: [modelStatus(model, openAiRoute, false, credentialName)] })
    );

    expect(decision.kind).toBe("refuse");
    if (decision.kind === "refuse") {
      expect(decision.reason).toContain(model);
      expect(decision.reason).toContain(credentialName);
    }
  });

  it("proceeds when all panel models have credentials and there is no collector", () => {
    const decision = expectProceed(decideAdvisorStartup(facts()));

    expect(decision.effectiveCollector).toBeNull();
  });

  it("refuses when a user-named collector credential is missing and names it", () => {
    const collector = "anthropic/claude-haiku-4-5";
    const decision = decideAdvisorStartup(
      facts({
        collector,
        collectorDefaulted: false,
        collectorStatus: modelStatus(collector, anthropicRoute, false, "ANTHROPIC_API_KEY"),
      })
    );

    expect(decision.kind).toBe("refuse");
    if (decision.kind === "refuse") {
      expect(decision.reason).toContain(collector);
      expect(decision.reason).toContain("ANTHROPIC_API_KEY");
    }
  });

  it("drops an unavailable default collector and explains concatenation", () => {
    const decision = expectProceed(
      decideAdvisorStartup(
        facts({
          collector: "haiku",
          collectorDefaulted: true,
          collectorStatus: modelStatus("haiku", anthropicRoute, false, "ANTHROPIC_API_KEY"),
        })
      )
    );

    expect(decision.effectiveCollector).toBeNull();
    expect(decision.notice.some((line) => line.includes("haiku"))).toBe(true);
    expect(decision.notice.some((line) => line.includes("concatenated"))).toBe(true);
  });

  describe("unresolved collector aliases", () => {
    const unresolvedRoute: AdvisorRoute = {
      ...anthropicRoute,
      unresolvedAlias: "haiku",
    };

    it("keeps an unresolved alias uncallable even when its credential is present", () => {
      const status = advisorModelStatus("haiku", unresolvedRoute, { anthropic: true });

      expect(status.callable).toBe(false);
      expect(status.unresolved).toBeTruthy();
      expect(status.unresolved).toContain("haiku");
    });

    it("refuses an unresolved collector named by the user", () => {
      const collector = "haiku";
      const panelStatus = [modelStatus("openai/gpt-5.6-sol", openAiRoute)];
      expect(panelStatus.every((status) => status.callable)).toBe(true);

      const decision = decideAdvisorStartup(
        facts({
          collector,
          collectorDefaulted: false,
          panelStatus,
          collectorStatus: advisorModelStatus(collector, unresolvedRoute, { anthropic: true }),
        })
      );

      expect(decision.kind).toBe("refuse");
      if (decision.kind === "refuse") expect(decision.reason).toContain(collector);
    });

    it("drops an unresolved default collector and explains concatenation", () => {
      const collector = "haiku";
      const decision = expectProceed(
        decideAdvisorStartup(
          facts({
            collector,
            collectorDefaulted: true,
            collectorStatus: advisorModelStatus(collector, unresolvedRoute, { anthropic: true }),
          })
        )
      );

      expect(decision.effectiveCollector).toBeNull();
      expect(decision.notice.some((line) => line.includes(collector))).toBe(true);
      expect(decision.notice.some((line) => line.includes("concatenat"))).toBe(true);
    });

    it.each([true, false])(
      "keeps a resolved collector when collectorDefaulted is %p",
      (collectorDefaulted) => {
        const collector = "anthropic/claude-haiku-4-5";
        const resolvedRoute: AdvisorRoute = {
          ...anthropicRoute,
          wireModel: "claude-haiku-4-5",
        };
        const decision = expectProceed(
          decideAdvisorStartup(
            facts({
              collector,
              collectorDefaulted,
              collectorStatus: advisorModelStatus(collector, resolvedRoute, { anthropic: true }),
            })
          )
        );

        expect(decision.effectiveCollector).toBe(collector);
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

  it("reports panel routing, billing, subscription isolation, cost, and a claudish-set enable variable", () => {
    const decision = expectProceed(
      decideAdvisorStartup(
        facts({
          panel: ["openai/gpt-5.6-sol", "google/gemini-2.5-pro"],
          panelStatus: [
            modelStatus("openai/gpt-5.6-sol", openAiRoute),
            modelStatus("google/gemini-2.5-pro", googleRoute, true, "GEMINI_API_KEY"),
          ],
        })
      )
    );

    expect(
      decision.notice.some(
        (line) =>
          line.includes("openai/gpt-5.6-sol") &&
          line.includes("api.openai.com") &&
          line.includes("billed per token")
      )
    ).toBe(true);
    expect(
      decision.notice.some(
        (line) =>
          line.includes("google/gemini-2.5-pro") &&
          line.includes("generativelanguage.googleapis.com") &&
          line.includes("billed per token")
      )
    ).toBe(true);
    expect(decision.notice.some((line) => line.includes("never use a subscription"))).toBe(true);
    expect(
      decision.notice.some(
        (line) => line.toLowerCase().includes("cost") && line.includes("FULL conversation")
      )
    ).toBe(true);
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
  it("returns null without --advisor and does not resolve credentials", async () => {
    let credentialLookups = 0;
    const toolEnv = resolveAdvisorToolEnv(config({ advisor: false }), {});

    const decision = await evaluateAdvisorStartup(
      config({ advisor: false }),
      toolEnv,
      {},
      {
        resolveCredentials: async () => {
          credentialLookups += 1;
          return {};
        },
      }
    );

    expect(decision).toBeNull();
    expect(credentialLookups).toBe(0);
  });
});
