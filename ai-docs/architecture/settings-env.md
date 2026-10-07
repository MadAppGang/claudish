# A settings `env` block and claudish's launches

claudish points each Claude Code it launches at its proxy through the child's environment
(`ANTHROPIC_BASE_URL`). An `env` block in a Claude Code settings file overrides that: Claude Code
"writes each `env` entry into the process environment, replacing the value inherited from the
shell", and every subprocess it starts inherits the result
([environment variables reference](https://code.claude.com/docs/en/env-vars), Precedence). The
same docs recommend a settings `env` block as the place for a gateway's address, so a user who
follows them sends every claudish session to that gateway instead of claudish's proxy.

Measured on Claude Code 2.1.281 against a capture server listening on two ports:

- With `ANTHROPIC_BASE_URL` in user settings and a different one in the launch environment,
  requests went to the settings one.
- `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1` in settings beat an empty value in the launch
  environment, so the session claimed first-party trust.
- A SessionStart hook, a child of Claude Code, saw the settings values.
- A `--settings` file outranks user settings: with the base URL in both the launch environment
  and a `--settings` file, requests went to the `--settings` one.

## Sessions claudish owns: the host marker

Claude Code documents `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` for this case: "Set by host
platforms that embed Claude Code and manage model provider routing on its behalf. When set,
Claude Code ignores provider-selection, endpoint, and authentication variables ... in settings
files, so user settings can't override the host's routing." A proxy-auth session, where every
request goes through a claudish provider and claudish supplies the placeholder credential, is
that case, so the runner sets the marker there. Measured with the marker and claudish's
placeholder key:

- Requests went to the launch environment's base URL, not the settings one.
- A settings-file trust flag was ignored. Claude Code's settings filter drops every base URL,
  credential, provider-selection and model variable from a settings `env` block when the
  session is host-managed, and logs each one it drops.
- A trust flag in the launch environment still applied. The runner therefore sets it empty for
  these sessions: a session routed to another provider must not claim first-party trust, and a
  claudish started from a shell inside a trusted session inherits the flag.

## Sessions that keep the user's login

Under the marker Claude Code also ignores a stored claude.ai login: with valid stored OAuth
credentials, a host-managed session printed "Not logged in · Please run /login" and sent
nothing. A session that uses the user's own login (`--monitor`, a native-model role, the
no-model advisor) is therefore not marked, and a base URL in the user's settings still applies
to it. For a `--monitor` session that costs nothing when the settings gateway forwards to
Anthropic unchanged.

Pinning such a session through claudish's `--settings` file would hold for the session itself,
but Claude Code carries `--settings` into a session sent to the background, which would then
point at a proxy that stops when claudish's child exits.

`claude-runner-host-routing.test.ts` checks the environment a stand-in `claude` receives for
each kind of launch.
