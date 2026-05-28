#!/usr/bin/env node

// Launcher script: checks for Bun runtime before starting claudish.
// Claudish uses Bun-specific APIs (bun:ffi for TUI, Bun.spawn, etc.)
// so it cannot run under Node.js directly.

const { execFileSync, execSync } = require("child_process");
const { resolve } = require("path");

function findBun() {
  const isWin = process.platform === "win32";
  // PATH lookup — "which" is POSIX-only; Windows uses "where".
  try {
    const out = execSync(isWin ? "where bun" : "which bun", { encoding: "utf-8" }).trim();
    const first = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    if (first) return first;
  } catch {}
  // Common install locations
  const home = process.env.HOME || process.env.USERPROFILE;
  const candidates = isWin
    ? [
        home && resolve(home, ".bun", "bin", "bun.exe"),
        home && resolve(home, ".bun", "bin", "bun"),
      ]
    : [
        home && home + "/.bun/bin/bun",
        "/usr/local/bin/bun",
        "/opt/homebrew/bin/bun",
      ];
  for (const c of candidates) {
    if (!c) continue;
    try {
      execFileSync(c, ["--version"], { stdio: "ignore" });
      return c;
    } catch {}
  }
  return null;
}

const bun = findBun();
if (!bun) {
  const installCmd =
    process.platform === "win32"
      ? 'powershell -c "irm bun.sh/install.ps1 | iex"'
      : "curl -fsSL https://bun.sh/install | bash";
  console.error(`claudish requires the Bun runtime but it was not found.

Install Bun (one command):
  ${installCmd}

Then retry:
  claudish --version

Learn more: https://bun.sh`);
  process.exit(1);
}

// Exec into bun with the real entry point
const entry = resolve(__dirname, "..", "dist", "index.js");
try {
  const result = require("child_process").spawnSync(bun, [entry, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: process.env,
  });
  process.exit(result.status ?? 1);
} catch (err) {
  console.error("Failed to start claudish:", err.message);
  process.exit(1);
}
