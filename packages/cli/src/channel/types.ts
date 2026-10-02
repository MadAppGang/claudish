// ─── Channel Mode Types ──────────────────────────────────────────────────────

export type SessionStatus =
  | "starting"
  | "running"
  | "tool_executing"
  | "waiting_for_input"
  /**
   * The session's FINAL turn ended and claudish closed the child's stdin; the
   * child has not exited yet. Non-terminal, and nothing waits for input: only
   * a terminal state follows. Distinct from `waiting_for_input`, which holds
   * only while stdin stays open and the session waits for `send_input`.
   */
  | "finishing"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout";

/**
 * The values the channel wire's `event` field may carry. Identical to
 * `SessionStatus` — the record and the wire agree.
 *
 * They did not always. This alias was `Exclude<SessionStatus, "timeout">`,
 * because `EVENT_TO_TASK_STATUS` (mcp-server.ts) maps the event enum onto
 * SEP-1686's 5-value `TaskStatus` and had **no `"timeout"` key**: it fell
 * through to `?? "working"`, so emitting `"timeout"` reported a dead session as
 * still working. The timeout path therefore recorded `"timeout"` and emitted
 * `"failed"`, and a consumer watching only the wire could not tell a session
 * that ran out of time from one that errored.
 *
 * `["timeout", "failed"]` now exists in that map — SEP-1686 has no `timeout`
 * member and `failed` is its only honest projection — so the divergence is gone
 * and `ReducerEvent` no longer carries a `sessionStatus` override.
 */
export type ChannelEventType = SessionStatus;

export interface SessionInfo {
  sessionId: string;
  model: string;
  /**
   * The explicit `provider@model` spec the child was actually SPAWNED with, when
   * the parent pinned one (see `prehydrateCredentialsForSpawn`). Null means the
   * child was handed `model` verbatim and did its own routing.
   *
   * `model` is the display identity an agent correlates on and is never
   * rewritten, so without this field the resolved half of the chain is invisible
   * — and "which provider actually served this?" is the first question a routing
   * failure raises.
   */
  spawnModel: string | null;
  status: SessionStatus;
  pid: number | null;
  startedAt: string;
  completedAt: string | null;
  exitCode: number | null;
  /** `result.num_turns` from the child's terminal frame. 0 until one arrives. */
  turnsCompleted: number;
  /** Total tokens, PROXY-measured where possible. See SessionManager.refreshAccounting. */
  tokensUsed: number;
  elapsedSeconds: number;
  /**
   * Seconds since the child last put anything on stdout. Null for a session
   * with no live reducer (already finalised, or restored from disk).
   *
   * INFORMATION, not a verdict. Nothing in claudish terminates a session for
   * being idle. A child inside a long `Bash` is silent and working; only the
   * caller knows whether that is expected for the task it set. Read this, decide,
   * and call `cancel_session` if the answer is no.
   */
  idleSeconds: number | null;
  /**
   * Real spend in USD, from the proxy's own token file.
   *
   * Deliberately NOT `result.total_cost_usd`: the child prices every model at
   * Anthropic's rates, so for a proxied model that figure is fiction — and for a
   * subscription provider it invents spend that will never be billed.
   */
  costUsd: number;
  /** Tool invocations the proxy counted, falling back to `tool_use` blocks seen on the stream. */
  toolCallCount: number;
  /** `result.terminal_reason` verbatim. Null when no terminal frame ever arrived. */
  terminalReason: string | null;
  /**
   * The child `claude`'s own session uuid — minted here and passed as
   * `--session-id`, then confirmed from its `system:init` frame. This is the
   * transcript filename under `~/.claude/projects/<slug>/`, so a diagnostic
   * consumer can find the full record without guessing by mtime.
   */
  claudeSessionId: string | null;
  /**
   * Absolute path to the child's authoritative JSONL transcript, or null before
   * `claudeSessionId` is known.
   *
   * Not a guess: the uuid is minted here and passed as `--session-id`, and the
   * directory is `~/.claude/projects/<slug of the REALPATH of cwd>`. The realpath
   * is the load-bearing half — on macOS `/tmp` is a symlink to `/private/tmp` and
   * a git worktree can be reached through one too, so the slug of the path we
   * SPAWNED with names a directory that does not exist. That is literally how the
   * incident's two transcripts were "missing": they were under the session's
   * `work_dir`, in a project directory nobody looked in.
   */
  transcriptPath: string | null;
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
   * - given  → one-shot. Sent as the opening `user` frame; stdin is closed as
   *   soon as the child reports a terminal `result`, so the session passes
   *   through `finishing` and ends at `completed` instead of idling to the
   *   timeout. It never enters `waiting_for_input`.
   * - absent → interactive. Stdin stays open indefinitely. The session is in
   *   `waiting_for_input` from creation until the first `send_input`, and again
   *   after every turn the child finishes.
   *
   * A `send_input` call converts a one-shot session to interactive — the caller
   * has taken over driving it, so we stop deciding when it is finished.
   */
  prompt?: string;
  timeoutSeconds?: number;
  claudishFlags?: string[];
  cwd?: string;
  /**
   * Use this id instead of minting a random one. Must be unique among live
   * sessions; a collision throws rather than silently adopting the existing
   * session.
   *
   * `team` needs it: its slots are anonymised ids ("01".."05") that address
   * everything else about the run — `response-<id>.md`, `stats/<id>.json`, the
   * manifest, the status file. A random session id would mean two names for one
   * slot and a mapping table to keep in step.
   */
  sessionId?: string;
  /**
   * Where this session's artifacts go. Defaults to `<sessionsDir>/<sessionId>`.
   *
   * `team` points every slot at a directory inside the TEAM run, so one run's
   * evidence stays in one place rather than scattering across
   * `~/.claudish/sessions` under ids nothing links back.
   */
  sessionDir?: string;
  /**
   * Where the child's token tracker writes. Defaults to `<sessionDir>/tokens.json`.
   *
   * `team` points it at `stats/<slot>.json`, which is what `renderTeamStatsCompact`
   * and the status file already read.
   */
  tokenFile?: string;
  /**
   * Keep JSON lines that are not stream-json vocabulary. Default false.
   * See `StreamJsonReducerOptions.keepUnrecognizedJson` for why the two
   * consumers differ.
   */
  keepUnrecognizedJson?: boolean;
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

/** One state change out of the stream-json reducer. */
export interface ReducerEvent {
  previousState: ChannelEventType;
  newState: ChannelEventType;
  content?: string;
  toolName?: string;
  toolCount?: number;
  /**
   * Emit even when `newState === previousState`.
   *
   * Two callers need it: the batched-tool notification (a second
   * `tool_executing` carrying a count) and the stall notice (a `running` that
   * says the stream has gone quiet). Without it those are swallowed by the
   * no-op guard, which exists so ordinary repeated frames do not spam the wire.
   */
  repeat?: boolean;
  /**
   * The stream has gone quiet in a state that should be producing frames.
   * Surfaced on the wire as `meta.stalled` so a consumer can tell "still
   * thinking" from "wedged" without parsing the content string.
   */
  stalled?: boolean;
  timestamp: string;
}

export type ReducerCallback = (sessionId: string, event: ReducerEvent) => void;

export interface SessionManagerOptions {
  maxSessions?: number;
  scrollbackCapacity?: number;
  onStateChange?: (sessionId: string, event: ChannelEvent) => void;
  /** Artifact root override. Defaults to CLAUDISH_SESSIONS_DIR, then ~/.claudish/sessions. */
  sessionsDir?: string;
  /**
   * Seconds of total stream silence, in a state that should be producing
   * frames, before the session reports itself stalled. 0 disables the watchdog.
   */
  stallSeconds?: number;
  /**
   * How long a TERMINAL session stays in the manager's map before it is
   * evicted. Defaults to 30 minutes.
   *
   * `maxSessions` bounds only active sessions, so without eviction a long-lived
   * MCP server retains every finished session — and its scrollback, reducer and
   * stderr buffer — for the life of the process. The on-disk artifacts are
   * unaffected by eviction.
   */
  terminalRetentionMs?: number;
}
