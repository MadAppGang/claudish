import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVIDENCE_FILES, isProductOutput, scanLeaks, withReleases } from "./harness.ts";

const roots: string[] = [];
function dirWith(files: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "leak-scan-")));
  roots.push(dir);
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

// The V10 values (rows.ts): a label letter followed by a digit.
const V10_VALUES = ["access-A2", "refresh-A2", "access-A3"];
const CLIENT_FILES = ["response.json", "stdout.txt", "stderr.txt", "transcript-1.jsonl"];

describe("scanLeaks", () => {
  test.each(V10_VALUES.flatMap((v) => CLIENT_FILES.map((f) => [v, f] as const)))(
    "the shape net fails on %s in %s",
    (value, file) => {
      const dir = dirWith({ [file]: `{"echo":"${value}"}` });
      expect(scanLeaks(dir).join("|")).toContain(value);
    }
  );

  test.each(V10_VALUES.flatMap((v) => CLIENT_FILES.map((f) => [v, f] as const)))(
    "the exact net fails on %s in %s even when the shape would not match",
    (value, file) => {
      // Glued to letters on both sides: no word boundary, so only the exact net can see it.
      const dir = dirWith({ [file]: `xx${value}yy` });
      expect(scanLeaks(dir, [value]).join("|")).toContain("seeded credential");
      expect(scanLeaks(dir)).toEqual([]);
    }
  );

  test("a replacement token the fake issues is caught by value", () => {
    const dir = dirWith({ "response.json": "token at-rotated-12 and rt-rotated-3" });
    expect(scanLeaks(dir).join("|")).toContain("at-rotated-12");
  });

  test("a clean directory and a non-client file pass", () => {
    const dir = dirWith({ "response.json": "OK", "accounts.jsonl": "access-A2" });
    expect(scanLeaks(dir, ["access-A2"])).toEqual([]);
  });
});

describe("every product-output file is scanned", () => {
  const CANARY = "sk-canary-must-never-be-used";
  test.each(["access-A", "refresh-A", CANARY])("account-disable.txt holding %s fails", (value) => {
    const dir = dirWith({ "account-disable.txt": `disabled A (${value})` });
    expect(scanLeaks(dir, ["access-A", "refresh-A"]).length).toBeGreaterThan(0);
  });

  test("an arbitrary new file name is scanned by default", () => {
    const dir = dirWith({ "brand-new-output.log": `x ${CANARY}` });
    expect(scanLeaks(dir)[0]).toContain("canary api key");
    expect(isProductOutput("brand-new-output.log")).toBe(true);
  });

  test("only the explicit evidence files are exempt", () => {
    const dir = dirWith(
      Object.fromEntries([...EVIDENCE_FILES].map((f) => [f, "access-A refresh-A"]))
    );
    expect(scanLeaks(dir, ["access-A"])).toEqual([]);
  });

  test("no file the rows save through ctx.save is an evidence file", () => {
    // Every literal name passed to c.save / ctx.save in rows.ts and harness.ts must be scanned.
    const names = new Set<string>();
    for (const f of ["rows.ts", "harness.ts"]) {
      const text = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
      for (const m of text.matchAll(/\b(?:c|ctx)\.save\(\s*[`"']([^`"'$]+)/g))
        names.add(m[1] as string);
    }
    expect(names.has("account-disable.txt")).toBe(true);
    for (const n of names) expect(isProductOutput(n)).toBe(true);
  });
});

describe("withReleases", () => {
  test("releases in reverse order when the body throws mid-acquisition", async () => {
    const log: string[] = [];
    await expect(
      withReleases(async (release) => {
        release(() => log.push("sink"));
        release(() => log.push("canary"));
        throw new Error("fake failed to start");
      })
    ).rejects.toThrow("fake failed to start");
    expect(log).toEqual(["canary", "sink"]);
  });

  test("a failing release does not stop the others, and the result is returned", async () => {
    const log: string[] = [];
    const out = await withReleases(async (release) => {
      release(() => log.push("a"));
      release(() => {
        throw new Error("already stopped");
      });
      return 7;
    });
    expect(out).toBe(7);
    expect(log).toEqual(["a"]);
  });
});
