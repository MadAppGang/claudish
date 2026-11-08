/**
 * The account label: its pattern, the default derived from a login, and the
 * comparisons that decide a clash. Pure and import-free so `types.ts`,
 * `config-schema.ts` and `management.ts` share ONE definition.
 *
 * A label is the user-facing handle and, by decision 12 in `accounts.md`, may be
 * the login's email. The character set is closed: `@` and `+` are inert in an
 * unquoted shell word (the glob forms need `(`, which stays excluded), and `;`,
 * quotes, `$`, backslash and control characters stay rejected.
 */

export const ACCOUNT_LABEL_MAX = 64;

/** First character `\w`; ASCII only (no `u` flag). Existing 32-character labels stay valid. */
export const ACCOUNT_LABEL_PATTERN = /^\w[\w@+. -]{0,63}$/;

export const ACCOUNT_LABEL_RULE =
  "An account label starts with a letter, digit or underscore and has at most 64 letters, " +
  "digits, spaces, and the characters _ @ + . -";

const PLAN_MAX = 16;
const NUMBER_MAX = 999;

/** The vendor's plan claim as a label suffix: lowercase letters and digits, at most 16. */
export function cleanPlan(plan?: string): string | undefined {
  const cleaned = (plan ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, PLAN_MAX);
  return cleaned || undefined;
}

/** Case-insensitive: uniqueness of a NEW label ignores case. */
export function labelTaken(taken: Iterable<string>, label: string): boolean {
  const wanted = label.toLowerCase();
  for (const existing of taken) if (existing.toLowerCase() === wanted) return true;
  return false;
}

/** A login's email against a command-line selector: exact, case-insensitive. */
export function emailMatches(rowEmail: string | undefined, selector: string): boolean {
  return rowEmail !== undefined && rowEmail.toLowerCase() === selector.toLowerCase();
}

/** A label as one shell word: bare when it needs no quoting, else single-quoted. */
export function shellWord(label: string): string {
  if (/^[\w@+.-]+$/.test(label)) return label;
  return `'${label.replace(/'/g, `'\\''`)}'`;
}

function baseOf(input: { email?: string; chatgptAccountId?: string }): string {
  const fromEmail = (input.email ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_@+.-]/g, "_")
    .replace(/^\W+/, "");
  if (fromEmail) return fromEmail.slice(0, ACCOUNT_LABEL_MAX);
  return (input.chatgptAccountId ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/^\W+/, "")
    .slice(0, 8);
}

/** Cut `base` so `base + suffix` fits, without leaving a dangling separator. */
function fit(base: string, suffix: string): string {
  return base.slice(0, ACCOUNT_LABEL_MAX - suffix.length).replace(/[.\-+@]+$/, "") + suffix;
}

/**
 * The default label for a new login: `<email>`, then `<email>-<plan>`, then a
 * number (`-<plan>-2`, or `-2` with no plan). With no email the base is the
 * first 8 characters of `chatgptAccountId`.
 */
export function deriveAccountLabel(input: {
  email?: string;
  plan?: string;
  chatgptAccountId?: string;
  taken: Iterable<string>;
}): string {
  const base = baseOf(input);
  if (!base) throw new Error("The login carries no email or account id; pass --label.");
  const taken = new Set<string>();
  for (const label of input.taken) taken.add(label.toLowerCase());
  const plan = cleanPlan(input.plan);
  const planSuffix = plan ? `-${plan}` : "";
  // Lazy: the ladder is walked only as far as the first free candidate.
  function* candidates(): Generator<string> {
    yield fit(base, "");
    if (plan) yield fit(base, planSuffix);
    for (let n = 2; n <= NUMBER_MAX; n++) yield fit(base, `${planSuffix}-${n}`);
  }
  for (const candidate of candidates()) {
    if (taken.has(candidate.toLowerCase())) continue;
    if (!ACCOUNT_LABEL_PATTERN.test(candidate)) {
      throw new Error(`The derived label "${candidate}" is not valid; pass --label.`);
    }
    return candidate;
  }
  throw new Error("Could not derive an unused label; pass --label.");
}
