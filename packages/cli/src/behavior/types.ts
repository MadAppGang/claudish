/**
 * Layer 4: Behavior Compatibility Layer — core types.
 *
 * Layers 1-3 translate the wire format, the model dialect, and the transport.
 * This layer translates the thing none of those cover: the *behavioral
 * conventions* the agent harness expects. A foreign model can speak the OpenAI
 * wire format perfectly, use every tool correctly, and still break Claude Code
 * because it did not follow an unwritten protocol.
 *
 * The motivating case: CC 2.1.220's ExitPlanModeV2 takes no `plan` parameter —
 * it reads the plan from a file at a CC-assigned path. gpt-5.6-sol wrote a
 * complete plan to a filename it invented instead, so CC found nothing at the
 * assigned path, reported `plan: null`, and degraded the approval dialog to a
 * bare yes/no with no permission-elevation option.
 *
 * Rules never mutate the request themselves. They RETURN actions, and the engine
 * applies them. That keeps every change attributable to a rule id, loggable, and
 * testable without a live request.
 */

/**
 * Linter semantics, deliberately: users already know what these mean.
 *   off  — rule does not run
 *   warn — rule runs, actions are logged but NOT applied
 *   fix  — rule runs, actions are applied
 */
export type Severity = "off" | "warn" | "fix";

/**
 * Facts about the harness detected from the incoming request.
 *
 * Extracted once per request by `harness.ts` and shared with every rule, so the
 * fragile business of matching Claude Code's prompt strings lives in exactly one
 * place rather than being copy-pasted into each rule.
 */
export interface HarnessFacts {
  /** True when the plan-mode system reminder is present in this request. */
  planModeActive: boolean;
  /**
   * The exact plan file path Claude Code assigned to this session.
   *
   * Never inferred from a default directory: CC exposes a `planDir` setting
   * ("Custom directory for plan files, relative to project root"), so assuming
   * ~/.claude/plans would silently break for anyone who set it. If the anchor
   * is absent this stays undefined and dependent rules stand down.
   */
  planFilePath?: string;
  /** Directory portion of `planFilePath`, for "is this write in the plan dir" tests. */
  planDir?: string;
  /** Claude Code session id — stable across turns of one session. */
  sessionId?: string;
  /**
   * Skills Claude Code offered this turn, in listing order.
   *
   * Empty means "no listing found", NOT "the user has no skills" — a rule must
   * not conclude anything from an empty list.
   */
  skills?: ReadonlyArray<AvailableSkill>;
}

/** A skill Claude Code offered the model. */
export interface AvailableSkill {
  name: string;
  description: string;
}

/** Request-time context handed to `onRequest`. All mutable fields are live. */
export interface BehaviorContext {
  modelId: string;
  providerName: string;
  /** Native Claude models already follow these conventions — rules default off. */
  isNativeAnthropic: boolean;
  /** Normalized Claude-format request. Owns `system`. Mutable. */
  claudeRequest: any;
  /** Claude-format tool definitions (`{name, description, input_schema}`). Mutable. */
  claudeTools: any[];
  /** Converted, target-format tools. Mutable — see the note in engine.applyAction. */
  tools: any[];
  /** Converted, target-format messages. Mutable. */
  messages: any[];
  /**
   * The system prompt as text.
   *
   * Carries CLAUDE.md, the user's project rules, and the skill listing — all of
   * which already arrive on every request. A rule reads this to decide that a
   * skill or a user rule applies, then INJECTS the relevant content rather than
   * instructing the model to go and fetch it.
   */
  systemText: string;
  harness: HarnessFacts;
}

/**
 * What the model said this turn, handed to `onModelOutput` once the stream ends.
 *
 * Deliberately NORMALIZED text rather than raw stream events: the four parsers
 * deliver four different shapes (a Chat Completions `delta`, a Responses API
 * event, an Anthropic frame, a Gemini part), and making every rule understand
 * all four would guarantee that rules silently work on some providers and not
 * others. Each parser knows its own shape; rules see prose.
 */
export interface ModelOutputContext {
  modelId: string;
  providerName: string;
  /** Assistant text for the turn, concatenated in order. */
  text: string;
  /** Reasoning/thinking text, where the provider exposes it separately. */
  reasoning: string;
  /** Tool names called during this turn, in order. Lets a rule see "claimed
   *  done but never called a test-running tool". */
  toolsCalled: string[];
  harness: HarnessFacts;
}

/** Tool-call context handed to `onToolCall`, after arguments are fully accumulated. */
export interface ToolCallContext {
  modelId: string;
  toolName: string;
  /** Parsed arguments. If the model emitted invalid JSON this is `{}`. */
  args: Record<string, any>;
  /** Raw argument JSON exactly as the model produced it. */
  rawArgs: string;
  harness: HarnessFacts;
}

/**
 * The closed set of things a rule may ask for. Closed on purpose: an open
 * "run this callback" action would make rule effects unauditable, which defeats
 * the point of having severity levels at all.
 */
export type RuleAction =
  | {
      /** Append a note to the system prompt. Used to restate a convention the
       *  model has lost track of under context pressure. */
      type: "injectSystemNote";
      text: string;
    }
  | {
      /** Append to a tool's description. A tool description sits adjacent to the
       *  call decision, so it survives context pressure that buries a reminder
       *  hundreds of thousands of tokens back. */
      type: "rewriteToolDescription";
      tool: string;
      append: string;
    }
  | {
      /** Replace the arguments of the tool call currently being intercepted. */
      type: "repairToolArgs";
      args: Record<string, any>;
      /** Human-readable reason, logged when applied. */
      reason: string;
    }
  | {
      /** Record a divergence without changing anything. */
      type: "warn";
      message: string;
    };

export interface BehaviorRule {
  /** Stable, namespaced id, e.g. "plan-mode/plan-file-path". Users key config off this. */
  id: string;
  description: string;
  defaultSeverity: Severity;
  /**
   * Tool names whose arguments this rule may rewrite.
   *
   * This drives SELECTIVE BUFFERING in the stream parsers. Repair is only
   * possible if a call's arguments are withheld until it completes, and
   * withholding costs incremental delivery — so it is opt-in per tool, and every
   * tool no rule names keeps streaming exactly as before.
   */
  interceptsTools?: string[];
  /**
   * Whether the rule is live for THIS request, given the detected harness state.
   * Defaults to true when omitted.
   *
   * This is what keeps `interceptsTools` honest. Model/provider gating
   * (`appliesTo`) happens before the request is inspected, so without this a
   * rule that intercepts `Write` would force buffering on every request for
   * every foreign model — turning off incremental delivery of file contents
   * even when the rule could not possibly fire. Arming on harness state means
   * a session outside plan mode buffers nothing and streams exactly as before.
   */
  armed?(facts: HarnessFacts): boolean;
  /** Model/provider gating, evaluated before any hook runs. */
  appliesTo(ctx: { modelId: string; providerName: string; isNativeAnthropic: boolean }): boolean;
  onRequest?(ctx: BehaviorContext): RuleAction[];
  onToolCall?(ctx: ToolCallContext): RuleAction[];
  /**
   * Runs once per turn, after the model's response has been fully streamed.
   *
   * This is where shortcut and rule-violation detection lives — those show up in
   * what the model SAYS ("this should work", "tests would pass") and in what it
   * did NOT do, not in any single tool call's arguments.
   *
   * The response has already reached the client by the time this runs, so it
   * cannot alter the current turn. Emit `warn` to record, or `injectSystemNote`
   * to correct on the NEXT request (see `pendingCorrections`).
   */
  onModelOutput?(ctx: ModelOutputContext): RuleAction[];
}

/** User-facing config, read from the `behavior` key of ~/.claudish/config.json. */
export interface BehaviorConfig {
  preset?: string;
  /**
   * Uploading behaviour decisions to claudish's servers for aggregate analysis.
   *
   * Its own opt-in, deliberately NOT sharing the existing `stats.enabled`
   * consent: that was granted for usage statistics, and reusing it to ship
   * behavioural records would be consent laundering. Default off.
   *
   * Local journalling is unaffected by this and always on — it is the user's own
   * data on their own disk, like `logs/`.
   *
   * Only the allow-listed `UploadableEntry` projection is ever sent: model,
   * provider, surface, decision, rule id, tool name, argument KEY names, and a
   * categorical path relation. No paths, no argument values, no message text.
   */
  telemetry?: {
    enabled?: boolean;
  };
  /** Rule id (or glob, e.g. "plan-mode/*") → severity. */
  rules?: Record<string, Severity>;
  /** Paths to user modules exporting BehaviorRule(s). */
  hooks?: string[];
  observer?: {
    enabled?: boolean;
    /**
     * `suggest` logs what it sees to the divergence log.
     *
     * There is deliberately no `enforce`. The tool-call seam the observer hangs
     * off is synchronous — stream parsers consume its return value immediately —
     * so an async model cannot gate a call without putting a network round-trip
     * between the model and the client. Config validation REJECTS `enforce`
     * rather than accepting it and quietly behaving as `suggest`.
     */
    mode?: "off" | "suggest";
    /** Omit to auto-discover a local model. Never defaulted to a pinned id. */
    model?: string;
    timeoutMs?: number;
    /**
     * Tools whose calls the observer is shown. Buffering these costs incremental
     * delivery, which is why the observer is off by default.
     */
    watchTools?: string[];
  };
}
