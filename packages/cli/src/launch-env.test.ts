import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { loadDotenvText } from "./dotenv-allowlist.js";
import {
  CONTROL_VARS,
  NO_ENV_FILE_FLAG,
  bunLoadedCwdEnvFiles,
  dropControlVars,
  isCompiledEntry,
} from "./launch-env.js";

const CLI_ROOT = join(import.meta.dir, "..");
const REPO_ROOT = join(CLI_ROOT, "..", "..");

describe("bunLoadedCwdEnvFiles", () => {
  test("only --no-env-file on Bun's own argv turns the autoload off", () => {
    expect(bunLoadedCwdEnvFiles([], "/x/dist/index.js")).toBe(true);
    expect(bunLoadedCwdEnvFiles([NO_ENV_FILE_FLAG], "/x/dist/index.js")).toBe(false);
    // `--env-file=<x>` loads <x>, which can be a file in the checkout.
    expect(bunLoadedCwdEnvFiles(["--env-file=.env.local"], "/x/dist/index.js")).toBe(true);
  });

  test("a compiled binary, built with --no-compile-autoload-dotenv, loads none", () => {
    expect(bunLoadedCwdEnvFiles([], "/$bunfs/root/claudish")).toBe(false);
    expect(bunLoadedCwdEnvFiles([], "B:\\~BUN\\root\\claudish.exe")).toBe(false);
  });

  test("isCompiledEntry recognises only Bun's embedded file system", () => {
    expect(isCompiledEntry("/$bunfs/root/claudish")).toBe(true);
    expect(isCompiledEntry("B:/~BUN/root/claudish.exe")).toBe(true);
    expect(isCompiledEntry("/usr/lib/node_modules/claudish/dist/index.js")).toBe(false);
    expect(isCompiledEntry("/home/u/$bunfs/index.js")).toBe(false);
  });
});

describe("dropControlVars", () => {
  test("deletes every control variable present and keeps everything else", () => {
    const env: Record<string, string | undefined> = {
      CLAUDISH_CONFIG: "./evil.json",
      CLAUDISH_PANE_CHILD: "1",
      CLAUDISH_HOOK_INBOX: "/x",
      CLAUDISH_MODEL: "grok-4",
      OPENROUTER_API_KEY: "k",
    };
    expect(dropControlVars(env)).toEqual([
      "CLAUDISH_CONFIG",
      "CLAUDISH_PANE_CHILD",
      "CLAUDISH_HOOK_INBOX",
    ]);
    expect(env).toEqual({ CLAUDISH_MODEL: "grok-4", OPENROUTER_API_KEY: "k" });
  });

  test("the control set names the config, the pane markers, the hook inbox and the child binary", () => {
    expect([...CONTROL_VARS].sort()).toEqual([
      "CLAUDISH_BIN",
      "CLAUDISH_CONFIG",
      "CLAUDISH_HOOK_INBOX",
      "CLAUDISH_HOOK_SESSION",
      "CLAUDISH_PANE_CHILD",
      "CLAUDISH_PANE_CWD",
      "CLAUDISH_PANE_ENV",
    ]);
  });
});

describe("loadDotenvText", () => {
  test("sets ordinary keys, never a control variable, and never overwrites", () => {
    const env: Record<string, string | undefined> = { KEEP: "shell" };
    const refused = loadDotenvText(
      env,
      [
        "OPENROUTER_API_KEY=k",
        "KEEP=file",
        "CLAUDISH_CONFIG=./evil.json",
        "CLAUDISH_PANE_CHILD=1",
        'CLAUDISH_PANE_ENV={"CLAUDISH_CONFIG":"./evil.json"}',
        "CLAUDISH_HOOK_INBOX=/tmp/x",
        "CLAUDISH_BIN=./evil.ts",
      ].join("\n")
    );
    expect(env).toEqual({ KEEP: "shell", OPENROUTER_API_KEY: "k" });
    expect(refused).toEqual([
      "CLAUDISH_CONFIG",
      "CLAUDISH_PANE_CHILD",
      "CLAUDISH_PANE_ENV",
      "CLAUDISH_HOOK_INBOX",
      "CLAUDISH_BIN",
    ]);
  });

  test("a control variable already in the real environment is kept and not reported", () => {
    const env: Record<string, string | undefined> = { CLAUDISH_CONFIG: "/mine.json" };
    expect(loadDotenvText(env, "CLAUDISH_CONFIG=./evil.json\n")).toEqual([]);
    expect(env.CLAUDISH_CONFIG).toBe("/mine.json");
  });
});

describe("every claudish launch path turns Bun's env-file autoload off", () => {
  test("the npm launcher starts Bun with --no-env-file before the entry", () => {
    const require = createRequire(import.meta.url);
    const { bunArgv } = require("../bin/claudish.cjs") as {
      bunArgv: (entry: string, argv: string[]) => string[];
    };
    expect(bunArgv("/pkg/dist/index.js", ["--mcp"])).toEqual([
      NO_ENV_FILE_FLAG,
      "/pkg/dist/index.js",
      "--mcp",
    ]);
  });

  test("the entry's shebang (kept in dist/index.js) passes --no-env-file", () => {
    const first = readFileSync(join(import.meta.dir, "index.ts"), "utf-8").split("\n")[0];
    expect(first).toBe(`#!/usr/bin/env -S bun ${NO_ENV_FILE_FLAG}`);
  });

  test("both compiled-binary builds pass --no-compile-autoload-dotenv", () => {
    const pkg = JSON.parse(readFileSync(join(CLI_ROOT, "package.json"), "utf-8"));
    expect(pkg.scripts["build:binary"]).toContain("--compile --no-compile-autoload-dotenv");
    const release = readFileSync(join(REPO_ROOT, ".github", "workflows", "release.yml"), "utf-8");
    const compileLines = release.split("\n").filter((l) => l.includes("--compile"));
    expect(compileLines.length).toBeGreaterThan(0);
    for (const line of compileLines) expect(line).toContain("--no-compile-autoload-dotenv");
  });
});
