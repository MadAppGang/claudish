/**
 * `InteractiveDriver`: session hooks for `claudish -i` (hook-system architecture §7.5).
 *
 * In `wrap` mode claudish launched a visible `-w` magmux and Claude Code is pane 0. In
 * `ambient` mode claudish runs inside a magmux someone else started (a `team --grid`
 * pane, a pane the user opened) and its pane is found by process ancestry
 * (`pane/own-pane.ts`). Either way the driver is a SECOND client on that socket (S2,
 * measured: `watch` frames and `send {typed:true}` both work there), and it is the only
 * part of claudish that types into the human's session.
 *
 * What it does, per turn:
 *
 *   - **Turns.** One `TranscriptFollower` on the session's transcript. The first turn
 *     opens at offset 0 with the HUMAN witness, so a prompt given on the command line,
 *     which Claude Code may write before the REPL is drawn, is witnessed. After each
 *     settle the next turn opens at the current offset with the same witness; an
 *     injected turn uses the `text` witness of the line it typed. The human witness is
 *     matched by provenance (`isHumanPrompt`): a task notification never matches it,
 *     so a background re-wake (D23) stays the turn it woke — it never makes a pending
 *     injection stale and never resets the cap.
 *   - **Settle.** `decideSettle`, with the same screen facts as a pane. The phase is the
 *     latch: one `binding.settle()` per settled turn, `SETTLING` while it runs, and a
 *     re-wake or a human prompt during the hold ends it (`rewake`, `caller`).
 *   - **Delivery gate.** An injection is typed only when the turn is idle, the box is
 *     drawn, empty, and has not changed for `typingHoldMs` (1,500 ms), no dialog or
 *     working row shows, no menu is open, and the recovery banner holds no lease. It is
 *     ONE `send {typed:true, enter:true}` of a plain line, or of the instruction to Read
 *     a turn file in the `--add-dir` turn directory. Never Esc, never into a dialog. The
 *     residual race — a keystroke landing between the last check and the send — is
 *     accepted: magmux has no atomic "send if empty".
 *   - **Acceptance.** The typed line's witness must appear within `acceptMs` (30 s),
 *     else the injection is dropped `send_not_accepted`.
 *   - **Session events.** `sessionStart` at the first empty REPL box; `sessionBlocked`
 *     on a question or a permission dialog; `sessionEnd` from `stop()`, which the
 *     launcher awaits for at most 1.5 s.
 *   - **Session id.** The minted `--session-id` from boot; then whatever id the proxy's
 *     requests carry (`InProcessSink.onSessionId`), so `/clear` retargets the follower
 *     and a `--resume`d launch finds its transcript. Until an id is known the driver
 *     opens no turn and types nothing; queued injections wait under the 10-minute rule.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { log, logStderr } from "../../logger.js";
import { MagmuxClient } from "../../pane/magmux-client.js";
import { findOwnPane } from "../../pane/own-pane.js";
import {
  type Delivery,
  deliveryRefusal,
  planDelivery,
  writeTurnFile,
} from "../../pane/prompt-delivery.js";
import {
  choiceDialog,
  hasChoiceDialog,
  inputBox,
  isWorking,
  readBoot,
} from "../../pane/screen-classifier.js";
import {
  type MagmuxFrame,
  type ScreenState,
  applyFrame,
  emptyScreen,
} from "../../pane/screen-model.js";
import {
  CORROBORATION_MS,
  SECONDARY_QUIET_MS,
  type ScreenFacts,
  decideSettle,
} from "../../pane/settle-rule.js";
import {
  TranscriptFollower,
  type TranscriptView,
  type TurnDelivery,
  type TurnView,
  type Witness,
  lastHumanPromptOffset,
} from "../../pane/transcript-follower.js";
import { transcriptPathFor } from "../../session/session-discovery.js";
import type { HookEngine } from "../engine.js";
import {
  type HookQueueItem,
  type InjectionQueueState,
  afterAdmission,
  emptyQueueState,
  hookCount,
  next as nextQueueDecision,
} from "../injection/queue.js";
import { type InProcessSink, reportInjectionUnavailable } from "../injection/sinks.js";
import type { SessionInfo } from "../public.js";
import {
  type HoldAbortReason,
  type HoldInjection,
  type HoldResult,
  type SessionHookBinding,
  createSessionHookBinding,
} from "./binding.js";

/** The box must have been empty and unchanged this long before an injection is typed. */
export const TYPING_HOLD_MS = 1_500;
/** The typed line's witness must appear within this long. */
export const ACCEPT_TIMEOUT_MS = 30_000;
/** `sessionEnd` hooks get at most this long before the launcher shuts its proxy down. */
export const SESSION_END_WAIT_MS = 1_500;
const TICK_MS = 250;
const WATCH_FPS = 4;
/** The REPL box must read empty this long before `sessionStart` fires. */
const REPL_STABLE_MS = 500;
/** How long a session id learned from a request may wait for its transcript to appear. */
const RETARGET_WAIT_MS = 10_000;
/** How long a lost send reply waits for `reconnect()` before the admission fails. */
const RECONNECT_WAIT_MS = 10_000;
const DEFAULT_MAX_CONSECUTIVE = 3;

/* ───────────────────────────── the turn phase ───────────────────────────── */

/**
 * The driver's turn phase. Unlike a pane it never ends the session: Claude Code is the
 * human's, and claudish only waits, reads and (rarely) types.
 *
 *   NONE       no session id known yet: nothing is followed
 *   OPEN       a human-witness turn is open and not yet accepted: the session is idle
 *   ADMITTING  an injection was typed; its text witness is awaited
 *   RUNNING    the turn was accepted and has not settled
 *   SETTLING   settled and recorded; `binding.settle()` runs (the latch)
 *   STOPPED    Claude Code exited, or the launcher stopped the driver
 */
export type DriverPhase = "NONE" | "OPEN" | "ADMITTING" | "RUNNING" | "SETTLING" | "STOPPED";

type DriverEvent =
  | "session_known"
  | "human_accepted"
  | "deliver"
  | "hook_accepted"
  | "admit_failed"
  | "settle_open"
  | "settle_hold"
  | "hold_done"
  | "rewake"
  | "retarget"
  | "stop";

const EDGES = {
  NONE: { session_known: "OPEN", stop: "STOPPED" },
  OPEN: {
    human_accepted: "RUNNING",
    deliver: "ADMITTING",
    rewake: "RUNNING",
    retarget: "OPEN",
    stop: "STOPPED",
  },
  ADMITTING: {
    hook_accepted: "RUNNING",
    admit_failed: "OPEN",
    retarget: "OPEN",
    stop: "STOPPED",
  },
  RUNNING: { settle_open: "OPEN", settle_hold: "SETTLING", retarget: "OPEN", stop: "STOPPED" },
  SETTLING: {
    hold_done: "OPEN",
    rewake: "RUNNING",
    human_accepted: "RUNNING",
    retarget: "OPEN",
    stop: "STOPPED",
  },
  STOPPED: {},
} as const satisfies Record<DriverPhase, Partial<Record<DriverEvent, DriverPhase>>>;

/** The next phase, or null when `ev` is not legal from `phase`. */
export function nextDriverPhase(phase: DriverPhase, ev: DriverEvent): DriverPhase | null {
  const row = EDGES[phase] as Partial<Record<DriverEvent, DriverPhase>>;
  return row[ev] ?? null;
}

/* ───────────────────────────── options ───────────────────────────── */

export interface InteractiveDriverOptions {
  mode: "wrap" | "ambient";
  /** the wrap's `--id` control socket, or the ambient `MAGMUX_SOCK` */
  sockPath: string;
  /** Claude Code's pane: 0 in a wrap. Absent → found by ancestry (ambient). */
  pane?: number;
  /** test seam for the ancestry search; `list` returns the `list` reply's result */
  findPane?: (list: () => Promise<unknown>) => Promise<number | null>;
  /** Claude Code's working directory (the transcript slug is its realpath) */
  cwd: string;
  /** the minted or user-given `--session-id`; null after `--resume`/`--continue`/`--fork-session` */
  sessionId: string | null;
  /** Claude Code's projects directory (`projectsDir(childEnv)`) */
  projectsRoot: string;
  /** the `--add-dir` turn directory (0700) where long injections are written */
  turnDir: string;
  /** false when Claude Code's flags remove the Read tool */
  readAvailable: boolean;
  /** the model as the user asked for it (`ctx.session.model`) */
  model: string;
  /** the launcher's in-process sink: proxy-event lines and request session ids */
  sink: InProcessSink;
  /** the engine a binding is built over; ignored when `binding` is given */
  engine?: HookEngine;
  /** test seam: any `SessionHookBinding` */
  binding?: SessionHookBinding;
  /** the recovery banner holds the pane (`recoveryOverlayHeld`) */
  overlayHeld?: () => boolean;
  /** stderr, for the one-line "unavailable" notices */
  warn?: (line: string) => void;
  /** test seams; production passes none */
  timings?: {
    tickMs?: number;
    typingHoldMs?: number;
    acceptMs?: number;
    replStableMs?: number;
    secondaryQuietMs?: number;
    corroborationMs?: number;
    connectMs?: number;
  };
}

/** What the driver can tell a test or the debug log about itself. */
export interface DriverSnapshot {
  phase: DriverPhase;
  pane: number | null;
  sessionId: string | null;
  booted: boolean;
  turnIndex: number;
  settles: number;
  callerAdmitted: number;
  consecutiveHookTurns: number;
  pendingHookInputs: number;
  available: boolean;
}

interface OpenTurn {
  index: number;
  offset: number;
  witness: Witness;
  delivery: TurnDelivery | null;
  hookCaused: boolean;
}

interface Admission {
  item: HookQueueItem;
  startedAt: number;
}

/* ───────────────────────────── the driver ───────────────────────────── */

export class InteractiveDriver {
  private phase: DriverPhase = "NONE";
  private readonly o: InteractiveDriverOptions;
  private readonly binding: SessionHookBinding;
  private readonly warn: (line: string) => void;
  private client: MagmuxClient | null = null;
  private pane: number | null;
  private screen: ScreenState = emptyScreen(160, 50);
  private framePending = false;
  private follower: TranscriptFollower | null = null;
  private sessionId: string | null;
  /** ids this driver followed and left (`/clear`): a late request naming one is ignored */
  private readonly retired = new Set<string>();
  private pendingSid: { id: string; since: number } | null = null;

  private q: InjectionQueueState;
  private current: OpenTurn | null = null;
  /** the turn that settled last, kept so a re-wake can re-open it */
  private settledTurn: OpenTurn | null = null;
  private lastAcceptedIndex = 0;
  private fileSeq = 0;
  private admission: Admission | null = null;
  private settles = 0;
  private blockedToolId: string | null = null;

  private booted = false;
  private bootKind: string | null = null;
  private bootKindSince = 0;
  private startCallerSeq = 1;

  private holdGen = 0;
  private holdController: AbortController | null = null;
  private holdWatchdog: ReturnType<typeof setTimeout> | null = null;

  private lastBoxKey: string | null = null;
  private boxChangedAt = Date.now();
  private lastPollAt = 0;
  private lastChatOffset: number | null = null;
  private lastChatSeenAt = Date.now();
  private readonly startedAt = Date.now();

  private ticker: ReturnType<typeof setInterval> | null = null;
  private unsubscribeSession: (() => void) | null = null;
  private unavailable = false;
  private stopping: Promise<void> | null = null;

  constructor(o: InteractiveDriverOptions) {
    this.o = o;
    this.warn = o.warn ?? logStderr;
    this.pane = o.pane ?? null;
    this.sessionId = o.sessionId;
    const session: SessionInfo = {
      kind: "interactive",
      role: null,
      id: o.sessionId ?? "",
      claudeSessionId: o.sessionId,
      model: o.model,
      cwd: o.cwd,
      shape: "interactive",
      injection: "available",
    };
    if (o.binding) this.binding = o.binding;
    else if (o.engine) this.binding = createSessionHookBinding(o.engine, session, o.sink.inbox);
    else throw new Error("InteractiveDriver needs an engine or a binding");
    this.q = emptyQueueState(this.binding.maxConsecutive ?? DEFAULT_MAX_CONSECUTIVE);
    this.binding.attach?.({
      queueInjections: (items) => this.step(() => this.queueInjections(items)),
    });
  }

  /* ───────────────────────────── lifecycle ───────────────────────────── */

  /**
   * Connect, find the pane, subscribe to its frames and start following. Never throws:
   * a driver that cannot reach its pane makes injection `unavailable` (one stderr line)
   * and still fires `sessionStart` and `sessionEnd`.
   */
  async start(): Promise<void> {
    this.unsubscribeSession = this.o.sink.onSessionId((sid) =>
      this.step(() => this.noteRequestSession(sid))
    );
    if (this.sessionId) this.follow(this.sessionId, 0);
    try {
      this.client = await MagmuxClient.connect(this.o.sockPath, {
        timeoutMs: this.o.timings?.connectMs ?? 10_000,
        alive: () => this.phase !== "STOPPED",
      });
    } catch (err) {
      this.goUnavailable(`cannot reach magmux at ${this.o.sockPath}: ${String(err)}`);
      return;
    }
    if (this.currentPhase() === "STOPPED") {
      this.client.close();
      return;
    }
    if (this.pane === null) {
      const client = this.client;
      const list = async () => {
        const r = await client.request({ type: "list" });
        return r.ok ? r.result : null;
      };
      this.pane = await (this.o.findPane ?? ((l) => findOwnPane(l)))(list);
      if (this.pane === null) {
        this.goUnavailable("this claudish's magmux pane was not found");
        return;
      }
    }
    await this.subscribe(this.client);
    this.ticker = setInterval(() => this.step(() => this.evaluate()), this.ms("tickMs", TICK_MS));
    log(
      `[hooks] interactive driver on magmux pane ${this.pane} (${this.o.mode}), session ${this.sessionId ?? "(not known yet)"}`
    );
  }

  /**
   * Claude Code exited (or the launcher is shutting down): end any hold, drop what is
   * queued, fire `sessionEnd` and wait for it at most `SESSION_END_WAIT_MS`. Idempotent.
   */
  stop(outcome: { state: string; reason: string | null; exitCode: number | null }): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      this.step(() => {
        if (this.phase === "SETTLING") this.endHold("terminal");
        this.admission = null;
        this.transition("stop");
        for (const item of this.q.items)
          if (item.kind === "hook") this.dropInjection(item, "session_ended");
        this.q.items = [];
      });
      if (this.ticker) clearInterval(this.ticker);
      this.ticker = null;
      this.unsubscribeSession?.();
      this.o.sink.markUnavailable();
      try {
        this.binding.fireEnd(outcome);
      } catch {
        // a binding's failure must not hold the launcher
      }
      await raceTimeout(this.binding.endSettled?.() ?? Promise.resolve(), SESSION_END_WAIT_MS);
      // what no settle took is journaled before the launcher shuts its proxy down
      try {
        this.binding.sweepInbox?.();
      } catch {
        // journaling never holds the launcher
      }
      this.client?.close();
      this.client = null;
    })();
    return this.stopping;
  }

  snapshot(): DriverSnapshot {
    return {
      phase: this.phase,
      pane: this.pane,
      sessionId: this.sessionId,
      booted: this.booted,
      turnIndex: this.current?.index ?? this.lastAcceptedIndex,
      settles: this.settles,
      callerAdmitted: this.q.callerAdmitted,
      consecutiveHookTurns: this.q.consecutiveHookTurns,
      pendingHookInputs: hookCount(this.q),
      available: !this.unavailable,
    };
  }

  private goUnavailable(why: string): void {
    this.unavailable = true;
    this.o.sink.markUnavailable();
    log(`[hooks] interactive driver: ${why}; hook injection is unavailable for this session`);
    reportInjectionUnavailable(this.warn);
    this.binding.updateSession?.({ injection: "unavailable" });
    // No screen to find the REPL box on: the session started when Claude Code did.
    this.fireStart();
  }

  private async subscribe(client: MagmuxClient): Promise<void> {
    const pane = this.pane as number;
    client.on("frame", (f: MagmuxFrame) => {
      if (f.pane !== undefined && f.pane !== pane) return;
      this.screen = applyFrame(this.screen, f);
      this.framePending = true;
      this.noteBox();
      this.step(() => this.evaluate());
    });
    client.on("disconnected", () => {
      if (this.client === client) this.client = null;
      if (this.phase !== "STOPPED") void this.reconnect();
    });
    const r = await client.request({ type: "watch", pane, mode: "frames", fps: WATCH_FPS });
    if (!r.ok) log(`[hooks] interactive driver: watch pane ${pane} refused: ${r.code} ${r.error}`);
  }

  /** magmux keeps its panes when a client leaves: redial while the session lives. */
  private async reconnect(): Promise<void> {
    let delay = 100;
    for (let i = 0; i < 20 && this.phase !== "STOPPED" && !this.client; i++) {
      await Bun.sleep(delay);
      try {
        const c = await MagmuxClient.dial(this.o.sockPath);
        if (this.currentPhase() === "STOPPED") {
          c.close();
          return;
        }
        this.client = c;
        await this.subscribe(c);
        return;
      } catch {
        delay = Math.min(1_000, delay * 2);
      }
    }
  }

  /* ───────────────────────────── the step ───────────────────────────── */

  private step(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      // The driver must never take the launcher down with it.
      log(
        `[hooks] interactive driver step failed: ${err instanceof Error ? err.stack : String(err)}`
      );
    }
  }

  /** The phase, read through a call so a narrowing from an earlier check never sticks. */
  private currentPhase(): DriverPhase {
    return this.phase;
  }

  private transition(ev: DriverEvent): boolean {
    const next = nextDriverPhase(this.phase, ev);
    if (!next) {
      log(`[hooks] interactive driver: illegal ${this.phase} --${ev}`);
      return false;
    }
    this.phase = next;
    return true;
  }

  private ms(key: keyof NonNullable<InteractiveDriverOptions["timings"]>, dflt: number): number {
    return this.o.timings?.[key] ?? dflt;
  }

  /* ───────────────────────────── the session id ───────────────────────────── */

  /** Start following `sid`'s transcript, with the first turn at `offset`. */
  private follow(sid: string, offset: number): void {
    const path = transcriptPathFor(this.o.cwd, sid, this.o.projectsRoot);
    this.follower = new TranscriptFollower(path, join(path.replace(/\.jsonl$/, ""), "subagents"));
    this.sessionId = sid;
    this.settledTurn = null;
    this.lastPollAt = Date.now();
    this.binding.updateSession?.({ id: sid, claudeSessionId: sid });
    // From a mid-file offset the follower must start reading THERE, not at byte 0.
    this.openHumanTurn(offset, offset > 0);
    if (this.phase === "NONE") this.transition("session_known");
  }

  /** A proxy request named `sid`: a `/clear`, or the session of a resumed launch. */
  private noteRequestSession(sid: string): void {
    if (this.phase === "STOPPED" || sid === this.sessionId || this.retired.has(sid)) return;
    if (this.pendingSid?.id !== sid) this.pendingSid = { id: sid, since: Date.now() };
    this.tryRetarget();
  }

  /**
   * Follow the pending session id once its transcript exists. The turn opens at its
   * last human prompt: Claude Code writes the prompt before the request that names the
   * session, so that prompt is the running turn's witness.
   */
  private tryRetarget(): void {
    const p = this.pendingSid;
    if (!p) return;
    const path = transcriptPathFor(this.o.cwd, p.id, this.o.projectsRoot);
    if (!existsSync(path)) {
      if (Date.now() - p.since > RETARGET_WAIT_MS) {
        log(`[hooks] interactive driver: no transcript for session ${p.id}; not following it`);
        this.pendingSid = null;
      }
      return;
    }
    this.pendingSid = null;
    if (this.phase === "SETTLING") this.endHold("caller");
    if (this.admission) {
      this.dropInjection(this.admission.item, "stale");
      this.admission = null;
    }
    if (this.sessionId) this.retired.add(this.sessionId);
    log(`[hooks] interactive driver: following session ${p.id}`);
    const offset = lastHumanPromptOffset(path) ?? fileSizeOf(path);
    const wasNone = this.phase === "NONE";
    this.follow(p.id, offset);
    if (!wasNone && this.phase !== "OPEN") this.transition("retarget");
  }

  /* ───────────────────────────── evaluation ───────────────────────────── */

  private pollFollower(force = false): TranscriptView | null {
    const f = this.follower;
    if (!f) return null;
    const now = Date.now();
    if (force || this.framePending || now - this.lastPollAt >= 1_000) {
      f.poll();
      this.lastPollAt = now;
      this.framePending = false;
    }
    const view = f.view();
    const off = view.current?.lastChatOffset ?? null;
    if (off !== this.lastChatOffset) {
      this.lastChatOffset = off;
      this.lastChatSeenAt = now;
    }
    return view;
  }

  private evaluate(): void {
    if (this.phase === "STOPPED") return;
    if (this.pendingSid) this.tryRetarget();
    this.checkBoot();
    const view = this.pollFollower();
    if (!view) return;
    const t = view.current;
    // Read after the steps above, any of which can move the phase.
    const phase: DriverPhase = this.currentPhase();
    switch (phase) {
      case "NONE":
      case "STOPPED":
        return;
      case "OPEN":
        if (t?.acceptedAt) this.humanAccepted();
        else if (this.settledTurn && t?.unwitnessedChatOffset != null) this.rewake();
        else this.pump();
        return;
      case "ADMITTING":
        this.evalAdmission(t);
        return;
      case "RUNNING":
        this.evalRunning(view);
        return;
      case "SETTLING":
        if (t?.acceptedAt) {
          // A human prompt during the hold ends it at once: the human goes first (rule 3).
          this.endHold("caller");
          this.humanAccepted();
        } else if (t?.unwitnessedChatOffset != null) {
          this.endHold("rewake");
          this.rewake();
        }
        return;
      default:
        assertNeverPhase(phase);
    }
  }

  /** `sessionStart` fires at the first empty REPL box, held stable for `replStableMs`. */
  private checkBoot(): void {
    if (this.booted || this.unavailable || this.screen.seq === 0) return;
    const r = readBoot(this.screen);
    const now = Date.now();
    if (r.kind !== this.bootKind) {
      this.bootKind = r.kind;
      this.bootKindSince = now;
    }
    if (r.kind === "repl" && now - this.bootKindSince >= this.ms("replStableMs", REPL_STABLE_MS)) {
      this.booted = true;
      this.fireStart();
    }
  }

  private fireStart(): void {
    // The session's first human turn counts as its initial prompt (§4.7 rule 3): a
    // `sessionStart` injection survives it, whether it was given on the command line
    // (already admitted here) or typed after the box appeared.
    this.startCallerSeq = Math.max(1, this.q.callerAdmitted);
    try {
      this.binding.fireStart();
    } catch {
      // a binding's failure must not break the driver
    }
  }

  private openHumanTurn(offset: number, readFromOffset = false): void {
    const turn: OpenTurn = {
      index: this.lastAcceptedIndex + 1,
      offset,
      witness: { kind: "human" },
      delivery: null,
      hookCaused: false,
    };
    if (readFromOffset) this.follower?.rewindTo(turn);
    else this.follower?.openTurn(turn);
    this.current = turn;
    this.blockedToolId = null;
  }

  /** Close what the follower has read so far, then open a human turn at its end. */
  private openHumanTurnHere(): void {
    this.follower?.poll();
    this.lastPollAt = Date.now();
    this.openHumanTurn(this.follower?.size() ?? 0);
  }

  private humanAccepted(): void {
    const cur = this.current;
    if (!cur) return;
    // Rule 3 and the cap: a human turn is a caller admission. Hook items queued before it
    // are stale, and the run of hook-caused turns ends.
    Object.assign(this.q, afterAdmission(this.q, { kind: "caller", text: "" }));
    this.lastAcceptedIndex = cur.index;
    this.lastChatSeenAt = Date.now();
    this.transition("human_accepted");
  }

  /**
   * A background notification woke the model after its turn settled (D23). The driver
   * had opened the next turn, which the notification does not witness, so the settled
   * turn is re-opened from its own offset and runs on as the SAME turn: no caller
   * admission, no cap reset, the same index when it settles again.
   */
  private rewake(): void {
    const turn = this.settledTurn;
    if (!turn || !this.follower) return;
    this.follower.rewindTo(turn);
    this.current = turn;
    this.lastChatSeenAt = Date.now();
    this.transition("rewake");
  }

  private evalAdmission(t: TurnView | null): void {
    const adm = this.admission;
    if (!adm) return;
    if (t?.acceptedAt) {
      this.admission = null;
      this.lastAcceptedIndex = this.current?.index ?? this.lastAcceptedIndex + 1;
      this.lastChatSeenAt = Date.now();
      this.transition("hook_accepted");
      return;
    }
    if (Date.now() - adm.startedAt >= this.ms("acceptMs", ACCEPT_TIMEOUT_MS))
      this.admitFailed("no witness in time");
  }

  private admitFailed(why: string): void {
    const adm = this.admission;
    if (!adm || this.phase !== "ADMITTING") return;
    this.admission = null;
    log(`[hooks] interactive driver: injection not accepted (${why})`);
    this.dropInjection(adm.item, "send_not_accepted");
    this.openHumanTurnHere();
    this.transition("admit_failed");
  }

  private screenFacts(): ScreenFacts | null {
    if (!this.client) return null;
    const box = inputBox(this.screen);
    return {
      boxEmpty: !!box && box.text === "",
      choiceDialog: hasChoiceDialog(this.screen),
      working: isWorking(this.screen),
      aboveBoxQuietMs: Date.now() - this.screen.aboveBoxChangedAt,
    };
  }

  private evalRunning(view: TranscriptView): void {
    const t = view.current;
    if (!t) return;
    this.checkBlocked(t);
    const now = Date.now();
    const decision = decideSettle({
      turn: t,
      session: view.session,
      transcriptQuietMs: now - (view.lastAppendAt ?? this.startedAt),
      chatQuietMs: now - this.lastChatSeenAt,
      screen: this.screenFacts(),
      paneExited: false,
      secondaryQuietMs: this.ms("secondaryQuietMs", SECONDARY_QUIET_MS),
      corroborationMs: this.ms("corroborationMs", CORROBORATION_MS),
    });
    if (decision.settled) this.record(t, decision.by === "local_command", decision.stopReason);
  }

  /** `sessionBlocked`, once per blocking tool: a question, or a permission/plan dialog. */
  private checkBlocked(t: TurnView): void {
    const pending = t.pendingTool;
    if (!pending) {
      this.blockedToolId = null;
      return;
    }
    if (pending.id === this.blockedToolId) return;
    let kind: "question" | "permission" | null = null;
    if (pending.name === "AskUserQuestion") kind = "question";
    else if (this.client && hasChoiceDialog(this.screen)) kind = "permission";
    if (!kind) return;
    this.blockedToolId = pending.id;
    const text = choiceDialog(this.screen)?.text ?? pending.name;
    try {
      this.binding.fireBlocked({ kind, text });
    } catch {
      // observe-only
    }
  }

  /* ───────────────────────────── settle, hold ───────────────────────────── */

  /**
   * The turn settled: open the next (human) turn at the current offset, then hold for
   * the session hooks when they have work, else go straight to OPEN.
   */
  private record(t: TurnView, localCommand: boolean, stopReason: string | null): void {
    const cur = this.current;
    if (!cur) return;
    this.settles++;
    this.settledTurn = cur;
    const info = {
      index: cur.index,
      answer: localCommand ? (t.localCommandOutput ?? "") : t.assistantText.join("\n\n"),
      stopReason,
      apiError: t.apiError !== null,
      hookCaused: cur.hookCaused,
      consecutiveHookTurns: this.q.consecutiveHookTurns,
      callerInputPending: false,
      shape: "interactive" as const,
    };
    this.openHumanTurnHere();
    let work = false;
    try {
      work = this.binding.hasIdleWork(hookCount(this.q) > 0);
    } catch {
      work = false;
    }
    if (!work) {
      this.transition("settle_open");
      this.pump();
      return;
    }
    this.startHold(info);
  }

  private startHold(info: Parameters<SessionHookBinding["settle"]>[0]): void {
    this.holdGen++;
    const gen = this.holdGen;
    this.transition("settle_hold");
    const ctl = new AbortController();
    this.holdController = ctl;
    let bound: number;
    try {
      bound = this.binding.holdBoundMs();
    } catch {
      bound = 0;
    }
    let p: Promise<HoldResult>;
    try {
      p = Promise.resolve(this.binding.settle(info, ctl.signal));
    } catch (e) {
      p = Promise.reject(e);
    }
    p.catch((err: unknown) => ({ injections: [], error: String(err) }) as HoldResult)
      .then((r) => this.step(() => this.completeHold(gen, r)))
      .catch(() => {});
    this.holdWatchdog = setTimeout(
      () => this.step(() => this.completeHold(gen, { injections: [], error: "watchdog" })),
      Math.max(0, bound)
    );
  }

  /** End the hold without its result; the binding acts on `reason` (§4.7 rule 12). */
  private endHold(reason: HoldAbortReason): void {
    this.holdGen++;
    if (this.holdWatchdog) clearTimeout(this.holdWatchdog);
    this.holdWatchdog = null;
    const ctl = this.holdController;
    this.holdController = null;
    if (ctl && !ctl.signal.aborted) ctl.abort(reason);
  }

  private completeHold(gen: number, r: HoldResult): void {
    if (gen !== this.holdGen || this.phase !== "SETTLING") return;
    for (const a of r.anomalies ?? []) log(`[hooks] interactive driver: ${a}`);
    // the last tick's poll can be up to a second old. A human prompt or a re-wake
    // that reached the transcript since ends the hold HERE, exactly as if a tick had seen
    // it during the hold, and the result goes back to the binding under that reason.
    const t = this.pollFollower(true)?.current;
    const ended: HoldAbortReason | null = t?.acceptedAt
      ? "caller"
      : t?.unwitnessedChatOffset != null
        ? "rewake"
        : null;
    if (ended) {
      // a settle still running (the watchdog fired) learns the reason through its signal
      this.endHold(ended);
      if (r.error === undefined) {
        try {
          this.binding.abandon?.(r, ended);
        } catch {
          // journaling never breaks the driver
        }
      }
      if (ended === "caller") this.humanAccepted();
      else this.rewake();
      return;
    }
    if (r.error !== undefined) {
      log(
        `[hooks] interactive driver: ${r.error === "watchdog" ? "hook_hold_watchdog" : `hook_hold_error ${r.error}`}`
      );
      this.endHold(r.error === "watchdog" ? "watchdog" : "error");
    } else {
      this.holdGen++;
      if (this.holdWatchdog) clearTimeout(this.holdWatchdog);
      this.holdWatchdog = null;
      this.holdController = null;
    }
    const now = Date.now();
    for (const i of r.injections) this.q.items.push(this.hookItemOf(i, now));
    this.transition("hold_done");
    this.pump();
  }

  /* ───────────────────────────── the queue and the gate ───────────────────────────── */

  /** `sessionStart` injections no hold took (the binding's `attach`). */
  private queueInjections(items: HoldInjection[]): void {
    if (this.phase === "STOPPED" || this.unavailable) {
      for (const i of items)
        this.dropInjection(i, this.unavailable ? "unavailable" : "session_ended");
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
      callerSeq: i.source === "sessionStart" ? this.startCallerSeq : this.q.callerAdmitted,
      source: i.source,
    };
  }

  /** As in a pane: typed text or a file, never a slash command. */
  private readonly canDeliver = (text: string): boolean =>
    !text.trimStart().startsWith("/") && deliveryRefusal(text, this.o.readAvailable) === null;

  /**
   * The delivery gate (§7.5). Every condition is read from the screen and the open
   * turn at this instant; nothing here waits.
   */
  private gateOpen(now: number): boolean {
    if (this.phase !== "OPEN" || !this.booted || this.unavailable) return false;
    if (!this.client || this.pane === null || !this.follower) return false;
    const t = this.follower.view().current;
    if (!t || t.acceptedAt !== null || t.unwitnessedChatOffset !== null) return false;
    const box = inputBox(this.screen);
    if (!box || box.text !== "" || box.menuOpen) return false;
    if (hasChoiceDialog(this.screen) || isWorking(this.screen)) return false;
    if (now - this.boxChangedAt < this.ms("typingHoldMs", TYPING_HOLD_MS)) return false;
    if (this.o.overlayHeld?.()) return false;
    return true;
  }

  /**
   * Read the transcript NOW, before the gate decides, and act on what it shows. A
   * human prompt or a re-wake written since the last tick moves the phase (the item stays
   * queued); typing on the strength of an older poll is typing over a running turn.
   * `deliver` takes its turn boundary from this same read.
   */
  private openTurnIdleNow(): boolean {
    if (this.phase !== "OPEN") return false;
    const t = this.pollFollower(true)?.current;
    if (t?.acceptedAt) {
      this.humanAccepted();
      return false;
    }
    if (this.settledTurn && t?.unwitnessedChatOffset != null) {
      this.rewake();
      return false;
    }
    return true;
  }

  /** The box's text (or its absence) changed: the typing hold restarts. */
  private noteBox(): void {
    const box = inputBox(this.screen);
    const key = box ? box.text : "\u0000none";
    if (key !== this.lastBoxKey) {
      this.lastBoxKey = key;
      this.boxChangedAt = Date.now();
    }
  }

  private pump(): void {
    if (this.q.items.length === 0) return;
    if (!this.openTurnIdleNow()) return;
    const now = Date.now();
    if (!this.gateOpen(now)) return;
    const d = nextQueueDecision(this.q, now, "IDLE", this.canDeliver);
    this.q.items = d.remaining;
    for (const { item, reason } of d.drop) this.dropInjection(item, reason);
    if (d.deliver?.kind === "hook") this.deliver(d.deliver);
  }

  private deliver(item: HookQueueItem): void {
    const follower = this.follower;
    const client = this.client;
    const pane = this.pane;
    if (!follower || !client || pane === null) return;
    Object.assign(this.q, afterAdmission(this.q, item));
    // the turn boundary is the read `openTurnIdleNow` just checked (same step)
    const offset = follower.size();
    const plan: Delivery = planDelivery(
      item.text,
      this.o.turnDir,
      ++this.fileSeq,
      this.o.readAvailable
    );
    if (plan.mode !== "typed" && plan.mode !== "file") {
      // canDeliver already refused anything else; a slash command is invalid at the action
      this.dropInjection(item, "delivery_unavailable");
      return;
    }
    try {
      writeTurnFile(plan);
    } catch (err) {
      log(`[hooks] interactive driver: turn file not written: ${String(err)}`);
      this.dropInjection(item, "delivery_unavailable");
      return;
    }
    const turn: OpenTurn = {
      index: this.lastAcceptedIndex + 1,
      offset,
      witness: plan.witness,
      delivery: plan.mode === "file" ? { file: plan.file, text: plan.fileContent } : null,
      hookCaused: true,
    };
    follower.openTurn(turn);
    this.current = turn;
    this.admission = { item, startedAt: Date.now() };
    try {
      this.binding.noteDelivered?.(item);
    } catch {
      // journaling never breaks delivery
    }
    this.transition("deliver");
    const adm = this.admission;
    void client
      .request({ type: "send", pane, text: plan.line, typed: true, enter: true }, 10_000)
      .then(async (r) => {
        if (r.ok || this.admission !== adm) return;
        // a lost REPLY is not a refusal. The line may already be typed, or typed
        // and entered; the screen and the transcript decide, as in a pane (`typeLine`).
        // Once it landed, the text witness accepts it within `acceptMs` as usual.
        const lost = r.code === "client_timeout" || r.code === "client_lost";
        if (lost && (await this.landedAfterLostReply(adm, pane, plan.line))) return;
        if (this.admission === adm)
          this.step(() => this.admitFailed(`send refused: ${r.code} ${r.error}`));
      });
  }

  /**
   * After a lost send reply: the line is in the box (its Enter was lost: press it now),
   * or it was submitted (its witness, or its echo above the box). False when neither.
   *
   * A lost reply can mean a lost connection, whose client delivers nothing more: the
   * screen is judged, and Enter sent, through the client connected NOW, after a frame
   * it delivered. Enter goes only while `adm` is still the pending admission, and only
   * its own reply, or the transcript and screen after it, says the line landed.
   */
  private async landedAfterLostReply(adm: Admission, pane: number, line: string): Promise<boolean> {
    const head = line.slice(0, 40);
    // Twice: the Enter itself can meet a connection that is closing.
    for (let attempt = 0; attempt < 2; attempt++) {
      const seen = this.screen.seq;
      const client = await this.connectedClient(RECONNECT_WAIT_MS);
      if (!client) return false;
      await this.frameAfter(seen, 1_000);
      if (!inputBox(this.screen)?.text.startsWith(head)) break;
      if (this.admission !== adm) return false;
      log("[hooks] interactive driver: send reply lost; the line is in the box, pressing Enter");
      const r = await client.request({ type: "send", pane, keys: ["enter"], enter: false }, 10_000);
      if (r.ok) return true;
      log(`[hooks] interactive driver: Enter after a lost reply: ${r.code} ${r.error}`);
    }
    const landed = this.submitted(head);
    if (landed) log("[hooks] interactive driver: send reply lost; the line was submitted");
    return landed;
  }

  /** The line starting with `head` was submitted: its witness, or its echo above the box. */
  private submitted(head: string): boolean {
    const t = this.pollFollower(true)?.current;
    return (
      (t?.acceptedAt ?? null) !== null || this.screen.lines.some((l) => l.startsWith(`❯ ${head}`))
    );
  }

  /** The client that is connected now, waiting up to `ms` for `reconnect()` to replace a lost one. */
  private async connectedClient(ms: number): Promise<MagmuxClient | null> {
    const end = Date.now() + ms;
    for (;;) {
      const c = this.client;
      if (c && !c.isClosed) return c;
      if (Date.now() >= end || this.phase === "STOPPED") return null;
      await Bun.sleep(25);
    }
  }

  /** Resolves once a frame newer than `seq` arrived, or after `ms`. */
  private frameAfter(seq: number, ms: number): Promise<void> {
    if (this.screen.seq !== seq) return Promise.resolve();
    return this.nextFrame(ms);
  }

  /** Resolves on the next frame, or after `ms`. */
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

  private dropInjection(item: { text: string; hookIds: string[] }, reason: string): void {
    log(`[hooks] interactive driver: hook_injection_dropped:${reason}`);
    try {
      this.binding.noteDropped?.(item, reason);
    } catch {
      // journaling never breaks the driver
    }
  }
}

function assertNeverPhase(p: never): never {
  throw new Error(`unhandled driver phase ${String(p)}`);
}

function fileSizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function raceTimeout(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    p.then(
      () => {
        clearTimeout(t);
        resolve();
      },
      () => {
        clearTimeout(t);
        resolve();
      }
    );
  });
}
