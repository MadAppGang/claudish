/**
 * `CLAUDISH_TEST_UPSTREAM` — a LOOPBACK-ONLY host override, and
 * `CLAUDISH_ACCOUNTS_FAULT` — the fault-injection vocabulary the accounts e2e
 * matrix is written against.
 *
 * ## Why this is production code
 *
 * The same reasoning as `CLAUDISH_DISABLE_KEYCHAIN` (see `keychain.md`): a flag
 * the PRODUCTION code honours is the only stub that cannot leak. `mock.module()`
 * is process-global in Bun and bleeds into sibling files, and a mock-upstream
 * e2e has to redirect the REAL binary's outbound calls — there is no module
 * registry to patch from outside the process.
 *
 * ## Loopback only, and rejected as a whole
 *
 * Every target must be loopback (`127.0.0.0/8`, `::1`, `localhost`). A single
 * non-loopback entry rejects the ENTIRE value: no rewriting happens at all and
 * traffic goes to the real upstream. Rejecting the whole value rather than the
 * offending entry means a typo cannot silently redirect one host to an attacker
 * while the rest of the run looks normal, and the safe direction of the failure
 * is "claudish talked to the vendor", never "claudish talked to a stranger".
 *
 * ## Accepted forms
 *
 * ```
 * CLAUDISH_TEST_UPSTREAM=http://127.0.0.1:4010
 *     every known upstream host is rewritten to that origin
 *
 * CLAUDISH_TEST_UPSTREAM=api.anthropic.com=http://127.0.0.1:4010,api.openai.com=http://127.0.0.1:4011
 *     per-host targets — this is the form the metered CANARY needs, because the
 *     canary listener is a DIFFERENT loopback port registered for
 *     `api.openai.com` so that contacting the metered path is an observed event
 *     rather than an absence.
 * ```
 *
 * A bare origin and per-host entries may be mixed; `default=<origin>` names the
 * catch-all explicitly.
 */

import { log } from "./logger.js";

/** Env var carrying the loopback host override. */
export const TEST_UPSTREAM_ENV = "CLAUDISH_TEST_UPSTREAM";

/** Env var carrying the fault-injection selector. */
export const ACCOUNTS_FAULT_ENV = "CLAUDISH_ACCOUNTS_FAULT";

/**
 * The CLOSED fault vocabulary `ai-docs/architecture/accounts-validation.md` depends on.
 *
 * A fault vocabulary that cannot produce a row's precondition makes that row
 * unrunnable, which is the same defect as an ineffective mutation one level
 * down — so the list is pinned here, in production code, and a name outside it
 * is rejected loudly rather than silently ignored.
 *
 * **Every name here has a live injection site.** A name the code accepts but
 * never acts on is worse than no name: the row that arms it goes green on a
 * precondition that never happened. Names whose site belongs to a later phase
 * are therefore NOT in the list yet — they are recorded below the array, with
 * the phase that adds them, and until then `accountsFault()` rejects them.
 *
 * The persist faults come in two families because a refresh persists TWICE:
 * the journal (before the exchange) and the rotated tokens (after it).
 * `persist-*` hits the FINAL write, which is the only way to produce "the
 * exchange succeeded and the persist failed" (V9, V9b); `journal-persist-*`
 * hits the journal write, before any exchange is attempted.
 */
export const ACCOUNTS_FAULTS = [
  /** The FINAL persist (the rotated tokens) throws outright, after a successful exchange. */
  "persist-throw",
  /** The FINAL persist times out AFTER the store committed (the ambiguous-success half). */
  "persist-timeout-committed",
  /** The FINAL persist times out BEFORE the store committed (the ambiguous-failure half). */
  "persist-timeout-uncommitted",
  /** The JOURNAL persist throws outright; no exchange may follow. */
  "journal-persist-throw",
  /** The JOURNAL persist times out AFTER the store committed; the exchange proceeds. */
  "journal-persist-timeout-committed",
  /** The JOURNAL persist times out BEFORE the store committed; no exchange may follow. */
  "journal-persist-timeout-uncommitted",
  /** The process dies between a successful exchange and the persist. */
  "crash-after-refresh",
  /** A live, heartbeating holder pins the gate past the acquire timeout — it never releases. */
  "lock-hold-forever",
  /** Every token-store READ throws — `failed`, never `absent`. */
  "store-read-throws",
  /** The account-list read (config.json / legacy file) throws — `failed`, never `absent`. */
  "account-list-read-throws",
  /** The holder's nonce is replaced while its exchange is in flight. */
  "steal-lock-mid-exchange",
  /** The holder's nonce is replaced BETWEEN its fence read and its final write. */
  "steal-lock-after-fence",
  /** Return a non-OAuth artifact for the metered canary before the transport's arm check. */
  "non-oauth-artifact",
] as const;
// Not yet accepted — no injection site exists in this phase (phases and rows:
// ai-docs/architecture/accounts.md and accounts-validation.md):
//   "crash-after-first-store-write" — Phase 4 adds it, with the dual-store refresh (V12c).

export type AccountsFault = (typeof ACCOUNTS_FAULTS)[number];

type HostMap = { byHost: Map<string, string>; fallback?: string };

/** Memo keyed by the RAW env value, so a test that changes it mid-process is seen. */
let parsedFor: string | undefined;
let parsed: HostMap | null = null;
let warnedFor: string | undefined;

/**
 * Loopback check.
 *
 * `0.0.0.0` is deliberately NOT loopback: it is a wildcard bind address, and a
 * connection to it leaves the machine's routing table's hands.
 */
function isLoopbackTarget(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** Normalize a target to a bare origin (scheme + host + port), dropping any path. */
function toOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function rejectValue(raw: string, reason: string): null {
  if (warnedFor !== raw) {
    warnedFor = raw;
    log(`[TestUpstream] ignoring ${TEST_UPSTREAM_ENV}: ${reason}`);
  }
  return null;
}

function parseTestUpstream(raw: string | undefined): HostMap | null {
  if (parsedFor === raw) return parsed;
  parsedFor = raw;
  parsed = null;
  if (!raw || raw.trim() === "") return null;

  const byHost = new Map<string, string>();
  let fallback: string | undefined;

  for (const piece of raw.split(",")) {
    const entry = piece.trim();
    if (!entry) continue;

    // `host=origin`, or a bare origin. `=` cannot appear in an origin, and the
    // first `=` splits, so `default=http://127.0.0.1:1` parses as expected.
    const eq = entry.indexOf("=");
    const hasKey = eq > 0 && !entry.slice(0, eq).includes("//");
    const key = hasKey ? entry.slice(0, eq).trim().toLowerCase() : "default";
    const target = hasKey ? entry.slice(eq + 1).trim() : entry;

    if (!isLoopbackTarget(target)) {
      return rejectValue(raw, `"${target}" is not a loopback target`);
    }
    const origin = toOrigin(target);
    if (!origin) return rejectValue(raw, `"${target}" is not a URL`);

    if (key === "default" || key === "*") fallback = origin;
    else byHost.set(key, origin);
  }

  if (byHost.size === 0 && !fallback) return rejectValue(raw, "no usable entries");
  parsed = fallback === undefined ? { byHost } : { byHost, fallback };
  return parsed;
}

/** True when a valid loopback override is in force. */
export function testUpstreamActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseTestUpstream(env[TEST_UPSTREAM_ENV]) !== null;
}

/**
 * Rewrite one outbound URL onto the loopback target, preserving path and query.
 *
 * Returns the url UNCHANGED when no override is in force, when the value was
 * rejected, or when no entry covers this host — so every call site is a no-op in
 * production by construction.
 */
export function resolveUpstreamUrl(url: string, env: NodeJS.ProcessEnv = process.env): string {
  const map = parseTestUpstream(env[TEST_UPSTREAM_ENV]);
  if (!map) return url;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return url;
  }
  const target = map.byHost.get(parsedUrl.hostname.toLowerCase()) ?? map.fallback;
  if (!target) return url;

  // Composed by concatenation rather than through `new URL(path, base)`, which
  // normalises a bare origin to a trailing slash. Callers that keep a BASE url
  // and append their own path (`${baseUrl}/v1/messages`) would then build a
  // double slash, and some servers route that as a different path.
  const keepPath = parsedUrl.pathname !== "/" || url.endsWith("/");
  const rewritten = `${target}${keepPath ? parsedUrl.pathname : ""}${parsedUrl.search}${parsedUrl.hash}`;
  log(`[TestUpstream] ${parsedUrl.origin} → ${target}${keepPath ? parsedUrl.pathname : ""}`);
  return rewritten;
}

/**
 * The armed fault, or null.
 *
 * ARMED ONLY WHEN `CLAUDISH_TEST_UPSTREAM` IS ALSO SET AND VALID. A fault that
 * could fire against a real vendor endpoint would be a way to corrupt a user's
 * real token store with an env var, so the two are deliberately coupled.
 * An unrecognised name is reported and ignored.
 */
export function accountsFault(env: NodeJS.ProcessEnv = process.env): AccountsFault | null {
  const raw = env[ACCOUNTS_FAULT_ENV]?.trim();
  if (!raw) return null;
  if (!testUpstreamActive(env)) {
    log(`[TestUpstream] ${ACCOUNTS_FAULT_ENV}=${raw} ignored: ${TEST_UPSTREAM_ENV} is not set`);
    return null;
  }
  const match = ACCOUNTS_FAULTS.find((name) => name === raw);
  if (!match) {
    log(`[TestUpstream] ${ACCOUNTS_FAULT_ENV}=${raw} is not a known fault name — ignored`);
    return null;
  }
  return match;
}

/** Is THIS fault armed? The predicate every injection site calls. */
export function accountsFaultArmed(
  name: AccountsFault,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return accountsFault(env) === name;
}
