/**
 * The pane owner's side of the hook inbox (architecture §2.3 steps 5-6).
 *
 * A pane child appends one JSON object per line to `hook-inbox.jsonl`:
 * `stop` before a response's `message_stop` can reach Claude Code, then the
 * `inject` / `annotate` payload its `responseEnd` hooks returned, then `end` once
 * those hooks resolved (or `end` with `aborted` when the stream died first).
 *
 * At a settle the owner records the file length and reads every line up to it,
 * incrementally by byte offset. It waits only for requests that have a `stop` and
 * no `end` by then: their `responseEnd` hooks are still running. While it waits it
 * keeps reading past the recorded length, because those requests' lines can only
 * appear there; lines past the length that belong to OTHER requests are carried to
 * the next settle. A request with no `stop` is still streaming (a background
 * subagent, a side request) and is never waited for. The wait polls every 100 ms,
 * is bounded, and ends at once when the signal aborts.
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { validateAction } from "../actions.js";
import type { JsonValue } from "../public.js";

export const INBOX_POLL_MS = 100;

export type InboxLine =
  | { v: 1; kind: "stop"; req: string }
  | { v: 1; kind: "inject"; req: string; hookId: string; text: string; at?: string }
  | {
      v: 1;
      kind: "annotate";
      req: string;
      hookId: string;
      key: string;
      value: JsonValue;
      at?: string;
    }
  | { v: 1; kind: "end"; req: string; aborted?: boolean }
  | { v: 1; kind: "capped" };

/** What one drain produced, in arrival order. */
export interface InboxDrain {
  injections: Array<{ req: string; hookId: string; text: string }>;
  annotations: Array<{ req: string; hookId: string; key: string; value: JsonValue }>;
  /** a `capped` line was read in this drain (the child stopped appending payload) */
  capped: boolean;
  /** requests still without `end` when the bound expired (their later lines go to the next drain) */
  timedOut: string[];
  /**
   * payload lines that fail the action rules the child applies: a slash
   * command, an over-long text, a bad annotation key or value. Never delivered.
   */
  invalid: Array<{ req: string; hookId: string; kind: "inject" | "annotate"; reason: string }>;
}

/**
 * Re-apply, at the owner, the rules `validateAction` applies to these actions
 * in the child. The inbox is a same-user file; a line in it is not proof that a hook
 * produced it, so it is held to what a hook could have produced. Null when valid.
 */
function payloadProblem(line: InboxLine): string | null {
  if (line.kind === "inject") {
    const v = validateAction("responseEnd", { type: "injectUserTurn", text: line.text });
    return v.ok ? null : v.reason;
  }
  if (line.kind === "annotate") {
    const v = validateAction("responseEnd", {
      type: "annotateTurn",
      key: line.key,
      value: line.value,
    });
    return v.ok ? null : v.reason;
  }
  return null;
}

function parseLine(text: string): InboxLine | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o.v !== 1) return null;
  switch (o.kind) {
    case "capped":
      return { v: 1, kind: "capped" };
    case "stop":
    case "end":
      return typeof o.req === "string" ? (o as InboxLine) : null;
    case "inject":
      return typeof o.req === "string" && typeof o.hookId === "string" && typeof o.text === "string"
        ? (o as InboxLine)
        : null;
    case "annotate":
      return typeof o.req === "string" && typeof o.hookId === "string" && typeof o.key === "string"
        ? (o as InboxLine)
        : null;
    default:
      return null;
  }
}

/**
 * Where an `InboxReader` takes its lines from. The pane child's file is one source;
 * the interactive launcher's in-process sink is the other (`MemoryInbox`), so the
 * owner's drain rule — wait only for a `stop` without its `end`, bounded, abortable,
 * carry other requests' lines — is one implementation for both (§2.3).
 */
export interface InboxLineSource {
  /** Every line appended since the last call, in order. */
  readNew(): InboxLine[];
  /** Lines were appended that `readNew()` has not returned yet. */
  hasNew(): boolean;
}

/**
 * The interactive launcher's inbox: the same lines the pane child appends to its
 * file, kept in memory, because proxy and session events share one process there.
 */
export class MemoryInbox implements InboxLineSource {
  private lines: InboxLine[] = [];

  append(line: InboxLine): void {
    this.lines.push(line);
  }

  readNew(): InboxLine[] {
    const out = this.lines;
    this.lines = [];
    return out;
  }

  hasNew(): boolean {
    return this.lines.length > 0;
  }
}

/** The pane child's `hook-inbox.jsonl`, read incrementally by byte offset. */
class FileInbox implements InboxLineSource {
  /** bytes read from the file so far */
  private offset = 0;
  /**
   * The bytes of a partial line at the end of the last read, undecoded: a read can
   * end inside a multi-byte character, which decodes whole only with the rest.
   */
  private partial: Buffer = Buffer.alloc(0);

  constructor(readonly path: string) {}

  hasNew(): boolean {
    try {
      return statSync(this.path).size > this.offset;
    } catch {
      return false;
    }
  }

  /** Read every complete line appended since the last read. */
  readNew(): InboxLine[] {
    if (!existsSync(this.path)) return [];
    let fd: number;
    try {
      fd = openSync(this.path, "r");
    } catch {
      return [];
    }
    try {
      const size = fstatSync(fd).size;
      if (size <= this.offset) return [];
      const buf = Buffer.alloc(size - this.offset);
      const n = readSync(fd, buf, 0, buf.length, this.offset);
      const bytes = Buffer.concat([this.partial, buf.subarray(0, n)]);
      // 0x0A never occurs inside a multi-byte UTF-8 sequence: cutting there is safe
      const nl = bytes.lastIndexOf(0x0a);
      const complete = nl === -1 ? "" : bytes.subarray(0, nl).toString("utf8");
      this.partial = Buffer.from(nl === -1 ? bytes : bytes.subarray(nl + 1));
      this.offset += n;
      const out: InboxLine[] = [];
      for (const raw of complete.split("\n")) {
        if (!raw.trim()) continue;
        const line = parseLine(raw);
        if (line) out.push(line);
      }
      return out;
    } finally {
      closeSync(fd);
    }
  }
}

export class InboxReader {
  /** lines read earlier that belong to a later drain */
  private carried: InboxLine[] = [];
  /** requests that wrote `stop`, and those that wrote `end` */
  private readonly stopped = new Set<string>();
  private readonly ended = new Set<string>();
  private readonly source: InboxLineSource;
  /** the inbox file, or null for an in-memory source */
  readonly path: string | null;

  constructor(source: string | InboxLineSource) {
    if (typeof source === "string") {
      this.path = source;
      this.source = new FileInbox(source);
    } else {
      this.path = null;
      this.source = source;
    }
  }

  /** Lines appended since the last read, or lines carried for the next drain. */
  hasUnread(): boolean {
    return this.carried.length > 0 || this.source.hasNew();
  }

  private readNew(): InboxLine[] {
    return this.source.readNew();
  }

  /**
   * Forget requests that are finished, so a long session's sets stay small. A request
   * that ended before `message_stop` wrote only its `end` and was never in `stopped`;
   * it is forgotten too. An `end` is always its request's last line.
   */
  private prune(): void {
    for (const req of this.ended) this.stopped.delete(req);
    this.ended.clear();
  }

  private note(line: InboxLine): void {
    if (line.kind === "stop") this.stopped.add(line.req);
    else if (line.kind === "end") this.ended.add(line.req);
  }

  /**
   * One settle's drain. `boundMs` caps the wait for requests whose `responseEnd`
   * hooks are still running; `signal` ends it at once (pane exit, terminal state,
   * an aborted hold).
   */
  async drain(boundMs: number, signal?: AbortSignal): Promise<InboxDrain> {
    const out: InboxDrain = {
      injections: [],
      annotations: [],
      capped: false,
      timedOut: [],
      invalid: [],
    };
    const take = (line: InboxLine) => {
      if (line.kind === "inject" || line.kind === "annotate") {
        const reason = payloadProblem(line);
        if (reason !== null) {
          out.invalid.push({ req: line.req, hookId: line.hookId, kind: line.kind, reason });
          return;
        }
      }
      if (line.kind === "inject")
        out.injections.push({ req: line.req, hookId: line.hookId, text: line.text });
      else if (line.kind === "annotate")
        out.annotations.push({
          req: line.req,
          hookId: line.hookId,
          key: line.key,
          value: line.value,
        });
      else if (line.kind === "capped") out.capped = true;
    };

    // Everything up to the recorded length, plus what an earlier drain carried.
    const upTo = [...this.carried, ...this.readNew()];
    this.carried = [];
    for (const line of upTo) {
      this.note(line);
      take(line);
    }
    // Requests whose hooks are still running: a `stop`, no `end`.
    const waiting = new Set<string>();
    for (const req of this.stopped) if (!this.ended.has(req)) waiting.add(req);
    if (waiting.size === 0) {
      this.prune();
      return out;
    }

    const deadline = Date.now() + Math.max(0, boundMs);
    while (waiting.size > 0 && !signal?.aborted && Date.now() < deadline) {
      await sleepOrAbort(Math.min(INBOX_POLL_MS, Math.max(0, deadline - Date.now())), signal);
      for (const line of this.readNew()) {
        // The cap is the inbox's, not a request's: this settle reports it.
        if (line.kind === "capped") {
          take(line);
          continue;
        }
        const req = line.req;
        if (waiting.has(req)) {
          this.note(line);
          take(line);
          if (line.kind === "end") waiting.delete(req);
        } else {
          // Another request's line: the next settle takes it.
          this.carried.push(line);
        }
      }
    }
    // Still waiting at the bound: those requests' later lines go to the next drain.
    // They are not waited for again (their `stop` is remembered as ended).
    for (const req of waiting) {
      out.timedOut.push(req);
      this.ended.add(req);
    }
    this.prune();
    return out;
  }

  /**
   * The session is over and its writer gone: every payload line not taken yet, carried
   * or never read, with no wait. The caller journals them.
   */
  takeRemaining(): Array<Extract<InboxLine, { kind: "inject" | "annotate" }>> {
    const lines = [...this.carried, ...this.readNew()];
    this.carried = [];
    return lines.filter(
      (l): l is Extract<InboxLine, { kind: "inject" | "annotate" }> =>
        l.kind === "inject" || l.kind === "annotate"
    );
  }
}

function sleepOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Every parseable line of an inbox file; [] when it is absent or unreadable. */
export function readInboxLines(path: string): InboxLine[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: InboxLine[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    const line = parseLine(raw);
    if (line) out.push(line);
  }
  return out;
}

/** The inbox holds an `inject` or `annotate` line (the reap check of an owner without hooks). */
export function inboxHasPayload(path: string): boolean {
  return readInboxLines(path).some((l) => l.kind === "inject" || l.kind === "annotate");
}

/** The inbox file name in a channel session's directory (§2.3 step 1). */
export const HOOK_INBOX_FILE = "hook-inbox.jsonl";

/**
 * Create `<dir>/<name>` for a pane child, 0600 with an exclusive create (a stale file
 * of an earlier run on the same dir is removed first, so the create never follows a
 * planted path). Null when it cannot be created: the child then has no inbox, which
 * costs its injections, never the session.
 */
export function createHookInbox(dir: string, name: string = HOOK_INBOX_FILE): string | null {
  const path = join(dir, name);
  try {
    rmSync(path, { force: true });
    closeSync(openSync(path, "wx", 0o600));
    return path;
  } catch {
    return null;
  }
}
