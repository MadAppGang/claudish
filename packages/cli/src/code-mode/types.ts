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
