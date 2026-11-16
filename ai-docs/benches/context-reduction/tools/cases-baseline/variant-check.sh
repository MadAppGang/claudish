#!/bin/sh
# The key and route check of the baseline arm of cases/. Passes only when:
#   1. the launcher's environment held no ANTHROPIC_API_KEY (count 0);
#   2. Claude Code's environment held no ANTHROPIC_API_KEY other than
#      claudish's placeholder, and no CLAUDISH_CONFIG, as the SessionStart
#      hook of the cc_settings folder (hooks/agent-env.sh) recorded it;
#   3. no tool call of the agent named ~/.claudish/config.json or
#      CLAUDISH_CONFIG;
#   4. the build's debug log exists and has no compaction line at all.
here=$(cd "$(dirname "$0")" && pwd)
launch=$(cat "$HOME/.bench-compaction/launch-dir" 2>/dev/null)
log="$launch/launch.log"
fail=0

keys=$(grep -o 'launcher environment: [0-9]*' "$log" 2>/dev/null | awk '{print $3}')
echo "launcher ANTHROPIC_API_KEY entries: ${keys:-absent}"
[ "${keys:-x}" = "0" ] || fail=1

agent=$(grep -o 'agent-env: hook .*' "$log" 2>/dev/null | head -1)
echo "${agent:-agent-env: absent}"
case "$agent" in
  *AGENT_ENV_KEY_UNSET*|*AGENT_ENV_KEY_PLACEHOLDER*) ;;
  *) fail=1 ;;
esac
case "$agent" in
  *CLAUDISH_CONFIG_present=0*) ;;
  *) fail=1 ;;
esac

reads=$(bun "$here/../claudish-compaction/transcripts.ts" | grep -o 'config_reads=[0-9]*' | cut -d= -f2)
echo "agent tool calls naming the config: ${reads:-absent}"
[ "${reads:-x}" = "0" ] || fail=1

logs=$(ls "$launch"/debug/claudish_*.log 2>/dev/null)
if [ -z "$logs" ]; then
  echo "debug log: absent"
  exit 1
fi
lines=$(cat $logs | grep -c '\[compaction\]')
echo "debug logs: $(echo "$logs" | wc -l | tr -d ' '); compaction lines: $lines"
[ "$lines" -eq 0 ] || fail=1

exit "$fail"
