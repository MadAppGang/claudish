/**
 * Exec records: one per exec call relayed with code mode on, keyed
 * `(accountKey, execCallId)`, holding the script source, its suspended runtime
 * while it waits on Claude Code, the batches it emitted and the outputs it
 * produced.
 *
 * Why keyed by account and not by session: upstream call ids are unique, so a
 * forked session (`--fork-session`: new session id, same history, same account)
 * still finds its execs and renders their completed outputs byte-identically.
 * Each record stores its OWNER `sessionKey`; only the owner may resume it. A
 * request on another account computes another `accountKey` and never finds,
 * resumes or renders this account's records.
 *
 * States — the State pattern's transition-table form (`patterns/state.md`),
 * chosen because the states differ only in which transitions are legal:
 *
 *     running:   block → suspended, finish → completed, fail → failed
 *     suspended: resume → running, terminate → terminated, abandon → terminated,
 *                evict → lost, expire → lost
 *     lost:      answer → failed (tombstone stored), replay → running
 *     completed / failed / terminated: answer → same state
 *
 * The catalog's table throws on an illegal transition. Here it is logged and
 * coerced to `lost`, never thrown: this runs on the request path, and a refused
 * request is worse than a degraded script. Every transition that ends a runtime
 * disposes it.
 *
 * Every store has a byte ceiling the model cannot raise (architecture §5.8):
 * settled records (anything but running/suspended) are capped at 2,000 records
 * AND 32 MiB, counting the UTF-8 length of the source, every stored output's
 * text plus 64 bytes per output part, and the reasoning items' JSON (images
 * are references, never bytes).
 * Eviction is LRU by `lastTouched`; an evicted record's id goes to a bounded
 * FIFO set, so the input builder can say "evicted" rather than "restart".
 * Suspended records are bounded by the sandbox's live-runtime cap (32) and a
 * 6 h idle TTL. A 60 s reaper applies the TTL and the caps.
 */

import { log } from "../logger.js";
import type { ExecOutput } from "./output.js";
import type { ScriptRuntime } from "./sandbox/script-runtime.js";
import type { NestedToolUse, ResponsesItem } from "./types.js";

export type ExecState = "running" | "suspended" | "completed" | "failed" | "terminated" | "lost";

export type ExecEvent =
  | "block"
  | "finish"
  | "fail"
  | "resume"
  | "terminate"
  | "abandon"
  | "evict"
  | "expire"
  | "answer"
  | "replay";

/** The legal transitions; anything absent is illegal (logged, coerced to `lost`). */
const TRANSITIONS: Record<ExecState, Partial<Record<ExecEvent, ExecState>>> = {
  running: { block: "suspended", finish: "completed", fail: "failed" },
  suspended: {
    resume: "running",
    terminate: "terminated",
    abandon: "terminated",
    evict: "lost",
    expire: "lost",
  },
  lost: { answer: "failed", replay: "running" },
  completed: { answer: "completed" },
  failed: { answer: "failed" },
  terminated: { answer: "terminated" },
};

/** Events after which the runtime is gone. */
const ENDS_RUNTIME = new Set<ExecEvent>([
  "finish",
  "fail",
  "terminate",
  "abandon",
  "evict",
  "expire",
  "answer",
]);

/** An output stored for one completion key. */
export interface StoredOutput {
  output: ExecOutput;
  /** `run`: the script produced it; `tombstone`: claudish answered for a lost script. */
  origin: "run" | "tombstone";
  /** The session that stored it (a tombstone is rendered only for that session). */
  sessionKey: string;
}

/** One emitted batch: the nested tool_use ids, and its hash once consumed. */
export interface ExecBatch {
  ids: string[];
  batchHash?: string;
  /**
   * The tool_use blocks as relayed, kept only while the record is live, so a
   * duplicate request can replay the same reply (dropped when it settles: the
   * inputs are up to 8 MiB a batch and are not in the byte cap).
   */
  blocks?: NestedToolUse[];
}

export interface ExecRecord {
  accountKey: string;
  /** The owner: only this session may resume the script. */
  sessionKey: string;
  /** The 32-hex exec key (`execKeyFor`), the key nested ids carry. */
  execCallId: string;
  /** The upstream `call_id` as the model sent it. */
  originalCallId: string;
  source: string;
  shape: "lite" | "classic";
  state: ExecState;
  runtime?: ScriptRuntime;
  batches: ExecBatch[];
  /** Outputs by completion key (`hashes.ts`). */
  outputs: Map<string, StoredOutput>;
  /** The reasoning items of the leg that produced the exec. */
  reasoningItems?: ResponsesItem[];
  /** The exec's output budget in tokens (pragma, else the default) when it was relayed. */
  maxOutputTokens?: number;
  startedAt: number;
  lastTouched: number;
  /** Counted bytes (source + output text + reasoning JSON). */
  bytes: number;
}

export interface ScriptStoreLimits {
  maxRecords: number;
  maxBytes: number;
  suspendedTtlMs: number;
  maxEvictedIds: number;
  reapIntervalMs: number;
}

export const DEFAULT_SCRIPT_STORE_LIMITS: ScriptStoreLimits = {
  maxRecords: 2_000,
  maxBytes: 32 * 1024 * 1024,
  suspendedTtlMs: 6 * 60 * 60 * 1000,
  maxEvictedIds: 20_000,
  reapIntervalMs: 60_000,
};

export interface NewExecRecord {
  accountKey: string;
  sessionKey: string;
  execCallId: string;
  originalCallId: string;
  source: string;
  shape: "lite" | "classic";
  state?: ExecState;
  reasoningItems?: ResponsesItem[];
  maxOutputTokens?: number;
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * What one stored output part costs beyond its text: the host object and its
 * Responses part. Without it, parts with little or no text were free.
 */
const PART_OVERHEAD_BYTES = 64;

function outputBytes(output: ExecOutput): number {
  let bytes = output.error ? utf8Bytes(output.error) : 0;
  for (const part of output.parts) {
    bytes += PART_OVERHEAD_BYTES;
    if (part.type === "text") bytes += utf8Bytes(part.text);
  }
  return bytes;
}

function recordBytes(record: ExecRecord): number {
  let bytes = utf8Bytes(record.source);
  for (const stored of record.outputs.values()) bytes += outputBytes(stored.output);
  if (record.reasoningItems) bytes += utf8Bytes(JSON.stringify(record.reasoningItems));
  return bytes;
}

function recordKey(accountKey: string, execCallId: string): string {
  return `${accountKey}\0${execCallId}`;
}

function isLive(state: ExecState): boolean {
  return state === "running" || state === "suspended";
}

/** A bounded FIFO set of ids. */
class BoundedIdSet {
  private readonly ids = new Set<string>();
  constructor(private readonly max: number) {}
  add(id: string): void {
    this.ids.delete(id);
    this.ids.add(id);
    while (this.ids.size > this.max) {
      const oldest = this.ids.values().next().value;
      if (oldest === undefined) break;
      this.ids.delete(oldest);
    }
  }
  has(id: string): boolean {
    return this.ids.has(id);
  }
  delete(id: string): void {
    this.ids.delete(id);
  }
  get size(): number {
    return this.ids.size;
  }
}

export class ScriptStore {
  private readonly records = new Map<string, ExecRecord>();
  private readonly evicted: BoundedIdSet;
  private readonly pins: BoundedIdSet;
  private readonly limits: ScriptStoreLimits;
  private readonly now: () => number;
  private settledBytes = 0;
  private reaper: ReturnType<typeof setInterval> | undefined;

  constructor(opts: { limits?: Partial<ScriptStoreLimits>; now?: () => number } = {}) {
    this.limits = { ...DEFAULT_SCRIPT_STORE_LIMITS, ...opts.limits };
    this.now = opts.now ?? Date.now;
    this.evicted = new BoundedIdSet(this.limits.maxEvictedIds);
    this.pins = new BoundedIdSet(this.limits.maxEvictedIds);
  }

  // ─── records ────────────────────────────────────────────────────────

  /** Create (or replace) the record for an exec. */
  create(init: NewExecRecord): ExecRecord {
    const key = recordKey(init.accountKey, init.execCallId);
    const existing = this.records.get(key);
    if (existing) this.remove(existing);
    const now = this.now();
    const record: ExecRecord = {
      accountKey: init.accountKey,
      sessionKey: init.sessionKey,
      execCallId: init.execCallId,
      originalCallId: init.originalCallId,
      source: init.source,
      shape: init.shape,
      state: init.state ?? "running",
      batches: [],
      outputs: new Map(),
      reasoningItems: init.reasoningItems,
      maxOutputTokens: init.maxOutputTokens,
      startedAt: now,
      lastTouched: now,
      bytes: 0,
    };
    record.bytes = recordBytes(record);
    this.records.set(key, record);
    this.evicted.delete(key);
    if (!isLive(record.state)) {
      this.settledBytes += record.bytes;
      this.enforceCaps();
    }
    return record;
  }

  /**
   * The record, touched. A suspended record whose runtime is gone (module
   * poisoned, evicted by the live cap) is moved to `lost` first.
   */
  get(accountKey: string, execCallId: string): ExecRecord | undefined {
    const record = this.records.get(recordKey(accountKey, execCallId));
    if (!record) return undefined;
    record.lastTouched = this.now();
    this.loseIfRuntimeGone(record);
    return record;
  }

  /**
   * A suspended record whose runtime is gone (evicted for the live cap, a
   * retired or poisoned module) moves to `lost` NOW, so it leaves the
   * suspended set and enters the settled caps. The runtime's `onEvicted`
   * calls this; `get()` and the reaper catch any it missed.
   */
  loseIfRuntimeGone(record: ExecRecord): void {
    if (record.state === "suspended" && (!record.runtime || !record.runtime.alive)) {
      this.transition(record, "evict");
    }
  }

  /** The record without touching it or checking its runtime. */
  peek(accountKey: string, execCallId: string): ExecRecord | undefined {
    return this.records.get(recordKey(accountKey, execCallId));
  }

  /** True when the record was evicted under the caps (not merely never seen). */
  isEvicted(accountKey: string, execCallId: string): boolean {
    return this.evicted.has(recordKey(accountKey, execCallId));
  }

  /** Every suspended record owned by `sessionKey`. */
  suspendedOwnedBy(sessionKey: string): ExecRecord[] {
    const out: ExecRecord[] = [];
    for (const record of this.records.values()) {
      if (record.state === "suspended" && record.sessionKey === sessionKey) out.push(record);
    }
    return out;
  }

  /**
   * Apply `event`. An illegal transition is logged and coerced to `lost`
   * (never thrown). Returns the new state.
   */
  transition(record: ExecRecord, event: ExecEvent): ExecState {
    const from = record.state;
    const legal = TRANSITIONS[from][event];
    const to: ExecState = legal ?? "lost";
    if (!legal) {
      log(
        `[CodeMode] exec ${record.execCallId}: illegal transition ${event} from ${from}; record coerced to lost`
      );
    }
    if (!legal || ENDS_RUNTIME.has(event)) this.disposeRuntime(record);
    const wasLive = isLive(from);
    record.state = to;
    record.lastTouched = this.now();
    const nowLive = isLive(to);
    if (!nowLive) for (const batch of record.batches) batch.blocks = undefined;
    if (wasLive && !nowLive) this.settledBytes += record.bytes;
    else if (!wasLive && nowLive) this.settledBytes -= record.bytes;
    if (!nowLive) this.enforceCaps();
    return to;
  }

  /** Attach a runtime to a running record (the store disposes it on the ending transitions). */
  attachRuntime(record: ExecRecord, runtime: ScriptRuntime): void {
    if (record.runtime && record.runtime !== runtime) record.runtime.dispose();
    record.runtime = runtime;
  }

  /** Store the reasoning items of the leg that produced the exec. */
  setReasoning(record: ExecRecord, items: ResponsesItem[] | undefined): void {
    this.rebytes(record, () => {
      record.reasoningItems = items && items.length > 0 ? items : undefined;
    });
  }

  /**
   * Store `output` under `completionKey`. A tombstone never overwrites a `run`
   * output for the same key.
   */
  storeOutput(
    record: ExecRecord,
    completionKey: string,
    output: ExecOutput,
    origin: StoredOutput["origin"],
    sessionKey: string
  ): void {
    const existing = record.outputs.get(completionKey);
    if (existing?.origin === "run" && origin === "tombstone") return;
    this.rebytes(record, () => {
      record.outputs.set(completionKey, { output, origin, sessionKey });
    });
    record.lastTouched = this.now();
    if (!isLive(record.state)) this.enforceCaps();
  }

  /**
   * The output to render for `completionKey`: a `run` output from any session
   * (a function of source + results, so a fork with the same history renders it
   * identically), else a tombstone stored by THIS session.
   */
  lookupOutput(
    accountKey: string,
    execCallId: string,
    completionKey: string,
    sessionKey: string
  ): StoredOutput | undefined {
    const record = this.records.get(recordKey(accountKey, execCallId));
    const stored = record?.outputs.get(completionKey);
    if (!stored) return undefined;
    if (stored.origin === "run" || stored.sessionKey === sessionKey) {
      if (record) record.lastTouched = this.now();
      return stored;
    }
    return undefined;
  }

  // ─── pins ───────────────────────────────────────────────────────────

  /** This session relayed an exec: keep it in code mode while its arm stays OAuth. */
  pin(sessionKey: string): void {
    this.pins.add(sessionKey);
  }

  isPinned(sessionKey: string): boolean {
    return this.pins.has(sessionKey);
  }

  // ─── caps and reaping ───────────────────────────────────────────────

  /** Lose suspended records whose runtime is gone, expire idle ones, enforce the caps. */
  reap(): void {
    const now = this.now();
    for (const record of [...this.records.values()]) {
      this.loseIfRuntimeGone(record);
      if (record.state === "suspended" && now - record.lastTouched > this.limits.suspendedTtlMs) {
        this.transition(record, "expire");
      }
    }
    this.enforceCaps();
  }

  /** Start the 60 s reaper (idempotent; unref'd so it never holds the process). */
  startReaper(): void {
    if (this.reaper) return;
    this.reaper = setInterval(() => {
      try {
        this.reap();
      } catch (err) {
        log(`[CodeMode] script store reaper failed: ${err}`);
      }
    }, this.limits.reapIntervalMs);
    this.reaper.unref?.();
  }

  stopReaper(): void {
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = undefined;
  }

  /** Records currently held. */
  get size(): number {
    return this.records.size;
  }

  /** Counted bytes of settled records (the 32 MiB cap applies to this). */
  get bytes(): number {
    return this.settledBytes;
  }

  /** Drop everything, disposing every runtime (tests; a process reset). */
  clear(): void {
    for (const record of this.records.values()) this.disposeRuntime(record);
    this.records.clear();
    this.settledBytes = 0;
  }

  private settledCount(): number {
    let n = 0;
    for (const record of this.records.values()) if (!isLive(record.state)) n++;
    return n;
  }

  private enforceCaps(): void {
    let count = this.settledCount();
    if (count <= this.limits.maxRecords && this.settledBytes <= this.limits.maxBytes) return;
    const settled = [...this.records.values()]
      .filter((r) => !isLive(r.state))
      .sort((a, b) => a.lastTouched - b.lastTouched);
    for (const record of settled) {
      if (count <= this.limits.maxRecords && this.settledBytes <= this.limits.maxBytes) break;
      this.remove(record);
      this.evicted.add(recordKey(record.accountKey, record.execCallId));
      count--;
    }
    log(
      `[CodeMode] script store over its cap; evicted to ${count} record(s), ${this.settledBytes} bytes`
    );
  }

  private remove(record: ExecRecord): void {
    this.disposeRuntime(record);
    this.records.delete(recordKey(record.accountKey, record.execCallId));
    if (!isLive(record.state)) this.settledBytes -= record.bytes;
  }

  private rebytes(record: ExecRecord, mutate: () => void): void {
    const before = record.bytes;
    mutate();
    record.bytes = recordBytes(record);
    if (!isLive(record.state)) this.settledBytes += record.bytes - before;
  }

  private disposeRuntime(record: ExecRecord): void {
    const runtime = record.runtime;
    record.runtime = undefined;
    if (!runtime) return;
    try {
      runtime.dispose();
    } catch (err) {
      log(`[CodeMode] exec ${record.execCallId}: disposing its runtime failed: ${err}`);
    }
  }
}
