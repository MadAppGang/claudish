/**
 * What this server can show a local client, addressed by target (`s:`, `t:`, `r:`). It composes
 * the owners' rows and details into `ViewItem`s and routes the read and resize ops to the owner
 * of a target.
 *
 * Rows always carry the absolute holder from `ViewClaims`, because a local client reads holders
 * with absolute names (only an MCP answer is relative to the server answering it). Replay items
 * list this server's own replays.
 */

import {
  type CaptureResult,
  type CaptureUnchanged,
  ContractErrorException,
  type ReplayCloseResult,
  type SessionRow,
  type TeamTranscriptResult,
  type TranscriptResult,
  decodeCursor,
  isTerminalState,
} from "../pane/index.js";
import {
  type ReplayViewItem,
  type ViewDetail,
  ViewError,
  type ViewItem,
  type ViewResizeAnswer,
  parseViewTarget,
  targetOfSession,
  targetOfSlot,
} from "../pane/view-contract.js";
import type { TeamViewSlot } from "../team-orchestrator.js";
import type { ClaimCaller, ViewClaims } from "./view-claims.js";

/** The parts of `SessionManager` the directory reads. */
export interface ViewSessionSource {
  sessionRow(id: string): SessionRow | null;
  viewDetail(id: string): ViewDetail | null;
  listSessionRows(includeCompleted?: boolean): SessionRow[];
  captureSession(
    id: string,
    sinceSeq?: number,
    spans?: boolean,
    caller?: ClaimCaller
  ): CaptureResult | CaptureUnchanged;
  transcriptSession(
    id: string,
    since?: ReturnType<typeof decodeCursor>
  ): TranscriptResult | TeamTranscriptResult;
  resizeSession(
    id: string,
    cols: number,
    rows: number,
    caller?: ClaimCaller
  ): Promise<ViewResizeAnswer>;
}

/** The team registry's view ops. */
export interface ViewTeamSource {
  listSlots(includeFinished: boolean): TeamViewSlot[];
  slot(runId: string, slot: string): TeamViewSlot | null;
  capture(
    runId: string,
    slot: string,
    sinceSeq?: number,
    spans?: boolean,
    caller?: ClaimCaller
  ): CaptureResult | CaptureUnchanged;
  transcript(
    runId: string,
    slot: string,
    since?: ReturnType<typeof decodeCursor>
  ): TranscriptResult | TeamTranscriptResult;
  resize(
    runId: string,
    slot: string,
    cols: number,
    rows: number,
    caller?: ClaimCaller
  ): Promise<ViewResizeAnswer>;
}

/** The parts of `ReplayManager` the directory reads. */
export interface ViewReplaySource {
  list(): Array<Omit<ReplayViewItem, "view">>;
  capture(
    id: string,
    sinceSeq?: number,
    spans?: boolean,
    caller?: ClaimCaller
  ): CaptureResult | CaptureUnchanged;
  resize(id: string, cols: number, rows: number, caller?: ClaimCaller): Promise<ViewResizeAnswer>;
  close?(id: string): Promise<ReplayCloseResult>;
}

export interface ViewDirectoryOptions {
  sessions: ViewSessionSource;
  team: ViewTeamSource;
  replays: ViewReplaySource;
  claims: ViewClaims;
}

function badTarget(target: string): ViewError {
  return new ViewError("invalid_args", `not a view target: ${JSON.stringify(target)}`);
}

export class ViewDirectory {
  constructor(private readonly o: ViewDirectoryOptions) {}

  items(includeFinished = false): ViewItem[] {
    const out: ViewItem[] = [];
    for (const row of this.o.sessions.listSessionRows(includeFinished)) {
      const item = this.sessionItem(row);
      if (item) out.push(item);
    }
    for (const slot of this.o.team.listSlots(includeFinished)) out.push(this.slotItem(slot));
    for (const replay of this.o.replays.list()) {
      if (replay.final && !includeFinished) continue;
      out.push(this.replayItem(replay));
    }
    return out;
  }

  item(target: string): ViewItem | null {
    const t = parseViewTarget(target);
    if (!t) return null;
    switch (t.kind) {
      case "session": {
        const row = this.o.sessions.sessionRow(t.sessionId);
        return row ? this.sessionItem(row) : null;
      }
      case "team_slot": {
        const slot = this.o.team.slot(t.runId, t.slot);
        return slot ? this.slotItem(slot) : null;
      }
      case "replay": {
        const replay = this.o.replays.list().find((r) => r.replay_id === t.replayId);
        return replay ? this.replayItem(replay) : null;
      }
    }
  }

  capture(
    target: string,
    sinceSeq: number | undefined,
    spans: boolean | undefined,
    caller: ClaimCaller
  ): CaptureResult | CaptureUnchanged {
    const t = parseViewTarget(target);
    if (!t) throw badTarget(target);
    switch (t.kind) {
      case "session":
        return this.o.sessions.captureSession(t.sessionId, sinceSeq, spans, caller);
      case "team_slot":
        return this.o.team.capture(t.runId, t.slot, sinceSeq, spans, caller);
      case "replay":
        return this.o.replays.capture(t.replayId, sinceSeq, spans, caller);
    }
  }

  transcript(target: string, since: string | undefined): TranscriptResult | TeamTranscriptResult {
    const t = parseViewTarget(target);
    if (!t) throw badTarget(target);
    const cursor = since === undefined ? undefined : decodeCursor(since);
    switch (t.kind) {
      case "session":
        return this.o.sessions.transcriptSession(t.sessionId, cursor);
      case "team_slot":
        return this.o.team.transcript(t.runId, t.slot, cursor);
      case "replay":
        throw new ContractErrorException("unknown_session", `no session ${t.replayId}`);
    }
  }

  /** The owner's resize path: the one owner of the pane's size, and the one place a claim is taken. */
  resize(
    target: string,
    cols: number,
    rows: number,
    caller: ClaimCaller
  ): Promise<ViewResizeAnswer> {
    const t = parseViewTarget(target);
    if (!t) throw badTarget(target);
    switch (t.kind) {
      case "session":
        return this.o.sessions.resizeSession(t.sessionId, cols, rows, caller);
      case "team_slot":
        return this.o.team.resize(t.runId, t.slot, cols, rows, caller);
      case "replay":
        return this.o.replays.resize(t.replayId, cols, rows, caller);
    }
  }

  private sessionItem(row: SessionRow): ViewItem | null {
    const detail = this.o.sessions.viewDetail(row.session_id);
    if (!detail) return null;
    const target = targetOfSession(row.session_id);
    return { ...row, ...detail, view: this.o.claims.holder(target), kind: "session", target };
  }

  private slotItem(s: TeamViewSlot): ViewItem {
    const target = targetOfSlot(s.runId, s.row.slot);
    return {
      ...s.row,
      ...s.detail,
      view: this.o.claims.holder(target),
      kind: "team_slot",
      target,
      run_id: s.runId,
      run_path: s.runPath,
      run_kind: s.runKind,
    };
  }

  private replayItem(r: Omit<ReplayViewItem, "view">): ReplayViewItem {
    return {
      ...r,
      view: this.o.claims.holder(r.target),
    };
  }
}

/** Whether a row is finished, for a subscription that hides finished items. */
export function isFinishedItem(item: ViewItem): boolean {
  return item.kind === "replay" ? item.final : isTerminalState(item.state);
}
