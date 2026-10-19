/**
 * OpenAI Responses API SSE → Claude SSE stream parser (module entry point).
 *
 * Handles Codex models that use /v1/responses instead of /v1/chat/completions.
 * The work is split in three, under `responses/`:
 *   - `claude-sse-sink.ts`: the one writer of Claude SSE for one downstream
 *     message (lifecycle, block index, ping, tool block states, disconnect);
 *   - `responses-leg.ts`: one upstream body → Claude SSE events → LegOutcome;
 *   - `responses-turn.ts`: how the message ends, and the usage callback.
 * `composed-handler.ts` imports only this file.
 */

import type { Context } from "hono";
import type { CodeModeTurnHooks } from "../../../code-mode/types.js";
import { wrapAnthropicError } from "../anthropic-error.js";
import type { UsageCacheDetail } from "../token-tracker.js";
import { ClaudeSseSink } from "./responses/claude-sse-sink.js";
import { type ResponsesRetryOptions, runResponsesTurn } from "./responses/responses-turn.js";

export type { ResponsesRetryOptions } from "./responses/responses-turn.js";
export type { CodeModeTurnHooks, ExecTurnStep } from "../../../code-mode/types.js";
export { resolveStallPolicy, type StallPolicy } from "./responses/stall-guard.js";

export function createResponsesStreamHandler(
  c: Context,
  response: Response,
  opts: {
    modelName: string;
    /**
     * Fires the request's stats record, LAST at turn end: the final leg's input
     * (the context figure) and every leg's output.
     */
    onTokenUpdate?: (input: number, output: number) => void;
    /**
     * Retry a degenerate leg inside the same downstream message (see
     * responses/responses-turn.ts). Absent ⇒ one leg per turn, exactly as before.
     */
    retry?: ResponsesRetryOptions;
    /** Fires FIRST at turn end: input of earlier legs that reported usage (cost only). */
    onExtraBilledInput?: (inputTokens: number, detail?: UsageCacheDetail) => void;
    /** Fires after onExtraBilledInput, before onTokenUpdate. */
    onTurnSummary?: (s: { legs: number; legRetries: number }) => void;
    toolNameMap?: Map<string, string>;
    /**
     * Real per-provider context window (tokens) for the model on THIS backend,
     * resolved from the catalog by the caller. Used only to make the overflow
     * message specific ("caps at ~372K"); omit/0 → the number is left out.
     */
    contextWindow?: number;
    /**
     * Fired when the Responses backend returns an in-stream error event (e.g.
     * `context_length_exceeded`). The error arrives on an HTTP 200 stream, so the
     * caller can't see it from the status code — this signal lets it record the
     * turn as a failure instead of a success in telemetry.
     */
    onApiError?: (code: string, message: string) => void;
    /**
     * Input tokens from the previous request on this handler. Seeds
     * `message_start.usage` so a turn that ends without upstream usage does
     * not report a 100-token context. See message-start-usage.ts.
     */
    priorInputTokens?: number;
    /**
     * Middleware chain, so the Responses path gets the same response-side hooks
     * the Chat Completions path has had. Previously absent, which left the Codex
     * models with no observation point at all.
     */
    // biome-ignore lint/suspicious/noExplicitAny: MiddlewareManager is untyped on every parser
    middlewareManager?: any;
    /**
     * Behavior-layer tool-call interception. Called once per completed tool call
     * with the fully accumulated argument JSON; return replacement JSON to repair
     * the call, or null/undefined to leave it untouched.
     *
     * Only consulted for tools that `shouldBufferTool` opted in — see below.
     */
    onToolCall?: (name: string, argsJson: string) => string | null | undefined;
    /**
     * Whether a tool's arguments must be withheld until the call completes.
     *
     * Repair is only possible for buffered calls: this parser streams
     * `input_json_delta` the instant each fragment arrives, so by the time a call
     * is complete its arguments are already on the wire to the client. Buffering
     * is therefore opt-in PER TOOL — a tool no rule cares about keeps streaming
     * incrementally, so the default path keeps its current latency profile.
     */
    shouldBufferTool?: (name: string) => boolean;
    /**
     * Behavior-layer observation (Layer 4). Called with normalized text so rules
     * never have to understand this parser's event shape.
     */
    onAssistantText?: (text: string, kind?: "text" | "reasoning") => void;
    onToolCallObserved?: (name: string) => void;
    onTurnEnd?: () => void;
    /**
     * The request's tool names as Claude Code sent them (decoded, not the
     * encoded wire names). A function_call named `parallel` is treated as the
     * parallel wrapper only when no declared tool has that name. Absent → the
     * values of `toolNameMap`.
     */
    declaredToolNames?: string[];
    /**
     * Code mode for this turn (`openai-codex`): exec calls are run through these
     * hooks (responses/responses-turn.ts). Absent ⇒ exec calls are ignored.
     */
    codeMode?: CodeModeTurnHooks;
  }
): Response {
  if (!response.body) {
    // biome-ignore lint/suspicious/noExplicitAny: Hono's typed json response is not a plain Response
    return c.json(wrapAnthropicError(500, "No response body"), 500) as any;
  }

  let sink: ClaudeSseSink | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start: async (controller) => {
      sink = new ClaudeSseSink(controller, {
        modelName: opts.modelName,
        priorInputTokens: opts.priorInputTokens,
        onToolCallObserved: opts.onToolCallObserved,
      });
      sink.start();
      // runResponsesTurn never rejects and closes the sink when it resolves.
      await runResponsesTurn(sink, response, {
        modelName: opts.modelName,
        toolNameMap: opts.toolNameMap,
        declaredToolNames: opts.declaredToolNames ?? [...(opts.toolNameMap?.values() ?? [])],
        middlewareManager: opts.middlewareManager,
        streamMetadata: new Map(),
        onToolCall: opts.onToolCall,
        shouldBufferTool: opts.shouldBufferTool,
        onAssistantText: opts.onAssistantText,
        contextWindow: opts.contextWindow,
        onApiError: opts.onApiError,
        onTokenUpdate: opts.onTokenUpdate,
        onTurnEnd: opts.onTurnEnd,
        retry: opts.retry,
        onExtraBilledInput: opts.onExtraBilledInput,
        onTurnSummary: opts.onTurnSummary,
        codeMode: opts.codeMode,
      });
    },
    // Downstream went away (client disconnect, abort, or timeout). The
    // controller is already closed here, but none of the normal close paths
    // ran — so the sink marks itself closed (the keep-alive ping would
    // otherwise enqueue on a closed controller and throw from a timer callback,
    // killing the proxy process), and aborts the turn: the upstream reader is
    // cancelled rather than left streaming to completion with nobody reading.
    cancel() {
      sink?.cancel();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
