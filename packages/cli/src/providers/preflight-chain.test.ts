import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// HOME must be set before imports: Bun caches homedir() at process startup.
if (process.env.CLAUDISH_W2_TEST_CHILD !== import.meta.path) {
  test("W2: isolated HOME child", () => {
    const home = mkdtempSync(join(tmpdir(), "claudish-w2-"));
    try {
      const child = Bun.spawnSync([process.execPath, "test", import.meta.path], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
          CLAUDISH_W2_TEST_CHILD: import.meta.path,
          CLAUDISH_DISABLE_KEYCHAIN: "1",
          CLAUDISH_DISABLE_OP: "1",
          CLAUDISH_DISABLE_CATALOG_WARM: "1",
        },
        timeout: 18_000,
      });
      const output =
        new TextDecoder().decode(child.stdout) + new TextDecoder().decode(child.stderr);
      console.info(output);
      expect(child.exitCode, output).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);
} else {
  const check = (name: string, run: () => unknown) =>
    test(name, async () => {
      await run();
    }, 10_000);

  const { preflightModel, renderPreflightReport, hopBilling } = await import(
    "./preflight-chain.js"
  );
  const { describeProbeState } = await import("./probe-live.js");
  const { setConfigFileOverride } = await import("../profile-config.js");
  setConfigFileOverride(join(process.env.HOME!, "config.json"));
  const blockedFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => {
    throw new Error("W2 forbids upstream network");
  }, blockedFetch);

  const model = "w2-chain-model";
  const explanation = (): import("./routing-rules.js").RouteExplanation => ({
    requestedModel: model,
    routedModel: model,
    source: "catalog",
    catalog: "found",
    candidates: [
      {
        provider: "kimi-coding",
        displayName: "Kimi Coding",
        modelSpec: "kc@wire-one",
        wireId: "wire-one",
        position: "candidate",
        tier: "subscription",
        outcome: "kept",
      },
      {
        provider: "openai",
        displayName: "OpenAI",
        modelSpec: "openai@wire-two",
        wireId: "wire-two",
        position: "candidate",
        tier: "native",
        outcome: "kept",
      },
      {
        provider: "openrouter",
        displayName: "OpenRouter",
        modelSpec: "or@wire-three",
        wireId: "wire-three",
        position: "fallback",
        tier: "fallback",
        outcome: "kept",
      },
    ],
    outcome: { kind: "ok" },
    warnings: [],
  });
  const rejected = (): import("./probe-live.js").ProbeResult => ({
    state: "auth-failed",
    latencyMs: 1,
    httpStatus: 400,
    errorMessage: "W2 rejected hop",
    chainAction: "advance",
    chainReason: "subscription-credential-rejected",
  });
  const live = (): import("./probe-live.js").ProbeResult => ({ state: "live", latencyMs: 1 });

  check(
    "G1 / 2.3: hop 2 serves with its provider, billing and model spec; hop 3 is not probed",
    async () => {
      const calls: string[] = [];
      const result = await preflightModel(model, {
        explain: async () => explanation(),
        probe: async (target) => {
          calls.push(target.provider);
          return target.provider === "kimi-coding" ? rejected() : live();
        },
      });
      expect(calls).toEqual(["kimi-coding", "openai"]);
      expect(result.kind).toBe("served");
      if (result.kind !== "served") throw new Error("Expected serving second hop");
      expect(result.served).toMatchObject({
        provider: "openai",
        billing: "metered",
        wireId: "wire-two",
        index: 2,
      });
      expect(result.served.probeSpec).toContain("@wire-two");
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]).toMatchObject({
        index: 1,
        provider: "kimi-coding",
        billing: "subscription",
        action: "advance",
        reason: "subscription-credential-rejected",
      });
      expect(result.untried).toBe(1);
      expect(result.total).toBe(3);
      const report = renderPreflightReport([result], { probed: true });
      expect(report).toContain("| Model | Provider | Billing | Status | Model spec |");
      expect(report).toContain("| OpenAI | metered |");
      expect(report).toContain("✅ live · hop 2/3");
      expect(report).toContain("(+1 untried)");
      expect(report).toContain("subscription: 0 · metered: 1");
      expect(report).toContain("PER TOKEN");
      expect(report).not.toContain("Drop or replace before running");
      const failedLines = report
        .split("\n")
        .filter((line) => line.startsWith("- ") && line.includes("hop 1/3"));
      expect(failedLines).toHaveLength(1);
      expect(failedLines[0]).toContain("subscription");
      expect(failedLines[0]).toContain(describeProbeState(rejected()));
      expect(failedLines[0]).toContain("moved to hop 2");
      expect(report).not.toContain("wire-three");
    }
  );

  check("G1 / 2.7: only exhausted and no-route models appear in Drop or replace", async () => {
    const served = await preflightModel(model, {
      explain: async () => explanation(),
      probe: async () => live(),
    });
    const exhausted = await preflightModel("w2-exhausted", {
      explain: async () => explanation(),
      probe: async () => rejected(),
    });
    expect(exhausted.kind).toBe("failed");
    if (exhausted.kind !== "failed") throw new Error("Expected exhausted chain");
    expect(exhausted.failed).toHaveLength(3);
    expect(exhausted.heldAt).toBeUndefined();
    expect(exhausted.untried).toBe(0);
    const noRoute = await preflightModel("w2-no-route", {
      probe: async () => {
        throw new Error("No-route must not probe");
      },
      explain: async () => ({
        ...explanation(),
        candidates: [],
        outcome: {
          kind: "no-route",
          cause: "catalog-empty",
          reason: "W2 no mapped route",
          hint: "W2 add a route",
        },
      }),
    });
    expect(noRoute).toMatchObject({
      kind: "no-route",
      reason: "W2 no mapped route",
      hint: "W2 add a route",
    });
    const report = renderPreflightReport([served, exhausted, noRoute], { probed: true });
    const drop = report
      .split("\n")
      .find((line) => line.includes("Drop or replace before running"))!;
    expect(drop).toContain("`w2-exhausted`");
    expect(drop).toContain("`w2-no-route`");
    expect(drop).not.toContain("`w2-chain-model`");
    expect(report).toContain("❌ every hop failed (3)");
    expect(report).toContain("W2 no mapped route");
    expect(report).toContain("W2 add a route");
  });

  check("G2 / 2.4: a stop verdict holds hop 1 and leaves later hops untried", async () => {
    let calls = 0;
    const result = await preflightModel(model, {
      explain: async () => explanation(),
      probe: async () => {
        calls++;
        return { ...rejected(), chainAction: "stop", chainReason: "credential-hold" };
      },
    });
    expect(calls).toBe(1);
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") throw new Error("Expected held chain");
    expect(result.heldAt).toMatchObject({ index: 1, action: "stop", reason: "credential-hold" });
    expect(result.untried).toBe(2);
    const report = renderPreflightReport([result], { probed: true });
    expect(report).toContain("chain stops at hop 1/3");
    expect(report).toContain("chain stops here");
  });

  check(
    "G2 / 2.9: absent chainAction stops with no-decision instead of trying a live hop 2",
    async () => {
      let calls = 0;
      const result = await preflightModel(model, {
        explain: async () => explanation(),
        probe: async () => (++calls === 1 ? { state: "key-missing", latencyMs: 0 } : live()),
      });
      expect(calls).toBe(1);
      expect(result.kind).toBe("failed");
      if (result.kind !== "failed") throw new Error("Expected no-decision hold");
      expect(result.heldAt).toMatchObject({ index: 1, action: "stop", reason: "no-decision" });
      expect(renderPreflightReport([result], { probed: true })).toContain(
        "chain stops here (no hop decision)"
      );
    }
  );

  check("G2 / 2.10: a throwing probe is contained as probe-error and never advances", async () => {
    let calls = 0;
    const result = await preflightModel(model, {
      explain: async () => explanation(),
      probe: async () => {
        calls++;
        throw new Error("boom");
      },
    });
    expect(calls).toBe(1);
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") throw new Error("Expected contained probe error");
    expect(result.heldAt).toMatchObject({ index: 1, action: "stop", reason: "probe-error" });
    expect(renderPreflightReport([result], { probed: true })).toContain(
      "❌ probe error · chain stops here"
    );
  });

  check(
    "G3 / 2.5: native Claude is neither success nor failure and bypasses explain and probe",
    async () => {
      const result = await preflightModel("opus", {
        explain: async () => {
          throw new Error("Native auth must not be routed");
        },
        probe: async () => {
          throw new Error("Native auth must not be probed");
        },
      });
      expect(result.kind).toBe("native");
      const report = renderPreflightReport([result], { probed: true });
      expect(report).toContain("native (not probed): 1");
      expect(report).toContain("not probed");
      expect(report).toContain("own auth");
      expect(report).not.toContain("Drop or replace before running");
      expect(report).not.toContain("✅");
      expect(report).not.toContain("❌");
    }
  );

  check("G1 / 2.6: plan-only preserves the chain without sending a probe", async () => {
    const result = await preflightModel(model, { explain: async () => explanation(), probe: null });
    expect(result.kind).toBe("planned");
    if (result.kind !== "planned") throw new Error("Expected unprobed plan");
    expect(result.hops).toHaveLength(3);
    expect(result.hops.every((hop) => hop.result === undefined)).toBe(true);
    const report = renderPreflightReport([result], { probed: false });
    expect(report).toContain("| Kimi Coding | subscription |");
    expect(report).toContain("not probed");
    expect(report).toContain("subscription: 1 · metered: 0");
    expect(report).not.toContain("PER TOKEN");
    expect(hopBilling("kimi-coding")).toBe("subscription");
    expect(hopBilling("openai")).toBe("metered");
    expect(hopBilling("ollama")).toBe("local");
  });
}
