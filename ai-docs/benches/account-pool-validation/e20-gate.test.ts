import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  diffPathOf,
  e20Verdict,
  guarded,
  headerStabilityDiff,
  mutantVerdict,
  outputLeaks,
  refreshRejectedAllReps,
  refreshRejectedProblems,
  standingBroken,
  underDiffPath,
  unknownSecretShapes,
} from "./e20-gate.ts";
import { V16_MUTANTS, finishE20, scanSecrets } from "./e20.ts";

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

// Review finding (round 5, HIGH): a mutant counted as red on ANY difference from the
// unmutated candidate, without checking that the request reached the mutation's path.
describe("mutantVerdict: red needs the mutation's own upstream request", () => {
  const ENDPOINT = {
    method: "POST",
    path: "/backend-api/codex/mutant",
    diffPaths: ["$.fake[*].path"],
  };
  const MODELS = { method: "GET", path: "/backend-api/codex/models" };
  const onPath = (n: number) =>
    Array.from({ length: n }, (_, i) => `$.fake[${i}].path: baseline="a" candidate="b"`);

  test("red: the mutant path was captured and the run differs on the declared path", () => {
    const v = mutantVerdict({
      evidence: ENDPOINT,
      fake: [MODELS, ENDPOINT],
      diff: onPath(3),
      harnessErrors: [],
    });
    expect(v.outcome).toBe("mutant red");
  });

  test("aborted: a difference with NO upstream contact is never red", () => {
    // The mutant crashed before any request: the client answer differs, the fake saw nothing.
    const v = mutantVerdict({ evidence: ENDPOINT, fake: [], diff: onPath(5), harnessErrors: [] });
    expect(v.outcome).toBe("ABORTED");
    expect(v.detail).toContain("POST /backend-api/codex/mutant never reached the fake");
    expect(v.detail).toContain("nothing");
  });

  test("aborted: a request on another path is not the mutation's evidence", () => {
    const v = mutantVerdict({
      evidence: ENDPOINT,
      fake: [MODELS, { method: "POST", path: "/backend-api/codex/responses" }],
      diff: onPath(2),
      harnessErrors: [],
    });
    expect(v.outcome).toBe("ABORTED");
    expect(v.detail).toContain("POST /backend-api/codex/responses");
  });

  test("aborted: the right path with the wrong method", () => {
    const v = mutantVerdict({
      evidence: ENDPOINT,
      fake: [{ method: "GET", path: ENDPOINT.path }],
      diff: onPath(1),
      harnessErrors: [],
    });
    expect(v.outcome).toBe("ABORTED");
  });

  test("dead: the mutant path was captured and nothing differs", () => {
    const v = mutantVerdict({ evidence: ENDPOINT, fake: [ENDPOINT], diff: [], harnessErrors: [] });
    expect(v.outcome).toBe("DEAD-MUTANT");
  });

  test("aborted: a harness error outranks evidence and difference", () => {
    const v = mutantVerdict({
      evidence: ENDPOINT,
      fake: [ENDPOINT],
      diff: onPath(4),
      harnessErrors: ["REDIRECT the product answered HTTP 302"],
    });
    expect(v.outcome).toBe("ABORTED");
    expect(v.detail).toContain("REDIRECT");
  });

  test("an ABORTED mutant fails the E20 exit code (counted as an error, never red)", () => {
    const v = mutantVerdict({ evidence: ENDPOINT, fake: [], diff: onPath(5), harnessErrors: [] });
    const r = e20Verdict(
      [{ id: "mutant V16-endpoint-path", outcome: v.outcome, detail: v.detail }],
      {},
      0,
      { cases: [], mutants: ["mutant V16-endpoint-path"] }
    );
    expect(r.code).toBe(1);
    expect(r.reasons[0]).toContain("ABORTED");
  });
});

describe("every V16 mutant declares the request that proves it ran", () => {
  test("the endpoint mutant needs POST /backend-api/codex/mutant", () => {
    const m = V16_MUTANTS.find((x) => x.id === "V16-endpoint-path");
    expect(m?.evidence).toMatchObject({ method: "POST", path: "/backend-api/codex/mutant" });
  });
  test.each(V16_MUTANTS.filter((m) => m.id !== "V16-endpoint-path").map((m) => m.id))(
    "%s needs POST /backend-api/codex/responses",
    (id) => {
      const m = V16_MUTANTS.find((x) => x.id === id);
      expect(m?.evidence).toMatchObject({ method: "POST", path: "/backend-api/codex/responses" });
    }
  );
});

// Review round 6 (D2, Gemini): red accepted ANY difference once the evidence request was seen,
// so a mutant that sent the request and then differed on an unrelated field read as red.
describe("D2: red needs a difference under the mutant's declared diff path", () => {
  // The run-15 captures, as `diffValues` paths (values dropped): ai-docs/sessions/
  // dev-feature-mtl-260-pool-bin-20261101-153857-c4a1/e20-run15/mutant-raw/<id>/{diff,fake-requests}.json.
  // That folder is gitignored, so the paths are copied here; every saved verdict must hold.
  const MODELS = { method: "GET", path: "/backend-api/codex/models" };
  const RESPONSES = { method: "POST", path: "/backend-api/codex/responses" };
  const RUN15: Record<
    string,
    {
      fake: Array<{ method: string; path: string }>;
      paths: string[];
      outcome: "mutant red" | "DEAD-MUTANT" | "ABORTED";
    }
  > = {
    "V16-endpoint-path": {
      fake: [{ method: "POST", path: "/backend-api/codex/mutant" }],
      paths: [
        "$.fake[0].method",
        "$.fake[0].path",
        "$.fake[0].search",
        "$.fake[0].headers.accept",
        "$.fake[0].headers.content-type",
        "$.fake[0].body",
        "$.fake[1]",
        "$.client.status",
        "$.client.body.content",
        "$.client.body.id",
        "$.client.body.model",
        "$.client.body.role",
        "$.client.body.stop_reason",
        "$.client.body.stop_sequence",
        "$.client.body.type",
        "$.client.body.usage",
        "$.client.body.error",
      ],
      outcome: "mutant red",
    },
    "V16-omit-header": {
      fake: [MODELS, RESPONSES],
      paths: ["$.fake[0].headers.originator", "$.fake[1].headers.originator"],
      outcome: "mutant red",
    },
    "V16-drop-transform": { fake: [MODELS, RESPONSES], paths: [], outcome: "DEAD-MUTANT" },
    "V16-drop-transform-both-layers": {
      fake: [MODELS, RESPONSES],
      paths: ["$.fake[1].body.include", "$.fake[1].body.store"],
      outcome: "mutant red",
    },
    "V16-remap": {
      fake: [MODELS, RESPONSES],
      paths: [
        "$.client.status",
        "$.client.body.error.message",
        "$.client.body.error.type",
        "$.client.body.error.provider_message",
        "$.client.body.error.upstream_status",
      ],
      outcome: "mutant red",
    },
  };
  const lines = (paths: string[]) => paths.map((p) => `${p}: baseline=1 candidate=2`);

  test.each(V16_MUTANTS.map((m) => m.id))("%s keeps its run-15 outcome", (id) => {
    const m = V16_MUTANTS.find((x) => x.id === id);
    const saved = RUN15[id];
    if (!m || !saved) throw new Error(`no run-15 data for ${id}`);
    const v = mutantVerdict({
      evidence: m.evidence,
      fake: saved.fake,
      diff: lines(saved.paths),
      harnessErrors: [],
    });
    expect(v.outcome).toBe(saved.outcome);
  });

  test.each(V16_MUTANTS.filter((m) => m.id !== "V16-drop-transform").map((m) => m.id))(
    "%s differing only elsewhere is ABORTED, never red",
    (id) => {
      const m = V16_MUTANTS.find((x) => x.id === id);
      if (!m) throw new Error(id);
      const v = mutantVerdict({
        evidence: m.evidence,
        fake: [MODELS, RESPONSES, { method: "POST", path: "/backend-api/codex/mutant" }],
        diff: lines(["$.client.body.id", "$.fake[1].headers.user-agent"]),
        harnessErrors: [],
      });
      expect(v.outcome).toBe("ABORTED");
      expect(v.detail).toContain("none under");
    }
  );

  test("underDiffPath matches the prefix at a path boundary and [*] as any index", () => {
    expect(underDiffPath("$.fake[3].headers.originator", "$.fake[*].headers.originator")).toBe(
      true
    );
    expect(underDiffPath("$.client.status", "$.client.status")).toBe(true);
    expect(underDiffPath("$.client.statusText", "$.client.status")).toBe(false);
    expect(underDiffPath("$.fake[0].body.store.x", "$.fake[*].body.store")).toBe(true);
    expect(underDiffPath("$.fake[x].path", "$.fake[*].path")).toBe(false);
    expect(diffPathOf('$.fake[1]: baseline={"a":1} candidate=undefined')).toBe("$.fake[1]");
  });
});

// Review round 6 (C4): a first-match-only scan let a real token hide behind a fake one.
describe("C4: every credential-shaped match is checked, not only the first", () => {
  const sk = `sk-proj-${"Z".repeat(30)}`;
  test("outputLeaks finds a real-looking key after an allowlisted fake token", () => {
    const leaks = outputLeaks({ stdout: "", stderr: `retry access-legacy then ${sk}` });
    expect(leaks.some((l) => l.includes("credential-shaped string"))).toBe(true);
    expect(leaks.join("\n")).not.toContain(sk.slice(3, 15));
  });
  test("clientLeaks finds it in the body after a fake token too", () => {
    const leaks = clientLeaks({
      client: { body: { m: `at-rotated-1 ${sk}` } },
      clientHeaders: {},
    });
    expect(leaks.some((l) => l.includes("credential-shaped string"))).toBe(true);
  });
  test("unknownSecretShapes lists every unknown match", () => {
    expect(unknownSecretShapes(`access-legacy ${sk} refresh-legacy ${sk}x`).length).toBe(2);
  });
});

// Review round 6 (D1): a start failure, connection error or crash threw out of the run before
// the secret scan and summary were written.
describe("D1: a step that throws is ABORTED and the run still ends in a scan and a summary", () => {
  test("guarded turns a throw into an ABORTED entry, redacting credential shapes", async () => {
    const jwt = `eyJ${"a".repeat(40)}.${"b".repeat(60)}.${"c".repeat(40)}`;
    const g = await guarded("mutant V16-remap", async () => {
      throw new Error(`serve did not start (V16-remap): stdout= stderr=bearer ${jwt}`);
    });
    expect(g.ok).toBe(false);
    if (g.ok) return;
    expect(g.entry.outcome).toBe("ABORTED");
    expect(g.entry.detail).toContain("serve did not start");
    expect(g.entry.detail).not.toContain(jwt.slice(0, 20));
    const ok = await guarded("x", async () => 7);
    expect(ok).toEqual({ ok: true, value: 7 });
  });

  test("finishE20 writes secret-scan.json and summary.json and fails on the ABORTED entry", async () => {
    const out = realpathSync(mkdtempSync(join(tmpdir(), "e20-finish-")));
    try {
      const g = await guarded("legacy-ok", async () => {
        throw new Error("POST failed (candidate): connection reset");
      });
      const summary: SummaryEntry[] = g.ok ? [] : [g.entry];
      const v = finishE20(
        out,
        summary,
        { baseline: null, candidate: null },
        {
          cases: ["legacy-ok"],
          mutants: [],
        }
      );
      expect(existsSync(join(out, "secret-scan.json"))).toBe(true);
      expect(JSON.parse(readFileSync(join(out, "summary.json"), "utf8"))[0].outcome).toBe(
        "ABORTED"
      );
      expect(v.code).toBe(1);
      expect(v.reasons.join("|")).toContain("legacy-ok: ABORTED");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("finishE20 counts a credential shape found in memory before a write as a violation", () => {
    const out = realpathSync(mkdtempSync(join(tmpdir(), "e20-finish-")));
    try {
      const v = finishE20(
        out,
        [{ id: "legacy-ok", outcome: "identical", detail: "x" }],
        { baseline: null, candidate: null },
        { cases: ["legacy-ok"], mutants: [] },
        [
          "legacy-ok/result.json @3: sk-key-shaped credential the bench did not create (40 chars, sha256 0)",
        ]
      );
      expect(v.code).toBe(1);
      expect(v.reasons.join("|")).toContain("secret scan");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
