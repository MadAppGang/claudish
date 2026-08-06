/**
 * Devin Connect-protobuf stream → Claude SSE.
 *
 * The response is a sequence of Connect envelopes (`[flags:u8][len:u32 BE][payload]`),
 * each carrying a protobuf message. `flags = 2` is the end-of-stream frame and
 * its payload is JSON: `{}` on success, `{"error":{"code","message"}}` on
 * failure.
 *
 * **Errors ride an HTTP 200.** The status code alone NEVER signals failure on
 * this backend, which is why `devin-stream-head-sniffer.ts` exists — it decides
 * retryable-vs-terminal while the status is still ours to choose. By the time
 * this parser runs the head is already clean, so an error frame here is a
 * mid-stream fault: it is reported through `onApiError` and ends the turn as an
 * `error` event rather than a successful `end_turn`.
 *
 * ## Response fields (VERIFIED live — see protocol-spec.md)
 *
 * | # | meaning |
 * |---|---|
 * | 3 | text delta |
 * | 5 | stop_reason (family-specific integer; **can be absent**) |
 * | 6 | tool call — `1` id, `2` name, `3` incremental JSON argument fragments |
 * | 7 | meta — `9` served model uid |
 * | 9 | reasoning / CoT |
 * | 28 | usage, repeated (see below) |
 *
 * Three of those cost real money to get wrong, so they are called out:
 *
 * - **Field 9 is FAMILY-DEPENDENT.** GPT emits reasoning, the Claude family does
 *   not — not even at `-high`. The thinking path must be genuinely optional; it
 *   is never assumed to arrive.
 * - **Field 5 can be ABSENT** (GPT returned none), and a `stop_reason:
 *   undefined` is rejected by Claude Code. The raw value is also family-specific
 *   and undocumented (2 on GLM, 4 on Claude, both meaning ordinary completion),
 *   so mapping it to a table would be exactly the hardcoded per-model data this
 *   project forbids. Rule: any tool_use block emitted → `tool_use`, else
 *   `end_turn`. The raw value is logged alongside the served uid so a future
 *   capture can justify something better.
 * - **Field 28 values are float32 LITTLE-endian** at `28 → 2 → 4 → 2`, selected
 *   by the STRING key at `28 → 2 → 5`. Field 28 is repeated (two groups, order
 *   unspecified) so selection is by key, never by index; an absent value means
 *   zero, not unknown. Measured: LE reads 16185 tokens where BE reads 2.09e-38.
 *
 * Tool arguments stream as fragments (`{"city": "` / `Mel` / `bourne` / `"` /
 * `}`) exactly like OpenAI `function.arguments` deltas, so `input_json_delta` is
 * a 1:1 forwarding rather than a reconstruction.
 */

import type { Context } from "hono";
import { log } from "../../../logger.js";
import {
  FRAME_FLAG_END_OF_STREAM,
  type TLV,
  createFrameReader,
  parseTLV,
  readFloat32LE,
  readString,
  readVarintValue,
} from "../../../providers/devin/proto-codec.js";
import { messageStartUsage } from "./message-start-usage.js";

/** Response field numbers. Protocol constants, not model data. */
const FIELD_TEXT = 3;
const FIELD_STOP_REASON = 5;
const FIELD_TOOL_CALL = 6;
const FIELD_META = 7;
const FIELD_REASONING = 9;
const FIELD_USAGE = 28;

/** Sub-field numbers inside a tool call (field 6). */
const TOOL_ID = 1;
const TOOL_NAME = 2;
const TOOL_ARGS_FRAGMENT = 3;

/** `7 → 9` is the uid the backend actually served. */
const META_SERVED_MODEL = 9;

/** Usage group: `28 → 2` entries, keyed by the string at `→ 5`, valued at `→ 4 → 2`. */
const USAGE_ENTRY = 2;
const USAGE_ENTRY_KEY = 5;
const USAGE_ENTRY_STAT = 4;
const USAGE_STAT_VALUE = 2;

/** Machine-stable usage keys. Anything else in the group is display data. */
const USAGE_KEY_INPUT = "input_tokens";
const USAGE_KEY_OUTPUT = "output_tokens";

export interface DevinConnectOptions {
  modelName: string;
  onTokenUpdate?: (input: number, output: number) => void;
  /** Last request's context size — seeds message_start.usage (see message-start-usage.ts). */
  priorInputTokens?: number;
  /**
   * Fired when an error frame arrives mid-stream (inside the HTTP 200). Lets the
   * caller record the turn as a failure instead of a success.
   */
  onApiError?: (code: string, message: string) => void;
  /** The uid the backend reports serving (field `7.9`), when it differs from the request. */
  onServedModel?: (uid: string) => void;

  // ── Layer 4 — the same five hooks the gemini-sse case passes ──────────────
  /**
   * Behavior-layer tool-call repair. Consulted once per COMPLETED tool call
   * with the fully accumulated argument JSON; return replacement JSON, or
   * null/undefined to leave it untouched.
   *
   * Only reached for tools `shouldBufferTool` opted in — see below.
   */
  repairToolArgs?: (name: string, argsJson: string) => string | null | undefined;
  /**
   * Whether a tool's arguments must be withheld until the call completes.
   *
   * Repair is only POSSIBLE for buffered calls: this backend emits argument
   * fragments the instant they arrive, so by the time a call is complete its
   * arguments are already on the wire. Buffering is therefore opt-in per tool
   * AND per request — outside an armed rule nothing is buffered and streaming is
   * byte-for-byte what it would have been.
   */
  shouldBufferTool?: (name: string) => boolean;
  /** Normalized observation, so rules never have to understand this wire. */
  onAssistantText?: (text: string, kind?: "text" | "reasoning") => void;
  onToolCallObserved?: (name: string) => void;
  onTurnEnd?: () => void;
  /** Restore truncated tool names (Layer 1 may have shortened them). */
  toolNameMap?: Map<string, string>;
}

/** One tool call being streamed. */
interface StreamingToolCall {
  id: string;
  name: string;
  blockIndex: number;
  /** Withhold `input_json_delta` until the call completes so it can be repaired. */
  buffered: boolean;
  /** Accumulated argument JSON (always tracked — cheap, and repair needs it). */
  args: string;
  /** Incremental UTF-8 decoder: a multi-byte char can straddle two fragments. */
  decoder: TextDecoder;
  closed: boolean;
}

export function createDevinConnectStream(
  _c: Context,
  response: Response,
  opts: DevinConnectOptions
): Response {
  const encoder = new TextEncoder();
  let isClosed = false;
  let pingInterval: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: any) => {
        if (!isClosed) {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        }
      };

      const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      let finalized = false;
      let curIdx = 0;
      let textIdx = -1;
      let textStarted = false;
      let thinkingIdx = -1;
      let thinkingStarted = false;
      let inputTokens = 0;
      let outputTokens = 0;
      let sawUsage = false;
      let rawStopReason: number | null = null;
      let servedModel = "";
      let toolBlocksEmitted = 0;
      let current: StreamingToolCall | null = null;
      let lastActivity = Date.now();

      // Separate streaming decoders per channel: a UTF-8 sequence can be split
      // across two deltas, and decoding each payload independently would emit a
      // replacement character. Each channel owns its own carry-over state.
      const textDecoder = new TextDecoder();
      const reasoningDecoder = new TextDecoder();

      send("message_start", {
        type: "message_start",
        message: {
          id: msgId,
          type: "message",
          role: "assistant",
          content: [],
          model: opts.modelName,
          stop_reason: null,
          stop_sequence: null,
          usage: messageStartUsage(opts.priorInputTokens),
        },
      });
      send("ping", { type: "ping" });

      // Devin's time-to-first-token was 2.5s in the capture and is far longer
      // with reasoning, so the keepalive matches the other four parsers.
      pingInterval = setInterval(() => {
        if (!isClosed && Date.now() - lastActivity > 1000) {
          send("ping", { type: "ping" });
        }
      }, 1000);

      const closeThinking = () => {
        if (!thinkingStarted) return;
        send("content_block_stop", { type: "content_block_stop", index: thinkingIdx });
        thinkingStarted = false;
      };
      const closeText = () => {
        if (!textStarted) return;
        send("content_block_stop", { type: "content_block_stop", index: textIdx });
        textStarted = false;
      };

      /** Close the in-flight tool call, repairing + flushing buffered arguments. */
      const closeCurrentTool = () => {
        if (!current || current.closed) return;
        const call = current;
        current = null;

        if (call.buffered) {
          let args = call.args;
          if (opts.repairToolArgs) {
            try {
              const repaired = opts.repairToolArgs(call.name, args);
              if (typeof repaired === "string" && repaired !== args) {
                log(`[DevinConnect] tool call repaired: ${call.name}`);
                args = repaired;
              }
            } catch (err) {
              // A failing rule must never corrupt the stream.
              log(`[DevinConnect] repairToolArgs threw for ${call.name}: ${err}`);
            }
          }
          send("content_block_delta", {
            type: "content_block_delta",
            index: call.blockIndex,
            // An empty argument object is still valid JSON the client can parse;
            // an empty string is not.
            delta: { type: "input_json_delta", partial_json: args || "{}" },
          });
        } else if (!call.args) {
          // A no-argument tool emitted no fragments at all. Claude Code needs a
          // parseable object, so supply the empty one explicitly.
          send("content_block_delta", {
            type: "content_block_delta",
            index: call.blockIndex,
            delta: { type: "input_json_delta", partial_json: "{}" },
          });
        }

        send("content_block_stop", { type: "content_block_stop", index: call.blockIndex });
        call.closed = true;
      };

      const finalize = (reason: "done" | "error", errorMessage?: string) => {
        if (finalized) return;
        finalized = true;

        closeCurrentTool();
        closeThinking();
        closeText();

        if (servedModel && servedModel !== opts.modelName) {
          log(`[DevinConnect] served model: ${servedModel} (requested ${opts.modelName})`);
        }
        if (sawUsage) {
          log(
            `[DevinConnect] usage: input=${inputTokens}, output=${outputTokens}` +
              (rawStopReason !== null ? `, raw stop_reason=${rawStopReason}` : "")
          );
        }

        // Fires exactly once — ComposedHandler hangs its recordStats on it.
        opts.onTokenUpdate?.(inputTokens, outputTokens);

        if (reason === "error") {
          log(`[DevinConnect] stream error: ${errorMessage}`);
          send("error", { type: "error", error: { type: "api_error", message: errorMessage } });
        } else {
          send("message_delta", {
            type: "message_delta",
            delta: {
              // Derived, not mapped — see the module header.
              stop_reason: toolBlocksEmitted > 0 ? "tool_use" : "end_turn",
              stop_sequence: null,
            },
            // input_tokens rides the delta so the client learns the real context
            // size; without it Claude Code keeps message_start's estimate and
            // auto-compaction never arms. See message-start-usage.ts.
            usage: {
              ...(inputTokens > 0 ? { input_tokens: inputTokens } : {}),
              output_tokens: outputTokens,
            },
          });
          opts.onTurnEnd?.();
          send("message_stop", { type: "message_stop" });
        }

        if (!isClosed) {
          isClosed = true;
          if (pingInterval) {
            clearInterval(pingInterval);
            pingInterval = null;
          }
          try {
            controller.close();
          } catch {}
        }
      };

      /** `28` — usage. Repeated; selected by string key, never by group index. */
      const readUsageGroup = (payload: Uint8Array) => {
        for (const entry of parseTLV(payload)) {
          if (entry.no !== USAGE_ENTRY || entry.wire !== 2) continue;
          let key = "";
          let value: number | null = null;
          for (const field of parseTLV(entry.payload)) {
            if (field.no === USAGE_ENTRY_KEY && field.wire === 2) {
              key = readString(field);
            } else if (field.no === USAGE_ENTRY_STAT && field.wire === 2) {
              for (const stat of parseTLV(field.payload)) {
                // wire 5 = fixed32, read LITTLE-endian. An absent field 2 means
                // zero (observed on cached_input_tokens), never "unknown".
                if (stat.no === USAGE_STAT_VALUE && stat.wire === 5) {
                  value = Math.round(readFloat32LE(stat));
                }
              }
            }
          }
          if (key === USAGE_KEY_INPUT) {
            inputTokens = value ?? 0;
            sawUsage = true;
          } else if (key === USAGE_KEY_OUTPUT) {
            outputTokens = value ?? 0;
            sawUsage = true;
          }
        }
      };

      /** `6` — a tool call: either a header (`1` id + `2` name) or a fragment (`3`). */
      const readToolCall = (payload: Uint8Array) => {
        let id = "";
        let name = "";
        let fragment: TLV | null = null;
        for (const field of parseTLV(payload)) {
          if (field.no === TOOL_ID && field.wire === 2) id = readString(field);
          else if (field.no === TOOL_NAME && field.wire === 2) name = readString(field);
          else if (field.no === TOOL_ARGS_FRAGMENT && field.wire === 2) fragment = field;
        }

        if (name) {
          // A new call begins. Close whatever was open — Devin streams calls
          // sequentially, and a block index is never reused.
          closeCurrentTool();
          closeThinking();
          closeText();

          const restored = opts.toolNameMap?.get(name) ?? name;
          const blockIndex = curIdx++;
          const toolId = id || `toolu_${Date.now()}_${blockIndex}`;
          current = {
            id: toolId,
            name: restored,
            blockIndex,
            buffered: opts.shouldBufferTool?.(restored) ?? false,
            args: "",
            decoder: new TextDecoder(),
            closed: false,
          };
          toolBlocksEmitted++;
          opts.onToolCallObserved?.(restored);
          send("content_block_start", {
            type: "content_block_start",
            index: blockIndex,
            content_block: { type: "tool_use", id: toolId, name: restored, input: {} },
          });
        }

        if (!fragment) return;
        // Whole-field decode is not enough: a multi-byte character can straddle
        // two fragments, so the per-call decoder carries the partial sequence.
        const chunk = current
          ? current.decoder.decode(fragment.payload, { stream: true })
          : readString(fragment);
        if (!chunk) return;
        if (!current) {
          // Arguments with no preceding header — nothing to attach them to.
          log("[DevinConnect] argument fragment with no open tool call, dropping");
          return;
        }
        current.args += chunk;
        if (!current.buffered) {
          send("content_block_delta", {
            type: "content_block_delta",
            index: current.blockIndex,
            delta: { type: "input_json_delta", partial_json: chunk },
          });
        }
      };

      /** One protobuf message frame (`flags = 0`). */
      const readMessageFrame = (payload: Uint8Array) => {
        for (const field of parseTLV(payload)) {
          lastActivity = Date.now();

          if (field.no === FIELD_TEXT && field.wire === 2) {
            const text = textDecoder.decode(field.payload, { stream: true });
            if (!text) continue;
            closeCurrentTool();
            closeThinking();
            if (!textStarted) {
              textIdx = curIdx++;
              send("content_block_start", {
                type: "content_block_start",
                index: textIdx,
                content_block: { type: "text", text: "" },
              });
              textStarted = true;
            }
            opts.onAssistantText?.(text, "text");
            send("content_block_delta", {
              type: "content_block_delta",
              index: textIdx,
              delta: { type: "text_delta", text },
            });
          } else if (field.no === FIELD_REASONING && field.wire === 2) {
            // Optional by construction: the Claude family emits no field 9 at
            // any tier, so this block may never open.
            const thinking = reasoningDecoder.decode(field.payload, { stream: true });
            if (!thinking) continue;
            closeCurrentTool();
            if (!thinkingStarted) {
              thinkingIdx = curIdx++;
              send("content_block_start", {
                type: "content_block_start",
                index: thinkingIdx,
                content_block: { type: "thinking", thinking: "" },
              });
              thinkingStarted = true;
            }
            opts.onAssistantText?.(thinking, "reasoning");
            send("content_block_delta", {
              type: "content_block_delta",
              index: thinkingIdx,
              delta: { type: "thinking_delta", thinking },
            });
          } else if (field.no === FIELD_TOOL_CALL && field.wire === 2) {
            readToolCall(field.payload);
          } else if (field.no === FIELD_STOP_REASON && field.wire === 0) {
            // Logged only — the value is family-specific and undocumented.
            rawStopReason = readVarintValue(field);
          } else if (field.no === FIELD_META && field.wire === 2) {
            for (const sub of parseTLV(field.payload)) {
              if (sub.no === META_SERVED_MODEL && sub.wire === 2) {
                const uid = readString(sub);
                if (uid && uid !== servedModel) {
                  servedModel = uid;
                  opts.onServedModel?.(uid);
                }
              }
            }
          } else if (field.no === FIELD_USAGE && field.wire === 2) {
            readUsageGroup(field.payload);
          }
        }
      };

      try {
        const body = response.body;
        if (!body) {
          finalize("error", "Devin returned no response body");
          return;
        }

        const reader = body.getReader();
        const nextFrames = createFrameReader();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;

          for (const frame of nextFrames(value)) {
            if (frame.flags === FRAME_FLAG_END_OF_STREAM) {
              const raw = new TextDecoder().decode(frame.payload).trim();
              if (!raw || raw === "{}") {
                finalize("done");
                return;
              }
              let code = "unknown";
              let message = raw;
              try {
                const parsed = JSON.parse(raw);
                code = String(parsed?.error?.code ?? parsed?.code ?? "unknown");
                message = String(parsed?.error?.message ?? parsed?.message ?? raw);
              } catch {
                // Not JSON — surface the body verbatim rather than inventing one.
              }
              opts.onApiError?.(code, message);
              finalize("error", `${code}: ${message}`);
              return;
            }
            readMessageFrame(frame.payload);
          }
        }

        // The connection ended without an end-of-stream frame. Everything
        // received is still valid output, so close the turn cleanly rather than
        // discarding it.
        finalize("done");
      } catch (e) {
        finalize("error", String(e));
      }
    },
    cancel() {
      isClosed = true;
      if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
      }
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
