/**
 * Who may place a herdr pane for a replay, decided on the replay's owner: the one place every
 * server of that replay meets.
 *
 * A workspace gets a grant only when it has neither a connected herdr viewer of the replay nor a
 * reservation. A grant is a reservation owned by the asker and named by a placement transaction.
 * The transaction id stays the same across the placement's retries; each creation attempt has its
 * own attempt token, and the pane it creates carries `<txn>.<attempt>` to its viewer's hello.
 *
 * A reservation ends only when:
 * - the placer reports the transaction placed AND the viewer of its current attempt is connected
 *   (in either order); from then on that viewer's presence keeps the workspace;
 * - the placer reports the transaction done (failed, dropped, or its pane went away);
 * - the reserving owner goes away.
 * A viewer never ends a reservation by subscribing. One from an abandoned attempt, or one the user
 * started, counts as presence while connected and nothing more, so when it disconnects the
 * reservation is still there and a second asker in the same workspace is still refused.
 */

export type GrantOwner = string;

interface Reservation {
  txn: string;
  owner: GrantOwner;
  /** the attempt now in flight; null before the first creation call */
  attempt: string | null;
  /** the connection of the current attempt's viewer, while connected */
  viewerConn: string | null;
  placed: boolean;
}

interface TargetGrants {
  /** connection id → workspace key and placement token, for connected herdr viewers */
  viewers: Map<string, { workspaceKey: string; placement: string | null }>;
  /** workspace key → reservation */
  reservations: Map<string, Reservation>;
}

export interface PlacementGrantsOptions {
  /** the target's `herdr_workspaces` changed */
  notify?: (target: string) => void;
}

/** `<txn>.<attempt>`: what a placed pane's viewer says in its hello. */
export function placementToken(txn: string, attempt: string): string {
  return `${txn}.${attempt}`;
}

export class PlacementGrants {
  private readonly byTarget = new Map<string, TargetGrants>();
  /** txn → target and workspace, to find a reservation by its transaction */
  private readonly byTxn = new Map<string, { target: string; workspaceKey: string }>();

  constructor(private readonly o: PlacementGrantsOptions = {}) {}

  /** Atomic: true adds a reservation for `owner`, false changes nothing. */
  grant(target: string, workspaceKey: string, owner: GrantOwner, txn: string): boolean {
    const g = this.grantsOf(target);
    if (g.reservations.has(workspaceKey)) return false;
    for (const v of g.viewers.values()) if (v.workspaceKey === workspaceKey) return false;
    g.reservations.set(workspaceKey, {
      txn,
      owner,
      attempt: null,
      viewerConn: null,
      placed: false,
    });
    this.byTxn.set(txn, { target, workspaceKey });
    this.o.notify?.(target);
    return true;
  }

  /** The transaction's creation attempt now in flight; earlier attempts' viewers stop counting. */
  attempt(txn: string, attempt: string): void {
    const r = this.reservationOf(txn);
    if (!r) return;
    r.attempt = attempt;
    r.viewerConn = null;
  }

  /** The transaction's pane is in place. */
  placed(txn: string): void {
    const r = this.reservationOf(txn);
    if (!r) return;
    r.placed = true;
    this.settle(txn, r);
  }

  /** A connected herdr viewer subscribed to `target`. `placement` is its `<txn>.<attempt>`, if placed. */
  viewerSubscribed(
    target: string,
    connId: string,
    workspaceKey: string,
    placement: string | null
  ): void {
    const g = this.grantsOf(target);
    g.viewers.set(connId, { workspaceKey, placement });
    const r = g.reservations.get(workspaceKey);
    if (r?.attempt && placement === placementToken(r.txn, r.attempt)) {
      r.viewerConn = connId;
      this.settle(r.txn, r);
    }
    this.o.notify?.(target);
  }

  /** The connection closed: its viewer presence goes, and every reservation it owned. */
  connectionGone(connId: string): void {
    for (const [target, g] of [...this.byTarget]) {
      let changed = g.viewers.delete(connId);
      for (const [key, r] of [...g.reservations]) {
        if (r.viewerConn === connId) r.viewerConn = null;
        if (r.owner !== connId) continue;
        g.reservations.delete(key);
        this.byTxn.delete(r.txn);
        changed = true;
      }
      if (changed) this.changed(target);
    }
  }

  /** The placement will not become a viewer. A no-op for a transaction already ended. */
  done(txn: string): void {
    const at = this.byTxn.get(txn);
    if (!at) return;
    this.byTxn.delete(txn);
    const g = this.byTarget.get(at.target);
    if (g?.reservations.get(at.workspaceKey)?.txn === txn) g.reservations.delete(at.workspaceKey);
    this.changed(at.target);
  }

  /** True while the transaction still holds its reservation. */
  pending(txn: string): boolean {
    return this.reservationOf(txn) !== null;
  }

  /** Workspace keys with a herdr viewer or a reservation, sorted. */
  workspaces(target: string): string[] {
    const g = this.byTarget.get(target);
    if (!g) return [];
    const keys = [...g.viewers.values()].map((v) => v.workspaceKey);
    return [...new Set([...keys, ...g.reservations.keys()])].sort();
  }

  forget(target: string): void {
    const g = this.byTarget.get(target);
    if (!g) return;
    for (const r of g.reservations.values()) this.byTxn.delete(r.txn);
    this.byTarget.delete(target);
  }

  /** Placed and its viewer connected: the viewer's presence keeps the workspace from now on. */
  private settle(txn: string, r: Reservation): void {
    if (!r.placed || !r.viewerConn) return;
    const at = this.byTxn.get(txn);
    if (!at) return;
    this.byTxn.delete(txn);
    this.byTarget.get(at.target)?.reservations.delete(at.workspaceKey);
    this.o.notify?.(at.target);
  }

  private reservationOf(txn: string): Reservation | null {
    const at = this.byTxn.get(txn);
    if (!at) return null;
    const r = this.byTarget.get(at.target)?.reservations.get(at.workspaceKey);
    return r && r.txn === txn ? r : null;
  }

  private grantsOf(target: string): TargetGrants {
    let g = this.byTarget.get(target);
    if (!g) {
      g = { viewers: new Map(), reservations: new Map() };
      this.byTarget.set(target, g);
    }
    return g;
  }

  private changed(target: string): void {
    const g = this.byTarget.get(target);
    if (g && g.viewers.size === 0 && g.reservations.size === 0) this.byTarget.delete(target);
    this.o.notify?.(target);
  }
}
