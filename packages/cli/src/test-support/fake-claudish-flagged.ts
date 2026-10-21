/**
 * Fake claudish for team-timeout-repro tests, compilable to a standalone exe
 * (#533 route: `bun build --compile` via test-support/compile-fake.ts).
 *
 * Behavior is controlled by CLI flags, in priority order:
 *   --fail                     exit 1 immediately
 *   --sleep <seconds>          sleep N s, exit 0
 *   --lines <n>                print "line 1" … "line N", exit 0
 *   --delay-ms-sidecar         delay = integer ms from `delay-ms.txt` next to
 *                              the exe (process.execPath dir) — how per-dir
 *                              variants are produced from a single compile
 *   --bytes <n>                write exactly n 'A' bytes (no newline), exit 0
 *   (default)                  read stdin, echo to stdout, exit 0
 *
 * Model-differentiated delays (team-timeout-repro "mixed" REPRO): when the
 * sidecar file exists AND `--model slow-model` is passed, the delay is
 * max(sidecarMs, 10000). Other models take the sidecar value.
 *
 * Unknown flags (the real spawn args --model/-y/--stdin/--quiet) are ignored.
 * A compiled exe is what this file is FOR under win32: spawn resolves it
 * natively, so kill/timeout semantics reach the process itself instead of a
 * cmd.exe wrapper whose grandchild can survive (#533).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);

function getFlag(name: string): string | null {
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  return args[idx + 1] ?? null;
}

function hasFlag(name: string): boolean {
  return args.includes(name);
}

async function main() {
  if (hasFlag("--fail")) {
    process.exit(1);
  }

  const sleepVal = getFlag("--sleep");
  if (sleepVal !== null) {
    await new Promise((r) => setTimeout(r, Number.parseFloat(sleepVal) * 1000));
    process.exit(0);
  }

  const linesVal = getFlag("--lines");
  if (linesVal !== null) {
    const n = Number.parseInt(linesVal, 10);
    for (let i = 1; i <= n; i++) {
      process.stdout.write(`line ${i}\n`);
    }
    process.exit(0);
  }

  const bytesVal = getFlag("--bytes");
  if (bytesVal !== null) {
    // Byte-counter REPRO (#team-timeout): exact stdout size, no newline —
    // mirrors `dd bs=1024 count=64 | tr '\0' 'A'` from the POSIX bash fake.
    for await (const _ of process.stdin) {
      // discard
    }
    const n = Number.parseInt(bytesVal, 10);
    process.stdout.write("A".repeat(n));
    process.exit(0);
  }

  if (hasFlag("--delay-ms-sidecar")) {
    const sidecar = join(dirname(process.execPath), "delay-ms.txt");
    let delayMs = 50;
    if (existsSync(sidecar)) {
      delayMs = Number.parseInt(readFileSync(sidecar, "utf-8").trim(), 10) || 50;
    }
    if (getFlag("--model") === "slow-model") {
      delayMs = Math.max(delayMs, 10_000);
    }
    // Drain stdin like the real fake (the orchestrator pipes the input in)
    for await (const _ of process.stdin) {
      // discard
    }
    await new Promise((r) => setTimeout(r, delayMs));
    const model = getFlag("--model") ?? "claudish";
    process.stdout.write(`Response from ${model} — complete analysis.\n`);
    process.stdout.write("The model has finished its work successfully.\n");
    process.exit(0);
  }

  // Default: echo stdin
  for await (const chunk of process.stdin) {
    process.stdout.write(chunk as Buffer);
  }
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
