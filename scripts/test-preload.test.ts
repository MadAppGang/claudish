import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { SESSION_ENV_VARS } from "./session-env-vars.ts";
import { scanSource } from "./spawn-env-scan.ts";

const repoRoot = resolve(import.meta.dir, "..");
const cliRoot = resolve(repoRoot, "packages/cli");
const capturePath = resolve(cliRoot, "src/handlers/shared/upstream-error-capture.ts");
const sessionVarsPath = resolve(import.meta.dir, "session-env-vars.ts");
const guardPath = resolve(import.meta.dir, "guard-real-config.ts");

function isolatedEnv(home: string): Record<string, string> {
  const sessionDir = resolve(home, ".claudish/sessions/w3-test-session");
  return {
    HOME: home,
    PATH: process.env.PATH ?? "",
    CLAUDISH_DISABLE_KEYCHAIN: "1",
    CLAUDISH_DISABLE_OP: "1",
    CLAUDISH_DISABLE_CATALOG_WARM: "1",
    ...Object.fromEntries(SESSION_ENV_VARS.map((name) => [name, "w3-test-session"])),
    CLAUDISH_UPSTREAM_ERROR_LOG: resolve(sessionDir, "upstream-errors.jsonl"),
    CLAUDISH_HOOK_INBOX: resolve(sessionDir, "hook-inbox.jsonl"),
    CLAUDISH_TOKEN_FILE: resolve(sessionDir, "tokens.json"),
    CLAUDISH_PUBLISHED_TOKEN_FILE: resolve(sessionDir, "tokens.json"),
    CLAUDISH_PANE_CHILD: "1",
    W3_KEEP_UNRELATED: "keep",
  };
}

function withHome(check: (home: string) => void): void {
  const home = mkdtempSync(resolve(tmpdir(), "w3-session-env-"));
  try {
    mkdirSync(resolve(home, ".claudish/sessions/w3-test-session"), { recursive: true });
    check(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function expectCleanExit(child: ReturnType<typeof Bun.spawnSync>): void {
  expect({
    exitCode: child.exitCode,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
  }).toEqual({ exitCode: 0, stdout: "", stderr: "" });
}

describe("R5 session environment isolation", () => {
  test("5.1 session-variable set matches the production constants without import side effects", () => {
    withHome((home) => {
      const child = Bun.spawnSync(
        [
          process.execPath,
          "--eval",
          `
        import assert from "node:assert/strict";
        const names = ${JSON.stringify(SESSION_ENV_VARS)};
        const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
        const { SESSION_ENV_VARS } = await import(${JSON.stringify(sessionVarsPath)});
        for (const name of names) {
          assert.equal(process.env[name], before[name], "import scrubbed " + name);
        }
        const { UPSTREAM_ERROR_LOG_ENV } = await import(${JSON.stringify(capturePath)});
        const { HOOK_INBOX_ENV } = await import(
          ${JSON.stringify(resolve(cliRoot, "src/hooks/injection/sinks.ts"))}
        );
        const { HOOK_SESSION_ENV } = await import(
          ${JSON.stringify(resolve(cliRoot, "src/hooks/request-stage.ts"))}
        );
        const { ENV } = await import(${JSON.stringify(resolve(cliRoot, "src/config.ts"))});
        assert.deepEqual(new Set(SESSION_ENV_VARS), new Set([
          UPSTREAM_ERROR_LOG_ENV, HOOK_INBOX_ENV, HOOK_SESSION_ENV,
          ENV.CLAUDISH_TOKEN_FILE, ENV.CLAUDISH_PUBLISHED_TOKEN_FILE,
          "CLAUDISH_PANE_CHILD",
        ]));
        assert.equal(SESSION_ENV_VARS.length, 6);
      `,
        ],
        {
          cwd: repoRoot,
          env: isolatedEnv(home),
          stdout: "pipe",
          stderr: "pipe",
          timeout: 8_000,
        }
      );
      expectCleanExit(child);
    });
  }, 10_000);

  test("5.2 record-writer control writes only into the isolated parent session", () => {
    withHome((home) => {
      const env = isolatedEnv(home);
      const child = Bun.spawnSync(
        [
          process.execPath,
          "--eval",
          `
        import assert from "node:assert/strict";
        import { captureUpstreamError } from ${JSON.stringify(capturePath)};
        assert.equal(captureUpstreamError({
          provider: "w3-test-provider", model: "w3-test-model",
          status: 400, body: "W3 isolation check", at: "2026-10-22T00:00:00.000Z",
        }), true);
      `,
        ],
        {
          cwd: cliRoot,
          env: { ...env, HOME: home },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 8_000,
        }
      );
      expectCleanExit(child);
      const records = readFileSync(env.CLAUDISH_UPSTREAM_ERROR_LOG, "utf8").trim().split("\n");
      expect(records).toHaveLength(1);
      expect(JSON.parse(records[0]).provider).toBe("w3-test-provider");
    });
  }, 10_000);

  for (const [label, cwd] of [
    ["packages/cli", cliRoot],
    ["repo root", repoRoot],
    ["packages/macos-bridge", resolve(repoRoot, "packages/macos-bridge")],
  ]) {
    test(`5.2/5.3 preload scrubs the inherited session before tests from ${label}`, () => {
      withHome((home) => {
        const env = isolatedEnv(home);
        // Outside the tree and without a .test. name: only this explicit run discovers it.
        const checkPath = resolve(home, "preload-check.ts");
        writeFileSync(
          checkPath,
          `
          import { test, expect } from "bun:test";
          import { existsSync } from "node:fs";
          import { captureUpstreamError } from ${JSON.stringify(capturePath)};
          import { SESSION_ENV_VARS } from ${JSON.stringify(sessionVarsPath)};
          test("inherited identity is absent before the record writer runs", () => {
            const wrote = captureUpstreamError({
              provider: "w3-test-provider", model: "w3-test-model",
              status: 400, body: "W3 isolation check", at: "2026-10-22T00:00:00.000Z",
            });
            expect(wrote).toBe(false);
            for (const name of SESSION_ENV_VARS) {
              expect({ name, value: process.env[name] }).toEqual({ name, value: undefined });
            }
            expect(process.env.W3_KEEP_UNRELATED).toBe("keep");
            expect(existsSync(${JSON.stringify(env.CLAUDISH_UPSTREAM_ERROR_LOG)})).toBe(false);
          }, 1_000);
        `
        );
        const child = Bun.spawnSync([process.execPath, "test", checkPath], {
          cwd,
          env: { ...env, HOME: home },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 8_000,
        });
        const output = child.stdout.toString() + child.stderr.toString();
        expect({ exitCode: child.exitCode, output }).toEqual({
          exitCode: 0,
          output: expect.stringContaining("1 pass"),
        });
        expect(output).toContain("0 fail");
        expect(existsSync(env.CLAUDISH_UPSTREAM_ERROR_LOG)).toBe(false);
      });
    }, 10_000);
  }

  test("5.4 guard strips all six identities from its spawned non-test process", () => {
    withHome((home) => {
      const env = isolatedEnv(home);
      const child = Bun.spawnSync([process.execPath, "run", guardPath, "--", "/usr/bin/env"], {
        cwd: repoRoot,
        env: { ...env, HOME: home },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 8_000,
      });
      const output = child.stdout.toString();
      expect({ exitCode: child.exitCode, stderr: child.stderr.toString() }).toEqual({
        exitCode: 0,
        stderr: "",
      });
      const entries = output
        .trim()
        .split("\n")
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        });
      const actual = Object.fromEntries(entries);
      expect(actual.HOME).toBe(home);
      expect(actual.W3_KEEP_UNRELATED).toBe("keep");
      for (const name of SESSION_ENV_VARS) expect(actual[name]).toBeUndefined();
      expect(existsSync(env.CLAUDISH_UPSTREAM_ERROR_LOG)).toBe(false);
    });
  }, 10_000);
});

describe("R5 static spawn-env rule", () => {
  test("5.5 reports each Bun or child_process spawn missing env despite a nearby env", () => {
    const file = "scripts/w3-spawn-sample.test.ts";
    const sample = [
      'import { spawn as childSpawn, spawnSync as childSpawnSync } from "node:child_process";',
      'import * as cp from "node:child_process";',
      "const unrelated = { env: {} };",
      'Bun.spawn(["bun"], { env: { HOME: "/isolated" } });',
      'Bun.spawn(["bun"], { stdout: "pipe" });',
      'Bun.spawnSync(["bun"]);',
      'childSpawn("bun", [], { stdio: "pipe" });',
      'childSpawnSync("bun", []);',
      'cp.spawn("bun", [], { env: { HOME: "/isolated" } });',
      'cp.spawnSync("bun", [], { stdio: "pipe" });',
    ].join("\n");
    const violations = scanSource(file, sample);
    expect(violations.map(({ file, line, family }) => ({ file, line, family }))).toEqual([
      { file, line: 5, family: "Bun" },
      { file, line: 6, family: "Bun" },
      { file, line: 7, family: "child_process" },
      { file, line: 8, family: "child_process" },
      { file, line: 10, family: "child_process" },
    ]);
    expect(scanSource(file, 'Bun.spawn(["bun"], { env: { HOME: "/isolated" } });')).toEqual([]);
  }, 1_000);
});
