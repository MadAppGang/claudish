/**
 * The request shape for `muse@`, borrowed from Meta's own direct-API wire.
 *
 * `meta-muse-code` has no catalog route binding yet (models-index publishes
 * its subscription profile later), so no connection describes how a Muse Code
 * request encodes its output limit and reasoning effort. Meta's METERED API
 * does: `meta/direct-api` publishes a known `responses` wire per model —
 * `max_output_tokens`, effort at `/reasoning/effort` with the values
 * `minimal … max` — and the subscription speaks the same Responses API to the
 * same host for the same model ids (muse-wire.md §4–5). So the owner's wire is
 * borrowed, exactly as `findOwnerWire` borrows an owner's fields elsewhere:
 *
 * - only from a KNOWN wire on the SAME API (`responses`);
 * - never its mode or speed: those carry entitlement and price (wire.md), so
 *   both are set to `unknown` on the borrowed copy and step 5w sends neither;
 * - the exact wire id first (an explicit contributor id gets its own
 *   connection's wire), never a family or sibling.
 *
 * A model the metered API does not publish (`muse-wonder-full-1.0`) gets no
 * borrowed wire, and its effort is whatever the Responses adapter sends.
 */

import { type ResolvedConnection, resolveConnection } from "../connection-resolver.js";
import type { KnownWire } from "../connection-wire.js";

/**
 * The owner wire to shape `muse@<modelName>` with, as a connection labelled
 * for `meta-muse-code`; undefined when Meta's direct API publishes no known
 * Responses wire for that id.
 */
export function ownerWireForModel(
  modelName: string,
  cachePath?: string
): ResolvedConnection | undefined {
  const resolution = cachePath
    ? resolveConnection("meta", modelName, cachePath)
    : resolveConnection("meta", modelName);
  if (!resolution.ok) return undefined;
  const { connection } = resolution;
  const wire = connection.wire;
  if (wire.status !== "known" || wire.api !== "responses") return undefined;
  const borrowed: KnownWire = {
    ...wire,
    speed: { status: "unknown" },
    reasoning:
      wire.reasoning.status === "supported"
        ? { ...wire.reasoning, mode: { status: "unknown" } }
        : wire.reasoning,
  };
  return { ...connection, provider: "meta-muse-code", wire: borrowed };
}
