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
  model: string;
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
}
