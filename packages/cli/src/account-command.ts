/**
 * `claudish account …` — read-only status and explicit Codex management.
 *
 *   claudish account              status (default)
 *   claudish account list         configured accounts, per vendor
 *   claudish account status       usage, thresholds, blockers, diagnostics
 *     --json                      machine-readable, same facts
 *     --refresh                   re-read the account list and state, bypassing caches
 *
 * Codex add/login/remove/enable/disable delegate to transactional management.
 * Claude mutations, import and use remain unavailable; list/status never enroll.
 *
 * ## `--refresh` does not spend quota
 *
 * claudish never issues inference traffic to measure quota — the only free
 * reading is the one stamped on a real response's headers, so an idle account's
 * usage is genuinely `unknown` and `unknown` counts as ELIGIBLE. `--refresh`
 * therefore re-reads the account list and `state.json` past every cache and flushes
 * coalesced writes; it does not contact a vendor.
 *
 * ## A user with only the legacy file sees `codex default (legacy file)`
 *
 * With `~/.claudish/codex-oauth.json` present and no `subscriptionAccounts`, the
 * registry synthesizes that account IN MEMORY and this command shows it, with no
 * action required from the user and nothing written to their config.
 */

import type { CodexManagementCommand } from "./auth/accounts/management.js";
import { getAccountPool } from "./auth/accounts/pool.js";
import type { AccountDescription, PoolDescription } from "./auth/accounts/pool.js";
import { getAccountRegistry } from "./auth/accounts/registry.js";
import { getStateStore } from "./auth/accounts/state-store.js";
import {
  ACCOUNT_PROVIDERS,
  type AccountProvider,
  formatReset,
  isAccountsError,
} from "./auth/accounts/types.js";
import { cliAnsi } from "./theme/ansi.js";

// ---------------------------------------------------------------------------
// Output helpers — colours resolved at RENDER time
// ---------------------------------------------------------------------------

/**
 * Every one of these reads `cliAnsi()` per call rather than capturing it.
 * Theme detection runs AFTER module load, so a module-level `const` snapshots
 * the dark palette and renders invisible text on a light terminal.
 */
function ok(text: string): string {
  const c = cliAnsi();
  return `${c.GREEN}${text}${c.RESET}`;
}
function warn(text: string): string {
  const c = cliAnsi();
  return `${c.YELLOW}${text}${c.RESET}`;
}
function bad(text: string): string {
  const c = cliAnsi();
  return `${c.RED}${text}${c.RESET}`;
}
function dim(text: string): string {
  const c = cliAnsi();
  return `${c.GRAY}${text}${c.RESET}`;
}
function strong(text: string): string {
  const c = cliAnsi();
  return `${c.BOLD}${text}${c.RESET}`;
}

/** Vendor label as the user names it on a command line. */
function vendorOf(provider: AccountProvider): string {
  return provider === "openai-codex" ? "codex" : "claude";
}

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/** One window, e.g. `5h 41%` — reddened once it is past its threshold. */
function renderWindows(row: AccountDescription, pool: PoolDescription): string {
  const windows = row.state.usage?.windows ?? [];
  if (windows.length === 0) return dim("usage unknown");
  return windows
    .map((w) => {
      const threshold = pool.switchAtByWindow[w.slot] ?? pool.switchAt;
      const text = `${w.displayId} ${pct(w.usedFraction)}`;
      return w.usedFraction >= threshold ? warn(text) : text;
    })
    .join(" · ");
}

function renderRow(row: AccountDescription, pool: PoolDescription, now: number): string[] {
  const lines: string[] = [];
  const marker = row.isActive ? ok("●") : dim("○");
  const legacy = row.record.legacy ? dim(" (legacy file)") : "";
  const disabled = row.record.enabled ? "" : dim(" disabled");
  const plan = row.record.identity.plan ? dim(` ${row.record.identity.plan}`) : "";
  lines.push(
    `  ${marker} ${strong(row.record.label)}${legacy}${plan}${disabled}  ${renderWindows(row, pool)}` +
      (row.isActive ? dim("  active") : "")
  );

  if (row.stateFailed) {
    // "Could not read" is not "nothing is there", and the difference decides
    // whether this account is ranked last or treated as fresh.
    lines.push(`      ${warn("state unreadable — ranked last, never assumed fresh")}`);
  }
  if (row.blocker?.kind === "exhausted") {
    lines.push(
      `      ${warn(formatReset(row.blocker.resetAt, now, row.blocker.estimated === true))}`
    );
  }
  if (row.blocker?.kind === "needs-reauth") {
    lines.push(
      `      ${bad("needs login")}: run \`claudish account login ${vendorOf(row.ref.provider)} ${row.record.label}\``
    );
    if (row.state.needsReauth?.lastReason) {
      lines.push(`      ${dim(row.state.needsReauth.lastReason)}`);
    }
  }
  if (row.state.lastSeenAt) {
    const mins = Math.max(0, Math.round((now - row.state.lastSeenAt) / 60_000));
    lines.push(`      ${dim(`last seen ${mins} min ago · ${row.store}`)}`);
  } else {
    lines.push(`      ${dim(`never contacted · ${row.store}`)}`);
  }
  return lines;
}

/** Account-list source health. The command must be able to SAY "could not read". */
function renderSources(pool: PoolDescription): string[] {
  const lines: string[] = [];
  for (const [name, status] of Object.entries(pool.sources)) {
    if (status.state !== "failed") continue;
    lines.push(
      `  ${bad(`could not read the ${name} account list`)}: ${status.error ?? "unknown error"}`
    );
    lines.push(
      `      ${dim(
        status.servingLastKnownGood
          ? "serving the last known-good account list — an unreadable account list is never read as an empty one"
          : "no last known-good account list in this process; requests will fail rather than sign a metered key"
      )}`
    );
  }
  for (const drop of pool.dropped) {
    lines.push(`  ${warn(`state not persisted — ${drop.field} for ${drop.account}`)}`);
    lines.push(`      ${dim(drop.reason)}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

interface ProviderReport {
  provider: AccountProvider;
  pool: PoolDescription | null;
  /** Set when the account list could not be read at all. */
  error?: string;
}

function collect(): ProviderReport[] {
  return ACCOUNT_PROVIDERS.map((provider) => {
    try {
      return { provider, pool: getAccountPool(provider).describe() };
    } catch (err) {
      // An account list that could not be READ is reported as such. Printing "0
      // accounts" here would be the same lie the registry refuses to tell.
      return {
        provider,
        pool: null,
        error: isAccountsError(err) || err instanceof Error ? err.message : String(err),
      };
    }
  });
}

function printHuman(reports: ProviderReport[], detailed: boolean): void {
  const now = Date.now();
  let any = false;

  for (const report of reports) {
    if (report.error) {
      console.log(`\n${strong(vendorOf(report.provider))}`);
      console.log(`  ${bad(report.error)}`);
      any = true;
      continue;
    }
    const pool = report.pool;
    if (!pool || pool.accounts.length === 0) continue;
    any = true;

    console.log(`\n${strong(vendorOf(report.provider))}`);
    if (!pool.poolEnabled) {
      console.log(`  ${warn("pool disabled in config — no account is selectable")}`);
    }
    for (const row of pool.accounts) {
      for (const line of renderRow(row, pool, now)) console.log(line);
    }
    if (detailed) {
      const perWindow = Object.entries(pool.switchAtByWindow)
        .map(([slot, value]) => `${slot} ${pct(value)}`)
        .join(", ");
      console.log(
        `  ${dim(`switch at ${pct(pool.switchAt)}${perWindow ? ` (per window: ${perWindow})` : ""}`)}`
      );
      for (const line of renderSources(pool)) console.log(line);
    }
  }

  if (!any) {
    console.log("\nNo subscription accounts are configured.");
    console.log(
      dim(
        "A Codex login (`claudish login codex`) is shown here as `default (legacy file)` " +
          "once it exists; multi-account commands arrive with the pool."
      )
    );
  }
  console.log("");
}

function toJson(reports: ProviderReport[]): unknown {
  return {
    providers: reports.map((report) => ({
      provider: report.provider,
      ...(report.error ? { error: report.error } : {}),
      ...(report.pool
        ? {
            poolEnabled: report.pool.poolEnabled,
            switchAt: report.pool.switchAt,
            switchAtByWindow: report.pool.switchAtByWindow,
            sources: report.pool.sources,
            dropped: report.pool.dropped,
            accounts: report.pool.accounts.map((row) => ({
              id: row.ref.id,
              label: row.record.label,
              legacy: row.record.legacy,
              enabled: row.record.enabled,
              store: row.store,
              active: row.isActive,
              stateUnreadable: row.stateFailed,
              pressure: row.pressure,
              windows: row.state.usage?.windows ?? [],
              observedAt: row.state.usage?.observedAt ?? null,
              exhaustedUntil: row.state.exhaustedUntil ?? null,
              needsReauth: row.state.needsReauth ?? null,
              blocker: row.blocker?.kind ?? null,
              // Identity only — never token material, and no key tails either:
              // a token has no user-facing "which one is this" problem that a
              // label does not already solve.
              identity: row.record.identity,
            })),
          }
        : {}),
    })),
  };
}

export const ACCOUNT_HELP = `Usage:
  claudish account [list|status] [--json] [--refresh]
  claudish account add codex [--label <label>]
  claudish account login|enable|disable codex <label> [--id <generated-id>]
  claudish account remove codex <label> [--id <generated-id>] [--yes] [--delete-file]

--id <generated-id> may replace or confirm the label; labels are unique per claudish provider.
Removing the legacy login (default, legacy-codex-file) requires --delete-file.
New accounts use the macOS Keychain, or protected plaintext files where there is none.
Add only accounts you own; vendor terms may restrict switching between subscriptions.
With Codex accounts configured, use account add/login instead of \`claudish login codex\`.
Claude account mutations, import and use are not available. No token input or export.`;

const MUTATION_VERBS = ["add", "login", "enable", "disable", "remove"] as const;
type MutationVerb = (typeof MUTATION_VERBS)[number];

function usage(problem: string): Error {
  return new Error(`${problem}\n\n${ACCOUNT_HELP}`);
}

/**
 * Strict: every malformed, extra or unknown argument is refused here, before a
 * prompt, a browser, a lock or a store is touched.
 */
export function parseAccountMutation(args: string[]): CodexManagementCommand {
  const [verb, provider, ...rest] = args;
  if (verb === "use" || verb === "import") {
    throw usage(`\`claudish account ${verb}\` is not available in this build.`);
  }
  if (!(MUTATION_VERBS as readonly string[]).includes(verb)) {
    throw usage(`Unknown account subcommand: ${verb}`);
  }
  if (provider !== "codex") {
    throw usage(
      provider === "claude"
        ? "Claude account mutations are not available in this build."
        : `account ${verb} takes the claudish provider \`codex\`${provider ? `, not ${provider}` : ""}.`
    );
  }
  const v = verb as MutationVerb;
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--label" || arg === "--id") {
      if ((arg === "--label") !== (v === "add"))
        throw usage(`${arg} does not apply to account ${v}.`);
      const value = rest[++i];
      if (values.has(arg) || value === undefined || value.startsWith("-")) {
        throw usage(`${arg} needs exactly one value.`);
      }
      values.set(arg, value);
    } else if (arg === "--yes" || arg === "--delete-file") {
      if (v !== "remove") throw usage(`${arg} applies only to account remove.`);
      if (flags.has(arg)) throw usage(`${arg} was given twice.`);
      flags.add(arg);
    } else if (arg.startsWith("-")) {
      throw usage(`Unknown account flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (v === "add") {
    if (positional.length > 0)
      throw usage("account add codex takes no positional argument; use --label.");
    return { verb: v, label: values.get("--label") };
  }
  if (positional.length > 1) throw usage(`account ${v} codex names one account.`);
  if (positional.length === 0 && !values.has("--id")) {
    throw usage(`account ${v} codex needs a label or --id <generated-id>.`);
  }
  const target = { label: positional[0], id: values.get("--id") };
  if (v === "remove") {
    return { verb: v, ...target, yes: flags.has("--yes"), deleteFile: flags.has("--delete-file") };
  }
  return { verb: v, ...target };
}

/** `claudish account [list|status] [--json] [--refresh]`, or one explicit Codex mutation. */
export async function accountCommand(args: string[]): Promise<void> {
  const sub = args.find((a) => !a.startsWith("-")) ?? "status";
  if (sub === "status" && (args.includes("--help") || args.includes("-h"))) {
    console.log(ACCOUNT_HELP);
    return;
  }

  if (sub !== "list" && sub !== "status") {
    // Mutations parse strictly from their own position; views keep their old leniency.
    if (args[0] !== sub) throw usage("Put flags after `account <verb> codex`.");
    const command = parseAccountMutation(args);
    const { CodexAccountManagement } = await import("./auth/accounts/management.js");
    for (const line of await new CodexAccountManagement().run(command)) console.log(line);
    return;
  }

  const json = args.includes("--json");
  const refresh = args.includes("--refresh");

  if (refresh) {
    // Re-read past every cache, and flush anything this process coalesced.
    // NOT a vendor call: claudish never spends quota to measure quota.
    getAccountRegistry().invalidate();
    const state = getStateStore();
    await state.flush();
    state.read(true);
  }

  const reports = collect();
  if (json) {
    console.log(JSON.stringify(toJson(reports), null, 2));
    return;
  }
  printHuman(reports, sub === "status");
}
