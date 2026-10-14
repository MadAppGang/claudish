/**
 * #445 option (b) — pins for `scripts/verify-decision-refs.py`.
 *
 * The script is the mechanical half of reviewing the condensed decision
 * layer (CLAUDE.md, worker SKILL): every backticked token must resolve in
 * code, in the doc's own pointer targets, or be adjudicated external. These
 * pins exist so the verifier cannot silently degrade into certify-everything:
 *
 *  1. Selftest (embedded fixture): two real references pass, two DELIBERATELY
 *     FALSE ones go red. A verifier that cannot go red certifies nothing.
 *  2. End-to-end: a hand-written doc with one true + one false token exits 1
 *     and names exactly the false token.
 *
 * The run over the real CLAUDE.md is deliberately NOT gated here: known-stale
 * entries (an OpenRouter vendor-map knob documented in three files, present
 * in no source) are findings to adjudicate, not CI failures.
 *
 * NB: the false tokens below are built by string concatenation ON PURPOSE --
 * this file is part of the script's code corpus, so a quoted false token
 * would verify itself through the very test that asserts its redness.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// packages/cli/src/test-support -> repo root is four levels up.
const REPO = join(here, "..", "..", "..", "..");
const SCRIPT = join(REPO, "scripts", "verify-decision-refs.py");

const FALSE_TOKEN = ["resolveEverything", "Magically"].join("");
const REAL_TOKEN = ["withFirstUsefulEvent", "Watchdog"].join("");

let cachedBin: string | null = null;

function findPython(): string {
  if (cachedBin) return cachedBin;
  const candidates = [process.env.DECISION_REFS_PYTHON, "python3", "python"].filter(Boolean);
  let lastError: unknown = null;
  for (const bin of candidates as string[]) {
    // Probe explicitly: a missing binary and a broken alias must both be
    // skipped deterministically, not distinguished by later output parsing.
    const probe = spawnSync(bin, ["-c", "print(1)"], { encoding: "utf8" });
    if (!probe.error && probe.status === 0 && (probe.stdout ?? "").trim() === "1") {
      cachedBin = bin;
      return bin;
    }
    lastError = probe.error ?? `probe status ${probe.status}`;
  }
  throw new Error(`no python interpreter for decision-refs test: ${lastError}`);
}

function runScript(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(findPython(), ["-I", SCRIPT, ...args], { encoding: "utf8", cwd: REPO });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("verify-decision-refs.py (#445 option b)", () => {
  const fixtureRel = join(".tmp", "decision-refs-fixture.md");

  afterAll(() => {
    rmSync(join(REPO, fixtureRel), { force: true });
  });

  it("selftest: the deliberately false pair goes red, the real pair passes", () => {
    const { status, stdout } = runScript(["--selftest"]);
    expect(stdout).toContain("SELFTEST PASS");
    expect(status).toBe(0);
  }, 30000);

  it("end-to-end: a doc with one true and one false token exits 1 naming only the false one", () => {
    mkdirSync(join(REPO, ".tmp"), { recursive: true });
    writeFileSync(
      join(REPO, fixtureRel),
      `## Fixture\n\n- Real symbol \`${REAL_TOKEN}\`.\n` +
        `- False symbol \`${FALSE_TOKEN}\`.\n`,
      "utf8"
    );
    const { status, stdout } = runScript([fixtureRel]);
    expect(status).toBe(1);
    const unverifiedLines = stdout.split(/\r?\n/).filter((l) => l.startsWith("UNVERIFIED"));
    expect(unverifiedLines.length).toBe(1);
    expect(unverifiedLines[0]).toContain(FALSE_TOKEN);
    expect(stdout).not.toContain(`${REAL_TOKEN}\``);
  }, 30000);
});
