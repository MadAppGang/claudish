/**
 * The oracle (architecture §4): an EXACT search for the maximum cu servable
 * under the hidden truth, on small scenarios only (at most 12 requests × 3
 * accounts, 3¹² ≈ 531k leaves before pruning).
 *
 * A yardstick, not a strategy: it sees the whole future, including every reset
 * and the external drift, which no deployable rule can. It re-derives the hand
 * figures of the adversarial traces (`adversarial.ts`) before any strategy is
 * built, and where a hand figure and the oracle disagree, the oracle wins.
 *
 * Two maxima, because they answer different questions:
 * - `servedCu`: any assignment, a request may also be left unserved on purpose
 *   (under `fits` admission, skipping a small request can save a window for a
 *   larger one);
 * - `servedCuNoIdle` (`mustServe`): every request that some account can accept
 *   is served, which is what a pool that always answers can achieve.
 */

import type { AccountId, Ms } from "../types.js";
import {
  type VendorAccountSpec,
  type VendorWorld,
  admissible,
  advanceWorld,
  chargeWorld,
  initialWorld,
} from "./vendor.js";

export const ORACLE_MAX_REQUESTS = 12;
export const ORACLE_MAX_ACCOUNTS = 3;

export interface OracleRequest {
  at: Ms;
  /** The request's cost in cu (the oracle charges cu directly, never tokens). */
  cu: number;
}

export interface OracleInput {
  accounts: VendorAccountSpec[];
  start: Ms;
  requests: OracleRequest[];
  /** Serve every request some account can accept (no deliberate idling). Default false. */
  mustServe?: boolean;
}

export interface OracleResult {
  /** The maximum total cu served. */
  servedCu: number;
  /** How many requests that assignment serves. */
  served: number;
  /** Per request, in time order: the account that serves it, or null. */
  assignment: (AccountId | null)[];
  /** Search nodes expanded, for the bench. */
  nodes: number;
}

/**
 * The best assignment, depth-first in time order, children in account order,
 * pruned when the cu served so far plus every remaining request's cu cannot
 * beat the best found. Ties keep the first found, so the result is
 * deterministic: earlier requests prefer earlier accounts.
 */
export function oracle(input: OracleInput): OracleResult {
  if (input.requests.length > ORACLE_MAX_REQUESTS) {
    throw new RangeError(`oracle: at most ${ORACLE_MAX_REQUESTS} requests`);
  }
  if (input.accounts.length > ORACLE_MAX_ACCOUNTS) {
    throw new RangeError(`oracle: at most ${ORACLE_MAX_ACCOUNTS} accounts`);
  }
  const requests = input.requests
    .map((r, i) => ({ ...r, i }))
    .sort((a, b) => a.at - b.at || a.i - b.i);
  if (requests.length > 0 && (requests[0]?.at ?? input.start) < input.start) {
    throw new RangeError("oracle: a request before the start");
  }
  const suffix: number[] = new Array(requests.length + 1).fill(0);
  for (let k = requests.length - 1; k >= 0; k--) {
    suffix[k] = (suffix[k + 1] ?? 0) + (requests[k]?.cu ?? 0);
  }
  const ids = input.accounts.map((a) => a.id);
  let best = { servedCu: -1, served: 0, assignment: [] as (AccountId | null)[] };
  let nodes = 0;
  const path: (AccountId | null)[] = [];

  const search = (k: number, world: VendorWorld, servedCu: number, served: number): void => {
    nodes++;
    if (servedCu + (suffix[k] ?? 0) <= best.servedCu + 1e-9 && best.servedCu >= 0) return;
    const request = requests[k];
    if (!request) {
      if (servedCu > best.servedCu + 1e-9) best = { servedCu, served, assignment: [...path] };
      return;
    }
    advanceWorld(world, request.at);
    const open = ids.filter((id) => admissible(world, id, request.cu));
    for (const id of open) {
      const next = structuredClone(world);
      chargeWorld(next, id, request.cu);
      path.push(id);
      search(k + 1, next, servedCu + request.cu, served + 1);
      path.pop();
    }
    if (open.length === 0 || !input.mustServe) {
      path.push(null);
      search(k + 1, structuredClone(world), servedCu, served);
      path.pop();
    }
  };

  search(0, initialWorld(input.accounts, input.start), 0, 0);
  // Restore input order for the assignment.
  const assignment: (AccountId | null)[] = new Array(requests.length).fill(null);
  requests.forEach((r, k) => {
    assignment[r.i] = best.assignment[k] ?? null;
  });
  return { servedCu: Math.max(0, best.servedCu), served: best.served, assignment, nodes };
}
