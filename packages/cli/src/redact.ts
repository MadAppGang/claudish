/**
 * Redaction for diagnostics.
 *
 * Two levels, because two different things are being protected:
 *
 *   redactSecrets()     — credentials ONLY. For text that stays on this machine
 *                         but WILL be read by an agent: on-disk error logs,
 *                         status.json snippets. Paths and emails are the user's
 *                         own and redacting them makes a local debug log worse,
 *                         so they are left alone here.
 *
 *   sanitizeForReport() — credentials AND personal data. For anything LEAVING
 *                         the machine (the `report_error` tool). Home directory
 *                         paths and email addresses identify the user, so they go.
 *
 * Conflating the two is how the old single `sanitize()` ended up simultaneously
 * too weak (it knew only `sk-` keys, so it missed Google, xAI, JWTs, and every
 * `_TOKEN`/`_SECRET`/`_KEY` variable) and too aggressive (it scrubbed `/Users/…`
 * out of logs that never leave the machine).
 */

/** What a redacted value is replaced with. Distinctive so it greps cleanly. */
const MASK = "***REDACTED***";

/**
 * Values that are obviously instructional placeholders, not real secrets.
 *
 * claudish's own credential errors say `export ZHIPU_API_KEY='your-key-here'`.
 * Redacting that turns actionable help into noise, so these are passed through.
 */
/*
 * Anything beginning with "your" is instructional, not a credential — no real
 * key starts that way. Enumerating exact phrases was too narrow: it covered
 * `your-key-here` but not the bare `your-key`, so claudish's own remediation
 * line `export GEMINI_API_KEY=your-key  (for google)` came back as
 * `=***REDACTED***`, turning the fix instructions into noise.
 */
const PLACEHOLDER =
  /^(['"`]?)(your[-_a-z0-9]*|<[^>]*>|\.\.\.|x{3,}|\*{3,}|REDACTED|CHANGEME|TODO|\$\{[^}]*\}|)(['"`]?)$/i;

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER.test(value.trim());
}

/**
 * `NAME=value` / `NAME: value` / `"NAME": "value"` where NAME looks like a
 * credential holder. Covers _API_KEY, _KEY, _TOKEN, _SECRET, _PASSWORD — the old
 * pattern matched only `_API_KEY=`, so GEMINI_CLIENT_SECRET, ANTHROPIC_AUTH_TOKEN,
 * OP_SERVICE_ACCOUNT_TOKEN and every CUSTOM_*_KEY leaked through.
 */
/*
 * The value alternation tries `${VAR}` FIRST. Without that branch the generic
 * class stops at `}` and captures a truncated `${VAR`, which then fails the
 * placeholder check and gets masked — leaving a corrupted `KEY=***REDACTED***}`.
 * claudish's own customEndpoints config uses `"apiKey": "${VLLM_API_KEY}"`, so
 * echoing config would have been mangled.
 */
const ASSIGNMENT_RE =
  /(["']?\b[A-Z][A-Z0-9_]*(?:_API_KEY|_KEY|_TOKEN|_SECRET|_PASSWORD)\b["']?\s*[:=]\s*)(["'`]?\$\{[^}]*\}["'`]?|["'`]?[^\s"'`,}]+["'`]?)/g;

/**
 * Known credential shapes, matched on their vendor prefix so a bare value is
 * caught even without a variable name attached.
 *
 * Derived from the providers claudish actually routes to; `sk-` alone (the old
 * behaviour) covers only OpenAI-family keys.
 */
const TOKEN_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // OpenAI / Anthropic / OpenRouter / Moonshot — sk-, sk-ant-, sk-or-v1-
  { name: "sk", re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  // Google AI Studio / Gemini
  { name: "google", re: /\bAIza[A-Za-z0-9_-]{20,}/g },
  // xAI
  { name: "xai", re: /\bxai-[A-Za-z0-9_-]{16,}/g },
  // GitHub personal / OAuth / server / user / refresh tokens
  { name: "github", re: /\bgh[posur]_[A-Za-z0-9]{20,}/g },
  // AWS access key id
  { name: "aws", re: /\bAKIA[0-9A-Z]{12,}/g },
  // JWT (MiniMax and friends issue these as keys). Three base64url segments.
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  // Zhipu / GLM: <32 hex>.<16 alnum>
  { name: "zhipu", re: /\b[0-9a-f]{32}\.[A-Za-z0-9]{16}\b/g },
  // Authorization headers of any scheme
  { name: "bearer", re: /\b(?:Bearer|Basic|Token)\s+[A-Za-z0-9_.\-+/=]{12,}/g },
];

// ─── Signing-value registry ──────────────────────────────────────────────────
//
// Shape rules (below) catch a credential by what it LOOKS like. A provider's
// opaque token, a Devin body credential or an OAuth access token has no shape
// to match, and an upstream error that echoes it back would reach the debug
// log, the always-on log, stderr and the error capture verbatim. The registry
// catches those by exact VALUE instead: every request registers the values it
// signs with, and every sink that redacts reads the union of the values of all
// requests in flight.
//
// Process-wide on purpose, not per request: a provider queue's loop runs in the
// async context of whichever request started it, so a line it logs for request
// B would be checked against request A's scope. Redacting B's line against A's
// values as well is harmless.
//
// A lease lives exactly as long as the work it protects: the holder releases it
// when that work has ended (a response body fully read, cancelled or errored).
// There is deliberately NO timer here. A fixed TTL can expire while a stream is
// still producing frames, and a later frame echoing the credential would then
// be logged in the clear. A lease nobody releases costs retained strings and
// extra redaction, never exposure.

/** What a registered signing value is replaced with. */
const SIGNING_MASK = "[redacted]";

/** Shorter values are ignored: they would mask ordinary words. */
const SIGNING_VALUE_MIN_LENGTH = 8;

/** Every live form of every live value -> how many leases hold it. */
const liveSigningValues = new Map<string, number>();

/** Live forms, longest first; rebuilt lazily after any change. */
let sortedSigningValues: string[] | null = null;

/** A set of signing values held for the duration of one piece of work. */
export interface SigningLease {
  /** Register values; ignored once released, and below the minimum length. */
  add(values: Iterable<string>): void;
  /** Drop this lease's hold on every value it added. Idempotent. */
  release(): void;
  /** True once `release()` has run. */
  readonly released: boolean;
}

/**
 * The forms one value can take in text a sink receives: verbatim, JSON-escaped
 * (an error body quoting it inside a JSON string), JSON-escaped twice (that body
 * embedded in another JSON string, as a log of a JSON envelope does), and
 * URL-encoded (a query parameter echoed back). Escaping only adds characters,
 * so a form differs from the value only when the value needs escaping.
 */
function signingValueForms(value: string): string[] {
  const forms = new Set<string>([value]);
  let escaped = value;
  for (let depth = 0; depth < 2; depth++) {
    escaped = JSON.stringify(escaped).slice(1, -1);
    forms.add(escaped);
  }
  try {
    forms.add(encodeURIComponent(value));
  } catch {
    // A lone surrogate cannot be URL-encoded; the other forms still apply.
  }
  return [...forms];
}

/** Hold every form of `value` for one lease: counted once per lease, not per call. */
function holdSigningValue(held: Set<string>, value: unknown): void {
  if (typeof value !== "string" || value.length < SIGNING_VALUE_MIN_LENGTH) return;
  for (const form of signingValueForms(value)) {
    if (held.has(form)) continue;
    held.add(form);
    liveSigningValues.set(form, (liveSigningValues.get(form) ?? 0) + 1);
    sortedSigningValues = null;
  }
}

/** Acquire a lease. The holder must call `release()` when its work has ended. */
export function acquireSigningLease(): SigningLease {
  const held = new Set<string>();
  let released = false;
  return {
    add(values: Iterable<string>): void {
      if (released) return;
      for (const value of values) holdSigningValue(held, value);
    },
    release(): void {
      if (released) return;
      released = true;
      for (const form of held) {
        const count = (liveSigningValues.get(form) ?? 0) - 1;
        if (count > 0) liveSigningValues.set(form, count);
        else liveSigningValues.delete(form);
      }
      held.clear();
      sortedSigningValues = null;
    },
    get released(): boolean {
      return released;
    },
  };
}

/**
 * Replace every live signing value in `text` with `[redacted]`, longest first.
 * Returns `text` untouched when no request holds a value (the common case).
 * Exact substring matching, no regular expression: a value is data, not a
 * pattern, and a shared global regex would carry `lastIndex` between calls.
 * Replacements only shorten, so JSON stays JSON.
 */
export function redactSigningValues(text: string): string {
  if (liveSigningValues.size === 0 || !text) return text;
  if (!sortedSigningValues) {
    sortedSigningValues = [...liveSigningValues.keys()].sort((a, b) => b.length - a.length);
  }
  let out = text;
  for (const value of sortedSigningValues) {
    if (out.includes(value)) out = out.split(value).join(SIGNING_MASK);
  }
  return out;
}

/**
 * Replace every form of every value in `values` with `[redacted]`, longest
 * first: the same forms and the same minimum length as the registry, for a
 * holder that keeps its own set and must redact after its lease is released
 * (the advisor gateway's result). Exact substring matching, no regex.
 */
export function redactExactValues(text: string, values: Iterable<string>): string {
  if (!text) return text;
  const forms = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value.length < SIGNING_VALUE_MIN_LENGTH) continue;
    for (const form of signingValueForms(value)) forms.add(form);
  }
  if (forms.size === 0) return text;
  let out = text;
  for (const form of [...forms].sort((a, b) => b.length - a.length)) {
    if (out.includes(form)) out = out.split(form).join(SIGNING_MASK);
  }
  return out;
}

/**
 * The registry pass for text sent back to Claude Code (an error body, an SSE
 * error frame). A response body is not a log line, so it never passes through
 * `log`; every site that puts upstream text into one calls this instead.
 */
export function redactForClient(text: string): string {
  return redactSigningValues(text);
}

/**
 * Strip credentials from text. Safe to run on anything; never throws.
 *
 * Deliberately does NOT do blanket high-entropy matching — that would redact
 * legitimate content (hashes, base64 payloads, model ids) and make logs
 * untrustworthy. Known shapes plus named assignments cover the real cases.
 */
export function redactSecrets(text: string | undefined | null): string {
  if (!text) return "";
  // Exact values first: a registered opaque token has no shape the rules below
  // could match.
  let out = redactSigningValues(text);

  // Named assignments first, so `FOO_API_KEY=sk-abc…` is masked once as a whole
  // rather than leaving a dangling `FOO_API_KEY=` next to a separate mask.
  out = out.replace(ASSIGNMENT_RE, (match, lhs: string, value: string) =>
    isPlaceholder(value) ? match : `${lhs}${MASK}`
  );

  for (const { re } of TOKEN_PATTERNS) {
    out = out.replace(re, (match) => {
      // Preserve the scheme word on Authorization headers so the log still
      // shows WHICH auth scheme was used.
      const scheme = /^(Bearer|Basic|Token)\s/.exec(match);
      return scheme ? `${scheme[1]} ${MASK}` : MASK;
    });
  }

  return out;
}

/**
 * Full sanitization for data leaving this machine: credentials plus the personal
 * details that identify the user.
 */
export function sanitizeForReport(text: string | undefined | null): string {
  if (!text) return "";
  return (
    redactSecrets(text)
      // Home directories carry the username.
      .replace(/\/Users\/[^/\s]+/g, "/Users/***")
      .replace(/\/home\/[^/\s]+/g, "/home/***")
      .replace(/[A-Z]:\\Users\\[^\\\s]+/gi, "C:\\Users\\***")
      // Email addresses.
      .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "***@***.***")
  );
}
