/**
 * Behavior rule engine.
 *
 * Rules return actions; the engine applies them. Nothing else in the layer is
 * allowed to mutate the request, which is what makes severity levels meaningful
 * and every change traceable to a rule id.
 *
 * CONCURRENCY: ComposedHandler is cached per model and can serve overlapping
 * requests, so per-request state (detected harness facts, the active rule set)
 * lives on a BehaviorSession created by `startSession()` — never on the engine.
 * The stream-parser closure captures its own session, so two in-flight requests
 * cannot read each other's plan file path.
 */

import { detectHarnessFacts, extractAvailableSkills, extractSessionId } from "../hooks/harness.js";
import {
  type Decision,
  type Surface,
  classifyPath,
  isUploadDecision,
  isUploadSurface,
  recordDecision,
} from "../hooks/journal.js";
import {
  recordTelemetryDecision,
  recordTelemetryTurn,
  setTelemetryConsent,
} from "../hooks/telemetry/aggregate.js";
import { log } from "../logger.js";
import { resolveSeverity } from "./config.js";
import type {
  BehaviorConfig,
  BehaviorContext,
  BehaviorRule,
  HarnessFacts,
  ModelOutputContext,
  RuleAction,
  Severity,
} from "./types.js";

/**
 * Caps on per-turn observation. A long turn can emit megabytes; holding all of
 * it to run rules at the end is a bad trade for a diagnostic feature.
 */
const MAX_OBSERVED_CHARS = 64 * 1024;
const MAX_OBSERVED_TOOLS = 200;

/** The slice of BehaviorEngine a session needs for cross-turn state. */
interface CorrectionStore {
  queueCorrection(key: string, text: string): void;
  drainCorrections(key: string): string[];
}

interface ActiveRule {
  rule: BehaviorRule;
  severity: Severity;
}

/** Per-request state. Created by BehaviorEngine.startSession(). */
export class BehaviorSession {
  private facts: HarnessFacts = { planModeActive: false };
  /**
   * Populated only once the request has been inspected. Empty until then, so a
   * request that never calls applyRequest buffers nothing.
   */
  private bufferedTools = new Set<string>();

  /** Accumulated assistant output for the current turn. */
  private textBuf = "";
  private reasoningBuf = "";
  private toolsCalled: string[] = [];
  /** Claude Code session id — stable across turns, the key for cross-turn state. */
  private sessionId?: string;
  /** System prompt text for this request (CLAUDE.md, user rules, skill listing). */
  private systemText = "";

  /** True when any active rule actually inspects model output. */
  private get watchesOutput(): boolean {
    return this.active.some((a) => typeof a.rule.onModelOutput === "function");
  }

  constructor(
    private readonly active: ActiveRule[],
    private readonly modelId: string,
    private readonly providerName: string,
    private readonly config: BehaviorConfig = {},
    /** Owns cross-turn state; a session is per-request and cannot hold it. */
    private readonly engine: CorrectionStore = { queueCorrection() {}, drainCorrections: () => [] }
  ) {}

  /** True when the observer should be consulted on this run. */
  private get observerOn(): boolean {
    return (
      this.config.observer?.enabled === true && (this.config.observer.mode ?? "suggest") !== "off"
    );
  }

  /**
   * Tools the observer watches when enabled.
   *
   * The observer exists to find divergences the RULES do not yet encode, so it
   * cannot be limited to tools a rule already intercepts — that would only ever
   * show it calls that are already handled. Buffering these costs incremental
   * delivery, which is why the observer is opt-in and off by default.
   */
  private observerWatchList(): string[] {
    return this.config.observer?.watchTools ?? ["Write", "Edit", "NotebookEdit", "ExitPlanMode"];
  }

  /**
   * Decide which tools need buffering, now that harness state is known.
   *
   * Two gates, both necessary. A rule at `warn` cannot apply a repair, so
   * buffering for it would be pure cost; and a rule that is not armed for this
   * request (e.g. a plan-mode rule outside plan mode) cannot fire at all. The
   * net effect is that ordinary sessions stream tool arguments incrementally
   * exactly as they did before this layer existed.
   */
  private armBuffering(): void {
    const armed = new Set<string>();
    for (const { rule, severity } of this.active) {
      if (severity !== "fix") continue;
      if (rule.armed && !rule.armed(this.facts)) continue;
      for (const t of rule.interceptsTools ?? []) armed.add(t);
    }
    // The observer needs to SEE calls to say anything about them, and the only
    // hook that carries a completed call is the repair seam.
    if (this.observerOn) {
      for (const t of this.observerWatchList()) armed.add(t);
    }
    this.bufferedTools = armed;
  }

  get harness(): HarnessFacts {
    return this.facts;
  }

  /** True when no rule is active — lets callers skip work entirely. */
  get isNoop(): boolean {
    return this.active.length === 0;
  }

  /**
   * Run request-time rules. Called from the middleware `beforeRequest` hook,
   * which the pipeline guarantees runs before `buildPayload`.
   */
  applyRequest(claudeRequest: any, claudeTools: any[], tools: any[], messages: any[]): void {
    if (this.active.length === 0) return;

    this.facts = detectHarnessFacts(claudeRequest);
    this.sessionId = extractSessionId(claudeRequest);
    this.systemText =
      typeof claudeRequest?.system === "string"
        ? claudeRequest.system
        : String(claudeRequest?.system ?? "");
    this.facts.sessionId = this.sessionId;
    this.facts.skills = extractAvailableSkills(this.systemText);
    this.armBuffering();

    // Apply anything an output rule queued at the end of a PREVIOUS turn of this
    // same Claude Code session. Keyed by the session id Claude Code sends, so
    // two concurrent conversations against the same model cannot cross over.
    if (this.sessionId) {
      for (const text of this.engine.drainCorrections(this.sessionId)) {
        this.applyAction(
          "behavior/pending-correction",
          "fix",
          { type: "injectSystemNote", text },
          {
            modelId: this.modelId,
            providerName: this.providerName,
            isNativeAnthropic: false,
            claudeRequest,
            claudeTools,
            tools,
            messages,
            systemText: this.systemText,
            harness: this.facts,
          }
        );
      }
    }

    const ctx: BehaviorContext = {
      modelId: this.modelId,
      providerName: this.providerName,
      isNativeAnthropic: false,
      claudeRequest,
      claudeTools,
      tools,
      messages,
      systemText: this.systemText,
      harness: this.facts,
    };

    for (const { rule, severity } of this.active) {
      if (!rule.onRequest) continue;
      let actions: RuleAction[] = [];
      try {
        actions = rule.onRequest(ctx) ?? [];
      } catch (err) {
        // A broken rule degrades to no-op. It must never fail the user's request.
        log(`[behavior] rule ${rule.id} onRequest threw: ${err}`);
        continue;
      }
      for (const action of actions) this.applyAction(rule.id, severity, action, ctx);
    }
  }

  /** Whether this tool's arguments must be buffered so a repair can land. */
  interceptsTool(toolName: string): boolean {
    return this.bufferedTools.has(toolName);
  }

  /**
   * Note that a turn finished on the wire, with the context size it ran at.
   *
   * Separate from `finishTurn()`, which runs output RULES and only fires when a
   * rule watches output. This runs on every turn, because a session where no
   * rule ever fired is the denominator every violation-rate question needs — a
   * rule that fires twice means nothing without knowing whether it saw 3 turns
   * or 300.
   *
   * Counts only; the token figure never leaves as anything finer than a bucket.
   */
  noteTurnComplete(inputTokens?: number): void {
    recordTelemetryTurn({
      sessionId: this.sessionId,
      model: this.modelId,
      provider: this.providerName,
      inputTokens,
    });
  }

  /**
   * Accumulate assistant output as it streams.
   *
   * Bounded: a long turn can emit megabytes, and holding all of it to run a
   * regex at the end is a poor trade. The cap keeps the head, because the
   * claims worth catching ("I've verified…", "tests pass") are overwhelmingly
   * stated up front rather than buried after 200KB of code.
   */
  observeText(text: string, kind: "text" | "reasoning" = "text"): void {
    if (!this.watchesOutput || !text) return;
    const buf = kind === "reasoning" ? this.reasoningBuf : this.textBuf;
    if (buf.length >= MAX_OBSERVED_CHARS) return;
    if (kind === "reasoning") this.reasoningBuf += text;
    else this.textBuf += text;
  }

  /** Record a tool call by name, so output rules can see what the turn actually did. */
  observeToolCall(toolName: string): void {
    if (!this.watchesOutput) return;
    if (this.toolsCalled.length < MAX_OBSERVED_TOOLS) this.toolsCalled.push(toolName);
  }

  /**
   * Run output rules. Called once the response stream has completed.
   *
   * The turn is already on the wire, so nothing here can change it — actions are
   * recorded, and `injectSystemNote` is held for the NEXT request instead.
   */
  finishTurn(): void {
    if (!this.watchesOutput) return;
    const ctx: ModelOutputContext = {
      modelId: this.modelId,
      providerName: this.providerName,
      text: this.textBuf,
      reasoning: this.reasoningBuf,
      toolsCalled: this.toolsCalled,
      harness: this.facts,
    };

    for (const { rule, severity } of this.active) {
      if (!rule.onModelOutput) continue;
      let actions: RuleAction[] = [];
      try {
        actions = rule.onModelOutput(ctx) ?? [];
      } catch (err) {
        log(`[behavior] rule ${rule.id} onModelOutput threw: ${err}`);
        continue;
      }
      for (const action of actions) {
        if (action.type === "warn") {
          log(`[behavior] ${rule.id} (output): ${action.message}`);
          this.journal("model_output", "warned", { ruleId: rule.id, note: action.message });
          continue;
        }
        if (action.type !== "injectSystemNote") continue;
        if (severity !== "fix") {
          this.journal("model_output", "warned", { ruleId: rule.id, note: "correction withheld" });
          continue;
        }
        // Carried into the next request rather than applied now — the response
        // this rule reacted to has already reached the client. Stored on the
        // engine under the Claude Code session id, because THIS session object
        // is destroyed when the request completes.
        if (this.sessionId) this.engine.queueCorrection(this.sessionId, action.text);
        this.journal("model_output", "matched", { ruleId: rule.id, note: "correction queued" });
        log(`[behavior] ${rule.id} queued a correction for the next request`);
      }
    }

    this.textBuf = "";
    this.reasoningBuf = "";
    this.toolsCalled = [];
  }

  /**
   * Offer a completed tool call to the rules.
   *
   * @returns replacement argument JSON, or null to leave the call untouched.
   */
  repairToolCall(toolName: string, rawArgs: string): string | null {
    if (!this.bufferedTools.has(toolName)) return null;

    let args: Record<string, any> = {};
    try {
      const parsed = JSON.parse(rawArgs || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed;
    } catch {
      // Malformed JSON is the recovery layer's problem, not ours. Leave it be.
      return null;
    }

    let changed = false;
    for (const { rule, severity } of this.active) {
      if (!rule.onToolCall) continue;
      if (!(rule.interceptsTools ?? []).includes(toolName)) continue;

      let actions: RuleAction[] = [];
      try {
        actions =
          rule.onToolCall({
            modelId: this.modelId,
            toolName,
            args,
            rawArgs,
            harness: this.facts,
          }) ?? [];
      } catch (err) {
        log(`[behavior] rule ${rule.id} onToolCall threw: ${err}`);
        continue;
      }

      for (const action of actions) {
        if (action.type === "warn") {
          log(`[behavior] ${rule.id} (warn): ${action.message}`);
          continue;
        }
        if (action.type !== "repairToolArgs") continue;
        if (severity !== "fix") {
          log(`[behavior] ${rule.id} (warn-only, not applied): ${action.reason}`);
          continue;
        }
        // Capture the path relation BEFORE overwriting args — afterwards the
        // observed value is gone and the classification cannot be reconstructed.
        this.journal("tool_call", "repaired", {
          ruleId: rule.id,
          toolName,
          argKeys: Object.keys(args),
          observedPath: typeof args.file_path === "string" ? args.file_path : undefined,
          expectedPath: this.facts.planFilePath,
          note: action.reason,
        });
        args = action.args;
        changed = true;
        // Deliberately log-file only, not stderr: claudish shares stdio with the
        // Claude Code TUI and stray stderr writes corrupt its rendering.
        log(`[behavior] ${rule.id} repaired ${toolName}: ${action.reason}`);
      }
    }

    // A call that reached a rule and was left alone is still a decision, and the
    // dream session needs the negatives as much as the positives — a rule that
    // never fires looks identical to a rule that is not needed without them.
    if (!changed) {
      this.journal("tool_call", "ignored", {
        toolName,
        argKeys: Object.keys(args),
        observedPath: typeof args.file_path === "string" ? args.file_path : undefined,
        expectedPath: this.facts.planFilePath,
      });
    }

    // Ask the observer about calls the deterministic rules did NOT change —
    // those are the candidates for rules that do not exist yet.
    //
    // Fire-and-forget by necessity: this method is called synchronously from the
    // stream parsers, which use its return value immediately. An advisory model
    // must never sit between the model and the client, so its verdict lands in
    // the divergence log rather than in this turn.
    if (this.observerOn && !changed) {
      void this.consultObserver(toolName, args);
    }

    return changed ? JSON.stringify(args) : null;
  }

  /**
   * Record one decision. Fire-and-forget — journalling must never sit between
   * the model and the client.
   */
  private journal(
    surface: Surface,
    decision: Decision,
    detail: {
      ruleId?: string;
      toolName?: string;
      argKeys?: string[];
      observedPath?: string;
      expectedPath?: string;
      note?: string;
    }
  ): void {
    const pathRelation = classifyPath(detail.observedPath, detail.expectedPath);

    // Same call site as the local journal, so the two can never disagree about
    // what happened. This one only counts — no paths, no values; see
    // telemetry/aggregate.ts. It is a no-op unless telemetry is opted in.
    if (isUploadSurface(surface) && isUploadDecision(decision))
      recordTelemetryDecision({
        sessionId: this.sessionId,
        model: this.modelId,
        provider: this.providerName,
        surface,
        decision,
        ruleId: detail.ruleId,
        toolName: detail.toolName,
        pathRelation,
      });

    void recordDecision({
      ts: new Date().toISOString(),
      model: this.modelId,
      provider: this.providerName,
      surface,
      decision,
      ruleId: detail.ruleId,
      toolName: detail.toolName,
      argKeys: detail.argKeys,
      pathRelation,
      // Full detail stays local; nothing uploads a journal line.
      local: {
        observedPath: detail.observedPath,
        expectedPath: detail.expectedPath,
        note: detail.note,
      },
    });
  }

  /** Advisory only. Never awaited, never throws into the request path. */
  private async consultObserver(toolName: string, args: Record<string, any>): Promise<void> {
    try {
      const { buildDigest } = await import("./observer/digest.js");
      const { observe } = await import("./observer/client.js");
      const { recordLiveDivergence } = await import("./observer/live-log.js");

      const digest = buildDigest({
        model: this.modelId,
        toolNames: [...this.bufferedTools],
        harness: this.facts,
        ruleVocabulary: this.active.map((a) => a.rule.id),
        call: { name: toolName, args },
      });

      const verdict = await observe(digest, this.config);
      if (!verdict?.ruleId) return; // nothing to report

      log(
        `[behavior:observer] flagged ${toolName} as ${verdict.ruleId} ` +
          `(confidence ${verdict.confidence})${verdict.note ? `: ${verdict.note}` : ""}`
      );
      await recordLiveDivergence({
        source: "observer",
        ts: new Date().toISOString(),
        model: this.modelId,
        toolName,
        ruleId: verdict.ruleId,
        confidence: verdict.confidence,
        note: verdict.note,
        paths: digest.proposedCall?.paths,
      });
    } catch (err) {
      log(`[behavior:observer] consult failed: ${err}`);
    }
  }

  private applyAction(
    ruleId: string,
    severity: Severity,
    action: RuleAction,
    ctx: BehaviorContext
  ): void {
    if (action.type === "warn") {
      log(`[behavior] ${ruleId} (warn): ${action.message}`);
      return;
    }
    if (severity !== "fix") {
      log(`[behavior] ${ruleId} (warn-only, not applied): ${action.type}`);
      return;
    }

    switch (action.type) {
      case "injectSystemNote": {
        const req = ctx.claudeRequest;
        if (typeof req.system === "string") {
          req.system = `${req.system}\n\n${action.text}`;
        } else if (Array.isArray(req.system)) {
          req.system.push({ type: "text", text: action.text });
        } else {
          req.system = action.text;
        }
        log(`[behavior] ${ruleId} injected system note (${action.text.length} chars)`);
        break;
      }
      case "rewriteToolDescription": {
        // Applied to BOTH representations. The converted array is what the
        // Chat Completions payload aliases and what Codex's buildPayload reads
        // when it rebuilds each tool; claudeTools is what any later
        // re-conversion would read. Updating one alone silently misses a path.
        let hits = 0;
        for (const t of ctx.claudeTools) {
          if (t?.name !== action.tool) continue;
          t.description = `${t.description ?? ""}${action.append}`;
          hits++;
        }
        for (const t of ctx.tools) {
          const fn = t?.function ?? t;
          if (fn?.name !== action.tool) continue;
          fn.description = `${fn.description ?? ""}${action.append}`;
          hits++;
        }
        log(`[behavior] ${ruleId} rewrote description of ${action.tool} (${hits} site(s))`);
        break;
      }
      case "repairToolArgs":
        // Only meaningful inside repairToolCall(); ignored at request time.
        log(`[behavior] ${ruleId} returned repairToolArgs from onRequest — ignored`);
        break;
    }
  }
}

/**
 * Corrections queued by one turn and applied to the next.
 *
 * These CANNOT live on the session: a session is per-request, so anything an
 * output rule queues at the end of turn N is destroyed before turn N+1 is built.
 * They also cannot live per-model, because two concurrent conversations against
 * the same model would leak corrections into each other.
 *
 * So they are keyed by a conversation fingerprint — see `conversationKey()`.
 * Bounded, because a long-running proxy would otherwise accumulate one entry per
 * conversation it has ever seen.
 */
const MAX_TRACKED_CONVERSATIONS = 64;

export class BehaviorEngine {
  private readonly corrections = new Map<string, string[]>();

  constructor(
    private readonly config: BehaviorConfig,
    private readonly rules: BehaviorRule[]
  ) {
    // The engine owns the parsed config, so consent is pushed to the collector
    // from here rather than re-read on the request path.
    const optedIn = config.telemetry?.enabled === true;
    setTelemetryConsent(optedIn);

    // Deliver anything a PREVIOUS session spooled at exit. Done here, in the
    // background of a live process, because shutdown is synchronous and cannot
    // await a POST. Never awaited, never allowed to throw.
    if (optedIn) {
      void import("../hooks/telemetry/upload.js")
        .then((m) => m.drainOutbox())
        .catch((err) => log(`[behavior:telemetry] drain unavailable: ${err}`));
    }
  }

  /** Queue a correction for the next request in this conversation. */
  queueCorrection(key: string, text: string): void {
    const list = this.corrections.get(key) ?? [];
    list.push(text);
    this.corrections.set(key, list);
    // Evict oldest — Map preserves insertion order.
    while (this.corrections.size > MAX_TRACKED_CONVERSATIONS) {
      const oldest = this.corrections.keys().next().value;
      if (oldest === undefined) break;
      this.corrections.delete(oldest);
    }
  }

  /** Drain corrections for a conversation. */
  drainCorrections(key: string): string[] {
    const list = this.corrections.get(key) ?? [];
    this.corrections.delete(key);
    return list;
  }

  /**
   * Build the per-request session.
   *
   * Rules are gated here, once, so the hot paths (`interceptsTool`, called per
   * tool call) are set lookups rather than repeated predicate evaluation.
   */
  startSession(params: {
    modelId: string;
    providerName: string;
    isNativeAnthropic: boolean;
  }): BehaviorSession {
    const active: ActiveRule[] = [];

    // Native Claude models already follow Claude Code's conventions — the whole
    // layer stays off for them so a no-op layer is genuinely a no-op.
    if (!params.isNativeAnthropic) {
      for (const rule of this.rules) {
        const severity = resolveSeverity(
          rule.id,
          rule.defaultSeverity,
          this.config,
          params.modelId
        );
        if (severity === "off") continue;
        let applies = false;
        try {
          applies = rule.appliesTo(params);
        } catch (err) {
          log(`[behavior] rule ${rule.id} appliesTo threw: ${err}`);
          continue;
        }
        if (applies) active.push({ rule, severity });
      }
    }

    if (active.length > 0) {
      log(
        `[behavior] ${active.length} rule(s) active for ${params.modelId}: ` +
          active.map((a) => `${a.rule.id}=${a.severity}`).join(", ")
      );
    }

    return new BehaviorSession(active, params.modelId, params.providerName, this.config, this);
  }
}
