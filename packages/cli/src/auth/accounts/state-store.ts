/**
 * `~/.claudish/accounts/state.json` — the shared, cross-process account state:
 * usage snapshots, `exhaustedUntil`, `needsReauth`, the named refresher, and the
 * sticky `active` account.
 *
 * ## Every write is a FIELD-WISE read-modify-write under `state.lock`
 *
 * The document is re-read INSIDE the lock and merged field by field. The defect
 * this exists to prevent is not the rename — a correct locked RMW also ends in an
 * atomic rename — it is persisting a snapshot taken BEFORE the lock, under which
 * process B's usage write silently erases process A's exhaustion mark.
 *
 * Merge rules:
 *
 * | Field | Rule |
 * |---|---|
 * | `usage` | newest `observedAt` wins |
 * | `exhaustedUntil` | `max(existing, incoming)` — a later reset is never walked back; a clear removes only marks it had SEEN |
 * | `needsReauth` | set by the gate holder only, self-healing against its recorded baseline; a clear after a rotation removes only a failure recorded BELOW the new generation, and a self-heal clear only a mark about the material it saw replaced |
 * | `owner`, `handoff` | compare-and-set on the previous value |
 * | `active` | compare-and-set, with reload-and-reapply, and the target must still exist in the account list |
 *
 * ## The pending overlay: what this process knows that the document does not
 *
 * Every mark is first recorded in an in-memory PENDING overlay, then written.
 * The overlay is what this process's own selection reads, layered over the
 * document, and it is cleared only by a write that actually landed. So:
 *
 * - a mark dropped because `state.lock` was busy, or `state.json` was
 *   unreadable, is still honoured by this process — and is MERGED into the next
 *   write that succeeds, whichever field that write was for. It is never
 *   discarded by an unrelated success, which is what the previous "drop the
 *   cache after any write" rule did;
 * - a coalesced sub-threshold usage reading rides on the next write, or on the
 *   `beforeExit` flush.
 *
 * ## The document is REVALIDATED, never served forever
 *
 * `read()` re-stats `state.json` on every call and re-reads it when its mtime,
 * size or inode changed — the same rule `registry.ts` uses. A long-lived `serve`
 * process therefore sees another process's exhaustion, `needsReauth` and
 * `active` within one answer. An I/O failure is never cached: the next answer
 * retries it.
 *
 * ## Failure semantics, which differ from the refresh gate on purpose
 *
 * Failing a user's turn because an EXHAUSTION MARK could not be persisted is
 * worse than the mark being late. So an update that cannot be written is
 * dropped — **silently** when it is coalescible (a sub-threshold usage
 * movement), **loudly** when it is selection-relevant (a threshold crossing,
 * exhaustion, `needsReauth`, `active`, `owner`, `handoff`): logged, and surfaced
 * in `account status` as "state not persisted — <field> for <account>" until a
 * later write carries it. The pending value is still used for this process's own
 * selection.
 *
 * ## `failed` is not `absent`, and a file we could not read is NEVER overwritten
 *
 * Three outcomes, kept apart both when reading and under the lock:
 *
 * - **absent** (`ENOENT`) — start from an empty document.
 * - **unreadable** (`EACCES`, `EMFILE`, `EIO`, …) — reads report
 *   `unknown-failed`, which the policy ranks LAST; a write does NOT happen: the
 *   mark stays pending in memory and the drop is reported. Writing an empty
 *   document over a file that merely could not be read would erase every other
 *   account's exhaustion, every `needsReauth` and the `active` pointer.
 * - **corrupt** (unparseable, or not an object) — reads report `unknown-failed`.
 *   Under the lock the file is moved to `state.json.corrupt-<ts>` (the evidence
 *   is kept) and only then is a fresh document written. If it cannot be moved,
 *   nothing is written.
 *
 * Quarantine happens ONLY under `state.lock`. A lock-free reader that renamed a
 * corrupt file aside could, between its read and its rename, move a VALID
 * document that a locked writer had just put in its place.
 *
 * **A stale OVER-THRESHOLD reading must never decay into "unknown".** That decay
 * is what resurrects a spent account before its window resets; `unknown` is
 * reserved for an account with no usable observation at all. The rule is enforced
 * in `policy.ts`, and this module's job is simply never to drop an old snapshot.
 */

import { existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { log } from "../../logger.js";
import { atomicWriteFileSync } from "./atomic-write.js";
import type { FileLockOptions, LockHandle } from "./file-lock.js";
import { stateLockFilePath, statePath } from "./paths.js";
import { getAccountRegistry } from "./registry.js";
import { withStateLock } from "./state-lock.js";
import type { AccountProvider, AccountRef, NeedsReauthRecord, UsageSnapshot } from "./types.js";

export interface QuotaObservation {
  at: number;
  resetAt?: number;
  estimated?: boolean;
}

/** State for one account. Every field optional: absence is a real answer. */
export interface AccountState {
  usage?: UsageSnapshot;
  /** Epoch ms. The account cannot serve until then. */
  exhaustedUntil?: number;
  /** True when `exhaustedUntil` was synthesized rather than reported. */
  exhaustedEstimated?: boolean;
  quotaEstimateCount?: number;
  quotaObservations?: Record<string, QuotaObservation>;
  needsReauth?: NeedsReauthRecord;
  /** Who may refresh unilaterally. `state.json` is the sole authority. */
  owner?: "claudish" | "claude-code";
  /** Epoch ms of the last outcome report, for `account status`'s "last seen". */
  lastSeenAt?: number;
}

export interface ProviderState {
  /** The sticky account id. Compare-and-set; validated against the account list. */
  active?: string;
  accounts: Record<string, AccountState>;
}

export interface AccountsState {
  version: 1;
  providers: Partial<Record<AccountProvider, ProviderState>>;
  /**
   * The in-flight `account use` handoff (Phase 4 writes it; Phase 1 preserves it).
   * Phases: ai-docs/architecture/accounts.md.
   */
  handoff?: Record<string, unknown>;
}

/** How the read went. `failed` and `absent` are different answers. */
export type StateReadKind = "ok" | "absent" | "failed";

export interface StateReadResult {
  kind: StateReadKind;
  state: AccountsState;
  error?: string;
}

export function emptyState(): AccountsState {
  return { version: 1, providers: {} };
}

/** A dropped update, surfaced by `account status` until a later write carries it. */
export interface DropRecord {
  field: string;
  account: string;
  reason: string;
  at: number;
}

export interface StateStoreOptions {
  path?: string;
  lockPath?: string;
  now?: () => number;
  /**
   * Does this account still exist in the account list? Injected rather than imported
   * so the store stays testable without a config file — and so a reapplied
   * `active` change cannot point at an account another process deleted.
   * {@link getStateStore} wires it to the process account list.
   */
  accountListHas?: (provider: AccountProvider, accountId: string) => boolean;
  /** Coalescing window for sub-threshold usage writes. */
  coalesceMs?: number;
  /** Seams for `state.lock` (clock, hostname, liveness, sleep). */
  lockDeps?: FileLockOptions["deps"];
}

/** One write per 5 s per process for sub-threshold usage movements. */
export const COALESCE_MS = 5_000;

type Owner = "claudish" | "claude-code";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Narrow a parsed document into `AccountsState`.
 *
 * Unknown providers and unknown fields are dropped from the TYPED view but the
 * raw document is not rewritten from it — see {@link StateStore.persist}, which
 * merges into the document it just read so a newer claudish's fields survive an
 * older one's write.
 */
function viewOf(raw: Record<string, unknown>): AccountsState {
  const providers = isRecord(raw.providers) ? raw.providers : {};
  const out: AccountsState = { version: 1, providers: {} };
  for (const [provider, value] of Object.entries(providers)) {
    if (!isRecord(value)) continue;
    const accounts: Record<string, AccountState> = {};
    if (isRecord(value.accounts)) {
      for (const [id, st] of Object.entries(value.accounts)) {
        if (isRecord(st)) accounts[id] = st as AccountState;
      }
    }
    out.providers[provider as AccountProvider] = {
      accounts,
      ...(typeof value.active === "string" ? { active: value.active } : {}),
    };
  }
  if (isRecord(raw.handoff)) out.handoff = raw.handoff;
  return out;
}

// ---------------------------------------------------------------------------
// Reading the file: absent / unreadable / corrupt / ok
// ---------------------------------------------------------------------------

interface FileStamp {
  mtimeMs: number;
  size: number;
  ino: number;
}

type DiskRead =
  | { kind: "absent" }
  | { kind: "ok"; raw: Record<string, unknown>; stamp: FileStamp }
  /** Could not be READ. Never cached, never overwritten. */
  | { kind: "unreadable"; error: string }
  /** Read, but not a JSON object. Cached against its stamp; quarantined under the lock. */
  | { kind: "corrupt"; error: string; stamp: FileStamp };

type StatProbe = { kind: "absent" } | { kind: "present"; stamp: FileStamp } | { kind: "error" };

function statProbe(file: string): StatProbe {
  try {
    const st = statSync(file);
    return { kind: "present", stamp: { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino } };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? { kind: "absent" } : { kind: "error" };
  }
}

function sameStamp(a: FileStamp, b: FileStamp): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size && a.ino === b.ino;
}

function readDisk(file: string): DiskRead {
  let stamp: FileStamp;
  try {
    const st = statSync(file);
    stamp = { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    return { kind: "unreadable", error: errorText(err) };
  }
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable", error: errorText(err) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { kind: "corrupt", error: errorText(err), stamp };
  }
  if (!isRecord(parsed)) return { kind: "corrupt", error: "state.json is not an object", stamp };
  return { kind: "ok", raw: parsed, stamp };
}

// ---------------------------------------------------------------------------
// The pending overlay
// ---------------------------------------------------------------------------

/**
 * The material a `needsReauth` mark was recorded against: its baseline pair.
 * Two marks with the same pair are about the same failed credential.
 */
export type ReauthMaterial = Pick<NeedsReauthRecord, "failedFingerprint" | "failedGeneration">;

/** Everything this process has decided about one account that may not be on disk yet. */
interface PendingAccount {
  ref: AccountRef;
  usage?: UsageSnapshot;
  lastSeenAt?: number;
  /** Remove any exhaustion mark whose reset is at or before this. Applied BEFORE `exhausted`. */
  clearExhaustedUpTo?: number;
  exhausted?: { resetAt: number; estimated: boolean };
  quota?: Map<string, QuotaObservation>;
  successfulUsageAt?: number;
  needsReauth?:
    | { op: "set"; record: NeedsReauthRecord }
    /**
     * With neither bound, unconditional (a login). `belowGeneration`: only a
     * failure recorded below it. `failedAgainst`: only a failure recorded against
     * that same material. See {@link mergeNeedsReauth}.
     */
    | { op: "clear"; belowGeneration?: number; failedAgainst?: ReauthMaterial };
  owner?: { value: Owner; expected?: Owner };
}

interface PendingActive {
  accountId: string;
  expectedPrevious?: string;
}

function accountKey(ref: AccountRef): string {
  return `${ref.provider}:${ref.id}`;
}

function newerUsage(a: UsageSnapshot | undefined, b: UsageSnapshot): UsageSnapshot {
  return a && a.observedAt > b.observedAt ? a : b;
}

/** Reach into `doc.providers[p]`, creating the path. */
function providerNode(doc: Record<string, unknown>, provider: string): Record<string, unknown> {
  if (!isRecord(doc.providers)) doc.providers = {};
  const providers = doc.providers as Record<string, unknown>;
  if (!isRecord(providers[provider])) providers[provider] = { accounts: {} };
  return providers[provider] as Record<string, unknown>;
}

/** Reach into `doc.providers[p].accounts[id]`, creating the path. */
function accountNode(doc: Record<string, unknown>, ref: AccountRef): Record<string, unknown> {
  const provider = providerNode(doc, ref.provider);
  if (!isRecord(provider.accounts)) provider.accounts = {};
  const accounts = provider.accounts as Record<string, unknown>;
  if (!isRecord(accounts[ref.id])) accounts[ref.id] = {};
  return accounts[ref.id] as Record<string, unknown>;
}

/**
 * Merge one account's pending marks into a document node, by the table in the
 * header. Returns false when the pending `owner` compare-and-set does not hold
 * against this node — the caller decides whether that is an error.
 */
function mergeAccount(node: Record<string, unknown>, p: PendingAccount): boolean {
  mergeUsage(node, p);
  mergeExhaustion(node, p);
  mergeQuotaObservations(node, p);
  mergeNeedsReauth(node, p);
  if (p.owner) {
    const current = node.owner as Owner | undefined;
    if (p.owner.expected !== undefined && current !== p.owner.expected) return false;
    node.owner = p.owner.value;
  }
  return true;
}

/** `usage`: newest `observedAt` wins. `lastSeenAt`: the later of the two. */
function mergeUsage(node: Record<string, unknown>, p: PendingAccount): void {
  if (p.usage) {
    const existing = node.usage as UsageSnapshot | undefined;
    if (!isRecord(existing) || numberOr(existing.observedAt, 0) <= p.usage.observedAt) {
      node.usage = p.usage;
    }
  }
  if (p.lastSeenAt !== undefined) {
    node.lastSeenAt = Math.max(numberOr(node.lastSeenAt, 0), p.lastSeenAt);
  }
}

/** `exhaustedUntil`: a bounded clear first, then `max()`. */
function mergeExhaustion(node: Record<string, unknown>, p: PendingAccount): void {
  if (p.clearExhaustedUpTo !== undefined) {
    const current = node.exhaustedUntil;
    if (typeof current !== "number" || current <= p.clearExhaustedUpTo) {
      delete node.exhaustedUntil;
      delete node.exhaustedEstimated;
    }
  }
  if (!p.exhausted) return;
  const previous = numberOr(node.exhaustedUntil, 0);
  // max(): a later reset is never walked back by a staler observation. On a
  // tie, a REPORTED reset beats an estimated one.
  if (p.exhausted.resetAt > previous) {
    node.exhaustedUntil = p.exhausted.resetAt;
    node.exhaustedEstimated = p.exhausted.estimated;
  } else if (p.exhausted.resetAt === previous) {
    node.exhaustedEstimated = node.exhaustedEstimated === true && p.exhausted.estimated;
  }
}

/** Identical merge for the pending view and the locked, re-read disk document. */
function mergeQuotaObservations(node: Record<string, unknown>, p: PendingAccount): void {
  const seen = isRecord(node.quotaObservations) ? { ...node.quotaObservations } : {};
  const latestQuotaAt = Math.max(
    0,
    ...Object.values(seen).map((v) => (isRecord(v) ? numberOr(v.at, 0) : 0))
  );
  if (
    p.successfulUsageAt !== undefined &&
    latestQuotaAt <= p.successfulUsageAt &&
    numberOr(node.exhaustedUntil, Number.POSITIVE_INFINITY) <= p.successfulUsageAt
  ) {
    node.quotaEstimateCount = 0;
  }
  for (const [requestId, observation] of p.quota ?? []) {
    const prior = isRecord(seen[requestId]) ? seen[requestId] : undefined;
    const authoritative =
      observation.estimated !== true && numberOr(observation.resetAt, 0) > observation.at;
    let resetAt: number;
    if (authoritative) {
      resetAt = Math.max(
        observation.resetAt as number,
        prior?.estimated === false ? numberOr(prior.resetAt, 0) : 0
      );
      node.quotaEstimateCount = 0;
    } else if (prior) {
      resetAt = numberOr(prior.resetAt, observation.at);
    } else {
      const count = Math.max(0, numberOr(node.quotaEstimateCount, 0));
      resetAt = observation.at + Math.min(5 * 60, 15 * 2 ** Math.min(count, 5)) * 60_000;
      node.quotaEstimateCount = Math.min(count + 1, 6);
    }
    const estimated = !authoritative && (!prior || prior.estimated === true);
    seen[requestId] = { at: observation.at, resetAt, estimated };
    mergeExhaustion(node, { ref: p.ref, exhausted: { resetAt, estimated } });
  }
  if (p.quota?.size) {
    // The request-local fold deduplicates its entire lifetime; retain recent ids
    // on disk as well so concurrent/repeated publication cannot double estimates.
    node.quotaObservations = Object.fromEntries(
      Object.entries(seen)
        .sort(
          ([, a], [, b]) =>
            numberOr((b as QuotaObservation).at, 0) - numberOr((a as QuotaObservation).at, 0)
        )
        .slice(0, 128)
    );
  }
}

/**
 * `needsReauth`: a set replaces. A clear removes the mark unless one of its
 * bounds says the mark on disk is NEWER evidence than the clear saw:
 *
 * - `belowGeneration` (after a successful rotation): a failure recorded AT or
 *   ABOVE the generation that healed us is kept — another process's rotation
 *   went bad afterwards.
 * - `failedAgainst` (the self-heal, after reading material the mark does not
 *   name): only a mark recorded against that SAME material — fingerprint and
 *   generation — is removed. A failure another process recorded against the new
 *   material survives, including when this clear rides on a later write.
 */
function mergeNeedsReauth(node: Record<string, unknown>, p: PendingAccount): void {
  if (p.needsReauth?.op === "set") {
    node.needsReauth = p.needsReauth.record;
    return;
  }
  if (p.needsReauth?.op !== "clear") return;
  const { belowGeneration: below, failedAgainst } = p.needsReauth;
  const current = node.needsReauth;
  const failedAt = isRecord(current) ? numberOr(current.failedGeneration, -1) : -1;
  if (below !== undefined && failedAt >= below) return;
  if (
    failedAgainst !== undefined &&
    isRecord(current) &&
    (current.failedFingerprint !== failedAgainst.failedFingerprint ||
      current.failedGeneration !== failedAgainst.failedGeneration)
  ) {
    return;
  }
  delete node.needsReauth;
}

/**
 * The state document, and every rule for changing it.
 *
 * One instance per process (see {@link getStateStore}); a test builds its own
 * with an explicit path and an injected clock.
 */
export class StateStore {
  private readonly file: string;
  private readonly lockFile: string;
  private readonly now: () => number;
  private readonly accountListHas: (provider: AccountProvider, accountId: string) => boolean;
  private readonly coalesceMs: number;
  private readonly lockDeps: FileLockOptions["deps"] | undefined;

  /** The last document read from disk. `null` = re-read on the next answer. */
  private disk: (DiskRead & { version: number }) | null = null;
  private diskVersion = 0;

  /** Marks not yet known to be on disk. Cleared only by a write that landed. */
  private readonly pendingAccounts = new Map<string, PendingAccount>();
  private readonly pendingActive = new Map<AccountProvider, PendingActive>();
  private pendingVersion = 0;

  /** The merged view, memoized on (disk version, pending version). */
  private view: { key: string; result: StateReadResult } | null = null;

  /** Selection-relevant updates still not on disk, keyed by `${field}:${account}`. */
  private readonly drops = new Map<string, DropRecord>();
  /**
   * Accounts whose pending `owner` compare-and-set failed inside ANOTHER call's
   * write. The `setOwner` that queued it must still reject, not report success.
   */
  private readonly staleOwnerConflicts = new Set<string>();
  /** Last usage write attempt per `${provider}:${id}`, for coalescing. */
  private readonly lastUsageWrite = new Map<string, number>();
  private flushHookInstalled = false;
  /** The pending version the last `beforeExit` flush attempted, so it cannot loop. */
  private exitFlushVersion = -1;

  constructor(opts: StateStoreOptions = {}) {
    this.file = opts.path ?? statePath();
    this.lockFile = opts.lockPath ?? stateLockFilePath();
    this.now = opts.now ?? (() => Date.now());
    this.accountListHas = opts.accountListHas ?? (() => true);
    this.coalesceMs = opts.coalesceMs ?? COALESCE_MS;
    this.lockDeps = opts.lockDeps;
  }

  // -- read ----------------------------------------------------------------

  /**
   * The document as this process should see it: what is on disk, revalidated
   * against the file's stamp, with this process's pending marks layered on top.
   *
   * Never throws: a caller that cannot read the state must still be able to
   * select an account (ranked last), because refusing to serve a turn over an
   * unreadable diagnostic file would be worse than serving it uninformed.
   * `force` re-reads the file even when its stamp has not moved.
   */
  read(force = false): StateReadResult {
    const disk = this.diskState(force);
    const key = `${disk.version}:${this.pendingVersion}`;
    if (this.view?.key === key) return this.view.result;

    const raw: Record<string, unknown> =
      disk.kind === "ok" ? structuredClone(disk.raw) : { version: 1, providers: {} };
    this.applyPending(raw, false);
    const result: StateReadResult = {
      kind: disk.kind === "ok" ? "ok" : disk.kind === "absent" ? "absent" : "failed",
      state: viewOf(raw),
      ...(disk.kind === "unreadable" || disk.kind === "corrupt" ? { error: disk.error } : {}),
    };
    this.view = { key, result };
    return result;
  }

  /** The on-disk document, re-read only when the file changed or could not be read. */
  private diskState(force: boolean): DiskRead & { version: number } {
    const cached = this.disk;
    if (!force && cached && cached.kind !== "unreadable") {
      const probe = statProbe(this.file);
      const unchanged =
        (cached.kind === "absent" && probe.kind === "absent") ||
        (cached.kind !== "absent" &&
          probe.kind === "present" &&
          sameStamp(cached.stamp, probe.stamp));
      if (unchanged) return cached;
    }
    const read = readDisk(this.file);
    if (read.kind === "unreadable") {
      log(`[accounts] state.json could not be READ: ${read.error}`);
    } else if (read.kind === "corrupt" && !(cached?.kind === "corrupt")) {
      log(`[accounts] state.json is corrupt (${read.error}); ranking every account last`);
    }
    this.disk = { ...read, version: ++this.diskVersion };
    return this.disk;
  }

  /** One account's state, plus whether the read that produced it failed. */
  stateFor(ref: AccountRef): { state: AccountState; failed: boolean } {
    const read = this.read();
    const state = read.state.providers[ref.provider]?.accounts[ref.id] ?? {};
    return { state, failed: read.kind === "failed" };
  }

  /** The sticky account id for a provider, or undefined. */
  activeId(provider: AccountProvider): string | undefined {
    return this.read().state.providers[provider]?.active;
  }

  /** Selection-relevant updates this process has not yet managed to persist. */
  dropped(): readonly DropRecord[] {
    return Array.from(this.drops.values());
  }

  // -- the overlay ---------------------------------------------------------

  private pendingFor(ref: AccountRef): PendingAccount {
    const key = accountKey(ref);
    let pending = this.pendingAccounts.get(key);
    if (!pending) {
      pending = { ref };
      this.pendingAccounts.set(key, pending);
    }
    return pending;
  }

  private touched(): void {
    this.pendingVersion++;
  }

  private hasPending(): boolean {
    return this.pendingAccounts.size > 0 || this.pendingActive.size > 0;
  }

  /**
   * Layer every pending mark onto `doc`. Returns the account keys whose pending
   * `owner` compare-and-set failed against it.
   *
   * `forDisk` gates the diagnostics only: the same merge runs for the view and
   * for the write, so what this process selects on is what it would persist.
   */
  private applyPending(doc: Record<string, unknown>, forDisk: boolean): Set<string> {
    const ownerConflicts = new Set<string>();
    for (const [key, pending] of this.pendingAccounts) {
      if (!mergeAccount(accountNode(doc, pending.ref), pending)) ownerConflicts.add(key);
    }
    for (const [provider, pending] of this.pendingActive) {
      this.mergeActive(providerNode(doc, provider), provider, pending, forDisk);
    }
    return ownerConflicts;
  }

  /** `active`: compare-and-set, reload-and-reapply, and never a deleted target. */
  private mergeActive(
    node: Record<string, unknown>,
    provider: AccountProvider,
    pending: PendingActive,
    forDisk: boolean
  ): void {
    const current = typeof node.active === "string" ? node.active : undefined;
    const target = this.accountListHas(provider, pending.accountId);
    if (pending.expectedPrevious !== undefined && current !== pending.expectedPrevious && !target) {
      // Reload-and-reapply: another process moved `active` while we decided,
      // and our choice has since been removed from the account list.
      if (forDisk) {
        log(
          `[accounts] not reapplying active=${pending.accountId} for ${provider}: it is no longer in the account list`
        );
      }
      if (current !== undefined && this.accountListHas(provider, current)) node.active = current;
      else delete node.active;
      return;
    }
    if (!target) {
      delete node.active;
      return;
    }
    node.active = pending.accountId;
  }

  // -- write ---------------------------------------------------------------

  /**
   * Write every pending mark under the lock, re-reading INSIDE it.
   *
   * Returns true when the write landed, which clears the whole overlay. On any
   * failure to write, the marks STAY pending (still honoured in memory, merged
   * into the next write that lands) and the drop is recorded — loudly unless
   * `coalescible`. An `owner` compare-and-set that fails for THIS call's own
   * mark rejects with an error, and nothing is written.
   */
  private async persist(
    field: string,
    account: string,
    coalescible: boolean,
    ownOwnerKey?: string
  ): Promise<boolean> {
    let outcome: WriteOutcome | { kind: "lock-unavailable" };
    try {
      outcome =
        (await withStateLock(async (handle) => this.writeUnderLock(handle, ownOwnerKey), {
          path: this.lockFile,
          ...(this.lockDeps ? { deps: this.lockDeps } : {}),
        })) ?? ({ kind: "lock-unavailable" } as const);
    } catch (err) {
      // A filesystem fault taking the lock or writing (`ENOSPC`, `EIO`, a
      // read-only HOME) is a diagnostic-state drop like any other, never a
      // request failure: a raw throw here used to fail a lease that already
      // held a usable token, as an unclassified error.
      outcome = { kind: "write-failed", error: err instanceof Error ? err.message : String(err) };
    }

    if (outcome.kind === "written") {
      if (ownOwnerKey !== undefined && this.staleOwnerConflicts.delete(ownOwnerKey)) {
        throw new Error(`owner for ${account} changed under us`);
      }
      return true;
    }
    if (outcome.kind === "owner-conflict") throw new Error(outcome.message);

    const reason =
      outcome.kind === "lock-unavailable"
        ? "state.lock could not be acquired"
        : outcome.kind === "fenced"
          ? "state.lock was lost before the write"
          : outcome.kind === "unreadable"
            ? `state.json could not be read under the lock, so it was not overwritten (${outcome.error})`
            : outcome.kind === "corrupt-unmovable"
              ? `state.json is corrupt and could not be moved aside, so it was not overwritten (${outcome.error})`
              : `state.json could not be written (${outcome.error})`;
    if (!coalescible) {
      const record: DropRecord = { field, account, reason, at: this.now() };
      this.drops.set(`${field}:${account}`, record);
      log(`[accounts] state not persisted — ${field} for ${account} (${reason})`);
    } else if (outcome.kind !== "lock-unavailable") {
      log(`[accounts] coalesced usage not persisted (${reason}); kept pending`);
    }
    this.installFlushHook();
    return false;
  }

  /** The critical section. Synchronous from here on: nothing can interleave. */
  private writeUnderLock(handle: LockHandle, ownOwnerKey: string | undefined): WriteOutcome {
    // A concurrent call in this process already carried everything pending onto
    // disk while this one waited for the lock: its marks landed, nothing to do.
    if (!this.hasPending()) return { kind: "written" };
    const disk = readDisk(this.file);
    let doc: Record<string, unknown>;
    switch (disk.kind) {
      case "unreadable":
        // NEVER overwrite a file we could not read — it may hold every other
        // account's state. The marks stay pending.
        log(`[accounts] state.json could not be read under the lock: ${disk.error}`);
        return { kind: "unreadable", error: disk.error };
      case "corrupt": {
        if (!handle.holdsLock()) return { kind: "fenced" };
        const moved = this.quarantine(disk.error);
        if (!moved) return { kind: "corrupt-unmovable", error: disk.error };
        doc = { version: 1, providers: {} };
        break;
      }
      case "absent":
        doc = { version: 1, providers: {} };
        break;
      default:
        doc = disk.raw;
    }

    const conflicts = this.applyPending(doc, true);
    if (ownOwnerKey !== undefined && conflicts.has(ownOwnerKey)) {
      const pending = this.pendingAccounts.get(ownOwnerKey);
      if (pending) pending.owner = undefined;
      this.touched();
      return {
        kind: "owner-conflict",
        message: `owner for ${pending?.ref.label ?? ownOwnerKey} changed under us`,
      };
    }
    for (const key of conflicts) {
      // Another call's compare-and-set that no longer holds: not written, and
      // remembered so THAT call rejects rather than reporting success.
      const pending = this.pendingAccounts.get(key);
      if (pending) pending.owner = undefined;
      this.staleOwnerConflicts.add(key);
      log(`[accounts] dropped a stale owner change for ${pending?.ref.label ?? key}`);
    }

    // The FENCE, immediately before the commit. `state.lock` has no heartbeat
    // and a 10 s stale TTL; a holder suspended past it may have been stolen
    // from, and a stolen-from holder must not rename over its successor's merge.
    if (!handle.holdsLock()) return { kind: "fenced" };
    try {
      atomicWriteFileSync(this.file, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
    } catch (err) {
      // Nothing landed: the marks stay pending, as for any other failed write.
      return { kind: "write-failed", error: err instanceof Error ? err.message : String(err) };
    }

    // Everything pending was merged into what just landed.
    this.pendingAccounts.clear();
    this.pendingActive.clear();
    this.drops.clear();
    this.touched();
    // Re-read on the next answer rather than trusting our own copy: another
    // process may write between this rename and the next stat.
    this.disk = null;
    return { kind: "written" };
  }

  /**
   * Move a corrupt document aside, keeping it as evidence. Under the lock only.
   * Returns false when it could not be moved — the caller then writes nothing.
   */
  private quarantine(detail: string): boolean {
    let target = `${this.file}.corrupt-${this.now()}`;
    for (let n = 1; existsSync(target); n++) target = `${this.file}.corrupt-${this.now()}-${n}`;
    try {
      renameSync(this.file, target);
      log(`[accounts] state.json was corrupt (${detail}); moved to ${target}`);
      return true;
    } catch (err) {
      log(`[accounts] state.json was corrupt (${detail}); could not move it aside: ${err}`);
      return false;
    }
  }

  /**
   * Record a usage reading.
   *
   * `selectionRelevant` — a threshold crossing — persists immediately; anything
   * else coalesces at one write per `coalesceMs` per account and is flushed on
   * `beforeExit` (or carried by the next write that lands). Overshoot is then
   * bounded by the requests already in flight at the crossing, which is the
   * point of persisting the crossing itself at once.
   */
  noteUsage(ref: AccountRef, usage: UsageSnapshot): void {
    const pending = this.pendingFor(ref);
    pending.usage = newerUsage(pending.usage, usage);
    pending.lastSeenAt = Math.max(pending.lastSeenAt ?? 0, usage.observedAt);
    this.touched();
    this.installFlushHook();
  }

  async recordUsage(
    ref: AccountRef,
    usage: UsageSnapshot,
    opts: { selectionRelevant: boolean } = { selectionRelevant: true }
  ): Promise<boolean> {
    this.noteUsage(ref, usage);
    const key = accountKey(ref);
    if (!opts.selectionRelevant) {
      const last = this.lastUsageWrite.get(key) ?? 0;
      if (this.now() - last < this.coalesceMs) {
        this.installFlushHook();
        return false;
      }
    }
    this.lastUsageWrite.set(key, this.now());
    return this.persist("usage", ref.label, !opts.selectionRelevant);
  }

  /**
   * Mark an account exhausted until `resetAt`. Always selection-relevant, so it
   * is persisted immediately and dropped loudly when it cannot be.
   */
  async markExhausted(
    ref: AccountRef,
    resetAt: number,
    opts: { estimated?: boolean; usage?: UsageSnapshot } = {}
  ): Promise<boolean> {
    const pending = this.pendingFor(ref);
    const estimated = opts.estimated === true;
    const previous = pending.exhausted;
    if (!previous || resetAt > previous.resetAt) {
      pending.exhausted = { resetAt, estimated };
    } else if (resetAt === previous.resetAt) {
      pending.exhausted = { resetAt, estimated: previous.estimated && estimated };
    }
    if (opts.usage) pending.usage = newerUsage(pending.usage, opts.usage);
    pending.lastSeenAt = Math.max(pending.lastSeenAt ?? 0, this.now());
    this.touched();
    return this.persist("exhaustedUntil", ref.label, false);
  }

  /** Install quota evidence before reporting/persistence can fail. No lock or I/O. */
  noteQuota(
    ref: AccountRef,
    requestId: string,
    observation: QuotaObservation,
    usage?: UsageSnapshot
  ): void {
    const pending = this.pendingFor(ref);
    pending.quota ??= new Map();
    const previous = pending.quota.get(requestId);
    if (!previous || (previous.estimated === true && observation.estimated !== true)) {
      pending.quota.set(requestId, observation);
    } else if (observation.estimated !== true && previous.estimated !== true) {
      pending.quota.set(requestId, {
        at: previous.at,
        resetAt: Math.max(previous.resetAt ?? 0, observation.resetAt ?? 0),
        estimated: false,
      });
    }
    if (usage) pending.usage = newerUsage(pending.usage, usage);
    pending.lastSeenAt = Math.max(pending.lastSeenAt ?? 0, observation.at);
    this.touched();
    this.installFlushHook();
  }

  async markQuota(
    ref: AccountRef,
    requestId: string,
    observation: QuotaObservation,
    usage?: UsageSnapshot
  ): Promise<boolean> {
    this.noteQuota(ref, requestId, observation, usage);
    try {
      return await this.persist("exhaustedUntil", ref.label, false);
    } catch {
      const reason = "quota observation could not be persisted; kept pending";
      this.drops.set(`exhaustedUntil:${ref.label}`, {
        field: "exhaustedUntil",
        account: ref.label,
        reason,
        at: observation.at,
      });
      log(`[accounts] state not persisted — exhaustedUntil for ${ref.label} (${reason})`);
      this.installFlushHook();
      return false;
    }
  }

  /** A failed reporter keeps staged evidence selectable and visible to account status. */
  noteOutcomeFailure(ref: AccountRef): void {
    this.drops.set(`outcome:${ref.label}`, {
      field: "outcome",
      account: ref.label,
      reason: "outcome reporting failed; observation kept pending",
      at: this.now(),
    });
    this.installFlushHook();
  }

  /** A successful usage observation resets estimation only after its known reset. */
  noteSuccessfulUsage(ref: AccountRef, observedAt: number): void {
    const pending = this.pendingFor(ref);
    pending.successfulUsageAt = Math.max(pending.successfulUsageAt ?? 0, observedAt);
    this.touched();
  }

  /**
   * Clear an exhaustion mark (its window reset, or a login re-armed it).
   *
   * Clears only what this process has SEEN: a mark with a later reset, written
   * by another process after this decision, is newer evidence and survives —
   * including when this clear is carried by a later write.
   */
  async clearExhausted(ref: AccountRef): Promise<boolean> {
    const seen = this.stateFor(ref).state.exhaustedUntil ?? this.now();
    const pending = this.pendingFor(ref);
    pending.clearExhaustedUpTo = Math.max(pending.clearExhaustedUpTo ?? seen, seen);
    pending.exhausted = undefined;
    this.touched();
    return this.persist("exhaustedUntil", ref.label, false);
  }

  /**
   * Write `needsReauth`.
   *
   * **Callers must hold that account's refresh gate.** The flag is a sticky
   * statement about material the holder just proved dead; a non-holder writing
   * it can pin off an account the new owner is mid-way through rotating
   * successfully. `token-manager.ts` checks the fence before calling this.
   */
  async setNeedsReauth(ref: AccountRef, record: NeedsReauthRecord): Promise<boolean> {
    this.pendingFor(ref).needsReauth = { op: "set", record };
    this.touched();
    return this.persist("needsReauth", ref.label, false);
  }

  /**
   * Clear `needsReauth` — the material moved, or the user logged in again.
   *
   * `belowGeneration` is the generation that healed the account: only a failure
   * recorded against an OLDER generation is cleared. `failedAgainst` is the
   * baseline of the mark the caller judged stale (`token-manager.ts`'s
   * self-heal): only a mark about that same material is cleared. With neither
   * (a login) the flag is cleared unconditionally.
   *
   * Unlike {@link setNeedsReauth}, this needs no gate: each bound removes only
   * evidence the caller has seen superseded, so it cannot erase a newer failure.
   */
  async clearNeedsReauth(
    ref: AccountRef,
    opts: { belowGeneration?: number; failedAgainst?: ReauthMaterial } = {}
  ): Promise<boolean> {
    this.pendingFor(ref).needsReauth = {
      op: "clear",
      ...(opts.belowGeneration === undefined ? {} : { belowGeneration: opts.belowGeneration }),
      ...(opts.failedAgainst === undefined
        ? {}
        : {
            failedAgainst: {
              failedFingerprint: opts.failedAgainst.failedFingerprint,
              failedGeneration: opts.failedAgainst.failedGeneration,
            },
          }),
    };
    this.touched();
    return this.persist("needsReauth", ref.label, false);
  }

  /** Set the named refresher. Compare-and-set on the previous value. */
  async setOwner(ref: AccountRef, owner: Owner, expected?: Owner): Promise<boolean> {
    this.staleOwnerConflicts.delete(accountKey(ref));
    this.pendingFor(ref).owner = { value: owner, ...(expected === undefined ? {} : { expected }) };
    this.touched();
    return this.persist("owner", ref.label, false, accountKey(ref));
  }

  /**
   * Set the sticky account, compare-and-set on `expectedPrevious`.
   *
   * On a mismatch the change is REAPPLIED against the value read under the lock
   * — and the reapply VALIDATES that the target still exists in the account list. If
   * another process removed it, `active` is cleared instead of being pointed at
   * a deleted account, and the policy's default selection takes over.
   */
  async setActive(
    provider: AccountProvider,
    accountId: string,
    expectedPrevious?: string
  ): Promise<boolean> {
    this.pendingActive.set(provider, {
      accountId,
      ...(expectedPrevious === undefined ? {} : { expectedPrevious }),
    });
    this.touched();
    return this.persist("active", accountId, false);
  }

  /**
   * Write everything still pending now. Called on `beforeExit` and by
   * `account status --refresh`. A failure leaves it pending, as any write does.
   */
  async flush(): Promise<void> {
    if (!this.hasPending()) return;
    await this.persist("pending state", "this process", true);
  }

  private installFlushHook(): void {
    if (this.flushHookInstalled) return;
    this.flushHookInstalled = true;
    process.on("beforeExit", () => {
      // One attempt per distinct pending state. A flush that fails leaves the
      // marks pending; re-attempting on every `beforeExit` would keep the event
      // loop alive forever against a lock or file that is not coming back.
      if (!this.hasPending() || this.exitFlushVersion === this.pendingVersion) return;
      this.exitFlushVersion = this.pendingVersion;
      void this.flush();
    });
  }
}

type WriteOutcome =
  | { kind: "written" }
  | { kind: "unreadable"; error: string }
  | { kind: "corrupt-unmovable"; error: string }
  | { kind: "fenced" }
  | { kind: "write-failed"; error: string }
  | { kind: "owner-conflict"; message: string };

// ---------------------------------------------------------------------------
// Process singleton + the test seam
// ---------------------------------------------------------------------------

let store: StateStore | null = null;
let loggedListUnavailable = false;

/**
 * The process account list, as the `active` validator.
 *
 * An UNREADABLE account list answers "present": the caller made its choice from
 * a successful read moments ago, and the cost of a wrong "present" (an `active`
 * pointer naming a removed account, which matches no candidate and is replaced
 * on the next lease) is smaller than a wrong "absent" (a valid sticky account
 * cleared, and its prompt cache with it).
 */
function processAccountListHas(provider: AccountProvider, accountId: string): boolean {
  try {
    return getAccountRegistry()
      .listAccounts(provider)
      .some((account) => account.id === accountId);
  } catch (err) {
    if (!loggedListUnavailable) {
      loggedListUnavailable = true;
      log(`[accounts] account list unreadable while validating active; keeping the choice: ${err}`);
    }
    return true;
  }
}

export function getStateStore(): StateStore {
  if (!store) store = new StateStore({ accountListHas: processAccountListHas });
  return store;
}

/** Replace (or with `null`, restore) the process state store. */
export function setStateStoreForTests(next: StateStore | null): void {
  store = next;
}
