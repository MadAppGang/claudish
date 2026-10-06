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
 * channel session's own `timeoutMs`.
 */

import type { ChildProcess } from "node:child_process";
import { readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { waitForExit } from "../process-tree.js";
import { redactSecrets } from "../redact.js";
import type { CaptureResult, CaptureUnchanged, FailureReason, SlotState } from "./contract.js";
import { MagmuxClient, type MagmuxConnectError } from "./magmux-client.js";
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
  sockPathFor,
  sockRootFor,
  spawnPaneMagmux,
  spawnPaneWatcher,
  versionAtLeast,
  writeLauncherFiles,
} from "./pane-launch.js";
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
  unregisterPane,
  updateRecord,
  writeRecord,
} from "./pane-registry.js";
import {
  type GroupSnapshot,
  type PaneIdentity,
  groupCheck,
  isLaunchDirPath,
  liveEscaped,
  readProcessTableAsync,
  recordPathOf,
  verifiedGroupSnapshot,
} from "./process-identity.js";
import { type Delivery, planDelivery, writeTurnFile } from "./prompt-delivery.js";
import {
  agentRejectedLine,
  choiceDialog,
  hasChoiceDialog,
  inputBox,
  isWorking,
  readBoot,
  screenAnswer,
  screenErrorRows,
  screenText,
  stopHookRunning,
  transcriptSavingOff,
} from "./screen-classifier.js";
import {
  type MagmuxCapture,
  type MagmuxFrame,
  type ScreenState,
  applyFrame,
  emptyScreen,
} from "./screen-model.js";
import {
  CORROBORATION_MS,
  SECONDARY_QUIET_MS,
  type ScreenFacts,
  type SettleDecision,
  decideSettle,
} from "./settle-rule.js";
import {
  type Phase,
  type PhaseEvent,
  isTerminalPhase,
  nextPhase,
  wireState,
} from "./slot-state.js";
import { TranscriptFollower, type TranscriptView, type TurnView } from "./transcript-follower.js";
import type { FinalVerdict, PaneSnapshot, SettledTurn } from "./types.js";

export type { FinalVerdict, PaneSnapshot, SettledTurn } from "./types.js";

export const BOOT_TIMEOUT_MS = 90_000;
export const ADMIT_TIMEOUT_MS = 30_000;
/** Without a witness this long after delivery: re-press Enter, or enter degraded mode. */
export const RESEND_AFTER_MS = 10_000;
export const DEGRADED_ENTRY_MS = 10_000;
/** Degraded settle: no change above the box for 2 × this. */
export const SCREEN_SETTLE_QUIET_MS = 3_000;
/** A panel command's screen must have been up this long after delivery before Esc. */
const PANEL_SETTLE_MS = 500;
/** The REPL box must read empty this long before boot is ready. */
const REPL_STABLE_MS = 500;
/** A dialog or choice screen static this long blocks boot. */
const BOOT_STATIC_MS = 5_000;
const TICK_MS = 250;
/** research-magmux §6 recommends 2–4; 4 halves boot/witness latency at no idle cost. */
const WATCH_FPS = 4;
const POLL_BACKSTOP_MS = 1_000;
/** R3-M4: a `finishing` turn with a static screen for this many secondary windows. */
const TURN_END_MISSING_FACTOR = 3;
const MAX_ANOMALY_KEYS = 64;
/** Settled answers kept for `turnAnswer` (owners read the current or the last one). */
const KEPT_ANSWERS = 4;

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
  cwd: string;
  sessionUuid: string;
  /** transcriptPathFor(realpath cwd, sessionUuid, projectsDir(parentEnv)) — the caller derives it */
  transcriptPath: string;
  slotEnv: Record<string, string>;
  shape: "one-shot" | "interactive";
  /** enqueued before boot; delivered on boot_ready */
  initialPrompt?: string;
  /** false when callerFlags remove Read (§2.3 rule 4) */
  readAvailable: boolean;
  decide: (turn: SettledTurn) => FinalVerdict | "continue";
  onBlocked: (b: PaneBlock) => FinalVerdict | "wait";
  bootTimeoutMs?: number;
  /** initialDelivery only */
  admitTimeoutMs?: number;
  /** whole-session deadline → TIMEOUT (channel only; team never passes it) */
  timeoutMs?: number;
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
    resendAfterMs?: number;
    corroborationMs?: number;
    bootStaticMs?: number;
    replStableMs?: number;
  };
}

export type SendResult =
  | { ok: true; queued: number }
  | { ok: false; reason: "terminal" | "delivery_unavailable" | "unsupported_command" };

/** What `get_diagnostics` reads from a live pane beyond the snapshot (§4.2). */
export interface PaneDiagnostics {
  /** the head of magmux's own stderr (≤ 8 KB) */
  magmuxStderr: string;
  /** assistant text before a file-delivered turn's task file was read (X-H4) */
  preambleBytes: number;
  /** read coverage of the current turn's task file; null for a typed turn or no turn */
  readCoverage: {
    linesTotal: number;
    linesReturned: number;
    complete: boolean;
    reads: number;
  } | null;
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
  turnAnswer(index: number): string;
  /** main-chain assistant message ids the transcript has shown, first-seen order, each once */
  assistantMessageIds(): readonly string[];
  diagnostics(): PaneDiagnostics;
  cancel(): { changed: boolean; state: SlotState };
  expire(): { changed: boolean; state: SlotState };
  reaped(): Promise<void>;
}

interface Admission {
  index: number;
  text: string;
  plan: Delivery;
  initial: boolean;
  startedAt: number;
  deliveredAt: number | null;
  resent: boolean;
  panelEscaped: boolean;
  /** degraded acceptance armed (no transcript evidence after the entry delay) */
  degraded: boolean;
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
  FAILED: "verdict_failed",
};

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function alive(p: ChildProcess | null): boolean {
  return !!p && p.exitCode === null && p.signalCode === null;
}

function screenTailOf(s: ScreenState, n = 12): string {
  const lines = s.lines.filter((l) => l.trim());
  return lines.slice(-n).join("\n");
}

export class PaneSessionImpl implements PaneSession, RegisteredPane {
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
  private queue: string[] = [];
  private screen: ScreenState = emptyScreen(160, 50);
  private final = false;
  private turnIndex = 0;
  private admission: Admission | null = null;
  private screenTurn: ScreenTurn | null = null;
  private turnSource: "transcript" | "screen" = "transcript";
  private turnsCompleted = 0;
  private rewakeOfSettled = false;
  private settledChatOffset: number | null = null;
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
  private exitScrollback = "";
  private exitLastLine = "";

  private bootKind: string | null = null;
  private bootKindSince = 0;

  private magmux: ChildProcess | null = null;
  private watcher: ChildProcess | null = null;
  private client: MagmuxClient | null = null;
  private panePidValue: number | null = null;
  private stderrHead = "";
  private paneClosed = false;
  private paneExited = false;
  private reaping = false;
  private fastReap = false;
  private reapPromise: Promise<void> | null = null;
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
    this.initialPending = !!o.initialPrompt;
    if (o.initialPrompt) this.queue.push(o.initialPrompt);
    this.secondaryQuietMs = o.timings?.secondaryQuietMs ?? SECONDARY_QUIET_MS;
    this.corroborationMs = o.timings?.corroborationMs ?? CORROBORATION_MS;
    this.follower = new TranscriptFollower(
      o.transcriptPath,
      join(o.transcriptPath.replace(/\.jsonl$/, ""), "subagents")
    );
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
    this.client = client;
    client.on("snapshot", (e) => this.onSnapshot(e));
    client.on("frame", (f: MagmuxFrame) => this.onFrame(f));
    client.on("exit", (e) => void this.onPaneExit(e));
    client.on("pane_closed", (e) => {
      if (e?.pane === 0) this.paneClosed = true;
    });
    client.on("disconnected", () => this.onDisconnected(client));
    const caps = await client.request<{ version?: string; protocol?: number }>({
      type: "capabilities",
    });
    if (caps.ok) {
      const v = String(caps.result.version ?? "");
      if (caps.result.protocol !== 1 || !versionAtLeast(v, MIN_MAGMUX_VERSION)) {
        this.step(() =>
          this.fire("pane_lost", {
            detail: `magmux_unavailable: magmux ${v || "?"} protocol ${caps.result.protocol ?? "?"}; panes need >= ${MIN_MAGMUX_VERSION}, protocol 1`,
          })
        );
        return;
      }
    }
    await client.request({ type: "watch", pane: 0, mode: "frames", fps: WATCH_FPS });
    // An `exit` pushed before this connection subscribed (a child that dies in its first
    // milliseconds, or one that exited in a reconnect gap) is only visible in `list`.
    const list = await client.request<{ panes?: Array<Record<string, unknown>> }>({ type: "list" });
    const p0 = list.ok ? list.result.panes?.find((p) => p.pane === 0) : undefined;
    if (typeof p0?.pid === "number" && !this.panePidValue) this.setPanePid(p0.pid);
    if (p0?.dead === true && !this.paneExited) {
      if (!reconnect) await this.nextFrame(500); // let the keyframe land: the final screen decides agent_rejected
      void this.onPaneExit({ exitCode: p0.exitCode ?? null, lastLine: "" });
    }
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
    void readProcessTableAsync().then((t) => refreshGroupOf(this, t));
  }

  private onFrame(f: MagmuxFrame): void {
    if (f.pane !== undefined && f.pane !== 0) return;
    this.screen = applyFrame(this.screen, f);
    this.framePending = true;
    if (!this.claudeCodeVersion) {
      const m = this.screen.lines.join("\n").match(/Claude Code v(\d+\.\d+\.\d+)/);
      if (m) this.claudeCodeVersion = m[1] ?? null;
    }
    this.step(() => this.evaluate());
  }

  private onDisconnected(client: MagmuxClient): void {
    if (this.client === client) this.client = null;
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
          return;
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
      if (this.phase === "RUNNING" && this.exitSettle()) {
        this.applyExitPath(null);
        return;
      }
      this.fire("pane_lost", {
        detail: `magmux exited (${sig ?? `code ${code}`}) without reporting the pane's exit${this.stderrHead ? `; stderr: ${this.stderrHead.trim().slice(0, 500)}` : ""}`,
      });
    });
  }

  /** The pane child exited (magmux `exit` event, or a dead pane found on reconnect). */
  private async onPaneExit(e: { exitCode?: unknown; lastLine?: unknown }): Promise<void> {
    if (this.paneExited || isTerminalPhase(this.phase)) return;
    this.paneExited = true;
    const code = typeof e?.exitCode === "number" ? e.exitCode : null;
    const lastLine = typeof e?.lastLine === "string" ? e.lastLine : "";
    // The final screen, with scrollback, so a long agent list cannot hide the refusal (L8).
    if (this.client) {
      const cap = await this.client.request<MagmuxCapture>(
        { type: "capture", pane: 0, offset: 200 },
        1000
      );
      if (
        cap.ok &&
        agentRejectedLine(cap.result.text ?? "") &&
        !agentRejectedLine(screenText(this.screen))
      )
        this.exitScrollback = cap.result.text ?? "";
    }
    this.step(() => {
      this.exitCode = code;
      this.exitLastLine = lastLine;
      this.applyExitPath(code);
    });
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

  /** Poll on a frame (debounced 250 ms) and on a 1 s backstop (FR4). */
  private pollFollower(force = false): TranscriptView {
    const now = Date.now();
    const since = now - this.lastPollAt;
    if (force || (this.framePending && since >= TICK_MS) || since >= POLL_BACKSTOP_MS) {
      this.follower.poll();
      this.lastPollAt = now;
      this.framePending = false;
    }
    const view = this.follower.view();
    const off = view.current?.lastChatOffset ?? null;
    if (off !== this.lastChatOffset) {
      this.lastChatOffset = off;
      this.lastChatSeenAt = now;
    }
    return view;
  }

  private evaluate(): void {
    if (isTerminalPhase(this.phase)) return;
    if (transcriptSavingOff(this.screen)) this.follower.markSavingOff();
    const view = this.pollFollower();
    this.checkLiveness();
    switch (this.phase) {
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
      case "IDLE":
        this.evalIdle(view);
        break;
    }
    this.pump();
  }

  /** While disconnected, the pane's liveness is `kill(panePid, 0)` every second (X-M12). */
  private checkLiveness(): void {
    if (this.client || !this.panePidValue || this.paneExited) return;
    const now = Date.now();
    if (now - this.lastLivenessAt < 1000) return;
    this.lastLivenessAt = now;
    try {
      process.kill(this.panePidValue, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") {
        this.paneExited = true;
        this.applyExitPath(null);
      }
    }
  }

  private t(key: keyof NonNullable<PaneSessionOptions["timings"]>, dflt: number): number {
    return this.o.timings?.[key] ?? dflt;
  }

  private evalBoot(): void {
    const now = Date.now();
    const r = readBoot(this.screen);
    if (r.kind !== this.bootKind) {
      this.bootKind = r.kind;
      this.bootKindSince = now;
    }
    const staticFor = this.screen.seq === 0 ? 0 : now - this.screen.changedAt;
    const staticMs = this.t("bootStaticMs", BOOT_STATIC_MS);
    if (r.kind === "repl" && now - this.bootKindSince >= this.t("replStableMs", REPL_STABLE_MS)) {
      this.bootReady();
      return;
    }
    if (r.kind === "dialog" && staticFor >= staticMs) {
      this.fire("boot_dialog", { detail: r.text });
      return;
    }
    if (r.kind === "choice" && staticFor >= staticMs) {
      this.fire("boot_blocked", { detail: r.text });
      return;
    }
    if (now - this.startedAtMs >= (this.o.bootTimeoutMs ?? BOOT_TIMEOUT_MS)) {
      const blocked = this.screen.seq > 0 && staticFor >= staticMs && r.kind !== "booting";
      this.fire("boot_deadline", {
        reason: blocked ? "boot_blocked" : "boot_timeout",
        detail: screenTailOf(this.screen),
      });
    }
  }

  private bootReady(): void {
    if (this.queue.length === 0) {
      this.fire("boot_ready_idle");
      return;
    }
    const head = this.queue[0] as string;
    if (isControl(head)) {
      this.fire("boot_ready_idle");
      return;
    }
    const initial = this.initialPending;
    this.initialPending = false;
    this.initialDelivery = initial;
    this.queue.shift();
    this.fire("boot_ready_admit");
    this.startAdmission(head, initial);
  }

  /** IDLE (or boot-ready) with a queued item: admit synchronously, then deliver. */
  private pump(): void {
    if (isTerminalPhase(this.phase) || this.admission) return;
    if (this.phase === "IDLE" && this.queue.length > 0) {
      const head = this.queue.shift() as string;
      if (isControl(head)) {
        this.exitRequested = true;
        void this.typeLine(head.trim(), true);
        return;
      }
      this.fire("admit");
      this.startAdmission(head, false);
      return;
    }
    if (
      (this.phase === "QUESTION" || this.phase === "PERMISSION") &&
      this.queue.length > 0 &&
      this.escapeArmed &&
      this.escapeSentAt === null
    ) {
      // Esc declines the dialog AND interrupts the turn; it settles through path I (D17).
      this.escapeArmed = false;
      this.escapeSentAt = Date.now();
      void this.key("escape");
    }
  }

  private startAdmission(text: string, initial: boolean): void {
    this.follower.poll();
    this.lastPollAt = Date.now();
    const offset = this.follower.size(); // mark BEFORE deliver: the single turn boundary
    const index = ++this.turnIndex;
    const plan = planDelivery(text, this.turnDir, index, this.o.readAvailable);
    this.currentDelivery = plan;
    this.turnSource = "transcript";
    this.screenTurn = null;
    this.rewakeOfSettled = false;
    this.settledChatOffset = null;
    if (plan.mode === "refused" || plan.mode === "control") {
      this.anomaly(`delivery_refused:${plan.mode === "refused" ? plan.reason : "control"}`);
      this.admission = null;
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
    this.admission = {
      index,
      text,
      plan,
      initial,
      startedAt: Date.now(),
      deliveredAt: null,
      resent: false,
      panelEscaped: false,
      degraded: false,
    };
    void this.deliver(this.admission);
  }

  private async deliver(adm: Admission): Promise<void> {
    const plan = adm.plan;
    if (plan.mode !== "typed" && plan.mode !== "file" && plan.mode !== "command") return;
    if (plan.mode === "command") {
      await this.typeLine(plan.line, false);
      await this.nextFrame(500);
      const box = inputBox(this.screen);
      const name = plan.line.match(/^\/\S+/)?.[0] ?? "";
      if (box?.menuOpen && box.menuItem !== name) await this.key("escape");
      await this.key("enter");
    } else {
      await this.typeLine(plan.line, true);
    }
    adm.deliveredAt = Date.now();
  }

  /**
   * §2.9 step 4: retry only a send magmux refused (`busy`, `pane_*`) or one never
   * written (`client_closed`). A send whose REPLY was lost (`client_timeout`,
   * `client_lost`) may already have been typed, so the screen decides: retyping it
   * blindly put the line in the box twice and no witness could ever match.
   */
  private async typeLine(text: string, enter: boolean): Promise<boolean> {
    let why = "disconnected";
    for (let attempt = 0; attempt < 2; attempt++) {
      const c = this.client;
      if (c) {
        const r = await c.request({ type: "send", pane: 0, text, typed: true, enter }, 10_000);
        if (r.ok) return true;
        why = r.code;
        if (r.code === "client_timeout" || r.code === "client_lost") {
          if (await this.landedAfterLostReply(text, enter)) return true;
        }
      }
      await Bun.sleep(500);
    }
    this.anomaly(`delivery_failed:${why}`);
    return false;
  }

  /** After a lost reply: the line is in the box (typed), or already submitted (echo, witness). */
  private async landedAfterLostReply(text: string, enter: boolean): Promise<boolean> {
    await this.nextFrame(1000);
    const head = text.slice(0, 40);
    const box = inputBox(this.screen);
    let landed = !!box && box.text.startsWith(head);
    if (landed && enter) await this.key("enter");
    if (!landed && enter) {
      this.follower.poll();
      const cur = this.follower.view().current;
      landed =
        (!!cur && cur.index === this.turnIndex && cur.acceptedAt !== null) ||
        this.screen.lines.some((l) => l.startsWith(`❯ ${head}`));
    }
    if (landed) this.anomaly("send_reply_lost");
    return landed;
  }

  private async key(k: string): Promise<boolean> {
    const c = this.client;
    if (!c) return false;
    const r = await c.request({ type: "send", pane: 0, keys: [k], enter: false }, 10_000);
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

  private evalAdmission(view: TranscriptView): void {
    const adm = this.admission;
    if (!adm) return;
    const cur = view.current;
    if (cur && cur.index === adm.index && cur.acceptedAt !== null) {
      this.accept();
      return;
    }
    const now = Date.now();
    const since = adm.deliveredAt ? now - adm.deliveredAt : 0;
    if (adm.deliveredAt && adm.plan.mode === "command" && this.panelCommand(adm, since)) return;
    if (adm.deliveredAt && since >= this.t("resendAfterMs", RESEND_AFTER_MS)) this.nudge(adm);
    if (
      adm.deliveredAt &&
      (view.availability === "off" || since >= this.t("degradedEntryMs", DEGRADED_ENTRY_MS))
    )
      this.maybeDegradedAccept(adm, view);
    if (this.phase !== "ADMITTING") return;
    if (now - adm.startedAt >= (this.o.admitTimeoutMs ?? ADMIT_TIMEOUT_MS)) this.admitExpired(adm);
  }

  /** A full-screen panel: no input box, no choice dialog, and its `Esc to cancel` footer. */
  private panelOpen(): boolean {
    return (
      !inputBox(this.screen) &&
      !hasChoiceDialog(this.screen) &&
      /Esc to cancel/.test(screenText(this.screen))
    );
  }

  /**
   * A delivered panel command (`/cost`, `/usage`, `/config`, …) writes no transcript record
   * and swallows input until Esc (phase2-captures §3, §10), so it can never be witnessed.
   * Once it is on screen it is dismissed at once, and when the empty box is back the
   * admission ends without a turn: a later prompt is not held for the 30 s admission bound.
   * True when this step handled the admission.
   */
  private panelCommand(adm: Admission, since: number): boolean {
    if (!adm.panelEscaped) {
      if (since < PANEL_SETTLE_MS || !this.panelOpen()) return false;
      adm.panelEscaped = true;
      this.anomaly("panel_dismissed");
      void this.key("escape");
      return true;
    }
    const box = inputBox(this.screen);
    if (!box || box.text !== "" || this.panelOpen()) return false;
    this.admission = null;
    this.anomaly("panel_command");
    if (adm.initial)
      this.fire("admit_deadline", {
        detail: `${adm.text.trim()} opened a panel and wrote no transcript record`,
      });
    else this.fire("admit_abandoned");
    return true;
  }

  /** +10 s without a witness: the line still in the box → Enter again; a panel → Esc. */
  private nudge(adm: Admission): void {
    const box = inputBox(this.screen);
    const line = adm.plan.mode === "control" || adm.plan.mode === "refused" ? "" : adm.plan.line;
    if (!adm.resent && box && line && box.text.startsWith(line.slice(0, 40))) {
      adm.resent = true;
      this.anomaly("resent_enter");
      void (async () => {
        if (box.menuOpen) await this.key("escape");
        await this.key("enter");
      })();
      return;
    }
    if (
      !adm.panelEscaped &&
      !box &&
      !hasChoiceDialog(this.screen) &&
      /Esc to cancel/.test(screenText(this.screen))
    ) {
      // A panel command (`/cost`, `/usage`, …) writes no record and swallows input until Esc.
      adm.panelEscaped = true;
      this.anomaly("panel_dismissed");
      void this.key("escape");
    }
  }

  /** Degraded acceptance (§2.8): the box emptied of the line, and an echo or a change above it. */
  private maybeDegradedAccept(adm: Admission, view: TranscriptView): void {
    if (view.availability === "ok") return;
    const box = inputBox(this.screen);
    if (!box || box.text !== "") return;
    const line = adm.plan.mode === "control" || adm.plan.mode === "refused" ? "" : adm.plan.line;
    const echo = this.screen.lines.some((l) => l.startsWith(`❯ ${line.slice(0, 40)}`));
    const changed = adm.deliveredAt !== null && this.screen.aboveBoxChangedAt > adm.deliveredAt;
    if (!echo && !changed) return;
    this.turnSource = "screen";
    this.anomaly("degraded_mode");
    this.screenTurn = { echo: line, acceptedAt: Date.now(), errorLogSize: this.errorLogSize() };
    this.accept();
  }

  private accept(): void {
    this.admission = null;
    this.initialDelivery = false;
    this.lastChatSeenAt = Date.now();
    this.fire("prompt_accepted");
  }

  private admitExpired(adm: Admission): void {
    this.admission = null;
    if (adm.initial) {
      this.fire("admit_deadline", { detail: screenTailOf(this.screen) });
      return;
    }
    this.anomaly("send_not_accepted");
    this.fire("admit_abandoned");
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
    const decision = decideSettle({
      turn: t,
      session: view.session,
      transcriptQuietMs: now - (view.lastAppendAt ?? this.startedAtMs),
      chatQuietMs: now - this.lastChatSeenAt,
      screen: this.screenFacts(),
      paneExited: false,
      secondaryQuietMs: this.secondaryQuietMs,
      corroborationMs: this.corroborationMs,
    });
    if (decision.settled) {
      this.settle(t, decision, null);
      return;
    }
    this.activity = decision.activity;
    this.checkTurnEndMissing();
  }

  private checkEscape(): void {
    if (this.escapeSentAt === null) return;
    if (Date.now() - this.escapeSentAt < (this.o.admitTimeoutMs ?? ADMIT_TIMEOUT_MS)) return;
    this.anomaly("escape_not_effective");
    this.escapeSentAt = null;
  }

  /**
   * R3-M4: `finishing` with a static screen and no Stop-hook UI for N secondary windows.
   * The condition is live (it clears the moment work resumes); the anomaly counts how often
   * it began.
   */
  private checkTurnEndMissing(): void {
    if (this.activity !== "finishing") {
      this.turnEndMissing = false;
      return;
    }
    if (!this.client) return;
    const quiet = Date.now() - this.screen.aboveBoxChangedAt;
    const missing =
      quiet >= TURN_END_MISSING_FACTOR * this.secondaryQuietMs && !stopHookRunning(this.screen);
    if (missing && !this.turnEndMissing) this.anomaly("turn_end_record_missing");
    this.turnEndMissing = missing;
  }

  /** Blocked detection (H7): AskUserQuestion from the transcript; permission needs the dialog too. */
  private detectBlocked(t: TurnView): boolean {
    const pending = t.pendingTool;
    if (!pending || this.phase !== "RUNNING") return false;
    let kind: PaneBlock["kind"] | null = null;
    if (pending.name === "AskUserQuestion") kind = "question";
    else if (this.client && hasChoiceDialog(this.screen)) kind = "permission";
    if (!kind) return false;
    this.blockedToolId = pending.id;
    this.fire(kind === "question" ? "blocked_question" : "blocked_permission");
    this.activity = pending.name;
    const text = blockText(pending, choiceDialog(this.screen)?.text ?? null);
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
    // After a delivered /exit only the pane's exit can follow, never a re-wake: Claude
    // Code 2.1.282–2.1.285 write the command's own records into the settled turn.
    if (!t || this.settledChatOffset === null || this.exitRequested) return;
    // A background notification woke the model with no prompt of ours (D23): same turn.
    if (t.lastChatOffset !== null && t.lastChatOffset > this.settledChatOffset) {
      this.rewakeOfSettled = true;
      this.fire("rewake");
      this.activity = "thinking";
    }
  }

  /* ───────────────────────────── settle ───────────────────────────── */

  private settledTurnOf(t: TurnView, decision: SettleDecision & { settled: true }): SettledTurn {
    const d = this.currentDelivery;
    // R3-M3: a file-carrying COMMAND turn hands its text to the command's own expansion,
    // which may never Read the pointer file (directly or through a subagent). Zero Reads is
    // then unverified coverage, not a failed read: complete null, never prompt_not_read.
    const unverified = d?.mode === "command" && !!t.delivery && t.readCoverage.reads === 0;
    if (unverified) this.anomaly("read_coverage_unverified");
    return {
      index: t.index,
      // a local command's answer is its own stdout: it has no assistant message (path L)
      answer:
        decision.by === "local_command"
          ? (t.localCommandOutput ?? "")
          : t.assistantText.join("\n\n"),
      apiError: t.apiError,
      stopReason: decision.stopReason,
      captureSource: "transcript",
      settledBy: decision.by,
      shape: this.shape,
      delivery: {
        mode: d && d.mode !== "refused" ? d.mode : "typed",
        linesTotal: t.delivery ? t.delivery.lines : null,
        linesRead: t.delivery ? t.readCoverage.linesReturned : null,
        complete: t.delivery && !unverified ? t.readCoverage.complete : null,
        preambleBytes: t.preambleBytes,
      },
    };
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

  private finishTurn(turn: SettledTurn, chatOffset: number | null, exitCode: number | null): void {
    this.turnEndMissing = false;
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
      const note = `pane child exited${exitCode === null ? "" : ` ${exitCode}`}`;
      verdict = { ...verdict, detail: verdict.detail ? `${verdict.detail} · ${note}` : note };
    }
    this.applyVerdict(verdict);
  }

  private applyVerdict(v: FinalVerdict): void {
    this.fire(VERDICT_EVENT[v.state], { reason: v.reason, detail: v.detail });
  }

  /* ───────────────────────────── degraded (screen) turn ───────────────────────────── */

  /** The current turn's witness is in the transcript. */
  private witnessed(t: TurnView | null): boolean {
    return !!t && t.index === this.turnIndex && t.acceptedAt !== null;
  }

  /** Degraded settle (§2.8): empty box, no dialog, not working, and an answer or error row gone quiet. */
  private screenSettleReady(view: TranscriptView, answer: string, apiError: unknown): boolean {
    const box = inputBox(this.screen);
    if (!box || box.text !== "" || hasChoiceDialog(this.screen) || isWorking(this.screen))
      return false;
    const quiet = Date.now() - this.screen.aboveBoxChangedAt;
    if (view.availability === "off" && quiet >= this.secondaryQuietMs) return true;
    return (
      (!!answer || !!apiError) && quiet >= 2 * this.t("screenSettleQuietMs", SCREEN_SETTLE_QUIET_MS)
    );
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
    if (!st || !this.client) return;
    const answer = screenAnswer(this.screen, st.echo);
    const apiError = this.screenApiError(st, answer);
    this.activity = "thinking";
    if (!this.screenSettleReady(view, answer, apiError)) return;
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
      screen: null,
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
   * admitted. An exit seen only as ESRCH while the socket is lost has no code: after a
   * delivered /exit that is still the clean exit it asked for.
   */
  private cleanIdleExit(code: number | null): boolean {
    if (this.phase !== "IDLE" || this.shape !== "interactive") return false;
    if (code !== 0 && !(code === null && this.exitRequested)) return false;
    return (this.exitRequested || this.turnsCompleted >= 1) && this.admission === null;
  }

  /** §2.2 rule 3: agent_rejected when the child's own refusal is on screen, else child_exited. */
  private firePaneExit(code: number | null): void {
    const text = `${this.exitLastLine}\n${this.exitScrollback}\n${screenText(this.screen)}`;
    const rejected =
      agentRejectedLine(screenText(this.screen)) ??
      agentRejectedLine(this.exitScrollback) ??
      agentRejectedLine(text);
    this.fire("pane_exit", {
      reason: rejected ? "agent_rejected" : "child_exited",
      detail: rejected
        ? rejected
        : `pane child exited ${code === null ? "(code unknown)" : `with code ${code}`}${this.exitLastLine ? `; last line: ${this.exitLastLine}` : ""}\n${screenTailOf(this.screen)}`,
    });
  }

  /* ───────────────────────────── public verbs ───────────────────────────── */

  snapshot(): PaneSnapshot {
    const view = this.follower.view();
    const terminal = isTerminalPhase(this.phase);
    const lastAct = Math.max(this.screen.changedAt, view.lastAppendAt ?? 0);
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
      pendingInputs: this.queue.length,
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
    };
  }

  private phaseActivity(): string | null {
    switch (this.phase) {
      case "RUNNING":
        return this.activity ?? "thinking";
      case "QUESTION":
        return "AskUserQuestion";
      case "PERMISSION":
        return this.activity;
      default:
        return null;
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
    this.queue.push(text);
    this.escapeArmed = true;
    // Read the transcript first: a turn whose end record already landed settles HERE, and
    // its owner must see the converted shape (SettledTurn.shape) and the queued text.
    this.step(() => {
      this.pollFollower(true);
      this.evaluate();
    });
    // Never report a queued prompt for a session this very step ended.
    if (isTerminalPhase(this.phase)) return { ok: false, reason: "terminal" };
    return { ok: true, queued: this.queue.length };
  }

  turnAnswer(index: number): string {
    const done = this.answers.get(index);
    if (done !== undefined) return done;
    const cur = this.follower.view().current;
    return cur && cur.index === index ? cur.assistantText.join("\n\n") : "";
  }

  assistantMessageIds(): readonly string[] {
    return this.follower.assistantMessageIds();
  }

  diagnostics(): PaneDiagnostics {
    const cur = this.follower.view().current;
    return {
      magmuxStderr: this.stderrHead,
      preambleBytes: cur?.preambleBytes ?? 0,
      readCoverage: cur?.delivery
        ? {
            linesTotal: cur.delivery.lines,
            linesReturned: cur.readCoverage.linesReturned,
            complete: cur.readCoverage.complete,
            reads: cur.readCoverage.reads,
          }
        : null,
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

  panePid(): number | null {
    return this.panePidValue;
  }

  /* ───────────────────────────── terminal and reap ───────────────────────────── */

  private onTerminal(): void {
    this.endedAtMs = Date.now();
    this.final = true;
    this.admission = null;
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    if (!this.readySettled) {
      this.readySettled = true;
      this.resolveReady();
    }
    // after the step that made it terminal has finished (onTransition first)
    queueMicrotask(() => this.resolveTerminal(this.snapshot()));
    if (!this.reapPromise) this.reapPromise = this.reap();
  }

  private files(): { paneId: string; sockPath: string; launcherDir: string; turnDir: string } {
    return {
      paneId: this.paneId,
      sockPath: this.sockPath,
      launcherDir: this.ctlDir,
      turnDir: this.turnDir,
    };
  }

  private ms(normal: number, fast: number): number {
    return this.fastReap ? fast : normal;
  }

  private async waitFor(pred: () => boolean, ms: number): Promise<void> {
    const end = Date.now() + ms;
    while (!pred() && Date.now() < end) await Bun.sleep(25);
  }

  /** §2.10 — close_pane, magmux by its handle, the verified group backstop, verify, clean, watcher. */
  private async reap(): Promise<void> {
    await Promise.resolve(); // let the terminal step finish first
    this.reaping = true;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    await this.captureGroupBeforeReap();
    const c = this.client;
    if (c && !c.isClosed && !this.paneClosed) {
      const r = await c.request({ type: "close_pane", pane: 0, force: true }, this.ms(1000, 500));
      if (r.ok || r.code === "no_such_pane")
        await this.waitFor(() => this.paneClosed || c.isClosed, this.ms(3000, 1000));
    }
    if (this.magmux) await waitForExit(this.magmux, this.ms(3000, 1000));
    if (alive(this.magmux)) {
      this.magmux?.kill("SIGTERM");
      if (this.magmux) await waitForExit(this.magmux, this.ms(2000, 500));
      if (alive(this.magmux)) this.magmux?.kill("SIGKILL");
      if (this.magmux) await waitForExit(this.magmux, 1000);
    }
    await this.groupBackstop();
    await this.verifyAndClean();
  }

  /** Step 0: refresh the verified group while its members still carry their identity. */
  private async captureGroupBeforeReap(): Promise<void> {
    const table = await readProcessTableAsync();
    if (!this.panePidValue && this.magmux?.pid) {
      const lead = table.find((r) => r.ppid === this.magmux?.pid && r.pgid === r.pid);
      if (lead) {
        const snap = verifiedGroupSnapshot(table, lead.pgid, this.identity);
        if (snap) this.panePidValue = lead.pid;
      }
    }
    refreshGroupOf(this, table);
  }

  /** The verified group, or a recorded escaped descendant (own process group), is alive. */
  private async groupAlive(): Promise<boolean> {
    if (!this.group) return false;
    const table = await readProcessTableAsync();
    return groupCheck(table, this.group) || liveEscaped(table, this.group).length > 0;
  }

  /** The verified group (`-pgid`) and each live escaped descendant (its pid), re-read now. */
  private async backstopTargets(): Promise<number[]> {
    if (!this.group) return [];
    const table = await readProcessTableAsync();
    return [
      ...(groupCheck(table, this.group) ? [-this.group.pgid] : []),
      ...liveEscaped(table, this.group),
    ];
  }

  private async groupBackstop(): Promise<void> {
    for (const sig of ["SIGTERM", "SIGKILL"] as const) {
      const targets = await this.backstopTargets();
      if (targets.length === 0) return;
      for (const target of targets) signalQuietly(target, sig);
      const end = Date.now() + (sig === "SIGTERM" ? this.ms(2000, 500) : 1000);
      while (Date.now() < end && (await this.groupAlive())) await Bun.sleep(150);
    }
  }

  private async verifyAndClean(): Promise<void> {
    const groupGone = !(await this.groupAlive());
    const magGone = !alive(this.magmux);
    this.client?.close();
    if (groupGone && magGone) {
      removePaneFiles(this.root, this.files());
      this.reapFailed = false;
      await this.endWatcher();
      unregisterPane(this.paneId);
      return;
    }
    this.reapFailed = true;
    this.anomaly("reap_unverified");
    updateRecord(this.root, this.paneId, { reapFailed: true });
  }

  /** Re-run steps 4–6 (the registry's 2 s tick, after an unverified reap). */
  async retryReap(): Promise<boolean> {
    if (alive(this.magmux)) this.magmux?.kill("SIGKILL");
    await this.groupBackstop();
    await this.verifyAndClean();
    return !this.reapFailed;
  }

  /** Step 6, only after a verified reap: `done`, end stdin, then SIGKILL through the handle. */
  private async endWatcher(): Promise<void> {
    const w = this.watcher;
    if (!w || !alive(w)) return;
    try {
      w.stdin?.write("done\n");
      w.stdin?.end();
    } catch {
      // EPIPE: the watcher is already gone (R3-M1)
    }
    await waitForExit(w, 1000);
    if (alive(w)) w.kill("SIGKILL");
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

function signalQuietly(target: number, sig: NodeJS.Signals): void {
  try {
    process.kill(target, sig);
  } catch {
    // gone between the read and the signal
  }
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
    const sockPath = sockPathFor(root, paneId);
    const cwd = realpathSync(o.cwd);
    const launch = o.claudishSpawn ?? resolveClaudishLaunch(parentEnv);
    dirs = createLaunchDirs(root);
    const argv = buildClaudishPaneArgv(o.spawnModel, o.sessionUuid, dirs.turnDir, o.callerFlags);
    writeLauncherFiles(dirs.ctlDir, launcherScript(cwd, launch, argv));
    const { magmuxEnv } = buildPaneEnv({ parentEnv, slotEnv: o.slotEnv, cwd, ctlDir: dirs.ctlDir });
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
