/**
 * publish-npm-package.ts passes exactly two npm outcomes: a publish that succeeded, and npm's
 * "cannot publish over the previously published versions" (a rerun of the release job). Every
 * other failure fails the release step. A provenance error such as TLOG_CREATE_ENTRY_ERROR once
 * left a platform package unpublished while the job stayed green.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "publish-npm-package.ts");
const scratch = mkdtempSync(join(tmpdir(), "publish-npm-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Runs the script against a stand-in `npm` that prints `out` to stderr and exits `code`. */
function publishWith(out: string, code: number) {
  const bin = mkdtempSync(join(scratch, "bin-"));
  const pkg = mkdtempSync(join(scratch, "pkg-"));
  const args = join(bin, "args");
  writeFileSync(
    join(bin, "npm"),
    `#!/bin/sh\necho "$PWD $*" > "${args}"\nprintf '%s\\n' ${JSON.stringify(out)} >&2\nexit ${code}\n`,
    { mode: 0o755 }
  );
  mkdirSync(pkg, { recursive: true });
  const r = Bun.spawnSync([process.execPath, "--no-env-file", SCRIPT, pkg], {
    env: { PATH: `${bin}:/usr/bin:/bin` },
  });
  return { status: r.exitCode, args: readFileSync(args, "utf8").trim(), pkg };
}

describe("publish-npm-package", () => {
  test("a successful publish passes, run in the package dir with provenance", () => {
    const r = publishWith("+ @claudish/magmux-darwin-arm64@1.2.3", 0);
    expect(r.status).toBe(0);
    // the stand-in reports $PWD, the real path (/var is a link to /private/var on macOS)
    expect(r.args).toBe(`${realpathSync(r.pkg)} publish --access public --provenance`);
  });

  test("a version already published passes (a rerun of the release job)", () => {
    const r = publishWith(
      "npm error You cannot publish over the previously published versions: 1.2.3.",
      1
    );
    expect(r.status).toBe(0);
  });

  test("a provenance error fails the step", () => {
    const r = publishWith(
      "npm error code TLOG_CREATE_ENTRY_ERROR\nnpm error error creating tlog entry - (409) an equivalent entry already exists in the transparency log",
      1
    );
    expect(r.status).toBe(1);
  });

  test("a staged version fails the step", () => {
    const r = publishWith(
      'npm error 409 Conflict - Cannot publish over previously staged version "1.2.3".',
      1
    );
    expect(r.status).toBe(1);
  });
});

describe("release.yml", () => {
  const yml = readFileSync(join(import.meta.dir, "..", ".github/workflows/release.yml"), "utf8");

  test("no npm publish failure is turned into a pass", () => {
    expect(yml).not.toMatch(/npm publish[^\n]*\|\|/);
  });

  test("every npm publish goes through publish-npm-package.ts", () => {
    expect(yml).not.toMatch(/npm publish --/);
    expect((yml.match(/scripts\/publish-npm-package\.ts/g) ?? []).length).toBe(2);
  });
});
