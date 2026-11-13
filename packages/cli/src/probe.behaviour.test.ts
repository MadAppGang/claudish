import { expect, test } from "bun:test";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { isolatedFile, MODEL, KEY, catalog, temp, cli, CONTRACT_OFFLINE_NETWORK } from "./test-helpers/claude-behaviour.js";

await isolatedFile(import.meta, async () => {
  const { writeAllModelsCache } = await import("./providers/all-models-cache.js");
  const { explainRoute, route } = await import("./providers/routing-rules.js");
  const { probeChainFrom } = await import("./probe/probe-chain.js");
  const { probeTargets, describeDropped, probeSendRefusal } = await import("./providers/probe-runner.js");
  const { probeRowsFrom, probeQueue } = await import("./tui/hooks/useRouteProbe.js");
  const { leaderboardRows } = await import("./probe/leaderboard-rows.js");
  const { preflightModel, renderPreflightReport } = await import("./providers/preflight-chain.js");
  const { CLAUDISH_PLACEHOLDER_API_KEY } = await import("./auth/claudish-placeholder.js");
  const { claudeSubscriptionSpecRefusal } = await import("./providers/native-route.js");
  const { credentials } = await import("./auth/credentials/authority.js");
  type Explanation = Awaited<ReturnType<typeof explainRoute>>;
  type Candidate = Explanation["candidates"][number];
  const lookup = { hintFor: () => "ANTHROPIC_API_KEY", provenanceFor: () => undefined, searchedFor: () => "environment, config" };
  const candidate = (provider: string, outcome: Candidate["outcome"]): Candidate => ({
    provider, displayName: provider === "anthropic" ? "Claude API" : "OpenRouter",
    modelSpec: provider + "@" + MODEL, wireId: MODEL, position: "candidate",
    tier: provider === "anthropic" ? "native" : "gateway", outcome,
  });
  const explanation = (): Explanation => ({
    requestedModel: MODEL, routedModel: MODEL, source: "native", candidates: [],
    native: { provider: "native-anthropic", displayName: "Claude subscription", modelSpec: MODEL, isTierAlias: false },
    comparisonCandidates: [candidate("openrouter", "kept"), candidate("anthropic", "no-credential")],
    outcome: { kind: "ok" }, warnings: [],
  });
  const writeCatalog = (home: string) => {
    const path = join(home, ".claudish", "cloud-models-catalog-v3.json");
    writeAllModelsCache(catalog() as Parameters<typeof writeAllModelsCache>[0], path);
    return path;
  };
  async function jsonProbe(spec: string, keys: Record<string, string>) {
    const home = temp();
    try {
      writeCatalog(home);
      const result = await cli(home, ["--probe", spec, "--json", "--no-probe"], keys);
      expect(result.code, result.stderr).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data).toHaveLength(1);
      return data[0];
    } finally { rmSync(home, { recursive: true, force: true }); }
  }

  test("B-1 lists subscription and all credentialed comparisons", async () => {
    const result = await jsonProbe(MODEL, { ANTHROPIC_API_KEY: KEY, OPENROUTER_API_KEY: "sk-or-test-fake-0000000000" });
    expect(result).toMatchObject({ routingSource: "native", comparisonCatalog: "found" });
    expect(result.chain[0]).toMatchObject({ provider: "native-anthropic", displayName: "Claude subscription", notProbed: "native-auth", label: "Claude Code's own login" });
    expect(result.chain[0].comparison).toBeUndefined();
    expect(result.chain).toContainEqual(expect.objectContaining({ provider: "anthropic", displayName: "Claude API", modelSpec: "anthropic@" + MODEL, comparison: true }));
    expect(result.chain).toContainEqual(expect.objectContaining({ provider: "openrouter", comparison: true }));
    expect([...result.chain.slice(1), ...result.dropped].filter(x => x.provider === "native-anthropic")).toEqual([]);
  }, 20_000);

  test("B-2 names the missing API key sources", async () => {
    const result = await jsonProbe(MODEL, {});
    expect(result.chain).toHaveLength(1);
    expect(result.chain[0].notProbed).toBe("native-auth");
    const api = result.dropped.find((x: { provider: string; searched: string }) => x.provider === "anthropic");
    expect(api).toMatchObject({ outcome: "no-credential", credentialHint: "ANTHROPIC_API_KEY", comparison: true });
    expect(api.searched).toContain("environment");
  }, 20_000);

  test("B-3 drops the placeholder API key", async () => {
    const result = await jsonProbe(MODEL, { ANTHROPIC_API_KEY: CLAUDISH_PLACEHOLDER_API_KEY });
    expect(result.chain).toHaveLength(1);
    expect(result.chain[0].notProbed).toBe("native-auth");
    expect(result.dropped).toContainEqual(expect.objectContaining({ provider: "anthropic", outcome: "no-credential", credentialHint: "ANTHROPIC_API_KEY", comparison: true, searched: expect.stringContaining("environment") }));
  }, 20_000);

  test("B-4 lists no comparison for aliases or an explicit subscription", async () => {
    for (const spec of ["opus", "claude@" + MODEL]) {
      const result = await jsonProbe(spec, { ANTHROPIC_API_KEY: KEY });
      expect(result.chain).toHaveLength(1);
      expect(result.chain[0].provider).toBe("native-anthropic");
      expect(result.chain[0].comparison).toBeUndefined();
      expect(result.dropped).toEqual([]);
      if (spec === "opus") expect(result.routingExplanation).toContain("probe a concrete id to compare routes");
    }
  }, 30_000);

  test("B-5 compares an off-catalog name only with a readable catalog", async () => {
    const home = temp();
    try {
      const cachePath = writeCatalog(home);
      const found = await explainRoute("claude-typo-9", { comparison: true, cachePath, network: CONTRACT_OFFLINE_NETWORK, rules: {} });
      expect(found.comparisonCatalog).toBe("absent");
      expect(found.comparisonCandidates).toHaveLength(1);
      expect(found.comparisonCandidates![0]).toMatchObject({ provider: "anthropic", modelSpec: "anthropic@claude-typo-9", origin: "off-catalog" });
      const unreadable = await explainRoute("claude-typo-9", { comparison: true, cachePath: join(home, "missing.json"), network: CONTRACT_OFFLINE_NETWORK, rules: {} });
      expect(unreadable.comparisonCatalog).toBe("unreadable");
      expect(unreadable.comparisonCandidates ?? []).toEqual([]);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("B-6 keeps comparison routes separate from launch routing", async () => {
    const home = temp();
    process.env.ANTHROPIC_API_KEY = KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-test-fake-0000000000";
    credentials.invalidate();
    try {
      const opts = { cachePath: writeCatalog(home), network: CONTRACT_OFFLINE_NETWORK, rules: {} };
      const e = await explainRoute(MODEL, { ...opts, comparison: true });
      expect(e.source).toBe("native");
      expect(e.candidates).toEqual([]);
      expect(e.comparisonCatalog).toBe("found");
      expect(e.comparisonCandidates?.map(c => c.provider)).toEqual(["anthropic", "openrouter"]);
      expect(e.comparisonCandidates?.every(c => c.position === "candidate")).toBe(true);
      for (const [spec, comparison] of [[MODEL, false], ["opus", true], ["claude@" + MODEL, true]] as const)
        expect((await explainRoute(spec, { ...opts, comparison })).comparisonCandidates).toBeUndefined();
    } finally {
      delete process.env.ANTHROPIC_API_KEY; delete process.env.OPENROUTER_API_KEY;
      credentials.invalidate(); rmSync(home, { recursive: true, force: true });
    }
  });

  test("B-7 shapes native and comparison probe links", () => {
    const result = probeChainFrom(explanation(), lookup);
    expect(result.chain).toHaveLength(2);
    expect(result.chain[0]).toMatchObject({ provider: "native-anthropic", wireId: MODEL, modelSpec: MODEL, notProbed: "native-auth" });
    expect(result.chain[0].comparison).toBeUndefined();
    expect(result.chain[1]).toMatchObject({ provider: "openrouter", comparison: true });
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]).toMatchObject({ provider: "anthropic", comparison: true, searched: "environment, config" });
  });

  test("B-8 queues only kept comparisons as pinned probe targets", () => {
    const e = explanation();
    e.candidates = [candidate("anthropic", "kept")];
    const targets = probeTargets(e);
    expect(targets).toHaveLength(2);
    expect(targets[0].provider).toBe("anthropic");
    expect(targets[1]).toMatchObject({ provider: "openrouter", comparison: true, hopOrigin: "routed", probeSpec: "openrouter@" + MODEL });
    expect(targets.every(t => t.outcome === "kept")).toBe(true);
  });

  test("B-9 describes searched sources only when supplied", () => {
    expect(describeDropped("no-credential", "ANTHROPIC_API_KEY", undefined, "environment, config")).toEndWith(" (looked in: environment, config)");
    expect(describeDropped("no-credential", "ANTHROPIC_API_KEY")).not.toContain("looked in");
  });

  test("B-10 builds TUI comparison rows and queues only pending routes", () => {
    const { rows } = probeRowsFrom(explanation());
    expect(rows[0]).toMatchObject({ status: "unverified" });
    expect(rows[0].displayName).toBe("Claude subscription");
    expect(rows.find(r => r.provider === "openrouter")).toMatchObject({ status: "pending", comparison: true });
    expect(rows.find(r => r.provider === "anthropic")).toMatchObject({ status: "dropped", outcome: "no-credential", error: expect.stringMatching(/^looked in /) });
    expect(probeQueue(rows)).toEqual([expect.objectContaining({ provider: "openrouter", comparison: true })]);
  });

  test("B-11 renders available absent and unpublished Claude API notes", async () => {
    const states = [
      { state: "available" as const, spec: "anthropic@" + MODEL, source: "environment" },
      { state: "absent" as const, searched: ["environment", "config"] },
      { state: "not-in-catalog" as const },
    ];
    const messages = [
      "`" + MODEL + "` — Claude API: `anthropic@" + MODEL + "` (metered, ANTHROPIC_API_KEY from environment), used only when named",
      "absent — no ANTHROPIC_API_KEY (looked in environment, config)",
      "the catalog publishes no Claude API connection for this model",
    ];
    for (let i = 0; i < states.length; i++) {
      const result = await preflightModel(MODEL, { probe: null, claudeApi: async () => states[i] });
      expect(result).toMatchObject({ kind: "native", displayName: "Claude subscription", claudeApi: states[i] });
      expect(renderPreflightReport([result], { probed: false })).toContain(messages[i]);
    }
  });

  test("B-12 omits the API note for aliases and explicit subscriptions", async () => {
    for (const spec of ["opus", "claude@" + MODEL]) {
      const result = await preflightModel(spec, { probe: null, claudeApi: async () => { throw new Error("comparison must not read a key"); } });
      expect(result).toMatchObject({ kind: "native" });
      expect("claudeApi" in result).toBe(false);
    }
  });

  test("B-14 ranks every live route stably without representing comparisons", () => {
    const live = (displayName: string, totalMs: number, comparison?: true) => ({
      displayName, probe: { state: "live", timing: { totalMs } }, ...(comparison ? { comparison } : {}),
    });
    const input = [
      { model: MODEL, links: [{ displayName: "Claude subscription", notProbed: "native-auth" as const }, live("Claude API", 900, true), live("OpenRouter", 400, true)] },
      { model: "gpt-x", links: [live("A", 700), live("B", 300)] },
    ] as Parameters<typeof leaderboardRows>[0];
    const out = leaderboardRows(input);
    expect(out.ranked.map(r => r.timing!.totalMs)).toEqual([300, 400, 700, 900]);
    expect(out.ranked.find(r => r.provider === "A")?.representative).toBe(true);
    for (const provider of ["B", "Claude API", "OpenRouter"]) expect(out.ranked.find(r => r.provider === provider)?.representative).toBeUndefined();
    expect(out.unranked).toEqual([{ model: MODEL, provider: "Claude subscription", missing: "not probed (Claude subscription)" }]);
    const tied = leaderboardRows([{ model: "ties", links: [live("first", 100), live("second", 100)] }] as Parameters<typeof leaderboardRows>[0]);
    expect(tied.ranked.map(r => r.provider)).toEqual(["first", "second"]);
  });

  test("B-15 preserves unranked reasons in input order", () => {
    expect(leaderboardRows([
      { model: "failed", links: [{ displayName: "failed provider", probe: { state: "auth-failed" } }] },
      { model: "empty", links: [], emptyLabel: "no route here" },
      { model: MODEL, links: [{ displayName: "Claude subscription", notProbed: "native-auth" }] },
    ]).unranked).toEqual([
      { model: "failed", provider: "failed provider", missing: "no live route" },
      { model: "empty", provider: "no route here", missing: "no route" },
      { model: MODEL, provider: "Claude subscription", missing: "not probed (Claude subscription)" },
    ]);
  });

  test("B-16 refuses unreadable probe credentials and redacts errors", async () => {
    expect(await probeSendRefusal("openrouter", async () => { throw new Error("must not resolve read-at-use key"); })).toBeNull();
    expect(await probeSendRefusal("anthropic", async () => ({ state: "present", key: KEY, source: "macOS Keychain" }))).toBeNull();
    expect(await probeSendRefusal("anthropic", async () => ({ state: "absent", searched: ["environment", "config"] }))).toEqual({ outcome: "no-credential", searched: "environment, config" });
    expect(await probeSendRefusal("anthropic", async () => ({ state: "failed", reason: "item locked" }))).toEqual({ outcome: "credential-unreadable", detail: "item locked" });
    const thrown = await probeSendRefusal("anthropic", async () => { throw new Error("boom " + KEY); });
    expect(thrown?.outcome).toBe("credential-unreadable");
    expect(thrown?.detail).toContain("boom");
    expect(thrown?.detail).not.toContain(KEY);
  });

  test("B-42 refuses marked subscription specs before route planning", async () => {
    for (const spec of ["claude@" + MODEL + "#fast", "claude@" + MODEL + ":3"]) {
      const e = await explainRoute(spec, { network: CONTRACT_OFFLINE_NETWORK, rules: {} });
      expect(e.outcome).toMatchObject({ kind: "no-route", cause: "explicit-refused" });
      expect(e.candidates).toEqual([]);
      expect(await preflightModel(spec, { probe: null })).toMatchObject({ kind: "route-error", message: claudeSubscriptionSpecRefusal(spec) });
    }
    expect((await explainRoute("claude@" + MODEL, { network: CONTRACT_OFFLINE_NETWORK })).source).toBe("native");
    const json = await jsonProbe("claude@" + MODEL + "#fast", {});
    expect(json.outcome).toMatchObject({ kind: "no-route", cause: "explicit-refused" });
    expect(json.chain).toEqual([]);
  }, 20_000);

  test("B-43 refuses user rules naming the subscription", async () => {
    for (const entry of ["claude", "claude@claude-haiku-x"]) {
      const rules = { "glm-*": [entry, "openrouter"] };
      const e = await explainRoute("glm-5", { rules, network: CONTRACT_OFFLINE_NETWORK });
      expect(e.outcome).toMatchObject({ kind: "no-route", cause: "explicit-refused" });
      expect(e.candidates).toEqual([]);
      if (e.outcome.kind !== "no-route") throw new Error("subscription rule unexpectedly routed");
      expect(e.outcome.reason).toContain('routing rule "glm-*" lists "' + entry + '", the Claude subscription');
      expect(await route("glm-5", rules, undefined, undefined, { network: CONTRACT_OFFLINE_NETWORK })).toMatchObject({ kind: "no-route", reason: e.outcome.reason });
    }
    const other = await explainRoute("glm-5", { rules: { "glm-*": ["openrouter"] }, network: CONTRACT_OFFLINE_NETWORK });
    if (other.outcome.kind === "no-route") expect(other.outcome.cause).not.toBe("explicit-refused");
  });
});
