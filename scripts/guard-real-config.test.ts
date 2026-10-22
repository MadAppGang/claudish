import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GUARD_SCRIPT = join(import.meta.dir, "guard-real-config.ts");
const decoder = new TextDecoder();

interface ScratchHome {
  home: string;
  claudishDir: string;
  configPath: string;
}

function withScratchHome(run: (fixture: ScratchHome) => void): void {
  const home = mkdtempSync(join(tmpdir(), "claudish-guard-test-"));
  const claudishDir = join(home, ".claudish");
  mkdirSync(claudishDir);
  try {
    run({ home, claudishDir, configPath: join(claudishDir, "config.json") });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function runGuard(
  fixture: ScratchHome,
  commandSource: string,
  script = GUARD_SCRIPT
): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(
    [process.execPath, "run", script, "--", process.execPath, "-e", commandSource],
    {
      env: {
        ...process.env,
        HOME: fixture.home,
        GUARD_TEST_CLAUDISH_DIR: fixture.claudishDir,
        GUARD_TEST_CONFIG_PATH: fixture.configPath,
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
}

function stderrOf(result: ReturnType<typeof Bun.spawnSync>): string {
  return decoder.decode(result.stderr);
}

// Local guard input, not a provider response or a real credential.
const originalSecret = JSON.stringify({
  refresh_token: "TEST_REFRESH_BEFORE",
  access_token: "TEST_ACCESS_BEFORE",
  claudish_generation: 5,
});

function seedSecret(fixture: ScratchHome, relativePath = "codex-oauth.json", mode = 0o600): string {
  const path = join(fixture.claudishDir, relativePath);
  mkdirSync(join(fixture.claudishDir, "accounts"), { recursive: true });
  writeFileSync(path, originalSecret, { mode });
  chmodSync(path, mode);
  return path;
}

function expectNoSecretCopies(path: string): void {
  expect(existsSync(`${path}.guard-backup`)).toBe(false);
  expect(existsSync(`${path}.guard-created`)).toBe(false);
  expect(readdirSync(join(path, "..")).filter((name) => name.includes(".guard-restore-"))).toEqual(
    []
  );
}

function patchedGuard(fixture: ScratchHome, before: string, after: string): string {
  const source = readFileSync(GUARD_SCRIPT, "utf8");
  expect(source.split(before)).toHaveLength(2);
  const path = join(fixture.home, "guard-copy.ts");
  writeFileSync(path, source.replace(before, after));
  return path;
}

describe("guard-real-config", () => {
  test("moves a file created during the command to .guard-created and exits 1", () => {
    withScratchHome((fixture) => {
      const createdContent = '{"createdBy":"guard-test"}\n';
      const result = runGuard(
        fixture,
        `import { writeFileSync } from "node:fs"; writeFileSync(process.env.GUARD_TEST_CONFIG_PATH!, ${JSON.stringify(createdContent)}, "utf8");`
      );

      const movedPath = `${fixture.configPath}.guard-created`;
      expect(result.exitCode).toBe(1);
      expect(existsSync(fixture.configPath)).toBe(false);
      expect(readFileSync(movedPath, "utf8")).toBe(createdContent);
      expect(stderrOf(result)).toContain("moved aside");
    });
  });

  test("restores a modified existing file byte-exactly and exits 1", () => {
    withScratchHome((fixture) => {
      const originalContent = '{\n  "token": "original",\n  "spacing": true\n}\n';
      writeFileSync(fixture.configPath, originalContent, "utf8");

      const result = runGuard(
        fixture,
        'import { writeFileSync } from "node:fs"; writeFileSync(process.env.GUARD_TEST_CONFIG_PATH!, "changed", "utf8");'
      );

      expect(result.exitCode).toBe(1);
      expect(readFileSync(fixture.configPath, "utf8")).toBe(originalContent);
      expect(stderrOf(result)).toContain("Restored it from the pre-run snapshot.");
    });
  });

  for (const relativePath of [
    "codex-oauth.json",
    "grok-oauth.json",
    "gemini-oauth.json",
    "kimi-oauth.json",
    "accounts/state.json",
  ]) {
    test(`restores deleted ${relativePath} with mode 0600 and no plaintext sidecar`, () => {
      withScratchHome((fixture) => {
        mkdirSync(join(fixture.claudishDir, "accounts"));
        const path = join(fixture.claudishDir, relativePath);
        const original = '{\n  "testCredential": "TEST_ONLY"\n}\n';
        writeFileSync(path, original, { mode: 0o644 });
        const result = runGuard(
          fixture,
          `import { existsSync, unlinkSync } from "node:fs";
           const path = ${JSON.stringify(path)};
           if (existsSync(path + ".guard-backup")) throw new Error("plaintext credential sidecar");
           unlinkSync(path);`
        );

        expect(result.exitCode).toBe(1);
        expect(existsSync(path)).toBe(true);
        expect(readFileSync(path, "utf8")).toBe(original);
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(existsSync(`${path}.guard-backup`)).toBe(false);
        expect(stderrOf(result)).toContain(path);
        expect(stderrOf(result)).toContain("MUTATED");
        expect(stderrOf(result)).toContain("Restored it from the pre-run snapshot.");
      });
    });
  }

  test("returns the child exit code 0 when no guarded file changes", () => {
    withScratchHome((fixture) => {
      const originalContent = '{"unchanged":true}\n';
      writeFileSync(fixture.configPath, originalContent, "utf8");

      const result = runGuard(fixture, "process.exit(0);");

      expect(result.exitCode).toBe(0);
      expect(readFileSync(fixture.configPath, "utf8")).toBe(originalContent);
      expect(stderrOf(result)).not.toContain("MUTATED");
    });
  });

  for (const mode of [0o600, 0o644]) {
    test(`keeps valid rotated credentials at ${mode.toString(8)} without leaking token values`, () => {
      withScratchHome((fixture) => {
        const path = seedSecret(fixture);
        const rotated = JSON.stringify({
          refresh_token: "TEST_REFRESH_AFTER",
          access_token: "TEST_ACCESS_AFTER",
          claudish_generation: 5,
        });
        const result = runGuard(
          fixture,
          `import { chmodSync, writeFileSync } from "node:fs";
           writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(rotated)});
           chmodSync(${JSON.stringify(path)}, ${mode});`
        );

        expect(result.exitCode).toBe(1);
        expect(readFileSync(path, "utf8")).toBe(rotated);
        expect(statSync(path).mode & 0o777).toBe(0o600);
        const stderr = stderrOf(result);
        expect(stderr).toContain("WARNING — kept");
        expect(stderr).toContain(path);
        expect(stderr).toContain("changed  refresh_token");
        expect(stderr).toContain("changed  access_token");
        for (const value of [
          "TEST_REFRESH_BEFORE",
          "TEST_ACCESS_BEFORE",
          "TEST_REFRESH_AFTER",
          "TEST_ACCESS_AFTER",
        ]) {
          expect(stderr).not.toContain(value);
        }
        expectNoSecretCopies(path);
      });
    });
  }

  test("keeps byte-only credential changes and reports unchanged key names", () => {
    withScratchHome((fixture) => {
      const path = seedSecret(fixture);
      const formatted = JSON.stringify(JSON.parse(originalSecret), null, 2);
      const result = runGuard(
        fixture,
        `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(formatted)});`
      );
      expect(result.exitCode).toBe(1);
      expect(readFileSync(path, "utf8")).toBe(formatted);
      expect(stderrOf(result)).toContain("No top-level key names changed.");
      expectNoSecretCopies(path);
    });
  });

  for (const [name, content] of [
    ["malformed JSON", "{"],
    ["JSON null", "null"],
    ["JSON scalar", "42"],
    ["no refresh token", '{"access_token":"TEST_ACCESS_AFTER"}'],
    ["empty refresh token", '{"refresh_token":""}'],
    ["whitespace refresh token", JSON.stringify({ refresh_token: " \t\n " })],
    ["non-string refresh token", '{"refresh_token":123}'],
  ]) {
    test(`restores ${name} credentials at 0600`, () => {
      withScratchHome((fixture) => {
        const path = seedSecret(fixture);
        const result = runGuard(
          fixture,
          `import { chmodSync, writeFileSync } from "node:fs";
           writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(content)});
           chmodSync(${JSON.stringify(path)}, 0o644);`
        );
        expect(result.exitCode).toBe(1);
        expect(readFileSync(path, "utf8")).toBe(originalSecret);
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(stderrOf(result)).toContain("Restored it from the pre-run snapshot.");
        expectNoSecretCopies(path);
      });
    });
  }

  test("restores unreadable credentials at 0600", () => {
    withScratchHome((fixture) => {
      const path = seedSecret(fixture);
      const result = runGuard(
        fixture,
        `import { chmodSync, writeFileSync } from "node:fs";
         writeFileSync(${JSON.stringify(path)}, "damaged");
         chmodSync(${JSON.stringify(path)}, 0);`
      );
      expect(result.exitCode).toBe(1);
      expect(readFileSync(path, "utf8")).toBe(originalSecret);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expectNoSecretCopies(path);
    });
  });

  for (const content of ['{"lastAccount":"TEST_ACCOUNT"}', "null"]) {
    test(`keeps parseable account state ${content} without a refresh token`, () => {
      withScratchHome((fixture) => {
        const path = seedSecret(fixture, "accounts/state.json");
        const result = runGuard(
          fixture,
          `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(content)});`
        );
        expect(result.exitCode).toBe(1);
        expect(readFileSync(path, "utf8")).toBe(content);
        expect(stderrOf(result)).toContain("WARNING — kept");
        expectNoSecretCopies(path);
      });
    });
  }

  test("restores unparseable account state", () => {
    withScratchHome((fixture) => {
      const path = seedSecret(fixture, "accounts/state.json");
      const result = runGuard(
        fixture,
        `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(path)}, "{");`
      );
      expect(result.exitCode).toBe(1);
      expect(readFileSync(path, "utf8")).toBe(originalSecret);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expectNoSecretCopies(path);
    });
  });

  test("chmods identical bytes recreated at 0644 without restoring bytes", () => {
    withScratchHome((fixture) => {
      const path = seedSecret(fixture);
      const inodePath = join(fixture.home, "recreated-inode");
      const result = runGuard(
        fixture,
        `import { chmodSync, statSync, unlinkSync, writeFileSync } from "node:fs";
         unlinkSync(${JSON.stringify(path)});
         writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(originalSecret)}, { mode: 0o644 });
         chmodSync(${JSON.stringify(path)}, 0o644);
         writeFileSync(${JSON.stringify(inodePath)}, String(statSync(${JSON.stringify(path)}).ino));`
      );
      expect(result.exitCode).toBe(1);
      expect(readFileSync(path, "utf8")).toBe(originalSecret);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(String(statSync(path).ino)).toBe(readFileSync(inodePath, "utf8"));
      expect(stderrOf(result)).toContain("Repaired secret file permissions to 0600.");
      expect(stderrOf(result)).not.toContain("Restored it from the pre-run snapshot.");
      expectNoSecretCopies(path);
    });
  });

  for (const code of [0, 7]) {
    test(`leaves an untouched pre-existing 0644 secret alone and preserves child exit ${code}`, () => {
      withScratchHome((fixture) => {
        const path = seedSecret(fixture, "gemini-oauth.json", 0o644);
        const result = runGuard(fixture, `process.exit(${code});`);
        expect(result.exitCode).toBe(code);
        expect(stderrOf(result)).toBe("");
        expect(readFileSync(path, "utf8")).toBe(originalSecret);
        expect(statSync(path).mode & 0o777).toBe(0o644);
        expectNoSecretCopies(path);
      });
    });
  }

  for (const content of [originalSecret, "{"]) {
    test(`deletes a test-created ${content === originalSecret ? "valid" : "invalid"} secret without a copy`, () => {
      withScratchHome((fixture) => {
        const path = join(fixture.claudishDir, "codex-oauth.json");
        const result = runGuard(
          fixture,
          `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(content)});`
        );
        expect(result.exitCode).toBe(1);
        expect(existsSync(path)).toBe(false);
        expect(stderrOf(result)).toContain(path);
        expect(stderrOf(result)).toContain("Deleted test-created secret");
        expectNoSecretCopies(path);
      });
    });
  }

  test("creates the restore copy at 0600 before writing secret bytes", () => {
    withScratchHome((fixture) => {
      const path = seedSecret(fixture);
      const audit = join(fixture.home, "restore-audit.json");
      const script = patchedGuard(
        fixture,
        '  const fd = openSync(temp, "wx", 0o600);\n  try {\n    try {\n      fchmodSync(fd, 0o600);\n      writeFileSync(fd, content, "utf-8");',
        `  const fd = openSync(temp, "wx", 0o600);\n  const createdMode = statSync(temp).mode & 0o777;\n  try {\n    try {\n      fchmodSync(fd, 0o600);\n      writeFileSync(${JSON.stringify(audit)}, JSON.stringify({ createdMode, mode: statSync(temp).mode & 0o777, path: temp, before: readFileSync(temp, "utf8") }));\n      writeFileSync(fd, content, "utf-8");`
      );
      const result = runGuard(
        fixture,
        `import { chmodSync, writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(path)}, "{"); chmodSync(${JSON.stringify(path)}, 0o644);`,
        script
      );
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(readFileSync(audit, "utf8"))).toMatchObject({
        createdMode: 0o600,
        mode: 0o600,
        before: "",
      });
      expect(JSON.parse(readFileSync(audit, "utf8")).path).toStartWith(`${path}.guard-restore-`);
      expect(readFileSync(path, "utf8")).toBe(originalSecret);
      expectNoSecretCopies(path);
    });
  });

  for (const operation of ["write", "rename"] as const) {
    test(`removes the private restore temp file when ${operation} fails`, () => {
      withScratchHome((fixture) => {
        const path = seedSecret(fixture);
        const script = patchedGuard(
          fixture,
          operation === "write"
            ? '      writeFileSync(fd, content, "utf-8");'
            : "    renameSync(temp, guarded.path);",
          `    throw new Error("injected restore ${operation} failure");`
        );
        const result = runGuard(
          fixture,
          `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(path)}, "{");`,
          script
        );
        expect(result.exitCode).toBe(1);
        expect(stderrOf(result)).toContain("RESTORE FAILED");
        expect(stderrOf(result)).toContain(`injected restore ${operation} failure`);
        expectNoSecretCopies(path);
      });
    });
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    for (const damage of [true, false]) {
      test(`forwards ${signal}, finishes once, and rejects child exit 0 (${damage ? "damaged" : "intact"})`, async () => {
        const home = mkdtempSync(join(tmpdir(), "claudish-guard-signal-"));
        const claudishDir = join(home, ".claudish");
        mkdirSync(claudishDir);
        const fixture = { home, claudishDir, configPath: join(claudishDir, "config.json") };
        const path = seedSecret(fixture);
        const ready = join(home, "ready");
        const received = join(home, "received");
        const childPid = join(home, "child-pid");
        const source = `
          import { unlinkSync, writeFileSync } from "node:fs";
          process.on(${JSON.stringify(signal)}, () => {
            writeFileSync(${JSON.stringify(received)}, ${JSON.stringify(signal)});
            process.exit(0);
          });
          ${damage ? `unlinkSync(${JSON.stringify(path)});` : ""}
          writeFileSync(${JSON.stringify(childPid)}, String(process.pid));
          writeFileSync(${JSON.stringify(ready)}, "ready");
          setInterval(() => {}, 1000);
        `;
        const guard = Bun.spawn(
          [process.execPath, "run", GUARD_SCRIPT, "--", process.execPath, "-e", source],
          { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" }
        );
        const output = new Response(guard.stderr).text();
        try {
          const deadline = Date.now() + 5000;
          while (!existsSync(ready)) {
            if (Date.now() > deadline) throw new Error("signal child never became ready");
            await Bun.sleep(5);
          }
          guard.kill(signal);
          const signalDeadline = Date.now() + 1000;
          while (!existsSync(received) && Date.now() < signalDeadline) await Bun.sleep(5);
          expect(existsSync(received)).toBe(true);
          const exitCode = await guard.exited;
          const stderr = await output;
          expect(exitCode).not.toBe(0);
          expect(existsSync(received)).toBe(true);
          expect(readFileSync(received, "utf8")).toBe(signal);
          expect(readFileSync(path, "utf8")).toBe(originalSecret);
          expect(statSync(path).mode & 0o777).toBe(0o600);
          expect(stderr.match(/MUTATED/g) ?? []).toHaveLength(damage ? 1 : 0);
          expect(stderr.match(/Restored it from the pre-run snapshot\./g) ?? []).toHaveLength(
            damage ? 1 : 0
          );
          if (!damage) expect(stderr).toContain(`command terminated by ${signal}`);
          expectNoSecretCopies(path);
        } finally {
          guard.kill("SIGKILL");
          if (existsSync(childPid)) {
            try {
              process.kill(Number(readFileSync(childPid, "utf8")), "SIGKILL");
            } catch {
              /* already exited */
            }
          }
          await guard.exited;
          await output;
          rmSync(home, { recursive: true, force: true });
        }
      }, 10_000);
    }
  }

  test("treats a non-ENOENT stat failure as unreadable, never absent", () => {
    withScratchHome((fixture) => {
      rmSync(fixture.claudishDir, { recursive: true });
      writeFileSync(fixture.claudishDir, "parent-is-not-a-directory", "utf8");
      const result = runGuard(
        fixture,
        'import { mkdirSync, rmSync, writeFileSync } from "node:fs"; rmSync(process.env.GUARD_TEST_CLAUDISH_DIR!); mkdirSync(process.env.GUARD_TEST_CLAUDISH_DIR!); writeFileSync(process.env.GUARD_TEST_CONFIG_PATH!, "created-after-stat-error", "utf8");'
      );

      expect(result.exitCode).toBe(1);
      expect(existsSync(fixture.configPath)).toBe(true);
      expect(existsSync(`${fixture.configPath}.guard-created`)).toBe(false);
      expect(readFileSync(fixture.configPath, "utf8")).toBe("created-after-stat-error");
      expect(stderrOf(result)).toContain("CANNOT RESTORE");
    });
  });
});
