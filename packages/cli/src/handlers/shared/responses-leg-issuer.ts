/**
 * Issue upstream legs 2..n of one Responses turn.
 *
 * The turn driver (`stream-parsers/responses/responses-turn.ts`) retries a
 * stalled or degenerate leg INSIDE the same downstream message, after the 200
 * and `message_start` were already flushed. So a leg cannot answer with a
 * status, cannot start a network-recovery hold, and must never move to another
 * credential silo: everything that goes wrong here ends as a `LegResponse`
 * error, which the driver turns into an SSE `error` event (Claude Code then
 * discards the message and retries the turn). No status is invented.
 *
 * Per leg (the contract `ai-docs/architecture/adapters.md` records):
 *  1. `refreshAuth()`; when the transport returns a binding and its arm or
 *     account differs from the turn's binding, stop ("Codex sign-in changed
 *     during the turn") rather than continue on another credential silo. A
 *     transport that returns nothing keeps today's no-binding path;
 *  2. endpoint and headers from that binding, wire headers merged;
 *  3. its own ceiling `deadlineClamp(now + tier-1 deadline)`, merged with the
 *     turn's signal and disarmed at headers;
 *  4. 401 → `forceRefreshAuth()` (same binding check) + fresh headers + one
 *     re-fetch;
 *  5. any other non-200 → error carrying the upstream status and the first 500
 *     bytes of the body; no parameter recovery on legs;
 *  6. 200 → the 7b stream-head settle (in-stream overload backoff);
 *  7. a throw from any network touch → classified for the log line only, then
 *     error; an abort from the turn's signal ends silently (the client is gone).
 */

import { log } from "../../logger.js";
import type { SerializedBody } from "../../providers/transport/types.js";
import { classifyConnectionError } from "./connection-error.js";
import { deadlineClamp, mergeSignalIntoInit } from "./transient-retry.js";

/** What `issueLeg` hands the turn driver. */
export type LegResponse =
  | { kind: "ok"; response: Response; headersAt: number }
  | { kind: "error"; message: string }
  | { kind: "aborted" };

/**
 * The part of a request's auth binding a leg checks: the credential arm and
 * the account. Transports that return nothing from `refreshAuth` have no
 * binding, and their legs use the no-binding path (identical to the primary
 * fetch).
 */
export interface LegAuthBinding {
  auth?: { arm?: string } | null;
  accountKey?: string;
}

type StreamHeadSettle =
  | { kind: "ok"; response: Response }
  | { kind: "exhausted"; code: string; message: string; attempts: number; unreachable?: true };

export interface LegIssuerDeps<B extends LegAuthBinding = LegAuthBinding> {
  providerDisplayName: string;
  /** The turn's current binding (undefined on the no-binding path). */
  getBinding: () => B | undefined;
  setBinding: (binding: B) => void;
  refreshAuth?: () => Promise<B | undefined>;
  forceRefreshAuth?: () => Promise<B | undefined>;
  getEndpoint: (binding: B | undefined) => string;
  /** The request's own header builder (wire headers merged). */
  fetchHeaders: (binding: B | undefined) => Promise<Record<string, string>>;
  /** The serialized body for a leg: `undefined` → the primary request's bytes. */
  serializeBody: (body: unknown | undefined) => { body: SerializedBody; contentType: string };
  getRequestInit?: () => Record<string, unknown>;
  enqueueRequest?: (
    fn: () => Promise<Response>,
    opts?: { signal?: AbortSignal }
  ) => Promise<Response>;
  /** The 7b stream-head settle, abortable by the turn's signal. */
  settleStreamHead: (
    response: Response,
    reissue: () => Promise<Response>,
    signal: AbortSignal
  ) => Promise<StreamHeadSettle>;
  /** The absolute ceiling for one leg's connect-and-headers, on `deadlineClamp`'s clock. */
  legDeadlineAt: () => number;
  /** Wall-clock stamp for `headersAt` (the stall guard's clock). Default `Date.now`. */
  now?: () => number;
  /** Injection point for tests; default the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** Thrown inside the issuer when the credential silo changed; never escapes it. */
class BindingChanged extends Error {}

function assertSameSilo(turn: LegAuthBinding | undefined, next: LegAuthBinding): void {
  if (!turn) return;
  const armChanged = (turn.auth?.arm ?? undefined) !== (next.auth?.arm ?? undefined);
  const accountChanged = turn.accountKey !== next.accountKey;
  if (armChanged || accountChanged) throw new BindingChanged();
}

/**
 * Build `issueLeg(body, signal)` for one request. Never throws; every failure
 * is a `LegResponse`.
 */
export function createLegIssuer<B extends LegAuthBinding = LegAuthBinding>(
  deps: LegIssuerDeps<B>
): (body: unknown | undefined, signal: AbortSignal) => Promise<LegResponse> {
  const now = deps.now ?? Date.now;
  const doFetch = deps.fetchImpl ?? fetch;
  let legNumber = 1;

  const adoptBinding = (next: B | undefined) => {
    if (!next) return;
    assertSameSilo(deps.getBinding(), next);
    deps.setBinding(next);
  };

  return async (body, signal) => {
    legNumber++;
    const leg = legNumber;
    if (signal.aborted) return { kind: "aborted" };
    try {
      if (deps.refreshAuth) adoptBinding(await deps.refreshAuth());
      let binding = deps.getBinding();
      const endpoint = deps.getEndpoint(binding);
      const serialized = deps.serializeBody(body);

      // One attempt: its own ceiling, composed with the turn's signal, disarmed
      // the instant headers arrive so a live body is never cut.
      let headersAt = 0;
      const send = async (headers: Record<string, string>): Promise<Response> => {
        const clamp = deadlineClamp(deps.legDeadlineAt());
        const sig = clamp.signal ? AbortSignal.any([clamp.signal, signal]) : signal;
        const attempt = () =>
          doFetch(
            endpoint,
            mergeSignalIntoInit(
              {
                method: "POST",
                headers: { ...headers, "Content-Type": serialized.contentType },
                body: serialized.body,
                ...(deps.getRequestInit?.() || {}),
              },
              sig
            )
          );
        try {
          const response = deps.enqueueRequest
            ? await deps.enqueueRequest(attempt, { signal: sig })
            : await attempt();
          headersAt = now();
          return response;
        } finally {
          clamp.disarm();
        }
      };

      let headers = await deps.fetchHeaders(binding);
      log(`[ResponsesTurn] issuing retry leg ${leg}: ${endpoint}`);
      let response = await send(headers);

      // The RAW upstream status of this leg's own fetch: no remap has happened
      // on this path, so there is nothing for extractUpstreamStatus to recover.
      if (response.status === 401 && deps.forceRefreshAuth) {
        await response.body?.cancel().catch(() => {});
        adoptBinding(await deps.forceRefreshAuth());
        binding = deps.getBinding();
        headers = await deps.fetchHeaders(binding);
        response = await send(headers);
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        const message = `HTTP ${response.status} on retry leg ${leg}: ${text.slice(0, 500)}`;
        log(`[ResponsesTurn] ${message}`);
        return { kind: "error", message };
      }

      const settled = await deps.settleStreamHead(response, () => send(headers), signal);
      if (signal.aborted) {
        if (settled.kind === "ok") await settled.response.body?.cancel().catch(() => {});
        return { kind: "aborted" };
      }
      if (settled.kind === "exhausted") {
        const message = `${deps.providerDisplayName} is overloaded upstream on retry leg ${leg} (${settled.code}): ${settled.message}`;
        log(`[ResponsesTurn] ${message}`);
        return { kind: "error", message };
      }
      return { kind: "ok", response: settled.response, headersAt };
    } catch (err) {
      if (signal.aborted) return { kind: "aborted" };
      if (err instanceof BindingChanged) {
        log(`[ResponsesTurn] Codex sign-in changed during the turn (retry leg ${leg})`);
        return { kind: "error", message: "Codex sign-in changed during the turn" };
      }
      // Classified for the log only: after the flush there is no status to
      // choose and no recovery hold to start.
      const conn = classifyConnectionError(err);
      const what = conn ? `${conn.kind} (${conn.code})` : "error";
      log(`[ResponsesTurn] retry leg ${leg} failed: ${what}: ${err}`);
      return {
        kind: "error",
        message: `retry leg ${leg} could not reach ${deps.providerDisplayName}: ${err}`,
      };
    }
  };
}
