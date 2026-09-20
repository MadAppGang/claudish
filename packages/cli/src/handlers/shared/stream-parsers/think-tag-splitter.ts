/**
 * `<think>…</think>` in an OpenAI `delta.content` stream → an Anthropic thinking
 * block.
 *
 * Some models carry their reasoning in the ordinary content field wrapped in
 * `<think>` tags rather than in `reasoning_content` / `reasoning`. Passed
 * through untouched, the tags and the reasoning render as the assistant's
 * ANSWER, and they enter the conversation history as the assistant's words.
 *
 * ## Two deliberate narrowings
 *
 * The obvious implementation scans the whole stream for the tags. It is wrong in
 * a way that is invisible until it bites: a model writing *about* `<think>` — in
 * a code block, in documentation, in a message about this very feature — has its
 * output silently eaten, and the text never reaches the client at all.
 *
 * So:
 *
 * 1. **The open tag is recognised at position 0 only.** `<think>` must be the
 *    first non-whitespace content of the turn. A `<think>` anywhere else is
 *    ordinary text.
 * 2. **The open tag is disarmed once real reasoning has been seen** on
 *    `reasoning_content` / `reasoning`. A provider that has its own reasoning
 *    field is not also speaking in tags, and a `<think>` in its content is a
 *    model talking about tags.
 *
 * Disarmed and decided, `push()` is the identity function on its argument, so a
 * stream with no tags is byte-identical to one that never met this splitter.
 *
 * ## The orphan close
 *
 * A `</think>` as the first non-whitespace content, with no `<think>` before it,
 * is real: the provider's chat template opened the tag server-side and only the
 * close reaches the wire. It is REMOVED from the text. It needs no further
 * signal — if a thinking block is open (because `reasoning_content` opened one),
 * the next text emission closes it through the block writer, and if no text
 * follows, `finalize()` closes it. Position 0 again, for the same reason as the
 * open tag.
 *
 * ## Chunk boundaries
 *
 * A tag can be split across chunks — `</thi` then `nk>`. The splitter holds back
 * the longest suffix of what it has that is a proper prefix of `</think>` (at
 * most 7 characters) and releases it on the next chunk, or at {@link flush}. A
 * held fragment is therefore never dropped; the cost is at most 7 characters of
 * latency on a chunk that ends mid-tag.
 *
 * (S4-b d4cba87)
 */

const OPEN = "<think>";
const CLOSE = "</think>";

export interface ThinkSplit {
  /** Content belonging in a thinking block. */
  thinking: string;
  /** Content belonging in a text block. */
  text: string;
}

export interface ThinkTagSplitter {
  /** Feed one chunk of post-adapter content. */
  push(chunk: string): ThinkSplit;
  /**
   * Release everything still held. Called once from `finalize()`, so a fragment
   * held back for a tag that never completed still reaches the client.
   */
  flush(): ThinkSplit;
  /**
   * Real reasoning arrived on its own field: stop looking for an OPEN tag.
   * Close-tag handling is unaffected — that is what strips a leaked `</think>`
   * from the head of the content on exactly those providers.
   */
  disarmOpen(): void;
  /** Whether content is currently being routed to a thinking block. */
  readonly inThinking: boolean;
}

const EMPTY: ThinkSplit = { thinking: "", text: "" };

export function createThinkTagSplitter(): ThinkTagSplitter {
  /**
   * `deciding` — nothing non-whitespace has been classified yet.
   * `thinking`  — inside `<think>`, looking for the close.
   * `passthrough` — decided; `push` is the identity from here on.
   */
  let phase: "deciding" | "thinking" | "passthrough" = "deciding";
  /** Held-back bytes: the undecided head, or a partial close tag. */
  let pending = "";
  let openArmed = true;

  /** Longest suffix of `s` that is a proper prefix of `CLOSE`, at most 7 chars. */
  const heldSuffixLength = (s: string): number => {
    for (let n = Math.min(CLOSE.length - 1, s.length); n > 0; n--) {
      if (CLOSE.startsWith(s.slice(s.length - n))) return n;
    }
    return 0;
  };

  const consumeThinking = (chunk: string): ThinkSplit => {
    pending += chunk;
    const at = pending.indexOf(CLOSE);
    if (at >= 0) {
      const thinking = pending.slice(0, at);
      const text = pending.slice(at + CLOSE.length);
      pending = "";
      phase = "passthrough";
      return { thinking, text };
    }
    const hold = heldSuffixLength(pending);
    const thinking = pending.slice(0, pending.length - hold);
    pending = hold === 0 ? "" : pending.slice(pending.length - hold);
    return { thinking, text: "" };
  };

  /**
   * Classify the head of the turn. `isFlush` means there will be no more input,
   * so an undecided head can no longer be held — it is ordinary text.
   */
  const decide = (isFlush: boolean): ThinkSplit => {
    const lead = pending.replace(/^\s+/, "");

    const releaseAsText = (): ThinkSplit => {
      phase = "passthrough";
      const text = pending;
      pending = "";
      return { thinking: "", text };
    };

    if (lead === "") return isFlush ? releaseAsText() : EMPTY;

    if (openArmed && lead.startsWith(OPEN)) {
      // Leading whitespace is dropped rather than emitted: emitting it would
      // open a TEXT block ahead of the thinking block, which is the very
      // ordering this exists to get right.
      phase = "thinking";
      pending = "";
      return consumeThinking(lead.slice(OPEN.length));
    }

    if (lead.startsWith(CLOSE)) {
      phase = "passthrough";
      pending = "";
      return { thinking: "", text: lead.slice(CLOSE.length) };
    }

    // Still a proper prefix of a tag — undecided, hold for the next chunk.
    if ((openArmed && OPEN.startsWith(lead)) || CLOSE.startsWith(lead)) {
      return isFlush ? releaseAsText() : EMPTY;
    }

    return releaseAsText();
  };

  return {
    push(chunk) {
      if (!chunk) return EMPTY;
      if (phase === "passthrough") return { thinking: "", text: chunk };
      if (phase === "thinking") return consumeThinking(chunk);
      pending += chunk;
      return decide(false);
    },

    flush() {
      if (phase === "passthrough") return EMPTY;
      if (phase === "thinking") {
        const thinking = pending;
        pending = "";
        return { thinking, text: "" };
      }
      return decide(true);
    },

    disarmOpen() {
      openArmed = false;
    },

    get inThinking() {
      return phase === "thinking";
    },
  };
}
