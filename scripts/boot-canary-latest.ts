#!/usr/bin/env bun
/**
 * The boot canary (scripts/boot-canary.ts) on npm's `latest` Claude Code:
 *
 *   bun scripts/boot-canary-latest.ts --out <dir>
 *
 * Reads the version npm's `latest` tag names for `@anthropic-ai/claude-code`, fetches the darwin
 * package of that version the way the pinned canary is fetched (`installPinnedClaudeCode`:
 * `npm pack`, untar, `--version` must print it), and boots it with `boot-canary.ts --bin <it>
 * --out <dir>`. Exits with the canary's code; any failure before the boot exits 1.
 *
 * It is the advisory step of one nightly part (`LATEST_CANARY_STEP` in scripts/test-macos.ts),
 * so a red run is recorded and fails nothing. Everything it fetches goes into one `mkdtemp`
 * directory, removed when it exits.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NO_ENV_FILE, installPinnedClaudeCode, parseClaudeCodePin } from "./test-macos.ts";

function fail(message: string): never {
  console.error(`[boot-canary-latest] ${message}`);
  process.exit(1);
}

if (import.meta.main) {
  const at = process.argv.indexOf("--out");
  const out = at === -1 ? undefined : process.argv[at + 1];
  if (!out || process.argv.length !== 4) fail("usage: boot-canary-latest.ts --out <dir>");
  if (process.arch !== "arm64" && process.arch !== "x64")
    fail(`no Claude Code darwin package for arch ${process.arch}`);

  const view = spawnSync("npm", ["view", "@anthropic-ai/claude-code@latest", "version"], {
    encoding: "utf8",
    env: { ...process.env },
  });
  if (view.status !== 0)
    fail(`npm view @anthropic-ai/claude-code@latest failed:\n${view.stderr ?? ""}`);
  let pin: ReturnType<typeof parseClaudeCodePin>;
  try {
    pin = parseClaudeCodePin(view.stdout ?? "", process.arch);
  } catch {
    fail(`npm's latest is not one x.y.z version: ${JSON.stringify(view.stdout ?? "")}`);
  }

  const runDir = mkdtempSync(join(tmpdir(), "claudish-boot-canary-latest-"));
  process.on("exit", () => rmSync(runDir, { recursive: true, force: true }));
  const claude = installPinnedClaudeCode(pin, runDir);
  console.log(`[boot-canary-latest] Claude Code ${pin.version} (npm latest): ${claude}`);

  const canary = spawnSync(
    process.execPath,
    [NO_ENV_FILE, join(import.meta.dir, "boot-canary.ts"), "--bin", claude, "--out", resolve(out)],
    { stdio: "inherit", env: { ...process.env } }
  );
  process.exit(canary.status ?? 1);
}
