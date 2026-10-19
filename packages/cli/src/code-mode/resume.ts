/**
 * Step 5r: resume a suspended exec script from the tool_results Claude Code
 * sends back (architecture §5.9).
 *
 * Runs after 5b, so the account is THIS request's (its binding), and after 3c,
 * so a synthetic reply gets the same Layer 4 hooks as a driver batch. It is
 * synchronous from the record lookup to the state transition (no `await` in
 * between), so two concurrent requests for one record serialise: the second
 * sees the batch already consumed.
 *
 * Guard (else nothing is touched and the request continues): `openai-codex`
 * (the caller's check), the binding's arm is `oauth`, an account key, a Claude
 * Code session id, ≥ 1 declared tool (5d's `no-tools` gate), and `tool_choice`
 * absent or `auto`. A named tool, `any` or
 * `none` never resumes a script: such requests are Claude Code's internal
 * one-shot calls, and consuming a batch there would run the script's next tools
 * outside the turn that owns it; the next ordinary request resumes it.
 *
 * Entry: the last user message carries tool_results whose ids decode as nested
 * ids. Only a suspended record owned by this session is resumed:
 *
 *   | situation                                       | behaviour                                  |
 *   |-------------------------------------------------|--------------------------------------------|
 *   | expected batch, no interrupt                    | resolve/reject by seq, resume: blocked →   |
 *   |                                                 |   synthetic reply; done → output stored,   |
 *   |                                                 |   the upstream turn continues              |
 *   | a result missing for an emitted id              | that call rejects "no tool_result returned"|
 *   | interrupt (`[Request interrupted by user…`)     | terminated: output so far + the results +  |
 *   |                                                 |   "interrupted by the user"; continue      |
 *   | consumed batch, same batchHash (duplicate)      | the memoised step: the same synthetic      |
 *   |                                                 |   reply, or the stored completion          |
 *   | late results for a settled record               | nothing (history renders its output)       |
 *   | consumed batch, different batchHash (rewind)    | lost path: tombstone, new completion key   |
 *   | suspended, owned by ANOTHER session (a fork)    | untouched; the fork gets a tombstone       |
 *   | record lost (eviction, poisoned module) or none | lost path: `Script failed` + the results,  |
 *   |   (restart, another account)                    |   stored as a tombstone (a minimal record  |
 *   |                                                 |   when none), so later turns render it too |
 *
 * Then, for every OTHER suspended record this session owns: if a message
 * follows the assistant message carrying its pending batch and nothing answers
 * that batch, the conversation moved on → terminated. A pending batch on the
 * LAST message (a prefill) or absent from this request (a subagent sharing the
 * session id; compaction) is left alone: TTL and LRU end it.
 */

import { extractSessionId } from "../behavior/harness.js";
import type { ClaudeToolChoice } from "../handlers/shared/format/openai-tools.js";
import { log } from "../logger.js";
import type { AuthBinding } from "../providers/transport/types.js";
import type { ClaudeToolLike } from "./exec-tool.js";
import { type BatchResultEntry, batchHash, completionKey } from "./hashes.js";
import { accountKeyFromBinding, decodeNestedId, sessionKeyFor } from "./ids.js";
import { LOST_SCRIPT_NOTE, MOVED_ON_NOTE, reconstructExecSource } from "./input-builder.js";
import type { ExecOutput, OutputPart } from "./output.js";
import type { CodeModeSetting } from "./policy.js";
import { nestedBlocksFor, settleDone, suspendBlocked } from "./relay.js";
import { replayLostScript } from "./replay.js";
import { currentQuickJSModule } from "./sandbox/quickjs-loader.js";
import type { NestedResult } from "./sandbox/script-runtime.js";
import type { ExecRecord, ScriptStore } from "./script-store.js";
import type { CodeModeStores } from "./stores.js";
import { normalizeToolIdent } from "./tool-names.js";
import { nestedResultFromToolResult, toolResultImages, toolResultText } from "./tool-results.js";
import type { ClaudeContentBlock, ClaudeMessage, NestedToolUse } from "./types.js";

/** Claude Code's interrupt marker (2.1.290: a user text block beside the results). */
export const INTERRUPT_MARKER = "[Request interrupted by user";
export const INTERRUPTED_NOTE = "interrupted by the user";
export const FORKED_SCRIPT_NOTE =
  "this script belongs to the session this one was forked from; claudish cannot run it twice";

/** What 5r decided for one request. */
export type ResumeOutcome =
  /** Nothing to resume (or the guard does not hold): the request continues unchanged. */
  | { kind: "none" }
  /** A script resolved or ended: the request continues to the upstream turn. */
  | { kind: "continue" }
  /** A script blocked again: answer with these tool_use blocks, no upstream call. */
  | { kind: "reply"; blocks: [NestedToolUse, ...NestedToolUse[]] }
  /**
   * Only with `mayRequestModule`: a lost script this request could replay, and
   * no sandbox module is loaded (a retired, poisoned or recycled one was
   * dropped). Nothing was touched; the caller awaits `loadQuickJSModule()` and
   * calls 5r again without `mayRequestModule`, so 5r itself never awaits.
   */
  | { kind: "needs-module" };

export interface ResumeOptions {
  /** The resolved code-mode setting; `off` turns matching suspended records lost. */
  setting?: CodeModeSetting;
  /**
   * Creates the process's stores when none exist yet but the last message
   * answers nested ids (the first request after a restart), so the lost-script
   * tombstone is stored before 5d builds the input. Default: never create.
   */
  createStores?: () => CodeModeStores;
  /** May answer `needs-module` (see ResumeOutcome). Default false: replay without a module tombstones. */
  mayRequestModule?: boolean;
}

/** True when the last message is a user message carrying a tool_result for a nested id. */
function lastMessageAnswersNestedIds(messages: ClaudeMessage[]): boolean {
  const last = messages[messages.length - 1];
  if (last?.role !== "user") return false;
  return blocksOf(last).some(
    (b) =>
      b.type === "tool_result" &&
      typeof b.tool_use_id === "string" &&
      decodeNestedId(b.tool_use_id) !== undefined
  );
}

interface RequestView {
  messages: ClaudeMessage[];
  accountKey: string;
  sessionKey: string;
  /** tool_use id → its block (first occurrence, assistant messages). */
  toolUses: Map<string, ClaudeContentBlock>;
  /** tool_use id → its tool_result (first occurrence, user messages), as the input builder reads them. */
  results: Map<string, ClaudeContentBlock>;
  /** Claude Code's tools in this request (a replayed script calls them). */
  tools: ClaudeToolLike[];
}

function blocksOf(message: ClaudeMessage | undefined): ClaudeContentBlock[] {
  return message && Array.isArray(message.content) ? message.content : [];
}

function isAutoToolChoice(choice: ClaudeToolChoice | null | undefined): boolean {
  return !choice || choice.type === undefined || choice.type === "auto";
}

function indexToolResults(messages: ClaudeMessage[]): Map<string, ClaudeContentBlock> {
  const out = new Map<string, ClaudeContentBlock>();
  for (const message of messages) {
    if (message?.role !== "user") continue;
    for (const block of blocksOf(message)) {
      const id = block.tool_use_id;
      if (block.type === "tool_result" && typeof id === "string" && !out.has(id))
        out.set(id, block);
    }
  }
  return out;
}

function indexToolUses(messages: ClaudeMessage[]): Map<string, ClaudeContentBlock> {
  const out = new Map<string, ClaudeContentBlock>();
  for (const message of messages) {
    if (message?.role !== "assistant") continue;
    for (const block of blocksOf(message)) {
      if (block.type === "tool_use" && typeof block.id === "string" && !out.has(block.id)) {
        out.set(block.id, block);
      }
    }
  }
  return out;
}

/** The batch's entries for hashing: each id with its tool_result, or missing. */
function batchEntries(
  ids: readonly string[],
  results: ReadonlyMap<string, ClaudeContentBlock>
): BatchResultEntry[] {
  return ids.map((id) => {
    const result = results.get(id);
    return result
      ? {
          toolUseId: id,
          result: { isError: result.is_error === true, content: result.content ?? "" },
        }
      : { toolUseId: id };
  });
}

/** One text part per nested result (`tools.X({...}) returned:` …), images by reference. */
export function resultParts(
  ids: readonly string[],
  results: ReadonlyMap<string, ClaudeContentBlock>,
  toolUses: ReadonlyMap<string, ClaudeContentBlock>
): OutputPart[] {
  const parts: OutputPart[] = [];
  for (const id of ids) {
    const use = toolUses.get(id);
    const name = typeof use?.name === "string" ? use.name : "";
    const call = `tools.${normalizeToolIdent(name)}(${JSON.stringify(use?.input ?? {})})`;
    const result = results.get(id);
    if (!result) {
      parts.push({ type: "text", text: `${call}: no tool_result returned` });
      continue;
    }
    const verb = result.is_error === true ? "rejected" : "returned";
    parts.push({ type: "text", text: `${call} ${verb}:\n${toolResultText(result)}` });
    toolResultImages(result).forEach((_, index) => {
      parts.push({ type: "image", ref: { toolUseId: id, index } });
    });
  }
  return parts;
}

/** File a tool_result under its exec key when its id decodes as a nested id. */
function addNestedResult(
  groups: Map<string, Map<string, ClaudeContentBlock>>,
  id: string,
  block: ClaudeContentBlock
): void {
  const nested = decodeNestedId(id);
  if (!nested) return;
  let group = groups.get(nested.execKey);
  if (!group) {
    group = new Map();
    groups.set(nested.execKey, group);
  }
  if (!group.has(id)) group.set(id, block);
}

/** The completion key of a record's batches 0..k, the last hashed from `lastHash`. */
function keyThrough(record: ExecRecord, k: number, lastHash: string): string {
  const hashes = record.batches.slice(0, k).map((b) => b.batchHash ?? "");
  return completionKey([...hashes, lastHash]);
}

class Resume {
  private readonly scripts: ScriptStore;

  constructor(
    private readonly view: RequestView,
    stores: CodeModeStores
  ) {
    this.scripts = stores.scripts;
  }

  /** The last message's nested tool_results grouped by exec key, and whether it carries an interrupt. */
  private lastMessageResults(): {
    groups: Map<string, Map<string, ClaudeContentBlock>>;
    interrupted: boolean;
  } {
    const groups = new Map<string, Map<string, ClaudeContentBlock>>();
    let interrupted = false;
    const last = this.view.messages[this.view.messages.length - 1];
    if (last?.role !== "user") return { groups, interrupted };
    for (const block of blocksOf(last)) {
      if (block.type === "text" && typeof block.text === "string") {
        if (block.text.trimStart().startsWith(INTERRUPT_MARKER)) interrupted = true;
      } else if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        addNestedResult(groups, block.tool_use_id, block);
      }
    }
    return { groups, interrupted };
  }

  run(): ResumeOutcome {
    const { groups, interrupted } = this.lastMessageResults();
    const replies: NestedToolUse[] = [];
    let resolved = false;
    for (const [execKey, results] of groups) {
      const outcome = this.resumeOne(execKey, results, interrupted);
      if (outcome.kind === "reply") replies.push(...outcome.blocks);
      else if (outcome.kind === "continue") resolved = true;
    }
    this.terminateMovedOn(new Set(groups.keys()));
    const [first, ...rest] = replies;
    if (first) return { kind: "reply", blocks: [first, ...rest] };
    return resolved ? { kind: "continue" } : { kind: "none" };
  }

  private resumeOne(
    execKey: string,
    results: Map<string, ClaudeContentBlock>,
    interrupted: boolean
  ): ResumeOutcome {
    const record = this.scripts.get(this.view.accountKey, execKey);
    // An evicted runtime whose source is kept: re-run it against history first
    // (on an interrupt, only up to the answered round, then ended there).
    if (record?.state === "lost" && record.sessionKey === this.view.sessionKey) {
      const replayed = this.replay(execKey, record, results, interrupted);
      if (replayed) return replayed;
    }
    // Restart, another account's record, eviction or a poisoned module: the
    // script state is gone; the model gets Script failed and the results.
    if (!record || record.state === "lost")
      return this.tombstone(execKey, record, LOST_SCRIPT_NOTE, results);
    const k = record.batches.findIndex((b) => b.ids.some((id) => results.has(id)));
    if (k < 0) return { kind: "none" };
    const batch = record.batches[k];
    const hash = batchHash(batchEntries(batch.ids, results));
    // The script's state is a function of EVERY batch it consumed: a history
    // whose earlier results differ (a rewind) cannot resume it or reuse a step.
    if (!this.prefixMatches(record, k)) {
      log(`[CodeMode] exec ${record.originalCallId}: earlier results changed; not resumable`);
      return this.tombstone(execKey, record, LOST_SCRIPT_NOTE, results);
    }

    if (batch.batchHash !== undefined) {
      return this.answerConsumed(execKey, record, k, batch.batchHash === hash, results);
    }
    if (record.state !== "suspended") return { kind: "none" };
    // A fork answering the original's pending batch: never resumed and never
    // touched; the owner's later answer resumes it and its run output wins.
    if (record.sessionKey !== this.view.sessionKey) {
      return this.tombstone(execKey, record, FORKED_SCRIPT_NOTE, results);
    }
    if (k !== record.batches.length - 1 || !record.runtime) return { kind: "none" };
    batch.batchHash = hash;
    try {
      return this.consume(record, k, results, interrupted);
    } catch (err) {
      // A store or sandbox failure: the script is lost, the request goes on.
      log(`[CodeMode] exec ${record.originalCallId}: resume failed; script lost: ${err}`);
      this.loseQuietly(record);
      return { kind: "none" };
    }
  }

  /**
   * Batches 0..k-1 as consumed equal this request's results for them, so
   * `keyThrough` (which copies their hashes from the record) names the key the
   * input builder computes from this history.
   */
  private prefixMatches(record: ExecRecord, k: number): boolean {
    for (let j = 0; j < k; j++) {
      const consumed = record.batches[j];
      if (consumed.batchHash !== batchHash(batchEntries(consumed.ids, this.view.results))) {
        return false;
      }
    }
    return true;
  }

  /** Results for batch `k`, which the script already consumed. */
  private answerConsumed(
    execKey: string,
    record: ExecRecord,
    k: number,
    sameResults: boolean,
    results: ReadonlyMap<string, ClaudeContentBlock>
  ): ResumeOutcome {
    // Different results (a rewind that re-ran the tools): not resumable; a
    // tombstone under the new completion key.
    if (!sameResults) return this.tombstone(execKey, record, LOST_SCRIPT_NOTE, results);
    // Another session (a fork) may read a completed output, never be handed
    // the owner's next batch: its tools would run twice, once per session.
    if (record.sessionKey !== this.view.sessionKey && record.batches[k + 1]?.blocks) {
      return this.tombstone(execKey, record, FORKED_SCRIPT_NOTE, results);
    }
    return this.replayDuplicate(record, k);
  }

  /**
   * The round the LAST message answers: the last round carrying one of its
   * tool_result ids. Never searched over the whole request's results, which
   * hold every earlier round too and so always matched round 0.
   */
  private answeredRound(
    rounds: ReadonlyArray<{ ids: string[] }>,
    answered: ReadonlyMap<string, ClaudeContentBlock>
  ): number {
    for (let k = rounds.length - 1; k >= 0; k--) {
      if (rounds[k].ids.some((id) => answered.has(id))) return k;
    }
    return -1;
  }

  /**
   * The exec's rounds in THIS request's history: the assistant messages that
   * carry its nested ids, in order (the input builder groups them the same way).
   */
  private historyRounds(execKey: string): Array<{ ids: string[]; blocks: ClaudeContentBlock[] }> {
    const rounds: Array<{ ids: string[]; blocks: ClaudeContentBlock[] }> = [];
    const seen = new Set<string>();
    for (const message of this.view.messages) {
      if (message?.role !== "assistant") continue;
      const blocks = blocksOf(message).filter(
        (b) =>
          b.type === "tool_use" &&
          typeof b.id === "string" &&
          !seen.has(b.id) &&
          decodeNestedId(b.id)?.execKey === execKey
      );
      for (const b of blocks) seen.add(b.id as string);
      if (blocks.length > 0) rounds.push({ ids: blocks.map((b) => b.id as string), blocks });
    }
    return rounds;
  }

  /**
   * The lost path: `Script failed` with `note` and the results it was waiting
   * for, stored as a TOMBSTONE under the completion key this request's history
   * gives, so the input builder renders it now and byte-identically on every
   * later request. No record (restart, another account) → a minimal one is
   * created under this account and session; a `lost` record is answered
   * (→ failed); a live record owned by another session is not touched beyond
   * the tombstone, which only this session renders.
   */
  private tombstone(
    execKey: string,
    record: ExecRecord | undefined,
    note: string,
    lastResults: ReadonlyMap<string, ClaudeContentBlock>
  ): ResumeOutcome {
    const rounds = this.historyRounds(execKey);
    const answered = this.answeredRound(rounds, lastResults);
    if (answered < 0) return { kind: "none" };
    try {
      const key = completionKey(
        rounds.slice(0, answered + 1).map((r) => batchHash(batchEntries(r.ids, this.view.results)))
      );
      const target =
        record ??
        this.scripts.create({
          accountKey: this.view.accountKey,
          sessionKey: this.view.sessionKey,
          execCallId: execKey,
          originalCallId: `call_${execKey}`,
          source: reconstructExecSource(
            rounds.map((r) =>
              r.blocks.map((b) => ({
                name: typeof b.name === "string" ? b.name : "",
                input: b.input,
              }))
            )
          ),
          shape: "classic",
          state: "lost",
        });
      if (target.state === "lost") this.scripts.transition(target, "answer");
      const output: ExecOutput = {
        status: "failed",
        wallMs: undefined,
        parts: [
          { type: "text", text: note },
          ...resultParts(rounds[answered].ids, this.view.results, this.view.toolUses),
        ],
      };
      this.scripts.storeOutput(target, key, output, "tombstone", this.view.sessionKey);
      log(
        `[CodeMode] exec ${target.originalCallId}: answered as Script failed (${note.split(";")[0]})`
      );
      return { kind: "continue" };
    } catch (err) {
      log(`[CodeMode] exec call_${execKey}: storing the Script failed answer failed: ${err}`);
      return { kind: "none" };
    }
  }

  /** C6: replay a lost script from history when this request answers its LAST round. */
  private replay(
    execKey: string,
    record: ExecRecord,
    lastResults: ReadonlyMap<string, ClaudeContentBlock>,
    interrupted: boolean
  ): ResumeOutcome | undefined {
    const rounds = this.historyRounds(execKey);
    const answered = this.answeredRound(rounds, lastResults);
    if (answered < 0 || answered !== rounds.length - 1) return undefined;
    const replayed = replayLostScript({
      scripts: this.scripts,
      record,
      rounds,
      results: this.view.results,
      tools: this.view.tools,
      sessionKey: this.view.sessionKey,
      interrupted,
    });
    if (!replayed) return undefined;
    if (replayed.kind === "interrupted") {
      // The live path's terminated output: what ran before the interrupt, the
      // results it was waiting for, the note. No further tool call is emitted.
      try {
        const { output } = replayed;
        output.parts.push(...resultParts(rounds[answered].ids, lastResults, this.view.toolUses));
        output.parts.push({ type: "text", text: INTERRUPTED_NOTE });
        this.scripts.storeOutput(record, replayed.key, output, "run", this.view.sessionKey);
        this.scripts.transition(record, "terminate");
        return { kind: "continue" };
      } catch (err) {
        log(`[CodeMode] exec ${record.originalCallId}: storing the interrupt failed: ${err}`);
        return undefined;
      }
    }
    return replayed.kind === "reply" ? replayed : { kind: "continue" };
  }

  /** A duplicate of a request already answered: the memoised step. */
  private replayDuplicate(record: ExecRecord, k: number): ResumeOutcome {
    const [first, ...rest] = record.batches[k + 1]?.blocks ?? [];
    if (first) {
      log(`[CodeMode] exec ${record.originalCallId}: duplicate request; same reply replayed`);
      return { kind: "reply", blocks: [first, ...rest] };
    }
    // The stored completion answers it; the upstream turn starts again (the
    // first answer never reached Claude Code; the script is the idempotency
    // boundary, not the upstream turn).
    return { kind: "continue" };
  }

  /** Feed batch `k`'s results to the suspended script (or end it on an interrupt). */
  private consume(
    record: ExecRecord,
    k: number,
    results: ReadonlyMap<string, ClaudeContentBlock>,
    interrupted: boolean
  ): ResumeOutcome {
    const runtime = record.runtime as NonNullable<ExecRecord["runtime"]>;
    const batch = record.batches[k];
    const key = keyThrough(record, k, batch.batchHash ?? "");
    if (interrupted) {
      const output = runtime.terminate("");
      output.parts.push(...resultParts(batch.ids, results, this.view.toolUses));
      output.parts.push({ type: "text", text: INTERRUPTED_NOTE });
      this.scripts.storeOutput(record, key, output, "run", this.view.sessionKey);
      this.scripts.transition(record, "terminate");
      log(`[CodeMode] exec ${record.originalCallId}: interrupted by the user; terminated`);
      return { kind: "continue" };
    }
    const nestedResults: NestedResult[] = [];
    for (const id of batch.ids) {
      const seq = decodeNestedId(id)?.seq;
      const block = results.get(id);
      // A missing result is left out: the runtime rejects that call "no tool_result returned".
      if (seq !== undefined && block) nestedResults.push(nestedResultFromToolResult(seq, block));
    }
    this.scripts.transition(record, "resume");
    const step = runtime.resume(nestedResults);
    if (step.kind === "blocked") {
      const blocks = nestedBlocksFor(record.execCallId, step.calls);
      suspendBlocked(this.scripts, record, blocks);
      log(`[CodeMode] exec ${record.originalCallId}: resumed; blocked on ${blocks.length} call(s)`);
      return { kind: "reply", blocks };
    }
    settleDone(this.scripts, record, step.output, key, this.view.sessionKey);
    log(`[CodeMode] exec ${record.originalCallId}: resumed; ${step.output.status}`);
    return { kind: "continue" };
  }

  private loseQuietly(record: ExecRecord): void {
    try {
      if (record.state === "running") this.scripts.transition(record, "fail");
      else if (record.state === "suspended") this.scripts.transition(record, "evict");
    } catch {
      // Lost either way.
    }
  }

  /** The other-entry scan: a pending batch the conversation moved past is terminated. */
  private terminateMovedOn(handled: ReadonlySet<string>): void {
    const { messages } = this.view;
    for (const record of this.scripts.suspendedOwnedBy(this.view.sessionKey)) {
      if (handled.has(record.execCallId)) continue;
      const pending = record.batches[record.batches.length - 1];
      if (!pending || pending.batchHash !== undefined) continue;
      const ids = new Set(pending.ids);
      const at = messages.findIndex(
        (m) =>
          m?.role === "assistant" &&
          blocksOf(m).some((b) => b.type === "tool_use" && ids.has(b.id as string))
      );
      // Absent (another thread, compaction) or the last message (a prefill): leave it.
      if (at < 0 || at === messages.length - 1) continue;
      const answered = messages
        .slice(at + 1)
        .some((m) =>
          blocksOf(m).some((b) => b.type === "tool_result" && ids.has(b.tool_use_id as string))
        );
      if (answered) continue;
      try {
        const output: ExecOutput = record.runtime
          ? record.runtime.terminate(MOVED_ON_NOTE)
          : {
              status: "terminated",
              wallMs: undefined,
              parts: [{ type: "text", text: MOVED_ON_NOTE }],
            };
        const key = keyThrough(
          record,
          record.batches.length - 1,
          batchHash(pending.ids.map((id) => ({ toolUseId: id })))
        );
        this.scripts.storeOutput(record, key, output, "run", this.view.sessionKey);
        this.scripts.transition(record, "terminate");
        log(`[CodeMode] exec ${record.originalCallId}: the conversation moved on; terminated`);
      } catch (err) {
        log(`[CodeMode] exec ${record.originalCallId}: terminating failed; script lost: ${err}`);
        this.loseQuietly(record);
      }
    }
  }

  /**
   * True when the last message answers a script this session owns whose
   * runtime is gone but whose source is kept — the case `run()` replays.
   * Read-only (`peek`, no transition), so a `needs-module` answer touches
   * nothing.
   */
  wouldReplay(): boolean {
    const { groups } = this.lastMessageResults();
    for (const execKey of groups.keys()) {
      const record = this.scripts.peek(this.view.accountKey, execKey);
      if (!record || record.sessionKey !== this.view.sessionKey) continue;
      if (!record.source || record.batches.length === 0) continue;
      const runtimeGone =
        record.state === "lost" ||
        (record.state === "suspended" && (!record.runtime || !record.runtime.alive));
      if (runtimeGone) return true;
    }
    return false;
  }

  /** Setting `off`: every suspended record the last message answers is lost (runtime disposed). */
  loseAnswered(): void {
    const { groups } = this.lastMessageResults();
    for (const execKey of groups.keys()) {
      const record = this.scripts.peek(this.view.accountKey, execKey);
      if (record?.state === "suspended") {
        log(`[CodeMode] exec ${record.originalCallId}: code mode is off; script dropped`);
        this.scripts.transition(record, "evict");
      }
    }
  }
}

/**
 * Step 5r for one `openai-codex` request. Never throws and never awaits: a
 * failure loses the script, never the request.
 */
export function resumeFromToolResults(
  req: { messages?: unknown; metadata?: unknown; tools?: unknown },
  binding: AuthBinding | undefined,
  stores: CodeModeStores | undefined,
  toolChoice: ClaudeToolChoice | null | undefined,
  opts: ResumeOptions = {}
): ResumeOutcome {
  try {
    if (binding?.auth?.arm !== "oauth") return { kind: "none" };
    const accountKey = accountKeyFromBinding(binding);
    const sessionKey = sessionKeyFor(extractSessionId(req), accountKey);
    if (!accountKey || !sessionKey) return { kind: "none" };
    if (!isAutoToolChoice(toolChoice)) return { kind: "none" };
    // 5d's `no-tools` gate: a tool-less request (compaction, an internal
    // summary) is never code mode, so it must not consume a batch, end the
    // session's other scripts, or be answered with tool_use blocks.
    const tools = Array.isArray(req.tools) ? (req.tools as ClaudeToolLike[]) : [];
    if (tools.length === 0) return { kind: "none" };
    const messages = Array.isArray(req.messages) ? (req.messages as ClaudeMessage[]) : [];
    let active = stores;
    if (
      !active &&
      opts.setting !== "off" &&
      opts.createStores &&
      lastMessageAnswersNestedIds(messages)
    ) {
      // After a restart: no store, but history answers a script claudish no
      // longer has. Without its tombstone the builder rendered `Script failed`
      // now and `Script completed` on the next request for the same script.
      active = opts.createStores();
    }
    if (!active) return { kind: "none" };
    const resume = new Resume(
      {
        messages,
        accountKey,
        sessionKey,
        toolUses: indexToolUses(messages),
        results: indexToolResults(messages),
        tools,
      },
      active
    );
    if (opts.setting === "off") {
      resume.loseAnswered();
      return { kind: "none" };
    }
    if (opts.mayRequestModule && !currentQuickJSModule() && resume.wouldReplay()) {
      log("[CodeMode] a lost script can replay but no sandbox module is loaded; loading one first");
      return { kind: "needs-module" };
    }
    return resume.run();
  } catch (err) {
    log(`[CodeMode] resume step failed; continuing without it: ${err}`);
    return { kind: "none" };
  }
}
