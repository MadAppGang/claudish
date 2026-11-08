/**
 * Structured errors for credential producers (token refresh, project lookup,
 * login files), so `classifyAuthFailure` (`handlers/shared/auth-failure.ts`)
 * reads FIELDS, never prose:
 *
 * - a missing login or a rejected grant (400/401/403 from a token host) is
 *   `terminal`: only a new login fixes it, and the routing chain stops with
 *   the message on the first attempt;
 * - a 429 or 5xx from a token host is `transient` with its `upstreamStatus`:
 *   the same hop answers on retry, so it is never a reason to stop, nor to
 *   walk onto another provider.
 *
 * A plain `Error` from a credential path is `unknown`, which a subscription
 * answers as retryable (transient 503): a producer that has not said what its
 * failure is gets the conservative answer, never a fatal one.
 */

export interface CredentialFailureFields {
  terminal?: true;
  transient?: true;
  upstreamStatus?: number;
}

/** A credential failure no retry can fix (no login, a revoked or rejected grant). */
export function terminalCredentialError(
  message: string,
  upstreamStatus?: number
): Error & CredentialFailureFields {
  return Object.assign(new Error(message), {
    terminal: true as const,
    ...(upstreamStatus !== undefined ? { upstreamStatus } : {}),
  });
}

/**
 * The error for a token host's non-2xx answer: 429 and 5xx are transient,
 * everything else (a rejected grant, a bad request) is terminal. The status
 * travels either way.
 */
export function credentialHttpError(
  message: string,
  status: number
): Error & CredentialFailureFields {
  if (status === 429 || (status >= 500 && status <= 599)) {
    return Object.assign(new Error(message), { transient: true as const, upstreamStatus: status });
  }
  return terminalCredentialError(message, status);
}

/** Whether a producer marked this error retryable (429/5xx from its token host). */
export function isTransientCredentialError(err: unknown): boolean {
  return (err as CredentialFailureFields | null)?.transient === true;
}
