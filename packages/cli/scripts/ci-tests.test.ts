import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_ESSENTIAL_PER_CATEGORY,
  type TierData,
  discover,
  filesInTier,
  forPlatform,
  loadTiers,
  slowCategoryOf,
  tierOf,
  validateTiers,
} from "./ci-tests";
import { slowestReport } from "./ci-tests";

const SCRIPT = join(import.meta.dir, "ci-tests.ts");
const dir = mkdtempSync(join(tmpdir(), "ci-tests-local-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const DATA: TierData = {
  heavySeconds: 2,
  slow: [
    {
      category: "pane",
      prefix: "src/pane/",
      essential: [{ file: "src/pane/a.test.ts", guards: "a session starts" }],
    },
    {
      category: "team",
      prefix: "src/team",
      essential: [{ file: "src/team-a.test.ts", guards: "a run settles" }],
    },
  ],
};

describe("tier derivation", () => {
  test("a slow category runs only its listed files; every other file of it is weekly", () => {
    expect(tierOf("src/pane/a.test.ts", DATA, {})).toBe("essential");
    expect(tierOf("src/pane/b.test.ts", DATA, {})).toBe("weekly");
    expect(tierOf("src/pane/nested/c.test.ts", DATA, {})).toBe("weekly");
  });

  test("a new file in a slow category is weekly by default, however fast it is", () => {
    expect(tierOf("src/pane/brand-new.test.ts", DATA, { "src/pane/brand-new.test.ts": 0 })).toBe(
      "weekly"
    );
  });

  test("a listed slow file stays essential however slow it is", () => {
    expect(tierOf("src/pane/a.test.ts", DATA, { "src/pane/a.test.ts": 90 })).toBe("essential");
  });

  test("a prefix without a trailing slash names files directly in that directory", () => {
    expect(slowCategoryOf("src/team-b.test.ts", DATA)).toBe("team");
    expect(slowCategoryOf("src/teams/x.test.ts", DATA)).toBeUndefined();
    expect(slowCategoryOf("src/pane/deep/x.test.ts", DATA)).toBe("pane");
    expect(tierOf("src/team-b.test.ts", DATA, {})).toBe("weekly");
  });

  test("any other file is weekly only at or above the heavy threshold", () => {
    const times = { "src/x.test.ts": 2, "src/y.test.ts": 1.9, "src/z.test.ts": 12 };
    expect(tierOf("src/x.test.ts", DATA, times)).toBe("weekly");
    expect(tierOf("src/y.test.ts", DATA, times)).toBe("essential");
    expect(tierOf("src/z.test.ts", DATA, times)).toBe("weekly");
  });

  test("an unmeasured file outside the slow categories is essential", () => {
    expect(tierOf("src/new.test.ts", DATA, {})).toBe("essential");
  });

  test("a pinned file stays essential however slow it is", () => {
    const data: TierData = {
      ...DATA,
      pinned: [{ file: "src/guard.test.ts", guards: "a credential reload" }],
    };
    expect(tierOf("src/guard.test.ts", data, { "src/guard.test.ts": 46 })).toBe("essential");
    expect(tierOf("src/other.test.ts", data, { "src/other.test.ts": 46 })).toBe("weekly");
  });

  test("a macOnly file is left out on Linux and kept on macOS", () => {
    const data: TierData = {
      ...DATA,
      macOnly: [{ file: "src/agy.test.ts", guards: "the shared token store is macOS-only" }],
    };
    const files = ["src/a.test.ts", "src/agy.test.ts"];
    expect(forPlatform(files, data, "linux")).toEqual(["src/a.test.ts"]);
    expect(forPlatform(files, data, "darwin")).toEqual(files);
    expect(forPlatform(files, DATA, "linux")).toEqual(files);
  });

  test("the full tier is every file; the essential tier keeps discovery order", () => {
    const files = ["src/a.test.ts", "src/pane/a.test.ts", "src/pane/b.test.ts", "src/z.test.ts"];
    const times = { "src/z.test.ts": 5 };
    expect(filesInTier(files, "full", DATA, times)).toEqual(files);
    expect(filesInTier(files, "essential", DATA, times)).toEqual([
      "src/a.test.ts",
      "src/pane/a.test.ts",
    ]);
  });
});

describe("validateTiers", () => {
  const known = ["src/pane/a.test.ts", "src/pane/b.test.ts", "src/team-a.test.ts"];

  test("the data above is valid", () => {
    expect(validateTiers(DATA, known)).toEqual([]);
  });

  test("an essential file that does not exist is an error", () => {
    const data: TierData = {
      ...DATA,
      slow: [
        {
          category: "pane",
          prefix: "src/pane/",
          essential: [{ file: "src/pane/gone.test.ts", guards: "x" }],
        },
      ],
    };
    expect(validateTiers(data, known).join("\n")).toContain("src/pane/gone.test.ts");
  });

  test(`a category with more than ${MAX_ESSENTIAL_PER_CATEGORY} essential files is an error`, () => {
    const files = ["a", "b", "c", "d"].map((n) => `src/pane/${n}.test.ts`);
    const data: TierData = {
      heavySeconds: 2,
      slow: [
        {
          category: "pane",
          prefix: "src/pane/",
          essential: files.map((file) => ({ file, guards: "x" })),
        },
      ],
    };
    expect(validateTiers(data, files).join("\n")).toMatch(/pane.*4 essential files/);
  });

  test("an essential file outside its own category, or listed twice, is an error", () => {
    const data: TierData = {
      heavySeconds: 2,
      slow: [
        {
          category: "pane",
          prefix: "src/pane/",
          essential: [
            { file: "src/team-a.test.ts", guards: "x" },
            { file: "src/pane/a.test.ts", guards: "x" },
            { file: "src/pane/a.test.ts", guards: "x" },
          ],
        },
      ],
    };
    const errors = validateTiers(data, known).join("\n");
    expect(errors).toContain("src/team-a.test.ts is not in category pane");
    expect(errors).toContain("src/pane/a.test.ts is listed twice");
  });

  test("a category named twice is an error, so a copied block cannot hold a 4th essential file", () => {
    const files = ["a", "b", "c", "d"].map((n) => `src/pane/${n}.test.ts`);
    const data: TierData = {
      heavySeconds: 2,
      slow: [
        {
          category: "pane",
          prefix: "src/pane/",
          essential: files.slice(0, 3).map((file) => ({ file, guards: "x" })),
        },
        {
          category: "pane",
          prefix: "src/pane/",
          essential: [{ file: "src/pane/d.test.ts", guards: "x" }],
        },
      ],
    };
    const errors = validateTiers(data, files).join("\n");
    expect(errors).toContain("category pane is named twice");
    expect(errors).toContain("prefix src/pane/ is named twice");
  });

  test("a prefix named twice, under another category name, is an error", () => {
    const data: TierData = {
      heavySeconds: 2,
      slow: [...DATA.slow, { category: "pane-copy", prefix: "src/pane/", essential: [] }],
    };
    expect(validateTiers(data, known).join("\n")).toContain("prefix src/pane/ is named twice");
  });

  test("a prefix that takes files of another category's prefix is an error", () => {
    for (const [outer, inner] of [
      ["src/pane/", "src/pane/sub/"],
      ["src/team", "src/teamx"],
      ["src/team", "src/team-"],
    ] as const) {
      const data: TierData = {
        heavySeconds: 2,
        slow: [
          { category: "outer", prefix: outer, essential: [] },
          { category: "inner", prefix: inner, essential: [] },
        ],
      };
      expect(validateTiers(data, known).join("\n")).toContain(
        `prefix ${inner} (category inner) overlaps prefix ${outer} (category outer)`
      );
    }
  });

  test("prefixes that share no file are valid: a bare prefix and the directory of that name", () => {
    const data: TierData = {
      heavySeconds: 2,
      slow: [
        { category: "team", prefix: "src/team", essential: [] },
        { category: "team-dir", prefix: "src/team/", essential: [] },
        { category: "teams-dir", prefix: "src/teams/", essential: [] },
      ],
    };
    const files = ["src/team-a.test.ts", "src/team/x.test.ts", "src/teams/y.test.ts"];
    expect(validateTiers(data, files)).toEqual([]);
  });

  test("a pinned list that is not an array, or a pinned entry that is not an object, is an error", () => {
    for (const pinned of [{}, "src/x.test.ts", [null], ["src/x.test.ts"], [{ file: "" }]]) {
      const data = { ...DATA, pinned } as unknown as TierData;
      expect(validateTiers(data, known).join("\n")).toContain("pinned");
    }
  });

  test("a pinned file that is missing, in a slow category, named twice or without guards is an error", () => {
    const files = [...known, "src/guard.test.ts"];
    const data: TierData = {
      ...DATA,
      pinned: [
        { file: "src/gone.test.ts", guards: "x" },
        { file: "src/pane/b.test.ts", guards: "x" },
        { file: "src/guard.test.ts", guards: "x" },
        { file: "src/guard.test.ts", guards: " " },
      ],
    };
    const errors = validateTiers(data, files).join("\n");
    expect(errors).toContain("pinned src/gone.test.ts is not a test file");
    expect(errors).toContain("pinned src/pane/b.test.ts is in slow category pane");
    expect(errors).toContain("pinned src/guard.test.ts is listed twice");
    expect(errors).toContain("pinned src/guard.test.ts has no guards text");
  });

  test("a macOnly entry that is missing, named twice, malformed or without guards is an error", () => {
    const files = [...known, "src/agy.test.ts"];
    const data: TierData = {
      ...DATA,
      macOnly: [
        { file: "src/gone.test.ts", guards: "x" },
        { file: "src/agy.test.ts", guards: "x" },
        { file: "src/agy.test.ts", guards: " " },
      ],
    };
    const errors = validateTiers(data, files).join("\n");
    expect(errors).toContain("macOnly src/gone.test.ts is not a test file");
    expect(errors).toContain("macOnly src/agy.test.ts is listed twice");
    expect(errors).toContain("macOnly src/agy.test.ts has no guards text");
    const bad = { ...DATA, macOnly: "src/agy.test.ts" } as unknown as TierData;
    expect(validateTiers(bad, files).join("\n")).toContain("macOnly must be an array");
  });

  test("the four Antigravity token-store test files are macOS-only", () => {
    const macOnly = (loadTiers().macOnly ?? []).map((e) => e.file);
    expect(macOnly).toEqual(
      expect.arrayContaining([
        "src/subscription-probe-command.test.ts",
        "src/auth/antigravity-user.account-switch.test.ts",
        "src/auth/antigravity-client-version-regression.test.ts",
        "src/model-selector-antigravity-order.test.ts",
      ])
    );
  });

  test("a valid pinned list passes", () => {
    const data: TierData = { ...DATA, pinned: [{ file: "src/guard.test.ts", guards: "x" }] };
    expect(validateTiers(data, [...known, "src/guard.test.ts"])).toEqual([]);
  });

  test("a root value that is not an object is an error, not a crash", () => {
    for (const root of [null, [], "x", 3]) {
      const errors = validateTiers(root as unknown as TierData, known).join("\n");
      expect(errors).toContain("must be a JSON object");
    }
  });

  test("an infinite or non-finite heavySeconds is an error", () => {
    for (const heavySeconds of [Number.POSITIVE_INFINITY, Number.NaN]) {
      const data: TierData = { heavySeconds, slow: [] };
      expect(validateTiers(data, known).join("\n")).toContain("heavySeconds must be a positive");
    }
  });

  test("a missing or non-array slow list is an error, not a crash", () => {
    for (const slow of [undefined, {}, "src/pane/"]) {
      const data = { heavySeconds: 2, slow } as unknown as TierData;
      expect(validateTiers(data, known).join("\n")).toContain("slow must be an array");
    }
  });

  test("a category without a non-empty string category or prefix is an error", () => {
    const data = {
      heavySeconds: 2,
      slow: [
        { category: "", prefix: "src/pane/", essential: [] },
        { category: "team", prefix: 7, essential: [] },
        { prefix: "src/x/", essential: [] },
      ],
    } as unknown as TierData;
    const errors = validateTiers(data, [...known, "src/x/a.test.ts"]).join("\n");
    expect(errors).toContain('slow[0] needs a non-empty string "category"');
    expect(errors).toContain('slow[1] needs a non-empty string "prefix"');
    expect(errors).toContain('slow[2] needs a non-empty string "category"');
  });

  test("an essential entry that is not an object with string file and guards is an error, not a crash", () => {
    const data = {
      heavySeconds: 2,
      slow: [
        {
          category: "pane",
          prefix: "src/pane/",
          essential: ["src/pane/a.test.ts", null, { file: "src/pane/b.test.ts", guards: 3 }],
        },
        { category: "team", prefix: "src/team", essential: [{ guards: "x" }] },
      ],
    } as unknown as TierData;
    let errors = "";
    expect(() => {
      errors = validateTiers(data, known).join("\n");
    }).not.toThrow();
    expect(errors).toContain(
      'category pane essential[0] must be an object with non-empty strings "file" and "guards"'
    );
    expect(errors).toContain(
      'category pane essential[1] must be an object with non-empty strings "file" and "guards"'
    );
    expect(errors).toContain('category pane essential[2] needs a non-empty string "guards"');
    expect(errors).toContain('category team essential[0] needs a non-empty string "file"');
  });

  test("a prefix that matches no test file is an error, even with no essential file listed", () => {
    const data: TierData = {
      heavySeconds: 2,
      slow: [...DATA.slow, { category: "panes", prefix: "src/panes/", essential: [] }],
    };
    expect(validateTiers(data, known).join("\n")).toContain(
      "prefix src/panes/ (category panes) matches no test file"
    );
  });

  test("a file listed in two categories is an error", () => {
    const data: TierData = {
      heavySeconds: 2,
      slow: [
        DATA.slow[0] as TierData["slow"][number],
        {
          category: "pane-copy",
          prefix: "src/pane-copy/",
          essential: [{ file: "src/pane/a.test.ts", guards: "x" }],
        },
      ],
    };
    expect(validateTiers(data, known).join("\n")).toContain("src/pane/a.test.ts is listed twice");
  });

  test("an essential file with no reason, or a threshold that is not a positive number, is an error", () => {
    const data = {
      heavySeconds: 0,
      slow: [
        {
          category: "pane",
          prefix: "src/pane/",
          essential: [{ file: "src/pane/a.test.ts", guards: "  " }],
        },
      ],
    } as TierData;
    const errors = validateTiers(data, known).join("\n");
    expect(errors).toContain("heavySeconds");
    expect(errors).toContain("src/pane/a.test.ts has no guards text");
  });

  test("the credential-file and metered-billing guard tests are pinned essential", () => {
    const pinned = (loadTiers().pinned ?? []).map((e) => e.file);
    expect(pinned).toEqual(
      expect.arrayContaining([
        "src/auth/credential-file.test.ts",
        "src/auth/grok-oauth.reload.test.ts",
        "src/auth/kimi-oauth.reload.test.ts",
        "src/providers/devin/devin-credentials.reload.test.ts",
        "src/handlers/composed-handler-accounts-2a.test.ts",
        "src/handlers/v14-merge-fixes.test.ts",
      ])
    );
  });

  test("the pane essentials run the two-socket check's rejections, a writable view socket included", () => {
    const pane = loadTiers().slow.find((c) => c.category === "pane");
    const files = pane?.essential.map((e) => e.file) ?? [];
    expect(files).toContain("src/pane/view-socket.test.ts");
    const source = readFileSync(
      join(import.meta.dir, "..", "src/pane/view-socket.test.ts"),
      "utf8"
    );
    expect(source).toContain("{ readOnly: false }");
  });

  test("the tracked test-tiers.json names only existing files, at most 3 per category", () => {
    expect(validateTiers(loadTiers(), discover())).toEqual([]);
  });
});

describe.skipIf(process.env.CLAUDISH_CI_TESTS_NESTED === "1")("--tier", () => {
  function cli(...args: string[]) {
    const r = Bun.spawnSync([process.execPath, "--no-env-file", SCRIPT, ...args], {
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  }
  const total = (out: string) =>
    [...out.matchAll(/\t(\d+) files\t/g)].reduce((s, m) => s + Number(m[1]), 0);

  test("--plan shows the tier, and the essential tier is a subset of the full tier", () => {
    const essential = cli("--plan", "pane@6", "--tier", "essential");
    const full = cli("--plan", "pane@6", "--tier", "full");
    expect(essential.code).toBe(0);
    expect(full.code).toBe(0);
    expect(essential.out).toContain("tier essential");
    expect(full.out).toContain("tier full");
    expect(total(essential.out)).toBeGreaterThan(0);
    expect(total(essential.out)).toBeLessThan(total(full.out));
  });

  test("--plan with no --tier plans the essential tier", () => {
    const plain = cli("--plan", "pane@6");
    expect(plain.out).toContain("tier essential");
    expect(total(plain.out)).toBe(total(cli("--plan", "pane@6", "--tier", "essential").out));
  });

  test("an unknown tier is refused", () => {
    const r = cli("--plan", "pane@6", "--tier", "nightly");
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('unknown tier "nightly"');
  });
});

describe("slowestReport", () => {
  test("lists the slowest files first, with the total over every file", () => {
    const lines = slowestReport({ "a.test.ts": 1.25, "b.test.ts": 30, "c.test.ts": 4 }, 2);
    expect(lines).toEqual([
      "[ci-tests] slowest 2 of 3 test files, 35.3 s in all:",
      "   30.0 s  b.test.ts",
      "    4.0 s  c.test.ts",
    ]);
  });

  test("an empty report says so instead of printing a header over nothing", () => {
    expect(slowestReport({}, 5)).toEqual(["[ci-tests] no test file timings in the junit report"]);
  });
});

// A `--local` that ignored its file would run this whole package, this file included, and
// each copy would start another. The processes these tests start carry the marker, and a
// copy that has it skips these tests, so such a bug fails once instead of multiplying.
const NESTED = "CLAUDISH_CI_TESTS_NESTED";

describe.skipIf(process.env[NESTED] === "1")("--local", () => {
  async function local(body: string, name: string, dash = true) {
    const file = join(dir, `${name}.test.ts`);
    writeFileSync(file, `import { test } from "bun:test";\n${body}\n`);
    const out = join(dir, `${name}.xml`);
    const args = dash ? ["--local", out, "--", file] : ["--local", out, file];
    const proc = Bun.spawn([process.execPath, SCRIPT, ...args], {
      env: { ...process.env, [NESTED]: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, text: stdout + stderr, out };
  }

  test("writes the junit report and prints the per-file timing after a green run", async () => {
    const r = await local('test("ok", () => {});', "green");
    expect(r.code).toBe(0);
    expect(existsSync(r.out)).toBe(true);
    expect(r.text).toContain("[ci-tests] slowest 1 of 1 test files");
    expect(r.text).toContain("green.test.ts");
  }, 60_000);

  test("keeps bun test's exit code when a test fails, and still prints the timing", async () => {
    const r = await local('test("red", () => { throw new Error("red"); });', "red");
    expect(r.code).toBe(1);
    expect(r.text).toContain("[ci-tests] slowest 1 of 1 test files");
    expect(r.text).toContain("red.test.ts");
  }, 60_000);

  test("a run that writes no report never prints the previous run's report", async () => {
    const out = join(dir, "stale.xml");
    writeFileSync(
      out,
      '<testsuites><testsuite name="old-run.test.ts" file="old-run.test.ts"><testcase name="t" time="9"/></testsuite></testsuites>'
    );
    const proc = Bun.spawn(
      [process.execPath, SCRIPT, "--local", out, "--", join(dir, "missing.test.ts")],
      { env: { ...process.env, [NESTED]: "1" }, stdout: "pipe", stderr: "pipe" }
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code).toBe(1);
    expect(stdout + stderr).not.toContain("old-run.test.ts");
    expect(stdout + stderr).toContain("[ci-tests] no test file timings in the junit report");
  }, 60_000);

  test("passes a file given without `--` to bun test, as `bun run test <file>` does", async () => {
    const r = await local('test("ok", () => {});', "nodash", false);
    expect(r.code).toBe(0);
    expect(r.text).toContain("[ci-tests] slowest 1 of 1 test files");
  }, 60_000);
});
