/**
 * Shared contract for the MCP × 1Password e2e harness.
 *
 * The harness drives a REAL `claudish --mcp` server over stdio JSON-RPC in an
 * isolated environment and records everything it can observe. Scenarios are
 * pure data + one `assert` function; the runner owns spawning, logging, and
 * ordering, so a scenario never has to know how any of that works.
 *
 * Design rule: assertions run against the PROTOCOL and the startup-trace SPANS,
 * never against prose. A `stderr.includes("…")` check passes for the wrong
 * reason — it matched a message the server printed while the thing under test
 * was silently broken. Span presence is the discriminator that actually
 * separates "resolved from 1Password" from "found it already in env".
 */

/** A parsed JSON-RPC frame read off the server's stdout. */
export interface JsonRpcFrame {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
  params?: Record<string, unknown>;
}

/**
 * One `[startup-trace] <name> <dur>` line parsed off stderr.
 *
 * `name` carries payload for op spans: `op:resolve(GLM_CODING_API_KEY,…)`
 * literally embeds the env-var names that resolution was asked for, which is
 * why `resolveRequests` below can exist without a side channel.
 */
export interface TraceSpan {
  name: string;
  /** Everything after the span name on the line (duration + meta), verbatim. */
  detail: string;
  raw: string;
}

/** How an arm's isolated `~/.claudish/config.json` should be built. */
export interface ArmConfigSpec {
  /**
   * `"inherit"` copies the real config's value (read-only) — the normal case.
   * `null` deliberately OMITS the key, which is how `op-no-account` reproduces
   * the multi-account wall. A literal string pins an exact value.
   */
  onepasswordAccount?: "inherit" | string | null;
  onepasswordEnvironments?: "inherit" | string[] | null;
  /** Merged in last; escape hatch for arms that need other config keys. */
  extra?: Record<string, unknown>;
}

/** Everything the runner managed to observe about one arm. */
export interface Observation {
  scenarioId: string;
  /** Index within the arm, for concurrent arms. 0 for single-process arms. */
  replica: number;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  /** Parsed stdout frames, in arrival order. */
  frames: JsonRpcFrame[];
  /** Raw stderr, redacted with redactSecrets. */
  stderr: string;
  /** Parsed `[startup-trace]` lines. */
  spans: TraceSpan[];
  /** Concatenated text content per tool name, keyed by the tool called. */
  toolText: Record<string, string>;
  /** Child session dirs this arm produced (`~/.claudish/sessions/<id>`). */
  sessionLogs: SessionLog[];
  /** The config file the arm actually ran with. */
  configUsed: Record<string, unknown>;
  /** Env var NAMES visible to the child (values never captured). */
  envNames: string[];
}

/** A child session dir collected after the arm finished. */
export interface SessionLog {
  sessionId: string;
  meta: Record<string, unknown> | null;
  stderr: string;
  output: string;
}

/** Convenience accessors so assertions stay readable. */
export interface ObservationView extends Observation {
  /** True when any span name matches. */
  hasSpan(prefix: string): boolean;
  /** Env-var names any `op:resolve(...)` span asked for, flattened + deduped. */
  resolveRequests(): string[];
  /** All stderr lines matching a pattern (for documented, stable markers). */
  grepStderr(re: RegExp): string[];
}

/** What a scenario asks the runner to do, and how to judge the result. */
export interface Scenario {
  id: string;
  group: "op" | "core";
  /** One line, shown in report.md. */
  description: string;
  /**
   * Provider-key env names to KEEP from the parent process. Default: none.
   * This is the load-bearing isolation knob — Claude Code runs under
   * `op run`, so an unstripped env means 1Password is never consulted and the
   * arm passes while the integration is broken.
   */
  keepKeys?: string[];
  /** Extra env layered on top of the stripped base. */
  env?: Record<string, string>;
  config: ArmConfigSpec;
  /** MCP tool calls to issue after `initialize`, in order. */
  calls: ToolCall[];
  /** Servers to run in parallel. Default 1. */
  concurrency?: number;
  /**
   * Seconds to idle AFTER this arm. 1Password suppresses Automated Unlock for
   * 15s after a burst of denials, during which EVERY request — including
   * sequential ones from unrelated processes — is denied instantly. An arm that
   * intentionally fails auth must be followed by a gap, or the next arm
   * measures the penalty box instead of its own behaviour.
   */
  cooldownSeconds?: number;
  /** Higher runs later. Auth-failing and concurrent arms must sort last. */
  order: number;
  /** Per-arm hard timeout. Default 90s. */
  timeoutMs?: number;
  /** Return [] to pass, or one string per failed expectation. */
  assert(obs: ObservationView[]): string[];
}

/** A single `tools/call` the runner issues. */
export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
  /** Wait this long after issuing before moving on. Default 0. */
  settleMs?: number;
  /**
   * When set, the runner issues `cancel_session` for the session id found in
   * this call's result. Keeps `create_session` arms from doing real work.
   */
  cancelAfter?: boolean;
}

/** Final per-arm verdict written to verdict.json. */
export interface Verdict {
  scenarioId: string;
  passed: boolean;
  failures: string[];
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  /** Seconds of idle observed before this arm started. */
  gapBeforeSeconds: number;
}
