/**
 * The hook examples in `docs/advanced/hooks.md` against the real contract.
 *
 * Every ```ts block in the guide that is a whole hook file (it starts with the
 * same `/// <reference …>` line as the file `claudish hooks init` writes) is
 * type-checked under `strict` against the declaration `init` writes, and then
 * loaded with `claudish hooks check`. The guide must also show the init example
 * verbatim, so the template and the documented starter cannot drift apart.
 *
 * The CLI runs with a generated HOME and a `CLAUDISH_CONFIG` override, so the
 * developer's config is never read or written.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_ROOT = join(import.meta.dir, "..");
const ENTRY = join(import.meta.dir, "index.ts");
const DOC = join(CLI_ROOT, "..", "..", "docs", "advanced", "hooks.md");
const REFERENCE = '/// <reference path="./claudish-hooks.d.ts" />';

const root = mkdtempSync(join(tmpdir(), "claudish-hooks-docs-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let seq = 0;
/** A fresh directory with an empty override config, and `hooks init` run into `<dir>/hooks`. */
function initDir(): { target: string; configPath: string } {
  const dir = mkdtempSync(join(root, `s${++seq}-`));
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, "{}");
  const target = join(dir, "hooks");
  expect(cli(["init", target], configPath).code).toBe(0);
  return { target, configPath };
}

function cli(args: string[], configPath: string) {
  const proc = Bun.spawnSync(["bun", "--no-env-file", ENTRY, "hooks", ...args], {
    cwd: CLI_ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: join(root, "home"),
      CLAUDISH_CONFIG: configPath,
      CLAUDISH_DISABLE_KEYCHAIN: "1",
      CLAUDISH_DISABLE_OP: "1",
      NO_COLOR: "1",
    },
  });
  return { code: proc.exitCode, stdout: proc.stdout.toString() };
}

/** Every ```ts block of the guide that is a whole hook file. */
function examples(): string[] {
  return [...readFileSync(DOC, "utf8").matchAll(/```ts\n([\s\S]*?)```/g)]
    .map((m) => m[1] ?? "")
    .filter((block) => block.startsWith(REFERENCE));
}

describe("docs/advanced/hooks.md examples", () => {
  it("shows the file `claudish hooks init` writes, verbatim", () => {
    const { target } = initDir();
    expect(examples()).toContain(readFileSync(join(target, "example-hook.ts"), "utf8"));
  });

  it("every whole-file example type-checks against the init declaration and loads", () => {
    const { target, configPath } = initDir();
    const blocks = examples();
    // The init example, the raw example and the two worked examples.
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    const files = blocks.map((block, i) => {
      const name = `doc-example-${i + 1}.ts`;
      writeFileSync(join(target, name), block);
      return name;
    });
    writeFileSync(
      join(target, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          types: [],
        },
        files,
      })
    );
    const tsc = join(CLI_ROOT, "node_modules", ".bin", "tsc");
    const proc = Bun.spawnSync([tsc, "-p", join(target, "tsconfig.json")], {
      env: { ...process.env },
      cwd: target,
    });
    expect(proc.stdout.toString() + proc.stderr.toString()).toBe("");
    expect(proc.exitCode).toBe(0);

    for (const name of files) {
      const r = cli(["check", join(target, name), "--json"], configPath);
      expect({ name, valid: JSON.parse(r.stdout).valid }).toEqual({ name, valid: true });
    }
  });
});
