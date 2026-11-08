/**
 * The usage ledger's reader (allowance architecture §2.1).
 *
 * ## Read precedence
 *
 * `source: "model"` (the default, the model loader's view): a day with an
 * hourly file is read from it and its raw segment is ignored. That one rule is
 * what makes compaction crash-safe without an index (see `ledger-writer.ts`).
 * `source: "raw"` reads raw segments only, for contributions and `--json`
 * detail over the last 30 days.
 *
 * ## Tail semantics under a concurrent appender
 *
 * {@link LedgerTail.tail} reads each raw segment from its stored offset to EOF
 * and parses only complete `\n`-terminated lines. The offset advances to just
 * after the last newline, so a partial trailing line (another process
 * mid-`write()`) is re-read on the next tail and never skipped. A complete line
 * that does not parse as a v1 row is skipped and counted.
 */

import { open, readFile, readdir } from "node:fs/promises";
import { usageHourlyDir, usageHourlyPath, usageRawDir, usageRawPath } from "../paths.js";
import { type LedgerRow, dayStart, parseRow, utcDay } from "./ledger-row.js";

const DAY_MS = 86_400_000;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export interface LedgerRead {
  rows: LedgerRow[];
  /** Complete lines that were not valid v1 rows. */
  skipped: number;
}

async function listDays(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir))
      .map((name) => DAY_FILE.exec(name)?.[1])
      .filter((day): day is string => day !== undefined)
      .sort();
  } catch {
    return [];
  }
}

function rowTime(row: LedgerRow): number {
  return row.kind === "rollup" ? row.hour : row.at;
}

/** Complete lines of `text`, parsed; the count of complete lines that were not rows. */
function parseLines(text: string): LedgerRead {
  const rows: LedgerRow[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    const row = parseRow(line);
    if (row) rows.push(row);
    else skipped++;
  }
  return { rows, skipped };
}

/** Everything up to and including the last newline; a trailing partial line is not complete. */
function completePart(text: string): string {
  const end = text.lastIndexOf("\n");
  return end < 0 ? "" : text.slice(0, end + 1);
}

/**
 * Every row at or after `sinceMs` (and before `untilMs`, when given), in file
 * order per day, days ascending. Never throws: an unreadable directory or file
 * reads as empty.
 */
export async function readLedger(
  opts: {
    sinceMs: number;
    untilMs?: number;
    source?: "model" | "raw";
    env?: NodeJS.ProcessEnv;
  } = { sinceMs: 0 }
): Promise<LedgerRead> {
  const env = opts.env ?? process.env;
  const source = opts.source ?? "model";
  const until = opts.untilMs ?? Number.POSITIVE_INFINITY;
  const hourly = new Set(source === "model" ? await listDays(usageHourlyDir(env)) : []);
  const raw = await listDays(usageRawDir(env));
  const days = [...new Set([...hourly, ...raw])].sort();
  const out: LedgerRead = { rows: [], skipped: 0 };
  for (const day of days) {
    const start = dayStart(day);
    if (start + DAY_MS <= opts.sinceMs || start >= until) continue;
    const path = hourly.has(day) ? usageHourlyPath(day, env) : usageRawPath(day, env);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      continue;
    }
    // A raw segment's trailing partial line belongs to a writer still mid-append.
    const parsed = parseLines(hourly.has(day) ? text : completePart(text));
    out.skipped += parsed.skipped;
    for (const row of parsed.rows) {
      const at = rowTime(row);
      if (at >= opts.sinceMs && at < until) out.rows.push(row);
    }
  }
  return out;
}

/** Bytes read past a stored offset per call; a longer backlog is read over several tails. */
const TAIL_CHUNK_BYTES = 8 * 1024 * 1024;

export interface LedgerTail {
  /** New complete rows since the last call, across every raw segment from the start day on. */
  tail(): Promise<LedgerRead>;
  /** The stored byte offset per raw day, for diagnostics and tests. */
  offsets(): ReadonlyMap<string, number>;
}

/**
 * A tail over the raw segments of `fromDay` (default: today, UTC) and every
 * later day. With `startAtEnd`, the first call skips what the segments already
 * held when the tail was created (the caller loaded those with `readLedger`).
 */
export function createLedgerTail(
  opts: {
    fromDay?: string;
    startAtEnd?: boolean;
    now?: number;
    env?: NodeJS.ProcessEnv;
  } = {}
): LedgerTail {
  const env = opts.env ?? process.env;
  const fromDay = opts.fromDay ?? utcDay(opts.now ?? Date.now());
  const offsets = new Map<string, number>();
  let primed = !opts.startAtEnd;

  /** Offset just after the last newline of a segment as it stands now. */
  const endOffset = async (path: string): Promise<number> => {
    const handle = await open(path, "r");
    try {
      const size = (await handle.stat()).size;
      const window = Math.min(size, 64 * 1024);
      for (let end = size; end > 0; ) {
        const start = Math.max(0, end - window);
        const buf = Buffer.alloc(end - start);
        await handle.read(buf, 0, buf.length, start);
        const nl = buf.lastIndexOf(0x0a);
        if (nl >= 0) return start + nl + 1;
        end = start;
      }
      return 0;
    } finally {
      await handle.close().catch(() => {});
    }
  };

  return {
    offsets: () => offsets,
    async tail(): Promise<LedgerRead> {
      const out: LedgerRead = { rows: [], skipped: 0 };
      const days = (await listDays(usageRawDir(env))).filter((day) => day >= fromDay);
      if (!primed) {
        primed = true;
        for (const day of days) {
          try {
            offsets.set(day, await endOffset(usageRawPath(day, env)));
          } catch {
            /* unreadable now: read from 0 when it becomes readable */
          }
        }
        return out;
      }
      for (const day of days) {
        const offset = offsets.get(day) ?? 0;
        let handle: Awaited<ReturnType<typeof open>> | undefined;
        try {
          handle = await open(usageRawPath(day, env), "r");
          const size = (await handle.stat()).size;
          if (size <= offset) continue;
          const length = Math.min(size - offset, TAIL_CHUNK_BYTES);
          const buf = Buffer.alloc(length);
          const { bytesRead } = await handle.read(buf, 0, length, offset);
          const nl = buf.subarray(0, bytesRead).lastIndexOf(0x0a);
          if (nl < 0) continue;
          const parsed = parseLines(buf.subarray(0, nl + 1).toString("utf8"));
          out.rows.push(...parsed.rows);
          out.skipped += parsed.skipped;
          offsets.set(day, offset + nl + 1);
        } catch {
          /* a segment that vanished (unlinked by retention) or is unreadable: skip */
        } finally {
          await handle?.close().catch(() => {});
        }
      }
      return out;
    },
  };
}
