/**
 * Prepend a one-time failover notice as the FIRST text block of an Anthropic SSE
 * stream, shifting every real content block's `index` by +1.
 *
 * Injected at the HEAD of the first streamed response a session receives under an
 * active budget failover (see fork/failover.ts `consumeStreamNotice`). The
 * substitute model then reads its own prior turn — starting with this notice — on
 * the next turn's history, so it knows it inherited a context built for a
 * different model and resumes its normal working scope. The condensation notice
 * (appendFailoverNoticeToMessage) reinforces this at every /compact.
 *
 * Why index-shift instead of append-at-tail: the notice must lead the message so
 * it is the first thing the model sees when re-reading its prior turn. Anthropic
 * SSE indexes content blocks 0,1,2…; injecting at 0 and rewriting every upstream
 * content_block_start/delta/stop `index` to `index+1` keeps the stream valid —
 * multi-block messages (text + tool_use, thinking + text) are routine.
 *
 * Never-throws (never-hang priority): a malformed stream or parse anomaly degrades
 * to passthrough of the bytes seen so far. A missing notice is a cosmetic loss;
 * a thrown error here would corrupt a working stream for 4 live agents.
 */

export function prependNoticeToAnthropicStream(
  source: ReadableStream<Uint8Array>,
  notice: string
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let noticeEmitted = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = source.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // SSE events are separated by a blank line (\n\n). Process only whole
          // events; keep the trailing partial in the buffer for the next chunk.
          let out = "";
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const rawEvent = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            out += transformEvent(rawEvent);
            out += "\n\n";
          }
          if (out) controller.enqueue(encoder.encode(out));
        }
        // Flush any trailing partial event (no closing blank line) verbatim.
        if (buffer) controller.enqueue(encoder.encode(buffer));
        controller.close();
      } catch {
        // Never hang: close cleanly on any error rather than leave the client
        // waiting. The upstream's own finalize still terminates its stream.
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  function transformEvent(rawEvent: string): string {
    try {
      // Locate the `data:` line and parse its JSON payload (if any).
      const lines = rawEvent.split("\n");
      let dataIdx = -1;
      let payload: any = null;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trimStart().startsWith("data:")) {
          const jsonStr = lines[i].slice(lines[i].indexOf("data:") + 5).trim();
          if (jsonStr && jsonStr !== "[DONE]") {
            try {
              payload = JSON.parse(jsonStr);
              dataIdx = i;
            } catch {
              /* not JSON — leave untouched */
            }
          }
        }
      }

      const isContentBlock =
        payload &&
        (payload.type === "content_block_start" ||
          payload.type === "content_block_delta" ||
          payload.type === "content_block_stop");

      // Emit the notice once, immediately BEFORE the first real content block.
      // This places it after message_start and ahead of the model's first block.
      let prefix = "";
      if (isContentBlock && !noticeEmitted) {
        noticeEmitted = true;
        prefix = noticeFrames(notice);
      }

      // Shift the block's index by +1 so the notice can own index 0.
      if (isContentBlock && typeof payload.index === "number" && dataIdx >= 0) {
        lines[dataIdx] = `data: ${JSON.stringify({ ...payload, index: payload.index + 1 })}`;
        return prefix + lines.join("\n");
      }

      return prefix + rawEvent;
    } catch {
      return rawEvent;
    }
  }
}

function noticeFrames(notice: string): string {
  // Three complete SSE events (each terminated by \n\n). The `event:` line equals
  // the `data.type`, matching Anthropic's wire shape so clients that key on the
  // event name dispatch correctly.
  const start = JSON.stringify({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  const delta = JSON.stringify({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: notice },
  });
  const stop = JSON.stringify({ type: "content_block_stop", index: 0 });
  return (
    `event: content_block_start\ndata: ${start}\n\n` +
    `event: content_block_delta\ndata: ${delta}\n\n` +
    `event: content_block_stop\ndata: ${stop}\n\n`
  );
}
