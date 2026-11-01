import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NEGATIVE_CONTROLS,
  REFRESH_REJECTED_DIFF_PATHS,
  REFRESH_REJECTED_MESSAGE,
  type SideCapture,
  type SummaryEntry,
  UPSTREAM_EVIDENCE_FILES,
  argProblems,
  clientLeaks,
  e20Verdict,
  headerStabilityDiff,
  outputLeaks,
  refreshRejectedAllReps,
  refreshRejectedProblems,
  standingBroken,
} from "./e20-gate.ts";
import { scanSecrets } from "./e20.ts";

// Values recorded in the saved E20 run (validation/e20/refresh-rejected/result.json).
const baseline = (): SideCapture => ({
  fake: [{ path: "/oauth/token" }],
  canary: [],
  client: {
    status: 500,
    body: {
      error: {
        message: REFRESH_REJECTED_MESSAGE.baseline,
        type: "api_error",
      },
      type: "error",
    },
  },
  clientHeaders: { "content-type": "application/json" },
});
const candidate = (): SideCapture => ({
  fake: [{ path: "/oauth/token" }],
  canary: [],
  client: {
    status: 400,
    body: {
      error: {
        message: REFRESH_REJECTED_MESSAGE.candidate,
        type: "invalid_request_error",
        upstream_status: 401,
      },
      type: "error",
    },
  },
  clientHeaders: { "content-type": "application/json", "x-claudish-auth-verdict": "terminal" },
});
const goodDiff = () => REFRESH_REJECTED_DIFF_PATHS.map((p) => `${p}: baseline=1 candidate=2`);

describe("refreshRejectedProblems", () => {
  test("accepts exactly the recorded divergence", () => {
    expect(refreshRejectedProblems(baseline(), candidate(), goodDiff())).toEqual([]);
  });

  test("rejects a candidate that lost the terminal verdict header", () => {
    const k = candidate();
    k.clientHeaders = { "content-type": "application/json" };
    expect(refreshRejectedProblems(baseline(), k, goodDiff()).join("|")).toContain(
      "x-claudish-auth-verdict"
    );
  });

  test("rejects a candidate that restored the old 500 shape", () => {
    const k = candidate();
    k.client = baseline().client;
    expect(refreshRejectedProblems(baseline(), k, goodDiff()).length).toBeGreaterThan(0);
  });

  test("rejects a second token exchange", () => {
    const k = candidate();
    k.fake = [{ path: "/oauth/token" }, { path: "/oauth/token" }];
    expect(refreshRejectedProblems(baseline(), k, goodDiff()).join("|")).toContain(
      "exactly one request"
    );
  });

  test("rejects a canary contact on either binary", () => {
    const b = baseline();
    b.canary = [{}];
    expect(refreshRejectedProblems(b, candidate(), goodDiff()).join("|")).toContain("canary");
  });

  test("rejects a difference outside the four recorded leaves", () => {
    const diff = [...goodDiff(), "$.fake[0].headers.x-extra: baseline=undefined candidate=1"];
    expect(refreshRejectedProblems(baseline(), candidate(), diff)).toEqual([
      "unexpected difference at $.fake[0].headers.x-extra",
    ]);
  });

  test("rejects a missing recorded difference (the two binaries agree)", () => {
    const diff = goodDiff().slice(1);
    expect(refreshRejectedProblems(baseline(), candidate(), diff).join("|")).toContain(
      "expected difference missing at $.client.status"
    );
  });
});

const caseOk = (id: string): SummaryEntry => ({ id, outcome: "identical", detail: "" });
const armedOk = { baseline: null, candidate: null };
const green = (): SummaryEntry[] => [
  caseOk("legacy-ok"),
  { id: "refresh-rejected", outcome: "expected divergence", detail: "" },
  { id: "mutant V16-remap", outcome: "mutant red", detail: "" },
  { id: "mutant V16-drop-transform", outcome: "DEAD-MUTANT", detail: "" },
];
const want = {
  cases: ["legacy-ok", "refresh-rejected"],
  mutants: ["mutant V16-remap", "mutant V16-drop-transform"],
};
const none = { cases: [], mutants: [] };

describe("e20Verdict", () => {
  test("is green for identical cases, red required mutants and the named dead control", () => {
    expect(NEGATIVE_CONTROLS).toContain("mutant V16-drop-transform");
    expect(e20Verdict(green(), armedOk, 0, want)).toEqual({ code: 0, reasons: [] });
  });

  test("fails on a DIFFERENT case", () => {
    const s = [...green(), { id: "legacy-error", outcome: "DIFFERENT", detail: "3 differing" }];
    expect(e20Verdict(s, armedOk, 0, want).code).toBe(1);
  });

  test("fails on an ABORTED case and on an ABORTED mutant", () => {
    expect(
      e20Verdict([{ id: "apikey", outcome: "ABORTED", detail: "x" }], armedOk, 0, none).code
    ).toBe(1);
    expect(
      e20Verdict([{ id: "mutant V16-remap", outcome: "ABORTED", detail: "x" }], armedOk, 0, none)
        .code
    ).toBe(1);
  });

  test("fails when a seam proof failed", () => {
    expect(
      e20Verdict(green(), { baseline: "no request reached the fake", candidate: null }, 0, want)
        .code
    ).toBe(1);
  });

  test("fails on a required mutant that is dead", () => {
    const s = [{ id: "mutant V16-omit-header", outcome: "DEAD-MUTANT", detail: "" }];
    const v = e20Verdict(s, armedOk, 0, none);
    expect(v.code).toBe(1);
    expect(v.reasons.join("|")).toContain("not red");
  });

  test("fails on a secret-scan violation", () => {
    expect(e20Verdict(green(), armedOk, 1, want).code).toBe(1);
  });

  test("a DIFFERENT refresh-rejected fails", () => {
    const s = [{ id: "refresh-rejected", outcome: "DIFFERENT", detail: "" }];
    expect(e20Verdict(s, armedOk, 0, none).code).toBe(1);
  });

  test("fails on an empty summary, even with nothing expected", () => {
    const v = e20Verdict([], armedOk, 0, none);
    expect(v.code).toBe(1);
    expect(v.reasons[0]).toContain("empty summary");
  });

  test("fails on an expected case or mutant that is missing", () => {
    const s = green().filter((e) => e.id !== "legacy-ok" && e.id !== "mutant V16-remap");
    const v = e20Verdict(s, armedOk, 0, want);
    expect(v.code).toBe(1);
    expect(v.reasons.join("|")).toContain("legacy-ok: expected but missing");
    expect(v.reasons.join("|")).toContain("mutant V16-remap: expected but missing");
  });

  test("a legitimate partial run passes with a narrowed expectation", () => {
    const s = [caseOk("legacy-ok")];
    expect(e20Verdict(s, armedOk, 0, { cases: ["legacy-ok"], mutants: [] }).code).toBe(0);
  });
});

describe("argProblems", () => {
  const ids = ["legacy-ok", "apikey"];
  const notCandidate = () => false;
  test("accepts a complete invocation", () => {
    expect(argProblems({ baseline: "/b", out: "/o", onlyGiven: false }, ids, notCandidate)).toEqual(
      []
    );
  });
  test("rejects missing baseline and out", () => {
    expect(argProblems({ onlyGiven: false }, ids, notCandidate).length).toBe(2);
  });
  test("rejects a flag value that is the next flag", () => {
    const p = argProblems({ baseline: "--out", out: "/o", onlyGiven: false }, ids, notCandidate);
    expect(p[0]).toContain("--baseline");
  });
  test("rejects a baseline equal to the candidate checkout", () => {
    const p = argProblems({ baseline: "/repo", out: "/o", onlyGiven: false }, ids, () => true);
    expect(p[0]).toContain("candidate checkout");
  });
  test("rejects an unknown or missing --only", () => {
    const base = { baseline: "/b", out: "/o", onlyGiven: true };
    expect(argProblems({ ...base, only: "legacy-okk" }, ids, notCandidate)[0]).toContain("--only");
    expect(argProblems({ ...base }, ids, notCandidate)[0]).toContain("--only");
    expect(argProblems({ ...base, only: "apikey" }, ids, notCandidate)).toEqual([]);
  });
});

describe("credential echo in a refresh-rejected response", () => {
  const withMessage = (extra: string) => {
    const k = candidate();
    (k.client.body as { error: { message: string } }).error.message += extra;
    return k;
  };
  test("the saved real values pass", () => {
    expect(refreshRejectedProblems(baseline(), candidate(), goodDiff())).toEqual([]);
    expect(clientLeaks(candidate())).toEqual([]);
  });
  test("refresh-legacy appended to the candidate message fails", () => {
    const p = refreshRejectedProblems(
      baseline(),
      withMessage(" refresh_token=refresh-legacy"),
      goodDiff()
    );
    expect(p.join("|")).toContain("error.message");
    expect(p.join("|")).toContain("echoes refresh-legacy");
  });
  test("it fails in either candidate repetition", () => {
    const clean = candidate();
    for (const reps of [
      [withMessage(" refresh-legacy"), clean],
      [clean, withMessage(" refresh-legacy")],
    ]) {
      const p = refreshRejectedAllReps([baseline(), baseline()], reps, [goodDiff(), goodDiff()]);
      expect(p.length).toBeGreaterThan(0);
    }
  });
  test("a credential in the baseline message fails", () => {
    const b = baseline();
    (b.client.body as { error: { message: string } }).error.message += " access-legacy";
    expect(refreshRejectedProblems(b, candidate(), goodDiff()).join("|")).toContain("baseline");
  });
  test("a credential in a client header fails, listed or not", () => {
    const k = candidate();
    k.clientHeaders["x-claudish-note"] = "rt-rotated-1";
    expect(refreshRejectedProblems(baseline(), k, goodDiff()).join("|")).toContain(
      "client header x-claudish-note echoes rt-rotated-1"
    );
    const k2 = candidate();
    k2.allClientHeaders = { "set-cookie": "sid=access-legacy" };
    expect(clientLeaks(k2)[0]).toContain("client header set-cookie");
  });
  test("a credential-shaped string outside the list fails", () => {
    const k = candidate();
    k.allClientHeaders = { authorization: "Bearer sk-live-abcdef123456" };
    expect(clientLeaks(k)[0]).toContain("credential-shaped");
  });
  test("a clean ordinary response has no leak", () => {
    expect(
      clientLeaks({ client: { body: { content: "FAKE_ANSWER_OK" } }, clientHeaders: {} })
    ).toEqual([]);
  });
});

describe("every repetition", () => {
  test("only the second candidate capture losing the verdict header fails", () => {
    const k2 = candidate();
    k2.clientHeaders = { "content-type": "application/json" };
    const reps = refreshRejectedAllReps(
      [baseline(), baseline()],
      [candidate(), k2],
      [goodDiff(), goodDiff()]
    );
    expect(reps.length).toBeGreaterThan(0);
    expect(reps.every((r) => r.startsWith("repetition 2:"))).toBe(true);
    expect(reps.join("|")).toContain("x-claudish-auth-verdict");
    // Both repetitions clean: no problem.
    expect(
      refreshRejectedAllReps(
        [baseline(), baseline()],
        [candidate(), candidate()],
        [goodDiff(), goodDiff()]
      )
    ).toEqual([]);
  });

  test("self-stability compares client headers of one binary", () => {
    const k2 = candidate();
    k2.clientHeaders = { "content-type": "application/json" };
    expect(headerStabilityDiff(candidate(), k2)[0]).toContain("x-claudish-auth-verdict");
    expect(headerStabilityDiff(candidate(), candidate())).toEqual([]);
    // Baseline and candidate may differ: stability never compares across binaries.
    expect(headerStabilityDiff(baseline(), baseline())).toEqual([]);
  });
});

describe("standingBroken", () => {
  const c = (name: string, ok: boolean) => ({ name, ok });
  test("is false when every standing check held", () => {
    expect(
      standingBroken([
        c("[standing] canary self-test: exactly one hit, then reset", true),
        c("[row] x", false),
      ])
    ).toBe(false);
  });

  test.each([
    "[standing] canary self-test: exactly one hit, then reset",
    "[standing] pre-flight request reached the fake",
    "[standing] no non-loopback contact beyond the known catalog read",
    "[standing] no credential-shaped string in client-visible evidence",
  ])("is true when %s failed", (name) => {
    expect(standingBroken([c(name, false)])).toBe(true);
  });
});

describe("credentials in the binary's output", () => {
  test("a seeded token in stdout or stderr fails, HTTP captures unchanged", () => {
    expect(outputLeaks({ stdout: "ok", stderr: "refresh failed for refresh-legacy" })[0]).toContain(
      "stderr echoes refresh-legacy"
    );
    expect(outputLeaks({ stdout: "token access-legacy", stderr: "" })[0]).toContain("stdout");
    expect(outputLeaks({ stdout: "listening on 1", stderr: "" })).toEqual([]);
    // The HTTP capture itself is clean, so only the output scan can see it.
    expect(clientLeaks(candidate())).toEqual([]);
  });
});

describe("scanSecrets allows fake credentials only in upstream-request evidence", () => {
  const dirs: string[] = [];
  const outDir = (files: Record<string, string>) => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), "e20-scan-")));
    dirs.push(d);
    mkdirSync(join(d, "case", "baseline"), { recursive: true });
    for (const [n, t] of Object.entries(files)) writeFileSync(join(d, "case", "baseline", n), t);
    return d;
  };
  test("fake-requests.json may hold one, serve-stderr.txt and client-response.json may not", () => {
    expect(UPSTREAM_EVIDENCE_FILES.has("serve-stderr.txt")).toBe(false);
    const ok = scanSecrets(outDir({ "fake-requests.json": "refresh-legacy" }));
    expect(ok.violations).toEqual([]);
    expect(ok.allowlisted).toBe(1);
    const bad = scanSecrets(
      outDir({ "serve-stderr.txt": "refresh-legacy", "client-response.json": "access-legacy" })
    );
    expect(bad.violations.length).toBe(2);
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
});
