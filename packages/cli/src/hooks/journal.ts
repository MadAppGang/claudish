/**
 * Hook decision journal (`~/.claudish/behavior-journal.jsonl`).
 *
 * The file keeps its name: it names the behaviour-telemetry product and its
 * `POST /v1/behavior` endpoint, not the deleted `behavior/` module.
 *
 * Records what the supervisor SAW and what it DECIDED, so the decisions can be
 * analysed later and turned into deterministic rules. This is the input to the
 * dream session (see MTL-77).
 *
 * ## Two payloads, on purpose
 *
 * A LOCAL record keeps full detail — real paths, real values-shapes. It lives on
 * the user's own machine alongside the debug log, and a local analysis pass
 * genuinely needs it: "the model wrote to <this> instead of <that>" is the whole
 * signal, and stripping it leaves nothing to learn from.
 *
 * What may LEAVE the machine carries no paths at all. Not sanitized paths — none. The
 * existing `sanitizeForReport()` masks the home directory but keeps the rest, so
 * `/Users/***\/dev/acme/acme-portal/...` still names a client. For aggregate
 * analysis the literal path is not needed anyway: what matters is the CATEGORY
 * of what happened ("wrote inside the plan dir but not to the assigned file"),
 * which is non-identifying and just as useful across many users.
 *
 * This mirrors the two-level rule already established in redact.ts:
 * `redactSecrets` for text staying on the machine, `sanitizeForReport` for text
 * leaving it — this module just takes it further, because a behavior record is
 * structural data rather than prose.
 *
 * ## Consent
 *
 * Local journalling is always on and needs no consent: it is the user's own data
 * on their own disk, exactly like `logs/`. Upload is a SEPARATE opt-in
 * (`hooks.telemetry.enabled`) and deliberately does NOT ride on the existing
 * `stats.enabled` consent — that consent was given for usage statistics, and
 * silently reusing it to ship behavioural records would be consent laundering.
 */

import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { log } from "../logger.js";

/**
 * Local journal line schema. 2 since the hook system: the line names the event,
 * the hook and the action. Uploads are NOT journal lines — they are the session
 * aggregate built by `telemetry/aggregate.ts`, which keeps its own schema (1).
 */
export const JOURNAL_SCHEMA_VERSION = 2;

/** Which supervision surface produced this decision. */
export type Surface =
  | "request"
  | "tool_call"
  | "model_output"
  | "sequence"
  | "response"
  | "session";

/**
 * The surfaces the telemetry backend accepts. A CLOSED set fixed by the server
 * contract (`docs/specs/behavior-telemetry-backend.md`); `response` and
 * `session` are local only.
 */
export type UploadSurface = "request" | "tool_call" | "model_output" | "sequence";

/** What the supervisor did. */
export type Decision =
  | "ignored" // no rule matched
  | "matched" // a rule matched and applied
  | "warned" // a rule matched but severity was warn
  | "repaired" // arguments were rewritten
  | "novel" // nothing matched and the observer was consulted
  | "superseded" // a duplicate of an earlier step's text, or an action on a removed tool
  | "invalid" // the action was refused (shape, limit, not allowed for the event)
  | "timeout" // the handler did not return within its timeout
  | "error" // the handler threw or rejected
  | "disabled" // the circuit breaker disabled the hook
  | "dropped" // an injection or annotation was dropped
  | "queued" // an injection or note was queued
  | "delivered" // an injection was delivered
  | "raw" // a raw (unsafe) hook touched the request or response
  | "skipped"; // the event budget was spent before the hook's step (local only)

/**
 * The decision values the telemetry backend accepts — the `counts.*` keys of
 * the server contract. Everything added since is local only.
 */
export type UploadDecision = "ignored" | "matched" | "warned" | "repaired" | "novel";

const UPLOAD_SURFACES: ReadonlySet<string> = new Set<UploadSurface>([
  "request",
  "tool_call",
  "model_output",
  "sequence",
]);
const UPLOAD_DECISIONS: ReadonlySet<string> = new Set<UploadDecision>([
  "ignored",
  "matched",
  "warned",
  "repaired",
  "novel",
]);

export function isUploadSurface(surface: Surface): surface is UploadSurface {
  return UPLOAD_SURFACES.has(surface);
}

export function isUploadDecision(decision: Decision): decision is UploadDecision {
  return UPLOAD_DECISIONS.has(decision);
}

/**
 * How a file path related to the one the harness expected.
 *
 * This is the uploadable stand-in for the path itself — it preserves the entire
 * signal the plan-mode rule keys off, while carrying no user data.
 */
export type PathRelation =
  | "as_expected"
  | "same_dir_wrong_name"
  | "outside_expected_dir"
  | "no_expectation"
  | "not_applicable";

/** Hook events, plus `raw` for every raw-tier stage. */
export type JournalEvent =
  | "request"
  | "toolCall"
  | "responseRewrite"
  | "responseEnd"
  | "sessionStart"
  | "sessionIdle"
  | "sessionBlocked"
  | "sessionEnd"
  | "raw";

/**
 * One local journal line. Never uploaded as-is: the upload is the per-session
 * aggregate, and the only fields that reach it are passed explicitly by the
 * hook engine's `journal()` fan-out, which also applies the user-hook privacy
 * rules there.
 */
export interface JournalEntry {
  /** JOURNAL_SCHEMA_VERSION. Absent on lines written by the pre-hook engine. */
  schema?: number;
  ts: string;
  event?: JournalEvent;
  /** The real hook id — local only. */
  hookId?: string;
  action?: string;
  model: string;
  provider: string;
  sessionId?: string;
  surface: Surface;
  decision: Decision;
  /** Same as hookId (kept for readers of schema 1). */
  ruleId?: string;
  toolName?: string;
  /** Argument KEYS only — never values. */
  argKeys?: string[];
  pathRelation?: PathRelation;
  /** Full local detail. Never uploaded. */
  local?: {
    observedPath?: string;
    expectedPath?: string;
    note?: string;
  };
  /** At most 200 chars. Local only. */
  detail?: string;
}

/** The longest `detail` a journal line carries. */
export const MAX_DETAIL_CHARS = 200;

/** Classify an observed path against the expected one, without keeping either. */
export function classifyPath(observed?: string, expected?: string): PathRelation {
  if (!observed) return "not_applicable";
  if (!expected) return "no_expectation";
  if (observed === expected) return "as_expected";
  const dirOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf("/")));
  return dirOf(observed) === dirOf(expected) ? "same_dir_wrong_name" : "outside_expected_dir";
}

export function journalPath(): string {
  return join(homedir(), ".claudish", "behavior-journal.jsonl");
}

/**
 * Size ceiling for the local journal. It is append-only and a busy session
 * writes an entry per watched tool call, so it needs a bound.
 */
export const MAX_JOURNAL_BYTES = 32 * 1024 * 1024;

/**
 * Prune target. Dropping to well under the cap rather than just below it means
 * the (relatively expensive) rewrite happens once per many appends instead of
 * on nearly every write once the file is full.
 */
const PRUNE_TO_BYTES = Math.floor(MAX_JOURNAL_BYTES * 0.6);

/**
 * Drop the oldest entries until the file fits under PRUNE_TO_BYTES.
 *
 * Oldest-first is the right eviction order here: the value of a decision record
 * decays: recent entries describe the models and rules currently in play, while
 * a record from six months and four claudish versions ago describes a system
 * that no longer exists.
 *
 * Written to a temp file and renamed so a reader never observes a half-pruned
 * journal. A concurrent append from another claudish process during the rewrite
 * can be lost — acceptable for diagnostic data, and far preferable to holding a
 * cross-process lock on the request path.
 */
async function prune(path: string): Promise<void> {
  const content = await readFile(path, "utf8");
  const lines = content.split("\n").filter(Boolean);

  // Walk backwards from the newest, keeping lines until the budget is spent.
  let kept = 0;
  let firstKept = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = Buffer.byteLength(lines[i]) + 1;
    if (kept + cost > PRUNE_TO_BYTES) break;
    kept += cost;
    firstKept = i;
  }

  const survivors = lines.slice(firstKept);
  const tmp = `${path}.pruning`;
  await writeFile(tmp, survivors.length ? `${survivors.join("\n")}\n` : "");
  await rename(tmp, path);
  log(
    `[behavior:journal] pruned ${lines.length - survivors.length} of ${lines.length} entries ` +
      `to stay under ${Math.round(MAX_JOURNAL_BYTES / 1e6)}MB`
  );
}

/**
 * The last pending append per journal path in this process.
 *
 * The request path fires `recordDecision` without awaiting it, so one hook step's actions start
 * several appends in the same tick. Each append first awaits a `stat` (and on a fresh journal a
 * `mkdir`), and those settle in no particular order: unchained, the lines reached the file in a
 * shuffled order, and the last decision could be on disk while an earlier one was still pending.
 * Chaining keeps the file in decision order, so a reader that sees a line also sees every line
 * this process decided before it. Cross-process appends stay unordered, as before.
 */
const pendingAppends = new Map<string, Promise<void>>();

/**
 * Append one decision. Never throws, never awaited by the request path. Appends from one process
 * reach the file in call order.
 */
export function recordDecision(entry: JournalEntry, path = journalPath()): Promise<void> {
  const previous = pendingAppends.get(path) ?? Promise.resolve();
  const next = previous.then(() => appendDecision(entry, path));
  pendingAppends.set(path, next);
  // Drop the entry once the chain is idle, so the map holds at most one promise per busy path.
  void next.then(() => {
    if (pendingAppends.get(path) === next) pendingAppends.delete(path);
  });
  return next;
}

async function appendDecision(entry: JournalEntry, path: string): Promise<void> {
  try {
    const size = await stat(path).then(
      (s) => s.size,
      () => 0
    );
    if (size === 0) await mkdir(dirname(path), { recursive: true }).catch(() => {});
    if (size > MAX_JOURNAL_BYTES) {
      await prune(path).catch((err) => log(`[behavior:journal] prune failed: ${err}`));
    }
    await appendFile(path, `${JSON.stringify(entry)}\n`);
  } catch (err) {
    // Journalling is diagnostic. It must never affect the user's request.
    log(`[behavior:journal] could not record: ${err}`);
  }
}
