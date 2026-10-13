/**
 * The hooks claudish ships. Their ids carry no `hook:` prefix, so a user hook
 * can never shadow one, and they keep the ids the behavior rules had, so
 * existing severity keys (`plan-mode/*`, …) still address them.
 *
 * Order here is their effective order among built-ins of the same `order`
 * bucket.
 */

import type { BuiltinHook } from "../registry.js";
import { planModeHook } from "./plan-mode.js";
import { sessionContextHook } from "./session-context.js";

export const BUILTIN_HOOKS: ReadonlyArray<BuiltinHook> = [planModeHook, sessionContextHook];
