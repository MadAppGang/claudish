/**
 * Who holds the active view of each item. One claim per target, the latest act wins, and memory
 * is the only store.
 *
 * Only Claude Code holds a view: this server's MCP link, or another server relaying its own Claude
 * Code over a peer connection. A local viewer only watches, so a viewer caller is refused. Holder
 * and label come from the caller's role, never from a client's words. A claim lives 10 s and is
 * renewed by a resize or by that owner's own capture. Closing a peer connection releases what it
 * held. One `unref()`'d timer sits at the earliest expiry and only exists while a claim does.
 */

import { randomBytes } from "node:crypto";
import type { ViewHolder } from "../pane/contract.js";
import { ViewError } from "../pane/view-contract.js";

export const CLAUDE_CODE_CLAIM_TTL_MS = 10_000;

export type ClaimCaller =
  | { kind: "mcp" }
  | {
      kind: "conn";
      connId: string;
      role: "viewer" | "peer";
    };

/** The caller every MCP verb passes. */
export const MCP_CALLER: ClaimCaller = { kind: "mcp" };

interface Claim {
  claimId: string;
  holder: ViewHolder["holder"];
  label: string;
  /** "mcp", or the peer connection's id */
  owner: string;
  ownerRole: "mcp" | "peer";
  since: string;
  expiresAt: number;
}

export interface ViewClaimsOptions {
  /** told about a target whose holder changed; never for a renewal */
  notify?: (target: string) => void;
  now?: () => number;
}

function ownerOf(caller: ClaimCaller): string {
  return caller.kind === "mcp" ? "mcp" : caller.connId;
}

function holderOfCaller(caller: ClaimCaller): Pick<Claim, "holder" | "label" | "ownerRole"> {
  if (caller.kind === "mcp")
    return { holder: "claude_code", label: "Claude Code", ownerRole: "mcp" };
  if (caller.role === "peer")
    return { holder: "claude_code", label: "Claude Code", ownerRole: "peer" };
  throw new ViewError("forbidden", "a viewer only watches; Claude Code holds the view");
}

function toHolder(c: Claim): ViewHolder {
  return { holder: c.holder, label: c.label, since: c.since, claim_id: c.claimId };
}

export class ViewClaims {
  private readonly claims = new Map<string, Claim>();
  private readonly notify: (target: string) => void;
  private readonly now: () => number;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ViewClaimsOptions = {}) {
    this.notify = options.notify ?? (() => {});
    this.now = options.now ?? Date.now;
  }

  /** The latest act wins. Throws `forbidden` for a viewer, which never holds a view. */
  claim(target: string, caller: ClaimCaller): ViewHolder {
    const who = holderOfCaller(caller);
    const by = ownerOf(caller);
    const now = this.now();
    const cur = this.live(target);
    const same = cur?.owner === by;
    const next: Claim = {
      ...who,
      claimId: same && cur ? cur.claimId : randomBytes(8).toString("hex"),
      owner: by,
      since: same && cur ? cur.since : new Date(now).toISOString(),
      expiresAt: now + CLAUDE_CODE_CLAIM_TTL_MS,
    };
    this.claims.set(target, next);
    this.schedule();
    if (!same) this.notify(target);
    return toHolder(next);
  }

  /** A capture renews a claim only for the owner of that claim. */
  renewFromCapture(target: string, caller: ClaimCaller): void {
    if (caller.kind === "conn" && caller.role !== "peer") return;
    const cur = this.live(target);
    if (!cur || cur.owner !== ownerOf(caller)) return;
    cur.expiresAt = this.now() + CLAUDE_CODE_CLAIM_TTL_MS;
    this.schedule();
  }

  /** Everything a closed peer connection held. */
  releaseConnection(connId: string): void {
    for (const [target, c] of [...this.claims])
      if (c.owner === connId && c.expiresAt > this.now()) this.drop(target);
  }

  /** The item is gone: its claim goes without telling anyone. */
  forget(target: string): void {
    this.claims.delete(target);
    this.schedule();
  }

  holds(target: string, caller: ClaimCaller): boolean {
    return this.live(target)?.owner === ownerOf(caller);
  }

  /** The holder with absolute names: the local transport's view. */
  holder(target: string): ViewHolder | null {
    const cur = this.live(target);
    return cur ? toHolder(cur) : null;
  }

  /** The holder as this server's own Claude Code should read it. */
  holderForMcp(target: string): ViewHolder | null {
    const cur = this.live(target);
    if (!cur) return null;
    if (cur.ownerRole !== "peer") return toHolder(cur);
    return { ...toHolder(cur), holder: "claude_code_other", label: "another Claude Code" };
  }

  viewFor(target: string, caller: ClaimCaller): ViewHolder | null {
    return caller.kind === "mcp" ? this.holderForMcp(target) : this.holder(target);
  }

  /** `answer` with the `view` this caller should read. */
  stamp<T extends object>(
    answer: T,
    target: string,
    caller: ClaimCaller
  ): T & { view: ViewHolder | null } {
    return { ...answer, view: this.viewFor(target, caller) };
  }

  /** An expired entry reads as absent even before the timer has removed it. */
  private live(target: string): Claim | undefined {
    const c = this.claims.get(target);
    return c && c.expiresAt > this.now() ? c : undefined;
  }

  private drop(target: string): void {
    if (!this.claims.delete(target)) return;
    this.schedule();
    this.notify(target);
  }

  private schedule(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    let earliest = Number.POSITIVE_INFINITY;
    for (const c of this.claims.values()) earliest = Math.min(earliest, c.expiresAt);
    if (earliest === Number.POSITIVE_INFINITY) return;
    this.timer = setTimeout(() => this.expire(), Math.max(0, earliest - this.now()));
    this.timer.unref?.();
  }

  private expire(): void {
    this.timer = null;
    const now = this.now();
    const lapsed = [...this.claims].filter(([, c]) => c.expiresAt <= now).map(([t]) => t);
    for (const target of lapsed) this.claims.delete(target);
    this.schedule();
    for (const target of lapsed) this.notify(target);
  }
}
