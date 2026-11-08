import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const target of ["usage/raw/2026-10-23.jsonl", "allowance-alerts.json"]) {
  test("33f guard detects a write to the scratch HOME's real " + target, () => {
    const home = mkdtempSync(join(tmpdir(), "allowance-guard-contract-"));
    try {
      const path = join(home, ".claudish/accounts", target);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "before\n");
      const command =
        'import {appendFileSync} from "node:fs";appendFileSync(' +
        JSON.stringify(path) +
        ',"after\\n");';
      const args =
        process.env.ALLOWANCE_MUTATION === "bypass-guard"
          ? [process.execPath, "-e", command]
          : [
              process.execPath,
              "run",
              join(import.meta.dir, "guard-real-config.ts"),
              "--",
              process.execPath,
              "-e",
              command,
            ];
      const child = Bun.spawnSync(args, {
        env: { ...process.env, HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(child.exitCode).toBe(1);
      expect(new TextDecoder().decode(child.stderr)).toContain("MUTATED");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}
test("33f unchanged scratch ledger is accepted", () => {
  const home = mkdtempSync(join(tmpdir(), "allowance-guard-contract-"));
  try {
    const child = Bun.spawnSync(
      [
        process.execPath,
        "run",
        join(import.meta.dir, "guard-real-config.ts"),
        "--",
        process.execPath,
        "-e",
        "process.exit(0)",
      ],
      { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" }
    );
    expect(child.exitCode).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
