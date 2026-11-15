#!/bin/sh
# The graded Check for claudish-compaction. Passes only when all of these hold:
#   1. The launcher's environment held no ANTHROPIC_API_KEY (count 0).
#   2. Claude Code's environment, read by the launcher's watcher, held no
#      ANTHROPIC_API_KEY other than claudish's placeholder, and no
#      CLAUDISH_CONFIG.
#   3. No tool call of the agent named ~/.claudish/config.json or
#      CLAUDISH_CONFIG.
#   4. claudish logged "[compaction] on", every compaction call was signed with
#      x-api-key and named claude-haiku-5-5, and no line says compaction
#      turned itself off.
# A trial with no tool output large enough to compress passes too; the
# evidence reports whether one occurred.
here=$(cd "$(dirname "$0")" && pwd)
launch=$(cat "$HOME/.bench-compaction/launch-dir" 2>/dev/null)
log="$launch/launch.log"
fail=0

keys=$(grep -o 'launcher environment: [0-9]*' "$log" 2>/dev/null | awk '{print $3}')
echo "launcher ANTHROPIC_API_KEY entries: ${keys:-absent}"
[ "${keys:-x}" = "0" ] || fail=1

agent=$(grep -o 'agent-env: .*' "$log" 2>/dev/null)
echo "${agent:-agent-env: absent}"
case "$agent" in
  *AGENT_ENV_KEY_UNSET*|*AGENT_ENV_KEY_PLACEHOLDER*) ;;
  *) fail=1 ;;
esac
case "$agent" in
  *CLAUDISH_CONFIG_present=0*) ;;
  *) fail=1 ;;
esac

reads=$(bun "$here/transcripts.ts" | grep -o 'config_reads=[0-9]*' | cut -d= -f2)
echo "agent tool calls naming the config: ${reads:-absent}"
[ "${reads:-x}" = "0" ] || fail=1

logs=$(ls "$launch"/debug/claudish_*.log 2>/dev/null)
if [ -z "$logs" ]; then
  echo "debug log: absent"
  exit 1
fi
on=$(cat $logs | grep -c '\[compaction\] on: model claude-haiku-5-5')
calls=$(cat $logs | grep -c '\[compaction\] Calling API')
signed=$(cat $logs | grep '\[compaction\] Calling API' | grep 'model: claude-haiku-5-5,' | grep -c 'auth: x-api-key')
off=$(cat $logs | grep '\[compaction\]' | grep -c 'off for')
echo "compaction on lines: $on; calls: $calls; on claude-haiku-5-5 with x-api-key: $signed; switched-off lines: $off"
[ "$on" -gt 0 ] && [ "$signed" -eq "$calls" ] && [ "$off" -eq 0 ] || fail=1

exit "$fail"
