/**
 * S1 — a user hook module loads from outside the claudish build.
 *
 * Architecture §9 measured this once by hand; this is that probe as a test, so
 * it reruns on every toolchain CI uses (the hermetic job, macOS; the
 * `hooks-loading` job, macOS + Linux, on the Bun the release builds with).
 *
 * `loader-probe.ts` is built and run three ways:
 *
 * | target   | how                                   | the route it stands for                         |
 * |----------|---------------------------------------|-------------------------------------------------|
 * | source   | `bun loader-probe.ts`                 | `bun run dev`                                   |
 * | dist     | `bun build --target bun`, then `bun`  | the npm install: `bin/claudish.cjs` runs `bun dist/index.js`; same build flags as `build` |
 * | compiled | `bun build --compile`, then exec      | the release binary magus installs               |
 *
 * Each imports, by absolute path from a temp directory with no `node_modules`:
 * a `.ts` with an `import type` from `claudish/hooks`, a `.ts` with a VALUE
 * import from `claudish/hooks` (resolved by the host's `Bun.plugin` virtual
 * module), and a `.js`. Two controls prove the probe can report failure: a hook
 * importing a missing file fails on every target, and with the plugin skipped
 * the value import fails.
 *
 * macOS note — exit 137 is a signature, not an import failure. A freshly
 * `--compile`d binary is killed with SIGKILL before it runs any code until it is
 * ad-hoc re-signed (`codesign --force -s -`), measured on Bun 1.4.0, macOS arm64.
 * release.yml signs its darwin binaries the same way, so this test re-signs
 * before running and names the cause if a 137 still occurs.
 *
 * Once `hooks/loader.ts` exists (P2) and ships in `dist/index.js` and the
 * binary (P5), the entry here becomes the real loader.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProbeReport, ProbeResult } from "./loader-probe.js";

const ENTRY = join(import.meta.dir, "loader-probe.ts");
const BUN = process.execPath;

/** The externals `packages/cli` `build` passes; the probe imports none of them. */
const BUILD_EXTERNALS = [
  "@opentui/core",
  "@opentui/core-*",
  "@opentui/react",
  "react",
  "react/*",
].flatMap((e) => ["--external", e]);

const HOOK_SOURCES: Record<string, string> = {
  "type-import.ts": [
    'import type { HookDefinition } from "claudish/hooks";',
    'const hook = { id: "type-only" } satisfies HookDefinition;',
    "export default hook;",
  ].join("\n"),
  "value-import.ts": [
    'import { defineHook } from "claudish/hooks";',
    'export default defineHook({ id: "value-import" });',
  ].join("\n"),
  "plain.js": 'export default { id: "plain-js" };',
  // Control: must fail on every target, or the probe cannot report a failure.
  "missing-import.ts": [
    'import { value } from "./does-not-exist.ts";',
    "export default { id: value };",
  ].join("\n"),
};

type TargetName = "source" | "dist" | "compiled";

let workDir = "";
let hookFiles: Record<string, string> = {};
const commands = {} as Record<TargetName, { argv: string[]; noInstallArgv: string[] }>;

function run(argv: string[], cwd: string, env: Record<string, string> = {}) {
  const proc = Bun.spawnSync(argv, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    signalCode: proc.signalCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function mustSucceed(label: string, result: ReturnType<typeof run>): void {
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed (exit ${result.exitCode}):\n${result.stderr}${result.stdout}`);
  }
}

function runProbe(target: TargetName, files: string[], withPlugin = true): ProbeReport {
  const { argv, noInstallArgv } = commands[target];
  const result = run(withPlugin ? argv : noInstallArgv, workDir, {
    S1_HOOK_FILES: JSON.stringify(files),
    ...(withPlugin ? {} : { S1_NO_PLUGIN: "1" }),
  });
  if (result.exitCode === 137 || result.signalCode === "SIGKILL") {
    throw new Error(
      `${target}: killed by SIGKILL (exit 137) before running any code. On macOS this is the ` +
        "code signature of a locally compiled binary, NOT a hook import failure: re-sign with " +
        "`codesign --force -s -` (this test does that; check that codesign ran)."
    );
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `${target}: probe exited ${result.exitCode}:\n${result.stderr}${result.stdout}`
    );
  }
  return JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "") as ProbeReport;
}

function resultFor(report: ProbeReport, name: string): ProbeResult {
  const found = report.results.find((r) => r.file === hookFiles[name]);
  if (!found) throw new Error(`no result for ${name}`);
  return found;
}

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "claudish-s1-"));
  const hooksDir = join(workDir, "hooks");
  mkdirSync(hooksDir);
  hookFiles = {};
  for (const [name, source] of Object.entries(HOOK_SOURCES)) {
    hookFiles[name] = join(hooksDir, name);
    writeFileSync(hookFiles[name]!, `${source}\n`);
  }

  const distDir = join(workDir, "dist");
  mustSucceed(
    "bun build --target bun",
    run([BUN, "build", ENTRY, "--outdir", distDir, "--target", "bun", ...BUILD_EXTERNALS], workDir)
  );

  const binary = join(workDir, "bin", "loader-probe");
  mustSucceed(
    "bun build --compile",
    run([BUN, "build", ENTRY, "--compile", "--outfile", binary], workDir)
  );
  if (process.platform === "darwin") {
    mustSucceed("codesign --force -s -", run(["codesign", "--force", "-s", "-", binary], workDir));
  }

  // `--no-install` only on the control runs: without the plugin, Bun would try
  // to auto-install the bare `claudish` package from npm. The positive runs
  // resolve nothing from npm, so they run exactly as production does.
  commands.source = { argv: [BUN, ENTRY], noInstallArgv: [BUN, "--no-install", ENTRY] };
  const bundle = join(distDir, "loader-probe.js");
  commands.dist = { argv: [BUN, bundle], noInstallArgv: [BUN, "--no-install", bundle] };
  // A compiled binary does not auto-install.
  commands.compiled = { argv: [binary], noInstallArgv: [binary] };
}, 120_000);

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

const TARGETS: TargetName[] = ["source", "dist", "compiled"];

describe("S1: user hook modules load from outside the build", () => {
  for (const target of TARGETS) {
    describe(target, () => {
      it("loads a .ts type-only import, a .ts value import through the host, and a .js", () => {
        const report = runProbe(target, Object.values(hookFiles));
        expect(report.pluginRegistered).toBe(true);

        expect(resultFor(report, "type-import.ts")).toMatchObject({ ok: true, id: "type-only" });
        expect(resultFor(report, "value-import.ts")).toMatchObject({
          ok: true,
          id: "value-import",
          viaHost: true,
        });
        expect(resultFor(report, "plain.js")).toMatchObject({ ok: true, id: "plain-js" });

        const missing = resultFor(report, "missing-import.ts");
        expect(missing.ok).toBe(false);
        expect(missing.error).toContain("does-not-exist");
      }, 30_000);

      it("control: without the plugin the value import fails and the others still load", () => {
        const report = runProbe(target, Object.values(hookFiles), false);
        expect(report.pluginRegistered).toBe(false);

        expect(resultFor(report, "type-import.ts").ok).toBe(true);
        expect(resultFor(report, "plain.js").ok).toBe(true);
        const value = resultFor(report, "value-import.ts");
        expect(value.ok).toBe(false);
        expect(value.error).toContain("claudish");
      }, 30_000);
    });
  }
});
