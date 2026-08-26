import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProOnUltracode } from "./profile-config.js";

// Hermetic via the ScopedConfigPaths seam (homedir() can't be re-pointed at
// runtime in Bun) — same approach as onepassword-config.test.ts.
test("readProOnUltracode: project .claudish.json beats global config.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "claudish-scoped-"));
  try {
    const globalPath = join(dir, "config.json");
    const projectPath = join(dir, ".claudish.json");
    writeFileSync(globalPath, JSON.stringify({ proOnUltracode: false }));
    writeFileSync(projectPath, JSON.stringify({ proOnUltracode: true }));
    expect(readProOnUltracode({ global: () => globalPath, project: () => projectPath })).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
