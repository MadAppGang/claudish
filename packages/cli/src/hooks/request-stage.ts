/**
 * The request stage: `request` hooks run once per upstream attempt, and their
 * actions are applied at two points of the terminal handler.
 *
 * - **Stage A, before conversion**: `injectSystemNote` (pending notes
 *   included), the message actions, `replaceToolSchema`, `removeTool`. Applied
 *   to the Claude-format request before the adapter converts it, so a system
 *   note reaches every route — chat-completions adapters build their payload
 *   from the converted `messages` alone.
 * - **Stage B, after conversion**: `rewriteToolDescription` and
 *   `replaceToolDescription`, applied to the Claude-format tools AND the
 *   converted tools. Stage B is why plan mode keeps working under
 *   `--summarize-tools`, which cuts a converted description to its first
 *   sentence: the append lands after that cut.
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
  applyStageA,
  applyStageB,
} from "./actions.js";
import { type HookEngine, type JournalMeta, PENDING_NOTE_ID } from "./engine.js";
import { detectHarnessFacts, extractAvailableSkills, extractSessionId } from "./harness.js";
import type {
  ClaudeMessage,
  ClaudeTool,
  HarnessFacts,
  ProxySessionRef,
  RequestAction,
  RequestContext,
  RequestFacts,
  RouteInfo,
} from "./public.js";
import type { ApplicableHook } from "./registry.js";
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
  /** The model as Claude Code asked for it. */
  model: string;
  stream: boolean;
}

/** The engine-facing part of one proxy: shared by every request it serves. */
export class RequestHooks {
  constructor(
    readonly engine: HookEngine,
    /** Which session this process's proxy events belong to; `CLAUDISH_HOOK_SESSION` by default. */
    readonly session: ProxySessionRef | null = proxySessionFromEnv()
  ) {}

  /**
   * Run the `request` hooks for one attempt and apply stage A. The scope is
   * stored on the context, replacing (and abandoning) a previous attempt's.
   */
  async beginAttempt(c: ContextLike, input: AttemptInput): Promise<HookRequestScope> {
    hookScopeOf(c)?.abandon();
    const scope = await HookRequestScope.begin(this.engine, this.session, input);
    contextSet(c, HOOK_SCOPE_CONTEXT_KEY, scope);
    return scope;
  }
}

type ScopeState = "open" | "committed" | "abandoned";

/** One upstream attempt's hook state. */
export class HookRequestScope {
  /** Tool names a fix-severity `toolCall` hook armed for this request. Consumed by the response seam. */
  readonly armedTools: ReadonlySet<string>;
  /** Ids of fix-severity `responseRewrite` hooks whose `claims` was true. Consumed by the response seam. */
  readonly rewriteClaimants: ReadonlyArray<string>;

  private held: PlannedAction<RequestAction>[];
  private state: ScopeState = "open";

  private constructor(
    private readonly engine: HookEngine,
    readonly route: RouteInfo,
    readonly harness: HarnessFacts,
    readonly sessionId: string | undefined,
    readonly meta: JournalMeta,
    held: PlannedAction<RequestAction>[],
    private readonly removedTools: ReadonlySet<string>,
    private readonly pendingSeqs: ReadonlyArray<number>,
    armedTools: ReadonlySet<string>,
    rewriteClaimants: ReadonlyArray<string>
  ) {
    this.held = held;
    this.armedTools = armedTools;
    this.rewriteClaimants = rewriteClaimants;
  }

  /** Steps 1–7 of §5.1, in order. */
  static async begin(
    engine: HookEngine,
    session: ProxySessionRef | null,
    input: AttemptInput
  ): Promise<HookRequestScope> {
    const { claudeRequest, route } = input;
    const sessionId = extractSessionId(claudeRequest);
    const meta: JournalMeta = sessionId
      ? { model: route.modelId, provider: route.provider, sessionId }
      : { model: route.modelId, provider: route.provider };

    // 2. Applicable hooks. Selection is cheap; the harness scan is not (it walks
    //    a conversation that can be ~180K tokens), so it runs only when some
    //    hook will read it.
    const requestHooks = engine.select("request", { route });
    const toolCallHooks = engine.select("toolCall", { route });
    const rewriteHooks = engine.select("responseRewrite", { route });
    const anyHook = requestHooks.length + toolCallHooks.length + rewriteHooks.length > 0;

    // 1. Harness facts.
    const harness: HarnessFacts = anyHook
      ? harnessOf(claudeRequest, sessionId)
      : sessionId
        ? { planModeActive: false, sessionId }
        : { planModeActive: false };

    const facts: RequestFacts = {
      model: input.model,
      stream: input.stream,
      systemText: systemTextOf(claudeRequest.system),
      messages: (claudeRequest.messages ?? []) as ReadonlyArray<ClaudeMessage>,
      tools: (claudeRequest.tools ?? []) as ReadonlyArray<ClaudeTool>,
    };
    const requestContext = (base: object): RequestContext =>
      ({
        ...base,
        event: "request",
        host: { mode: engine.hostMode },
        route,
        request: facts,
        harness,
        session,
      }) as RequestContext;

    const run =
      requestHooks.length > 0
        ? await engine.run("request", requestHooks, (_a, base) => requestContext(base), meta)
        : { runs: [], apply: [] };

    // 3 + 4. Stage A, with the pending notes peeked (removed only on commit),
    //    in one pass so an identical note from a hook and from the store is
    //    applied once.
    const notes = engine.peekNotes(sessionId);
    const noteItems: PlannedAction<RequestAction>[] = notes.map((n) => ({
      hookId: PENDING_NOTE_ID,
      action: { type: "injectSystemNote", text: n.text },
    }));
    const items = [...run.apply, ...noteItems];
    const stageA =
      items.length > 0
        ? applyStageA(claudeRequest, items)
        : { results: [], held: [], removedTools: new Set<string>() };
    if (stageA.results.length > 0) engine.recordResults("request", stageA.results, meta);

    // 6. Armed tools and rewrite claims, evaluated once, before any response.
    const armedTools = new Set<string>();
    for (const applicable of toolCallHooks) {
      if (applicable.severity !== "fix") continue;
      const tc = applicable.hook.def.on?.toolCall;
      if (!tc || tc.observe === true) continue;
      const ctx = requestContext(predicateBase(applicable));
      if (!engine.callPredicate(applicable.hook.id, tc.armed, tc, ctx, true)) continue;
      for (const tool of tc.tools) armedTools.add(tool);
    }
    const rewriteClaimants: string[] = [];
    for (const applicable of rewriteHooks) {
      if (applicable.severity !== "fix") continue;
      const rr = applicable.hook.def.on?.responseRewrite;
      if (!rr) continue;
      const ctx = requestContext(predicateBase(applicable));
      if (engine.callPredicate(applicable.hook.id, rr.claims, rr, ctx, true)) {
        rewriteClaimants.push(applicable.hook.id);
      }
    }

    const applied = stageA.results.filter((r) => r.decision === "matched").length;
    if (applied > 0 || stageA.held.length > 0) {
      log(
        `[hooks] request ${route.provider}/${route.modelId}: ${requestHooks.length} hook(s), ` +
          `${applied} stage-A action(s) applied, ${stageA.held.length} held for stage B`
      );
    }

    // 5. Stage-B actions are held until the converted tools exist.
    return new HookRequestScope(
      engine,
      route,
      harness,
      sessionId,
      meta,
      [...stageA.held],
      stageA.removedTools,
      notes.map((n) => n.seq),
      armedTools,
      rewriteClaimants
    );
  }

  /** True while stage-B actions are waiting for `applyToolDescriptions`. */
  get hasToolDescriptionWork(): boolean {
    return this.held.length > 0;
  }

  /**
   * Stage B: apply the held description actions to both tool representations.
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
  };
}

function harnessOf(
  claudeRequest: AttemptInput["claudeRequest"],
  sessionId: string | undefined
): HarnessFacts {
  const facts = detectHarnessFacts(claudeRequest);
  if (sessionId) facts.sessionId = sessionId;
  facts.skills = extractAvailableSkills(systemTextOf(claudeRequest.system));
  return facts;
}
