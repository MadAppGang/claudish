/**
 * Row driver.
 *
 *   bun ai-docs/benches/account-pool-validation/run-row.ts --all
 *   bun ai-docs/benches/account-pool-validation/run-row.ts --row V1            (every variant of V1)
 *   bun ai-docs/benches/account-pool-validation/run-row.ts --row V1:direct
 *   bun ai-docs/benches/account-pool-validation/run-row.ts --list
 *   bun ai-docs/benches/account-pool-validation/run-row.ts --all --out <dir> [--no-offline]
 *
 * Per row: a pre-flight on a scratch HOME, a canary self-test, then the row against
 * the BUILT launcher (`packages/cli/bin/claudish.cjs`), then once per mutant against
 * a scratch COPY of the bundle (`mutants.ts`). Verdicts:
 *
 *   PASS         the real bundle met every contract check and every required mutant turned red
 *   FAIL         a contract check failed on the real bundle (re-run once to rule out a flake)
 *   DEAD-MUTANT  the real bundle passed but a required mutant did not turn the row red:
 *                the row is "not evidence" (rows-contract.md section 1)
 *   ERROR        the harness could not run the row
 *
 * The pin (version, sha256 of bundle and launcher, git HEAD and status, Claude Code
 * version, catalog generation) is written BEFORE any row runs and is the first thing
 * in `rows-summary.md`. Nothing real is touched: HOME is a fresh temp tree per run,
 * the child environment is a whitelist and every token is fake.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Check } from "./agree.ts";
import { standingBroken } from "./e20-gate.ts";
import { type Obs, type RunRecord, executeRun } from "./harness.ts";
import { MUTANTS } from "./mutants.ts";
import { REPO, buildEnv, makeRowRoot, pinOf, run } from "./row-env.ts";
import { ROWS, type RowSpec } from "./rows.ts";
import { CATALOG_FIXTURE } from "./seed.ts";

export interface MutantOutcome {
  id: string;
  expected: "red" | "dead";
  outcome: "RED" | "DEAD" | "ERROR";
  /** `ok` when the outcome is what the contract expects. */
  asExpected: boolean;
  note: string;
  dir: string;
  canary: number;
}

export interface RowOutcome {
  id: string;
  row: string;
  drive: string;
  verdict: "PASS" | "FAIL" | "DEAD-MUTANT" | "ERROR";
  flaky: boolean;
  canary: number;
  expectedCanary: number;
  mutants: MutantOutcome[];
  mutantNote?: string;
  failedChecks: string[];
  dir: string;
  attempts: number;
}

const dirName = (id: string) => id.replace(/[^A-Za-z0-9._-]/g, "-");

function sessionDefault(): string {
  return (
    process.env.SESSION_PATH ??
    join(REPO, "ai-docs/sessions/dev-feature-mtl-260-pool-bin-20261101-153857-c4a1")
  );
}

/** Set once by main, before any row runs; every result file carries it first. */
let currentPin: Record<string, string> | undefined;

async function runRealWithRetry(
  spec: RowSpec,
  rowDir: string,
  common: { offline: boolean; mutantTreesDir: string }
): Promise<{ record: RunRecord; attempts: number; flaky: boolean }> {
  const attempt = (dir: string) => {
    const plan = spec.make(); // fresh per run: resets and clocks are never shared
    return executeRun(spec.id, plan.setup, plan.run, {
      dir,
      offline: common.offline,
      mutantTreesDir: common.mutantTreesDir,
      canaryExpected: spec.canary,
      expectsFakeRequests: spec.expectsFakeRequests,
      rowId: spec.id,
      pin: currentPin,
    });
  };
  rmSync(rowDir, { recursive: true, force: true });
  let record = await attempt(rowDir);
  if (record.pass) return { record, attempts: 1, flaky: false };
  // Re-run once to rule out a flake; keep the first attempt's evidence.
  const firstDir = `${rowDir}-attempt1`;
  rmSync(firstDir, { recursive: true, force: true });
  await Bun.$`mv ${rowDir} ${firstDir}`.quiet();
  record = await attempt(rowDir);
  return { record, attempts: 2, flaky: record.pass };
}

export async function runOneRow(spec: RowSpec, out: string, offline: boolean): Promise<RowOutcome> {
  const rowDir = join(out, "rows", dirName(spec.id));
  const mutantTreesDir = join(out, "mutant-trees");
  mkdirSync(rowDir, { recursive: true });
  const base = {
    id: spec.id,
    row: spec.row,
    drive: spec.drive,
    expectedCanary: spec.canary,
    mutantNote: spec.mutantNote,
    dir: rowDir,
  };
  let real: { record: RunRecord; attempts: number; flaky: boolean };
  try {
    real = await runRealWithRetry(spec, rowDir, { offline, mutantTreesDir });
  } catch (err) {
    return {
      ...base,
      verdict: "ERROR",
      flaky: false,
      canary: -1,
      mutants: [],
      failedChecks: [String(err)],
      attempts: 1,
    };
  }

  const mutants: MutantOutcome[] = [];
  if (real.record.pass) {
    for (const ref of spec.mutants) {
      const mutant = MUTANTS.find((m) => m.id === ref.id);
      const mdir = join(rowDir, `mutant-${ref.id}`);
      if (!mutant) {
        mutants.push({
          id: ref.id,
          expected: ref.expected,
          outcome: "ERROR",
          asExpected: false,
          note: "mutant id not in mutants.ts",
          dir: mdir,
          canary: -1,
        });
        continue;
      }
      try {
        rmSync(mdir, { recursive: true, force: true });
        const plan = spec.make();
        const rec = await executeRun(spec.id, plan.setup, plan.run, {
          dir: mdir,
          offline,
          mutant,
          mutantTreesDir,
          canaryExpected: spec.canary,
          expectsFakeRequests: false,
          rowId: spec.id,
          pin: currentPin,
        });
        const red = rec.error || standingBroken(rec.checks) ? null : ref.red(rec.obs);
        // A mutant run whose OWN standing checks (canary self-test, pre-flight, egress,
        // credential scan) failed is not evidence either way: report it as an error, never
        // as RED or DEAD.
        const outcome: MutantOutcome["outcome"] =
          standingBroken(rec.checks) || rec.error ? "ERROR" : red ? "RED" : "DEAD";
        mutants.push({
          id: ref.id,
          expected: ref.expected,
          outcome,
          asExpected:
            (ref.expected === "red" && outcome === "RED") ||
            (ref.expected === "dead" && outcome === "DEAD"),
          note:
            outcome === "RED"
              ? (red ?? "")
              : `${rec.error ? "run error: " : ""}red condition not met; canary=${rec.obs.canary}; failed checks: ${rec.obs.failedChecks.join(" | ") || "none"}`,
          dir: mdir,
          canary: rec.obs.canary,
        });
      } catch (err) {
        mutants.push({
          id: ref.id,
          expected: ref.expected,
          outcome: "ERROR",
          asExpected: false,
          note: String(err),
          dir: mdir,
          canary: -1,
        });
      }
    }
  }

  const failedChecks = real.record.checks
    .filter((c) => !c.ok)
    .map((c) => `${c.name} [${c.detail}]`);
  let verdict: RowOutcome["verdict"];
  if (!real.record.pass) verdict = "FAIL";
  else if (mutants.some((m) => m.outcome === "ERROR")) verdict = "ERROR";
  else if (mutants.some((m) => m.expected === "red" && m.outcome === "DEAD"))
    verdict = "DEAD-MUTANT";
  else if (mutants.some((m) => !m.asExpected)) verdict = "FAIL";
  else verdict = "PASS";
  const outcome: RowOutcome = {
    ...base,
    verdict,
    flaky: real.flaky,
    canary: real.record.obs.canary,
    mutants,
    failedChecks:
      verdict === "FAIL" && real.record.pass
        ? mutants
            .filter((m) => !m.asExpected)
            .map((m) => `mutant ${m.id}: ${m.outcome} (expected ${m.expected}): ${m.note}`)
        : failedChecks,
    attempts: real.attempts,
  };
  writeFileSync(
    join(rowDir, "outcome.json"),
    JSON.stringify(
      {
        pin: currentPin ?? null,
        ...outcome,
        contract: {
          drive: spec.drive,
          steps: spec.steps,
          expectedMain: spec.expectedMain,
          accountsRecords: spec.accountsRecords,
          fakeProperty: spec.fakeProperty,
          transcript: spec.transcript,
          canary: spec.canary,
          mutants: spec.mutants.map((m) => ({ id: m.id, expected: m.expected })),
          mutantNote: spec.mutantNote ?? null,
        },
        checks: real.record.checks,
      },
      null,
      2
    )
  );
  return outcome;
}

function writePin(out: string): Record<string, string> {
  const tree = makeRowRoot();
  try {
    return writePinIn(out, tree);
  } finally {
    rmSync(tree.root, { recursive: true, force: true });
  }
}

function writePinIn(out: string, tree: ReturnType<typeof makeRowRoot>): Record<string, string> {
  const claudePath = run(["which", "claude"], { env: { PATH: process.env.PATH ?? "" } });
  const env = buildEnv({
    tree,
    accountsLog: join(tree.root, "pin-accounts.jsonl"),
    fakeOrigin: "http://127.0.0.1:9",
    canaryOrigin: "http://127.0.0.1:9",
    sinkPort: 9,
    claudePath,
  });
  const pin = pinOf(env, realpathSync(claudePath));
  let generation = "unknown";
  try {
    generation = JSON.parse(readFileSync(CATALOG_FIXTURE, "utf8")).catalogGenerationId ?? "unknown";
  } catch {
    /* keep unknown */
  }
  const full = {
    ...pin,
    catalogGeneration: generation,
    catalogSource: CATALOG_FIXTURE.replace(`${REPO}/`, ""),
    pinnedAt: new Date().toISOString(),
  };
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "pin.json"), JSON.stringify(full, null, 2));
  return full;
}

const pinBlock = (pin: Record<string, string>) =>
  [
    "## Pin (recorded before any row ran)",
    "",
    `- claudish --version: \`${pin.claudishVersion}\``,
    `- bundle \`${pin.bundle?.replace(`${REPO}/`, "")}\` sha256 \`${pin.builtBundleSha256}\``,
    `- launcher \`${pin.launcher?.replace(`${REPO}/`, "")}\` sha256 \`${pin.launcherSha256}\``,
    `- git HEAD \`${pin.gitHead}\`; \`git status --porcelain\`: \`${(pin.gitStatusPorcelain ?? "").replace(/\n/g, " | ") || "(clean)"}\``,
    `- Claude Code: \`${pin.claudeVersion}\` at \`${pin.claudePath}\``,
    `- catalog generation: \`${pin.catalogGeneration}\` (${pin.catalogSource})`,
    `- Bun ${pin.bun}; pinned at ${pin.pinnedAt}`,
    "",
  ].join("\n");

function summaryLine(o: RowOutcome, out: string): string {
  const mutants = o.mutants.length
    ? o.mutants
        .map(
          (m) =>
            `${m.id}=${m.outcome}${m.asExpected ? "" : "!"}${m.expected === "dead" ? "(ctl)" : ""}`
        )
        .join(", ")
    : (o.mutantNote ?? "none");
  const flaky = o.flaky ? " (flaky: attempt 1 failed)" : "";
  return `| ${o.id} | run | ${o.drive} | ${o.verdict}${flaky} | ${o.canary}/${o.expectedCanary} | ${mutants} | \`${o.dir.replace(`${out}/`, "")}\` |`;
}

function writeSummary(out: string, pin: Record<string, string>, outcomes: RowOutcome[]) {
  const lines = [
    "# Rows summary",
    "",
    pinBlock(pin),
    "## Rows",
    "",
    "| Row | Bucket | Drive | Verdict | Canary (got/expected) | Mutant outcome | Evidence |",
    "|---|---|---|---|---|---|---|",
    ...outcomes.map((o) => summaryLine(o, out)),
    "",
    `Counts: ${(["PASS", "FAIL", "DEAD-MUTANT", "ERROR"] as const)
      .map((v) => `${v}=${outcomes.filter((o) => o.verdict === v).length}`)
      .join(" ")} of ${outcomes.length} run row variants.`,
    "",
  ];
  writeFileSync(join(out, "rows-summary.md"), lines.join("\n"));
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (args.includes("--list")) {
    for (const r of ROWS) console.log(`${r.id.padEnd(16)} ${r.drive.padEnd(8)} ${r.title}`);
    process.exit(0);
  }
  const out = resolve(flag("--out") ?? join(sessionDefault(), "validation"));
  const offline = !args.includes("--no-offline");
  const wanted = flag("--row");
  const wantedList = (wanted ?? "").split(",").filter(Boolean);
  const selected = args.includes("--all")
    ? ROWS
    : ROWS.filter((r) => wantedList.includes(r.id) || wantedList.includes(r.row));
  if (selected.length === 0) {
    console.error(
      "usage: run-row.ts --all | --row <id|row> | --list   [--out <dir>] [--no-offline]"
    );
    process.exit(2);
  }
  if (!existsSync(join(REPO, "packages/cli/dist/index.js"))) {
    console.error("packages/cli/dist/index.js is absent: bun run --cwd packages/cli build first");
    process.exit(2);
  }

  const pin = writePin(out);
  currentPin = pin;
  console.log(pinBlock(pin));
  const outcomes: RowOutcome[] = [];
  for (const spec of selected) {
    const started = Date.now();
    const o = await runOneRow(spec, out, offline);
    outcomes.push(o);
    console.log(
      `${o.verdict.padEnd(11)} ${spec.id.padEnd(16)} canary=${o.canary}/${o.expectedCanary} mutants=[${o.mutants.map((m) => `${m.id}:${m.outcome}`).join(", ")}] ${((Date.now() - started) / 1000).toFixed(0)}s`
    );
    for (const f of o.failedChecks) console.log(`    - ${f}`);
    // A partial summary after every row: a crash mid-run keeps what ran.
    if (args.includes("--all") || selected.length > 1) writeSummary(out, pin, outcomes);
  }
  const bad = outcomes.filter((o) => o.verdict !== "PASS").length;
  process.exit(bad === 0 ? 0 : 1);
}

export type { Check, Obs };
