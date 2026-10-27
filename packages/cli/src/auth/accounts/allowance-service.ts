/**
 * The allowance model's I/O shell (architecture §2.4), a process singleton.
 *
 * Step 1 of the build: `record` and `recordNoEligible` only APPEND to the usage
 * ledger. There is no model state, no forecast and no ranker yet, so nothing
 * here can change which account serves a request. The ledger is written under
 * every strategy (sticky included), because the forecast, alerts and
 * contributions that later steps build all read it.
 *
 * Both entry points are synchronous and never throw: they run on the response
 * path, inside the handler's finalization and inside `pool.acquire`'s throw
 * path, where an exception would replace the answer the request was about to
 * give.
 *
 * Step 11 adds the ranking seam (§2.3): `safeRanker`, the in-memory thread
 * map, and `allowanceHintOf` for the handler.
 *
 * Step 12 adds the model, every part of it OFF the request path (§2.4):
 *
 * - **Lazy load.** The first `requestSettled` (the handler's response-complete
 *   point) arms a LOAD_DEFER_MS timer that schedules an async load (rollups for
 *   [now − 42 d, now − 48 h], raw rows for the last 48 h, the registry's
 *   `accounts` event); `evaluateAlerts` loads on its own chain. `ranker` and
 *   `record` never load: a quota row is recorded mid-request, before a
 *   rotation sends the next account's request, and a ledger read there would
 *   run while that request is in flight. Until the load completes, `decide`
 *   declines (sticky). Afterwards a ledger tail refreshes the state at most
 *   every REFRESH_MIN_MS, on the same scheduled chain. Rows this process
 *   recorded wait in `pending` and are folded after the request settles,
 *   deduplicated by id.
 * - **Memo.** The forecast is cached under `forecastKey`; a miss is recomputed
 *   in slices of 100 paths, one per tick, and the plans use the last forecast
 *   meanwhile.
 * - **Plans.** One per thread key (LRU, as the thread map) and one POOL plan.
 *   After every response the threads that decided since, and the pool, are
 *   replanned when `choose` reports the plan stale (the strategy's
 *   `needsReplan`) or the forecast moved. A decision without a fresh plan is
 *   counted in `staleDecisions`, logged with each evaluation.
 * - **Alerts.** `evaluateAlerts` every EVAL_CADENCE on an unref'd timer while
 *   this process served a pooled request in the last 24 h, and after a
 *   response (debounced to one per EVAL_CADENCE). `alerts` itself reuses the
 *   gap evaluation while its `inputsKey` holds; the forecast moves hourly. The
 *   memory lives in `allowance-alerts.json`, read-modified-written under a
 *   200 ms try-lock, and a transition is announced only by the process whose
 *   write added its id. The notice goes through `logStderr`, which an
 *   interactive session routes to DiagOutput: it reaches HEADLESS runs only.
 * - **Label.** Each evaluation hands `{level, remainingPct, gap epochs}` to the
 *   token trackers attached for the provider (§3.3).
 */

import { readFileSync } from "node:fs";
import type { AllowanceLabel } from "../../handlers/shared/token-tracker.js";
import { log, logStderr } from "../../logger.js";
import {
  ALLOWANCE_REPORT_SCHEMA,
  type AllowanceReport,
  allowanceReportSchema,
} from "./allowance-report-schema.js";
import { type AlertPayload, type AlertsRun, alertsSliced, remedyText } from "./allowance/alerts.js";
import { accountViews, combinedNow, isRead } from "./allowance/capacity.js";
import { choose, planFor } from "./allowance/choose.js";
import { DEFAULT_ALLOWANCE_CONFIG, alertStrategy } from "./allowance/constants.js";
import { contributions } from "./allowance/contributions.js";
import { forecastKey } from "./allowance/digest.js";
import { forecastSliced } from "./allowance/forecast.js";
import { burnRates } from "./allowance/profile.js";
import { candidatesToChooseRequest, threadKeyOf } from "./allowance/request.js";
import { evidenceOf, ledgerDays } from "./allowance/state.js";
import { initialState, observeAll, observeAllInPlace } from "./allowance/state.js";
import { STRATEGIES } from "./allowance/strategies/strategy.js";
import { sparkline, trajectory } from "./allowance/trajectory.js";
import type {
  AccountView,
  Alert,
  AlertMemory,
  AllowanceConfig,
  AllowanceEvent,
  AllowanceState,
  Calendar,
  ChooseRequest,
  Forecast,
  Plan,
  PlanClass,
  ResponseOutcome,
  StrategyName,
  ThreadKey,
  TokenCounts,
  Transition,
} from "./allowance/types.js";
import { atomicWriteFileSync } from "./atomic-write.js";
import { FileLockUnavailableError, acquireFileLock } from "./file-lock.js";
import { type LedgerTail, createLedgerTail, readLedger } from "./ledger/ledger-reader.js";
import {
  type LedgerRow,
  buildNoEligibleRow,
  buildResponseRow,
  toEvent,
} from "./ledger/ledger-row.js";
import { appendUsageRow, setLedgerIdleProbe } from "./ledger/ledger-writer.js";
import { allowanceAlertsLockPath, allowanceAlertsPath, statePath } from "./paths.js";
import type { AllowanceRank, SelectOptions, SelectReason } from "./policy.js";
import { getAccountRegistry } from "./registry.js";
import { StateStore, getStateStore } from "./state-store.js";
import type {
  AccountProvider,
  AccountRef,
  AllowanceSelectionHint,
  UsageSnapshot,
} from "./types.js";

/** Thread map bounds (§2.2): LRU 512, entries idle for over 24 h dropped. */
const THREAD_MAP_MAX = 512;
const THREAD_IDLE_MS = 24 * 60 * 60 * 1000;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** The load's split (§2.4): rollups up to 48 h ago, raw rows after. */
const LOAD_HISTORY_MS = 42 * DAY_MS;
const LOAD_RAW_MS = 48 * HOUR_MS;
/**
 * The first load waits this long after a request settles. A non-streamed answer
 * settles just before the handler returns it; the timer's first tick follows
 * that return.
 */
const LOAD_DEFER_MS = 1_000;
/** The ledger tail refreshes the state at most this often (§2.4). */
const REFRESH_MIN_MS = 60_000;
/** The alert timer runs while a pooled request was served within this (§2.4). */
const SERVED_RECENTLY_MS = DAY_MS;
/** The `allowance-alerts.json` try-lock: a short wait, off the request path. */
const ALERTS_LOCK_WAIT_MS = 200;
const ALERTS_LOCK_STALE_MS = 10_000;
/** Compare-and-set retries of one alert step before it gives up until the next. */
const ALERTS_CAS_ATTEMPTS = 3;
/**
 * An in-flight request older than this is treated as settled: a lost settle
 * callback must not stop every later ledger read.
 */
const IN_FLIGHT_MAX_MS = 30 * 60_000;
/**
 * Rows buffered for the next fold, per provider. Past it the oldest is dropped:
 * every buffered row is also in the ledger, so a later load still sees it.
 */
const PENDING_MAX = 4096;
/** A failed load is retried after this, doubling per failure up to LOAD_RETRY_MAX_MS. */
const LOAD_RETRY_MIN_MS = 60_000;
const LOAD_RETRY_MAX_MS = HOUR_MS;
/** Announced transition ids kept per provider in the alert memory file. */
const ANNOUNCED_MAX = 256;
/** The calendar is sampled over [now − 42 d, now + 9 d] and rebuilt daily. */
const CALENDAR_FUTURE_MS = 9 * DAY_MS;

/** What the service remembers about one thread. Never persisted. */
interface ThreadEntry {
  account: string;
  lastSwitchAt: number | null;
  lastAt: number;
}

/** A ranking that never chooses: the policy reverts to sticky with `rank declined`. */
const DECLINE: AllowanceRank = () => null;

/** Something that shows the label: a session's `TokenTracker`. */
export interface AllowanceLabelSink {
  setAllowanceLabel(label: AllowanceLabel | undefined): void;
}

/** One provider's model, as this process holds it. */
interface ProviderModel {
  cfg: AllowanceConfig;
  state: AllowanceState | null;
  loading: boolean;
  /** The deferred first load, armed by `requestSettled`. */
  loadTimer: ReturnType<typeof setTimeout> | null;
  tail: LedgerTail | null;
  lastTailAt: number;
  /** Own rows and tail rows waiting for the next fold; at most PENDING_MAX. */
  pending: AllowanceEvent[];
  /** Consecutive failed loads, and the earliest time the next may run. */
  loadFailures: number;
  nextLoadAt: number;
  cal: Calendar;
  calBuiltAt: number;
  fc: Forecast | null;
  /** Keyed like the thread map; `""` is the POOL plan (root = `poolActive`). */
  plans: Map<string, Plan | null>;
  /** The last request each thread (and the pool) decided on: what a replan plans for. */
  requests: Map<string, ChooseRequest>;
  /** Threads that decided since the last replan. */
  dirty: Set<string>;
  staleDecisions: number;
  loggedStale: number;
  lastServedAt: number;
  lastEvalAt: number;
  timer: ReturnType<typeof setInterval> | null;
  /** Serializes every scheduled task of this provider. */
  chain: Promise<void>;
  scheduled: boolean;
  sinks: Set<AllowanceLabelSink>;
  label: AllowanceLabel | undefined;
  /** The last evaluation's Monte Carlo quantiles and remedy scans, reused while their key holds. */
  payload: AlertPayload | null;
  /** The last evaluation's active alerts and blocked state, for `report()`. */
  lastAlerts: { active: Alert[]; blockedNow: boolean; status: "ok" | "insufficient-evidence" };
}

/** `allowance-alerts.json`: the shared memory and the ids already announced. */
interface AlertsFile {
  version: 1;
  providers: Record<string, { memory: AlertMemory; announced: string[] }>;
}

/** The pure core's cost table: Codex is priced as itself, everything else as Anthropic. */
function costProviderOf(provider: AccountProvider): AllowanceConfig["provider"] {
  return provider === "openai-codex" ? "openai-codex" : "anthropic";
}

function vendorLabel(provider: AccountProvider): string {
  return provider === "openai-codex" ? "Codex" : "Claude";
}

/**
 * The process's local calendar: offsets sampled hourly over the window the
 * model reads, kept only where they change (DST transitions).
 */
export function localCalendar(now: number): Calendar {
  const offsets: Calendar["offsets"] = [];
  const from = Math.floor((now - LOAD_HISTORY_MS) / HOUR_MS) * HOUR_MS;
  for (let t = from; t <= now + CALENDAR_FUTURE_MS; t += HOUR_MS) {
    const offsetMinutes = -new Date(t).getTimezoneOffset();
    if (offsets.length === 0 || offsets[offsets.length - 1]?.offsetMinutes !== offsetMinutes) {
      offsets.push({ from: offsets.length === 0 ? 0 : t, offsetMinutes });
    }
  }
  return { offsets };
}

/** `Thu 14:00`, local time, 24 h. */
export function formatLocalTime(at: number): string {
  const d = new Date(at);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${day} ${hh}:${mm}`;
}

function eventTime(e: AllowanceEvent): number {
  return e.kind === "rollup" ? e.hour : e.at;
}

/** The gap an alert announces: the Monte Carlo p50 when there is one, else the deterministic run. */
function gapSpan(alert: Alert): { start: number; end: number } {
  return {
    start: alert.gap.start?.p50 ?? alert.gap.atLongRate.start,
    end: alert.gap.end?.p50 ?? alert.gap.atLongRate.end,
  };
}

/**
 * The one stderr line of §3.2 for a won transition, or null for one that is
 * never announced (`deescalated`).
 */
export function allowanceNotice(
  provider: AccountProvider,
  transition: Transition,
  alert: Alert | undefined,
  accounts: number,
  formatTime: (at: number) => string = formatLocalTime
): string | null {
  const vendor = vendorLabel(provider);
  if (transition.to === "cleared") return `${vendor} allowance: the projected gap has cleared.`;
  if (transition.to === "deescalated" || !alert) return null;
  const { start, end } = gapSpan(alert);
  const who =
    accounts <= 1
      ? "the account is"
      : accounts === 2
        ? "both accounts are"
        : `all ${accounts} accounts are`;
  const hours = Math.round((end - start) / HOUR_MS);
  const remedy = remedyText(alert.remedy, start, formatTime);
  const advice = remedy ? ` ${remedy.charAt(0).toUpperCase()}${remedy.slice(1)}.` : "";
  return `${vendor} allowance: at the current rate ${who} spent ${formatTime(start)} and blocked until ${formatTime(end)} (${hours} h).${advice} \`claudish account forecast\``;
}

function emptyAlertsFile(): AlertsFile {
  return { version: 1, providers: {} };
}

/** The shared memory, or an empty one when absent or unreadable: a fresh chain, never a throw. */
function readAlertsFile(env: NodeJS.ProcessEnv): AlertsFile {
  try {
    const parsed = JSON.parse(readFileSync(allowanceAlertsPath(env), "utf8")) as AlertsFile;
    if (parsed?.version !== 1 || typeof parsed.providers !== "object" || !parsed.providers) {
      return emptyAlertsFile();
    }
    return parsed;
  } catch {
    return emptyAlertsFile();
  }
}

/** One account attempt of one inbound request, as the handler hands it over (§2.2). */
export interface UsageAttemptRecord {
  requestId: string;
  /** 0-based position in the request's attempt list. */
  attempt: number;
  at: number;
  account: AccountRef;
  planClass: PlanClass | null;
  session: string | null | undefined;
  model: string;
  reason: SelectReason | undefined;
  outcome: ResponseOutcome;
  /** null for an attempt that billed nothing this handler saw (quota, early error). */
  tokens: TokenCounts | null;
  finalInput: number | null;
  usage?: UsageSnapshot;
}

export class AllowanceService {
  private warned = false;
  private rankWarned = false;
  private pendingWarned = false;
  private readonly taskWarned = new Set<string>();
  /** Requests in flight in this process, by token → start time (§2.4: ledger reads wait for none). */
  private readonly inFlight = new Map<number, number>();
  private nextFlight = 0;
  /** Keyed `provider + "\0" + threadKey`; insertion order is recency. */
  private readonly threads = new Map<string, ThreadEntry>();
  private readonly models = new Map<AccountProvider, ProviderModel>();
  /** `state.json` at `statePath(this.env)`, read by `report()` only; built on first use. */
  private reportStateStore: StateStore | null = null;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly clock: () => number = Date.now
  ) {}

  /** Append one attempt's row. Synchronous, never throws, never awaits. */
  record(attempt: UsageAttemptRecord): void {
    try {
      const row = buildResponseRow({
        provider: attempt.account.provider,
        requestId: attempt.requestId,
        attempt: attempt.attempt,
        at: attempt.at,
        accountId: attempt.account.id,
        label: attempt.account.label,
        planClass: attempt.planClass,
        session: attempt.session,
        model: attempt.model,
        reason: attempt.reason,
        outcome: attempt.outcome,
        tokens: attempt.tokens,
        finalInput: attempt.finalInput,
        usage: attempt.usage,
      });
      if (!row) {
        this.warnOnce("a usage row failed its guards and was not written");
        return;
      }
      appendUsageRow(row, this.env);
      this.afterResponse(row);
    } catch {
      this.warnOnce("a usage row could not be recorded");
    }
  }

  /**
   * The inbound request finished: its stream body ended, or its answer is being
   * returned. The ONLY point that schedules the first load (deferred by
   * LOAD_DEFER_MS) and the fold of the rows its attempts buffered. Synchronous,
   * never throws.
   */
  requestSettled(provider: AccountProvider): void {
    try {
      const m = this.modelFor(provider);
      if (m.state) {
        this.scheduleFold(provider, m);
        return;
      }
      if (m.loadTimer || m.loading || !this.idle() || this.clock() < m.nextLoadAt) return;
      m.loadTimer = setTimeout(() => {
        m.loadTimer = null;
        // Another request began meanwhile: its own settle re-arms the load.
        if (!this.idle()) return;
        this.enqueue(m, () => this.load(provider, m), "load");
        this.scheduleFold(provider, m);
      }, LOAD_DEFER_MS);
      m.loadTimer.unref?.();
    } catch {
      this.warnOnce("a settled request could not be scheduled");
    }
  }

  /**
   * An inbound request began (any provider). Returns its idempotent release,
   * which the handler calls when the request settles, BEFORE `requestSettled`.
   * While any request is in flight no ledger is read (§2.4). Never throws.
   */
  requestStarted(): () => void {
    try {
      const id = ++this.nextFlight;
      this.inFlight.set(id, this.clock());
      return () => {
        this.inFlight.delete(id);
      };
    } catch {
      return () => {};
    }
  }

  /** True when no request of this process is in flight (one older than IN_FLIGHT_MAX_MS is dropped). */
  idle(): boolean {
    const now = this.clock();
    for (const [id, at] of this.inFlight) {
      if (now - at > IN_FLIGHT_MAX_MS) this.inFlight.delete(id);
      else return false;
    }
    return true;
  }

  /** A pool-wide block (`AllAccountsExhaustedError` from `acquire`): opens a censored interval. */
  recordNoEligible(provider: AccountProvider, now: number = Date.now()): void {
    try {
      const row = buildNoEligibleRow(provider, now);
      appendUsageRow(row, this.env);
      this.buffer(this.modelFor(provider), toEvent(row));
    } catch {
      this.warnOnce("a no-eligible row could not be recorded");
    }
  }

  /**
   * The rank closure for one evaluation (§2.3). It maps the eligible candidates
   * through the shared `candidatesToChooseRequest`, fills the thread's account
   * and last switch from the thread map, and asks `decide`. Any throw inside it
   * is caught and declines.
   */
  ranker(
    provider: AccountProvider,
    hint: AllowanceSelectionHint | null,
    options: SelectOptions
  ): AllowanceRank {
    try {
      this.modelFor(provider);
    } catch (err) {
      this.warnRankOnce(err);
    }
    return (eligible) => {
      try {
        const now = options.now;
        const thread = hint?.threadKey ? this.thread(provider, hint.threadKey, now) : undefined;
        const request = candidatesToChooseRequest(eligible, options, {
          session: hint?.sessionKey ?? null,
          thread: hint?.threadKey ?? null,
          threadAccount: thread?.account ?? null,
          lastSwitchAt: thread?.lastSwitchAt ?? null,
          contextTokens: hint?.contextTokens ?? null,
        });
        return this.decide(provider, request);
      } catch (err) {
        this.warnRankOnce(err);
        return null;
      }
    };
  }

  /**
   * One decision over a mapped request: `choose` with the thread's (or the
   * pool's) last plan. Null declines (sticky serves): before the load
   * completes, or when the strategy declines. Never computes a plan or a
   * forecast; a missing or stale plan is counted and replanned after the
   * response.
   */
  decide(
    provider: AccountProvider,
    request: ChooseRequest
  ): { id: string; reason: SelectReason } | null {
    const m = this.modelFor(provider);
    if (!m.state) return null;
    // The pool read the strategy for THIS request; the model follows that read,
    // never a copy up to REFRESH_MIN_MS old.
    const strategy = this.configFor(provider).strategy;
    if (strategy !== m.cfg.strategy) {
      m.cfg = { ...m.cfg, strategy };
      m.plans.clear();
    }
    if (strategy === "sticky") return null;
    const key = request.thread ?? "";
    remember(m.requests, key, request);
    if (request.thread) {
      remember(m.requests, "", {
        ...request,
        thread: null,
        threadAccount: null,
        lastSwitchAt: null,
      });
    }
    // A new thread starts from the POOL plan; `choose`'s staleness check rejects an unsuitable one.
    const plan = m.plans.get(key) ?? m.plans.get("") ?? null;
    const result = choose(m.state, request, plan, m.cal, m.cfg);
    if (STRATEGIES[m.cfg.strategy].plan && (plan === null || result.plan?.stale)) {
      m.staleDecisions++;
    }
    m.dirty.add(key);
    if (result.account === null) return null;
    // `lookahead` without a fresh plan answers with the MODEL's sticky pick (ledger views,
    // SELECTION_THRESHOLD); declining lets the pool's own sticky path decide with the
    // user's `switchAt` over the live `state.json` view (§1.8 step 3).
    if (strategy === "lookahead" && !result.usedPlan) return null;
    return { id: result.account, reason: result.reason };
  }

  /**
   * Attach a label sink for `provider` (a session's token tracker); it gets the
   * current label at once and every later one. Never throws.
   */
  attachLabelSink(provider: AccountProvider, sink: AllowanceLabelSink): void {
    try {
      const m = this.modelFor(provider);
      if (m.sinks.has(sink)) return;
      m.sinks.add(sink);
      if (m.label) sink.setAllowanceLabel(m.label);
    } catch {
      /* the label is advisory */
    }
  }

  /**
   * Detach `sink` from every provider: its handler shut down. A sink left
   * attached keeps its tracker alive and is written on every evaluation for the
   * life of the process. Never throws.
   */
  detachLabelSink(sink: AllowanceLabelSink): void {
    for (const m of this.models.values()) m.sinks.delete(sink);
  }

  /** The latest label for `provider`, for diagnostics and tests. */
  labelFor(provider: AccountProvider): AllowanceLabel | undefined {
    return this.models.get(provider)?.label;
  }

  /** Decisions taken without a fresh plan since this process started (§2.4 `staleDecisions`). */
  staleDecisions(provider: AccountProvider): number {
    return this.models.get(provider)?.staleDecisions ?? 0;
  }

  /** Resolves once every task scheduled so far for `provider` has run. Test and CLI seam. */
  async settled(provider: AccountProvider): Promise<void> {
    const m = this.models.get(provider);
    if (!m) return;
    for (let last: Promise<void> | undefined; last !== m.chain; ) {
      last = m.chain;
      await last;
    }
  }

  /**
   * The 5-minute step of §1.9, off the request path: load if needed, refresh,
   * then `alerts` against the SHARED memory under the try-lock. Returns the
   * transitions this process won (and announced). Never throws.
   */
  evaluateAlerts(provider: AccountProvider): Promise<Transition[]> {
    return this.evaluate(provider, true);
  }

  /** `announce: false` is the report's read-only evaluation: no lock, no write, no win. */
  private evaluate(provider: AccountProvider, announce: boolean): Promise<Transition[]> {
    const m = this.modelFor(provider);
    let won: Transition[] = [];
    this.enqueue(
      m,
      async () => {
        await this.load(provider, m);
        await this.refresh(provider, m);
        won = await this.alertStep(provider, m, announce);
      },
      "alert"
    );
    return m.chain.then(() => won);
  }

  /**
   * The `AllowanceReport` (§3.1), the single builder for `account forecast`,
   * its `--json` and the MCP tool: load, refresh, one alert evaluation (which
   * also refreshes the forecast), then the trajectory over `horizonMs` and the
   * contributions of each account's binding window. Validated against
   * `claudish.allowance.v1` before it is returned.
   */
  async report(provider: AccountProvider, horizonMs: number): Promise<AllowanceReport> {
    // Read-only: evaluates against the shared memory but never takes the lock,
    // writes it or announces. A poller (the magus mod) must not win the
    // transitions a headless run is there to print.
    await this.evaluate(provider, false);
    const m = this.modelFor(provider);
    const now = this.clock();
    const s = m.state ?? initialState();
    const labels = new Map<string, string>();
    try {
      for (const r of getAccountRegistry().listAccounts(provider))
        labels.set(r.id, r.label ?? r.id);
    } catch {
      /* labels are cosmetic */
    }
    return buildReport({
      s,
      now,
      horizonMs,
      cfg: m.cfg,
      cal: m.cal,
      fc: m.fc,
      alerts: m.lastAlerts,
      labels,
      poolActive: this.activeNow(provider, s),
    });
  }

  /**
   * The pool's active account as `state.json` says it NOW: the model's
   * `poolActive` is refreshed at most every REFRESH_MIN_MS, and the report's
   * `accounts[].active` must match `account list`. Read from `statePath(this.env)`,
   * not the process singleton, so a service built for another accounts dir reads
   * its own file. An unreadable or corrupt file falls back to the model's value.
   */
  private activeNow(provider: AccountProvider, s: AllowanceState): string | null {
    try {
      this.reportStateStore ??= new StateStore({ path: statePath(this.env) });
      const read = this.reportStateStore.read();
      if (read.kind === "failed") return s.poolActive ?? null;
      return read.state.providers[provider]?.active ?? null;
    } catch {
      return s.poolActive ?? null;
    }
  }

  // -------------------------------------------------------------------------
  // The model, off the request path

  private modelFor(provider: AccountProvider): ProviderModel {
    let m = this.models.get(provider);
    if (!m) {
      const now = this.clock();
      m = {
        cfg: this.configFor(provider),
        state: null,
        loading: false,
        loadTimer: null,
        tail: null,
        lastTailAt: 0,
        pending: [],
        loadFailures: 0,
        nextLoadAt: 0,
        cal: localCalendar(now),
        calBuiltAt: now,
        fc: null,
        plans: new Map(),
        requests: new Map(),
        dirty: new Set(),
        staleDecisions: 0,
        loggedStale: 0,
        lastServedAt: 0,
        lastEvalAt: 0,
        timer: null,
        chain: Promise.resolve(),
        scheduled: false,
        sinks: new Set(),
        label: undefined,
        payload: null,
        lastAlerts: { active: [], blockedNow: false, status: "insufficient-evidence" },
      };
      this.models.set(provider, m);
    }
    return m;
  }

  private configFor(provider: AccountProvider): AllowanceConfig {
    let strategy: StrategyName = "sticky";
    try {
      strategy = getAccountRegistry().settingsFor(provider).strategy;
    } catch {
      /* an unreadable account list reads as sticky */
    }
    return { ...DEFAULT_ALLOWANCE_CONFIG, strategy, provider: costProviderOf(provider) };
  }

  /** Run `task` on its own tick, after every task already scheduled for this provider. */
  private enqueue(
    m: ProviderModel,
    task: () => Promise<void> | void,
    kind: "load" | "fold" | "alert" = "fold"
  ): void {
    m.chain = m.chain
      .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
      .then(task)
      .catch((err) => this.warnTaskOnce(kind, err));
  }

  /** After a recorded response: buffer it until the request settles. */
  private afterResponse(row: LedgerRow): void {
    const provider = row.provider;
    const m = this.modelFor(provider);
    this.buffer(m, toEvent(row));
    if (row.kind === "response" && row.outcome === "ok") {
      m.lastServedAt = this.clock();
      this.ensureTimer(provider, m);
    }
  }

  /**
   * Buffer one row for the next fold. Before the first load nothing drains the
   * buffer, so a model that never loads drops its oldest row, with one warning.
   */
  private buffer(m: ProviderModel, e: AllowanceEvent): void {
    m.pending.push(e);
    if (m.pending.length <= PENDING_MAX) return;
    m.pending.splice(0, m.pending.length - PENDING_MAX);
    this.warnPendingOnce();
  }

  /** Fold the buffered rows, replan what is stale, step the alerts when due. */
  private scheduleFold(provider: AccountProvider, m: ProviderModel): void {
    if (m.scheduled) return;
    m.scheduled = true;
    this.enqueue(m, () => this.refresh(provider, m));
    this.enqueue(m, () => this.refreshForecast(m));
    this.enqueue(m, () => this.replan(m));
    this.enqueue(
      m,
      async () => {
        m.scheduled = false;
        if (this.clock() - m.lastEvalAt >= m.cfg.EVAL_CADENCE_MS) {
          await this.alertStep(provider, m, true);
        }
      },
      "alert"
    );
  }

  private ensureTimer(provider: AccountProvider, m: ProviderModel): void {
    if (m.timer) return;
    m.timer = setInterval(() => {
      if (this.clock() - m.lastServedAt > SERVED_RECENTLY_MS) {
        if (m.timer) clearInterval(m.timer);
        m.timer = null;
        return;
      }
      // A step due while a request is in flight waits for the next tick (§2.4).
      if (this.idle()) void this.evaluateAlerts(provider);
    }, m.cfg.EVAL_CADENCE_MS);
    m.timer.unref?.();
  }

  /**
   * The lazy load (§2.4). Idempotent; a failure leaves the state unloaded, is
   * logged once, and holds the next attempt off for LOAD_RETRY_MIN_MS, doubling
   * per consecutive failure up to LOAD_RETRY_MAX_MS.
   */
  private async load(provider: AccountProvider, m: ProviderModel): Promise<void> {
    if (m.state || m.loading || !this.idle() || this.clock() < m.nextLoadAt) return;
    m.loading = true;
    try {
      const now = this.clock();
      // The tail is primed BEFORE the reads: a row another process appends in
      // between is in both, and the fold's id dedup drops the second copy. Primed
      // after, it would be in neither.
      const tail = createLedgerTail({ startAtEnd: true, now, env: this.env });
      await tail.tail();
      // The rollup/raw handoff on a whole hour: an hourly rollup covers its
      // whole hour, so a cutoff inside one would count its later half twice.
      const handoff = Math.floor((now - LOAD_RAW_MS) / HOUR_MS) * HOUR_MS;
      const [older, recent] = await Promise.all([
        readLedger({ sinceMs: now - LOAD_HISTORY_MS, untilMs: handoff, env: this.env }),
        readLedger({ sinceMs: handoff, source: "raw", env: this.env }),
      ]);
      const events = this.eventsOf(provider, [...older.rows, ...recent.rows]);
      events.push(this.accountsEvent(provider, now, [...older.rows, ...recent.rows]));
      m.cfg = this.configFor(provider);
      m.state = observeAll(initialState(), events, m.cfg);
      m.tail = tail;
      m.lastTailAt = now;
      m.loadFailures = 0;
      m.nextLoadAt = 0;
      log(
        `[allowance] ${provider}: model loaded from ${events.length} event(s) in ${this.clock() - now} ms`
      );
    } catch (err) {
      m.nextLoadAt =
        this.clock() + Math.min(LOAD_RETRY_MAX_MS, LOAD_RETRY_MIN_MS * 2 ** m.loadFailures);
      m.loadFailures++;
      this.warnOnce(
        `the model could not be loaded: ${String((err as Error)?.message ?? err).slice(0, 120)}`
      );
    } finally {
      m.loading = false;
    }
  }

  /** This provider's rows as events, oldest first. */
  private eventsOf(provider: AccountProvider, rows: LedgerRow[]): AllowanceEvent[] {
    return rows
      .filter((r) => r.provider === provider)
      .map(toEvent)
      .sort((a, b) => eventTime(a) - eventTime(b));
  }

  /** The registry's account list as the model's `accounts` event; plan classes from the rows. */
  private accountsEvent(provider: AccountProvider, now: number, rows: LedgerRow[]): AllowanceEvent {
    const planClass = new Map<string, PlanClass | null>();
    for (const r of rows) {
      if (r.kind === "response" && r.provider === provider && r.planClass) {
        planClass.set(r.accountId, r.planClass);
      }
    }
    const records = getAccountRegistry().listAccounts(provider);
    let active: string | null | undefined;
    try {
      active = getStateStore().activeId(provider) ?? null;
    } catch {
      active = undefined; // unreadable: keep the last one
    }
    return {
      kind: "accounts",
      at: now,
      ...(active !== undefined ? { active } : {}),
      accounts: records.map((r, order) => ({
        id: r.id,
        order,
        enabled: r.enabled,
        planClass: planClass.get(r.id) ?? null,
      })),
    };
  }

  /** Fold pending own rows, and the ledger tail at most every REFRESH_MIN_MS. */
  private async refresh(provider: AccountProvider, m: ProviderModel): Promise<void> {
    if (!m.state) return;
    const now = this.clock();
    const events = m.pending.splice(0);
    if (m.tail && now - m.lastTailAt >= REFRESH_MIN_MS && this.idle()) {
      m.lastTailAt = now;
      const read = await m.tail.tail();
      events.push(...this.eventsOf(provider, read.rows));
      try {
        events.push(this.accountsEvent(provider, now, read.rows));
      } catch {
        /* an unreadable account list keeps the last one */
      }
      const cfg = this.configFor(provider);
      if (cfg.strategy !== m.cfg.strategy) {
        m.plans.clear();
        m.cfg = cfg;
      }
    }
    if (now - m.calBuiltAt >= DAY_MS) {
      m.cal = localCalendar(now);
      m.calBuiltAt = now;
    }
    if (events.length > 0) {
      events.sort((a, b) => eventTime(a) - eventTime(b));
      m.state = observeAllInPlace(m.state, events, m.cfg);
    }
  }

  /**
   * Recompute the memoized forecast when its key moved, in slices (one per
   * `setImmediate` tick): 1000 paths in one run held the event loop for the
   * whole forecast. The state is not folded meanwhile: every fold runs on the
   * same chain.
   */
  private async refreshForecast(m: ProviderModel): Promise<void> {
    if (!m.state) return;
    const now = this.clock();
    const horizon = m.cfg.SIM_MAX_STEPS * HOUR_MS;
    if (m.fc && m.fc.key === forecastKey(m.state, now, horizon, m.cal, m.cfg)) return;
    m.fc = await runSliced(forecastSliced(m.state, now, horizon, m.cal, m.cfg));
  }

  /**
   * Replan every thread that decided since the last replan, and the pool, when
   * stale: one key per `setImmediate` tick, so a team's N threads are N short
   * tasks and never one ~N × PLAN_LATENCY block.
   */
  private async replan(m: ProviderModel): Promise<void> {
    if (!m.state || !STRATEGIES[m.cfg.strategy].plan) {
      m.dirty.clear();
      return;
    }
    const keys = new Set([...m.dirty, ""]);
    m.dirty.clear();
    for (const key of keys) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (!m.state || !STRATEGIES[m.cfg.strategy].plan) return;
      const last = m.requests.get(key);
      if (!last) continue;
      const request = { ...last, now: this.clock() };
      const plan = m.plans.get(key) ?? null;
      const stale =
        plan === null ||
        (m.fc !== null && plan.forecastKey !== m.fc.key) ||
        choose(m.state, request, plan, m.cal, m.cfg).plan?.stale === true;
      if (!stale) continue;
      remember(m.plans, key, planFor(m.state, request, m.cal, m.cfg, m.fc ?? undefined));
    }
  }

  /**
   * `alerts` against the shared memory, under the try-lock. A transition is
   * announced only when this process's own write added its id; a lock not had
   * within ALERTS_LOCK_WAIT_MS skips the step (the next one runs in 5 min).
   *
   * The evaluation always runs OUTSIDE the lock, one simulation per tick
   * (orchestrator decision 3 after step 12), against the memory as last read.
   * Under the lock the memory is compared with that read: equal, the result is
   * written (after the lock fence); moved by another process, the lock is
   * released and the sliced evaluation redone against the new memory, at most
   * ALERTS_CAS_ATTEMPTS times. Nothing synchronous and long runs under the lock.
   *
   * `announce: false` (the report) evaluates against the shared memory and
   * stops there: no lock, no write, no announcement, no label.
   */
  private async alertStep(
    provider: AccountProvider,
    m: ProviderModel,
    announce: boolean
  ): Promise<Transition[]> {
    if (!m.state) return [];
    const now = this.clock();
    if (announce) m.lastEvalAt = now;
    await this.refreshForecast(m);
    if (!m.state) return [];
    const state = m.state;
    const fc = m.fc ?? undefined;
    let peek = readAlertsFile(this.env).providers[provider]?.memory ?? null;
    let won: Transition[] = [];
    let landed: AlertsRun | null = null;
    for (let attempt = 0; attempt < ALERTS_CAS_ATTEMPTS && landed === null; attempt++) {
      const result = await runSliced(
        alertsSliced(state, now, peek, m.cal, m.cfg, fc, { reuse: m.payload })
      );
      if (result.payload) m.payload = result.payload;
      if (!announce) {
        m.lastAlerts = {
          active: result.active,
          blockedNow: result.blockedNow,
          status: result.status,
        };
        return [];
      }
      let handle: Awaited<ReturnType<typeof acquireFileLock>>;
      try {
        handle = await acquireFileLock(allowanceAlertsLockPath(this.env), {
          timeoutMs: ALERTS_LOCK_WAIT_MS,
          pollMs: 25,
          staleMs: ALERTS_LOCK_STALE_MS,
          heartbeatMs: 0,
          log,
        });
      } catch (err) {
        if (err instanceof FileLockUnavailableError) return [];
        throw err;
      }
      try {
        const file = readAlertsFile(this.env);
        const prior = file.providers[provider] ?? null;
        const memory = prior?.memory ?? null;
        if (JSON.stringify(memory) !== JSON.stringify(peek)) {
          // Another process moved the memory: redo, sliced, outside the lock.
          peek = memory;
          continue;
        }
        const announced = new Set(prior?.announced ?? []);
        const wins = result.transitions.filter((t) => !announced.has(t.id));
        file.providers[provider] = {
          memory: result.memory,
          announced: [...(prior?.announced ?? []), ...wins.map((t) => t.id)].slice(-ANNOUNCED_MAX),
        };
        // A holder stolen from (suspended past ALERTS_LOCK_STALE_MS) must not write.
        if (!handle.holdsLock()) {
          this.warnOnce("the alert memory lock was lost; nothing was written");
          return [];
        }
        atomicWriteFileSync(allowanceAlertsPath(this.env), `${JSON.stringify(file)}\n`);
        won = wins;
        landed = result;
      } catch (err) {
        // No write, no win: nothing is announced from an evaluation that did not land.
        this.warnOnce(
          `the alert memory could not be updated: ${String((err as Error)?.message ?? err).slice(0, 120)}`
        );
        return [];
      } finally {
        handle.release();
      }
    }
    if (landed === null) {
      log(`[allowance] ${provider}: the alert memory kept moving; step skipped`);
      return [];
    }
    m.lastAlerts = { active: landed.active, blockedNow: landed.blockedNow, status: landed.status };
    const active = landed.active;
    const status = landed.status;

    const accounts = accountViews(m.state, now, m.cfg).length;
    for (const t of won) {
      const line = allowanceNotice(
        provider,
        t,
        active.find((a) => a.level === t.level),
        accounts
      );
      log(`[allowance] ${provider}: ${t.level} ${t.to} (${t.id})`);
      if (line && (t.to === "raised" || t.to === "escalated" || t.to === "cleared")) {
        logStderr(line);
      }
    }
    if (m.staleDecisions !== m.loggedStale) {
      m.loggedStale = m.staleDecisions;
      log(`[allowance] ${provider}: staleDecisions=${m.staleDecisions}`);
    }
    this.publishLabel(m, now, status, active);
    return won;
  }

  private publishLabel(
    m: ProviderModel,
    now: number,
    status: "ok" | "insufficient-evidence",
    active: Alert[]
  ): void {
    if (!m.state) return;
    let label: AllowanceLabel | undefined;
    if (status === "ok") {
      // The same figure as the report's `combined`, as a share of its capacity.
      const pool = poolRemaining(accountViews(m.state, now, m.cfg));
      const remainingPct =
        pool === null || pool.capacity <= 0
          ? null
          : Math.round((100 * Math.max(0, pool.remainingNow)) / pool.capacity);
      const top = active[0];
      const span = top ? gapSpan(top) : null;
      label = {
        level: top ? top.level : "ok",
        remainingPct,
        gapStartSec: span ? Math.round(span.start / 1000) : null,
        gapEndSec: span ? Math.round(span.end / 1000) : null,
        observedAt: now,
      };
    }
    m.label = label;
    for (const sink of m.sinks) {
      try {
        sink.setAllowanceLabel(label);
      } catch {
        /* the label is advisory */
      }
    }
  }

  /**
   * After a successful lease: the thread's account for its next request. A
   * change of account is a switch. Never throws.
   */
  noteSelection(
    provider: AccountProvider,
    threadKey: ThreadKey | null,
    account: string,
    now: number
  ): void {
    if (!threadKey) return;
    try {
      const key = `${provider}\u0000${threadKey}`;
      const prev = this.thread(provider, threadKey, now);
      const switched = prev !== undefined && prev.account !== account;
      this.threads.delete(key);
      this.threads.set(key, {
        account,
        lastSwitchAt: switched ? now : (prev?.lastSwitchAt ?? null),
        lastAt: now,
      });
      while (this.threads.size > THREAD_MAP_MAX) {
        const oldest = this.threads.keys().next().value;
        if (oldest === undefined) break;
        this.threads.delete(oldest);
      }
    } catch (err) {
      this.warnRankOnce(err);
    }
  }

  /** A thread's entry, or undefined once it has been idle past THREAD_IDLE_MS. */
  private thread(
    provider: AccountProvider,
    threadKey: ThreadKey,
    now: number
  ): ThreadEntry | undefined {
    const key = `${provider}\u0000${threadKey}`;
    const entry = this.threads.get(key);
    if (entry && now - entry.lastAt > THREAD_IDLE_MS) {
      this.threads.delete(key);
      return undefined;
    }
    return entry;
  }

  warnRankOnce(err: unknown): void {
    if (this.rankWarned) return;
    this.rankWarned = true;
    try {
      const why = String((err as Error)?.message ?? err).slice(0, 120);
      log(`[allowance] the ranker failed and declines to sticky: ${why}`);
    } catch {
      /* non-fatal */
    }
  }

  /** One line per kind of scheduled task: a load, fold or alert failure never uses up the ranker's warning. */
  private warnTaskOnce(kind: "load" | "fold" | "alert", err: unknown): void {
    if (this.taskWarned.has(kind)) return;
    this.taskWarned.add(kind);
    try {
      const why = String((err as Error)?.message ?? err).slice(0, 120);
      log(`[allowance] a scheduled ${kind} task failed: ${why}`);
    } catch {
      /* non-fatal */
    }
  }

  private warnPendingOnce(): void {
    if (this.pendingWarned) return;
    this.pendingWarned = true;
    try {
      log(`[allowance] the fold buffer is full (${PENDING_MAX} rows); the oldest are dropped`);
    } catch {
      /* non-fatal */
    }
  }

  private warnOnce(message: string): void {
    if (this.warned) return;
    this.warned = true;
    try {
      log(`[allowance] ${message}`);
    } catch {
      /* non-fatal */
    }
  }
}

/** Drive a sliced evaluation, one step per `setImmediate` tick. */
async function runSliced<T>(gen: Generator<void, T>): Promise<T> {
  for (;;) {
    const next = gen.next();
    if (next.done) return next.value;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

const iso = (at: number): string => new Date(at).toISOString();

/**
 * The ONE "remaining" of the report's `combined` and the status line's
 * `pool N%`: `combinedNow` (Σ_a min_w r/β in cu, or Σ_a min_w r in
 * account-fraction) over the full capacity in the same unit (Σ_a min_w 1/β, or
 * the read-account count). Null with no read account.
 */
export function poolRemaining(
  views: readonly AccountView[]
): { remainingNow: number; capacity: number; unit: "cu" | "account-fraction" } | null {
  const read = views.filter(isRead);
  if (read.length === 0) return null;
  const now = combinedNow(read);
  let capacity = 0;
  for (const v of read) {
    if (now.unit === "account-fraction") {
      capacity += 1;
      continue;
    }
    let least = Number.POSITIVE_INFINITY;
    for (const w of v.windows) least = Math.min(least, 1 / (v.beta[w.key]?.value ?? 1));
    if (Number.isFinite(least)) capacity += least;
  }
  return { remainingNow: now.value, capacity, unit: now.unit };
}

/** The inputs of one report: the model's state and the last evaluation. */
export interface ReportInput {
  s: AllowanceState;
  now: number;
  horizonMs: number;
  cfg: AllowanceConfig;
  cal: Calendar;
  fc: Forecast | null;
  alerts: { active: Alert[]; blockedNow: boolean; status: "ok" | "insufficient-evidence" };
  /** Account id → the registry's label. */
  labels: Map<string, string>;
  /**
   * `state.json` `active` read at report time; absent → the model's
   * `s.poolActive`. It sets `accounts[].active` and is where the trajectory's
   * paths start.
   */
  poolActive?: string | null;
}

/**
 * The `AllowanceReport` from the pure core's outputs (§3.1): ms → ISO, ids
 * cut to 8 characters, evidence `none` → a valid report with empty arrays.
 * Throws when the result does not validate: a builder that leaks a field the
 * schema refuses never ships it.
 */
export function buildReport(input: ReportInput): AllowanceReport {
  const { s, now, cfg, cal, fc } = input;
  const horizonMs = Math.min(168 * HOUR_MS, Math.max(HOUR_MS, input.horizonMs));
  const evidence = evidenceOf(s, now);
  const none = evidence === "none";
  const views = accountViews(s, now, cfg);
  const poolActive = input.poolActive !== undefined ? input.poolActive : (s.poolActive ?? null);
  // A shallow copy: the trajectory's paths start from the account the flag shows.
  const traj = trajectory({ ...s, poolActive }, now, horizonMs, cal, cfg);
  const unit = fc?.unit ?? traj.unit;
  const burn = none ? { long: 0, short: 0 } : burnRates(s, now, cal, cfg);
  // A rate whose evidence is shorter than its half-life is a few turns' mean, not a rate.
  const ledgerHours = ledgerDays(s, now) * 24;
  const label = (id: string) => input.labels.get(id) ?? id;
  const pool = poolRemaining(views);
  const top = input.alerts.active[0];
  const fmt = (at: number) => formatLocalTime(at);
  const report: AllowanceReport = {
    schema: ALLOWANCE_REPORT_SCHEMA,
    generatedAt: iso(now),
    forecastAt: fc && !none ? iso(fc.buckets[0]?.start ?? now) : null,
    provider: "openai-codex",
    strategy: cfg.strategy,
    alertModel: alertStrategy(cfg.strategy),
    evidence,
    unit,
    assumption: unit === "account-fraction" ? "equal-capacity" : null,
    horizonHours: Math.round(horizonMs / HOUR_MS),
    accounts: views.map((v) => {
      const g = v.governing === null ? undefined : v.beta[v.governing];
      const k = v.binding === null || v.binding === v.governing ? undefined : v.kappa[v.binding];
      return {
        label: label(v.account),
        id: v.account,
        planClass: s.accounts[v.account]?.planClass ?? null,
        deliverable: v.deliverable === null ? null : Math.min(1, Math.max(0, v.deliverable)),
        binding: v.binding,
        windows: v.windows
          .filter((w) => w.remaining !== null)
          .map((w) => ({
            key: w.key,
            displayId: w.slot,
            usedFraction: Math.min(1, Math.max(0, 1 - (w.remaining ?? 0))),
            resetAt: w.resetAt === null ? null : iso(w.resetAt),
            provenance: w.provenance,
            semantics: w.semantics,
          })),
        lambda: null,
        calibration: { beta: g?.quality ?? "prior", kappa: k?.quality ?? null },
        // `account list`'s predicate (pool.ts `isActive`); an active id outside `accounts[]` flags none.
        active: poolActive !== null && v.account === poolActive,
      };
    }),
    combined: {
      remainingNow: pool?.remainingNow ?? null,
      capacity: pool?.capacity ?? null,
    },
    burn: {
      long: ledgerHours < cfg.BURN_LONG_HL_H ? null : burn.long,
      short: ledgerHours < cfg.BURN_SHORT_HL_H ? null : burn.short,
      sustainable: top ? top.burn.sustainable : null,
      unit: "cu/h",
    },
    alerts: none
      ? []
      : input.alerts.active.map((a) => {
          const r = a.remedy;
          const start = a.gap.start?.p50 ?? a.gap.atLongRate.start;
          const q = <T>(
            x: { p10: number; p25: number; p50: number; p75: number; p90: number },
            f: (n: number) => T
          ) => ({
            p10: f(x.p10),
            p25: f(x.p25),
            p50: f(x.p50),
            p75: f(x.p75),
            p90: f(x.p90),
          });
          return {
            level: a.level,
            since: iso(a.raisedAt),
            gapStartEpoch: start,
            gapStart: a.gap.start ? q(a.gap.start, iso) : null,
            gapEnd: a.gap.end ? q(a.gap.end, iso) : null,
            gapHours: a.gap.lengthMs ? q(a.gap.lengthMs, (ms) => ms / HOUR_MS) : null,
            pGap: Math.min(1, Math.max(0, a.pGap)),
            binding: a.gap.atLongRate.binding.map((b) => ({
              account: label(b.account),
              window: b.window,
            })),
            remedy: {
              kind: r.kind,
              cutToPercent: r.kind === "cut" ? Math.round(r.cutToFraction * 100) : null,
              until: r.kind === "not-addressable" ? null : iso(r.until),
              pauseHours:
                r.kind === "not-addressable" || r.pauseMs === null ? null : r.pauseMs / HOUR_MS,
              reason: r.kind === "not-addressable" ? r.reason : null,
              text: remedyText(r, start, fmt),
            },
          };
        }),
    blockedNow: none ? false : input.alerts.blockedNow,
    status: none ? "insufficient-evidence" : input.alerts.status,
    trajectory: {
      history: traj.history.map((h) => ({
        at: iso(h.at),
        remaining: h.remaining,
        provenance: h.provenance,
      })),
      forecast: traj.forecast.map((f) => ({
        at: iso(f.at),
        p10: f.q.p10,
        p50: f.q.p50,
        p90: f.q.p90,
        pBlocked: f.pBlocked,
      })),
      resets: traj.resets.map((r) => ({
        at: iso(r.at),
        account: label(r.account),
        window: r.window,
        projected: r.projected,
      })),
      blocked: traj.blocked.map((b) => ({
        from: iso(b.from.p50),
        to: iso(b.to.p50),
        kind: b.kind,
        probability: b.probability,
      })),
      spark48: sparkline(
        {
          ...traj,
          history: traj.history.filter((h) => h.at >= now - 24 * HOUR_MS),
          forecast: traj.forecast.filter((f) => f.at <= now + 24 * HOUR_MS),
        },
        48
      ),
    },
    sessions: none
      ? []
      : contributions(s, { now, window: "binding" }, cfg).map((c) => ({
          session: c.session === "unattributed" ? "unattributed" : c.session.slice(0, 8),
          account: c.account === "all" ? "all" : label(c.account),
          window: c.window,
          share: Math.min(1, Math.max(0, c.share)),
          usedFraction: c.usedFraction === null ? null : Math.min(1, Math.max(0, c.usedFraction)),
          cu: Math.max(0, c.cu),
          tokens: {
            in: c.tokens.input,
            out: c.tokens.output,
            cacheRead: c.tokens.cacheRead,
            cacheWrite: c.tokens.cacheWrite,
          },
          models: c.models,
          exactness: c.exactness,
          firstAt: iso(c.firstAt),
          lastAt: iso(c.lastAt),
        })),
  };
  return allowanceReportSchema.parse(report);
}

/** Set `key` as the most recent entry of an LRU bounded like the thread map. */
function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > THREAD_MAP_MAX) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

let instance: AllowanceService | undefined;
let safeRankerWarned = false;

/**
 * The ranker `pool.evaluate` passes to `selectAccount` (§2.3). TOTAL: its whole
 * body (service access, lazy construction, the closure) sits in `try/catch`,
 * and on any error it returns a closure that declines, so the policy serves
 * sticky. Nothing here can reach `rethrowSelectionFailure` and become a
 * `RefreshUnavailableError`.
 */
export function safeRanker(
  provider: AccountProvider,
  hint: AllowanceSelectionHint | null,
  options: SelectOptions
): AllowanceRank | undefined {
  try {
    return getAllowanceService().ranker(provider, hint, options);
  } catch (err) {
    if (!safeRankerWarned) {
      safeRankerWarned = true;
      try {
        const why = String((err as Error)?.message ?? err).slice(0, 120);
        log(`[allowance] ${provider}: no ranker, selection stays sticky: ${why}`);
      } catch {
        /* non-fatal */
      }
    }
    return DECLINE;
  }
}

/**
 * The thread hint for one inbound request (§2.2), from the request the handler
 * is about to send. `contextTokens` is THIS request's input estimate: the
 * serialized system prompt and messages, UTF-8 bytes / 4 (the handler makes no
 * other request-size estimate). Null on any failure: the hint is advisory.
 */
export function allowanceHintOf(
  sessionId: string | null | undefined,
  request: { system?: unknown; messages?: unknown }
): AllowanceSelectionHint {
  const sessionKey = sessionId ?? null;
  let threadKey: string | null = null;
  let contextTokens: number | null = null;
  try {
    threadKey = threadKeyOf(sessionKey, request);
  } catch {
    threadKey = null;
  }
  try {
    const serialized = JSON.stringify([request.system ?? null, request.messages ?? []]);
    contextTokens = Math.ceil(Buffer.byteLength(serialized, "utf8") / 4);
  } catch {
    contextTokens = null;
  }
  return { sessionKey, threadKey, contextTokens };
}

export function getAllowanceService(): AllowanceService {
  if (!instance) {
    instance = new AllowanceService();
    // Compaction waits for no request in flight too (§2.4).
    setLedgerIdleProbe(() => instance?.idle() ?? true);
  }
  return instance;
}

/** Test seam: replace or drop the process singleton. */
export function _setAllowanceServiceForTests(service: AllowanceService | undefined): void {
  instance = service;
}
