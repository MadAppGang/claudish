/**
 * Anthropic-Compatible ProviderTransport
 *
 * Handles communication with providers that speak native Anthropic API format
 * (MiniMax, Kimi, Kimi Coding, Z.AI). Auth uses x-api-key header with
 * anthropic-version, plus Kimi OAuth fallback for kimi-coding.
 */

import { credentials } from "../../auth/credentials/authority.js";
import type { RemoteProvider } from "../../handlers/shared/remote-provider-types.js";
import { log } from "../../logger.js";
import {
  describeDiscoveryFailure,
  discoverProviderModels,
  getDiscoveryFailure,
  rankDiscoveredModels,
} from "../model-discovery.js";
import { getProviderByName } from "../provider-definitions.js";
import { isTerminal429 } from "./openai.js";
import { type DiscoveryOutcome, isChatCapable } from "./probe-discovery.js";
import type { ProviderTransport, StreamFormat } from "./types.js";

export class AnthropicProviderTransport implements ProviderTransport {
  readonly name: string;
  readonly displayName: string;
  readonly streamFormat: StreamFormat = "anthropic-sse";

  private provider: RemoteProvider;
  private apiKey: string;

  constructor(provider: RemoteProvider, apiKey: string) {
    this.provider = provider;
    this.apiKey = apiKey;
    this.name = provider.name;
    this.displayName = AnthropicProviderTransport.formatDisplayName(provider.name);
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
      headers.Authorization = `Bearer ${this.apiKey}`;
    } else {
      headers["x-api-key"] = this.apiKey;
    }

    // Add provider-specific headers
    if (this.provider.headers) {
      Object.assign(headers, this.provider.headers);
    }

    // Kimi Coding: OAuth wins over API key when both are present.
    // Per kimi.com/code docs, the canonical auth path for the coding
    // subscription is OAuth (claudish login kimi). A stale or wrong
    // KIMI_CODING_API_KEY env var would otherwise produce 401 even
    // though the user has a valid OAuth token on disk.
    //
    // The transport no longer manages OAuth itself — it delegates to the
    // credential authority, which mints the OAuth artifact (anthropic-version +
    // Bearer token + the X-Msh-* platform headers) and applies the
    // OAuth_FALLBACK_TO_API_KEY → api-key fallback internally. On failure here
    // we keep the plain x-api-key path already populated above.
    if (this.provider.name === "kimi-coding") {
      try {
        const auth = await credentials.getRequestAuth("kimi-coding", { model: "" });
        // If the authority returned an OAuth Bearer, it replaces the api-key auth.
        if (auth.headers.Authorization) {
          delete headers["x-api-key"];
        }
        Object.assign(headers, auth.headers);
      } catch (e: any) {
        log(`[${this.displayName}] OAuth path failed, falling back to API key: ${e.message}`);
      }
    }

    return headers;
  }

  /**
   * Discover a probe-friendly model from the provider's OWN authenticated
   * model list.
   *
   * Why this transport needs it at all: several Anthropic-compat providers are
   * SUBSCRIPTIONS (Qwen Plan, Kimi Coding). The cloud /probeModels
   * catalog fundamentally cannot know which models a given key is entitled to
   * — that is a property of the caller's plan, not of the provider — so the
   * TUI falls back to GET /v1/probe-discover, which requires this method.
   * Without it the Test column reads "no probe model: transport does not
   * support discovery" for every subscription provider.
   *
   * Source of truth is the provider's own `modelDiscovery` descriptor (already
   * declared by qwen-cloud and kimi-coding), reached through the shared
   * `discoverProviderModels()` — the same authenticated call the picker and
   * the context-window resolver use, so it shares their cache and their
   * credential-authority auth path. No new HTTP path is introduced here.
   *
   * Ordering: `rankDiscoveredModels()` (largest live context window first,
   * alphabetical tiebreak) — the same order the picker defaults to, so the
   * probe exercises the model the user would actually get.
   *
   * Non-chat rows are dropped with the shared `isChatCapable()` filter rather
   * than a per-provider skip list: qwen-cloud's roster mixes image/TTS models
   * (`wan2.7-image`, `qwen-audio-3.0-tts-plus`) in with the text models, and
   * hardcoding model ids here would rot the moment Alibaba ships the next one.
   */
  async discoverProbeModel(exclude?: ReadonlySet<string>): Promise<DiscoveryOutcome> {
    const def = getProviderByName(this.provider.name);
    if (!def?.modelDiscovery) {
      return {
        model: null,
        reason: `${this.displayName} publishes no live model list (no modelDiscovery endpoint) — its probe model must come from the cloud catalog`,
      };
    }

    const discovered = await discoverProviderModels(this.provider.name);
    if (discovered.length === 0) {
      // Prefer the REAL reason over the generic guess. This used to read
      // "check the API key and that the subscription is active" for every
      // failure mode — advice that is wrong for an unreachable endpoint and
      // unhelpfully vague for a rejected key, since Alibaba serves several
      // mutually-isolated plan hosts that reject each other's keys identically.
      const failure = getDiscoveryFailure(this.provider.name);
      return {
        model: null,
        reason: failure
          ? `${this.displayName}: ${describeDiscoveryFailure(failure)}`
          : `${this.displayName} listed no models at ${def.modelDiscovery.path} — check the API key and that the subscription is active`,
      };
    }

    // Rank by live capability first, then drop anything that can't answer a
    // chat probe (image / TTS / embedding rows).
    const ranked = rankDiscoveredModels(discovered)
      .map((m) => m.id)
      .filter(isChatCapable);
    if (ranked.length === 0) {
      return {
        model: null,
        reason: `no chat-capable model among the ${discovered.length} listed by ${this.displayName}`,
      };
    }

    // `exclude` carries the models this probe round already tried, so a
    // transient per-model failure advances to the next candidate instead of
    // failing the provider outright.
    const pick = ranked.find((m) => !exclude?.has(m));
    if (!pick) {
      return {
        model: null,
        reason: `all ${ranked.length} candidate model(s) already tried`,
      };
    }
    return { model: pick };
  }

  /**
   * Retry 429 responses with bounded backoff. Anthropic-compat providers
   * (Kimi, MiniMax, Z.AI) throttle aggressively; one quick retry helps
   * recover transient bursts. The retry budget is intentionally tight
   * (~3s worst case) so probe deadlines (typically 15s) don't get blown
   * by an extended retry chain — the probe surfaces 429 as a healthy
   * "throttled" signal instead.
   *
   * Terminal 429s (billing/quota) skip the retry chain — see isTerminal429
   * in transport/openai.ts for the patterns matched.
   */
  async enqueueRequest(fetchFn: () => Promise<Response>): Promise<Response> {
    const maxRetries = 2;
    let lastResponse: Response | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const response = await fetchFn();

      if (response.status === 429 && attempt < maxRetries) {
        const bodyText = await response
          .clone()
          .text()
          .catch(() => "");
        if (isTerminal429(bodyText)) {
          log(`[${this.displayName}] 429 is terminal (billing/quota), not retrying`);
          return response;
        }
        lastResponse = response;
        const retryAfter = response.headers.get("Retry-After");
        let delayMs: number;
        if (retryAfter && !Number.isNaN(Number(retryAfter))) {
          delayMs = Math.min(Number(retryAfter) * 1000, 2000);
        } else {
          // 500ms, 1000ms — quick recovery without blowing probe budget
          delayMs = 500 * (attempt + 1);
        }
        log(
          `[${this.displayName}] 429 rate limited, retry ${attempt + 1}/${maxRetries} in ${(delayMs / 1000).toFixed(1)}s`
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      return response;
    }

    return lastResponse!;
  }

  private static formatDisplayName(name: string): string {
    const map: Record<string, string> = {
      minimax: "MiniMax",
      "minimax-coding": "MiniMax Coding",
      kimi: "Kimi",
      "kimi-coding": "Kimi Coding",
      "qwen-cloud": "Qwen Plan",
      "qwen-payg": "Qwen PAYG",
      moonshot: "Kimi",
      "z-ai": "Z.AI",
    };
    return map[name.toLowerCase()] || name.charAt(0).toUpperCase() + name.slice(1);
  }
}

// Backward-compatible alias
/** @deprecated Use AnthropicProviderTransport */
export { AnthropicProviderTransport as AnthropicCompatProvider };
