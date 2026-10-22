import type { Context } from "hono";
import { wrapAnthropicError } from "../../handlers/shared/anthropic-error.js";
import { AllAccountsExhaustedError } from "./errors.js";

/** Only proven pool exhaustion may advance through the quota response seam. */
export function respondAccountsQuotaFailure(c: Context, err: unknown): Response | null {
  if (!(err instanceof AllAccountsExhaustedError)) return null;
  return c.json(
    wrapAnthropicError(400, err.message, "invalid_request_error", err.upstreamStatus),
    400
  );
}
