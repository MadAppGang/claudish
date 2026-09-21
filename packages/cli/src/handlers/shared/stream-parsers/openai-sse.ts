/**
 * OpenAI SSE → Claude SSE stream parser.
 *
 * Converts OpenAI-compatible Server-Sent Events to Claude SSE format.
 * Used by ComposedHandler to translate streaming responses from
 * OpenAI-compatible providers (OpenRouter, LiteLLM, local models, etc.)
 * into the format Claude Code expects.
 */

import type { Context } from "hono";
import { log, logStderr } from "../../../logger.js";

const SEARXNG_AVAILABLE = !!process.env.SEARXNG_URL;
import {
  validateAndRepairToolCall,
  inferMissingParameters,
  extractToolCallsFromText,
  hasExtractableFunctionTag,
  type ToolSchema,
} from "../tool-call-recovery.js";
import { isWebSearchToolCall } from "../web-search-detector.js";
import { executeWebSearch, extractSearchQuery } from "../web-search-executor.js";
import { createResponseCapture } from "../response-capture.js";
import { requestNumberFor } from "../../../fork/middleware/request-logger.js";
import {
  isPolicyRefusal,
  logPolicyRefusal,
  policyRefusalNotice,
  POLICY_RETRY_BACKOFF_MS,
  type PolicyRetryOpts,
} from "./policy-refusal.js";
import { messageStartUsage } from "./message-start-usage.js";
import { type BlockRef, createBlockWriter } from "./block-writer.js";
import { type ThinkSplit, createThinkTagSplitter } from "./think-tag-splitter.js";
import { splitPromptTokens, toAnthropicUsage } from "./usage-cache-split.js";

/**
 * Hard ceiling, in characters, on ONE logged raw SSE payload.
 *
 * The debug log is the source of record for test fixtures — `extract-sse-from-log.ts`
 * reads these very lines back and writes them out as `.sse` replay files — so the
 * payload has to reach the log VERBATIM. A payload cut mid-JSON yields a fixture that
 * `JSON.parse` rejects, and the parser's `catch` swallows that, so the corruption only
 * ever surfaces as a wrong `stop_reason` several layers away. That is exactly what the
 * previous 300-character cap did.
 *
 * 1M characters is a backstop against a pathological provider, not a content limit: a
 * normal chunk is a few hundred bytes, and even a whole tool call with inlined arguments
 * is orders of magnitude under it. Nothing that fits in a real turn can be cut by it.
 * (S4-b 333026b)
 */
export const SSE_LOG_MAX_CHARS = 1_000_000;

/**
 * Appended when — and only when — a payload exceeded {@link SSE_LOG_MAX_CHARS}.
 *
 * A cut payload is never left looking whole. This marker is not valid JSON and not
 * plausible content, so both a human reading the log and `extract-sse-from-log.ts`
 * can tell an incomplete line from a complete one.
 */
export const SSE_LOG_TRUNCATION_MARKER = "<<<CLAUDISH_SSE_TRUNCATED>>>";

/**
 * Render a raw SSE `data:` payload for the debug log: verbatim, unless it is
 * absurdly large, in which case it is cut and unmistakably flagged as cut.
 */
export function formatRawSseLogPayload(dataStr: string): string {
  if (dataStr.length <= SSE_LOG_MAX_CHARS) return dataStr;
  return `${dataStr.substring(0, SSE_LOG_MAX_CHARS)} ${SSE_LOG_TRUNCATION_MARKER} original_chars=${dataStr.length}`;
}

/**
 * Render an error carried INSIDE a 200 stream into one readable line.
 *
 * OpenRouter answers HTTP 200 and then reports the upstream's refusal as a
 * frame in the body (empty `choices` + `error` object), so every field the
 * parser reads is undefined and the frame matched nothing at all: dropped
 * without a log line, the turn looked like a model with nothing to say.
 *
 * Returns undefined when the frame carries no error, so the caller can test
 * the result directly. The refusal CLASS keeps its #65 treatment; this
 * handles everything else. (S4-b 321c2f0)
 */
export function describeInStreamError(chunk: unknown): string | undefined {
  if (!chunk || typeof chunk !== "object") return undefined;
  const error = (chunk as { error?: unknown }).error;
  if (!error) return undefined;

  // Some gateways send a bare string; most send an object.
  if (typeof error === "string") return error;
  if (typeof error !== "object") return String(error);

  const e = error as Record<string, unknown>;
  const metadata = (e.metadata ?? {}) as Record<string, unknown>;

  const parts: string[] = [];
  // The vendor that actually refused, when the aggregator names it. Without
  // this the message reads as though the aggregator itself rejected the call.
  const provider = (chunk as { provider?: unknown }).provider;
  if (typeof provider === "string" && provider) parts.push(`[${provider}]`);

  const code = e.code ?? metadata.provider_code;
  const type = e.type ?? metadata.error_type;
  const label = [code, type].filter((v) => v !== undefined && v !== null && v !== "").join(" ");
  if (label) parts.push(label);

  const message = e.message ?? metadata.raw;
  parts.push(
    typeof message === "string" && message.trim() ? message : JSON.stringify(error).slice(0, 500)
  );

  return parts.join(" ");
}

export interface StreamingState {
  usage: any;
  finalized: boolean;
  /**
   * Which content block is open, and every block index allocated this turn, are
   * owned by the BlockWriter — not by this state object. The five fields that
   * used to live here (`textStarted`, `textIdx`, `reasoningStarted`,
   * `reasoningIdx`, `curIdx`) were a second source of truth for the same thing
   * and were maintained by hand at every emit site. (S4-b ccca029)
   */
  tools: Map<number, ToolState>;
  toolIds: Set<string>;
  lastActivity: number;
  accumulatedText: string; // Accumulated text for potential tool call extraction
  lastFinishReason: string | null; // Last finish_reason seen (stop/length/content_filter) — diagnoses empty responses
  /**
   * Argument fragments that arrived for a `tool_calls` index BEFORE its
   * `function.name` did, keyed by that index (S4-b baf19ef).
   *
   * OpenAI's own streams put the name in the first fragment for an index, so
   * this map is empty on every capture in the tree. Providers that do not —
   * and they exist — had the head of their JSON object silently dropped by an
   * `&& t` guard, leaving arguments that begin mid-object and cannot parse —
   * indistinguishable downstream from a model that emitted bad JSON.
   * Drained into `ToolState.arguments` the moment the tool is created.
   */
  pendingToolArgs: Map<number, string>;
  /**
   * `function.name` fragments per `tool_calls` index, accumulated (S4-b baf19ef).
   *
   * The name is decoded from here rather than from a single chunk's fragment,
   * so there is ONE place where a complete name exists — decoding a fragment
   * yields a miss on the truncated-name map, and the call is then dropped in
   * silence.
   */
  pendingToolName: Map<number, string>;
}

export interface ToolState {
  id: string;
  name: string;
  blockIndex: number;
  started: boolean; // Whether content_block_start has been sent
  closed: boolean;
  suppressed: boolean; // Web search tools — drop from stream, replace with text
  remapped: boolean; // Web search tools re-emitted as the client's WebSearch tool_use
  arguments: string; // Accumulated JSON arguments string
  buffered: boolean; // Whether we're buffering args until tool call completes
  /**
   * The block this tool is currently streaming into, or null when it has none
   * (buffered and not yet flushed, or its block was superseded — see the
   * interleave degradation in the `tool_calls` delta handler). (S4-b ccca029)
   */
  ref: BlockRef | null;
}

/**
 * Whether the client declared a WebSearch tool in this request.
 * When it did, provider-side web search calls (web_search tool calls or GLM
 * <searchWeb> tags) are remapped to a synthetic WebSearch tool_use with
 * stop_reason "tool_use" — the client then runs its own WebSearch, gets the
 * results as a tool_result, and the agentic loop CONTINUES. Suppressing the
 * call and injecting results as text ends the turn (stop_reason end_turn),
 * which stalls the agent on raw search results (CoursIA incident 2026-06-10).
 */
function clientDeclaresWebSearch(toolSchemas?: any[]): boolean {
  return !!toolSchemas?.some((s) => s?.name === "WebSearch");
}

/**
 * Validate tool call arguments against the tool schema
 * Now includes automatic repair of missing parameters
 */
export function validateToolArguments(
  toolName: string,
  argsStr: string,
  toolSchemas: any[],
  textContent?: string
): {
  valid: boolean;
  missingParams: string[];
  parsedArgs: any;
  repaired: boolean;
  repairedArgs?: any;
} {
  const result = validateAndRepairToolCall(
    toolName,
    argsStr,
    toolSchemas as ToolSchema[],
    textContent
  );

  if (result.repaired) {
    log(`[ToolValidation] Repaired tool call ${toolName} - inferred missing parameters`);
  }

  return {
    valid: result.valid,
    missingParams: result.missingParams,
    parsedArgs: result.args,
    repaired: result.repaired,
    repairedArgs: result.repaired ? result.args : undefined,
  };
}

/**
 * Create initial streaming state
 */
export function createStreamingState(): StreamingState {
  return {
    usage: null,
    finalized: false,
    tools: new Map(),
    toolIds: new Set(),
    lastActivity: Date.now(),
    accumulatedText: "",
    lastFinishReason: null,
    pendingToolArgs: new Map(),
    pendingToolName: new Map(),
  };
}

/**
 * Handle streaming response conversion from OpenAI SSE to Claude SSE format
 */
export function createStreamingResponseHandler(
  c: Context,
  response: Response,
  adapter: any,
  target: string,
  middlewareManager: any,
  // `input` is ALWAYS `prompt_tokens` — the full context size, which the status
  // line renders and the delta strategy bills against. The cached breakdown
  // rides in the third argument and is for COST ONLY; handing the tracker the
  // reduced wire figure would report a nearly-full conversation as almost
  // empty and disarm auto-compaction. (S4-c, upstream f9baf2e rule 1 — this
  // fork already passed the full value before; the rule is now pinned by test.)
  onTokenUpdate?: (
    input: number,
    output: number,
    detail?: { cacheReadTokens: number; cacheCreationTokens: number }
  ) => void,
  toolSchemas?: any[], // Tool schemas for validation
  toolNameMap?: Map<string, string>, // Truncated → original tool name mapping
  headerLatencyMs?: number, // dispatch → upstream headers, from ComposedHandler
  retryOpts?: PolicyRetryOpts, // invalid_prompt transparent retry (#65) — absent = inert
  priorInputTokens?: number // Last request's context size — seeds message_start.usage (S4-b ae8c07f)
): Response {
  log(`[Streaming] ===== HANDLER STARTED for ${target} =====`);
  let isClosed = false;
  let ping: NodeJS.Timeout | null = null;
  const encoder = new TextEncoder();
  // `let`: re-created on a policy-refusal reader swap — a TextDecoder keeps
  // partial multi-byte state across decode(stream:true) calls, and bytes from
  // the OLD stream must not leak into the first chunk of the new one.
  let decoder = new TextDecoder();
  const streamMetadata = new Map<string, any>();

  // TTFT anchor: headers are in the moment this handler is built. The first
  // upstream `data:` line then closes the measurement. stdout like [resp] so
  // the two markers join in docker logs (this was the instrumentation gap of
  // the 2026-08-24 abort investigation: totals were logged, TTFT never was).
  // reqN resolved from the request object (assigned at ingestion): the global
  // counter read at this point returns whichever request is CURRENT while this
  // one waited for headers — under concurrency handlers cross-label.
  const tHeaders = performance.now();
  const reqN = requestNumberFor(c.req);
  const cap = createResponseCapture("openai", target, true, reqN);
  let ttftLogged = false;

  return c.body(
    new ReadableStream({
      async start(controller) {
        // Diagnostic tap (no-op unless CLAUDISH_CAPTURE_DIR set): mirror every
        // outgoing byte to the response capture so a hung stream is visible offline.
        const _origEnqueue = controller.enqueue.bind(controller);
        controller.enqueue = ((chunk: any) => {
          cap.tap(chunk);
          return _origEnqueue(chunk);
        }) as any;

        const send = (e: string, d: any) => {
          if (!isClosed) {
            controller.enqueue(encoder.encode(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`));
          }
        };

        const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const state = createStreamingState();
        // Every content block for this turn is opened, appended to and closed
        // through here. It owns the block-index counter, so nothing else
        // allocates an index. (S4-b ccca029)
        const writer = createBlockWriter(send);
        const thinkSplitter = createThinkTagSplitter();

        /**
         * Route one splitter result to its blocks.
         *
         * Shared by the streaming path and by `finalize()`'s flush, so a fragment
         * released at the end of the turn takes exactly the same hold-back
         * decision as one released mid-stream — rather than bypassing it and
         * emitting a lone fragment of text that the hold-back is withholding the
         * rest of. (S4-b d4cba87)
         */
        const emitSplitContent = ({ thinking, text }: ThinkSplit): void => {
          if (thinking) {
            writer.append(writer.openThinking(), thinking);
          }
          if (!text) return;

          // Accumulate text for potential tool call extraction
          state.accumulatedText += text;

          // Check if text contains STRUCTURED tool call patterns that we should hold back
          // Only hold back for patterns we can actually parse (XML, JSON), not natural language
          // Natural language patterns are extracted at finalization, not held back
          const hasStructuredToolPattern =
            // Qwen XML-style: <function=ToolName>. Same shape the
            // extractor accepts, so text held back here is always text
            // the extractor can act on. A looser test here withheld
            // text that nothing later emitted.
            hasExtractableFunctionTag(state.accumulatedText) ||
            // JSON tool call in text: {"name": "Task", "arguments":
            /\{\s*"(?:name|tool)"\s*:\s*"(?:Task|Read|Write|Edit|Bash|Grep|Glob)"/i.test(
              state.accumulatedText
            ) ||
            // XML tool_call tags: <tool_call>
            /<tool_call>/.test(state.accumulatedText);

          // Only hold back if we have a structured pattern AND haven't accumulated too much
          // (if we've accumulated > 1000 chars without a complete pattern, release the text)
          const shouldHoldBack = hasStructuredToolPattern && state.accumulatedText.length < 1000;

          if (shouldHoldBack) {
            log(
              `[Streaming] Text held back (structured tool pattern): ${state.accumulatedText.length} chars accumulated`
            );
            return;
          }

          writer.append(writer.openText(), text);
        };

        // Emit a synthetic WebSearch tool_use block. Used to remap provider
        // web search calls (web_search tool calls, GLM <searchWeb> tags) to
        // the client's own WebSearch tool so the agentic loop continues
        // (stop_reason "tool_use") instead of ending the turn on raw results.
        const emitWebSearchToolUse = (query: string, t?: ToolState) => {
          const blockIndex = t?.blockIndex ?? writer.reserve();
          const id = t?.id ?? `tool_websearch_${Date.now()}_${blockIndex}`;
          const ref = writer.openTool({ id, name: "WebSearch", index: blockIndex });
          writer.append(ref, JSON.stringify({ query }));
          writer.close(ref);
          if (t) {
            t.ref = ref;
            t.started = true;
            t.closed = true;
          } else {
            // Register so hasStructuredTools counts it → stop_reason "tool_use".
            // Negative key avoids collisions with provider tool_call indices.
            state.tools.set(-(blockIndex + 1), {
              id,
              name: "WebSearch",
              blockIndex,
              started: true,
              closed: true,
              suppressed: false,
              remapped: true,
              arguments: JSON.stringify({ query }),
              buffered: false,
              ref,
            });
          }
          log(`[Stream] Remapped provider web search → WebSearch tool_use (query="${query}")`);
        };

        send("message_start", {
          type: "message_start",
          message: {
            id: msgId,
            type: "message",
            role: "assistant",
            content: [],
            model: target,
            stop_reason: null,
            stop_sequence: null,
            usage: messageStartUsage(priorInputTokens),
          },
        });
        send("ping", { type: "ping" });

        ping = setInterval(() => {
          if (!isClosed && Date.now() - state.lastActivity > 1000) {
            send("ping", { type: "ping" });
          }
        }, 1000);

        const finalize = async (reason: string, err?: string) => {
          if (state.finalized) return;
          state.finalized = true;
          // Hang-guard: the body below performs awaits and send()s that can throw
          // (a controller errored by a client-disconnect race, a callback failure).
          // If a throw escaped, the outer read-loop catch would re-call finalize() —
          // now a no-op (finalized=true) — leaving the stream with no message_stop
          // and a leaked ping interval: a hung HTTP 200 the client reports as "empty
          // or malformed response", and an agent blocked forever (the worst proxy
          // failure mode). The try/catch/finally GUARANTEES terminal events +
          // controller.close() + clearInterval(ping) on every exit path.
          let terminalSent = false;
          let toolCount = 0;
          try {
          toolCount = Array.from(state.tools.values()).filter(t => t.started && !t.suppressed).length;
          log(`[Stream] reason=${reason} model=${target} blocks=${writer.anyBlockEmitted} tools=${toolCount} text_len=${state.accumulatedText.length} err=${err ?? "none"}`);
          logStderr(`[Stream] ${target} ${reason} text_len=${state.accumulatedText.length} tools=${toolCount}`);

          // FIRST, before anything reads `accumulatedText`: release whatever
          // the think-splitter still holds (an undecided head, a partial close
          // tag, an unterminated `<think>`). It routes through
          // `emitSplitContent`, so a released fragment takes the same
          // hold-back decision as one released mid-stream, and text recovery
          // below scans the complete text. (S4-b d4cba87)
          emitSplitContent(thinkSplitter.flush());

          // Argument fragments whose `function.name` never arrived (S4-b
          // baf19ef). A call with no name is not a call — nothing to dispatch
          // and no schema to validate against — so they are discarded. Named
          // in the log because silently dropping them is precisely the defect
          // the pending buffer fixes, and a buffer that survives to here means
          // the provider is doing something the accumulator did not
          // anticipate. "error" carries this to the always-on structural log.
          for (const [idx, pending] of state.pendingToolArgs) {
            log(
              `[Streaming] Tool argument error: discarding ${pending.length} buffered chars for tool_calls index ${idx} — function.name never arrived`
            );
          }
          state.pendingToolArgs.clear();

          // Debug: Log accumulated text for analysis
          if (state.accumulatedText.length > 0) {
            const preview = state.accumulatedText.slice(0, 500).replace(/\n/g, "\\n");
            log(
              `[Streaming] Accumulated text (${state.accumulatedText.length} chars): ${preview}...`
            );
          }

          // Check for text-based web search tags (GLM emits <searchWeb><query>...</query></searchWeb>)
          // These must be intercepted before text-based tool call extraction, since we want to
          // execute SearXNG and replace the search tags with results, not pass them through.
          let searchWebResults: string | null = null;
          let pendingSearchRemap: string | null = null;
          let cleanedText = state.accumulatedText;
          const searchWebMatch = state.accumulatedText.match(/<searchWeb>\s*<query>([\s\S]*?)<\/query>\s*<\/searchWeb>/i);
          if (searchWebMatch) {
            const searchQuery = searchWebMatch[1].trim();
            if (searchQuery && clientDeclaresWebSearch(toolSchemas)) {
              // Remap to the client's WebSearch tool — emitted as a tool_use
              // block after the text blocks close, keeping the agent loop alive.
              log(`[Stream] GLM searchWeb detected: "${searchQuery}" — remapping to client WebSearch tool_use`);
              pendingSearchRemap = searchQuery;
            } else {
              log(`[Stream] GLM searchWeb detected: "${searchQuery}" — intercepting via SearXNG`);
              if (searchQuery && SEARXNG_AVAILABLE) {
                searchWebResults = await executeWebSearch(searchQuery);
              } else {
                searchWebResults = searchQuery
                  ? `[Web search for "${searchQuery}" could not be executed. SearXNG is not configured.]`
                  : `[Web search was requested but no query was provided.]`;
              }
            }
            // Remove the search tags from accumulated text so they don't appear in output
            cleanedText = state.accumulatedText.replace(/<searchWeb>[\s\S]*?<\/searchWeb>/i, "").trim();
            state.accumulatedText = cleanedText;
          }

          // Check for text-based tool calls before finalizing
          // Some models (like Qwen) output tool calls as text instead of structured tool_calls
          // Only when the model produced NO structured call (S4-b e82c315).
          // Recovery exists for models that cannot emit `tool_calls` at all;
          // against a model that just did, it can only ADD calls, never repair
          // one. Ungated, a turn holding one real call plus prose mentioning a
          // function tag dispatched two tool_use blocks, and both were
          // recorded. The advertised-name list holds every pattern to the
          // request's own tools; the decode fn maps wire names back to the
          // client's originals (2e18042 parser half).
          const textToolCalls =
            state.tools.size > 0
              ? []
              : extractToolCallsFromText(
                  state.accumulatedText,
                  toolSchemas?.map((t: any) => t?.name).filter((n: any): n is string => !!n),
                  toolNameMap ? (name: string) => toolNameMap.get(name) ?? name : undefined
                );
          if (state.tools.size > 0 && state.accumulatedText.length > 0) {
            log(
              `[Streaming] Skipping text-based tool extraction: ${state.tools.size} structured tool call(s) already present`
            );
          }
          log(`[Streaming] Text-based tool calls found: ${textToolCalls.length}`);

          // ── Ending classification (S4-b c1b907f) ──────────────────────────
          // `finish_reason` is the ONLY completion signal — neither `[DONE]`
          // nor a final usage frame counts; both are transport punctuation. A
          // turn that ends with NO finish_reason while tool content is in
          // flight (structured fragments or a text-recovered call — recovery
          // runs above and counts as content AND as a tool) was CUT mid-call:
          // dispatching the call would ship an action the model never finished
          // specifying. That is a FAILURE ending. Plain text on a
          // finish_reason-less turn degrades to max_tokens below (silent
          // truncation — visible, labeled by its stop_reason, never an error).
          const toolsInFlight = state.tools.size > 0 || textToolCalls.length > 0;
          const failedEnding =
            reason === "error" ||
            (state.lastFinishReason == null && toolsInFlight);
          if (failedEnding && state.lastFinishReason == null) {
            log(
              `[Stream] Unexplained ending: finish_reason never arrived with ${state.tools.size} structured tool(s) and ${textToolCalls.length} recovered call(s) in flight — suppressing dispatch, labeling the turn`
            );
            logStderr(
              `[Stream] UNEXPLAINED ENDING from ${target} — no finish_reason with tool content in flight; failure lane`
            );
          }
          if (failedEnding && textToolCalls.length > 0) {
            log(
              `[Streaming] Suppressing ${textToolCalls.length} text-recovered tool call(s): the turn failed before completion`
            );
          }

          if (textToolCalls.length > 0 && !failedEnding) {
            log(
              `[Streaming] Found ${textToolCalls.length} text-based tool call(s), converting to structured format`
            );

            // Send each extracted tool call as a proper tool_use block.
            // `openTool` closes whatever is open first, which is where the
            // hand-written "close any open text block" used to live. (S4-b ccca029)
            for (const tc of textToolCalls) {
              const toolIdx = writer.reserve();
              const toolId = `tool_${Date.now()}_${toolIdx}`;
              const ref = writer.openTool({ id: toolId, name: tc.name, index: toolIdx });
              writer.append(ref, JSON.stringify(tc.arguments));
              writer.close(ref);
            }
          }

          // GLM <searchWeb> remapped to the client's WebSearch tool —
          // emitted as a tool_use block so stop_reason becomes "tool_use".
          // Suppressed on a failure ending: no NEW tool block leaves a failed
          // turn (S4-b c1b907f).
          if (pendingSearchRemap && !failedEnding) {
            emitWebSearchToolUse(pendingSearchRemap);
          }

          // Inject SearXNG results if we intercepted GLM <searchWeb> tags.
          // Sent as a separate text block after the (now-cleaned) model output.
          if (searchWebResults) {
            const ref = writer.openText();
            writer.append(ref, searchWebResults);
            writer.close(ref);
          }

          // Whatever is still open — thinking, text, or a tool — closes here.
          // This replaces the hand-written reasoning-then-text pair, which could
          // only ever close the two kinds it named. (S4-b ccca029)
          writer.closeCurrent();

          // Remapped web search tools that never saw finish_reason="tool_calls"
          // (e.g. the provider ended with "stop") — emit them now so the
          // query isn't silently dropped and stop_reason becomes "tool_use".
          for (const t of Array.from(state.tools.values())) {
            if (t.remapped && !t.closed) {
              const query = extractSearchQuery(t.arguments);
              if (query) {
                emitWebSearchToolUse(query, t);
              } else {
                t.closed = true;
              }
            }
          }

          // Handle buffered-but-unsent structured tool calls.
          // Some models (e.g., Gemini via LiteLLM) send tool calls with finish_reason="stop"
          // instead of "tool_calls", so the normal validation path (line ~695) is never reached.
          // We must send these buffered tools here so Claude Code can execute them.
          // Suppressed on a failure ending: no completed tool call ships with a
          // failed turn (S4-b c1b907f).
          if (failedEnding) {
            const unsent = Array.from(state.tools.values()).filter(
              (t) => !t.closed && t.buffered && !t.started
            );
            if (unsent.length > 0) {
              log(
                `[Streaming] Suppressing buffered flush of ${unsent.length} tool call(s): the turn failed before completion`
              );
              for (const t of unsent) t.closed = true;
            }
          }
          for (const t of Array.from(state.tools.values())) {
            if (!t.closed && t.buffered && !t.started && !failedEnding) {
              if (toolSchemas && toolSchemas.length > 0) {
                const validation = validateToolArguments(
                  t.name,
                  t.arguments,
                  toolSchemas,
                  state.accumulatedText
                );

                if (validation.valid || (validation.repaired && validation.repairedArgs)) {
                  const argsJson = JSON.stringify(
                    validation.repaired ? validation.repairedArgs : validation.parsedArgs
                  );
                  log(
                    `[Streaming] Sending buffered tool call (finish_reason!=tool_calls): ${t.name} with args: ${argsJson}`
                  );
                  t.ref = writer.openTool({ id: t.id, name: t.name, index: t.blockIndex });
                  writer.append(t.ref, argsJson);
                  writer.close(t.ref);
                  t.started = true;
                  t.closed = true;
                } else {
                  log(
                    `[Streaming] Buffered tool call ${t.name} failed validation, skipping: ${validation.missingParams.join(", ")}`
                  );
                  t.closed = true;
                }
              } else {
                // No schemas to validate against — send as-is
                const argsJson = t.arguments || "{}";
                log(
                  `[Streaming] Sending buffered tool call (no validation): ${t.name} with args: ${argsJson}`
                );
                t.ref = writer.openTool({ id: t.id, name: t.name, index: t.blockIndex });
                writer.append(t.ref, argsJson);
                writer.close(t.ref);
                t.started = true;
                t.closed = true;
              }
            }
          }

          // Close any remaining started-but-unclosed tool calls. Under the
          // one-open-block invariant at most one of these is still open; the
          // rest were closed when the block that superseded them opened, and
          // `writer.close` is a no-op for those. (S4-b ccca029)
          for (const t of Array.from(state.tools.values())) {
            if (t.started && !t.closed) {
              if (t.ref) writer.close(t.ref);
              t.closed = true;
            }
          }

          if (middlewareManager) {
            await middlewareManager.afterStreamComplete(target, streamMetadata);
          }

          // Determine whether the stream produced any usable content.
          // `writer.anyBlockEmitted` is monotonic for the whole turn, so it
          // replaces the pre-close snapshot of textStarted/reasoningStarted
          // this used to take (S4-b ccca029).
          const hasStructuredTools = Array.from(state.tools.values()).some((t) => t.started && !t.suppressed);
          // A suppressed web-search tool that reached `closed` emitted its SearXNG
          // result as a real text block (see the suppression path) — that IS content,
          // even though the tool is suppressed and never set textStarted. Likewise the
          // GLM <searchWeb> SearXNG injection. Counting these prevents a spurious
          // "[Error: empty response]" being appended after valid search results.
          const hasSuppressedWebText = Array.from(state.tools.values()).some((t) => t.suppressed && t.closed);
          const hasContent =
            writer.anyBlockEmitted ||
            state.accumulatedText.length > 0 ||
            hasStructuredTools ||
            textToolCalls.length > 0 ||
            hasSuppressedWebText ||
            searchWebResults !== null;

          if (reason === "error" || failedEnding) {
            // Socket close, network error, other fetch failure mid-stream — or
            // an unexplained ending: finish_reason never arrived while tool
            // content was in flight (S4-b c1b907f).
            // Previously we sent event: error, but Claude Code surfaces raw SSE error
            // events as "API Error: <message>" without closing the turn cleanly.
            // Instead, close any open blocks and inject the error as a text block
            // so the turn ends gracefully with end_turn.
            // INTENDED DIVERGENCE FROM UPSTREAM (ai-01 arbitration, corpus-settled):
            // upstream's failure ending emits a bare SSE `error` event. This fork
            // delivers the failure through this labeled text-block lane instead —
            // 1017 resp-*.sse captures on our wire carry ZERO `event: error`
            // frames, and the never-hang invariant is "every terminating path
            // ends with message_stop after a well-formed turn".
            log(`[Stream] Stream error from ${target}: ${err}`);
            logStderr(`[Stream] Stream error from ${target}: ${err?.substring(0, 120)}`);

            // Inject error as a text block (or replace if no content was produced).
            // `openText` closes whatever block is still open — thinking, text, or
            // a tool — which is where the hand-written close pair used to live.
            const isSocketClose = /socket.*closed|connection was closed|ECONNRESET/i.test(err || "");
            const errorNotice =
              reason !== "error"
                ? `[Upstream stream ended without a finish_reason while a tool call was in flight — the turn was cut and no tool was dispatched. This is usually temporary — please retry.]`
                : isSocketClose
                  ? `[The connection to the model provider was interrupted. This is usually temporary — please retry.]`
                  : `[Upstream stream error: ${(err || "unknown").substring(0, 200)}]`;
            const errorRef = writer.openText();
            writer.append(errorRef, errorNotice);
            writer.close(errorRef);

            send("message_delta", {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: toAnthropicUsage(state.usage),
            });
            send("message_stop", { type: "message_stop" });
            terminalSent = true;
          } else {
            // Ensure at least one content block exists — some providers (z.ai, GLM)
            // return empty responses (finish_reason without content). The Anthropic
            // SDK treats messages with content:[] as malformed.
            if (!hasContent) {
              // Inject a text content block with the error message.
              // Previously we sent event: error, but Claude Code does not handle
              // raw error events in-stream — it reports "empty or malformed response".
              // A content block with the error text is properly parsed and surfaced.
              //
              // Cause classification (was: always blamed "context too large"):
              //   - finish_reason "length"        → genuine context/max_tokens overflow → compact
              //   - finish_reason "content_filter"→ provider content filter → not a context issue
              //   - otherwise (stop/null)         → almost always transient (provider load /
              //                                       momentary rate limit) → RETRY, do NOT compact
              // The old blanket "compact" message pushed agents into a destructive /compact on
              // transient empties (the majority — sub-agents with tiny contexts), discarding
              // context mid-task. Lead with "transient, retry"; mention compact only when the
              // cause is actually length/overflow.
              const fr = state.lastFinishReason;
              const promptTokens = state.usage?.prompt_tokens ?? 0;
              const isOverflow = fr === "length" || promptTokens > 100_000;
              const emptyMsg =
                fr === "content_filter"
                  ? `The model's response was filtered by the provider's content policy. This is usually transient — please retry, or rephrase the request.`
                  : isOverflow
                    ? `The model returned an empty response and the conversation context is very large (finish_reason: ${fr || "stop"}, ~${promptTokens} input tokens). Try /compact to reduce the context size, or retry.`
                    : `The model returned an empty response (finish_reason: ${fr || "stop"}). This is usually transient — a momentary provider load or rate limit, NOT a context-size problem. Please retry. If it recurs repeatedly, then try /compact.`;
              const blockIdx = writer.reserve();
              const noticeRef = writer.openText({ index: blockIdx });
              writer.append(noticeRef, `[Error: ${emptyMsg}]`);
              writer.close(noticeRef);
              const cls = fr === "content_filter" ? "content-filter" : isOverflow ? "overflow" : "transient";
              logStderr(
                `[Stream] EMPTY RESPONSE from ${target} — finish_reason=${fr || "null"} prompt_tokens=${promptTokens} → ${cls} (injected ${cls} message)`
              );
              log(
                `[Stream] Empty response from provider (finish_reason=${fr || "null"}, prompt_tokens=${promptTokens}) — classified as ${cls}, injected guidance`
              );
            }

            // Set stop_reason based on whether we sent ANY tool calls (text-based or structured)
            //
            // A turn the PROVIDER cut off must not be reported as a turn the
            // model chose to end (S4-b 92b72cb). Anthropic's contract for a
            // cut-off turn is "max_tokens"; reporting "end_turn" presents a
            // truncated (or, when reasoning consumed the whole budget, an
            // EMPTY) answer as the model's complete final word.
            // `content_filter` is the same class: the provider refused, which
            // is Anthropic's "refusal". Both OUTRANK tool_use — a truncated
            // tool call must not be dispatched as a complete one.
            // A finish_reason-less turn that DID produce text is the same
            // silent truncation (S4-b c1b907f): [DONE] and the final usage
            // frame are transport punctuation, not completion. Tool content on
            // such a turn never reaches here — it took the failure lane above.
            // A turn that produced NOTHING and ended with nothing is a plain
            // success: the empty-response notice above already covers the
            // empty content array.
            const truncated =
              state.lastFinishReason === "length" ||
              (state.lastFinishReason == null && hasContent);
            const refused = state.lastFinishReason === "content_filter";
            const stopReason = refused
              ? "refusal"
              : truncated
                ? "max_tokens"
                : textToolCalls.length > 0 || hasStructuredTools
                  ? "tool_use"
                  : "end_turn";
            if (truncated || refused) {
              log(
                `[Streaming] Upstream finish_reason=${state.lastFinishReason} → stop_reason=${stopReason} (${state.accumulatedText.length} chars produced)`
              );
            }

            // A successful turn is never contentless (S4-b edd4ce9):
            // `end_turn` with an empty content array is not a shape
            // Anthropic's API produces. The guard fires only on end_turn —
            // the one value that excludes every case where emptiness is
            // MEANINGFUL (max_tokens, refusal, tool_use). An EMPTY text
            // block, not placeholder prose and not an error: prose would
            // enter history as the assistant's words, an error would trip
            // the client's retry on a deterministic outcome. In this fork
            // the gap it closes is specific: text held back pending a
            // structured tool pattern that never completed counts as
            // "content" for the empty-response notice above
            // (accumulatedText > 0) but emitted no block.
            if (stopReason === "end_turn" && !writer.anyBlockEmitted) {
              const guardRef = writer.openText();
              writer.close(guardRef);
              log(
                `[Stream] Contentless end_turn — emitting an empty text block (${state.accumulatedText.length} chars were accumulated but never emitted)`
              );
            }

            send("message_delta", {
              type: "message_delta",
              delta: { stop_reason: stopReason, stop_sequence: null },
              usage: toAnthropicUsage(state.usage),
            });
            send("message_stop", { type: "message_stop" });
            terminalSent = true;
          }

          // Update token counts - use actual usage if available, otherwise estimate
          if (onTokenUpdate) {
            if (state.usage) {
              log(
                `[Streaming] Final usage: prompt=${state.usage.prompt_tokens || 0}, completion=${state.usage.completion_tokens || 0}`
              );
              const costSplit = splitPromptTokens(state.usage);
              onTokenUpdate(state.usage.prompt_tokens || 0, state.usage.completion_tokens || 0, {
                cacheReadTokens: costSplit.cacheReadTokens,
                cacheCreationTokens: costSplit.cacheCreationTokens,
              });
            } else {
              // Estimate tokens for local models that don't return usage data
              // Rough estimate: ~4 characters per token
              const estimatedOutputTokens = Math.ceil(state.accumulatedText.length / 4);
              log(
                `[Streaming] No usage data from provider, estimating: ~${estimatedOutputTokens} output tokens`
              );
              // Carry the previous context size forward rather than a literal
              // 0 (S4-b ae8c07f) — the status line reads this value, and 0
              // would make the bar collapse to "empty" on any turn the
              // provider skips usage.
              onTokenUpdate(priorInputTokens || 100, estimatedOutputTokens);
            }
          }

          } catch (finalizeErr) {
            // finalize() body threw before completing (controller enqueue raced a
            // disconnect, a callback failed, etc.). Force terminal events so the
            // client never hangs on an un-terminated 200.
            logStderr(
              `[Stream] finalize() threw for ${target}: ${String(finalizeErr).slice(0, 160)} — forcing terminal events`
            );
            if (!terminalSent) {
              try {
                send("message_delta", {
                  type: "message_delta",
                  delta: { stop_reason: "end_turn", stop_sequence: null },
                  usage: toAnthropicUsage(state.usage),
                });
                send("message_stop", { type: "message_stop" });
                terminalSent = true;
              } catch {}
            }
          } finally {
            // ALWAYS terminate the HTTP stream and free the ping timer, on every
            // exit path (success, empty, error, or a throw inside finalize).
            if (!isClosed) {
              try {
                controller.enqueue(encoder.encode("data: [DONE]\n\n\n"));
              } catch {}
              try {
                controller.close();
              } catch {}
              isClosed = true;
              if (ping) clearInterval(ping);
              try {
                cap.note(`close reason=${reason}`);
                cap.done({ closed: true, reason, tools: toolCount, text_len: state.accumulatedText.length, err: err ?? null });
              } catch {}
            }
          }
        };

        try {
          let reader = response.body!.getReader();
          let buffer = "";

          // invalid_prompt-class transparent retry state (#65): the flag is
          // probabilistic, the identical body usually passes on a plain retry.
          // Bounded at two fast attempts, only while NOTHING client-visible
          // has been emitted (no text/reasoning/tool block ever started).
          let policyRetryAttempts = 0;
          const policyRetryBackoff = retryOpts?.retryBackoffMs ?? POLICY_RETRY_BACKOFF_MS;

          // A transparent retry swaps the upstream reader and restarts here.
          readLoop: while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (!line.trim() || !line.startsWith("data: ")) continue;
              const dataStr = line.slice(6);
              if (!ttftLogged) {
                ttftLogged = true;
                const firstEventMs = Math.round(performance.now() - tHeaders);
                const hdr = headerLatencyMs ?? -1;
                process.stdout.write(
                  `  [ttft] openai model=${target} reqN=${reqN} headers=${hdr}ms firstEvent=${firstEventMs}ms total=${hdr >= 0 ? hdr + firstEventMs : -1}ms\n`
                );
              }
              // Verbatim: this line IS the fixture source (see SSE_LOG_MAX_CHARS, S4-b 333026b).
              log(`[SSE:openai] ${formatRawSseLogPayload(dataStr)}`);
              if (dataStr === "[DONE]") {
                await finalize("done");
                return;
              }

              try {
                const chunk = JSON.parse(dataStr);

                // ── In-stream policy refusal (#65) ─────────────────────────
                // OpenAI-compat providers can deliver the error INSIDE a 200
                // SSE stream as a `{"error":{...}}` chunk. Before this branch,
                // such a chunk matched neither `usage` nor `choices` and was
                // silently dropped — the stream then ended as an unexplained
                // "empty response". An invalid_prompt-class refusal gets the
                // arbitrated treatment: bounded transparent retry of the
                // identical body, then a labeled well-formed terminal turn.
                if (chunk.error) {
                  const errCode = chunk.error.code || "";
                  const errMsg = chunk.error.message || JSON.stringify(chunk.error);
                  if (isPolicyRefusal(errCode, errMsg)) {
                    const nothingVisible =
                      !writer.anyBlockEmitted &&
                      state.accumulatedText.length === 0 &&
                      state.tools.size === 0;
                    const canRetry =
                      !!retryOpts?.retryUpstream &&
                      policyRetryAttempts < policyRetryBackoff.length &&
                      nothingVisible;
                    logPolicyRefusal({
                      lane: "openai",
                      model: target,
                      provider: retryOpts?.providerName,
                      attempt: policyRetryAttempts + 1,
                      action: canRetry ? "retry" : "surface",
                    });
                    if (canRetry) {
                      policyRetryAttempts++;
                      const backoffMs =
                        policyRetryBackoff[policyRetryAttempts - 1] +
                        Math.floor(Math.random() * 1_000);
                      log(
                        `[OpenAISSE] invalid_prompt before any client-visible block — transparent retry ${policyRetryAttempts}/${policyRetryBackoff.length} in ${backoffMs}ms (reqN=${reqN})`,
                        true
                      );
                      await new Promise((resolve) => setTimeout(resolve, backoffMs));
                      let retryResp: Response | null = null;
                      try {
                        retryResp = await retryOpts!.retryUpstream!();
                      } catch {
                        // retry fetch failed — fall through to surface
                      }
                      if (retryResp?.ok && retryResp.body) {
                        try {
                          await reader.cancel();
                        } catch {
                          // old upstream body — best-effort release
                        }
                        reader = retryResp.body.getReader();
                        buffer = "";
                        decoder = new TextDecoder();
                        continue readLoop;
                      }
                    }
                    // Persistent (or already visible content) — surface as a
                    // labeled, well-formed terminal turn. Never a bare refusal.
                    log(
                      `[OpenAISSE] policy refusal surfaced model=${target} reqN=${reqN} code=${errCode}`,
                      true
                    );
                    const refusalRef = writer.openText();
                    writer.append(refusalRef, policyRefusalNotice(errMsg));
                    writer.close(refusalRef);
                    send("message_delta", {
                      type: "message_delta",
                      delta: { stop_reason: "end_turn", stop_sequence: null },
                      usage: toAnthropicUsage(state.usage),
                    });
                    send("message_stop", { type: "message_stop" });
                    isClosed = true;
                    if (ping) clearInterval(ping);
                    if (onTokenUpdate) {
                      onTokenUpdate(
                        state.usage?.prompt_tokens || 0,
                        state.usage?.completion_tokens || 0,
                        {
                          cacheReadTokens: splitPromptTokens(state.usage).cacheReadTokens,
                          cacheCreationTokens: splitPromptTokens(state.usage).cacheCreationTokens,
                        }
                      );
                    }
                    try {
                      cap.note("policy-refusal->surface");
                      cap.done({
                        closed: true,
                        reason: "policy-refusal",
                        tools: 0,
                        text_len: state.accumulatedText.length,
                        err: `invalid_prompt: ${errMsg.slice(0, 120)}`,
                      });
                    } catch {}
                    try {
                      controller.close();
                    } catch {
                      // already closed
                    }
                    return;
                  }
                  // Non-policy in-stream error (S4-b 321c2f0): surface it.
                  // OpenRouter-shaped frames carry an empty `choices` array,
                  // so every field the parser reads is undefined and the frame
                  // matched nothing — dropped without a log line, the turn
                  // read as a model with nothing to say while the tokens it
                  // spent were already billed. Checked AFTER `usage` (a frame
                  // can carry both) so the tokens the turn already spent are
                  // still reported. finalize("error", …) injects our labeled
                  // text-block lane — never a bare, never a hang.
                  if (chunk.usage) {
                    state.usage = chunk.usage;
                  }
                  const inStreamError = describeInStreamError(chunk);
                  if (inStreamError) {
                    log(`[Streaming] Upstream error inside a 200 stream: ${inStreamError}`);
                    await finalize("error", inStreamError);
                    return;
                  }
                }

                if (chunk.usage) {
                  state.usage = chunk.usage;
                  log(
                    `[Streaming] Usage data received: prompt=${chunk.usage.prompt_tokens}, completion=${chunk.usage.completion_tokens}, total=${chunk.usage.total_tokens}`
                  );
                }

                const delta = chunk.choices?.[0]?.delta;
                const finishReason = chunk.choices?.[0]?.finish_reason;

                // Track the last non-null finish_reason so the empty-response
                // fallback (finalize) can diagnose the cause instead of guessing
                // "context overflow" for every empty response.
                if (finishReason) {
                  state.lastFinishReason = finishReason;
                }

                // Debug: Log chunk details for troubleshooting early termination
                if (delta?.content || finishReason) {
                  log(
                    `[Streaming] Chunk: content=${delta?.content?.length || 0} chars, finish_reason=${finishReason || "null"}`
                  );
                }

                if (delta) {
                  if (middlewareManager) {
                    await middlewareManager.afterStreamChunk({
                      modelId: target,
                      chunk,
                      delta,
                      metadata: streamMetadata,
                    });
                  }

                  // Handle reasoning_content (Kimi, DeepSeek thinking models via
                  // LiteLLM) and `reasoning` — the same stream under a different
                  // field name, emitted by vLLM's reasoning parser and OpenRouter.
                  // Dropping it made the vllm qwen3.6 lane bill ~98% thinking
                  // tokens that never reached the client (measured 2026-08-25:
                  // 241 completion tokens on "Reponds exactement: ok", 899 chars
                  // of reasoning, 4 chars of visible text).
                  const reasoning = delta.reasoning_content ?? delta.reasoning;
                  if (reasoning) {
                    state.lastActivity = Date.now();
                    // Real reasoning on its own field: this provider is not also
                    // speaking in `<think>` tags, so a `<think>` in its content
                    // is a model writing ABOUT tags — the open tag must not fire.
                    // The close tag stays armed: that is what strips a leaked
                    // `</think>` from the head of the content here. (S4-b d4cba87)
                    thinkSplitter.disarmOpen();
                    // Reasoning arriving AFTER text used to open a thinking
                    // block while the text block was still open — two open
                    // blocks, which Anthropic's wire does not allow.
                    // `openThinking` closes the text block first. That
                    // difference is the point of the BlockWriter. (S4-b ccca029)
                    writer.append(writer.openThinking(), reasoning);
                  }

                  // Handle text content
                  const txt = delta.content || "";
                  log(
                    `[Streaming] Text chunk: "${txt.substring(0, 30).replace(/\n/g, "\\n")}" (${txt.length} chars)`
                  );
                  if (txt) {
                    state.lastActivity = Date.now();
                    // The thinking block is NOT closed here any more: it closes
                    // when `writer.openText()` actually runs below. A chunk that
                    // the adapter empties, or that is held back pending a tool
                    // pattern, no longer ends the thinking block on the strength
                    // of text that never reaches the client. (S4-b ccca029)
                    const res = adapter.processTextContent(txt, "");
                    log(
                      `[Streaming] After adapter: "${res.cleanedText.substring(0, 30).replace(/\n/g, "\\n")}" (${res.cleanedText.length} chars, transformed=${res.wasTransformed})`
                    );

                    // Debug: Log text processing
                    if (txt.length > 0 && res.cleanedText.length === 0) {
                      log(`[Streaming] Text filtered out by adapter: "${txt.substring(0, 50)}"`);
                    }

                    if (res.cleanedText) {
                      // Through the splitter: content carrying `<think>…</think>`
                      // is split into a thinking block and a text block (S4-b
                      // d4cba87); everything else takes the same accumulate /
                      // hold-back / emit path as before.
                      emitSplitContent(thinkSplitter.push(res.cleanedText));
                    }
                  }

                  // Handle tool calls
                  if (delta.tool_calls) {
                    log(
                      `[Streaming] Received ${delta.tool_calls.length} structured tool call(s) from model`
                    );
                    for (const tc of delta.tool_calls) {
                      const idx = tc.index;
                      let t = state.tools.get(idx);
                      if (tc.function?.name) {
                        // Accumulate the name BEFORE anything reads it (S4-b
                        // baf19ef): a provider may split `function.name`
                        // across chunks, and this is the one place a complete
                        // name exists. Decoding a fragment misses the
                        // truncated-name map, and the call is then dropped in
                        // silence.
                        const accumulatedName =
                          (state.pendingToolName.get(idx) ?? "") + tc.function.name;
                        state.pendingToolName.set(idx, accumulatedName);
                        // THIS IS THE DECODE POINT: it reads the accumulated
                        // name, never a single chunk's fragment (S4-b baf19ef).
                        const rawName = accumulatedName;
                        const restoredName = toolNameMap?.get(rawName) || rawName;
                        if (!t) {
                          // The hand-written "close thinking, then close text"
                          // pair that used to stand here is `openTool`'s job now.
                          // (S4-b ccca029)
                          // Restore truncated tool name to original if mapping exists.
                          const isWebSearch = isWebSearchToolCall(restoredName);
                          const remapToWebSearch = isWebSearch && clientDeclaresWebSearch(toolSchemas);
                          if (isWebSearch) {
                            log(`[Stream] Web search tool call detected: "${restoredName}" — ${remapToWebSearch ? "remapping to client WebSearch tool_use" : `intercepting via SearXNG (available=${SEARXNG_AVAILABLE})`}`);
                          }
                          t = {
                            id: tc.id || `tool_${Date.now()}_${idx}`,
                            name: restoredName,
                            // Reserved, not opened: a buffered tool keeps its place
                            // in the index order and emits at finish_reason time.
                            blockIndex: writer.reserve(),
                            started: false,
                            closed: false,
                            suppressed: isWebSearch && !remapToWebSearch,
                            remapped: remapToWebSearch,
                            arguments: "", // Initialize arguments accumulator
                            ref: null,
                            // Buffer if we have schemas to validate, OR if a behavior
                            // rule wants to rewrite this call — repair is only
                            // possible while the arguments are still withheld.
                            buffered: !!toolSchemas && toolSchemas.length > 0 && !isWebSearch,
                          };
                          // Seeded, not empty (S4-b baf19ef): fragments that
                          // arrived for this index before the name did are
                          // drained in here.
                          t.arguments = state.pendingToolArgs.get(idx) ?? "";
                          if (t.arguments) {
                            log(
                              `[Streaming] tool ${t.name} (index ${idx}): seeded ${t.arguments.length} argument chars that arrived before function.name`
                            );
                          }
                          state.pendingToolArgs.delete(idx);
                          state.tools.set(idx, t);
                        } else if (t.name !== restoredName) {
                          // A LATER fragment completed the name (S4-b 2e18042
                          // parser half). The tool was created from the first
                          // fragment, so its name is a prefix — and a prefix of
                          // a wire-encoded name decodes to nothing, which is
                          // how a call gets dropped without a word anywhere.
                          if (t.started) {
                            // The block is already on the wire under the short
                            // name; it cannot be recalled. "error" is deliberate
                            // — it is what carries this to the structural log.
                            log(
                              `[Streaming] error: tool block ${t.blockIndex} was started as "${t.name}" but the full name is "${restoredName}" — the client sees the wrong name`
                            );
                          } else {
                            t.name = restoredName;
                            t.buffered = !!toolSchemas && toolSchemas.length > 0 && !t.remapped;
                            if (isWebSearchToolCall(restoredName)) {
                              log(
                                `[Stream] Web search tool call detected: "${restoredName}" — name completed by a later fragment, re-evaluated at the decode point`
                              );
                            }
                          }
                        }
                        // Only send content_block_start immediately if NOT buffering.
                        // Suppressed and remapped tools never stream their blocks live.
                        if (!t.started && !t.buffered && !t.suppressed && !t.remapped) {
                          t.ref = writer.openTool({
                            id: t.id,
                            name: t.name,
                            index: t.blockIndex,
                          });
                          t.started = true;
                          // Flush the seed as ONE delta, right after the start
                          // (S4-b baf19ef). Skipped when the seed is empty —
                          // every capture in the tree — so the common case is
                          // byte-identical.
                          if (t.arguments) {
                            writer.append(t.ref, t.arguments);
                          }
                        }
                      }
                      if (tc.function?.arguments && !t) {
                        // Arguments before the name (S4-b baf19ef). This used
                        // to be dropped by the `&& t` guard below, so the head
                        // of the JSON object vanished and what survived began
                        // mid-object and could not parse — indistinguishable
                        // downstream from a model emitting bad JSON. Hold it
                        // until the name creates the tool.
                        state.pendingToolArgs.set(
                          idx,
                          (state.pendingToolArgs.get(idx) ?? "") + tc.function.arguments
                        );
                      }
                      if (tc.function?.arguments && t) {
                        // Always accumulate arguments — suppressed/remapped tools
                        // need them too (extractSearchQuery reads the query later).
                        t.arguments += tc.function.arguments;
                        // Only stream immediately if NOT buffering/suppressed/remapped
                        if (!t.buffered && !t.suppressed && !t.remapped) {
                          if (!t.ref || !writer.append(t.ref, tc.function.arguments)) {
                            // OpenAI's wire lets `tool_calls[0]` and `tool_calls[1]`
                            // fragments interleave; Anthropic's allows one open
                            // block. So this tool's block is no longer the open one
                            // — something else (another tool, or text) took over and
                            // closed it. Degrade THIS tool to the buffered path: the
                            // complete arguments go out as one block when the call
                            // closes. Same recovery shape the repair path already
                            // uses when it supersedes a partially-streamed block.
                            // (S4-b ccca029)
                            log(
                              `[Streaming] tool ${t.name} (index ${idx}) lost its open block mid-arguments — buffering the rest`
                            );
                            t.buffered = true;
                            t.started = false;
                            t.ref = null;
                            // Divergence from upstream, load-bearing for the very
                            // invariant this migration enforces: the original
                            // blockIndex was SPENT (its block opened and closed
                            // when another superseded it). Flushing at a spent
                            // index would emit a second `content_block_start`
                            // for an index the client already saw. Re-reserve.
                            t.blockIndex = writer.reserve();
                          }
                        }
                      }
                    }
                  }
                }

                if (chunk.choices?.[0]?.finish_reason === "tool_calls") {
                  for (const t of Array.from(state.tools.values())) {
                    if (t.remapped) {
                      if (!t.closed) {
                        const query = extractSearchQuery(t.arguments);
                        if (query) {
                          emitWebSearchToolUse(query, t);
                        } else {
                          // No usable query — degrade to the suppression path
                          // (text injection below) rather than emit a broken tool_use.
                          t.remapped = false;
                          t.suppressed = true;
                        }
                      }
                      if (t.closed) continue;
                    }
                    if (t.suppressed) {
                      // Execute web search via SearXNG and inject results
                      if (!t.closed) {
                        const query = extractSearchQuery(t.arguments);
                        let resultText: string;
                        if (query && SEARXNG_AVAILABLE) {
                          resultText = await executeWebSearch(query);
                        } else {
                          resultText = query
                            ? `[Web search for "${query}" could not be executed. The search service (SearXNG) is not configured. Set SEARXNG_URL env var to enable.]`
                            : `[Web search was requested but no query was provided.]`;
                        }
                        // The suppressed tool never opened its block, so its
                        // reserved index is unspent — the text takes it.
                        const ref = writer.openText({ index: t.blockIndex });
                        writer.append(ref, resultText);
                        writer.close(ref);
                        t.closed = true;
                      }
                      continue;
                    }
                    if (!t.closed) {
                      // Validate and potentially repair tool arguments
                      if (toolSchemas && toolSchemas.length > 0) {
                        const validation = validateToolArguments(
                          t.name,
                          t.arguments,
                          toolSchemas,
                          state.accumulatedText
                        );

                        if (validation.repaired && validation.repairedArgs) {
                          // Tool call was repaired - send the complete repaired arguments
                          log(
                            `[Streaming] Tool call ${t.name} was repaired with inferred parameters`
                          );
                          const repairedJson = JSON.stringify(validation.repairedArgs);
                          log(
                            `[Streaming] Sending repaired tool call: ${t.name} with args: ${repairedJson}`
                          );

                          // If buffered, this is the first time we're sending this tool call
                          // Send the complete repaired tool call as a single block
                          if (t.buffered && !t.started) {
                            t.ref = writer.openTool({
                              id: t.id,
                              name: t.name,
                              index: t.blockIndex,
                            });
                            writer.append(t.ref, repairedJson);
                            writer.close(t.ref);
                            t.started = true;
                            t.closed = true;
                            continue;
                          }

                          // If already started (non-buffered), close old and send new.
                          // This is the one path that mints a SECOND block for a tool
                          // that already has one — the partially-streamed original is
                          // closed and superseded, under a new id. (S4-b ccca029)
                          if (t.started) {
                            if (t.ref) writer.close(t.ref);
                            const repairedIdx = writer.reserve();
                            const repairedId = `tool_repaired_${Date.now()}_${repairedIdx}`;
                            const repairedRef = writer.openTool({
                              id: repairedId,
                              name: t.name,
                              index: repairedIdx,
                            });
                            writer.append(repairedRef, repairedJson);
                            writer.close(repairedRef);
                            t.ref = repairedRef;
                            t.closed = true;
                            continue;
                          }

                          // Non-buffered and never started — emit repaired tool at a new index
                          const fallbackIdx = writer.reserve();
                          const fallbackId = `tool_repaired_${Date.now()}_${fallbackIdx}`;
                          log(
                            `[Streaming] Emitting repaired tool ${t.name} (non-buffered, not started) at fallback index ${fallbackIdx}`
                          );
                          const fallbackRef = writer.openTool({
                            id: fallbackId,
                            name: t.name,
                            index: fallbackIdx,
                          });
                          writer.append(fallbackRef, repairedJson);
                          writer.close(fallbackRef);
                          t.closed = true;
                          continue;
                        }

                        if (!validation.valid) {
                          // Repair failed - send error message instead of invalid tool call
                          log(
                            `[Streaming] Tool call ${t.name} validation failed: ${validation.missingParams.join(", ")}`
                          );
                          // A buffered tool never emitted its block, so its reserved
                          // index is free and the warning text takes it. A
                          // non-buffered one already spent its index on the tool
                          // block, so the warning needs a fresh one.
                          const errorIdx = t.buffered ? t.blockIndex : undefined;
                          const errorMsg = `\n\n⚠️ Tool call "${t.name}" failed: missing required parameters: ${validation.missingParams.join(", ")}. Local models sometimes generate incomplete tool calls. Please try again or use a model with better tool support.`;
                          const errorRef = writer.openText({ index: errorIdx });
                          writer.append(errorRef, errorMsg);
                          writer.close(errorRef);
                          // Close the invalid tool if it was already started.
                          // `openText` above will already have closed it when it was
                          // the open block; this covers the case where it was not.
                          if (t.started && !t.buffered && t.ref) {
                            writer.close(t.ref);
                          }
                          t.closed = true;
                          continue;
                        }

                        // Valid tool call - send if buffered, close if not
                        if (t.buffered && !t.started) {
                          const argsJson = JSON.stringify(validation.parsedArgs);
                          t.ref = writer.openTool({
                            id: t.id,
                            name: t.name,
                            index: t.blockIndex,
                          });
                          writer.append(t.ref, argsJson);
                          writer.close(t.ref);
                          t.started = true;
                          t.closed = true;
                          continue;
                        }
                      }

                      // Non-buffered valid tool call or no validation - just close
                      if (t.started && !t.closed) {
                        if (t.ref) writer.close(t.ref);
                        t.closed = true;
                      }
                    }
                  }
                }
              } catch (e) {
                // NEVER swallow silently (S4-b ea5258c). Everything a chunk
                // would have emitted — a content block, a tool call, the
                // finish_reason — is lost here, and the turn still ends HTTP
                // 200, so the only symptom is a missing block several layers
                // away. The bare `catch {}` this replaces made every such
                // fault undiagnosable from the log. forceConsole, like
                // [PolicyRefusal]: this is an error-class, countable marker,
                // and "error" in the text carries it to the always-on
                // structural log. The payload itself was already logged
                // verbatim above as `[SSE:openai]`, so only a short locator is
                // repeated here.
                log(
                  `[Streaming] Chunk processing error (chunk dropped): ${e} — payload starts: ${dataStr.slice(0, 120)}`,
                  true
                );
              }
            }
          }
          await finalize("unexpected");
        } catch (e) {
          await finalize("error", String(e));
        }
      },
      cancel() {
        isClosed = true;
        if (ping) clearInterval(ping);
      },
    }),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    }
  );
}

/**
 * Estimate token count from text (rough approximation)
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
