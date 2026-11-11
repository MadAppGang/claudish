/**
 * Who holds the active view of each item. One claim per target, the latest act wins, and memory
 * is the only store.
 *
 * Holder and label always come from the caller's role, never from a client's words. A viewer's
 * claim lives 15 s and its heartbeat renews it; a Claude Code claim (this server's MCP link, or
 * another server's) lives 10 s and is renewed by a resize or by that owner's own capture. Closing a
 * connection releases what it held. One `unref()`'d timer sits at the earliest expiry and only
 * exists while a claim does.
 */

import { randomBytes } from "node:crypto";
import type { ViewHolder } from "../pane/contract.js";
import { ViewError } from "../pane/view-contract.js";

export const VIEWER_CLAIM_TTL_MS = 15_000;
export const CLAUDE_CODE_CLAIM_TTL_MS = 10_000;
const TERM_PROGRAM_MAX_CHARS = 24;

export type ClaimCaller =
  | { kind: "mcp" }
  | {
      kind: "conn";
      connId: string;
      role: "viewer" | "peer";
      frontEnd?: string;
      termProgram?: string;
    };

/** The caller every MCP verb passes. */
export const MCP_CALLER: ClaimCaller = { kind: "mcp" };

interface Claim {
  claimId: string;
  holder: ViewHolder["holder"];
  label: string;
  /** "mcp", or the connection id */
  owner: string;
  ownerRole: "mcp" | "peer" | "viewer";
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

function ttlOf(ownerRole: Claim["ownerRole"]): number {
  return ownerRole === "viewer" ? VIEWER_CLAIM_TTL_MS : CLAUDE_CODE_CLAIM_TTL_MS;
}

/** `term_program` reaches other clients as a label: only these characters, and not many of them. */
function terminalLabel(termProgram: string | undefined): string {
  const clean = (termProgram ?? "")
    .replace(/[^A-Za-z0-9 ._-]/g, "")
    .slice(0, TERM_PROGRAM_MAX_CHARS)
    .trim();
  return clean || "a terminal";
}

function holderOfCaller(caller: ClaimCaller): Pick<Claim, "holder" | "label" | "ownerRole"> {
  if (caller.kind === "mcp")
    return { holder: "claude_code", label: "Claude Code", ownerRole: "mcp" };
  if (caller.role === "peer")
    return { holder: "claude_code", label: "Claude Code", ownerRole: "peer" };
  const frontEnd = caller.frontEnd ?? "none";
  if (frontEnd === "herdr") return { holder: "herdr", label: "herdr", ownerRole: "viewer" };
  if (frontEnd === "herdr-core")
    return { holder: "herdr_app", label: "Herdr.app", ownerRole: "viewer" };
  if (frontEnd === "none")
    return { holder: "terminal", label: terminalLabel(caller.termProgram), ownerRole: "viewer" };
  throw new ViewError("forbidden", `unknown front end ${JSON.stringify(frontEnd)}`);
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

  /** The latest act wins. Throws `forbidden` for a front end this server does not know. */
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
      expiresAt: now + ttlOf(who.ownerRole),
    };
    this.claims.set(target, next);
    this.schedule();
    if (!same) this.notify(target);
    return toHolder(next);
  }

  /** A viewer's heartbeat. Throws `view_not_held` when the caller does not hold the view. */
  renew(target: string, caller: ClaimCaller): ViewHolder {
    const cur = this.live(target);
    if (!cur || cur.owner !== ownerOf(caller))
      throw new ViewError("view_not_held", `this client does not hold the view of ${target}`);
    cur.expiresAt = this.now() + ttlOf(cur.ownerRole);
    this.schedule();
    return toHolder(cur);
  }

  /** A capture renews only a Claude Code claim, and only for the owner of that claim. */
  renewFromCapture(target: string, caller: ClaimCaller): void {
    if (caller.kind === "conn" && caller.role !== "peer") return;
    const cur = this.live(target);
    if (!cur || cur.owner !== ownerOf(caller)) return;
    cur.expiresAt = this.now() + CLAUDE_CODE_CLAIM_TTL_MS;
    this.schedule();
  }

  /** Drops the caller's claim when it holds one. Answers who holds the view now. */
  release(target: string, caller: ClaimCaller): ViewHolder | null {
    const cur = this.live(target);
    if (cur && cur.owner === ownerOf(caller)) this.drop(target);
    return this.holder(target);
  }

  /** Everything a closed connection held. */
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
