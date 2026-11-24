/**
 * `PaneSession` — one interactive Claude Code, launched through claudish, in its own
 * headless magmux pane, driven over the socket (architecture §2.9–§2.10).
 *
 * The transcript decides turn state (D3): acceptance, settle, answer and accounting.
 * magmux supplies liveness (`exit`, pids), the screen (`watch` frames) and input
 * (`send`). The lifecycle is the phase table of `slot-state.ts`; this class is the only
 * thing that fires its events. Policy stays with the owner (D8): `decide(turn)` and
 * `onBlocked(block)` are the owner's, never ours.
 *
 * Every event handler runs inside `step()`, which reports the NET wire-state change of
 * one event-processing step to `onTransition` (so RUNNING → IDLE → ADMITTING in one step
 * reports nothing) and coalesces `onChange` to at most 4 per second.
 *
 * No claudish timer ends a turn after its prompt was accepted (D10). The only bounds are
 * boot (90 s) and admission of the CREATED prompt (30 s), before any work exists, and a
 * MCP session's own `timeoutMs`.
 *
 * Session hooks (architecture §7.3). With a `hooks` binding, a settled turn is RECORDED
 * first (its answer published through `onTurnRecorded`, before any transition) and
 * CONCLUDED later: between the two the pane sits in `SETTLING` (wire RUNNING) while
 * `binding.settle()` runs. The phase is the latch: the ticker never re-settles a held
 * turn, and every way out of the hold is a table edge that aborts it with a reason. An
 * injection the hold returns becomes the next turn of the session's TURN CHAIN; the
 * verdict is taken once, at the end, on the session's current shape. Without a binding
 * none of this runs: `finishTurn` is today's code path exactly.
 */

import type { ChildProcess } from "node:child_process";
import { readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeCodeConfigDir } from "../auth/claude-code-facts.js";
import { getConfigFileOverride } from "../config-override.js";
import {
  type HookQueueItem,
  type InjectionQueueState,
  type QueueItem,
  afterAdmission,
  callerCount,
  emptyQueueState,
  hookCount,
  next as nextQueueDecision,
} from "../hooks/injection/queue.js";
import type {
  HoldAbortReason,
  HoldInjection,
  HoldResult,
  SessionHookBinding,
} from "../hooks/session/binding.js";
import { log } from "../logger.js";
import { redactSecrets } from "../redact.js";
import {
  type BoxMatch,
  cursorGapAfterText,
  locateBox,
  locatedBoxText,
  matchBoxText,
} from "./box-locate.js";
// the box-text matcher lives with the box reader; these names stay importable from here
export { type BoxMatch, boxShowsLine, matchBoxText } from "./box-locate.js";
import {
  type CaptureResult,
  type CaptureUnchanged,
  ContractErrorException,
  type FailureReason,
  type SlotState,
} from "./contract.js";
import { childExitEvidence } from "./exit-evidence.js";
import {
  GATE_INPUT_RETRY_MS,
  GATE_INPUT_WAIT_MS,
  type GateBindingCheck,
  checkGateBinding,
} from "./gate-binding.js";
import {
  BOOT_DIALOG_KINDS,
  type GateDialogKind,
  type GateInput,
  SEND_READY_WAIT_DEFAULT_MS,
  type SendOutcome,
  type SendOutcomeKind,
  type TypingStop,
  assertNever,
  classifySendReply,
  mismatchBoxStayedEmpty,
  parseGateInput,
  sendBudgetMs,
  writtenPrefix,
} from "./input-gate.js";
import { MagmuxClient, type MagmuxConnectError, type MagmuxReply } from "./magmux-client.js";
import {
  type ClaudishLaunch,
  FATAL_MAGMUX_STDERR,
  MIN_MAGMUX_VERSION,
  SUBCOMMAND_WORDS,
  assertMagmuxAvailable,
  buildClaudishPaneArgv,
  buildPaneEnv,
  createLaunchDirs,
  ensureSockRoot,
  launcherScript,
  mintPaneId,
  resolveClaudishLaunch,
  sockRootFor,
  spawnPaneMagmux,
  spawnPaneWatcher,
  versionAtLeast,
  writeLauncherFiles,
} from "./pane-launch.js";
import { type PaneReapSubject, alive, reapPaneProcesses, retryPaneReap } from "./pane-reap.js";
import {
  type RegisteredPane,
  ensureSwept,
  installPaneShutdownHooks,
  ownerStartOfSelf,
  paneShutdownHooksInstalled,
  refreshGroupOf,
  registerPane,
  removePaneFiles,
  reservePanes,
  takePaneReservation,
  updateRecord,
  writeRecord,
} from "./pane-registry.js";
import {
  DEFAULT_PANE_COLS,
  DEFAULT_PANE_ROWS,
  type PaneSize,
  RESIZE_QUIET_MS,
  clampPaneSize,
  samePaneSize,
} from "./pane-size.js";
import {
  type GroupSnapshot,
  type PaneIdentity,
  isLaunchDirPath,
  readProcessTableAsync,
  recordPathOf,
  sockPathOf,
} from "./process-identity.js";
import { type Delivery, deliveryRefusal, planDelivery, writeTurnFile } from "./prompt-delivery.js";
import {
  agentRejectedLine,
  choiceDialog,
  dialogText,
  flatText,
  hasChoiceDialog,
  inputBox,
  isWorking,
  menuAbove,
  nameBootScreen,
  screenAnswer,
  screenErrorRows,
  screenText,
  stopHookRunning,
  transcriptSavingOff,
  workingAboveBox,
} from "./screen-classifier.js";
import {
  type MagmuxCapture,
  type MagmuxFrame,
  type ScreenState,
  applyFrame,
  emptyScreen,
} from "./screen-model.js";
import {
  CTRL_END,
  LIVE_BOTTOM,
  type ScrollPosition,
  type ScrollRequest,
  UNKNOWN_POSITION,
  isLiveBottom,
  planScroll,
} from "./scroll-input.js";
import { KNOWN_STATUSES, type RegistryRecord, SessionRegistry } from "./session-registry.js";
import {
  CORROBORATION_MS,
  type CorroborationFacts,
  SECONDARY_QUIET_MS,
  type SettleDecision,
  agentCountMismatch,
  decideSettle,
} from "./settle-rule.js";
import { type TurnCore, settledTurnCoreOf } from "./settled-turn.js";
import {
  type Phase,
  type PhaseEvent,
  isTerminalPhase,
  nextPhase,
  wireState,
} from "./slot-state.js";
import {
  TranscriptFollower,
  type TranscriptView,
  type TurnView,
  type Witness,
} from "./transcript-follower.js";
import type { FinalVerdict, PaneSnapshot, SettledTurn } from "./types.js";
import { type ControlCapabilities, verifyViewSocket } from "./view-socket.js";

export type { FinalVerdict, PaneSnapshot, SettledTurn } from "./types.js";

export const BOOT_TIMEOUT_MS = 90_000;
export const ADMIT_TIMEOUT_MS = 30_000;
/**
 * A turn the input gate accepted with no transcript witness this long after the acceptance
 * settles from the screen (degraded mode). Acceptance itself is never inferred from the
 * screen (architecture-v2 §5.7).
 */
export const DEGRADED_ENTRY_MS = 10_000;
/** Degraded settle: no change above the box for 2 × this. */
export const SCREEN_SETTLE_QUIET_MS = 3_000;
/** A panel command's screen must have been up this long after delivery before Esc. */
const PANEL_SETTLE_MS = 500;
/**
 * @deprecated Nothing reads it: boot readiness is magmux's `input.ready` (architecture-v2
 * §6.2), which waits for the box and a raw terminal both still for 1 s AND for Claude
 * Code's boot stdin reset (or 3.5 s after the terminal first went raw) — the hazard this
 * 3 s wait existed for. Kept only so the integration test that pins it still loads; delete
 * it with that test.
 */
export const REPL_STABLE_MS = 3_000;
/**
 * A gated send's client request timeout is magmux's own upper bound on it
 * (`sendBudgetMs`, protocol.SendBudget) plus this. Every admission attempt is sized so
 * that timeout ends by the admission deadline (architecture-v2 R1.4).
 */
const SEND_CLIENT_SLACK_MS = 2_000;
/** No attempt is started with less readiness wait than this (R1.4). */
const MIN_READY_TIMEOUT_MS = 1_000;
/**
 * The readiness floor of an Enter-only send. Its box already holds the text (a typed send
 * verified it, or the screen showed it settled), so magmux is ready for the key at once;
 * a pane that is not answers `busy` with no key pressed, and the loop tries again. The
 * lower floor lets a line whose draw settles late still get its Enter: the send then needs
 * its fixed part (10 824 ms), the client slack and this, 13 074 ms in all.
 */
const ENTER_MIN_READY_TIMEOUT_MS = 250;
/** A `busy` refusal (Enter not pressed): the next attempt after this. */
const BUSY_RETRY_MS = 250;
/** After a ctrl-u from the admission loop: wait at most this for a fresh `ready` reading. */
const CLEAR_WAIT_MS = 1_000;

/**
 * After a mismatch whose box stayed empty: how long the box's text must stay unchanged on
 * the screen before claudish acts on it (`awaitDraw`). Claude Code draws typed text 300–800 ms
 * after reading it at rest, and a backlog read in more than one read is drawn read by read,
 * so text that is still growing can be the first part of what was sent. Two seconds is more
 * than twice the at-rest draw lag, so a later read of the same backlog is drawn inside the
 * window, and it still leaves most of a 30 s admission for the Enter or the resend.
 */
const DRAW_SETTLE_MS = 2_000;

/**
 * The number of ctrl-u keys that empties a box holding this admission's leftover text.
 * Claude Code's ctrl-u deletes ONE wrapped screen row, not the whole box, and extra ctrl-u
 * keys on an empty box do nothing (both measured on Claude Code 2.1.330). A gated send types
 * its line once (magmux 0.20.2 never retypes), so leftover text is at most one copy per send
 * made so far; the count is still sized for two copies per send, as headroom for text that
 * is not ours, and covers that many screen cells (a wide character takes two) wrapped at
 * half the box width (word wrap can leave a row far shorter than the box), plus one row.
 */
export function clearKeyCount(line: string, attempts: number, cols: number): number {
  const cells = 2 * Math.max(1, attempts) * Bun.stringWidth(line);
  const halfRow = Math.max(1, Math.floor((cols - 4) / 2));
  return Math.ceil(cells / halfRow) + 1;
}
/** A dialog or choice screen static this long blocks boot. */
const BOOT_STATIC_MS = 5_000;
const TICK_MS = 250;
/** research-magmux §6 recommends 2–4; 4 halves boot/witness latency at no idle cost. */
const WATCH_FPS = 4;
const POLL_BACKSTOP_MS = 1_000;
/** R3-M4: a `finishing` turn with a static screen for this many secondary windows. */
const TURN_END_MISSING_FACTOR = 3;
/** A resize reply, and the screen showing the new size after it. */
const RESIZE_REPLY_MS = 10_000;
const RESIZE_SCREEN_MS = 1_000;
/** A scroll send's reply (one raw `send`, no gate). */
const SCROLL_REPLY_MS = 5_000;
/** After a scroll's reply: wait at most this for the screen to change (`timings.scrollScreenMs`). */
const SCROLL_SCREEN_MS = 1_000;
/**
 * magmux's input gate is read by polling `list` (it publishes no readiness event and
 * refreshes `input` at 4 Hz): one request in flight at a time, this often, while connected.
 */
const GATE_POLL_MS = 250;
const GATE_REPLY_MS = 1_000;
/** A gate reading older than this, or any reading while disconnected, is unknown. */
const GATE_STALE_MS = 1_000;
/**
 * The most gate corroboration may delay a transcript-closed turn (architecture-v2 §7.1,
 * Jack's decision J2): after this much chat quiet it settles with `settle_gate_unconfirmed`.
 */
export const GATE_GRACE_MS = SECONDARY_QUIET_MS;
/**
 * `list` showing pane 0 dead this long with no `exit` event: take the exit path anyway.
 * The event stays the primary path (it carries `lastLine`); this is its backstop.
 */
const GATE_DEAD_BACKSTOP_MS = 1_000;
/**
 * The longest a liveness exit (ESRCH while disconnected) waits for magmux to name the code.
 * magmux keeps a dead pane's code after the socket drops, and whatever dropped the socket can
 * hold the path away for a moment, so the query redials until this bound rather than asking
 * once. Two seconds covers a socket that comes back within about a second of the exit being
 * seen (the liveness check itself runs once a second); it is also all a magmux that is gone,
 * wedged or slow can add to the finish.
 */
const EXIT_CODE_QUERY_MS = 2_000;
/** The redial period inside EXIT_CODE_QUERY_MS, and the `list` re-ask period. */
const EXIT_CODE_RETRY_MS = 50;
/** Gate reasons that carry no dialog kind: a static screen under one is named from its words. */
const GATE_KINDLESS_REASONS: ReadonlySet<string> = new Set([
  "starting",
  "terminal_not_ready",
  "no_input_box",
]);
/** Dialogs a turn can open; a boot dialog kind is never one of them. */
const RUNTIME_DIALOG_KINDS: ReadonlySet<GateDialogKind> = new Set<GateDialogKind>([
  "permission",
  "question",
  "plan",
  "select",
]);
/** The session registry is re-read at most this often (telemetry only). */
const REGISTRY_READ_MS = 250;
/** A registry/screen disagreement must hold this long before it is counted. */
const REGISTRY_DISAGREE_MS = 2_000;
/**
 * `registry_idle_gate_starting` must hold this long: while it waits for Claude Code's boot
 * reset the gate says `starting` for up to its 3.5 s floor plus 1 s of stillness, a window
 * in which the registry can already read idle. Longer than that, it is the canary.
 */
const REGISTRY_GATE_BOOT_DISAGREE_MS = 5_000;
/** No live registry record this long after boot was ready: `registry_record_missing`. */
const REGISTRY_MISSING_MS = 5_000;
const MAX_ANOMALY_KEYS = 64;
/** Settled answers kept for `turnAnswer` (owners read the current or the last one). */
const KEPT_ANSWERS = 4;
/** `hooks.injection.maxConsecutive` when the binding does not say (§4.7 rule 5). */
const DEFAULT_MAX_CONSECUTIVE = 3;

export interface PaneBlock {
  kind: "question" | "permission";
  tool: string;
  text: string;
}

export interface PaneSessionOptions {
  kind: "t" | "s";
  label: string;
  /** already checked by checkChildFlags */
  callerFlags: string[];
  spawnModel: string;
  /** `spawnModel` is the parent's pin for a bare name (`--model-pinned`); absent → named by the caller */
  spawnPinned?: boolean;
  cwd: string;
  sessionUuid: string;
  /** transcriptPathFor(realpath cwd, sessionUuid, projectsDir(parentEnv, cwd)) — the caller derives it */
  transcriptPath: string;
  slotEnv: Record<string, string>;
  shape: "one-shot" | "interactive";
  /** enqueued before boot; delivered on boot_ready */
  initialPrompt?: string;
  /** the pane's size at launch, clamped here; DEFAULT_PANE_COLS × DEFAULT_PANE_ROWS when absent */
  initialSize?: PaneSize;
  /** false when callerFlags remove Read (§2.3 rule 4) */
  readAvailable: boolean;
  decide: (turn: SettledTurn) => FinalVerdict | "continue";
  onBlocked: (b: PaneBlock) => FinalVerdict | "wait";
  bootTimeoutMs?: number;
  /** initialDelivery only */
  admitTimeoutMs?: number;
  /** whole-session deadline → TIMEOUT (MCP sessions only; team never passes it) */
  timeoutMs?: number;
  /** the session's hook binding (§7.3); absent → today's code path exactly */
  hooks?: SessionHookBinding;
  /**
   * Synchronous, in the step that records a settled turn, before any transition of that
   * step (binding present only): the answer reaches the owner before anything can end
   * the session.
   */
  onTurnRecorded?: (turn: SettledTurn) => void;
  /** coalesced ≤ 4/s */
  onChange?: (snap: PaneSnapshot, prev: SlotState) => void;
  /** every wire-state change, synchronously, never coalesced, NET of one event-processing step */
  onTransition?: (t: { from: SlotState; to: SlotState; at: string; snap: PaneSnapshot }) => void;
  magmuxBinary?: string;
  sockRoot?: string;
  claudishSpawn?: ClaudishLaunch;
  parentEnv?: Record<string, string | undefined>;
  /** @internal test-only timing seams (X-M7); production never passes them */
  timings?: {
    secondaryQuietMs?: number;
    screenSettleQuietMs?: number;
    degradedEntryMs?: number;
    /**
     * @deprecated ignored: there is no resend timer; magmux's input gate resends Enter
     * itself (architecture-v2 §5.1). Kept so the tests that still pass it load.
     */
    resendAfterMs?: number;
    corroborationMs?: number;
    /** GATE_GRACE_MS */
    gateGraceMs?: number;
    bootStaticMs?: number;
    /** @deprecated ignored: boot readiness is magmux's `input.ready` (see `REPL_STABLE_MS`) */
    replStableMs?: number;
    /** H-31: hold the exit-path screen capture this long, as a slow magmux reply does */
    exitCaptureDelayMs?: number;
    /** a LATER admission's bound, through owners that do not pass `admitTimeoutMs` (H-13 … H-15) */
    admitTimeoutMs?: number;
    /** a frame polls the transcript only this long after the last poll (default 250) */
    pollDebounceMs?: number;
    /** with no frame, the transcript is polled this often (default 1 000) */
    pollBackstopMs?: number;
    /** SCROLL_SCREEN_MS: after a scroll's reply, the wait for a changed screen */
    scrollScreenMs?: number;
  };
}

/**
 * What `resize` answers: the size SET, whether the pane's size moved, and the screen's
 * seq after it. `pending` = the socket is reconnecting; the size is applied on the redial.
 */
export interface PaneResizeOutcome {
  cols: number;
  rows: number;
  changed: boolean;
  seq: number;
  pending?: true;
}

export type SendResult =
  | { ok: true; queued: number }
  | { ok: false; reason: "terminal" | "delivery_unavailable" | "unsupported_command" };

/** What `get_diagnostics` reads from a live pane beyond the snapshot (§4.2). */
export interface PaneDiagnostics {
  /** the head of magmux's own stderr (≤ 8 KB) */
  magmuxStderr: string;
  /** the child's session-registry record as last read (telemetry); null when none matched */
  registry: { status: string | null; waitingFor: string | null; version: string | null } | null;
  /** assistant text before a file-delivered turn's task file was read (X-H4) */
  preambleBytes: number;
  /** read coverage of the current turn's task file; null for a typed turn or no turn */
  readCoverage: {
    linesTotal: number;
    linesReturned: number;
    complete: boolean;
    reads: number;
  } | null;
  /**
   * magmux's input gate as last read (`list` → pane 0 `input`); `ageMs` since it was read.
   * null: never read on this connection, or disconnected. Additive (architecture-v2 §9).
   */
  gate: { ready: boolean; reason: string | null; detail: string | null; ageMs: number } | null;
  /** The last gated send's outcome, in the input gate's own words; null before any send. */
  lastSend: PaneLastSend | null;
}

/** `get_diagnostics`' view of the last gated send (architecture-v2 §9, R1.2). */
export interface PaneLastSend {
  kind: SendOutcomeKind;
  /** a `busy` / `not_accepted` reason, or a client / magmux code */
  reason?: string;
  accept?: string;
  evidence?: string;
  /** gated sends of the admission (or control line) it belongs to */
  attempts: number;
}

export interface PaneSession {
  readonly paneId: string;
  readonly sockPath: string;
  /** resolves when the wire state leaves STARTING: RUNNING, AWAITING_INPUT (promptless), or terminal */
  readonly ready: Promise<void>;
  readonly terminal: Promise<PaneSnapshot>;
  snapshot(): PaneSnapshot;
  capture(sinceSeq?: number, opts?: { spans?: boolean }): CaptureResult | CaptureUnchanged;
  send(text: string): SendResult;
  /**
   * Set the terminal size (clamped). Allowed in every live state; a terminal session
   * answers its last size with `changed:false`. Throws `ContractErrorException` with
   * `resize_unsupported` (magmux lacks the op) or `delivery_unavailable`.
   */
  resize(cols: number, rows: number): Promise<PaneResizeOutcome>;
  /**
   * Scroll the child's transcript view: `by` rows (negative = toward older content, a
   * target ± 1 row, clamped to MAX_SCROLL_ROWS) or `to:"end"` (the live bottom), as raw
   * wheel / ctrl-End bytes in one ungated magmux send that types nothing. Answers the
   * screen's seq after it (the first changed screen within SCROLL_SCREEN_MS, else the
   * current one). Throws `ContractErrorException` `scroll_unavailable` while the pane is
   * starting, finished, delivering a prompt, reading its turn from the screen or
   * reconnecting, or when magmux did not confirm the send; nothing is queued.
   */
  scroll(req: ScrollRequest): Promise<{ seq: number }>;
  turnAnswer(index: number): string;
  /** The recorded chain answers plus the running chain turn's partial, joined like chainAnswerOf. */
  chainText(): string;
  /** main-chain assistant message ids the transcript has shown, first-seen order, each once */
  assistantMessageIds(): readonly string[];
  diagnostics(): PaneDiagnostics;
  cancel(): { changed: boolean; state: SlotState };
  expire(): { changed: boolean; state: SlotState };
  reaped(): Promise<void>;
  /**
   * Resolves once a reap VERIFIED the pane group and magmux gone and removed the pane's
   * files: on the first attempt, or on a later registry retry. Never resolves while the
   * reap is unverified (`reapFailed`): `reaped()` resolves then too, and a survivor may
   * still write. The only signal that proves the child's writer is gone
   * (`transcript_session`'s `final`).
   */
  reapVerified(): Promise<void>;
}

/**
 * Which gated send of an admission comes next (architecture-v2 §5.4): `submit` types the
 * line and presses Enter in one send; a slash command is `type` (no Enter), a menu check,
 * then `enter` (`{keys:["enter"]}`, itself a gated SUBMIT).
 */
export type SubmitStep = "submit" | "type" | "enter";

/**
 * Why no further send of an admission is made: Enter may have been pressed and nothing
 * proves it, so only claudish's own transcript witness can accept now (§5.6, R1.3).
 */
type SubmittedUnproven = "unconfirmed" | "reply_lost" | "still_in_box" | "maybe_submitted_by_other";

interface Admission {
  index: number;
  /** a hook item's admission takes the hook routes when it is never accepted (§7.3 step 7) */
  item: QueueItem;
  text: string;
  plan: Delivery;
  /** the one line every gated send of this admission types */
  line: string;
  initial: boolean;
  startedAt: number;
  /** startedAt + (initial ? admitTimeoutMs : ADMIT_TIMEOUT_MS); no attempt outlives it */
  deadline: number;
  step: SubmitStep;
  /** a gated send of this admission awaits its reply */
  inFlight: boolean;
  /** gated sends made */
  attempts: number;
  submittedUnproven: SubmittedUnproven | null;
  /** a command that opened a panel or picker (§5.4 `panelStep`) */
  panel: null | {
    showingSince: number | null;
    escaped: boolean;
    /** Enter reached the pane (`unconfirmed`), or not (`busy dialog:select`) */
    entered: boolean;
  };
  /** no further attempt: a stop row of §5.2 already decided, or the pane is gone */
  stopped: boolean;
  /** the box may hold this admission's own text (a lost TYPE reply, a withheld Enter) */
  clearFirst: boolean;
  /**
   * When the reply that set `clearFirst` arrived. Only a gate reading received after it (by
   * one publication interval) may clear the flag: an older one can say `ready` while that
   * delivery's text is still being drawn (Revision 3 item 2, DB-2).
   */
  clearAfter: number;
  /**
   * When a `text_mismatch` reply said the box stayed EMPTY: the copy sent may still sit
   * unread in Claude Code's input queue, so nothing is typed or cleared until the box shows
   * text (`awaitDraw`). Null otherwise.
   */
  awaitingDraw: number | null;
  /**
   * While `awaitingDraw`, what the screen last showed in the box, for the detail at the
   * deadline: nothing, the start of the line (still being drawn), or text still changing.
   */
  drawState: DrawState;
  /**
   * The line of an earlier admission's copy that may still sit unread in Claude Code's input
   * queue (`unreadCopy`): while set, the box is read against THAT line, and this admission
   * types nothing until the leftover has shown and settled, or shown and gone.
   */
  leftoverOf: string | null;
  /** the earlier copy's witness, offset and written part, kept with `leftoverOf` (`inheritUnreadCopy`) */
  leftoverCopy: { witness: Witness; after: number; part: string | null } | null;
  /**
   * A send of this admission may have typed its line (`mayHaveTyped`) and no ctrl-u has been
   * sent since: if the admission ends unwitnessed, that copy may still be unread
   * (`rememberUnreadCopy`).
   */
  uncleared: boolean;
  /**
   * Proof that this admission's whole line was in the box since its last send that may have
   * typed: magmux verified it (`in_box`, a `still_in_box` or `unconfirmed` reply, an
   * `accepted`), or a trusted frame drew it whole. Every byte of it was read, so it leaves no
   * unread copy behind (`rememberUnreadCopy`). A later send that may have typed resets it.
   */
  readWhole: boolean;
  /** the transcript offset marked before this admission was delivered: its copy's records land after it */
  mark: number;
  /**
   * The copy this admission waits on (`leftoverOf`) has its own transcript record
   * (`releaseRecordedCopy`): it was submitted, so an empty settled box now ends the wait.
   */
  copyReleased: boolean;
  /** when `awaitCopyRecord` began waiting for the earlier copy's record (null: it has not) */
  recordWaitFrom: number | null;
  /**
   * The part of this admission's line magmux wrote before it stopped typing partway
   * (`noteStoppedTyping`); null when the whole line was written or the reply had no counts.
   */
  writtenPart: string | null;
  /** a TYPE whose reply was lost: its delivery may still be typing until `until` (R1.5.3) */
  lostType: { client: MagmuxClient; until: number } | null;
  /** the latest reply, for `prompt_not_accepted`'s detail */
  last: SendOutcome | null;
  /** anomaly keys counted once per admission */
  noted: Set<string>;
  /** the connection this admission's ctrl-End check ran on: at most once per connection */
  liveBottomClient: MagmuxClient | null;
}

/** A `resize` call waiting for the drain worker's send that carries its size (or a later one). */
interface ResizeWaiter {
  resolve: (r: PaneResizeOutcome) => void;
  reject: (e: unknown) => void;
}

/** A `list` result, as far as it is read here. */
interface ListResult {
  panes?: Array<Record<string, unknown>>;
}

interface ScreenTurn {
  echo: string;
  acceptedAt: number;
  errorLogSize: number;
}

const EVENT_REASON: Partial<Record<PhaseEvent, FailureReason>> = {
  boot_dialog: "first_run_dialog",
  boot_blocked: "boot_blocked",
  admit_deadline: "prompt_not_accepted",
  pane_lost: "pane_lost",
  cancel: "cancelled",
  timeout: "timeout",
};

const VERDICT_EVENT: Record<FinalVerdict["state"], PhaseEvent> = {
  COMPLETED: "verdict_completed",
  EMPTY: "verdict_empty",
  SHAPE_MISMATCH: "verdict_shape_mismatch",
  FAILED: "verdict_failed",
};

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function screenTailOf(s: ScreenState, n = 12): string {
  const lines = s.lines.filter((l) => l.trim());
  return lines.slice(-n).join("\n");
}

export class PaneSessionImpl implements PaneSession, RegisteredPane {
  /** The verified read-only view socket of a live pane; null when there is none to publish. */
  get viewSockPath(): string | null {
    return isTerminalPhase(this.phase) ? null : this.viewSock;
  }

  readonly paneId: string;
  readonly sockPath: string;
  readonly root: string;
  readonly identity: PaneIdentity;
  readonly ready: Promise<void>;
  readonly terminal: Promise<PaneSnapshot>;
  group: GroupSnapshot | null = null;
  reapFailed = false;

  private readonly o: PaneSessionOptions;
  private readonly turnDir: string;
  private readonly ctlDir: string;
  private readonly follower: TranscriptFollower;
  private readonly startedAtMs = Date.now();
  private readonly secondaryQuietMs: number;
  private readonly corroborationMs: number;

  private resolveReady!: () => void;
  private resolveTerminal!: (s: PaneSnapshot) => void;
  private readySettled = false;

  private phase: Phase = "BOOTING";
  private initialDelivery = false;
  private initialPending: boolean;
  private shape: "one-shot" | "interactive";
  /** caller and hook items (§7.2); the policy is the pure `hooks/injection/queue.ts` */
  private q: InjectionQueueState;
  private screen: ScreenState;
  private final = false;
  private turnIndex = 0;
  private admission: Admission | null = null;
  private screenTurn: ScreenTurn | null = null;
  private turnSource: "transcript" | "screen" = "transcript";
  private turnsCompleted = 0;
  private rewakeOfSettled = false;
  private settledChatOffset: number | null = null;
  /** the settled turn was read from the follower's shadow view (`TurnView.unwitnessed`) */
  private settledOnShadow = false;
  private lastChatOffset: number | null = null;
  private lastChatSeenAt = 0;
  private currentDelivery: Delivery | null = null;
  private answers = new Map<number, string>();
  private lastCaptureSource: SettledTurn["captureSource"] | null = null;
  private exitRequested = false;
  private escapeArmed = false;
  private escapeSentAt: number | null = null;
  private blockedToolId: string | null = null;
  private reason: FailureReason | null = null;
  private detail: string | null = null;
  private activity: string | null = null;
  private exitCode: number | null = null;
  private endedAtMs: number | null = null;
  private claudeCodeVersion: string | null = null;
  private anomalies = new Map<string, number>();
  private turnEndMissing = false;
  /** the live agent_count_mismatch pair as `counted/reported`; null while counts agree */
  private agentMismatch: string | null = null;
  private readonly registry: SessionRegistry;
  private registryRec: RegistryRecord | null = null;
  private registryEverSeen = false;
  private lastRegistryReadAt = 0;
  private bootReadyAtMs: number | null = null;
  /** registry/screen disagreements now holding, with when each began; counted once at onset */
  private disagreeSince = new Map<string, number>();
  private disagreeCounted = new Set<string>();
  /** the exit capture's text, kept only when it holds an `--agent` refusal the screen lacks */
  private exitScrollback = "";
  /** the exit capture's text, whatever it holds */
  private exitCapture = "";
  /** whether the exit capture was taken on the alternate screen */
  private exitCaptureAlt = false;
  private exitLastLine = "";

  /** the size the viewer asked for last (clamped); the drain worker always sends THIS one */
  private desiredSize: PaneSize;
  /** the view socket proven read-only on the current connection; null = none to publish */
  private viewSock: string | null = null;
  /** the pane's size as magmux last confirmed it; null = unknown (a lost or timed-out reply) */
  private appliedSize: PaneSize | null;
  /** `capabilities.verbs` contains "resize", as of the latest attach */
  private supportsResize = false;
  private resizeWaiters: ResizeWaiter[] = [];
  private resizeDraining = false;
  /** the size of the worker's last send on this connection; null = none since the attach */
  private lastSentSize: PaneSize | null = null;
  /**
   * The resize quiet window [from, until): opened at a send, only ever extended (a lost
   * reply may follow an applied resize, so nothing retracts it); 0 = never opened.
   */
  private resizeQuietFrom = 0;
  private resizeQuietUntil = 0;
  /** the last screen change that is activity, i.e. not a resize redraw (M4) */
  private activityChangedAt = 0;
  /**
   * Where the child's transcript view is believed to be (`scroll-input.ts`). An accepted
   * submit snaps the view to the bottom, so `accept()` resets it.
   */
  private scrollPos: ScrollPosition = LIVE_BOTTOM;
  /** ctrl-End sends awaiting magmux's reply */
  private scrollEndsInFlight = 0;
  /** when magmux last confirmed a ctrl-End; 0 = never (a screen turn's quiet counts from it) */
  private scrollEndConfirmedAt = 0;

  /** the last `list` → pane 0 `input` reading; read through `gateNow()`, never directly */
  private gate: GateInput | null = null;
  /** this connection passed the binding check: its gate readings may be trusted */
  private gateTrusted = false;
  /** ends the pause between two `list` reads of an attach at once; null when none is running */
  private endGatePause: (() => void) | null = null;
  /** numbers each attached connection; its frames are stamped with it (`onFrame`) */
  private connectionGen = 0;
  /** the connection whose binding check passed last (`gateTrusted` while it is current) */
  private trustedGen = 0;
  /**
   * Counts every time trust is (re)established. A reader that saw one value and now sees
   * another knows the connection changed under it, however briefly, even between its polls.
   */
  private trustEpoch = 0;
  /**
   * The connection that delivered the latest frame, visible or not: `applyFrame` keeps the
   * screen object on a frame that changes nothing, so only this stamp says a frame came.
   */
  private lastFrameGen = 0;
  private gateInFlight = false;
  private gateTimer: ReturnType<typeof setInterval> | null = null;
  /** when `list` first showed pane 0 dead with no `exit` event yet; 0 = not dead */
  private gateDeadSince = 0;
  /** the last gated send's outcome (`get_diagnostics`) */
  private lastSend: PaneLastSend | null = null;
  /**
   * When the current turn was accepted, by the gate's evidence or the witness: the
   * degraded-entry clock (§5.7) and the `witness_missing` clock (§5.8). null: not accepted.
   */
  private turnAcceptedAt: number | null = null;
  private turnErrorLogSize = 0;
  private witnessMissingCounted = false;
  /** the turn whose witness copy count was read (`witness_copies:<k>` once per turn) */
  private witnessCopiesTurn = 0;
  /** a later send abandoned unwitnessed: a witness arriving in IDLE re-wakes this turn (§5.3) */
  private abandonedIndex: number | null = null;
  /**
   * The line of a copy that may still sit unread in Claude Code's input queue: an admission
   * expired after typing it, waiting on a box that showed none of it, or not all. The next
   * admission types nothing until that copy has shown (then clears it) or shown and gone.
   * Forgotten when the clear path runs, when a trusted frame shows the box empty and settled
   * after the copy had shown, or when that copy's own witness arrives.
   */
  private unreadCopy: string | null = null;
  /** the remembered copy's witness and the transcript offset it was typed after (`rememberCopy`) */
  private unreadCopyWitness: Witness | null = null;
  private unreadCopyAfter = 0;
  /**
   * The part of the remembered copy that was written when magmux stopped typing it partway
   * (`writtenPart`); null when the whole copy was written or the reply had no counts.
   */
  private unreadCopyPart: string | null = null;
  /**
   * The remembered copy showed WHOLE and then left the box (`awaitCopyRecord`): every byte of it
   * was read, so nothing of it can be queued, only its transcript record is still to come. Keys
   * go again (`keysWithheld`), and an empty settled box ends a wait on it. Cleared by
   * `rememberCopy` and `forgetCopy`.
   */
  private unreadCopyReadWhole = false;
  /**
   * The remembered copy was answered `still_in_box`: its whole line was in the box and Enter was
   * pressed, but Claude Code may not have read that Enter, so it may still be queued. The line
   * shown and settled in the box proves nothing then: only the box emptying (the Enter read, the
   * line submitted) or the copy's record ends a wait on it. Keys stay withheld meanwhile.
   * Cleared by `rememberCopy` and `forgetCopy`.
   */
  private unreadCopyEnterPending = false;
  /** moves on every `rememberCopy`, so a copy of the same text remembered again is watched afresh */
  private unreadCopyGen = 0;
  /** the copy the follower watches (`syncCopyWatch`) */
  private watchedCopyKey: string | null = null;
  /** a control line (`/exit`, `/quit`) waiting out `unreadCopy`: nothing else is admitted */
  private controlPending = false;

  /* session hooks (§7.3); untouched without a binding */
  private readonly hooks: SessionHookBinding | null;
  /** the turn chain: every recorded answer since the last caller admission */
  private chain: Array<{ index: number; answer: string; writtenFiles: string[] }> = [];
  private chainHead: SettledTurn["delivery"] | null = null;
  private hookTurns = 0;
  /** the current turn was admitted from a hook item */
  private turnHookCaused = false;
  /** recorded, not yet concluded */
  private heldTurn: SettledTurn | null = null;
  private holdGen = 0;
  private holdController: AbortController | null = null;
  private holdWatchdog: ReturnType<typeof setTimeout> | null = null;
  /**
   * The hold's result, waiting in SETTLING until the screen shows the session idle
   *. Applied, or handed back to the binding by `endHold`; never both.
   */
  private heldResult: { result: HoldResult; since: number } | null = null;
  /** `callerAdmitted` when sessionStart fired: its injections survive the initial prompt */
  private startCallerSeq = 0;

  private magmux: ChildProcess | null = null;
  private watcher: ChildProcess | null = null;
  private client: MagmuxClient | null = null;
  private panePidValue: number | null = null;
  private stderrHead = "";
  private paneClosed = false;
  private paneExited = false;
  /** A liveness exit is asking magmux for the code; the exit path waits for the answer. */
  private exitCodeQuery = false;
  private reaping = false;
  private fastReap = false;
  private reapPromise: Promise<void> | null = null;
  private readonly verifiedReap = Promise.withResolvers<void>();
  private reconnecting = false;

  private depth = 0;
  private stepFrom: SlotState | null = null;
  private lastPollAt = 0;
  private framePending = false;
  private lastLivenessAt = 0;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private changeTimer: ReturnType<typeof setTimeout> | null = null;
  private lastChangeAt = 0;
  private lastChangeState: SlotState = "STARTING";

  constructor(
    o: PaneSessionOptions,
    ids: { paneId: string; sockPath: string; root: string; ctlDir: string; turnDir: string }
  ) {
    this.o = o;
    this.paneId = ids.paneId;
    this.sockPath = ids.sockPath;
    this.root = ids.root;
    this.ctlDir = ids.ctlDir;
    this.turnDir = ids.turnDir;
    this.identity = { paneId: ids.paneId, sessionUuid: o.sessionUuid, ctlDir: ids.ctlDir };
    this.shape = o.shape;
    const size = launchSize(o);
    this.desiredSize = size;
    // magmux sizes the pane from COLUMNS/LINES at launch, so the launch size is applied
    this.appliedSize = { ...size };
    this.screen = emptyScreen(size.cols, size.rows);
    this.initialPending = !!o.initialPrompt;
    this.hooks = o.hooks ?? null;
    this.q = emptyQueueState(this.hooks?.maxConsecutive ?? DEFAULT_MAX_CONSECUTIVE);
    if (o.initialPrompt) this.q.items.push({ kind: "caller", text: o.initialPrompt });
    this.hooks?.attach?.({
      queueInjections: (items) => this.step(() => this.queueHookInjections(items)),
    });
    this.secondaryQuietMs = o.timings?.secondaryQuietMs ?? SECONDARY_QUIET_MS;
    this.corroborationMs = o.timings?.corroborationMs ?? CORROBORATION_MS;
    this.follower = new TranscriptFollower(
      o.transcriptPath,
      join(o.transcriptPath.replace(/\.jsonl$/, ""), "subagents")
    );
    // the same environment the transcript path is derived from
    this.registry = new SessionRegistry({
      configDir: claudeCodeConfigDir(o.parentEnv ?? process.env, o.cwd),
      sessionUuid: o.sessionUuid,
    });
    this.ready = new Promise((r) => {
      this.resolveReady = r;
    });
    this.terminal = new Promise((r) => {
      this.resolveTerminal = r;
    });
  }

  /* ───────────────────────────── start ───────────────────────────── */

  /** Spawn order (X-L4): record → watcher → magmux → magmux.pid/record → dial → watch. */
  async start(input: {
    magmuxBinary: string;
    env: Record<string, string>;
    cwd: string;
  }): Promise<void> {
    const recordPath = recordPathOf(this.root, this.paneId);
    try {
      this.watcher = spawnPaneWatcher({
        paneId: this.paneId,
        sessionUuid: this.o.sessionUuid,
        ctlDir: this.ctlDir,
        sockPath: this.sockPath,
        recordPath,
        turnDir: this.turnDir,
        sockRoot: this.root,
      });
    } catch (e) {
      // a registered session must still reach a terminal state, or it stays counted
      // (livePaneCount) with its record and dirs on disk until the owner exits
      return this.spawnFailed(e);
    }
    updateRecord(this.root, this.paneId, { watcherPid: this.watcher.pid ?? null });
    let proc: ChildProcess | null = null;
    try {
      proc = spawnPaneMagmux({
        binary: input.magmuxBinary,
        paneId: this.paneId,
        sockRoot: this.root,
        ctlDir: this.ctlDir,
        cwd: input.cwd,
        env: input.env,
        sessionUuid: this.o.sessionUuid,
        transcriptPath: this.o.transcriptPath,
      });
    } catch (e) {
      return this.spawnFailed(e);
    }
    if (!proc.pid) return this.spawnFailed(new Error("magmux did not start"));
    this.magmux = proc;
    try {
      writeFileSync(join(this.ctlDir, "magmux.pid"), `${proc.pid}\n`, { mode: 0o600 });
    } catch {
      // the record carries it too
    }
    updateRecord(this.root, this.paneId, { magmuxPid: proc.pid });
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (d: string) => this.onStderr(d));
    proc.on("exit", (code, sig) => this.onMagmuxExit(code, sig));
    this.ticker = setInterval(() => this.step(() => this.evaluate()), TICK_MS);
    this.gateTimer = setInterval(() => this.pollGate(), GATE_POLL_MS);
    if (this.o.timeoutMs !== undefined)
      this.timeoutTimer = setTimeout(
        () => this.step(() => this.fire("timeout")),
        Math.max(0, this.o.timeoutMs)
      );
    await this.connectFirst();
  }

  /**
   * R3-M1: magmux could not be spawned. The terminal transition's reap does the "spawn
   * failed" reap: no magmux and no group to signal, so it removes the record and the dirs
   * and ends the watcher with `done`.
   */
  private spawnFailed(e: unknown): void {
    const msg = e instanceof Error ? e.message : String(e);
    this.step(() => this.fire("pane_lost", { detail: `magmux spawn failed: ${msg}` }));
  }

  private async connectFirst(): Promise<void> {
    let client: MagmuxClient;
    try {
      client = await MagmuxClient.connect(this.sockPath, {
        timeoutMs: 5000,
        alive: () => alive(this.magmux),
      });
    } catch (e) {
      const err = e as MagmuxConnectError;
      this.step(() =>
        this.fire("pane_lost", {
          detail: `cannot connect to ${this.sockPath}: ${err.message}${this.stderrHead ? `; magmux: ${this.stderrHead.trim()}` : ""}`,
        })
      );
      return;
    }
    await this.attach(client, false);
  }

  /** Subscribe a fresh connection: capabilities, list (dead pane?), watch. */
  private async attach(client: MagmuxClient, reconnect: boolean): Promise<void> {
    if (isTerminalPhase(this.phase) && this.reaping) {
      client.close();
      return;
    }
    client.on("snapshot", (e) => this.onSnapshot(e));
    const gen = ++this.connectionGen;
    client.on("frame", (f: MagmuxFrame) => this.onFrame(f, gen));
    client.on("exit", (e) => void this.onPaneExit(e));
    client.on("pane_closed", (e) => {
      if (e?.pane !== 0) return;
      this.paneClosed = true;
      this.endGatePause?.();
    });
    client.on("disconnected", () => this.onDisconnected(client));
    const caps = await client.request<{
      version?: string;
      protocol?: number;
      verbs?: unknown;
      viewSocket?: unknown;
    }>({
      type: "capabilities",
    });
    // The resize flag is set BEFORE this.client: a resize arriving in between sees a
    // disconnected session (stored, pending), never a connected one without the op.
    this.supportsResize =
      caps.ok && Array.isArray(caps.result.verbs) && caps.result.verbs.includes("resize");
    // dropped while asking: `disconnected` has already started the redial
    if (client.isClosed) return;
    this.client = client;
    // no gate reading is trusted on this connection until its binding check passes
    this.gateTrusted = false;
    this.gate = null;
    const magmuxVersion = caps.ok ? String(caps.result.version ?? "") : "";
    if (caps.ok) {
      const v = magmuxVersion;
      if (caps.result.protocol !== 1 || !versionAtLeast(v, MIN_MAGMUX_VERSION)) {
        this.step(() =>
          this.fire("pane_lost", {
            detail: `magmux_unavailable: magmux ${v || "?"} protocol ${caps.result.protocol ?? "?"}; panes need >= ${MIN_MAGMUX_VERSION}, protocol 1`,
          })
        );
        return;
      }
    }
    // a path proven on the previous connection says nothing about this one
    this.viewSock = null;
    void this.checkViewSocket(client, caps.ok ? caps.result : null);
    // a size set while disconnected, or one whose reply was lost, is applied now
    this.lastSentSize = null;
    if (this.supportsResize && !samePaneSize(this.appliedSize, this.desiredSize)) this.kickResize();
    await client.request({ type: "watch", pane: 0, mode: "frames", fps: WATCH_FPS });
    const bound = await this.awaitBoundPane(client, reconnect, magmuxVersion);
    if (!bound) return;
    this.trustedGen = gen;
    this.trustEpoch++;
    this.gateTrusted = true;
    this.onGateList(client, bound);
  }

  /**
   * The `list` result that passed the binding check, or null when this attach ends here: the
   * pane failed, is dead or gone, or the connection or the session ended. `list` is read again
   * only while pane 0 is declared and its input view is not published yet
   * (`GateBindingCheck.unpublished`), until `gateWaitEnd`; then that check's detail fails the
   * pane. The connection is not trusted meanwhile, so no gate reading is taken from it and
   * nothing is typed.
   */
  private async awaitBoundPane(
    client: MagmuxClient,
    reconnect: boolean,
    magmuxVersion: string
  ): Promise<ListResult | null> {
    let list = await client.request<ListResult>({ type: "list" });
    let end: number | null = null;
    for (;;) {
      // An `exit` pushed before this connection subscribed (a child that dies in its first
      // milliseconds, or one that exited in a reconnect gap) is only visible in `list`.
      const p0 = list.ok ? list.result.panes?.find((p) => p.pane === 0) : undefined;
      if (typeof p0?.pid === "number" && !this.panePidValue) this.setPanePid(p0.pid);
      if (p0?.dead === true && !this.paneExited) {
        if (!reconnect) await this.nextFrame(500); // let the keyframe land: the final screen decides agent_rejected
        void this.onPaneExit({ exitCode: p0.exitCode ?? null, lastLine: "" });
        return null;
      }
      const check = this.gateBindingOf(client, list, magmuxVersion);
      if (!check) return null;
      if (check.ok) return list.ok ? list.result : null;
      if (!check.unpublished) return this.failGateBinding(check.detail);
      end ??= this.gateWaitEnd();
      const again = await this.relistBefore(client, end);
      // whatever ended the wait decides; a reply that arrived with it is not acted on
      if (this.gateWaitOver(client)) return null;
      if (!again) return this.failGateBinding(check.detail);
      list = again;
    }
  }

  /** After a pause, another `list`; null when it is over or no answer arrived by `end`. */
  private async relistBefore(
    client: MagmuxClient,
    end: number
  ): Promise<MagmuxReply<ListResult> | null> {
    const left = end - Date.now();
    if (left <= 0 || this.gateWaitOver(client)) return null;
    await this.gatePause(Math.min(GATE_INPUT_RETRY_MS, left));
    const rest = end - Date.now();
    if (rest <= 0 || this.gateWaitOver(client)) return null;
    const list = await client.request<ListResult>({ type: "list" }, rest);
    return !list.ok && list.code === "client_timeout" ? null : list;
  }

  /**
   * When the wait for the input view ends: GATE_INPUT_WAIT_MS from now, or one tick before the
   * boot or admission deadline when that is sooner, so the pane fails with the gate's own
   * detail and not with the deadline's.
   */
  private gateWaitEnd(): number {
    const deadline =
      this.phase === "BOOTING"
        ? this.startedAtMs + (this.o.bootTimeoutMs ?? BOOT_TIMEOUT_MS)
        : (this.admission?.deadline ?? Number.POSITIVE_INFINITY);
    return Math.min(Date.now() + GATE_INPUT_WAIT_MS, deadline - TICK_MS);
  }

  /** Nothing is left to wait for: the connection, the pane or the session ended. */
  private gateWaitOver(client: MagmuxClient): boolean {
    return (
      client.isClosed ||
      this.client !== client ||
      this.paneExited ||
      this.paneClosed ||
      this.reaping ||
      isTerminalPhase(this.phase)
    );
  }

  /** A pause `endGatePause` ends at once, leaving no timer. */
  private gatePause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        if (this.endGatePause === done) this.endGatePause = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.endGatePause = done;
    });
  }

  private failGateBinding(detail: string): null {
    this.step(() => this.fire("pane_lost", { detail }));
    return null;
  }

  /** The two-socket check for this connection; a failure leaves the session running unpublished. */
  private async checkViewSocket(
    client: MagmuxClient,
    caps: ControlCapabilities | null
  ): Promise<void> {
    const check = await verifyViewSocket(caps, this.root, this.paneId);
    if (this.client !== client || isTerminalPhase(this.phase)) return;
    if (check.ok) {
      this.viewSock = check.path;
      this.scheduleChange();
      return;
    }
    this.anomaly("view_socket_unverified");
    log(`[pane] ${this.paneId} view socket unverified: ${check.detail}`);
  }

  /**
   * The binding check (architecture-v2 R1.0), on every attach: magmux's input gate is
   * trusted only for a pane it bound BY NAME to this session's id and transcript. Anything
   * else fails the pane; claudish never falls back to magmux's transcript discovery.
   * null: nothing to decide on this connection (dropped, session over, or no pane 0).
   */
  private gateBindingOf(
    client: MagmuxClient,
    list: MagmuxReply<ListResult>,
    magmuxVersion: string
  ): GateBindingCheck | null {
    // dropped while asking: the redial attaches again and re-checks
    if (client.isClosed || isTerminalPhase(this.phase)) return null;
    if (!list.ok)
      return {
        ok: false,
        detail: `input_gate_unbound: magmux ${magmuxVersion || "?"} list failed (${list.code}: ${list.error}), so the binding of pane 0 is unknown`,
      };
    // no pane 0: it is gone, and the exit path owns that
    if (!list.result.panes?.some((p) => p.pane === 0)) return null;
    return checkGateBinding(list.result, {
      sessionUuid: this.o.sessionUuid,
      transcriptPath: this.o.transcriptPath,
      magmuxVersion,
    });
  }

  /* ───────────────────────────── the input gate ───────────────────────────── */

  /**
   * One `list` on the current connection, unless one is in flight (architecture-v2 §6.1).
   * Only after this connection's binding check passed: a reading from an unbound pane could
   * describe another session's dialog.
   */
  private pollGate(): void {
    const c = this.client;
    if (!c || !this.gateTrusted || this.gateInFlight) return;
    if (this.reaping || isTerminalPhase(this.phase)) return;
    this.gateInFlight = true;
    void c
      .request<{ panes?: Array<Record<string, unknown>> }>({ type: "list" }, GATE_REPLY_MS)
      .then((r) => {
        this.gateInFlight = false;
        if (r.ok) this.onGateList(c, r.result);
      });
  }

  /**
   * A `list` reply: pane 0's `input` is the gate reading; its `pid`/`dead` back up the
   * `exit` event. A reading that changed `ready` or `reason` is evaluated at once rather
   * than at the next tick.
   */
  private onGateList(c: MagmuxClient, result: { panes?: Array<Record<string, unknown>> }): void {
    if (c !== this.client || !this.gateTrusted || isTerminalPhase(this.phase)) return;
    const now = Date.now();
    const p0 = result.panes?.find((p) => p.pane === 0);
    if (typeof p0?.pid === "number" && !this.panePidValue) this.setPanePid(p0.pid);
    if (p0?.dead === true && !this.paneExited) {
      if (this.gateDeadSince === 0) this.gateDeadSince = now;
      else if (now - this.gateDeadSince >= GATE_DEAD_BACKSTOP_MS) {
        this.anomaly("exit_event_missing");
        void this.onPaneExit({ exitCode: p0.exitCode ?? null, lastLine: "" });
        return;
      }
    } else this.gateDeadSince = 0;
    const prev = this.gate;
    this.gate = parseGateInput(result, now);
    const g = this.gate;
    if (prev?.ready !== g?.ready || prev?.reason !== g?.reason) this.step(() => this.evaluate());
  }

  /** The gate's latest reading, or null when unknown: disconnected, unbound, or stale. */
  private gateNow(): GateInput | null {
    const g = this.gate;
    if (!g || !this.client || !this.gateTrusted) return null;
    return Date.now() - g.receivedAt <= GATE_STALE_MS ? g : null;
  }

  /* ───────────────────────────── magmux events ───────────────────────────── */

  private onStderr(d: string): void {
    if (this.stderrHead.length < 8192) this.stderrHead += d.slice(0, 8192 - this.stderrHead.length);
    const fatal = d.split("\n").find((l) => FATAL_MAGMUX_STDERR.test(l));
    if (fatal) this.step(() => this.fire("pane_lost", { detail: fatal.trim() }));
  }

  private onSnapshot(e: { panes?: Array<{ pane?: number; pid?: number }> }): void {
    const p0 = e?.panes?.find((p) => p.pane === 0);
    if (p0?.pid && !this.panePidValue) this.setPanePid(p0.pid);
  }

  private setPanePid(pid: number): void {
    this.panePidValue = pid;
    updateRecord(this.root, this.paneId, { panePid: pid });
    // never a synchronous ps on the event loop: a stalled loop gets our socket dropped as a slow consumer
    void readProcessTableAsync().then((t) => {
      if (t) refreshGroupOf(this, t);
    });
  }

  private onFrame(f: MagmuxFrame, gen: number): void {
    if (f.pane !== undefined && f.pane !== 0) return;
    this.lastFrameGen = gen;
    const seq = this.screen.seq;
    this.screen = applyFrame(this.screen, f);
    if (this.screen.seq !== seq && !this.inResizeQuiet(this.screen.changedAt))
      this.activityChangedAt = this.screen.changedAt;
    this.framePending = true;
    if (!this.claudeCodeVersion) {
      const m = this.screen.lines.join("\n").match(/Claude Code v(\d+\.\d+\.\d+)/);
      if (m) this.claudeCodeVersion = m[1] ?? null;
    }
    this.step(() => this.evaluate());
  }

  private onDisconnected(client: MagmuxClient): void {
    if (this.client === client) {
      this.client = null;
      // a reading from before the drop says nothing about now
      this.gate = null;
      this.gateTrusted = false;
      this.endGatePause?.();
    }
    if (this.reaping || !alive(this.magmux)) return;
    if (isTerminalPhase(this.phase)) return;
    void this.reconnect();
  }

  /** magmux is alive (it keeps panes when a client leaves): redial with backoff while it lives. */
  private async reconnect(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    let delay = 50;
    let enoent = 0;
    try {
      while (alive(this.magmux) && !this.reaping && !isTerminalPhase(this.phase)) {
        try {
          const c = await MagmuxClient.dial(this.sockPath);
          this.anomaly("socket_reconnected");
          await this.attach(c, true);
          // dropped during its attach: `onDisconnected` left the redial to this loop
          if (!c.isClosed) return;
        } catch (e) {
          enoent = (e as MagmuxConnectError).errno === "ENOENT" ? enoent + 1 : 0;
          if (enoent >= 20) {
            this.anomaly("socket_lost");
            return;
          }
        }
        await Bun.sleep(delay);
        delay = Math.min(1000, delay * 2);
      }
    } finally {
      this.reconnecting = false;
    }
  }

  private onMagmuxExit(code: number | null, sig: NodeJS.Signals | null): void {
    if (this.reaping || isTerminalPhase(this.phase)) return;
    this.step(() => {
      this.pollFollower(true);
      const detail = `magmux exited (${sig ?? `code ${code}`}) without reporting the pane's exit${this.stderrHead ? `; stderr: ${this.stderrHead.trim().slice(0, 500)}` : ""}`;
      // §7.3 step 6 (M-1a): a held turn is concluded on its settled chain. A one-shot
      // gets its verdict; an interactive session goes to IDLE and then, as from IDLE today,
      // reports the lost pane.
      if (this.phase === "SETTLING") {
        this.endHold("exit");
        this.conclude(`magmux exited (${sig ?? `code ${code}`})`);
        if (!isTerminalPhase(this.phase)) this.fire("pane_lost", { detail });
        return;
      }
      if (this.phase === "RUNNING" && this.exitSettle()) {
        this.applyExitPath(null);
        return;
      }
      this.fire("pane_lost", { detail });
    });
  }

  /** The pane child exited (magmux `exit` event, or a dead pane found on reconnect). */
  private async onPaneExit(e: { exitCode?: unknown; lastLine?: unknown }): Promise<void> {
    if (this.paneExited || isTerminalPhase(this.phase)) return;
    const code = typeof e?.exitCode === "number" ? e.exitCode : null;
    const lastLine = typeof e?.lastLine === "string" ? e.lastLine : "";
    // The code is stored with the exit itself, not after the capture below: a tick that
    // settles the turn inside that window concludes with this code (H-27).
    this.paneExited = true;
    this.exitCode = code;
    this.exitLastLine = lastLine;
    this.endGatePause?.();
    // The final screen, with scrollback, so a long agent list cannot hide the refusal (L8).
    const slow = this.o.timings?.exitCaptureDelayMs;
    if (slow) await Bun.sleep(slow);
    if (this.client) {
      const cap = await this.client.request<MagmuxCapture>(
        { type: "capture", pane: 0, offset: 200 },
        1000
      );
      if (cap.ok) {
        this.exitCapture = cap.result.text ?? "";
        this.exitCaptureAlt = cap.result.alt === true;
        if (agentRejectedLine(this.exitCapture) && !agentRejectedLine(screenText(this.screen)))
          this.exitScrollback = this.exitCapture;
      }
    }
    this.step(() => this.applyExitPath(code));
  }

  /* ───────────────────────────── the step ───────────────────────────── */

  private wire(): SlotState {
    return wireState(this.phase, this.initialDelivery);
  }

  /** Run one event-processing step; report the NET wire change once. */
  private step(fn: () => void): void {
    if (this.depth === 0) this.stepFrom = this.wire();
    this.depth++;
    try {
      fn();
    } finally {
      this.depth--;
    }
    if (this.depth > 0) return;
    const from = this.stepFrom as SlotState;
    const to = this.wire();
    if (from !== to) {
      try {
        this.o.onTransition?.({ from, to, at: iso(Date.now()), snap: this.snapshot() });
      } catch {
        // an owner's callback must not break the session
      }
    }
    if (to !== "STARTING" && !this.readySettled) {
      this.readySettled = true;
      this.resolveReady();
    }
    this.scheduleChange();
  }

  private scheduleChange(): void {
    if (!this.o.onChange || this.changeTimer) return;
    const wait = Math.max(0, this.lastChangeAt + 250 - Date.now());
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      this.lastChangeAt = Date.now();
      const prev = this.lastChangeState;
      const snap = this.snapshot();
      this.lastChangeState = snap.state;
      try {
        this.o.onChange?.(snap, prev);
      } catch {
        // ignore
      }
    }, wait);
  }

  private fire(ev: PhaseEvent, info: { reason?: FailureReason; detail?: string } = {}): boolean {
    const next = nextPhase(this.phase, ev);
    if (!next) {
      this.anomaly(`illegal_transition:${this.phase}:${ev}`);
      return false;
    }
    this.phase = next;
    const reason = info.reason ?? EVENT_REASON[ev];
    // `detail` often carries the final screen rows: redacted HERE, once, so no owner can
    // persist or forward a credential the child printed (meta.json, output.log, frames)
    const detail = info.detail === undefined ? undefined : redactSecrets(info.detail);
    if (isTerminalPhase(next)) {
      this.reason = next === "COMPLETED" ? null : (reason ?? this.reason);
      if (detail !== undefined) this.detail = detail;
      this.onTerminal();
    } else if (detail !== undefined) this.detail = detail;
    return true;
  }

  private anomaly(key: string): void {
    const n = this.anomalies.get(key);
    if (n !== undefined) this.anomalies.set(key, n + 1);
    else if (this.anomalies.size < MAX_ANOMALY_KEYS) this.anomalies.set(key, 1);
  }

  /* ───────────────────────────── evaluation ───────────────────────────── */

  /**
   * Poll on a frame (debounced 250 ms) and on a 1 s backstop (FR4). The returned view
   * can be that old: a step about to type into the pane reads with `force`.
   */
  private pollFollower(force = false): TranscriptView {
    const now = Date.now();
    const since = now - this.lastPollAt;
    const debounce = this.t("pollDebounceMs", TICK_MS);
    if (
      force ||
      (this.framePending && since >= debounce) ||
      since >= this.t("pollBackstopMs", POLL_BACKSTOP_MS)
    ) {
      this.syncCopyWatch(false);
      this.follower.poll();
      this.lastPollAt = now;
      this.framePending = false;
      this.syncCopyWatch(true);
    }
    const view = this.follower.view();
    const off = view.current?.lastChatOffset ?? null;
    if (off !== this.lastChatOffset) {
      this.lastChatOffset = off;
      this.lastChatSeenAt = now;
    }
    this.noteWitnessCopies(view.current);
    return view;
  }

  /** A turn witnessed by k > 1 whole copies of its line (a doubled submit), counted once. */
  private noteWitnessCopies(t: TurnView | null): void {
    if (!t || t.index !== this.turnIndex || t.index === this.witnessCopiesTurn) return;
    const k = t.witnessCopies;
    if (k === null) return;
    this.witnessCopiesTurn = t.index;
    if (k > 1) this.anomaly(`witness_copies:${k}`);
  }

  private evaluate(): void {
    if (isTerminalPhase(this.phase)) return;
    if (transcriptSavingOff(this.screen)) this.follower.markSavingOff();
    const view = this.pollFollower();
    this.checkLiveness();
    const phase = this.phase;
    switch (phase) {
      case "BOOTING":
        this.evalBoot();
        break;
      case "ADMITTING":
        this.evalAdmission(view);
        break;
      case "RUNNING":
      case "QUESTION":
      case "PERMISSION":
        this.evalRunning(view);
        break;
      case "SETTLING":
        this.evalSettling(view);
        break;
      case "IDLE":
        this.evalIdle(view);
        break;
      case "COMPLETED":
      case "FAILED":
      case "CANCELLED":
      case "TIMEOUT":
      case "EMPTY":
      case "SHAPE_MISMATCH":
        break;
      default:
        assertNever(phase);
    }
    this.checkRegistry();
    this.pump();
  }

  /**
   * Telemetry only (pane-session.md, "The session registry"; architecture-v2 §6.4): compare
   * Claude Code's own session record with magmux's input gate (and, for working, the
   * screen), and the gate with the screen readers it is replacing; count each disagreement
   * once at its onset. No decision reads the registry; these counts decide, later, whether
   * the screen cross-checks can go.
   */
  private checkRegistry(): void {
    const now = Date.now();
    if (now - this.lastRegistryReadAt < REGISTRY_READ_MS) return;
    this.lastRegistryReadAt = now;
    const rec = this.registry.read();
    this.registryRec = rec;
    if (rec) this.registryEverSeen = true;
    if (
      !this.registryEverSeen &&
      this.bootReadyAtMs !== null &&
      now - this.bootReadyAtMs >= REGISTRY_MISSING_MS
    ) {
      this.disagree("registry_record_missing", true, now, 0);
    }
    const status = rec?.status ?? null;
    if (status !== null && !KNOWN_STATUSES.has(status))
      this.disagree(`registry_status_unknown:${status.slice(0, 32)}`, true, now, 0);
    if (!this.client) return; // a stale screen proves nothing
    const idle = status === "idle";
    this.disagree(
      "registry_idle_screen_working",
      this.phase === "RUNNING" && idle && isWorking(this.screen),
      now
    );
    // an unknown gate reading is not a disagreement, and does not end one either
    const g = this.gateNow();
    if (!g) return;
    // the `--agent` border signature, and the canary for magmux missing the box at a new width
    this.disagree(
      "registry_idle_gate_starting",
      this.phase === "BOOTING" && idle && (g.reason === "starting" || g.reason === "no_input_box"),
      now,
      REGISTRY_GATE_BOOT_DISAGREE_MS
    );
    this.disagree("registry_waiting_gate_no_dialog", status === "waiting" && g.ready, now);
    this.disagree(
      "gate_dialog_registry_not_waiting",
      g.dialog !== null && RUNTIME_DIALOG_KINDS.has(g.dialog) && (idle || status === "busy"),
      now
    );
    this.disagree("gate_ready_box_not_located", g.ready && locateBox(this.screen) === null, now);
    // canary for magmux's dialog markers drifting from claudish's closed list
    this.disagree(
      "gate_dialog_screen_unrecognised",
      (g.dialog === "permission" || g.dialog === "plan" || g.dialog === "question") &&
        choiceDialog(this.screen) === null,
      now
    );
  }

  private disagree(key: string, holds: boolean, now: number, forMs = REGISTRY_DISAGREE_MS): void {
    if (!holds) {
      this.disagreeSince.delete(key);
      this.disagreeCounted.delete(key);
      return;
    }
    const since = this.disagreeSince.get(key) ?? now;
    this.disagreeSince.set(key, since);
    if (now - since >= forMs && !this.disagreeCounted.has(key)) {
      this.disagreeCounted.add(key);
      this.anomaly(key);
    }
  }

  /**
   * While disconnected, the pane's liveness is `kill(panePid, 0)` every second (X-M12).
   *
   * ESRCH means magmux has already reaped the child, so magmux knows its exit code even though
   * our socket is gone. Before finishing, a bounded query asks it (`exitCodeFromMagmux`); the
   * code is then stored together with `paneExited`, as `onPaneExit` does (H-27). Unreachable or
   * silent, the exit goes on without a code, exactly as before.
   */
  private checkLiveness(): void {
    if (this.client || !this.panePidValue || this.paneExited || this.exitCodeQuery) return;
    const now = Date.now();
    if (now - this.lastLivenessAt < 1000) return;
    this.lastLivenessAt = now;
    try {
      process.kill(this.panePidValue, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") {
        this.exitCodeQuery = true;
        void this.exitCodeFromMagmux().then((code) => {
          this.exitCodeQuery = false;
          // a redial that attached meanwhile saw the dead pane and took the exit path with its code
          if (this.paneExited || isTerminalPhase(this.phase)) return;
          this.paneExited = true;
          this.exitCode = code;
          this.step(() => this.applyExitPath(code));
        });
      }
    }
  }

  /**
   * Pane 0's exit code from magmux over a fresh connection, or null when magmux cannot be
   * reached, does not answer, or does not report the pane dead with a numeric code within
   * EXIT_CODE_QUERY_MS. Its own dial loop, not the redial loop: that one backs off to a second
   * between attempts, and its attach does far more than this needs. Never throws.
   */
  private async exitCodeFromMagmux(): Promise<number | null> {
    const deadline = Date.now() + EXIT_CODE_QUERY_MS;
    const left = () => deadline - Date.now();
    const client = await this.dialWithin(left);
    if (!client) return null;
    try {
      // magmux marks the pane dead once it has reaped the child; ESRCH says it has, but the
      // mark may trail the reap by a moment, so ask again until the bound.
      while (left() > 0) {
        const r = await client.request<{ panes?: Array<Record<string, unknown>> }>(
          { type: "list" },
          Math.max(1, left())
        );
        if (!r.ok) return null;
        const p0 = r.result.panes?.find((p) => p.pane === 0);
        if (!p0) return null;
        if (p0.dead === true) return typeof p0.exitCode === "number" ? p0.exitCode : null;
        await Bun.sleep(Math.min(EXIT_CODE_RETRY_MS, Math.max(0, left())));
      }
      return null;
    } finally {
      client.close();
    }
  }

  /** A fresh magmux connection, redialled every EXIT_CODE_RETRY_MS while `left()` is positive. */
  private async dialWithin(left: () => number): Promise<MagmuxClient | null> {
    while (left() > 0 && !this.reaping && !isTerminalPhase(this.phase)) {
      try {
        // a connect that never completes must not outlive the bound either
        const dial = MagmuxClient.dial(this.sockPath);
        const client = await Promise.race([dial, Bun.sleep(Math.max(0, left())).then(() => null)]);
        if (!client) void dial.then((late) => late.close()).catch(() => {});
        return client;
      } catch {
        await Bun.sleep(Math.min(EXIT_CODE_RETRY_MS, Math.max(0, left())));
      }
    }
    return null;
  }

  private t(key: keyof NonNullable<PaneSessionOptions["timings"]>, dflt: number): number {
    return this.o.timings?.[key] ?? dflt;
  }

  /** The owner's admission bound, else the test seam, else `ADMIT_TIMEOUT_MS`. */
  private admitTimeoutMs(): number {
    return this.o.admitTimeoutMs ?? this.o.timings?.admitTimeoutMs ?? ADMIT_TIMEOUT_MS;
  }

  /**
   * An admission's bound. `admitTimeoutMs` bounds only the CREATED prompt's admission, as its
   * option says; the test-only `timings.admitTimeoutMs` bounds only a LATER one (an injected
   * turn, H-13 … H-15), for owners that do not pass `admitTimeoutMs`. A bound must leave room
   * for one gated send (`readyTimeoutFor`), else no attempt is made at all.
   */
  private admitBoundMs(initial: boolean): number {
    if (initial) return this.o.admitTimeoutMs ?? ADMIT_TIMEOUT_MS;
    return this.o.timings?.admitTimeoutMs ?? ADMIT_TIMEOUT_MS;
  }

  /**
   * Boot (architecture-v2 §6.2): ready is magmux's `input.ready`, which already requires the
   * box and a raw terminal both still for 1 s and Claude Code's boot stdin reset seen (or
   * 3.5 s since the terminal went raw). What blocks boot is the gate's dialog kind, named
   * from the screen's words only where the gate has no kind for it. Nothing is ever
   * accepted: no key is sent while booting.
   */
  private evalBoot(): void {
    const now = Date.now();
    const g = this.gateNow();
    if (g?.ready) {
      this.bootReady();
      return;
    }
    const staticFor = this.screen.seq === 0 ? 0 : now - this.screen.changedAt;
    const settled = staticFor >= this.t("bootStaticMs", BOOT_STATIC_MS);
    const block = g && settled ? this.bootBlock(g) : null;
    if (block) {
      this.fire(block.ev, { detail: block.detail });
      return;
    }
    const elapsedMs = now - this.startedAtMs;
    if (elapsedMs >= (this.o.bootTimeoutMs ?? BOOT_TIMEOUT_MS)) {
      const blocked =
        this.screen.seq > 0 &&
        settled &&
        (g?.reason?.startsWith("dialog:") === true ||
          nameBootScreen(this.screen).kind !== "booting");
      const gate = g
        ? `gate: ${g.reason ?? "ready"}${g.detail ? ` (${g.detail})` : ""}`
        : "gate: unknown";
      // A child that never drew a frame has no screen tail; say that instead of an empty line.
      const evidence =
        this.screen.seq === 0
          ? `Claude Code drew nothing in ${Math.round(elapsedMs / 1000)} s`
          : screenTailOf(this.screen);
      this.fire("boot_deadline", {
        reason: blocked ? "boot_blocked" : "boot_timeout",
        detail: `${evidence}\n${gate}`,
      });
    }
  }

  /**
   * A static boot screen the gate does not call ready: a boot dialog kind fails
   * `first_run_dialog` with the dialog's words; otherwise the screen names it — a named
   * first-run marker is `first_run_dialog` (magmux files a reworded boot dialog under
   * `select`); vim mode, `select` or another dialog kind is `boot_blocked`; a reason with no
   * kind (`starting`, `no_input_box`, …) blocks only on choice markers (`Press Enter to
   * continue`, the unnamed MCP-server prompt), which magmux has no kind for.
   * null: nothing names a blocking screen, so boot keeps waiting for its deadline.
   */
  private bootBlock(g: GateInput): { ev: "boot_dialog" | "boot_blocked"; detail: string } | null {
    if (g.dialog && BOOT_DIALOG_KINDS.has(g.dialog))
      return { ev: "boot_dialog", detail: dialogText(this.screen) };
    const named = nameBootScreen(this.screen);
    // the gate is not ready and the screen is static: a named first-run dialog is that dialog
    if (named.kind === "dialog") return { ev: "boot_dialog", detail: named.text };
    if (g.reason === "vim_mode")
      return { ev: "boot_blocked", detail: "vim editing mode is on (-- INSERT -- under the box)" };
    if (g.reason?.startsWith("dialog:"))
      return { ev: "boot_blocked", detail: screenText(this.screen) };
    if (named.kind === "choice" && g.reason !== null && GATE_KINDLESS_REASONS.has(g.reason))
      return { ev: "boot_blocked", detail: named.text };
    return null;
  }

  private bootReady(): void {
    this.bootReadyAtMs = Date.now();
    const head = this.q.items.find((i) => i.kind === "caller");
    if (!head || isControl(head.text)) {
      this.fire("boot_ready_idle");
      this.fireSessionStart();
      return;
    }
    const initial = this.initialPending;
    this.initialPending = false;
    this.initialDelivery = initial;
    this.q.items = this.q.items.filter((i) => i !== head);
    this.fire("boot_ready_admit");
    this.startAdmission(head, initial);
    this.fireSessionStart();
  }

  /** §7.3: right after the initial prompt's admission started (or boot found no prompt). */
  private fireSessionStart(): void {
    if (!this.hooks) return;
    this.startCallerSeq = this.q.callerAdmitted;
    try {
      this.hooks.fireStart();
    } catch {
      // a binding's failure must not break the session
    }
  }

  /** IDLE (or boot-ready) with a queued item: admit synchronously, then deliver. */
  private pump(): void {
    if (isTerminalPhase(this.phase) || this.admission || this.controlPending) return;
    if (this.q.items.length === 0) return;
    const d = nextQueueDecision(this.q, Date.now(), this.phase, this.canDeliver);
    if (this.phase === "IDLE") {
      // a hook item is typed only on current evidence; it stays queued until then
      if (d.deliver?.kind === "hook" && !this.idleForHookItem()) return;
      this.q.items = d.remaining;
      this.dropHookItems(d.drop);
      const item = d.deliver;
      if (!item) return;
      if (item.kind === "caller" && isControl(item.text)) {
        this.exitRequested = true;
        void this.submitControl(item.text.trim());
        return;
      }
      this.fire("admit");
      this.startAdmission(item, false);
      return;
    }
    // A queue holding only hook items never presses Esc (§7.2).
    if (
      (this.phase === "QUESTION" || this.phase === "PERMISSION") &&
      d.pressEscape &&
      this.escapeArmed &&
      !this.keysWithheld() &&
      this.escapeSentAt === null
    ) {
      // Esc declines the dialog AND interrupts the turn; it settles through path I (D17).
      this.escapeArmed = false;
      this.escapeSentAt = Date.now();
      void this.key("escape");
    }
  }

  /**
   * What the interactive driver's gate reads, read NOW. The transcript first: a
   * re-wake written since the last tick moves the session to RUNNING (`evalIdle`). Then
   * the screen: the box drawn and empty, no menu, no dialog, no working row.
   */
  private idleForHookItem(): boolean {
    this.evalIdle(this.pollFollower(true));
    return this.phase === "IDLE" && this.screenIdle();
  }

  /**
   * The box is drawn and empty with no menu, no dialog and no working row. The box is the
   * one located by the cursor (any terminal width), else the rule-drawn one; a dialog is the
   * input gate's (`dialog:<kind>`), else the screen's. The gated send that follows still
   * waits for the gate's own readiness.
   */
  private screenIdle(): boolean {
    if (!this.client) return false;
    if (this.gateNow()?.dialog) return false;
    const s = this.screen;
    const located = locateBox(s);
    const drawn = located ? null : inputBox(s);
    const top = located?.top ?? drawn?.top;
    if (top === undefined) return false;
    const text = located ? locatedBoxText(s, located) : (drawn?.text ?? "");
    if (text !== "" || menuAbove(s.lines, top).menuOpen) return false;
    return !hasChoiceDialog(s) && !isWorking(s);
  }

  /**
   * The merged hook text can be delivered: a plain line, or a file the child can Read.
   * Never a slash command: hook text goes as typed text or a file, not through
   * the command or control path a caller's `/model` or `/exit` takes.
   */
  private readonly canDeliver = (text: string): boolean =>
    !text.trimStart().startsWith("/") && deliveryRefusal(text, this.o.readAvailable) === null;

  /** No Read tool: the only delivery whose typed text is not the caller's own (`normalizedLine`). */
  private noteNormalized(plan: Delivery): void {
    if (plan.mode === "typed" && plan.normalized) this.anomaly("typed_normalized");
  }

  private startAdmission(item: QueueItem, initial: boolean): void {
    const text = item.text;
    // §7.2 L1: both counters change here, when the item leaves the queue
    Object.assign(this.q, afterAdmission(this.q, item));
    if (item.kind === "caller") {
      this.chain = [];
      this.chainHead = null;
      this.hookTurns = 0;
      this.turnHookCaused = false;
    } else {
      this.hookTurns++;
      this.turnHookCaused = true;
      this.hooks?.noteDelivered?.(item);
      this.anomaly("hook_injection_delivered");
    }
    // through the copy watch: a record of a copy remembered just now is read as that copy's
    this.pollFollower(true);
    const offset = this.follower.size(); // mark BEFORE deliver: the single turn boundary
    const index = ++this.turnIndex;
    const plan = planDelivery(text, this.turnDir, index, this.o.readAvailable);
    this.currentDelivery = plan;
    this.noteNormalized(plan);
    this.turnSource = "transcript";
    this.screenTurn = null;
    this.rewakeOfSettled = false;
    this.settledChatOffset = null;
    this.settledOnShadow = false;
    this.turnAcceptedAt = null;
    this.witnessMissingCounted = false;
    this.abandonedIndex = null;
    if (plan.mode === "refused" || plan.mode === "control") {
      this.anomaly(`delivery_refused:${plan.mode === "refused" ? plan.reason : "control"}`);
      this.admission = null;
      if (item.kind === "hook") {
        this.hookAdmissionFailed(item);
        return;
      }
      this.fire(initial ? "admit_deadline" : "admit_abandoned", {
        detail: plan.mode === "refused" ? plan.reason : undefined,
      });
      return;
    }
    try {
      writeTurnFile(plan);
    } catch (e) {
      this.anomaly(`turn_file_failed:${e instanceof Error ? e.message : String(e)}`);
    }
    const delivery =
      (plan.mode === "file" || plan.mode === "command") &&
      plan.file &&
      plan.fileContent !== undefined
        ? { file: plan.file, text: plan.fileContent }
        : null;
    this.follower.openTurn({ index, offset, witness: plan.witness, delivery });
    const adm = newAdmission({
      index,
      item,
      text,
      plan,
      initial,
      bound: this.admitBoundMs(initial),
      mark: offset,
    });
    this.admission = adm;
    void this.runAdmission(adm);
  }

  /** This admission is still the live one: nothing accepted, expired or ended it meanwhile. */
  private admitting(adm: Admission): boolean {
    return this.admission === adm && this.phase === "ADMITTING";
  }

  /**
   * The admission loop (architecture-v2 §5.3, R1.4): at most one gated send in flight, each
   * sized so that its client timeout ends by the admission deadline, and every reply handled
   * by the exhaustive switch of `onSendOutcome`. magmux's gate presses Enter only on a box
   * holding exactly the line; claudish reads the box only to WITHHOLD a retype while a copy
   * may sit unread (`awaitDraw`), never resends a SUBMIT whose reply was lost or that may have
   * been submitted, and never accepts on the screen. Claudish's own transcript witness accepts in `evalAdmission` whatever the loop is
   * doing ("the witness always wins"); the loop sees that at its next check and stops.
   *
   * The loop ends with no decision when Enter may have been pressed unproven
   * (`submittedUnproven`), when a stop row decided (`stopped`), or when no attempt fits
   * before the deadline; `evalAdmission` then expires the admission at its deadline.
   */
  private async runAdmission(adm: Admission): Promise<void> {
    this.inheritUnreadCopy(adm);
    try {
      while (this.admitting(adm) && adm.submittedUnproven === null && !adm.stopped) {
        if (Date.now() >= adm.deadline) return;
        if (adm.panel) {
          // a command opened a picker or panel: `panelStep` dismisses it, or hands it back
          await this.pause(adm, TICK_MS);
          continue;
        }
        if (this.needsConnectionStep(adm)) {
          await this.connectionStep(adm);
          continue;
        }
        // a stop row, an ended admission or a wait re-checks from the top of the loop
        if ((await this.beforeSend(adm)) !== "send") continue;
        if (!this.admitting(adm) || !(await this.attemptOnce(adm))) return;
      }
    } finally {
      adm.inFlight = false;
    }
  }

  /**
   * The loop waits for a trusted connection, or returns the view to the live bottom. No ctrl-End
   * goes while a copy may be unread (`keysWithheld`) or this admission's own copy is still being
   * drawn: it runs at a later step, once that wait has resolved.
   */
  private needsConnectionStep(adm: Admission): boolean {
    if (!this.trustedConnection()) return true;
    if (this.keysWithheld() || adm.awaitingDraw !== null) return false;
    return this.needsAdmissionLiveBottom(adm);
  }

  /**
   * A view the caller scrolled up goes back to the live bottom before the prompt: once per
   * admission per trusted connection. A failed or unconfirmed ctrl-End never blocks the
   * prompt (a submit snaps the view to the bottom, measured).
   */
  private needsAdmissionLiveBottom(adm: Admission): boolean {
    if (adm.liveBottomClient === this.client) return false;
    adm.liveBottomClient = this.client;
    return !isLiveBottom(this.scrollPos);
  }

  /** An open connection whose binding check passed: the only one claudish writes to. */
  private trustedConnection(): boolean {
    return !!this.client && !this.client.isClosed && this.gateTrusted;
  }

  /** Wait for a trusted connection, else return the view to the live bottom on it. */
  private connectionStep(adm: Admission): Promise<void> {
    if (!this.trustedConnection()) return this.awaitTrustedClient(adm);
    return this.returnToLiveBottom(Math.max(0, adm.deadline - Date.now()));
  }

  /** Nothing is written while disconnected: the redial's attach re-checks the binding first. */
  private awaitTrustedClient(adm: Admission): Promise<void> {
    return this.waitFor(
      () => !this.admitting(adm) || this.trustedConnection(),
      Math.max(0, adm.deadline - Date.now())
    );
  }

  /**
   * One gated send of the admission's current step, and its outcome handled. False when no
   * attempt fits before the deadline, or the admission ended while the send was out.
   */
  private async attemptOnce(adm: Admission): Promise<boolean> {
    const c = this.client;
    if (!c) return true; // the loop waits for the redial
    const step = adm.step;
    const shape = sendShape(step, adm.line);
    const rt = readyTimeoutFor(step, adm.line, adm.deadline - Date.now());
    if (rt === null) return false;
    const timeout = sendBudgetMs({ ...shape.budget, readyTimeoutMs: rt }) + SEND_CLIENT_SLACK_MS;
    // from its first send on, a record of its own line may be this turn's
    this.follower.holdTurn(false);
    const sentAt = Date.now();
    adm.inFlight = true;
    adm.attempts++;
    let reply: MagmuxReply;
    try {
      reply = await c.request({ ...shape.msg, readyTimeoutMs: rt }, timeout);
    } finally {
      adm.inFlight = false;
    }
    const out = classifySendReply(reply);
    adm.last = out;
    this.noteLastSend(out, adm.attempts);
    this.noteTyping(adm, step, out);
    // the witness accepted it, or the session ended, while the send was out
    if (!this.admitting(adm)) return false;
    await this.onSendOutcome(adm, out, step, { client: c, until: sentAt + timeout });
    return true;
  }

  /**
   * One gated reply → what the admission does next (architecture-v2 §5.2, R1.1-R1.5). The
   * switch is exhaustive over the closed `SendOutcome`; `input-gate.ts` only translates.
   */
  private async onSendOutcome(
    adm: Admission,
    out: SendOutcome,
    step: SubmitStep,
    sent: { client: MagmuxClient; until: number }
  ): Promise<void> {
    switch (out.kind) {
      case "accepted":
        this.onGateAccepted(adm, out);
        return;
      case "in_box":
        if (step !== "type") {
          // a send that carried an Enter answered as a TYPE: whether Enter was pressed is unknown
          this.anomaly("send_unexpected:in_box");
          this.stopAdmission(adm, "magmux answered in_box to a send that carried an Enter");
          return;
        }
        if (await this.menuCheck(adm)) adm.step = "enter";
        else await this.menuWait(adm);
        return;
      case "busy":
        await this.onBusy(adm, out, step);
        return;
      case "not_accepted":
        await this.onNotAccepted(adm, out, step);
        return;
      case "bad_request":
        // nothing was written: a claudish bug (planDelivery emits printable text only)
        this.anomaly("send_bad_request");
        this.stopAdmission(adm, `send_bad_request: ${out.error}`);
        return;
      case "reply_lost":
        this.anomaly("send_reply_lost");
        if (step === "type") {
          // a TYPE presses no Enter, but whether Claude Code read its text is unknown (the
          // reply's timeout bounds magmux, not Claude Code): as after a mismatch, nothing is
          // cleared or typed until the box has settled; a clear then still waits out the lost
          // delivery on a new connection (R1.5.3)
          adm.lostType = sent;
          startDrawWait(adm);
          return;
        }
        // magmux carries the delivery on, Enter included: never resent; the witness decides
        adm.submittedUnproven = "reply_lost";
        return;
      case "unsent":
        // never written: the next attempt waits for the redial
        await this.pause(adm, BUSY_RETRY_MS);
        return;
      case "pane_gone":
        // the exit path decides (`onPaneExit`); no further attempt
        adm.stopped = true;
        return;
      case "unexpected":
        this.anomaly(`send_unexpected:${out.code}`);
        this.stopAdmission(adm, `send_unexpected: ${out.code}${out.error ? `: ${out.error}` : ""}`);
        return;
      default:
        assertNever(out);
    }
  }

  /**
   * `ok`: history evidence (this pane's own screen) accepts at once; transcript evidence
   * only together with claudish's own witness (§5.6: until the named binding is trusted for
   * it, a transcript the gate read is not attributable on its own), else it is `unconfirmed`.
   */
  private onGateAccepted(adm: Admission, out: Extract<SendOutcome, { kind: "accepted" }>): void {
    if (out.accept === "resent_enter") this.anomaly("gate_resent_enter");
    if (out.accept === "submitted_by_other") this.anomaly("gate_submitted_by_other");
    if (out.dismissed.length > 0) this.anomaly("gate_dismissed_unexpected");
    if (out.evidence === "transcript") {
      this.anomaly("gate_transcript_evidence");
      if (!this.witnessNow()) {
        this.anomaly("gate_transcript_evidence_unwitnessed");
        adm.submittedUnproven = "unconfirmed";
        return;
      }
    }
    this.acceptAdmission(adm);
  }

  /** `busy`: Enter was NOT pressed. */
  private async onBusy(
    adm: Admission,
    out: Extract<SendOutcome, { kind: "busy" }>,
    step: SubmitStep
  ): Promise<void> {
    const reason = out.reason || "unknown";
    if (this.stopOnGateBlock(adm, reason, out.dialog)) return;
    if (out.dialog === "select" && step === "enter" && adm.plan.mode === "command") {
      // the command's own Enter met a picker or panel: dismiss it (§5.4 `panelStep`)
      this.noteOnce(adm, "gate_dialog_at_admission:select");
      adm.panel = { showingSince: null, escaped: false, entered: false };
      return;
    }
    if (out.dialog) {
      // a re-woken turn owns the dialog; evalIdle/evalRunning see it
      this.noteOnce(adm, `gate_dialog_at_admission:${out.dialog}`);
      // text typed before the dialog opened may sit unread behind it: nothing is cleared or
      // typed until the box, once located again, has settled (`awaitDraw`)
      if (out.typed) {
        this.noteStoppedTyping(adm, out);
        startDrawWait(adm);
      }
    } else if (out.typed) {
      // all or part of the text may be in Claude Code's input, read or not: as after a
      // mismatch, nothing is cleared or typed until the box has settled
      this.anomaly("gate_typed_withheld");
      this.noteStoppedTyping(adm, out);
      startDrawWait(adm);
    } else if (reason === "box_not_empty") {
      this.anomaly("gate_box_not_empty");
      markClearFirst(adm);
    } else {
      // starting, terminal_not_ready, no_input_box, typing_in_progress, queue_full, in_flight, …
      this.noteOnce(adm, `gate_busy:${reason}`);
    }
    await this.pause(adm, BUSY_RETRY_MS);
  }

  /**
   * The §5.2 stop rows a gate reason decides on its own, from a reply or from the published
   * view: a boot dialog kind (`first_run_dialog`) and vim mode. True when it stopped.
   */
  private stopOnGateBlock(adm: Admission, reason: string, dialog: GateDialogKind | null): boolean {
    if (dialog && BOOT_DIALOG_KINDS.has(dialog)) {
      // a question for the human: never a key, never accepted
      this.anomaly(`gate_boot_dialog:${dialog}`);
      this.stopAdmission(adm, dialogText(this.screen) || `busy ${reason}`, "first_run_dialog");
      return true;
    }
    if (reason === "vim_mode") {
      this.anomaly("gate_vim_mode");
      this.stopAdmission(adm, "busy vim_mode: vim editing mode is on (-- INSERT -- under the box)");
      return true;
    }
    return false;
  }

  /**
   * Revision 3 item 1: magmux answers `busy vim_mode` and `busy dialog:<kind>` only after the
   * send's WHOLE `readyTimeoutMs`, so before a send that types, the fresh published view is
   * read first, as R1.5.2 does for `box_not_empty`. Vim mode or a boot dialog stops the
   * admission with no send; a turn's own dialog (permission, question, plan) starts no send
   * until it leaves, within the deadline. A stale or missing reading decides nothing: the
   * send goes, and the gate decides.
   * `"send"`: go ahead; `"stopped"`: a stop row decided; `"waited"`: re-check from the top.
   */
  private async precheckGate(adm: Admission): Promise<"send" | "stopped" | "waited"> {
    const g = this.gateNow();
    if (!g || g.ready) return "send";
    if (this.stopOnGateBlock(adm, g.reason ?? "unknown", g.dialog)) return "stopped";
    const kind = g.dialog;
    if (kind !== "permission" && kind !== "question" && kind !== "plan") return "send";
    this.noteOnce(adm, `gate_dialog_at_admission:${kind}`);
    await this.waitFor(
      () => !this.admitting(adm) || this.gateNow()?.dialog !== kind,
      Math.max(0, adm.deadline - Date.now())
    );
    return "waited";
  }

  /**
   * The preconditions of a send: after a mismatch whose box stayed empty, the box showing
   * text (`awaitDraw`); then, for a send that types, leftover text cleared and the pre-check.
   * A command's Enter types nothing and has no other.
   */
  private async beforeSend(adm: Admission): Promise<"send" | "stopped" | "waited"> {
    if (adm.awaitingDraw !== null) {
      // the box stayed empty after a send: nothing is typed or cleared until it shows text
      await this.awaitDraw(adm);
      return "waited";
    }
    if (adm.step === "enter") return "send";
    // R1.5.2 / R1.5.3: clear leftover text BEFORE a send that types; a clear whose keys were
    // not sent types nothing behind it, and the loop clears again
    const cleared = await this.clearLeftover(adm);
    if (!this.admitting(adm)) return "stopped";
    if (!cleared) {
      await this.pause(adm, BUSY_RETRY_MS);
      return "waited";
    }
    return this.precheckGate(adm);
  }

  /** `not_accepted`: Enter withheld (`text_mismatch`, `empty_box`) or pressed (the other two). */
  private async onNotAccepted(
    adm: Admission,
    out: Extract<SendOutcome, { kind: "not_accepted" }>,
    step: SubmitStep
  ): Promise<void> {
    switch (out.reason) {
      case "text_mismatch":
        if (out.maybeSubmitted) {
          // R1.3: the text may already have been submitted by another writer: no ctrl-u and no
          // further send; only claudish's own witness can accept now
          this.anomaly("gate_maybe_submitted_by_other");
          adm.submittedUnproven = "maybe_submitted_by_other";
          return;
        }
        this.anomaly("gate_text_mismatch");
        if (mismatchBoxStayedEmpty(out)) this.noteOnce(adm, "gate_text_mismatch_box_empty");
        this.noteStoppedTyping(adm, out);
        // Empty or not, part of this copy may sit unread in Claude Code's input queue: magmux
        // types in short writes, and Claude Code can draw the first and stop reading. A ctrl-u
        // or a new copy would queue behind that tail and be read with it in one long read, so
        // the box's settled text decides (`awaitDraw`)
        startDrawWait(adm);
        return;
      case "empty_box":
        if (step === "enter") {
          // R1.1: the text left the box without claudish's Enter, so it may have been
          // submitted (a command run); typing it again is the D-B duplicate in another form
          this.anomaly(leftBoxAnomaly(adm.plan));
          adm.submittedUnproven = "maybe_submitted_by_other";
          return;
        }
        this.anomaly("gate_empty_box");
        await this.pause(adm, BUSY_RETRY_MS);
        return;
      case "still_in_box":
        // Enter was pressed and the line is still in the box: Claude Code may not have read
        // the Enter yet. Any byte sent now queues behind it and is read after it, so a ctrl-u
        // would clear nothing and a second copy would be submitted too: nothing is sent, and
        // only the line's own record accepts it
        if (this.witnessNow()) {
          this.acceptAdmission(adm);
          return;
        }
        this.anomaly("gate_still_in_box");
        adm.submittedUnproven = "still_in_box";
        return;
      case "unconfirmed":
        // Enter was pressed with no attributable evidence: never retyped
        this.anomaly("gate_unconfirmed");
        adm.submittedUnproven = "unconfirmed";
        if (step === "enter" && adm.plan.mode === "command")
          adm.panel = { showingSince: null, escaped: false, entered: true };
        return;
      default:
        assertNever(out.reason);
    }
  }

  /**
   * While a copy may sit unread in Claude Code's input queue (`awaitingDraw`): after any
   * `text_mismatch` reply that may not have been submitted, the box empty or not, and at the
   * start of an admission that follows one that expired so (`leftoverOf`, `unreadCopy`).
   * magmux types a line in short writes, and Claude Code can draw the first and then stop
   * reading stdin (measured under concurrent boot: a box drawn empty for about 20 s). Every
   * byte sent meanwhile queues unread behind the copy, and the backlog is then read in long
   * reads, inside which Claude Code 2.1.330 ignores ctrl-u (a read of about 64 bytes or more;
   * its early-input capture drops it too). A clear plus a new copy would land as copies
   * joined end to end, so nothing is typed or cleared until the box settles.
   *
   * magmux (≥ 0.20.2, the floor) types a send once and never retypes or clears, so the only
   * bytes that can be queued behind the box are that one copy. Text on the screen is still
   * not proof it was all read: its first part can be drawn while the rest is unread. So only
   * box text read from a frame of the trusted connection (`drawnBox`), unchanged for
   * `DRAW_SETTLE_MS`, decides; a gate reading of `box_not_empty` ahead of the frame only
   * means the frame is coming. Each time trust is established the trust epoch moves on, and a
   * wait that sees it move (even when the drop and the reattach both fell between two of its
   * polls) starts its settle again, on frames of the new connection only. The box is read
   * against the copy that may be unread: this admission's line, or the earlier one's. The
   * wait ends, within the deadline, on:
   * - the witness (`evalAdmission` accepts; the admission ends);
   * - settled text that is exactly this admission's line in the normal `❯` prompt
   *   (`matchBoxText`): the one copy was read, and only its Enter is sent;
   * - settled other text, any text in a `!` (bash mode) box, or an earlier copy settled:
   *   Claude Code is visibly reading, so the box is cleared and this line typed
   *   (`clearFirst`);
   * - an earlier copy that showed and then left the box, empty and settled: it was read and
   *   is gone, so this line is typed;
   * - a boot dialog or vim mode: the stop rows decide.
   * Text that ENDS with the start of the line (alone, or after other text) may be that copy
   * with its rest still unread: it is never acted on, however long it holds. At the deadline
   * the loop ends and the admission expires, its detail saying whether the box stayed empty,
   * showed the start of the line, or was still changing (`describeLastReply`).
   */
  private async awaitDraw(adm: Admission): Promise<void> {
    const r = await this.waitDrawn({
      against: adm.leftoverOf ?? adm.line,
      earlier: adm.leftoverOf !== null,
      live: () => this.admitting(adm),
      ms: Math.max(0, adm.deadline - Date.now()),
      // the earlier copy's record released it, or it was read whole: an empty box is not its tail
      emptyEnds: () =>
        adm.copyReleased ||
        (adm.leftoverOf !== null && (this.unreadCopyReadWhole || this.unreadCopyEnterPending)),
      shownEnds: () => adm.leftoverOf === null || !this.unreadCopyEnterPending,
      // magmux stopped partway: the part it wrote, settled in the box, is all there is to read
      partOnly: adm.leftoverOf === null ? adm.writtenPart : (adm.leftoverCopy?.part ?? null),
      onRead: (box) => {
        adm.drawState = drawStateOf(box);
        // its own whole line drawn: every byte of this copy was read
        if (adm.leftoverOf === null && box?.match === "line") this.noteReadWhole(adm);
      },
    });
    if (!this.admitting(adm)) return;
    const g = this.drawBlocked();
    if (g && this.stopOnGateBlock(adm, g.reason ?? "unknown", g.dialog)) return;
    if (r.ended === null || r.seen === undefined) return; // the deadline: the loop ends at its top
    await this.afterDraw(adm, r.ended === "gone" ? null : r.seen);
  }

  /** A boot dialog or vim mode: the stop rows decide, so a draw wait ends on it. */
  private drawBlocked(): GateInput | null {
    const g = this.gateNow();
    if (!g) return null;
    return (g.dialog && BOOT_DIALOG_KINDS.has(g.dialog)) || g.reason === "vim_mode" ? g : null;
  }

  /**
   * The settle wait of `awaitDraw`, shared with a control line (`awaitControlCopy`): box text
   * read against `against` from frames of the trusted connection, until it has been
   * unchanged for `DRAW_SETTLE_MS` (`drawOutcome`), `live` turns false, a stop row shows or
   * `ms` passes. `earlier`: `against` is an earlier copy, so its leaving the box may end the
   * wait as "gone". A move of the trust epoch, or a reading with no box located (a dialog
   * drawn over it, a redraw), is nothing trustworthy read: the settle starts again, and only
   * a move of the epoch also forgets that the whole line had shown.
   */
  private async waitDrawn(o: {
    against: string;
    earlier: boolean;
    live: () => boolean;
    ms: number;
    /** true: an empty box settled ends the wait as "gone" even though the whole line never showed */
    emptyEnds?: () => boolean;
    /**
     * The only text that was written (`writtenPart`): a normal box settled on exactly it ends the
     * wait as "settled", although it reads as the start of the line.
     */
    partOnly?: string | null;
    /** false: text settled in the box ends nothing (an Enter may be queued behind it) */
    shownEnds?: () => boolean;
    onRead?: (box: DrawnBox) => void;
  }): Promise<{ ended: "settled" | "gone" | null; seen: DrawnBox | undefined }> {
    let epoch = this.trustEpoch;
    // undefined: nothing trustworthy read since the settle last started
    let last: DrawnBox | undefined;
    let changedAt = Date.now();
    // the WHOLE earlier line was read from a trusted frame in this epoch: only then can an
    // empty box mean that copy is gone (`drawOutcome`)
    let wholeShown = false;
    let ended: "settled" | "gone" | null = null;
    const settle = (): boolean => {
      const at = Date.now();
      if (this.trustEpoch !== epoch) {
        epoch = this.trustEpoch;
        last = undefined;
        wholeShown = false;
      }
      const now = this.drawnBox(o.against);
      if (now === undefined || last === undefined || !sameDrawnBox(now, last)) {
        last = now;
        changedAt = at;
        if (now !== undefined) o.onRead?.(now);
        if (now?.match === "line") wholeShown = true;
      }
      ended = drawEnded(
        now,
        (wholeShown && o.earlier) || o.emptyEnds?.() === true,
        at - changedAt,
        o.partOnly ?? null
      );
      if (ended === "settled" && o.shownEnds?.() === false) ended = null;
      return ended !== null;
    };
    await this.waitFor(() => !o.live() || this.drawBlocked() !== null || settle(), o.ms);
    return { ended, seen: last };
  }

  /** What `awaitDraw` does with what settled: null, an earlier copy shown and gone. */
  private async afterDraw(adm: Admission, seen: DrawnBox): Promise<void> {
    adm.awaitingDraw = null;
    if (adm.leftoverOf !== null) {
      const copy = adm.leftoverOf;
      adm.leftoverOf = null;
      if (seen === null) {
        await this.afterCopyGone(adm, copy);
        return;
      }
      // the earlier copy is visibly read: cleared (`clearBox` forgets it), then this line typed
      this.anomaly("unread_copy_drawn");
      markClearFirst(adm);
      adm.step = typingStep(adm.plan);
      return;
    }
    if (seen?.match === "line") {
      this.anomaly("box_drawn_after_mismatch");
      this.noteReadWhole(adm);
      if (adm.plan.mode === "command" && !(await this.menuCheck(adm))) {
        await this.menuWait(adm);
        return;
      }
      adm.step = "enter";
      return;
    }
    // settled on exactly the part magmux wrote before it stopped: all of it read, none queued
    if (seen?.match === "prefix") {
      this.anomaly("box_drawn_written_part");
      this.noteReadWhole(adm);
      adm.writtenPart = null;
      markClearFirst(adm);
      adm.step = typingStep(adm.plan);
      return;
    }
    this.anomaly("box_drawn_other_after_mismatch");
    markClearFirst(adm);
    adm.step = typingStep(adm.plan);
  }

  /** The earlier copy `copy` showed whole and then left the box (`afterDraw`). */
  private async afterCopyGone(adm: Admission, copy: string): Promise<void> {
    this.anomaly("unread_copy_gone");
    // a copy that left the box may have been submitted: when it has this line's text, its
    // record (read fresh, not at the next poll, and with the copy still watched, so a held
    // turn may accept it) is this turn's witness, and nothing is typed
    if (this.witnessNow()) {
      this.forgetCopy();
      this.acceptAdmission(adm);
      return;
    }
    if (copy === adm.line && this.unreadCopy === copy) {
      adm.leftoverOf = copy;
      this.unreadCopyReadWhole = true;
      await this.awaitCopyRecord(adm);
      return;
    }
    if (this.unreadCopy === copy) this.departCopy();
    else this.forgetCopy();
  }

  /**
   * The remembered copy left the box, submitted, and is forgotten before its record landed: that
   * record, when it lands, must never be read as a later line's (`refuseDeparted`: a late
   * "PEARPEAR" is two joined copies of "PEAR").
   */
  private departCopy(): void {
    if (this.unreadCopyWitness)
      this.follower.refuseDeparted(this.unreadCopyWitness, this.unreadCopyAfter);
    this.forgetCopy();
  }

  /**
   * An earlier copy of this same line showed whole and left the box, which only claudish
   * writes: it was submitted, and its record can lag far behind (a UserPromptSubmit hook delays
   * it: 12,501 ms measured with `sleep 12`). Nothing is typed. The copy stays remembered and
   * watched and the turn held, until its record accepts this turn (one copy of the line,
   * `heldMayAccept`), or releases the copy without accepting it (joined copies: this line is
   * then typed by the normal rules), or the deadline expires the admission with nothing typed
   * and the copy still remembered, marked read whole (`unreadCopyReadWhole`): keys go again,
   * and the next wait on it ends on an empty settled box.
   */
  private async awaitCopyRecord(adm: Admission): Promise<void> {
    this.anomaly("unread_copy_gone_unrecorded");
    adm.recordWaitFrom = Date.now();
    await this.waitFor(
      () =>
        !this.admitting(adm) ||
        this.unreadCopy === null ||
        this.witnessed(this.pollFollower().current),
      Math.max(0, adm.deadline - Date.now())
    );
    if (!this.admitting(adm)) return;
    if (this.witnessed(this.follower.view().current)) {
      this.forgetCopy();
      this.acceptAdmission(adm);
      return;
    }
    // released by a record that was not this turn's: no copy is left to wait for
    if (this.unreadCopy === null) adm.leftoverOf = null;
  }

  /** A copy that may be unread (`unreadCopy`) makes a fresh admission wait before typing. */
  private inheritUnreadCopy(adm: Admission): void {
    if (this.unreadCopy === null || adm.attempts > 0 || adm.awaitingDraw !== null) return;
    adm.awaitingDraw = Date.now();
    adm.drawState = "none";
    adm.leftoverOf = this.unreadCopy;
    adm.leftoverCopy = {
      witness: this.unreadCopyWitness ?? { kind: "text", text: this.unreadCopy },
      after: this.unreadCopyAfter,
      part: this.unreadCopyPart,
    };
    // it has typed nothing: only one copy of its own line, when that is the copy's, accepts it
    this.follower.holdTurn(true);
    this.anomaly("unread_copy_wait");
  }

  /**
   * The input box as the latest frame of the trusted connection draws it: null when it is
   * located and empty, else its text and how it reads against `line`. undefined when no box
   * is located (a runtime dialog over it, a redraw), or while no frame of the trusted
   * connection has arrived: disconnected, the binding not yet checked, or a new connection
   * whose first frame is still to come. A frame received on a
   * connection before its binding check passed counts once it passes: it is that
   * connection's own picture of pane 0. Every frame counts, visible or not, so a keyframe
   * identical to the screen held across a disconnect still proves the box is current.
   */
  private drawnBox(line: string): DrawnBox | undefined {
    if (!this.trustedConnection() || this.lastFrameGen !== this.trustedGen) return undefined;
    const box = locateBox(this.screen);
    // a box not located (a dialog drawn over it, a redraw) is not an empty box: nothing is read
    if (!box) return undefined;
    const text = locatedBoxText(this.screen, box);
    if (text === "") return null;
    // only the normal prompt takes the line as a prompt: a `!` box is bash mode, and Enter
    // there would run the text as a shell command
    const normal = (this.screen.lines[box.top + 1] ?? "").startsWith("❯");
    return {
      text,
      match: normal ? matchBoxText(text, line) : "other",
      cursorGap: cursorGapAfterText(this.screen, box),
    };
  }

  /** Accept from the async loop, inside one event-processing step. */
  private acceptAdmission(adm: Admission): void {
    this.step(() => {
      if (this.admitting(adm)) this.accept();
    });
  }

  /**
   * A §5.2 stop row: no further attempt. The created prompt fails now with `detail` (its
   * first line is `reason_detail`); a later send returns the session to IDLE.
   */
  private stopAdmission(adm: Admission, detail: string, reason?: FailureReason): void {
    adm.stopped = true;
    this.step(() => {
      if (!this.admitting(adm)) return;
      this.rememberUnreadCopy(adm);
      this.admission = null;
      if (adm.initial) {
        this.fire("admit_deadline", { reason, detail: `${detail}\n${screenTailOf(this.screen)}` });
        return;
      }
      if (adm.item.kind === "hook") {
        this.hookAdmissionFailed(adm.item);
        return;
      }
      this.anomaly("send_not_accepted");
      this.abandonedIndex = adm.index;
      this.fire("admit_abandoned");
    });
  }

  /** The current turn's witness, after a fresh read of the transcript. */
  private witnessNow(): boolean {
    return this.witnessed(this.pollFollower(true).current);
  }

  private noteOnce(adm: Admission, key: string): void {
    if (adm.noted.has(key)) return;
    adm.noted.add(key);
    this.anomaly(key);
  }

  /** Wait `ms`, or less if the admission ends meanwhile. */
  private pause(adm: Admission, ms: number): Promise<void> {
    return this.waitFor(() => !this.admitting(adm), ms);
  }

  /** A gate reading received after `after` says the box is ready (and therefore empty). */
  private freshReady(after: number): boolean {
    const g = this.gateNow();
    return !!g && g.receivedAt > after && g.ready;
  }

  /**
   * One KEYS send of `clearKeyCount` ctrl-u keys (one ctrl-u deletes one wrapped row), then
   * wait at most `CLEAR_WAIT_MS` for a fresh `ready` reading. The keys are lane-ordered after
   * every byte typed before them, so they empty Claude Code's buffer whether its text is drawn
   * yet or not. False when the keys were not sent (no connection, or the send failed): then
   * nothing is forgotten, and `clearFirst` is set so the next attempt clears again.
   */
  private async clearBox(adm: Admission): Promise<boolean> {
    const at = Date.now();
    if (!(await this.sendClear(clearKeyCount(adm.line, adm.attempts, this.screen.cols)))) {
      markClearFirst(adm);
      return false;
    }
    adm.uncleared = false;
    await this.waitFor(() => !this.admitting(adm) || this.freshReady(at), CLEAR_WAIT_MS);
    return true;
  }

  /**
   * `own` ctrl-u keys, or more when an earlier copy that may be in the box (`unreadCopy`)
   * fills more rows: it is cleared with it. That copy is forgotten only once the keys were
   * sent; while they were not, the next clear is still sized for it.
   */
  private async sendClear(own: number): Promise<boolean> {
    const earlier =
      this.unreadCopy === null ? 0 : clearKeyCount(this.unreadCopy, 1, this.screen.cols);
    const n = Math.max(own, earlier);
    if (!(await this.keys(Array.from({ length: n }, () => "ctrl-u")))) {
      this.anomaly("clear_unsent");
      return false;
    }
    this.forgetCopy();
    return true;
  }

  /**
   * The precondition of every gated send that types (R1.5.2): a gated send into a non-empty
   * box types nothing and waits its whole `readyTimeoutMs`, so leftover text is cleared
   * first, from the published view. `box_not_empty` is the gate's LAST readiness rule, so it
   * already proves no dialog and a settled terminal: this ctrl-u cannot land on a dialog.
   * Text this admission may itself have left (`clearFirst`) is always cleared unless a
   * reading received after the reply that set the flag names a dialog or vim mode (then the
   * flag stays and the pre-check decides). A `ready` reading does not skip the clear: the
   * screen shows only what Claude Code has drawn, and under load it reads typed bytes into its
   * buffer seconds before drawing them, so a box drawn empty can still hold the text. With no
   * newer reading within `CLEAR_WAIT_MS`, the ctrl-u keys go anyway: ctrl-u on an empty box
   * does nothing, a send into a full one costs its whole `readyTimeoutMs`.
   *
   * R1.5.3: after a TYPE whose reply was lost, a ctrl-u on the SAME connection is
   * lane-ordered behind that delivery; one on a NEW connection is not and could land
   * mid-typing, so it waits until the lost TYPE's own client timeout has passed.
   */
  private async clearLeftover(adm: Admission): Promise<boolean> {
    const lost = adm.lostType;
    if (lost) {
      adm.lostType = null;
      if (lost.client !== this.client || lost.client.isClosed)
        await this.pause(adm, Math.max(0, lost.until - Date.now()));
      if (!this.admitting(adm)) return true;
    }
    if (adm.clearFirst) return this.clearOwnLeftover(adm);
    if (this.gateNow()?.reason === "box_not_empty") return this.clearBox(adm);
    return true;
  }

  /** `clearFirst`: cleared unless a reading newer than the reply names a dialog or vim mode. */
  private async clearOwnLeftover(adm: Admission): Promise<boolean> {
    // the published view trails the pane by up to one refresh: a reading received within
    // that interval of the reply may still show the box as it was before the text landed
    const after = adm.clearAfter + GATE_POLL_MS;
    const newer = (): GateInput | null => {
      const g = this.gateNow();
      return g && g.receivedAt > after ? g : null;
    };
    await this.waitFor(
      () => !this.admitting(adm) || newer() !== null,
      CLEAR_WAIT_MS + GATE_POLL_MS
    );
    if (!this.admitting(adm)) return true;
    const g = newer();
    // a dialog or vim mode: no key; the pre-check decides, and the flag waits for a clear box
    if (g && (g.dialog !== null || g.reason === "vim_mode")) return true;
    // the flag stays until the keys were sent, so a failed clear is tried again
    if (!(await this.clearBox(adm))) return false;
    adm.clearFirst = false;
    return true;
  }

  /**
   * After a command's TYPE (`in_box`): Enter on an open `/` menu runs the HIGHLIGHTED item,
   * not the typed one, and the gate has no menu handling, so a menu whose highlight is not
   * the typed name is closed with Escape first (§5.4). Read on the box located by the cursor;
   * a box not located is `menu_unverified`, and no Escape. False when that Escape was not sent
   * (withheld, `keysWithheld`, or its send failed): `menu_unverified`, and the caller sends no
   * Enter; the admission waits, and expires at its deadline with the menu still open.
   */
  private async menuCheck(adm: Admission): Promise<boolean> {
    const name = adm.line.match(/^\/\S+/)?.[0] ?? "";
    // our frames trail magmux's own verify by up to one frame interval
    await this.waitFor(() => {
      if (!this.admitting(adm)) return true;
      const box = locateBox(this.screen);
      return !!box && locatedBoxText(this.screen, box).startsWith(name);
    }, 2 * TICK_MS);
    if (!this.admitting(adm)) return false;
    const box = locateBox(this.screen);
    if (!box) {
      this.anomaly("menu_unverified");
      return true;
    }
    const menu = menuAbove(this.screen.lines, box.top);
    if (!menu.menuOpen || menu.menuItem === name) return true;
    // Enter would run the highlighted item: with the Escape not sent, nothing proves it closed
    if (await this.key("escape")) return true;
    this.anomaly("menu_unverified");
    return false;
  }

  /**
   * After `menuCheck` sent no Escape: nothing more is sent. Waits to the deadline, or until the
   * admission ends; the loop's deadline check then expires it.
   */
  private async menuWait(adm: Admission): Promise<void> {
    await this.waitFor(() => !this.admitting(adm), Math.max(0, adm.deadline - Date.now()));
  }

  /** The last gated send, as `get_diagnostics` reports it. */
  private noteLastSend(out: SendOutcome, attempts: number): PaneLastSend {
    const s: PaneLastSend = { kind: out.kind, attempts };
    switch (out.kind) {
      case "accepted":
        s.accept = out.accept;
        s.evidence = out.evidence;
        break;
      case "in_box":
        s.accept = "in_box";
        break;
      case "busy":
      case "not_accepted":
        s.reason = out.reason;
        break;
      case "bad_request":
        s.reason = "bad_request";
        break;
      case "reply_lost":
      case "unsent":
      case "pane_gone":
      case "unexpected":
        s.reason = out.code;
        break;
      default:
        assertNever(out);
    }
    this.lastSend = s;
    return s;
  }

  /**
   * `/exit` / `/quit` (§5.4 `control`): one gated SUBMIT. Its reply is only recorded; the
   * pane's exit decides. A copy that may still be unread (`unreadCopy`) is waited out first
   * (`awaitControlCopy`), so the line never lands behind it; nothing else is admitted
   * meanwhile. When the session ends first, nothing is typed: cancel and the session timeout
   * close the pane without a keystroke.
   */
  private async submitControl(line: string): Promise<void> {
    this.controlPending = true;
    try {
      if (!(await this.awaitControlCopy())) {
        this.anomaly("control_send:unread_copy");
        return;
      }
      const c = this.client;
      if (!c) {
        this.anomaly("control_send:unsent");
        return;
      }
      const mark = this.follower.size();
      const rt = SEND_READY_WAIT_DEFAULT_MS;
      const shape = sendShape("submit", line);
      // remembered (and so watched) before it is sent: a record of it polled while the request
      // is out is read as this copy's, which releases it
      this.rememberCopy(line, { kind: "command", name: line.slice(1), line }, mark);
      const gen = this.unreadCopyGen;
      const r = await c.request(
        { ...shape.msg, readyTimeoutMs: rt },
        sendBudgetMs({ ...shape.budget, readyTimeoutMs: rt }) + SEND_CLIENT_SLACK_MS
      );
      const out = classifySendReply(r);
      const s = this.noteLastSend(out, 1);
      const own = this.unreadCopy !== null && this.unreadCopyGen === gen;
      if (out.kind !== "accepted")
        this.anomaly(`control_send:${out.kind}${s.reason ? `:${s.reason}` : ""}`);
      // accepted, or nothing typed: no copy of it is left. Otherwise the pane may not exit on
      // it, and a later prompt waits for this copy too (unless its record released it already)
      if (own && (out.kind === "accepted" || !mayHaveTyped("submit", out))) this.forgetCopy();
    } finally {
      this.controlPending = false;
    }
  }

  /**
   * A stop row with no admission to stop (vim mode, a boot dialog): the control wait holds
   * until it closes or the session ends, and says so once (`control_wait_blocked:<row>`).
   * True once noted.
   */
  private async controlBlockedWait(live: () => boolean, noted: boolean): Promise<boolean> {
    const g = this.drawBlocked();
    if (g && !noted) this.anomaly(`control_wait_blocked:${g.dialog ?? g.reason ?? "unknown"}`);
    await this.waitFor(() => !live() || this.drawBlocked() === null, BUSY_RETRY_MS);
    return noted || g !== null;
  }

  /**
   * The wait an admission inherits from `unreadCopy` (`awaitDraw`), for a control line, which
   * has no admission and no deadline: until the copy settles in the box (cleared, then
   * forgotten), settles on exactly its written part (`unreadCopyPart`: cleared too), shows
   * whole and leaves (forgotten), shows an empty settled box after it was read whole
   * (`unreadCopyReadWhole`: forgotten), or its record releases it (`syncCopyWatch`). A stop row, a
   * clear whose keys were not sent, or a reconnect only starts the wait again. False when the
   * session ended first.
   */
  private async awaitControlCopy(): Promise<boolean> {
    const live = () => !isTerminalPhase(this.phase);
    if (this.unreadCopy !== null) this.anomaly("unread_copy_wait");
    let blockedNoted = false;
    while (this.unreadCopy !== null) {
      const gen = this.unreadCopyGen;
      // the copy forgotten or replaced meanwhile (its record released it) ends this wait
      const copyLive = () => live() && this.unreadCopy !== null && this.unreadCopyGen === gen;
      const r = await this.waitDrawn({
        against: this.unreadCopy,
        earlier: true,
        live: copyLive,
        ms: Number.POSITIVE_INFINITY,
        emptyEnds: () => this.unreadCopyReadWhole || this.unreadCopyEnterPending,
        shownEnds: () => !this.unreadCopyEnterPending,
        partOnly: this.unreadCopyPart,
      });
      if (!live()) return false;
      if (!copyLive()) continue;
      if (r.ended === "gone") {
        this.anomaly("unread_copy_gone");
        this.departCopy();
      } else if (r.ended === "settled") {
        this.anomaly("unread_copy_drawn");
        const at = Date.now();
        if (await this.sendClear(0))
          await this.waitFor(() => !live() || this.freshReady(at), CLEAR_WAIT_MS);
        else await this.waitFor(() => !live(), BUSY_RETRY_MS);
      } else blockedNoted = await this.controlBlockedWait(live, blockedNoted);
    }
    return live();
  }

  /**
   * One KEYS send of one key (Escape): no text and no final Enter, never gated. Withheld while
   * a copy may be unread (`keysWithheld`): false, and nothing is sent.
   */
  private key(k: string): Promise<boolean> {
    if (this.keysWithheld()) {
      this.anomaly(`key_withheld:${k}`);
      return Promise.resolve(false);
    }
    return this.keys([k]);
  }

  /**
   * A copy that may still be unread is remembered (`unreadCopy`): no key bytes other than the
   * clear of a settled copy (`sendClear`) go to the pane, since bytes queued behind an unread
   * tail are read with it in one long read. A caller scroll is refused, a ctrl-End waits, and
   * an Escape is not sent. A copy read whole (`unreadCopyReadWhole`) withholds nothing.
   */
  private keysWithheld(): boolean {
    return this.unreadCopy !== null && !this.unreadCopyReadWhole;
  }

  /** One KEYS send of `ks` in order (ctrl-u ×n): no text and no final Enter, never gated. */
  private async keys(ks: string[]): Promise<boolean> {
    const c = this.client;
    if (!c) return false;
    const r = await c.request(
      { type: "send", pane: 0, keys: ks, enter: false, noGate: true },
      10_000
    );
    return r.ok;
  }

  private nextFrame(ms: number): Promise<void> {
    const seq = this.screen.seq;
    const end = Date.now() + ms;
    return new Promise((resolve) => {
      const check = () => {
        if (this.screen.seq !== seq || Date.now() >= end) resolve();
        else setTimeout(check, 25);
      };
      check();
    });
  }

  /**
   * Synchronous, on every evaluation: the witness accepts whatever the loop is doing; a
   * command's panel is stepped; the deadline expires the admission once no gated send is
   * out (every attempt is sized to end by it).
   */
  private evalAdmission(view: TranscriptView): void {
    const adm = this.admission;
    if (!adm) return;
    if (this.witnessed(view.current)) {
      // an admission still waiting on an earlier copy of its own text typed nothing: the record
      // is that copy, submitted, so no copy is left to wait for
      if (adm.leftoverOf !== null && adm.leftoverOf === adm.line) this.forgetCopy();
      this.accept();
      return;
    }
    if (adm.panel) this.panelStep(adm);
    if (!this.admitting(adm)) return;
    if (Date.now() >= adm.deadline && !adm.inFlight) this.admitExpired(adm);
  }

  /** A full-screen panel or picker: the gate sees no box (or a `select` dialog), and `Esc to cancel`. */
  private panelShowing(g: GateInput | null): boolean {
    return (
      !!g &&
      (g.reason === "no_input_box" || g.dialog === "select") &&
      /Esc to cancel/.test(flatText(this.screen.lines))
    );
  }

  /**
   * A panel command (`/cost`, `/usage`, `/config`; `/model` with no argument) writes no
   * transcript record and swallows input until Esc (phase2-captures §3, §10), so it can never
   * be witnessed. Once it has been up for `PANEL_SETTLE_MS` it gets one Escape, and when the
   * gate is ready again the admission ends without a turn (§5.4). Never an Escape while the
   * gate names a boot dialog (`panelShowing` admits only `no_input_box` and `select`).
   */
  private panelStep(adm: Admission): void {
    const p = adm.panel;
    if (!p) return;
    const g = this.gateNow();
    if (!p.escaped) {
      if (!this.panelShowing(g)) {
        p.showingSince = null;
        return;
      }
      const now = Date.now();
      p.showingSince ??= now;
      if (now - p.showingSince < PANEL_SETTLE_MS) return;
      if (this.keysWithheld()) return;
      p.escaped = true;
      this.anomaly(g?.dialog === "select" ? "picker_dismissed" : "panel_dismissed");
      void this.key("escape");
      return;
    }
    if (!g) return;
    if (g.ready) {
      this.admission = null;
      this.anomaly("panel_command");
      if (adm.initial)
        this.fire("admit_deadline", {
          detail: `${adm.text.trim()} opened a panel and wrote no transcript record`,
        });
      else if (adm.item.kind === "hook") this.hookAdmissionFailed(adm.item);
      else this.fire("admit_abandoned");
      return;
    }
    // Esc closed a menu, not a panel, and the command (whose Enter was never pressed) is
    // still in the box: the loop presses its Enter through the gate again
    if (!p.entered && g.reason === "box_not_empty") adm.panel = null;
  }

  private accept(): void {
    this.admission = null;
    this.initialDelivery = false;
    // an evidenced submit snaps Claude Code's view to the live bottom (measured, MTL-369)
    this.scrollPos = LIVE_BOTTOM;
    const now = Date.now();
    this.lastChatSeenAt = now;
    this.turnAcceptedAt = now;
    this.turnErrorLogSize = this.errorLogSize();
    this.fire("prompt_accepted");
  }

  /**
   * magmux stopped typing partway (`stopped`, 0.20.3+, on a `text_mismatch` or a `busy` that
   * typed): only the first `writes` writes reached the pane, so nothing of this copy is queued
   * beyond that written part (`writtenPart`). The box is still waited on until it settles, and
   * a box settled on exactly that part is cleared and the line typed again (`waitDrawn`'s
   * `partOnly`), never waited on to the deadline as the start of a copy still being drawn. A
   * stop for a dialog keeps the part too: the wait holds while the dialog covers the box, and
   * the same rule applies once it is located again.
   */
  private noteStoppedTyping(adm: Admission, out: { stopped: TypingStop | null }): void {
    adm.writtenPart = null;
    if (!out.stopped) return;
    this.anomaly(`typing_stopped:${out.stopped.reason}`);
    adm.writtenPart = writtenPrefix(adm.line, out.stopped.writes);
  }

  /** What one reply says about this admission's copy (`mayHaveTyped`, `provesReadWhole`). */
  private noteTyping(adm: Admission, step: SubmitStep, out: SendOutcome): void {
    // only this reply can say its send stopped partway (`noteStoppedTyping`)
    adm.writtenPart = null;
    if (mayHaveTyped(step, out)) {
      adm.uncleared = true;
      adm.readWhole = false;
    }
    if (provesReadWhole(out)) this.noteReadWhole(adm);
  }

  /** The whole line was in the box: none of this copy can be unread. */
  private noteReadWhole(adm: Admission): void {
    adm.uncleared = false;
    adm.readWhole = true;
  }

  /**
   * An admission ending unwitnessed (its deadline, or a stop row) leaves behind the copy that
   * may still be unread: the earlier one it was waiting on, or its own, typed by a send whose
   * outcome is unknown and not cleared since, with the part of it written when magmux stopped
   * partway. The next admission then types nothing until that copy has shown
   * (`inheritUnreadCopy`).
   */
  private rememberUnreadCopy(adm: Admission): void {
    if (adm.leftoverOf !== null) {
      // still the earlier copy (its witness, offset and part kept), unless its record released it
      const c = adm.leftoverCopy;
      if (!adm.copyReleased && this.unreadCopy !== adm.leftoverOf && c)
        this.rememberCopy(adm.leftoverOf, c.witness, c.after, c.part);
      return;
    }
    if (adm.submittedUnproven === "still_in_box") {
      // its line was read, its Enter maybe not: queued behind the line, so no key may follow
      this.rememberCopy(
        adm.line,
        "witness" in adm.plan ? adm.plan.witness : { kind: "text", text: adm.line },
        adm.mark
      );
      this.unreadCopyEnterPending = true;
      return;
    }
    if (adm.readWhole && adm.submittedUnproven !== null) {
      // read whole and maybe submitted (its Enter reply lost or unconfirmed): its record may
      // still land, so a retry of the same text waits for it (`awaitCopyRecord`) and another
      // line refuses it (`departCopy`); nothing of it is queued, so no key is withheld
      this.rememberCopy(
        adm.line,
        "witness" in adm.plan ? adm.plan.witness : { kind: "text", text: adm.line },
        adm.mark
      );
      this.unreadCopyReadWhole = true;
      return;
    }
    if (adm.readWhole || (adm.awaitingDraw === null && !adm.uncleared)) return;
    this.rememberCopy(
      adm.line,
      "witness" in adm.plan ? adm.plan.witness : { kind: "text", text: adm.line },
      adm.mark,
      adm.writtenPart
    );
  }

  /**
   * Remember a copy that may be unread: its line, its witness, the offset it was typed after,
   * and the part written when magmux stopped typing it partway. The follower watches for its
   * record from here on (`syncCopyWatch`), before any later poll can read that record.
   */
  private rememberCopy(
    line: string,
    witness: Witness,
    after: number,
    part: string | null = null
  ): void {
    this.unreadCopy = line;
    this.unreadCopyWitness = witness;
    this.unreadCopyAfter = after;
    this.unreadCopyPart = part;
    this.unreadCopyReadWhole = false;
    this.unreadCopyEnterPending = false;
    this.unreadCopyGen++;
    this.syncCopyWatch(false);
  }

  /** Forget the remembered copy, and stop watching for its record. */
  private forgetCopy(): void {
    this.unreadCopy = null;
    this.unreadCopyWitness = null;
    this.unreadCopyPart = null;
    this.unreadCopyReadWhole = false;
    this.unreadCopyEnterPending = false;
    this.syncCopyWatch(false);
  }

  /**
   * Keep the follower watching the remembered copy (`watchCopy`), and release the copy once a
   * record of it has landed: it was submitted, so nothing of it is queued, whether the session
   * is idle or another admission is waiting on it. That admission is not accepted by the record
   * (the follower holds its turn, `holdTurn`, unless the record is exactly one copy of its own
   * line); it goes on by the normal rules, now with no copy remembered: an empty settled box
   * ends its wait (`copyReleased`).
   */
  private syncCopyWatch(afterPoll: boolean): void {
    if (this.unreadCopy === null) this.unreadCopyWitness = null;
    const key = this.unreadCopy === null ? null : `${this.unreadCopyGen}`;
    if (key !== this.watchedCopyKey) {
      this.watchedCopyKey = key;
      const w =
        this.unreadCopyWitness ??
        (this.unreadCopy === null ? null : { kind: "text" as const, text: this.unreadCopy });
      this.follower.watchCopy(this.unreadCopy === null ? null : w, this.unreadCopyAfter);
    }
    if (!afterPoll || this.unreadCopy === null || !this.follower.copySeen()) return;
    this.anomaly("unread_copy_recorded");
    const adm = this.admission;
    if (adm && adm.leftoverOf !== null) adm.copyReleased = true;
    this.forgetCopy();
  }

  private admitExpired(adm: Admission): void {
    this.rememberUnreadCopy(adm);
    this.admission = null;
    if (adm.initial) {
      this.fire("admit_deadline", {
        detail: `${this.notAcceptedLine(adm)}\n${screenTailOf(this.screen)}`,
      });
      return;
    }
    if (adm.item.kind === "hook") {
      this.hookAdmissionFailed(adm.item);
      return;
    }
    this.anomaly("send_not_accepted");
    // a witness that still arrives re-wakes the session as this turn (evalIdle)
    this.abandonedIndex = adm.index;
    this.fire("admit_abandoned");
  }

  /**
   * §7.3 step 7: an injected turn never accepted (refused, no witness in time, a panel,
   * a stop row, or the pane exited first). A one-shot chain ends with a verdict on what it
   * has; an interactive session waits for input as after any turn.
   */
  private hookAdmissionFailed(item: HookQueueItem): void {
    this.admission = null;
    this.anomaly("hook_injection_dropped:send_not_accepted");
    this.hooks?.noteDropped?.(item, "send_not_accepted");
    // The turn the injection followed is still held only on a one-shot chain, or on one a
    // send_input converted to interactive during this admission: it is concluded
    // now, on the current shape, so decide() runs for it either way.
    if (this.heldTurn) {
      this.fire("hook_admit_abandoned");
      this.conclude(null);
      return;
    }
    this.fire("admit_abandoned");
  }

  /**
   * The first line of `prompt_not_accepted`'s detail, i.e. `reason_detail`: the input
   * gate's own answer (the magus session reads it).
   */
  private notAcceptedLine(adm: Admission): string {
    const secs = Math.round((Date.now() - adm.startedAt) / 1000);
    switch (adm.submittedUnproven) {
      case "maybe_submitted_by_other":
        return "magmux could not tell whether the prompt was submitted (the box emptied without its Enter) and no transcript record of it appeared";
      case "unconfirmed":
        return `magmux not_accepted unconfirmed: Enter was pressed with no evidence it was submitted, and no transcript record appeared in ${secs} s`;
      case "reply_lost": {
        const code = adm.last?.kind === "reply_lost" ? adm.last.code : "client_lost";
        return `the magmux send reply was lost (${code}) and no transcript record of the prompt appeared in ${secs} s`;
      }
      case "still_in_box":
        return `magmux not_accepted still_in_box: Enter was pressed and Claude Code had not read it (the prompt stayed in the input box), and no transcript record of it appeared in ${secs} s`;
      case null:
        return `prompt not accepted in ${secs} s; ${describeLastReply(adm, this.gateNow())}`;
      default:
        return assertNever(adm.submittedUnproven);
    }
  }

  /**
   * Settle corroboration (architecture-v2 §7.1, R1.5.1): the gate's fresh reading, plus the
   * working row and the quiet ABOVE the box located by the cursor. Null while disconnected.
   * An unlocated box yields nulls, never a veto.
   */
  private corroborationFacts(): CorroborationFacts | null {
    if (!this.client) return null;
    const g = this.gateNow();
    return {
      gate: g ? { ready: g.ready, dialog: g.dialog, reason: g.reason } : null,
      working: workingAboveBox(this.screen),
      aboveBoxQuietMs: this.aboveBoxQuietMs(),
    };
  }

  /** ms since a row above the located box changed; null when this frame locates no box. */
  private aboveBoxQuietMs(): number | null {
    return locateBox(this.screen) ? Date.now() - this.screen.aboveBoxChangedAt : null;
  }

  /**
   * A turn the gate accepted that the transcript has not witnessed: with the transcript off,
   * or still absent or empty `DEGRADED_ENTRY_MS` after the acceptance, it settles from the
   * screen (§5.7, degraded mode now begins only AFTER an evidenced acceptance); with the
   * transcript `ok` and no witness `ADMIT_TIMEOUT_MS` after it, `witness_missing` is counted
   * once (§5.8) and the turn stays RUNNING: no timer ends it (D10).
   */
  private checkUnwitnessed(view: TranscriptView): void {
    const at = this.turnAcceptedAt;
    if (at === null || this.rewakeOfSettled || this.witnessed(view.current)) return;
    const since = Date.now() - at;
    const missing = view.availability === "absent" || view.availability === "empty";
    if (
      view.availability === "off" ||
      (missing && since >= this.t("degradedEntryMs", DEGRADED_ENTRY_MS))
    ) {
      const d = this.currentDelivery;
      this.turnSource = "screen";
      this.anomaly("degraded_mode");
      // the screen turn reads the live bottom; a scrolled view would hide it
      void this.returnToLiveBottom(SCROLL_REPLY_MS);
      this.screenTurn = {
        echo: d && d.mode !== "refused" ? d.line : "",
        acceptedAt: at,
        errorLogSize: this.turnErrorLogSize,
      };
      return;
    }
    if (view.availability === "ok" && since >= ADMIT_TIMEOUT_MS && !this.witnessMissingCounted) {
      this.witnessMissingCounted = true;
      this.anomaly("witness_missing");
    }
  }

  private evalRunning(view: TranscriptView): void {
    if (this.turnSource === "transcript") this.checkUnwitnessed(view);
    if (this.turnSource === "screen") {
      this.evalScreenTurn(view);
      return;
    }
    const t = view.current;
    if (!t) return;
    if (this.phase === "QUESTION" || this.phase === "PERMISSION") {
      if (t.pendingTool && t.pendingTool.id === this.blockedToolId) {
        this.checkEscape();
        return;
      }
      this.blockedToolId = null;
      this.escapeSentAt = null;
      this.fire("unblocked");
    }
    if (this.detectBlocked(t)) return;
    const now = Date.now();
    const transcriptQuietMs = now - (view.lastAppendAt ?? this.startedAtMs);
    const decision = decideSettle({
      turn: t,
      session: view.session,
      transcriptQuietMs,
      chatQuietMs: now - this.lastChatSeenAt,
      facts: this.corroborationFacts(),
      paneExited: false,
      secondaryQuietMs: this.secondaryQuietMs,
      corroborationMs: this.corroborationMs,
      corroborationGraceMs: this.t("gateGraceMs", GATE_GRACE_MS),
    });
    if (decision.settled) {
      this.settle(t, decision, null);
      return;
    }
    this.activity = decision.activity;
    this.checkTurnEndMissing(t, transcriptQuietMs);
    this.checkAgentCountMismatch(t);
  }

  private checkEscape(): void {
    if (this.escapeSentAt === null) return;
    if (Date.now() - this.escapeSentAt < this.admitTimeoutMs()) return;
    this.anomaly("escape_not_effective");
    this.escapeSentAt = null;
  }

  /**
   * R3-M4: `finishing` with a static screen and no Stop-hook UI for N secondary windows.
   * The condition is live (it clears the moment work resumes); the anomaly counts how often
   * it began. A turn whose end record WAS written (turn_duration, or an interrupt) is not
   * missing one: "the turn ended and the gate disagrees" is `settle_gate_unconfirmed`.
   * Quiet is measured above the located box, else from the transcript (architecture-v2 §7.2).
   */
  private checkTurnEndMissing(t: TurnView, transcriptQuietMs: number): void {
    if (this.activity !== "finishing" || t.turnDurationAfterLast || t.interruptAfterLast) {
      this.turnEndMissing = false;
      return;
    }
    if (!this.client) return;
    const quiet = this.aboveBoxQuietMs() ?? transcriptQuietMs;
    const missing =
      quiet >= TURN_END_MISSING_FACTOR * this.secondaryQuietMs && !stopHookRunning(this.screen);
    if (missing && !this.turnEndMissing) this.anomaly("turn_end_record_missing");
    this.turnEndMissing = missing;
  }

  /**
   * claudish's pending background agents disagree with Claude Code's count at the turn's
   * end record. Live like turn_end_record_missing; the anomaly counts each onset of a pair.
   * It never settles or ends the turn: Claude Code's count is a witness (D23).
   */
  private checkAgentCountMismatch(t: TurnView): void {
    const m = agentCountMismatch(t);
    const key = m ? `${m.counted}/${m.reported}` : null;
    if (m && key !== this.agentMismatch)
      this.anomaly(
        `agent_count_mismatch: claudish ${m.counted} pending, Claude Code ${m.reported}`
      );
    this.agentMismatch = key;
  }

  /**
   * Blocked detection (architecture-v2 §6.3): a pending AskUserQuestion from the transcript
   * alone; any other pending tool blocks only when magmux's input gate names the dialog
   * (`dialog:permission`/`dialog:plan`, or `dialog:question`). Anything else, an unknown
   * gate included, stays RUNNING: an honest unknown, never `blocked`.
   */
  private detectBlocked(t: TurnView): boolean {
    const pending = t.pendingTool;
    if (!pending || this.phase !== "RUNNING") return false;
    let kind: PaneBlock["kind"] | null = null;
    if (pending.name === "AskUserQuestion") kind = "question";
    else {
      const dialog = this.gateNow()?.dialog ?? null;
      if (dialog === "permission" || dialog === "plan") kind = "permission";
      else if (dialog === "question") kind = "question";
    }
    if (!kind) return false;
    this.blockedToolId = pending.id;
    this.fire(kind === "question" ? "blocked_question" : "blocked_permission");
    this.activity = pending.name;
    // the screen supplies only the words; with no frame yet there are none to give
    const text = blockText(pending, this.screen.seq > 0 ? dialogText(this.screen) || null : null);
    try {
      this.hooks?.fireBlocked({ kind, text });
    } catch {
      // a binding's failure must not break the session
    }
    let v: FinalVerdict | "wait";
    try {
      v = this.o.onBlocked({ kind, tool: pending.name, text });
    } catch {
      v = "wait";
    }
    if (v !== "wait") this.applyVerdict(v);
    return true;
  }

  private evalIdle(view: TranscriptView): void {
    const t = view.current;
    // A later send abandoned unwitnessed (§5.3, R1.3) whose witness arrives now: magmux's
    // delivery DID land. It is this same turn, reported late, never lost.
    if (
      t &&
      this.abandonedIndex !== null &&
      t.index === this.abandonedIndex &&
      t.acceptedAt !== null &&
      !this.exitRequested
    ) {
      this.abandonedIndex = null;
      this.anomaly("late_witness");
      this.forgetCopy();
      this.turnAcceptedAt = Date.now();
      this.turnErrorLogSize = this.errorLogSize();
      this.lastChatSeenAt = Date.now();
      this.fire("rewake");
      this.activity = "thinking";
      return;
    }
    // After a delivered /exit only the pane's exit can follow, never a re-wake: Claude
    // Code 2.1.282–2.1.285 write the command's own records into the settled turn.
    if (!t || this.settledChatOffset === null || this.exitRequested) return;
    // A background notification woke the model with no prompt of ours (D23): same turn.
    const off = this.chatOffsetSinceSettle(t);
    if (off !== null && off > this.settledChatOffset) {
      this.rewakeOfSettled = true;
      this.fire("rewake");
      this.activity = "thinking";
    }
  }

  /* ───────────────────────────── settle ───────────────────────────── */

  /** `note` receives the anomalies the turn carries; a caller that may still not settle defers them. */
  private settledTurnOf(
    t: TurnView,
    decision: SettleDecision & { settled: true },
    note: (key: string) => void = (key) => this.anomaly(key)
  ): TurnCore {
    // R3-M3: a file-carrying COMMAND turn with zero Reads is unverified coverage (settled-turn.ts).
    const { core, unverified } = settledTurnCoreOf(t, decision, {
      delivery: this.currentDelivery,
      shape: this.shape,
    });
    if (unverified) note("read_coverage_unverified");
    return core;
  }

  private settle(
    t: TurnView,
    decision: SettleDecision & { settled: true },
    exitCode: number | null
  ): void {
    for (const a of decision.anomalies) this.anomaly(a);
    for (const cmd of t.backgroundShellsOpen) this.anomaly(`background_shell_open: ${cmd}`);
    this.finishTurn(this.settledTurnOf(t, decision), t.lastChatOffset, exitCode);
  }

  private finishTurn(
    core: TurnCore,
    chatOffset: number | null,
    exitCode: number | null,
    onShadow = false
  ): void {
    this.settledOnShadow = onShadow;
    if (this.hooks) {
      this.recordTurn(core, chatOffset, exitCode);
      return;
    }
    const turn: SettledTurn = {
      ...core,
      chainAnswers: [],
      chainDelivery: core.delivery,
      hookTurns: 0,
      hookCaused: false,
    };
    this.turnEndMissing = false;
    this.agentMismatch = null;
    this.answers.set(turn.index, turn.answer);
    // owners ask for the current or the last settled turn: keep a few, not the session's all
    for (const k of this.answers.keys()) if (k <= turn.index - KEPT_ANSWERS) this.answers.delete(k);
    this.lastCaptureSource = turn.captureSource;
    this.activity = null;
    let verdict: FinalVerdict | "continue";
    try {
      verdict = this.o.decide(turn);
    } catch (e) {
      verdict = { state: "FAILED", reason: "child_exited", detail: `decide() threw: ${String(e)}` };
    }
    if (!this.rewakeOfSettled) {
      this.turnsCompleted++;
      this.follower.markSettled();
    }
    if (verdict === "continue") {
      if (turn.delivery.complete === false) this.anomaly("prompt_not_read");
      this.settledChatOffset = chatOffset ?? -1;
      this.fire("turn_continue");
      return;
    }
    if (exitCode !== null || this.paneExited) {
      const note = exitNoteOf(exitCode ?? this.exitCode);
      verdict = { ...verdict, detail: verdict.detail ? `${verdict.detail} · ${note}` : note };
    }
    this.applyVerdict(verdict);
  }

  private applyVerdict(v: FinalVerdict): void {
    this.fire(VERDICT_EVENT[v.state], { reason: v.reason, detail: v.detail });
  }

  /* ───────────────────────────── record, hold, conclude (§7.3) ───────────────────────────── */

  /**
   * Step 1, synchronously in the settling step: store the answer, extend the chain,
   * PUBLISH it through `onTurnRecorded` before any transition, then hold (step 3) or
   * conclude at once (step 2).
   */
  private recordTurn(core: TurnCore, chatOffset: number | null, exitCode: number | null): void {
    this.turnEndMissing = false;
    this.answers.set(core.index, core.answer);
    for (const k of this.answers.keys()) if (k <= core.index - KEPT_ANSWERS) this.answers.delete(k);
    this.lastCaptureSource = core.captureSource;
    this.activity = null;
    if (!this.rewakeOfSettled) {
      this.turnsCompleted++;
      this.follower.markSettled();
    }
    const last = this.chain[this.chain.length - 1];
    const writtenFiles = core.writtenFiles ?? [];
    if (last && last.index === core.index) {
      last.answer = core.answer;
      last.writtenFiles = writtenFiles;
    } else this.chain.push({ index: core.index, answer: core.answer, writtenFiles });
    if (!this.turnHookCaused) this.chainHead = core.delivery;
    const turn: SettledTurn = {
      ...core,
      chainAnswers: this.chain.slice(0, -1).map((c) => c.answer),
      chainDelivery: this.chainHead ?? core.delivery,
      hookTurns: this.hookTurns,
      hookCaused: this.turnHookCaused,
      writtenFiles: [...new Set(this.chain.flatMap((c) => c.writtenFiles))],
    };
    this.heldTurn = turn;
    try {
      this.o.onTurnRecorded?.(turn);
    } catch {
      // an owner's callback must not break the session
    }
    this.settledChatOffset = chatOffset ?? -1;
    if (turn.hookCaused && turn.delivery.complete === false)
      this.anomaly("hook_injection_not_read");
    // Step 2: no hold when nothing can come of it, and never into a dead pane.
    const exited = exitCode !== null || this.paneExited;
    let work = false;
    if (!exited) {
      try {
        work = this.hooks?.hasIdleWork(hookCount(this.q) > 0) ?? false;
      } catch {
        work = false;
      }
    }
    if (!work) {
      this.conclude(exited ? exitNoteOf(exitCode ?? this.exitCode) : null);
      return;
    }
    this.startHold(turn);
  }

  /** Step 3: SETTLING, `settle()` in flight, a watchdog at `holdBoundMs()`. */
  private startHold(turn: SettledTurn): void {
    const binding = this.hooks as SessionHookBinding;
    this.holdGen++;
    const gen = this.holdGen;
    this.fire("settle_hold");
    this.activity = "hook";
    const ctl = new AbortController();
    this.holdController = ctl;
    let bound: number;
    try {
      bound = binding.holdBoundMs();
    } catch {
      bound = 0;
    }
    let p: Promise<{ injections: HoldInjection[]; error?: string; anomalies?: string[] }>;
    try {
      p = Promise.resolve(
        binding.settle(
          {
            index: turn.index,
            answer: turn.answer,
            stopReason: turn.stopReason,
            apiError: turn.apiError !== null,
            hookCaused: turn.hookCaused,
            consecutiveHookTurns: this.q.consecutiveHookTurns,
            callerInputPending: callerCount(this.q) > 0,
            shape: this.shape,
          },
          ctl.signal
        )
      );
    } catch (e) {
      p = Promise.reject(e);
    }
    p.catch((err: unknown) => ({ injections: [], error: String(err), rejected: true }))
      .then((r) => this.step(() => this.completeHold(gen, r)))
      .catch(() => {});
    this.holdWatchdog = setTimeout(
      () => this.step(() => this.completeHold(gen, { injections: [], error: "watchdog" })),
      Math.max(0, bound)
    );
  }

  /**
   * End the hold this step leaves `SETTLING` by: no result of it is applied afterwards. A
   * settle still running learns `reason` through its signal; a result already returned
   * and waiting for the screen goes back to the binding under the same reason.
   */
  private endHold(reason: HoldAbortReason): void {
    this.holdGen++;
    if (this.holdWatchdog) clearTimeout(this.holdWatchdog);
    this.holdWatchdog = null;
    const ctl = this.holdController;
    this.holdController = null;
    if (ctl && !ctl.signal.aborted) ctl.abort(reason);
    const held = this.heldResult;
    this.heldResult = null;
    if (held) {
      try {
        this.hooks?.abandon?.(held.result, reason);
      } catch {
        // journaling never breaks the session
      }
    }
  }

  /** Step 4: the hold's result (or the watchdog's) arrives, in its own step. */
  private completeHold(gen: number, r: HoldResult & { rejected?: boolean }): void {
    if (gen !== this.holdGen || this.phase !== "SETTLING") return;
    for (const a of r.anomalies ?? []) this.anomaly(a);
    // The pane child exited while the hold ran: onPaneExit's step concludes with the real
    // exit code within its capture window. Nothing is queued or typed into a dead pane.
    if (this.paneExited) {
      for (const i of r.injections) this.dropInjection(i, "pane_exited");
      this.holdGen++;
      if (this.holdWatchdog) clearTimeout(this.holdWatchdog);
      this.holdWatchdog = null;
      return;
    }
    const failed = r.error !== undefined;
    if (!failed) this.heldResult = { result: r, since: Date.now() };
    // the last tick's poll can be up to a second old. A re-wake written since ends
    // the hold HERE, as a tick during the hold would have, and a returned result is
    // carried under `rewake` (endHold) instead of being typed over the running turn.
    if (this.rewokeDuringHold(this.pollFollower(true))) return;
    if (failed) {
      const watchdog = r.error === "watchdog" && !r.rejected;
      this.anomaly(watchdog ? "hook_hold_watchdog" : "hook_hold_error");
      this.endHold(watchdog ? "watchdog" : "error");
      // the failed settle offers nothing; hook items queued earlier may still go
      this.heldResult = { result: { injections: [] }, since: Date.now() };
    } else {
      // ended normally: clear the bound, nothing to abort
      this.holdGen++;
      if (this.holdWatchdog) clearTimeout(this.holdWatchdog);
      this.holdWatchdog = null;
      this.holdController = null;
    }
    this.applyHeldResult();
  }

  /**
   * Step 4, applied: from `completeHold`, and from each `evalSettling` tick while the
   * screen still shows work. The phase is SETTLING throughout. An injection that
   * survives the queue policy is admitted only when `screenIdle()`; until then the result
   * waits, for at most the admission bound, after which it is abandoned as the
   * watchdog's would be and the turn concludes.
   */
  private applyHeldResult(): void {
    const held = this.heldResult;
    if (!held) return;
    const r = held.result;
    // Guard: caller input normally ends the hold in send()'s own step (4a).
    if (callerCount(this.q) > 0) {
      this.heldResult = null;
      for (const i of r.injections) this.dropInjection(i, "stale");
      this.conclude(null);
      return;
    }
    const items = [...this.q.items, ...r.injections.map((i) => this.hookItemOf(i, held.since))];
    const now = Date.now();
    const d = nextQueueDecision({ ...this.q, items }, now, "IDLE", this.canDeliver);
    const inject = d.deliver?.kind === "hook" ? d.deliver : null;
    if (inject && this.heldAdmission(held.since, now) !== "admit") return;
    this.heldResult = null;
    this.q.items = d.remaining;
    this.dropHookItems(d.drop);
    if (!inject) {
      this.conclude(null);
      return;
    }
    if (this.shape === "interactive") {
      // the turn the injection follows gets its own verdict first (decide(): an
      // API error fails the session, an unread task file is prompt_not_read). `continue`
      // takes it to IDLE, from which the injection is admitted in this same step.
      this.conclude(null);
      if (this.phase !== "IDLE") {
        this.dropInjection(inject, "session_ended");
        return;
      }
    } else {
      this.fire("hold_inject");
      this.activity = null;
    }
    this.fire("admit");
    this.startAdmission(inject, false);
  }

  /**
   * Whether a held result's injection may be typed now. `wait`: the screen still shows
   * work, within the admission bound. `ended`: the hold ended here, the bound passed (the
   * watchdog's outcome) or a re-wake was found, and the result went back to the binding.
   */
  private heldAdmission(since: number, now: number): "admit" | "wait" | "ended" {
    if (!this.screenIdle()) {
      if (now - since < this.admitTimeoutMs()) return "wait";
      this.anomaly("hook_hold_watchdog");
      this.endHold("watchdog");
      this.conclude(null);
      return "ended";
    }
    // About to type: read the transcript now, as `idleForHookItem` does. The view an
    // `evalSettling` tick passed in can be a poll debounce old, and a re-wake whose
    // records landed as the screen cleared ends the hold here, its result carried.
    return this.rewokeDuringHold(this.pollFollower(true)) ? "ended" : "admit";
  }

  /**
   * Step 5: today's `finishTurn` tail, on the held turn and the session's CURRENT shape
   * (a send during the hold converted it). Legal from RUNNING (no hold) and SETTLING.
   */
  private conclude(exitNote: string | null): void {
    const held = this.heldTurn;
    if (!held) return;
    this.heldTurn = null;
    this.activity = null;
    const turn: SettledTurn = { ...held, shape: this.shape };
    let verdict: FinalVerdict | "continue";
    try {
      verdict = this.o.decide(turn);
    } catch (e) {
      verdict = { state: "FAILED", reason: "child_exited", detail: `decide() threw: ${String(e)}` };
    }
    if (verdict === "continue") {
      // an unread hook-turn file is hook_injection_not_read, never the caller's prompt_not_read
      if (!turn.hookCaused && turn.delivery.complete === false) this.anomaly("prompt_not_read");
      this.fire("turn_continue");
      return;
    }
    const note = exitNote ?? (this.paneExited ? exitNoteOf(this.exitCode) : null);
    if (note)
      verdict = { ...verdict, detail: verdict.detail ? `${verdict.detail} · ${note}` : note };
    this.applyVerdict(verdict);
  }

  private evalSettling(view: TranscriptView): void {
    if (this.paneExited) return;
    if (this.rewokeDuringHold(view)) return;
    this.applyHeldResult();
  }

  /**
   * §7.3: a re-wake during the hold abandons it; the same turn runs on and settles again.
   * True when `view` shows one (and the hold has ended).
   */
  private rewokeDuringHold(view: TranscriptView): boolean {
    const t = view.current;
    if (!t || this.settledChatOffset === null) return false;
    const off = this.chatOffsetSinceSettle(t);
    if (off === null || off <= this.settledChatOffset) return false;
    this.endHold("rewake");
    this.heldTurn = null;
    this.rewakeOfSettled = true;
    this.fire("hold_rewake");
    this.activity = "thinking";
    return true;
  }

  /**
   * The last chat offset of the view the settled turn was read from, compared against
   * `settledChatOffset`: the shadow while a turn settled from it is still unwitnessed (new
   * records fold there), otherwise the turn's own.
   */
  private chatOffsetSinceSettle(t: TurnView): number | null {
    if (this.settledOnShadow && t.unwitnessed) return t.unwitnessed.lastChatOffset;
    return t.lastChatOffset;
  }

  /** A sessionStart dispatch no hold took (§7.3 "other session events"). */
  private queueHookInjections(items: HoldInjection[]): void {
    if (isTerminalPhase(this.phase)) {
      for (const i of items) this.dropInjection(i, "session_ended");
      return;
    }
    const now = Date.now();
    for (const i of items) this.q.items.push(this.hookItemOf(i, now));
    this.pump();
  }

  private hookItemOf(i: HoldInjection, now: number): HookQueueItem {
    return {
      kind: "hook",
      text: i.text,
      hookIds: [...i.hookIds],
      queuedAt: now,
      // a sessionStart injection is queued as of its dispatch: it survives the initial prompt
      callerSeq: i.source === "sessionStart" ? this.startCallerSeq : this.q.callerAdmitted,
      source: i.source,
    };
  }

  private dropHookItems(drops: ReadonlyArray<{ item: HookQueueItem; reason: string }>): void {
    for (const { item, reason } of drops) this.dropInjection(item, reason);
  }

  private dropInjection(item: { text: string; hookIds: string[] }, reason: string): void {
    this.anomaly(`hook_injection_dropped:${reason}`);
    try {
      this.hooks?.noteDropped?.(item, reason);
    } catch {
      // journaling never breaks the session
    }
  }

  /* ───────────────────────────── degraded (screen) turn ───────────────────────────── */

  /** The current turn's witness is in the transcript. */
  private witnessed(t: TurnView | null): boolean {
    return !!t && t.index === this.turnIndex && t.acceptedAt !== null;
  }

  /**
   * Degraded settle (architecture-v2 §7.3): the gate ready (an empty box) and naming no
   * dialog, no working row above the located box, and an answer or error row gone quiet.
   * Quiet is above the located box, else the whole screen's (stricter: a ticking status line
   * delays it), used only with no transcript witness.
   */
  private screenSettleReady(view: TranscriptView, answer: string, apiError: unknown): boolean {
    const g = this.gateNow();
    if (!g || !g.ready || g.dialog !== null || workingAboveBox(this.screen) === true) return false;
    let quiet = this.aboveBoxQuietMs() ?? Date.now() - this.screen.changedAt;
    // a static scrolled view looks quiet: count only from the confirmed return to the bottom
    if (this.scrollEndConfirmedAt > 0)
      quiet = Math.min(quiet, Date.now() - this.scrollEndConfirmedAt);
    if (view.availability === "off" && quiet >= this.secondaryQuietMs) return true;
    return (
      (!!answer || !!apiError) && quiet >= 2 * this.t("screenSettleQuietMs", SCREEN_SETTLE_QUIET_MS)
    );
  }

  /**
   * A screen-read turn never settles from a scrolled view: false while a ctrl-End is out or
   * the view may not be at the live bottom, sending ctrl-End when none is out.
   */
  private screenViewLive(): boolean {
    if (this.scrollEndsInFlight > 0) return false;
    if (isLiveBottom(this.scrollPos)) return true;
    void this.returnToLiveBottom(SCROLL_REPLY_MS);
    return false;
  }

  private evalScreenTurn(view: TranscriptView): void {
    if (this.witnessed(view.current)) {
      // A late witness (slow UserPromptSubmit hook): back to the transcript, at once.
      this.turnSource = "transcript";
      this.screenTurn = null;
      this.anomaly("degraded_reverted");
      this.evalRunning(view);
      return;
    }
    const st = this.screenTurn;
    if (!st) return;
    if (this.settleUnwitnessedEnd(view, st)) return;
    if (!this.client) return;
    const answer = screenAnswer(this.screen, st.echo);
    const apiError = this.screenApiError(st, answer);
    this.activity = "thinking";
    if (!this.screenViewLive() || !this.screenSettleReady(view, answer, apiError)) return;
    // one last poll before a screen-mode settle, with the same reversion
    this.follower.poll();
    if (this.witnessed(this.follower.view().current)) return;
    this.anomaly("screen_answer_may_be_truncated");
    if (this.currentDelivery?.mode === "file") this.anomaly("read_coverage_unverified");
    const d = this.currentDelivery;
    this.finishTurn(
      {
        index: this.turnIndex,
        answer,
        apiError,
        stopReason: null,
        captureSource: "screen",
        settledBy: "screen",
        shape: this.shape,
        delivery: {
          mode: d && d.mode !== "refused" ? d.mode : "typed",
          linesTotal: null,
          linesRead: null,
          complete: null,
          preambleBytes: 0,
        },
      },
      null,
      null
    );
  }

  /**
   * A screen turn whose witness never arrives still ends at Claude Code's own end record:
   * the `turn_duration` the follower folded from this turn's records past its offset
   * (`TurnView.unwitnessed`), written after the screen turn began. The same `decideSettle`
   * as a witnessed turn decides, so a background agent still pending, a pending tool or a
   * waking record holds the turn open exactly as it does there. The answer is that
   * transcript's assistant text; with none, the screen's, read from the live bottom of a
   * connected client. The turn settles at the shadow's last chat offset, so a re-wake past
   * it is seen while held or idle.
   */
  private settleUnwitnessedEnd(view: TranscriptView, st: ScreenTurn): boolean {
    const u = view.current?.index === this.turnIndex ? view.current.unwitnessed : null;
    if (!u?.turnDurationAfterLast || u.turnDurationAt === null) return false;
    // an end record whose time cannot be read is never proven to follow the acceptance
    const endedAt = Date.parse(u.turnDurationAt);
    if (!Number.isFinite(endedAt) || endedAt < st.acceptedAt) return false;
    const quiet = Date.now() - (view.lastAppendAt ?? st.acceptedAt);
    const turn: TurnView = { ...u, acceptedAt: new Date(st.acceptedAt).toISOString() };
    const decision = decideSettle({
      turn,
      session: view.session,
      transcriptQuietMs: quiet,
      chatQuietMs: quiet,
      facts: this.corroborationFacts(),
      paneExited: false,
      secondaryQuietMs: this.secondaryQuietMs,
      corroborationMs: this.corroborationMs,
      corroborationGraceMs: this.t("gateGraceMs", GATE_GRACE_MS),
    });
    if (!decision.settled) return false;
    // counted only once the turn really settles: the screen branch below may still wait
    const notes: string[] = [];
    let core = this.settledTurnOf(turn, decision, (key) => notes.push(key));
    if (!core.answer && !core.apiError) {
      // the screen and the scroll position are the last frame before a dropped client
      if (!this.client || !this.screenViewLive()) return false;
      const answer = screenAnswer(this.screen, st.echo);
      core = {
        ...core,
        answer,
        apiError: this.screenApiError(st, answer),
        captureSource: "screen",
      };
      this.anomaly("screen_answer_may_be_truncated");
    }
    for (const key of notes) this.anomaly(key);
    this.anomaly("unwitnessed_turn_duration");
    for (const a of decision.anomalies) this.anomaly(a);
    for (const cmd of turn.backgroundShellsOpen) this.anomaly(`background_shell_open: ${cmd}`);
    this.finishTurn(core, u.lastChatOffset, null, true);
    return true;
  }

  private errorLogPath(): string | null {
    return this.o.slotEnv.CLAUDISH_UPSTREAM_ERROR_LOG ?? null;
  }

  private errorLogSize(): number {
    const p = this.errorLogPath();
    if (!p) return 0;
    try {
      return statSync(p).size;
    } catch {
      return 0;
    }
  }

  private screenApiError(st: ScreenTurn, answer: string): TurnView["apiError"] {
    const p = this.errorLogPath();
    if (p && this.errorLogSize() > st.errorLogSize) {
      try {
        const text = readFileSync(p, "utf8").slice(st.errorLogSize).trim();
        return { status: null, category: "upstream_error_log", text };
      } catch {
        // fall through to the screen
      }
    }
    const rows = screenErrorRows(this.screen);
    if (rows.length > 0 && !answer)
      return { status: null, category: "screen", text: rows.join("\n") };
    return null;
  }

  /* ───────────────────────────── the exit path ───────────────────────────── */

  /** Settle evidence for the current turn on the exit path (paths P, I, S without screen, X). */
  private exitSettle(): (SettleDecision & { settled: true }) | null {
    const view = this.follower.view();
    const d = decideSettle({
      turn: view.current,
      session: view.session,
      transcriptQuietMs: Number.MAX_SAFE_INTEGER,
      chatQuietMs: Number.MAX_SAFE_INTEGER,
      facts: null,
      paneExited: true,
      secondaryQuietMs: this.secondaryQuietMs,
      corroborationMs: 0,
    });
    if (!d.settled) return null;
    return { ...d, anomalies: d.anomalies.filter((a) => a !== "screen_unverified") };
  }

  /** §2.2: the exit is decided against the CURRENT turn only. */
  private applyExitPath(code: number | null): void {
    if (isTerminalPhase(this.phase)) return;
    const view = this.pollFollower(true);
    // a witness written just before the exit is still an acceptance
    if (this.phase === "ADMITTING" && this.admission && this.witnessed(view.current)) this.accept();
    // §7.3 step 7 (M-1c): an unwitnessed HOOK admission is abandoned first, so an
    // injection never turns a settled chain or a clean exit into a failure.
    const adm = this.admission;
    if (this.phase === "ADMITTING" && adm && adm.item.kind === "hook")
      this.hookAdmissionFailed(adm.item);
    // §7.3 step 6 (H1): a held turn is concluded with the exit code. An interactive
    // session then takes today's IDLE exit rules below.
    if (this.phase === "SETTLING") {
      this.endHold("exit");
      this.conclude(exitNoteOf(code));
      if (isTerminalPhase(this.phase)) return;
    }
    if (this.phase === "RUNNING") {
      const d = this.exitSettle();
      const t = this.follower.view().current;
      if (d && t) this.settle(t, d, code);
    }
    if (isTerminalPhase(this.phase)) return;
    if (this.cleanIdleExit(code)) {
      this.fire("exit_clean");
      return;
    }
    this.firePaneExit(code);
  }

  /**
   * §2.2 rule 2: interactive, IDLE, exit 0, after /exit or ≥ 1 settled turn, nothing
   * admitted. An exit seen only as ESRCH while the socket is lost has no code when magmux could
   * not name it either: after a delivered /exit that is still the clean exit it asked for.
   */
  private cleanIdleExit(code: number | null): boolean {
    if (this.phase !== "IDLE" || this.shape !== "interactive") return false;
    if (code !== 0 && !(code === null && this.exitRequested)) return false;
    return (this.exitRequested || this.turnsCompleted >= 1) && this.admission === null;
  }

  /**
   * §2.2 rule 3: agent_rejected when the child's own refusal is on screen, else child_exited.
   * A child that exited outside the alternate screen gets its own error line (or, with none,
   * its last lines) right after the exit code, so a display that keeps only the first line
   * still says why it exited. On the alternate screen those lines are the interface's own
   * (box rules, the prompt, tool output), so the detail carries the exit code and last line only.
   */
  private firePaneExit(code: number | null): void {
    const screen = screenText(this.screen);
    const text = `${this.exitLastLine}\n${this.exitScrollback}\n${screen}`;
    const rejected =
      agentRejectedLine(screen) ??
      agentRejectedLine(this.exitScrollback) ??
      agentRejectedLine(text);
    if (rejected) {
      this.fire("pane_exit", { reason: "agent_rejected", detail: rejected });
      return;
    }
    const onAltScreen = this.screen.alt || this.exitCaptureAlt;
    const evidence = onAltScreen
      ? ""
      : childExitEvidence(
          [this.exitCapture, screen, this.exitLastLine],
          [this.exitCapture, screen]
        );
    const exited = `pane child exited ${code === null ? "(code unknown)" : `with code ${code}`}`;
    this.fire("pane_exit", {
      reason: "child_exited",
      detail: `${exited}${evidence ? `: ${evidence}` : ""}${this.exitLastLine ? `; last line: ${this.exitLastLine}` : ""}\n${screenTailOf(this.screen)}`,
    });
  }

  /* ───────────────────────────── public verbs ───────────────────────────── */

  snapshot(): PaneSnapshot {
    const view = this.follower.view();
    const subagents = this.follower.subagents();
    const terminal = isTerminalPhase(this.phase);
    // M4: a resize redraw is not activity, so it never resets idle_seconds
    const lastAct = Math.max(this.activityChangedAt, view.lastAppendAt ?? 0);
    const cur = view.current;
    const hasTranscript =
      view.availability === "ok" && view.usage.tokensIn + view.usage.tokensOut > 0;
    return {
      paneId: this.paneId,
      phase: this.phase,
      state: this.wire(),
      reason: this.phase === "COMPLETED" || !terminal ? null : this.reason,
      detail: this.detail,
      activity: terminal ? null : this.phaseActivity(),
      lastActivityAt: lastAct > 0 ? iso(lastAct) : null,
      idleSeconds:
        terminal || lastAct === 0 ? null : Math.max(0, Math.floor((Date.now() - lastAct) / 1000)),
      turnsCompleted: this.turnsCompleted,
      tokensIn: hasTranscript ? view.usage.tokensIn : null,
      tokensOut: hasTranscript ? view.usage.tokensOut : null,
      toolCalls: view.toolCalls,
      liveAnswerBytes: cur ? Buffer.byteLength(cur.assistantText.join("\n\n")) : 0,
      exitCode: this.exitCode,
      captureSource: this.lastCaptureSource,
      turnSource: this.turnSource,
      pendingInputs: callerCount(this.q),
      pendingHookInputs: hookCount(this.q),
      connected: this.client !== null,
      startedAt: iso(this.startedAtMs),
      endedAt: this.endedAtMs ? iso(this.endedAtMs) : null,
      transcriptPath: this.o.transcriptPath,
      panePid: this.panePidValue,
      screenTail: screenTailOf(this.screen),
      anomalies: [...this.anomalies].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)),
      claudeCodeVersion: this.claudeCodeVersion,
      shape: this.shape,
      turnEndRecordMissing:
        !terminal &&
        this.phase === "RUNNING" &&
        this.activity === "finishing" &&
        this.turnEndMissing,
      agentCountMismatch: !terminal && this.phase === "RUNNING" && this.agentMismatch !== null,
      recent: cur && cur.recent.length > 0 ? cur.recent : null,
      agent: view.agentSetting,
      viewSockPath: terminal ? null : this.viewSock,
      promptsSent: this.q.callerAdmitted + callerCount(this.q),
      subagents: subagents.rows,
      subagentsVersion: subagents.version,
    };
  }

  private phaseActivity(): string | null {
    const phase = this.phase;
    switch (phase) {
      case "RUNNING":
        return this.activity ?? "thinking";
      case "SETTLING":
        return this.activity ?? "hook";
      case "QUESTION":
        return "AskUserQuestion";
      case "PERMISSION":
        return this.activity;
      case "BOOTING":
      case "ADMITTING":
      case "IDLE":
      case "COMPLETED":
      case "FAILED":
      case "CANCELLED":
      case "TIMEOUT":
      case "EMPTY":
      case "SHAPE_MISMATCH":
        return null;
      default:
        return assertNever(phase);
    }
  }

  capture(sinceSeq?: number, opts: { spans?: boolean } = {}): CaptureResult | CaptureUnchanged {
    const s = this.screen;
    if (sinceSeq !== undefined && sinceSeq === s.seq)
      return { unchanged: true, seq: s.seq, final: this.final };
    const out: CaptureResult = {
      seq: s.seq,
      cols: s.cols,
      rows: s.rows,
      cursor: { ...s.cursor },
      lines: [...s.lines],
      final: this.final,
    };
    if (opts.spans) out.spans = s.spans.map((r) => r.map((x) => [...x] as typeof x));
    return out;
  }

  send(text: string): SendResult {
    if (isTerminalPhase(this.phase)) return { ok: false, reason: "terminal" };
    if (/^\/(clear|resume)(\s|$)/.test(text.trim()))
      return { ok: false, reason: "unsupported_command" };
    const plan = planDelivery(text, this.turnDir, 0, this.o.readAvailable);
    if (plan.mode === "refused") return { ok: false, reason: "delivery_unavailable" };
    if (this.shape === "one-shot") this.shape = "interactive";
    this.q.items.push({ kind: "caller", text });
    this.escapeArmed = true;
    // Read the transcript first: a turn whose end record already landed settles HERE, and
    // its owner must see the converted shape (SettledTurn.shape) and the queued text.
    this.step(() => {
      this.pollFollower(true);
      // §7.3 step 4a (L-5): caller input ends a hold at once, in this step. The held
      // turn concludes on the converted shape (continue → IDLE) and the pump admits the
      // caller's text below; whatever settle() returns later fails the generation check.
      if (this.phase === "SETTLING" && !this.paneExited) {
        this.endHold("caller");
        this.conclude(null);
      }
      this.evaluate();
    });
    // Never report a queued prompt for a session this very step ended.
    if (isTerminalPhase(this.phase)) return { ok: false, reason: "terminal" };
    return { ok: true, queued: callerCount(this.q) };
  }

  async resize(cols: number, rows: number): Promise<PaneResizeOutcome> {
    const size = clampPaneSize(cols, rows);
    if (isTerminalPhase(this.phase)) return this.lastSizeOutcome();
    if (!this.supportsResize)
      throw new ContractErrorException(
        "resize_unsupported",
        'this magmux has no resize op (capabilities.verbs lacks "resize"); a newer magmux is needed'
      );
    if (!this.client) return this.pendingOutcome(size);
    // Same size and nothing in flight: no request. Otherwise magmux's `changed` decides.
    if (
      samePaneSize(this.appliedSize, size) &&
      samePaneSize(this.desiredSize, size) &&
      !this.resizeDraining
    )
      return { ...size, changed: false, seq: this.screen.seq };
    this.desiredSize = size;
    return new Promise<PaneResizeOutcome>((resolve, reject) => {
      this.resizeWaiters.push({ resolve, reject });
      this.kickResize();
    });
  }

  /** Store the size for the redial (`attach` applies it) and answer it as pending. */
  private pendingOutcome(size: PaneSize): PaneResizeOutcome {
    this.desiredSize = { ...size };
    return { ...size, changed: true, seq: this.screen.seq, pending: true };
  }

  /** A terminal pane's answer: the size of its last screen, unchanged. */
  private lastSizeOutcome(): PaneResizeOutcome {
    return { cols: this.screen.cols, rows: this.screen.rows, changed: false, seq: this.screen.seq };
  }

  /** A screen change at `at` falls within the resize quiet window. */
  private inResizeQuiet(at: number): boolean {
    return this.resizeQuietFrom > 0 && at >= this.resizeQuietFrom && at < this.resizeQuietUntil;
  }

  /** Open the quiet window (or keep the open one's start) and extend its end, never retract it. */
  private extendResizeQuiet(): void {
    const now = Date.now();
    if (now >= this.resizeQuietUntil) this.resizeQuietFrom = now;
    this.resizeQuietUntil = Math.max(this.resizeQuietUntil, now + RESIZE_QUIET_MS);
  }

  /**
   * A size no waiter carries is still owed: a `pending` one stored while the worker sat in
   * its screen wait, whose redial's `attach` kick found the worker running. Only a size the
   * worker has not sent on this connection is owed, so a refused one is never resent.
   */
  private resizeOwed(): boolean {
    return (
      !!this.client &&
      this.supportsResize &&
      !isTerminalPhase(this.phase) &&
      !samePaneSize(this.appliedSize, this.desiredSize) &&
      !samePaneSize(this.lastSentSize, this.desiredSize)
    );
  }

  /** Start the per-pane drain worker unless it runs already. */
  private kickResize(): void {
    if (this.resizeDraining) return;
    this.resizeDraining = true;
    void this.drainResize().finally(() => {
      this.resizeDraining = false;
      // a waiter, or an owed size, that arrived after the loop's last check
      if (this.resizeWaiters.length > 0 || this.resizeOwed()) this.kickResize();
    });
  }

  /**
   * The single resize worker of this pane (H3, M3): one request at a time, always the
   * LATEST desired size, so the sizes of a drag coalesce. Each send answers every waiter
   * queued before it; a waiter that arrives during it gets the next send. With no waiter
   * it runs once (`attach` re-applying the size after a redial), and again while a size is
   * owed. The phase is re-checked after every await: a terminal pane answers its last
   * size, `changed:false`.
   */
  private async drainResize(): Promise<void> {
    let first = true;
    while (first || this.resizeWaiters.length > 0 || this.resizeOwed()) {
      first = false;
      const batch = this.resizeWaiters.splice(0);
      const answer = (r: PaneResizeOutcome) => {
        for (const w of batch) w.resolve(r);
      };
      const fail = (e: ContractErrorException) => {
        for (const w of batch) w.reject(e);
      };
      if (isTerminalPhase(this.phase)) {
        answer(this.lastSizeOutcome());
        continue;
      }
      const want = { ...this.desiredSize };
      const c = this.client;
      if (!c) {
        answer(this.pendingOutcome(want));
        continue;
      }
      if (!this.supportsResize) {
        fail(new ContractErrorException("resize_unsupported", "this magmux has no resize op"));
        continue;
      }
      // opened before the send: the child's SIGWINCH redraw can arrive before the reply
      this.lastSentSize = want;
      this.extendResizeQuiet();
      const r = await c.request<{ cols?: number; rows?: number; changed?: boolean }>(
        { type: "resize", pane: 0, cols: want.cols, rows: want.rows },
        RESIZE_REPLY_MS
      );
      if (isTerminalPhase(this.phase)) {
        answer(this.lastSizeOutcome());
        continue;
      }
      if (!r.ok) {
        // magmux may have applied a request whose reply was lost: the size is unknown, and
        // its redraw may still arrive
        if (r.code === "client_lost" || r.code === "client_timeout") {
          this.appliedSize = null;
          this.extendResizeQuiet();
        }
        // the connection is gone: the redial's attach re-applies desiredSize
        if (r.code === "client_lost" || r.code === "client_closed") {
          answer(this.pendingOutcome(this.desiredSize));
          continue;
        }
        fail(
          new ContractErrorException(
            "delivery_unavailable",
            `magmux did not resize the pane: ${r.code}${r.error ? `: ${r.error}` : ""}`
          )
        );
        continue;
      }
      const set = {
        cols: typeof r.result.cols === "number" ? r.result.cols : want.cols,
        rows: typeof r.result.rows === "number" ? r.result.rows : want.rows,
      };
      this.appliedSize = set;
      if (r.result.changed !== true) {
        answer({ ...set, changed: false, seq: this.screen.seq });
        continue;
      }
      this.extendResizeQuiet();
      // H4: the answer's seq is the first screen at the new size (magmux's forced keyframe)
      await this.waitFor(
        () =>
          isTerminalPhase(this.phase) ||
          (this.screen.cols === set.cols && this.screen.rows === set.rows),
        RESIZE_SCREEN_MS
      );
      if (isTerminalPhase(this.phase)) {
        answer(this.lastSizeOutcome());
        continue;
      }
      answer({ ...set, changed: true, seq: this.screen.seq });
    }
  }

  async scroll(req: ScrollRequest): Promise<{ seq: number }> {
    const refusal = this.scrollRefusal();
    if (refusal) throw new ContractErrorException("scroll_unavailable", refusal);
    const c = this.client;
    if (!c || c.isClosed)
      throw new ContractErrorException("scroll_unavailable", "the pane's socket is reconnecting");
    const plan = planScroll(this.scrollPos, req);
    if (plan.bytes === "") return { seq: this.screen.seq };
    // Before any await: a concurrent scroll plans from where this one leaves the view, and
    // the redraw falls in the quiet window (a scroll redraw is not the child working).
    this.scrollPos = plan.next;
    const seq0 = this.screen.seq;
    this.extendResizeQuiet();
    const r = await c.request(
      { type: "send", pane: 0, text: plan.bytes, enter: false, noGate: true },
      SCROLL_REPLY_MS
    );
    if (!r.ok) {
      // the bytes may still be delivered (they queue behind claudish's own in-flight send
      // on the pane's lane), so the position is unknown, never assumed unmoved
      this.scrollPos = UNKNOWN_POSITION;
      if (r.code === "client_lost" || r.code === "client_timeout") this.extendResizeQuiet();
      throw new ContractErrorException(
        "scroll_unavailable",
        `magmux did not confirm the scroll: ${r.code}${r.error ? `: ${r.error}` : ""}`
      );
    }
    this.extendResizeQuiet();
    await this.waitFor(
      () => isTerminalPhase(this.phase) || this.screen.seq !== seq0,
      this.t("scrollScreenMs", SCROLL_SCREEN_MS)
    );
    return { seq: this.screen.seq };
  }

  /**
   * A screen-read turn is in progress. `turnSource` stays "screen" after it settles (until
   * the next delivery), so the phase decides: SETTLING and IDLE hold a settled turn.
   */
  private screenTurnActive(): boolean {
    if (this.turnSource !== "screen") return false;
    return this.phase === "RUNNING" || this.phase === "QUESTION" || this.phase === "PERMISSION";
  }

  /** Why a scroll is refused now (nothing is sent), or null when it is allowed. */
  private scrollRefusal(): string | null {
    if (isTerminalPhase(this.phase) || this.final) return "the session has finished";
    if (this.phase === "BOOTING" || this.screen.seq === 0) return "the session is still starting";
    if (this.phase === "ADMITTING") return "a prompt is being delivered to the session";
    if (this.keysWithheld())
      return "an earlier prompt's copy may still be unread in the input box; nothing is sent to the pane until it is resolved";
    if (this.screenTurnActive())
      return "the session's turn is being read from its screen (no transcript)";
    // a closed client is not connected: it is replaced only when `disconnected` fires; an
    // attached one is not trusted until its binding check passes
    if (!this.client || this.client.isClosed || !this.gateTrusted)
      return "the pane's socket is reconnecting";
    return null;
  }

  /**
   * ctrl-End before claudish needs the live bottom (an admission's delivery, a screen-read
   * turn) when a scroll may have left the view elsewhere. One ungated send, no Enter.
   */
  private async returnToLiveBottom(ms: number): Promise<void> {
    if (isLiveBottom(this.scrollPos)) return;
    // the position stays as it is, so a later step returns the view once the copy is resolved
    if (this.keysWithheld()) return;
    const c = this.client;
    // an unverified connection is a reconnecting one: nothing is sent, the position stays
    if (!c || c.isClosed || !this.gateTrusted || ms <= 0) return;
    this.scrollPos = LIVE_BOTTOM;
    this.extendResizeQuiet();
    this.scrollEndsInFlight++;
    try {
      const r = await c.request(
        { type: "send", pane: 0, text: CTRL_END, enter: false, noGate: true },
        Math.min(SCROLL_REPLY_MS, ms)
      );
      if (r.ok) {
        this.scrollEndConfirmedAt = Date.now();
      } else {
        this.scrollPos = UNKNOWN_POSITION;
        this.anomaly(`scroll_end_unconfirmed:${r.code}`);
      }
    } finally {
      this.scrollEndsInFlight--;
    }
  }

  turnAnswer(index: number): string {
    const done = this.answers.get(index);
    if (done !== undefined) return done;
    const cur = this.follower.view().current;
    return cur && cur.index === index ? cur.assistantText.join("\n\n") : "";
  }

  chainText(): string {
    const parts = this.chain.map((c) => c.answer);
    const lastIndex = this.chain[this.chain.length - 1]?.index ?? 0;
    const cur = this.follower.view().current;
    // the running chain turn: one above the last recorded index, not yet recorded
    if (cur && cur.index > lastIndex) parts.push(cur.assistantText.join("\n\n"));
    return parts.filter((a) => a !== "").join("\n\n");
  }

  assistantMessageIds(): readonly string[] {
    return this.follower.assistantMessageIds();
  }

  diagnostics(): PaneDiagnostics {
    const cur = this.follower.view().current;
    const rec = this.registryRec;
    const g = this.gate;
    return {
      magmuxStderr: this.stderrHead,
      registry: rec
        ? { status: rec.status, waitingFor: rec.waitingFor, version: rec.version }
        : null,
      preambleBytes: cur?.preambleBytes ?? 0,
      readCoverage: cur?.delivery
        ? {
            linesTotal: cur.delivery.lines,
            linesReturned: cur.readCoverage.linesReturned,
            complete: cur.readCoverage.complete,
            reads: cur.readCoverage.reads,
          }
        : null,
      gate:
        g && this.client
          ? { ready: g.ready, reason: g.reason, detail: g.detail, ageMs: Date.now() - g.receivedAt }
          : null,
      lastSend: this.lastSend ? { ...this.lastSend } : null,
    };
  }

  cancel(): { changed: boolean; state: SlotState } {
    return this.endBy("cancel");
  }

  expire(): { changed: boolean; state: SlotState } {
    return this.endBy("timeout");
  }

  private endBy(ev: "cancel" | "timeout"): { changed: boolean; state: SlotState } {
    if (isTerminalPhase(this.phase)) return { changed: false, state: this.wire() };
    this.step(() => this.fire(ev));
    return { changed: true, state: this.wire() };
  }

  reaped(): Promise<void> {
    return this.reapPromise ?? this.terminal.then(() => this.reapPromise ?? Promise.resolve());
  }

  reapVerified(): Promise<void> {
    return this.verifiedReap.promise;
  }

  panePid(): number | null {
    return this.panePidValue;
  }

  /* ───────────────────────────── terminal and reap ───────────────────────────── */

  private onTerminal(): void {
    this.endedAtMs = Date.now();
    this.final = true;
    this.endGatePause?.();
    this.admission = null;
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    if (this.hooks) {
      // every way out of SETTLING aborts the hold with its reason (§4.10)
      this.endHold("terminal");
      this.heldTurn = null;
      for (const item of this.q.items)
        if (item.kind === "hook") this.dropInjection(item, "session_ended");
      this.q.items = this.q.items.filter((i) => i.kind === "caller");
      try {
        this.hooks.fireEnd({ state: this.wire(), reason: this.reason, exitCode: this.exitCode });
      } catch {
        // never delays the terminal state or the reap
      }
    }
    if (!this.readySettled) {
      this.readySettled = true;
      this.resolveReady();
    }
    // after the step that made it terminal has finished (onTransition first)
    queueMicrotask(() => this.resolveTerminal(this.snapshot()));
    if (!this.reapPromise) this.reapPromise = this.reap();
  }

  private async waitFor(pred: () => boolean, ms: number): Promise<void> {
    const end = Date.now() + ms;
    while (!pred() && Date.now() < end) await Bun.sleep(25);
  }

  /** The identity-checked reap, in `pane-reap.ts`: this pane's own steps first. */
  private async reap(): Promise<void> {
    await Promise.resolve(); // let the terminal step finish first
    this.reaping = true;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    if (this.gateTimer) clearInterval(this.gateTimer);
    this.gateTimer = null;
    await reapPaneProcesses(this.reapSubject);
  }

  /** What the shared reap reads and writes: this pane's own fields, never a copy. */
  private get reapSubject(): PaneReapSubject {
    const pane = this;
    return {
      paneId: this.paneId,
      root: this.root,
      identity: this.identity,
      get group() {
        return pane.group;
      },
      set group(g) {
        pane.group = g;
      },
      get reapFailed() {
        return pane.reapFailed;
      },
      set reapFailed(v) {
        pane.reapFailed = v;
      },
      panePid: () => this.panePidValue,
      adoptPanePid: (pid) => {
        this.panePidValue = pid;
      },
      client: () => this.client,
      paneClosed: () => this.paneClosed,
      magmux: () => this.magmux,
      watcher: () => this.watcher,
      files: () => ({
        paneId: this.paneId,
        sockPath: this.sockPath,
        launcherDir: this.ctlDir,
        turnDir: this.turnDir,
      }),
      fast: () => this.fastReap,
      onVerified: () => this.verifiedReap.resolve(),
      onUnverified: () => this.anomaly("reap_unverified"),
    };
  }

  /** Re-run the last steps (the registry's 2 s tick, after an unverified reap). */
  retryReap(): Promise<boolean> {
    return retryPaneReap(this.reapSubject);
  }

  async shutdownReap(_reason: string): Promise<void> {
    this.fastReap = true;
    if (!isTerminalPhase(this.phase)) this.step(() => this.fire("cancel"));
    await (this.reapPromise ?? Promise.resolve());
  }

  killMagmuxSync(): void {
    if (alive(this.magmux)) this.magmux?.kill("SIGKILL");
  }
}

/** The pane's size at launch: the owner's initial size, clamped, else the default. */
function launchSize(o: PaneSessionOptions): PaneSize {
  return o.initialSize
    ? clampPaneSize(o.initialSize.cols, o.initialSize.rows)
    : { cols: DEFAULT_PANE_COLS, rows: DEFAULT_PANE_ROWS };
}

/** A fresh admission of a typed, file or command plan; its first step follows the plan's kind. */
function newAdmission(a: {
  index: number;
  item: QueueItem;
  text: string;
  plan: Extract<Delivery, { mode: "typed" | "file" | "command" }>;
  initial: boolean;
  bound: number;
  mark: number;
}): Admission {
  const now = Date.now();
  return {
    index: a.index,
    item: a.item,
    text: a.text,
    plan: a.plan,
    line: a.plan.line,
    initial: a.initial,
    startedAt: now,
    deadline: now + a.bound,
    step: typingStep(a.plan),
    inFlight: false,
    attempts: 0,
    submittedUnproven: null,
    panel: null,
    stopped: false,
    clearFirst: false,
    clearAfter: 0,
    awaitingDraw: null,
    drawState: "none",
    leftoverOf: null,
    leftoverCopy: null,
    uncleared: false,
    readWhole: false,
    mark: a.mark,
    copyReleased: false,
    recordWaitFrom: null,
    writtenPart: null,
    lostType: null,
    last: null,
    noted: new Set(),
    liveBottomClient: null,
  };
}

/** The anomaly of an Enter-only step whose text left the box without claudish's Enter. */
function leftBoxAnomaly(plan: Delivery): string {
  return plan.mode === "command" ? "gate_command_left_box" : "gate_line_left_box";
}

/** The step of a send that types the line: a command's TYPE, else the one-shot SUBMIT. */
function typingStep(plan: Delivery): SubmitStep {
  return plan.mode === "command" ? "type" : "submit";
}

/** What the screen last showed while a copy may be unread, for the deadline detail. */
type DrawState = "none" | "prefix" | "changing";

/**
 * The box as one trusted frame draws it: null when it is located and empty, else its text, how
 * it reads against the line, and the blank cells the cursor proves were drawn after the text on
 * its last text row (`cursorGapAfterText`, null when it proves none).
 */
type DrawnBox = { text: string; match: BoxMatch; cursorGap: number | null } | null;

function sameDrawnBox(a: DrawnBox, b: DrawnBox): boolean {
  return a?.text === b?.text && a?.match === b?.match && a?.cursorGap === b?.cursorGap;
}

/** A box read empty again resets the detail: it never says "changing" for an empty box. */
function drawStateOf(seen: DrawnBox): DrawState {
  if (seen === null) return "none";
  return seen.match === "prefix" ? "prefix" : "changing";
}

/**
 * How a box unchanged for `quietMs` ends `awaitDraw`: "settled" (text that is not the start
 * of the line), "gone" (empty, after an earlier copy's WHOLE line showed in a trusted frame
 * of the same trust epoch: `goneCounts`), or null (keep waiting: no trusted frame, still
 * changing, empty, or the start of the line). "gone" is safe only after the whole line was
 * read: nothing of that copy can still be unread, so its leaving the box means it was taken
 * away. After only its start showed, an empty box may be a redraw while the rest is still
 * queued, and a new copy typed then would land behind that rest.
 */
function drawOutcome(
  now: DrawnBox | undefined,
  goneCounts: boolean,
  quietMs: number
): "settled" | "gone" | null {
  if (now === undefined || quietMs < DRAW_SETTLE_MS) return null;
  if (now === null) return goneCounts ? "gone" : null;
  return now.match === "prefix" ? null : "settled";
}

/**
 * `drawOutcome`, or "settled" for a box settled on exactly the written part (`partOnly`). Text
 * that may be that part with its final spaces unread never settles (`unprovenSpaces`).
 */
function drawEnded(
  now: DrawnBox | undefined,
  goneCounts: boolean,
  quietMs: number,
  partOnly: string | null
): "settled" | "gone" | null {
  const ended = drawOutcome(now, goneCounts, quietMs);
  if (!partOnly) return ended;
  if (ended === "settled" && unprovenSpaces(now, partOnly)) return null;
  if (ended !== null) return ended;
  return isWrittenPart(now, partOnly, quietMs) ? "settled" : null;
}

/**
 * The written part ends in spaces, the cursor does not prove them drawn (`writtenPartShown`),
 * and the box, with every space and row break removed, shows a start of the part with every
 * space removed. However its rows were matched ("other" included: a space run wrapped over
 * several rows), the box may be that part with its final spaces still unread, and a clear
 * would queue behind them: nothing is proved, so it is waited on.
 */
function unprovenSpaces(now: DrawnBox | undefined, part: string): boolean {
  if (!now || !part.endsWith(" ") || writtenPartShown(part, now)) return false;
  return part.replace(/\s+/g, "").startsWith(now.text.replace(/\s+/g, ""));
}

/** A normal box, unchanged for the settle window, showing exactly the written part of the line. */
function isWrittenPart(now: DrawnBox | undefined, part: string, quietMs: number): boolean {
  return quietMs >= DRAW_SETTLE_MS && writtenPartShown(part, now);
}

/**
 * A normal box showing exactly the written part `part`. A drawn row loses its trailing
 * whitespace (`locatedBoxText`), so a part that ends in k ASCII spaces matches only when the box
 * shows the rest of it AND the cursor proves the k spaces were drawn after that text on the
 * same row (`cursorGap === k`). Anything less (spaces not drawn yet, spaces wrapped to another
 * row, a cursor elsewhere) proves nothing, and the box is waited on, never cleared.
 */
export function writtenPartShown(part: string, now: DrawnBox | undefined): boolean {
  if (!now || now.match !== "prefix") return false;
  const shown = trimTrailingSpaces(part);
  if (matchBoxText(now.text, shown) !== "line") return false;
  const spaces = part.length - shown.length;
  return spaces === 0 || now.cursorGap === spaces;
}

function trimTrailingSpaces(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === " ") end--;
  return s.slice(0, end);
}

/** The box may hold this admission's own text, as of the reply received now. */
function markClearFirst(adm: Admission): void {
  adm.clearFirst = true;
  adm.clearAfter = Date.now();
}

/** Nothing is cleared or typed until the box has settled (`awaitDraw`). */
function startDrawWait(adm: Admission): void {
  adm.awaitingDraw = Date.now();
  adm.drawState = "none";
}

/**
 * The reply proves the whole line was in the box: magmux verified it there (`in_box`, and the
 * `still_in_box` and `unconfirmed` replies, whose Enter it pressed only after verifying it), or
 * Enter was pressed with its evidence seen (`accepted`). Every byte of it was read.
 */
export function provesReadWhole(out: SendOutcome): boolean {
  if (out.kind === "accepted" || out.kind === "in_box") return true;
  return (
    out.kind === "not_accepted" && (out.reason === "still_in_box" || out.reason === "unconfirmed")
  );
}

/**
 * Whether a send of `step` answered by `out` may have left its line in Claude Code's input
 * unread: every outcome of a send that types, except those that prove nothing was written
 * (`bad_request`, `unsent`, an untyped `busy`, `not_accepted` or `pane_gone`) and those that
 * prove the whole line was in the box (`provesReadWhole`): nothing of it is queued. An
 * Enter-only send types nothing.
 */
export function mayHaveTyped(step: SubmitStep, out: SendOutcome): boolean {
  if (step === "enter") return false;
  switch (out.kind) {
    case "accepted":
    case "bad_request":
    case "unsent":
      return false;
    case "busy":
    case "pane_gone":
      return out.typed;
    case "not_accepted":
      return out.typed && !provesReadWhole(out);
    case "in_box":
      return false;
    case "reply_lost":
    case "unexpected":
      return true;
    default:
      return assertNever(out);
  }
}

/**
 * The wire request of one admission step and the shape `sendBudgetMs` sizes it by. `keys`
 * counts the final Enter as one key (an upper bound either way). Every send is typed
 * (`typed:true`, R1.2: a paste is never retyped and is verified by token count). `noGate`
 * and `dismissDialogs` are never set.
 */
function sendShape(
  step: SubmitStep,
  line: string
): {
  msg: Record<string, unknown>;
  budget: { text: string; keys: number; submit: boolean };
} {
  switch (step) {
    case "submit":
      return {
        msg: { type: "send", pane: 0, text: line, typed: true, enter: true },
        budget: { text: line, keys: 1, submit: true },
      };
    case "type":
      return {
        msg: { type: "send", pane: 0, text: line, typed: true, enter: false },
        budget: { text: line, keys: 0, submit: false },
      };
    case "enter":
      // a final Enter key is a SUBMIT to the gate (verified `non_empty`), R1.5.4
      return {
        msg: { type: "send", pane: 0, keys: ["enter"], enter: false },
        budget: { text: "", keys: 1, submit: true },
      };
    default:
      return assertNever(step);
  }
}

/** `sendBudgetMs` minus its readiness wait: what an attempt costs beyond waiting for the box. */
function fixedSendMs(step: SubmitStep, line: string): number {
  const rt = SEND_READY_WAIT_DEFAULT_MS;
  return sendBudgetMs({ ...sendShape(step, line).budget, readyTimeoutMs: rt }) - rt;
}

/**
 * The `readyTimeoutMs` of the next attempt, or null when none fits (R1.4): the client
 * timeout (`sendBudgetMs + SEND_CLIENT_SLACK_MS`) must end by the deadline, and a command's
 * TYPE leaves room for its Enter SUBMIT. Never above magmux's default 10 s, never below
 * `MIN_READY_TIMEOUT_MS` (`ENTER_MIN_READY_TIMEOUT_MS` for an Enter-only send).
 */
export function readyTimeoutFor(step: SubmitStep, line: string, leftMs: number): number | null {
  const reserve =
    step === "type" ? fixedSendMs("enter", line) + SEND_CLIENT_SLACK_MS + MIN_READY_TIMEOUT_MS : 0;
  const rt = Math.min(
    SEND_READY_WAIT_DEFAULT_MS,
    leftMs - fixedSendMs(step, line) - SEND_CLIENT_SLACK_MS - reserve
  );
  const floor = step === "enter" ? ENTER_MIN_READY_TIMEOUT_MS : MIN_READY_TIMEOUT_MS;
  return rt < floor ? null : Math.floor(rt);
}

/** What the screen showed of an earlier prompt's copy that may be unread, at the deadline. */
const EARLIER_COPY_SEEN: Record<DrawState, string> = {
  none: "it never showed",
  prefix: "only its start showed",
  changing: "it showed and was still changing",
};

/** What a deadline detail adds while the box stayed empty after a send (`awaitDraw`). */
function stayedEmptyNote(adm: { awaitingDraw: number | null; drawState: DrawState }): string {
  if (adm.awaitingDraw === null) return "";
  switch (adm.drawState) {
    case "none":
      return " (the input box stayed empty: Claude Code drew none of the typed text, so it was neither cleared nor typed again)";
    case "prefix":
      return " (the input box was empty after typing, then showed text ending in the start of the typed text, its rest perhaps unread, at the deadline, so no key was sent)";
    case "changing":
      return " (the input box was empty after typing, then showed text that was still changing at the deadline, so no key was sent)";
    default:
      return assertNever(adm.drawState);
  }
}

/** An admission's detail when no gated send of it was answered. */
function noReplyNote(
  adm: {
    attempts: number;
    awaitingDraw: number | null;
    drawState: DrawState;
    leftoverOf: string | null;
    recordWaitFrom?: number | null;
  },
  gate: GateInput | null
): string {
  const g = gate ? (gate.ready ? "ready" : (gate.reason ?? "not ready")) : "unknown";
  if (adm.leftoverOf !== null && adm.recordWaitFrom != null) {
    const s = Math.round((Date.now() - adm.recordWaitFrom) / 1000);
    return `nothing was typed: an earlier copy of this prompt left the input box, and its transcript record did not appear in ${s} s (gate: ${g})`;
  }
  if (adm.leftoverOf !== null && adm.awaitingDraw !== null)
    return `nothing was typed: the input box may still hold an earlier prompt's copy that Claude Code has not read (${EARLIER_COPY_SEEN[adm.drawState]}), and a new copy would queue behind it (gate: ${g})`;
  return adm.attempts === 0
    ? `no gated send fitted before the deadline (gate: ${g})`
    : `no magmux reply (gate: ${g})`;
}

/** The latest reply of an admission that ended with nothing submitted, in the gate's words. */
function describeLastReply(
  adm: {
    last: SendOutcome | null;
    attempts: number;
    awaitingDraw: number | null;
    drawState: DrawState;
    leftoverOf: string | null;
    recordWaitFrom?: number | null;
  },
  gate: GateInput | null
): string {
  const o = adm.last;
  if (!o) return noReplyNote(adm, gate);
  switch (o.kind) {
    case "busy":
      return `last magmux reply: busy ${o.reason || "unknown"}${o.typed ? " (typed, Enter withheld)" : ""}${gate?.detail ? ` (${gate.detail})` : ""}`;
    case "not_accepted":
      return `last magmux reply: not_accepted ${o.reason}${stayedEmptyNote(adm)}`;
    case "accepted":
      return `last magmux reply: ok ${o.accept} (${o.evidence})`;
    case "in_box":
      return "last magmux reply: in_box (the command was typed, its Enter never sent)";
    case "bad_request":
      return `last magmux reply: bad_request ${o.error}`;
    case "reply_lost":
    case "unsent":
    case "pane_gone":
      return `last magmux reply: ${o.code}`;
    case "unexpected":
      return `last magmux reply: ${o.code}`;
    default:
      return assertNever(o);
  }
}

/** The verdict note of a conclusion on the exit path. */
function exitNoteOf(code: number | null): string {
  return `pane child exited${code === null ? "" : ` ${code}`}`;
}

function isControl(text: string): boolean {
  const t = text.trim();
  return t === "/exit" || t === "/quit";
}

/** The question or dialog text a block reports to the owner. */
function blockText(pending: { name: string; input?: unknown }, dialog: string | null): string {
  if (pending.name === "AskUserQuestion") {
    const qs = (pending.input as { questions?: Array<{ question?: unknown }> } | undefined)
      ?.questions;
    const text = (qs ?? [])
      .map((q) => (typeof q.question === "string" ? q.question : ""))
      .filter(Boolean);
    if (text.length) return text.join("\n");
  }
  return dialog ?? pending.name;
}

/* ───────────────────────────── the entry point ───────────────────────────── */

export class PaneStartError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

interface PreparedPane {
  paneId: string;
  sockPath: string;
  cwd: string;
  ctlDir: string;
  turnDir: string;
  magmuxEnv: Record<string, string>;
}

/** Ids, dirs, launcher and environment. Nothing is spawned; on a throw the dirs are removed. */
function preparePane(
  o: PaneSessionOptions,
  root: string,
  parentEnv: Record<string, string | undefined>
): PreparedPane {
  let dirs: { ctlDir: string; turnDir: string } | null = null;
  try {
    const paneId = mintPaneId(o.kind, o.label);
    const sockPath = sockPathOf(root, paneId);
    const cwd = realpathSync(o.cwd);
    const launch = o.claudishSpawn ?? resolveClaudishLaunch(parentEnv);
    dirs = createLaunchDirs(root);
    const argv = buildClaudishPaneArgv(
      o.spawnModel,
      o.sessionUuid,
      dirs.turnDir,
      o.callerFlags,
      o.spawnPinned === true
    );
    writeLauncherFiles(dirs.ctlDir, launcherScript(cwd, launch, argv));
    const { magmuxEnv } = buildPaneEnv({
      parentEnv,
      slotEnv: o.slotEnv,
      cwd,
      ctlDir: dirs.ctlDir,
      configFile: getConfigFileOverride(),
      ...launchSize(o),
    });
    return { paneId, sockPath, cwd, ...dirs, magmuxEnv };
  } catch (e) {
    for (const d of dirs ? [dirs.ctlDir, dirs.turnDir] : [])
      if (isLaunchDirPath(root, d)) rmSync(d, { recursive: true, force: true });
    if ((e as { code?: string }).code) throw e;
    throw new PaneStartError("pane_lost", e instanceof Error ? e.message : String(e));
  }
}

/**
 * Start a pane session. Throws `MagmuxUnavailableError`, `PaneLimitError` or
 * `PaneStartError` BEFORE anything is spawned; installs the shutdown hooks (idempotent).
 */
export async function startPaneSession(o: PaneSessionOptions): Promise<PaneSession> {
  const parentEnv = o.parentEnv ?? process.env;
  let took = false;
  let magmux: { binary: string };
  let root: string;
  try {
    if (SUBCOMMAND_WORDS.includes(o.spawnModel))
      throw new PaneStartError(
        "invalid_args",
        `model "${o.spawnModel}" is a claudish subcommand name`
      );
    magmux = await assertMagmuxAvailable(o.magmuxBinary);
    root = ensureSockRoot(o.sockRoot ?? sockRootFor(parentEnv));
    await ensureSwept(root);
    if (!paneShutdownHooksInstalled()) installPaneShutdownHooks();
    // a reservation the owner made for this run, else our own (which checks the limit); the
    // record is written before the next await, so the pane is never uncounted
    took = takePaneReservation();
    if (!took) {
      reservePanes(1, root);
      took = takePaneReservation();
    }
  } catch (e) {
    // A start that fails before it took its reservation still uses up the one its owner
    // made for it, so an owner that reserved N panes never leaks the count.
    if (!took) takePaneReservation();
    throw e;
  }
  const p = preparePane(o, root, parentEnv);
  try {
    writeRecord(root, {
      paneId: p.paneId,
      ownerPid: process.pid,
      ownerStart: ownerStartOfSelf(),
      watcherPid: null,
      magmuxPid: null,
      panePid: null,
      sessionUuid: o.sessionUuid,
      sockPath: p.sockPath,
      launcherDir: p.ctlDir,
      turnDir: p.turnDir,
      createdAt: new Date().toISOString(),
    });
  } catch (e) {
    // nothing was spawned: remove the dirs preparePane made (validated paths only)
    removePaneFiles(root, {
      paneId: p.paneId,
      sockPath: p.sockPath,
      launcherDir: p.ctlDir,
      turnDir: p.turnDir,
    });
    throw new PaneStartError("pane_lost", `cannot write the pane record: ${String(e)}`);
  }
  const session = new PaneSessionImpl(o, {
    paneId: p.paneId,
    sockPath: p.sockPath,
    root,
    ctlDir: p.ctlDir,
    turnDir: p.turnDir,
  });
  registerPane(session);
  await session.start({ magmuxBinary: magmux.binary, env: p.magmuxEnv, cwd: p.cwd });
  return session;
}
