import { describe, expect, it } from "bun:test";
import {
  type OtlpResource,
  type StatsEvent,
  buildResource,
  eventToLogRecord,
  formatOtlpBatch,
} from "./stats-otlp.js";

const SAMPLE_RESOURCE: OtlpResource = {
  version: "5.12.0",
  platform: "darwin",
  arch: "arm64",
  runtime: "bun-1.2",
  installMethod: "homebrew",
  timezone: "America/New_York",
};

const SAMPLE_EVENT: StatsEvent = {
  timestamp: "2026-03-16T14:00:00.000Z",
  model_id: "google/gemini-2.5-pro",
  provider_name: "gemini",
  stream_format: "gemini-sse",
  latency_ms: 1842,
  success: true,
  http_status: 200,
  input_tokens: 15420,
  output_tokens: 3200,
  estimated_cost: 0.00234,
  is_free_model: false,
  token_strategy: "standard",
  adapter_name: "DefaultAPIFormat",
  middleware_names: ["GeminiThoughtSignature"],
  fallback_used: false,
  invocation_mode: "auto-route",
  platform: "darwin",
  arch: "arm64",
  timezone: "America/New_York",
  runtime: "bun-1.2",
  install_method: "homebrew",
  claudish_version: "5.12.0",
};

describe("buildResource", () => {
  it("returns correct service.name attribute", () => {
    const attrs = buildResource(SAMPLE_RESOURCE);
    const serviceName = attrs.find((a) => a.key === "service.name");
    expect(serviceName).toBeDefined();
    expect((serviceName?.value as any).stringValue).toBe("claudish");
  });

  it("returns service.version matching input", () => {
    const attrs = buildResource(SAMPLE_RESOURCE);
    const version = attrs.find((a) => a.key === "service.version");
    expect((version?.value as any).stringValue).toBe("5.12.0");
  });

  it("splits runtime into name and version", () => {
    const attrs = buildResource(SAMPLE_RESOURCE);
    const runtimeName = attrs.find((a) => a.key === "process.runtime.name");
    const runtimeVersion = attrs.find((a) => a.key === "process.runtime.version");
    expect((runtimeName?.value as any).stringValue).toBe("bun");
    expect((runtimeVersion?.value as any).stringValue).toBe("1.2");
  });

  it("includes os.type, host.arch, install_method, timezone", () => {
    const attrs = buildResource(SAMPLE_RESOURCE);
    const keys = attrs.map((a) => a.key);
    expect(keys).toContain("os.type");
    expect(keys).toContain("host.arch");
    expect(keys).toContain("claudish.install_method");
    expect(keys).toContain("claudish.timezone");
  });

  it("handles runtime without dash", () => {
    const attrs = buildResource({ ...SAMPLE_RESOURCE, runtime: "unknown" });
    const runtimeName = attrs.find((a) => a.key === "process.runtime.name");
    const runtimeVersion = attrs.find((a) => a.key === "process.runtime.version");
    expect((runtimeName?.value as any).stringValue).toBe("unknown");
    expect((runtimeVersion?.value as any).stringValue).toBe("unknown");
  });
});

describe("eventToLogRecord", () => {
  it("sets severityNumber to 9 (INFO)", () => {
    const record = eventToLogRecord(SAMPLE_EVENT);
    expect(record.severityNumber).toBe(9);
    expect(record.severityText).toBe("INFO");
  });

  it("sets body to llm.request", () => {
    const record = eventToLogRecord(SAMPLE_EVENT);
    expect(record.body.stringValue).toBe("llm.request");
  });

  it("formats timeUnixNano as nanosecond string", () => {
    const record = eventToLogRecord(SAMPLE_EVENT);
    const expectedMs = new Date("2026-03-16T14:00:00.000Z").getTime();
    const expectedNano = String(expectedMs * 1_000_000);
    expect(record.timeUnixNano).toBe(expectedNano);
    // Must be a string (OTel spec requires string for nanoseconds)
    expect(typeof record.timeUnixNano).toBe("string");
  });

  it("includes llm.model attribute with model_id", () => {
    const record = eventToLogRecord(SAMPLE_EVENT);
    const modelAttr = record.attributes.find((a) => a.key === "llm.model");
    expect((modelAttr?.value as any).stringValue).toBe("google/gemini-2.5-pro");
  });

  it("includes http.status_code as intValue string", () => {
    const record = eventToLogRecord(SAMPLE_EVENT);
    const httpAttr = record.attributes.find((a) => a.key === "http.status_code");
    expect((httpAttr?.value as any).intValue).toBe("200");
    // intValue must be string per OTel spec
    expect(typeof (httpAttr?.value as any).intValue).toBe("string");
  });

  it("includes llm.estimated_cost_usd as doubleValue", () => {
    const record = eventToLogRecord(SAMPLE_EVENT);
    const costAttr = record.attributes.find((a) => a.key === "llm.estimated_cost_usd");
    expect((costAttr?.value as any).doubleValue).toBe(0.00234);
  });

  it("includes middleware as arrayValue", () => {
    const record = eventToLogRecord(SAMPLE_EVENT);
    const mwAttr = record.attributes.find((a) => a.key === "llm.middleware");
    const values = (mwAttr?.value as any).arrayValue.values;
    expect(Array.isArray(values)).toBe(true);
    expect(values[0].stringValue).toBe("GeminiThoughtSignature");
  });

  it("includes boolValue for llm.success and llm.is_free", () => {
    const record = eventToLogRecord(SAMPLE_EVENT);
    const successAttr = record.attributes.find((a) => a.key === "llm.success");
    const freeAttr = record.attributes.find((a) => a.key === "llm.is_free");
    expect((successAttr?.value as any).boolValue).toBe(true);
    expect((freeAttr?.value as any).boolValue).toBe(false);
  });

  it("omits error_class and error_code when not set", () => {
    const record = eventToLogRecord(SAMPLE_EVENT);
    const hasErrorClass = record.attributes.some((a) => a.key === "llm.error_class");
    const hasErrorCode = record.attributes.some((a) => a.key === "llm.error_code");
    expect(hasErrorClass).toBe(false);
    expect(hasErrorCode).toBe(false);
  });

  it("includes error fields when present", () => {
    const errorEvent: StatsEvent = {
      ...SAMPLE_EVENT,
      success: false,
      http_status: 429,
      error_class: "rate_limit",
      error_code: "rate_limited_429",
    };
    const record = eventToLogRecord(errorEvent);
    const errorClass = record.attributes.find((a) => a.key === "llm.error_class");
    const errorCode = record.attributes.find((a) => a.key === "llm.error_code");
    expect((errorClass?.value as any).stringValue).toBe("rate_limit");
    expect((errorCode?.value as any).stringValue).toBe("rate_limited_429");
  });

  it("includes fallback_chain when present", () => {
    const fallbackEvent: StatsEvent = {
      ...SAMPLE_EVENT,
      fallback_used: true,
      fallback_chain: ["litellm", "openrouter"],
      fallback_attempts: 1,
    };
    const record = eventToLogRecord(fallbackEvent);
    const chainAttr = record.attributes.find((a) => a.key === "llm.fallback_chain");
    const attemptsAttr = record.attributes.find((a) => a.key === "llm.fallback_attempts");
    expect(chainAttr).toBeDefined();
    expect(attemptsAttr).toBeDefined();
    const values = (chainAttr?.value as any).arrayValue.values;
    expect(values[0].stringValue).toBe("litellm");
  });
});

describe("formatOtlpBatch", () => {
  it("returns valid JSON", () => {
    const result = formatOtlpBatch([SAMPLE_EVENT], SAMPLE_RESOURCE);
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it("has correct top-level structure", () => {
    const result = JSON.parse(formatOtlpBatch([SAMPLE_EVENT], SAMPLE_RESOURCE));
    expect(Array.isArray(result.resourceLogs)).toBe(true);
    expect(result.resourceLogs.length).toBe(1);
  });

  it("has one resourceLogs entry with scopeLogs", () => {
    const result = JSON.parse(formatOtlpBatch([SAMPLE_EVENT], SAMPLE_RESOURCE));
    const rl = result.resourceLogs[0];
    expect(rl.resource).toBeDefined();
    expect(Array.isArray(rl.scopeLogs)).toBe(true);
    expect(rl.scopeLogs.length).toBe(1);
  });

  it("scope has name claudish.stats and version 1", () => {
    const result = JSON.parse(formatOtlpBatch([SAMPLE_EVENT], SAMPLE_RESOURCE));
    const scope = result.resourceLogs[0].scopeLogs[0].scope;
    expect(scope.name).toBe("claudish.stats");
    expect(scope.version).toBe("1");
  });

  it("includes one logRecord per event", () => {
    const result = JSON.parse(formatOtlpBatch([SAMPLE_EVENT, SAMPLE_EVENT], SAMPLE_RESOURCE));
    const records = result.resourceLogs[0].scopeLogs[0].logRecords;
    expect(records.length).toBe(2);
  });

  it("returns empty resourceLogs for empty events array", () => {
    const result = JSON.parse(formatOtlpBatch([], SAMPLE_RESOURCE));
    expect(result.resourceLogs).toEqual([]);
  });
});

/**
 * THE GUARD FOR THE ONE SILENT FAILURE IN `stats-otlp.ts`.
 *
 * `eventToLogRecord` is a hand-written attribute allowlist. A field added to
 * `StatsEvent` and populated by `stats.ts` but NOT pushed there is typed,
 * type-checked, buffered and written to `~/.claudish/stats-buffer.json` — and
 * never leaves the machine. Nothing throws. The field is simply missing from
 * every dashboard built to read it, and the loss is discovered a quarter later,
 * when someone asks a question the data cannot answer.
 *
 * Two layers, and the first is the durable one:
 *
 *  1. `satisfies Record<OptionalStatsKey, …>` makes the table below EXHAUSTIVE
 *     over `StatsEvent`'s optional fields AT COMPILE TIME. Add an optional field
 *     to the interface and this file stops compiling until it is listed here.
 *  2. The table then drives emit-when-set and omit-when-unset for every entry,
 *     so listing a field without pushing it in `eventToLogRecord` is red.
 *
 * Together, a new optional field cannot reach `main` without its push. Layer 1
 * is what stops this from being a checklist someone has to remember to read.
 */
type OptionalStatsKey = {
  [K in keyof StatsEvent]-?: undefined extends StatsEvent[K] ? K : never;
}[keyof StatsEvent];

const OPTIONAL_WIRE = {
  error_class: {
    attribute: "llm.error_class",
    sample: "network",
    value: { stringValue: "network" },
  },
  error_code: {
    attribute: "llm.error_code",
    sample: "ECONNREFUSED",
    value: { stringValue: "ECONNREFUSED" },
  },
  fallback_chain: {
    attribute: "llm.fallback_chain",
    sample: ["litellm", "openrouter"],
    value: { arrayValue: { values: [{ stringValue: "litellm" }, { stringValue: "openrouter" }] } },
  },
  fallback_attempts: {
    attribute: "llm.fallback_attempts",
    sample: 2,
    value: { intValue: "2" },
  },
  retry_attempts: {
    attribute: "llm.retry_attempts",
    sample: 5,
    value: { intValue: "5" },
  },
  leg_retries: { attribute: "llm.leg_retries", sample: 2, value: { intValue: "2" } },
  recovery_ms: {
    attribute: "llm.recovery_ms",
    sample: 201_900,
    value: { intValue: "201900" },
  },
  recovery_episode_id: {
    attribute: "llm.recovery_episode_id",
    sample: "3f2b9c14-5d6e-4a71-9b0c-8e2d4f6a1b33",
    value: { stringValue: "3f2b9c14-5d6e-4a71-9b0c-8e2d4f6a1b33" },
  },
  recovery_client_retry: {
    attribute: "llm.recovery_client_retry",
    sample: 3,
    value: { intValue: "3" },
  },
  recovery_outcome: {
    attribute: "llm.recovery_outcome",
    sample: "handoff",
    value: { stringValue: "handoff" },
  },
} satisfies Record<OptionalStatsKey, { attribute: string; sample: unknown; value: unknown }>;

const OPTIONAL_ENTRIES = Object.entries(OPTIONAL_WIRE) as Array<
  [OptionalStatsKey, { attribute: string; sample: unknown; value: unknown }]
>;

describe("eventToLogRecord — every optional field reaches the wire", () => {
  for (const [field, spec] of OPTIONAL_ENTRIES) {
    it(`emits ${spec.attribute} when ${field} is set`, () => {
      const record = eventToLogRecord({ ...SAMPLE_EVENT, [field]: spec.sample } as StatsEvent);
      const attr = record.attributes.find((a) => a.key === spec.attribute);
      expect(attr).toBeDefined();
      expect(attr?.value).toEqual(spec.value as any);
    });

    it(`omits ${spec.attribute} when ${field} is unset`, () => {
      // Deleting rather than assigning undefined: `{ ...e, x: undefined }` leaves
      // the KEY present, and the absent-key shape is the one production emits.
      const bare = { ...SAMPLE_EVENT } as Record<string, unknown>;
      delete bare[field];
      const record = eventToLogRecord(bare as unknown as StatsEvent);
      expect(record.attributes.some((a) => a.key === spec.attribute)).toBe(false);
    });
  }

  it("emits retry_attempts: 0 — zero is a fact, not an absence", () => {
    // The episode existed and this request added no re-issue to it. A truthiness
    // guard (`if (event.retry_attempts)`) instead of `!== undefined` deletes this
    // record's only evidence that recovery ran at all, and deletes it precisely
    // on the requests that were handed off with no budget left.
    const record = eventToLogRecord({
      ...SAMPLE_EVENT,
      retry_attempts: 0,
      recovery_ms: 0,
      recovery_client_retry: 0,
      recovery_episode_id: "3f2b9c14-5d6e-4a71-9b0c-8e2d4f6a1b33",
    });
    expect(record.attributes.find((a) => a.key === "llm.retry_attempts")?.value).toEqual({
      intValue: "0",
    } as any);
    expect(record.attributes.find((a) => a.key === "llm.recovery_client_retry")?.value).toEqual({
      intValue: "0",
    } as any);
  });

  it("a healthy request carries no recovery attributes at all", () => {
    // The other half of NFR-1: a machine that never loses its network sends the
    // same bytes it sent before this feature existed.
    const keys = eventToLogRecord(SAMPLE_EVENT).attributes.map((a) => a.key);
    expect(keys.filter((k) => k.startsWith("llm.recovery_"))).toEqual([]);
    expect(keys).not.toContain("llm.retry_attempts");
  });
});
