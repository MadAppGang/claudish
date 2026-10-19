/**
 * The Responses `input` of a code-mode request, built straight from Claude
 * Code's `claudeRequest.messages` — never from the step-3 conversion, which is
 * lossy for this purpose: it lifts tool_result images into separate messages,
 * synthesizes results for unanswered calls, joins assistant text blocks, and
 * knows nothing of exec scripts.
 *
 * Walk, in order (architecture §5.10):
 *  - assistant message: its turn record's items verbatim when one exists (how
 *    interstitial execs and multi-leg text come back in order), else its text
 *    blocks as one `output_text` message each; then the exec groups it starts.
 *    Thinking blocks are not sent (reasoning travels as encrypted items).
 *  - exec group (the nested tool_uses whose ids decode to one exec, across every
 *    round trip of that script): the exec's reasoning items and its
 *    `custom_tool_call` ONCE, at its first round; its `custom_tool_call_output`
 *    ONCE, after the round that completed it, looked up by completion key. A
 *    script whose record is gone is reconstructed from history: an evicted one
 *    or one lost to a restart renders `Script completed` with a note saying
 *    which, never `Script failed` for a script that resolved in the past.
 *  - user message: text and images as `input_text` / `input_image`; text beside
 *    tool results goes AFTER the outputs they sit beside, in arrival order.
 *  - orphan tool_result (its call is in no earlier assistant message, e.g.
 *    compaction removed it): rendered as user text `[Tool Result]: <text>` with
 *    its images after it, as the step-3 converter does; never dropped.
 *  - classic tool round (ids that do not decode: a session that started classic,
 *    a `/model` switch, parallel-wrapper `_p<k>` ids, a stray classic call):
 *    transliterated into ONE synthetic exec (`transliterate.ts`) — the call at
 *    the assistant message, its `Script completed` output after the message
 *    that answers it — so a request never mixes classic `function_call` items
 *    with the exec tool.
 *
 * Two sets keep the once-only rules mechanical for the whole walk: emitted
 * `call_id`s and emitted reasoning (by item id, else the sha256 of its
 * `encrypted_content`). Output is byte-identical for byte-identical history
 * and store state, so the prompt-cache prefix is stable; the eviction
 * renderings are pure functions of history plus the eviction sets, so the
 * prefix changes once, on the first request after an eviction.
 */

import { createHash } from "node:crypto";
import { log } from "../logger.js";
import { DEFAULT_EXEC_MAX_OUTPUT_TOKENS, EXEC_TOOL_NAME } from "./exec-tool.js";
import { type BatchResultEntry, batchHash, completionKey } from "./hashes.js";
import { decodeNestedId } from "./ids.js";
import {
  type ExecOutput,
  type ImageRef,
  type OutputPart,
  type ResponsesOutputPart,
  formatExecOutput,
} from "./output.js";
import type { CodeModeStores } from "./stores.js";
import { type ToolNameTable, normalizeToolIdent } from "./tool-names.js";
import { imageUrlOf, toolResultImages, toolResultText } from "./tool-results.js";
import { transliterateRound } from "./transliterate.js";
import { turnAnchorFor } from "./turn-records.js";
import type { ClaudeContentBlock, ClaudeMessage, ResponsesItem } from "./types.js";

/** Whose records a request may read. */
export interface CodeModeKeys {
  accountKey: string;
  sessionKey: string;
}

export interface BuildCodeModeInputOptions {
  /** Output budget for an exec whose record names none (discovery's truncation limit). */
  defaultMaxOutputTokens?: number;
  /** Today's exec-tool identifiers; a transliterated call to a tool absent from it uses `tools["name"]`. */
  toolNames?: ToolNameTable;
}

/** A classic round awaiting its transliterated output. */
interface PendingClassicRound {
  assistantIndex: number;
  uses: ClaudeContentBlock[];
  done: boolean;
}

/** First line of a reconstructed script. */
export const RECONSTRUCTED_SOURCE_HEADER =
  "// reconstructed by claudish: original script unavailable";
export const EVICTED_OUTPUT_NOTE =
  "claudish evicted this script's stored output under its memory limit; the nested tool results follow";
export const RESTART_OUTPUT_NOTE =
  "output unavailable after a claudish restart; the nested tool results follow";
export const LOST_SCRIPT_NOTE =
  "claudish lost this script's state (proxy restart or eviction); the nested tool results it was waiting for follow";
export const MOVED_ON_NOTE = "the conversation moved on without the tool results";

interface Round {
  assistantIndex: number;
  blocks: ClaudeContentBlock[];
}

interface ExecGroup {
  execKey: string;
  rounds: Round[];
}

function blocksOf(message: ClaudeMessage | undefined): ClaudeContentBlock[] {
  return message && Array.isArray(message.content) ? message.content : [];
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function reasoningKey(item: ResponsesItem): string | undefined {
  if (typeof item.id === "string" && item.id) return `id:${item.id}`;
  if (typeof item.encrypted_content === "string") return `enc:${sha256Hex(item.encrypted_content)}`;
  return undefined;
}

const CALL_TYPES = new Set(["custom_tool_call", "function_call"]);
const OUTPUT_TYPES = new Set(["custom_tool_call_output", "function_call_output"]);

/** The key under which an item may be emitted only once; undefined for any other item. */
function onceKey(item: ResponsesItem): string | undefined {
  if (item.type === "reasoning") {
    const key = reasoningKey(item);
    return key ? `reasoning:${key}` : undefined;
  }
  const callId = typeof item.call_id === "string" && item.call_id ? item.call_id : undefined;
  if (!callId) return undefined;
  if (CALL_TYPES.has(item.type)) return `call:${callId}`;
  if (OUTPUT_TYPES.has(item.type)) return `output:${callId}`;
  return undefined;
}

/**
 * The source shown for an exec whose record is gone: one
 * `Promise.allSettled([...])` per batch the script emitted, from history.
 */
export function reconstructExecSource(
  batches: ReadonlyArray<ReadonlyArray<{ name: string; input: unknown }>>
): string {
  const lines = [RECONSTRUCTED_SOURCE_HEADER];
  for (const batch of batches) {
    const calls = batch.map(
      (call) => `tools.${normalizeToolIdent(call.name)}(${JSON.stringify(call.input ?? {})})`
    );
    lines.push(`await Promise.allSettled([${calls.join(", ")}]);`);
  }
  return lines.join("\n");
}

class InputBuilder {
  private readonly out: ResponsesItem[] = [];
  /** Once-only keys: `call:<call_id>`, `output:<call_id>`, `reasoning:<id|enc hash>`. */
  private readonly emitted = new Set<string>();
  /** tool_use id → index of the assistant message carrying it (first occurrence). */
  private readonly toolUseAt = new Map<string, number>();
  /** tool_use id → its tool_result block (first occurrence). */
  private readonly results = new Map<string, ClaudeContentBlock>();
  private readonly groups = new Map<string, ExecGroup>();
  private readonly classicRounds: PendingClassicRound[] = [];
  private loggedOrphan = false;

  constructor(
    private readonly messages: readonly ClaudeMessage[],
    private readonly stores: CodeModeStores,
    private readonly keys: CodeModeKeys,
    private readonly defaultMaxOutputTokens: number,
    private readonly toolNames?: ToolNameTable
  ) {
    this.index();
  }

  build(): ResponsesItem[] {
    for (let i = 0; i < this.messages.length; i++) {
      const message = this.messages[i];
      if (message?.role === "assistant") this.assistant(i);
      else if (message?.role === "user") this.user(i);
    }
    return this.out;
  }

  // ─── indexing ───────────────────────────────────────────────────────

  private index(): void {
    for (let i = 0; i < this.messages.length; i++) {
      const message = this.messages[i];
      for (const block of blocksOf(message)) {
        if (message.role === "assistant") this.indexToolUse(i, block);
        else if (message.role === "user") this.indexToolResult(block);
      }
    }
  }

  private indexToolUse(i: number, block: ClaudeContentBlock): void {
    if (block.type !== "tool_use" || typeof block.id !== "string") return;
    if (this.toolUseAt.has(block.id)) return;
    this.toolUseAt.set(block.id, i);
    const nested = decodeNestedId(block.id);
    if (nested) this.addToGroup(nested.execKey, i, block);
  }

  private indexToolResult(block: ClaudeContentBlock): void {
    if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") return;
    if (!this.results.has(block.tool_use_id)) this.results.set(block.tool_use_id, block);
  }

  private addToGroup(execKey: string, assistantIndex: number, block: ClaudeContentBlock): void {
    let group = this.groups.get(execKey);
    if (!group) {
      group = { execKey, rounds: [] };
      this.groups.set(execKey, group);
    }
    let round = group.rounds[group.rounds.length - 1];
    if (!round || round.assistantIndex !== assistantIndex) {
      round = { assistantIndex, blocks: [] };
      group.rounds.push(round);
    }
    round.blocks.push(block);
  }

  // ─── emission helpers ───────────────────────────────────────────────

  private push(item: ResponsesItem): void {
    const key = onceKey(item);
    if (key !== undefined) {
      if (this.emitted.has(key)) return;
      this.emitted.add(key);
    }
    this.out.push(item);
  }

  private outputEmitted(callId: string): boolean {
    return this.emitted.has(`output:${callId}`);
  }

  private assistantText(text: string): void {
    if (!text) return;
    this.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
  }

  // ─── assistant messages ─────────────────────────────────────────────

  private assistant(i: number): void {
    const message = this.messages[i];
    const anchor = turnAnchorFor(this.keys.sessionKey, message, this.messages[i - 1]);
    const record = this.stores.turns.get(this.keys.sessionKey, anchor);
    if (record) {
      for (const item of record.items) this.push(item);
    } else if (typeof message.content === "string") {
      this.assistantText(message.content);
    } else {
      for (const block of message.content) {
        if (block.type === "text" && typeof block.text === "string") this.assistantText(block.text);
      }
    }
    const startedHere = new Set<string>();
    const classicUses: ClaudeContentBlock[] = [];
    for (const block of blocksOf(message)) {
      if (block.type !== "tool_use" || typeof block.id !== "string") continue;
      if (this.toolUseAt.get(block.id) !== i) continue;
      const nested = decodeNestedId(block.id);
      if (!nested) {
        classicUses.push(block);
        continue;
      }
      const group = this.groups.get(nested.execKey);
      if (group && group.rounds[0]?.assistantIndex === i && !startedHere.has(nested.execKey)) {
        startedHere.add(nested.execKey);
        this.startGroup(group);
      }
    }
    if (classicUses.length > 0) this.startClassicRound(i, classicUses);
  }

  // ─── classic rounds (transliterated) ────────────────────────────────

  /** A classic round's synthetic exec call; its output follows the message that answers it. */
  private startClassicRound(i: number, uses: ClaudeContentBlock[]): void {
    const round = transliterateRound({ uses, results: new Map() }, { names: this.toolNames });
    this.push(round.call);
    this.classicRounds.push({ assistantIndex: i, uses, done: false });
  }

  /**
   * The transliterated output of every classic round message `i` answers: the
   * first user message after the round (a missing result reads as not
   * returned, as the step-3 converter synthesizes one). A round on the last
   * message (a prefill) has no answer yet and gets the call alone.
   */
  private completeClassicRounds(i: number): void {
    for (const pending of this.classicRounds) {
      if (pending.done || pending.assistantIndex >= i) continue;
      let firstUser = true;
      for (let j = pending.assistantIndex + 1; j < i; j++) {
        if (this.messages[j]?.role === "user") firstUser = false;
      }
      if (!firstUser) continue;
      pending.done = true;
      const round = transliterateRound(
        { uses: pending.uses, results: this.results },
        { names: this.toolNames }
      );
      this.push({
        type: "custom_tool_call_output",
        call_id: round.callId,
        output: formatExecOutput(round.output, {
          maxOutputTokens: this.defaultMaxOutputTokens,
          resolveImage: (ref) => this.resolveImage(ref),
        }),
      });
    }
  }

  private callIdOf(group: ExecGroup): string {
    const record = this.stores.scripts.peek(this.keys.accountKey, group.execKey);
    return record?.originalCallId ?? `call_${group.execKey}`;
  }

  private startGroup(group: ExecGroup): void {
    const record = this.stores.scripts.peek(this.keys.accountKey, group.execKey);
    for (const item of record?.reasoningItems ?? []) this.push(item);
    const source =
      record?.source ??
      reconstructExecSource(
        group.rounds.map((round) =>
          round.blocks.map((b) => ({
            name: typeof b.name === "string" ? b.name : "",
            input: b.input,
          }))
        )
      );
    this.push({
      type: "custom_tool_call",
      call_id: this.callIdOf(group),
      name: EXEC_TOOL_NAME,
      input: source,
    });
  }

  // ─── user messages ──────────────────────────────────────────────────

  private user(i: number): void {
    const message = this.messages[i];
    if (typeof message.content === "string") {
      this.closeMovedOnGroups(i);
      this.completeClassicRounds(i);
      if (message.content) {
        this.push({
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: message.content }],
        });
      }
      return;
    }
    const parts: ResponsesOutputPart[] = [];
    const seen = new Set<string>();
    const touchedGroups: string[] = [];
    for (const block of message.content) {
      if (block.type === "text" && typeof block.text === "string") {
        parts.push({ type: "input_text", text: block.text });
      } else if (block.type === "image") {
        const url = imageUrlOf(block);
        if (url) parts.push({ type: "input_image", image_url: url });
      } else if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        if (seen.has(block.tool_use_id)) continue;
        seen.add(block.tool_use_id);
        this.toolResult(i, block, parts, touchedGroups);
      }
    }
    for (const execKey of touchedGroups) this.maybeCompleteGroup(execKey, i);
    this.closeMovedOnGroups(i);
    this.completeClassicRounds(i);
    if (parts.length > 0) this.push({ type: "message", role: "user", content: parts });
  }

  private toolResult(
    i: number,
    block: ClaudeContentBlock,
    parts: ResponsesOutputPart[],
    touchedGroups: string[]
  ): void {
    const id = block.tool_use_id as string;
    const callAt = this.toolUseAt.get(id);
    if (callAt === undefined || callAt >= i) {
      this.orphan(block, parts);
      return;
    }
    const nested = decodeNestedId(id);
    if (nested && !touchedGroups.includes(nested.execKey)) touchedGroups.push(nested.execKey);
    // A classic result is read from `results` when its round's transliterated
    // output is emitted (completeClassicRounds); its images go inside that output.
  }

  private orphan(block: ClaudeContentBlock, parts: ResponsesOutputPart[]): void {
    if (!this.loggedOrphan) {
      this.loggedOrphan = true;
      log(
        `[CodeMode] tool result ${block.tool_use_id} answers no earlier call; rendered as user text`
      );
    }
    parts.push({ type: "input_text", text: `[Tool Result]: ${toolResultText(block)}` });
    for (const image of toolResultImages(block)) {
      const url = imageUrlOf(image);
      if (url) parts.push({ type: "input_image", image_url: url });
    }
  }

  // ─── exec outputs ───────────────────────────────────────────────────

  /** True when message `i` answers the group's LAST round (the script ended there). */
  private completesAt(group: ExecGroup, i: number): boolean {
    const last = group.rounds[group.rounds.length - 1];
    if (!last || last.assistantIndex >= i) return false;
    // Only the first user message after the last round answers it.
    for (let j = last.assistantIndex + 1; j < i; j++) {
      if (this.messages[j]?.role === "user") return false;
    }
    return true;
  }

  private maybeCompleteGroup(execKey: string, i: number): void {
    const group = this.groups.get(execKey);
    if (!group || !this.completesAt(group, i)) return;
    this.emitOutput(group, this.hasLaterAssistant(i));
  }

  /**
   * A group whose last round was the previous assistant message and that this
   * message does not answer at all: the conversation moved on without results.
   */
  private closeMovedOnGroups(i: number): void {
    const previous = i - 1;
    if (this.messages[previous]?.role !== "assistant") return;
    for (const group of this.groups.values()) {
      const last = group.rounds[group.rounds.length - 1];
      if (!last || last.assistantIndex !== previous) continue;
      const answered = last.blocks.some((b) => this.results.has(b.id as string));
      if (answered) continue;
      this.emitOutput(group, true, MOVED_ON_NOTE);
    }
  }

  private hasLaterAssistant(i: number): boolean {
    for (let j = i + 1; j < this.messages.length; j++) {
      if (this.messages[j]?.role === "assistant") return true;
    }
    return false;
  }

  private batchEntries(round: Round): BatchResultEntry[] {
    return round.blocks.map((b) => {
      const id = b.id as string;
      const result = this.results.get(id);
      return result
        ? {
            toolUseId: id,
            result: { isError: result.is_error === true, content: result.content ?? "" },
          }
        : { toolUseId: id };
    });
  }

  private emitOutput(group: ExecGroup, followedByAssistant: boolean, movedOnNote?: string): void {
    const callId = this.callIdOf(group);
    if (this.outputEmitted(callId)) return;
    const key = completionKey(group.rounds.map((round) => batchHash(this.batchEntries(round))));
    const record = this.stores.scripts.peek(this.keys.accountKey, group.execKey);
    const stored = this.stores.scripts.lookupOutput(
      this.keys.accountKey,
      group.execKey,
      key,
      this.keys.sessionKey
    );
    const maxOutputTokens = record?.maxOutputTokens ?? this.defaultMaxOutputTokens;
    let output: ResponsesOutputPart[];
    if (stored) {
      output = formatExecOutput(stored.output, {
        maxOutputTokens,
        resolveImage: (ref) => this.resolveImage(ref),
      });
    } else if (movedOnNote) {
      output = this.notedOutput(group, "terminated", movedOnNote, maxOutputTokens);
    } else if (!record && followedByAssistant) {
      const evicted = this.stores.scripts.isEvicted(this.keys.accountKey, group.execKey);
      output = this.notedOutput(
        group,
        "completed",
        evicted ? EVICTED_OUTPUT_NOTE : RESTART_OUTPUT_NOTE,
        maxOutputTokens
      );
    } else {
      output = this.notedOutput(group, "failed", LOST_SCRIPT_NOTE, maxOutputTokens);
    }
    this.push({ type: "custom_tool_call_output", call_id: callId, output });
  }

  /** `status` + `note` + one item per nested result (with its images), for a script with no output to show. */
  private notedOutput(
    group: ExecGroup,
    status: ExecOutput["status"],
    note: string,
    maxOutputTokens: number
  ): ResponsesOutputPart[] {
    const parts: OutputPart[] = [{ type: "text", text: note }];
    for (const round of group.rounds) {
      for (const block of round.blocks) {
        const id = block.id as string;
        const name = typeof block.name === "string" ? block.name : "";
        const call = `tools.${normalizeToolIdent(name)}(${JSON.stringify(block.input ?? {})})`;
        const result = this.results.get(id);
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
    }
    return formatExecOutput(
      { status, wallMs: undefined, parts },
      { maxOutputTokens, resolveImage: (ref) => this.resolveImage(ref) }
    );
  }

  private resolveImage(ref: ImageRef): string | undefined {
    const result = this.results.get(ref.toolUseId);
    if (!result) return undefined;
    const image = toolResultImages(result)[ref.index];
    return image ? imageUrlOf(image) : undefined;
  }
}

/**
 * The Responses `input` for `messages` (Claude Code's own, after Layer 4),
 * reading this account's and session's records from `stores`. Pure for a given
 * history and store state.
 */
export function buildCodeModeInput(
  messages: readonly ClaudeMessage[],
  stores: CodeModeStores,
  keys: CodeModeKeys,
  options: BuildCodeModeInputOptions = {}
): ResponsesItem[] {
  const builder = new InputBuilder(
    Array.isArray(messages) ? messages : [],
    stores,
    keys,
    options.defaultMaxOutputTokens ?? DEFAULT_EXEC_MAX_OUTPUT_TOKENS,
    options.toolNames
  );
  return builder.build();
}
