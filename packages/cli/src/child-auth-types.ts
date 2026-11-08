/**
 * The types of `childAuthControl` (claude-runner.ts): whether claudish controls
 * the child's Anthropic auth on this launch. Kept free of imports so a handler
 * that takes the decision does not load the launcher. The decision itself is
 * made in claude-runner.ts.
 */

/**
 * A credential source, other than Claude Code's own claude.ai login, that this
 * launch lets the child authenticate with. Names only; no value is ever kept.
 *
 * - `proxy-auth`: the child gets claudish's placeholder pair, so no login
 *   reaches the proxy at all.
 * - `user-auth-token`: the user's own ANTHROPIC_AUTH_TOKEN stays in the child
 *   env (the native-mapping branch keeps it); Claude Code sends it as a bearer.
 * - `user-api-key`: a real ANTHROPIC_API_KEY stays in the child env (sent as
 *   `x-api-key`).
 * - `settings-auth-token` / `settings-api-key`: a Claude Code settings file
 *   sets that variable in its `env` block, which claudish's env builder never
 *   sees and cannot remove.
 * - `api-key-helper`: a settings file names an `apiKeyHelper`; Claude Code
 *   sends its output as a bearer AND as `x-api-key`.
 * - `custom-headers`: ANTHROPIC_CUSTOM_HEADERS (the environment or a settings
 *   `env` block) carries an `Authorization` or `x-api-key` header.
 * - `settings-unreadable`: a `--settings` value the child receives verbatim
 *   could not be read or parsed by claudish, so what it sets is unknown.
 *   Unknown provenance is never treated as controlled.
 */
export type ChildAuthSource =
  | "proxy-auth"
  | "user-auth-token"
  | "user-api-key"
  | "settings-auth-token"
  | "settings-api-key"
  | "api-key-helper"
  | "custom-headers"
  | "settings-unreadable";

/**
 * Whether claudish controls the child's Anthropic auth, so that a bearer
 * arriving at the proxy can only be Claude Code's own claude.ai login.
 * `where` names the source (`environment`, or the settings file's path),
 * never a value.
 */
export type ChildAuthControl =
  | { controlled: true }
  | {
      controlled: false;
      reason: ChildAuthSource;
      where: string;
      /**
       * `custom-headers` only: whether the headers set `x-api-key`, so Claude
       * Code itself sends a real key the advisor can sign with. False when they
       * set only `Authorization`, whose bearer the advisor never uses on an
       * uncontrolled launch.
       */
      sendsApiKey?: boolean;
    };
