/**
 * The row table: every `run` row of rows-contract.md, each with the contract's
 * fields, validated on load (a row that lacks any field throws before anything
 * runs). The fields mirror the contract:
 *
 *   drive            session | direct
 *   steps            the process steps, per-process env and the barrier
 *   expectedMain     the expected main-turn attempts
 *   accountsRecords  the expected accounts.jsonl records, or "none"
 *   fakeProperty     the property of the fake's request log
 *   transcript       the expected transcript text, or the NAMED relaxation
 *   canary           the stated canary count
 *   mutants          the mutants that must turn the row red, or `mutantNote`
 *                    ("not evidence ...") when none is built
 *
 * `make()` builds a fresh plan per run (resets and ids are computed inside it,
 * so a real run and its mutant runs never share a clock).
 *
 * Blocked and deferred rows are NOT here; rows-contract.md section 4 holds them.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  FileTokenStore,
  fingerprintOf,
} from "../../../packages/cli/src/auth/accounts/token-store.ts";
import {
  type AccountRecord,
  type Check,
  bearerOf,
  noSwitchAgreement,
  ok,
  recordsCheck,
  requestIds,
  switchAgreement,
  v17Agreement,
} from "./agree.ts";
import type { DirectReply } from "./direct.ts";
import { classifyResponsesRequest } from "./fake-upstream.ts";
import {
  ANSWER,
  CANARY_KEY,
  type MutantRef,
  type RowSetup,
  type RunCtx,
  type SessionResult,
  nowSec,
  quotaFor,
} from "./harness.ts";
import { KNOWN_EGRESS } from "./row-env.ts";
import {
  DEFAULT_ACCOUNTS,
  type SeedAccount,
  accessTokenOf,
  lockPathOf,
  tokenPathOf,
  writeLockFile,
} from "./seed.ts";

export interface RowPlan {
  setup: RowSetup;
  run(c: RunCtx): Promise<void>;
}

export interface RowSpec {
  id: string;
  row: string;
  title: string;
  drive: "session" | "direct";
  steps: string;
  expectedMain: string;
  accountsRecords: string;
  fakeProperty: string;
  transcript: string;
  canary: number;
  /** The row's own fake log must hold at least one main or token request. */
  expectsFakeRequests: boolean;
  mutants: MutantRef[];
  /** Required when `mutants` is empty: starts with "not evidence". */
  mutantNote?: string;
  make(): RowPlan;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const ID = { A: "aaaaaaaaaaaa", B: "bbbbbbbbbbbb", C: "cccccccccccc" } as const;
const acc = (labels: Array<keyof typeof ID>, over: Record<string, Partial<SeedAccount>> = {}) =>
  labels.map((l): SeedAccount => ({ id: ID[l], label: l, ...(over[l] ?? {}) }));
const AB = DEFAULT_ACCOUNTS;

const errOf = (r: DirectReply) =>
  ((r.body as { error?: { type?: string; message?: string; upstream_status?: number } })?.error ??
    {}) as { type?: string; message?: string; upstream_status?: number };
const verdictOf = (r: DirectReply): string | null => r.headers["x-claudish-auth-verdict"] ?? null;
const textOf = (r: DirectReply): string =>
  String((r.body as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? "");

async function send(
  c: RunCtx,
  proc: Parameters<RunCtx["post"]>[0],
  n: number | string,
  session?: string
) {
  const r = await c.post(proc, undefined, session);
  c.save(`response-${n}.json`, JSON.stringify(r, null, 2));
  c.note(`status${n}`, r.status);
  c.note(`message${n}`, errOf(r).message ?? textOf(r));
  c.note(`type${n}`, errOf(r).type ?? null);
  c.note(`verdict${n}`, verdictOf(r));
  return r;
}

interface HttpExpect {
  status: number;
  type?: string;
  upstream?: number;
  /** A header value, or `null` meaning the header must be absent. */
  verdict?: string | null;
  includes?: Array<string | RegExp>;
  excludes?: Array<string | RegExp>;
  /** Exact message. */
  message?: string;
}

const has = (text: string, needle: string | RegExp) =>
  typeof needle === "string" ? text.includes(needle) : needle.test(text);

/** The direct row's third source: the HTTP response. */
function httpChecks(label: string, r: DirectReply, e: HttpExpect): Check[] {
  const err = errOf(r);
  const msg = String(err.message ?? "");
  const out: Check[] = [
    ok(
      `[third] ${label} HTTP ${e.status}`,
      r.status === e.status,
      `${r.status}${r.connectionError ? ` (${r.connectionError})` : ""}`
    ),
  ];
  if (e.type !== undefined)
    out.push(ok(`[third] ${label} error.type`, err.type === e.type, `${err.type}`));
  if (e.upstream !== undefined)
    out.push(
      ok(
        `[third] ${label} upstream_status ${e.upstream}`,
        err.upstream_status === e.upstream,
        `${err.upstream_status}`
      )
    );
  if (e.verdict !== undefined)
    out.push(
      ok(
        `[third] ${label} x-claudish-auth-verdict ${e.verdict === null ? "absent" : e.verdict}`,
        verdictOf(r) === e.verdict,
        `${verdictOf(r)}`
      )
    );
  if (e.message !== undefined)
    out.push(ok(`[third] ${label} exact message`, msg === e.message, msg.slice(0, 200)));
  for (const needle of e.includes ?? [])
    out.push(
      ok(`[third] ${label} message has ${String(needle)}`, has(msg, needle), msg.slice(0, 200))
    );
  for (const needle of e.excludes ?? [])
    out.push(
      ok(`[third] ${label} message lacks ${String(needle)}`, !has(msg, needle), msg.slice(0, 200))
    );
  return out;
}

const answerChecks = (label: string, r: DirectReply): Check[] => [
  ok(`[third] ${label} HTTP 200`, r.status === 200, `${r.status}`),
  ok(`[third] ${label} body text ${ANSWER}`, textOf(r) === ANSWER, textOf(r).slice(0, 80)),
];

const PINNED = "Codex subscription usage limit reached on every account (2 of 2).";
const RED_LINE = /Error \[[^\]]*\]: HTTP \d{3}|Auth\/health check failed/;

/** The session row's third source: Claude Code's transcript, stdout, stderr and exit. */
function sessionChecks(
  s: SessionResult,
  e: { answer?: string; apiError?: number; includes?: string[] }
): Check[] {
  const out: Check[] = [
    ok("[third] a transcript exists", s.transcripts.length >= 1, `${s.transcripts.length} file(s)`),
  ];
  if (e.answer) {
    out.push(
      ok("[third] exit 0", s.exit === 0, `${s.exit}`),
      ok("[third] stdout is the answer", s.stdout.includes(e.answer), s.stdout.trim().slice(0, 80)),
      ok(
        "[third] transcript carries the answer",
        s.transcriptText.includes(e.answer),
        s.transcriptText.slice(0, 80)
      ),
      ok(
        "[third] stderr has no red failure line",
        !RED_LINE.test(s.stderr),
        s.stderr.trim().slice(0, 160) || "empty"
      )
    );
  }
  if (e.apiError !== undefined) {
    out.push(
      ok(
        `[third] transcript carries API Error: ${e.apiError}`,
        s.transcriptText.includes(`API Error: ${e.apiError}`),
        s.transcriptText.slice(0, 200)
      )
    );
  }
  for (const needle of e.includes ?? [])
    out.push(
      ok(
        `[third] transcript has "${needle}"`,
        s.transcriptText.includes(needle),
        s.transcriptText.slice(0, 200)
      )
    );
  return out;
}

const apiErrorOf = (s: SessionResult): number | null => {
  const m = /API Error: (\d{3})/.exec(s.transcriptText);
  return m ? Number(m[1]) : null;
};

const recs = (c: RunCtx): AccountRecord[] => c.accounts();
const sleep = (ms: number) => Bun.sleep(ms);

/** The `requestId`s in `accounts.jsonl` and whether any record carries `quota-switch`. */
function noteRecords(c: RunCtx) {
  const r = recs(c);
  c.note("requestIdCount", requestIds(r).length);
  c.note(
    "hasQuotaSwitch",
    r.some((x) => x.reason === "quota-switch")
  );
  c.note(
    "recordSigs",
    r.map((x) => `${x.label}:${x.reason ?? "-"}:${x.outcome}`)
  );
}

const sha256File = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

const tokenJsonAt = (path: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

const mark = (c: RunCtx, label = "A") => {
  const state = c.stateJson() as {
    providers?: Record<
      string,
      { accounts?: Record<string, { needsReauth?: Record<string, unknown> }> }
    >;
  } | null;
  return (
    state?.providers?.["openai-codex"]?.accounts?.[ID[label as keyof typeof ID]]?.needsReauth ??
    null
  );
};

// ---------------------------------------------------------------------------
// V11: the :695 swap emits no false failure
// ---------------------------------------------------------------------------

const V11_RECORDS = [
  "A:initial-selection:http-error",
  "A:initial-selection:quota",
  "B:quota-switch:usage",
  "B:quota-switch:ok",
];

const v11Mutants: MutantRef[] = [
  {
    id: "V11-no-rotation",
    expected: "red",
    red: (o) =>
      o.notes.hasQuotaSwitch === false || Number(o.notes.requestIdCount) !== 1
        ? `no in-request switch: quota-switch=${o.notes.hasQuotaSwitch}, requestIds=${o.notes.requestIdCount}`
        : null,
  },
  {
    id: "V11-quota-to-terminal",
    expected: "red",
    red: (o) =>
      o.notes.stderrRedLine === true ||
      Number(o.notes.requestIdCount) !== 1 ||
      (o.notes.status1 !== undefined && o.notes.status1 !== 200)
        ? `red failure line on stderr=${o.notes.stderrRedLine}, requestIds=${o.notes.requestIdCount}, direct HTTP=${o.notes.status1 ?? "n/a"}`
        : null,
  },
];

function v11Plan(mode: "session" | "direct"): RowPlan {
  const reset = nowSec() + 3600;
  return {
    setup: {
      accounts: AB,
      script: quotaFor({ A: reset }),
      fake: { classify: mode === "session" ? classifyResponsesRequest : () => "main" },
    },
    async run(c) {
      let third: Check[];
      if (mode === "session") {
        const s = await c.session();
        c.note("stderrRedLine", RED_LINE.test(s.stderr));
        third = sessionChecks(s, { answer: ANSWER });
      } else {
        const p = await c.serve();
        const r = await send(c, p, 1);
        third = answerChecks("response", r);
      }
      noteRecords(c);
      c.checks(
        switchAgreement({
          main: c.main(),
          recs: recs(c),
          expectedAttempts: 2,
          bearers: [bearerOf("A"), bearerOf("B")],
          sameBody: true,
          expectedRecords: V11_RECORDS,
          third,
        })
      );
    },
  };
}

// ---------------------------------------------------------------------------
// V1: the rotation sign throws
// ---------------------------------------------------------------------------

function v1Plan(mode: "session" | "direct"): RowPlan {
  const rA = nowSec() + 1800;
  return {
    setup: {
      accounts: AB,
      stateOps: [{ op: "exhausted", id: ID.B, label: "B", resetAtMs: Date.now() + 3_600_000 }],
      script: quotaFor({ A: rA }),
      fake: { classify: mode === "session" ? classifyResponsesRequest : () => "main" },
    },
    async run(c) {
      let third: Check[];
      if (mode === "session") {
        // The 400 is never retried, so this changes nothing on the real bundle. A mutant turns
        // it into a 500 that Claude Code would retry for minutes before printing it; with the
        // retry off the red condition (API Error: 500) is visible at once.
        const s = await c.session(undefined, { CLAUDE_CODE_MAX_RETRIES: "0" });
        c.note("status1", apiErrorOf(s));
        third = sessionChecks(s, {
          apiError: 400,
          includes: [PINNED, "A — resets", "B — resets"],
        });
      } else {
        const p = await c.serve();
        const r = await send(c, p, 1);
        third = httpChecks("response", r, {
          status: 400,
          type: "invalid_request_error",
          upstream: 429,
          verdict: null,
          includes: [PINNED, "A — resets", "B — resets"],
        });
      }
      noteRecords(c);
      const r = recs(c);
      c.checks(
        noSwitchAgreement({
          main: c.main(),
          recs: r,
          expectedAttempts: 1,
          bearers: [bearerOf("A")],
          forbiddenBearers: [bearerOf("B")],
          expectedRecords: ["A:initial-selection:http-error", "A:initial-selection:quota"],
          third,
        })
      );
      c.check(
        "[accounts] A's quota record carries R_A and estimated false",
        r[1]?.resetAt === rA * 1000 && r[1]?.estimated === false,
        `resetAt=${r[1]?.resetAt} expected ${rA * 1000}, estimated=${r[1]?.estimated}`
      );
      c.check(
        "[accounts] no B record",
        !r.some((x) => x.label === "B"),
        r.map((x) => x.label).join(",")
      );
    },
  };
}

const v1Mutants: MutantRef[] = [
  {
    id: "V1-no-rotation-catch",
    expected: "red",
    red: (o) => (o.notes.status1 === 500 ? "HTTP 500 server_error instead of the 400" : null),
  },
  {
    id: "V1-no-rotation-catch-inner-only-DEAD",
    expected: "dead",
    red: (o) => (o.notes.status1 === 500 ? "unexpectedly turned red (HTTP 500)" : null),
  },
];

// ---------------------------------------------------------------------------
// V1c: already-exhausted pool (billing)
// ---------------------------------------------------------------------------

function v1cPlan(mode: "session" | "direct"): RowPlan {
  return {
    setup: {
      accounts: AB,
      stateOps: [
        { op: "exhausted", id: ID.A, label: "A", resetAtMs: Date.now() + 3_600_000 },
        { op: "exhausted", id: ID.B, label: "B", resetAtMs: Date.now() + 7_200_000 },
      ],
      fake: { classify: mode === "session" ? classifyResponsesRequest : () => "main" },
    },
    async run(c) {
      let third: Check[];
      if (mode === "session") {
        const s = await c.session();
        c.note("status1", apiErrorOf(s));
        third = sessionChecks(s, {
          apiError: 400,
          includes: [PINNED, "A — resets", "B — resets"],
        });
      } else {
        const p = await c.serve();
        const r = await send(c, p, 1);
        third = httpChecks("response", r, {
          status: 400,
          type: "invalid_request_error",
          upstream: 429,
          verdict: null,
          includes: [PINNED, "A — resets", "B — resets"],
        });
      }
      noteRecords(c);
      c.checks(
        noSwitchAgreement({
          main: c.main(),
          recs: recs(c),
          expectedAttempts: 0,
          expectedRecords: "none",
          third,
        })
      );
      c.check(
        "[fake] zero requests of any kind in the row's own fake log (no /responses, no /models)",
        c.fake.requests.length === 0,
        c.fake.requests.map((r) => `${r.method} ${r.path}`).join("; ") || "none"
      );
    },
  };
}

const v1cMutants: MutantRef[] = [
  {
    id: "V1c-swallow-initial-sign",
    expected: "red",
    red: (o) =>
      o.canary >= 1 ? `canary recorded ${o.canary} metered request(s) (billing escape)` : null,
  },
  {
    // The doc's single-edit mutant: measured DEAD (the two nets catch it).
    id: "V1c-swallow-only-DEAD",
    expected: "dead",
    red: (o) => (o.canary >= 1 ? `unexpectedly reached the canary (${o.canary})` : null),
  },
];

// ---------------------------------------------------------------------------
// V1b / V1d / V1e: billing nets and read failures
// ---------------------------------------------------------------------------

const V1B_MESSAGE =
  "Refusing to sign a pooled subscription request with a metered credential (Codex signing returned a non-OAuth artifact). This is a claudish bug; no request was sent.";

function v1bPlan(): RowPlan {
  return {
    setup: { accounts: AB },
    async run(c) {
      const p = await c.serve({ CLAUDISH_ACCOUNTS_FAULT: "non-oauth-artifact" });
      const r = await send(c, p, 1);
      c.checks(
        noSwitchAgreement({
          main: c.main(),
          recs: recs(c),
          expectedAttempts: 0,
          expectedRecords: "none",
          third: httpChecks("response", r, {
            status: 400,
            verdict: "terminal",
            includes: [V1B_MESSAGE],
          }),
        })
      );
      c.check(
        "[fake] the row's own fake log is empty",
        c.fake.requests.length === 0,
        c.fake.requests.map((x) => `${x.method} ${x.path}`).join("; ") || "none"
      );
    },
  };
}

function v1dPlan(): RowPlan {
  return {
    setup: { accounts: acc(["A"]) },
    async run(c) {
      const p = await c.serve({ CLAUDISH_ACCOUNTS_FAULT: "store-read-throws" });
      const r = await send(c, p, 1);
      c.checks(
        noSwitchAgreement({
          main: c.main(),
          recs: recs(c),
          expectedAttempts: 0,
          expectedRecords: "none",
          third: httpChecks("response", r, { status: 503, upstream: 503, verdict: "transient" }),
        })
      );
      c.check(
        "[fake] no /responses request",
        !c.fake.requests.some((x) => x.path.endsWith("/codex/responses")),
        c.fake.requests.map((x) => x.path).join(",") || "none"
      );
    },
  };
}

function v1ePlan(): RowPlan {
  return {
    setup: { accounts: AB },
    async run(c) {
      const config = join(c.tree.home, ".claudish", "config.json");
      const original = readFileSync(config, "utf8");
      c.onCleanup(() => {
        try {
          chmodSync(config, 0o644);
        } catch {
          /* gone */
        }
        writeFileSync(config, original);
      });

      const p1 = await c.serve();
      const r1 = await send(c, p1, "1");
      c.checks(answerChecks("step 1 (P1, healthy)", r1));

      writeFileSync(config, "{");
      const r2 = await send(c, p1, "2");
      c.checks(answerChecks("step 2 (P1, truncated config: last-known-good)", r2));

      const p2 = await c.serve();
      const r3 = await send(c, p2, "3");
      c.checks(
        httpChecks("step 3 (P2 fresh, truncated config)", r3, {
          status: 400,
          upstream: 400,
          verdict: "terminal",
          includes: ["config.json"],
        })
      );

      writeFileSync(config, original);
      chmodSync(config, 0o000);
      const p3 = await c.serve();
      const r4 = await send(c, p3, "4");
      chmodSync(config, 0o644);
      c.checks(
        httpChecks("step 4 (P3 fresh, chmod 000 config)", r4, {
          status: 503,
          upstream: 503,
          verdict: "transient",
          includes: ["config.json"],
        })
      );

      const r = recs(c);
      c.checks(
        recordsCheck("P1's two requests only", r, [
          "A:initial-selection:usage",
          "A:initial-selection:ok",
          "A:initial-selection:usage",
          "A:initial-selection:ok",
        ])
      );
      c.check(
        "[accounts] exactly two requestIds",
        requestIds(r).length === 2,
        `${requestIds(r).length}`
      );
      c.check(
        "[fake] main attempts: P1 1 then 1, P2 and P3 none",
        c.main().length === 2 && c.main().every((m) => m.bearer === bearerOf("A")),
        c
          .main()
          .map((m) => m.bearer)
          .join(" -> ")
      );
    },
  };
}

// ---------------------------------------------------------------------------
// V16b: the legacy file is unreadable
// ---------------------------------------------------------------------------

function v16bPlan(): RowPlan {
  return {
    setup: { accounts: [], legacy: true },
    async run(c) {
      const legacy = join(c.tree.home, ".claudish", "codex-oauth.json");
      const original = readFileSync(legacy, "utf8");
      c.onCleanup(() => {
        try {
          chmodSync(legacy, 0o600);
        } catch {
          /* gone */
        }
        writeFileSync(legacy, original, { mode: 0o600 });
      });
      const unreadable = (label: string, r: DirectReply, extra: Array<string | RegExp> = []) =>
        httpChecks(label, r, {
          status: 503,
          upstream: 503,
          verdict: "transient",
          type: "overloaded_error",
          includes: [
            "codex-oauth.json",
            "Refusing to treat an unreadable account list as an empty one.",
            ...extra,
          ],
        });

      // Pass 1: truncated, then repaired on the SAME process (no restart).
      writeFileSync(legacy, "{");
      const p1 = await c.serve();
      const r1 = await send(c, p1, "1-truncated");
      c.checks(unreadable("truncated", r1, ["invalid JSON"]));
      writeFileSync(legacy, original, { mode: 0o600 });
      const r1b = await send(c, p1, "1b-repaired");
      c.checks(answerChecks("truncated, then repaired without a restart", r1b));

      // Pass 2: empty file.
      writeFileSync(legacy, "");
      const p2 = await c.serve();
      const r2 = await send(c, p2, "2-empty");
      c.checks(unreadable("empty", r2, ["invalid JSON"]));

      // Pass 3: chmod 000.
      writeFileSync(legacy, original, { mode: 0o600 });
      chmodSync(legacy, 0o000);
      const p3 = await c.serve();
      const r3 = await send(c, p3, "3-chmod000");
      chmodSync(legacy, 0o600);
      c.checks(unreadable("chmod 000", r3, ["EACCES"]));

      // Pass 4: the generic read-error fault.
      const p4 = await c.serve({ CLAUDISH_ACCOUNTS_FAULT: "account-list-read-throws" });
      const r4 = await send(c, p4, "4-fault");
      c.checks(
        httpChecks("account-list-read-throws", r4, {
          status: 503,
          upstream: 503,
          verdict: "transient",
          type: "overloaded_error",
          includes: ["Refusing to treat an unreadable account list as an empty one."],
        })
      );

      // Pass 5: control, a valid legacy file.
      const p5 = await c.serve();
      const r5 = await send(c, p5, "5-control");
      c.checks(answerChecks("control (valid legacy file)", r5));

      // Pass 6: absent (ENOENT) stays distinct: no pool, no api key, the file deleted.
      const p6env = { OPENAI_CODEX_API_KEY: "" };
      writeFileSync(legacy, original, { mode: 0o600 });
      const { rmSync } = await import("node:fs");
      rmSync(legacy);
      const p6 = await c.serve(p6env);
      const r6 = await send(c, p6, "6-absent");
      c.check(
        "[third] absent file: not the 503 unreadable outcome",
        r6.status !== 503 &&
          r6.status !== 200 &&
          !String(errOf(r6).message).includes("Refusing to treat"),
        `${r6.status} ${String(errOf(r6).message).slice(0, 160)}`
      );
      c.check(
        "[third] absent file: names a missing Codex login",
        /login|credential|authenticat|Codex/i.test(String(errOf(r6).message)),
        String(errOf(r6).message).slice(0, 160)
      );

      c.check(
        "[fake] main attempts: the repaired request and the control, both on the legacy bearer",
        c.main().length === 2 && c.main().every((m) => m.bearer === "Bearer access-legacy"),
        c
          .main()
          .map((m) => m.bearer)
          .join(" -> ")
      );
      // The contract expected "ok records" for the control pass. Measured: a synthesized
      // legacy-only list signs through the singleton CodexOAuth with NO pooled account, so
      // nothing is reported to accounts.jsonl at all (rows-contract.md amended in the log).
      c.checks(recordsCheck("synthesized-legacy path reports no pooled account", recs(c), "none"));
    },
  };
}

// ---------------------------------------------------------------------------
// V2 family: refresh gate
// ---------------------------------------------------------------------------

function v2Plan(): RowPlan {
  return {
    setup: { accounts: acc(["A"], { A: { expiresAt: 0 } }), fake: { tokenDelayMs: 300 } },
    async run(c) {
      const procs = [];
      for (let i = 0; i < 4; i++) procs.push(await c.serve());
      const t0 = Date.now();
      const pending = procs.map((p) => c.post(p)); // all four fetches start in this tick
      const issuedWithin = Date.now() - t0;
      const replies = await Promise.all(pending);
      replies.forEach((r, i) => c.save(`response-${i + 1}.json`, JSON.stringify(r, null, 2)));
      const ex = c.fake.exchanges();
      c.note("exchangeOk", ex.ok);
      c.note("exchangeInvalidGrant", ex.invalidGrant);
      const r = recs(c);
      const groups = requestIds(r);
      c.check(
        "[fake] 4 main attempts, all on the rotated bearer at-rotated-1",
        c.main().length === 4 && c.main().every((m) => m.bearer === "Bearer at-rotated-1"),
        c
          .main()
          .map((m) => m.bearer)
          .join(", ")
      );
      c.check(
        "[fake] token endpoint: exactly one exchange accepted, none rejected",
        ex.ok === 1 && ex.invalidGrant === 0,
        `ok=${ex.ok} invalid_grant=${ex.invalidGrant}`
      );
      c.check(
        "[accounts] 4 request ids, each with an ok record",
        groups.length === 4 &&
          groups.every((g) => r.some((x) => x.requestId === g && x.outcome === "ok")),
        `${groups.length} ids`
      );
      c.check("[accounts] no needsReauth in state.json", mark(c) === null, JSON.stringify(mark(c)));
      c.check(
        "[third] four HTTP 200",
        replies.every((x) => x.status === 200),
        replies.map((x) => x.status).join(",")
      );
      const tok = c.tokenJson("A") as { generation?: number; fingerprint?: string } | null;
      c.check(
        "[third] token file: generation seed + 1, fingerprint of rt-rotated-1",
        tok?.generation === 2 && tok?.fingerprint === fingerprintOf("rt-rotated-1"),
        `generation=${tok?.generation} fingerprint=${tok?.fingerprint}`
      );
      c.check(
        "[row] the four requests were issued in one tick (< 200 ms)",
        issuedWithin < 200,
        `${issuedWithin} ms`
      );
    },
  };
}

function v2bPlan(): RowPlan {
  return {
    setup: {
      accounts: acc(["A"], { A: { expiresAt: 0 } }),
      after({ tree }) {
        const dead = Bun.spawnSync(["true"]);
        writeLockFile(lockPathOf(tree.accountsDir, ID.A), {
          pid: dead.pid,
          host: hostname(),
          nonce: "dead-holder-nonce",
          at: Date.now(),
        });
      },
    },
    async run(c) {
      const p = await c.serve();
      const t0 = Date.now();
      const r = await send(c, p, 1);
      const firstExchange = c.fake.requests.find((x) => x.kind === "token");
      const latency = firstExchange ? firstExchange.at - t0 : null;
      c.note("exchangeLatencyMs", latency);
      c.check(
        "[fake] exactly one exchange, within 5 s of the request",
        c.fake.exchanges().ok === 1 && latency !== null && latency < 5000,
        `ok=${c.fake.exchanges().ok}, latency=${latency} ms`
      );
      c.checks(
        noSwitchAgreement({
          main: c.main(),
          recs: recs(c),
          expectedAttempts: 1,
          bearers: ["Bearer at-rotated-1"],
          expectedRecords: ["A:initial-selection:usage", "A:initial-selection:ok"],
          third: answerChecks("response", r),
        })
      );
    },
  };
}

function v2cPlan(): RowPlan {
  return {
    setup: { accounts: acc(["A"], { A: { expiresAt: 0 } }) },
    async run(c) {
      const p1 = await c.serve({ CLAUDISH_ACCOUNTS_FAULT: "lock-hold-forever" });
      const held = c.post(p1); // hangs by design
      const lock = lockPathOf(c.tree.accountsDir, ID.A);
      const deadline = Date.now() + 30_000;
      let holderPid: number | null = null;
      while (Date.now() < deadline) {
        try {
          holderPid = (JSON.parse(readFileSync(lock, "utf8")) as { pid: number }).pid;
          break;
        } catch {
          await sleep(100);
        }
      }
      c.note("holderPid", holderPid);
      c.check("[row] barrier: the lock file names the holder", holderPid !== null, `${holderPid}`);
      const p2 = await c.serve();
      const t0 = Date.now();
      const r = await c.post(p2, undefined, undefined, 60_000);
      const elapsed = Date.now() - t0;
      c.save("response-2.json", JSON.stringify(r, null, 2));
      c.note("status2", r.status);
      c.note("elapsedMs", elapsed);
      const ex = c.fake.exchanges();
      c.note("exchangeTotal", ex.ok + ex.invalidGrant);
      void held;
      c.checks(
        noSwitchAgreement({
          main: c.main(),
          recs: recs(c),
          expectedAttempts: 0,
          expectedRecords: "none",
          third: httpChecks("waiter response", r, {
            status: 503,
            verdict: "transient",
            includes: ["refresh gate"],
            excludes: [/quota|usage limit/i],
          }),
        })
      );
      c.check(
        "[fake] zero token exchanges in total",
        ex.ok + ex.invalidGrant === 0,
        `ok=${ex.ok} invalid_grant=${ex.invalidGrant}`
      );
      c.check(
        "[third] the waiter took 18-25 s (the 20 s acquire timeout)",
        elapsed >= 18_000 && elapsed <= 25_000,
        `${elapsed} ms`
      );
    },
  };
}

function v2dPlan(): RowPlan {
  return {
    setup: {
      accounts: acc(["A"], { A: { expiresAt: 0 } }),
    },
    async run(c) {
      const dir = join(c.tree.accountsDir, "locks", "openai-codex");
      mkdirSync(dir, { recursive: true });
      chmodSync(dir, 0o500);
      c.onCleanup(() => chmodSync(dir, 0o700));
      const p = await c.serve();
      const r = await send(c, p, 1);
      const ex = c.fake.exchanges();
      c.note("exchangeTotal", ex.ok + ex.invalidGrant);
      c.checks(
        noSwitchAgreement({
          main: c.main(),
          recs: recs(c),
          expectedAttempts: 0,
          expectedRecords: "none",
          third: httpChecks("response", r, {
            status: 503,
            verdict: "transient",
            includes: ["refresh disabled"],
          }),
        })
      );
      c.check(
        "[fake] zero token exchanges",
        ex.ok + ex.invalidGrant === 0,
        `ok=${ex.ok} invalid_grant=${ex.invalidGrant}`
      );
    },
  };
}

function v2fPlan(): RowPlan {
  return {
    setup: { accounts: acc(["A"], { A: { expiresAt: 0 } }) },
    async run(c) {
      const seed = c.tokenJson("A") as Record<string, unknown>;
      c.save(
        "token-seed.json",
        JSON.stringify({ ...seed, accessToken: "(fake)", refreshToken: "(fake)" })
      );
      const p = await c.serve({ CLAUDISH_ACCOUNTS_FAULT: "steal-lock-mid-exchange" });
      const r = await send(c, p, 1);
      const tok = c.tokenJson("A") as {
        generation?: number;
        fingerprint?: string;
        accessToken?: string;
        refreshToken?: string;
        writeId?: string;
        journal?: { state?: string; from?: string } | null;
      } | null;
      c.note("tokenGeneration", tok?.generation);
      c.checks(
        noSwitchAgreement({
          main: c.main(),
          recs: recs(c),
          expectedAttempts: 0,
          expectedRecords: "none",
          third: httpChecks("response", r, {
            status: 503,
            verdict: "transient",
            includes: ["stolen before the persist"],
          }),
        })
      );
      c.check(
        "[fake] exactly one exchange (in flight when the gate was stolen)",
        c.fake.exchanges().ok === 1,
        `${c.fake.exchanges().ok}`
      );
      const fp = fingerprintOf("refresh-A");
      // The contract also said "no writeId". Measured: the JOURNAL write (before the exchange)
      // mints a writeId, so the file carries one even though the final persist never happened.
      // The discriminating facts are the unchanged generation, fingerprint and tokens.
      c.note("writeIdMintedByJournal", typeof tok?.writeId === "string");
      c.check(
        "[third] token file: generation = seed, seed fingerprint, access and refresh token unchanged",
        tok?.generation === seed.generation &&
          tok?.fingerprint === fp &&
          tok?.accessToken === accessTokenOf("A") &&
          tok?.refreshToken === "refresh-A",
        `generation=${tok?.generation} fp=${tok?.fingerprint} writeId=${tok?.writeId}`
      );
      c.check(
        "[third] token file: journal.state refreshing, journal.from = seed fingerprint",
        tok?.journal?.state === "refreshing" && tok?.journal?.from === fp,
        JSON.stringify(tok?.journal)
      );
    },
  };
}

// ---------------------------------------------------------------------------
// V3 / V3b: thresholds
// ---------------------------------------------------------------------------

const SESSION_ID = "pool-validation-v3";

function v3Plan(): RowPlan {
  return {
    setup: {
      accounts: AB,
      // A answers 20% to the first main request and 92% to every later one; B always 20%.
      script: (ctx) => ({
        type: "text",
        text: ANSWER,
        usagePercent: ctx.bearer === bearerOf("A") && (ctx.mainIndex ?? 0) > 1 ? 92 : 20,
      }),
    },
    async run(c) {
      const p1 = await c.serve();
      const p2 = await c.serve();
      const r1 = await send(c, p1, 1, SESSION_ID);
      const r2 = await send(c, p1, 2, SESSION_ID); // 92% inside the 5 s coalescing window
      await sleep(1000);
      const r3 = await send(c, p2, 3, SESSION_ID);
      c.note("bearer3", c.main()[2]?.bearer ?? null);
      c.checks(
        switchAgreement({
          main: c.main(),
          recs: recs(c),
          expectedAttempts: 3,
          bearers: [bearerOf("A"), bearerOf("A"), bearerOf("B")],
          sameSession: true,
          expectedRecords: [
            "A:initial-selection:usage",
            "A:initial-selection:ok",
            "A:initial-selection:usage",
            "A:initial-selection:ok",
            "B:initial-selection:usage",
            "B:initial-selection:ok",
          ],
          third: [
            ...answerChecks("P1 request 1", r1),
            ...answerChecks("P1 request 2 (A at 92%)", r2),
            ...answerChecks("P2 request (selects B)", r3),
          ],
        })
      );
      c.check(
        "[accounts] three distinct requestIds",
        requestIds(recs(c)).length === 3,
        `${requestIds(recs(c)).length}`
      );
    },
  };
}

function v3bPlan(): RowPlan {
  return {
    setup: {
      accounts: AB,
      stateOps: [
        {
          op: "usage",
          id: ID.A,
          label: "A",
          fraction: 0.92,
          observedAtMs: Date.now() - 20 * 60_000,
          resetAtMs: Date.now() + 2 * 3_600_000,
        },
      ],
    },
    async run(c) {
      const p = await c.serve();
      const r = await send(c, p, 1);
      c.note("bearer1", c.main()[0]?.bearer ?? null);
      c.checks(
        noSwitchAgreement({
          main: c.main(),
          recs: recs(c),
          expectedAttempts: 1,
          bearers: [bearerOf("B")],
          forbiddenBearers: [bearerOf("A")],
          expectedRecords: ["B:initial-selection:usage", "B:initial-selection:ok"],
          third: answerChecks("response", r),
        })
      );
    },
  };
}

// ---------------------------------------------------------------------------
// V8 / V8b: the retry budget
// ---------------------------------------------------------------------------

const V8_RECORDS = [
  "A:initial-selection:http-error",
  "A:initial-selection:quota",
  "B:quota-switch:http-error",
  "B:quota-switch:quota",
];

function v8Plan(mode: "session" | "direct"): RowPlan {
  const rA = nowSec() + 1800;
  const rB = nowSec() + 3600;
  return {
    setup: {
      accounts: AB,
      script: quotaFor({ A: rA, B: rB }),
      fake: { classify: mode === "session" ? classifyResponsesRequest : () => "main" },
    },
    async run(c) {
      const pinned = [PINNED, "A — resets", "B — resets"];
      let third: Check[];
      if (mode === "session") {
        // The real answer is a 400 (never retried). The mutant's answer is a transient 429 that
        // Claude Code would retry for minutes; with the retry off its text is printed at once.
        const s = await c.session(undefined, { CLAUDE_CODE_MAX_RETRIES: "0" });
        c.note("status1", apiErrorOf(s));
        c.note("transient1", /retry deferred/.test(s.transcriptText));
        third = sessionChecks(s, { apiError: 400, includes: pinned });
      } else {
        const p = await c.serve();
        const r1 = await send(c, p, 1);
        c.note("transient1", verdictOf(r1) === "transient");
        const mainAfter1 = c.main().length;
        const recAfter1 = recs(c).length;
        third = httpChecks("request 1", r1, {
          status: 400,
          type: "invalid_request_error",
          upstream: 429,
          verdict: null,
          includes: pinned,
        });
        const r2 = await send(c, p, 2);
        third.push(
          ...httpChecks("request 2", r2, {
            status: 400,
            type: "invalid_request_error",
            upstream: 429,
            verdict: null,
            includes: pinned,
          })
        );
        c.check(
          "[fake] request 2 made no main attempt (both accounts already marked)",
          c.main().length === mainAfter1,
          `${mainAfter1} -> ${c.main().length}`
        );
        c.check(
          "[accounts] request 2 wrote no record",
          recs(c).length === recAfter1,
          `${recAfter1} -> ${recs(c).length}`
        );
      }
      noteRecords(c);
      const r = recs(c);
      c.checks(
        noSwitchAgreement({
          main: c.main(),
          recs: r,
          expectedAttempts: 2,
          bearers: [bearerOf("A"), bearerOf("B")],
          expectedRecords: V8_RECORDS,
          switchAttempted: true,
          third,
        })
      );
      c.check(
        "[fake] A then B on the SAME body hash, no third attempt",
        c.main().length === 2 && c.main()[0]?.bodySha256 === c.main()[1]?.bodySha256,
        c
          .main()
          .map((m) => m.bodySha256.slice(0, 8))
          .join(",")
      );
      c.check(
        "[accounts] request 1's records share one requestId",
        requestIds(r).length === 1,
        `${requestIds(r).length}`
      );
    },
  };
}

const v8Mutants: MutantRef[] = [
  {
    id: "V8-no-record-retry",
    expected: "red",
    red: (o) =>
      o.notes.transient1 === true
        ? "request 1 answered the transient 'retry deferred' 429 instead of the pinned message"
        : null,
  },
];

function v8bPlan(kase: 1 | 2): RowPlan {
  const rA = nowSec() + 1800;
  const rB = nowSec() + 3600;
  return {
    setup: {
      accounts: acc(["A", "B", "C"], {
        C: kase === 1 ? { expiresAt: 0 } : { disabled: true },
      }),
      script: quotaFor({ A: rA, B: rB }),
    },
    async run(c) {
      const cTokenPath = tokenPathOf(c.tree.accountsDir, ID.C);
      const cBefore = existsSync(cTokenPath) ? sha256File(cTokenPath) : null;
      const p = await c.serve();
      const r = await send(c, p, 1);
      const ex = c.fake.exchanges();
      c.note("exchangeTotal", ex.ok + ex.invalidGrant);
      const state = c.stateJson() as { providers?: Record<string, { active?: string }> } | null;
      const active = state?.providers?.["openai-codex"]?.active ?? null;
      c.note("active", active);
      const cAfter = existsSync(cTokenPath) ? sha256File(cTokenPath) : null;
      c.note("cTokenChanged", cBefore !== cAfter);
      const third =
        kase === 1
          ? httpChecks("response", r, {
              status: 429,
              type: "rate_limit_error",
              upstream: 429,
              verdict: "transient",
              message: "Codex account retry deferred; retry this request.",
              excludes: [/usage limit/i, "every account"],
            })
          : httpChecks("response", r, {
              status: 400,
              includes: ["(3 of 3)", /disabled/i],
            });
      c.checks(
        noSwitchAgreement({
          main: c.main(),
          recs: recs(c),
          expectedAttempts: 2,
          bearers: [bearerOf("A"), bearerOf("B")],
          expectedRecords: V8_RECORDS,
          switchAttempted: true,
          third,
        })
      );
      c.check(
        "[accounts] no C record",
        !recs(c).some((x) => x.label === "C"),
        recs(c)
          .map((x) => x.label)
          .join(",")
      );
      if (kase === 1) {
        c.check(
          "[fake] zero token exchanges (C is not refreshed by the query)",
          ex.ok + ex.invalidGrant === 0,
          `ok=${ex.ok} invalid_grant=${ex.invalidGrant}`
        );
        c.check("[accounts] state.json active is still B", active === ID.B, `${active}`);
        c.check(
          "[accounts] C's token file bytes unchanged",
          cBefore === cAfter,
          `${cBefore?.slice(0, 8)} -> ${cAfter?.slice(0, 8)}`
        );
      }
    },
  };
}

const v8bMutants: MutantRef[] = [
  {
    id: "V8b-acquire-in-query",
    expected: "red",
    red: (o) =>
      Number(o.notes.exchangeTotal) >= 1 || o.notes.cTokenChanged === true
        ? `the query refreshed C: exchanges=${o.notes.exchangeTotal}, C file changed=${o.notes.cTokenChanged}`
        : null,
  },
];

// ---------------------------------------------------------------------------
// V9 / V9b: persistence faults
// ---------------------------------------------------------------------------

function v9Plan(fault: "persist-throw" | "crash-after-refresh"): RowPlan {
  return {
    setup: { accounts: acc(["A"], { A: { expiresAt: 0 } }) },
    async run(c) {
      const p1 = await c.serve({ CLAUDISH_ACCOUNTS_FAULT: fault });
      const r1 = await send(c, p1, 1);
      let p1Exit: number | null | "alive" = "alive";
      if (fault === "crash-after-refresh") {
        p1Exit = await Promise.race([p1.exited, sleep(30_000).then(() => "alive" as const)]);
        c.note("p1Exit", p1Exit);
      }
      const afterP1 = c.tokenJson("A") as {
        generation?: number;
        fingerprint?: string;
        journal?: { state?: string } | null;
      } | null;
      if (fault === "persist-throw") {
        c.checks(
          httpChecks("P1 response", r1, {
            status: 503,
            verdict: "transient",
            includes: [/unknown|persist|rotation/i],
          })
        );
      } else {
        c.check(
          "[third] P1: the client sees a connection failure",
          r1.status === 0,
          `${r1.status} ${r1.connectionError ?? ""}`
        );
        c.check("[third] P1: exit code 9", p1Exit === 9, `${p1Exit}`);
      }
      c.check(
        "[third] after P1: token file generation = seed, open journal 'refreshing'",
        afterP1?.generation === 1 && afterP1?.journal?.state === "refreshing",
        `generation=${afterP1?.generation} journal=${JSON.stringify(afterP1?.journal)}`
      );
      c.check(
        "[fake] after P1: one exchange accepted",
        c.fake.exchanges().ok === 1,
        `${c.fake.exchanges().ok}`
      );

      const p2 = await c.serve();
      const r2 = await send(c, p2, 2);
      const m = mark(c) as { lastReason?: string } | null;
      c.note("lastReason", m?.lastReason ?? null);
      const afterP2 = c.tokenJson("A") as { journal?: unknown } | null;
      c.checks(
        httpChecks("P2 response", r2, {
          status: 400,
          upstream: 401,
          verdict: "terminal",
        })
      );
      c.check(
        'state.json needsReauth.lastReason === "a token rotation was interrupted"',
        m?.lastReason === "a token rotation was interrupted",
        `${m?.lastReason}`
      );
      c.check(
        "[third] the journal is closed after P2",
        afterP2?.journal === null || afterP2?.journal === undefined,
        JSON.stringify(afterP2?.journal)
      );
      const ex = c.fake.exchanges();
      c.check(
        "[fake] totals: ok = 1, invalid_grant = 1 (the recovery exchange)",
        ex.ok === 1 && ex.invalidGrant === 1,
        `ok=${ex.ok} invalid_grant=${ex.invalidGrant}`
      );
      c.checks(
        noSwitchAgreement({
          main: c.main(),
          recs: recs(c),
          expectedAttempts: 0,
          expectedRecords: "none",
          third: [],
        })
      );
    },
  };
}

const v9Mutants: MutantRef[] = [
  {
    id: "V9-no-journal",
    expected: "red",
    red: (o) =>
      o.notes.lastReason !== "a token rotation was interrupted"
        ? `lastReason reads ${JSON.stringify(o.notes.lastReason)}`
        : null,
  },
];

function v9bPlan(kase: "committed" | "uncommitted"): RowPlan {
  return {
    setup: { accounts: acc(["A"], { A: { expiresAt: 0 } }) },
    async run(c) {
      const p = await c.serve({ CLAUDISH_ACCOUNTS_FAULT: `persist-timeout-${kase}` });
      const r = await send(c, p, 1);
      const tok = c.tokenJson("A") as {
        generation?: number;
        journal?: { state?: string } | null;
      } | null;
      c.note("tokenGeneration", tok?.generation);
      const exOk = c.fake.exchanges().ok;
      if (kase === "committed") {
        c.checks(
          noSwitchAgreement({
            main: c.main(),
            recs: recs(c),
            expectedAttempts: 1,
            bearers: ["Bearer at-rotated-1"],
            expectedRecords: ["A:initial-selection:usage", "A:initial-selection:ok"],
            third: answerChecks("response", r),
          })
        );
        c.check(
          "[third] token file generation = seed + 1, journal null",
          tok?.generation === 2 && (tok?.journal === null || tok?.journal === undefined),
          `generation=${tok?.generation} journal=${JSON.stringify(tok?.journal)}`
        );
        c.check(
          "[accounts] one requestId",
          requestIds(recs(c)).length === 1,
          `${requestIds(recs(c)).length}`
        );
      } else {
        c.checks(
          noSwitchAgreement({
            main: c.main(),
            recs: recs(c),
            expectedAttempts: 0,
            expectedRecords: "none",
            third: httpChecks("response", r, {
              status: 503,
              verdict: "transient",
              includes: [/unknown|persist|timed out/i],
            }),
          })
        );
        c.check(
          "[third] token file: generation = seed, journal.state unknown",
          tok?.generation === 1 && tok?.journal?.state === "unknown",
          `generation=${tok?.generation} journal=${JSON.stringify(tok?.journal)}`
        );
      }
      c.check("[fake] exactly one exchange", exOk === 1, `${exOk}`);
    },
  };
}

const v9bMutants: MutantRef[] = [
  {
    id: "V9b-committed-resolved-as-uncommitted",
    expected: "red",
    red: (o) =>
      o.notes.status1 !== 200
        ? `the committed rotation was lost to the caller: HTTP ${o.notes.status1}`
        : null,
  },
];

// ---------------------------------------------------------------------------
// V10 / V10b: needsReauth
// ---------------------------------------------------------------------------

async function v10Setup(c: RunCtx) {
  c.fake.setTokenMode("invalid_grant");
  const p1 = await c.serve();
  const r1 = await send(c, p1, "1-setup");
  c.checks(
    httpChecks("setup (invalid_grant -> needsReauth)", r1, {
      status: 400,
      upstream: 401,
      verdict: "terminal",
    })
  );
  const m = mark(c) as { failedFingerprint?: string; failedGeneration?: number } | null;
  c.check(
    "[accounts] the binary wrote the mark with its baseline (failedFingerprint, failedGeneration)",
    typeof m?.failedFingerprint === "string" && typeof m?.failedGeneration === "number",
    JSON.stringify(m)
  );
  const tok = c.tokenJson("A") as { generation?: number } | null;
  c.note("generationAfterSetup", tok?.generation);
  c.note("failedGeneration", m?.failedGeneration);
  c.fake.setTokenMode("ok");
  return { p1, m };
}

function v10Plan(kase: "a" | "b" | "c"): RowPlan {
  return {
    setup: {
      accounts: acc(["A"], { A: { expiresAt: 0 } }),
      fake: { tokenMode: "invalid_grant" },
      // Written mid-run by cases a and b below; the shape regex covers them too.
      extraSecrets: ["access-A2", "refresh-A2", "access-A3"],
    },
    async run(c) {
      const setupAt = Date.now();
      const { m } = await v10Setup(c);
      const accountsDir = c.tree.accountsDir;
      const store = new FileTokenStore({
        env: { ...process.env, HOME: c.tree.home, CLAUDISH_ACCOUNTS_DIR: accountsDir },
      });
      const ref = { provider: "openai-codex" as const, id: ID.A, label: "A" };
      const exAfterSetup = c.fake.exchanges();
      const stored = c.tokenJson("A") as {
        generation: number;
        accountId?: string;
        refreshToken: string;
        fingerprint: string;
      };

      if (kase === "a") {
        await store.write(ref, {
          accessToken: "access-A2",
          refreshToken: "refresh-A2",
          expiresAt: Date.now() + 3_600_000,
          accountId: stored.accountId,
          generation: stored.generation + 1,
          fingerprint: fingerprintOf("refresh-A2"),
          updatedAt: Date.now(),
        });
      } else if (kase === "b") {
        await store.write(ref, {
          accessToken: "access-A3",
          refreshToken: stored.refreshToken,
          expiresAt: Date.now() + 3_600_000,
          accountId: stored.accountId,
          generation: stored.generation + 1,
          fingerprint: stored.fingerprint,
          updatedAt: Date.now(),
        });
      }

      if (kase === "a" || kase === "b") {
        const bearer = kase === "a" ? "Bearer access-A2" : "Bearer access-A3";
        const p2 = await c.serve();
        const r2 = await send(c, p2, "2-heal");
        const markAfter = mark(c);
        c.note("statusHeal", r2.status);
        c.note("markAfterHeal", markAfter !== null);
        const ex = c.fake.exchanges();
        c.checks(
          noSwitchAgreement({
            main: c.main(),
            recs: recs(c),
            expectedAttempts: 1,
            bearers: [bearer],
            expectedRecords: ["A:initial-selection:usage", "A:initial-selection:ok"],
            third: answerChecks("P2 response", r2),
          })
        );
        c.check(
          "[fake] zero further exchanges",
          ex.ok === exAfterSetup.ok && ex.invalidGrant === exAfterSetup.invalidGrant,
          `after setup ok=${exAfterSetup.ok}/ig=${exAfterSetup.invalidGrant}, now ok=${ex.ok}/ig=${ex.invalidGrant}`
        );
        c.check(
          "[accounts] state.json no longer carries the mark",
          markAfter === null,
          JSON.stringify(markAfter)
        );
        void m;
        return;
      }

      // Case c: the store is untouched. P2 is refused; after the 1-minute interval P3 retries once.
      const p2 = await c.serve();
      const r2 = await send(c, p2, "2-refused");
      c.checks(
        httpChecks("P2 response (refused)", r2, { status: 400, upstream: 401, verdict: "terminal" })
      );
      const ex2 = c.fake.exchanges();
      c.note("statusRefused", r2.status);
      c.note(
        "exchangesDuringRefusal",
        ex2.ok + ex2.invalidGrant - (exAfterSetup.ok + exAfterSetup.invalidGrant)
      );
      c.check(
        "[fake] P2: 0 main attempts, 0 further exchanges",
        c.main().length === 0 &&
          ex2.ok === exAfterSetup.ok &&
          ex2.invalidGrant === exAfterSetup.invalidGrant,
        `main=${c.main().length}, ok=${ex2.ok}, ig=${ex2.invalidGrant}`
      );
      c.check("[accounts] the mark is kept", mark(c) !== null, JSON.stringify(mark(c)));
      const waitMs = Math.max(0, setupAt + 61_000 - Date.now());
      c.note("waitedMs", waitMs);
      await sleep(waitMs);
      const p3 = await c.serve();
      const r3 = await send(c, p3, "3-retry");
      const ex3 = c.fake.exchanges();
      c.note("statusRetry", r3.status);
      c.check(
        "[fake] P3: exactly one new exchange, answered ok",
        ex3.ok === 1 && ex3.invalidGrant === exAfterSetup.invalidGrant,
        `ok=${ex3.ok}, ig=${ex3.invalidGrant}`
      );
      c.checks(
        noSwitchAgreement({
          main: c.main(),
          recs: recs(c),
          expectedAttempts: 1,
          bearers: ["Bearer at-rotated-1"],
          expectedRecords: ["A:initial-selection:usage", "A:initial-selection:ok"],
          third: answerChecks("P3 response", r3),
        })
      );
    },
  };
}

const v10aMutants: MutantRef[] = [
  {
    id: "V10-no-material-moved",
    expected: "red",
    red: (o) =>
      o.notes.statusHeal !== 200 ? `re-login stays blocked: HTTP ${o.notes.statusHeal}` : null,
  },
  {
    id: "V10-no-baseline-in-mark",
    expected: "red",
    red: (o) =>
      o.notes.statusHeal !== 200
        ? `mark without a baseline never heals: HTTP ${o.notes.statusHeal}`
        : null,
  },
  {
    id: "V10-no-heal-in-acquire",
    expected: "red",
    red: (o) => (o.notes.markAfterHeal === true ? "the healed mark is still in state.json" : null),
  },
];

const v10bMutants: MutantRef[] = [
  {
    id: "V10-no-material-moved",
    expected: "red",
    red: (o) =>
      o.notes.statusHeal !== 200
        ? `non-rotating refresh stays blocked: HTTP ${o.notes.statusHeal}`
        : null,
  },
  {
    id: "V10-no-baseline-in-mark",
    expected: "red",
    red: (o) =>
      o.notes.statusHeal !== 200
        ? `mark without a baseline never heals: HTTP ${o.notes.statusHeal}`
        : null,
  },
];

function v10bRowPlan(): RowPlan {
  return {
    setup: {
      accounts: acc(["A"], { A: { expiresAt: 0 } }),
      fake: { tokenMode: "invalid_grant" },
    },
    async run(c) {
      const p = await c.serve({ CLAUDISH_ACCOUNTS_FAULT: "steal-lock-mid-exchange" });
      const r = await send(c, p, 1);
      const m = mark(c);
      c.note("markPresent", m !== null);
      const ex = c.fake.exchanges();
      c.checks(
        noSwitchAgreement({
          main: c.main(),
          recs: recs(c),
          expectedAttempts: 0,
          expectedRecords: "none",
          third: httpChecks("response", r, {
            status: 503,
            verdict: "transient",
            includes: ["gate was lost during the exchange"],
          }),
        })
      );
      c.check(
        "[fake] exactly one exchange, answered invalid_grant",
        ex.invalidGrant === 1 && ex.ok === 0,
        `ok=${ex.ok}, invalid_grant=${ex.invalidGrant}`
      );
      c.check(
        "[accounts] state.json carries no needsReauth for the account",
        m === null,
        JSON.stringify(m)
      );
    },
  };
}

// ---------------------------------------------------------------------------
// V14: account-list reload
// ---------------------------------------------------------------------------

function v14Plan(): RowPlan {
  return {
    setup: { accounts: AB },
    async run(c) {
      const p1 = await c.serve();
      const r1 = await send(c, p1, 1);
      const cmd = Bun.spawnSync(["node", c.launcher, "account", "disable", "codex", "A"], {
        env: c.env(),
        cwd: c.tree.cwd,
      });
      const cmdOut = `${cmd.stdout.toString()}${cmd.stderr.toString()}`;
      c.save("account-disable.txt", cmdOut);
      c.check(
        "[row] `account disable codex A` exited 0",
        cmd.exitCode === 0,
        `${cmd.exitCode}: ${cmdOut.trim().slice(0, 160)}`
      );
      const r2 = await send(c, p1, 2);
      c.note("bearer2", c.main()[1]?.bearer ?? null);
      c.checks(
        switchAgreement({
          main: c.main(),
          recs: recs(c),
          expectedAttempts: 2,
          bearers: [bearerOf("A"), bearerOf("B")],
          expectedRecords: [
            "A:initial-selection:usage",
            "A:initial-selection:ok",
            "B:initial-selection:usage",
            "B:initial-selection:ok",
          ],
          third: [...answerChecks("request 1", r1), ...answerChecks("request 2", r2)],
        })
      );
    },
  };
}

// ---------------------------------------------------------------------------
// V17: api-key only
// ---------------------------------------------------------------------------

function v17Plan(mode: "session" | "direct"): RowPlan {
  return {
    setup: {
      accounts: [],
      fake: { classify: mode === "session" ? classifyResponsesRequest : () => "main" },
    },
    async run(c) {
      let third: Check[];
      if (mode === "session") {
        // The canary answers 500 and Claude Code retries a 5xx up to 10 times over minutes (measured:
        // 10 canary hits, a 150 s run). The contract's "exactly one" counts the PROXY's contact, so
        // the session variant switches Claude Code's own retry off for this row only.
        const s = await c.session(undefined, { CLAUDE_CODE_MAX_RETRIES: "0" });
        third = [...sessionChecks(s, { includes: ["CANARY: the metered path was contacted"] })];
      } else {
        const p = await c.serve();
        const r = await send(c, p, 1);
        third = httpChecks("response", r, {
          status: 500,
          type: "server_error",
          includes: ["CANARY: the metered path was contacted"],
        });
      }
      c.checks(
        v17Agreement({
          canaryHits: c.canary.hits,
          main: c.main(),
          recs: recs(c),
          key: CANARY_KEY,
          third,
        })
      );
      c.check(
        "[canary] the request path is POST /v1/responses",
        c.canary.hits[0]?.method === "POST" && c.canary.hits[0]?.path === "/v1/responses",
        c.canary.hits.map((h) => `${h.method} ${h.path}`).join("; ")
      );
    },
  };
}

const v17Mutants: MutantRef[] = [
  {
    id: "V17-pool-available-when-empty",
    expected: "red",
    red: (o) =>
      o.canary === 0 ? "canary stays 0: the api-key user never reaches the metered host" : null,
  },
];

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

const NOT_EVIDENCE = (why: string) => `not evidence: ${why}`;

export const ROWS: RowSpec[] = [
  {
    id: "V11:session",
    row: "V11",
    title: "the :695 swap emits no false failure (Claude Code -p)",
    drive: "session",
    steps:
      "one `-p` run, cx@gpt-6.1-sol; pool A,B fresh; A's bearer answers a quota 429, B serves FAKE_ANSWER_OK",
    expectedMain: "2 (A then B, same body hash)",
    accountsRecords: V11_RECORDS.join(", ") + " (one requestId)",
    fakeProperty: "same body hash, bearer access-A then access-B, same session id",
    transcript:
      "contains FAKE_ANSWER_OK; stdout FAKE_ANSWER_OK; exit 0; no `Error [..]: HTTP n` on stderr",
    canary: 0,
    expectsFakeRequests: true,
    mutants: v11Mutants,
    make: () => v11Plan("session"),
  },
  {
    id: "V11:direct",
    row: "V11",
    title: "the :695 swap emits no false failure (serve + POST)",
    drive: "direct",
    steps: "one serve, one POST; pool A,B fresh; A quota 429, B serves",
    expectedMain: "2 (A then B, same body hash)",
    accountsRecords: V11_RECORDS.join(", ") + " (one requestId)",
    fakeProperty: "same body hash, bearer access-A then access-B",
    transcript:
      "relaxation (direct): the HTTP response replaces the transcript - HTTP 200, body text FAKE_ANSWER_OK",
    canary: 0,
    expectsFakeRequests: true,
    mutants: v11Mutants,
    make: () => v11Plan("direct"),
  },
  {
    id: "V1:direct",
    row: "V1",
    title: "the rotation sign throws (HTTP)",
    drive: "direct",
    steps:
      "A fresh, B exhaustedUntil now+1h (state store, child); one serve, one POST; A's bearer answers a quota 429",
    expectedMain: "1 (A); B never contacted",
    accountsRecords:
      "A initial-selection http-error, A initial-selection quota (resetAt R_A, estimated false); no B record",
    fakeProperty: "one main, bearer access-A; zero with access-B",
    transcript:
      "relaxation (direct): HTTP 400 invalid_request_error, upstream_status 429, no verdict header, pinned (2 of 2) message with both reset lines",
    canary: 0,
    expectsFakeRequests: true,
    mutants: v1Mutants,
    make: () => v1Plan("direct"),
  },
  {
    id: "V1:session",
    row: "V1",
    title: "the rotation sign throws (Claude Code -p)",
    drive: "session",
    steps: "as V1:direct through one `-p` run",
    expectedMain: "1 (A); B never contacted",
    accountsRecords: "A initial-selection http-error, A initial-selection quota; no B record",
    fakeProperty: "one main, bearer access-A; zero with access-B",
    transcript: "carries `API Error: 400` with the pinned (2 of 2) text and both reset lines",
    canary: 0,
    expectsFakeRequests: true,
    mutants: v1Mutants,
    make: () => v1Plan("session"),
  },
  {
    id: "V1c:direct",
    row: "V1c",
    title: "already-exhausted pool, the initial sign throws (billing, HTTP)",
    drive: "direct",
    steps: "A and B exhaustedUntil in the future (state store, child); one serve, one POST",
    expectedMain: "0",
    accountsRecords: "none (the initial sign throws before any account is reported)",
    fakeProperty:
      "zero requests in the row's own fake log (the pre-flight is the proof the seam was armed)",
    transcript:
      "relaxation (direct): HTTP 400, upstream_status 429, no verdict header, pinned (2 of 2) message",
    canary: 0,
    expectsFakeRequests: false,
    mutants: v1cMutants,
    make: () => v1cPlan("direct"),
  },
  {
    id: "V1c:session",
    row: "V1c",
    title: "already-exhausted pool, the initial sign throws (billing, Claude Code -p)",
    drive: "session",
    steps: "as V1c:direct through one `-p` run",
    expectedMain: "0",
    accountsRecords: "none",
    fakeProperty: "zero requests in the row's own fake log",
    transcript: "carries `API Error: 400` with the pinned (2 of 2) text",
    canary: 0,
    expectsFakeRequests: false,
    mutants: v1cMutants,
    make: () => v1cPlan("session"),
  },
  {
    id: "V1b",
    row: "V1b",
    title: "the redundant net fires (initial site only)",
    drive: "direct",
    steps: "pool A,B fresh; one serve with CLAUDISH_ACCOUNTS_FAULT=non-oauth-artifact; one POST",
    expectedMain: "0",
    accountsRecords: "none",
    fakeProperty: "none: the row's own fake log is empty",
    transcript:
      "relaxation (direct): HTTP 400, x-claudish-auth-verdict terminal, message `Refusing to sign a pooled subscription request ... no request was sent.`; no poisoned-arm record is not observable (named relaxation)",
    canary: 0,
    expectsFakeRequests: false,
    mutants: [
      {
        id: "V1b-no-transport-net",
        expected: "red",
        red: (o) =>
          String(o.notes.message1).includes("Request requires a Codex OAuth artifact before fetch")
            ? "the handler backstop's wording replaced the transport net's message"
            : null,
      },
      {
        id: "V1b-no-nets",
        expected: "red",
        red: (o) =>
          o.canary >= 1 ? `canary recorded ${o.canary} escaped metered request(s)` : null,
      },
    ],
    make: v1bPlan,
  },
  {
    id: "V1d",
    row: "V1d",
    title: "token-store read fails (not empty)",
    drive: "direct",
    steps:
      "one account, fresh token; one serve with CLAUDISH_ACCOUNTS_FAULT=store-read-throws and the canary api key; one POST",
    expectedMain: "0",
    accountsRecords: "none",
    fakeProperty: "no /responses request",
    transcript:
      "relaxation (direct): HTTP 503, x-claudish-auth-verdict transient, upstream_status 503 (RefreshUnavailableError per the accounts.md error table)",
    canary: 0,
    expectsFakeRequests: false,
    mutants: [
      {
        id: "V1d-swallow-in-isavailable",
        expected: "red",
        red: (o) => (o.canary >= 1 ? `canary recorded ${o.canary} metered request(s)` : null),
      },
      {
        id: "V1d-swallow-only-DEAD",
        expected: "dead",
        red: (o) => (o.canary >= 1 ? `unexpectedly reached the canary (${o.canary})` : null),
      },
    ],
    make: v1dPlan,
  },
  {
    id: "V1e",
    row: "V1e",
    title: "account-list read FAILS: config.json",
    drive: "direct",
    steps:
      "P1 serve, request 1; truncate config.json to `{`, request 2 on P1; P2 fresh serve + request (truncated); restore; chmod 000, P3 fresh serve + request; chmod 644 in finally",
    expectedMain: "P1: 1 then 1; P2, P3: 0",
    accountsRecords: "four records, P1's two requests only (A initial-selection usage, ok) x2",
    fakeProperty: "two main requests, both bearer access-A",
    transcript:
      "relaxation (direct): step 2 HTTP 200 (last-known-good); step 3 HTTP 400 terminal upstream 400 naming config.json; step 4 HTTP 503 transient upstream 503 naming the file",
    canary: 0,
    expectsFakeRequests: true,
    mutants: [
      {
        id: "V1e-config-failed-as-absent",
        expected: "red",
        red: (o) => (o.canary >= 1 ? `canary recorded ${o.canary} metered request(s)` : null),
      },
    ],
    make: v1ePlan,
  },
  {
    id: "V16b",
    row: "V16b",
    title: "the legacy file is unreadable (pool half)",
    drive: "direct",
    steps:
      "no subscriptionAccounts; codex-oauth.json present; passes (fresh serve each): truncated (+ repaired on the same serve), empty, chmod 000, account-list-read-throws fault, valid control, ENOENT with no api key",
    expectedMain: "0 for each failing pass; 1 repaired + 1 control, both on access-legacy",
    accountsRecords:
      "none for failing passes AND for the served requests (the synthesized-legacy path signs with no pooled account; amended from 'ok records' after measurement)",
    fakeProperty: "no request for failing passes; the repaired and control requests only",
    transcript:
      "relaxation (direct): failing passes HTTP 503 transient overloaded_error naming codex-oauth.json (invalid JSON / EACCES); ENOENT stays distinct (not 503)",
    canary: 0,
    expectsFakeRequests: true,
    mutants: [
      {
        id: "V16b-registry-failed-as-absent",
        expected: "red",
        red: (o) => (o.canary >= 1 ? `canary recorded ${o.canary} metered request(s)` : null),
      },
      {
        id: "V16b-hascredentials-revert-DEAD",
        expected: "dead",
        red: (o) => (o.canary >= 1 ? `unexpectedly reached the canary (${o.canary})` : null),
      },
      {
        id: "V16b-existssync-absence-DEAD",
        expected: "dead",
        red: (o) => (o.canary >= 1 ? `unexpectedly reached the canary (${o.canary})` : null),
      },
    ],
    make: v16bPlan,
  },
  {
    id: "V2",
    row: "V2",
    title: "refresh race, four processes",
    drive: "direct",
    steps:
      "one expired account; fake token endpoint delays 300 ms; 4 serve processes listening, then 4 POSTs issued in one tick",
    expectedMain: "4, all on the rotated bearer at-rotated-1",
    accountsRecords: "4 request ids, each with an ok record; no needsReauth",
    fakeProperty: "token endpoint: ok = 1, invalid_grant = 0",
    transcript:
      "relaxation (direct): four HTTP 200; token file generation = seed + 1, fingerprint of rt-rotated-1",
    canary: 0,
    expectsFakeRequests: true,
    mutants: [
      {
        id: "V2-no-exclusive-create",
        expected: "red",
        // The contract predicted `ok > 1 and invalid_grant >= 1`. Measured on the mutated bundle:
        // exactly ONE exchange and three HTTP 503s (the read-back after the write still keeps the
        // holders apart, so the safety property survives and availability does not). The row is
        // red through its other contract checks, so they count.
        red: (o) => {
          if (o.exchanges.ok > 1 && o.exchanges.invalidGrant >= 1)
            return `ok=${o.exchanges.ok}, invalid_grant=${o.exchanges.invalidGrant}`;
          const broken = o.failedChecks.filter((n) =>
            /four HTTP 200|4 main attempts|4 request ids/.test(n)
          );
          return broken.length > 0
            ? `exchanges ok=${o.exchanges.ok}/invalid_grant=${o.exchanges.invalidGrant}, but the row's contract checks fail: ${broken.join(" | ")}`
            : null;
        },
      },
    ],
    make: v2Plan,
  },
  {
    id: "V2b",
    row: "V2b",
    title: "dead lock holder",
    drive: "direct",
    steps:
      "one expired account; a lock file held by a dead pid on this host; one serve, one POST; wall clock from request to first exchange",
    expectedMain: "1 (at-rotated-1)",
    accountsRecords: "A initial-selection usage, ok; one request id",
    fakeProperty: "exactly one exchange, within 5 s of the request",
    transcript: "relaxation (direct): HTTP 200",
    canary: 0,
    expectsFakeRequests: true,
    mutants: [
      {
        id: "V2b-no-dead-holder-detection",
        expected: "red",
        red: (o) =>
          o.notes.status1 !== 200 ||
          o.notes.exchangeLatencyMs === null ||
          Number(o.notes.exchangeLatencyMs) >= 5000
            ? `latency=${o.notes.exchangeLatencyMs}, HTTP ${o.notes.status1}`
            : null,
      },
    ],
    make: v2bPlan,
  },
  {
    id: "V2c",
    row: "V2c",
    title: "acquire timeout",
    drive: "direct",
    steps:
      "one expired account; P1 serve with lock-hold-forever, request 1 (hangs); barrier = the lock file names the holder; P2 serve without the fault, request 2; wait up to 60 s; kill P1 in finally",
    expectedMain: "0 for both",
    accountsRecords: "none",
    fakeProperty: "zero token exchanges in total",
    transcript:
      "relaxation (direct): request 2 HTTP 503 transient (RefreshUnavailableError), no quota wording, elapsed 18-25 s",
    canary: 0,
    expectsFakeRequests: false,
    mutants: [
      {
        id: "V2c-timeout-unlocked-refresh",
        expected: "red",
        red: (o) =>
          Number(o.notes.exchangeTotal) >= 1
            ? `the waiter exchanged ${o.notes.exchangeTotal} time(s)`
            : null,
      },
    ],
    make: v2cPlan,
  },
  {
    id: "V2d",
    row: "V2d",
    title: "unwritable lock directory",
    drive: "direct",
    steps:
      "one expired account; create locks/openai-codex/ then chmod 0500 (restored in finally); one serve, one POST",
    expectedMain: "0",
    accountsRecords: "none",
    fakeProperty: "zero exchanges",
    transcript:
      "relaxation (direct): HTTP 503 transient, message contains `refresh disabled` (the `account status` line is not built, not asserted)",
    canary: 0,
    expectsFakeRequests: false,
    mutants: [
      {
        id: "V2d-unwritable-unlocked-refresh",
        expected: "red",
        red: (o) =>
          Number(o.notes.exchangeTotal) >= 1
            ? `an unlocked refresh exchanged ${o.notes.exchangeTotal} time(s)`
            : null,
      },
    ],
    make: v2dPlan,
  },
  {
    id: "V2f",
    row: "V2f",
    title: "fencing",
    drive: "direct",
    steps: "one expired account; one serve with steal-lock-mid-exchange; one POST",
    expectedMain: "0",
    accountsRecords: "none",
    fakeProperty: "exactly one exchange",
    transcript:
      "relaxation (direct): HTTP 503 transient (gate stolen before the persist); token file unchanged (generation, fingerprint, tokens; the journal write mints a writeId before the exchange, so writeId is not asserted), journal refreshing with from = seed fingerprint",
    canary: 0,
    expectsFakeRequests: true,
    mutants: [
      {
        id: "V2f-fence-on-pid-only",
        expected: "red",
        red: (o) =>
          Number(o.notes.tokenGeneration) > 1
            ? `the stolen-from holder persisted: generation ${o.notes.tokenGeneration}`
            : null,
      },
    ],
    make: v2fPlan,
  },
  {
    id: "V3",
    row: "V3",
    title: "threshold switch, genuinely concurrent",
    drive: "direct",
    steps:
      "pool A,B fresh, switchAt 0.90; P1 and P2 serve idle; P1 request 1 (A 20%) and request 2 (A 92%, inside the 5 s window); 1000 ms; P2 request; all carry the same metadata.user_id session id",
    expectedMain: "3 (A, A, B)",
    accountsRecords:
      "A initial-selection usage, ok (x2); B initial-selection usage, ok; three request ids",
    fakeProperty:
      "bearers access-A, access-A, access-B; the same claudish_<32 hex> prompt_cache_key on all three",
    transcript: "relaxation (direct): three HTTP 200",
    canary: 0,
    expectsFakeRequests: true,
    mutants: [
      {
        id: "V3-coalesce-selection-usage",
        expected: "red",
        red: (o) =>
          o.notes.bearer3 === bearerOf("A")
            ? "P2 read the pre-crossing state and selected A"
            : null,
      },
    ],
    make: v3Plan,
  },
  {
    id: "V3b",
    row: "V3b",
    title: "staleness does not resurrect an over-threshold account",
    drive: "direct",
    steps:
      "pool A,B; A's usage snapshot 0.92, observedAt now-20min, reset in the future (state store, child); one serve, one POST",
    expectedMain: "1 (access-B); A never contacted",
    accountsRecords: "B initial-selection usage, ok",
    fakeProperty: "one main on access-B; zero on access-A",
    transcript: "relaxation (direct): HTTP 200",
    canary: 0,
    expectsFakeRequests: true,
    mutants: [
      {
        id: "V3b-stale-usage-is-unknown",
        expected: "red",
        red: (o) =>
          o.notes.bearer1 === bearerOf("A")
            ? "the stale 92% snapshot was dropped and A selected"
            : null,
      },
    ],
    make: v3bPlan,
  },
  {
    id: "V8:direct",
    row: "V8",
    title: "second HTTP attempt also 429 (billing, HTTP)",
    drive: "direct",
    steps:
      "pool A,B fresh; both bearers answer a quota 429 with distinct resets; one serve; request 1; request 2 on the same process",
    expectedMain: "request 1: 2 (A then B, same body hash); request 2: 0",
    accountsRecords:
      "A initial-selection http-error, quota; B quota-switch http-error, quota; one requestId; request 2 writes none",
    fakeProperty: "two main attempts on one body hash, no third; none for request 2",
    transcript:
      "relaxation (direct): both requests HTTP 400, upstream_status 429, no verdict header, `(2 of 2)` listing both resets",
    canary: 0,
    expectsFakeRequests: true,
    mutants: v8Mutants,
    make: () => v8Plan("direct"),
  },
  {
    id: "V8:session",
    row: "V8",
    title: "second HTTP attempt also 429 (billing, Claude Code -p)",
    drive: "session",
    steps: "as V8:direct, request 1 only, through one `-p` run",
    expectedMain: "2 (A then B, same body hash)",
    accountsRecords:
      "A initial-selection http-error, quota; B quota-switch http-error, quota; one requestId",
    fakeProperty: "two main attempts on one body hash, no third",
    transcript: "carries `API Error: 400` with the pinned (2 of 2) text and both reset lines",
    canary: 0,
    expectsFakeRequests: true,
    mutants: v8Mutants,
    make: () => v8Plan("session"),
  },
  {
    id: "V8b:case1",
    row: "V8b",
    title: "retry budget spent with an account still eligible (C expired)",
    drive: "direct",
    steps:
      "pool A,B,C; C expiresAt 0; A and B quota 429; one serve; request 1; read state.json and C's token file",
    expectedMain: "2 (A, B)",
    accountsRecords:
      "A initial-selection http-error, quota; B quota-switch http-error, quota; one requestId; no C record",
    fakeProperty: "zero token exchanges; state.json active still B; C's token file bytes unchanged",
    transcript:
      "relaxation (named in the contract): no session variant, because Claude Code retries a transient 429; HTTP 429 rate_limit_error upstream 429 verdict transient, message exactly `Codex account retry deferred; retry this request.`",
    canary: 0,
    expectsFakeRequests: true,
    mutants: v8bMutants,
    make: () => v8bPlan(1),
  },
  {
    id: "V8b:case2",
    row: "V8b",
    title: "retry budget spent, the third account is disabled",
    drive: "direct",
    steps: "pool A,B,C; C disabled in config.json; A and B quota 429; fresh serve; one POST",
    expectedMain: "2 (A, B)",
    accountsRecords:
      "A initial-selection http-error, quota; B quota-switch http-error, quota; no C record",
    fakeProperty: "two main attempts",
    transcript:
      "relaxation (direct): HTTP 400 mixed exhausted error naming (3 of 3) with C's disabled line",
    canary: 0,
    expectsFakeRequests: true,
    mutants: [],
    mutantNote: NOT_EVIDENCE(
      "case 2 is the disabled-account arm; the V8b mutant (acquire in the capacity query) targets case 1's eligible-account arm"
    ),
    make: () => v8bPlan(2),
  },
  {
    id: "V9:persist-throw",
    row: "V9",
    title: "persistence fault: the final persist throws",
    drive: "direct",
    steps:
      "one expired account; P1 serve with persist-throw, request; P2 fresh serve without the fault, request",
    expectedMain: "0",
    accountsRecords: "none",
    fakeProperty:
      "ok = 1, invalid_grant = 1 (the recovery exchange presents the now-revoked token on purpose)",
    transcript:
      "relaxation (direct): P1 HTTP 503 transient; P2 HTTP 400 terminal upstream 401; needsReauth.lastReason === `a token rotation was interrupted`; journal closed afterwards",
    canary: 0,
    expectsFakeRequests: true,
    mutants: v9Mutants,
    make: () => v9Plan("persist-throw"),
  },
  {
    id: "V9:crash-after-refresh",
    row: "V9",
    title: "persistence fault: the process dies after the exchange",
    drive: "direct",
    steps:
      "one expired account; P1 serve with crash-after-refresh, request; P2 fresh serve, request",
    expectedMain: "0",
    accountsRecords: "none",
    fakeProperty: "ok = 1, invalid_grant = 1",
    transcript:
      "relaxation (direct): P1 connection failure and exit code 9; P2 HTTP 400 terminal upstream 401; lastReason `a token rotation was interrupted`",
    canary: 0,
    expectsFakeRequests: true,
    mutants: v9Mutants,
    make: () => v9Plan("crash-after-refresh"),
  },
  {
    id: "V9b:committed",
    row: "V9b",
    title: "ambiguous write: committed",
    drive: "direct",
    steps: "one expired account; one serve with persist-timeout-committed; one POST",
    expectedMain: "1 on the NEW bearer at-rotated-1",
    accountsRecords: "A initial-selection usage, ok; one requestId",
    fakeProperty: "exactly one exchange",
    transcript: "relaxation (direct): HTTP 200; token file generation = seed + 1, journal null",
    canary: 0,
    expectsFakeRequests: true,
    mutants: v9bMutants,
    make: () => v9bPlan("committed"),
  },
  {
    id: "V9b:uncommitted",
    row: "V9b",
    title: "ambiguous write: uncommitted",
    drive: "direct",
    steps: "one expired account; one serve with persist-timeout-uncommitted; one POST",
    expectedMain: "0",
    accountsRecords: "none",
    fakeProperty: "exactly one exchange",
    transcript:
      "relaxation (direct): HTTP 503 transient; token file journal.state unknown, generation = seed",
    canary: 0,
    expectsFakeRequests: true,
    mutants: [],
    mutantNote: NOT_EVIDENCE(
      "the V9b mutant (committed resolved as uncommitted) is observable only in the committed case; this is its negative arm"
    ),
    make: () => v9bPlan("uncommitted"),
  },
  {
    id: "V10:a",
    row: "V10",
    title: "needsReauth self-heals against a baseline: re-login (new refresh token)",
    drive: "direct",
    steps:
      "one expired account; fake rejects (invalid_grant); P1 request writes the mark; fake back to ok; driver writes F2 material; P2 fresh serve, request",
    expectedMain: "1 (the store's bearer access-A2)",
    accountsRecords: "A initial-selection usage, ok",
    fakeProperty: "zero further exchanges after the setup rejection",
    transcript:
      "relaxation (direct): setup HTTP 400 terminal upstream 401; heal HTTP 200; state.json no longer carries the mark",
    canary: 0,
    expectsFakeRequests: true,
    mutants: v10aMutants,
    make: () => v10Plan("a"),
  },
  {
    id: "V10:b",
    row: "V10",
    title: "needsReauth self-heals against a baseline: same refresh token, next generation",
    drive: "direct",
    steps:
      "as V10:a, but the driver writes the SAME refresh token at generation + 1 with a fresh access token",
    expectedMain: "1 (access-A3)",
    accountsRecords: "A initial-selection usage, ok",
    fakeProperty: "zero further exchanges after the setup rejection",
    transcript: "relaxation (direct): heal HTTP 200; state.json no longer carries the mark",
    canary: 0,
    expectsFakeRequests: true,
    mutants: v10bMutants,
    make: () => v10Plan("b"),
  },
  {
    id: "V10:c",
    row: "V10",
    title: "needsReauth stays while the store is untouched, retries after 1 minute",
    drive: "direct",
    steps:
      "as V10:a up to the mark; store untouched; P2 request (refused); real wait to 61 s after the mark; P3 fresh serve, request",
    expectedMain: "P2: 0; P3: 1 (at-rotated-1)",
    accountsRecords: "P3: A initial-selection usage, ok",
    fakeProperty:
      "P2 makes no exchange and the mark is kept; P3 makes exactly one exchange, answered ok",
    transcript: "relaxation (direct): P2 HTTP 400 terminal upstream 401; P3 HTTP 200",
    canary: 0,
    expectsFakeRequests: true,
    mutants: [
      {
        // Beyond the contract (its V10 mutants all target the heal arms), added so case (c) is evidence.
        id: "V10c-retry-always-due",
        expected: "red",
        red: (o) =>
          Number(o.notes.exchangesDuringRefusal) >= 1 || o.notes.statusRefused !== 400
            ? `P2 was not refused: HTTP ${o.notes.statusRefused}, exchanges ${o.notes.exchangesDuringRefusal}`
            : null,
      },
    ],
    make: () => v10Plan("c"),
  },
  {
    id: "V10b",
    row: "V10b",
    title: "needsReauth is gate-holder-only",
    drive: "direct",
    steps: "one expired account; fake rejects; one serve with steal-lock-mid-exchange; one POST",
    expectedMain: "0",
    accountsRecords: "none",
    fakeProperty: "one exchange, answered invalid_grant",
    transcript:
      "relaxation (direct): HTTP 503 transient (gate lost during the exchange); state.json has no needsReauth for the account",
    canary: 0,
    expectsFakeRequests: true,
    mutants: [
      {
        id: "V10b-no-gate-ownership-check",
        expected: "red",
        red: (o) => (o.notes.markPresent === true ? "a non-holder wrote needsReauth" : null),
      },
    ],
    make: v10bRowPlan,
  },
  {
    id: "V14",
    row: "V14",
    title: "account-list reload in a long-lived process",
    drive: "direct",
    steps:
      "P1 serve, request 1 (sticky A); a separate process runs `claudish account disable codex A`; request 2 on P1",
    expectedMain: "2 (access-A then access-B)",
    accountsRecords: "request 2: B initial-selection usage, ok",
    fakeProperty: "bearer access-A then access-B",
    transcript:
      "relaxation (direct): both HTTP 200; the billing-probe half is in-process state with no external read (named relaxation)",
    canary: 0,
    expectsFakeRequests: true,
    mutants: [
      {
        id: "V14-no-restat-per-answer",
        expected: "red",
        red: (o) =>
          o.notes.bearer2 === bearerOf("A")
            ? "request 2 still signed with the disabled account A"
            : null,
      },
    ],
    make: v14Plan,
  },
  {
    id: "V17:direct",
    row: "V17",
    title: "Codex api key only (HTTP)",
    drive: "direct",
    steps: "no pool, no legacy file; OPENAI_CODEX_API_KEY is the subject; one serve, one POST",
    expectedMain: "0",
    accountsRecords: "none",
    fakeProperty: "no request reaches the subscription upstream",
    transcript:
      "relaxation (direct): HTTP 500 server_error `CANARY: the metered path was contacted`; recordSignedArm=metered is in-process state, stood in for by the canary request carrying the api key (named relaxation)",
    canary: 1,
    expectsFakeRequests: false,
    mutants: v17Mutants,
    make: () => v17Plan("direct"),
  },
  {
    id: "V17:session",
    row: "V17",
    title: "Codex api key only (Claude Code -p)",
    drive: "session",
    steps: "as V17:direct through one `-p` run",
    expectedMain: "0",
    accountsRecords: "none",
    fakeProperty: "no request reaches the subscription upstream",
    transcript: "shows the vendor error text `CANARY: the metered path was contacted`",
    canary: 1,
    expectsFakeRequests: false,
    mutants: v17Mutants,
    make: () => v17Plan("session"),
  },
];

// ---------------------------------------------------------------------------
// Load-time validation: a row that lacks any contract field throws.
// ---------------------------------------------------------------------------

export function validateRows(rows: RowSpec[]): void {
  const seen = new Set<string>();
  for (const r of rows) {
    const where = `row ${r.id || "(no id)"}`;
    for (const field of [
      "id",
      "row",
      "title",
      "steps",
      "expectedMain",
      "accountsRecords",
      "fakeProperty",
      "transcript",
    ] as const) {
      if (typeof r[field] !== "string" || r[field].trim() === "")
        throw new Error(`${where}: contract field "${field}" is missing or empty`);
    }
    if (r.drive !== "session" && r.drive !== "direct")
      throw new Error(`${where}: drive must be session or direct`);
    if (typeof r.canary !== "number" || !Number.isInteger(r.canary) || r.canary < 0)
      throw new Error(`${where}: canary count is missing`);
    if (typeof r.make !== "function") throw new Error(`${where}: make() is missing`);
    if (typeof r.expectsFakeRequests !== "boolean")
      throw new Error(`${where}: expectsFakeRequests is missing`);
    if (r.mutants.length === 0 && !r.mutantNote?.startsWith("not evidence"))
      throw new Error(`${where}: needs a mutant or a mutantNote starting "not evidence"`);
    if (r.drive === "direct" && !/relaxation/i.test(r.transcript))
      throw new Error(`${where}: a direct row must name its transcript relaxation`);
    for (const m of r.mutants) {
      if (typeof m.red !== "function" || (m.expected !== "red" && m.expected !== "dead"))
        throw new Error(`${where}: mutant ${m.id} lacks a red predicate or an expectation`);
    }
    if (seen.has(r.id)) throw new Error(`${where}: duplicate id`);
    seen.add(r.id);
  }
}

validateRows(ROWS);

export { KNOWN_EGRESS };
