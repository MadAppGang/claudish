import { expect, test } from "bun:test";
import { isolatedFile } from "../test-helpers/claude-behaviour.js";
import { deferred, runChild, useSandbox } from "../test-helpers/model-lineup-blind.js";
import type { ProviderListing } from "../types.js";
import type { LineupDeps, LineupRow, ModelLineup } from "./model-lineup.js";

await isolatedFile(import.meta, async () => {
  const sandbox = useSandbox();
  const lineupModule = await import("./model-lineup.js");
  const {
    buildModelLineup,
    lineupRowsForProvider,
    modelPickerSetting,
    routedUserRows,
    lineupReport,
    sessionWindow,
    redactAndTruncate,
    MODEL_RESTORE_PROMISE,
    LINEUP_WAIT_MS,
    LINEUP_LABEL_MAX,
    LINEUP_DESCRIPTION_MAX,
  } = lineupModule;
  const { CLAUDE_CODE_DEFAULT_MAX_CONTEXT } = await import("../claude-runner.js");
  const { parseModelSpec } = await import("../providers/model-parser.js");

  function listing(
    provider = "my-vllm",
    scope: ProviderListing["scope"] = "recommended"
  ): ProviderListing {
    return {
      provider,
      typed: provider + "@" + (scope === "all" ? "*" : ""),
      scope,
      pinnedSpecs: [],
    };
  }
  const own: LineupRow = {
    model: "ollama@listed",
    label: "Listed model",
    description: "Ollama · local",
    provider: "ollama",
  };
  function deps(overrides: Partial<LineupDeps> = {}): LineupDeps {
    return {
      ready: async () => true,
      storedList: async () => null,
      liveList: async () => {
        throw new Error("Discovery is unavailable in this test");
      },
      catalogRows: () => [],
      catalogIsBundled: () => false,
      ensureCatalog: async () => {},
      // REQ-40: this callback conforms to the public no-argument signature.
      recommended: async () => null,
      declaredModels: () => null,
      tier: () => "native",
      hasDiscovery: () => false,
      now: () => Date.now(),
      ...overrides,
    };
  }

  // REQ-18; H1 is checked against whole user objects, not just their model ids.
  test("TEST-14 preserves arbitrary user option fields and drops malformed options", () => {
    const user = {
      model: "my-gw/x",
      behavesAs: "claude-haiku-4-5",
      extra: 1,
      nested: { keep: [1, 2] },
    };
    const value = modelPickerSetting([own], {
      user: {
        where: sandbox().settingsFile,
        options: [user, { label: "no model" }, { model: 42 }, ["array"], null],
      },
      managed: null,
      availableModels: [],
    });

    expect(value.setting.options).toEqual([
      { ...user, label: "my-gw/x" },
      { model: own.model, label: own.label, description: own.description },
    ]);
    expect(value.setting.options[0]).not.toHaveProperty("description");
    expect(Object.keys(value.setting.options[1]!).sort()).toEqual([
      "description",
      "label",
      "model",
    ]);
    expect(value.setting).not.toHaveProperty("replaceBuiltInOptions");
    expect(user).not.toHaveProperty("label");
  });

  // REQ-5, REQ-18, REQ-20
  test("TEST-15 keeps user rows first, deduplicates and names every policy notice", () => {
    const where = sandbox().settingsFile;
    const managed = sandbox().home + "/managed.json";
    const allowed = sandbox().home + "/allowed.json";
    const duplicate = { model: own.model, label: "My label", behavesAs: "claude-haiku-4-5" };
    const result = modelPickerSetting([own, { ...own, model: "ollama@second" }], {
      user: { where, options: [duplicate], replaceBuiltInOptions: true },
      managed,
      availableModels: [allowed],
    });

    expect(result.setting.options).toEqual([
      duplicate,
      { model: "ollama@second", label: own.label, description: own.description },
    ]);
    expect(result.setting).not.toHaveProperty("replaceBuiltInOptions");
    expect(result.notices.filter((line) => line.includes("replaceBuiltInOptions"))).toHaveLength(1);
    expect(result.notices.join("\n")).toContain(where);
    expect(result.notices.join("\n")).toContain(managed);
    expect(result.notices.join("\n")).toContain(allowed);
  });

  // REQ-10, §4 H3
  test("TEST-16 routes only non-lineup explicit claudish user specs", () => {
    const models = [
      "ollama@user-choice",
      own.model,
      "claude-opus-5",
      "claude@opus",
      "my-gw/x",
      "nosuchprovider@x",
      "https://example.invalid/model",
      "oc/legacy",
    ];
    expect(
      routedUserRows(
        models.map((model) => ({ model, label: "Label: " + model })),
        [own]
      )
    ).toEqual([{ model: "ollama@user-choice", label: "Label: ollama@user-choice" }]);
  });

  // REQ-16, REQ-41
  test.each([
    [{ CLAUDE_CODE_MAX_CONTEXT_TOKENS: "64000" }, 128000, 64000],
    [{}, 128000, 128000],
    [{}, 0, CLAUDE_CODE_DEFAULT_MAX_CONTEXT],
    [{}, -1, CLAUDE_CODE_DEFAULT_MAX_CONTEXT],
  ] as const)(
    "TEST-17 applies user/computed/default window precedence: %j, %s",
    (env, computed, expected) => {
      expect(sessionWindow(env, computed)).toBe(expected);
    }
  );

  test("TEST-18 uses the shared assumed window without the obsolete export", () => {
    expect(sessionWindow({}, 0)).toBe(CLAUDE_CODE_DEFAULT_MAX_CONTEXT);
    expect(lineupModule).not.toHaveProperty("CLAUDE_CODE_ASSUMED_WINDOW");
  });

  // REQ-9, REQ-16, REQ-17, REQ-28, REQ-38
  test.each(["claude-start", "foreign-start", "tiers"] as const)(
    "TEST-19 report explains %s posture and never makes an unregistered restore promise",
    (posture) => {
      const lineup: ModelLineup = {
        rows: [
          { ...own, contextLength: 64000 },
          { ...own, model: "ollama@smallest", label: "Smallest", contextLength: 32000 },
        ],
        outcomes: [
          { kind: "listed", provider: "ollama", count: 2, source: "bundled" },
          { kind: "not-listed", provider: "devin", reason: "account list unavailable" },
        ],
      };
      const report = lineupReport(lineup, {
        sizedFor: 200000,
        settingsNotices: ["settings notice: " + sandbox().settingsFile],
        posture,
        inheritedModelVars: [
          { name: "ANTHROPIC_SMALL_FAST_MODEL", value: "private-user-background" },
        ],
      });
      const text = report.join("\n");
      expect(report).not.toContain(MODEL_RESTORE_PROMISE);
      expect(text).not.toContain("puts your setting back");
      expect(text).toContain("account list unavailable");
      expect(text).toMatch(/bundled|partial/i);
      expect(text).toContain(sandbox().settingsFile);
      expect(text).toMatch(/32|smallest/i);
      expect(text).toContain("ANTHROPIC_SMALL_FAST_MODEL");
      expect(text).not.toContain("private-user-background");
      if (posture === "foreign-start") expect(text).toMatch(/foreign model.*start model/i);
      if (posture === "tiers") expect(text).toMatch(/mapped tiers/);
    }
  );

  // REQ-1, REQ-13, REQ-31
  test.each(["recommended", "all"] as const)(
    "TEST-20 declared endpoints list all declared ids in %s scope",
    (scope) => {
      const result = lineupRowsForProvider({
        listing: listing("my-vllm", scope),
        tier: "gateway",
        isLocal: false,
        discovered: null,
        catalogRows: [],
        recommendedIds: [],
        declared: ["alpha", "vendor/beta"],
      });
      expect(result.rows.map((row) => parseModelSpec(row.model).model)).toEqual([
        "alpha",
        "vendor/beta",
      ]);
      for (const row of result.rows) {
        expect(parseModelSpec(row.model).provider).toBe("my-vllm");
        expect(row.label.length).toBeGreaterThan(0);
        expect(row.label.length).toBeLessThanOrEqual(60);
        expect(row.description.length).toBeLessThanOrEqual(100);
      }
    }
  );

  test("TEST-20 local and subscription pinned rows retain their billing labels", () => {
    for (const [provider, isLocal, tier, label] of [
      ["ollama", true, "native", "local"],
      ["devin", false, "dynamic-subscription", "SUB"],
    ] as const) {
      const result = lineupRowsForProvider({
        listing: { ...listing(provider), pinnedSpecs: [provider + "@synthetic"] },
        tier,
        isLocal,
        discovered: null,
        catalogRows: [],
        recommendedIds: null,
        declared: null,
      });
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]!.description).toContain(label);
    }
  });

  // REQ-13: HTTP traffic is observable; internal dependency invocations are not asserted.
  test("TEST-21 undeclared custom recommended scope gives a remedy without any /models traffic", async () => {
    const paths: string[] = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        paths.push(new URL(request.url).pathname);
        return Response.json({ data: [] });
      },
    });
    try {
      const dependency = deps({
        declaredModels: () => [],
        tier: () => "gateway",
        hasDiscovery: () => true,
        liveList: async () => {
          await fetch("http://127.0.0.1:" + upstream.port + "/models");
          throw new Error("The test discovery returned no usable models");
        },
      });
      const recommended = await buildModelLineup([listing()], { deps: dependency });
      expect(recommended.rows).toEqual([]);
      expect(recommended.outcomes).toEqual([
        {
          kind: "not-listed",
          provider: "my-vllm",
          reason: "declare models for my-vllm, or use 'my-vllm@*'",
        },
      ]);
      expect(paths).toEqual([]);

      await buildModelLineup([listing("my-vllm", "all")], { deps: dependency });
      expect(paths).toContain("/models");
    } finally {
      await upstream.stop(true);
    }
  });

  // REQ-14
  test("TEST-22 unready providers expose no pinned or declared rows", async () => {
    const result = await buildModelLineup([{ ...listing(), pinnedSpecs: ["my-vllm@pinned"] }], {
      deps: deps({ ready: async () => false, declaredModels: () => ["declared"] }),
    });
    expect(result.rows).toEqual([]);
    expect(result.outcomes[0]).toMatchObject({ kind: "not-listed", provider: "my-vllm" });
    expect(result.outcomes[0]).toHaveProperty("reason", expect.any(String));
  });

  // REQ-12
  test("TEST-23 failed account discovery resolves with a reason and no invented rows", async () => {
    const result = await buildModelLineup([listing("devin", "all")], {
      deps: deps({
        hasDiscovery: () => true,
        tier: () => "dynamic-subscription",
        liveList: async () => {
          throw new Error("account list unavailable");
        },
      }),
    });
    expect(result.rows).toEqual([]);
    expect(result.outcomes).toEqual([
      {
        kind: "not-listed",
        provider: "devin",
        reason: expect.any(String),
      },
    ]);
    expect(JSON.stringify(result.outcomes)).toMatch(/list|discovery|unavailable|failed/i);
  });

  // REQ-24
  test.each(["credential", "list"] as const)(
    "TEST-24 deadline resolves and names a pending %s stage",
    async (stage) => {
      const never = (): Promise<never> => new Promise(() => {});
      const dependency = deps({
        tier: () => "gateway",
        ...(stage === "credential" ? { ready: () => never() } : {}),
        ...(stage === "list" ? { hasDiscovery: () => true, liveList: () => never() } : {}),
      });
      const result = await buildModelLineup(
        [{ ...listing("openrouter"), pinnedSpecs: ["or@pinned"] }],
        { deadlineMs: 30, deps: dependency }
      );
      expect(result.outcomes[0]).toMatchObject({ kind: "not-listed", provider: "openrouter" });
      const outcome = result.outcomes[0]!;
      if (outcome.kind !== "not-listed") throw new Error("Expected deadline outcome");
      expect(outcome.reason).toMatch(new RegExp(stage, "i"));
      if (stage !== "credential") expect(outcome.reason).not.toContain("1Password");
    },
    5_000
  );

  // REQ-24, REQ-47
  test("TEST-25 fast provider survives the shared deadline and late readiness cannot append rows", async () => {
    expect(LINEUP_WAIT_MS).toBe(6000);
    const late = deferred<boolean>();
    const result = await buildModelLineup([listing("late"), listing("fast")], {
      deadlineMs: 30,
      deps: deps({
        ready: (provider) => (provider === "late" ? late.promise : Promise.resolve(true)),
        declaredModels: (provider) => [provider + "-model"],
        tier: () => "gateway",
      }),
    });
    expect(result.rows.map((row) => row.provider)).toEqual(["fast"]);
    expect(result.outcomes.find((row) => row.provider === "late")).toMatchObject({
      kind: "not-listed",
    });
    const before = JSON.stringify(result);
    late.resolve(true);
    await Bun.sleep(0);
    expect(JSON.stringify(result)).toBe(before);
  });

  // REQ-11
  test("TEST-26 missing recommendations keep explicit pins and explain full scope", () => {
    const result = lineupRowsForProvider({
      listing: { ...listing("openrouter"), pinnedSpecs: ["or@chosen"] },
      tier: "gateway",
      isLocal: false,
      discovered: null,
      catalogRows: [],
      recommendedIds: null,
      declared: null,
    });
    expect(result.rows.map((row) => row.model)).toEqual(["or@chosen"]);
    const empty = lineupRowsForProvider({
      listing: { ...listing("openrouter"), typed: "or@" },
      tier: "gateway",
      isLocal: false,
      discovered: null,
      catalogRows: [],
      recommendedIds: null,
      declared: null,
    });
    expect(empty.rows).toEqual([]);
    expect(empty.emptyReason).toContain("recommended list unavailable");
    expect(empty.emptyReason).toMatch(/(?:or|openrouter)@\*/);
  });

  // REQ-46; the default catalogRows, not a stubbed bundled answer, is essential here.
  test("TEST-27 fresh offline child lists bundled Anthropic rows instead of an empty lineup", async () => {
    const url = new URL("./model-lineup.js", import.meta.url).href;
    const run = await runChild(
      sandbox().home,
      [
        "delete process.env.CLAUDISH_DISABLE_BUNDLED_LIST;",
        "const {buildModelLineup} = await import(" + JSON.stringify(url) + ");",
        'const result = await buildModelLineup([{provider:"anthropic",typed:"anthropic@",scope:"all",pinnedSpecs:[]}], {deps:{ready:async()=>true,ensureCatalog:async()=>{},hasDiscovery:()=>false,declaredModels:()=>null}});',
        'console.log("@@lineup=" + JSON.stringify(result));',
      ].join("\n")
    );
    expect(run.code, run.stdout + run.stderr).toBe(0);
    const line = run.stdout.split("\n").find((value) => value.startsWith("@@lineup="));
    expect(line, run.stdout + run.stderr).toBeDefined();
    const result = JSON.parse(line!.slice("@@lineup=".length)) as ModelLineup;
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.outcomes).toEqual([
      {
        kind: "listed",
        provider: "anthropic",
        count: result.rows.length,
        source: "bundled",
      },
    ]);
  }, 20_000);

  // REQ-31, REQ-44
  test.each([60, 100])(
    "TEST-28 plain text truncates to exactly %s characters with an ellipsis",
    (max) => {
      expect(redactAndTruncate("x".repeat(max), max)).toBe("x".repeat(max));
      expect(redactAndTruncate("x".repeat(max + 1), max)).toBe("x".repeat(max - 1) + "…");
      expect(LINEUP_LABEL_MAX).toBe(60);
      expect(LINEUP_DESCRIPTION_MAX).toBe(100);
    }
  );

  // TEST-41 exercises redaction-marker truncation with a real active signing lease.
});
