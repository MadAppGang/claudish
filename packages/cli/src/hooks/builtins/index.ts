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
import { createGeminiThoughtSignatureHook } from "./gemini-thought-signature.js";
import { createObserverHook } from "./observer.js";
import { planModeHook } from "./plan-mode.js";
import { sessionContextHook } from "./session-context.js";

/** The built-ins that need no configuration. */
export const BUILTIN_HOOKS: ReadonlyArray<BuiltinHook> = [planModeHook, sessionContextHook];

/**
 * Every built-in for one config: the fixed ones, the Gemini thought-signature
 * raw hook (a fresh instance, so its per-route caches belong to one engine), then
 * the observer it configures. The observer's rule vocabulary is the closed
 * conformance rules only.
 */
export function builtinHooks(config: HooksConfig): ReadonlyArray<BuiltinHook> {
  return [
    ...BUILTIN_HOOKS,
    createGeminiThoughtSignatureHook(),
    createObserverHook(
      config,
      BUILTIN_HOOKS.map((h) => h.id)
    ),
  ];
}
