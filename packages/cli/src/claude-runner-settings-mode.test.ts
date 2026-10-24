import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTempSettingsFile, mergeUserSettingsIfPresent } from "./claude-runner.js";
import type { ClaudishConfig } from "./types.js";

// REGRESSION: MTL-207 — Child claudish copies inherited settings env secrets into a 0644 ~/.claudish/settings-<ts>.json — Fixed in /dev:fix session dev-fix-20261024-232213-8ffb9daa
const KEYS = ["HOME", "CLAUDISH_TOKEN_FILE", "CLAUDISH_PUBLISHED_TOKEN_FILE"] as const;
const dirs: string[] = [];
let previousUmask: number;

beforeAll(() => {
  previousUmask = process.umask(0o022);
});

afterAll(() => {
  process.umask(previousUmask);
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function withHome(fn: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "claudish-settings-mode-"));
  dirs.push(home);
  const saved: Partial<Record<(typeof KEYS)[number], string>> = {};
  for (const key of KEYS) {
    saved[key] = process.env[key];
    if (key === "HOME") process.env[key] = home;
    else delete process.env[key];
  }
  try {
    fn(home);
  } finally {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function inheritedConfig(home: string): ClaudishConfig {
  const path = join(home, "inherited-settings.json");
  writeFileSync(path, JSON.stringify({ env: { EXAMPLE_TOKEN: "x" } }), { mode: 0o600 });
  return { quiet: true, claudeArgs: ["--settings", path] } as ClaudishConfig;
}

test.skipIf(process.platform === "win32")(
  "should create owner-only settings when createTempSettingsFile runs under umask 022",
  () => {
    withHome(() => {
      const settings = createTempSettingsFile("m", "4321", true);
      expect(statSync(settings.path).mode & 0o777).toBe(0o600);
    });
  }
);

test.skipIf(process.platform === "win32")(
  "should restrict existing settings when merging an inherited env layer into a 0644 file",
  () => {
    withHome((home) => {
      const path = join(home, "overlay.json");
      writeFileSync(path, "{}", { mode: 0o644 });
      chmodSync(path, 0o644);
      const config = inheritedConfig(home);
      const statusLine = { type: "command", command: "echo hi", padding: 0 };
      mergeUserSettingsIfPresent(config, path, statusLine, true, false);
      expect(JSON.parse(readFileSync(path, "utf8")).env.EXAMPLE_TOKEN).toBe("x");
      expect(statSync(path).mode & 0o777).toBe(0o600);
    });
  }
);

test.skipIf(process.platform === "win32")(
  "should retain owner-only settings when an inherited env layer is merged after creation",
  () => {
    withHome((home) => {
      const settings = createTempSettingsFile("m", "4322", true);
      const config = inheritedConfig(home);
      mergeUserSettingsIfPresent(config, settings.path, settings.statusLine, true, false);
      expect(JSON.parse(readFileSync(settings.path, "utf8")).env.EXAMPLE_TOKEN).toBe("x");
      expect(statSync(settings.path).mode & 0o777).toBe(0o600);
    });
  }
);
