# Daemon Mode

**Background sessions and agent view, through claudish.**

Claude Code runs its background sessions, the ones `claude --bg`, `/bg` and agent view start, inside a supervisor process, `claude daemon run`. `claudish daemon` starts a `--monitor` proxy on a port you choose and runs that supervisor as its child, so the two stay up together.

---

## Start it

```bash
claudish daemon --port 8787
```

It prints the proxy's address, starts `claude daemon run`, and stays in the foreground until you stop it.

Options for `claude daemon run` itself go after `--`:

```bash
claudish daemon --port 8787 -- --log-file ~/claude-daemon.log
```

---

## Point sessions at the proxy

Sessions do not take the proxy's address from the supervisor. The supervisor hands a session the base URL of the client that dispatched it only in a few cases, and only when it matches the supervisor's own, so the reliable route is a settings file. Put the proxy in its `env` block, where Claude Code's docs put a base URL for background sessions ([agent view: LLM gateway](https://code.claude.com/docs/en/agent-view#llm-gateway)):

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787"
  }
}
```

`settings.json` in Claude Code's config directory (`~/.claude`, or `$CLAUDE_CONFIG_DIR`) covers every session, background and interactive; a project's `.claude/settings.json` covers the sessions in that project. Sessions keep their own Claude Code login, and the proxy forwards each request to Anthropic as Claude Code built it, as `--monitor` does.

Claude Code treats a base URL as Anthropic's own API only when told to. To give the proxy that trust, add `"_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL": "1"` to the same block.

---

## What claudish does with the supervisor

- **Keeps it up.** It runs with `--origin service`. A supervisor Claude Code starts on demand exits once nothing is attached to it; this one does not.
- **Restarts it on upgrade.** When the supervisor finds its binary replaced, it exits with code 70 and claudish starts the new one, waiting for it if an npm install is still finishing. The proxy stays up throughout.
- **Stops it with you.** Ctrl-C, SIGTERM or SIGHUP sends the supervisor one SIGTERM, and claudish exits with 128 plus the signal's number once it has shut down.
- **Ends when it does.** Any other exit ends `claudish daemon` with the supervisor's code. The supervisor writes why to its own log, which `claude daemon logs` shows.

---

## One supervisor per config directory

Claude Code runs one supervisor per config directory. If one it started on demand is already running there, the supervisor `claudish daemon` starts takes over from it and adopts its sessions. Any other running supervisor stays, and `claudish daemon` exits with code 1.

To run a separate instance, with its own sessions and its own agent view, give it its own `CLAUDE_CONFIG_DIR`:

```bash
CLAUDE_CONFIG_DIR=~/.claude-work claudish daemon --port 8788
```
