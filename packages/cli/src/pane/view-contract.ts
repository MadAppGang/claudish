/**
 * Wire types of the local view transport (`claudish.view.v1`): the socket each MCP server serves
 * to clients other than its own Claude Code. `ViewItem` is built on the contract v1 rows, so the
 * two surfaces cannot drift.
 *
 * Framing is JSON Lines. A request is `{id, op, args}`, a reply `{id, ok, result | error}`, an
 * event `{type:"event", sub, seq, event, ...}`. A control socket's path is never in a reply.
 */

import type {
  CaptureResult,
  CaptureUnchanged,
  ContractError,
  ResizeResult,
  SessionRow,
  SlotRow,
  TeamResizeResult,
  TeamTranscriptResult,
  TranscriptResult,
  ViewHolder,
} from "./contract.js";

export const VIEW_PROTOCOL = "claudish.view.v1";

/** How to reach an item's magmux pane. `view_socket` is null until it has been proven read-only. */
export interface ViewMagmux {
  pane_id: string;
  view_socket: string | null;
}

/** One subagent of a running session. */
export interface SubagentRow {
  /** the `agent-<id>.jsonl` id */
  id: string;
  /** null until linked to its parent call; at most 100 characters, credentials masked */
  description: string | null;
  subagent_type: string | null;
  mode: "foreground" | "background" | null;
  state: "running" | "done";
  started_at: string;
  tool_calls: number;
  tokens_out: number | null;
}

/** What a session or a team slot adds to its contract row. */
export interface ViewDetail {
  /** first line of the first prompt, at most 100 characters, credentials masked */
  prompt_summary: string | null;
  /** caller prompts admitted or queued; hook-injected turns are not counted */
  prompts_sent: number;
  pending_inputs: number;
  /** at most 20, newest kept */
  subagents: SubagentRow[];
  /** null before the pane exists */
  magmux: ViewMagmux | null;
}

export interface ViewItemCommon extends ViewDetail {
  /** `s:<session_id>`, `t:<run_id>/<slot>` or `r:<replay_id>` */
  target: string;
}

export type SessionViewItem = SessionRow & ViewItemCommon & { kind: "session" };

export type TeamSlotViewItem = SlotRow &
  ViewItemCommon & {
    kind: "team_slot";
    run_id: string;
    run_path: string;
    run_kind: "run" | "judge";
  };

export interface ReplayViewItem {
  kind: "replay";
  target: string;
  replay_id: string;
  of: { session_id: string } | { run_id: string; slot: string; path: string };
  model: string | null;
  final: boolean;
  magmux: ViewMagmux | null;
  view: ViewHolder | null;
  /** workspace keys with a herdr viewer on this replay or a placement reserved */
  herdr_workspaces: string[];
}

export type ViewItem = SessionViewItem | TeamSlotViewItem | ReplayViewItem;

export type ViewTarget =
  | { kind: "session"; sessionId: string }
  | { kind: "team_slot"; runId: string; slot: string }
  | { kind: "replay"; replayId: string };

export function targetOfSession(sessionId: string): string {
  return `s:${sessionId}`;
}

export function targetOfSlot(runId: string, slot: string): string {
  return `t:${runId}/${slot}`;
}

export function targetOfReplay(replayId: string): string {
  return `r:${replayId}`;
}

/** Null for anything that is not one of the three prefixed forms. */
export function parseViewTarget(target: string): ViewTarget | null {
  if (target.startsWith("s:") && target.length > 2)
    return { kind: "session", sessionId: target.slice(2) };
  if (target.startsWith("r:") && target.length > 2)
    return { kind: "replay", replayId: target.slice(2) };
  if (target.startsWith("t:")) {
    const at = target.lastIndexOf("/");
    if (at > 2 && at < target.length - 1)
      return { kind: "team_slot", runId: target.slice(2, at), slot: target.slice(at + 1) };
  }
  return null;
}

export type ViewClientKind = "viewer" | "relay" | "peer";
export type ViewFrontEnd = "herdr" | "herdr-core" | "none";

export interface ViewClientHello {
  name: string;
  kind: ViewClientKind;
  front_end?: ViewFrontEnd;
  term_program?: string;
  workspace_key?: string;
  /** the caller's own endpoint file name; required for `kind: "peer"` */
  endpoint?: string;
}

export interface ViewHelloResult {
  protocol: string;
  server: {
    pid: number;
    version: string;
    started_at: string;
    endpoint: string;
    front_end: ViewFrontEnd;
    workspace_id?: string;
  };
  contract_version: 1;
  capabilities: string[];
}

export interface ViewListResult {
  items: ViewItem[];
}

export interface ViewSubscribeResult {
  sub: number;
}

export type ViewCaptureAnswer = CaptureResult | CaptureUnchanged;
export type ViewTranscriptAnswer = TranscriptResult | TeamTranscriptResult;
export type ViewResizeAnswer = ResizeResult | TeamResizeResult;

export interface ViewClaimResult {
  granted: boolean;
  view: ViewHolder | null;
  resize: ViewResizeAnswer;
}

export interface ViewHolderResult {
  view: ViewHolder | null;
}

export type ViewRemoveReason = "evicted" | "replay_closed" | "run_pruned";

/** Every event of a subscription; `server.closing` carries `sub: 0`. */
export type ViewEvent =
  | { type: "event"; sub: number; seq: number; event: "snapshot"; items: ViewItem[] }
  | { type: "event"; sub: number; seq: number; event: "item.upsert"; item: ViewItem }
  | {
      type: "event";
      sub: number;
      seq: number;
      event: "item.remove";
      target: string;
      reason: ViewRemoveReason;
    }
  | { type: "event"; sub: number; seq: number; event: "server.closing" };

export type ViewErrorCode =
  | ContractError["error"]["code"]
  | "unknown_op"
  | "forbidden"
  | "view_not_held"
  | "slow_consumer"
  | "too_many_connections"
  | "line_too_long"
  | "replay_limit"
  | "replay_elsewhere"
  | "server_gone";

export interface ViewErrorBody {
  code: ViewErrorCode;
  message: string;
  reason?: string;
}

/** An error of the local transport. Never one of contract v1's own errors. */
export class ViewError extends Error {
  constructor(
    readonly code: ViewErrorCode,
    message: string,
    readonly reason?: string
  ) {
    super(message);
  }
}
