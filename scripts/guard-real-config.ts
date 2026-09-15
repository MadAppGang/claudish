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
 *
 * GUARDED is a list rather than one path because the convention decayed again,
 * in exactly the shape the paragraph above describes. `all-models.json` is the
 * hosted model catalog's disk cache, and `effort-mapping.test.ts` seeds a
 * fixture into it and restores in a `finally`. That is the same save/restore
 * pattern the config files used, with the same hole: a killed or timed-out run
 * skips the restore and the two-entry fixture becomes the machine's permanent
 * catalog. It fails the way the config damage did — silently, as wrong routing
 * and wrong reasoning decisions rather than an error — because a stale catalog
 * is indistinguishable from a cold one to every caller.
 *
 * The seam that would remove the need is missing, which is why the test writes
 * the real path at all: `findCacheEntry(modelId, cachePath?)` accepts an
 * override, but `BaseApiFormat.lookupReasoningCapability` calls
 * `lookupModelReasoning(this.modelId)` with no way to pass one, so a dialect
 * test cannot redirect the read. `catalog-client.ts` solved the same problem
 * with an in-memory seam (`_setCatalogEntriesForTest`); `model-catalog.ts` has
 * no equivalent. Until it does, this guard is the backstop.
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Every real file a test run must give back unchanged. `label` names it in the
 * failure, and `remedy` states the isolation the author should have used — the
 * two files have different answers, so the message cannot be generic.
 */
const GUARDED = [
  {
    path: join(homedir(), ".claudish", "config.json"),
    label: "REAL CONFIG",
    remedy: "isolate with setConfigFileOverride(<temp path>) instead of writing the real file",
  },
  {
    path: join(homedir(), ".claudish", "all-models.json"),
    label: "REAL MODEL CATALOG CACHE",
    remedy:
      "pass a temp path to readAllModelsCache/writeAllModelsCache, or seed in memory the way " +
      "catalog-client.ts's _setCatalogEntriesForTest does, instead of writing the real cache",
  },
] as const;

interface Snapshot {
  existed: boolean;
  content: string | null;
  /** `existed` is true but the bytes could not be read, so no restore is possible. */
  unreadable: boolean;
}

/**
 * Presence and content are established SEPARATELY. Folding an unreadable file
 * into "absent" would be a data-loss bug now that absence authorises a delete
 * below: a file the guard could not read at snapshot time would be removed after
 * the run as though the command had created it.
 */
function snapshot(path: string): Snapshot {
  if (!existsSync(path)) return { existed: false, content: null, unreadable: false };
  try {
    return { existed: true, content: readFileSync(path, "utf-8"), unreadable: false };
  } catch {
    return { existed: true, content: null, unreadable: true };
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
    else if (JSON.stringify(a[k]) !== JSON.stringify(b[k]))
      notes.push(`  - changed  ${k}${describeSize(a[k], b[k])}`);
  }
  return notes;
}

/**
 * Array lengths either side of a change, because the catalog's damage IS its
 * length: "changed entries" and "changed entries (947 -> 2)" are the same
 * finding, but only the second one reads as a clobbered file at a glance.
 */
function describeSize(before: unknown, after: unknown): string {
  if (!Array.isArray(before) || !Array.isArray(after)) return "";
  if (before.length === after.length) return "";
  return `  (${before.length} -> ${after.length} entries)`;
}

const args = process.argv.slice(2);
// Tolerate the `--` separator npm/bun users reflexively add.
const cmd = args[0] === "--" ? args.slice(1) : args;
if (cmd.length === 0) {
  process.stderr.write("usage: guard-real-config.ts [--] <command> [args...]\n");
  process.exit(2);
}

const before = new Map(GUARDED.map((g) => [g.path, snapshot(g.path)]));
for (const g of GUARDED) {
  if (!before.get(g.path)?.existed) continue;
  // A sidecar, so the guard's own copy can never overwrite a real backup.
  try {
    copyFileSync(g.path, `${g.path}.guard-backup`);
  } catch {
    // Best effort: the in-memory snapshot is the real restore path.
  }
}

// The developer's real CREDENTIAL STORES are guarded the same way as their
// config file, and for the same reason: a test that reaches one is not
// hermetic, and the damage lands on the machine rather than on the test.
//
// `CLAUDISH_DISABLE_KEYCHAIN=1` makes `hasKeychainSource()` return false, so no
// suite can spawn `security` against the login keychain. This is not
// hypothetical: `keychain.enabled` in a real config was enough to make an
// unrelated test run enumerate it. The keychain is worse than the config file
// in one respect — a mutation there cannot be snapshotted and restored the way
// the bytes of a JSON file can — so it is prevented rather than repaired.
//
// `CLAUDISH_DISABLE_OP=1` is set for the same reason: 1Password arbitrates its
// handshake machine-wide, and a burst of denials from a test run suppresses
// authorization for every process on the machine for 15 seconds.
//
// `CLAUDISH_DISABLE_CATALOG_WARM=1` is the third. `createProxyServer` fires
// `warmCatalog()` on every create, which live-fetches the hosted catalog and
// writes `all-models.json` — so a suite that builds a proxy reads the network
// and rewrites the machine. Prevention beats the snapshot here for the same
// reason it does for the keychain: the restore below puts the bytes back, but
// it cannot put back the hermeticity. A test whose result depends on what the
// hosted catalog said this morning is the failure that turned two DeepSeek
// tests red mid-release.
const child = spawn(cmd[0], cmd.slice(1), {
  stdio: "inherit",
  env: {
    ...process.env,
    CLAUDISH_DISABLE_KEYCHAIN: "1",
    CLAUDISH_DISABLE_OP: "1",
    CLAUDISH_DISABLE_CATALOG_WARM: "1",
  },
});

/** Report one file's mutation, put the original bytes back, and explain the fix. */
function reportAndRestore(guarded: (typeof GUARDED)[number], after: Snapshot): void {
  const prior = before.get(guarded.path) ?? { existed: false, content: null, unreadable: false };
  const verb = prior.existed ? "wrote" : "CREATED";
  process.stderr.write(
    `\n\x1b[31m✗ ${guarded.label} MUTATED\x1b[0m — something in that command ${verb} ${guarded.path}\n`
  );
  for (const line of describeDelta(prior.content, after.content)) {
    process.stderr.write(`${line}\n`);
  }
  try {
    if (prior.existed && prior.content !== null) {
      writeFileSync(guarded.path, prior.content, "utf-8");
      process.stderr.write("\n  Restored it from the pre-run snapshot.\n");
    } else if (prior.existed && prior.unreadable) {
      // Presence was certain, the bytes were not. Writing anything here would
      // invent content; say so instead and leave the file for the developer.
      process.stderr.write(
        "\n  \x1b[31mCANNOT RESTORE\x1b[0m — the file existed before the run but could not be read,\n" +
          "  so there is no snapshot to put back. Its current contents are whatever the run left.\n"
      );
    } else {
      // Absent before, present after: the run CREATED a real file. Removing it is
      // the restore. Leaving it is worse than it looks — on a clean machine a
      // two-entry fixture becomes the catalog, and a cold cache and a poisoned
      // one are indistinguishable to every caller.
      rmSync(guarded.path, { force: true });
      process.stderr.write("\n  Removed it — no such file existed before the run.\n");
    }
  } catch (err) {
    process.stderr.write(
      `\n  \x1b[31mRESTORE FAILED\x1b[0m (${err instanceof Error ? err.message : String(err)}).\n` +
        `  A copy is at ${guarded.path}.guard-backup\n`
    );
  }
  process.stderr.write(
    `\n  Tests must ${guarded.remedy}.\n` +
      "  See scripts/guard-real-config.ts for the history.\n\n"
  );
}

child.on("exit", (code, signal) => {
  // Every guarded file is checked and restored before the first exit, so one
  // clobbered file cannot mask a second. Reporting only the first would send
  // the author to fix one test while another keeps rewriting the machine.
  let mutated = false;
  for (const g of GUARDED) {
    const prior = before.get(g.path) ?? { existed: false, content: null, unreadable: false };
    const after = snapshot(g.path);
    const changed =
      prior.existed !== after.existed || (prior.content ?? null) !== (after.content ?? null);
    if (!changed) continue;
    mutated = true;
    reportAndRestore(g, after);
  }

  if (mutated) process.exit(1);
  if (signal) {
    process.stderr.write(`\n[guard] command terminated by ${signal}; guarded files intact.\n`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});

child.on("error", (err) => {
  process.stderr.write(`[guard] failed to run command: ${err.message}\n`);
  process.exit(1);
});
