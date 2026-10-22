import { constants, closeSync, fchmodSync, openSync, writeSync } from "node:fs";
import {
  type CodexUsageLimit,
  resolveUsageLimitResetAt,
} from "../../handlers/shared/codex-usage-limit.js";
import { log } from "../../logger.js";
import { type AccountPool, getAccountPool } from "./pool.js";
import type { AccountOutcome, AccountRef, UsageSnapshot } from "./types.js";

interface FoldedOutcome {
  outcome: AccountOutcome;
  usage?: UsageSnapshot;
  observedAt: number;
  delivered?: string;
  pending: boolean;
}

/** Owned by one inbound request, never the handler or transport instance. */
export type AccountOutcomeFold = Map<string, FoldedOutcome>;

export interface AccountOutcomeReport {
  requestId: string;
  account: AccountRef;
  outcome: AccountOutcome;
  usage?: UsageSnapshot;
  observedAt?: number;
  reason?: string;
}

/** Opt-in, allowlisted metadata only. Logging can never change routing. */
function appendOutcome(report: AccountOutcomeReport, pool: AccountPool): void {
  const path = process.env.CLAUDISH_ACCOUNTS_LOG;
  if (!path) return;
  let fd: number | undefined;
  try {
    const state = pool.observationState(report.account);
    const row = {
      requestId: report.requestId,
      provider: report.account.provider,
      accountId: report.account.id,
      label: report.account.label,
      reason: report.reason,
      outcome: report.outcome.kind,
      resetAt: report.outcome.kind === "quota" ? state.exhaustedUntil : undefined,
      estimated: report.outcome.kind === "quota" ? state.exhaustedEstimated : undefined,
      arm: "oauth",
    };
    fd = openSync(
      path,
      constants.O_CREAT |
        constants.O_APPEND |
        constants.O_WRONLY |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600
    );
    fchmodSync(fd, 0o600);
    writeSync(fd, `${JSON.stringify(row)}\n`);
  } catch {
    try {
      log("[accounts] outcome log could not be appended");
    } catch {
      /* non-fatal */
    }
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* non-fatal */
      }
    }
  }
}

/** Body reset, then a full header window; estimates are counted under state.lock. */
export function codexQuotaOutcome(
  limit: CodexUsageLimit | null,
  usage?: UsageSnapshot,
  now: number = Date.now()
): Extract<AccountOutcome, { kind: "quota" }> {
  const bodyReset = limit ? resolveUsageLimitResetAt(limit, now) : undefined;
  const headerResets = (usage?.windows ?? []).flatMap((window) =>
    window.usedFraction >= 1 && Number.isFinite(window.resetAt) && (window.resetAt ?? 0) > now
      ? [window.resetAt as number]
      : []
  );
  const resetAt =
    bodyReset !== undefined && Number.isFinite(bodyReset) && bodyReset > now
      ? bodyReset
      : headerResets.length > 0
        ? Math.min(...headerResets)
        : undefined;
  return {
    kind: "quota",
    resetAt: resetAt ?? now + 15 * 60_000,
    estimated: resetAt === undefined,
    usage,
  };
}

function mergeOutcome(previous: AccountOutcome | undefined, next: AccountOutcome): AccountOutcome {
  if (previous?.kind !== "quota") return next;
  if (next.kind !== "quota") return previous;
  if (next.estimated && !previous.estimated) return previous;
  if (previous.estimated && !next.estimated) return next;
  return { ...next, resetAt: Math.max(previous.resetAt, next.resetAt) };
}

/**
 * Upgrade, never first-seen suppression. A quota overlay is installed by report
 * before its first await; failed publication stays pending for a later observation.
 */
export async function reportAccountOutcome(
  report: AccountOutcomeReport,
  fold: AccountOutcomeFold,
  pool?: AccountPool
): Promise<void> {
  const key = `${report.requestId}:${report.account.provider}:${report.account.id}`;
  const previous = fold.get(key);
  const usage = report.usage ?? ("usage" in report.outcome ? report.outcome.usage : undefined);
  const newest =
    previous?.usage && (!usage || previous.usage.observedAt > usage.observedAt)
      ? previous.usage
      : usage;
  const outcome = mergeOutcome(previous?.outcome, report.outcome);
  const entry: FoldedOutcome = {
    outcome,
    usage: newest,
    observedAt:
      outcome.kind === "quota" && previous?.outcome.kind === "quota"
        ? previous.observedAt
        : (report.observedAt ?? Date.now()),
    delivered: previous?.delivered,
    pending: true,
  };
  fold.set(key, entry);
  const signature = JSON.stringify({ outcome, usage: newest });
  if (previous?.delivered === signature && !previous.pending) {
    entry.pending = false;
    return;
  }
  let reporter = pool;
  try {
    reporter ??= getAccountPool(report.account.provider);
    const context = { requestId: report.requestId, observedAt: entry.observedAt };
    const observedOutcome: AccountOutcome =
      outcome.kind === "quota" || outcome.kind === "ok"
        ? { ...outcome, usage: newest }
        : outcome.kind === "usage" && newest
          ? { kind: "usage", usage: newest }
          : outcome;
    // Staging is synchronous and precedes even an unexpected report() exception.
    reporter.stageOutcome(report.account, observedOutcome, context);
    if (newest && !("usage" in observedOutcome)) {
      const usageOutcome: AccountOutcome = { kind: "usage", usage: newest };
      reporter.stageOutcome(report.account, usageOutcome, context);
      await reporter.report(report.account, usageOutcome, context);
    }
    await reporter.report(report.account, observedOutcome, context);
    entry.pending = false;
    entry.delivered = signature;
    appendOutcome({ ...report, outcome }, reporter);
  } catch {
    // Keep the fold and the StateStore overlay intact, including when logging fails.
    try {
      reporter?.noteOutcomeFailure(report.account);
      log(`[accounts] outcome pending for ${report.account.id}`);
    } catch {
      /* non-fatal */
    }
  }
}
