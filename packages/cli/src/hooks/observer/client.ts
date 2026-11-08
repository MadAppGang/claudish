/**
 * The hook observer: a small LOCAL model that flags harness divergences the
 * declarative rules do not yet encode.
 *
 * Built on the services/vision-proxy.ts contract — hard timeout, `null` on any
 * failure, never throws, never blocks the request it advises on. If the local
 * daemon is down, the model is missing, the JSON is malformed, or the call times
 * out, the observer simply contributes nothing that turn.
 *
 * MODEL SELECTION IS DISCOVERED, NOT PINNED. The config may name a model; if it
 * does not, the smallest installed non-embedding Ollama model is used. No model
 * id is hardcoded anywhere in this file — a pinned default would rot the moment
 * the user's local library changed.
 */

import { log } from "../../logger.js";
import { fetchOllamaModels, ollamaBaseUrl } from "../../providers/ollama-discovery.js";
import type { HooksConfig } from "../config.js";
import type { ObserverDigest } from "./digest.js";

const DEFAULT_TIMEOUT_MS = 1_500;

/** The slice of the config the observer reads (`hooks.observer`). */
export type ObserverConfig = Pick<HooksConfig, "observer">;

export interface ObserverVerdict {
  /** A rule id from the digest's vocabulary, or null for "nothing to report". */
  ruleId: string | null;
  confidence: number;
  note?: string;
}

const SYSTEM_PROMPT = `You audit an AI coding agent for violations of Claude Code's conventions.
You receive a JSON digest: the tools available, detected harness state, and the tool call the agent proposes.
Decide whether the proposed call violates one of the rules listed in ruleVocabulary.

Reply with ONLY a JSON object, no prose:
{"ruleId": "<id from ruleVocabulary, or null>", "confidence": <0-1>, "note": "<short reason>"}

Return ruleId null unless you are confident. A false positive is worse than a miss.`;

/**
 * Floor below which a reported size cannot be a real set of local weights.
 *
 * Ollama lists CLOUD-hosted models alongside local ones, and a cloud entry is a
 * stub: `gemma4:31b-cloud` reports 312 BYTES. "Smallest wins" therefore picked a
 * 31B model served over the network, which promptly blew the observer's timeout
 * — measured live, 2026-08-02. The observer's whole premise is a fast local
 * model, so a stub must never win.
 */
const MIN_LOCAL_MODEL_BYTES = 50 * 1024 * 1024;

/** Reject cloud-hosted entries by both name and implausible size. */
function isGenuinelyLocal(model: { name: string; size?: number }): boolean {
  if (/[-:]cloud$/i.test(model.name)) return false;
  return (model.size ?? 0) >= MIN_LOCAL_MODEL_BYTES;
}

/** Resolved once per process — discovery costs an HTTP round trip. */
let cachedModel: string | null | undefined;

async function resolveObserverModel(config: ObserverConfig): Promise<string | null> {
  if (config.observer?.model) return config.observer.model;
  if (cachedModel !== undefined) return cachedModel;

  try {
    const models = await fetchOllamaModels({ enrichCapabilities: false });
    const usable = models.filter((m) => !m.isEmbeddingModel && isGenuinelyLocal(m));
    if (usable.length === 0) {
      log("[hooks:observer] No local Ollama models found — observer disabled for this run");
      cachedModel = null;
      return null;
    }
    // Smallest wins: the observer runs alongside a live request, so it has to be
    // cheap. A model with no reported size sorts last rather than winning by 0.
    usable.sort(
      (a, b) => (a.size ?? Number.MAX_SAFE_INTEGER) - (b.size ?? Number.MAX_SAFE_INTEGER)
    );
    cachedModel = usable[0].name;
    log(`[hooks:observer] Using discovered local model: ${cachedModel}`);
    return cachedModel;
  } catch (err) {
    log(`[hooks:observer] Model discovery failed, observer disabled: ${err}`);
    cachedModel = null;
    return null;
  }
}

/** Test seam: forget the discovered model so the next call re-resolves. */
export function resetObserverModelCache(): void {
  cachedModel = undefined;
}

/**
 * Ask the observer about a digest.
 *
 * @returns a verdict, or null when the observer is unavailable/unsure/malformed.
 */
export async function observe(
  digest: ObserverDigest,
  config: ObserverConfig
): Promise<ObserverVerdict | null> {
  const mode = config.observer?.mode ?? "suggest";
  if (config.observer?.enabled !== true || mode === "off") return null;

  const model = await resolveObserverModel(config);
  if (!model) return null;

  const timeoutMs = config.observer?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const response = await fetch(`${ollamaBaseUrl()}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model,
        stream: false,
        format: "json",
        options: { temperature: 0 },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(digest) },
        ],
      }),
    });
    if (!response.ok) {
      log(`[hooks:observer] HTTP ${response.status} — skipping`);
      return null;
    }

    const body: any = await response.json();
    const content = body?.message?.content;
    if (typeof content !== "string") return null;

    const parsed = JSON.parse(content);
    const ruleId = typeof parsed?.ruleId === "string" ? parsed.ruleId : null;

    // An id outside the vocabulary is a hallucination. Drop it rather than let
    // an invented rule name reach the engine or the divergence log.
    if (ruleId && !digest.ruleVocabulary.includes(ruleId)) {
      log(`[hooks:observer] Discarding unknown ruleId "${ruleId}"`);
      return null;
    }

    return {
      ruleId,
      confidence: typeof parsed?.confidence === "number" ? parsed.confidence : 0,
      note: typeof parsed?.note === "string" ? parsed.note : undefined,
    };
  } catch (err) {
    // Timeouts are the expected failure here, not an exceptional one.
    log(`[hooks:observer] Skipped: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
