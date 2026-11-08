/**
 * The environment variables that point a process at ONE claudish session's records.
 *
 * A pane child (an MCP `create_session` slot, a `team` slot) inherits them, and so does
 * a test run started inside that pane. Inherited, they make the suite write its test
 * doubles into the real session: `captureUpstreamError` appends to
 * `~/.claudish/sessions/<id>/upstream-errors.jsonl` whenever the first one is set, and
 * `get_diagnostics` then lists `stub` and `fixture-upstream-error` as that session's
 * upstream failures (model-failures-2026-10-21.md, D5).
 *
 * Each name is the literal of a production constant (the writer is in the comment).
 * They are literals, with no imports, on purpose: this file is loaded by the bun test
 * preload before every test file, and importing the production modules would load
 * `hooks/`, `config.ts` and the token tracker ahead of the module-scope snapshots tests
 * rely on. Importing this file has NO side effect; `test-preload.ts` does the deleting.
 *
 * Read by `scripts/test-preload.ts` (in-process, first layer) and
 * `scripts/guard-real-config.ts` (the child's OS environment, second layer).
 */
export const SESSION_ENV_VARS = [
  // UPSTREAM_ERROR_LOG_ENV, handlers/shared/upstream-error-capture.ts → upstream-errors.jsonl
  "CLAUDISH_UPSTREAM_ERROR_LOG",
  // HOOK_INBOX_ENV, hooks/injection/sinks.ts → the session's hook inbox
  "CLAUDISH_HOOK_INBOX",
  // HOOK_SESSION_ENV, hooks/request-stage.ts → the identity hook records are attributed to
  "CLAUDISH_HOOK_SESSION",
  // ENV.CLAUDISH_TOKEN_FILE, config.ts → sessions/<id>/tokens.json (TokenTracker.writeFile)
  "CLAUDISH_TOKEN_FILE",
  // ENV.CLAUDISH_PUBLISHED_TOKEN_FILE, config.ts → the marker resolveTokenFilePath compares
  // with the one above; clearing only one of the pair writes the session's tokens.json
  "CLAUDISH_PUBLISHED_TOKEN_FILE",
  // read by isPaneChild (pane/child-env.ts): gates the inbox sink and the nested refusal
  "CLAUDISH_PANE_CHILD",
] as const;
