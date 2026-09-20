/**
 * The one-open-content-block invariant, in one place.
 *
 * Anthropic's streaming wire allows **exactly one open content block at a time**:
 * a `content_block_start` must be matched by its `content_block_stop` before the
 * next `content_block_start`. `openai-sse.ts` used to spell that rule by hand at
 * every emit site — with the "close thinking, then close text" sequence written
 * out twice and re-derived a third time at teardown. It got it wrong in at
 * least one shipping path: a `reasoning_content` chunk arriving after text
 * opened a `thinking` block without closing the text block, leaving two open.
 *
 * This is the State pattern in its **transition-table** form. The table is the
 * whole machine and is four lines:
 *
 * ```
 *   open(k): openRef === null                  -> start k
 *            openRef.kind === k && k !== tool   -> reuse (same ref)
 *            otherwise                          -> closeCurrent(), start k
 *   append(ref): ref === openRef ? emit : false
 * ```
 *
 * Two deliberate deviations from the generic pattern write-up:
 *
 * 1. **A table, not a class per state.** There are three kinds and one piece of
 *    state (which block is open); a class hierarchy would be ceremony.
 * 2. **It NEVER THROWS.** The generic advice is to throw on an illegal
 *    transition. Here a throw is worse than the corruption it reports: it
 *    propagates out of `finalize()` into the outer catch, which re-enters
 *    `finalize()` and returns immediately at the `state.finalized` guard — so the
 *    error string is never sent either and the turn ends with no `message_delta`,
 *    no `message_stop` and no `error` event. A throwing writer converts visible
 *    corruption into a silently truncated HTTP 200. So: correct the state, log,
 *    continue.
 *
 * Every mutating call takes a {@link BlockRef} rather than a bare kind, because
 * OpenAI's wire lets fragments for `tool_calls[0]` and `tool_calls[1]` interleave
 * while Anthropic's wire does not. A `BlockRef` names *which* block the caller
 * means, so an append aimed at a block that is no longer open is detected
 * (returns `false`) instead of silently landing in whatever is open now.
 *
 * (S4-b ccca029)
 */

import { log } from "../../../logger.js";

export type BlockKind = "text" | "thinking" | "tool_use";

/**
 * Identity of one emitted block. Opaque to callers — only the writer mints them.
 *
 * `toolId` distinguishes two blocks minted for the *same* tool, which the repair
 * path does: it closes a partially-streamed tool block and mints a fresh one
 * carrying the complete repaired arguments under a new id.
 */
export interface BlockRef {
  readonly index: number;
  readonly kind: BlockKind;
  readonly toolId?: string;
}

export interface BlockWriter {
  /**
   * Open (or reuse) a text block, closing whatever else is open.
   *
   * `index` is honoured only when no text block is already open — the
   * validation-failure path reserves a buffered tool's index and then spends it
   * on a `⚠️` text block instead.
   */
  openText(opts?: { index?: number }): BlockRef;

  /** Open (or reuse) the thinking block, closing whatever else is open. */
  openThinking(): BlockRef;

  /**
   * Open a tool block, closing whatever else is open. Never reuses: two calls
   * are two blocks, which is what the repair path needs.
   *
   * `index` is supplied when the index was reserved earlier — a buffered tool
   * reserves at the moment its name arrives and emits at finish_reason time.
   */
  openTool(opts: { id: string; name: string; index?: number }): BlockRef;

  /**
   * Append to a block BY REFERENCE. Returns `false` — and emits nothing — when
   * `ref` is not the currently open block. The caller decides what that means;
   * for a tool it means buffering the rest of the arguments. Never throws.
   */
  append(ref: BlockRef, payload: string): boolean;

  /** Close a specific block. Safe to call twice, and on a superseded block. */
  close(ref: BlockRef): void;

  /** Close whatever is open, if anything. */
  closeCurrent(): void;

  /** Reserve a block index without emitting anything. */
  reserve(): number;

  /** The open block, or null. The invariant this type exists to hold. */
  readonly openRef: BlockRef | null;

  /** Whether any `content_block_start` at all has been emitted this turn. */
  readonly anyBlockEmitted: boolean;

  /**
   * Every tool block start emitted this turn, in order.
   *
   * `state.tools` does not cover this: text-recovered calls are minted straight
   * from `extractToolCallsFromText` and live in no map.
   */
  readonly emittedToolRefs: readonly BlockRef[];
}

type SendFn = (event: string, data: any) => void;

/**
 * Build a writer over one stream's `send`. All index allocation for the turn
 * goes through it — there is no second counter.
 */
export function createBlockWriter(send: SendFn): BlockWriter {
  let nextIndex = 0;
  let openRef: BlockRef | null = null;
  let anyBlockEmitted = false;
  const emittedToolRefs: BlockRef[] = [];
  /** Indices whose `content_block_stop` has been emitted. Makes close() idempotent. */
  const stopped = new Set<number>();

  const describe = (ref: BlockRef | null) => (ref ? `${ref.kind}@${ref.index}` : "none");

  const closeCurrent = (): void => {
    if (!openRef) return;
    send("content_block_stop", { type: "content_block_stop", index: openRef.index });
    stopped.add(openRef.index);
    openRef = null;
  };

  const start = (ref: BlockRef, contentBlock: Record<string, any>): BlockRef => {
    send("content_block_start", {
      type: "content_block_start",
      index: ref.index,
      content_block: contentBlock,
    });
    openRef = ref;
    anyBlockEmitted = true;
    return ref;
  };

  const writer: BlockWriter = {
    openText(opts) {
      if (openRef?.kind === "text") {
        if (opts?.index !== undefined && opts.index !== openRef.index) {
          // Not an error: the reserved index is simply not spent. Logged because
          // it means a block index was allocated and never used, which reads as a
          // gap when someone diffs indices against a capture.
          log(
            `[BlockWriter] reusing open text block @${openRef.index}; reserved index ${opts.index} goes unused`
          );
        }
        return openRef;
      }
      closeCurrent();
      const index = opts?.index ?? nextIndex++;
      return start({ index, kind: "text" }, { type: "text", text: "" });
    },

    openThinking() {
      if (openRef?.kind === "thinking") return openRef;
      closeCurrent();
      return start({ index: nextIndex++, kind: "thinking" }, { type: "thinking", thinking: "" });
    },

    openTool({ id, name, index }) {
      closeCurrent();
      const ref: BlockRef = { index: index ?? nextIndex++, kind: "tool_use", toolId: id };
      start(ref, { type: "tool_use", id, name });
      emittedToolRefs.push(ref);
      return ref;
    },

    append(ref, payload) {
      if (!openRef || openRef.index !== ref.index || openRef.kind !== ref.kind) {
        log(
          `[BlockWriter] append error: ${describe(ref)} is not the open block (open=${describe(openRef)}); ${payload.length} chars withheld for the caller to handle`
        );
        return false;
      }
      const delta =
        ref.kind === "text"
          ? { type: "text_delta", text: payload }
          : ref.kind === "thinking"
            ? { type: "thinking_delta", thinking: payload }
            : { type: "input_json_delta", partial_json: payload };
      send("content_block_delta", { type: "content_block_delta", index: ref.index, delta });
      return true;
    },

    close(ref) {
      if (openRef && openRef.index === ref.index && openRef.kind === ref.kind) {
        closeCurrent();
        return;
      }
      if (stopped.has(ref.index)) return; // already closed, possibly by a later open()
      // A ref the writer minted is always either open or stopped, so this is
      // unreachable by construction. Logged rather than thrown (see the header):
      // emitting a stop for a block the client never saw start is the one thing
      // that would make this worse.
      log(
        `[BlockWriter] close error: ${describe(ref)} was never opened and is not stopped (open=${describe(openRef)})`
      );
    },

    closeCurrent,

    reserve() {
      return nextIndex++;
    },

    get openRef() {
      return openRef;
    },
    get anyBlockEmitted() {
      return anyBlockEmitted;
    },
    get emittedToolRefs() {
      return emittedToolRefs;
    },
  };

  return writer;
}
