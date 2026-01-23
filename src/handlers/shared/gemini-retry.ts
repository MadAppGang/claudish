/**
 * Gemini Retry Utilities
 *
 * Shared retry logic with exponential backoff for Gemini API rate limits.
 * Used by both GeminiHandler (API key) and GeminiCodeAssistHandler (OAuth).
 *
 * All requests are serialized through GeminiRequestQueue to prevent parallel
 * quota exhaustion. The queue handles rate limiting, while this module handles
 * individual request retries for non-429 errors.
 */

import { log } from "../../logger.js";
import { GeminiRequestQueue } from "./gemini-queue.js";

export interface RetryConfig {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface RetryResult {
  response: Response;
  attempts: number;
  lastErrorText?: string;
}

/**
 * Parse retry delay from Gemini 429 error response
 *
 * Gemini API returns retry hints in two formats:
 * 1. `retryDelay` field in error details (e.g., "3s", "1.5s")
 * 2. Message pattern "reset after Xs" (e.g., "quota will reset after 3s")
 */
export function parseRetryDelay(errorText: string, attempt: number, baseDelayMs: number): number {
  let waitMs = (attempt + 1) * baseDelayMs; // Default exponential backoff

  try {
    const errorData = JSON.parse(errorText);

    // Check for retryDelay in details array
    const retryDetail = errorData?.error?.details?.find((d: any) => d.retryDelay);
    if (retryDetail?.retryDelay) {
      // Parse "3s" or "1.5s" format
      const match = retryDetail.retryDelay.match(/(\d+(?:\.\d+)?)/);
      if (match) {
        waitMs = Math.ceil(parseFloat(match[1]) * 1000);
      }
    }

    // Also check message for "reset after Xs" pattern
    const msgMatch = errorData?.error?.message?.match(/reset after (\d+)s/);
    if (msgMatch) {
      waitMs = Math.max(waitMs, parseInt(msgMatch[1], 10) * 1000);
    }
  } catch {
    // JSON parse failed, use default backoff
  }

  return waitMs;
}

/**
 * Check if a 429 error is due to a terminal quota limit (daily quota)
 *
 * Terminal quotas (PerDay, Daily) should NOT be retried since they won't
 * reset within a reasonable retry window.
 *
 * Transient quotas (PerMinute, PerSecond) should be retried with backoff.
 *
 * @param errorText - The error response text from the API
 * @returns true if the quota limit is terminal (daily), false otherwise
 *
 * @example
 * // Daily quota - returns true
 * isTerminalQuotaLimit(JSON.stringify({
 *   error: {
 *     details: [{
 *       "@type": "type.googleapis.com/google.rpc.QuotaFailure",
 *       violations: [{ quotaId: "GenerateContentRequestsPerDayPerProject" }]
 *     }]
 *   }
 * }));
 *
 * @example
 * // Per-minute quota - returns false
 * isTerminalQuotaLimit(JSON.stringify({
 *   error: {
 *     details: [{
 *       "@type": "type.googleapis.com/google.rpc.QuotaFailure",
 *       violations: [{ quotaId: "GenerateContentRequestsPerMinutePerProjectPerRegion" }]
 *     }]
 *   }
 * }));
 */
export function isTerminalQuotaLimit(errorText: string): boolean {
  try {
    const errorData = JSON.parse(errorText);

    // Find QuotaFailure detail in error.details[]
    const quotaFailure = errorData?.error?.details?.find(
      (d: any) => d["@type"] === "type.googleapis.com/google.rpc.QuotaFailure"
    );

    if (!quotaFailure?.violations?.length) {
      return false; // No quota info, assume retriable
    }

    // Check first violation's quotaId
    const quotaId = quotaFailure.violations[0]?.quotaId || "";

    // Terminal patterns: PerDay, Daily (case-insensitive)
    const isTerminal = /PerDay|Daily/i.test(quotaId);

    if (isTerminal) {
      log(`[GeminiRetry] Detected terminal quota: ${quotaId}`);
    }

    return isTerminal;
  } catch {
    // JSON parse failed or missing fields → assume retriable (conservative)
    return false;
  }
}

/**
 * Fetch with retry logic for Gemini API rate limits (429 errors)
 *
 * All requests are serialized through GeminiRequestQueue to prevent parallel quota exhaustion.
 * The queue handles 429 rate limiting with dynamic delays based on quotaResetDelay.
 *
 * This function handles retries for non-429 errors (network errors, 500, 503, etc.).
 * Terminal quota limits (daily) are detected and fail immediately without retries.
 */
export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  config: RetryConfig = {},
  logPrefix = "[GeminiRetry]"
): Promise<RetryResult> {
  const { maxRetries = 5, baseDelayMs = 2000, maxDelayMs = 30000 } = config;

  // Get queue instance - only used for first attempt
  const queue = GeminiRequestQueue.getInstance();

  let response: Response | null = null;
  let lastErrorText = "";

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    log(`${logPrefix} Attempt ${attempt + 1}/${maxRetries}`);

    // FIRST attempt goes through queue (rate limiting + serialization)
    // RETRIES bypass queue (we've already been rate-limited, avoid duplicate entries)
    if (attempt === 0) {
      response = await queue.enqueue(() => fetch(url, options));
    } else {
      // Direct fetch for retries - queue already applied rate limiting
      response = await fetch(url, options);
    }

    if (response.status === 429) {
      lastErrorText = await response.text();
      log(`${logPrefix} Rate limit hit (attempt ${attempt + 1}): ${lastErrorText}`);

      // Check if this is a terminal quota limit (daily limit)
      if (isTerminalQuotaLimit(lastErrorText)) {
        log(`${logPrefix} Terminal quota limit detected (daily quota exhausted). Failing immediately.`);
        break; // Exit retry loop, return 429 to caller
      }

      // Don't retry on last attempt
      if (attempt === maxRetries - 1) {
        break;
      }

      // Parse retry delay from error response
      let waitMs = parseRetryDelay(lastErrorText, attempt, baseDelayMs);
      waitMs = Math.min(waitMs, maxDelayMs);

      log(`${logPrefix} Waiting ${waitMs}ms before retry...`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    // Non-429 response - return immediately
    return { response, attempts: attempt + 1 };
  }

  // Exhausted retries or final 429
  if (!response) {
    throw new Error("No response received from API");
  }

  return { response, attempts: maxRetries, lastErrorText };
}
