import { describe, expect, test } from "bun:test";
import type {
  AdvisorPanelCall,
  AdvisorPanelGateway,
  AdvisorPanelResult,
} from "./advisor-route-plan";
import { ADVISOR_STUB_PATHS, runAdvisorCall } from "./native-handler-advisor";

const messages = [{ role: "user", content: "Review this change." }];

function gateway(
  reply: (request: AdvisorPanelCall) => Pick<AdvisorPanelResult, "status" | "bodyText" | "hops">
): AdvisorPanelGateway {
  return {
    plan(spec, role) {
      return {
        kind: "routed",
        spec,
        role,
        explanation: {
          requestedModel: spec,
          routedModel: spec.slice(spec.indexOf("@") + 1),
          source: "explicit",
          candidates: [],
          warnings: [],
          outcome: { kind: "ok" },
        },
        hops: [
          {
            provider: "openrouter",
            displayName: "OpenRouter",
            modelSpec: spec,
            wireId: spec.slice(spec.indexOf("@") + 1),
            billing: "metered",
          },
        ],
        invocationMode: "explicit-model",
      };
    },
    async call(request) {
      return { streamFailure: false, latencyMs: 1, ...reply(request) };
    },
  };
}

function errorGateway(message: string): AdvisorPanelGateway {
  return gateway(() => ({
    status: 400,
    bodyText: JSON.stringify({ error: { message } }),
    hops: [],
  }));
}

describe("runAdvisorCall failure handling", () => {
  test("turns an HTTP 400 panel response into a named stub failure", async () => {
    const model = "openrouter@acme/failing-model";
    const reason = "the requested model is unavailable";

    const outcome = await runAdvisorCall({
      toolUseId: "advisor-http-400",
      messages,
      models: [model],
      collector: null,
      gateway: errorGateway(reason),
      warn: () => {},
    });

    expect(outcome.panel[0].origin).not.toBe("upstream");
    const stubPath = outcome.panel[0].stubPath;
    expect(stubPath).not.toBeNull();
    if (stubPath === null) throw new Error("Expected a named advisor stub path");
    expect(Object.values(ADVISOR_STUB_PATHS)).toContain(stubPath);
    expect(outcome.panel[0].stubPath).toBe(ADVISOR_STUB_PATHS.PANEL_ERROR);
    expect(outcome.result.isError).toBe(true);
    expect(outcome.result.text).toContain(model);
    expect(outcome.result.text).toContain(`HTTP 400: ${reason}`);
  });

  test("treats an HTTP 200 response with an empty answer as a failure", async () => {
    const model = "openrouter@acme/empty-model";

    const outcome = await runAdvisorCall({
      toolUseId: "advisor-empty-200",
      messages,
      models: [model],
      collector: null,
      gateway: gateway(() => ({
        status: 200,
        bodyText: JSON.stringify({ content: [{ type: "text", text: "   " }] }),
        hops: [],
      })),
      warn: () => {},
    });

    expect(outcome.panel[0].origin).not.toBe("upstream");
    expect(outcome.panel[0].stubPath).toBe(ADVISOR_STUB_PATHS.PANEL_EMPTY);
    expect(outcome.panel[0].text).toBeUndefined();
    expect(outcome.result.isError).toBe(true);
    expect(outcome.result.text).toContain(model);
  });

  test("preserves successful advice and reports a failed peer without a collector", async () => {
    const failedModel = "openrouter@acme/failing-peer";
    const successfulModel = "openrouter@acme/successful-peer";
    const successfulText = "Keep the validation at the boundary.";
    const failureReason = "temporary provider rejection";
    const warnings: string[] = [];

    const outcome = await runAdvisorCall({
      toolUseId: "advisor-partial-panel",
      messages,
      models: [failedModel, successfulModel],
      collector: null,
      gateway: gateway((request) =>
        request.plan.spec === failedModel
          ? {
              status: 400,
              bodyText: JSON.stringify({ error: { message: failureReason } }),
              hops: [],
            }
          : {
              status: 200,
              bodyText: JSON.stringify({ content: [{ type: "text", text: successfulText }] }),
              hops: [
                {
                  provider: "openrouter",
                  wireModel: "acme/successful-peer",
                  arm: "api-key",
                  billing: "metered",
                  uid: "openrouter",
                  displayName: "OpenRouter",
                },
              ],
            }
      ),
      warn: (message) => warnings.push(message),
    });

    expect(outcome.result.isError).toBe(false);
    expect(outcome.result.text).toContain(successfulText);
    expect(outcome.result.text).toContain(failedModel);
    expect(outcome.result.text).toContain(failureReason);
    expect(outcome.panel.find((item) => item.requestedModel === failedModel)).toMatchObject({
      origin: "stub",
      stubPath: ADVISOR_STUB_PATHS.PANEL_ERROR,
    });
    expect(outcome.panel.find((item) => item.requestedModel === successfulModel)).toMatchObject({
      origin: "upstream",
      servedBy: {
        provider: "openrouter",
        displayName: "OpenRouter",
        arm: "api-key",
        billing: "metered",
      },
      billing: "metered",
      hopsTried: ["openrouter"],
      recordRoute: { kind: "routed", plannedChain: ["OpenRouter"] },
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(failedModel);
  });

  test("raises exactly one warning for a failed call and names every failed model", async () => {
    const models = ["openrouter@acme/failure-one", "openrouter@acme/failure-two"];
    const warnings: string[] = [];

    await runAdvisorCall({
      toolUseId: "advisor-warning-count",
      messages,
      models,
      collector: null,
      gateway: errorGateway("provider refused"),
      warn: (message) => warnings.push(message),
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(models[0]);
    expect(warnings[0]).toContain(models[1]);
  });

  test("redacts credential-shaped provider text while preserving the reason", async () => {
    const model = "openrouter@acme/credential-error";
    const rawSecret = `sk-${"x".repeat(20)}`;
    const reasonPrefix = "Incorrect API key";

    const outcome = await runAdvisorCall({
      toolUseId: "advisor-secret-redaction",
      messages,
      models: [model],
      collector: null,
      gateway: errorGateway(`${reasonPrefix}: ${rawSecret}; request denied`),
      warn: () => {},
    });

    expect(outcome.result.text).not.toContain(rawSecret);
    expect(outcome.result.text).toContain(reasonPrefix);
    expect(outcome.result.text).toContain("request denied");
  });
});
