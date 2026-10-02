/**
 * StreamJsonReducer — turns a child's `--output-format stream-json` NDJSON into
 * channel state, prose, and accounting.
 *
 * ## What it replaces, and why
 *
 * `SignalWatcher` inferred state by regex-matching Claude Code's INTERACTIVE TUI
 * glyphs (`⏺ Read`, spinner text) against the output of a child running in PRINT
 * mode, which emits none of them. Every pattern was therefore dead from the day
 * it shipped: `feed()` never matched, the machine never left `starting`, and the
 * only transition that ever fired was the one driven by process exit. Two real
 * sessions ran 15 minutes, made 93 tool calls and generated 68 k output tokens,
 * and were recorded as `turnsCompleted: 0, tokensUsed: 0, status: "completed"`
 * with a 0-byte output log.
 *
 * The fix is not a better regex. The child can be asked to *declare* its state,
 * and 2.1.239 does: `--output-format stream-json` emits one JSON object per line
 * for every message, tool call, hook and turn boundary, and `result` carries
 * `terminal_reason` / `is_error` / `api_error_status` / `num_turns` / `usage`.
 * Transitions become facts instead of guesses.
 *
 * ## Three rules that are load-bearing
 *
 * 1. **Deltas are consumed and discarded.** With `--include-partial-messages` a
 *    long session emits 20–60 k `stream_event` frames (~230 B each, 5–14 MB).
 *    Storing them would evict all 2 000 lines of `ScrollbackBuffer` within
 *    seconds and leave a ring full of three-character text fragments. They exist
 *    here to prove the child is alive — nothing more.
 *
 * 2. **Per-line degradation, never latching.** Only a line that is BOTH valid
 *    JSON AND carries a recognised `type` is treated as an event. Anything else
 *    goes to the answer verbatim. This is not defensive padding: a real run of
 *    `claude 2.1.239` put `Client.listTools() called but server does not
 *    advertise tools capability - returning empty list` on stdout, mid-stream.
 *    Sniffing the format once from the first line would have been cheaper and
 *    would have silently disabled recovery for the whole run.
 *
 * 3. **Terminal states are absorbing.** The 900-second silent success was
 *    manufactured by a guard that blocked only `cancelled`, so a process exit
 *    could *upgrade* a `failed` the timeout handler had already decided. The
 *    transition table below makes every terminal state absorbing, and an attempt
 *    to leave one is recorded rather than obeyed.
 */

import {
  type AssistantTextCapture,
  STREAM_JSON_EVENT_TYPES,
  createAssistantTextCapture,
} from "../team-stream-capture.js";
import type { ChannelEventType, ReducerCallback, ReducerEvent } from "./types.js";

/**
 * Frame types that exist only to prove liveness.
 *
 * They are counted, they reset the stall watchdog, and then they are dropped —
 * never fed to the answer capture, never written to the event log. `stream_event`
 * is the partial-message delta firehose (rule 1 above).
 */
const DELTA_FRAME_TYPES = new Set(["stream_event"]);

/**
 * Which lines reach the answer capture.
 *
 * `STREAM_JSON_EVENT_TYPES` is the capture's own vocabulary, imported rather
 * than duplicated: a frame it does not recognise it passes through VERBATIM, so
 * handing it `rate_limit_event` (or any type Claude Code adds next) would dump
 * raw protocol JSON into the answer an agent reads. Measured — that is exactly
 * what happened to `rate_limit_event` before this gate existed.
 *
 * Non-JSON lines still go through, which is the point of the degradation rule:
 * the worst case must be an ugly answer, never a lost one.
 */
function reachesAnswer(
  parsedType: string | null,
  isJson: boolean,
  keepUnrecognizedJson: boolean
): boolean {
  if (!isJson) return true;
  if (parsedType !== null && STREAM_JSON_EVENT_TYPES.has(parsedType)) return true;
  // JSON that is not stream-json vocabulary. A channel session's stdout is pure
  // stream-json, so for the channel this is machine noise and dropping it keeps
  // the answer clean. `team` needs the opposite — see keepUnrecognizedJson.
  return keepUnrecognizedJson;
}

const TERMINAL_STATES: readonly ChannelEventType[] = [
  "completed",
  "failed",
  "cancelled",
  "timeout",
];

/**
 * Which states may follow which. Absent from a row ⇒ illegal.
 *
 * The four terminal states have EMPTY rows, which is the whole point: once a
 * supervisor (timeout, cancel, exit classification) has decided how a session
 * ended, nothing may revise it.
 */
const LEGAL_TRANSITIONS: Record<ChannelEventType, readonly ChannelEventType[]> = {
  starting: ["running", "tool_executing", "waiting_for_input", "finishing", ...TERMINAL_STATES],
  running: ["tool_executing", "waiting_for_input", "finishing", ...TERMINAL_STATES],
  tool_executing: ["running", "waiting_for_input", "finishing", ...TERMINAL_STATES],
  waiting_for_input: ["running", "tool_executing", ...TERMINAL_STATES],
  // The final turn ended and stdin is closed: only the exit verdict may follow.
  // A frame arriving here is outside the stream-json contract, so it is refused
  // and recorded as an anomaly rather than moving the session backwards.
  finishing: [...TERMINAL_STATES],
  completed: [],
  failed: [],
  cancelled: [],
  // Absorbing, like every other terminal state. `"timeout"` reaches the wire
  // now that EVENT_TO_TASK_STATUS knows how to project it; it used to be
  // laundered into `"failed"` here and re-attached to the record separately.
  timeout: [],
};

/** Debounce window for batching rapid tool_use frames into one notification. */
const TOOL_BATCH_MS = 500;

/**
 * Default stream silence before a stall notice, in seconds.
 *
 * Only `starting` and `running` are watched. `tool_executing` is deliberately
 * exempt: a 10-minute `Bash` produces no frames at all and is not stalled, it is
 * working. `waiting_for_input` is exempt for the same reason — silence there is
 * the contract. `finishing` is exempt too: the child is exiting, and the session
 * timeout bounds it.
 */
const DEFAULT_STALL_SECONDS = 120;

/** How often the stall watchdog looks at the clock. Bounded so tests stay quick. */
const STALL_TICK_CEILING_MS = 15_000;

/** Bounded per-session record of illegal transitions and unparseable lines. */
const MAX_ANOMALIES = 50;

/** What the child reported on its terminal `result` frame. */
export interface ResultSummary {
  /** `subtype`, e.g. "success" / "error_max_turns". */
  subtype: string | null;
  isError: boolean;
  /** `terminal_reason`, e.g. "completed". Null when the field is absent. */
  terminalReason: string | null;
  /** `api_error_status` — a number when the turn died on an upstream status. */
  apiErrorStatus: number | null;
  stopReason: string | null;
  numTurns: number;
  inputTokens: number;
  outputTokens: number;
  permissionDenials: number;
}

/**
 * The owner's answer, at a turn end, to "does stdin stay open?".
 *
 * - `"stdin-open"`   → the session waits for `send_input`: `waiting_for_input`.
 * - `"stdin-closed"` → that was the final turn and the child is exiting:
 *   `finishing`, then a terminal state.
 *
 * The reducer cannot see stdin, so it asks. Deciding it here instead is what
 * used to put every one-shot session through a false `waiting_for_input`.
 */
export type TurnEnd = "stdin-open" | "stdin-closed";

export interface StreamJsonReducerOptions {
  sessionId: string;
  callback: ReducerCallback;
  /** Seconds of stream silence before a stall notice. 0 disables the watchdog. */
  stallSeconds?: number;
  /**
   * Keep JSON lines that are not stream-json vocabulary, instead of dropping
   * them. Default false.
   *
   * The two consumers want opposite things and both are right. A CHANNEL
   * session's stdout is pure stream-json, so a stray JSON object is machine
   * noise and keeping it would pollute the answer. A TEAM slot's response file
   * is the only place a reader ever sees what the child printed, and this
   * project has already lost real answers to a parser that decided something
   * was not worth keeping (see ai-docs/architecture/team-capture.md) — so team
   * preserves anything it does not positively recognise.
   *
   * Note the asymmetry this fixes: an UNPARSEABLE line is kept either way
   * ("keep it, verbatim — it is the only place a reader would ever see it"),
   * so dropping *valid* JSON was the stricter of the two rules, not the looser.
   */
  keepUnrecognizedJson?: boolean;
  /**
   * Fired once per terminal `result` frame, BEFORE the state changes, and its
   * answer decides the state the turn end moves to (see `TurnEnd`).
   * SessionManager closes stdin on a one-shot session's first `result` and
   * answers `"stdin-closed"`, which is what lets the session reach `completed`
   * instead of idling until the timeout; `team` closes stdin at spawn and always
   * answers `"stdin-closed"`.
   *
   * Required, so the compiler names every construction site: a default would
   * silently pick one of the two states for a caller that never decided.
   */
  onResult: (summary: ResultSummary) => TurnEnd;
  /**
   * Every line except the delta firehose, verbatim. Persisted to `events.jsonl`
   * so a post-mortem has the structured record the prose cannot carry.
   *
   * `label` is the frame's `type` (with `:subtype` when it carries one), or null
   * for a line that did not parse as a typed JSON frame. Passed along rather
   * than re-derived by the consumer, which would mean a second `JSON.parse` of
   * every frame purely to name it.
   */
  onSemanticLine?: (line: string, label: string | null) => void;
  /** Recovered assistant prose, streamed as it is decoded. */
  onProse?: (text: string) => void;
}

/** Shape of the frames we read. Everything is optional — the wire is not ours. */
interface Frame {
  type?: unknown;
  subtype?: unknown;
  session_id?: unknown;
  cwd?: unknown;
  status?: unknown;
  hook_name?: unknown;
  is_error?: unknown;
  terminal_reason?: unknown;
  api_error_status?: unknown;
  stop_reason?: unknown;
  num_turns?: unknown;
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
  permission_denials?: unknown;
  message?: { content?: unknown };
}

const asString = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const asNumber = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** `"system:init"`, `"result"`, or null for a line that carried no `type`. */
function labelFor(type: string | null, subtype: string | null): string | null {
  if (type === null) return null;
  return subtype === null ? type : `${type}:${subtype}`;
}

/**
 * The same label, for a line read back off `events.jsonl` rather than off the
 * wire.
 *
 * Exported so the disk-recovery path in `SessionManager` cannot invent a second
 * spelling of a label a live session already has a spelling for — two formats
 * for the same frame would make a post-mortem's events unmatchable against a
 * live one's. It re-parses, which the live path must never do: there the frame
 * is already in hand and `labelFor` takes it directly.
 */
export function labelForLine(line: string): string | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object") return null;
    const frame = parsed as Frame;
    return labelFor(asString(frame.type), asString(frame.subtype));
  } catch {
    // Not JSON — the same case the reducer records as an unparseable line.
    return null;
  }
}

export class StreamJsonReducer {
  private _state: ChannelEventType = "starting";
  private disposed = false;

  /** Incomplete trailing line held until its newline arrives. */
  private pending = "";
  private readonly capture: AssistantTextCapture = createAssistantTextCapture();

  private toolBatchTimer: ReturnType<typeof setTimeout> | null = null;
  private toolBatchCount = 0;
  /** How many tools the IMMEDIATE notification already reported, so the batched one adds news. */
  private toolBatchAnnounced = 0;
  private toolBatchName: string | null = null;

  private stallTimer: ReturnType<typeof setInterval> | null = null;
  private readonly stallMs: number;
  private lastFrameAt = Date.now();
  /** True while a stall notice is outstanding, so it is announced once per episode. */
  private stallAnnounced = false;

  // ─── Accounting, all sourced from the child's own frames ───────────────────
  private _claudeSessionId: string | null = null;
  private _cwd: string | null = null;
  private _turns = 0;
  private _inputTokens = 0;
  private _outputTokens = 0;
  private _toolUseCount = 0;
  private _terminalReason: string | null = null;
  private _apiErrorStatus: number | null = null;
  private _resultIsError = false;
  private _resultSeen = false;
  private readonly _anomalies: string[] = [];

  constructor(private readonly opts: StreamJsonReducerOptions) {
    const seconds = opts.stallSeconds ?? DEFAULT_STALL_SECONDS;
    this.stallMs = seconds > 0 ? seconds * 1000 : 0;
    if (this.stallMs > 0) {
      const tick = Math.min(this.stallMs, STALL_TICK_CEILING_MS);
      this.stallTimer = setInterval(() => this.checkStall(), tick);
      // A watchdog must never be the reason a process stays alive.
      this.stallTimer.unref?.();
    }
  }

  get state(): ChannelEventType {
    return this._state;
  }
  get claudeSessionId(): string | null {
    return this._claudeSessionId;
  }
  /** The child's own report of its working directory, from `system:init`. */
  get cwd(): string | null {
    return this._cwd;
  }
  get turns(): number {
    return this._turns;
  }
  get tokens(): number {
    return this._inputTokens + this._outputTokens;
  }
  get toolUseCount(): number {
    return this._toolUseCount;
  }
  /**
   * Milliseconds since the child last put ANYTHING on stdout.
   *
   * Reported, never acted on. Silence is not a verdict: a child inside a long
   * `Bash` emits no frames and is working, not wedged, which is why
   * `tool_executing` is exempt from the stall notice. The agent asking "when did
   * session X last say something?" has context this class does not, so it gets
   * the number and makes the call — including the call to `cancel_session`.
   *
   * This is the signal `team` used to lack. It polled `stats/<id>.json`, which
   * only advances when tokens flow, so a slot compiling for 90s looked dead and
   * was killed. Frames arrive throughout — Claude Code emits `tool_progress`
   * heartbeats every 30s inside a long tool call — so this number stays honest
   * where a token-flow timestamp does not.
   */
  get idleMs(): number {
    return Math.max(0, Date.now() - this.lastFrameAt);
  }
  get terminalReason(): string | null {
    return this._terminalReason;
  }
  get apiErrorStatus(): number | null {
    return this._apiErrorStatus;
  }
  /** True once a `result` frame arrived. Exit 0 without one has not earned `completed`. */
  get sawResult(): boolean {
    return this._resultSeen;
  }
  get resultIsError(): boolean {
    return this._resultIsError;
  }
  /** Illegal transitions and unparseable lines, bounded. Diagnostics only. */
  get anomalies(): readonly string[] {
    return this._anomalies;
  }

  // ─── Input ─────────────────────────────────────────────────────────────────

  /** Feed a raw stdout chunk. Returns the assistant prose recovered from it. */
  feed(chunk: string): string {
    if (this.disposed) return "";

    this.pending += chunk;
    let prose = "";
    let newlineAt = this.pending.indexOf("\n");
    while (newlineAt !== -1) {
      const line = this.pending.slice(0, newlineAt);
      this.pending = this.pending.slice(newlineAt + 1);
      prose += this.consumeLine(line, true);
      newlineAt = this.pending.indexOf("\n");
    }
    return prose;
  }

  /**
   * Flush the trailing partial line and close the answer capture.
   *
   * A child killed mid-frame leaves an incomplete line; it is passed to the same
   * per-line rule, which will fail to parse it and keep it verbatim rather than
   * dropping it.
   */
  end(): string {
    if (this.disposed) return "";
    let prose = "";
    if (this.pending.length > 0) {
      prose += this.consumeLine(this.pending, false);
      this.pending = "";
    }
    const tail = this.capture.end();
    if (tail) {
      prose += tail;
      this.opts.onProse?.(tail);
    }
    return prose;
  }

  /**
   * A new turn has just been handed to the child. Clears the PREVIOUS turn's
   * terminal witness.
   *
   * Without this, `sawResult` is session-global and latches true forever: turn
   * 1 answers successfully, `send_input` starts turn 2, the child dies mid-turn
   * and exits 0 — and `classifyExit` finds turn 1's `result` sitting there and
   * calls the run completed. That is the original bug in a new costume, a
   * session reporting success on evidence that does not belong to it, so the
   * witness has to be scoped to the turn that is actually outstanding.
   *
   * `_turns`, the token counters and `_terminalReason` are deliberately NOT
   * reset — they are cumulative session accounting and the last observed
   * reason, not completion evidence.
   *
   * A session that was `waiting_for_input` is no longer waiting once a turn is
   * handed over, so this moves it to `running` — the only transition it makes.
   * From any other state it only resets the flags above.
   */
  beginTurn(): void {
    if (this.disposed) return;
    this._resultSeen = false;
    this._resultIsError = false;
    this._apiErrorStatus = null;
    // A turn was just sent, so the stream is legitimately busy again.
    this.lastFrameAt = Date.now();
    this.stallAnnounced = false;
    if (this._state === "waiting_for_input") {
      this.transition("running", { content: "input received" });
    }
  }

  /**
   * A promptless session waits for its first `send_input` from the moment it
   * exists: `starting → waiting_for_input`. A no-op from any other state.
   *
   * Without it such a session read `starting`, then `running` on the child's
   * `system:init`, while nothing would happen until the caller sent input.
   */
  awaitInput(): void {
    if (this.disposed || this._state !== "starting") return;
    this.transition("waiting_for_input", { content: "waiting for the first input" });
  }

  /**
   * Move to a terminal state, or to any state a supervisor decides.
   *
   * This is the ONLY way `completed` / `failed` / `cancelled` / `timeout` is
   * reached, and the transition table makes those absorbing — a later caller
   * cannot revise a verdict that has already been recorded.
   */
  settle(state: ChannelEventType, opts?: { content?: string }): void {
    if (this.disposed) return;
    this.resetToolBatch();
    this.transition(state, { content: opts?.content });
  }

  /** Stop every timer. Called once, from SessionManager's exit/shutdown paths. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resetToolBatch();
    if (this.stallTimer) {
      clearInterval(this.stallTimer);
      this.stallTimer = null;
    }
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  /**
   * One line of the child's stdout.
   *
   * Order matters: the delta check comes first so the firehose costs one
   * `JSON.parse` and nothing else, and the answer capture is only ever handed
   * lines that could plausibly carry prose.
   */
  private consumeLine(line: string, terminated: boolean): string {
    if (line.trim().length === 0) return "";

    this.lastFrameAt = Date.now();
    if (this.stallAnnounced) {
      this.stallAnnounced = false;
    }

    let frame: Frame | null = null;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object") frame = parsed as Frame;
    } catch {
      // Not JSON. Rule 2: keep it, verbatim, in the answer — it is the only
      // place a reader would ever see it.
      this.note(`unparseable line: ${line.slice(0, 120)}`);
    }

    const type = frame ? asString(frame.type) : null;

    // Liveness only. Never stored, never shown, never logged.
    if (type !== null && DELTA_FRAME_TYPES.has(type)) return "";

    this.opts.onSemanticLine?.(line, labelFor(type, frame ? asString(frame.subtype) : null));

    if (frame && type !== null) this.applyFrame(frame, type);

    if (!reachesAnswer(type, frame !== null, this.opts.keepUnrecognizedJson ?? false)) return "";

    // The answer capture owns prose recovery; hand it the line exactly as it
    // arrived, newline included, so `outputBytes` agrees with what the child
    // actually wrote.
    const prose = this.capture.write(terminated ? `${line}\n` : line);
    if (prose) this.opts.onProse?.(prose);
    return prose;
  }

  private applyFrame(frame: Frame, type: string): void {
    switch (type) {
      case "system":
        this.applySystemFrame(frame);
        return;

      case "assistant": {
        const tools = this.toolUseNames(frame);
        if (tools.length > 0) {
          // Every BLOCK, not one per frame. Parallel tool calls are Claude
          // Code's default shape, so counting frames under-reported exactly the
          // metric ("93 tool calls") the silent-success incident was measured by.
          this._toolUseCount += tools.length;
          this.batchToolUse(tools[0], tools.length);
        } else if (this._state === "starting" || this._state === "finishing") {
          // From `finishing` the transition table refuses this and records the
          // anomaly: a frame after the final `result`, with stdin closed, is
          // outside the stream-json contract and must not revive the session.
          this.transition("running", { content: "assistant turn started" });
        }
        return;
      }

      case "user":
        // A `tool_result` closes a tool round trip; a replayed user message
        // (`--replay-user-messages`) is the child acking our input. Either way
        // the model is the thing that runs next. From `finishing` the table
        // refuses it and records the anomaly, as for `assistant` above.
        if (
          this._state === "tool_executing" ||
          this._state === "waiting_for_input" ||
          this._state === "finishing"
        ) {
          this.transition("running");
        } else if (this._state === "starting") {
          this.transition("running");
        }
        return;

      case "result":
        this.applyResultFrame(frame);
        return;

      default:
        // `rate_limit_event` and anything a future Claude Code adds. Recorded on
        // disk by the caller, ignored for state — an unknown frame must never
        // move a state machine.
        return;
    }
  }

  private applySystemFrame(frame: Frame): void {
    const subtype = asString(frame.subtype);

    if (subtype === "init") {
      this._claudeSessionId = asString(frame.session_id);
      this._cwd = asString(frame.cwd);
      // A promptless session announces itself with `init` while it still waits
      // for its first input; that is not a turn starting, so the wait stands.
      if (this._state === "waiting_for_input") return;
      this.transition("running", { content: "session initialised" });
      return;
    }

    // `{"status":"requesting"}` — the child's own first-party liveness signal,
    // emitted at the top of every request. Enough on its own to leave `starting`
    // when partial messages are off.
    if (subtype === "status" && this._state === "starting") {
      this.transition("running", { content: `status: ${asString(frame.status) ?? "requesting"}` });
      return;
    }

    // `--include-hook-events` reports the lifecycle of hooks the USER has
    // configured (measured: only `SessionStart` and `Stop` fired, because those
    // are the only two in ~/.claude/settings.json). It does NOT synthesise
    // PreToolUse/PostToolUse, so it is a diagnostic signal, not a state source.
  }

  private applyResultFrame(frame: Frame): void {
    const subtype = asString(frame.subtype);
    this._resultSeen = true;
    // `subtype` carries `error_max_turns` / `error_during_execution` — turns
    // that ended badly but do not always set `is_error`. Reading only
    // `is_error` let those through as clean completions.
    this._resultIsError = frame.is_error === true || (subtype?.startsWith("error") ?? false);
    this._terminalReason = asString(frame.terminal_reason);
    this._apiErrorStatus =
      typeof frame.api_error_status === "number" ? frame.api_error_status : null;
    this._turns = asNumber(frame.num_turns) || this._turns;
    this._inputTokens = asNumber(frame.usage?.input_tokens) || this._inputTokens;
    this._outputTokens = asNumber(frame.usage?.output_tokens) || this._outputTokens;

    const summary: ResultSummary = {
      subtype,
      isError: this._resultIsError,
      terminalReason: this._terminalReason,
      apiErrorStatus: this._apiErrorStatus,
      stopReason: asString(frame.stop_reason),
      numTurns: this._turns,
      inputTokens: this._inputTokens,
      outputTokens: this._outputTokens,
      permissionDenials: Array.isArray(frame.permission_denials)
        ? frame.permission_denials.length
        : 0,
    };

    // The owner decides FIRST whether stdin stays open, and the state follows
    // its answer. A turn boundary with stdin still open IS `waiting_for_input`;
    // one where the owner just closed stdin is `finishing`, and the child walks
    // to a terminal state on its own. Transitioning before asking is what put
    // every one-shot session through a `waiting_for_input` nothing waited in.
    const turnEnd = this.opts.onResult(summary);
    const content = summary.isError
      ? `turn ended with an error (${summary.terminalReason ?? summary.subtype ?? "unknown"})`
      : `turn ${summary.numTurns} complete`;
    this.transition(turnEnd === "stdin-closed" ? "finishing" : "waiting_for_input", { content });
  }

  /** Every `tool_use` block in an assistant message, in order. */
  private toolUseNames(frame: Frame): string[] {
    const content = frame.message?.content;
    if (!Array.isArray(content)) return [];
    const names: string[] = [];
    for (const raw of content) {
      const block = raw as { type?: unknown; name?: unknown };
      if (block?.type === "tool_use") names.push(asString(block.name) ?? "unknown");
    }
    return names;
  }

  /**
   * Announce the first tool immediately, then one aggregated notification per
   * burst. A batch of eight parallel Reads is one useful line, not eight.
   */
  private batchToolUse(toolName: string, count = 1): void {
    this.toolBatchCount += count;
    this.toolBatchName = toolName;

    if (this._state !== "tool_executing") {
      this.transition("tool_executing", { toolName, toolCount: count });
      this.toolBatchAnnounced = count;
    }

    if (this.toolBatchTimer) clearTimeout(this.toolBatchTimer);
    this.toolBatchTimer = setTimeout(() => {
      this.toolBatchTimer = null;
      // The batch is only ever a NOTIFICATION about the state we are still in.
      // `transition` already cancels a pending batch on any move away from
      // `tool_executing`, and this second check covers the ordering where the
      // timer was already in the macrotask queue when that move happened:
      // firing then would have dragged a `running` (final text being generated)
      // or a `waiting_for_input` session back to `tool_executing` with no tool
      // running at all.
      if (
        !this.disposed &&
        this._state === "tool_executing" &&
        this.toolBatchCount > 1 &&
        this.toolBatchCount > this.toolBatchAnnounced
      ) {
        this.transition("tool_executing", {
          toolName: this.toolBatchName ?? undefined,
          toolCount: this.toolBatchCount,
          repeat: true,
        });
      }
      this.toolBatchCount = 0;
      this.toolBatchAnnounced = 0;
      this.toolBatchName = null;
    }, TOOL_BATCH_MS);
    this.toolBatchTimer.unref?.();
  }

  /**
   * Report — never terminate — a stream that has gone quiet where it should not
   * be quiet.
   *
   * This is the 900-second case made visible. Terminating is the session
   * timeout's job; this only ensures the agent is not staring at a state that
   * has not changed in ten minutes with no way to tell working from wedged.
   */
  private checkStall(): void {
    if (this.disposed || this.stallAnnounced) return;
    if (this._state !== "starting" && this._state !== "running") return;
    const idleMs = Date.now() - this.lastFrameAt;
    if (idleMs < this.stallMs) return;

    this.stallAnnounced = true;
    this.transition(this._state, {
      repeat: true,
      content: `no output from the child for ${Math.round(idleMs / 1000)}s`,
      stalled: true,
    });
  }

  private transition(newState: ChannelEventType, extra?: Partial<ReducerEvent>): void {
    const prev = this._state;

    if (prev === newState) {
      // Self-transitions are only ever notifications (batched tools, stall
      // notices). Everything else would be wire spam.
      if (!extra?.repeat) return;
    } else if (!LEGAL_TRANSITIONS[prev].includes(newState)) {
      // Loud, but not fatal: this runs inside a stdout data handler on the MCP
      // server's event loop, and throwing here would take down every other
      // session with it. Recording + refusing is what kills the original bug —
      // an exit must never upgrade a verdict a supervisor already reached.
      this.note(
        `illegal transition ${prev} → ${newState}${TERMINAL_STATES.includes(prev) ? " (terminal state is absorbing)" : ""}`
      );
      return;
    }

    // Leaving `tool_executing` invalidates any batch still being accumulated.
    // Without this the debounce timer outlives the state it describes: a
    // `user` frame carrying the tool_result moves the session to `running`,
    // the model starts its final text, and 450 ms later the stale timer yanks
    // it back to `tool_executing` — a state change the child never reported.
    if (newState !== "tool_executing") this.resetToolBatch();

    this._state = newState;

    this.opts.callback(this.opts.sessionId, {
      previousState: prev,
      newState,
      timestamp: new Date().toISOString(),
      ...extra,
    });
  }

  /** Record an anomaly. Bounded — a pathological stream must not become a leak. */
  private note(text: string): void {
    if (this._anomalies.length >= MAX_ANOMALIES) return;
    this._anomalies.push(text);
    if (process.env.CLAUDISH_CHANNEL_TRACE === "1") {
      process.stderr.write(`[channel-trace] reducer sid=${this.opts.sessionId} ${text}\n`);
    }
  }

  /** Drop the pending tool batch: its timer, its count, and its name. */
  private resetToolBatch(): void {
    if (this.toolBatchTimer) {
      clearTimeout(this.toolBatchTimer);
      this.toolBatchTimer = null;
    }
    this.toolBatchCount = 0;
    this.toolBatchAnnounced = 0;
    this.toolBatchName = null;
  }
}
