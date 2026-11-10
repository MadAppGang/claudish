import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
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
  copyFileSync(
    join(import.meta.dir, "session-env-vars.ts"),
    join(fixture.home, "session-env-vars.ts")
  );
  writeFileSync(path, source.replace(before, after));
  return path;
}

const NON_SECRET_FILES = [
  "config.json",
  "cloud-models-catalog-v3.json",
  "cloud-models-catalog-v3.routes.json",
  "cloud-models-catalog-v3.efforts.json",
  "all-models.json",
  "openrouter-models.json",
  "accounts/allowance-alerts.json",
  "catalog-incompatible.json",
] as const;

describe("guard-real-config", () => {
  // Valid keys and directory deltas are not damage.
  test("57. guards the dynamic models catalog directory and its secret key", () => {
    withScratchHome((fixture) => {
      const dir = join(fixture.claudishDir, "dynamic-models-catalog");
      const listPath = join(dir, "devin.json");
      const keyPath = join(fixture.claudishDir, "dynamic-models-catalog.key");
      const secret = "7".repeat(64);
      const result = runGuard(
        fixture,
        `import { mkdirSync, writeFileSync } from "node:fs";
         mkdirSync(${JSON.stringify(dir)}, { mode: 0o700 });
         writeFileSync(${JSON.stringify(listPath)}, '{"schema":1,"provider":"devin","accounts":{}}', { mode: 0o600 });
         writeFileSync(${JSON.stringify(keyPath)}, ${JSON.stringify(secret)}, { mode: 0o600 });`
      );

      expect(result.exitCode).toBe(0);
      const stderr = stderrOf(result);
      expect(stderr).toContain("REAL DYNAMIC MODELS CATALOG KEY");
      expect(stderr).toContain(keyPath);
      expect(stderr).toContain("REAL DYNAMIC MODELS CATALOG");
      expect(stderr).toContain(dir);
      expect(stderr).toContain("devin.json");
      expect(stderr).not.toContain(secret);
      expect(readFileSync(keyPath, "utf8")).toBe(secret);
      expect(statSync(keyPath).mode & 0o777).toBe(0o600);
      expect(stderr).toContain("WARNING — kept");
      expect(stderr).toContain("changed during the run");
      expect(stderr).toContain("Not restored");
      expect(stderr).not.toContain("MUTATED");
      expect(readFileSync(listPath, "utf8")).toBe('{"schema":1,"provider":"devin","accounts":{}}');
      expectNoSecretCopies(keyPath);
    });
  });

  // Invalid created non-secret files are moved aside.
  test("moves a file created during the command to .guard-created and exits 1", () => {
    withScratchHome((fixture) => {
      const createdContent = "not JSON created by the child\n";
      const result = runGuard(
        fixture,
        `import { writeFileSync } from "node:fs"; writeFileSync(process.env.GUARD_TEST_CONFIG_PATH!, ${JSON.stringify(createdContent)}, "utf8");`
      );

      const movedPath = `${fixture.configPath}.guard-created`;
      expect(result.exitCode).toBe(1);
      expect(existsSync(fixture.configPath)).toBe(false);
      expect(readFileSync(movedPath, "utf8")).toBe(createdContent);
      expect(stderrOf(result)).toContain("moved aside");
      expect(stderrOf(result)).toContain("MUTATED");
    });
  });

  // Only damaged non-secret content is restored.
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

  // Deleted secrets are restored privately.
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

  // Unchanged files do not affect the child result.
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

  // Credential rotations are valid concurrent writes, not damage.
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

        expect(result.exitCode).toBe(0);
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

  // Formatting-only secret changes are retained.
  test("keeps byte-only credential changes and reports unchanged key names", () => {
    withScratchHome((fixture) => {
      const path = seedSecret(fixture);
      const formatted = JSON.stringify(JSON.parse(originalSecret), null, 2);
      const result = runGuard(
        fixture,
        `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(formatted)});`
      );
      expect(result.exitCode).toBe(0);
      expect(readFileSync(path, "utf8")).toBe(formatted);
      expect(stderrOf(result)).toContain("No top-level key names changed.");
      expectNoSecretCopies(path);
    });
  });

  // Invalid refresh-token stores must be repaired.
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

  // Unreadable secrets are damaged.
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

  // Account state needs only parseable JSON, including null.
  for (const content of ['{"lastAccount":"TEST_ACCOUNT"}', "null"]) {
    test(`keeps parseable account state ${content} without a refresh token`, () => {
      withScratchHome((fixture) => {
        const path = seedSecret(fixture, "accounts/state.json");
        const result = runGuard(
          fixture,
          `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(content)});`
        );
        expect(result.exitCode).toBe(0);
        expect(readFileSync(path, "utf8")).toBe(content);
        expect(stderrOf(result)).toContain("WARNING — kept");
        expectNoSecretCopies(path);
      });
    });
  }

  // Account state still rejects invalid JSON.
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

  // Permission-only repair preserves bytes and child result.
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
      expect(result.exitCode).toBe(0);
      expect(readFileSync(path, "utf8")).toBe(originalSecret);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(String(statSync(path).ino)).toBe(readFileSync(inodePath, "utf8"));
      expect(stderrOf(result)).toContain("Repaired secret file permissions to 0600.");
      expect(stderrOf(result)).not.toContain("Restored it from the pre-run snapshot.");
      expectNoSecretCopies(path);
    });
  });

  // Untouched secret permissions are not changed.
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
    // Valid new logins survive; invalid new secrets are removed.
    test(`${content === originalSecret ? "keeps a test-created valid secret at 0600" : "deletes a test-created invalid secret"} without a copy`, () => {
      withScratchHome((fixture) => {
        const path = join(fixture.claudishDir, "codex-oauth.json");
        const result = runGuard(
          fixture,
          `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(content)});`
        );
        const valid = content === originalSecret;
        expect(result.exitCode).toBe(valid ? 0 : 1);
        expect(existsSync(path)).toBe(valid);
        expect(stderrOf(result)).toContain(path);
        if (valid) {
          expect(readFileSync(path, "utf8")).toBe(content);
          expect(statSync(path).mode & 0o777).toBe(0o600);
          expect(stderrOf(result)).toContain("WARNING — kept");
          expect(stderrOf(result)).not.toContain("MUTATED");
          expect(stderrOf(result)).not.toContain("TEST_REFRESH_BEFORE");
          expect(stderrOf(result)).not.toContain("TEST_ACCESS_BEFORE");
        } else {
          expect(stderrOf(result)).toContain("Deleted test-created secret");
          expect(stderrOf(result)).toContain("MUTATED");
        }
        expectNoSecretCopies(path);
      });
    });
  }

  // Preserve the existing private-restore safety check.
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

  // Preserve the existing restore-failure injection harness.
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

  // A repair reads the file again first: a valid write that lands after the
  // post-run snapshot belongs to a live session and is kept.
  test("keeps a valid login written after the post-run snapshot instead of restoring over it", () => {
    withScratchHome((fixture) => {
      const path = seedSecret(fixture);
      const fresh = JSON.stringify({ refresh_token: "TEST_REFRESH_FRESH_LOGIN" });
      const script = patchedGuard(
        fixture,
        "    if (changed && settle(g, prior, after)) damaged = true;",
        `    if (changed && g.path === ${JSON.stringify(path)}) writeFileSync(g.path, ${JSON.stringify(fresh)}, { mode: 0o600 });\n    if (changed && settle(g, prior, after)) damaged = true;`
      );
      const result = runGuard(
        fixture,
        `import { rmSync } from "node:fs"; rmSync(${JSON.stringify(path)});`,
        script
      );
      expect(result.exitCode).toBe(0);
      expect(readFileSync(path, "utf8")).toBe(fresh);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(stderrOf(result)).toContain("WARNING — kept");
      expect(stderrOf(result)).not.toContain("Restored it from");
      expectNoSecretCopies(path);
    });
  });

  // Termination always overrides child success.
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
          expect(exitCode).toBe(1);
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

  for (const relativePath of NON_SECRET_FILES) {
    for (const code of [0, 7]) {
      test(`keeps valid changed ${relativePath}, backs up original bytes and preserves child exit ${code}`, () => {
        withScratchHome((fixture) => {
          const path = join(fixture.claudishDir, relativePath);
          mkdirSync(join(path, ".."), { recursive: true });
          const original =
            '{\n  "stable": true,\n  "changedKey": "before",\n  "removedKey": true\n}\n';
          const updated = '{"stable":true,"changedKey":"after","addedKey":true}\n';
          writeFileSync(path, original);

          const result = runGuard(
            fixture,
            `import { writeFileSync } from "node:fs";
             writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(updated)});
             process.exit(${code});`
          );

          expect(result.exitCode).toBe(code);
          expect(readFileSync(path, "utf8")).toBe(updated);
          expect(readFileSync(`${path}.guard-backup`, "utf8")).toBe(original);
          expect(existsSync(`${path}.guard-created`)).toBe(false);
          const stderr = stderrOf(result);
          expect(stderr).toContain(`WARNING — kept ${path}`);
          expect(stderr).toContain(`${path}.guard-backup`);
          expect(stderr).toContain("changedKey");
          expect(stderr).toContain("removedKey");
          expect(stderr).toContain("addedKey");
          expect(stderr).not.toContain("MUTATED");
          expect(stderr).not.toContain("Restored it from the pre-run snapshot.");
        });
      });
    }
  }

  test("keeps a valid created non-secret file without moving it aside", () => {
    withScratchHome((fixture) => {
      const created = '{"createdBy":"guard-test"}\n';
      const result = runGuard(
        fixture,
        `import { writeFileSync } from "node:fs";
         writeFileSync(${JSON.stringify(fixture.configPath)}, ${JSON.stringify(created)});`
      );

      expect(result.exitCode).toBe(0);
      expect(readFileSync(fixture.configPath, "utf8")).toBe(created);
      expect(existsSync(`${fixture.configPath}.guard-created`)).toBe(false);
      const stderr = stderrOf(result);
      expect(stderr).toContain(`WARNING — kept ${fixture.configPath}`);
      expect(stderr).not.toContain("MUTATED");
      expect(stderr).not.toContain("moved aside");
    });
  });

  for (const [name, damaged] of [
    ["empty", ""],
    ["malformed JSON", "{"],
    ["null", "null"],
    ["scalar", "42"],
    ["array", "[]"],
    ["deleted", undefined],
  ] as const) {
    test(`restores ${name} non-secret config byte-exactly and exits 1`, () => {
      withScratchHome((fixture) => {
        const original = '{\n  "onepasswordAccount": "test-account",\n  "stable": true\n}\n';
        writeFileSync(fixture.configPath, original, { mode: 0o640 });
        chmodSync(fixture.configPath, 0o640);
        const action =
          damaged === undefined
            ? `unlinkSync(${JSON.stringify(fixture.configPath)});`
            : `writeFileSync(${JSON.stringify(fixture.configPath)}, ${JSON.stringify(damaged)});`;

        const result = runGuard(
          fixture,
          `import { unlinkSync, writeFileSync } from "node:fs"; ${action}`
        );

        expect(result.exitCode).toBe(1);
        expect(readFileSync(fixture.configPath, "utf8")).toBe(original);
        expect(statSync(fixture.configPath).mode & 0o777).toBe(0o640);
        const stderr = stderrOf(result);
        expect(stderr).toContain("MUTATED");
        expect(stderr).toContain("Restored it from the pre-run snapshot.");
        expect(stderr).not.toContain("WARNING — kept");
      });
    });
  }

  test("restores a deleted 0600 config at its prior mode", () => {
    withScratchHome((fixture) => {
      const original = '{"private":true}\n';
      writeFileSync(fixture.configPath, original, { mode: 0o600 });
      chmodSync(fixture.configPath, 0o600);

      const result = runGuard(
        fixture,
        `import { unlinkSync } from "node:fs"; unlinkSync(${JSON.stringify(fixture.configPath)});`
      );

      expect(result.exitCode).toBe(1);
      expect(readFileSync(fixture.configPath, "utf8")).toBe(original);
      expect(statSync(fixture.configPath).mode & 0o777).toBe(0o600);
      expect(stderrOf(result)).toContain("Restored it from the pre-run snapshot.");
    });
  });

  test("restores a non-secret config made unreadable at mode 000", () => {
    withScratchHome((fixture) => {
      const original = '{"stable":true}\n';
      writeFileSync(fixture.configPath, original, { mode: 0o640 });
      chmodSync(fixture.configPath, 0o640);

      const result = runGuard(
        fixture,
        `import { chmodSync, writeFileSync } from "node:fs";
         writeFileSync(${JSON.stringify(fixture.configPath)}, "{");
         chmodSync(${JSON.stringify(fixture.configPath)}, 0);`
      );

      expect(result.exitCode).toBe(1);
      expect(readFileSync(fixture.configPath, "utf8")).toBe(original);
      expect(statSync(fixture.configPath).mode & 0o777).toBe(0o640);
      expect(stderrOf(result)).toContain("MUTATED");
      expect(stderrOf(result)).toContain("Restored it from the pre-run snapshot.");
    });
  });

  test("restores non-secret bytes by replacing the file, not writing through a hard link", () => {
    withScratchHome((fixture) => {
      const original = '{"original":true}\n';
      const alias = join(fixture.home, "config-hard-link");
      writeFileSync(fixture.configPath, original, { mode: 0o640 });
      chmodSync(fixture.configPath, 0o640);
      linkSync(fixture.configPath, alias);

      const result = runGuard(
        fixture,
        `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(fixture.configPath)}, "{");`
      );

      expect(result.exitCode).toBe(1);
      expect(readFileSync(fixture.configPath, "utf8")).toBe(original);
      expect(readFileSync(alias, "utf8")).toBe("{");
      expect(statSync(fixture.configPath).ino).not.toBe(statSync(alias).ino);
      expect(statSync(fixture.configPath).mode & 0o777).toBe(0o640);
      expect(stderrOf(result)).toContain("Restored it from the pre-run snapshot.");
    });
  });

  for (const [directory, label] of [
    ["accounts/usage", "REAL USAGE LEDGER"],
    ["dynamic-models-catalog", "REAL DYNAMIC MODELS CATALOG"],
  ]) {
    for (const code of [0, 7]) {
      test(`keeps ${label} directory deltas and preserves child exit ${code}`, () => {
        withScratchHome((fixture) => {
          const dir = join(fixture.claudishDir, directory);
          mkdirSync(dir, { recursive: true });
          const changed = join(dir, "changed.json");
          const removed = join(dir, "removed.json");
          const added = join(dir, "added.json");
          writeFileSync(changed, '{"before":true}');
          writeFileSync(removed, '{"remove":true}');

          const result = runGuard(
            fixture,
            `import { unlinkSync, writeFileSync } from "node:fs";
             writeFileSync(${JSON.stringify(changed)}, '{"after":true}');
             unlinkSync(${JSON.stringify(removed)});
             writeFileSync(${JSON.stringify(added)}, '{"added":true}');
             process.exit(${code});`
          );

          expect(result.exitCode).toBe(code);
          expect(readFileSync(changed, "utf8")).toBe('{"after":true}');
          expect(existsSync(removed)).toBe(false);
          expect(readFileSync(added, "utf8")).toBe('{"added":true}');
          const stderr = stderrOf(result);
          expect(stderr).toContain(`${label} changed during the run`);
          for (const name of ["changed.json", "removed.json", "added.json"]) {
            expect(stderr).toContain(name);
          }
          expect(stderr).toContain("Not restored");
          expect(stderr).not.toContain("MUTATED");
        });
      });
    }
  }

  for (const [relativePath, label] of [
    ["config.json", "REAL CONFIG"],
    ["accounts/usage/raw/run.jsonl", "REAL USAGE LEDGER"],
    ["dynamic-models-catalog/test.json", "REAL DYNAMIC MODELS CATALOG"],
  ]) {
    test(`trips on ${label} written using child HOME and removes run home`, () => {
      withScratchHome((fixture) => {
        const original = '{"untouched":true}\n';
        writeFileSync(fixture.configPath, original);
        const result = runGuard(
          fixture,
          `import { mkdirSync, writeFileSync } from "node:fs";
           import { join, dirname } from "node:path";
           const path = join(process.env.HOME!, ".claudish", ${JSON.stringify(relativePath)});
           mkdirSync(dirname(path), { recursive: true });
           writeFileSync(path, '{"fromChild":true}');
           process.stdout.write(JSON.stringify({
             home: process.env.HOME,
             marker: process.env.CLAUDISH_GUARD_RUN_HOME,
           }));`
        );

        expect(result.exitCode).toBe(1);
        expect(readFileSync(fixture.configPath, "utf8")).toBe(original);
        if (relativePath !== "config.json") {
          expect(existsSync(join(fixture.claudishDir, relativePath))).toBe(false);
        }
        const seen = JSON.parse(decoder.decode(result.stdout)) as { home: string; marker: string };
        expect(seen.home).not.toBe(fixture.home);
        expect(seen.home).toBe(seen.marker);
        expect(seen.home).toStartWith(join(tmpdir(), "claudish-guard-home-"));
        expect(existsSync(seen.home)).toBe(false);
        const stderr = stderrOf(result);
        expect(stderr).toContain(`${label} WRITTEN IN THE RUN HOME`);
        expect(stderr).toMatch(/spawn/i);
        expect(stderr).toMatch(/no[\s\S]{0,40}env|without[\s\S]{0,40}env/i);
      });
    });
  }

  test("keeps a key-losing config and retains the original privately across later runs", () => {
    withScratchHome((fixture) => {
      const original = '{\n  "onepasswordAccount": "test-account",\n  "stable": true\n}\n';
      const updated = '{"stable":false}\n';
      writeFileSync(fixture.configPath, original);
      const result = runGuard(
        fixture,
        `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(fixture.configPath)}, ${JSON.stringify(updated)});`
      );

      expect(result.exitCode).toBe(0);
      expect(readFileSync(fixture.configPath, "utf8")).toBe(updated);
      const copies = readdirSync(fixture.claudishDir).filter((name) =>
        name.startsWith("config.json.guard-kept-")
      );
      expect(copies).toHaveLength(1);
      expect(copies[0]!.slice("config.json.guard-kept-".length).length).toBeGreaterThan(0);
      const retainedPath = join(fixture.claudishDir, copies[0]!);
      expect(readFileSync(retainedPath, "utf8")).toBe(original);
      expect(statSync(retainedPath).mode & 0o777).toBe(0o600);
      const stderr = stderrOf(result);
      expect(stderr).toContain(`WARNING — kept ${fixture.configPath}`);
      expect(stderr).toContain("onepasswordAccount");
      expect(stderr).toContain(retainedPath);
      expect(stderr).not.toContain("MUTATED");

      const later = runGuard(fixture, "process.exit(0);");
      expect(later.exitCode).toBe(0);
      expect(readFileSync(`${fixture.configPath}.guard-backup`, "utf8")).toBe(updated);
      expect(readFileSync(retainedPath, "utf8")).toBe(original);
      expect(statSync(retainedPath).mode & 0o777).toBe(0o600);
      expect(
        readdirSync(fixture.claudishDir).filter((name) =>
          name.startsWith("config.json.guard-kept-")
        )
      ).toEqual(copies);
    });
  });

  test("keeps a key-preserving config change without a retained copy", () => {
    withScratchHome((fixture) => {
      const original = '{"stable":true}\n';
      const updated = '{"stable":false,"added":true}\n';
      writeFileSync(fixture.configPath, original);
      const result = runGuard(
        fixture,
        `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(fixture.configPath)}, ${JSON.stringify(updated)});`
      );

      expect(result.exitCode).toBe(0);
      expect(readFileSync(fixture.configPath, "utf8")).toBe(updated);
      expect(readFileSync(`${fixture.configPath}.guard-backup`, "utf8")).toBe(original);
      expect(
        readdirSync(fixture.claudishDir).filter((name) =>
          name.startsWith("config.json.guard-kept-")
        )
      ).toEqual([]);
      expect(stderrOf(result)).toContain(`WARNING — kept ${fixture.configPath}`);
      expect(stderrOf(result)).not.toContain("MUTATED");
    });
  });

  for (const [name, replacement, valid] of [
    ["mixed-case hex", "aB".repeat(32), true],
    ["non-hex", "z".repeat(64), false],
    ["short hex", "a".repeat(63), false],
    ["long hex", "a".repeat(65), false],
  ] as const) {
    test(`${valid ? "keeps" : "restores"} changed ${name} dynamic models catalog key`, () => {
      withScratchHome((fixture) => {
        const path = join(fixture.claudishDir, "dynamic-models-catalog.key");
        const original = "7".repeat(64);
        writeFileSync(path, original, { mode: 0o600 });
        const result = runGuard(
          fixture,
          `import { chmodSync, writeFileSync } from "node:fs";
           writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(replacement)});
           chmodSync(${JSON.stringify(path)}, 0o644);`
        );

        expect(result.exitCode).toBe(valid ? 0 : 1);
        expect(readFileSync(path, "utf8")).toBe(valid ? replacement : original);
        expect(statSync(path).mode & 0o777).toBe(0o600);
        const stderr = stderrOf(result);
        expect(stderr).toContain(
          valid ? "WARNING — kept" : "Restored it from the pre-run snapshot."
        );
        if (valid) expect(stderr).not.toContain("MUTATED");
        else expect(stderr).toContain("MUTATED");
        expect(stderr).not.toContain(original);
        expect(stderr).not.toContain(replacement);
        expectNoSecretCopies(path);
      });
    });
  }

  // Stat failure must not be mistaken for absence.
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
