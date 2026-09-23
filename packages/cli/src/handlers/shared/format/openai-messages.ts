/**
 * OpenAI message format conversion utilities.
 *
 * Converts Claude/Anthropic message format to OpenAI message format.
 */

import { log } from "../../../logger.js";

/**
 * Convert Claude/Anthropic messages to OpenAI format
 * @param simpleFormat - If true, use simple string content only (for MLX and other basic providers)
 * @param reasoningRoundtrip - If true, emit reasoning_content on EVERY assistant message
 *   (empty string when no thinking block). DeepSeek rejects with HTTP 400 "The reasoning_content
 *   in the thinking mode must be passed back to the API" when a conversation in thinking mode
 *   has recent assistant messages without the field — including tool_use-only turns that never
 *   carried a thinking block. Empty string satisfies the presence check.
 */
export function convertMessagesToOpenAI(
  req: any,
  modelId: string,
  filterIdentityFn?: (s: string) => string,
  simpleFormat = false,
  reasoningRoundtrip = false
): any[] {
  const messages: any[] = [];

  if (req.system) {
    let content = Array.isArray(req.system)
      ? req.system.map((i: any) => i.text || i).join("\n\n")
      : req.system;
    if (filterIdentityFn) content = filterIdentityFn(content);
    messages.push({ role: "system", content });
  }

  // Add instruction for Grok models to use proper tool format
  if (modelId.includes("grok") || modelId.includes("x-ai")) {
    const msg =
      "IMPORTANT: When calling tools, you MUST use the OpenAI tool_calls format with JSON. NEVER use XML format like <xai:function_call>.";
    if (messages.length > 0 && messages[0].role === "system") {
      messages[0].content += "\n\n" + msg;
    } else {
      messages.unshift({ role: "system", content: msg });
    }
  }

  if (req.messages) {
    // An inline system message is HELD rather than emitted, and folds into the
    // NEXT user turn (see the system branch below).
    let pendingInlineSystem: string | null = null;
    const flushInlineSystem = () => {
      if (!pendingInlineSystem) return;
      const content = pendingInlineSystem;
      pendingInlineSystem = null;
      const last = messages[messages.length - 1];
      if (last && last.role === "user" && typeof last.content === "string") {
        last.content += "\n\n" + content;
      } else {
        messages.push({ role: "user", content });
      }
    };

    for (const msg of req.messages) {
      if (msg.role === "user") {
        processUserMessage(msg, messages, simpleFormat, pendingInlineSystem);
        pendingInlineSystem = null;
      } else if (msg.role === "assistant") {
        flushInlineSystem();
        processAssistantMessage(msg, messages, simpleFormat, reasoningRoundtrip);
      } else if (msg.role === "system") {
        // Inline system messages (Claude Code v2.1.153+). One of them carries THE
        // USER'S OWN MESSAGE, typed while the turn was still running: "The user
        // sent a new message while you were working: ... Address the message above
        // as you continue this turn." Their POSITION is the payload — CC places
        // them alongside the tool result the model is about to read.
        //
        // This used to append them to messages[0], the system prompt. That both
        // buried the steer at the head of a multi-hundred-KB body (measured on
        // po-2024, 2026-08-28: one landing at message 114/141 went unaddressed for
        // 52 messages until the user re-asked) and DESTROYED it outright on the
        // Codex/Responses wire, where buildPayload skips role:"system" and rebuilds
        // `instructions` from claudeRequest.system — which never saw the merge.
        //
        // Emitted as role:"user" — it survives the Responses conversion and
        // satisfies the backends (Z.AI/MiniMax/Kimi) that accept no role but
        // user/assistant, exactly how Claude Code emits every other
        // system-reminder natively.
        //
        // HELD until the next message since S3 lot 1: on the real wire the steer
        // lands BETWEEN the assistant's tool_calls and the user turn carrying
        // their results. Emitting it there would split the tool round
        // (normalizeMessageSequence would close it on the steer and synthesize a
        // false "no result"); folding it into the result turn keeps the round
        // whole and the steer read right alongside the result it accompanied.
        // A non-user follower (or the end of the list) flushes it in place.
        const content = typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.map((c: any) => c.text || "").join("\n")
            : "";
        if (content) {
          pendingInlineSystem = pendingInlineSystem
            ? pendingInlineSystem + "\n\n" + content
            : content;
        }
      }
    }
    flushInlineSystem();
  }

  return normalizeMessageSequence(messages);
}

/**
 * Convert one Claude `image` block to an OpenAI `image_url` part.
 *
 * Claude carries an image in one of two source shapes, and only ONE of them is
 * base64:
 *
 *   { type: "base64", media_type: "image/png", data: "<b64>" }
 *   { type: "url",    url: "https://…" }
 *
 * Building a data URL unconditionally made a `url` source produce the literal
 * string `data:undefined;base64,undefined` — a syntactically valid data URL
 * carrying the word "undefined", which no provider rejects loudly. It is
 * decoded as garbage bytes or ignored, and the user sees a model that cannot
 * see the image it was sent. (Upstream 84578c9, item 16, S3 lot 1.)
 *
 * Returns `null` for a source this converter cannot express, so the caller drops
 * the part rather than forwarding a broken one. Every caller MUST skip `null`;
 * in particular the tool_result path counts the forwarded images to decide
 * whether to emit its "[image returned…]" marker.
 *
 * The media type is validated for SHAPE (a non-empty string), not against a list
 * of accepted image types. An allowlist here would be a second roster to keep
 * current, and a media type this converter has not heard of is the upstream
 * provider's judgement to make, not ours.
 */
function imageBlockToUrlPart(block: any): any | null {
  const source = block?.source;
  if (!source || typeof source !== "object") {
    log("[OpenAIMessages] Dropping image block: error — no source object");
    return null;
  }

  const url = typeof source.url === "string" ? source.url : "";
  const data = typeof source.data === "string" ? source.data : "";
  // `source.type` is the declaration; the payload present is the fallback, for
  // an older client that omits the discriminator on a base64 source.
  const kind = source.type || (url ? "url" : data ? "base64" : "");

  if (kind === "url") {
    if (!url) {
      log("[OpenAIMessages] Dropping image block: error — url source carries no url");
      return null;
    }
    // Forwarded verbatim. OpenAI-shaped providers fetch the URL themselves; a
    // data: URL handed to us as a url source is equally valid here.
    return { type: "image_url", image_url: { url } };
  }

  if (kind === "base64") {
    if (!data) {
      log("[OpenAIMessages] Dropping image block: error — base64 source carries no data");
      return null;
    }
    const mediaType = typeof source.media_type === "string" ? source.media_type : "";
    if (!mediaType) {
      log("[OpenAIMessages] Dropping image block: error — base64 source carries no media_type");
      return null;
    }
    return { type: "image_url", image_url: { url: `data:${mediaType};base64,${data}` } };
  }

  log(`[OpenAIMessages] Dropping image block: error — unsupported source type ${kind || "(none)"}`);
  return null;
}

/**
 * Merge two adjacent `user` contents, or return `undefined` for "do not merge".
 *
 * Two shapes reach here: a plain string (a Claude turn whose content was not a
 * block array) and an array of OpenAI content parts. A string pair stays a
 * string — keeping the simple shape matters for providers that only accept one.
 * A mixed pair is lifted to parts. Anything else (a null content, an object) is
 * left alone rather than guessed at. (Upstream b9e2163, item 13, S3 lot 1.)
 */
function mergeUserContent(a: any, b: any): any | undefined {
  if (typeof a === "string" && typeof b === "string") {
    if (!a) return b;
    if (!b) return a;
    return `${a}\n\n${b}`;
  }
  const toParts = (c: any): any[] | undefined => {
    if (typeof c === "string") return c ? [{ type: "text", text: c }] : [];
    if (Array.isArray(c)) return c;
    return undefined;
  };
  const pa = toParts(a);
  const pb = toParts(b);
  if (!pa || !pb) return undefined;
  return [...pa, ...pb];
}

/** Push a `user` message, merging it into the preceding one when there is one. */
function pushUserMessage(out: any[], msg: any) {
  const prev = out[out.length - 1];
  if (prev?.role === "user") {
    const merged = mergeUserContent(prev.content, msg.content);
    if (merged !== undefined) {
      prev.content = merged;
      return;
    }
  }
  out.push(msg);
}

/**
 * The text a synthetic `tool` message carries when a call got no result.
 * It names the omission rather than asserting a single cause: the model must not
 * read it as the tool having run and returned nothing. (Upstream a981d13.)
 */
function missingResultText(name: string): string {
  const call = name ? `\`${name}\` call` : "call";
  return (
    `[No tool result was provided for this ${call} — it was interrupted, cancelled, ` +
    "or dropped from the conversation history.]"
  );
}

/**
 * Align one tool round's `tool` messages against the `tool_calls` that opened it.
 *
 * Claude carries `tool_result` blocks in a user turn, in whatever order the
 * client assembled them; OpenAI carries them as separate `tool` messages and
 * ties each to a call by id. Two things go wrong in the gap, and both surface
 * as an opaque 400 rather than a diagnosis:
 *
 * - **Order.** Several relays and local runtimes pair results to calls
 *   positionally instead of by `tool_call_id`, so a parallel tool turn whose
 *   results came back out of order hands each tool the wrong output — silently,
 *   with no error anywhere. Results are emitted in the calls' own order.
 * - **A call with no result at all.** OpenAI rejects an assistant `tool_calls`
 *   message that is not answered by one `tool` message per call. Passing that
 *   through unchanged turns a recoverable history gap into a failed request, so
 *   the omission is NAMED by a synthetic `tool` message instead.
 *
 * Only the IMMEDIATELY preceding assistant message's calls are indexed — ids
 * from an earlier turn are not in scope and must not be matched. A result whose
 * id is in no call of this round is dropped with a log: OpenAI rejects an
 * unknown `tool_call_id`, and there is no call for it to answer.
 *
 * De-duplication is unchanged. `processUserMessage` dedupes by `tool_use_id`
 * within one Claude message; two results for the same id that arrived in
 * DIFFERENT messages are still both emitted here, adjacent and in arrival
 * order. This pass reorders, it does not decide identity.
 */
function alignToolRound(assistant: any, collected: any[]): any[] {
  const calls: any[] = Array.isArray(assistant.tool_calls) ? assistant.tool_calls : [];

  const byId = new Map<string, any[]>();
  for (const m of collected) {
    const list = byId.get(m.tool_call_id);
    if (list) list.push(m);
    else byId.set(m.tool_call_id, [m]);
  }

  const ordered: any[] = [];
  let synthesized = 0;
  for (const call of calls) {
    const matched = byId.get(call.id);
    if (matched) {
      ordered.push(...matched);
      byId.delete(call.id);
      continue;
    }
    synthesized++;
    log(
      `[OpenAIMessages] error — tool call ${call.id} (${call.function?.name || "?"}) has no ` +
        "result; a synthetic tool message names the omission"
    );
    ordered.push({
      role: "tool",
      content: missingResultText(call.function?.name || ""),
      tool_call_id: call.id,
    });
  }

  let dropped = 0;
  for (const [id, list] of byId) {
    dropped += list.length;
    log(
      `[OpenAIMessages] error — tool result ${id} matches no call in the round it follows; dropped`
    );
  }

  const reordered = ordered.some((m, i) => m !== collected[i]);
  if (reordered && !synthesized && !dropped) {
    log(`[OpenAIMessages] Reordered ${ordered.length} tool results to their tool_calls order`);
  }

  return ordered;
}

/**
 * Post-pass over the converted message list, fixing three sequence-level
 * defects that are only visible AFTER conversion.
 *
 * It has to be a post-pass rather than an edit inside `processUserMessage`,
 * because the converter itself emits up to three messages for a single Claude
 * user turn (the tool results, the images lifted out of them, and the turn's
 * own content). The adjacency is created here, so it can only be seen from
 * here.
 *
 * 1. **Adjacent `user` messages merge.** Chat Completions does not require
 *    strict alternation, but several relays and local runtimes do, and a
 *    provider that silently keeps only the last of a run drops the user's words.
 *
 * 2. **A `tool` message must answer an open tool round** — it must follow either
 *    an `assistant` carrying `tool_calls` or another `tool` message in the same
 *    round. An orphan (the assistant turn was compacted out of history, or the
 *    client replayed a result alone) is rejected by OpenAI with
 *    `messages with role 'tool' must be a response to a preceding message with
 *    tool_calls`, which reaches the user as an opaque 400. It is re-emitted as
 *    a `user` message prefixed `[Tool Result]:` — the same degradation
 *    `simpleFormat` already applies — so the content survives.
 *
 * 3. **Within a round, the `tool` messages are aligned against the calls that
 *    opened it** — see `alignToolRound`. A round left open at the END of the
 *    list with NO results at all is not a history gap — it is a request that
 *    stops on the assistant's own tool calls (a continuation/prefill), and
 *    answering it synthetically would tell the model its calls had failed. A
 *    PARTIALLY answered trailing round is a gap and is completed like any
 *    other.
 *
 * FCC additionally inserts a synthetic `assistant: " "` between a tool round
 * and a following user turn. That is NOT done here, per upstream's design
 * ruling: the synthetic turn is itself a fidelity cost (it enters history as
 * words the assistant never said, and is replayed on every later turn), and
 * `assistant(tool_calls) → tool → user` is legal OpenAI on its own.
 *
 * No message is ever moved or dropped by rules 1-2; rule 3 reorders within a
 * round and names omissions, and never moves anything past another message.
 * (Upstream b9e2163 + a981d13, items 13-14, S3 lot 1.)
 */
export function normalizeMessageSequence(messages: any[]): any[] {
  const out: any[] = [];
  // The assistant message whose tool_calls are currently unanswered, and the
  // tool messages collected against it. Both are null/empty outside a round.
  let openRound: any = null;
  let collected: any[] = [];

  const flushRound = (isFinal = false) => {
    if (!openRound) return;
    // A round left open at the END of the list with NO results at all is not a
    // history gap — it is a request that stops on the assistant's own tool calls
    // (a continuation/prefill). Answering it with synthetic "no result" messages
    // would tell the model its calls had failed. A PARTIALLY answered trailing
    // round is a gap and is completed like any other.
    if (isFinal && collected.length === 0) {
      openRound = null;
      return;
    }
    out.push(...alignToolRound(openRound, collected));
    openRound = null;
    collected = [];
  };

  for (const msg of messages) {
    if (msg.role === "tool") {
      if (openRound) {
        collected.push(msg);
        continue;
      }
      log(
        `[OpenAIMessages] error — tool result ${msg.tool_call_id} answers no open tool round; ` +
          "re-emitted as a user message"
      );
      const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      pushUserMessage(out, { role: "user", content: `[Tool Result]: ${text}` });
      continue;
    }

    // Any non-tool message ends the round, so the collected results are emitted
    // before it — they are never moved past another message.
    flushRound();

    if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      out.push(msg);
      openRound = msg;
      continue;
    }

    if (msg.role === "user") pushUserMessage(out, msg);
    else out.push(msg);
  }

  flushRound(true);
  return out;
}

function processUserMessage(
  msg: any,
  messages: any[],
  simpleFormat = false,
  prependSteer: string | null = null
) {
  if (Array.isArray(msg.content)) {
    const textParts: string[] = [];
    const contentParts: any[] = [];
    const toolResults: any[] = [];
    // Per TURN by design: every image lifted out of a tool_result leaves in ONE
    // following user message, so they accumulate across every result in this
    // same Claude user turn. The per-RESULT counters that decide each result's
    // marker live inside the loop. (Upstream 9f4488d, S3 lot 1.)
    const toolResultImages: any[] = [];
    const seen = new Set<string>();

    for (const block of msg.content) {
      if (block.type === "text") {
        textParts.push(block.text);
        if (!simpleFormat) {
          contentParts.push({ type: "text", text: block.text });
        }
      } else if (block.type === "image") {
        if (!simpleFormat) {
          const part = imageBlockToUrlPart(block);
          if (part) contentParts.push(part);
        }
        // Skip images in simple format - MLX doesn't support vision
      } else if (block.type === "tool_result") {
        if (seen.has(block.tool_use_id)) continue;
        seen.add(block.tool_use_id);

        let resultText = "";
        if (typeof block.content === "string") {
          resultText = block.content;
        } else if (Array.isArray(block.content)) {
          // BOTH counters are per RESULT, and that is the whole point.
          // `toolResultImages` is per TURN — testing its length to choose THIS
          // result's marker answers a question about some EARLIER result:
          // tool_result B, whose only image could not be expressed, said
          // "[image returned; see following message]" and pointed at tool
          // result A's image. The model then reads the wrong screenshot as B's
          // output, with no error anywhere.
          const texts: string[] = [];
          const others: any[] = [];
          let forwardedImages = 0;
          let droppedImages = 0;
          let droppedDocuments = 0;
          let wireDroppedImages = 0;
          for (const inner of block.content) {
            if (inner.type === "text") {
              texts.push(inner.text);
            } else if (inner.type === "image" && inner.source) {
              // A dropped image must NOT be counted as forwarded: the marker
              // below decides whether this tool message points at a following
              // image message that would not exist.
              if (!simpleFormat) {
                const part = imageBlockToUrlPart(inner);
                if (part) {
                  toolResultImages.push(part);
                  forwardedImages++;
                } else {
                  droppedImages++;
                }
              } else {
                // A text-only wire (simpleFormat) has no part for an image.
                // Count it as dropped so the marker names the omission: an
                // uncounted one contributed nothing and the tool result came
                // out EMPTY — a silent drop (#222 class). Counted apart from
                // droppedImages: the source is fine, the WIRE has no part for
                // it, and the marker states that fact (doctrine #126).
                wireDroppedImages++;
              }
            } else if (inner.type === "image" || inner.type === "document") {
              // Media this wire has no part for: an image without a usable
              // source, a document (PDF base64). Counted, NEVER serialized —
              // stringifying the block ships its base64 as text inside the
              // tool message on every later turn of the session (#224, the
              // same mechanism the hoist above closes for forwardable images).
              if (inner.type === "document") droppedDocuments++;
              else droppedImages++;
            } else {
              others.push(inner);
            }
          }
          resultText = texts.join("\n");
          if (others.length) resultText += (resultText ? "\n" : "") + JSON.stringify(others);
          // Tool/function messages must be non-empty; point at the forwarded
          // image. Every omission is named, and each counter speaks for
          // itself: a result with one forwarded AND one dropped image used to
          // say only "see following message", leaving the drop silent. An
          // image whose source could not be expressed leaves nothing to point
          // at — otherwise a tool_result whose only block was that image
          // becomes an empty tool message, which OpenAI rejects.
          const markers: string[] = [];
          if (forwardedImages && !resultText) markers.push("[image returned; see following message]");
          if (droppedImages) markers.push("[image returned, but its source could not be forwarded]");
          if (wireDroppedImages) markers.push("[image returned, but this wire cannot forward it]");
          if (droppedDocuments) markers.push("[document returned, but this wire cannot forward it]");
          if (markers.length) resultText += (resultText ? "\n" : "") + markers.join("\n");
        } else {
          resultText = JSON.stringify(block.content);
        }

        if (simpleFormat) {
          // In simple format, include tool results as text in user message
          textParts.push(`[Tool Result]: ${resultText}`);
        } else {
          toolResults.push({
            role: "tool",
            content: resultText,
            tool_call_id: block.tool_use_id,
          });
        }
      }
    }

    if (simpleFormat) {
      // Simple format: just concatenate all text
      if (prependSteer) textParts.unshift(prependSteer);
      if (textParts.length) {
        messages.push({ role: "user", content: textParts.join("\n\n") });
      }
    } else {
      if (toolResults.length) messages.push(...toolResults);
      // Images from tool results ride in their own user message, after the tool
      // outputs they came from (OpenAI requires tool messages to directly follow
      // the assistant tool_calls; a user image message may follow).
      if (toolResultImages.length) messages.push({ role: "user", content: toolResultImages });
      // A held inline-system steer rides at the head of this turn's own content
      // — after the tool results it accompanied, never between them and the
      // calls that opened the round.
      if (prependSteer) contentParts.unshift({ type: "text", text: prependSteer });
      if (contentParts.length) {
        messages.push({ role: "user", content: contentParts });
      } else if (prependSteer) {
        messages.push({ role: "user", content: prependSteer });
      }
    }
  } else {
    if (prependSteer && typeof msg.content === "string") {
      messages.push({ role: "user", content: prependSteer + "\n\n" + msg.content });
    } else {
      if (prependSteer) messages.push({ role: "user", content: prependSteer });
      messages.push({ role: "user", content: msg.content });
    }
  }
}

function processAssistantMessage(msg: any, messages: any[], simpleFormat = false, reasoningRoundtrip = false) {
  if (Array.isArray(msg.content)) {
    const strings: string[] = [];
    const toolCalls: any[] = [];
    const seen = new Set<string>();
    let reasoningContent = "";
    let hasThinking = false;

    for (const block of msg.content) {
      if (block.type === "text") {
        strings.push(block.text);
      } else if (block.type === "thinking") {
        // Accumulate thinking content to send back as reasoning_content.
        // Track presence regardless of content — Kimi K2.5 requires the field
        // even when the thinking text is empty.
        // Skip in simpleFormat (same as tool calls).
        if (!simpleFormat) {
          hasThinking = true;
          reasoningContent += block.thinking || "";
        }
      } else if (block.type === "tool_use") {
        if (seen.has(block.id)) continue;
        seen.add(block.id);
        if (simpleFormat) {
          // In simple format, include tool calls as text
          strings.push(`[Tool Call: ${block.name}]: ${JSON.stringify(block.input)}`);
        } else {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: JSON.stringify(block.input) },
          });
        }
      }
    }

    if (simpleFormat) {
      // Simple format: just string content, no tool_calls
      if (strings.length) {
        messages.push({ role: "assistant", content: strings.join("\n") });
      }
    } else {
      const m: any = { role: "assistant" };
      if (strings.length) m.content = strings.join(" ");
      else if (toolCalls.length) m.content = null;
      if (toolCalls.length) m.tool_calls = toolCalls;
      // Include reasoning_content whenever ANY thinking block was present,
      // even if the concatenated text is empty — Kimi K2.5 rejects turn 2+
      // with HTTP 400 if the field is missing after thinking was active.
      // With reasoningRoundtrip (DeepSeek), emit on every assistant message —
      // even tool_use-only turns with no thinking block — because DeepSeek
      // requires the field on recent assistant messages of a thinking-mode
      // conversation (empty string satisfies the presence check).
      if (hasThinking || reasoningRoundtrip) m.reasoning_content = reasoningContent;
      if (m.content !== undefined || m.tool_calls) messages.push(m);
    }
  } else {
    messages.push({ role: "assistant", content: msg.content });
  }
}

/**
 * Remove `reasoning_content` from already-converted OpenAI messages, in place.
 * Returns how many messages were changed.
 *
 * The counterpart to the emission in processAssistantMessage: that one writes
 * the field whenever a thinking block is present in history, which is right for
 * backends that require it (DeepSeek) or tolerate it (GLM, Kimi) and wrong for
 * ones that validate their body strictly. Mistral answers HTTP 422
 * `extra_forbidden` on `body.messages[N].assistant.reasoning_content`, which
 * fails every turn of a real thinking-mode conversation.
 *
 * This exists as a separate pass rather than a condition on the emitter because
 * the two needs genuinely conflict: Kimi K2.5 requires the field on turn 2+ of a
 * thinking conversation without opting into preserveThinkingInHistory(), so the
 * emitter cannot be gated on that capability alone.
 *
 * Note it cannot be folded into ComposedHandler's thinking-block strip either:
 * that one filters `type:"thinking"` blocks out of message content arrays, but
 * by this point the OpenAI conversion has flattened content to a string and
 * hoisted the reasoning into a sibling scalar — a block filter can never see it.
 */
export function stripReasoningContent(messages: any[]): number {
  if (!Array.isArray(messages)) return 0;
  let dropped = 0;
  for (const msg of messages) {
    if (msg && typeof msg === "object" && "reasoning_content" in msg) {
      delete msg.reasoning_content;
      dropped++;
    }
  }
  return dropped;
}
