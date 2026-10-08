/**
 * runtime/shutdown.ts — ONE owner and ONE idempotent path for every exit: the quit key,
 * SIGINT, SIGTERM, a fatal signal, normal completion, and a thrown error. Never call
 * `process.exit()` anywhere else; a live renderer owns the terminal, and exiting around
 * it leaves raw mode on and ghost cells the renderer can no longer clear.
 *
 * THIS MODULE IS THE SOLE SIGNAL OWNER, and the bootstrap must keep it that way:
 *
 *     await createCliRenderer({ exitSignals: [], exitOnCtrlC: false, ... })
 *
 * Two owners is not a style question, it is a measured bug. The renderer is constructed
 * before `installShutdown` runs, so its handler is registered first and fires first; a
 * real SIGTERM against the pinned 0.4.5 renderer produced
 *     renderer.destroy → disposer → root.unmount → renderer.destroy
 * — the React tree torn down AFTER the terminal was already restored, and `destroy()`
 * run twice. With `exitSignals: []` upstream's `addExitListeners()` returns early on
 * `this.exitSignals.length === 0` and registers nothing, so the order below is the only
 * one there is. (`[]` survives upstream's `config.exitSignals || [...defaults]` because an
 * empty array is truthy — this is the documented "disables signal-based cleanup
 * entirely" switch, not an accident.)
 *
 * CTRL+C IS NOT A SIGNAL HERE. The renderer puts stdin in raw mode, which clears ISIG, so
 * the terminal driver never raises SIGINT from a keypress — it delivers the 0x03 byte.
 * `exitOnCtrlC: false` stops the renderer quitting behind us, so the bootstrap owns the
 * key itself:
 *     renderer.keyInput.on("keypress", (k) => { if (k.ctrl && k.name === "c") void shutdown() })
 * Our SIGINT handler is still load-bearing — it catches `kill -INT` from outside the tty.
 *
 * Bridge site B1: imports from core and react, calls no construct. */
import type { CliRenderer } from "@opentui/core";
import type { Root } from "@opentui/react";
import { signalExitCode } from "../../signal-exit-code.js";

/**
 * Every signal `installShutdown` registers: OpenTUI's documented default set, complete,
 * SIGINT included — because the renderer is now told to register none of them.
 *
 * NEVER hand this to `createCliRenderer`. It was previously exported as `EXIT_SIGNALS`
 * for precisely that purpose, and that export WAS the second owner. The rename is the
 * point: a stale `exitSignals: EXIT_SIGNALS` bootstrap now fails to compile instead of
 * silently reinstating the double-destroy above.
 *
 * SIGBREAK is Windows-only. `process.on` accepts it on darwin and it simply never fires,
 * so registration is attempted for every entry and only what actually registered is
 * tracked for removal. */
export const OWNED_SIGNALS: NodeJS.Signals[] = [
  "SIGINT",
  "SIGTERM",
  "SIGQUIT",
  "SIGABRT",
  "SIGHUP",
  "SIGBREAK",
  "SIGPIPE",
  "SIGBUS",
];

/** Long enough for the restored terminal to flush its last frame, short enough that a
 * quit still feels immediate. */
const FLUSH_MS = 50;

/*
 * EXIT CODE POLICY — `128 + signum`, the shell's own convention. Deliberately NOT
 * re-raising the signal, though re-raising is the textbook answer:
 *
 * 1. It loses the cause on this very stack. Bun reports a re-raised darwin SIGBUS to its
 *    parent as `signalCode: "SIGUSR1"` (signal 10, read back through a Linux table), so
 *    the one signal we are required to keep distinguishable is the one re-raise corrupts.
 * 2. It needs `process.kill(pid, "SIGBREAK")`, which throws `Unknown signal` off Windows.
 * 3. It only terminates while the default disposition survives listener removal. Any
 *    other library still holding a listener on that signal turns the re-raise into a
 *    no-op and the process hangs — the exact failure class this file keeps regressing
 *    into, traded in for the one thing re-raise was supposed to buy.
 *
 * `128 + signum` is deterministic, needs no cooperation from anything else in the
 * process, and is platform-correct as long as the number comes from the OS and never
 * from a literal (SIGBUS is 10 on darwin, 7 on Linux): SIGINT 130, SIGQUIT 131,
 * SIGABRT 134, SIGBUS 138, SIGPIPE 141, SIGTERM 143. Every one is distinguishable from
 * another and from the 0 of a clean quit — a signal-terminated TUI never reports success.
 * The trade-off accepted: a parent reading `WIFSIGNALED` sees an exit code instead.
 * `signalExitCode` computes it, for this and every other exit claudish takes on a signal. */

const UNPRINTABLE = "<unprintable throwable>";

/**
 * Format a throwable, and NEVER throw doing it. Not defensive padding — the catch block
 * used to run `err.stack ?? err.message` / `String(err)` raw, so an `unmount` that threw
 * an object with a throwing `toString` made the FORMATTER throw. That escaped the catch,
 * skipped `renderer.destroy()` and skipped the exit, with the idempotency flag already
 * latched so no retry could ever clean up: measured, that process hung until the test's
 * guard timer fired. A `stack` getter, a `message` getter, `Symbol.toPrimitive` and a
 * Proxy trap can each throw here, so the whole read sits in one `try` and the fallback is
 * a constant that cannot involve the value itself. */
const describeError = (err: unknown): string => {
  try {
    if (err instanceof Error) {
      const stack = err.stack;
      if (typeof stack === "string" && stack !== "") return stack;
      const message = err.message;
      if (typeof message === "string" && message !== "") return message;
    }
    return String(err);
  } catch {
    return `${UNPRINTABLE} (typeof ${typeof err})`;
  }
};

/**
 * Structural minimums, not the full classes: `installShutdown` calls exactly two methods,
 * and saying so lets a test pass two stubs with no `as unknown as` cast — a teardown path
 * whose failure modes cannot be exercised is how this file grew them. A real
 * `CliRenderer` / `Root` satisfies these. */
type Destroyable = Pick<CliRenderer, "destroy">;
type Unmountable = Pick<Root, "unmount">;

/**
 * Wire every exit path to one teardown and return it, so the app can also end normally by
 * awaiting it. The returned function is safe to call repeatedly and from inside a handler
 * — a SIGINT arriving during teardown must not re-enter.
 *
 * GUARANTEED ORDER, on every path: `disposers` (stop the app's own work) → `root.unmount`
 * (so no render is queued against a dead renderer) → `renderer.destroy` (restore the
 * terminal) → report failures → flush → exit.
 *
 * `disposers` is where an app-owned `setInterval`, watcher or socket goes. It is not a
 * convenience: this file forbids `process.exit()` everywhere else, so a timer with no
 * teardown hook had nowhere to be cleared and kept the event loop alive after an
 * `await shutdown()` that was supposed to end the program. Each runs at most once, before
 * the tree comes down, so nothing can fire a `setState` into an unmounting root:
 *
 *   const t = setInterval(tick, 1000)
 *   const shutdown = installShutdown(renderer, root, [() => clearInterval(t)])
 *
 * EVERY STEP IS GUARDED INDEPENDENTLY, AND `process.exit(code)` IS IN A `finally`. That is
 * the whole shape of the fix. A quit that leaves the terminal wedged is the worst failure
 * this file can have, so a broken disposer, an unprintable throwable or a double-destroy
 * all degrade to a stderr line printed AFTER the terminal is restored, and the process
 * still exits with the code it was given.
 */
export function installShutdown(
  renderer: Destroyable,
  root: Unmountable,
  disposers: ReadonlyArray<() => void> = []
): () => Promise<void> {
  const handlers = new Map<NodeJS.Signals, () => void>();
  const failures: string[] = [];
  let torndown = false;

  /** stderr is safe only AFTER `destroy()`: behind a live renderer it leaves cells the
   * renderer cannot invalidate. It can also fail on its own (a closed pipe), and a failed
   * report must never be the thing that stops the process exiting. */
  const report = (line: string): void => {
    try {
      console.error(line);
    } catch {
      /* stderr is gone; there is nowhere left to report */
    }
  };

  /** Run one teardown step; never let it end the teardown. Reported after `destroy()`. */
  const attempt = (label: string, step: () => void): void => {
    try {
      step();
    } catch (err) {
      failures.push(`${label}: ${describeError(err)}`);
    }
  };

  /**
   * Every step, exactly once, in the documented order — and this function CANNOT throw.
   * The teardown steps are guarded independently and at the same level, so nothing (not a
   * throwing disposer, not a pathological `disposers` array, not a throwing `unmount`) can
   * skip `renderer.destroy()`. Restoring the terminal is the step that must never be
   * skipped. */
  const teardownOnce = (): void => {
    if (torndown) return;
    torndown = true;
    try {
      // Listeners come off FIRST, so a second signal arriving mid-teardown hits the
      // default disposition and kills the process outright instead of re-entering here —
      // and so a later renderer in the same process starts from a clean slate.
      attempt("removeListeners", () => {
        for (const [sig, handler] of handlers) process.removeListener(sig, handler);
        handlers.clear();
        process.removeListener("uncaughtException", onCrash);
        process.removeListener("unhandledRejection", onCrash);
      });
      attempt("disposers", () => {
        disposers.forEach((d, i) => attempt(`disposers[${i}]`, d));
      });
      attempt("root.unmount", () => {
        root.unmount();
      });
      attempt("renderer.destroy", () => {
        renderer.destroy();
      });
      for (const f of failures) report(`shutdown: ${f}`);
    } catch (err) {
      // Unreachable by construction — which is exactly what was believed of the catch
      // block that threw. A file broken three times does not get to rely on that.
      report(`shutdown: teardown: ${describeError(err)}`);
    }
  };

  /**
   * `exitCode === undefined` means "tear down and hand control back": the normal-quit
   * path ends the program by letting the event loop drain, not by exiting.
   *
   * THE EXIT IS IN A `finally`. It used to sit in a `.then()` on the success path, so any
   * throw upstream skipped it entirely — and since every caller is fire-and-forget
   * (`void shutdown(...)`, because a signal handler cannot await), the rejection went
   * nowhere and took the exit code with it. The once-latch guards only the STEPS: a
   * repeat call re-runs nothing but still reaches this `finally`, so a caller can always
   * still end the process and latching can never strand it. */
  const shutdown = async (exitCode?: number, crash?: { readonly err: unknown }): Promise<void> => {
    try {
      teardownOnce();
      // Deliberately NOT behind the latch: a crash can land after teardown has already
      // run, and it still has to be reported — after `destroy()`, never before.
      if (crash) report(describeError(crash.err));
    } finally {
      if (exitCode !== undefined) {
        // Let the restored terminal flush its last frame before the process goes.
        try {
          await new Promise((r) => setTimeout(r, FLUSH_MS));
        } catch {
          /* a broken timer must not block the exit */
        }
        process.exit(exitCode);
      }
    }
  };

  const onCrash = (err: unknown): void => {
    void shutdown(1, { err });
  };

  for (const sig of OWNED_SIGNALS) {
    const handler = (): void => {
      void shutdown(signalExitCode(sig));
    };
    try {
      process.on(sig, handler);
      handlers.set(sig, handler); // track only what registered, so removal stays symmetric
    } catch {
      /* signal unknown to this platform: nothing registered, nothing to remove */
    }
  }
  process.on("uncaughtException", onCrash);
  process.on("unhandledRejection", onCrash);

  return () => shutdown(undefined);
}
