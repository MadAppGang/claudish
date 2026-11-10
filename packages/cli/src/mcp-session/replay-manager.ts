/**
 * The replays this server holds: finished sessions opened as their real interface, read only.
 *
 * A replay is not a session. It lives in these maps alone, so `list_sessions`, the accounting,
 * the session limit and `team(mode:"list")` cannot see it. The three reads take a `replay_id`
 * where they take a `session_id`, and the MCP handler routes them here before any session
 * lookup.
 *
 * `open` classifies and registers synchronously, before its first await, so a second open of
 * the same target finds the entry and waits on the same promise: one process, one id, one
 * error. A failed open removes its entry, so the next call tries again.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { constants, accessSync, closeSync, existsSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { findClaudeBinary } from "../claude-runner.js";
import {
  type CaptureResult,
  type CaptureUnchanged,
  ContractErrorException,
  DEFAULT_PANE_COLS,
  DEFAULT_PANE_ROWS,
  type ReplayCloseResult,
  type ReplayOpenResult,
  type ReplayPane,
  type ReplayTarget,
  type ReplayUnavailableReason,
  type ResizeResult,
  type ScrollRequest,
  type ScrollResult,
  clampPaneSize,
  isUuid,
  openContainedTranscript,
  startReplayPane,
} from "../pane/index.js";
import { type ReplayViewItem, targetOfReplay } from "../pane/view-contract.js";
import { transcriptPathFor } from "../session/session-discovery.js";
import { type ClaimCaller, MCP_CALLER, type ViewClaims } from "../view/view-claims.js";
import type { ViewFeed } from "../view/view-feed.js";

/** How long an open waits for the box before it answers with the current screen. */
export const REPLAY_READY_MS = 15_000;
/** Finished replays kept for `capture`; a screen can be 4 M cells, and a caller may never close. */
export const FINISHED_REPLAYS_MAX = 20;

export interface ReplayManagerOptions {
  parentEnv?: Record<string, string | undefined>;
  /** the `claude` to run; default `findClaudeBinary(parentEnv)` */
  claudeBinary?: string;
  magmuxBinary?: string;
  sockRoot?: string;
  readyMs?: number;
}

interface ReplayEntry {
  replayId: string;
  /** the claude session uuid */
  targetKey: string;
  /** null until the start has constructed it */
  pane: ReplayPane | null;
  /** resolves once the open has an answer; rejects with its `replay_unavailable` */
  opening: Promise<void>;
  finishedAt: number | null;
  of: ReplayViewItem["of"];
  model: string | null;
}

function unavailable(reason: ReplayUnavailableReason, message: string): ContractErrorException {
  return new ContractErrorException("replay_unavailable", message, reason);
}

function unknownReplay(id: string): ContractErrorException {
  return new ContractErrorException("unknown_session", `no replay ${id} is open on this server`);
}

/** The target's own folder when it is still a directory, else the server's working directory. */
function replayCwd(own: string | null): string {
  if (own) {
    try {
      if (statSync(own).isDirectory()) return realpathSync(own);
    } catch {
      // the folder is gone: the server's own directory is trusted, a new one would not be
    }
  }
  return realpathSync(process.cwd());
}

/**
 * The `claude` a replay runs, as an absolute path. A `CLAUDE_PATH` that is set names the only
 * binary: when it is not an executable file the open fails, because `findClaudeBinary` would go
 * on to the user's own installation, and a replay would then start a Claude Code nobody asked
 * for. A relative one is resolved against the server's working directory before the check: the
 * launcher runs it after `cd` into the replay's folder, where the same words name another file.
 */
async function replayClaudeBinary(env: Record<string, string | undefined>): Promise<string> {
  const named = env.CLAUDE_PATH ? resolve(env.CLAUDE_PATH) : "";
  if (named) {
    try {
      if (!statSync(named).isFile()) throw new Error("not a file");
      accessSync(named, constants.X_OK);
    } catch {
      throw new Error(`CLAUDE_PATH ${named} is not an executable file`);
    }
    return named;
  }
  const found = await findClaudeBinary(env);
  if (!found) throw new Error("claude not found");
  return found;
}

export class ReplayManager {
  private readonly byId = new Map<string, ReplayEntry>();
  private readonly openByTarget = new Map<string, ReplayEntry>();
  private readonly parentEnv: Record<string, string | undefined>;
  private readonly readyMs: number;
  private shuttingDown = false;
  private feed: ViewFeed | null = null;
  private claims: ViewClaims | null = null;

  constructor(private readonly options: ReplayManagerOptions = {}) {
    this.parentEnv = options.parentEnv ?? process.env;
    this.readyMs = options.readyMs ?? REPLAY_READY_MS;
  }

  /** Bound once at startup; `replay_session` and the local transport then share the holders. */
  setViewServices(services: { feed: ViewFeed; claims: ViewClaims }): void {
    this.feed = services.feed;
    this.claims = services.claims;
  }

  /** Every replay this server holds, oldest first. */
  list(): Array<Omit<ReplayViewItem, "view">> {
    return [...this.byId.values()].map((e) => ({
      kind: "replay" as const,
      target: targetOfReplay(e.replayId),
      replay_id: e.replayId,
      of: e.of,
      model: e.model,
      final: e.finishedAt !== null,
      magmux: e.pane ? { pane_id: e.pane.paneId, view_socket: e.pane.viewSockPath } : null,
      herdr_workspaces: [],
    }));
  }

  /** From now on an open refuses, also one between the awaits of its start. */
  beginShutdown(): void {
    this.shuttingDown = true;
  }

  async open(
    target: ReplayTarget,
    size: { cols?: number; rows?: number } = {}
  ): Promise<ReplayOpenResult> {
    const uuid = this.classify(target);
    const shared = this.openByTarget.get(uuid);
    if (shared) return this.answerOf(shared);
    if (this.shuttingDown) throw unavailable("spawn_failed", "the server is shutting down");

    const forkUuid = randomUUID();
    const cwd = replayCwd(target.cwd);
    // absolute against the server's directory: `claude` reads its config dir after the launcher's
    // `cd`, and the fork record it writes there is the path the cleanup removes
    const projectsRoot = resolve(target.projectsRoot);
    const forkPath = transcriptPathFor(cwd, forkUuid, projectsRoot);
    const entry: ReplayEntry = {
      replayId: `replay-${randomBytes(8).toString("hex")}`,
      targetKey: uuid,
      pane: null,
      opening: Promise.resolve(),
      finishedAt: null,
      of: target.of ?? { session_id: uuid },
      model: target.model ?? null,
    };
    this.byId.set(entry.replayId, entry);
    this.openByTarget.set(uuid, entry);
    entry.opening = this.run(entry, {
      claudeSessionId: uuid,
      forkUuid,
      cwd,
      projectsRoot,
      forkPath,
      // read before the spawn: Claude Code creates this directory when it writes a record
      removeProjectDir: !existsSync(dirname(forkPath)),
      configDir: dirname(projectsRoot),
      cols: size.cols ?? DEFAULT_PANE_COLS,
      rows: size.rows ?? DEFAULT_PANE_ROWS,
    });
    return this.answerOf(entry);
  }

  /** The last screen of a finished replay stays readable until it is closed or evicted. */
  capture(
    id: string,
    sinceSeq?: number,
    spans?: boolean,
    caller: ClaimCaller = MCP_CALLER
  ): CaptureResult | CaptureUnchanged {
    const answer = this.paneOf(id).capture(sinceSeq, { spans: spans === true });
    if (!this.claims) return answer;
    const target = targetOfReplay(id);
    this.claims.renewFromCapture(target, caller);
    return this.claims.stamp(answer, target, caller);
  }

  async resize(
    id: string,
    cols: number,
    rows: number,
    caller: ClaimCaller = MCP_CALLER
  ): Promise<ResizeResult> {
    const pane = this.paneOf(id);
    const target = targetOfReplay(id);
    if (!pane.finished()) this.claims?.claim(target, caller);
    const answer: ResizeResult = { session_id: id, ...(await pane.resize(cols, rows)) };
    return this.claims ? this.claims.stamp(answer, target, caller) : answer;
  }

  async scroll(id: string, req: ScrollRequest): Promise<ScrollResult> {
    const r = await this.paneOf(id).scroll(req);
    return { session_id: id, seq: r.seq };
  }

  /** Any id answers. The entry stays until the one reap ended, so a second close awaits it too. */
  async close(id: string): Promise<ReplayCloseResult> {
    const entry = this.byId.get(id);
    if (!entry) return { closed: true };
    try {
      await entry.opening;
    } catch {
      // a failed open has already reaped its pane and removed its entry
    }
    const verified = entry.pane ? await entry.pane.close() : true;
    this.forget(entry);
    this.claims?.forget(targetOfReplay(id));
    this.feed?.removed(targetOfReplay(id), "replay_closed");
    return verified ? { closed: true } : { closed: true, reap_unverified: true };
  }

  /** The target's uuid, lowercase; or the reason it cannot be replayed. Reads the file, keeps nothing. */
  private classify(target: ReplayTarget): string {
    if (!target.writerGone) throw unavailable("session_live", "the session is still running");
    const id = target.claudeSessionId;
    const path = target.transcriptPath;
    if (!isUuid(id) || !path)
      throw unavailable("no_record", "the session has no Claude Code record");
    const uuid = id.toLowerCase();
    const fd = openContainedTranscript(path, uuid, target.projectsRoot);
    if (fd === null) throw unavailable("no_record", "the session's Claude Code record is gone");
    closeSync(fd);
    return uuid;
  }

  private async answerOf(entry: ReplayEntry): Promise<ReplayOpenResult> {
    await entry.opening;
    const answer: ReplayOpenResult = { replay_id: entry.replayId, seq: entry.pane?.seq() ?? 0 };
    return this.claims
      ? this.claims.stamp(answer, targetOfReplay(entry.replayId), MCP_CALLER)
      : answer;
  }

  private paneOf(id: string): ReplayPane {
    const pane = this.byId.get(id)?.pane;
    if (!pane) throw unknownReplay(id);
    return pane;
  }

  /** The start, the wait for the box, and the failures that leave nothing behind. */
  private async run(
    entry: ReplayEntry,
    a: {
      claudeSessionId: string;
      forkUuid: string;
      cwd: string;
      projectsRoot: string;
      forkPath: string;
      removeProjectDir: boolean;
      configDir: string;
      cols: number;
      rows: number;
    }
  ): Promise<void> {
    try {
      const claudeBinary = this.options.claudeBinary ?? (await replayClaudeBinary(this.parentEnv));
      entry.pane = await startReplayPane({
        claudeSessionId: a.claudeSessionId,
        forkUuid: a.forkUuid,
        claudeBinary,
        cwd: a.cwd,
        projectsRoot: a.projectsRoot,
        forkPath: a.forkPath,
        removeProjectDir: a.removeProjectDir,
        configDir: a.configDir,
        size: clampPaneSize(a.cols, a.rows),
        parentEnv: this.parentEnv,
        sockRoot: this.options.sockRoot,
        magmuxBinary: this.options.magmuxBinary,
        label: a.claudeSessionId.slice(0, 8),
        onFinish: () => this.onFinished(entry),
        refused: () => this.shuttingDown,
        onViewSocket: () => this.notify(entry),
      });
      this.notify(entry);
    } catch (e) {
      this.forget(entry);
      this.feed?.removed(targetOfReplay(entry.replayId), "replay_closed");
      throw unavailable("spawn_failed", e instanceof Error ? e.message : String(e));
    }
    const ready = await entry.pane.ready(this.readyMs);
    if (ready.kind === "box" || ready.kind === "slow") return;
    await entry.pane.close();
    this.forget(entry);
    this.feed?.removed(targetOfReplay(entry.replayId), "replay_closed");
    if (ready.kind === "dialog")
      throw unavailable("boot_dialog", `a dialog replaced the input box: ${ready.name}`);
    throw unavailable("spawn_failed", ready.detail);
  }

  /** A later open starts fresh; `byId` still answers `final:true`, up to the bound. */
  private onFinished(entry: ReplayEntry): void {
    entry.finishedAt = Date.now();
    if (this.openByTarget.get(entry.targetKey) === entry) this.openByTarget.delete(entry.targetKey);
    this.notify(entry);
    const finished = [...this.byId.values()]
      .filter((e) => e.finishedAt !== null)
      .sort((x, y) => (x.finishedAt as number) - (y.finishedAt as number));
    for (const old of finished.slice(0, Math.max(0, finished.length - FINISHED_REPLAYS_MAX))) {
      this.byId.delete(old.replayId);
      this.claims?.forget(targetOfReplay(old.replayId));
      this.feed?.removed(targetOfReplay(old.replayId), "evicted");
    }
  }

  private notify(entry: ReplayEntry): void {
    this.feed?.changed(targetOfReplay(entry.replayId), true);
  }

  private forget(entry: ReplayEntry): void {
    this.byId.delete(entry.replayId);
    if (this.openByTarget.get(entry.targetKey) === entry) this.openByTarget.delete(entry.targetKey);
  }
}
