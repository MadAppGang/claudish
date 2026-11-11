/**
 * What this process has learned about reaching the models-index backend.
 *
 * Only a catalog refresh writes it, as a settled fact: the first answer of a
 * request, and how the refresh ended. A caller whose own wait ran out writes
 * nothing, because that only means the catalog has not arrived yet, and a slow
 * backend is not an unreachable one. The one other writer is
 * {@link noteCatalogSkipped}, a user's statement that this launch is offline.
 *
 *   unknown ──2xx──► contacted ──refresh ok──► reached
 *      │ transport error, non-2xx, failed refresh    ▲
 *      └────────────────► unreachable ──refresh ok───┘
 *
 * `unreachable` stays until a refresh succeeds: a retry's later 2xx leaves it
 * alone, because no catalog has been delivered yet. `reached` never goes back.
 *
 * A leaf module, so the catalog reader, the refresh and routing can all import it.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type UnreachableReason =
  /** `CLAUDISH_DISABLE_CATALOG_WARM=1`, or `--models-skip-update` on this launch. */
  | "disabled"
  /** A request ended in a network error or its own timeout. */
  | "transport"
  /** A request was answered with a non-2xx status. */
  | "http-status"
  /** A refresh ended fetch_failed or incompatible, or threw. */
  | "refresh-failed";

export type Reachability =
  /** No catalog request has answered yet. */
  | { state: "unknown" }
  /** A catalog request got a 2xx and its refresh is still running. */
  | { state: "contacted" }
  /** A refresh succeeded in this process. */
  | { state: "reached" }
  | { state: "unreachable"; reason: UnreachableReason; detail?: string };

let current: Reachability = { state: "unknown" };
let verdictWaiters: Array<() => void> = [];

/** Whether `CLAUDISH_DISABLE_CATALOG_WARM` holds the value that turns the refresh off. */
export function catalogWarmDisabledFor(value: string | undefined): boolean {
  return value === "1";
}

export function catalogReachability(): Reachability {
  // Read before what is stored: with the refresh off, no request will ever answer.
  if (catalogWarmDisabledFor(process.env.CLAUDISH_DISABLE_CATALOG_WARM)) {
    return { state: "unreachable", reason: "disabled", detail: "CLAUDISH_DISABLE_CATALOG_WARM=1" };
  }
  return current;
}

function settle(next: Reachability): void {
  current = next;
  const waiters = verdictWaiters;
  verdictWaiters = [];
  for (const resolve of waiters) resolve();
}

/** `unreachable`, unless the state is already settled; the first cause stays. */
function markUnreachable(reason: UnreachableReason, detail: string | undefined): void {
  if (current.state === "unknown" || current.state === "contacted") {
    settle({ state: "unreachable", reason, ...(detail !== undefined ? { detail } : {}) });
  }
}

/** The answer of one catalog request. Written by the refresh's own fetch. */
export function noteCatalogContact(
  outcome: "ok" | "transport" | "http-status",
  detail?: string
): void {
  if (outcome === "ok") {
    if (current.state === "unknown") settle({ state: "contacted" });
    return;
  }
  markUnreachable(outcome, detail);
}

/** How a refresh ended. A successful one counts from any state. */
export function noteRefreshSettled(outcome: "refreshed" | "failed", detail?: string): void {
  if (outcome === "refreshed") {
    settle({ state: "reached" });
    return;
  }
  markUnreachable("refresh-failed", detail);
}

/** This launch was told not to refresh the catalog (`--models-skip-update`). */
export function noteCatalogSkipped(detail: string): void {
  if (current.state !== "reached") settle({ state: "unreachable", reason: "disabled", detail });
}

/**
 * Resolves once the state is no longer `unknown`. A waiter only: it starts
 * nothing, so a caller must have started the request whose answer it waits for.
 */
export async function awaitCatalogVerdict(): Promise<Reachability> {
  if (catalogReachability().state === "unknown") {
    await new Promise<void>((resolve) => verdictWaiters.push(resolve));
  }
  return catalogReachability();
}

/** False when `CLAUDISH_DISABLE_BUNDLED_LIST=1`: no reader ever gets the bundled list. */
export function bundledListEnabled(): boolean {
  return process.env.CLAUDISH_DISABLE_BUNDLED_LIST !== "1";
}

const bundledListScope = new AsyncLocalStorage<true>();

/**
 * Run `fn` with the bundled list answering the default catalog path whatever the
 * reachability, for this async context only. A concurrent caller outside `fn`
 * is unaffected.
 */
export function withBundledListScope<T>(fn: () => T): T {
  return bundledListScope.run(true, fn);
}

export function bundledListScopeActive(): boolean {
  return bundledListScope.getStore() === true;
}

export function _resetCatalogReachabilityForTest(): void {
  settle({ state: "unknown" });
}
