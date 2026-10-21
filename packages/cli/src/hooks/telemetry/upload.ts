/**
 * Behaviour telemetry — delivery.
 *
 * Reads the outbox written by `aggregate.ts` at exit and POSTs each session
 * aggregate to the deployed endpoint. Runs in the BACKGROUND of a later session,
 * never on the shutdown path, because shutdown cannot await a network call.
 *
 * ## Server contract (deployed)
 *
 *   POST https://claudish.com/v1/behavior
 *   auth:  none
 *   limit: 60 accepted requests per source per minute
 *   202 — stored; a duplicate delivery gets the same response (idempotent on session_id)
 *   400 — malformed; never retried
 *   429 — rate limited, carries Retry-After
 *   5xx — server fault; at most one retry, then dropped
 *
 * Every failure mode is silent by design. This is diagnostic data about model
 * behaviour; it is never worth a word on the user's terminal, let alone an
 * error. Note also that claudish shares stdio with the Claude Code TUI, so a
 * stray write here would corrupt its rendering.
 */

import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { log } from "../../logger.js";
import type { SessionReport } from "./aggregate.js";
import { outboxPath } from "./aggregate.js";

const ENDPOINT = "https://claudish.com/v1/behavior";

/**
 * Deliberately more generous than the 3s `/v1/report` uses.
 *
 * That endpoint is fire-and-forget on the request path, where a slow call would
 * make the user wait, so a tight timeout is right. This drain runs in the
 * BACKGROUND and blocks nothing, so the same 3s buys nothing and costs real
 * deliveries: measured against the deployed service, a warm request completes in
 * ~600ms but a COLD start exceeds 3s. At 3s the first drain after an idle period
 * fails every time, and reports only ever land on a second run.
 */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Spacing between deliveries. The server accepts 60/minute; 1.1s keeps a drained
 * backlog comfortably inside that without needing to read the response headers
 * to find out we have already exceeded it.
 */
const SEND_INTERVAL_MS = 1100;

/**
 * Ceiling on a single drain. A backlog larger than this is not worth the wall
 * clock — the data is aggregate and the oldest entries are the least useful.
 */
const MAX_DRAIN_PER_RUN = 50;

/**
 * Ceiling on the retained outbox. Reached only if a machine is offline for a
 * long stretch; oldest entries are dropped first for the same reason the journal
 * prunes oldest-first — a record of a claudish version no longer in use
 * describes a system that no longer exists.
 */
const MAX_OUTBOX_ENTRIES = 200;

type Outcome = "sent" | "drop" | "retry";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Deliver one report.
 *
 * @returns `sent` on 202, `drop` when the report can never succeed, `retry`
 *          when it should stay in the outbox for a later run.
 */
async function post(report: SessionReport): Promise<Outcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
      signal: controller.signal,
    });

    if (res.status === 202) return "sent";

    // Malformed by the server's judgement. Retrying an identical body would
    // fail identically forever, so this is a client bug to fix, not a transient
    // fault to absorb.
    if (res.status === 400) {
      log("[behavior:telemetry] rejected as malformed (400), dropping");
      return "drop";
    }

    // We cannot honour Retry-After by waiting — a drain runs in the background
    // of someone's coding session and must not sit on a timer for a minute. The
    // report keeps for the next run, which is the same outcome, later.
    if (res.status === 429) {
      log("[behavior:telemetry] rate limited, deferring to next run");
      return "retry";
    }

    return res.status >= 500 ? "retry" : "drop";
  } catch {
    // Offline, DNS failure, timeout. All transient.
    return "retry";
  } finally {
    clearTimeout(timer);
  }
}

/** Parse the outbox, discarding any line that is not a usable report. */
function parseOutbox(content: string): SessionReport[] {
  const out: SessionReport[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed.session_id === "string") out.push(parsed);
    } catch {
      // A torn line from an interrupted append. Skipping it is correct; there is
      // nothing to recover and one bad line must not block the whole outbox.
    }
  }
  return out;
}

/** Rewrite the outbox with what remains, via temp + rename so a reader never sees a partial file. */
async function persistRemaining(path: string, remaining: SessionReport[]): Promise<void> {
  if (remaining.length === 0) {
    await unlink(path).catch(() => {});
    return;
  }
  const kept = remaining.slice(-MAX_OUTBOX_ENTRIES);
  const tmp = `${path}.draining`;
  await writeFile(tmp, `${kept.map((r) => JSON.stringify(r)).join("\n")}\n`);
  await rename(tmp, path);
}

let drained = false;

/**
 * Deliver the outbox. Safe to call repeatedly — it runs at most once per process.
 *
 * Never throws and is never awaited by the request path.
 */
export async function drainOutbox(path = outboxPath()): Promise<{ sent: number; kept: number }> {
  if (drained) return { sent: 0, kept: 0 };
  drained = true;

  try {
    const content = await readFile(path, "utf8").catch(() => "");
    const reports = parseOutbox(content);
    if (reports.length === 0) return { sent: 0, kept: 0 };

    // Newest first: if the backlog exceeds one drain, recent sessions are the
    // ones worth delivering.
    const batch = reports.slice(-MAX_DRAIN_PER_RUN).reverse();
    const older = reports.slice(0, Math.max(0, reports.length - MAX_DRAIN_PER_RUN));

    const keep: SessionReport[] = [];
    let sent = 0;
    for (let i = 0; i < batch.length; i++) {
      if (i > 0) await sleep(SEND_INTERVAL_MS);
      const outcome = await post(batch[i]);
      if (outcome === "sent") sent++;
      else if (outcome === "retry") keep.push(batch[i]);
      // "drop" falls through: neither sent nor kept.
    }

    await persistRemaining(path, [...older, ...keep]);
    if (sent > 0) log(`[behavior:telemetry] delivered ${sent} session report(s)`);
    return { sent, kept: keep.length };
  } catch (err) {
    log(`[behavior:telemetry] drain failed: ${err}`);
    return { sent: 0, kept: 0 };
  }
}

/** Test seam — re-arms the once-per-process guard. */
export function resetDrainState(): void {
  drained = false;
}
