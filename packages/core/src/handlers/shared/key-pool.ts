/**
 * Key Pool - API Key Rotation with Automatic Failover
 *
 * Provides round-robin rotation across multiple API keys from a single
 * environment variable (comma-separated). Handles transparent failover
 * when keys return errors (especially 429 rate limits).
 *
 * Example env var:
 *   export GEMINI_API_KEY="key1,key2,key3"
 *   export OPENAI_API_KEY="sk-abc123, sk-def456"
 */

import { log } from "../../logger.js";

/**
 * HTTP status codes that trigger key rotation/failover.
 * Rotate when another key could plausibly help; propagate immediately otherwise.
 */
const ROTATABLE_STATUS_CODES = new Set([
  // Key-related: different key may authenticate/have credits/permissions
  401, 402, 403,
  // Transient: may succeed on retry
  408, 429,
  // Server-side transient
  500, 502, 503, 504,
]);

/**
 * KeyPool - manages rotation and failover for multiple API keys
 */
export class KeyPool {
  private keys: string[];
  private currentIndex: number = 0;
  private readonly providerName: string;

  /**
   * Create a KeyPool from a comma-separated key string
   *
   * @param keyString - Comma-separated API keys (e.g., "key1,key2,key3" or "key1, key2, key3")
   * @param providerName - Name for logging (e.g., "Gemini", "OpenAI")
   */
  constructor(keyString: string, providerName: string) {
    this.providerName = providerName;

    if (!keyString || !keyString.trim()) {
      this.keys = [];
      return;
    }

    // Split by comma and trim whitespace from each key
    this.keys = keyString
      .split(",")
      .map((k) => k.trim())
      .filter((k) => k.length > 0);

    if (this.keys.length > 1) {
      log(`[KeyPool:${providerName}] Initialized with ${this.keys.length} keys`);
    }
  }

  /**
   * Check if the key pool has any keys configured
   */
  hasKeys(): boolean {
    return this.keys.length > 0;
  }

  /**
   * Get the number of keys in the pool
   */
  keyCount(): number {
    return this.keys.length;
  }

  /**
   * Get the current key (for single-key mode compatibility)
   */
  getCurrentKey(): string {
    return this.keys[this.currentIndex] || "";
  }

  /**
   * Get the next key in round-robin rotation
   * Does NOT advance the index - use advanceIndex() after successful request
   */
  peekNextKey(): string {
    if (this.keys.length === 0) {
      return "";
    }
    return this.keys[this.currentIndex];
  }

  /**
   * Advance to the next key in rotation
   */
  private advanceIndex(): void {
    if (this.keys.length > 0) {
      this.currentIndex = (this.currentIndex + 1) % this.keys.length;
    }
  }

  /**
   * Reset to first key (called on proxy restart)
   */
  reset(): void {
    this.currentIndex = 0;
    log(`[KeyPool:${this.providerName}] Reset to first key`);
  }

  /**
   * Check if a response status should trigger key rotation
   */
  private shouldRotateOnStatus(status: number): boolean {
    return ROTATABLE_STATUS_CODES.has(status);
  }

  /**
   * Execute a fetch request with automatic key failover
   *
   * On retryable errors (429, 500, etc.), automatically rotates to the next key
   * and retries. Only propagates the error after all keys have been tried.
   *
   * When all keys fail with HTTP errors, returns the last failed Response
   * (preserving status, headers, and body for the caller to handle).
   * When all keys fail with network errors (thrown exceptions), re-throws the last error.
   *
   * @param fetchFn - Function that takes a key and returns a Response promise
   * @returns The successful Response, or the last failed Response if all keys returned HTTP errors
   * @throws The last error if all keys fail with network errors
   */
  async executeWithFailover<T extends Response>(
    fetchFn: (key: string) => Promise<T>
  ): Promise<T> {
    if (this.keys.length === 0) {
      throw new Error(`[KeyPool:${this.providerName}] No keys configured`);
    }

    let lastError: Error | null = null;
    let lastResponse: T | null = null;
    const isLastAttempt = (attempt: number) => attempt === this.keys.length - 1;

    // Try each key in rotation until one succeeds
    for (let attempt = 0; attempt < this.keys.length; attempt++) {
      const key = this.keys[this.currentIndex];
      const keyLabel = this.keys.length > 1 ? `key #${this.currentIndex + 1}/${this.keys.length}` : "key";

      try {
        if (this.keys.length > 1) {
          log(`[KeyPool:${this.providerName}] Trying ${keyLabel}`);
        }

        // Drain previous response body to prevent connection/memory leaks.
        // We keep only the last failed response intact for the caller.
        if (lastResponse) {
          try {
            await lastResponse.text();
          } catch {
            // Ignore drain errors
          }
          lastResponse = null;
        }

        const response = await fetchFn(key);

        // Clear lastError on successful HTTP response (even if status is non-ok)
        // so error tracking reflects the most recent attempt, not a stale network error
        lastError = null;

        if (!response.ok) {
          if (this.shouldRotateOnStatus(response.status)) {
            log(
              `[KeyPool:${this.providerName}] Got ${response.status} ${response.statusText} with ${keyLabel}, rotating to next key`
            );
            lastResponse = response;
            this.advanceIndex();
            continue;
          }

          // Non-retryable error - return immediately (don't consume keys)
          log(
            `[KeyPool:${this.providerName}] Got ${response.status} ${response.statusText} with ${keyLabel}, not retryable`
          );
          return response;
        }

        // Success! Advance index for next request
        if (this.keys.length > 1) {
          log(`[KeyPool:${this.providerName}] ${keyLabel} succeeded`);
        }
        this.advanceIndex();
        return response;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        lastResponse = null;
        log(
          `[KeyPool:${this.providerName}] Error with ${keyLabel}: ${lastError.message}, rotating to next key`
        );

        // Network error - try next key
        this.advanceIndex();
      }
    }

    // All keys failed
    const triedCount = this.keys.length;

    if (lastError) {
      // Last failure was a network error (thrown exception) - re-throw
      log(
        `[KeyPool:${this.providerName}] All ${triedCount} keys failed. Last error: ${lastError.message}`
      );
      throw lastError;
    }

    if (lastResponse) {
      // Last failure was an HTTP error - return the response so the caller
      // can read status, headers, and body (e.g., 429 quota details).
      // The last response's body is intentionally NOT drained so the caller
      // can read error details (quota info, retry-after hints, etc.).
      log(
        `[KeyPool:${this.providerName}] All ${triedCount} keys failed with status ${lastResponse.status} ${lastResponse.statusText}`
      );
      return lastResponse;
    }

    // Should not reach here, but handle defensively
    throw new Error(
      `[KeyPool:${this.providerName}] All ${triedCount} keys failed`
    );
  }
}
