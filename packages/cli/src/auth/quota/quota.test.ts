import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TokenTracker } from "../../handlers/shared/token-tracker.js";
import { BUILTIN_PROVIDERS } from "../../providers/provider-definitions.js";
import { allQuotaAdapters, reportableQuotaAdapters, resolveQuotaAdapter } from "./registry.js";
import {
  compareModelRecency,
  parseModelVersion,
  planFromBuckets,
  planFromSummary,
  selectBucket,
  shortenModelId,
} from "./sources/antigravity.js";
import { formatWindowMinutes, scrapeCodexHeaders } from "./sources/codex.js";
import { PLAN_TTL_MS, type PlanUsage, epochSecondsToIso, isPlanStale, toUsedPct } from "./types.js";

const CODEX_RESPONSE_HEADERS = {
  "x-codex-active-limit": "premium",
  "x-codex-credits-balance": "0",
  "x-codex-credits-has-credits": "False",
  "x-codex-credits-unlimited": "False",
  "x-codex-plan-type": "pro",
  "x-codex-primary-over-secondary-limit-percent": "0",
  "x-codex-primary-reset-after-seconds": "235938",
  "x-codex-primary-reset-at": "1786160106",
  "x-codex-primary-used-percent": "66",
  "x-codex-primary-window-minutes": "10080",
  "x-codex-safety-buffering-enabled": "true",
  "x-codex-secondary-reset-after-seconds": "0",
  "x-codex-secondary-used-percent": "0",
  "x-codex-secondary-window-minutes": "0",
};

const ANTIGRAVITY_QUOTA_BUCKETS = [
  {
    resetTime: "2026-08-06T10:04:48Z",
    tokenType: "REQUESTS",
    modelId: "gemini-2.5-flash",
    remainingFraction: 1,
  },
  {
    resetTime: "2026-08-06T10:04:48Z",
    tokenType: "REQUESTS",
    modelId: "gemini-2.5-flash-lite",
    remainingFraction: 1,
  },
  {
    resetTime: "2026-08-06T10:04:48Z",
    tokenType: "REQUESTS",
    modelId: "gemini-2.5-pro",
    remainingFraction: 1,
  },
  {
    resetTime: "2026-08-06T10:04:48Z",
    tokenType: "REQUESTS",
    modelId: "gemini-3.1-flash-lite",
    remainingFraction: 1,
  },
];

const ANTIGRAVITY_WINDOW_IDS = [
  "claude-opus-4-6-thinking",
  "claude-sonnet-4-6",
  "2.5-flash",
  "2.5-flash-lite",
  "2.5-flash-thinking",
  "2.5-pro",
  "3-flash",
  "3-flash-agent",
  "3.1-flash-image",
  "3.1-flash-lite",
  "3.1-pro-high",
  "3.1-pro-low",
  "3.5-flash-extra-low",
  "3.5-flash-low",
  "3.6-flash-high",
  "3.6-flash-low",
  "3.6-flash-medium",
  "3.6-flash-tiered",
  "chat_20706",
  "chat_23310",
  "gpt-oss-120b-medium",
  "pro-agent",
  "tab_flash_lite_preview",
  "tab_jump_flash_lite_preview",
];

function codexHeaders(): Headers {
  return new Headers(CODEX_RESPONSE_HEADERS);
}

describe("Codex quota headers", () => {
  test("derives the window id, drops the unused slot, and parses reset epoch seconds", () => {
    const plan = scrapeCodexHeaders(codexHeaders());

    expect(plan).toBeDefined();
    expect(plan?.label).toBe("Codex Pro");
    expect(plan?.windows).toHaveLength(1);
    expect(plan?.windows[0]).toMatchObject({ id: "7d", used_pct: 66 });

    const reset = plan?.windows[0]?.resets_at;
    expect(reset).toBe(epochSecondsToIso(1786160106));
    expect(Number.isNaN(Date.parse(reset ?? ""))).toBe(false);
    expect(new Date(reset ?? "").getUTCFullYear()).toBe(2026);
  });

  test("returns undefined when no usable Codex headers are present", () => {
    expect(scrapeCodexHeaders(new Headers())).toBeUndefined();
  });

  test("formats real window durations without inventing zero-length windows", () => {
    const cases: Array<[number, string]> = [
      [10080, "7d"],
      [1440, "1d"],
      [300, "5h"],
      [60, "1h"],
      [30, "30m"],
      [0, ""],
      [-30, ""],
    ];

    for (const [minutes, expected] of cases) {
      expect(formatWindowMinutes(minutes)).toBe(expected);
    }
  });
});

describe("Antigravity quota summary", () => {
  const groups = [
    {
      displayName: "Gemini Models",
      buckets: [
        {
          bucketId: "gemini-weekly",
          window: "weekly",
          resetTime: "2026-11-22T10:46:31Z",
          remainingFraction: 1,
        },
        {
          bucketId: "gemini-5h",
          window: "5h",
          resetTime: "2026-11-15T15:46:31Z",
          remainingFraction: 0.75,
        },
      ],
    },
    {
      displayName: "Gemini 4 Argon",
      buckets: [{ bucketId: "gemini-argon-wtu-weekly", window: "weekly", remainingFraction: 0.4 }],
    },
  ];

  test("one window per limit, in the server's order, named by group and window", () => {
    const plan = planFromSummary(groups);
    expect(plan?.windows).toEqual([
      { id: "Gemini Models weekly", used_pct: 0, resets_at: "2026-11-22T10:46:31.000Z" },
      { id: "Gemini Models 5h", used_pct: 25, resets_at: "2026-11-15T15:46:31.000Z" },
      { id: "Gemini 4 Argon weekly", used_pct: 60 },
    ]);
    expect(plan?.source).toBe("provider");
  });

  test("a limit with no number is left out, and a summary with none reports nothing", () => {
    expect(
      planFromSummary([{ displayName: "Gemini Models", buckets: [{ window: "weekly" }] }])
    ).toBeUndefined();
    expect(planFromSummary([])).toBeUndefined();
  });
});

describe("Antigravity quota buckets", () => {
  test("does not fall back when the active model has no bucket", () => {
    expect(planFromBuckets(ANTIGRAVITY_QUOTA_BUCKETS, "gemini-3.6-flash")).toBeUndefined();
  });

  test("matches a bucket id plus a reasoning-tier suffix", () => {
    expect(selectBucket(ANTIGRAVITY_QUOTA_BUCKETS, "gemini-3.1-flash-lite-high")?.modelId).toBe(
      "gemini-3.1-flash-lite"
    );

    const reasoningTiers = ["extra-low", "high", "medium", "low", "tiered"];
    for (const tier of reasoningTiers) {
      expect(selectBucket(ANTIGRAVITY_QUOTA_BUCKETS, `gemini-2.5-pro-${tier}`)?.modelId).toBe(
        "gemini-2.5-pro"
      );
    }

    // This previously asserted the opposite, incorrectly reporting a sibling
    // model's flash-lite quota for a session spending the flash model.
    expect(selectBucket(ANTIGRAVITY_QUOTA_BUCKETS, "gemini-3.1-flash")).toBeUndefined();

    const flashLiteBucket = selectBucket(ANTIGRAVITY_QUOTA_BUCKETS, "gemini-2.5-flash-lite-high");
    expect(flashLiteBucket?.modelId).toBe("gemini-2.5-flash-lite");
    expect(flashLiteBucket?.modelId).not.toBe("gemini-2.5-flash");

    expect(selectBucket(ANTIGRAVITY_QUOTA_BUCKETS, "gemini-2.5")).toBeUndefined();
    expect(selectBucket(ANTIGRAVITY_QUOTA_BUCKETS, "gemini-2.5-p")).toBeUndefined();
    expect(selectBucket(ANTIGRAVITY_QUOTA_BUCKETS, "gemini-2.5-flash-8b")).toBeUndefined();
  });

  test("reports every captured bucket newest-first when there is no active model", () => {
    const plan = planFromBuckets(ANTIGRAVITY_QUOTA_BUCKETS);

    expect(plan).toBeDefined();
    expect(plan?.windows).toHaveLength(4);
    expect(plan?.windows.map((window) => window.id)).toEqual([
      "3.1-flash-lite",
      "2.5-flash",
      "2.5-flash-lite",
      "2.5-pro",
    ]);
    expect(plan?.windows.every((window) => window.used_pct === 0)).toBe(true);
  });

  test("parses agent model versions without promoting helper ids or model sizes", () => {
    const windowIdCases: Array<[string, number]> = [
      ["3.6-flash-high", 3.6],
      ["3.5-flash-low", 3.5],
      ["3.1-pro-low", 3.1],
      ["2.5-flash", 2.5],
      ["3-flash", 3],
      ["claude-sonnet-4-6", 4.6],
      ["claude-opus-4-6-thinking", 4.6],
    ];

    // Quota windows have already lost the gemini- prefix, so start-of-id
    // versions are the load-bearing form for keeping 3.6 above 2.5.
    for (const [modelId, expected] of windowIdCases) {
      expect(parseModelVersion(modelId)).toBe(expected);
    }

    // The exported parser remains safe for callers that pass a raw model id.
    expect(parseModelVersion("gemini-3.6-flash-high")).toBe(3.6);

    // These underscore-delimited tabModelIds are server-side helpers, not
    // agent versions; reading 20706/23310 would pin them above every model.
    expect(parseModelVersion("chat_20706")).toBeUndefined();
    expect(parseModelVersion("chat_23310")).toBeUndefined();
    expect(parseModelVersion("tab_flash_lite_preview")).toBeUndefined();
    expect(parseModelVersion("tab_jump_flash_lite_preview")).toBeUndefined();

    // 120b is a parameter size, while pro-agent has no encoded version.
    expect(parseModelVersion("gpt-oss-120b-medium")).toBeUndefined();
    expect(parseModelVersion("pro-agent")).toBeUndefined();
  });

  test("orders model windows newest-first with deterministic fallbacks", () => {
    const window = (id: string) => ({ id, used_pct: 0 });
    const versioned = window("3.6-flash-high");
    const unversioned = window("pro-agent");

    expect(compareModelRecency(versioned, window("3.5-flash-low"))).toBeLessThan(0);

    // Unversioned ids belong after real model versions in either argument order.
    expect(compareModelRecency(versioned, unversioned)).toBeLessThan(0);
    expect(compareModelRecency(unversioned, versioned)).toBeGreaterThan(0);

    // Equal versions and two unversioned ids use lexical order rather than
    // relying on the input order or Array.sort stability.
    expect(compareModelRecency(window("3.6-flash-high"), window("3.6-flash-low"))).toBe(
      "3.6-flash-high".localeCompare("3.6-flash-low")
    );
    expect(compareModelRecency(window("chat_23310"), window("pro-agent"))).toBe(
      "chat_23310".localeCompare("pro-agent")
    );
  });

  test("sorts the real 24-window listing by useful recency relationships", () => {
    const orderedIds = ANTIGRAVITY_WINDOW_IDS.map((id) => ({ id, used_pct: 0 }))
      .sort(compareModelRecency)
      .map((window) => window.id);
    const version36Ids = ANTIGRAVITY_WINDOW_IDS.filter((id) => id.startsWith("3.6-"));
    const version25Ids = ANTIGRAVITY_WINDOW_IDS.filter((id) => id.startsWith("2.5-"));

    // Every current 3.6 route must stay above every retired 2.5 route without
    // freezing the irrelevant ordering of all 24 entries.
    for (const currentId of version36Ids) {
      for (const retiredId of version25Ids) {
        expect(orderedIds.indexOf(currentId)).toBeLessThan(orderedIds.indexOf(retiredId));
      }
    }

    const threeXIds = ANTIGRAVITY_WINDOW_IDS.filter((id) => /^3(?:\.|-)/.test(id));
    const helperIds = [
      "chat_20706",
      "chat_23310",
      "tab_flash_lite_preview",
      "tab_jump_flash_lite_preview",
    ];

    // Server-side chat/tab helpers must remain below every 3.x agent model;
    // their incidental digits or input position must never promote them.
    for (const helperId of helperIds) {
      for (const agentId of threeXIds) {
        expect(orderedIds.indexOf(helperId)).toBeGreaterThan(orderedIds.indexOf(agentId));
      }
    }
  });

  test("reports only the active model and converts fully remaining to zero used", () => {
    const plan = planFromBuckets(ANTIGRAVITY_QUOTA_BUCKETS, "gemini-2.5-pro");

    expect(plan?.windows).toEqual([
      {
        id: "2.5-pro",
        used_pct: 0,
        resets_at: "2026-08-06T10:04:48.000Z",
      },
    ]);
    expect(toUsedPct((1 - 1) * 100)).toBe(0);
    expect(shortenModelId("gemini-2.5-pro")).toBe("2.5-pro");
  });
});

describe("quota plan freshness", () => {
  test("uses the plan TTL without sleeping", () => {
    const capturedPlan = scrapeCodexHeaders(codexHeaders());
    if (!capturedPlan) throw new Error("captured Codex headers must produce a plan");

    const now = Date.parse("2026-08-05T12:00:00.000Z");
    const freshPlan = {
      ...capturedPlan,
      observed_at: new Date(now - PLAN_TTL_MS).toISOString(),
    };
    const stalePlan = {
      ...capturedPlan,
      observed_at: new Date(now - PLAN_TTL_MS - 1).toISOString(),
    };

    expect(isPlanStale(freshPlan, now)).toBe(false);
    expect(isPlanStale(stalePlan, now)).toBe(true);
  });
});

describe("quota adapter registry", () => {
  test("resolves reporting adapters and researched unsupported providers", () => {
    expect(resolveQuotaAdapter("openai-codex")?.capability().kind).toBe("headers");
    expect(resolveQuotaAdapter("antigravity")?.capability().kind).toBe("endpoint");

    const glmCapability = resolveQuotaAdapter("glm-coding")?.capability();
    expect(glmCapability?.kind).toBe("none");
    if (glmCapability?.kind !== "none") {
      throw new Error("glm-coding must carry researched no-surface evidence");
    }
    expect(glmCapability.evidence.probed.length).toBeGreaterThan(0);

    expect(resolveQuotaAdapter(undefined)).toBeUndefined();
    expect(resolveQuotaAdapter("unknown-provider")).toBeUndefined();
  });

  test("excludes every unsupported adapter from the reportable registry", () => {
    const all = allQuotaAdapters();
    const reportable = reportableQuotaAdapters();
    const unsupportedIds = all
      .filter((adapter) => adapter.capability().kind === "none")
      .map((adapter) => adapter.providerId);

    expect(unsupportedIds.length).toBeGreaterThan(0);
    expect(reportable.every((adapter) => adapter.capability().kind !== "none")).toBe(true);
    for (const providerId of unsupportedIds) {
      expect(reportable.map((adapter) => adapter.providerId)).not.toContain(providerId);
    }
  });
});

describe("quota adapter registry integrity", () => {
  test("uses canonical unique provider ids, labels, and researched evidence", () => {
    const adapters = allQuotaAdapters();
    const providerIds = adapters.map((adapter) => adapter.providerId);
    const builtinProviderIds = new Set(BUILTIN_PROVIDERS.map((provider) => provider.name));

    // Antigravity is already keyed by its definition name. The google -> gemini
    // rename belongs only to the direct-API runtime path, so quota ids stay in
    // this strict definition-name key space without alias normalization.
    const unknownBuiltinIds = providerIds.filter(
      (providerId) => !builtinProviderIds.has(providerId)
    );
    const duplicateIds = providerIds.filter(
      (providerId, index) => providerIds.indexOf(providerId) !== index
    );
    const emptyLabelIds = adapters
      .filter((adapter) => adapter.label.trim().length === 0)
      .map((adapter) => adapter.providerId);
    const missingProbeIds: string[] = [];
    const invalidResearchDateIds: string[] = [];

    for (const adapter of adapters) {
      const capability = adapter.capability();
      if (capability.kind !== "none") continue;
      if (capability.evidence.probed.length === 0) missingProbeIds.push(adapter.providerId);
      if (Number.isNaN(Date.parse(capability.evidence.researched_at))) {
        invalidResearchDateIds.push(adapter.providerId);
      }
    }

    expect(unknownBuiltinIds).toEqual([]);
    expect(duplicateIds).toEqual([]);
    expect(emptyLabelIds).toEqual([]);
    expect(missingProbeIds).toEqual([]);
    expect(invalidResearchDateIds).toEqual([]);
  });
});

describe("TokenTracker plan serialization", () => {
  test("writes only fresh plans without producer-only metadata", () => {
    const previousTokenFile = process.env.CLAUDISH_TOKEN_FILE;
    const tempDirectory = mkdtempSync(join(tmpdir(), "claudish-quota-plan-"));
    const tokenFile = join(tempDirectory, "tokens.json");
    process.env.CLAUDISH_TOKEN_FILE = tokenFile;

    try {
      const tracker = new TokenTracker(45_678, {
        contextWindow: 200_000,
        providerName: "openai",
        modelName: "gpt-test",
      });
      tracker.update(123, 45);

      const freshPlan: PlanUsage = {
        label: "Codex Pro",
        windows: [{ id: "7d", used_pct: 66, resets_at: "2026-08-08T00:00:00.000Z" }],
        source: "provider",
        observed_at: new Date().toISOString(),
      };
      tracker.setPlanUsage(freshPlan);
      tracker.rewrite();

      const freshWritten = JSON.parse(readFileSync(tokenFile, "utf8"));
      expect(freshWritten.plan).toEqual({
        label: freshPlan.label,
        windows: freshPlan.windows,
        source: freshPlan.source,
      });
      expect(freshWritten.plan).not.toHaveProperty("observed_at");
      expect(freshWritten).toMatchObject({
        input_tokens: 123,
        output_tokens: 45,
        provider_name: "OpenAI",
      });

      tracker.setPlanUsage({
        ...freshPlan,
        observed_at: new Date(Date.now() - PLAN_TTL_MS - 1).toISOString(),
      });
      tracker.rewrite();
      const staleWritten = JSON.parse(readFileSync(tokenFile, "utf8"));
      expect(staleWritten).not.toHaveProperty("plan");

      tracker.setPlanUsage(undefined);
      tracker.rewrite();
      const absentWritten = JSON.parse(readFileSync(tokenFile, "utf8"));
      expect(absentWritten).not.toHaveProperty("plan");
    } finally {
      if (previousTokenFile === undefined) delete process.env.CLAUDISH_TOKEN_FILE;
      else process.env.CLAUDISH_TOKEN_FILE = previousTokenFile;
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });
});
