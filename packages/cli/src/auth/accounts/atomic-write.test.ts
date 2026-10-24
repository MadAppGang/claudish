import { describe, expect, test } from "bun:test";
import {
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
import { atomicWriteFileSync } from "./atomic-write.js";

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "claudish-atomic-write-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("atomicWriteFileSync", () => {
  test("replaces the whole file and enforces 0600 even under a fully restrictive umask", () => {
    withTempDir((dir) => {
      const target = join(dir, "codex-oauth.json");
      writeFileSync(target, "old credential bytes", "utf8");

      // Mutation caught: remove the explicit chmod after creating the temp file.
      // With umask 0777, open(..., 0600) creates mode 0000; chmod is what makes
      // the final mode an exact guarantee rather than a request to the OS.
      const previousUmask = process.umask(0o777);
      try {
        atomicWriteFileSync(target, "new credential bytes");
      } finally {
        process.umask(previousUmask);
      }

      expect(readFileSync(target, "utf8")).toBe("new credential bytes");
      expect(statSync(target).mode & 0o777).toBe(0o600);
      expect(readdirSync(dir).filter((name) => name.includes(".tmp-"))).toEqual([]);
    });
  });

  test("leaves prior bytes intact when the temp file cannot be created", () => {
    withTempDir((dir) => {
      // 240 bytes is a valid final basename on NAME_MAX=255 filesystems, while
      // adding `.tmp-<pid>-<nonce>` exceeds NAME_MAX deterministically.
      const target = join(dir, "x".repeat(240));
      writeFileSync(target, "old credential bytes", "utf8");

      // Mutation caught: replace temp+rename with openSync(target, "w") and a
      // direct write. That mutant succeeds against the short final basename and
      // destroys the old bytes instead of throwing before publication.
      expect(() => atomicWriteFileSync(target, "replacement")).toThrow();
      expect(readFileSync(target, "utf8")).toBe("old credential bytes");
      expect(readdirSync(dir)).toEqual(["x".repeat(240)]);
    });
  });
});

describe("CodexOAuth credential persistence", () => {
  test("serializes before opening anything, so a serialization fault cannot truncate the token file", () => {
    withTempDir((home) => {
      const claudishDir = join(home, ".claudish");
      const target = join(claudishDir, "codex-oauth.json");
      mkdirSync(claudishDir, { recursive: true });
      writeFileSync(target, "old credential bytes", { encoding: "utf8", mode: 0o600 });

      // Isolate HOME and the CodexOAuth singleton in a real child process. The
      // child never touches the login Keychain or the developer's credential file.
      const modulePath = join(import.meta.dir, "../codex-oauth.ts");
      const source = `
        import { readFileSync } from "node:fs";
        import { homedir } from "node:os";
        import { join } from "node:path";
        import { CodexOAuth } from ${JSON.stringify(modulePath)};

        const oauth = CodexOAuth.getInstance();
        const poison = { toJSON() { throw new Error("serialization fault"); } };
        try {
          (oauth as unknown as { saveCredentials(value: unknown): void }).saveCredentials(poison);
        } catch {}
        process.stdout.write(readFileSync(join(homedir(), ".claudish", "codex-oauth.json"), "utf8"));
      `;
      const child = Bun.spawnSync([process.execPath, "-e", source], {
        cwd: import.meta.dir,
        env: {
          ...process.env,
          HOME: home,
          CLAUDISH_DISABLE_KEYCHAIN: "1",
          CLAUDISH_DISABLE_OP: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(child.exitCode).toBe(0);
      expect(child.stdout.toString()).toBe("old credential bytes");
      // Mutation caught: restore openSync(path, "w") before JSON.stringify.
      // That old ordering truncates the file before the injected fault throws.
      expect(readFileSync(target, "utf8")).toBe("old credential bytes");
    });
  });
});
