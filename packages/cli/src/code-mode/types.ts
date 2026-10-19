/**
 * Shapes shared by the code-mode modules: Responses `input` items and the
 * parts of Claude Code's `/v1/messages` body the input builder and the stores
 * read. Deliberately loose: both sides are external wire formats, and code mode
 * only ever reads the fields named here.
 */

/** One Responses `input` item (message, reasoning, custom_tool_call, custom_tool_call_output, …). */
export interface ResponsesItem {
  type: string;
  [field: string]: unknown;
}

/** A content block of a Claude Code message. */
export interface ClaudeContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  source?: unknown;
  [field: string]: unknown;
}

/** One message of `claudeRequest.messages`. */
export interface ClaudeMessage {
  role: string;
  content: string | ClaudeContentBlock[];
}

/** A nested tool call relayed to Claude Code as one tool_use block. */
export interface NestedToolUse {
  /** `toolu_cx_<hex>_<seq>` (`encodeNestedId`). */
  id: string;
  /** Claude Code's own tool name. */
  name: string;
  input: Record<string, unknown>;
}

/**
 * What the turn driver does after an exec call: relay the script's batch as
 * tool_use blocks (the message ends `tool_use`), or continue the turn with
 * another upstream leg whose input carries the exec items.
 */
export type ExecTurnStep =
  | { kind: "emit-tool-uses"; blocks: [NestedToolUse, ...NestedToolUse[]] }
  | { kind: "continue"; appendItems: ResponsesItem[] };

/**
 * How the Responses turn driver reaches code mode. The driver never imports
 * code mode itself, so classic providers never load QuickJS.
 */
export interface CodeModeTurnHooks {
  /**
   * An exec call ended a leg. `precedingItems` are that leg's assistant text
   * and reasoning items in order; `truncated` means `response.incomplete` cut
   * the exec input, which is then never run. Never rejects: a store or sandbox
   * failure becomes a `Script failed` continuation.
   */
  onExecCall(call: {
    callId: string;
    input: string;
    precedingItems: ResponsesItem[];
    truncated: boolean;
  }): ExecTurnStep | Promise<ExecTurnStep>;
  /**
   * The message ended: store its Responses items (they end before the final
   * exec call when it ended on nested calls). `anchor` is the message's first
   * tool_use id; undefined when it has none, and `texts` (its text blocks, in
   * order) then derive it.
   */
  onTurnEnd(record: { anchor?: string; items: ResponsesItem[]; texts: string[] }): void;
  /** The client went away before the `message_stop` of a relayed batch. */
  onTurnAbandoned(callId: string): void;
}
