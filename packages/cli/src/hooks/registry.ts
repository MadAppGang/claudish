/**
 * The hook registry: built-in and user hooks in effective order, indexed by
 * event, with applicability (severity ≠ off, `models`, `routes`).
 *
 * Effective order is the order every closed action is applied in, and the
 * order every raw hook runs in: `order` bucket (`pre`, `normal`, `post`), then
 * built-ins before user hooks, then position in `hooks.modules`, then export
 * order within a module. `claudish hooks list` prints exactly this order.
 */

import { globMatches, resolveSeverity } from "./config.js";
import type { HookDefinition, HookOrder, RouteInfo, RouteScope, Severity } from "./public.js";

/** Every point a hook can declare: the closed events plus the four raw stages. */
export type HookEventName =
  | "request"
  | "toolCall"
  | "responseRewrite"
  | "responseEnd"
  | "sessionStart"
  | "sessionIdle"
  | "sessionBlocked"
  | "sessionEnd"
  | "raw.providerRequest"
  | "raw.providerChunk"
  | "raw.providerStreamEnd"
  | "raw.response";

const CLOSED_HANDLER_KEYS = [
  "request",
  "toolCall",
  "responseRewrite",
  "responseEnd",
  "sessionStart",
  "sessionIdle",
  "sessionBlocked",
  "sessionEnd",
] as const;

const RAW_KEYS = ["providerRequest", "providerChunk", "providerStreamEnd", "response"] as const;

/** Proxy events are filtered by `models` and `routes`; session events are not. */
const PROXY_EVENTS: ReadonlySet<HookEventName> = new Set<HookEventName>([
  "request",
  "toolCall",
  "responseRewrite",
  "responseEnd",
  "raw.providerRequest",
  "raw.providerChunk",
  "raw.providerStreamEnd",
  "raw.response",
]);

export function isProxyEvent(event: HookEventName): boolean {
  return PROXY_EVENTS.has(event);
}

/**
 * What the model catalog says about the upstream a route reaches, when the
 * handler serving it has a catalog connection. Internal to claudish: never on a
 * hook context, so it adds nothing to the `claudish/hooks` contract.
 */
export interface UpstreamFacts {
  /** The connection's wire API when the catalog knows it (`"gemini"`, `"chat-completions"`, …). */
  wireApi: string | null;
  /** The catalog vendor of the model (`"google"`, …), when known. */
  vendor: string | null;
}

/** A built-in hook. Its id carries no `hook:` prefix. */
export type BuiltinHook = HookDefinition & {
  /** Name reported in stats `middleware_names` while this raw built-in is active. */
  statsName?: string;
  /**
   * Selects the hook from catalog data instead of `models` when the route has a
   * catalog connection (`ApplicabilityScope.upstream`). The model name, possibly
   * an opaque gateway id, is then not asked again. Without a connection the
   * `models` globs decide, as for every hook.
   */
  selectByUpstream?: (upstream: UpstreamFacts) => boolean;
};

/** A user hook as the loader produced it. */
export interface UserHookInput {
  /** Effective id, `hook:<module basename>/<id>`. */
  id: string;
  /** Absolute module path. */
  module: string;
  /** Position of the module in `hooks.modules`. */
  moduleIndex: number;
  /** Position of the hook in the module's default export. */
  exportIndex: number;
  def: HookDefinition;
}

export interface RegisteredHook {
  /** Effective id: the built-in's own id, or `hook:<module basename>/<id>`. */
  id: string;
  source: "builtin" | "user";
  /** Absolute module path; undefined for a built-in. */
  module?: string;
  def: HookDefinition;
  order: HookOrder;
  defaultSeverity: Severity;
  routes: RouteScope;
  models: ReadonlyArray<string>;
  unsafe: boolean;
  /** Every event this hook declares a handler for, in a fixed order. */
  events: ReadonlyArray<HookEventName>;
  statsName?: string;
  /** Built-ins only: see `BuiltinHook.selectByUpstream`. */
  selectByUpstream?: (upstream: UpstreamFacts) => boolean;
}

/** A hook selected for one event, with its resolved severity. */
export interface ApplicableHook {
  hook: RegisteredHook;
  severity: Exclude<Severity, "off">;
}

/** What applicability is judged against. */
export interface ApplicabilityScope {
  /** Proxy events: the route (models, routes, model-scoped severity keys). */
  route?: RouteInfo;
  /** Proxy events: catalog facts about the route's upstream, when it has a connection. */
  upstream?: UpstreamFacts;
  /** Session events: the model the caller asked for (model-scoped severity keys). */
  sessionModel?: string;
}

const ORDER_RANK: Record<HookOrder, number> = { pre: 0, normal: 1, post: 2 };

/** The events a definition declares, in a fixed order. */
export function eventsOf(def: HookDefinition): HookEventName[] {
  const events: HookEventName[] = [];
  const on = (def.on ?? {}) as Record<string, unknown>;
  for (const key of CLOSED_HANDLER_KEYS) if (on[key] !== undefined) events.push(key);
  const raw = ((def as { raw?: unknown }).raw ?? {}) as Record<string, unknown>;
  for (const key of RAW_KEYS) if (typeof raw[key] === "function") events.push(`raw.${key}`);
  return events;
}

function normalizeModels(models: HookDefinition["models"]): string[] {
  if (models === undefined) return ["*"];
  return typeof models === "string" ? [models] : [...models];
}

function register(
  def: HookDefinition,
  id: string,
  source: RegisteredHook["source"],
  module?: string,
  statsName?: string,
  selectByUpstream?: (upstream: UpstreamFacts) => boolean
): RegisteredHook {
  const hook: RegisteredHook = {
    id,
    source,
    def,
    order: def.order ?? "normal",
    defaultSeverity: def.defaultSeverity ?? "fix",
    routes: def.routes ?? "all",
    models: normalizeModels(def.models),
    unsafe: (def as { unsafe?: unknown }).unsafe === true,
    events: eventsOf(def),
  };
  if (module !== undefined) hook.module = module;
  if (statsName !== undefined) hook.statsName = statsName;
  if (selectByUpstream !== undefined) hook.selectByUpstream = selectByUpstream;
  return hook;
}

export class HookRegistry {
  /** Every hook in effective order. */
  readonly hooks: ReadonlyArray<RegisteredHook>;
  private readonly byEvent = new Map<HookEventName, RegisteredHook[]>();

  constructor(
    builtins: ReadonlyArray<BuiltinHook>,
    users: ReadonlyArray<UserHookInput>,
    private readonly severityMap: Record<string, Severity> | undefined
  ) {
    const ranked = [
      ...builtins.map((def, i) => ({
        hook: register(def, def.id, "builtin", undefined, def.statsName, def.selectByUpstream),
        key: [0, 0, i] as const,
      })),
      ...users.map((u) => ({
        hook: register(u.def, u.id, "user", u.module),
        key: [1, u.moduleIndex, u.exportIndex] as const,
      })),
    ];
    ranked.sort(
      (a, b) =>
        ORDER_RANK[a.hook.order] - ORDER_RANK[b.hook.order] ||
        a.key[0] - b.key[0] ||
        a.key[1] - b.key[1] ||
        a.key[2] - b.key[2]
    );
    this.hooks = ranked.map((r) => r.hook);
    for (const hook of this.hooks) {
      for (const event of hook.events) {
        const list = this.byEvent.get(event) ?? [];
        list.push(hook);
        this.byEvent.set(event, list);
      }
    }
  }

  /** Hooks declaring `event`, in effective order, before applicability. */
  declaring(event: HookEventName): ReadonlyArray<RegisteredHook> {
    return this.byEvent.get(event) ?? [];
  }

  /** True when any hook declares `event` at all. */
  has(event: HookEventName): boolean {
    return (this.byEvent.get(event)?.length ?? 0) > 0;
  }

  /** A hook's severity for a model (or unscoped when `modelId` is undefined). */
  severityOf(hook: RegisteredHook, modelId?: string): Severity {
    return resolveSeverity(hook.id, hook.defaultSeverity, this.severityMap, modelId);
  }

  /**
   * Hooks that apply to `event` in this scope, in effective order: severity is
   * not `off`, and for proxy events the route's nativeness matches `routes` and
   * its model matches `models` (or, for a built-in with `selectByUpstream` on a
   * route with a catalog connection, the catalog facts select it).
   */
  applicable(event: HookEventName, scope: ApplicabilityScope = {}): ApplicableHook[] {
    const proxy = isProxyEvent(event);
    const modelId = proxy ? scope.route?.modelId : scope.sessionModel;
    const out: ApplicableHook[] = [];
    for (const hook of this.declaring(event)) {
      if (proxy && scope.route && !routeMatches(hook, scope.route, scope.upstream)) continue;
      const severity = this.severityOf(hook, modelId);
      if (severity === "off") continue;
      out.push({ hook, severity });
    }
    return out;
  }
}

function routeMatches(hook: RegisteredHook, route: RouteInfo, upstream?: UpstreamFacts): boolean {
  if (hook.routes === "native" && !route.native) return false;
  if (hook.routes === "foreign" && route.native) return false;
  if (upstream && hook.selectByUpstream) return hook.selectByUpstream(upstream);
  return hook.models.some((glob) => globMatches(glob, route.modelId));
}
