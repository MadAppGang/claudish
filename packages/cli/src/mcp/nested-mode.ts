/**
 * The claudish MCP server's surface inside a session that a claudish owner started
 * (`CLAUDISH_PANE_CHILD=1`, read by `inMcpSession()`), where one level of nesting is
 * the limit. See `ai-docs/architecture/mcp-channel.md` § Nested mode and
 * `pane-session.md` § One level of nesting.
 *
 * A leaf module that imports nothing, so a test can read the list without importing
 * `mcp-server.ts`, which loads `.env` at import time.
 */

/**
 * The tools a nested server registers, by NAME. The rule: keep a tool only if it is a
 * one-shot call that starts no session, no pane and no claudish child. `run_prompt` and
 * `compare_models` answer through an in-process proxy; the two catalog reads start
 * nothing. The list fails closed: a tool added later is absent in nested mode until
 * someone lists it here, which a group filter would not guarantee.
 *
 * Nested mode INTERSECTS this list with the groups `CLAUDISH_MCP_TOOLS` enables; it
 * never widens them.
 */
export const NESTED_MCP_TOOL_NAMES = [
  "run_prompt",
  "list_models",
  "search_models",
  "compare_models",
] as const;

/** The server instructions in nested mode, in place of the channel-mode text. */
export const NESTED_INSTRUCTIONS = `Claudish MCP server provides access to external AI models for one-shot calls.

## Nested mode — no sessions

This server runs inside a session that a claudish MCP server started (CLAUDISH_PANE_CHILD=1). One level of nesting is the limit, so these tools are not registered: create_session, team, send_input, get_output, cancel_session, list_sessions, get_diagnostics, capture_session, preflight, report_error. No channel notifications are sent.

- run_prompt or compare_models: a one-shot answer from another model.
- list_models, search_models: find a model.

Do not start a claudish session another way: \`claudish -p\`, an interactive claudish or \`claudish team\` run from this session's shell exits 64 with "nested session refused".`;
