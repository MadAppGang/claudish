/**
 * The request stage: `request` hooks run once per upstream attempt, as a hook
 * chain (§4.4.1), and their actions are applied at two points of the terminal
 * handler.
 *
 * - **Stage A, before conversion, at each step**: `injectSystemNote`, the
 *   message actions, `replaceToolSchema`, `removeTool`, applied to the chain's
 *   working state after the hook that returned them and before the next hook
 *   is called. Step 0 is the pending notes `responseEnd` stored, so every
 *   request hook sees them. The final state becomes the attempt's Claude-format
 *   request before the adapter converts it, so a system note reaches every
 *   route — chat-completions adapters build their payload from the converted
 *   `messages` alone.
 * - **Stage B, after conversion**: `rewriteToolDescription` and
 *   `replaceToolDescription`, replayed in chain order on the Claude-format tools
 *   AND the converted tools. During the chain they are an overlay: later hooks
 *   see the resulting description in `ctx.request.tools`, but the Claude-format
 *   tools `convertTools` summarises stay unedited. Stage B is why plan mode
 *   keeps working under `--summarize-tools`, which cuts a converted description
 *   to its first sentence: the append lands after that cut.
 *
 * `ctx.harness` is detected once, from the request as Claude Code sent it, and
 * is the same for every step.
 *
 * The stage runs only when `withHooks` put the per-request `RequestHooks` on the
 * Hono context. The classifier passthrough, monitor mode, `--probe` and direct
 * handler use in tests therefore run no hooks.
 *
 * A `HookRequestScope` is one attempt's state. A FallbackHandler runs one
 * attempt per candidate on the same context; each attempt begins from a fresh
 * deep copy of the request (`transformOpenAIToClaude`), so nothing one attempt
 * applies leaks into the next, and the LAST attempt's scope is the one the
 * decorator commits or abandons. Pending notes are peeked, not taken: they are
 * removed only on `commit()`, so a correction survives a failed first attempt.
 */

import type { Context } from "hono";
import { log } from "../logger.js";
import {
  type MutableClaudeRequest,
  type PlannedAction,
  type RequestChainState,
  applyStageA,
  applyStageB,
  overlayToolDescriptions,
  requestChainState,
} from "./actions.js";
import { type HookEngine, type JournalMeta, PENDING_NOTE_ID } from "./engine.js";
import { deepFreeze, frozenClone } from "./freeze.js";
import { detectHarnessFacts, extractAvailableSkills, extractSessionId } from "./harness.js";
import { type InjectionSink, sinkFromEnv } from "./injection/sinks.js";
import type {
  ClaudeMessage,
  ClaudeTool,
  HarnessFacts,
  PriorAction,
  ProxySessionRef,
  RequestAction,
  RequestContext,
  RequestFacts,
  RouteInfo,
} from "./public.js";
import { RawRequest } from "./raw.js";
import type { ApplicableHook, UpstreamFacts } from "./registry.js";
import { recordTelemetryTurn } from "./telemetry/aggregate.js";

/** Hono context key: the per-proxy `RequestHooks`, set by `withHooks`. */
export const HOOKS_CONTEXT_KEY = "claudishHooks";
/** Hono context key: the current attempt's `HookRequestScope` (the last attempt overwrites). */
export const HOOK_SCOPE_CONTEXT_KEY = "claudishHookScope";

/** The pane-child env var naming the session a proxy event belongs to (§2.3). */
export const HOOK_SESSION_ENV = "CLAUDISH_HOOK_SESSION";

/**
 * `RouteInfo.native` for a proxied route: today's exact rule.
 *
 * A naming rule, not a pinned model list: Claude models are `claude-*`, and the
 * `anthropic` provider serves them. `forceForeignModel` is the one escape
 * hatch, set by a provider profile whose uids merely LOOK like Claude's (a
 * subscription aggregator serving `claude-sonnet-5-medium` over a foreign
 * protocol), where the 87/87 plan-mode measurement says nothing.
 */
export function isNativeRoute(
  bareModelName: string,
  providerName: string,
  forceForeignModel?: boolean
): boolean {
  return !forceForeignModel && (/^claude[-.]/i.test(bareModelName) || providerName === "anthropic");
}

/** A system prompt (string, or an array of text blocks) flattened to text. */
export function systemTextOf(system: unknown): string {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  const parts: string[] = [];
  for (const block of system) {
    if (typeof block === "string") parts.push(block);
    else if (typeof (block as { text?: unknown } | null)?.text === "string") {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join("\n\n");
}

/** `CLAUDISH_HOOK_SESSION` (`{"kind","id","role"}`), or null when absent or malformed. */
export function proxySessionFromEnv(env: NodeJS.ProcessEnv = process.env): ProxySessionRef | null {
  const raw = env[HOOK_SESSION_ENV];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const kinds = ["interactive", "channel", "team"];
    const roles = ["slot", "judge", null];
    if (
      typeof parsed?.id !== "string" ||
      !kinds.includes(parsed.kind as string) ||
      !roles.includes((parsed.role ?? null) as string | null)
    ) {
      return null;
    }
    return {
      kind: parsed.kind as ProxySessionRef["kind"],
      id: parsed.id,
      role: (parsed.role ?? null) as ProxySessionRef["role"],
    };
  } catch {
    return null;
  }
}

/* ───────────── context access ───────────── */

// Hono's Context is the production carrier; tests pass minimal fakes, some
// without get/set, which must keep running no hooks.
type ContextLike = Pick<Context, "get" | "set"> | undefined;

function contextGet<T>(c: ContextLike, key: string): T | undefined {
  return typeof c?.get === "function" ? (c.get(key as never) as T | undefined) : undefined;
}

function contextSet(c: ContextLike, key: string, value: unknown): void {
  if (typeof c?.set === "function") c.set(key as never, value as never);
}

/** The per-request hooks `withHooks` put on the context, if any. */
export function requestHooksOf(c: ContextLike): RequestHooks | undefined {
  return contextGet<RequestHooks>(c, HOOKS_CONTEXT_KEY);
}

/** The current attempt's scope, if a terminal handler began one. */
export function hookScopeOf(c: ContextLike): HookRequestScope | undefined {
  return contextGet<HookRequestScope>(c, HOOK_SCOPE_CONTEXT_KEY);
}

/** Put the per-request hooks on a context (`withHooks` does this). */
export function attachRequestHooks(c: ContextLike, hooks: RequestHooks): void {
  contextSet(c, HOOKS_CONTEXT_KEY, hooks);
}

/* ───────────── attempts ───────────── */

/** What a terminal handler hands the stage for one attempt. */
export interface AttemptInput {
  /**
   * The Claude-format request this attempt owns. Stage A REPLACES its `system`,
   * `messages` and `tools` (never mutating a message, block or tool in place),
   * so it is safe on a copy-on-write view of a shared payload.
   */
  claudeRequest: MutableClaudeRequest & { metadata?: unknown };
  route: RouteInfo;
  /**
   * Catalog facts about the route's upstream, when the handler has a catalog
   * connection. Built-ins with `selectByUpstream` are selected from them.
   */
  upstream?: UpstreamFacts;
  /** The model as Claude Code asked for it. */
  model: string;
  stream: boolean;
}

/** The engine-facing part of one proxy: shared by every request it serves. */
export class RequestHooks {
  constructor(
    readonly engine: HookEngine,
    /** Which session this process's proxy events belong to; `CLAUDISH_HOOK_SESSION` by default. */
    readonly session: ProxySessionRef | null = proxySessionFromEnv(),
    /** Where `responseEnd` injections, annotations and the inbox `stop`/`end` lines go. */
    readonly sink: InjectionSink = sinkFromEnv()
  ) {}

  /**
   * Run the `request` hooks for one attempt and apply stage A. The scope is
   * stored on the context, replacing (and abandoning) a previous attempt's.
   */
  async beginAttempt(c: ContextLike, input: AttemptInput): Promise<HookRequestScope> {
    hookScopeOf(c)?.abandon();
    const scope = await HookRequestScope.begin(this.engine, this.session, input);
    contextSet(c, HOOK_SCOPE_CONTEXT_KEY, scope);
    // The interactive launcher's driver follows the session the requests name (§7.5).
    if (scope.sessionId) this.sink.noteSessionId?.(scope.sessionId);
    return scope;
  }
}

type ScopeState = "open" | "committed" | "abandoned";

/** A `toolCall` hook armed for one request, with the tool names it sees. */
export interface ArmedToolHook {
  applicable: ApplicableHook;
  /** The names it listed; `"*"` matches every tool. */
  tools: ReadonlySet<string>;
}

/** True when an armed hook's tool list covers `name`. */
export function armedFor(hook: ArmedToolHook, name: string): boolean {
  return hook.tools.has("*") || hook.tools.has(name);
}

/** What `begin` decided about the response, before it starts. */
interface ResponsePlan {
  /** Fix-severity, non-observe `toolCall` hooks whose `armed` was true: they hold blocks. */
  interceptHooks: ArmedToolHook[];
  /** Observe-mode or warn-severity `toolCall` hooks whose `armed` was true: they run at the tap. */
  observeToolHooks: ArmedToolHook[];
  /** Fix-severity `responseRewrite` hooks whose `claims` was true: they buffer the response. */
  rewriteHooks: ApplicableHook[];
  /** Warn-severity `responseRewrite` hooks whose `claims` was true: evaluated at the tap. */
  observeRewriteHooks: ApplicableHook[];
  /** Applicable `responseEnd` hooks. */
  endHooks: ApplicableHook[];
}

/** One upstream attempt's hook state. */
export class HookRequestScope {
  /** Tool names a fix-severity `toolCall` hook armed for this request. Consumed by the response seam. */
  readonly armedTools: ReadonlySet<string>;
  /** Ids of fix-severity `responseRewrite` hooks whose `claims` was true. Consumed by the response seam. */
  readonly rewriteClaimants: ReadonlyArray<string>;
  /** The response-side hooks this request armed (§5.3). */
  readonly response: Readonly<ResponsePlan>;
  /** This attempt's raw (unsafe) tier: `providerRequest`, the parser taps, the `response` stage. */
  readonly raw: RawRequest;

  private held: PlannedAction<RequestAction>[];
  private state: ScopeState = "open";

  private constructor(
    readonly engine: HookEngine,
    readonly route: RouteInfo,
    readonly harness: HarnessFacts,
    readonly sessionId: string | undefined,
    readonly meta: JournalMeta,
    held: PlannedAction<RequestAction>[],
    private readonly removedTools: ReadonlyMap<string, number>,
    private readonly pendingSeqs: ReadonlyArray<number>,
    /** The request as the response-side hooks see it: the request chain's final view. */
    readonly facts: RequestFacts,
    readonly session: ProxySessionRef | null,
    response: ResponsePlan,
    upstream?: UpstreamFacts
  ) {
    this.held = held;
    this.response = response;
    const armed = new Set<string>();
    for (const h of response.interceptHooks) for (const t of h.tools) armed.add(t);
    this.armedTools = armed;
    this.rewriteClaimants = response.rewriteHooks.map((a) => a.hook.id);
    this.raw = new RawRequest(engine, route, meta, facts, upstream);
  }

  /**
   * A proxy-event context for a response-side hook (the request chain's final view).
   * `extra` (the tool call, the response view) is given to the hook as a deep-frozen
   * copy: its objects are what the seam serialises to the client afterwards.
   */
  proxyContext<T extends object>(base: object, event: string, extra: T): object {
    return {
      ...base,
      event,
      host: Object.freeze({ mode: this.engine.hostMode }),
      route: this.route,
      request: this.facts,
      harness: this.harness,
      session: this.session,
      ...frozenClone(extra),
    };
  }

  /** Steps 1–7 of §5.1, in order. */
  static async begin(
    engine: HookEngine,
    session: ProxySessionRef | null,
    input: AttemptInput
  ): Promise<HookRequestScope> {
    const { claudeRequest, route, upstream } = input;
    const sessionId = extractSessionId(claudeRequest);
    const meta: JournalMeta = sessionId
      ? { model: route.modelId, provider: route.provider, sessionId }
      : { model: route.modelId, provider: route.provider };

    // 2. Applicable hooks. Selection is cheap; the harness scan is not (it walks
    //    a conversation that can be ~180K tokens), so it runs only when some
    //    hook will read it.
    const requestHooks = engine.select("request", { route, upstream });
    const toolCallHooks = engine.select("toolCall", { route, upstream });
    const rewriteHooks = engine.select("responseRewrite", { route, upstream });
    // responseEnd reads ctx.harness too: selected once, here, for the plan below
    const endHooks = engine.select("responseEnd", { route, upstream });
    const anyHook =
      requestHooks.length + toolCallHooks.length + rewriteHooks.length + endHooks.length > 0;

    // 1. Harness facts, ONCE, from the request as Claude Code sent it: they
    //    describe the client, so no hook's edit can change another hook's idea
    //    of whether plan mode is on.
    // Deep-frozen: every hook, `claims()`, `armed()` and the observer read the same
    // object, so a write by one hook would change what all the others see.
    const harness: HarnessFacts = deepFreeze(
      anyHook
        ? harnessOf(claudeRequest, sessionId)
        : sessionId
          ? { planModeActive: false, sessionId }
          : { planModeActive: false }
    );
    // Hook-visible copies: the route and session objects belong to the caller.
    const hookRoute: RouteInfo = Object.freeze({ ...route });
    const hookSession: ProxySessionRef | null = session ? Object.freeze({ ...session }) : null;

    // The request view of one working state, built once per state and frozen: every
    // later step and the response-side hooks read it. `messages` and `tools` are
    // deep-frozen copies made on first read, because their elements are the objects
    // the provider payload is built from; a hook that never reads them pays nothing.
    let viewed: RequestChainState | null = null;
    let view: RequestFacts | null = null;
    const factsOf = (state: RequestChainState): RequestFacts => {
      if (state === viewed && view) return view;
      viewed = state;
      let messages: ReadonlyArray<ClaudeMessage> | undefined;
      let tools: ReadonlyArray<ClaudeTool> | undefined;
      view = Object.freeze({
        model: input.model,
        stream: input.stream,
        systemText: systemTextOf(state.system),
        get messages() {
          messages ??= frozenArrayCopy<ClaudeMessage>(state.messages);
          return messages;
        },
        get tools() {
          tools ??= frozenArrayCopy<ClaudeTool>(overlayToolDescriptions(state.tools, state.held));
          return tools;
        },
      });
      return view;
    };
    const requestContext = (base: object, facts: RequestFacts): RequestContext =>
      ({
        ...base,
        event: "request",
        host: Object.freeze({ mode: engine.hostMode }),
        route: hookRoute,
        request: facts,
        harness,
        session: hookSession,
      }) as RequestContext;

    // 3. Step 0: the pending notes, peeked (removed only on commit), so every
    //    request hook sees them in systemText and in ctx.prior.
    let state = requestChainState(claudeRequest);
    const notes = engine.peekNotes(sessionId);
    let prior: PriorAction[] = [];
    let applied = 0;
    if (notes.length > 0) {
      const step0 = applyStageA(
        state,
        notes.map((n) => ({
          hookId: PENDING_NOTE_ID,
          action: { type: "injectSystemNote", text: n.text },
        }))
      );
      state = step0.state;
      engine.recordResults("request", step0.results, meta);
      prior = step0.applied.map((p) =>
        Object.freeze({ hookId: p.hookId, action: frozenClone(p.action) })
      );
      applied += step0.applied.length;
    }

    // 4. The request hook chain: each step's stage-A actions applied to the
    //    working state before the next hook, description actions added to the
    //    overlay its successors see in ctx.request.tools.
    if (requestHooks.length > 0) {
      const chain = await engine.runChain(
        "request",
        requestHooks,
        {
          context: (_a, base, s) => requestContext(base, factsOf(s)),
          apply: (s, items) => applyStageA(s, items),
        },
        meta,
        { initial: state, prior }
      );
      state = chain.state;
      applied += chain.applied.length;
    }

    // The attempt's own request takes the final working state; a field no step
    // changed keeps its object (and its absence).
    if (state.system !== claudeRequest.system) claudeRequest.system = state.system;
    if (state.messages !== claudeRequest.messages) claudeRequest.messages = state.messages;
    if (state.tools !== claudeRequest.tools) claudeRequest.tools = state.tools;

    // 6. Armed tools and rewrite claims, evaluated once, before any response.
    //    The request facts the response-side hooks see are the request chain's
    //    final view: what the provider actually receives.
    const postFacts = factsOf(state);
    const predicateContext = (applicable: ApplicableHook): RequestContext =>
      requestContext(predicateBase(applicable), postFacts);
    const plan: ResponsePlan = {
      interceptHooks: [],
      observeToolHooks: [],
      rewriteHooks: [],
      observeRewriteHooks: [],
      endHooks,
    };
    for (const applicable of toolCallHooks) {
      const tc = applicable.hook.def.on?.toolCall;
      if (!tc) continue;
      const ctx = predicateContext(applicable);
      if (!engine.callPredicate(applicable.hook.id, tc.armed, tc, ctx, true)) continue;
      const armed: ArmedToolHook = { applicable, tools: new Set(tc.tools) };
      // A warn-severity or observe-mode hook never holds the stream: it sees the
      // call as delivered, at the tap.
      if (applicable.severity === "fix" && tc.observe !== true) plan.interceptHooks.push(armed);
      else plan.observeToolHooks.push(armed);
    }
    for (const applicable of rewriteHooks) {
      const rr = applicable.hook.def.on?.responseRewrite;
      if (!rr) continue;
      const ctx = predicateContext(applicable);
      if (!engine.callPredicate(applicable.hook.id, rr.claims, rr, ctx, true)) continue;
      if (applicable.severity === "fix") plan.rewriteHooks.push(applicable);
      else plan.observeRewriteHooks.push(applicable);
    }

    if (applied > 0 || state.held.length > 0) {
      log(
        `[hooks] request ${route.provider}/${route.modelId}: ${requestHooks.length} hook(s), ` +
          `${applied} action(s) applied, ${state.held.length} description action(s) for stage B`
      );
    }

    // 5. Description actions are replayed, in chain order, once the converted tools exist.
    return new HookRequestScope(
      engine,
      hookRoute,
      harness,
      sessionId,
      meta,
      [...state.held],
      state.removedTools,
      notes.map((n) => n.seq),
      postFacts,
      hookSession,
      plan,
      upstream
    );
  }

  /** True while stage-B actions are waiting for `applyToolDescriptions`. */
  get hasToolDescriptionWork(): boolean {
    return this.held.length > 0;
  }

  /**
   * Stage B: replay the held description actions, in chain order, on both tool
   * representations, each over the description the earlier ones produced.
   * `convertedTools` is null on a route with one representation (native). Both
   * arrays have ELEMENTS replaced, never their tool objects mutated, so the
   * converted array the provider payload aliases sees the change. Runs once;
   * later calls do nothing.
   */
  // biome-ignore lint/suspicious/noExplicitAny: Claude-format and provider-format tool arrays
  applyToolDescriptions(claudeTools: any[], convertedTools: any[] | null): void {
    if (this.held.length === 0) return;
    const held = this.held;
    this.held = [];
    const results = applyStageB(claudeTools, convertedTools, held, this.removedTools);
    if (results.length > 0) this.engine.recordResults("request", results, this.meta);
  }

  /**
   * The attempt's response was accepted (2xx): remove the pending notes it
   * carried. Idempotent; a no-op after `abandon()`.
   */
  commit(): void {
    if (this.state !== "open") return;
    this.state = "committed";
    if (this.sessionId && this.pendingSeqs.length > 0) {
      this.engine.consumeNotes(this.sessionId, this.pendingSeqs);
    }
  }

  /** The attempt failed or was superseded: its pending notes stay queued. */
  abandon(): void {
    if (this.state !== "open") return;
    this.state = "abandoned";
  }

  get settled(): ScopeState {
    return this.state;
  }

  /**
   * A turn finished on the wire, at this context size. Runs on every turn,
   * because a session where no hook ever fired is the denominator every
   * violation-rate question needs. Counts only; no-op unless telemetry is
   * opted in.
   */
  noteTurnComplete(inputTokens?: number): void {
    recordTelemetryTurn({
      sessionId: this.sessionId,
      model: this.route.modelId,
      provider: this.route.provider,
      inputTokens,
    });
  }
}

/** A predicate's base context. `armed`/`claims` get no signal of their own: they are synchronous. */
function predicateBase(applicable: ApplicableHook): object {
  return {
    hookId: applicable.hook.id,
    severity: applicable.severity,
    log: (message: string) => log(`[hook ${applicable.hook.id}] ${message}`),
    signal: new AbortController().signal,
    prior: [],
  };
}

/**
 * The arrays a hook reads as `ctx.request.messages` / `.tools` are deep-frozen
 * copies: the provider payload is built from the originals, and an in-place
 * `reverse()` in a `.js` hook (no types to stop it), or a write into a message or a
 * tool schema, would change the outgoing request with no journal line. A frozen
 * value turns that into a throw the engine contains.
 */
function frozenArrayCopy<T>(items: unknown): ReadonlyArray<T> {
  return frozenClone(Array.isArray(items) ? (items as T[]) : []);
}

function harnessOf(
  claudeRequest: AttemptInput["claudeRequest"],
  sessionId: string | undefined
): HarnessFacts {
  return {
    ...detectHarnessFacts(claudeRequest),
    ...(sessionId ? { sessionId } : {}),
    skills: extractAvailableSkills(systemTextOf(claudeRequest.system)),
  };
}
