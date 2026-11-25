import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findMagmuxCandidates } from "./launcher/magmux-binary.js";
import { findMagmuxForTest } from "./team-grid.e2e-helpers.js";

describe("findMagmuxForTest", () => {
  // test:macos puts the pinned magmux first on PATH; a fixed Homebrew path must not outrank it.
  test("takes magmux from PATH before any fixed install path", () => {
    const dir = mkdtempSync(join(tmpdir(), "magmux-lookup-"));
    const savedPath = process.env.PATH;
    try {
      const magmux = join(dir, "magmux");
      writeFileSync(magmux, "#!/bin/sh\necho 'magmux 0.0.0'\n");
      chmodSync(magmux, 0o755);
      // A bundled or npm-installed copy outranks PATH by design (findMagmuxCandidates).
      const shipped = findMagmuxCandidates({ PATH: "/nonexistent" }).paths[0];
      process.env.PATH = `${dir}:${savedPath ?? ""}`;
      expect(findMagmuxForTest()).toBe(shipped ?? magmux);
    } finally {
      process.env.PATH = savedPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
