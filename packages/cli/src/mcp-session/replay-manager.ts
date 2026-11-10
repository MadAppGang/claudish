/**
 * The replays this server takes part in: finished sessions opened as their real interface, read
 * only. One replay per Claude session runs across every MCP server under the socket root.
 *
 * A replay is not a session. It lives in these maps alone, so `list_sessions`, the accounting,
 * the session limit and `team(mode:"list")` cannot see it. The three reads take a `replay_id`
 * where they take a `session_id`, and the MCP handler routes them here before any session
 * lookup.
 *
 * The exclusion is a kernel lock, `<root>/replays/<uuid>.lock`: the opener takes it with
 * `LOCK_EX|LOCK_NB` and hands its descriptor to the replay's magmux, so the kernel holds it
 * exactly as long as that magmux lives. Only a holder of the lock reaches the spawn, so a second
 * replay process has no code path. The registry entry next to it is only a directory of whom to
 * dial. An entry is one of:
 *   - owned: the replay pane runs here; this server answers every holder of it;
 *   - remote: another server owns it; this server's MCP verbs are relayed to that owner over a
 *     peer link, and it is never listed (one replay is one item machine-wide).
 *
 * `open` registers its slot synchronously, before its first await, so a second open of the same
 * target in this process waits on the same promise. A failed open removes its slot, so the next
 * call tries again. Where `flock` cannot be bound, replays are per server, as before: no
 * registry, no remote entry, no redirect.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { constants, accessSync, closeSync, existsSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { findClaudeBinary } from "../claude-runner.js";
import { log } from "../logger.js";
import {
  type CaptureResult,
  type CaptureUnchanged,
  ContractErrorException,
  DEFAULT_PANE_COLS,
  DEFAULT_PANE_ROWS,
  type ReplayCloseResult,
  type ReplayOpenResult,
  type ReplayTarget,
  type ReplayUnavailableReason,
  type ResizeResult,
  type ScrollRequest,
  type ScrollResult,
  TRANSCRIPT_GRACE_MS,
  type ViewHolder,
  clampPaneSize,
  isUuid,
  openContainedTranscript,
  startReplayPane,
} from "../pane/index.js";
import { mintPaneId, sockRootFor } from "../pane/pane-launch.js";
import { recordPathOf } from "../pane/process-identity.js";
import type { ReplayPaneOptions, ReplayReady } from "../pane/replay-pane.js";
import {
  type ReplayViewItem,
  ViewError,
  type ViewMagmux,
  targetOfReplay,
} from "../pane/view-contract.js";
import { transcriptPathFor } from "../session/session-discovery.js";
import { type KernelLock, KernelLockUnavailable, flockAvailable } from "../view/kernel-lock.js";
import {
  type PeerEnd,
  type PeerLink,
  PeerLinks,
  type PeerPlaceAsk,
  type ReplayOpenWire,
} from "../view/peer-link.js";
import { ReplayRegistry } from "../view/replay-registry.js";
import { type ClaimCaller, MCP_CALLER, type ViewClaims } from "../view/view-claims.js";
import type { ViewFeed } from "../view/view-feed.js";

/** How long an open waits for the box before it answers with the current screen. */
export const REPLAY_READY_MS = 15_000;
/** Finished replays kept for `capture`; a screen can be 4 M cells, and a caller may never close. */
export const FINISHED_REPLAYS_MAX = 20;
/** Beyond the boot wait: how long a loser of the lock keeps polling it and dialing its owner. */
export const REPLAY_JOIN_EXTRA_MS = 10_000;
/** A joined `close_replay` whose owner is unreachable: how long it checks that the replay is gone. */
export const UNREACHABLE_CLOSE_MS = 15_000;
/** Holds one viewer connection may keep, and viewer-opened replays one server may run. */
export const VIEWER_HOLDS_MAX = 4;
export const VIEWER_REPLAYS_MAX = 8;
const POLL_MS = 100;

/** The parts of a replay pane this manager uses; `startReplayPane` makes the real one. */
export interface ReplayPaneLike {
  readonly paneId: string;
  readonly viewSockPath: string | null;
  seq(): number;
  finished(): boolean;
  ready(ms: number): Promise<ReplayReady>;
  capture(sinceSeq?: number, opts?: { spans?: boolean }): CaptureResult | CaptureUnchanged;
  resize(
    cols: number,
    rows: number
  ): Promise<{ cols: number; rows: number; changed: boolean; seq: number }>;
  scroll(req: ScrollRequest): Promise<{ seq: number }>;
  /** true when the process is verified gone */
  close(): Promise<boolean>;
}

export interface ReplayManagerOptions {
  parentEnv?: Record<string, string | undefined>;
  /** the `claude` to run; default `findClaudeBinary(parentEnv)` */
  claudeBinary?: string;
  magmuxBinary?: string;
  sockRoot?: string;
  readyMs?: number;
  /** false: replays are per server (as where `flock` cannot be bound); default `flockAvailable()` */
  shared?: boolean;
  /** tests replace the pane */
  startPane?: (o: ReplayPaneOptions) => Promise<ReplayPaneLike>;
  /** tests replace the dial */
  peers?: PeerLinks;
  joinExtraMs?: number;
  unreachableCloseMs?: number;
}

/** Who asks: this server's Claude Code, or a connection of the local transport. */
export type ReplayOpener =
  | { kind: "mcp" }
  | { kind: "conn"; connId: string; role: "viewer" | "peer" };

const MCP_OPENER: ReplayOpener = { kind: "mcp" };

/** The owner's placement grant, for `replay.open {place}` from a peer. */
export interface ReplayGrants {
  grant(target: string, workspaceKey: string, owner: string, txn: string): boolean;
  doneFor(target: string, workspaceKey: string, owner: string): void;
  workspaces(target: string): string[];
}

/** This server's herdr placer, as the replays see it. */
export interface ReplayPlacer {
  /** this server's workspace key, once the placer runs */
  workspaceKey(): string | null;
  /** this server's MCP link opened or joined a replay it owns */
  owned(target: string): void;
  /** the owner granted this server a placement for a joined replay */
  remote(target: string, txn: string, ownerEndpoint: string): void;
  /** a joined replay stopped being served */
  ended(target: string): void;
}

interface Holds {
  mcp: boolean;
  conns: Set<string>;
}

interface OwnedEntry {
  kind: "owned";
  replayId: string;
  /** the claude session uuid */
  targetKey: string;
  paneId: string;
  pane: ReplayPaneLike | null;
  /** resolves once the open has an answer; rejects with its `replay_unavailable` */
  opening: Promise<void>;
  finishedAt: number | null;
  /** close started: removed from the machine's items, readable by its remaining holders */
  closed: boolean;
  /** this server's Claude Code closed it: its MCP verbs answer `unknown_session` */
  mcpGone: boolean;
  holds: Holds;
  /** started by a viewer's open, counted against `VIEWER_REPLAYS_MAX` while live */
  viewerOpened: boolean;
  /** an entry was written to the registry for it */
  registered: boolean;
  closing: Promise<boolean> | null;
  of: ReplayViewItem["of"];
  model: string | null;
}

interface RemoteEntry {
  kind: "remote";
  replayId: string;
  targetKey: string;
  ownerEndpoint: string;
  paneId: string;
  link: PeerLink;
  finishedAt: number | null;
  /** the last full screen relayed; the final screen once the owner stopped serving it */
  lastScreen: CaptureResult | null;
  /** the `claim_id` of this server's last peer grant: a `claude_code` holder with it is ours */
  lastClaimId: string | null;
  placeTxn: string | null;
  placeKey: string | null;
  of: ReplayViewItem["of"];
  model: string | null;
}

type Entry = OwnedEntry | RemoteEntry;

interface Slot {
  uuid: string;
  entry: Entry | null;
  promise: Promise<Entry>;
}

/** A provisional open that ended in `replay_elsewhere`: a viewer is sent there, an MCP waiter retries. */
class Redirected extends Error {
  constructor(
    readonly endpoint: string,
    readonly replayId: string
  ) {
    super("the replay is owned by another server");
  }
}

export interface ReplayOpenAnswer {
  replay_id: string;
  target: string;
  seq: number;
  magmux: ViewMagmux | null;
  view: ViewHolder | null;
  herdr_workspaces: string[];
  place: boolean;
}

function unavailable(reason: ReplayUnavailableReason, message: string): ContractErrorException {
  return new ContractErrorException("replay_unavailable", message, reason);
}

function unknownReplay(id: string): ContractErrorException {
  return new ContractErrorException("unknown_session", `no replay ${id} is open on this server`);
}

function elsewhere(endpoint: string, replayId: string): ViewError {
  return new ViewError(
    "replay_elsewhere",
    "the replay is open on another server; join it there",
    undefined,
    { endpoint, replay_id: replayId }
  );
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

function callerOf(opener: ReplayOpener): ClaimCaller {
  return opener.kind === "mcp"
    ? MCP_CALLER
    : { kind: "conn", connId: opener.connId, role: opener.role };
}

function isRecordGone(path: string): boolean {
  try {
    statSync(path);
    return false;
  } catch (e) {
    // any other error reads as not verified
    return (e as NodeJS.ErrnoException).code === "ENOENT";
  }
}

export class ReplayManager {
  private readonly byId = new Map<string, Entry>();
  private readonly openByTarget = new Map<string, Slot>();
  /** a joined replay's first answer, for this server's later in-process joins */
  private readonly seqOfJoin = new Map<string, { seq: number; view: ViewHolder | null }>();
  private readonly parentEnv: Record<string, string | undefined>;
  private readonly readyMs: number;
  private readonly root: string;
  private shuttingDown = false;
  private feed: ViewFeed | null = null;
  private claims: ViewClaims | null = null;
  private grants: ReplayGrants | null = null;
  private placer: ReplayPlacer | null = null;
  private endpoint: () => string | null = () => null;
  private registryValue: ReplayRegistry | null = null;
  private peersValue: PeerLinks | null;
  private sharedValue: boolean | null;

  constructor(private readonly options: ReplayManagerOptions = {}) {
    this.parentEnv = options.parentEnv ?? process.env;
    this.readyMs = options.readyMs ?? REPLAY_READY_MS;
    this.root = resolve(options.sockRoot ?? sockRootFor(this.parentEnv));
    this.peersValue = options.peers ?? null;
    this.sharedValue = options.shared ?? null;
  }

  /** Bound once at startup; `replay_session` and the local transport then share the holders. */
  setViewServices(services: { feed: ViewFeed; claims: ViewClaims; grants?: ReplayGrants }): void {
    this.feed = services.feed;
    this.claims = services.claims;
    this.grants = services.grants ?? null;
  }

  /** This server's endpoint name, once bound: what its registry entries and peer hellos name. */
  setEndpoint(name: () => string | null): void {
    this.endpoint = name;
  }

  setPlacer(placer: ReplayPlacer | null): void {
    this.placer = placer;
  }

  /** True when replays are shared across servers through the kernel lock and the registry. */
  get shared(): boolean {
    if (this.sharedValue === null) this.sharedValue = flockAvailable();
    return this.sharedValue;
  }

  get registry(): ReplayRegistry {
    if (!this.registryValue) this.registryValue = new ReplayRegistry(this.root, log);
    return this.registryValue;
  }

  private get peers(): PeerLinks {
    if (!this.peersValue)
      this.peersValue = new PeerLinks({ root: this.root, self: () => this.endpoint() });
    return this.peersValue;
  }

  /** Every replay this server owns and still shows, oldest first. Remote entries are not listed. */
  list(): Array<Omit<ReplayViewItem, "view">> {
    const out: Array<Omit<ReplayViewItem, "view">> = [];
    for (const e of this.byId.values()) {
      if (e.kind !== "owned" || e.closed) continue;
      out.push(this.itemOf(e));
    }
    return out;
  }

  /** A joined replay as the placer reads it: this server never lists it. */
  remoteItem(target: string): Omit<ReplayViewItem, "view"> | null {
    for (const e of this.byId.values())
      if (e.kind === "remote" && targetOfReplay(e.replayId) === target)
        return {
          kind: "replay",
          target,
          replay_id: e.replayId,
          of: e.of,
          model: e.model,
          final: e.finishedAt !== null,
          magmux: null,
          herdr_workspaces: [],
        };
    return null;
  }

  /** The owner endpoint of a joined replay; null for one this server owns. */
  ownerEndpointOf(target: string): string | null {
    for (const e of this.byId.values())
      if (e.kind === "remote" && targetOfReplay(e.replayId) === target) return e.ownerEndpoint;
    return null;
  }

  /**
   * From now on an open refuses, also one between the awaits of its start, and a peer's join
   * answers `unknown_session`, so joiners wait on the lock and then open fresh. Every owned entry
   * is marked closing in the registry.
   */
  beginShutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (!this.shared) return;
    for (const e of this.byId.values())
      if (e.kind === "owned" && e.registered && e.finishedAt === null)
        void this.registry.markClosing(e.targetKey, e.replayId).catch(() => {});
  }

  /** Close every peer link: the owners drop this server's holds and claims. */
  closePeerLinks(): void {
    this.peersValue?.closeAll();
  }

  /** Removes lock files nobody holds and their entries (startup). */
  async sweep(): Promise<string[]> {
    if (!this.shared) return [];
    try {
      return await this.registry.sweep();
    } catch (e) {
      log(`[replay] registry sweep failed: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }

  /* ───────────────────────────── open ───────────────────────────── */

  /** `replay_session` and `team(mode:"replay")`: this server's Claude Code opens or joins. */
  async open(
    target: ReplayTarget,
    size: { cols?: number; rows?: number } = {}
  ): Promise<ReplayOpenResult> {
    const a = await this.openAs(target, size, MCP_OPENER);
    return { replay_id: a.replay_id, seq: a.seq, view: a.view };
  }

  /** A viewer's `replay.open {session_id}` or `{run_id, slot, path}`. */
  openForViewer(target: ReplayTarget, connId: string): Promise<ReplayOpenAnswer> {
    return this.openAs(target, {}, { kind: "conn", connId, role: "viewer" });
  }

  /** A peer's or a viewer's `replay.open {replay_id}`: a join of a live owned entry, nothing else. */
  async join(
    replayId: string,
    opener: ReplayOpener & { kind: "conn" },
    place?: PeerPlaceAsk
  ): Promise<ReplayOpenAnswer> {
    const entry = this.byId.get(replayId);
    if (
      !entry ||
      entry.kind !== "owned" ||
      entry.closed ||
      entry.finishedAt !== null ||
      this.shuttingDown
    )
      throw unknownReplay(replayId);
    await entry.opening;
    if (entry.closed || entry.finishedAt !== null) throw unknownReplay(replayId);
    this.addHold(entry, opener);
    let placed = false;
    if (place && opener.role === "peer" && this.grants)
      placed = this.grants.grant(
        targetOfReplay(replayId),
        place.workspace_key,
        opener.connId,
        place.txn
      );
    return { ...this.answerOfOwned(entry, opener), place: placed };
  }

  private async openAs(
    target: ReplayTarget,
    size: { cols?: number; rows?: number },
    opener: ReplayOpener
  ): Promise<ReplayOpenAnswer> {
    const uuid = this.classify(target);
    for (let round = 0; ; round++) {
      const existing = this.openByTarget.get(uuid);
      const slot = existing ?? this.startSlot(uuid, target, size, opener);
      if (existing && existing.entry?.kind === "remote" && opener.kind === "conn")
        throw elsewhere(existing.entry.ownerEndpoint, existing.entry.replayId);
      let entry: Entry;
      try {
        entry = await slot.promise;
      } catch (e) {
        if (e instanceof Redirected) {
          if (opener.kind === "conn") throw elsewhere(e.endpoint, e.replayId);
          // the provisional slot is gone: look again, and join through the registry this time
          if (round < 3) continue;
          throw unavailable("spawn_failed", "the replay moved while it was opened");
        }
        throw e;
      }
      if (entry.kind === "remote") {
        if (opener.kind === "conn") throw elsewhere(entry.ownerEndpoint, entry.replayId);
        return this.answerOfRemote(entry, slot === existing);
      }
      if (existing) {
        if (entry.closed || entry.finishedAt !== null) {
          if (round < 3) continue;
          throw unknownReplay(entry.replayId);
        }
        if (opener.kind === "conn" && !entry.holds.conns.has(opener.connId))
          this.assertViewerRoom(opener.connId, false);
        this.addHold(entry, opener);
      }
      return { ...this.answerOfOwned(entry, opener), place: false };
    }
  }

  /** Registered synchronously, before the first await: a second open in this process finds it. */
  private startSlot(
    uuid: string,
    target: ReplayTarget,
    size: { cols?: number; rows?: number },
    opener: ReplayOpener
  ): Slot {
    if (this.shuttingDown) throw unavailable("spawn_failed", "the server is shutting down");
    if (opener.kind === "conn" && opener.role === "viewer") this.assertViewerRoom(opener.connId);
    const slot: Slot = { uuid, entry: null, promise: Promise.resolve(null as unknown as Entry) };
    this.openByTarget.set(uuid, slot);
    slot.promise = this.decide(slot, target, size, opener).catch((e: unknown) => {
      if (this.openByTarget.get(uuid) === slot) this.openByTarget.delete(uuid);
      throw e;
    });
    // a waiter that never comes must not turn a rejection into an unhandled one
    slot.promise.catch(() => {});
    return slot;
  }

  /** `spawning`: the open would start a replay, which also counts against the server's bound. */
  private assertViewerRoom(connId: string, spawning = true): void {
    let mine = 0;
    let viewerLive = 0;
    for (const e of this.byId.values()) {
      if (e.kind !== "owned") continue;
      if (e.holds.conns.has(connId)) mine++;
      if (e.viewerOpened && e.finishedAt === null && !e.closed) viewerLive++;
    }
    if (mine >= VIEWER_HOLDS_MAX)
      throw new ViewError("replay_limit", `a viewer holds at most ${VIEWER_HOLDS_MAX} replays`);
    if (spawning && viewerLive >= VIEWER_REPLAYS_MAX)
      throw new ViewError(
        "replay_limit",
        `this server runs at most ${VIEWER_REPLAYS_MAX} replays opened by viewers`
      );
  }

  /** Section 7.2 step 3: the registry decision. Never blocks in the kernel. */
  private async decide(
    slot: Slot,
    target: ReplayTarget,
    size: { cols?: number; rows?: number },
    opener: ReplayOpener
  ): Promise<Entry> {
    if (!this.shared) {
      if (!target.writerGone) throw unavailable("session_live", "the session is still running");
      return this.spawn(slot, target, size, opener, null, this.mintReplayId(), null);
    }
    const uuid = slot.uuid;
    const deadline = Date.now() + this.readyMs + (this.options.joinExtraMs ?? REPLAY_JOIN_EXTRA_MS);
    const place = this.placeAsk(opener);
    for (;;) {
      if (this.shuttingDown) throw unavailable("spawn_failed", "the server is shutting down");
      let lock: KernelLock | null;
      try {
        lock = this.registry.tryLock(uuid);
      } catch (e) {
        if (e instanceof KernelLockUnavailable)
          throw unavailable("spawn_failed", `the replay lock is unavailable: ${e.message}`);
        throw e;
      }
      if (lock) return this.won(slot, target, size, opener, lock);
      const e = this.registry.read(uuid);
      const me = this.endpoint();
      const waiting = !e || e.state === "closing" || (me !== null && e.owner_endpoint === me);
      if (!waiting && e) {
        if (e.owner_endpoint === null || me === null)
          throw unavailable("spawn_failed", "the replay is open on another server");
        if (opener.kind === "conn") throw new Redirected(e.owner_endpoint, e.replay_id);
        const left = deadline - Date.now();
        if (left > 0) {
          const joined = await this.tryJoin(
            slot,
            e.owner_endpoint,
            e.replay_id,
            e.pane_id,
            place,
            left,
            target
          );
          if (joined) return joined;
        }
      }
      if (Date.now() >= deadline)
        throw unavailable(
          "spawn_failed",
          "a replay of this session is still running and did not answer"
        );
      await Bun.sleep(POLL_MS);
    }
  }

  /** The lock is ours: no replay process of this session exists anywhere. */
  private async won(
    slot: Slot,
    target: ReplayTarget,
    size: { cols?: number; rows?: number },
    opener: ReplayOpener,
    lock: KernelLock
  ): Promise<Entry> {
    const uuid = slot.uuid;
    const replayId = this.mintReplayId();
    const paneId = mintPaneId("r", uuid.slice(0, 8));
    let decided: { value: "live" | "ok" } | null;
    try {
      decided = await this.registry.withLock(() => {
        const stale = this.registry.read(uuid);
        if (stale) log(`[replay] ${uuid}: overwriting a stale registry entry (${stale.replay_id})`);
        // a stale entry younger than the grace proves the writer was gone a moment ago
        const young = stale !== null && Date.now() - Date.parse(stale.since) < TRANSCRIPT_GRACE_MS;
        if (!target.writerGone && !young) return "live" as const;
        this.registry.writeLocked(uuid, {
          v: 1,
          state: "open",
          replay_id: replayId,
          owner_endpoint: this.endpoint(),
          pane_id: paneId,
          since: new Date().toISOString(),
        });
        return "ok" as const;
      });
    } catch (e) {
      lock.close();
      throw e;
    }
    if (!decided) {
      lock.close();
      throw unavailable(
        "spawn_failed",
        "the replay registry is locked by a process that does not answer"
      );
    }
    if (decided.value === "live") {
      lock.close();
      throw unavailable("session_live", "the session is still running");
    }
    return this.spawn(slot, target, size, opener, lock, replayId, paneId);
  }

  private async tryJoin(
    slot: Slot,
    ownerEndpoint: string,
    replayId: string,
    paneId: string,
    place: PeerPlaceAsk | undefined,
    timeoutMs: number,
    target: ReplayTarget
  ): Promise<RemoteEntry | null> {
    let link: PeerLink;
    let answer: ReplayOpenWire;
    try {
      link = await this.peers.link(ownerEndpoint);
      answer = await link.open(replayId, place, timeoutMs);
    } catch {
      // unknown_session, server_gone, refused or timed out: the lock decides on the next pass
      return null;
    }
    const entry: RemoteEntry = {
      kind: "remote",
      replayId: answer.replay_id,
      targetKey: slot.uuid,
      ownerEndpoint,
      paneId,
      link,
      finishedAt: null,
      lastScreen: null,
      // a join takes no claim: any `claude_code` holder in the answer is another server's
      lastClaimId: null,
      placeTxn: answer.place && place ? place.txn : null,
      placeKey: answer.place && place ? place.workspace_key : null,
      of: target.of ?? { session_id: slot.uuid },
      model: target.model ?? null,
    };
    this.byId.set(entry.replayId, entry);
    slot.entry = entry;
    void link.follow(entry.replayId, (why) => void this.remoteEnded(entry, why));
    if (entry.placeTxn)
      this.placer?.remote(targetOfReplay(entry.replayId), entry.placeTxn, ownerEndpoint);
    this.seqOfJoin.set(entry.replayId, { seq: answer.seq, view: answer.view });
    return entry;
  }

  private placeAsk(opener: ReplayOpener): PeerPlaceAsk | undefined {
    if (opener.kind !== "mcp" || !this.placer) return undefined;
    const key = this.placer.workspaceKey();
    return key ? { workspace_key: key, txn: `p${randomBytes(6).toString("hex")}` } : undefined;
  }

  private mintReplayId(): string {
    return `replay-${randomBytes(8).toString("hex")}`;
  }

  /** SPAWN(lock): reachable only holding the replay lock (or with no sharing at all). */
  private async spawn(
    slot: Slot,
    target: ReplayTarget,
    size: { cols?: number; rows?: number },
    opener: ReplayOpener,
    lock: KernelLock | null,
    replayId: string,
    paneId: string | null
  ): Promise<Entry> {
    const uuid = slot.uuid;
    const forkUuid = randomUUID();
    const cwd = replayCwd(target.cwd);
    // absolute against the server's directory: `claude` reads its config dir after the launcher's
    // `cd`, and the fork record it writes there is the path the cleanup removes
    const projectsRoot = resolve(target.projectsRoot);
    const forkPath = transcriptPathFor(cwd, forkUuid, projectsRoot);
    const entry: OwnedEntry = {
      kind: "owned",
      replayId,
      targetKey: uuid,
      paneId: paneId ?? "",
      pane: null,
      opening: Promise.resolve(),
      finishedAt: null,
      closed: false,
      mcpGone: false,
      holds: { mcp: false, conns: new Set() },
      viewerOpened: opener.kind === "conn" && opener.role === "viewer",
      registered: lock !== null,
      closing: null,
      of: target.of ?? { session_id: uuid },
      model: target.model ?? null,
    };
    this.addHold(entry, opener);
    this.byId.set(entry.replayId, entry);
    slot.entry = entry;
    entry.opening = this.run(entry, lock, {
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
    await entry.opening;
    return entry;
  }

  private addHold(entry: OwnedEntry, opener: ReplayOpener): void {
    if (opener.kind === "mcp") {
      entry.holds.mcp = true;
      entry.mcpGone = false;
    } else entry.holds.conns.add(opener.connId);
    this.notify(entry);
  }

  private answerOfOwned(entry: OwnedEntry, opener: ReplayOpener): Omit<ReplayOpenAnswer, "place"> {
    const target = targetOfReplay(entry.replayId);
    if (opener.kind === "mcp" && entry.finishedAt === null) this.placer?.owned(target);
    return {
      replay_id: entry.replayId,
      target,
      seq: entry.pane?.seq() ?? 0,
      magmux: entry.pane
        ? { pane_id: entry.pane.paneId, view_socket: entry.pane.viewSockPath }
        : null,
      view: this.claims?.viewFor(target, callerOf(opener)) ?? null,
      herdr_workspaces: this.grants?.workspaces(target) ?? [],
    };
  }

  private answerOfRemote(entry: RemoteEntry, again: boolean): ReplayOpenAnswer {
    const joined = this.seqOfJoin.get(entry.replayId);
    return {
      replay_id: entry.replayId,
      target: targetOfReplay(entry.replayId),
      seq: again ? (entry.lastScreen?.seq ?? joined?.seq ?? 0) : (joined?.seq ?? 0),
      magmux: null,
      view: this.relative(entry, joined?.view ?? null),
      herdr_workspaces: [],
      place: false,
    };
  }

  /** A `claude_code` holder on the owner is this server's only when the grant is its own. */
  private relative(entry: RemoteEntry, view: ViewHolder | null): ViewHolder | null {
    if (!view || view.holder !== "claude_code") return view;
    if (entry.lastClaimId !== null && view.claim_id === entry.lastClaimId) return view;
    return { ...view, holder: "claude_code_other", label: "another Claude Code" };
  }

  /* ───────────────────────────── reads and the two inputs ───────────────────────────── */

  /** The last screen of a finished replay stays readable until it is closed or evicted. */
  capture(
    id: string,
    sinceSeq?: number,
    spans?: boolean,
    caller: ClaimCaller = MCP_CALLER
  ): CaptureResult | CaptureUnchanged {
    const entry = this.ownedFor(id, caller);
    const answer = (entry.pane as ReplayPaneLike).capture(sinceSeq, { spans: spans === true });
    if (!this.claims) return answer;
    const target = targetOfReplay(id);
    if (!entry.closed) this.claims.renewFromCapture(target, caller);
    return this.claims.stamp(answer, target, caller);
  }

  /** `capture_session` on a replay id: owned answers here, remote is relayed to the owner. */
  async captureMcp(
    id: string,
    sinceSeq?: number,
    spans?: boolean
  ): Promise<CaptureResult | CaptureUnchanged> {
    const entry = this.byId.get(id);
    if (entry?.kind !== "remote") return this.capture(id, sinceSeq, spans, MCP_CALLER);
    if (entry.finishedAt === null) {
      try {
        const r = await entry.link.capture(id, sinceSeq, spans === true);
        if (!("unchanged" in r)) entry.lastScreen = r;
        if (r.final) void this.remoteEnded(entry, "closed");
        const view = this.relative(entry, (r as { view?: ViewHolder | null }).view ?? null);
        return { ...r, view };
      } catch (e) {
        const disowned = e instanceof ViewError && e.code === "unknown_session";
        if (!disowned && entry.link.isOpen) throw e;
        await this.remoteEnded(entry, "server_gone");
      }
    }
    return this.finalOfRemote(entry, sinceSeq, spans === true);
  }

  /** A finished remote entry's kept screen, as a finished owned replay answers it. */
  private finalOfRemote(
    entry: RemoteEntry,
    sinceSeq: number | undefined,
    spans: boolean
  ): CaptureResult | CaptureUnchanged {
    const s = entry.lastScreen;
    const seq = s?.seq ?? 0;
    if (sinceSeq !== undefined && sinceSeq === seq)
      return { unchanged: true, seq, final: true, view: null };
    if (!s)
      return {
        seq: 0,
        cols: 0,
        rows: 0,
        cursor: { x: 0, y: 0 },
        lines: [],
        final: true,
        view: null,
      };
    const { spans: kept, view: _view, ...rest } = s as CaptureResult & { view?: unknown };
    return { ...rest, ...(spans && kept ? { spans: kept } : {}), final: true, view: null };
  }

  async resize(
    id: string,
    cols: number,
    rows: number,
    caller: ClaimCaller = MCP_CALLER
  ): Promise<ResizeResult> {
    const remote = this.byId.get(id);
    if (remote?.kind === "remote" && caller.kind === "mcp")
      return this.resizeRemote(remote, cols, rows);
    const entry = this.ownedFor(id, caller);
    const pane = entry.pane as ReplayPaneLike;
    const target = targetOfReplay(id);
    if (!pane.finished() && !entry.closed) this.claims?.claim(target, caller);
    const answer: ResizeResult = { session_id: id, ...(await pane.resize(cols, rows)) };
    return this.claims ? this.claims.stamp(answer, target, caller) : answer;
  }

  private async resizeRemote(
    entry: RemoteEntry,
    cols: number,
    rows: number
  ): Promise<ResizeResult> {
    if (entry.finishedAt === null) {
      try {
        const r = await entry.link.claim(entry.replayId, cols, rows);
        if (r.view?.holder === "claude_code") entry.lastClaimId = r.view.claim_id;
        const resize = r.resize as ResizeResult;
        return { ...resize, session_id: entry.replayId, view: this.relative(entry, r.view) };
      } catch (e) {
        if (entry.link.isOpen && !(e instanceof ViewError && e.code === "unknown_session")) throw e;
        await this.remoteEnded(entry, "server_gone");
      }
    }
    const s = entry.lastScreen;
    return {
      session_id: entry.replayId,
      cols: s?.cols ?? cols,
      rows: s?.rows ?? rows,
      changed: false,
      seq: s?.seq ?? 0,
      view: null,
    };
  }

  async scroll(
    id: string,
    req: ScrollRequest,
    caller: ClaimCaller = MCP_CALLER
  ): Promise<ScrollResult> {
    const remote = this.byId.get(id);
    if (remote?.kind === "remote" && caller.kind === "mcp") {
      if (remote.finishedAt !== null)
        throw new ContractErrorException("scroll_unavailable", "the replay finished");
      try {
        const r = await remote.link.scroll(id, req);
        return { session_id: id, seq: r.seq };
      } catch (e) {
        if (e instanceof ViewError && e.code === "server_gone" && !remote.link.isOpen) {
          await this.remoteEnded(remote, "server_gone");
          throw new ContractErrorException("scroll_unavailable", "the replay finished");
        }
        if (e instanceof ViewError)
          throw new ContractErrorException(
            e.code === "unknown_session" ? "scroll_unavailable" : (e.code as never),
            e.message,
            e.reason as ReplayUnavailableReason | undefined
          );
        throw e;
      }
    }
    const entry = this.ownedFor(id, caller);
    if (entry.closed) throw new ContractErrorException("scroll_unavailable", "the replay finished");
    const r = await (entry.pane as ReplayPaneLike).scroll(req);
    return { session_id: id, seq: r.seq };
  }

  /** The owned entry `caller` may read; this server's Claude Code loses its own after `close_replay`. */
  private ownedFor(id: string, caller: ClaimCaller): OwnedEntry {
    const entry = this.byId.get(id);
    if (!entry || entry.kind !== "owned" || !entry.pane) throw unknownReplay(id);
    if (caller.kind === "mcp" && entry.mcpGone) throw unknownReplay(id);
    if (caller.kind === "conn" && entry.closed && !entry.holds.conns.has(caller.connId))
      throw unknownReplay(id);
    return entry;
  }

  /* ───────────────────────────── close and release ───────────────────────────── */

  /** `close_replay`. Any id answers. Returns only once the process is gone, on every server. */
  close(id: string): Promise<ReplayCloseResult> {
    return this.closeBy(id, MCP_OPENER);
  }

  /** Close by any holder: this server's Claude Code, or a peer relaying its own `close_replay`. */
  async closeBy(id: string, closer: ReplayOpener): Promise<ReplayCloseResult> {
    const entry = this.byId.get(id);
    if (!entry) return { closed: true };
    if (entry.kind === "remote") return this.closeRemote(entry);
    const verified = await this.reapOwned(entry);
    this.dropHold(entry, closer);
    return verified ? { closed: true } : { closed: true, reap_unverified: true };
  }

  /** Drops this connection's hold; the last hold of a live replay with no MCP hold reaps it. */
  async release(id: string, connId: string): Promise<{ closed: boolean }> {
    const entry = this.byId.get(id);
    if (!entry || entry.kind !== "owned") return { closed: false };
    if (!entry.holds.conns.has(connId)) return { closed: false };
    entry.holds.conns.delete(connId);
    this.notify(entry);
    if (this.held(entry) || entry.closed) {
      this.forgetIfUnheld(entry);
      return { closed: false };
    }
    await this.reapOwned(entry);
    this.forgetIfUnheld(entry);
    return { closed: true };
  }

  /** A connection of the local transport closed: every hold it had is released. */
  connectionGone(connId: string): void {
    for (const e of [...this.byId.values()])
      if (e.kind === "owned" && e.holds.conns.has(connId)) void this.release(e.replayId, connId);
  }

  /** This server's placement for a joined replay will not become a viewer: tell its owner. */
  givePlacementBack(target: string): void {
    for (const e of this.byId.values()) {
      if (e.kind !== "remote" || targetOfReplay(e.replayId) !== target || !e.placeKey) continue;
      const key = e.placeKey;
      e.placeKey = null;
      e.placeTxn = null;
      if (e.link.isOpen) void e.link.placeDone(e.replayId, key).catch(() => {});
    }
  }

  /** A peer's `replay.place_done`: a reservation that will not become a viewer. */
  placeDone(id: string, workspaceKey: string, connId: string): void {
    this.grants?.doneFor(targetOfReplay(id), workspaceKey, connId);
  }

  /** The one reap: closing → reap → registry removal → `item.remove`. True when verified. */
  private reapOwned(entry: OwnedEntry): Promise<boolean> {
    if (entry.closing) return entry.closing;
    entry.closed = true;
    entry.closing = (async () => {
      try {
        await entry.opening;
      } catch {
        // a failed open has already reaped its pane
      }
      if (entry.registered) await this.registry.markClosing(entry.targetKey, entry.replayId);
      const verified = entry.pane ? await entry.pane.close() : true;
      if (entry.registered) await this.registry.removeIf(entry.targetKey, entry.replayId);
      const target = targetOfReplay(entry.replayId);
      this.claims?.forget(target);
      this.feed?.removed(target, "replay_closed");
      return verified;
    })();
    return entry.closing;
  }

  private held(entry: OwnedEntry): boolean {
    return entry.holds.mcp || entry.holds.conns.size > 0;
  }

  private dropHold(entry: OwnedEntry, who: ReplayOpener): void {
    if (who.kind === "mcp") {
      entry.holds.mcp = false;
      entry.mcpGone = true;
    } else entry.holds.conns.delete(who.connId);
    this.forgetIfUnheld(entry);
  }

  /** A closed entry stays for its other holders (their capture answers `final:true`), then goes. */
  private forgetIfUnheld(entry: OwnedEntry): void {
    if (!entry.closed || this.held(entry)) return;
    this.forget(entry);
  }

  /** `close_replay` on a joined replay: relayed, and answered after the owner's reap. */
  private async closeRemote(entry: RemoteEntry): Promise<ReplayCloseResult> {
    const target = targetOfReplay(entry.replayId);
    if (entry.finishedAt === null) {
      try {
        const r = await entry.link.close(entry.replayId);
        this.forget(entry);
        entry.link.unfollow(entry.replayId);
        this.placer?.ended(target);
        return r;
      } catch (e) {
        // alive but silent for the whole wait: the process cannot be verified gone
        const answered = e instanceof ViewError && e.code === "unknown_session";
        if (!answered && entry.link.isOpen) {
          this.forget(entry);
          entry.link.unfollow(entry.replayId);
          this.placer?.ended(target);
          return { closed: true, reap_unverified: true };
        }
      }
    }
    this.forget(entry);
    entry.link.unfollow(entry.replayId);
    this.placer?.ended(target);
    return (await this.verifyGone(entry))
      ? { closed: true }
      : { closed: true, reap_unverified: true };
  }

  /** Lock free (its magmux is gone) and the pane record absent, within the bound. */
  private async verifyGone(entry: RemoteEntry): Promise<boolean> {
    const deadline = Date.now() + (this.options.unreachableCloseMs ?? UNREACHABLE_CLOSE_MS);
    const record = recordPathOf(this.root, entry.paneId);
    for (;;) {
      let free = false;
      try {
        const lock = this.registry.tryLock(entry.targetKey);
        free = lock !== null;
        lock?.close();
      } catch {
        free = false;
      }
      if (free && isRecordGone(record)) return true;
      if (Date.now() >= deadline) return false;
      await Bun.sleep(POLL_MS);
    }
  }

  /** The owner stopped serving a joined replay: keep its last screen as `final`, once. */
  private async remoteEnded(entry: RemoteEntry, why: PeerEnd): Promise<void> {
    if (entry.finishedAt !== null) return;
    entry.finishedAt = Date.now();
    const slot = this.openByTarget.get(entry.targetKey);
    if (slot?.entry === entry) this.openByTarget.delete(entry.targetKey);
    if (why !== "server_gone" && entry.link.isOpen) {
      try {
        const r = await entry.link.capture(entry.replayId, undefined, true);
        if (!("unchanged" in r)) entry.lastScreen = r;
      } catch {
        // the last relayed screen stays the final one
      }
      void entry.link.release(entry.replayId).catch(() => {});
    }
    entry.link.unfollow(entry.replayId);
    this.placer?.ended(targetOfReplay(entry.replayId));
    this.evict();
  }

  /* ───────────────────────────── the pane ───────────────────────────── */

  /** The target's uuid, lowercase; or the reason it cannot be replayed. Reads the file, keeps nothing. */
  private classify(target: ReplayTarget): string {
    // shared: a held lock already proves the writer gone, so `writerGone` is read by the winner
    if (!this.shared && !target.writerGone)
      throw unavailable("session_live", "the session is still running");
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

  private itemOf(e: OwnedEntry): Omit<ReplayViewItem, "view"> {
    return {
      kind: "replay" as const,
      target: targetOfReplay(e.replayId),
      replay_id: e.replayId,
      of: e.of,
      model: e.model,
      final: e.finishedAt !== null,
      magmux: e.pane ? { pane_id: e.pane.paneId, view_socket: e.pane.viewSockPath } : null,
      herdr_workspaces: [],
    };
  }

  /** The start, the wait for the box, and the failures that leave nothing behind. */
  private async run(
    entry: OwnedEntry,
    lock: KernelLock | null,
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
    const target = targetOfReplay(entry.replayId);
    const failed = async (e: unknown): Promise<never> => {
      this.forget(entry);
      if (entry.registered) await this.registry.removeIf(entry.targetKey, entry.replayId);
      this.feed?.removed(target, "replay_closed");
      throw e;
    };
    try {
      const claudeBinary = this.options.claudeBinary ?? (await replayClaudeBinary(this.parentEnv));
      const o: ReplayPaneOptions = {
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
        sockRoot: this.root,
        magmuxBinary: this.options.magmuxBinary,
        label: a.claudeSessionId.slice(0, 8),
        onFinish: () => this.onFinished(entry),
        refused: () => this.shuttingDown,
        onViewSocket: () => this.notify(entry),
        ...(lock ? { holdLock: lock } : {}),
        ...(entry.paneId ? { paneId: entry.paneId } : {}),
        onReaped: () => {
          if (entry.registered) void this.registry.removeIf(entry.targetKey, entry.replayId);
        },
      };
      const pane = this.options.startPane
        ? await this.options.startPane(o)
        : await startReplayPane(o);
      entry.pane = pane;
      entry.paneId = pane.paneId;
      this.notify(entry);
    } catch (e) {
      return failed(unavailable("spawn_failed", e instanceof Error ? e.message : String(e)));
    } finally {
      // every failure before the child exists frees the lock here; after the spawn it is magmux's
      lock?.close();
    }
    const ready = await entry.pane.ready(this.readyMs);
    if (ready.kind === "box" || ready.kind === "slow") return;
    await entry.pane.close();
    if (ready.kind === "dialog")
      return failed(unavailable("boot_dialog", `a dialog replaced the input box: ${ready.name}`));
    return failed(unavailable("spawn_failed", ready.detail));
  }

  /** A later open starts fresh; `byId` still answers `final:true`, up to the bound. */
  private onFinished(entry: OwnedEntry): void {
    entry.finishedAt = Date.now();
    const slot = this.openByTarget.get(entry.targetKey);
    if (slot?.entry === entry) this.openByTarget.delete(entry.targetKey);
    this.notify(entry);
    this.evict();
  }

  private evict(): void {
    const finished = [...this.byId.values()]
      .filter((e) => e.finishedAt !== null)
      .sort((x, y) => (x.finishedAt as number) - (y.finishedAt as number));
    for (const old of finished.slice(0, Math.max(0, finished.length - FINISHED_REPLAYS_MAX))) {
      this.byId.delete(old.replayId);
      this.claims?.forget(targetOfReplay(old.replayId));
      if (old.kind === "owned" && !old.closed)
        this.feed?.removed(targetOfReplay(old.replayId), "evicted");
    }
  }

  private notify(entry: OwnedEntry): void {
    if (entry.closed) return;
    this.feed?.changed(targetOfReplay(entry.replayId), true);
  }

  private forget(entry: Entry): void {
    if (this.byId.get(entry.replayId) === entry) this.byId.delete(entry.replayId);
    const slot = this.openByTarget.get(entry.targetKey);
    if (slot?.entry === entry) this.openByTarget.delete(entry.targetKey);
    if (entry.kind === "remote") this.seqOfJoin.delete(entry.replayId);
  }
}
