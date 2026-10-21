/**
 * Pure text rewriting over content blocks.
 *
 * One implementation for every place text is rewritten: the response seam's
 * `buffer` mode (the held blocks), its non-streaming JSON branch (the whole
 * `content[]`), and the request's message-text actions. It never touches a
 * non-text block, and it reports where each output block came from so the seam
 * can re-emit unchanged blocks from their original bytes and re-index the rest.
 */

import type {
  AppendText,
  PrependText,
  RemoveMessageText,
  RemoveText,
  ReplaceMessageText,
  ReplaceText,
} from "./public.js";

/** The text actions this module applies. `warn` never reaches it. */
export type TextAction = AppendText | PrependText | ReplaceText | RemoveText;

/** A matcher action from either surface (response text or message text). */
export type MatchAction = ReplaceText | RemoveText | ReplaceMessageText | RemoveMessageText;

/** Regex flags a hook may pass. */
const ALLOWED_FLAGS = new Set(["g", "i", "m", "s", "u", "y"]);

/** A compiled `find`: a replacer that never interprets `$` in literal mode. */
export interface Matcher {
  apply(text: string): string;
}

/**
 * Compile an action's `find` into a matcher, or return the reason it is invalid.
 *
 * Literal mode (the default) replaces every occurrence and inserts `replace`
 * verbatim through a replacer FUNCTION, so `"$500"` stays `$500`. Regex mode
 * uses `flags` (a subset of `gimsuy`, default `"g"`) and applies JavaScript
 * replacement patterns (`$1`, `$<name>`, `$&`, `$$`).
 */
export function compileMatcher(action: MatchAction): Matcher | { invalid: string } {
  const replace = "replace" in action ? action.replace : "";
  if (typeof action.find !== "string" || action.find.length === 0) return { invalid: "empty_find" };
  if (typeof replace !== "string") return { invalid: "replace_not_string" };

  if (action.regex === true) {
    const flags = action.flags ?? "g";
    if (typeof flags !== "string") return { invalid: "invalid_flags" };
    const seen = new Set<string>();
    for (const f of flags) {
      if (!ALLOWED_FLAGS.has(f) || seen.has(f)) return { invalid: "invalid_flags" };
      seen.add(f);
    }
    let re: RegExp;
    try {
      re = new RegExp(action.find, flags);
    } catch {
      return { invalid: "invalid_regex" };
    }
    return {
      apply(text) {
        re.lastIndex = 0;
        return text.replace(re, replace);
      },
    };
  }

  if (action.flags !== undefined) return { invalid: "flags_without_regex" };
  const find = action.find;
  return { apply: (text) => text.split(find).join(replace) };
}

/** A block as the rewriter sees it. Only unlocked `text` blocks are editable. */
export interface RewriteBlock {
  type: string;
  text?: string;
  /**
   * An excluded text block (e.g. one that carried `citations_delta`): never
   * rewritten, and never chosen as the target of an append or prepend.
   */
  locked?: boolean;
}

export interface RewrittenBlock<B extends RewriteBlock> {
  /** The original block, or for an edited/inserted text block a new `{type:"text", text}`. */
  block: B | { type: "text"; text: string };
  /** Index of the original block, or null for an inserted one. */
  source: number | null;
  /** True when the text differs from the original (always true for an inserted block). */
  changed: boolean;
}

export interface TextRewriteResult<B extends RewriteBlock> {
  blocks: Array<RewrittenBlock<B>>;
  /** Index into `actions` of every action that was evaluated. */
  applied: Array<{ index: number; action: TextAction; changed: boolean }>;
  /** Index into `actions` of every action refused, with the reason. */
  rejected: Array<{ index: number; action: TextAction; reason: string }>;
}

const THINKING_TYPES = new Set(["thinking", "redacted_thinking"]);

interface WorkBlock<B extends RewriteBlock> {
  original: B | null;
  source: number | null;
  text: string | null;
  editable: boolean;
  touched: boolean;
}

/**
 * Apply response text actions sequentially, each over the previous result.
 *
 * Insert rules (the held region starts at the first block that is not
 * thinking, so both insert points always lie inside it):
 * - `appendText` → end of the LAST text block; with none, a new text block
 *   immediately BEFORE the first `tool_use` block; with none of those either,
 *   after the last block.
 * - `prependText` → start of the FIRST text block; with none, a new text block
 *   after any leading thinking blocks.
 * - `replaceText` / `removeText` → each text block independently, in order.
 *
 * A text block left empty by an edit is dropped (an empty text block is a 400 on
 * Anthropic-compatible endpoints when replayed), and from that action on it is not
 * there: a later append goes to the last text block still standing, or before the
 * first `tool_use` when none is. So replaying one hook chain's actions in a single
 * call gives exactly what each hook saw step by step. An originally empty block
 * that no action touched passes through unchanged.
 */
export function applyTextActions<B extends RewriteBlock>(
  blocks: ReadonlyArray<B>,
  actions: ReadonlyArray<TextAction>
): TextRewriteResult<B> {
  const work: Array<WorkBlock<B>> = blocks.map((b, i) => {
    const editable = b.type === "text" && !b.locked && typeof b.text === "string";
    return {
      original: b,
      source: i,
      text: editable ? (b.text as string) : null,
      editable,
      touched: false,
    };
  });
  const applied: TextRewriteResult<B>["applied"] = [];
  const rejected: TextRewriteResult<B>["rejected"] = [];

  const newText = (text: string): WorkBlock<B> => ({
    original: null,
    source: null,
    text,
    editable: true,
    touched: true,
  });

  actions.forEach((action, index) => {
    switch (action.type) {
      case "appendText":
      case "prependText": {
        if (typeof action.text !== "string" || action.text.length === 0) {
          rejected.push({ index, action, reason: "empty_text" });
          return;
        }
        const editableIdx = work.flatMap((w, i) => (w.editable ? [i] : []));
        if (editableIdx.length > 0) {
          const target = work[
            action.type === "appendText" ? editableIdx[editableIdx.length - 1] : editableIdx[0]
          ] as WorkBlock<B>;
          target.text =
            action.type === "appendText"
              ? `${target.text ?? ""}${action.text}`
              : `${action.text}${target.text ?? ""}`;
          target.touched = true;
        } else if (action.type === "appendText") {
          const firstTool = work.findIndex((w) => w.original?.type === "tool_use");
          work.splice(firstTool === -1 ? work.length : firstTool, 0, newText(action.text));
        } else {
          let leading = 0;
          while (leading < work.length && THINKING_TYPES.has(work[leading]?.original?.type ?? "")) {
            leading++;
          }
          work.splice(leading, 0, newText(action.text));
        }
        applied.push({ index, action, changed: true });
        return;
      }
      case "replaceText":
      case "removeText": {
        const matcher = compileMatcher(action);
        if ("invalid" in matcher) {
          rejected.push({ index, action, reason: matcher.invalid });
          return;
        }
        let changed = false;
        for (const w of work) {
          if (!w.editable || w.text === null) continue;
          const next = matcher.apply(w.text);
          if (next !== w.text) {
            w.text = next;
            w.touched = true;
            changed = true;
            // Emptied: the previous result has no such block, so no later action
            // (an append, a replace matching "") may target it.
            if (next === "") w.editable = false;
          }
        }
        applied.push({ index, action, changed });
        return;
      }
      default: {
        const unknown = action as { type?: unknown };
        rejected.push({
          index,
          action: action as TextAction,
          reason: `not_a_text_action:${String(unknown.type)}`,
        });
      }
    }
  });

  const out: Array<RewrittenBlock<B>> = [];
  for (const w of work) {
    if (w.touched && w.text === "") continue;
    if (w.original && (!w.editable || w.text === w.original.text)) {
      out.push({ block: w.original, source: w.source, changed: false });
      continue;
    }
    out.push({ block: { type: "text", text: w.text ?? "" }, source: w.source, changed: true });
  }
  return { blocks: out, applied, rejected };
}
