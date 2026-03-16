/**
 * Stats OTLP Formatter
 *
 * Converts StatsEvent arrays into OTLP ExportLogsServiceRequest JSON format.
 * Manual serialization — no SDK dependency.
 *
 * Wire format: OTLP JSON Logs
 * Signal type: LogRecord per request
 * Namespace: llm.* for custom attributes, standard OTel for resource/HTTP
 */

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
  adapter_name: string; // e.g., "GLMAdapter", "DefaultAdapter"
  middleware_names: string[]; // names only, no details

  // Fallback
  fallback_used: boolean;
  fallback_chain?: string[]; // provider names tried, in order
  fallback_attempts?: number; // how many failed before success

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
