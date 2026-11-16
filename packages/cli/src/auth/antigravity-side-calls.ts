/**
 * The requests the Antigravity CLI makes beside generation whose answers
 * claudish does not read: the account lookups of a start and the access write
 * of a new conversation. Recorded from `agy` 1.5.9
 * (`ai-docs/architecture/providers/antigravity.md`).
 *
 * None of them may fail or delay a session: every call is bounded, its answer
 * is drained and dropped, and an error is logged and nothing more.
 */

import { log } from "../logger.js";
import { antigravityFetch } from "../providers/transport/antigravity-fetch.js";
import { acquireSigningLease } from "../redact.js";

/** Google's account endpoint; `agy` calls it through Go's default HTTP client. */
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const GOOGLE_USERINFO_USER_AGENT = "Go-http-client/1.1";
/** The configuration endpoint, on its own host. */
const ANTIGRAVITY_CONFIG_URL = "https://aicode.googleapis.com/v1alpha:fetchConfig";

/** How long one side call may take. */
export const ANTIGRAVITY_SIDE_CALL_TIMEOUT_MS = 10_000;

/** One request of the list: a POST carries `body`, a GET has none. */
export interface AntigravitySideCall {
  name: string;
  url: string;
  userAgent: string;
  body?: string;
}

/** What the calls of one account need. */
export interface AntigravitySideCallAccount {
  /** `<host>/v1internal`, the prefix of the Antigravity calls. */
  apiBase: string;
  /** False when the user pointed claudish at another host: the two calls to other Google hosts are then left out. */
  defaultHost: boolean;
  userAgent: string;
  projectId: string;
}

/** The account lookups `agy` makes at a start, in its order, after `loadCodeAssist`. */
export function antigravityAccountCalls(
  account: AntigravitySideCallAccount
): AntigravitySideCall[] {
  const body = JSON.stringify({ project: account.projectId });
  const internal = (name: string): AntigravitySideCall => ({
    name,
    url: `${account.apiBase}:${name}`,
    userAgent: account.userAgent,
    body,
  });
  const calls: AntigravitySideCall[] = [];
  if (account.defaultHost) {
    calls.push({
      name: "userinfo",
      url: GOOGLE_USERINFO_URL,
      userAgent: GOOGLE_USERINFO_USER_AGENT,
    });
  }
  calls.push(
    internal("fetchAdminControls"),
    internal("fetchUserInfo"),
    internal("retrieveUserQuotaSummary"),
    internal("listExperiments")
  );
  if (account.defaultHost) {
    calls.push({ name: "fetchConfig", url: ANTIGRAVITY_CONFIG_URL, userAgent: account.userAgent });
  }
  return calls;
}

/** The write `agy` makes once for a conversation, before its first generation request. */
export function antigravityTrajectoryAclCall(
  account: Pick<AntigravitySideCallAccount, "apiBase" | "userAgent">,
  trajectoryId: string
): AntigravitySideCall {
  return {
    name: "writeTrajectoryAcls",
    url: `${account.apiBase}:writeTrajectoryAcls`,
    userAgent: account.userAgent,
    body: JSON.stringify({ trajectoryId }),
  };
}

/**
 * Sends one call and drops its answer. Never throws. `abort` ends the call
 * with the request it is sent for.
 */
export async function sendAntigravitySideCall(
  call: AntigravitySideCall,
  accessToken: string,
  timeoutMs: number = ANTIGRAVITY_SIDE_CALL_TIMEOUT_MS,
  abort?: AbortSignal
): Promise<void> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": call.userAgent,
  };
  if (call.body !== undefined) headers["Content-Type"] = "application/json";
  // The call can run before or after the request whose lease holds this token,
  // so it holds the token itself for as long as it can log an answer.
  const lease = acquireSigningLease();
  lease.add([accessToken]);
  try {
    const res = await antigravityFetch(call.url, {
      method: call.body === undefined ? "GET" : "POST",
      headers,
      ...(call.body === undefined ? {} : { body: call.body }),
      signal: abort
        ? AbortSignal.any([abort, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    });
    await res.arrayBuffer();
    if (!res.ok) log(`[Antigravity] ${call.name} answered ${res.status}`);
  } catch (err) {
    log(`[Antigravity] ${call.name} error: ${err}`);
  } finally {
    lease.release();
  }
}

/** Sends the calls one after another, as `agy` does. Never throws. */
export async function sendAntigravitySideCalls(
  calls: AntigravitySideCall[],
  accessToken: string,
  timeoutMs: number = ANTIGRAVITY_SIDE_CALL_TIMEOUT_MS
): Promise<void> {
  for (const call of calls) await sendAntigravitySideCall(call, accessToken, timeoutMs);
}
