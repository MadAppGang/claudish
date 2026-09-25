# Daemon mode

`claudish daemon --port <n>` runs Claude Code's supervisor, `claude daemon run`, as the child of a
`--monitor` proxy on a fixed port, and acts as the supervisor's service manager. The supervisor
hosts Claude Code's background sessions, the ones `claude --bg`, `/bg` and agent view start and
the only ones agent view lists ([agent view](https://code.claude.com/docs/en/agent-view#the-supervisor-process)).
Read this before editing `daemon-command.ts`.

## What `claude daemon run` does, by origin

Read from the `claude daemon` code of Claude Code 2.1.281. Its help documents `run` and the
on-demand default, not the origins. Where a point was also measured, the measurement is given.

- `--origin` is `service`, `transient` or `foreground`; `auto` means `transient`, and a bare
  `claude daemon run` is `foreground`. The parser keeps the LAST `--origin` it sees and falls
  back to `foreground` on a value it does not know, so `supervisorArgv` puts `--origin service`
  after the caller's own options, where none of them can replace it.
- Only a `transient` supervisor, the kind a client starts on demand, exits after an idle grace
  with no client attached. A `service` one stays up.
- The supervisor polls its own binary. When the binary changes or is deleted, a `service`
  supervisor exits with code 70 for its manager to start the new one (measured: a touched copy
  was noticed at the next poll, 60 s after start, and claudish had the new supervisor up 300 ms
  later); every other origin spawns its successor detached and exits. That successor would
  not be claudish's child, so `service` is the only origin a parent can keep across an upgrade.
  A change to an OLDER build is refused and the running one kept.
- SIGINT and SIGTERM start a graceful shutdown; a second signal forces exit 1 with no cleanup.
  SIGHUP is not handled, so its default action kills the supervisor without cleanup.
- With agent view disabled (`CLAUDE_CODE_DISABLE_AGENT_VIEW` or `disableAgentView`) it prints
  why and exits 0. A service supervisor also stops its workers and exits 0 when Claude Code's
  service-recall flag (`tengu_copper_lantern`) is set. Exit 0 is never restarted.
- One supervisor holds a config directory. A service start asks a running `transient` one to
  yield and adopts its sessions (measured: the transient shut down with `cause=yield`, one live
  session kept its pid under the new supervisor, `bg adopt: adopted=1`). Any other holder makes
  the new supervisor exit 1, with the reason only in its own log, which is why claudish's last
  line names the exit and points at `claude daemon logs`.

## One signal, through a separate process group

Claude Code starts its own supervisor detached, with stdin ignored, and claudish does the same.
A terminal's Ctrl-C or hangup is delivered to the foreground process group; with the supervisor
in claudish's group it would get the terminal's signal AND the one claudish forwards, and take
the second as a forced shutdown, or be killed outright by SIGHUP. Detached, it gets exactly one
SIGTERM from claudish whatever claudish received. The end-to-end test signals claudish's GROUP,
as a terminal does, and asserts the supervisor saw one SIGTERM; run with `detached: false` it
fails with the terminal's SIGINT recorded as well.

claudish itself has to be the one that waits. `stats-buffer.ts` registers SIGINT and SIGTERM
handlers at module load that flush stats and `process.exit` at once, and they run before any
listener registered later, so the daemon's own would never run: measured with a stand-in that
took 2 s to stop, claudish exited 2 ms after the SIGTERM, taking the proxy with it while the
supervisor was still shutting down. `daemonCommand` takes those two handlers off
(`releaseSignalHandlers`; stats still flush on `exit`) and exits once the supervisor has. The
end-to-end test's stand-in asks the proxy for `/health` after its SIGTERM, and gets 0 instead
of 200 when the handlers are left in place.

Detaching also means nothing takes the supervisor down with claudish by default, so claudish
stops it from its `exit` handler whenever it ends without having done so.

## How sessions reach the proxy

The supervisor builds each session's environment from its own, then deletes every base URL
variable (`ANTHROPIC_BASE_URL`, `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL`, and each cloud
provider's endpoint) that the dispatching client did not carry, and keeps a carried one only
when it equals the supervisor's. The docs describe the same from the user's side: a
base URL exported in a shell reaches a background session only in three dispatch cases, and
only when the supervisor was started with the same one
([LLM gateway](https://code.claude.com/docs/en/agent-view#llm-gateway)).

So the `ANTHROPIC_BASE_URL` claudish gives the supervisor reaches no session by itself. It is
there so that a client pointed at the same proxy keeps it on dispatch. The route that reaches
every session is a settings file's `env` block, which each session reads where it runs.
Measured under a claudish-run supervisor whose environment named the proxy:

- With no `env` block, a background session's environment had no `ANTHROPIC_BASE_URL`, and its
  connections went to `api.anthropic.com` (160.79.104.10) with none to the proxy.
- With the block, the same kind of session held its connections to the proxy. One connection
  still went straight to `api.anthropic.com`: Claude Code sends some requests past its base URL,
  whatever launched it.
- `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1` works from the same block. Against a capture
  server, a background session's requests carried `x-claude-code-request-class` and
  `x-client-request-id` with it in settings and neither without it ([first-party.md](first-party.md)).

The supervisor keeps a session process started ahead of the next dispatch. When that process is
claimed it reads settings again and picks up a key added since it started, but a key REMOVED
since stays in its environment, so the first dispatch after removing one may still carry it.

## Restarting after an upgrade

A restart waits for the new binary the way Claude Code does when it restarts a supervisor that
npm is reinstalling (2.1.281): every 250 ms for 10 s, then every second up to 120 s while npm's
staging directory for the package (`node_modules/@anthropic-ai/.<name>-*`) was touched in the
last 10 minutes; inside the npm package a file under 64 KiB is npm's stub, not the binary. The
supervisor exits 70 when its binary is deleted as well as when it changes, and npm moves the old
package aside before it writes the new one, so a restart at once could find nothing. Like Claude
Code, claudish polls the path that exited. The one addition is ours: when that path stays
unrunnable, a single fresh `findClaudeBinary()`, in case the install moved. A first start does
not wait: finding nothing there is an installation problem, as for any launch.

## Exit codes

The supervisor's own code; `128 + signum` for a signal that killed it, so a SIGKILL from the
OOM killer reads 137; and `128 + signum` of the signal claudish received when it was stopped,
as for a launched session. Both come from `signalExitCode`, which takes the number from the OS.
