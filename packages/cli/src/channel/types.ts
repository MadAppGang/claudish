// ─── Channel Mode Types ──────────────────────────────────────────────────────

export type SessionStatus =
  | "starting"
  | "running"
  | "tool_executing"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout";

export type SignalState =
  | "starting"
  | "running"
  | "tool_executing"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "cancelled";

export interface SessionInfo {
  sessionId: string;
  model: string;
  status: SessionStatus;
  pid: number | null;
  startedAt: string;
  completedAt: string | null;
  exitCode: number | null;
  turnsCompleted: number;
  tokensUsed: number;
  elapsedSeconds: number;
}

export interface SessionCreateOptions {
  /**
   * The model as the caller asked for it. This is the session's DISPLAY
   * identity — `SessionInfo.model`, channel `meta.model`, `list_sessions` — and
   * the agent correlates on it, so it is never rewritten.
   */
  model: string;
  /**
   * Optional explicit "provider@model" spec to spawn with, resolved by the
   * parent (see auth/credentials/prehydrate.ts). Only argv uses it: a child
   * given an explicit spec skips routing, which is what stops it re-walking the
   * chain and opening its own 1Password SDK client. Absent → spawn `model`.
   */
  spawnModel?: string;
  prompt?: string;
  timeoutSeconds?: number;
  claudishFlags?: string[];
  cwd?: string;
}

export interface ChannelEvent {
  type: string;
  model: string;
  content: string;
  elapsedSeconds: number;
  /**
   * ISO-8601 timestamp of session creation. Populated by SessionManager from
   * `entry.info.startedAt`. Used by the bridge to populate SEP-1686-shaped
   * `meta.created_at` for forward-compat with notifications/tasks/status.
   */
  createdAt: string;
  extraMeta?: Record<string, string>;
}

export interface SignalData {
  previousState: SignalState;
  newState: SignalState;
  content?: string;
  toolName?: string;
  toolCount?: number;
  timestamp: string;
}

export type SignalCallback = (sessionId: string, data: SignalData) => void;

export interface SessionManagerOptions {
  maxSessions?: number;
  scrollbackCapacity?: number;
  onStateChange?: (sessionId: string, event: ChannelEvent) => void;
  /** Artifact root override. Defaults to CLAUDISH_SESSIONS_DIR, then ~/.claudish/sessions. */
  sessionsDir?: string;
}
