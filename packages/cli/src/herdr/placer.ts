/**
 * The herdr terminal adapter, MCP server side: one passive viewer pane per session, team slot and
 * replay of this server, in a background tab named `claudish` of the workspace the server runs in.
 *
 * Creation always happens in a scratch tab whose label `claudish-new-<token>` only this code makes,
 * with the viewer as the pane's argv (`layout.apply`). The first pane's scratch tab is renamed
 * `claudish`; every later pane is moved into the claudish tab (`pane.move`) and herdr closes the
 * emptied scratch tab. A pane is created by no other call, so every pane this placer may ever own
 * has an identity it can find again: a returned pane id, or the token in a tab label.
 *
 * What the placer owns, and so may close, is exactly what is in its records: panes whose id a reply
 * gave it, and scratch tabs found by their token after a reply was lost. A token is retired only
 * once its tab is verified absent, so a lost cleanup request is tried again, not forgotten.
 *
 * `pane.zoom` is never called: herdr moves the user's focus to the zoomed tab on `on` and `off`
 * alike. A move into a zoomed claudish tab is parked until herdr reports the tab unzoomed.
 */

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { ensurePrivateSubdir } from "../pane/pane-launch.js";
import { type ViewItem, parseViewTarget } from "../pane/view-contract.js";
import {
  type KernelLock,
  KernelLockUnavailable,
  flockAvailable,
  waitAcquire,
} from "../view/kernel-lock.js";
import { isFinishedItem } from "../view/view-directory.js";
import type { ViewFeedEvent } from "../view/view-feed.js";
import { type HerdrPaneEnv, workspaceKeyOf, workspaceLockName } from "./front-end.js";
import { type HerdrApi, HerdrApiError, type HerdrEvent } from "./herdr-socket.js";
import { type PlacementGrants, placementToken } from "./placement-grants.js";
import { shortModel } from "./state-map.js";

/** What the placer asks of the grants: the owner's in-process ones, or a joined replay's. */
export type PlacerGrants = Pick<
  PlacementGrants,
  "grant" | "attempt" | "placed" | "done" | "pending"
>;

export const CLAUDISH_TAB = "claudish";
export const SCRATCH_PREFIX = "claudish-new-";
export const PLACED_GRACE_MS = 4_000;
export const LOCK_WAIT_MS = 15_000;
export const SHUTDOWN_CLOSE_MS = 500;
const CLEANUP_RETRY_MS = 500;
const CLEANUP_RETRY_MAX_MS = 5_000;
const RESUBSCRIBE_MS = 1_000;

const EVENT_TYPES = ["pane.closed", "pane.exited", "tab.created", "tab.closed", "layout.updated"];

export interface PlacerOptions {
  herdr: HerdrApi;
  /** the herdr pane this MCP server runs in */
  pane: HerdrPaneEnv;
  /** the socket root; the workspace lock lives in `<root>/herdr/` */
  root: string;
  feed: { subscribe(fn: (e: ViewFeedEvent) => void): () => void };
  /** the current row of a target, for the checks made inside the lock */
  item: (target: string) => ViewItem | null;
  grants: PlacerGrants;
  /** this server's endpoint, once bound; a placed viewer dials it */
  endpoint: () => { name: string; path: string } | null;
  /** the endpoint path a placed viewer of `target` dials instead (a joined replay's owner) */
  endpointFor?: (target: string) => string | null;
  /** the argv of a placed viewer for `target` */
  command: (target: string) => string[];
  /** extra variables for the viewer: herdr panes inherit herdr's environment, not ours */
  env?: Record<string, string>;
  cwd: string;
  graceMs?: number;
  lockWaitMs?: number;
  cleanupRetryMs?: number;
  /** 8 hex characters; tests pin it */
  token?: () => string;
  log?: (line: string) => void;
  /** false: rely on the in-process queue only (a process where `flock` cannot be bound) */
  kernelLock?: boolean;
}

interface Placement {
  target: string;
  /** set for a replay: the transaction that holds the owner's reservation */
  txn: string | null;
  lockMisses: number;
}

interface PaneRecord {
  paneId: string;
  target: string;
  tabId: string;
  /** the scratch tab the pane was created in, until it is in the claudish tab */
  scratchTabId: string | null;
  txn: string | null;
  /** set when closing it failed for want of a reply; the next reconcile closes it */
  stray: boolean;
  /** this placer asked herdr to close it: its close event is not the user's */
  closing: boolean;
}

/** A creation whose result is not known from a reply. Kept until its tab is verified absent. */
interface Orphan {
  tabId: string | null;
  /** true while its `layout.apply` may still answer: a tab seen then may be about to be ours */
  awaiting: boolean;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function rec(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

interface TabInfo {
  tab_id: string;
  label: string;
  number: number;
}

export class HerdrPlacer {
  private workspaceId = "";
  private workspaceKey = "";
  private readonly records = new Map<string, PaneRecord>();
  private readonly byTarget = new Map<string, string>();
  private readonly queue: Placement[] = [];
  private readonly queued = new Set<string>();
  private readonly parked = new Map<string, Placement>();
  /** targets whose placed pane the user closed while the item ran; never placed again */
  private readonly dismissed = new Set<string>();
  private parkedOn: string | null = null;
  private readonly orphans = new Map<string, Orphan>();
  private readonly graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null;
  private cleanupDelay: number;
  private running = false;
  private stopped = false;
  private nextSplit: "right" | "down" = "right";
  private unsubscribeFeed: (() => void) | null = null;
  private unsubscribeEvents: (() => void) | null = null;
  private readonly log: (line: string) => void;
  private readonly useKernelLock: boolean;
  private idle: Promise<void> = Promise.resolve();
  private settleIdle: (() => void) | null = null;

  constructor(private readonly o: PlacerOptions) {
    this.log = o.log ?? (() => {});
    this.cleanupDelay = o.cleanupRetryMs ?? CLEANUP_RETRY_MS;
    this.useKernelLock = o.kernelLock ?? flockAvailable();
  }

  get key(): string {
    return this.workspaceKey;
  }

  /** this server's herdr workspace id, once started */
  get workspace(): string | undefined {
    return this.workspaceId || undefined;
  }

  /** Resolves this server's workspace and starts following the feed and herdr's events. */
  async start(): Promise<void> {
    const got = await this.o.herdr.request("pane.get", { pane_id: this.o.pane.paneId });
    this.workspaceId = str(rec(got.pane).workspace_id) || this.o.pane.workspaceId || "";
    if (!this.workspaceId) throw new Error("herdr did not say which workspace this pane is in");
    this.workspaceKey = workspaceKeyOf(this.o.pane.socketPath, this.workspaceId);
    this.subscribeEvents();
    this.unsubscribeFeed = this.o.feed.subscribe((e) => this.onFeed(e));
  }

  /**
   * This server's MCP link opened or joined a replay. It gets one pane in this workspace only when
   * the owner grants it, which it does at most once per workspace.
   */
  replayOpened(target: string): void {
    if (this.stopped || this.isKnown(target)) return;
    const txn = `p${randomBytes(6).toString("hex")}`;
    if (!this.o.grants.grant(target, this.workspaceKey, "mcp", txn)) return;
    this.enqueue({ target, txn, lockMisses: 0 });
  }

  /**
   * The owner of a joined replay granted this server a placement (`txn`) in this workspace. The
   * grant is the owner's; a placement that will not become a viewer gives it back through `done`.
   */
  placeGranted(target: string, txn: string): void {
    if (this.stopped || this.isKnown(target)) {
      this.o.grants.done(txn);
      return;
    }
    this.enqueue({ target, txn, lockMisses: 0 });
  }

  /** A target this server learns has ended outside its own feed (a joined replay). */
  ended(target: string): void {
    if (!this.stopped) this.targetEnded(target);
  }

  /** Resolves once nothing is queued or running. For tests and the shutdown path. */
  whenIdle(): Promise<void> {
    return this.idle;
  }

  /** Own panes closed at once, bounded; nothing is placed after this. */
  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribeFeed?.();
    this.unsubscribeEvents?.();
    for (const t of this.graceTimers.values()) clearTimeout(t);
    this.graceTimers.clear();
    if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
    for (const p of [...this.queue, ...this.parked.values()]) this.drop(p);
    this.queue.length = 0;
    this.parked.clear();
    const closes = [
      ...[...this.records.values()].map((r) => this.closePane(r)),
      ...[...this.orphans.values()]
        .filter((o) => o.tabId)
        .map((o) => this.call("tab.close", { tab_id: o.tabId }).catch(() => {})),
    ];
    await Promise.race([Promise.allSettled(closes), Bun.sleep(SHUTDOWN_CLOSE_MS)]);
    this.o.herdr.close();
  }

  /* ───────────────────────────── inputs ───────────────────────────── */

  private onFeed(e: ViewFeedEvent): void {
    if (this.stopped) return;
    if (e.event === "remove") {
      this.targetEnded(e.target);
      return;
    }
    const item = e.item;
    if (isFinishedItem(item)) {
      this.targetEnded(item.target);
      return;
    }
    // sessions and slots are placed by this server alone; a replay only through `replayOpened`
    if (item.kind === "replay" || !item.magmux?.view_socket || this.isKnown(item.target)) return;
    this.enqueue({ target: item.target, txn: null, lockMisses: 0 });
  }

  private subscribeEvents(): void {
    if (this.stopped) return;
    this.unsubscribeEvents = this.o.herdr.subscribe(
      EVENT_TYPES,
      (e) => this.onHerdrEvent(e),
      (code) => {
        if (this.stopped) return;
        this.log(`[herdr] event stream ended${code ? ` (${code})` : ""}; reconciling`);
        const t = setTimeout(() => {
          this.subscribeEvents();
          void this.reconcile();
        }, RESUBSCRIBE_MS);
        t.unref?.();
      }
    );
  }

  private onHerdrEvent(e: HerdrEvent): void {
    if (this.stopped) return;
    const d = e.data;
    switch (e.event) {
      case "pane_closed":
      case "pane_exited": {
        const r = this.records.get(str(d.pane_id));
        if (r) this.goneUnderUs(r);
        return;
      }
      case "tab_created": {
        const tab = rec(d.tab);
        const token = this.tokenOfLabel(str(tab.label));
        const orphan = token ? this.orphans.get(token) : undefined;
        if (orphan && !orphan.awaiting && !orphan.tabId) {
          // a creation herdr finished after its reply was lost
          orphan.tabId = str(tab.tab_id);
          void this.cleanOrphans();
        }
        return;
      }
      case "tab_closed": {
        const tabId = str(d.tab_id);
        for (const r of [...this.records.values()]) if (r.tabId === tabId) this.goneUnderUs(r);
        if (this.parkedOn === tabId) this.unpark();
        if ([...this.orphans.values()].some((o) => o.tabId === tabId)) void this.cleanOrphans();
        return;
      }
      case "layout_updated": {
        const layout = rec(d.layout);
        if (this.parkedOn && str(layout.tab_id) === this.parkedOn && layout.zoomed === false)
          this.unpark();
        return;
      }
    }
  }

  /* ───────────────────────────── the queue ───────────────────────────── */

  private isKnown(target: string): boolean {
    return (
      this.byTarget.has(target) ||
      this.queued.has(target) ||
      this.parked.has(target) ||
      this.dismissed.has(target)
    );
  }

  /**
   * A pane of ours closed by someone else. Once placed, that is the user closing the view (or its
   * viewer leaving on its own): the target is not placed again while its item runs.
   */
  private goneUnderUs(r: PaneRecord): void {
    if (!r.closing && r.scratchTabId === null) {
      const item = this.o.item(r.target);
      if (item && !isFinishedItem(item)) this.dismissed.add(r.target);
    }
    this.forget(r);
  }

  private enqueue(p: Placement): void {
    this.queue.push(p);
    this.queued.add(p.target);
    this.pump();
  }

  private pump(): void {
    if (this.running || this.stopped) return;
    const next = this.queue.shift();
    if (!next) {
      this.settleIdle?.();
      this.settleIdle = null;
      return;
    }
    this.running = true;
    if (!this.settleIdle)
      this.idle = new Promise<void>((resolve) => {
        this.settleIdle = resolve;
      });
    void this.runOne(next).finally(() => {
      this.running = false;
      this.pump();
    });
  }

  private async runOne(p: Placement): Promise<void> {
    let lock: KernelLock | null = null;
    let missed = false;
    if (this.useKernelLock) {
      try {
        const dir = ensurePrivateSubdir(this.o.root, "herdr");
        lock = await waitAcquire(
          join(dir, workspaceLockName(this.workspaceKey)),
          this.o.lockWaitMs ?? LOCK_WAIT_MS
        );
        missed = lock === null;
      } catch (e) {
        // no lock in this process: the in-process queue alone orders placements
        if (!(e instanceof KernelLockUnavailable)) throw e;
      }
      if (missed) {
        if (p.lockMisses === 0) {
          // once to the back of the queue: another server's placements in this workspace go first
          p.lockMisses = 1;
          this.queue.push(p);
          return;
        }
        this.queued.delete(p.target);
        this.log(`[herdr] placement for ${p.target} skipped: the workspace lock stayed held`);
        this.drop(p);
        return;
      }
    }
    this.queued.delete(p.target);
    try {
      if (!this.stillWanted(p)) {
        this.drop(p);
        return;
      }
      await this.place(p);
    } catch (e) {
      this.log(`[herdr] placement for ${p.target} failed: ${e instanceof Error ? e.message : e}`);
      this.drop(p);
    } finally {
      lock?.close();
    }
  }

  /** The checks made again inside the lock: the item still runs and has no pane of ours. */
  private stillWanted(p: Placement): boolean {
    if (this.stopped || this.byTarget.has(p.target)) return false;
    if (p.txn && !this.o.grants.pending(p.txn)) return false;
    const item = this.o.item(p.target);
    return item !== null && !isFinishedItem(item);
  }

  /** A placement that will not become a viewer gives its reservation back. */
  private drop(p: Placement): void {
    if (p.txn) this.o.grants.done(p.txn);
  }

  private targetEnded(target: string): void {
    this.dismissed.delete(target);
    const parked = this.parked.get(target);
    if (parked) {
      this.parked.delete(target);
      this.drop(parked);
    }
    const at = this.queue.findIndex((p) => p.target === target);
    if (at >= 0) {
      const [p] = this.queue.splice(at, 1);
      this.queued.delete(target);
      if (p) this.drop(p);
    }
    const paneId = this.byTarget.get(target);
    const r = paneId ? this.records.get(paneId) : undefined;
    if (r) this.armGrace(r);
  }

  /** The viewer closes its own pane after its verdict; this only catches one that did not. */
  private armGrace(r: PaneRecord): void {
    if (this.graceTimers.has(r.paneId)) return;
    const t = setTimeout(() => {
      this.graceTimers.delete(r.paneId);
      if (this.records.get(r.paneId) === r) void this.closePane(r);
    }, this.o.graceMs ?? PLACED_GRACE_MS);
    t.unref?.();
    this.graceTimers.set(r.paneId, t);
  }

  private park(p: Placement, tabId: string): void {
    this.parked.set(p.target, p);
    this.parkedOn = tabId;
    this.log(`[herdr] the claudish tab is zoomed; ${p.target} waits until it is not`);
  }

  private unpark(): void {
    this.parkedOn = null;
    const waiting = [...this.parked.values()];
    this.parked.clear();
    for (const p of waiting) this.enqueue(p);
  }

  /* ───────────────────────────── placing ───────────────────────────── */

  private async place(p: Placement): Promise<void> {
    let created = await this.create(p);
    // one more try, with a new token: a lost reply's tab, if herdr made it, is being closed
    if (!created && !this.stopped && this.stillWanted(p)) created = await this.create(p);
    if (!created) {
      this.drop(p);
      return;
    }
    await this.intoClaudishTab(created, p);
  }

  /** One `layout.apply` in a fresh scratch tab. The record, or null when no pane is known. */
  private async create(p: Placement): Promise<PaneRecord | null> {
    const token = this.o.token?.() ?? randomBytes(4).toString("hex");
    const attempt = token;
    if (p.txn) this.o.grants.attempt(p.txn, attempt);
    const orphan: Orphan = { tabId: null, awaiting: true };
    this.orphans.set(token, orphan);
    const endpoint = this.o.endpoint();
    // a joined replay's viewer dials the replay's owner: its holds and claims live there
    const ownerPath = this.o.endpointFor?.(p.target) ?? null;
    const env: Record<string, string> = {
      ...(this.o.env ?? {}),
      ...(endpoint
        ? { CLAUDISH_VIEW_PLACED: endpoint.name, CLAUDISH_VIEW_ENDPOINT: endpoint.path }
        : { CLAUDISH_VIEW_PLACED: "1" }),
      ...(ownerPath ? { CLAUDISH_VIEW_ENDPOINT: ownerPath } : {}),
      ...(p.txn ? { CLAUDISH_VIEW_PLACEMENT: placementToken(p.txn, attempt) } : {}),
    };
    let result: Record<string, unknown>;
    try {
      result = await this.o.herdr.request("layout.apply", {
        workspace_id: this.workspaceId,
        tab_label: `${SCRATCH_PREFIX}${token}`,
        focus: false,
        root: {
          type: "pane",
          label: this.labelOf(p.target),
          cwd: this.o.cwd,
          command: this.o.command(p.target),
          env,
        },
      });
    } catch (e) {
      orphan.awaiting = false;
      if (e instanceof HerdrApiError) {
        // herdr answered: nothing was created
        this.orphans.delete(token);
        this.log(`[herdr] layout.apply for ${p.target}: ${e.code}`);
        return null;
      }
      this.log(`[herdr] layout.apply for ${p.target}: no reply; looking for its tab`);
      await this.cleanOrphans();
      return null;
    }
    orphan.awaiting = false;
    const layout = rec(result.layout);
    const paneId = str(layout.focused_pane_id);
    const tabId = str(layout.tab_id);
    if (!paneId || !tabId) {
      await this.cleanOrphans();
      return null;
    }
    // the reply named the pane: it is owned through its record from here on
    this.orphans.delete(token);
    const r: PaneRecord = {
      paneId,
      target: p.target,
      tabId,
      scratchTabId: tabId,
      txn: p.txn,
      stray: false,
      closing: false,
    };
    this.records.set(paneId, r);
    this.byTarget.set(p.target, paneId);
    return r;
  }

  private labelOf(target: string): string {
    const item = this.o.item(target);
    const model = shortModel(item?.model);
    const t = parseViewTarget(target);
    return t?.kind === "team_slot" ? `${model} · ${t.slot}` : model;
  }

  private async intoClaudishTab(r: PaneRecord, p: Placement): Promise<void> {
    let tabs: TabInfo[];
    try {
      tabs = await this.listTabs();
    } catch {
      await this.abandon(r, p);
      return;
    }
    const claudish = tabs
      .filter((t) => t.label === CLAUDISH_TAB)
      .sort((a, b) => a.number - b.number)[0];
    if (!claudish) {
      await this.renameToClaudish(r, p);
      return;
    }
    await this.move(r, p, claudish.tab_id, true);
  }

  private async renameToClaudish(r: PaneRecord, p: Placement): Promise<void> {
    try {
      await this.call("tab.rename", { tab_id: r.tabId, label: CLAUDISH_TAB });
      r.scratchTabId = null;
      this.placed(r);
    } catch {
      await this.abandon(r, p);
    }
  }

  private async move(
    r: PaneRecord,
    p: Placement,
    tabId: string,
    withAnchor: boolean
  ): Promise<void> {
    const anchor = withAnchor ? this.anchorIn(tabId, r.paneId) : null;
    const split = this.nextSplit;
    let result: Record<string, unknown>;
    try {
      result = await this.call("pane.move", {
        pane_id: r.paneId,
        destination: {
          type: "tab",
          tab_id: tabId,
          split,
          ...(anchor ? { target_pane_id: anchor } : {}),
        },
        focus: false,
      });
    } catch (e) {
      if (e instanceof HerdrApiError && e.code === "target_pane_not_found" && anchor) {
        await this.move(r, p, tabId, false);
        return;
      }
      if (e instanceof HerdrApiError && e.code === "tab_not_found") {
        await this.renameToClaudish(r, p);
        return;
      }
      await this.abandon(r, p);
      return;
    }
    const m = rec(result.move_result);
    if (m.changed === true) {
      this.nextSplit = split === "right" ? "down" : "right";
      const scratch = r.scratchTabId;
      this.rekey(r, str(rec(m.pane).pane_id) || r.paneId);
      r.tabId = tabId;
      r.scratchTabId = null;
      if (scratch && str(m.closed_tab_id) !== scratch)
        await this.call("tab.close", { tab_id: scratch }).catch(() => {});
      this.placed(r);
      return;
    }
    if (m.reason === "zoomed_tab") {
      // the pane goes, the reservation stays with the parked placement
      r.txn = null;
      await this.closePane(r);
      this.park(p, tabId);
      return;
    }
    this.log(`[herdr] pane.move for ${p.target}: not moved (${str(m.reason) || "unknown"})`);
    await this.abandon(r, p);
  }

  /** This placer's newest live pane in `tabId`, the anchor a new one splits. */
  private anchorIn(tabId: string, except: string): string | null {
    let anchor: string | null = null;
    for (const r of this.records.values())
      if (r.tabId === tabId && r.paneId !== except && r.scratchTabId === null && !r.stray)
        anchor = r.paneId;
    return anchor;
  }

  private rekey(r: PaneRecord, paneId: string): void {
    if (paneId === r.paneId) return;
    this.records.delete(r.paneId);
    r.paneId = paneId;
    this.records.set(paneId, r);
    this.byTarget.set(r.target, paneId);
  }

  private placed(r: PaneRecord): void {
    this.log(`[herdr] placed ${r.target} in ${r.paneId}`);
    if (r.txn) this.o.grants.placed(r.txn);
    const item = this.o.item(r.target);
    if (!item || isFinishedItem(item)) this.armGrace(r);
  }

  /** The placement failed after its pane existed: close the pane and its scratch tab, no retry. */
  private async abandon(r: PaneRecord, p: Placement): Promise<void> {
    this.log(`[herdr] placement for ${p.target} abandoned`);
    await this.closePane(r);
    this.drop(p);
  }

  /* ───────────────────────────── closing ───────────────────────────── */

  /** Close one of our panes; a scratch tab it was alone in closes with it. */
  private async closePane(r: PaneRecord): Promise<void> {
    r.closing = true;
    try {
      await this.call("pane.close", { pane_id: r.paneId });
      this.forget(r);
    } catch (e) {
      if (e instanceof HerdrApiError && e.code === "pane_not_found") {
        this.forget(r);
        return;
      }
      // no reply: the pane may still be there; the next reconcile closes it
      r.stray = true;
      this.scheduleCleanup();
    }
  }

  private forget(r: PaneRecord): void {
    if (this.records.get(r.paneId) !== r) return;
    this.records.delete(r.paneId);
    if (this.byTarget.get(r.target) === r.paneId) this.byTarget.delete(r.target);
    const t = this.graceTimers.get(r.paneId);
    if (t) clearTimeout(t);
    this.graceTimers.delete(r.paneId);
    // a pane gone before its viewer subscribed will never end the reservation itself
    if (r.txn) this.o.grants.done(r.txn);
  }

  private tokenOfLabel(label: string): string | null {
    return label.startsWith(SCRATCH_PREFIX) ? label.slice(SCRATCH_PREFIX.length) : null;
  }

  /**
   * Find every orphan's tab by its label, close it, and retire the token only when a fresh list
   * shows the tab is gone. A token whose tab was never seen stays: herdr may still create it, and
   * `tab_created` or the next reconcile finds it.
   */
  private async cleanOrphans(): Promise<void> {
    if (this.orphans.size === 0) return;
    let tabs: TabInfo[];
    try {
      tabs = await this.listTabs();
    } catch {
      this.scheduleCleanup();
      return;
    }
    for (const t of tabs) {
      const token = this.tokenOfLabel(t.label);
      const orphan = token ? this.orphans.get(token) : undefined;
      if (orphan && !orphan.awaiting) orphan.tabId = t.tab_id;
    }
    const closing = [...this.orphans.values()].filter((o) => o.tabId && !o.awaiting);
    for (const o of closing) {
      try {
        await this.call("tab.close", { tab_id: o.tabId });
        this.log(`[herdr] closed scratch tab ${o.tabId} of a creation whose reply was lost`);
      } catch {
        // tab_not_found is success; anything else is checked by the list below
      }
    }
    if (closing.length > 0) {
      try {
        const present = new Set((await this.listTabs()).map((t) => t.tab_id));
        for (const [token, o] of [...this.orphans])
          if (o.tabId && !present.has(o.tabId)) this.orphans.delete(token);
      } catch {
        // not verified: the tokens stay
      }
    }
    if ([...this.orphans.values()].some((o) => o.tabId)) this.scheduleCleanup();
    else this.cleanupDelay = this.o.cleanupRetryMs ?? CLEANUP_RETRY_MS;
  }

  private scheduleCleanup(): void {
    if (this.cleanupTimer || this.stopped) return;
    const delay = this.cleanupDelay;
    this.cleanupDelay = Math.min(delay * 2, CLEANUP_RETRY_MAX_MS);
    this.cleanupTimer = setTimeout(() => {
      this.cleanupTimer = null;
      void this.reconcile();
    }, delay);
    this.cleanupTimer.unref?.();
  }

  /** After a lost reply or a dropped event stream: close what we own and cannot account for. */
  private async reconcile(): Promise<void> {
    if (this.stopped) return;
    for (const r of [...this.records.values()]) {
      if (r.stray) {
        await this.closePane(r);
        continue;
      }
      try {
        await this.call("pane.get", { pane_id: r.paneId });
      } catch (e) {
        if (e instanceof HerdrApiError && e.code === "pane_not_found") this.forget(r);
      }
    }
    await this.cleanOrphans();
  }

  /* ───────────────────────────── herdr ───────────────────────────── */

  private call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.o.herdr.request(method, params);
  }

  private async listTabs(): Promise<TabInfo[]> {
    const r = await this.call("tab.list", { workspace_id: this.workspaceId });
    const tabs = Array.isArray(r.tabs) ? r.tabs : [];
    return tabs.map((t) => {
      const tab = rec(t);
      return {
        tab_id: str(tab.tab_id),
        label: str(tab.label),
        number: typeof tab.number === "number" ? tab.number : 0,
      };
    });
  }
}
