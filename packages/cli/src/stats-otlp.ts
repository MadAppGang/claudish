/**
 * Stats OTLP Formatter
 *
 * Converts StatsEvent arrays into OTLP ExportLogsServiceRequest JSON format.
 * Manual serialization — no SDK dependency.
 *
 * Wire format: OTLP JSON Logs
 * Signal type: LogRecord per request
 * Namespace: llm.* for custom attributes, standard OTel for resource/HTTP
 *
 * ── THE ONE TRAP IN THIS FILE ────────────────────────────────────────────────
 *
 * `eventToLogRecord` below is a HAND-WRITTEN ALLOWLIST. A field added to
 * `StatsEvent` and populated by `stats.ts` but not pushed there is typed,
 * type-checked, buffered, and written to `~/.claudish/stats-buffer.json` — and
 * never leaves the machine. Nothing fails; the number is simply absent from
 * every dashboard that was built to read it. Add the push, and add a case to
 * `stats-otlp.test.ts`'s emit/omit table, which exists to make the omission
 * cost a red test instead of a silent quarter.
 */

import type { RecoveryOutcome } from "./recovery/coordinator.js";

// ─── Interfaces ───────────────────────────────────────────────────────────────

/**
 * A single usage stats event — one per LLM request.
 */
export interface StatsEvent {
  // Request identification
  timestamp: string; // ISO 8601 UTC

  // Model & Provider
  model_id: string; // sanitized (local models → <local-model>)
  provider_name: string; // e.g., "openrouter", "gemini", "ollama"
  stream_format: string; // e.g., "openai-sse", "gemini-sse"

  // Performance
  latency_ms: number; // request duration (performance.now() delta)
  success: boolean; // HTTP 2xx
  http_status: number; // response status code
  error_class?: string; // from classifyError() — only on failure
  error_code?: string; // from classifyError() — only on failure

  // Tokens & Cost
  input_tokens: number;
  output_tokens: number;
  estimated_cost: number; // USD from TokenTracker
  is_free_model: boolean;
  token_strategy: string; // "standard" | "delta-aware" | etc.

  // Transforms
  adapter_name: string; // e.g., "GLMModelDialect", "DefaultAPIFormat"
  middleware_names: string[]; // names only, no details

  // Fallback
  fallback_used: boolean;
  fallback_chain?: string[]; // provider names tried, in order
  fallback_attempts?: number; // how many failed before success

  // ── Network recovery ────────────────────────────────────────────────────────
  // Present only on a request that hit a classified connection failure. On every
  // healthy request all five are absent, and `eventToLogRecord` emits nothing
  // for them — so a machine that never loses its network sends exactly the
  // bytes it sent before this feature existed.

  /**
   * Connect retries THIS REQUEST made against the SAME provider.
   *
   * NOT `fallback_attempts`, which counts how many DIFFERENT providers were
   * tried. The two answer opposite questions and a chain that never advanced
   * can still have retried thirty times.
   *
   * Per-request, not per-episode: one episode can serve several concurrent
   * requests and can outlive any of them, so the episode's cumulative count
   * would over-report every request in it. `recovery_episode_id` is what joins
   * them back together.
   */
  retry_attempts?: number;

  /**
   * Ms of this request's own `latency_ms` spent inside the retry ladder —
   * backoff waits plus failed connects.
   *
   * `latency_ms` deliberately still INCLUDES that time (`adapters.md`: "the
   * honest figure is time-to-usable-response"). This field is what makes the
   * resulting skew explicable rather than mysterious: `latency_ms: 246_000,
   * recovery_ms: 201_900` reads as a 44-second turn behind a three-and-a-half
   * minute outage. Without it, the same record reads as a four-minute model.
   */
  recovery_ms?: number;

  /**
   * The episode this request belonged to — the correlation id, and the only
   * field that makes "how often does recovery happen" answerable.
   *
   * One outage is one episode and may span several requests (each tier-2
   * handoff is a new request re-entering the same episode), so counting
   * records over-counts outages by the retry factor.
   * `count(distinct recovery_episode_id)` is the honest figure.
   *
   * A request that hits BOTH an auth-path episode and a fetch-path episode
   * carries the id of the one that DECIDED ITS STATUS. An auth episode that
   * recovered has no record of its own: its attempts fold into this request's
   * `retry_attempts` and its waits into this request's `recovery_ms`, because
   * there is exactly one record per request.
   */
  recovery_episode_id?: string;

  /** Which tier-2 re-entry this request is. 0 = the original request. */
  recovery_client_retry?: number;

  /** How the episode ended for this request. */
  recovery_outcome?: RecoveryOutcome;

  /**
   * Upstream legs this Responses turn RE-ISSUED inside the same downstream
   * message (a degenerate `parallel` wrapper or a stalled leg; see
   * `responses-turn.ts`). Absent on a turn that needed no retry. The earlier
   * legs' billed input is already inside `estimated_cost`.
   */
  leg_retries?: number;

  /**
   * Who issued the request. `"advisor"` marks an `--advisor` panel or collector
   * call, made by claudish itself rather than by Claude Code; absent on every
   * main request. `estimated_cost` keeps one meaning for both: the emitting
   * handler's running total, so a launch's advisor spend is the largest
   * `estimated_cost` per `(model_id, provider_name)` with this field set.
   */
  request_role?: "advisor";

  // Invocation
  invocation_mode: string; // "profile" | "explicit-model" | "auto-route" | "env-var" | "model-map"

  // Environment (set once at init, same for all events in session)
  platform: string; // process.platform
  arch: string; // process.arch
  timezone: string; // full IANA timezone
  runtime: string; // e.g., "bun-1.2", "node-22"
  install_method: string; // "npm" | "homebrew" | "bun" | "binary"
  claudish_version: string;
}

/**
 * Consent state for anonymous usage stats. Persisted to config.json.
 */
export interface StatsConsent {
  /** Explicit opt-in. Default: false (disabled until user says yes). */
  enabled: boolean;
  /** ISO 8601 UTC of when the user first responded to consent. */
  enabledAt?: string;
  /** ISO 8601 UTC of last monthly banner shown. */
  lastMonthlyPrompt?: string;
  /** ISO 8601 UTC of last successful batch send. */
  lastSentAt?: string;
  /** Claudish version when first prompted. */
  promptedVersion?: string;
}

// ─── OTLP Internal Types ──────────────────────────────────────────────────────

interface OtlpStringAttr {
  key: string;
  value: { stringValue: string };
}

interface OtlpIntAttr {
  key: string;
  value: { intValue: string };
}

interface OtlpDoubleAttr {
  key: string;
  value: { doubleValue: number };
}

interface OtlpBoolAttr {
  key: string;
  value: { boolValue: boolean };
}

interface OtlpArrayAttr {
  key: string;
  value: { arrayValue: { values: Array<{ stringValue: string }> } };
}

type OtlpAttr = OtlpStringAttr | OtlpIntAttr | OtlpDoubleAttr | OtlpBoolAttr | OtlpArrayAttr;

interface OtlpLogRecord {
  timeUnixNano: string;
  severityNumber: number;
  severityText: string;
  body: { stringValue: string };
  attributes: OtlpAttr[];
}

export interface OtlpResource {
  version: string;
  platform: string;
  arch: string;
  runtime: string;
  installMethod: string;
  timezone: string;
}

// ─── Attribute Builders ───────────────────────────────────────────────────────

function stringAttr(key: string, value: string): OtlpStringAttr {
  return { key, value: { stringValue: value } };
}

function intAttr(key: string, value: number): OtlpIntAttr {
  return { key, value: { intValue: String(Math.round(value)) } };
}

function doubleAttr(key: string, value: number): OtlpDoubleAttr {
  return { key, value: { doubleValue: value } };
}

function boolAttr(key: string, value: boolean): OtlpBoolAttr {
  return { key, value: { boolValue: value } };
}

function arrayAttr(key: string, values: string[]): OtlpArrayAttr {
  return {
    key,
    value: {
      arrayValue: {
        values: values.map((v) => ({ stringValue: v })),
      },
    },
  };
}

// ─── Resource Builder ─────────────────────────────────────────────────────────

/**
 * Build the shared OTLP Resource attributes object.
 * Resource attributes are shared across all LogRecords in a batch.
 */
export function buildResource(res: OtlpResource): OtlpAttr[] {
  // Parse runtime into name and version (e.g., "bun-1.2" → name="bun", version="1.2")
  const dashIdx = res.runtime.indexOf("-");
  const runtimeName = dashIdx !== -1 ? res.runtime.slice(0, dashIdx) : res.runtime;
  const runtimeVersion = dashIdx !== -1 ? res.runtime.slice(dashIdx + 1) : "unknown";

  return [
    stringAttr("service.name", "claudish"),
    stringAttr("service.version", res.version),
    stringAttr("host.arch", res.arch),
    stringAttr("os.type", res.platform),
    stringAttr("process.runtime.name", runtimeName),
    stringAttr("process.runtime.version", runtimeVersion),
    stringAttr("claudish.install_method", res.installMethod),
    stringAttr("claudish.timezone", res.timezone),
  ];
}

// ─── Log Record Converter ─────────────────────────────────────────────────────

/**
 * Convert a single StatsEvent to an OTLP LogRecord.
 *
 * timeUnixNano: OTel spec requires nanosecond timestamps as string type.
 * Uses ISO timestamp parsed to milliseconds × 1_000_000 for nanoseconds.
 */
export function eventToLogRecord(event: StatsEvent): OtlpLogRecord {
  const tsMs = new Date(event.timestamp).getTime();
  const timeUnixNano = String(tsMs * 1_000_000);

  const attributes: OtlpAttr[] = [
    stringAttr("llm.model", event.model_id),
    stringAttr("llm.provider", event.provider_name),
    stringAttr("llm.stream_format", event.stream_format),
    intAttr("llm.latency_ms", event.latency_ms),
    boolAttr("llm.success", event.success),
    intAttr("http.status_code", event.http_status),
    intAttr("llm.input_tokens", event.input_tokens),
    intAttr("llm.output_tokens", event.output_tokens),
    doubleAttr("llm.estimated_cost_usd", event.estimated_cost),
    boolAttr("llm.is_free", event.is_free_model),
    stringAttr("llm.token_strategy", event.token_strategy),
    stringAttr("llm.adapter", event.adapter_name),
    arrayAttr("llm.middleware", event.middleware_names),
    boolAttr("llm.fallback_used", event.fallback_used),
    stringAttr("llm.invocation_mode", event.invocation_mode),
  ];

  // Optional error fields — only on failure
  if (event.error_class !== undefined) {
    attributes.push(stringAttr("llm.error_class", event.error_class));
  }
  if (event.error_code !== undefined) {
    attributes.push(stringAttr("llm.error_code", event.error_code));
  }

  // Optional fallback fields
  if (event.fallback_chain !== undefined && event.fallback_chain.length > 0) {
    attributes.push(arrayAttr("llm.fallback_chain", event.fallback_chain));
  }
  if (event.fallback_attempts !== undefined) {
    attributes.push(intAttr("llm.fallback_attempts", event.fallback_attempts));
  }

  // Optional network-recovery fields. THIS IS THE STEP WHOSE OMISSION IS
  // SILENT — see the file header. Each is emitted only when set, so a healthy
  // request's record is byte-identical to what it was before recovery existed.
  if (event.retry_attempts !== undefined) {
    attributes.push(intAttr("llm.retry_attempts", event.retry_attempts));
  }
  if (event.recovery_ms !== undefined) {
    attributes.push(intAttr("llm.recovery_ms", event.recovery_ms));
  }
  if (event.recovery_episode_id !== undefined) {
    attributes.push(stringAttr("llm.recovery_episode_id", event.recovery_episode_id));
  }
  if (event.recovery_client_retry !== undefined) {
    attributes.push(intAttr("llm.recovery_client_retry", event.recovery_client_retry));
  }
  if (event.recovery_outcome !== undefined) {
    attributes.push(stringAttr("llm.recovery_outcome", event.recovery_outcome));
  }
  if (event.leg_retries !== undefined) {
    attributes.push(intAttr("llm.leg_retries", event.leg_retries));
  }
  if (event.request_role !== undefined) {
    attributes.push(stringAttr("llm.request_role", event.request_role));
  }

  return {
    timeUnixNano,
    severityNumber: 9, // INFO
    severityText: "INFO",
    body: { stringValue: "llm.request" },
    attributes,
  };
}

// ─── Batch Formatter ──────────────────────────────────────────────────────────

/**
 * Convert an array of StatsEvents to an OTLP ExportLogsServiceRequest JSON string.
 *
 * Batching strategy: all events share one resource (claudish version, OS, runtime
 * don't change within a session). Only one resourceLogs entry per batch.
 */
export function formatOtlpBatch(events: StatsEvent[], resource: OtlpResource): string {
  if (events.length === 0) {
    return JSON.stringify({ resourceLogs: [] });
  }

  const resourceAttributes = buildResource(resource);
  const logRecords = events.map(eventToLogRecord);

  const payload = {
    resourceLogs: [
      {
        resource: {
          attributes: resourceAttributes,
        },
        scopeLogs: [
          {
            scope: {
              name: "claudish.stats",
              version: "1",
            },
            logRecords,
          },
        ],
      },
    ],
  };

  return JSON.stringify(payload);
}
