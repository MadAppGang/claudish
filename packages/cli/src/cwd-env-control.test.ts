/**
 * A repository cannot set claudish's control variables: nothing in a checkout's env
 * files may choose the config file (and so which hook modules are imported) or mark
 * the process as a pane child.
 *
 * Each row spawns the real CLI entry in a scratch checkout with a throwaway HOME,
 * twice: with the exact argv the npm launcher gives Bun (`bunArgv` in
 * `bin/claudish.cjs`), and as a bare `bun <entry>`, where Bun loads the cwd env files
 * before any claudish code runs. The checkout's `evil.ts` writes a marker file when
 * imported, so "the module was never imported" is observed, not inferred.
 *
 * The positive controls show each check can fail: the same config named by the real
 * environment IS imported, and a real pane marker DOES refuse `-p`.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "index.ts");
const BUN = process.execPath;
const require = createRequire(import.meta.url);
const { bunArgv } = require("../bin/claudish.cjs") as {
  bunArgv: (entry: string, argv: string[]) => string[];
};

const root = realpathSync(mkdtempSync(join(tmpdir(), "claudish-cwd-env-")));
const home = join(root, "home");
mkdirSync(home);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const GLOBAL_CONFIG = join(home, ".claudish", "config.json");

type Launch = (args: string[]) => string[];
const LAUNCHES: [string, Launch][] = [
  ["the npm launcher's argv", (args) => [BUN, ...bunArgv(ENTRY, args)]],
  ["a bare `bun <entry>`", (args) => [BUN, ENTRY, ...args]],
];

/** A checkout holding `evil.json`, whose one hook module `evil.ts` marks its import. */
function hostileCheckout(files: Record<string, string>) {
  const repo = mkdtempSync(join(root, "repo-"));
  const marker = join(repo, "IMPORTED");
  writeFileSync(
    join(repo, "evil.ts"),
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "imported");
export default { apiVersion: 1, id: "evil", on: { responseEnd: () => [] } };`
  );
  writeFileSync(join(repo, "evil.json"), JSON.stringify({ hooks: { modules: ["./evil.ts"] } }));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(repo, name), text);
  return { repo, marker };
}

const BASE_ENV = {
  PATH: process.env.PATH ?? "",
  HOME: home,
  CLAUDISH_DISABLE_KEYCHAIN: "1",
  CLAUDISH_DISABLE_OP: "1",
  NO_COLOR: "1",
};

function run(argv: string[], cwd: string, env: Record<string, string> = {}) {
  const proc = Bun.spawnSync(argv, {
    cwd,
    env: { ...BASE_ENV, ...env },
    stdin: "ignore",
  });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function listHooks(launch: Launch, cwd: string, env: Record<string, string> = {}) {
  const r = run(launch(["hooks", "list", "--json"]), cwd, env);
  if (r.code !== 0) throw new Error(`hooks list exited ${r.code}: ${r.stderr}`);
  return { ...r, out: JSON.parse(r.stdout) as { configFile: string; hooks: { id: string }[] } };
}

/** Env files that try to choose the config file, directly or through a pane snapshot. */
const CONFIG_VECTORS: [string, Record<string, string>, Record<string, string>][] = [
  [".env names CLAUDISH_CONFIG", { ".env": "CLAUDISH_CONFIG=./evil.json\n" }, {}],
  [
    ".env.development.local names CLAUDISH_CONFIG",
    { ".env.development.local": "CLAUDISH_CONFIG=./evil.json\n" },
    {},
  ],
  [
    ".env.production.local names CLAUDISH_CONFIG under NODE_ENV=production",
    { ".env.production.local": "CLAUDISH_CONFIG=./evil.json\n" },
    { NODE_ENV: "production" },
  ],
  [
    ".env.test.local names CLAUDISH_CONFIG under NODE_ENV=test",
    { ".env.test.local": "CLAUDISH_CONFIG=./evil.json\n" },
    { NODE_ENV: "test" },
  ],
  [
    "a quoted value Bun and dotenv parse differently",
    { ".env": 'CLAUDISH_CONFIG="./evil.json"x\n' },
    {},
  ],
  [
    "pane markers whose snapshot carries CLAUDISH_CONFIG",
    {
      ".env":
        'CLAUDISH_PANE_CHILD=1\nCLAUDISH_PANE_ENV={"CLAUDISH_CONFIG":"./evil.json","PATH":"$PATH","HOME":"$HOME"}\n',
    },
    {},
  ],
];

describe("a checkout's env files cannot choose the config hooks load from", () => {
  for (const [launchName, launch] of LAUNCHES) {
    describe(launchName, () => {
      it.each(CONFIG_VECTORS)("%s: the module is never imported", (_name, files, env) => {
        const { repo, marker } = hostileCheckout(files);
        const r = listHooks(launch, repo, env);
        expect(existsSync(marker)).toBe(false);
        expect(r.out.configFile).toBe(GLOBAL_CONFIG);
        expect(r.out.hooks.map((h) => h.id)).not.toContain("hook:evil/evil");
      });
    });
  }

  for (const [launchName, launch] of LAUNCHES) {
    it(`${launchName}: one stderr line names the variable it ignored`, () => {
      const { repo } = hostileCheckout({ ".env": "CLAUDISH_CONFIG=./evil.json\n" });
      const r = listHooks(launch, repo);
      expect(r.stderr.match(/ignoring CLAUDISH_CONFIG/g)?.length).toBe(1);
    });
  }

  it("control: the same config named by the real environment is imported", () => {
    const { repo, marker } = hostileCheckout({});
    const launch = LAUNCHES[0][1];
    const r = listHooks(launch, repo, { CLAUDISH_CONFIG: join(repo, "evil.json") });
    expect(existsSync(marker)).toBe(true);
    expect(r.out.hooks.map((h) => h.id)).toContain("hook:evil/evil");
  });
});

describe("a checkout's env files cannot mark the process as a pane child", () => {
  // `-p` is refused with exit 64 in a pane child, and as a nested launch under the
  // flag alone; anywhere else this run fails fast with exit 1 on the missing
  // OpenRouter key.
  const PRINT = ["-p", "hi", "--model", "openrouter@x/y"];

  for (const [launchName, launch] of LAUNCHES) {
    it(`${launchName}: CLAUDISH_PANE_CHILD=1 in .env does not refuse -p`, () => {
      const { repo } = hostileCheckout({ ".env": "CLAUDISH_PANE_CHILD=1\n" });
      const r = run(launch(PRINT), repo);
      expect(r.stderr).not.toContain("pane child refused");
      expect(r.stderr).not.toContain("nested session refused");
      expect(r.code).toBe(1);
    });
  }

  it("control: the marker in the real environment refuses -p with exit 64", () => {
    const { repo } = hostileCheckout({});
    // A pane child is the flag AND a pane cwd; the flag alone is a nested launch.
    const r = run(LAUNCHES[0][1](PRINT), repo, {
      CLAUDISH_PANE_CHILD: "1",
      CLAUDISH_PANE_CWD: repo,
    });
    expect(r.stderr).toContain("pane child refused");
    expect(r.code).toBe(64);
  });
});

describe("a pane child keeps the config its parent passed", () => {
  it("the snapshot's CLAUDISH_CONFIG wins over an expanded .env assignment in the checkout", () => {
    const { repo, marker } = hostileCheckout({ ".env": "CLAUDISH_CONFIG=$PWD/evil.json\n" });
    const trusted = join(repo, "..", `trusted-${Date.now()}.json`);
    writeFileSync(trusted, JSON.stringify({}));
    // What buildPaneEnv hands a child of a parent started with `--config <trusted>`.
    const snapshot = { ...BASE_ENV, CLAUDISH_CONFIG: trusted, CLAUDISH_PANE_CHILD: "1" };
    const r = listHooks(LAUNCHES[0][1], repo, {
      CLAUDISH_PANE_CHILD: "1",
      CLAUDISH_PANE_CWD: repo,
      CLAUDISH_PANE_ENV: JSON.stringify(snapshot),
    });
    expect(r.stderr).not.toContain("ignoring CLAUDISH_CONFIG");
    expect(r.out.configFile).toBe(trusted);
    expect(existsSync(marker)).toBe(false);
  });
});
