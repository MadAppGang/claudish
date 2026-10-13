/**
 * Stage 3 of the response seam: the observe tap (§5.3).
 *
 * A synchronous pass-through. Each chunk is parsed incrementally and enqueued
 * unchanged — same bytes, same chunking, nothing awaited between reading a
 * chunk and handing it on. It is pull-driven, so it reads upstream no faster
 * than the client reads it.
 *
 * Two things happen at the chunk that carries `message_stop`:
 *
 * 1. BEFORE it is enqueued, the inbox `stop` line is appended synchronously
 *    (when a `responseEnd` hook applies). Claude Code writes a turn's
 *    `turn_duration` only after it read the final response's `message_stop`, so
 *    the line is on disk first by construction, whatever the earlier stages did.
 * 2. AFTER it is enqueued, the consumers run on what was parsed, off the client
 *    path: warn-mode `responseRewrite`, then `responseEnd`, whose `end` line is
 *    written in a `finally`.
 *
 * Observe-mode and warn-severity `toolCall` hooks run as each tool block
 * completes. Because the tap is the last stage, every consumer sees exactly
 * what the client received. A throw in the tap's parser stops parsing and the
 * bytes keep flowing (fail open); a client cancel or an upstream error writes
 * `end` with `aborted: true` at once.
 */

import { randomUUID } from "node:crypto";
import { log } from "../logger.js";
import { BlockCollector, collectorView } from "./response-blocks.js";
import type { SeamHooks } from "./seam-hooks.js";
import { SseSplitter, eventJson } from "./sse-codec.js";

/** A fresh id for one response's inbox lines. */
export function newRequestId(): string {
  return randomUUID();
}

/**
 * Writes one response's `end` line exactly once. `stop` is written by the
 * tap or the JSON branch; `end` by whichever finishes first: the `responseEnd`
 * dispatch, or an abort.
 */
export class EndLine {
  private written = false;

  constructor(
    private readonly hooks: SeamHooks,
    readonly req: string
  ) {}

  write(aborted: boolean): void {
    if (this.written || !this.hooks.hasEndHooks) return;
    this.written = true;
    try {
      this.hooks.sink.end(this.req, aborted);
    } catch (err) {
      log(`[hooks] inbox end failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}

export function observeTap(
  source: ReadableStream<Uint8Array>,
  hooks: SeamHooks,
  req: string = newRequestId()
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const splitter = new SseSplitter();
  const collector = new BlockCollector();
  const end = new EndLine(hooks, req);
  let parsing = true;
  let stopped = false;

  const observeTool = (name: string, id: string, rawArgs: string) => {
    if (!hooks.observes(name)) return;
    void hooks.observeToolCall({ id, name, rawArgs }).catch(() => {});
  };

  const onMessageStop = () => {
    const view = collectorView(collector);
    void (async () => {
      try {
        await hooks.observeRewrite(view);
        await hooks.end(view, req);
      } catch (err) {
        log(`[hooks] tap consumers failed: ${err instanceof Error ? err.message : err}`);
      } finally {
        end.write(false);
      }
    })();
  };

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let result: Awaited<ReturnType<typeof reader.read>>;
        try {
          result = await reader.read();
        } catch (err) {
          end.write(true);
          controller.error(err);
          return;
        }
        if (result.done) {
          controller.close();
          // A response that ended before `message_stop` writes only its `end`.
          if (!stopped) end.write(true);
          return;
        }

        const chunk = result.value;
        let carriesStop = false;
        const completed: Array<{ name: string; id: string; args: string }> = [];
        if (parsing) {
          try {
            for (const ev of splitter.push(chunk)) {
              const json = eventJson(ev) as { type?: string } | undefined;
              if (!json) continue;
              const block = collector.onEvent(json);
              if (block?.type === "tool_use" && block.name) {
                completed.push({ name: block.name, id: block.id ?? "", args: block.args });
              }
              if (json.type === "message_stop" && !stopped) carriesStop = true;
            }
          } catch (err) {
            parsing = false;
            log(
              `[hooks] tap parser failed, observing stopped: ${err instanceof Error ? err.message : err}`
            );
          }
        }

        if (carriesStop) {
          stopped = true;
          if (hooks.hasEndHooks) {
            try {
              hooks.sink.stop(req);
            } catch (err) {
              log(`[hooks] inbox stop failed: ${err instanceof Error ? err.message : err}`);
            }
          }
        }
        controller.enqueue(chunk);
        for (const c of completed) observeTool(c.name, c.id, c.args);
        if (carriesStop) onMessageStop();
      },
      cancel(reason) {
        end.write(true);
        return reader.cancel(reason).catch(() => {});
      },
    },
    { highWaterMark: 0 }
  );
}
