/**
 * The one call compaction makes: a key-signed POST to the Anthropic Messages
 * endpoint.
 *
 * - The URL is the module constant `ANTHROPIC_MESSAGES_URL`; no caller can
 *   change it, and a redirect is refused (`redirect: "error"`), so the key
 *   reaches no other URL.
 * - It signs with `x-api-key` (the key resolved at startup) and
 *   `anthropic-version` only. It never reads the inbound request: not its
 *   `authorization`, not its `x-api-key`, not the Claude login.
 * - The `system` prompt is claudish's own plain string. No Claude Code
 *   identity text is sent.
 * - Every upstream text it logs or returns passes `redactForClient` and then
 *   `redactExactValues` over the key, both on the raw body and again on the
 *   decoded answer and error message, and the key is on a signing lease for
 *   the life of the launch.
 * - A 429 "Error" shape refusal (`isClaudeShapeRefusal`) is a final failure,
 *   never retried. Nothing here retries.
 * - Three 401 answers in one launch switch the client off, with one warning.
 * - Every call sent records one stats event (`request_role: "compaction"`),
 *   priced with `calculateCost("anthropic", ...)`.
 */

import { ANTHROPIC_MESSAGES_URL } from "../handlers/advisor-claude-route.js";
import { isClaudeShapeRefusal } from "../handlers/native-handler-advisor.js";
import { calculateCost } from "../handlers/shared/remote-provider-types.js";
import { log, logStderr } from "../logger.js";
import type { WireValue } from "../providers/connection-wire.js";
import { redactExactValues, redactForClient } from "../redact.js";
import type { StatsEvent } from "../stats-otlp.js";
import { recordStats } from "../stats.js";

/** The `anthropic-version` header every compaction call sends. */
export const COMPACTION_ANTHROPIC_VERSION = "2023-06-01";

/** 401 answers in one launch after which compaction is switched off. */
export const COMPACTION_MAX_UNAUTHORIZED = 3;

/** One request to the model. */
export interface CompactionCallRequest {
  /** claudish's own system prompt, a plain string. */
  system: string;
  /** The single user message. */
  user: string;
  maxTokens: number;
  /** Abort the call after this many milliseconds. */
  timeoutMs: number;
  /** For log lines: what the call is for. */
  purpose: string;
  /** A JSON schema the answer must follow (`output_config.format`). */
  schema?: Record<string, unknown>;
  /**
   * Text sent before `user` in its own block with a cache marker, so a
   * prefix repeated across calls is read from the cache once it is long
   * enough to be cached.
   */
  cachedPrefix?: string;
}

export type CompactionCallResult =
  | {
      ok: true;
      text: string;
      usage: { input_tokens: number; output_tokens: number };
    }
  | {
      ok: false;
      /** Why there is no usable text. Safe to log: redacted. */
      reason: string;
      /** The upstream status, when one was received. */
      status?: number;
      /** True for the 429 "Error" shape refusal. */
      shapeRefusal?: boolean;
      /**
       * True when the call was cut short by `close()` (proxy shutdown). Not a
       * decision about the input: the caller records nothing.
       */
      cancelled?: boolean;
    };

export interface CompactionClientOptions {
  /** The Anthropic API key. Held in memory only. */
  apiKey: string;
  /** The resolved Anthropic model id. */
  model: string;
  /**
   * The `output_config.effort` value, from the catalog wire
   * (`compactionEffort`). A function is called on every request, so a catalog
   * written after startup (a first run) sets the effort of the next call.
   * Absent, or a function that answers undefined: no effort field is sent.
   */
  effort?: WireValue | (() => WireValue | undefined);
  /** Test seam; defaults to the global fetch at call time. */
  fetchImpl?: typeof fetch;
  /** Where the one switch-off warning goes. Defaults to `logStderr`. */
  warn?: (message: string) => void;
  /** Where stats events go. Defaults to `recordStats`. */
  record?: (event: Partial<StatsEvent>) => void;
}

export class CompactionClient {
  private unauthorized = 0;
  private off = false;
  private shut = false;
  /** The abort controllers of the calls in flight, for `close()`. */
  private readonly inFlight = new Set<AbortController>();
  /** Running spend and output tokens for the stats event, as the advisor reports its own. */
  private spend = 0;
  private outputTokens = 0;
  /** The effort the last effort log line named; a sentinel before the first call. */
  private loggedEffort: WireValue | undefined | null = null;

  constructor(private readonly opts: CompactionClientOptions) {}

  /** The effort for this request; logged on the first call and when it changes. */
  private effortNow(): WireValue | undefined {
    const source = this.opts.effort;
    const effort = typeof source === "function" ? source() : source;
    if (effort !== this.loggedEffort) {
      this.loggedEffort = effort;
      log(
        effort === undefined
          ? `[compaction] output_config.effort not sent: the catalog publishes no effort for ${this.opts.model} (yet)`
          : `[compaction] output_config.effort sent: ${JSON.stringify(effort)}, from the catalog wire of ${this.opts.model}`
      );
    }
    return effort;
  }

  /** The model id this client calls. */
  get model(): string {
    return this.opts.model;
  }

  /** True once three 401s switched compaction off for this launch. */
  get disabled(): boolean {
    return this.off;
  }

  /** True once `close()` ran. */
  get closed(): boolean {
    return this.shut;
  }

  /**
   * Abort every call in flight and refuse new ones. Each aborted call answers
   * `{ ok: false, cancelled: true }`. For proxy shutdown.
   */
  close(): void {
    this.shut = true;
    for (const controller of this.inFlight) controller.abort();
    this.inFlight.clear();
  }

  /** Send one request. Never rejects. */
  async complete(req: CompactionCallRequest): Promise<CompactionCallResult> {
    if (this.shut) {
      return { ok: false, reason: "compaction is shut down", cancelled: true };
    }
    if (this.off) {
      return { ok: false, reason: "compaction is off for this launch after repeated 401 answers" };
    }
    const timeoutMs = Math.max(1, Math.floor(req.timeoutMs));
    const effort = this.effortNow();
    const outputConfig = {
      ...(effort === undefined ? {} : { effort }),
      ...(req.schema ? { format: { type: "json_schema", schema: req.schema } } : {}),
    };
    const body = {
      model: this.opts.model,
      system: req.system,
      messages: [
        {
          role: "user",
          content:
            req.cachedPrefix === undefined
              ? req.user
              : [
                  { type: "text", text: req.cachedPrefix, cache_control: { type: "ephemeral" } },
                  { type: "text", text: req.user },
                ],
        },
      ],
      max_tokens: req.maxTokens,
      ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
    };
    const controller = new AbortController();
    this.inFlight.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    try {
      const request = new Request(ANTHROPIC_MESSAGES_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.opts.apiKey,
          "anthropic-version": COMPACTION_ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        // A redirect would carry x-api-key to the redirect target: refuse it.
        redirect: "error",
      });
      log(
        `[compaction] Calling API: ${request.url} (purpose: ${req.purpose}, model: ${this.opts.model}, auth: x-api-key)`
      );
      let resp: Response;
      try {
        resp = await (this.opts.fetchImpl ?? fetch)(request);
      } catch (err) {
        if (this.shut) return this.cancelled(req);
        const reason = controller.signal.aborted
          ? `no answer within ${timeoutMs} ms`
          : `request failed: ${this.redact(err instanceof Error ? err.message : String(err))}`;
        log(`[compaction] ${req.purpose}: ${reason}`);
        this.recordCall(0, elapsed());
        return { ok: false, reason };
      }
      let raw: string;
      try {
        raw = await resp.text();
      } catch {
        if (this.shut) return this.cancelled(req);
        const reason = controller.signal.aborted
          ? `no complete answer within ${timeoutMs} ms`
          : `HTTP ${resp.status} but the body could not be read`;
        log(`[compaction] ${req.purpose}: ${reason}`);
        this.recordCall(resp.status, elapsed());
        return { ok: false, reason, status: resp.status };
      }
      const text = this.redact(raw);
      if (!resp.ok) {
        return this.failure(req, resp, text, elapsed());
      }
      return this.success(req, resp.status, text, elapsed());
    } finally {
      clearTimeout(timer);
      this.inFlight.delete(controller);
    }
  }

  private cancelled(req: CompactionCallRequest): CompactionCallResult {
    log(`[compaction] ${req.purpose}: cancelled at shutdown`);
    return { ok: false, reason: "cancelled at shutdown", cancelled: true };
  }

  private redact(text: string): string {
    return redactExactValues(redactForClient(text), [this.opts.apiKey]);
  }

  private failure(
    req: CompactionCallRequest,
    resp: Response,
    text: string,
    latencyMs: number
  ): CompactionCallResult {
    this.recordCall(resp.status, latencyMs);
    if (isClaudeShapeRefusal(resp.status, text, resp.headers)) {
      log(
        `[compaction] ${req.purpose}: Anthropic refused the request shape (429 "Error"); not retried`
      );
      return {
        ok: false,
        status: resp.status,
        shapeRefusal: true,
        reason: `HTTP 429 rate_limit_error "Error" with no unified rate-limit headers; not retried`,
      };
    }
    if (resp.status === 401) {
      this.unauthorized += 1;
      if (this.unauthorized >= COMPACTION_MAX_UNAUTHORIZED && !this.off) {
        this.off = true;
        (this.opts.warn ?? logStderr)(
          `[compaction] the Anthropic API key was refused ${this.unauthorized} times (HTTP 401); compaction is off for the rest of this session`
        );
      }
    }
    // The decoded message is redacted again: JSON escapes can spell the key.
    const reason = `HTTP ${resp.status}: ${this.redact(summarize(text))}`;
    log(`[compaction] ${req.purpose}: ${reason}`);
    return { ok: false, status: resp.status, reason };
  }

  private success(
    req: CompactionCallRequest,
    status: number,
    text: string,
    latencyMs: number
  ): CompactionCallResult {
    let data: {
      content?: Array<{ type?: unknown; text?: unknown }>;
      usage?: { input_tokens?: unknown; output_tokens?: unknown };
      stop_reason?: unknown;
    };
    try {
      data = JSON.parse(text);
    } catch {
      this.recordCall(status, latencyMs);
      log(`[compaction] ${req.purpose}: HTTP ${status} but the body is not JSON`);
      return { ok: false, status, reason: `HTTP ${status} but the body is not JSON` };
    }
    const usage = {
      input_tokens: typeof data.usage?.input_tokens === "number" ? data.usage.input_tokens : 0,
      output_tokens: typeof data.usage?.output_tokens === "number" ? data.usage.output_tokens : 0,
    };
    this.recordCall(status, latencyMs, usage);
    // Redacted again after decoding and joining: a key split across two text
    // blocks, or written with JSON escapes, is whole only now.
    const answer = this.redact(
      (Array.isArray(data.content) ? data.content : [])
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("")
    ).trim();
    if (data.stop_reason === "max_tokens") {
      log(`[compaction] ${req.purpose}: the answer reached max_tokens and is incomplete`);
      return { ok: false, status, reason: "the answer reached max_tokens and is incomplete" };
    }
    // Only a finished answer is usable. A refusal, a paused turn or a missing
    // stop_reason can carry text that is not a summary of the input.
    if (!COMPLETE_STOP_REASONS.has(data.stop_reason as string)) {
      const reason = `HTTP ${status} with stop_reason ${describeStopReason(data.stop_reason)}; the answer is not used`;
      log(`[compaction] ${req.purpose}: ${reason}`);
      return { ok: false, status, reason };
    }
    if (!answer) {
      log(`[compaction] ${req.purpose}: HTTP ${status} but the answer carried no text`);
      return { ok: false, status, reason: `HTTP ${status} but the answer carried no text` };
    }
    log(
      `[compaction] ${req.purpose}: HTTP ${status}, ${usage.input_tokens} in / ${usage.output_tokens} out tokens, ${latencyMs} ms`
    );
    return { ok: true, text: answer, usage };
  }

  /** One stats event per call sent. Never throws. */
  private recordCall(
    status: number,
    latencyMs: number,
    usage?: { input_tokens: number; output_tokens: number }
  ): void {
    try {
      const success = status >= 200 && status < 300;
      if (success && usage) {
        this.spend += calculateCost(
          "anthropic",
          this.opts.model,
          usage.input_tokens,
          usage.output_tokens
        );
        this.outputTokens += usage.output_tokens;
      }
      (this.opts.record ?? recordStats)({
        model_id: this.opts.model,
        provider_name: "anthropic",
        stream_format: "anthropic-messages",
        latency_ms: latencyMs,
        success,
        http_status: status,
        input_tokens: success && usage ? usage.input_tokens : 0,
        output_tokens: success && usage ? this.outputTokens : 0,
        estimated_cost: this.spend,
        is_free_model: this.spend === 0,
        token_strategy: "standard",
        adapter_name: "none",
        fallback_used: false,
        request_role: "compaction",
      });
    } catch {
      // stats never break a compaction call
    }
  }
}

/** The `stop_reason` values of a finished answer. */
const COMPLETE_STOP_REASONS: ReadonlySet<string> = new Set(["end_turn", "stop_sequence"]);

/** A `stop_reason` for a log line: a short string as is, anything else by type. */
function describeStopReason(value: unknown): string {
  if (value === undefined || value === null) return "missing";
  if (typeof value === "string" && /^[a-z_]{1,40}$/.test(value)) return `"${value}"`;
  return `of type ${typeof value}`;
}

/** The `error.message` of an Anthropic error body, else its first 300 characters. */
function summarize(text: string): string {
  try {
    const message = (JSON.parse(text) as { error?: { message?: unknown } }).error?.message;
    if (typeof message === "string" && message) return message.slice(0, 300);
  } catch {
    // not JSON
  }
  return text.slice(0, 300);
}
