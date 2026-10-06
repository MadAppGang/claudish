// ─── Channel Mode Types ──────────────────────────────────────────────────────

import type { FailureReason, PaneSessionOptions, SlotState } from "../pane/index.js";

/**
 * Every value the channel wire's `event` field may carry, as a runtime list so a
 * test can walk it (`event-task-status.test.ts` checks each one against
 * `EVENT_TO_TASK_STATUS`). `ChannelEventType` is derived from it.
 *
 * It is its own union, derived from the session's `SlotState` by `channelEventFor`
 * (session-manager.ts): the stream-json `SessionStatus` it once mirrored is gone with
 * that transport. 10.4.0's `finishing` is not here (architecture §20.3 item 5, RB1): a
 * pane session decides a one-shot verdict at settle, so the "exiting" interval it named
 * does not exist; the wait for Claude Code's end-of-turn record is `activity:"finishing"`
 * on a RUNNING row.
 */
export const CHANNEL_EVENT_TYPES = [
  "starting",
  "running",
  "tool_executing",
  "waiting_for_input",
  /** A tool call waits on Claude Code's permission dialog; answered with `send_input`. */
  "awaiting_permission",
  "completed",
  "failed",
  "cancelled",
  "timeout",
] as const;

/**
 * The values the channel wire's `event` field may carry.
 *
 * `EVENT_TO_TASK_STATUS` (mcp-server.ts) maps each onto SEP-1686's 5-value
 * `TaskStatus`; it is a `Record` over this type, so an event without a projection is a
 * compile error. `timeout` has its own key (→ `failed`): before it existed the timeout
 * path fell through to `?? "working"` and reported a dead session as still working.
 */
export type ChannelEventType = (typeof CHANNEL_EVENT_TYPES)[number];

/**
 * One channel session, in memory (architecture §3.3). Persisted as `meta.json` through
 * `toMetaRecord`, which keeps every 10.4.0 key under its 10.4.0 name (the magus monitor
 * reads them) and adds the pane keys.
 */
export interface SessionInfo {
  sessionId: string;
  /** The model as the caller asked for it; the display identity, never rewritten. */
  model: string;
  /**
   * The explicit `provider@model` spec the child was actually SPAWNED with, when the
   * parent pinned one (see `prehydrateCredentialsForSpawn`). Null means the child was
   * handed `model` verbatim and did its own routing.
   */
  spawnModel: string | null;
  /** Display name of the claudish provider serving it; null until known. */
  provider: string | null;
  state: SlotState;
  /** "one-shot" when created with a prompt; a send_input converts it to "interactive". */
  shape: "one-shot" | "interactive";
  /** Informational pane id; null when no pane was ever spawned. */
  pane: string | null;
  panePid: number | null;
  startedAt: string;
  completedAt: string | null;
  /** The child's own exit code; null when claudish ended the pane (verdict, cancel, timeout). */
  exitCode: number | null;
  /** Prompts whose turn settled (a re-wake adds none). */
  turnsCompleted: number;
  /** From the transcript or the proxy's token file; null = no source yet. */
  tokensIn: number | null;
  tokensOut: number | null;
  /** Real spend from the proxy's token file; null = unknown (always null for native routes). */
  costUsd: number | null;
  toolCalls: number;
  /** ISO 8601: last screen change or transcript append. */
  lastActivityAt: string | null;
  elapsedSeconds: number;
  /**
   * Seconds since `lastActivityAt`; null in terminal states and for a record read from
   * disk. INFORMATION, not a verdict: nothing in claudish ends a session for being idle.
   */
  idleSeconds: number | null;
  /** RUNNING: tool name, "thinking", "background" or "finishing"; a blocked tool; else null. */
  activity: string | null;
  /** Set on FAILED / EMPTY / CANCELLED / TIMEOUT; null otherwise (incl. COMPLETED). */
  reason: FailureReason | null;
  detail: string | null;
  /** send_input texts queued behind the current turn. */
  pendingInputs: number;
  /**
   * The child Claude Code's own session uuid — minted here and passed as `--session-id`.
   * It is the transcript's basename.
   */
  claudeSessionId: string;
  /**
   * Absolute path of the child's JSONL transcript: `<config dir>/projects/<slug of the
   * REALPATH of cwd>/<claudeSessionId>.jsonl`. The realpath is load-bearing (macOS `/tmp`
   * is a symlink), and it is the turn oracle the pane session reads.
   */
  transcriptPath: string;
  /**
   * The Claude Code conversation that called create_session, PROVEN at call time
   * (channel/parent-proof.ts). Absent when not proven — never a guess.
   */
  parentClaudeSessionId?: string;
  captureSource: "transcript" | "screen" | "none" | null;
  turnSource: "transcript" | "screen";
  /** normaliseTimeoutSeconds(): an integer in 1..3600 (0 for a record read from disk without it). */
  timeoutSeconds: number;
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
  /**
   * The first turn. Its presence also selects the session's SHAPE:
   *
   * - given  → one-shot. Delivered once the REPL is ready; the session's verdict is
   *   decided when that turn settles, and it ends at COMPLETED, EMPTY or FAILED.
   * - absent → interactive. The session waits in AWAITING_INPUT once boot is ready
   *   (STARTING before), and again after every turn.
   *
   * A `send_input` call converts a one-shot session to interactive — the caller has
   * taken over driving it, so we stop deciding when it is finished.
   */
  prompt?: string;
  timeoutSeconds?: number;
  claudishFlags?: string[];
  cwd?: string;
  /**
   * Use this id instead of minting a random one. Must be unique among live sessions;
   * a collision throws rather than silently adopting the existing session.
   */
  sessionId?: string;
  /** Where this session's artifacts go. Defaults to `<sessionsDir>/<sessionId>`. */
  sessionDir?: string;
  /** Where the child's token tracker writes. Defaults to `<sessionDir>/tokens.json`. */
  tokenFile?: string;
  /**
   * The calling conversation, when the caller PROVED it (see
   * `proveCallingConversation`). Recorded verbatim in `spawn.json` and
   * `SessionInfo`; absent means not proven. Never pass an unproven id.
   */
  parentClaudeSessionId?: string;
  /**
   * The environment the pane child is built from (X-M9). Defaults to the manager's
   * `parentEnv`, then `process.env`. Tests pass a hermetic one instead of mutating
   * `process.env`.
   */
  parentEnv?: Record<string, string | undefined>;
}

export interface ChannelEvent {
  type: ChannelEventType;
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

export interface SessionManagerOptions {
  maxSessions?: number;
  scrollbackCapacity?: number;
  onStateChange?: (sessionId: string, event: ChannelEvent) => void;
  /** Artifact root override. Defaults to CLAUDISH_SESSIONS_DIR, then ~/.claudish/sessions. */
  sessionsDir?: string;
  /**
   * How long a TERMINAL session stays in the manager's map before it is
   * evicted. Defaults to 30 minutes.
   *
   * `maxSessions` bounds only active sessions, so without eviction a long-lived
   * MCP server retains every finished session for the life of the process. The
   * on-disk artifacts are unaffected by eviction.
   */
  terminalRetentionMs?: number;
  /**
   * Test override for the host pid recorded in `spawn.json`. Default:
   * `hostPidFrom(process.env, process.ppid)` (channel/parent-proof.ts). An
   * override records no `launcherPid`.
   */
  hostPid?: number;
  /** The environment pane children are built from (X-M9). Defaults to `process.env`. */
  parentEnv?: Record<string, string | undefined>;
  /** @internal test-only pane timing seams (X-M7); production never passes them. */
  paneTimings?: PaneSessionOptions["timings"];
}
