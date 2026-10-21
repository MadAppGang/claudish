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

/** Where the parse loop publishes the upstream reader it reads. */
export interface UpstreamReaderSlot {
  reader?: ReadableStreamDefaultReader<Uint8Array>;
}

/** A parser source: an async `start` that runs the whole loop, and an optional flag-setting `cancel`. */
export interface ParserSource<T> {
  start(controller: ReadableStreamDefaultController<T>): Promise<void>;
  cancel?(reason?: unknown): void | Promise<void>;
}

export function cancelEndsUpstreamWork<T>(
  upstream: UpstreamReaderSlot,
  source: ParserSource<T>
): UnderlyingDefaultSource<T> {
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
