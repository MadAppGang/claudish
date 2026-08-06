import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TokenTracker } from "../../handlers/shared/token-tracker.js";
import { BUILTIN_PROVIDERS } from "../../providers/provider-definitions.js";
import { PROVIDER_PROFILES } from "../../providers/provider-profiles.js";
import { allQuotaAdapters, reportableQuotaAdapters, resolveQuotaAdapter } from "./registry.js";
import { planFromBuckets, selectBucket, shortenModelId } from "./sources/antigravity.js";
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

  test("reports every captured bucket when there is no active model", () => {
    const plan = planFromBuckets(ANTIGRAVITY_QUOTA_BUCKETS);

    expect(plan).toBeDefined();
    expect(plan?.windows).toHaveLength(4);
    expect(plan?.windows.map((window) => window.id)).toEqual([
      "2.5-flash",
      "2.5-flash-lite",
      "2.5-pro",
      "3.1-flash-lite",
    ]);
    expect(plan?.windows.every((window) => window.used_pct === 0)).toBe(true);
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
    const profileProviderIds = new Set(Object.keys(PROVIDER_PROFILES));

    const unknownBuiltinIds = providerIds.filter(
      (providerId) => !builtinProviderIds.has(providerId)
    );
    const unknownProfileIds = providerIds.filter(
      (providerId) => !profileProviderIds.has(providerId)
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
    expect(unknownProfileIds).toEqual([]);
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
