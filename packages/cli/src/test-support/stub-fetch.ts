/**
 * Fetch stub for tests whose subject is HTTP *semantics*, not sockets (#593).
 *
 * MEASURED 2026-10-23 (po-2024): once ANY node:http server has existed in the
 * `bun test` process — the real claudish proxy is @hono/node-server, so every
 * proxy-server-*.test.ts route test does this — every `Bun.serve` created
 * afterwards in that same process becomes UNREACHABLE:
 *   - `fetch()` to it answers Bun's default page: 200 text/plain
 *     "Welcome to Bun! To get started, return a Response object."
 *   - a node:http client to it HANGS, and a raw net.Socket connection hangs
 *     too (measured; see the repro probes run on 2026-10-23).
 * Reproduced on win32 bun 1.3.14 and on the ubuntu-24.04 CI runner bun 1.4.0;
 * NOT in a single-file run (no node:http server has lived in that process).
 *
 * That is why the #593 CI signature ("Failed to parse JSON" in
 * mcp-searxng-client / web-search-executor) only ever appeared in the full
 * suite: the socket mock was never reached, and the body parsed was Bun's
 * welcome page. No client-side shim can fix a misdispatch that happens BELOW
 * fetch — and neither node:http nor a raw socket gets around it. The durable
 * fix is to stop depending on in-process Bun.serve reachability: these files
 * answer through a fetch stub, which exercises the same HTTP semantics
 * (status, headers, bodies, streaming, aborts) with no socket at all.
 *
 * The stub honors `init.signal` the way a real fetch does: an
 * `AbortSignal.timeout(...)` handed to the client under test still rejects,
 * so attempt-timeout and deadline behaviour stays faithfully exercised.
 */

type StubHandler = (req: Request) => Response | Promise<Response>;

function abortError(): Error {
  const err = new Error("The operation was aborted.");
  err.name = "AbortError";
  return err;
}

/**
 * Install `handler` as `globalThis.fetch` for the duration of a test (or the
 * file). Returns the restore function — call it in try/finally or afterAll.
 */
export function installStubFetch(handler: StubHandler): () => void {
  const native = globalThis.fetch;

  const wrapped = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    let req: Request;
    try {
      req = input instanceof Request ? input : new Request(String(input), init);
    } catch (err) {
      return Promise.reject(err);
    }
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);

    let answer: Promise<Response>;
    try {
      answer = Promise.resolve(handler(req));
    } catch (err) {
      answer = Promise.reject(err);
    }

    if (!signal) return answer;

    // bun 1.3.14: inside `bun test`, the timer behind AbortSignal.timeout()
    // does NOT wake the event loop when it is the only thing pending — a test
    // that awaits nothing but the abort simply never returns (measured
    // 2026-10-23: no output, no per-test timeout, the whole run hangs). A
    // live interval keeps the loop turning so the signal's timer fires; it is
    // cleared on every settle path. Harmless on seats where the signal's timer
    // works on its own.
    const waker = setInterval(() => {}, 5);

    return new Promise<Response>((resolve, reject) => {
      const settle = (fn: () => void) => {
        clearInterval(waker);
        signal.removeEventListener("abort", onAbort);
        fn();
      };
      const onAbort = () => settle(() => reject(abortError()));
      if (signal.aborted) {
        settle(() => reject(abortError()));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      answer.then(
        (res) => settle(() => resolve(res)),
        (err) => settle(() => reject(err))
      );
    });
  };

  globalThis.fetch = wrapped as typeof fetch;
  return () => {
    if (globalThis.fetch === (wrapped as unknown)) globalThis.fetch = native;
  };
}

/**
 * "The server never answers" without leaving a dangling promise behind:
 * the handler's promise settles (rejects) exactly when the request's own
 * AbortSignal fires, which is what a real fetch does on abort. A promise that
 * simply never settles suspends `bun test` at exit (measured 2026-10-23: the
 * run printed nothing and never returned, even though the outer fetch had
 * already rejected on the client's AbortSignal.timeout).
 */
export function hangUntilAborted(req: Request): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    if (req.signal.aborted) {
      reject(abortError());
      return;
    }
    req.signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });
}
