/**
 * The end of a run (review round 6): processes are stopped before any cleanup, and the files
 * written after the directory scans (result.json, outcome.json) are scanned in memory first.
 * No process, keychain or network here: fake producers and temp directories only.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Producer } from "./direct.ts";
import { describeBearers, finalizeRecord, teardownRun } from "./harness.ts";
import {
  type RowOutcome,
  errorOutcome,
  harnessErrorOf,
  outcomeLines,
  writeOutcomeScanned,
} from "./run-row.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "run-end-")));
  dirs.push(d);
  return d;
};

/** A JWT-shaped value of realistic length, built at run time (no token literal). */
const jwtLike = () => {
  const seg = (s: string, n: number) =>
    createHash("sha256")
      .update(s)
      .digest("base64url")
      .repeat(Math.ceil(n / 43))
      .slice(0, n);
  return `eyJ${seg("h", 30)}.eyJ${seg("p", 1400)}.${seg("s", 340)}`;
};

function producer(name: string, events: string[], dies = true): Producer {
  return {
    name,
    pid: 4242,
    kill: () => events.push(`kill ${name}`),
    confirmGone: async () => {
      events.push(`kill ${name}`);
      await Bun.sleep(20); // the tree takes a moment to go
      events.push(dies ? `gone ${name}` : `still alive ${name}`);
      return dies;
    },
    confirmGoneSync: () => dies,
  };
}

describe("teardownRun: processes first, confirmed gone, then the cleanups (A2)", () => {
  test("a live serve is confirmed gone before V2e's keychain cleanup runs", async () => {
    const events: string[] = [];
    const alive = await teardownRun(
      [producer("serve 1", events), producer("serve 2", events)],
      [() => void events.push("cleanup: keychain delete")]
    );
    expect(alive).toEqual([]);
    const del = events.indexOf("cleanup: keychain delete");
    expect(events.indexOf("gone serve 1")).toBeLessThan(del);
    expect(events.indexOf("gone serve 2")).toBeLessThan(del);
  });

  test("a process that is not confirmed gone is named; cleanups still run, in reverse order", async () => {
    const events: string[] = [];
    const alive = await teardownRun(
      [producer("serve 1", events, false)],
      [() => void events.push("first registered"), () => void events.push("second registered")],
      50
    );
    expect(alive).toEqual(["serve 1 pid 4242"]);
    expect(events.slice(-2)).toEqual(["second registered", "first registered"]);
  });
});

describe("result.json is scanned in memory before it is written (C2)", () => {
  const base = {
    rowId: "V2e",
    variant: "real",
    egress: [],
    obs: { canary: 0, mainCount: 2, exchanges: { ok: 1, invalidGrant: 0 } },
    known: ["access-A", "refresh-A"],
  };

  test("a credential in a note fails the run and is written redacted", () => {
    const dir = tempDir();
    const jwt = jwtLike();
    const checks = [{ name: "[row] x", ok: true, detail: "" }];
    const rec = finalizeRecord({
      ...base,
      dir,
      checks,
      notes: { harnessError: `first error: ${jwt.slice(0, 160)}` },
      pre: { ok: true, detail: "HTTP 200" },
    });
    expect(rec.pass).toBe(false);
    expect(rec.obs.failedChecks).toContain(
      "[standing] no real-credential-shaped string in result.json"
    );
    const written = readFileSync(join(dir, "result.json"), "utf8");
    expect(written).not.toContain(jwt.slice(0, 40));
    expect(written).toContain("<redacted 160 chars, sha256 ");
  });

  test("a clean record passes and is written unchanged", () => {
    const dir = tempDir();
    const rec = finalizeRecord({
      ...base,
      dir,
      checks: [{ name: "[row] x", ok: true, detail: "Bearer access-A" }],
      notes: {},
      pre: { ok: true, detail: "HTTP 200" },
    });
    expect(rec.pass).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "result.json"), "utf8")).rowId).toBe("V2e");
  });

  test("the pre-flight detail names bearers by hash, never by value", () => {
    const jwt = jwtLike();
    const d = describeBearers([`Bearer ${jwt}`, "Bearer access-A", null]);
    expect(d).not.toContain(jwt.slice(0, 12));
    expect(d).not.toContain("access-A");
    expect(d).toMatch(
      /^Bearer <\d+ chars, sha256 [0-9a-f]{12}> -> Bearer <8 chars, sha256 [0-9a-f]{12}> -> none$/
    );
    // Two requests on one bearer read the same.
    const [a, b] = describeBearers(["Bearer access-A", "Bearer access-A"]).split(" -> ");
    expect(a).toBe(b);
  });
});

describe("outcome.json is scanned in memory before it is written (C2)", () => {
  const outcome = (failedChecks: string[]): RowOutcome => ({
    id: "V2e",
    row: "V2e",
    drive: "direct",
    verdict: "FAIL",
    flaky: false,
    canary: 0,
    expectedCanary: 0,
    mutants: [],
    failedChecks,
    dir: "/x",
    attempts: 1,
  });

  test("a credential in a failed check turns the row into ERROR and is written redacted", () => {
    const dir = tempDir();
    const sk = `sk-proj-${createHash("sha256").update("k").digest("hex").slice(0, 32)}`;
    const o = writeOutcomeScanned(join(dir, "outcome.json"), outcome([`auth ${sk}`]), (x) =>
      JSON.stringify(x, null, 2)
    );
    expect(o.verdict).toBe("ERROR");
    expect(o.failedChecks.at(-1)).toContain("sk-key-shaped credential");
    const written = readFileSync(join(dir, "outcome.json"), "utf8");
    expect(written).not.toContain(sk.slice(3, 20));
    expect(JSON.parse(written).verdict).toBe("ERROR");
  });

  test("a clean outcome is written as it is", () => {
    const dir = tempDir();
    const o = writeOutcomeScanned(join(dir, "outcome.json"), outcome(["[row] x [1]"]), (x) =>
      JSON.stringify(x)
    );
    expect(o.verdict).toBe("FAIL");
  });
});

// Review round 7 (GPT HIGH 3, Gemini LOW 1): the FILES were written redacted, but the record
// and outcome RETURNED to run-row (and printed by it) still held the raw value, and the
// harness-error early return bypassed the outcome scan entirely.
describe("returned records, outcomes and console lines hold no part of a credential (R7-3)", () => {
  const hex = (s: string, n: number) =>
    createHash("sha256").update(s).digest("hex").repeat(4).slice(0, n);
  const jwt = jwtLike();
  const sk = `sk-proj-${hex("k3", 40)}`;
  const rt = `rt_${hex("r3", 40)}`;
  const secrets = [jwt, sk, rt];
  /** Every 6-character piece of every secret that appears in `text`. */
  const leaks = (text: string) =>
    secrets.flatMap((v) => {
      const found: string[] = [];
      for (let i = 0; i + 6 <= v.length; i++) {
        const piece = v.slice(i, i + 6);
        if (text.includes(piece)) found.push(piece);
      }
      return found;
    });
  const base = {
    id: "V2e",
    row: "V2e",
    drive: "direct",
    expectedCanary: 0,
    dir: "/x",
  };
  /** What run-row prints for a row, captured from console.log. */
  const printed = (o: RowOutcome) => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    try {
      for (const line of outcomeLines(o, 12)) console.log(line);
    } finally {
      console.log = original;
    }
    return lines.join("\n");
  };

  test("finalizeRecord returns the record sanitized: notes, check detail, error", () => {
    const dir = tempDir();
    const rec = finalizeRecord({
      rowId: "V2e",
      variant: "real",
      egress: [],
      obs: { canary: 0, mainCount: 2, exchanges: { ok: 1, invalidGrant: 0 } },
      known: [],
      dir,
      checks: [{ name: "[row] bearer rotated", ok: false, detail: `Bearer ${sk} rejected` }],
      notes: { harnessError: `refresh failed: ${jwt}`, other: `presented ${rt}` },
      error: `run threw on ${jwt.slice(0, 160)}`,
      pre: { ok: true, detail: "HTTP 200" },
    });
    expect(rec.pass).toBe(false);
    expect(leaks(JSON.stringify(rec))).toEqual([]);
    expect(leaks(readFileSync(join(dir, "result.json"), "utf8"))).toEqual([]);
    // run-row's harness-error early return, fed with this record, prints nothing either.
    const odir = tempDir();
    const o = errorOutcome(
      join(odir, "outcome.json"),
      base,
      rec.obs.canary,
      harnessErrorOf(rec.obs.notes) ?? "",
      1
    );
    expect(leaks(JSON.stringify(o))).toEqual([]);
    expect(leaks(printed(o))).toEqual([]);
  });

  test("errorOutcome (the harness-error early return) sanitizes a raw message and scans its file", () => {
    const dir = tempDir();
    const o = errorOutcome(join(dir, "outcome.json"), base, 0, `harness error: ${jwt} / ${rt}`, 1);
    expect(o.verdict).toBe("ERROR");
    expect(leaks(JSON.stringify(o))).toEqual([]);
    expect(leaks(readFileSync(join(dir, "outcome.json"), "utf8"))).toEqual([]);
    expect(leaks(printed(o))).toEqual([]);
    expect(o.failedChecks.join("\n")).toContain("credential-shaped string");
  });

  test("writeOutcomeScanned returns failed checks and mutant notes sanitized", () => {
    const dir = tempDir();
    const raw: RowOutcome = {
      ...base,
      verdict: "FAIL",
      flaky: false,
      canary: 0,
      mutants: [
        {
          id: "m1",
          expected: "red",
          outcome: "ERROR",
          asExpected: false,
          note: `run error: ${sk}`,
          dir: "/x/m1",
          canary: 0,
        },
      ],
      failedChecks: [`[row] auth [Bearer ${sk}]`, `[row] note [${jwt}]`],
      attempts: 1,
    };
    const o = writeOutcomeScanned(join(dir, "outcome.json"), raw, (x) => JSON.stringify(x));
    expect(o.verdict).toBe("ERROR");
    expect(leaks(JSON.stringify(o))).toEqual([]);
    expect(leaks(printed(o))).toEqual([]);
  });

  test("a console line is redacted even for an outcome that skipped every sanitizer", () => {
    const raw: RowOutcome = {
      ...base,
      verdict: "ERROR",
      flaky: false,
      canary: 0,
      mutants: [],
      failedChecks: [`raw ${jwt}`, `raw ${sk}`, `raw ${rt}`],
      attempts: 1,
    };
    const out = printed(raw);
    expect(out).toContain("<redacted ");
    expect(leaks(out)).toEqual([]);
  });
});
