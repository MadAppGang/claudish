/**
 * Request-mode and speed markers on a model spec: `+pro` and `#<speed>`.
 *
 *   cx@gpt-6-sol+pro         reasoning mode pro
 *   oai@gpt-6-sol#fast       speed fast (also: priority, flex, ultrafast, standard)
 *   oai@gpt-6-sol+pro#flex   both, in either order
 *
 * The characters are chosen because no catalog id contains `+` or `#`
 * (2,080 ids, generation g-20261012101007285-7770c36e), while `-pro` (102 ids)
 * and `-fast` (22) are real, different models; `:` is concurrency; `>>` and `|`
 * are shell operators (an unquoted `>>fast` silently redirects to a file).
 * `#` mid-word is literal in bash and default zsh, and with zsh's
 * `extendedglob` it fails loudly rather than silently.
 *
 * A marker only REQUESTS a value. Whether it is sent is the connection's
 * `wire.reasoning.mode` / `wire.speed` (catalog 3.7.0 R13); an explicit request
 * the connection does not publish is refused with the values it offers.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Context } from "hono";
import type { ModelHandler } from "../handlers/types.js";
import { WIRE_SPEEDS, type WireMode, type WireSpeed } from "./wire-request.js";

/**
 * The markers of the request being served, for `ComposedHandler` step 5w.
 *
 * Carried per request rather than baked into a handler: handlers are cached
 * per model, a fallback chain shares them, and a marker must never reach a
 * request body (the native passthrough forwards the body verbatim).
 */
export const wireMarkerContext = new AsyncLocalStorage<WireMarkers>();

/** Serve `inner` with `markers` in {@link wireMarkerContext}. */
export class WireMarkerHandler implements ModelHandler {
  constructor(
    private readonly inner: ModelHandler,
    private readonly markers: WireMarkers
  ) {}

  handle(c: Context, payload: any): Promise<Response> {
    return wireMarkerContext.run(this.markers, () => this.inner.handle(c, payload));
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}

const MODES: readonly WireMode[] = ["standard", "pro"];

export interface WireMarkers {
  /** The spec with every marker removed, `:N` concurrency kept. */
  spec: string;
  mode?: WireMode;
  speed?: WireSpeed;
}

export class WireMarkerError extends Error {}

/**
 * Split the markers off a model spec. Markers sit at the end of the model
 * part, before an optional `:N` concurrency suffix. Throws
 * {@link WireMarkerError} for an unknown value or a repeated marker, so a typo
 * never silently becomes "no marker".
 */
export function splitWireMarkers(input: string): WireMarkers {
  const concurrency = /:\d+$/.exec(input)?.[0] ?? "";
  let rest = concurrency ? input.slice(0, -concurrency.length) : input;
  let mode: WireMode | undefined;
  let speed: WireSpeed | undefined;

  for (;;) {
    const match = /([+#])([A-Za-z]+)$/.exec(rest);
    if (!match) break;
    const [whole, sigil, raw] = match;
    const value = raw.toLowerCase();
    if (sigil === "+") {
      if (!(MODES as readonly string[]).includes(value)) {
        throw new WireMarkerError(
          `unknown mode "+${raw}" in "${input}" (modes: +${MODES.join(", +")})`
        );
      }
      if (mode) throw new WireMarkerError(`more than one mode marker in "${input}"`);
      mode = value as WireMode;
    } else {
      if (!(WIRE_SPEEDS as readonly string[]).includes(value)) {
        throw new WireMarkerError(
          `unknown speed "#${raw}" in "${input}" (speeds: #${WIRE_SPEEDS.join(", #")})`
        );
      }
      if (speed) throw new WireMarkerError(`more than one speed marker in "${input}"`);
      speed = value as WireSpeed;
    }
    rest = rest.slice(0, -whole.length);
  }
  if (/[+#]/.test(rest)) {
    throw new WireMarkerError(
      `"${input}": "+" and "#" mark a mode or speed at the end of the model name only`
    );
  }
  return { spec: `${rest}${concurrency}`, ...(mode ? { mode } : {}), ...(speed ? { speed } : {}) };
}

/** Put markers back on a spec (for display and handler cache keys). */
export function formatWireMarkers(markers: WireMarkers): string {
  const concurrency = /:\d+$/.exec(markers.spec)?.[0] ?? "";
  const base = concurrency ? markers.spec.slice(0, -concurrency.length) : markers.spec;
  return `${base}${markers.mode ? `+${markers.mode}` : ""}${markers.speed ? `#${markers.speed}` : ""}${concurrency}`;
}
