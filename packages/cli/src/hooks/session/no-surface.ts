/**
 * Session hooks for a launch with no pane to drive (hook-system §2.1, §4.4): `claudish
 * -i` with no TTY or no magmux, and `claudish -p`. Only the process lifecycle is known,
 * so `sessionStart` fires at spawn and `sessionEnd` at exit; `sessionIdle` and
 * `sessionBlocked` never fire. Every injection is dropped `unavailable`, with the one
 * stderr line per process of §4.7 rule 8.
 */

import type { HookEngine } from "../engine.js";
import { reportInjectionUnavailable } from "../injection/sinks.js";
import type { SessionInfo } from "../public.js";
import { createSessionHookBinding } from "./binding.js";

export interface NoSurfaceSession {
  /** Fire `sessionEnd` and wait for it, at most `waitMs`. */
  end(
    outcome: { state: string; reason: string | null; exitCode: number | null },
    waitMs?: number
  ): Promise<void>;
}

export function startNoSurfaceSession(
  engine: HookEngine,
  session: Omit<SessionInfo, "injection">,
  warn?: (line: string) => void
): NoSurfaceSession {
  const binding = createSessionHookBinding(engine, { ...session, injection: "unavailable" }, null);
  binding.attach?.({
    queueInjections(items) {
      reportInjectionUnavailable(warn);
      for (const i of items) binding.noteDropped?.(i, "unavailable");
    },
  });
  binding.fireStart();
  let ended: Promise<void> | null = null;
  return {
    end(outcome, waitMs = 1_500) {
      if (ended) return ended;
      binding.fireEnd(outcome);
      const settled = binding.endSettled?.() ?? Promise.resolve();
      ended = new Promise<void>((resolve) => {
        const t = setTimeout(resolve, waitMs);
        settled.then(
          () => {
            clearTimeout(t);
            resolve();
          },
          () => {
            clearTimeout(t);
            resolve();
          }
        );
      });
      return ended;
    },
  };
}
