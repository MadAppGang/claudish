/**
 * Quota/usage subcommand for subscription providers.
 *
 * Usage:
 *   claudish quota [provider]   - Show plan usage for a provider
 *   claudish usage [provider]   - Alias for quota
 *
 * All provider knowledge lives in the `auth/quota` registry — this module only
 * resolves what the user typed and renders what the adapter returns.
 *
 * ## What changed, and why
 *
 * The previous version kept its own `QUOTA_ADAPTERS` table where each entry was
 * a `handler: () => Promise<void>` that printed and then called `process.exit()`.
 * Two things followed from that:
 *
 * 1. There was no seam to get structured data out, so the same numbers could not
 *    also be published to a status line. That is the whole of MTL-76 §2.
 * 2. Window labels were hardcoded. Codex's two slots were rendered as
 *    "5h window" and "Weekly" — but Codex reports each slot's DURATION in
 *    `x-codex-*-window-minutes`, and on a real Pro account the primary slot is
 *    the WEEKLY window (10080 minutes) while the secondary is unused (0). So the
 *    old output mislabelled one bar and invented a second. Durations are now
 *    read, never assumed.
 *
 * Providers proven to expose no usage surface are registered too, so this
 * command answers "not supported" with a date rather than "Unknown provider",
 * which reads as a typo.
 */

import { getShortcuts } from "../providers/provider-definitions.js";
import type { QuotaAdapter } from "./quota/adapter.js";
import { allQuotaAdapters, resolveQuotaAdapter } from "./quota/registry.js";
import type { PlanUsage, ProbeRecord } from "./quota/types.js";

// ANSI
const R = "\x1b[0m";
const B = "\x1b[1m";
const D = "\x1b[2m";
const I = "\x1b[3m";
const RED = "\x1b[31m";
const GRN = "\x1b[32m";
const YEL = "\x1b[33m";
const CYN = "\x1b[36m";
const WHT = "\x1b[37m";
const GRY = "\x1b[90m";

const W = 58;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function quotaCommand(provider?: string): Promise<void> {
  const adapter = provider ? resolveAdapterFromInput(provider) : await promptForAdapter();

  if (!adapter) {
    printUnknownProvider(provider ?? "");
    process.exit(1);
  }

  const capability = adapter.capability();

  if (capability.kind === "none") {
    printUnsupported(adapter, capability.evidence);
    return;
  }
  if (capability.kind === "unknown") {
    console.log(`\n  ${WHT}${adapter.label}${R} — usage support has not been researched yet.\n`);
    return;
  }

  if (!adapter.isAvailable()) {
    console.error(`${RED}Not logged in for ${adapter.label}.${R} Run: ${B}claudish login${R}\n`);
    process.exit(1);
  }

  // The explicit path may spend quota where a provider has no cheaper reading
  // (Codex); `poll` is the free one. Prefer whichever the adapter offers.
  const fetch = adapter.fetchExplicit ?? adapter.poll;
  if (!fetch) {
    console.log(`\n  ${WHT}${adapter.label}${R} — no way to read usage.\n`);
    return;
  }

  let plan: PlanUsage | undefined;
  try {
    plan = await fetch.call(adapter);
  } catch (err: any) {
    console.error(`\n  ${RED}Failed to fetch usage:${R} ${err?.message ?? err}\n`);
    process.exit(1);
  }

  if (!plan || plan.windows.length === 0) {
    console.log(`\n  ${D}No usage data returned for ${adapter.label}.${R}\n`);
    return;
  }

  renderPlan(adapter, plan);
}

/**
 * Resolve what the user typed to an adapter.
 *
 * Accepts the canonical provider id ("openai-codex") and every routing shortcut
 * ("cx", "codex", "ag"), because `getShortcuts()` already maps aliases onto
 * canonical ids. Reusing it means there is no second alias list to drift.
 */
function resolveAdapterFromInput(input: string): QuotaAdapter | undefined {
  const raw = input.toLowerCase().replace(/@+$/, "");

  const direct = resolveQuotaAdapter(raw);
  if (direct) return direct;

  // Friendly names first. `getShortcuts()` covers ROUTING prefixes, which is not
  // the same vocabulary users type at this command: "gpt"/"chatgpt"/"openai" are
  // not routing shortcuts at all, and "gemini" routes to the direct-API provider
  // (which has no quota adapter) rather than to the subscription one. All of
  // these worked before this command was rewritten, so they are kept working.
  const friendly = FRIENDLY_NAMES[raw];
  if (friendly) {
    const viaFriendly = resolveQuotaAdapter(friendly);
    if (viaFriendly) return viaFriendly;
  }

  const canonical = getShortcuts()[raw];
  if (canonical) {
    const viaShortcut = resolveQuotaAdapter(canonical);
    if (viaShortcut) return viaShortcut;
  }
  return undefined;
}

/**
 * User-facing names → canonical provider id.
 *
 * Deliberately separate from `getShortcuts()`: that table answers "which
 * provider does this @-prefix route to", a different question from "which
 * subscription does the user mean". `gemini` is the clearest divergence — as a
 * routing prefix it means the pay-per-use direct API, but someone typing
 * `claudish quota gemini` is asking about their subscription.
 */
const FRIENDLY_NAMES: Record<string, string> = {
  gpt: "openai-codex",
  chatgpt: "openai-codex",
  openai: "openai-codex",
  gemini: "antigravity",
  google: "antigravity",
  glm: "glm-coding",
  zai: "glm-coding",
  kimi: "kimi-coding",
  moonshot: "kimi-coding",
  minimax: "minimax-coding",
  sakana: "sakana-subscription",
  fugu: "sakana-subscription",
  zen: "opencode-zen-go",
  qwen: "qwen-cloud",
};

async function promptForAdapter(): Promise<QuotaAdapter | undefined> {
  const { select } = await import("@inquirer/prompts");
  const choices = allQuotaAdapters().map((a) => {
    const kind = a.capability().kind;
    const status =
      kind === "none"
        ? `${GRY}not supported${R}`
        : a.isAvailable()
          ? `${GRN}logged in${R}`
          : `${GRY}not logged in${R}`;
    return { name: `${a.label} — ${status}`, value: a };
  });
  return select({ message: "Select provider:", choices });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderPlan(adapter: QuotaAdapter, plan: PlanUsage): void {
  console.log("");
  boxTop(plan.label);
  boxRow("Provider", adapter.providerId);
  boxRow("Windows", String(plan.windows.length));
  boxBottom();

  // Peak, not average: the window nearest its limit is the one that will stop
  // the user working, and averaging hides it.
  const peak = plan.windows.reduce((m, w) => Math.max(m, w.used_pct), 0);
  const peakColor = colorFor(peak);
  console.log("");
  console.log(
    `  ${peakColor}${B}${peak}%${R} ${D}peak usage across ${plan.windows.length} window${plan.windows.length === 1 ? "" : "s"}${R}`
  );
  console.log("");

  for (const w of plan.windows) {
    const color = colorFor(w.used_pct);
    const bar = buildUsageBar(w.used_pct / 100, color, 24);
    const reset = w.resets_at ? formatRelativeReset(w.resets_at) : "";
    const name = w.id.length > 14 ? `${w.id.slice(0, 13)}…` : w.id;
    console.log(
      `  ${GRY}│${R} ${WHT}${name.padEnd(14)}${R}${bar}  ${color}${String(w.used_pct).padStart(3)}%${R}  ${GRY}${I}${reset}${R}`
    );
  }

  console.log("");
  console.log(
    `  ${GRN}█${R}${GRY} <50%${R}   ${YEL}█${R}${GRY} 50-80%${R}   ${RED}█${R}${GRY} >80%${R}   ${D}░ available${R}`
  );
  console.log("");
}

/**
 * Report a provider that has been researched and has nothing to report.
 *
 * Prints the date and the recheck condition, because the useful question about
 * a negative result is not "is it absent" but "how old is this verdict".
 */
function printUnsupported(adapter: QuotaAdapter, evidence: ProbeRecord): void {
  console.log("");
  console.log(`  ${WHT}${B}${adapter.label}${R} ${D}— usage reporting not supported${R}`);
  console.log("");
  console.log(`  ${GRY}This provider exposes no usage endpoint and returns no rate-limit${R}`);
  console.log(`  ${GRY}headers, so there is nothing for claudish to report.${R}`);
  console.log("");
  console.log(`  ${D}Probed ${evidence.researched_at}:${R}`);
  for (const p of evidence.probed) {
    console.log(`    ${GRY}· ${p.what}${R}`);
    console.log(`      ${D}→ ${p.result}${R}`);
  }
  if (evidence.recheck_if) {
    console.log("");
    console.log(`  ${D}Re-check if: ${evidence.recheck_if}${R}`);
  }
  console.log("");
}

function printUnknownProvider(input: string): void {
  const known = allQuotaAdapters().map((a) => a.providerId);
  console.error(`Unknown provider: ${input}`);
  console.error(`Available: ${known.join(", ")}`);
}

// ---------------------------------------------------------------------------
// Box + bar helpers
// ---------------------------------------------------------------------------

function boxTop(title: string): void {
  console.log(`  ${CYN}╭${"─".repeat(W)}╮${R}`);
  const t = title.length > W - 2 ? title.slice(0, W - 3) : title;
  console.log(
    `  ${CYN}│${R} ${B}${WHT}${t}${R}${" ".repeat(Math.max(0, W - 1 - t.length))}${CYN}│${R}`
  );
  console.log(`  ${CYN}├${"─".repeat(W)}┤${R}`);
}

function boxRow(label: string, value: string): void {
  const paddedLabel = label.padEnd(9);
  const visLen = paddedLabel.length + value.length;
  console.log(
    `  ${CYN}│${R} ${GRY}${paddedLabel}${R}${WHT}${value}${R}${" ".repeat(Math.max(0, W - 1 - visLen))}${CYN}│${R}`
  );
}

function boxBottom(): void {
  console.log(`  ${CYN}╰${"─".repeat(W)}╯${R}`);
}

function colorFor(usedPct: number): string {
  return usedPct < 50 ? GRN : usedPct < 80 ? YEL : RED;
}

export function buildUsageBar(usedFraction: number, color: string, width = 24): string {
  const clamped = Math.max(0, Math.min(1, usedFraction));
  const usedCols =
    clamped >= 1 ? width : Math.max(clamped > 0.005 ? 1 : 0, Math.round(clamped * width));
  const freeCols = width - usedCols;
  const usedPart = usedCols > 0 ? `${color}${"█".repeat(usedCols)}${R}` : "";
  const freePart = freeCols > 0 ? `${D}${"░".repeat(freeCols)}${R}` : "";
  return usedPart + freePart;
}

export function formatRelativeReset(resetTime: string): string {
  const resetAt = new Date(resetTime).getTime();
  if (Number.isNaN(resetAt)) return "";
  const diffMs = resetAt - Date.now();
  if (diffMs <= 0) return "resets now";
  const totalMinutes = Math.ceil(diffMs / (1000 * 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `resets ${hours}h ${minutes}m`;
  if (hours > 0) return `resets ${hours}h`;
  return `resets ${minutes}m`;
}
