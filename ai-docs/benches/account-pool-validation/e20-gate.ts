/**
 * Pure pass/fail decisions of the E20 runner and of the mutant standing check.
 * Kept free of I/O so `e20-gate.test.ts` can pin them: a wrong rule here fails
 * silently (exit 0 on a regressed binary).
 */

import { describeSecret, redactCredentialShapes } from "./cred-shape-scan.ts";

/** The slice of an E20 capture the divergence check reads. `Capture` satisfies it. */
export interface SideCapture {
  fake: Array<{ path: string }>;
  canary: unknown[];
  client: { status: number; body: unknown };
  clientHeaders: Record<string, string>;
  /** Every response header; absent in older test data. */
  allClientHeaders?: Record<string, string>;
}

/** Values that are fake by construction: allowed in upstream-request evidence, never in a client response. */
export const FAKE_SECRETS = new Set([
  "sk-canary-must-never-be-used",
  "access-legacy",
  "refresh-legacy",
  "at-rotated-1",
  "rt-rotated-1",
]);

const SECRET_SHAPE =
  /sk-[A-Za-z0-9_-]{6,}|eyJ[A-Za-z0-9_-]{10,}|\b(?:access|refresh)-(?:legacy|[A-Z]\d*)\b|(?:at|rt)-rotated-\d+/g;

/**
 * Every credential-shaped string in `text` that is not one of the fake values, described by
 * hash. ALL matches are checked (review round 6: a first-match-only test let a real token hide
 * behind an allowlisted fake one earlier in the same text).
 */
export function unknownSecretShapes(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(SECRET_SHAPE))
    if (!FAKE_SECRETS.has(m[0])) out.push(describeSecret(m[0]));
  return out;
}

/**
 * Credentials in what the client sees: the body and every response header of one
 * capture. In memory, so a repetition whose raw files are not kept is covered too.
 */
export function clientLeaks(cap: {
  client: { body: unknown };
  clientHeaders: Record<string, string>;
  allClientHeaders?: Record<string, string>;
}): string[] {
  const surfaces: Array<[string, string]> = [
    ["client body", JSON.stringify(cap.client.body) ?? ""],
    ...Object.entries({ ...cap.clientHeaders, ...cap.allClientHeaders }).map(
      ([k, v]): [string, string] => [`client header ${k}`, v]
    ),
  ];
  const out: string[] = [];
  for (const [where, text] of surfaces) {
    for (const secret of FAKE_SECRETS)
      if (text.includes(secret)) out.push(`${where} echoes ${secret}`);
    for (const d of unknownSecretShapes(text))
      out.push(`${where} has a credential-shaped string (${d})`);
  }
  return out;
}

/**
 * Files in the E20 output directory that are upstream-request evidence: the fake's and the
 * canary's recorded requests, each case's result.json and each mutant's diff.json (diffs of
 * normalized upstream requests;
 * its client part is covered in memory by `clientLeaks`). A fake credential is allowed ONLY
 * in these. Anything else (client-response.json, serve-stdout.txt, serve-stderr.txt, ...)
 * holding one is a violation.
 */
export const UPSTREAM_EVIDENCE_FILES: ReadonlySet<string> = new Set([
  "fake-requests.json",
  "canary-requests.json",
  "result.json",
  "diff.json",
]);

/** Credentials in the binary's full stdout or stderr, scanned in memory on every run. */
export function outputLeaks(streams: { stdout: string; stderr: string }): string[] {
  const out: string[] = [];
  for (const [where, text] of Object.entries(streams)) {
    for (const secret of FAKE_SECRETS)
      if (text.includes(secret)) out.push(`${where} echoes ${secret}`);
    for (const d of unknownSecretShapes(text))
      out.push(`${where} has a credential-shaped string (${d})`);
  }
  return out;
}

/** The exact error.message of each binary in the saved run (validation-run4/e20/refresh-rejected). */
export const REFRESH_REJECTED_MESSAGE = {
  baseline:
    'Error: OAuth credentials invalid. Please run `claudish login codex` again. Details: Token refresh failed: 400 - {"error":"invalid_grant"}',
  candidate:
    "OpenAI Codex login expired or was revoked \u2014 run `claudish login codex` to sign in again. (token refresh: HTTP 400 invalid_grant)",
};

/** The only differing leaves `refresh-rejected` may show (recorded in accounts-validation.md E20). */
export const REFRESH_REJECTED_DIFF_PATHS = [
  "$.client.status",
  "$.client.body.error.message",
  "$.client.body.error.type",
  "$.client.body.error.upstream_status",
];

function errorOf(body: unknown): Record<string, unknown> {
  const e = (body as { error?: unknown } | null)?.error;
  return e && typeof e === "object" ? (e as Record<string, unknown>) : {};
}

function sideProblems(
  name: string,
  s: SideCapture,
  want: {
    status: number;
    errorType: string;
    message: string;
    upstreamStatus?: number;
    verdictHeader?: string;
  }
): string[] {
  const out: string[] = [];
  const err = errorOf(s.client.body);
  const exchanges = s.fake.filter((q) => q.path.endsWith("/oauth/token")).length;
  if (s.fake.length !== 1 || exchanges !== 1)
    out.push(
      `${name}: expected exactly one request, a token exchange (saw ${s.fake.length}, ${exchanges} exchange(s))`
    );
  if (s.canary.length !== 0) out.push(`${name}: canary contacted ${s.canary.length}x`);
  if (s.client.status !== want.status)
    out.push(`${name}: client status ${s.client.status}, expected ${want.status}`);
  if (err.type !== want.errorType)
    out.push(`${name}: error.type ${JSON.stringify(err.type)}, expected ${want.errorType}`);
  if (err.upstream_status !== want.upstreamStatus)
    out.push(
      `${name}: error.upstream_status ${JSON.stringify(err.upstream_status)}, expected ${JSON.stringify(want.upstreamStatus)}`
    );
  if (err.message !== want.message)
    out.push(
      `${name}: error.message ${JSON.stringify(err.message)}, expected ${JSON.stringify(want.message)}`
    );
  for (const leak of clientLeaks(s)) out.push(`${name}: ${leak}`);
  const verdict = s.clientHeaders["x-claudish-auth-verdict"];
  if (verdict !== want.verdictHeader)
    out.push(
      `${name}: x-claudish-auth-verdict ${JSON.stringify(verdict)}, expected ${JSON.stringify(want.verdictHeader)}`
    );
  return out;
}

/**
 * Explicit expectations for `refresh-rejected`, including each binary's exact
 * `error.message` (no variable part: the saved messages carry none) and no credential
 * in the client body or headers. Baseline (v14.4.1 plus the seam):
 * 500 `api_error`, no verdict header. Candidate (A2/A4): 400 `invalid_request_error`
 * with `upstream_status` 401 and `x-claudish-auth-verdict: terminal`. Both: one
 * token exchange and no canary. `diff` (from `diffValues`) must name exactly the four
 * recorded leaves. Anything else is a problem.
 */
export function refreshRejectedProblems(
  baseline: SideCapture,
  candidate: SideCapture,
  diff: string[]
): string[] {
  const out = [
    ...sideProblems("baseline", baseline, {
      status: 500,
      errorType: "api_error",
      message: REFRESH_REJECTED_MESSAGE.baseline,
    }),
    ...sideProblems("candidate", candidate, {
      status: 400,
      errorType: "invalid_request_error",
      message: REFRESH_REJECTED_MESSAGE.candidate,
      upstreamStatus: 401,
      verdictHeader: "terminal",
    }),
  ];
  const seen = diff.map((d) => d.slice(0, d.indexOf(":")));
  for (const p of seen)
    if (!REFRESH_REJECTED_DIFF_PATHS.includes(p)) out.push(`unexpected difference at ${p}`);
  for (const p of REFRESH_REJECTED_DIFF_PATHS)
    if (!seen.includes(p)) out.push(`expected difference missing at ${p}`);
  return out;
}

export interface SummaryEntry {
  id: string;
  outcome: string;
  detail: string;
}

/**
 * Run one E20 step (a seam proof, a case's captures, a mutant run). A throw (the binary did
 * not start, the connection broke, the process crashed) becomes an ABORTED summary entry for
 * `id` instead of ending the run, so the secret scan and the summary are still written and
 * the exit code fails (review round 6). The error text is redacted by shape: a start failure
 * quotes the binary's stdout and stderr.
 */
export async function guarded<T>(
  id: string,
  fn: () => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; entry: SummaryEntry }> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    const detail = redactCredentialShapes(text.slice(0, 2000), []).text;
    return { ok: false, entry: { id, outcome: "ABORTED", detail: `threw: ${detail}` } };
  }
}

/** Summary ids of mutants that are DOCUMENTED dead (single-site, redundant layer). */
export const NEGATIVE_CONTROLS = ["mutant V16-drop-transform"];

export interface Expected {
  /** Case ids this invocation must report on. */
  cases: string[];
  /** Summary ids (`mutant <id>`) this invocation must report on. */
  mutants: string[];
}

/**
 * Exit code and reasons. Nonzero for: an empty summary, a case or mutant that was
 * expected but never reported, a secret-scan violation, a seam that was not armed, any
 * ABORTED entry, a case that is not `identical` / `expected divergence` (so DIFFERENT
 * fails), and any required mutant that is not `mutant red`. A named negative control
 * may be dead (or red) without failing the run. A partial run (`--only`) passes the
 * narrowed `expected`.
 */
export function e20Verdict(
  summary: SummaryEntry[],
  armed: Record<string, string | null>,
  scanViolations: number,
  expected: Expected
): { code: 0 | 1; reasons: string[] } {
  const reasons: string[] = [];
  if (summary.length === 0) reasons.push("empty summary: no case or mutant produced a result");
  const have = new Set(summary.map((e) => e.id));
  for (const id of [...expected.cases, ...expected.mutants])
    if (!have.has(id)) reasons.push(`${id}: expected but missing from the summary`);
  if (scanViolations > 0) reasons.push(`secret scan: ${scanViolations} violation(s)`);
  for (const [id, err] of Object.entries(armed))
    if (err !== null) reasons.push(`seam not armed on ${id}: ${err}`);
  for (const e of summary) {
    const isMutant = e.id.startsWith("mutant ");
    const control = NEGATIVE_CONTROLS.includes(e.id);
    if (e.outcome === "ABORTED") reasons.push(`${e.id}: ABORTED (${e.detail})`);
    else if (isMutant && !control && e.outcome !== "mutant red")
      reasons.push(`${e.id}: required mutant is ${e.outcome}, not red`);
    else if (!isMutant && e.outcome !== "identical" && e.outcome !== "expected divergence")
      reasons.push(`${e.id}: ${e.outcome} (${e.detail})`);
  }
  return { code: reasons.length ? 1 : 0, reasons };
}

/** Command-line problems, found before any process starts. */
export function argProblems(
  raw: { baseline?: string; out?: string; only?: string; onlyGiven: boolean },
  caseIds: string[],
  isCandidateTree: (baseline: string) => boolean
): string[] {
  const out: string[] = [];
  const missing = (v: string | undefined) => v === undefined || v === "" || v.startsWith("--");
  if (missing(raw.baseline)) out.push("--baseline <worktree> is required");
  else if (isCandidateTree(raw.baseline as string))
    out.push("--baseline is the candidate checkout: the two binaries would be the same");
  if (missing(raw.out)) out.push("--out <dir> is required");
  if (raw.onlyGiven && (missing(raw.only) || !caseIds.includes(raw.only as string)))
    out.push(`--only must name one of: ${caseIds.join(", ")}`);
  return out;
}

const STABLE_HEADERS = (k: string) => k === "content-type" || k.startsWith("x-claudish");

/** Client headers that differ between two captures of the SAME binary. */
export function headerStabilityDiff(a: SideCapture, b: SideCapture): string[] {
  const keys = new Set(
    [...Object.keys(a.clientHeaders), ...Object.keys(b.clientHeaders)].filter(STABLE_HEADERS)
  );
  return [...keys]
    .filter((k) => a.clientHeaders[k] !== b.clientHeaders[k])
    .map(
      (k) =>
        `clientHeaders.${k}: ${JSON.stringify(a.clientHeaders[k])} vs ${JSON.stringify(b.clientHeaders[k])}`
    );
}

/**
 * `refreshRejectedProblems` on EVERY repetition: repetition i of the baseline against
 * repetition i of the candidate, with `diffs[i]` the diff of that pair.
 */
export function refreshRejectedAllReps(
  baseline: SideCapture[],
  candidate: SideCapture[],
  diffs: string[][]
): string[] {
  return baseline.flatMap((b, i) =>
    refreshRejectedProblems(b, candidate[i] as SideCapture, diffs[i] ?? []).map(
      (p) => `repetition ${i + 1}: ${p}`
    )
  );
}

/**
 * What proves a mutant's mutated code ran and changed what it was built to change: the
 * upstream request (method and exact path) and the diff paths the mutation must change.
 * A diff path is a `diffValues` path prefix; `[*]` matches any array index
 * (`$.fake[*].headers.originator`).
 */
export interface MutantEvidence {
  method: string;
  path: string;
  diffPaths: string[];
}

/** The path of one `diffValues` line (`$.a.b: baseline=… candidate=…`). */
export const diffPathOf = (line: string): string => line.slice(0, line.indexOf(": "));

/** True when `path` is `prefix` or lies under it; `[*]` in the prefix matches any index. */
export function underDiffPath(path: string, prefix: string): boolean {
  const re = new RegExp(
    `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\[\\\*\\\]/g, "\\[\\d+\\]")}(?=$|[.[])`
  );
  return re.test(path);
}

/**
 * One E20 mutant's outcome. A difference from the unmutated candidate is RED only when
 * the mutation's own upstream request reached the fake AND the difference lies under one of
 * the mutant's declared diff paths: without the request the mutated code never ran, and a
 * difference elsewhere (a crash, an unrelated field) proves nothing about the mutation.
 *
 * - any harness error (egress, leak, canary, redirect): ABORTED;
 * - the evidence request is absent: ABORTED (counted as an error, never red);
 * - evidence present and a difference under a declared path: `mutant red`;
 * - evidence present, differences, none under a declared path: ABORTED (difference elsewhere);
 * - evidence present and no difference: `DEAD-MUTANT`.
 */
export function mutantVerdict(input: {
  evidence: MutantEvidence;
  fake: ReadonlyArray<{ method: string; path: string }>;
  /** The `diffValues` lines against the unmutated candidate. */
  diff: string[];
  harnessErrors: string[];
}): { outcome: "mutant red" | "DEAD-MUTANT" | "ABORTED"; detail: string } {
  const want = `${input.evidence.method} ${input.evidence.path}`;
  if (input.harnessErrors.length > 0)
    return { outcome: "ABORTED", detail: input.harnessErrors.join("; ") };
  const seen = input.fake.map((q) => `${q.method} ${q.path}`);
  if (!seen.includes(want))
    return {
      outcome: "ABORTED",
      detail: `the mutation's upstream request ${want} never reached the fake (fake saw: ${seen.join(", ") || "nothing"})`,
    };
  if (input.diff.length === 0)
    return { outcome: "DEAD-MUTANT", detail: `${want} captured; no difference` };
  const paths = input.diff.map(diffPathOf);
  const onTarget = paths.filter((p) => input.evidence.diffPaths.some((d) => underDiffPath(p, d)));
  if (onTarget.length === 0)
    return {
      outcome: "ABORTED",
      detail: `${want} captured; ${paths.length} difference(s), none under ${input.evidence.diffPaths.join(" or ")} (differences at ${paths.join(", ")})`,
    };
  return {
    outcome: "mutant red",
    detail: `${want} captured; ${onTarget.length} of ${paths.length} difference(s) under ${input.evidence.diffPaths.join(" or ")}`,
  };
}

/**
 * A mutant run is evidence only if every standing check of its own run held:
 * canary self-test, pre-flight, egress, credential scan. Any failed `[standing]` check
 * means the harness, not the mutant, is suspect.
 */
export function standingBroken(checks: Array<{ ok: boolean; name: string }>): boolean {
  return checks.some((c) => !c.ok && c.name.startsWith("[standing]"));
}
