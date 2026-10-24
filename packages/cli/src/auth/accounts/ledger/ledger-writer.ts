/**
 * The usage ledger's writer (allowance architecture §2.1): a synchronous,
 * bounded enqueue on the response path and an asynchronous append off it.
 *
 * ## Never throws, never awaits on the response path
 *
 * `appendUsageRow` validates and enqueues, then schedules a drain on
 * `setImmediate`. Every failure (an unwritable directory, a full disk, a
 * symlinked segment) is logged with `log()` and the row is dropped: a usage
 * ledger that could fail a turn would be worse than one with a hole in it.
 *
 * ## Appends are atomic per row
 *
 * Several claudish processes append to the same day's segment. Each row is ONE
 * `write()` of at most 4 KB to a descriptor opened `O_APPEND`, so two
 * processes' rows never interleave inside a line. The segment is opened
 * `O_NOFOLLOW` and then `fchmod 0600`, as `outcomes.ts:appendOutcome` does.
 *
 * ## Compaction, and why there is no index
 *
 * At most once per process per UTC day, under a try-lock (`compact.lock`,
 * never waited on), each closed day (older than yesterday) without an hourly
 * file is rolled up and published by ONE atomic rename. Raw days older than
 * {@link RAW_RETENTION_DAYS} are unlinked only once their hourly file exists;
 * hourly files go after {@link ROLLUP_RETENTION_DAYS}. The reader ignores a raw
 * segment whose hourly file exists, and that single rule covers every crash
 * point: killed after the rename and before the unlink, the hourly file wins
 * (no double count); killed before the rename, raw is still read.
 *
 * ## The hourly file
 *
 * One `rollup` row per (hour, provider, account, session, model) with summed
 * tokens and the first and last reading of each window, then the day's
 * `no-eligible` rows verbatim. `censoredMinutes` on a rollup is its hour's
 * pool-wide censored time for that provider, computed here from exact row
 * times (a `no-eligible` row opens an interval, the provider's next `ok`
 * response closes it, the day's end closes one still open), and it is the SAME
 * value on every rollup of that hour: take it once per hour, never sum it. The
 * verbatim `no-eligible` rows are what make a censored hour with no response at
 * all visible to a reader.
 */

import { constants, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import { log } from "../../../logger.js";
import { atomicWriteFileSync } from "../atomic-write.js";
import { FileLockUnavailableError, acquireFileLockSync } from "../file-lock.js";
import {
  usageCompactLockPath,
  usageHourlyDir,
  usageHourlyPath,
  usageRawDir,
  usageRawPath,
} from "../paths.js";
import {
  LEDGER_ROW_VERSION,
  type LedgerRow,
  type NoEligibleRow,
  type ResponseRow,
  type RollupRow,
  dayStart,
  parseRow,
  serializeRow,
  utcDay,
} from "./ledger-row.js";

/** The queue's bound; beyond it the OLDEST row is dropped and counted. */
export const LEDGER_QUEUE_MAX = 1024;
/** A raw day over this stops appending for that day, logged once. */
export const RAW_DAY_MAX_BYTES = 64 * 1024 * 1024;
/** Owner decision: 30 days of raw rows. */
export const RAW_RETENTION_DAYS = 30;
export const ROLLUP_RETENTION_DAYS = 180;
/** A compaction lock older than this belongs to a dead holder. */
const COMPACT_LOCK_STALE_MS = 10 * 60_000;
/** The drain only ARMS compaction; it runs this long after, on an unref'd timer. */
const COMPACT_DEFER_MS = 60_000;
/** A compaction that found requests in flight, or a day it could not read, retries after this. */
const COMPACT_RETRY_MS = 60_000;
const COMPACT_FAILED_RETRY_MS = 60 * 60_000;
/** Lines parsed (and rows grouped) per `setImmediate` slice of an async compaction. */
const COMPACT_SLICE_ROWS = 2_000;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

/**
 * `CLAUDISH_ALLOWANCE_LEDGER=off` writes nothing. Read at call time.
 *
 * Under `bun test` (`NODE_ENV=test`) the ledger is written only when
 * `CLAUDISH_ACCOUNTS_DIR` points somewhere: a suite that drives a pooled Codex
 * request or an exhausted pool without pinning the accounts directory would
 * otherwise append test rows to the developer's real ledger, which no restore
 * can tell apart from real usage. Every test that writes a ledger pins the
 * directory (Bun ignores an in-process `HOME`), so this costs those tests
 * nothing. `guard-real-config.ts` is the backstop.
 */
export function ledgerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CLAUDISH_ALLOWANCE_LEDGER?.trim().toLowerCase() === "off") return false;
  if (env.NODE_ENV === "test" && !env.CLAUDISH_ACCOUNTS_DIR) return false;
  return true;
}

interface Queued {
  line: string;
  day: string;
  env: NodeJS.ProcessEnv;
}

const queue: Queued[] = [];
let dropped = 0;
let draining: Promise<void> | null = null;
let scheduled = false;
/** Days this process found over the size cap; logged once each. */
const fullDays = new Set<string>();
/** The UTC day this process last compacted. */
let compactedDay: string | null = null;
let compactTimer: ReturnType<typeof setTimeout> | null = null;
/** True while no request is in flight; set by the allowance service. Absent = always idle. */
let idleProbe: (() => boolean) | null = null;

/**
 * Register the "no request in flight" check compaction waits on (§2.4): a
 * compaction never starts, nor moves to its next day, while a request runs.
 */
export function setLedgerIdleProbe(probe: (() => boolean) | null): void {
  idleProbe = probe;
}

function isIdle(): boolean {
  try {
    return idleProbe === null || idleProbe();
  } catch {
    return true;
  }
}

function safeLog(message: string): void {
  try {
    log(message);
  } catch {
    /* non-fatal */
  }
}

/**
 * Enqueue one row. Synchronous, bounded, never throws. The append happens on
 * `setImmediate`, after the caller has returned.
 */
export function appendUsageRow(row: LedgerRow, env: NodeJS.ProcessEnv = process.env): void {
  try {
    if (!ledgerEnabled(env)) return;
    const line = serializeRow(row);
    if (line === null) {
      safeLog("[ledger] row over 4 KB dropped");
      return;
    }
    const at = row.kind === "rollup" ? row.hour : row.at;
    queue.push({ line, day: utcDay(at), env });
    while (queue.length > LEDGER_QUEUE_MAX) {
      queue.shift();
      dropped++;
    }
    scheduleDrain();
  } catch {
    safeLog("[ledger] row could not be enqueued");
  }
}

function scheduleDrain(): void {
  if (scheduled || draining) return;
  scheduled = true;
  setImmediate(() => {
    scheduled = false;
    draining = drain()
      .catch(() => safeLog("[ledger] drain failed"))
      .finally(() => {
        draining = null;
        if (queue.length > 0) scheduleDrain();
      });
  });
}

/** Resolves once every row enqueued so far has been written or dropped. For shutdown and tests. */
export async function flushUsageLedger(): Promise<void> {
  for (let i = 0; i < 64 && (queue.length > 0 || draining || scheduled); i++) {
    if (draining) await draining;
    else if (queue.length > 0) {
      draining = drain().finally(() => {
        draining = null;
      });
      await draining;
    } else await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function drain(): Promise<void> {
  if (dropped > 0) {
    safeLog(`[ledger] queue full: ${dropped} oldest row(s) dropped`);
    dropped = 0;
  }
  const batch = queue.splice(0, queue.length);
  const groups = new Map<string, Queued[]>();
  for (const item of batch) {
    const key = `${item.day}\u0000${item.env.CLAUDISH_ACCOUNTS_DIR ?? ""}\u0000${item.env.HOME ?? ""}`;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  for (const group of groups.values()) {
    const first = group[0];
    if (!first) continue;
    await appendToSegment(first.day, first.env, group);
    maybeCompact(first.env);
  }
}

async function appendToSegment(day: string, env: NodeJS.ProcessEnv, rows: Queued[]): Promise<void> {
  const path = usageRawPath(day, env);
  if (fullDays.has(path)) return;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await mkdir(usageRawDir(env), { recursive: true, mode: 0o700 });
    handle = await open(
      path,
      constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600
    );
    await handle.chmod(0o600);
    let size = (await handle.stat()).size;
    for (const row of rows) {
      if (size >= RAW_DAY_MAX_BYTES) {
        fullDays.add(path);
        safeLog(
          `[ledger] ${day} is over ${RAW_DAY_MAX_BYTES} bytes; appending stopped for that day`
        );
        return;
      }
      const bytes = Buffer.from(row.line, "utf8");
      await handle.write(bytes, 0, bytes.length);
      size += bytes.length;
    }
  } catch (err) {
    safeLog(
      `[ledger] ${rows.length} row(s) for ${day} not appended (${(err as NodeJS.ErrnoException)?.code ?? "error"})`
    );
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Once per process per UTC day, after a drain: ARMS the compaction on an
 * unref'd timer, never runs it. The drain runs while the next account's
 * request may still be in flight; whole-day reads there would stall it.
 * Never throws.
 */
function maybeCompact(env: NodeJS.ProcessEnv, now: number = Date.now()): void {
  const today = utcDay(now);
  if (compactedDay === today || compactTimer) return;
  compactedDay = today;
  armCompaction(env, COMPACT_DEFER_MS);
}

function armCompaction(env: NodeJS.ProcessEnv, delayMs: number): void {
  if (compactTimer) return;
  compactTimer = setTimeout(() => {
    compactTimer = null;
    if (!isIdle()) {
      armCompaction(env, COMPACT_RETRY_MS);
      return;
    }
    compactUsageLedgerAsync({ env })
      .then((result) => {
        if (result.status === "busy") armCompaction(env, COMPACT_RETRY_MS);
        else if (result.unreadable.length > 0) armCompaction(env, COMPACT_FAILED_RETRY_MS);
      })
      .catch(() => safeLog("[ledger] compaction failed"));
  }, delayMs);
  compactTimer.unref?.();
}

function listDays(dir: string): string[] {
  try {
    return readdirSync(dir)
      .map((name) => DAY_FILE.exec(name)?.[1])
      .filter((day): day is string => day !== undefined)
      .sort();
  } catch {
    return [];
  }
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

export interface CompactionResult {
  /**
   * `locked`: another process holds `compact.lock`; nothing was done. `busy`
   * (async only): a request began, so the rest waits for the next run.
   */
  status: "done" | "locked" | "busy";
  rolledUp: string[];
  rawUnlinked: string[];
  hourlyUnlinked: string[];
  /** Closed days whose raw segment could not be read: not published, not retained against, retried. */
  unreadable: string[];
}

/**
 * Roll up every closed raw day that has no hourly file, then apply retention.
 * Synchronous; takes `compact.lock` with a try-lock and returns `locked` when
 * another process holds it.
 */
export function compactUsageLedger(
  opts: { now?: number; env?: NodeJS.ProcessEnv } = {}
): CompactionResult {
  const now = opts.now ?? Date.now();
  const env = opts.env ?? process.env;
  const result = emptyResult();
  const lock = tryCompactLock(env);
  if (lock === null) return { ...result, status: "locked" };
  try {
    const { closed, rawDays, todayStart } = compactionPlan(env, now);
    let carry: Set<string> | null = null;
    let prev: string | null = null;
    for (const day of closed) {
      const openAtStart = carryInto(day, prev, carry, env);
      const text = readTextSync(usageRawPath(day, env));
      if (text === null) {
        result.unreadable.push(day);
        carry = null;
        prev = day;
        continue;
      }
      const rolled = runSteps(rollupDaySteps(day, parseText(text), openAtStart));
      atomicWriteFileSync(usageHourlyPath(day, env), rolled.text, { mode: 0o600, dirMode: 0o700 });
      result.rolledUp.push(day);
      carry = rolled.openAtEnd;
      prev = day;
    }
    applyRetention(env, rawDays, todayStart, result);
  } finally {
    lock.release();
  }
  logCompaction(result);
  return result;
}

/**
 * The drain's compaction: the same work as {@link compactUsageLedger}, but
 * reads are async, parsing and grouping yield every COMPACT_SLICE_ROWS rows,
 * and it stops (`busy`) before the next day when a request is in flight. A day
 * it cannot read is left raw (no hourly file, so retention never unlinks it)
 * and listed in `unreadable` for a later retry.
 */
export async function compactUsageLedgerAsync(
  opts: { now?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<CompactionResult> {
  const now = opts.now ?? Date.now();
  const env = opts.env ?? process.env;
  const result = emptyResult();
  const lock = tryCompactLock(env);
  if (lock === null) return { ...result, status: "locked" };
  try {
    const { closed, rawDays, todayStart } = compactionPlan(env, now);
    let carry: Set<string> | null = null;
    let prev: string | null = null;
    for (const day of closed) {
      if (!isIdle()) {
        result.status = "busy";
        break;
      }
      const openAtStart = carryInto(day, prev, carry, env);
      let text: string | null;
      try {
        text = await readFile(usageRawPath(day, env), "utf8");
      } catch {
        text = null;
      }
      if (text === null) {
        result.unreadable.push(day);
        carry = null;
        prev = day;
        continue;
      }
      const rows = await runStepsAsync(parseTextSteps(text));
      const rolled = await runStepsAsync(rollupDaySteps(day, rows, openAtStart));
      atomicWriteFileSync(usageHourlyPath(day, env), rolled.text, { mode: 0o600, dirMode: 0o700 });
      result.rolledUp.push(day);
      carry = rolled.openAtEnd;
      prev = day;
    }
    if (result.status === "done") applyRetention(env, rawDays, todayStart, result);
  } finally {
    lock.release();
  }
  logCompaction(result);
  return result;
}

function emptyResult(): CompactionResult {
  return { status: "done", rolledUp: [], rawUnlinked: [], hourlyUnlinked: [], unreadable: [] };
}

function tryCompactLock(env: NodeJS.ProcessEnv): ReturnType<typeof acquireFileLockSync> | null {
  try {
    return acquireFileLockSync(usageCompactLockPath(env), {
      staleMs: COMPACT_LOCK_STALE_MS,
      waitMs: 0,
      log: safeLog,
    });
  } catch (err) {
    if (err instanceof FileLockUnavailableError) return null;
    throw err;
  }
}

/** Closed (older than yesterday) raw days without an hourly file, ascending. */
function compactionPlan(
  env: NodeJS.ProcessEnv,
  now: number
): { closed: string[]; rawDays: string[]; todayStart: number } {
  const todayStart = dayStart(utcDay(now));
  const closedBefore = todayStart - DAY_MS;
  const rawDays = listDays(usageRawDir(env));
  const closed = rawDays.filter(
    (day) => dayStart(day) < closedBefore && !exists(usageHourlyPath(day, env))
  );
  return { closed, rawDays, todayStart };
}

/**
 * The providers whose censored interval was still open when the day before
 * `day` ended: from this run's previous day when that is the day before, else
 * from that day's hourly file (`continues` rows). None when that day has no file.
 */
function carryInto(
  day: string,
  prev: string | null,
  carry: Set<string> | null,
  env: NodeJS.ProcessEnv
): Set<string> {
  const before = utcDay(dayStart(day) - DAY_MS);
  if (prev === before && carry !== null) return carry;
  const open = new Set<string>();
  const text = readTextSync(usageHourlyPath(before, env));
  if (text === null) return open;
  for (const row of parseText(text)) {
    if (row.kind === "no-eligible" && row.continues) open.add(row.provider);
  }
  return open;
}

function applyRetention(
  env: NodeJS.ProcessEnv,
  rawDays: string[],
  todayStart: number,
  result: CompactionResult
): void {
  const rawCutoff = todayStart - RAW_RETENTION_DAYS * DAY_MS;
  for (const day of rawDays) {
    if (dayStart(day) >= rawCutoff) continue;
    // Only once the rollup is published: unlinking first would lose the day.
    if (!exists(usageHourlyPath(day, env))) continue;
    unlinkSync(usageRawPath(day, env));
    result.rawUnlinked.push(day);
  }
  const hourlyCutoff = todayStart - ROLLUP_RETENTION_DAYS * DAY_MS;
  for (const day of listDays(usageHourlyDir(env))) {
    if (dayStart(day) >= hourlyCutoff) continue;
    unlinkSync(usageHourlyPath(day, env));
    result.hourlyUnlinked.push(day);
  }
}

function logCompaction(result: CompactionResult): void {
  if (result.rolledUp.length > 0 || result.rawUnlinked.length > 0) {
    safeLog(
      `[ledger] compacted: ${result.rolledUp.length} day(s) rolled up, ${result.rawUnlinked.length} raw day(s) removed`
    );
  }
  if (result.unreadable.length > 0) {
    safeLog(
      `[ledger] ${result.unreadable.length} closed day(s) unreadable; left raw, retried later`
    );
  }
}

/** A file's text, or null when it cannot be read: an unreadable day is never an empty one. */
function readTextSync(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function parseText(text: string): LedgerRow[] {
  return runSteps(parseTextSteps(text));
}

function* parseTextSteps(text: string): Generator<void, LedgerRow[]> {
  const rows: LedgerRow[] = [];
  let n = 0;
  for (const line of text.split("\n")) {
    if (line.length > 0) {
      const row = parseRow(line);
      if (row) rows.push(row);
    }
    if (++n % COMPACT_SLICE_ROWS === 0) yield;
  }
  return rows;
}

function runSteps<T>(gen: Generator<void, T>): T {
  for (;;) {
    const next = gen.next();
    if (next.done) return next.value;
  }
}

async function runStepsAsync<T>(gen: Generator<void, T>): Promise<T> {
  for (;;) {
    const next = gen.next();
    if (next.done) return next.value;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** One censored interval of a day: [at, until), `continues` when still open at the day's end. */
interface CensorInterval {
  provider: AccountProviderName;
  at: number;
  until: number;
  continues: boolean;
}

type AccountProviderName = NoEligibleRow["provider"];

/**
 * Per provider: minutes of each hour (keyed by hour start) the pool was
 * unavailable, and the intervals themselves. A provider in `openAtStart` was
 * still blocked when the previous day ended: its interval runs from the day's
 * start to its first `ok`.
 */
function censoredMinutesByHour(
  rows: LedgerRow[],
  dayBegin: number,
  dayEnd: number,
  openAtStart: ReadonlySet<string> = new Set()
): { minutes: Map<string, Map<number, number>>; intervals: CensorInterval[] } {
  const byProvider = new Map<string, Map<number, number>>();
  const intervals: CensorInterval[] = [];
  const events = rows
    .filter(
      (r): r is ResponseRow | NoEligibleRow => r.kind === "response" || r.kind === "no-eligible"
    )
    .sort((a, b) => a.at - b.at);
  const openSince = new Map<string, number>();
  for (const provider of openAtStart) openSince.set(provider, dayBegin);
  const credit = (provider: string, from: number, to: number) => {
    let hours = byProvider.get(provider);
    if (!hours) {
      hours = new Map();
      byProvider.set(provider, hours);
    }
    for (let h = Math.floor(from / HOUR_MS) * HOUR_MS; h < to; h += HOUR_MS) {
      const overlap = Math.min(to, h + HOUR_MS) - Math.max(from, h);
      if (overlap > 0) hours.set(h, Math.min(60, (hours.get(h) ?? 0) + overlap / 60_000));
    }
  };
  for (const row of events) {
    if (row.kind === "no-eligible") {
      if (!openSince.has(row.provider)) openSince.set(row.provider, row.at);
    } else if (row.outcome === "ok") {
      const since = openSince.get(row.provider);
      if (since !== undefined) {
        credit(row.provider, since, row.at);
        intervals.push({ provider: row.provider, at: since, until: row.at, continues: false });
        openSince.delete(row.provider);
      }
    }
  }
  for (const [provider, since] of openSince) {
    credit(provider, since, dayEnd);
    intervals.push({
      provider: provider as AccountProviderName,
      at: since,
      until: dayEnd,
      continues: true,
    });
  }
  intervals.sort((a, b) => a.at - b.at);
  return { minutes: byProvider, intervals };
}

/**
 * The hourly file's text for one closed day. Deterministic for the same rows.
 * `openAtStart`: the providers still blocked when the previous day ended.
 */
export function rollupDay(
  day: string,
  rows: LedgerRow[],
  openAtStart: ReadonlySet<string> = new Set()
): string {
  return runSteps(rollupDaySteps(day, rows, openAtStart)).text;
}

/**
 * {@link rollupDay} in slices: yields every COMPACT_SLICE_ROWS rows grouped and
 * lines built. Also returns the providers whose interval is open at the day's end.
 */
function* rollupDaySteps(
  day: string,
  rows: LedgerRow[],
  openAtStart: ReadonlySet<string>
): Generator<void, { text: string; openAtEnd: Set<string> }> {
  const dayBegin = dayStart(day);
  const dayEnd = dayBegin + DAY_MS;
  const { minutes: censored, intervals } = censoredMinutesByHour(
    rows,
    dayBegin,
    dayEnd,
    openAtStart
  );
  yield;
  const responses = rows
    .filter((r): r is ResponseRow => r.kind === "response")
    .sort((a, b) => a.at - b.at);
  yield;
  const groups = new Map<string, { rows: ResponseRow[]; hour: number }>();
  let n = 0;
  for (const row of responses) {
    if (++n % COMPACT_SLICE_ROWS === 0) yield;
    const hour = Math.floor(row.at / HOUR_MS) * HOUR_MS;
    const key = [hour, row.provider, row.accountId, row.session ?? "-", row.model].join("\u0000");
    const group = groups.get(key);
    if (group) group.rows.push(row);
    else groups.set(key, { rows: [row], hour });
  }
  const lines: string[] = [];
  n = 0;
  for (const { rows: group, hour } of groups.values()) {
    if (++n % COMPACT_SLICE_ROWS === 0) yield;
    const head = group[0];
    if (!head) continue;
    const first = new Map<string, NonNullable<ResponseRow["windows"]>[number]>();
    const last = new Map<string, NonNullable<ResponseRow["windows"]>[number]>();
    for (const row of group) {
      for (const w of row.windows ?? []) {
        if (!first.has(w.key)) first.set(w.key, w);
        last.set(w.key, w);
      }
    }
    const hh = String(new Date(hour).getUTCHours()).padStart(2, "0");
    const rollup: RollupRow = {
      v: LEDGER_ROW_VERSION,
      kind: "rollup",
      id: `rollup:${day}:${hh}:${head.provider}:${head.accountId}:${head.session ?? "-"}:${head.model}`,
      hour,
      provider: head.provider,
      accountId: head.accountId,
      session: head.session,
      model: head.model,
      n: group.length,
      tokens: {
        input: group.reduce((s, r) => s + r.inTok, 0),
        cacheRead: group.reduce((s, r) => s + r.cacheReadTok, 0),
        cacheWrite: group.reduce((s, r) => s + r.cacheWriteTok, 0),
        output: group.reduce((s, r) => s + r.outTok, 0),
      },
      first: first.size > 0 ? [...first.values()] : null,
      last: last.size > 0 ? [...last.values()] : null,
      censoredMinutes: censored.get(head.provider)?.get(hour) ?? 0,
    };
    lines.push(JSON.stringify(rollup));
  }
  // One SEALED row per interval (both endpoints), never the raw opening rows:
  // a replay of the hourly file then censors exactly what the raw day did.
  for (const interval of intervals) {
    const row: NoEligibleRow = {
      v: LEDGER_ROW_VERSION,
      kind: "no-eligible",
      at: interval.at,
      provider: interval.provider,
      until: interval.until,
      ...(interval.continues ? { continues: true as const } : {}),
    };
    lines.push(JSON.stringify(row));
  }
  const openAtEnd = new Set(intervals.filter((i) => i.continues).map((i) => i.provider));
  return { text: lines.length > 0 ? `${lines.join("\n")}\n` : "", openAtEnd };
}

/** Test seam: forget the per-process compaction and size-cap memory. */
export function _resetLedgerWriterForTests(): void {
  queue.length = 0;
  dropped = 0;
  fullDays.clear();
  compactedDay = null;
  if (compactTimer) clearTimeout(compactTimer);
  compactTimer = null;
}
