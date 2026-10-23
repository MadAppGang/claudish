/**
 * The frozen mod contract, version 1 — the single source of the wire types that the
 * peer's Claude Code mod reads from `team(mode="list"|"status"|"cancel"|"capture"|"resize")`,
 * `list_sessions`, `cancel_session`, `capture_session` and `resize_session`.
 *
 * Pasted verbatim from the session architecture §8 (including CA-12 `contract_version`
 * / `capabilities` and CA-13 `run_id`). Fields never change meaning or type within
 * version 1; new fields may only be ADDED. `FailureReason` lives here because both
 * owners (team and the MCP sessions) produce it.
 */

export const CONTRACT_VERSION = 1;

/**
 * v1 announces exactly these. `resize` is additive: it needs magmux >= 0.15.1.
 * `allowance` is additive too: the `allowance_status` tool answers
 * `claudish.allowance.v1` (allowance architecture §3.4).
 */
export const CAPABILITIES = [
  "list",
  "status",
  "cancel",
  "capture",
  "capture_since_seq",
  "capture_spans",
  "resize",
  "allowance",
] as const;

export interface ContractMeta {
  contract_version: 1;
  /** v1: exactly CAPABILITIES (fields and capabilities are only ever added) */
  capabilities: string[];
}

/** Closed set. The mod colours by it. */
export type SlotState =
  /** Pane spawned; Claude Code booting, or the prompt the session was CREATED with delivered but not yet
   * accepted. A promptless session's first send_input goes AWAITING_INPUT → RUNNING, never back to
   * STARTING. Bounded: leaves within 90 s + 30 s. Non-terminal. */
  | "STARTING"
  /** A turn is in progress: prompt accepted; the model thinking, a tool running, Stop hooks or background
   * agents still finishing. Never ended by a timer (team). Non-terminal. */
  | "RUNNING"
  /** Waiting for text: an interactive create_session between turns (activity null), or a turn blocked on
   * a question (activity "AskUserQuestion"). A send_input during a question does NOT answer it: claudish
   * presses Esc, which declines the question and interrupts the turn, and the text becomes the next
   * prompt. Team slots never stay here. Non-terminal. */
  | "AWAITING_INPUT"
  /** A permission / plan-approval dialog is showing (only when caller flags override -y). A send_input
   * declines it the same way. Same team rule as above. Non-terminal. */
  | "AWAITING_PERMISSION"
  /** Turn settled with a usable answer (team: passed require_pattern / min_output_bytes), or an
   * interactive session whose child exited 0 while idle after /exit or after ≥ 1 settled turn. Terminal. */
  | "COMPLETED"
  /** The session broke: boot failure, prompt never accepted, task file not fully read, child exited
   * (incl. unknown agent), API error, blocked (team), pane lost. Terminal. */
  | "FAILED"
  /** Stopped by team(mode="cancel") or cancel_session. Terminal. */
  | "CANCELLED"
  /** create_session timeout_seconds elapsed (team slots never time out). Terminal. */
  | "TIMEOUT"
  /** Turn settled but the answer is unusable: empty, refused, below min_output_bytes, or
   * shape_mismatch. Terminal. */
  | "EMPTY";

export const SLOT_STATES: readonly SlotState[] = [
  "STARTING",
  "RUNNING",
  "AWAITING_INPUT",
  "AWAITING_PERMISSION",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMEOUT",
  "EMPTY",
];

export const TERMINAL_STATES: readonly SlotState[] = [
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMEOUT",
  "EMPTY",
];

export function isTerminalState(s: SlotState): boolean {
  return TERMINAL_STATES.includes(s);
}

export type FailureReason =
  | "cancelled" // the caller stopped it — a decision, not a fault
  | "timeout" // create_session timeout_seconds; team-grid (CLI) pane end
  | "boot_timeout" // no REPL prompt within the boot deadline, screen still changing (screen tail in detail)
  | "boot_blocked" // a static non-REPL screen that is not a named dialog blocked boot (screen text in detail)
  | "first_run_dialog" // a named first-run dialog blocked boot (dialog text in detail)
  | "agent_rejected" // the child refused --agent (its own "not found. Available agents" line)
  | "prompt_not_accepted" // the first prompt never produced an acceptance witness within the admission bound
  | "prompt_not_read" // a file-delivered turn settled without Read returning every line of its task file
  | "child_exited" // pane child exited before the turn settled (exit code + last line + screen tail)
  | "pane_lost" // the magmux PROCESS died without reporting the pane's exit
  | "blocked" // team slot stopped on a question/permission dialog team cannot answer (question in detail)
  | "api_error" // the settled turn is an isApiErrorMessage entry (or a screen-mode error row)
  | "refused" // the settled turn's stop_reason is "refusal"
  | "empty_output"
  | "shape_mismatch";

export const FAILURE_REASONS: readonly FailureReason[] = [
  "cancelled",
  "timeout",
  "boot_timeout",
  "boot_blocked",
  "first_run_dialog",
  "agent_rejected",
  "prompt_not_accepted",
  "prompt_not_read",
  "child_exited",
  "pane_lost",
  "blocked",
  "api_error",
  "refused",
  "empty_output",
  "shape_mismatch",
];

/** B — one row per team slot, and the base of every list_sessions row. */
export interface SlotRow {
  /** team: anonymised slot id ("01"); session: the session_id */
  slot: string;
  /** as requested */
  model: string;
  /** display name of the claudish provider serving it; null until known */
  provider: string | null;
  state: SlotState;
  /** set on FAILED / EMPTY / CANCELLED / TIMEOUT; null otherwise (incl. COMPLETED). One exception: a
   * pre-contract state read from disk is FAILED with null (§B) */
  reason: FailureReason | null;
  /** [additive] one line (≤ 160 chars) saying why `reason`: for api_error the provider's
   * `error.message` from the last upstream-error record, else the child's API-error text;
   * for any other reason the first line of its detail. null on non-terminal states, on
   * COMPLETED, and when nothing readable exists. Never the upstream body. `reasonDetail()` */
  reason_detail: string | null;
  /** billed input incl. cache reads/writes, main conversation + subagents; null = no source yet */
  tokens_in: number | null;
  tokens_out: number | null;
  /** null = unknown (always null for native Claude routes) */
  cost_usd: number | null;
  /** includes the child's Read call(s) of a file-delivered prompt */
  tool_calls: number;
  /** prompts whose turn settled (one per prompt, however many internal loops) */
  turns_completed: number;
  /** ISO 8601: last screen change or transcript append */
  last_activity_at: string | null;
  /** seconds since last_activity_at; null in terminal states */
  idle_seconds: number | null;
  /** RUNNING: tool name, "thinking", "background" (waiting on background agents), or "finishing" (the
   * model's message ended; waiting for Claude Code's end-of-turn record, typically while Stop hooks run),
   * or "hook" (the turn settled and claudish's session hooks run before the verdict);
   * AWAITING_PERMISSION: blocked tool; AWAITING_INPUT on a question: "AskUserQuestion"; otherwise null.
   * Treat unknown values as "busy". */
  activity: string | null;
  /** informational only (do not parse, no verb takes it); null if no pane was ever spawned */
  pane: string | null;
  /** [additive] the last RECENT_STEP_LIMIT (20) steps of the current turn, oldest first, from the
   * main-chain transcript; null before the first step and on rows built from disk. Kept after the
   * turn settles until the next turn starts. Each summary is one line (≤ 100 chars), credentials
   * masked; never a whole tool input and nothing from a tool result. `pane/slot-steps.ts` */
  recent: SlotStep[] | null;
  /** [additive] the subagent the caller asked for: the `--agent` value claudish passed to the
   * child (from `agent`, or from `claude_flags`); null when none. `requestedAgentOf` */
  agent_requested: string | null;
  /** [additive] the subagent Claude Code actually loaded: the latest `agent-setting` record of the
   * child's own transcript. null when the transcript has none: no agent, a rejected agent
   * (`reason: "agent_rejected"`), or not written yet. Kept on rows built from disk. */
  agent: string | null;
}

/** One step of a slot's turn: an assistant text, thinking or tool_use block. */
export interface SlotStep {
  /** ISO 8601: the transcript record's own timestamp */
  at: string;
  /** "ask" is a tool_use of AskUserQuestion */
  kind: "text" | "thinking" | "tool" | "ask";
  /** the tool name for "tool" and "ask"; null for "text" and "thinking" */
  tool: string | null;
  /** text and thinking: the first line; tool: the input naming its target (file_path, the first
   * line of a Bash command, pattern, query, url, description) or "" for any other tool; ask: the
   * first question */
  summary: string;
}

/** list_sessions row = SlotRow + session fields. `slot` equals `session_id`. */
export interface SessionRow extends SlotRow {
  session_id: string;
  /** ISO */
  started_at: string;
  /** ISO */
  completed_at: string | null;
  elapsed_seconds: number;
}

/** A — one team run this server knows. */
export interface TeamRunRow {
  /** [CA-13] unique per team(mode="run") start, distinct even when `path` is reused (opaque; format
   * `<team_session_id>-<base36 start ms>-<6 hex>`). Same value as the start answer's `run_id`. A judge
   * sub-run has its own run_id. */
  run_id: string;
  /** absolute session directory (the `path` every other team mode takes) */
  path: string;
  /** "judge" = the judging/ sub-run of a judge or run-and-judge */
  kind: "run" | "judge";
  /** ISO */
  started_at: string;
  /** ISO, set when the last slot turned terminal */
  finished_at: string | null;
  /** run-level, distinct from SlotState: SETTLED ⇔ every slot terminal */
  state: "ACTIVE" | "SETTLED";
  /** null while ACTIVE; same words as the result card */
  outcome: "ok" | "partial" | "all-failed" | null;
  /** sorted by slot id */
  slots: SlotRow[];
}

/** [CA-12] an object, not a bare array */
export interface TeamListResult extends ContractMeta {
  runs: TeamRunRow[];
}
export interface SessionListResult extends ContractMeta {
  sessions: SessionRow[];
}
/** team(mode="status") adds these keys to its existing payload. */
export interface TeamStatusAdditions extends ContractMeta {
  run: TeamRunRow;
}

/** C */
export interface TeamCancelResult {
  /** [CA-13] */
  run_id: string;
  path: string;
  /** changed = this call moved it to CANCELLED */
  results: Array<{ slot: string; state: SlotState; changed: boolean }>;
}
export interface SessionCancelResult {
  session_id: string;
  state: SlotState;
  changed: boolean;
}

/** One magmux span run: [col, len, fg, bg, attr]. Colour -1 = default, 0..255 indexed,
 * ≥ 16777216 truecolor (`c & 0xFFFFFF`); attr bitmask, 1 = bold. */
export type SpanRun = [col: number, len: number, fg: number, bg: number, attr: number];

/** D */
export interface CaptureResult {
  /** claudish-owned. 0 = no frame received yet (lines all ""); ≥ 1 after the first frame; +1 per visible
   * change (text, colours, cursor, alt screen, size); never resets for a pane's life */
  seq: number;
  /** the pane's current width: 160 at launch, then whatever the last resize set */
  cols: number;
  /** the pane's current height: 50 at launch, then whatever the last resize set */
  rows: number;
  cursor: { x: number; y: number };
  /** exactly `rows` entries, plain text, right-trimmed; Claude Code's screen (no scrollback) */
  lines: string[];
  /** true = the pane is closed and this is its last screen */
  final: boolean;
  /** only when spans:true was asked */
  spans?: SpanRun[][];
}
export interface CaptureUnchanged {
  unchanged: true;
  seq: number;
  final: boolean;
}

/**
 * F — `resize_session`. `cols`/`rows` are the size SET (the request clamped to cols 40–9999,
 * rows 24–9999 and at most 4 000 000 cells, magmux's limits: `clampPaneSize`); `changed` = the pane's size moved; `seq` = the screen's seq after the
 * resize (the first capture at the new size once `changed`). `pending: true` = the socket
 * is reconnecting (or the pane is still starting): the size is stored and applied on the
 * reconnect (or at launch). A terminal session answers its last size with `changed:false`.
 */
export interface ResizeResult {
  session_id: string;
  cols: number;
  rows: number;
  changed: boolean;
  seq: number;
  pending?: true;
}
/** F — `team(mode="resize")`: the same answer, addressed by run and slot. */
export interface TeamResizeResult {
  run_id: string;
  path: string;
  slot: string;
  cols: number;
  rows: number;
  changed: boolean;
  seq: number;
  pending?: true;
}

/** E. `resize_unsupported` and `delivery_unavailable` are emitted only by the resize verbs. */
export interface ContractError {
  error: {
    code:
      | "unknown_run"
      | "unknown_slot"
      | "unknown_session"
      | "invalid_args"
      | "resize_unsupported"
      | "delivery_unavailable";
    message: string;
  };
}

export function contractMeta(): ContractMeta {
  return { contract_version: CONTRACT_VERSION, capabilities: [...CAPABILITIES] };
}

/**
 * A §8 verb's error, thrown by the owners and serialised by the MCP handler as the
 * `ContractError` JSON with `isError: true` (§8 E).
 */
export class ContractErrorException extends Error {
  constructor(
    readonly code: ContractError["error"]["code"],
    message: string
  ) {
    super(message);
  }

  toContractError(): ContractError {
    return { error: { code: this.code, message: this.message } };
  }
}
