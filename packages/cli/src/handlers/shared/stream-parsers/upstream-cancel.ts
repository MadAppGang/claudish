/**
 * A downstream cancel that ends the upstream work, and resolves only once it has.
 *
 * Every parser here runs its whole upstream read loop inside `start()` and
 * used to answer `cancel()` by setting a flag: the loop never looked at it, so
 * it kept reading and logging frames after the consumer left, until the
 * provider finished generating. The session app's signing lease is released
 * when `cancel()` resolves (`releaseWhenBodyEnds`, `call-context.ts`), so a
 * frame that echoed the signing credential after that point reached the log
 * with its registry entry already gone (A2: a lease lives as long as the
 * protected work).
 *
 * `cancelEndsUpstreamWork` wraps a parser's underlying source so that its
 * `cancel()`:
 *   1. runs the parser's own cancel first (flags, ping), so nothing more is
 *      emitted downstream;
 *   2. cancels the upstream reader the loop is reading, so its pending
 *      `read()` resolves `done` and the provider connection is dropped;
 *   3. waits until the `start()` task itself has settled, including whatever
 *      the loop logs and records while it winds down.
 * A ReadableStream's `cancel()` promise resolves after the source's cancel
 * promise, so a caller that awaits it (the lease middleware, the advisor tee)
 * now waits for the upstream work to end.
 */

/**
 * Where the parse loop publishes the upstream reader it reads. Typed by the one
 * method used here rather than as `ReadableStreamDefaultReader`: the macOS
 * bridge typechecks these files under another bun-types version and without the
 * DOM lib, where that name differs (`readMany`) and `UnderlyingDefaultSource`
 * does not exist.
 */
export interface UpstreamReaderSlot {
  reader?: { cancel(reason?: unknown): Promise<void> };
}

/** A parser source: an async `start` that runs the whole loop, and an optional flag-setting `cancel`. */
export interface ParserSource<T> {
  start(controller: ReadableStreamDefaultController<T>): Promise<void>;
  cancel?(reason?: unknown): void | Promise<void>;
}

export function cancelEndsUpstreamWork<T>(
  upstream: UpstreamReaderSlot,
  source: ParserSource<T>
): {
  start(controller: ReadableStreamDefaultController<T>): Promise<void>;
  cancel(reason?: unknown): Promise<void>;
} {
  let task: Promise<void> | undefined;
  return {
    start(controller) {
      task = source.start(controller);
      return task;
    },
    async cancel(reason) {
      try {
        await source.cancel?.(reason);
      } catch {
        // The parser's own cancel failing must not stop the upstream cancel.
      }
      try {
        await upstream.reader?.cancel(reason);
      } catch {
        // Already released or errored: the loop has stopped reading either way.
      }
      try {
        await task;
      } catch {
        // The loop's failure is its own to report; the cancel only waits for it.
      }
    },
  };
}

/**
 * `response` with `onCancel` called when its body is cancelled downstream
 * (Claude Code went away), BEFORE the cancel is forwarded to the source. A
 * parser's cancelled finalize still reports the usage the provider sent, which
 * fires the handler's stats callback; this flag is how that callback tells a
 * client-cancelled turn from a completed one. Same status, headers and bytes,
 * pulled one chunk at a time (`highWaterMark: 0`); a response with no body is
 * returned as is.
 */
export function notifyOnDownstreamCancel(response: Response, onCancel: () => void): Response {
  const source = response.body;
  if (!source) return response;
  const reader = source.getReader();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let result: Awaited<ReturnType<typeof reader.read>>;
        try {
          result = await reader.read();
        } catch (err) {
          if (!cancelled) controller.error(err);
          return;
        }
        // A read the cancel below woke up: this stream is already closed.
        if (cancelled) return;
        if (result.done) {
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      },
      async cancel(reason) {
        cancelled = true;
        try {
          onCancel();
        } catch {
          // The flag is diagnostics; the upstream cancel below is what matters.
        }
        await reader.cancel(reason);
      },
    },
    { highWaterMark: 0 }
  );
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
