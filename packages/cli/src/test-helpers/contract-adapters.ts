// packages/cli/src/test-helpers/contract-adapters.ts
/**
 * INFERRED glue, in one place. The contract names these symbols but not their exact shapes:
 *
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
import type { SlotState } from "../pane/index.js";
import * as orchestrator from "../team-orchestrator.js";

type AnyRecord = Record<string, unknown>;
type Fn = (...args: unknown[]) => unknown;

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
