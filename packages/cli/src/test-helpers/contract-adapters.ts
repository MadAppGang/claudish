// packages/cli/src/test-helpers/contract-adapters.ts
/**
 * INFERRED glue, in one place. The contract names these symbols but not their exact shapes:
 *
 *   - StreamJsonReducer: its constructor options beyond `onResult`, the method that ingests a
 *     stream-json line, the state getter, `settle`, and where refused transitions are recorded.
 *     Documented: `onResult: (summary) => TurnEnd` (required), `awaitInput()`, `beginTurn()`.
 *   - SessionManager: the class name and constructor (`SessionManagerOptions.hostPid` is
 *     documented), `recordTeamRun({ teamPath, slots, parentClaudeSessionId })` and
 *     `finishTeamRun(record, outcome)` (documented by name and argument).
 *   - team-orchestrator: `setupSession` (named, signature not given), `startModels(path, opts)`
 *     (named), and the slot state values (`modelStates`). Team slots are panes now; their
 *     suites drive the pane fake through `TeamRunOptions.parentEnv` (CLAUDISH_BIN), not a
 *     spawn seam.
 *
 * Every test asserts the SPEC; only these functions bend to the implementation. If a contract
 * test fails with "ADAPTER:", fix this file, not the test.
 */
import * as sessionManagerModule from "../channel/session-manager.js";
import * as reducerModule from "../channel/stream-json-reducer.js";
import type { TurnEnd } from "../channel/stream-json-reducer.js";
import type { SlotState } from "../pane/index.js";
import * as orchestrator from "../team-orchestrator.js";

type AnyRecord = Record<string, unknown>;
type Fn = (...args: unknown[]) => unknown;

export const KNOWN_STATES = [
  "starting",
  "running",
  "tool_executing",
  "waiting_for_input",
  "finishing",
  "completed",
  "failed",
  "timeout",
  "cancelled",
] as const;

function method(obj: unknown, names: string[], what: string): Fn {
  const o = obj as AnyRecord;
  for (const name of names) {
    if (typeof o?.[name] === "function") return (o[name] as Fn).bind(o);
  }
  throw new Error(
    `ADAPTER: ${what}: none of ${names.join(", ")} exists — fix test-helpers/contract-adapters.ts`
  );
}

// ------------------------------------------------------------------------------------------
// StreamJsonReducer
// ------------------------------------------------------------------------------------------

export interface ReducerProbe {
  reducer: AnyRecord;
  /** Ingest one stream-json frame (serialised as one newline-terminated line). */
  feed(frame: unknown): void;
  state(): string;
  /** The state after every step this probe drove (construction, feed, beginTurn, awaitInput, settle). */
  snapshots: string[];
  /** Every known state named in any argument of any state-change callback. */
  mentioned: Set<string>;
  stateChangeCalls(): number;
  /** The reducer's state at the moment each onResult call ran. */
  stateAtOnResult: string[];
  anomalyCount(): number;
  beginTurn(): void;
  awaitInput(): void;
  settle(state: string): void;
  dispose(): void;
}

/** Reducers built by makeReducerProbe; a test file disposes them in afterEach so no stall timer outlives its test. */
const liveReducers: AnyRecord[] = [];

export function disposeReducerProbes(): void {
  for (const r of liveReducers.splice(0)) {
    if (typeof r.dispose === "function") (r.dispose as Fn).call(r);
  }
}

function collectStates(value: unknown, into: Set<string>, depth = 0): void {
  if (typeof value === "string") {
    if ((KNOWN_STATES as readonly string[]).includes(value)) into.add(value);
    return;
  }
  if (value && typeof value === "object" && depth < 2) {
    for (const v of Object.values(value as AnyRecord)) collectStates(v, into, depth + 1);
  }
}

export function makeReducerProbe(turnEnd: TurnEnd): ReducerProbe {
  const Reducer = (reducerModule as unknown as AnyRecord).StreamJsonReducer as new (
    opts: AnyRecord
  ) => AnyRecord;
  if (typeof Reducer !== "function")
    throw new Error("ADAPTER: StreamJsonReducer is not exported as a class");

  const mentioned = new Set<string>();
  const stateAtOnResult: string[] = [];
  const snapshots: string[] = [];
  let calls = 0;

  const readState = (): string => {
    const r = reducer as AnyRecord;
    for (const key of ["state", "status", "currentState"]) {
      if (typeof r[key] === "string") return r[key] as string;
    }
    for (const key of ["getState", "getStatus", "currentState"]) {
      if (typeof r[key] === "function") return String((r[key] as Fn).call(r));
    }
    throw new Error("ADAPTER: no state getter on StreamJsonReducer");
  };

  const onStateChange = (...args: unknown[]) => {
    calls += 1;
    for (const a of args) collectStates(a, mentioned);
  };

  // StreamJsonReducerOptions (exported interface): `sessionId` and `callback: ReducerCallback`
  // are required alongside `onResult`. `callback(sessionId, event)` reports each state change.
  const reducer: AnyRecord = new Reducer({
    sessionId: "contract-reducer",
    callback: onStateChange,
    onResult: (_summary: unknown): TurnEnd => {
      stateAtOnResult.push(readState());
      return turnEnd;
    },
  });
  liveReducers.push(reducer);

  const snap = () => snapshots.push(readState());
  snap();

  const feedFn = method(
    reducer,
    ["handleLine", "processLine", "pushLine", "ingestLine", "push", "feed", "write", "ingest"],
    "reducer line ingestion"
  );

  return {
    reducer,
    feed(frame) {
      feedFn(`${JSON.stringify(frame)}\n`);
      snap();
    },
    state: readState,
    snapshots,
    mentioned,
    stateChangeCalls: () => calls,
    stateAtOnResult,
    anomalyCount() {
      const r = reducer as AnyRecord;
      const candidates: unknown[] = [
        r.anomalies,
        typeof r.getAnomalies === "function" ? (r.getAnomalies as Fn).call(r) : undefined,
        (r.diagnostics as AnyRecord | undefined)?.anomalies,
        typeof r.getDiagnostics === "function"
          ? ((r.getDiagnostics as Fn).call(r) as AnyRecord | undefined)?.anomalies
          : undefined,
      ];
      const list = candidates.find((c) => Array.isArray(c)) as unknown[] | undefined;
      if (!list) throw new Error("ADAPTER: cannot find the reducer's recorded anomalies");
      return list.length;
    },
    beginTurn() {
      method(reducer, ["beginTurn"], "beginTurn")();
      snap();
    },
    awaitInput() {
      method(reducer, ["awaitInput"], "awaitInput")();
      snap();
    },
    settle(state) {
      method(reducer, ["settle"], "settle")(state);
      snap();
    },
    dispose() {
      method(reducer, ["dispose"], "dispose")();
    },
  };
}

// ------------------------------------------------------------------------------------------
// SessionManager (team record API)
// ------------------------------------------------------------------------------------------

export interface SessionManagerHandle {
  sm: AnyRecord;
  recordTeamRun(args: { teamPath: string; slots: number; parentClaudeSessionId?: string }): unknown;
  finishTeamRun(record: unknown, outcome: unknown): unknown;
  /**
   * `SessionManager.getSession(id): SessionInfo` (public; its doc comment says it falls back to
   * `<sessionsDir>/<id>/meta.json` for a session not in memory). Returns `{ info }` or `{ error }`
   * so an unknown-id answer can be compared, whether it throws or returns.
   */
  getSession(id: string): { info?: AnyRecord; error?: string };
  dispose(): Promise<void>;
}

/**
 * Construct with the documented test override `hostPid`. `sessionsDir` is the documented
 * `SessionManagerOptions.sessionsDir`; without it the manager reads CLAUDISH_SESSIONS_DIR.
 */
export function newSessionManager(
  hostPid: number,
  opts: { sessionsDir?: string } = {}
): SessionManagerHandle {
  const Ctor = (sessionManagerModule as unknown as AnyRecord).SessionManager as new (
    opts: AnyRecord
  ) => AnyRecord;
  if (typeof Ctor !== "function")
    throw new Error("ADAPTER: SessionManager is not exported as a class");
  const sm = new Ctor(
    opts.sessionsDir === undefined ? { hostPid } : { hostPid, sessionsDir: opts.sessionsDir }
  );
  return {
    sm,
    getSession(id) {
      try {
        return { info: method(sm, ["getSession"], "getSession")(id) as AnyRecord };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
    recordTeamRun: (args) => method(sm, ["recordTeamRun"], "recordTeamRun")(args),
    finishTeamRun: (record, outcome) =>
      method(sm, ["finishTeamRun"], "finishTeamRun")(record, outcome),
    async dispose() {
      for (const name of ["shutdown", "dispose", "close", "stop"]) {
        if (typeof sm[name] === "function") {
          await (sm[name] as Fn).call(sm);
          return;
        }
      }
    },
  };
}

// ------------------------------------------------------------------------------------------
// team-orchestrator internals
// ------------------------------------------------------------------------------------------

/**
 * The slot state values the record suites name. `status.json` now carries the contract's
 * closed `SlotState` set, which has no PENDING: a not-yet-started slot is STARTING
 * (`setupSession` writes it), and `summarise` counts it as failed either way (§20.2).
 */
export function modelStates(): Record<
  "COMPLETED" | "FAILED" | "EMPTY" | "TIMEOUT" | "PENDING" | "RUNNING",
  SlotState
> {
  return {
    COMPLETED: "COMPLETED",
    FAILED: "FAILED",
    EMPTY: "EMPTY",
    TIMEOUT: "TIMEOUT",
    PENDING: "STARTING",
    RUNNING: "RUNNING",
  };
}

/** INFERRED signature: `setupSession(sessionPath, models, input)` writes manifest.json and status.json. */
export async function setupTeamSession(
  dir: string,
  models: string[],
  input: string
): Promise<void> {
  const fn = (orchestrator as unknown as AnyRecord).setupSession as Fn | undefined;
  if (typeof fn !== "function")
    throw new Error("ADAPTER: team-orchestrator does not export setupSession");
  await fn(dir, models, input);
}

export interface TeamHandleLike {
  done: Promise<unknown>;
}

export async function startModels(dir: string, opts: AnyRecord): Promise<TeamHandleLike> {
  const fn = (orchestrator as unknown as AnyRecord).startModels as Fn | undefined;
  if (typeof fn !== "function")
    throw new Error("ADAPTER: team-orchestrator does not export startModels");
  return (await fn(dir, opts)) as TeamHandleLike;
}
