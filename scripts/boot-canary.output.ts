/**
 * The spawn shapes the boot canary boots, and the files one run writes in its output directory:
 * `results.json` and one `<scenario>.screen.txt` per shape. The canary removes an earlier run's
 * files from its `--out` directory with this list. The macOS gate (`test-macos.ts`) removes
 * nothing: each of its runs gives the canary a new temp directory of its own.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";

export const SCENARIOS = [
  "boot",
  "agent",
  "badagent",
  "onboarding",
  "trust",
  "apikey",
  "bypass",
  "mcp",
  "settingserr",
  "nokey",
] as const;
export type Scenario = (typeof SCENARIOS)[number];

/** Removes what a canary run wrote in `dir`. Every other file there stays. */
export function removeCanaryOutput(dir: string): void {
  rmSync(join(dir, "results.json"), { force: true });
  for (const s of SCENARIOS) rmSync(join(dir, `${s}.screen.txt`), { force: true });
}
