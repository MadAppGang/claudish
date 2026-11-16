#!/bin/sh
# SessionStart hook: records whether Claude Code's own environment holds an
# ANTHROPIC_API_KEY, and which kind, in the trial's launch log. A hook runs
# with Claude Code's environment, which the sandbox does not let `ps` read.
#
# It writes one label, never a value: AGENT_ENV_KEY_UNSET,
# AGENT_ENV_KEY_PLACEHOLDER (claudish's own placeholder) or AGENT_ENV_KEY_SET
# (any other value), and whether CLAUDISH_CONFIG is present.
#
# It prints NOTHING: a SessionStart hook's stdout goes into the model's
# context. Every error is swallowed for the same reason, and the exit code
# is always 0.
{
  launch=${AGENT_ENV_LAUNCH_DIR:-$(cat "$HOME/.bench-compaction/launch-dir")}
  placeholder="sk-ant-api03-placeholder-not-used-proxy-handles-auth-with-openrouter-key-xxxxxxxxxxxxxxxxxxxxx"
  if [ -z "${ANTHROPIC_API_KEY+set}" ] || [ -z "$ANTHROPIC_API_KEY" ]; then
    label=AGENT_ENV_KEY_UNSET
  elif [ "$ANTHROPIC_API_KEY" = "$placeholder" ]; then
    label=AGENT_ENV_KEY_PLACEHOLDER
  else
    label=AGENT_ENV_KEY_SET
  fi
  config=0
  [ -n "${CLAUDISH_CONFIG+set}" ] && config=1
  source=$(cat | grep -o '"source" *: *"[a-z]*"' | grep -o '[a-z]*"$' | tr -d '"')
  echo "agent-env: hook pid $PPID source=${source:-unknown} $label CLAUDISH_CONFIG_present=$config" >>"$launch/launch.log"
} >/dev/null 2>&1
exit 0
