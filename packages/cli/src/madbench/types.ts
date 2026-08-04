/**
 * madbench — end-to-end benchmark of the whole stack, from a real Claude Code
 * session down through the claudish MCP server to three real external models.
 *
 * The mcp-e2e harness proves claudish's MCP server resolves credentials
 * correctly when driven by a synthetic JSON-RPC client. madbench proves the
 * thing that actually matters: that a REAL Claude Code agent, given a real
 * task, routes it through claudish to three real models and gets real answers
 * back. Nothing here is mocked and nothing is stubbed.
 *
 * The model names are deliberately NOT pinned. The prompt asks for "the latest
 * models" and Claude Code resolves that itself against claudish's live catalog.
 * Pinning ids would make the test a snapshot of one afternoon's model roster —
 * it would go red every time a vendor ships, for reasons that have nothing to do
 * with claudish. What is asserted instead is the invariant: three DISTINCT
 * models, each one real (present in the catalog the session itself saw), each
 * one returning the correct answer.
 *
 * 1Password is exercised for real: the MCP server is spawned with a stripped
 * environment, so every provider key must come from the configured 1Password
 * Environment. That is the whole point, and it is why this cannot be a silent
 * background test — see AuthMode.
 */

/** One frame from `claude -p --output-format stream-json --verbose`. */
export interface StreamFrame {
  type?: string;
  subtype?: string;
  /** `system/init` carries these. */
  mcp_servers?: { name: string; status: string }[];
  tools?: string[];
  /** assistant/user frames carry a message with content blocks. */
  message?: {
    role?: string;
    content?: ContentBlock[];
  };
  /** the final result frame */
  result?: unknown;
  is_error?: boolean;
  [k: string]: unknown;
}

export interface ContentBlock {
  type?: string;
  /** tool_use */
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  /** tool_result */
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  /** text */
  text?: string;
}

/** A claudish MCP tool call extracted from the session, with its result. */
export interface ClaudishCall {
  /** Bare tool name, e.g. "run_prompt" (the `mcp__…__` prefix is stripped). */
  tool: string;
  /** Fully-qualified name as it appeared, e.g. `mcp__claudish__run_prompt`. */
  qualifiedName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  /** The `model` argument, when the call carried one. */
  model?: string;
  /** Flattened text of the matching tool_result, "" when none arrived. */
  resultText: string;
  isError: boolean;
}

/**
 * How 1Password will be reached. Determines whether this run can be unattended.
 *
 *  - "service-account": OP_SERVICE_ACCOUNT_TOKEN is set. Token auth never shows
 *    a desktop prompt and bypasses the handshake lock entirely, so the run is
 *    fully unattended. This is the CI mode.
 *  - "desktop": DesktopAuth. Every `createClient()` can raise an approval
 *    dialog, so a human has to be present to approve. This is the local mode.
 */
export type AuthMode = "service-account" | "desktop";

/** Everything observed about one madbench run. */
export interface BenchObservation {
  /** Unique token embedded in the prompt, for tracing this run through logs. */
  runToken: string;
  authMode: AuthMode;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  /** Every parsed stream-json frame, in order. */
  frames: StreamFrame[];
  /** The `system/init` frame, when one arrived. */
  init?: StreamFrame;
  /** Every claudish MCP call the session made, paired with its result. */
  calls: ClaudishCall[];
  /** Model ids the session saw in any list_models / search_models result. */
  catalogModels: string[];
  /** The final assistant text. */
  finalText: string;
  stdout: string;
  stderr: string;
  /** The arithmetic answer every model was asked to produce. */
  expectedAnswer: string;
}

/** A single named check over the observation. */
export interface Check {
  id: string;
  /** What this proves, one line, shown in report.md. */
  description: string;
  /** Return [] to pass, or one message per failed expectation. */
  run(obs: BenchObservation): string[];
}

export interface CheckResult {
  id: string;
  description: string;
  passed: boolean;
  failures: string[];
}
