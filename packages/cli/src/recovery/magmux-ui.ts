/**
 * The recovery banner — drawn by magmux itself, over the pane claudish's Claude
 * Code already occupies.
 *
 * WHY magmux's `overlay`, AND NOT A PANE OF OURS. The first version opened a
 * pane with `open_pane` and closed it with `close_pane`. Opening a stacked pane
 * shrinks Claude Code's pane; closing it grows the pane back, and Claude Code
 * 2.1.272 does not survive the grow: six rows of its bottom chrome collapse
 * onto one line and the input box is destroyed, and nothing done from outside —
 * Escape, a keystroke, Ctrl-L, SIGWINCH, a shrink-then-grow cycle — repairs it
 * (`ai-docs/reports/network-recovery-pane-close-wedges-host-tui-20260915.md`).
 * magmux resizes correctly; the reflow itself is the trigger. `overlay` draws a
 * styled box OVER a pane and changes no layout, so there is no reflow to
 * survive. It also retired the pane process, the NDJSON socket we served it
 * from, that socket's wire protocol and the cross-process lock that let only
 * one claudish in a grid own the single pane: magmux is the renderer now, and
 * every claudish draws on its own pane.
 *
 * THE LEASE, RESTATED FOR A RENDERER WE DO NOT OWN. A retryable 503 is allowed
 * only while the reason is legible on screen, so:
 *
 *   uiLeaseValid(id)  ⇔  we hold a magmux control connection and know our pane
 *                     ∧  magmux ACKNOWLEDGED an overlay write painting THIS
 *                        episode within UI_LEASE_MS
 *
 * magmux replies only to a message that carries an `id`, and a reply means it
 * accepted the text for a pane it is drawing. If magmux dies, the writes stop
 * being acknowledged, the lease lapses on its own, and the proxy answers the
 * inline 400 at exhaustion. No path has to remember to revoke anything.
 *
 * THE BANNER IS RE-ASSERTED EVERY TICK, NEVER WRITTEN ONCE. magmux writes the
 * same overlay from its own Claude Code state tracker — `CtrlError` paints
 * "✗ …" over whatever is there (`magmux/mux/mux.go`) — so a banner written once
 * can be replaced mid-outage. The countdown needs one write per second anyway,
 * and the same write restores ours within a second of being overwritten.
 *
 * NO KEYS. An overlay is drawn by magmux; it is not a process and cannot read
 * `[r] try now` or `[q] give up`. Esc in Claude Code still aborts the held
 * request — a client disconnect ends its waiter — and the ladder retries on its
 * own. Driving the status line and forwarding keys are requested of magmux in
 * its `ai-docs/feature-request-status-line.md`.
 */

import { existsSync } from "node:fs";
import { type Socket, connect as netConnect } from "node:net";
import { log } from "../logger.js";
import { findOwnPane } from "../pane/own-pane.js";
import { recoveryClock } from "./clock.js";
import {
  type RecoveryOutcome,
  type RecoveryUiHooks,
  episodeIsLive,
  markPaneRequested,
  registerRecoveryUi,
  renderableEpisodeFrame,
} from "./coordinator.js";
import { FRAME_TICK_MS, type RecoveryEpisodeFrame, UI_LEASE_MS } from "./types.js";

/** How long the "recovered" banner stays up before the overlay is cleared. */
export const OUTCOME_LINGER_MS = 4_000;

/**
 * Wrap width for the reason sentence. magmux clamps the box to the pane and
 * CLIPS a line that is too wide rather than wrapping it, so the text has to
 * arrive already wrapped.
 */
const OVERLAY_WRAP_COLS = 60;

/** A control request that gets no reply in this long is treated as refused. */
const CONTROL_TIMEOUT_MS = 3_000;

// ─── The control endpoint ────────────────────────────────────────────────────

let explicitControlSock: string | null = null;

/**
 * Where to send `overlay`, and whether claudish launched this magmux itself.
 *
 * The launch wrapper hands its socket in EXPLICITLY: claudish is magmux's
 * parent and `MAGMUX_SOCK` is exported downward only, so the parent can never
 * discover a pid-derived path. The wrapper fixes the path with `--id` before
 * magmux starts. Failing that, an ambient `MAGMUX_SOCK` means this claudish is
 * running INSIDE someone else's magmux — `team --grid`, or a user's own pane.
 *
 * It answers a launch-order question and gates only the banner. It must never
 * gate whether a retry happens.
 */
function resolveControlEndpoint(): { sock: string; wrapped: boolean } | null {
  if (explicitControlSock && existsSync(explicitControlSock)) {
    return { sock: explicitControlSock, wrapped: true };
  }
  const ambient = process.env.MAGMUX_SOCK;
  if (ambient && existsSync(ambient)) return { sock: ambient, wrapped: false };
  return null;
}

// ─── State ───────────────────────────────────────────────────────────────────

interface UiState {
  control: Socket | null;
  connecting: Promise<boolean> | null;
  /** The magmux pane Claude Code runs in. Null until found. */
  targetPane: number | null;
  /** episodeId → PROCESS ms of the last ACKNOWLEDGED overlay write painting it. */
  leases: Map<string, number>;
  /** The last frame magmux acknowledged, kept to draw the outcome after close. */
  lastFrame: RecoveryEpisodeFrame | null;
  tickTimer: unknown | null;
  lingerTimer: unknown | null;
  /** Guards against a slow magmux stacking one paint on another. */
  painting: boolean;
  /** Whether the last paint was acknowledged, so a failure logs once, not per tick. */
  lastPaintOk: boolean | null;
  /** An unreachable magmux is logged once, not once per tick. */
  unavailableLogged: boolean;
  /**
   * Ambient magmux only: our pane was looked for and is not there. Pane
   * topology does not change under a running claudish, so the ancestry walk is
   * not repeated every tick.
   */
  paneNotFound: boolean;
  nextControlId: number;
}

const state: UiState = {
  control: null,
  connecting: null,
  targetPane: null,
  leases: new Map(),
  lastFrame: null,
  tickTimer: null,
  lingerTimer: null,
  painting: false,
  lastPaintOk: null,
  unavailableLogged: false,
  paneNotFound: false,
  nextControlId: 1,
};

function noteUnavailable(message: string): void {
  if (state.unavailableLogged) return;
  state.unavailableLogged = true;
  log(message);
}

let installed = false;

// ─── The lease ───────────────────────────────────────────────────────────────

/**
 * Is this episode's reason on screen right now?
 *
 * Read LIVE when a status is chosen, never cached: a boolean destructured off a
 * result object can describe a magmux that has since exited.
 *
 * The window is HALF-OPEN: at exactly `UI_LEASE_MS` after the last
 * acknowledgement the lease has already lapsed. For a gate that decides a
 * retryable status, the stricter reading is the right one.
 */
export function uiLeaseValid(episodeId: string): boolean {
  if (!state.control || state.targetPane === null) return false;
  const last = state.leases.get(episodeId);
  if (last === undefined) return false;
  return recoveryClock().now() - last < UI_LEASE_MS;
}

/** Diagnostics for the log and for tests. Never used to decide anything. */
export function describeLease(episodeId: string): {
  connected: boolean;
  targetPane: number | null;
  lastAckAgoMs: number | null;
  valid: boolean;
} {
  const last = state.leases.get(episodeId);
  return {
    connected: state.control !== null,
    targetPane: state.targetPane,
    lastAckAgoMs: last === undefined ? null : Math.round(recoveryClock().now() - last),
    valid: uiLeaseValid(episodeId),
  };
}

/**
 * The recovery banner owns the pane right now: an outage is being painted (its
 * tick runs), a lease is held, or the recovered outcome is lingering. The
 * interactive driver never types an injection while this is true: the overlay
 * sits on top of the screen it reads, and the turn it would start is the turn
 * the outage is holding (architecture §7.5, the delivery gate).
 */
export function recoveryOverlayHeld(): boolean {
  return state.tickTimer !== null || state.lingerTimer !== null || state.leases.size > 0;
}

// ─── The magmux control connection ───────────────────────────────────────────

async function connectControl(sock: string): Promise<Socket | null> {
  try {
    return await new Promise<Socket>((resolve, reject) => {
      const s = netConnect(sock);
      s.once("connect", () => resolve(s));
      s.once("error", reject);
    });
  } catch {
    return null;
  }
}

/** Send one control message and wait for the `reply` carrying the same id. */
function request(
  socket: Socket,
  msg: Record<string, unknown>,
  timeoutMs = CONTROL_TIMEOUT_MS
): Promise<Record<string, unknown> | null> {
  const id = state.nextControlId++;
  return new Promise((resolve) => {
    let buf = "";
    let settled = false;
    const finish = (v: Record<string, unknown> | null) => {
      if (settled) return;
      settled = true;
      socket.removeListener("data", onData);
      clearTimeout(timer);
      resolve(v);
    };
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        if (!line) continue;
        try {
          const evt = JSON.parse(line) as Record<string, unknown>;
          if (evt.type === "reply" && evt.id === id) finish(evt);
        } catch {
          /* magmux emits live events on the same stream; ignore what is not ours */
        }
      }
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    socket.on("data", onData);
    try {
      socket.write(`${JSON.stringify({ ...msg, id })}\n`);
    } catch {
      finish(null);
    }
  });
}

/** Forget the connection. Every lease goes with it, at once. */
function dropConnection(): void {
  state.control = null;
  state.targetPane = null;
  state.leases.clear();
}

/**
 * Which pane is ours, in a magmux claudish did not launch: process ancestry
 * against `list` (`pane/own-pane.ts`, shared with the interactive driver). Null
 * when nothing matches: the banner is then unavailable, and recovery still
 * retries and still answers the inline error at exhaustion.
 */
function findPaneOf(socket: Socket): Promise<number | null> {
  return findOwnPane(async () => (await request(socket, { type: "list" }))?.result ?? null);
}

/** Connect once and find our pane. Concurrent callers share one attempt. */
function ensureConnected(): Promise<boolean> {
  if (state.control && state.targetPane !== null) return Promise.resolve(true);
  if (state.paneNotFound) return Promise.resolve(false);
  if (state.connecting) return state.connecting;
  state.connecting = (async () => {
    const endpoint = resolveControlEndpoint();
    if (!endpoint) {
      noteUnavailable(
        "[Recovery] no magmux control endpoint — no banner; recovery continues without one"
      );
      return false;
    }
    const socket = await connectControl(endpoint.sock);
    if (!socket) {
      noteUnavailable(`[Recovery] could not reach magmux at ${endpoint.sock} — no banner`);
      return false;
    }
    // Bound to THIS socket: a late `close` from a replaced connection must not
    // tear down its successor and every lease with it.
    const onGone = () => {
      if (state.control === socket) dropConnection();
    };
    socket.on("error", onGone);
    socket.on("close", onGone);
    state.control = socket;
    // A magmux claudish launched has exactly one `-e` pane, and magmux numbers
    // `-e` panes 0..N-1 in argument order, so Claude Code is pane 0.
    const pane = endpoint.wrapped ? 0 : await findPaneOf(socket);
    if (pane === null) {
      state.paneNotFound = true;
      log("[Recovery] this claudish's pane was not found in magmux — no banner");
      try {
        socket.end();
      } catch {
        /* already gone */
      }
      dropConnection();
      return false;
    }
    state.targetPane = pane;
    state.unavailableLogged = false;
    log(
      `[Recovery] banner will draw on magmux pane ${pane} ` +
        `(${endpoint.wrapped ? "magmux launched by claudish" : "ambient magmux"})`
    );
    return true;
  })().finally(() => {
    state.connecting = null;
  });
  return state.connecting;
}

// ─── The banner text ─────────────────────────────────────────────────────────

/** `9s`, `1m 26s`, `2h 5m`. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Word-wrap one sentence to `cols`, never splitting a word. */
function wrap(text: string, cols: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > cols) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out;
}

const KIND_WORD: Record<RecoveryEpisodeFrame["kind"], string> = {
  refused: "refused",
  dns: "not found",
  unreachable: "unreachable",
};

/**
 * The outage banner.
 *
 * THE FIRST LINE MUST STAND ALONE. On a pane too small for the box, magmux
 * falls back to a one-line pill that shows only the first line.
 */
export function bannerText(frame: RecoveryEpisodeFrame, nowMs: number): string {
  const lines: string[] = [`✗ NETWORK · ${frame.providerDisplayName} ${KIND_WORD[frame.kind]}`];
  lines.push(...wrap(frame.reason, OVERLAY_WRAP_COLS));
  lines.push(`${frame.host} · ${frame.code ?? frame.kind}${frame.loopback ? " · local" : ""}`);
  const elapsed = formatElapsed(nowMs - frame.startedAtMs);
  // An episode exists only because an attempt already failed, but the banner is
  // first drawn the instant the episode opens — before the coordinator has
  // counted that attempt or registered the request holding it. Measured: the
  // first frame read `attempt 0` and `0 requests held` for up to a second.
  const attempt = Math.max(1, frame.attempts);
  if (frame.state === "handoff") {
    lines.push(`handed back to Claude Code · waiting for its retry · ${elapsed} in recovery`);
  } else if (frame.nextAttemptAtMs === null) {
    lines.push(`connecting to ${frame.host}… · attempt ${attempt} · ${elapsed} in recovery`);
  } else {
    const secs = Math.max(0, Math.ceil((frame.nextAttemptAtMs - nowMs) / 1000));
    lines.push(`next attempt in ${secs}s · attempt ${attempt} · ${elapsed} in recovery`);
  }
  const counts: string[] = [];
  if (frame.waiters > 0)
    counts.push(`${frame.waiters} request${frame.waiters === 1 ? "" : "s"} held`);
  if (frame.otherEpisodes > 0) {
    counts.push(`+${frame.otherEpisodes} more outage${frame.otherEpisodes === 1 ? "" : "s"}`);
  }
  if (counts.length > 0) lines.push(counts.join(" · "));
  lines.push("Esc in Claude Code stops the turn");
  return lines.join("\n");
}

/** The banner shown for a moment after the connection comes back. */
export function recoveredText(frame: RecoveryEpisodeFrame, nowMs: number): string {
  return [
    `✓ NETWORK · ${frame.providerDisplayName} recovered`,
    `${frame.attempts} attempt${frame.attempts === 1 ? "" : "s"} over ${formatElapsed(nowMs - frame.startedAtMs)}`,
  ].join("\n");
}

// ─── Painting ────────────────────────────────────────────────────────────────

/** Paint one outage frame. Only an acknowledged write renews a lease. */
async function paint(frame: RecoveryEpisodeFrame): Promise<void> {
  if (state.painting) return;
  state.painting = true;
  try {
    if (!(await ensureConnected())) return;
    const socket = state.control;
    const pane = state.targetPane;
    if (!socket || pane === null) return;
    const reply = await request(socket, {
      type: "overlay",
      pane,
      text: bannerText(frame, Date.now()),
      style: "error",
    });
    const ok = reply?.ok === true;
    // The reply can arrive AFTER the episode it painted has closed — the close
    // cleared the overlay while this write was still in flight. Renewing then
    // would report a banner for up to UI_LEASE_MS that is no longer on screen,
    // and the red tint sent below would land after the clear and stay. So an
    // acknowledgement counts only for an episode the coordinator still holds.
    if (ok && !episodeIsLive(frame.episodeId)) {
      state.lastPaintOk = ok;
      return;
    }
    if (ok) {
      const first = !state.leases.has(frame.episodeId);
      state.leases.set(frame.episodeId, recoveryClock().now());
      state.lastFrame = frame;
      if (first) {
        log(
          `[Recovery] banner painted for episode ${frame.episodeId} on magmux pane ${pane} ` +
            "— lease granted"
        );
      }
      // Decoration. Its reply grants nothing, so nothing waits on it.
      void request(socket, { type: "tint", pane, color: "red" });
    } else if (state.lastPaintOk !== false) {
      log(`[Recovery] magmux did not acknowledge the banner: ${JSON.stringify(reply)}`);
    }
    state.lastPaintOk = ok;
  } finally {
    state.painting = false;
  }
}

/** Replace the overlay outright. Grants no lease. */
async function writeOverlay(text: string, style: string, tint: string): Promise<void> {
  const socket = state.control;
  const pane = state.targetPane;
  if (!socket || pane === null) return;
  await request(socket, { type: "overlay", pane, text, style });
  await request(socket, { type: "tint", pane, color: tint });
}

function clearOverlay(): Promise<void> {
  return writeOverlay("", "", "reset");
}

function stopTick(): void {
  if (state.tickTimer !== null) {
    recoveryClock().clearTimeout(state.tickTimer);
    state.tickTimer = null;
  }
}

function cancelLinger(): void {
  if (state.lingerTimer !== null) {
    recoveryClock().clearTimeout(state.lingerTimer);
    state.lingerTimer = null;
  }
}

/**
 * Paint now, then once per `FRAME_TICK_MS` for as long as any outage is live.
 *
 * The tick is independent of the ladder on purpose. A connect against an
 * unreachable host takes up to 75 s with nothing new to say, and the lease has
 * to stay fresh across it — renewing only on ladder events would let it lapse
 * at exhaustion, for exactly the failure class this feature exists for.
 */
function startTick(): void {
  if (state.tickTimer !== null) return;
  const clock = recoveryClock();
  const loop = () => {
    state.tickTimer = null;
    const frame = renderableEpisodeFrame();
    if (!frame) return;
    void paint(frame);
    const t = clock.setTimeout(loop, FRAME_TICK_MS);
    clock.unref?.(t);
    state.tickTimer = t;
  };
  loop();
}

// ─── The hooks ───────────────────────────────────────────────────────────────

function onEpisodeOpened(episodeId: string): void {
  // Asking and being told no is still asking: the coordinator's grace rule
  // measures from this, so it is recorded even when there is no magmux.
  markPaneRequested(episodeId);
  cancelLinger();
  startTick();
}

/**
 * One episode ended. The coordinator has already removed it from the live set,
 * so `renderableEpisodeFrame()` here answers "is another outage still live?".
 */
function onEpisodeClosed(episodeId: string, outcome: RecoveryOutcome, attempts: number): void {
  state.leases.delete(episodeId);
  if (renderableEpisodeFrame() !== null) return; // the tick keeps drawing the other one
  stopTick();
  const last = state.lastFrame?.episodeId === episodeId ? state.lastFrame : null;
  state.lastFrame = null;
  if (outcome !== "recovered" || !last) {
    // Esc in Claude Code, shutdown, an expired hand-off: nothing is being held
    // any more, so there is nothing to explain.
    void clearOverlay();
    return;
  }
  // The final count, not the last painted frame's: that frame predates the
  // attempt that succeeded. Measured: the banner read 7 while the log said 8.
  void writeOverlay(recoveredText({ ...last, attempts }, Date.now()), "success", "green");
  cancelLinger();
  const clock = recoveryClock();
  const timer = clock.setTimeout(() => {
    state.lingerTimer = null;
    if (renderableEpisodeFrame() !== null) return; // a new outage owns the overlay
    void clearOverlay();
  }, OUTCOME_LINGER_MS);
  clock.unref?.(timer);
  state.lingerTimer = timer;
}

const hooks: RecoveryUiHooks = {
  onEpisodeOpened,
  onEpisodeClosed,
  leaseValid: (episodeId) => uiLeaseValid(episodeId),
};

/**
 * Install the banner into the coordinator.
 *
 * Called only from `claude-runner.ts`, for an interactive launch that has a
 * magmux to draw on. Every other entry point — `-p`, `--stdin`, `serve`, the
 * MCP server, the test suite — leaves it uninstalled, so none of them can hold
 * a lease, without any of them having to opt out.
 */
export function installRecoveryUi(controlSock: string | null): void {
  explicitControlSock = controlSock;
  if (installed) return;
  installed = true;
  registerRecoveryUi(hooks);
}

/** Take the banner down and uninstall. Claude Code's exit, proxy shutdown, tests. */
export async function shutdownRecoveryUi(): Promise<void> {
  stopTick();
  cancelLinger();
  if (state.control && state.targetPane !== null) {
    // Short: at Claude Code's exit magmux is usually exiting too.
    const socket = state.control;
    const pane = state.targetPane;
    await request(socket, { type: "overlay", pane, text: "", style: "" }, 500);
    await request(socket, { type: "tint", pane, color: "reset" }, 500);
  }
  if (state.control) {
    try {
      state.control.end();
    } catch {
      /* already gone */
    }
  }
  dropConnection();
  state.lastFrame = null;
  state.lastPaintOk = null;
  state.unavailableLogged = false;
  state.paneNotFound = false;
  registerRecoveryUi(null);
  installed = false;
  explicitControlSock = null;
}

/** Tests only: the banner is process state shared with every sibling test. */
export function __resetUiStateForTests(): void {
  stopTick();
  cancelLinger();
  if (state.control) {
    try {
      state.control.destroy();
    } catch {
      /* already gone */
    }
  }
  dropConnection();
  state.connecting = null;
  state.lastFrame = null;
  state.painting = false;
  state.lastPaintOk = null;
  state.unavailableLogged = false;
  state.paneNotFound = false;
  registerRecoveryUi(null);
  installed = false;
  explicitControlSock = null;
}
