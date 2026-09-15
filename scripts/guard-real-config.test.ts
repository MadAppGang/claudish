import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function runGuard(fixture: ScratchHome, commandSource: string): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(
    [process.execPath, "run", GUARD_SCRIPT, "--", process.execPath, "-e", commandSource],
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
