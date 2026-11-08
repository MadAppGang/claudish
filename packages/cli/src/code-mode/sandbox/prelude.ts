/**
 * The guest-side prelude, evaluated in every script's QuickJS context before
 * the model's code.
 *
 * It is ONE function expression the host calls with the bridge object, so the
 * host functions (`call`, `text`, `register`) live only in this closure and are
 * never reachable from the global object. It defines the four globals the exec
 * description promises — `text`, `exit`, `tools`, `ALL_TOOLS` — as
 * non-writable, non-configurable properties.
 *
 * Every intrinsic it uses is captured into a closure constant when it loads
 * (`$apply`, `$slice`, `$String`, …) and called through `$apply`, so a script
 * that later overwrites `String.prototype.slice`, `Reflect` or
 * `Function.prototype.call` cannot change what the bridge does. The host
 * never trusts the guest's slicing either: it re-checks every string it
 * receives (`script-runtime.ts`).
 *
 * Isolation: `SharedArrayBuffer`, `Atomics`, `WeakRef` and
 * `FinalizationRegistry` are deleted; `console` and timers are never defined
 * (as in Codex); `Date` is kept (as in Codex); `Math.random` is replaced by a
 * PRNG seeded from the exec call id, so a re-run of the same script draws the
 * same numbers.
 */

/** The exit sentinel's marker property, for diagnostics only (identity is what counts). */
export const EXIT_SENTINEL_TAG = "__claudish_exit__";

/**
 * The prelude source. Called as `prelude(bridge, seed, identsJson, allToolsJson)`:
 *  - `bridge.call(ident, args)` → a promise for the nested tool's result;
 *  - `bridge.text(string)` → appends one output item (host enforces the budget);
 *  - `bridge.register(cut, exitSentinel)` → hands the host the trusted slice
 *    function and the exit sentinel object it compares rejections against.
 */
export const PRELUDE_SOURCE = `(function (bridge, seed, identsJson, allToolsJson) {
  "use strict";
  const $apply = Reflect.apply;
  const $String = String;
  const $stringify = JSON.stringify;
  const $parse = JSON.parse;
  const $slice = String.prototype.slice;
  const $freeze = Object.freeze;
  const $create = Object.create;
  const $defineProperty = Object.defineProperty;
  const $isArray = Array.isArray;
  const $imul = Math.imul;
  const $Promise = Promise;
  const $promiseReject = Promise.reject;
  const $call = bridge.call;
  const $text = bridge.text;
  const $register = bridge.register;

  const EXIT = $freeze({ ${EXIT_SENTINEL_TAG}: true });
  $apply($register, undefined, [function (s, n) { return $apply($slice, s, [0, n]); }, EXIT]);

  function toText(value) {
    if (typeof value === "string") return value;
    if (value === undefined || value === null || typeof value === "number" ||
        typeof value === "boolean" || typeof value === "bigint") {
      return $String(value);
    }
    try {
      const s = $apply($stringify, undefined, [value]);
      if (typeof s === "string") return s;
    } catch (e) {}
    try { return $String(value); } catch (e) { return "[value could not be stringified]"; }
  }

  function text(value) {
    $apply($text, undefined, [toText(value)]);
  }

  function exit() {
    throw EXIT;
  }

  const idents = $apply($parse, undefined, [identsJson]);
  const tools = $create(null);
  for (let i = 0; i < idents.length; i++) {
    const ident = idents[i];
    const fn = function (args) {
      if (typeof args !== "object" || args === null || $apply($isArray, undefined, [args])) {
        return $apply($promiseReject, $Promise, [
          "claudish: tools." + ident + " takes an object as its argument; this call was not run",
        ]);
      }
      return $apply($call, undefined, [ident, args]);
    };
    $defineProperty(tools, ident, { value: fn, enumerable: true });
  }
  $freeze(tools);

  const allTools = $apply($parse, undefined, [allToolsJson]);
  for (let i = 0; i < allTools.length; i++) $freeze(allTools[i]);
  $freeze(allTools);

  let state = seed >>> 0;
  function random() {
    state = (state + 0x6d2b79f5) | 0;
    let t = $imul(state ^ (state >>> 15), 1 | state);
    t = (t + $imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  $defineProperty(Math, "random", { value: random, writable: false, configurable: false });

  delete globalThis.SharedArrayBuffer;
  delete globalThis.Atomics;
  delete globalThis.WeakRef;
  delete globalThis.FinalizationRegistry;

  const fixed = { writable: false, configurable: false, enumerable: false };
  $defineProperty(globalThis, "text", { value: text, ...fixed });
  $defineProperty(globalThis, "exit", { value: exit, ...fixed });
  $defineProperty(globalThis, "tools", { value: tools, ...fixed });
  $defineProperty(globalThis, "ALL_TOOLS", { value: allTools, ...fixed });
})`;
