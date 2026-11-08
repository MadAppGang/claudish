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
 * the child environment is a whitelist and every token is fake. The one exception is
 * V2e (`--row V2e` only, never `--all`): it stores ONE fake item in the user's default
 * keychain through the product's own writer and deletes it at the end (keychain-guard.ts).
 *
 *   bun ai-docs/benches/account-pool-validation/run-row.ts --row V2e [--v2e-no-sandbox --v2e-no-sandbox-reason <why>]
 *   bun ai-docs/benches/account-pool-validation/run-row.ts --recover-keychain
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Check } from "./agree.ts";
import {
  formatShapeFinding,
  redactCredentialShapes,
  redactCredentialShapesDeep,
  writeScanned,
} from "./cred-shape-scan.ts";
import { standingBroken } from "./e20-gate.ts";
import { type Obs, type RunRecord, executeRun } from "./harness.ts";
import { RECOVERY_FILE, makeSecurityRunner, recoverKeychain } from "./keychain-guard.ts";
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
  /** Set when a row ran without the offline sandbox on purpose: the recorded reason. */
  sandboxFallbackReason?: string;
}

/** A row that cannot prove anything (precondition, refusal, restore failure) sets this note. */
export const harnessErrorOf = (notes: Record<string, unknown>): string | null =>
  typeof notes.harnessError === "string" ? notes.harnessError : null;

/**
 * The offline sandbox for one row. A `keychain` row (V2e) may run without it only when the
 * caller passes `--v2e-no-sandbox` AND a non-empty `--v2e-no-sandbox-reason`: the fallback is
 * recorded in the row's outcome. The egress sink and the canary stay on either way.
 */
export function offlineFor(
  spec: { keychain?: boolean },
  offline: boolean,
  flags: { noSandbox: boolean; reason?: string }
): { offline: boolean; reason?: string } | { error: string } {
  if (!spec.keychain || !flags.noSandbox) return { offline };
  if (!flags.reason?.trim())
    return { error: "--v2e-no-sandbox needs --v2e-no-sandbox-reason <why the sandbox failed>" };
  return { offline: false, reason: flags.reason.trim() };
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
  // A refusal or a failed precondition is not a flake: no second attempt.
  if (harnessErrorOf(record.obs.notes)) return { record, attempts: 1, flaky: false };
  // Re-run once to rule out a flake; keep the first attempt's evidence.
  const firstDir = `${rowDir}-attempt1`;
  rmSync(firstDir, { recursive: true, force: true });
  await Bun.$`mv ${rowDir} ${firstDir}`.quiet();
  record = await attempt(rowDir);
  return { record, attempts: 2, flaky: record.pass };
}

export async function runOneRow(
  spec: RowSpec,
  out: string,
  offline: boolean,
  sandboxFallbackReason?: string
): Promise<RowOutcome> {
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
    ...(sandboxFallbackReason ? { sandboxFallbackReason } : {}),
  };
  const outcomePath = join(rowDir, "outcome.json");
  let real: { record: RunRecord; attempts: number; flaky: boolean };
  try {
    real = await runRealWithRetry(spec, rowDir, { offline, mutantTreesDir });
  } catch (err) {
    return errorOutcome(outcomePath, base, -1, String(err), 1);
  }

  const realHarnessError = harnessErrorOf(real.record.obs.notes);
  if (realHarnessError)
    return errorOutcome(outcomePath, base, real.record.obs.canary, realHarnessError, real.attempts);

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
        const red =
          rec.error || standingBroken(rec.checks) || harnessErrorOf(rec.obs.notes)
            ? null
            : ref.red(rec.obs);
        // A mutant run whose OWN standing checks (canary self-test, pre-flight, egress,
        // credential scan) failed is not evidence either way: report it as an error, never
        // as RED or DEAD.
        const mutantHarnessError = harnessErrorOf(rec.obs.notes);
        const outcome: MutantOutcome["outcome"] =
          standingBroken(rec.checks) || rec.error || mutantHarnessError
            ? "ERROR"
            : red
              ? "RED"
              : "DEAD";
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
              : `${mutantHarnessError ? `harness error: ${mutantHarnessError}; ` : ""}${rec.error ? "run error: " : ""}red condition not met; canary=${rec.obs.canary}; failed checks: ${rec.obs.failedChecks.join(" | ") || "none"}`,
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
  return writeOutcomeScanned(outcomePath, outcome, (o) =>
    JSON.stringify(
      {
        pin: currentPin ?? null,
        ...o,
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
}

/**
 * A row that ended in ERROR before its mutants ran (the run threw, or set a harness error).
 * Its message is product or run text, so it goes through the same sanitizer and file scan as
 * every other outcome (review round 7: this early return used to bypass both).
 */
export function errorOutcome(
  path: string,
  base: Pick<RowOutcome, "id" | "row" | "drive" | "expectedCanary" | "dir"> &
    Partial<Pick<RowOutcome, "mutantNote" | "sandboxFallbackReason">>,
  canary: number,
  message: string,
  attempts: number
): RowOutcome {
  return writeOutcomeScanned(
    path,
    {
      ...base,
      verdict: "ERROR",
      flaky: false,
      canary,
      mutants: [],
      failedChecks: [message],
      attempts,
    },
    (o) => JSON.stringify({ pin: currentPin ?? null, ...o }, null, 2)
  );
}

/**
 * outcome.json is written after every scan of the row: its text is scanned in memory first.
 * A credential-shaped value turns the row into ERROR (named in `failedChecks`, by hash) and is
 * written redacted. Returns the outcome as written: SANITIZED (failed checks, mutant notes),
 * because the caller prints it (review round 7).
 */
export function writeOutcomeScanned(
  path: string,
  outcome: RowOutcome,
  toText: (o: RowOutcome) => string
): RowOutcome {
  const probe = redactCredentialShapes(toText(outcome), [], "outcome.json");
  const safe = redactCredentialShapesDeep(outcome, []).value;
  const final: RowOutcome = probe.findings.length
    ? {
        ...safe,
        verdict: "ERROR",
        failedChecks: [
          ...safe.failedChecks,
          ...probe.findings.map((f) => `credential-shaped string: ${formatShapeFinding(f)}`),
        ],
      }
    : safe;
  writeScanned(path, toText(final), []);
  return final;
}

/** A console line built from a record or outcome: redacted as a final safeguard. */
export const safeLine = (line: string) => redactCredentialShapes(line, []).text;

/** The lines run-row prints for one row, each through {@link safeLine}. */
export function outcomeLines(o: RowOutcome, seconds: number): string[] {
  return [
    `${o.verdict.padEnd(11)} ${o.id.padEnd(16)} canary=${o.canary}/${o.expectedCanary} mutants=[${o.mutants.map((m) => `${m.id}:${m.outcome}`).join(", ")}] ${seconds.toFixed(0)}s`,
    ...o.failedChecks.map((f) => `    - ${f}`),
  ].map(safeLine);
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

/** Written through the in-memory scan; returns its findings (each fails the exit code). */
function writeSummary(out: string, pin: Record<string, string>, outcomes: RowOutcome[]): string[] {
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
  return writeScanned(join(out, "rows-summary.md"), lines.join("\n"), []);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (args.includes("--recover-keychain")) {
    // Deletes the one fake V2e item (claudish-accounts / openai-codex:aaaaaaaaaaaa) left by a
    // crashed run, and its recovery file. One delete-generic-password; nothing else.
    try {
      console.log(await recoverKeychain(makeSecurityRunner()));
      process.exit(0);
    } catch (err) {
      console.error(`recovery failed: ${String(err)}\nrecovery file: ${RECOVERY_FILE}`);
      process.exit(1);
    }
  }
  if (args.includes("--list")) {
    for (const r of ROWS) console.log(`${r.id.padEnd(16)} ${r.drive.padEnd(8)} ${r.title}`);
    process.exit(0);
  }
  const out = resolve(flag("--out") ?? join(sessionDefault(), "validation"));
  const offline = !args.includes("--no-offline");
  const wanted = flag("--row");
  const wantedList = (wanted ?? "").split(",").filter(Boolean);
  // `--all` skips keychain rows (V2e uses the real default keychain): name them with --row.
  const selected = args.includes("--all")
    ? ROWS.filter((r) => !r.keychain)
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
  let summaryFindings: string[] = [];
  for (const spec of selected) {
    const started = Date.now();
    const off = offlineFor(spec, offline, {
      noSandbox: args.includes("--v2e-no-sandbox"),
      reason: flag("--v2e-no-sandbox-reason"),
    });
    if ("error" in off) {
      console.error(off.error);
      process.exit(2);
    }
    const o = await runOneRow(spec, out, off.offline, off.reason);
    outcomes.push(o);
    for (const line of outcomeLines(o, (Date.now() - started) / 1000)) console.log(line);
    // A partial summary after every row: a crash mid-run keeps what ran.
    if (args.includes("--all") || selected.length > 1) {
      summaryFindings = writeSummary(out, pin, outcomes);
      for (const f of summaryFindings) console.error(`rows-summary.md: ${f}`);
    }
  }
  const bad = outcomes.filter((o) => o.verdict !== "PASS").length;
  process.exit(bad === 0 && summaryFindings.length === 0 ? 0 : 1);
}

export type { Check, Obs };
