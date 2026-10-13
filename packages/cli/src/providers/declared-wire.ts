/**
 * The wire of a custom endpoint: what its config DECLARES, never what a model
 * name suggests. A custom endpoint has no catalog connection, so the user's
 * `wire` block (config-schema.ts `CustomEndpointWireSchema`) plays that role,
 * and the request is shaped by the same step 5w a catalog connection uses.
 *
 * Defaults (documented in the schema): the API follows the transport; the
 * output limit is `max_tokens`, or `max_output_tokens` on Responses; no
 * reasoning field is sent unless declared; no mode or speed is offered.
 */
import type { CustomEndpointWire as DeclaredWire } from "../config-schema.js";
import type { ResolvedConnection } from "./connection-resolver.js";
import type { KnownWire, WireApi, WireAssignment, WireValue } from "./connection-wire.js";
import { WIRE_EFFORT_ORDER } from "./wire-request.js";

export function declaredWire(transportApi: WireApi, declared: DeclaredWire | undefined): KnownWire {
  const api: WireApi = declared?.api ?? transportApi;
  const tokenParam: KnownWire["tokenParam"] =
    declared?.tokenParam === "none"
      ? { status: "not_applicable" }
      : (declared?.tokenParam ?? (api === "responses" ? "max_output_tokens" : "max_tokens"));

  const r = declared?.reasoning;
  const assignments = (list: WireAssignment[] | undefined) =>
    list && list.length > 0 ? list : ({ status: "unknown" } as const);
  const reasoning: KnownWire["reasoning"] =
    r && (r.effort || r.enable?.length || r.disable?.length)
      ? {
          status: "supported",
          enable: assignments(r.enable),
          disable: assignments(r.disable),
          effort: r.effort
            ? {
                path: r.effort.path,
                values:
                  r.effort.values ??
                  (Object.fromEntries(WIRE_EFFORT_ORDER.map((name) => [name, name])) as Record<
                    string,
                    WireValue
                  >),
                default: r.effort.default ?? { status: "unknown" },
              }
            : { status: "unknown" },
          mode: { status: "unknown" },
        }
      : { status: "unknown" };

  return {
    status: "known",
    api,
    tokenParam,
    toolsWithReasoning: { status: "unknown" },
    reasoning,
    speed: { status: "unknown" },
    evidence: [],
  };
}

/** A connection for a custom endpoint, carrying its declared wire. */
export function declaredConnection(
  endpointName: string,
  model: string,
  baseUrl: string,
  wire: KnownWire
): ResolvedConnection {
  return {
    provider: endpointName,
    modelId: model,
    route: { routeId: "custom-endpoint", routeProfileId: endpointName },
    externalModelId: model,
    wire,
    profile: { kind: "custom", apis: { [wire.api]: { baseUrl } } },
    generationId: "declared",
  };
}
