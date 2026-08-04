#!/usr/bin/env bun
/**
 * Run a command and refuse to let it damage the developer's real claudish config.
 *
 *   bun run scripts/guard-real-config.ts -- bun test
 *   bun run test:safe
 *
 * Why this exists: three e2e test files used to sandbox by overwriting the real
 * `~/.claudish/config.json` and restoring it in `afterEach`. A killed or
 * timed-out run skipped the restore, so the fixture became permanent. That
 * destroyed a real user's `onepasswordAccount` and `onepasswordEnvironments`,
 * which silently disabled 1Password for every claudish run on that machine —
 * and because the failure mode is "1Password is never consulted", nothing
 * errored. It just quietly stopped working.
 *
 * Those files now use `setConfigFileOverride`, but the fix is a convention and
 * conventions decay. This guard is the enforcement: it does not care WHICH test
 * misbehaves, only that the file came out the way it went in. Snapshot, run,
 * compare, restore, fail loudly.
 *
 * Restoring rather than only reporting is deliberate. By the time a developer
 * reads the failure their config is already replaced, and — as happened here —
 * the `.bak` alongside it may be a clobbered copy from an earlier run. Putting
 * the bytes back is the part that actually saves them.
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG = join(homedir(), ".claudish", "config.json");

interface Snapshot {
  existed: boolean;
  content: string | null;
}

function snapshot(): Snapshot {
  try {
    if (!existsSync(CONFIG)) return { existed: false, content: null };
    return { existed: true, content: readFileSync(CONFIG, "utf-8") };
  } catch {
    return { existed: false, content: null };
  }
}

/** Which top-level keys changed — enough to see what a rogue test clobbered. */
function describeDelta(before: string | null, after: string | null): string[] {
  const parse = (s: string | null): Record<string, unknown> => {
    if (!s) return {};
    try {
      return JSON.parse(s) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  const a = parse(before);
  const b = parse(after);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const notes: string[] = [];
  for (const k of [...keys].sort()) {
    const inA = k in a;
    const inB = k in b;
    if (inA && !inB) notes.push(`  - REMOVED  ${k}`);
    else if (!inA && inB) notes.push(`  - added    ${k}`);
    else if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) notes.push(`  - changed  ${k}`);
  }
  return notes;
}

const args = process.argv.slice(2);
// Tolerate the `--` separator npm/bun users reflexively add.
const cmd = args[0] === "--" ? args.slice(1) : args;
if (cmd.length === 0) {
  process.stderr.write("usage: guard-real-config.ts [--] <command> [args...]\n");
  process.exit(2);
}

const before = snapshot();
if (before.existed) {
  // A dated sidecar, so the guard's own copy can never overwrite a real backup.
  try {
    copyFileSync(CONFIG, `${CONFIG}.guard-backup`);
  } catch {
    // Best effort: the in-memory snapshot is the real restore path.
  }
}

const child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit", env: process.env });

child.on("exit", (code, signal) => {
  const after = snapshot();
  const changed =
    before.existed !== after.existed || (before.content ?? null) !== (after.content ?? null);

  if (changed) {
    process.stderr.write(
      `\n\x1b[31m✗ REAL CONFIG MUTATED\x1b[0m — something in that command wrote ${CONFIG}\n`
    );
    for (const line of describeDelta(before.content, after.content)) {
      process.stderr.write(`${line}\n`);
    }
    try {
      if (before.existed && before.content !== null) {
        writeFileSync(CONFIG, before.content, "utf-8");
        process.stderr.write("\n  Restored your config from the pre-run snapshot.\n");
      }
    } catch (err) {
      process.stderr.write(
        `\n  \x1b[31mRESTORE FAILED\x1b[0m (${err instanceof Error ? err.message : String(err)}).\n` +
          `  A copy is at ${CONFIG}.guard-backup\n`
      );
    }
    process.stderr.write(
      "\n  Tests must isolate with setConfigFileOverride(<temp path>) instead of\n" +
        "  writing the real file. See scripts/guard-real-config.ts for the history.\n\n"
    );
    process.exit(1);
  }

  if (signal) {
    process.stderr.write(`\n[guard] command terminated by ${signal}; config intact.\n`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});

child.on("error", (err) => {
  process.stderr.write(`[guard] failed to run command: ${err.message}\n`);
  process.exit(1);
});
