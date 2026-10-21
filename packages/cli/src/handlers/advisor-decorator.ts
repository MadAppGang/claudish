/**
 * `withAdvisorSwap` — the advisor for ANY main model (P4, P5, P10).
 *
 * WHY A DECORATOR
 * ===============
 * Claude Code's advisor is a SERVER tool (`advisor_20260301`), not a function
 * tool. Every foreign converter drops it, so a main model served by xAI,
 * OpenRouter, Codex, ... never sees an advisor at all (observed: the Codex
 * handler sent 28 tools upstream and no `advisor`). The advisor code used to
 * live only inside `NativeHandler`, so it ran only for native traffic.
 *
 * This wrapper does, for whatever handler the proxy resolved:
 *   1. REQUEST — swaps the server tool for claudish's function tool `advisor`
 *      BEFORE the inner handler converts anything (converters keep function
 *      tools), and rewrites earlier advisor tool_results with the panel's
 *      advice (session-keyed, retained, replayed — native-handler-advisor.ts).
 *   2. SIGNAL — `c.set("advisorSwapped", true)` when it swapped. `NativeHandler`
 *      strips the `advisor-tool-2026-03-01` beta flag on that signal: its
 *      outbound headers are built inside `NativeHandler.handle` and a wrapper
 *      cannot reach them through `ModelHandler`, and Anthropic rejects a request
 *      that enables the beta without declaring the server tool.
 *   3. RESPONSE — tees the one-shot body: one branch goes to the client
 *      unchanged, the other is scanned for advisor tool_use ids (SSE reassembled
 *      across chunk boundaries, or a non-stream JSON `content[]`).
 *
 * EXACTLY ONCE
 * ============
 * No handler under this wrapper does advisor work any more — `NativeHandler`'s
 * own swap/scan/rewrite was removed in favour of this one (option (a), see the
 * P4 implementation log). The proxy wraps the RESULT of `getHandlerForRequest`
 * once per request, never a `FallbackHandler` candidate (wrapping candidates
 * would hide them from `FallbackHandler`'s `instanceof ComposedHandler` checks
 * and drop fallback metadata). Two guards make a second application inert
 * even by mistake: `withAdvisorSwap` never wraps an `AdvisorSwapHandler`, and a
 * request whose context is already marked `advisorHandled` passes straight
 * through.
 *
 * OFF MEANS OFF (BC20)
 * ====================
 * `withAdvisorSwap` returns `inner` itself when the swap config is disabled:
 * no swap, no scan, no log records.
 */

import type { Context } from "hono";
// The HARNESS extractSessionId: takes the whole request and reads
// `metadata.user_id`'s JSON `session_id`. NOT the same-named function in
// session-events/index.ts, which takes the metadata object instead.
import { extractSessionId } from "../behavior/harness.js";
import type { ChildAuthControl } from "../claude-runner.js";
import { log, logStderr } from "../logger.js";
import type { AdvisorPanelGateway } from "./advisor-route-plan.js";
import {
  type AdvisorSwapConfig,
  type AdvisorToolResult,
  type ClaudeAdvisorAuth,
  type ClaudeRequestFacts,
  NO_SESSION_BUCKET,
  type RunAdvisorCallParams,
  claudeRequestFacts,
  createAdvisorStreamScanner,
  findPendingAdvisorToolResults,
  getAdvisorCall,
  joinOrStartAdvisorCall,
  logAdvisorEvent,
  markAdvisorCallConsumed,
  missingAdvisorResult,
  prepareLegacyStubResult,
  recordAdvisorEventsFromResponseBody,
  recoverUnassociatedAdvisorResult,
  reportUnrecordedAdvisorCalls,
  resolveAdvisorCredential,
  resolveClaudeAdvisorAuth,
  rewriteAdvisorToolResults,
  runAdvisorCall,
  stubAdvisorAdvice,
  swapAdvisorToolInBody,
} from "./native-handler-advisor.js";
import type { ModelHandler } from "./types.js";

declare module "hono" {
  interface ContextVariableMap {
    /**
     * Set by `withAdvisorSwap` when it replaced Claude Code's advisor server
     * tool on this request. `NativeHandler` strips the advisor beta flag on it.
     */
    advisorSwapped: boolean;
    /** Set by `withAdvisorSwap` once it has processed this request. */
    advisorHandled: boolean;
  }
}

/** The Hono context key `NativeHandler` reads to decide the beta strip. */
export const ADVISOR_SWAPPED_CONTEXT_KEY = "advisorSwapped" as const;

const ADVISOR_SERVER_TOOL_TYPE = "advisor_20260301";
const ADVISOR_TOOL_NAME = "advisor";

/**
 * Cap on a NON-stream body buffered for the id scan. A Messages JSON response
 * is kilobytes; past this the scan is skipped (and says so) rather than
 * holding an unbounded copy.
 */
const MAX_JSON_SCAN_CHARS = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------
// P10 — the advisor tool stopped arriving
// ---------------------------------------------------------------------------

/** Consecutive advisor-less requests before the one warning. */
export const ADVISOR_ABSENT_WARN_AFTER = 3;

/** True when `tools` offers the advisor in either form: server tool or function tool. */
export function toolsOfferAdvisor(tools: unknown): boolean {
  if (!Array.isArray(tools)) return false;
  return tools.some((t) => {
    if (!t || typeof t !== "object") return false;
    const tool = t as Record<string, unknown>;
    return tool.type === ADVISOR_SERVER_TOOL_TYPE || tool.name === ADVISOR_TOOL_NAME;
  });
}

/** Watches requests for the advisor tool going missing (BC21). */
export interface AdvisorPresenceMonitor {
  /** Call once per request, BEFORE the swap, with the request as Claude Code sent it. */
  observe(payload: Record<string, unknown>): void;
}

/**
 * One monitor per proxy. After `ADVISOR_ABSENT_WARN_AFTER` consecutive
 * requests that offer tools but no advisor tool of either kind, it warns
 * exactly once and then stays silent for the life of the monitor.
 *
 * A request with NO `tools[]` at all neither counts nor resets the run: it is
 * a side request (title generation, the quota probe), which never carries
 * tools, and three of those in a row open every session before the main loop
 * starts. Counting them would warn on a healthy launch.
 *
 * The warning goes through `logStderr`, the sanctioned channel: while Claude
 * Code owns the terminal it is routed to DiagOutput instead of tearing the TUI.
 */
export function createAdvisorPresenceMonitor(
  warn: (message: string) => void = logStderr
): AdvisorPresenceMonitor {
  let consecutiveAbsent = 0;
  let warned = false;
  return {
    observe(payload: Record<string, unknown>): void {
      if (warned) return;
      const tools = payload?.tools;
      if (!Array.isArray(tools) || tools.length === 0) return;
      if (toolsOfferAdvisor(tools)) {
        consecutiveAbsent = 0;
        return;
      }
      consecutiveAbsent++;
      log(
        `[advisor-swap] request offers ${tools.length} tool(s) but no advisor (${consecutiveAbsent} in a row)`
      );
      if (consecutiveAbsent < ADVISOR_ABSENT_WARN_AFTER) return;
      warned = true;
      warn(
        `[advisor] Claude Code sent ${consecutiveAbsent} requests in a row that offer tools but no advisor tool, so --advisor is having no effect. Claude Code is not offering the advisor in this session (for example, the experimental advisor flag was withdrawn or disabled). This warning is shown once.`
      );
    },
  };
}

// ---------------------------------------------------------------------------
// The decorator
// ---------------------------------------------------------------------------

/** Optional collaborators for `withAdvisorSwap`. */
export interface AdvisorSwapDeps {
  /**
   * P10 monitor, shared by every request of one proxy. Omit it on side paths
   * (the classifier passthrough) whose requests must not count.
   */
  presence?: AdvisorPresenceMonitor;
  /**
   * The panel gateway over the startup plans and chains. Absent ⇒ nothing was
   * planned for this launch, and every member of a panel call is S7.
   */
  panel?: AdvisorPanelGateway;
  /** What a Claude member may sign with. Absent ⇒ the bearer is never used. */
  claude?: ClaudeAdvisorSwapDeps;
}

/** The decorator's inputs for Claude members and the Claude collector. */
export interface ClaudeAdvisorSwapDeps {
  /**
   * This launch's `childAuthControl(config, env)`, decided at startup. Only a
   * launch where claudish controls the child's auth lets the bearer sign.
   */
  childAuth: ChildAuthControl;
  /** ANTHROPIC_API_KEY lookup; defaults to the advisor's own credential lookup. */
  anthropicKey?: () => Promise<string | undefined>;
  /** Read for ANTHROPIC_AUTH_TOKEN; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Test seam for the Anthropic call; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Used when the decorator was given no Claude inputs: the launch's auth is
 * unknown, so the bearer is treated as not provably the Claude login.
 */
const UNKNOWN_CHILD_AUTH: ChildAuthControl = {
  controlled: false,
  reason: "proxy-auth",
  where: "unknown (no launch decision was passed to the advisor)",
};

/**
 * Wraps `inner` so its requests carry claudish's advisor function tool and its
 * responses are scanned for advisor calls. Returns `inner` unchanged when the
 * advisor is disabled, and never wraps a handler twice.
 */
export function withAdvisorSwap(
  inner: ModelHandler,
  cfg: AdvisorSwapConfig,
  deps: AdvisorSwapDeps = {}
): ModelHandler {
  if (!cfg.enabled) return inner;
  if (inner instanceof AdvisorSwapHandler) return inner;
  return new AdvisorSwapHandler(inner, cfg, deps);
}

/** The wrapper `withAdvisorSwap` returns. Exported for `instanceof` checks. */
export class AdvisorSwapHandler implements ModelHandler {
  constructor(
    readonly inner: ModelHandler,
    private readonly cfg: AdvisorSwapConfig,
    private readonly deps: AdvisorSwapDeps = {}
  ) {}

  async handle(c: Context, payload: any): Promise<Response> {
    // Exactly once per request, even if a wrapped handler were wrapped again.
    if (c.get("advisorHandled") === true) return this.inner.handle(c, payload);
    c.set("advisorHandled", true);

    // Pending advisor calls are keyed by Claude Code session: `serve` and the
    // MCP path run several conversations through one proxy. Absent → the
    // documented `__no_session__` bucket (see NO_SESSION_BUCKET).
    const sessionId = extractSessionId(payload);

    // P10 reads the request as Claude Code sent it, before the swap.
    try {
      this.deps.presence?.observe(payload);
    } catch {
      // a monitoring fault must never fail the request
    }

    await applyAdvisorRequestSide(c, payload, this.cfg, sessionId, this.deps);

    const response = await this.inner.handle(c, payload);
    return tapAdvisorResponse(response, this.cfg, sessionId);
  }

  async shutdown(): Promise<void> {
    await this.inner.shutdown();
  }
}

/**
 * What `runAdvisorCall` gets from this decorator: the panel gateway, and the
 * Claude credential for this main request, resolved only when a Claude member
 * runs (runAdvisorCall memoises it per call).
 */
function advisorCallDeps(
  deps: AdvisorSwapDeps,
  facts: ClaudeRequestFacts
): Pick<RunAdvisorCallParams, "gateway" | "claude"> {
  const anthropicKey = deps.claude?.anthropicKey ?? (() => resolveAdvisorCredential("anthropic"));
  return {
    ...(deps.panel ? { gateway: deps.panel } : {}),
    claude: {
      resolveAuth: (): Promise<ClaudeAdvisorAuth> => resolveClaudeAdvisorAuth(facts, anthropicKey),
      ...(deps.claude?.fetchImpl ? { fetchImpl: deps.claude.fetchImpl } : {}),
    },
  };
}

/**
 * The request half: tool swap, advisor tool_result rewrite, stub path S10,
 * body dump. Mutates `payload` in place before any converter reads it.
 */
async function applyAdvisorRequestSide(
  c: Context,
  payload: Record<string, unknown>,
  cfg: AdvisorSwapConfig,
  sessionId: string | undefined,
  deps: AdvisorSwapDeps
): Promise<void> {
  const target = payload.model;
  const sessionLabel = sessionId ?? NO_SESSION_BUCKET;

  // Stage 1: tool-definition swap (outbound).
  const swapped = swapAdvisorToolInBody(payload);
  if (swapped) {
    c.set(ADVISOR_SWAPPED_CONTEXT_KEY, true);
    log(
      `[advisor-swap] replaced advisor_20260301 with function tool 'advisor' (model=${target}, session=${sessionLabel})`
    );
    logAdvisorEvent(cfg, {
      kind: "swap_applied",
      model: target,
      originalTool: swapped.originalTool,
      regularTool: swapped.regularTool,
    });
  }

  // Stage 2: tool_result rewrite (inbound). A call's result is prepared once
  // and RETAINED: Claude Code re-sends every earlier advisor tool_result on
  // each turn, still carrying its own "No such tool" error, and each must get
  // the same text back — replayed, never re-fetched.
  const cachedResult = (id: string) => getAdvisorCall(id, sessionId)?.result;
  let rewrittenIds: string[] = [];

  if (cfg.models && cfg.models.length > 0) {
    // Bound once: TypeScript drops the narrowing of `cfg.models` inside the
    // async closure below, and `as string[]` there would hide a real change.
    const models = cfg.models;
    // Pass 1 restores advice already delivered on earlier turns, so the panel
    // below reads the conversation the model actually saw.
    rewriteAdvisorToolResults(payload, cachedResult, sessionId);

    const pendingIds = findPendingAdvisorToolResults(payload, sessionId);
    if (pendingIds.length > 0) {
      const freshIds: string[] = [];
      // Results this request has in hand. `cachedResult` covers every normal
      // case; this is the fall-back for one it cannot — a call whose entry was
      // evicted while the panel ran, which would otherwise take stub path S2
      // although the advice is right here.
      const delivered = new Map<string, AdvisorToolResult>();
      // Read ONCE per main request, before any panel runs: it registers every
      // real inbound credential on this request's signing lease, so any line
      // the request logs from here on is redacted against it.
      const facts: ClaudeRequestFacts = claudeRequestFacts(c, payload, {
        childAuth: deps.claude?.childAuth ?? UNKNOWN_CHILD_AUTH,
        ...(deps.claude?.env ? { env: deps.claude.env } : {}),
      });
      const callDeps = advisorCallDeps(deps, facts);
      for (const id of pendingIds) {
        if (cachedResult(id)) continue;

        // One panel run per (session, tool_use id), even if Claude Code has
        // two requests in flight for it — see joinOrStartAdvisorCall.
        const runPanel = async (): Promise<AdvisorToolResult> => {
          const outcome = await runAdvisorCall({
            toolUseId: id,
            sessionId,
            messages: payload.messages as any[],
            models,
            collector: cfg.collector ?? null,
            cfg,
            ...callDeps,
          });
          // The false return is honoured, never dropped: an answer claudish
          // cannot attach to the call is an answer the model will not receive,
          // so the model is told that and the log is corrected to match.
          if (!markAdvisorCallConsumed(id, outcome.result, sessionId)) {
            return recoverUnassociatedAdvisorResult(cfg, outcome);
          }
          return outcome.result;
        };

        let { promise, joined } = joinOrStartAdvisorCall(id, sessionId, runPanel);
        if (joined) {
          log(
            `[advisor-swap] advisor call ${id} is already running for this session; joined it instead of running the panel again (session=${sessionLabel})`
          );
          try {
            delivered.set(id, await promise);
            continue;
          } catch (err) {
            // The other request's call failed. Its entry is already gone, so
            // running our own is safe and cannot re-bill a live call.
            log(
              `[advisor-swap] the in-flight advisor call ${id} failed (${errorMessage(err)}); running our own`
            );
            ({ promise, joined } = joinOrStartAdvisorCall(id, sessionId, runPanel));
          }
        }
        delivered.set(id, await promise);
        if (!joined) freshIds.push(id);
      }
      // Pass 2: every tracked call now has a result. The S2 fallback is
      // unreachable by construction and reports itself as an error if not.
      rewrittenIds = rewriteAdvisorToolResults(
        payload,
        (id) => cachedResult(id) ?? delivered.get(id) ?? missingAdvisorResult(id),
        sessionId
      );
      if (rewrittenIds.length > 0) {
        const replayed = rewrittenIds.filter((id) => !freshIds.includes(id));
        log(
          `[advisor-swap] rewrote ${rewrittenIds.length} advisor tool_result(s) (session=${sessionLabel}) fresh=[${freshIds.join(", ")}] replayed=[${replayed.join(", ")}] panel=[${cfg.models.join(", ")}] collector=${cfg.collector ?? "none"}`
        );
        logAdvisorEvent(cfg, {
          kind: "multi_model_rewrite",
          ids: rewrittenIds,
          freshIds,
          models: cfg.models,
          collector: cfg.collector,
          model: target,
        });
      }
    }
  } else {
    // Legacy: stub advice (CLAUDISH_SWAP_ADVISOR=1 with no panel), stub path S1.
    for (const id of findPendingAdvisorToolResults(payload, sessionId)) {
      if (!cachedResult(id)) prepareLegacyStubResult(cfg, id, sessionId);
    }
    rewrittenIds = rewriteAdvisorToolResults(
      payload,
      (id) => cachedResult(id) ?? stubAdvisorAdvice(id),
      sessionId
    );
    if (rewrittenIds.length > 0) {
      log(
        `[advisor-swap] rewrote ${rewrittenIds.length} advisor tool_result(s) with stub advice (session=${sessionLabel}): ${rewrittenIds.join(", ")}`
      );
      logAdvisorEvent(cfg, {
        kind: "tool_result_rewritten",
        ids: rewrittenIds,
        model: target,
      });
    }
  }

  // Stub path S10: an advisor tool_result still carrying Claude Code's own
  // "No such tool" error for an id this session never recorded. Must run
  // after the rewrite, which clears the error text from every known call.
  reportUnrecordedAdvisorCalls(cfg, payload, sessionId);

  // Dump request body (trimmed) to inspect follow-ups that carry tool_result
  // blocks — the evidence for Stage 2 debugging.
  if (cfg.dumpBodies) {
    logAdvisorEvent(cfg, {
      kind: "request_body",
      swapApplied: !!swapped,
      rewrittenIds,
      model: target,
      body: trimForLog(payload),
    });
  }
}

/**
 * The response half. Tees the one-shot body: the client gets one branch, the
 * scanner drains the other in the background.
 *
 * BC7 — the client's bytes: the same chunk objects, in the same order, with no
 * buffering added. The client branch is re-exposed through a pull-only stream
 * (highWaterMark 0) for one reason: when the client cancels, the scan branch
 * is cancelled too. A tee releases its source only when BOTH branches are
 * cancelled, so without that the upstream model would keep generating (and
 * billing) for a client that has gone.
 *
 * Backpressure: the scan branch is drained eagerly and never paused, so the
 * tee never queues bytes for it. The upstream is therefore read at network
 * speed, exactly as NativeHandler's own eager read loop always did, and what
 * the client has not read yet waits in the client branch.
 *
 * Failures: a scan fault is logged and cancels ONLY the scan branch; the
 * client branch keeps streaming. An upstream fault reaches the client as it
 * would have without the tap.
 *
 * Ordering: the scan branch sees each chunk as the tee reads it, so an
 * advisor tool_use is recorded while the stream is still in flight — long
 * before Claude Code can run the tool and send the tool_result back.
 */
function tapAdvisorResponse(
  response: Response,
  cfg: AdvisorSwapConfig,
  sessionId: string | undefined
): Response {
  const body = response.body;
  if (!body) return response;
  const contentType = response.headers.get("content-type") ?? "";
  const kind: ScanKind | null = contentType.includes("text/event-stream")
    ? "sse"
    : contentType.includes("json")
      ? "json"
      : null;
  if (!kind) return response;

  let toClient: ReadableStream<Uint8Array>;
  let toScan: ReadableStream<Uint8Array>;
  try {
    [toClient, toScan] = body.tee();
  } catch (err) {
    // tee() on a locked/disturbed body throws without touching it.
    log(`[advisor-swap] response not scanned (${errorMessage(err)}); passed through untouched`);
    return response;
  }

  const clientReader = toClient.getReader();
  const scanReader = toScan.getReader();
  void drainScanBranch(scanReader, kind, cfg, sessionId);

  const passthrough = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const { done, value } = await clientReader.read();
          if (done) controller.close();
          else controller.enqueue(value);
        } catch (err) {
          controller.error(err);
        }
      },
      cancel(reason) {
        scanReader.cancel(reason).catch(() => {});
        return clientReader.cancel(reason);
      },
    },
    { highWaterMark: 0 }
  );

  return new Response(passthrough, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

type ScanKind = "sse" | "json";

/** Reads the scan branch to the end and records every advisor tool_use id. Never rejects. */
async function drainScanBranch(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  kind: ScanKind,
  cfg: AdvisorSwapConfig,
  sessionId: string | undefined
): Promise<void> {
  const decoder = new TextDecoder();
  // One scanner per stream: its own SSE reassembly buffer, bound to this session.
  const scanner = kind === "sse" ? createAdvisorStreamScanner(cfg, sessionId) : null;
  let jsonText = "";
  let jsonTooLarge = false;
  const take = (text: string) => {
    if (!text) return;
    if (scanner) {
      scanner.push(text);
    } else if (!jsonTooLarge) {
      jsonText += text;
      if (jsonText.length > MAX_JSON_SCAN_CHARS) {
        jsonTooLarge = true;
        jsonText = "";
      }
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      take(
        typeof value === "string" ? value : decoder.decode(value as Uint8Array, { stream: true })
      );
    }
    take(decoder.decode());
    if (jsonTooLarge) {
      log(
        `[advisor-swap] non-stream response over ${MAX_JSON_SCAN_CHARS} chars was not scanned for advisor calls`
      );
    } else if (!scanner && jsonText.trim()) {
      // A non-stream body is NOT a content_block_start: its advisor tool_use
      // blocks live in `content[]`, so it is read structurally (BC6).
      recordAdvisorEventsFromResponseBody(cfg, JSON.parse(jsonText), sessionId);
    }
  } catch (err) {
    log(`[advisor-swap] response scan stopped: ${errorMessage(err)} (client stream unaffected)`);
    reader.cancel(err).catch(() => {});
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Produces a logging-friendly copy of a request payload. Trims long text
 * fields (system prompts can exceed 30KB) so the advisor-swap log stays
 * readable. Preserves block structure so you can still inspect the shape
 * of tool_use / tool_result / server_tool_use blocks.
 */
function trimForLog(payload: any): any {
  const TEXT_TRUNC = 400;
  const clone = structuredClone(payload);
  const trimStr = (s: string) =>
    typeof s === "string" && s.length > TEXT_TRUNC
      ? `${s.slice(0, TEXT_TRUNC)}… [+${s.length - TEXT_TRUNC} chars]`
      : s;
  const walk = (v: any): any => {
    if (typeof v === "string") return trimStr(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: any = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return walk(clone);
}
