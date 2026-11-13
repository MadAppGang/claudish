import { expect, test } from "bun:test";
import { Hono } from "hono";
import { isolatedFile, LOGIN, KEY, catalog, connection } from "./test-helpers/claude-behaviour.js";
await isolatedFile(import.meta, async () => {
  const { advisorKeyArmFor } = await import("./handlers/advisor-decorator.js");
  const { planAdvisorModel, describeAdvisorRefusal, describeClaudeAdvisorPlan, CLAUDE_SUBSCRIPTION_ADVISOR_NO_KEY } = await import("./handlers/advisor-route-plan.js");
  const { resolveClaudeAdvisorAuth, claudeRequestFacts } = await import("./handlers/native-handler-advisor.js");
  const { writeAllModelsCache, ALL_MODELS_CACHE_PATH } = await import("./providers/all-models-cache.js");
  type Arm = NonNullable<Parameters<typeof resolveClaudeAdvisorAuth>[2]>;
  type Facts = Parameters<typeof resolveClaudeAdvisorAuth>[0];
  const uncontrolled = { controlled: false as const, reason: "proxy-auth" as const, where: "environment" };
  const plan = async (spec: string, keyArm: Arm, controlled = false) => {
    // opus is a selector; advisor calls need a concrete id from test-owned catalog data.
    const modelId = "claude-opus-behaviour-test";
    const data = {
      ...catalog(),
      entries: [{
        modelId, aliases: ["opus"], provider: "anthropic", contextWindow: 200000,
        aggregators: [connection("anthropic", "direct-api", modelId)],
      }],
      models: [{ id: modelId }],
    };
    writeAllModelsCache(data as Parameters<typeof writeAllModelsCache>[0], ALL_MODELS_CACHE_PATH);
    return planAdvisorModel(spec, "panel", {
      childAuth: controlled ? { controlled: true } : uncontrolled,
      anthropicKeyPresent: async () => true, keyArm,
      ensureCatalog: async () => {}, warmCatalog: async () => {},
    });
  };

  test("B-78 derives advisor key arms from launch signing", () => {
    const key = () => KEY;
    const out = advisorKeyArmFor({ kind: "launch-key", key });
    expect(typeof out).toBe("object");
    if (typeof out !== "object") throw new Error("launch-key arm missing");
    expect(out.launchKey()).toBe(KEY);
    expect(advisorKeyArmFor({ kind: "login-only" })).toBe("off");
    const inbound = { kind: "inbound" as const, fallbackKey: async () => KEY };
    expect(advisorKeyArmFor(inbound)).toBe("lookup");
    expect(advisorKeyArmFor(inbound, { keyLookup: false })).toBe("request-key");
  });

  test("B-79 never falls from an explicit subscription advisor to a key", async () => {
    for (const arm of ["lookup", { launchKey: () => KEY }] as const) {
      expect(await plan("claude@opus", arm)).toMatchObject({ kind: "refused", cause: "claude-no-credential", reason: expect.stringContaining("anthropic@") });
    }
    expect(await plan("claude@opus", "lookup", true)).toMatchObject({ kind: "claude-native", expectedArm: "claude-login" });
    expect(await plan("opus", "lookup")).toMatchObject({ kind: "claude-native", expectedArm: "api-key" });
  });

  test("B-80 refuses malformed subscription advisors without repeating the spec", async () => {
    expect(await plan("claude@gpt-6", "lookup")).toMatchObject({ kind: "refused", cause: "claude-subscription-spec" });
    const spec = "claude@opus#fast", out = await plan(spec, "lookup");
    expect(out).toMatchObject({ kind: "refused", cause: "wire-marker" });
    if (out.kind !== "refused") throw new Error("marked subscription advisor accepted");
    const text = describeAdvisorRefusal(out);
    expect(text).toStartWith(spec);
    expect(text.split(spec)).toHaveLength(2);
  });

  test("B-81 allows only inbound keys on the request-key arm", async () => {
    expect(await plan("opus", "request-key")).toMatchObject({ kind: "refused", cause: "claude-no-credential" });
    const forbidden = async () => { throw new Error("request-key must never look up a stored key"); };
    expect(await resolveClaudeAdvisorAuth({ inboundApiKey: KEY }, forbidden, "request-key")).toMatchObject({ arm: "api-key", source: "inbound-x-api-key", apiKey: KEY });
    expect(await resolveClaudeAdvisorAuth({}, forbidden, "request-key")).toMatchObject({ arm: null });
  });

  test("B-82 describes the exact advisor key fallback boundary", async () => {
    for (const [arm, fallback, fragment] of [
      ["off", "none", undefined], ["request-key", "request-key", "never ANTHROPIC_API_KEY"],
      ["lookup", "lookup", "its x-api-key or ANTHROPIC_API_KEY"],
      [{ launchKey: () => KEY }, "launch-key", "the Claude API launch's key"],
    ] as const) {
      const out = await plan("opus", arm, true);
      expect(out).toMatchObject({ kind: "claude-native", keyFallback: fallback });
      if (out.kind !== "claude-native") throw new Error("controlled native advisor refused");
      const text = describeClaudeAdvisorPlan(out);
      if (fragment) expect(text).toContain(fragment);
      else { expect(text).not.toContain("ANTHROPIC_API_KEY"); expect(text).not.toContain("x-api-key"); }
    }
    for (const [fallback, fragment] of [["request-key", "never ANTHROPIC_API_KEY"], ["lookup", "else ANTHROPIC_API_KEY"]] as const) {
      const text = describeClaudeAdvisorPlan({
        kind: "claude-native", spec: "opus", model: "opus", role: "panel", expectedArm: "api-key",
        authSource: { reason: "proxy-auth", where: "environment" }, apiKeySource: "inbound-x-api-key", keyFallback: fallback,
      });
      expect(text).toContain(fragment);
    }
  });

  test("B-83 prefers login and otherwise obeys off and launch-key arms", async () => {
    const forbidden = async () => { throw new Error("arm must not read a stored key"); };
    expect(await resolveClaudeAdvisorAuth({}, forbidden, "off")).toMatchObject({ arm: null, reason: CLAUDE_SUBSCRIPTION_ADVISOR_NO_KEY });
    expect(await resolveClaudeAdvisorAuth({ inboundApiKey: "different-fake-key" }, forbidden, { launchKey: () => KEY })).toMatchObject({ arm: "api-key", source: "claude-api-launch-key", apiKey: KEY });
    let facts: Facts | undefined;
    const app = new Hono();
    app.post("/facts", c => {
      facts = claudeRequestFacts(c, {}, { childAuth: { controlled: true }, env: {} });
      return c.text("ok");
    });
    await app.request("/facts", { method: "POST", headers: { authorization: "Bearer " + LOGIN } });
    expect(facts?.login).toBeDefined();
    for (const arm of ["off", "request-key", "lookup", { launchKey: () => KEY }] as const)
      expect(await resolveClaudeAdvisorAuth(facts!, forbidden, arm)).toMatchObject({ arm: "oauth", source: "claude-code-login" });
  });
});
