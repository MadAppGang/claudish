/**
 * The advisor panel gateway: one in-process request per routed panel or
 * collector call, through the chain startup built for it.
 *
 * A facade of two functions over Context building, chain lookup, the call's
 * deadline, its signing lease, redaction and hop attribution:
 *
 * - `plan(spec, role)` reads the startup plan map only. There is no lazy
 *   planning: a spec the map lacks is a refused plan ("advisor runtime not
 *   planned for this launch").
 * - `call(req)` never rejects. It POSTs the payload to a never-served Hono app
 *   whose one route installs the call's abort signal, hop log and signing
 *   secrets on a real `Context` and hands it to the startup-built chain. The
 *   app is never passed to `Bun.serve` and never goes through the session's
 *   `resolveHandlerForRequest`, so the monitor branch, the serve slot map and
 *   the `--model` remap cannot touch a panel call, and no advisor wrapper is
 *   ever applied (no recursion).
 *
 * The synthetic request carries NO auth header, and `ComposedHandler` forwards
 * no inbound `authorization`, so Claude Code's bearer cannot reach a panel hop.
 * `x-claudish-no-recovery: advisor` skips the tier-1 hold ladder: a 60 s budget
 * cannot use a multi-minute hold.
 */

import { type Context, Hono } from "hono";
import type { ChildAuthControl } from "../claude-runner.js";
import { log } from "../logger.js";
import { redactExactValues, redactForClient } from "../redact.js";
import {
  type AdvisorChainBuild,
  type AdvisorModelPlan,
  type AdvisorPanelCall,
  type AdvisorPanelGateway,
  type AdvisorPanelResult,
  type AdvisorRole,
  advisorChainKey,
  planHopForTransport,
} from "./advisor-route-plan.js";
import { wrapAnthropicError } from "./shared/anthropic-error.js";
import {
  CALL_ABORT_SIGNAL_KEY,
  HOP_LOG_KEY,
  type HopAttempt,
  SIGNING_SECRETS_KEY,
  type SigningSecrets,
  createSigningSecrets,
} from "./shared/call-context.js";
import { isStreamFailureResponse } from "./shared/recovery-marker.js";
import type { ModelHandler } from "./types.js";

/** What startup hands the proxy: every member's plan and every routed member's built chain. */
export interface AdvisorRuntime {
  /** Keyed `"<role>:<spec>"` (`advisorChainKey`). */
  plans: ReadonlyMap<string, AdvisorModelPlan>;
  chains: ReadonlyMap<string, AdvisorChainBuild>;
  /**
   * The launch's `childAuthControl` decision, the one the Claude plans were
   * made with: the decorator lets Claude Code's bearer sign a Claude call only
   * when it says claudish controls the child's auth.
   */
  childAuth: ChildAuthControl;
}

/** The URL of the synthetic request. Never resolved: the app is called in process. */
const ADVISOR_INTERNAL_URL = "http://claudish.advisor.internal/v1/messages";

interface PendingCall {
  handler: ModelHandler;
  signal: AbortSignal;
  hops: HopAttempt[];
  secrets: SigningSecrets;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The answer the app gives for a call it cannot run or a handler that threw. */
function proxyErrorResponse(c: Context, message: string): Response {
  return c.json(wrapAnthropicError(500, redactForClient(`Proxy error: ${message}`)), 500);
}

export function createAdvisorPanelGateway(runtime: AdvisorRuntime): AdvisorPanelGateway {
  const pendingCalls = new WeakMap<Request, PendingCall>();
  const app = new Hono();

  app.onError((err, c) => {
    log(`[advisor] panel gateway error: ${errorMessage(err)}`);
    return proxyErrorResponse(c, errorMessage(err));
  });

  app.post("/v1/messages", async (c) => {
    // Hono keeps the Request's identity, so the entry `call()` registered is
    // found by the very object it passed to `app.fetch`.
    const entry = pendingCalls.get(c.req.raw);
    if (!entry)
      return proxyErrorResponse(c, "advisor gateway: no call registered for this request");
    c.set(CALL_ABORT_SIGNAL_KEY, entry.signal);
    c.set(HOP_LOG_KEY, entry.hops);
    c.set(SIGNING_SECRETS_KEY, entry.secrets);
    try {
      return await entry.handler.handle(c, await c.req.json());
    } catch (err) {
      log(`[advisor] panel call threw: ${errorMessage(err)}`);
      return proxyErrorResponse(c, errorMessage(err));
    }
  });

  const plan = (spec: string, role: AdvisorRole): AdvisorModelPlan =>
    runtime.plans.get(advisorChainKey(role, spec)) ?? {
      kind: "refused",
      spec,
      role,
      cause: "no-callable-hop",
      reason: "advisor runtime not planned for this launch",
    };

  const call = async (req: AdvisorPanelCall): Promise<AdvisorPanelResult> => {
    const started = performance.now();
    const latencyMs = () => Math.round(performance.now() - started);
    const build = runtime.chains.get(advisorChainKey(req.plan.role, req.plan.spec));
    const hops: HopAttempt[] = [];
    const snapshot = (): AdvisorPanelResult["hops"] =>
      hops.slice().map((h) => {
        const hop = build ? planHopForTransport(req.plan, build, h.provider) : null;
        return { ...h, uid: hop?.provider ?? null, displayName: hop?.displayName ?? h.provider };
      });
    if (!build?.handler) {
      return {
        status: null,
        bodyText: "",
        streamFailure: false,
        hops: [],
        failure: { kind: "internal", message: `no hop could be built for ${req.plan.spec}` },
        latencyMs: latencyMs(),
      };
    }

    const plannedIndex = build.firstCallableHop;
    const plannedHop = plannedIndex === null ? undefined : req.plan.hops[plannedIndex];
    const planned = plannedHop
      ? {
          plannedHop: {
            provider: plannedHop.provider,
            displayName: plannedHop.displayName,
            billing: plannedHop.billing,
          },
        }
      : {};

    const secrets = createSigningSecrets();
    const controller = new AbortController();
    const request = new Request(ADVISOR_INTERNAL_URL, {
      method: "POST",
      body: JSON.stringify(req.payload),
      signal: controller.signal,
      headers: { "content-type": "application/json", "x-claudish-no-recovery": "advisor" },
    });
    pendingCalls.set(request, { handler: build.handler, signal: controller.signal, hops, secrets });

    // The body is read INSIDE the work, so the deadline covers it, and redacted
    // while the lease still holds every value the chain signed with.
    const work = (async () => {
      const res = await app.fetch(request);
      const text = redactExactValues(redactForClient(await res.text()), secrets.values);
      return { res, text };
    })();
    // The lease lives as long as the work: released when it settles, which for
    // a timed-out call is after its aborted work has unwound (and could still log).
    work.finally(() => secrets.lease.release()).catch(() => {});

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), req.timeoutMs);
    });
    try {
      const outcome = await Promise.race([work, deadline]);
      if (outcome === "timeout") {
        controller.abort();
        return {
          status: null,
          bodyText: "",
          streamFailure: false,
          hops: snapshot(),
          ...planned,
          failure: {
            kind: "timeout",
            message: `timed out after ${Math.round(req.timeoutMs / 1000)}s`,
          },
          latencyMs: latencyMs(),
        };
      }
      return {
        status: outcome.res.status,
        bodyText: outcome.text,
        streamFailure: isStreamFailureResponse(outcome.res),
        hops: snapshot(),
        ...planned,
        latencyMs: latencyMs(),
      };
    } catch (err) {
      return {
        status: null,
        bodyText: "",
        streamFailure: false,
        hops: snapshot(),
        ...planned,
        failure: {
          kind: "internal",
          message: redactExactValues(redactForClient(errorMessage(err)), secrets.values),
        },
        latencyMs: latencyMs(),
      };
    } finally {
      clearTimeout(timer);
    }
  };

  return { plan, call };
}
