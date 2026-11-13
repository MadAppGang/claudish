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
- A trust flag in the launch environment still applied. The flag tells Claude Code that its base
  URL is Anthropic's own API, so Claude Code sizes windows and shapes requests for Anthropic; a
  session routed to another provider has a different backend, and a claudish started from a
  shell inside a trusted session inherits the flag. The runner therefore sets it empty for these
  sessions. A session whose requests go to Anthropic keeps the flag its launcher gave it.

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

## The two Claude launches

`--model claude@<id>` and `--model anthropic@<id>` (`a@`, `api@`) each start a monitor session
(`decideClaudeLaunch`, `launcher/claude-launch.ts`; `claudeLaunch` is `subscription` or `api`).
Both take the runner's monitor branch, which deletes `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`
from the child, scrubs inherited host routing and fast-mode gates, and pins `ANTHROPIC_MODEL` to
`claudeLaunchModel` (`claude-runner.ts`). `config.model` keeps the user's spec, so the
end-of-session card and the advisor notice name the route.

**Claude subscription (`claude@<id>`).** The child keeps the user's login, so it is not
host-managed, as above. The Claude subscription is never signed with an Anthropic API key, so a
settings layer that would hand the child one REFUSES the launch before spawn, naming the file and
never the value (`settingsCredentialFindings`, `claude-runner.ts`; `subscriptionSettingsCheck`,
`launcher/claude-launch.ts`). It reads the layers `childAuthControl` reads (managed, user,
`$CLAUDE_CONFIG_DIR`, project, project-local, every `--settings` occurrence) and returns every
finding of every layer: an earlier layer never hides a later one. Refused: a real
`ANTHROPIC_API_KEY` in an `env` block, an `apiKeyHelper`, an `ANTHROPIC_CUSTOM_HEADERS` (in a
settings `env` block or the launch environment) carrying `x-api-key` or a non-login
`authorization`, a real `ANTHROPIC_AUTH_TOKEN` in an `env` block (Claude Code would send it
instead of the login, and every request would then fail with a "Sign in" answer that names the
wrong cause), and a `--settings` value claudish cannot read or parse. A settings
`ANTHROPIC_BASE_URL` is a one-line notice: it moves where the login's requests go, not which
credential signs them.
The same refusal runs for a bare Claude main model without `--anthropic-api-billing` (top level
and pane child, where its message also offers that flag) and in MCP `run_prompt`'s print child
(`runPromptViaClaudeCode`). What claudish cannot read (an MDM profile, a file Claude Code adds
later) is the same limit `childAuthControl` documents; a key-signed request from there that
reaches the proxy is still refused.

**Claude API (`anthropic@<id>`).** Claude Code holds no key. Its only credential is claudish's
placeholder token (`ANTHROPIC_AUTH_TOKEN`, no `ANTHROPIC_API_KEY`), which suppresses the login and
raises no "Detected a custom API key" question, and the monitor proxy drops whatever credential a
request arrives with and signs it with the key the launch resolved (`launch-key`). So the key is
never in Claude Code's environment, its tool shells, MCP servers, a nested claudish, the magmux
script or the launcher's `process.env`. The child also gets:

- `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1` alone (`applyHostManagedMarker`,
  `host-routing-env.ts`). The trust flag keeps the value the launcher gave it, because the
  requests go to Anthropic. The record `CLAUDISH_SET_HOST_ROUTING_VARS` is `marker` here and `1`
  for the proxy-auth pair; `scrubInheritedHostRouting` removes exactly what the record names.
- `forceLoginMethod: "console"` in claudish's `--settings` overlay. Under the host marker Claude
  Code ignores the login, so a session forced to the claude.ai login could not start: the launch
  is refused before any key is read when the OS managed tier or a `--settings` value sets
  `forceLoginMethod: "claudeai"`.
- none of the fast-mode gates a parent claudish opened (`scrubInheritedFastModeGates` removes an
  inherited `CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK` it set): the key's own organisation policy
  applies.

The key is resolved before spawn through the authority's `resolveForUse("anthropic")` (env,
config, Keychain, 1Password; a 1Password prompt only on an interactive launch). No key refuses the
launch naming the sources searched; a vault that could not be read refuses it with the vault's
reason. The banner names the source, never the key: `[claudish] Monitor mode · Claude API ·
ANTHROPIC_API_KEY from macOS Keychain · signed by claudish`. `childAuthControl` answers
`proxy-auth` for this launch: the bearer Claude Code sends is the placeholder, never a login.

**Measured on Claude Code 2.1.323** (local capture servers on two ports, no Anthropic call; a
settings `env` block setting `ANTHROPIC_BASE_URL` to port B and a fake `ANTHROPIC_API_KEY`; the
launch environment pointing at port A with the placeholder token and no `ANTHROPIC_API_KEY`;
`forceLoginMethod: "console"` in the overlay):

- With the host marker, all 8 `/v1/messages` requests of one prompt went to port A and none to
  port B. Each carried `Authorization: Bearer <placeholder>` and no `x-api-key`. No login screen
  and no custom-key question appeared; the only dialog was folder trust.
- Control, without the marker: all 8 went to port B, the settings address, and Claude Code asked
  "Detected a custom API key in your environment … Do you want to use this API key?" about the
  settings key. With "No" chosen the requests carried the placeholder bearer, so the control shows
  the base-URL override and not what a "Yes" would send.

So a settings `env` block can neither move this session's requests away from the proxy nor give it
a credential, and the launch needs no base-URL refusal. Whatever credential did arrive, the proxy
would replace it with the launch key.

`claude-runner-host-routing.test.ts` checks the environment a stand-in `claude` receives for
each kind of launch.
