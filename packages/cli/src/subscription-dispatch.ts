/**
 * How `index.ts` routes `claudish subscription …`. Kept free of imports beyond
 * the version, so the decision and the last-resort probe line exist even when
 * `subscription-probe-command.ts` (keychain, token, network) will not load.
 */

import { VERSION } from "./version.js";

export const SUBSCRIPTION_PROBE_SCHEMA = "claudish.subscription-probe.v1" as const;

/**
 * Whether the argv that follows `subscription` belongs to the probe command:
 * its first positional, read the way the probe parser reads it (the value of
 * `--model` / `--request-file` is not a positional), is `probe`. Flags may
 * come first, so `argv[0]` alone would send `--json probe …` to the models
 * command.
 */
export function isSubscriptionProbeArgv(argv: readonly string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--model" || token === "--request-file") {
      if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("-")) i++;
    } else if (!token.startsWith("-")) {
      return token === "probe";
    }
  }
  return false;
}

/**
 * The probe's `internal_error` line when its module will not load: schema,
 * version, `tokenRefreshed: false`, the fixed failure. Same shape as
 * `reportProbeInternalError` prints, so one line on every exit holds.
 */
export function probeLoadFailureLine(): string {
  return `${JSON.stringify({
    schema: SUBSCRIPTION_PROBE_SCHEMA,
    claudishVersion: VERSION,
    tokenRefreshed: false,
    failure: { class: "internal", code: "internal_error" },
  })}\n`;
}
