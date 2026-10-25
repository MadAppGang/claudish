/**
 * Anthropic-Compatible ProviderTransport
 *
 * Handles communication with providers that speak native Anthropic API format
 * (MiniMax, Kimi, Kimi Coding, Z.AI). Auth uses x-api-key header with
 * anthropic-version, plus Kimi OAuth fallback for kimi-coding.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ProviderTransport, StreamFormat } from "./types.js";
import type { RemoteProvider } from "../../handlers/shared/remote-provider-types.js";
import { LocalModelQueue } from "../../handlers/shared/local-queue.js";
import { ConcurrencyLimiter } from "../../handlers/shared/concurrency-limiter.js";
import { log } from "../../logger.js";
import { KimiOAuth } from "../../auth/kimi-oauth.js";
import { isQuotaWall } from "./quota-wall.js";
import { isConcurrencyRefusalResponse } from "../../handlers/shared/step-skip.js";

export class AnthropicProviderTransport implements ProviderTransport {
  readonly name: string;
  readonly displayName: string;
  readonly streamFormat: StreamFormat = "anthropic-sse";

  private provider: RemoteProvider;
  private apiKey: string;
  private maxConcurrency?: number;
  private limiter?: ConcurrencyLimiter;

  constructor(provider: RemoteProvider, apiKey: string, maxConcurrency?: number) {
    this.provider = provider;
    this.apiKey = apiKey;
    this.name = provider.name;
    this.maxConcurrency = maxConcurrency;
    this.displayName = AnthropicProviderTransport.formatDisplayName(provider.name);

    if (this.maxConcurrency !== undefined) {
      log(
        `[${this.displayName}] Concurrency: ${this.maxConcurrency === 0 ? "unlimited" : this.maxConcurrency}`
      );
    }
    // Per-instance cap (independent per provider — see ConcurrencyLimiter docs).
    // 0 = unlimited (no limiter). Gated by CLAUDISH_LOCAL_QUEUE_ENABLED.
    if (this.maxConcurrency !== undefined && this.maxConcurrency > 0 && LocalModelQueue.isEnabled()) {
      this.limiter = new ConcurrencyLimiter(this.maxConcurrency, this.displayName);
    }
  }

  getEndpoint(): string {
    return `${this.provider.baseUrl}${this.provider.apiPath}`;
  }

  /**
   * Honor the optional streamFormatOverride declared on the RemoteProvider.
   * Lets custom endpoints (e.g. qwen-token-plan serving an Anthropic-compatible
   * wire format for a Qwen-named model) win over the dialect's default choice.
   * No-op when unset — by default Anthropic-compat speaks anthropic-sse anyway.
   */
  overrideStreamFormat(): StreamFormat | undefined {
    return this.provider.streamFormatOverride;
  }

  async getHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      "anthropic-version": "2023-06-01",
    };

    if (this.provider.authScheme === "bearer") {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    } else {
      headers["x-api-key"] = this.apiKey;
    }

    // Add provider-specific headers
    if (this.provider.headers) {
      Object.assign(headers, this.provider.headers);
    }

    // Kimi Coding: prefer API key auth, fall back to OAuth if no key provided
    if (this.provider.name === "kimi-coding" && !this.apiKey) {
      try {
        const credPath = join(homedir(), ".claudish", "kimi-oauth.json");
        if (existsSync(credPath)) {
          const data = JSON.parse(readFileSync(credPath, "utf-8"));
          if (data.access_token && data.refresh_token) {
            const oauth = KimiOAuth.getInstance();
            const accessToken = await oauth.getAccessToken();

            // Replace API key auth with Bearer token
            delete headers["x-api-key"];
            headers["Authorization"] = `Bearer ${accessToken}`;

            // Add Kimi-specific platform headers
            const platformHeaders = oauth.getPlatformHeaders();
            Object.assign(headers, platformHeaders);
          }
        }
      } catch (e: any) {
        log(`[${this.displayName}] OAuth fallback failed: ${e.message}`);
      }
    }

    return headers;
  }

  /**
   * Retry HTTP 429 responses with jittered exponential backoff.
   *
   * The anthropic-compat providers (Z.AI, MiniMax, Kimi) previously had NO
   * transport-level retry at all — a bare 429 propagated straight up. This
   * mirrors OpenAIProviderTransport's retry but ADDS jitter: the whole cluster
   * shares a single key per provider, so without jitter every machine retries
   * on the same 2s/4s/8s boundary and re-collides on the burst limit. The
   * jitter spreads those retries out.
   *
   * Note: this only covers errors the provider returns as an HTTP 429. Z.AI's
   * burst limit is frequently delivered as HTTP 200 + an in-stream SSE error
   * ([1302]); that variant is handled one layer up in ComposedHandler (peek +
   * backoff-retry + cross-provider fallback), since it isn't visible from the
   * Response status alone.
   */
  async enqueueRequest(fetchFn: () => Promise<Response>, opts?: { busyWaitMs?: number }): Promise<Response> {
    // Gates the fetch, not the backoff sleep — see OpenAIProviderTransport for
    // the full rationale. A slot held across a backoff blocks the lane while the
    // backend is idle; here that matters most, because these providers share one
    // cluster-wide key and therefore throttle in synchronized bursts.
    // opts.busyWaitMs (#431): bounded queue wait — StepBusyError propagates to
    // ComposedHandler's skip response; undefined = today's unbounded FIFO.
    // CR S1: first admission only — the gate runs at every 429-retry
    // iteration, and a bound riding a retry surfaces as a skip for a request
    // the backend already 429'd (see OpenAIProviderTransport for the full text).
    let firstAdmission = true;
    const gate = (fn: () => Promise<Response>): Promise<Response> => {
      const budget = firstAdmission ? opts?.busyWaitMs : undefined;
      firstAdmission = false;
      return this.limiter ? this.limiter.run(fn, budget) : fn();
    };

    const runWith429Retry = async (): Promise<Response> => {
      const maxRetries = 5;
      let lastResponse: Response | null = null;
      let sleptMs = 0;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const response = await gate(fetchFn);

        if (response.status === 429 && attempt < maxRetries) {
          lastResponse = response;
          // A wall will still be a wall after the ladder — give up now so the
          // caller's deadline is not spent asleep. Bursts still retry (narrow predicate).
          if (await isQuotaWall(response, this.displayName)) return response;
          // #679 — a plan-concurrency refusal (z.ai 1302) also gives up now,
          // for the mirror reason: the slot frees in seconds, sleeping 2s..30s
          // against a busy SHARED plan burns the caller's deadline and ends at
          // the fetch abort, which destroys the body the cascade needs to skip
          // on. The 429 surfaces intact; ComposedHandler annotates it busy.
          if (await isConcurrencyRefusalResponse(response)) return response;
          const retryAfter = response.headers.get("Retry-After");
          let delayMs: number;
          if (retryAfter && !Number.isNaN(Number(retryAfter))) {
            delayMs = Math.min(Number(retryAfter) * 1000, 30000);
          } else {
            // Exponential backoff: 2s, 4s, 8s, 16s, 30s (capped)
            delayMs = Math.min(2000 * Math.pow(2, attempt), 30000);
          }
          // Jitter: spread cluster-wide synchronized retries off the same boundary.
          const jitterMs = Math.floor(Math.random() * 1000);
          const totalMs = delayMs + jitterMs;
          log(
            `[${this.displayName}] 429 rate limited, retry ${attempt + 1}/${maxRetries} in ${(totalMs / 1000).toFixed(1)}s`
          );
          await new Promise((resolve) => setTimeout(resolve, totalMs));
          sleptMs += totalMs;
          continue;
        }

        // Out of retries. `attempt < maxRetries` above is what sends a 429 back
        // round, so a 429 arriving HERE can only mean the ladder is spent — and
        // this exit was completely silent. The per-retry lines are debug-level
        // and never reach stdout, so `sleptMs` of sleeping against something
        // that never moved left no trace anywhere in the log; diagnosing one
        // cost a timing-correlation study across 28.5h of traffic (2026-08-25).
        //
        // At most one forced line per affected request, mutually exclusive with
        // the quota-wall short-circuit above — so WHICH line appears is how you
        // tell from outside whether that short-circuit fired.
        if (response.status === 429) {
          log(
            `[${this.displayName}] 429 ladder exhausted after ${maxRetries} retries / ` +
              `${(sleptMs / 1000).toFixed(1)}s asleep — returning the last 429`,
            true
          );
        }

        return response;
      }

      // UNREACHABLE — see OpenAIProviderTransport for the full note. The loop's
      // last iteration fails the retry guard and leaves through `return response`,
      // so nothing ever falls out of the bottom. Kept for the return type only.
      return lastResponse!;
    };

    // Capacity-limited backend — per-instance cap so parallel large prefills can't
    // wedge the engine (and a slow remote provider can't pile up unbounded streams).
    // Independent per provider. Gating is per attempt inside the loop above.
    // Unset maxConcurrency = unbounded (unchanged behavior).
    return runWith429Retry();
  }

  // Public static: the overflow-caps purge (#660 r2) must derive the SAME key
  // the handler records (`transport.displayName`), and duplicating this map
  // anywhere else would drift the day it changes.
  static formatDisplayName(name: string): string {
    const map: Record<string, string> = {
      minimax: "MiniMax",
      "minimax-coding": "MiniMax Coding",
      kimi: "Kimi",
      "kimi-coding": "Kimi Coding",
      moonshot: "Kimi",
      zai: "Z.AI",
    };
    return map[name.toLowerCase()] || name.charAt(0).toUpperCase() + name.slice(1);
  }
}

// Backward-compatible alias
/** @deprecated Use AnthropicProviderTransport */
export { AnthropicProviderTransport as AnthropicCompatProvider };
