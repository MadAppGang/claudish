/**
 * The catalog's per-connection `wire` and the route registry (contract 3.7.0).
 *
 * Every mapped connection publishes how to call it: the API, the output-limit
 * field, the reasoning encoding, the request mode and the speed tier. The route
 * registry publishes each route profile's base URL per API. Together they are
 * the ONLY source of request decisions for a catalog connection: no model name,
 * family or model-level field may decide any of these.
 *
 * Shapes are copied from Models Index `ai-docs/claudish-catalog-3.7.0.md` §3–4.
 */

export type WireApi = "chat-completions" | "responses" | "anthropic-messages" | "gemini";

export const WIRE_APIS: readonly WireApi[] = [
  "chat-completions",
  "responses",
  "anthropic-messages",
  "gemini",
];

export type WireUnknown = { status: "unknown" };
export type WireNotApplicable = { status: "not_applicable" };
export type WireStatusOnly = WireUnknown | WireNotApplicable;

export type WireValue = string | number | boolean;

export type TokenParam = "max_tokens" | "max_completion_tokens" | "max_output_tokens";

export interface WireAssignment {
  /** RFC 6901 JSON Pointer into the request body root. */
  path: string;
  value: WireValue;
}

export interface WireEffort {
  path: string;
  /** Catalog effort name → the exact native value on this connection. */
  values: Record<string, WireValue>;
  /** Catalog effort name in effect when the field is omitted. */
  default: string | WireUnknown;
}

export interface WireHeader {
  name: string;
  value: string;
  merge: "append-comma";
}

export type WireControl =
  | {
      status: "supported";
      path: string;
      values: Record<string, WireValue>;
      default: string | WireUnknown;
      headers: WireHeader[];
      echo: string | WireStatusOnly;
      access: "open" | "entitlement" | "usage-credits";
    }
  | { status: "rejected"; path: string }
  | WireStatusOnly;

export interface WireReasoningWarning {
  code: string;
  part: "enable" | "disable";
  servedModel: string;
}

export type WireReasoning =
  | {
      status: "supported";
      enable: WireAssignment[] | WireStatusOnly;
      disable: WireAssignment[] | WireStatusOnly;
      effort: WireEffort | WireStatusOnly;
      mode: WireControl;
      warnings?: WireReasoningWarning[];
    }
  | WireStatusOnly;

export interface WireEvidenceRef {
  evidenceId: string;
  method: string;
  sourceUrl?: string;
  observedAt: string;
}

export type KnownWire = {
  status: "known";
  api: WireApi;
  tokenParam: TokenParam | WireStatusOnly;
  toolsWithReasoning: "ok" | "requires-responses" | "requires-effort-none" | WireStatusOnly;
  reasoning: WireReasoning;
  speed: WireControl;
  evidence: WireEvidenceRef[];
};

export type ConnectionWire =
  | KnownWire
  | { status: "unknown"; evidence: WireEvidenceRef[] }
  | { status: "unsupported"; protocol: string; evidence: WireEvidenceRef[] };

export interface RouteProfile {
  kind: string;
  admission?: string;
  /** Vendors whose OWN models this profile serves natively (a `direct` profile is their native API). */
  nativeModelProviders?: string[];
  /** `{}` means no base URL is established for this profile. */
  apis: Partial<Record<WireApi, { baseUrl: string }>>;
}

export interface RouteRegistry {
  registryVersion: string;
  routes: Record<string, { routeId?: string; profiles: Record<string, RouteProfile> }>;
}

/** The registry as cached, pinned to the model list's generation. */
export interface CachedRouteRegistry {
  generationId: string;
  registry: RouteRegistry;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isWireApi(value: unknown): value is WireApi {
  return typeof value === "string" && (WIRE_APIS as readonly string[]).includes(value);
}

/**
 * Structural check of one connection's `wire`: the discriminator and the fields
 * a request reads. Sub-objects are checked only as far as `status` tells how to
 * read them; the request builder re-checks each value it uses.
 */
export function isConnectionWire(value: unknown): value is ConnectionWire {
  if (!isObject(value)) return false;
  switch (value.status) {
    case "unknown":
      return true;
    case "unsupported":
      return typeof value.protocol === "string";
    case "known":
      return (
        isWireApi(value.api) &&
        (typeof value.tokenParam === "string" || isObject(value.tokenParam)) &&
        isObject(value.reasoning) &&
        typeof value.reasoning.status === "string" &&
        isObject(value.speed) &&
        typeof value.speed.status === "string"
      );
    default:
      return false;
  }
}

export function isRouteRegistry(value: unknown): value is RouteRegistry {
  if (!isObject(value) || typeof value.registryVersion !== "string" || !isObject(value.routes)) {
    return false;
  }
  return Object.values(value.routes).every(
    (route) =>
      isObject(route) &&
      isObject(route.profiles) &&
      Object.values(route.profiles).every(
        (profile) =>
          isObject(profile) &&
          typeof profile.kind === "string" &&
          isObject(profile.apis) &&
          Object.entries(profile.apis).every(
            ([api, entry]) => isWireApi(api) && isObject(entry) && typeof entry.baseUrl === "string"
          )
      )
  );
}

/** `"3.7.0"` ≥ `"3.6.2"`, compared numerically per part. */
export function registryVersionAtLeast(version: string, minimum: string): boolean {
  const a = version.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const b = minimum.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return true;
}

/** The first registry version whose connections all carry `wire`. */
export const WIRE_REGISTRY_VERSION = "3.7.0";

export function routeProfile(
  registry: RouteRegistry,
  route: { routeId: string; routeProfileId: string }
): RouteProfile | undefined {
  return registry.routes[route.routeId]?.profiles?.[route.routeProfileId];
}

/**
 * The request path for `api` under a registry base URL (catalog 3.7.0 §4).
 * `baseUrl` already ends in its version segment (`/v1`, `/v1beta`), so the
 * suffix is appended as is.
 */
export function wireRequestUrl(
  baseUrl: string,
  api: WireApi,
  externalModelId: string,
  stream = true
): string {
  const base = baseUrl.replace(/\/+$/, "");
  switch (api) {
    case "chat-completions":
      return `${base}/chat/completions`;
    case "responses":
      return `${base}/responses`;
    case "anthropic-messages":
      return `${base}/messages`;
    case "gemini":
      return `${base}/models/${externalModelId}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
  }
}
