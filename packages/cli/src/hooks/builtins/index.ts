/**
 * The hooks claudish ships. Their ids carry no `hook:` prefix, so a user hook
 * can never shadow one, and they keep the ids the behavior rules had, so
 * existing severity keys (`plan-mode/*`, …) still address them.
 *
 * Order here is their effective order among built-ins of the same `order`
 * bucket.
 */

import type { HooksConfig } from "../config.js";
import type { BuiltinHook } from "../registry.js";
import { createObserverHook } from "./observer.js";
import { planModeHook } from "./plan-mode.js";
import { sessionContextHook } from "./session-context.js";

/** The built-ins that need no configuration. */
export const BUILTIN_HOOKS: ReadonlyArray<BuiltinHook> = [planModeHook, sessionContextHook];

/** Every built-in for one config: the fixed ones, then the observer it configures. */
export function builtinHooks(config: HooksConfig): ReadonlyArray<BuiltinHook> {
  return [
    ...BUILTIN_HOOKS,
    createObserverHook(
      config,
      BUILTIN_HOOKS.map((h) => h.id)
    ),
  ];
}
