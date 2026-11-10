import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelPinnedHonoured } from "./child-env.js";

test("REQ-106 RB-27: the CLI logs that --model-pinned is ignored outside a pane child", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "pin-flag-log-")));
  const entry = new URL("../index.ts", import.meta.url).href;
  const logger = new URL("../logger.ts", import.meta.url).href;
  const script = `
    import { writeFileSync } from "node:fs";
    import { join } from "node:path";
    const logger = await import(${JSON.stringify(logger)});
    process.on("exit", () => writeFileSync(join(process.env.HOME, "log-paths.json"),
      JSON.stringify([logger.getLogFilePath(), logger.getAlwaysOnLogPath()])));
    globalThis.fetch = async () => { throw new TypeError("network disabled by pin diagnostic test"); };
    process.argv = [process.execPath, new URL(${JSON.stringify(entry)}).pathname,
      "--model", "openai@pin-diagnostic-model", "--model-pinned",
      "--models-skip-update", "--debug", "-p", "Reply"];
    await import(${JSON.stringify(entry)});
  `;
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
      cwd: home,
      env: {
        HOME: home,
        PATH: process.env.PATH ?? "",
        TMPDIR: tmpdir(),
        CLAUDE_CONFIG_DIR: join(home, "claude"),
        ZDOTDIR: home,
        XDG_CONFIG_HOME: home,
        CLAUDISH_DISABLE_KEYCHAIN: "1",
        CLAUDISH_DISABLE_OP: "1",
        CLAUDISH_DISABLE_CATALOG_WARM: "1",
        CLAUDISH_DISABLE_BUNDLED_LIST: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    timer = setTimeout(() => child?.kill(), 15_000);
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exit, stdout + stderr).not.toBeNull();
    const paths = JSON.parse(readFileSync(join(home, "log-paths.json"), "utf8")) as Array<
      string | null
    >;
    const logs = paths
      .filter((path): path is string => path !== null)
      .map((path) => {
        expect(path.startsWith(home + "/")).toBe(true);
        return readFileSync(path, "utf8");
      })
      .join("\n");
    expect(logs).toMatch(
      /--model-pinned[^\n]*(?:ignor|dropp)|(?:ignor|dropp)[^\n]*--model-pinned/i
    );
  } finally {
    clearTimeout(timer);
    if (child?.exitCode === null) child.kill();
    await child?.exited;
    rmSync(home, { recursive: true, force: true });
  }
}, 20_000);

type Env = Record<string, string | undefined>;
const markers: Array<[string, Env, boolean]> = [
  ["both pane markers", { CLAUDISH_PANE_CHILD: "1", CLAUDISH_PANE_CWD: "/test/work" }, true],
  ["neither pane marker", {}, false],
  ["only the child marker", { CLAUDISH_PANE_CHILD: "1" }, false],
  ["only the working-directory marker", { CLAUDISH_PANE_CWD: "/test/work" }, false],
  ["an empty working directory", { CLAUDISH_PANE_CHILD: "1", CLAUDISH_PANE_CWD: "" }, false],
  ["an empty child marker", { CLAUDISH_PANE_CHILD: "", CLAUDISH_PANE_CWD: "/test/work" }, false],
  [
    "a non-exact child marker",
    { CLAUDISH_PANE_CHILD: "true", CLAUDISH_PANE_CWD: "/test/work" },
    false,
  ],
  ["a disabled child marker", { CLAUDISH_PANE_CHILD: "0", CLAUDISH_PANE_CWD: "/test/work" }, false],
];

describe("REQ-106 RB-27: only a pane child may honor a parent model pin", () => {
  for (const [label, env, paneChild] of markers) {
    for (const flag of [true, false, undefined]) {
      test(`REQ-106: flag=${String(flag)} with ${label} returns ${flag === true && paneChild}`, () => {
        const before = { ...env };
        expect(modelPinnedHonoured(flag, env)).toBe(flag === true && paneChild);
        expect(env).toEqual(before);
      });
    }
  }
});
