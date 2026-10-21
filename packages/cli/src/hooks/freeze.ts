/**
 * Read-only values for hook contexts.
 *
 * A context is frozen at its top level by the engine, but a frozen object's FIELDS can
 * still be objects a hook writes into: `ctx.prior[i].action.append`, `ctx.harness`,
 * `ctx.request.tools[i].input_schema`, `ctx.response.blocks[k].input`. Each of those is
 * also something claudish reads after the hook — the next step's view, a stage-B replay,
 * the payload sent to the provider or the client — so a write would change what claudish
 * does with no journal line, under the wrong hook id, or from a warn-severity hook. Every
 * value a hook can reach is therefore either a deep-frozen copy or deep-frozen in place
 * when claudish owns it and never writes it again.
 *
 * Plain data only (actions, facts, views): no functions, no class instances.
 */

/** Freeze `value` and everything reachable from it, in place. Returns it. */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value as object)) {
    const desc = Object.getOwnPropertyDescriptor(value as object, key);
    // An accessor is left alone: calling it here would defeat a lazy view.
    if (desc && "value" in desc) deepFreeze(desc.value);
  }
  return value;
}

/** A deep-frozen copy of plain data, for a value a hook sees while claudish keeps the original. */
export function frozenClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}
