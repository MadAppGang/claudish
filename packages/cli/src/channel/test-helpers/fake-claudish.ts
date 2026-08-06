#!/usr/bin/env bun
/**
 * Fake claudish binary for session-manager unit tests.
 *
 * Behavior is controlled via CLI flags:
 *   --sleep <seconds>   Sleep for N seconds then exit 0
 *   --fail              Exit immediately with code 1
 *   --lines <n>         Print N numbered lines then exit 0
 *   --print-argv        Print the received argv as JSON then exit 0
 *   --echo-stdin        Read stdin and echo it to stdout then exit 0
 *   (default)           Echo any stdin received to stdout then exit 0
 *
 * The script ignores all the real claudish flags (--model, -y, --stdin, --quiet)
 * so the SessionManager can use its normal spawn args.
 */

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
  // --print-argv: expose the exact spawn contract to parent-process tests
  if (hasFlag("--print-argv")) {
    process.stdout.write(`${JSON.stringify(args)}\n`);
    process.exit(0);
  }

  // --fail: exit immediately with error
  if (hasFlag("--fail")) {
    process.exit(1);
  }

  // --sleep <seconds>: sleep then exit 0
  const sleepVal = getFlag("--sleep");
  if (sleepVal !== null) {
    const ms = Number.parseFloat(sleepVal) * 1000;
    await new Promise((r) => setTimeout(r, ms));
    process.exit(0);
  }

  // --lines <n>: print N numbered lines then exit 0
  const linesVal = getFlag("--lines");
  if (linesVal !== null) {
    const n = Number.parseInt(linesVal, 10);
    for (let i = 1; i <= n; i++) {
      process.stdout.write(`line ${i}\n`);
    }
    process.exit(0);
  }

  // Default / --echo-stdin: read stdin, echo to stdout, exit 0
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
    process.stdout.write(chunk as Buffer);
  }
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
